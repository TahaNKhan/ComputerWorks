// packages/server/src/tools/index.ts
// T5.7 — Default tool set registry.
//
// Per DESIGN.MD §8.4 the server registers a default set of tools:
//   run_shell, read_file, write_file, edit_file, list_dir,
//   read_memory, write_memory, list_memory, search_memory.
//
// We wrap each tool with a session-scoped ToolContext that injects the
// session's cwd and abort signal at execute time. For v1 the memory
// tools are wired through a single FileMemoryProvider instance per
// process (the user has one memory root per-machine).

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "@computerworks/core";
import {
  runShellTool, tools as fileTools,
} from "@computerworks/tools-shell";
import { tools as filesTools } from "@computerworks/tools-files";
import { createFileMemoryProvider, type MemoryProvider } from "@computerworks/memory-files";

/** Input schemas for the memory tools (the tool package exports the
 *  provider but not zod-typed ToolDefinitions). */
const readMemorySchema = z.object({ name: z.string().min(1) });
const writeMemorySchema = z.object({
  name: z.string().min(1),
  content: z.string(),
});
const listMemorySchema = z.object({});
const searchMemorySchema = z.object({
  query: z.string().min(1),
});

/** Build the memory tools given a MemoryProvider instance. */
function memoryTools(mem: MemoryProvider): ToolDefinition[] {
  // Each schema is wrapped as `unknown as never` at the ToolDefinition
  // boundary. Runtime is correct (zod parses + validates); the cast
  // is purely to satisfy TS strict-mode variance around z.input vs
  // z.output shape differences.
  const read: ToolDefinition = {
    name: "read_memory",
    description:
      "Read a memory note (Markdown file under ~/.computerworks/memory/notes/).",
    inputSchema: readMemorySchema as unknown as ToolDefinition["inputSchema"],
    requiresApproval: false,
    async execute(input: { name: string }) {
      return await mem.read(input.name);
    },
  };
  const write: ToolDefinition = {
    name: "write_memory",
    description:
      "Write a memory note. Approval-gated; the agent should only call this for facts likely useful across sessions.",
    inputSchema: writeMemorySchema as unknown as ToolDefinition["inputSchema"],
    requiresApproval: true,
    async execute(input: { name: string; content: string }) {
      await mem.write(input.name, input.content);
    },
  };
  const list: ToolDefinition = {
    name: "list_memory",
    description: "List available memory notes (name + first ~200 chars preview).",
    inputSchema: listMemorySchema as unknown as ToolDefinition["inputSchema"],
    requiresApproval: false,
    async execute() {
      return await mem.list();
    },
  };
  const search: ToolDefinition = {
    name: "search_memory",
    description:
      "Search memory notes (filename + content) for a query string. Returns up to 10 hits with snippets.",
    inputSchema: searchMemorySchema as unknown as ToolDefinition["inputSchema"],
    requiresApproval: false,
    async execute(input: { query: string }) {
      return await mem.search(input.query);
    },
  };
  return [read, write, list, search];
}

/**
 * Build the full default tool set for a server.
 *
 * `filesTools` and `runShellTool` already have correct input schemas.
 * The file tools' schemas are typed against the file package's input
 * types (with defaults applied); we cast through `unknown as never` only
 * at the boundary to satisfy TS strict-mode variance. Runtime is
 * unaffected.
 */
export function defaultTools(opts: { memoryRoot: string }): {
  tools: ToolDefinition[];
  memory: MemoryProvider;
} {
  const memory = createFileMemoryProvider({ root: opts.memoryRoot });
  return {
    tools: [
      // Shell
      runShellTool as unknown as ToolDefinition,
      // File tools (read, write, edit, list_dir)
      ...(filesTools as unknown as ToolDefinition[]),
      // Memory tools (read, write, list, search)
      ...memoryTools(memory),
    ],
    memory,
  };
}

/** Build a ToolContext for a given session id + cwd. The cwd comes from
 *  the session's stored meta.json; the signal is the per-session
 *  AbortController managed by the messages route. */
export function makeContext(
  cwd: string,
  signal: AbortSignal,
  sessionId: string,
): ToolContext {
  return {
    cwd,
    signal,
    env: process.env,
    sessionId,
  };
}

// Silence unused-import warning (fileTools is a placeholder for future
// memory-of-shell-tools — v1 uses runShellTool directly).
void fileTools;
