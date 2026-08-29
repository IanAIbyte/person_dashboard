import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  STOCK_RESEARCH_PATH,
  StockResearchError,
  createStockResearchRepository,
} from "../server/stock-research.mjs";
import { createStockAnalysisService } from "../server/stock-analysis.mjs";

async function makeVault(t) {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-stock-research-"));
  await mkdir(path.join(vaultRoot, "10_raw", "my-thoughts", "reading-notes"), { recursive: true });
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  return vaultRoot;
}

function sampleReport(overrides = {}) {
  return {
    facts: {
      oneLiner: "卖光模块给云厂商，靠技术壁垒赚钱",
      business: ["光器件", "无源器件"],
      industry: "光通信",
      position: "上游器件",
      limitations: "无财报数据，仅基于新闻与行情",
    },
    technicals: {
      trend: "多头排列",
      signals: ["MACD 红柱缩短"],
      support: ["347（MA5）"],
      resistance: ["376"],
      dataNote: "素材无 K 线历史",
    },
    rating: {
      dimensions: [
        { key: "technicals", label: "技术面", score: 4.0, weight: 0.25, comment: "主升浪" },
        { key: "fundamentals", label: "基本面", score: 4.5, weight: 0.30, comment: "高增长" },
      ],
      total: 2.35,
      verdict: "中性观察",
      oneLiner: "中期趋势向好，短期估值透支。",
    },
    debate: {
      bulls: [{ point: "CPO 景气", evidence: "新闻 1" }],
      bears: [{ point: "估值过贵", evidence: "PE 偏高" }],
      verifications: ["8 月中报验证环比"],
    },
    boardroom: [{ name: "巴菲特", stance: "回避", view: "安全边际为零。" }],
    monitor: [
      { type: "reinforce", event: "中报 Q2 环比改善", action: "强化持有逻辑" },
      { type: "falsify", event: "毛利率跌破 55%", action: "逻辑证伪，重新评估" },
    ],
    sentiment: { sentiment: "正面", score: 4, summary: "新闻偏正面。" },
    ...overrides,
  };
}

test("stock research repository saves, lists, and overwrites per stock", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createStockResearchRepository({ vaultRoot });

  assert.deepEqual(await repository.list(), { version: 1, updatedAt: null, reports: [] });

  const saved = await repository.save("天孚通信", {
    generatedAt: "2026-08-14T00:00:00.000Z",
    report: sampleReport(),
  });
  assert.equal(saved.name, "天孚通信");
  assert.equal(saved.generatedAt, "2026-08-14T00:00:00.000Z");

  const second = await repository.save("中际旭创", {
    generatedAt: "2026-08-14T01:00:00.000Z",
    report: sampleReport(),
  });
  let listed = await repository.list();
  assert.equal(listed.reports.length, 2);
  assert.equal(listed.updatedAt, second.generatedAt === undefined ? listed.updatedAt : listed.updatedAt);

  // 同股覆盖：只保留最新快照
  await repository.save("天孚通信", {
    generatedAt: "2026-08-14T02:00:00.000Z",
    report: sampleReport({ rating: { dimensions: [], total: 1, verdict: "谨慎", oneLiner: null } }),
  });
  listed = await repository.list();
  assert.equal(listed.reports.length, 2);
  const entry = listed.reports.find((item) => item.name === "天孚通信");
  assert.equal(entry.generatedAt, "2026-08-14T02:00:00.000Z");
  assert.equal(entry.report.rating.verdict, "谨慎");

  assert.equal(await repository.remove("中际旭创"), true);
  assert.equal(await repository.remove("不存在"), false);
  listed = await repository.list();
  assert.equal(listed.reports.length, 1);
});

test("stock research repository sanitizes unknown fields and clamps numbers", async (t) => {
  const vaultRoot = await makeVault(t);
  const repository = createStockResearchRepository({ vaultRoot });

  const saved = await repository.save("某公司", {
    generatedAt: "2026-08-14T00:00:00.000Z",
    report: {
      ...sampleReport(),
      extraField: "should be dropped",
      rating: {
        dimensions: [{ key: "x", label: "X", score: 99, weight: 5, comment: null }],
        total: 42,
        verdict: "积极关注",
        oneLiner: null,
      },
      monitor: [{ type: "unknown", event: " 事件 ", action: null }],
    },
  });

  assert.equal(JSON.stringify(saved.report).includes("extraField"), false);
  assert.equal(saved.report.rating.dimensions[0].score, 5);
  assert.equal(saved.report.rating.dimensions[0].weight, 1);
  assert.equal(saved.report.rating.total, 5);
  // 未知 monitor.type 归入 reinforce
  assert.equal(saved.report.monitor[0].type, "reinforce");
  assert.equal(saved.report.monitor[0].event, "事件");
});

test("stock research repository rejects corrupt store files", async (t) => {
  const vaultRoot = await makeVault(t);
  await writeFile(
    path.join(vaultRoot, STOCK_RESEARCH_PATH),
    "{ not json",
    "utf8",
  );
  const repository = createStockResearchRepository({ vaultRoot });
  await assert.rejects(() => repository.list(), StockResearchError);
});

// ===== AI 研究任务 =====

function mockLlm(payload) {
  return {
    chatCompletion: async () => (typeof payload === "function" ? payload() : payload),
  };
}

async function waitForTask(service, id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = service.get(id);
    if (task?.status === "completed" || task?.status === "failed") return task;
    if (Date.now() > deadline) throw new Error("任务等待超时。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("startResearch parses the methodology-shaped report from the LLM", async () => {
  const report = sampleReport();
  const service = createStockAnalysisService({
    llmClient: mockLlm(JSON.stringify(report)),
    newsService: {
      getStockNews: async () => [{ title: "某新闻", mediaName: "媒体", date: "2026-08-13", url: "https://example.com" }],
    },
    marketService: { getQuotes: async () => new Map([["300394", { code: "300394", price: 368.7, changePct: 1.2 }]]) },
  });

  const started = await service.startResearch({ name: "天孚通信", note: "光器件", code: "300394" });
  const task = await waitForTask(service, started.id);

  assert.equal(task.status, "completed");
  assert.equal(task.result.name, "天孚通信");
  assert.equal(task.result.rating.verdict, "中性观察");
  assert.equal(task.result.monitor.length, 2);
  assert.equal(task.result.monitor[1].type, "falsify");
  assert.equal(task.result.boardroom[0].name, "巴菲特");
});

test("startResearch falls back to a minimal structure when the LLM output is not JSON", async () => {
  const service = createStockAnalysisService({
    llmClient: mockLlm("这不是 JSON，只是一段纯文本分析。"),
  });

  const started = await service.startResearch({ name: "某公司", code: null });
  const task = await waitForTask(service, started.id);

  assert.equal(task.status, "completed");
  assert.equal(task.result.rating.dimensions.length, 0);
  assert.equal(task.result.sentiment.sentiment, "不确定");
  assert.ok(task.result.facts.limitations.includes("纯文本"));
});

test("startCoachReview renders four-part markdown from context data", async () => {
  let capturedPrompt = "";
  const service = createStockAnalysisService({
    llmClient: {
      chatCompletion: async ({ messages }) => {
        capturedPrompt = messages[1].content;
        return JSON.stringify({
          core: "指数分化，沪强深弱。",
          market: { narrative: "沪指收涨。", sentimentStage: "发酵", sentimentNext: "判断：明日分歧加大（中）。" },
          holdings: [{ name: "沪电股份", action: "持有", logic: "被验证", signal: "缩量回调", support: 112.1, pressure: 121.21, stop: 110, supportBasis: "60日低点", pressureBasis: "前高", trigger: "121.21 放量突破减 1/3", invalid: "跌破 112 清仓", note: "抗跌。" }],
          watch: [{ name: "长鑫存储", conclusion: "继续观察", distance: "-3.2%", flash: false, note: "随板块。" }],
          plan: { scenarios: [{ name: "强势", prob: 30, stance: "维持仓位" }], watchPlans: [], risks: ["外盘波动"] },
        });
      },
    },
  });
  const started = await service.startCoachReview({
    date: "2026-08-25",
    indices: [{ name: "上证指数", close: 3889.44, changePct: 0.19, amplitudePct: 1.17, turnoverYi: 5800 }],
    market: { turnoverYi: 12000, note: "近似" },
    positions: [{
      name: "沪电股份", code: "002463", shares: 1100, costPrice: 119.5, price: 114.29,
      changePct: -1.11, turnoverPct: 2.6, volumeRatio: 0.9, pnlPct: -4.36, weight: 61,
      note: "PCB 主力", ma5: 118, ma20: 120, ma60: 115, high60: 132, low60: 100,
      last5Closes: [117, 116, 115.5, 114.3, 114.29], news: ["某新闻"],
    }],
    watch: [{ name: "长鑫存储", code: "688825", note: "国产存储", changePct: -0.18, turnoverPct: 6.13, volumeRatio: 0.65 }],
    events: [{ ts: "2026-08-25T06:30:00.000Z", source: "手动", title: "午后回落", changePct: null }],
  });
  const task = await waitForTask(service, started.id);

  assert.equal(task.status, "completed");
  // JSON 信封透传；overview 取 core。
  assert.equal(task.result.structured.core, "指数分化，沪强深弱。");
  assert.equal(task.result.structured.holdings[0].action, "持有");
  assert.equal(task.result.markdown, undefined);
  assert.equal(task.result.overview, "指数分化，沪强深弱。");
  // 默认模板 + 数据段 + session 注入。
  assert.ok(capturedPrompt.includes("四段式复盘"));
  assert.ok(capturedPrompt.includes("# 今日真实数据"));
  assert.ok(capturedPrompt.includes("收盘后复盘"));
  assert.ok(capturedPrompt.includes("上涨 [待补充] 家"));
});

test("startCoachReview falls back to markdown when JSON invalid", async () => {
  const service = createStockAnalysisService({
    llmClient: mockLlm("这不是 JSON,是一段普通复盘文字。"),
  });
  const started = await service.startCoachReview({ date: "2026-08-26", indices: [], positions: [], watch: [], events: [] });
  const task = await waitForTask(service, started.id);
  assert.equal(task.status, "completed");
  assert.equal(task.result.structured, undefined);
  assert.equal(task.result.markdown, "这不是 JSON,是一段普通复盘文字。");
});

test("extractJsonObject tolerates preamble and fences", async () => {
  const { extractJsonObject } = await import("../server/stock-analysis.mjs");
  const payload = { core: "x" };
  // 带 disclaimer 前言 + JSON
  assert.deepEqual(
    extractJsonObject(`*以下为推演,非投资建议*\n\n${JSON.stringify(payload)}`),
    payload,
  );
  // 围栏包裹
  assert.deepEqual(extractJsonObject("```json\n" + JSON.stringify(payload) + "\n```"), payload);
  // 纯文本无 JSON → null
  assert.equal(extractJsonObject("完全是文字,没有对象。"), null);
  // 前言 + 围栏混排
  const service2 = createStockAnalysisService({
    llmClient: mockLlm(`免责声明。\n\`\`\`json\n${JSON.stringify({ core: "ok" })}\n\`\`\``),
  });
  const started2 = await service2.startCoachReview({ date: "2026-08-26", indices: [], positions: [], watch: [], events: [] });
  const task2 = await waitForTask(service2, started2.id);
  assert.equal(task2.result.structured?.core, "ok");
});

test("startCoachReview honors custom prompt template and intraday session", async () => {
  let capturedPrompt = "";
  const service = createStockAnalysisService({
    llmClient: {
      chatCompletion: async ({ messages }) => {
        capturedPrompt = messages[1].content;
        return "盘中快照完成。";
      },
    },
  });
  const started = await service.startCoachReview(
    {
      date: "2026-08-26",
      session: { key: "intraday", phase: "lunch", label: "午间休市 · 盘中", time: "12:00", isTrading: true },
      indices: [],
      sentiment: { upCount: 3000, downCount: 2000, limitUp: 60, maxBoards: 5, limitDown: null, blastRate: null, promotionRate: 55.5, topSectors: [{ name: "半导体", changePct: 3.2 }], bottomSectors: null, bj50: { close: 1400.5, changePct: -1.2 } },
      positions: [],
      watch: [],
      events: [],
    },
    { promptTemplate: "自定义模板 {{date}} {{session}}——只输出盘中要点。" },
  );
  const task = await waitForTask(service, started.id);

  assert.equal(task.status, "completed");
  assert.equal(task.result.session, "intraday");
  assert.ok(capturedPrompt.startsWith("自定义模板 2026-08-26 午间休市 · 盘中"));
  assert.ok(capturedPrompt.includes("盘中复盘"));
  assert.ok(capturedPrompt.includes("上涨 3000 家 / 下跌 2000 家"));
  assert.ok(capturedPrompt.includes("涨停 60 家"));
  assert.ok(capturedPrompt.includes("最高连板 5 板"));
  assert.ok(capturedPrompt.includes("昨日涨停晋级率 55.5%"));
  assert.ok(capturedPrompt.includes("北证50：1400.5（-1.20%）"));
  assert.ok(capturedPrompt.includes("领涨板块 半导体 +3.20%"));
  assert.ok(capturedPrompt.includes("跌停 [待补充]"));
});

test("startReview keeps monitor context and parses verification nodes", async () => {
  const service = createStockAnalysisService({
    llmClient: mockLlm(JSON.stringify({
      overview: "板块整体回暖。",
      notable: ["某股放量"],
      risks: ["估值偏高"],
      actions: ["跟踪中报"],
      verifications: [
        { stock: "天孚通信", event: "8 月中报 Q2 环比", type: "reinforce", note: "待验证" },
        { stock: "中际旭创", event: "毛利率跌破 55%", type: "falsify", note: "证伪退出" },
      ],
    })),
  });

  const started = await service.startReview({
    stocks: [
      { name: "天孚通信", code: "300394", note: "光器件", monitor: [{ type: "reinforce", event: "中报环比", action: null }] },
      { name: "长江存储", code: null, note: "未上市", monitor: [] },
    ],
  });
  const task = await waitForTask(service, started.id);

  assert.equal(task.status, "completed");
  assert.equal(task.result.verifications.length, 2);
  assert.equal(task.result.verifications[1].type, "falsify");
});
