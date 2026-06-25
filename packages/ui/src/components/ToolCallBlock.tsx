// packages/ui/src/components/ToolCallBlock.tsx
// T7.8 — Collapsible inline block for a tool call + its result.

import React from "react";
import type { MessagePart } from "../api/types.js";

interface Props {
  part: Extract<MessagePart, { kind: "tool_call" }>;
}

export function ToolCallBlock({ part }: Props): JSX.Element {
  const inputStr = renderInput(part.call.input);
  const resultStr = renderResult(part.result);
  const isError = part.isError === true;
  return (
    <details className={`cw-tool-call ${isError ? "error" : ""}`}>
      <summary>
        <span className="cw-tool-icon">⚙</span>
        <span className="cw-tool-name">{part.call.name}</span>
        {part.approved === false && (
          <span className="cw-tool-badge cw-tool-badge-rejected">rejected</span>
        )}
        {isError && <span className="cw-tool-badge cw-tool-badge-error">error</span>}
      </summary>
      <div className="cw-tool-section">
        <div className="cw-tool-label">input</div>
        <pre className="cw-tool-pre">{inputStr}</pre>
      </div>
      {resultStr !== null && (
        <div className="cw-tool-section">
          <div className="cw-tool-label">result</div>
          <pre className="cw-tool-pre">{resultStr}</pre>
        </div>
      )}
    </details>
  );
}

function renderInput(input: unknown): string {
  if (input === undefined || input === null) return "(no input)";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function renderResult(result: unknown): string | null {
  if (result === undefined) return null;
  // Server tool outputs often look like { stdout, stderr, exitCode }.
  if (result && typeof result === "object" && ("stdout" in result || "stderr" in result)) {
    const r = result as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    const lines: string[] = [];
    if (typeof r.stdout === "string" && r.stdout.length > 0) lines.push(r.stdout);
    if (typeof r.stderr === "string" && r.stderr.length > 0) lines.push(`(stderr)\n${r.stderr}`);
    if (r.exitCode !== undefined) lines.push(`\n(exit ${String(r.exitCode)})`);
    return lines.join("\n");
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}