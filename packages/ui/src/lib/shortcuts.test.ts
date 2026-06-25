// packages/ui/src/lib/shortcuts.test.ts
// Unit tests for the shortcut matcher.

import { describe, expect, test } from "bun:test";
import { matchesShortcut, shortcutLabel } from "./shortcuts.js";

function key(opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...opts,
  } as KeyboardEvent;
}

describe("matchesShortcut", () => {
  test("send matches Cmd+Enter", () => {
    expect(matchesShortcut("send", key({ key: "Enter", metaKey: true }))).toBe(true);
    expect(matchesShortcut("send", key({ key: "Enter", ctrlKey: true }))).toBe(true);
  });

  test("send does not match plain Enter", () => {
    expect(matchesShortcut("send", key({ key: "Enter" }))).toBe(false);
  });

  test("cancel matches Escape", () => {
    expect(matchesShortcut("cancel", key({ key: "Escape" }))).toBe(true);
  });

  test("switch-session matches Cmd+K", () => {
    expect(matchesShortcut("switch-session", key({ key: "k", metaKey: true }))).toBe(true);
    expect(matchesShortcut("switch-session", key({ key: "K", ctrlKey: true }))).toBe(true);
  });

  test("open-settings matches Cmd+,", () => {
    expect(matchesShortcut("open-settings", key({ key: ",", metaKey: true }))).toBe(true);
  });
});

describe("shortcutLabel", () => {
  test("labels are non-empty", () => {
    expect(shortcutLabel("send").length).toBeGreaterThan(0);
    expect(shortcutLabel("cancel").length).toBeGreaterThan(0);
    expect(shortcutLabel("switch-session").length).toBeGreaterThan(0);
    expect(shortcutLabel("open-settings").length).toBeGreaterThan(0);
  });
});