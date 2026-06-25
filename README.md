# ComputerWorks

A local, single-user PC-control chatbot. Type a natural-language request;
Claude decides which tools to call; you approve each one before it runs.
See [`REQUIREMENTS.MD`](./REQUIREMENTS.MD), [`DESIGN.MD`](./DESIGN.MD), and
[`TASKS.MD`](./TASKS.MD) for the full spec.

> Status: **Phase 0 — scaffolding.** Nothing user-facing works yet.

## Stack

- **Bun** (workspaces, native TS, `bun test`)
- **TypeScript** (strict, ESM)
- **Fastify** server, **React + Vite** UI (added in later phases)
- **Anthropic Claude** as the v1 LLM provider

## Quickstart (once Phase 5+ lands)

```sh
bun install
bun run build
bun run start          # boots the Fastify server on 127.0.0.1:4747
```

Open the printed UI URL. Edit `~/.computerworks/config.ts` to set your
Anthropic API key (or set `COMPUTERWORKS_ANTHROPIC_API_KEY`).

## Layout

```
packages/
├── core/          # types + Provider interface + Anthropic provider
├── agent/         # agent loop + tool registry + approval
├── tools-shell/   # run_shell
├── tools-files/   # read/write/edit/list_dir
├── memory-files/  # file-based MemoryProvider
├── server/        # Fastify app, routes, SSE, session store
└── ui/            # React + Vite SPA
```

## License

MIT — see [`LICENSE`](./LICENSE).
