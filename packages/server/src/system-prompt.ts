// packages/server/src/system-prompt.ts
// T5.7 — System prompt assembler.
//
// Per REQUIREMENTS.MD §4.6: the system prompt is a static prefix
// (project identity + tool rules + approval rules) followed by a
// listing of available memory notes (title + first ~200 chars) so the
// agent knows what to read_memory for.

import type { MemoryProvider } from "@computerworks/memory-files";

const STATIC_PREFIX = `# ComputerWorks — session context

You are ComputerWorks, a local PC-control assistant. The user is at the
terminal and approves every tool call that mutates state.

## Tool rules
- run_shell, write_file, edit_file, write_memory require approval.
  read_file, list_dir, read_memory, list_memory, search_memory do not.
- **Every tool call MUST include all required arguments** (path, command,
  content, etc.). Calls missing required fields fail validation and
  the user sees a structured error. Double-check your tool_use block
  before sending.
- read_file refuses binary content. Use write_file for new files and
  edit_file for small in-place changes.
- edit_file is atomic: ALL hunks must match before any write occurs.
  If one fails, the file is untouched.

## Shell safety
- We do not auto-quote shell input. Show the user exactly what you're
  about to run.
- Prefer non-destructive commands first (\`ls\`, \`git status\`).
- Don't pipe untrusted input through \`sh\` or \`eval\`.

## Memory
- You may call write_memory when you learn something likely useful in
  FUTURE sessions (recurring user preferences, project facts).
- One memory per topic; use descriptive kebab-case names like
  \`user-preferences\` or \`project-acme-architecture\`.

## Output
- Use GFM markdown. Code blocks for commands and file contents.
- Prefer tables when comparing options.
- Be concise; don't restate the user's question back to them.

`;

export interface BuildSystemPromptOptions {
  memory: MemoryProvider;
  cwd: string;
  model: string;
  /** Truncate memory list to this many entries to bound prompt size. */
  maxMemoryEntries?: number;
}

/**
 * Assemble the system prompt: static prefix + a compact directory of
 * available memory notes. The agent can read_memory(name) for full
 * contents.
 */
export async function buildSystemPrompt(
  opts: BuildSystemPromptOptions,
): Promise<string> {
  const max = opts.maxMemoryEntries ?? 30;
  const notes = await opts.memory.list();
  const truncated = notes.slice(0, max);

  const lines: string[] = [STATIC_PREFIX];
  lines.push(`## Session`);
  lines.push(`- cwd: \`${opts.cwd}\``);
  lines.push(`- model: \`${opts.model}\``);
  lines.push("");
  lines.push(`## Memory (${truncated.length}${notes.length > max ? ` of ${notes.length}` : ""} notes)`);
  if (truncated.length === 0) {
    lines.push("_No memory notes yet._");
  } else {
    for (const n of truncated) {
      const preview = n.preview.length > 120
        ? n.preview.slice(0, 117) + "…"
        : n.preview;
      lines.push(`- **${n.name}**: ${preview}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
