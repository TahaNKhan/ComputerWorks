// packages/server/src/sync-hub.ts
// T17.2 — Per-process hub that fans state-change events out to the
// central SSE subscribers (one SSE per origin, owned by a SharedWorker).
//
// Disjoint from the per-message SSE that the messages route owns —
// the central SSE carries `message_appended`, `session_renamed`,
// `session_meta_updated`, `approval_required`, `tool_result`,
// `message_done`, `error`. The per-message SSE carries the live
// per-turn events (`message_start`, `token`, `tool_call`, `done`).
// The two streams never carry the same event type; this hub is
// only ever called for state-change events.

import type { SSEWriter } from "./sse-writer.js";
import type { ServerEvent } from "./sse.js";

export class SyncHub {
  private readonly subs = new Set<SSEWriter>();

  /** Register a subscriber. Returns an unsubscribe function. */
  subscribe(writer: SSEWriter): () => void {
    this.subs.add(writer);
    return () => this.unsubscribe(writer);
  }

  /** Remove a subscriber. No-op if not registered. */
  unsubscribe(writer: SSEWriter): void {
    this.subs.delete(writer);
  }

  /** Number of live subscribers. Test handle. */
  subscriberCount(): number {
    return this.subs.size;
  }

  /**
   * Fan an event out to every live subscriber. Dead writers
   * (those that throw on write) are pruned from the set lazily
   * — the next broadcast won't try them again. An empty subscriber
   * set is a cheap no-op.
   */
  broadcast(event: ServerEvent): void {
    if (this.subs.size === 0) return;
    for (const writer of this.subs) {
      try {
        writer.write(event);
      } catch {
        this.subs.delete(writer);
      }
    }
  }
}