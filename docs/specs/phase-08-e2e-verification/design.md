# Phase 8 — Design

## End-to-end smoke (`scripts/e2e.ts`)

The e2e runner is intentionally **excluded** from `bun test` —
booting a real server is slow and pollutes global state. It runs
explicitly via `bun run test:e2e`.

The runner:

1. Loads the config (with overrides for an ephemeral port).
2. Builds the app via `buildApp({ config })` (same code path the
   real server uses, minus `listen`).
3. Calls `app.listen({ port: 0, host: '127.0.0.1' })` and grabs
   the assigned port.
4. Injects a scripted `Provider` that returns a fixed sequence of
   `StreamEvent`s (one assistant message that calls `run_shell`,
   then a final assistant message).
5. Injects an `AutoApprover` that approves everything.
6. Sends `POST /api/sessions/:id/messages` with a user message.
7. Consumes the SSE stream (post-Phase 14) or polls
   `GET /api/sessions/:id` (pre-Phase 14) until the run completes.
8. Asserts:
   - The transcript on disk contains the expected
     `[user, assistant(tool_use), tool(tool_result), assistant(text)]`
     sequence ([[phase-11-persist-responses|Phase 11]] regression).
   - The `audit.jsonl` contains the `run_shell` decision.
9. Tears down the server and exits.

## UI manual smoke checklist

See [`ui-smoke.md`](ui-smoke.md) — a tick-through checklist for a
human running the real UI against the real server. This is the most
important human check in the system; every release candidate should
have a fresh pass.

## Build / install / dev workflow

- `bun install` — installs all workspaces.
- `bun run typecheck` — `tsc --noEmit` across workspaces.
- `bun run test` — `bun test` everywhere.
- `bun run dev` — runs `server` and `ui` in parallel (the `ui` dev
  server proxies `/api` to the `server` port).
- `bun run build` — builds all packages (`tsc -b` for libraries,
  `vite build` for the UI).
- `bun run start` — `computerworks serve` against the built output.
- `bun run start:dev` — same as `dev` but with file watching.

## Failure modes and how we handle them

| Failure                              | Handling                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Provider 4xx/5xx                     | Surface as `error` SSE event; partial assistant msg dropped; user retries |
| Tool call exceeds iteration cap      | Synthetic `tool_result` with `is_error: true`; loop terminates           |
| Tool execution throws                | Caught, returned as `tool_result` with `is_error: true`; agent recovers  |
| User aborts mid-tool                 | `AbortSignal` cancels the child process and the provider stream          |
| Approval request times out           | Default: 5 minutes; auto-rejects with reason "approval timed out"        |
| Disk full on append                  | Caught at write time, surfaced as `error`, no partial commit             |
| Stale `EventSource` reconnect        | Client sends `Last-Event-ID`; server replays from `audit.jsonl`          |
| Shell command in denylist            | Refused at server, returned as tool error to the agent                   |
| Path traversal attempt               | Refused at tool boundary with a clear error                             |