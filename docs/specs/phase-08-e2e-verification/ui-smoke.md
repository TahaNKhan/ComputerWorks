# ComputerWorks — UI Manual Smoke Checklist

A human-driven checklist to verify the React UI works end-to-end against
the real server. Run after `bun install` completes.

**How to use this checklist**

- Each step has a single checkbox `[ ]`. Tick it when you've confirmed
  the described behavior.
- Run through the steps in order. If any step fails, stop and capture a
  screenshot / console output before reporting.
- The script tags in parentheses (e.g. `(S1)`) are stable identifiers you
  can reference when filing a bug or asking for help.

## Prerequisites

- [ ] (P1) You have Bun ≥ 1.1 installed (`bun --version`)
- [ ] (P2) You have cloned the repo and run `bun install` from the root
- [ ] (P3) `MINIMAX_TOKEN` is exported in your shell
      (`echo "$MINIMAX_TOKEN" | head -c 8` shows a non-empty prefix)
- [ ] (P4) No leftover server is bound to `127.0.0.1:4747`
      (`lsof -iTCP:4747 -sTCP:LISTEN` returns nothing)

## Boot sequence

> **Phase 15** — the UI is now served by the Fastify server on the
> same port; no separate Vite process. Build once, then start.

- [ ] (S1) From the repo root, build the UI bundle:
      `bun run build`. Terminal prints `✓ built in <N>s` (Vite)
      and `tsc` exits with no errors.
- [ ] (S2) Start the server: `bun run start` from the repo root.
      The terminal prints
      `ComputerWorks server listening on http://127.0.0.1:4747`
      and `Serving UI from /…/packages/ui/dist-app`.
- [ ] (S3) Open `http://127.0.0.1:4747/` in a modern browser
      (Chromium, Firefox, or Safari current). The page renders without
      console errors.

## Session lifecycle

- [ ] (S4) In the left **SessionList** panel, click the `+` button.
      A new session appears in the list and is selected.
- [ ] (S5) The session shows a sensible default title; renaming it
      (right-click → Rename, or click on the title) persists across
      page reload.

## Tool flow — shell

- [ ] (S6) With the new session selected, type
      `list files in this directory` in the composer and press
      `Cmd/Ctrl+Enter` (or click **Send**).
- [ ] (S7) A `tool_call` block for `run_shell` appears inline in the
      message stream, showing the proposed command (`ls` or similar).
- [ ] (S8) An **ApprovalCard** appears under the tool call with three
      buttons: **Approve**, **Always** (approve for session), **Reject**.
- [ ] (S9) Click **Approve**. The shell tool executes and the result
      streams in as a collapsible block containing stdout / stderr /
      exit code.

## Tool flow — file read

- [ ] (S10) Send `read README.md`. The agent issues a `read_file` tool
      call; no approval card appears (read-only tools are auto-approved).
- [ ] (S11) The file content renders as GFM markdown (the headings,
      bullet list, and any tables are visible and formatted).

## Theme + shortcuts

- [ ] (S12) Use the theme toggle in the top bar to switch between
      **light** and **dark**. The page re-styles immediately.
- [ ] (S13) Reload the page (`Cmd/Ctrl+R`). The chosen theme persists
      (no flash of the wrong theme).
- [ ] (S14) Press `Cmd/Ctrl+K`. The session switcher palette opens.
      Pick a different session, press Enter — the active session
      switches and its transcript loads.
- [ ] (S15) Press `Esc`. The palette closes without changing session.

## Multi-session state isolation

- [ ] (S16) Create a **second** session from the SessionList panel.
- [ ] (S17) Send a message in the second session. Wait for the response.
- [ ] (S18) Switch back to the first session (via `Cmd/Ctrl+K` or by
      clicking in SessionList). The first session's messages, approval
      state, and theme are restored unchanged.
- [ ] (S19) Switch back to the second session. Its message is still
      there.

## Streaming cancellation

- [ ] (S20) Send a message that produces a long answer (e.g.
      `write a 200-word essay about the moon`). While the tokens are
      still streaming in, press `Esc`.
- [ ] (S21) The streaming stops within a second, the partial assistant
      message is discarded, and the composer is ready for the next
      message.

## Settings

- [ ] (S22) Press `Cmd/Ctrl+,` (comma). The settings modal opens.
- [ ] (S23) A **Model picker** is visible in the settings. The current
      default model (`MiniMax-M3`) is selected. Switching the model
      and closing the modal persists the choice for the active session.

## Cleanup

- [ ] (S24) Stop the server (`Ctrl+C` in the server terminal). One
      process — no UI terminal to stop.
- [ ] (S25) Confirm nothing is left listening on port 4747
      (`lsof -iTCP:4747 -sTCP:LISTEN` returns nothing).

---

**Verified on**: 2026-06-25 by Claude (pending user verification)
