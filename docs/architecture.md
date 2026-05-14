# Architecture

## Overview

pi-web-content is a [pi](https://github.com/earendil-works/pi) extension that registers a single tool — `fetch_content` — to retrieve and process remote content. The tool auto-detects whether a given URL points to a web page or a git repository, routing to the appropriate fetch path: web URLs are fetched over HTTP, HTML is cleaned via Mozilla Readability and converted to Markdown, while git repo URLs trigger a shallow clone to a local temp directory. Both paths optionally delegate to a pi subagent for summarization. There is no build step — the extension is loaded directly from `src/index.ts` via the `"pi.extensions"` field in `package.json`, with TypeScript compiled on the fly by the pi runtime.

## Module Map

| Module | File | Responsibility | Key Exports | Internal Dependencies |
|--------|------|----------------|-------------|----------------------|
| **Entry point** | `src/index.ts` | Extension registration with pi host | `default` (extension factory) | `fetch-content.ts` |
| **fetch_content tool** | `src/fetch-content.ts` | Unified tool definition: URL validation, routing, web fetch, git clone, truncation | `createFetchContentTool(pi)` | All modules except `turndown-plugin-gfm.d.ts` |
| **URL detector** | `src/detect-repo-url.ts` | Classifies a URL as git repo vs. web page via hostname/path heuristics | `isRepoUrl(url)`, `RepoUrlResult`, `stripCredentials(url)` _(internal, not exported)_ | — |
| **URL parser** | `src/parse-repo-url.ts` | Extracts `owner`/`repo` from SSH, HTTPS, and generic git URLs | `parseRepoUrl(url)`, `RepoInfo` | — |
| **SSRF guard** | `src/ssrf.ts` | Validates URLs against SSRF: static hostname blocklist, DNS resolution, IP range checks, redirect validation | `validateUrlForSsrf(url)`, `validateRedirectForSsrf(from, to)`, `isBlockedHostname(hostname)`, `isBlockedByDns(hostname)` | — |
| **HTML→Markdown** | `src/html-to-markdown.ts` | Strips boilerplate via Readability, converts HTML to Markdown via Turndown + GFM | `htmlToMarkdown(html, url)`, `BINARY_TYPES`, `HtmlToMarkdownResult` | — |
| **Summarizer** | `src/summarize.ts` | Constructs subagent prompt with UUID-bounded content delimiter, delegates to subagent | `summarizeWithSubagent(options)`, `SummarizeOptions` | `subagent.ts` |
| **Subagent runner** | `src/subagent.ts` | Spawns pi as a subprocess in `--mode json`, parses NDJSON stdout, handles abort (SIGTERM→SIGKILL) | `runSubagent(task, cwd, signal)`, `SubagentResult` | — |
| **TUI renderers** | `src/tool-renderers.ts` | Shared call/result text rendering for the pi TUI | `renderToolCall(toolName, args, theme)`, `renderToolResult(result, details, {isPartial}, theme, options?)` | — |

## URL Classification Constants

The repo-vs-web detection in `detect-repo-url.ts` relies on two path-segment classification sets:

### `NON_REPO_SEGMENTS`

A `Set<string>` of URL path segments that indicate **web UI pages** rather than repository content. When a known git host URL contains one of these segments in its path, the URL is classified as **web** (not a repo).

| Segment | Example |
|---------|---------|
| `issues` | `github.com/owner/repo/issues/42` |
| `pulls` | `github.com/owner/repo/pulls` |
| `pull` | `github.com/owner/repo/pull/123` |
| `wiki` | `github.com/owner/repo/wiki/Home` |
| `settings` | `github.com/owner/repo/settings` |
| `actions` | `github.com/owner/repo/actions` |
| `discussions` | `github.com/owner/repo/discussions` |
| `releases` | `github.com/owner/repo/releases` |
| `tags` | `github.com/owner/repo/tags` |
| `projects` | `github.com/owner/repo/projects` |

### `REPO_SUBPATHS`

A `Set<string>` of URL path segments that indicate **repository content views**. When a known git host URL contains one of these segments, the URL is classified as a **repo** — the subagent can clone and explore the repo filesystem.

| Segment | Purpose |
|---------|---------|
| `tree` | Browse directory tree |
| `blob` | View file contents |
| `raw` | Raw file download |
| `src` | Source file view (GitLab) |
| `commits` | Commit history |
| `blame` | Line-by-line attribution |
| `archive` | Archive/tarball download |

These sets allow the detector to distinguish between `github.com/owner/repo` (cloneable repo) and `github.com/owner/repo/issues` (web UI page), even though both share the same hostname.

## Data Flow — Web Fetch

1. **Tool invocation** — `index.ts` registers the tool via `createFetchContentTool(pi)`. The pi host calls `execute(toolCallId, params, signal, onUpdate, ctx)`.

2. **Scheme validation** — The URL must match `^https?://` or `^git@`. Anything else throws.

3. **Repo detection** — `isRepoUrl(url)` ([detect-repo-url.ts](../src/detect-repo-url.ts)) applies priority-ordered rules:
   - `git@` prefix → SSH repo
   - `.git` in path → repo
   - Known git host + repo-like path → repo
   - Known git host + non-repo path → web
   - Unknown host → web (default)
   
   If `isRepo: true`, routing jumps to the [Git Clone flow](#data-flow--git-clone).

4. **SSRF validation** — `validateUrlForSsrf(url)` ([ssrf.ts](../src/ssrf.ts)) checks scheme, static hostname blocklist, and DNS-resolved IPs. Throws `Blocked: …` on failure. See [docs/security.md](./security.md) for the full threat model.

5. **Streaming: fetching** — An `onUpdate` callback fires `{ status: "fetching" }`.

6. **HTTP fetch with manual redirects** — A loop (max 10 redirects) issues `fetch()` with `redirect: "manual"`. Each redirect's `Location` header is validated via `validateRedirectForSsrf()` to prevent SSRF-to-internal on redirect. A 30-second `AbortSignal.timeout` is combined with the caller's signal via `AbortSignal.any()`.

7. **Response validation** — Non-OK status throws `HTTP {status} {statusText}`. The body is read via `readResponseWithSizeLimit()` — a streaming reader that aborts if the total exceeds `MAX_RESPONSE_BYTES` (10 MB), regardless of `Content-Length`.

8. **Content-type routing**:

   | Content-Type | Handling |
   |---|---|
   | `application/json` | Wrapped in `# JSON Response` heading + fenced `json` code block. Title: `"JSON Response"`. |
   | `text/plain`, `text/csv` | Wrapped in `# Content from {url}` heading + fenced code block. Title: `"Text Response"`. |
   | `text/html`, `application/xhtml+xml` | Passed to `htmlToMarkdown()` ([html-to-markdown.ts](../src/html-to-markdown.ts)). Streaming update: `"converting"`. |
   | Binary types (`image/*`, `video/*`, `audio/*`, `application/pdf`, `application/zip`, etc.) | **Rejected** with `Unsupported content type` error. See `BINARY_TYPES` constant. |
   | Other | Returned as-is with `# Content from {url}` heading. |

   Binary content rejection is a separate check after the size-limited read — it ensures no binary payload is processed further.

9. **HTML→Markdown conversion** (HTML path only) — `htmlToMarkdown()` creates a `JSDOM` instance, runs Mozilla Readability to extract the article body, falls back to `<body>` if Readability fails, then converts to Markdown via a singleton TurndownService with GFM plugin. The JSDOM window is closed afterward.

10. **Optional summarization** — If `params.summarize` is set, the markdown is passed to `summarizeWithSubagent()`. See [Data Flow — Summarization](#data-flow--summarization).

11. **Truncation** — If not summarized, the markdown is truncated via `truncateHead()` from `pi-coding-agent` using `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`. If truncated, the full content is written to a temp file (`/tmp/pi-fetch-{random}/content.md`) and the path is returned in `details.fullOutputPath`.

12. **Return** — The result includes the (possibly truncated) markdown with a header of `# {title}` and `**Source:** {finalUrl}`.

### FetchContentDetails Interface

The `details` object attached to every tool result:

```ts
interface FetchContentDetails {
  url?: string;              // Final resolved URL
  title?: string;            // Page title (web only)
  summarized?: boolean;      // Whether summarization was applied
  summarizePrompt?: string;  // The user's summarize directive
  contentLength?: number;    // Markdown length in characters
  truncated?: boolean;       // Whether output was truncated
  fullOutputPath?: string;   // Path to full output file (if truncated)
  status?: string;           // Current operation status (streaming)
  type: "web" | "repo";      // Fetch type discriminator
  // — Repo-only fields —
  owner?: string;
  repo?: string;
  targetPath?: string;       // Local clone path
  branch?: string;           // Cloned branch
}
```

## Data Flow — Git Clone

Triggered when `isRepoUrl(url)` returns `isRepo: true`.

1. **SSRF validation** (HTTPS only) — If `repoResult.scheme === "https"` and `repoResult.sanitizedUrl` exists, `validateUrlForSsrf()` is called. SSH URLs (`git@…`) skip this check because they cannot be fetched via HTTP.

2. **URL sanitization** — `sanitizeGitUrl()` applies defense-in-depth checks:
   - Rejects empty or >2048 char URLs
   - Rejects whitespace
   - Rejects `ext::` protocol injection
   - Rejects shell metacharacters (`;|`$(){}!\'"` )
   - Rejects control characters (0x00–0x1f)
   - Strict allowlist: `[a-zA-Z0-9\-_./:@#?=&]+`
   - Strips embedded credentials from HTTPS URLs

3. **Owner/repo extraction** — `parseRepoUrl(sanitizedUrl)` applies regex patterns for SSH (`git@host:owner/repo`), HTTPS (`https://host/owner/repo`), and generic fallback. Both `owner` and `repo` are validated against `^~?[a-zA-Z0-9._-]+$`. Returns `null` on failure.

4. **Path traversal check** — Explicitly rejects `owner` or `repo` values of `".."` or `"."`.

5. **Target path construction** — `/tmp/repository-{owner}/{repo}`. Cloned repos persist intentionally for subsequent agent access.

6. **Symlink check** — `fs.lstat(targetPath)` verifies the target is not a symbolic link before proceeding (TOCTOU mitigation).

7. **Directory preparation** — Existing directory is removed via `fs.rm({ recursive: true, force: true })`. Parent directory is created.

8. **Git clone** — Executes `git clone --depth 1 --single-branch [--branch {branch}] -- {sanitizedUrl} {targetPath}` with a 120-second timeout. If the clone fails, the partial directory is cleaned up and the stderr is thrown.

9. **Optional summarization** — If `params.summarize` is set, `summarizeWithSubagent()` is called with `cwd: targetPath` so the subagent can explore the repo filesystem. See [Data Flow — Summarization](#data-flow--summarization).

10. **Return** — Without summarization, returns the clone path, owner, repo, and URL as structured text. With summarization, returns the subagent's analysis.

## Data Flow — Summarization

Used by both the web fetch and git clone paths when `params.summarize` is provided.

1. **Streaming: summarizing** — `onUpdate` fires `{ status: "summarizing" }`.

2. **Delimiter generation** — A unique boundary string is created: `---CONTENT_BOUNDARY_{randomUUID()}---`.

3. **Prompt construction** — The task prompt is assembled as:

   ```
   {roleContext}
   URL: {url}                    (if provided)
   Title: {title}                (if provided)

   {delimiter}
   {content}
   {delimiter}

   User's instruction: {summarize}

   Provide a focused response based on the user's instruction above.
   ```

   The UUID-bounded delimiter prevents prompt injection: the content is visually delimited and the subagent is instructed to respond to the user instruction that follows.

4. **Subprocess spawning** — `runSubagent()` ([subagent.ts](../src/subagent.ts)) determines how to invoke pi:
   - If the current script is a real file (not a Bun virtual script), it re-invokes via `process.execPath {script} …`
   - If `process.execPath` is not `node` or `bun`, it is used directly as the command
   - Otherwise, invokes `pi` from PATH
   
   The subprocess is spawned with `--mode json -p --no-session` and `stdio: ["ignore", "pipe", "pipe"]`.

5. **NDJSON parsing** — The subprocess stdout is line-buffered. Each line is parsed as JSON. Events of type `"message_end"` and `"tool_result_end"` have their `message` field accumulated.

6. **Output extraction** — `getFinalOutput()` scans the accumulated messages in reverse, returning the first `assistant` role message's text content.

7. **Stderr capping** — Stderr is capped at 64 KB. If exceeded, it is truncated with a `[stderr truncated]` marker.

8. **Abort handling** — If the caller's `AbortSignal` fires:
   - `proc.kill("SIGTERM")` is sent
   - After 5 seconds (`SIGKILL_DELAY_MS`), if the process is still alive, `proc.kill("SIGKILL")` is sent
   - The result includes `error: "Subagent was aborted"` and empty text

9. **Error propagation** — If the subagent exits non-zero with no text output, the error includes the exit code and capped stderr. This is re-thrown by `summarizeWithSubagent()` as `Summarization failed: …`.

10. **Return** — `{ content: [{ type: "text", text }], summarized: true, summarizePrompt }`.

## Dependency Graph

```
index.ts
└── fetch-content.ts
    ├── detect-repo-url.ts      (URL → repo vs web classification)
    ├── parse-repo-url.ts       (URL → { owner, repo })
    ├── ssrf.ts                 (URL validation against SSRF)
    ├── html-to-markdown.ts     (HTML → Markdown via Readability + Turndown)
    │   └── turndown-plugin-gfm (GFM markdown extensions)
    ├── summarize.ts            (Prompt construction + subagent delegation)
    │   └── subagent.ts         (Subprocess spawn + NDJSON parsing)
    └── tool-renderers.ts       (TUI call/result text rendering)
```

**External runtime imports** (not shown above):

```
html-to-markdown.ts
├── @mozilla/readability        (Readability)
├── jsdom                       (JSDOM)
├── turndown                    (TurndownService)
└── turndown-plugin-gfm         (gfm plugin)

fetch-content.ts
└── @earendil-works/pi-coding-agent
    └── (DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead)
```

## External Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@mozilla/readability` | `^0.6.0` | Extracts article content from HTML, stripping navigation/ads/sidebars |
| `jsdom` | `^26.0.0` | DOM parsing environment for Readability |
| `turndown` | `^7.2.0` | Converts HTML DOM to Markdown |
| `turndown-plugin-gfm` | `^1.0.2` | GitHub Flavored Markdown support (tables, strikethrough) |

### Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@earendil-works/pi-agent-core` | `*` | Core agent types (`ExtensionAPI`, `ExtensionContext`, `AgentToolUpdateCallback`, `Theme`) |
| `@earendil-works/pi-ai` | `*` | AI message types (`Message`) used by subagent NDJSON parsing |
| `@earendil-works/pi-coding-agent` | `*` | Tool registration, `truncateHead`, `formatSize`, default limits, `Theme` |
| `@earendil-works/pi-tui` | `*` | TUI `Text` component for renderCall/renderResult |
| `typebox` | `*` | Schema validation for tool parameters (`Type.Object`, `Type.String`) |

### Overrides

```json
"@mistralai/mistralai": "npm:empty-npm-package@1.0.0"
```
The Mistral SDK is replaced with an empty package to avoid pulling in its transitive dependencies.

## File Layout

```
pi-web-content/
├── .bifrost.yaml
├── .gitignore
├── biome.json
├── LICENSE
├── package.json
├── package-lock.json
├── README.md
├── tsconfig.json
├── vitest.config.ts
├── docs/
│   └── architecture.md          ← This file
└── src/
    ├── index.ts                 # Extension entry point
    ├── fetch-content.ts         # fetch_content tool definition
    ├── detect-repo-url.ts       # Git repo URL detection
    ├── parse-repo-url.ts        # Owner/repo extraction from URLs
    ├── ssrf.ts                  # SSRF validation (hostname + DNS)
    ├── html-to-markdown.ts      # HTML → Markdown conversion
    ├── summarize.ts             # Subagent summarization helper
    ├── subagent.ts              # Pi subprocess runner
    ├── tool-renderers.ts        # Shared TUI rendering
    ├── types/
    │   └── turndown-plugin-gfm.d.ts  # Type declarations for gfm plugin
    └── __tests__/
        ├── fetch-content.test.ts
        ├── detect-repo-url.test.ts
        ├── parse-repo-url.test.ts
        ├── ssrf.test.ts
        ├── html-to-markdown.test.ts
        ├── summarize.test.ts
        ├── subagent.test.ts
        └── tool-renderers.test.ts
```

---

**Related documentation:**
- [Security](./security.md) — SSRF threat model, input sanitization, and defense-in-depth measures
- [Configuration](./configuration.md) — Tool parameters, extension loading, and runtime options
- [Development](./development.md) — Testing, linting, and contribution guidelines
