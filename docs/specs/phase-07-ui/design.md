# Phase 7 — Design

## Module layout

```
packages/ui/
├── package.json
├── vite.config.ts
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── api/
    │   ├── client.ts              # fetch + EventSource wrapper
    │   └── types.ts               # mirror of server's wire types
    ├── store/
    │   ├── sessions.ts            # zustand
    │   └── stream.ts              # active SSE per session
    ├── components/
    │   ├── SessionList.tsx
    │   ├── ChatView.tsx
    │   ├── MessageList.tsx
    │   ├── Message.tsx            # markdown render
    │   ├── Markdown.tsx           # react-markdown config
    │   ├── ToolCallBlock.tsx      # collapsible shell/diff block
    │   ├── ApprovalCard.tsx
    │   ├── Composer.tsx
    │   ├── Settings.tsx           # model picker
    │   └── ThemeToggle.tsx
    ├── styles/
    │   └── global.css
    └── lib/
        ├── shortcuts.ts
        └── format.ts
```

## Layout

Three-pane CSS grid:

```mermaid
block-beta
    columns 3
    block:sidebar["Sessions"]
    end
    block:chat["Chat (message list + composer)"]
    end
    block:tools["Tool panel (collapsible)"]
    end
```

The right pane shows the most recent tool call details (full
output, diff) so long shell output doesn't dominate the chat.

The Phase 7 layout is desktop-first; the mobile-first pass is in
[[../phase-10-mobile-ui/design]].

## Streaming in the UI (Phase 7 shape)

- A single `EventSource` per active session is held in `stream.ts`.
- The stream consumer dispatches into a `Map<messageId, TokenBuffer>`.
- The chat view reads the buffer via a ref (not state) and updates
  the DOM directly for incremental token appends. The component
  re-renders only on structural changes (new message, new tool
  block, approval request).
- Approval cards appear inline as soon as `approval_required`
  arrives; the stream consumer sends the user's decision to
  `POST /approve` and continues consuming.

The pure SSE-event reducer that replaces this imperative consumer
is documented in [[../phase-14-per-message-sse/design]].

## Markdown component

`Markdown.tsx` configures:

- `react-markdown` with `remark-gfm` and `rehype-sanitize` (default
  schema).
- Code blocks: a `pre > code` `code` component that lazy-loads
  `shiki` and caches grammars.
- Inline code: copy-on-click via a small `<button>` overlay.
- No math / no raw HTML.

## Testing strategy

- Component tests are not the value (per the global CLAUDE.md §2 —
  "tests must exercise the real behavior, not the implementation").
  Integration tests cover the streaming + approval paths through
  `app.inject()` + a scripted browser flow (added in
  [[phase-08-e2e-verification|Phase 8]]).
- The Phase 14 reducer is unit-tested without rendering any
  component (see [[../phase-14-per-message-sse/design]]).

## Risks & mitigations

| Risk                                       | Mitigation                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Per-token re-render jank                   | Token buffer lives in a ref; the DOM is updated directly; only structural changes re-render the list. |
| Sanitization bypass via crafted HTML       | `rehype-sanitize` default schema; no `script` or `iframe`.                  |
| External font/CDN dependency breaks offline | Self-hosted fonts only; no `<link>` to third-party origins.                |

## Dev workflow (post-Phase 15)

The original `bun run --filter @computerworks/ui dev` (Vite dev
server on port 5173, proxying `/api` to the Fastify server) is no
longer the recommended workflow. [[../phase-15-serve-ui-from-server|Phase 15]]
unified the UI and server: `bun run build && bun run start` is the
new one-process, one-port flow. For iteration,
`bun run dev:watch` rebuilds the UI and restarts the server on
file changes. There is no HMR — Vite is build-only in this mode;
refresh the browser after each UI change.