// packages/core/src/providers/anthropic.test.ts
// Unit tests for createAnthropicProvider. No network calls.
//
// Strategy: intercept global fetch, replay a fake Anthropic SSE
// response, and assert the request that was sent (URL, headers,
// body) plus the StreamEvent sequence we got back.

import {
  afterEach, beforeAll, describe, expect, it, mock,
} from "bun:test";
import { z } from "zod";

const TOOL = {
  name: "echo",
  description: "echoes input",
  inputSchema: z.object({ msg: z.string() }),
  requiresApproval: false,
  async execute(input: { msg: string }) { return { echoed: input.msg }; },
};

// Test fixture key. Uses "tk-" prefix so the secret-leak guard regex
// (which matches sk-... and eyJ...) does not flag this test file.
// Any 16+ char string is fine here — only the wire format matters.
const TEST_KEY = "tk-test-fixture-key-do-not-use";

const ORIGINAL_ENV: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in ORIGINAL_ENV)) ORIGINAL_ENV[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  setEnv("MINIMAX_TOKEN", TEST_KEY);
  setEnv("MINIMAX_BASE_URL", "https://api.minimax.io/anthropic");
  setEnv("MINIMAX_DEFAULT_MODEL", "MiniMax-M3");
  setEnv("ANTHROPIC_API_KEY", undefined);
  setEnv("ANTHROPIC_BASE_URL", undefined);
});

afterEach(() => { mock.restore(); });

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function installFetchMock(events: Array<{ event: string; data: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const body = events.map((e) => sseFrame(e.event, e.data)).join("");
  const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return calls;
}

describe("createAnthropicProvider", () => {
  it("uses MINIMAX_BASE_URL by default and sends Authorization header with MINIMAX_TOKEN", async () => {
    const calls = installFetchMock([
      { event: "message_start", data: {
        type: "message_start",
        message: {
          id: "msg_test", type: "message", role: "assistant",
          content: [], model: "MiniMax-M3",
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }},
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "hi" },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();
    expect(provider.id).toBe("anthropic");
    expect(provider.capabilities.toolUse).toBe(true);

    const events: import("../types.js").StreamEvent[] = [];
    for await (const ev of provider.chat({
      model: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    })) events.push(ev);

    expect(calls.length).toBe(1);
    const req = calls[0]!;
    expect(req.url).toBe("https://api.minimax.io/anthropic/v1/messages");

    const headers = req.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeDefined();

    const body = JSON.parse(req.init.body as string);
    expect(body.model).toBe("MiniMax-M3");

    const types = events.map((e) => e.type);
    expect(types).toContain("message_start");
    expect(types).toContain("token");
    expect(types).toContain("message_done");
    expect(types).toContain("done");
  });

  it("merges overrides: defaults < config < per-request", async () => {
    const calls = installFetchMock([
      { event: "message_start", data: { type: "message_start" } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider({
      betaHeaders: ["prompt-caching-2024-07-31"],
      extraBody: { metadata: { user_id: "from-config" } },
    });

    for await (const _ of provider.chat({
      model: "MiniMax-M3-override",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      overrides: {
        temperature: 0.3,
        extraBody: { metadata: { trace_id: "from-request" } },
      },
    })) { void _; }

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("MiniMax-M3-override");
    expect(body.temperature).toBe(0.3);
    expect(body.metadata).toEqual({ user_id: "from-config", trace_id: "from-request" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
  });

  it("joins multiple beta headers with ', '", async () => {
    const calls = installFetchMock([
      { event: "message_start", data: { type: "message_start" } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider({
      betaHeaders: ["prompt-caching-2024-07-31", "max-tokens-3-5-sonnet-2024-07-15"],
    });

    for await (const _ of provider.chat({
      model: "MiniMax-M3",
      messages: [{ role: "user", content: "x" }],
      tools: [],
    })) { void _; }

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31, max-tokens-3-5-sonnet-2024-07-15");
  });

  it("throws a clear error if MINIMAX_TOKEN is missing", async () => {
    setEnv("MINIMAX_TOKEN", undefined);
    const { createAnthropicProvider } = await import("./anthropic.js");
    expect(() => createAnthropicProvider()).toThrow(/MINIMAX_TOKEN/);
    setEnv("MINIMAX_TOKEN", TEST_KEY);
  });

  it("scrubs ANTHROPIC_API_KEY so a stray env var cannot misroute", async () => {
    const STRAY_KEY = "tk-stray-env-value-should-be-ignored";
    const STRAY_URL = "https://api.anthropic.com";
    setEnv("ANTHROPIC_API_KEY", STRAY_KEY);
    setEnv("ANTHROPIC_BASE_URL", STRAY_URL);

    const calls = installFetchMock([
      { event: "message_start", data: { type: "message_start" } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    for await (const _ of provider.chat({
      model: "",
      messages: [{ role: "user", content: "x" }],
      tools: [],
    })) { void _; }

    expect(calls[0]!.url).toBe("https://api.minimax.io/anthropic/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);

    expect(process.env.ANTHROPIC_API_KEY).toBe(STRAY_KEY);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(STRAY_URL);

    setEnv("ANTHROPIC_API_KEY", undefined);
    setEnv("ANTHROPIC_BASE_URL", undefined);
  });

  it("prompt caching enabled injects ephemeral cache breakpoints", async () => {
    const calls = installFetchMock([
      { event: "message_start", data: { type: "message_start" } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider({
      betaHeaders: ["prompt-caching-2024-07-31"],
    });

    for await (const _ of provider.chat({
      model: "MiniMax-M3",
      system: "you are helpful",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ],
      tools: [],
    })) { void _; }

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    const userBlocks = body.messages.flatMap((m: { content: unknown[] }) =>
      (m.content as Array<{ type?: string }>).filter((b) => b.type === "text"),
    );
    const cachedCount = (userBlocks as Array<{ cache_control?: unknown }>)
      .filter((b) => b.cache_control).length;
    expect(cachedCount).toBe(1);
  });
});

describe("AnthropicProvider.inferText", () => {
  it("returns concatenated text tokens from the stream", async () => {
    const calls = installFetchMock([
      { event: "message_start", data: {
        type: "message_start",
        message: {
          id: "msg_test", type: "message", role: "assistant",
          content: [], model: "MiniMax-M3",
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }},
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "hello, " },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "world" },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const text = await provider.inferText("say hi");
    expect(text).toBe("hello, world");

    // Verify the request was shaped like a single user message with no tools.
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("MiniMax-M3");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "say hi" }] }]);
    expect(body.tools).toBeUndefined();
  });

  it("passes through system, model, maxTokens, temperature overrides", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "ok" },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const text = await provider.inferText("summarize", {
      system: "you are concise",
      model: "MiniMax-M3-fast",
      maxTokens: 64,
      temperature: 0.2,
    });
    expect(text).toBe("ok");
  });

  it("throws on a provider error event", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      { event: "error", data: {
        type: "error",
        error: { type: "api_error", message: "rate limited" },
      }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    await expect(provider.inferText("ping")).rejects.toThrow(/rate limited/);
  });

  it("returns empty string when the response has no text tokens", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const text = await provider.inferText("noop");
    expect(text).toBe("");
  });
});

// ─── tool_use streaming ───────────────────────────────────────────────────
// Anthropic streams a tool_use block across three event types:
//   1. content_block_start  { content_block: { type: "tool_use",
//                                              id, name, input: {} } }
//   2. content_block_delta  { delta: { type: "input_json_delta",
//                                       partial_json: "..." } }   (×N)
//   3. content_block_stop   (no payload)
// The provider must accumulate the partial JSON from (2) and emit a
// single complete `tool_call` event at (3) — NOT at (1), when the
// input is still empty. This block exercises that path end-to-end.

describe("createAnthropicProvider — tool_use streaming", () => {
  it("accumulates input from input_json_delta events and emits one complete tool_call on content_block_stop", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "toolu_a", name: "echo", input: {} },
      }},
      // The real input arrives as a series of partial-JSON deltas.
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: '{"msg":' },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: '"hello world"}' },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const events: import("../types.js").StreamEvent[] = [];
    for await (const ev of provider.chat({
      model: "",
      messages: [{ role: "user", content: "echo please" }],
      tools: [TOOL],
    })) events.push(ev);

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(1);
    const call = (toolCalls[0] as Extract<typeof toolCalls[0], { type: "tool_call" }>).call;
    expect(call.id).toBe("toolu_a");
    expect(call.name).toBe("echo");
    expect(call.input).toEqual({ msg: "hello world" });
  });

  it("handles multiple tool_use blocks in a single message", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      // Block 0 — tool_use "echo"
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "toolu_echo", name: "echo", input: {} },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: '{"msg":"first"}' },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      // Block 1 — tool_use "run_shell"
      { event: "content_block_start", data: {
        type: "content_block_start", index: 1,
        content_block: { type: "tool_use", id: "toolu_shell", name: "run_shell", input: {} },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls -la /tmp"}' },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const events: import("../types.js").StreamEvent[] = [];
    for await (const ev of provider.chat({
      model: "",
      messages: [{ role: "user", content: "do two things" }],
      tools: [TOOL],
    })) events.push(ev);

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(2);
    const a = (toolCalls[0] as Extract<typeof toolCalls[0], { type: "tool_call" }>).call;
    const b = (toolCalls[1] as Extract<typeof toolCalls[1], { type: "tool_call" }>).call;
    expect(a.name).toBe("echo");
    expect(a.input).toEqual({ msg: "first" });
    expect(b.name).toBe("run_shell");
    expect(b.input).toEqual({ command: "ls -la /tmp" });
  });

  it("emits text tokens before the tool_call when a message has both text and tool_use", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      // Block 0 — text
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "running now…" },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      // Block 1 — tool_use
      { event: "content_block_start", data: {
        type: "content_block_start", index: 1,
        content_block: { type: "tool_use", id: "toolu_shell", name: "run_shell", input: {} },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"echo hi"}' },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const events: import("../types.js").StreamEvent[] = [];
    for await (const ev of provider.chat({
      model: "",
      messages: [{ role: "user", content: "say hi then run something" }],
      tools: [TOOL],
    })) events.push(ev);

    // Tokens come first, then the complete tool_call, then message_done.
    const types = events.map((e) => e.type);
    const tokenIdx = types.indexOf("token");
    const callIdx = types.indexOf("tool_call");
    const doneIdx = types.indexOf("message_done");
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(tokenIdx);
    expect(doneIdx).toBeGreaterThan(callIdx);

    const call = (events.find((e) => e.type === "tool_call") as Extract<typeof events[0], { type: "tool_call" }>).call;
    expect(call.input).toEqual({ command: "echo hi" });
  });

  it("passes malformed input JSON through as a raw string so the registry's zod validation can report a useful error", async () => {
    installFetchMock([
      { event: "message_start", data: { type: "message_start", message: {
        id: "msg_test", type: "message", role: "assistant",
        content: [], model: "MiniMax-M3",
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }}},
      { event: "content_block_start", data: {
        type: "content_block_start", index: 0,
        content_block: { type: "tool_use", id: "toolu_bad", name: "echo", input: {} },
      }},
      { event: "content_block_delta", data: {
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: "{not valid json" },
      }},
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 }},
      { event: "message_stop", data: { type: "message_stop" }},
    ]);

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const events: import("../types.js").StreamEvent[] = [];
    for await (const ev of provider.chat({
      model: "",
      messages: [{ role: "user", content: "broken" }],
      tools: [TOOL],
    })) events.push(ev);

    const call = events.find((e) => e.type === "tool_call") as
      Extract<typeof events[0], { type: "tool_call" }> | undefined;
    expect(call).toBeDefined();
    // Raw string is forwarded rather than dropped — the registry's
    // zod validation will report a clear "invalid input" error.
    expect(call?.call.input).toBe("{not valid json");
  });
});

describe("getDefaultAnthropicProvider", () => {
  it("returns the same instance across calls (lazy singleton)", async () => {
    const { getDefaultAnthropicProvider, resetDefaultAnthropicProvider } =
      await import("./anthropic.js");
    resetDefaultAnthropicProvider();
    const a = getDefaultAnthropicProvider();
    const b = getDefaultAnthropicProvider();
    expect(a).toBe(b);
  });

  it("rebuilds after resetDefaultAnthropicProvider", async () => {
    const {
      getDefaultAnthropicProvider,
      resetDefaultAnthropicProvider,
      createAnthropicProvider,
    } = await import("./anthropic.js");
    resetDefaultAnthropicProvider();
    const first = getDefaultAnthropicProvider();
    resetDefaultAnthropicProvider();
    const second = getDefaultAnthropicProvider();
    expect(first).not.toBe(second);
    // Both still behave like valid AnthropicProvider instances.
    expect(first.id).toBe("anthropic");
    expect(second.id).toBe("anthropic");
  });

  it("reads fresh env after reset (token change picks up on next call)", async () => {
    const {
      getDefaultAnthropicProvider,
      resetDefaultAnthropicProvider,
    } = await import("./anthropic.js");
    resetDefaultAnthropicProvider();
    const a = getDefaultAnthropicProvider();
    expect(a.resolvedConfig().baseUrl).toBe("https://api.minimax.io/anthropic");
    setEnv("MINIMAX_BASE_URL", "https://alt.example/anthropic");
    resetDefaultAnthropicProvider();
    const b = getDefaultAnthropicProvider();
    expect(b.resolvedConfig().baseUrl).toBe("https://alt.example/anthropic");
    setEnv("MINIMAX_BASE_URL", "https://api.minimax.io/anthropic");
  });
});

// ─── Progressive streaming (T19.14) ───────────────────────────────────────
//
// Regression for "the SSE stream returns all the tokens at once rather
// than streaming them". The previous implementation of
// `createAnthropicProvider.run` buffered every Anthropic stream event
// into a single array and only resolved the consumer Promise when the
// SDK emitted `'end'`. Tokens therefore all landed at the same wall
// timestamp, after the entire Anthropic response had been received.
//
// The fix iterates the SDK's own `MessageStream[Symbol.asyncIterator]`
// (a real async queue: pushQueue + readQueue). This test wires
// `globalThis.fetch` to a `ReadableStream` Response that emits each
// SSE frame on a small delay, captures the wall-clock timestamps at
// which `provider.chat(...)` yields `token` events, and asserts that
// the tokens arrive in order with measurable gaps between them — which
// the buffered implementation cannot satisfy because every token
// landed at the same moment after the stream ended.

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("createAnthropicProvider — progressive token streaming", () => {
  it("delivers token events as they arrive, not buffered at stream end", async () => {
    // Delays (ms) applied *before* each subsequent frame is enqueued.
    // Total wall time if consumed progressively = sum(delays) ≈ 150ms.
    // If the provider buffers, the first token arrives at ≥ 150ms.
    const delays = [40, 60, 40, 0];
    const frames = [
      frame("message_start", {
        type: "message_start",
        message: {
          id: "msg_test", type: "message", role: "assistant",
          content: [], model: "MiniMax-M3",
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      frame("content_block_start", {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "a" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "b" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "c" },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_stop", { type: "message_stop" }),
    ];

    globalThis.fetch = mock(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for (let i = 0; i < frames.length; i++) {
                controller.enqueue(enc.encode(frames[i]!));
                const wait = delays[i] ?? 0;
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
              }
            } finally {
              controller.close();
            }
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    ) as unknown as typeof fetch;

    const { createAnthropicProvider } = await import("./anthropic.js");
    const provider = createAnthropicProvider();

    const tokenTimes: number[] = [];
    const tokenDeltas: string[] = [];
    const start = performance.now();
    for await (const ev of provider.chat({
      model: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      if (ev.type === "token") {
        tokenTimes.push(performance.now() - start);
        tokenDeltas.push(ev.delta);
      }
    }

    expect(tokenDeltas).toEqual(["a", "b", "c"]);
    expect(tokenTimes.length).toBe(3);

    // Tokens arrive in order.
    expect(tokenTimes[1]!).toBeGreaterThan(tokenTimes[0]!);
    expect(tokenTimes[2]!).toBeGreaterThan(tokenTimes[1]!);

    // First token arrives substantially *before* the total streaming
    // time (140ms of delays before the third frame). A buffered
    // implementation would see the first token ≥ 140ms after start;
    // a progressive one sees it after message_start + content_block_start
    // + first delta, roughly within the first ~100ms. Pick a
    // generous threshold to keep the test stable on a loaded CI.
    expect(tokenTimes[0]!).toBeLessThan(140);
  }, 5_000);
});
