// packages/ui/src/components/MessageList.tsx
// T7.5 — Renders the ordered list of `UiMessage`s for the active session.
//
// T7.6 will keep this same component but route it through
// `useDeferredValue` so per-token re-renders don't blow up the entire
// list. For now we render synchronously and let React handle it.

import React from "react";
import type { UiMessage } from "../api/types.js";
import { Message } from "./Message.js";

interface MessageListProps {
  messages: UiMessage[];
}

export function MessageList({ messages }: MessageListProps): JSX.Element {
  return (
    <ol className="cw-message-list" aria-label="Messages">
      {messages.map((m) => (
        <li key={m.id} className={`cw-message cw-message-${m.role}`}>
          <Message message={m} />
        </li>
      ))}
    </ol>
  );
}