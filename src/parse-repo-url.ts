/**
 * Git repository URL parser
 *
 * Parses SSH, HTTPS, and generic git URLs to extract owner and repository name.
 * Includes owner/repo character validation to prevent injection.
 */

/** Parsed repository information */
export interface RepoInfo {
  owner: string;
  repo: string;
}

/** Regex for valid repository owner/name characters (allows optional leading ~ for SourceHut) */
const validName = /^~?[a-zA-Z0-9._-]+$/;

/**
 * Parse a git repository URL and extract owner/repo information.
 *
 * Supports:
 * - SSH: git@github.com:owner/repo.git
 * - HTTPS: https://github.com/owner/repo(.git)?(/tree/...)?
 * - Generic: owner/repo at the end of any URL
 *
 * Returns null if the URL cannot be parsed or contains invalid characters.
 */
export function parseRepoUrl(url: string): RepoInfo | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    if (!(validName.test(owner) && validName.test(repo))) {
      return null;
    }
    return { owner, repo };
  }

  // HTTPS: https://github.com/owner/repo(.git)?(/tree/...)?
  const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (httpsMatch) {
    const owner = httpsMatch[1];
    const repo = httpsMatch[2];
    if (!(validName.test(owner) && validName.test(repo))) {
      return null;
    }
    return { owner, repo };
  }

  // Generic: owner/repo at the end of any URL
  const genericMatch = url.match(/\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (genericMatch) {
    const owner = genericMatch[1];
    const repo = genericMatch[2];
    if (!(validName.test(owner) && validName.test(repo))) {
      return null;
    }
    return { owner, repo };
  }

  return null;
}
