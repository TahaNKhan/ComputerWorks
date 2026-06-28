# Phase 10 — Mobile-friendly UI (LAN deployment followup)

**Status:** done
**Started:** 2026-06-25
**Done:** 2026-06-25

## Isolation
- **Branch:** `phase/10-mobile-friendly`
- **Worktree:** n/a

## Pointers
- **Tasks:** T10.1 in `TASKS.MD`
- **PR / merge commit:** merged from `phase/10-mobile-friendly` to `main`
- **Related specs:** [[phase-07-ui]] (the three-pane layout being made mobile-first)

## Why isolated

A LAN user opened the UI on a phone and the three-pane layout was
unusable: the chat column was squeezed to a sliver and the session
list covered most of the screen. The fix is a CSS-only + small
component pass — no new dependencies, no state restructure — but it
touches every component file and the global stylesheet, so it earned
its own branch for reviewability.

## Design notes

The implementation lives entirely in:

- `packages/ui/src/styles/global.css` — mobile-first CSS: one column
  at < 768 px (sidebar collapses behind a hamburger drawer); two
  columns at 768–1023 px; three columns at ≥ 1024 px. Sticky composer
  with `env(safe-area-inset-bottom)` padding, 44 px tap targets, 16 px
  base font (no iOS zoom-on-focus).
- `packages/ui/src/components/SessionList.tsx` — renders as a
  slide-in drawer behind a hamburger toggle on mobile, inline sidebar
  on tablet/desktop.
- `packages/ui/src/components/Composer.tsx` — sticky positioning with
  safe-area-inset bottom padding.
- `packages/ui/src/components/ApprovalCard.tsx` — buttons stacked
  vertically on mobile, side-by-side on desktop.

No state changes, no new actions, no new types. The UI was already a
thin renderer over the zustand store (per
[[phase-07-ui|Phase 7]]); mobile-friendly was pure layout work.
