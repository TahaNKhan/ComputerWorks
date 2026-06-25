# ComputerWorks — Task list

The build is sequenced so each task leaves the repo in a green state
(`bun run typecheck && bun test` pass) and unlocks the next task.
Tasks are grouped by phase. Each task lists: **files**, **done when**,
and **depends on** as indented subtasks. Tags: `#phase<N>`, `@ready`,
`@wip`, `@blocked`.

> **Status legend** — `[ ]` not started, `[~]` in progress, `[x]` done.

## Done ✅

### Phase 0 — Repo scaffolding 🔧 @ready

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

- [x] T1.1 — Core types #phase1 @ready _done:2026-06-25
  - **Files**: `packages/core/src/types.ts`,
    `packages/core/src/index.ts`
  - **Deps**: T0.2
  - **Done when**: types in §4 of `DESIGN.MD` exist and compile.
    Includes `Role`, content blocks, `Message`, `ToolDefinition`,
    `ToolContext`, `StreamEvent`. `bun run typecheck` passes for
    `core`.
- [x] T1.2 — Provider interface #phase1 @ready _done:2026-06-25
  - **Files**: `packages/core/src/provider.ts`
  - **Deps**: T1.1
  - **Done when**: `Provider` and `ProviderOverrides` interfaces
    exist per §5 of `DESIGN.MD`. `core` typechecks.
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

- [x] T4.1 — File-based memory provider #phase4 @ready _done:2026-06-25
  - **Files**: `packages/memory-files/src/index.ts`,
    `packages/memory-files/src/index.test.ts`
  - **Deps**: T1.1
  - **Done when**:
    - Implements `MemoryProvider` (`list`, `read`, `write`,
      `delete`, `search`)
    - Storage layout matches §4.4 of `REQUIREMENTS.MD`:
      `<root>/notes/<name>.md` + `<root>/index.json`
    - `search` is case-insensitive substring + filename match,
      top-10, with ±60-char snippet around the match
    - `write` refuses to escape `root` (rejects `..`, `/`, `\` and
      non-`[A-Za-z0-9._-]` names)
    - Index rebuilds from disk on first call after a fresh root
    - Round-trip test passes; missing-file handling is clean

---

### Phase 5 — Server 🛰️

- [x] T5.1 — Config loader #phase5 @ready target:phase5 _done:2026-06-25
  - **Files**: `packages/server/src/config.ts`,
    `packages/server/src/config.test.ts`,
    `packages/server/package.json` (adds `jiti`, `zod`)
  - **Deps**: T1.1
  - **Done when**:
    - Loads `~/.computerworks/config.ts` via `jiti`
    - Validates with the schema in §12 of `DESIGN.MD`
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
    - Storage layout matches §4.4 of `REQUIREMENTS.MD`
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


## Up next 👉

### Phase 6 — CLI 💻

- [ ] T6.1 — `computerworks serve` #phase6 @ready target:phase6
  - **Files**: `packages/server/src/cli.ts`,
    `packages/cli/` (or top-level `bin/`)
  - **Deps**: T5.6
  - **Done when**: `bun run start` (or `computerworks serve`)
    loads the config and starts the server; `--port`, `--host`,
    `--verbose` flags work
- [ ] T6.2 — `computerworks sessions` and `computerworks memory` #phase6 @ready target:phase6
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

- [ ] T7.1 — Vite + React scaffold #phase7 @ready target:phase7
  - **Files**: `packages/ui/`, `packages/ui/vite.config.ts`
  - **Deps**: T0.2
  - **Done when**: `bun run --filter @computerworks/ui dev` starts
    the Vite dev server with a placeholder page
- [ ] T7.2 — API client and types #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/api/client.ts`,
    `packages/ui/src/api/types.ts`
  - **Deps**: T7.1
  - **Done when**: typed `fetch` wrappers for every REST route and
    a `SSEClient` that yields `ServerEvent`. Reconnect on
    disconnect.
- [ ] T7.3 — Session store (zustand) #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/store/sessions.ts`
  - **Deps**: T7.2
  - **Done when**: state holds the session list, the active
    session, its messages, and the in-flight approval request
- [ ] T7.4 — Three-pane layout and SessionList #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/App.tsx`,
    `packages/ui/src/components/SessionList.tsx`
  - **Deps**: T7.3
  - **Done when**: the layout matches §11.3; the session list
    fetches, creates, deletes, renames, switches sessions
- [ ] T7.5 — Chat + Composer (no streaming) #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/components/ChatView.tsx`,
    `packages/ui/src/components/MessageList.tsx`,
    `packages/ui/src/components/Composer.tsx`
  - **Deps**: T7.4
  - **Done when**: typing a message and pressing send POSTs to
    `/api/sessions/:id/messages` and renders the full assistant
    reply once it returns. Streaming added next.
- [ ] T7.6 — SSE consumer + streaming tokens #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/store/stream.ts`,
    updates to `MessageList.tsx`
  - **Deps**: T7.5
  - **Done when**: tokens appear incrementally in the UI without
    re-rendering the whole list per token. The chat view is
    responsive while streaming
- [ ] T7.7 — Markdown rendering #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/components/Markdown.tsx`,
    `packages/ui/src/components/Message.tsx`
  - **Deps**: T7.6
  - **Done when**: GFM markdown renders with tables, task lists,
    strikethrough, autolinks; code blocks are syntax-highlighted
    via `shiki`; raw HTML is sanitized; inline code is copy-on-click
- [ ] T7.8 — Tool call rendering #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/components/ToolCallBlock.tsx`
  - **Deps**: T7.6
  - **Done when**: shell output and file diffs render as
    collapsible blocks inline in the message stream
- [ ] T7.9 — Approval card #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/components/ApprovalCard.tsx`
  - **Deps**: T7.6, T5.7
  - **Done when**: when `approval_required` arrives, the card
    appears inline; Approve / Reject / Edit-and-approve buttons
    POST to `/api/sessions/:id/approve`; the agent continues
    after a decision
- [ ] T7.10 — Polish: themes, shortcuts, settings #phase7 @ready target:phase7
  - **Files**: `packages/ui/src/components/ThemeToggle.tsx`,
    `packages/ui/src/lib/shortcuts.ts`,
    `packages/ui/src/styles/global.css`
  - **Deps**: T7.9
  - **Done when**: light + dark theme (system default),
    `Cmd/Ctrl+K` session switcher, `Cmd/Ctrl+Enter` send,
    `Esc` cancel, and a basic settings page (model picker) all
    work

### Phase 8 — End-to-end verification 🧪

- [ ] T8.1 — E2E smoke script #phase8 @ready target:phase8
  - **Files**: `scripts/e2e.ts`
  - **Deps**: all of Phase 5
  - **Done when**: starts the server on an ephemeral port with
    `ScriptedProvider` and `AutoApprover`, sends a message,
    consumes the SSE stream, asserts a shell tool was called and
    the transcript was persisted
- [ ] T8.2 — UI manual smoke checklist #phase8 @ready target:phase8
  - **Files**: `docs/ui-smoke.md`
  - **Deps**: T7.10, T8.1
  - **Done when**: a written checklist (agent runs `ls`, user
    approves, result renders; agent edits a file, user sees the
    diff, approves, sees the result; switching sessions keeps
    state) is checked off in a real browser run
- [ ] T8.3 — README and quickstart #phase8 @ready target:phase8
  - **Files**: `README.md`
  - **Deps**: T6.*, T7.10
  - **Done when**: README has install, run, configure, override
    the API base URL, write a memory note, and troubleshoot
    sections

---

## Cross-cutting tasks (run continuously)

- [ ] Typecheck gate #gates @ready — every PR (or every push) runs
  `bun run typecheck` and `bun test`; both must pass.
- [ ] Lint gate #gates @ready — `eslint` with `@typescript-eslint`
  and `eslint-plugin-react` for the UI package.
- [ ] Dependency hygiene #gates @ready — `bun outdated` reviewed
  before each phase close; no `bun add` of a package with a
  non-MIT/Apache/BSD license without a note in `REQUIREMENTS.MD`.

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
