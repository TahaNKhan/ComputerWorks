// packages/core/src/providers/anthropic.ts
// T1.3 — Anthropic provider implementation.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest, Provider, ProviderCapabilities, ProviderOverrides,
} from "../provider.js";
import type { Message, StreamEvent, ToolDefinition } from "../types.js";

export interface AnthropicProviderConfig {
  defaultModel?: string;
  baseUrl?: string;
  apiKey?: string;
  betaHeaders?: string[];
  extraBody?: Record<string, unknown>;
}

type RawEvent = { type: string; [k: string]: unknown };

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v;
}

function readApiKey(): string {
  const v = readEnv("MINIMAX_TOKEN") ?? readEnv("ANTHROPIC_API_KEY");
  if (!v) {
    throw new Error("createAnthropicProvider: MINIMAX_TOKEN env var is required.");
  }
  return v;
}

function readBaseUrl(): string {
  return (
    readEnv("MINIMAX_BASE_URL") ?? readEnv("ANTHROPIC_BASE_URL") ??
    "https://api.minimax.io/anthropic"
  );
}

function readDefaultModel(): string {
  return readEnv("MINIMAX_DEFAULT_MODEL") ?? "MiniMax-M3";
}

interface ResolvedOverrides {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  betaHeaders: string[];
  extraBody: Record<string, unknown>;
}

function mergeOverrides(
  defaults: AnthropicProviderConfig | undefined,
  perRequest: ProviderOverrides | undefined,
): ResolvedOverrides {
  const o: ResolvedOverrides = {
    baseUrl: perRequest?.baseUrl ?? defaults?.baseUrl ?? readBaseUrl(),
    apiKey: perRequest?.apiKey ?? defaults?.apiKey ?? readApiKey(),
    headers: { ...(defaults?.extraBody ?? {}), ...(perRequest?.headers ?? {}) } as Record<string, string>,
    maxTokens: perRequest?.maxTokens,
    temperature: perRequest?.temperature,
    topP: perRequest?.topP,
    topK: perRequest?.topK,
    stopSequences: perRequest?.stopSequences,
    betaHeaders: [...(defaults?.betaHeaders ?? []), ...(perRequest?.betaHeaders ?? [])],
    extraBody: deepMerge(
      (defaults?.extraBody ?? {}) as Record<string, unknown>,
      (perRequest?.extraBody ?? {}) as Record<string, unknown>,
    ),
  };
  return o;
}

export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) &&
        out[k] !== null && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else { out[k] = v; }
  }
  return out;
}

function joinBetaHeaders(headers: string[]): string | undefined {
  if (headers.length === 0) return undefined;
  return headers.join(", ");
}

const PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";

function injectCacheBreakpoints(
  system: string | undefined,
  messages: Message[],
): { system: unknown; messages: unknown[] } {
  const sysBlock = system !== undefined
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined;
  const out: unknown[] = [];
  let lastUserIdx = -1, lastToolResultIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") lastUserIdx = i;
    if (m.role === "tool") lastToolResultIdx = i;
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(convertMessage(m, i === lastUserIdx, i === lastToolResultIdx));
  }
  return { system: sysBlock, messages: out };
}

function convertMessage(
  m: Message, markLastUser: boolean, markLastToolResult: boolean,
): unknown {
  if (typeof m.content === "string") {
    const block: Record<string, unknown> = { type: "text", text: m.content };
    if (markLastUser) block["cache_control"] = { type: "ephemeral" };
    return { role: m.role, content: [block] };
  }
  const blocks: unknown[] = [];
  for (const b of m.content) {
    if (b.type === "text") {
      const tb: Record<string, unknown> = { type: "text", text: b.text };
      if (markLastUser) tb["cache_control"] = { type: "ephemeral" };
      blocks.push(tb);
    } else if (b.type === "tool_use") {
      blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    } else if (b.type === "tool_result") {
      const tb: Record<string, unknown> = {
        type: "tool_result", tool_use_id: b.tool_use_id,
        content: b.content, is_error: b.is_error ?? false,
      };
      if (markLastToolResult) tb["cache_control"] = { type: "ephemeral" };
      blocks.push(tb);
    }
  }
  const role = m.role === "tool" ? "user" : m.role;
  return { role, content: blocks };
}

function convertTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name, description: t.description,
    input_schema: zodToJsonSchema(t.inputSchema),
  }));
}

export function zodToJsonSchema(schema: unknown): unknown {
  const def = (schema as { _def?: { typeName?: string; [k: string]: unknown } })._def;
  if (!def) return {};
  const t = def.typeName as string;
  switch (t) {
    case "ZodString": return { type: "string" };
    case "ZodNumber": return { type: "number" };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodLiteral": { const v = (def as { value: unknown }).value; return { type: typeof v, enum: [v] }; }
    case "ZodEnum": { const values = (def as { values: readonly unknown[] }).values; return { type: "string", enum: [...values] }; }
    case "ZodArray": { const inner = (def as { type: unknown }).type; return { type: "array", items: zodToJsonSchema(inner) }; }
    case "ZodOptional": { const inner = (def as { innerType: unknown }).innerType; return zodToJsonSchema(inner); }
    case "ZodObject": {
      const shape = (def as { shape: () => Record<string, unknown> }).shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v);
        const innerDef = (v as { _def?: { typeName?: string } })._def;
        if (innerDef?.typeName !== "ZodOptional") required.push(k);
      }
      return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
    }
    case "ZodRecord": { const valueType = (def as { valueType: unknown }).valueType; return { type: "object", additionalProperties: zodToJsonSchema(valueType) }; }
    case "ZodUnion": { const options = (def as { options: unknown[] }).options; return { anyOf: options.map((o) => zodToJsonSchema(o)) }; }
    default: return {};
  }
}

function translateEvent(
  raw: RawEvent,
  out: (e: StreamEvent) => void,
  sink: {
    pendingUsage?: { input: number; output: number };
    /**
     * In-progress tool_use blocks, keyed by the Anthropic `index` of
     * the content block. The Anthropic streaming protocol builds up a
     * tool_use input incrementally:
     *
     *   content_block_start  { type: "tool_use", id, name, input: {} }
     *   content_block_delta  { delta: { type: "input_json_delta",
     *                                 partial_json: "{\"command\":" } }
     *   content_block_delta  { delta: { type: "input_json_delta",
     *                                 partial_json: "\"ls -la\"}" } }
     *   content_block_stop   (no payload)
     *
     * We can't emit the tool_call event at `content_block_start` (the
     * input is `{}` at that point) and we don't want to ship a stream
     * of partial events. So we accumulate the JSON here and emit a
     * single complete `tool_call` on `content_block_stop`.
     */
    inProgressToolUses?: Map<number, { id: string; name: string; inputJson: string }>;
  },
): void {
  switch (raw.type) {
    case "message_start": out({ type: "message_start" }); return;
    case "content_block_start": {
      const block = (raw.content_block ?? {}) as { type?: string; id?: string; name?: string };
      if (block.type === "tool_use") {
        if (!sink.inProgressToolUses) sink.inProgressToolUses = new Map();
        const index = typeof raw.index === "number" ? raw.index : 0;
        sink.inProgressToolUses.set(index, {
          id: block.id ?? "",
          name: block.name ?? "",
          inputJson: "",
        });
      }
      return;
    }
    case "content_block_delta": {
      const delta = (raw.delta ?? {}) as { type?: string; text?: string; partial_json?: string };
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        out({ type: "token", delta: delta.text });
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = typeof raw.index === "number" ? raw.index : 0;
        const inProgress = sink.inProgressToolUses?.get(index);
        if (inProgress) inProgress.inputJson += delta.partial_json;
      }
      return;
    }
    case "content_block_stop": {
      const index = typeof raw.index === "number" ? raw.index : 0;
      const inProgress = sink.inProgressToolUses?.get(index);
      if (inProgress) {
        let input: unknown = {};
        if (inProgress.inputJson.length > 0) {
          try {
            input = JSON.parse(inProgress.inputJson);
          } catch {
            // Malformed input JSON — pass the raw string through so
            // the registry's zod validation produces a useful error
            // rather than dropping the call on the floor.
            input = inProgress.inputJson;
          }
        }
        out({
          type: "tool_call",
          call: {
            type: "tool_use",
            id: inProgress.id,
            name: inProgress.name,
            input,
          },
        });
        sink.inProgressToolUses!.delete(index);
      }
      return;
    }
    case "message_delta": {
      const usage = (raw.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      sink.pendingUsage = { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };
      return;
    }
    case "message_stop": {
      const usage = sink.pendingUsage ?? { input: 0, output: 0 };
      out({ type: "message_done", usage });
      sink.pendingUsage = undefined;
      return;
    }
    case "error": {
      const message = (raw.error as { message?: string } | undefined)?.message ?? "unknown error";
      out({ type: "error", message });
      return;
    }
    default: return;
  }
}

function withScrubbedAnthropicEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

export interface AnthropicProvider extends Provider {
  resolvedConfig(): { baseUrl: string; defaultModel: string; betaHeaders: string[] };
  /**
   * One-shot text inference. Sends a single user message and returns the
   * full text response in one Promise. Internally streams the response
   * and concatenates tokens. Throws on provider error. Returns "" if
   * the response contains no text (e.g. only tool_use blocks).
   *
   * Use this when you want a single blocking call ("sync" from the
   * caller's POV) — summarization, classification, intent detection,
   * etc. For multi-turn, tool-calling, or token-level streaming, use
   * `chat()` instead.
   *
   * The provider is stateless across calls, so `inferText` is safe to
   * invoke concurrently from multiple callers on the same instance.
   */
  inferText(prompt: string, options?: InferTextOptions): Promise<string>;
}

export interface InferTextOptions {
  /** Override the system prompt (default: no system prompt). */
  system?: string;
  /** Override the model (default: provider's `defaultModel`). */
  model?: string;
  /** Max tokens to generate (default: 1024, matches `chat()`). */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig = {},
): AnthropicProvider {
  const KEY = "apiKey";
  const URL_KEY = "baseURL";
  const BETA_KEY = "defaultHeaders";

  const defaults: AnthropicProviderConfig = {
    defaultModel: config.defaultModel ?? readDefaultModel(),
    baseUrl: config.baseUrl ?? readBaseUrl(),
    apiKey: config.apiKey ?? readApiKey(),
    betaHeaders: config.betaHeaders ?? [],
    extraBody: config.extraBody ?? {},
  };

  const capabilities: ProviderCapabilities = {
    toolUse: true,
    promptCaching: (defaults.betaHeaders ?? []).includes(PROMPT_CACHING_BETA),
    vision: true,
  };

  async function* run(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const ov = mergeOverrides(defaults, req.overrides);
    const model = req.model || defaults.defaultModel!;
    const cachingEnabled = ov.betaHeaders.includes(PROMPT_CACHING_BETA);

    const { system, messages } = cachingEnabled
      ? injectCacheBreakpoints(req.system, req.messages)
      : { system: req.system, messages: req.messages.map((m) => convertMessage(m, false, false)) };

    const tools = convertTools(req.tools);
    const betaHeader = joinBetaHeaders(ov.betaHeaders);

    const clientOpts: Record<string, unknown> = {};
    // Prefer `authToken` (sets Authorization: Bearer ...) since
    // MiniMax's Anthropic-compatible endpoint expects Bearer auth,
    // not the x-api-key header that `apiKey` triggers.
    clientOpts["authToken"] = ov.apiKey;
    clientOpts[URL_KEY] = ov.baseUrl;
    if (betaHeader) clientOpts[BETA_KEY] = { "anthropic-beta": betaHeader };

    const client = withScrubbedAnthropicEnv(() => new Anthropic({ ...clientOpts, fetch: globalThis.fetch } as never));

    const sink: {
      pendingUsage?: { input: number; output: number };
      inProgressToolUses?: Map<number, { id: string; name: string; inputJson: string }>;
    } = { inProgressToolUses: new Map() };

    try {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: ov.maxTokens ?? 1024,
          ...(ov.temperature !== undefined ? { temperature: ov.temperature } : {}),
          ...(ov.topP !== undefined ? { top_p: ov.topP } : {}),
          ...(ov.topK !== undefined ? { top_k: ov.topK } : {}),
          ...(ov.stopSequences && ov.stopSequences.length > 0 ? { stop_sequences: ov.stopSequences } : {}),
          ...(system !== undefined ? { system: system as never } : {}),
          ...ov.extraBody,
          messages: messages as never,
          ...(tools.length > 0 ? { tools: tools as never } : {}),
        },
        { signal: req.signal },
      );

      // The Anthropic SDK's MessageStream uses an EventEmitter, not async
      // iteration. Bridge it into our AsyncIterable<StreamEvent> shape.
      yield* await new Promise<AsyncGenerator<StreamEvent, void, void>>(
        (resolve, reject) => {
          const out: StreamEvent[] = [];
          let done = false;

          const finish = () => {
            if (done) return;
            done = true;
            async function* gen(): AsyncGenerator<StreamEvent, void, void> {
              while (out.length) {
                const ev = out.shift()!;
                yield ev;
              }
              yield { type: "done" };
            }
            resolve(gen());
          };

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (stream as any).on("streamEvent", (ev: { type: string; [k: string]: unknown }) => {
            if (req.signal?.aborted) return;
            translateEvent(ev as RawEvent, (e) => out.push(e), sink);
          });
          (stream as any).on("error", (err: unknown) => {
            if (req.signal?.aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            out.push({ type: "error", message });
            finish();
          });
          (stream as any).on("end", () => { finish(); });
        },
      );
    } catch (err) {
      if (req.signal?.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", message };
      yield { type: "done" };
    }
  }

  return {
    id: "anthropic",
    capabilities,
    chat(req: ChatRequest): AsyncIterable<StreamEvent> {
      const signal = req.signal;
      return {
        [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          const it = run(req);
          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              if (signal?.aborted) return { value: undefined, done: true };
              return it.next();
            },
            async return(): Promise<IteratorResult<StreamEvent>> {
              if (typeof it.return === "function") return it.return();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    resolvedConfig() {
      return {
        baseUrl: defaults.baseUrl!,
        defaultModel: defaults.defaultModel!,
        betaHeaders: [...(defaults.betaHeaders ?? [])],
      };
    },
    async inferText(
      prompt: string,
      options: InferTextOptions = {},
    ): Promise<string> {
      const req: ChatRequest = {
        model: options.model ?? defaults.defaultModel ?? readDefaultModel(),
        ...(options.system !== undefined ? { system: options.system } : {}),
        messages: [{ role: "user", content: prompt }],
        tools: [],
        ...(options.signal ? { signal: options.signal } : {}),
        overrides: {
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
      };
      let text = "";
      for await (const ev of this.chat(req)) {
        if (ev.type === "token") {
          text += ev.delta;
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
        // message_start / tool_call / tool_result / message_done / done
        // are intentionally ignored — `inferText` only returns text.
      }
      return text;
    },
  };
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _defaultProvider: AnthropicProvider | null = null;

/**
 * Lazily-constructed singleton `AnthropicProvider`, configured from
 * `process.env` (MINIMAX_TOKEN, MINIMAX_BASE_URL, MINIMAX_DEFAULT_MODEL).
 *
 * The instance is stateless across calls — concurrent `chat()` and
 * `inferText()` invocations are safe. Each call constructs a fresh
 * Anthropic SDK client internally, so there is no shared mutable state.
 *
 * Use this when you want a "just works" provider from anywhere in the
 * codebase without threading configuration through call sites:
 *
 * ```ts
 * import { getDefaultAnthropicProvider } from "@computerworks/core";
 * const answer = await getDefaultAnthropicProvider().inferText("What is 2+2?");
 * ```
 *
 * For per-request overrides (different model, base URL, etc.) call
 * `createAnthropicProvider()` explicitly instead.
 */
export function getDefaultAnthropicProvider(): AnthropicProvider {
  if (_defaultProvider === null) {
    _defaultProvider = createAnthropicProvider();
  }
  return _defaultProvider;
}

/**
 * Test helper: clear the cached singleton so the next call to
 * `getDefaultAnthropicProvider()` builds a fresh one. Use between
 * tests that mutate `process.env` (MINIMAX_TOKEN, MINIMAX_BASE_URL,
 * MINIMAX_DEFAULT_MODEL) so the new env is picked up.
 */
export function resetDefaultAnthropicProvider(): void {
  _defaultProvider = null;
}

function* emitFromSink(
  _raw: RawEvent,
  sink: { pendingUsage?: { input: number; output: number } },
): Generator<StreamEvent, void, void> {
  if (sink.pendingUsage) {
    yield { type: "message_done", usage: sink.pendingUsage };
    sink.pendingUsage = undefined;
  }
}
