/**
 * fetch_content tool
 *
 * Fetches a URL, converts HTML to markdown, optionally summarizes via pi subagent.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BINARY_TYPES, htmlToMarkdown } from "./html-to-markdown.js";
import { validateRedirectForSsrf, validateUrlForSsrf } from "./ssrf.js";
import { summarizeWithSubagent } from "./summarize.js";
import { renderToolCall, renderToolResult } from "./tool-renderers.js";

// --- Module-level constants ---

/** Timeout for fetch requests (30 seconds) */
const FETCH_TIMEOUT_MS = 30_000;

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
}

export function createFetchContentTool(_pi: ExtensionAPI) {
  return {
    name: "fetch_content",
    label: "Fetch Content",
    description: [
      "Fetch a URL and convert its content to markdown.",
      "Strips navigation, ads, and sidebars from HTML pages using Mozilla Readability.",
      "Returns full markdown by default. Use 'summarize' to get a condensed version.",
      "Supports HTML pages, JSON APIs, and plain text URLs.",
    ].join(" "),
    promptSnippet: "Fetch and read web content as markdown",
    promptGuidelines: [
      "Use fetch_content when you need to read a web page, documentation, or online article.",
      "Use the summarize parameter to reduce context usage for long pages.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      summarize: Type.Optional(
        Type.String({
          description:
            "Optional directed prompt for summarization (e.g., 'find all references to bananas'). When provided, the content is summarized by a subagent instead of returned in full.",
        }),
      ),
    }),

    async execute(
      _toolCallId: string, // Required by tool interface; not used internally
      params: { url: string; summarize?: string },
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<FetchContentDetails> | undefined,
      ctx: ExtensionContext,
    ) {
      const { url, summarize } = params;

      // Validate URL
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`Invalid URL: must start with http:// or https://. Got: ${url}`);
      }

      // SSRF protection: validate URL against internal/private addresses
      await validateUrlForSsrf(url);

      // Streaming: fetching
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: { status: "fetching" },
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
          details: { status: "converting" },
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
          // Cast to match summarizeWithSubagent's expected callback type
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
        const tempDir = await mkdtemp(join(tmpdir(), "pi-fetch-"));
        fullOutputPath = join(tempDir, "content.md");
        await writeFile(fullOutputPath, markdown, "utf8");
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
        },
      };
    },

    renderCall(args: { url?: string; summarize?: string }, theme: Theme) {
      const text = renderToolCall("fetch_content", { url: args.url, summarize: args.summarize }, theme);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: FetchContentDetails; isError?: boolean },
      { isPartial }: { isPartial?: boolean },
      theme: Theme,
    ) {
      const details = result.details;
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
