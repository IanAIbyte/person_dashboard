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
import { defaultPoolStocks } from "./stock-universe.mjs";

// 股票池：默认池（stock-universe 常量）+ 自选池（用户自由增删，任意 A 股）。
// 自选池存 vault 内 json（原子写 + mutation 队列，仿 stock-watchlist 范式）。
// 自选股字段：name/code 必填，chain/board/segment/note 可选（用户手填）。

export const STOCK_POOL_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-stock-pool.json";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_NAME_LENGTH = 128;
const STORE_DIRECTORY = path.posix.dirname(STOCK_POOL_PATH);

export class StockPoolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StockPoolError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new StockPoolError(code, message, details);
}

function normalizeText(value, label, maximum = 128, required = false) {
  if (value == null || value === "") {
    if (required) fail(`INVALID_STOCK_POOL_${label}`, `${label}不能为空。`);
    return null;
  }
  if (typeof value !== "string") fail(`INVALID_STOCK_POOL_${label}`, `${label}必须是字符串。`);
  const result = value.normalize("NFC").trim();
  if (!result || result.length > maximum) {
    fail(`INVALID_STOCK_POOL_${label}`, `${label}为空或过长。`);
  }
  return result;
}

function normalizeCode(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{6}$/.test(value.trim())) {
    fail("INVALID_STOCK_POOL_CODE", "股票代码必须是 6 位数字。");
  }
  return value.trim();
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: null, items: [] };
}

async function ensureSafeStorageDirectory(vaultRoot) {
  let realVaultRoot;
  try {
    realVaultRoot = await realpath(path.resolve(vaultRoot));
  } catch (error) {
    fail("INVALID_VAULT", "Vault 不存在或不可访问。", { cause: error?.code });
  }
  const rootDetails = await stat(realVaultRoot);
  if (!rootDetails.isDirectory()) fail("INVALID_VAULT", "Vault 不是目录。");

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
      fail("UNSAFE_STOCK_POOL_DIRECTORY", `${segment} 必须是真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "自选池目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

async function safeStorePath(vaultRoot) {
  const directory = await ensureSafeStorageDirectory(vaultRoot);
  const targetPath = path.join(directory, path.posix.basename(STOCK_POOL_PATH));
  try {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      fail("UNSAFE_STOCK_POOL_STORE", "自选池必须是普通文件。");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return targetPath;
}

function clone(value) {
  return structuredClone(value);
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("STOCK_POOL_CORRUPT", "自选池文件格式无效。");
  }
  if (value.version !== STORE_VERSION || !Array.isArray(value.items)) {
    fail("STOCK_POOL_CORRUPT", "自选池文件版本无效。");
  }
  if (value.items.length > MAX_ITEMS) {
    fail("STOCK_POOL_TOO_LARGE", "自选池超过安全上限。");
  }
  const seenNames = new Set();
  const items = value.items.map((item) => ({
    name: normalizeText(item.name, "NAME", MAX_NAME_LENGTH, true),
    code: normalizeCode(item.code),
    chain: normalizeText(item.chain, "CHAIN"),
    board: normalizeText(item.board, "BOARD"),
    segment: normalizeText(item.segment, "SEGMENT"),
    note: normalizeText(item.note, "NOTE", 500),
    addedAt: String(item.addedAt || ""),
  }));
  for (const item of items) {
    if (seenNames.has(item.name)) {
      fail("STOCK_POOL_CORRUPT", "自选池存在重复公司名。");
    }
    seenNames.add(item.name);
  }
  return {
    version: STORE_VERSION,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    items,
  };
}

export function createStockPoolRepository({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, STOCK_POOL_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_STOCK_POOL", "自选池路径越出了 Vault。");
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
      fail("STOCK_POOL_TOO_LARGE", "自选池文件无效或超过安全上限。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error) {
      fail("STOCK_POOL_CORRUPT", "自选池文件无法解析。", {
        cause: error?.code || error.message,
      });
    }
    return validatePersistedStore(parsed);
  }

  async function writeStore(store) {
    const normalized = validatePersistedStore(store);
    const targetPath = await safeStorePath(resolvedRoot);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      fail("STOCK_POOL_TOO_LARGE", "自选池超过安全上限。");
    }
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await safeStorePath(resolvedRoot);
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

  async function listCustom() {
    return clone(await readStore());
  }

  function addCustom(input) {
    return mutate(async () => {
      const item = {
        name: normalizeText(input?.name, "NAME", MAX_NAME_LENGTH, true),
        code: normalizeCode(input?.code),
        chain: normalizeText(input?.chain, "CHAIN"),
        board: normalizeText(input?.board, "BOARD"),
        segment: normalizeText(input?.segment, "SEGMENT"),
        note: normalizeText(input?.note, "NOTE", 500),
        addedAt: now().toISOString(),
      };
      if (!item.code) fail("INVALID_STOCK_POOL_CODE", "自选股必须提供 6 位代码。");
      const store = await readStore();
      if (store.items.some((x) => x.name === item.name || (item.code && x.code === item.code))) {
        fail("STOCK_POOL_DUPLICATE", "该公司（名称或代码）已在自选池。");
      }
      const items = [item, ...store.items];
      if (items.length > MAX_ITEMS) fail("STOCK_POOL_TOO_LARGE", "自选池超过安全上限。");
      const timestamp = now().toISOString();
      const saved = await writeStore({ version: STORE_VERSION, updatedAt: timestamp, items });
      return clone(saved.items[0]);
    });
  }

  function removeCustom(name) {
    return mutate(async () => {
      const safeName = normalizeText(name, "NAME", MAX_NAME_LENGTH, true);
      const store = await readStore();
      const items = store.items.filter((item) => item.name !== safeName);
      if (items.length === store.items.length) return false;
      const timestamp = now().toISOString();
      await writeStore({ version: STORE_VERSION, updatedAt: timestamp, items });
      return true;
    });
  }

  // 完整股票池 = 默认池 + 自选池（去重：自选池公司名若与默认池重名则跳过）。
  async function pool(codeOverrides = {}) {
    const defaults = defaultPoolStocks(codeOverrides);
    const store = await readStore();
    const defaultNames = new Set(defaults.map((s) => s.name));
    const customs = store.items
      .filter((item) => !defaultNames.has(item.name))
      .map((item) => ({
        name: item.name,
        note: item.note ?? "",
        code: item.code,
        board: item.board,
        segment: item.segment,
        chainKey: item.chain,
        chainLabel: item.chain,
        hasEntityPage: false,
        entityPageId: null,
        custom: true,
      }));
    return [...defaults, ...customs];
  }

  return Object.freeze({ listCustom, addCustom, removeCustom, pool });
}
