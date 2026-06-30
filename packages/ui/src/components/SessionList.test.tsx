// packages/ui/src/components/SessionList.test.tsx
// T19.8 — Tests for the sidebar row's slide-in animation.
//
// The Row component's animation-gating logic — bump the key when
// the title changes AND titleSource is "auto" — is mirrored here
// as a pure function so we can test the contract without rendering.
// The actual render path uses React's `key` prop on the title
// `<span>`; bumping the key retriggers the `@keyframes
// cw-row-title-in` animation defined in `global.css`. SSR with
// `renderToString` doesn't expose `useEffect`, so the rendering
// path is verified manually (T19.10 smoke); the reducer +
// state-shape round-trip is pinned in `reducer.test.ts`.

import { describe, expect, test } from "bun:test";

/** Mirror of the Row component's animation-gating logic. The
 *  component reads `prevTitle.current !== props.title && props.titleSource === "auto"`
 *  in a useEffect; this is the same predicate, factored out for
 *  unit testing. */
function shouldAnimate(
  prevTitle: string,
  nextTitle: string,
  nextSource: "auto" | "manual" | undefined,
): boolean {
  if (prevTitle === nextTitle) return false; // cold start / no change
  return nextSource === "auto";
}

describe("SessionList Row — animation gating (T19.8)", () => {
  test("cold start: same title, no animation", () => {
    expect(shouldAnimate("foo", "foo", "auto")).toBe(false);
  });

  test("SSE-driven auto rename: title changed + source 'auto' → animate", () => {
    expect(shouldAnimate("foo", "bar", "auto")).toBe(true);
  });

  test("manual rename: title changed + source 'manual' → no animation", () => {
    expect(shouldAnimate("foo", "My Custom Title", "manual")).toBe(false);
  });

  test("missing source: title changed + undefined → no animation", () => {
    // The reducer defaults missing → "auto" so this is theoretical;
    // pinning behavior so a regression that drops the prop doesn't
    // silently animate everything.
    expect(shouldAnimate("foo", "bar", undefined)).toBe(false);
  });

  test("title cleared (auto → ''): animate even though new title is empty", () => {
    // Edge: the model might choose to clear the title. From the
    // SessionList's perspective, that IS a title change and came
    // from a tool call (auto source), so animate.
    expect(shouldAnimate("Old", "", "auto")).toBe(true);
  });
});