// packages/server/src/routes/health.ts
// T5.6 — Health check.
//
// Per the spec: `GET /api/health` returns `{ ok: true }`. Used by the UI
// to confirm the server is up before it tries to use it.

import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));
}
