// packages/server/src/routes/messages.test.ts
// T18 — integration test for session allowlist + pattern approval.
//
// We exercise the end-to-end flow at the `runAgentForSession`
// layer: a scripted provider that emits a `run_shell echo …` call,
// a real `InteractiveApprover` that prompts and is then resolved
// with `approve_for_session`, the `onAllowlistExtended` callback
// that mutates `meta.allowlist` via `store.patch`, and a SECOND
// agent run that should auto-approve via the now-populated
// allowlist (no prompt) and write a `decision: "auto_approve"`
// audit entry with the matching pattern.
//
// We don't go through the HTTP SSE layer here (that path is
// covered by app.test.ts; it requires waiting for the response
// to close, which means waiting for the agent to finish, which
// means the user already clicked approve). Instead, we drive
// `runAgentForSession` directly with an in-memory `SSEWriter`
// and use the approver's `resolveById` to deliver the decision
// when the approval_required event lands.
//
// The route has a known race: the `onAllowlistExtended` patch is
// fire-and-forget and can lose to the agent loop's `appendMessage`
// (which reads meta and writes it back). In this test we capture
// the patch's completion via a promise and await it BEFORE
// awaiting the agent run, so the patch is observable on disk
// when the test asserts.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realCore from "@computerworks/core";
import type { Provider, StreamEvent } from "@computerworks/core";
import { runAgentForSession } from "./messages.js";
import { InteractiveApprover } from "../interactive-approver.js";
import { SessionStore } from "../session-store.js";
import { SessionRegistry } from "../session-runtime.js";
import { SyncHub } from "../sync-hub.js";
import type { ServerEvent } from "../sse.js";
import type { SSEWriter } from "../sse-writer.js";
import type { Config } from "../config.js";

const realCoreSnapshot = { ...realCore };

mock.module("@computerworks/core", () => ({
  ...realCoreSnapshot,
  getDefaultAnthropicProvider: () => ({
    inferText: async (prompt: string): Promise<string> => {
      const m = prompt.match(/User Input:\s*(.+)$/);
      return m ? m[1]! : prompt;
    },
  }),
}));

let sessionsRoot: string;
let memoryRoot: string;

function makeConfig(): Config {
  return {
    providers: {
      anthropic: {
        baseUrl: "https://api.example.com",
        defaultModel: "test-model",
        betaHeaders: [],
        extraHeaders: {},
      },
    },
    defaultProvider: "anthropic",
    server: { host: "127.0.0.1", port: 4747, verbose: false },
    approval: {
      autoApprove: { read: true, write: false, shell: false },
      globalShellAllowlist: [],
      shellDenylist: [],
    },
    memory: { enabled: true, root: memoryRoot },
  };
}

/** Scripted provider. The agent loop calls chat() twice per turn
 *  (once before any tool call, once after the tool result is
 *  appended). On odd calls we yield a `run_shell echo hi`; on
 *  even calls we yield nothing extra (so the loop terminates
 *  because no tool_call was emitted). */
function echoShellProvider(): () => Provider {
  const cursor = { i: 0 };
  return () => ({
    id: "scripted",
    capabilities: { toolUse: true, promptCaching: false, vision: false },
    async *chat(): AsyncIterable<StreamEvent> {
      cursor.i++;
      yield { type: "message_start" };
      if (cursor.i % 2 === 1) {
        yield {
          type: "tool_call",
          call: {
            type: "tool_use",
            id: `c${cursor.i}`,
            name: "run_shell",
            input: { cmd: "echo hi" },
          },
        };
      }
      yield { type: "message_done", usage: { input: 1, output: 1 } };
    },
  });
}

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), "cw-msgs-"));
  memoryRoot = mkdtempSync(join(tmpdir(), "cw-mem-"));
  mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true });
  rmSync(memoryRoot, { recursive: true, force: true });
});

/** Read the audit.jsonl file for a session as an array of objects. */
function readAudit(root: string, id: string): Array<Record<string, unknown>> {
  const path = join(root, id, "audit.jsonl");
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

/** In-memory SSEWriter that records every event but never auto-ends. */
function recordingWriter(): { writer: SSEWriter; events: ServerEvent[] } {
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

/** Wait for the given event type to appear in `events`. Polls at
 *  10ms intervals up to `timeoutMs`. */
async function waitForEvent(
  events: ServerEvent[],
  predicate: (e: ServerEvent) => boolean,
  timeoutMs = 5_000,
): Promise<ServerEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const e of events) {
      if (predicate(e)) return e;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for event");
}

// ─── T18 — Session allowlist + pattern approval ───────────────────────────

describe("T18 — session allowlist + pattern approval", () => {
  it(
    "first call prompts; approve_for_session persists the pattern; second call auto-approves",
    async () => {
      const store = new SessionStore({ root: sessionsRoot });
      const registry = new SessionRegistry();
      const syncHub = new SyncHub();
      const createProvider = echoShellProvider();

      // Create the session via the store (mirrors the route handler).
      const meta = await store.create({
        cwd: process.cwd(),
        model: "test-model",
        allowlist: [],
      });
      const sessionId = meta.id;

      // ─── First call ────────────────────────────────────────────────
      // The route normally wires the onAllowlistExtended callback. We
      // do the same here: when the approver fires, append the pattern
      // to meta.allowlist and persist via store.patch. We capture the
      // patch's completion in a promise so the test can await it
      // deterministically (the route's fire-and-forget has a known
      // race with appendMessage).
      let allowlistExt: string[] = [];
      let onAllowlistExtendedPromise: Promise<unknown> =
        Promise.resolve();
      const onAllowlistExtended = (p: string): void => {
        if (allowlistExt.includes(p)) return;
        allowlistExt.push(p);
        onAllowlistExtendedPromise = store.patch(sessionId, {
          allowlist: allowlistExt,
        });
      };

      const { writer: firstWriter, events: firstEvents } = recordingWriter();
      const firstApprover = new InteractiveApprover(
        firstWriter,
        syncHub,
        sessionId,
        [], // session allowlist (empty)
        [], // global shell allowlist
        { timeoutMs: 5_000, onAllowlistExtended },
      );
      const firstStart = registry.startIfIdle(
        sessionId,
        firstApprover,
        "test-tab",
      );
      expect(firstStart.busy).toBe(false);

      // Kick off the first agent run; it will block on approval.
      const firstRun = runAgentForSession(
        {
          store,
          registry,
          config: makeConfig(),
          createProvider,
          syncHub,
        },
        sessionId,
        "first call",
        firstWriter,
        firstStart.runtime,
      );

      // Wait for the approval_required event.
      const approvalEv = await waitForEvent(
        firstEvents,
        (e) => e.type === "approval_required",
      );
      expect(approvalEv.type).toBe("approval_required");
      if (approvalEv.type !== "approval_required") throw new Error("unreachable");
      const reqId = approvalEv.requestId;
      expect(typeof reqId).toBe("string");
      expect(reqId.length).toBeGreaterThan(0);

      // Runtime should still be busy.
      expect(registry.isRunning(sessionId)).toBe(true);

      // Resolve the approval with approve_for_session.
      const resolved = firstApprover.resolveById(reqId, {
        kind: "approve_for_session",
        pattern: "tool:run_shell echo",
      });
      expect(resolved).toBe(true);

      // Wait for the onAllowlistExtended callback's store.patch to
      // complete. This serializes the patch against the agent
      // loop's appendMessage, so the test can observe the
      // allowlist on disk deterministically.
      await onAllowlistExtendedPromise;
      expect(allowlistExt).toEqual(["tool:run_shell echo"]);

      // The agent run should now complete (the tool runs, returns
      // echo hi, the agent loop emits message_done, runAgentForSession
      // returns).
      await firstRun;

      // The allowlist should be on disk now.
      const m = await store.get(sessionId);
      expect(m?.allowlist).toEqual(["tool:run_shell echo"]);

      // First audit entry: explicit approve_once (the allowlist only
      // existed after the approval, so this call was approved, not
      // auto-approved). Pattern is NOT set on this entry because the
      // decision was approve_for_session, not auto_approve.
      const firstAudit = readAudit(sessionsRoot, sessionId);
      expect(firstAudit.length).toBe(1);
      expect(firstAudit[0]!.tool).toBe("run_shell");
      expect(firstAudit[0]!.decision).toBe("approve_once");

      // ─── Second call: should auto-approve via the session allowlist
      // T18 — the second run uses a FRESH scripted provider so the
      // shared cursor isn't bumped by any other consumer of the
      // provider in the first run. (Pre-T19, generateTitle's
      // fire-and-forget chat call was the second consumer; T19
      // removed that path entirely.)
      const createProvider2 = echoShellProvider();
      const { writer: secondWriter, events: secondEvents } = recordingWriter();
      const secondApprover = new InteractiveApprover(
        secondWriter,
        syncHub,
        sessionId,
        (await store.get(sessionId))?.allowlist ?? [], // session allowlist populated by the first call
        [],
        { timeoutMs: 5_000 },
      );
      const secondStart = registry.startIfIdle(
        sessionId,
        secondApprover,
        "test-tab",
      );
      expect(secondStart.busy).toBe(false);

      await runAgentForSession(
        {
          store,
          registry,
          config: makeConfig(),
          createProvider: createProvider2,
          syncHub,
        },
        sessionId,
        "second call",
        secondWriter,
        secondStart.runtime,
      );

      // The second response should NOT contain an approval_required
      // frame (the allowlist covered it).
      const hasApprovalRequired = secondEvents.some(
        (e) => e.type === "approval_required",
      );
      expect(hasApprovalRequired).toBe(false);
      // It SHOULD contain a tool_result.
      const hasToolResult = secondEvents.some(
        (e) => e.type === "tool_result",
      );
      expect(hasToolResult).toBe(true);

      // Wait for the audit log to update.
      let secondAudit: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 200; i++) {
        secondAudit = readAudit(sessionsRoot, sessionId);
        if (secondAudit.length >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(secondAudit.length).toBe(2);
      const secondEntry = secondAudit[1]!;
      expect(secondEntry.tool).toBe("run_shell");
      expect(secondEntry.decision).toBe("auto_approve");
      expect(secondEntry.pattern).toBe("tool:run_shell echo");
    },
    30_000,
  );
});
