// packages/ui/src/workers/sync-client.ts
// T17.3 — Tab-side wrapper around the SharedWorker that owns the
// central SSE connection.
//
// The SharedWorker's implicit `port` (created by the constructor)
// is the entire channel — both directions. We do NOT use
// MessageChannel: every previous attempt to transfer a port from
// the client to the worker resulted in the client listening on the
// transferred (now-neutered) end, so messages went nowhere.
//
// Usage:
//   const { tabId, onEvent, onResync } = connectSyncWorker();
//   tabId.then((id) => store.setTabId(id));
//   const offEvent = onEvent((ev) => applyServerEvent(sessionIdFor(ev), ev));
//   const offResync = onResync(() => { loadTranscript(activeId); loadSessions(); });

import type { ServerEvent } from "../api/types.js";

type WorkerToTab =
  | { kind: "registered"; tabId: string }
  | { kind: "event"; event: ServerEvent }
  | { kind: "resync" };

// Tab-side doesn't write to the worker; reserved for future
// bidirectional commands.
type TabToWorker = { kind: "subscribe" };

export interface SyncConnection {
  /** Resolves with the tab UUID once the worker has registered us. */
  tabId: Promise<string>;
  /** Subscribe to events from the central SSE. Returns unsubscribe. */
  onEvent(cb: (ev: ServerEvent) => void): () => void;
  /** Subscribe to the worker's resync signal. Returns unsubscribe. */
  onResync(cb: () => void): () => void;
}

function openTransport(): { port: MessagePort } {
  if (typeof SharedWorker !== "undefined") {
    // Each `new SharedWorker(...)` constructs a NEW SharedWorker
    // instance UNLESS one with the same `name` already exists for
    // this origin — browser behavior. All tabs that share an
    // origin connect to the SAME worker, which is what we want.
    const sw = new SharedWorker(
      new URL("./sync.worker.ts", import.meta.url),
      { type: "module", name: "computerworks-sync" },
    );
    const port = sw.port;
    port.start();
    return { port };
  }
  throw new Error("SharedWorker not supported in this browser");
}

export function connectSyncWorker(): SyncConnection {
  const { port } = openTransport();
  // T17 debug — surface lifecycle at the tab. Tag every line with a
  // stable prefix so a single grep on the console shows the whole flow.
  const TAG = "[sync-client]";
  // eslint-disable-next-line no-console
  console.log(TAG, "connecting to SharedWorker (sw.port opened)");

  const eventListeners = new Set<(ev: ServerEvent) => void>();
  const resyncListeners = new Set<() => void>();
  let resolveTabId: ((id: string) => void) | null = null;
  let rejectTabId: ((err: unknown) => void) | null = null;
  const tabId = new Promise<string>((resolve, reject) => {
    resolveTabId = resolve;
    rejectTabId = reject;
  });

  let lastResyncSignal = 0;
  const RESYNC_DEBOUNCE_MS = 1000;

  port.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as WorkerToTab | undefined;
    if (!msg) return;
    if (msg.kind === "registered") {
      // eslint-disable-next-line no-console
      console.log(TAG, "received registered tabId from worker:", msg.tabId);
      resolveTabId?.(msg.tabId);
    } else if (msg.kind === "event") {
      // eslint-disable-next-line no-console
      console.log(TAG, "received event from worker:", msg.event.type, msg.event);
      for (const cb of eventListeners) {
        try { cb(msg.event); } catch { /* ignore listener errors */ }
      }
    } else if (msg.kind === "resync") {
      // eslint-disable-next-line no-console
      console.log(TAG, "received resync from worker");
      // Debounce: the worker may emit a burst of resync signals
      // during SSE flap recovery. Coalesce into a single listener
      // call after a short quiet period.
      lastResyncSignal = Date.now();
      setTimeout(() => {
        if (Date.now() - lastResyncSignal < RESYNC_DEBOUNCE_MS) return;
        for (const cb of resyncListeners) {
          try { cb(); } catch { /* ignore */ }
        }
      }, RESYNC_DEBOUNCE_MS);
    }
  });

  // Tell the worker we're here. The worker fires `connect` and
  // sends `{ kind: 'registered', tabId }` back via the same port.
  // We don't need a separate MessageChannel — `sw.port` is the
  // single bidirectional channel.
  // eslint-disable-next-line no-console
  console.log(TAG, "posting subscribe to worker");
  port.postMessage({ kind: "subscribe" } satisfies TabToWorker);

  return {
    tabId,
    onEvent(cb) {
      eventListeners.add(cb);
      return () => { eventListeners.delete(cb); };
    },
    onResync(cb) {
      resyncListeners.add(cb);
      return () => { resyncListeners.delete(cb); };
    },
  };
}

// Internal helper for tests — exposed only so a fake
// MessagePort can be injected.
export const __testing__ = { openTransport };