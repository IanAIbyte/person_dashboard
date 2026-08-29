// 每日复盘指数清单配置：镜像 public-config.mjs 的 default + local 覆盖范式。
// dev server（阶段3 聚合服务）与 watchdog（指数盯盘）两个进程共享只读。
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_FILE = "config/daily-review.default.json";
const LOCAL_FILE = "config/daily-review.local.json";

async function readJson(filePath) {
  const source = await readFile(filePath, "utf8");
  return JSON.parse(source);
}

function validateConfig(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${source} must contain a JSON object.`);
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError(`${source} must use schemaVersion 1.`);
  }
  if (!Array.isArray(value.indices) || value.indices.length === 0 || value.indices.length > 16) {
    throw new TypeError(`${source} must contain an indices array of 1-16 entries.`);
  }
  const seen = new Set();
  for (const index of value.indices) {
    if (!index || typeof index !== "object") {
      throw new TypeError(`${source} indices entries must be objects.`);
    }
    if (!/^(sh|sz)\d{6}$/.test(String(index.symbol ?? ""))) {
      throw new TypeError(`${source} index symbol must look like sh000001.`);
    }
    if (seen.has(index.symbol)) {
      throw new TypeError(`${source} index symbols must be unique.`);
    }
    seen.add(index.symbol);
    if (typeof index.name !== "string" || !index.name.trim()) {
      throw new TypeError(`${source} index name must be a non-empty string.`);
    }
    if (typeof index.code !== "string" || !index.code.trim()) {
      throw new TypeError(`${source} index code must be a non-empty string.`);
    }
  }
  return value;
}

export async function loadDailyReviewConfig(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const localPath = path.join(root, LOCAL_FILE);
  try {
    return {
      ...validateConfig(await readJson(localPath), LOCAL_FILE),
      source: "local",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const defaultPath = path.join(root, DEFAULT_FILE);
  return {
    ...validateConfig(await readJson(defaultPath), DEFAULT_FILE),
    source: "default",
  };
}
