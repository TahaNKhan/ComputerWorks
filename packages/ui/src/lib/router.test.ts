// packages/ui/src/lib/router.test.ts
// Unit tests for the pure URL helpers in router.ts. Side-effect
// helpers (window.history, popstate) are not exercised here — they
// run in a real browser and are covered indirectly via the store's
// URL integration tests.

import { describe, expect, test } from "bun:test";
import { buildSessionUrl, parseSessionFromUrl } from "./router.js";

describe("parseSessionFromUrl", () => {
  test("returns null when no session param is present", () => {
    expect(parseSessionFromUrl("/")).toBeNull();
    expect(parseSessionFromUrl("/?foo=bar")).toBeNull();
    expect(parseSessionFromUrl("https://example.com/")).toBeNull();
  });

  test("returns the id when session param is present", () => {
    expect(parseSessionFromUrl("/?session=abc123")).toBe("abc123");
    expect(parseSessionFromUrl("/?session=abc123&foo=bar")).toBe("abc123");
    expect(parseSessionFromUrl("https://example.com/?session=abc123")).toBe("abc123");
  });

  test("returns null for empty / whitespace-only value", () => {
    expect(parseSessionFromUrl("/?session=")).toBeNull();
    expect(parseSessionFromUrl("/?session=%20%20")).toBeNull();
    // Decoded: tabs and spaces only
    expect(parseSessionFromUrl("/?session=%09%20")).toBeNull();
  });

  test("trims surrounding whitespace from the id", () => {
    expect(parseSessionFromUrl("/?session=%20abc%20")).toBe("abc");
  });

  test("ignores other params when session is absent", () => {
    expect(parseSessionFromUrl("/?foo=bar&baz=qux")).toBeNull();
  });

  test("returns null for malformed URLs instead of throwing", () => {
    // new URL throws on bare strings without a base — verify we
    // gracefully return null.
    expect(parseSessionFromUrl("not a url at all")).toBeNull();
  });

  test("preserves case and special characters in the id", () => {
    // Session ids are base36-ish; we should pass them through verbatim.
    expect(parseSessionFromUrl("/?session=ABC-123_xyz")).toBe("ABC-123_xyz");
  });
});

describe("buildSessionUrl", () => {
  test("sets the session param when id is provided", () => {
    expect(buildSessionUrl("/", "abc")).toBe("/?session=abc");
    expect(buildSessionUrl("/?foo=bar", "abc")).toBe("/?foo=bar&session=abc");
  });

  test("removes the session param when id is null", () => {
    expect(buildSessionUrl("/?session=abc", null)).toBe("/");
    expect(buildSessionUrl("/?session=abc&foo=bar", null)).toBe("/?foo=bar");
  });

  test("preserves the path", () => {
    expect(buildSessionUrl("/foo/bar?session=abc", null)).toBe("/foo/bar");
    expect(buildSessionUrl("/foo/bar", "abc")).toBe("/foo/bar?session=abc");
  });

  test("preserves the hash fragment", () => {
    expect(buildSessionUrl("/#top", "abc")).toBe("/?session=abc#top");
    expect(buildSessionUrl("/?session=abc#top", null)).toBe("/#top");
  });

  test("returns '/' when input is empty and id is null", () => {
    expect(buildSessionUrl("", null)).toBe("/");
  });

  test("updates an existing session param rather than duplicating", () => {
    expect(buildSessionUrl("/?session=old", "new")).toBe("/?session=new");
  });

  test("URL-encodes ids with special characters", () => {
    expect(buildSessionUrl("/", "a b/c")).toBe("/?session=a+b%2Fc");
  });
});
