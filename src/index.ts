/**
 * pi-web-content extension
 *
 * Provides the fetch_content tool for pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFetchContentTool } from "./fetch-content.js";

export default function (pi: ExtensionAPI) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- registerTool generic type mismatch at extension boundary
  pi.registerTool(createFetchContentTool(pi) as any);
}
