/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Proxy to the same PORT the server reads from the repo-root .env (default 8787).
  // Only PORT is read here; nothing from .env is exposed to the browser bundle.
  const rootEnv = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "");
  const apiPort = process.env.PORT || rootEnv.PORT || "8787";

  return {
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    setupFiles: ["./src/test-setup.ts"],
  },
};
});
