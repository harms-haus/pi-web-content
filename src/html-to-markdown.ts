/**
 * HTML-to-Markdown conversion utilities.
 *
 * Extracted from fetch-content.ts for reuse across tools.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// Singleton TurndownService instance — safe to reuse across requests
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
});

turndownService.use(gfm);
turndownService.remove(["script", "style", "iframe", "noscript"]);

export const BINARY_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "application/zip",
  "application/octet-stream",
  "application/x-gzip",
  "application/x-tar",
];

export interface HtmlToMarkdownResult {
  title: string;
  markdown: string;
}

export function htmlToMarkdown(html: string, url: string): HtmlToMarkdownResult {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  let title: string;
  let contentHtml: string;

  if (article) {
    title = article.title || url;
    contentHtml = article.content ?? "";
  } else {
    // Readability failed — probably not an article page.
    // Fall back to converting the full body.
    title = dom.window.document.title || url;
    const body = dom.window.document.body;
    contentHtml = body ? body.innerHTML : html;
  }

  const markdown = turndownService.turndown(contentHtml);

  // Clean up jsdom window to free memory
  dom.window.close();

  return { title, markdown };
}
