// 「AI 每日总结」自动生成调度配置：独立于盯盘配置，互不混淆。
// { enabled, time("HH:mm") }，交易日到点后由 dev server 调度器触发一次。

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

export const REVIEW_SCHEDULE_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-review-schedule.json";

const STORE_DIRECTORY = path.posix.dirname(REVIEW_SCHEDULE_PATH);

export const DEFAULT_REVIEW_SCHEDULE = { enabled: true, time: "15:05" };

export class ReviewScheduleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReviewScheduleError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReviewScheduleError(code, message);
}

export function normalizeSchedule(value) {
  const enabled = value?.enabled == null ? true : Boolean(value.enabled);
  const raw = String(value?.time ?? DEFAULT_REVIEW_SCHEDULE.time).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    fail("INVALID_REVIEW_SCHEDULE", "时间必须是 HH:mm（00:00-23:59）。");
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) {
    fail("INVALID_REVIEW_SCHEDULE", "时间超出 00:00-23:59 范围。");
  }
  return { enabled, time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}

async function safeStorePath(vaultRoot) {
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
      fail("UNSAFE_REVIEW_SCHEDULE_DIRECTORY", `${segment} 必须是 Vault 内的真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "调度配置目录越出了 Vault。");
    }
    parent = resolved;
  }
  const target = path.join(parent, path.posix.basename(REVIEW_SCHEDULE_PATH));
  const realTarget = await realpath(target).catch(() => target);
  if (!isPathInside(parent, realTarget)) {
    fail("SYMLINK_ESCAPE", "调度配置文件必须是 Vault 内的真实文件。");
  }
  return target;
}

export function createReviewScheduleRepository({ vaultRoot = DEFAULT_VAULT_ROOT } = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, REVIEW_SCHEDULE_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_REVIEW_SCHEDULE", "调度配置路径越出了 Vault。");
  }

  // 文件缺失/损坏 → 默认值（每天 15:05）。
  async function get() {
    try {
      const raw = JSON.parse(await readFile(await safeStorePath(resolvedRoot), "utf8"));
      return { ...normalizeSchedule(raw), customized: true };
    } catch (error) {
      if (error instanceof ReviewScheduleError) throw error;
      return { ...DEFAULT_REVIEW_SCHEDULE, customized: false };
    }
  }

  async function save(patch = {}) {
    const current = await get();
    const next = normalizeSchedule({
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
      time: patch.time === undefined ? current.time : patch.time,
    });
    const target = await safeStorePath(resolvedRoot);
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), ...next }, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, target);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    return { ...next, customized: true };
  }

  return Object.freeze({ get, save });
}
