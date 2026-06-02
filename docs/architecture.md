# Architecture

## Overview

pi-web-content is a [pi](https://github.com/earendil-works/pi) extension that registers a single tool — `fetch_content` — to retrieve and process remote content. The tool auto-detects whether a given URL points to a web page or a git repository, routing to the appropriate fetch path: web URLs are fetched over HTTP, HTML is cleaned via Mozilla Readability and converted to Markdown, while git repo URLs trigger a shallow clone to a local temp directory. Both paths optionally delegate to a pi subagent for summarization. There is no build step — the extension is loaded directly from `src/index.ts` via the `"pi.extensions"` field in `package.json`, with TypeScript compiled on the fly by the pi runtime.

## Module Map

| Module | File | Responsibility | Key Exports | Internal Dependencies |
|--------|------|----------------|-------------|----------------------|
| **Entry point** | `src/index.ts` | Extension registration with pi host | `default` (extension factory) | `fetch-content.ts` |
| **fetch_content tool** | `src/fetch-content.ts` | Thin orchestrator: tool definition, URL scheme validation, repo detection, routing to `execute-repo-fetch` or `execute-web-fetch`, TUI renderers | `createFetchContentTool(pi)` | `detect-repo-url.ts`, `execute-repo-fetch.ts`, `execute-web-fetch.ts`, `tool-renderers.ts` |
| **Web fetch executor** | `src/execute-web-fetch.ts` | Full web fetch pipeline: SSRF validation, HTTP fetch with manual redirects, binary rejection, body read with size limit, content-type routing, HTML→Markdown conversion, summarization, truncation | `executeWebFetch(params, signal, onUpdate, ctx)` | `fetch-constants.ts`, `ssrf.ts`, `html-to-markdown.ts`, `summarize.ts`, `types.ts` |
| **Repo fetch executor** | `src/execute-repo-fetch.ts` | Git clone pipeline: SSRF validation (HTTPS + SSH), URL sanitization, owner/repo parsing, branch validation, git clone with timeout, summarization | `executeRepoFetch(pi, params, repoResult, signal, onUpdate, ctx)` | `fetch-constants.ts`, `sanitize-git-url.ts`, `ssrf.ts`, `parse-repo-url.ts`, `summarize.ts`, `types.ts` |
| **Fetch constants** | `src/fetch-constants.ts` | All timeout, size limit, HTTP header constants, and binary type detection list | `FETCH_TIMEOUT_MS`, `GIT_CLONE_TIMEOUT_MS`, `MAX_RESPONSE_BYTES`, `MAX_REDIRECTS`, `USER_AGENT`, `ACCEPT_HEADER`, `ACCEPT_LANGUAGE`, `BINARY_TYPES` | — |
| **Git URL sanitizer** | `src/sanitize-git-url.ts` | Git URL sanitization against command injection: length, whitespace, protocol injection, shell metacharacters, character allowlist, credential stripping | `sanitizeGitUrl(url)` | — |
| **URL detector** | `src/detect-repo-url.ts` | Classifies a URL as git repo vs. web page via hostname/path heuristics | `isRepoUrl(url)`, `RepoUrlResult`, `stripCredentials(url)` (also imported by `sanitize-git-url.ts`) | — |
| **URL parser** | `src/parse-repo-url.ts` | Extracts `owner`/`repo` from SSH, HTTPS, and generic git URLs | `parseRepoUrl(url)`, `RepoInfo` | — |
| **SSRF guard** | `src/ssrf.ts` | Validates URLs against SSRF: static hostname blocklist, DNS resolution, IP range checks, redirect validation | `validateUrlForSsrf(url)`, `validateRedirectForSsrf(from, to)`, `isBlockedHostname(hostname)`, `isBlockedByDns(hostname)` | — |
| **HTML→Markdown** | `src/html-to-markdown.ts` | Strips boilerplate via Readability (lazy-loaded), converts HTML to Markdown via Turndown + GFM | `htmlToMarkdown(html, url)` _(async)_, `HtmlToMarkdownResult` | — |
| **Summarizer** | `src/summarize.ts` | Constructs subagent prompt with UUID-bounded content delimiter, delegates to subagent | `summarizeWithSubagent(options)` | `subagent.ts`, `types.ts` |
| **Shared types** | `src/types.ts` | Shared type definitions for tool result details and streaming updates | `FetchContentDetails`, `SummarizeUpdate` | — |
| **Subagent runner** | `src/subagent.ts` | Spawns pi as a subprocess in `--mode json`, parses NDJSON stdout, handles abort (SIGTERM→SIGKILL) | `runSubagent(task, cwd, signal)`, `SubagentResult` | — |
| **TUI renderers** | `src/tool-renderers.ts` | Shared call/result text rendering for the pi TUI | `renderToolCall(toolName, args, theme)`, `renderToolResult(result, details, {isPartial}, theme, options?)` | `types.ts` |

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

Executed in `execute-web-fetch.ts`. Triggered when `isRepoUrl(url)` returns `isRepo: false`.

1. **Tool invocation** — `index.ts` registers the tool via `createFetchContentTool(pi)`. The pi host calls `execute(toolCallId, params, signal, onUpdate, ctx)`. After scheme validation and repo detection in `fetch-content.ts`, control is delegated to `executeWebFetch()`.

2. **SSRF validation** — `validateUrlForSsrf(url)` ([ssrf.ts](../src/ssrf.ts)) checks scheme, static hostname blocklist, and DNS-resolved IPs. DNS resolution uses `Promise.allSettled` to query IPv4 and IPv6 in parallel; if *both* fail the request is blocked (fail-closed). Throws `Blocked: …` on failure. See [docs/security.md](./security.md) for the full threat model.

3. **Streaming: fetching** — An `onUpdate` callback fires `{ status: "fetching" }`.

4. **HTTP fetch with manual redirects** — A loop (max 10 redirects) issues `fetch()` with `redirect: "manual"`. Each redirect's `Location` header is validated via `validateRedirectForSsrf()` to prevent SSRF-to-internal on redirect. A 30-second `AbortSignal.timeout` is combined with the caller's signal via `AbortSignal.any()`. Redirect response bodies are explicitly cancelled via `response.body?.cancel()` to free the connection before following the next redirect.

5. **Response validation** — Non-OK status throws `HTTP {status} {statusText}`.

6. **Binary rejection (before body read)** — The `Content-Type` header is checked against `BINARY_TYPES` **before** the response body is read. If a binary type is detected, an error is thrown immediately — no binary payload is ever buffered into memory. This avoids wasting bandwidth and memory on unsupported content.

7. **Body read with streaming size limit** — The body is read via `readResponseWithSizeLimit()` — a streaming reader that aborts if the total exceeds `MAX_RESPONSE_BYTES` (10 MB), regardless of `Content-Length`.

8. **Content-type routing**:

   | Content-Type | Handling |
   |---|---|
   | `application/json` | Wrapped in `# JSON Response` heading + fenced `json` code block. Title: `"JSON Response"`. |
   | `text/plain`, `text/csv` | Wrapped in `# Content from {url}` heading + fenced code block. Title: `"Text Response"`. |
   | `text/html`, `application/xhtml+xml` | Passed to `htmlToMarkdown()` ([html-to-markdown.ts](../src/html-to-markdown.ts)). Streaming update: `"converting"`. |
   | Other | Returned as-is with `# Content from {url}` heading. |

9. **HTML→Markdown conversion** (HTML path only) — `htmlToMarkdown()` is `async` — it dynamically imports `jsdom` and `@mozilla/readability` on each call (lazy-loaded to avoid paying the cost when only fetching non-HTML content). It creates a `JSDOM` instance, runs Mozilla Readability to extract the article body, falls back to `<body>` if Readability fails, then converts to Markdown via a singleton TurndownService with GFM plugin. The JSDOM window is closed afterward.

10. **Optional summarization** — If `params.summarize` is set, the markdown is passed to `summarizeWithSubagent()`. See [Data Flow — Summarization](#data-flow--summarization).

11. **Truncation** — If not summarized, the markdown is truncated via `truncateHead()` from `pi-coding-agent` using `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`. If truncated, the full content is written to a temp file (`os.tmpdir()/pi-fetch-{random}/content.md`) and the path is returned in `details.fullOutputPath`.

12. **Return** — The result includes the (possibly truncated) markdown with a header of `# {title}` and `**Source:** {finalUrl}`.

### FetchContentDetails Interface

Defined in `src/types.ts`. The `details` object attached to every tool result:

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

Executed in `execute-repo-fetch.ts`. Triggered when `isRepoUrl(url)` returns `isRepo: true`.

1. **SSRF validation** — Both HTTPS and SSH URLs are validated:
   - **HTTPS** (`repoResult.scheme === "https"` and `sanitizedUrl` exists): `validateUrlForSsrf()` is called for full URL validation.
   - **SSH** (`repoResult.scheme === "ssh"`): The hostname is extracted from the `git@hostname:owner/repo` pattern and checked against the hostname blocklist (`isBlockedHostname`) and DNS resolution blocklist (`isBlockedByDns`). SSH URLs are not validated via `validateUrlForSsrf()` because they cannot be fetched via HTTP.

2. **URL sanitization** — `sanitizeGitUrl()` ([sanitize-git-url.ts](../src/sanitize-git-url.ts)) applies defense-in-depth checks:
   - Rejects empty or >2048 char URLs
   - Rejects whitespace
   - Rejects `ext::` protocol injection
   - Rejects shell metacharacters (`;|`$(){}!\'"` )
   - Rejects control characters (0x00–0x1f)
   - Strict allowlist: `[a-zA-Z0-9\-_./:@#?=&]+`
   - Strips embedded credentials from HTTPS URLs

3. **Owner/repo extraction** — `parseRepoUrl(sanitizedUrl)` applies regex patterns for SSH (`git@host:owner/repo`), HTTPS (`https://host/owner/repo`), and generic fallback. Both `owner` and `repo` are validated against `^~?[a-zA-Z0-9._-]+$`. Returns `null` on failure.

4. **Path traversal check** — Explicitly rejects `owner` or `repo` values of `".."` or `"."`.

5. **Branch validation** — If `params.branch` is provided, it is validated against git naming rules before being passed to `git clone`:
   - Max 256 characters
   - Only alphanumeric, `/`, `.`, `_`, `-`
   - No `..`, `~`, `^`, or `:` characters
   - Cannot end with `.lock`, `/`, or `.`
   
   Invalid branch names throw an error with a descriptive message.

6. **Target path construction** — `os.tmpdir()/repository-{owner}/{repo}`. Cloned repos persist intentionally for subsequent agent access.

7. **Symlink check** — `fs.lstat(targetPath)` verifies the target is not a symbolic link before proceeding (TOCTOU mitigation).

8. **Directory preparation** — Existing directory is removed via `fs.rm({ recursive: true, force: true })`. Parent directory is created.

9. **Git clone** — Executes `git clone --depth 1 --single-branch [--branch {branch}] -- {sanitizedUrl} {targetPath}` with a 120-second timeout (`GIT_CLONE_TIMEOUT_MS`). If the clone fails, the partial directory is cleaned up and a sanitized error is thrown — stderr from git is **not** included in the error message to avoid leaking repository metadata or internal paths.

10. **Optional summarization** — If `params.summarize` is set, `summarizeWithSubagent()` is called with `cwd: targetPath` so the subagent can explore the repo filesystem. See [Data Flow — Summarization](#data-flow--summarization).

11. **Return** — Without summarization, returns the clone path, owner, repo, and URL as structured text. With summarization, returns the subagent's analysis.

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
   
   The subprocess is spawned with `--mode json -p --no-session`, `stdio: ["ignore", "pipe", "pipe"]`, and `shell: invocation.useShell` (true on Windows so that `cmd.exe` is used and array arguments are automatically shell-escaped by Node.js).

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
└── fetch-content.ts              (thin orchestrator + TUI renderers)
    ├── detect-repo-url.ts        (URL → repo vs web classification)
    ├── execute-repo-fetch.ts     (git clone pipeline)
    │   ├── fetch-constants.ts    (GIT_CLONE_TIMEOUT_MS)
    │   ├── sanitize-git-url.ts   (URL sanitization)
    │   ├── parse-repo-url.ts     (URL → { owner, repo })
    │   ├── ssrf.ts               (hostname blocklist + DNS checks)
    │   ├── summarize.ts          (subagent delegation)
    │   │   └── subagent.ts       (subprocess spawn + NDJSON parsing)
    │   └── types.ts              (FetchContentDetails, SummarizeUpdate)
    ├── execute-web-fetch.ts      (web fetch pipeline)
    │   ├── fetch-constants.ts    (timeouts, size limits, headers, BINARY_TYPES)
    │   ├── ssrf.ts               (URL + redirect SSRF validation)
    │   ├── html-to-markdown.ts   (HTML → Markdown, dynamic imports for JSDOM/Readability)
    │   │   └── turndown-plugin-gfm (GFM markdown extensions)
    │   ├── summarize.ts          (subagent delegation)
    │   │   └── subagent.ts       (subprocess spawn + NDJSON parsing)
    │   └── types.ts              (FetchContentDetails, SummarizeUpdate)
    ├── tool-renderers.ts         (TUI call/result text rendering)
    │   └── types.ts              (FetchContentDetails)
    └── types.ts                  (FetchContentDetails, SummarizeUpdate)
```

**External runtime imports** (not shown above):

```
execute-web-fetch.ts
└── @earendil-works/pi-coding-agent
    └── (DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead)

execute-repo-fetch.ts
└── @earendil-works/pi-coding-agent
    └── (AgentToolUpdateCallback, ExtensionAPI, ExtensionContext types)

html-to-markdown.ts               (static imports)
├── turndown                       (TurndownService)
└── turndown-plugin-gfm            (gfm plugin)

html-to-markdown.ts               (dynamic imports — lazy-loaded per call)
├── @mozilla/readability           (Readability)
└── jsdom                          (JSDOM)

fetch-content.ts
├── @earendil-works/pi-coding-agent
│   └── (AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, Theme)
├── @earendil-works/pi-tui
│   └── (Text)
├── typebox
│   └── (Type)
└── types.ts
    └── (FetchContentDetails)
```

## External Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@mozilla/readability` | `^0.6.0` | Extracts article content from HTML, stripping navigation/ads/sidebars (dynamically imported) |
| `jsdom` | `^26.0.0` | DOM parsing environment for Readability (dynamically imported) |
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
├── eslint.config.js
├── .prettierrc
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
    ├── fetch-content.ts         # fetch_content tool: definition + routing orchestrator
    ├── execute-web-fetch.ts     # Web fetch pipeline (SSRF, HTTP, binary rejection, HTML→MD, truncation)
    ├── execute-repo-fetch.ts    # Git clone pipeline (SSRF, URL sanitization, branch validation, clone)
    ├── fetch-constants.ts       # Timeout, size limit, and HTTP header constants
    ├── sanitize-git-url.ts      # Git URL sanitization against command injection
    ├── detect-repo-url.ts       # Git repo URL detection
    ├── parse-repo-url.ts        # Owner/repo extraction from URLs
    ├── ssrf.ts                  # SSRF validation (hostname + DNS)
    ├── html-to-markdown.ts      # HTML → Markdown conversion (async, JSDOM/Readability lazy-loaded)
    ├── summarize.ts             # Subagent summarization helper
    ├── subagent.ts              # Pi subprocess runner
    ├── tool-renderers.ts        # Shared TUI rendering
    ├── types.ts                  # Shared types: FetchContentDetails, SummarizeUpdate
    ├── types/
    │   └── turndown-plugin-gfm.d.ts  # Type declarations for gfm plugin
    └── __tests__/
        ├── detect-repo-url.test.ts
        ├── execute-repo-fetch.test.ts
        ├── execute-web-fetch.test.ts
        ├── fetch-constants.test.ts
        ├── fetch-content.repo.test.ts
        ├── fetch-content.web.test.ts
        ├── html-to-markdown.edge-cases.test.ts
        ├── html-to-markdown.test.ts
        ├── index.test.ts
        ├── parse-repo-url.test.ts
        ├── sanitize-git-url.test.ts
        ├── ssrf.test.ts
        ├── subagent.test.ts
        ├── summarize.test.ts
        └── tool-renderers.test.ts
```

---

**Related documentation:**
- [Security](./security.md) — SSRF threat model, input sanitization, and defense-in-depth measures
- [Configuration](./configuration.md) — Tool parameters, extension loading, and runtime options
- [Development](./development.md) — Testing, linting, and contribution guidelines
