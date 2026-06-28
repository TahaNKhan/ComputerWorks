# Phase 14 — Design

## Module layout (post-rewrite)

```
packages/server/src/
├── sse-writer.ts                 # per-response writer (new — replaces SSEManager)
├── sse.ts                        # pure: formatSSE(frame) → Uint8Array + ServerEvent union
├── interactive-approver.ts       # writes through SSEWriter; resolver map is local
├── session-runtime.ts            # SessionRegistry: Map<sessionId, SessionRuntime>
├── routes/
│   ├── messages.ts               # POST /messages — opens SSE in the response
│   ├── approve.ts                # looks up in-flight runtime via SessionRegistry
│   ├── cancel.ts                 # AbortController on the runtime
│   └── health.ts
├── app.ts                        # composition root (unchanged shape)
└── ...

packages/ui/src/store/
├── reducer.ts                    # pure (state, sessionId, ev) → state  (new)
├── reducer.test.ts               # every branch + every helper (new)
└── sessions.ts                   # zustand: applyServerEvent = (s, ev) => reduceStreamEvent(s, ev)
```

`packages/server/src/sse.ts` no longer holds an `SSEManager`. It's
just the wire-shape union plus the byte serializer.
`routes/stream.ts` is gone — there is no persistent `GET /stream`.

## Wire protocol — one turn end-to-end

The request lifecycle is now linear:

```mermaid
sequenceDiagram
    participant UI as Browser
    participant Srv as Server (Fastify)
    participant Loop as Agent loop
    participant Tool as Tool registry
    participant LLM as LLM Provider

    UI->>Srv: POST /api/sessions/:id/messages {content}
    Srv-->>UI: 200 text/event-stream (response is the channel)

    Srv->>Srv: createSSEWriter(reply)<br/>build InteractiveApprover<br/>register SessionRuntime

    Srv->>Loop: runTurn(provider, history, tools, approver, signal)

    loop each iteration
        Loop->>LLM: provider.chat({...})
        LLM-->>Loop: StreamEvent (token / tool_call / message_done)
        Loop-->>Srv: AgentEvent (token / tool_call)
        Srv-->>UI: SSE frame: token / tool_call

        alt tool_call requires approval
            Loop->>Srv: approver.request(req, signal)
            Srv-->>UI: SSE frame: approval_required
            UI->>Srv: POST /api/sessions/:id/approve {requestId, decision}
            Srv->>Loop: approver.resolveById(requestId, decision)
        end

        Loop->>Tool: registry.execute(name, input, ctx)
        Tool-->>Loop: {result, is_error}
        Loop-->>Srv: AgentEvent (tool_result)
        Srv-->>UI: SSE frame: tool_result
    end

    Loop-->>Srv: AgentEvent (done)
    Srv-->>UI: SSE frame: done + close response
```

The browser uses a single `fetch()` per message and pipes the
response body through a small SSE-frame parser. There is no
`EventSource`, no long-lived connection, no reconnect logic.

## `SSEWriter`

```ts
export interface SSEWriter {
  write(event: ServerEvent): void;
  end(): void;
  readonly closed: boolean;
}

export function createSSEWriter(reply: FastifyReply): SSEWriter {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.hijack();
  reply.raw.on('close', () => { /* flips closed=true */ });
  // write(event): serialize via formatSSE, reply.raw.write(bytes)
  // end(): emit terminal done, reply.raw.end()
}
```

- `closed: true` if the client disconnected — `write` becomes a
  no-op after that, so a stale turn can't keep writing to a dead
  socket.
- `end()` is idempotent (multiple end() calls are safe).

## `SessionRuntime` + `SessionRegistry`

```ts
export interface SessionRuntime {
  sessionId: string;
  controller: AbortController;
  approver: ApproverHandle;     // can resolveById(requestId, decision)
  startedAt: number;
}

export class SessionRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();

  startIfIdle(sessionId, approver) {
    if (this.runtimes.has(sessionId)) return { busy: true };
    const runtime = { sessionId, controller: new AbortController(),
                      approver, startedAt: Date.now() };
    this.runtimes.set(sessionId, runtime);
    return { runtime, busy: false };
  }
  cancel(sessionId) { return this.runtimes.get(sessionId)?.controller; }
  finish(sessionId) { this.runtimes.delete(sessionId); }
}
```

- One runtime per in-flight turn. The approver is scoped to the
  runtime, so `/approve` finds the right resolver without a global
  registry.
- `startIfIdle` no longer rejects — Phase 14 supports multiple
  concurrent turns on the same session, each with its own runtime.
  Concurrent turns interleave on `messages.jsonl` (the desired
  behavior — the original "409 if busy" guard is gone).

## `InteractiveApprover`

The approver now writes through the per-response `SSEWriter` (not a
global `SSEManager`). Local `Map<requestId, resolver>`, 5-minute
timeout default (configurable). `resolveById(requestId, decision)` is
what the `/approve` route calls. A decision from one tab never
resolves an approval on another because the approver is per-turn.

## UI architecture — pure reducer

The SSE → state logic moves out of the store into a pure function:

```ts
export function reduceStreamEvent(
  state: SessionsState,
  sessionId: string,
  ev: ServerEvent,
): SessionsState {
  // switch on ev.type → return new state
}
```

- The reducer is the single source of truth for SSE → state.
- The zustand store's `applyServerEvent` is a one-liner:
  `set((s) => reduceStreamEvent(s, sessionId, ev))`.
- Components are presentational; they read state via typed selectors
  and dispatch through store actions.
- No `useState` outside the composer (draft text) and the settings
  dialog (form state). No event-handling logic in JSX.

## Wire types

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

## Concurrency invariants

- A session may have at most one in-flight turn per **request** —
  each request creates its own `SessionRuntime`; multiple in-flight
  requests on the same session are explicitly supported.
- The server emits `message_start` exactly once at the beginning of
  a turn and `done` (or `error`) exactly once at the end. Clients
  may treat `done` as the connection-close marker.

## Testing strategy

- `sse-writer.test.ts`: closed flag, idempotent `end()`, write-after-close
  is a no-op.
- `session-runtime.test.ts`: `startIfIdle` returns `busy: false` on
  first call, returns the existing runtime's `controller` from
  `cancel`, removes on `finish`.
- `routes/messages.test.ts`: `app.inject()` returns
  `Content-Type: text/event-stream` with the expected event frames
  in order.
- `reducer.test.ts` (UI): every branch of the reducer + every helper
  (`appendToken`, `appendToolCall`, `applyToolResult`, `appendPart`,
  `finalizeStreaming`). Pure-function tests — no React, no zustand,
  no fetch.
- `e2e.ts` ([[phase-08-e2e-verification|Phase 8]]) exercises the
  full path: scripted provider + auto-approver + real server.

## Risks & mitigations

| Risk                                       | Mitigation                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Stale runtime after a client disconnects mid-turn | `reply.raw.on('close')` flips `closed: true` on the writer; `finish` removes the runtime. |
| Resolver map grows unbounded               | 5-minute default timeout per approval; `finish` is called from the route's finally block. |
| Two tabs accidentally resolve each other's approvals | Approver is per-turn; the `(requestId → resolver)` map is scoped to the originating request. |
| Reducer grows unwieldy                     | Keep helpers small and pure; co-locate tests; one branch per event type.   |