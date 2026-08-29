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

// 重点个股「研究档案」存储。仿 stock-watchlist 的轻量 repository 范式：
// 原子写（tmp + rename）+ mutation 队列 + symlink 逃逸校验。
// 只存结构化研究报告（LLM 生成快照），不存 Obsidian 内容，不写回 Obsidian。

export const STOCK_RESEARCH_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-stock-research.json";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_REPORTS = 200;
const MAX_NAME_LENGTH = 128;
const STORE_DIRECTORY = path.posix.dirname(STOCK_RESEARCH_PATH);

export class StockResearchError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "StockResearchError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new StockResearchError(code, message, details);
}

function normalizeName(value) {
  if (typeof value !== "string") fail("INVALID_STOCK_NAME", "公司名必须是字符串。");
  const result = value.normalize("NFC").trim();
  if (!result || result.length > MAX_NAME_LENGTH) {
    fail("INVALID_STOCK_NAME", "公司名为空或过长。");
  }
  return result;
}

function text(value, maximum) {
  if (typeof value !== "string") return null;
  const result = value.normalize("NFC").trim();
  return result ? result.slice(0, maximum) : null;
}

function textArray(value, maxItems, maxText) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maxText))
    .filter(Boolean)
    .slice(0, maxItems);
}

function number(value, minimum, maximum) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(maximum, Math.max(minimum, n));
}

// 报告为 LLM 输出快照，入库前按字段白名单做防御性规整，丢弃未知字段。
function sanitizeReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_STOCK_RESEARCH_REPORT", "研究报告格式无效。");
  }
  const facts = input.facts ?? {};
  const technicals = input.technicals ?? {};
  const rating = input.rating ?? {};
  const debate = input.debate ?? {};
  const sentiment = input.sentiment ?? {};
  const dimension = (item) => ({
    key: text(item?.key, 32) ?? "unknown",
    label: text(item?.label, 32) ?? "未命名",
    score: number(item?.score, 0, 5),
    weight: number(item?.weight, 0, 1),
    comment: text(item?.comment, 200),
  });
  const stance = (item) => ({
    point: text(item?.point, 240) ?? "（观点缺失）",
    evidence: text(item?.evidence, 240),
  });
  const watch = (item) => ({
    type: item?.type === "falsify" ? "falsify" : "reinforce",
    event: text(item?.event, 240) ?? "（事件缺失）",
    action: text(item?.action, 240),
  });
  return {
    facts: {
      oneLiner: text(facts.oneLiner, 160),
      business: textArray(facts.business, 8, 200),
      industry: text(facts.industry, 120),
      position: text(facts.position, 200),
      limitations: text(facts.limitations, 240),
    },
    technicals: {
      trend: text(technicals.trend, 200),
      signals: textArray(technicals.signals, 8, 200),
      support: textArray(technicals.support, 6, 80),
      resistance: textArray(technicals.resistance, 6, 80),
      dataNote: text(technicals.dataNote, 200),
    },
    rating: {
      dimensions: Array.isArray(rating.dimensions)
        ? rating.dimensions.slice(0, 8).map(dimension)
        : [],
      total: number(rating.total, 0, 5),
      verdict: text(rating.verdict, 24),
      oneLiner: text(rating.oneLiner, 200),
    },
    debate: {
      bulls: Array.isArray(debate.bulls) ? debate.bulls.slice(0, 8).map(stance) : [],
      bears: Array.isArray(debate.bears) ? debate.bears.slice(0, 8).map(stance) : [],
      verifications: textArray(debate.verifications, 8, 240),
    },
    boardroom: Array.isArray(input.boardroom)
      ? input.boardroom.slice(0, 8).map((member) => ({
          name: text(member?.name, 32) ?? "幕僚",
          stance: text(member?.stance, 24),
          view: text(member?.view, 300),
        }))
      : [],
    monitor: Array.isArray(input.monitor) ? input.monitor.slice(0, 12).map(watch) : [],
    sentiment: {
      sentiment: text(sentiment.sentiment, 16),
      score: number(sentiment.score, 1, 5),
      summary: text(sentiment.summary, 200),
    },
  };
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: null, reports: [] };
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
        "UNSAFE_STOCK_RESEARCH_DIRECTORY",
        `${segment} 必须是 Vault 内的真实目录，不能是符号链接。`,
      );
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "研究档案目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

async function safeStorePath(vaultRoot) {
  const directory = await ensureSafeStorageDirectory(vaultRoot);
  const targetPath = path.join(directory, path.posix.basename(STOCK_RESEARCH_PATH));
  try {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      fail("UNSAFE_STOCK_RESEARCH_STORE", "研究档案必须是普通文件，不能是符号链接。");
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
    fail("STOCK_RESEARCH_CORRUPT", "研究档案文件格式无效。");
  }
  if (value.version !== STORE_VERSION || !Array.isArray(value.reports)) {
    fail("STOCK_RESEARCH_CORRUPT", "研究档案文件版本无效。");
  }
  if (value.reports.length > MAX_REPORTS) {
    fail("STOCK_RESEARCH_TOO_LARGE", "研究档案超过安全上限。");
  }
  const seenNames = new Set();
  const reports = value.reports.map((entry) => {
    const name = normalizeName(entry.name);
    if (seenNames.has(name)) {
      fail("STOCK_RESEARCH_CORRUPT", "研究档案存在重复记录。");
    }
    seenNames.add(name);
    return {
      name,
      generatedAt: String(entry.generatedAt || ""),
      report: sanitizeReport(entry.report),
    };
  });
  return {
    version: STORE_VERSION,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    reports,
  };
}

export function createStockResearchRepository({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, STOCK_RESEARCH_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_STOCK_RESEARCH", "研究档案路径越出了 Vault。");
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
      fail("STOCK_RESEARCH_TOO_LARGE", "研究档案文件无效或超过安全上限。");
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error) {
      fail("STOCK_RESEARCH_CORRUPT", "研究档案文件无法解析。", {
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
      fail("STOCK_RESEARCH_TOO_LARGE", "研究档案超过安全上限。");
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

  // 覆盖式保存某股研究报告（同一股只保留最新快照）。
  function save(name, { generatedAt, report } = {}) {
    return mutate(async () => {
      const safeName = normalizeName(name);
      const timestamp = generatedAt ? String(generatedAt) : now().toISOString();
      const next = {
        name: safeName,
        generatedAt: timestamp,
        report: sanitizeReport(report),
      };
      const rest = (await readStore()).reports.filter((entry) => entry.name !== safeName);
      const reports = [next, ...rest].slice(0, MAX_REPORTS);
      const saved = await writeStore({
        version: STORE_VERSION,
        updatedAt: now().toISOString(),
        reports,
      });
      return clone(saved.reports.find((entry) => entry.name === safeName));
    });
  }

  function remove(name) {
    return mutate(async () => {
      const safeName = normalizeName(name);
      const store = await readStore();
      const reports = store.reports.filter((entry) => entry.name !== safeName);
      if (reports.length === store.reports.length) return false;
      await writeStore({ version: STORE_VERSION, updatedAt: now().toISOString(), reports });
      return true;
    });
  }

  return Object.freeze({ list, save, remove });
}
