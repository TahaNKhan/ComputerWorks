# Phase 19 — LLM-driven retitle: Requirements

## Purpose

T12.2 generates a session title from the first turn, then freezes
it. By the third or fourth message the title is no longer
representative. The user has no way to fix that without manually
renaming. A cadence-based retitler (every N messages) was the
first draft of this phase, but the LLM already has the
conversation in its context — it can decide better than a counter
when to rename, and a single tool call is cheaper than a
background LLM call.

This phase replaces T12.2 with a single path: the model calls a
new `rename_session` tool whenever it sees a topic shift. The
tool is auto-approved, server-side rate-limited, and respects
manual renames. The first-turn title becomes a tool call on turn
1 (or whenever the model first feels confident) — no separate
background generator.

## Users / actors

- **End user** — the single human at the keyboard. Wants sidebar
  titles that reflect what each session is currently about, without
  doing it themselves.
- **Operator** — same person, dev role. Wants to disable or
  retune the LLM-driven retitler without code changes.
- **Model** — the LLM running the agent loop. Decides when the
  title is stale and calls the tool. Reads the system-prompt
  instruction for guidance.
- **Auditor** — reads `meta.json` and the audit log to understand
  when a rename happened and why. The `session_renamed` SSE
  event + the `lastRenamedAtMessageCount` field make this
  auditable.

## User stories

1. **Drifting topic.** A user starts a session about a Postgres
   backup script, then pivots to a React component on the third
   message. The model renames the session on the third turn
   (subject to the rate limit). The sidebar title updates with a
   slide-in animation.
2. **Long focused session.** A 50-message session on a single
   topic. The model never renames — the rate limit is irrelevant
   because the model doesn't try. The original (turn-1) title
   sticks.
3. **Manual rename sticks.** A user renames a session to
   "DO NOT AUTO-RENAME". The model tries to rename on the next
   turn; the tool rejects with `manual_rename_locked`. The
   sidebar shows the user's title forever (until the user
   resets via `title: ""`).
4. **Titled on create.** A user creates a session with
   `createSession({ title: "Sprint planning" })`. `titleSource`
   is `"manual"`. The model's first-turn rename attempt is
   rejected with `manual_rename_locked`.
5. **Model over-renames.** A pathological model renames every
   turn. The rate limit blocks renames where
   `userMessageCount - lastRenamedAtMessageCount < 3`. The model
   gets a structured `rate_limited` result and (per the system
   prompt) learns to back off.
6. **Disabled.** The operator sets
   `COMPUTERWORKS_TITLE_LLM_DECIDES=false`. The system-prompt
   instruction is removed; the model never calls the tool. The
   existing `createSession({ title })` and PATCH rename paths
   still work.
7. **Animation.** When the title changes because of an
   auto-rename, the new title slides in from the left over
   ~280ms. Manual renames do NOT animate. Switching sessions,
   cold start, and identical-title renders do NOT animate.

## Functional requirements

### FR-1 — `rename_session` tool

A new tool registered in `defaultTools`:

- **Name:** `rename_session`
- **Description:** `"Update the session title visible in the sidebar. Call this when the conversation topic has drifted and the current title is no longer representative. The title should be 3-5 words, lowercase unless a word is a proper noun. Do not call this on every turn — only when the topic genuinely shifts."`
- **Input schema:** `z.object({ title: z.string().min(1).max(200) })`
- **`requiresApproval`:** `false`
- **Output:** a structured result the agent loop writes back as a
  `tool_result` message:
  - On success: `{ ok: true, title: <sanitized> }`
  - On rejection: `{ ok: false, reason: <one of the strings below> }`

Rejection reasons (returned in the tool result; the model can read
these and adjust):

- `manual_rename_locked` — `meta.titleSource === "manual"`.
- `rate_limited` — `userCount - (lastRenamedAtMessageCount ?? -min) < minMessagesBetweenRenames`.
- `empty_after_sanitize` — the title sanitized to the empty string.
- `session_not_found` — defensive; the session disappeared.

The agent loop already routes tool calls through the registry and
writes the result back as a `tool_result` message. No new agent
plumbing.

### FR-2 — Server-side rate limit

`SessionMeta` gains `lastRenamedAtMessageCount?: number`. The tool
reads it and rejects when the user-message count hasn't advanced
by at least `minMessagesBetweenRenames` since the last successful
rename. The first rename (when the field is `undefined`) is
always allowed.

Default: `minMessagesBetweenRenames = 3`. Override via
`config.title.minMessagesBetweenRenames` and
`COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES`. Setting to `0`
disables the rate limit (model can rename every turn after the
first).

### FR-3 — `titleSource` field

`SessionMeta` gains `titleSource: z.enum(["auto", "manual"]).default("auto")`.
The tool checks this field; PATCH/POST set it to `"manual"` when
the user supplies a title. `PATCH /api/sessions/:id` with
`title: ""` resets it to `"auto"`.

Existing `meta.json` files without the field default to `"auto"`.

### FR-4 — `session_renamed` SSE event with `titleSource`

The existing `session_renamed` event gains an optional
`titleSource` field. The reducer updates the matching session in
`store/sessions.sessions[]` so the next render uses the right
value for animation gating. The UI's `SessionMeta` mirror gains
the same field.

### FR-5 — System-prompt instruction

`packages/server/src/system-prompt.ts` `STATIC_PREFIX` gains one
section:

```
## Session title
The session title is shown in the sidebar and helps the user find
this conversation later. You can update it by calling the
`rename_session` tool with a 3-5 word title.

Call `rename_session` when:
- The current title no longer describes the topic (e.g. the user
  shifted from "K8s backup" to "React component").
- The conversation is long enough that you can summarize it
  confidently (don't rename on the first turn if the user only
  said "hi").

Do NOT call `rename_session`:
- On every turn (the server rate-limits you; you'll get a
  `rate_limited` result).
- If the user has manually renamed the session (the server
  rejects with `manual_rename_locked`; respect their choice).
- For trivial exchanges that don't change the topic.
```

The system prompt is the primary signal that the model should
only rename on topic shifts. The rate limit is the backstop.

### FR-6 — `COMPUTERWORKS_TITLE_LLM_DECIDES` (disable)

A new config flag (default `true`). When `false`, the
system-prompt section is omitted entirely — the model never learns
about the tool, so it never calls it. The tool still exists in
the registry (so any model that happens to know about it can
still call it, e.g. via a future override), but the system-prompt
omission is enough to disable the auto-retitling in practice.

This is an operator escape hatch for users who want no
auto-retitling at all (the original T12.2 first-turn generator
is also gone, so without this they'd be stuck with "(untitled)"
forever).

### FR-7 — Sidebar slide-in animation

The `Row` component in `SessionList.tsx` watches `props.title`
and `props.animated`. When `prev !== current && animated`, bump
an `animKey` state. The `<span className="cw-row-title">` gets
`key={animKey}` so React retriggers the CSS animation on every
change. Cold-start and identical-title renders do NOT bump the
key. `SessionList` passes `animated={true` for SSE-driven
renames and `animated={false` for the local rename input flow.

`global.css` adds `@keyframes cw-row-title-in` (translateX -8px →
0, opacity 0 → 1, 280ms ease-out) and applies it to
`.cw-row-title`.

### FR-8 — Cross-tab sync

The tool's `execute` broadcasts
`{ type: "session_renamed", sessionId, title, titleSource: "auto" }`
on `SyncHub` (the same hub T12.2 and Phase 17 use). Every tab on
the origin sees the rename, the SharedWorker dispatches it
through the central SSE → reducer → `Row` update → animation.

## Non-functional requirements

### NFR-1 — Backward compatibility

- `meta.json` files without `titleSource` parse with
  `titleSource: "auto"`. Default is forward-compatible.
- `meta.json` files without `lastRenamedAtMessageCount` parse with
  the field `undefined`. The first rename is always allowed.
- `meta.json` files with `title` non-empty AND no `titleSource`:
  treated as `titleSource: "auto"` (eligible for the LLM-driven
  retitler). The pre-Phase-19 T12.2 generator only set non-empty
  titles, so most titled sessions on disk today are auto-titled
  and eligible. Operators who want a sticky title rename once
  via the UI.
- `session_renamed` SSE events without the `titleSource` field
  are treated as `titleSource: "auto"` by the reducer.

### NFR-2 — Concurrency

- Two in-flight turns on different sessions never contend.
- Two in-flight turns on the same session: 409 (Phase 14 still
  enforces).
- The tool's read-modify-write of `lastRenamedAtMessageCount`
  goes through `SessionStore.patch` (already serialized via
  `enqueueWrite` since T18). A concurrent manual PATCH on the
  same field is fine — they both produce a coherent meta.

### NFR-3 — Cost

- A rename is one tool call inside an existing turn — no extra
  LLM call, no background fire-and-forget. Cheaper than the
  T12.2 generator.
- The system prompt grows by ~250 tokens. Negligible per-turn
  cost.
- The rate limit bounds the worst case: at most one rename per
  `minMessagesBetweenRenames` user messages. With the default
  3, that's 1 rename per ~3 user messages in the pathological
  case where the model tries to rename every turn.

### NFR-4 — Testability

The tool's `execute` is testable as a unit: pass a fake
`SessionStore` (in-memory temp dir) and a fake `SyncHub` (capture
broadcast calls). Each rejection path has a test. The rate limit
has a focused test. The sanitization has a focused test. The
audit log entry is tested via the existing `routes/messages.test.ts`
integration path.

## Out of scope (V1)

- **Model-name → context-window mapping.** The model has the
  context already.
- **Tier-based prompt budgets.** Eliminated.
- **Cadence trigger.** Eliminated.
- **Force-rename flag on the tool.** The rate limit is the only
  backstop; operators tune the env var to relax it.
- **Audit log decision variants for system-internal tools.** The
  existing `approve_once` covers `rename_session`.
- **`prefers-reduced-motion` gating.** Trivial follow-up.
- **Migration of pre-existing titled sessions to `manual`.** Old
  `meta.json` files default to `"auto"`.

## Constraints & assumptions

- The model is the source of truth for "is the title stale". The
  server's job is to enforce the rate limit, sanitize the title,
  and respect manual renames.
- The system-prompt section is the primary signal; the rate
  limit is the backstop. We accept that a model that ignores
  the system prompt will over-rename — the rate limit bounds
  the blast radius.
- The user is single-actor. No "session shared with collaborator"
  model.

## Acceptance criteria

This phase is done when:

- The model can call `rename_session({ title: "K8s migration" })`
  during any turn, and the title updates in the sidebar with a
  slide-in animation across all tabs.
- A second call within `minMessagesBetweenRenames` user messages
  is rejected with `rate_limited`; the model sees the result and
  backs off.
- A user PATCH on `title` sets `titleSource: "manual"`; the
  model's next rename attempt is rejected with
  `manual_rename_locked`.
- `createSession({ title })` creates a session with
  `titleSource: "manual"`.
- `COMPUTERWORKS_TITLE_LLM_DECIDES=false` omits the system-prompt
  section; the model doesn't call the tool.
- T12.2's first-turn generator is gone — no `title-generator.ts`,
  no `void generateTitle(...)` call in `routes/messages.ts`.
- The sidebar animation triggers on SSE-driven renames and does
  NOT trigger on cold start, session switch, or manual rename.
- `bun run typecheck && bun test` is green. New tests cover the
  tool, the rate limit, the manual-rename lock, the system-prompt
  gating, the `session_renamed` event with `titleSource`, and the
  `Row` animation gating.

## Open questions

None. The LLM-driven design eliminates the open questions from
the prior draft (no tier budgets, no cadence number, no first-
turn vs retitle distinction).