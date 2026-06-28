// packages/ui/src/lib/router.ts
// T12.1 — URL routing for the SPA.
//
// The active session id lives in two places: the zustand store
// (`activeSessionId`) and the URL query string (`?session=<id>`).
// This module owns the URL side. The store decides what to do with
// the resulting id.
//
// URL shape: `/?session=<id>` (query param — keeps the app a pure SPA,
// no Fastify SPA fallback needed).
//
// Design notes:
//   - Pure helpers (`parseSessionFromUrl`, `buildSessionUrl`) accept a
//     URL string and return a string or null. They never touch the
//     global `window`, so they're trivially unit-testable.
//   - Side-effect helpers (`getSessionFromUrl`, `setSessionInUrl`,
//     `subscribeUrlChange`) are thin wrappers over `window.history` and
//     `window.addEventListener('popstate', …)`. Tests skip these and
//     exercise the pure layer; integration is verified in the store.
//
// The query-string is intentionally minimal:
//   - `?session=<id>` → activate that session
//   - `?session=` (empty value) → same as no param
//   - no param → empty state (no active session)

const SESSION_PARAM = "session";

// ─── Pure helpers (exported for unit tests) ────────────────────────────────

/** Parse `?session=<id>` out of a URL string. Returns the id (string,
 *  non-empty) or null when the param is missing / blank. Other query
 *  params are ignored — we don't strip them so callers can preserve
 *  them via `buildSessionUrl`. */
export function parseSessionFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://placeholder.test");
  } catch {
    return null;
  }
  const raw = parsed.searchParams.get(SESSION_PARAM);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Build a URL string for `?session=<id>`. If `id` is null, drops the
 *  param entirely. Preserves any other query params from `currentUrl`.
 *  The path is preserved verbatim (no normalization), so callers can
 *  pass either `/` or `/something` and get the same path back. */
export function buildSessionUrl(currentUrl: string, id: string | null): string {
  let parsed: URL;
  try {
    parsed = new URL(currentUrl, "http://placeholder.test");
  } catch {
    parsed = new URL("http://placeholder.test/");
  }
  if (id === null) {
    parsed.searchParams.delete(SESSION_PARAM);
  } else {
    parsed.searchParams.set(SESSION_PARAM, id);
  }
  // `URL.toString()` always includes the placeholder origin; strip it
  // so callers get a path-only string like `/?session=abc`.
  const out = parsed.pathname + parsed.search + parsed.hash;
  return out === "" ? "/" : out;
}

// ─── Side-effect helpers (DOM-bound) ──────────────────────────────────────

/** Read the active session id from the current page URL. Returns null
 *  when no param is present. Browser-only. */
export function getSessionFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return parseSessionFromUrl(window.location.href);
}

/** Write the active session id into the URL via `history.pushState`
 *  (so the back button walks the session history). When `id` is null
 *  the param is removed entirely, leaving the path clean. Browser-only.
 *
 *  We deliberately do NOT dispatch a synthetic `popstate` event —
 *  `pushState` is a user-driven action and we don't want the listener
 *  to echo it back through the store. */
export function setSessionInUrl(id: string | null): void {
  if (typeof window === "undefined") return;
  const next = buildSessionUrl(window.location.href, id);
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next === current) return;
  window.history.pushState({ session: id }, "", next);
}

/** Subscribe to URL changes driven by the browser (back/forward
 *  buttons, or manual edits to the address bar). Returns an
 *  unsubscribe function. The callback receives the new session id
 *  derived from the current URL (null when absent). Browser-only. */
export function subscribeUrlChange(cb: (id: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  function handler(): void {
    cb(parseSessionFromUrl(window.location.href));
  }
  window.addEventListener("popstate", handler);
  return () => {
    window.removeEventListener("popstate", handler);
  };
}
