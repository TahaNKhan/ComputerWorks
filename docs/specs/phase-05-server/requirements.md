# Phase 5 — Requirements

## Purpose

Wire every prior package behind a Fastify HTTP server: configuration,
session storage, audit log, SSE streaming, approval sub-flow, route
surface, and CLI bootstrap. The server is the only process that
talks to the LLM provider, the only one that holds state, and the
only one that the UI talks to.

## Users / actors

- **The UI** — talks to the server over HTTP + SSE.
- **The agent loop** — runs inside the server process.
- **The provider** — called from inside the server.
- **The user** — edits `~/.computerworks/config.ts` and the memory
  directory.
- **The OS** — the server binds to a port and writes to
  `~/.computerworks/`.

## Functional requirements

### Config loader (`packages/server/src/config.ts`)

- FR-1. Loads `~/.computerworks/config.ts` via `jiti`.
- FR-2. Validates with the schema documented in the design.
- FR-3. Applies env overrides (`COMPUTERWORKS_*`) on top of the file
  config.
- FR-4. Fails fast with a useful error on bad config.
- FR-5. Defaults are schema defaults so an empty config still parses.

### Session store (`packages/server/src/session-store.ts`)

- FR-6. CRUD: `create`, `list`, `get`, `patch` (rename/cwd/model),
  `delete`.
- FR-7. `appendMessage(sessionId, message)` and
  `appendAudit(sessionId, entry)`.
- FR-8. Atomic per-line writes (`fs.appendFile` with `O_APPEND`).
  Concurrent appends are safe.
- FR-9. `meta.json` is read whole + written via tmp+rename for
  atomicity. Partial writes can't corrupt it.
- FR-10. `messages.jsonl` is never loaded whole into memory in the
  read path — callers stream it.

### Audit log (`packages/server/src/audit.ts`)

- FR-11. `appendAudit(sessionId, entry)` writes a single JSON line
  per call + decision.
- FR-12. Format: `{ ts, call: { id, name, input }, decision: {
  kind, ... } }`.

### SSE manager (`packages/server/src/sse.ts`) — pre-Phase 14

- FR-13. `SSEManager` supports multiple subscribers per session.
- FR-14. `send(sessionId, event)` frames events correctly.
- FR-15. Heartbeat at 15s on idle streams.
- FR-16. Cleanup on subscriber disconnect.
- *This whole module is replaced in [[phase-14-per-message-sse]]
  with a per-response `SSEWriter`; no `SSEManager`, no heartbeat,
  no broadcast.*

### Interactive approver (`packages/server/src/interactive-approver.ts`)

- FR-17. `InteractiveApprover(sseManager, sessionId, allowlist)`
  sends `approval_required` and waits for `POST /approve`.
- FR-18. Global + session allowlists skip the prompt and
  auto-approve (still logged).
- FR-19. Default 5-minute timeout; auto-rejects with reason on
  timeout.

### Fastify app skeleton (`packages/server/src/app.ts`)

- FR-20. `buildApp({ config })` returns a configured
  `FastifyInstance`.
- FR-21. Routes from the design §8.4 exist; non-`/stream` routes
  are `app.inject()`-tested.
- FR-22. CORS is locked to localhost + private LAN ranges (when the
  server is bound non-loopback).
- FR-23. `start()` binds to `config.server.host:port`; refuses to
  bind to non-loopback without `--allow-non-loopback` and a
  warning.

### Messages route (`packages/server/src/routes/messages.ts`)

- FR-24. `POST /api/sessions/:id/messages` with a user message
  starts `runTurn`, wires its `onEvent` into the SSE manager, and
  returns `204` once the turn is queued (or `409` if one is already
  in flight).
- *Phase 14 changes this to return `Content-Type:
  text/event-stream` directly; see [[phase-14-per-message-sse]].*

### Cancel route (`packages/server/src/routes/cancel.ts`)

- FR-25. `POST /api/sessions/:id/cancel` aborts the in-flight run
  via the per-session `AbortController`.

## Non-functional requirements

- All routes validated with `zod`; bad bodies return `400`.
- Per-message SSE response is `Content-Type: text/event-stream`;
  all other endpoints return JSON.
- Server binds only to `127.0.0.1` by default.
- Strict TypeScript, no `any` in the public API.
- `bun run typecheck && bun test` is green.

## Out of scope

- Multi-tenant / multi-user.
- TLS termination (the server is local-only).
- Vector / cloud storage backends.
- MCP server support.

## Constraints

- Single-user, single-machine.
- Filesystem-only persistence.

## Acceptance criteria

- `bun run start:dev` boots the server; `GET /api/health` returns
  `{ ok: true }`.
- All non-`/stream` routes are unit-tested with `app.inject()`.
- Path-traversal rejection works at the tool boundary.
- Denylisted shell commands are refused at the server.

## Open questions

None at acceptance (the wire-protocol questions are addressed in
[[phase-14-per-message-sse]]).