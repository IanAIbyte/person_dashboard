import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { workbenchApiPlugin } from "./server/vite-plugin-workbench.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const obsidianVaultRoot =
    env.OBSIDIAN_VAULT_ROOT || env.CAREER_VAULT_ROOT || null;
  return {
    cacheDir: process.env.VITE_CACHE_DIR || "node_modules/.vite",
    build: {
      outDir: "dist/client",
      emptyOutDir: false,
    },
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      // This server exposes local Vault reads, note persistence, and a confirmed
      // Codex write action. Keep it loopback-only by default.
      host: "127.0.0.1",
      allowedHosts: ["terminal.local"],
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    plugins: [
      react(),
      workbenchApiPlugin({
        careerVaultRoot: env.CAREER_VAULT_ROOT || null,
        obsidianVaultRoot,
      }),
    ],
  };
});
