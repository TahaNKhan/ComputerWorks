// packages/server/src/app.ts
// T5.6 — Fastify app skeleton.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { createAnthropicProvider } from "@computerworks/core";
import type { Config } from "./config.js";
import { SessionStore } from "./session-store.js";
import { SSEManager } from "./sse.js";
import { SessionRegistry } from "./session-runtime.js";
import { InteractiveApprover, ApproverRegistry } from "./interactive-approver.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerMessagesRoute, type RunAgentDeps } from "./routes/messages.js";
import { registerStreamRoute } from "./routes/stream.js";
import { registerApproveRoute } from "./routes/approve.js";
import { registerCancelRoute } from "./routes/cancel.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BuildAppOptions {
  config: Config;
  store?: SessionStore;
  sse?: SSEManager;
  registry?: SessionRegistry;
  approvers?: ApproverRegistry;
  createProvider?: RunAgentDeps["createProvider"];
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
      const allow = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
      if (allow.test(origin)) return cb(null, true);
      cb(new Error("CORS: origin not allowed"), false);
    },
    credentials: true,
  });
  await app.register(sensible);

  const store = opts.store ?? new SessionStore({
    root: opts.config.server?.sessionsRoot
      ?? join(homedir(), ".computerworks", "sessions"),
  });
  const sse = opts.sse ?? new SSEManager({ heartbeatMs: 15_000 });
  const registry = opts.registry ?? new SessionRegistry();
  const approvers = opts.approvers ?? new ApproverRegistry();

  await registerHealthRoutes(app);
  await registerSessionRoutes(app, store);

  const agentDeps: RunAgentDeps = {
    store,
    sse,
    registry,
    approvers,
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

  await registerMessagesRoute(app, agentDeps);
  await registerStreamRoute(app, sse);
  await registerApproveRoute(app, approvers);
  await registerCancelRoute(app, registry);

  (app as unknown as { __cw: unknown }).__cw = { store, sse, registry, approvers };

  return app;
}
