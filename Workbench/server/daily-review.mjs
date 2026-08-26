// 每日复盘聚合服务：把指数行情/分时、watchdog 异动、手动事件、AI 总结
// 拼成页面需要的形状。所有外部依赖注入（marketService/config/alerts/repos），
// 服务端各端点只做薄封装。

import { computeMA } from "./market-data.mjs";
import { sessionForNow } from "./stock-analysis.mjs";

const MAX_TIMELINE_ITEMS = 100;

function localDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function normalizeDateParam(value, now) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return localDate(now);
}

function positiveOrNull(value) {
  return typeof value === "number" && value > 0 ? value : null;
}

// 指数行情里的空字段（PE/涨跌停等）在行情层 Number("")=0，这里统一清洗为 null。
function cleanIndexQuote(quote) {
  if (!quote) return null;
  return {
    price: typeof quote.price === "number" ? quote.price : null,
    prevClose: positiveOrNull(quote.prevClose),
    open: positiveOrNull(quote.open),
    high: positiveOrNull(quote.high),
    low: positiveOrNull(quote.low),
    changePct: typeof quote.changePct === "number" ? quote.changePct : null,
    amplitudePct: positiveOrNull(quote.amplitudePct),
    // 行情层 f[37] 成交额单位为万元 → 亿。
    turnoverYi: typeof quote.turnoverWan === "number" && quote.turnoverWan > 0
      ? Math.round(quote.turnoverWan / 10_000)
      : null,
    timestamp: quote.timestamp ?? null,
  };
}

export function createDailyReviewService({
  marketService,
  loadConfig,
  readAlerts,
  eventsRepo,
  reviewStore,
  portfolioRepo = null,
  newsService = null,
  sentimentService = null,
  now = () => Date.now(),
} = {}) {
  if (!marketService) throw new TypeError("daily review requires a market service.");
  if (typeof loadConfig !== "function") throw new TypeError("daily review requires loadConfig.");
  if (typeof readAlerts !== "function") throw new TypeError("daily review requires readAlerts.");
  if (!eventsRepo) throw new TypeError("daily review requires an events repository.");
  if (!reviewStore) throw new TypeError("daily review requires a review store.");

  async function getIndices(date = null) {
    const resolvedDate = normalizeDateParam(date, now());
    const config = await loadConfig();
    const symbols = config.indices.map((index) => index.symbol);
    const quotes = await marketService.getQuotes(symbols);
    const intradayResults = await Promise.all(
      config.indices.map((index) =>
        marketService.getMinuteKlines(index.symbol, { ktype: "m5", date: resolvedDate }),
      ),
    );
    const indices = config.indices.map((index, i) => {
      const quote = quotes.get(index.symbol) ?? null;
      return {
        symbol: index.symbol,
        code: index.code,
        name: index.name,
        quote: cleanIndexQuote(quote),
        intraday: intradayResults[i] ?? [],
        prevCloseReference: positiveOrNull(quote?.prevClose),
      };
    });
    return { date: resolvedDate, generatedAt: new Date(now()).toISOString(), indices };
  }

  async function getIndexDaily(symbol, days = 60) {
    const config = await loadConfig();
    const allowed = new Set(config.indices.map((index) => index.symbol));
    if (typeof symbol !== "string" || !allowed.has(symbol)) {
      const error = new Error("指数不在复盘清单中。");
      error.code = "INDEX_NOT_ALLOWED";
      throw error;
    }
    const resolvedDays = days === 120 ? 120 : 60;
    const klines = await marketService.getDailyKlines(symbol, resolvedDays);
    return { symbol, days: resolvedDays, klines };
  }

  function alertTitle(alert) {
    const labels = {
      surge: "急拉",
      plunge: "急跌",
      limitUp: "触及涨停",
      limitDown: "触及跌停",
    };
    const label = labels[alert.type] ?? "异动";
    return alert.scope === "index" ? `指数${label}` : label;
  }

  async function getTimeline(date = null) {
    const resolvedDate = normalizeDateParam(date, now());
    const [alerts, manual, aiEntry] = await Promise.all([
      readAlerts(),
      eventsRepo.list({ date: resolvedDate }),
      reviewStore.get(resolvedDate),
    ]);

    const items = [];
    for (const alert of alerts?.items ?? []) {
      if (alert.ts?.slice(0, 10) !== resolvedDate) continue;
      items.push({
        id: `alert:${alert.ts}:${alert.code}:${alert.type}`,
        ts: alert.ts,
        source: "watchdog",
        kind: alert.scope === "index" ? "index" : "stock",
        name: alert.name ?? alert.code,
        title: alertTitle(alert),
        changePct: alert.changePct ?? null,
        price: alert.price ?? null,
        tone: alert.type === "surge" || alert.type === "limitUp" ? "up" : "down",
      });
    }
    for (const event of manual) {
      items.push({
        id: event.id,
        ts: event.ts,
        source: "manual",
        kind: "manual",
        title: event.title,
        note: event.note ?? null,
        tone: event.tone ?? "info",
      });
    }
    if (aiEntry) {
      items.push({
        id: "ai-summary",
        ts: `${resolvedDate}T15:05:00.000Z`,
        source: "ai",
        kind: "ai",
        title: aiEntry.session === "intraday" ? "AI 盘中总结" : "AI 每日复盘",
        summary: aiEntry.review?.overview ?? null,
        tone: "note",
        entry: aiEntry,
      });
    }

    items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return { date: resolvedDate, items: items.slice(0, MAX_TIMELINE_ITEMS) };
  }

  // 持仓分析：活跃仓结合行情计算市值/浮盈亏/当日盈亏/权重，已清仓单列历史。
  async function getPortfolio() {
    const positions = await portfolioRepo.list();
    const active = positions.filter((item) => !item.closedAt);
    const closed = positions.filter((item) => item.closedAt);
    const quotes = active.length
      ? await marketService.getQuotes(active.map((item) => item.code))
      : new Map();

    const rows = active.map((item) => {
      const quote = quotes.get(item.code) ?? null;
      const price = quote?.price ?? null;
      const marketValue = price != null ? Math.round(item.shares * price * 100) / 100 : null;
      const pnl = price != null
        ? Math.round((price - item.costPrice) * item.shares * 100) / 100
        : null;
      const pnlPct = price != null && item.costPrice > 0
        ? Math.round(((price - item.costPrice) / item.costPrice) * 10000) / 100
        : null;
      const dayPnl = marketValue != null && quote?.changePct != null
        ? Math.round(marketValue * quote.changePct) / 100
        : null;
      return {
        ...item,
        quote: {
          price,
          prevClose: quote?.prevClose ?? null,
          changePct: quote?.changePct ?? null,
          turnoverPct: quote?.turnoverPct ?? null,
          volumeRatio: quote?.volumeRatio ?? null,
          turnoverYi: typeof quote?.turnoverWan === "number" && quote.turnoverWan > 0
            ? Math.round(quote.turnoverWan / 10_000)
            : null,
        },
        marketValue,
        pnl,
        pnlPct,
        dayPnl,
        weight: null, // 汇总后回填
      };
    });

    const totalValue = rows.reduce((sum, row) => sum + (row.marketValue ?? 0), 0);
    for (const row of rows) {
      row.weight = totalValue > 0 && row.marketValue != null
        ? Math.round((row.marketValue / totalValue) * 1000) / 10
        : null;
    }
    const totalCost = rows.reduce((sum, row) => sum + row.costPrice * row.shares, 0);
    const totals = {
      positions: rows.length,
      marketValue: Math.round(totalValue * 100) / 100,
      cost: Math.round(totalCost * 100) / 100,
      pnl: Math.round((totalValue - totalCost) * 100) / 100,
      pnlPct: totalCost > 0 ? Math.round(((totalValue - totalCost) / totalCost) * 10000) / 100 : null,
      dayPnl: Math.round(rows.reduce((sum, row) => sum + (row.dayPnl ?? 0), 0) * 100) / 100,
      maxWeight: rows.reduce((max, row) => Math.max(max, row.weight ?? 0), 0),
    };

    const closedRows = closed.map((item) => ({
      ...item,
      finalPnl: item.closedPrice != null
        ? Math.round((item.closedPrice - item.costPrice) * item.shares * 100) / 100
        : null,
      finalPnlPct: item.closedPrice != null && item.costPrice > 0
        ? Math.round(((item.closedPrice - item.costPrice) / item.costPrice) * 10000) / 100
        : null,
    }));

    return { generatedAt: new Date(now()).toISOString(), positions: rows, totals, closed: closedRows };
  }

  // 个股当日分时（持仓行展开用，任何 6 位个股代码均可）。
  async function getStockIntraday(code, date = null) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      const error = new Error("个股代码必须是 6 位数字。");
      error.code = "INVALID_STOCK_CODE";
      throw error;
    }
    const resolvedDate = normalizeDateParam(date, now());
    const [quotes, intraday] = await Promise.all([
      marketService.getQuotes([code]),
      marketService.getMinuteKlines(code, { ktype: "m5", date: resolvedDate }),
    ]);
    const prevClose = positiveOrNull(quotes.get(code)?.prevClose);
    return { code, date: resolvedDate, intraday, prevCloseReference: prevClose };
  }

  // 供 LLM generate 端点取上下文（四段式复盘教练的输入）。
  // watchStocks 由路由从页面关注清单传入（[{name, code, note}]）。
  async function collectReviewContext(date = null, watchStocks = []) {
    const resolvedDate = normalizeDateParam(date, now());
    const [indicesResult, timeline, portfolio] = await Promise.all([
      getIndices(resolvedDate),
      getTimeline(resolvedDate),
      portfolioRepo ? getPortfolio() : Promise.resolve(null),
    ]);

    const indices = indicesResult.indices.map((index) => ({
      name: index.name,
      close: index.quote?.price ?? null,
      changePct: index.quote?.changePct ?? null,
      amplitudePct: index.quote?.amplitudePct ?? null,
      turnoverYi: index.quote?.turnoverYi ?? null,
    }));
    // 两市成交额口径：上证指数（全沪市）+ 深证成指（成分），近似值。
    const sh = indices.find((item) => item.name === "上证指数");
    const sz = indices.find((item) => item.name === "深证成指");
    const market = {
      turnoverYi: sh?.turnoverYi != null && sz?.turnoverYi != null
        ? sh.turnoverYi + sz.turnoverYi
        : null,
      note: "口径：上证指数+深证成指成分合计（近似）；环比[待补充]",
    };

    // 持仓增强：均线/60日高低/近5日收盘 + 当日新闻标题。
    const positions = [];
    for (const row of portfolio?.positions ?? []) {
      const klines = await marketService.getDailyKlines(row.code, 70);
      const ma = klines.length ? computeMA(klines, [5, 20, 60]) : {};
      const high60 = klines.length ? Math.max(...klines.map((k) => k.high)) : null;
      const low60 = klines.length ? Math.min(...klines.map((k) => k.low)) : null;
      let news = [];
      if (newsService && row.code) {
        try {
          const result = await newsService.getStockNews({ name: row.name, code: row.code });
          news = (result?.items ?? result ?? []).slice(0, 3)
            .map((item) => item?.title ?? item?.name)
            .filter(Boolean);
        } catch { /* 新闻失败静默，prompt 标[待补充] */ }
      }
      positions.push({
        name: row.name ?? row.code,
        code: row.code,
        shares: row.shares,
        costPrice: row.costPrice,
        price: row.quote?.price ?? null,
        changePct: row.quote?.changePct ?? null,
        turnoverPct: row.quote?.turnoverPct ?? null,
        volumeRatio: row.quote?.volumeRatio ?? null,
        pnlPct: row.pnlPct,
        weight: row.weight,
        note: row.note,
        ma5: ma.ma5 ?? null,
        ma20: ma.ma20 ?? null,
        ma60: ma.ma60 ?? null,
        high60,
        low60,
        last5Closes: klines.slice(-5).map((k) => k.close),
        news,
      });
    }

    // 关注清单增强：行情四要素。
    const watchCodes = watchStocks.filter((s) => s?.code).map((s) => s.code);
    const watchQuotes = watchCodes.length
      ? await marketService.getQuotes(watchCodes)
      : new Map();
    const watch = watchStocks.map((stock) => {
      const quote = stock.code ? watchQuotes.get(stock.code) ?? null : null;
      return {
        name: stock.name,
        code: stock.code ?? null,
        note: stock.note ?? null,
        changePct: quote?.changePct ?? null,
        turnoverPct: quote?.turnoverPct ?? null,
        volumeRatio: quote?.volumeRatio ?? null,
      };
    });

    const events = timeline.items
      .filter((item) => item.source !== "ai")
      .map((item) => ({
        ts: item.ts,
        source: item.source === "watchdog" ? (item.kind === "index" ? "指数异动" : "个股异动") : "手动",
        title: `${item.title} ${item.name ?? ""}`.trim(),
        changePct: item.changePct ?? null,
      }));
    const sentiment = sentimentService
      ? await sentimentService.getSentiment().catch(() => null)
      : null;
    return {
      date: resolvedDate,
      session: sessionForNow(new Date(now())),
      indices,
      market,
      sentiment,
      positions,
      watch,
      events,
    };
  }

  return Object.freeze({
    getIndices,
    getIndexDaily,
    getTimeline,
    collectReviewContext,
    getPortfolio,
    getStockIntraday,
  });
}
