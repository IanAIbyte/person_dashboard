import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { workbenchApiPlugin } from "./server/vite-plugin-workbench.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const obsidianVaultRoot =
    env.OBSIDIAN_VAULT_ROOT || env.CAREER_VAULT_ROOT || null;
  // 智谱密钥：Workbench/.env 优先；手动 npm run dev 时回退读 shell 环境变量
  // （Coding Plan 套餐的约定变量：GLM_API_KEY + GLM_CODING_BASE_URL）。
  // launchd 服务不继承 shell 环境，仍以 .env 为准。
  const zhipuApiKey =
    env.ZHIPU_API_KEY || process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || null;
  const zhipuBaseUrl =
    env.ZHIPU_BASE_URL || process.env.ZHIPU_BASE_URL || process.env.GLM_CODING_BASE_URL || null;
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
        zhipuApiKey,
        zhipuBaseUrl,
        serverChanSendKey: env.SERVERCHAN_SENDKEY || null,
      }),
    ],
  };
});
