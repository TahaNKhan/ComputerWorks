// packages/server/src/title-fallback.test.ts
// T19.12 — Tests for the server-side title fallback.
//
// `ensureTitleFallback` is the safety net: when the LLM doesn't
// call `rename_session` after the first user message, the server
// fires `deriveTitle` and patches the meta. We test the helper
// directly against a real SessionStore + SyncHub in a temp dir.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realCore from "@computerworks/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import { SyncHub } from "./sync-hub.js";
import { ensureTitleFallback } from "./title-fallback.js";
import type { ServerEvent } from "./sse.js";
import type { SSEWriter } from "./sse-writer.js";

const realCoreSnapshot = { ...realCore };

// Mock @computerworks/core for title.ts — deriveTitle calls
// `getDefaultAnthropicProvider().inferText(...)`. The mock echoes
// the cleaned user input as the title so we can assert deterministically.
mock.module("@computerworks/core", () => ({
  ...realCoreSnapshot,
  getDefaultAnthropicProvider: () => ({
    inferText: async (prompt: string): Promise<string> => {
      const m = prompt.match(/User Input:\s*(.+)$/);
      return m ? m[1]! : prompt;
    },
  }),
}));

let root: string;
let store: SessionStore;
let syncHub: SyncHub;
let broadcasts: ServerEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cw-fallback-"));
  store = new SessionStore({ root });
  syncHub = new SyncHub();
  broadcasts = [];
  syncHub["subs"] = new Set<SSEWriter>([
    {
      write(ev: ServerEvent) { broadcasts.push(ev); },
      end() {},
      get closed() { return false; },
    },
  ]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function makeSession(title = ""): Promise<string> {
  const meta = await store.create({ cwd: "/tmp", model: "test", title });
  return meta.id;
}

// ─── Happy path ──────────────────────────────────────────────────────────

describe("ensureTitleFallback (T19.12)", () => {
  it("names the session when title is empty", async () => {
    const id = await makeSession();
    await store.appendMessage(id, { role: "user", content: "Help with React" });

    await ensureTitleFallback({
      store, syncHub, sessionId: id,
      userContent: "Help with React",
    });

    const after = await store.get(id);
    expect(after?.title).toBe("Help with React");
    expect(after?.titleSource).toBe("auto");
    const renameBroadcasts = broadcasts.filter(
      (e) => e.type === "session_renamed" && e.sessionId === id,
    );
    expect(renameBroadcasts.length).toBe(1);
    expect(renameBroadcasts[0]).toMatchObject({
      type: "session_renamed",
      title: "Help with React",
      titleSource: "auto",
    });
  });

  it("does not overwrite a non-empty title", async () => {
    const id = await makeSession("User-set title");
    await store.appendMessage(id, { role: "user", content: "anything" });

    await ensureTitleFallback({
      store, syncHub, sessionId: id,
      userContent: "anything",
    });

    const after = await store.get(id);
    expect(after?.title).toBe("User-set title");
    expect(broadcasts).toEqual([]);
  });

  it("does not overwrite a manual titleSource", async () => {
    const id = await makeSession("Manual lock");
    await store.patch(id, { titleSource: "manual" });

    await ensureTitleFallback({
      store, syncHub, sessionId: id,
      userContent: "anything",
    });

    const after = await store.get(id);
    expect(after?.title).toBe("Manual lock");
    expect(after?.titleSource).toBe("manual");
    expect(broadcasts).toEqual([]);
  });

  it("silently skips when the session does not exist", async () => {
    await ensureTitleFallback({
      store, syncHub, sessionId: "does-not-exist",
      userContent: "anything",
    });
    expect(broadcasts).toEqual([]);
  });

  it("silently skips when userContent is empty", async () => {
    const id = await makeSession();
    await store.appendMessage(id, { role: "user", content: "" });

    await ensureTitleFallback({
      store, syncHub, sessionId: id,
      userContent: "",
    });

    const after = await store.get(id);
    expect(after?.title).toBe("");
  });

  it("does not race: a successful rename_session between checks wins", async () => {
    const id = await makeSession();
    await store.appendMessage(id, { role: "user", content: "first message" });

    // Simulate the LLM renaming between the meta reads. Patch
    // synchronously here; the fallback's second `store.get`
    // inside `ensureTitleFallback` sees the new title and skips.
    // We patch the title directly to mimic the race.
    await store.patch(id, {
      title: "From LLM",
      titleSource: "auto",
    });

    await ensureTitleFallback({
      store, syncHub, sessionId: id,
      userContent: "first message",
    });

    const after = await store.get(id);
    expect(after?.title).toBe("From LLM");
  });

  it("swallows errors (best-effort)", async () => {
    const id = await makeSession();
    await store.appendMessage(id, { role: "user", content: "anything" });

    // Force a throw inside deriveTitle by breaking the store.
    // ensureTitleFallback should log + swallow.
    const brokenStore = {
      ...store,
      get: async () => { throw new Error("boom"); },
    } as unknown as SessionStore;

    // No throw escapes.
    await ensureTitleFallback({
      store: brokenStore, syncHub, sessionId: id,
      userContent: "anything",
    });
    // Original store is unchanged.
    const after = await store.get(id);
    expect(after?.title).toBe("");
  });
});