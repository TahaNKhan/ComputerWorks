// packages/ui/src/components/Composer.tsx
// T7.5 — Text area + send button. Submits via the sessions store's
// `sendMessage` action. Keyboard shortcuts (Cmd/Ctrl+Enter to send,
// Esc to cancel) are wired in T7.10.

import React, { useState } from "react";
import { useSessionsStore } from "../store/sessions.js";

export function Composer(): JSX.Element {
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const status = useSessionsStore((s) => s.status);
  const sendMessage = useSessionsStore((s) => s.sendMessage);
  const cancelTurn = useSessionsStore((s) => s.cancelTurn);
  const [draft, setDraft] = useState("");

  const busy = status === "connecting" || status === "streaming" || status === "awaiting-approval";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId) return;
    const text = draft.trim();
    if (!text) return;
    void sendMessage(activeId, text);
    setDraft("");
  };

  return (
    <form className="cw-composer" onSubmit={onSubmit}>
      <textarea
        className="cw-composer-input"
        placeholder={activeId ? "Type a message… (Cmd/Ctrl+Enter to send)" : "Select a session first"}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        rows={3}
        disabled={!activeId}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            onSubmit(e);
          }
        }}
      />
      <div className="cw-composer-actions">
        {busy && activeId && (
          <button
            type="button"
            className="cw-cancel"
            onClick={() => void cancelTurn(activeId)}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          className="cw-send"
          disabled={!activeId || draft.trim().length === 0 || busy}
        >
          Send
        </button>
      </div>
    </form>
  );
}