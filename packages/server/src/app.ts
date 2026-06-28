// packages/server/src/app.ts
// T14.1 — Fastify app skeleton, refactored for per-message SSE.
//
// Before v1.14 this file owned an SSEManager and an
// ApproverRegistry; both are gone. The messages route now owns its
// own SSEWriter and InteractiveApprover (per-request), and the
// /approve + /cancel routes look up the in-flight runtime via
// `SessionRegistry` instead of a global approver registry.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { createAnthropicProvider } from "@computerworks/core";
import type { Config } from "./config.js";
import { SessionStore } from "./session-store.js";
import { SessionRegistry } from "./session-runtime.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerMessagesRoute, type RunAgentDeps } from "./routes/messages.js";
import { registerApproveRoute } from "./routes/approve.js";
import { registerCancelRoute } from "./routes/cancel.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BuildAppOptions {
  config: Config;
  store?: SessionStore;
  registry?: SessionRegistry;
  createProvider?: RunAgentDeps["createProvider"];
  /**
   * If true, the messages route installs an AutoApprover (instead of an
   * InteractiveApprover) that approves every tool call. Used by the E2E
   * smoke test and headless runs.
   */
  autoApprove?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const verbose = opts.config.server?.verbose ?? false;
  const app = Fastify({
    logger: verbose ? { level: "debug" } : { level: "warn" },
    disableRequestLogging: !verbose,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allow = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
      // Also allow private LAN ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      // — only enabled when the server is bound to a non-loopback host.
      const lan = /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/;
      if (allow.test(origin) || lan.test(origin)) return cb(null, true);
      cb(new Error("CORS: origin not allowed"), false);
    },
    credentials: true,
  });
  await app.register(sensible);

  const store = opts.store ?? new SessionStore({
    root: opts.config.server?.sessionsRoot
      ?? join(homedir(), ".computerworks", "sessions"),
  });
  const registry = opts.registry ?? new SessionRegistry();

  await registerHealthRoutes(app);
  await registerSessionRoutes(app, store);

  const agentDeps: RunAgentDeps = {
    store,
    registry,
    config: opts.config,
    createProvider: opts.createProvider ?? (() =>
      createAnthropicProvider({
        ...(opts.config.providers?.anthropic?.baseUrl
          ? { baseUrl: opts.config.providers.anthropic.baseUrl }
          : {}),
        defaultModel: opts.config.providers?.anthropic?.defaultModel,
        ...(opts.config.providers?.anthropic?.betaHeaders
          ? { betaHeaders: opts.config.providers.anthropic.betaHeaders }
          : {}),
      })
    ),
  };

  await registerMessagesRoute(app, agentDeps, { autoApprove: opts.autoApprove ?? false });
  await registerApproveRoute(app, registry);
  await registerCancelRoute(app, registry);

  // Test handle — exposes internal pieces without leaking them on
  // the public route surface.
  (app as unknown as { __cw: unknown }).__cw = { store, registry };

  return app;
}