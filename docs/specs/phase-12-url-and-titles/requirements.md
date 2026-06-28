# Phase 12 — Requirements

## Purpose

Two UX gaps: (1) sessions have no shareable URL — refreshing or
sending a link drops the user on the empty state; (2) session titles
stay blank or "(untitled)" until the user manually renames them. Fix
both in one phase because they touch the same state-handoff code.

## Functional requirements

### URL-routable sessions

- FR-1. URL shape is `/?session=<id>` (query param — keeps the SPA
  pure; no Fastify SPA-fallback needed).
- FR-2. On app boot: `getSessionFromUrl()` reads the param. If it
  names a real session in the loaded list, that becomes the active
  session. If it names an unknown id, the param is cleared and an
  error toast surfaces.
- FR-3. `switchSession(id)` writes the new id via `pushState` so the
  browser back button walks the session history.
- FR-4. `popstate` (user clicking back/forward) updates
  `activeSessionId` accordingly.
- FR-5. Visiting `/` with no param shows the empty state.

### LLM-generated titles

- FR-6. After each turn, `generateTitle(deps, sessionId)` runs
  fire-and-forget: read the first user message + first assistant text
  from the store, call `provider.chat` once with a "summarize as
  3–5 word title" prompt, sanitize (strip quotes/whitespace, truncate
  to 80 chars), and PATCH `meta.title`.
- FR-7. The title generator is skipped entirely if `meta.title` is
  already non-empty (manual rename or `createSession({ title })`).
- FR-8. Failures (LLM error, no messages yet) are logged and
  swallowed — the user experience never blocks on a title.
- FR-9. On success: emit a `session_renamed` SSE event with
  `{ sessionId, title }`. The UI reducer updates the session in
  `sessions` and (if it's the active one) the meta header.

## Non-functional requirements

- No new dependencies.
- The router is pure URL ↔ string — unit-tested without a DOM where
  possible, with a `popstate` mock where not.
- Title generation does not block the user response.
- `bun run typecheck && bun test` must remain green.

## Out of scope

- Custom URL paths (e.g. `/s/<slug>`).
- Path-based routing (no SPA-fallback).
- A configurable title-generation prompt.
- Title regeneration on user request (manual rename is the only
  path to re-title).

## Constraints

- Query-param routing (not path-based) — keeps it a pure SPA and
  avoids needing Fastify SPA-fallback configuration.

## Acceptance criteria

- Unit test for the URL helpers in
  `packages/ui/src/store/sessions.test.ts` covers get / set /
  popstate / unknown-id clears param.
- Unit test for the title sanitizer covers edge cases (quotes,
  leading whitespace, > 80 chars, non-ASCII).
- Server test asserts the title PATCH happens and the
  `session_renamed` SSE event is emitted.
- Manual: opening a fresh `/?session=<id>` in a new tab loads the
  right session; back/forward navigates between sessions.

## Open questions

None at acceptance.
