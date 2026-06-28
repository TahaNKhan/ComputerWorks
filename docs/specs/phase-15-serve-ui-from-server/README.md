# Phase 15 — Serve UI from server

**Status:** done
**Started:** 2026-06-28
**Done:** 2026-06-28

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (worked on `main` directly)

## Pointers
- **Tasks:** T15.1, T15.2, T15.3 in `TASKS.MD`
- **PR / merge commit:** three commits on `main`:
  `11d1feb` (T15.1), `869290b` (T15.2), the T15.3 doc commit
- **Related specs:** [[phase-07-ui]] (the UI being served), [[phase-05-server]] (the server doing the serving)

## Why isolated

The original dev workflow ran two processes (Fastify on
`127.0.0.1:4747`, Vite on `localhost:5173`) with a CORS
allowlist covering both origins. In production the Vite build was
configured but never invoked — there was no path from
`bun run start` to a working browser session. This phase unifies
them: the Fastify server serves the built UI bundle from
`packages/ui/dist-app/` via `@fastify/static`. One process, one
port, one URL in the browser bar.

The user chose **build-then-serve** over Vite middleware mode.
Vite becomes a build-only tool (no dev server, no proxy); the
cost is no HMR (UI iteration requires a rebuild and refresh),
the win is a cleaner dependency tree and one deployment artifact.