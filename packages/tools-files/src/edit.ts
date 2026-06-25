// packages/tools-files/src/edit.ts
// edit_file tool — atomic, all-or-nothing; supports array-of-replaces.
//
// Per REQUIREMENTS §4.2:
//   - Single-string replace by default; array-of-replaces supported.
//   - Atomic: all hunks must match before any write occurs.
//   - Approval-gated.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@computerworks/core";
import { resolveSafe } from "./path-safety.js";

const singleReplace = z.object({
  oldString: z.string().min(1).describe("Exact substring to find."),
  newString: z.string().describe("Replacement text. Use \"\" to delete."),
  /** Require a unique match. Default true. */
  unique: z.boolean().optional().default(true),
});

export const editFileInputSchema = z.object({
  path: z.string().min(1).describe("File to edit."),
  /** Single-string replace (legacy/simpler shape). */
  oldString: z.string().optional(),
  newString: z.string().optional(),
  /** Or an array of replaces applied in order. */
  replaces: z.array(singleReplace).optional(),
  normalizeEol: z.boolean().optional().default(true),
}).refine(
  (v) => Boolean(v.replaces) || (v.oldString !== undefined && v.newString !== undefined),
  { message: "either {oldString, newString} or replaces[] must be provided" },
);

export type EditFileInput = z.infer<typeof editFileInputSchema>;

export interface EditFileOutput {
  path: string;
  replacementsApplied: number;
}

interface ResolvedReplace {
  oldString: string;
  newString: string;
  unique: boolean;
}

function resolveReplaces(input: EditFileInput): ResolvedReplace[] {
  if (input.replaces && input.replaces.length > 0) {
    return input.replaces.map((r) => ({
      oldString: r.oldString,
      newString: r.newString,
      unique: r.unique ?? true,
    }));
  }
  return [{
    oldString: input.oldString!,
    newString: input.newString!,
    unique: true,
  }];
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export const editFileTool: ToolDefinition<EditFileInput, EditFileOutput> = {
  name: "edit_file",
  description:
    "Edit a UTF-8 file by replacing exact substrings. Either " +
    "{oldString, newString} for a single edit, or replaces[] for " +
    "multiple edits applied in order. Atomic: all hunks must match " +
    "before any write occurs. Approval-gated.",
  inputSchema: editFileInputSchema as unknown as import("@computerworks/core").z.ZodType<EditFileInput>,
  requiresApproval: true,
  async execute(input: EditFileInput, ctx) {
    const { absolute } = resolveSafe(input.path, { cwd: ctx.cwd });
    const buf = await readFile(absolute);
    let text = buf.toString("utf8");
    if (input.normalizeEol) text = normalize(text);

    const replaces = resolveReplaces(input);
    let next = text;
    let applied = 0;
    for (const rep of replaces) {
      const needle = input.normalizeEol ? normalize(rep.oldString) : rep.oldString;
      const replacement = input.normalizeEol ? normalize(rep.newString) : rep.newString;
      const occurrences = next.split(needle).length - 1;
      if (occurrences === 0) {
        throw new Error(
          `edit_file: oldString not found in ${input.path}: ${needle.slice(0, 80)}${needle.length > 80 ? "…" : ""}`,
        );
      }
      if (rep.unique && occurrences > 1) {
        throw new Error(
          `edit_file: oldString matches ${occurrences} times in ${input.path}; ` +
            `pass unique:false to allow multiple replacements, or include more context.`,
        );
      }
      // Replace ALL occurrences when unique:false (matches common user expectation).
      if (rep.unique) {
        next = next.replace(needle, replacement);
      } else {
        next = next.split(needle).join(replacement);
      }
      applied += 1;
    }

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, next, { encoding: "utf8" });

    return { path: absolute, replacementsApplied: applied };
  },
};
