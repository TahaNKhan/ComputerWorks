// packages/core/src/types.ts
// T1.1 — Core types. The single source of truth for the wire shapes that
// flow from core through agent, server, and UI. Every other package
// imports from here.
//
// DESIGN.MD §4 is the spec.

import type { ZodType } from "zod";

// ─── Roles and content blocks ─────────────────────────────────────────────

export type Role = "user" | "assistant" | "system" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[] | string;
}

// ─── Tool protocol ───────────────────────────────────────────────────────

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Sanitized environment — strip secrets before passing to spawn. */
  env: NodeJS.ProcessEnv;
  sessionId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  requiresApproval: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

// ─── Streaming events from a Provider ─────────────────────────────────────

export type StreamEvent =
  | { type: "message_start" }
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | {
      type: "tool_result";
      call_id: string;
      result: unknown;
      is_error: boolean;
    }
  | { type: "message_done"; usage: { input: number; output: number } }
  | { type: "error"; message: string }
  | { type: "done" };
