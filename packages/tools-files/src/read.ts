// packages/tools-files/src/read.ts
// read_file tool — line-numbered text reader, rejects binary, size-capped.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "@computerworks/core";
import { resolveSafe } from "./path-safety.js";

export const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB

export const readFileInputSchema = z.object({
  path: z.string().min(1).describe("File to read. Relative to session cwd, or absolute if inside allowed root."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override the 5MB size cap."),
  startLine: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Read starting at this 1-indexed line number. Default 1."),
  maxLines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Limit the number of lines returned."),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export interface ReadFileOutput {
  path: string;
  content: string;
  lineCount: number;
  truncated: boolean;
}

/**
 * Heuristic binary detection: if any of the first 8KB contains a NUL byte
 * or >5% non-text control characters, treat as binary.
 */
async function looksBinary(buf: Buffer): Promise<boolean> {
  const sample = buf.subarray(0, Math.min(buf.byteLength, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) control++;
  }
  return sample.length > 0 && control / sample.length > 0.05;
}

export const readFileTool: ToolDefinition<ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description:
    "Read a UTF-8 text file with line numbers. Rejects binary content. " +
    "Read-only; no approval required.",
  inputSchema: readFileInputSchema as unknown as import("@computerworks/core").z.ZodType<ReadFileInput>,
  requiresApproval: false,
  async execute(input: ReadFileInput, ctx) {
    const { absolute } = resolveSafe(input.path, { cwd: ctx.cwd });
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    const startLine = input.startLine ?? 1;

    let buf: Buffer;
    try {
      buf = await readFile(absolute);
    } catch (err) {
      // Surface ENOENT cleanly so the model can recover.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`file not found: ${input.path}`);
      }
      throw err;
    }

    if (buf.byteLength > maxBytes) {
      throw new Error(
        `file too large: ${buf.byteLength} bytes (cap ${maxBytes}); use startLine/maxLines or raise maxBytes`,
      );
    }
    if (await looksBinary(buf)) {
      throw new Error(
        `binary content detected; refusing to read (${input.path}). ` +
          `If you need binary support, attach the file directly when that feature lands.`,
      );
    }

    const text = buf.toString("utf8");
    const allLines = text.split(/\r?\n/);
    const startLineClamped = Math.max(1, startLine);
    const endLine = input.maxLines ? startLineClamped - 1 + input.maxLines : allLines.length;
    const slice = allLines.slice(startLine - 1, endLine);
    const numbered = slice
      .map((line, idx) => `${String(startLineClamped + idx).padStart(6, " ")}\t${line}`)
      .join("\n");

    return {
      path: absolute,
      content: numbered,
      lineCount: slice.length,
      truncated: endLine < allLines.length,
    };
  },
};
