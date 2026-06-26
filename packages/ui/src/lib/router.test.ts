// packages/ui/src/lib/router.test.ts
// Unit tests for the URL router. Pure functions over an injected
// HistoryLike / LocationLike so no real DOM is needed.

import { describe, expect, it } from "bun:test";
import {
  navigateToSession,
  parseSessionIdFromPath,
  replaceSessionInUrl,
  subscribeToRouteChanges,
  type HistoryLike,
  type LocationLike,
  type RouterEnv,
} from "./router.js";

// ─── fakes ─────────────────────────────────────────────────────────────────

function makeFakeHistory(): HistoryLike & { stack: string[] } {
  const stack: string[] = [];
  const fake: HistoryLike & { stack: string[] } = {
    stack,
    pushState(_d, _u, url) {
      stack.push(url);
    },
    replaceState(_d, _u, url) {
      stack.push(url);
    },
  };
  return fake;
}

function makeEnv(initialPath: string): RouterEnv & { popHandler?: () => void } {
  const env: RouterEnv & { popHandler?: () => void } = {
    history: makeFakeHistory(),
    location: { pathname: initialPath } as LocationLike,
  };
  return env;
}

// ─── parseSessionIdFromPath ────────────────────────────────────────────────

describe("parseSessionIdFromPath", () => {
  it("extracts the id from /s/:id", () => {
    expect(parseSessionIdFromPath("/s/abc-123")).toBe("abc-123");
  });

  it("extracts the id from /s/:id/ (trailing slash)", () => {
    expect(parseSessionIdFromPath("/s/abc-123/")).toBe("abc-123");
  });

  it("returns null for /", () => {
    expect(parseSessionIdFromPath("/")).toBeNull();
  });

  it("returns null for /s/ with no id", () => {
    expect(parseSessionIdFromPath("/s/")).toBeNull();
  });

  it("returns null for other paths", () => {
    expect(parseSessionIdFromPath("/settings")).toBeNull();
    expect(parseSessionIdFromPath("/api/sessions")).toBeNull();
    expect(parseSessionIdFromPath("")).toBeNull();
  });

  it("rejects ids with unsafe characters", () => {
    // Path traversal etc. — session ids are restricted to a charset
    // elsewhere; the router only allows the same charset here.
    expect(parseSessionIdFromPath("/s/../etc")).toBeNull();
    expect(parseSessionIdFromPath("/s/foo/bar")).toBeNull();
    expect(parseSessionIdFromPath("/s/foo bar")).toBeNull();
  });
});

// ─── navigateToSession / replaceSessionInUrl ──────────────────────────────

describe("navigateToSession", () => {
  it("pushState to /s/:id", () => {
    const env = makeEnv("/");
    navigateToSession("abc", env);
    expect(env.history.stack).toEqual(["/s/abc"]);
  });

  it("pushState to / when id is null", () => {
    const env = makeEnv("/s/abc");
    navigateToSession(null, env);
    expect(env.history.stack).toEqual(["/"]);
  });
});

describe("replaceSessionInUrl", () => {
  it("replaceState to /s/:id", () => {
    const env = makeEnv("/s/old");
    replaceSessionInUrl("new", env);
    expect(env.history.stack).toEqual(["/s/new"]);
  });

  it("replaceState to / when id is null", () => {
    const env = makeEnv("/s/abc");
    replaceSessionInUrl(null, env);
    expect(env.history.stack).toEqual(["/"]);
  });
});

// ─── subscribeToRouteChanges ───────────────────────────────────────────────

describe("subscribeToRouteChanges", () => {
  it("returns an unsubscribe function even in non-browser env", () => {
    // Pass null to skip the real window.addEventListener call.
    const unsub = subscribeToRouteChanges(() => undefined, null);
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });
});