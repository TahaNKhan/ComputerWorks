# Phase 12 — URL-routable sessions + LLM-generated titles

**Status:** done
**Started:** 2026-06-26
**Done:** 2026-06-26

## Isolation
- **Branch:** `phase/12-url-and-titles` (folded into `phase/auto`, then
  into `main` after Phase 14)
- **Worktree:** n/a

## Pointers
- **Tasks:** T12.1, T12.2 in `TASKS.MD`
- **PR / merge commit:** merged via `phase/auto` → `main`
- **Related specs:** [[phase-07-ui]] (the UI consuming the URL), [[phase-05-server]] (the title generator)

## Why isolated

Two UX asks that go together: the sidebar's session id should be
shareable via URL (so a user can bookmark or share a session), and
the session title should auto-generate from the first turn instead of
staying blank or "(untitled)". They share a phase because both touch
the session list state and the message-route handoff.

## Design notes

### T12.1 — Frontend URL sync

`packages/ui/src/lib/router.ts` exposes three pure helpers:

- `getSessionFromUrl()` — read `?session=<id>` from the current URL.
- `setSessionInUrl(id | null)` — write via `pushState` so the browser
  back button walks session history.
- `subscribeUrlChange(cb)` — `popstate`-driven; calls `cb` on browser
  back/forward.

On app boot: `getSessionFromUrl()` reads the param; if it names a real
session in the loaded list, that becomes the active session. If it
names an unknown id, the param is cleared and an error toast surfaces.
`switchSession(id)` writes the new id via `pushState`. `popstate`
updates `activeSessionId` accordingly. Visiting `/` with no param
shows the empty state.

The router is pure URL ↔ string — `packages/ui/src/main.tsx` wires it
to the store on mount, and `packages/ui/src/store/sessions.ts` calls
`setSessionInUrl` from `switchSession` and reads it in initialization.

### T12.2 — Backend LLM-generated titles

`packages/server/src/title-generator.ts` reads the first user message
+ first assistant text from the store, calls `provider.chat` once with
a "summarize as 3–5 word title" prompt, sanitizes the result (strip
quotes/whitespace, truncate to 80 chars), and PATCHes `meta.title`.

- Skipped entirely if `meta.title` is already non-empty (manual rename
  or `createSession({ title })`).
- Failures (LLM error, no messages yet) are logged and swallowed — the
  user experience never blocks on a title.
- On success: emits a `session_renamed` SSE event on the session's
  stream with `{ sessionId, title }`. The UI reducer updates the
  session in `sessions` and (if it's the active one) the meta header.

The title generator is a thin wrapper around `provider.chat`; the
title-sanitization helper is unit-tested in isolation.
