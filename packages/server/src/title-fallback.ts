// packages/server/src/title-fallback.ts
// T19.12 — Server-side fallback for the LLM-driven retitler.
//
// The model can rename the session whenever it wants (no rate
// limit by default, T19.12). But models are sometimes lax —
// they may go many turns without calling `rename_session`,
// leaving the sidebar with "(untitled)" or a stale first-turn
// title. To keep the sidebar useful, we fire a background
// fallback that:
//
//   1. Re-reads meta (so a concurrent successful `rename_session`
//      is honored — if the LLM already named it, we skip).
//   2. Checks if `meta.title === ""` AND the persisted transcript
//      has at least one user message. Both gates must be true.
//   3. Calls `deriveTitle` (T12.1's deterministic helper that
//      strips markdown noise, truncates at a word boundary, and
//      asks the LLM for a short summary).
//   4. Patches meta with `{ title, titleSource: "auto" }` and
//      broadcasts `session_renamed` — only if the patch
//      succeeded. The patch is serialized via `enqueueWrite`
//      (T18) so it can't race with the agent loop's
//      `appendMessage`-driven `updatedAt` bump or a concurrent
//      manual rename.
//
// Errors are swallowed — the fallback is best-effort. The
// user's turn is never blocked on a working title.
//
// The fallback only fires UNTIL the session has a title. Once
// the LLM names the session (or the user does via PATCH) the
// title is no longer empty and the fallback is permanently
// dormant for that session. A user can reset to untitled by
// PATCHing `{ title: "" }` (which the route stamps as
// `titleSource: "auto"`) — at which point the next message
// will re-trigger the fallback.

import type { SessionStore } from "./session-store.js";
import type { SyncHub } from "./sync-hub.js";
import { deriveTitle } from "./title.js";

export interface EnsureTitleFallbackDeps {
  store: SessionStore;
  syncHub: SyncHub;
  sessionId: string;
  /** The current user message's content. We pass it through to
   *  `deriveTitle` so the fallback can summarize it directly
   *  without re-scanning the transcript. */
  userContent: string;
}

/**
 * Fire-and-forget fallback. Returns a promise so the caller can
 * `await` it for testing; the route calls it without awaiting so
 * the user's turn isn't blocked. Errors are logged + swallowed.
 */
export async function ensureTitleFallback(
  deps: EnsureTitleFallbackDeps,
): Promise<void> {
  try {
    // Re-fetch the latest meta. The agent loop's
    // `appendMessage`-driven bumps and any concurrent
    // `rename_session` calls have all gone through patch by the
    // time we read — `enqueueWrite` guarantees linear ordering.
    const meta = await deps.store.get(deps.sessionId);
    if (!meta) return;
    if (meta.title && meta.title.trim() !== "") return; // already named
    if (meta.titleSource === "manual") return; // user locked it; never auto-name

    // The first user message is sufficient signal — derive from it.
    // If the user message is empty (shouldn't happen since the
    // route validates min(1) on the body), skip.
    const trimmed = deps.userContent.trim();
    if (trimmed === "") return;

    const title = await deriveTitle(trimmed);
    // deriveTitle returns "" only when the date fallback fails too
    // (defensive); skip the patch if so.
    if (title === "") return;

    // Race-safe patch: re-check the title is still empty before
    // writing. The atomic `enqueueWrite` (T18) serializes this
    // against any concurrent patch.
    const fresh = await deps.store.get(deps.sessionId);
    if (!fresh) return;
    if (fresh.title && fresh.title.trim() !== "") return;
    if (fresh.titleSource === "manual") return;

    await deps.store.patch(deps.sessionId, {
      title,
      titleSource: "auto",
    });

    deps.syncHub.broadcast({
      type: "session_renamed",
      sessionId: deps.sessionId,
      title,
      titleSource: "auto",
    });
  } catch (err) {
    // Best-effort. The user's turn is never blocked on a working
    // title generator.
    console.warn(
      `[title-fallback] failed for ${deps.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
