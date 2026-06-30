// packages/server/src/system-prompt.test.ts
// T19.6 — Unit tests for the LLM-decides system-prompt gate.
//
// buildSystemPrompt accepts `llmDecides: boolean`. We assert the
// rendered prompt contains the "## Session title" section when
// true (default) and does NOT contain it when false.

import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "./system-prompt.js";
import { createFileMemoryProvider } from "@computerworks/memory-files";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let memoryRoot: string;

function setup(): void {
  memoryRoot = mkdtempSync(join(tmpdir(), "cw-sysprompt-"));
}

function teardown(): void {
  rmSync(memoryRoot, { recursive: true, force: true });
}

async function makeMemory() {
  return createFileMemoryProvider({ root: memoryRoot });
}

describe("buildSystemPrompt (T19.6)", () => {
  it("default (llmDecides=true) includes the Session title section", async () => {
    setup();
    try {
      const memory = await makeMemory();
      const out = await buildSystemPrompt({
        memory,
        cwd: "/tmp",
        model: "MiniMax-M3",
      });
      expect(out).toContain("## Session title");
      expect(out).toContain("rename_session");
      expect(out).toContain("rate_limited");
      expect(out).toContain("manual_rename_locked");
    } finally {
      teardown();
    }
  });

  it("llmDecides=true explicitly includes the section", async () => {
    setup();
    try {
      const memory = await makeMemory();
      const out = await buildSystemPrompt({
        memory,
        cwd: "/tmp",
        model: "MiniMax-M3",
        llmDecides: true,
      });
      expect(out).toContain("## Session title");
    } finally {
      teardown();
    }
  });

  it("llmDecides=false omits the Session title section", async () => {
    setup();
    try {
      const memory = await makeMemory();
      const out = await buildSystemPrompt({
        memory,
        cwd: "/tmp",
        model: "MiniMax-M3",
        llmDecides: false,
      });
      expect(out).not.toContain("## Session title");
      expect(out).not.toContain("rename_session");
      // The rest of the prompt is unchanged.
      expect(out).toContain("## Tool rules");
      expect(out).toContain("## Memory");
      expect(out).toContain("## Session"); // the cwd/model block
    } finally {
      teardown();
    }
  });

  it("still includes cwd + model regardless of llmDecides", async () => {
    setup();
    try {
      const memory = await makeMemory();
      const on = await buildSystemPrompt({
        memory,
        cwd: "/work/proj",
        model: "MiniMax-M3",
        llmDecides: true,
      });
      const off = await buildSystemPrompt({
        memory,
        cwd: "/work/proj",
        model: "MiniMax-M3",
        llmDecides: false,
      });
      expect(on).toContain("/work/proj");
      expect(off).toContain("/work/proj");
      expect(on).toContain("MiniMax-M3");
      expect(off).toContain("MiniMax-M3");
    } finally {
      teardown();
    }
  });
});
