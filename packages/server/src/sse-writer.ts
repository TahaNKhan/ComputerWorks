// packages/server/src/sse-writer.ts
// T14.1 — Per-response SSE writer.
//
// Replaces the Phase-5 `SSEManager` (which broadcast events to many
// long-lived subscribers) with a small writer that owns one HTTP
// response and serializes one SSE frame per `write()` call.
//
// Lifecycle:
//   const writer = createSSEWriter(reply);
//   writer.write({ type: "message_start" });
//   writer.write({ type: "token", delta: "Hel" });
//   writer.write({ type: "done" });
//   writer.end();
//
// The writer is per-request; the response is closed via `writer.end()`
// or implicitly when the underlying socket closes (client disconnect).
// A `closed` flag lets the agent loop bail out early when the client
// goes away.

import type { FastifyReply } from "fastify";
import { formatSSE } from "./sse.js";
import type { ServerEvent } from "./sse.js";

/** Per-response writer. Cheap; no fanout. */
export interface SSEWriter {
  /** Write one event to the response stream. Silently no-ops if the
   *  underlying response has already closed. */
  write(event: ServerEvent): void;
  /** Emit the terminal `done` frame and end the response. Safe to
   *  call more than once; only the first call has any effect. */
  end(): void;
  /** True after the client has disconnected (or `end()` was called). */
  readonly closed: boolean;
}

const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Wrap a Fastify reply as an SSE writer.
 *
 * Hijacks the underlying `http.ServerResponse` so Fastify doesn't try
 * to serialize a JSON body. Installs a `close` listener so the writer
 * flips to `closed: true` when the client disconnects; the agent loop
 * should observe `closed` to abort expensive work.
 */
export function createSSEWriter(reply: FastifyReply): SSEWriter {
  const raw = reply.raw;
  for (const [name, value] of Object.entries(SSE_HEADERS)) {
    raw.setHeader(name, value);
  }
  raw.flushHeaders?.();
  reply.hijack();

  let closed = false;
  raw.on("close", () => {
    closed = true;
  });

  function safeWrite(event: ServerEvent): void {
    if (closed) return;
    const buf = formatSSE(event);
    try {
      // We don't await `drain`; if the client is slow, Node will buffer
      // up to highWaterMark and then `write()` returns false. We
      // deliberately do NOT block here — a slow client just means the
      // event lands in the OS buffer, which is fine for a single-turn
      // stream on a localhost tool. If the buffer fills the socket
      // closes and `closed` flips.
      raw.write(buf);
    } catch {
      closed = true;
    }
  }

  return {
    write: safeWrite,
    end() {
      if (closed) return;
      try {
        safeWrite({ type: "done" });
        raw.end();
      } catch {
        /* ignore */
      } finally {
        closed = true;
      }
    },
    get closed() {
      return closed;
    },
  };
}