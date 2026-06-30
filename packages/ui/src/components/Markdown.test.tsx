// packages/ui/src/components/Markdown.test.tsx
// Regression tests for the markdown renderer.
//
// The interesting case is inline vs block code. Before the fix, the
// `code` component branched on an `inline` prop that react-markdown 9
// no longer passes, so every inline ``code`` got routed through
// FencedCode (which wraps in a <div class="cw-code-block">). This
// test pins the correct behavior.

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { Markdown } from "./Markdown.js";

describe("Markdown", () => {
  test("inline backtick code renders as a <code> chip, not a block", () => {
    const html = renderToString(<Markdown source="prefix `cmd` suffix" />);

    // The chip must be present…
    expect(html).toContain("cmd");
    expect(html).toContain("cw-inline-code");
    // …and the surrounding words must sit in the same <p>.
    expect(html).toMatch(/prefix\s+<code[^>]*class="cw-inline-code"[^>]*>cmd<\/code>\s+suffix/);

    // The block path must not have been taken.
    expect(html).not.toContain("cw-code-block");
  });

  test("a fenced code block still renders as FencedCode (block div + lang + copy)", () => {
    const html = renderToString(
      <Markdown source={"before\n```bash\necho hi\n```\nafter"} />,
    );

    expect(html).toContain("cw-code-block");
    expect(html).toContain("cw-code-lang");
    expect(html).toContain("echo hi");
    // Sanity: the block chip class must not appear inside a fenced block.
    expect(html).not.toContain("cw-inline-code");
  });

  test("multiple inline chips in one paragraph all render", () => {
    const html = renderToString(
      <Markdown source={"use `ls` to list and `cat` to read"} />,
    );

    const inlineMatches = html.match(/cw-inline-code/g) ?? [];
    expect(inlineMatches.length).toBe(2);
    expect(html).not.toContain("cw-code-block");
  });
});
