# Phase 9 — MiniMax auth fix (LAN deployment followup)

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `phase/9-minimax-auth`
- **Worktree:** n/a

## Pointers
- **Tasks:** T9.1 in `TASKS.MD`
- **PR / merge commit:** commit `041c0aa` on `phase/9-minimax-auth`
- **Related specs:** [[phase-01-core-and-provider]] (the provider that reads these env vars)

## Why isolated

A LAN device got `401 Invalid bearer token` from the MiniMax endpoint
because three config defaults were pointing at real Anthropic
(`baseUrl: https://api.anthropic.com`, `defaultModel:
claude-sonnet-4-6`, and the API key being read from `ANTHROPIC_API_KEY`
instead of `MINIMAX_TOKEN`). The fix is one env-var change, but it
touches the provider construction, the config loader's defaults, and
the `.env.example` shim, so it earned its own branch.

## Design notes

The implementation is fully documented in the code:

- `packages/core/src/providers/anthropic.ts` — reads `MINIMAX_TOKEN`,
  `MINIMAX_BASE_URL`, `MINIMAX_DEFAULT_MODEL`; default model
  `MiniMax-M3`; uses Bearer auth (`authToken`) instead of `x-api-key`
  because MiniMax's Anthropic-compatible endpoint expects Bearer.
  Scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` before
  constructing the SDK client so the wrong env can't leak through.
- `.env.example` — documents the new env-var names.
- `.env` — local-only secrets (gitignored).
- `bunfig.toml` and `package.json` scripts — `bun --env-file=.env`
  plumbs the env into the server and the e2e smoke.
