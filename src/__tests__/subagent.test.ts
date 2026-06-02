import { describe, expect, it, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";
import type { ChildProcess } from "node:child_process";

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
  const proc = new EventEmitter() as ChildProcess;

  Object.defineProperty(proc, "stdout", { value: stdout, writable: true });
  Object.defineProperty(proc, "stderr", { value: stderr, writable: true });
  Object.defineProperty(proc, "killed", { value: false, writable: true });
  Object.defineProperty(proc, "kill", { value: vi.fn(), writable: true });

  return proc as unknown as ChildProcess & {
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
    provider: "openai",
    model: "gpt-4",
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    } as unknown as Usage,
    stopReason: "end_turn" as unknown as StopReason,
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

      const resultPromise = runSubagent("test task", tmpdir());

      // Simulate stdout with a message_end event
      const message = createAssistantMessage("Hello from subagent");

      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`),
      );
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Hello from subagent");
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it("handles multiple messages and returns the last assistant text", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      const msg1 = createAssistantMessage("First message");
      const msg2 = createAssistantMessage("Second message");

      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message: msg1 })}\n`),
      );
      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message: msg2 })}\n`),
      );
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Second message");
    });

    it("handles tool_result_end events", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      const toolResult: Message = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file content" }],
        isError: false,
      } as Message;

      const assistantMsg = createAssistantMessage("Done");

      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "tool_result_end", message: toolResult })}\n`),
      );
      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message: assistantMsg })}\n`),
      );
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Done");
    });

    it("handles chunked data across multiple events", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

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

      const resultPromise = runSubagent("test task", tmpdir());

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

      const resultPromise = runSubagent("test task", tmpdir());

      const message = createAssistantMessage("Valid message");

      proc.stdout.emit("data", Buffer.from(`not valid json\n`));
      proc.stdout.emit("data", Buffer.from("{incomplete\n"));
      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`),
      );
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Valid message");
    });

    it("ignores unknown event types", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      const message = createAssistantMessage("Final output");

      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "unknown_event", data: "stuff" })}\n`),
      );
      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`),
      );
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.text).toBe("Final output");
    });

    it("spawns with correct arguments", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      proc.emit("close", 0);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "--mode",
          "json",
          "-p",
          "--no-session",
          expect.stringContaining("test task"),
        ]),
        { cwd: tmpdir(), shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
    });
  });

  // --- Error handling ---

  describe("error handling", () => {
    it("returns error on non-zero exit code with no output", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

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

      const resultPromise = runSubagent("test task", tmpdir());

      proc.emit("error", new Error("spawn ENOENT"));

      const result = await resultPromise;

      expect(result.text).toBe("");
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain("Subagent process error");
    });

    it("handles error event with stderr truncation", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      // First, fill stderr past the limit
      proc.stderr.emit("data", Buffer.from("x".repeat(70000)));
      // Then emit an error — the error handler should skip adding to stderr since it's truncated
      proc.emit("error", new Error("spawn ENOENT"));

      const result = await resultPromise;

      expect(result.stderr).toContain("[stderr truncated]");
    });

    it("handles error event that causes stderr truncation", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      // Fill stderr close to the limit
      proc.stderr.emit("data", Buffer.from("x".repeat(65000)));
      // Error message pushes it over the limit
      proc.emit("error", new Error("some error"));

      const result = await resultPromise;

      // The error message in stderr should be present (possibly truncated)
      expect(result.exitCode).toBe(1);
    });

    it("returns text even on non-zero exit code if output exists", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      const message = createAssistantMessage("Partial output");

      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`),
      );
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

      const resultPromise = runSubagent("test task", tmpdir(), controller.signal);

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

      const resultPromise = runSubagent("test task", tmpdir(), controller.signal);

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

      const resultPromise = runSubagent("test task", tmpdir(), controller.signal);

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

    it("on Windows, kills process immediately without SIGKILL fallback", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const abortController = new AbortController();

      const resultPromise = runSubagent("test task", tmpdir(), abortController.signal);

      // Trigger abort
      abortController.abort();

      // Verify proc.kill was called once (no signal argument on Windows)
      expect(proc.kill).toHaveBeenCalledTimes(1);
      expect(proc.kill).toHaveBeenCalledWith();

      // Advance timers and verify NO second kill call
      vi.advanceTimersByTime(6000);
      expect(proc.kill).toHaveBeenCalledTimes(1);

      proc.emit("close", 1);
      const result = await resultPromise;

      expect(result.error).toBe("Subagent was aborted");

      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    });
  });

  // --- Stderr capture ---

  describe("stderr capture", () => {
    it("captures stderr output", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      proc.stderr.emit("data", Buffer.from("warning: some warning\n"));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.stderr).toContain("warning: some warning");
    });

    it("handles multiple stderr chunks", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      proc.stderr.emit("data", Buffer.from("chunk1 "));
      proc.stderr.emit("data", Buffer.from("chunk2 "));
      proc.stderr.emit("data", Buffer.from("chunk3\n"));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.stderr).toBe("chunk1 chunk2 chunk3\n");
    });

    it("truncates stderr when it exceeds MAX_STDERR_LENGTH", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      // MAX_STDERR_LENGTH = 64 * 1024 = 65536
      // Send a chunk that exceeds the limit
      proc.stderr.emit("data", Buffer.from("x".repeat(70000)));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.stderr).toContain("[stderr truncated]");
    });

    it("stops capturing stderr after truncation", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());

      // First chunk triggers truncation
      proc.stderr.emit("data", Buffer.from("x".repeat(70000)));
      // This chunk should be ignored because stderrTruncated is true
      proc.stderr.emit("data", Buffer.from("SHOULD_NOT_APPEAR"));
      proc.emit("close", 0);

      const result = await resultPromise;

      expect(result.stderr).toContain("[stderr truncated]");
      expect(result.stderr).not.toContain("SHOULD_NOT_APPEAR");
    });
  });

  // --- getPiInvocation logic (indirectly tested via spawn args) ---

  describe("getPiInvocation", () => {
    it("passes task text as last argument", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("my specific task", tmpdir());

      proc.emit("close", 0);
      await resultPromise;

      const callArgs = mockSpawn.mock.calls[0]![1] as string[];
      const lastArg = callArgs[callArgs.length - 1]!;
      expect(lastArg).toContain("my specific task");
    });

    it("uses execPath directly when basename is not a generic runtime (e.g. 'pi')", async () => {
      const originalExecPath = process.execPath;
      const originalArgv1 = process.argv[1];
      Object.defineProperty(process, "execPath", {
        value: "/usr/local/bin/pi",
        configurable: true,
      });
      // Ensure argv[1] is falsy so branch 1 is skipped
      Object.defineProperty(process, "argv", { value: ["node"], configurable: true });

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());
      proc.emit("close", 0);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "/usr/local/bin/pi",
        expect.arrayContaining(["--mode", "json", "-p", "--no-session"]),
        expect.any(Object),
      );

      Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
      Object.defineProperty(process, "argv", {
        value: [process.execPath, originalArgv1],
        configurable: true,
      });
    });

    it("uses execPath with script when execPath is 'node' and script exists", async () => {
      const originalExecPath = process.execPath;
      const originalArgv = process.argv;
      const scriptPath = "/path/to/pi-script.js";
      Object.defineProperty(process, "execPath", {
        value: "/usr/local/bin/node",
        configurable: true,
      });
      Object.defineProperty(process, "argv", {
        value: ["/usr/local/bin/node", scriptPath],
        configurable: true,
      });
      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(true);

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());
      proc.emit("close", 0);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "/usr/local/bin/node",
        expect.arrayContaining([scriptPath, "--mode", "json", "-p", "--no-session"]),
        expect.any(Object),
      );
      // Script should be the first arg
      const callArgs = mockSpawn.mock.calls[0]![1] as string[];
      expect(callArgs[0]!).toBe(scriptPath);

      Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
      Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it("falls back to 'pi' when execPath is 'node' and script does not exist", async () => {
      const originalExecPath = process.execPath;
      const originalArgv = process.argv;
      Object.defineProperty(process, "execPath", {
        value: "/usr/local/bin/node",
        configurable: true,
      });
      Object.defineProperty(process, "argv", {
        value: ["/usr/local/bin/node", "/nonexistent/script.js"],
        configurable: true,
      });
      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(false);

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());
      proc.emit("close", 0);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "pi",
        expect.arrayContaining(["--mode", "json", "-p", "--no-session"]),
        expect.any(Object),
      );

      Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
      Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    });

    it("returns useShell: true on Windows for generic runtime fallback", async () => {
      const originalPlatform = process.platform;
      const originalExecPath = process.execPath;
      const originalArgv = process.argv;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      Object.defineProperty(process, "execPath", {
        value: "C:/Program Files/nodejs/node.exe",
        configurable: true,
      });
      Object.defineProperty(process, "argv", {
        value: ["C:/Program Files/nodejs/node.exe", "C:/nonexistent/script.js"],
        configurable: true,
      });
      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(false);

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const resultPromise = runSubagent("test task", tmpdir());
      proc.emit("close", 0);
      await resultPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "pi",
        expect.arrayContaining(["--mode", "json", "-p", "--no-session"]),
        expect.objectContaining({ shell: true }),
      );

      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
      Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    });

    it("passes args as an array (not concatenated string) when shell is true", async () => {
      // Security: When shell: true, args MUST be an array so that Node.js
      // shell-escapes each argument individually. A single concatenated
      // string would allow cmd.exe to interpret special characters in the
      // task prompt (e.g. &, |, >).
      const originalPlatform = process.platform;
      const originalExecPath = process.execPath;
      const originalArgv = process.argv;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      Object.defineProperty(process, "execPath", {
        value: "C:/Program Files/nodejs/node.exe",
        configurable: true,
      });
      Object.defineProperty(process, "argv", {
        value: ["C:/Program Files/nodejs/node.exe", "C:/nonexistent/script.js"],
        configurable: true,
      });
      const { existsSync } = await import("node:fs");
      vi.mocked(existsSync).mockReturnValue(false);

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const maliciousTask = "task & echo PWNED | del /f important.txt > nul";
      const resultPromise = runSubagent(maliciousTask, tmpdir());
      proc.emit("close", 0);
      await resultPromise;

      // Verify the second argument to spawn is an actual Array
      const spawnArgs = mockSpawn.mock.calls[0]![1] as unknown;
      expect(Array.isArray(spawnArgs)).toBe(true);

      // Verify shell: true was used
      const spawnOpts = mockSpawn.mock.calls[0]![2] as { shell: boolean };
      expect(spawnOpts.shell).toBe(true);

      // The malicious task text should appear verbatim as a single array element,
      // not split across multiple elements or concatenated into the command string.
      const command = mockSpawn.mock.calls[0]![0] as string;
      expect(command).toBe("pi"); // command is just "pi", not "pi <args>"

      // The task prompt should be contained in one of the array args
      const lastArg = (spawnArgs as string[])[(spawnArgs as string[]).length - 1]!;
      expect(lastArg).toContain(maliciousTask);

      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
      Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    });
  });
});
