# Phase 3 — Design

## Module layout

```
packages/
├── tools-shell/
│   ├── package.json
│   └── src/
│       ├── index.ts          # run_shell ToolDefinition
│       └── index.test.ts
└── tools-files/
    ├── package.json
    └── src/
        ├── path-safety.ts    # resolveSafe(cwd, candidate) — single fs gate
        ├── read.ts           # read_file
        ├── write.ts          # write_file
        ├── edit.ts           # edit_file
        ├── list.ts           # list_dir
        ├── index.ts          # public re-exports + defaultTools()
        └── index.test.ts
```

## `run_shell`

```ts
export const runShell: ToolDefinition = {
  name: 'run_shell',
  description: 'Run a shell command. Bash on Unix, PowerShell on Windows.',
  inputSchema: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    cwd: z.string().optional(),
  }),
  requiresApproval: true,
  async execute(input, ctx) {
    // platform detection: process.platform === 'win32' → powershell, else bash -lc
    // spawn via node:child_process non-interactively
    // wire ctx.signal → AbortSignal that sets timedOut=true on abort
    // enforce timeout (default 60s) + output cap (default 100KB) with visible marker
    // return { stdout, stderr, exitCode, durationMs, timedOut, truncated }
  },
};
```

Key behaviors:

- A fresh `child_process.spawn` is used per call (no shell-history
  reuse).
- `ctx.signal` is wired into the child process; on abort the child is
  killed and `timedOut: true` is set (abort and timeout share the
  same shape).
- Output cap is per-stream (stdout and stderr each capped
  independently) with a `<truncated>` marker.
- The shell tool's environment is the sanitized `ctx.env` — secrets
  redaction is the agent's responsibility.

## `read_file`, `write_file`, `edit_file`, `list_dir`

All four tools share `path-safety.ts`'s `resolveSafe` as the single
path-resolution gate. Nothing else in the package calls `fs` directly
without going through it.

```ts
export function resolveSafe(cwd: string, candidate: string): string {
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes cwd: ${candidate}`);
  }
  return abs;
}
```

### `read_file`

- `inputSchema`: `{ path: string; startLine?: number; maxLines?: number }`.
- Reads file as a buffer; if the first 8KB contains a NUL byte or
  >5% control characters, refuses with a clear error suggesting the
  user attach directly (when attachments are added).
- 5MB cap on file size.
- Output is line-numbered (`   1\t<line>`) to match the editor
  experience.
- Read-only: `requiresApproval: false`.

### `write_file`

- `inputSchema`: `{ path: string; content: string; normalizeNewlines?: boolean }`.
- `mkdir -p` the parent directory.
- UTF-8 encoded; CRLF → LF by default unless `normalizeNewlines:
  false`.
- `requiresApproval: true`.

### `edit_file`

- `inputSchema`:
  ```ts
  z.union([
    z.object({ path: z.string(), oldString: z.string(),
               newString: z.string(), unique: z.boolean().default(true) }),
    z.object({ path: z.string(),
               replaces: z.array(z.object({ oldString: z.string(), newString: z.string() })),
               unique: z.boolean().default(true) }),
  ])
  ```
- Reads the file once into memory.
- Validates every hunk matches before any write.
- Atomic: if any hunk fails to match, the file is unchanged.
- `requiresApproval: true`.

### `list_dir`

- `inputSchema`: `{ path: string }` (defaults to cwd).
- Returns `{ name, type, size, mtime }[]`.
- Honors `.gitignore` when the cwd is inside a git repository (uses
  `git ls-files` or a tiny gitignore matcher; the implementation
  chose the latter to avoid a git dependency).
- Read-only: `requiresApproval: false`.

## Testing strategy

- `tools-files/src/index.test.ts`: read / write / edit / list with a
  temp directory; path-traversal rejections; binary rejection;
  oversize rejection; edit atomicity; `unique: false` multi-match.
- `tools-shell/src/index.test.ts`: scripted temp script that exits
  0, exits 1, sleeps past the timeout, and is killed by abort.

## Risks & mitigations

| Risk                                       | Mitigation                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Path traversal via `..`                    | `resolveSafe` is the only path-resolver; rejects `..` and absolute-outside-cwd before any `fs` call. |
| Symlink escape                             | `resolveSafe` uses `path.resolve` (follows symlinks); symlink-chain test catches escapes. |
| `run_shell` env-leak                       | Tool receives a sanitized `ctx.env`; secrets redaction is the agent's.     |
| Runaway shell                              | Default 60s timeout, configurable per call; abort kills the child.         |