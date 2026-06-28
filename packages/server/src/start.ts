// packages/server/src/start.ts
// T5.6 — Process entry point. Loads config, builds the app, and
// starts listening.
//
// Refuses to bind to non-loopback interfaces without the explicit
// `--allow-non-loopback` flag (REQUIREMENTS.MD §6).
//
// T15.1 — `--ui-root=<path>` flag selects the built UI bundle
// directory. Default is `<workspace root>/packages/ui/dist-app`,
// resolved relative to this file's location so it works regardless
// of cwd (important when invoked via `bun run --filter
// @computerworks/server start`). Validated at startup; clear error
// if the path is missing.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

// src/start.ts → ../../../packages/ui/dist-app = <workspace>/packages/ui/dist-app
// (also works when compiled: dist/start.js → ../../../packages/ui/dist-app)
const DEFAULT_UI_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "packages", "ui", "dist-app",
);

async function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose");
  const allowNonLoopback = argv.includes("--allow-non-loopback");
  const portArg = argv.find((a) => a.startsWith("--port="));
  const hostArg = argv.find((a) => a.startsWith("--host="));
  const uiRootArg = argv.find((a) => a.startsWith("--ui-root="));
  const explicitPort = portArg ? parseInt(portArg.slice("--port=".length), 10) : undefined;
  const explicitHost = hostArg ? hostArg.slice("--host=".length) : undefined;
  const explicitUiRoot = uiRootArg ? uiRootArg.slice("--ui-root=".length) : undefined;

  const config = await loadConfig();
  if (verbose) (config as unknown as { server: object }).server = { ...config.server, verbose: true };

  const host = explicitHost ?? config.server?.host ?? "127.0.0.1";
  const port = explicitPort ?? config.server?.port ?? 4747;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    if (!allowNonLoopback) {
      console.error(
        `Refusing to bind to ${host}:${port}: non-loopback bind requires --allow-non-loopback.`,
      );
      console.error(
        "ComputerWorks is a local-first agent; binding to a public interface exposes your machine and every approval gate to the network.",
      );
      process.exit(2);
    }
    console.warn(`WARNING: binding to non-loopback ${host}:${port}. Use only on trusted networks.`);
  }

  // T15.1 — Resolve the UI bundle directory. Default to the standard
  // monorepo layout, computed relative to this file so the resolution
  // is independent of cwd. Validate it exists; fail fast with a
  // helpful error so users don't see a 500 on every page load after
  // a `bun run start` without `bun run build`.
  const uiRoot = resolve(explicitUiRoot ?? DEFAULT_UI_ROOT);
  if (!existsSync(uiRoot)) {
    console.error(`UI bundle directory not found: ${uiRoot}`);
    console.error("Run \`bun run build\` first to produce the UI bundle, or pass --ui-root=<path>.");
    process.exit(2);
  }

  const app = await buildApp({ config, uiRoot });
  await app.listen({ port, host });
  console.log(`ComputerWorks server listening on http://${host}:${port}`);
  console.log(`Serving UI from ${uiRoot}`);

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
