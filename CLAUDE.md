# ComputerWorks — Project Context for Claude Code

> Local, single-user PC-control chatbot. The user types natural-language
> requests; an LLM decides which tools to call; the user approves each
> one. The repo is being built phase-by-phase; phase status lives in
> TASKS.MD.

## Tech stack (already chosen)

- **Bun** as runtime + package manager + test runner (`bun test`, `bun run build`)
- **TypeScript** strict mode, ESM, project references via `tsconfig.json`
- **Fastify** server, **React + Vite** UI (later phases)
- **Zod** for input validation
- **`@anthropic-ai/sdk`** for the LLM provider (also supports the MiniMax Anthropic-compatible endpoint via env vars)

## Workspace layout

```
packages/
  core/          # types, Provider interface, scripted test provider
  agent/         # runTurn state machine, approval, tool registry
  tools-shell/   # run_shell tool
  tools-files/   # read/write/edit/list_dir
  memory-files/  # FileMemoryProvider (notes under ~/.computerworks/memory/notes/)
  server/        # Fastify app, routes, SSE, session store
  cli/           # computerworks serve / sessions / memory
  ui/            # (later) React SPA
```

`bun install` from the repo root. Workspace links via `workspace:*`.

## Build / verify commands

```sh
bun run typecheck    # tsc -b tsconfig.build.json  — must be green
bun test             # bun test across all packages — must pass 100%
bun run build        # same as typecheck but emits dist/
```

The pre-push git hook runs `bun run typecheck` and refuses broken
pushes. Do not bypass it.

## Conventions

- Strict TypeScript: `noUncheckedIndexedAccess`, all fields typed
- Zod schemas with `as unknown as ToolDefinition["inputSchema"]`
  cast at the tool boundary (TS variance workaround)
- `process.env` for env lookups; **never commit secrets**
- `~/.computerworks/` is the user-data root (config, sessions, memory)
- All file tools run under `cwd` and reject paths that escape it
- Shell + write_file + edit_file + write_memory require approval

## Documentation

Docs are split per phase, not monolithic. The layout:

- `docs/architecture.md` — the one constant: 1-page system overview
  (runtime topology, wire protocol, monorepo layout, package
  dependencies). Start here when orienting.
- `docs/specs/phase-NN-<name>/` — one folder per phase. Each has a
  `README.md` (status, isolation, pointers, why-isolated),
  `requirements.md` (what + why), and `design.md` (how).
- `TASKS.MD` (this repo root) — the active task ledger. **Use this
  filename** — the project's update protocol below references it
  explicitly. Each `### Phase N` heading carries a `**Spec**:`
  pointer to the corresponding spec folder.
- `README.md` — the user-facing manual (install / run / configure /
  troubleshoot). Slim by design; points at `docs/architecture.md`
  for the system overview.
- `docs/specs/phase-08-e2e-verification/ui-smoke.md` — the
  human-driven UI smoke checklist.

ASCII box-drawing in diagrams is forbidden; use Mermaid.

## Phase status (check TASKS.MD for details)

- ✅ Phases 0–8 done and pushed to main
- ✅ Phase 9 — MiniMax auth fix (LAN deployment followup) done on `phase/9-minimax-auth`
- ✅ Phase 10 — Mobile-friendly UI (LAN deployment followup) done on `phase/10-mobile-friendly`
- ✅ Phase 11 — Persist LLM responses to transcript done on `phase/11-persist-responses`
- ✅ Phase 12 — URL-routable sessions + LLM-generated titles done on `phase/auto`
  (T12.x tool_validation_error folded in from `phase/12-url-and-titles`)
- ✅ Phase 14 — Per-message SSE + UI rewrite merged into main on 2026-06-28.
  The architecture shift is large: POST /messages opens its own SSE
  response, the SSEManager is gone, the UI reducer is a pure function
  tested without rendering any component. See TASKS.MD and the commit
  history for the breakdown.
- ✅ Phase 15 — Serve UI from server merged into main on 2026-06-28.
  Fastify now serves the built UI bundle via @fastify/static; one
  process, one port (`127.0.0.1:4747`), one URL. `bun run build &&
  bun run start` is the new workflow; `dev:watch` runs Vite
  `--watch` and `bun --watch` in parallel for iteration. Vite is
  build-only (no dev server); the trade-off is no HMR.
- ✅ Phase 17 — Cross-tab session sync merged into main on 2026-06-28.
  Two SSE streams with disjoint event vocabularies: the per-message
  SSE keeps Phase 14's job (live per-turn events: message_start /
  token / tool_call / done); a new central SSE carries
  state-change events only (message_appended / session_renamed /
  approval_required / tool_result / etc.) for every tab on the
  origin via a SharedWorker. Tab UUIDs (`X-CW-Tab`) deduplicate
  the leading tab's optimistic append from its own
  `message_appended` echo. Resync on worker reconnect is tab-side
  (`loadTranscript` + `loadSessions`).
- 🎉 Build complete — no further phases planned (Phase 17 was the
  last architectural change; the codebase is now `main`-only, no
  phase branches)

## CRITICAL: How to update TASKS.MD

**The user is building a tracking system around TASKS.MD. They MUST see
your progress in real time — not after you've already committed.**

The pattern in TASKS.MD is tasks.md format:

```
- [ ] T<n>.<m> — Title #phaseN @ready target:phaseN
  - **Files**: ...
  - **Deps**: ...
  - **Done when**: ...
```

### Update protocol — follow this exactly

When you **start** working on a task:
- Do NOT change TASKS.MD yet. (The `- [ ]` status is correct.)

When you **finish** a task (i.e. its `Done when` criteria all pass and
`bun run typecheck && bun test` are green):

1. Edit TASKS.MD: change `- [ ]` to `- [x]` AND append
   `_done:YYYY-MM-DD` (use today's date in the user's local TZ, which is
   America/Los_Angeles / PT). Example:
   ```
   - [x] T6.1 — `computerworks serve` #phase6 @ready target:phase6 _done:2026-06-25
   ```
2. `git add TASKS.MD` (you can include it in your main commit too).

This applies **as you finish each task**, not at the very end. If you
finish T6.1 and need to keep working on T6.2, **commit T6.1's code +
the TASKS.MD edit before moving on**. Multiple commits per phase are
fine — the user wants visible progress.

If you run out of turns or budget mid-phase, the partial commits +
TASKS.MD edits mean the user can see exactly where you stopped.

### When you finish the LAST task in scope

Update the "Phase status" line at the top of THIS file (CLAUDE.md) so
the next session knows what's next.

## Workflow (per phase handed to you)

1. **Read** TASKS.MD (find `### Phase N`), CLAUDE.md, and one or two
   relevant existing source files to ground yourself.
2. **Work directly on `main`**: `git checkout main && git pull`.
   No phase branches — tasks are individual commits on `main`. `main`
   is the rolling integration branch (formerly `phase/auto`; folded in
   after Phase 14).
3. **Implement** task by task. After each task:
   - Run `bun run typecheck && bun test`.
   - If green: update TASKS.MD per the protocol above, then commit with
     `git add <files> && git commit -m "T<n>.<m>: <one-line summary>"`.
   - Multiple commits per phase are expected and welcome.
4. **Push** at natural pause points: `git push origin main`. The
   pre-push hook runs `bun run typecheck` and refuses if red.
5. **Update CLAUDE.md**'s "Phase status" section when the phase is done.

## Hard rules

- Push to `main` directly. The pre-push hook runs `bun run typecheck`;
  if red, you can't push — fix the typecheck errors first.
- Don't commit `.hermes-state.json` (it's gitignored).
- Don't bypass the pre-push hook with `--no-verify`.
- Don't touch packages that aren't in your phase's TASKS.MD scope.
- Don't add dependencies that aren't on the project's allowlist
  (MIT/Apache/BSD). Don't add `lodash`, `moment`, `request`, `colors`,
  or any other anti-pattern libraries.
- **Update TASKS.MD per the protocol above** — this is non-negotiable.
  A silent implementation that never updates TASKS.MD is a failure.

## If you get stuck

If a task is genuinely blocked (ambiguous spec, missing context,
etc.), do ONE of:

1. Stop and report back in your final response. Don't spin.
2. Write the blocker as a note in TASKS.MD under the task (e.g.
   add a `**Blocker**: <reason>` line) and continue with the next task.

Never silently retry the same failing operation across multiple turns
without making progress. Burn rate is the user's money.

## Don't

- Create `phase/<N>-...` branches. Work goes on `main` directly.
- Commit `.hermes-state.json`.
- Add a tool that requires approval without a UI surface for it.
- Skip `bun run typecheck && bun test` before committing.
- Touch phases that are already `[x]` in TASKS.MD unless explicitly asked.
- Work past your budget without committing + updating TASKS.MD first.

## Environment notes (for the assistant calling Claude)

- Use `claude --bare -p --output-format json --max-turns 30
  --max-budget-usd 5.00 --allowedTools "Read,Edit,Write,Bash" --prompt "<prompt>"`.
  `--bare` skips CLAUDE.md auto-discovery so we MUST pass context via
  `--append-system-prompt` or by writing CLAUDE.md first (we do — it's
  this file).
- **Do NOT pass `--model`.** The user's `~/.claude/settings.json`
  pins the model to `MiniMax-M3` (via `ANTHROPIC_MODEL` +
  `ANTHROPIC_DEFAULT_*_MODEL`). Override that with `--model` and you
  bypass the user's preference. Just let `--bare` pick up the env.
- Budget of $5 is enough for a phase-sized task. If you need more,
  bump it; the user is watching.
- The reported `modelUsage` key will be `MiniMax-M3`. That is correct
  and intentional — do not flag it as an error.
