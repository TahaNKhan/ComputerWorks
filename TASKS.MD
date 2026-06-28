# ComputerWorks — Task list

The build is sequenced so each task leaves the repo in a green state
(`bun run typecheck && bun test` pass) and unlocks the next task.
Tasks are grouped by phase. Each task lists: **files**, **done when**,
and **depends on** as indented subtasks. Tags: `#phase<N>`, `@ready`,
`@wip`, `@blocked`.

> **Status legend** — `[ ]` not started, `[~]` in progress, `[x]` done.

## Done ✅

### Phase 0 — Repo scaffolding 🔧 @ready
**Spec**: [phase-00-scaffolding](docs/specs/phase-00-scaffolding/)

- [x] T0.1 — Monorepo skeleton #phase0 @ready _done:2026-06-24
  - **Files**: `package.json`, `bunfig.toml`, `tsconfig.base.json`,
    `.gitignore`, `.editorconfig`, `.nvmrc`, `README.md`, `LICENSE`
  - **Deps**: none
  - **Done when**:
    - Root `package.json` declares workspaces
      (`packages/*`), `private: true`, `name: "computerworks"`,
      `type: "module"`, scripts `dev`, `build`, `test`, `typecheck`,
      `lint`, `start`
    - `tsconfig.base.json` enables `strict`, `moduleResolution:
      "bundler"`, `target: "ES2022"`, `module: "ESNext"`,
      `noUncheckedIndexedAccess: true`
    - `bunfig.toml` registers a `[test]` block
    - `bun install` runs cleanly with zero deps installed
- [x] T0.2 — Empty workspace packages #phase0 @ready _done:2026-06-24
  - **Files**: `packages/{core,agent,tools-shell,tools-files,memory-files,server,ui}/package.json` (placeholder),
    `packages/*/tsconfig.json` extending the base
  - **Deps**: T0.1
  - **Done when**: each package has a `name`,
    `"@computerworks/<name>"`, a `build` script (`tsc -b`), a
    `typecheck` script, and an empty `src/index.ts`. `bun install`
    resolves the workspace links.

### Phase 1 — Core types and Provider interface 📦 @ready
**Spec**: [phase-01-core-and-provider](docs/specs/phase-01-core-and-provider/)

- [x] T1.1 — Core types #phase1 @ready _done:2026-06-25
  - **Files**: `packages/core/src/types.ts`,
    `packages/core/src/index.ts`
  - **Deps**: T0.2
  - **Done when**: types in [phase-01-core-and-provider/design.md](docs/specs/phase-01-core-and-provider/design.md) exist and compile.
    Includes `Role`, content blocks, `Message`, `ToolDefinition`,
    `ToolContext`, `StreamEvent`. `bun run typecheck` passes for
    `core`.
- [x] T1.2 — Provider interface #phase1 @ready _done:2026-06-25
  - **Files**: `packages/core/src/provider.ts`
  - **Deps**: T1.1
  - **Done when**: `Provider` and `ProviderOverrides` interfaces
    exist per [phase-01-core-and-provider/design.md](docs/specs/phase-01-core-and-provider/design.md). `core` typechecks.
- [x] T1.3 — Anthropic provider #phase1 @ready _done:2026-06-25
  - **Files**: `packages/core/src/providers/anthropic.ts`,
    `packages/core/src/providers/anthropic.test.ts`,
    `packages/core/package.json` (adds `@anthropic-ai/sdk`, `zod`)
  - **Deps**: T1.2
  - **Done when**:
    - `createAnthropicProvider(config)` returns a `Provider`
    - Override merge precedence (defaults < config < request)
      is correct (unit tested)
    - `betaHeaders` joined into `anthropic-beta`
    - `extraBody` deep-merged
    - Stream events translated (unit tested with mocked fetch)
    - Reads `MINIMAX_TOKEN` / `MINIMAX_BASE_URL` /
      `MINIMAX_DEFAULT_MODEL` from env; default model `MiniMax-M3`
    - Scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` before
      constructing SDK client
    - `Authorization: Bearer *** (via `authToken`), not
      `x-api-key` (Bearer auth required by MiniMax)
    - Throws clear error if `MINIMAX_TOKEN` missing
- [x] T1.4 — Scripted test provider #phase1 @ready _done:2026-06-25
  - **Files**: `packages/core/src/providers/scripted.ts`
  - **Deps**: T1.2
  - **Done when**: `createScriptedProvider(script)` plays back a
    list of pre-canned `StreamEvent` sequences. Used by every
    later test to avoid network calls.

### Phase 2 — Agent loop 🧠 @ready
**Spec**: [phase-02-agent-loop](docs/specs/phase-02-agent-loop/)

- [x] T2.1 — Approver interface and AutoApprover #phase2 @ready _done:2026-06-25
  - **Files**: `packages/agent/src/approval.ts`,
    `packages/agent/src/approval.test.ts`
  - **Deps**: T1.4
  - **Done when**: `Approver`, `ApprovalRequest`,
    `ApprovalDecision` types exist per §7. `AutoApprover` accepts a
    policy function and is unit tested.
- [x] T2.2 — Tool registry #phase2 @ready _done:2026-06-25
  - **Files**: `packages/agent/src/registry.ts`,
    `packages/agent/src/registry.test.ts`
  - **Deps**: T2.1
  - **Done when**: `ToolRegistry` lets you `register(tool)` and
    `get(name)`, validates inputs against the tool's zod schema,
    and returns descriptive errors for unknown tools.
- [x] T2.3 — Agent loop #phase2 @ready _done:2026-06-25
  - **Files**: `packages/agent/src/loop.ts`,
    `packages/agent/src/loop.test.ts`
  - **Deps**: T2.2, T1.4, T1.3
  - **Done when**:
    - `runTurn` implements the state machine in §6.1
    - Iteration cap enforced (default 25, configurable)
    - Cancellation via `AbortSignal` stops the loop; partial
      message dropped
    - Provider errors surface as `error` events; partial dropped
    - Tool errors become `tool_result` with `is_error: true`;
      loop continues
    - Tests cover: happy path, rejection-recovery, iteration
      cap, cancellation, provider error, tool error

### Phase 3 — Tools 🛠️ @ready
**Spec**: [phase-03-tools](docs/specs/phase-03-tools/)

- [x] T3.1 — `run_shell` tool #phase3 @ready _done:2026-06-25
  - **Files**: `packages/tools-shell/src/index.ts`,
    `packages/tools-shell/src/index.test.ts`
  - **Deps**: T2.2
  - **Done when**:
    - Detects platform (PowerShell on Windows, `bash -lc` on Unix)
    - Spawns via `node:child_process` non-interactively (no TTY)
    - Default 60s timeout, configurable
    - 100KB output cap with visible truncation marker
    - Returns `{ stdout, stderr, exitCode, durationMs, timedOut, truncated }`
    - Honors `cwd` and `AbortSignal` (abort sets `timedOut: true`)
    - `requiresApproval: true`
    - Tested with a temp script that exits 0, exits 1, times out,
      and is killed by abort
- [x] T3.2 — File tools: `read_file`, `write_file`, `edit_file`, `list_dir` #phase3 @ready _done:2026-06-25
  - **Files**: `packages/tools-files/src/{path-safety,read,write,edit,list,index}.ts`,
    `packages/tools-files/src/index.test.ts`
  - **Deps**: T2.2
  - **Done when**:
    - `read_file`: rejects binary content (NUL byte / >5% control
      chars); 5MB cap; line-numbered; `startLine` / `maxLines`;
      rejects paths escaping the session cwd
    - `write_file`: creates parent dirs; UTF-8 normalized (CRLF→LF,
      opt-out); `requiresApproval: true`
    - `edit_file`: atomic, all-or-nothing; `requiresApproval: true`;
      single {oldString,newString} OR `replaces[]`; `unique:false`
      to allow multi-match
    - `list_dir`: read-only, no approval; returns
      `{ name, type, size, mtime }`; honors session cwd
    - All four tools share `path-safety.ts` (`resolveSafe`) that
      rejects `..` escapes and absolute paths outside session cwd
    - All four tools are unit tested with a temp directory

### Phase 4 — Memory provider 🧠 @ready
**Spec**: [phase-04-memory](docs/specs/phase-04-memory/)

- [x] T4.1 — File-based memory provider #phase4 @ready _done:2026-06-25
  - **Files**: `packages/memory-files/src/index.ts`,
    `packages/memory-files/src/index.test.ts`
  - **Deps**: T1.1
  - **Done when**:
    - Implements `MemoryProvider` (`list`, `read`, `write`,
      `delete`, `search`)
    - Storage layout matches [phase-04-memory/requirements.md](docs/specs/phase-04-memory/requirements.md):
      `<root>/notes/<name>.md` + `<root>/index.json`
    - `search` is case-insensitive substring + filename match,
      top-10, with ±60-char snippet around the match
    - `write` refuses to escape `root` (rejects `..`, `/`, `\` and
      non-`[A-Za-z0-9._-]` names)
    - Index rebuilds from disk on first call after a fresh root
    - Round-trip test passes; missing-file handling is clean

---

### Phase 5 — Server 🛰️
**Spec**: [phase-05-server](docs/specs/phase-05-server/)

- [x] T5.1 — Config loader #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/config.ts`,
    `packages/server/src/config.test.ts`,
    `packages/server/package.json` (adds `jiti`, `zod`)
  - **Deps**: T1.1
  - **Done when**:
    - Loads `~/.computerworks/config.ts` via `jiti`
    - Validates with the schema in [phase-05-server/design.md](docs/specs/phase-05-server/design.md#configuration)
    - Applies env overrides (`COMPUTERWORKS_*`)
    - Fails fast with a useful error on bad config
    - Unit tested with a temp config file and process env tweaks
- [x] T5.2 — Session store #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/session-store.ts`,
    `packages/server/src/session-store.test.ts`
  - **Deps**: T1.1
  - **Done when**:
    - `create`, `list`, `get`, `patch` (rename/cwd/model), `delete`,
      `appendMessage`, `appendAudit`
    - Storage layout matches [phase-05-server/requirements.md](docs/specs/phase-05-server/requirements.md)
    - Atomic per-line writes; concurrent appends are safe
    - Round-trip test passes for a session with several messages
      and audit entries
- [x] T5.3 — Audit log #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/audit.ts`
  - **Deps**: T5.2
  - **Done when**: `appendAudit(sessionId, entry)` writes a single
    JSON line. Tested via the session store.
- [x] T5.4 — SSE manager #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/sse.ts`,
    `packages/server/src/sse.test.ts`
  - **Deps**: T1.1
  - **Done when**:
    - `SSEManager` supports multiple subscribers per session
    - `send(sessionId, event)` frames events correctly
    - Heartbeat at 15s on idle streams
    - Cleanup on subscriber disconnect
- [x] T5.5 — Interactive approver #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/interactive-approver.ts`,
    `packages/server/src/interactive-approver.test.ts`
  - **Deps**: T2.1, T5.4
  - **Done when**:
    - `InteractiveApprover(sseManager, sessionId, allowlist)` sends
      `approval_required` and waits for `POST /approve`
    - Global + session allowlists skip the prompt and auto-approve
      (still logged)
    - Default 5-minute timeout; auto-rejects with reason on
      timeout
    - Unit tested with a fake `SSEManager` and a fake `approve`
      responder
- [x] T5.6 — Fastify app skeleton #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/app.ts`,
    `packages/server/src/start.ts`,
    `packages/server/src/index.ts`,
    `packages/server/src/routes/*.ts`,
    `packages/server/package.json` (adds `fastify`,
    `@fastify/cors`, `@fastify/sensible`)
  - **Deps**: T5.1, T5.2, T5.4
  - **Done when**:
    - `buildApp({ config })` returns a configured `FastifyInstance`
    - Routes from §8.4 exist; non-`/stream` routes are
      `app.inject()`-tested
    - CORS is locked to localhost
    - `start()` binds to `config.server.host:port`; refuses to
      bind to non-loopback without `--allow-non-loopback` and a
      warning
    - `bun run start:dev` boots the server; `GET /api/health`
      returns `{ ok: true }`
- [x] T5.7 — Wire agent loop into `/messages` and `/stream` #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/routes/messages.ts`,
    `packages/server/src/routes/stream.ts`,
    `packages/server/src/system-prompt.ts`,
    `packages/server/src/tools/index.ts`
  - **Deps**: T2.3, T3.*, T4.1, T5.5
  - **Done when**:
    - `POST /api/sessions/:id/messages` with a user message starts
      `runTurn`, wires its `onEvent` into the SSE manager, and
      returns `204` once the turn is queued (or `409` if one is
      already in flight)
    - `GET /api/sessions/:id/stream` returns the SSE event stream
      for the latest run, including `approval_required` events
    - System prompt is assembled from a static prefix + memory
      directory listing
    - Default tool set is registered (`run_shell`, `read_file`,
      `write_file`, `edit_file`, `list_dir`, `read_memory`,
      `write_memory`, `list_memory`, `search_memory`)
    - End-to-end test: scripted provider + auto-approver, send a
      message, assert the agent requested a tool and the tool
      result was appended
- [x] T5.8 — Cancel route #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/routes/cancel.ts`
  - **Deps**: T5.7
  - **Done when**: `POST /api/sessions/:id/cancel` aborts the
    in-flight run via the per-session `AbortController`. Tested.

---

### Phase 6 — CLI 💻
**Spec**: [phase-06-cli](docs/specs/phase-06-cli/)

- [x] T6.1 — `computerworks serve` #phase6 @ready target:phase6 _done:2026-06-25
  - **Files**: `packages/server/src/cli.ts`,
    `packages/cli/` (or top-level `bin/`)
  - **Deps**: T5.6
  - **Done when**: `bun run start` (or `computerworks serve`)
    loads the config and starts the server; `--port`, `--host`,
    `--verbose` flags work
- [x] T6.2 — `computerworks sessions` and `computerworks memory` #phase6 @ready target:phase6 _done:2026-06-25
  - **Files**: same CLI module
  - **Deps**: T5.2, T4.1
  - **Done when**:
    - `computerworks sessions list` prints id, title, last-active
    - `computerworks sessions delete <id>` removes a session
    - `computerworks sessions export <id>` writes a Markdown
      transcript to stdout
    - `computerworks memory ls`, `show <name>`, `edit <name>`
      work


### Phase 7 — UI 🖥️
**Spec**: [phase-07-ui](docs/specs/phase-07-ui/)

- [x] T7.1 — Vite + React scaffold #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/`, `packages/ui/vite.config.ts`
  - **Deps**: T0.2
  - **Done when**: `bun run --filter @computerworks/ui dev` starts
    the Vite dev server with a placeholder page
- [x] T7.2 — API client and types #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/api/client.ts`,
    `packages/ui/src/api/types.ts`
  - **Deps**: T7.1
  - **Done when**: typed `fetch` wrappers for every REST route and
    a `SSEClient` that yields `ServerEvent`. Reconnect on
    disconnect.
- [x] T7.3 — Session store (zustand) #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/store/sessions.ts`
  - **Deps**: T7.2
  - **Done when**: state holds the session list, the active
    session, its messages, and the in-flight approval request
- [x] T7.4 — Three-pane layout and SessionList #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/App.tsx`,
    `packages/ui/src/components/SessionList.tsx`
  - **Deps**: T7.3
  - **Done when**: the layout matches §11.3; the session list
    fetches, creates, deletes, renames, switches sessions
- [x] T7.5 — Chat + Composer (no streaming) #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/components/ChatView.tsx`,
    `packages/ui/src/components/MessageList.tsx`,
    `packages/ui/src/components/Composer.tsx`
  - **Deps**: T7.4
  - **Done when**: typing a message and pressing send POSTs to
    `/api/sessions/:id/messages` and renders the full assistant
    reply once it returns. Streaming added next.
- [x] T7.6 — SSE consumer + streaming tokens #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/store/stream.ts`,
    updates to `MessageList.tsx`
  - **Deps**: T7.5
  - **Done when**: tokens appear incrementally in the UI without
    re-rendering the whole list per token. The chat view is
    responsive while streaming
- [x] T7.7 — Markdown rendering #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/components/Markdown.tsx`,
    `packages/ui/src/components/Message.tsx`
  - **Deps**: T7.6
  - **Done when**: GFM markdown renders with tables, task lists,
    strikethrough, autolinks; code blocks are syntax-highlighted
    via `shiki`; raw HTML is sanitized; inline code is copy-on-click
- [x] T7.8 — Tool call rendering #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/components/ToolCallBlock.tsx`
  - **Deps**: T7.6
  - **Done when**: shell output and file diffs render as
    collapsible blocks inline in the message stream
- [x] T7.9 — Approval card #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/components/ApprovalCard.tsx`
  - **Deps**: T7.6, T5.7
  - **Done when**: when `approval_required` arrives, the card
    appears inline; Approve / Reject / Edit-and-approve buttons
    POST to `/api/sessions/:id/approve`; the agent continues
    after a decision
- [x] T7.10 — Polish: themes, shortcuts, settings #phase7 @ready target:phase7 _done:2026-06-25
  - **Files**: `packages/ui/src/components/ThemeToggle.tsx`,
    `packages/ui/src/lib/shortcuts.ts`,
    `packages/ui/src/styles/global.css`
  - **Deps**: T7.9
  - **Done when**: light + dark theme (system default),
    `Cmd/Ctrl+K` session switcher, `Cmd/Ctrl+Enter` send,
    `Esc` cancel, and a basic settings page (model picker) all
    work

### Phase 8 — End-to-end verification 🧪
**Spec**: [phase-08-e2e-verification](docs/specs/phase-08-e2e-verification/)

- [x] T8.1 — E2E smoke script #phase8 @ready target:phase8 _done:2026-06-25
  - **Files**: `scripts/e2e.ts`
  - **Deps**: all of Phase 5
  - **Done when**: starts the server on an ephemeral port with
    `ScriptedProvider` and `AutoApprover`, sends a message,
    consumes the SSE stream, asserts a shell tool was called and
    the transcript was persisted
- [x] T8.2 — UI manual smoke checklist #phase8 @ready target:phase8 _done:2026-06-25
  - **Files**: `docs/ui-smoke.md`
  - **Deps**: T7.10, T8.1
  - **Done when**: a written checklist (agent runs `ls`, user
    approves, result renders; agent edits a file, user sees the
    diff, approves, sees the result; switching sessions keeps
    state) is checked off in a real browser run
- [x] T8.3 — README and quickstart #phase8 @ready target:phase8 _done:2026-06-25
  - **Files**: `README.md`
  - **Deps**: T6.*, T7.10
  - **Done when**: README has install, run, configure, override
    the API base URL, write a memory note, and troubleshoot
    sections
 (run continuously)

### Phase 9 — MiniMax auth fix (LAN deployment followup)
**Spec**: [phase-09-minimax-auth](docs/specs/phase-09-minimax-auth/)

LAN device got `401 Invalid bearer token` from MiniMax because three config defaults pointed at real Anthropic. Root-caused and fixed on `phase/9-minimax-auth`.

- [x] T9.1 — Fix MiniMax auth (default model + baseUrl + apiKey) + .env file support #phase9
      _done:2026-06-25 — commit `041c0aa` on `phase/9-minimax-auth`

### Phase 10 — Mobile-friendly UI (LAN deployment followup)
**Spec**: [phase-10-mobile-ui](docs/specs/phase-10-mobile-ui/)

User opened the UI on a phone and the three-pane layout was unusable. Pure CSS + component pass — no new deps, no state restructure.

- [x] T10.1 — Mobile breakpoints + responsive layout #phase10 _done:2026-06-25
      Mobile-first CSS: <768px single pane (chat only) with sidebar as a slide-in drawer behind a hamburger; >=768px inline sidebar + chat (2 panes); >=1024px full 3-pane layout. Sticky composer with safe-area-inset padding, 44px tap targets, 16px base font (no iOS zoom-on-focus), ApprovalCard buttons stacked vertically on mobile.

### Phase 11 — Persist LLM responses to transcript
**Spec**: [phase-11-persist-responses](docs/specs/phase-11-persist-responses/)

User noticed the session transcript (messages.jsonl) only contains the user message — assistant text, tool calls, and tool results stayed in the agent loop's in-memory `history` and were lost on reload. SSE consumers saw them in the stream, but `GET /api/sessions/:id` returned just the user turn.

- [x] T11.1 — Persist assistant + tool messages after runTurn #phase11 @ready target:phase11 _done:2026-06-25
  - **Files**: `packages/server/src/routes/messages.ts`,
    `packages/agent/src/loop.ts`,
    `packages/server/src/app.test.ts`
  - **Deps**: none
  - **Done when**:
    - After `runTurn` completes (or throws), every new message the
      loop appended to `history` is also written to
      `messages.jsonl` via `SessionStore.appendMessage`
    - The user message itself is still persisted before `runTurn`
      starts (no double-append)
    - On provider error: the partial text the LLM streamed before
      failing is appended to history (so it gets persisted) — the
      SSE consumer saw it, the on-disk transcript should too
    - On AbortError: completed iterations are persisted; the
      in-flight partial is dropped, matching the existing
      "partial message dropped" loop invariant
    - Regression test in `app.test.ts` asserts the transcript
      after a scripted turn contains `[user, assistant(tool_use),
      tool(tool_result), assistant(text)]` — fails before this
      fix, passes after

### Phase 12 — URL-routable sessions + LLM-generated titles
**Spec**: [phase-12-url-and-titles](docs/specs/phase-12-url-and-titles/)

Two UX asks that go together: the sidebar's session id should be
shareable via URL, and the session title should auto-generate
from the first turn instead of staying blank or "(untitled)".

URL shape: `/?session=<id>` (query param — keeps it a pure SPA,
no Fastify SPA-fallback needed). Title gen: fire-and-forget
LLM call after each turn, skipped when the title is already
non-empty (so manual renames + titled-on-create survive).

- [x] T12.1 — Frontend URL sync (activeSessionId ↔ ?session=<id>) #phase12 @ready target:phase12 _done:2026-06-26
  - **Files**: `packages/ui/src/lib/router.ts` (new),
    `packages/ui/src/main.tsx` (mount the router),
    `packages/ui/src/store/sessions.ts` (write URL on
    `switchSession` + read URL on init),
    `packages/ui/src/store/sessions.test.ts` (URL helpers)
  - **Deps**: none
  - **Done when**:
    - `router.ts` exposes: `getSessionFromUrl()`,
      `setSessionInUrl(id | null)`,
      `subscribeUrlChange(cb)` (popstate-driven)
    - On app boot: `getSessionFromUrl()` reads the param; if it
      names a real session in the loaded list, that becomes the
      active session. If it names an unknown id, the param is
      cleared and an error toast surfaces.
    - `switchSession(id)` writes the new id via `pushState` so
      the browser back button walks the session history.
    - `popstate` (user clicking back/forward) updates
      `activeSessionId` accordingly.
    - Visiting `/` with no param shows the empty state.

- [x] T12.2 — Backend LLM-generated session titles #phase12 @ready target:phase12 _done:2026-06-26
  - **Files**: `packages/server/src/title-generator.ts` (new),
    `packages/server/src/routes/messages.ts` (call after runTurn),
    `packages/server/src/sse.ts` (add `title_updated` event),
    `packages/ui/src/api/types.ts` +
    `packages/ui/src/store/sessions.ts` (consume the new event)
  - **Deps**: T12.1
  - **Done when**:
    - `generateTitle(deps, sessionId)` reads the first user
      message + first assistant text from the store, calls
      `provider.chat` once with a "summarize as 3-5 word title"
      prompt, sanitizes the result (strip quotes/whitespace,
      truncate to 80 chars), and PATCHes `meta.title`.
    - Skipped entirely if `meta.title` is already non-empty
      (manual rename or `createSession({ title })`).
    - Failures (LLM error, no messages yet) are logged and
      swallowed — the user experience never blocks on a title.
    - On success: emits a `title_updated` SSE event on the
      session's stream with `{ sessionId, title }`. The UI
      reducer updates the session in `sessions` and (if it's
      the active one) the meta header.
    - Unit test for the title sanitizer + a server test that
      asserts the PATCH happens and the SSE event is emitted.

## Gates (run continuously)

- [x] Typecheck gate #gates @ready _done:2026-06-28 — every PR (or every push) runs
  `bun run typecheck` and `bun test`; both must pass.
- [x] Lint gate #gates @ready _done:2026-06-28 — `eslint` with `@typescript-eslint`
  and `eslint-plugin-react` for the UI package.
- [x] Dependency hygiene #gates @ready _done:2026-06-28 — `bun outdated` reviewed
  before each phase close; no `bun add` of a package with a
  non-MIT/Apache/BSD license without a note in the phase's `requirements.md`.

### Phase 14 — Per-message SSE + UI rewrite
**Spec**: [phase-14-per-message-sse](docs/specs/phase-14-per-message-sse/)

The Phase 5/7 architecture held two long-lived SSE channels open per
session — one per browser tab — and made the agent loop a background
side-effect of `POST /messages`. That worked for one user with one tab,
but it can't scale to multiple concurrent conversations on the same
session (each new tab fights for the same broadcast queue), it can't
reliably multiplex approvals and tool events across streams, and the
frontend reducer entangled event merging with store actions so the UI
felt jittery on every token burst.

Phase 14 simplifies the wire model end-to-end:

- `POST /api/sessions/:id/messages` now opens an SSE stream **in its
  own response**. The agent runs synchronously while the response is
  open; events are written directly to the response stream; the stream
  closes with a `done` frame when the turn ends. The persistent
  `GET /api/sessions/:id/stream` route is gone.
- This means each message gets its own SSE channel — multiple
  concurrent conversations on the same session are isolated by request
  lifecycle, not by fanout through a broadcast manager.
- Approvals still POST to `/approve`, but the resolver is now keyed
  on `(sessionId, requestId, request)` rather than a global
  `SSEManager`. The agent turn writes back through a per-request
  writer callback, so a rejected approval on tab A no longer leaks
  tool events to tab B's stream.

The UI is rewritten from scratch around two ideas:

1. **Business logic lives outside React.** The SSE-event reducer is a
   pure function in `store/reducer.ts`. The zustand store delegates to
   it. Components are presentational; they read state and dispatch
   actions through typed selectors, but they don't own any state
   transitions.
2. **Mobile is the default.** CSS is single-column at every width;
   the session list is a slide-in drawer; the composer is sticky with
   `env(safe-area-inset-*)` padding; every tap target is ≥44 px.
   Tablet/desktop widen the grid to 2 or 3 columns but inherit the
   same primitives.

Tests follow §2 of the global CLAUDE.md: we don't unit-test
components (they're thin and verified by the integration tests). We
**do** unit-test every piece of business logic — the reducer, the SSE
frame parser, the router, the shortcut matcher, and the title
derivation.

- [x] T14.1 — POST /api/sessions/:id/messages opens SSE directly #phase14 @ready target:phase14 _done:2026-06-28
  - **Files**:
    `packages/server/src/routes/messages.ts`,
    `packages/server/src/sse-writer.ts` (new),
    `packages/server/src/sse.ts` (rewrite — drop the manager),
    `packages/server/src/interactive-approver.ts`,
    `packages/server/src/app.ts`,
    `packages/server/src/app.test.ts`
  - **Deps**: none
  - **Done when**:
    - `POST /api/sessions/:id/messages` returns `Content-Type:
      text/event-stream`, streams `message_start` / `token` / `tool_call`
      / `tool_result` / `approval_required` / `session_renamed` /
      `message_done` / `done` / `error` frames in order as the agent
      runs, and closes the stream after the terminal `done` (or
      `error`) frame
    - Multiple in-flight requests on the same session are NOT
      rejected — each gets its own SSE channel and its own
      `SessionRuntime`. The previous "409 if busy" guard is removed
      in favor of "each request owns its turn end-to-end"
    - `InteractiveApprover` writes events through a `SSEWriter`
      interface (the per-request response writer) instead of an
      `SSEManager`. `ApproverRegistry` is removed; the
      `/approve` route handler holds the `(requestId → resolver)`
      map for the duration of one turn
    - The `SSEManager` class, its subscriber/heartbeat machinery, and
      `routes/stream.ts` are deleted
    - `app.test.ts` integration test: send a message via
      `app.inject()` and assert the response is `text/event-stream`
      and contains the expected event frames in order
    - `bun run typecheck && bun test` is green
- [x] T14.2 — Pure reducer for SSE events #phase14 @ready target:phase14 _done:2026-06-28
  - **Files**:
    `packages/ui/src/store/reducer.ts` (new),
    `packages/ui/src/store/reducer.test.ts` (new),
    `packages/ui/src/store/sessions.ts`,
    `packages/ui/src/api/types.ts`
  - **Deps**: none
  - **Done when**:
    - `reduceStreamEvent(state, ev): SessionsState` is a pure
      function — no I/O, no side effects, no React. It takes the
      current `SessionsState` and one `ServerEvent` and returns the
      next `SessionsState`. Every branch in the current
      `reduceEvent` lives here, unchanged in semantics
    - The reducer is the single source of truth for `message_start`,
      `token`, `tool_call`, `tool_result`, `approval_required`,
      `message_done`, `session_renamed`, `done`, and `error`. It does
      NOT call the API or update the URL — those stay in the store's
      action methods
    - `bun test packages/ui/src/store/reducer.test.ts` covers all
      nine branches plus the cross-cutting helpers
      (`appendToken`, `appendToolCall`, `applyToolResult`,
      `appendPart`, `finalizeStreaming`)
    - The store's `applyServerEvent` action becomes a one-liner:
      `set((s) => reduceStreamEvent(s, ev))`
- [x] T14.3 — UI rewrite: mobile-first, thin components #phase14 @ready target:phase14 _done:2026-06-28
  - **Files**: every file under `packages/ui/src/`; `packages/ui/src/styles/global.css`
  - **Deps**: T14.1, T14.2
  - **Done when**:
    - `App.tsx` is a thin composition root: header + main + modals.
      No event-handling logic, no store mutation
    - Components are presentational: each one takes typed props and
      calls selectors via the store. No `useState` outside the
      composer (draft text) and the settings dialog (form state)
    - `SessionList` is a pure renderer over the store's
      `sessions: SessionMeta[]`. Switch / rename / delete actions are
      bound to store actions, not implemented in the component
    - `Composer` is the only place that holds local form state
      (the draft). Submit calls `sendMessage`; the store opens SSE,
      consumes events through the reducer, and the chat view updates
      declaratively
    - `ChatView` / `MessageList` / `Message` read messages from the
      store and render them. No streaming awareness in the JSX
    - `ApprovalCard` reads `pendingApproval` from the store and
      dispatches `decideApproval`. Buttons are full-width on mobile,
      side-by-side on desktop
    - CSS is mobile-first: a single column at < 768 px, two columns
      at 768–1023 px, three columns at ≥ 1024 px. Tap targets are
      ≥44 px; the composer respects `env(safe-area-inset-bottom)`
    - `Cmd/Ctrl+K`, `Cmd/Ctrl+Enter`, `Esc`, `Cmd/Ctrl+,` shortcuts
      still work and are tested via the existing shortcut tests
- [x] T14.4 — Tests, docs, ship #phase14 @ready target:phase14 _done:2026-06-28
  - **Files**: `README.md`, `CLAUDE.md`, the new tests
  - **Deps**: T14.1, T14.2, T14.3
  - **Done when**:
    - All existing tests still pass. New reducer tests cover every
      event branch and every helper
    - `README.md` "Architecture" section is updated to describe
      per-message SSE (no more "GET /api/sessions/:id/stream" line)
    - `CLAUDE.md` "Phase status" reflects Phase 14 done
    - `bun run typecheck && bun test` is green
    - One final commit per task; final push to main per the
      user-issued override of the "push only to phase branches" rule

### Phase 15 — Serve UI from server
**Spec**: [phase-15-serve-ui-from-server](docs/specs/phase-15-serve-ui-from-server/)

Today the dev workflow runs two processes: the Fastify server on
`127.0.0.1:4747` and a Vite dev server on `localhost:5173` that
proxies `/api/*`. This phase unifies them: the Fastify server
serves the built UI bundle from `packages/ui/dist-app/` via
`@fastify/static`. One process, one port, one URL. The user chose
**build-then-serve** over Vite middleware mode — the cost is no
HMR; the win is a cleaner dependency tree and one deployment
artifact.

- [x] T15.1 — Static-file serving in buildApp #phase15 @ready target:phase15 _done:2026-06-28
  - **Files**: `packages/server/package.json`,
    `packages/server/src/app.ts`,
    `packages/server/src/start.ts`
  - **Deps**: none
  - **Done when**:
    - `@fastify/static` added to `packages/server/package.json`
    - `buildApp({ uiRoot })` registers `@fastify/static` and a
      `GET /` fallback to `index.html` when `uiRoot` is provided
    - `start.ts` accepts `--ui-root=<path>` (default
      `packages/ui/dist-app` relative to cwd), validates the path
      exists, fails fast with a clear error if not
    - New tests in `app.test.ts` cover: `GET /` returns
      `index.html`, `GET /assets/<file>` returns the bundle,
      `GET /api/*` still returns JSON, missing `uiRoot` produces
      a working app without static serving
    - `bun run typecheck && bun test` is green

- [x] T15.2 — Build pipeline produces UI bundle #phase15 @ready target:phase15 _done:2026-06-28
  - **Files**: `packages/ui/package.json`,
    `packages/ui/vite.config.ts`,
    `package.json` (root)
  - **Deps**: T15.1
  - **Done when**:
    - `packages/ui/package.json` `build` is `tsc -b && vite build`,
      emitting both `dist/` (TS) and `dist-app/` (Vite)
    - `packages/ui/vite.config.ts` has no `server` block (no dev
      server, no proxy); `emptyOutDir: true` on the build config
    - `packages/ui/package.json` has no `dev` or `start` scripts
    - Root `build` chains `tsc -b` and the UI build so a single
      `bun run build` produces the full distributable
    - Root `dev` is `bun run build && bun run start`
    - Root `dev:watch` rebuilds the UI on change and restarts
      the server in parallel
    - `bun run build && bun run start` boots a working browser
      session at `http://127.0.0.1:4747`

- [x] T15.3 — Docs + tests updated, ship #phase15 @ready target:phase15 _done:2026-06-28
  - **Files**: `README.md`, `docs/architecture.md`,
    `docs/specs/phase-07-ui/design.md`,
    `docs/specs/phase-08-e2e-verification/ui-smoke.md`,
    `packages/server/src/app.test.ts`,
    `docs/specs/phase-15-serve-ui-from-server/{README,requirements,design}.md`
  - **Deps**: T15.1, T15.2
  - **Done when**:
    - `app.test.ts` `localhost:5173` origin test updated to
      `127.0.0.1:4747` (the new UI origin)
    - `README.md` "Run" section describes one command, one port
    - `architecture.md` runtime topology reflects single-port
      serving
    - `phase-07-ui/design.md` notes the dev-workflow change
    - `ui-smoke.md`'s boot sequence is updated; the
      second-terminal UI step is removed
    - `phase-15` spec folder is complete with `README`,
      `requirements`, `design` (Mermaid diagrams)
    - `CLAUDE.md` "Phase status" reflects Phase 15 done
    - `bun run typecheck && bun test` is green

## Up next 👉

### Phase 16 — UI bug fixes (URL sync + scroll-to-bottom)

Two small UX bugs that surface when navigating to a session via the
shareable URL:

- [x] T16.1 — URL session sync lands on home page #phase16 @ready target:phase16 _done:2026-06-28
  - **Files**: `packages/ui/src/App.tsx`,
    `packages/ui/src/store/sessions.test.ts`
  - **Deps**: none
  - **Done when**:
    - Visiting `/?session=<id>` for a real session id lands on that
      session's chat (not the empty home state)
    - The URL is only cleared if the session is genuinely not found
      AFTER `loadSessions()` completes — not during the loading
      window when `sessions` is still `[]`
    - `bun run typecheck && bun test` is green

- [x] T16.2 — Chat view scrolls to bottom on load #phase16 @ready target:phase16 _done:2026-06-28
  - **Files**: `packages/ui/src/components/ChatView.tsx`,
    `packages/ui/src/components/MessageList.tsx`
  - **Deps**: none
  - **Done when**:
    - Opening a session with N messages shows the chat scrolled to
      the last message (not the first)
    - Switching between sessions with messages scrolls each to its
      bottom
    - The auto-scroll logic survives the `useDeferredValue` stagger
      in `MessageList` — fix is to read scrollHeight after the
      deferred render lands
    - `bun run typecheck && bun test` is green

After Phase 14 lands, the natural next moves are: cross-session tool
calls (one session asking another to run a tool), persistent
multi-tab sync (the new per-message SSE makes this trivially safe —
each tab opens its own stream), and a structured "edit-and-resend"
flow (rewind a turn, re-prompt with a modified message). None of
those are scheduled yet.

---


## Suggested commit sequence

1. T0.1, T0.2 ✅ done (commit `50b38c1`)
2. T1.1, T1.2 ✅ done (commit `a4fce1a`)
3. T1.3 ✅ done (commit `a4fce1a`)
4. T1.4 ✅ done (commit `a4fce1a`)
5. T2.1, T2.2 ✅ done (commit `7c9a016`)
6. T2.3 ✅ done (commit `7c9a016`)
7. T3.1 ✅ done (commit `6d30203`)
8. T3.2 ✅ done (commit `6d30203`)
9. T4.1 ✅ done (commit `6d30203`)
10. T5.1, T5.2, T5.3 — next cron tick (target: 2026-06-26 01:10 PT)
11. T5.4, T5.5
12. T5.6
13. T5.7
14. T5.8
15. T6.1, T6.2
16. T7.1, T7.2, T7.3, T7.4, T7.5
17. T7.6, T7.7, T7.8, T7.9
18. T7.10
19. T8.1, T8.2, T8.3
