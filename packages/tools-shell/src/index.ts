// packages/tools-shell/src/index.ts
// T3.1 — run_shell tool.
//
// Per DESIGN.MD §4.2 / TASKS.MD Phase 3:
//   - Detects platform (PowerShell on Windows, bash on Unix)
//   - Spawns via node:child_process non-interactively (no TTY)
//   - Hard timeout (default 60s, configurable per call)
//   - Output truncated to 100KB with a visible marker
//   - Returns { stdout, stderr, exitCode, durationMs }
//   - Honors cwd and AbortSignal from ToolContext
//   - requiresApproval: true
//
// SECURITY (per REQUIREMENTS.MD §6):
//   - We DO NOT shell-quote the input. The agent-supplied command
//     string is passed to bash -lc / powershell -Command AS IS, and
//     the user sees the full command in the approval UI.
//   - We DO NOT auto-execute; this tool always requires approval.
//   - The server layer (Phase 5) is responsible for any command
//     denylist enforcement — this tool just runs what it's told.

import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolDefinition } from "@computerworks/core";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024; // 100KB

const TRUNCATION_MARKER = "\n…[truncated]…\n";

export const runShellInputSchema = z.object({
  command: z.string().min(1).describe(
    "REQUIRED. The shell command to execute. " +
    "This argument MUST be included on every call — omitting it will fail validation."
  ),
  cwd: z.string().optional().describe("Override the working directory"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override the default timeout (ms)"),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override the 100KB output cap (bytes)"),
});

export type RunShellInput = z.infer<typeof runShellInputSchema>;

export interface RunShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Pick the right shell + arg shape for the host platform.
 * `bash -lc <cmd>` runs in a login shell (PATH etc.); we use `-c` only
 * for the simple case where the caller passes a single command.
 * PowerShell uses `-Command` with the full string.
 */
function platformShell(): { shell: string; baseArgs: (cmd: string) => string[] } {
  if (process.platform === "win32") {
    // Prefer pwsh (PowerShell Core) if available; fall back to powershell.exe.
    const shell =
      process.env["COMSPEC"]?.includes("cmd") ? "powershell.exe" : "pwsh";
    return {
      shell,
      baseArgs: (cmd) => ["-NoProfile", "-NonInteractive", "-Command", cmd],
    };
  }
  return {
    shell: "/bin/bash",
    baseArgs: (cmd) => ["-lc", cmd],
  };
}

function maybeTruncate(buf: Buffer<ArrayBufferLike>, cap: number): { text: string; truncated: boolean } {
  if (buf.byteLength <= cap) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  const sliced = buf.subarray(0, cap).toString("utf8");
  return { text: sliced + TRUNCATION_MARKER, truncated: true };
}

async function runOnce(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<RunShellOutput> {
  const { shell, baseArgs } = platformShell();
  const args = baseArgs(cmd);
  const started = Date.now();

  return await new Promise<RunShellOutput>((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd,
      // No TTY — stdin is closed so child commands can't hang on input.
      stdio: ["ignore", "pipe", "pipe"],
      // env is inherited; ToolContext can sanitize it in Phase 5.
      env: process.env,
      // Don't open a shell of its own; we already specified shell + args.
      shell: false,
    });

    let stdoutBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;

    // Cap output even if the child streams faster than we can read.
    // We give a little slack so we can detect truncation cleanly.
    const hardCap = maxOutputBytes * 2;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf = appendCapped(stdoutBuf, chunk, hardCap);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf = appendCapped(stderrBuf, chunk, hardCap);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL on Unix; on Windows, child_process maps kill() to TerminateProcess.
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);

    const onAbort = () => {
      // Abort counts as a timeout from the model's perspective — the
      // turn was cut short intentionally. Surface it the same way.
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);

      const stdout = maybeTruncate(stdoutBuf, maxOutputBytes);
      const stderr = maybeTruncate(stderrBuf, maxOutputBytes);

      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

function appendCapped(
  buf: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  cap: number,
): Buffer<ArrayBufferLike> {
  const next = buf.length + chunk.length;
  if (next <= cap) return Buffer.concat([buf, chunk] as Uint8Array[]);
  if (buf.length >= cap) return buf;
  const take = cap - buf.length;
  return Buffer.concat([buf, chunk.subarray(0, take)] as Uint8Array[]);
}

export const runShellTool: ToolDefinition<RunShellInput, RunShellOutput> = {
  name: "run_shell",
  description:
    "Run a shell command non-interactively. The full command is shown " +
    "in the approval prompt before execution. Honors the session's " +
    "working directory and abort signal.",
  inputSchema: runShellInputSchema as unknown as import("@computerworks/core").z.ZodType<RunShellInput>,
  requiresApproval: true,
  async execute(input: RunShellInput, ctx) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const cwd = input.cwd ?? ctx.cwd;
    return await runOnce(input.command, cwd, timeoutMs, maxOutputBytes, ctx.signal);
  },
};

// Re-export the singleton form for the registry in Phase 5.
export const tools = [runShellTool];
export default runShellTool;
