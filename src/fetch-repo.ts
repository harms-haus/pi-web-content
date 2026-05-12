/**
 * fetch-repo tool
 *
 * Clones a git repository to a local temp directory, optionally summarizes via pi subagent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { runSubagent } from "./subagent.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function createFetchRepoTool(pi: ExtensionAPI) {
  return {
    name: "fetch-repo",
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
      _toolCallId: string,
      params: { url: string; summarize?: string },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) {
      const { url, summarize } = params;

      // Validate URL scheme for git clone
      if (!/^https?:\/\//i.test(url) && !/^git@/i.test(url)) {
        throw new Error(
          "Invalid repository URL: must use HTTPS or SSH (git@) scheme.",
        );
      }
      const repoInfo = parseRepoUrl(url);
      if (!repoInfo) {
        throw new Error(`Could not parse repository URL: ${url}`);
      }

      const { owner, repo } = repoInfo;

      // Path traversal protection
      if (owner === ".." || repo === ".." || owner === "." || repo === ".") {
        throw new Error("Invalid repository owner or name in URL.");
      }

      const targetPath = path.join(
        "/tmp",
        `repository-${owner}`,
        repo,
      );

      // Streaming: cloning
      onUpdate?.({
        content: [
          { type: "text", text: `Cloning ${owner}/${repo}...` },
        ],
        details: { status: "cloning", url, targetPath },
      });

      // Remove existing directory if present
      try {
        await fs.rm(targetPath, { recursive: true, force: true });
      } catch {
        // Ignore errors — directory may not exist
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(targetPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Clone
      const result = await pi.exec(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          url,
          targetPath,
        ],
        {
          signal,
          timeout: 120_000, // 2 minutes for large repos
        },
      );

      if (result.code !== 0) {
        // Clean up partial clone
        try {
          await fs.rm(targetPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        throw new Error(
          `git clone failed: ${result.stderr.trim() || "unknown error"}`,
        );
      }

      // Summarization
      if (summarize) {
        onUpdate?.({
          content: [
            { type: "text", text: "Analyzing repository..." },
          ],
          details: { status: "summarizing", targetPath },
        });

        const taskPrompt = [
          "You are analyzing a cloned git repository.",
          `Repository: ${owner}/${repo}`,
          `URL: ${url}`,
          `Local path: ${targetPath}`,
          "",
          `Explore the repository at ${targetPath} using your tools (read, find, grep, ls, bash).`,
          "",
          `User's instruction: ${summarize}`,
          "",
          "Provide a focused response based on the user's instruction above.",
        ].join("\n");

        const subResult = await runSubagent(
          taskPrompt,
          targetPath,
          signal,
        );

        if (subResult.error) {
          throw new Error(
            `Repository summarization failed: ${subResult.error}`,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: subResult.text || "(no summary produced)",
            },
          ],
          details: {
            url,
            owner,
            repo,
            targetPath,
            summarized: true,
            summarizePrompt: summarize,
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

    renderCall(args: any, theme: any) {
      const url: string = args.url || "...";
      const shortUrl =
        url.length > 60 ? `${url.slice(0, 57)}...` : url;
      let text = theme.fg("toolTitle", theme.bold("fetch-repo "));
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

      if (details?.owner && details?.repo) {
        text +=
          " " +
          theme.fg("accent", `${details.owner}/${details.repo}`);
      }
      if (details?.summarized) {
        text += " " + theme.fg("muted", "(summarized)");
      }
      if (details?.targetPath) {
        text +=
          " " + theme.fg("dim", `→ ${details.targetPath}`);
      }
      return new Text(text, 0, 0);
    },
  };
}

// --- Helper: Parse repository URL ---

interface RepoInfo {
  owner: string;
  repo: string;
}

function parseRepoUrl(url: string): RepoInfo | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(
    /git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo(.git)?(/tree/...)?
  const httpsMatch = url.match(
    /https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // Generic: owner/repo at the end of any URL
  const genericMatch = url.match(
    /\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (genericMatch) {
    return { owner: genericMatch[1], repo: genericMatch[2] };
  }

  return null;
}
