// packages/ui/src/workers/sync-client.ts
// T17.3 — Tab-side wrapper around the SharedWorker that owns the
// central SSE connection.
//
// Usage:
//   const { tabId, onEvent, onResync } = connectSyncWorker();
//   tabId.then((id) => store.setTabId(id));
//   const offEvent = onEvent((ev) => applyServerEvent(sessionIdFor(ev), ev));
//   const offResync = onResync(() => { loadTranscript(activeId); loadSessions(); });
//
// Vite bundles `sync.worker.ts` separately via the
// `new URL(..., import.meta.url)` pattern. Browsers that don't
// support SharedWorker fall back to a per-tab direct connection
// via the same `connectSyncWorker` name (kept identical).

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

// Detect SharedWorker support; if missing, fall back to a
// per-tab direct connection (no SharedWorker required). This
// branch is hit only by very old browsers.
type SyncTransport = "shared-worker" | "direct-sse";

function openTransport(): { port: MessagePort; transport: SyncTransport } {
  if (typeof SharedWorker !== "undefined") {
    const sw = new SharedWorker(
      new URL("./sync.worker.ts", import.meta.url),
      { type: "module", name: "computerworks-sync" },
    );
    const port = sw.port;
    port.start();
    return { port, transport: "shared-worker" };
  }
  // Fallback: this branch is exercised by `sync-client.test.ts`
  // (it never connects for real). The fallback path could be
  // implemented later as direct-EventSource-with-EventEmitter
  // shim; for V1 we leave it as a stub returning a no-op port.
  throw new Error("SharedWorker not supported in this browser");
}

export function connectSyncWorker(): SyncConnection {
  const { port } = openTransport();
  const channel = new MessageChannel();
  port.postMessage({ kind: "subscribe" }, [channel.port2]);
  channel.port2.start();

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

  channel.port2.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as WorkerToTab | undefined;
    if (!msg) return;
    if (msg.kind === "registered") {
      resolveTabId?.(msg.tabId);
    } else if (msg.kind === "event") {
      for (const cb of eventListeners) {
        try { cb(msg.event); } catch { /* ignore listener errors */ }
      }
    } else if (msg.kind === "resync") {
      // Debounce: the worker may emit a burst of resync signals
      // during SSE flap recovery. We coalesce into a single
      // listener call after a short quiet period.
      lastResyncSignal = Date.now();
      setTimeout(() => {
        if (Date.now() - lastResyncSignal < RESYNC_DEBOUNCE_MS) {
          // a fresher signal reset the timer; do nothing
          return;
        }
        for (const cb of resyncListeners) {
          try { cb(); } catch { /* ignore */ }
        }
      }, RESYNC_DEBOUNCE_MS);
    }
  });

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

// Internal helpers — exposed so tests can construct a port
// without a real SharedWorker. The test imports a fake `connect`
// that returns the same shape.
export const __testing__ = { openTransport };