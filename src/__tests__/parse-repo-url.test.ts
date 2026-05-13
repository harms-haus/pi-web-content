import { describe, it, expect } from "vitest";
import { parseRepoUrl } from "../parse-repo-url.js";

describe("parseRepoUrl", () => {
  describe("HTTPS URLs", () => {
    it("parses a basic HTTPS URL", () => {
      expect(parseRepoUrl("https://github.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses HTTPS URL with .git suffix", () => {
      expect(parseRepoUrl("https://github.com/owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses HTTPS URL with subpath (tree)", () => {
      expect(parseRepoUrl("https://github.com/owner/repo/tree/main")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses HTTPS URL with subpath (blob)", () => {
      expect(parseRepoUrl("https://github.com/owner/repo/blob/main/README.md")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses HTTPS URL with .git and subpath", () => {
      expect(parseRepoUrl("https://github.com/owner/repo.git/tree/main")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses HTTPS URL with trailing slash", () => {
      expect(parseRepoUrl("https://github.com/owner/repo/")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses URLs from non-GitHub hosts", () => {
      expect(parseRepoUrl("https://gitlab.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });
  });

  describe("SSH URLs", () => {
    it("parses SSH URL with .git suffix", () => {
      expect(parseRepoUrl("git@github.com:owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses SSH URL without .git suffix", () => {
      expect(parseRepoUrl("git@github.com:owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses SSH URL from non-GitHub hosts", () => {
      expect(parseRepoUrl("git@gitlab.com:owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("falls back to generic parsing for SSH URLs with 3+ path segments", () => {
      // SSH regex expects exactly owner/repo (2 segments), but generic fallback
      // matches the last two segments: subgroup/repo
      expect(parseRepoUrl("git@gitlab.com:org/subgroup/repo.git")).toEqual({
        owner: "subgroup",
        repo: "repo",
      });
    });
  });

  describe("Generic URL fallback", () => {
    it("parses owner/repo from generic URL path", () => {
      expect(parseRepoUrl("https://example.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses owner/repo from generic URL with trailing slash", () => {
      expect(parseRepoUrl("https://example.com/owner/repo/")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("parses owner/repo from generic URL with .git", () => {
      expect(parseRepoUrl("https://example.com/owner/repo.git")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });
  });

  describe("invalid URLs return null", () => {
    it.each([
      "",
      "not-a-url",
      "http://",
      "https://",
      "https://github.com",
      "https://github.com/",
      "git@github.com:",
      "git@github.com:owner",
    ])('returns null for: "%s"', (url) => {
      expect(parseRepoUrl(url)).toBeNull();
    });
  });

  describe("generic fallback catches unexpected patterns", () => {
    it("parses single-segment HTTPS as generic fallback", () => {
      // The generic fallback matches "github.com/owner" from the URL
      expect(parseRepoUrl("https://github.com/owner")).toEqual({
        owner: "github.com",
        repo: "owner",
      });
    });

    it("parses ftp URLs via generic fallback", () => {
      // The parser does not restrict schemes — generic fallback handles this
      expect(parseRepoUrl("ftp://example.com/owner/repo")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });
  });

  describe("special characters rejected", () => {
    it.each([
      "https://github.com/owner/repo;cmd",
      "https://github.com/owner/repo$(cmd)",
      "https://github.com/owner/repo`cmd`",
      "https://github.com/owner/repo|cmd",
      "https://github.com/owner/repo&cmd",
      "https://github.com/owner/repo<cmd>",
      "https://github.com/owner/repo\"cmd\"",
      "https://github.com/owner/repo'cmd'",
      "https://github.com/owner/repo;cmd.git",
      "git@github.com:owner/repo;cmd.git",
      "git@github.com:ow;ner/repo.git",
    ])('returns null for URL with special chars: "%s"', (url) => {
      expect(parseRepoUrl(url)).toBeNull();
    });
  });

  describe("owner/repo character validation", () => {
    it("allows alphanumeric characters", () => {
      expect(parseRepoUrl("https://github.com/owner123/repo456")).toEqual({
        owner: "owner123",
        repo: "repo456",
      });
    });

    it("allows dots in names", () => {
      expect(parseRepoUrl("https://github.com/my.owner/my.repo")).toEqual({
        owner: "my.owner",
        repo: "my.repo",
      });
    });

    it("allows underscores in names", () => {
      expect(parseRepoUrl("https://github.com/my_owner/my_repo")).toEqual({
        owner: "my_owner",
        repo: "my_repo",
      });
    });

    it("allows hyphens in names", () => {
      expect(parseRepoUrl("https://github.com/my-owner/my-repo")).toEqual({
        owner: "my-owner",
        repo: "my-repo",
      });
    });

    it("rejects spaces in names", () => {
      expect(parseRepoUrl("https://github.com/my owner/my repo")).toBeNull();
    });

    it("parses extra path segments via HTTPS subpath matching", () => {
      // The HTTPS regex treats /ner as a subpath, matching owner=ow, repo=ner
      expect(parseRepoUrl("https://github.com/ow/ner/repo")).toEqual({
        owner: "ow",
        repo: "ner",
      });
    });

    it("rejects at-signs in names", () => {
      expect(parseRepoUrl("https://github.com/owner@name/repo")).toBeNull();
    });

    it("rejects colons in names", () => {
      expect(parseRepoUrl("https://github.com/owner:name/repo")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles repo names with multiple dots", () => {
      expect(parseRepoUrl("https://github.com/owner/repo.name.with.dots")).toEqual({
        owner: "owner",
        repo: "repo.name.with.dots",
      });
    });

    it("handles repo names ending in .git.git", () => {
      expect(parseRepoUrl("https://github.com/owner/repo.git.git")).toEqual({
        owner: "owner",
        repo: "repo.git",
      });
    });

    it("handles deeply nested HTTPS subpaths", () => {
      expect(parseRepoUrl("https://github.com/owner/repo/tree/main/src/utils")).toEqual({
        owner: "owner",
        repo: "repo",
      });
    });

    it("handles SSH URLs with complex repo names", () => {
      expect(parseRepoUrl("git@github.com:my-org/my-cool_repo.v2.git")).toEqual({
        owner: "my-org",
        repo: "my-cool_repo.v2",
      });
    });
  });
});
