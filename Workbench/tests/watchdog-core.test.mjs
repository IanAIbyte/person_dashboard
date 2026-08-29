import assert from "node:assert/strict";
import test from "node:test";

import { detectAlerts } from "../server/watchdog-core.mjs";

const CONFIG = {
  thresholdPct: 3,
  indexThresholdPct: 1,
  windowMinutes: 5,
  cooldownMinutes: 15,
};

function runOnce({ quotes, meta, samples, cooldowns, config = CONFIG, now = 1_000_000 }) {
  return detectAlerts({ quotes, bySymbolMeta: meta, samples, cooldowns, config, now });
}

test("stock surge triggers at stock threshold and respects cooldown", () => {
  const samples = new Map();
  const cooldowns = new Map();
  const meta = new Map([["600519", { name: "贵州茅台", scope: "stock" }]]);

  // t0：建立窗口基准 100。
  let alerts = runOnce({
    quotes: new Map([["600519", { price: 100, name: "贵州茅台" }]]),
    meta, samples, cooldowns,
  });
  assert.equal(alerts.length, 0);

  // t+5min：104 → +4% ≥ 3% 触发急拉。
  alerts = runOnce({
    quotes: new Map([["600519", { price: 104, name: "贵州茅台" }]]),
    meta, samples, cooldowns, now: 1_000_000 + 5 * 60_000,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "surge");
  assert.equal(alerts[0].changePct, 4);
  assert.equal(alerts[0].scope, undefined);

  // 冷却期内同向不再触发。
  alerts = runOnce({
    quotes: new Map([["600519", { price: 108, name: "贵州茅台" }]]),
    meta, samples, cooldowns, now: 1_000_000 + 6 * 60_000,
  });
  assert.equal(alerts.length, 0);
});

test("index uses its own threshold and never emits limit events", () => {
  const samples = new Map();
  const cooldowns = new Map();
  const meta = new Map([["sh000001", { name: "上证指数", scope: "index" }]]);

  runOnce({
    quotes: new Map([["sh000001", { price: 3000, limitUp: 0, limitDown: 0 }]]),
    meta, samples, cooldowns,
  });
  // +1.5%：不到个股阈值 3%，但达到指数阈值 1% → 触发，且不因 limitUp=0 误报涨停。
  const alerts = runOnce({
    quotes: new Map([["sh000001", { price: 3045, limitUp: 0, limitDown: 0 }]]),
    meta, samples, cooldowns, now: 1_000_000 + 5 * 60_000,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "surge");
  assert.equal(alerts[0].scope, "index");
  assert.equal(alerts[0].name, "上证指数");
  assert.equal(alerts[0].code, "sh000001");
});

test("index plunge below index threshold is detected with negative changePct", () => {
  const samples = new Map();
  const cooldowns = new Map();
  const meta = new Map([["sz399006", { name: "创业板指", scope: "index" }]]);

  runOnce({ quotes: new Map([["sz399006", { price: 2000 }]]), meta, samples, cooldowns });
  const alerts = runOnce({
    quotes: new Map([["sz399006", { price: 1975 }]]),
    meta, samples, cooldowns, now: 1_000_000 + 5 * 60_000,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "plunge");
  assert.equal(alerts[0].changePct, -1.25);
});

test("stock limitUp takes priority over surge", () => {
  const samples = new Map();
  const cooldowns = new Map();
  const meta = new Map([["688825", { name: "长鑫存储", scope: "stock" }]]);

  runOnce({
    quotes: new Map([["688825", { price: 58, limitUp: 63.8, limitDown: 52.2 }]]),
    meta, samples, cooldowns,
  });
  const alerts = runOnce({
    quotes: new Map([["688825", { price: 63.8, limitUp: 63.8, limitDown: 52.2 }]]),
    meta, samples, cooldowns, now: 1_000_000 + 5 * 60_000,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "limitUp");
});

test("quotes outside window baseline do not alert on flat prices", () => {
  const samples = new Map();
  const cooldowns = new Map();
  const meta = new Map([["600519", { name: "贵州茅台", scope: "stock" }]]);

  const alerts = runOnce({
    quotes: new Map([["600519", { price: 100 }]]),
    meta, samples, cooldowns,
  });
  assert.equal(alerts.length, 0);
  // 价格未变：deque[0] === price 分支直接跳过。
  const still = runOnce({
    quotes: new Map([["600519", { price: 100 }]]),
    meta, samples, cooldowns, now: 1_000_000 + 60_000,
  });
  assert.equal(still.length, 0);
  assert.equal(detectAlerts({ quotes: null, bySymbolMeta: meta, samples, cooldowns, config: CONFIG }).length, 0);
});
