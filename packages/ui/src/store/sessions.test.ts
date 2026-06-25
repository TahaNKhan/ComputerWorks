// packages/ui/src/store/sessions.test.ts
// Unit tests for the pure reducer helpers in sessions.ts.

import { describe, expect, test } from "bun:test";
import {
  appendPart,
  appendToken,
  appendToolCall,
  applyToolResult,
  finalizeStreaming,
} from "./sessions.js";
import type { ToolUseBlock, UiMessage } from "../api/types.js";

function newStreamingMsg(text: string = ""): UiMessage {
  return {
    id: "a-1",
    role: "assistant",
    parts: [{ kind: "text", text }],
    streaming: true,
  };
}

const SHELL_CALL: ToolUseBlock = {
  type: "tool_use",
  id: "call-1",
  name: "run_shell",
  input: { command: "ls" },
};

describe("appendToken", () => {
  test("returns msgs unchanged when buffer is empty (caller should send message_start first)", () => {
    // The reducer relies on `message_start` to create the first streaming
    // assistant message; token events before that are dropped.
    const out = appendToken([], "hi");
    expect(out).toEqual([]);
  });

  test("appends to existing streaming assistant message", () => {
    const msgs = [newStreamingMsg("he")];
    const out = appendToken(msgs, "llo");
    expect(out).toHaveLength(1);
    expect(out[0]!.parts[0]).toEqual({ kind: "text", text: "hello" });
  });

  test("does not merge into a finalized message", () => {
    const finalized: UiMessage = { ...newStreamingMsg("done"), streaming: false };
    const out = appendToken([finalized], "more");
    expect(out).toHaveLength(2);
    expect(out[1]!.parts[0]).toEqual({ kind: "text", text: "more" });
  });
});

describe("appendToolCall", () => {
  test("adds tool_call part to last message", () => {
    const msgs = [newStreamingMsg("Calling…")];
    const out = appendToolCall(msgs, SHELL_CALL);
    expect(out).toHaveLength(1);
    expect(out[0]!.parts).toHaveLength(2);
    expect(out[0]!.parts[1]).toMatchObject({ kind: "tool_call", call: SHELL_CALL });
  });
});

describe("applyToolResult", () => {
  test("fills in approved + result for matching call id", () => {
    const msgs = [newStreamingMsg(""), { kind: "tool_call", call: SHELL_CALL } as never];
    const m0 = msgs[0]!;
    const m0WithTool: UiMessage = { ...m0, parts: [{ kind: "text", text: "" }, { kind: "tool_call", call: SHELL_CALL }] };
    const updated = applyToolResult([m0WithTool], "call-1", {
      approved: true,
      isError: false,
      result: { stdout: "hi" },
    });
    const tc = updated[0]!.parts.find((p) => p.kind === "tool_call") as Extract<UiMessage["parts"][number], { kind: "tool_call" }>;
    expect(tc.approved).toBe(true);
    expect(tc.isError).toBe(false);
    expect(tc.result).toEqual({ stdout: "hi" });
  });
});

describe("appendPart", () => {
  test("appends arbitrary part to last message", () => {
    const msgs = [newStreamingMsg("")];
    const out = appendPart(msgs, { kind: "approval", requestId: "r1", tool: SHELL_CALL, description: "ok" });
    expect(out[0]!.parts).toHaveLength(2);
    expect(out[0]!.parts[1]).toMatchObject({ kind: "approval", requestId: "r1" });
  });
});

describe("finalizeStreaming", () => {
  test("marks last streaming message as not streaming", () => {
    const msgs = [newStreamingMsg("done")];
    const out = finalizeStreaming(msgs);
    expect(out[0]!.streaming).toBe(false);
    expect(out[0]!.completedAt).toBeDefined();
  });

  test("leaves non-streaming messages alone", () => {
    const finalized: UiMessage = { ...newStreamingMsg("done"), streaming: false };
    const out = finalizeStreaming([finalized]);
    expect(out).toEqual([finalized]);
  });
});