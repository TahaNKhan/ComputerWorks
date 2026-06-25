// packages/agent/src/registry.ts
// T2.2 — Tool registry.
//
// Per DESIGN.MD §7 (and TASKS.MD Phase 2):
//   - register(tool)
//   - get(name)
//   - validates inputs against the tool's zod schema
//   - returns descriptive errors for unknown tools
//
// Used by the agent loop in T2.3 and by the server in Phase 5.

import type { ToolContext, ToolDefinition } from "@computerworks/core";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition {
    const t = this.tools.get(name);
    if (!t) {
      const known = [...this.tools.keys()].join(", ");
      throw new Error(
        `unknown tool: ${name}` + (known ? ` (known tools: ${known})` : ""),
      );
    }
    return t;
  }

  /** Returns tools in registration order. */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Validate `input` against the tool's zod schema, then execute.
   * The signal from `ctx` is passed through to the tool's `execute`.
   */
  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<unknown> {
    const tool = this.get(name); // throws on unknown
    const parsed = tool.inputSchema.parse(input); // throws on bad input
    return await tool.execute(parsed, ctx);
  }
}
