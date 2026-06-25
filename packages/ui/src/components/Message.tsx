// packages/ui/src/components/Message.tsx
// T7.5 — Render one UiMessage's parts in order. Plain text for now;
// Markdown and tool/approval cards are added in T7.7–T7.9.

import React from "react";
import type { UiMessage } from "../api/types.js";

interface Props {
  message: UiMessage;
}

export function Message({ message }: Props): JSX.Element {
  return (
    <div className="cw-message-body">
      {message.parts.map((part, idx) => {
        if (part.kind === "text") {
          return (
            <p key={idx} className="cw-message-text">
              {part.text || (message.streaming ? "…" : "")}
            </p>
          );
        }
        if (part.kind === "tool_call") {
          return (
            <pre key={idx} className="cw-tool-call-stub">
              tool: {part.call.name}
            </pre>
          );
        }
        // Approval card — full UI in T7.9.
        return (
          <div key={idx} className="cw-approval-stub">
            Approval required: {part.tool.name}
          </div>
        );
      })}
    </div>
  );
}