// packages/server/src/audit.ts
// T5.3 — Audit log.
//
// Per DESIGN.MD §7.3 and §9, every tool call and approval decision is
// recorded as one JSON line in <session>/audit.jsonl. This module is a
// thin wrapper around SessionStore.appendAudit: it exists so the
// approval flow (T5.5) and the agent loop (T5.7) can `import { appendAudit }`
// from a stable name, and so we have one place to add filtering or
// redaction later if we ever need it.
//
// The store does the actual file I/O and validation; we just add a
// timestamp if the caller didn't supply one.

import type { SessionStore, AuditEntry } from "./session-store.js";

export type { AuditEntry };

/** Append one entry to a session's audit log. If `entry.ts` is not
 *  set, we set it to the current time. */
export async function appendAudit(
  store: SessionStore,
  sessionId: string,
  entry: Omit<AuditEntry, "ts" | "sessionId"> & { ts?: string },
): Promise<void> {
  const ts = entry.ts ?? new Date().toISOString();
  await store.appendAudit(sessionId, { ...entry, ts, sessionId });
}
