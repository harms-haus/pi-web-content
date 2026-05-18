import { describe, it, expect, vi } from "vitest";

// Mock the dependency before importing
vi.mock("../fetch-content.js", () => ({
  createFetchContentTool: vi.fn().mockReturnValue({ name: "fetch_content" }),
}));

import defaultExport from "../index.js";

describe("index.ts", () => {
  it("registers the fetch_content tool once", () => {
    const mockRegisterTool = vi.fn();
    const mockPi = { registerTool: mockRegisterTool } as any;

    defaultExport(mockPi);

    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterTool).toHaveBeenCalledWith({ name: "fetch_content" });
  });
});
