// packages/server/src/sse.ts
// T5.4 — SSE (Server-Sent Events) manager.
//
// One process can have many concurrent runs, each with one or more
// open client connections (typically one browser tab). The manager
// routes `ServerEvent`s to the right subscribers and frames them as
// SSE wire data:
//
//   event: <type>\n
//   data: <json>\n
//   \n
//
// plus a 15s heartbeat (":hb\n\n") on idle streams so proxies and
// load balancers don't kill the connection.
//
// Design choices:
//   - Subscribers are pull-based: `subscribe()` returns an
//     AsyncIterable<Uint8Array> that the route handler can yield from.
//   - `send()` is non-blocking: a slow subscriber backpressures only
//     its own queue; the manager never awaits on a subscriber.
//   - When a subscriber's queue is full (slow client), it is dropped
//     silently. This is the "good enough" behavior for a localhost
//     tool; if you disconnect from WiFi, the next reconnect will
//     catch up via the audit log anyway (DESIGN.MD §8.2).
//   - Heartbeat runs on a single global interval; it iterates the
//     subscriber map and writes to idle streams only.

import type { ToolUseBlock } from "@computerworks/core";

/** Wire event types sent from server → client over SSE. Defined in
 *  DESIGN.MD §8.3. Note that this is NOT the same as `StreamEvent`
 *  (which is the provider's wire format) or `Message` (core). The
 *  server translates one into the other in the agent-loop route. */
export type ServerEvent =
  | { type: "message_start" }
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | {
      type: "approval_required";
      requestId: string;
      tool: ToolUseBlock;
      description: string;
      diff?: string;
    }
  | {
      type: "tool_result";
      call_id: string;
      approved: boolean;
      result?: unknown;
      is_error: boolean;
      reason?: string;
    }
  | { type: "message_done"; usage: { input: number; output: number } }
  | { type: "session_renamed"; sessionId: string; title: string }
  | { type: "error"; message: string }
  | { type: "done" };

// ─── Framing ──────────────────────────────────────────────────────────────

/** Encode one `ServerEvent` as an SSE frame, ready to be written to
 *  the response stream. Returns a Uint8Array of UTF-8 bytes. */
export function formatSSE(event: ServerEvent): Uint8Array {
  const lines: string[] = [];
  // SSE requires the `data:` field to be present (even if empty).
  // The `event:` field is optional but recommended.
  lines.push(`event: ${event.type}`);
  // For events that carry a body, JSON-serialize the body minus `type`.
  const { type, ...rest } = event;
  // `done` has no body. We still emit an empty `data:` line so the
  // client can rely on the trailing blank line.
  const body = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
  // SSE forbids newlines inside `data:`; if the JSON has any, we'd
  // have to split it. None of our event types contain raw newlines
  // (strings are JSON-escaped) so a single line is safe.
  lines.push(`data: ${body}`);
  lines.push(""); // blank line to terminate the frame
  lines.push(""); // double newline for clarity (not strictly required)
  return new TextEncoder().encode(lines.join("\n"));
}

const HEARTBEAT_BYTES = new TextEncoder().encode(":hb\n\n");

// ─── Subscriber ───────────────────────────────────────────────────────────

interface Subscriber {
  /** Buffered events awaiting consumer pull. */
  queue: Uint8Array[];
  /** True after `close()` is called; producers stop writing to us. */
  closed: boolean;
  /** Resolves when a new event arrives or we close. */
  waiter: ((v: Uint8Array | null) => void) | null;
  /** Tracks if the consumer is currently waiting (so heartbeats know
   *  if the stream is "idle"). */
  waiting: boolean;
}

function makeSubscriber(): Subscriber {
  return {
    queue: [],
    closed: false,
    waiter: null,
    waiting: false,
  };
}

const MAX_QUEUE = 1000; // events; backpressure beyond this drops the subscriber

// ─── Manager ──────────────────────────────────────────────────────────────

export interface SSEManagerOptions {
  /** Heartbeat interval. Default 15s. */
  heartbeatMs?: number;
}

export class SSEManager {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly heartbeatMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SSEManagerOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
  }

  // ─── subscribe ────────────────────────────────────────────────────────

  /**
   * Subscribe to events for one session. Returns an async iterator
   * and a `dispose` callback. The iterator yields the raw SSE bytes
   * (events + heartbeats) in the order they were enqueued.
   *
   * To stop consuming, call `.dispose()` (or use the returned
   * iterable's `return()` method via `for await ... of` with an
   * explicit break — see note below).
   *
   * Note: a `for await (const x of sub) { break; }` loop CANNOT
   * short-circuit a pending `next()` call, because the runtime only
   * invokes the iterator's `return()` after the body has executed
   * at least once. If no events are available, the body never runs
   * and `return()` is never called. To abort a stream cleanly, call
   * `sub.dispose()` directly (which wakes any pending `next()` and
   * removes the subscriber).
   */
  subscribe(sessionId: string): AsyncIterable<Uint8Array> & {
    dispose(): void;
  } {
    const sub = makeSubscriber();
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(sub);
    this.ensureHeartbeat();

    const iterable: AsyncIterable<Uint8Array> & { dispose(): void } = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          if (sub.closed) return { value: undefined, done: true };
          // If something is already queued, return it.
          const head = sub.queue.shift();
          if (head !== undefined) {
            return { value: head, done: false };
          }
          // Otherwise wait for the next event OR a close signal.
          sub.waiting = true;
          const value = await new Promise<Uint8Array | null>((resolve) => {
            // If we were closed between the check above and the
            // assignment, resolve immediately with `null` so the
            // iterator can terminate.
            if (sub.closed) {
              resolve(null);
              return;
            }
            sub.waiter = resolve;
          });
          sub.waiting = false;
          sub.waiter = null;
          if (value === null) return { value: undefined, done: true };
          return { value, done: false };
        },
        return: async () => {
          sub.closed = true;
          if (sub.waiter) sub.waiter(null);
          this.removeSubscriber(sessionId, sub);
          return { value: undefined, done: true };
        },
        throw: async (err) => {
          sub.closed = true;
          if (sub.waiter) sub.waiter(null);
          this.removeSubscriber(sessionId, sub);
          throw err;
        },
      }),
      dispose: () => {
        if (sub.closed) return;
        sub.closed = true;
        if (sub.waiter) sub.waiter(null);
        this.removeSubscriber(sessionId, sub);
      },
    };

    return iterable;
  }

  // ─── send ─────────────────────────────────────────────────────────────

  /** Broadcast a single event to all subscribers of `sessionId`.
   *  Dropped silently for closed or backpressured subscribers. */
  send(sessionId: string, event: ServerEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    const bytes = formatSSE(event);
    for (const sub of set) {
      if (sub.closed) continue;
      if (sub.queue.length >= MAX_QUEUE) {
        // Slow client; drop them.
        sub.closed = true;
        if (sub.waiter) sub.waiter(null);
        this.removeSubscriber(sessionId, sub);
        continue;
      }
      // If the consumer is currently awaiting, hand the bytes
      // directly to the waiter (and leave the queue empty so we
      // don't double-deliver). Otherwise queue them.
      if (sub.waiter) {
        const w = sub.waiter;
        sub.waiter = null;
        w(bytes);
      } else {
        sub.queue.push(bytes);
      }
    }
  }

  // ─── close ────────────────────────────────────────────────────────────

  /** Close all subscribers for a session. Called when a run ends
   *  and we want clients to reconnect (or the tab to know the stream
   *  is over). */
  closeSession(sessionId: string): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    for (const sub of set) {
      sub.closed = true;
      if (sub.waiter) sub.waiter(null);
    }
    this.subscribers.delete(sessionId);
  }

  /** Test / shutdown hook: stop the heartbeat, close everything. */
  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const sid of [...this.subscribers.keys()]) this.closeSession(sid);
  }

  /** Test helper. */
  subscriberCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  // ─── heartbeat ────────────────────────────────────────────────────────

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [sessionId, set] of this.subscribers) {
        for (const sub of set) {
          if (sub.closed) continue;
          // Only emit heartbeat if the consumer is idle (waiting on
          // the iterator) AND has an empty queue. We don't want to
          // interleave heartbeats between real events when the client
          // is keeping up.
          if (sub.waiting && sub.queue.length === 0) {
            // Hand the heartbeat directly to the waiter so we don't
            // double-deliver via the queue.
            if (sub.waiter) {
              const w = sub.waiter;
              sub.waiter = null;
              w(HEARTBEAT_BYTES);
            } else {
              sub.queue.push(HEARTBEAT_BYTES);
            }
            // Subtle: the consumer is no longer waiting after we
            // resume them. Reset.
            sub.waiting = false;
          }
        }
        if (set.size === 0) this.subscribers.delete(sessionId);
      }
    }, this.heartbeatMs);
    // Don't keep the event loop alive just for heartbeats.
    this.heartbeatTimer.unref?.();
  }

  private removeSubscriber(sessionId: string, sub: Subscriber): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subscribers.delete(sessionId);
  }
}
