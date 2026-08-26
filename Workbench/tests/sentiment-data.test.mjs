import assert from "node:assert/strict";
import test from "node:test";

import { createSentimentDataService } from "../server/sentiment-data.mjs";
import { sessionForNow } from "../server/stock-analysis.mjs";
import { createCoachPromptRepository, renderCoachPrompt } from "../server/coach-prompt.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function emResponse(items) {
  return { ok: true, json: async () => ({ data: { diff: items } }) };
}

function tencentLine() {
  const f = new Array(40).fill("0");
  f[1] = "北证50";
  f[3] = "1400.55";
  f[32] = "-1.23";
  f[37] = "250000"; // 万 → 25 亿
  return `v_bj899050="${f.join("~")}"`;
}

test("getSentiment aggregates breadth, pools, promotion and bj50 with degradation", async () => {
  const calls = [];
  const service = createSentimentDataService({
    intervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (url.includes("push2.eastmoney.com")) {
        // 行业板块：3 涨 2 跌 → 上涨 5 家 / 下跌 7 家。
        return emResponse([
          { f14: "半导体", f3: "3.2", f104: "2", f105: "1" },
          { f14: "白酒", f3: "-2.1", f104: "1", f105: "4" },
          { f14: "光模块", f3: "1.5", f104: "2", f105: "2" },
        ]);
      }
      if (url.includes("fs=b%3AMK0021") || url.includes("fs=b:MK0021")) {
        // 昨日涨停：3 只中 2 只上涨 → 晋级率 66.67%。
        return emResponse([
          { f14: "A", f3: "10.0" },
          { f14: "B", f3: "1.0" },
          { f14: "C", f3: "-3.0" },
        ]);
      }
      if (url.includes("push2ex")) {
        // 涨停池：2 只，最高 4 板。
        return emResponse([
          { f14: "X", f3: "9.98", f107: "2" },
          { f14: "Y", f3: "10.0", f107: "4" },
        ]);
      }
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(tencentLine()).buffer,
      };
    },
    decoder: () => ({ decode: (buf) => new TextDecoder().decode(buf) }),
  });

  const s = await service.getSentiment();
  assert.equal(s.upCount, 5);
  assert.equal(s.downCount, 7);
  assert.equal(s.limitUp, 2);
  assert.equal(s.maxBoards, 4);
  assert.equal(s.promotionRate, 66.67);
  assert.deepEqual(s.topSectors[0], { name: "半导体", changePct: 3.2 });
  assert.equal(s.bottomSectors[0].name, "白酒");
  assert.equal(s.bj50.close, 1400.55);
  assert.equal(s.bj50.changePct, -1.23);
  assert.equal(s.bj50.turnoverYi, 25);
  assert.equal(s.limitDown, null); // 未采集 → null
  assert.equal(s.blastRate, null);

  // 缓存：第二次调用零请求。
  const callsAfterFirst = calls.length;
  await service.getSentiment();
  assert.equal(calls.length, callsAfterFirst);
});

test("all sources failing degrades every field to null", async () => {
  const service = createSentimentDataService({
    intervalMs: 0,
    fetchImpl: async () => ({ ok: false }),
  });
  const s = await service.getSentiment();
  assert.equal(s.upCount, null);
  assert.equal(s.limitUp, null);
  assert.equal(s.bj50, null);
});

test("sessionForNow maps trading phases and storage keys", () => {
  const at = (hhmm) => new Date(2026, 7, 26, ...hhmm.split(":").map(Number)); // 周三
  assert.equal(sessionForNow(at("09:00")).phase, "pre");
  assert.equal(sessionForNow(at("10:30")).key, "intraday");
  assert.equal(sessionForNow(at("12:00")).phase, "lunch");
  assert.equal(sessionForNow(at("12:00")).key, "intraday"); // 午间生成盘中总结
  assert.equal(sessionForNow(at("14:45")).phase, "tail");
  assert.equal(sessionForNow(at("15:30")).key, "close");
  assert.equal(sessionForNow(new Date(2026, 7, 29, 10, 0)).label, "周末休市");
});

test("coach prompt repository defaults, saves and resets", async () => {
  const vault = await mkdtemp(path.join(tmpdir(), "cp-"));
  const repo = createCoachPromptRepository({ vaultRoot: vault });

  const initial = await repo.get();
  assert.equal(initial.customized, false);
  assert.ok(initial.prompt.includes("四段式复盘"));

  const saved = await repo.save("自定义 {{date}} {{session}} 模板");
  assert.equal(saved.customized, true);
  assert.equal((await repo.get()).prompt, "自定义 {{date}} {{session}} 模板");

  await assert.rejects(() => repo.save("   "), /不能为空/);
  await assert.rejects(() => repo.save("a".repeat(20_001)), /上限/);

  const reset = await repo.reset();
  assert.equal(reset.customized, false);
  assert.ok(reset.prompt.includes("四段式复盘"));

  assert.equal(renderCoachPrompt("D={{date}} S={{session}}", { date: "2026-08-26", session: "午间休市 · 盘中" }), "D=2026-08-26 S=午间休市 · 盘中");
});
