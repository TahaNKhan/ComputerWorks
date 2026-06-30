// packages/server/src/tools/rename-session.ts
// T19.2 — Auto-approved rename_session tool.
//
// Replaces the T12.2 fire-and-forget first-turn title generator. The
// model decides when the title is stale and calls this tool; the
// server enforces:
//   - manual-rename lock (`titleSource === "manual"` → reject)
//   - server-side rate limit (`userCount - last < min` → reject;
//     the first rename is always allowed)
//   - sanitization (T12.2's `sanitizeTitle` moved here verbatim)
//
// On success the tool PATCHes meta + broadcasts
// `session_renamed` via the central SSE so every tab on the origin
// sees the rename (Phase 17's SyncHub wiring). The chat view
// flashes a `rename_session` tool call + `tool_result` message via
// the existing per-message SSE pipeline — no agent-loop changes.

import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@computerworks/core";
import type { Message } from "@computerworks/core";
import type { SessionStore } from "../session-store.js";
import type { SyncHub } from "../sync-hub.js";

// ─── Input schema ─────────────────────────────────────────────────────────

export const renameSessionInputSchema = z.object({
  /** Proposed title (3–5 words). Sanitized server-side; LLM-supplied
   *  control characters / quotes are stripped before persistence. */
  title: z.string().min(1).max(200),
});

export type RenameSessionInput = z.infer<typeof renameSessionInputSchema>;

// ─── Result + reason codes ────────────────────────────────────────────────

export type RenameResult =
  | { ok: true; title: string }
  | {
      ok: false;
      reason:
        | "manual_rename_locked"
        | "rate_limited"
        | "empty_after_sanitize"
        | "session_not_found";
    };

// ─── Sanitizer (moved from title-generator.ts) ───────────────────────────

/** Hard cap on the resulting title. */
export const TITLE_MAX_LENGTH = 80;

/** Turn a model-supplied title into a usable one:
 *   - strip surrounding quotes (`"`, `'`, backtick, smart quotes)
 *   - strip leading "Title:" / "Subject:" prefixes the model sometimes
 *     prepends
 *   - collapse internal whitespace to single spaces
 *   - trim, then truncate at the word boundary closest to the cap
 *   - strip trailing punctuation
 *
 *  Exported for unit testing. The logic is unchanged from T12.2;
 *  moving it here keeps the rename tool self-contained. */
export function sanitizeTitle(raw: string): string {
  let s = raw.trim();
  if (s === "") return "";
  s = s.replace(/^\s*(?:title|subject)\s*[:\-—]\s*/i, "");
  for (;;) {
    const before = s;
    s = s.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "");
    s = s.trim();
    if (s === before) break;
  }
  s = s.replace(/\s+/g, " ");
  if (s === "") return "";
  if (s.length > TITLE_MAX_LENGTH) {
    const slice = s.slice(0, TITLE_MAX_LENGTH);
    const lastSpace = slice.lastIndexOf(" ");
    s = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  }
  s = s.replace(/[\s,;:.\-—]+$/, "");
  return s;
}

// ─── Tool factory ────────────────────────────────────────────────────────

export interface RenameSessionToolOptions {
  store: SessionStore;
  syncHub: SyncHub;
  /** Minimum number of user messages between successful renames.
   *  The first rename is always allowed. */
  minMessagesBetweenRenames: number;
}

/**
 * Build the `rename_session` tool. The factory closes over the store
 * + syncHub at construction time; registered into the same
 * `ToolRegistry` as every other tool via `defaultTools`.
 */
export function createRenameSessionTool(
  opts: RenameSessionToolOptions,
): ToolDefinition {
  return {
    name: "rename_session",
    description:
      `Update the session title shown in the sidebar so the user ` +
      `can find this conversation later. ` +
      `CALL THIS WHENEVER the topic has shifted or the current ` +
      `title is empty / inaccurate. ` +
      `The title should be 3-5 words (lowercase, except proper ` +
      `nouns). ` +
      `Returns { ok: true, title } on success, or { ok: false, ` +
      `reason } where reason is one of: ` +
      `"manual_rename_locked" (user renamed the session — respect ` +
      `their choice, do NOT retry), ` +
      `"rate_limited" (called too soon — min ` +
      `${opts.minMessagesBetweenRenames} user messages between ` +
      `renames; back off), ` +
      `"empty_after_sanitize" (the title was empty after ` +
      `stripping quotes/whitespace/punctuation — try a different ` +
      `title), ` +
      `or "session_not_found" (defensive).`,
    inputSchema: renameSessionInputSchema as unknown as ToolDefinition["inputSchema"],
    requiresApproval: false,
    async execute(input: RenameSessionInput, ctx: ToolContext): Promise<RenameResult> {
      return runRename(opts, input, ctx);
    },
  };
}

// ─── Core logic ──────────────────────────────────────────────────────────

async function runRename(
  opts: RenameSessionToolOptions,
  input: RenameSessionInput,
  ctx: ToolContext,
): Promise<RenameResult> {
  const meta = await opts.store.get(ctx.sessionId);
  if (!meta) return { ok: false, reason: "session_not_found" };
  if (meta.titleSource === "manual") {
    return { ok: false, reason: "manual_rename_locked" };
  }

  // Count user messages in the persisted transcript. This is the
  // rate-limit clock — independent of any in-memory turn counter
  // so the cadence survives restarts.
  let userCount = 0;
  for await (const m of opts.store.readMessages(ctx.sessionId)) {
    if (m.role === "user") userCount++;
  }

  // Server-side rate limit. The first rename (last === undefined)
  // is always allowed so the model can give the session an initial
  // title on turn 1.
  const last = meta.lastRenamedAtMessageCount;
  if (last !== undefined) {
    if (userCount - last < opts.minMessagesBetweenRenames) {
      return { ok: false, reason: "rate_limited" };
    }
  }

  const sanitized = sanitizeTitle(input.title);
  if (sanitized === "") {
    return { ok: false, reason: "empty_after_sanitize" };
  }

  // Atomic patch via the existing tmp+rename path, serialized via
  // enqueueWrite (T18) so it can't race with the agent loop's
  // appendMessage bump.
  await opts.store.patch(ctx.sessionId, {
    title: sanitized,
    titleSource: "auto",
    lastRenamedAtMessageCount: userCount,
  });
  opts.syncHub.broadcast({
    type: "session_renamed",
    sessionId: ctx.sessionId,
    title: sanitized,
    titleSource: "auto",
  });

  return { ok: true, title: sanitized };
}

// Re-export the message-shape only used for tests / type inference.
export type { Message };
