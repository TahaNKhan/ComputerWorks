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
// The InteractiveApprover is registered on the SessionRuntime so
// /approve can find its (requestId → resolver) map without a global
// registry.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { runTurn, AutoApprover, type Approver, type AgentEvent } from "@computerworks/agent";
import type {
  Message, Provider, ProviderOverrides, ToolDefinition,
} from "@computerworks/core";
import { InteractiveApprover } from "../interactive-approver.js";
import { ToolRegistry } from "@computerworks/agent";
import { SessionRegistry, type SessionRuntime } from "../session-runtime.js";
import { SessionStore } from "../session-store.js";
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

export interface RunAgentDeps {
  store: SessionStore;
  registry: SessionRegistry;
  config: Config;
  /** Provider factory: given overrides, returns a Provider instance. */
  createProvider: (overrides?: ProviderOverrides) => Provider;
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

  try {
    await deps.store.appendMessage(sessionId, {
      role: "user",
      content: userContent,
    });

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
          if (ev.type === "tool_result") {
            void deps.store.appendAudit(sessionId, {
              ts: new Date().toISOString(),
              sessionId,
              callId: ev.call_id,
              tool: "<unknown>",
              decision: ev.approved ? "approve_once" : "reject",
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
      }
      throw err;
    }

    // Persist whatever messages the loop appended to history
    // (assistant text, tool_use, tool_results, terminal assistant).
    const newMessages = history.slice(initialHistoryLength);
    for (const msg of newMessages) {
      await deps.store.appendMessage(sessionId, msg);
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
          if (!writer.closed) writer.write(ev);
        },
      },
      sessionId,
    );

    return eventCount;
  } finally {
    deps.registry.finish(sessionId);
  }
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
    const approver = new InteractiveApprover(writer, id, [], [], {
      timeoutMs: 5 * 60_000,
    });
    const start = deps.registry.startIfIdle(id, approver);
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