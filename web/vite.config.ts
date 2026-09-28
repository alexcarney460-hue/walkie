import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The daemon (or `bun mock/server.ts`) serves /v1 on 127.0.0.1:7457.
// In dev, Vite proxies API + SSE calls there so the page stays same-origin.
const target = `http://127.0.0.1:${process.env.WALKIE_MOCK_PORT ?? "7457"}`;

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0, // CSP: fonts/images must be files, never data: fonts
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target, changeOrigin: false },
      "/auth": { target, changeOrigin: false },
    },
  },
});
