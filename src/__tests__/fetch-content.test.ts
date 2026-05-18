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

vi.mock("../html-to-markdown.js", () => ({
  htmlToMarkdown: vi
    .fn()
    .mockReturnValue({ title: "Test Page", markdown: "# Test Page\n\nConverted content." }),
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
  mkdtemp: vi.fn().mockResolvedValue("/tmp/pi-fetch-abc123"),
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

describe("fetch_content tool", () => {
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
    // Default: isRepoUrl returns not-a-repo so existing web tests pass
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

  // --- URL Validation ---

  describe("URL validation", () => {
    it("rejects non-http URLs (ftp://)", async () => {
      const tool = createTool();
      await expect(
        tool.execute(
          "call-1",
          { url: "ftp://example.com/file.txt" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid URL: must start with http:// or https://");
    });

    it("rejects non-http URLs (file://)", async () => {
      const tool = createTool();
      await expect(
        tool.execute(
          "call-1",
          { url: "file:///etc/passwd" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid URL: must start with http:// or https://");
    });

    it("rejects non-http URLs (data:)", async () => {
      const tool = createTool();
      await expect(
        tool.execute(
          "call-1",
          { url: "data:text/plain,hello" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Invalid URL: must start with http:// or https://");
    });

    it("accepts http:// URLs", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(createMockResponse());
      await tool.execute(
        "call-1",
        { url: "http://example.com/" },
        undefined,
        undefined,
        createContext(),
      );
      expect(mockFetch).toHaveBeenCalled();
    });

    it("accepts https:// URLs", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(createMockResponse());
      await tool.execute(
        "call-1",
        { url: "https://example.com/" },
        undefined,
        undefined,
        createContext(),
      );
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  // --- SSRF Protection ---

  describe("SSRF protection", () => {
    it("calls validateUrlForSsrf before fetching", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(createMockResponse());
      await tool.execute(
        "call-1",
        { url: "https://example.com/" },
        undefined,
        undefined,
        createContext(),
      );
      expect(ssrf.validateUrlForSsrf).toHaveBeenCalledWith("https://example.com/");
    });

    it("blocks localhost URLs", async () => {
      const tool = createTool();
      vi.mocked(ssrf.validateUrlForSsrf).mockRejectedValueOnce(
        new Error("Blocked: cannot fetch internal/private addresses (localhost)."),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "http://localhost:3000/" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked: cannot fetch internal/private addresses");
    });

    it("blocks 127.0.0.1 URLs", async () => {
      const tool = createTool();
      vi.mocked(ssrf.validateUrlForSsrf).mockRejectedValueOnce(
        new Error("Blocked: cannot fetch internal/private addresses (127.0.0.1)."),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "http://127.0.0.1:8080/" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked: cannot fetch internal/private addresses");
    });

    it("blocks private IP URLs", async () => {
      const tool = createTool();
      vi.mocked(ssrf.validateUrlForSsrf).mockRejectedValueOnce(
        new Error("Blocked: resolved IP for internal.example.com is internal/private."),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "http://internal.example.com/" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked:");
    });
  });

  // --- Content-Type Routing ---

  describe("content-type routing", () => {
    it("handles JSON responses", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "application/json",
          body: '{"key": "value"}',
        }),
      );
      const result = await tool.execute(
        "call-1",
        { url: "https://api.example.com/data" },
        undefined,
        undefined,
        createContext(),
      );
      expect(result.content[0].text).toContain("JSON Response");
      expect(result.content[0].text).toContain('"key": "value"');
    });

    it("handles plain text responses", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "text/plain",
          body: "Hello plain text",
        }),
      );
      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/readme.txt" },
        undefined,
        undefined,
        createContext(),
      );
      expect(result.content[0].text).toContain("Text Response");
      expect(result.content[0].text).toContain("Hello plain text");
    });

    it("handles HTML responses", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "text/html; charset=utf-8",
          body: "<html><body><h1>Test</h1></body></html>",
        }),
      );
      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/" },
        undefined,
        undefined,
        createContext(),
      );
      expect(result.content[0].text).toContain("Test Page");
    });

    it("rejects binary content types", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "image/png",
          body: "binary data",
        }),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/image.png" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Unsupported content type");
    });

    it("rejects PDF content type", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "application/pdf",
          body: "binary pdf data",
        }),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/doc.pdf" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Unsupported content type");
    });

    it("rejects octet-stream content type", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "application/octet-stream",
          body: "binary data",
        }),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/file.bin" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Unsupported content type");
    });

    it("handles CSV content type", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "text/csv",
          body: "a,b,c\n1,2,3",
        }),
      );
      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/data.csv" },
        undefined,
        undefined,
        createContext(),
      );
      expect(result.content[0].text).toContain("Text Response");
      expect(result.content[0].text).toContain("a,b,c");
    });
  });

  // --- Response Size Limit ---

  describe("response size limit", () => {
    it("rejects responses larger than 10MB", async () => {
      const tool = createTool();
      const largeBody = "x".repeat(11 * 1024 * 1024); // 11MB
      const encoder = new TextEncoder();
      const encoded = encoder.encode(largeBody);
      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        ok: true,
        headers: new Headers({ "content-type": "text/plain" }),
        url: "https://example.com/large",
        body: readableStream,
        bodyUsed: false,
      });

      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/large" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow(/Response body exceeds maximum size/);
    });

    it("accepts responses at or below 10MB", async () => {
      const tool = createTool();
      const body = "x".repeat(10 * 1024 * 1024); // exactly 10MB
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "text/plain",
          body,
        }),
      );
      // This should not throw a size error (may throw other errors due to truncation)
      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/exact" },
        undefined,
        undefined,
        createContext(),
      );
      expect(result).toBeDefined();
    });
  });

  // --- HTTP Error Handling ---

  describe("HTTP error handling", () => {
    it("throws on 404 responses", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 404,
          statusText: "Not Found",
        }),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/missing" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("HTTP 404 Not Found");
    });

    it("throws on 500 responses", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/error" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("HTTP 500 Internal Server Error");
    });

    it("throws on fetch failure", async () => {
      const tool = createTool();
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Failed to fetch");
    });
  });

  // --- Redirect Handling ---

  describe("redirect handling", () => {
    it("follows redirects with SSRF validation", async () => {
      const tool = createTool();
      const redirectResponse = {
        status: 301,
        statusText: "Moved Permanently",
        ok: false,
        headers: new Headers({ location: "https://example.com/final" }),
        url: "https://example.com/redirect",
        body: null,
        bodyUsed: false,
      } as Response;

      const finalResponse = createMockResponse({
        url: "https://example.com/final",
      });

      mockFetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/redirect" },
        undefined,
        undefined,
        createContext(),
      );
      expect(ssrf.validateRedirectForSsrf).toHaveBeenCalled();
      expect(result.content[0].text).toContain("https://example.com/final");
    });

    it("blocks redirects to internal addresses", async () => {
      const tool = createTool();
      const redirectResponse = {
        status: 301,
        statusText: "Moved Permanently",
        ok: false,
        headers: new Headers({ location: "http://localhost:3000/internal" }),
        url: "https://example.com/redirect",
        body: null,
        bodyUsed: false,
      } as Response;

      mockFetch.mockResolvedValueOnce(redirectResponse);
      vi.mocked(ssrf.validateRedirectForSsrf).mockRejectedValueOnce(
        new Error("Blocked: redirect to internal/private address (localhost)"),
      );

      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/redirect" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow("Blocked: redirect to internal/private address");
    });
  });

  // --- Summarization ---

  describe("summarization", () => {
    it("calls summarizeWithSubagent when summarize param is provided", async () => {
      const { summarizeWithSubagent } = await import("../summarize.js");
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(createMockResponse());

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/", summarize: "summarize this" },
        undefined,
        undefined,
        createContext(),
      );

      expect(summarizeWithSubagent).toHaveBeenCalled();
      expect(result.details.summarized).toBe(true);
    });
  });

  // --- Abort Signal ---

  describe("abort signal", () => {
    it("throws abort error when signal is aborted", async () => {
      const tool = createTool();
      const controller = new AbortController();
      controller.abort();

      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/" },
          controller.signal,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow(/Fetch cancelled/);
    });
  });

  // --- renderCall ---

  describe("renderCall", () => {
    it("renders a tool call with URL", () => {
      const tool = createTool();
      const result = tool.renderCall({ url: "https://example.com/" }, mockTheme);
      expect(result).toBeDefined();
    });

    it("renders a tool call with URL and summarize", () => {
      const tool = createTool();
      const result = tool.renderCall(
        { url: "https://example.com/", summarize: "summarize this" },
        mockTheme,
      );
      expect(result).toBeDefined();
    });
  });

  // --- renderResult ---

  describe("renderResult", () => {
    it("renders a successful result", () => {
      const tool = createTool();
      const result = tool.renderResult(
        {
          content: [{ type: "text", text: "content" }],
          details: {
            url: "https://example.com/",
            contentLength: 1000,
            truncated: false,
            summarized: false,
            type: "web",
          },
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
          content: [{ type: "text", text: "content" }],
          details: { url: "https://example.com/", type: "web" },
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
          details: { url: "https://example.com/", status: "error", type: "web" },
        },
        { isPartial: false },
        mockTheme,
      );
      expect(result).toBeDefined();
    });

    it("renders a truncated result", () => {
      const tool = createTool();
      const result = tool.renderResult(
        {
          content: [{ type: "text", text: "content" }],
          details: {
            url: "https://example.com/",
            truncated: true,
            contentLength: 50000,
            type: "web",
          },
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
          details: {
            url: "https://example.com/",
            summarized: true,
            contentLength: 10000,
            type: "web",
          },
        },
        { isPartial: false },
        mockTheme,
      );
      expect(result).toBeDefined();
    });
  });

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
      ).rejects.toThrow(
        "Blocked: resolved IP for evil.example.com is internal/private.",
      );

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

  // --- Redirect Loop Exhaustion (Todo #14) ---

  describe("redirect loop exhaustion", () => {
    it("stops after >10 consecutive redirects and throws an error", async () => {
      const tool = createTool();

      // Return 12 consecutive 301 redirects — more than MAX_REDIRECTS (10)
      for (let i = 0; i < 12; i++) {
        mockFetch.mockResolvedValueOnce({
          status: 301,
          statusText: "Moved Permanently",
          ok: false,
          headers: new Headers({ location: `https://example.com/redirect-${i + 1}` }),
          url: `https://example.com/redirect-${i}`,
          body: null,
          bodyUsed: false,
        });
      }

      await expect(
        tool.execute(
          "call-1",
          { url: "https://example.com/start" },
          undefined,
          undefined,
          createContext(),
        ),
      ).rejects.toThrow(/HTTP 301/);

      // The loop runs MAX_REDIRECTS+1 = 11 iterations (i=0..10), so fetch is called 11 times
      expect(mockFetch).toHaveBeenCalledTimes(11);
    });

    it("does not infinite loop on redirect chains", async () => {
      const tool = createTool();

      // Return a very large number of redirects to confirm bounded behavior
      for (let i = 0; i < 100; i++) {
        mockFetch.mockResolvedValueOnce({
          status: 302,
          statusText: "Found",
          ok: false,
          headers: new Headers({ location: `https://example.com/r${i + 1}` }),
          url: `https://example.com/r${i}`,
          body: null,
          bodyUsed: false,
        });
      }

      // Must resolve quickly (not hang) and throw an error
      const resultPromise = tool.execute(
        "call-1",
        { url: "https://example.com/start" },
        undefined,
        undefined,
        createContext(),
      );

      // Use a timeout to ensure it doesn't hang
      await expect(
        Promise.race([
          resultPromise
            .then(() => {
              return "resolved";
            })
            .catch(() => {
              return "rejected";
            }),
          new Promise<string>((resolve) => {
            setTimeout(() => {
              resolve("timeout");
            }, 5000);
          }),
        ]),
      ).resolves.toBe("rejected");

      // Verify fetch was called a bounded number of times (11, not 100)
      expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(11);
    });
  });

  // --- Branch Parameter Injection (Todo #15) ---

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
      const execCall = mockExec.mock.calls[0];
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

      const execArgs = mockExec.mock.calls[0][1] as string[];
      expect(execArgs).not.toContain("--branch");
    });
  });

  // --- Branch Validation (HIGH Security Issue Fix) ---

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

  // --- readResponseWithSizeLimit Edge Cases (Todo #16) ---

  describe("readResponseWithSizeLimit edge cases", () => {
    it("handles response with null body gracefully", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        ok: true,
        headers: new Headers({ "content-type": "text/plain" }),
        url: "https://example.com/empty",
        body: null,
        bodyUsed: false,
      });

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/empty" },
        undefined,
        undefined,
        createContext(),
      );

      // Should not throw; should return a result with empty-ish content
      expect(result).toBeDefined();
      expect(result.content[0].text).toBeDefined();
    });

    it("handles response with empty stream body", async () => {
      const tool = createTool();
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        ok: true,
        headers: new Headers({ "content-type": "text/plain" }),
        url: "https://example.com/empty-stream",
        body: emptyStream,
        bodyUsed: false,
      });

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/empty-stream" },
        undefined,
        undefined,
        createContext(),
      );

      expect(result).toBeDefined();
      expect(result.content[0].text).toBeDefined();
    });
  });

  // --- Empty Content-Type Header (Todo #17) ---

  describe("empty content-type header", () => {
    it("handles empty content-type as generic raw content", async () => {
      const tool = createTool();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          contentType: "",
          body: "Some raw content",
        }),
      );

      const result = await tool.execute(
        "call-1",
        { url: "https://example.com/raw" },
        undefined,
        undefined,
        createContext(),
      );

      // Empty content-type falls through to the else branch which renders raw content
      expect(result.content[0].text).toContain("Some raw content");
      // Should NOT be wrapped in a code block (that's for text/plain / JSON)
      expect(result.content[0].text).not.toContain("Text Response");
      expect(result.content[0].text).not.toContain("JSON Response");
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

  // --- Repo edge cases: parseRepoUrl returns null (execute-repo-fetch line 59) ---

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

  // --- Repo edge cases: path traversal (execute-repo-fetch line 66) ---

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
  });

  // --- Repo edge cases: symlink protection (execute-repo-fetch line 85) ---

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
