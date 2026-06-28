# Phase 6 — Design

## Module layout

```
packages/cli/
├── package.json              # bin: { "computerworks": "./dist/index.js" }
└── src/
    ├── index.ts              # arg parsing, dispatch to subcommand
    ├── serve.ts              # re-export of startServer()
    └── commands/
        ├── sessions.ts       # list / delete / export
        ├── memory.ts         # ls / show / edit
        └── config.ts         # resolved-config dump
```

## Dispatch

`index.ts` parses argv, looks up the subcommand, and delegates.
`serve.ts` is a single-line re-export of `startServer()` from
`@computerworks/server` — the same code path `bun run start` uses.

## Subcommands

- `serve` — starts the server. Passes `--port`, `--host`,
  `--verbose`, `--allow-non-loopback` straight through.
- `sessions list` — reads `~/.computerworks/sessions/`,
  prints `{id, title, updatedAt}` for each.
- `sessions delete <id>` — `rm -rf` the session directory after a
  yes/no confirmation (skipped with `--yes`).
- `sessions export <id>` — streams the transcript as Markdown to
  stdout (messages + tool calls + tool results).
- `memory ls` — calls `memory.list()` and prints the directory.
- `memory show <name>` — calls `memory.read(name)` and prints it.
- `memory edit <name>` — opens the file in `$EDITOR`. If
  `$EDITOR` is unset, errors with a clear message.
- `config` — dumps the resolved config (file + env overrides
  merged, after zod validation).

## Testing strategy

- Each subcommand has a small test that runs against a temp
  `~/.computerworks/` root.
- `serve` is exercised by `scripts/e2e.ts` ([[phase-08-e2e-verification|Phase 8]]).

## Risks & mitigations

| Risk                                       | Mitigation                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Accidental `delete`                        | Confirmation prompt with explicit `--yes` to bypass.                       |
| `$EDITOR` unset                            | Error message tells the user to set `$EDITOR` and try again.               |