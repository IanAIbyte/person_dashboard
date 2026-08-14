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
