// packages/ui/src/api/client.ts
// T14.2 — Typed wrappers around the Fastify REST API.
//
// v1.13 also exported `SSEClient` (a long-lived EventSource-style
// consumer for `GET /api/sessions/:id/stream`). v1.14 drops both
// the GET /stream route on the server and the SSEClient here; each
// message uses per-request SSE, which the store's `stream.ts`
// handles with raw `fetch` + the frame parser in `sse-parse.ts`.
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
  SessionMeta,
} from "./types.js";

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

// ─── Approvals + cancel ────────────────────────────────────────────────────

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