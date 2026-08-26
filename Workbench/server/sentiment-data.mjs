// 情绪面数据服务：涨跌家数/涨停统计/连板高度/晋级率/板块排行/北证50。
// 上游与限流策略来自 a-stock-data 文档：东财 push2 系需串行限流（此处
// 串行 + 请求间隔），腾讯零限流。任一数据源失败仅该字段降级为 null，
// 由 prompt 层标 [待补充]，绝不阻断复盘生成。
// 涨停池/晋级率上游为 push2ex.eastmoney.com，本网络环境实测 404（与
// 本仓已知的「东财部分接口被阻断」一致）——按设计降级，标 [待补充]。
// 炸板率/跌停家数：上游文档未给出确切池参数，不猜测编造，恒 null。

const EM_LIST = "https://push2.eastmoney.com/api/qt/clist/get";
const EM_EX_LIST = "https://push2ex.eastmoney.com/api/qt/clist/get";
const TENCENT_QUOTE = "http://qt.gtimg.cn/q=";
const EM_MIN_INTERVAL_MS = 300;
const CACHE_TTL_MS = 60_000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(part, total) {
  if (part == null || total == null || total <= 0) return null;
  return Math.round((part / total) * 10000) / 100;
}

export function createSentimentDataService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  decoder = () => new TextDecoder("gbk"),
  intervalMs = EM_MIN_INTERVAL_MS,
  cacheTtlMs = CACHE_TTL_MS,
  timeoutMs = 8_000,
} = {}) {
  let cache = null;
  let lastEmRequestAt = 0;

  // 东财请求：统一 UA + 超时 + 串行间隔（对齐 a-stock-data 的 em_get 思想）。
  async function emGet(url, params) {
    const wait = lastEmRequestAt + intervalMs - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastEmRequestAt = now();
    const query = new URLSearchParams({
      pn: "1", pz: "300", po: "1", np: "1", fltt: "2", invt: "2",
      ...params,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}?${query.toString()}`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return Array.isArray(payload?.data?.diff) ? payload.data.diff : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBj50() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // 北证50 腾讯代码实测为 bj899050（a-stock-data 文档写的 899000 是错的）。
      const response = await fetchImpl(`${TENCENT_QUOTE}bj899050`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const text = decoder().decode(await response.arrayBuffer());
      const raw = text.match(/v_bj899050="([^"]*)"/)?.[1];
      if (!raw) return null;
      const f = raw.split("~");
      if (f.length < 35) return null;
      const turnoverWan = num(f[37]);
      return {
        name: f[1] || "北证50",
        close: num(f[3]),
        changePct: num(f[32]),
        turnoverYi: turnoverWan != null && turnoverWan > 0
          ? Math.round(turnoverWan / 10_000)
          : null,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getSentiment() {
    if (cache && now() - cache.at < cacheTtlMs) return cache.value;

    // 1) 行业板块：涨跌家数求和 + 领涨领跌 top3。
    const industries = await emGet(EM_LIST, {
      fid: "f3",
      fs: "m:90+t:2",
      fields: "f3,f12,f14,f104,f105",
    });
    let upCount = null;
    let downCount = null;
    let topSectors = null;
    let bottomSectors = null;
    if (industries) {
      upCount = industries.reduce((sum, item) => sum + (num(item.f104) ?? 0), 0);
      downCount = industries.reduce((sum, item) => sum + (num(item.f105) ?? 0), 0);
      const sorted = [...industries]
        .filter((item) => num(item.f3) != null)
        .sort((a, b) => num(b.f3) - num(a.f3));
      const shape = (item) => ({ name: item.f14, changePct: num(item.f3) });
      topSectors = sorted.slice(0, 3).map(shape);
      bottomSectors = sorted.slice(-3).reverse().map(shape);
    }

    // 2) 涨停池：数量 + 最高连板高度（f107）。
    const ztPool = await emGet(EM_EX_LIST, {
      fid: "f62",
      fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
      fields: "f12,f14,f3,f107",
    });
    let limitUp = null;
    let maxBoards = null;
    if (ztPool) {
      limitUp = ztPool.length;
      maxBoards = ztPool.reduce((max, item) => Math.max(max, num(item.f107) ?? 0), 0) || null;
    }

    // 3) 昨日涨停今日表现 → 晋级率（b:MK0021 为文档给出的昨日涨停池 fs）。
    const yztPool = await emGet(EM_EX_LIST, {
      fid: "f3",
      fs: "b:MK0021",
      fields: "f12,f14,f3,f107",
    });
    let promotionRate = null;
    if (yztPool && yztPool.length > 0) {
      const promoted = yztPool.filter((item) => (num(item.f3) ?? 0) > 0).length;
      promotionRate = pct(promoted, yztPool.length);
    }

    // 4) 北证50（腾讯，零限流）。
    const bj50 = await fetchBj50();

    const value = {
      upCount,
      downCount,
      limitUp,
      // 炸板率/跌停家数：上游文档未提供确切池参数，恒 null（prompt 标[待补充]）。
      limitDown: null,
      maxBoards,
      blastRate: null,
      promotionRate,
      topSectors,
      bottomSectors,
      bj50,
    };
    cache = { at: now(), value };
    return value;
  }

  return Object.freeze({ getSentiment });
}
