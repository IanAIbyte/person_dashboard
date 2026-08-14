// A 股个股新闻封装（东方财富搜索 API，按公司名关键词搜索）。
// 可注入 fetch + 内存缓存 + 降级。返回近期新闻标题/摘要/来源/链接/时间。

const NEWS_ORIGIN = "https://search-api-web.eastmoney.com";
const CACHE_TTL_MS = 5 * 60_000; // 新闻缓存 5 分钟

function stripEm(text) {
  return String(text ?? "").replace(/<\/?em>/g, "").trim();
}

function normalizeArticle(raw) {
  return {
    title: stripEm(raw?.title),
    summary: stripEm(raw?.content),
    mediaName: raw?.mediaName ?? null,
    date: raw?.date ?? null,
    url: raw?.url ?? null,
  };
}

export function createStockNewsService({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  cacheTtlMs = CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const cache = new Map(); // keyword -> { at, items }

  async function search(keyword) {
    const cached = cache.get(keyword);
    if (cached && now() - cached.at < cacheTtlMs) return cached.items;

    const param = {
      uid: "",
      keyword,
      type: ["cmsArticleWebOld"],
      client: "web",
      clientType: "web",
      clientVersion: "curr",
      param: {
        cmsArticleWebOld: {
          searchScope: "default",
          sort: "default",
          pageIndex: 1,
          pageSize: 8,
        },
      },
    };
    const url = `${NEWS_ORIGIN}/search/jsonp?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "*/*" },
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const text = await response.text();
      // 响应是 JSONP：cb({...})。剥掉外层取 JSON。
      const jsonText = text.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, "");
      const payload = JSON.parse(jsonText);
      const items = (payload?.result?.cmsArticleWebOld ?? []).map(normalizeArticle);
      cache.set(keyword, { at: now(), items });
      return items;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  // name 用于搜索关键词；code 留作扩展（部分新闻源可按代码精确查）。
  async function getStockNews({ name, code = null }) {
    if (!name) return [];
    return search(name);
  }

  return Object.freeze({ getStockNews });
}
