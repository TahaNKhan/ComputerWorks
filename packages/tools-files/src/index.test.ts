// packages/tools-files/src/index.test.ts
// T3.2 unit tests — read_file / write_file / edit_file / list_dir.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFileTool, writeFileTool, editFileTool, listDirTool,
} from "./index.js";
import type { ToolContext } from "@computerworks/core";

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-files-"));
  ctx = {
    cwd: dir,
    signal: new AbortController().signal,
    env: {},
    sessionId: "test",
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── list_dir ────────────────────────────────────────────────────────────

describe("listDirTool", () => {
  it("returns entries with name, type, size, mtime", async () => {
    writeFileSync(join(dir, "a.txt"), "hi");
    mkdirSync(join(dir, "sub"));
    const entries = await listDirTool.execute({ path: dir }, ctx);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);
    const a = entries.find((e) => e.name === "a.txt")!;
    expect(a.type).toBe("file");
    expect(a.size).toBe(2);
    const s = entries.find((e) => e.name === "sub")!;
    expect(s.type).toBe("directory");
  });

  it("uses session cwd when path is omitted", async () => {
    writeFileSync(join(dir, "x"), "1");
    const entries = await listDirTool.execute({}, ctx);
    expect(entries.find((e) => e.name === "x")).toBeDefined();
  });

  it("does not require approval", () => {
    expect(listDirTool.requiresApproval).toBe(false);
  });
});

// ─── read_file ────────────────────────────────────────────────────────────

describe("readFileTool", () => {
  it("returns line-numbered content", async () => {
    writeFileSync(join(dir, "r.txt"), "alpha\nbeta\ngamma");
    const r = await readFileTool.execute({ path: "r.txt" }, ctx);
    expect(r.content).toContain("1\talpha");
    expect(r.content).toContain("2\tbeta");
    expect(r.content).toContain("3\tgamma");
    expect(r.lineCount).toBe(3);
  });

  it("honors startLine + maxLines", async () => {
    writeFileSync(join(dir, "r.txt"), "1\n2\n3\n4\n5");
    const r = await readFileTool.execute(
      { path: "r.txt", startLine: 2, maxLines: 2 },
      ctx,
    );
    expect(r.content).toContain("2\t2");
    expect(r.content).toContain("3\t3");
    expect(r.content).not.toContain("4\t4");
    expect(r.truncated).toBe(true);
  });

  it("rejects binary content (NUL byte)", async () => {
    writeFileSync(join(dir, "bin"), Buffer.from([0x68, 0x00, 0x69]));
    await expect(readFileTool.execute({ path: "bin" }, ctx)).rejects.toThrow(/binary/i);
  });

  it("returns file-not-found for missing files", async () => {
    await expect(readFileTool.execute({ path: "nope.txt" }, ctx)).rejects.toThrow(/not found/);
  });

  it("does not require approval", () => {
    expect(readFileTool.requiresApproval).toBe(false);
  });
});

// ─── write_file ───────────────────────────────────────────────────────────

describe("writeFileTool", () => {
  it("creates parent directories as needed", async () => {
    const r = await writeFileTool.execute(
      { path: join("deep", "nested", "file.txt"), content: "ok" },
      ctx,
    );
    expect(r.bytesWritten).toBe(2);
    expect(readFileSync(join(dir, "deep", "nested", "file.txt"), "utf8")).toBe("ok");
  });

  it("normalizes CRLF to LF by default", async () => {
    await writeFileTool.execute(
      { path: "x.txt", content: "line1\r\nline2\r\n" },
      ctx,
    );
    expect(readFileSync(join(dir, "x.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("preserves raw line endings when normalizeEol: false", async () => {
    await writeFileTool.execute(
      { path: "x.txt", content: "a\r\nb", normalizeEol: false },
      ctx,
    );
    const raw = readFileSync(join(dir, "x.txt"));
    expect(raw.includes(0x0d)).toBe(true);
  });

  it("requires approval", () => {
    expect(writeFileTool.requiresApproval).toBe(true);
  });
});

// ─── edit_file ────────────────────────────────────────────────────────────

describe("editFileTool", () => {
  beforeEach(() => {
    writeFileSync(join(dir, "e.txt"), "the quick brown fox\njumps over\n");
  });

  it("single replace via {oldString, newString}", async () => {
    const r = await editFileTool.execute(
      { path: "e.txt", oldString: "brown fox", newString: "red panda" },
      ctx,
    );
    expect(r.replacementsApplied).toBe(1);
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("the quick red panda\njumps over\n");
  });

  it("array-of-replaces applies in order", async () => {
    const r = await editFileTool.execute(
      {
        path: "e.txt",
        replaces: [
          { oldString: "quick", newString: "slow" },
          { oldString: "fox", newString: "turtle" },
        ],
      },
      ctx,
    );
    expect(r.replacementsApplied).toBe(2);
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toContain("slow brown turtle");
  });

  it("refuses on missing oldString", async () => {
    await expect(
      editFileTool.execute(
        { path: "e.txt", oldString: "no-such-text", newString: "x" },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("refuses on non-unique match by default", async () => {
    writeFileSync(join(dir, "e.txt"), "abc\nabc\nabc\n");
    await expect(
      editFileTool.execute(
        { path: "e.txt", oldString: "abc", newString: "x" },
        ctx,
      ),
    ).rejects.toThrow(/matches \d+ times/);
  });

  it("allows multi-replace when unique:false", async () => {
    writeFileSync(join(dir, "e.txt"), "abc\nabc\nabc\n");
    const r = await editFileTool.execute(
      {
        path: "e.txt",
        replaces: [{ oldString: "abc", newString: "x", unique: false }],
      },
      ctx,
    );
    expect(r.replacementsApplied).toBe(1);
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("x\nx\nx\n");
  });

  it("atomic: no write if any hunk fails", async () => {
    const before = readFileSync(join(dir, "e.txt"), "utf8");
    await expect(
      editFileTool.execute(
        {
          path: "e.txt",
          replaces: [
            { oldString: "quick", newString: "slow" },
            { oldString: "no-such", newString: "x" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe(before);
  });

  it("requires approval", () => {
    expect(editFileTool.requiresApproval).toBe(true);
  });
});

// ─── path safety (applies to all four tools) ───────────────────────────

describe("path safety", () => {
  it("rejects paths that escape the session cwd via ..", async () => {
    await expect(
      readFileTool.execute({ path: "../escape.txt" }, ctx),
    ).rejects.toThrow(/escapes/i);
    await expect(
      writeFileTool.execute(
        { path: "../escape.txt", content: "x" },
        ctx,
      ),
    ).rejects.toThrow(/escapes/i);
  });

  it("rejects absolute paths outside the session cwd", async () => {
    await expect(
      readFileTool.execute({ path: "/etc/passwd" }, ctx),
    ).rejects.toThrow(/escapes/i);
  });

  it("allows absolute paths inside the session cwd", async () => {
    writeFileSync(join(dir, "ok.txt"), "yes");
    const r = await readFileTool.execute({ path: join(dir, "ok.txt") }, ctx);
    expect(r.content).toContain("yes");
  });
});
