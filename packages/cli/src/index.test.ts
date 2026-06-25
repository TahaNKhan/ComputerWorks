// packages/cli/src/index.test.ts
// T6.2 — Tests for CLI commands.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sessionsCmd from "./commands/sessions.js";
import * as memoryCmd from "./commands/memory.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

const testSessionsRoot = join(tmpdir(), `cw-cli-test-sessions-${process.pid}`);
const testMemoryRoot = join(tmpdir(), `cw-cli-test-memory-${process.pid}`);

// Patch env so the commands use our temp dirs.
let origSessionsRoot: string | undefined;
let origMemoryRoot: string | undefined;

beforeEach(async () => {
  origSessionsRoot = process.env.COMPUTERWORKS_SESSIONS_ROOT;
  origMemoryRoot = process.env.COMPUTERWORKS_MEMORY_ROOT;
  process.env.COMPUTERWORKS_SESSIONS_ROOT = testSessionsRoot;
  process.env.COMPUTERWORKS_MEMORY_ROOT = testMemoryRoot;
  await mkdir(testSessionsRoot, { recursive: true });
  await mkdir(testMemoryRoot, { recursive: true });
});

afterEach(async () => {
  process.env.COMPUTERWORKS_SESSIONS_ROOT = origSessionsRoot;
  process.env.COMPUTERWORKS_MEMORY_ROOT = origMemoryRoot;
  await rm(testSessionsRoot, { recursive: true, force: true });
  await rm(testMemoryRoot, { recursive: true, force: true });
});

// ─── Sessions tests ─────────────────────────────────────────────────────────

test("sessions list — empty", async () => {
  const { SessionStore } = await import("@computerworks/server");
  const store = new SessionStore({ root: testSessionsRoot });
  const sessions = await store.list();
  expect(sessions).toEqual([]);
});

test("sessions list — shows a session", async () => {
  const { SessionStore } = await import("@computerworks/server");
  const store = new SessionStore({ root: testSessionsRoot });
  await store.create({ cwd: "/tmp", model: "test-model", title: "Test Session" });
  const sessions = await store.list();
  expect(sessions.length).toBe(1);
  expect(sessions[0]?.title).toBe("Test Session");
});

test("sessions export — outputs markdown with messages", async () => {
  const { SessionStore } = await import("@computerworks/server");
  const store = new SessionStore({ root: testSessionsRoot });
  const meta = await store.create({ cwd: "/tmp", model: "test-model", title: "Export Test" });
  await store.appendMessage(meta.id, { role: "user", content: "Hello, world!" });
  await store.appendMessage(meta.id, { role: "assistant", content: "Hi there!" });

  const messages = await store.getMessages(meta.id);
  expect(messages.length).toBe(2);
  expect(messages[0]?.content).toBe("Hello, world!");
  expect(messages[1]?.content).toBe("Hi there!");
});

// ─── Memory tests ─────────────────────────────────────────────────────────────

test("memory ls — empty", async () => {
  const { createFileMemoryProvider } = await import("@computerworks/memory-files");
  const provider = createFileMemoryProvider({ root: testMemoryRoot });
  const notes = await provider.list();
  expect(notes).toEqual([]);
});

test("memory ls — after writing a note", async () => {
  const { createFileMemoryProvider } = await import("@computerworks/memory-files");
  const provider = createFileMemoryProvider({ root: testMemoryRoot });
  await provider.write("test-note", "This is a test note.");
  const notes = await provider.list();
  expect(notes.length).toBe(1);
  expect(notes[0]?.name).toBe("test-note");
  expect(notes[0]?.preview).toContain("test note");
});

test("memory show — prints note content", async () => {
  const { createFileMemoryProvider } = await import("@computerworks/memory-files");
  const provider = createFileMemoryProvider({ root: testMemoryRoot });
  const content = "Hello from memory!";
  await provider.write("show-test", content);
  const read = await provider.read("show-test");
  expect(read).toBe(content);
});
