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

## Phase status (check TASKS.MD for details)

- ✅ Phases 0–5 done and pushed to main
- 👉 Phase 6: CLI commands (`computerworks serve`, `computerworks sessions`, `computerworks memory`)
- Future: Phase 7 (UI), Phase 8 (E2E)

## Don't

- Push to `main` directly. Use `phase/auto` and merge with `git merge --ff-only phase/auto && git push origin main` from outside.
- Commit `.hermes-state.json` (it's gitignored for a reason).
- Add a tool that requires approval without a UI surface for it.
- Skip `bun run typecheck && bun test` before committing.
- Touch phases that are already `[x]` in TASKS.MD unless explicitly asked.
