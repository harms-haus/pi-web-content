/**
 * fetch-content tool
 *
 * Fetches a URL, converts HTML to markdown, optionally summarizes via pi subagent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSubagent } from "./subagent.js";

const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
];

const BLOCKED_HOSTNAME_PREFIXES = [
  "10.",
  "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.",
  "192.168.",
  "169.254.",
];

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(lower)) return true;
  if (BLOCKED_HOSTNAME_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return false;
}

const BINARY_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "application/zip",
  "application/octet-stream",
  "application/x-gzip",
  "application/x-tar",
];

export function createFetchContentTool(pi: ExtensionAPI) {
  return {
    name: "fetch-content",
    label: "Fetch Content",
    description: [
      "Fetch a URL and convert its content to markdown.",
      "Strips navigation, ads, and sidebars from HTML pages using Mozilla Readability.",
      "Returns full markdown by default. Use 'summarize' to get a condensed version.",
      "Supports HTML pages, JSON APIs, and plain text URLs.",
    ].join(" "),
    promptSnippet: "Fetch and read web content as markdown",
    promptGuidelines: [
      "Use fetch-content when you need to read a web page, documentation, or online article.",
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
      _toolCallId: string,
      params: { url: string; summarize?: string },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) {
      const { url, summarize } = params;

      // Validate URL
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(
          `Invalid URL: must start with http:// or https://. Got: ${url}`,
        );
      }

      // SSRF protection: block internal/private addresses
      try {
        const parsed = new URL(url);
        if (isBlockedHostname(parsed.hostname)) {
          throw new Error(
            `Blocked: cannot fetch internal/private addresses (${parsed.hostname}).`,
          );
        }
      } catch (err) {
        if ((err as Error).message?.startsWith("Blocked:")) throw err;
        throw new Error(`Invalid URL: ${url}`);
      }

      // Streaming: fetching
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: { status: "fetching" },
      });

      // Fetch
      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(30_000);
        const signals = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;

        response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
          signal: signals,
        });
      } catch (err: any) {
        if (err.name === "AbortError" || signal?.aborted) {
          throw new Error(`Fetch cancelled for ${url}`);
        }
        throw new Error(`Failed to fetch ${url}: ${err.message}`);
      }

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText} for ${url}`,
        );
      }

      const finalUrl = response.url;
      const contentType = response.headers.get("content-type") || "";

      // Reject very large responses to avoid memory issues
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
        throw new Error(
          `Response too large (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
        );
      }

      const rawText = await response.text();

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
      } else if (
        contentType.includes("text/plain") ||
        contentType.includes("text/csv")
      ) {
        title = "Text Response";
        markdown = `# Content from ${finalUrl}\n\n\`\`\`\n${rawText}\n\`\`\``;
      } else if (
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml")
      ) {
        onUpdate?.({
          content: [
            { type: "text", text: "Converting HTML to markdown..." },
          ],
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
        onUpdate?.({
          content: [{ type: "text", text: "Summarizing content..." }],
          details: { status: "summarizing" },
        });

        const delimiter = `---CONTENT_BOUNDARY_${Date.now()}_${Math.random().toString(36).slice(2)}---`;
        const taskPrompt = [
          "You are summarizing content from a web page.",
          `URL: ${finalUrl}`,
          title ? `Title: ${title}` : "",
          "",
          delimiter,
          markdown,
          delimiter,
          "",
          `User's instruction: ${summarize}`,
          "",
          "Provide a focused response based on the user's instruction above.",
        ]
          .filter(Boolean)
          .join("\n");

        const subResult = await runSubagent(taskPrompt, ctx.cwd, signal);

        if (subResult.error) {
          throw new Error(`Summarization failed: ${subResult.error}`);
        }

        return {
          content: [
            {
              type: "text",
              text:
                subResult.text || "(no summary produced)",
            },
          ],
          details: {
            url: finalUrl,
            title,
            summarized: true,
            summarizePrompt: summarize,
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
        const tempDir = await mkdtemp(join(tmpdir(), "pi-fetch-"));
        fullOutputPath = join(tempDir, "content.md");
        await writeFile(fullOutputPath, markdown, "utf8");
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
        },
      };
    },

    renderCall(args: any, theme: any) {
      const url: string = args.url || "...";
      const shortUrl =
        url.length > 60 ? `${url.slice(0, 57)}...` : url;
      let text = theme.fg("toolTitle", theme.bold("fetch-content "));
      text += theme.fg("accent", shortUrl);
      if (args.summarize) {
        const preview =
          args.summarize.length > 40
            ? `${args.summarize.slice(0, 37)}...`
            : args.summarize;
        text += theme.fg("dim", ` — ${preview}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { isPartial }: any, theme: any) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Processing..."), 0, 0);
      }
      const details = result.details as any;
      const icon = result.isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
      let text = icon;

      if (details?.url) {
        text += " " + theme.fg("accent", details.url);
      }
      if (details?.title) {
        text += " " + theme.fg("dim", `— ${details.title}`);
      }
      if (details?.summarized) {
        text += " " + theme.fg("muted", "(summarized)");
      }
      if (details?.truncated) {
        text += " " + theme.fg("warning", "(truncated)");
      }
      if (details?.contentLength) {
        text +=
          " " + theme.fg("dim", `(${formatSize(details.contentLength)})`);
      }
      return new Text(text, 0, 0);
    },
  };
}

// --- Helper: HTML to Markdown ---

interface HtmlToMarkdownResult {
  title: string;
  markdown: string;
}

function htmlToMarkdown(html: string, url: string): HtmlToMarkdownResult {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
  });

  // Enable GFM tables, strikethrough, task lists
  turndownService.use(gfm);

  // Remove noise elements
  turndownService.remove(["script", "style", "iframe", "noscript"]);

  let title: string;
  let contentHtml: string;

  if (article) {
    title = article.title || url;
    contentHtml = article.content;
  } else {
    // Readability failed — probably not an article page.
    // Fall back to converting the full body.
    title = dom.window.document.title || url;
    const body = dom.window.document.body;
    contentHtml = body ? body.innerHTML : html;
  }

  const markdown = turndownService.turndown(contentHtml);

  // Clean up jsdom window to free memory
  dom.window.close();

  return { title, markdown };
}
