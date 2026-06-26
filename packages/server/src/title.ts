// packages/server/src/title.ts
// T12.1 — Derive a short, human-readable title from a session's first
// user message. The result is what shows up in the sidebar and in
// `computerworks sessions list`.
//
// Rules (in order):
//   1. Trim leading/trailing whitespace.
//   2. Strip leading markdown noise (headings, blockquotes, list
//      bullets, code-fence backticks) so `# Help with React` becomes
//      `Help with React`.
//   3. Collapse internal whitespace.
//   4. Take the first non-empty line (a user sometimes pastes a
//      multi-line message; we only want the headline).
//   5. Truncate to ≤ MAX_LEN chars at the nearest word boundary;
//      append `…` if truncation actually happened.
//   6. Fallback: if the cleaned content is empty (all markdown noise,
//      all whitespace, all emoji, etc.) return `Chat – YYYY-MM-DD
//      HH:MM` so the session always has a name.
//
// Pure function. No I/O. Deterministic except for the date fallback,
// which depends on `now` (defaults to `new Date()`). Tests pass an
// explicit `now` to keep the assertion stable.

import { getDefaultAnthropicProvider } from "@computerworks/core";

/** Max length of a derived title, not counting the trailing ellipsis. */
export const TITLE_MAX_LEN = 50;

/** Strip leading markdown noise from a single line. The regex is
 *  intentionally conservative — we don't try to be a full markdown
 *  parser, just to peel off the prefixes users most commonly add
 *  when they paste into chat. We match triple (or longer) backticks
 *  for code-fence stripping because a single leading backtick is far
 *  more often inline-code formatting (`` `foo` ``) than a fence. */
function stripMarkdownNoise(line: string): string {
  // Repeatedly strip: leading whitespace, then any of:
  //   - `#`, `##`, …  (ATX headings)
  //   - `>`            (blockquote)
  //   - `-`, `*`, `+`  (unordered list bullets)
  //   - `1.`, `2)`     (ordered list markers; 1-3 digits)
  //   - ```` ``` ```` (code-fence opener, 3+ backticks)
  // After each strip the loop runs again in case the user wrote
  // `> > > quoted` or similar.
  let out = line;
  let changed = true;
  while (changed) {
    changed = false;
    const next = out.replace(
      /^\s*(?:#{1,6}|>|[-*+]|\d{1,3}[.)]|`{3,})\s*/,
      "",
    );
    if (next !== out) {
      out = next;
      changed = true;
    }
  }
  return out;
}

/** Truncate `s` to at most `maxLen` chars at the nearest word
 *  boundary. If we had to cut, append `…` (U+2026). If `s` already
 *  fits, return it unchanged (no ellipsis on a clean fit). */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  // Find the last whitespace at or before maxLen so we don't slice
  // mid-word. If there's no whitespace in the first maxLen chars
  // (one very long word), fall back to a hard slice.
  const slice = s.slice(0, maxLen);
  const lastSpace = slice.search(/\s\S*$/);
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/\s+$/, "") + "…";
}

/** Format a date as `Chat – YYYY-MM-DD HH:MM` in local time. Centralized
 *  so the test can pin the exact output. Uses an EN DASH (U+2013)
 *  surrounded by single spaces — a subtle typographic touch that makes
 *  the sidebar easier to scan than an ASCII hyphen. */
function formatChatFallback(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Chat – ${date}`;
}

async function generateTitle(input: string) {
  const provider = getDefaultAnthropicProvider();
  const prompt = `Generate a title for a chat given the following user input, keep it concise, less that ${TITLE_MAX_LEN} characters, do not use quotes just return bare text. User Input: ${input}`;
  const text = await provider.inferText(prompt);
  return text;
}

/**
 * Derive a session title from the first user message.
 *
 * @param content The raw first user message.
 * @param now     Optional clock for the date fallback (testing hook).
 */
export async function deriveTitle(content: string, now: Date = new Date()): Promise<string> {
  if (typeof content !== "string") return formatChatFallback(now);

  // Normalize line endings and split on newlines so a multi-line
  // message yields just its first useful line.
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const cleaned = stripMarkdownNoise(raw).replace(/\s+/g, " ").trim();
    if (cleaned.length > 0) {
      return truncate(await generateTitle(cleaned), TITLE_MAX_LEN);
    }
  }
  return formatChatFallback(now);
}