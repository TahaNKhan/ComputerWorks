// packages/ui/src/api/client.ts
// T7.2 — Typed wrappers around the Fastify REST API plus an SSEClient
// that yields `ServerEvent`s and auto-reconnects on disconnect.
//
// The base URL is read once at module load from
// `import.meta.env.VITE_API_BASE_URL`, falling back to "" so the
// browser uses relative paths (Vite proxies `/api/*` to the server
// during development).

import type {
  ApprovalDecision,
  ApiError,
  AuditEntry,
  CreateSessionInput,
  GetSessionResponse,
  PatchSessionInput,
  PostMessageInput,
  SessionMeta,
  ServerEvent,
} from "./types.js";
import { drainFrames, parseSSEFrame } from "./sse-parse.js";

// ─── Base URL resolution ───────────────────────────────────────────────────

function resolveBaseUrl(): string {
  // Vite injects `import.meta.env.VITE_*` at build time.
  const fromEnv = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
  // Trim trailing slash so we can join with a leading-slash path.
  return fromEnv.replace(/\/+$/, "");
}

export const API_BASE_URL = resolveBaseUrl();

// ─── Errors ────────────────────────────────────────────────────────────────

export class HttpError extends Error implements ApiError {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function buildUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

async function parseError(res: Response): Promise<string> {
  // The server returns `{ error: string }` for non-2xx.
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // fallthrough
  }
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(
  method: string,
  path: string,
  init: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const res = await fetch(buildUrl(path), {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) {
    const message = await parseError(res);
    throw new HttpError(res.status, message);
  }
  // Some endpoints return 204 No Content.
  if (res.status === 204) return undefined as T;
  // Otherwise parse JSON.
  const text = await res.text();
  if (text === "") return undefined as T;
  return JSON.parse(text) as T;
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export function listSessions(signal?: AbortSignal): Promise<SessionMeta[]> {
  return request("GET", "/api/sessions", signal ? { signal } : {});
}

export function getSession(id: string, signal?: AbortSignal): Promise<GetSessionResponse> {
  return request("GET", `/api/sessions/${encodeURIComponent(id)}`, signal ? { signal } : {});
}

export function createSession(
  input: CreateSessionInput = {},
  signal?: AbortSignal,
): Promise<SessionMeta> {
  return request("POST", "/api/sessions", {
    body: input,
    ...(signal ? { signal } : {}),
  });
}

export function deleteSession(id: string, signal?: AbortSignal): Promise<void> {
  return request("DELETE", `/api/sessions/${encodeURIComponent(id)}`, signal ? { signal } : {});
}

export function renameSession(
  id: string,
  title: string,
  signal?: AbortSignal,
): Promise<SessionMeta> {
  const patch: PatchSessionInput = { title };
  return request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, {
    body: patch,
    ...(signal ? { signal } : {}),
  });
}

export function patchSession(
  id: string,
  patch: PatchSessionInput,
  signal?: AbortSignal,
): Promise<SessionMeta> {
  return request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, {
    body: patch,
    ...(signal ? { signal } : {}),
  });
}

// ─── Messages + approvals + cancel ─────────────────────────────────────────

export function postMessage(
  sessionId: string,
  body: PostMessageInput,
  signal?: AbortSignal,
): Promise<void> {
  return request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    body,
    ...(signal ? { signal } : {}),
  });
}

export function approveRequest(
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  signal?: AbortSignal,
): Promise<void> {
  return request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/approve`, {
    body: { requestId, decision },
    ...(signal ? { signal } : {}),
  });
}

export function cancelTurn(sessionId: string, signal?: AbortSignal): Promise<void> {
  return request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    ...(signal ? { signal } : {}),
  });
}

// ─── Audit (helper used by the session detail view if needed) ──────────────

export async function listAudit(id: string, signal?: AbortSignal): Promise<AuditEntry[]> {
  const res = await getSession(id, signal);
  return res.audit;
}

// ─── SSEClient ─────────────────────────────────────────────────────────────

/** How long to wait between reconnect attempts, doubling up to a cap.
 *  Sequence: 1s, 2s, 4s, 8s, 8s, 8s, …  */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
const HEARTBEAT_LINE = ":\n\n";

export interface SSEClientOptions {
  /** Override the base URL (mostly for tests). */
  baseUrl?: string;
  /** Called whenever a reconnect is attempted (useful for status UIs). */
  onReconnect?: (attempt: number, nextDelayMs: number) => void;
  /** Called after the first successful chunk arrives on each (re)connect. */
  onOpen?: () => void;
  /** Called once when the stream ends with a terminal `done` event. */
  onDone?: () => void;
  /** Called on transport errors that aren't user-initiated aborts. */
  onError?: (err: unknown) => void;
}

export class SSEClient {
  private readonly sessionId: string;
  private readonly opts: SSEClientOptions;
  private controller: AbortController | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(sessionId: string, opts: SSEClientOptions = {}) {
    this.sessionId = sessionId;
    this.opts = opts;
  }

  /** Start consuming events. Returns when `stop()` is called or the
   *  server emits a terminal `done` event. Never throws on transport
   *  errors — we silently reconnect with backoff. */
  async *events(): AsyncIterable<ServerEvent> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        for await (const ev of this.readStream(this.controller.signal)) {
          if (this.stopped) return;
          if (ev.type === "done") {
            this.opts.onDone?.();
            return;
          }
          yield ev;
        }
        // Stream ended without `done` (server closed the connection).
        if (this.stopped) return;
      } catch (err) {
        if (this.stopped) return;
        // User-initiated aborts surface as `AbortError`; don't reconnect.
        if ((err as Error).name === "AbortError") return;
        this.opts.onError?.(err);
      }
      // Reconnect with backoff.
      const delay = RECONNECT_DELAYS_MS[
        Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
      ] ?? 8000;
      this.attempt++;
      this.opts.onReconnect?.(this.attempt, delay);
      await sleep(delay);
      if (this.stopped) return;
    }
  }

  /** Halt consumption and cancel any in-flight read. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  /** One network attempt: yields events until the server closes the
   *  stream or the connection errors out. */
  private async *readStream(
    signal: AbortSignal,
  ): AsyncIterableIterator<ServerEvent> {
    const base = this.opts.baseUrl ?? API_BASE_URL;
    const url = `${base}/api/sessions/${encodeURIComponent(this.sessionId)}/stream`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok) {
      throw new HttpError(res.status, await parseError(res));
    }
    if (!res.body) {
      throw new Error("SSE: response had no body");
    }
    this.opts.onOpen?.();
    this.attempt = 0; // reset backoff on successful connect
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = drainFrames(buffer);
        buffer = frames.rest;
        for (const frame of frames.events) {
          const ev = parseSSEFrame(frame);
          if (ev) yield ev;
        }
      }
      // Flush any remaining text on close.
      buffer += decoder.decode();
      const tail = drainFrames(buffer + "\n\n");
      for (const frame of tail.events) {
        const ev = parseSSEFrame(frame);
        if (ev) yield ev;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}