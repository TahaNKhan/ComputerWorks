// packages/server/src/interactive-approver.ts
// T14.1 — Interactive approver, refactored for per-message SSE.
//
// v1.0–v1.13: the approver took an `SSEManager` and routed events
// through a global broadcast queue; an `ApproverRegistry` keyed on
// sessionId allowed the /approve route to find the right approver.
//
// v1.14: there is no broadcast queue. Each `POST /messages` handler
// owns a per-response `SSEWriter` (see sse-writer.ts). The approver
// takes a `writer` instead of an SSEManager and emits its events
// directly to the response that triggered the agent run. The
// `(requestId → resolver)` map is owned by the approver instance,
// which lives for exactly one turn; the messages route stores the
// approver on the `SessionRuntime` so the /approve route can find it.

import { randomUUID } from "node:crypto";
import type {
  Approver,
  ApprovalDecision,
  ApprovalRequest,
} from "@computerworks/agent";
import type { SSEWriter } from "./sse-writer.js";
import type { ServerEvent } from "./sse.js";

export interface InteractiveApproverOptions {
  /** Override the default 5-minute timeout. */
  timeoutMs?: number;
}

export class InteractiveApprover implements Approver {
  public readonly sessionId: string;
  private readonly writer: SSEWriter;
  private readonly sessionAllowlist: readonly string[];
  private readonly globalShellAllowlist: readonly RegExp[];
  private readonly timeoutMs: number;
  /** In-flight requestIds → resolver. Keyed locally so the lookup is
   *  O(1) and the approver is self-contained (no global registry). */
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  constructor(
    writer: SSEWriter,
    sessionId: string,
    sessionAllowlist: readonly string[],
    globalShellAllowlist: readonly RegExp[],
    opts: InteractiveApproverOptions = {},
  ) {
    this.writer = writer;
    this.sessionId = sessionId;
    this.sessionAllowlist = sessionAllowlist;
    this.globalShellAllowlist = globalShellAllowlist;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  }

  /** Called by the agent loop when a tool needs approval. */
  async request(
    req: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    // 1. Check global shell allowlist (still logged via tool_result).
    if (req.call.name === "run_shell" && this.matchesGlobalShell(req.call.input)) {
      this.writer.write({
        type: "tool_result",
        call_id: req.call.id,
        approved: true,
        result: undefined,
        is_error: false,
      });
      return { kind: "approve_once" };
    }

    // 2. Check session allowlist.
    if (this.matchesSessionAllowlist(req.call)) {
      this.writer.write({
        type: "tool_result",
        call_id: req.call.id,
        approved: true,
        result: undefined,
        is_error: false,
      });
      return { kind: "approve_once" };
    }

    // 3. Otherwise, prompt the user via the per-response SSE stream.
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
          this.writer.write({
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
        this.writer.write({
          type: "tool_result",
          call_id: req.call.id,
          approved: decision.kind !== "reject",
          result: undefined,
          is_error: decision.kind === "reject",
          reason: decision.kind === "reject" ? decision.reason : undefined,
        });
        resolve(decision);
      });

      const approvalEvent: ServerEvent = {
        type: "approval_required",
        requestId,
        tool: req.call,
        description: req.description,
        ...(req.diff !== undefined ? { diff: req.diff } : {}),
      };
      this.writer.write(approvalEvent);
    });
  }

  /** Resolve a pending approval by id. Returns true if a resolver
   *  fired; false if no such request is pending on this approver. */
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

  private matchesGlobalShell(input: unknown): boolean {
    if (!input || typeof input !== "object") return false;
    const cmd = (input as { cmd?: unknown }).cmd;
    if (typeof cmd !== "string") return false;
    return this.globalShellAllowlist.some((re) => re.test(cmd));
  }

  private matchesSessionAllowlist(call: { name: string; input: unknown }): boolean {
    if (this.sessionAllowlist.length === 0) return false;
    return this.sessionAllowlist.some((pattern) => pattern === call.name);
  }
}