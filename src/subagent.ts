/**
 * Pi subagent invocation
 *
 * Spawns pi as a subprocess to summarize or analyze content.
 * Adapted from the subagent example in pi-coding-agent.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

export interface SubagentResult {
  text: string;
  exitCode: number;
  stderr: string;
  error?: string;
}

/**
 * Determine how to invoke pi (handles bundled executables vs node vs global pi)
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

/**
 * Extract the final assistant text from a list of messages.
 */
function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Run a pi subagent with the given task prompt.
 *
 * @param task - The full task prompt (e.g., content + summarize directive)
 * @param cwd - Working directory for the subprocess
 * @param signal - AbortSignal for cancellation
 * @returns The assistant's final text output
 */
export async function runSubagent(
  task: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  args.push(`Task: ${task}`);

  let wasAborted = false;
  const messages: Message[] = [];
  let stderr = "";

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message) {
        messages.push(event.message as Message);
      }
      if (event.type === "tool_result_end" && event.message) {
        messages.push(event.message as Message);
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", () => {
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });

  if (wasAborted) {
    return { text: "", exitCode, stderr, error: "Subagent was aborted" };
  }

  const text = getFinalOutput(messages);

  if (exitCode !== 0 && !text) {
    return {
      text: "",
      exitCode,
      stderr,
      error: `Subagent exited with code ${exitCode}: ${stderr.trim() || "(no output)"}`,
    };
  }

  return { text, exitCode, stderr };
}
