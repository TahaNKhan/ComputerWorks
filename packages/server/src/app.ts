// packages/server/src/app.ts
// T14.1 — Fastify app skeleton, refactored for per-message SSE.
//
// Before v1.14 this file owned an SSEManager and an
// ApproverRegistry; both are gone. The messages route now owns its
// own SSEWriter and InteractiveApprover (per-request), and the
// /approve + /cancel routes look up the in-flight runtime via
// `SessionRegistry` instead of a global approver registry.
//
// T15.1 — When `uiRoot` is provided, registers `@fastify/static` to
// serve the built UI bundle from that directory at `/`, plus a
// single GET `/` fallback that returns `index.html`. The router
// uses `?session=<id>` query strings (not paths), so a single
// fallback is enough — no `/*` catch-all.
//
// T17.2 — instantiates a `SyncHub` (one per app) and exposes the
// `GET /api/sync` endpoint. The hub carries state-change events
// for cross-tab sync via the SharedWorker; it's disjoint from the
// per-message SSE that the messages route owns.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import staticPlugin from "@fastify/static";
import { createAnthropicProvider } from "@computerworks/core";
import type { Config } from "./config.js";
import { SessionStore } from "./session-store.js";
import { SessionRegistry } from "./session-runtime.js";
import { SyncHub } from "./sync-hub.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerMessagesRoute, type RunAgentDeps } from "./routes/messages.js";
import { registerApproveRoute } from "./routes/approve.js";
import { registerCancelRoute } from "./routes/cancel.js";
import { registerSyncRoute } from "./routes/sync.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  /**
   * Absolute path to the built UI bundle directory (typically
   * `packages/ui/dist-app`). When set, `@fastify/static` serves the
   * bundle at `/`, and a GET `/` fallback returns `index.html`.
   * Omit for API-only deployments or tests that don't care about
   * the UI.
   */
  uiRoot?: string;
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
  const syncHub = new SyncHub();

  await registerHealthRoutes(app);
  await registerSessionRoutes(app, store);

  const agentDeps: RunAgentDeps = {
    store,
    registry,
    config: opts.config,
    syncHub,
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
  await registerSyncRoute(app, { syncHub });

  // T15.1 — Serve the built UI bundle from the same origin as the
  // API. `serve: false` makes @fastify/static NOT auto-register any
  // routes; we wire them up explicitly so there's no conflict
  // between @fastify/static's internal index handler and the
  // GET / fallback below. All asset files (everything except
  // index.html) live under /assets/ in the built bundle, served
  // by the wildcard route; GET / returns index.html.
  if (opts.uiRoot) {
    await app.register(staticPlugin, {
      root: resolve(opts.uiRoot),
      serve: false,
    });
    app.get("/", async (_req, reply) => {
      return reply.sendFile("index.html");
    });
    // Wildcard route for everything else; @fastify/static resolves
    // the path against the configured root. We use req.url directly
    // (stripped of the leading `/`) instead of the wildcard param
    // because Fastify's typing for `/*` wildcard params isn't
    // ergonomic without a generic at every handler site.
    app.get("/*", async (req, reply) => {
      const assetPath = req.url.replace(/^\/+/, "");
      return reply.sendFile(assetPath);
    });
  }

  // Test handle — exposes internal pieces without leaking them on
  // the public route surface.
  (app as unknown as { __cw: unknown }).__cw = {
    store,
    registry,
    syncHub,
    uiRoot: opts.uiRoot,
  };

  return app;
}