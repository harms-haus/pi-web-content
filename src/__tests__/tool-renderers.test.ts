import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderToolCall, renderToolResult, truncateForDisplay } from "../tool-renderers.js";

/**
 * Create a minimal mock Theme that wraps text with identifiable markers.
 * fg(color, text) => `[${color}:${text}]`
 * bold(text) => `[bold:${text}]`
 */
function createMockTheme(): Theme {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `[bold:${text}]`,
  } as unknown as Theme;
}

describe("truncateForDisplay", () => {
  it("returns short strings unchanged", () => {
    expect(truncateForDisplay("hello", 10)).toBe("hello");
  });

  it("truncates long strings with '...'", () => {
    const result = truncateForDisplay("this is a very long string", 10);
    expect(result).toBe("this is...");
    expect(result.length).toBe(10);
  });

  it("returns string unchanged at exact length boundary", () => {
    expect(truncateForDisplay("hello", 5)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(truncateForDisplay("", 5)).toBe("");
  });
});

describe("renderToolCall", () => {
  const theme = createMockTheme();

  it("renders tool name and URL", () => {
    const result = renderToolCall("fetch_content", { url: "https://example.com" }, theme);
    expect(result).toContain("fetch_content");
    expect(result).toContain("https://example.com");
  });

  it("truncates long URLs at 60 chars", () => {
    const longUrl = `https://example.com/${"a".repeat(100)}`;
    const result = renderToolCall("fetch_content", { url: longUrl }, theme);
    // The URL portion should be truncated to 60 chars
    expect(result.length).toBeLessThan(`[bold:fetch_content ][accent:${longUrl}]`.length);
  });

  it("shows summarize preview when present", () => {
    const result = renderToolCall(
      "fetch_content",
      { url: "https://example.com", summarize: "extract key points" },
      theme,
    );
    expect(result).toContain("extract key points");
  });

  it("truncates long summarize at 40 chars", () => {
    const longSummarize = "a".repeat(100);
    const result = renderToolCall("fetch_content", { url: "https://example.com", summarize: longSummarize }, theme);
    expect(result.length).toBeLessThan(
      `[bold:fetch_content ][accent:https://example.com][dim: — ${longSummarize}]`.length,
    );
  });
});

describe("renderToolResult", () => {
  const theme = createMockTheme();

  it("shows ✓ for success", () => {
    const result = renderToolResult({}, {}, { isPartial: false }, theme);
    expect(result).toContain("✓");
  });

  it("shows ✗ for error", () => {
    const result = renderToolResult({ isError: true }, {}, { isPartial: false }, theme);
    expect(result).toContain("✗");
  });

  it("shows 'Processing...' for partial", () => {
    const result = renderToolResult({}, {}, { isPartial: true }, theme);
    expect(result).toContain("Processing...");
  });

  it("shows URL in accent color", () => {
    const result = renderToolResult({}, {}, { isPartial: false }, theme, { showUrl: "https://example.com" });
    expect(result).toContain("https://example.com");
  });

  it("shows owner/repo in accent color", () => {
    const result = renderToolResult({}, {}, { isPartial: false }, theme, {
      showOwnerRepo: { owner: "myorg", repo: "myrepo" },
    });
    expect(result).toContain("myorg/myrepo");
  });

  it("shows status badges (truncated, summarized)", () => {
    const result = renderToolResult({}, {}, { isPartial: false }, theme, { showTruncated: true, showSummarized: true });
    expect(result).toContain("truncated");
    expect(result).toContain("summarized");
  });
});
