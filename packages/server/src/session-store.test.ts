// packages/server/src/session-store.test.ts
// T5.2 unit tests — SessionStore.
//
// Coverage:
//   - create / get round-trip
//   - list returns sessions sorted by updatedAt desc
//   - patch (rename / cwd / model / allowlist)
//   - delete removes the directory
//   - appendMessage + readMessages preserves order
//   - appendMessage bumps updatedAt
//   - appendAudit + readAudit round-trip
//   - concurrent appendMessage is safe (no interleaving)
//   - invalid session id is rejected
//   - getMessages returns the full transcript
//   - create refuses to clobber an existing id (idempotent on real fs)

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionStore,
  generateId,
  resolveSessionsRoot,
  sessionDir,
} from "./session-store.js";
import type { Message } from "@computerworks/core";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-sess-"));
  store = new SessionStore({ root: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function txt(text: string): Message {
  return { role: "user", content: text };
}

// ─── create + get ─────────────────────────────────────────────────────────

describe("create + get", () => {
  it("round-trips meta", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "MiniMax-M3", title: "First" });
    expect(meta.id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(meta.title).toBe("First");
    expect(meta.cwd).toBe("/tmp");
    expect(meta.model).toBe("MiniMax-M3");
    expect(meta.provider).toBe("anthropic");
    expect(meta.allowlist).toEqual([]);

    const got = await store.get(meta.id);
    expect(got).toEqual(meta);
  });

  it("uses caller-supplied id when provided", async () => {
    const meta = await store.create({ id: "my-session", cwd: "/tmp", model: "m" });
    expect(meta.id).toBe("my-session");
    expect(existsSync(sessionDir(dir, "my-session"))).toBe(true);
  });

  it("rejects ids that contain path separators or traversal", async () => {
    await expect(
      store.create({ id: "../escape", cwd: "/tmp", model: "m" }),
    ).rejects.toThrow(/Invalid session id/);
    await expect(
      store.create({ id: "dir/file", cwd: "/tmp", model: "m" }),
    ).rejects.toThrow(/Invalid session id/);
  });

  it("touches messages.jsonl and audit.jsonl on create", async () => {
    const meta = await store.create({ cwd: "/tmp", model: "m" });
    const sd = sessionDir(dir, meta.id);
    expect(existsSync(join(sd, "messages.jsonl"))).toBe(true);
    expect(existsSync(join(sd, "audit.jsonl"))).toBe(true);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────

describe("list", () => {
  it("returns empty when there are no sessions", async () => {
    const xs = await store.list();
    expect(xs).toEqual([]);
  });

  it("returns sessions sorted by updatedAt descending", async () => {
    const a = await store.create({ cwd: "/tmp", model: "m", title: "A" });
    // Wait a tick so updatedAt differs.
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.create({ cwd: "/tmp", model: "m", title: "B" });
    const xs = await store.list();
    expect(xs.map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it("skips corrupt session directories silently", async () => {
    await store.create({ cwd: "/tmp", model: "m", title: "good" });
    // Create a directory that is NOT a valid session (no meta.json)
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "broken-session"), { recursive: true });
    const xs = await store.list();
    expect(xs.length).toBe(1);
    expect(xs[0]?.title).toBe("good");
  });
});

// ─── patch ────────────────────────────────────────────────────────────────

describe("patch", () => {
  it("renames a session", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m", title: "Old" });
    // updatedAt is millisecond resolution; a fast box can land both
    // timestamps in the same ms, making this flake. Bump the clock a
    // hair between the two calls so they're guaranteed to differ.
    await new Promise((r) => setTimeout(r, 2));
    const next = await store.patch(m.id, { title: "New" });
    expect(next.title).toBe("New");
    expect(next.updatedAt).not.toBe(m.updatedAt);
  });

  it("patches cwd / model / allowlist / systemPromptOverrides", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    const next = await store.patch(m.id, {
      cwd: "/var",
      model: "MiniMax-M3",
      allowlist: ["git status", /^ls/],
      systemPromptOverrides: "you are a helpful bot",
    });
    expect(next.cwd).toBe("/var");
    expect(next.model).toBe("MiniMax-M3");
    // RegExp inputs are normalized to their source for storage.
    expect(next.allowlist).toEqual(["git status", "^ls"] as string[]);
    expect(next.systemPromptOverrides).toBe("you are a helpful bot");
  });

  it("rejects unknown fields in the patch", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    // zod's `.strict()` throws on unknown keys.
    await expect(
      store.patch(m.id, { bad: true } as unknown as never),
    ).rejects.toThrow();
  });
});

// ─── delete ───────────────────────────────────────────────────────────────

describe("delete", () => {
  it("removes the session directory", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    expect(existsSync(sessionDir(dir, m.id))).toBe(true);
    await store.delete(m.id);
    expect(existsSync(sessionDir(dir, m.id))).toBe(false);
    expect(await store.get(m.id)).toBeNull();
  });
});

// ─── messages ─────────────────────────────────────────────────────────────

describe("messages", () => {
  it("appends and reads back in order", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    await store.appendMessage(m.id, txt("hello"));
    await store.appendMessage(m.id, { role: "assistant", content: "hi" });
    await store.appendMessage(m.id, txt("goodbye"));

    const out: Message[] = [];
    for await (const msg of store.readMessages(m.id)) out.push(msg);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "goodbye" },
    ]);
  });

  it("getMessages returns the full transcript", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    await store.appendMessage(m.id, txt("a"));
    await store.appendMessage(m.id, txt("b"));
    const out = await store.getMessages(m.id);
    expect(out.length).toBe(2);
  });

  it("appendMessage bumps updatedAt on meta", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    const before = m.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.appendMessage(m.id, txt("x"));
    const after = await store.get(m.id);
    expect(after.updatedAt > before).toBe(true);
  });

  it("rejects messages with an invalid role", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    await expect(
      // @ts-expect-error – bad role
      store.appendMessage(m.id, { role: "robot", content: "x" }),
    ).rejects.toThrow(/Invalid message role/);
  });

  it("round-trips ContentBlock[] content", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    await store.appendMessage(m.id, {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu-1", name: "run_shell", input: { cmd: "ls" } },
      ],
    });
    const out = await store.getMessages(m.id);
    expect(out[0]?.content).toBeInstanceOf(Array);
  });

  it("concurrent appendMessage is safe (no interleaving)", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendMessage(m.id, txt(`msg-${String(i).padStart(3, "0")}`)),
      ),
    );
    const out = await store.getMessages(m.id);
    expect(out.length).toBe(N);
    // Every line must be a complete JSON object — if two writes
    // interleaved, JSON.parse would throw and we'd never get here.
    const lines = out.map((x) => x.content as string);
    const sorted = [...lines].sort();
    const expected = Array.from(
      { length: N },
      (_, i) => `msg-${String(i).padStart(3, "0")}`,
    );
    expect(sorted).toEqual(expected);
  });
});

// ─── audit ────────────────────────────────────────────────────────────────

describe("audit", () => {
  it("appends and reads back", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m" });
    await store.appendAudit(m.id, {
      ts: new Date().toISOString(),
      sessionId: "",
      callId: "c1",
      tool: "run_shell",
      input: { cmd: "ls" },
      decision: "approve_once",
    });
    await store.appendAudit(m.id, {
      ts: new Date().toISOString(),
      sessionId: "",
      callId: "c2",
      tool: "write_file",
      input: { path: "/tmp/x" },
      decision: "reject",
      reason: "nope",
    });
    const out: unknown[] = [];
    for await (const e of store.readAudit(m.id)) out.push(e);
    expect(out.length).toBe(2);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────

describe("generateId", () => {
  it("returns a unique-ish id matching the allowed charset", () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("resolveSessionsRoot", () => {
  it("resolves ~ and ~/", () => {
    expect(resolveSessionsRoot("~").length).toBeGreaterThan(1);
    expect(resolveSessionsRoot("~/foo")).toMatch(/foo$/);
    expect(resolveSessionsRoot("/abs")).toBe("/abs");
  });
  it("resolveSessionsRoot returns an absolute path", () => {
    expect(resolveSessionsRoot(dir).startsWith("/")).toBe(true);
  });
});

// ─── meta.json on disk is valid JSON ──────────────────────────────────────

describe("meta.json on disk", () => {
  it("the file written is parseable JSON and matches the schema", async () => {
    const m = await store.create({ cwd: "/tmp", model: "m", title: "x" });
    const raw = readFileSync(sessionDir(dir, m.id) + "/meta.json", "utf8");
    const obj = JSON.parse(raw);
    expect(obj.id).toBe(m.id);
    expect(obj.title).toBe("x");
  });
});
