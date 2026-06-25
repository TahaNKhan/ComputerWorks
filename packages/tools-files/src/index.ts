// packages/tools-files/src/index.ts
// Public surface of @computerworks/tools-files.

export { readFileTool, DEFAULT_MAX_READ_BYTES } from "./read.js";
export type { ReadFileInput, ReadFileOutput } from "./read.js";
export { writeFileTool } from "./write.js";
export type { WriteFileInput, WriteFileOutput } from "./write.js";
export { editFileTool } from "./edit.js";
export type { EditFileInput, EditFileOutput } from "./edit.js";
export { listDirTool } from "./list.js";
export type { ListDirInput, DirEntry } from "./list.js";

import { readFileTool } from "./read.js";
import { writeFileTool } from "./write.js";
import { editFileTool } from "./edit.js";
import { listDirTool } from "./list.js";
import type { ToolDefinition } from "@computerworks/core";

/** All four file tools in registration order. */
export const tools: ToolDefinition[] = [
  listDirTool,
  readFileTool,
  writeFileTool,
  editFileTool,
];

export default tools;
