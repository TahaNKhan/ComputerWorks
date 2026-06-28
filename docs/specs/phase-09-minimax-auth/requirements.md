# Phase 9 — Requirements

## Purpose

A LAN user got `401 Invalid bearer token` from MiniMax on first
connection. Root cause: the Anthropic provider's defaults pointed at
real Anthropic (`api.anthropic.com`, `claude-sonnet-4-6`, env var
`ANTHROPIC_API_KEY`), not at MiniMax's Anthropic-compatible endpoint.
The fix re-points the defaults and adds `.env` support so the LAN
deployment works out of the box.

## Functional requirements

- FR-1. Default `baseUrl` is `https://api.minimax.io/anthropic` (not
  Anthropic's real URL).
- FR-2. Default model is `MiniMax-M3` (not `claude-sonnet-4-6`).
- FR-3. API token is read from `MINIMAX_TOKEN` (not
  `ANTHROPIC_API_KEY`).
- FR-4. Authorization header is `Bearer <token>` (not `x-api-key`).
- FR-5. The provider scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
  from the process env before constructing the SDK client, so a stale
  shell export can't leak through.
- FR-6. `.env.example` is committed and documents the env-var names.
- FR-7. `bun run start` and `bun run test:e2e` both load `.env`
  (`bun --env-file=.env`) so a user with a `.env` doesn't need to
  export manually.

## Out of scope

- A runtime model picker (added in Phase 7 via the settings dialog).
- A multi-provider config (Anthropic-compatible is the only supported
  shape in v1).
- A setup wizard. The README is the wizard.

## Constraints

- The change is the smallest possible diff that fixes the LAN
  deployment. No provider-shape changes, no SDK upgrades.

## Acceptance criteria

- A fresh clone with `.env` containing `MINIMAX_TOKEN=...` boots the
  server and answers a real `messages.stream()` call against
  `api.minimax.io`.
- A shell with `ANTHROPIC_API_KEY=sk-...` set in the environment
  still works (scrubbing happens, MiniMax token wins).
- `bun run test:e2e` is green on the LAN device.

## Open questions

None at acceptance.
