// 提示词收藏：每条收藏是 vault 里的一个 markdown 文件（10_raw/prompts/）。
// vault 为唯一数据源：dashboard 增删改 = 增删改文件；Obsidian 端改动经 vault-sync 自动刷新。
// 行为约定见 docs/superpowers/specs/2026-08-29-prompt-collection-design.md。

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

import {
  DEFAULT_VAULT_ROOT,
  formatShanghaiDate,
  isPathInside,
  sanitizeFilenamePart,
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

function normalizeTitle(value) {
  const title = String(value ?? "").trim();
  if (!title) fail("INVALID_TITLE", "标题不能为空。");
  if (title.length > MAX_TITLE_LENGTH) fail("INVALID_TITLE", "标题超过 200 字上限。");
  return title;
}

function normalizeContent(value) {
  const content = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!content) fail("INVALID_CONTENT", "提示词正文不能为空。");
  if (content.length > MAX_CONTENT_LENGTH) fail("INVALID_CONTENT", "提示词正文超过 20000 字上限。");
  return content;
}

function normalizeTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("INVALID_TAG", "标签必须是字符串数组。");
  const tags = [];
  for (const raw of value) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) fail("INVALID_TAG", "单个标签超过 32 字上限。");
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) fail("INVALID_TAG", "标签超过 20 个上限。");
  return tags;
}

function normalizeSource(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    fail("INVALID_SOURCE", "来源必须是合法 URL。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("INVALID_SOURCE", "来源必须以 http(s) 开头。");
  }
  return parsed.toString();
}

// gray-matter 的 stringify 负责 YAML 转义（标题可含冒号等特殊字符）。
function renderMarkdown(item) {
  const data = {
    title: item.title,
    tags: item.tags,
    created: item.created,
    updated: item.updated,
  };
  if (item.source) data.source = item.source;
  return matter.stringify(`${item.content}\n`, data);
}

// ID → 文件名。白名单式校验：必须是 10_raw/prompts/ 下的单段 .md 文件名。
function resolveId(id) {
  const value = String(id ?? "");
  const prefix = `${PROMPTS_DIRECTORY}/`;
  if (!value.startsWith(prefix)) fail("INVALID_PROMPT_ID", "提示词 ID 不合法。");
  const fileName = value.slice(prefix.length);
  if (
    !fileName ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    fileName.startsWith(".") ||
    !fileName.endsWith(".md")
  ) {
    fail("INVALID_PROMPT_ID", "提示词 ID 不合法。");
  }
  return fileName;
}

// 原子写新文件：文件名被占用时换下一个后缀；返回实际文件名。
async function writeNewFile(promptsDirectory, baseName, payload) {
  for (let index = 0; index < 100; index += 1) {
    const fileName = index === 0 ? `${baseName}.md` : `${baseName}-${index + 1}.md`;
    const targetPath = path.join(promptsDirectory, fileName);
    const temporaryPath = path.join(
      promptsDirectory,
      `.${fileName}.${randomUUID()}.tmp`,
    );
    let handle = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await lstat(targetPath);
        continue; // 目标已被占用 → 换下一个名字（finally 清理 tmp）
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(temporaryPath, targetPath);
      return fileName;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
    }
  }
  fail("PROMPT_FILE_NAME_EXHAUSTED", "无法生成不冲突的提示词文件名。");
}

// 原子覆盖既有文件（永不重命名）：tmp + rename。
async function overwriteFile(promptsDirectory, fileName, payload) {
  const targetPath = path.join(promptsDirectory, fileName);
  const details = await lstat(targetPath).catch(() => null);
  if (!details || details.isSymbolicLink() || !details.isFile()) {
    fail("PROMPT_NOT_FOUND", "提示词不存在。");
  }
  const temporaryPath = path.join(promptsDirectory, `.${fileName}.${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, targetPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
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

  async function create(input) {
    const realVaultRoot = await resolveVaultRoot(resolvedRoot);
    const promptsDirectory = await ensurePromptsDirectory(realVaultRoot);
    const existing = await readdir(promptsDirectory);
    if (existing.length >= MAX_PROMPT_FILES) {
      fail("TOO_MANY_PROMPTS", "提示词数量超过上限。");
    }
    const timestamp = now();
    const item = {
      title: normalizeTitle(input?.title),
      content: normalizeContent(input?.content),
      tags: normalizeTags(input?.tags),
      source: normalizeSource(input?.source),
      created: formatShanghaiDate(timestamp),
      updated: timestamp.toISOString(),
    };
    const baseName = `${item.created}-${sanitizeFilenamePart(item.title, "prompt")}`;
    const fileName = await writeNewFile(
      promptsDirectory,
      baseName,
      renderMarkdown(item),
    );
    return { ...item, id: `${PROMPTS_DIRECTORY}/${fileName}` };
  }

  async function update(id, input) {
    const realVaultRoot = await resolveVaultRoot(resolvedRoot);
    const promptsDirectory = await ensurePromptsDirectory(realVaultRoot);
    const fileName = resolveId(id);
    const current = await readItem(promptsDirectory, fileName);
    if (!current) fail("PROMPT_NOT_FOUND", "提示词不存在。");
    const item = {
      ...current,
      title: normalizeTitle(input?.title),
      content: normalizeContent(input?.content),
      tags: normalizeTags(input?.tags),
      source: normalizeSource(input?.source),
      updated: now().toISOString(),
    };
    await overwriteFile(promptsDirectory, fileName, renderMarkdown(item));
    return item;
  }

  async function remove(id) {
    const realVaultRoot = await resolveVaultRoot(resolvedRoot);
    const promptsDirectory = await ensurePromptsDirectory(realVaultRoot);
    const fileName = resolveId(id);
    const targetPath = path.join(promptsDirectory, fileName);
    const details = await lstat(targetPath).catch(() => null);
    if (!details || details.isSymbolicLink() || !details.isFile()) {
      fail("PROMPT_NOT_FOUND", "提示词不存在。");
    }
    await unlink(targetPath);
    return { id: `${PROMPTS_DIRECTORY}/${fileName}` };
  }

  return Object.freeze({ list, create, update, remove });
}
