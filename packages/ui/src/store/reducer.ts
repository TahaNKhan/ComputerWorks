// packages/ui/src/store/reducer.ts
// T14.2 — Pure reducer for SSE → UI state transitions.
//
// The single source of truth for every `ServerEvent` the server can
// send. Pure function: `(state, event) → state`. No React, no
// zustand, no fetch. The store's `applyServerEvent` action is a
// one-liner that delegates here.
//
// All the helpers (`appendToken`, `appendToolCall`, `removeToolCall`,
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

/** Remove the tool_call part (and its associated `approval` card, if
 *  any) once the tool's fate is decided — `tool_result` for any
 *  tool, whether approved, rejected, errored, or runtime-failed.
 *  The chat drops the block; the server-side audit log and the
 *  on-disk transcript still have the full record. */
export function removeToolCall(msgs: UiMessage[], callId: string): UiMessage[] {
  const out: UiMessage[] = [];
  for (const m of msgs) {
    const parts = m.parts.filter((p) => {
      if (p.kind === "tool_call" && p.call.id === callId) return false;
      // Drop the approval card that was rendered for the same tool
      // call (if any). The approval card's `tool.id` matches the
      // tool_use id we received in `approval_required`.
      if (p.kind === "approval" && p.tool.id === callId) return false;
      return true;
    });
    out.push(parts.length === m.parts.length ? m : { ...m, parts });
  }
  return out;
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
 *   - tool_result         drop the matching tool_call (and approval
 *                         card) — the tool's outcome is in, the chat
 *                         doesn't need to keep showing the block
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
      // Once the tool's outcome is decided, drop the tool_call block
      // and its approval card from the chat. The server still records
      // the decision in the audit log and on-disk transcript.
      nextMsgs = removeToolCall(msgs, ev.call_id);
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