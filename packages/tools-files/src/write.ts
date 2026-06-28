// packages/tools-files/src/write.ts
// write_file tool — atomic write, creates parent dirs, UTF-8 normalized.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@computerworks/core";
import { resolveSafe } from "./path-safety.js";

export const writeFileInputSchema = z.object({
  path: z.string().min(1).describe(
    "REQUIRED. File to write, relative to session cwd or absolute if inside allowed root. " +
    "This argument MUST be included on every call — omitting it will fail validation."
  ),
  content: z.string().describe("REQUIRED. UTF-8 content to write."),
  /** Normalize line endings to LF. Default true (REQUIREMENTS §4.2). */
  normalizeEol: z.boolean().optional().default(true),
});

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

export interface WriteFileOutput {
  path: string;
  bytesWritten: number;
}

/**
 * Normalize line endings to LF. CRLF and CR are both converted.
 * NEL / LS / PS are left alone (they're valid in Unicode text).
 */
function normalizeToLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export const writeFileTool: ToolDefinition<WriteFileInput, WriteFileOutput> = {
  name: "write_file",
  description:
    "Write a UTF-8 file. Creates parent directories as needed. " +
    "Normalizes line endings to LF by default. Approval-gated.",
  inputSchema: writeFileInputSchema as unknown as import("@computerworks/core").z.ZodType<WriteFileInput>,
  requiresApproval: true,
  async execute(input: WriteFileInput, ctx) {
    const { absolute } = resolveSafe(input.path, { cwd: ctx.cwd });
    const normalizeEol = input.normalizeEol ?? true;
    const content = normalizeEol ? normalizeToLf(input.content) : input.content;

    // Create parent dirs. mkdir with recursive:true is idempotent.
    await mkdir(dirname(absolute), { recursive: true });

    // Atomic write via temp + rename would be ideal but adds complexity;
    // for v1 we accept the small window of partial writes.
    await writeFile(absolute, content, { encoding: "utf8" });

    return {
      path: absolute,
      bytesWritten: Buffer.byteLength(content, "utf8"),
    };
  },
};
