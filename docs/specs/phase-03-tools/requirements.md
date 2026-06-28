# Phase 3 — Requirements

## Purpose

Give the agent two categories of hands: a shell that can run
arbitrary commands (with approval), and a set of file tools that can
read, write, edit, and list files inside the session's working
directory (writes and edits with approval). Safety is non-negotiable:
no tool may escape its allowed surface, no tool may run a mutating
call without explicit approval.

## Users / actors

- **The agent loop** — invokes tools via the registry.
- **The user** — approves mutating tool calls in the UI.
- **The operating system** — runs `run_shell` via
  `node:child_process`.

## Functional requirements

### `run_shell` (`packages/tools-shell/src/index.ts`)

- FR-1. Platform-detected: PowerShell on Windows, `bash -lc` on Unix.
- FR-2. Spawned via `node:child_process`, non-interactive (no TTY).
- FR-3. Returns `{ stdout, stderr, exitCode, durationMs, timedOut,
  truncated }`.
- FR-4. Hard timeout (default 60s, configurable per call).
- FR-5. Working directory defaults to the session's `cwd` from the
  tool context.
- FR-6. Output capped (default 100KB), truncated with a visible marker
  if exceeded.
- FR-7. Always approval-gated.

### `read_file` (`packages/tools-files/src/read.ts`)

- FR-8. Path is relative to the session cwd by default; absolute paths
  are allowed if within an allowed root.
- FR-9. Binary detection: refuse to read binary content (NUL byte or
  >5% control characters).
- FR-10. Max file size cap (default 5MB).
- FR-11. Returns content with line numbers.
- FR-12. Optional `startLine` and `maxLines` for paging.
- FR-13. Read-only — no approval required.

### `write_file` (`packages/tools-files/src/write.ts`)

- FR-14. Creates parent directories as needed.
- FR-15. UTF-8, normalized (CRLF → LF by default; opt-out flag).
- FR-16. Approval-gated.

### `edit_file` (`packages/tools-files/src/edit.ts`)

- FR-17. Single-string replace by default; array-of-replaces
  supported.
- FR-18. Atomic: all hunks must match before any write occurs.
- FR-19. `unique: false` to allow multi-match.
- FR-20. Approval-gated.

### `list_dir` (`packages/tools-files/src/list.ts`)

- FR-21. Read-only — no approval required.
- FR-22. Returns entries with `name`, `type`, `size`, `mtime`.
- FR-23. Respects `.gitignore` if the cwd is inside a git repository.

### Path safety (`packages/tools-files/src/path-safety.ts`)

- FR-24. `resolveSafe(cwd, candidate)` rejects absolute paths outside
  `cwd`, rejects `..` escapes, and is the only thing that should ever
  hand a path to `fs` from this package.
- FR-25. All four file tools use `resolveSafe` before any I/O.

## Non-functional requirements

- All four file tools run under the session's `cwd` and reject paths
  that escape it.
- Hard timeouts prevent runaway `run_shell` calls.
- Tool output (stdout/stderr) is rendered as a code block in the UI,
  not interpreted as markdown.
- `bun run typecheck && bun test` is green across all tools.

## Out of scope

- Web tools (`web_fetch`, `web_search`) — reserved for a later phase.
- Process scheduling, clipboard, system notifications.
- A tool marketplace. The tool set is fixed in v1.
- Sandboxing beyond path-safety + approval. No chroot, no seccomp, no
  container.

## Constraints

- All tools must use `ToolContext.signal` for cancellation.
- The shell tool's environment is sanitized (the agent's responsibility
  to redact secrets in shell commands; this tool does not).

## Acceptance criteria

- Unit tests cover each tool with a temp directory:
  - `run_shell`: exits 0, exits 1, times out, killed by abort.
  - `read_file`: line-numbered, startLine / maxLines, binary rejected,
    oversize rejected.
  - `write_file`: parent dirs created, UTF-8 normalized, approval
    flag set.
  - `edit_file`: single + array replaces, atomic, multi-match with
    `unique: false`.
  - `list_dir`: returns type/size/mtime, respects `.gitignore`.
- Path-traversal tests: `../escape`, absolute outside cwd, symlink
  chains — all rejected with a clear error.

## Open questions

None at acceptance.