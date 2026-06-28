// packages/server/src/sse.test.ts
// T14.1 unit tests — formatSSE.
//
// Before v1.14 this file also covered SSEManager (subscriber map,
// heartbeats, dispose). v1.14 replaces the manager with a per-
// response writer (sse-writer.ts); the only thing left in sse.ts is
// the pure `formatSSE(event)` framing function. Coverage here is
// deliberately small: every event type is exercised by the
// app.test.ts integration tests via POST /messages.

import { describe, expect, it } from "bun:test";
import { formatSSE, type ServerEvent } from "./sse.js";

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

describe("formatSSE", () => {
  it("frames an event with no body as event: + empty data: + blank line", () => {
    const bytes = formatSSE({ type: "done" });
    const text = decode(bytes);
    expect(text).toBe("event: done\ndata: \n\n");
  });

  it("frames a token event with a JSON body", () => {
    const bytes = formatSSE({ type: "token", delta: "Hel" });
    const text = decode(bytes);
    expect(text).toBe('event: token\ndata: {"delta":"Hel"}\n\n');
  });

  it("frames a tool_result with optional fields preserved", () => {
    const ev: ServerEvent = {
      type: "tool_result",
      call_id: "abc",
      approved: true,
      result: { stdout: "hi" },
      is_error: false,
    };
    const text = decode(formatSSE(ev));
    expect(text).toBe(
      'event: tool_result\ndata: {"call_id":"abc","approved":true,"result":{"stdout":"hi"},"is_error":false}\n\n',
    );
  });

  it("frames an approval_required with optional diff", () => {
    const ev: ServerEvent = {
      type: "approval_required",
      requestId: "r1",
      tool: { type: "tool_use", id: "c1", name: "run_shell", input: { cmd: "ls" } },
      description: "run_shell: ls",
      diff: "+ ls\n",
    };
    const text = decode(formatSSE(ev));
    // We don't pin the exact JSON ordering — just sanity-check that
    // the type, body, and trailing blank line are all there.
    expect(text.startsWith("event: approval_required\ndata: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    expect(text).toContain('"requestId":"r1"');
    expect(text).toContain('"name":"run_shell"');
  });

  it("frames a message_start with empty body", () => {
    const text = decode(formatSSE({ type: "message_start" }));
    expect(text).toBe("event: message_start\ndata: \n\n");
  });
});