// 个股 AI 分析 service：新闻情绪评分 + 每日复盘。
// 复用 reader-explanations 的「异步任务 + 轮询」模式：start 立即返回任务记录，
// 后台异步调用 LLM，get 轮询状态。内存态，不持久化（重启即清空）。
// 依赖注入 llmClient / newsService / marketService，便于测试与降级。

import { randomUUID } from "node:crypto";

import { stripJsonFence } from "./llm-client.mjs";

const STATUS = { QUEUED: "queued", RUNNING: "running", COMPLETED: "completed", FAILED: "failed" };

function parseJson(content, fallback) {
  try {
    return JSON.parse(stripJsonFence(content));
  } catch {
    return fallback;
  }
}

function systemPrompt() {
  return [
    "你是一名严谨的 A 股投资研究助手，面向个人投资者提供信息整理与风险提示。",
    "所有输出必须基于给定的公开信息，不编造数据；信息缺失时明确说明「缺失」。",
    "不构成投资建议，不给出买卖指令；只做客观的整理、解读与风险提示。",
  ].join("\n");
}

export function createStockAnalysisService({
  llmClient,
  newsService,
  marketService,
  now = () => Date.now(),
} = {}) {
  if (!llmClient) throw new Error("stock-analysis 需要注入 llmClient。");
  const tasks = new Map();

  function start(runner) {
    const id = randomUUID();
    tasks.set(id, { id, status: STATUS.QUEUED, createdAt: now() });
    void (async () => {
      tasks.set(id, { ...tasks.get(id), status: STATUS.RUNNING });
      try {
        const result = await runner();
        tasks.set(id, { id, status: STATUS.COMPLETED, createdAt: tasks.get(id).createdAt, result });
      } catch (error) {
        tasks.set(id, {
          id,
          status: STATUS.FAILED,
          createdAt: tasks.get(id).createdAt,
          error: error?.message || "分析失败。",
        });
      }
    })();
    return { id, status: STATUS.QUEUED };
  }

  function get(id) {
    const task = tasks.get(id);
    if (!task) return null;
    const { id: _id, ...rest } = task;
    return { id: _id, ...rest };
  }

  // 个股新闻情绪评分。
  async function startSentiment({ name, note, code, entityContent = null }) {
    return start(async () => {
      const [news, quoteMap] = await Promise.all([
        newsService?.getStockNews?.({ name, code }) ?? [],
        code ? marketService?.getQuotes?.([code]) ?? new Map() : new Map(),
      ]);
      const quote = quoteMap.get(code) ?? null;

      const newsText = news.length
        ? news.map((n) => `- [${n.date ?? "?"}] ${n.title}（${n.mediaName ?? "?"}）`).join("\n")
        : "（无近期新闻数据）";
      const priceText = quote
        ? `现价 ${quote.price ?? "?"} 元，涨跌幅 ${quote.changePct ?? "?"}%`
        : "（无行情数据）";
      const entityText = entityContent || "（无实体页资料）";

      const prompt = `请对以下个股做「新闻情绪 + 逻辑」分析，严格输出 JSON（不要 markdown 围栏）：

公司：${name}${code ? `（${code}）` : ""}
定位：${note ?? "无"}
${priceText}

【近期新闻】
${newsText}

【实体页资料】
${entityText}

请输出 JSON，字段如下（值用中文，简洁）：
{
  "sentiment": "正面|中性|负面|不确定",
  "score": 1-5 的整数（1 最负面，5 最正面），
  "summary": "一句话总结当前情绪与逻辑（80 字内）",
  "drivers": ["2-4 条正向催化或逻辑"],
  "risks": ["2-4 条风险点"],
  "watchPoints": ["2-3 条后续需要跟踪的验证点"]
}`;

      const content = await llmClient.chatCompletion({
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: prompt },
        ],
      });
      const fallback = {
        sentiment: "不确定",
        score: null,
        summary: content.slice(0, 120),
        drivers: [],
        risks: [],
        watchPoints: [],
      };
      return { name, code, price: quote, newsCount: news.length, ...parseJson(content, fallback) };
    });
  }

  // 每日复盘（基于关注股 + 行情 + 定位，不依赖逐股新闻）。
  async function startReview({ stocks = [] }) {
    return start(async () => {
      const withCode = stocks.filter((s) => s.code);
      const quoteMap = withCode.length
        ? await marketService?.getQuotes?.(withCode.map((s) => s.code)) ?? new Map()
        : new Map();

      const lines = stocks.map((s) => {
        const q = s.code ? quoteMap.get(s.code) ?? null : null;
        const price = q ? `${q.price ?? "?"} 元，${q.changePct ?? "?"}%` : "无行情";
        return `- ${s.name}${s.code ? `（${s.code}）` : ""}｜${s.note ?? ""}｜${price}`;
      }).join("\n");

      const prompt = `请基于下面的「重点关注个股清单」生成一份每日复盘，严格输出 JSON（不要 markdown 围栏）：

【关注清单】
${lines || "（空）"}

请输出 JSON，字段如下（值用中文，简洁）：
{
  "overview": "整体一句话点评（100 字内）",
  "notable": ["2-4 条值得注意的个股或板块观察（结合涨跌幅与定位）"],
  "risks": ["2-3 条整体风险提示"],
  "actions": ["2-3 条建议的后续跟踪动作（非买卖指令）"]
}`;

      const content = await llmClient.chatCompletion({
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: prompt },
        ],
      });
      const fallback = {
        overview: content.slice(0, 120),
        notable: [],
        risks: [],
        actions: [],
      };
      return {
        generatedAt: new Date().toISOString(),
        stockCount: stocks.length,
        ...parseJson(content, fallback),
      };
    });
  }

  return Object.freeze({ startSentiment, startReview, get });
}
