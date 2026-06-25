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
