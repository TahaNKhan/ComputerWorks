// packages/server/src/session-runtime.ts
// Per-session runtime state.
//
// Each session has at most ONE in-flight turn. We keep the AbortController
// here so /cancel can kill it. v1.14 also stores the InteractiveApprover
// on the runtime so /approve can find the right (requestId → resolver)
// map without a global registry — there's exactly one approver per
// in-flight turn, and exactly one turn per session.

export interface ApproverHandle {
  /** Resolve a pending approval. Returns true if a resolver fired. */
  resolveById(
    requestId: string,
    decision: import("@computerworks/agent").ApprovalDecision,
  ): boolean;
}

export interface SessionRuntime {
  sessionId: string;
  controller: AbortController;
  approver: ApproverHandle;
  startedAt: number;
}

export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();

  /** Register an in-flight turn. Returns `{ busy: true }` if a turn
   *  is already in flight for this session. */
  startIfIdle(
    sessionId: string,
    approver: ApproverHandle,
  ): { runtime: SessionRuntime; busy: false } | { busy: true } {
    const existing = this.runtimes.get(sessionId);
    if (existing) return { busy: true };
    const runtime: SessionRuntime = {
      sessionId,
      controller: new AbortController(),
      approver,
      startedAt: Date.now(),
    };
    this.runtimes.set(sessionId, runtime);
    return { runtime, busy: false };
  }

  /** Get the in-flight runtime for a session, or undefined. */
  get(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** Cancel the in-flight turn; returns the controller or undefined. */
  cancel(sessionId: string): AbortController | undefined {
    return this.runtimes.get(sessionId)?.controller;
  }

  /** Mark the turn done; clear the runtime. */
  finish(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }
}