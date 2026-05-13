import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message } from "@earendil-works/pi-ai";

// --- Mocks ---

const { spawn: mockSpawn } = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// Import after mocks are set up
import { runSubagent } from "../subagent.js";

function createMockProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;

  Object.defineProperty(proc, "stdout", { value: stdout, writable: true });
  Object.defineProperty(proc, "stderr", { value: stderr, writable: true });
  Object.defineProperty(proc, "killed", { value: false, writable: true });
  Object.defineProperty(proc, "kill", { value: vi.fn(), writable: true });

  return proc as unknown as ReturnType<typeof import("node:child_process").spawn> & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
}

function createAssistantMessage(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai" as string,
    provider: "openai" as string,
    model: "gpt-4",
    usage: { inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 } as unknown as import("@earendil-works/pi-ai").Usage,
    stopReason: "end_turn" as unknown as import("@earendil-works/pi-ai").StopReason,
    timestamp: Date.now(),
  };
}

describe("subagent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  // --- Successful subagent run ---

  describe("runSubagent", () => {
    it("returns text output on successful run", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      // Simulate stdout with a message_end event
      const message = createAssistantMessage("Hello from subagent");

      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Hello from subagent");
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it("handles multiple messages and returns the last assistant text", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const msg1 = createAssistantMessage("First message");
      const msg2 = createAssistantMessage("Second message");

      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: msg1 })}\n`));
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: msg2 })}\n`));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Second message");
    });

    it("handles tool_result_end events", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const toolResult: Message = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file content" }],
        isError: false,
      } as Message;

      const assistantMsg = createAssistantMessage("Done");

      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "tool_result_end", message: toolResult })}\n`));
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: assistantMsg })}\n`));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Done");
    });

    it("handles chunked data across multiple events", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const message = createAssistantMessage("Chunked response");

      const jsonLine = `${JSON.stringify({ type: "message_end", message })}\n`;
      // Split into two chunks
      const midPoint = Math.floor(jsonLine.length / 2);
      proc.stdout.emit("data", Buffer.from(jsonLine.slice(0, midPoint)));
      proc.stdout.emit("data", Buffer.from(jsonLine.slice(midPoint)));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Chunked response");
    });

    it("handles partial line at end of stream", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const message = createAssistantMessage("No trailing newline");

      // No trailing newline - should still be processed on close
      proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message })));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("No trailing newline");
    });

    it("ignores invalid JSON lines", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const message = createAssistantMessage("Valid message");

      proc.stdout.emit("data", Buffer.from(`not valid json\n`));
      proc.stdout.emit("data", Buffer.from("{incomplete\n"));
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Valid message");
    });

    it("ignores unknown event types", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const message = createAssistantMessage("Final output");

      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "unknown_event", data: "stuff" })}\n`));
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Final output");
    });

    it("spawns with correct arguments", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      proc.emit("close", 0);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["--mode", "json", "-p", "--no-session", expect.stringContaining("test task")]),
        { cwd: "/tmp", shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("returns error on non-zero exit code with no output", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      proc.stderr.emit("data", Buffer.from("Some error output\n"));
      proc.emit("close", 1);

      const result = await resultPromise;

      expect(result.text).toBe("");
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain("Subagent exited with code 1");
      expect(result.stderr).toContain("Some error output");
    });

    it("returns error on process error event", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      proc.emit("error", new Error("spawn ENOENT"));

      const result = await resultPromise;

      expect(result.text).toBe("");
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain("Subagent process error");
    });

    it("returns text even on non-zero exit code if output exists", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      const message = createAssistantMessage("Partial output");

      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`));
      proc.emit("close", 1);

      const result = await resultPromise;

      // Should return text since there is output, even with non-zero exit
      expect(result.text).toBe("Partial output");
      expect(result.exitCode).toBe(1);
      expect(result.error).toBeUndefined();
    });
  });

  // --- Abort signal handling ---

  describe("abort signal", () => {
    it("kills process when signal is already aborted", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const controller = new AbortController();
      controller.abort();

      const resultPromise = runSubagent("test task", "/tmp", controller.signal);

      // Process should be killed immediately
      vi.advanceTimersByTime(0);

      proc.emit("close", 1);
      const result = await resultPromise;

      expect(result.error).toBe("Subagent was aborted");
      expect(proc.kill).toHaveBeenCalled();
    });

    it("kills process when signal is aborted during execution", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const controller = new AbortController();

      const resultPromise = runSubagent("test task", "/tmp", controller.signal);

      // Abort the signal
      controller.abort();

      proc.emit("close", 1);
      const result = await resultPromise;

      expect(result.error).toBe("Subagent was aborted");
      expect(proc.kill).toHaveBeenCalled();
    });

    it("sends SIGKILL after delay if SIGTERM fails", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const controller = new AbortController();

      const resultPromise = runSubagent("test task", "/tmp", controller.signal);

      controller.abort();

      // First SIGTERM should be sent
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

      // Advance time past the 5 second delay
      vi.advanceTimersByTime(5000);

      // SIGKILL should be sent
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      proc.emit("close", 1);
      await resultPromise;
    });
  });

  // --- Stderr capture ---

  describe("stderr capture", () => {
    it("captures stderr output", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      proc.stderr.emit("data", Buffer.from("warning: some warning\n"));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.stderr).toContain("warning: some warning");
    });

    it("handles multiple stderr chunks", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", "/tmp");

      proc.stderr.emit("data", Buffer.from("chunk1 "));
      proc.stderr.emit("data", Buffer.from("chunk2 "));
      proc.stderr.emit("data", Buffer.from("chunk3\n"));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.stderr).toBe("chunk1 chunk2 chunk3\n");
    });
  });

  // --- getPiInvocation logic (indirectly tested via spawn args) ---

  describe("getPiInvocation", () => {
    it("passes task text as last argument", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("my specific task", "/tmp");

      proc.emit("close", 0);
      await resultPromise;

      const callArgs = mockSpawn.mock.calls[0][1] as string[];
      const lastArg = callArgs[callArgs.length - 1];
      expect(lastArg).toContain("my specific task");
    });
  });
});
