/**
 * Git repository URL detector
 *
 * Detects whether a URL points to a git repository (for routing to git clone logic)
 * vs. a regular web page. Supports SSH, HTTPS, and special hosting platforms.
 */

/** Result of detecting whether a URL is a git repository URL */
export interface RepoUrlResult {
  isRepo: boolean;
  scheme: "ssh" | "https";
  sanitizedUrl?: string;
}

/** Known git hosting platform hostnames */
const KNOWN_GIT_HOSTNAMES = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "gitea.com",
  "gitee.com",
  "git.sr.ht",
  "sr.ht",
  "dev.azure.com",
]);

/** Path segments that indicate a non-repo web UI page on a known git host */
const NON_REPO_SEGMENTS = new Set([
  "issues",
  "pull",
  "pulls",
  "releases",
  "actions",
  "discussions",
  "wiki",
  "projects",
  "milestones",
  "settings",
  "pulse",
  "compare",
  "network",
  "graphs",
  "find",
  "search",
  "labels",
  "assignees",
  "tags",
  "downloads",
  "addons",
  "tutorials",
  "notifications",
  "account",
  "marketplace",
  "explore",
  "topics",
  "trending",
  "organizations",
  "new",
  "login",
  "signup",
  "pricing",
  "features",
  "security",
  "about",
  "sponsors",
  "collections",
]);

/** Repo-like subpaths that indicate repo content rather than web UI */
const REPO_SUBPATHS = new Set(["tree", "blob", "raw", "src", "commits", "blame", "archive"]);

/**
 * Detect whether a URL points to a git repository.
 *
 * Detection rules (in priority order):
 * 1. SSH scheme (starts with `git@`) → always repo
 * 2. `.git` in path (before query string) → always repo
 * 3. Known git host + repo-like path → repo
 * 4. Known git host + non-repo path → web
 * 5. Everything else → web (default)
 */
// eslint-disable-next-line complexity -- multi-branch URL detection with 10+ git host patterns
export function isRepoUrl(url: string): RepoUrlResult {
  // Rule 1: SSH scheme
  if (url.startsWith("git@")) {
    return { isRepo: true, scheme: "ssh", sanitizedUrl: url };
  }

  // Try to parse as HTTPS URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // URL is not parseable — treat as non-repo URL, default to web fetch.
    return { isRepo: false, scheme: "https" };
  }

  const hostname = parsed.hostname;
  // Path before query string
  const path = parsed.pathname;

  // Strip embedded credentials for sanitized URL
  const sanitizedUrl = stripCredentials(parsed);

  // Rule 2: `.git` in path (before query string)
  if (path.includes(".git")) {
    return { isRepo: true, scheme: "https", sanitizedUrl };
  }

  // Check if this is a known git host
  if (!KNOWN_GIT_HOSTNAMES.has(hostname)) {
    // Rule 5: Unknown host without .git → web
    return { isRepo: false, scheme: "https", sanitizedUrl };
  }

  // For known git hosts, analyze the path segments
  const segments = path.split("/").filter(Boolean);

  // Azure DevOps: look for `_git` in path
  if (hostname === "dev.azure.com") {
    if (segments.includes("_git")) {
      return { isRepo: true, scheme: "https", sanitizedUrl };
    }
    return { isRepo: false, scheme: "https", sanitizedUrl };
  }

  // SourceHut: /~owner/repo pattern
  if (hostname === "git.sr.ht" || hostname === "sr.ht") {
    const seg0 = segments[0];
    const seg2 = segments[2];
    if (segments.length >= 2 && seg0 !== undefined && seg0.startsWith("~")) {
      // Check if third segment (if any) is a non-repo segment
      if (segments.length >= 3 && seg2 !== undefined && NON_REPO_SEGMENTS.has(seg2)) {
        return { isRepo: false, scheme: "https", sanitizedUrl };
      }
      return { isRepo: true, scheme: "https", sanitizedUrl };
    }
    return { isRepo: false, scheme: "https", sanitizedUrl };
  }

  // Need at least owner/repo (2 segments)
  if (segments.length < 2) {
    return { isRepo: false, scheme: "https", sanitizedUrl };
  }

  const seg0 = segments[0];
  if (seg0 !== undefined && NON_REPO_SEGMENTS.has(seg0)) {
    return { isRepo: false, scheme: "https", sanitizedUrl };
  }

  // If there are more than 2 segments, check the third segment
  if (segments.length >= 3) {
    const seg2 = segments[2];
    // GitLab: /owner/repo/-/tree/branch pattern
    if (seg2 === "-" && segments.length >= 4) {
      const gitlabSection = segments[3];
      if (gitlabSection !== undefined && REPO_SUBPATHS.has(gitlabSection)) {
        return { isRepo: true, scheme: "https", sanitizedUrl };
      }
      // GitLab non-repo sections like /-/issues, /-/merge_requests
      if (gitlabSection !== undefined && NON_REPO_SEGMENTS.has(gitlabSection)) {
        return { isRepo: false, scheme: "https", sanitizedUrl };
      }
      // Other /-/ paths are likely repo content
      return { isRepo: true, scheme: "https", sanitizedUrl };
    }

    // Check if third segment is a repo-like subpath
    if (seg2 !== undefined && REPO_SUBPATHS.has(seg2)) {
      return { isRepo: true, scheme: "https", sanitizedUrl };
    }

    // Check if third segment is a non-repo segment
    if (seg2 !== undefined && NON_REPO_SEGMENTS.has(seg2)) {
      return { isRepo: false, scheme: "https", sanitizedUrl };
    }
  }

  // Exactly owner/repo → repo
  return { isRepo: true, scheme: "https", sanitizedUrl };
}

/**
 * Strip embedded credentials from a URL.
 * e.g., `https://user:pass@github.com/...` → `https://github.com/...`
 */
export function stripCredentials(parsed: URL): string {
  if (parsed.username || parsed.password) {
    const url = new URL(parsed.toString());
    url.username = "";
    url.password = "";
    return url.toString();
  }
  return parsed.toString();
}
