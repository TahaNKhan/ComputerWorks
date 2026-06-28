# Phase 6 — Requirements

## Purpose

Expose the server's runtime, session store, and memory provider as a
small command-line interface so the user can manage state without
the UI. The CLI binary is `computerworks` (alias `cw`).

## Users / actors

- **The user** — runs `computerworks serve`, `computerworks sessions
  list`, `computerworks memory edit`, etc.
- **The server** — `serve` is a thin wrapper around
  `startServer()`.

## Functional requirements

### `computerworks serve`

- FR-1. Loads the config and starts the server.
- FR-2. Flags: `--port`, `--host`, `--verbose`, `--allow-non-loopback`.

### `computerworks sessions`

- FR-3. `list` prints `id`, `title`, `last-active` for each session.
- FR-4. `delete <id>` removes a session directory.
- FR-5. `export <id>` writes a Markdown transcript to stdout.

### `computerworks memory`

- FR-6. `ls` lists notes (name + first ~200 chars preview).
- FR-7. `show <name>` prints the full note to stdout.
- FR-8. `edit <name>` opens the note in `$EDITOR`.

### `computerworks config`

- FR-9. Shows the resolved config (file + env overrides merged).

## Non-functional requirements

- Each subcommand is independently testable.
- Exit codes are meaningful (0 success, non-zero on error).
- `--help` is implemented for every subcommand.
- No interactive prompts in non-TTY environments.

## Out of scope

- A REPL / interactive mode.
- Tab completion.
- A plugin system.

## Constraints

- Thin wrappers — no business logic in the CLI itself.

## Acceptance criteria

- All subcommands round-trip with the on-disk state.
- `--help` works on every subcommand.
- `bun run start` (which is `computerworks serve` under the hood)
  behaves identically.

## Open questions

None at acceptance.