# Phase 14 — Per-message SSE + UI rewrite

**Status:** done
**Started:** 2026-06-28
**Done:** 2026-06-28

## Isolation
- **Branch:** `phase/14-sse-and-ui`
- **Worktree:** n/a (folded into `main` after merge)

## Pointers
- **Tasks:** T14.1, T14.2, T14.3, T14.4 in `TASKS.MD`
- **PR / merge commit:** merged from `phase/14-sse-and-ui` into `main`
  on 2026-06-28
- **Related specs:** [[phase-05-server]] (the original wire protocol being replaced), [[phase-07-ui]] (the imperative consumer being replaced)

## Why isolated

The Phase 5/7 architecture held two long-lived SSE channels open per
session — one per browser tab — and made the agent loop a background
side-effect of `POST /messages`. That worked for one user with one
tab, but it can't scale to multiple concurrent conversations on the
same session (each new tab fights for the same broadcast queue), it
can't reliably multiplex approvals and tool events across streams,
and the frontend reducer entangled event merging with store actions so
the UI felt jittery on every token burst.

Phase 14 simplifies the wire model end-to-end and rewrites the UI
around a pure reducer. It is the largest single architectural change
in the build and was deliberately isolated so the merge could be
audited in one PR.