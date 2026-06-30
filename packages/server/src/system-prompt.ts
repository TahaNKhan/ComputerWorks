// packages/server/src/system-prompt.ts
// T5.7 — System prompt assembler.
//
// Per REQUIREMENTS.MD §4.6: the system prompt is a static prefix
// (project identity + tool rules + approval rules) followed by a
// listing of available memory notes (title + first ~200 chars) so the
// agent knows what to read_memory for.
//
// T19.6 — when `llmDecides` is true, the prompt gains a "Session
// title" section that teaches the model about the `rename_session`
// tool (when to call it, when not to). Setting `llmDecides` to
// false omits the section, which is the documented way to disable
// LLM-driven retitling — operators who don't want the sidebar to
// ever auto-update can flip the env var and the model never learns
// the tool exists.

import type { MemoryProvider } from "@computerworks/memory-files";

/** Shell-safety guidance is platform-conditional so the LLM picks
 *  commands that actually exist on the host shell (PowerShell on
 *  Windows, bash on Unix). Both blocks are written to read identically
 *  at a glance — the differences are only the command names. */
function shellSafetyBlock(): string {
  if (process.platform === "win32") {
    return `## Shell safety (Windows / PowerShell)
- We do not auto-quote shell input. Show the user exactly what you're
  about to run.
- Prefer non-destructive commands first (\`Get-ChildItem\`,
  \`Get-Process\`, \`git status\`).
- Don't pipe untrusted input through \`Invoke-Expression\` or
  \`iex\`. Use \`Start-Process\` with explicit args instead.`;
  }
  return `## Shell safety (Unix / bash)
- We do not auto-quote shell input. Show the user exactly what you're
  about to run.
- Prefer non-destructive commands first (\`ls\`, \`git status\`).
- Don't pipe untrusted input through \`sh\` or \`eval\`.`;
}

/** T19.6 — the "Session title" section. Inlined when `llmDecides`
 *  is true; omitted entirely when false. Kept as a separate string
 *  so the test can assert inclusion/exclusion without rebuilding the
 *  whole prompt. */
function sessionTitleBlock(): string {
  return `## Session title

The session title is shown in the sidebar and helps the user find
this conversation later. You can update it by calling the
\`rename_session\` tool with a 3-5 word title.

Call \`rename_session\` when:
- The current title no longer describes the topic (e.g. the user
  shifted from "K8s backup" to "React component").
- You can summarize the conversation confidently (don't call it on
  turn 1 if the user only said "hi" and you have no signal yet).

Do NOT call \`rename_session\`:
- On every turn — the server rate-limits you. If you call it too
  soon after the previous rename, the tool returns \`rate_limited\`.
- If the user has manually renamed the session. The server rejects
  with \`manual_rename_locked\`; respect their choice.
- For trivial exchanges that don't change the topic.

The tool sanitizes your input (strips quotes, collapses whitespace,
truncates to 80 chars at a word boundary). Reply with the raw title
text only — no quotes, no prefix, no explanation.
`;
}

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

${shellSafetyBlock()}

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
  /** T19.6 — when true (default), include the "Session title"
   *  section that teaches the model about `rename_session`.
   *  Operators disable LLM-driven retitling by setting this to
   *  false (config.title.llmDecides). */
  llmDecides?: boolean;
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
  const llmDecides = opts.llmDecides ?? true;

  const lines: string[] = [STATIC_PREFIX];
  if (llmDecides) {
    lines.push(sessionTitleBlock());
  }
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
