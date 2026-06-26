// packages/server/src/app.test.ts
// T5.6 + T5.7 + T5.8 integration tests via app.inject().
//
// We don't open a real socket — `buildApp()` returns a configured
// FastifyInstance and tests use `app.inject()`. We pass in a fake
// provider factory so no network calls happen.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Provider, ProviderOverrides, StreamEvent, ToolDefinition } from "@computerworks/core";
import type { Config } from "./config.js";
import { buildApp } from "./app.js";
import { SessionStore } from "./session-store.js";

let sessionsRoot: string;
let memoryRoot: string;

const baseConfig: Config = {
  providers: { anthropic: {} },
  defaultProvider: "anthropic",
  server: { host: "127.0.0.1", port: 4747 },
  approval: { autoApprove: { read: true, write: false, shell: false } },
};

const ECHO_TOOL: ToolDefinition = {
  name: "echo",
  description: "echoes input",
  inputSchema: z.object({ msg: z.string() }),
  requiresApproval: false,
  async execute({ msg }) {
    return { echoed: msg };
  },
};

/** Build a scripted provider that yields one tool_call then a text reply. */
function scriptedProvider(): Provider {
  const cursor = { i: 0 };
  const frames: StreamEvent[][] = [
    [
      { type: "message_start" },
      {
        type: "tool_call",
        call: { type: "tool_use", id: "c1", name: "echo", input: { msg: "hi" } },
      },
      { type: "message_done", usage: { input: 1, output: 1 } },
    ],
    [
      { type: "message_start" },
      { type: "token", delta: "done" },
      { type: "message_done", usage: { input: 1, output: 1 } },
    ],
  ];
  return {
    id: "scripted",
    capabilities: { toolUse: true, promptCaching: false, vision: false },
    chat(_req: { model: string; messages: unknown[]; tools: ToolDefinition[]; overrides?: ProviderOverrides; signal?: AbortSignal }): AsyncIterable<StreamEvent> {
      const frame = frames[cursor.i++] ?? [];
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx >= frame.length) return { value: undefined, done: true };
              return { value: frame[idx++]!, done: false };
            },
            async return() { return { value: undefined, done: true }; },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), "cw-srv-"));
  memoryRoot = mkdtempSync(join(tmpdir(), "cw-mem-"));
  mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true });
  rmSync(memoryRoot, { recursive: true, force: true });
});

// ─── T5.6 ───────────────────────────────────────────────────────────────

describe("buildApp", () => {
  it("GET /api/health returns { ok: true }", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects non-loopback origin via CORS", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://evil.example.com" },
    });
    // CORS rejection happens preflight-ish; with credentials:true the
    // server returns 500 because cors plugin throws. Either way the
    // status is not 200 with a permissive CORS header.
    expect([403, 500]).toContain(res.statusCode);
  });

  it("allows loopback origin via CORS", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── T5.6 (sessions routes) ─────────────────────────────────────────────

describe("session routes", () => {
  it("creates, lists, fetches, and deletes a session", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "test" },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((s: { id: string }) => s.id === id)).toBe(true);

    const fetch = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    expect(fetch.statusCode).toBe(200);
    expect(fetch.json().meta.id).toBe(id);

    const del = await app.inject({ method: "DELETE", url: `/api/sessions/${id}` });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    expect(after.statusCode).toBe(404);
  });

  it("PATCH updates title and cwd", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const id = create.json().id;
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { title: "renamed", cwd: "/tmp" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().title).toBe("renamed");
    expect(patch.json().cwd).toBe("/tmp");
  });
});

// ─── T5.7 (messages + stream) ────────────────────────────────────────────

describe("messages + stream", () => {
  it("POST /messages returns 204 and an SSE consumer receives events", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
    });
    // Subscribe via the SSE manager directly (route uses the same
    // subscribe API: AsyncIterable<Uint8Array>).
    const cw = (app as unknown as { __cw: { sse: { subscribe(id: string): AsyncIterable<Uint8Array> & { dispose(): void } } } }).__cw;

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    const chunks: Buffer[] = [];
    const sub = cw.sse.subscribe(sessionId);
    // Drain the iterator in the background.
    void (async () => {
      try {
        for await (const chunk of sub) chunks.push(Buffer.from(chunk));
      } catch { /* expected on close */ }
    })();

    const post = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(post.statusCode).toBe(204);

    // The agent runs in the background; wait for events.
    await new Promise((r) => setTimeout(r, 500));
    const all = Buffer.concat(chunks).toString("utf8");
    expect(all).toMatch(/event: (token|tool_call|message_start|done)/);
  });

  it("persists assistant + tool messages to the session transcript", async () => {
    // scriptedProvider emits: frame 0 = tool_call, frame 1 = text reply.
    // The agent loop should append: assistant(tool_use), tool(result),
    // assistant(text) — so the on-disk transcript after a turn is:
    //   [user, assistant(tool_use), tool(result), assistant(text)]
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    const post = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(post.statusCode).toBe(204);

    // The agent runs in the background; poll until it has written
    // the full transcript (user + assistant + tool + assistant = 4).
    const expectedLength = 4;
    let transcript: Awaited<ReturnType<typeof store.getMessages>> = [];
    for (let i = 0; i < 100; i++) {
      transcript = await store.getMessages(sessionId);
      if (transcript.length >= expectedLength) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(transcript.length).toBe(expectedLength);
    expect(transcript.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    // Assistant message #1 must carry the tool_use block.
    const assistantWithTool = transcript[1]!;
    expect(Array.isArray(assistantWithTool.content)).toBe(true);
    const blocks1 = assistantWithTool.content as Array<{ type: string; name?: string }>;
    expect(blocks1.some((b) => b.type === "tool_use" && b.name === "echo")).toBe(true);
    // Tool message must reference the same call id. The scripted
    // provider asks for an "echo" tool which isn't in the default
    // registry, so the executor returns is_error=true — but the
    // tool_result block itself is still persisted (the bug we're
    // regressing on).
    const toolMsg = transcript[2]!;
    expect(Array.isArray(toolMsg.content)).toBe(true);
    const blocks2 = toolMsg.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
    expect(blocks2.some((b) => b.type === "tool_result" && b.tool_use_id === "c1")).toBe(true);
    // Final assistant message must be the text reply.
    const finalAssistant = transcript[3]!;
    expect(finalAssistant.content).toEqual([{ type: "text", text: "done" }]);
  });
});

// ─── T5.8 (cancel) ───────────────────────────────────────────────────────

describe("cancel route", () => {
  it("returns 404 when no turn is in flight", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const res = await app.inject({ method: "POST", url: "/api/sessions/none/cancel" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── T5.7 (approve) ─────────────────────────────────────────────────────

describe("approve route", () => {
  it("returns 404 for unknown requestId", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/anything/approve",
      payload: { requestId: "nope", decision: { kind: "approve_once" } },
    });
    expect(res.statusCode).toBe(404);
  });
});

// Ensure ECHO_TOOL is referenced (so unused-import lints stay quiet).
void ECHO_TOOL;

// ─── T12.2 (title generator — end-to-end via buildApp) ──────────────────

describe("title generator (T12.2)", () => {
  // Reset the shared scripted playback cursor between tests so each
  // test gets the agent-run + title-generator frames in order.
  beforeEach(() => {
    titleTestCursor.i = 0;
  });

  // The default `scriptedProvider` above produces 2 frames
  // (tool_call, then text reply). `generateTitle` runs the same
  // provider after the agent loop and consumes a 3rd frame; an
  // empty/missing frame is a no-op for title generation, so the
  // default scripted provider is fine for the negative assertions.
  // For the positive assertion we need a provider that emits tokens
  // for BOTH the agent reply AND a title.

  // Module-scoped so the agent run AND the title generator share
  // the same scripted playback. The route calls `createProvider()`
  // once for each — both calls return distinct Provider objects
  // backed by the same `cursor` + `frames`.
  const titleTestFrames: StreamEvent[][] = [
    // frame 0 — agent run, iter 1: tool_call (echo)
    [
      { type: "message_start" },
      {
        type: "tool_call",
        call: { type: "tool_use", id: "c1", name: "echo", input: { msg: "hi" } },
      },
      { type: "message_done", usage: { input: 1, output: 1 } },
    ],
    // frame 1 — agent run, iter 2: empty frame because "echo" isn't
    // registered. The loop sees no tool_call → ends the turn.
    [],
    // frame 2 — title generator: emit a short title
    [
      { type: "token", delta: '"echo ' },
      { type: "token", delta: 'test"' },
      { type: "message_done", usage: { input: 1, output: 1 } },
    ],
  ];
  const titleTestCursor = { i: 0 };

  function scriptedProviderWithTitle(): Provider {
    return {
      id: "scripted",
      capabilities: { toolUse: true, promptCaching: false, vision: false },
      chat(_req): AsyncIterable<StreamEvent> {
        const frame = titleTestFrames[titleTestCursor.i++] ?? [];
        return {
          [Symbol.asyncIterator]() {
            let idx = 0;
            return {
              async next() {
                if (idx >= frame.length) return { value: undefined, done: true };
                return { value: frame[idx++]!, done: false };
              },
              async return() { return { value: undefined, done: true }; },
            };
          },
        };
      },
    };
  }

  it("patches meta.title and emits title_updated over SSE after the first turn", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProviderWithTitle,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    // Subscribe to SSE before posting the message.
    const cw = (app as unknown as {
      __cw: {
        sse: {
          subscribe(id: string): AsyncIterable<Uint8Array> & { dispose(): void };
        };
      };
    }).__cw;
    const chunks: Buffer[] = [];
    const sub = cw.sse.subscribe(sessionId);
    void (async () => {
      try {
        for await (const chunk of sub) chunks.push(Buffer.from(chunk));
      } catch { /* expected */ }
    })();

    const post = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(post.statusCode).toBe(204);

    // Poll for the title update: the agent run finishes quickly with
    // the scripted provider, then the fire-and-forget title gen runs.
    let meta = await store.get(sessionId);
    for (let i = 0; i < 100; i++) {
      if (meta && meta.title !== "") break;
      await new Promise((r) => setTimeout(r, 50));
      meta = await store.get(sessionId);
    }
    expect(meta?.title).toBe("echo test");

    // Verify the SSE event was emitted. The wire format is the SSE
    // `event: title_updated` frame with a JSON body.
    const all = Buffer.concat(chunks).toString("utf8");
    expect(all).toMatch(/event: title_updated/);
    expect(all).toMatch(/"title"\s*:\s*"echo test"/);
  });

  it("skips title generation when the session is created with a title", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProviderWithTitle,
      autoApprove: true,
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "My pre-named session" },
    });
    const sessionId = create.json().id;

    const post = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(post.statusCode).toBe(204);

    // Wait long enough for any title gen to have run.
    await new Promise((r) => setTimeout(r, 500));
    const meta = await store.get(sessionId);
    expect(meta?.title).toBe("My pre-named session");
  });
});
