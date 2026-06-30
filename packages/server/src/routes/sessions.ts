// packages/server/src/routes/sessions.ts
// T5.6 (continued) — Session CRUD routes.
//
// Endpoints:
//   GET    /api/sessions                — list
//   POST   /api/sessions                — create
//   GET    /api/sessions/:id            — fetch (meta + transcript)
//   PATCH  /api/sessions/:id            — rename / change cwd / change model
//   DELETE /api/sessions/:id            — delete
//   POST   /api/sessions/:id/fork       — fork at a message id (placeholder)

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { SessionStore } from "../session-store.js";

const CreateBody = z.object({
  cwd: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
}).transform((b) => ({
  cwd: b.cwd ?? process.cwd(),
  model: b.model ?? process.env.MINIMAX_DEFAULT_MODEL ?? "MiniMax-M3",
  title: b.title,
  // T19.3 — every create-with-title is a manual title. The store
  // records `titleSource: "manual"` so the LLM-driven rename tool
  // is permanently locked out for this session. A create WITHOUT a
  // title leaves the source as `"auto"` (default in the schema).
  titleSource: b.title !== undefined ? ("manual" as const) : undefined,
}));

const PatchBody = z
  .object({
    title: z.string().optional(),
    titleSource: z.enum(["auto", "manual"]).optional(),
    lastRenamedAtMessageCount: z.number().int().min(0).optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

/** T19.3 — infer `titleSource` from a PATCH. Rules:
 *  - If the patch sets a non-empty title and no explicit
 *    `titleSource` is provided, stamp `"manual"` (the user renamed).
 *  - If the patch clears the title (`""`) and no explicit
 *    `titleSource` is provided, stamp `"auto"` (reset to
 *    retitle-eligible).
 *  - If the patch only touches `titleSource` (escape hatch), pass
 *    it through unchanged.
 *  - If neither field is set, return null (no inference needed).
 *
 *  Called after the route's zod parse succeeds. Mutates a fresh
 *  copy of `parsed.data` so the route can pass it to `store.patch`
 *  unchanged. */
function inferTitleSourceFromPatch(
  body: z.infer<typeof PatchBody>,
): { titleSource: "auto" | "manual" } | null {
  if (body.titleSource !== undefined) {
    return { titleSource: body.titleSource };
  }
  if (body.title === undefined) {
    return null;
  }
  return { titleSource: body.title === "" ? "auto" : "manual" };
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  store: SessionStore,
): Promise<void> {
  app.get("/api/sessions", async () => {
    const list = await store.list();
    return list.map((s) => ({
      id: s.id,
      title: s.title,
      model: s.model,
      cwd: s.cwd,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  });

  app.post("/api/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const body = parsed.data;
    const meta = await store.create({
      cwd: body.cwd,
      model: body.model,
      title: body.title,
      ...(body.titleSource !== undefined ? { titleSource: body.titleSource } : {}),
    });
    return reply.code(201).send(meta);
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const meta = await store.get(id);
    if (!meta) return reply.code(404).send({ error: "session not found" });
    const messages = await store.getMessages(id);
    const audit: unknown[] = [];
    for await (const entry of store.readAudit(id)) audit.push(entry);
    return { meta, messages, audit };
  });

  app.patch("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    // T19.3 — infer titleSource from the patch shape. We merge the
    // inferred field into a shallow copy so the route stays a
    // thin pass-through to `store.patch`.
    const inferred = inferTitleSourceFromPatch(parsed.data);
    const merged = inferred
      ? { ...parsed.data, ...inferred }
      : parsed.data;
    try {
      const updated = await store.patch(id, merged);
      return updated;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        return reply.code(404).send({ error: "session not found" });
      }
      throw err;
    }
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await store.delete(id);
      return reply.code(204).send();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        return reply.code(404).send({ error: "session not found" });
      }
      throw err;
    }
  });

  // Fork is intentionally a placeholder for v1.5.
  app.post("/api/sessions/:id/fork", async (_req, reply) => {
    return reply.code(501).send({ error: "fork not implemented in v1" });
  });
}
