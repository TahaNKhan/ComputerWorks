// packages/server/src/routes/sync.ts
// T17.2 — GET /api/sync.
//
// One persistent SSE stream per origin (per SharedWorker instance).
// Carries state-change events only: `message_appended`,
// `session_renamed`, `session_meta_updated`, `approval_required`,
// `tool_result`, `message_done`, `error`.
//
// Disjoint from the per-message SSE owned by the messages route —
// the leader's POST keeps streaming live per-turn events
// (`message_start`, `token`, `tool_call`, `done`) on its own
// response. Nothing crosses both streams; an originating tab sees
// `message_appended` for its own messages via the central SSE and
// dedupes via the `originator` field in the UI reducer.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createSSEWriter } from "../sse-writer.js";
import type { SyncHub } from "../sync-hub.js";

interface SyncDeps {
  syncHub: SyncHub;
}

export async function registerSyncRoute(
  app: FastifyInstance,
  deps: SyncDeps,
): Promise<void> {
  app.get("/api/sync", (_req: FastifyRequest, reply: FastifyReply) => {
    // T17.2 — open a long-lived SSE writer and register with the
    // hub. The connection lives until the client closes it (browser
    // tab backgrounded → EventSource/fetch dies → server sees
    // `close` and unregisters).
    const writer = createSSEWriter(reply);
    const unsubscribe = deps.syncHub.subscribe(writer);
    reply.raw.on("close", () => {
      unsubscribe();
    });
    return reply;
  });
}