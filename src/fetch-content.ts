/**
 * fetch_content tool
 *
 * Unified content fetcher that auto-detects git repository URLs and routes
 * to git clone logic, or falls back to web fetch with HTML-to-markdown conversion.
 * Optionally summarizes via pi subagent.
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isRepoUrl } from "./detect-repo-url.js";
import { executeRepoFetch } from "./execute-repo-fetch.js";
import type { FetchContentDetails } from "./types.js";
import { executeWebFetch } from "./execute-web-fetch.js";
import { renderToolCall, renderToolResult } from "./tool-renderers.js";

// eslint-disable-next-line max-lines-per-function -- tool definition orchestrator: metadata + thin execute routing + renderers
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
      const { url } = params;

      // Validate URL scheme: accept http/https and git@ SSH URLs
      if (!(/^https?:\/\//i.test(url) || /^git@/i.test(url))) {
        throw new Error(
          `Invalid URL: must start with http:// or https://, or use SSH (git@) scheme. Got: ${url}`,
        );
      }

      // --- Repo detection and routing ---
      const repoResult = isRepoUrl(url);
      if (repoResult.isRepo) {
        return executeRepoFetch(pi, params, repoResult, signal, onUpdate, ctx);
      }

      // --- Web fetch ---
      return executeWebFetch(params, signal, onUpdate, ctx);
    },

    renderCall(args: { url?: string; summarize?: string; branch?: string }, theme: Theme) {
      const text = renderToolCall(
        "fetch_content",
        { url: args.url, summarize: args.summarize },
        theme,
      );
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details?: FetchContentDetails;
        isError?: boolean;
      },
      { isPartial }: { isPartial?: boolean },
      theme: Theme,
    ) {
      const details = result.details;
      // Repo result
      if (details?.type === "repo") {
        const text = renderToolResult(result, details, { isPartial }, theme, {
          showOwnerRepo:
            details.owner && details.repo
              ? { owner: details.owner, repo: details.repo }
              : undefined,
          showSummarized: details.summarized,
          showTargetPath: details.targetPath,
        });
        return new Text(text, 0, 0);
      }
      // Web result (default)
      const text = renderToolResult(result, details, { isPartial }, theme, {
        showUrl: details?.url,
        showTruncated: details?.truncated,
        showSummarized: details?.summarized,
        showContentLength: details?.contentLength,
      });
      return new Text(text, 0, 0);
    },
  };
}
