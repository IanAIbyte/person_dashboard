import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadDailyReviewConfig } from "../server/daily-review-config.mjs";

async function makeRoot(files) {
  const root = await mkdtemp(path.join(tmpdir(), "dr-config-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, "config", name), JSON.stringify(content));
  }
  return root;
}

const VALID = {
  schemaVersion: 1,
  indices: [{ symbol: "sh000001", code: "000001", name: "上证指数" }],
};

test("falls back to default file and reports source", async () => {
  const root = await makeRoot({ "daily-review.default.json": VALID });
  const config = await loadDailyReviewConfig(root);
  assert.equal(config.source, "default");
  assert.equal(config.indices[0].symbol, "sh000001");
});

test("local file wins over default", async () => {
  const root = await makeRoot({
    "daily-review.default.json": VALID,
    "daily-review.local.json": {
      schemaVersion: 1,
      indices: [
        { symbol: "sh000001", code: "000001", name: "上证指数" },
        { symbol: "sz399001", code: "399001", name: "深证成指" },
      ],
    },
  });
  const config = await loadDailyReviewConfig(root);
  assert.equal(config.source, "local");
  assert.equal(config.indices.length, 2);
});

test("rejects invalid configs", async () => {
  await assert.rejects(
    makeRoot({ "daily-review.default.json": { schemaVersion: 2, indices: [] } }).then(loadDailyReviewConfig),
    /schemaVersion/,
  );
  await assert.rejects(
    makeRoot({ "daily-review.default.json": { schemaVersion: 1, indices: [] } }).then(loadDailyReviewConfig),
    /1-16/,
  );
  await assert.rejects(
    makeRoot({
      "daily-review.default.json": {
        schemaVersion: 1,
        indices: [
          { symbol: "000001", code: "000001", name: "缺前缀" },
        ],
      },
    }).then(loadDailyReviewConfig),
    /sh000001/,
  );
  await assert.rejects(
    makeRoot({
      "daily-review.default.json": {
        schemaVersion: 1,
        indices: [
          { symbol: "sh000001", code: "000001", name: "A" },
          { symbol: "sh000001", code: "000001", name: "重复" },
        ],
      },
    }).then(loadDailyReviewConfig),
    /unique/,
  );
});
