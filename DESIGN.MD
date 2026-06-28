# ComputerWorks — Technical Design

This document describes the architecture, data model, and module
boundaries for v1. It assumes the requirements in `REQUIREMENTS.MD` are
fixed.

## 1. Goals and non-goals

**Goals**

- A single-user, local-first agent that is safe enough to grant access
  to a real machine.
- A `Provider` abstraction that can grow to support multiple LLM
  backends without touching the agent loop.
- A `Tool` abstraction that the same agent loop can drive today (shell
  + file tools) and that MCP servers can plug into later.
- A `MemoryProvider` abstraction so the v1 file backend can be
  replaced by a vector backend without agent changes.
- Streaming end-to-end: tokens, tool calls, and approval requests
  must reach the UI in real time.

**Non-goals (v1)**

- Multi-tenant / multi-user.
- Vector memory.
- MCP servers.
- Web tools.
- Process scheduling, clipboard, system notifications.

## 2. High-level architecture

```
                ┌─────────────────────────────────────────────┐
                │           Browser (React SPA, mobile-first) │
                │  Pure reducer · zustand store · components  │
                │  Session list · Chat · Tool cards · Approve │
                └────────────────────┬────────────────────────┘
                                     │  POST /messages (SSE in response)
                ┌────────────────────▼────────────────────────┐
                │            Server (Fastify on Bun)          │
                │  routes · SSE writer (per request)          │
                │  config loader · audit log · session store  │
                └───┬─────────────┬─────────────┬─────────────┘
                    │             │             │
        ┌───────────▼──┐   ┌──────▼──────┐   ┌───▼──────────┐
        │ Agent loop   │   │ Tool shell  │   │ Tool files   │
        │ (history,    │   │ run_shell   │   │ r/w/edit/ls  │
        │  approvals)  │   └─────────────┘   └──────────────┘
        └──────┬───────┘
               │
   ┌───────────▼────────────┐    ┌─────────────────────────┐
   │ Provider: Anthropic    │    │ Memory provider (files) │
   │ (overrides, streaming) │    │ notes/*.md              │
   └────────────────────────┘    └─────────────────────────┘
```

### 2.1 Wire protocol — per-message SSE (v1.14+)

Before v1.14, the browser opened **one persistent SSE connection per
session** (`GET /api/sessions/:id/stream`) and the server kept that
connection open across turns using an `SSEManager` that broadcast
events to all subscribers. Two complications:

1. Two browser tabs on the same session shared one broadcast queue;
   every event went to every tab, so an approval request opened in
   tab A was visible to tab B.
2. The `POST /messages` → `204 No Content` → background-agent pattern
   required the client to keep a long-lived connection alive across
   many minutes and reconcile any disconnects.

v1.14 replaces this with **per-message SSE**:

- `POST /api/sessions/:id/messages` opens an SSE response. Events are
  written directly to that response by the agent loop. The stream
  closes when the turn ends (terminal `done` or `error` frame).
- The persistent `GET /stream` route is gone. There is no
  `SSEManager` — only a small `SSEWriter` helper that owns one
  response object and serializes frames into it.
- The interactive approver holds the `(requestId → resolver)` map
  for the duration of one turn. Approvals are scoped to the
  originating request — a different tab making a decision resolves
  the approver for that turn only.
- Multiple in-flight turns on the same session are NOT supported
  (one turn at a time per session), but multiple **tabs** on the
  same session are — each tab holds its own request and its own
  response stream, and there is no global broadcast step.

### 2.2 UI architecture (v1.14+)

- **Reducer-first state**: the SSE-event reducer in
  `packages/ui/src/store/reducer.ts` is a pure function
  `(state, event) → state`. It has no React, no zustand, no fetch.
- The **zustand store** in `packages/ui/src/store/sessions.ts`
  delegates `applyServerEvent` to the reducer and owns the network
  side-effects (POST `/messages`, POST `/approve`, etc.).
- **Components** are presentational. They select state via
  typed selectors and dispatch through store actions. No
  `useState` outside the composer (draft text) and the settings
  dialog (form state). No event-handling logic in JSX.

## 3. Monorepo layout

```
computerworks/
├── package.json              # name, private:true, workspaces, scripts
├── bunfig.toml               # bun config
├── tsconfig.base.json        # strict, ESM, bundler resolution
├── .gitignore
├── .editorconfig
├── .nvmrc                    # 20
├── README.md
├── LICENSE                   # MIT
├── REQUIREMENTS.MD
├── DESIGN.MD
├── TASKS.MD
└── packages/
    ├── core/                 # types, Provider interface, Anthropic provider
    ├── agent/                # agent loop, tool registry, approval logic
    ├── tools-shell/          # run_shell
    ├── tools-files/          # read/write/edit/list_dir
    ├── memory-files/         # file-based MemoryProvider
    ├── server/               # Fastify app, routes, SSE, session store
    └── ui/                   # React + Vite SPA
```

**Package dependency graph** (arrows = "depends on"):

```
core  ◄── agent
core  ◄── tools-shell
core  ◄── tools-files
core  ◄── memory-files
core  ◄── server
agent ◄── server
memory-files ◄── server
tools-shell, tools-files, memory-files ◄── server
(core/providers/anthropic lives inside core)
```

The UI talks to the server over HTTP+SSE only. It does not import
`core`, `agent`, or any tool package directly.

## 4. Core types

`packages/core/src/types.ts` is the contract that holds the system
together. Every other package depends on these types.

```ts
// Roles and content blocks
export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type TextBlock       = { type: 'text'; text: string };
export type ToolUseBlock    = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string;
                                content: string; is_error?: boolean };
export type ContentBlock    = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[] | string;
}

// Tool protocol
export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;     // sanitized
  sessionId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  requiresApproval: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

// Streaming events from a Provider
export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; call: ToolUseBlock }
  | { type: 'tool_result'; call_id: string; result: unknown; is_error: boolean }
  | { type: 'message_done'; usage: { input: number; output: number } }
  | { type: 'error'; message: string }
  | { type: 'done' };
```

## 5. Provider abstraction

`packages/core/src/provider.ts`:

```ts
export interface ProviderOverrides {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  betaHeaders?: string[];
  extraBody?: Record<string, unknown>;
}

export interface Provider {
  readonly id: string;             // 'anthropic'
  readonly capabilities: {
    toolUse: boolean;
    promptCaching: boolean;
    vision: boolean;
  };

  chat(req: {
    model: string;
    system?: string;
    messages: Message[];
    tools: ToolDefinition[];
    overrides?: ProviderOverrides;
    signal?: AbortSignal;
  }): AsyncIterable<StreamEvent>;
}
```

### 5.1 Anthropic provider

Lives in `packages/core/src/providers/anthropic.ts`.

- Wraps `@anthropic-ai/sdk`'s `messages.stream(...)`.
- Translates Anthropic events → our `StreamEvent`.
- A fresh `Anthropic` client is constructed per call so per-call
  `baseURL` and `defaultHeaders` do not leak between calls. Cheap, and
  avoids hidden global state.
- Override precedence: defaults < provider config < per-request
  overrides. The merge is shallow for scalars and shallow-merged for
  `headers`, `betaHeaders`, and `extraBody` (latter wins).
- `betaHeaders` are joined with `, ` and set as the
  `anthropic-beta` header.
- `extraBody` is deep-merged into the request body via a small
  utility (last write wins for keys, arrays replaced).
- Prompt caching is opt-in via the `prompt-caching-2024-07-31` beta
  header; if present, cache breakpoints are added on the system
  prompt, last user message, and last tool result.

### 5.2 Test provider

`packages/core/src/providers/scripted.ts` is a `Provider` that reads
recorded responses from a JSON fixture. It is used by agent and
end-to-end tests to avoid network calls and to drive specific
tool-call sequences deterministically.

## 6. Agent loop

`packages/agent/src/loop.ts`:

```ts
export type AgentEvent =
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; call: ToolUseBlock }
  | { type: 'tool_result'; call_id: string; result: unknown;
      is_error: boolean; approved: boolean }
  | { type: 'turn_done' }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  provider: Provider;
  model: string;
  system: string;
  history: Message[];
  tools: ToolDefinition[];
  approver: Approver;
  overrides?: ProviderOverrides;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  maxIterations?: number;     // default 25
}

export async function runTurn(opts: AgentRunOptions): Promise<Message>;
```

### 6.1 State machine

```
                   ┌──────────────┐
       user msg ──►│ append user  │
                   └──────┬───────┘
                          ▼
              ┌──────────────────────┐
              │  stream from         │◄────────┐
              │  provider            │         │
              └──────────┬───────────┘         │
                         │                     │
                ┌────────▼─────────┐           │
                │  text delta?     │           │
                │  → emit token    │           │
                │  → accumulate    │           │
                └────────┬─────────┘           │
                         │                     │
                ┌────────▼─────────┐           │
                │  tool_use block? │           │
                │  → emit tool_call│           │
                │  → approver      │           │
                └────────┬─────────┘           │
                         │                     │
              ┌──────────▼───────────┐         │
              │ approved?            │         │
              ├── yes ─► execute ────┼──► append tool_result ──┘
              └── no  ─► append tool_result (is_error, reason)
```

### 6.2 Loop guards

- **Iteration cap** (`maxIterations`, default 25): if the agent
  requests more than 25 tool calls in one turn, the loop terminates
  with an `error` event and a synthetic tool result informing the
  model.
- **Cancellation**: `signal` is threaded into every `await` and into
  the provider's stream. Cancellation throws `AbortError`; the
  partial assistant message is **not** appended to history.
- **Provider errors**: surfaced as `AgentEvent.error`. The partial
  assistant message is not appended; the user can retry.
- **Tool errors**: appended to history as `tool_result` with
  `is_error: true` so the model can self-correct.

## 7. Approval model

`packages/agent/src/approval.ts`:

```ts
export interface ApprovalRequest {
  call: ToolUseBlock;
  description: string;          // human-readable summary
  diff?: string;                // for write/edit_file
}

export type ApprovalDecision =
  | { kind: 'approve_once' }
  | { kind: 'approve_for_session'; pattern: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'edit'; newInput: unknown };

export interface Approver {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}
```

### 7.1 Implementations

- `InteractiveApprover` (server-only): assigns a `requestId`, sends
  an `approval_required` SSE event with the request payload, and
  waits for a matching `POST /sessions/:id/approve`. Resolution is
  done with a `Map<requestId, {resolve, reject, signal}>`.
- `AutoApprover` (tests): takes a policy function. Used in unit
  tests and the end-to-end smoke test.

### 7.2 Allowlist application

- The `InteractiveApprover` checks the global allowlist and the
  session allowlist **before** sending the SSE event. A matching
  pattern means the call proceeds without a UI prompt, but the
  decision is still logged to the audit log.
- Pattern matching is regex; matching is done against the canonical
  command string (after trimming whitespace).
- An **Approve and remember for this session** decision from the UI
  adds a pattern to the session's allowlist and persists it in
  `meta.json`.

### 7.3 Audit log

Every call + decision is appended to `sessions/<id>/audit.jsonl`:

```json
{ "ts": "2026-06-24T12:34:56.789Z",
  "call": { "id": "...", "name": "run_shell", "input": { "command": "npm test" } },
  "decision": { "kind": "approve_once" } }
```

## 8. Server (Fastify on Bun)

### 8.1 Module layout

```
packages/server/src/
├── index.ts              # CLI entry: parses argv, calls start()
├── start.ts              # start({ config, port }) → starts listening
├── app.ts                # buildApp({...}) → FastifyInstance (testable)
├── config.ts             # loads ~/.computerworks/config.ts via jiti
├── routes/
│   ├── sessions.ts       # CRUD
│   ├── messages.ts       # POST /sessions/:id/messages (SSE in response)
│   └── approve.ts        # POST /sessions/:id/approve
├── sse-writer.ts         # SSEWriter: owns one response, frames events
├── sse.ts                # pure: formatSSE(frame) → Uint8Array
├── session-store.ts      # file-based session store
├── audit.ts              # append to audit.jsonl
├── tools/
│   └── index.ts          # registers the default tool set
└── system-prompt.ts      # assembles the system prompt
```

### 8.2 Key design choices

- `buildApp` is **pure** (no `listen`) and returns a configured
  `FastifyInstance`. Tests use `app.inject(...)` and never open a
  socket.
- Only one in-flight `runTurn` per session. A second `POST /messages`
  while one is in flight returns `409 Conflict`.
- The agent's `onEvent` is wired into an `SSEWriter` that owns the
  response stream for the current request. Every `AgentEvent`
  becomes an SSE `data:` frame in that response; the writer flushes
  on every event and closes the response with a terminal `done`
  frame when the turn ends.
- The `InteractiveApprover` writes through the same `SSEWriter`,
  scoped to the request, so an approval card is delivered to the
  request that triggered it and never leaks to another connection.
  The `/approve` route looks up the request's resolver map by
  `requestId` and resolves it.
- The client uses a single `fetch()` call per message and pipes the
  response body through a small SSE-frame parser. There is no
  `EventSource`, no long-lived connection, no reconnect logic.

### 8.3 SSE protocol

Wire types (shared with the UI):

```ts
type ServerEvent =
  | { type: 'message_start' }
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; call: ToolUseBlock }
  | { type: 'approval_required'; requestId: string;
      tool: ToolUseBlock; description: string; diff?: string }
  | { type: 'tool_result'; call_id: string; approved: boolean;
      result?: unknown; is_error: boolean; reason?: string }
  | { type: 'message_done'; usage: { input: number; output: number } }
  | { type: 'session_renamed'; sessionId: string; title: string }
  | { type: 'error'; message: string }
  | { type: 'done' };
```

SSE framing:

```
event: token             data: {"delta":"Hel"}
event: tool_call         data: {"id":"…","name":"run_shell","input":{…}}
event: approval_required data: {"requestId":"…","tool":{…},"diff":null}
event: tool_result       data: {"call_id":"…","approved":true,"result":{…}}
event: message_done      data: {"usage":{…}}
event: error             data: {"message":"…"}
event: done              data: {}
```

A `done` frame is the connection-close marker — clients may treat
the response stream as terminated once `done` arrives. No
heartbeats: the request owns its own stream and a single message
turn never approaches a proxy timeout in practice.

### 8.4 Routes

| Method | Path                              | Purpose                          |
| ------ | --------------------------------- | -------------------------------- |
| GET    | `/api/health`                     | Liveness                         |
| GET    | `/api/sessions`                   | List sessions                    |
| POST   | `/api/sessions`                   | Create session                   |
| GET    | `/api/sessions/:id`               | Fetch transcript + meta          |
| PATCH  | `/api/sessions/:id`               | Rename / change cwd / model      |
| DELETE | `/api/sessions/:id`               | Delete session                   |
| POST   | `/api/sessions/:id/fork`          | Fork at a message id             |
| POST   | `/api/sessions/:id/messages`      | Send a user message (SSE response) |
| POST   | `/api/sessions/:id/approve`       | Approve / reject a pending tool  |
| POST   | `/api/sessions/:id/cancel`        | Abort in-flight run              |

All bodies are JSON. All bodies validated with `zod`. The
`/messages` endpoint returns `Content-Type: text/event-stream`;
all other endpoints return JSON.

## 9. Session store

`packages/server/src/session-store.ts` is deliberately simple — no
database, no migration system in v1.

- `meta.json`: `{ id, title, createdAt, updatedAt, cwd, model,
  provider, allowlist, systemPromptOverrides? }`
- `messages.jsonl`: append-only, one JSON `Message` per line.
- `audit.jsonl`: append-only, one JSON entry per tool call +
  decision.

Writes are atomic per line (`fs.appendFile`); the whole file is
never loaded in memory. Reads stream the file.

Compaction (future): `computerworks compact <id>` rewrites
`messages.jsonl` keeping only the last N tool turns verbatim and a
model-generated summary of older turns. Not in v1.

## 10. Memory provider

`packages/memory-files/src/index.ts` implements:

```ts
export interface MemoryProvider {
  list(): Promise<{ name: string; preview: string }[]>;
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<void>;
  search(query: string): Promise<{ name: string; snippet: string }[]>;
}
```

- `search` in v1: case-insensitive substring + filename match,
  returning up to 10 hits.
- `write` is exposed to the agent as a `write_memory` tool that is
  approval-gated.
- The server's `system-prompt.ts` calls `memory.list()` once per
  turn and injects a compact directory (`# Memory\n- <name>:
  <preview>`) into the system prompt.

## 11. UI architecture

`packages/ui/`:

```
src/
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
│   └── ThemeToggle.tsx
├── styles/
│   └── global.css
└── lib/
    ├── shortcuts.ts
    └── format.ts
```

### 11.1 Streaming in the UI

- A single `EventSource` per active session is held in `stream.ts`.
- The stream consumer dispatches into a `Map<messageId, TokenBuffer>`.
- The chat view reads the buffer via a ref (not state) and updates
  the DOM directly for incremental token appends. The component
  re-renders only on structural changes (new message, new tool
  block, approval request).
- Approval cards appear inline as soon as `approval_required`
  arrives; the stream consumer sends the user's decision to
  `POST /approve` and continues consuming.

### 11.2 Markdown component

`Markdown.tsx` configures:

- `react-markdown` with `remark-gfm` and `rehype-sanitize`
  (default schema).
- Code blocks: `rehype-shiki` (server-side highlight) or a
  `pre > code` `code` component that lazy-loads `shiki` and caches
  grammars.
- Inline code: copy-on-click via a small `<button>` overlay.
- No math / no raw HTML.

### 11.3 Layout

Three-pane CSS grid:

```
+----------+----------------------+----------------+
| Sessions | Chat (message list + | Tool panel     |
|          | composer)            | (collapsible)  |
+----------+----------------------+----------------+
```

The right pane shows the most recent tool call details (full
output, diff) so long shell output doesn't dominate the chat.

## 12. Configuration

Loaded once at server start from `~/.computerworks/config.ts` via
`jiti`. Schema (in `packages/server/src/config.ts`):

```ts
const ConfigSchema = z.object({
  providers: z.object({
    anthropic: z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().url().default('https://api.anthropic.com'),
      defaultModel: z.string().default('claude-sonnet-4-6'),
      betaHeaders: z.array(z.string()).default([]),
      extraHeaders: z.record(z.string()).default({}),
      maxTokens: z.number().int().positive().optional(),
      temperature: z.number().min(0).max(2).optional(),
    }).default({}),
  }).default({}),
  defaultProvider: z.literal('anthropic').default('anthropic'),
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(4747),
  }).default({}),
  approval: z.object({
    autoApprove: z.object({
      read: z.boolean().default(true),
      write: z.boolean().default(false),
      shell: z.boolean().default(false),
    }).default({}),
    globalShellAllowlist: z.array(z.instanceof(RegExp)).default([]),
    shellDenylist: z.array(z.instanceof(RegExp)).default([
      /rm\s+-rf\s+\//, /format\s+c:/i, /mkfs/, /dd\s+if=/,
    ]),
  }).default({}),
  memory: z.object({
    enabled: z.boolean().default(true),
    root: z.string().default('~/.computerworks/memory'),
  }).default({}),
});
```

Env overrides (read before file config):

| Env var                            | Maps to                              |
| ---------------------------------- | ------------------------------------ |
| `COMPUTERWORKS_ANTHROPIC_API_KEY`  | `providers.anthropic.apiKey`         |
| `COMPUTERWORKS_ANTHROPIC_BASE_URL` | `providers.anthropic.baseUrl`        |
| `COMPUTERWORKS_SERVER_PORT`        | `server.port`                        |
| `COMPUTERWORKS_SERVER_HOST`        | `server.host`                        |

## 13. Testing strategy

- **Unit (per package)**: `bun test` with colocated `*.test.ts`.
  - `core/providers/anthropic`: override merging, header composition,
    `extraBody` deep-merge, stream-event translation against a
    recorded fixture.
  - `agent`: loop termination, rejection recovery, iteration cap,
    cancellation, error propagation.
  - `tools-files`: path-traversal rejection, binary detection,
    atomic edit, encoding round-trip.
  - `tools-shell`: timeout enforcement, output truncation, non-zero
    exit handling, denylist enforcement.
  - `memory-files`: read/write/search round-trip, missing-file
    handling.
  - `server`: `app.inject()` for every route, SSE smoke test.
- **End-to-end smoke**: `scripts/e2e.ts` starts the server on an
  ephemeral port with a `ScriptedProvider` and `AutoApprover`, sends
  a message, consumes the SSE stream, asserts a shell tool was
  called and the transcript was persisted.
- **Manual UI smoke**: agent runs `ls`, user approves, result
  renders. The most important human check.

## 14. Build / install / dev workflow

- `bun install` — installs all workspaces.
- `bun run typecheck` — `tsc --noEmit` across workspaces.
- `bun run test` — `bun test` everywhere.
- `bun run dev` — runs `server` and `ui` in parallel (the `ui` dev
  server proxies `/api` to the `server` port).
- `bun run build` — builds all packages (`tsc -b` for libraries,
  `vite build` for the UI).
- `bun run start` — `computerworks serve` against the built output.
- `bun run start:dev` — same as `dev` but with file watching.

## 15. Failure modes and how we handle them

| Failure                              | Handling                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Provider 4xx/5xx                     | Surface as `error` SSE event; partial assistant msg dropped; user retries |
| Tool call exceeds iteration cap      | Synthetic `tool_result` with `is_error: true`; loop terminates           |
| Tool execution throws                | Caught, returned as `tool_result` with `is_error: true`; agent recovers  |
| User aborts mid-tool                 | `AbortSignal` cancels the child process and the provider stream          |
| Approval request times out           | Default: 5 minutes; auto-rejects with reason "approval timed out"        |
| Disk full on append                  | Caught at write time, surfaced as `error`, no partial commit             |
| Stale `EventSource` reconnect        | Client sends `Last-Event-ID`; server replays from `audit.jsonl`          |
| Shell command in denylist            | Refused at server, returned as tool error to the agent                   |
| Path traversal attempt               | Refused at tool boundary with a clear error                             |
