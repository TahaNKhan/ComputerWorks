// packages/ui/src/store/reducer.test.ts
// T14.2 — Pure reducer unit tests.
//
// Every ServerEvent branch is covered here, plus each cross-cutting
// helper (appendToken / appendToolCall / removeToolCall /
// appendPart / finalizeStreaming). The reducer is pure — no React,
// no zustand, no fetch — so these run in milliseconds and pin down
// every state transition the UI relies on.

import { describe, expect, it } from "bun:test";
import {
  appendPart,
  appendToken,
  appendToolCall,
  finalizeStreaming,
  initialState,
  messagesOf,
  reduceStreamEvent,
  removeToolCall,
  transcriptToUi,
} from "./reducer.js";
import type { ServerEvent, SessionMessage, UiMessage } from "../api/types.js";

function stateWith(active: string | null = null, messages: UiMessage[] = []) {
  const s = initialState();
  return {
    ...s,
    activeSessionId: active,
    messagesBySession: active ? { [active]: messages } : {},
  };
}

const MSG_ID = "u-1";

describe("appendToken", () => {
  it("returns the array unchanged when there is no message to append to", () => {
    // The reducer pairs `message_start` with `token` events, so this
    // case is unreachable in practice — but the helper is defensive
    // (returns the empty buffer as-is) so accidental misuse doesn't
    // surprise callers.
    const out = appendToken([], "Hello");
    expect(out).toHaveLength(0);
  });

  it("appends delta to an existing streaming assistant's first text part", () => {
    const base: UiMessage[] = [{
      id: MSG_ID, role: "assistant", streaming: true,
      parts: [{ kind: "text", text: "Hel" }],
    }];
    const out = appendToken(base, "lo");
    expect(out[0]!.parts).toEqual([{ kind: "text", text: "Hello" }]);
    expect(out[0]!.id).toBe(MSG_ID);
  });

  it("starts a new message when last is a non-streaming user message", () => {
    const base: UiMessage[] = [{
      id: "u-1", role: "user", parts: [{ kind: "text", text: "hi" }],
    }];
    const out = appendToken(base, "Hello");
    expect(out).toHaveLength(2);
    expect(out[1]!.streaming).toBe(true);
  });

  it("creates a text part if the streaming message has no text yet", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }];
    const out = appendToken(base, "Hi");
    expect(out[0]!.parts).toEqual([{ kind: "text", text: "Hi" }]);
  });
});

describe("appendToolCall", () => {
  it("appends a tool_call part to the last assistant message", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [{ kind: "text", text: "thinking…" }],
    }];
    const out = appendToolCall(base, { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } });
    expect(out[0]!.parts).toEqual([
      { kind: "text", text: "thinking…" },
      { kind: "tool_call", call: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } } },
    ]);
  });
});

describe("appendPart", () => {
  it("appends a generic part to the last message", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }];
    const out = appendPart(base, {
      kind: "approval",
      requestId: "r1",
      tool: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } },
      description: "run_shell: ls",
    });
    expect(out[0]!.parts).toHaveLength(1);
    expect(out[0]!.parts[0]!.kind).toBe("approval");
  });
});

describe("removeToolCall", () => {
  it("drops the matching tool_call part", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [
        { kind: "tool_call", call: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } } },
      ],
    }];
    const out = removeToolCall(base, "c1");
    expect(out[0]!.parts).toHaveLength(0);
  });

  it("also drops the approval card rendered for the same tool call", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [
        { kind: "text", text: "thinking…" },
        { kind: "tool_call", call: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } } },
        { kind: "approval", requestId: "r1", tool: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } }, description: "ok" },
      ],
    }];
    const out = removeToolCall(base, "c1");
    expect(out[0]!.parts).toEqual([
      { kind: "text", text: "thinking…" },
    ]);
  });

  it("leaves non-matching tool_call parts untouched", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [
        { kind: "tool_call", call: { type: "tool_use", id: "c1", name: "run_shell", input: {} } },
        { kind: "tool_call", call: { type: "tool_use", id: "c2", name: "read_file", input: {} } },
      ],
    }];
    const out = removeToolCall(base, "c1");
    expect(out[0]!.parts).toHaveLength(1);
    expect((out[0]!.parts[0] as { call: { id: string } }).call.id).toBe("c2");
  });
});

describe("finalizeStreaming", () => {
  it("marks the last streaming message as finalized", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }];
    const out = finalizeStreaming(base);
    expect(out[0]!.streaming).toBe(false);
    expect(out[0]!.completedAt).toBeDefined();
  });

  it("is a no-op when no message is streaming", () => {
    const base: UiMessage[] = [{
      id: "a-1", role: "assistant", streaming: false, parts: [],
    }];
    const out = finalizeStreaming(base);
    expect(out).toBe(base);
  });
});

describe("messagesOf", () => {
  it("returns the array for the session, or empty", () => {
    const s = stateWith("s1", [{ id: "u-1", role: "user", parts: [] }]);
    expect(messagesOf(s, "s1")).toHaveLength(1);
    expect(messagesOf(s, "s2")).toEqual([]);
  });
});

// ─── reduceStreamEvent ─────────────────────────────────────────────────────

describe("reduceStreamEvent — message_start", () => {
  it("begins a fresh streaming assistant message and sets status=streaming", () => {
    const s = stateWith("s1", []);
    const ev: ServerEvent = { type: "message_start" };
    const next = reduceStreamEvent(s, "s1", ev);
    expect(messagesOf(next, "s1")).toHaveLength(1);
    expect(messagesOf(next, "s1")[0]!.streaming).toBe(true);
    expect(next.status).toBe("streaming");
  });
});

describe("reduceStreamEvent — token", () => {
  it("appends the delta to the streaming assistant message", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [{ kind: "text", text: "Hel" }],
    }]);
    const next = reduceStreamEvent(s, "s1", { type: "token", delta: "lo" });
    expect(messagesOf(next, "s1")[0]!.parts).toEqual([{ kind: "text", text: "Hello" }]);
  });
});

describe("reduceStreamEvent — tool_call", () => {
  it("appends a tool_use part to the streaming message", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "tool_call",
      call: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } },
    });
    expect(messagesOf(next, "s1")[0]!.parts).toHaveLength(1);
    expect(messagesOf(next, "s1")[0]!.parts[0]!.kind).toBe("tool_call");
  });
});

describe("reduceStreamEvent — tool_result", () => {
  it("removes the matching tool_call block from the chat", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [{ kind: "tool_call", call: { type: "tool_use", id: "c1", name: "x", input: {} } }],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "tool_result",
      call_id: "c1",
      approved: true,
      is_error: false,
      result: "ok",
    });
    expect(messagesOf(next, "s1")[0]!.parts).toHaveLength(0);
  });

  it("removes the matching tool_call AND its approval card", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [
        { kind: "text", text: "thinking…" },
        { kind: "tool_call", call: { type: "tool_use", id: "c1", name: "run_shell", input: {} } },
        { kind: "approval", requestId: "r1", tool: { type: "tool_use", id: "c1", name: "run_shell", input: {} }, description: "ok" },
      ],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "tool_result",
      call_id: "c1",
      approved: true,
      is_error: false,
      result: "ok",
    });
    expect(messagesOf(next, "s1")[0]!.parts).toEqual([
      { kind: "text", text: "thinking…" },
    ]);
  });

  it("leaves the message and other tool calls alone when call_id does not match", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true,
      parts: [{ kind: "tool_call", call: { type: "tool_use", id: "c2", name: "x", input: {} } }],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "tool_result",
      call_id: "c1",
      approved: false,
      is_error: true,
    });
    expect(messagesOf(next, "s1")[0]!.parts).toHaveLength(1);
  });
});

describe("reduceStreamEvent — approval_required", () => {
  it("appends an approval card and sets pendingApproval + status=awaiting-approval", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "approval_required",
      requestId: "r1",
      tool: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } },
      description: "run_shell: ls",
      diff: "ls",
    });
    expect(messagesOf(next, "s1")[0]!.parts[0]!.kind).toBe("approval");
    expect(next.pendingApproval?.requestId).toBe("r1");
    expect(next.status).toBe("awaiting-approval");
  });
});

describe("reduceStreamEvent — message_appended (T17.3)", () => {
  it("appends the message to the target session", () => {
    const s = stateWith("s1", [{
      id: "u-1", role: "user", parts: [{ kind: "text", text: "hi" }],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "message_appended",
      sessionId: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      originator: "tab-other",
      ts: "2026-06-28T12:00:00.000Z",
    });
    const parts = messagesOf(next, "s1")[1]!.parts;
    expect(parts).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("skips the event when originator matches our tabId", () => {
    const s = {
      ...stateWith("s1"),
      tabId: "tab-us",
      messagesBySession: {
        s1: [{
          id: "u-1", role: "user", parts: [{ kind: "text", text: "hi" }],
        }],
      },
    };
    const before = messagesOf(s, "s1");
    const next = reduceStreamEvent(s, "s1", {
      type: "message_appended",
      sessionId: "s1",
      message: { role: "assistant", content: [{ type: "text", text: "echo" }] },
      originator: "tab-us",
      ts: "2026-06-28T12:00:00.000Z",
    });
    // The originator's own echo: the reducer returns the same state
    // object (identity-preserving no-op).
    expect(messagesOf(next, "s1")).toBe(before);
  });

  it("T19 — drops tool-result messages (no tool_output as raw text in chat)", () => {
    const s = stateWith("s1", []);
    const next = reduceStreamEvent(s, "s1", {
      type: "message_appended",
      sessionId: "s1",
      message: {
        role: "tool",
        content: [{
          type: "tool_result",
          tool_use_id: "c1",
          content: '{"stdout":"hi"}',
          is_error: false,
        }],
      },
      originator: "tab-other",
      ts: "2026-06-28T12:00:00.000Z",
    });
    expect(messagesOf(next, "s1")).toHaveLength(0);
  });

  it("T19 — drops assistant messages whose only content is a tool_use block", () => {
    const s = stateWith("s1", []);
    const next = reduceStreamEvent(s, "s1", {
      type: "message_appended",
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "list_dir", input: {} }],
      },
      originator: "tab-other",
      ts: "2026-06-28T12:00:00.000Z",
    });
    expect(messagesOf(next, "s1")).toHaveLength(0);
  });

  it("dedupes by ts key (server-stable timestamp)", () => {
    const ts = "2026-06-28T12:00:00.000Z";
    const baseEvent = {
      type: "message_appended" as const,
      sessionId: "s1",
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
      originator: "tab-other",
      ts,
    };
    // First event: appends.
    const after1 = reduceStreamEvent(initialState(), "s1", baseEvent);
    expect(messagesOf(after1, "s1")).toHaveLength(1);
    // Second event with same ts: no-op (same state object).
    const after2 = reduceStreamEvent(after1, "s1", baseEvent);
    expect(messagesOf(after2, "s1")).toBe(messagesOf(after1, "s1"));
  });

  it("starts a session with the message when messagesBySession is empty", () => {
    const s = stateWith("s1", []);
    const next = reduceStreamEvent(s, "s1", {
      type: "message_appended",
      sessionId: "s1",
      message: { role: "user", content: "first message" },
      originator: "tab-other",
      ts: "2026-06-28T12:00:00.000Z",
    });
    expect(messagesOf(next, "s1")).toHaveLength(1);
  });
});

describe("reduceStreamEvent — message_done / done", () => {
  it("message_done finalizes the streaming message and goes idle", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "message_done",
      usage: { input: 1, output: 1 },
    });
    expect(messagesOf(next, "s1")[0]!.streaming).toBe(false);
    expect(next.status).toBe("idle");
  });

  it("done behaves identically to message_done", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }]);
    const next = reduceStreamEvent(s, "s1", { type: "done" });
    expect(messagesOf(next, "s1")[0]!.streaming).toBe(false);
    expect(next.status).toBe("idle");
  });
});

describe("reduceStreamEvent — session_renamed", () => {
  it("updates the matching session's title without touching messages", () => {
    const s = {
      ...stateWith("s1"),
      sessions: [
        { id: "s1", title: "", model: "m", cwd: "/", createdAt: "", updatedAt: "" },
        { id: "s2", title: "Other", model: "m", cwd: "/", createdAt: "", updatedAt: "" },
      ],
    };
    const next = reduceStreamEvent(s, "s1", {
      type: "session_renamed",
      sessionId: "s1",
      title: "New title",
    });
    expect(next.sessions.find((x) => x.id === "s1")!.title).toBe("New title");
    expect(next.sessions.find((x) => x.id === "s2")!.title).toBe("Other");
    expect(messagesOf(next, "s1")).toEqual(messagesOf(s, "s1"));
  });
});

describe("reduceStreamEvent — error", () => {
  it("surfaces the error, finalizes the streaming message, and goes error", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [],
    }]);
    const next = reduceStreamEvent(s, "s1", {
      type: "error",
      message: "kaboom",
    });
    expect(next.errorMessage).toBe("kaboom");
    expect(next.status).toBe("error");
    expect(messagesOf(next, "s1")[0]!.streaming).toBe(false);
  });
});

describe("reduceStreamEvent — pure-function invariants", () => {
  it("returns the same object identity for sessions when not touched", () => {
    const s = {
      ...stateWith("s1"),
      sessions: [
        { id: "s1", title: "hello", model: "m", cwd: "/", createdAt: "", updatedAt: "" },
      ],
    };
    const next = reduceStreamEvent(s, "s1", { type: "token", delta: "x" });
    expect(next.sessions).toBe(s.sessions);
  });

  it("does not mutate the input state", () => {
    const s = stateWith("s1", [{
      id: "a-1", role: "assistant", streaming: true, parts: [{ kind: "text", text: "x" }],
    }]);
    const snapshot = JSON.stringify(s);
    reduceStreamEvent(s, "s1", { type: "token", delta: "y" });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

// ─── transcriptToUi (T19 — filter tool calls / results from persisted transcript) ─

describe("transcriptToUi", () => {
  it("keeps user text and assistant text", () => {
    const out = transcriptToUi([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "user", parts: [{ kind: "text", text: "hi" }] });
    expect(out[1]).toMatchObject({ role: "assistant", parts: [{ kind: "text", text: "hello" }] });
  });

  it("keeps only the text part when an assistant message has text + tool_use", () => {
    const out = transcriptToUi([{
      role: "assistant",
      content: [
        { type: "text", text: "I'll show you — note the file is ~16 KB." },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "REQUIREMENTS.MD" } },
      ],
    }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.parts).toEqual([{ kind: "text", text: "I'll show you — note the file is ~16 KB." }]);
  });

  it("drops assistant messages whose only content is a tool_use block", () => {
    const out = transcriptToUi([{
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "list_dir", input: {} }],
    }]);
    expect(out).toHaveLength(0);
  });

  it("drops tool_result messages (no raw JSON in chat)", () => {
    const out = transcriptToUi([{
      role: "tool",
      content: [{
        type: "tool_result",
        tool_use_id: "c1",
        content: '[{"name":"package.json","type":"file","size":973}]',
        is_error: false,
      }],
    }]);
    expect(out).toHaveLength(0);
  });

  it("drops system messages", () => {
    const out = transcriptToUi([
      { role: "system", content: "you are a helpful assistant" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("matches the user's transcript (the one that triggered this fix)", () => {
    // Reproduces the shape from the bug report: a turn where the
    // assistant issues a tool_use, gets a tool_result back, then
    // summarizes. None of the tool bookkeeping should appear in
    // the chat; only the user prompts and the assistant narrative.
    const transcript: SessionMessage[] = [
      { role: "user", content: "list the files in your working dir" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "list_dir", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c1", content: "[]", is_error: false }] },
      { role: "assistant", content: [{ type: "text", text: "Here's what's there…" }] },
      { role: "user", content: "cat it" },
      { role: "assistant", content: [
        { type: "text", text: "Sure, give me a sec." },
        { type: "tool_use", id: "c2", name: "run_shell", input: { command: "cat" } },
      ] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "c2", content: '{"stdout":"…"}', is_error: false }] },
      { role: "assistant", content: [{ type: "text", text: "Done — that's the file." }] },
    ];
    const out = transcriptToUi(transcript);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "assistant"]);
    expect(out.map((m) => m.parts[0])).toEqual([
      { kind: "text", text: "list the files in your working dir" },
      { kind: "text", text: "Here's what's there…" },
      { kind: "text", text: "cat it" },
      { kind: "text", text: "Sure, give me a sec." },
      { kind: "text", text: "Done — that's the file." },
    ]);
  });

  it("handles an empty transcript", () => {
    expect(transcriptToUi([])).toEqual([]);
  });

  it("handles an assistant message whose content is a single text block with empty text", () => {
    const out = transcriptToUi([{ role: "assistant", content: [{ type: "text", text: "" }] }]);
    expect(out).toEqual([]);
  });
});