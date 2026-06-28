# Phase 1 — Design

## Module layout

```
packages/core/src/
├── types.ts              # Role, ContentBlock, Message, ToolDefinition, ToolContext, StreamEvent
├── provider.ts           # Provider interface, ProviderOverrides
├── index.ts              # public re-exports
└── providers/
    ├── anthropic.ts      # createAnthropicProvider + inferText
    ├── anthropic.test.ts # override merging, header composition, extraBody deep-merge, stream-event translation
    ├── scripted.ts       # createScriptedProvider (test double)
    └── scripted.test.ts  # playback assertions
```

## Core types

`types.ts` is the contract every other package imports. No I/O, no
React, no Fastify.

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

## Provider abstraction

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

### Anthropic provider

Lives in `packages/core/src/providers/anthropic.ts`.

- Wraps `@anthropic-ai/sdk`'s `messages.stream(...)`.
- Translates Anthropic events → our `StreamEvent`.
- A fresh `Anthropic` client is constructed per call so per-call
  `baseURL` and `defaultHeaders` do not leak between calls. Cheap,
  and avoids hidden global state.
- Override precedence: defaults < provider config < per-request
  overrides. The merge is shallow for scalars and shallow-merged for
  `headers`, `betaHeaders`, and `extraBody` (latter wins).
- `betaHeaders` are joined with `, ` and set as the `anthropic-beta`
  header.
- `extraBody` is deep-merged into the request body via a small utility
  (last write wins for keys, arrays replaced).
- Prompt caching is opt-in via the `prompt-caching-2024-07-31` beta
  header; if present, cache breakpoints are added on the system
  prompt, last user message, and last tool result.

Env wiring:

| Env var                  | Maps to                               |
| ------------------------ | ------------------------------------- |
| `MINIMAX_TOKEN`          | `apiKey` (required)                   |
| `MINIMAX_BASE_URL`       | `baseUrl` (default `https://api.minimax.io/anthropic`) |
| `MINIMAX_DEFAULT_MODEL`  | `defaultModel` (default `MiniMax-M3`) |

The provider scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` from
`process.env` before constructing the SDK client (defense in depth —
Phase 9 fix; see [[phase-09-minimax-auth|Phase 9 design]]).

`inferText(prompt)` is a thin blocking wrapper used by the title
generator. It runs `messages.create({...})` (not the streaming API)
and returns the joined text content.

### Scripted provider

`packages/core/src/providers/scripted.ts` is a `Provider` that reads
recorded responses from a JSON fixture. It is used by agent and
end-to-end tests to avoid network calls and to drive specific
tool-call sequences deterministically. Every later package's tests
use it; no test suite makes a network call.

## Testing strategy

- `core/providers/anthropic`: override merging, header composition,
  `extraBody` deep-merge, stream-event translation against a
  recorded fixture.
- `core/providers/scripted`: playback order, exhaustion behavior,
  duplicate-call safety.

## Risks & mitigations

| Risk                                          | Mitigation                                          |
| --------------------------------------------- | --------------------------------------------------- |
| Per-call SDK construction is slow             | Bench-marked; per-call cost < 1 ms and the call is network-bound. |
| Env-var scrub is fragile under env mutation   | Scrub once at construction, snapshot the resulting `process.env` keys, refuse to construct if `MINIMAX_TOKEN` is missing. |
| Provider overrides silently drop fields       | Strict override types; unknown keys on `extraBody` are still merged (deep merge is permissive by design). |
