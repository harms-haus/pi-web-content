import { describe, expect, it } from "vitest";
import { isRepoUrl } from "../detect-repo-url.js";

describe("isRepoUrl", () => {
  describe("SSH URLs → repo", () => {
    it("detects basic SSH URL as repo", () => {
      const result = isRepoUrl("git@github.com:owner/repo.git");
      expect(result).toEqual({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@github.com:owner/repo.git",
      });
    });

    it("detects SSH URL without .git suffix", () => {
      const result = isRepoUrl("git@github.com:owner/repo");
      expect(result).toEqual({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@github.com:owner/repo",
      });
    });

    it("detects SSH URL for GitLab", () => {
      const result = isRepoUrl("git@gitlab.com:owner/repo.git");
      expect(result.isRepo).toBe(true);
      expect(result.scheme).toBe("ssh");
    });

    it("detects SSH URL for GitLab with subgroup", () => {
      const result = isRepoUrl("git@gitlab.com:org/subgroup/repo.git");
      expect(result.isRepo).toBe(true);
      expect(result.scheme).toBe("ssh");
    });

    it("detects SSH URL for Bitbucket", () => {
      const result = isRepoUrl("git@bitbucket.org:team/project.git");
      expect(result.isRepo).toBe(true);
      expect(result.scheme).toBe("ssh");
    });
  });

  describe("HTTPS URLs with .git → repo", () => {
    it("detects GitHub URL with .git as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo.git");
      expect(result.isRepo).toBe(true);
      expect(result.scheme).toBe("https");
    });

    it("detects unknown host with .git as repo", () => {
      const result = isRepoUrl("https://example.com/owner/repo.git");
      expect(result).toEqual({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://example.com/owner/repo.git",
      });
    });

    it("detects .git in the middle of path", () => {
      const result = isRepoUrl("https://example.com/some/repo.git/tree/main");
      expect(result.isRepo).toBe(true);
    });

    it("detects unknown host with deep path and .git as repo", () => {
      const result = isRepoUrl("https://random.org/path/to/project.git");
      expect(result.isRepo).toBe(true);
      expect(result.scheme).toBe("https");
    });
  });

  describe("GitHub URLs", () => {
    it("detects bare /owner/repo as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/ with trailing slash as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/tree/branch as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/tree/main");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/blob/branch/path as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/blob/main/src/index.ts");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/raw/branch as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/raw/main/README.md");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/commits as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/commits/main");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/blame as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/blame/main/file.ts");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/archive as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/archive/refs/tags/v1.0.tar.gz");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/commit/abc123 as repo", () => {
      const result = isRepoUrl("https://github.com/owner/repo/commit/abc123");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/issues as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/issues");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/pull/123 as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/pull/123");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/releases as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/releases");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/pulls as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/pulls");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/actions as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/actions");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/discussions as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/discussions");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/wiki as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/wiki");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/projects as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/projects");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/milestones as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/milestones");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/settings as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/settings");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/security as web", () => {
      const result = isRepoUrl("https://github.com/owner/repo/security");
      expect(result.isRepo).toBe(false);
    });

    it("detects profile page /owner as web", () => {
      const result = isRepoUrl("https://github.com/owner");
      expect(result.isRepo).toBe(false);
    });

    it("detects homepage / as web", () => {
      const result = isRepoUrl("https://github.com/");
      expect(result.isRepo).toBe(false);
    });

    it("detects host-only https://github.com as web", () => {
      const result = isRepoUrl("https://github.com");
      expect(result.isRepo).toBe(false);
    });

    it("detects /explore as web", () => {
      const result = isRepoUrl("https://github.com/explore");
      expect(result.isRepo).toBe(false);
    });

    it("detects /trending as web", () => {
      const result = isRepoUrl("https://github.com/trending");
      expect(result.isRepo).toBe(false);
    });

    it("detects /notifications as web", () => {
      const result = isRepoUrl("https://github.com/notifications");
      expect(result.isRepo).toBe(false);
    });

    it("detects /marketplace as web", () => {
      const result = isRepoUrl("https://github.com/marketplace");
      expect(result.isRepo).toBe(false);
    });

    it("detects /topics as web", () => {
      const result = isRepoUrl("https://github.com/topics");
      expect(result.isRepo).toBe(false);
    });

    it("detects /organizations as web", () => {
      const result = isRepoUrl("https://github.com/organizations");
      expect(result.isRepo).toBe(false);
    });

    it("detects /new as web", () => {
      const result = isRepoUrl("https://github.com/new");
      expect(result.isRepo).toBe(false);
    });

    it("detects /login as web", () => {
      const result = isRepoUrl("https://github.com/login");
      expect(result.isRepo).toBe(false);
    });

    it("detects /pricing as web", () => {
      const result = isRepoUrl("https://github.com/pricing");
      expect(result.isRepo).toBe(false);
    });

    it("detects /features as web", () => {
      const result = isRepoUrl("https://github.com/features");
      expect(result.isRepo).toBe(false);
    });

    it("detects /sponsors as web", () => {
      const result = isRepoUrl("https://github.com/sponsors");
      expect(result.isRepo).toBe(false);
    });

    it("detects /collections as web", () => {
      const result = isRepoUrl("https://github.com/collections");
      expect(result.isRepo).toBe(false);
    });

    it("works with www.github.com", () => {
      const result = isRepoUrl("https://www.github.com/owner/repo");
      expect(result.isRepo).toBe(true);
    });
  });

  describe("GitLab URLs", () => {
    it("detects bare /owner/repo as repo", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/-/tree/branch as repo", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo/-/tree/main");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/-/blob/branch/path as repo", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo/-/blob/main/src/index.ts");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/-/raw/branch as repo", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo/-/raw/main/README.md");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/-/issues as web", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo/-/issues");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/-/merge_requests as repo", () => {
      // merge_requests is not in NON_REPO_SEGMENTS and not a REPO_SUBPATH,
      // the /-/ handler returns it as repo (other /-/ paths treated as repo content)
      const result = isRepoUrl("https://gitlab.com/owner/repo/-/merge_requests");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/-/wiki as web", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo/-/wiki");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/issues as web (non-/-/ pattern)", () => {
      const result = isRepoUrl("https://gitlab.com/owner/repo/issues");
      expect(result.isRepo).toBe(false);
    });
  });

  describe("Bitbucket URLs", () => {
    it("detects bare /owner/repo as repo", () => {
      const result = isRepoUrl("https://bitbucket.org/owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/src/branch as repo", () => {
      const result = isRepoUrl("https://bitbucket.org/owner/repo/src/main");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/src/branch/path as repo", () => {
      const result = isRepoUrl("https://bitbucket.org/owner/repo/src/main/README.md");
      expect(result.isRepo).toBe(true);
    });

    it("detects /owner/repo/issues as web", () => {
      const result = isRepoUrl("https://bitbucket.org/owner/repo/issues");
      expect(result.isRepo).toBe(false);
    });

    it("detects /owner/repo/pull-requests as repo (pull-requests not in non-repo set)", () => {
      // pull-requests is not a NON_REPO_SEGMENT, so it falls through to default repo
      const result = isRepoUrl("https://bitbucket.org/owner/repo/pull-requests");
      // Not a known repo subpath or non-repo segment, so treated as repo
      expect(result.isRepo).toBe(true);
    });
  });

  describe("Other known git hosts", () => {
    it("detects Codeberg /owner/repo as repo", () => {
      const result = isRepoUrl("https://codeberg.org/owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects Gitea /owner/repo as repo", () => {
      const result = isRepoUrl("https://gitea.com/owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects Gitee /owner/repo as repo", () => {
      const result = isRepoUrl("https://gitee.com/owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects Codeberg /owner/repo/issues as web", () => {
      const result = isRepoUrl("https://codeberg.org/owner/repo/issues");
      expect(result.isRepo).toBe(false);
    });

    it("detects Gitea /owner/repo/releases as web", () => {
      const result = isRepoUrl("https://gitea.com/owner/repo/releases");
      expect(result.isRepo).toBe(false);
    });
  });

  describe("SourceHut URLs", () => {
    it("detects /~owner/repo as repo", () => {
      const result = isRepoUrl("https://git.sr.ht/~owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects /~owner/repo on sr.ht as repo", () => {
      const result = isRepoUrl("https://sr.ht/~owner/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects /~owner/repo/tree as repo", () => {
      const result = isRepoUrl("https://git.sr.ht/~owner/repo/tree/main");
      expect(result.isRepo).toBe(true);
    });

    it("detects SourceHut without ~owner as web", () => {
      const result = isRepoUrl("https://git.sr.ht/owner/repo");
      expect(result.isRepo).toBe(false);
    });

    it("detects bare sr.ht homepage as web", () => {
      const result = isRepoUrl("https://sr.ht/");
      expect(result.isRepo).toBe(false);
    });
  });

  describe("Azure DevOps URLs", () => {
    it("detects /org/project/_git/repo as repo", () => {
      const result = isRepoUrl("https://dev.azure.com/org/project/_git/repo");
      expect(result.isRepo).toBe(true);
    });

    it("detects Azure DevOps without _git as web", () => {
      const result = isRepoUrl("https://dev.azure.com/org/project");
      expect(result.isRepo).toBe(false);
    });

    it("detects Azure DevOps _git with branch path as repo", () => {
      const result = isRepoUrl("https://dev.azure.com/org/project/_git/repo?path=%2FREADME.md");
      expect(result.isRepo).toBe(true);
    });
  });

  describe("Unknown hosts", () => {
    it("detects unknown host without .git as web", () => {
      const result = isRepoUrl("https://example.com/owner/repo");
      expect(result.isRepo).toBe(false);
    });

    it("detects unknown host with .git as repo", () => {
      const result = isRepoUrl("https://example.com/owner/repo.git");
      expect(result.isRepo).toBe(true);
    });

    it("detects random website as web", () => {
      const result = isRepoUrl("https://www.google.com/search?q=git");
      expect(result.isRepo).toBe(false);
    });
  });

  describe("Invalid URLs", () => {
    it("returns web for no-scheme plain hostname", () => {
      const result = isRepoUrl("github.com");
      expect(result).toEqual({ isRepo: false, scheme: "https" });
    });

    it("returns web for empty string", () => {
      const result = isRepoUrl("");
      expect(result).toEqual({ isRepo: false, scheme: "https" });
    });

    it("returns web for plain text", () => {
      const result = isRepoUrl("not-a-url");
      expect(result).toEqual({ isRepo: false, scheme: "https" });
    });

    it("returns web for incomplete URL", () => {
      const result = isRepoUrl("https://");
      expect(result).toEqual({ isRepo: false, scheme: "https" });
    });

    it("returns web for just a scheme", () => {
      const result = isRepoUrl("http://");
      expect(result).toEqual({ isRepo: false, scheme: "https" });
    });
  });

  describe("Embedded credentials stripped from sanitizedUrl", () => {
    it("strips user:pass from HTTPS URL", () => {
      const result = isRepoUrl("https://user:pass@github.com/owner/repo");
      expect(result.sanitizedUrl).toBe("https://github.com/owner/repo");
    });

    it("strips user-only from HTTPS URL", () => {
      const result = isRepoUrl("https://user@github.com/owner/repo");
      expect(result.sanitizedUrl).toBe("https://github.com/owner/repo");
    });

    it("returns sanitized URL for URLs without credentials", () => {
      const result = isRepoUrl("https://github.com/owner/repo");
      expect(result.sanitizedUrl).toBe("https://github.com/owner/repo");
    });

    it("strips credentials from URL with .git", () => {
      const result = isRepoUrl("https://user:pass@example.com/owner/repo.git");
      expect(result.isRepo).toBe(true);
      expect(result.sanitizedUrl).toBe("https://example.com/owner/repo.git");
    });
  });

  describe("scheme detection", () => {
    it("returns ssh scheme for SSH URLs", () => {
      const result = isRepoUrl("git@github.com:owner/repo.git");
      expect(result.scheme).toBe("ssh");
    });

    it("returns https scheme for HTTPS URLs", () => {
      const result = isRepoUrl("https://github.com/owner/repo");
      expect(result.scheme).toBe("https");
    });

    it("returns https scheme for invalid URLs", () => {
      const result = isRepoUrl("not-a-url");
      expect(result.scheme).toBe("https");
    });
  });
});
