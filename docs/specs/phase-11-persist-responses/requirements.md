# Phase 11 — Requirements

## Purpose

After a turn completes, the on-disk transcript must contain every
message the agent saw during the turn — not just the user message
that started it. This makes `GET /api/sessions/:id` useful for
reload, debugging, and export, and matches what the SSE consumer
already saw during the turn.

## Functional requirements

- FR-1. After `runTurn` completes (or throws), every new message the
  loop appended to `history` is also written to `messages.jsonl` via
  `SessionStore.appendMessage`.
- FR-2. The user message itself is still persisted before `runTurn`
  starts — no double-append.
- FR-3. On provider error: the partial text the LLM streamed before
  failing is appended to `history` and therefore persisted. The
  in-flight message is finalized with whatever text streamed.
- FR-4. On `AbortError` (user cancel): completed iterations are
  persisted; the in-flight partial is dropped, matching the existing
  loop invariant that a cancelled message leaves no orphan.
- FR-5. Persistence order matches append order — `messages.jsonl`
  reflects the timeline the SSE consumer saw.

## Non-functional requirements

- No new dependencies.
- The existing per-line atomic write (`fs.appendFile` with
  `O_APPEND`) is sufficient. No batching needed in v1.
- `bun run typecheck && bun test` must remain green.

## Out of scope

- Transcript compaction (`computerworks compact`).
- Streaming writes (we still finish one turn, then flush).
- A database. Files are fine for v1.

## Constraints

- The fix is at the persistence boundary. The agent loop's append
  invariants stay the same.

## Acceptance criteria

- Regression test in `packages/server/src/app.test.ts` asserts the
  transcript after a scripted turn contains
  `[user, assistant(tool_use), tool(tool_result), assistant(text)]`.
  Fails before the fix, passes after.
- A real turn with a tool call, opened via `GET /api/sessions/:id`,
  shows the full transcript (user + assistant tool_use + tool result
  + final assistant text).

## Open questions

None at acceptance.
