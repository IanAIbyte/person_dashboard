import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPortfolioRepository } from "../server/portfolio.mjs";
import { createDailyReviewService } from "../server/daily-review.mjs";
import { createReviewEventsRepository } from "../server/review-events.mjs";
import { createDailyReviewStore } from "../server/daily-review-store.mjs";

async function makeVault() {
  return mkdtemp(path.join(tmpdir(), "pf-vault-"));
}

function makeService(vault, { price = 60, changePct = 2 } = {}) {
  const portfolioRepo = createPortfolioRepository({ vaultRoot: vault });
  const marketService = {
    getQuotes: async (codes) => {
      const map = new Map();
      for (const code of codes) {
        map.set(code, {
          price,
          prevClose: price / (1 + changePct / 100),
          changePct,
        });
      }
      return map;
    },
    getMinuteKlines: async () => [
      { time: "2026-08-25 09:35", open: price, close: price, high: price, low: price, volume: 1 },
    ],
    getDailyKlines: async () => [],
  };
  const service = createDailyReviewService({
    marketService,
    loadConfig: async () => ({ indices: [] }),
    readAlerts: async () => ({ items: [] }),
    eventsRepo: createReviewEventsRepository({ vaultRoot: vault }),
    reviewStore: createDailyReviewStore({ vaultRoot: vault }),
    portfolioRepo,
    now: () => Date.parse("2026-08-25T16:00:00+08:00"),
  });
  return { portfolioRepo, service };
}

test("portfolio repository validates fields and round-trips", async () => {
  const vault = await makeVault();
  const repo = createPortfolioRepository({ vaultRoot: vault });

  await assert.rejects(() => repo.add({ code: "sh000001", shares: 100, costPrice: 10 }), /6 位数字/);
  await assert.rejects(() => repo.add({ code: "688825", shares: -5, costPrice: 10 }), /股数/);
  await assert.rejects(() => repo.add({ code: "688825", shares: 100, costPrice: 0 }), /成本价/);
  // add 忽略清仓字段（清仓只能走 update）。
  const direct = await repo.add({ code: "002371", shares: 100, costPrice: 10, closedAt: "2026-08-25" });
  assert.equal(direct.closedAt, null);
  await repo.remove(direct.id);

  const position = await repo.add({
    code: "688825",
    name: "长鑫存储",
    shares: 200,
    costPrice: 58.5,
    openedAt: "2026-08-01",
    note: "主力仓",
  });
  assert.equal(position.code, "688825");
  assert.equal(position.shares, 200);
  assert.equal(position.closedAt, null);

  const updated = await repo.update(position.id, { shares: 300, costPrice: 57 });
  assert.equal(updated.shares, 300);
  assert.equal(updated.note, "主力仓");

  // 清仓必须成对出现 closedAt + closedPrice。
  await assert.rejects(
    () => repo.update(position.id, { closedAt: "2026-08-20" }),
    /同时提供/,
  );
  const closed = await repo.update(position.id, { closedAt: "2026-08-20", closedPrice: 61.2 });
  assert.equal(closed.closedPrice, 61.2);

  // 重开：清空两字段。
  const reopened = await repo.update(position.id, { closedAt: null, closedPrice: null });
  assert.equal(reopened.closedAt, null);

  assert.equal(await repo.remove(position.id), true);
  assert.equal(await repo.remove(position.id), false);
});

test("getPortfolio computes values, weights and closed history", async () => {
  const vault = await makeVault();
  const { portfolioRepo, service } = makeService(vault, { price: 60, changePct: 2 });

  await portfolioRepo.add({ code: "688825", name: "长鑫存储", shares: 200, costPrice: 50 });
  await portfolioRepo.add({ code: "600519", name: "贵州茅台", shares: 100, costPrice: 60 });
  const bank = await portfolioRepo.add({ code: "000001", name: "平安银行", shares: 1000, costPrice: 10 });
  await portfolioRepo.update(bank.id, { closedAt: "2026-08-20", closedPrice: 11 });

  const portfolio = await service.getPortfolio();
  assert.equal(portfolio.positions.length, 2); // 清仓的不在活跃列表
  const totals = portfolio.totals;
  // 市值 200×60=12000 + 100×60=6000 = 18000；成本 10000 + 6000 = 16000。
  assert.equal(totals.marketValue, 18000);
  assert.equal(totals.cost, 16000);
  assert.equal(totals.pnl, 2000);
  assert.equal(totals.pnlPct, 12.5);
  // 当日按「现价 − 昨收」× 股数：(60 − 60/1.02) × (200 + 100) = 352.94。
  // 回归：不能用 市值×pct/100（=360），那会高估收益、低估亏损。
  assert.equal(totals.dayPnl, 352.94);
  assert.equal(totals.maxWeight, 66.7);
  const first = portfolio.positions.find((item) => item.code === "688825");
  assert.equal(first.weight, 66.7);
  assert.equal(first.pnl, 2000); // (60-50)*200
  assert.equal(first.pnlPct, 20);

  const closedRow = portfolio.closed[0];
  assert.equal(closedRow.finalPnl, 1000); // (11-10)*1000
  assert.equal(closedRow.finalPnlPct, 10);
});

test("getStockIntraday validates code and returns bars with prevClose", async () => {
  const vault = await makeVault();
  const { service } = makeService(vault);
  await assert.rejects(() => service.getStockIntraday("sh000001"), /6 位数字/);
  const intraday = await service.getStockIntraday("688825");
  assert.equal(intraday.code, "688825");
  assert.equal(intraday.intraday.length, 1);
  assert.ok(intraday.prevCloseReference > 0);
});

test("collectReviewContext includes positions for LLM", async () => {
  const vault = await makeVault();
  const { portfolioRepo, service } = makeService(vault, { price: 60, changePct: 2 });
  await portfolioRepo.add({ code: "688825", name: "长鑫存储", shares: 200, costPrice: 50 });

  const context = await service.collectReviewContext();
  assert.equal(context.positions.length, 1);
  assert.equal(context.positions[0].name, "长鑫存储");
  assert.equal(context.positions[0].weight, 100);
  assert.equal(context.positions[0].pnlPct, 20);
});
