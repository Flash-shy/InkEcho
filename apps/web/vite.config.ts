import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Always treat `apps/web` as the Vite root, even when the CLI is started from the monorepo root. */
const webRoot = path.dirname(fileURLToPath(import.meta.url));

const backend = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
