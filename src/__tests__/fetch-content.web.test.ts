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

import * as detectRepoUrl from "../detect-repo-url.js";
// Import after mocks are set up
import { createFetchContentTool } from "../fetch-content.js";
import * as ssrf from "../ssrf.js";

describe("fetch_content tool — web", () => {
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
      expect(result.content[0]!.text).toContain("JSON Response");
      expect(result.content[0]!.text).toContain('"key": "value"');
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
      expect(result.content[0]!.text).toContain("Text Response");
      expect(result.content[0]!.text).toContain("Hello plain text");
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
      expect(result.content[0]!.text).toContain("Test Page");
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
      expect(result.content[0]!.text).toContain("Text Response");
      expect(result.content[0]!.text).toContain("a,b,c");
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
      expect(result.content[0]!.text).toContain("https://example.com/final");
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

  // --- Redirect Loop Exhaustion ---

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

  // --- readResponseWithSizeLimit Edge Cases ---

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
      expect(result.content[0]!.text).toBeDefined();
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
      expect(result.content[0]!.text).toBeDefined();
    });
  });

  // --- Empty Content-Type Header ---

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
      expect(result.content[0]!.text).toContain("Some raw content");
      // Should NOT be wrapped in a code block (that's for text/plain / JSON)
      expect(result.content[0]!.text).not.toContain("Text Response");
      expect(result.content[0]!.text).not.toContain("JSON Response");
    });
  });
});
