import {
  fallbackCollections,
  fallbackDouyinWorks,
  fallbackOverview,
  fallbackSearchResults,
} from "../data/fallback";
import {
  httpApiError,
  normalizeApiFailure,
} from "./api-errors";
import { createDailyHotLoader } from "../../shared/ai-hot.mjs";

export { countNewDailyHotItems } from "../../shared/ai-hot.mjs";

const DEFAULT_TIMEOUT = 12_000;

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeout ?? DEFAULT_TIMEOUT);

  try {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw normalizeApiFailure(error);
    }

    if (!response.ok) {
      const body = await response.text();
      throw httpApiError(
        response.status,
        body,
        response.headers.get("content-type") || "",
      );
    }

    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

async function withFallback(loader, fallback) {
  try {
    const data = await loader();
    return { data, source: "live", error: null };
  } catch (error) {
    return {
      data: typeof fallback === "function" ? fallback() : fallback,
      source: "fallback",
      error,
    };
  }
}

// GET 响应的 stale-while-revalidate 缓存：命中新鲜缓存直接返回；缓存陈旧
// 时立即返回旧数据并后台刷新（下次挂载即新数据）；无缓存才真正请求。
// 目的：路由切换二次进入页面时秒出内容，消除「loading 骨架 → 请求」的刷新感。
const getCache = new Map(); // path -> { data, at }
const getInflight = new Map(); // path -> Promise

export function cachedGet(path, ttlMs = 5 * 60_000) {
  const hit = getCache.get(path);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) {
    return Promise.resolve(hit.data);
  }
  if (hit) {
    // 陈旧：先回旧数据，后台静默刷新。
    void request(path)
      .then((data) => getCache.set(path, { data, at: Date.now() }))
      .catch(() => {});
    return Promise.resolve(hit.data);
  }
  const inflight = getInflight.get(path);
  if (inflight) return inflight;
  const pending = request(path)
    .then((data) => {
      getCache.set(path, { data, at: Date.now() });
      return data;
    })
    .finally(() => getInflight.delete(path));
  getInflight.set(path, pending);
  return pending;
}

// mutation 后失效相关 GET 缓存（支持前缀匹配）；无参清空全部。
export function invalidateCache(prefix = null) {
  if (!prefix) {
    getCache.clear();
    return;
  }
  for (const key of getCache.keys()) {
    if (key.startsWith(prefix)) getCache.delete(key);
  }
}

export function loadOverview() {
  // ttl 45s：短于页面的 60s 轮询，轮询仍能拿到真数据；二次进入秒出缓存。
  return withFallback(() => cachedGet("/api/overview", 45_000), fallbackOverview);
}

let dailyHotLoader = null;
let dailyHotStrategyKey = null;

async function configuredDailyHotLoader() {
  let strategy = null;
  try {
    strategy = await request("/api/config/attention");
  } catch {
    // Hosted/static builds use the shared neutral default.
  }
  const key = JSON.stringify(strategy ?? {});
  if (!dailyHotLoader || key !== dailyHotStrategyKey) {
    dailyHotLoader = createDailyHotLoader({
      requestTimeoutMs: 20_000,
      strategy,
    });
    dailyHotStrategyKey = key;
  }
  return dailyHotLoader;
}

const unavailableDailyHot = {
  schemaVersion: 1,
  status: "unavailable",
  fetchedAt: null,
  source: {
    name: "AI HOT",
    url: "https://aihot.virxact.com/agent",
  },
  policy: null,
  daily: null,
  counts: {
    upstreamHot: null,
    upstreamSelected24h: null,
    mustRead: 0,
    browse: 0,
    other: 0,
  },
  tiers: {
    mustRead: [],
    browse: [],
    other: [],
  },
  error: {
    code: "AI_HOT_DATA_SERVICE_UNAVAILABLE",
    message: "AI HOT 暂时无法读取。",
  },
};

export async function loadDailyHot({ refresh = false } = {}) {
  try {
    const loader = await configuredDailyHotLoader();
    const data = await loader({ force: refresh });
    return { data, source: "live", error: null };
  } catch (error) {
    return {
      data: unavailableDailyHot,
      source: "fallback",
      error: normalizeApiFailure(error),
    };
  }
}

export function loadCollection(kind, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  });

  return withFallback(
    () => cachedGet(`/api/collections/${kind}?${search.toString()}`),
    () => {
      const overviewRows =
        kind === "wiki"
          ? fallbackSearchResults.filter((item) => item.layer === "wiki")
          : kind === "materials"
            ? fallbackSearchResults.filter((item) => item.layer === "raw")
            : kind === "archive"
              ? fallbackSearchResults.filter((item) => item.layer === "run")
              : fallbackSearchResults;

      return {
        items: overviewRows,
        groups: fallbackCollections[kind] ?? [],
        total: overviewRows.length,
      };
    },
  );
}

const emptyMaterialsHome = {
  generatedAt: null,
  root: null,
  folders: [],
  queue: [],
  queuePreview: [],
  recent: [],
  total: 0,
};

export function loadMaterialsHome() {
  return withFallback(() => request("/api/materials"), emptyMaterialsHome);
}

export function loadBooks() {
  return withFallback(
    () => cachedGet("/api/books"),
    { generatedAt: null, total: 0, chapterTotal: 0, books: [] },
  );
}

export function loadMaterialFolder(relativePath) {
  const search = new URLSearchParams({ path: relativePath });
  return withFallback(
    () => request(`/api/materials/folder?${search.toString()}`),
    {
      generatedAt: null,
      folder: null,
      breadcrumbs: [],
      folders: [],
      items: [],
    },
  );
}

export function loadMaterialReadingQueue() {
  return withFallback(
    () => request("/api/material-reading-queue"),
    { updatedAt: null, total: 0, items: [] },
  );
}

export function addMaterialToReadingQueue(documentId, contentHash = undefined) {
  return request("/api/material-reading-queue", {
    method: "POST",
    body: JSON.stringify({
      documentId,
      ...(contentHash ? { contentHash } : {}),
    }),
  });
}

export function removeMaterialFromReadingQueue(documentId) {
  return request(`/api/material-reading-queue/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  });
}

export function searchVault(query, filters = {}) {
  const search = new URLSearchParams({ q: query });
  Object.entries(filters).forEach(([key, value]) => {
    if (value) search.set(key, String(value));
  });

  return withFallback(
    () => request(`/api/search?${search.toString()}`),
    () => ({
      query,
      total: fallbackSearchResults.filter((item) => {
        const haystack = `${item.title} ${item.section} ${item.excerpt ?? ""}`.toLowerCase();
        return !query || haystack.includes(query.toLowerCase());
      }).length,
      items: fallbackSearchResults.filter((item) => {
        const haystack = `${item.title} ${item.section} ${item.excerpt ?? ""}`.toLowerCase();
        return !query || haystack.includes(query.toLowerCase());
      }),
    }),
  );
}

export function loadDocument(id) {
  return withFallback(
    () => request(`/api/documents/${encodeURIComponent(id)}`),
    null,
  );
}

export function loadReaderNotes(documentId) {
  const search = new URLSearchParams({ documentId: String(documentId) });
  return request(`/api/reader-notes?${search.toString()}`);
}

export function saveReaderNote(payload) {
  return request("/api/reader-notes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteReaderNote(noteId, documentId) {
  const search = new URLSearchParams({ documentId: String(documentId) });
  return request(
    `/api/reader-notes/${encodeURIComponent(noteId)}?${search.toString()}`,
    { method: "DELETE" },
  );
}

export function loadReaderExplanations(documentId) {
  const search = new URLSearchParams({ documentId: String(documentId) });
  return request(`/api/reader-explanations?${search.toString()}`);
}

export function loadReaderExplanation(analysisId, documentId) {
  const search = new URLSearchParams({ documentId: String(documentId) });
  return request(
    `/api/reader-explanations/${encodeURIComponent(analysisId)}?${search.toString()}`,
  );
}

export function startReaderExplanation(payload) {
  return request("/api/reader-explanations", {
    method: "POST",
    body: JSON.stringify(payload),
    timeout: 30_000,
  });
}

export function followUpReaderExplanation(analysisId, payload) {
  return request(
    `/api/reader-explanations/${encodeURIComponent(analysisId)}/follow-up`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      timeout: 30_000,
    },
  );
}

export function saveReaderExplanationToNote(analysisId, payload) {
  return request(
    `/api/reader-explanations/${encodeURIComponent(analysisId)}/save-note`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      timeout: 30_000,
    },
  );
}

export function startWikiIngest(documentId) {
  return request("/api/wiki-ingest", {
    method: "POST",
    body: JSON.stringify({ documentId }),
    timeout: 30_000,
  });
}

export function loadWikiIngestJob(jobId) {
  return request(`/api/wiki-ingest/jobs/${encodeURIComponent(jobId)}`);
}

export function loadWikiIngestRecovery(documentId) {
  return request(`/api/wiki-ingest/recovery?documentId=${encodeURIComponent(documentId)}`);
}

export function sendWikiIngestMessage(jobId, message, kind = "query") {
  return request(`/api/wiki-ingest/jobs/${encodeURIComponent(jobId)}/message`, {
    method: "POST",
    body: JSON.stringify({ message, kind }),
    timeout: 30_000,
  });
}

export function confirmWikiIngestJob(jobId, expectedReviewVersion) {
  return request(`/api/wiki-ingest/jobs/${encodeURIComponent(jobId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ expectedReviewVersion }),
    timeout: 30_000,
  });
}

export function createWikiIngestClientHandoff(jobId, expectedReviewVersion) {
  return request(`/api/wiki-ingest/jobs/${encodeURIComponent(jobId)}/handoff`, {
    method: "POST",
    body: JSON.stringify({ expectedReviewVersion }),
    timeout: 30_000,
  });
}

export function cancelWikiIngestJob(jobId) {
  return request(`/api/wiki-ingest/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    timeout: 30_000,
  });
}

export function createWikiIngestEventSource(jobId) {
  return new EventSource(`/api/wiki-ingest/jobs/${encodeURIComponent(jobId)}/events`);
}

export function loadGraph() {
  return withFallback(() => cachedGet("/api/graph"), {
    generatedAt: null,
    stats: { nodeCount: 0, edgeCount: 0, isolatedCount: 0 },
    typeCounts: {},
    nodes: [],
    edges: [],
  });
}

export function loadDouyinWorks(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) search.set(key, String(value));
  });

  return withFallback(
    () => request(`/api/douyin/works?${search.toString()}`),
    {
      generatedAt: null,
      total: fallbackDouyinWorks.length,
      items: fallbackDouyinWorks,
      comparableCount: null,
      summary: {},
      summaryLowerBounds: {},
      contentLines: [],
      formats: [],
      roles: [],
      monthly: [],
      reviewStatusCounts: {
        public: null,
        private: null,
      },
      available: false,
      sourcePath: null,
      sourceUpdatedAt: null,
      range: {
        from: null,
        to: null,
      },
      qualityIssues: [],
      qualityFlags: ["data_service_unavailable"],
      analytics: null,
    },
  );
}

export function loadSocialInsights() {
  return withFallback(
    () => request("/api/social-insights"),
    {
      available: false,
      generatedAt: null,
      total: null,
      items: [],
    },
  );
}

export function loadCareer() {
  return withFallback(
    () => cachedGet("/api/career"),
    {
      available: false,
      generatedAt: null,
      report: null,
      campaign: null,
      questionBanks: { curated: [], raw: [] },
      concepts: [],
      coverage: { roles: false, matrix: false },
      placeholderHints: {
        roles: "待运行岗位扫描",
        matrix: "待运行技能差距分析",
      },
    },
  );
}

export function loadStockUniverse() {
  return withFallback(
    () => cachedGet("/api/stock-universe"),
    { generatedAt: null, total: 0, chains: [] },
  );
}

export function loadStockWatchlist() {
  return withFallback(
    () => cachedGet("/api/stock-watchlist"),
    { updatedAt: null, total: 0, items: [] },
  );
}

export function followStock(name) {
  return request("/api/stock-watchlist", {
    method: "POST",
    body: JSON.stringify({ name }),
  }).then((result) => {
    invalidateCache("/api/stock-watchlist");
    return result;
  });
}

export function unfollowStock(name) {
  return request(`/api/stock-watchlist/${encodeURIComponent(name)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  }).then((result) => {
    invalidateCache("/api/stock-watchlist");
    return result;
  });
}

export function updateStockMeta(name, meta) {
  return request(`/api/stock-watchlist/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(meta),
  }).then((result) => {
    invalidateCache("/api/stock-watchlist");
    return result;
  });
}

export function loadStockCodes() {
  return withFallback(
    () => cachedGet("/api/stock-codes"),
    { updatedAt: null, items: [] },
  );
}

export function setStockCode(name, code) {
  return request("/api/stock-codes", {
    method: "PUT",
    body: JSON.stringify({ name, code }),
  }).then((result) => {
    invalidateCache("/api/stock-codes");
    invalidateCache("/api/stock-universe");
    return result;
  });
}

export function loadMarketQuotes(codes) {
  const search = new URLSearchParams();
  for (const code of codes) search.append("codes", code);
  // 行情时效性强，ttl 与服务端行情缓存一致（60s）。
  return withFallback(
    () => cachedGet(`/api/market/quotes?${search.toString()}`, 60_000),
    { items: [] },
  );
}

export function loadStockNews(name, code) {
  const search = new URLSearchParams({ name });
  if (code) search.set("code", code);
  return withFallback(
    () => cachedGet(`/api/stock-news?${search.toString()}`),
    { name, items: [] },
  );
}

// ===== 监控台 v2：股票池 / 财务 / 技术 / 异动 / 盯盘配置 / 估值 =====

export function loadStockPool() {
  return withFallback(
    () => cachedGet("/api/stock-pool"),
    { generatedAt: null, total: 0, items: [] },
  );
}

export function addStockPoolItem(payload) {
  return request("/api/stock-pool", {
    method: "POST",
    body: JSON.stringify(payload),
  }).then((result) => {
    invalidateCache("/api/stock-pool");
    return result;
  });
}

export function removeStockPoolItem(name) {
  return request(`/api/stock-pool/${encodeURIComponent(name)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  }).then((result) => {
    invalidateCache("/api/stock-pool");
    return result;
  });
}

export function loadStockFinancials(code) {
  return withFallback(
    () => cachedGet(`/api/stock-financials?code=${encodeURIComponent(code)}`),
    { code, available: false, periods: [] },
  );
}

export function loadStockTechnicals(code) {
  return withFallback(
    () => cachedGet(`/api/stock-technicals?code=${encodeURIComponent(code)}`),
    { code, klineCount: 0, latest: null, ma: {}, trend: "unknown" },
  );
}

export function loadStockAlerts() {
  return withFallback(
    () => cachedGet("/api/stock-alerts", 30_000),
    { updatedAt: null, total: 0, items: [] },
  );
}

export function loadWatchdogConfig() {
  return withFallback(
    () => cachedGet("/api/watchdog-config", 10_000),
    { pushConfigured: false, config: null },
  );
}

export function updateWatchdogConfig(patch) {
  return request("/api/watchdog-config", {
    method: "PUT",
    body: JSON.stringify(patch),
  }).then((result) => {
    invalidateCache("/api/watchdog-config");
    return result;
  });
}

export function loadValuationHistory(code) {
  return withFallback(
    () => cachedGet(`/api/valuation-history?code=${encodeURIComponent(code)}`),
    { code, points: [], since: null, current: null, percentile: null },
  );
}

export function testWatchdogPush() {
  return request("/api/watchdog-test", {
    method: "POST",
    body: JSON.stringify({}),
  });
}


export function startStockSentiment(payload) {
  return request("/api/stock-analysis/sentiment", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function startStockResearch(payload) {
  return request("/api/stock-analysis/research", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function loadStockResearch() {
  return withFallback(
    () => cachedGet("/api/stock-research"),
    { updatedAt: null, total: 0, reports: [] },
  );
}

export function saveStockResearch(name, { generatedAt, report }) {
  return request(`/api/stock-research/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ generatedAt, report }),
  }).then((result) => {
    invalidateCache("/api/stock-research");
    return result;
  });
}

export function deleteStockResearch(name) {
  return request(`/api/stock-research/${encodeURIComponent(name)}`, {
    method: "DELETE",
    body: JSON.stringify({}),
  }).then((result) => {
    invalidateCache("/api/stock-research");
    return result;
  });
}

export function startStockReview(stocks) {
  return request("/api/stock-analysis/review", {
    method: "POST",
    body: JSON.stringify({ stocks }),
  });
}

export function getStockAnalysis(id) {
  return request(`/api/stock-analysis/${encodeURIComponent(id)}`);
}

const emptyReviewIndices = { date: null, indices: [] };
const emptyReviewTimeline = { date: null, items: [] };
const emptyReviewKline = { symbol: null, days: 60, klines: [] };

export function loadDailyReviewIndices(date = null) {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return withFallback(
    () => cachedGet(`/api/daily-review/indices${query}`, 60_000),
    () => emptyReviewIndices,
  );
}

export function loadDailyReviewKline(symbol, days = 60) {
  return withFallback(
    () => cachedGet(
      `/api/daily-review/kline?symbol=${encodeURIComponent(symbol)}&days=${days}`,
      10 * 60_000,
    ),
    () => ({ ...emptyReviewKline, symbol }),
  );
}

export function loadDailyReviewTimeline(date = null) {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return withFallback(
    () => cachedGet(`/api/daily-review/timeline${query}`, 30_000),
    () => emptyReviewTimeline,
  );
}

export function loadDailyReviewSummary(date) {
  return withFallback(
    () => cachedGet(`/api/daily-review/summary?date=${encodeURIComponent(date)}`, 60_000),
    () => ({ intraday: null, close: null }),
  );
}

export function loadCoachPrompt() {
  return withFallback(
    () => cachedGet("/api/daily-review/prompt", 10_000),
    () => ({ prompt: null, customized: false, variables: [] }),
  );
}

export async function saveCoachPrompt(prompt) {
  const result = await request("/api/daily-review/prompt", {
    method: "PUT",
    body: JSON.stringify({ prompt }),
  });
  invalidateCache("/api/daily-review/prompt");
  return result;
}

export async function resetCoachPrompt() {
  const result = await request("/api/daily-review/prompt", { method: "DELETE" });
  invalidateCache("/api/daily-review/prompt");
  return result;
}

export function loadReviewSchedule() {
  return withFallback(
    () => cachedGet("/api/daily-review/schedule", 10_000),
    () => ({ enabled: true, time: "15:05", customized: false }),
  );
}

export function loadDailyReviewSentiment() {
  return withFallback(
    () => cachedGet("/api/daily-review/sentiment", 60_000),
    () => null,
  );
}

// 提示词库检索：服务端聚合双源并缓存，这里每次直连（含用户输入，不宜长缓存）。
export function searchPrompts(q, lang) {
  const params = new URLSearchParams({ q, lang });
  return request(`/api/prompts?${params}`);
}

// AI 辅助检索：中文想法 → 英文关键词。
export function suggestPromptKeywords(idea) {
  return request("/api/prompts/suggest", {
    method: "POST",
    body: JSON.stringify({ idea }),
    timeout: 40_000,
  });
}

// AI 优化：想法 + 模板 + 上下文 → 定制提示词。
export function optimizePrompt({ idea, template, context }) {
  return request("/api/prompts/optimize", {
    method: "POST",
    body: JSON.stringify({ idea, template, context }),
    timeout: 150_000,
  });
}

// ---- 云服务管理 ----

export function loadServices() {
  return cachedGet("/api/services", 15_000);
}

export function addService({ name, url, note }) {
  return request("/api/services", { method: "POST", body: JSON.stringify({ name, url, note }) });
}

export function updateService(id, { name, url, note }) {
  return request(`/api/services/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ name, url, note }),
  });
}

export function removeService(id) {
  return request(`/api/services/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function updateReviewSchedule(patch) {
  const result = await request("/api/daily-review/schedule", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  invalidateCache("/api/daily-review/schedule");
  return result;
}

export async function addReviewEvent(payload) {
  const event = await request("/api/daily-review/events", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  invalidateCache("/api/daily-review");
  return event;
}

export async function removeReviewEvent(id) {
  const result = await request(`/api/daily-review/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  invalidateCache("/api/daily-review");
  return result;
}

export async function saveDailyReviewSummary(date, payload) {
  const entry = await request(`/api/daily-review/summary/${encodeURIComponent(date)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  invalidateCache("/api/daily-review");
  return entry;
}

export function startDailyReviewGenerate(stocks, session = "close", date = null) {
  return request("/api/daily-review/generate", {
    method: "POST",
    body: JSON.stringify({ stocks, session, ...(date ? { date } : {}) }),
  });
}

const emptyPortfolio = { positions: [], totals: null, closed: [] };

export function loadPortfolio() {
  return withFallback(
    () => cachedGet("/api/portfolio", 60_000),
    () => emptyPortfolio,
  );
}

export function loadStockIntraday(code, date = null) {
  const query = date ? `&date=${encodeURIComponent(date)}` : "";
  return withFallback(
    () => cachedGet(`/api/daily-review/intraday?code=${encodeURIComponent(code)}${query}`, 60_000),
    () => ({ code, date: null, intraday: [], prevCloseReference: null }),
  );
}

export async function addPosition(payload) {
  const position = await request("/api/portfolio", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  invalidateCache("/api/portfolio");
  return position;
}

export async function updatePosition(id, patch) {
  const position = await request(`/api/portfolio/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  invalidateCache("/api/portfolio");
  return position;
}

export async function removePosition(id) {
  const result = await request(`/api/portfolio/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  invalidateCache("/api/portfolio");
  return result;
}

export function loadSocialInsight(reportId) {
  return withFallback(
    () => request(`/api/social-insights/${encodeURIComponent(reportId)}`),
    null,
  );
}

export function loadSocialTrends() {
  return withFallback(
    () => request("/api/social-trends"),
    {
      available: false,
      generatedAt: null,
      total: null,
      items: [],
    },
  );
}

export function loadSocialTrend(reportId) {
  return withFallback(
    () => request(`/api/social-trends/${encodeURIComponent(reportId)}`),
    null,
  );
}

export function refreshVault() {
  return request("/api/refresh", { method: "POST" });
}

export function openLocalTarget(id, target = "obsidian") {
  return request("/api/open", {
    method: "POST",
    body: JSON.stringify({ id, target }),
  });
}

export function getRuntimeStatus() {
  return withFallback(
    () => request("/api/runtime"),
    {
      codex: {
        available: false,
        authenticated: null,
        version: null,
        path: null,
      },
      vault: {
        connected: null,
        label: "本地 Vault",
        documents: null,
        generatedAt: null,
        errors: null,
      },
    },
  );
}

export function startWorkflow(payload) {
  return request("/api/workflows/xiaohongshu", {
    method: "POST",
    body: JSON.stringify(payload),
    timeout: 30_000,
  });
}

export function loadWorkflowJob(jobId) {
  return request(`/api/workflows/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelWorkflowJob(jobId) {
  return request(`/api/workflows/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}

export function confirmWorkflowJob(jobId) {
  return request(`/api/workflows/jobs/${encodeURIComponent(jobId)}/confirm`, {
    method: "POST",
  });
}

export function createJobEventSource(jobId) {
  return new EventSource(`/api/workflows/jobs/${encodeURIComponent(jobId)}/events`);
}
