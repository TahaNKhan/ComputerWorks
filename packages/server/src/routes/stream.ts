// packages/server/src/routes/stream.ts
// T5.7 — GET /api/sessions/:id/stream returns the SSE event stream.

import type { FastifyInstance } from "fastify";
import { SSEManager } from "../sse.js";

export async function registerStreamRoute(
  app: FastifyInstance,
  sse: SSEManager,
): Promise<void> {
  app.get("/api/sessions/:id/stream", (req, reply) => {
    const { id } = req.params as { id: string };
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders?.();
    reply.hijack();

    const stream = sse.subscribe(id);
    (async () => {
      try {
        for await (const chunk of stream) {
          if (!reply.raw.write(chunk)) {
            await new Promise<void>((r) => reply.raw.once("drain", r));
          }
        }
      } catch {
        /* client disconnected */
      }
    })();

    req.raw.on("close", () => {
      // The async iterator returned by subscribe disposes itself when
      // the consumer breaks out; we don't need explicit cleanup here
      // because the for-await loop above will throw on socket close.
    });
  });
}
