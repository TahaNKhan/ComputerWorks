// packages/server/src/routes/approve.ts
// T5.7 — POST /api/sessions/:id/approve resolves a pending approval.
//
// The InteractiveApprover emits an `approval_required` SSE event with a
// `requestId`; the UI calls this endpoint with that requestId and a
// decision. The approver's promise resolves and the agent loop
// continues.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { ApproverRegistry } from "../interactive-approver.js";

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
  approvers: ApproverRegistry,
): Promise<void> {
  app.post("/api/sessions/:id/approve", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const ok = approvers.resolve(parsed.data.requestId, parsed.data.decision);
    if (!ok) {
      return reply.code(404).send({ error: "no pending approval with that id" });
    }
    return reply.code(204).send();
  });
}
