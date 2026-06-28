# Phase 2 — Agent loop

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T2.1, T2.2, T2.3 in `TASKS.MD`
- **PR / merge commit:** commit `7c9a016`
- **Related specs:** [[phase-01-core-and-provider]] (the `Provider` and `StreamEvent` this phase consumes)

## Why isolated (or not)

The agent loop is the heart of the system — the `Provider` and
`ToolDefinition` types are enough to build it, but nothing else in
the system can be wired up until it exists. Building it second (after
[[phase-01-core-and-provider]]) keeps the dependency graph strictly
acyclic and lets the loop be unit-tested with the scripted provider
from day one.
