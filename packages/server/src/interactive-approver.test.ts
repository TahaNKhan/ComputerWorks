// packages/server/src/interactive-approver.test.ts
// T5.5 + T14.1 unit tests — InteractiveApprover.
//
// Before v1.14 the approver took an `SSEManager` and emitted via the
// manager's `send(sessionId, event)` API. v1.14 replaces the manager
// with a per-response `SSEWriter`; we use a fake writer here so the
// tests stay pure (no Fastify, no Node sockets).
//
// Coverage:
//   - Global shell allowlist auto-approves matching run_shell calls
//   - Session allowlist auto-approves matching tool names
//   - Approval prompt emits an `approval_required` event
//   - resolveById with `approve_once` returns approve_once
//   - resolveById with `reject` returns reject
//   - Timeout auto-rejects with reason "approval timeout"
//   - resolveById with unknown requestId returns false (does not throw)
//   - The approver honors AbortSignal
//   - tool_result is emitted with the right approved/is_error

import { describe, expect, it } from "bun:test";
import { InteractiveApprover } from "./interactive-approver.js";
import type { SSEWriter } from "./sse-writer.js";
import type { ServerEvent } from "./sse.js";
import type { ApprovalRequest } from "@computerworks/agent";

/** Tiny in-memory SSEWriter. Records every event written; lets the
 *  test flip `closed` to verify the approver short-circuits on
 *  disconnect in the future. */
function makeFakeWriter(): { writer: SSEWriter; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  let closed = false;
  const writer: SSEWriter = {
    write(ev) {
      if (!closed) events.push(ev);
    },
    end() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
  return { writer, events };
}

const sampleRequest = (tool = "run_shell", name = "run_shell"): ApprovalRequest => ({
  call: {
    type: "tool_use",
    id: "tu-1",
    name,
    input: { cmd: "rm -rf /" },
  },
  description: `${name}: rm -rf /`,
});

function makeApprover(opts: {
  writer: SSEWriter;
  global?: RegExp[];
  session?: string[];
  timeoutMs?: number;
}) {
  return new InteractiveApprover(
    opts.writer,
    "s1",
    opts.session ?? [],
    opts.global ?? [],
    { timeoutMs: opts.timeoutMs },
  );
}

// ─── global shell allowlist ───────────────────────────────────────────────

describe("global shell allowlist", () => {
  it("auto-approves matching run_shell calls and logs tool_result", async () => {
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({ writer, global: [/^ls/] });
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "run_shell", input: { cmd: "ls -la" } },
      description: "run_shell: ls -la",
    };
    const decision = await approver.request(req, new AbortController().signal);
    expect(decision).toEqual({ kind: "approve_once" });
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("tool_result");
    if (events[0]?.type === "tool_result") {
      expect(events[0].approved).toBe(true);
      expect(events[0].is_error).toBe(false);
    }
  });

  it("does NOT auto-approve non-matching run_shell calls", async () => {
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({ writer, global: [/^ls/] });
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "run_shell", input: { cmd: "rm -rf /" } },
      description: "rm -rf",
    };
    const ac = new AbortController();
    const p = approver.request(req, ac.signal);
    // Give the event loop a tick so the event is emitted.
    await new Promise((r) => setTimeout(r, 5));
    expect(approver.pendingCount()).toBe(1);
    expect(events.some((e) => e.type === "approval_required")).toBe(true);
    ac.abort();
    const decision = await p;
    expect(decision.kind).toBe("reject");
  });

  it("does NOT auto-approve non-shell tools even with shell allowlist", async () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({ writer, global: [/.*/] }); // matches everything
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "write_file", input: { path: "/tmp/x" } },
      description: "write",
    };
    const ac = new AbortController();
    const p = approver.request(req, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(approver.pendingCount()).toBe(1);
    ac.abort();
    await p;
  });
});

// ─── session allowlist ────────────────────────────────────────────────────

describe("session allowlist", () => {
  it("auto-approves matching tool names", async () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({ writer, session: ["read_file", "list_dir"] });
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "read_file", input: { path: "/tmp/x" } },
      description: "read",
    };
    const decision = await approver.request(req, new AbortController().signal);
    expect(decision).toEqual({ kind: "approve_once" });
  });
});

// ─── interactive prompt ───────────────────────────────────────────────────

describe("interactive prompt", () => {
  it("emits approval_required and resolves on approve_once", async () => {
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({ writer });
    const ac = new AbortController();
    const p = approver.request(sampleRequest(), ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.type === "approval_required")).toBe(true);
    const requestId = (events.find((e) => e.type === "approval_required") as
      | { requestId: string }
      | undefined)?.requestId;
    expect(requestId).toBeDefined();
    const ok = approver.resolveById(requestId!, { kind: "approve_once" });
    expect(ok).toBe(true);
    const decision = await p;
    expect(decision).toEqual({ kind: "approve_once" });
    const tr = events.find(
      (e) => e.type === "tool_result" && (e as { call_id: string }).call_id === "tu-1",
    );
    expect(tr).toBeDefined();
  });

  it("emits tool_result(is_error=true) on reject", async () => {
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({ writer });
    const ac = new AbortController();
    const p = approver.request(sampleRequest(), ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    const requestId = (events.find((e) => e.type === "approval_required") as
      | { requestId: string }
      | undefined)?.requestId!;
    approver.resolveById(requestId, { kind: "reject", reason: "nope" });
    const decision = await p;
    expect(decision).toEqual({ kind: "reject", reason: "nope" });
    const tr = events.find(
      (e) => e.type === "tool_result" && (e as { call_id: string }).call_id === "tu-1",
    ) as { is_error: boolean; reason?: string } | undefined;
    expect(tr?.is_error).toBe(true);
    expect(tr?.reason).toBe("nope");
  });

  it("resolveById with unknown requestId returns false", () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({ writer });
    expect(approver.resolveById("nope", { kind: "approve_once" })).toBe(false);
  });
});

// ─── timeout ──────────────────────────────────────────────────────────────

describe("timeout", () => {
  it("auto-rejects with reason 'approval timeout' after the timeout", async () => {
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({ writer, timeoutMs: 30 });
    const ac = new AbortController();
    const p = approver.request(sampleRequest(), ac.signal);
    const decision = await p;
    expect(decision).toEqual({ kind: "reject", reason: "approval timeout" });
    const tr = events.find(
      (e) => e.type === "tool_result" && (e as { call_id: string }).call_id === "tu-1",
    ) as { is_error: boolean; reason?: string } | undefined;
    expect(tr?.is_error).toBe(true);
    expect(tr?.reason).toBe("approval timeout");
  });
});

// ─── abort ────────────────────────────────────────────────────────────────

describe("abort signal", () => {
  it("rejects with reason 'aborted' when the signal fires", async () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({ writer, timeoutMs: 0 });
    const ac = new AbortController();
    const p = approver.request(sampleRequest(), ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const decision = await p;
    expect(decision).toEqual({ kind: "reject", reason: "aborted" });
    expect(approver.pendingCount()).toBe(0);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({ writer, timeoutMs: 0 });
    const ac = new AbortController();
    ac.abort();
    const decision = await approver.request(sampleRequest(), ac.signal);
    expect(decision).toEqual({ kind: "reject", reason: "aborted" });
  });
});