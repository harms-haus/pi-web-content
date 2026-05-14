# Configuration

pi-web-content has **no runtime configuration file or user-facing settings**. All behavior is controlled by module-level constants in source code and tool parameters at invocation time. This page documents those constants, truncation behavior, git clone storage, subagent spawning, and HTML-to-Markdown conversion settings.

For module context and data flows, see [docs/architecture.md](./architecture.md). For security details, see [docs/security.md](./security.md).

## Tool Parameters

The `fetch_content` tool accepts these parameters at invocation:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | `string` | Yes | URL to fetch. Must start with `http://`, `https://`, or use SSH scheme (`git@`). |
| `summarize` | `string` | No | Directed prompt for summarization (e.g., `"find all references to bananas"`). When provided, content is summarized by a subagent instead of returned in full. |
| `branch` | `string` | No | Git branch to clone. Only applies when the URL is detected as a git repository. Defaults to the repository's default branch. |

Example invocation:

```
fetch_content(url="https://github.com/example/docs", summarize="list all API endpoints")
fetch_content(url="https://docs.python.org/3/library/json.html")
fetch_content(url="https://github.com/example/repo", branch="develop")
```

## Configurable Constants

All constants below are **hardcoded in source** — they are not user-configurable at runtime. To change them, modify the source file and recompile/restart the extension.

| Constant | File | Default Value | Purpose |
|----------|------|---------------|---------|
| `FETCH_TIMEOUT_MS` | `src/fetch-content.ts` | `30_000` (30s) | Timeout for HTTP fetch requests |
| `GIT_CLONE_TIMEOUT_MS` | `src/fetch-content.ts` | `120_000` (2m) | Timeout for `git clone` operations |
| `MAX_RESPONSE_BYTES` | `src/fetch-content.ts` | `10 * 1024 * 1024` (10 MB) | Maximum allowed response body size (enforced via streaming read) |
| `MAX_REDIRECTS` | `src/fetch-content.ts` | `10` | Maximum number of HTTP redirects to follow |
| `USER_AGENT` | `src/fetch-content.ts` | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36` | User-Agent header for HTTP requests |
| `ACCEPT_HEADER` | `src/fetch-content.ts` | `text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8` | Accept header for HTTP requests |
| `ACCEPT_LANGUAGE` | `src/fetch-content.ts` | `en-US,en;q=0.9` | Accept-Language header for HTTP requests |
| `SIGKILL_DELAY_MS` | `src/subagent.ts` | `5000` (5s) | Delay between SIGTERM and SIGKILL when aborting a subagent |
| `MAX_STDERR_LENGTH` | `src/subagent.ts` | `64 * 1024` (64 KB) | Maximum stderr buffer length from subagent |
| `BINARY_TYPES` | `src/html-to-markdown.ts` | Array of 8 MIME type prefixes | Content types rejected as binary (see below) |
| `BLOCKED_HOSTNAMES` | `src/ssrf.ts` | `["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]` | Exact hostnames always blocked for SSRF |
| `BLOCKED_HOSTNAME_PREFIXES` | `src/ssrf.ts` | 20 prefixes (`10.`, `172.16.`–`172.31.`, `192.168.`, `169.254.`) | Private IP range prefixes blocked for SSRF |
| `KNOWN_GIT_HOSTNAMES` | `src/detect-repo-url.ts` | Set of 10 hostnames | Hostnames recognized as git hosting platforms |
| `NON_REPO_SEGMENTS` | `src/detect-repo-url.ts` | Set of 38 path segments | URL path segments that indicate web UI pages (not repo content) |
| `REPO_SUBPATHS` | `src/detect-repo-url.ts` | `["tree", "blob", "raw", "src", "commits", "blame", "archive"]` | Path segments that indicate repo content |
| `DEFAULT_MAX_LINES` | `@earendil-works/pi-coding-agent` | `2000` | Max lines for `truncateHead()` — defines truncation threshold for fetched content |
| `DEFAULT_MAX_BYTES` | `@earendil-works/pi-coding-agent` | `50 * 1024` (50 KB) | Max bytes for `truncateHead()` — defines truncation threshold for fetched content |

### BINARY_TYPES

The following MIME type prefixes cause content to be rejected with an `Unsupported content type` error:

| Prefix | Examples |
|--------|----------|
| `image/` | `image/png`, `image/jpeg`, `image/gif` |
| `video/` | `video/mp4`, `video/webm` |
| `audio/` | `audio/mpeg`, `audio/ogg` |
| `application/pdf` | PDF documents |
| `application/zip` | ZIP archives |
| `application/octet-stream` | Generic binary |
| `application/x-gzip` | Gzip archives |
| `application/x-tar` | Tar archives |

### KNOWN_GIT_HOSTNAMES

URLs to these hosts are classified as git repositories (subject to path analysis):

```
github.com, www.github.com, gitlab.com, bitbucket.org, codeberg.org,
gitea.com, gitee.com, git.sr.ht, sr.ht, dev.azure.com
```

### BLOCKED_HOSTNAME_PREFIXES (full list)

Private IP ranges blocked by the SSRF guard:

```
10., 172.16., 172.17., 172.18., 172.19., 172.20., 172.21., 172.22.,
172.23., 172.24., 172.25., 172.26., 172.27., 172.28., 172.29.,
172.30., 172.31., 192.168., 169.254.
```

DNS resolution is also performed to catch dynamic/private IPs not caught by static prefix matching. See [docs/security.md](./security.md) for the full SSRF threat model.

## Truncation Behavior

When web content is fetched **without** the `summarize` parameter, the resulting Markdown is truncated via `truncateHead()` from `@earendil-works/pi-coding-agent`:

```ts
truncateHead(markdown, {
  maxLines: DEFAULT_MAX_LINES,  // 2000
  maxBytes: DEFAULT_MAX_BYTES,  // 50 KB
});
```

**Behavior:**

- Keeps the **first N lines** (up to `DEFAULT_MAX_LINES`) **and** the **first N bytes** (up to `DEFAULT_MAX_BYTES`), whichever limit is reached first.
- If truncated, the full content is written to a temp file at `/tmp/pi-fetch-{random}/content.md` where `{random}` is a unique directory name generated by `fs.mkdtemp()`.
- The temp file path is returned in `details.fullOutputPath`.
- Temp files are **intentionally NOT auto-cleaned**. The path is provided so the agent or user can access the full output in subsequent tool calls. Cleanup is deferred to the OS temp directory maintenance.
- A truncation notice is appended to the returned text:
  ```
  [Output truncated: showing {outputLines} of {totalLines} lines ({outputSize} of {totalSize}). Full output saved to: {fullOutputPath}]
  ```

When `summarize` is provided, truncation is **skipped** — the subagent receives the full content.

## Git Clone Storage

### Path

Cloned repositories are stored at:

```
/tmp/repository-{owner}/{repo}
```

Example: `https://github.com/torvalds/linux` → `/tmp/repository-torvalds/linux`

### Behavior

- **Shallow clone**: `git clone --depth 1 --single-branch` — only the latest commit of a single branch is fetched.
- **Optional branch**: If `branch` parameter is provided, `--branch {branch}` is appended to the clone command.
- **NOT auto-cleaned**: Cloned repos persist at `/tmp/repository-{owner}/{repo}` indefinitely. This is intentional — the agent is expected to explore the cloned repository via subsequent tool calls (`read`, `grep`, `ls`, `bash`).
- **Symlink protection**: Before cloning, `fs.lstat()` checks that the target path is not a symbolic link (TOCTOU mitigation).
- **Collision handling**: If a directory already exists at the target path, it is removed via `fs.rm({ recursive: true, force: true })` before cloning.
- **Partial clone cleanup**: If `git clone` fails, the partial directory is cleaned up.

## Subagent Behavior

When `summarize` is provided, a pi subprocess is spawned to analyze or summarize the content.

### Invocation

The subprocess is spawned with these flags:

```
pi --mode json -p --no-session
```

Or, depending on how the extension itself is invoked:

```
node /path/to/pi-entrypoint.js --mode json -p --no-session
```

### Pi Invocation Detection Order

The `getPiInvocation()` function in `src/subagent.ts` determines how to invoke pi:

1. **Bundled executable** — If `process.argv[1]` (the current script) exists on disk and is not a Bun virtual script (`/$bunfs/root/`), the subagent is invoked as `{process.execPath} {currentScript} …`. This handles standalone/packaged pi executables.
2. **Global pi** — If `process.execPath` is a generic runtime (`node` or `bun`), the subagent is invoked as `pi …` (from PATH).
3. **Direct executable** — If `process.execPath` is neither `node` nor `bun` (e.g., a custom binary), it is used directly as the command with the provided args.

### Content Delimiters

The content passed to the subagent is wrapped in a unique delimiter to prevent prompt injection:

```
---CONTENT_BOUNDARY_{randomUUID()}---
```

The full task prompt structure (assembled via `.filter(Boolean).join("\n")`, so no blank lines appear between sections):

```
{roleContext}
URL: {url}           (if provided)
Title: {title}       (if provided)
---CONTENT_BOUNDARY_{uuid}---
{content}
---CONTENT_BOUNDARY_{uuid}---
User's instruction: {summarize}
Provide a focused response based on the user's instruction above.
```

The UUID is generated via `crypto.randomUUID()`, making collision practically impossible.

### Abort Handling

If the caller's `AbortSignal` fires:

1. `SIGTERM` is sent to the subprocess.
2. After `SIGKILL_DELAY_MS` (5 seconds), if the process is still alive, `SIGKILL` is sent.
3. The result includes `error: "Subagent was aborted"` and empty text.

### Stderr Capping

Stderr output from the subprocess is capped at `MAX_STDERR_LENGTH` (64 KB). If exceeded, a `[stderr truncated]` marker is appended.

### Output Extraction

The subagent's stdout is parsed as NDJSON. Events of type `"message_end"` and `"tool_result_end"` are accumulated. The final output is extracted by scanning messages in reverse for the first `assistant`-role text content.

## Turndown Configuration

HTML-to-Markdown conversion uses a **singleton** `TurndownService` instance (safe to reuse across requests), configured as follows:

```ts
const turndownService = new TurndownService({
  headingStyle: "atx",         // # Heading
  codeBlockStyle: "fenced",    // ``` code
  bulletListMarker: "-",       // - item
  emDelimiter: "*",            // *italic*
  strongDelimiter: "**",       // **bold**
});

turndownService.use(gfm);                              // GitHub Flavored Markdown plugin
turndownService.remove(["script", "style", "iframe", "noscript"]);  // Removed elements
```

### Pipeline

1. **JSDOM** parses the raw HTML.
2. **Mozilla Readability** extracts the article body (strips navigation, ads, sidebars). If Readability fails (e.g., non-article page), falls back to the full `<body>` content.
3. **Turndown** converts the extracted HTML to Markdown with the settings above.
4. The GFM plugin adds support for tables, strikethrough, and task lists.
5. The JSDOM window is closed to free memory.

### Example Output

| Setting | Value | Example |
|---------|-------|---------|
| `headingStyle` | `"atx"` | `## Section` |
| `codeBlockStyle` | `"fenced"` | ` ```javascript\ncode\n``` ` |
| `bulletListMarker` | `"-"` | `- List item` |
| `emDelimiter` | `"*"` | `*italic*` |
| `strongDelimiter` | `"**"` | `**bold**` |

---

**Related documentation:**
- [Architecture](./architecture.md) — Module map, data flows, and dependency graph
- [Security](./security.md) — SSRF threat model, input sanitization, and defense-in-depth measures
- [Development](./development.md) — Testing, linting, and contribution guidelines
