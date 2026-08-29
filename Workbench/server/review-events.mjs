// 每日复盘「手动补录事件」存储。镜像 stock-watchlist 的 repository 范式：
// 原子写（tmp + rename）+ mutation 队列 + symlink 逃逸校验。
// 不存 Obsidian 内容，不写回 Obsidian 笔记本体。

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

export const REVIEW_EVENTS_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-review-events.json";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;
const TONES = new Set(["info", "up", "down", "note"]);
const STORE_DIRECTORY = path.posix.dirname(REVIEW_EVENTS_PATH);

export class ReviewEventsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReviewEventsError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ReviewEventsError(code, message, details);
}

function normalizeTitle(value) {
  if (typeof value !== "string") fail("INVALID_REVIEW_EVENT", "事件标题必须是字符串。");
  const result = value.normalize("NFC").trim();
  if (!result || result.length > MAX_TITLE_LENGTH) {
    fail("INVALID_REVIEW_EVENT", "事件标题为空或超过 200 字。");
  }
  return result;
}

function normalizeNote(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_NOTE_LENGTH) {
    fail("INVALID_REVIEW_EVENT", "事件备注无效或超过 2000 字。");
  }
  return value.normalize("NFC").trim() || null;
}

function normalizeTone(value) {
  if (value == null || value === "") return "info";
  if (!TONES.has(value)) fail("INVALID_REVIEW_EVENT", "tone 只支持 info/up/down/note。");
  return value;
}

function normalizeTimestamp(value, now) {
  if (value == null || value === "") return now.toISOString();
  const parsed = typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(parsed)) fail("INVALID_REVIEW_EVENT", "事件时间无效。");
  return new Date(parsed).toISOString();
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
      fail("UNSAFE_REVIEW_EVENTS_DIRECTORY", `${segment} 必须是 Vault 内的真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "复盘事件目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

async function safeStorePath(vaultRoot) {
  const directory = await ensureSafeStorageDirectory(vaultRoot);
  const target = path.join(directory, path.posix.basename(REVIEW_EVENTS_PATH));
  const realTarget = await realpath(target).catch(() => target);
  if (!isPathInside(directory, realTarget)) {
    fail("SYMLINK_ESCAPE", "复盘事件文件必须是 Vault 内的真实文件。");
  }
  return target;
}

function validatePersistedStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("REVIEW_EVENTS_CORRUPT", "复盘事件存储无效。");
  }
  const items = Array.isArray(value.items) ? value.items : [];
  return {
    version: STORE_VERSION,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    items: items.map((item) => ({
      id: String(item.id || randomUUID()),
      ts: normalizeTimestamp(item.ts, new Date(0)),
      title: String(item.title || "未命名事件"),
      note: item.note == null ? null : String(item.note),
      tone: TONES.has(item.tone) ? item.tone : "info",
    })),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createReviewEventsRepository({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, REVIEW_EVENTS_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_REVIEW_EVENTS", "复盘事件路径越出了 Vault。");
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
      fail("REVIEW_EVENTS_TOO_LARGE", "复盘事件文件无效或超过安全上限。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error) {
      fail("REVIEW_EVENTS_CORRUPT", "复盘事件文件无法解析。", { cause: error?.code || error?.message });
    }
    return validatePersistedStore(parsed);
  }

  async function writeStore(store) {
    const normalized = validatePersistedStore(store);
    const targetPath = await safeStorePath(resolvedRoot);
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_STORE_BYTES) {
      fail("REVIEW_EVENTS_TOO_LARGE", "复盘事件超过安全上限。");
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

  function list({ date = null } = {}) {
    return mutate(async () => {
      const store = await readStore();
      const items = date
        ? store.items.filter((item) => item.ts.slice(0, 10) === date)
        : store.items;
      return clone(items);
    });
  }

  function add(payload = {}) {
    return mutate(async () => {
      const timestamp = now().toISOString();
      const event = {
        id: randomUUID(),
        ts: normalizeTimestamp(payload.ts, now()),
        title: normalizeTitle(payload.title),
        note: normalizeNote(payload.note),
        tone: normalizeTone(payload.tone),
      };
      const store = await readStore();
      const items = [...store.items, event].slice(-MAX_ITEMS);
      await writeStore({ version: STORE_VERSION, updatedAt: timestamp, items });
      return clone(event);
    });
  }

  function update(id, patch = {}) {
    return mutate(async () => {
      const store = await readStore();
      const previous = store.items.find((item) => item.id === id);
      if (!previous) return null;
      const next = {
        ...previous,
        ts: patch.ts != null ? normalizeTimestamp(patch.ts, now()) : previous.ts,
        title: patch.title != null ? normalizeTitle(patch.title) : previous.title,
        note: patch.note !== undefined ? normalizeNote(patch.note) : previous.note,
        tone: patch.tone != null ? normalizeTone(patch.tone) : previous.tone,
      };
      const items = store.items.map((item) => (item.id === id ? next : item));
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), items });
      return clone(next);
    });
  }

  function remove(id) {
    return mutate(async () => {
      const store = await readStore();
      const items = store.items.filter((item) => item.id !== id);
      if (items.length === store.items.length) return false;
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), items });
      return true;
    });
  }

  return Object.freeze({ list, add, update, remove });
}
