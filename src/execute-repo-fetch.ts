import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RepoUrlResult } from "./detect-repo-url.js";
import { GIT_CLONE_TIMEOUT_MS } from "./fetch-constants.js";
import { parseRepoUrl } from "./parse-repo-url.js";
import { sanitizeGitUrl } from "./sanitize-git-url.js";
import { isBlockedByDns, isBlockedHostname, validateUrlForSsrf } from "./ssrf.js";
import { summarizeWithSubagent } from "./summarize.js";

/** Structured details returned by fetch_content tool */
export interface FetchContentDetails {
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
// eslint-disable-next-line max-lines-per-function, complexity
export async function executeRepoFetch(
  pi: ExtensionAPI,
  params: { url: string; summarize?: string; branch?: string },
  repoResult: RepoUrlResult,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<FetchContentDetails> | undefined,
  _ctx: ExtensionContext,
) {
  const { url, summarize, branch } = params;

  // For HTTPS URLs detected as repos, do SSRF validation
  // "https" scheme covers both http:// and https:// URLs (detect-repo-url doesn't distinguish)
  if (repoResult.scheme === "https" && repoResult.sanitizedUrl) {
    await validateUrlForSsrf(repoResult.sanitizedUrl);
  } else if (repoResult.scheme === "ssh") {
    // Extract hostname from SSH URL (git@hostname:owner/repo)
    const sshUrl = repoResult.sanitizedUrl || url;
    const sshHostMatch = sshUrl.match(/^git@([^:]+):/);
    if (sshHostMatch) {
      const hostname = sshHostMatch[1];
      if (isBlockedHostname(hostname)) {
        throw new Error(
          `Blocked: cannot clone from internal/private hostname (${hostname}).`,
        );
      }
      const blocked = await isBlockedByDns(hostname);
      if (blocked) {
        throw new Error(
          `Blocked: resolved IP for ${hostname} is internal/private.`,
        );
      }
    }
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

  const targetPath = path.join(tmpdir(), `repository-${owner}`, repo);
  // NOTE: Cloned repos persist at tmpdir()/repository-{owner}/{repo} and are never
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
    // Validate branch name against git naming rules
    // Git branches: alphanumeric, /, ., _, -; no spaces, no control chars,
    // no .., no ~, no ^, no :, cannot end with .lock, /, or .
    if (
      branch.length > 256 ||
      !/^[a-zA-Z0-9/._-]+$/.test(branch) ||
      branch.includes("..") ||
      branch.endsWith("/") ||
      branch.endsWith(".") ||
      branch.endsWith(".lock") ||
      /[~^:]/.test(branch)
    ) {
      throw new Error(
        `Invalid branch name: ${branch.substring(0, 50)}${branch.length > 50 ? "..." : ""}. ` +
          "Branch names must contain only alphanumeric characters, /, ., _, and -; " +
          "cannot contain .., ~, ^, or :, and cannot end with .lock, /, or .",
      );
    }
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
    throw new Error(
      `git clone failed for ${owner}/${repo}. ${result.code ? `Exit code: ${result.code}.` : "Unknown error."}`,
    );
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
        | ((update: {
            content: Array<{ type: string; text: string }>;
            details: { status: string };
          }) => void)
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
