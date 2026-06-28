# Phase 4 — Requirements

## Purpose

Let the agent persist facts across sessions — user preferences,
project facts, recurring gotchas — in a way the user can read,
search, edit, and audit. The v1 implementation is plain markdown
files under `~/.computerworks/memory/notes/` plus a cached index.
A `MemoryProvider` interface reserves the seam for a future vector
backend without rewriting the agent.

## Users / actors

- **The agent** — reads, lists, and searches notes via the four
  memory tools.
- **The user** — edits notes directly (`bun run memory edit`) or
  via the agent (with approval).
- **The server** — injects a compact directory listing into every
  system prompt.

## Functional requirements

### Storage layout

- FR-1. Notes live at `<root>/notes/<name>.md`.
- FR-2. A cached listing lives at `<root>/index.json`.
- FR-3. Note names use kebab-case (`user-preferences`,
  `project-acme-architecture`).
- FR-4. `write` refuses names that escape `root` — rejects `..`,
  `/`, `\\`, and any character outside `[A-Za-z0-9._-]`.

### `MemoryProvider` interface

- FR-5. `list()` returns `{ name: string; preview: string }[]`.
- FR-6. `read(name)` returns the full file content.
- FR-7. `write(name, content)` writes or overwrites the note.
- FR-8. `delete(name)` removes the note.
- FR-9. `search(query)` returns `{ name, snippet }[]` (top-10).

### Search behavior (v1)

- FR-10. `search` is case-insensitive substring + filename match.
- FR-11. Results include a ±60-char snippet around the match.

### Tools exposed to the agent

- FR-12. `read_memory(name)` — read a memory file. No approval.
- FR-13. `write_memory(name, content)` — write/overwrite. Approval-gated.
- FR-14. `list_memory()` — list available notes. No approval.
- FR-15. `search_memory(query)` — substring + filename search. No approval.

### System-prompt injection

- FR-16. The server's `system-prompt.ts` calls `memory.list()` once
  per turn and injects a compact directory (`# Memory\n- <name>:
  <preview>`) into the system prompt. The agent can `read_memory`
  for full content.

### Agent behavior

- FR-17. The system prompt instructs the agent that it may write to
  memory when it learns something likely useful across sessions
  (preferences, recurring project facts).

## Non-functional requirements

- Index rebuilds from disk on first call after a fresh `root`.
- Round-trip read/write/search is unit-tested.
- Missing-file handling is clean (returns a useful error, not a
  crash).
- `bun run typecheck && bun test` is green.

## Out of scope

- Vector embeddings / similarity search (the interface is the seam;
  v2 picks a store and writes the adapter).
- Memory compaction, archiving, or per-session scoping.
- Multi-user isolation (single-user in v1).
- Encrypted-at-rest notes.

## Constraints

- Filesystem-only. No external services.
- Storage root is configurable via `~/.computerworks/config.ts`.

## Acceptance criteria

- Unit tests cover: round-trip read/write, missing-file error,
  search ordering and snippet centering, name validation
  (rejection of `..`, `/`, `\\`, non-`[A-Za-z0-9._-]`).
- `bun run memory ls`, `bun run memory show <name>`, `bun run memory
  edit <name>` all work (added in [[phase-06-cli|Phase 6]]).

## Open questions

None at acceptance.