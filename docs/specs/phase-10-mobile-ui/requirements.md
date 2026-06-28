# Phase 10 — Requirements

## Purpose

The UI was designed desktop-first (three columns ≥ 1024 px) and
unusable on a phone. Make it work comfortably on a touchscreen without
giving up the desktop layout.

## Users / actors

- **Phone user** — single-column layout, sidebar hidden behind a
  hamburger drawer, sticky composer that respects the iPhone home
  indicator (`env(safe-area-inset-bottom)`).
- **Tablet user** — two-column layout (sidebar + chat), composer
  inline.
- **Desktop user** — three-column layout (sidebar + chat + tool
  panel), unchanged from Phase 7.

## Functional requirements

- FR-1. At < 768 px viewport width: a single column (chat only), with
  the session list collapsed behind a hamburger toggle that opens a
  slide-in drawer.
- FR-2. At 768–1023 px: two columns (sidebar + chat).
- FR-3. At ≥ 1024 px: three columns (sidebar + chat + tool panel).
- FR-4. Every interactive element (button, link, tap target) is at
  least 44 × 44 px so the UI is comfortable on touch screens without
  zooming.
- FR-5. The composer is sticky to the bottom of the viewport and
  respects `env(safe-area-inset-bottom)` so it stays clear of the
  iPhone home indicator.
- FR-6. Base font size is 16 px on mobile (no iOS zoom-on-focus when
  the composer is focused).
- FR-7. The `ApprovalCard` buttons are full-width on mobile and
  side-by-side on desktop.

## Non-functional requirements

- No new dependencies.
- No state-shape changes.
- The desktop layout must look identical to before this phase.
- `bun run typecheck && bun test` must remain green.

## Out of scope

- A native app shell (Capacitor, etc.).
- A separate mobile-only component tree.
- Touch-gesture enhancements (swipe-to-open drawer, etc.).
- A responsive redesign of the tool panel (it stays right-rail on
  desktop and collapses inline on mobile).

## Constraints

- Pure CSS + small component tweaks. No new packages, no store
  changes.

## Acceptance criteria

- iPhone SE viewport (375 × 667): chat is full-width, composer is
  sticky above the home indicator, the session drawer opens via the
  hamburger and closes on backdrop tap.
- iPad viewport (768 × 1024): two columns visible.
- Desktop (1280 × 800): three columns visible, identical to
  pre-Phase 10.
- ApprovalCard buttons are usable with one thumb on the smallest
  target viewport.

## Open questions

None at acceptance.
