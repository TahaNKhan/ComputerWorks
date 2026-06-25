// packages/agent/src/approval.ts
// T2.1 — Approver interface and AutoApprover.
//
// Per DESIGN.MD §7:
//
//   interface ApprovalRequest {
//     call: ToolUseBlock;
//     description: string;
//     diff?: string;
//   }
//
//   type ApprovalDecision =
//     | { kind: "approve_once" }
//     | { kind: "approve_for_session"; pattern: string }
//     | { kind: "reject"; reason: string }
//     | { kind: "edit"; newInput: unknown };
//
//   interface Approver {
//     request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
//   }
//
// AutoApprover takes a policy function (sync or async) so tests and
// headless contexts can drive approval without a UI.

import type { ToolUseBlock } from "@computerworks/core";

export interface ApprovalRequest {
  call: ToolUseBlock;
  /** Human-readable summary (e.g. "run_shell: ls -la"). */
  description: string;
  /** Diff for write/edit_file approvals. */
  diff?: string;
}

export type ApprovalDecision =
  | { kind: "approve_once" }
  | { kind: "approve_for_session"; pattern: string }
  | { kind: "reject"; reason: string }
  | { kind: "edit"; newInput: unknown };

export interface Approver {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/**
 * AutoApprover delegates every request to a user-supplied policy.
 * The policy returns an `ApprovalDecision` (or a Promise of one),
 * or throws to signal that approval is impossible (e.g. fatal error).
 *
 * Used by:
 *   - Unit tests (return canned decisions)
 *   - End-to-end smoke tests
 *   - Headless runs / CI where human approval isn't available
 */
export class AutoApprover implements Approver {
  constructor(
    private readonly policy: (
      req: ApprovalRequest,
    ) => ApprovalDecision | Promise<ApprovalDecision>,
  ) {}

  async request(
    req: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) {
      throw new DOMException("Approval aborted", "AbortError");
    }
    // The policy itself is not signal-aware; if the run is cancelled
    // mid-policy, the awaited promise will simply resolve and the
    // result will be discarded by the agent loop.
    return await this.policy(req);
  }
}
