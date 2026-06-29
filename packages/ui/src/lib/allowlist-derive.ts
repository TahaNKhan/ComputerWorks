// packages/ui/src/lib/allowlist-derive.ts
// T18 — Helpers for deriving a session-allowlist pattern from a
// pending tool call. The UI uses these to render a "Always allow
// `<token>` …" button on run_shell approvals.
//
// The matching logic on the server side lives in
// `packages/server/src/interactive-approver.ts` (`firstToken` +
// `pickFirstStringField` + `matchesParsed`). The wire format is
// `tool:<name>` and `tool:<name> <prefix>`; no regex, no escape.

/**
 * First whitespace-delimited token of `s`, or `null` for empty /
 * whitespace-only input. Mirrors the server's `firstToken`.
 */
export function firstToken(s: string): string | null {
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c === 0x20 /* space */ || c === 0x09 /* tab */) {
      return trimmed.slice(0, i);
    }
  }
  return trimmed;
}

/**
 * True iff `tok` looks like a plain command name: starts with a
 * letter, then letters / digits / dot / underscore / dash. The
 * check rejects shell metacharacters, paths, and empty input.
 * Mirrors the safety check described in design.md "First-token
 * derivation (UI)".
 */
export function isSafeToken(tok: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(tok);
}

/** Shape that `deriveRunShellToken` accepts as input — the parts of
 *  an approval part that matter for derivation. Decoupled from
 *  `MessagePart` so the helper stays a pure function and is easy
 *  to unit-test without React. */
export interface RunShellApprovalLike {
  name: string;
  input: unknown;
}

/**
 * Compute the derived "Always allow `<token>` …" affordance for a
 * pending approval, or `null` when none should be shown. Only
 * `run_shell` with a string `cmd` whose first token passes
 * `isSafeToken` qualifies. The returned object carries the token
 * (no further shape transformation here — the caller decides the
 * UI label and the wire-format pattern string).
 */
export function deriveRunShellToken(
  approval: RunShellApprovalLike,
): { token: string } | null {
  if (approval.name !== "run_shell") return null;
  if (!approval.input || typeof approval.input !== "object") return null;
  const cmd = (approval.input as Record<string, unknown>).cmd;
  if (typeof cmd !== "string") return null;
  const tok = firstToken(cmd);
  if (tok === null) return null;
  if (!isSafeToken(tok)) return null;
  return { token: tok };
}