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
  /** T19.8 — provenance of the session title. "auto" = the
   *  server-side rename_session tool set it; "manual" = the
   *  user set it via the UI (PATCH /api/sessions/:id). Mirrors
   *  SessionMeta.titleSource in @computerworks/server. Optional
   *  + forward-compatible: missing field is treated as "auto". */
  titleSource?: "auto" | "manual";
  /** T19.8 — server-side rate-limit clock for rename_session.
   *  Mirrored so the sidebar can show a future "rename pending"
   *  affordance if we add one. Currently only displayed in
   *  dev mode. */
  lastRenamedAtMessageCount?: number;
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
      tool: string;
      approved: boolean;
      result?: unknown;
      is_error: boolean;
      reason?: string;
    }
  | {
      /** T12.x — Server emits this when the model called a tool with
       *  an input shape that failed zod validation (typically the
       *  model forgot a required field). The UI shows this as an
       *  inline error attached to the tool_call block — distinct
       *  from a runtime tool failure shown via `tool_result.is_error`.
       *  Currently this event is only emitted in tests; the server
       *  surfaces validation errors through `tool_result` with
       *  `is_error: true` and `reason: <formatted message>`. We
       *  keep the type here for parity with the codebase and for
       *  future use. */
      type: "tool_validation_error";
      call_id: string;
      tool: string;
      message: string;
    }
  | {
      /** The server has updated the session's title. Triggered by
       *  the LLM-driven rename_session tool (T19.2) and by any
       *  manual PATCH /api/sessions/:id. The reducer updates the
       *  matching session in the sidebar. T19.8 — optional
       *  `titleSource` so the reducer + UI know whether the
       *  change came from a tool call (auto, animate) or a user
       *  PATCH (manual, no animation). */
      type: "session_renamed";
      sessionId: string;
      title: string;
      titleSource?: "auto" | "manual";
    }
  | { type: "message_done"; usage: { input: number; output: number } }
  | { type: "error"; message: string }
  | { type: "done" }
  | {
      // T17.3 — central SSE only (not on the per-message stream).
      // Emitted after every successful message persistence; the
      // SharedWorker hands these to every tab on the origin.
      // Carries the originating tab UUID so the leading tab can
      // dedupe its own optimistic append via the reducer; re-
      // connecting tabs dedupe by message.id.
      type: "message_appended";
      sessionId: string;
      message: SessionMessage;
      originator: string;
      ts: string;
    };

// ─── UI-local message representation ───────────────────────────────────────

/** A single message rendered in the chat view. We model an assistant
 *  message as a list of `parts` so we can interleave text tokens,
 *  tool calls, tool results, validation errors, and approval cards
 *  in the order they arrived. */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ToolUseBlock; result?: unknown; isError?: boolean; approved?: boolean; validationError?: string }
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