// packages/server/src/routes/sessions.test.ts
// T19.3 — Integration tests for the titleSource stamping on
// POST /api/sessions and PATCH /api/sessions/:id.
//
// We go through `buildApp` + `app.inject()` so the route handlers
// are exercised end-to-end (the inference logic lives in the route,
// not the store).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { buildApp } from "../app.js";
import { SessionStore } from "../session-store.js";

const baseConfig: Config = {
  providers: { anthropic: {} },
  defaultProvider: "anthropic",
  server: { host: "127.0.0.1", port: 4747 },
  approval: { autoApprove: { read: true, write: false, shell: false } },
};

let sessionsRoot: string;
let memoryRoot: string;

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), "cw-sessions-"));
  memoryRoot = mkdtempSync(join(tmpdir(), "cw-mem-"));
  mkdirSync(memoryRoot, { recursive: true });
});

afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true });
  rmSync(memoryRoot, { recursive: true, force: true });
});

async function buildTestApp(): Promise<Awaited<ReturnType<typeof buildApp>>> {
  return buildApp({
    config: baseConfig,
    store: new SessionStore({ root: sessionsRoot }),
  });
}

// ─── POST /api/sessions ──────────────────────────────────────────────────

describe("POST /api/sessions — titleSource stamping", () => {
  it("with title, creates meta with titleSource: 'manual'", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Sprint planning" },
    });
    expect(res.statusCode).toBe(201);
    const meta = res.json();
    expect(meta.title).toBe("Sprint planning");
    expect(meta.titleSource).toBe("manual");
  });

  it("without title, creates meta with titleSource: 'auto'", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const meta = res.json();
    expect(meta.title).toBe("");
    expect(meta.titleSource).toBe("auto");
  });
});

// ─── PATCH /api/sessions/:id ─────────────────────────────────────────────

describe("PATCH /api/sessions/:id — titleSource stamping", () => {
  it("setting title stamps titleSource: 'manual'", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {},
    });
    const { id } = create.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { title: "My notes" },
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.title).toBe("My notes");
    expect(meta.titleSource).toBe("manual");
  });

  it("clearing title (empty string) resets titleSource to 'auto'", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Pinned" },
    });
    const { id } = create.json();

    // Sanity: starts manual.
    const before = await app.inject({
      method: "GET",
      url: `/api/sessions/${id}`,
    });
    expect(before.json().meta.titleSource).toBe("manual");

    // Clear via empty title → flips back to "auto".
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.title).toBe("");
    expect(meta.titleSource).toBe("auto");
  });

  it("explicit titleSource: 'auto' is honored (escape hatch)", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Pinned" },
    });
    const { id } = create.json();

    // Operator resets a manual session back to auto without changing
    // the title.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { titleSource: "auto" },
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.title).toBe("Pinned"); // unchanged
    expect(meta.titleSource).toBe("auto"); // explicit override wins
  });

  it("explicit titleSource: 'manual' is honored even with title: ''", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {},
    });
    const { id } = create.json();

    // Force a manual lock without setting a title.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { titleSource: "manual" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().titleSource).toBe("manual");
  });

  it("patching cwd / model without title does NOT touch titleSource", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Sticky" },
    });
    const { id } = create.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { cwd: "/tmp" },
    });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.title).toBe("Sticky");
    expect(meta.titleSource).toBe("manual"); // unchanged
    expect(meta.cwd).toBe("/tmp");
  });

  it("lastRenamedAtMessageCount can be set via PATCH", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {},
    });
    const { id } = create.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { lastRenamedAtMessageCount: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastRenamedAtMessageCount).toBe(4);
  });

  it("returns 404 for unknown session id", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/sessions/does-not-exist",
      payload: { title: "X" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unknown fields in the patch (zod strict)", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {},
    });
    const { id } = create.json();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { title: "X", bogus: true } as unknown as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /api/sessions/:id returns the new fields ────────────────────────

describe("GET /api/sessions/:id — titleSource round-trip", () => {
  it("returns titleSource in meta on GET", async () => {
    const app = await buildTestApp();
    const create = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Round-trip" },
    });
    const { id } = create.json();
    const get = await app.inject({
      method: "GET",
      url: `/api/sessions/${id}`,
    });
    const body = get.json();
    expect(body.meta.title).toBe("Round-trip");
    expect(body.meta.titleSource).toBe("manual");
  });
});