// packages/ui/src/api/sse-parse.test.ts
// Unit tests for the SSE frame parser.

import { describe, expect, test } from "bun:test";
import { drainFrames, isHeartbeatFrame, parseSSEFrame } from "./sse-parse.js";

describe("drainFrames", () => {
  test("splits a single complete frame", () => {
    const input = "event: token\ndata: {\"delta\":\"hi\"}\n\n";
    const { events, rest } = drainFrames(input);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe("event: token\ndata: {\"delta\":\"hi\"}");
    expect(rest).toBe("");
  });

  test("returns empty when no terminator", () => {
    const input = "event: token\ndata: {\"delta\":\"hi\"}";
    const { events, rest } = drainFrames(input);
    expect(events).toHaveLength(0);
    expect(rest).toBe(input);
  });

  test("emits multiple events in order", () => {
    const a = "event: token\ndata: {\"delta\":\"a\"}\n\n";
    const b = "event: token\ndata: {\"delta\":\"b\"}\n\n";
    const c = "event: done\ndata: \n\n";
    const { events, rest } = drainFrames(a + b + c);
    expect(events).toHaveLength(3);
    expect(rest).toBe("");
    expect(parseSSEFrame(events[0]!)).toEqual({ type: "token", delta: "a" });
    expect(parseSSEFrame(events[1]!)).toEqual({ type: "token", delta: "b" });
    expect(parseSSEFrame(events[2]!)).toEqual({ type: "done" });
  });

  test("preserves trailing partial frame", () => {
    const input = "event: token\ndata: {\"delta\":\"a\"}\n\nevent: tok";
    const { events, rest } = drainFrames(input);
    expect(events).toHaveLength(1);
    expect(rest).toBe("event: tok");
  });

  test("skips heartbeat-only frames", () => {
    const input = ":hb\n\nevent: token\ndata: {\"delta\":\"x\"}\n\n";
    const { events, rest } = drainFrames(input);
    expect(events).toHaveLength(1);
    expect(rest).toBe("");
  });
});

describe("isHeartbeatFrame", () => {
  test("true for comment-only frame", () => {
    expect(isHeartbeatFrame(":hb")).toBe(true);
  });

  test("false for a real event", () => {
    expect(isHeartbeatFrame("event: token\ndata: hi")).toBe(false);
  });
});

describe("parseSSEFrame", () => {
  test("parses a token event", () => {
    const ev = parseSSEFrame("event: token\ndata: {\"delta\":\"hello\"}");
    expect(ev).toEqual({ type: "token", delta: "hello" });
  });

  test("parses done with empty body", () => {
    const ev = parseSSEFrame("event: done\ndata: ");
    expect(ev).toEqual({ type: "done" });
  });

  test("parses tool_call", () => {
    const body = JSON.stringify({
      call: {
        type: "tool_use",
        id: "abc",
        name: "run_shell",
        input: { command: "ls" },
      },
    });
    const ev = parseSSEFrame(`event: tool_call\ndata: ${body}`);
    expect(ev).toEqual({
      type: "tool_call",
      call: { type: "tool_use", id: "abc", name: "run_shell", input: { command: "ls" } },
    });
  });

  test("parses tool_result with optional result and reason", () => {
    const body = JSON.stringify({
      call_id: "abc",
      approved: true,
      is_error: false,
      result: { stdout: "hi", stderr: "", exitCode: 0 },
    });
    const ev = parseSSEFrame(`event: tool_result\ndata: ${body}`);
    expect(ev).toEqual({
      type: "tool_result",
      call_id: "abc",
      approved: true,
      is_error: false,
      result: { stdout: "hi", stderr: "", exitCode: 0 },
    });
  });

  test("parses approval_required with diff", () => {
    const body = JSON.stringify({
      requestId: "req-1",
      tool: { type: "tool_use", id: "abc", name: "run_shell", input: { command: "ls" } },
      description: "Run shell command",
      diff: "- a\n+ b",
    });
    const ev = parseSSEFrame(`event: approval_required\ndata: ${body}`);
    expect(ev).toMatchObject({
      type: "approval_required",
      requestId: "req-1",
      diff: "- a\n+ b",
    });
  });

  test("parses session_renamed", () => {
    const body = JSON.stringify({ sessionId: "sess-1", title: "Help with React" });
    const ev = parseSSEFrame(`event: session_renamed\ndata: ${body}`);
    expect(ev).toEqual({ type: "session_renamed", sessionId: "sess-1", title: "Help with React" });
  });

  test("returns null for session_renamed with missing sessionId", () => {
    const body = JSON.stringify({ title: "no id" });
    const ev = parseSSEFrame(`event: session_renamed\ndata: ${body}`);
    expect(ev).toBeNull();
  });

  test("returns null for unknown event types", () => {
    const ev = parseSSEFrame("event: bogus\ndata: {}");
    expect(ev).toBeNull();
  });

  test("returns null when event field missing", () => {
    const ev = parseSSEFrame("data: {\"delta\":\"x\"}");
    expect(ev).toBeNull();
  });

  test("returns null when JSON body is invalid", () => {
    const ev = parseSSEFrame("event: token\ndata: not-json");
    expect(ev).toBeNull();
  });
});