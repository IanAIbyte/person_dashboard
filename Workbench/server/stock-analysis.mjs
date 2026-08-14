// 个股 AI 分析 service：新闻情绪评分 + 每日复盘 + 研究报告。
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

// 研究报告专用原则（源自「把投资分析变成你的日常」研究方法论）：
// 事实与判断分开、强制空方逻辑对抗确认偏误、评级是研究判断而非操作指令。
function researchSystemPrompt() {
  return [
    systemPrompt(),
    "你在生成一份个股研究报告，必须遵守以下研究原则：",
    "1. 严格区分【事实】与【判断】：事实底座只写可核实信息；评级、分歧、幕僚观点属于判断，必须基于给定信息推理。",
    "2. 必须给出空方逻辑与反证，不得只顺着利好方向陈述。",
    "3. rating.verdict 是研究评级（积极关注/中性观察/谨慎/回避），不是买卖指令。",
    "4. 私董会四位幕僚观点允许尖锐对立，分歧本身就是输出价值，不需要强行统一。",
  ].join("\n");
}

// 收集个股研究素材：近期新闻 + 实时行情（同 startSentiment）。
async function collectResearchContext({ name, code, note, entityContent }, newsService, marketService) {
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
  return { news, quote, newsText, priceText, entityText: entityContent || "（无实体页资料）" };
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
      const { news, quote, newsText, priceText, entityText } = await collectResearchContext(
        { name, note, code, entityContent },
        newsService,
        marketService,
      );

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

  // 个股研究报告：按「事实底座 → 技术面速读 → 四维评级 → 多空分歧 → 私董会 → 监控清单」
  // 的研究方法论框架输出结构化 JSON。前端生成后持久化到 stock-research 存储。
  async function startResearch({ name, note, code, entityContent = null }) {
    return start(async () => {
      const { news, quote, newsText, priceText, entityText } = await collectResearchContext(
        { name, note, code, entityContent },
        newsService,
        marketService,
      );

      const prompt = `请基于以下素材，为这只个股生成一份结构化研究报告，严格输出 JSON（不要 markdown 围栏）：

公司：${name}${code ? `（${code}）` : ""}
定位：${note ?? "无"}
${priceText}

【近期新闻】
${newsText}

【实体页资料】
${entityText}

按下面的 JSON 结构输出（值用中文，判断要克制、不喊口号）：
{
  "facts": {
    "oneLiner": "一句话概括这门生意（卖什么→卖给谁→靠什么赚钱，50 字内）",
    "business": ["2-4 条核心业务/产品线要点"],
    "industry": "所处行业与板块",
    "position": "在产业链中的位置（上游/中游/下游及环节）",
    "limitations": "本次素材的数据边界（如：无财报数据，仅基于新闻与行情）"
  },
  "technicals": {
    "trend": "当前趋势一句话（基于行情与新闻中的价格信息）",
    "signals": ["2-4 条值得注意的技术面/量价信号"],
    "support": ["1-3 个关键支撑位（价格或依据，缺失则写「缺失」）"],
    "resistance": ["1-3 个关键压力位（价格或依据，缺失则写「缺失」）"],
    "dataNote": "技术面数据边界说明（素材无 K 线历史时如实说明）"
  },
  "rating": {
    "dimensions": [
      { "key": "technicals", "label": "技术面", "score": 0-5, "weight": 0.25, "comment": "一句话依据" },
      { "key": "fundamentals", "label": "基本面", "score": 0-5, "weight": 0.30, "comment": "一句话依据" },
      { "key": "valuation", "label": "估值水平", "score": 0-5, "weight": 0.25, "comment": "一句话依据" },
      { "key": "liquidity", "label": "资金面", "score": 0-5, "weight": 0.20, "comment": "一句话依据" }
    ],
    "total": "四维加权总分（0-5，保留两位小数，与 dimensions 一致）",
    "verdict": "积极关注|中性观察|谨慎|回避",
    "oneLiner": "核心结论一句话（80 字内，克制表述）"
  },
  "debate": {
    "bulls": [{ "point": "多方核心论点", "evidence": "支撑证据（来自素材，缺失则说明）" }],
    "bears": [{ "point": "空方核心论点", "evidence": "支撑证据（来自素材，缺失则说明）" }],
    "verifications": ["2-4 条哪些分歧可被未来数据/事件验证，及关键验证节点"]
  },
  "boardroom": [
    { "name": "巴菲特", "stance": "立场（如 回避/观望/看多）", "view": "从价值投资角度的一句话观点" },
    { "name": "马斯克", "stance": "立场", "view": "从科技趋势角度的一句话观点" },
    { "name": "比尔·盖茨", "stance": "立场", "view": "从商业模式与行业格局角度的一句话观点" },
    { "name": "乔布斯", "stance": "立场", "view": "从产品力角度的一句话观点" }
  ],
  "monitor": [
    { "type": "reinforce", "event": "当某事件/数据发生时", "action": "强化当前逻辑，做什么跟踪" },
    { "type": "falsify", "event": "一旦某数据恶化/证伪条件触发", "action": "逻辑证伪，重新评估" }
  ],
  "sentiment": {
    "sentiment": "正面|中性|负面|不确定",
    "score": 1-5 的整数,
    "summary": "一句话新闻情绪总结（80 字内）"
  }
}`;

      const content = await llmClient.chatCompletion({
        messages: [
          { role: "system", content: researchSystemPrompt() },
          { role: "user", content: prompt },
        ],
      });
      const fallback = {
        facts: { oneLiner: null, business: [], industry: null, position: null, limitations: content.slice(0, 120) },
        technicals: { trend: null, signals: [], support: [], resistance: [], dataNote: null },
        rating: { dimensions: [], total: null, verdict: null, oneLiner: content.slice(0, 120) },
        debate: { bulls: [], bears: [], verifications: [] },
        boardroom: [],
        monitor: [],
        sentiment: { sentiment: "不确定", score: null, summary: content.slice(0, 120) },
      };
      return {
        name,
        code,
        price: quote,
        newsCount: news.length,
        generatedAt: new Date().toISOString(),
        ...parseJson(content, fallback),
      };
    });
  }

  // 每日复盘（基于关注股 + 行情 + 定位 + 各股监控清单，不依赖逐股新闻）。
  async function startReview({ stocks = [] }) {
    return start(async () => {
      const withCode = stocks.filter((s) => s.code);
      const quoteMap = withCode.length
        ? await marketService?.getQuotes?.(withCode.map((s) => s.code)) ?? new Map()
        : new Map();

      const lines = stocks.map((s) => {
        const q = s.code ? quoteMap.get(s.code) ?? null : null;
        const price = q ? `${q.price ?? "?"} 元，${q.changePct ?? "?"}%` : "无行情";
        const monitors = Array.isArray(s.monitor) && s.monitor.length
          ? s.monitor
            .map((m) => `[${m?.type === "falsify" ? "证伪" : "强化"}] ${m?.event ?? ""}${m?.action ? `→ ${m.action}` : ""}`)
            .join("；")
          : "";
        return `- ${s.name}${s.code ? `（${s.code}）` : ""}｜${s.note ?? ""}｜${price}${monitors ? `｜监控：${monitors}` : ""}`;
      }).join("\n");

      const prompt = `请基于下面的「重点关注个股清单」生成一份每日复盘，严格输出 JSON（不要 markdown 围栏）：

【关注清单】
${lines || "（空）"}

请输出 JSON，字段如下（值用中文，简洁）：
{
  "overview": "整体一句话点评（100 字内）",
  "notable": ["2-4 条值得注意的个股或板块观察（结合涨跌幅与定位）"],
  "risks": ["2-3 条整体风险提示"],
  "actions": ["2-3 条建议的后续跟踪动作（非买卖指令）"],
  "verifications": [
    { "stock": "公司名", "event": "临近或当日可验证的监控事件", "type": "reinforce|falsify", "note": "验证结果或待验证说明" }
  ]
}
verifications 仅汇总清单中「监控」字段的验证节点，没有则输出空数组，不要编造。`;

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
        verifications: [],
      };
      return {
        generatedAt: new Date().toISOString(),
        stockCount: stocks.length,
        ...parseJson(content, fallback),
      };
    });
  }

  return Object.freeze({ startSentiment, startResearch, startReview, get });
}
