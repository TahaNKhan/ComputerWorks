// packages/ui/src/components/MessageList.tsx
// T7.5 — Renders the ordered list of `UiMessage`s for the active session.
// T7.6 — Streaming deferral was previously done here with
//         `useDeferredValue`. As of T16.2 the deferral happens one
//         level up in `ChatView` so the scroll-to-bottom
//         `useLayoutEffect` can read the same value the DOM is
//         rendering — otherwise the auto-scroll fired before the
//         deferred render landed and the chat pinned to the top.

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