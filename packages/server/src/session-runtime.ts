// packages/server/src/session-runtime.ts
// Shared per-session runtime state.
//
// Each session has at most ONE in-flight turn. We keep the AbortController
// here so /cancel can kill it. The SSE manager handles stream delivery;
// this file owns the "is a turn running right now?" flag + the abort
// signal.

export interface SessionRuntime {
  sessionId: string;
  controller: AbortController;
  startedAt: number;
}

export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();

  /** Returns true if a turn was already in flight. */
  startIfIdle(sessionId: string): { runtime: SessionRuntime; busy: false } | { busy: true } {
    const existing = this.runtimes.get(sessionId);
    if (existing) return { busy: true };
    const runtime: SessionRuntime = {
      sessionId,
      controller: new AbortController(),
      startedAt: Date.now(),
    };
    this.runtimes.set(sessionId, runtime);
    return { runtime, busy: false };
  }

  /** Cancel the in-flight turn; returns the controller or undefined. */
  cancel(sessionId: string): AbortController | undefined {
    const r = this.runtimes.get(sessionId);
    return r?.controller;
  }

  /** Mark the turn done; clear the runtime. */
  finish(sessionId: string): void {
    this.runtimes.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }
}
