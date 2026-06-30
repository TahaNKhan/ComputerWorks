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
 *  is true; omitted entirely when false. The current title is
 *  passed in so the model can compare against it (otherwise it
 *  has no way to know whether a rename is warranted). The
 *  wording uses direct imperative ("Consider renaming...") and
 *  positive triggers — models gloss over hedged suggestions. */
function sessionTitleBlock(currentTitle: string): string {
  return `## Session title

The session title is shown in the sidebar. The CURRENT title is:
\`${currentTitle || "(untitled)"}\`

You have a tool called \`rename_session\` that updates this title.
**Consider calling it on most turns.** The sidebar title is the
primary way the user finds this conversation later — keeping it
accurate is part of your job, not a nice-to-have.

When to call \`rename_session\`:
- The user has shifted topic (e.g. "now help me with React" after
  ten K8s messages).
- The current title is wrong, vague, or empty after turn 1.
- You can summarize the conversation confidently in 3-5 words.

When NOT to call:
- The current title is already accurate.
- The conversation is a single trivial exchange (e.g. "what time
  is it"). On turn 1 if there's no signal yet, skip it.
- The user just renamed the session manually — the server will
  reject with \`manual_rename_locked\`, but you don't need to retry.

Reply with the raw title only — no quotes, no prefix, no
explanation. The tool sanitizes (strips quotes, collapses
whitespace, truncates to 80 chars).
`;
}

const STATIC_PREFIX = `# ComputerWorks — session context

You are ComputerWorks, a local PC-control assistant. The user is at the
terminal and approves every tool call that mutates state.

## Tool rules
- run_shell, write_file, edit_file, write_memory require approval.
  read_file, list_dir, read_memory, list_memory, search_memory,
  rename_session do not.
- **Every tool call MUST include all required arguments** (path, command,
  content, title, etc.). Calls missing required fields fail
  validation and the user sees a structured error. Double-check
  your tool_use block before sending.
- read_file refuses binary content. Use write_file for new files and
  edit_file for small in-place changes.
- edit_file is atomic: ALL hunks must match before any write occurs.
  If one fails, the file is untouched.
- **rename_session** updates the sidebar title — see the "Session
  title" section below for when to call it.

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
  /** T19.11 — current session title. The "Session title" section
   *  surfaces it so the model can compare against the topic and
   *  decide whether to call `rename_session`. Without this, the
   *  model has no signal that a rename is warranted. Defaults to
   *  "" (treated as untitled). */
  currentTitle?: string;
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
  const currentTitle = opts.currentTitle ?? "";

  const lines: string[] = [STATIC_PREFIX];
  if (llmDecides) {
    lines.push(sessionTitleBlock(currentTitle));
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
