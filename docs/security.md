# Security Audit — pi-web-content

This document covers the security controls implemented in the `pi-web-content` extension. The extension operates in a trust boundary where untrusted URLs are fetched into the agent's environment, so defense-in-depth is applied at every layer.

For overall module context and data flow, see [docs/architecture.md](./architecture.md).

---

## Threat Model

The following threats are explicitly defended against:

- **SSRF (Server-Side Request Forgery)** — fetching internal or cloud-metadata endpoints via crafted URLs.
- **Command injection** — injecting shell metacharacters or git argument flags into clone URLs.
- **DNS rebinding** — resolving a benign hostname to a private IP after initial validation.
- **Redirect-based SSRF** — following HTTP redirects that chain from a public URL to an internal address.
- **Path traversal** — using `..` segments in the parsed owner/repo to escape the intended clone directory.
- **Content bombing** — sending oversized responses to exhaust memory or disk.
- **Symlink attacks** — pre-creating a symlink at the target clone path to redirect `git clone` writes to an arbitrary filesystem location.
- **Credential leakage** — exposing embedded `user:pass@` credentials in URLs to logs or downstream tools.

---

## SSRF Protection Layers

The extension uses a **multi-layer SSRF defense**. Each layer is independent; bypassing one does not bypass the rest.

### Layer 1 — URL Scheme Validation

| Source file | `src/fetch-content.ts` |
|---|---|
| Function | Entry-point regex in `execute()` |
| Logic | `^https?:\/\/` (web URLs) or `^git@` (SSH URLs) |
| Blocks | `file://`, `ftp://`, `gopher://`, `data://`, and all non-HTTP schemes. Also rejects any URL that doesn't match either pattern. |

### Layer 2 — Static Hostname Blocklist

| Source file | `src/ssrf.ts` |
|---|---|
| Function | `isBlockedHostname()` |
| Constants | `BLOCKED_HOSTNAMES`, `BLOCKED_HOSTNAME_PREFIXES` |

**Exact blocked values:**

| Constant | Values |
|---|---|
| `BLOCKED_HOSTNAMES` | `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]` |
| `BLOCKED_HOSTNAME_PREFIXES` | `10.`, `172.16.`–`172.31.` (all 16 subnets), `192.168.`, `169.254.` |

Comparison is case-insensitive (`hostname.toLowerCase()`). This catches obvious private-address attempts **before** any DNS resolution occurs.

### Layer 3 — DNS Resolution Validation

| Source file | `src/ssrf.ts` |
|---|---|
| Function | `isBlockedByDns()` → `isPrivateIPv4()` / `isPrivateIPv6()` |
| DNS APIs | `node:dns/promises` `resolve4()`, `resolve6()` |

After the static blocklist passes, the hostname is resolved via the system DNS resolver. Every returned A and AAAA record is checked:

- **`isPrivateIPv4()`** — flags `10.0.0.0/8`, `127.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, and `0.0.0.0/8`.
- **`isPrivateIPv6()`** — flags `::1` (loopback), IPv6 link-local (`fe80::`, `fe90::`, `fea0::`, `feb0::` — only the first four /12 subnets, not the full `fe80::/10` range `fe80`–`febf`), `fc00::/7` (unique-local), and IPv4-mapped addresses (`::ffff:x.x.x.x` in both dotted-decimal and hex `::ffff:XXXX:XXXX` forms).

If **any** resolved address is private, the request is blocked. DNS resolution failures are silently ignored (a failed lookup is not treated as safe).

### Layer 4 — Non-Decimal IP Normalization

| Source file | `src/ssrf.ts` |
|---|---|
| Function | `parseIPSegment()` |

Attackers can encode octets in hex (`0xC0`) or octal (`0300`) to evade string-matching blocklists. `parseIPSegment()` normalizes every IP segment:

| Prefix | Interpretation | Example |
|---|---|---|
| `0x` / `0X` | Hexadecimal (base 16) | `0xC0` → `192` |
| `0` followed by more digits | Octal (base 8) | `014` → `12` |
| No prefix | Decimal (base 10) | `192` → `192` |

Normalization occurs inside `isPrivateIPv4()` before the private-range checks, so `0177.0.0.1` (octal for `127.0.0.1`) is correctly detected as loopback.

### Layer 5 — IPv6 Literal Checking

| Source file | `src/ssrf.ts` |
|---|---|
| Function | `validateUrlForSsrf()` (inline check) |
| Location | Step 2.5, **before** the static hostname blocklist |

When `parsed.hostname` is bracketed (`[::1]`), the brackets are stripped and the inner address is passed directly to `isPrivateIPv6()`. This check runs **before** `isBlockedHostname()` so that `[::1]` is caught by the IPv6 private check even though `[::1]` also appears in `BLOCKED_HOSTNAMES`.

### Layer 6 — Redirect Validation

| Source file | `src/ssrf.ts` |
|---|---|
| Function | `validateRedirectForSsrf()` |
| Called from | `src/fetch-content.ts`, inside the manual redirect loop |

`fetch()` is called with `redirect: "manual"`, so the extension follows redirects itself. For every `3xx` response:

1. The `Location` header is resolved to an absolute URL.
2. `validateRedirectForSsrf(from, to)` runs the **full SSRF check** (scheme, IPv6 literal, static blocklist, DNS resolution) on the redirect target.
3. The loop caps at `MAX_REDIRECTS` (10) to prevent redirect-chain exhaustion.

This prevents an attacker from hosting a public page that `302`s to `http://169.254.169.254/latest/meta-data/`.

---

## Git URL Sanitization

`sanitizeGitUrl()` in [`src/fetch-content.ts`](../src/fetch-content.ts) applies seven sequential checks to the raw URL **before** it reaches `git clone`:

| Step | Check | Pattern | Effect |
|---|---|---|---|
| 1 | Length bounds | `url.length > 2048` or empty | Rejects DoS via extremely long URLs |
| 2 | Whitespace | `/\s/` | Rejects spaces, tabs, newlines — prevents argument splitting |
| 3 | `ext::` protocol | `/ext::/i` | Blocks [git ext remote helpers](https://git-scm.com/docs/gitremote-helpers), a known command injection vector |
| 4 | Shell metacharacters | `/[;|`$(){}!\\'"]/` | Rejects `;`, `|`, backtick, `$`, `(`, `)`, `{`, `}`, `!`, `\`, `'`, `"` |
| 4b | Control characters | Loop `charCodeAt(i)` for `0x00–0x1f` | Blocks NUL, bell, escape, and other control codes that `\s` misses |
| 5 | Character allowlist | `/^[a-zA-Z0-9\-_./:@#?=&]+$/` | Whitelist-only: only alphanumeric and `- _ . / : @ # ? = &` are permitted |
| 6 | Credential stripping | `/^(https?:\/\/)([^/@]+@)(.+)$/` | Strips `user:pass@` from HTTPS URLs |

The allowlist (step 5) is the strongest guarantee: even if an earlier regex check is bypassed, any character outside the allowed set causes rejection.

---

## TOCTOU Mitigation

In `executeRepoFetch()` ([`src/fetch-content.ts`](../src/fetch-content.ts)), before cloning:

```ts
const lstat = await fs.lstat(targetPath).catch(() => null);
if (lstat?.isSymbolicLink()) {
  throw new Error(`Refusing to clone: ${targetPath} is a symbolic link.`);
}
```

**What it prevents:** An attacker who can pre-create a symlink at `/tmp/repository-{owner}/{repo}` (e.g., via a prior request with a crafted owner name, or through a separate vulnerability) could cause `git clone` to write repository contents to an arbitrary filesystem location. The `lstat` check (which does **NOT** follow the link, unlike `stat`) detects this and aborts.

**Narrow TOCTOU window:** Between the `lstat` check and the subsequent `fs.rm` + `git clone`, an attacker with filesystem access could theoretically replace the directory with a symlink. This window is narrow (sub-millisecond under normal conditions) and requires a concurrent local race. The mitigation addresses the common case of a pre-existing symlink but does not guarantee atomicity against a determined local attacker with write access to `/tmp`.

---

## Content Size Limits

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `MAX_RESPONSE_BYTES` | 10 MB (`10 * 1024 * 1024`) | `fetch-content.ts` | Streaming body size cap |
| `MAX_REDIRECTS` | 10 | `fetch-content.ts` | Redirect chain limit |
| `FETCH_TIMEOUT_MS` | 30 000 ms (30 s) | `fetch-content.ts` | `AbortSignal.timeout()` on fetch |
| `GIT_CLONE_TIMEOUT_MS` | 120 000 ms (120 s) | `fetch-content.ts` | `pi.exec()` timeout for `git clone` |

### Why Streaming Over `Content-Length`

The `readResponseWithSizeLimit()` function reads the response body chunk-by-chunk, accumulating `totalBytes` and aborting if it exceeds `MAX_RESPONSE_BYTES`. This is preferred over checking the `Content-Length` header because:

- **Spoofing:** A malicious server can send `Content-Length: 100` and then stream 10 GB.
- **Chunked transfer encoding:** Responses may omit `Content-Length` entirely.
- **Compression:** The header reports compressed size, not decompressed size — a small compressed payload can decompress to many times its size.

Streaming enforcement guarantees that memory consumption never exceeds the limit, regardless of what the server claims.

---

## Subagent Isolation

When content is summarized, a pi subprocess is spawned with multiple isolation controls:

### UUID-Based Content Delimiters

[`src/summarize.ts`](../src/summarize.ts) wraps the fetched content with a unique boundary:

```ts
const delimiter = `---CONTENT_BOUNDARY_${randomUUID()}---`;
```

The content is embedded in the task prompt between two copies of this delimiter. Because each invocation generates a fresh UUID, prompt injection via content that contains the delimiter string is cryptographically infeasible.

### `--no-session` Flag

[`src/subagent.ts`](../src/subagent.ts) passes `--no-session` to the subprocess:

```ts
const args: string[] = ["--mode", "json", "-p", "--no-session"];
```

This ensures the subagent runs in a disposable session with no access to the user's conversation history, project state, or prior tool results.

### `shell: false`

The subprocess is spawned with `shell: false`:

```ts
const proc = spawn(invocation.command, invocation.args, {
  cwd,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

This prevents shell interpretation of arguments — the command and each argument are passed directly to `execve()`, eliminating shell injection even if an argument contained special characters.

### Abort Handling

If the parent `AbortSignal` fires, the subprocess receives `SIGTERM` followed by `SIGKILL` after a 5-second grace period (`SIGKILL_DELAY_MS`). This prevents orphaned subagent processes from continuing to consume resources.

---

## Credential Stripping

Credentials embedded in HTTPS URLs are removed at two points in the pipeline:

### 1. `stripCredentials()` in `detect-repo-url.ts`

When `isRepoUrl()` parses an HTTPS URL, it calls `stripCredentials()`:

```ts
function stripCredentials(parsed: URL): string {
  if (parsed.username || parsed.password) {
    const url = new URL(parsed.toString());
    url.username = "";
    url.password = "";
    return url.toString();
  }
  return parsed.toString();
}
```

This produces a `sanitizedUrl` (e.g., `https://github.com/org/repo`) that is returned in the `RepoUrlResult`. The sanitized URL is what flows through the rest of the pipeline — including SSRF validation and logging.

### 2. `sanitizeGitUrl()` in `fetch-content.ts`

As step 6 of the sanitization pipeline, `sanitizeGitUrl()` applies a second regex-based credential strip:

```ts
const httpsWithCreds = url.match(/^(https?:\/\/)([^/@]+@)(.+)$/);
if (httpsWithCreds) {
  return httpsWithCreds[1] + httpsWithCreds[3];
}
```

This catches any HTTPS URL with embedded credentials that may have reached this function through a path other than `isRepoUrl()`. Both functions together ensure credentials never appear in tool logs, error messages, or subprocess arguments.

---

## Summary of Defense Layers

| Threat | Primary defense | Backup defense |
|---|---|---|
| SSRF | `validateUrlForSsrf()` — static blocklist + DNS check | Manual redirect loop with `validateRedirectForSsrf()` |
| Command injection | `sanitizeGitUrl()` — 7-step sanitization + allowlist | `shell: false` in all subprocess spawns |
| DNS rebinding | `isBlockedByDns()` — resolve and check at fetch time | Static hostname blocklist catches common cases |
| Redirect SSRF | `redirect: "manual"` + per-redirect SSRF validation | `MAX_REDIRECTS` cap (10) |
| Path traversal | Owner/repo `..` and `.` check in `executeRepoFetch()` | `sanitizeGitUrl()` allowlist blocks `..` (not in allowed chars) |
| Content bombing | Streaming `readResponseWithSizeLimit()` at 10 MB | `FETCH_TIMEOUT_MS` (30 s) and `GIT_CLONE_TIMEOUT_MS` (120 s) |
| Symlink attacks | `fs.lstat()` pre-clone symlink check | Clone target is always under `/tmp/repository-{owner}/` |
| Credential leakage | `stripCredentials()` + `sanitizeGitUrl()` regex | `--no-session` prevents subagent from seeing prior context |
