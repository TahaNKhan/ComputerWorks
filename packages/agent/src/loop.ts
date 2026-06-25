// packages/agent/src/loop.ts
// T2.3 — Agent loop state machine.
//
// Implements runTurn per DESIGN.MD §6.1. Loops while the provider emits
// tool_use blocks; executes each tool (after approver consent) and
// appends the tool_result back to history for the next iteration.
//
// Loop guards (§6.2):
//   - iteration cap (default 25) terminates with error event
//   - AbortSignal cancellation throws AbortError; partial message dropped
//   - Provider errors surface as AgentEvent.error; partial dropped
//   - Tool errors / rejections become tool_result with is_error: true;
//     the loop continues so the model can self-correct.

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderOverrides,
  ToolDefinition,
  ToolUseBlock,
} from "@computerworks/core";
import type { Approver } from "./approval.js";
import type { ToolRegistry } from "./registry.js";

// DESIGN.MD §6 places AgentEvent in the agent package (not core).
export type AgentEvent =
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | {
      type: "tool_result";
      call_id: string;
      result: unknown;
      is_error: boolean;
      approved: boolean;
      reason?: string;
    }
  | { type: "turn_done" }
  | { type: "error"; message: string };

export interface AgentRunOptions {
  provider: Provider;
  model: string;
  system: string;
  history: Message[];
  /** Optional registry. If omitted, tools is used directly. */
  registry?: ToolRegistry;
  /** Used when registry is not provided. */
  tools?: ToolDefinition[];
  approver: Approver;
  overrides?: ProviderOverrides;
  onEvent: (e: AgentEvent) => void;
  signal: AbortSignal;
  /** Default 25 (per DESIGN.MD §6.2). */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 25;

function emit(
  onEvent: (e: AgentEvent) => void,
  e: AgentEvent,
): void {
  try {
    onEvent(e);
  } catch {
    // Listener errors must not crash the loop.
  }
}

function appendAssistant(
  history: Message[],
  text: string,
  toolCalls: ToolUseBlock[],
): Message {
  const blocks: ContentBlock[] = [];
  if (text.length > 0) blocks.push({ type: "text", text });
  for (const call of toolCalls) blocks.push(call);
  const msg: Message = { role: "assistant", content: blocks };
  history.push(msg);
  return msg;
}

function appendToolResult(
  history: Message[],
  toolUseId: string,
  content: string,
  isError: boolean,
): void {
  history.push({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
  });
}

/**
 * Run one agent turn.
 *
 * Returns the final assistant Message. Throws AbortError if the
 * signal aborts. Emits AgentEvents via `onEvent` as the turn progresses.
 */
export async function runTurn(opts: AgentRunOptions): Promise<Message> {
  const {
    provider, model, system, history, approver, onEvent, signal,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = opts;

  if (signal.aborted) {
    throw new DOMException("runTurn: aborted before start", "AbortError");
  }

  const tools = opts.registry ? opts.registry.list() : (opts.tools ?? []);

  let iter = 0;
  let lastFinalMessage: Message | null = null;

  // Outer loop: each iteration = one provider chat call.
  while (true) {
    if (signal.aborted) {
      throw new DOMException("runTurn: aborted", "AbortError");
    }
    if (iter >= maxIterations) {
      emit(onEvent, {
        type: "error",
        message: `iteration cap reached (${maxIterations}); stopping turn`,
      });
      appendToolResult(
        history,
        "synthetic-cap",
        `iteration cap reached (${maxIterations})`,
        true,
      );
      lastFinalMessage = appendAssistant(history, "", []);
      break;
    }
    iter += 1;

    let textAccum = "";
    let toolCall: ToolUseBlock | null = null;
    let providerError: string | null = null;

    try {
      for await (const ev of provider.chat({
        model,
        system,
        messages: history,
        tools,
        ...(opts.overrides ? { overrides: opts.overrides } : {}),
        signal,
      })) {
        if (signal.aborted) {
          throw new DOMException("runTurn: aborted mid-stream", "AbortError");
        }
        switch (ev.type) {
          case "token":
            textAccum += ev.delta;
            emit(onEvent, { type: "token", delta: ev.delta });
            break;
          case "tool_call":
            toolCall = ev.call;
            emit(onEvent, { type: "tool_call", call: ev.call });
            break;
          case "error":
            providerError = ev.message;
            break;
          case "message_start":
          case "message_done":
          case "tool_result":
          case "done":
            break;
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      providerError = err instanceof Error ? err.message : String(err);
    }

    if (providerError) {
      emit(onEvent, { type: "error", message: providerError });
      lastFinalMessage = { role: "assistant", content: textAccum };
      break;
    }

    if (!toolCall) {
      lastFinalMessage = appendAssistant(history, textAccum, []);
      break;
    }

    appendAssistant(history, textAccum, [toolCall]);

    let approved = true;
    let decisionContent = "";
    let decisionIsError = false;

    const tool = tools.find((t) => t.name === toolCall!.name);
    if (tool?.requiresApproval) {
      try {
        const decision = await approver.request(
          {
            call: toolCall,
            description: `${toolCall.name}`,
            ...(typeof toolCall.input === "object" && toolCall.input !== null
              ? { diff: JSON.stringify(toolCall.input, null, 2) }
              : {}),
          },
          signal,
        );
        switch (decision.kind) {
          case "approve_once":
            approved = true;
            break;
          case "approve_for_session":
            approved = true;
            break;
          case "reject":
            approved = false;
            decisionContent = `rejected: ${decision.reason}`;
            decisionIsError = true;
            break;
          case "edit":
            approved = true;
            decisionContent = "edit-and-approve applied";
            break;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        approved = false;
        decisionContent = err instanceof Error ? err.message : String(err);
        decisionIsError = true;
      }
    }

    if (approved && opts.registry) {
      try {
        const result = await opts.registry.execute(
          toolCall.name,
          toolCall.input,
          {
            cwd: process.cwd(),
            signal,
            env: process.env,
            sessionId: "agent-loop",
          },
        );
        decisionContent = typeof result === "string" ? result : JSON.stringify(result);
        decisionIsError = false;
      } catch (err) {
        decisionContent = err instanceof Error ? err.message : String(err);
        decisionIsError = true;
      }
    } else if (approved && !opts.registry) {
      decisionContent = "(no tool registry configured)";
      decisionIsError = true;
    }

    emit(onEvent, {
      type: "tool_result",
      call_id: toolCall.id,
      result: decisionContent,
      is_error: decisionIsError,
      approved,
      ...(decisionIsError ? { reason: decisionContent } : {}),
    });

    appendToolResult(history, toolCall.id, decisionContent, decisionIsError);
  }

  emit(onEvent, { type: "turn_done" });
  return lastFinalMessage ?? { role: "assistant", content: "" };
}
