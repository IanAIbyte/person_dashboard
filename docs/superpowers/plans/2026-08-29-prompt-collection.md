# 提示词收藏（Prompt Collection）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作台「提示词」页新增「我的收藏」分区：每条收藏是 vault 中 `10_raw/prompts/` 下的一个 markdown 文件，dashboard 与 Obsidian 双向实时同步。

**Architecture:** vault 为唯一数据源。新建服务端 repository 模块 `prompt-collection.mjs`（仿 `coach-prompt.mjs` 的安全模式），在 `vite-plugin-workbench.mjs` 挂 4 个端点，写后 `vaultSync.notifyPaths` 触发索引刷新；前端在 `PromptsLibraryPage` 加「我的收藏 | 公开模板」双 tab，收藏面板抽成独立组件。Obsidian 端改动经既有 `App.jsx` 的 `useVaultSync`（`10_raw/*` → `overview` scope → `<Routes key={revision}>` 重挂载 → 页面重新挂载时重新拉取）自动生效，**前端无需新增同步代码**。

**Tech Stack:** Node 20 ESM + vite 中间件 API（服务端）、node:test（测试）、React 18 + 原生 CSS（前端）、gray-matter（frontmatter 解析/序列化）。

**设计文档:** `docs/superpowers/specs/2026-08-29-prompt-collection-design.md`

## Global Constraints

- 数据目录硬编码 `10_raw/prompts/`；每条收藏一个 `.md` 文件；文件名 `YYYY-MM-DD-<slug>.md`（上海时区 + `sanitizeFilenamePart`），重名追加 `-2`、`-3` 后缀。
- frontmatter 键：`title`（必填 ≤200 字）、`tags`（≤20 个、每个 ≤32 字、去重保序）、`source`（http(s) URL 或不写该键）、`created`（YYYY-MM-DD）、`updated`（ISO）；正文 = 提示词原文，原样保存不做加工。
- ID = vault 内相对 posix 路径（`10_raw/prompts/<file>.md`）；`update()` 永不重命名文件（ID 稳定，Obsidian 双链不断）。
- 冲突策略 last-write-wins；本地单人使用，无字段级合并。
- 错误码：`INVALID_TITLE` / `INVALID_CONTENT` / `INVALID_TAG` / `INVALID_SOURCE` / `INVALID_PROMPT_ID` / `INVALID_PROMPT_REQUEST` → 400；`PROMPT_NOT_FOUND` → 404；`SYMLINK_ESCAPE` / `UNSAFE_PROMPTS_DIRECTORY` → 500（全局 `errorStatus` 已按前缀自动映射，端点内不必手工映射）。
- 公开模板库（`prompts-library.mjs`、现有搜索/优化功能）一行不动。
- 提交信息用仓库现有风格：`<type>: 中文描述`（type: feat/fix/test/docs/chore），不加 attribution 尾注。
- 测试命令：全量 `npm test`（含 build，较慢）；定向 `node --test --test-concurrency=1 tests/prompt-collection.test.mjs`（在 `Workbench/` 目录下执行）。
- 工作目录：所有文件路径相对 `/Volumes/Data/Github/person_dashboard/`。

---

### Task 1: 服务端模块 — 读取路径（list + 解析容错）

**Files:**
- Create: `Workbench/server/prompt-collection.mjs`
- Test: `Workbench/tests/prompt-collection.test.mjs`

**Interfaces:**
- Consumes: `security.mjs` 的 `DEFAULT_VAULT_ROOT`、`isPathInside(parent, candidate)`、`sanitizeFilenamePart(value, fallback)`、`formatShanghaiDate(date)`。
- Produces（后续任务依赖的准确签名）:
  - `PROMPTS_DIRECTORY = "10_raw/prompts"`（常量）
  - `class PromptCollectionError extends Error`，带 `code` 属性
  - `createPromptCollectionRepository({ vaultRoot = DEFAULT_VAULT_ROOT, now = () => new Date() })` → `{ list, create, update, remove }`
  - `list()` → `Promise<{ items: Array<{ id, title, tags, source, created, updated, content }>, tags: string[] }>`；`id` 形如 `"10_raw/prompts/2026-08-29-xxx.md"`；按 `updated` 倒序；`tags` 按出现次数降序、同次数按中文名升序，去重。

- [ ] **Step 1: 写失败测试（读取路径）**

创建 `Workbench/tests/prompt-collection.test.mjs`：

```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROMPTS_DIRECTORY,
  PromptCollectionError,
  createPromptCollectionRepository,
} from "../server/prompt-collection.mjs";

async function makeVault(t) {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-prompt-collection-"));
  await mkdir(path.join(vaultRoot, "10_raw", "articles"), { recursive: true });
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  return vaultRoot;
}

test("list 返回空集合与空标签（目录不存在时自动创建）", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createPromptCollectionRepository({ vaultRoot });
  assert.deepEqual(await repository.list(), { items: [], tags: [] });
  // 目录已被自动创建
  const dir = await readFile(path.join(vaultRoot, PROMPTS_DIRECTORY), "utf8").then(
    () => "file",
    () => "dir",
  );
  assert.equal(dir, "dir");
});

test("list 解析 Obsidian 手写的 markdown 文件，缺失字段兜底", async (t) => {
  const vaultRoot = await makeVault(t);
  await mkdir(path.join(vaultRoot, "10_raw", "prompts"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "10_raw", "prompts", "2026-08-01-代码审查.md"),
    `---
title: 代码审查提示词
tags:
  - 代码
  - review
source: https://example.com/post
created: 2026-08-01
updated: 2026-08-01T00:00:00.000Z
---

请审查以下代码，关注边界条件。
`,
    "utf8",
  );
  // 手写坏文件：缺 frontmatter、缺 title → 不炸列表，title 回退文件名
  await writeFile(
    path.join(vaultRoot, "10_raw", "prompts", "2026-08-02-broken.md"),
    "只有正文，没有 frontmatter。\n",
    "utf8",
  );
  // 非 md 与点文件跳过
  await writeFile(path.join(vaultRoot, "10_raw", "prompts", "notes.txt"), "skip", "utf8");
  await writeFile(path.join(vaultRoot, "10_raw", "prompts", ".hidden.md"), "skip", "utf8");

  const repository = createPromptCollectionRepository({ vaultRoot });
  const { items, tags } = await repository.list();
  assert.equal(items.length, 2);
  const good = items.find((item) => item.id.endsWith("代码审查.md"));
  assert.equal(good.title, "代码审查提示词");
  assert.deepEqual(good.tags, ["代码", "review"]);
  assert.equal(good.source, "https://example.com/post");
  assert.equal(good.created, "2026-08-01");
  assert.ok(good.content.includes("请审查以下代码"));
  const broken = items.find((item) => item.id.endsWith("broken.md"));
  assert.equal(broken.title, "2026-08-02-broken");
  assert.deepEqual(broken.tags, []);
  assert.deepEqual(tags, ["代码", "review"]);
});

test("list 按 updated 倒序、id 升序稳定排序", async (t) => {
  const vaultRoot = await makeVault(t);
  await mkdir(path.join(vaultRoot, "10_raw", "prompts"), { recursive: true });
  const fixtures = [
    ["b.md", "2026-08-02T00:00:00.000Z"],
    ["a.md", "2026-08-02T00:00:00.000Z"],
    ["c.md", "2026-08-01T00:00:00.000Z"],
  ];
  for (const [name, updated] of fixtures) {
    await writeFile(
      path.join(vaultRoot, "10_raw", "prompts", name),
      `---\nupdated: ${updated}\n---\n\n正文 ${name}\n`,
      "utf8",
    );
  }
  const repository = createPromptCollectionRepository({ vaultRoot });
  const { items } = await repository.list();
  assert.deepEqual(
    items.map((item) => item.id),
    ["10_raw/prompts/a.md", "10_raw/prompts/b.md", "10_raw/prompts/c.md"],
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: FAIL —— `Cannot find module '../server/prompt-collection.mjs'`

- [ ] **Step 3: 写最小实现（模块骨架 + list）**

创建 `Workbench/server/prompt-collection.mjs`：

```js
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
  } catch (error) {
    fail("INVALID_VAULT", "Vault 不存在或不可访问。", { cause: error?.code });
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
    created: typeof data.created === "string" ? data.created : "",
    updated: typeof data.updated === "string" ? data.updated : "",
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
```

注意：`fail` 里第二个参数 `details` 并未在 `fail` 签名中 —— 把 `resolveVaultRoot` 的 catch 简化为 `fail("INVALID_VAULT", "Vault 不存在或不可访问。");`（与 coach-prompt 一致，不传 details）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Data/Github/person_dashboard
git add Workbench/server/prompt-collection.mjs Workbench/tests/prompt-collection.test.mjs
git commit -m "feat: 提示词收藏 - 服务端模块读取路径(扫目录+frontmatter解析容错)"
```

---

### Task 2: 服务端模块 — 写入路径（create + update）

**Files:**
- Modify: `Workbench/server/prompt-collection.mjs`
- Test: `Workbench/tests/prompt-collection.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 的模块骨架；新增 import `open, rename, unlink`（from `node:fs/promises`）、`formatShanghaiDate, sanitizeFilenamePart`（from `./security.mjs`）。
- Produces:
  - `create({ title, content, tags?, source? })` → Promise\<item\>（含 `id`）；文件名 `${formatShanghaiDate(now)}-${sanitizeFilenamePart(title)}.md`，占用则追加 `-2`、`-3`…后缀（至多 100 次，耗尽抛 `PROMPT_FILE_NAME_EXHAUSTED`）；目录内 `.md` 文件数 ≥5000 时抛 `TOO_MANY_PROMPTS`。
  - `update(id, { title, content, tags, source })` → Promise\<item\>；**不重命名文件**；`created` 保持原值，`updated` 刷新为 `now().toISOString()`；文件不存在抛 `PROMPT_NOT_FOUND`。
  - 校验：title 必填 ≤200；content 必填 ≤20000（`\r\n` 归一为 `\n`）；tags 数组 ≤20 个每个 ≤32 字去重保序；source 空 或 http(s) URL（`INVALID_TITLE`/`INVALID_CONTENT`/`INVALID_TAG`/`INVALID_SOURCE`）。
  - 写盘为原子写：`.tmp`（`wx` + 0o600）+ `fsync` + `rename`，finally 清理 tmp。

- [ ] **Step 1: 追加失败测试（写入路径）**

在 `Workbench/tests/prompt-collection.test.mjs` 追加：

```js
test("create 写出带 frontmatter 的 md，字段可往返解析，重名自动加后缀", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createPromptCollectionRepository({
    vaultRoot,
    now: () => new Date("2026-08-29T06:30:00.000Z"),
  });

  const created = await repository.create({
    title: "周报生成",
    content: "帮我基于以下流水生成周报：\n1. ……",
    tags: ["写作", "周报"],
    source: "https://example.com/a",
  });
  assert.equal(created.id, "10_raw/prompts/2026-08-29-周报生成.md");
  assert.equal(created.created, "2026-08-29"); // 上海时区日期
  assert.equal(created.updated, "2026-08-29T06:30:00.000Z");

  const raw = await readFile(
    path.join(vaultRoot, "10_raw", "prompts", "2026-08-29-周报生成.md"),
    "utf8",
  );
  assert.ok(raw.startsWith("---\n"));
  const parsed = await repository.list();
  const item = parsed.items.find((entry) => entry.id === created.id);
  assert.equal(item.title, "周报生成");
  assert.deepEqual(item.tags, ["写作", "周报"]);
  assert.equal(item.source, "https://example.com/a");
  assert.ok(item.content.includes("帮我基于以下流水生成周报"));

  // 同名再建 → -2 后缀
  const second = await repository.create({ title: "周报生成", content: "b" });
  assert.equal(second.id, "10_raw/prompts/2026-08-29-周报生成-2.md");
  // 无 source 时不写该键
  assert.equal(second.source, "");
  assert.ok(!raw.includes("source:") || second.id !== created.id);
  const secondRaw = await readFile(
    path.join(vaultRoot, "10_raw", "prompts", "2026-08-29-周报生成-2.md"),
    "utf8",
  );
  assert.ok(!secondRaw.includes("source:"));
});

test("create 校验非法输入", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createPromptCollectionRepository({ vaultRoot });
  await assert.rejects(
    repository.create({ title: "", content: "x" }),
    (error) => error instanceof PromptCollectionError && error.code === "INVALID_TITLE",
  );
  await assert.rejects(
    repository.create({ title: "t", content: "  " }),
    (error) => error instanceof PromptCollectionError && error.code === "INVALID_CONTENT",
  );
  await assert.rejects(
    repository.create({ title: "t", content: "x", tags: "写作" }),
    (error) => error instanceof PromptCollectionError && error.code === "INVALID_TAG",
  );
  await assert.rejects(
    repository.create({ title: "t", content: "x", source: "ftp://a" }),
    (error) => error instanceof PromptCollectionError && error.code === "INVALID_SOURCE",
  );
});

test("update 原地覆盖内容但保持文件名与 created 不变", async (t) => {
  const vaultRoot = await makeVault(t);
  let clock = 0;
  const times = [
    new Date("2026-08-29T06:00:00.000Z"),
    new Date("2026-08-30T08:00:00.000Z"),
  ];
  const repository = createPromptCollectionRepository({ vaultRoot, now: () => times[clock++] });

  const created = await repository.create({ title: "初稿", content: "v1", tags: ["a"] });
  const updated = await repository.update(created.id, {
    title: "改名字",
    content: "v2",
    tags: ["b", "c"],
    source: "https://example.com/b",
  });
  assert.equal(updated.id, created.id); // 不重命名
  assert.equal(updated.title, "改名字");
  assert.equal(updated.created, "2026-08-29"); // created 保留
  assert.equal(updated.updated, "2026-08-30T08:00:00.000Z");

  const raw = await readFile(path.join(vaultRoot, created.id), "utf8");
  assert.ok(raw.includes("v2"));
  assert.ok(!raw.includes("初稿"));

  await assert.rejects(
    repository.update("10_raw/prompts/不存在.md", { title: "t", content: "x" }),
    (error) => error instanceof PromptCollectionError && error.code === "PROMPT_NOT_FOUND",
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: FAIL —— `repository.create is not a function`

- [ ] **Step 3: 实现写入路径**

在 `prompt-collection.mjs` 中：

1) 扩展 imports：

```js
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
```

```js
import {
  DEFAULT_VAULT_ROOT,
  formatShanghaiDate,
  isPathInside,
  sanitizeFilenamePart,
} from "./security.mjs";
```

2) 在 `readItem` 之后追加校验、渲染、写盘函数：

```js
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
```

3) 在 repository 内、`return Object.freeze({ list });` 之前追加 `create`/`update`，并把返回改为：

```js
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

  return Object.freeze({ list, create, update });
```

4) 在 `renderMarkdown` 附近追加 `resolveId`（Task 3 也会用到）：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Data/Github/person_dashboard
git add Workbench/server/prompt-collection.mjs Workbench/tests/prompt-collection.test.mjs
git commit -m "feat: 提示词收藏 - create/update 原子写(唯一文件名+frontmatter渲染+校验)"
```

---

### Task 3: 服务端模块 — 删除与安全边界

**Files:**
- Modify: `Workbench/server/prompt-collection.mjs`
- Test: `Workbench/tests/prompt-collection.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `resolveId`、模块 imports。
- Produces: `remove(id)` → Promise\<`{ id }`\>；不存在/是符号链接时抛 `PROMPT_NOT_FOUND`；ID 越界（非 `10_raw/prompts/` 前缀、含 `/`、`\`、`..`、不以 `.md` 结尾）抛 `INVALID_PROMPT_ID`；提示词目录是符号链接指向外部时抛 `UNSAFE_PROMPTS_DIRECTORY`/`SYMLINK_ESCAPE`。

- [ ] **Step 1: 追加失败测试（删除 + 安全）**

在 `Workbench/tests/prompt-collection.test.mjs` 追加：

```js
test("remove 删除文件，不存在时报 PROMPT_NOT_FOUND", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createPromptCollectionRepository({ vaultRoot });
  const created = await repository.create({ title: "待删", content: "x" });
  assert.deepEqual(await repository.remove(created.id), { id: created.id });
  const { items } = await repository.list();
  assert.deepEqual(items, []);
  await assert.rejects(
    repository.remove(created.id),
    (error) => error instanceof PromptCollectionError && error.code === "PROMPT_NOT_FOUND",
  );
});

test("越界 ID 一律拒绝（路径穿越/绝对路径/非 md/前缀不符）", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createPromptCollectionRepository({ vaultRoot });
  for (const badId of [
    "10_raw/prompts/../wiki/index.md",
    "/etc/passwd",
    "10_raw/articles/one.md",
    "10_raw/prompts/a.txt",
    "10_raw/prompts/子/文件.md",
    "10_raw\\prompts\\a.md",
    "10_raw/prompts/.hidden.md",
    "",
    null,
  ]) {
    await assert.rejects(
      repository.update(badId, { title: "t", content: "x" }),
      (error) => error instanceof PromptCollectionError && error.code === "INVALID_PROMPT_ID",
    );
    await assert.rejects(
      repository.remove(badId),
      (error) => error instanceof PromptCollectionError && error.code === "INVALID_PROMPT_ID",
    );
  }
});

test("提示词目录是指向外部目录的符号链接时拒绝写入", async (t) => {
  const vaultRoot = await makeVault(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "workbench-prompt-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(vaultRoot, "10_raw"), { recursive: true });
  await symlink(outside, path.join(vaultRoot, "10_raw", "prompts"));
  const repository = createPromptCollectionRepository({ vaultRoot });
  await assert.rejects(repository.create({ title: "t", content: "x" }), (error) =>
    error instanceof PromptCollectionError &&
    ["UNSAFE_PROMPTS_DIRECTORY", "SYMLINK_ESCAPE"].includes(error.code),
  );
  assert.deepEqual(await readdir(outside), []);
});
```

并在文件顶部 import 中补上 `readdir`（`node:fs/promises` 的命名导入列表加入 `readdir`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: FAIL —— `repository.remove is not a function`

- [ ] **Step 3: 实现 remove**

在 repository 内追加，返回值改为 `Object.freeze({ list, create, update, remove })`：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: PASS（9 个用例）

- [ ] **Step 5: 全量回归（服务端相关）**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/*.test.mjs`
Expected: 全部 PASS（既有套件不受影响）

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Data/Github/person_dashboard
git add Workbench/server/prompt-collection.mjs Workbench/tests/prompt-collection.test.mjs
git commit -m "feat: 提示词收藏 - remove 与安全边界(越界ID拒绝+symlink逃逸防护)"
```

---

### Task 4: API 端点接入 + 冒烟测试

**Files:**
- Modify: `Workbench/server/vite-plugin-workbench.mjs`
- Test: `Workbench/tests/prompt-collection.test.mjs`（追加 API 冒烟用例）

**Interfaces:**
- Consumes: Task 3 完成的 `createPromptCollectionRepository`；插件内既有变量 `vaultRoot`、`vaultSync`（`notifyPaths(relativePaths)`）、helpers `json(res, status, value)`、`readJson(req, maxBytes)`、`assertAllowedObjectKeys(value, allowedKeys, code)`。**注意**：`assertLocalMutationRequest(req)` 已在 dispatch 入口统一调用（约 line 1308），端点内无需重复；错误直接 throw，中间件尾部全局 catch（约 line 2721）经 `errorStatus`/`errorPayload` 自动映射（`INVALID_*`→400、`*_NOT_FOUND`→404）。
- Produces（HTTP 端点，前端任务依赖）:
  - `GET /api/prompts/collection` → 200 `{ items, tags }`
  - `POST /api/prompts/collection` body `{ title, content, tags?, source? }` → 200 item
  - `PATCH /api/prompts/collection?id=<相对路径>` body 同上（全量替换）→ 200 item
  - `DELETE /api/prompts/collection?id=<相对路径>` → 200 `{ id }`
  - 写操作后调 `vaultSync.notifyPaths([item.id])`。

- [ ] **Step 1: 追加失败测试（API 冒烟）**

在 `Workbench/tests/prompt-collection.test.mjs` 顶部追加 import：

```js
import http from "node:http";
import { createServer as createViteServer } from "vite";
import { workbenchApiPlugin } from "../server/vite-plugin-workbench.mjs";
```

文件末尾追加：

```js
async function startApiFixture(t) {
  const vaultRoot = await makeVault(t);
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
    plugins: [workbenchApiPlugin({ vaultRoot })],
  });
  const server = http.createServer(vite.middlewares);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
  });
  return `http://127.0.0.1:${address.port}`;
}

test("API 冒烟：GET 空列表 → POST 创建 → PATCH 更新 → DELETE 删除", async (t) => {
  const origin = await startApiFixture(t);
  const jsonHeaders = { "Content-Type": "application/json" };

  const empty = await fetch(`${origin}/api/prompts/collection`);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { items: [], tags: [] });

  const created = await fetch(`${origin}/api/prompts/collection`, {
    headers: jsonHeaders,
    method: "POST",
    body: JSON.stringify({ title: "接口冒烟", content: "正文", tags: ["api"] }),
  });
  assert.equal(created.status, 200);
  const item = await created.json();
  assert.equal(item.id, "10_raw/prompts/" + String(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })) + "-接口冒烟.md");

  const updated = await fetch(
    `${origin}/api/prompts/collection?${new URLSearchParams({ id: item.id })}`,
    { headers: jsonHeaders, method: "PATCH", body: JSON.stringify({ title: "接口冒烟", content: "正文v2", tags: [], source: "" }) },
  );
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).content, "正文v2");

  const removed = await fetch(
    `${origin}/api/prompts/collection?${new URLSearchParams({ id: item.id })}`,
    { headers: jsonHeaders, method: "DELETE" },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { id: item.id });
});

test("API：非法 ID 返回 400，不存在返回 404，多余字段返回 400", async (t) => {
  const origin = await startApiFixture(t);
  const jsonHeaders = { "Content-Type": "application/json" };

  const traversal = await fetch(
    `${origin}/api/prompts/collection?${new URLSearchParams({ id: "10_raw/prompts/../wiki/x.md" })}`,
    { headers: jsonHeaders, method: "PATCH", body: JSON.stringify({ title: "t", content: "x" }) },
  );
  assert.equal(traversal.status, 400);

  const missing = await fetch(
    `${origin}/api/prompts/collection?${new URLSearchParams({ id: "10_raw/prompts/2020-01-01-无.md" })}`,
    { headers: jsonHeaders, method: "PATCH", body: JSON.stringify({ title: "t", content: "x" }) },
  );
  assert.equal(missing.status, 404);

  const extraKey = await fetch(`${origin}/api/prompts/collection`, {
    headers: jsonHeaders,
    method: "POST",
    body: JSON.stringify({ title: "t", content: "x", hack: 1 }),
  });
  assert.equal(extraKey.status, 400);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: FAIL —— 新增两个 API 用例 404（端点不存在）

- [ ] **Step 3: 接入插件**

在 `Workbench/server/vite-plugin-workbench.mjs`：

1) import 区（约 line 66-70 附近，与 coach-prompt import 相邻）追加：

```js
import { createPromptCollectionRepository } from "./prompt-collection.mjs";
```

2) repository 创建区（`const coachPrompt = createCoachPromptRepository({ vaultRoot });` 约 line 1001 附近）追加：

```js
  const promptCollection = createPromptCollectionRepository({ vaultRoot });
```

3) 端点 dispatch：定位到 `if (req.method === "GET" && url.pathname === "/api/prompts") {`（约 line 2415），在其后追加：

```js
          if (req.method === "GET" && url.pathname === "/api/prompts/collection") {
            return json(res, 200, await promptCollection.list());
          }

          if (req.method === "POST" && url.pathname === "/api/prompts/collection") {
            const body = await readJson(req, 64 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["title", "content", "tags", "source"]),
              "INVALID_PROMPT_REQUEST",
            );
            const item = await promptCollection.create(body);
            vaultSync.notifyPaths([item.id]);
            return json(res, 200, item);
          }

          if (req.method === "PATCH" && url.pathname === "/api/prompts/collection") {
            const body = await readJson(req, 64 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["title", "content", "tags", "source"]),
              "INVALID_PROMPT_REQUEST",
            );
            const item = await promptCollection.update(url.searchParams.get("id"), body);
            vaultSync.notifyPaths([item.id]);
            return json(res, 200, item);
          }

          if (req.method === "DELETE" && url.pathname === "/api/prompts/collection") {
            const result = await promptCollection.remove(url.searchParams.get("id"));
            vaultSync.notifyPaths([result.id]);
            return json(res, 200, result);
          }
```

**关键顺序**：`/api/prompts/collection` 的匹配必须放在 `GET /api/prompts` 的**后面**（它更具体但 `GET /api/prompts` 只精确匹配 `url.pathname === "/api/prompts"`，互不干扰；放在同一区域即可，无前缀匹配冲突）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && node --test --test-concurrency=1 tests/prompt-collection.test.mjs`
Expected: PASS（11 个用例）

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Data/Github/person_dashboard
git add Workbench/server/vite-plugin-workbench.mjs Workbench/tests/prompt-collection.test.mjs
git commit -m "feat: 提示词收藏 - 四个 collection 端点接入+写后notifyPaths+API冒烟测试"
```

---

### Task 5: 前端 — api.js 客户端 + 页面双 tab + 收藏面板（只读）

**Files:**
- Modify: `Workbench/src/lib/api.js`（在 `optimizePrompt` 之后追加）
- Modify: `Workbench/src/pages/PromptsLibraryPage.jsx`
- Create: `Workbench/src/components/prompts/PromptCollectionPanel.jsx`
- Modify: `Workbench/src/pages/prompts-library.css`（末尾追加）

**Interfaces:**
- Consumes: Task 4 的 4 个端点；`api.js` 既有 `request(path, options)`；现有 CSS 类 `.prompts-toolbar` `.prompts-search` `.prompts-seg` `.prompts-seg__btn(--on)` `.prompts-list` `.prompts-item(--open)` `.prompts-item__head/__title/__lang/__preview/__body/__ops/__copy` `.prompts-skeleton(__line)` `.prompts-error` `.prompts-empty`。
- Produces:
  - `loadPromptCollection()` → Promise\<`{ items, tags }`\>（普通 request，不走 cachedGet —— 收藏列表是写后即读的数据）
  - `createPromptItem(input)` / `updatePromptItem(id, input)` / `deletePromptItem(id)`（Task 6 使用）
  - 组件 `<PromptCollectionPanel />`（本任务实现列表/搜索/标签筛选；Task 6 补表单与增删改）
  - 页面 tab 状态：`"mine"`（默认）| `"public"`

- [ ] **Step 1: api.js 追加客户端函数**

在 `Workbench/src/lib/api.js` 的 `optimizePrompt` 函数之后（约 line 791）、`// ---- 云服务管理 ----` 之前追加：

```js
// ---- 我的提示词收藏（vault 10_raw/prompts/，vault 为唯一数据源） ----

export function loadPromptCollection() {
  return request("/api/prompts/collection");
}

export async function createPromptItem(input) {
  return request("/api/prompts/collection", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updatePromptItem(id, input) {
  const params = new URLSearchParams({ id });
  return request(`/api/prompts/collection?${params}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deletePromptItem(id) {
  const params = new URLSearchParams({ id });
  return request(`/api/prompts/collection?${params}`, { method: "DELETE" });
}
```

- [ ] **Step 2: 创建 PromptCollectionPanel（只读版）**

创建 `Workbench/src/components/prompts/PromptCollectionPanel.jsx`：

```jsx
// 我的提示词收藏：每条是 vault 10_raw/prompts/ 下的一个 md 文件。
// vault 为唯一数据源；Obsidian 端改动经 App 级 useVaultSync（revision 递增 → 页面重挂载）触发重拉。

import { useEffect, useMemo, useState } from "react";
import { IconCopy, IconPlus, IconSearch, IconSparkles } from "@tabler/icons-react";
import { loadPromptCollection } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api-errors";

export function PromptCollectionPanel() {
  const [items, setItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [openIndex, setOpenIndex] = useState(-1);
  const [copiedIndex, setCopiedIndex] = useState(-1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadPromptCollection();
        if (cancelled) return;
        setItems(data?.items ?? []);
        setTags(data?.tags ?? []);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(apiErrorMessage(caught, "收藏加载失败"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword && !activeTag) return items;
    return items.filter((item) => {
      if (activeTag && !item.tags.includes(activeTag)) return false;
      if (!keyword) return true;
      return (
        item.title.toLowerCase().includes(keyword) ||
        item.content.toLowerCase().includes(keyword) ||
        item.tags.some((tag) => tag.toLowerCase().includes(keyword))
      );
    });
  }, [items, query, activeTag]);

  const copy = async (index) => {
    const item = filtered[index];
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.content);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(-1), 1500);
    } catch { /* 剪贴板被拒时静默 */ }
  };

  return (
    <div className="prompts-col">
      <div className="prompts-toolbar">
        <label className="prompts-search">
          <IconSearch aria-hidden="true" size={15} stroke={1.7} />
          <input
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索：标题、正文、标签"
            value={query}
          />
        </label>
        <button className="prompts-col__new" type="button">
          <IconPlus aria-hidden="true" size={14} stroke={1.7} />
          新建收藏
        </button>
      </div>

      {tags.length ? (
        <div className="prompts-col__tags">
          <button
            className={`prompts-col__tag${activeTag === "" ? " prompts-col__tag--on" : ""}`}
            onClick={() => setActiveTag("")}
            type="button"
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              className={`prompts-col__tag${activeTag === tag ? " prompts-col__tag--on" : ""}`}
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? "" : tag)}
              type="button"
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="prompts-error">{error}</div> : null}

      {loading ? (
        <div className="prompts-list" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div className="prompts-skeleton" key={key}>
              <div className="prompts-skeleton__line" style={{ width: "38%" }} />
              <div className="prompts-skeleton__line" />
            </div>
          ))}
        </div>
      ) : (
        <ul className="prompts-list">
          {filtered.map((item, index) => (
            <li
              className={`prompts-item${openIndex === index ? " prompts-item--open" : ""}`}
              key={item.id}
            >
              <button
                className="prompts-item__head"
                onClick={() => setOpenIndex(openIndex === index ? -1 : index)}
                type="button"
              >
                <span className="prompts-item__title">{item.title}</span>
                {item.tags.length ? (
                  <span className="prompts-item__tags">
                    {item.tags.map((tag) => (
                      <span className="prompts-item__tag" key={tag}>#{tag}</span>
                    ))}
                  </span>
                ) : null}
              </button>
              <p className="prompts-item__preview">{item.content}</p>
              {openIndex === index ? (
                <div className="prompts-item__body">
                  <pre>{item.content}</pre>
                  <div className="prompts-item__ops">
                    <button className="prompts-item__copy" onClick={() => copy(index)} type="button">
                      <IconCopy aria-hidden="true" size={13} stroke={1.7} />
                      {copiedIndex === index ? "已复制" : "复制全文"}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!loading && filtered.length === 0 && !error ? (
        <div className="prompts-empty">
          <IconSparkles aria-hidden="true" size={20} stroke={1.6} />
          <p>还没有收藏。在公开模板里找到合适的底子改造成自己的，或点「新建收藏」。</p>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: PromptsLibraryPage 改为双 tab**

修改 `Workbench/src/pages/PromptsLibraryPage.jsx`：

1) 顶部 import 区追加：

```jsx
import { PromptCollectionPanel } from "../components/prompts/PromptCollectionPanel";
```

2) 组件内 `const [query, setQuery] = useState("");` 之前加 tab 状态：

```jsx
  const [tab, setTab] = useState("mine"); // mine=我的收藏（默认） | public=公开模板
```

3) `PageHeader` 之后、`<div className="prompts-toolbar">` 之前插入 tab 切换：

```jsx
      <div className="prompts-tabs" role="tablist" aria-label="提示词库分区">
        <button
          aria-selected={tab === "mine"}
          className={`prompts-tabs__btn${tab === "mine" ? " prompts-tabs__btn--on" : ""}`}
          onClick={() => setTab("mine")}
          role="tab"
          type="button"
        >
          我的收藏
        </button>
        <button
          aria-selected={tab === "public"}
          className={`prompts-tabs__btn${tab === "public" ? " prompts-tabs__btn--on" : ""}`}
          onClick={() => setTab("public")}
          role="tab"
          type="button"
        >
          公开模板
        </button>
      </div>

      {tab === "mine" ? <PromptCollectionPanel /> : (
```

4) 现有公开模板的全部内容（`<div className="prompts-toolbar">…` 到 optimizer 弹层结束的 `</div>`（`prompts-optimizer` 条件块闭合）之前的内容）包进该 fragment：即在 `{tab === "mine" ? <PromptCollectionPanel /> : (` 之后接 `<>`，在 optimizer 弹层 JSX 结束后接 `)}`：

   - 精确做法：将现有 return 中从 `<div className="prompts-toolbar">` 起、至 optimizer 条件块 `{optimizer ? (...) : null}` 结束为止的全部 JSX，包一层 `<> … </>`，随后补 `)}`。
   - **公开模板的 JSX 逻辑一行不改**（含 `autoFocus`、搜索、优化器弹层）。

5) 更新 `PageHeader` description（提及双分区与 vault 同步）：

```jsx
        description="「我的收藏」沉淀自己的提示词，与 Obsidian 知识库（10_raw/prompts/）双向同步；「公开模板」检索中文与英文模板库，找适合的打底再改。"
```

- [ ] **Step 4: 追加 CSS**

在 `Workbench/src/pages/prompts-library.css` 末尾追加（只用文件里已出现的变量）：

```css
/* ---- 我的收藏（prompt collection）---- */

.prompts-tabs {
  display: flex;
  width: max-content;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  overflow: hidden;
  margin-bottom: 12px;
}

.prompts-tabs__btn {
  min-height: 32px;
  padding: 0 16px;
  border: none;
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 12.5px;
  cursor: pointer;
}

.prompts-tabs__btn--on {
  background: var(--accent-wash);
  color: var(--ink);
  font-weight: 600;
}

.prompts-col__new {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--ink-soft);
  font-size: 12px;
  cursor: pointer;
}

.prompts-col__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.prompts-col__tag {
  min-height: 26px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink-faint);
  font-size: 11.5px;
  cursor: pointer;
}

.prompts-col__tag--on {
  border-color: var(--accent-soft);
  background: var(--accent-wash);
  color: var(--ink);
}

.prompts-item__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.prompts-item__tag {
  font-size: 11px;
  color: var(--ink-faint);
}
```

若 `var(--ink)` 未生效（已在 `Workbench/src/styles.css:12` 确认存在 `--ink: #0a0a0a`，正常无需改动），将 `prompts-tabs__btn--on` 与 `prompts-col__tag--on` 的 `color` 改为已存在的正文色变量。

- [ ] **Step 5: 构建与手动验证**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && npm run build`
Expected: 构建成功，无 JSX/import 错误。

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && npm run dev` 后浏览器打开 `http://127.0.0.1:5173/prompts`：
Expected: 默认显示「我的收藏」tab；空态文案出现；切到「公开模板」原有搜索/优化功能完好；用 Obsidian 或 Finder 在 vault `10_raw/prompts/` 手工放一个带 frontmatter 的 md（可复制 Task 1 Step 1 的样例），约 1-2 秒后页面自动重挂载并显示该条（App 级 vault-sync 重挂载机制）。

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Data/Github/person_dashboard
git add Workbench/src/lib/api.js Workbench/src/pages/PromptsLibraryPage.jsx Workbench/src/components/prompts/PromptCollectionPanel.jsx Workbench/src/pages/prompts-library.css
git commit -m "feat: 提示词页 - 双tab(我的收藏/公开模板)+收藏面板只读版(搜索/标签筛选/复制)"
```

---

### Task 6: 前端 — 新建/编辑/删除表单

**Files:**
- Modify: `Workbench/src/components/prompts/PromptCollectionPanel.jsx`

**Interfaces:**
- Consumes: Task 5 的 `createPromptItem` / `updatePromptItem` / `deletePromptItem`；Task 5 面板既有 state。
- Produces: 完整 CRUD 面板。表单弹层复用 `.prompts-optimizer` 系列类（`prompts-optimizer` / `__head` / `__field` / `__run` / `__ops` / `__error`），仅新增 `.prompts-form__result`（正文 textarea，等同 `__result` 用法时可直接复用 `prompts-optimizer__result`）。

- [ ] **Step 1: 加表单 state 与提交逻辑**

在 `PromptCollectionPanel` 中：

1) import 追加：

```jsx
import { createPromptItem, deletePromptItem, loadPromptCollection, updatePromptItem } from "../../lib/api";
```

（`loadPromptCollection` 已有，合并为一行 import；Task 5 的 IconPlus 已引入。）

2) state 区追加（`form`：null 或 `{ item?, title, content, tagText, source, busy, error }`）：

```jsx
  const [form, setForm] = useState(null);

  const openCreate = () =>
    setForm({ item: null, title: "", content: "", tagText: "", source: "", busy: false, error: null });

  const openEdit = (index) => {
    const item = filtered[index];
    if (!item) return;
    setForm({
      item,
      title: item.title,
      content: item.content,
      tagText: item.tags.join("、"),
      source: item.source ?? "",
      busy: false,
      error: null,
    });
  };

  const patchForm = (changes) => setForm((state) => ({ ...state, ...changes }));

  const submitForm = async () => {
    if (!form || form.busy) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      patchForm({ error: "标题和正文不能为空。" });
      return;
    }
    const tags = form.tagText.split(/[,，、\s]+/).filter(Boolean);
    setForm((state) => ({ ...state, busy: true, error: null }));
    try {
      const payload = { title, content, tags, source: form.source.trim() };
      if (form.item) {
        await updatePromptItem(form.item.id, payload);
      } else {
        await createPromptItem(payload);
      }
      setForm(null);
      setOpenIndex(-1);
      const data = await loadPromptCollection();
      setItems(data?.items ?? []);
      setTags(data?.tags ?? []);
    } catch (caught) {
      setForm((state) => ({ ...state, busy: false, error: apiErrorMessage(caught, "保存失败") }));
    }
  };

  const removeItem = async (index) => {
    const item = filtered[index];
    if (!item) return;
    if (!window.confirm(`删除「${item.title}」？vault 中的文件会一并删除。`)) return;
    try {
      await deletePromptItem(item.id);
      const data = await loadPromptCollection();
      setItems(data?.items ?? []);
      setTags(data?.tags ?? []);
      setOpenIndex(-1);
    } catch (caught) {
      setError(apiErrorMessage(caught, "删除失败"));
    }
  };
```

- [ ] **Step 2: 接线按钮 + 渲染弹层**

1) 「新建收藏」按钮接 `onClick={openCreate}`。

2) 展开区 `.prompts-item__ops` 里在复制按钮后追加两个操作（样式复用 `prompts-item__copy`）：

```jsx
                    <button className="prompts-item__copy" onClick={() => openEdit(index)} type="button">
                      编辑
                    </button>
                    <button className="prompts-item__copy" onClick={() => removeItem(index)} type="button">
                      删除
                    </button>
```

3) 组件 return 的最外层 div 末尾（空态判断之后）追加表单弹层：

```jsx
      {form ? (
        <div className="prompts-optimizer" role="dialog" aria-label={form.item ? "编辑收藏" : "新建收藏"}>
          <header className="prompts-optimizer__head">
            <strong>{form.item ? "编辑收藏" : "新建收藏"}</strong>
            <button onClick={() => setForm(null)} type="button">关闭</button>
          </header>
          <label className="prompts-optimizer__field">
            <span>标题（必填）</span>
            <input
              onChange={(event) => patchForm({ title: event.target.value })}
              placeholder="例如：代码审查提示词"
              value={form.title}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>提示词正文（必填）</span>
            <textarea
              onChange={(event) => patchForm({ content: event.target.value })}
              placeholder="粘贴提示词原文，原样保存"
              rows={10}
              value={form.content}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>标签（用逗号或顿号分隔）</span>
            <input
              onChange={(event) => patchForm({ tagText: event.target.value })}
              placeholder="写作、代码、review"
              value={form.tagText}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>来源 URL（可选）</span>
            <input
              onChange={(event) => patchForm({ source: event.target.value })}
              placeholder="https://…"
              value={form.source}
            />
          </label>
          <button
            className="prompts-optimizer__run"
            disabled={form.busy}
            onClick={submitForm}
            type="button"
          >
            {form.busy ? "保存中…" : form.item ? "保存修改" : "保存到知识库"}
          </button>
          {form.error ? <p className="prompts-optimizer__error">{form.error}</p> : null}
        </div>
      ) : null}
```

- [ ] **Step 3: 手动验证 CRUD 全链路**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && npm run dev`，浏览器 `http://127.0.0.1:5173/prompts`：

1. 新建：填标题/正文/标签 → 保存 → 列表立即出现；用 Obsidian 打开 `<vault>/10_raw/prompts/` 确认新 md 存在、properties 面板五个字段正确、正文原样。
2. 编辑：改标题与正文 → 保存 → 列表即时更新；确认**文件名未变**（排序里该条仍在，Obsidian 中打开同一文件看到新 frontmatter）。
3. 删除：confirm 后条目消失，vault 中文件被删。
4. 校验：正文清空保存 → 表单内提示「标题和正文不能为空」；来源填 `abc` → 服务端 400 错误信息显示在表单。
5. 搜索 + 标签：关键词命中标题/正文/标签；点击标签 chip 过滤，再点取消。
6. Obsidian 反向：在 Obsidian 中改某条正文 → 约 1-2 秒后页面自动刷新显示新内容。

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Data/Github/person_dashboard
git add Workbench/src/components/prompts/PromptCollectionPanel.jsx
git commit -m "feat: 提示词收藏 - 面板新建/编辑/删除表单(复用optimizer弹层样式)"
```

---

### Task 7: 收尾 — 全量测试 + 双向实测

**Files:**
- 无新文件（只验证；如有微修则一并提交）

**Interfaces:**
- Consumes: 前全部任务。

- [ ] **Step 1: 全量测试**

Run: `cd /Volumes/Data/Github/person_dashboard/Workbench && npm test`
Expected: build 成功 + 全部测试 PASS（含新增 11 个 prompt-collection 用例）。若有失败，修复后重跑直至全绿（失败信息原样报告，不得跳过用例）。

- [ ] **Step 2: 双向实测（vault = `PERSONAL_DASHBOARD_VAULT_ROOT` 指向的 vault 或仓库内置示例库）**

1. dashboard 新建一条 → Obsidian 里文件出现、properties 可编辑。
2. Obsidian 改正文/标签 → dashboard 自动刷新。
3. 重启 dev server → 列表仍在（数据在 vault，天然持久）。

- [ ] **Step 3: 前端 UI 走查（可选自动化）**

Run: 在仓库根目录执行 `/qa`（Playwright）覆盖：建/改/删/搜索/标签筛选五个交互；无 `/qa` 环境时以 Task 6 Step 3 的手动清单为准。

- [ ] **Step 4: 检查改动面**

Run: `cd /Volumes/Data/Github/person_dashboard && git diff main --stat`
Expected: 变更仅涉及 `Workbench/server/prompt-collection.mjs`、`Workbench/tests/prompt-collection.test.mjs`、`Workbench/server/vite-plugin-workbench.mjs`、`Workbench/src/lib/api.js`、`Workbench/src/pages/PromptsLibraryPage.jsx`、`Workbench/src/components/prompts/PromptCollectionPanel.jsx`、`Workbench/src/pages/prompts-library.css`、`docs/superpowers/`。若出现其他文件，逐个核对是否误改。

- [ ] **Step 5: 收尾提交（如有微修）**

```bash
cd /Volumes/Data/Github/person_dashboard
git add -A
git commit -m "chore: 提示词收藏 - 收尾微调(如有)"
```
