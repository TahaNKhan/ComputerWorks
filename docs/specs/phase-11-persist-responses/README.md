# Phase 11 — Persist LLM responses to transcript

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `phase/11-persist-responses`
- **Worktree:** n/a

## Pointers
- **Tasks:** T11.1 in `TASKS.MD`
- **PR / merge commit:** merged from `phase/11-persist-responses` to `main`
- **Related specs:** [[phase-05-server]] (routes + session store), [[phase-02-agent-loop]] (the loop that owns `history`)

## Why isolated

A user noticed that the session transcript (`messages.jsonl`) only
contained the user message after a turn completed. The assistant text,
tool calls, and tool results stayed in the agent loop's in-memory
`history` and were lost on reload. SSE consumers saw the full stream,
but `GET /api/sessions/:id` returned just the user turn. A focused
fix on the messages route + the loop's persistence handoff.

## Design notes

The implementation touches two files plus a regression test:

- `packages/server/src/routes/messages.ts` — after `runTurn` resolves
  (or throws), iterate over the messages the loop appended to
  `history` and append each to `messages.jsonl` via
  `SessionStore.appendMessage`. The user message itself is still
  persisted before `runTurn` starts (no double-append).
- `packages/agent/src/loop.ts` — on provider error: the partial text
  the LLM streamed before failing is appended to `history` (so it
  gets persisted); the SSE consumer saw it, the on-disk transcript
  should too. On `AbortError`: completed iterations are persisted;
  the in-flight partial is dropped, matching the existing "partial
  message dropped" loop invariant.
- `packages/server/src/app.test.ts` — regression test asserts the
  transcript after a scripted turn contains
  `[user, assistant(tool_use), tool(tool_result), assistant(text)]`.

The loop's append invariants (already documented in
[[phase-02-agent-loop/design]]) are unchanged. The fix is at the
persistence boundary only.
