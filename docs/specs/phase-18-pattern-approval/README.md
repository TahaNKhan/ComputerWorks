# Phase 18 — Pattern-based command approval per session

**Status:** done
**Started:** 2026-06-28
**Done:** 2026-06-29

## Isolation
- **Branch:** `main`
- **Worktree:** n/a (working on main directly per the project rule)

## Pointers
- **Tasks:** T18.x IDs in `TASKS.MD`
  - T18.1 — scope (this doc) — `_done:2026-06-28`
  - T18.2 — server-side pattern matching + approver wiring — `_done:2026-06-29` (commit `00bb59d`)
  - T18.3 — UI derived-pattern suggestion — `_done:2026-06-29` (commit `a09a115`)
  - T18.4 — docs + smoke + ship — `_done:2026-06-29`
- **Spec:**
  - [requirements.md](requirements.md)
  - [design.md](design.md)
- **Related specs:** [[phase-05-server]] (where `InteractiveApprover`
  and `SessionStore` first landed; this phase finishes the half-built
  allowlist plumbing), [[phase-07-ui]] (where `ApprovalCard` lives).

## Why isolated (or not)
Small-to-medium UX feature. No new dependencies, no architectural
shifts, no wire-format changes. The persistence model
(`SessionMeta.allowlist: string[]` declared in T5.2) and approver
interface (`ApprovalDecision["approve_for_session"]` declared in T2.1)
are already half-built; this phase finishes them end-to-end so that
clicking "Always" actually adds an allowlist entry, and adds a derived
"allow all `curl …`" suggestion for `run_shell` calls.

## Brainstorm source
`next.md:1` — *"tool approval: allow base tool approval per session,
if a user approves `curl "xyz"` ask if they'd like to allow all
future `curl` runs using the bash tool."*

The user's phrasing ("base tool approval") pointed at the
tool-name-only pattern (today's "Always" button). The follow-up
sentence ("all future `curl` runs") points at extending that to a
small DSL so a single approval can whitelist an entire command family.

## Final grammar (as implemented)

The implementation deliberately chose a simpler grammar than the original
draft. Patterns are strings of one of two shapes:

```
tool:<name>             matches any call to <name>
tool:<name> <prefix>    matches calls to <name> whose first
                        whitespace-delimited token of the input's
                        `cmd` (or `path`, or `name`, or first string
                        field) equals <prefix>
```

Trade-offs vs. a regex-based grammar: no `new RegExp(...)` evaluation,
no length cap, no field-name validation, no catastrophic-backtracking
surface; `onAllowlistExtended` lives inside `InteractiveApprover` so
the `agent` package stays decoupled from `SessionStore`. The UI emits
patterns in exactly this format; the server parses them eagerly at
approver construction time and rejects malformed entries.