// packages/ui/src/components/ApprovalCard.tsx
// T7.9 — Inline approval card. Renders tool name, description, and
// optional diff. Approve / Reject / Edit-and-approve buttons POST to
// /api/sessions/:id/approve via the sessions store.
//
// T18.3 — Pattern-based per-session approval. The existing "Always"
// button now sends `pattern: "tool:" + <toolName>` and reads as
// "Always allow `<toolName>`". A fourth button appears when the
// pending approval is for `run_shell` with a string `cmd` whose
// first token passes `isSafeToken` — it sends
// `pattern: "tool:run_shell " + <token>` so the user can whitelist
// an entire command family in one click. See
// `docs/specs/phase-18-pattern-approval/{requirements,design}.md`
// and `lib/allowlist-derive.ts` for the derivation helpers.

import React from "react";
import type { MessagePart } from "../api/types.js";
import { useSessionsStore } from "../store/sessions.js";
import { deriveRunShellToken } from "../lib/allowlist-derive.js";

interface Props {
  part: Extract<MessagePart, { kind: "approval" }>;
}

export function ApprovalCard({ part }: Props): JSX.Element {
  const pending = useSessionsStore((s) => s.pendingApproval);
  const decide = useSessionsStore((s) => s.decideApproval);
  const status = useSessionsStore((s) => s.status);

  const isActive = pending?.requestId === part.requestId;
  const disabled = !isActive || status === "awaiting-approval" && false;
  const derived = isActive ? deriveRunShellToken(part.tool) : null;

  return (
    <div className={`cw-approval-card ${isActive ? "active" : ""}`}>
      <div className="cw-approval-header">
        <span className="cw-approval-icon">🔐</span>
        <span className="cw-approval-name">{part.tool.name}</span>
        <span className="cw-approval-status">
          {isActive ? "awaiting decision" : "decided"}
        </span>
      </div>
      <p className="cw-approval-desc">{part.description}</p>
      {part.diff && (
        <pre className="cw-approval-diff">{part.diff}</pre>
      )}
      <div className="cw-approval-actions">
        <button
          type="button"
          onClick={() => void decide({ kind: "approve_once" })}
          disabled={!isActive}
        >
          Approve once
        </button>
        <button
          type="button"
          onClick={() =>
            void decide({
              kind: "approve_for_session",
              pattern: `tool:${part.tool.name}`,
            })
          }
          disabled={!isActive}
        >
          Always allow {part.tool.name}
        </button>
        {derived && (
          <button
            type="button"
            className="cw-allow-prefix"
            onClick={() =>
              void decide({
                kind: "approve_for_session",
                pattern: `tool:run_shell ${derived.token}`,
              })
            }
            disabled={!isActive}
          >
            Always allow {derived.token} …
          </button>
        )}
        <button
          type="button"
          className="cw-reject"
          onClick={() => void decide({ kind: "reject", reason: "user rejected" })}
          disabled={!isActive}
        >
          Reject
        </button>
      </div>
    </div>
  );
}