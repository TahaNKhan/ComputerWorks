# Phase 15 — Requirements

## Purpose

Eliminate the separate Vite dev server. The Fastify server serves
the built UI bundle from `packages/ui/dist-app/` via
`@fastify/static`, so the user runs one process and visits one URL
in the browser.

## Users / actors

- **The user** — runs `bun run build && bun run start` and opens
  `http://127.0.0.1:4747`. Same UI, same flow, one less terminal.
- **The UI** — served from the same origin as the API; no CORS
  round-trip, no Vite proxy.
- **The server** — gains static-file serving and a CLI flag for the
  UI bundle path.

## Functional requirements

### Server-side wiring

- FR-1. `buildApp({ config, uiRoot })` accepts an optional `uiRoot`
  string. When provided, the app registers `@fastify/static` and a
  `GET /` fallback that returns `index.html`.
- FR-2. `uiRoot` defaults to `<workspace>/packages/ui/dist-app`,
  resolved relative to `start.ts` (not cwd) so the value is correct
  whether the user invokes the server via `bun run start` or
  `bun run --filter @computerworks/server start`.
- FR-3. `start.ts` accepts `--ui-root=<path>` to override the default.
- FR-4. `start.ts` validates the resolved `uiRoot` exists at startup
  and fails fast with a clear error (`Run \`bun run build\` first.`)
  if it doesn't.
- FR-5. `GET /` returns `index.html` (`text/html`). `GET /assets/*`
  returns the matching asset. `GET /api/*` continues to return JSON —
  no path conflict.
- FR-6. When `uiRoot` is omitted, `buildApp` still returns a working
  app (just no static files). All existing tests pass unchanged.

### Build pipeline

- FR-7. `packages/ui/package.json` `build` is `tsc -b && vite build`,
  emitting both `dist/` (TypeScript) and `dist-app/` (Vite bundle).
- FR-8. `packages/ui/vite.config.ts` has no `server` block (no dev
  server, no proxy); `emptyOutDir: true` so stale assets don't ship.
- FR-9. `packages/ui/package.json` has no `dev` or `start` scripts
  (those were Vite dev-server aliases).
- FR-10. Root `build` chains `tsc -b` and the UI build so a single
  `bun run build` produces the full distributable.
- FR-11. Root `dev` is `bun run build && bun run start`.
- FR-12. Root `dev:watch` runs the Vite `--watch` and `bun --watch`
  in parallel; UI rebuilds on change, server restarts on change.

### CORS

- FR-13. CORS allowlist unchanged (still permissive for loopback +
  private LAN ranges). Same-origin requests from the UI bypass CORS
  automatically; the allowlist remains in place for any external
  client.

## Non-functional requirements

- One process, one port (`127.0.0.1:4747` by default).
- No new dependencies beyond `@fastify/static` (same vendor as the
  existing `@fastify/cors` / `@fastify/sensible`).
- `bun run typecheck && bun test` must remain green.
- `dist-app/` is gitignored (it's a build artifact).
- The smoke checklist (`docs/specs/phase-08-e2e-verification/ui-smoke.md`)
  passes against the new single-port flow.

## Out of scope

- HMR / Vite middleware mode (the user chose build-then-serve).
- A separate `dev` workflow that runs Vite on a different port.
- Server-side rendering of the React app.
- Multi-page UI (the router uses query-string routing, not paths —
  no `/*` catch-all needed).
- Sub-resource Integrity / Content-Security-Policy headers (future
  hardening).

## Constraints

- `@fastify/static` is the same vendor as the existing Fastify
  plugins — MIT-licensed and in the allowlist.
- No changes to the wire protocol; SSE, approvals, and the
  per-message stream are unchanged from
  [[../phase-14-per-message-sse|Phase 14]].

## Acceptance criteria

- `bun run typecheck` is green.
- `bun test` is green (274 existing + 5 new static-serving tests).
- `bun run build` produces `packages/ui/dist-app/index.html` and
  `packages/ui/dist-app/assets/*.js`.
- `bun run --filter @computerworks/server start --port=4749` boots
  and serves:
  - `GET /` → `200 text/html` with the index body
  - `GET /assets/index-*.js` → `200` with the JS bundle
  - `GET /api/health` → `200` with `{"ok":true}`
- `bun run start` from a stale checkout (no `dist-app/`) fails
  with a clear error message.
- No `localhost:5173` references in tests or docs (except as a
  historical note in `phase-07-ui/design.md`).

## Open questions

None at acceptance.