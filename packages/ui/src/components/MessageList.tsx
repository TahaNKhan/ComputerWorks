// packages/ui/src/components/MessageList.tsx
// T7.5 — Renders the ordered list of `UiMessage`s for the active session.
// T7.6 — Uses `useDeferredValue` so fast token streams don't block the
//         urgent UI (composer, approval buttons). React will paint the
//         urgent updates at high priority and apply the long-message
//         diff in a deferred pass.

import React, { useDeferredValue } from "react";
import type { UiMessage } from "../api/types.js";
import { Message } from "./Message.js";

interface MessageListProps {
  messages: UiMessage[];
}

export function MessageList({ messages }: MessageListProps): JSX.Element {
  // Defer the heavy list render so token bursts don't queue up renders
  // of every historical message. The streamed text part inside the
  // last message still updates quickly because Message is a child
  // component and React reconciles at the part level.
  const deferred = useDeferredValue(messages);
  return (
    <ol className="cw-message-list" aria-label="Messages">
      {deferred.map((m) => (
        <li key={m.id} className={`cw-message cw-message-${m.role}`}>
          <Message message={m} />
        </li>
      ))}
    </ol>
  );
}