# Troubleshooting

Common errors encountered when using the `fetch_content` tool, with symptoms, causes, and resolutions.

> For SSRF protection details, see [security.md](security.md).
> For configuration constants (timeouts, size limits), see [configuration.md](configuration.md).

---

## SSRF Blocks

| Field | Details |
|-------|---------|
| **Symptom** | `Blocked: cannot fetch internal/private addresses (<hostname>).` or `Blocked: resolved IP for <hostname> is internal/private.` |
| **Cause** | The URL resolves to a private or internal IP address (localhost, 10.x.x.x, 172.16–31.x.x, 192.168.x.x, 169.254.x.x, fc00::/7, fe80::/10, etc.). This includes DNS rebinding attacks — the tool resolves the hostname via DNS before fetching and blocks any result that maps to a private range. |
| **Resolution** | This is by design — the tool prevents Server-Side Request Forgery. To troubleshoot:<br>1. Run `nslookup <hostname>` or `dig <hostname>` to verify where the hostname resolves.<br>2. Corporate proxy or CDN configurations can cause false positives if they route through internal IPs. In that case, use a public-facing endpoint.<br>3. For redirect-based blocks, the message includes the source URL: `Blocked: redirect to internal/private address (<hostname>) from <source>.` Check the redirect chain in your browser. |

### DNS Resolution Failure (Fail-Closed)

| Field | Details |
|-------|---------|
| **Symptom** | `Blocked: could not resolve hostname "<hostname>" via DNS (resolution failed for both IPv4 and IPv6).` |
| **Cause** | The tool failed to resolve the hostname via DNS. This is a fail-closed behavior — if DNS resolution produces no results for either IPv4 or IPv6, the request is blocked rather than allowed through. Common causes:<br>• **DNS server unreachable** — no network connectivity or DNS server is down.<br>• **Hostname doesn't exist** — the domain name is misspelled or the DNS record has been removed. |
| **Resolution** | 1. Check network connectivity (`ping`, `curl`, or `nslookup`).<br>2. Verify the hostname is correct and has valid DNS records (`nslookup <hostname>` or `dig <hostname>`).<br>3. If behind a corporate proxy or firewall, ensure DNS resolution is not being intercepted or blocked. |

The full list of blocked hostname prefixes and DNS-checked IP ranges is defined in [`src/ssrf.ts`](../src/ssrf.ts). See [security.md](security.md) for a complete description of SSRF protection behavior.

---

## Binary Content Rejection

| Field | Details |
|-------|---------|
| **Symptom** | `Unsupported content type: <content-type>. This tool handles text-based content (HTML, JSON, plain text).` |
| **Cause** | The server returned a response with a binary `Content-Type` header. The tool rejects these content types:<br>`image/*`, `video/*`, `audio/*`, `application/pdf`, `application/zip`, `application/octet-stream`, `application/x-gzip`, `application/x-tar` |
| **Resolution** | `fetch_content` only handles text-based content (HTML, JSON, CSV, plain text). For binary files (images, PDFs, archives), use a different tool or download them via `bash` with `curl`/`wget`. |

---

## Git Clone Failures

| Field | Details |
|-------|---------|
| **Symptom** | `git clone failed for <owner>/<repo>. Exit code: <code>.` |
| **Cause** | The underlying `git clone --depth 1 --single-branch` command returned a non-zero exit code. Only the exit code is reported — raw stderr is **not** exposed in the error message. Common causes include:<br>• **Repository doesn't exist** — the URL is incorrect or the repo was deleted.<br>• **Private repository** — no SSH key or credentials configured for `git`.<br>• **Git not installed** — `git` is not available in the system PATH.<br>• **Network / firewall** — outbound connections to the git host are blocked.<br>• **Branch doesn't exist** — the `--branch` parameter specified a non-existent branch.<br>• **Permissions** — the `os.tmpdir()/repository-{owner}` directory cannot be created (filesystem permissions, disk full). |
| **Resolution** | Verify the URL in a browser, ensure `git` is installed (`git --version`), and check network connectivity. For SSH (`git@`) URLs, confirm your SSH keys are configured. To get more detail, run the `git clone` command manually in a terminal to see the full stderr output. |

Cloned repos are placed at `os.tmpdir()/repository-{owner}/{repo}` and persist after the tool returns. If a previous partial clone is stuck, manually remove the directory before retrying.

---

## Content Too Large

| Field | Details |
|-------|---------|
| **Symptom** | `Response body exceeds maximum size of 10 MB. Reading was aborted.` |
| **Cause** | The response body exceeded 10 MB (10,485,760 bytes) during streaming read. The tool enforces this limit regardless of the `Content-Length` header to prevent memory issues. |
| **Resolution** | Use the `summarize` parameter to have a subagent produce a condensed version instead of returning the full content. For example: `fetch_content(url, summarize="extract the key API endpoints")`. This avoids loading the entire body into memory. |

---

## Windows-Specific Notes

On Windows, the following behaviors are important to be aware of:

- **Temp directory location**: `os.tmpdir()` returns the Windows temp directory (typically `%LOCALAPPDATA%\Temp` or `%TEMP%`), not `/tmp`. Cloned repos are stored at `os.tmpdir()\repository-{owner}\{repo}`, and truncated content temp files are placed in `os.tmpdir()\pi-fetch-{random}`.
- **Reserved device names**: Owner and repo names matching Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) are rejected on all platforms. See [Windows Reserved Device Name Errors](#windows-reserved-device-name-errors) above.
- **Path separators**: While the tool handles path construction using `path.join()` (which produces `\` on Windows), any paths returned in error messages or output will use the platform-native separator.

---

## Summarization Failures

| Field | Details |
|-------|---------|
| **Symptom** | `Summarization failed: Subagent exited with code 1: <stderr or "(no output)">` |
| **Cause** | The pi subprocess used for summarization exited with a non-zero code. Common causes include:<br>• **pi not configured** — the `pi` CLI is not installed or not in PATH (or the extension's own executable path is misidentified).<br>• **No API key** — no AI provider API key is configured, so the subagent cannot generate a response.<br>• **Timeout** — the summarization task took too long and was cancelled via the abort signal.<br>• **Process error** — the subprocess failed to spawn entirely (error event captured as `Subagent process error: <message>`). |
| **Resolution** | Verify `pi` is installed and working (`pi --version`). Ensure an API key is configured for your AI provider. For timeouts, try a more focused `summarize` prompt to reduce the subagent's workload. Check stderr in the error message for additional diagnostics. |

---

## Fetch Timeouts

| Field | Details |
|-------|---------|
| **Symptom** | `Fetch cancelled for <url>` |
| **Cause** | The server did not respond within the 30-second fetch timeout, or the user/agent cancelled the operation. The tool uses `AbortSignal.timeout(30_000)` combined with any external abort signal. |
| **Resolution** | The target server may be slow or unreachable. Retry the request, or check connectivity to the host. If the operation was intentionally cancelled (e.g., user aborted), no action is needed. |

---

## Redirect Issues

| Field | Details |
|-------|---------|
| **Symptom** | `Redirect with no Location header from <url>` or any `Blocked: redirect to ...` message |
| **Cause** | The server returned a 3xx status code without a `Location` header, or redirected to an internal/private address (blocked by SSRF protection). The tool follows redirects manually (up to 10 hops) to validate each target for SSRF. |
| **Resolution** | Open the URL in a browser to inspect the redirect chain. If the redirect is legitimate but targets an internal address, the block is working as intended. If the `Location` header is missing, the server may be misconfigured. |

---

## URL Scheme Errors

| Field | Details |
|-------|---------|
| **Symptom** | `Invalid URL: must start with http:// or https://, or use SSH (git@) scheme. Got: <url>` |
| **Cause** | The URL does not match one of the supported schemes:<br>• `http://` or `https://` — for web fetches and HTTPS git URLs<br>• `git@` — for SSH git URLs (e.g., `git@github.com:org/repo.git`)<br>Other schemes like `ftp://`, `file://`, `data://`, etc. are rejected. |
| **Resolution** | Use a supported URL scheme. For SSH git access, use the `git@host:org/repo` format. For web content, ensure the URL starts with `http://` or `https://`. |

---

## Windows Reserved Device Name Errors

| Field | Details |
|-------|---------|
| **Symptom** | `Invalid repository owner or name: reserved device name on Windows.` |
| **Cause** | The repository owner or name matches a Windows reserved device name: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, or `LPT1`–`LPT9` (case-insensitive, with or without a trailing extension). This check applies on **all platforms** to prevent cross-platform filesystem issues. |
| **Resolution** | This is by design — the tool rejects these names to prevent path conflicts on Windows. There is no workaround. Use a different owner or repository name. |

---

## Branch Validation Errors

| Field | Details |
|-------|---------|
| **Symptom** | `Invalid branch name: <name>. Branch names must contain only alphanumeric characters, /, ., _, and -; cannot contain .., ~, ^, or :, and cannot end with .lock, /, or .` |
| **Cause** | The `branch` parameter contains invalid characters (shell metacharacters, spaces, control characters, etc.) or uses disallowed patterns like `..`, `~`, `^`, `:`, or ends with `.lock`, `/`, or `.`. The branch name is validated before the `git clone` command is constructed to prevent command injection. |
| **Resolution** | Use valid git branch names containing only alphanumeric characters, `/`, `.`, `_`, and `-`. Avoid shell metacharacters, spaces, and control characters. |
