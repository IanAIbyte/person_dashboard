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

// 重点个股「关注」状态存储。仿 material-reading-state 的轻量 repository 范式：
// 原子写（tmp + rename）+ mutation 队列 + symlink 逃逸校验。
// 只存公司名（code 可为 null），不存 Obsidian 内容，不写回 Obsidian。

export const STOCK_WATCHLIST_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-stock-watchlist.json";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 5_000;
const MAX_NAME_LENGTH = 128;
const STORE_DIRECTORY = path.posix.dirname(STOCK_WATCHLIST_PATH);

export class StockWatchlistError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StockWatchlistError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new StockWatchlistError(code, message, details);
}

function normalizeName(value) {
  if (typeof value !== "string") fail("INVALID_STOCK_NAME", "公司名必须是字符串。");
  const result = value.normalize("NFC").trim();
  if (!result || result.length > MAX_NAME_LENGTH) {
    fail("INVALID_STOCK_NAME", "公司名为空或过长。");
  }
  return result;
}

function normalizeOptional(value, maximum = 200) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) {
    fail("INVALID_STOCK_META", "关注元数据字段无效。");
  }
  return value.normalize("NFC").trim() || null;
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
      fail(
        "UNSAFE_STOCK_WATCHLIST_DIRECTORY",
        `${segment} 必须是 Vault 内的真实目录，不能是符号链接。`,
      );
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "关注状态目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

async function safeStorePath(vaultRoot) {
  const directory = await ensureSafeStorageDirectory(vaultRoot);
  const targetPath = path.join(directory, path.posix.basename(STOCK_WATCHLIST_PATH));
  try {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      fail("UNSAFE_STOCK_WATCHLIST_STORE", "关注状态必须是普通文件，不能是符号链接。");
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
    fail("STOCK_WATCHLIST_CORRUPT", "关注状态文件格式无效。");
  }
  if (value.version !== STORE_VERSION || !Array.isArray(value.items)) {
    fail("STOCK_WATCHLIST_CORRUPT", "关注状态文件版本无效。");
  }
  if (value.items.length > MAX_ITEMS) {
    fail("STOCK_WATCHLIST_TOO_LARGE", "关注记录超过安全上限。");
  }
  const seenNames = new Set();
  const items = value.items.map((item) => {
    const name = normalizeName(item.name);
    if (seenNames.has(name)) {
      fail("STOCK_WATCHLIST_CORRUPT", "关注状态存在重复记录。");
    }
    seenNames.add(name);
    return {
      name,
      group: normalizeOptional(item.group),
      note: normalizeOptional(item.note),
      addedAt: String(item.addedAt || ""),
    };
  });
  return {
    version: STORE_VERSION,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    items,
  };
}

export function createStockWatchlistRepository({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, STOCK_WATCHLIST_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_STOCK_WATCHLIST", "关注状态路径越出了 Vault。");
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
      fail("STOCK_WATCHLIST_TOO_LARGE", "关注状态文件无效或超过安全上限。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error) {
      fail("STOCK_WATCHLIST_CORRUPT", "关注状态文件无法解析。", {
        cause: error?.code || error?.message,
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
      fail("STOCK_WATCHLIST_TOO_LARGE", "关注状态超过安全上限。");
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

  async function list() {
    return clone(await readStore());
  }

  function add(name, meta = {}) {
    return mutate(async () => {
      const safeName = normalizeName(name);
      const timestamp = now().toISOString();
      const store = await readStore();
      const previous = store.items.find((item) => item.name === safeName);
      const next = {
        name: safeName,
        group: normalizeOptional(meta.group ?? previous?.group),
        note: normalizeOptional(meta.note ?? previous?.note),
        addedAt: previous?.addedAt || timestamp,
      };
      const items = [
        next,
        ...store.items.filter((item) => item.name !== safeName),
      ];
      if (items.length > MAX_ITEMS) {
        fail("TOO_MANY_STOCK_WATCHLIST_ITEMS", "关注记录超过安全上限。");
      }
      const saved = await writeStore({ version: STORE_VERSION, updatedAt: timestamp, items });
      return clone(saved.items[0]);
    });
  }

  function remove(name) {
    return mutate(async () => {
      const safeName = normalizeName(name);
      const store = await readStore();
      const items = store.items.filter((item) => item.name !== safeName);
      if (items.length === store.items.length) return false;
      const timestamp = now().toISOString();
      await writeStore({ version: STORE_VERSION, updatedAt: timestamp, items });
      return true;
    });
  }

  // 更新某关注股的 group/note（不改变 addedAt）。
  function updateMeta(name, meta = {}) {
    return mutate(async () => {
      const safeName = normalizeName(name);
      const store = await readStore();
      const previous = store.items.find((item) => item.name === safeName);
      if (!previous) return null;
      const next = {
        ...previous,
        group: normalizeOptional(meta.group ?? previous.group),
        note: normalizeOptional(meta.note ?? previous.note),
      };
      const items = store.items.map((item) => (item.name === safeName ? next : item));
      const timestamp = now().toISOString();
      const saved = await writeStore({ version: STORE_VERSION, updatedAt: timestamp, items });
      return clone(saved.items.find((item) => item.name === safeName));
    });
  }

  return Object.freeze({ list, add, remove, updateMeta });
}
