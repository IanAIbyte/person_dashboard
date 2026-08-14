// A 股免费行情封装（腾讯 qt.gtimg.cn，HTTP + GBK）。
// 可注入 fetch + 内存缓存 + 降级。东财 push2 在部分网络环境被阻断，故用腾讯源。
// 字段（split ~）：[1]名称 [2]代码 [3]现价 [4]昨收 [32]涨跌幅%。

const QUOTE_ORIGIN = "http://qt.gtimg.cn";
const CACHE_TTL_MS = 60_000; // 行情缓存 1 分钟

// 6 开头 → 沪市 sh，0/3 开头 → 深市 sz。
function tencentSymbol(code) {
  if (!/^\d{6}$/.test(code)) return null;
  return `${code.startsWith("6") ? "sh" : "sz"}${code}`;
}

function parseLine(line) {
  const match = line.match(/v_(\w+)="([^"]*)"/);
  if (!match) return null;
  const f = match[2].split("~");
  const price = Number(f[3]);
  const prevClose = Number(f[4]);
  const changePct = Number(f[32]);
  return {
    code: f[2] || null,
    name: f[1] || null,
    price: Number.isFinite(price) ? price : null,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    changePct: Number.isFinite(changePct) ? changePct : null,
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

  // 批量拉取，一次请求查多只。返回 Map<code, quote>。
  async function getQuotes(codes) {
    const results = new Map();
    if (!Array.isArray(codes)) return results;
    const valid = codes
      .filter((code) => typeof code === "string" && tencentSymbol(code))
      .map((code) => ({ code, symbol: tencentSymbol(code) }));

    // 先看缓存，命中直接塞结果；未命中的批量请求。
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
          if (quote?.code) bySymbol.set(`${tencentSymbol(quote.code)}`, quote);
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

  return Object.freeze({ getQuotes });
}
