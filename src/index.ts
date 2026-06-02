/**
 * pi-web-content extension
 *
 * Provides the fetch_content tool for pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./fetch-content.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createFetchContentTool(pi) as Parameters<typeof pi.registerTool>[0]);
}
