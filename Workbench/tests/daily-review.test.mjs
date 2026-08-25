import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReviewEventsRepository } from "../server/review-events.mjs";
import { createDailyReviewStore } from "../server/daily-review-store.mjs";
import { createDailyReviewService } from "../server/daily-review.mjs";

async function makeVault() {
  return mkdtemp(path.join(tmpdir(), "dr-vault-"));
}

test("review events repository validates, persists and filters by date", async () => {
  const vault = await makeVault();
  const repo = createReviewEventsRepository({ vaultRoot: vault });

  await assert.rejects(
    () => repo.add({ title: "" }),
    /标题/,
  );
  await assert.rejects(
    () => repo.add({ title: "ok", tone: "bad" }),
    /tone/,
  );

  const event = await repo.add({
    title: "  盘中消息面利好  ",
    note: "半导体设备板块联动",
    tone: "up",
    ts: "2026-08-25T14:30:00+08:00",
  });
  assert.equal(event.title, "盘中消息面利好");
  assert.equal(event.ts, "2026-08-25T06:30:00.000Z");
  assert.equal(event.tone, "up");

  await repo.add({ title: "另一天的事件", ts: "2026-08-24T10:00:00+08:00" });

  const today = await repo.list({ date: "2026-08-25" });
  assert.equal(today.length, 1);
  assert.equal(today[0].title, "盘中消息面利好");

  const updated = await repo.update(event.id, { tone: "note" });
  assert.equal(updated.tone, "note");
  assert.equal(updated.title, "盘中消息面利好");

  assert.equal(await repo.remove(event.id), true);
  assert.equal(await repo.remove(event.id), false);
  assert.equal((await repo.list()).length, 1);
});

test("daily review store overrides by date and keeps last 30 entries", async () => {
  const vault = await makeVault();
  const store = createDailyReviewStore({ vaultRoot: vault });

  await assert.rejects(
    () => store.save("2026-8-25", { review: { overview: "x" } }),
    /YYYY-MM-DD/,
  );

  const first = await store.save("2026-08-25", { review: { overview: "第一版" } });
  assert.equal(first.review.overview, "第一版");
  await store.save("2026-08-25", { review: { overview: "覆盖版" }, stockCount: 27 });
  const entry = await store.get("2026-08-25");
  assert.equal(entry.review.overview, "覆盖版");
  assert.equal(entry.stockCount, 27);
  assert.equal((await store.list()).length, 1);

  for (let i = 1; i <= 32; i += 1) {
    await store.save(`2026-09-${String(i).padStart(2, "0")}`, { review: { overview: `d${i}` } });
  }
  const entries = await store.list();
  assert.equal(entries.length, 30);
  assert.equal(entries[0].date, "2026-09-03");
});

test("aggregation service merges timeline sources with ai pinned by time order", async () => {
  const vault = await makeVault();
  const eventsRepo = createReviewEventsRepository({ vaultRoot: vault });
  const reviewStore = createDailyReviewStore({ vaultRoot: vault });
  const now = () => Date.parse("2026-08-25T16:00:00+08:00");

  await eventsRepo.add({ title: "手动事件", ts: "2026-08-25T09:00:00+08:00" });
  await reviewStore.save("2026-08-25", { review: { overview: "AI 总结内容" } });

  const marketService = {
    getQuotes: async (codes) => {
      const map = new Map();
      if (codes.includes("sh000001")) {
        map.set("sh000001", {
          price: 3889.44,
          prevClose: 3882.01,
          open: 3863.37,
          high: 3896.21,
          low: 3850.86,
          changePct: 0.19,
          amplitudePct: 1.17,
        });
      }
      return map;
    },
    getMinuteKlines: async (symbol, { date }) => [
      { time: `${date} 09:35`, open: 3863.37, close: 3867.36, high: 3868.44, low: 3861.99, volume: 1 },
      { time: `${date} 09:40`, open: 3867.36, close: 3869.1, high: 3870, low: 3866, volume: 2 },
    ],
    getDailyKlines: async () => [{ date: "2026-08-25", open: 1, close: 3889.44, high: 2, low: 0.5, volume: 3 }],
  };
  const loadConfig = async () => ({
    indices: [{ symbol: "sh000001", code: "000001", name: "上证指数" }],
  });
  const readAlerts = async () => ({
    items: [
      {
        ts: "2026-08-25T02:00:00.000Z",
        code: "600519",
        name: "贵州茅台",
        type: "surge",
        changePct: 4,
        price: 104,
      },
      {
        ts: "2026-08-25T03:00:00.000Z",
        code: "sh000001",
        name: "上证指数",
        type: "plunge",
        changePct: -1.25,
        scope: "index",
      },
      {
        ts: "2026-08-24T03:00:00.000Z",
        code: "600519",
        name: "昨天的异动",
        type: "surge",
        changePct: 4,
        price: 104,
      },
    ],
  });

  const service = createDailyReviewService({
    marketService,
    loadConfig,
    readAlerts,
    eventsRepo,
    reviewStore,
    now,
  });

  const indices = await service.getIndices();
  assert.equal(indices.date, "2026-08-25");
  assert.equal(indices.indices[0].name, "上证指数");
  assert.equal(indices.indices[0].quote.changePct, 0.19);
  assert.equal(indices.indices[0].intraday.length, 2);

  await assert.rejects(() => service.getIndexDaily("sz000001"), /不在复盘清单/);
  const daily = await service.getIndexDaily("sh000001", 120);
  assert.equal(daily.days, 120);

  const timeline = await service.getTimeline();
  assert.deepEqual(
    timeline.items.map((item) => item.source),
    ["ai", "watchdog", "watchdog", "manual"],
  );
  const indexAlert = timeline.items.find((item) => item.kind === "index");
  assert.equal(indexAlert.title, "指数急跌");
  assert.equal(indexAlert.changePct, -1.25);

  const context = await service.collectReviewContext();
  assert.equal(context.indices[0].name, "上证指数");
  assert.equal(context.events.length, 3); // ai 不进 LLM 上下文
});
