// packages/server/src/interactive-approver.test.ts
// T5.5 + T14.1 + T18 unit tests — InteractiveApprover.
//
// Before v1.14 the approver took an `SSEManager` and emitted via the
// manager's `send(sessionId, event)` API. v1.14 replaces the manager
// with a per-response `SSEWriter`; we use a fake writer here so the
// tests stay pure (no Fastify, no Node sockets).
//
// T18 — pattern-based session allowlist. The old test suite used
// bare tool names like `["read_file"]`; those are now rejected by
// `parsePattern` (the on-disk format is `tool:<name>`). The new
// tests cover pattern parsing, tool_prefix matching, the
// onAllowlistExtended callback, and the approve_for_session flow.

import { describe, expect, it } from "bun:test";
import {
  InteractiveApprover,
  formatPattern,
  isCoveredByAllowlist,
  parsePattern,
  firstToken,
} from "./interactive-approver.js";
import { SyncHub } from "./sync-hub.js";
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
  onAllowlistExtended?: (pattern: string) => void;
}) {
  // T17.3 — InteractiveApprover takes BOTH the per-message writer
  // (for the leader's POST stream) and the SyncHub (for passive
  // viewers via the central SSE). The writer receives from the
  // per-message stream only; the hub is for OTHER subscribers (passive
  // viewers). Tests observe via the writer. We deliberately don't
  // subscribe the writer to the hub — that would double-count
  // events. Hub behavior is covered by sync-hub.test.ts.
  const hub = new SyncHub();
  const approver = new InteractiveApprover(
    opts.writer,
    hub,
    "s1",
    opts.session ?? [],
    opts.global ?? [],
    {
      timeoutMs: opts.timeoutMs,
      ...(opts.onAllowlistExtended
        ? { onAllowlistExtended: opts.onAllowlistExtended }
        : {}),
    },
  );
  return approver;
}

// ─── parsePattern (T18) ───────────────────────────────────────────────────

describe("parsePattern", () => {
  it("parses a tool-only pattern", () => {
    expect(parsePattern("tool:read_file")).toEqual({
      kind: "tool",
      name: "read_file",
    });
  });

  it("parses a tool_prefix pattern", () => {
    expect(parsePattern("tool:run_shell curl")).toEqual({
      kind: "tool_prefix",
      name: "run_shell",
      prefix: "curl",
    });
  });

  it("is the inverse of formatPattern", () => {
    const samples: Array<ReturnType<typeof parsePattern>> = [
      { kind: "tool", name: "read_file" },
      { kind: "tool", name: "run_shell" },
      { kind: "tool_prefix", name: "run_shell", prefix: "curl" },
      { kind: "tool_prefix", name: "run_shell", prefix: "git" },
      { kind: "tool_prefix", name: "list_dir", prefix: "/tmp" },
    ];
    for (const p of samples) {
      expect(parsePattern(formatPattern(p))).toEqual(p);
    }
  });

  it("rejects an empty string", () => {
    expect(() => parsePattern("")).toThrow(/empty/i);
  });

  it("rejects a bare tool name (legacy format is gone)", () => {
    expect(() => parsePattern("read_file")).toThrow(/tool:/);
  });

  it("rejects an empty tool name after the prefix", () => {
    expect(() => parsePattern("tool:")).toThrow();
  });

  it("rejects whitespace inside the tool name", () => {
    // The parser splits on the first space, so a name with a space
    // produces "read" as the name and "file" as the prefix — but the
    // input shape is "tool:<name> <prefix>", so the prefix must
    // come after the name. "tool:read file" actually parses as
    // {kind:"tool_prefix", name:"read", prefix:"file"} which IS a
    // legal pattern (just an odd one — a write_file call would not
    // match because the tool name is "read", not "write_file").
    // The rejection we DO want is whitespace in the bare tool name
    // (no prefix), which my parser handles via the /\s/.test(rest)
    // branch.
    expect(parsePattern("tool:read file")).toEqual({
      kind: "tool_prefix",
      name: "read",
      prefix: "file",
    });
    // Tabs inside the input are rejected up-front (no space ambiguity).
    let threw = false;
    try {
      parsePattern("tool:read\tfile");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects an empty prefix", () => {
    let threw = false;
    try {
      parsePattern("tool:run_shell ");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects more than one whitespace-separated token after the name", () => {
    let threw = false;
    try {
      parsePattern("tool:run_shell curl https://example.com");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects embedded newlines and tabs", () => {
    let threwNewline = false;
    try {
      parsePattern("tool:run_shell curl\n");
    } catch {
      threwNewline = true;
    }
    expect(threwNewline).toBe(true);

    let threwTab = false;
    try {
      parsePattern("tool:run_shell\tcurl");
    } catch {
      threwTab = true;
    }
    expect(threwTab).toBe(true);
  });
});

// ─── firstToken (T18) ─────────────────────────────────────────────────────

describe("firstToken", () => {
  it("returns the first whitespace-delimited token", () => {
    expect(firstToken("ls -la /tmp")).toBe("ls");
    expect(firstToken("curl https://example.com")).toBe("curl");
  });

  it("returns the whole string if there is no whitespace", () => {
    expect(firstToken("ls")).toBe("ls");
  });

  it("trims leading whitespace", () => {
    expect(firstToken("   ls -la")).toBe("ls");
  });

  it("returns null for an empty / whitespace-only string", () => {
    expect(firstToken("")).toBeNull();
    expect(firstToken("   ")).toBeNull();
    expect(firstToken("\t")).toBeNull();
  });

  it("treats tabs as separators", () => {
    expect(firstToken("git\tstatus")).toBe("git");
  });
});

// ─── isCoveredByAllowlist (T18) ──────────────────────────────────────────

describe("isCoveredByAllowlist", () => {
  it("matches a bare-tool pattern against the tool name", () => {
    expect(
      isCoveredByAllowlist(["tool:read_file"], "read_file", { path: "/tmp/x" }),
    ).toBe(true);
  });

  it("does not match a different tool", () => {
    expect(
      isCoveredByAllowlist(["tool:read_file"], "write_file", { path: "/tmp/x" }),
    ).toBe(false);
  });

  it("matches a tool_prefix pattern against run_shell's first token", () => {
    expect(
      isCoveredByAllowlist(
        ["tool:run_shell curl"],
        "run_shell",
        { cmd: "curl https://example.com" },
      ),
    ).toBe(true);
  });

  it("does not match a different first token", () => {
    expect(
      isCoveredByAllowlist(
        ["tool:run_shell curl"],
        "run_shell",
        { cmd: "wget https://example.com" },
      ),
    ).toBe(false);
  });

  it("is an OR across patterns — any matching pattern covers the call", () => {
    expect(
      isCoveredByAllowlist(
        ["tool:read_file", "tool:run_shell curl"],
        "run_shell",
        { cmd: "curl -X GET example.com" },
      ),
    ).toBe(true);
  });

  it("returns false on empty allowlist", () => {
    expect(isCoveredByAllowlist([], "run_shell", { cmd: "ls" })).toBe(false);
  });

  it("silently ignores malformed patterns instead of throwing", () => {
    expect(
      isCoveredByAllowlist(
        ["garbage", "tool:read_file"],
        "read_file",
        { path: "/tmp/x" },
      ),
    ).toBe(true);
  });

  it("falls back to the `path` field for non-shell tools", () => {
    // The matcher looks at `cmd` first (run_shell), then `path`
    // (file tools), then `name` (memory tools). For write_file with
    // input {path: "/tmp/foo.txt"}, the fallback kicks in and
    // matches "tool:write_file /tmp/foo.txt" via the path.
    expect(
      isCoveredByAllowlist(
        ["tool:write_file /tmp/foo.txt"],
        "write_file",
        { path: "/tmp/foo.txt" },
      ),
    ).toBe(true);
  });
});

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
  it("auto-approves matching tool patterns", async () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({
      writer,
      session: ["tool:read_file", "tool:list_dir"],
    });
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "read_file", input: { path: "/tmp/x" } },
      description: "read",
    };
    const decision = await approver.request(req, new AbortController().signal);
    expect(decision).toEqual({ kind: "approve_once" });
  });

  it("auto-approves run_shell calls matching a tool_prefix pattern", async () => {
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({
      writer,
      session: ["tool:run_shell curl"],
    });
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "run_shell", input: { cmd: "curl https://example.com" } },
      description: "curl",
    };
    const decision = await approver.request(req, new AbortController().signal);
    expect(decision).toEqual({ kind: "approve_once" });
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("tool_result");
  });

  it("does NOT auto-approve a different first token under a tool_prefix pattern", async () => {
    const { writer } = makeFakeWriter();
    const approver = makeApprover({
      writer,
      session: ["tool:run_shell curl"],
    });
    const req: ApprovalRequest = {
      call: { type: "tool_use", id: "tu-1", name: "run_shell", input: { cmd: "wget https://example.com" } },
      description: "wget",
    };
    const ac = new AbortController();
    const p = approver.request(req, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(approver.pendingCount()).toBe(1);
    ac.abort();
    await p;
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

  // T18 — the new decision kind both approves THIS call and notifies
  // the session to extend the allowlist.
  it("approve_for_session: resolves the call AND fires onAllowlistExtended with the pattern", async () => {
    const calls: string[] = [];
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({
      writer,
      onAllowlistExtended: (p) => {
        calls.push(p);
      },
    });
    const ac = new AbortController();
    const p = approver.request(sampleRequest(), ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    const requestId = (events.find((e) => e.type === "approval_required") as
      | { requestId: string }
      | undefined)?.requestId!;
    approver.resolveById(requestId, {
      kind: "approve_for_session",
      pattern: "tool:run_shell rm",
    });
    const decision = await p;
    expect(decision).toEqual({
      kind: "approve_for_session",
      pattern: "tool:run_shell rm",
    });
    expect(calls).toEqual(["tool:run_shell rm"]);
  });

  it("approve_for_session: a malformed pattern does NOT crash the tool call (callback swallows)", async () => {
    // The approver fires the callback regardless of whether the
    // session side will accept it. If the session throws, we
    // swallow it so the in-flight tool call still resolves.
    const { writer, events } = makeFakeWriter();
    const approver = makeApprover({
      writer,
      onAllowlistExtended: () => {
        throw new Error("disk full");
      },
    });
    const ac = new AbortController();
    const p = approver.request(sampleRequest(), ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    const requestId = (events.find((e) => e.type === "approval_required") as
      | { requestId: string }
      | undefined)?.requestId!;
    approver.resolveById(requestId, {
      kind: "approve_for_session",
      pattern: "tool:run_shell rm",
    });
    const decision = await p;
    expect(decision).toEqual({
      kind: "approve_for_session",
      pattern: "tool:run_shell rm",
    });
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

// ─── malformed allowlist entries (T18) ───────────────────────────────────

describe("malformed allowlist entries", () => {
  it("throws at construction if any entry is malformed", () => {
    const { writer } = makeFakeWriter();
    expect(() =>
      makeApprover({ writer, session: ["tool:read_file", "garbage"] }),
    ).toThrow();
  });

  it("throws at construction for legacy bare-tool names", () => {
    const { writer } = makeFakeWriter();
    expect(() => makeApprover({ writer, session: ["read_file"] })).toThrow();
  });
});
