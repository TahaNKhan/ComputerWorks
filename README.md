# ComputerWorks

ComputerWorks is a **local, single-user PC-control chatbot**. You type a
natural-language request; an LLM decides which tools (shell, file read /
write / edit, memory notes) to invoke; you approve each one before it
runs. Everything lives on your machine — no telemetry, no cloud
relay, no shared tenancy. The agent can run `ls`, edit a file in your
repo, or write a memory note, but only after you say "yes" to that
specific call.

The project is built as a TypeScript monorepo (`packages/*`) using
**Bun** as the runtime, package manager, and test runner.

---

## Install

Requirements:

- **Bun ≥ 1.1** (`curl -fsSL https://bun.sh/install | bash`)
- A Unix-like shell (macOS, Linux, or WSL)
- An Anthropic-compatible API token (the default endpoint is MiniMax)

```sh
git clone <your-fork-url> ComputerWorks
cd ComputerWorks
bun install
```

Set your API token in the environment. The default endpoint is
`https://api.minimax.io/anthropic`, but any Anthropic-compatible
endpoint that accepts Bearer auth will work — override the URL via
`MINIMAX_BASE_URL` (see [Configure](#configure)).

```sh
export MINIMAX_TOKEN="sk-..."        # required
# Optional overrides (defaults shown):
export MINIMAX_BASE_URL="https://api.minimax.io/anthropic"
export MINIMAX_DEFAULT_MODEL="MiniMax-M3"
```

Add the exports to your shell rc (`~/.zshrc`, `~/.bashrc`, etc.) so they
survive new terminals.

---

## Run

Two processes — the **server** (Fastify + SSE agent) and the **UI**
(Vite + React). Run them in separate terminals.

```sh
# Terminal 1 — server (defaults to http://127.0.0.1:4747)
bun run start

# Terminal 2 — UI (defaults to http://localhost:5173)
bun run --filter @computerworks/ui dev
```

Open <http://localhost:5173> in your browser. The UI talks to the
server on the same machine — no network exposure.

To run only the server without the UI (e.g. for CLI use):

```sh
bun run start                     # bind 127.0.0.1:4747
bun run start -- --port 8080      # different port
bun run start -- --verbose        # debug logging
```

By design the server **refuses to bind to a non-loopback interface**
unless you pass `--allow-non-loopback`. ComputerWorks is local-first;
exposing the agent to the network exposes every approval gate with it.

---

## Configure

ComputerWorks reads configuration in this order, later sources overriding
earlier ones:

1. Built-in defaults
2. `~/.computerworks/config.ts` (a TypeScript file you author)
3. `COMPUTERWORKS_*` environment variables

### Environment variables

| Variable                      | Purpose                                              | Default                                |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------- |
| `MINIMAX_TOKEN`               | API token (Bearer auth)                              | _(required)_                           |
| `MINIMAX_BASE_URL`            | Override the API base URL                            | `https://api.minimax.io/anthropic`     |
| `MINIMAX_DEFAULT_MODEL`       | Default model for new sessions                       | `MiniMax-M3`                           |
| `COMPUTERWORKS_SERVER_PORT`   | Server bind port                                     | `4747`                                 |
| `COMPUTERWORKS_SERVER_HOST`   | Server bind host (loopback only by default)          | `127.0.0.1`                            |
| `COMPUTERWORKS_ANTHROPIC_API_KEY`  | Alternative token (same as `MINIMAX_TOKEN`)     | _(unset)_                              |
| `COMPUTERWORKS_ANTHROPIC_BASE_URL` | Alternative base URL (same as `MINIMAX_BASE_URL`) | _(unset)_                              |

### Config file (`~/.computerworks/config.ts`)

The file is a TypeScript module with a default export. Run
`bun run start` once to let the server create the directory; then
author your config:

```ts
// ~/.computerworks/config.ts
export default {
  providers: {
    anthropic: {
      // Leave apiKey unset if you set MINIMAX_TOKEN in the environment.
      baseUrl: "https://api.minimax.io/anthropic",
      defaultModel: "MiniMax-M3",
      betaHeaders: [],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4747,
  },
  approval: {
    autoApprove: { read: true, write: false, shell: false },
    // Regexes that bypass the prompt for matching run_shell commands.
    // Decisions are still logged.
    globalShellAllowlist: [/^ls(\s|$)/, /^git\s+status$/],
  },
  memory: {
    enabled: true,
    root: "~/.computerworks/memory",
  },
};
```

Any key you omit falls back to the schema default. See
[`packages/server/src/config.ts`](packages/server/src/config.ts) for the
full schema and `DESIGN.MD §12` for the design rationale.

### Override the API base URL

Most common case: pointing ComputerWorks at a self-hosted or alternative
Anthropic-compatible endpoint.

```sh
export MINIMAX_BASE_URL="https://my-proxy.example.com/anthropic"
export MINIMAX_TOKEN="sk-my-token"
bun run start
```

The CLI, server, and the in-app settings model picker all read this
variable. Restart the server after changing it.

---

## Memory notes

Memory notes are Markdown files under `~/.computerworks/memory/notes/`.
They let the agent persist facts across sessions (your preferences,
project facts, recurring gotchas).

**From the CLI:**

```sh
bun run --filter @computerworks/cli memory write user-preferences \
  "Prefer bun over npm. Use tabs in TypeScript."
bun run --filter @computerworks/cli memory ls
bun run --filter @computerworks/cli memory show user-preferences
bun run --filter @computerworks/cli memory edit user-preferences
```

**From inside a session:**

The agent has four memory tools: `read_memory`, `write_memory`,
`list_memory`, `search_memory`. `write_memory` requires your approval
(it's a mutation).

**Storage layout:**

```
~/.computerworks/
  config.ts                       # your config
  sessions/<id>/
    meta.json                     # session metadata
    messages.jsonl                # append-only transcript
    audit.jsonl                   # approval + tool-call audit
  memory/
    notes/<name>.md               # one note per file
    index.json                    # cached note listing
```

One memory note per topic. Use kebab-case names:
`user-preferences`, `project-acme-architecture`, `gotchas-typescript`.

---

## Troubleshoot

### `MINIMAX_TOKEN not set`

```
Error: MINIMAX_TOKEN environment variable is required.
Set it in your shell, ~/.zshrc, or ~/.bashrc.
```

Export the variable and restart the server. The token is read once at
provider construction time, not per request.

### `Refusing to bind to non-loopback`

```
Refusing to bind to 0.0.0.0:4747: non-loopback bind requires --allow-non-loopback.
ComputerWorks is a local-first agent; binding to a public interface
exposes your machine and every approval gate to the network.
```

You started the server on a public interface (`0.0.0.0`, your LAN IP,
etc.) without the explicit `--allow-non-loopback` flag. Either bind to
`127.0.0.1` (the default) or, if you understand the risk, pass the
flag. See `packages/server/src/start.ts` for the policy.

### `tool call requires approval`

A `run_shell`, `write_file`, `edit_file`, or `write_memory` call needs
your decision before it runs. In the UI an **ApprovalCard** appears
inline; click **Approve**, **Always**, or **Reject**. The decision is
logged to `audit.jsonl`.

If you want a command to skip the prompt permanently, add it to
`approval.globalShellAllowlist` in `~/.computerworks/config.ts`.

### `429 Too Many Requests` / rate-limit errors

The provider returns these when you exceed the plan's rate limit. Wait
and retry, or lower the request frequency by reducing the iteration cap
in your config (advanced).

### `bun test` says it can't find `scripts/e2e.ts`

`scripts/e2e.ts` is intentionally excluded from `bun test` (it's a
long-running integration check that needs a real server). Run it
explicitly with `bun run test:e2e`.

### Stale port

```
Error: listen EADDRINUSE: address already in use :::4747
```

Another process is already bound to `4747`. Either stop it, or start
ComputerWorks on a different port: `bun run start -- --port 4748`.

---

## Architecture

The repo is a Bun workspace; every package is independently
typecheckable and publishable. Roughly:

```
packages/
  core/           # types, Provider interface, ScriptedProvider (test double)
  agent/          # runTurn state machine, Approver, ToolRegistry
  tools-shell/    # run_shell tool
  tools-files/    # read_file, write_file, edit_file, list_dir
  memory-files/   # FileMemoryProvider (notes under ~/.computerworks/memory/notes/)
  server/         # Fastify app, REST routes, SSE manager, session store, CLI
  cli/            # computerworks serve / sessions / memory commands
  ui/             # React + Vite SPA
scripts/
  e2e.ts          # end-to-end smoke runner (excluded from bun test)
docs/
  ui-smoke.md     # human-driven UI checklist
```

**Request flow:**

1. UI `POST`s a user message to `/api/sessions/:id/messages`.
2. The server enqueues an agent turn: it loads history, builds a system
   prompt from the static prefix + memory directory, and calls
   `runTurn()`.
3. The provider streams tokens / tool calls. For each tool call the
   agent asks the **Approver** (Interactive by default, Auto for E2E).
4. SSE events fan out to every subscriber for that session.
5. Each turn's transcript is appended to `messages.jsonl`; each
   tool-call decision is appended to `audit.jsonl`.

See `DESIGN.MD` for the long-form spec and `REQUIREMENTS.MD` for
product requirements.

---

## Development

```sh
bun run typecheck    # tsc -b tsconfig.build.json — must be green
bun test             # unit + integration tests across all packages
bun run test:e2e     # end-to-end smoke (real server, ~5s)
bun run build        # build every package to packages/*/dist/
```

### Project layout conventions

- Strict TypeScript: `noUncheckedIndexedAccess`, every field typed.
- Zod schemas at the tool boundary, cast through `unknown` to satisfy
  TS variance. Runtime validation is the source of truth.
- `process.env` for env lookups. **Never commit secrets.**
- `~/.computerworks/` is the user-data root (config, sessions, memory).
- All file tools run under the session's `cwd` and reject paths that
  escape it.
- `run_shell`, `write_file`, `edit_file`, and `write_memory` require
  approval by default.

### Add a new tool

1. Pick the right package (`packages/tools-<area>/`) or create one.
2. Export a `ToolDefinition` from the package's `src/index.ts`:
   ```ts
   import { z } from "zod";
   import type { ToolDefinition } from "@computerworks/core";

   export const myTool: ToolDefinition = {
     name: "my_tool",
     description: "What it does (the LLM reads this).",
     inputSchema: z.object({ foo: z.string() }),
     requiresApproval: true, // mutation? true. read? false.
     async execute(input, ctx) {
       // input is parsed by zod. ctx has cwd, signal, env, sessionId.
       return { ok: true };
     },
   };
   ```
3. Register it in `packages/server/src/tools/index.ts` (add it to the
   `defaultTools()` array).
4. Add a unit test in the tool's package (`src/index.test.ts`) using
   `createScriptedProvider` to drive the loop without network calls.
5. Run `bun run typecheck && bun test && bun run test:e2e`.

### Tests

- **Unit tests** live next to the code (`foo.ts` → `foo.test.ts`).
- **Integration tests** for the server live in
  `packages/server/src/app.test.ts` and use Fastify's `app.inject()` —
  no real sockets.
- **End-to-end** is `scripts/e2e.ts`, run with `bun run test:e2e`. It
  boots the real server on port `0` with a scripted provider and an
  auto-approver and asserts the full request → SSE → persistence path.

### Pre-push hook

A git hook runs `bun run typecheck` before any push. If it's red you
can't push — fix the typecheck errors first. **Do not** bypass it with
`--no-verify`.

---

## License

MIT — see [`LICENSE`](LICENSE).
