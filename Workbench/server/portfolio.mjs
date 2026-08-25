// 每日复盘「持仓分析」存储。镜像 review-events 的 repository 范式：
// 原子写（tmp + rename）+ mutation 队列 + symlink 逃逸校验。
// 只存持仓快照（股数/成本），清仓走 closedAt 标记保留历史，不记交易流水。

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { DEFAULT_VAULT_ROOT, isPathInside } from "./security.mjs";

export const PORTFOLIO_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-portfolio.json";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_POSITIONS = 100;
const MAX_NOTE_LENGTH = 200;
const STORE_DIRECTORY = path.posix.dirname(PORTFOLIO_PATH);

export class PortfolioError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PortfolioError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PortfolioError(code, message, details);
}

function normalizeCode(value) {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) {
    fail("INVALID_POSITION", "股票代码必须是 6 位数字。");
  }
  return value;
}

function normalizeName(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) {
    fail("INVALID_POSITION", "股票名称无效。");
  }
  return value.normalize("NFC").trim() || null;
}

function normalizeShares(value) {
  const shares = Number(value);
  if (!Number.isInteger(shares) || shares <= 0 || shares > 10_000_000) {
    fail("INVALID_POSITION", "股数必须是正整数。");
  }
  return shares;
}

function normalizePrice(value, label) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    fail("INVALID_POSITION", `${label}必须是正数。`);
  }
  return Math.round(price * 1000) / 1000;
}

function normalizeOptionalPrice(value, label) {
  if (value == null || value === "") return null;
  return normalizePrice(value, label);
}

function normalizeDateString(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail("INVALID_POSITION", `${label}必须是 YYYY-MM-DD。`);
  }
  return value;
}

function normalizeNote(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_NOTE_LENGTH) {
    fail("INVALID_POSITION", "备注无效或超过 200 字。");
  }
  return value.normalize("NFC").trim() || null;
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") fail("INVALID_POSITION", "持仓条目无效。");
  const closedAt = normalizeDateString(value.closedAt, "清仓日期");
  const closedPrice = normalizeOptionalPrice(value.closedPrice, "清仓价");
  if ((closedAt && closedPrice == null) || (closedPrice != null && !closedAt)) {
    fail("INVALID_POSITION", "清仓日期与清仓价必须同时提供。");
  }
  return {
    id: String(value.id || randomUUID()),
    code: normalizeCode(value.code),
    name: normalizeName(value.name),
    shares: normalizeShares(value.shares),
    costPrice: normalizePrice(value.costPrice, "成本价"),
    openedAt: normalizeDateString(value.openedAt, "建仓日期"),
    targetPrice: normalizeOptionalPrice(value.targetPrice, "目标价"),
    stopPrice: normalizeOptionalPrice(value.stopPrice, "止损价"),
    note: normalizeNote(value.note),
    closedAt,
    closedPrice,
  };
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: null, positions: [] };
}

async function ensureSafeStorageDirectory(vaultRoot) {
  let realVaultRoot;
  try {
    realVaultRoot = await realpath(path.resolve(vaultRoot));
  } catch (error) {
    fail("INVALID_VAULT", "Vault 不存在或不可访问。", { cause: error?.code });
  }
  let parent = realVaultRoot;
  for (const segment of STORE_DIRECTORY.split("/")) {
    const candidate = path.join(parent, segment);
    let details;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(candidate, { mode: 0o700 });
      details = await lstat(candidate);
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      fail("UNSAFE_PORTFOLIO_DIRECTORY", `${segment} 必须是 Vault 内的真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "持仓目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

async function safeStorePath(vaultRoot) {
  const directory = await ensureSafeStorageDirectory(vaultRoot);
  const target = path.join(directory, path.posix.basename(PORTFOLIO_PATH));
  const realTarget = await realpath(target).catch(() => target);
  if (!isPathInside(directory, realTarget)) {
    fail("SYMLINK_ESCAPE", "持仓文件必须是 Vault 内的真实文件。");
  }
  return target;
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PORTFOLIO_CORRUPT", "持仓存储无效。");
  }
  const positions = Array.isArray(value.positions) ? value.positions : [];
  return {
    version: STORE_VERSION,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    positions: positions.map(normalizePosition),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createPortfolioRepository({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, PORTFOLIO_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_PORTFOLIO", "持仓路径越出了 Vault。");
  }
  let mutationQueue = Promise.resolve();

  async function readStore() {
    const targetPath = await safeStorePath(resolvedRoot);
    let details;
    try {
      details = await stat(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyStore();
      throw error;
    }
    if (!details.isFile() || details.size > MAX_STORE_BYTES) {
      fail("PORTFOLIO_TOO_LARGE", "持仓文件无效或超过安全上限。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error) {
      fail("PORTFOLIO_CORRUPT", "持仓文件无法解析。", { cause: error?.code || error?.message });
    }
    return validatePersistedStore(parsed);
  }

  async function writeStore(store) {
    const normalized = validatePersistedStore(store);
    const targetPath = await safeStorePath(resolvedRoot);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      fail("PORTFOLIO_TOO_LARGE", "持仓数据超过安全上限。");
    }
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, targetPath);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    return normalized;
  }

  function mutate(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  // 全量列表（含已清仓），供聚合层区分。
  function list() {
    return mutate(async () => clone((await readStore()).positions));
  }

  function add(payload = {}) {
    return mutate(async () => {
      const position = normalizePosition({
        id: randomUUID(),
        code: payload.code,
        name: payload.name,
        shares: payload.shares,
        costPrice: payload.costPrice,
        openedAt: payload.openedAt,
        targetPrice: payload.targetPrice,
        stopPrice: payload.stopPrice,
        note: payload.note,
      });
      const store = await readStore();
      const positions = [...store.positions, position];
      if (positions.length > MAX_POSITIONS) {
        fail("TOO_MANY_POSITIONS", "持仓数量超过安全上限。");
      }
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), positions });
      return clone(position);
    });
  }

  function update(id, patch = {}) {
    return mutate(async () => {
      const store = await readStore();
      const previous = store.positions.find((item) => item.id === id);
      if (!previous) return null;
      // 清仓/重开是补丁字段；数量成本仅在活跃仓上可改。
      const merged = {
        ...previous,
        code: patch.code ?? previous.code,
        name: patch.name !== undefined ? normalizeName(patch.name) : previous.name,
        shares: patch.shares ?? previous.shares,
        costPrice: patch.costPrice ?? previous.costPrice,
        openedAt: patch.openedAt !== undefined ? patch.openedAt : previous.openedAt,
        targetPrice: patch.targetPrice !== undefined ? patch.targetPrice : previous.targetPrice,
        stopPrice: patch.stopPrice !== undefined ? patch.stopPrice : previous.stopPrice,
        note: patch.note !== undefined ? patch.note : previous.note,
        closedAt: patch.closedAt !== undefined ? patch.closedAt : previous.closedAt,
        closedPrice: patch.closedPrice !== undefined ? patch.closedPrice : previous.closedPrice,
      };
      const next = normalizePosition(merged);
      const positions = store.positions.map((item) => (item.id === id ? next : item));
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), positions });
      return clone(next);
    });
  }

  function remove(id) {
    return mutate(async () => {
      const store = await readStore();
      const positions = store.positions.filter((item) => item.id !== id);
      if (positions.length === store.positions.length) return false;
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), positions });
      return true;
    });
  }

  return Object.freeze({ list, add, update, remove });
}
