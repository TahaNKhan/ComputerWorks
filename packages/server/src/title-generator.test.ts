// packages/server/src/title-generator.test.ts
//
// Unit tests for the pure helpers and end-to-end behavior of the
// title generator. The provider is mocked with `createScriptedProvider`
// so we never hit the network. The session store uses a temp dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedProvider } from "@computerworks/core";
import {
  extractFirstExchange,
  generateTitle,
  sanitizeTitle,
  TITLE_MAX_LENGTH,
} from "./title-generator.js";
import type { Message } from "@computerworks/core";
import { SessionStore } from "./session-store.js";
import { SSEManager } from "./sse.js";

describe("sanitizeTitle", () => {
  test("trims whitespace and collapses runs of spaces", () => {
    expect(sanitizeTitle("   hello   world   ")).toBe("hello world");
  });

  test("strips surrounding double quotes", () => {
    expect(sanitizeTitle('"hello world"')).toBe("hello world");
  });

  test("strips surrounding single quotes and backticks", () => {
    expect(sanitizeTitle("'hello world'")).toBe("hello world");
    expect(sanitizeTitle("`hello world`")).toBe("hello world");
  });

  test("strips nested/layered quotes", () => {
    expect(sanitizeTitle('"""hello world"""')).toBe("hello world");
    expect(sanitizeTitle("''`hello`''")).toBe("hello");
  });

  test("strips a leading Title: / Subject: prefix", () => {
    expect(sanitizeTitle("Title: hello world")).toBe("hello world");
    expect(sanitizeTitle("title — hello world")).toBe("hello world");
    expect(sanitizeTitle("Subject: hello world")).toBe("hello world");
    // Don't strip the word "title" when it's the actual title.
    expect(sanitizeTitle("Title fight")).toBe("Title fight");
  });

  test("truncates long titles at a word boundary", () => {
    const long = "a".repeat(TITLE_MAX_LENGTH + 20);
    const out = sanitizeTitle(long);
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });

  test("returns empty string for empty / whitespace input", () => {
    expect(sanitizeTitle("")).toBe("");
    expect(sanitizeTitle("   ")).toBe("");
    expect(sanitizeTitle("\"")).toBe("");
  });

  test("strips trailing punctuation", () => {
    expect(sanitizeTitle("hello world.")).toBe("hello world");
    expect(sanitizeTitle("hello world,,,")).toBe("hello world");
  });

  test("preserves internal punctuation", () => {
    expect(sanitizeTitle("CI: deploy fix")).toBe("CI: deploy fix");
    expect(sanitizeTitle("node-inspect-debugger")).toBe("node-inspect-debugger");
  });

  test("preserves capitalization for proper nouns", () => {
    expect(sanitizeTitle("MySQL slow query")).toBe("MySQL slow query");
    expect(sanitizeTitle("iOS app crash")).toBe("iOS app crash");
  });
});

describe("extractFirstExchange", () => {
  test("returns the first user + assistant text", () => {
    const messages: Message[] = [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi friend" },
      { role: "user", content: "second turn" },
    ];
    const out = extractFirstExchange(messages);
    expect(out).toEqual({ user: "hello there", assistant: "hi friend" });
  });

  test("unwraps ContentBlock[] when content is an array", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello!" },
          { type: "tool_use", id: "x", name: "run_shell", input: {} },
        ],
      },
    ];
    const out = extractFirstExchange(messages);
    expect(out).toEqual({ user: "hi", assistant: "hello!" });
  });

  test("returns empty strings when neither role is present", () => {
    const out = extractFirstExchange([]);
    expect(out).toEqual({ user: "", assistant: "" });
  });

  test("returns empty assistant when only the user spoke", () => {
    const out = extractFirstExchange([{ role: "user", content: "ping" }]);
    expect(out).toEqual({ user: "ping", assistant: "" });
  });
});

// ─── Integration: generateTitle against a real SessionStore + scripted LLM ──

describe("generateTitle", () => {
  let root: string;
  let store: SessionStore;
  let sse: SSEManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cw-titlegen-"));
    store = new SessionStore({ root });
    sse = new SSEManager({ heartbeatMs: 60_000 });
  });

  afterEach(async () => {
    sse.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  test("returns null when the session has no user messages", async () => {
    await store.create({
      cwd: "/tmp",
      model: "fake",
    });
    const id = (await store.list())[0]!.id;
    const events: string[] = [];
    sse.send = ((sid: string, ev: { type: string }) => {
      events.push(`${sid}:${ev.type}`);
      // @ts-expect-error - replace method on instance
      return sse.send.call(sse, sid, ev);
    }) as typeof sse.send;
    const out = await generateTitle(
      {
        store,
        sse,
        createProvider: () =>
          createScriptedProvider({ frames: [[{ type: "done" }]] }),
      },
      id,
    );
    expect(out).toBeNull();
    expect(events).toEqual([]);
  });

  test("returns null (no-op) when the session already has a title", async () => {
    await store.create({ cwd: "/tmp", model: "fake", title: "Manual title" });
    const id = (await store.list())[0]!.id;
    await store.appendMessage(id, { role: "user", content: "hi" });
    const out = await generateTitle(
      {
        store,
        sse,
        createProvider: () =>
          createScriptedProvider({ frames: [[{ type: "token", delta: "should not run" }]] }),
      },
      id,
    );
    expect(out).toBeNull();
    // Title is unchanged.
    const meta = await store.get(id);
    expect(meta?.title).toBe("Manual title");
  });

  test("generates a title, patches meta, and emits title_updated over SSE", async () => {
    await store.create({ cwd: "/tmp", model: "fake" });
    const id = (await store.list())[0]!.id;
    await store.appendMessage(id, {
      role: "user",
      content: "How do I set up a Bun workspace?",
    });
    await store.appendMessage(id, {
      role: "assistant",
      content: "Run `bun init` and add packages to workspaces.",
    });

    // Capture SSE events sent to this session.
    const captured: { type: string; title?: string; sessionId?: string }[] = [];
    const originalSend = sse.send.bind(sse);
    sse.send = ((sid: string, ev: { type: string; title?: string; sessionId?: string }) => {
      if (sid === id) captured.push(ev);
      originalSend(sid, ev);
    }) as typeof sse.send;

    const title = await generateTitle(
      {
        store,
        sse,
        createProvider: () =>
          createScriptedProvider({
            frames: [
              [
                { type: "token", delta: '"bun ' },
                { type: "token", delta: "workspace setup\"" },
                { type: "done" },
              ],
            ],
          }),
      },
      id,
    );
    expect(title).toBe("bun workspace setup");
    const meta = await store.get(id);
    expect(meta?.title).toBe("bun workspace setup");
    expect(captured).toEqual([
      { type: "title_updated", sessionId: id, title: "bun workspace setup" },
    ]);
  });

  test("returns null and swallows provider errors", async () => {
    await store.create({ cwd: "/tmp", model: "fake" });
    const id = (await store.list())[0]!.id;
    await store.appendMessage(id, { role: "user", content: "ping" });

    const captured: unknown[] = [];
    const originalSend = sse.send.bind(sse);
    sse.send = ((sid: string, ev: unknown) => {
      captured.push(ev);
      originalSend(sid, ev as Parameters<typeof originalSend>[1]);
    }) as typeof sse.send;

    const title = await generateTitle(
      {
        store,
        sse,
        createProvider: () =>
          createScriptedProvider({
            frames: [[{ type: "error", message: "kaboom" }]],
          }),
      },
      id,
    );
    expect(title).toBeNull();
    expect(captured).toEqual([]);
    const meta = await store.get(id);
    expect(meta?.title).toBe("");
  });

  test("returns null when the model produces only an empty/whitespace string", async () => {
    await store.create({ cwd: "/tmp", model: "fake" });
    const id = (await store.list())[0]!.id;
    await store.appendMessage(id, { role: "user", content: "hi" });

    const title = await generateTitle(
      {
        store,
        sse,
        createProvider: () =>
          createScriptedProvider({
            frames: [
              [
                { type: "token", delta: "   " },
                { type: "done" },
              ],
            ],
          }),
      },
      id,
    );
    expect(title).toBeNull();
    const meta = await store.get(id);
    expect(meta?.title).toBe("");
  });
});
