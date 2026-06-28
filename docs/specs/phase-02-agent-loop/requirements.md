# Phase 2 — Requirements

## Purpose

Implement the agent loop — the state machine that drives a single
turn: stream from the provider, collect tokens and at most one tool
call, ask the approver if the tool requires approval, execute the
tool, append the result, repeat. This is the only place in the
system that owns turn-level coordination; everything else plugs into
it.

## Users / actors

- **The server** — calls `runTurn(...)` once per user message turn.
- **The agent loop** — coordinates provider, approver, registry.
- **The provider** — yields `StreamEvent`s.
- **The approver** — gates tool calls that mutate state.
- **The tool registry** — validates input, executes the tool.

## Functional requirements

### Approval (`packages/agent/src/approval.ts`)

- FR-1. `Approver` is an interface with one method:
  `request(req, signal): Promise<ApprovalDecision>`.
- FR-2. `ApprovalDecision` is the discriminated union
  `approve_once | approve_for_session | reject | edit`.
- FR-3. `AutoApprover` accepts a policy function
  `(req, signal) => Decision | Promise<Decision>`. Used by tests and
  the end-to-end smoke to drive approval without a UI.

### Tool registry (`packages/agent/src/registry.ts`)

- FR-4. `ToolRegistry.register(tool)` / `.get(name)` / `.list()` /
  `.execute(name, input, ctx)`.
- FR-5. `execute` validates input against the tool's zod schema and
  throws a typed `ToolValidationError` on shape failures (not a raw
  `ZodError`).
- FR-6. Unknown tools produce a clear error message (no silent
  fallback).

### Agent loop (`packages/agent/src/loop.ts`)

- FR-7. `runTurn(opts)` returns the new assistant message(s) appended
  to `history`.
- FR-8. Each iteration calls `provider.chat(...)` once, collects token
  deltas in `textAccum` and at most one `tool_call`.
- FR-9. If `tool_call` arrived, append the assistant message, call
  `approver.request(...)` (only if `tool.requiresApproval`), then run
  the tool via the registry.
- FR-10. On `approval.kind === 'reject'`, append a `tool_result` with
  `is_error: true` and the rejection reason — the loop continues so
  the model can self-correct.
- FR-11. On `approval.kind === 'edit'`, run with the edited input.

## Loop guards

- FR-12. **Iteration cap** (`maxIterations`, default 25): if the
  agent requests more than 25 tool calls in one turn, the loop
  terminates with an `error` event and a synthetic tool result
  informing the model.
- FR-13. **Cancellation**: `signal` is threaded into every `await`
  and into the provider's stream. Cancellation throws `AbortError`;
  the partial assistant message is **not** appended to history.
- FR-14. **Provider errors**: surfaced as `AgentEvent.error`. The
  partial assistant message is not appended; the user can retry.
- FR-15. **Tool errors**: appended to history as `tool_result` with
  `is_error: true` so the model can self-correct.

## Non-functional requirements

- The loop has zero React / Fastify / filesystem dependencies.
- All branches are unit-tested with the scripted provider.
- Strict TypeScript with no `any` in the public API.

## Out of scope

- Multi-agent / sub-agent delegation (a reserved seam in
  [[phase-05-server|Phase 5 design]]).
- Persistent memory of past turns inside the loop (the server owns
  history persistence; see [[phase-05-server]]).
- Parallel tool calls within one iteration (single tool call per
  iteration is the current shape; future enhancement).

## Constraints

- No new dependencies.

## Acceptance criteria

- Tests cover: happy path, rejection recovery, iteration cap,
  cancellation, provider error, tool error.
- `bun run typecheck && bun test` is green.

## Open questions

None at acceptance.
