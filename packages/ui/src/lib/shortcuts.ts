// packages/ui/src/lib/shortcuts.ts
// T7.10 — Keyboard shortcuts.
//
// We register a single document-level `keydown` listener that
// dispatches named events. Components opt in via
// `useShortcut("send", handler)` or `useShortcut("cancel", handler)`.
//
// Bindings:
//   - Cmd/Ctrl + Enter  → "send"          (composer)
//   - Esc               → "cancel"        (composer / active turn)
//   - Cmd/Ctrl + K      → "switch-session" (open switcher)
//   - Cmd/Ctrl + ,      → "open-settings"

import { useEffect } from "react";

export type ShortcutName = "send" | "cancel" | "switch-session" | "open-settings";

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/** Test whether a KeyboardEvent matches the given shortcut. */
export function matchesShortcut(name: ShortcutName, ev: KeyboardEvent): boolean {
  const mod = ev.metaKey || ev.ctrlKey;
  switch (name) {
    case "send":
      return mod && ev.key === "Enter";
    case "cancel":
      return ev.key === "Escape";
    case "switch-session":
      return mod && (ev.key === "k" || ev.key === "K");
    case "open-settings":
      return mod && ev.key === ",";
    default:
      return false;
  }
}

/** Human-readable label for a shortcut (for menus / hints). */
export function shortcutLabel(name: ShortcutName): string {
  const mod = isMac() ? "⌘" : "Ctrl";
  switch (name) {
    case "send":
      return `${mod}+Enter`;
    case "cancel":
      return "Esc";
    case "switch-session":
      return `${mod}+K`;
    case "open-settings":
      return `${mod}+,`;
  }
}

/** React hook: invoke `handler` whenever the named shortcut fires.
 *  Ignores key events originating inside editable elements (except for
 *  Esc and Cmd+Enter, which we always honor). */
export function useShortcut(name: ShortcutName, handler: () => void): void {
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (!matchesShortcut(name, ev)) return;
      // Skip when typing in an input/textarea, except for Esc/Cmd+Enter
      // which we treat as global.
      const target = ev.target as HTMLElement | null;
      const editable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (editable && name !== "send" && name !== "cancel") return;
      ev.preventDefault();
      handler();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [name, handler]);
}