import assert from "node:assert/strict";
import test from "node:test";

import {
  createMarketDataService,
  formatMinuteRow,
  normalizeTencentSymbol,
} from "../server/market-data.mjs";

// 构造一条腾讯 ~ 分隔行情（≥54 字段，仅填关键位）。
function quoteLine(symbol, { name, code, price = "10.00" }) {
  const f = new Array(56).fill("");
  f[1] = name;
  f[2] = code;
  f[3] = price;
  f[4] = "9.50";
  f[5] = "9.80";
  f[6] = "10000";
  f[30] = "2026/08/25 15:00:00";
  f[31] = "0.50";
  f[32] = "5.26";
  f[33] = "10.20";
  f[34] = "9.70";
  f[37] = "123456"; // 成交额(万)
  f[43] = "5.26"; // 振幅
  return `v_${symbol}="${f.join("~")}"`;
}

function fakeFetch(lines) {
  const text = lines.join(";");
  return async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    json: async () => null,
  });
}

test("normalizeTencentSymbol keeps prefixed index symbols and stock rules for bare codes", () => {
  assert.equal(normalizeTencentSymbol("sh000001"), "sh000001");
  assert.equal(normalizeTencentSymbol("sz399006"), "sz399006");
  assert.equal(normalizeTencentSymbol("000001"), "sz000001"); // 裸码沿用个股规则
  assert.equal(normalizeTencentSymbol("600519"), "sh600519");
  assert.equal(normalizeTencentSymbol("688825"), "sh688825");
  assert.equal(normalizeTencentSymbol("sh0001"), null);
  assert.equal(normalizeTencentSymbol("abc"), null);
  assert.equal(normalizeTencentSymbol(123), null);
});

test("getQuotes resolves index symbols without colliding into stock codes", async () => {
  const fetchImpl = fakeFetch([
    quoteLine("sh000001", { name: "上证指数", code: "000001", price: "3000.00" }),
    quoteLine("sh600519", { name: "贵州茅台", code: "600519", price: "1500.00" }),
  ]);
  const service = createMarketDataService({
    fetchImpl,
    decoder: () => ({ decode: (buf) => new TextDecoder().decode(buf) }),
  });

  const quotes = await service.getQuotes(["sh000001", "600519"]);
  const index = quotes.get("sh000001");
  assert.equal(index?.name, "上证指数");
  assert.equal(index?.symbol, "sh000001");
  assert.equal(index?.price, 3000);
  assert.equal(quotes.get("600519")?.name, "贵州茅台");
  // 修复前：v_sh000001 的 f[2]="000001" 会被重建为 sz000001（平安银行）导致查不到。
  assert.equal(quotes.get("sh000001")?.code, "000001");
});

test("formatMinuteRow parses mkline rows and rejects malformed stamps", () => {
  const row = formatMinuteRow(["202608251445", "3000.1", "3005.2", "3008.0", "2999.5", "12345", {}]);
  assert.deepEqual(row, {
    time: "2026-08-25 14:45",
    open: 3000.1,
    close: 3005.2,
    high: 3008,
    low: 2999.5,
    volume: 12345,
  });
  assert.deepEqual(formatMinuteRow(["bad", "1", "2", "3", "4", "5"]), {});
  assert.deepEqual(formatMinuteRow(null), {});
});

test("getMinuteKlines fetches, filters by date and caches until ttl", async () => {
  let nowMs = 1_000_000;
  let calls = 0;
  const payload = {
    code: 0,
    data: {
      sh000001: {
        m5: [
          ["202608241455", "2990", "2991", "2992", "2989", "100"],
          ["202608251000", "2995", "2996", "2997", "2994", "110"],
          ["202608251005", "2996", "2997.5", "2998", "2995", "120"],
        ],
      },
    },
  };
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => payload };
  };
  const service = createMarketDataService({
    fetchImpl,
    now: () => nowMs,
    decoder: () => ({ decode: () => "" }),
  });

  const all = await service.getMinuteKlines("sh000001", { ktype: "m5", count: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[1].time, "2026-08-25 10:00");

  const day = await service.getMinuteKlines("sh000001", { date: "2026-08-25" });
  assert.equal(day.length, 2);
  assert.ok(day.every((k) => k.time.startsWith("2026-08-25")));

  nowMs += 30_000; // TTL 内不再请求
  await service.getMinuteKlines("sh000001", { date: "2026-08-25" });
  assert.equal(calls, 2); // all 与 day 是两个缓存键，命中后无第三次请求

  nowMs += 60_000; // TTL 过期后重新请求
  await service.getMinuteKlines("sh000001", { date: "2026-08-25" });
  assert.equal(calls, 3);

  assert.deepEqual(await service.getMinuteKlines("sh000001", { ktype: "m7" }), []);
});
