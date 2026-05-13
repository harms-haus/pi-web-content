/**
 * pi-web-content extension
 *
 * Provides fetch-content and fetch-repo tools for pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./fetch-content.js";
import { createFetchRepoTool } from "./fetch-repo.js";

export default function (pi: ExtensionAPI) {
  // biome-ignore lint/suspicious/noExplicitAny: Tool objects use simplified renderCall/renderResult signatures that omit the optional `context` parameter from ToolDefinition; structural mismatch requires cast
  pi.registerTool(createFetchContentTool(pi) as any);
  // biome-ignore lint/suspicious/noExplicitAny: Tool objects use simplified renderCall/renderResult signatures that omit the optional `context` parameter from ToolDefinition; structural mismatch requires cast
  pi.registerTool(createFetchRepoTool(pi) as any);
}
