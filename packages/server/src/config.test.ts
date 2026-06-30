// packages/server/src/config.test.ts
// T5.1 unit tests — Config loader.
//
// Coverage:
//   - Defaults from the schema apply when the file is missing
//   - File with full default export parses + env overrides win
//   - File with no default export is treated as empty
//   - Bad shape → ConfigError with a useful path
//   - Bad regex string → ConfigError
//   - COMPUTERWORKS_SERVER_PORT non-integer → ConfigError
//   - expandHome handles "~" and "~/foo"
//   - resolveConfigPath resolves to absolute

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  applyEnvOverrides,
  expandHome,
  resolveConfigPath,
  ConfigError,
  ConfigSchema,
  DEFAULT_CONFIG_PATH,
} from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cw-cfg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "config.ts");
  writeFileSync(p, content, "utf8");
  return p;
}

// ─── defaults ─────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  it("returns schema defaults when the config file does not exist", async () => {
    const cfg = await loadConfig({ path: join(dir, "nope.ts"), env: {} });
    expect(cfg.defaultProvider).toBe("anthropic");
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.port).toBe(4747);
    expect(cfg.approval.autoApprove).toEqual({ read: true, write: false, shell: false });
    expect(cfg.approval.shellDenylist.length).toBeGreaterThanOrEqual(4);
    expect(cfg.memory.enabled).toBe(true);
    // memory.root must be expanded on load
    expect(cfg.memory.root).not.toContain("~");
    expect(cfg.memory.root).toContain(".computerworks/memory");
  });

  it("uses DEFAULT_CONFIG_PATH as the canonical location", () => {
    expect(DEFAULT_CONFIG_PATH).toMatch(/\.computerworks[\\/]config\.ts$/);
  });

  // ─── file parsing ───────────────────────────────────────────────────────

  it("loads a full default export from the config file", async () => {
    const path = writeConfig(`
      export default {
        providers: {
          anthropic: {
            apiKey: "file-key",
            baseUrl: "https://example.test",
            defaultModel: "MiniMax-M3",
            betaHeaders: ["beta-1", "beta-2"],
            extraHeaders: { "X-Test": "1" },
            maxTokens: 4096,
            temperature: 0.5,
          },
        },
        server: { host: "0.0.0.0", port: 9000 },
        approval: {
          autoApprove: { read: true, write: true, shell: true },
          globalShellAllowlist: [/^ls/],
          shellDenylist: [/rm\\s+-rf/],
        },
        memory: { enabled: false, root: "/tmp/mem" },
      };
    `);
    const cfg = await loadConfig({ path, env: {} });
    expect(cfg.providers.anthropic.apiKey).toBe("file-key");
    expect(cfg.providers.anthropic.baseUrl).toBe("https://example.test");
    expect(cfg.providers.anthropic.defaultModel).toBe("MiniMax-M3");
    expect(cfg.providers.anthropic.betaHeaders).toEqual(["beta-1", "beta-2"]);
    expect(cfg.providers.anthropic.extraHeaders).toEqual({ "X-Test": "1" });
    expect(cfg.providers.anthropic.maxTokens).toBe(4096);
    expect(cfg.providers.anthropic.temperature).toBe(0.5);
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.server.port).toBe(9000);
    expect(cfg.approval.autoApprove).toEqual({ read: true, write: true, shell: true });
    expect(cfg.approval.globalShellAllowlist[0]?.test("ls -la")).toBe(true);
    expect(cfg.approval.shellDenylist[0]?.test("rm -rf /")).toBe(true);
    expect(cfg.memory.enabled).toBe(false);
    expect(cfg.memory.root).toBe("/tmp/mem");
  });

  it("treats a config file with no default export as empty", async () => {
    const path = writeConfig(`// no default export here\nexport const foo = 1;`);
    const cfg = await loadConfig({ path, env: {} });
    expect(cfg.server.port).toBe(4747); // default still applies
  });

  it("compiles string-based regex entries into RegExp", async () => {
    const path = writeConfig(`
      export default {
        approval: { globalShellAllowlist: ["^git\\\\s+status$"] }
      };
    `);
    const cfg = await loadConfig({ path, env: {} });
    expect(cfg.approval.globalShellAllowlist[0]).toBeInstanceOf(RegExp);
    expect(cfg.approval.globalShellAllowlist[0]?.test("git status")).toBe(true);
  });

  // ─── env overrides ──────────────────────────────────────────────────────

  it("applies COMPUTERWORKS_* env vars on top of the file config", async () => {
    const path = writeConfig(`
      export default {
        providers: { anthropic: { apiKey: "file-key", baseUrl: "https://file" } },
        server: { host: "127.0.0.1", port: 1000 },
      };
    `);
    const cfg = await loadConfig({
      path,
      env: {
        COMPUTERWORKS_ANTHROPIC_API_KEY: "env-key",
        COMPUTERWORKS_ANTHROPIC_BASE_URL: "https://env",
        COMPUTERWORKS_SERVER_HOST: "0.0.0.0",
        COMPUTERWORKS_SERVER_PORT: "5555",
      },
    });
    expect(cfg.providers.anthropic.apiKey).toBe("env-key");
    expect(cfg.providers.anthropic.baseUrl).toBe("https://env");
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.server.port).toBe(5555);
  });

  it("leaves a field untouched if the env var is empty string", async () => {
    const path = writeConfig(`
      export default {
        providers: { anthropic: { apiKey: "file-key" } }
      };
    `);
    const cfg = await loadConfig({
      path,
      env: { COMPUTERWORKS_ANTHROPIC_API_KEY: "" },
    });
    expect(cfg.providers.anthropic.apiKey).toBe("file-key");
  });

  it("throws ConfigError on non-integer COMPUTERWORKS_SERVER_PORT", async () => {
    const path = writeConfig(`export default {};`);
    await expect(
      loadConfig({ path, env: { COMPUTERWORKS_SERVER_PORT: "not-a-number" } }),
    ).rejects.toThrow(ConfigError);
  });

  // ─── validation errors ──────────────────────────────────────────────────

  it("throws ConfigError with a path message on bad config", async () => {
    const path = writeConfig(`
      export default {
        server: { port: -1 },
      };
    `);
    try {
      await loadConfig({ path, env: {} });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(path);
      expect((err as Error).message).toContain("server.port");
    }
  });

  it("throws ConfigError when a regex string is invalid", async () => {
    const path = writeConfig(`
      export default {
        approval: { globalShellAllowlist: ["(unclosed"] }
      };
    `);
    await expect(loadConfig({ path, env: {} })).rejects.toThrow(/Invalid regular expression/);
  });

  it("strips extra keys (zod default behavior, no .strict())", async () => {
    const path = writeConfig(`
      export default {
        unknownKey: "ignored",
        server: { port: 2000, alsoUnknown: true },
      };
    `);
    const cfg = await loadConfig({ path, env: {} });
    expect(cfg.server.port).toBe(2000);
  });
});

// ─── pure helpers ─────────────────────────────────────────────────────────

describe("expandHome", () => {
  it("expands ~ alone", () => {
    const out = expandHome("~");
    expect(out).not.toBe("~");
    expect(out.length).toBeGreaterThan(1);
  });
  it("expands ~/foo to <home>/foo", () => {
    const out = expandHome("~/foo/bar");
    expect(out.endsWith("foo/bar")).toBe(true);
    expect(out.startsWith("~")).toBe(false);
  });
  it("passes through absolute paths", () => {
    expect(expandHome("/etc/passwd")).toBe("/etc/passwd");
  });
  it("passes through relative paths that don't start with ~", () => {
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});

describe("resolveConfigPath", () => {
  it("returns the absolute path unchanged", () => {
    expect(resolveConfigPath("/tmp/x.ts")).toBe("/tmp/x.ts");
  });
  it("resolves a relative path against cwd", () => {
    const out = resolveConfigPath("x.ts");
    expect(out.endsWith("x.ts")).toBe(true);
    expect(out.startsWith("/")).toBe(true);
  });
  it("expands ~ in the input", () => {
    const out = resolveConfigPath("~/cfg.ts");
    expect(out.endsWith("cfg.ts")).toBe(true);
    expect(out.startsWith("~")).toBe(false);
  });
});

// ─── applyEnvOverrides direct ─────────────────────────────────────────────

describe("applyEnvOverrides", () => {
  it("does not mutate the input config", () => {
    const base: ReturnType<typeof ConfigSchema.parse> = ConfigSchema.parse({});
    const before = JSON.stringify(base);
    applyEnvOverrides(base, { COMPUTERWORKS_SERVER_PORT: "9999" });
    expect(JSON.stringify(base)).toBe(before);
  });
});

// ─── smoke: roundtrip via a real file written by the user ────────────────

describe("config file round-trip on disk", () => {
  it("the file we just wrote is actually parseable end-to-end", async () => {
    const path = writeConfig(`
      export default {
        providers: { anthropic: { apiKey: "k", defaultModel: "MiniMax-M3" } },
        server: { port: 4748 },
      };
    `);
    expect(existsSync(path)).toBe(true);
    const cfg = await loadConfig({ path, env: {} });
    expect(cfg.providers.anthropic.defaultModel).toBe("MiniMax-M3");
    expect(cfg.server.port).toBe(4748);
    // sanity: the file content on disk matches what we wrote
    expect(readFileSync(path, "utf8")).toContain("MiniMax-M3");
  });
});

// ─── T19.5 — title config knobs + env overrides ──────────────────────────

describe("config.title (T19.5/T19.12)", () => {
  it("defaults: llmDecides true, minMessagesBetweenRenames 0 (no rate limit)", async () => {
    const cfg = await loadConfig({ path: join(dir, "nope.ts"), env: {} });
    expect(cfg.title.llmDecides).toBe(true);
    // T19.12 — default flipped to 0 so the model can rename freely.
    expect(cfg.title.minMessagesBetweenRenames).toBe(0);
  });

  it("file config can override the defaults", async () => {
    const path = writeConfig(`
      export default {
        title: {
          llmDecides: false,
          minMessagesBetweenRenames: 5,
        },
      };
    `);
    const cfg = await loadConfig({ path, env: {} });
    expect(cfg.title.llmDecides).toBe(false);
    expect(cfg.title.minMessagesBetweenRenames).toBe(5);
  });

  it("COMPUTERWORKS_TITLE_LLM_DECIDES=false flips the flag", async () => {
    const cfg = await loadConfig({
      path: join(dir, "nope.ts"),
      env: { COMPUTERWORKS_TITLE_LLM_DECIDES: "false" },
    });
    expect(cfg.title.llmDecides).toBe(false);
  });

  it("COMPUTERWORKS_TITLE_LLM_DECIDES=1 also flips it true (any truthy value)", async () => {
    const cfg = await loadConfig({
      path: join(dir, "nope.ts"),
      env: { COMPUTERWORKS_TITLE_LLM_DECIDES: "1" },
    });
    expect(cfg.title.llmDecides).toBe(true);
  });

  it("invalid COMPUTERWORKS_TITLE_LLM_DECIDES falls back to schema default", async () => {
    const cfg = await loadConfig({
      path: join(dir, "nope.ts"),
      env: { COMPUTERWORKS_TITLE_LLM_DECIDES: "maybe" },
    });
    expect(cfg.title.llmDecides).toBe(true); // schema default
  });

  it("COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES overrides", async () => {
    const cfg = await loadConfig({
      path: join(dir, "nope.ts"),
      env: { COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES: "10" },
    });
    expect(cfg.title.minMessagesBetweenRenames).toBe(10);
  });

  it("COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES=0 disables the rate limit", async () => {
    const cfg = await loadConfig({
      path: join(dir, "nope.ts"),
      env: { COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES: "0" },
    });
    expect(cfg.title.minMessagesBetweenRenames).toBe(0);
  });

  it("invalid COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES falls back to schema default", async () => {
    const cfg = await loadConfig({
      path: join(dir, "nope.ts"),
      env: { COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES: "abc" },
    });
    expect(cfg.title.minMessagesBetweenRenames).toBe(0); // schema default (no rate limit)
  });

  it("env wins over file config", async () => {
    const path = writeConfig(`
      export default {
        title: { minMessagesBetweenRenames: 5 },
      };
    `);
    const cfg = await loadConfig({
      path,
      env: { COMPUTERWORKS_TITLE_MIN_MESSAGES_BETWEEN_RENAMES: "0" },
    });
    expect(cfg.title.minMessagesBetweenRenames).toBe(0); // env won
  });
});
