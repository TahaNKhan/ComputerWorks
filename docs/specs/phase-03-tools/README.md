# Phase 3 — Tools

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T3.1, T3.2 in `TASKS.MD`
- **PR / merge commit:** commit `6d30203`
- **Related specs:** [[phase-01-core-and-provider]] (`ToolDefinition`), [[phase-02-agent-loop]] (`ToolRegistry`)

## Why isolated (or not)

Tools are the agent's hands. They depend on the `ToolDefinition`
contract from [[phase-01-core-and-provider]] and are registered into
the `ToolRegistry` from [[phase-02-agent-loop]], but they are
otherwise self-contained. Splitting them into a dedicated phase
(`tools-shell` + `tools-files`) keeps each package's blast radius
small and lets the safety surface (`run_shell` + the path-traversal
guard) be audited independently.