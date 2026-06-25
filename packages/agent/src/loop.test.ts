// packages/agent/src/loop.test.ts
// T2.3 unit tests — runTurn state machine.
//
// We use a ScriptedProvider (from @computerworks/core) to drive the
// loop deterministically without network calls. Each test scripts a
// sequence of StreamEvent frames and asserts the resulting events.

import { describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import { createScriptedProvider } from "@computerworks/core";
import { AutoApprover } from "./approval.js";
import { ToolRegistry } from "./registry.js";
import { runTurn } from "./loop.js";
import type {
  Message,
  ProviderOverrides,
  StreamEvent,
  ToolContext,
  ToolDefinition,
} from "@computerworks/core";

const ECHO: ToolDefinition = {
  name: "echo",
  description: "echoes input",
  inputSchema: z.object({ msg: z.string() }),
  requiresApproval: false,
  async execute({ msg }) {
    return { echoed: msg };
  },
};

const DANGEROUS: ToolDefinition = {
  name: "dangerous",
  description: "needs approval",
  inputSchema: z.object({ cmd: z.string() }),
  requiresApproval: true,
  async execute({ cmd }) {
    return { ran: cmd };
  },
};

function ctx(signal?: AbortSignal): ToolContext {
  return {
    cwd: "/tmp",
    signal: signal ?? new AbortController().signal,
    env: {},
    sessionId: "s1",
  };
}

describe("runTurn", () => {
  it("happy path: text response, no tools", async () => {
    const provider = createScriptedProvider({
      frames: [
        [
          { type: "message_start" },
          { type: "token", delta: "Hello" },
          { type: "token", delta: " world" },
          { type: "message_done", usage: { input: 5, output: 7 } },
        ],
      ],
    });
    const events: unknown[] = [];
    const final = await runTurn({
      provider,
      model: "MiniMax-M3",
      system: "be helpful",
      history: [{ role: "user", content: "hi" }],
      tools: [],
      approver: new AutoApprover(() => ({ kind: "approve_once" })),
      overrides: undefined as unknown as ProviderOverrides,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    expect(final.role).toBe("assistant");
    expect(final.content).toEqual([{ type: "text", text: "Hello world" }]);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("token");
    expect(types).toContain("turn_done");
  });

  it("calls a tool, executes it, appends tool_result, and continues the loop", async () => {
    const provider = createScriptedProvider({
      frames: [
        // Frame 1: tool_call
        [
          { type: "message_start" },
          {
            type: "tool_call",
            call: { type: "tool_use", id: "c1", name: "echo", input: { msg: "hi" } },
          },
          { type: "message_done", usage: { input: 1, output: 1 } },
        ],
        // Frame 2: text reply after seeing tool result
        [
          { type: "message_start" },
          { type: "token", delta: "done" },
          { type: "message_done", usage: { input: 2, output: 2 } },
        ],
      ],
    });
    const reg = new ToolRegistry();
    reg.register(ECHO);
    const events: unknown[] = [];
    const final = await runTurn({
      provider,
      model: "MiniMax-M3",
      system: "",
      history: [{ role: "user", content: "echo hi" }],
      registry: reg,
      approver: new AutoApprover(() => ({ kind: "approve_once" })),
      overrides: undefined as unknown as ProviderOverrides,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    // The loop should append a tool_result to history for the next round.
    expect(final.role).toBe("assistant");
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("turn_done");
  });

  it("rejection-recovery: rejected tool becomes a tool_result with is_error", async () => {
    const provider = createScriptedProvider({
      frames: [
        [
          { type: "message_start" },
          {
            type: "tool_call",
            call: { type: "tool_use", id: "c1", name: "dangerous", input: { cmd: "rm -rf /" } },
          },
          { type: "message_done", usage: { input: 1, output: 1 } },
        ],
        [
          { type: "message_start" },
          { type: "token", delta: "ok" },
          { type: "message_done", usage: { input: 1, output: 1 } },
        ],
      ],
    });
    const reg = new ToolRegistry();
    reg.register(DANGEROUS);
    const events: unknown[] = [];
    await runTurn({
      provider,
      model: "MiniMax-M3",
      system: "",
      history: [{ role: "user", content: "x" }],
      registry: reg,
      approver: new AutoApprover(() => ({ kind: "reject", reason: "no" })),
      overrides: undefined as unknown as ProviderOverrides,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    // Find the tool_result event and verify is_error + reason.
    const tr = events.find(
      (e) => (e as { type: string }).type === "tool_result",
    ) as { approved: boolean; is_error: boolean; reason?: string } | undefined;
    expect(tr).toBeDefined();
    expect(tr!.approved).toBe(false);
    expect(tr!.is_error).toBe(true);
    expect(tr!.reason).toBe("rejected: no");
  });

  it("iteration cap: limits total tool calls per turn", async () => {
    // 5 identical frames (loop calls provider.chat() once per iteration; cap is 3).
    const frame = (): StreamEvent[] => [
      { type: "message_start" },
      {
        type: "tool_call",
        call: { type: "tool_use", id: "c1", name: "echo", input: { msg: "x" } },
      },
      { type: "message_done", usage: { input: 1, output: 1 } },
    ];
    const provider = createScriptedProvider({
      frames: [frame(), frame(), frame(), frame(), frame()],
    });
    const reg = new ToolRegistry();
    reg.register(ECHO);
    const events: unknown[] = [];
    await runTurn({
      provider,
      model: "MiniMax-M3",
      system: "",
      history: [{ role: "user", content: "loop" }],
      registry: reg,
      approver: new AutoApprover(() => ({ kind: "approve_once" })),
      overrides: undefined as unknown as ProviderOverrides,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
      maxIterations: 3,
    });
    const err = events.find((e) => (e as { type: string }).type === "error");
    expect(err).toBeDefined();
    expect((err as { message: string }).message).toMatch(/iteration cap|iterations/i);
  });

  it("cancellation: abort signal stops the loop and drops the partial message", async () => {
    const provider = createScriptedProvider({
      frames: [
        [
          { type: "message_start" },
          { type: "token", delta: "abc" },
          { type: "token", delta: "def" },
          { type: "message_done", usage: { input: 1, output: 1 } },
        ],
      ],
    });
    const ac = new AbortController();
    ac.abort(); // already aborted
    await expect(
      runTurn({
        provider,
        model: "MiniMax-M3",
        system: "",
        history: [{ role: "user", content: "x" }],
        tools: [],
        approver: new AutoApprover(() => ({ kind: "approve_once" })),
        overrides: undefined as unknown as ProviderOverrides,
        onEvent: () => undefined,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("tool error: returns tool_result with is_error, loop continues", async () => {
    const failingTool: ToolDefinition = {
      name: "broken",
      description: "always fails",
      inputSchema: z.object({}),
      requiresApproval: false,
      async execute() {
        throw new Error("kaboom");
      },
    };
    const provider = createScriptedProvider({
      frames: [
        [
          { type: "message_start" },
          {
            type: "tool_call",
            call: { type: "tool_use", id: "c1", name: "broken", input: {} },
          },
          { type: "message_done", usage: { input: 1, output: 1 } },
        ],
        [
          { type: "message_start" },
          { type: "token", delta: "ok" },
          { type: "message_done", usage: { input: 1, output: 1 } },
        ],
      ],
    });
    const reg = new ToolRegistry();
    reg.register(failingTool);
    const events: unknown[] = [];
    await runTurn({
      provider,
      model: "MiniMax-M3",
      system: "",
      history: [{ role: "user", content: "x" }],
      registry: reg,
      approver: new AutoApprover(() => ({ kind: "approve_once" })),
      overrides: undefined as unknown as ProviderOverrides,
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });
    const tr = events.find(
      (e) => (e as { type: string }).type === "tool_result",
    ) as { is_error: boolean; reason?: string } | undefined;
    expect(tr).toBeDefined();
    expect(tr!.is_error).toBe(true);
    expect(tr!.reason).toMatch(/kaboom/);
  });
});
