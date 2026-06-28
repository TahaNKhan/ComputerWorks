// packages/server/src/config.ts
// T5.1 — Config loader.
//
// Loads ~/.computerworks/config.ts (a user-authored module) via `jiti`,
// validates the exported default with the schema in DESIGN.MD §12,
// and applies COMPUTERWORKS_* env overrides on top.
//
// Design choices:
//   - The schema below is the source of truth for what config keys
//     exist. Defaults are applied by zod, not by hand, so the file
//     loader can pass through an empty `{}` and still get a complete
//     config object.
//   - The env override layer is read AFTER the file. Env wins. The
//     specific keys we honor are listed in DESIGN.MD §12; we don't
//     claim to support every nested override because the design only
//     specifies these four.
//   - jiti gives us TypeScript-aware loading without a separate
//     build step. The config file may use any TS syntax that compiles
//     in-place.
//
// Failure modes:
//   - File does not exist: we treat that as "no file config" and
//     fall back to defaults. A user who never ran `computerworks init`
//     must still be able to start the server.
//   - File exists but the default export doesn't match the schema:
//     we throw with a structured error so the CLI can show a useful
//     message and exit non-zero.
//   - Required env vars are not validated here; the provider layer
//     (T1.3) does that. We only override; absence is not our problem.

import { createJiti, type Jiti } from "jiti";
import { z } from "zod";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";

// ─── Schema ───────────────────────────────────────────────────────────────

/** A single regex literal in the config. We accept RegExp instances
 *  OR a string source (which we compile via `new RegExp` so the config
 *  file can stay JSON-ish if the user prefers). */
const regexLiteral = z.union([
  z.instanceof(RegExp),
  z.string().min(1).transform((src, ctx) => {
    try {
      return new RegExp(src);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid regular expression: ${src}`,
      });
      return z.NEVER;
    }
  }),
]);

export const ConfigSchema = z.object({
  providers: z
      .object({
        anthropic: z
          .object({
            apiKey: z.string().optional(),
            baseUrl: z.string().url().default("https://api.minimax.io/anthropic"),
            defaultModel: z.string().default("MiniMax-M3"),
            betaHeaders: z.array(z.string()).default([]),
            extraHeaders: z.record(z.string()).default({}),
            maxTokens: z.number().int().positive().optional(),
            temperature: z.number().min(0).max(2).optional(),
          })
          .default({}),
      })
      .default({}),
  defaultProvider: z.literal("anthropic").default("anthropic"),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().positive().default(4747),
      verbose: z.boolean().default(false),
      sessionsRoot: z.string().optional(),
    })
    .default({}),
  approval: z
    .object({
      autoApprove: z
        .object({
          read: z.boolean().default(true),
          write: z.boolean().default(false),
          shell: z.boolean().default(false),
        })
        .default({}),
      globalShellAllowlist: z.array(regexLiteral).default([]),
      // Default denylist covers POSIX and Windows destructive commands.
      // Users can override via their config.ts or by adding entries;
      // the list is applied cross-platform so a user who configured
      // for one OS still gets the other set as a safety net.
      shellDenylist: z
        .array(regexLiteral)
        .default([
          // POSIX destructive
          /rm\s+-rf\s+\//,
          /format\s+c:/i,
          /mkfs/,
          /dd\s+if=/,
          // Windows destructive (cmd.exe)
          /rd\s+\/s\s+\/q/i,
          /del\s+\/s\s+\/q/i,
          /format\s+[a-z]:/i,
          /diskpart/i,
          /bcdedit/i,
          // Windows destructive (PowerShell)
          /Remove-Item\s+.*-Recurse\s+.*-Force/i,
          /Format-Volume/i,
          /Clear-Disk/i,
          /reg\s+delete\s+HKEY/i,
        ]),
    })
    .default({}),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      root: z.string().default("~/.computerworks/memory"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** A "raw" config is anything jiti returns from a user-authored .ts
 *  file. It is permitted to be incomplete (defaults fill in) or
 *  contain extra keys (we strip them). */
export type RawConfig = z.input<typeof ConfigSchema>;

// ─── Path resolution ──────────────────────────────────────────────────────

export const DEFAULT_CONFIG_PATH = join(homedir(), ".computerworks", "config.ts");

/** Expand a leading "~/" or "~" to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve a config file path to an absolute one. Symlinks aren't
 *  followed — `jiti` handles the file itself. */
export function resolveConfigPath(p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

// ─── Env overrides ────────────────────────────────────────────────────────

/** Apply COMPUTERWORKS_* env vars on top of a parsed config.
 *  Only the keys DESIGN.MD §12 lists are honored; everything else
 *  must come from the file. */
export function applyEnvOverrides(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const out: Config = structuredClone(config);

  if (env.COMPUTERWORKS_ANTHROPIC_API_KEY) {
    out.providers.anthropic.apiKey = env.COMPUTERWORKS_ANTHROPIC_API_KEY;
  }
  if (env.COMPUTERWORKS_ANTHROPIC_BASE_URL) {
    out.providers.anthropic.baseUrl = env.COMPUTERWORKS_ANTHROPIC_BASE_URL;
  }
  if (env.COMPUTERWORKS_SERVER_PORT) {
    const port = Number(env.COMPUTERWORKS_SERVER_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ConfigError(
        `COMPUTERWORKS_SERVER_PORT must be a positive integer, got: ${env.COMPUTERWORKS_SERVER_PORT}`,
      );
    }
    out.server.port = port;
  }
  if (env.COMPUTERWORKS_SERVER_HOST) {
    out.server.host = env.COMPUTERWORKS_SERVER_HOST;
  }

  // Expand ~ in memory.root, since zod defaults it that way too.
  out.memory.root = expandHome(out.memory.root);

  return out;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /** Override the default config file path. Used by tests. */
  path?: string;
  /** Source of env vars. Defaults to process.env. Used by tests. */
  env?: NodeJS.ProcessEnv;
  /** A pre-built jiti instance. Used by tests for caching or custom
   *  loaders; otherwise we create a fresh one per call. */
  jiti?: Jiti;
}

/**
 * Load, parse, and validate the user config.
 *
 * - If `path` doesn't exist, the defaults from the schema apply.
 * - If `path` exists but fails validation, throws `ConfigError`.
 * - Env overrides are applied last; they win.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const filePath = resolveConfigPath(opts.path ?? DEFAULT_CONFIG_PATH);
  const env = opts.env ?? process.env;
  const jiti =
    opts.jiti ??
    createJiti(import.meta.url, {
      // We don't want jiti to mess with the user's TS install; let it
      // fall back to its built-in transformer.
      interopDefault: true,
      moduleCache: false,
    });

  let raw: RawConfig = {};
  let fileExists = true;
  try {
    await stat(filePath);
  } catch {
    fileExists = false;
  }
  if (fileExists) {
    let mod: unknown;
    try {
      mod = await jiti.import(filePath);
    } catch (err) {
      throw new ConfigError(
        `Failed to load config file at ${filePath}: ${(err as Error).message}`,
        err,
      );
    }
    const candidate = extractDefaultExport(mod);
    if (candidate === undefined) {
      // No default export — treat as empty config.
      raw = {};
    } else {
      raw = candidate as RawConfig;
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config at ${filePath}:\n${formatZodIssues(parsed.error.issues)}`,
    );
  }

  return applyEnvOverrides(parsed.data, env);
}

/** Pull the default export out of whatever jiti handed us. Handles
 *  `export default x`, `module.exports = x`, and `export { x as default }`
 *  in the ESM-interop case. Returns undefined if there's nothing
 *  sensible. */
function extractDefaultExport(mod: unknown): unknown {
  if (mod === null || mod === undefined) return undefined;
  if (typeof mod !== "object" && typeof mod !== "function") return mod;
  const obj = mod as Record<string, unknown>;
  if ("default" in obj) {
    return obj.default;
  }
  return mod;
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((iss) => {
      const path = iss.path.length ? iss.path.join(".") : "<root>";
      return `  - ${path}: ${iss.message}`;
    })
    .join("\n");
}
