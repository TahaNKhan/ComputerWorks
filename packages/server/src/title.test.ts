// packages/server/src/title.test.ts
// Tests for deriveTitle(). The function now delegates title generation to
// the Anthropic provider via getDefaultAnthropicProvider().inferText(),
// so the tests mock @computerworks/core and assert two things:
//   1. The prompt sent to the LLM contains the cleaned content (and
//      not the raw markdown noise).
//   2. The LLM's response is truncated to TITLE_MAX_LEN when needed,
//      with the `…` suffix, and returned verbatim otherwise.
//
// Deterministic paths (date fallback when content is empty) are tested
// by leaving the mock response untouched and asserting no LLM call was
// made.

import { beforeEach, describe, expect, it, mock } from "bun:test";

// ─── LLM mock state ────────────────────────────────────────────────────────

interface MockState {
  response: string;
  calls: number;
  capturedPrompt: string;
}

const mockState: MockState = {
  response: "Mock Title",
  calls: 0,
  capturedPrompt: "",
};

// Mock @computerworks/core before title.ts is imported, so deriveTitle's
// `import { getDefaultAnthropicProvider } from "@computerworks/core"`
// resolves to our fake provider.
mock.module("@computerworks/core", () => ({
  getDefaultAnthropicProvider: () => ({
    inferText: async (prompt: string): Promise<string> => {
      mockState.calls += 1;
      mockState.capturedPrompt = prompt;
      return mockState.response;
    },
  }),
}));

const { deriveTitle, TITLE_MAX_LEN } = await import("./title.js");

// ─── Test helpers ──────────────────────────────────────────────────────────

const FIXED_NOW = new Date(2026, 5, 26, 14, 7); // 2026-06-26 14:07 local

function resetMock(response = "Mock Title"): void {
  mockState.response = response;
  mockState.calls = 0;
  mockState.capturedPrompt = "";
}

function formatFallback(d: Date = FIXED_NOW): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `Chat – ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("deriveTitle — markdown / whitespace normalization", () => {
  beforeEach(() => resetMock());

  it("strips leading '# ' heading noise", async () => {
    await deriveTitle("# Help with React");
    expect(mockState.capturedPrompt).toContain("Help with React");
    expect(mockState.capturedPrompt).not.toMatch(/User Input:\s*#/);
  });

  it("strips '## ' and '### ' style headings", async () => {
    await deriveTitle("###   Database migration plan");
    expect(mockState.capturedPrompt).toContain("Database migration plan");
  });

  it("strips leading '>' blockquote", async () => {
    await deriveTitle("> Quote this please");
    expect(mockState.capturedPrompt).toContain("Quote this please");
    expect(mockState.capturedPrompt).not.toMatch(/User Input:\s*>/);
  });

  it("strips '-' / '*' / '+' unordered list bullets", async () => {
    await deriveTitle("- buy groceries");
    expect(mockState.capturedPrompt).toContain("buy groceries");

    resetMock();
    await deriveTitle("* write tests");
    expect(mockState.capturedPrompt).toContain("write tests");

    resetMock();
    await deriveTitle("+ ship it");
    expect(mockState.capturedPrompt).toContain("ship it");
  });

  it("strips '1.' / '2)' ordered list markers", async () => {
    await deriveTitle("1. First item");
    expect(mockState.capturedPrompt).toContain("First item");

    resetMock();
    await deriveTitle("2) Second item");
    expect(mockState.capturedPrompt).toContain("Second item");
  });

  it("strips ``` code fence opener (3+ backticks)", async () => {
    // Bare fence (no language identifier) cleans to "", so the
    // function skips it and uses the next line. (With a language
    // tag like ```js, the function stops at "js" — that's a
    // documented quirk of the per-line strip.)
    await deriveTitle("```\nfoo();\n```");
    expect(mockState.capturedPrompt).toContain("foo();");
    expect(mockState.capturedPrompt).not.toMatch(/User Input:.*`{3}/);
  });

  it("loops to peel off repeated noise (e.g. '> > quoted')", async () => {
    await deriveTitle("> > deeply quoted");
    expect(mockState.capturedPrompt).toContain("deeply quoted");
  });

  it("collapses internal whitespace runs to a single space", async () => {
    await deriveTitle("hello    world\n\n\tfoo");
    expect(mockState.capturedPrompt).toContain("hello world");
  });

  it("uses only the first non-empty line of multi-line input", async () => {
    await deriveTitle("first line\n\nsecond line\nthird");
    expect(mockState.capturedPrompt).toContain("first line");
    expect(mockState.capturedPrompt).not.toMatch(/second line/);
    expect(mockState.capturedPrompt).not.toMatch(/third/);
  });

  it("normalizes CRLF and CR line endings to LF", async () => {
    await deriveTitle("windows line\r\nanother");
    expect(mockState.capturedPrompt).toContain("windows line");
    expect(mockState.capturedPrompt).not.toContain("\r");

    resetMock();
    await deriveTitle("old mac line\ranother");
    expect(mockState.capturedPrompt).toContain("old mac line");
  });

  it("trims leading and trailing whitespace", async () => {
    await deriveTitle("   trimmed   ");
    expect(mockState.capturedPrompt).toContain("User Input: trimmed");
    // No run of two+ spaces right before the cleaned content.
    expect(mockState.capturedPrompt).not.toMatch(/User Input:\s{2,}\w/);
    // No trailing whitespace before end-of-string or quote.
    expect(mockState.capturedPrompt).not.toMatch(/\s+$/);
  });
});

describe("deriveTitle — LLM integration", () => {
  beforeEach(() => resetMock());

  it("returns the LLM's response verbatim when it fits", async () => {
    resetMock("Help with React");
    const title = await deriveTitle("anything");
    expect(title).toBe("Help with React");
    expect(mockState.calls).toBe(1);
  });

  it("truncates a long LLM response to TITLE_MAX_LEN with an ellipsis", async () => {
    const long = "x".repeat(TITLE_MAX_LEN + 30);
    resetMock(long);
    const title = await deriveTitle("trigger truncation");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LEN + 1); // +1 for the ellipsis
    expect(title.length).toBeGreaterThan(1);
  });

  it("truncation cuts at a word boundary, not mid-word", async () => {
    // 50 chars exactly → no truncation, no ellipsis.
    resetMock("a".repeat(TITLE_MAX_LEN));
    const exact = await deriveTitle("x");
    expect(exact).toBe("a".repeat(TITLE_MAX_LEN));
    expect(exact.endsWith("…")).toBe(false);

    // Long wordy string → cut happens before TITLE_MAX_LEN at a space.
    resetMock("alpha beta gamma delta epsilon zeta eta theta iota kappa");
    const cut = await deriveTitle("x");
    expect(cut.endsWith("…")).toBe(true);
    // No whitespace at the cut point — should end with a clean word + ellipsis.
    expect(cut).not.toMatch(/\s…$/);
  });

  it("falls back to a hard slice when the response is one giant word", async () => {
    resetMock("z".repeat(TITLE_MAX_LEN + 20));
    const title = await deriveTitle("x");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(TITLE_MAX_LEN + 1);
  });

  it("prompt tells the LLM the length budget and the 'User Input' marker", async () => {
    await deriveTitle("anything goes");
    expect(mockState.capturedPrompt).toContain(String(TITLE_MAX_LEN));
    expect(mockState.capturedPrompt).toContain("User Input:");
    expect(mockState.capturedPrompt).toContain("anything goes");
    expect(mockState.capturedPrompt).toMatch(/less that \d+ characters/);
  });
});

describe("deriveTitle — date fallback", () => {
  beforeEach(() => resetMock());

  it("returns the date fallback for empty content (no LLM call)", async () => {
    const title = await deriveTitle("", FIXED_NOW);
    expect(title).toBe(formatFallback(FIXED_NOW));
    expect(mockState.calls).toBe(0);
  });

  it("returns the date fallback for whitespace-only content", async () => {
    const title = await deriveTitle("   \n\n\t   ", FIXED_NOW);
    expect(title).toBe(formatFallback(FIXED_NOW));
    expect(mockState.calls).toBe(0);
  });

  it("returns the date fallback when every line is markdown noise", async () => {
    const title = await deriveTitle("###\n>\n-\n```\n", FIXED_NOW);
    expect(title).toBe(formatFallback(FIXED_NOW));
    expect(mockState.calls).toBe(0);
  });

  it("returns the date fallback for a non-string content (defensive)", async () => {
    // TS would prevent this at compile time, but the runtime check exists
    // so test the path by casting through unknown.
    const title = await deriveTitle(
      undefined as unknown as string,
      FIXED_NOW,
    );
    expect(title).toBe(formatFallback(FIXED_NOW));
    expect(mockState.calls).toBe(0);
  });

  it("date fallback uses an EN DASH and pads month/day/hour/minute", async () => {
    const cases: Array<[Date, string]> = [
      [new Date(2026, 0, 1, 0, 0), "Chat – 2026-01-01 00:00"],
      [new Date(2026, 11, 31, 23, 59), "Chat – 2026-12-31 23:59"],
      [new Date(2026, 5, 26, 14, 7), "Chat – 2026-06-26 14:07"],
    ];
    for (const [d, expected] of cases) {
      expect(await deriveTitle("", d)).toBe(expected);
    }
  });

  it("uses `new Date()` for `now` when no clock is provided", async () => {
    const before = Date.now();
    const title = await deriveTitle("");
    const after = Date.now();
    expect(title.startsWith("Chat –")).toBe(true);
    // Title has minute precision, so the parsed timestamp must fall
    // inside the minute window that contained the test run.
    const ts = Date.parse(title.replace("Chat – ", "").replace(" ", "T"));
    expect(ts).toBeGreaterThanOrEqual(before - 60_000);
    expect(ts).toBeLessThanOrEqual(after + 60_000);
  });
});