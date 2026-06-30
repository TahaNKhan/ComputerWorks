// packages/server/src/tools/rename-session.test.ts
// T19.2 — Unit tests for the rename_session tool + sanitizeTitle.
//
// We exercise the tool end-to-end against a real SessionStore (temp
// dir) and a fake SyncHub (in-memory). The tool is pure with respect
// to provider / network, so no Provider mock is needed.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRenameSessionTool,
  sanitizeTitle,
  renameSessionInputSchema,
  TITLE_MAX_LENGTH,
  type RenameResult,
} from "./rename-session.js";
import type { ToolContext } from "@computerworks/core";
import { SessionStore } from "../session-store.js";
import { SyncHub } from "../sync-hub.js";
import type { ServerEvent } from "../sse.js";
import type { SSEWriter } from "../sse-writer.js";

let root: string;
let store: SessionStore;
let syncHub: SyncHub;
let broadcasts: ServerEvent[];

function makeContext(sessionId: string): ToolContext {
  return {
    cwd: "/tmp",
    signal: new AbortController().signal,
    env: process.env,
    sessionId,
  };
}

function tool(min = 3) {
  return createRenameSessionTool({
    store,
    syncHub,
    minMessagesBetweenRenames: min,
  });
}

/** Recording syncHub: capture every broadcast event. Replaces the
 *  real subscribers list so a test can assert exactly what was sent. */
function recordingBroadcasts(): void {
  broadcasts = [];
  syncHub["subs"] = new Set<SSEWriter>([
    {
      write(ev: ServerEvent) {
        broadcasts.push(ev);
      },
      end() {},
      get closed() { return false; },
    },
  ]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-rename-"));
  store = new SessionStore({ root });
  syncHub = new SyncHub();
  recordingBroadcasts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── sanitizeTitle ───────────────────────────────────────────────────────

describe("sanitizeTitle", () => {
  it("trims whitespace and collapses runs of spaces", () => {
    expect(sanitizeTitle("   hello   world   ")).toBe("hello world");
  });

  it("strips surrounding double quotes", () => {
    expect(sanitizeTitle('"hello world"')).toBe("hello world");
  });

  it("strips surrounding single quotes and backticks", () => {
    expect(sanitizeTitle("'hello world'")).toBe("hello world");
    expect(sanitizeTitle("`hello world`")).toBe("hello world");
  });

  it("strips smart quotes", () => {
    expect(sanitizeTitle("“hello world”")).toBe("hello world");
    expect(sanitizeTitle("‘hello world’")).toBe("hello world");
  });

  it("strips nested/layered quotes", () => {
    expect(sanitizeTitle('"""hello world"""')).toBe("hello world");
    expect(sanitizeTitle("''`hello`''")).toBe("hello");
  });

  it("strips a leading Title: / Subject: prefix", () => {
    expect(sanitizeTitle("Title: hello world")).toBe("hello world");
    expect(sanitizeTitle("title — hello world")).toBe("hello world");
    expect(sanitizeTitle("Subject: hello world")).toBe("hello world");
    // Don't strip the word "title" when it's the actual title.
    expect(sanitizeTitle("Title fight")).toBe("Title fight");
  });

  it("truncates long titles at a word boundary", () => {
    const long = "a".repeat(TITLE_MAX_LENGTH + 20);
    const out = sanitizeTitle(long);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });

  it("returns empty string for empty / whitespace input", () => {
    expect(sanitizeTitle("")).toBe("");
    expect(sanitizeTitle("   ")).toBe("");
    expect(sanitizeTitle('"')).toBe("");
  });

  it("strips trailing punctuation", () => {
    expect(sanitizeTitle("hello world.")).toBe("hello world");
    expect(sanitizeTitle("hello world,,,")).toBe("hello world");
  });

  it("preserves internal punctuation", () => {
    expect(sanitizeTitle("CI: deploy fix")).toBe("CI: deploy fix");
    expect(sanitizeTitle("node-inspect-debugger")).toBe("node-inspect-debugger");
  });

  it("preserves capitalization for proper nouns", () => {
    expect(sanitizeTitle("MySQL slow query")).toBe("MySQL slow query");
    expect(sanitizeTitle("iOS app crash")).toBe("iOS app crash");
  });
});

// ─── renameSessionInputSchema ────────────────────────────────────────────

describe("renameSessionInputSchema", () => {
  it("accepts a non-empty short title", () => {
    const parsed = renameSessionInputSchema.safeParse({ title: "K8s migration" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty title", () => {
    const parsed = renameSessionInputSchema.safeParse({ title: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a title over 200 chars", () => {
    const parsed = renameSessionInputSchema.safeParse({ title: "a".repeat(201) });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing input", () => {
    const parsed = renameSessionInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

// ─── rename_session tool: happy path + rate limit + manual lock ──────────

describe("rename_session tool", () => {
  it("patches meta and broadcasts on first rename", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    const t = tool();

    const result = await t.execute(
      { title: "K8s migration" },
      makeContext(meta.id),
    );

    expect(result).toEqual({ ok: true, title: "K8s migration" });
    const after = await store.get(meta.id);
    expect(after?.title).toBe("K8s migration");
    expect(after?.titleSource).toBe("auto");
    expect(after?.lastRenamedAtMessageCount).toBe(0);
    // No user messages yet → userCount is 0, lastRenamedAtMessageCount
    // is bumped to 0 (the rate-limit clock starts at the first rename).
    expect(broadcasts).toEqual([
      {
        type: "session_renamed",
        sessionId: meta.id,
        title: "K8s migration",
        titleSource: "auto",
      },
    ]);
  });

  it("counts user messages in the persisted transcript for the rate-limit clock", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    await store.appendMessage(meta.id, { role: "user", content: "q1" });
    await store.appendMessage(meta.id, { role: "assistant", content: "a1" });
    await store.appendMessage(meta.id, { role: "user", content: "q2" });
    await store.appendMessage(meta.id, { role: "assistant", content: "a2" });
    await store.appendMessage(meta.id, { role: "user", content: "q3" });

    const t = tool();
    const result = await t.execute({ title: "Three questions" }, makeContext(meta.id));
    expect(result).toEqual({ ok: true, title: "Three questions" });

    const after = await store.get(meta.id);
    // 3 user messages persisted before the tool call.
    expect(after?.lastRenamedAtMessageCount).toBe(3);
  });

  it("rate-limited when userCount - last < min", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    // Simulate a previous rename at user message 1.
    await store.appendMessage(meta.id, { role: "user", content: "q1" });
    await store.patch(meta.id, {
      lastRenamedAtMessageCount: 1,
      title: "Earlier",
      titleSource: "auto",
    });
    // Add 2 more user messages → userCount = 3, last = 1, diff = 2.
    await store.appendMessage(meta.id, { role: "user", content: "q2" });
    await store.appendMessage(meta.id, { role: "user", content: "q3" });

    const t = tool(3);
    const result = await t.execute({ title: "Now" }, makeContext(meta.id));
    expect(result).toEqual({ ok: false, reason: "rate_limited" });

    // No patch, no broadcast on rejection.
    const after = await store.get(meta.id);
    expect(after?.title).toBe("Earlier");
    expect(broadcasts).toEqual([]);
  });

  it("rate-limit boundary: equal-to-min passes", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    await store.appendMessage(meta.id, { role: "user", content: "q1" });
    await store.patch(meta.id, { lastRenamedAtMessageCount: 1, title: "Older", titleSource: "auto" });
    await store.appendMessage(meta.id, { role: "user", content: "q2" });
    await store.appendMessage(meta.id, { role: "user", content: "q3" });
    // userCount = 3, last = 1, diff = 3, min = 3 → allowed.
    await store.appendMessage(meta.id, { role: "user", content: "q4" });
    // userCount = 4, diff = 3 → still ok.

    const t = tool(3);
    const result = await t.execute({ title: "Now" }, makeContext(meta.id));
    expect(result).toEqual({ ok: true, title: "Now" });

    const after = await store.get(meta.id);
    expect(after?.title).toBe("Now");
    expect(after?.lastRenamedAtMessageCount).toBe(4);
  });

  it("manual rename lock rejects without patch or broadcast", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test", title: "Pinned" });
    await store.patch(meta.id, { titleSource: "manual" });

    const t = tool();
    const result = await t.execute({ title: "Override" }, makeContext(meta.id));
    expect(result).toEqual({ ok: false, reason: "manual_rename_locked" });

    const after = await store.get(meta.id);
    expect(after?.title).toBe("Pinned");
    expect(after?.titleSource).toBe("manual");
    expect(broadcasts).toEqual([]);
  });

  it("empty-after-sanitize rejects without patch", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });

    const t = tool();
    // Stripped to all-quote soup → sanitize yields "". ("   !!!   "
    // does NOT empty out because trim+strip leaves "!!!" — punctuation
    // characters alone are a valid title.)
    const result = await t.execute({ title: "\"\"\"\"" }, makeContext(meta.id));
    expect(result).toEqual({ ok: false, reason: "empty_after_sanitize" });

    const after = await store.get(meta.id);
    expect(after?.title).toBe("");
    expect(broadcasts).toEqual([]);
  });

  it("quoted title is stripped before persist + broadcast", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    const t = tool();

    const result = await t.execute({ title: '"K8s migration"' }, makeContext(meta.id));
    expect(result).toEqual({ ok: true, title: "K8s migration" });

    const after = await store.get(meta.id);
    expect(after?.title).toBe("K8s migration");
    expect(broadcasts[0]).toMatchObject({
      type: "session_renamed",
      title: "K8s migration",
      titleSource: "auto",
    });
  });

  it("long title is truncated at a word boundary under TITLE_MAX_LENGTH", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    const t = tool();
    const long = "alpha beta gamma ".repeat(20).trim(); // well over the cap

    const result = await t.execute({ title: long }, makeContext(meta.id));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    // The truncated title should end on a word boundary (last char isn't a space).
    expect(result.title.endsWith(" ")).toBe(false);
  });

  it("session not found returns session_not_found", async () => {
    const t = tool();
    const result = await t.execute(
      { title: "Whatever" },
      makeContext("does-not-exist"),
    );
    expect(result).toEqual({ ok: false, reason: "session_not_found" });
    expect(broadcasts).toEqual([]);
  });

  it("exposes the expected ToolDefinition shape", () => {
    const t = tool();
    expect(t.name).toBe("rename_session");
    expect(t.requiresApproval).toBe(false);
    expect(t.description).toContain("session title");
    expect(t.description).toContain("manual_rename_locked");
    expect(t.description).toContain("rate_limited");
    expect(t.description).toContain("empty_after_sanitize");
    expect(t.description).toContain("session_not_found");
  });
});

// ─── helper: clean type narrowing ─────────────────────────────────────────

function isOk(r: RenameResult): r is { ok: true; title: string } {
  return r.ok === true;
}

describe("RenameResult type", () => {
  it("isOk is a usable type guard", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "test" });
    const r = await tool().execute({ title: "X" }, makeContext(meta.id));
    if (isOk(r)) {
      expect(typeof r.title).toBe("string");
    } else {
      throw new Error("expected ok");
    }
  });
});
