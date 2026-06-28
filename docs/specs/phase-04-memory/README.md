# Phase 4 — Memory provider

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T4.1 in `TASKS.MD`
- **PR / merge commit:** commit `6d30203`
- **Related specs:** [[phase-01-core-and-provider]] (the `ToolDefinition` shape), [[phase-05-server]] (where the system prompt injects the directory listing)

## Why isolated (or not)

Memory is a vertical of its own: a `MemoryProvider` interface (the
reserved seam) plus the v1 file implementation. Splitting it off lets
the server consume a stable interface while a future vector backend
is built behind it. The agent only sees `read_memory`,
`write_memory`, `list_memory`, `search_memory` — the file backend
is hidden behind those four tool definitions.