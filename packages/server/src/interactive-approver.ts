// packages/server/src/interactive-approver.ts
// T14.1 — Interactive approver, refactored for per-message SSE.
//
// v1.0–v1.13: the approver took an `SSEManager` and routed events
// through a global broadcast queue; an `ApproverRegistry` keyed on
// sessionId allowed the /approve route to find the right approver.
//
// v1.14: there is no broadcast queue. Each `POST /messages` handler
// owns a per-response `SSEWriter` (see sse-writer.ts). The approver
// takes a `writer` instead of an SSEManager and emits its events
// directly to the response that triggered the agent run. The
// `(requestId → resolver)` map is owned by the approver instance,
// which lives for exactly one turn; the messages route stores the
// approver on the `SessionRuntime` so the /approve route can find it.
//
// T17.2 — `approval_required` and `tool_result` move off the
// per-request `SSEWriter` and onto the central SSE (via `SyncHub`).
// The leader sees them on the central SSE — same end result, no
// duplication — and the leader's per-message SSE is reserved for
// live per-turn events only.
//
// T18 — Pattern-based per-session approval. The session allowlist
// is now a list of *patterns* (not just bare tool names):
//   - "tool:<name>"           matches any call to <name>
//   - "tool:<name> <prefix>"  matches calls to <name> whose first
//                              whitespace-separated token equals
//                              <prefix> exactly
// Patterns are parsed eagerly at construction time; a malformed
// pattern throws. The legacy "bare tool name" format is gone — we
// only accept "tool:..." forms, so we don't have two ways to spell
// the same thing.

import { randomUUID } from "node:crypto";
import type {
  Approver,
  ApprovalDecision,
  ApprovalRequest,
} from "@computerworks/agent";
import type { SSEWriter } from "./sse-writer.js";
import type { SyncHub } from "./sync-hub.js";
import type { ServerEvent } from "./sse.js";

export interface InteractiveApproverOptions {
  /** Override the default 5-minute timeout. */
  timeoutMs?: number;
  /** T18 — called when the user picks "approve for session". The
   *  callback receives the raw pattern string. The session is
   *  responsible for persisting the new pattern to meta.json; the
   *  approver just notifies. Errors thrown from the callback are
   *  swallowed (best-effort) so the in-flight tool call still
   *  resolves with approve_once semantics. */
  onAllowlistExtended?: (pattern: string) => void;
}

// ─── Pattern parsing (Phase 18) ───────────────────────────────────────────

/**
 * A parsed session-allowlist pattern.
 *
 * Two shapes:
 *   - tool name only: `{ kind: "tool"; name }`
 *   - tool + first-token prefix: `{ kind: "tool_prefix"; name; prefix }`
 *
 * The string form (what the API stores on disk in meta.allowlist) is
 * `formatPattern(parsed)`; `parsePattern` is its inverse.
 */
export type ParsedPattern =
  | { kind: "tool"; name: string }
  | { kind: "tool_prefix"; name: string; prefix: string };

/**
 * Parse a session-allowlist pattern. Eager: throws on malformed
 * input rather than returning a nullable match.
 *
 * Accepted shapes:
 *   - "tool:<name>"             → { kind: "tool", name }
 *   - "tool:<name> <prefix>"    → { kind: "tool_prefix", name, prefix }
 *
 * Rejected:
 *   - empty string
 *   - missing "tool:" prefix
 *   - empty tool name after "tool:"
 *   - whitespace inside the tool name
 *   - empty prefix after the single whitespace
 *   - more than one whitespace-separated token after the tool name
 *   - embedded newlines or tabs (single ASCII space only)
 */
export function parsePattern(input: string): ParsedPattern {
  if (input.length === 0) throw new Error("pattern is empty");
  if (input.includes("\n") || input.includes("\t")) {
    throw new Error("pattern may not contain newlines or tabs");
  }
  const PREFIX = "tool:";
  if (!input.startsWith(PREFIX)) {
    throw new Error(`pattern must start with "tool:"; got: ${JSON.stringify(input)}`);
  }
  const rest = input.slice(PREFIX.length);
  if (rest.length === 0) throw new Error("pattern is missing tool name after tool:");
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx === -1) {
    if (/\s/.test(rest)) throw new Error("invalid tool name");
    return { kind: "tool", name: rest };
  }
  const name = rest.slice(0, spaceIdx);
  const tail = rest.slice(spaceIdx + 1);
  if (name.length === 0 || /\s/.test(name)) throw new Error("invalid tool name");
  if (tail.length === 0 || /\s/.test(tail)) throw new Error("invalid prefix");
  return { kind: "tool_prefix", name, prefix: tail };
}

/** Inverse of `parsePattern` for happy paths. */
export function formatPattern(p: ParsedPattern): string {
  switch (p.kind) {
    case "tool":
      return `tool:${p.name}`;
    case "tool_prefix":
      return `tool:${p.name} ${p.prefix}`;
  }
}

/**
 * First whitespace-delimited token of `s`, or null if the string is
 * empty / whitespace-only. Used by the matching logic to compare a
 * pattern's `prefix` against the command name.
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

/** Field name we look at first when matching tool_prefix patterns.
 *  Most "command-y" tools have a string `cmd` field (run_shell); we
 *  fall back to `path` (file tools), then `name` (memory tools),
 *  then any first string-valued key in the input. */
const TOOL_INPUT_STRING_FIELDS = ["cmd", "path", "name"] as const;

function pickFirstStringField(input: Record<string, unknown>): string | null {
  for (const k of TOOL_INPUT_STRING_FIELDS) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string") return v;
  }
  return null;
}

function matchesParsed(
  p: ParsedPattern,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (p.kind === "tool") return p.name === toolName;
  if (p.name !== toolName) return false;
  const cmd = pickFirstStringField(input);
  if (cmd === null) return false;
  const tok = firstToken(cmd);
  if (tok === null) return false;
  return tok === p.prefix;
}

/** Return true iff `(toolName, input)` is covered by any pattern in
 *  `allowlist`. Malformed patterns are silently skipped — the
 *  caller's invariant is that `meta.allowlist` only contains parsed
 *  strings, so a malformed entry means somebody wrote garbage to
 *  meta.json directly and we should ignore it instead of crashing
 *  every approval. */
export function isCoveredByAllowlist(
  allowlist: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  for (const raw of allowlist) {
    let parsed: ParsedPattern;
    try {
      parsed = parsePattern(raw);
    } catch {
      continue;
    }
    if (matchesParsed(parsed, toolName, input)) return true;
  }
  return false;
}

// ─── InteractiveApprover ──────────────────────────────────────────────────

export class InteractiveApprover implements Approver {
  public readonly sessionId: string;
  /** T17.3 — the originating tab's per-message SSE writer. We write
   *  approval_required + tool_result here in addition to the SyncHub
   *  so the leader's tool calls work even if the SharedWorker
   *  fails to connect. The reducer's `removeToolCall` is idempotent,
   *  so the leader receiving the event twice is harmless. */
  private readonly leaderWriter: SSEWriter;
  private readonly syncHub: SyncHub;
  /** T18 — pre-parsed allowlist patterns. Eagerly parsed at
   *  construction so a malformed pattern is caught at request
   *  entry, not silently dropped per-call. */
  private readonly parsedAllowlist: readonly ParsedPattern[];
  private readonly globalShellAllowlist: readonly RegExp[];
  private readonly timeoutMs: number;
  /** T18 — called whenever `approve_for_session` lands. The session
   *  is responsible for persisting the new pattern to meta.json
   *  (single source of truth on disk); the approver just notifies.
   *  The callback receives the raw pattern string. */
  public readonly onAllowlistExtended?: (pattern: string) => void;
  /** In-flight requestIds → resolver. Keyed locally so the lookup is
   *  O(1) and the approver is self-contained (no global registry). */
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();

  constructor(
    leaderWriter: SSEWriter,
    syncHub: SyncHub,
    sessionId: string,
    sessionAllowlist: readonly string[],
    globalShellAllowlist: readonly RegExp[],
    opts: InteractiveApproverOptions = {},
  ) {
    this.leaderWriter = leaderWriter;
    this.syncHub = syncHub;
    this.sessionId = sessionId;
    // Eagerly parse; throw on a malformed pattern. The messages
    // route is responsible for validating allowlist strings before
    // persisting them; this is a defensive secondary check.
    this.parsedAllowlist = sessionAllowlist.map((raw) => parsePattern(raw));
    this.globalShellAllowlist = globalShellAllowlist;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    if (opts.onAllowlistExtended) {
      this.onAllowlistExtended = opts.onAllowlistExtended;
    }
  }

  /** Belt-and-suspenders broadcast: write to the leader's
   *  per-message stream AND the central SSE. The leader gets the
   *  event once (via the per-message stream). Passive viewers via
   *  the central SSE. */
  private broadcast(ev: ServerEvent): void {
    try {
      this.leaderWriter.write(ev);
    } catch {
      // leader disconnected mid-event; safe to ignore — the
      // SyncHub broadcast below still reaches passive viewers.
    }
    this.syncHub.broadcast(ev);
  }

  /** Called by the agent loop when a tool needs approval. */
  async request(
    req: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const input = (req.call.input ?? {}) as Record<string, unknown>;

    // 1. Check global shell allowlist (still logged via tool_result).
    if (req.call.name === "run_shell" && this.matchesGlobalShell(input)) {
      this.broadcast({
        type: "tool_result",
        call_id: req.call.id,
        approved: true,
        result: undefined,
        is_error: false,
      });
      return { kind: "approve_once" };
    }

    // 2. Check session allowlist (T18: parsed patterns).
    if (this.matchesSessionAllowlist(req.call.name, input)) {
      this.broadcast({
        type: "tool_result",
        call_id: req.call.id,
        approved: true,
        result: undefined,
        is_error: false,
      });
      return { kind: "approve_once" };
    }

    // 3. Otherwise, prompt the user via both channels.
    const requestId = randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      // Timeout handler.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ kind: "reject", reason: "aborted" });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      if (this.timeoutMs > 0) {
        timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(requestId);
          this.broadcast({
            type: "tool_result",
            call_id: req.call.id,
            approved: false,
            result: undefined,
            is_error: true,
            reason: "approval timeout",
          });
          resolve({ kind: "reject", reason: "approval timeout" });
        }, this.timeoutMs);
      }

      this.pending.set(requestId, (decision) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(requestId);

        // T18 — if the user picked "approve for session", notify
        // the session so the new pattern lands in meta.allowlist
        // and is visible to the *next* turn's approver instance.
        // We do this before emitting tool_result so the persistence
        // side-effect is logically "decided + extended".
        if (decision.kind === "approve_for_session") {
          try {
            this.onAllowlistExtended?.(decision.pattern);
          } catch {
            // The callback is best-effort. A persistence failure
            // here shouldn't crash the in-flight tool call — the
            // agent still runs the tool with approve_once semantics.
            // The next turn will see no allowlist extension and the
            // user will be prompted again.
          }
        }

        // Emit a tool_result so client UIs can show the decision.
        this.broadcast({
          type: "tool_result",
          call_id: req.call.id,
          approved: decision.kind !== "reject",
          result: undefined,
          is_error: decision.kind === "reject",
          reason: decision.kind === "reject" ? decision.reason : undefined,
        });
        resolve(decision);
      });

      const approvalEvent: ServerEvent = {
        type: "approval_required",
        requestId,
        tool: req.call,
        description: req.description,
        ...(req.diff !== undefined ? { diff: req.diff } : {}),
      };
      this.broadcast(approvalEvent);
    });
  }

  /** Resolve a pending approval by id. Returns true if a resolver
   *  fired; false if no such request is pending on this approver. */
  resolveById(requestId: string, decision: ApprovalDecision): boolean {
    const r = this.pending.get(requestId);
    if (!r) return false;
    r(decision);
    return true;
  }

  /** Test helper. */
  pendingCount(): number {
    return this.pending.size;
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private matchesGlobalShell(input: unknown): boolean {
    if (!input || typeof input !== "object") return false;
    const cmd = (input as { cmd?: unknown }).cmd;
    if (typeof cmd !== "string") return false;
    return this.globalShellAllowlist.some((re) => re.test(cmd));
  }

  private matchesSessionAllowlist(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (this.parsedAllowlist.length === 0) return false;
    return this.parsedAllowlist.some((p) => matchesParsed(p, toolName, input));
  }
}
