/**
 * fetch_repo tool
 *
 * Clones a git repository to a local temp directory, optionally summarizes via pi subagent.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseRepoUrl } from "./parse-repo-url.js";
import { summarizeWithSubagent } from "./summarize.js";
import { renderToolCall, renderToolResult } from "./tool-renderers.js";

const GIT_CLONE_TIMEOUT_MS = 120_000; // 2 minutes for large repos

export function createFetchRepoTool(pi: ExtensionAPI) {
  return {
    name: "fetch_repo",
    label: "Fetch Repo",
    description: [
      "Clone a git repository to a local temp directory for exploration.",
      "Performs a shallow clone (--depth 1) of the default branch.",
      "Returns the local path to the cloned repository by default.",
      "Use 'summarize' to have a subagent explore and summarize the repo.",
    ].join(" "),
    promptSnippet: "Clone and explore git repositories",
    promptGuidelines: [
      "Use fetch-repo when you need to browse or analyze a git repository.",
      "The repo is cloned to /tmp/repository-{owner}/{repo-name}.",
      "Use the summarize parameter to get a high-level overview without consuming context.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "Git repository URL (HTTPS or SSH)",
      }),
      summarize: Type.Optional(
        Type.String({
          description:
            "Optional directed prompt for summarization. When provided, a subagent explores the cloned repo and returns a summary instead of the raw path.",
        }),
      ),
    }),

    async execute(
      _toolCallId: string, // Required by tool interface; not used internally
      params: { url: string; summarize?: string },
      signal: AbortSignal | undefined,
      onUpdate?: (update: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }) => void,
      _ctx?: { cwd: string } & Record<string, unknown>, // Not used internally; cwd is derived from targetPath
    ) {
      const { url, summarize } = params;

      // Validate URL scheme for git clone
      if (!(/^https?:\/\//i.test(url) || /^git@/i.test(url))) {
        throw new Error("Invalid repository URL: must use HTTPS or SSH (git@) scheme.");
      }

      // Sanitize URL against command injection
      const sanitizedUrl = sanitizeGitUrl(url);

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
        details: { status: "cloning", url, targetPath },
      });

      // Remove existing directory if present
      // TOCTOU mitigation: validate target path is not a symlink before proceeding.
      // Between fs.rm() and git clone, a symlink race could redirect the clone to
      // an arbitrary filesystem location. Reject symlinks outright.
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

      // Clone
      const result = await pi.exec(
        "git",
        ["clone", "--depth", "1", "--single-branch", "--", sanitizedUrl, targetPath],
        {
          signal,
          timeout: GIT_CLONE_TIMEOUT_MS,
        },
      );

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
          onUpdate,
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
          },
        };
      }

      // Return path
      return {
        content: [
          {
            type: "text",
            text: `Repository cloned to: ${targetPath}\n\nOwner: ${owner}\nRepo: ${repo}\nURL: ${url}`,
          },
        ],
        details: {
          url,
          owner,
          repo,
          targetPath,
          summarized: false,
        },
      };
    },

    renderCall(args: { url?: string; summarize?: string }, theme: Theme) {
      return new Text(renderToolCall("fetch_repo", { url: args.url, summarize: args.summarize }, theme), 0, 0);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
      { isPartial }: { isPartial?: boolean },
      theme: Theme,
    ) {
      const details = result.details;
      return new Text(
        renderToolResult(result, details ?? {}, { isPartial }, theme, {
          showOwnerRepo:
            details?.owner && details?.repo
              ? { owner: details.owner as string, repo: details.repo as string }
              : undefined,
          showSummarized: details?.summarized as boolean | undefined,
          showTargetPath: details?.targetPath as string | undefined,
        }),
        0,
        0,
      );
    },
  };
}

// --- Helper: Sanitize and validate git URL against command injection ---

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
