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
//
// T17.2 — `approval_required` and `tool_result` move off the
// per-request `SSEWriter` and onto the central SSE (via `SyncHub`).
// The leader sees them on the central SSE — same end result, no
// duplication — and the leader's per-message SSE is reserved for
// live per-turn events only.

import { randomUUID } from "node:crypto";
import type {
  Approver,
  ApprovalDecision,
  ApprovalRequest,
} from "@computerworks/agent";
import type { SSEWriter } from "./sse-writer.js";
import type { SyncHub } from "./sync-hub.js";
import type { ServerEvent } from "./sse.js";

export interface InteractiveApproverOptions {
  /** Override the default 5-minute timeout. */
  timeoutMs?: number;
}

export class InteractiveApprover implements Approver {
  public readonly sessionId: string;
  /** T17.3 — the originating tab's per-message SSE writer. We write
   *  approval_required + tool_result here in addition to the SyncHub
   *  so the leader's tool calls work even if the SharedWorker
   *  fails to connect. The reducer's `removeToolCall` is idempotent,
   *  so the leader receiving the event twice is harmless. */
  private readonly leaderWriter: SSEWriter;
  private readonly syncHub: SyncHub;
  private readonly sessionAllowlist: readonly string[];
  private readonly globalShellAllowlist: readonly RegExp[];
  private readonly timeoutMs: number;
  /** In-flight requestIds → resolver. Keyed locally so the lookup is
   *  O(1) and the approver is self-contained (no global registry). */
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  constructor(
    leaderWriter: SSEWriter,
    syncHub: SyncHub,
    sessionId: string,
    sessionAllowlist: readonly string[],
    globalShellAllowlist: readonly RegExp[],
    opts: InteractiveApproverOptions = {},
  ) {
    this.leaderWriter = leaderWriter;
    this.syncHub = syncHub;
    this.sessionId = sessionId;
    this.sessionAllowlist = sessionAllowlist;
    this.globalShellAllowlist = globalShellAllowlist;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  }

  /** Belt-and-suspenders broadcast: write to the leader's
   *  per-message stream AND the central SSE. The leader gets the
   *  event once (via the per-message stream). Passive viewers via
   *  the central SSE. */
  private broadcast(ev: ServerEvent): void {
    try {
      this.leaderWriter.write(ev);
    } catch {
      // leader disconnected mid-event; safe to ignore — the
      // SyncHub broadcast below still reaches passive viewers.
    }
    this.syncHub.broadcast(ev);
  }

  /** Called by the agent loop when a tool needs approval. */
  async request(
    req: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    // 1. Check global shell allowlist (still logged via tool_result).
    if (req.call.name === "run_shell" && this.matchesGlobalShell(req.call.input)) {
      this.broadcast({
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
      this.broadcast({
        type: "tool_result",
        call_id: req.call.id,
        approved: true,
        result: undefined,
        is_error: false,
      });
      return { kind: "approve_once" };
    }

    // 3. Otherwise, prompt the user via both channels.
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
          this.broadcast({
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
        // Emit a tool_result so client UIs can show the decision.
        this.broadcast({
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
      this.broadcast(approvalEvent);
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