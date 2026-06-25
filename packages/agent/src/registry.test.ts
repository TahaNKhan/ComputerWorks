// packages/agent/src/registry.test.ts
// T2.2 unit tests — ToolRegistry.

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import type { ToolContext, ToolDefinition } from "@computerworks/core";

function makeCtx(): ToolContext {
  return {
    cwd: "/tmp",
    signal: new AbortController().signal,
    env: {},
    sessionId: "s1",
  };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echoes the input",
  inputSchema: z.object({ msg: z.string() }),
  requiresApproval: false,
  async execute({ msg }) {
    return { echoed: msg };
  },
};

const requireApprovalTool: ToolDefinition = {
  name: "rm",
  description: "removes a file",
  inputSchema: z.object({ path: z.string() }),
  requiresApproval: true,
  async execute({ path }) {
    return { removed: path };
  },
};

describe("ToolRegistry", () => {
  it("register + get round-trips a tool", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(reg.get("echo")).toBe(echoTool);
    expect(reg.list()).toEqual([echoTool]);
  });

  it("get returns a descriptive error for unknown tools", () => {
    const reg = new ToolRegistry();
    expect(() => reg.get("nope")).toThrow(/nope/);
  });

  it("rejects duplicate registration", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(() => reg.register(echoTool)).toThrow(/already registered/);
  });

  it("execute validates input against the zod schema", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    // Good input — works.
    await expect(
      reg.execute("echo", { msg: "hi" }, makeCtx()),
    ).resolves.toEqual({ echoed: "hi" });
    // Bad input — zod error.
    await expect(
      reg.execute("echo", { msg: 42 }, makeCtx()),
    ).rejects.toThrow();
  });

  it("execute returns a descriptive error for unknown tools", async () => {
    const reg = new ToolRegistry();
    await expect(reg.execute("nope", {}, makeCtx())).rejects.toThrow(/nope/);
  });

  it("execute respects requiresApproval flag (registry surface)", () => {
    const reg = new ToolRegistry();
    reg.register(requireApprovalTool);
    reg.register(echoTool);
    expect(reg.get("rm").requiresApproval).toBe(true);
    expect(reg.get("echo").requiresApproval).toBe(false);
  });

  it("execute forwards abort signal to the tool", async () => {
    const reg = new ToolRegistry();
    let aborted = false;
    const t: ToolDefinition = {
      name: "slow",
      description: "checks signal",
      inputSchema: z.object({}),
      requiresApproval: false,
      async execute(_input, ctx) {
        return await new Promise((resolve) => {
          if (ctx.signal.aborted) {
            aborted = true;
            resolve({ ok: false });
            return;
          }
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: false });
          });
        });
      },
    };
    reg.register(t);
    const ac = new AbortController();
    const p = reg.execute("slow", {}, { ...makeCtx(), signal: ac.signal });
    ac.abort();
    await p;
    expect(aborted).toBe(true);
  });
});
