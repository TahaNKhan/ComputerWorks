// packages/server/src/app.test.ts
// T14.1 integration tests via app.inject().
//
// We don't open a real socket — `buildApp()` returns a configured
// FastifyInstance and tests use `app.inject()`. We pass in a fake
// provider factory so no network calls happen.
//
// The big shift vs v1.13: POST /api/sessions/:id/messages now opens
// an SSE stream in its own response. Tests assert the response is
// text/event-stream, contains the expected event frames in order,
// and closes after the terminal `done` frame.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as realCore from "@computerworks/core";
import type { Config } from "./config.js";

// ─── Mock @computerworks/core for auto-title ──────────────────────────────
// title.ts calls `getDefaultAnthropicProvider()` to derive a session title
// via the LLM. We replace that one export with a fake that echoes the
// cleaned user input back as the title — a deterministic stand-in for
// the LLM, no network. Everything else from @computerworks/core is
// re-exported from the static `realCore` snapshot we already loaded, so
// createAnthropicProvider and the type definitions still resolve.
const realCoreSnapshot = { ...realCore };

mock.module("@computerworks/core", () => ({
  ...realCoreSnapshot,
  getDefaultAnthropicProvider: () => ({
    inferText: async (prompt: string): Promise<string> => {
      const m = prompt.match(/User Input:\s*(.+)$/);
      return m ? m[1]! : prompt;
    },
  }),
}));

// Dynamic imports below — these run after mock.module() is in place, so
// title.ts (loaded transitively via app.js) sees the mocked provider.
const { buildApp } = await import("./app.js");
const { SessionStore } = await import("./session-store.js");

let sessionsRoot: string;
let memoryRoot: string;

const baseConfig: Config = {
  providers: { anthropic: {} },
  defaultProvider: "anthropic",
  server: { host: "127.0.0.1", port: 4747 },
  approval: { autoApprove: { read: true, write: false, shell: false } },
  // T19.5 — explicit defaults so the in-memory test config matches
  // what `loadConfig()` produces. Tests that want a different
  // rate limit override this field.
  title: { llmDecides: true, minMessagesBetweenRenames: 3 },
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
  return scriptedProviderWithFrames(
    [
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
    ],
    { i: 0 },
  );
}

/** Build a scripted provider with explicit frames + a shared cursor.
 *  Lets one test exercise both the agent turn and the title-gen call
 *  by feeding the right frames in sequence. */
function scriptedProviderWithFrames(
  frames: StreamEvent[][],
  cursor: { i: number },
): Provider {
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

// ─── buildApp ─────────────────────────────────────────────────────────────

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
    expect([403, 500]).toContain(res.statusCode);
  });

  it("allows loopback origin via CORS", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    // T15.3 — origin now matches the server's own loopback (the UI
    // is served from the same origin post-Phase 15; this test still
    // exercises the CORS allowlist for any external client that
    // happens to also be on loopback).
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://127.0.0.1:4747" },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── T15.1 — static UI serving ────────────────────────────────────────────
// buildApp({ uiRoot }) registers @fastify/static + a GET / fallback.
// Tests use a temp dir with a fixture index.html and assets/main.js.

describe("static UI (T15.1)", () => {
  let uiRoot: string;

  beforeEach(() => {
    uiRoot = mkdtempSync(join(tmpdir(), "cw-ui-"));
    mkdirSync(join(uiRoot, "assets"));
    Bun.write(join(uiRoot, "index.html"),
      "<!doctype html><title>cw</title><script src=\"/assets/main.js\"></script>");
    Bun.write(join(uiRoot, "assets", "main.js"),
      "console.log('hello from fixture');");
  });

  afterEach(() => {
    rmSync(uiRoot, { recursive: true, force: true });
  });

  it("GET / returns the index.html from uiRoot", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
      uiRoot,
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    const ct = res.headers["content-type"];
    expect(typeof ct === "string" && ct.includes("text/html")).toBe(true);
    expect(res.body).toContain("<title>cw</title>");
  });

  it("GET /assets/main.js returns the bundle", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
      uiRoot,
    });
    const res = await app.inject({ method: "GET", url: "/assets/main.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("hello from fixture");
  });

  it("GET /api/health still returns JSON (no path conflict)", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
      uiRoot,
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("without uiRoot, GET / returns 404 (UI is opt-in)", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
  });

  it("__cw test handle exposes the configured uiRoot", async () => {
    const app = await buildApp({
      config: baseConfig,
      store: new SessionStore({ root: sessionsRoot }),
      uiRoot,
    });
    const cw = (app as unknown as { __cw: { uiRoot: string | undefined } }).__cw;
    expect(cw.uiRoot).toBe(uiRoot);
  });
});

// ─── session routes ──────────────────────────────────────────────────────

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

// ─── messages + per-message SSE ───────────────────────────────────────────

describe("POST /api/sessions/:id/messages (per-message SSE)", () => {
  it("returns text/event-stream and contains the expected frames in order", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    // The response is the SSE channel — we read it in full and assert
    // its content type and event order.
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const body = res.body;
    // The scripted provider emits: tool_call (frame 0), then a
    // "done" text reply (frame 1). The auto-approver means no
    // approval card. session_renamed is NOT in the response body —
    // it arrives via the Phase 12.2 fire-and-forget background call
    // (or never, if the response closes first). We expect:
    //   - tool_call
    //   - token ("done")
    //   - terminal `done` (one frame, from SSEWriter.end)
    expect(body).toMatch(/event: tool_call/);
    expect(body).toMatch(/event: token/);
    expect(body).toMatch(/event: done/);

    // Ordering: tool_call must precede token, done must be last.
    const toolCallIdx = body.indexOf("event: tool_call");
    const tokenIdx = body.indexOf("event: token");
    const doneIdx = body.lastIndexOf("event: done");
    expect(toolCallIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(toolCallIdx);
    expect(doneIdx).toBeGreaterThan(tokenIdx);

    // Exactly one terminal `done` frame.
    const doneCount = (body.match(/event: done/g) ?? []).length;
    expect(doneCount).toBe(1);
  });

  it("persists assistant + tool messages to the session transcript", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(res.statusCode).toBe(200);

    // After the SSE response closes, the transcript should contain:
    //   [user, assistant(tool_use), tool(result), assistant(text)]
    for (let i = 0; i < 100; i++) {
      const msgs = await store.getMessages(sessionId);
      if (msgs.length >= 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const transcript = await store.getMessages(sessionId);
    expect(transcript.length).toBe(4);
    expect(transcript.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const assistantWithTool = transcript[1]!;
    expect(Array.isArray(assistantWithTool.content)).toBe(true);
    const blocks1 = assistantWithTool.content as Array<{ type: string; name?: string }>;
    expect(blocks1.some((b) => b.type === "tool_use" && b.name === "echo")).toBe(true);

    const toolMsg = transcript[2]!;
    expect(Array.isArray(toolMsg.content)).toBe(true);
    const blocks2 = toolMsg.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
    expect(blocks2.some((b) => b.type === "tool_result" && b.tool_use_id === "c1")).toBe(true);

    const finalAssistant = transcript[3]!;
    expect(finalAssistant.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("falls back to a server-side title when the LLM doesn't call rename_session (T19.12)", async () => {
    // T19.12 — even when the LLM is lax about calling
    // `rename_session`, the server fills the gap with a
    // deterministic `deriveTitle` call. The scripted provider in
    // this test does not call the tool, but the session still
    // gets titled after the first user message.
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;
    expect(create.json().title).toBe("");

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "Help me write a React component for a todo list" },
    });
    expect(res.statusCode).toBe(200);

    // Poll for the fallback to land — it's fire-and-forget.
    let meta: Awaited<ReturnType<typeof store.get>>;
    for (let i = 0; i < 100; i++) {
      meta = await store.get(sessionId);
      if (meta?.title && meta.title !== "") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(meta?.title).not.toBe("");
    // The fallback stamps `titleSource: "auto"` so a future
    // `rename_session` call from the LLM can still update the title
    // (only manual renames are sticky).
    expect(meta?.titleSource).toBe("auto");
  }, 5_000);

  it("does not overwrite a manual title with auto-title", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    // User renames the session manually before sending the first message.
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}`,
      payload: { title: "My Custom Title" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().titleSource).toBe("manual");
    expect(rename.json().title).toBe("My Custom Title");

    const post = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "completely different content here" },
    });
    expect(post.statusCode).toBe(200);

    // Wait for the agent loop to complete + persistence.
    for (let i = 0; i < 100; i++) {
      const msgs = await store.getMessages(sessionId);
      if (msgs.length >= 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const meta = await store.get(sessionId);
    // T19: the manual title sticks because the scripted provider
    // doesn't call `rename_session`. Even if it did, the tool would
    // reject with `manual_rename_locked`.
    expect(meta?.title).toBe("My Custom Title");
    expect(meta?.titleSource).toBe("manual");
  });

  it("returns 409 when a turn is already in flight on the same session", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: true,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    const cw = (app as unknown as {
      __cw: { registry: { isRunning: (id: string) => boolean } };
    }).__cw;
    expect(cw.registry.isRunning(sessionId)).toBe(false);

    // Force "busy" by injecting a placeholder runtime directly.
    const fakeApprover = {
      resolveById: () => false,
    };
    const start = (app as unknown as {
      __cw: { registry: { startIfIdle: (id: string, a: unknown) => { runtime: unknown; busy: boolean } } };
    }).__cw.registry.startIfIdle(sessionId, fakeApprover);
    expect(start.busy).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ─── cancel route ────────────────────────────────────────────────────────

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

// ─── approve route ───────────────────────────────────────────────────────

describe("approve route", () => {
  it("returns 404 when no turn is in flight", async () => {
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

  it("returns 404 for unknown requestId on the active approver", async () => {
    const store = new SessionStore({ root: sessionsRoot });
    const app = await buildApp({
      config: { ...baseConfig, server: { ...baseConfig.server!, port: 4747 } },
      store,
      createProvider: scriptedProvider,
      autoApprove: false,
    });

    const create = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const sessionId = create.json().id;

    const fakeApprover = {
      resolveById: () => false,
    };
    const start = (app as unknown as {
      __cw: { registry: { startIfIdle: (id: string, a: unknown) => { runtime: unknown; busy: boolean } } };
    }).__cw.registry.startIfIdle(sessionId, fakeApprover);
    expect(start.busy).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/approve`,
      payload: { requestId: "nope", decision: { kind: "approve_once" } },
    });
    expect(res.statusCode).toBe(404);
  });
});

// Ensure ECHO_TOOL is referenced (so unused-import lints stay quiet).
void ECHO_TOOL;