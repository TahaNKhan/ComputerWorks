// packages/ui/src/lib/router.ts
// T12.2 — Lightweight client-side router for the active session id.
//
// Shape: `/s/:id` is the deep link to a session; `/` (or anything
// else) means "no active session". We use the History API directly
// instead of pulling in react-router — the URL only carries one
// piece of state (the active session id), so the full router library
// would be overkill.
//
// Side-effects (push/replace) and reads (parse, popstate) are
// exported as pure-ish functions; tests exercise them by stubbing
// `window.history` and `window.location` via dependency injection so
// the test environment doesn't need a real DOM.

const SESSION_PATH = /^\/s\/([A-Za-z0-9._-]+)\/?$/;

/** Parse the session id from a pathname. Returns null for `/` or any
 *  path that doesn't match the `/s/:id` shape. */
export function parseSessionIdFromPath(pathname: string): string | null {
  const m = SESSION_PATH.exec(pathname);
  return m ? (m[1] ?? null) : null;
}

/** Parse the current session id from `window.location.pathname`.
 *  Returns null in non-browser environments (tests, SSR). */
export function parseSessionIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return parseSessionIdFromPath(window.location.pathname);
}

/** Minimal History-API surface we depend on. Lets tests inject a
 *  fake without monkey-patching globals. */
export interface HistoryLike {
  pushState(data: unknown, unused: string, url: string): void;
  replaceState(data: unknown, unused: string, url: string): void;
}

export interface LocationLike {
  pathname: string;
}

export interface RouterEnv {
  history: HistoryLike;
  location: LocationLike;
}

function defaultEnv(): RouterEnv | null {
  if (typeof window === "undefined") return null;
  return {
    history: window.history,
    location: window.location,
  };
}

function buildPath(id: string | null): string {
  return id ? `/s/${id}` : "/";
}

/** Push a new history entry for the given session id. Use when the
 *  user explicitly switches sessions (so back/forward works). */
export function navigateToSession(
  id: string | null,
  env: RouterEnv | null = defaultEnv(),
): void {
  if (!env) return;
  env.history.pushState({}, "", buildPath(id));
}

/** Replace the current history entry. Use on initial mount so a
 *  reload of `/s/:id` doesn't add a stale entry to the back stack. */
export function replaceSessionInUrl(
  id: string | null,
  env: RouterEnv | null = defaultEnv(),
): void {
  if (!env) return;
  env.history.replaceState({}, "", buildPath(id));
}

/** Subscribe to back/forward navigation. The handler receives the
 *  session id parsed from `env.location.pathname` (or null when the
 *  URL is `/`). Returns an unsubscribe function. */
export function subscribeToRouteChanges(
  handler: (sessionId: string | null) => void,
  env: RouterEnv | null = defaultEnv(),
): () => void {
  if (typeof window === "undefined" || !env) {
    return () => undefined;
  }
  function onPop(): void {
    handler(parseSessionIdFromPath(env!.location.pathname));
  }
  window.addEventListener("popstate", onPop);
  return () => {
    window.removeEventListener("popstate", onPop);
  };
}