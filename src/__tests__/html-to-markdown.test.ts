import { describe, it, expect } from "vitest";
import { htmlToMarkdown, BINARY_TYPES } from "../html-to-markdown.js";

describe("htmlToMarkdown", () => {
  describe("simple HTML conversion", () => {
    it("converts headings to ATX-style markdown", async () => {
      const html = "<h1>Hello World</h1>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("# Hello World");
    });

    it("converts paragraphs", async () => {
      const html = "<p>This is a paragraph.</p>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("This is a paragraph.");
    });

    it("converts bold text", async () => {
      const html = "<p>This is <strong>bold</strong> text.</p>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("**bold**");
    });

    it("converts italic text", async () => {
      const html = "<p>This is <em>italic</em> text.</p>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("*italic*");
    });

    it("converts links", async () => {
      const html = '<p>Visit <a href="https://example.com">Example</a></p>';
      const result = await htmlToMarkdown(html, "https://example.com");
      // Turndown normalizes URLs, adding trailing slash
      expect(result.markdown).toContain("[Example](https://example.com/)");
    });

    it("converts unordered lists", async () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
      const result = await htmlToMarkdown(html, "https://example.com");
      // Turndown uses "-   " (dash + spaces) for list items
      expect(result.markdown).toContain("Item 1");
      expect(result.markdown).toContain("Item 2");
      expect(result.markdown).toMatch(/^-/m);
    });

    it("converts code blocks", async () => {
      const html = "<pre><code>const x = 1;</code></pre>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("```");
      expect(result.markdown).toContain("const x = 1;");
    });

    it("converts inline code", async () => {
      const html = "<p>Use the <code>console.log</code> function.</p>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("`console.log`");
    });
  });

  describe("article with title extraction", () => {
    it("extracts title from article content", async () => {
      const html = `
        <html>
          <head><title>My Article Title</title></head>
          <body>
            <article>
              <h1>My Article Title</h1>
              <p>This is the article content.</p>
            </article>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com/article");
      expect(result.title).toBe("My Article Title");
      expect(result.markdown).toContain("article content");
    });

    it("extracts content from article element", async () => {
      const html = `
        <html>
          <head><title>Test</title></head>
          <body>
            <article>
              <h2>Article Heading</h2>
              <p>Article body text here.</p>
            </article>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("Article body text here.");
    });
  });

  describe("non-article page fallback", () => {
    it("falls back to body when Readability cannot parse", async () => {
      const html = `
        <html>
          <head><title>Fallback Title</title></head>
          <body>
            <div>
              <p>Some content without article structure.</p>
            </div>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("Some content without article structure.");
    });

    it("uses URL as fallback title when no title available", async () => {
      const html = `
        <html>
          <head></head>
          <body>
            <p>Content without title.</p>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com/page");
      expect(result.title).toBe("https://example.com/page");
    });
  });

  describe("scripts and styles removed", () => {
    it("removes script tags", async () => {
      const html = `
        <html>
          <body>
            <p>Visible content</p>
            <script>alert('xss');</script>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).not.toContain("alert");
      expect(result.markdown).not.toContain("<script>");
    });

    it("removes style tags", async () => {
      const html = `
        <html>
          <body>
            <p>Visible content</p>
            <style>body { display: none; }</style>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).not.toContain("display: none");
      expect(result.markdown).not.toContain("<style>");
    });

    it("removes iframe tags", async () => {
      const html = `
        <html>
          <body>
            <p>Visible content</p>
            <iframe src="https://evil.com"></iframe>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).not.toContain("iframe");
      expect(result.markdown).not.toContain("evil.com");
    });

    it("removes noscript tags", async () => {
      const html = `
        <html>
          <body>
            <p>Visible content</p>
            <noscript>Enable JavaScript</noscript>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).not.toContain("noscript");
    });
  });

  describe("GFM tables", () => {
    it("converts HTML tables to GFM markdown", async () => {
      const html = `
        <table>
          <thead>
            <tr><th>Header 1</th><th>Header 2</th></tr>
          </thead>
          <tbody>
            <tr><td>Cell 1</td><td>Cell 2</td></tr>
            <tr><td>Cell 3</td><td>Cell 4</td></tr>
          </tbody>
        </table>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.markdown).toContain("|");
      expect(result.markdown).toContain("Header 1");
      expect(result.markdown).toContain("Header 2");
      expect(result.markdown).toContain("Cell 1");
      expect(result.markdown).toContain("Cell 2");
    });
  });

  describe("empty and malformed HTML", () => {
    it("handles empty HTML string", async () => {
      const result = await htmlToMarkdown("", "https://example.com");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("markdown");
    });

    it("handles HTML with only whitespace", async () => {
      const result = await htmlToMarkdown("   ", "https://example.com");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("markdown");
    });

    it("handles malformed HTML gracefully", async () => {
      const html = "<p>Unclosed paragraph<div>Another unclosed";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("markdown");
    });

    it("handles HTML with only script tags", async () => {
      const html = "<script>alert('hi');</script>";
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("markdown");
      expect(result.markdown).not.toContain("alert");
    });
  });

  describe("complex documents", () => {
    it("handles nested elements", async () => {
      const html = `
        <html>
          <head><title>Main Title</title></head>
          <body>
            <article>
              <h1>Main Title</h1>
              <p>Paragraph with <strong>bold <em>and italic</em></strong> text.</p>
              <ul>
                <li>First item</li>
                <li>Second item with <a href="https://example.com">a link</a></li>
              </ul>
            </article>
          </body>
        </html>
      `;
      const result = await htmlToMarkdown(html, "https://example.com");
      expect(result.title).toBe("Main Title");
      // Readability extracts the title separately; the h1 is not included in content
      expect(result.markdown).toContain("**bold");
      expect(result.markdown).toContain("*and italic*");
      expect(result.markdown).toContain("First item");
      expect(result.markdown).toContain("[a link]");
    });
  });
});

describe("BINARY_TYPES", () => {
  it("is an array", () => {
    expect(Array.isArray(BINARY_TYPES)).toBe(true);
  });

  it("covers image types", () => {
    expect(BINARY_TYPES).toContain("image/");
  });

  it("covers video types", () => {
    expect(BINARY_TYPES).toContain("video/");
  });

  it("covers audio types", () => {
    expect(BINARY_TYPES).toContain("audio/");
  });

  it("covers PDF", () => {
    expect(BINARY_TYPES).toContain("application/pdf");
  });

  it("covers ZIP", () => {
    expect(BINARY_TYPES).toContain("application/zip");
  });

  it("covers octet-stream", () => {
    expect(BINARY_TYPES).toContain("application/octet-stream");
  });

  it("covers gzip", () => {
    expect(BINARY_TYPES).toContain("application/x-gzip");
  });

  it("covers tar", () => {
    expect(BINARY_TYPES).toContain("application/x-tar");
  });

  it("has exactly 8 entries", () => {
    expect(BINARY_TYPES).toHaveLength(8);
  });
});
