// packages/ui/src/store/sessions.ts
// T7.3 — Zustand store for the session list, the active session, its
// messages, and the in-flight approval request.
//
// State shape:
//   - sessions: list of session metadata (sidebar)
//   - activeSessionId: which session is currently open
//   - messages: per-session transcript (rendered in MessageList)
//   - inFlight: the active streaming assistant message, if any
//   - pendingApproval: the request waiting for a user decision
//   - status: 'idle' | 'connecting' | 'streaming' | 'awaiting-approval' | 'error'
//
// The store does NOT own network code — it exposes actions that call
// the API client in `../api/client.ts`. SSE token merging lives in
// `../store/stream.ts` (added in T7.6).

import { create } from "zustand";
import {
  approveRequest as apiApproveRequest,
  cancelTurn as apiCancelTurn,
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  getSession as apiGetSession,
  listSessions as apiListSessions,
  patchSession as apiPatchSession,
  postMessage as apiPostMessage,
  renameSession as apiRenameSession,
} from "../api/client.js";
import type {
  AuditEntry,
  ApprovalDecision,
  SessionMeta,
  UiMessage,
} from "../api/types.js";
import {
  getSessionFromUrl,
  setSessionInUrl,
  subscribeUrlChange,
} from "../lib/router.js";

// ─── Types ────────────────────────────────────────────────────────────────

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

  // ─── actions ──────────────────────────────────────────────────────────
  loadSessions: () => Promise<void>;
  createSession: (input?: { title?: string; cwd?: string; model?: string }) => Promise<SessionMeta | null>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  switchSession: (id: string | null) => Promise<void>;
  loadTranscript: (id: string) => Promise<void>;

  /**
   * T12.1 — Apply the `?session=<id>` query param to local state.
   *
   * Behavior:
   *   - If the URL has a session id and it names a session in the
   *     already-loaded list, make it the active session (no-op if
   *     already active). If its transcript hasn't been loaded yet,
   *     load it.
   *   - If the URL has a session id but it does NOT match any known
   *     session, clear the param and surface an error toast — the
   *     bookmark is stale.
   *   - If the URL has no session param, do nothing.
   *
   * Safe to call before `loadSessions()` resolves: when called early,
   * we re-run the URL apply after the session list settles (the
   * typical boot order is `loadSessions` → `initFromUrl`).
   */
  initFromUrl: () => Promise<void>;

  sendMessage: (sessionId: string, content: string) => Promise<void>;
  cancelTurn: (sessionId: string) => Promise<void>;

  setPendingApproval: (p: PendingApproval | null) => void;
  decideApproval: (decision: ApprovalDecision) => Promise<void>;

  /** Merge a server event into local state. Called from stream.ts. */
  applyServerEvent: (sessionId: string, ev: import("../api/types.js").ServerEvent) => void;

  /** Reset all state (used on logout / server unreachable). */
  reset: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function messagesOf(state: SessionsState, sessionId: string): UiMessage[] {
  return state.messagesBySession[sessionId] ?? [];
}

function setMessages(
  state: SessionsState,
  sessionId: string,
  msgs: UiMessage[],
): Partial<SessionsState> {
  return { messagesBySession: { ...state.messagesBySession, [sessionId]: msgs } };
}

function setAudit(
  state: SessionsState,
  sessionId: string,
  audit: AuditEntry[],
): Partial<SessionsState> {
  return { auditBySession: { ...state.auditBySession, [sessionId]: audit } };
}

// ─── Store ────────────────────────────────────────────────────────────────

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  auditBySession: {},
  pendingApproval: null,
  status: "idle",
  errorMessage: null,
  initialized: false,

  // ─── session list ────────────────────────────────────────────────────

  loadSessions: async () => {
    try {
      const list = await apiListSessions();
      set({ sessions: list, initialized: true, errorMessage: null });
    } catch (err) {
      set({
        initialized: true,
        errorMessage: (err as Error).message ?? "Failed to load sessions",
      });
    }
  },

  createSession: async (input) => {
    try {
      const meta = await apiCreateSession(input ?? {});
      set((s) => ({
        sessions: [meta, ...s.sessions.filter((x) => x.id !== meta.id)],
        activeSessionId: meta.id,
        messagesBySession: { ...s.messagesBySession, [meta.id]: [] },
        auditBySession: { ...s.auditBySession, [meta.id]: [] },
        errorMessage: null,
      }));
      // Reflect the new session in the URL so the back button can
      // return to it and the address bar is shareable.
      setSessionInUrl(meta.id);
      return meta;
    } catch (err) {
      set({ errorMessage: (err as Error).message ?? "Failed to create session" });
      return null;
    }
  },

  deleteSession: async (id) => {
    try {
      await apiDeleteSession(id);
      set((s) => {
        const next = { ...s.messagesBySession };
        delete next[id];
        const nextAudit = { ...s.auditBySession };
        delete nextAudit[id];
        const sessions = s.sessions.filter((x) => x.id !== id);
        return {
          sessions,
          messagesBySession: next,
          auditBySession: nextAudit,
          activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
        };
      });
    } catch (err) {
      set({ errorMessage: (err as Error).message ?? "Failed to delete session" });
    }
  },

  renameSession: async (id, title) => {
    try {
      const updated = await apiRenameSession(id, title);
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? updated : x)),
      }));
    } catch (err) {
      set({ errorMessage: (err as Error).message ?? "Failed to rename session" });
    }
  },

  switchSession: async (id) => {
    set({ activeSessionId: id, pendingApproval: null, errorMessage: null });
    // Keep the URL in sync with the active session so the page is
    // bookmarkable / shareable and the back button walks the history.
    setSessionInUrl(id);
    if (id && !get().messagesBySession[id]) {
      await get().loadTranscript(id);
    }
  },

  initFromUrl: async () => {
    const urlId = getSessionFromUrl();
    if (urlId === null) return;
    // If the session list hasn't been fetched yet, run the URL apply
    // immediately after it settles. We don't want to start a parallel
    // fetch — `loadSessions()` is the single source of truth for the
    // session list, and is called from App.tsx's boot effect.
    const state = get();
    if (!state.initialized) {
      // Poll on a microtask tick until initialized flips. Cheap and
      // avoids exposing a "promise" of the load via the store.
      for (let i = 0; i < 200 && !get().initialized; i++) {
        await Promise.resolve();
      }
    }
    const after = get();
    const known = after.sessions.some((s) => s.id === urlId);
    if (!known) {
      // Stale bookmark — clear it and toast so the user knows.
      setSessionInUrl(null);
      set({
        errorMessage: `Session "${urlId}" not found on this server.`,
      });
      return;
    }
    if (after.activeSessionId === urlId) return;
    // Reuse switchSession so transcript loading + URL writes go
    // through the same path (idempotent on the URL write).
    await after.switchSession(urlId);
  },

  loadTranscript: async (id) => {
    try {
      const res = await apiGetSession(id);
      const msgs: UiMessage[] = res.messages.map((m) => {
        if (m.role === "user") {
          const text =
            typeof m.content === "string"
              ? m.content
              : (m.content.find((b) => b.type === "text")?.text ?? "");
          return {
            id: makeId("u"),
            role: "user",
            parts: [{ kind: "text", text }],
          };
        }
        if (m.role === "assistant") {
          const text =
            typeof m.content === "string"
              ? m.content
              : (m.content.find((b) => b.type === "text")?.text ?? "");
          return {
            id: makeId("a"),
            role: "assistant",
            parts: text ? [{ kind: "text", text }] : [],
          };
        }
        if (m.role === "tool") {
          const text =
            typeof m.content === "string"
              ? m.content
              : (m.content.find((b) => b.type === "tool_result")?.content ?? "");
          return {
            id: makeId("t"),
            role: "assistant",
            parts: [{ kind: "text", text }],
          };
        }
        return {
          id: makeId("s"),
          role: "assistant",
          parts: [],
        };
      });
      set((s) => ({
        ...setMessages(s, id, msgs),
        ...setAudit(s, id, res.audit),
      }));
    } catch (err) {
      set({ errorMessage: (err as Error).message ?? "Failed to load transcript" });
    }
  },

  // ─── messaging ───────────────────────────────────────────────────────

  sendMessage: async (sessionId, content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const userMsg: UiMessage = {
      id: makeId("u"),
      role: "user",
      parts: [{ kind: "text", text: trimmed }],
    };
    set((s) => {
      const existing = messagesOf(s, sessionId);
      return setMessages(s, sessionId, [...existing, userMsg]);
    });
    set({ status: "connecting", errorMessage: null, pendingApproval: null });
    try {
      await apiPostMessage(sessionId, { content: trimmed });
      set({ status: "streaming" });
    } catch (err) {
      const message = (err as Error).message ?? "Failed to send message";
      set({ status: "error", errorMessage: message });
    }
  },

  cancelTurn: async (sessionId) => {
    try {
      await apiCancelTurn(sessionId);
    } catch (err) {
      set({ errorMessage: (err as Error).message ?? "Failed to cancel turn" });
    }
  },

  // ─── approvals ───────────────────────────────────────────────────────

  setPendingApproval: (p) => set({ pendingApproval: p, status: p ? "awaiting-approval" : get().status }),

  decideApproval: async (decision) => {
    const p = get().pendingApproval;
    if (!p) return;
    try {
      await apiApproveRequest(p.sessionId, p.requestId, decision);
      set({ pendingApproval: null, status: "streaming" });
    } catch (err) {
      set({
        status: "error",
        errorMessage: (err as Error).message ?? "Failed to send approval decision",
      });
    }
  },

  // ─── SSE → state ─────────────────────────────────────────────────────
  // Reducer-style handler. The full streaming behavior (tokens, tool
  // calls, etc.) is implemented in ../store/stream.ts and routed here.
  applyServerEvent: (sessionId, ev) => {
    set((s) => reduceEvent(s, sessionId, ev));
  },

  reset: () => {
    set({
      sessions: [],
      activeSessionId: null,
      messagesBySession: {},
      auditBySession: {},
      pendingApproval: null,
      status: "idle",
      errorMessage: null,
      initialized: false,
    });
  },
}));

// ─── URL → store bridge (popstate) ─────────────────────────────────────────

// Wire the browser back/forward buttons to the store once at module
// load. The popstate handler reads the URL via the router helpers and
// applies it through the same `switchSession` path the UI uses, so the
// transcript reload behavior is identical to a click-driven switch.
//
// We deliberately skip writes to the URL here — `pushState` is what
// triggers popstate in the first place, so writing the URL again would
// be a no-op echo. The router helpers already guard `typeof window`,
// so this is a no-op under bun test or SSR.
subscribeUrlChange((id) => {
  const state = useSessionsStore.getState();
  if (state.activeSessionId === id) return;
  void state.switchSession(id);
});

// ─── Reducer-style event merging ──────────────────────────────────────────

function reduceEvent(
  state: SessionsState,
  sessionId: string,
  ev: import("../api/types.js").ServerEvent,
): Partial<SessionsState> {
  const msgs = messagesOf(state, sessionId);
  let nextMsgs: UiMessage[] = msgs;
  let status: RunStatus = state.status;
  let pendingApproval: PendingApproval | null = state.pendingApproval;
  let errorMessage: string | null = state.errorMessage;

  switch (ev.type) {
    case "message_start": {
      // Begin a fresh streaming assistant message.
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
      // Append delta to the last streaming assistant text part.
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
    case "tool_validation_error": {
      // Attach the validation message to the matching tool_call part so
      // the UI renders it inline (T11.x). This is distinct from a
      // runtime tool failure; we want it to look like "the model
      // emitted bad args" instead of "tool crashed".
      nextMsgs = applyValidationError(msgs, ev.call_id, ev.message);
      break;
    }
    case "approval_required": {
      // Append an inline approval card to the message stream.
      const card: import("../api/types.js").MessagePart = {
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
    case "message_done": {
      nextMsgs = finalizeStreaming(msgs);
      status = "idle";
      break;
    }
    case "done": {
      nextMsgs = finalizeStreaming(msgs);
      status = "idle";
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
    ...setMessages(state, sessionId, nextMsgs),
    status,
    pendingApproval,
    errorMessage,
  };
}

// ─── Pure helpers (exported for tests) ────────────────────────────────────

export function appendToken(msgs: UiMessage[], delta: string): UiMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx]!;
  if (last.role !== "assistant" || !last.streaming) {
    // No streaming target; start a new message.
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

export function appendPart(
  msgs: UiMessage[],
  part: import("../api/types.js").MessagePart,
): UiMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx]!;
  const parts = [...last.parts, part];
  const updated: UiMessage = { ...last, parts };
  const out = msgs.slice();
  out[lastIdx] = updated;
  return out;
}

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

/**
 * Attach a tool-validation error message to the matching tool_call
 * part. This is the UI-side counterpart of the agent's
 * `ToolValidationError` — the model emitted a tool call that the
 * server's zod schema rejected, and we want to show that fact inline
 * rather than as a generic failed-tool badge.
 */
export function applyValidationError(
  msgs: UiMessage[],
  callId: string,
  message: string,
): UiMessage[] {
  const out: UiMessage[] = [];
  for (const m of msgs) {
    const parts = m.parts.map((p) => {
      if (p.kind === "tool_call" && p.call.id === callId) {
        return { ...p, validationError: message };
      }
      return p;
    });
    out.push({ ...m, parts });
  }
  return out;
}

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