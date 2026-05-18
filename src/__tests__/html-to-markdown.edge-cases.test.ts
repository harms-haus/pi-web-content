/**
 * Edge case tests for htmlToMarkdown that require mocking Readability/JSDOM
 * to trigger defensive fallback branches (lines 50, 57).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Readability to control its output for edge case testing
const mockParseResult = vi.hoisted(() => ({
  value: null as {
    title: string | null;
    content: string | null;
    textContent: string | null;
    length: number;
    excerpt: string | null;
    byline: string | null;
    dir: string | null;
    siteName: string | null;
    lang: string | null;
  } | null,
}));

const mockBodyNull = vi.hoisted(() => ({ value: false }));

vi.mock("@mozilla/readability", () => ({
  Readability: class {
    parse() {
      return mockParseResult.value;
    }
  },
}));

vi.mock("jsdom", () => ({
  JSDOM: class {
    window: {
      document: {
        title: string;
        body: { innerHTML: string } | null;
      };
      close: () => void;
    };
    constructor(html: string, _opts: { url: string }) {
      const bodyHtml = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "";
      this.window = {
        document: {
          title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "",
          body: mockBodyNull.value ? null : { innerHTML: bodyHtml },
        },
        close: () => {},
      };
    }
  },
}));

import { htmlToMarkdown } from "../html-to-markdown.js";

describe("htmlToMarkdown edge cases (mocked Readability)", () => {
  beforeEach(() => {
    // Default: Readability returns null (no article)
    mockParseResult.value = null;
    mockBodyNull.value = false;
  });

  it("falls back to empty string when article.content is null", async () => {
    // Readability returns an article with null content
    mockParseResult.value = {
      title: "Test Article",
      content: null,
      textContent: "",
      length: 0,
      excerpt: "",
      byline: null,
      dir: null,
      siteName: null,
      lang: null,
    };

    const html = `
      <html>
        <head><title>Test Article</title></head>
        <body><article><p>Content here.</p></article></body>
      </html>
    `;
    const result = await htmlToMarkdown(html, "https://example.com/article");
    // When content is null, ?? "" kicks in, producing empty markdown
    expect(result.title).toBe("Test Article");
    expect(result.markdown).toBe("");
  });

  it("falls back to url when article.title is empty string", async () => {
    // Readability returns an article with empty title
    mockParseResult.value = {
      title: "",
      content: "<p>Some content</p>",
      textContent: "Some content",
      length: 12,
      excerpt: "",
      byline: null,
      dir: null,
      siteName: null,
      lang: null,
    };

    const html = `
      <html>
        <head><title></title></head>
        <body><article><p>Some content</p></article></body>
      </html>
    `;
    const result = await htmlToMarkdown(html, "https://example.com/no-title");
    // When title is empty string (falsy), falls back to URL
    expect(result.title).toBe("https://example.com/no-title");
    expect(result.markdown).toContain("Some content");
  });

  it("falls back to raw html when body is null", async () => {
    // Readability returns null (non-article path)
    mockParseResult.value = null;
    // Force body to be null
    mockBodyNull.value = true;

    const html = "<p>Raw HTML content</p>";
    const result = await htmlToMarkdown(html, "https://example.com/raw");
    // When body is null, falls back to converting the raw html input
    expect(result.markdown).toContain("Raw HTML content");
  });
});
