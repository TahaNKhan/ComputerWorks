// packages/server/src/title.test.ts
// Unit tests for deriveTitle. Pure function, easy to cover exhaustively.

import { describe, expect, it } from "bun:test";
import { deriveTitle, TITLE_MAX_LEN } from "./title.js";

// Fixed clock so the fallback tests are deterministic.
const NOW = new Date("2026-06-25T14:32:00");

describe("deriveTitle", () => {
  it("uses the cleaned first line as-is when short", () => {
    expect(deriveTitle("Help with React", NOW)).toBe("Help with React");
  });

  it("trims surrounding whitespace", () => {
    expect(deriveTitle("   Hello world   ", NOW)).toBe("Hello world");
  });

  it("collapses internal whitespace within a single line", () => {
    expect(deriveTitle("foo\t\t  bar", NOW)).toBe("foo bar");
    expect(deriveTitle("  many   spaces   inside  ", NOW)).toBe(
      "many spaces inside",
    );
  });

  it("strips ATX heading hashes", () => {
    expect(deriveTitle("# Help with React", NOW)).toBe("Help with React");
    expect(deriveTitle("### Help with React", NOW)).toBe("Help with React");
    expect(deriveTitle("###### Deep nesting", NOW)).toBe("Deep nesting");
  });

  it("strips blockquote markers (repeated)", () => {
    expect(deriveTitle("> quoted text", NOW)).toBe("quoted text");
    expect(deriveTitle(">> >  nested quote", NOW)).toBe("nested quote");
  });

  it("strips unordered list bullets", () => {
    expect(deriveTitle("- first item", NOW)).toBe("first item");
    expect(deriveTitle("* starred item", NOW)).toBe("starred item");
    expect(deriveTitle("+ plus item", NOW)).toBe("plus item");
  });

  it("strips ordered list markers", () => {
    expect(deriveTitle("1. first", NOW)).toBe("first");
    expect(deriveTitle("2) second", NOW)).toBe("second");
    expect(deriveTitle("42. many", NOW)).toBe("many");
  });

  it("does NOT strip a single inline backtick", () => {
    // Inline code (`` `foo` ``) is normal prose, not a code fence.
    expect(deriveTitle("`inline` is fine", NOW)).toBe("`inline` is fine");
  });

  it("strips leading triple+ backticks (code fence)", () => {
    expect(deriveTitle("```js", NOW)).toBe("js");
    expect(deriveTitle("````python", NOW)).toBe("python");
    // A pure fence line has no content after stripping — fallback.
    expect(deriveTitle("```", NOW)).toBe("Chat – 2026-06-25 14:32");
  });

  it("combines multiple noise prefixes in one message", () => {
    expect(deriveTitle("> > - # deep nesting", NOW)).toBe("deep nesting");
  });

  it("takes only the first non-empty line of a multi-line message", () => {
    expect(
      deriveTitle(
        "Subject: a quick question\n\nbody of the email goes here",
        NOW,
      ),
    ).toBe("Subject: a quick question");
  });

  it("skips empty leading lines", () => {
    expect(deriveTitle("\n\n\n  the real first line", NOW)).toBe(
      "the real first line",
    );
  });

  it("skips lines that are pure markdown noise", () => {
    expect(
      deriveTitle("> \n> > \n# \nactually the title", NOW),
    ).toBe("actually the title");
  });

  it("truncates at the nearest word boundary with an ellipsis", () => {
    const long =
      "Refactor the auth middleware to use a token store backed by Redis instead of in-memory state";
    // Total length > TITLE_MAX_LEN.
    const t = deriveTitle(long, NOW);
    expect(t.endsWith("…")).toBe(true);
    // Total length stays bounded.
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_LEN + 1);
    // No mid-word cut: the char immediately before the ellipsis
    // should be a word character (i.e. we ended ON a word, not in
    // the middle of one), AND that character should match the
    // character at the same position in the original input — which
    // means we never sliced a single word in half.
    const body = t.slice(0, -1);
    expect(body).toMatch(/\S$/);
    const lastChar = body.charAt(body.length - 1);
    expect(long.charAt(body.length - 1)).toBe(lastChar);
  });

  it("does not add an ellipsis when no truncation was needed", () => {
    expect(deriveTitle("short and sweet", NOW)).toBe("short and sweet");
  });

  it("hard-cuts a single very long word with no whitespace", () => {
    // 60-char word; max is 50. There's no word boundary inside, so
    // we slice at max and append `…`.
    const word = "a".repeat(60);
    const t = deriveTitle(word, NOW);
    expect(t.length).toBe(TITLE_MAX_LEN + 1);
    expect(t.endsWith("…")).toBe(true);
  });

  it("returns the date fallback when content is empty", () => {
    expect(deriveTitle("", NOW)).toBe("Chat – 2026-06-25 14:32");
  });

  it("returns the date fallback for whitespace-only input", () => {
    expect(deriveTitle("   \n\t  \n   ", NOW)).toBe(
      "Chat – 2026-06-25 14:32",
    );
  });

  it("returns the date fallback when every line is pure markdown noise", () => {
    expect(deriveTitle("# \n> \n- \n", NOW)).toBe(
      "Chat – 2026-06-25 14:32",
    );
  });

  it("returns the date fallback for non-string input (defensive)", () => {
    // @ts-expect-error – testing defensive path
    expect(deriveTitle(null, NOW)).toBe("Chat – 2026-06-25 14:32");
    // @ts-expect-error – testing defensive path
    expect(deriveTitle(undefined, NOW)).toBe("Chat – 2026-06-25 14:32");
  });

  it("uses `new Date()` by default", () => {
    const t = deriveTitle("");
    expect(t).toMatch(/^Chat – \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("normalizes CRLF line endings", () => {
    expect(deriveTitle("first line\r\n\r\nsecond line", NOW)).toBe(
      "first line",
    );
  });
});