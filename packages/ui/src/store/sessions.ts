// packages/ui/src/store/sessions.ts
// T14.2 — Zustand store, refactored to delegate SSE-event handling
// to the pure reducer in `./reducer.ts`.
//
// The store owns:
//   - network calls (POST /messages, POST /approve, etc.)
//   - URL side-effects (history API)
//   - the per-session SSE consumer (via `./stream.ts`)
//
// Components own nothing: they read state via typed selectors and
// dispatch actions. No `useState` outside the composer and the
// settings dialog.

import { create } from "zustand";
import {
  approveRequest as apiApproveRequest,
  cancelTurn as apiCancelTurn,
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  getSession as apiGetSession,
  listSessions as apiListSessions,
  patchSession as apiPatchSession,
  renameSession as apiRenameSession,
} from "../api/client.js";
import { setSessionInUrl } from "../lib/router.js";
import type {
  AuditEntry,
  ApprovalDecision,
  SessionMeta,
  UiMessage,
} from "../api/types.js";
import {
  initialState,
  makeId,
  messagesOf,
  reduceStreamEvent,
  type PendingApproval,
  type SessionsState,
} from "./reducer.js";
import { sendMessageStreaming, stopActiveStream } from "./stream.js";

// Re-export so existing consumers don't need to import from
// `./reducer.ts` separately. Keeps the public surface of the store
// module unchanged.
export type { PendingApproval, RunStatus, SessionsState } from "./reducer.js";

export interface SessionsStore extends SessionsState {
  // ─── session list ────────────────────────────────────────────────────
  loadSessions: () => Promise<void>;
  createSession: (input?: { title?: string; cwd?: string; model?: string }) => Promise<SessionMeta | null>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  switchSession: (id: string | null) => Promise<void>;
  /** T17.3 — set the SharedWorker-assigned tab UUID. Idempotent. */
  setTabId: (tabId: string) => void;
  loadTranscript: (id: string) => Promise<void>;

  // ─── messaging ───────────────────────────────────────────────────────
  sendMessage: (sessionId: string, content: string) => Promise<void>;
  cancelTurn: (sessionId: string) => Promise<void>;

  // ─── approvals ───────────────────────────────────────────────────────
  setPendingApproval: (p: PendingApproval | null) => void;
  decideApproval: (decision: ApprovalDecision) => Promise<void>;

  // ─── SSE → state ─────────────────────────────────────────────────────
  /** Merge a server event into local state. Delegates to the pure
   *  reducer — no business logic lives here. */
  applyServerEvent: (sessionId: string, ev: import("../api/types.js").ServerEvent) => void;

  /** Reset all state (used on logout / server unreachable). */
  reset: () => void;
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

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  ...initialState(),

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

  setTabId: (tabId) => {
    if (get().tabId === tabId) return;
    set({ tabId });
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
      let wasActive = false;
      set((s) => {
        const next = { ...s.messagesBySession };
        delete next[id];
        const nextAudit = { ...s.auditBySession };
        delete nextAudit[id];
        const sessions = s.sessions.filter((x) => x.id !== id);
        wasActive = s.activeSessionId === id;
        return {
          sessions,
          messagesBySession: next,
          auditBySession: nextAudit,
          activeSessionId: wasActive ? null : s.activeSessionId,
        };
      });
      if (wasActive) setSessionInUrl(null);
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
    // Stop any active stream from the previous session.
    stopActiveStream();
    set({ activeSessionId: id, pendingApproval: null, errorMessage: null });
    setSessionInUrl(id);
    if (id && !get().messagesBySession[id]) {
      await get().loadTranscript(id);
    }
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

  sendMessage: async (sessionId, content) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    // Append the user message optimistically so the UI feels instant.
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

    // Open the per-message SSE stream and route every event through
    // the reducer. Errors land in `errorMessage`; success returns
    // the user to `idle`.
    await sendMessageStreaming(sessionId, trimmed, {
      // T17.3 — pass the tab UUID so the server can stamp
      // `message_appended` events with our originator. The reducer
      // uses this to skip our own broadcast echo on the central SSE.
      ...(get().tabId ? { originator: get().tabId! } : {}),
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        set({ errorMessage: message, status: "error" });
      },
      onDone: () => {
        set({ status: "idle" });
      },
    });
  },

  cancelTurn: async (sessionId) => {
    stopActiveStream();
    try {
      await apiCancelTurn(sessionId);
    } catch (err) {
      set({ errorMessage: (err as Error).message ?? "Failed to cancel turn" });
    }
  },

  setPendingApproval: (p) =>
    set({ pendingApproval: p, status: p ? "awaiting-approval" : get().status }),

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

  // SSE → state. Single line; all transitions live in the reducer.
  applyServerEvent: (sessionId, ev) => {
    set((s) => reduceStreamEvent(s, sessionId, ev));
  },

  reset: () => {
    stopActiveStream();
    set(initialState());
  },
}));

// ─── Wire apiPatchSession so Settings can update the active session's model ──
export { apiPatchSession as patchSessionApi };