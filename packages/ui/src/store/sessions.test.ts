// packages/ui/src/store/sessions.test.ts
// Unit tests for the pure reducer helpers in sessions.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendPart,
  appendToken,
  appendToolCall,
  applyToolResult,
  finalizeStreaming,
  useSessionsStore,
} from "./sessions.js";
import type { ServerEvent, ToolUseBlock, UiMessage } from "../api/types.js";

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

// ─── SSE reducer (via the public applyServerEvent) ─────────────────────────

describe("applyServerEvent: session_renamed", () => {
  const SID_A = "sess-A";
  const SID_B = "sess-B";

  beforeEach(() => {
    useSessionsStore.setState({
      sessions: [
        {
          id: SID_A,
          title: "",
          model: "m",
          cwd: "/tmp",
          createdAt: "2026-06-25T00:00:00Z",
          updatedAt: "2026-06-25T00:00:00Z",
        },
        {
          id: SID_B,
          title: "Existing",
          model: "m",
          cwd: "/tmp",
          createdAt: "2026-06-25T00:00:00Z",
          updatedAt: "2026-06-25T00:00:00Z",
        },
      ],
      activeSessionId: null,
      messagesBySession: {},
      auditBySession: {},
      pendingApproval: null,
      status: "idle",
      errorMessage: null,
      initialized: true,
    });
  });

  afterEach(() => {
    useSessionsStore.getState().reset();
  });

  test("updates only the matching session's title", () => {
    const ev: ServerEvent = {
      type: "session_renamed",
      sessionId: SID_A,
      title: "Help with React",
    };
    useSessionsStore.getState().applyServerEvent(SID_A, ev);
    const sessions = useSessionsStore.getState().sessions;
    expect(sessions.find((s) => s.id === SID_A)?.title).toBe("Help with React");
    expect(sessions.find((s) => s.id === SID_B)?.title).toBe("Existing");
  });

  test("is a no-op for an unknown session id (does not crash)", () => {
    const ev: ServerEvent = {
      type: "session_renamed",
      sessionId: "does-not-exist",
      title: "stale",
    };
    useSessionsStore.getState().applyServerEvent("does-not-exist", ev);
    const sessions = useSessionsStore.getState().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === SID_A)?.title).toBe("");
  });
});

// ─── URL sync (T12.2) ──────────────────────────────────────────────────────
//
// The store calls navigateToSession / replaceSessionInUrl which read
// `window.history` + `window.location`. In the bun:test runtime these
// are undefined, so we install a minimal stub via `globalThis.window`
// for the duration of this block.

describe("URL sync", () => {
  // Minimal type for our stub.
  type StubHistory = {
    pushed: string[];
    replaced: string[];
    pushState(_d: unknown, _u: string, url: string): void;
    replaceState(_d: unknown, _u: string, url: string): void;
  };
  type StubLocation = { pathname: string };
  type StubWindow = {
    history: StubHistory;
    location: StubLocation;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  };

  let originalWindow: unknown;
  let stubWindow: StubWindow;
  let listeners: Array<() => void>;

  beforeEach(() => {
    listeners = [];
    stubWindow = {
      pushed: [],
      replaced: [],
      history: {
        pushed: [],
        replaced: [],
        pushState(_d, _u, url) {
          (stubWindow.history.pushed as string[]).push(url);
        },
        replaceState(_d, _u, url) {
          (stubWindow.history.replaced as string[]).push(url);
        },
      },
      location: { pathname: "/" },
      addEventListener(_type, fn) {
        listeners.push(fn);
      },
      removeEventListener(_type, fn) {
        listeners = listeners.filter((l) => l !== fn);
      },
    } as StubWindow;
    originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = stubWindow;
    // Reset the store to a known empty state.
    useSessionsStore.getState().reset();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    useSessionsStore.getState().reset();
  });

  test("switchSession pushes the session URL", async () => {
    useSessionsStore.setState({
      sessions: [
        {
          id: "abc",
          title: "",
          model: "m",
          cwd: "/tmp",
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    await useSessionsStore.getState().switchSession("abc");
    expect(stubWindow.history.pushed).toContain("/s/abc");
  });

  test("switchSession to null pushes the root URL", async () => {
    useSessionsStore.setState({ activeSessionId: "abc" });
    await useSessionsStore.getState().switchSession(null);
    expect(stubWindow.history.pushed).toContain("/");
  });

  test("deleteSession of the active session pushes the root URL", async () => {
    // Stub global fetch so apiDeleteSession's DELETE returns 204.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    try {
      useSessionsStore.setState({
        sessions: [
          {
            id: "abc",
            title: "",
            model: "m",
            cwd: "/tmp",
            createdAt: "",
            updatedAt: "",
          },
        ],
        activeSessionId: "abc",
      });
      await useSessionsStore.getState().deleteSession("abc");
      // active session cleared and URL pushed to root.
      expect(useSessionsStore.getState().activeSessionId).toBeNull();
      expect(stubWindow.history.pushed).toContain("/");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("deleteSession of a non-active session does NOT change the URL", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    try {
      useSessionsStore.setState({
        sessions: [
          {
            id: "abc",
            title: "",
            model: "m",
            cwd: "/tmp",
            createdAt: "",
            updatedAt: "",
          },
          {
            id: "xyz",
            title: "",
            model: "m",
            cwd: "/tmp",
            createdAt: "",
            updatedAt: "",
          },
        ],
        activeSessionId: "abc",
      });
      const pushedBefore = stubWindow.history.pushed.length;
      await useSessionsStore.getState().deleteSession("xyz");
      // Active session unchanged; nothing was pushed to the URL.
      expect(useSessionsStore.getState().activeSessionId).toBe("abc");
      expect(stubWindow.history.pushed.length).toBe(pushedBefore);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});