import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

vi.mock("../ssrf.js", () => ({
  validateUrlForSsrf: vi.fn().mockResolvedValue(undefined),
  validateRedirectForSsrf: vi.fn().mockResolvedValue(undefined),
  isBlockedHostname: vi.fn().mockReturnValue(false),
  isBlockedByDns: vi.fn().mockResolvedValue(false),
}));

import type * as FetchConstants from "../fetch-constants.js";

vi.mock("../fetch-constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof FetchConstants>();
  return {
    ...actual,
    BINARY_TYPES: [
      "image/",
      "video/",
      "audio/",
      "application/pdf",
      "application/zip",
      "application/octet-stream",
      "application/x-gzip",
      "application/x-tar",
    ],
  };
});

vi.mock("../html-to-markdown.js", () => ({
  htmlToMarkdown: vi
    .fn()
    .mockReturnValue({ title: "Test Page", markdown: "# Test Page\n\nConverted content." }),
}));

vi.mock("../summarize.js", () => ({
  summarizeWithSubagent: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Summarized content" }],
    summarized: true,
    summarizePrompt: "summarize this",
  }),
}));

vi.mock("../tool-renderers.js", () => ({
  renderToolCall: vi.fn().mockReturnValue("fetch_content https://example.com"),
  renderToolResult: vi.fn().mockReturnValue("✓ https://example.com"),
}));

vi.mock("../detect-repo-url.js", () => ({
  isRepoUrl: vi.fn().mockReturnValue({ isRepo: false, scheme: "https" }),
}));

vi.mock("../parse-repo-url.js", () => ({
  parseRepoUrl: vi.fn().mockReturnValue({ owner: "owner", repo: "repo" }),
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue(`${tmpdir()}/pi-fetch-abc123`),
  writeFile: vi.fn().mockResolvedValue(undefined),
  lstat: vi.fn().mockResolvedValue(null),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from "node:fs/promises";
import * as detectRepoUrl from "../detect-repo-url.js";
// Import after mocks are set up
import { createFetchContentTool } from "../fetch-content.js";
import * as parseRepoUrl from "../parse-repo-url.js";
import * as ssrf from "../ssrf.js";
import * as toolRenderers from "../tool-renderers.js";

describe("fetch_content tool — repo", () => {
  const mockExec = vi.fn();
  const mockPi = {
    exec: mockExec,
  } as unknown as ExtensionAPI;
  const mockTheme = {
    fg: vi.fn().mockImplementation((_, text: string) => text),
    bold: vi.fn().mockImplementation((text: string) => text),
  } as unknown as Theme;

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    // Default: isRepoUrl returns not-a-repo
    vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({ isRepo: false, scheme: "https" });
    vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: "repo" });
    // Default fs mocks for repo clone path
    vi.mocked(fs.lstat).mockResolvedValue(null as never);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  function createTool() {
    return createFetchContentTool(mockPi);
  }

  function createMockResponse({
    status = 200,
    statusText = "OK",
    contentType = "text/html; charset=utf-8",
    body = "<html><body><h1>Test</h1><p>Hello world</p></body></html>",
    headers: customHeaders = {},
    url = "https://example.com/",
  }: {
    status?: number;
    statusText?: string;
    contentType?: string;
    body?: string;
    headers?: Record<string, string>;
    url?: string;
  } = {}) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(body);
    const readableStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });

    const headers = new Headers({
      "content-type": contentType,
      ...customHeaders,
    });

    return {
      status,
      statusText,
      ok: status >= 200 && status < 300,
      headers,
      url,
      body: readableStream,
      bodyUsed: false,
    } as Response;
  }

  function createContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    return {
      cwd: tmpdir(),
      config: {} as Record<string, unknown>,
      ...overrides,
    } as ExtensionContext;
  }

  // --- Repo URL Detection Routing ---

  describe("repo URL detection routing", () => {
    it("routes web URLs through web fetch path (not clone)", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(createMockResponse());

      await tool.execute(
        "call-1",
        { url: "https://example.com" },
        undefined,
        undefined,
        createContext(),
      );

      expect(mockFetch).toHaveBeenCalled();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("routes HTTPS repo URLs to clone path", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo" },
        undefined,
        undefined,
        createContext(),
      );

      expect(mockExec).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.details.type).toBe("repo");
    });

    it("routes SSH URLs to clone path", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@github.com:owner/repo.git",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "git@github.com:owner/repo.git" },
        undefined,
        undefined,
        createContext(),
      );

      expect(mockExec).toHaveBeenCalled();
      expect(result.details.type).toBe("repo");
    });
  });

  // --- Git Clone Success ---

  describe("git clone success", () => {
    it("returns correct path in details on successful clone", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo" },
        undefined,
        undefined,
        createContext(),
      );

      expect(result.details.type).toBe("repo");
      if (result.details.type === "repo") {
        expect(result.details.targetPath).toContain("repository-owner");
        expect(result.details.targetPath).toContain("repo");
      }
    });

    it("calls pi.exec with correct git clone arguments", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo" },
        undefined,
        undefined,
        createContext(),
      );

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--",
          "https://github.com/owner/repo",
          expect.stringContaining("repository-owner"),
        ],
        expect.objectContaining({ signal: undefined, timeout: 120_000 }),
      );
    });

    it("includes type, owner, repo, and targetPath in details", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo" },
        undefined,
        undefined,
        createContext(),
      );

      expect(result.details.type).toBe("repo");
      if (result.details.type === "repo") {
        expect(result.details.owner).toBe("owner");
        expect(result.details.repo).toBe("repo");
        expect(result.details.targetPath).toBeDefined();
      }
    });
  });

  // --- Git Clone with Branch ---

  describe("git clone with branch", () => {
    it("includes --branch flag in git clone args", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo", branch: "develop" },
        undefined,
        undefined,
        createContext(),
      );

      expect(mockExec).toHaveBeenCalledWith(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--branch",
          "develop",
          "--",
          "https://github.com/owner/repo",
          expect.stringContaining("repository-owner"),
        ],
        expect.objectContaining({ signal: undefined, timeout: 120_000 }),
      );
    });

    it("includes branch field in details", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo", branch: "develop" },
        undefined,
        undefined,
        createContext(),
      );

      expect(result.details.type).toBe("repo");
      if (result.details.type === "repo") {
        expect(result.details.branch).toBe("develop");
      }
    });
  });

  // --- Git Clone Failure ---

  describe("git clone failure", () => {
    it("throws descriptive error on clone failure", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: repository not found",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow(/git clone failed/);
    });

    it("cleans up partial clone on failure", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: repository not found",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow(/git clone failed/);

      expect(fs.rm).toHaveBeenCalled();
    });
  });

  // --- Git Clone Summarization ---

  describe("git clone summarization", () => {
    it("calls summarizeWithSubagent when summarize param is provided on repo URL", async () => {
      const { summarizeWithSubagent } = await import("../summarize.js");
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo", summarize: "summarize this repo" },
        undefined,
        undefined,
        createContext(),
      );

      expect(summarizeWithSubagent).toHaveBeenCalled();
      expect(result.details.summarized).toBe(true);
    });
  });

  // --- Git Clone with SSH URL ---

  describe("git clone with SSH URL", () => {
    it("accepts SSH URL to public host without calling validateUrlForSsrf", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@github.com:owner/repo.git",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "git@github.com:owner/repo.git" },
        undefined,
        undefined,
        createContext(),
      );

      expect(ssrf.validateUrlForSsrf).not.toHaveBeenCalled();
      expect(ssrf.isBlockedHostname).toHaveBeenCalledWith("github.com");
      expect(mockExec).toHaveBeenCalled();
    });

    it("blocks SSH URL to internal IP (192.168.1.1)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@192.168.1.1:owner/repo",
      });
      vi.mocked(ssrf.isBlockedHostname).mockReturnValueOnce(true);

      await expect(
        tool.execute(
          "call-1",
          { url: "git@192.168.1.1:owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked: cannot clone from internal/private hostname (192.168.1.1).");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("blocks SSH URL to localhost", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@localhost:owner/repo",
      });
      vi.mocked(ssrf.isBlockedHostname).mockReturnValueOnce(true);

      await expect(
        tool.execute(
          "call-1",
          { url: "git@localhost:owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked: cannot clone from internal/private hostname (localhost).");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("blocks SSH URL when DNS resolves to internal IP", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@evil.example.com:owner/repo",
      });
      // isBlockedHostname returns false (not in static list)
      vi.mocked(ssrf.isBlockedHostname).mockReturnValueOnce(false);
      // But DNS resolves to internal IP
      vi.mocked(ssrf.isBlockedByDns).mockResolvedValueOnce(true);

      await expect(
        tool.execute(
          "call-1",
          { url: "git@evil.example.com:owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked: resolved IP for evil.example.com is internal/private.");

      expect(ssrf.isBlockedHostname).toHaveBeenCalledWith("evil.example.com");
      expect(ssrf.isBlockedByDns).toHaveBeenCalledWith("evil.example.com");
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("allows SSH URL to public host that passes DNS check", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "ssh",
        sanitizedUrl: "git@github.com:owner/repo.git",
      });
      vi.mocked(ssrf.isBlockedHostname).mockReturnValueOnce(false);
      vi.mocked(ssrf.isBlockedByDns).mockResolvedValueOnce(false);
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "git@github.com:owner/repo.git" },
        undefined,
        undefined,
        createContext(),
      );

      expect(ssrf.isBlockedHostname).toHaveBeenCalledWith("github.com");
      expect(ssrf.isBlockedByDns).toHaveBeenCalledWith("github.com");
      expect(mockExec).toHaveBeenCalled();
      expect(result.details.type).toBe("repo");
    });
  });

  // --- Git Clone with HTTPS URL ---

  describe("git clone with HTTPS URL", () => {
    it("validates HTTPS repo URL through SSRF validation before cloning", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo" },
        undefined,
        undefined,
        createContext(),
      );

      expect(ssrf.validateUrlForSsrf).toHaveBeenCalledWith("https://github.com/owner/repo");
      expect(mockExec).toHaveBeenCalled();
    });
  });

  // --- Branch Parameter Injection ---

  describe("branch parameter injection", () => {
    it("passes branch parameter as array args to git clone (safe from injection)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo", branch: "feature/test" },
        undefined,
        undefined,
        createContext(),
      );

      // Verify exec is called with an array (not shell string), containing --branch and the branch name
      const execCall = mockExec.mock.calls[0]!;
      expect(execCall[0]).toBe("git");
      expect(Array.isArray(execCall[1])).toBe(true);
      expect(execCall[1]).toContainEqual("--branch");
      expect(execCall[1]).toContainEqual("feature/test");
    });

    it("does not include --branch flag when branch is undefined", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo" },
        undefined,
        undefined,
        createContext(),
      );

      const execArgs = mockExec.mock.calls[0]![1] as string[];
      expect(execArgs).not.toContain("--branch");
    });
  });

  // --- Branch Validation ---

  describe("branch validation", () => {
    it("accepts valid branch name with slashes and hyphens", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

      const result = await tool.execute(
        "call-1",
        { url: "https://github.com/owner/repo", branch: "feature/test-branch" },
        undefined,
        undefined,
        createContext(),
      );

      expect(result.details.type).toBe("repo");
      if (result.details.type === "repo") {
        expect(result.details.branch).toBe("feature/test-branch");
      }
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["--branch", "feature/test-branch"]),
        expect.any(Object),
      );
    });

    it("rejects branch with shell metacharacters", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature; rm -rf /" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch with spaces", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "my branch" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch with control characters", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature\n\tbranch" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects very long branch name (>256 chars)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      const longBranch = "a".repeat(257);

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: longBranch },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch containing double dot (..)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature/../test" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch ending with slash", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature/test/" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch ending with period", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature/test." },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch ending with .lock", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature/test.lock" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch containing tilde (~)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature~test" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch containing caret (^)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature^test" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });

    it("rejects branch containing colon (:)", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo", branch: "feature:test" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid branch name");

      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  // --- renderResult for repo results ---

  describe("renderResult for repo results", () => {
    it("shows owner/repo for repo results", () => {
      const tool = createTool();
      const testTargetPath = path.join(tmpdir(), "repository-owner", "repo");
      tool.renderResult(
        {
          content: [{ type: "text", text: "cloned" }],
          details: {
            type: "repo",
            owner: "owner",
            repo: "repo",
            targetPath: testTargetPath,
            summarized: false,
          },
        },
        { isPartial: false },
        mockTheme,
      );

      expect(toolRenderers.renderToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          showOwnerRepo: { owner: "owner", repo: "repo" },
        }),
      );
    });

    it("shows targetPath for repo results", () => {
      const tool = createTool();
      const testTargetPath = path.join(tmpdir(), "repository-owner", "repo");
      tool.renderResult(
        {
          content: [{ type: "text", text: "cloned" }],
          details: {
            type: "repo",
            owner: "owner",
            repo: "repo",
            targetPath: testTargetPath,
            summarized: false,
          },
        },
        { isPartial: false },
        mockTheme,
      );

      expect(toolRenderers.renderToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          showTargetPath: testTargetPath,
        }),
      );
    });
  });

  // --- Repo URL Parse Failure ---

  describe("repo URL parse failure", () => {
    it("throws when parseRepoUrl returns null", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue(null);

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Could not parse repository URL");
    });
  });

  // --- Repo Path Traversal Protection ---

  describe("repo path traversal protection", () => {
    it("rejects owner '..'", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/../repo",
      });
      vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "..", repo: "repo" });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/../repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid repository owner or name");
    });

    it("rejects repo '..'", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/..",
      });
      vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: ".." });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/.." },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid repository owner or name");
    });

    it("rejects owner '.'", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/./repo",
      });
      vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: ".", repo: "repo" });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/./repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid repository owner or name");
    });

    it("rejects repo '.'", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/.",
      });
      vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: "." });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/." },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid repository owner or name");
    });

    it.each(["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"])(
      "rejects Windows reserved device name '%s' as repo",
      async (reserved) => {
        const tool = createTool();
        vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
          isRepo: true,
          scheme: "https",
          sanitizedUrl: `https://github.com/owner/${reserved}`,
        });
        vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: reserved });

        await expect(
          tool.execute(
            "call-1",
            { url: `https://github.com/owner/${reserved}` },
            undefined,
            undefined,
            createContext(),
          ),
        ).rejects.toThrow("reserved device name");
      },
    );

    it.each(["CON", "AUX", "NUL"])(
      "rejects Windows reserved device name '%s' as owner",
      async (reserved) => {
        const tool = createTool();
        vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
          isRepo: true,
          scheme: "https",
          sanitizedUrl: `https://github.com/${reserved}/myrepo`,
        });
        vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: reserved, repo: "myrepo" });

        await expect(
          tool.execute(
            "call-1",
            { url: `https://github.com/${reserved}/myrepo` },
            undefined,
            undefined,
            createContext(),
          ),
        ).rejects.toThrow("reserved device name");
      },
    );
  });

  // --- Repo Symlink Protection ---

  describe("repo symlink protection", () => {
    it("rejects symlink at target path", async () => {
      const tool = createTool();
      vi.mocked(detectRepoUrl.isRepoUrl).mockReturnValue({
        isRepo: true,
        scheme: "https",
        sanitizedUrl: "https://github.com/owner/repo",
      });
      vi.mocked(parseRepoUrl.parseRepoUrl).mockReturnValue({ owner: "owner", repo: "repo" });

      // Mock lstat to return a symlink
      const mockLstat = {
        isSymbolicLink: () => true,
      };
      vi.mocked(fs.lstat).mockResolvedValue(mockLstat as never);

      await expect(
        tool.execute(
          "call-1",
          { url: "https://github.com/owner/repo" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow(/symbolic link/);
    });
  });
});
