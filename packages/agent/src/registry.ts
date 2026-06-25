// packages/agent/src/registry.ts
// T2.2 — Tool registry.
//
// Per DESIGN.MD §7 (and TASKS.MD Phase 2):
//   - register(tool)
//   - get(name)
//   - validates inputs against the tool's zod schema
//   - returns descriptive errors for unknown tools
//   - formats Zod validation errors as actionable messages so the
//     model can self-correct on the next iteration
//
// Used by the agent loop in T2.3 and by the server in Phase 5.

import { z, ZodError } from "zod";
import type { ToolContext, ToolDefinition } from "@computerworks/core";

/**
 * Custom error class for tool input validation failures.
 *
 * The loop / SSE pipeline catches this specifically and surfaces it
 * as a structured `tool_validation_error` event (Phase 11 follow-up)
 * with the offending tool name and field paths, instead of leaking a
 * raw ZodError JSON dump to the model.
 */
export class ToolValidationError extends Error {
  readonly toolName: string;
  readonly issues: ReadonlyArray<{
    path: string;
    message: string;
    expected?: string;
    received?: string;
  }>;

  constructor(
    toolName: string,
    issues: ToolValidationError["issues"],
  ) {
    const summary = ToolValidationError.format(toolName, issues);
    super(summary);
    this.name = "ToolValidationError";
    this.toolName = toolName;
    this.issues = issues;
  }

  /**
   * Format a human-readable, actionable message.
   *
   * Example:
   *   "Tool 'read_file' was called with invalid arguments:
   *    - missing required field 'path' (expected string)
   *    Call read_file again with {path: '<file path>'}."
   */
  static format(
    toolName: string,
    issues: ToolValidationError["issues"],
  ): string {
    if (issues.length === 0) {
      return `Tool '${toolName}' was called with invalid arguments.`;
    }
    const bullets = issues
      .map((i) => {
        const where = i.path ? `'${i.path}'` : "(root)";
        const what = i.expected ? ` (expected ${i.expected})` : "";
        return `- ${i.message} at ${where}${what}`;
      })
      .join("\n");
    return (
      `Tool '${toolName}' was called with invalid arguments:\n${bullets}\n` +
      `Call ${toolName} again with the correct argument shape.`
    );
  }
}

/** Convert a ZodError into a list of structured issues. */
function zodIssues(err: ZodError): ToolValidationError["issues"] {
  return err.issues.map((issue) => {
    const path = issue.path.join(".") || "(root)";
    const out: ToolValidationError["issues"][number] = {
      path,
      message: issue.message,
    };
    if ("expected" in issue && issue.expected !== undefined) {
      out.expected = String(issue.expected);
    }
    if ("received" in issue && issue.received !== undefined) {
      out.received = String(issue.received);
    }
    return out;
  });
}

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
   *
   * On validation failure throws `ToolValidationError` (NOT a raw
   * ZodError) so callers can distinguish "bad input shape" from "tool
   * ran but errored at runtime" and surface a structured event to the
   * UI / model. The signal from `ctx` is passed through to the tool's
   * `execute`.
   */
  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<unknown> {
    const tool = this.get(name); // throws on unknown
    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(input);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ToolValidationError(name, zodIssues(err));
      }
      throw err;
    }
    return await tool.execute(parsed, ctx);
  }
}

// Re-export z so consumers can build ToolDefinitions ergonomically.
export { z };
