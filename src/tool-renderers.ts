/**
 * Shared TUI rendering helpers for tool call/result display.
 *
 * Extracted from duplicated renderCall/renderResult methods in
 * fetch-content.ts and fetch-repo.ts.
 */

import type { FetchContentDetails } from "./types.js";
import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";

/**
 * Truncates a string to maxLen characters, appending '...' if truncated.
 */
export function truncateForDisplay(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Builds the TUI display text for a tool call.
 *
 * Shows bold tool name + colored URL (truncated at 60 chars) +
 * optional dim summarize preview (truncated at 40 chars).
 */
export function renderToolCall(
  toolName: string,
  args: { url?: string; summarize?: string },
  theme: Theme,
): string {
  const url: string = args.url || "...";
  const shortUrl = truncateForDisplay(url, 60);
  let text = theme.fg("toolTitle", theme.bold(`${toolName} `));
  text += theme.fg("accent", shortUrl);
  if (args.summarize) {
    const preview = truncateForDisplay(args.summarize, 40);
    text += theme.fg("dim", ` — ${preview}`);
  }
  return text;
}

/**
 * Options controlling which detail fields are shown in the result display.
 */
interface RenderToolResultOptions {
  /** Display a URL in accent color */
  showUrl?: string;
  /** Display owner/repo in accent color as "owner/repo" */
  showOwnerRepo?: { owner: string; repo: string };
  /** Display "(truncated)" in warning color */
  showTruncated?: boolean;
  /** Display "(summarized)" in muted color */
  showSummarized?: boolean;
  /** Display content length in dim color */
  showContentLength?: number;
  /** Display a target path in dim color with arrow */
  showTargetPath?: string;
}

/**
 * Builds the TUI display text for a tool result.
 *
 * Shows ✓/✗ icon, identity, and status badges based on the provided options.
 */
// eslint-disable-next-line complexity -- multi-branch content rendering for repo/web/summarize/binary
export function renderToolResult(
  result: { isError?: boolean },
  details: FetchContentDetails | undefined,
  { isPartial }: { isPartial?: boolean },
  theme: Theme,
  options?: RenderToolResultOptions,
): string {
  if (isPartial) {
    return theme.fg("warning", "Processing...");
  }

  const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  let text = icon;

  if (options?.showUrl) {
    text += ` ${theme.fg("accent", options.showUrl)}`;
  }

  if (options?.showOwnerRepo) {
    const { owner, repo } = options.showOwnerRepo;
    text += ` ${theme.fg("accent", `${owner}/${repo}`)}`;
  }

  // Title from details (used by fetch_content)
  if (details?.title) {
    text += ` ${theme.fg("dim", `— ${details.title}`)}`;
  }

  if (options?.showSummarized) {
    text += ` ${theme.fg("muted", "(summarized)")}`;
  }

  if (options?.showTruncated) {
    text += ` ${theme.fg("warning", "(truncated)")}`;
  }

  if (options?.showContentLength !== undefined) {
    text += ` ${theme.fg("dim", `(${formatSize(options.showContentLength)})`)}`;
  }

  if (options?.showTargetPath) {
    text += ` ${theme.fg("dim", `→ ${options.showTargetPath}`)}`;
  }

  return text;
}
