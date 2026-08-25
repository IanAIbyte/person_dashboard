// 每日复盘「AI 每日总结」落盘存储（LLM 任务本身在 stock-analysis 内存态，
// 前端完成后 PUT 到这里持久化）。同 review-events 的安全范式，按 date 覆盖。

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

export const DAILY_REVIEW_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-daily-review.json";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 30;
const MAX_TEXT_LENGTH = 8_000;
const STORE_DIRECTORY = path.posix.dirname(DAILY_REVIEW_PATH);

export class DailyReviewStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DailyReviewStoreError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DailyReviewStoreError(code, message, details);
}

const MAX_LIST_ITEMS = 50;

function normalizeText(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    fail("INVALID_REVIEW_SUMMARY", "总结字段无效或过长。");
  }
  return value.trim() || null;
}

// LLM 输出的 notable/risks/actions 是字符串数组；容忍单个字符串入参。
function normalizeTextList(value) {
  if (value == null || value === "") return null;
  const raw = Array.isArray(value) ? value : [value];
  const items = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      fail("INVALID_REVIEW_SUMMARY", "总结列表项必须是字符串。");
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TEXT_LENGTH) {
      fail("INVALID_REVIEW_SUMMARY", "总结列表项过长。");
    }
    items.push(trimmed);
  }
  if (items.length > MAX_LIST_ITEMS) {
    fail("INVALID_REVIEW_SUMMARY", "总结列表项过多。");
  }
  return items.length ? items : null;
}

// verifications：[{stock, event, type, note}]，字段全部字符串化。
function normalizeVerifications(value) {
  if (value == null || value === "") return null;
  if (!Array.isArray(value)) {
    fail("INVALID_REVIEW_SUMMARY", "verifications 必须是数组。");
  }
  const items = value.slice(0, MAX_LIST_ITEMS).map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const item = {
      stock: typeof entry.stock === "string" ? entry.stock.trim() : "",
      event: typeof entry.event === "string" ? entry.event.trim() : "",
      type: entry.type === "falsify" ? "falsify" : "reinforce",
      note: typeof entry.note === "string" ? entry.note.trim() : "",
    };
    return item.stock || item.event ? item : null;
  }).filter(Boolean);
  return items.length ? items : null;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail("INVALID_REVIEW_DATE", "日期必须是 YYYY-MM-DD。");
  }
  return value;
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object") fail("INVALID_REVIEW_SUMMARY", "总结条目无效。");
  const source = value.review ?? value;
  const overview = normalizeText(source.overview);
  if (!overview) fail("INVALID_REVIEW_SUMMARY", "总结必须包含 overview。");
  const review = { overview };
  for (const key of ["notable", "risks", "actions"]) {
    const list = normalizeTextList(source[key]);
    if (list) review[key] = list;
  }
  const verifications = normalizeVerifications(source.verifications);
  if (verifications) review.verifications = verifications;
  return {
    date: normalizeDate(value.date),
    generatedAt: value.generatedAt ? String(value.generatedAt) : null,
    stockCount: Number.isFinite(Number(value.stockCount)) ? Number(value.stockCount) : null,
    review,
  };
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: null, entries: [] };
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
      fail("UNSAFE_DAILY_REVIEW_DIRECTORY", `${segment} 必须是 Vault 内的真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "每日总结目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

async function safeStorePath(vaultRoot) {
  const directory = await ensureSafeStorageDirectory(vaultRoot);
  const target = path.join(directory, path.posix.basename(DAILY_REVIEW_PATH));
  const realTarget = await realpath(target).catch(() => target);
  if (!isPathInside(directory, realTarget)) {
    fail("SYMLINK_ESCAPE", "每日总结文件必须是 Vault 内的真实文件。");
  }
  return target;
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("DAILY_REVIEW_CORRUPT", "每日总结存储无效。");
  }
  const entries = Array.isArray(value.entries) ? value.entries : [];
  return {
    version: STORE_VERSION,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    entries: entries.map((entry) => normalizeEntry(entry)),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createDailyReviewStore({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, DAILY_REVIEW_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_DAILY_REVIEW", "每日总结路径越出了 Vault。");
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
      fail("DAILY_REVIEW_TOO_LARGE", "每日总结文件无效或超过安全上限。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error) {
      fail("DAILY_REVIEW_CORRUPT", "每日总结文件无法解析。", { cause: error?.code || error?.message });
    }
    return validatePersistedStore(parsed);
  }

  async function writeStore(store) {
    const normalized = validatePersistedStore(store);
    const targetPath = await safeStorePath(resolvedRoot);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      fail("DAILY_REVIEW_TOO_LARGE", "每日总结超过安全上限。");
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

  async function get(date) {
    const store = await mutate(() => readStore());
    const entry = store.entries.find((item) => item.date === normalizeDate(date));
    return entry ? clone(entry) : null;
  }

  function save(date, payload = {}) {
    return mutate(async () => {
      const safeDate = normalizeDate(date);
      const entry = normalizeEntry({
        date: safeDate,
        generatedAt: now().toISOString(),
        stockCount: payload.stockCount ?? null,
        review: payload.review ?? payload,
      });
      const store = await readStore();
      const entries = [
        ...store.entries.filter((item) => item.date !== safeDate),
        entry,
      ]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .slice(-MAX_ENTRIES);
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), entries });
      return clone(entry);
    });
  }

  async function list() {
    const store = await mutate(() => readStore());
    return clone(store.entries);
  }

  return Object.freeze({ get, save, list });
}
