// packages/cli/src/serve.ts
// T6.1 — serve command: reuses the server's start.ts logic.

import { loadConfig } from "@computerworks/server";
import { buildApp } from "@computerworks/server";

export async function startServer() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose");
  const allowNonLoopback = argv.includes("--allow-non-loopback");
  const portArg = argv.find((a) => a.startsWith("--port="));
  const hostArg = argv.find((a) => a.startsWith("--host="));
  const explicitPort = portArg ? parseInt(portArg.slice("--port=".length), 10) : undefined;
  const explicitHost = hostArg ? hostArg.slice("--host=".length) : undefined;

  const config = await loadConfig();
  if (verbose) {
    (config as unknown as { server: object }).server = { ...config.server, verbose: true };
  }

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

  const app = await buildApp({ config });
  await app.listen({ port, host });
  console.log(`ComputerWorks server listening on http://${host}:${port}`);

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
