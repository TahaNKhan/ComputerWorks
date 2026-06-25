// packages/tools-files/src/list.ts
// list_dir tool — read-only directory listing, no approval required.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@computerworks/core";
import { resolveSafe } from "./path-safety.js";

export const listDirInputSchema = z.object({
  path: z
    .string()
    .optional()
    .default(".")
    .describe("Directory to list. Relative to session cwd, or absolute if inside allowed root."),
  respectGitignore: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true and the directory is inside a git repo, skip .gitignore'd entries."),
});

export type ListDirInput = z.infer<typeof listDirInputSchema>;

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: string; // ISO
}

export const listDirTool: ToolDefinition<ListDirInput, DirEntry[]> = {
  name: "list_dir",
  description:
    "List entries in a directory. Returns each entry's name, type, " +
    "size, and modification time. Read-only; no approval required.",
  inputSchema: listDirInputSchema as unknown as import("@computerworks/core").z.ZodType<ListDirInput>,
  requiresApproval: false,
  async execute(input: ListDirInput, ctx) {
    const path = input.path ?? ".";
    const { absolute } = resolveSafe(path, { cwd: ctx.cwd });
    const names = await readdir(absolute);
    const entries: DirEntry[] = [];
    for (const name of names) {
      const full = join(absolute, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        // dangling symlink etc.
        entries.push({
          name,
          type: "other",
          size: 0,
          mtime: new Date(0).toISOString(),
        });
        continue;
      }
      let type: DirEntry["type"];
      if (st.isDirectory()) type = "directory";
      else if (st.isFile()) type = "file";
      else if (st.isSymbolicLink()) type = "symlink";
      else type = "other";
      entries.push({
        name,
        type,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    }
    // .gitignore filtering is a Phase-3 stretch — v1 returns everything.
    // TODO Phase 7+ if needed: integrate `ignore` package for .gitignore support.
    const _respectGitignore = input.respectGitignore ?? true;
    void _respectGitignore;
    return entries;
  },
};
