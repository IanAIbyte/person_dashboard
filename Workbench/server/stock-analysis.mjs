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

function fmtPct(value) {
  if (value == null || !Number.isFinite(Number(value))) return "?%";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function rnd(value) {
  if (value == null || !Number.isFinite(Number(value))) return "?";
  return Number(value).toFixed(2);
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

  // 每日复盘（关注股 + 指数 + 当前持仓 + 当日事件时间线 + 各股监控清单）。
  async function startReview({ stocks = [], indices = [], events = [], positions = [] }) {
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

      const indexLines = indices
        .map((i) => `- ${i.name}｜${i.changePct ?? "?"}%${i.note ? `｜${i.note}` : ""}`)
        .join("\n");
      const positionLines = positions
        .map((p) => {
          const weight = p.weight != null ? `权重 ${p.weight}%` : "权重 ?";
          const pnl = p.pnlPct != null ? `${p.pnlPct > 0 ? "+" : ""}${p.pnlPct}%` : "?";
          const day = p.dayPnlPct != null ? `当日 ${p.dayPnlPct > 0 ? "+" : ""}${p.dayPnlPct}%` : "当日 ?";
          return `- ${p.name}｜${weight}｜浮盈亏 ${pnl}｜${day}${p.note ? `｜${p.note}` : ""}`;
        })
        .join("\n");
      const eventLines = events
        .map((e) => `- [${e.ts?.slice(11, 16) ?? "?"}] ${e.source ?? ""} ${e.title ?? ""}${e.changePct != null ? `（${e.changePct}%）` : ""}`)
        .join("\n");

      const prompt = `请基于下面的「重点关注个股清单」生成一份每日复盘，严格输出 JSON（不要 markdown 围栏）：

【关注清单】
${lines || "（空）"}

【今日指数】
${indexLines || "（空）"}

【当前持仓】
${positionLines || "（空）"}

【当日事件时间线】
${eventLines || "（空）"}

请输出 JSON，字段如下（值用中文，简洁）：
{
  "overview": "整体一句话点评（100 字内，先讲指数与大盘节奏，再讲持仓）",
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

  // 四段式复盘教练（每日复盘页面「AI 每日总结」）：输出 markdown，
  // 数据缺口按约定标 [待补充]，事实与推测强制区分。
  async function startCoachReview(context = {}) {
    return start(async () => {
      const lines = [];
      lines.push("【今日指数】");
      for (const index of context.indices ?? []) {
        lines.push(`- ${index.name}｜收盘 ${index.close ?? "?"}｜${fmtPct(index.changePct)}｜振幅 ${index.amplitudePct ?? "?"}%｜成交额 ${index.turnoverYi ?? "?"} 亿`);
      }
      lines.push(`- 两市成交额：${context.market?.turnoverYi ?? "?"} 亿（${context.market?.note ?? ""}）`);
      lines.push("");
      lines.push("【当前持仓】（含技术位与成本）");
      for (const position of context.positions ?? []) {
        lines.push([
          `- ${position.name}（${position.code}）｜股数 ${position.shares}｜成本 ${position.costPrice}｜现价 ${position.price ?? "?"}｜今日 ${fmtPct(position.changePct)}｜换手 ${position.turnoverPct ?? "?"}%｜量比 ${position.volumeRatio ?? "?"}｜浮盈亏 ${fmtPct(position.pnlPct)}｜权重 ${position.weight ?? "?"}%`,
          `  均线 MA5/${rnd(position.ma5)} MA20/${rnd(position.ma20)} MA60/${rnd(position.ma60)}｜60日高 ${rnd(position.high60)} 低 ${rnd(position.low60)}｜近5日收盘 ${JSON.stringify(position.last5Closes ?? [])}｜备注 ${position.note ?? "无"}`,
          `  当日新闻 ${position.news?.length ? position.news.join("；") : "[待补充]"}`,
        ].join("\n"));
      }
      if ((context.positions ?? []).length === 0) lines.push("- （空仓）");
      lines.push("");
      lines.push("【关注清单】");
      for (const stock of context.watch ?? []) {
        lines.push(`- ${stock.name}${stock.code ? `（${stock.code}）` : ""}｜今日 ${fmtPct(stock.changePct)}｜换手 ${stock.turnoverPct ?? "?"}%｜量比 ${stock.volumeRatio ?? "?"}｜定位 ${stock.note ?? "无"}`);
      }
      if ((context.watch ?? []).length === 0) lines.push("- （空）");
      lines.push("");
      lines.push("【当日事件时间线】");
      for (const event of context.events ?? []) {
        lines.push(`- [${event.ts?.slice(11, 16) ?? "?"}] ${event.source} ${event.title}${event.changePct != null ? `（${event.changePct}%）` : ""}`);
      }
      if ((context.events ?? []).length === 0) lines.push("- （空）");

      const prompt = `今天是 ${context.date ?? "[日期缺失]"}。请基于下面的真实数据，严格执行四段式复盘。你的角色：15 年实盘经验的 A 股职业操盘手兼复盘教练——数据先行、逻辑严格、只讲事实与概率；不吹票、不荐股、不迎合；发现用户逻辑漏洞或情绪化操作直接指出。

${lines.join("\n")}

# 输出要求（Markdown，直接以正文开始，不要代码围栏）

## 一、大盘与情绪面
指数收盘与涨跌幅；两市成交额（环比[待补充]）。赚钱效应数据（涨跌家数/涨停跌停家数/连板高度/炸板率/晋级率/领涨领跌板块/北证50）系统暂未采集，逐项标注 [待补充]，但你可以基于给出的指数与振幅数据做有限的情绪推断，推断必须以「判断：」前缀并附依据与置信度（高/中/低）。用「冰点→回暖→发酵→高潮→分歧→退潮」框架定位当前情绪阶段，并给明日倾向预判（同样走「判断：」格式）。当日事件时间线为消息面素材。

## 二、持仓个股诊断（逐只，勿遗漏）
每只小节呈现：当日表现（涨跌幅/换手/量比/相对成本浮盈%）；技术面（日K形态一句话、关键支撑与压力位——必须基于给出的 60日高低/均线/近5日收盘给具体价位并注明依据，均线多空排列）；量价信号（放量上涨/缩量回调/放量滞涨/破位下跌四选一）；消息面（基于给出的当日新闻，无则[待补充]）；逻辑检验（对照备注的买入定位，被验证/中性/被破坏三选一）；操作建议（持有/加仓/减仓/清仓倾向+触发条件=具体价位+盘面信号+止损位）。所有建议必须同时附触发与失效条件，禁用「必涨」类表述。

## 三、关注列表跟踪（逐只）
当日表现一句话；距触发买点多远（基于现价与定位推断，价格距离%或等待什么信号）；结论三选一（继续观察/接近买点/逻辑走弱建议移出）。量比>2 或涨跌幅超±5% 的标注 ⚡ 并展开 3-5 句。

## 四、明日作战计划
大盘强势/中性/弱势三情景及粗略概率（「判断：」格式）与总仓位框架；每只持仓的明日预案（触发价/动作/仓位变化量/失效条件）；关注列表到达什么价位或信号可关注哪只（建议观察仓位与止损位）；2-3 个明日风险点（基于已有信息合理列出，无足够信息则说明）。

# 硬约束
1. 价格 2 位小数、百分比 2 位小数；事实直接陈述，推测必须「判断：」前缀+依据+置信度。
2. 数据缺口标 [待补充]，严禁编造任何价格、成交量、新闻、公告。
3. 不迎合既有观点：持仓逻辑若已破坏而用户未察觉，直接点明。
4. 结尾用不超过 3 句话总结今日复盘核心结论（以「**今日核心**：」开头）。`;

      const content = await llmClient.chatCompletion({
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: prompt },
        ],
        // 四段式长文 + 27 只关注股逐只跟踪，生成时长波动大（实测 190-400s+）。
        timeoutMs: 600_000,
      });
      const markdown = content.trim();
      return {
        generatedAt: new Date().toISOString(),
        markdown,
        overview: markdown.replace(/[#*`>\-]/g, "").slice(0, 120),
      };
    });
  }

  return Object.freeze({ startSentiment, startResearch, startReview, startCoachReview, get });
}
