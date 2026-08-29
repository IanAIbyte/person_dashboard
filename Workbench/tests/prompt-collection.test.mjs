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
