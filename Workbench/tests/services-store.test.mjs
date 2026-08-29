// 服务管理 store 与健康探测单测：mkdtemp 临时 vault + 假 fetch，不出网。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkService, createServicesStore } from "../server/services-store.mjs";

test("services store CRUD with validation and dedupe", async (t) => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "services-store-"));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const store = createServicesStore({ vaultRoot });

  assert.equal((await store.list()).items.length, 0);

  const { item } = await store.add({ name: "Reactive Resume", url: "http://10.0.0.1:3000/", note: "简历服务" });
  assert.ok(item.id);

  await assert.rejects(() => store.add({ name: "重复", url: "http://10.0.0.1:3000/" }), /已注册/);
  await assert.rejects(() => store.add({ name: "坏地址", url: "ftp://x" }), /http/);

  const updated = await store.update(item.id, { name: "简历", url: "http://10.0.0.1:3000/", note: "" });
  assert.equal(updated.item.name, "简历");

  const onDisk = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].name, "简历");

  assert.equal(await store.remove(item.id), true);
  assert.equal(await store.remove(item.id), false);
  assert.equal((await store.list()).items.length, 0);
});

test("checkService probes HEAD with GET fallback and captures failures", async () => {
  const ok = await checkService("http://up.example", {
    fetchImpl: async () => ({ status: 200 }),
    now: (() => { let t = 0; return () => (t += 10); })(),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 200);
  assert.equal(ok.latencyMs, 10);

  const calls = [];
  const fallback = await checkService("http://picky.example", {
    fetchImpl: async (url, { method }) => {
      calls.push(method);
      return { status: method === "HEAD" ? 405 : 200 };
    },
    now: (() => { let t = 0; return () => (t += 5); })(),
  });
  assert.deepEqual(calls, ["HEAD", "GET"]);
  assert.equal(fallback.ok, true);

  const down = await checkService("http://down.example", {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(down.ok, false);
  assert.equal(down.error, "ECONNREFUSED");
  assert.equal(down.code, null);
});
