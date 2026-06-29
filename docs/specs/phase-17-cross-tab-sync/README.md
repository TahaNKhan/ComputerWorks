# Phase 17 — Cross-tab session sync

**Status:** in-progress
**Started:** 2026-06-28
**Done:** (not yet)

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T17.1 (scope — done), T17.2 (server), T17.3 (UI),
  T17.4 (smoke + ship) in `TASKS.MD`
- **PR / merge commit:** (forthcoming)
- **Related specs:** [[phase-14-per-message-sse]] (defines the
  per-message SSE that this phase complements),
  [[phase-15-serve-ui-from-server]] (the static-UI hosting layer that
  this phase runs alongside).

## Why isolated

Phase 14 specifically replaced the pre-Phase 14 broadcast manager
(`SSEManager`) with per-message SSE — one POST = one stream, no
fanout. Phase 17 re-introduces fanout, but only for a carefully
scoped set of state-change events (NOT per-turn lifecycle), and
in a way that keeps the per-message SSE's job intact:

- The per-message SSE keeps streaming live tokens / message_start /
  tool_call / done to the leader.
- A new central SSE carries only `message_appended`,
  `session_renamed`, `session_meta_updated`, `approval_required`,
  `tool_result`, `message_done`, `error`.
- A SharedWorker per origin owns the central SSE connection and
  fan-outs events to its connected tabs via `MessageChannel`.

This separation means the two streams never carry the same event
type — the leader never sees the same event twice. The user's brain
dump ("background JS worker on the browser?") pointed at this
shape; the plan document captures the architectural reasoning.