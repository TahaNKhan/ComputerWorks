// packages/ui/src/store/sessions.test.ts
//
// T14.2 — Pure-helper tests for the reducer helpers. The reducer
// itself is exercised in `./reducer.test.ts`; this file stays as a
// thin sanity check on the helpers that compose the streaming
// message model.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendPart,
  appendToken,
  appendToolCall,
  finalizeStreaming,
  removeToolCall,
} from "./reducer.js";
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

describe("removeToolCall", () => {
  test("removes the matching tool_call part", () => {
    const msgs: UiMessage[] = [{
      ...newStreamingMsg(""),
      parts: [
        { kind: "text", text: "" },
        { kind: "tool_call", call: SHELL_CALL },
      ],
    }];
    const out = removeToolCall(msgs, "call-1");
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]!.kind).toBe("text");
  });

  test("also removes the approval card for the same tool call", () => {
    const msgs: UiMessage[] = [{
      ...newStreamingMsg(""),
      parts: [
        { kind: "text", text: "" },
        { kind: "tool_call", call: SHELL_CALL },
        { kind: "approval", requestId: "r1", tool: SHELL_CALL, description: "ok" },
      ],
    }];
    const out = removeToolCall(msgs, "call-1");
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]!.kind).toBe("text");
  });

  test("returns the same message identity when no part matches", () => {
    const msgs: UiMessage[] = [{
      ...newStreamingMsg(""),
      parts: [{ kind: "text", text: "" }],
    }];
    const out = removeToolCall(msgs, "call-99");
    expect(out).toEqual(msgs);
  });

  test("removes only the matching part when several tool_calls exist", () => {
    const otherCall: ToolUseBlock = { type: "tool_use", id: "call-2", name: "read_file", input: {} };
    const msgs: UiMessage[] = [{
      ...newStreamingMsg(""),
      parts: [
        { kind: "text", text: "" },
        { kind: "tool_call", call: SHELL_CALL },
        { kind: "tool_call", call: otherCall },
      ],
    }];
    const out = removeToolCall(msgs, "call-1");
    expect(out[0]!.parts).toHaveLength(2);
    expect(out[0]!.parts[1]!.kind).toBe("tool_call");
    expect((out[0]!.parts[1] as Extract<UiMessage["parts"][number], { kind: "tool_call" }>).call.id).toBe("call-2");
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

describe("applyValidationError", () => {
  // applyValidationError was removed when tool_validation_error stopped
  // being part of the wire (validation errors are caught inside the
  // agent loop, never reach the UI). The validation-error → block-removal
  // behavior is now expressed by removeToolCall + the loop's own
  // ToolValidationError handling — covered by the removeToolCall tests
  // above and the loop tests in packages/agent.
});