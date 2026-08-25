// 每日复盘聚合服务：把指数行情/分时、watchdog 异动、手动事件、AI 总结
// 拼成页面需要的形状。所有外部依赖注入（marketService/config/alerts/repos），
// 服务端各端点只做薄封装。

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
    timestamp: quote.timestamp ?? null,
  };
}

export function createDailyReviewService({
  marketService,
  loadConfig,
  readAlerts,
  eventsRepo,
  reviewStore,
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
        title: "AI 每日复盘",
        summary: aiEntry.review?.overview ?? null,
        tone: "note",
        entry: aiEntry,
      });
    }

    items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return { date: resolvedDate, items: items.slice(0, MAX_TIMELINE_ITEMS) };
  }

  // 供 LLM generate 端点取上下文。
  async function collectReviewContext(date = null) {
    const resolvedDate = normalizeDateParam(date, now());
    const [indicesResult, timeline] = await Promise.all([
      getIndices(resolvedDate),
      getTimeline(resolvedDate),
    ]);
    const indices = indicesResult.indices.map((index) => ({
      name: index.name,
      changePct: index.quote?.changePct ?? null,
    }));
    const events = timeline.items
      .filter((item) => item.source !== "ai")
      .map((item) => ({
        ts: item.ts,
        source: item.source === "watchdog" ? (item.kind === "index" ? "指数异动" : "个股异动") : "手动",
        title: `${item.title} ${item.name ?? ""}`.trim(),
        changePct: item.changePct ?? null,
      }));
    return { date: resolvedDate, indices, events };
  }

  return Object.freeze({ getIndices, getIndexDaily, getTimeline, collectReviewContext });
}
