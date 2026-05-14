/**
 * fetch_content tool
 *
 * Unified content fetcher that auto-detects git repository URLs and routes
 * to git clone logic, or falls back to web fetch with HTML-to-markdown conversion.
 * Optionally summarizes via pi subagent.
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isRepoUrl, type RepoUrlResult } from "./detect-repo-url.js";
import { BINARY_TYPES, htmlToMarkdown } from "./html-to-markdown.js";
import { parseRepoUrl } from "./parse-repo-url.js";
import { validateRedirectForSsrf, validateUrlForSsrf } from "./ssrf.js";
import { summarizeWithSubagent } from "./summarize.js";
import { renderToolCall, renderToolResult } from "./tool-renderers.js";

// --- Module-level constants ---

/** Timeout for fetch requests (30 seconds) */
const FETCH_TIMEOUT_MS = 30_000;

/** Timeout for git clone operations (2 minutes for large repos) */
const GIT_CLONE_TIMEOUT_MS = 120_000;

/** Maximum allowed response size (10 MB) */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Maximum number of redirects to follow */
const MAX_REDIRECTS = 10;

/** User-Agent header for fetch requests */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Accept header for fetch requests */
const ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8";

/** Accept-Language header for fetch requests */
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

// --- Helper functions ---

/**
 * Reads a response body using streaming, aborting if the total size exceeds
 * the given limit. This prevents memory issues from oversized responses
 * regardless of Content-Length header presence or accuracy.
 */
async function readResponseWithSizeLimit(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    // Fallback: empty body or already consumed
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Response body exceeds maximum size of ${(maxBytes / 1024 / 1024).toFixed(0)} MB. Reading was aborted.`,
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate all chunks
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Decode to string
  return new TextDecoder().decode(combined);
}

/**
 * Sanitize and validate a git URL against command injection.
 * Strips embedded credentials and rejects dangerous patterns.
 */
function sanitizeGitUrl(url: string): string {
  // 1. Reject empty or excessively long URLs
  if (!url || url.length > 2048) {
    throw new Error("Invalid repository URL: empty or exceeds maximum length.");
  }

  // 2. Reject whitespace (spaces, tabs, newlines, etc.)
  if (/\s/.test(url)) {
    throw new Error("Invalid repository URL: must not contain whitespace.");
  }

  // 3. Reject git argument injection patterns
  //    ext:: is a git remote helper protocol specifier
  if (/ext::/i.test(url)) {
    throw new Error("Invalid repository URL: ext:: protocol is not allowed.");
  }

  // 4. Reject shell metacharacters that could be dangerous
  //    even in non-shell exec contexts (defense in depth)
  const shellMetaChars = /[;|`$(){}!\\'"]/.test(url);
  if (shellMetaChars) {
    throw new Error("Invalid repository URL: contains shell metacharacters.");
  }

  // 4b. Reject control characters (0x00-0x1f) beyond what \s catches
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code >= 0x00 && code <= 0x1f) {
      throw new Error("Invalid repository URL: contains control characters.");
    }
  }

  // 5. Strict character allowlist:
  //    alphanumeric, -, _, ., /, :, @, #, ?, =, &
  const allowedChars = /^[a-zA-Z0-9\-_./:@#?=&]+$/;
  if (!allowedChars.test(url)) {
    throw new Error("Invalid repository URL: contains disallowed characters.");
  }

  // 6. Strip embedded credentials from HTTPS URLs
  //    https://user:pass@github.com/org/repo → https://github.com/org/repo
  const httpsWithCreds = url.match(/^(https?:\/\/)([^/@]+@)(.+)$/);
  if (httpsWithCreds) {
    return httpsWithCreds[1] + httpsWithCreds[3];
  }

  return url;
}

/** Structured details returned by fetch_content tool */
interface FetchContentDetails {
  url?: string;
  title?: string;
  summarized?: boolean;
  summarizePrompt?: string;
  contentLength?: number;
  truncated?: boolean;
  fullOutputPath?: string;
  status?: string;
  /** Whether this was a web fetch or git repo clone */
  type: "web" | "repo";
  /** Repo owner (only for type=repo) */
  owner?: string;
  /** Repo name (only for type=repo) */
  repo?: string;
  /** Local path to cloned repo (only for type=repo) */
  targetPath?: string;
  /** Git branch that was cloned (only for type=repo) */
  branch?: string;
}

/** Execute the git clone flow for a detected repository URL. */
async function executeRepoFetch(
  pi: ExtensionAPI,
  params: { url: string; summarize?: string; branch?: string },
  repoResult: RepoUrlResult,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<FetchContentDetails> | undefined,
  _ctx: ExtensionContext,
) {
  const { url, summarize, branch } = params;

  // For SSH URLs, skip SSRF validation (can't fetch SSH URLs via HTTP)
  // For HTTPS URLs detected as repos, still do SSRF validation
  // "https" scheme covers both http:// and https:// URLs (detect-repo-url doesn't distinguish)
  if (repoResult.scheme === "https" && repoResult.sanitizedUrl) {
    await validateUrlForSsrf(repoResult.sanitizedUrl);
  }

  // Sanitize URL
  const sanitizedUrl = sanitizeGitUrl(repoResult.sanitizedUrl || url);

  // Parse owner/repo
  const repoInfo = parseRepoUrl(sanitizedUrl);
  if (!repoInfo) {
    throw new Error(`Could not parse repository URL: ${url}`);
  }

  const { owner, repo } = repoInfo;

  // Path traversal protection
  if (owner === ".." || repo === ".." || owner === "." || repo === ".") {
    throw new Error("Invalid repository owner or name in URL.");
  }

  const targetPath = path.join("/tmp", `repository-${owner}`, repo);
  // NOTE: Cloned repos persist at /tmp/repository-{owner}/{repo} and are never
  // automatically cleaned up. This is intentional — it allows the user or agent
  // to access the cloned repository after the tool call returns (e.g., via
  // subsequent read/grep/ls operations on the local path).

  // Streaming: cloning
  onUpdate?.({
    content: [{ type: "text", text: `Cloning ${owner}/${repo}...` }],
    details: { status: "cloning", url, targetPath, type: "repo" },
  });

  // Remove existing directory if present
  // TOCTOU mitigation: validate target path is not a symlink before proceeding.
  const lstat = await fs.lstat(targetPath).catch(() => null);
  if (lstat?.isSymbolicLink()) {
    throw new Error(`Refusing to clone: ${targetPath} is a symbolic link.`);
  }

  try {
    await fs.rm(targetPath, { recursive: true, force: true });
  } catch {
    // Directory may not exist or may be partially created; safe to ignore
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });

  // Clone with optional branch
  const cloneArgs = ["clone", "--depth", "1", "--single-branch"];
  if (branch) {
    cloneArgs.push("--branch", branch);
  }
  cloneArgs.push("--", sanitizedUrl, targetPath);

  // Clone
  const result = await pi.exec("git", cloneArgs, {
    signal,
    timeout: GIT_CLONE_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    // Clean up partial clone
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch {
      // Partial clone may be left in an inconsistent state; safe to ignore cleanup errors
    }
    throw new Error(`git clone failed: ${result.stderr.trim() || "unknown error"}`);
  }

  // Summarization
  if (summarize) {
    const subResult = await summarizeWithSubagent({
      content: [
        `Repository: ${owner}/${repo}`,
        `URL: ${url}`,
        `Local path: ${targetPath}`,
        "",
        `Explore the repository at ${targetPath} using your tools (read, find, grep, ls, bash).`,
      ].join("\n"),
      summarize,
      roleContext: "You are analyzing a cloned git repository.",
      url,
      cwd: targetPath,
      signal,
      onUpdate: onUpdate as
        | ((update: { content: Array<{ type: string; text: string }>; details: { status: string } }) => void)
        | undefined,
    });

    return {
      content: subResult.content,
      details: {
        url,
        owner,
        repo,
        targetPath,
        summarized: subResult.summarized,
        summarizePrompt: subResult.summarizePrompt,
        type: "repo" as const,
        branch,
      },
    };
  }

  // Return path
  return {
    content: [
      {
        type: "text",
        text: `Repository cloned to: ${targetPath}\n\nOwner: ${owner}\nRepo: ${repo}\nURL: ${url}${branch ? `\nBranch: ${branch}` : ""}`,
      },
    ],
    details: {
      url,
      owner,
      repo,
      targetPath,
      summarized: false,
      type: "repo" as const,
      branch,
    },
  };
}

export function createFetchContentTool(pi: ExtensionAPI) {
  return {
    name: "fetch_content",
    label: "Fetch Content",
    description: [
      "Fetch a URL and convert its content to markdown, or auto-detect and clone a git repository.",
      "For web URLs: strips navigation, ads, and sidebars from HTML pages using Mozilla Readability.",
      "For git repo URLs (HTTPS or SSH): performs a shallow clone (--depth 1) to a local temp directory.",
      "Returns full markdown by default. Use 'summarize' to get a condensed version.",
      "Supports HTML pages, JSON APIs, plain text URLs, and git repositories.",
      "Auto-detects whether the URL is a web page or git repo based on the host and path.",
      "Known git hosts: GitHub, GitLab, Bitbucket, Codeberg, Gitea, Gitee, SourceHut, Azure DevOps.",
      "Returns the local clone path by default for repos. Use 'summarize' to get an AI-generated overview.",
    ].join(" "),
    promptSnippet: "Fetch and read web content as markdown, or clone git repositories",
    promptGuidelines: [
      "Use fetch_content when you need to read a web page, documentation, or online article.",
      "Use fetch_content when you need to clone or explore a git repository.",
      "Use the summarize parameter to reduce context usage for long pages or large repos.",
      "Use the branch parameter to clone a specific git branch (only applies to repo URLs).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      summarize: Type.Optional(
        Type.String({
          description:
            "Optional directed prompt for summarization (e.g., 'find all references to bananas'). When provided, the content is summarized by a subagent instead of returned in full.",
        }),
      ),
      branch: Type.Optional(
        Type.String({
          description:
            "Git branch to clone (only applies when URL is detected as a git repository). Defaults to the repository's default branch.",
        }),
      ),
    }),

    async execute(
      _toolCallId: string, // Required by tool interface; not used internally
      params: { url: string; summarize?: string; branch?: string },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<FetchContentDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const { url, summarize } = params;

      // Validate URL scheme: accept http/https and git@ SSH URLs
      if (!(/^https?:\/\//i.test(url) || /^git@/i.test(url))) {
        throw new Error(`Invalid URL: must start with http:// or https://, or use SSH (git@) scheme. Got: ${url}`);
      }

      // --- Repo detection and routing ---
      const repoResult = isRepoUrl(url);
      if (repoResult.isRepo) {
        return executeRepoFetch(pi, params, repoResult, signal, onUpdate, ctx);
      }

      // --- Web fetch flow (existing logic) ---

      // SSRF protection: validate URL against internal/private addresses
      await validateUrlForSsrf(url);

      // Streaming: fetching
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: { status: "fetching", type: "web" },
      });

      // Fetch with manual redirect following (SSRF protection)
      let currentUrl = url;
      let response: Response | undefined;
      try {
        const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const signals = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

        for (let i = 0; i <= MAX_REDIRECTS; i++) {
          response = await fetch(currentUrl, {
            headers: {
              "User-Agent": USER_AGENT,
              Accept: ACCEPT_HEADER,
              "Accept-Language": ACCEPT_LANGUAGE,
            },
            redirect: "manual",
            signal: signals,
          });

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
              throw new Error(`Redirect with no Location header from ${currentUrl}`);
            }
            const redirectUrl = new URL(location, currentUrl);
            await validateRedirectForSsrf(new URL(currentUrl), redirectUrl);
            currentUrl = redirectUrl.href;
            continue;
          }
          break;
        }
      } catch (err: unknown) {
        // Re-throw SSRF blocks and abort errors as-is; wrap all other errors
        if (err instanceof Error) {
          if (err.message.startsWith("Blocked:")) throw err;
          if (err.name === "AbortError" || signal?.aborted) {
            throw new Error(`Fetch cancelled for ${url}`);
          }
          throw new Error(`Failed to fetch ${url}: ${err.message}`);
        }
        throw new Error(`Failed to fetch ${url}: ${String(err)}`);
      }

      // TypeScript narrowing: response is guaranteed defined after the try/catch
      // because the loop always assigns it at least once and throws on errors.
      if (!response) {
        throw new Error(`Fetch failed for ${url}: no response received`);
      }
      const resolvedResponse = response;

      if (!resolvedResponse.ok) {
        throw new Error(`HTTP ${resolvedResponse.status} ${resolvedResponse.statusText} for ${url}`);
      }

      const finalUrl = resolvedResponse.url;
      const contentType = resolvedResponse.headers.get("content-type") || "";

      // Read response body with size limit using streaming.
      // This is more robust than checking Content-Length (which can be spoofed
      // or absent with chunked transfer encoding).
      const rawText = await readResponseWithSizeLimit(resolvedResponse, MAX_RESPONSE_BYTES);

      // Reject binary content
      if (BINARY_TYPES.some((t) => contentType.includes(t))) {
        throw new Error(
          `Unsupported content type: ${contentType}. This tool handles text-based content (HTML, JSON, plain text).`,
        );
      }

      // Content type routing
      let markdown: string;
      let title: string | undefined;

      if (contentType.includes("application/json")) {
        title = "JSON Response";
        markdown = `# JSON Response from ${finalUrl}\n\n\`\`\`json\n${rawText}\n\`\`\``;
      } else if (contentType.includes("text/plain") || contentType.includes("text/csv")) {
        title = "Text Response";
        markdown = `# Content from ${finalUrl}\n\n\`\`\`\n${rawText}\n\`\`\``;
      } else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        onUpdate?.({
          content: [{ type: "text", text: "Converting HTML to markdown..." }],
          details: { status: "converting", type: "web" },
        });

        const result = htmlToMarkdown(rawText, finalUrl);
        title = result.title;
        markdown = result.markdown;
      } else {
        title = "Content";
        markdown = `# Content from ${finalUrl}\n\n${rawText}`;
      }

      // Summarization
      if (summarize) {
        const subResult = await summarizeWithSubagent({
          content: markdown,
          summarize,
          roleContext: "You are summarizing content from a web page.",
          url: finalUrl,
          title,
          cwd: ctx.cwd,
          signal,
          onUpdate: onUpdate as
            | ((update: { content: Array<{ type: string; text: string }>; details: { status: string } }) => void)
            | undefined,
        });

        return {
          content: subResult.content,
          details: {
            url: finalUrl,
            title,
            summarized: true,
            summarizePrompt: subResult.summarizePrompt,
            contentLength: markdown.length,
            type: "web" as const,
          },
        };
      }

      // Truncation
      const truncation = truncateHead(markdown, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let resultText = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        // NOTE: Temp file is intentionally NOT cleaned up here. The file path
        // is returned in `fullOutputPath` so the agent/user can access the full
        // output later. Cleanup is deferred to the OS (tmpdir) or a separate
        // maintenance process.
        const tempDir = await fs.mkdtemp(path.join(tmpdir(), "pi-fetch-"));
        fullOutputPath = path.join(tempDir, "content.md");
        await fs.writeFile(fullOutputPath, markdown, "utf8");
        resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
      }

      // Return full markdown
      const header = title ? `# ${title}\n\n**Source:** ${finalUrl}\n\n` : `**Source:** ${finalUrl}\n\n`;

      return {
        content: [{ type: "text", text: header + resultText }],
        details: {
          url: finalUrl,
          title,
          summarized: false,
          contentLength: markdown.length,
          truncated: truncation.truncated,
          fullOutputPath,
          type: "web" as const,
        },
      };
    },

    renderCall(args: { url?: string; summarize?: string; branch?: string }, theme: Theme) {
      const text = renderToolCall("fetch_content", { url: args.url, summarize: args.summarize }, theme);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: FetchContentDetails; isError?: boolean },
      { isPartial }: { isPartial?: boolean },
      theme: Theme,
    ) {
      const details = result.details;

      // Repo result
      if (details?.type === "repo") {
        const text = renderToolResult(result, details as unknown as Record<string, unknown>, { isPartial }, theme, {
          showOwnerRepo: details.owner && details.repo ? { owner: details.owner, repo: details.repo } : undefined,
          showSummarized: details.summarized,
          showTargetPath: details.targetPath,
        });
        return new Text(text, 0, 0);
      }

      // Web result (default)
      const text = renderToolResult(result, details as unknown as Record<string, unknown>, { isPartial }, theme, {
        showUrl: details?.url,
        showTruncated: details?.truncated,
        showSummarized: details?.summarized,
        showContentLength: details?.contentLength,
      });
      return new Text(text, 0, 0);
    },
  };
}
