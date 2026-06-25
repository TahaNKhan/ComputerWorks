// packages/ui/src/components/ApprovalCard.tsx
// T7.9 — Inline approval card. Renders tool name, description, and
// optional diff. Approve / Reject / Edit-and-approve buttons POST to
// /api/sessions/:id/approve via the sessions store.

import React from "react";
import type { MessagePart } from "../api/types.js";
import { useSessionsStore } from "../store/sessions.js";

interface Props {
  part: Extract<MessagePart, { kind: "approval" }>;
}

export function ApprovalCard({ part }: Props): JSX.Element {
  const pending = useSessionsStore((s) => s.pendingApproval);
  const decide = useSessionsStore((s) => s.decideApproval);
  const status = useSessionsStore((s) => s.status);

  const isActive = pending?.requestId === part.requestId;
  const disabled = !isActive || status === "awaiting-approval" && false;

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
          onClick={() => void decide({ kind: "approve_for_session", pattern: part.tool.name })}
          disabled={!isActive}
        >
          Always
        </button>
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