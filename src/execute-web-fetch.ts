import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { BINARY_TYPES, htmlToMarkdown } from "./html-to-markdown.js";
import {
  ACCEPT_HEADER,
  ACCEPT_LANGUAGE,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  USER_AGENT,
} from "./fetch-constants.js";
import type { FetchContentDetails } from "./execute-repo-fetch.js";
import { validateRedirectForSsrf, validateUrlForSsrf } from "./ssrf.js";
import { summarizeWithSubagent } from "./summarize.js";

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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- infinite loop with explicit break
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

/** Execute the web fetch flow for a non-repository URL. */
// eslint-disable-next-line max-lines-per-function, complexity
export async function executeWebFetch(
  params: { url: string; summarize?: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<FetchContentDetails> | undefined,
  ctx: ExtensionContext,
) {
  const { url, summarize } = params;

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
        // Cancel the redirect body to free the connection
        await response.body?.cancel().catch(() => {});
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

  // Reject binary content BEFORE reading the body
  if (BINARY_TYPES.some((t) => contentType.includes(t))) {
    throw new Error(
      `Unsupported content type: ${contentType}. This tool handles text-based content (HTML, JSON, plain text).`,
    );
  }

  // Read response body with size limit using streaming.
  // This is more robust than checking Content-Length (which can be spoofed
  // or absent with chunked transfer encoding).
  const rawText = await readResponseWithSizeLimit(resolvedResponse, MAX_RESPONSE_BYTES);

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

    const result = await htmlToMarkdown(rawText, finalUrl);
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
        | ((update: {
            content: Array<{ type: string; text: string }>;
            details: { status: string };
          }) => void)
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
  const header = title
    ? `# ${title}\n\n**Source:** ${finalUrl}\n\n`
    : `**Source:** ${finalUrl}\n\n`;

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
}
