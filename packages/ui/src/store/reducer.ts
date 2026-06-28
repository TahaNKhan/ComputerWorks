// packages/ui/src/store/reducer.ts
// T14.2 — Pure reducer for SSE → UI state transitions.
//
// The single source of truth for every `ServerEvent` the server can
// send. Pure function: `(state, event) → state`. No React, no
// zustand, no fetch. The store's `applyServerEvent` action is a
// one-liner that delegates here.
//
// All the helpers (`appendToken`, `appendToolCall`, `applyToolResult`,
// `appendPart`, `finalizeStreaming`) are exported alongside the
// reducer so they can be unit-tested independently. They were
// previously inlined inside the zustand store; the v1.14 split lets
// us test every state transition without rendering any component.

import type {
  AuditEntry,
  MessagePart,
  ServerEvent,
  SessionMeta,
  UiMessage,
} from "../api/types.js";

export type RunStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "awaiting-approval"
  | "error";

export interface PendingApproval {
  sessionId: string;
  requestId: string;
  toolName: string;
  description: string;
  diff?: string;
}

export interface SessionsState {
  // ─── data ─────────────────────────────────────────────────────────────
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** session id → UiMessage[] (ordered oldest → newest) */
  messagesBySession: Record<string, UiMessage[]>;
  /** session id → AuditEntry[] */
  auditBySession: Record<string, AuditEntry[]>;
  pendingApproval: PendingApproval | null;
  status: RunStatus;
  /** Last error message surfaced from any store action. */
  errorMessage: string | null;
  /** Whether the initial session list fetch has completed. */
  initialized: boolean;
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Helpers (exported for unit testing) ──────────────────────────────────

/** Look up the messages for a session, or empty if none yet. */
export function messagesOf(state: SessionsState, sessionId: string): UiMessage[] {
  return state.messagesBySession[sessionId] ?? [];
}

/** Append a delta to the last streaming assistant text part. If the
 *  last message isn't a streaming assistant, starts a new one. */
export function appendToken(msgs: UiMessage[], delta: string): UiMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx]!;
  if (last.role !== "assistant" || !last.streaming) {
    return [
      ...msgs,
      {
        id: makeId("a"),
        role: "assistant",
        parts: [{ kind: "text", text: delta }],
        streaming: true,
      },
    ];
  }
  const parts = [...last.parts];
  const firstText = parts.findIndex((p) => p.kind === "text");
  if (firstText === -1) {
    parts.push({ kind: "text", text: delta });
  } else {
    const existing = parts[firstText] as Extract<typeof parts[number], { kind: "text" }>;
    parts[firstText] = { kind: "text", text: existing.text + delta };
  }
  const updated: UiMessage = { ...last, parts };
  const out = msgs.slice();
  out[lastIdx] = updated;
  return out;
}

/** Append a tool_call part to the last assistant message. */
export function appendToolCall(
  msgs: UiMessage[],
  call: import("../api/types.js").ToolUseBlock,
): UiMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx]!;
  const parts = [...last.parts, { kind: "tool_call" as const, call }];
  const updated: UiMessage = { ...last, parts };
  const out = msgs.slice();
  out[lastIdx] = updated;
  return out;
}

/** Append any MessagePart to the last message. */
export function appendPart(msgs: UiMessage[], part: MessagePart): UiMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx]!;
  const parts = [...last.parts, part];
  const updated: UiMessage = { ...last, parts };
  const out = msgs.slice();
  out[lastIdx] = updated;
  return out;
}

/** Patch a tool_call part with its result + outcome. */
export function applyToolResult(
  msgs: UiMessage[],
  callId: string,
  info: { approved: boolean; isError: boolean; result?: unknown; reason?: string },
): UiMessage[] {
  const out: UiMessage[] = [];
  for (const m of msgs) {
    const parts = m.parts.map((p) => {
      if (p.kind === "tool_call" && p.call.id === callId) {
        return {
          ...p,
          result: info.result,
          isError: info.isError,
          approved: info.approved,
        };
      }
      return p;
    });
    out.push({ ...m, parts });
  }
  return out;
}

/** Attach a validation-error string to the matching tool_call part.
 *  Used by the `tool_validation_error` event so the UI can show the
 *  problem inline. No-op when there is no matching part. */
export function applyValidationError(
  msgs: UiMessage[],
  callId: string,
  message: string,
): UiMessage[] {
  let touched = false;
  const out: UiMessage[] = [];
  for (const m of msgs) {
    const parts = m.parts.map((p) => {
      if (p.kind === "tool_call" && p.call.id === callId) {
        touched = true;
        return { ...p, validationError: message };
      }
      return p;
    });
    out.push({ ...m, parts });
  }
  return touched ? out : msgs;
}

/** Mark the last streaming assistant message as finalized. */
export function finalizeStreaming(msgs: UiMessage[]): UiMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx]!;
  if (!last.streaming) return msgs;
  const updated: UiMessage = { ...last, streaming: false, completedAt: new Date().toISOString() };
  const out = msgs.slice();
  out[lastIdx] = updated;
  return out;
}

// ─── Reducer ──────────────────────────────────────────────────────────────

/**
 * Pure reducer. Given the current `SessionsState` and one
 * `ServerEvent`, returns the next state.
 *
 * The reducer handles all nine wire events:
 *   - message_start       begin a new streaming assistant message
 *   - token               append text delta
 *   - tool_call           append a tool_use part
 *   - tool_result         patch the matching tool_call with its outcome
 *   - approval_required   surface an inline approval card + set status
 *   - message_done        mark the streaming message as finalized
 *   - session_renamed     refresh the matching sidebar entry
 *   - done                terminal frame — finalize + go idle
 *   - error               surface error + finalize + go error
 *
 * `done` and `message_done` are semantically equivalent in v1.14
 * (the response closes after the agent turn); we treat them the
 * same way to be defensive.
 */
export function reduceStreamEvent(
  state: SessionsState,
  sessionId: string,
  ev: ServerEvent,
): SessionsState {
  const msgs = messagesOf(state, sessionId);
  let nextMsgs: UiMessage[] = msgs;
  let status: RunStatus = state.status;
  let pendingApproval: PendingApproval | null = state.pendingApproval;
  let errorMessage: string | null = state.errorMessage;
  let nextSessions: SessionMeta[] | null = null;

  switch (ev.type) {
    case "message_start": {
      const fresh: UiMessage = {
        id: makeId("a"),
        role: "assistant",
        parts: [{ kind: "text", text: "" }],
        streaming: true,
      };
      nextMsgs = [...msgs, fresh];
      status = "streaming";
      break;
    }
    case "token": {
      nextMsgs = appendToken(msgs, ev.delta);
      break;
    }
    case "tool_call": {
      nextMsgs = appendToolCall(msgs, ev.call);
      break;
    }
    case "tool_result": {
      nextMsgs = applyToolResult(msgs, ev.call_id, {
        approved: ev.approved,
        isError: ev.is_error,
        result: ev.result,
        reason: ev.reason,
      });
      break;
    }
    case "approval_required": {
      const card: MessagePart = {
        kind: "approval",
        requestId: ev.requestId,
        tool: ev.tool,
        description: ev.description,
        ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
      };
      nextMsgs = appendPart(msgs, card);
      pendingApproval = {
        sessionId,
        requestId: ev.requestId,
        toolName: ev.tool.name,
        description: ev.description,
        ...(ev.diff !== undefined ? { diff: ev.diff } : {}),
      };
      status = "awaiting-approval";
      break;
    }
    case "message_done":
    case "done": {
      nextMsgs = finalizeStreaming(msgs);
      status = "idle";
      break;
    }
    case "session_renamed": {
      nextSessions = state.sessions.map((s) =>
        s.id === ev.sessionId ? { ...s, title: ev.title } : s,
      );
      break;
    }
    case "error": {
      errorMessage = ev.message;
      status = "error";
      nextMsgs = finalizeStreaming(msgs);
      break;
    }
  }

  return {
    ...state,
    messagesBySession: {
      ...state.messagesBySession,
      [sessionId]: nextMsgs,
    },
    sessions: nextSessions ?? state.sessions,
    status,
    pendingApproval,
    errorMessage,
  };
}

// ─── Initial state factory ────────────────────────────────────────────────

export function initialState(): SessionsState {
  return {
    sessions: [],
    activeSessionId: null,
    messagesBySession: {},
    auditBySession: {},
    pendingApproval: null,
    status: "idle",
    errorMessage: null,
    initialized: false,
  };
}