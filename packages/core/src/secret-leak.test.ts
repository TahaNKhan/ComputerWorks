// packages/core/src/secret-leak.test.ts
// Guard test: fails bun test if any tracked source file contains an
// obvious secret shape (sk-... API key, eyJ... JWT) or a literal
// "MINIMAX_TOKEN=*** assignment to a non-placeholder value.
//
// This runs as part of `bun test` so it gates every push via the
// pre-push hook (which runs `bun run typecheck` — but we also rely on
// CI / the user to actually run `bun test` before merging).

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SCAN_ROOTS = [
  join(REPO_ROOT, "packages"),
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".hermes",
]);

// Strict enough to catch real Anthropic / OpenAI / MiniMax / GitHub keys
// (sk-..., sk-cp-..., eyJ... JWT), permissive enough not to false-flag
// on identifiers or comments.
const KEY_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Anthropic/OpenAI-style key", re: /sk-(?:cp-)?[A-Za-z0-9_-]{20,}/ },
  { name: "JWT-style token", re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
];

const LITERAL_ENV_ASSIGNMENT = /(MINIMAX_TOKEN|ANTHROPIC_API_KEY)\s*=\s*["']?[A-Za-z0-9]{16,}/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (
      /\.(ts|tsx|js|mjs|cjs|json|md|toml|yaml|yml|sh|bash)$/.test(entry)
    ) {
      out.push(full);
    }
  }
}

describe("secret-leak guard", () => {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(r, files);

  for (const path of files) {
    const rel = path.replace(REPO_ROOT + "/", "");
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");

    lines.forEach((line, idx) => {
      // Skip lines that are clearly comments or example placeholders.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return;
      if (/example|placeholder|your[-_ ]key|xxxx/i.test(line)) return;

      for (const { name, re } of KEY_PATTERNS) {
        if (re.test(line)) {
          it(`${rel}:${idx + 1} contains ${name}`, () => {
            expect(line).not.toMatch(re);
          });
        }
      }
      if (LITERAL_ENV_ASSIGNMENT.test(line)) {
        it(`${rel}:${idx + 1} contains literal env assignment`, () => {
          expect(line).not.toMatch(LITERAL_ENV_ASSIGNMENT);
        });
      }
    });
  }

  it("scanned files exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });
});
