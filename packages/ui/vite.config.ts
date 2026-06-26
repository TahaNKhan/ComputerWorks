// packages/ui/vite.config.ts
// T7.1 — Vite + React dev server for the ComputerWorks SPA.
//
// We use Vite 5+ with the React plugin. Path aliases mirror the
// workspace's package names so source files can `import { foo } from
// "@computerworks/core"` and Vite resolves to the right TS source.
// The dev server proxies `/api` to the Fastify server on
// `localhost:8787` so the SPA can use relative URLs during
// development.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Server config is read at runtime so we don't need a typed import.
// Default to 4747 to match the Fastify server's default port.
// Override with CW_SERVER_PORT=... if you run the server elsewhere.
const serverPort = Number(process.env.CW_SERVER_PORT ?? 4747);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@computerworks/core": resolve(__dirname, "../core/src/index.ts"),
      "@computerworks/agent": resolve(__dirname, "../agent/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    // Bind to IPv4 loopback only. Default `localhost` on Windows
    // resolves to `::1` (IPv6) first, which leaves an orphan
    // listener behind that breaks `/api` proxy resolution when a
    // second Vite is started. 127.0.0.1 matches the Fastify
    // server's bind host.
    host: "127.0.0.1",
    strictPort: false,
    proxy: {
      "/api": {
        // Match the Fastify server's bind host (127.0.0.1, not
        // localhost). On Windows `localhost` resolves to `::1`
        // (IPv6) first and the server only listens on IPv4, so the
        // proxy gets ECONNREFUSED.
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist-app",
    sourcemap: true,
  },
});