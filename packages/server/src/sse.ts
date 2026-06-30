// packages/server/src/sse.ts
// T14.1 — Pure SSE framing utilities.
//
// Before v1.14, this file also exported `SSEManager` — a subscriber
// map that broadcast events to many long-lived connections. v1.14
// replaces that with per-response writers (see `sse-writer.ts`); each
// `POST /messages` opens its own response stream and writes events
// directly to it. Nothing in the codebase needs broadcast-style
// fanout anymore, so the manager is gone.
//
// This file now contains:
//   - `ServerEvent` — the wire event union shared with the UI.
//   - `formatSSE(event)` — pure function, frames one event as the
//     SSE wire bytes the UI parses.

import type { ToolUseBlock } from "@computerworks/core";

// T17.2 — Wire shape for a persisted message. Mirrors the agent
// loop's `Message` shape so the UI can re-render from `messages.jsonl`
// without conversion. The role union includes "system" (the agent
// loop writes one into history at runtime).
export interface ServerMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: unknown;
}

/** Wire event types sent from server → client over SSE. The set of
 *  events is unchanged from Phase 5; only the transport is new
 *  (per-message SSE instead of a persistent GET /stream).
 *
 *  T17.2 — adds `message_appended` for cross-tab sync. That event
 *  is central-SSE-only (not per-message SSE); the per-message SSE
 *  keeps streaming live per-turn events to the leader. */
export type ServerEvent =
  | { type: "message_start" }
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | {
      type: "approval_required";
      requestId: string;
      tool: ToolUseBlock;
      description: string;
      diff?: string;
    }
  | {
      type: "tool_result";
      call_id: string;
      approved: boolean;
      result?: unknown;
      is_error: boolean;
      reason?: string;
    }
  | { type: "message_done"; usage: { input: number; output: number } }
  | {
      type: "session_renamed";
      sessionId: string;
      title: string;
      /** T19.2 — provenance of the new title. "auto" for the
       *  LLM-driven rename_session tool; "manual" for a user PATCH.
       *  Optional + forward-compatible: clients that ignore the
       *  missing field still work (treat as "auto"). */
      titleSource?: "auto" | "manual";
    }
  | { type: "error"; message: string }
  | { type: "done" }
  | {
      // T17.2 — central SSE only. Emitted after every successful
      // appendMessage (user + assistant). Carries the originator
      // tab UUID so the originating tab can dedupe its own optimistic
      // append; idempotent on `id` for re-connect safety.
      type: "message_appended";
      sessionId: string;
      message: ServerMessage;
      originator: string;
      ts: string;
    };

// ─── Framing ──────────────────────────────────────────────────────────────

/**
 * Encode one `ServerEvent` as an SSE frame, ready to be written to
 * the response stream. Returns a `Uint8Array` of UTF-8 bytes.
 *
 * Frame shape:
 *
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * `done` carries no body; we still emit an empty `data:` line so the
 * client's parser can rely on the trailing blank line.
 */
export function formatSSE(event: ServerEvent): Uint8Array {
  const lines: string[] = [];
  lines.push(`event: ${event.type}`);
  const { type: _type, ...rest } = event;
  const body = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
  // SSE forbids newlines inside `data:`; if the JSON has any, we'd
  // have to split it. None of our event types contain raw newlines
  // (strings are JSON-escaped) so a single line is safe.
  lines.push(`data: ${body}`);
  lines.push(""); // blank line to terminate the frame
  lines.push(""); // double newline for clarity (not strictly required)
  return new TextEncoder().encode(lines.join("\n"));
}