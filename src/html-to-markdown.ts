/**
 * HTML-to-Markdown conversion utilities.
 *
 * Extracted from fetch-content.ts for reuse across tools.
 */

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

interface HtmlToMarkdownResult {
  title: string;
  markdown: string;
}

export async function htmlToMarkdown(html: string, url: string): Promise<HtmlToMarkdownResult> {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");

  const virtualConsole = new VirtualConsole();

  const dom = new JSDOM(html, { url, virtualConsole });
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- body can be null in some JSDOM configurations
    contentHtml = body ? body.innerHTML : html;
  }

  const markdown = turndownService.turndown(contentHtml);

  // Clean up jsdom window to free memory
  dom.window.close();

  return { title, markdown };
}
