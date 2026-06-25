// packages/server/src/routes/messages.ts
// T5.7 — POST /api/sessions/:id/messages kicks off a turn.
//
// On success: returns 204 immediately and runs the turn in the
// background, streaming events via the SSE manager. On a busy session
// (a turn is already in flight) returns 409 Conflict.
//
// The actual agent invocation lives in runAgentForSession() so we can
// test it with app.inject() without going through HTTP.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { runTurn } from "@computerworks/agent";
import type {
  Message, Provider, ProviderOverrides, ToolDefinition,
} from "@computerworks/core";
import { InteractiveApprover, ApproverRegistry } from "../interactive-approver.js";
import { ToolRegistry } from "@computerworks/agent";
import { SessionRegistry } from "../session-runtime.js";
import { SessionStore } from "../session-store.js";
import { SSEManager, type ServerEvent } from "../sse.js";
import type { Config } from "../config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { defaultTools } from "../tools/index.js";
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
  sse: SSEManager;
  registry: SessionRegistry;
  approvers: ApproverRegistry;
  config: Config;
  /** Provider factory: given overrides, returns a Provider instance. */
  createProvider: (overrides?: ProviderOverrides) => Provider;
}

function defaultMemoryRoot(): string {
  return join(homedir(), ".computerworks", "memory");
}

/**
 * Run an agent turn for a single user message.
 *
 * @returns the number of agent events emitted (excluding the final `done`)
 */
export async function runAgentForSession(
  deps: RunAgentDeps,
  sessionId: string,
  userContent: string,
  perRequestOverrides?: ProviderOverrides,
): Promise<number> {
  const start = deps.registry.startIfIdle(sessionId);
  if (start.busy) {
    throw new Error("busy");
  }
  const { runtime } = start;
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

    const model =
      perRequestOverrides && "apiKey" in perRequestOverrides
        ? meta.model
        : meta.model;

    const system = await buildSystemPrompt({
      memory,
      cwd: meta.cwd,
      model,
    });

    // Load prior history (sync via listMessages helper or async iter).
    const history: Message[] = [];
    for await (const m of deps.store.readMessages(sessionId)) history.push(m);

    const approver = new InteractiveApprover(deps.sse, sessionId, [], [], {
      timeoutMs: 5 * 60_000,
    });
    deps.approvers.register(approver);

    const toolRegistry = new ToolRegistry();
    for (const t of tools as ToolDefinition[]) toolRegistry.register(t);

    let eventCount = 0;
    await runTurn({
      provider,
      model,
      system,
      history,
      registry: toolRegistry,
      approver,
      signal,
      maxIterations: 25,
      onEvent: (ev) => {
        eventCount++;
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
        if (se) deps.sse.send(sessionId, se);
      },
    });

    return eventCount;
  } finally {
    deps.registry.finish(sessionId);
    deps.approvers.unregister(sessionId);
  }
}

function mapAgentEventToServer(
  ev: import("@computerworks/agent").AgentEvent,
): ServerEvent | null {
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
    case "turn_done":
      return { type: "done" };
    case "error":
      return { type: "error", message: ev.message };
  }
}

export async function registerMessagesRoute(
  app: FastifyInstance,
  deps: RunAgentDeps,
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

    void runAgentForSession(deps, id, parsed.data.content, parsed.data.overrides)
      .catch((err) => {
        try {
          deps.sse.send(id, { type: "error", message: (err as Error).message });
        } catch { /* session may be gone */ }
      });

    return reply.code(204).send();
  });
}
