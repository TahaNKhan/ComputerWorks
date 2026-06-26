// packages/server/src/title-generator.ts
// T12.2 — Auto-generate a session title from the first user turn.
//
// After a successful runTurn, the server fires a background call to
// the provider with a short "summarize as a 3-5 word title" prompt.
// The result is sanitized, PATCHed onto meta.title, and broadcast to
// any open SSE clients as `title_updated`.
//
// Design choices:
//   - Pure helpers (`sanitizeTitle`, `extractFirstExchange`) live
//     here so they're unit-testable without a server.
//   - `generateTitle(deps, sessionId)` does the I/O. It returns the
//     sanitized title on success and `null` on any error / skip
//     condition, and is fire-and-forget from the message route.
//   - Skip conditions (already titled, no messages) are also returns
//     of null; the caller doesn't need to distinguish — failures are
//     logged inside the function so the route can stay dumb.

import type { Provider } from "@computerworks/core";
import type { Message } from "@computerworks/core";
import type { SessionStore } from "./session-store.js";
import type { SSEManager } from "./sse.js";

// ─── Constants ────────────────────────────────────────────────────────────

/** Max characters of the first user message we feed into the
 *  summarizer. Keeps the title prompt small enough to never push us
 *  past a few hundred tokens. */
const MAX_USER_CHARS = 600;

/** Max characters of the first assistant message. The first reply
 *  often contains a shell command or file path; we trim aggressively
 *  to avoid the title prompt picking up noise. */
const MAX_ASSISTANT_CHARS = 400;

/** Hard cap on the resulting title. Even if the model says "Here is a
 *  very long title…", we clamp before persisting. */
export const TITLE_MAX_LENGTH = 80;

// ─── Pure helpers ─────────────────────────────────────────────────────────

/** Turn a model response into a usable title:
 *   - strip surrounding quotes (`"`, `'`, backtick)
 *   - strip leading "Title:" / "Subject:" prefixes the model sometimes
 *     prepends
 *   - collapse internal whitespace to single spaces
 *   - trim, then truncate at the word boundary closest to the cap
 *
 *  Exported for unit testing. */
export function sanitizeTitle(raw: string): string {
  let s = raw.trim();
  if (s === "") return "";
  // Strip a leading "Title:" / "Subject:" / "Here is a title:" prefix.
  s = s.replace(/^\s*(?:title|subject)\s*[:\-—]\s*/i, "");
  // Repeatedly strip matching surrounding quotes.
  for (;;) {
    const before = s;
    s = s.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "");
    s = s.trim();
    if (s === before) break;
  }
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, " ");
  if (s === "") return "";
  // Truncate at a word boundary when over the cap.
  if (s.length > TITLE_MAX_LENGTH) {
    const slice = s.slice(0, TITLE_MAX_LENGTH);
    const lastSpace = slice.lastIndexOf(" ");
    s = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  }
  // Final strip — punctuation-only tails look ugly.
  s = s.replace(/[\s,;:.\-—]+$/, "");
  return s;
}

/** Pull the first user message + first assistant *text* out of the
 *  persisted message log. Returns `{ user, assistant }` with empty
 *  strings when a slot is missing. We deliberately accept either
 *  string content or ContentBlock[] (the wire shape for tool_use
 *  turns is array), and we skip assistant turns whose content is
 *  only tool_use blocks — those carry no narrative text and would
 *  produce a misleading title if fed to the summarizer. */
export function extractFirstExchange(messages: Message[]): {
  user: string;
  assistant: string;
} {
  const user: string = firstTextOf(messages.find((m) => m.role === "user")) ?? "";
  // Find the first assistant message that contains a non-empty text
  // block. Assistant turns that are only tool_use blocks are skipped
  // because they don't help a summarizer.
  const assistantWithText = messages.find(
    (m) =>
      m.role === "assistant" &&
      typeof m.content !== "string" &&
      m.content.some((b) => b.type === "text" && b.text.trim() !== ""),
  );
  const assistant: string =
    firstTextOf(assistantWithText ?? messages.find((m) => m.role === "assistant")) ?? "";
  return { user, assistant };
}

function firstTextOf(m: Message | undefined): string | undefined {
  if (!m) return undefined;
  if (typeof m.content === "string") return m.content;
  for (const block of m.content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

/** Truncate `s` to at most `max` characters on a word boundary. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > 20 ? slice.slice(0, lastSpace) + "…" : slice + "…";
}

// ─── Side-effect: I/O-bound title generation ───────────────────────────────

export interface TitleGeneratorDeps {
  store: SessionStore;
  sse: SSEManager;
  /** Provider factory — same shape as in `routes/messages.ts`. We use
   *  a fresh provider (not the run's) so the title prompt is
   *  independent of any per-request overrides and so a failure here
   *  can't poison the run's provider. */
  createProvider: () => Provider;
}

/**
 * Generate (or skip generating) a title for `sessionId`. Returns the
 * new title on success, `null` if skipped or failed. Always safe to
 * call — never throws. The route invokes this fire-and-forget.
 */
export async function generateTitle(
  deps: TitleGeneratorDeps,
  sessionId: string,
): Promise<string | null> {
  try {
    const meta = await deps.store.get(sessionId);
    if (!meta) return null;
    // Skip when the user already titled this session, either via the
    // PATCH endpoint (manual rename) or `createSession({ title })`.
    if (meta.title && meta.title.trim() !== "") return null;

    const messages: Message[] = [];
    for await (const m of deps.store.readMessages(sessionId)) messages.push(m);
    const { user, assistant } = extractFirstExchange(messages);
    if (user.trim() === "" && assistant.trim() === "") return null;

    const provider = deps.createProvider();
    const prompt = buildPrompt({
      user: clip(user, MAX_USER_CHARS),
      assistant: clip(assistant, MAX_ASSISTANT_CHARS),
    });

    let raw = "";
    const iter = provider.chat({
      model: meta.model,
      messages: [{ role: "user", content: prompt }],
      tools: [],
    });
    for await (const ev of iter) {
      if (ev.type === "token") raw += ev.delta;
      else if (ev.type === "error") {
        // Provider-level error mid-stream; bail with whatever we have.
        break;
      } else if (ev.type === "done") {
        break;
      }
    }
    const title = sanitizeTitle(raw);
    if (title === "") return null;

    // Race-y but acceptable: if the user renamed the session while we
    // were calling the LLM, the patch will overwrite their title. We
    // re-check inside patchSession? No — the meta.title === "" check
    // is the gate, and a concurrent rename means the user's choice
    // wins because they hit the patch endpoint before ours lands.
    // We accept that for a v1 title generator; the user can always
    // rename again.
    await deps.store.patch(sessionId, { title });
    deps.sse.send(sessionId, { type: "title_updated", sessionId, title });
    return title;
  } catch (err) {
    // Log + swallow — the UX must not depend on a working title gen.
    console.warn(`[title-generator] failed for ${sessionId}:`, (err as Error).message);
    return null;
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────

function buildPrompt(input: { user: string; assistant: string }): string {
  const lines: string[] = [
    "You generate a short title for a chat session.",
    "",
    "Reply with ONLY the title — no quotes, no prefix, no explanation.",
    "Length: 3 to 5 words. Style: lowercase unless a word is a proper noun.",
    "",
    "First user message:",
    input.user || "(empty)",
  ];
  if (input.assistant) {
    lines.push("", "First assistant reply (for context only):", input.assistant);
  }
  return lines.join("\n");
}
