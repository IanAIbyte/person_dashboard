// 提示词模板库：聚合两个公开源，本地缓存 + minisearch 检索。
// - 中文：PlexPt/awesome-chatgpt-prompts-zh 的 prompts-zh.json（124 条，MIT）
// - 英文：f/prompts.chat 的 prompts.csv（约 1.2 万条，内容 CC0）
// 统一 schema：{ act, prompt, lang: "zh"|"en", source }。
// 拉取失败时沿用上一次成功结果（stale），页面始终可用。

import MiniSearch from "minisearch";

const ZH_JSON_URL =
  "https://raw.githubusercontent.com/PlexPt/awesome-chatgpt-prompts-zh/main/prompts-zh.json";
const EN_CSV_URL =
  "https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv";
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

// RFC4180 宽容解析：引号内可含逗号/换行/转义引号。header 行必须含 act,prompt。
export function parsePromptsCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  const actIndex = header.indexOf("act");
  const promptIndex = header.indexOf("prompt");
  if (actIndex < 0 || promptIndex < 0) return [];
  return rows
    .filter((cells) => cells.length > Math.max(actIndex, promptIndex))
    .map((cells) => ({ act: cells[actIndex].trim(), prompt: cells[promptIndex].trim() }))
    .filter((item) => item.act && item.prompt);
}

export function createPromptsLibrary({ fetchImpl = globalThis.fetch, now = Date.now, log = console.log } = {}) {
  let cache = null; // { index, docs, zhCount, enCount, fetchedAt, stale }

  async function fetchText(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async function refresh() {
    const [zhRaw, enRaw] = await Promise.all([
      fetchText(ZH_JSON_URL).catch(() => null),
      fetchText(EN_CSV_URL).catch(() => null),
    ]);
    const docs = [];
    if (zhRaw) {
      const items = JSON.parse(zhRaw);
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.act && item?.prompt) {
          docs.push({ act: String(item.act), prompt: String(item.prompt), lang: "zh", source: "zh" });
        }
      }
    }
    if (enRaw) {
      for (const item of parsePromptsCsv(enRaw)) {
        docs.push({ ...item, lang: "en", source: "chat" });
      }
    }
    if (docs.length === 0) throw new Error("两个提示词源均不可用");
    const index = new MiniSearch({
      fields: ["act", "prompt"],
      searchOptions: { fuzzy: 0.2, prefix: true },
    });
    index.addAll(docs.map((doc, id) => ({ ...doc, id })));
    const zhCount = docs.filter((doc) => doc.lang === "zh").length;
    cache = {
      index,
      docs,
      zhCount,
      enCount: docs.length - zhCount,
      fetchedAt: now(),
      stale: Boolean(zhRaw == null || enRaw == null),
    };
    log(`[workbench] 提示词库已加载：中文 ${zhCount} / 英文 ${docs.length - zhCount}${cache.stale ? "（部分源失败，用可用源）" : ""}`);
  }

  async function ensureIndex() {
    if (cache && now() - cache.fetchedAt < REFRESH_TTL_MS) return;
    try {
      await refresh();
    } catch (error) {
      if (!cache) throw error; // 从未成功过，无降级可用
      cache.stale = true;
      log(`[workbench] 提示词库刷新失败，沿用缓存：${error?.message ?? error}`);
    }
  }

  async function search({ q = "", lang = "all", limit = 30 } = {}) {
    await ensureIndex();
    let items;
    if (!q.trim()) {
      // 无关键词：中文源在前，给一页浏览样本。
      items = [
        ...cache.docs.filter((doc) => doc.lang === "zh"),
        ...cache.docs.filter((doc) => doc.lang === "en"),
      ];
    } else {
      const term = q.trim();
      const hits = cache.index.search(term).map((hit) => cache.docs[hit.id]);
      // CJK 无空格分词，minisearch 记号化后长句不可命中 —— 含中文字符时
      // 叠加子串扫描（act/prompt 包含即命中），去重合并。
      if (/[一-鿿]/.test(term)) {
        const seen = new Set(hits);
        for (const doc of cache.docs) {
          if (seen.has(doc)) continue;
          if (doc.act.includes(term) || doc.prompt.includes(term)) hits.push(doc);
        }
      }
      items = hits;
    }
    if (lang === "zh" || lang === "en") items = items.filter((doc) => doc.lang === lang);
    return {
      total: items.length,
      items: items.slice(0, limit).map(({ act, prompt, lang: docLang, source }) => ({
        act, prompt, lang: docLang, source,
      })),
      stats: {
        zhCount: cache.zhCount,
        enCount: cache.enCount,
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        stale: cache.stale,
      },
    };
  }

  return { search };
}
