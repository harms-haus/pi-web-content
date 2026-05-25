/**
 * SSRF protection module
 *
 * Provides URL validation against Server-Side Request Forgery attacks,
 * including DNS rebinding, non-decimal IP representations, and redirect-based SSRF.
 */

import { resolve4, resolve6 } from "node:dns/promises";

/** Blocklist of exact hostnames that are always internal */
export const BLOCKED_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

/** Blocklist of hostname prefixes for private IP ranges */
export const BLOCKED_HOSTNAME_PREFIXES: readonly string[] = [
  "10.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "192.168.",
  "169.254.",
];

/** Check if a hostname string matches the static blocklist (no DNS resolution) */
export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(lower)) return true;
  if (BLOCKED_HOSTNAME_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return false;
}

/**
 * Check if an IPv4 address is private/internal.
 * Handles decimal, hex (0x...), and octal (0...) representations.
 */
// eslint-disable-next-line complexity -- multi-branch IP classification for IPv4/IPv6/octal/hex
function isPrivateIPv4(ip: string): boolean {
  // Normalize: strip leading zeros and handle octal/hex
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const numericParts: number[] = [];
  for (const part of parts) {
    const parsed = parseIPSegment(part);
    if (parsed === null || parsed < 0 || parsed > 255) return false;
    numericParts.push(parsed);
  }

  const a = numericParts[0];
  const b = numericParts[1];
  if (a === undefined || b === undefined) return false;

  // 10.x.x.x
  if (a === 10) return true;

  // 127.x.x.x (loopback)
  if (a === 127) return true;

  // 172.16.x.x - 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.x.x
  if (a === 192 && b === 168) return true;

  // 169.254.x.x (link-local)
  if (a === 169 && b === 254) return true;

  // 0.x.x.x
  if (a === 0) return true;

  return false;
}

/**
 * Parse an IP segment that may be decimal, hex (0x...), or octal (0...).
 */
function parseIPSegment(segment: string): number | null {
  if (!segment) return null;

  // Hex: 0x prefix
  if (segment.startsWith("0x") || segment.startsWith("0X")) {
    const val = parseInt(segment, 16);
    return Number.isNaN(val) ? null : val;
  }

  // Octal: starts with 0 and has more digits (but not just "0")
  if (segment.startsWith("0") && segment.length > 1) {
    const val = parseInt(segment, 8);
    return Number.isNaN(val) ? null : val;
  }

  // Decimal
  const val = parseInt(segment, 10);
  return Number.isNaN(val) ? null : val;
}

/**
 * Check if an IPv6 address is private/internal.
 * Also handles IPv4-mapped addresses (::ffff:x.x.x.x and ::ffff:XXXX:XXXX).
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped IPv6 in dotted-decimal: ::ffff:x.x.x.x
  const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    const ip = mappedMatch[1];
    if (ip === undefined) return false;
    return isPrivateIPv4(ip);
  }

  // IPv4-mapped IPv6 in hex format: ::ffff:XXXX:XXXX
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hiStr = mappedHex[1];
    const loStr = mappedHex[2];
    if (hiStr === undefined || loStr === undefined) return false;
    const hi = parseInt(hiStr, 16);
    const lo = parseInt(loStr, 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  // ::1 (loopback)
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;

  // fe80::/10 (link-local) — first 10 bits are 1111 1110 10
  // Hex prefix range: fe80–febf (the 3rd and 4th hex chars span 8 bits)
  if (lower.startsWith("fe")) {
    const h = lower.slice(2, 4);
    if (h >= "80" && h <= "bf") {
      return true;
    }
  }

  // fc00::/7 (unique local: fc00::/8 and fd00::/8)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  return false;
}

/**
 * Resolve a hostname via DNS and check if any resolved IP is private/internal.
 * Uses dns.promises.resolve4() and resolve6().
 * For IPv6, also check IPv4-mapped addresses (::ffff:x.x.x.x).
 * Returns true if ANY resolved IP is internal.
 */
export async function isBlockedByDns(hostname: string): Promise<boolean> {
  // Check IPv4 addresses
  try {
    const ipv4Addresses = await resolve4(hostname);
    for (const ip of ipv4Addresses) {
      if (isPrivateIPv4(ip)) return true;
    }
  } catch {
    // DNS resolution failed — not a sign of safety, but we continue to IPv6
  }

  // Check IPv6 addresses
  try {
    const ipv6Addresses = await resolve6(hostname);
    for (const ip of ipv6Addresses) {
      if (isPrivateIPv6(ip)) return true;
    }
  } catch {
    // DNS resolution failed — continue
  }

  return false;
}

/** Shared core SSRF validation logic.
 *  Checks scheme, IPv6 literals, hostname blocklist, and DNS resolution.
 *  Takes an optional context parameter for error messages (used by redirect variant).
 *  Throws Error with descriptive message if blocked. */
async function validateParsedUrlForSsrf(parsed: URL, context?: string): Promise<void> {
  // Check scheme
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const suffix = context ? ` (from ${context})` : "";
    throw new Error(`Invalid URL: scheme must be http or https. Got: ${parsed.protocol}${suffix}.`);
  }

  // Check IPv6 address literals
  if (parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")) {
    const ipv6 = parsed.hostname.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      const suffix = context ? ` (from ${context})` : "";
      throw new Error(`Blocked: IPv6 address ${parsed.hostname} is internal/private${suffix}.`);
    }
  }

  // Check hostname blocklist
  if (isBlockedHostname(parsed.hostname)) {
    const suffix = context ? ` from ${context}` : "";
    throw new Error(
      `Blocked: cannot fetch internal/private addresses (${parsed.hostname})${suffix}.`,
    );
  }

  // Resolve hostname via DNS, check resolved IPs
  const blocked = await isBlockedByDns(parsed.hostname);
  if (blocked) {
    const suffix = context ? ` (from ${context})` : "";
    throw new Error(`Blocked: resolved IP for ${parsed.hostname} is internal/private${suffix}.`);
  }
}

/** Full SSRF validation of a URL. Steps:
 *  1. Parse URL (throw descriptive Error if invalid)
 *  2. Check scheme is http or https
 *  3. Check hostname against static blocklist (isBlockedHostname)
 *  4. Resolve hostname via DNS, check resolved IPs (isBlockedByDns)
 *  5. Return the parsed URL object
 *  Throws Error with descriptive message if blocked. */
export async function validateUrlForSsrf(url: string): Promise<URL> {
  let parsed: URL;

  // Step 1: Parse URL
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  await validateParsedUrlForSsrf(parsed);

  // Step 5: Return the parsed URL
  return parsed;
}

/** Validate a redirect target URL for SSRF. Same checks as validateUrlForSsrf.
 *  Takes the from URL for logging purposes. */
export async function validateRedirectForSsrf(from: URL, to: URL): Promise<void> {
  await validateParsedUrlForSsrf(to, from.href);
}
