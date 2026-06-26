// packages/memory-files/src/index.ts
// T4.1 — File-based MemoryProvider.
//
// Per DESIGN.MD §10:
//   - list(): Promise<{ name, preview }[]>
//   - read(name): Promise<string>
//   - write(name, content): Promise<void>
//   - search(query): Promise<{ name, snippet }[]>  (top-10)
//
// Storage layout (REQUIREMENTS.MD §4.6):
//   <root>/notes/<name>.md      (markdown notes)
//   <root>/index.json           (precomputed title + preview list)
//
// "Name" is the filename without extension. Both `notes/foo.md` and a
// `search("foo")` query use the bare name "foo". Names may contain
// alphanumerics, dash, underscore, dot — anything else is rejected.

import { mkdir, readFile, writeFile, readdir, unlink, stat } from "node:fs/promises";
import path, { join, basename, extname } from "node:path";
import { z } from "zod";

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const PREVIEW_LEN = 200;

export interface MemorySummary {
  name: string;
  preview: string;
}

export interface SearchHit {
  name: string;
  snippet: string;
}

export interface MemoryProvider {
  list(): Promise<MemorySummary[]>;
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<void>;
  delete(name: string): Promise<void>;
  search(query: string): Promise<SearchHit[]>;
}

export interface FileMemoryProviderOptions {
  /** Root directory. The provider creates <root>/notes/ on demand. */
  root: string;
}

const indexSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      preview: z.string(),
      mtime: z.string(),
    }),
  ),
});

/** Validate a memory name (no extension, no path separators). */
export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid memory name: ${JSON.stringify(name)} (allowed: letters, digits, '.', '-', '_')`,
    );
  }
}

function notesDir(root: string): string {
  return join(root, "notes");
}

function indexPath(root: string): string {
  return join(root, "index.json");
}

async function ensureDirs(root: string): Promise<void> {
  await mkdir(notesDir(root), { recursive: true });
  await mkdir(root, { recursive: true });
}

async function loadIndex(root: string): Promise<z.infer<typeof indexSchema>> {
  try {
    const raw = await readFile(indexPath(root), "utf8");
    const parsed = indexSchema.parse(JSON.parse(raw));
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [] };
    }
    // Corrupt index — rebuild from disk on the fly.
    return { entries: [] };
  }
}

async function saveIndex(
  root: string,
  index: z.infer<typeof indexSchema>,
): Promise<void> {
  await ensureDirs(root);
  await writeFile(indexPath(root), JSON.stringify(index, null, 2), "utf8");
}

async function rebuildIndex(root: string): Promise<z.infer<typeof indexSchema>> {
  const notes = notesDir(root);
  await mkdir(notes, { recursive: true });
  let names: string[];
  try {
    names = await readdir(notes);
  } catch {
    names = [];
  }
  const entries: z.infer<typeof indexSchema>["entries"] = [];
  for (const fname of names) {
    if (!fname.endsWith(".md")) continue;
    const name = basename(fname, ".md");
    const full = join(notes, fname);
    try {
      const st = await stat(full);
      const content = await readFile(full, "utf8");
      const preview = content.slice(0, PREVIEW_LEN).replace(/\s+/g, " ").trim();
      entries.push({
        name,
        preview,
        mtime: st.mtime.toISOString(),
      });
    } catch {
      // skip unreadable entries
    }
  }
  return { entries };
}

function snippetAround(haystack: string, needle: string, around = 60): string {
  const lower = haystack.toLowerCase();
  const i = lower.indexOf(needle.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - around);
  const end = Math.min(haystack.length, i + needle.length + around);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < haystack.length ? "…" : "";
  return prefix + haystack.slice(start, end).replace(/\s+/g, " ") + suffix;
}

export function createFileMemoryProvider(opts: FileMemoryProviderOptions): MemoryProvider {
  const { root } = opts;
  return {
    async list(): Promise<MemorySummary[]> {
      await ensureDirs(root);
      let idx = await loadIndex(root);
      if (idx.entries.length === 0) {
        idx = await rebuildIndex(root);
        await saveIndex(root, idx);
      }
      return idx.entries.map((e) => ({ name: e.name, preview: e.preview }));
    },

    async read(name: string): Promise<string> {
      assertValidName(name);
      const full = join(notesDir(root), `${name}.md`);
      try {
        return await readFile(full, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`memory note not found: ${name}`);
        }
        throw err;
      }
    },

    async write(name: string, content: string): Promise<void> {
      assertValidName(name);
      if (name.includes(path.sep) || name.includes("\\") || name.startsWith(".")) {
        throw new Error(`memory name escapes root: ${name}`);
      }
      await ensureDirs(root);
      const full = join(notesDir(root), `${name}.md`);
      // Path-traversal check: the resolved path must be inside notesDir.
      const notesAbs = join(notesDir(root));
      if (!full.startsWith(notesAbs.endsWith(path.sep) ? notesAbs : notesAbs + path.sep)) {
        throw new Error(`memory name escapes root: ${name}`);
      }
      await writeFile(full, content, "utf8");
      // Refresh index entry.
      const idx = await rebuildIndex(root);
      await saveIndex(root, idx);
    },

    async delete(name: string): Promise<void> {
      assertValidName(name);
      const full = join(notesDir(root), `${name}.md`);
      try {
        await unlink(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      const idx = await rebuildIndex(root);
      await saveIndex(root, idx);
    },

    async search(query: string): Promise<SearchHit[]> {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return [];
      await ensureDirs(root);
      let idx = await loadIndex(root);
      if (idx.entries.length === 0) {
        idx = await rebuildIndex(root);
        await saveIndex(root, idx);
      }
      const hits: SearchHit[] = [];
      for (const entry of idx.entries) {
        let snippet = "";
        if (entry.name.toLowerCase().includes(q)) {
          snippet = entry.preview || `(name match: ${entry.name})`;
        } else {
          // Read full content to find an in-body snippet.
          try {
            const content = await readFile(
              join(notesDir(root), `${entry.name}.md`),
              "utf8",
            );
            const s = snippetAround(content, q);
            if (s) snippet = s;
          } catch {
            // ignore unreadable
          }
        }
        if (snippet) {
          hits.push({ name: entry.name, snippet });
          if (hits.length >= 10) break;
        }
      }
      return hits;
    },
  };
}

export default createFileMemoryProvider;

// Convenience exports for tests / introspection.
export const __testing = {
  indexPath,
  notesDir,
  rebuildIndex,
  NAME_RE,
  PREVIEW_LEN,
};
