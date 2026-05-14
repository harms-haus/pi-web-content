/**
 * pi-web-content extension
 *
 * Provides the fetch_content tool for pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./fetch-content.js";

export default function (pi: ExtensionAPI) {
  // biome-ignore lint/suspicious/noExplicitAny: Tool objects use simplified renderCall/renderResult signatures that omit the optional `context` parameter from ToolDefinition; structural mismatch requires cast
  pi.registerTool(createFetchContentTool(pi) as any);
}
