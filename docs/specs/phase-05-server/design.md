# Phase 5 — Design

> **Note** — this design captures the **Phase 5** wire protocol:
> persistent SSE per session, `SSEManager`, `GET /api/sessions/:id/stream`,
> `409` on a busy session. Phase 14 replaces this with per-message
> SSE; see [[../phase-14-per-message-sse/design]] for the
> post-rewrite shape.

## Module layout

```
packages/server/src/
├── index.ts              # CLI entry: parses argv, calls start()
├── start.ts              # start({ config, port }) → starts listening
├── app.ts                # buildApp({...}) → FastifyInstance (testable)
├── config.ts             # loads ~/.computerworks/config.ts via jiti
├── routes/
│   ├── sessions.ts       # CRUD
│   ├── messages.ts       # POST /sessions/:id/messages
│   ├── stream.ts         # GET /sessions/:id/stream (Phase 5; deleted in Phase 14)
│   └── approve.ts        # POST /sessions/:id/approve
├── sse.ts                # SSEManager (Phase 5) — see Phase 14 for replacement
├── session-store.ts      # file-based session store
├── audit.ts              # append to audit.jsonl
├── tools/
│   └── index.ts          # registers the default tool set
└── system-prompt.ts      # assembles the system prompt
```

## Key design choices

- `buildApp` is **pure** (no `listen`) and returns a configured
  `FastifyInstance`. Tests use `app.inject(...)` and never open a
  socket.
- Only one in-flight `runTurn` per session. A second `POST /messages`
  while one is in flight returns `409 Conflict`. (Phase 14 removes
  this guard.)
- The agent's `onEvent` is wired into an `SSEManager` that fans out
  events to all subscribers for the session. Every `AgentEvent`
  becomes an SSE `data:` frame.

## Wire protocol (Phase 5)

The persistent `GET /api/sessions/:id/stream` route is opened by
the UI on session boot and held open across turns. Events are:

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

The `SSEManager` heartbeats every 15 s on idle streams and cleans up
on subscriber disconnect.

## Routes

| Method | Path                              | Purpose                          |
| ------ | --------------------------------- | -------------------------------- |
| GET    | `/api/health`                     | Liveness                         |
| GET    | `/api/sessions`                   | List sessions                    |
| POST   | `/api/sessions`                   | Create session                   |
| GET    | `/api/sessions/:id`               | Fetch transcript + meta          |
| PATCH  | `/api/sessions/:id`               | Rename / change cwd / model      |
| DELETE | `/api/sessions/:id`               | Delete session                   |
| POST   | `/api/sessions/:id/fork`          | Fork at a message id             |
| POST   | `/api/sessions/:id/messages`      | Send a user message (204 + SSE side-channel) |
| GET    | `/api/sessions/:id/stream`        | Persistent SSE stream for this session (Phase 5; removed in Phase 14) |
| POST   | `/api/sessions/:id/approve`       | Approve / reject a pending tool  |
| POST   | `/api/sessions/:id/cancel`        | Abort in-flight run              |

All bodies are JSON. All bodies validated with `zod`. The
`/messages` endpoint returns `204 No Content` and queues the turn;
the actual events flow over the persistent `/stream` connection.

## Session store

`packages/server/src/session-store.ts` is deliberately simple — no
database, no migration system in v1.

- `meta.json`: `{ id, title, createdAt, updatedAt, cwd, model,
  provider, allowlist, systemPromptOverrides? }`
- `messages.jsonl`: append-only, one JSON `Message` per line.
- `audit.jsonl`: append-only, one JSON entry per tool call +
  decision.

Writes are atomic per line (`fs.appendFile`); the whole file is
never loaded in memory. Reads stream the file. `meta.json` uses
tmp+rename for atomicity.

Compaction (future): `computerworks compact <id>` rewrites
`messages.jsonl` keeping only the last N tool turns verbatim and a
model-generated summary of older turns. Not in v1.

## Configuration

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

## Testing strategy

- `config.test.ts`: temp config file + process-env tweaks.
- `session-store.test.ts`: round-trip with several messages and
  audit entries; concurrent append safety.
- `app.test.ts`: `app.inject(...)` for every non-`/stream` route.
- `interactive-approver.test.ts`: fake `SSEManager` + fake
  responder.
- `routes/messages.test.ts`: scripted provider + auto-approver,
  send a message, assert the agent requested a tool and the tool
  result was appended.

## Risks & mitigations

| Risk                                       | Mitigation                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Persistent SSE never reconnects on tab close | Server heartbeats every 15 s; cleanup on `req.raw.on('close')`.            |
| Two tabs fighting for the same broadcast   | Documented limitation of Phase 5; resolved in [[../phase-14-per-message-sse/design]] by removing the broadcast. |
| Non-loopback bind exposes the agent        | `--allow-non-loopback` is an explicit opt-in with a startup warning.        |