// packages/ui/vite.config.ts
// T15.2 — Vite is now build-only (no dev server). The Fastify server
// serves the built bundle from packages/ui/dist-app via @fastify/static
// (see packages/server/src/app.ts). We keep the React plugin and the
// workspace alias map so the bundle resolves `@computerworks/core` and
// `@computerworks/agent` to source files.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@computerworks/core": resolve(__dirname, "../core/src/index.ts"),
      "@computerworks/agent": resolve(__dirname, "../agent/src/index.ts"),
    },
  },
  build: {
    outDir: "dist-app",
    // Clear the bundle directory on every build so stale assets
    // (renamed components, deleted files) don't ship.
    emptyOutDir: true,
    sourcemap: true,
  },
});