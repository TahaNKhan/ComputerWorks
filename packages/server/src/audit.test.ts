// packages/server/src/audit.test.ts
// T5.3 unit tests — audit log wrapper.
//
// The actual file I/O lives in SessionStore (covered in session-store.test.ts).
// Here we verify the wrapper:
//   - fills in `ts` if absent
//   - passes through a caller-supplied `ts`
//   - stamps `sessionId` from the wrapper argument

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, type AuditEntry } from "./audit.js";
import { SessionStore } from "./session-store.js";

let dir: string;
let store: SessionStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cw-audit-"));
  store = new SessionStore({ root: dir });
  const m = await store.create({ cwd: "/tmp", model: "m" });
  sessionId = m.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appendAudit", () => {
  it("fills in `ts` if absent", async () => {
    const before = Date.now();
    await appendAudit(store, sessionId, {
      callId: "c1",
      tool: "run_shell",
      input: { cmd: "ls" },
      decision: "approve_once",
    });
    const after = Date.now();
    const all: AuditEntry[] = [];
    for await (const e of store.readAudit(sessionId)) all.push(e);
    expect(all.length).toBe(1);
    const ts = Date.parse(all[0]!.ts);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("passes through a caller-supplied ts", async () => {
    const fixed = "2026-01-01T00:00:00.000Z";
    await appendAudit(store, sessionId, {
      ts: fixed,
      callId: "c1",
      tool: "write_file",
      input: { path: "/tmp/x" },
      decision: "reject",
      reason: "nope",
    });
    const all: AuditEntry[] = [];
    for await (const e of store.readAudit(sessionId)) all.push(e);
    expect(all[0]?.ts).toBe(fixed);
  });

  it("stamps sessionId from the wrapper argument", async () => {
    await appendAudit(store, sessionId, {
      callId: "c1",
      tool: "run_shell",
      input: {},
      decision: "auto_approve",
    });
    const all: AuditEntry[] = [];
    for await (const e of store.readAudit(sessionId)) all.push(e);
    expect(all[0]?.sessionId).toBe(sessionId);
  });
});
