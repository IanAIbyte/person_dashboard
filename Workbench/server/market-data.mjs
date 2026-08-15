// A 股免费行情封装（腾讯 qt.gtimg.cn 快照 + web.ifzq.gtimg.cn 日K）。
// 可注入 fetch + 内存缓存 + 降级。东财 push2 在部分网络环境被阻断，故用腾讯源。
//
// 快照字段（split "~"，0 基索引，实测 2026-08-14）：
//   [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [6]成交量(手)
//   [30]时间戳 [31]涨跌额 [32]涨跌幅% [33]/[34]最高/最低 [37]成交额(万)
//   [38]换手率% [39]PE(TTM) [43]振幅% [44]流通市值(亿) [45]总市值(亿)
//   [46]PB [47]涨停价 [48]跌停价 [49]量比 [51]均价 [52]/[53]PE动/静

const QUOTE_ORIGIN = "http://qt.gtimg.cn";
const KLINE_ORIGIN = "https://web.ifzq.gtimg.cn";
const CACHE_TTL_MS = 60_000; // 行情缓存 1 分钟
const KLINE_CACHE_TTL_MS = 10 * 60_000; // 日K缓存 10 分钟

// 6/9 开头 → 沪市 sh，0/3 开头 → 深市 sz。
export function tencentSymbol(code) {
  if (!/^\d{6}$/.test(code)) return null;
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

function numberOrNA(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseLine(line) {
  const match = line.match(/v_(\w+)="([^"]*)"/);
  if (!match) return null;
  const f = match[2].split("~");
  if (f.length < 54) return null;
  return {
    code: f[2] || null,
    name: f[1] || null,
    price: numberOrNA(f[3]),
    prevClose: numberOrNA(f[4]),
    open: numberOrNA(f[5]),
    volumeHands: numberOrNA(f[6]),
    timestamp: f[30] || null,
    change: numberOrNA(f[31]),
    changePct: numberOrNA(f[32]),
    high: numberOrNA(f[33]),
    low: numberOrNA(f[34]),
    turnoverPct: numberOrNA(f[38]),
    peTtm: numberOrNA(f[39]),
    amplitudePct: numberOrNA(f[43]),
    floatMarketCap: numberOrNA(f[44]),
    marketCap: numberOrNA(f[45]),
    pb: numberOrNA(f[46]),
    limitUp: numberOrNA(f[47]),
    limitDown: numberOrNA(f[48]),
    volumeRatio: numberOrNA(f[49]),
    avgPrice: numberOrNA(f[51]),
  };
}

export function createMarketDataService({
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  cacheTtlMs = CACHE_TTL_MS,
  now = () => Date.now(),
  decoder = () => new TextDecoder("gbk"),
} = {}) {
  const cache = new Map(); // symbol -> { at, quote }
  const klineCache = new Map(); // `${symbol}:${days}` -> { at, klines }

  // 批量拉取，一次请求查多只。返回 Map<code, quote>。
  async function getQuotes(codes) {
    const results = new Map();
    if (!Array.isArray(codes)) return results;
    const valid = codes
      .filter((code) => typeof code === "string" && tencentSymbol(code))
      .map((code) => ({ code, symbol: tencentSymbol(code) }));

    const miss = [];
    for (const { code, symbol } of valid) {
      const cached = cache.get(symbol);
      if (cached && now() - cached.at < cacheTtlMs) {
        results.set(code, cached.quote);
      } else {
        miss.push({ code, symbol });
      }
    }

    if (miss.length === 0) return results;

    const symbolList = miss.map((m) => m.symbol).join(",");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${QUOTE_ORIGIN}/q=${symbolList}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: controller.signal,
      });
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const text = decoder().decode(buffer);
        const bySymbol = new Map();
        for (const line of text.split(";")) {
          const quote = parseLine(line.trim());
          if (quote?.code) bySymbol.set(tencentSymbol(quote.code), quote);
        }
        for (const { code, symbol } of miss) {
          const quote = bySymbol.get(symbol);
          if (quote) {
            cache.set(symbol, { at: now(), quote });
            results.set(code, quote);
          }
        }
      }
    } catch {
      // 网络失败降级：返回已缓存的部分，无则空。
    } finally {
      clearTimeout(timer);
    }
    return results;
  }

  // 日K线（前复权），返回 [{date, open, close, high, low, volume}]。
  // 注意腾讯 K 线数组顺序：[日期, 开, 收, 高, 低, 量]。
  async function getDailyKlines(code, days = 120) {
    const symbol = tencentSymbol(code);
    if (!symbol) return [];
    const cacheKey = `${symbol}:${days}`;
    const cached = klineCache.get(cacheKey);
    if (cached && now() - cached.at < KLINE_CACHE_TTL_MS) return cached.klines;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${KLINE_ORIGIN}/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const payload = await response.json();
      // 腾讯系陷阱：HTTP 200 但 code:11 表示接口失效，必须校验业务码。
      if (payload?.code !== 0) return [];
      const raw = payload?.data?.[symbol]?.qfqday ?? payload?.data?.[symbol]?.day ?? [];
      const klines = raw
        .map((row) => ({
          date: row[0],
          open: numberOrNA(row[1]),
          close: numberOrNA(row[2]),
          high: numberOrNA(row[3]),
          low: numberOrNA(row[4]),
          volume: numberOrNA(row[5]),
        }))
        .filter((k) => k.date && k.close != null);
      klineCache.set(cacheKey, { at: now(), klines });
      return klines;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({ getQuotes, getDailyKlines });
}

// 由日K自算均线与技术速览（纯函数，便于测试）。
export function computeMA(klines, periods = [5, 20, 60]) {
  const closes = klines.map((k) => k.close);
  const result = {};
  for (const period of periods) {
    if (closes.length < period) {
      result[`ma${period}`] = null;
      continue;
    }
    const slice = closes.slice(-period);
    result[`ma${period}`] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

// 均线排列状态：bullish（多头）/ bearish（空头）/ mixed（纠缠）。
export function maTrend(ma) {
  const { ma5, ma20, ma60 } = ma;
  if (ma5 == null || ma20 == null || ma60 == null) return "unknown";
  if (ma5 > ma20 && ma20 > ma60) return "bullish";
  if (ma5 < ma20 && ma20 < ma60) return "bearish";
  return "mixed";
}
