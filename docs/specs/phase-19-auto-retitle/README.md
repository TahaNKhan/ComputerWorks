# Phase 19 — LLM-driven session retitling

**Status:** in-progress (spec)
**Started:** 2026-06-29
**Done:** —

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (working on main directly per the project rule)

## Pointers
- **Tasks:** T19.x IDs in `TASKS.MD` (added below)
- **Spec:**
  - [requirements.md](requirements.md)
  - [design.md](design.md)
- **Related specs:** [[phase-12-url-and-titles]] (where the
  fire-and-forget first-turn title generator lived — **this phase
  deletes it**; the LLM-driven path replaces it), [[phase-17-cross-tab-sync]]
  (where the `session_renamed` SSE event and `SyncHub` were added —
  reused for the cross-tab rename broadcast), [[phase-18-pattern-approval]]
  (where `SessionStore.enqueueWrite` was hardened — reused for the
  rename patch).

## Why isolated (or not)

Medium-sized refactor of a single feature. No new dependencies, no
new wire events (the `session_renamed` event already exists; this
phase just emits it from a new place), no changes to the agent
loop. Two pieces move:

1. The T12.2 fire-and-forget first-turn title generator
   (`packages/server/src/title-generator.ts` + the call in
   `routes/messages.ts`) is **deleted**. One code path, not two.
2. A new auto-approved `rename_session` tool lives in the default
   tool set. The model calls it whenever it sees a topic shift; a
   server-side rate limit prevents over-renaming.

The `SessionMeta` schema gains two fields (`titleSource`,
`lastRenamedAtMessageCount`) and the sidebar animation from the
prior draft is preserved.

## What "the LLM decides" means

The default tool set grows by one tool:

```
rename_session({ title: string })
```

The system prompt instructs the model: "If the session title (shown
in the sidebar) is stale, call `rename_session` with a 3-5 word
title." The model emits the tool call during its normal turn; the
agent loop routes it through the existing tool pipeline; the tool
validates, sanitizes, persists, and broadcasts. The chat view
flashes a "rename_session" tool call + result (same shape as
`run_shell`); the sidebar shows the new title with a slide-in
animation.

The tool is **not** approval-gated. The user opted in to letting
the model choose titles when they opted in to using ComputerWorks.

## What "server-side rate limit" means

The server tracks `meta.lastRenamedAtMessageCount` — the user-
message count at the time of the most recent successful rename.
The tool rejects renames where
`userMessageCount - lastRenamedAtMessageCount < minMessagesBetweenRenames`
(default 3). The **first** rename (when `lastRenamedAtMessageCount`
is `undefined`) is always allowed, so the model can give the
session an initial title on turn 1.

The rate limit is purely a backstop — the system-prompt instruction
is the primary signal that the model should only rename on topic
shifts. The default (3) means after the first rename, the next
rename is allowed on the 4th user message after that, then the
7th, etc. Operators can tune via
`COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES`.

## What "respect manual renames" means

`SessionMeta.titleSource: "auto" | "manual"` carries over from the
prior draft. PATCH and POST stamp `"manual"` when the user supplies
the title; the tool rejects renames when `titleSource === "manual"`.
A manually-titled session is permanently locked from auto-retitling.
The user can re-enable auto-retitling by setting `title: ""` via
PATCH (which resets `titleSource` to `"auto"`).

## What "slide-in animation" means

Unchanged from the prior draft. The sidebar row's title `<span>`
retriggers a CSS keyframe (`@keyframes cw-row-title-in`, ~280ms
ease-out) on every `session_renamed` SSE event. Manual renames
don't animate (the user just typed it). The animation gating
relies on a `props.animated` flag from the parent — `true` for
SSE-driven renames, `false` for local rename input.

## What we're deleting (T12.2)

- `packages/server/src/title-generator.ts` — file gone.
- `packages/server/src/routes/messages.ts` lines 273-284 — the
  `void generateTitle(...)` call at the end of `runAgentForSession`
  is gone.
- The T12.2 spec at `docs/specs/phase-12-url-and-titles/` stays
  in place as the historical record of the first-turn generator
  that this phase retires.

The first-turn behavior is now entirely in the model: it sees the
system-prompt instruction, has the conversation in its context from
message 1, and calls `rename_session` on turn 1 if it has a good
title. The cost is the same shape as a normal tool call — no extra
LLM call, no background fire-and-forget.

## What we're keeping

- `SessionMeta.titleSource` — manual-rename lock.
- `SessionMeta.lastRenamedAtMessageCount` — server-side rate limit.
- `SessionMetaSchema` backward compat — missing fields default to
  `"auto"` and `undefined` respectively.
- `session_renamed` SSE event with optional `titleSource` field.
- Cross-tab sync via `SyncHub.broadcast`.
- Sidebar slide-in animation on title change.
- PATCH/POST stamp `titleSource: "manual"` when the user sets the
  title.
- `bun run typecheck && bun test` green at every step.

## Out of scope (V1)

- **Model-name → context-window mapping.** The LLM has the
  conversation in its context; we don't curate a slice.
- **Tier-based prompt budgets.** Eliminated — the LLM does the
  work, no per-tier clip budget needed.
- **Cadence trigger ("every N user messages").** Eliminated —
  the model decides.
- **Force-rename escape hatch for the model.** No `force: true`
  flag on the tool. If the model wants to override the rate limit,
  the operator tunes the env var.
- **Audit log decision variants for system-internal tools.** The
  existing `approve_once` decision covers `rename_session` (it's
  not approval-required, but the audit log records it as
  `approve_once` like every other non-rejected tool call —
  consistent with how `read_file` is already audited).
- **`prefers-reduced-motion` gating.** Trivial follow-up.
- **Migration of pre-existing titled sessions to `manual`.** Old
  `meta.json` files default `titleSource` to `"auto"`. Operators
  who want a sticky title for an existing session rename it once
  via the UI.

## Open question

The `lastRenamedAtMessageCount` is a server-side field that the
tool reads but the agent loop never sees. The model has no way to
know "the rate limit blocks me right now" except via the tool
result. That's correct — the rate limit is enforced at the tool
boundary, the model gets structured feedback (`rate_limited`), and
the system prompt instructs it to not over-rename anyway. No
clarification needed.