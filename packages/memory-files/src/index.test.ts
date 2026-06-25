// packages/memory-files/src/index.test.ts
// T4.1 unit tests — FileMemoryProvider.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryProvider, assertValidName } from "./index.js";

let dir: string;
let mem: ReturnType<typeof createFileMemoryProvider>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-mem-"));
  mem = createFileMemoryProvider({ root: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── round-trip ───────────────────────────────────────────────────────────

describe("write + read round-trip", () => {
  it("writes and reads a memory note", async () => {
    await mem.write("user-preferences", "# Prefs\n\n- dark mode\n");
    const got = await mem.read("user-preferences");
    expect(got).toBe("# Prefs\n\n- dark mode\n");
  });

  it("rejects names with path separators", async () => {
    await expect(mem.write("../escape", "x")).rejects.toThrow(/escapes|invalid/i);
    await expect(mem.write("dir/file", "x")).rejects.toThrow(/invalid/i);
    await expect(mem.write(".hidden", "x")).rejects.toThrow(/escapes|invalid/i);
  });

  it("rejects names with bad characters", () => {
    expect(() => assertValidName("foo bar")).toThrow(/invalid/);
    expect(() => assertValidName("foo/bar")).toThrow(/invalid/);
    expect(() => assertValidName("foo\\bar")).toThrow(/invalid/);
    expect(() => assertValidName("")).toThrow(/invalid/);
  });
});

// ─── missing file handling ────────────────────────────────────────────────

describe("missing files", () => {
  it("read throws a descriptive error for unknown names", async () => {
    await expect(mem.read("does-not-exist")).rejects.toThrow(/not found/);
  });

  it("delete is a no-op on missing files", async () => {
    await expect(mem.delete("never-existed")).resolves.toBeUndefined();
  });
});

// ─── list + index.json ────────────────────────────────────────────────────

describe("list", () => {
  it("returns empty list when nothing is written", async () => {
    const list = await mem.list();
    expect(list).toEqual([]);
  });

  it("returns name + preview for each note", async () => {
    await mem.write("a", "alpha beta gamma\n");
    await mem.write("b", "delta\nepsilon\n");
    const list = await mem.list();
    const names = list.map((e) => e.name).sort();
    expect(names).toEqual(["a", "b"]);
    expect(list.find((e) => e.name === "a")!.preview).toContain("alpha");
  });

  it("rebuilds index from disk on first call after a fresh root", async () => {
    // Write directly to disk, bypassing the provider.
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "notes", "manual.md"), "manually placed");
    // New provider on the same root — must rebuild index.json.
    const fresh = createFileMemoryProvider({ root: dir });
    const list = await fresh.list();
    expect(list.find((e) => e.name === "manual")?.preview).toContain("manually placed");
  });
});

// ─── search ───────────────────────────────────────────────────────────────

describe("search", () => {
  beforeEach(async () => {
    await mem.write("coffee", "I drink dark roast every morning.\n");
    await mem.write("tea", "Green tea in the afternoon.\n");
    await mem.write("coding", "TypeScript is my daily driver.\n");
  });

  it("matches in note content (case-insensitive)", async () => {
    const hits = await mem.search("DARK");
    expect(hits.length).toBe(1);
    expect(hits[0]!.name).toBe("coffee");
    expect(hits[0]!.snippet.toLowerCase()).toContain("dark");
  });

  it("matches in filename", async () => {
    const hits = await mem.search("coffee");
    expect(hits.length).toBe(1);
    expect(hits[0]!.name).toBe("coffee");
  });

  it("returns at most 10 hits", async () => {
    for (let i = 0; i < 15; i++) {
      await mem.write(`note-${i}`, "lorem ipsum dolor");
    }
    const hits = await mem.search("lorem");
    expect(hits.length).toBe(10);
  });

  it("returns empty for empty query", async () => {
    const hits = await mem.search("   ");
    expect(hits).toEqual([]);
  });

  it("returns empty when nothing matches", async () => {
    const hits = await mem.search("xyzzy-no-match");
    expect(hits).toEqual([]);
  });
});

// ─── write refuses to escape root ─────────────────────────────────────────

describe("path-traversal safety", () => {
  it("write with .. in name does not write outside notes/", async () => {
    await expect(mem.write("..", "x")).rejects.toThrow();
    await expect(mem.write("../escape", "x")).rejects.toThrow();
    // Nothing should have been created outside notes/.
    expect(() => readFileSync(join(dir, "escape"), "utf8")).toThrow();
  });
});
