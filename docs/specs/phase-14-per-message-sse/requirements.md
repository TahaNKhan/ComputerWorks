# Phase 14 — Requirements

## Purpose

Replace the persistent SSE model (one long-lived `GET /stream` per
tab, broadcast manager on the server, imperative SSE consumer in the
UI) with a simpler shape: `POST /messages` opens its own SSE
response, the agent runs synchronously while the response is open,
the response closes when the turn ends. Multiple concurrent
conversations on the same session become safe because each request
owns its own stream. The UI is rewritten around a pure reducer so
every state transition is testable without rendering a component.

## Functional requirements

### T14.1 — POST /api/sessions/:id/messages opens SSE directly

- FR-1. `POST /api/sessions/:id/messages` returns `Content-Type:
  text/event-stream`, streams `message_start` / `token` /
  `tool_call` / `tool_result` / `approval_required` /
  `session_renamed` / `message_done` / `done` / `error` frames in
  order as the agent runs, and closes the stream after the terminal
  `done` (or `error`) frame.
- FR-2. Multiple in-flight requests on the same session are NOT
  rejected — each gets its own SSE channel and its own
  `SessionRuntime`. The previous "409 if busy" guard is removed in
  favor of "each request owns its turn end-to-end".
- FR-3. `InteractiveApprover` writes events through a `SSEWriter`
  interface (the per-request response writer) instead of an
  `SSEManager`. The `/approve` route handler holds the
  `(requestId → resolver)` map for the duration of one turn.
- FR-4. The `SSEManager` class, its subscriber/heartbeat machinery,
  and `routes/stream.ts` are deleted.

### T14.2 — Pure reducer for SSE events

- FR-5. `reduceStreamEvent(state, ev): SessionsState` is a pure
  function — no I/O, no side effects, no React. It takes the current
  `SessionsState` and one `ServerEvent` and returns the next
  `SessionsState`.
- FR-6. The reducer is the single source of truth for every event
  branch (`message_start`, `token`, `tool_call`, `tool_result`,
  `approval_required`, `message_done`, `session_renamed`, `done`,
  `error`). It does NOT call the API or update the URL — those stay
  in the store's action methods.
- FR-7. The store's `applyServerEvent` action becomes a one-liner:
  `set((s) => reduceStreamEvent(s, ev))`.

### T14.3 — UI rewrite: mobile-first, thin components

- FR-8. `App.tsx` is a thin composition root: header + main +
  modals. No event-handling logic, no store mutation.
- FR-9. Components are presentational: each one takes typed props
  and calls selectors via the store. No `useState` outside the
  composer (draft text) and the settings dialog (form state).
- FR-10. `SessionList` is a pure renderer over the store's
  `sessions: SessionMeta[]`. Switch / rename / delete actions are
  bound to store actions, not implemented in the component.
- FR-11. `Composer` is the only place that holds local form state
  (the draft). Submit calls `sendMessage`; the store opens SSE,
  consumes events through the reducer, and the chat view updates
  declaratively.
- FR-12. `ChatView` / `MessageList` / `Message` read messages from
  the store and render them. No streaming awareness in the JSX.
- FR-13. `ApprovalCard` reads `pendingApproval` from the store and
  dispatches `decideApproval`.
- FR-14. CSS is mobile-first: a single column at < 768 px, two
  columns at 768–1023 px, three columns at ≥ 1024 px. Tap targets
  are ≥ 44 px; the composer respects `env(safe-area-inset-bottom)`.
- FR-15. `Cmd/Ctrl+K`, `Cmd/Ctrl+Enter`, `Esc`, `Cmd/Ctrl+,`
  shortcuts still work and are tested via the existing shortcut
  tests.

### T14.4 — Tests, docs, ship

- FR-16. All existing tests still pass. New reducer tests cover every
  event branch and every helper.
- FR-17. `README.md` "Architecture" section is updated to describe
  per-message SSE.
- FR-18. `CLAUDE.md` "Phase status" reflects Phase 14 done.

## Non-functional requirements

- The new architecture must support multiple concurrent
  conversations on the same session safely.
- No event-handling logic in JSX. The reducer is the single source
  of truth for SSE → state.
- `bun run typecheck && bun test` is green.

## Out of scope

- Cross-session tool calls (one session asking another).
- Multi-tab session sync (the per-message SSE shape makes it
  trivially safe at the wire layer; the remaining work is in the
  UI store and is not Phase 14).
- Edit-and-resend flow.
- Vector-backed memory.
- MCP server support.

## Constraints

- No new runtime dependencies.
- The UI build remains independent of the server packages (wire
  types duplicated in `packages/ui/src/api/types.ts`).

## Acceptance criteria

- All FRs above pass.
- Multiple in-flight `POST /messages` on the same session each get
  their own SSE channel; concurrent turns interleave on
  `messages.jsonl` (the desired behavior).
- A `done` (or `error`) frame is the connection-close marker;
  clients may treat the response stream as terminated on `done`.
- `bun run typecheck && bun test` is green.

## Open questions

None at acceptance.