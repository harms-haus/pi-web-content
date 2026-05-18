import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeWithSubagent } from "../summarize.js";

// Mock the subagent module
vi.mock("../subagent.js", () => ({
  runSubagent: vi.fn(),
}));

// Mock node:crypto for deterministic UUID
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-0000-0000-000000000000"),
}));

import { runSubagent } from "../subagent.js";

const mockedRunSubagent = vi.mocked(runSubagent);

describe("summarizeWithSubagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onUpdate with 'summarizing' status", async () => {
    const updates: Array<{
      content: Array<{ type: string; text: string }>;
      details: { status: string };
    }> = [];
    mockedRunSubagent.mockResolvedValue({ text: "summary", exitCode: 0, stderr: "" });

    await summarizeWithSubagent({
      content: "some content",
      summarize: "extract key points",
      roleContext: "You are summarizing.",
      cwd: "/tmp",
      onUpdate: (update) => {
        updates.push(update);
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].details.status).toBe("summarizing");
    expect(updates[0].content[0].text).toContain("Summarizing");
  });

  it("constructs prompt with content and user instruction", async () => {
    mockedRunSubagent.mockResolvedValue({ text: "summary", exitCode: 0, stderr: "" });

    await summarizeWithSubagent({
      content: "the full article text here",
      summarize: "give me the main points",
      roleContext: "You are summarizing content from a web page.",
      url: "https://example.com",
      title: "Example Page",
      cwd: "/tmp",
    });

    expect(mockedRunSubagent).toHaveBeenCalledTimes(1);
    const taskPrompt = mockedRunSubagent.mock.calls[0][0];

    // Verify role context
    expect(taskPrompt).toContain("You are summarizing content from a web page.");
    // Verify URL
    expect(taskPrompt).toContain("URL: https://example.com");
    // Verify title
    expect(taskPrompt).toContain("Title: Example Page");
    // Verify content
    expect(taskPrompt).toContain("the full article text here");
    // Verify user instruction
    expect(taskPrompt).toContain("User's instruction: give me the main points");
  });

  it("throws error when subResult.error is set", async () => {
    mockedRunSubagent.mockResolvedValue({
      text: "",
      exitCode: 1,
      stderr: "something went wrong",
      error: "Subagent exited with code 1",
    });

    await expect(
      summarizeWithSubagent({
        content: "content",
        summarize: "summarize",
        roleContext: "role",
        cwd: "/tmp",
      }),
    ).rejects.toThrow("Summarization failed: Subagent exited with code 1");
  });

  it("returns successful result", async () => {
    mockedRunSubagent.mockResolvedValue({
      text: "Here is the summary",
      exitCode: 0,
      stderr: "",
    });

    const result = await summarizeWithSubagent({
      content: "content",
      summarize: "summarize",
      roleContext: "role",
      cwd: "/tmp",
    });

    expect(result.summarized).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Here is the summary" }]);
    expect(result.summarizePrompt).toBe("summarize");
  });

  it("uses crypto UUID delimiter in prompt", async () => {
    mockedRunSubagent.mockResolvedValue({ text: "summary", exitCode: 0, stderr: "" });

    await summarizeWithSubagent({
      content: "content",
      summarize: "summarize",
      roleContext: "role",
      cwd: "/tmp",
    });

    const taskPrompt = mockedRunSubagent.mock.calls[0][0];
    expect(taskPrompt).toContain("---CONTENT_BOUNDARY_00000000-0000-0000-0000-000000000000---");
  });

  it("returns fallback text when subagent returns empty text", async () => {
    mockedRunSubagent.mockResolvedValue({ text: "", exitCode: 0, stderr: "" });

    const result = await summarizeWithSubagent({
      content: "content",
      summarize: "summarize",
      roleContext: "role",
      cwd: "/tmp",
    });

    expect(result.content[0].text).toBe("(no summary produced)");
  });

  it("omits URL and title from prompt when not provided", async () => {
    mockedRunSubagent.mockResolvedValue({ text: "summary", exitCode: 0, stderr: "" });

    await summarizeWithSubagent({
      content: "content",
      summarize: "summarize",
      roleContext: "role",
      cwd: "/tmp",
    });

    const taskPrompt = mockedRunSubagent.mock.calls[0][0];
    expect(taskPrompt).not.toContain("URL:");
    expect(taskPrompt).not.toContain("Title:");
  });
});
