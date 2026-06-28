# Phase 1 — Core types and Provider interface

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T1.1, T1.2, T1.3, T1.4 in `TASKS.MD`
- **PR / merge commit:** commit `a4fce1a`
- **Related specs:** none — this phase is the dependency root for [[phase-02-agent-loop]], [[phase-05-server]], [[phase-09-minimax-auth]]

## Why isolated (or not)

`packages/core` is the foundation: every other package depends on it
for types and the `Provider` interface. Splitting it off first made
the later phases buildable incrementally — once T1.1 lands, the agent
loop and the tool packages can compile against a frozen type contract.
