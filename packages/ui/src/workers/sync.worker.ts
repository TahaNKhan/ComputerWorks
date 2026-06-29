/// <reference lib="WebWorker" />
// packages/ui/src/workers/sync.worker.ts
// T17.3 — SharedWorker that owns the central SSE connection.
//
// Architecture:
//   - One SharedWorker instance per origin (browser spawns it on
//     first import).
//   - Each tab that imports sync-client.ts opens a MessageChannel
//     and sends one port to the worker; the worker stashes the
//     tab's UUID alongside the port.
//   - The worker opens ONE GET /api/sync SSE and pipes events to
//     every connected port (so N tabs share 1 SSE connection).
//   - On (re)connect, the worker emits `{ kind: 'resync' }` so each
//     tab can `loadTranscript` + `loadSessions` to catch up after
//     any events missed during the disconnect window.
//   - Tab UUIDs come from `crypto.randomUUID()` (per connect).
//
// Loaded by:
//   const worker = new SharedWorker(
//     new URL("./sync.worker.ts", import.meta.url),
//     { type: "module" }
//   );
// Vite bundles the worker separately; this file is its entry.

type WorkerToTab =
  | { kind: "registered"; tabId: string }
  | { kind: "event"; event: ServerEvent }
  | { kind: "resync" };

// Tab-side doesn't write to the worker; reserved for future
// bidirectional commands.
type TabToWorker = { kind: "subscribe" };

// ServerEvent shape duplicated here so the worker file is
// self-contained (no bundling across packages/ui/src boundaries
// for a single-purpose module). Keep in sync with
// packages/ui/src/api/types.ts.
type ServerEvent =
  | { type: "message_start" }
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: { type: "tool_use"; id: string; name: string; input: unknown } }
  | { type: "approval_required"; requestId: string; tool: { type: "tool_use"; id: string; name: string; input: unknown }; description: string; diff?: string }
  | { type: "tool_result"; call_id: string; tool: string; approved: boolean; result?: unknown; is_error: boolean; reason?: string }
  | { type: "message_done"; usage: { input: number; output: number } }
  | { type: "session_renamed"; sessionId: string; title: string }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "message_appended"; sessionId: string; message: { role: string; content: unknown }; originator: string; ts: string };

const ports = new Map<MessagePort, string>();
let sseController: AbortController | null = null;
let attempt = 0;

const workerSelf = self as unknown as SharedWorkerGlobalScope;

workerSelf.addEventListener(
  "connect",
  (ev: MessageEvent) => {
    const port = (ev as unknown as { ports: readonly MessagePort[] }).ports[0];
    if (!port) return;
    const tabId = crypto.randomUUID();
    ports.set(port, tabId);
    port.postMessage({ kind: "registered", tabId } satisfies WorkerToTab);
    port.start();

    port.addEventListener("message", (mev: MessageEvent) => {
      const data = mev.data as TabToWorker | undefined;
      if (!data) return;
      // No write actions from tabs in V1.
      void data;
    });

    startSSEIfNeeded();
  },
);

async function startSSEIfNeeded(): Promise<void> {
  if (sseController) return;
  sseController = new AbortController();
  await connectAndLoop(sseController.signal);
}

async function connectAndLoop(signal: AbortSignal): Promise<void> {
  // Re-attempt connection with exponential backoff capped at 30s,
  // max 5 attempts before giving up. A fresh `startSSEIfNeeded`
  // call from a new tab will retry from the top.
  while (attempt < 5 && !signal.aborted) {
    try {
      const res = await fetch("/api/sync", {
        signal,
        credentials: "include",
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: HTTP ${res.status}`);
      }
      attempt = 0; // reset on clean connect

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = drainFrames(buffer);
        buffer = frames.rest;
        for (const frame of frames.events) {
          const ev = parseSSEFrame(frame);
          if (ev) broadcast({ kind: "event", event: ev } satisfies WorkerToTab);
        }
      }
    } catch (err) {
      if (signal.aborted) break;
      // eslint-disable-next-line no-console
      console.warn("[sync.worker] SSE error, reconnecting:", err);
    }

    if (signal.aborted) break;
    attempt++;
    // Tell tabs to resync before we attempt to reconnect.
    broadcast({ kind: "resync" } satisfies WorkerToTab);
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    await sleep(delay);
  }
}

function broadcast(msg: WorkerToTab): void {
  for (const port of ports.keys()) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// SSE frame helpers, kept inline to keep the worker file
// self-contained (no shared util imports).
function drainFrames(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { events: parts, rest };
}

function parseSSEFrame(frame: string): ServerEvent | null {
  const lines = frame.split("\n");
  let data: string | null = null;
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const trimmed = line.slice(5).trim();
      data = data === null ? trimmed : data + trimmed;
    } else if (line.startsWith("event:")) {
      void line.slice(6).trim();
    }
  }
  if (data === null || data === "") return null;
  try {
    return JSON.parse(data) as ServerEvent;
  } catch {
    return null;
  }
}