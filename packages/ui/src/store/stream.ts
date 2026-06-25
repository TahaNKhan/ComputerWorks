// packages/ui/src/store/stream.ts
// T7.6 — Subscribes to `SSEClient` for the active session and routes
// each `ServerEvent` into the zustand session store.
//
// The store is the single source of truth — every component reads from
// it. We don't push events directly to React; we let the existing
// reducer in `sessions.ts` mutate state, then React re-renders.
//
// Performance: a fast token stream can fire 50+ events/second. We
// coalesce them by yielding to the microtask queue between events so
// React's batching can keep up. The MessageList in T7.5 also wraps
// the message array in `useDeferredValue` so urgent UI (the composer,
// approval cards) updates ahead of long-message diffs.

import { SSEClient, type SSEClientOptions } from "../api/client.js";
import type { ServerEvent } from "../api/types.js";
import { useSessionsStore } from "./sessions.js";

export interface StreamController {
  /** Stop consuming events and tear down the SSEClient. */
  stop(): void;
}

interface ActiveSubscription {
  sessionId: string;
  client: SSEClient;
}

/** Currently active subscription. We keep only one — switching
 *  sessions cancels the old SSE and starts a new one. */
let active: ActiveSubscription | null = null;

/** Open (or replace) the SSE stream for `sessionId`. Returns a
 *  controller whose `stop()` ends the stream. */
export function subscribeToSession(
  sessionId: string,
  extra: SSEClientOptions = {},
): StreamController {
  // If we're already subscribed to this session, just no-op.
  if (active && active.sessionId === sessionId) {
    return { stop: () => stopActive() };
  }
  // Otherwise tear down the old subscription first.
  if (active) {
    active.client.stop();
    active = null;
  }

  const client = new SSEClient(sessionId, {
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      useSessionsStore.setState({ errorMessage: message, status: "error" });
    },
    onDone: () => {
      useSessionsStore.setState({ status: "idle" });
    },
    ...extra,
  });
  active = { sessionId, client };

  // Kick off the consume loop. We don't await it — the loop runs in
  // the background and is stopped by `stopActive()`.
  void consume(client, sessionId);

  return { stop: stopActive };
}

function stopActive(): void {
  if (!active) return;
  active.client.stop();
  active = null;
}

async function consume(client: SSEClient, sessionId: string): Promise<void> {
  try {
    for await (const ev of client.events()) {
      useSessionsStore.getState().applyServerEvent(sessionId, ev);
      // Yield to the microtask queue so React's scheduler can flush
      // between bursts of tokens. This is cheap (no setTimeout) and
      // keeps the UI responsive while streaming.
      await Promise.resolve();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useSessionsStore.setState({ errorMessage: message, status: "error" });
  }
}

/** Re-export the event type so tests can build fakes without
 *  importing from `../api/types` directly. */
export type { ServerEvent };