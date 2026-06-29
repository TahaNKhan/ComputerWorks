// packages/server/src/routes/messages.ts
// T14.1 — POST /api/sessions/:id/messages opens an SSE stream in its
// own response and writes events to it as the agent runs.
//
// v1.0–v1.13 returned 204 immediately and ran the agent in the
// background while a separate GET /api/sessions/:id/stream route
// served the events. v1.14 collapses that into one request: the
// response itself is the SSE channel.
//
// Lifecycle:
//   - POST arrives → set text/event-stream headers → hijack the reply
//   - build an SSEWriter wrapping the reply
//   - start the agent loop; every onEvent goes to the writer
//   - when the loop completes (or errors) write the terminal frame
//     and end the response
//   - if the client disconnects mid-run, the writer flips `closed`
//     and the loop's AbortSignal fires (see session-runtime + agent
//     loop)
//
// T17.2 — `InteractiveApprover` no longer takes a writer; it writes
// `approval_required` / `tool_result` to the central SSE via
// SyncHub. The leader's POST stream is therefore per-turn-lifecycle
// only; cross-tab state (new messages, approvals) flows via the
// central SSE owned by the SharedWorker.
//
// The messages route reads `X-CW-Tab` from the POST headers (a UUID
// the SharedWorker assigned on connect) and stamps it on every
// `message_appended` event it broadcasts. The originating tab
// dedupes by `originator === tabId` in the reducer; re-connecting
// tabs dedupe by `message.id`.
//
// T18 — Pattern-based per-session approval. The route now:
//   1. reads `meta.allowlist` from the session and hands the
//      InteractiveApprover a snapshot at request time
//   2. provides an `onAllowlistExtended` callback that appends the
//      new pattern to `meta.allowlist` and persists via store.patch
//   3. logs `decision: "auto_approve"` + the matching pattern to
//      the audit log when the session allowlist covers a call

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { runTurn, AutoApprover, type Approver, type AgentEvent } from "@computerworks/agent";
import type {
  Message, Provider, ProviderOverrides, ToolDefinition,
} from "@computerworks/core";
import {
  InteractiveApprover,
  isCoveredByAllowlist,
  parsePattern,
} from "../interactive-approver.js";
import { ToolRegistry } from "@computerworks/agent";
import { SessionRegistry, type SessionRuntime } from "../session-runtime.js";
import { SessionStore } from "../session-store.js";
import { SyncHub } from "../sync-hub.js";
import { createSSEWriter, type SSEWriter } from "../sse-writer.js";
import type { ServerEvent } from "../sse.js";
import type { Config } from "../config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { defaultTools } from "../tools/index.js";
import { generateTitle } from "../title-generator.js";
import { join } from "node:path";
import { homedir } from "node:os";

const MessageBody = z.object({
  content: z.string().min(1),
  overrides: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
});

/** Header name for the tab UUID assigned by the SharedWorker. */
export const TAB_ID_HEADER = "x-cw-tab";

export interface RunAgentDeps {
  store: SessionStore;
  registry: SessionRegistry;
  config: Config;
  /** Provider factory: given overrides, returns a Provider instance. */
  createProvider: (overrides?: ProviderOverrides) => Provider;
  /** T17.2 — central SSE hub; broadcasts `message_appended` (and is
   *  used by `InteractiveApprover` for `approval_required` /
   *  `tool_result`). Required. */
  syncHub: SyncHub;
}

function defaultMemoryRoot(): string {
  return join(homedir(), ".computerworks", "memory");
}

/**
 * Run an agent turn for a single user message, streaming events to
 * `writer`. Returns the number of agent events emitted (excluding
 * the final `done`).
 *
 * Public so tests can exercise it without going through HTTP.
 */
export async function runAgentForSession(
  deps: RunAgentDeps,
  sessionId: string,
  userContent: string,
  writer: SSEWriter,
  runtime: SessionRuntime,
  perRequestOverrides?: ProviderOverrides,
  options: { autoApprove?: boolean } = {},
): Promise<number> {
  const signal = runtime.controller.signal;

  // T17.2 — originator is the tab UUID from the SharedWorker.
  // Falls back to "anonymous" for clients that bypass the worker
  // (curl, e2e tests).
  const originator = runtime.originator ?? "anonymous";

  const broadcastMessage = (msg: Message): void => {
    deps.syncHub.broadcast({
      type: "message_appended",
      sessionId,
      message: { role: msg.role, content: msg.content },
      originator,
      ts: new Date().toISOString(),
    });
  };

  try {
    const userMsg: Message = {
      role: "user",
      content: userContent,
    };
    await deps.store.appendMessage(sessionId, userMsg);
    broadcastMessage(userMsg);

    const meta = await deps.store.get(sessionId);
    if (!meta) throw new Error("session disappeared");

    const provider = deps.createProvider(perRequestOverrides);
    const memoryRoot = meta.memoryRoot ?? defaultMemoryRoot();
    const { tools, memory } = defaultTools({ memoryRoot });

    const model = meta.model;

    const system = await buildSystemPrompt({
      memory,
      cwd: meta.cwd,
      model,
    });

    // Load prior history.
    const history: Message[] = [];
    for await (const m of deps.store.readMessages(sessionId)) history.push(m);
    const initialHistoryLength = history.length;

    let approver: Approver;
    if (options.autoApprove) {
      approver = new AutoApprover(() => ({ kind: "approve_once" }));
    } else {
      // The InteractiveApprover was constructed in the route handler
      // and stored on the runtime. It IS the `Approver` interface
      // (and more — it has `resolveById` for the /approve route).
      approver = runtime.approver as unknown as Approver;
    }

    const toolRegistry = new ToolRegistry();
    for (const t of tools as ToolDefinition[]) toolRegistry.register(t);

    // T18 — compute the matching pattern once per tool_result so
    // the audit log can record WHY an auto-approved call was
    // auto-approved. This is duplicated work with the approver
    // (which also checks the allowlist) but it keeps the approver
    // ignorant of the audit log.
    const matchingPattern = (
      toolName: string,
      input: Record<string, unknown>,
    ): string | undefined => {
      for (const p of meta.allowlist) {
        try {
          if (isCoveredByAllowlist([p], toolName, input)) return p;
        } catch {
          continue;
        }
      }
      return undefined;
    };

    let eventCount = 0;
    try {
      await runTurn({
        provider,
        model,
        system,
        history,
        registry: toolRegistry,
        approver,
        signal,
        maxIterations: 25,
        onEvent: (ev: AgentEvent) => {
          eventCount++;
          // Persist an audit entry for every tool_result so the
          // on-disk log captures the decision (matches Phase 5).
          // T18 — also stamp the tool name (was "<unknown>" pre-12.x)
          // and the session-allowlist pattern when auto-approved.
          if (ev.type === "tool_result") {
            // T18 — look up the tool name (was "<unknown>" pre-12.x)
            // and the session-allowlist pattern when auto-approved.
            const toolName = lookupToolName(history, ev.call_id);
            const pattern =
              toolName !== "<unknown>"
                ? matchingPattern(
                    toolName,
                    (lookupToolInput(history, ev.call_id) ??
                      {}) as Record<string, unknown>,
                  )
                : undefined;
            void deps.store.appendAudit(sessionId, {
              ts: new Date().toISOString(),
              sessionId,
              callId: ev.call_id,
              tool: toolName,
              decision:
                ev.approved && pattern
                  ? "auto_approve"
                  : ev.approved
                    ? "approve_once"
                    : "reject",
              ...(pattern ? { pattern } : {}),
              ...(ev.reason ? { reason: ev.reason } : {}),
              isError: ev.is_error,
            });
          }
          const se = mapAgentEventToServer(ev);
          if (se) writer.write(se);
          // If the client disconnected mid-stream, abort the loop
          // so we don't keep doing expensive work.
          if (writer.closed && !signal.aborted) {
            runtime.controller.abort();
          }
        },
      });
    } catch (err) {
      // Surface loop errors to the client (if still connected).
      if (!writer.closed) {
        const message = err instanceof Error ? err.message : String(err);
        // Only emit a non-AbortError as `error`; aborts are normal.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          writer.write({ type: "error", message });
        }
      }
      // Persist whatever messages the loop appended to history.
      const newMessages = history.slice(initialHistoryLength);
      for (const msg of newMessages) {
        await deps.store.appendMessage(sessionId, msg);
        broadcastMessage(msg);
      }
      throw err;
    }

    // Persist whatever messages the loop appended to history
    // (assistant text, tool_use, tool_results, terminal assistant).
    const newMessages = history.slice(initialHistoryLength);
    for (const msg of newMessages) {
      await deps.store.appendMessage(sessionId, msg);
      broadcastMessage(msg);
    }

    // T12.2 — Fire-and-forget LLM-generated title. Skipped when the
    // session already has a title (manual rename, or
    // createSession({ title })). Errors are logged + swallowed inside
    // generateTitle so the route's return path is unaffected.
    void generateTitle(
      {
        store: deps.store,
        createProvider: deps.createProvider,
        notify: (ev) => {
          // T17.2 — title updates also route via the central SSE so
          // every tab on this origin sees the rename.
          deps.syncHub.broadcast(ev);
        },
      },
      sessionId,
    );

    return eventCount;
  } finally {
    deps.registry.finish(sessionId);
  }
}

/** Find the tool name for a call_id by scanning assistant messages in
 *  history. Used to enrich audit entries — the agent loop's
 *  `tool_result` event currently only carries `call_id`, not the tool
 *  name. Returns "<unknown>" if not found. */
function lookupToolName(history: Message[], callId: string): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (typeof b !== "object" || b === null) continue;
      const blk = b as { type?: string; id?: string; name?: string };
      if (blk.type === "tool_use" && blk.id === callId && typeof blk.name === "string") {
        return blk.name;
      }
    }
  }
  return "<unknown>";
}

/** Find the tool input for a call_id by scanning assistant messages.
 *  Returns null if not found. */
function lookupToolInput(history: Message[], callId: string): unknown | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (typeof b !== "object" || b === null) continue;
      const blk = b as { type?: string; id?: string; input?: unknown };
      if (blk.type === "tool_use" && blk.id === callId) {
        return blk.input ?? {};
      }
    }
  }
  return null;
}

function mapAgentEventToServer(ev: AgentEvent): ServerEvent | null {
  switch (ev.type) {
    case "token":
      return { type: "token", delta: ev.delta };
    case "tool_call":
      return { type: "tool_call", call: ev.call };
    case "tool_result":
      return {
        type: "tool_result",
        call_id: ev.call_id,
        result: ev.result,
        is_error: ev.is_error,
        approved: ev.approved,
        ...(ev.reason ? { reason: ev.reason } : {}),
      };
    case "error":
      return { type: "error", message: ev.message };
  }
  // message_start / message_done / turn_done / done are loop-internal;
  // we don't forward them as wire events. The response closes (with a
  // single terminal `done` frame from SSEWriter.end) once the loop
  // finishes.
  return null;
}

export async function registerMessagesRoute(
  app: FastifyInstance,
  deps: RunAgentDeps,
  options: { autoApprove?: boolean } = {},
): Promise<void> {
  app.post("/api/sessions/:id/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const parsed = MessageBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const meta = await deps.store.get(id);
    if (!meta) return reply.code(404).send({ error: "session not found" });
    if (deps.registry.isRunning(id)) {
      return reply.code(409).send({ error: "a turn is already in flight" });
    }

    // Build the SSE writer BEFORE we register the runtime, so a
    // client disconnect during startup still flips `closed` and we
    // don't leak an orphaned runtime.
    const writer = createSSEWriter(reply);
    // T17.2 — read the tab UUID (assigned by the SharedWorker). The
    // approver stashes it on the runtime via originator.
    const tabIdHeader = req.headers[TAB_ID_HEADER];
    const originator = typeof tabIdHeader === "string" && tabIdHeader.length > 0
      ? tabIdHeader
      : "anonymous";

    // T18 — the approver needs the session's allowlist at construction
    // time so it can eagerly parse patterns and (later) auto-approve
    // matching calls. We also wire `onAllowlistExtended` so an
    // `approve_for_session` decision persists the new pattern to
    // meta.allowlist via store.patch. Persistence is best-effort: a
    // failed patch logs + swallows; the in-flight tool call still
    // resolves with approve_once semantics.
    const onAllowlistExtended = (pattern: string): void => {
      // The approver already threw if the existing allowlist
      // contained a malformed pattern, but the *new* pattern is
      // user-supplied. Defensively re-parse.
      try {
        parsePattern(pattern);
      } catch {
        return;
      }
      // De-dupe: if the pattern is already in the allowlist, do
      // nothing (idempotent). This avoids two patches racing for
      // the same pattern on a repeated click.
      if (meta.allowlist.includes(pattern)) return;
      const next = [...meta.allowlist, pattern];
      // Fire-and-forget: store.patch writes meta.json atomically.
      // We don't await — the agent loop doesn't block on this.
      deps.store
        .patch(id, { allowlist: next })
        .catch((err: unknown) => {
          // Best-effort. Log to stderr so operators can spot it.
          // The in-flight tool call still resolves with approve_once
          // semantics; the next turn will see the unchanged allowlist
          // and prompt again. The user gets a clear "you approved
          // for session but it didn't stick" experience only if they
          // look at meta.json, which is acceptable for v1.
          // eslint-disable-next-line no-console
          console.error(
            `[cw] failed to persist session allowlist extension:`,
            err instanceof Error ? err.message : String(err),
          );
        });
    };

    // T17.3 — the approver writes approval_required + tool_result to
    // BOTH the leader's per-message stream AND the SyncHub so the
    // leader's tool calls never depend on the SharedWorker being
    // connected. The reducer's `removeToolCall` is idempotent, so
    // the leader receiving the event twice is harmless.
    const approver = new InteractiveApprover(
      writer,
      deps.syncHub,
      id,
      meta.allowlist,
      [],
      {
        timeoutMs: 5 * 60_000,
        onAllowlistExtended,
      },
    );
    const start = deps.registry.startIfIdle(id, approver, originator);
    if (start.busy) {
      // Race: another request started a turn between our check
      // and our register. Emit an error frame and bail.
      writer.write({ type: "error", message: "a turn is already in flight" });
      writer.end();
      return;
    }

    // Fire and forget: the response stream is the SSE channel; we
    // don't await the agent here because we want the response to
    // remain open while the agent streams.
    void runAgentForSession(
      deps,
      id,
      parsed.data.content,
      writer,
      start.runtime,
      parsed.data.overrides,
      options,
    ).catch((err: unknown) => {
      // Errors are already surfaced via the writer inside
      // runAgentForSession; this catch is just defense-in-depth.
      if (!writer.closed) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          writer.write({ type: "error", message });
        } catch { /* ignore */ }
      }
    }).finally(() => {
      if (!writer.closed) writer.end();
    });

    // The reply is hijacked by createSSEWriter; Fastify must not
    // try to serialize a return value.
    return reply;
  });
}
