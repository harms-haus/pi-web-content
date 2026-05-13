import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// --- Mocks ---

vi.mock("../summarize.js", () => ({
  summarizeWithSubagent: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Summarized repo content" }],
    summarized: true,
    summarizePrompt: "summarize this repo",
  }),
}));

vi.mock("../tool-renderers.js", () => ({
  renderToolCall: vi.fn().mockReturnValue("fetch-repo https://github.com/owner/repo"),
  renderToolResult: vi.fn().mockReturnValue("✓ owner/repo"),
}));

vi.mock("node:fs/promises", () => ({
  lstat: vi.fn().mockResolvedValue(null),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks are set up
import { createFetchRepoTool } from "../fetch-repo.js";
import * as fs from "node:fs/promises";

describe("fetch-repo tool", () => {
  const mockExec = vi.fn();
  const mockPi = {
    exec: mockExec,
  } as unknown as ExtensionAPI;

  const mockTheme = {
    fg: vi.fn().mockImplementation((_, text: string) => text),
    bold: vi.fn().mockImplementation((text: string) => text),
  } as unknown as Theme;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.lstat).mockResolvedValue(null as never);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  function createTool() {
    return createFetchRepoTool(mockPi);
  }

  // --- URL Validation ---

  describe("URL validation", () => {
    it("rejects URLs with invalid scheme (ftp://)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "ftp://github.com/owner/repo" }, undefined, undefined, undefined),
      ).rejects.toThrow("Invalid repository URL: must use HTTPS or SSH (git@) scheme.");
    });

    it("rejects URLs with invalid scheme (file://)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "file:///path/to/repo" }, undefined, undefined, undefined),
      ).rejects.toThrow("Invalid repository URL: must use HTTPS or SSH (git@) scheme.");
    });

    it("rejects URLs with invalid scheme (git://)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "git://github.com/owner/repo" }, undefined, undefined, undefined),
      ).rejects.toThrow("Invalid repository URL: must use HTTPS or SSH (git@) scheme.");
    });

    it("accepts https:// URLs", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo.git" },
        undefined,
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.details?.owner).toBe("owner");
      expect(result.details?.repo).toBe("repo");
    });

    it("accepts http:// URLs", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "http://github.com/owner/repo.git" },
        undefined,
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
    });

    it("accepts SSH (git@) URLs", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "git@github.com:owner/repo.git" },
        undefined,
        undefined,
        undefined,
      );

      expect(result).toBeDefined();
      expect(result.details?.owner).toBe("owner");
      expect(result.details?.repo).toBe("repo");
    });
  });

  // --- sanitizeGitUrl ---

  describe("sanitizeGitUrl", () => {
    it("rejects empty URLs", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL/);
    });

    it("rejects URLs exceeding 2048 characters", async () => {
      const tool = createTool();
      const longUrl = `https://github.com/${"a".repeat(2048)}`;
      await expect(
        tool.execute("call-1", { url: longUrl }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL/);
    });

    it("rejects URLs with whitespace", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo with spaces" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: must not contain whitespace/);
    });

    it("rejects URLs with shell metacharacters (;)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo;rm" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: contains shell metacharacters/);
    });

    it("rejects URLs with shell metacharacters ($)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo$HOME" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: contains shell metacharacters/);
    });

    it("rejects URLs with shell metacharacters (`)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo`whoami`" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: contains shell metacharacters/);
    });

    it("rejects URLs with shell metacharacters (|)", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo|cat" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: contains shell metacharacters/);
    });

    it("rejects URLs with ext:: protocol", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo.ext::helper" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: ext:: protocol is not allowed/);
    });

    it("strips embedded credentials from HTTPS URLs", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://user:password@github.com/owner/repo.git" },
        undefined,
        undefined,
        undefined,
      );

      // The sanitized URL should not contain credentials
      const execCall = mockExec.mock.calls[0];
      const gitArgs = execCall[1] as string[];
      // git clone args: ["clone", "--depth", "1", "--single-branch", "--", sanitizedUrl, targetPath]
      const urlArg = gitArgs[5]; // 6th arg (index 5) is the sanitized URL
      expect(urlArg).not.toContain("user:password");
      expect(urlArg).toContain("github.com/owner/repo.git");
    });

    it("rejects URLs with control characters", async () => {
      const tool = createTool();
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo\x00malicious" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL/);
    });

    it("rejects URLs with disallowed characters", async () => {
      const tool = createTool();
      // < and > are not in the allowed character set
      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo<bad" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository URL: contains disallowed characters/);
    });
  });

  // --- Path Traversal Protection ---

  describe("path traversal protection", () => {
    it("rejects URLs that would result in '..' owner", async () => {
      const tool = createTool();
      // This URL would parse to owner=".."
      await expect(
        tool.execute("call-1", { url: "https://github.com/../repo.git" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Invalid repository owner or name/);
    });
  });

  // --- Git Clone ---

  describe("git clone", () => {
    it("calls pi.exec with correct arguments on success", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo.git" },
        undefined,
        undefined,
        undefined,
      );

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        ["clone", "--depth", "1", "--single-branch", "--", "https://github.com/owner/repo.git", expect.stringContaining("repository-owner")],
        expect.objectContaining({ signal: undefined, timeout: 120_000 }),
      );
      expect(result.details?.targetPath).toContain("repository-owner");
      expect(result.details?.targetPath).toContain("repo");
    });

    it("throws on git clone failure", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 128, stdout: "", stderr: "fatal: repository not found" });

      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo.git" }, undefined, undefined, undefined),
      ).rejects.toThrow(/git clone failed/);
    });

    it("throws on git clone failure with generic error", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });

      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo.git" }, undefined, undefined, undefined),
      ).rejects.toThrow(/git clone failed: unknown error/);
    });

    it("cleans up partial clone on failure", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 128, stdout: "", stderr: "fatal: repository not found" });

      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo.git" }, undefined, undefined, undefined),
      ).rejects.toThrow(/git clone failed/);

      // fs.rm should have been called for cleanup
      expect(fs.rm).toHaveBeenCalled();
    });

    it("creates parent directory before cloning", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo.git" },
        undefined,
        undefined,
        undefined,
      );

      expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining("repository-owner"), { recursive: true });
    });

    it("rejects symbolic link targets", async () => {
      const tool = createTool();
      vi.mocked(fs.lstat).mockResolvedValue({
        isSymbolicLink: () => true,
      } as never);

      await expect(
        tool.execute("call-1", { url: "https://github.com/owner/repo.git" }, undefined, undefined, undefined),
      ).rejects.toThrow(/Refusing to clone: .* is a symbolic link/);
    });
  });

  // --- Summarization ---

  describe("summarization", () => {
    it("calls summarizeWithSubagent when summarize param is provided", async () => {
      const { summarizeWithSubagent } = await import("../summarize.js");
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo.git", summarize: "summarize this repo" },
        undefined,
        undefined,
        undefined,
      );

      expect(summarizeWithSubagent).toHaveBeenCalled();
      expect(result.details?.summarized).toBe(true);
    });
  });

  // --- Streaming Updates ---

  describe("streaming updates", () => {
    it("calls onUpdate with cloning status", async () => {
      const tool = createTool();
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      const onUpdate = vi.fn();

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo.git" },
        undefined,
        onUpdate,
        undefined,
      );

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: expect.stringContaining("Cloning") }],
          details: expect.objectContaining({ status: "cloning" }),
        }),
      );
    });
  });

  // --- renderCall ---

  describe("renderCall", () => {
    it("renders a tool call with URL", () => {
      const tool = createTool();
      const result = tool.renderCall({ url: "https://github.com/owner/repo" }, mockTheme);
      expect(result).toBeDefined();
    });

    it("renders a tool call with URL and summarize", () => {
      const tool = createTool();
      const result = tool.renderCall({ url: "https://github.com/owner/repo", summarize: "summarize" }, mockTheme);
      expect(result).toBeDefined();
    });
  });

  // --- renderResult ---

  describe("renderResult", () => {
    it("renders a successful result", () => {
      const tool = createTool();
      const result = tool.renderResult(
        {
          content: [{ type: "text", text: "cloned" }],
          details: { owner: "owner", repo: "repo", targetPath: "/tmp/repository-owner/repo", summarized: false },
        },
        { isPartial: false },
        mockTheme,
      );
      expect(result).toBeDefined();
    });

    it("renders a partial result", () => {
      const tool = createTool();
      const result = tool.renderResult(
        {
          content: [{ type: "text", text: "cloning..." }],
          details: { status: "cloning" },
        },
        { isPartial: true },
        mockTheme,
      );
      expect(result).toBeDefined();
    });

    it("renders an error result", () => {
      const tool = createTool();
      const result = tool.renderResult(
        {
          content: [{ type: "text", text: "error" }],
          isError: true,
          details: { url: "https://github.com/owner/repo" },
        },
        { isPartial: false },
        mockTheme,
      );
      expect(result).toBeDefined();
    });

    it("renders a summarized result", () => {
      const tool = createTool();
      const result = tool.renderResult(
        {
          content: [{ type: "text", text: "summary" }],
          details: { owner: "owner", repo: "repo", targetPath: "/tmp/repository-owner/repo", summarized: true },
        },
        { isPartial: false },
        mockTheme,
      );
      expect(result).toBeDefined();
    });
  });
});
