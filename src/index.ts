/**
 * pi-web-content extension
 *
 * Provides fetch-content and fetch-repo tools for pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./fetch-content.js";
import { createFetchRepoTool } from "./fetch-repo.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createFetchContentTool(pi) as any);
  pi.registerTool(createFetchRepoTool(pi) as any);
}
