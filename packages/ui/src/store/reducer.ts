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
  SessionMessage,
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
  /** T17.3 — tab UUID assigned by the SharedWorker. Set once on
   *  mount (the listener awaits `initSync`) and used by the
   *  reducer to dedupe `message_appended` events the originating
   *  tab's own POST triggered. */
  tabId: string | null;
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// T17.3 — convert a single server-side message to a UiMessage.
// The `id` is a client-generated prefix + the server's ts (which
// is stable across subscribers); `_cw_ts` carries the bare ts
// for idempotent dedupe in the reducer.
//
// Returns `null` for messages that should never be rendered in
// the chat:
//   - `role: "tool"` / `role: "system"` — tool outputs and
//     system prompts aren't user-visible narrative.
//   - assistant messages whose only content is a `tool_use`
//     block — they represent the model invoking a tool with
//     no text; the tool's outcome arrives in a separate
//     message.
//
// For assistant messages with mixed `text` + `tool_use` content,
// only the `text` blocks are kept; `tool_use` blocks are
// dropped. This matches the live-streaming behavior, where
// `tool_result` events cause `removeToolCall` to drop the
// tool_call block from the chat.
function serverMessageToUi(message: SessionMessage, ts: string): UiMessage | null {
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content : "";
    if (!text) return null;
    return {
      id: `m-${ts}`,
      role: "user",
      parts: [{ kind: "text", text }],
    };
  }
  if (message.role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (!text) return null;
    return {
      id: `m-${ts}`,
      role: "assistant",
      parts: [{ kind: "text", text }],
    };
  }
  return null;
}

/** Convert a server-side transcript (e.g. from GET /api/sessions/:id)
 *  to a list of UI messages, dropping tool/system/tool_use-only
 *  messages. Used by `loadTranscript` (refresh + session switch)
 *  and is the same shape the `message_appended` reducer path
 *  produces for a single message. */
export function transcriptToUi(messages: SessionMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const m of messages) {
    // Pin the id to the message's position in the transcript so a
    // subsequent `message_appended` for one of these messages is
    // deduped via the reducer's `_cw_ts` check (the reducer tags
    // each fresh message with `_cw_ts = "<sessionId>:<ts>"`).
    const fresh = serverMessageToUi(m, `tx-${out.length}`);
    if (fresh) out.push(fresh);
  }
  return out;
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
      // T19.8 — propagate `titleSource` so the sidebar can
      // decide whether the title change came from an SSE-driven
      // tool call (animate) or a manual user PATCH (no
      // animation). Missing field defaults to "auto" for forward
      // compat with pre-T19 servers.
      const source = ev.titleSource ?? "auto";
      nextSessions = state.sessions.map((s) =>
        s.id === ev.sessionId ? { ...s, title: ev.title, titleSource: source } : s,
      );
      break;
    }
    case "message_appended": {
      // T17.3 — central-SSE-only event. Originator dedupe: the
      // leading tab has the message already (optimistic append),
      // so we skip. Re-connect dedupe uses the server's `ts` (a
      // per-message stable timestamp) — `id` is client-generated
      // and doesn't survive re-mount, but `ts` does.
      //
      // T19 — `serverMessageToUi` returns `null` for tool/system
      // messages and assistant messages with no text. The chat
      // doesn't render those, so we drop them on the floor here
      // too (the live broadcast from the server carries the full
      // transcript, including tool result messages).
      if (ev.originator === state.tabId) return state;
      const sessionMessages = messagesOf(state, ev.sessionId);
      const tsKey = `${ev.sessionId}:${ev.ts}`;
      if (sessionMessages.some((m) => (m as UiMessage & { _cw_ts?: string })._cw_ts === tsKey)) {
        nextMsgs = sessionMessages;
        break;
      }
      const fresh = serverMessageToUi(ev.message, ev.ts);
      if (!fresh) {
        nextMsgs = sessionMessages;
        break;
      }
      (fresh as UiMessage & { _cw_ts?: string })._cw_ts = tsKey;
      nextMsgs = [...sessionMessages, fresh];
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
    tabId: null,
  };
}