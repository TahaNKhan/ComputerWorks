// packages/ui/src/components/ChatView.tsx
// T7.5 — Scrollable list of messages for the active session.
//
// T7.6 — Streaming token deferral: `useDeferredValue` lets React
//         keep the urgent UI (composer, approval buttons) responsive
//         during a token burst by deferring the long-message-list
//         diff to a low-priority pass.
//
// T16.2 — Auto-scroll to bottom. Previously the auto-scroll
//         `useEffect` keyed on `messages.length` fired BEFORE the
//         deferred render landed, so `scrollHeight` read the stale
//         empty layout and the chat was pinned to the top after
//         loading. Fix: hoist `useDeferredValue` to ChatView (so the
//         effect can depend on the deferred value), switch to
//         `useLayoutEffect` (fires after DOM commit, before paint),
//         and depend on the deferred array — not its length.

import React, { useDeferredValue, useLayoutEffect, useRef } from "react";
import { useSessionsStore } from "../store/sessions.js";
import { MessageList } from "./MessageList.js";

export function ChatView(): JSX.Element {
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const messages = useSessionsStore((s) =>
    s.activeSessionId ? s.messagesBySession[s.activeSessionId] ?? [] : [],
  );
  const status = useSessionsStore((s) => s.status);
  const initialized = useSessionsStore((s) => s.initialized);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Defer here (not inside MessageList) so the scroll-to-bottom
  // effect below can see the same value the DOM is actually
  // rendering.
  const deferredMessages = useDeferredValue(messages);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [deferredMessages, activeId]);

  if (!activeId) {
    return <div className="cw-empty">Select a session to start chatting.</div>;
  }

  return (
    <div className="cw-chat-view" ref={scrollRef}>
      {messages.length === 0 && initialized && (
        <div className="cw-empty">
          <p>This session is empty. Type a message below to get started.</p>
        </div>
      )}
      <MessageList messages={deferredMessages} />
      {status === "connecting" && (
        <div className="cw-status">Connecting to agent…</div>
      )}
      {status === "awaiting-approval" && (
        <div className="cw-status">Waiting for approval…</div>
      )}
    </div>
  );
}