# Phase 6 — CLI

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T6.1, T6.2 in `TASKS.MD`
- **PR / merge commit:** see `git log` (small, single-feature)
- **Related specs:** [[phase-05-server]] (the runtime), [[phase-04-memory]] (memory commands)

## Why isolated (or not)

The CLI is thin glue between the user and the server / session store
/ memory provider. It earned its own phase so the `computerworks`
binary could be packaged and tested independently from the server
process — and so the binary's argument surface could be designed
without dragging server changes along.