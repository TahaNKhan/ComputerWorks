// packages/tools-shell/src/index.test.ts
// T3.1 unit tests — runShellTool.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellTool } from "./index.js";
import type { ToolContext } from "@computerworks/core";

function ctx(cwd?: string): ToolContext {
  return {
    cwd: cwd ?? process.cwd(),
    signal: new AbortController().signal,
    env: {},
    sessionId: "test",
  };
}

describe("runShellTool", () => {
  it("returns stdout, exit 0 for a successful command", async () => {
    const r = await runShellTool.execute({ command: "echo hello" }, ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns exit 1 (or non-zero) for a failing command, with stderr", async () => {
    const r = await runShellTool.execute(
      { command: "echo to stderr >&2; exit 7" },
      ctx(),
    );
    expect(r.exitCode).toBe(7);
    expect(r.stderr.trim()).toBe("to stderr");
  });

  it("enforces timeout and reports timedOut=true", async () => {
    // sleep 5 with a 200ms timeout — must be killed.
    const r = await runShellTool.execute(
      { command: "sleep 5", timeoutMs: 200 },
      ctx(),
    );
    expect(r.timedOut).toBe(true);
    // Exit code is from the kill signal — any non-zero is fine.
    expect(r.exitCode).not.toBe(0);
  });

  it("truncates output beyond maxOutputBytes", async () => {
    const r = await runShellTool.execute(
      { command: "yes A | head -c 5000", maxOutputBytes: 1024 },
      ctx(),
    );
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeGreaterThanOrEqual(1024);
    expect(r.stdout).toContain("truncated");
  });

  it("respects cwd override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-shell-"));
    try {
      writeFileSync(join(dir, "marker.txt"), "found-it");
      const r = await runShellTool.execute(
        {
          command: process.platform === "win32" ? "type marker.txt" : "cat marker.txt",
          cwd: dir,
        },
        ctx(),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("found-it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates abort signal by killing the child", async () => {
    const ac = new AbortController();
    const promise = runShellTool.execute({ command: "sleep 10" }, {
      ...ctx(),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    const r = await promise;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("declares requiresApproval=true", () => {
    expect(runShellTool.requiresApproval).toBe(true);
    expect(runShellTool.name).toBe("run_shell");
  });
});
