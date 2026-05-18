import { describe, expect, it } from "vitest";
import { sanitizeGitUrl } from "../sanitize-git-url.js";

describe("sanitizeGitUrl", () => {
  // --- Rejection tests ---

  it("rejects empty string", () => {
    expect(() => sanitizeGitUrl("")).toThrow("empty or exceeds maximum length");
  });

  it("rejects URL exceeding 2048 characters", () => {
    const longUrl = `https://github.com/owner/${"a".repeat(2050)}`;
    expect(() => sanitizeGitUrl(longUrl)).toThrow("empty or exceeds maximum length");
  });

  it("rejects URL with space character", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo name")).toThrow(
      "must not contain whitespace",
    );
  });

  it("rejects URL with tab character", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo\tname")).toThrow(
      "must not contain whitespace",
    );
  });

  it("rejects URL with newline character", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo\nname")).toThrow(
      "must not contain whitespace",
    );
  });

  it("rejects ext:: protocol", () => {
    expect(() => sanitizeGitUrl("ext::git-remote-helper")).toThrow("ext:: protocol is not allowed");
  });

  it("rejects semicolon shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo;rm-rf")).toThrow(
      "shell metacharacters",
    );
  });

  it("rejects pipe shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo|cat")).toThrow(
      "shell metacharacters",
    );
  });

  it("rejects backtick shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo`whoami`")).toThrow(
      "shell metacharacters",
    );
  });

  it("rejects dollar sign shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo$HOME")).toThrow(
      "shell metacharacters",
    );
  });

  it("rejects parenthesis shell metacharacters", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo()")).toThrow("shell metacharacters");
  });

  it("rejects curly brace shell metacharacters", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo{}")).toThrow("shell metacharacters");
  });

  it("rejects exclamation mark shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo!")).toThrow("shell metacharacters");
  });

  it("rejects backslash shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo\\")).toThrow("shell metacharacters");
  });

  it("rejects single quote shell metacharacter", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo'")).toThrow("shell metacharacters");
  });

  it("rejects double quote shell metacharacter", () => {
    expect(() => sanitizeGitUrl('https://github.com/owner/repo"')).toThrow("shell metacharacters");
  });

  it("rejects control characters (null byte)", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo\0")).toThrow("control characters");
  });

  it("rejects control characters (0x01)", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo\u0001")).toThrow(
      "control characters",
    );
  });

  it("rejects tilde as disallowed character", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/~repo")).toThrow("disallowed characters");
  });

  it("rejects plus as disallowed character", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/repo+extra")).toThrow(
      "disallowed characters",
    );
  });

  it("rejects percent as disallowed character", () => {
    expect(() => sanitizeGitUrl("https://github.com/owner/%20repo")).toThrow(
      "disallowed characters",
    );
  });

  // --- Credential stripping tests ---

  it("strips credentials from HTTPS URL with username and password", () => {
    const result = sanitizeGitUrl("https://user:pass@github.com/owner/repo");
    expect(result).toBe("https://github.com/owner/repo");
  });

  it("strips username-only credentials from HTTPS URL", () => {
    const result = sanitizeGitUrl("https://user@github.com/owner/repo");
    expect(result).toBe("https://github.com/owner/repo");
  });

  // --- Pass-through tests ---

  it("passes clean HTTPS URL unchanged", () => {
    const url = "https://github.com/owner/repo";
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it("passes SSH URL unchanged", () => {
    const url = "git@github.com:owner/repo.git";
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it("passes URL with query parameters", () => {
    const url = "https://github.com/owner/repo?foo=bar";
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it("passes URL with hash fragment", () => {
    const url = "https://github.com/owner/repo#readme";
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  // --- Boundary tests ---

  it("passes URL exactly 2048 characters", () => {
    // Build a URL that is exactly 2048 chars long
    const base = "https://github.com/owner/";
    const repoLen = 2048 - base.length;
    const url = base + "a".repeat(repoLen);
    expect(url.length).toBe(2048);
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it("rejects URL that is 2049 characters", () => {
    const base = "https://github.com/owner/";
    const repoLen = 2049 - base.length;
    const url = base + "a".repeat(repoLen);
    expect(url.length).toBe(2049);
    expect(() => sanitizeGitUrl(url)).toThrow("empty or exceeds maximum length");
  });

  // --- Additional edge cases ---

  it("passes URL with multiple path segments", () => {
    const url = "https://github.com/owner/repo/tree/main/src";
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it("passes URL with trailing slash", () => {
    const url = "https://github.com/owner/repo/";
    expect(sanitizeGitUrl(url)).toBe(url);
  });

  it("strips credentials from URL with path after them", () => {
    const result = sanitizeGitUrl("https://user:pass@github.com/owner/repo.git");
    expect(result).toBe("https://github.com/owner/repo.git");
  });
});
