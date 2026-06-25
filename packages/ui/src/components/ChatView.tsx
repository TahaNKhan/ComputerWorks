// packages/ui/src/components/ChatView.tsx
// T7.5 — Scrollable list of messages for the active session.
//
// For now (T7.5) the message list renders the persisted transcript
// fetched by `loadTranscript`. T7.6 layers streaming tokens on top by
// reading the same store but opting into a deferred render path so a
// fast token stream doesn't re-render every message.

import React, { useEffect, useRef } from "react";
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

  // Auto-scroll to the bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, activeId]);

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
      <MessageList messages={messages} />
      {status === "connecting" && (
        <div className="cw-status">Connecting to agent…</div>
      )}
      {status === "awaiting-approval" && (
        <div className="cw-status">Waiting for approval…</div>
      )}
    </div>
  );
}