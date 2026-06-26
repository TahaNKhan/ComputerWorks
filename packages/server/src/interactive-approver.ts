// packages/server/src/interactive-approver.ts
// T5.5 — Interactive approver.
//
// Implements the `Approver` interface (from @computerworks/agent) for
// the server. When the agent loop needs approval for a tool call, this
// class:
//
//   1. Emits an `approval_required` ServerEvent over the SSE channel.
//   2. Waits for a human to POST /api/sessions/:id/approve.
//   3. Resolves with the ApprovalDecision.
//
// Allowlists:
//   - `globalShellAllowlist` (regex[]) bypasses the prompt for matching
//     run_shell commands. The decision is still logged as
//     `auto_approve`.
//   - `sessionAllowlist` (string[]) does the same for any tool — these
//     are the session's user-set per-tool allow patterns from meta.json.
//
// Timeout:
//   - Default 5 minutes. On timeout, returns a `reject` decision with
//     reason "approval timeout". The agent loop will turn that into a
//     `tool_result` with is_error: true.
//
// Threading:
//   - The `decision` resolver is a singleton per approver instance
//     (which the agent loop creates fresh per turn). `resolve()` is
//     called by the /approve route handler in response to the POST.

import { randomUUID } from "node:crypto";
import type {
  Approver,
  ApprovalDecision,
  ApprovalRequest,
} from "@computerworks/agent";
import type { SSEManager, ServerEvent } from "./sse.js";

export interface InteractiveApproverOptions {
  /** Override the default 5-minute timeout. */
  timeoutMs?: number;
  /** Optional logger hook (used in tests to capture events). */
  onEvent?: (event: ServerEvent) => void;
}

export class InteractiveApprover implements Approver {
  private readonly manager: SSEManager;
  public readonly sessionId: string;
  private readonly globalShellAllowlist: readonly RegExp[];
  private readonly sessionAllowlist: readonly string[];
  private readonly timeoutMs: number;
  private readonly onEvent?: (event: ServerEvent) => void;
  /** Set of in-flight requestIds → resolver. */
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  constructor(
    manager: SSEManager,
    sessionId: string,
    sessionAllowlist: readonly string[],
    globalShellAllowlist: readonly RegExp[],
    opts: InteractiveApproverOptions = {},
  ) {
    this.manager = manager;
    this.sessionId = sessionId;
    this.sessionAllowlist = sessionAllowlist;
    this.globalShellAllowlist = globalShellAllowlist;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    this.onEvent = opts.onEvent;
  }

  /** Called by the agent loop when a tool needs approval. */
  async request(
    req: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    // 1. Check global shell allowlist (design says: still logged).
    if (req.call.name === "run_shell" && this.matchesGlobalShell(req.call.input)) {
      this.emit({ type: "tool_result", call_id: req.call.id, approved: true, result: undefined, is_error: false });
      return { kind: "approve_once" };
    }

    // 2. Check session allowlist.
    if (this.matchesSessionAllowlist(req.call)) {
      this.emit({ type: "tool_result", call_id: req.call.id, approved: true, result: undefined, is_error: false });
      return { kind: "approve_once" };
    }

    // 3. Otherwise, prompt the user via SSE.
    const requestId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      // Timeout handler.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ kind: "reject", reason: "aborted" });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(requestId);
          this.emit({
            type: "tool_result",
            call_id: req.call.id,
            approved: false,
            result: undefined,
            is_error: true,
            reason: "approval timeout",
          });
          resolve({ kind: "reject", reason: "approval timeout" });
        }, this.timeoutMs);
      }

      this.pending.set(requestId, (decision) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);
        // Emit a tool_result so the client UI can show the decision.
        this.emit({
          type: "tool_result",
          call_id: req.call.id,
          approved: decision.kind !== "reject",
          result: undefined,
          is_error: decision.kind === "reject",
          reason: decision.kind === "reject" ? decision.reason : undefined,
        });
        resolve(decision);
      });

      this.emit({
        type: "approval_required",
        requestId,
        tool: req.call,
        description: req.description,
        diff: req.diff,
      });
    });
  }

  /** Called by the ApproverRegistry when the /approve route fires.
   *  Returns true if a pending request was resolved. */
  resolveById(requestId: string, decision: ApprovalDecision): boolean {
    const r = this.pending.get(requestId);
    if (!r) return false;
    r(decision);
    return true;
  }

  /** Test helper. */
  pendingCount(): number {
    return this.pending.size;
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private emit(event: ServerEvent): void {
    if (this.onEvent) this.onEvent(event);
    this.manager.send(this.sessionId, event);
  }

  private matchesGlobalShell(input: unknown): boolean {
    if (!input || typeof input !== "object") return false;
    const cmd = (input as { cmd?: unknown }).cmd;
    if (typeof cmd !== "string") return false;
    return this.globalShellAllowlist.some((re) => re.test(cmd));
  }

  private matchesSessionAllowlist(call: { name: string; input: unknown }): boolean {
    if (this.sessionAllowlist.length === 0) return false;
    // We accept either a string (exact tool name match) or a string
    // like "tool:pattern" for finer matching. For v1 we keep it simple
    // and just match by tool name.
    return this.sessionAllowlist.some((pattern) => pattern === call.name);
  }
}

/** A registry that maps sessionId → InteractiveApprover instance.
 *
 *  The agent loop creates one approver per turn and registers it here.
 *  The /approve route looks up the session's approver and delegates
 *  to its resolveById(). The registry owns the lifetime of all
 *  approvers; the routes/messages handler removes the entry when the
 *  turn ends.
 */
export class ApproverRegistry {
  private readonly instances = new Map<string, InteractiveApprover>();

  register(approver: InteractiveApprover): void {
    this.instances.set(approver.sessionId, approver);
  }

  unregister(sessionId: string): void {
    this.instances.delete(sessionId);
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    for (const approver of this.instances.values()) {
      if (approver.resolveById(requestId, decision)) return true;
    }
    return false;
  }
}
