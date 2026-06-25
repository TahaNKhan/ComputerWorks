// packages/ui/src/components/Message.tsx
// T7.5 — Render one UiMessage's parts in order.
// T7.7 — text parts render through the Markdown component (GFM +
//        shiki highlight + sanitized HTML).
// T7.8 — tool_call parts render through ToolCallBlock.
// T7.9 — approval parts render through ApprovalCard.

import React from "react";
import type { UiMessage } from "../api/types.js";
import { Markdown } from "./Markdown.js";
import { ToolCallBlock } from "./ToolCallBlock.js";
import { ApprovalCard } from "./ApprovalCard.js";

interface Props {
  message: UiMessage;
}

export function Message({ message }: Props): JSX.Element {
  return (
    <div className="cw-message-body">
      {message.parts.map((part, idx) => {
        if (part.kind === "text") {
          const text = part.text || (message.streaming ? "…" : "");
          // User messages render as plain text; assistant messages go
          // through the markdown renderer.
          if (message.role === "user") {
            return (
              <p key={idx} className="cw-message-text">
                {text}
              </p>
            );
          }
          return <Markdown key={idx} source={text} />;
        }
        if (part.kind === "tool_call") {
          return <ToolCallBlock key={idx} part={part} />;
        }
        // Approval part.
        return <ApprovalCard key={idx} part={part} />;
      })}
    </div>
  );
}