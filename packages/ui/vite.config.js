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
const serverPort = Number(process.env.CW_SERVER_PORT ?? 8787);
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
        strictPort: false,
        proxy: {
            "/api": {
                target: `http://localhost:${serverPort}`,
                changeOrigin: false,
            },
        },
    },
    build: {
        outDir: "dist-app",
        sourcemap: true,
    },
});
//# sourceMappingURL=vite.config.js.map