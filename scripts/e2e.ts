// scripts/e2e.ts
// T8.1 — End-to-end smoke test.
//
// Spawns the server in-process on port 0 with a ScriptedProvider and an
// AutoApprover, then drives a full happy-path session:
//   1. POST /api/sessions                  → create session
//   2. POST /api/sessions/:id/messages     → enqueue user message
//   3. GET  /api/sessions/:id/stream       → consume SSE, assert events
//   4. GET  /api/sessions/:id              → assert transcript persisted
//
// On success prints a summary and exits 0. On any failure prints the
// cause, closes the app, and exits 1.
//
// Run with: `bun run test:e2e` (or `bun run scripts/e2e.ts`).

import { createScriptedProvider } from "@computerworks/core";
import { buildApp, SessionStore } from "@computerworks/server";
import type { ServerEvent } from "@computerworks/server";

import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ParsedSSE {
  events: ServerEvent[];
  raw: string;
}

async function fetchHealth(baseUrl: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/health`);
  return res.status === 200;
}

async function postJSON<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  return { status: res.status, body: parsed as T };
}

async function getJSON<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const text = await res.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  return { status: res.status, body: parsed as T };
}

/**
 * Parse a UTF-8 SSE byte stream into ServerEvent frames. We only care
 * about `event:` and `data:` lines — comments and heartbeats are ignored.
 */
async function consumeSSEUntilDone(
  url: string,
  timeoutMs = 15_000,
): Promise<ParsedSSE> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    throw new Error(`SSE: bad response status=${res.status}`);
  }

  const decoder = new TextDecoder();
  const events: ServerEvent[] = [];
  let buf = "";
  let raw = "";

  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) events.push(ev);
        if (ev && ev.type === "done") {
          clearTimeout(timer);
          return { events, raw };
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
  return { events, raw };
}

function parseFrame(frame: string): ServerEvent | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (eventName === null) return null;
  const dataStr = dataLines.join("\n");
  if (dataStr === "") return { type: eventName as ServerEvent["type"] } as ServerEvent;
  try {
    const data = JSON.parse(dataStr);
    return { type: eventName, ...data } as ServerEvent;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "cw-e2e-sessions-"));
  const memoryRoot = mkdtempSync(join(tmpdir(), "cw-e2e-memory-"));
  mkdirSync(memoryRoot, { recursive: true });

  const cwd = process.cwd();
  console.log(`[e2e] sessionsRoot=${sessionsRoot}`);
  console.log(`[e2e] memoryRoot=${memoryRoot}`);

  const store = new SessionStore({ root: sessionsRoot });

  // ScriptedProvider script:
  //   frame 0: tool_call run_shell ls
  //   frame 1: text reply
  const scripted = createScriptedProvider({
    frames: [
      [
        { type: "message_start" },
        {
          type: "tool_call",
          call: {
            type: "tool_use",
            id: "call_ls_1",
            name: "run_shell",
            input: { cmd: "ls -la", timeoutMs: 5000 },
          },
        },
        { type: "message_done", usage: { input: 10, output: 4 } },
      ],
      [
        { type: "message_start" },
        { type: "token", delta: "Here are the files in the current directory." },
        { type: "message_done", usage: { input: 15, output: 8 } },
      ],
    ],
  });

  const app = await buildApp({
    config: {
      providers: { anthropic: {} },
      defaultProvider: "anthropic",
      server: { host: "127.0.0.1", port: 0 },
      approval: { autoApprove: { read: true, write: true, shell: true } },
      memory: { enabled: true, root: memoryRoot },
    },
    store,
    createProvider: () => scripted,
    autoApprove: true,
  });

  let exitCode = 0;
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("could not determine bound address");
    }
    const { port } = addr;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[e2e] server listening at ${baseUrl}`);

    // 1. Health check (with small retry loop for the bind).
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      if (await fetchHealth(baseUrl)) { healthy = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!healthy) {
      throw new Error("health check never returned 200");
    }
    console.log("[e2e] ✓ /api/health returned 200");

    // 2. Create session
    const create = await postJSON<{ id: string }>(`${baseUrl}/api/sessions`, {
      cwd,
      title: "e2e smoke",
    });
    if (create.status !== 201) {
      throw new Error(`create session failed: status=${create.status}`);
    }
    const sessionId = create.body.id;
    console.log(`[e2e] ✓ created session ${sessionId}`);

    // 3. Subscribe to SSE before posting the message so we don't miss events.
    const ssePromise = consumeSSEUntilDone(`${baseUrl}/api/sessions/${sessionId}/stream`);

    // 4. POST message — should return 204 and kick off the agent loop.
    const post = await postJSON<unknown>(
      `${baseUrl}/api/sessions/${sessionId}/messages`,
      { content: "list the files in this directory" },
    );
    if (post.status !== 204) {
      throw new Error(`POST /messages expected 204, got ${post.status}`);
    }
    console.log("[e2e] ✓ POST /messages returned 204");

    // 5. Consume the SSE stream and assert events.
    const { events, raw } = await ssePromise;
    const types = events.map((e) => e.type);
    console.log(`[e2e] received ${events.length} SSE events: ${types.join(", ")}`);

    const toolCall = events.find((e) => e.type === "tool_call") as
      | Extract<ServerEvent, { type: "tool_call" }>
      | undefined;
    if (!toolCall) {
      throw new Error(`no tool_call event in stream. raw=${raw.slice(0, 500)}`);
    }
    if (toolCall.call.name !== "run_shell") {
      throw new Error(`expected run_shell tool_call, got ${toolCall.call.name}`);
    }
    console.log(`[e2e] ✓ tool_call received: ${toolCall.call.name}`);

    const toolResult = events.find((e) => e.type === "tool_result") as
      | Extract<ServerEvent, { type: "tool_result" }>
      | undefined;
    if (!toolResult) {
      throw new Error("no tool_result event in stream");
    }
    if (toolResult.is_error) {
      throw new Error(`tool_result is_error=true: ${toolResult.reason ?? ""}`);
    }
    console.log(`[e2e] ✓ tool_result received (approved=true, no error)`);

    const token = events.find((e) => e.type === "token");
    if (!token) {
      throw new Error("no token event in stream");
    }
    console.log("[e2e] ✓ token event received");

    const done = events.find((e) => e.type === "done");
    if (!done) {
      throw new Error("no done event in stream");
    }
    console.log("[e2e] ✓ done event received");

    // 6. Assert transcript persisted.
    const detail = await getJSON<{
      meta: { id: string };
      messages: Array<{ role: string; content: unknown }>;
      audit: unknown[];
    }>(`${baseUrl}/api/sessions/${sessionId}`);
    if (detail.status !== 200) {
      throw new Error(`GET /sessions/:id failed: status=${detail.status}`);
    }
    if (detail.body.meta.id !== sessionId) {
      throw new Error(`session id mismatch: ${detail.body.meta.id} !== ${sessionId}`);
    }
    const msgs = detail.body.messages;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      throw new Error("transcript is empty");
    }
    const roles = msgs.map((m) => m.role);
    if (!roles.includes("user")) {
      throw new Error(`transcript missing user message: ${roles.join(",")}`);
    }
    if (!roles.includes("assistant")) {
      throw new Error(`transcript missing assistant message: ${roles.join(",")}`);
    }
    console.log(`[e2e] ✓ transcript persisted: ${msgs.length} messages [${roles.join(", ")}]`);

    console.log("");
    console.log("================================================");
    console.log("  E2E smoke test PASSED");
    console.log("================================================");
    console.log(`  session:    ${sessionId}`);
    console.log(`  sse events: ${events.length}`);
    console.log(`  transcript: ${msgs.length} messages`);
    console.log("================================================");
  } catch (err) {
    exitCode = 1;
    console.error("");
    console.error("================================================");
    console.error("  E2E smoke test FAILED");
    console.error("================================================");
    console.error(err);
    console.error("================================================");
  } finally {
    try {
      await app.close();
    } catch { /* ignore */ }
    try { rmSync(sessionsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(exitCode);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
