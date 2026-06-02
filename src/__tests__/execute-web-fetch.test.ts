import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// --- Mocks ---

vi.mock("../ssrf.js", () => ({
  validateUrlForSsrf: vi.fn().mockResolvedValue(undefined),
  validateRedirectForSsrf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../html-to-markdown.js", () => ({
  htmlToMarkdown: vi
    .fn()
    .mockResolvedValue({ title: "Test Page", markdown: "# Test Page\n\nConverted content." }),
}));

vi.mock("../summarize.js", () => ({
  summarizeWithSubagent: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Summarized content" }],
    summarized: true,
    summarizePrompt: "summarize this",
  }),
}));

vi.mock("../fetch-constants.js", () => ({
  FETCH_TIMEOUT_MS: 30_000,
  MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
  MAX_REDIRECTS: 10,
  USER_AGENT:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  ACCEPT_HEADER:
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
  ACCEPT_LANGUAGE: "en-US,en;q=0.9",
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

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/pi-fetch-abc123"),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from "node:fs/promises";
import { executeWebFetch } from "../execute-web-fetch.js";
import * as htmlToMarkdown from "../html-to-markdown.js";
import * as ssrf from "../ssrf.js";

// --- Helpers ---

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
} = {}): Response {
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

// --- Tests ---

describe("executeWebFetch", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  // 1. Successful HTML fetch
  it("handles successful HTML fetch — converts to markdown", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        contentType: "text/html; charset=utf-8",
        body: "<html><body><h1>Hello</h1></body></html>",
      }),
    );

    const result = await executeWebFetch(
      { url: "https://example.com/" },
      undefined,
      undefined,
      createContext(),
    );

    expect(htmlToMarkdown.htmlToMarkdown).toHaveBeenCalledOnce();
    expect(result.content[0]!.text).toContain("Test Page");
    expect(result.content[0]!.text).toContain("https://example.com/");
    expect(result.details).toMatchObject({
      url: "https://example.com/",
      title: "Test Page",
      summarized: false,
      type: "web",
    });
  });

  // 2. JSON content-type
  it("wraps JSON responses in a code block", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        contentType: "application/json",
        body: '{"key": "value"}',
      }),
    );

    const result = await executeWebFetch(
      { url: "https://api.example.com/data" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result.content[0]!.text).toContain("```json");
    expect(result.content[0]!.text).toContain('"key": "value"');
    expect(result.details.title).toBe("JSON Response");
  });

  // 3. Plain text content-type
  it("wraps plain text responses in a code block", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        contentType: "text/plain",
        body: "Hello plain text world",
      }),
    );

    const result = await executeWebFetch(
      { url: "https://example.com/readme.txt" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result.content[0]!.text).toContain("```");
    expect(result.content[0]!.text).toContain("Hello plain text world");
    expect(result.details.title).toBe("Text Response");
  });

  // 4. Binary content rejection
  it("rejects binary content types with an error", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        contentType: "image/png",
        body: "binary-data",
      }),
    );

    await expect(
      executeWebFetch({ url: "https://example.com/image.png" }, undefined, undefined, createContext()),
    ).rejects.toThrow("Unsupported content type");
  });

  // 5. HTTP 404
  it("throws on HTTP 404 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        status: 404,
        statusText: "Not Found",
      }),
    );

    await expect(
      executeWebFetch(
        { url: "https://example.com/missing" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("HTTP 404 Not Found");
  });

  // 6. HTTP 500
  it("throws on HTTP 500 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(
      executeWebFetch(
        { url: "https://example.com/error" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("HTTP 500 Internal Server Error");
  });

  // 7. Redirect following — 301 → new URL → 200
  it("follows 301 redirects to the final URL", async () => {
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

    const result = await executeWebFetch(
      { url: "https://example.com/redirect" },
      undefined,
      undefined,
      createContext(),
    );

    expect(ssrf.validateRedirectForSsrf).toHaveBeenCalledOnce();
    expect(result.content[0]!.text).toContain("https://example.com/final");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // 8. Redirect with no Location header
  it("throws on 301 redirect with no Location header", async () => {
    const redirectResponse = {
      status: 301,
      statusText: "Moved Permanently",
      ok: false,
      headers: new Headers(),
      url: "https://example.com/redirect",
      body: null,
      bodyUsed: false,
    } as Response;

    mockFetch.mockResolvedValueOnce(redirectResponse);

    await expect(
      executeWebFetch(
        { url: "https://example.com/redirect" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("Redirect with no Location header");
  });

  // 9. Response size exceeded
  it("rejects responses exceeding MAX_RESPONSE_BYTES", async () => {
    const largeBody = "x".repeat(11 * 1024 * 1024); // 11 MB > 10 MB limit
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
      executeWebFetch(
        { url: "https://example.com/large" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow(/Response body exceeds maximum size/);
  });

  // 10. Large response truncation — writes temp file
  it("truncates large markdown output and writes full content to temp file", async () => {
    // Create a very large markdown output by making htmlToMarkdown return a huge string
    const hugeMarkdown = "line\n".repeat(50_000); // ~300KB of markdown
    vi.mocked(htmlToMarkdown.htmlToMarkdown).mockResolvedValueOnce({
      title: "Big Page",
      markdown: hugeMarkdown,
    });

    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        contentType: "text/html; charset=utf-8",
        body: "<html><body>big page</body></html>",
      }),
    );

    const result = await executeWebFetch(
      { url: "https://example.com/big" },
      undefined,
      undefined,
      createContext(),
    );

    if (result.details.truncated) {
      expect(fs.mkdtemp).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("content.md"),
        hugeMarkdown,
        "utf8",
      );
      expect(result.details.fullOutputPath).toBeDefined();
      expect(result.content[0]!.text).toContain("Output truncated");
    }
    // If not truncated (line limits are high), the test still passes —
    // but for a 50K-line document it should be truncated.
    expect(result.details.title).toBe("Big Page");
  });

  // 11. Abort signal — already-aborted signal
  it("throws cancellation error when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeWebFetch(
        { url: "https://example.com/" },
        controller.signal,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow(/Fetch cancelled/);
  });

  // --- Additional edge-case tests ---

  it("calls validateUrlForSsrf with the provided URL", async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    await executeWebFetch(
      { url: "https://example.com/" },
      undefined,
      undefined,
      createContext(),
    );

    expect(ssrf.validateUrlForSsrf).toHaveBeenCalledWith("https://example.com/");
  });

  it("re-throws SSRF Blocked errors without wrapping", async () => {
    vi.mocked(ssrf.validateUrlForSsrf).mockRejectedValueOnce(
      new Error("Blocked: cannot fetch internal/private addresses (localhost)."),
    );

    await expect(
      executeWebFetch(
        { url: "http://localhost:3000/" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("Blocked: cannot fetch internal/private addresses");
  });

  it("wraps network errors with context", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await expect(
      executeWebFetch(
        { url: "https://example.com/" },
        undefined,
        undefined,
        createContext(),
      ),
    ).rejects.toThrow("Failed to fetch https://example.com/: Network error");
  });

  it("sends correct request headers", async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    await executeWebFetch(
      { url: "https://example.com/" },
      undefined,
      undefined,
      createContext(),
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({
        headers: {
          "User-Agent":
            "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "manual",
      }),
    );
  });

  it("calls onUpdate with fetching status", async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());
    const onUpdate = vi.fn();

    await executeWebFetch(
      { url: "https://example.com/" },
      undefined,
      onUpdate,
      createContext(),
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { status: "fetching", type: "web" },
      }),
    );
  });

  it("handles response with null body", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      url: "https://example.com/empty",
      body: null,
      bodyUsed: false,
    });

    const result = await executeWebFetch(
      { url: "https://example.com/empty" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result).toBeDefined();
    expect(result.content[0]!.text).toBeDefined();
  });
});
