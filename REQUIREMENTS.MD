# ComputerWorks — Requirements

A local, single-user PC-control chatbot. A user types natural-language
requests; an LLM (Anthropic Claude) decides which tools to call; the user
approves each tool call before it executes; results stream back into a rich
markdown chat UI.

## 1. Identity

| Item             | Value                                       |
| ---------------- | ------------------------------------------- |
| Project name     | **ComputerWorks**                           |
| CLI binary       | `computerworks` (alias: `cw`)               |
| Data directory   | `~/.computerworks/`                         |
| License          | MIT                                         |
| Default port     | `4747` (127.0.0.1 only)                     |
| Default model    | `claude-sonnet-4-6` (Anthropic)             |

## 2. Tech stack

| Concern             | Choice                                          |
| ------------------- | ----------------------------------------------- |
| Runtime + pkg mgr   | **Bun** (workspaces, native TS, `bun test`)     |
| Language            | TypeScript (strict, ESM)                        |
| Server framework    | **Fastify** on Bun                              |
| LLM SDK             | `@anthropic-ai/sdk` (Messages API)              |
| UI framework        | **React + Vite + TypeScript** (SPA)             |
| Markdown rendering  | `react-markdown` + `remark-gfm` + `rehype-sanitize` + `shiki` |
| State (UI)          | `zustand`                                       |
| Validation          | `zod`                                           |
| Config loader       | `jiti` (TS config at runtime)                   |
| Tests               | `bun test`                                      |

## 3. Scope

### In scope (v1)

- Anthropic Claude as the first LLM provider, with override hooks for proxies and custom deployments (custom `baseUrl`, extra `headers`, `betaHeaders`, `extraBody`, per-request `temperature` / `maxTokens` / model).
- Pluggable `Provider` interface so additional providers (OpenAI-compatible, Ollama, etc.) can be added without touching the agent loop.
- Tools: `run_shell` (bash on Unix, PowerShell on Windows), `read_file`, `write_file`, `edit_file`, `list_dir`.
- Human-in-the-loop approval for any tool call that mutates state.
- Multi-session chat with persistent history, per-session cwd, per-session allowlist, and per-session model.
- Streaming responses to the UI (tokens + tool events).
- Full GitHub-flavored markdown rendering with syntax-highlighted code blocks.
- File-based memory (v1): the agent can read `~/.computerworks/memory/notes/*.md` and write new ones, with a `MemoryProvider` interface reserved for a v2 vector backend.

### Out of scope (v1)

- Web tools (`web_fetch`, `web_search`).
- Multi-user accounts, authentication, network bind beyond 127.0.0.1.
- Vector database / embeddings.
- MCP server support.
- Process scheduling, clipboard integration, system notifications.
- Mobile / responsive-first design.
- LaTeX/math rendering in markdown.

## 4. Functional requirements

### 4.1 LLM provider layer

- A `Provider` interface exposes `chat(...)` returning `AsyncIterable<StreamEvent>` and a `capabilities` flag set.
- `StreamEvent` is a discriminated union: `token | tool_call | tool_result | message_start | message_done | error | done`.
- The Anthropic provider is implemented using `@anthropic-ai/sdk` with `messages.stream(...)`.
- Tool use is plumbed via the native `tools` parameter, with tool results passed back as `tool_result` blocks.
- Prompt caching is enabled by default on the Anthropic provider where the model supports it.
- The provider must support the following **overrides**, applied per-request and per-config:
  - `baseUrl`
  - `apiKey`
  - `headers` (arbitrary extra HTTP headers)
  - `defaultModel` and per-session model override
  - `maxTokens`, `temperature`, `topP`, `topK`, `stopSequences`
  - `betaHeaders` (joined into `anthropic-beta`)
  - `extraBody` (deep-merged into the request body)
- Provider is selected per session; switching providers mid-session is not required.
- The interface must accommodate future providers (OpenAI-compatible, Ollama, Gemini) without changing the agent loop.

### 4.2 Tool execution

#### `run_shell`
- Platform-detected: PowerShell on Windows, bash on Unix.
- Spawned via `node:child_process`, non-interactive (no TTY).
- Returns `{ stdout, stderr, exitCode, durationMs }`.
- Hard timeout (default 60s, configurable per call).
- Working directory defaults to the session's cwd.
- Output capped (default 100KB), truncated with a visible marker if exceeded.
- Always approval-gated.

#### `read_file`
- Path is relative to the session cwd by default; absolute paths allowed if within an allowed root.
- Binary detection: refuse to read binary content (return an error suggesting the user attach directly, when attachments are added).
- Max file size cap (default 5MB).
- Returns content with line numbers.

#### `write_file`
- Creates parent directories as needed.
- UTF-8, normalized.
- Triggers a diff preview in the approval UI before approval.

#### `edit_file`
- Single-string replace by default; array-of-replaces supported.
- Atomic: all hunks must match before any write occurs.
- Approval-gated.

#### `list_dir`
- Read-only; no approval required.
- Returns entries with type, size, mtime.
- Respects `.gitignore` if the cwd is inside a git repository.

### 4.3 Approval model (critical safety surface)

- Default policy: `run_shell`, `write_file`, `edit_file` require explicit approval.
- `read_file` and `list_dir` do not require approval by default; a session-level toggle can require it.
- The approval UI must show:
  - The exact tool call (command text, file path, or full new contents).
  - A diff view for `edit_file` and `write_file`.
  - Buttons: **Approve once** / **Approve and remember for this session** / **Reject with reason** / **Edit and approve** (let the user tweak the call).
- A **per-session allowlist** of command/path patterns can skip approval.
- A **global allowlist** in `~/.computerworks/config.ts` skips approval for known-safe patterns (e.g. `git status`, `ls`).
- **Server-side enforcement**: the approval decision is enforced on the server, not just the UI. Hiding the button in the UI is not a security boundary.
- **Audit log**: every tool call + decision is appended to `sessions/<id>/audit.jsonl`.
- **Cancellation**: a running tool can be killed from the UI; subsequent steps in the same turn are aborted.

### 4.4 Sessions

- A session = a conversation with its own message history, working directory, model config, and allowlist.
- Session list shows: title (auto-generated from first message), last-active time, model badge.
- Session operations: create, rename, delete, fork (clone at a message), export as Markdown.
- Storage layout:
  ```
  ~/.computerworks/
  ├── config.ts
  ├── sessions/
  │   └── <session-id>/
  │       ├── meta.json          # title, createdAt, cwd, model, allowlist
  │       ├── messages.jsonl     # full transcript
  │       └── audit.jsonl         # tool call decisions
  └── memory/
      ├── notes/                  # agent-writable memory
      └── index.json
  ```
- Sessions are append-only on disk; compaction is a separate `computerworks compact` command.
- Session cwd is set at creation and changeable mid-session (with confirmation).

### 4.5 UI

- **Layout (v1.14+)**: mobile-first. A single column on phones
  (session list collapses behind a hamburger drawer); two columns on
  tablet (≥ 768 px); three columns on desktop (≥ 1024 px) with a
  right rail for tool / approval detail.
- **State ownership**: business logic lives in a pure reducer
  (`store/reducer.ts`); the zustand store delegates to it; React
  components are presentational. This lets us unit-test every state
  transition without rendering any component.
- **Markdown** (must-have):
  - GitHub-flavored markdown via `react-markdown` + `remark-gfm`.
  - Syntax-highlighted code blocks via `shiki` (or `rehype-highlight`).
  - Tables, task lists, strikethrough, autolinks.
  - Inline code with copy-on-click.
  - HTML in markdown sanitized (`rehype-sanitize`) — no raw `script` or `iframe`.
  - LaTeX/math is explicitly **not** supported in v1.
- **Streaming**: tokens appear incrementally; code blocks render progressively without layout thrash; no full re-render per token.
- **Tool events** rendered inline: shell commands in a collapsible "ran this" block; file diffs in a syntax-highlighted diff view.
- **Approval flow**: when the agent wants to run a tool, the chat pauses, an inline card appears with the call + Approve/Reject buttons; on rejection the agent receives the rejection reason in the next turn.
- **Stop / regenerate / edit-and-resend** controls per message.
- **Keyboard shortcuts**: `Cmd/Ctrl+K` switch sessions, `Cmd/Ctrl+Enter` send, `Esc` cancel generation.
- **Theme**: light + dark, system-preference default.
- **No telemetry**, no external fonts/CDNs by default — works fully offline once installed.
- **Tap targets**: every interactive element is ≥ 44 × 44 px so the
  UI is comfortable on touch screens without zooming. The composer
  uses `env(safe-area-inset-bottom)` to stay clear of the iPhone
  home indicator.

### 4.6 Memory (v1, file-based)

- Layout:
  ```
  ~/.computerworks/memory/
  ├── notes/
  │   ├── user-preferences.md
  │   ├── project-<name>.md
  │   └── …
  └── index.json
  ```
- Tools exposed to the agent:
  - `read_memory(name)` — read a memory file.
  - `write_memory(name, content)` — write/overwrite (approval-gated).
  - `list_memory()` — list available notes (no approval).
  - `search_memory(query)` — v1: substring + filename match across `notes/`. Vector search reserved for v2.
- Available memory is auto-injected into the system prompt as a list (title + first ~200 chars), with the agent able to `read_memory` for full content.
- The system prompt instructs the agent that it may write to memory when it learns something likely useful across sessions (preferences, recurring project facts).
- A `MemoryProvider` interface (`search`, `read`, `write`, `list`) is defined so a vector backend can be added later without changing the agent.

### 4.8 Wire protocol (v1.14+)

- **Per-message SSE** (replaces the persistent session-stream model
  used in v1.0–v1.13). Each `POST /api/sessions/:id/messages` request
  opens an SSE stream **in its own response body**. The agent turn
  runs while the response is open; events are written directly to
  the response; the response closes with a `done` (or `error`)
  frame when the turn ends.
- This means multiple concurrent conversations on the same session
  are isolated by request lifecycle, not by a shared broadcast
  manager — each gets its own stream, its own `AbortController`,
  and its own approver registry.
- The browser client uses `fetch()` + `response.body.getReader()`
  to consume the stream. There is no separate `GET /stream` route;
  clients never need to maintain a long-lived connection.
- **Approval sub-flow**: when the server needs a human decision, the
  stream emits an `approval_required` frame and pauses the agent
  loop. The client POSTs the decision to
  `/api/sessions/:id/approve`. The server keys the resolver on
  `(sessionId, requestId)` scoped to the in-flight request, so a
  decision from one tab never resolves an approval on another.
- **Concurrency invariants**:
  - A session may have at most one in-flight message request per
    browser tab; the server enforces this with `SessionRegistry`
    (a per-session `AbortController`).
  - The server emits `message_start` exactly once at the beginning
    of a turn and `done` (or `error`) exactly once at the end.
    Clients may treat `done` as the connection-close marker.

### 4.7 Configuration

- `~/.computerworks/config.ts` is the user config, validated at startup with `zod`:

  ```ts
  {
    providers: {
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseUrl: 'https://api.anthropic.com',  // overridable for proxies
        defaultModel: 'claude-sonnet-4-6',
        betaHeaders: ['prompt-caching-2024-07-31'],
        extraHeaders: { 'X-Org-Id': '...' },
      }
    },
    defaultProvider: 'anthropic',
    server: { host: '127.0.0.1', port: 4747 },
    approval: {
      autoApprove: { read: true, write: false, shell: false },
      globalShellAllowlist: [/^git status/, /^ls/],
    },
    memory: { enabled: true, root: '~/.computerworks/memory' },
  }
  ```

- Bad config fails fast with a useful error.
- Env vars override config: `COMPUTERWORKS_ANTHROPIC_API_KEY`, `COMPUTERWORKS_SERVER_PORT`, etc.
- CLI subcommands: `computerworks serve`, `computerworks config`, `computerworks sessions list/delete/export`, `computerworks memory ls/show/edit`.

## 5. Non-functional requirements

- **Performance**: first token to UI in < 500 ms after send on local; UI remains interactive during streaming (no main-thread block > 50 ms).
- **Reliability**: agent loop resumes cleanly after a tool rejection, network blip, or user abort.
- **Observability**: structured logs to stderr (JSON), no log file by default; `--verbose` adds request/response debug.
- **Tests**: unit tests for the agent loop, approval logic, provider overrides, path-traversal guards; integration test for end-to-end shell + approval flow with a stubbed provider.
- **Type safety end-to-end**: `Provider` types flow from `core` through `server` to the UI; no `any` in the public API.
- **Licensing**: MIT, dependencies all MIT/Apache-2.0/BSD-compatible.

## 6. Security & safety

- Backend binds to `127.0.0.1` only by default. Binding to other interfaces requires an explicit config flag and emits a startup warning.
- CORS locked to `http://localhost:<vite-port>` and `http://127.0.0.1:<server-port>`.
- No API keys in plaintext on disk by default; read from env, with plaintext-file fallback that emits a startup warning.
- **Path traversal protection**: file tools resolve paths and reject anything escaping the session cwd, unless the session is configured with explicit additional allowed roots.
- **Shell execution**: the `run_shell` tool takes a single command string, not argv. The system prompt tells the agent to prefer safe single-string commands. We do **not** attempt to "shell-quote" agent-supplied input — we surface what the agent wants to run and let the user decide.
- **No auto-execution** of any tool that mutates state without approval.
- **Tool output sanitization**: stdout/stderr from shell is rendered in the UI in a code block, not interpreted as markdown.
- **Configurable command denylist** (e.g. `rm -rf /`, `format c:`) — server refuses to run these and returns an error to the agent.

## 7. Reserved seams (interfaces defined, not built in v1)

- `MemoryProvider` — file implementation in v1, vector backend later.
- `Provider` — Anthropic in v1, OpenAI-compatible / Ollama / Gemini later.
- `Tool` — same interface will accommodate MCP server tools in the future.
- Sub-agents / task delegation.
- Scheduled / recurring tasks.
- Multi-user with auth and per-user isolation.

## 8. v1 definition of done

A user can:

1. `bun install && bun run build && bun run start` (or `computerworks serve`) and see the UI open.
2. Start a new session, set a working directory, chat.
3. Ask the agent to run a shell command, see the approval prompt, approve, see the result inline.
4. Ask the agent to read/edit a file, see the diff, approve, see the result.
5. Switch between multiple sessions; each keeps its own cwd, allowlist, and history.
6. Override the API base URL / headers / model in `~/.computerworks/config.ts` and have it take effect.
7. The agent reads from `~/.computerworks/memory/notes/` and writes new notes when appropriate (with approval).
8. Light + dark theme, keyboard shortcuts, no external network calls in normal operation.
