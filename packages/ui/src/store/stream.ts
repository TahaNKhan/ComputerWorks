// packages/ui/src/store/stream.ts
// T14.2 — Per-message SSE consumer.
//
// v1.13: kept a long-lived `GET /api/sessions/:id/stream` SSE
// connection open across turns, with reconnect-on-error logic and
// automatic recovery. Switched sessions tore down the old stream and
// opened a new one.
//
// v1.14: each `POST /messages` returns its own SSE stream in the
// response body. There's no persistent connection to maintain. The
// store's `sendMessage` calls `sendMessageStreaming`, which POSTs
// the user message and pipes the response body through the SSE
// frame parser. Every event lands in `useSessionsStore`'s reducer.
//
// There is at most one in-flight stream at a time. `stopActiveStream`
// aborts it (used by `switchSession` and `cancelTurn`).

import { drainFrames, parseSSEFrame } from "../api/sse-parse.js";
import { API_BASE_URL } from "../api/client.js";
import type { ServerEvent } from "../api/types.js";
import { useSessionsStore } from "./sessions.js";

export interface StreamOptions {
  /** Called on transport errors that aren't user-initiated aborts. */
  onError?: (err: unknown) => void;
  /** Called once when the stream ends with a terminal `done` event
   *  OR the response body closes cleanly. */
  onDone?: () => void;
}

interface ActiveStream {
  sessionId: string;
  controller: AbortController;
}

let active: ActiveStream | null = null;

/** Abort any in-flight stream. Safe to call when nothing is active. */
export function stopActiveStream(): void {
  if (!active) return;
  active.controller.abort();
  active = null;
}

/**
 * Send a user message and consume the per-message SSE response.
 *
 * Resolves once the response stream closes (either after a terminal
 * `done` frame, on a transport error, or via user abort). The caller
 * is expected to feed events to the store via `applyServerEvent`;
 * we do that inline below.
 *
 * The promise resolves to the number of events delivered (excludes
 * the closing `done`). On error, resolves to `-1`.
 */
export async function sendMessageStreaming(
  sessionId: string,
  content: string,
  opts: StreamOptions = {},
): Promise<number> {
  // One stream at a time; if a previous one is still going, abort it.
  if (active) {
    active.controller.abort();
    active = null;
  }

  const controller = new AbortController();
  active = { sessionId, controller };

  let count = 0;
  try {
    const url = `${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = drainFrames(buffer);
      buffer = rest;
      for (const frame of events) {
        const ev = parseSSEFrame(frame);
        if (!ev) continue;
        useSessionsStore.getState().applyServerEvent(sessionId, ev);
        count++;
        if (ev.type === "done") {
          opts.onDone?.();
        }
      }
    }
    // Flush any trailing text.
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const tail = drainFrames(buffer + "\n\n");
      for (const frame of tail.events) {
        const ev = parseSSEFrame(frame);
        if (!ev) continue;
        useSessionsStore.getState().applyServerEvent(sessionId, ev);
        count++;
        if (ev.type === "done") opts.onDone?.();
      }
    }
    return count;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      // User-initiated abort; the store already cleared its stream.
      return count;
    }
    opts.onError?.(err);
    return -1;
  } finally {
    if (active?.controller === controller) active = null;
  }
}

/** Test-only: peek at whether a stream is currently active. */
export function isStreaming(): boolean {
  return active !== null;
}