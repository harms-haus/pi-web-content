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

HTTPS URLs that pass the initial regex then go through `validateUrlForSsrf()` (in [`src/ssrf.ts`](../src/ssrf.ts)), which delegates to the shared `validateParsedUrlForSsrf()` helper for scheme, IPv6, blocklist, and DNS checks. SSH URLs are validated separately in Layer 7. |

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
- **`isPrivateIPv6()`** — flags `::1` (loopback), IPv6 link-local addresses (`fe80::/10` — matches `fe80` through `febf`), `fc00::/7` (unique-local), and IPv4-mapped addresses (`::ffff:x.x.x.x` in both dotted-decimal and hex `::ffff:XXXX:XXXX` forms).

If **any** resolved address is private, the request is blocked.

DNS resolution is **fail-closed**: `isBlockedByDns()` uses `Promise.allSettled` to resolve both IPv4 (`resolve4`) and IPv6 (`resolve6`) in parallel. If **both** resolutions fail (i.e., no A or AAAA records are returned at all), the function throws:

```
Blocked: could not resolve hostname "..." via DNS (resolution failed for both IPv4 and IPv6).
```

A hostname that cannot be resolved at all is treated as blocked rather than allowed.

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
| Function | `validateParsedUrlForSsrf()` (inline check) |
| Location | Step 2, **before** the static hostname blocklist |

When `parsed.hostname` is bracketed (`[::1]`), the brackets are stripped and the inner address is passed directly to `isPrivateIPv6()`. This check runs **before** `isBlockedHostname()` so that `[::1]` is caught by the IPv6 private check even though `[::1]` also appears in `BLOCKED_HOSTNAMES`.

### Layer 6 — Redirect Validation

| Source file | `src/ssrf.ts` |
|---|---|
| Function | `validateRedirectForSsrf()` → `validateParsedUrlForSsrf()` |
| Called from | `src/execute-web-fetch.ts`, inside the manual redirect loop |

Both `validateUrlForSsrf()` (Layer 1 initial check) and `validateRedirectForSsrf()` (redirect check) share a common `validateParsedUrlForSsrf()` helper that runs scheme validation, IPv6 literal checking, static hostname blocklist, and DNS resolution. This eliminates duplication and ensures the same checks apply to both initial URLs and redirect targets.

`fetch()` is called with `redirect: "manual"`, so the extension follows redirects itself. For every `3xx` response:

1. The `Location` header is resolved to an absolute URL.
2. `validateRedirectForSsrf(from, to)` delegates to `validateParsedUrlForSsrf(to, from.href)`, running the **full SSRF check** (scheme, IPv6 literal, static blocklist, DNS resolution) on the redirect target with context from the source URL.
3. The loop caps at `MAX_REDIRECTS` (10) to prevent redirect-chain exhaustion.

This prevents an attacker from hosting a public page that `302`s to `http://169.254.169.254/latest/meta-data/`.

### Layer 7 — SSH URL SSRF Validation

| Source file | `src/execute-repo-fetch.ts` |
|---|---|
| Function | `executeRepoFetch()` (SSH branch) |
| Helpers | `isBlockedHostname()`, `isBlockedByDns()` from `src/ssrf.ts` |

When the detected repository URL uses the SSH scheme (`git@host:owner/repo`), the hostname is extracted and checked against the same SSRF defenses used for HTTP URLs:

1. **Static hostname blocklist** — `isBlockedHostname(hostname)` checks against `BLOCKED_HOSTNAMES` and `BLOCKED_HOSTNAME_PREFIXES`.
2. **DNS resolution + private IP check** — `isBlockedByDns(hostname)` resolves the hostname and verifies no A/AAAA records point to private or internal addresses.

This closes a gap where an attacker could use `git@127.0.0.1:...` or `git@10.0.0.1:...` to bypass HTTP-only SSRF checks.

---

## Git URL Sanitization

`sanitizeGitUrl()` in [`src/sanitize-git-url.ts`](../src/sanitize-git-url.ts) applies seven sequential checks to the raw URL **before** it reaches `git clone`:

| Step | Check | Pattern | Effect |
|---|---|---|---|
| 1 | Length bounds | `url.length > 2048` or empty | Rejects DoS via extremely long URLs |
| 2 | Whitespace | `/\s/` | Rejects spaces, tabs, newlines — prevents argument splitting |
| 3 | `ext::` protocol | `/ext::/i` | Blocks [git ext remote helpers](https://git-scm.com/docs/gitremote-helpers), a known command injection vector |
| 4 | Shell metacharacters | `/[;|`$(){}!\\'"]/` | Rejects `;`, `|`, backtick, `$`, `(`, `)`, `{`, `}`, `!`, `\`, `'`, `"` |
| 4b | Control characters | Loop `charCodeAt(i)` for `0x00–0x1f` | Blocks NUL, bell, escape, and other control codes that `\s` misses |
| 5 | Character allowlist | `/^[a-zA-Z0-9\-_./:@#?=&%]+$/` | Whitelist-only: only alphanumeric, `- _ . / : @ # ? = & %` are permitted (`%` supports percent-encoded URLs) |
| 6 | Credential stripping | URL API (`new URL()`) | Strips `user:pass@` from HTTPS URLs by setting `username` and `password` to empty strings |

The allowlist (step 5) is the strongest guarantee: even if an earlier regex check is bypassed, any character outside the allowed set causes rejection. The `%` character is included to support percent-encoded URLs (e.g., `https://github.com/org/repo%20name`).

---

## Branch Validation

In `executeRepoFetch()` ([`src/execute-repo-fetch.ts`](../src/execute-repo-fetch.ts)), the optional `branch` parameter is validated against git naming rules **before** being passed to `git clone --branch`:

| Rule | Check |
|---|---|
| Max length | `branch.length <= 256` |
| Allowed characters | `/^[a-zA-Z0-9\/._-]+$/` — alphanumeric, `/`, `.`, `_`, `-` |
| No `..` | `branch.includes("..")` — prevents path traversal in branch refs |
| No `~ ^ :` | `/[~^:]/.test(branch)` — git metacharacters that have special meaning |
| Can't end with `/` | `branch.endsWith("/")` |
| Can't end with `.` | `branch.endsWith(".")` |
| Can't end with `.lock` | `branch.endsWith(".lock")` |

If validation fails, the branch name is included in the error message (truncated to 50 characters) along with the allowed character rules. This prevents an attacker from injecting git flags or ref manipulation via the branch parameter.

## Windows Reserved Device Names

In `executeRepoFetch()` ([`src/execute-repo-fetch.ts`](../src/execute-repo-fetch.ts)), the parsed `owner` and `repo` segments are checked against Windows reserved device names:

```ts
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
```

This blocks `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, and `LPT1`–`LPT9` as owner or repo names on **all** platforms (not just Windows). On Windows, these names are treated as device paths by the kernel — a directory named `CON` could resolve to the console device rather than a filesystem path, enabling path-based attacks. The check applies universally so that cross-platform clones never create paths that would be dangerous on Windows.

## Git Error Sanitization

When `git clone` fails in `executeRepoFetch()` ([`src/execute-repo-fetch.ts`](../src/execute-repo-fetch.ts)), the error message is **sanitized** to exclude raw `stderr` output:

```ts
throw new Error(
  `git clone failed for ${owner}/${repo}. ${result.code ? `Exit code: ${result.code}.` : "Unknown error."}`,
);
```

Only the **exit code** is reported — never the full stderr. Git error messages can leak sensitive information such as filesystem paths, server configuration details, or network topology. The partial clone directory is also cleaned up on failure via `fs.rm({ recursive: true, force: true })`. The `fs.rm` error handler only catches `ENOTEMPTY` (which can occur during race conditions); all other errors (e.g., `EACCES`, `EPERM`, `EBUSY`) are propagated.

## TOCTOU Mitigation

In `executeRepoFetch()` ([`src/execute-repo-fetch.ts`](../src/execute-repo-fetch.ts)), before cloning:

```ts
const lstat = await fs.lstat(targetPath).catch(() => null);
if (lstat?.isSymbolicLink()) {
  throw new Error(`Refusing to clone: ${targetPath} is a symbolic link.`);
}
```

**What it prevents:** An attacker who can pre-create a symlink at `os.tmpdir()/repository-{owner}/{repo}` (e.g., via a prior request with a crafted owner name, or through a separate vulnerability) could cause `git clone` to write repository contents to an arbitrary filesystem location. The `lstat` check (which does **NOT** follow the link, unlike `stat`) detects this and aborts.

**Narrow TOCTOU window:** Between the `lstat` check and the subsequent `fs.rm` + `git clone`, an attacker with filesystem access could theoretically replace the directory with a symlink. This window is narrow (sub-millisecond under normal conditions) and requires a concurrent local race. The mitigation addresses the common case of a pre-existing symlink but does not guarantee atomicity against a determined local attacker with write access to the temp directory (`os.tmpdir()`).

---

## Content Size Limits

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `MAX_RESPONSE_BYTES` | 10 MB (`10 * 1024 * 1024`) | `fetch-constants.ts` | Streaming body size cap |
| `MAX_REDIRECTS` | 10 | `fetch-constants.ts` | Redirect chain limit |
| `FETCH_TIMEOUT_MS` | 30 000 ms (30 s) | `fetch-constants.ts` | `AbortSignal.timeout()` on fetch |
| `GIT_CLONE_TIMEOUT_MS` | 120 000 ms (120 s) | `fetch-constants.ts` | `pi.exec()` timeout for `git clone` |

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

### Platform-Dependent Shell Invocation

The subprocess spawn behavior depends on the platform, determined by `getPiInvocation()` in [`src/subagent.ts`](../src/subagent.ts):

- **Unix (Linux, macOS):** `shell: false` — the command and each argument are passed directly to `execve()`, eliminating shell injection even if an argument contained special characters.
- **Windows:** `shell: true` — required to resolve `.cmd` wrapper scripts (e.g., `pi.cmd`). Without `shell: true`, Windows cannot find and execute `.cmd` files via `child_process.spawn`.

When `shell: true` is used on Windows, Node.js automatically shell-escapes array arguments by wrapping them in double quotes. This prevents `cmd.exe` from interpreting special characters (e.g., `&`, `|`, `>`) in the task prompt:

```ts
const proc = spawn(invocation.command, invocation.args, {
  cwd,
  shell: invocation.useShell, // false on Unix, true on Windows
  stdio: ["ignore", "pipe", "pipe"],
});
```

This is safe because arguments are passed as an **array** (not a concatenated string), ensuring each argument is individually quoted by Node.js.

### Abort Handling

If the parent `AbortSignal` fires, the subprocess is terminated with platform-appropriate behavior:

- **Unix (Linux, macOS):** `SIGTERM` is sent first for graceful shutdown. If the process does not exit within 5 seconds (`SIGKILL_DELAY_MS`), it escalates to `SIGKILL`.
- **Windows:** `proc.kill()` is called directly. Windows does not support Unix-style signals, so `proc.kill()` forcefully terminates the process — no signal escalation is needed.

This prevents orphaned subagent processes from continuing to consume resources.

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

### 2. `sanitizeGitUrl()` in `sanitize-git-url.ts`

As step 6 of the sanitization pipeline, `sanitizeGitUrl()` applies a second credential strip using the **URL API** (not regex), mirroring the approach in `detect-repo-url.ts`:

```ts
try {
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  }
} catch {
  // Not a URL-parseable string (e.g., SSH URL); fall through
}
```

This catches any HTTPS URL with embedded credentials that may have reached this function through a path other than `isRepoUrl()`. Both functions together ensure credentials never appear in tool logs, error messages, or subprocess arguments. SSH URLs (e.g., `git@host:owner/repo`) are not parseable by the URL API and fall through unchanged.

---

## Summary of Defense Layers

| Threat | Primary defense | Backup defense |
|---|---|---|
| SSRF (HTTP) | `validateUrlForSsrf()` — static blocklist + DNS check | Manual redirect loop with `validateRedirectForSsrf()` |
| SSRF (SSH) | `isBlockedHostname()` + `isBlockedByDns()` on SSH hostname | `sanitizeGitUrl()` allowlist limits hostname characters |
| Command injection | `sanitizeGitUrl()` — 7-step sanitization + allowlist | `shell: false` (Unix) / auto-quoted `shell: true` (Windows) in subprocess spawns |
| DNS rebinding | `isBlockedByDns()` — resolve and check at fetch time | Static hostname blocklist catches common cases |
| Redirect SSRF | `redirect: "manual"` + per-redirect SSRF validation | `MAX_REDIRECTS` cap (10) |
| Path traversal | Owner/repo `..` and `.` check in `executeRepoFetch()` | `sanitizeGitUrl()` allowlist blocks `..` (not in allowed chars) |
| Branch injection | Branch name validation (alphanumeric + `/._-`, max 256 chars, no `..~^:`, can't end with `.lock`/`.`/`) | `sanitizeGitUrl()` allowlist limits URL characters |
| Content bombing | Streaming `readResponseWithSizeLimit()` at 10 MB | `FETCH_TIMEOUT_MS` (30 s) and `GIT_CLONE_TIMEOUT_MS` (120 s) |
| Symlink attacks | `fs.lstat()` pre-clone symlink check | Clone target is always under `os.tmpdir()/repository-{owner}/` |
| Credential leakage | `stripCredentials()` + `sanitizeGitUrl()` via URL API | `--no-session` prevents subagent from seeing prior context |
| Git error leakage | Clone errors sanitized to exit code only (no raw stderr) | Partial clone directory cleaned up on failure |
