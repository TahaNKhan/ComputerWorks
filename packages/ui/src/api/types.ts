// packages/ui/src/api/types.ts
// T7.2 — Wire types shared with the server.
//
// These shapes mirror `@computerworks/server`'s `sse.ts` and route
// handlers. We intentionally redefine them here (rather than import
// from `@computerworks/server`) so the browser bundle does not pull
// in fastify/node runtime code. The two definitions MUST stay in sync;
// see packages/server/src/sse.ts for the source of truth.

// ─── Inlined from @computerworks/core/src/types.ts ─────────────────────────
// We mirror the few core types we need so the browser bundle has no
// runtime dependency on @computerworks/core (whose provider code uses
// `process.env`). The originals remain the source of truth — keep this
// block in sync.

export type Role = "user" | "assistant" | "system" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[] | string;
}

// ─── REST: session resource ────────────────────────────────────────────────

/** Session metadata as returned by GET /api/sessions and GET
 *  /api/sessions/:id. Mirrors `SessionMeta` in
 *  packages/server/src/session-store.ts. */
export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  allowlist?: string[];
}

/** Body of POST /api/sessions. */
export interface CreateSessionInput {
  cwd?: string;
  model?: string;
  title?: string;
}

/** Body of PATCH /api/sessions/:id. */
export interface PatchSessionInput {
  title?: string;
  cwd?: string;
  model?: string;
}

/** A single `Message` from the transcript (content can be a string
 *  or an array of content blocks). */
export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{
    type: "text" | "tool_use" | "tool_result";
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
  }>;
}

/** Audit entry returned by GET /api/sessions/:id. */
export interface AuditEntry {
  ts: string;
  sessionId: string;
  callId: string;
  tool: string;
  input?: unknown;
  decision:
    | "approve_once"
    | "approve_for_session"
    | "reject"
    | "edit"
    | "auto_approve"
    | "denied_by_denylist"
    | "timeout";
  reason?: string;
  result?: unknown;
  isError?: boolean;
}

export interface GetSessionResponse {
  meta: SessionMeta;
  messages: SessionMessage[];
  audit: AuditEntry[];
}

// ─── REST: messages + approvals + cancel ───────────────────────────────────

/** Body of POST /api/sessions/:id/messages. */
export interface PostMessageInput {
  content: string;
  overrides?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

/** Decision sent to POST /api/sessions/:id/approve. The server uses
 *  the same discriminated union in routes/approve.ts. */
export type ApprovalDecision =
  | { kind: "approve_once" }
  | { kind: "approve_for_session"; pattern: string }
  | { kind: "reject"; reason: string }
  | { kind: "edit"; newInput: unknown };

export interface ApproveRequestBody {
  requestId: string;
  decision: ApprovalDecision;
}

// ─── SSE: ServerEvent from /api/sessions/:id/stream ────────────────────────

/** Wire event types from server → client over SSE. Mirrors
 *  `ServerEvent` in packages/server/src/sse.ts. */
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
  | { type: "error"; message: string }
  | { type: "done" };

// ─── UI-local message representation ───────────────────────────────────────

/** A single message rendered in the chat view. We model an assistant
 *  message as a list of `parts` so we can interleave text tokens,
 *  tool calls, tool results, and approval cards in the order they
 *  arrived. */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ToolUseBlock; result?: unknown; isError?: boolean; approved?: boolean }
  | { kind: "approval"; requestId: string; tool: ToolUseBlock; description: string; diff?: string };

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  /** Parts, in order. User messages have exactly one text part. */
  parts: MessagePart[];
  /** True if this message is still being filled in by a stream. */
  streaming?: boolean;
  /** When the message finished (ISO string). Undefined while streaming. */
  completedAt?: string;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/** An error returned from the API. The server's shape is `{ error: string }`. */
export interface ApiError {
  status: number;
  message: string;
}