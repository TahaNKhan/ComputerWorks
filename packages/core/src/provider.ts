// packages/core/src/provider.ts
// T1.2 — Provider interface. Anthropic implementation lives in
// providers/anthropic.ts; future providers (OpenAI-compatible, Ollama,
// Gemini) plug in here without changing the agent loop.
//
// DESIGN.MD §5 is the spec.

import type { Message, StreamEvent, ToolDefinition } from "./types.js";

/**
 * Per-request / per-config knobs. Merged in precedence order:
 * defaults < provider config < per-request overrides.
 */
export interface ProviderOverrides {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  betaHeaders?: string[];
  extraBody?: Record<string, unknown>;
}

export interface ProviderCapabilities {
  toolUse: boolean;
  promptCaching: boolean;
  vision: boolean;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolDefinition[];
  overrides?: ProviderOverrides;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}
