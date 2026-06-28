# Phase 8 — Requirements

## Purpose

Prove the system works end-to-end against the real server. Three
artifacts:

1. **`scripts/e2e.ts`** — automated smoke runner, excluded from
   `bun test` because it boots a real server.
2. **`docs/specs/phase-08-e2e-verification/ui-smoke.md`** — the
   human-driven UI checklist.
3. **`README.md`** — the user-facing manual (install / run /
   configure / troubleshoot).

## Users / actors

- **CI / cron** — runs `bun run test:e2e` to verify the build
  doesn't regress on the wire protocol.
- **The user** — runs the UI smoke checklist after `bun install` to
  confirm the browser-side flow works against their real server.
- **A new contributor** — reads the README to learn how to install
  and run the system.

## Functional requirements

### `scripts/e2e.ts`

- FR-1. Boots the real server on an ephemeral port with
  `ScriptedProvider` and `AutoApprover`.
- FR-2. Sends a message, consumes the SSE stream, asserts the
  shell tool was called and the transcript was persisted.

### `docs/specs/phase-08-e2e-verification/ui-smoke.md`

- FR-3. A written checklist covering: prerequisites, boot sequence,
  session lifecycle, shell tool flow, file read tool flow, theme +
  shortcuts, multi-session isolation, streaming cancellation,
  settings, cleanup.
- FR-4. Each step has a single checkbox `[ ]` and a stable
  identifier (e.g. `(S1)`) for bug reports.

### `README.md`

- FR-5. Sections: install, run, configure, memory notes,
  troubleshoot, architecture (pointer), development.

## Non-functional requirements

- **Performance**: first token to UI in < 500 ms after send on
  local; UI remains interactive during streaming (no main-thread
  block > 50 ms).
- **Reliability**: agent loop resumes cleanly after a tool
  rejection, network blip, or user abort.
- **Observability**: structured logs to stderr (JSON), no log file
  by default; `--verbose` adds request/response debug.
- **Tests**: unit tests for the agent loop, approval logic,
  provider overrides, path-traversal guards; integration test for
  end-to-end shell + approval flow with a stubbed provider.
- **Type safety end-to-end**: `Provider` types flow from `core`
  through `server` to the UI; no `any` in the public API.
- **Licensing**: MIT, dependencies all MIT/Apache-2.0/BSD-compatible.

## Security & safety

- Backend binds to `127.0.0.1` only by default. Binding to other
  interfaces requires an explicit config flag and emits a startup
  warning.
- CORS locked to `http://localhost:<vite-port>` and
  `http://127.0.0.1:<server-port>`.
- No API keys in plaintext on disk by default; read from env, with
  plaintext-file fallback that emits a startup warning.
- **Path traversal protection**: file tools resolve paths and
  reject anything escaping the session cwd, unless the session is
  configured with explicit additional allowed roots.
- **Shell execution**: the `run_shell` tool takes a single command
  string, not argv. The system prompt tells the agent to prefer
  safe single-string commands. We do **not** attempt to
  "shell-quote" agent-supplied input — we surface what the agent
  wants to run and let the user decide.
- **No auto-execution** of any tool that mutates state without
  approval.
- **Tool output sanitization**: stdout/stderr from shell is
  rendered in the UI in a code block, not interpreted as markdown.
- **Configurable command denylist** (e.g. `rm -rf /`, `format c:`)
  — server refuses to run these and returns an error to the agent.

## Out of scope

- Visual regression tests.
- Load testing.
- Penetration testing (the surface is small and the user is the
  only attacker).

## Acceptance criteria

- `bun run test:e2e` is green on a fresh clone.
- The UI smoke checklist can be ticked through against the real
  server without intervention.
- The README covers the canonical user journey.

## Open questions

None at acceptance.