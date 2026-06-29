# Phase 18 — Pattern-based command approval: Requirements

## Purpose

Today the "Always" button on the approval card is a visual no-op.
`SessionMeta.allowlist` exists on disk, `InteractiveApprover` has a
`sessionAllowlist` constructor slot, `ApprovalDecision` has an
`approve_for_session` variant carrying a `pattern` field — but nothing
is wired end-to-end:

- `routes/messages.ts` constructs `InteractiveApprover(..., [], [])`
  with empty allowlists.
- `InteractiveApprover.matchesSessionAllowlist` only does
  `pattern === call.name` (strict equality, never a regex).
- `agent/src/loop.ts` `case "approve_for_session":` ignores the
  pattern and just sets `approved = true`, indistinguishable from
  `approve_once`.

The result: every `run_shell` call — including repeats of a command the
user has already approved several times in the same session — requires
a fresh click. This phase closes the loop and adds a derived-pattern
suggestion so a single click can whitelist an entire command family
for the rest of the session.

## Users / actors

- **End user** — the single human at the keyboard. Wants fewer
  interruptions for routine commands (`ls`, `curl <known-endpoint>`,
  `grep`).
- **Agent loop** — calls `approver.request(...)` whenever a tool with
  `requiresApproval: true` is about to run.
- **Auditor** (the user, after the fact) — reads `audit.jsonl` to see
  why a particular tool call was approved or denied. The audit entry
  for an auto-approved call must include the pattern that matched.

## User stories

1. **Routine commands.** The agent wants to run `ls -la /tmp`. The
   user clicks "Always". All subsequent `run_shell` calls in this
   session are auto-approved (without prompting). The audit log
   records `decision: "auto_approve"`, `pattern: "run_shell"` for
   each one.

2. **Repeated shell utility.** The agent wants to run
   `curl -s https://example.com/api`. The user clicks "Always allow
   `curl …` for this session" (a new button that appears next to
   "Always" for `run_shell` calls with a `cmd` string). The next
   `curl …` call — and the one after that — auto-approve. A call to
   `rm -rf /` does not.

3. **Existing "Approve once" still works.** A click on "Approve once"
   continues to approve exactly the current call and nothing else.
   No regression.

4. **Approve then re-prompt.** After the user approves one
   `curl https://api/foo`, the agent's next turn asks again for
   `curl https://api/bar`. The user clicks "Always allow `curl …`"
   once; both subsequent calls are silent.

5. **Manual reset (deferred).** The user opens settings → session
   → "Clear allowlist" to wipe the session's accumulated patterns.
   Out of scope for V1 (see [Out of scope](#out-of-scope)).

6. **Cross-session isolation.** An allowlist added in session A does
   not apply to session B. A user who wants `curl` whitelisted
   permanently must click "Always allow `curl …`" in each new
   session.

## Functional requirements

### FR-1 — Pattern grammar
A pattern is a single string with one of two shapes:

- **Tool-name form:** `run_shell` — matches every call to that tool
  regardless of input.
- **Field-restricted form:** `run_shell:cmd=/^curl\b/` — matches
  calls to that tool whose input has a string field whose value
  matches the regex.

Grammar (BNF-ish):

```
pattern     := toolName | toolName ":" field "=" regex
toolName    := [a-z][a-z0-9_-]*
field       := [a-z][a-z0-9_]*
regex       := <JS RegExp source, no separator characters required>
```

The split between `toolName` and the body is the **first** `:`. The
body, if present, is exactly one `field=regex` pair — the regex
source is everything after the first `=` (so `=` may appear inside
the regex source; it just isn't a structural character).

No multi-clause AND-composition is supported in V1 (a pattern is at
most one `field=regex` clause). The rationale and migration path
to a structured JSON form live in the [Out of scope](#out-of-scope-v1)
section.

### FR-2 — Storage
- Each session's `meta.json` carries an `allowlist: string[]` field
  (already declared in `SessionMetaSchema` since T5.2).
- Patterns are appended (never overwritten) when the user clicks
  "Always" or "Always allow `<token> …`".
- Duplicate patterns are silently de-duplicated on append.
- The on-disk schema is unchanged; old sessions with no `allowlist`
  key default to `[]` (existing zod default).

### FR-3 — Auto-approval match
Before the agent loop calls `approver.request(...)`, the approver
checks the session allowlist:

- If any pattern matches the call, the approver returns
  `approve_once` and emits a `tool_result` event with
  `approved: true` and `reason: "matched pattern <pattern>"`.
- Otherwise, the user is prompted as today.

The check is the very first thing the approver does — before the
global shell allowlist (which is admin-set and tighter).

### FR-4 — "Always" button (existing)
- The UI's existing "Always" button sends
  `decision: { kind: "approve_for_session", pattern: <toolName> }`
  (this is what it already does today).
- The server appends the pattern to the session allowlist and approves
  the current call.
- The label becomes "Always allow `<toolName>`" (e.g. "Always allow
  `run_shell`") so the user knows what they're agreeing to.

### FR-5 — Derived pattern button (new)
- When `part.tool.name === "run_shell"` and `part.tool.input.cmd` is
  a string, the UI computes the first whitespace-delimited token of
  `cmd`, escapes it for regex use, and shows an extra button labelled
  `Always allow <token> …`.
- Clicking it sends
  `decision: { kind: "approve_for_session", pattern: "run_shell:cmd=/^<escaped-token>\b/" }`.
- The button is **absent** for other tools (the project only ships
  one tool with a meaningful command token today) and **absent** when
  `cmd` is missing or not a string.
- The first-token derivation is a fixed algorithm — no user-editable
  text box in V1.

### FR-6 — Audit log
Every auto-approved call (whether via the global shell allowlist,
session allowlist, or new pattern) writes an audit entry:

- `decision: "auto_approve"` for the global shell allowlist
- `decision: "auto_approve"` + `pattern: <matched-pattern>` for the
  session allowlist (a new field on `AuditEntry`).

Audit entries for user-driven decisions are unchanged:
`approve_once`, `approve_for_session`, `reject`, `edit`, `timeout`.

### FR-7 — Server-side regex safety
- A pattern string is rejected at the route boundary (HTTP 400) if
  `new RegExp(patternBody)` throws or the pattern is longer than
  256 characters.
- The server does not impose any deeper sandbox on regex execution;
  JS RegExp is treated as a low-cost operation. A pathological
  pattern is the user's own input and is their problem (the UI only
  generates safe patterns; the route accepts what the UI sent).
- Patterns are persisted verbatim — the server does not normalize or
  re-format them.

## Non-functional requirements

### NFR-1 — Match cost
A `matchesSessionAllowlist` check against N patterns completes in
well under 1 ms per pattern on a single thread. No backtracking
explosions are expected because the UI only generates
`^\s*<token>\b` style patterns. We do not pre-compile patterns; if
profiling later shows this matters, it's a follow-up.

### NFR-2 — Concurrency
Two `POST /messages` in flight on different sessions must not
interfere — each session owns its own allowlist. Same-session
concurrency already returns 409 (Phase 14).

### NFR-3 — Backward compatibility
Existing `meta.json` files with `allowlist: []` (or no `allowlist`
key at all) keep working. Old `audit.jsonl` lines without a `pattern`
field stay valid.

### NFR-4 — UI simplicity
The approval card gains one extra button (FR-5) and existing
buttons keep their positions. The card stays mobile-first —
buttons remain stacked on small screens.

## Out of scope (V1)

- **YOLO mode (per-session wildcard allowlist).** A future phase may
  introduce a "trust this session" affordance — a single click that
  adds a `*` pattern matching any tool. We deliberately leave this
  for a later phase because it is a qualitatively different decision
  from "approve this specific tool" or "approve this specific
  command family" (much broader blast radius; deserves its own UX
  review, e.g. confirmation dialog, persistence policy, audit
  surfacing). For V1 the pattern grammar has no wildcard toolName;
  `parsePattern("*")` returns `null` and the route returns 400.
  When this lands it should support **TTL** — a YOLO trust that
  expires after N minutes (so leaving for coffee doesn't leave the
  agent trusted for hours). TTL is part of YOLO's design, not a
  separate feature.
- **Structured JSON pattern format (migration target).** The V1
  pattern is a string. We expect to migrate to a structured JSON
  object when one of these becomes real:
  - A third pattern shape beyond tool-name-only and one
    field-restricted clause (e.g. glob, multi-clause AND,
    path-segment matching).
  - Per-pattern metadata: TTL, who-added-it, comment, hit count.
  - Bulk import/export (a JSON form is easier to round-trip through
    other tools).
  Until then the string is the right tool. The migration would
  change the on-disk `meta.allowlist: string[]` shape and the
  `approve_for_session` decision's `pattern` field — both are wire
  formats, both need a one-shot migration when we flip.
- **Global allowlist (cross-session).** The existing global shell
  allowlist stays admin-only. The user-facing allowlist is per-session.
- **Manual "clear allowlist" UI.** Settings → session → Clear
  allowlist is a separate task. V1 users can clear by deleting the
  session, or by editing `~/.computerworks/sessions/<id>/meta.json`
  by hand.
- **Pattern editor.** No UI to hand-craft a regex pattern. The
  pattern is always UI-generated from the tool name + first token.
- **Per-tool derived patterns beyond `run_shell`.** We only generate
  derived patterns for `run_shell`'s `cmd` field because it's the
  only tool where the first-token heuristic is unambiguous. `grep`,
  `cat`, etc. are not derived automatically — they fall under the
  generic "Always allow `run_shell`" path.
- **Deny list / "never auto-approve this pattern".** Symmetric to the
  allowlist but not needed today.
- **Time-based or count-based expiration of patterns.** Patterns
  accumulate for the session's life. Deleting the session clears
  them.
- **Server-side event log for cross-tab replay of approve-for-session
  decisions.** This is a future phase (the same V2 path noted in
  Phase 17). V1 persists to `meta.json` and that's enough — if a
  tab disconnects and reconnects mid-turn, the next call still
  consults the latest `meta.json`.

## Constraints & assumptions

- The pattern grammar is deliberately tiny. We do not introduce a
  parser library; the implementation is a small string-split +
  `new RegExp(...)` with a try/catch.
- The first-token extraction is a fixed heuristic — there's no
  configuration. If the heuristic gets a command wrong, the user
  can fall back to "Always allow `run_shell`" (broader) or "Approve
  once" (narrower).
- The user is single-actor. No "session shared with collaborator"
  model; concurrent-tab races are not a security concern.

## Acceptance criteria

This phase is done when:

- A user clicks "Always allow `run_shell`" and the next `run_shell`
  call in the same session is auto-approved with no card appearing.
- A user clicks "Always allow `curl …`" and the next
  `curl <anything>` call in the same session is auto-approved, while
  `rm -rf /tmp` is not.
- A pattern that was added in session A does not affect session B.
- The audit log distinguishes `auto_approve` (pattern matched) from
  `approve_once` (user click) — the former carries the matched
  pattern.
- `bun run typecheck && bun test` is green; new tests cover the
  pattern grammar, the matcher, and the wiring through
  `routes/messages.ts` (integration) and `InteractiveApprover` (unit).

## Open questions

None blocking. The brainstorming item is unambiguous once you accept
that "base tool approval" = the existing "Always" path and "future
`curl` runs" = a derived first-token pattern.