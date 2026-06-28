# Phase 7 — Requirements

## Purpose

Build a React + Vite SPA that talks to the server over HTTP + SSE.
The UI is mobile-first, presents the chat transcript, streams
tokens in real time, renders markdown with syntax highlighting,
shows tool calls inline, and prompts the user for approval when a
mutating tool is requested.

## Users / actors

- **The user** — sends messages, approves/rejects tool calls,
  switches sessions, changes the model and theme.
- **The server** — provides the API + SSE stream.
- **The reducer** — single source of truth for SSE → state (see
  [[phase-14-per-message-sse]] for the Phase 14 pure-function
  rewrite; Phase 7 has the imperative version).

## Functional requirements

### Layout (Phase 7 desktop)

- FR-1. Three-pane layout at ≥ 1024 px:
  `Sessions | Chat (message list + composer) | Tool panel`.
- FR-2. The tool panel is collapsible and shows the most recent
  tool call details (full output, diff) so long shell output doesn't
  dominate the chat.

### Streaming

- FR-3. Tokens appear incrementally.
- FR-4. Code blocks render progressively without layout thrash; no
  full re-render per token.

### Markdown

- FR-5. GitHub-flavored markdown via `react-markdown` + `remark-gfm`.
- FR-6. Syntax-highlighted code blocks via `shiki`.
- FR-7. Tables, task lists, strikethrough, autolinks.
- FR-8. Inline code with copy-on-click.
- FR-9. HTML in markdown sanitized (`rehype-sanitize`) — no raw
  `script` or `iframe`.
- FR-10. LaTeX/math is **not** supported in v1.

### Tool events

- FR-11. Shell commands render in a collapsible "ran this" block.
- FR-12. File diffs render in a syntax-highlighted diff view.

### Approval flow

- FR-13. When `approval_required` arrives, an `ApprovalCard` appears
  inline.
- FR-14. Buttons: **Approve**, **Approve and remember for this
  session**, **Reject with reason**, **Edit and approve**.
- FR-15. On rejection the agent receives the rejection reason in the
  next turn.
- FR-16. Once the tool's outcome is decided (`tool_result` arrives),
  the corresponding `tool_call` block AND its `ApprovalCard` are
  dropped from the chat — the block disappears as soon as the
  decision is made. The server-side audit log and the on-disk
  transcript still have the full record; this is a UI-only
  behavior.

### Controls

- FR-16. Stop / regenerate / edit-and-resend controls per message.
- FR-17. Keyboard shortcuts:
  - `Cmd/Ctrl+K` — switch sessions
  - `Cmd/Ctrl+Enter` — send
  - `Esc` — cancel generation
  - `Cmd/Ctrl+,` — settings

### Theme

- FR-18. Light + dark, system-preference default.
- FR-19. The chosen theme persists across reloads (no flash of wrong
  theme).

### Offline / no telemetry

- FR-20. No telemetry.
- FR-21. No external fonts/CDNs by default — works fully offline
  once installed.

## Non-functional requirements

- Strict TypeScript with no `any` in the public API.
- `bun run typecheck && bun test` is green.
- No N+1 fetches; the session list is fetched once on boot.

## Out of scope (Phase 7)

- Mobile-first layout (added in [[phase-10-mobile-ui]]).
- URL-routable sessions (added in [[phase-12-url-and-titles]]).
- The pure SSE-event reducer (added in
  [[phase-14-per-message-sse|Phase 14]]).

## Constraints

- React + Vite + TypeScript only (no other UI framework).
- `zustand` is the only state library.
- Tailwind is **not** used — the project is plain CSS.

## Acceptance criteria

- All T7.x "Done when" criteria in `TASKS.MD` pass.
- A real browser session against a real server renders, streams,
  approves, and rejects correctly.

## Open questions

None at acceptance.