# Phase 0 — Repo scaffolding

**Status:** done
**Started:** 2026-06-24
**Done:** 2026-06-24

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T0.1, T0.2 in `TASKS.MD`
- **PR / merge commit:** commit `50b38c1`
- **Related specs:** none — this is the foundation

## Why isolated (or not)

Every later phase assumes the workspace exists. The scaffold is
mechanical: declare Bun workspaces, configure strict TypeScript, drop
in empty package directories with `tsc -b` wired up. No design
decisions to record beyond what's already in `package.json`,
`tsconfig.base.json`, `bunfig.toml`, and `.gitignore`. Tasks T0.1
and T0.2 are the full specification for this phase.
