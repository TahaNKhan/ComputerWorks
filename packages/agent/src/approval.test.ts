// packages/agent/src/approval.test.ts
// T2.1 unit tests — AutoApprover.

import { describe, expect, it } from "bun:test";
import { AutoApprover } from "./approval.js";
import type { ToolUseBlock } from "@computerworks/core";

function makeToolUse(name: string, input: unknown): ToolUseBlock {
  return { type: "tool_use", id: "t1", name, input };
}

describe("AutoApprover", () => {
  it("returns the policy's decision", async () => {
    const approver = new AutoApprover(() => ({ kind: "approve_once" }));
    const dec = await approver.request(
      { call: makeToolUse("run_shell", { command: "ls" }), description: "ls" },
      new AbortController().signal,
    );
    expect(dec).toEqual({ kind: "approve_once" });
  });

  it("supports async policies", async () => {
    const approver = new AutoApprover(async () => {
      await Promise.resolve();
      return { kind: "reject", reason: "too dangerous" };
    });
    const dec = await approver.request(
      { call: makeToolUse("run_shell", { command: "rm -rf /" }), description: "rm" },
      new AbortController().signal,
    );
    expect(dec).toEqual({ kind: "reject", reason: "too dangerous" });
  });

  it("throws AbortError when called with an already-aborted signal", async () => {
    const approver = new AutoApprover(() => ({ kind: "approve_once" }));
    const ac = new AbortController();
    ac.abort();
    await expect(
      approver.request(
        { call: makeToolUse("x", {}), description: "x" },
        ac.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates a thrown error from the policy", async () => {
    const approver = new AutoApprover(() => {
      throw new Error("policy failure");
    });
    await expect(
      approver.request(
        { call: makeToolUse("x", {}), description: "x" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("policy failure");
  });

  it("supports edit decisions with arbitrary new input", async () => {
    const approver = new AutoApprover(() => ({
      kind: "edit",
      newInput: { command: "ls -la" },
    }));
    const dec = await approver.request(
      { call: makeToolUse("run_shell", { command: "ls" }), description: "ls" },
      new AbortController().signal,
    );
    expect(dec).toEqual({ kind: "edit", newInput: { command: "ls -la" } });
  });
});
