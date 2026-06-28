# Phase 4 — Design

## Module layout

```
packages/memory-files/
├── package.json
└── src/
    ├── index.ts          # createFileMemoryProvider(root) + the four tool definitions
    └── index.test.ts
```

## `MemoryProvider` interface

```ts
export interface MemoryProvider {
  list(): Promise<{ name: string; preview: string }[]>;
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<void>;
  delete(name: string): Promise<void>;
  search(query: string): Promise<{ name: string; snippet: string }[]>;
}
```

## File backend

### Storage

```
~/.computerworks/memory/
├── index.json                       # cached listing; rebuilt on first call
└── notes/
    ├── user-preferences.md
    ├── project-<name>.md
    └── …
```

### Name validation

`write` validates `name` against `[A-Za-z0-9._-]+` and rejects any
of `..`, `/`, `\\` to prevent directory escape. The validation runs
before any filesystem call.

### Search

`search(query)` walks `<root>/notes/`, lowercases both sides, and
returns top-10 matches across:

1. filename matches (substring),
2. file-content matches (substring).

Snippets are ±60 chars centered on the first match in the file (or
the whole preview if the file is short).

### Index rebuild

If `index.json` is missing or its `mtime` doesn't match the
directory's, the listing is rebuilt from disk on the next `list()`
call. The index is purely a cache; nothing depends on its
freshness.

## Tool wrapping

`createFileMemoryProvider(root)` returns a `MemoryProvider`. The
server's `defaultTools({ memoryRoot })` factory wraps four methods
into `ToolDefinition`s:

| Method   | Tool name      | Approval |
| -------- | -------------- | -------- |
| `read`   | `read_memory`  | no       |
| `write`  | `write_memory` | **yes**  |
| `list`   | `list_memory`  | no       |
| `search` | `search_memory`| no       |

The wrapping is thin: each tool's `inputSchema` is a `z.object(...)`
with a single field (`name` or `query`), and `execute` calls the
provider method.

## System-prompt integration

`packages/server/src/system-prompt.ts` calls `memory.list()` once
per turn and prepends a `# Memory\n- <name>: <preview>` block to the
static system prefix. The agent can `read_memory` for the full file.

## Testing strategy

- `memory-files/src/index.test.ts`: round-trip read/write, missing
  file error, search ordering, snippet centering, name validation.
- The server's system-prompt injection is tested via the messages
  route in `packages/server/src/app.test.ts` (added in
  [[phase-05-server|Phase 5]]).

## Risks & mitigations

| Risk                                       | Mitigation                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Directory escape via crafted `name`        | `write` validates against `[A-Za-z0-9._-]+` and rejects `..`, `/`, `\\`.    |
| Index drift after external edits           | `mtime`-based rebuild on first `list()` after a missing/stale index.        |
| Large `root` slows down `list`             | v1 assumption: < 100 notes per user. If breached, swap the index rebuild for a real watcher. |