// packages/server/src/routes/approve.ts
// T14.1 — POST /api/sessions/:id/approve resolves a pending approval.
//
// Before v1.14 this route looked up the approver via a global
// `ApproverRegistry` keyed by sessionId. v1.14 drops the registry;
// the in-flight turn's `InteractiveApprover` lives on the
// `SessionRuntime` registered for that session. Since there is at
// most one in-flight turn per session, the lookup is unambiguous.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { SessionRegistry } from "../session-runtime.js";

const Body = z.object({
  requestId: z.string().min(1),
  decision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("approve_once") }),
    z.object({ kind: z.literal("approve_for_session"), pattern: z.string() }),
    z.object({ kind: z.literal("reject"), reason: z.string() }),
    z.object({
      kind: z.literal("edit"),
      newInput: z.unknown().refine((v) => v !== undefined, {
        message: "edit decision requires newInput",
      }),
    }),
  ]),
});

export async function registerApproveRoute(
  app: FastifyInstance,
  registry: SessionRegistry,
): Promise<void> {
  app.post("/api/sessions/:id/approve", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const { id } = req.params as { id: string };
    const runtime = registry.get(id);
    if (!runtime) {
      return reply.code(404).send({ error: "no turn in flight for that session" });
    }
    const ok = runtime.approver.resolveById(parsed.data.requestId, parsed.data.decision);
    if (!ok) {
      return reply.code(404).send({ error: "no pending approval with that id" });
    }
    return reply.code(204).send();
  });
}