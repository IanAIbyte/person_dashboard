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
