// packages/ui/src/api/sse-parse.ts
// Internal helpers used by the store's `stream.ts` consumer. Extracted
// so they can be unit-tested without spinning up a server.
//
// In v1.14 there's no long-lived `SSEClient` — each `POST /messages`
// returns its own SSE response and `stream.ts` parses the bytes
// through these primitives.

import type { ServerEvent } from "./types.js";

export interface ParsedFrames {
  events: string[];
  rest: string;
}

/** Split `buffer` into complete SSE frames (`event:` + `data:` blocks
 *  terminated by a blank line). Anything after the last blank line is
 *  returned in `rest` and appended to on the next read. */
export function drainFrames(buffer: string): ParsedFrames {
  const events: string[] = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf("\n\n", start);
    if (idx === -1) break;
    const chunk = buffer.slice(start, idx);
    if (!isHeartbeatFrame(chunk)) events.push(chunk);
    start = idx + 2;
  }
  return { events, rest: buffer.slice(start) };
}

export function isHeartbeatFrame(chunk: string): boolean {
  // Heartbeats start with `:` (a comment line) and have no `event:` or `data:`.
  const trimmed = chunk.replace(/\s+/g, "");
  if (trimmed === "") return true;
  if (chunk.startsWith(":")) return true;
  return false;
}

/** Parse one SSE frame (`event: <type>\ndata: <json>`) into a
 *  `ServerEvent`. Returns `null` for unrecognized events. */
export function parseSSEFrame(frame: string): ServerEvent | null {
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(":")) continue; // comment
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // Per SSE spec, a single leading space after the colon is stripped.
    const rawValue = line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!eventType) return null;
  const dataStr = dataLines.join("\n");
  let body: Record<string, unknown> = {};
  if (dataStr !== "") {
    try {
      const parsed = JSON.parse(dataStr) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return reconstructServerEvent(eventType, body);
}

function reconstructServerEvent(
  type: string,
  body: Record<string, unknown>,
): ServerEvent | null {
  switch (type) {
    case "message_start":
      return { type: "message_start" };
    case "token":
      if (typeof body.delta === "string") return { type: "token", delta: body.delta };
      return null;
    case "message_done":
      return {
        type: "message_done",
        usage: (body.usage as { input: number; output: number }) ?? { input: 0, output: 0 },
      };
    case "tool_call": {
      const call = body.call;
      if (call && typeof call === "object" && "id" in call && "name" in call) {
        return { type: "tool_call", call: call as Extract<ServerEvent, { type: "tool_call" }>["call"] };
      }
      return null;
    }
    case "tool_result": {
      const call_id = typeof body.call_id === "string" ? body.call_id : "";
      const tool = typeof body.tool === "string" ? body.tool : "<unknown>";
      const approved = body.approved === true;
      const is_error = body.is_error === true;
      const result = "result" in body ? body.result : undefined;
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      const out: Extract<ServerEvent, { type: "tool_result" }> = {
        type: "tool_result",
        call_id,
        tool,
        approved,
        is_error,
        ...(result !== undefined ? { result } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
      return out;
    }
    case "approval_required": {
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      const tool = body.tool;
      const description = typeof body.description === "string" ? body.description : "";
      const diff = typeof body.diff === "string" ? body.diff : undefined;
      if (!requestId || !tool) return null;
      const out: Extract<ServerEvent, { type: "approval_required" }> = {
        type: "approval_required",
        requestId,
        tool: tool as Extract<ServerEvent, { type: "approval_required" }>["tool"],
        description,
        ...(diff !== undefined ? { diff } : {}),
      };
      return out;
    }
    case "tool_validation_error": {
      const call_id = typeof body.call_id === "string" ? body.call_id : "";
      const tool = typeof body.tool === "string" ? body.tool : "<unknown>";
      const message = typeof body.message === "string" ? body.message : "";
      if (!call_id || !message) return null;
      const out: Extract<ServerEvent, { type: "tool_validation_error" }> = {
        type: "tool_validation_error",
        call_id,
        tool,
        message,
      };
      return out;
    }
    case "session_renamed": {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const title = typeof body.title === "string" ? body.title : "";
      if (!sessionId || !title) return null;
      return { type: "session_renamed", sessionId, title };
    }
    case "error":
      if (typeof body.message === "string") return { type: "error", message: body.message };
      return null;
    case "done":
      return { type: "done" };
    case "session_renamed": {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const title = typeof body.title === "string" ? body.title : "";
      if (!sessionId) return null;
      return { type: "session_renamed", sessionId, title };
    }
    default:
      return null;
  }
}