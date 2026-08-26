// 提示词库（双源聚合 + minisearch 检索）单元测试：全部用注入的假 fetch，不出网。
import assert from "node:assert/strict";
import test from "node:test";

import { createPromptsLibrary, parsePromptsCsv } from "../server/prompts-library.mjs";

const ZH_FIXTURE = JSON.stringify([
  { act: "担任雅思写作考官", prompt: "我希望你假定自己是雅思写作考官，按评分细则打分并给修改意见。" },
  { act: "充当 Linux 终端", prompt: "我想让你充当 linux 终端。我只输入命令，你回复终端输出。" },
]);

// 含引号内逗号与换行的多行 prompt，验证 RFC4180 解析。
const EN_FIXTURE = [
  "act,prompt,for_devs,type,contributor",
  '"Linux Terminal","I want you to act as a linux terminal. I will type commands and you will reply with what the terminal should show inside one unique code block, and nothing else.",TRUE,TEXT,f',
  '"Ethical Hacker,""pro"",I will do X","first prompt line\nsecond line after embedded newline",TRUE,TEXT,x',
].join("\n");

function makeFakeFetch({ zh = ZH_FIXTURE, en = EN_FIXTURE } = {}) {
  return async (url) => {
    if (url.includes("prompts-zh.json")) {
      if (zh === null) throw new Error("zh down");
      return { ok: true, text: async () => zh };
    }
    if (en === null) throw new Error("en down");
    return { ok: true, text: async () => en };
  };
}

test("parsePromptsCsv handles quoted commas, escaped quotes and embedded newlines", () => {
  const items = parsePromptsCsv(EN_FIXTURE);
  assert.equal(items.length, 2);
  assert.equal(items[0].act, "Linux Terminal");
  assert.ok(items[0].prompt.includes("code block"));
  assert.equal(items[1].act, 'Ethical Hacker,"pro",I will do X'); // 转义引号还原
  assert.ok(items[1].prompt.includes("second line after embedded newline"));
});

test("library aggregates both sources and searches across languages", async () => {
  const library = createPromptsLibrary({ fetchImpl: makeFakeFetch(), now: () => 1_000 });
  const all = await library.search({});
  assert.equal(all.stats.zhCount, 2);
  assert.equal(all.stats.enCount, 2);
  // 无关键词：中文在前。
  assert.equal(all.items[0].lang, "zh");

  // 中文子串兜底：无空格分词下长句标题/正文仍可命中。
  const zhHit = await library.search({ q: "雅思写作考官" });
  assert.ok(zhHit.items.some((item) => item.act.includes("雅思")));
  const enHit = await library.search({ q: "linux terminal" });
  assert.ok(enHit.items.length >= 2); // 中英各一条终端
  const zhOnly = await library.search({ q: "terminal", lang: "zh" });
  assert.ok(zhOnly.items.every((item) => item.lang === "zh"));
});

test("library serves stale cache when refresh fails after a success", async () => {
  let time = 1_000;
  const fresh = makeFakeFetch();
  const broken = makeFakeFetch({ zh: null, en: null });
  let current = fresh;
  const library = createPromptsLibrary({
    fetchImpl: (url, opts) => current(url, opts),
    now: () => time,
  });
  const first = await library.search({ q: "terminal" });
  assert.equal(first.stats.stale, false);

  time += 25 * 60 * 60 * 1000; // 过期
  current = broken;
  const second = await library.search({ q: "linux terminal" });
  assert.equal(second.stats.stale, true);
  assert.ok(second.items.length >= 2); // 缓存仍可检索

  time = 1_000; // 未过期不再拉取（broken 也不影响）
  current = broken;
  const third = await library.search({ q: "雅思" });
  assert.ok(third.items.length >= 1);
});

test("library throws when no source ever succeeded", async () => {
  const library = createPromptsLibrary({ fetchImpl: makeFakeFetch({ zh: null, en: null }), now: () => 1_000 });
  await assert.rejects(() => library.search({}), /不可用|failed|down|HTTP/i);
});

test("suggestKeywords and optimize route through llmClient", async () => {
  const calls = [];
  const llmClient = {
    chatCompletion: async ({ messages }) => {
      calls.push(messages);
      if (messages[1].content.includes("搜索关键词翻译器") || messages[0].content.includes("搜索关键词翻译器")) {
        return "linux terminal assistant\n多余行";
      }
      return "优化后的提示词正文";
    },
  };
  const library = createPromptsLibrary({ fetchImpl: makeFakeFetch(), llmClient, now: () => 1_000 });

  const keywords = await library.suggestKeywords("帮我找一个终端助手");
  assert.equal(keywords, "linux terminal assistant"); // 只取首行

  const optimized = await library.optimize({
    idea: "复盘交易",
    template: "Linux Terminal",
    context: "A股",
  });
  assert.equal(optimized.prompt, "优化后的提示词正文");
  const userContent = calls.at(-1)[1].content;
  assert.ok(userContent.includes("复盘交易") && userContent.includes("Linux Terminal") && userContent.includes("A股"));
});

test("suggest and optimize fail fast without llmClient", async () => {
  const library = createPromptsLibrary({ fetchImpl: makeFakeFetch(), now: () => 1_000 });
  await assert.rejects(() => library.suggestKeywords("x"), /LLM 未配置/);
  await assert.rejects(() => library.optimize({ idea: "x", template: "y" }), /LLM 未配置/);
});
