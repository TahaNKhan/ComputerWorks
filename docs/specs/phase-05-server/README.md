# Phase 5 — Server

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T5.1, T5.2, T5.3, T5.4, T5.5, T5.6, T5.7, T5.8 in `TASKS.MD`
- **PR / merge commit:** commits `c5d…`, `c5d…`, `c5d…` (see TASKS.MD)
- **Related specs:** [[phase-01-core-and-provider]], [[phase-02-agent-loop]], [[phase-03-tools]], [[phase-04-memory]]

## Why isolated (or not)

The server is the integration point: it consumes every package from
phases 1–4 and exposes them over HTTP. Phase 5 ships the original
wire protocol (persistent SSE per session, `SSEManager`,
`/api/sessions/:id/stream`, `409` on busy). The Phase 14 rewrite
replaces this with per-message SSE; see [[phase-14-per-message-sse]]
for the post-rewrite shape.