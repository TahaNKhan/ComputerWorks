# Phase 8 — End-to-end verification

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T8.1, T8.2, T8.3 in `TASKS.MD`
- **PR / merge commit:** see `git log`
- **Related specs:** [[phase-05-server]] (the runtime being verified), [[phase-07-ui]] (the surface being verified)

## Why isolated (or not)

E2E verification is a vertical of its own — a scripted smoke runner
plus a human-driven UI checklist plus the first pass of the README.
Splitting it off lets verification be tightened independently of any
later feature work. The manual UI checklist is the most important
human check in the system.