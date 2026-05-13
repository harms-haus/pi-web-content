/**
 * Shared summarization helper
 *
 * Extracts the common summarization logic from fetch-content.ts and fetch-repo.ts
 * into a reusable function that delegates to a pi subagent.
 */

import { randomUUID } from "node:crypto";
import { runSubagent } from "./subagent.js";

export interface SummarizeOptions {
  /** The text content to summarize */
  content: string;
  /** User's instruction for summarization */
  summarize: string;
  /** Role context for the subagent (e.g., 'You are summarizing content from a web page.') */
  roleContext: string;
  /** URL for display in prompt */
  url?: string;
  /** Title for display in prompt */
  title?: string;
  /** Working directory for subagent */
  cwd: string;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Streaming updates callback */
  onUpdate?: (update: { content: Array<{ type: string; text: string }>; details: { status: string } }) => void;
}

export async function summarizeWithSubagent(options: SummarizeOptions): Promise<{
  content: Array<{ type: string; text: string }>;
  summarized: true;
  summarizePrompt: string;
}> {
  const { content, summarize, roleContext, url, title, cwd, signal, onUpdate } = options;

  // Notify that summarization has started
  onUpdate?.({
    content: [{ type: "text", text: "Summarizing content..." }],
    details: { status: "summarizing" },
  });

  // Build delimiter using crypto.randomUUID()
  const delimiter = `---CONTENT_BOUNDARY_${randomUUID()}---`;

  // Build the task prompt with role context, content, and user instruction
  const taskPrompt = [
    roleContext,
    url ? `URL: ${url}` : "",
    title ? `Title: ${title}` : "",
    "",
    delimiter,
    content,
    delimiter,
    "",
    `User's instruction: ${summarize}`,
    "",
    "Provide a focused response based on the user's instruction above.",
  ]
    .filter(Boolean)
    .join("\n");

  // Run the subagent
  const subResult = await runSubagent(taskPrompt, cwd, signal);

  // Check for errors
  if (subResult.error) {
    throw new Error(`Summarization failed: ${subResult.error}`);
  }

  return {
    content: [
      {
        type: "text",
        text: subResult.text || "(no summary produced)",
      },
    ],
    summarized: true,
    summarizePrompt: summarize,
  };
}
