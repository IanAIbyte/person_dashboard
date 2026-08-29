// 提示词收藏：每条收藏是 vault 里的一个 markdown 文件（10_raw/prompts/）。
// vault 为唯一数据源：dashboard 增删改 = 增删改文件；Obsidian 端改动经 vault-sync 自动刷新。
// 行为约定见 docs/superpowers/specs/2026-08-29-prompt-collection-design.md。

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import {
  DEFAULT_VAULT_ROOT,
  isPathInside,
} from "./security.mjs";

export const PROMPTS_DIRECTORY = "10_raw/prompts";

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 20_000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 32;
const MAX_PROMPT_FILES = 5_000;

export class PromptCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PromptCollectionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PromptCollectionError(code, message);
}

async function resolveVaultRoot(vaultRoot) {
  const requestedRoot = path.resolve(vaultRoot);
  let resolved;
  try {
    resolved = await realpath(requestedRoot);
  } catch {
    fail("INVALID_VAULT", "Vault 不存在或不可访问。");
  }
  const details = await stat(resolved);
  if (!details.isDirectory()) fail("INVALID_VAULT", "Vault 不是目录。");
  return resolved;
}

async function ensurePromptsDirectory(realVaultRoot) {
  let parent = realVaultRoot;
  for (const segment of PROMPTS_DIRECTORY.split("/")) {
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
      fail("UNSAFE_PROMPTS_DIRECTORY", `${segment} 必须是 Vault 内的真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "提示词目录越出了 Vault。");
    }
    parent = resolved;
  }
  return parent;
}

// js-yaml 会把无引号的 frontmatter 日期解析成 Date（如 `created: 2026-08-01`）。
// 还原成字符串：纯日期回 YYYY-MM-DD（与 social-insights normalizeDate 一致），带时间的保留完整 ISO。
function normalizeDate(value) {
  if (typeof value === "string") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  return "";
}

// 解析单个 .md → 条目。宽容：缺 frontmatter/缺 title 不炸，title 回退文件名。
async function readItem(promptsDirectory, fileName) {
  const absolutePath = path.join(promptsDirectory, fileName);
  const details = await lstat(absolutePath).catch(() => null);
  if (!details || details.isSymbolicLink() || !details.isFile()) return null;
  const raw = await readFile(absolutePath, "utf8").catch(() => null);
  if (raw == null) return null;

  let data = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
      data = parsed.data;
    }
    body = parsed.content;
  } catch {
    // frontmatter 损坏：剥掉文件头部的 --- 块后按纯正文处理。
    body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  }

  const content = String(body ?? "").replace(/\r\n/g, "\n").trim();
  const baseName = fileName.replace(/\.md$/, "");
  const title =
    typeof data.title === "string" && data.title.trim() ? data.title.trim() : baseName;
  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag) => String(tag ?? "").trim()).filter(Boolean)
    : [];
  return {
    id: `${PROMPTS_DIRECTORY}/${fileName}`,
    title,
    tags,
    source: typeof data.source === "string" ? data.source.trim() : "",
    created: normalizeDate(data.created),
    updated: normalizeDate(data.updated),
    content,
  };
}

export function createPromptCollectionRepository({
  vaultRoot = DEFAULT_VAULT_ROOT,
  now = () => new Date(),
} = {}) {
  const resolvedRoot = path.resolve(vaultRoot);

  async function list() {
    const realVaultRoot = await resolveVaultRoot(resolvedRoot);
    const promptsDirectory = await ensurePromptsDirectory(realVaultRoot);
    const entries = await readdir(promptsDirectory, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
      const item = await readItem(promptsDirectory, entry.name);
      if (item) items.push(item);
    }
    items.sort(
      (a, b) =>
        String(b.updated).localeCompare(String(a.updated)) || a.id.localeCompare(b.id),
    );
    const counts = new Map();
    for (const item of items) {
      for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    const tags = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .map(([name]) => name);
    return { items, tags };
  }

  return Object.freeze({ list });
}
