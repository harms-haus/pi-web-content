import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

vi.mock("../ssrf.js", () => ({
  validateUrlForSsrf: vi.fn().mockResolvedValue(undefined),
  isBlockedHostname: vi.fn().mockReturnValue(false),
  isBlockedByDns: vi.fn().mockResolvedValue(false),
}));

vi.mock("../sanitize-git-url.js", () => ({
  sanitizeGitUrl: vi.fn((url: string) => url),
}));

vi.mock("../parse-repo-url.js", () => ({
  parseRepoUrl: vi.fn().mockReturnValue({ owner: "owner", repo: "repo" }),
}));

vi.mock("../summarize.js", () => ({
  summarizeWithSubagent: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Summarized content" }],
    summarized: true,
    summarizePrompt: "summarize this repo",
  }),
}));

vi.mock("../fetch-constants.js", () => ({
  GIT_CLONE_TIMEOUT_MS: 120_000,
}));

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn().mockRejectedValue({ code: "ENOENT" }),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeRepoFetch } from "../execute-repo-fetch.js";
import type { RepoUrlResult } from "../detect-repo-url.js";
import * as ssrf from "../ssrf.js";
import * as sanitizeGitUrl from "../sanitize-git-url.js";
import * as parseRepoUrl from "../parse-repo-url.js";
import * as summarize from "../summarize.js";

describe("executeRepoFetch", () => {
  const mockExec = vi.fn();
  const mockPi = { exec: mockExec } as unknown as ExtensionAPI;

  function makeRepoResult(overrides: Partial<RepoUrlResult> = {}): RepoUrlResult {
    return {
      isRepo: true,
      scheme: "https",
      sanitizedUrl: "https://github.com/owner/repo",
      ...overrides,
    };
  }

  function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    return {
      cwd: tmpdir(),
      config: {} as Record<string, unknown>,
      ...overrides,
    } as ExtensionContext;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mocks to safe defaults
    vi.mocked(fs.lstat).mockRejectedValue({ code: "ENOENT" });
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    // Reset parseRepoUrl to return a valid result
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: "repo" });
    // Reset sanitizeGitUrl to pass-through
    vi.mocked(sanitizeGitUrl.sanitizeGitUrl).mockImplementation((url: string) => url);
  });

  // 1. Successful HTTPS clone — SSRF checks pass, exec succeeds (code 0)
  it("returns correct shape on successful HTTPS clone", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const result = await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo" },
      makeRepoResult(),
      undefined,
      undefined,
      makeCtx(),
    );

    expect(ssrf.validateUrlForSsrf).toHaveBeenCalledWith("https://github.com/owner/repo");
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["clone", "--depth", "1", "--single-branch"]),
      expect.objectContaining({ timeout: 120_000 }),
    );
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("Repository cloned to:");
    expect(result.details).toMatchObject({
      url: "https://github.com/owner/repo",
      owner: "owner",
      repo: "repo",
      summarized: false,
      type: "repo",
      branch: undefined,
    });
    expect(result.details.targetPath).toContain("repository-owner");
  });

  // 2. Successful SSH clone — verify SSH hostname extraction and SSRF check
  it("extracts SSH hostname and checks SSRF for SSH URLs", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const result = await executeRepoFetch(
      mockPi,
      { url: "git@github.com:owner/repo.git" },
      makeRepoResult({ scheme: "ssh", sanitizedUrl: "git@github.com:owner/repo.git" }),
      undefined,
      undefined,
      makeCtx(),
    );

    // Should NOT call validateUrlForSsrf for SSH URLs
    expect(ssrf.validateUrlForSsrf).not.toHaveBeenCalled();
    // Should check the hostname via isBlockedHostname
    expect(ssrf.isBlockedHostname).toHaveBeenCalledWith("github.com");
    expect(result.details.type).toBe("repo");
    expect(result.details.owner).toBe("owner");
    expect(result.details.repo).toBe("repo");
  });

  // 3. Clone with branch — verify --branch in git args
  it("includes --branch flag in git args when branch is specified", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const result = await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo", branch: "develop" },
      makeRepoResult(),
      undefined,
      undefined,
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--branch", "develop", "--", "https://github.com/owner/repo", expect.stringContaining("repository-owner")],
      expect.objectContaining({ signal: undefined, timeout: 120_000 }),
    );
    expect(result.details.branch).toBe("develop");
  });

  // 4. Clone failure (non-zero exit code) — verify error thrown, cleanup attempted
  it("throws error and cleans up on non-zero exit code", async () => {
    mockExec.mockResolvedValueOnce({ code: 128, stdout: "", stderr: "fatal: not found" });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/owner/repo" },
        makeRepoResult(),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("git clone failed for owner/repo");

    // Cleanup rm should have been called (once before clone, once after failure)
    expect(fs.rm).toHaveBeenCalled();
  });

  // 5. Invalid repo URL — parseRepoUrl returns null
  it("throws when parseRepoUrl returns null", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue(null);

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/garbage" },
        makeRepoResult({ sanitizedUrl: "https://github.com/garbage" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Could not parse repository URL: https://github.com/garbage");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 6. Path traversal owner (..)
  it("throws for path traversal owner '..'", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "..", repo: "repo" });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/../repo" },
        makeRepoResult({ sanitizedUrl: "https://github.com/../repo" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Invalid repository owner or name in URL.");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 7. Path traversal repo (..)
  it("throws for path traversal repo '..'", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: ".." });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/owner/.." },
        makeRepoResult({ sanitizedUrl: "https://github.com/owner/.." }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Invalid repository owner or name in URL.");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 8. Symlink at target — lstat returns symbolic link
  it("throws when target path is a symbolic link", async () => {
    const mockLstat = { isSymbolicLink: () => true };
    vi.mocked(fs.lstat).mockResolvedValue(mockLstat as never);

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/owner/repo" },
        makeRepoResult(),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow(/symbolic link/);

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 9. SSRF block (HTTPS) — validateUrlForSsrf throws
  it("throws when HTTPS URL fails SSRF validation", async () => {
    vi.mocked(ssrf.validateUrlForSsrf).mockRejectedValueOnce(
      new Error("Blocked: cannot fetch internal/private addresses (localhost)."),
    );

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://localhost/repo" },
        makeRepoResult({ sanitizedUrl: "https://localhost/repo" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Blocked: cannot fetch internal/private addresses (localhost).");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 10. SSRF block (SSH) — SSH hostname blocked
  it("throws when SSH hostname is blocked by isBlockedHostname", async () => {
    vi.mocked(ssrf.isBlockedHostname).mockReturnValueOnce(true);

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "git@192.168.1.1:owner/repo" },
        makeRepoResult({ scheme: "ssh", sanitizedUrl: "git@192.168.1.1:owner/repo" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Blocked: cannot clone from internal/private hostname (192.168.1.1).");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 10b. SSRF block (SSH) — SSH hostname blocked by DNS
  it("throws when SSH hostname resolves to internal IP via DNS", async () => {
    vi.mocked(ssrf.isBlockedByDns).mockResolvedValueOnce(true);

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "git@evil.example.com:owner/repo" },
        makeRepoResult({ scheme: "ssh", sanitizedUrl: "git@evil.example.com:owner/repo" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Blocked: resolved IP for evil.example.com is internal/private.");

    expect(ssrf.isBlockedHostname).toHaveBeenCalledWith("evil.example.com");
    expect(ssrf.isBlockedByDns).toHaveBeenCalledWith("evil.example.com");
    expect(mockExec).not.toHaveBeenCalled();
  });

  // 11. Windows reserved name (CON)
  it("throws for Windows reserved device name as repo", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: "CON" });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/owner/CON" },
        makeRepoResult({ sanitizedUrl: "https://github.com/owner/CON" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("reserved device name on Windows");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 11b. Windows reserved name as owner
  it("throws for Windows reserved device name as owner", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "AUX", repo: "repo" });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/AUX/repo" },
        makeRepoResult({ sanitizedUrl: "https://github.com/AUX/repo" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("reserved device name on Windows");

    expect(mockExec).not.toHaveBeenCalled();
  });

  // 12. Summarization — verify summarizeWithSubagent called, result has summarized: true
  it("calls summarizeWithSubagent when summarize param is provided and returns summarized result", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const result = await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo", summarize: "summarize this repo" },
      makeRepoResult(),
      undefined,
      undefined,
      makeCtx(),
    );

    expect(summarize.summarizeWithSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        summarize: "summarize this repo",
        roleContext: "You are analyzing a cloned git repository.",
        url: "https://github.com/owner/repo",
      }),
    );
    expect(result.details.summarized).toBe(true);
    expect(result.details.summarizePrompt).toBe("summarize this repo");
  });

  // --- Additional edge cases ---

  it("passes signal to pi.exec", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const controller = new AbortController();
    const signal = controller.signal;

    await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo" },
      makeRepoResult(),
      signal,
      undefined,
      makeCtx(),
    );

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ signal }),
    );
  });

  it("calls onUpdate with cloning status", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const onUpdate = vi.fn();

    await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo" },
      makeRepoResult(),
      undefined,
      onUpdate,
      makeCtx(),
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ status: "cloning" }),
      }),
    );
  });

  it("removes existing directory before cloning", async () => {
    // lstat returns a non-symlink stat result (directory exists)
    const mockLstat = { isSymbolicLink: () => false };
    vi.mocked(fs.lstat).mockResolvedValue(mockLstat as never);

    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo" },
      makeRepoResult(),
      undefined,
      undefined,
      makeCtx(),
    );

    expect(fs.rm).toHaveBeenCalledWith(
      expect.stringContaining("repository-owner"),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("creates parent directory before cloning", async () => {
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo" },
      makeRepoResult(),
      undefined,
      undefined,
      makeCtx(),
    );

    expect(fs.mkdir).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("uses sanitized URL from sanitizeGitUrl for cloning", async () => {
    vi.mocked(sanitizeGitUrl.sanitizeGitUrl).mockReturnValue("https://github.com/owner/repo.git");
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await executeRepoFetch(
      mockPi,
      { url: "https://github.com/owner/repo" },
      makeRepoResult(),
      undefined,
      undefined,
      makeCtx(),
    );

    expect(sanitizeGitUrl.sanitizeGitUrl).toHaveBeenCalledWith("https://github.com/owner/repo");
    const execArgs = mockExec.mock.calls[0]![1] as string[];
    // The sanitized URL should be used in the git args
    expect(execArgs).toContain("https://github.com/owner/repo.git");
  });

  it("rejects path traversal owner '.'", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: ".", repo: "repo" });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/./repo" },
        makeRepoResult({ sanitizedUrl: "https://github.com/./repo" }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Invalid repository owner or name in URL.");
  });

  it("rejects path traversal repo '.'", async () => {
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: "." });

    await expect(
      executeRepoFetch(
        mockPi,
        { url: "https://github.com/owner/." },
        makeRepoResult({ sanitizedUrl: "https://github.com/owner/." }),
        undefined,
        undefined,
        makeCtx(),
      ),
    ).rejects.toThrow("Invalid repository owner or name in URL.");
  });
});
