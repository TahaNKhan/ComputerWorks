# Phase 1 — Requirements

## Purpose

Establish the type contract that holds the system together and the
provider abstraction that lets the agent loop talk to any
Anthropic-compatible LLM endpoint. Everything else in the system
depends on these definitions; nothing here depends on anything else.

## Functional requirements

### Core types (`packages/core/src/types.ts`)

- FR-1. `Role` is `'user' | 'assistant' | 'system' | 'tool'`.
- FR-2. `ContentBlock` is the discriminated union
  `TextBlock | ToolUseBlock | ToolResultBlock`.
- FR-3. `Message` is `{ role: Role; content: ContentBlock[] | string }`.
- FR-4. `ToolContext` is
  `{ cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv;
  sessionId: string }`.
- FR-5. `ToolDefinition<TInput, TOutput>` is
  `{ name; description; inputSchema: z.ZodType<TInput>;
  requiresApproval: boolean; execute(input, ctx): Promise<TOutput> }`.
- FR-6. `StreamEvent` is the discriminated union
  `message_start | token | tool_call | tool_result | message_done |
  error | done`.

### Provider interface (`packages/core/src/provider.ts`)

- FR-7. `Provider` exposes `chat(req): AsyncIterable<StreamEvent>` and
  a `capabilities` flag set (`toolUse`, `promptCaching`, `vision`).
- FR-8. `ProviderOverrides` lists every per-request knob:
  `baseUrl`, `apiKey`, `headers`, `maxTokens`, `temperature`,
  `topP`, `topK`, `stopSequences`, `betaHeaders`, `extraBody`.
- FR-9. Merge order is **defaults < provider config < per-request**;
  the per-request value always wins.

### Anthropic provider (`packages/core/src/providers/anthropic.ts`)

- FR-10. `createAnthropicProvider(config)` returns a `Provider`.
- FR-11. Wraps `@anthropic-ai/sdk`'s `messages.stream(...)`.
- FR-12. Translates Anthropic SDK events into our `StreamEvent` union.
- FR-13. `betaHeaders` are joined with `, ` and set as the
  `anthropic-beta` header.
- FR-14. `extraBody` is deep-merged into the request body (last write
  wins).
- FR-15. A fresh `Anthropic` client is constructed per call so per-call
  `baseURL` and `defaultHeaders` do not leak between calls.
- FR-16. Prompt caching is opt-in via the
  `prompt-caching-2024-07-31` beta header; when present, cache
  breakpoints are added on the system prompt, the last user message,
  and the last tool result.
- FR-17. Reads `MINIMAX_TOKEN` / `MINIMAX_BASE_URL` /
  `MINIMAX_DEFAULT_MODEL` from env (default model `MiniMax-M3`).
- FR-18. Scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` before
  constructing the SDK client so the wrong env can't leak through.
- FR-19. Uses `authToken` (Bearer) instead of `apiKey` (`x-api-key`)
  because MiniMax's Anthropic-compatible endpoint expects Bearer.
- FR-20. Throws a clear error if `MINIMAX_TOKEN` is missing.
- FR-21. Exposes `inferText(prompt)` for one-shot blocking calls
  (used by the title generator in [[phase-12-url-and-titles]]).

### Scripted test provider (`packages/core/src/providers/scripted.ts`)

- FR-22. `createScriptedProvider(script)` plays back a list of
  pre-canned `StreamEvent` sequences.
- FR-23. Used by every later package's tests to avoid network calls
  and to drive specific tool-call sequences deterministically.

## Non-functional requirements

- No I/O in `types.ts`. Pure types only.
- Strict TypeScript (`noUncheckedIndexedAccess`) compiles cleanly.
- Override merging is unit tested for every supported field.
- Stream-event translation is unit tested against a recorded fixture.

## Out of scope

- Multi-provider routing (one provider per session is fine for v1).
- Streaming-cancellation through the Anthropic SDK (`AbortSignal`
  plumbing comes in [[phase-02-agent-loop]]).
- Tool-use streaming deltas (one `tool_use` block per call).

## Constraints

- `@anthropic-ai/sdk` is the only LLM SDK dependency.
- `zod` is the only validation library.

## Acceptance criteria

- `bun run typecheck` passes for `core` alone (no other package
  depends on it yet).
- Unit tests cover override merging for `baseUrl`, `apiKey`,
  `headers`, `betaHeaders`, `extraBody`.
- Unit tests cover stream-event translation against a recorded
  fixture.
- A missing `MINIMAX_TOKEN` produces a clear, actionable error.

## Open questions

None at acceptance.
