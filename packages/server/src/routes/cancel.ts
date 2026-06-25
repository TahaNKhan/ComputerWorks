// packages/server/src/routes/cancel.ts
// T5.8 — POST /api/sessions/:id/cancel aborts the in-flight turn.
//
// Looks up the session's runtime, calls abort() on its AbortController,
// and returns 204. If no turn is in flight for the session, returns
// 404 (there's nothing to cancel).

import type { FastifyInstance } from "fastify";
import { SessionRegistry } from "../session-runtime.js";

export async function registerCancelRoute(
  app: FastifyInstance,
  registry: SessionRegistry,
): Promise<void> {
  app.post("/api/sessions/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctrl = registry.cancel(id);
    if (!ctrl) {
      return reply.code(404).send({ error: "no turn in flight for that session" });
    }
    ctrl.abort();
    return reply.code(204).send();
  });
}
