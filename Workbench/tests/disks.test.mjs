// 本机磁盘监控单测：df 解析（伪 fs 过滤 / APFS 容器合并 / 挂载点归一）+ 每日缓存。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDisksMonitor, parseDfOutput, parseDuOutput } from "../server/disks.mjs";

// 结构取自真实 macOS df 输出（数值做无害缩放）。
const DF_FIXTURE = [
  "Filesystem     1024-blocks      Used  Available Capacity  Mounted on",
  "/dev/disk3s1s1   239362496  16690840   77381940    18%    /",
  "devfs                  217       217          0   100%    /dev",
  "/dev/disk3s6     239362496  15729084   77381940    17%    /System/Volumes/VM",
  "/dev/disk3s5     239362496 108615424   77381940    59%    /System/Volumes/Data",
  "/dev/disk1s2        512000      6164     494304     2%    /System/Volumes/xarts",
  "map auto_home            0         0          0   100%    /System/Volumes/Data/home",
  "/dev/disk5s1    2000193840  38579288 1961317392     2%    /Volumes/Data",
].join("\n");

test("parseDfOutput filters pseudo filesystems and merges APFS container snapshots", () => {
  const disks = parseDfOutput(DF_FIXTURE);
  assert.equal(disks.length, 2); // 根容器(合并) + 外接卷
  const root = disks.find((disk) => disk.mount === "/");
  assert.ok(root);
  assert.equal(root.usedKb, 108615424); // 取容器内用量最大的 Data 卷
  assert.deepEqual(root.members.sort(), ["/", "/System/Volumes/Data"]); // VM 等支撑卷已被排除
  const external = disks.find((disk) => disk.mount === "/Volumes/Data");
  assert.equal(external.totalKb, 2000193840);
});

test("disksMonitor list returns GB figures and totals", async () => {
  const monitor = createDisksMonitor({
    execImpl: async (cmd, args) => {
      assert.equal(cmd, "df");
      assert.deepEqual(args, ["-k", "-P"]);
      return { stdout: DF_FIXTURE };
    },
  });
  const result = await monitor.list();
  assert.ok(result.checkedAt);
  assert.equal(result.items.length, 2);
  const root = result.items.find((disk) => disk.mount === "/");
  assert.equal(root.usePct, 45); // 108615424/239362496 ≈ 45%
  assert.equal(root.totalGb, 228.3);
  assert.ok(result.totalGb > result.usedGb);
});

test("parseDuOutput keeps only first-level dirs sorted by size", () => {
  const duFixture = [
    "108615424\t/",
    "60000000\t/Users",
    "48384000\t/Users/ian", // 二级：应被过滤
    "40000000\t/Applications",
    "9431040\t/private",
    "8192\t/opt",
  ].join("\n");
  const { items } = parseDuOutput(duFixture, "/");
  assert.deepEqual(items.map((item) => item.name), ["Users", "Applications", "private", "opt"]);
  assert.equal(items[0].kb, 60000000);

  const external = parseDuOutput(["38579288\t/Volumes/Data", "20000000\t/Volumes/Data/Github", "9000000\t/Volumes/Data/Backup"].join("\n"), "/Volumes/Data");
  assert.deepEqual(external.items.map((item) => item.name), ["Github", "Backup"]);
});

test("list 缓存当天复用：自动刷新零重跑，force 或跨天才重新取数", async () => {
  let now = new Date("2026-08-28T10:00:00+08:00");
  let calls = 0;
  const monitor = createDisksMonitor({
    nowImpl: () => now,
    execImpl: async () => {
      calls += 1;
      return { stdout: DF_FIXTURE };
    },
  });
  await monitor.list();
  await monitor.list();
  await monitor.list({ force: true });
  assert.equal(calls, 2); // 当天两次自动刷新共用缓存，手动 force 才重跑
  now = new Date("2026-08-29T09:00:00+08:00");
  await monitor.list();
  assert.equal(calls, 3); // 第二天第一次自动刷新重新取数
});

// du 完成后的落盘在回调里 fire-and-forget，读取快照前先等它落定。
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("每日快照落盘：重启后同一天直接复用，不触发 df", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "disks-cache-"));
  const statePath = path.join(dir, "cache.json");
  try {
    let calls = 0;
    const first = createDisksMonitor({
      statePath,
      execImpl: async () => {
        calls += 1;
        return { stdout: DF_FIXTURE };
      },
    });
    await first.list();
    assert.equal(calls, 1);

    // 模拟服务重启：新实例从快照 hydrate，df 不应被再次调用
    const second = createDisksMonitor({
      statePath,
      execImpl: async () => {
        throw new Error("不应重跑 df");
      },
    });
    const cached = await second.list();
    assert.equal(cached.items.length, 2);
    assert.equal(cached.items.find((disk) => disk.mount === "/").usePct, 45);
    assert.equal(calls, 1);

    // 非当天快照视为过期：跨天后重新取数
    await rm(statePath, { force: true });
    await writeFile(statePath, `${JSON.stringify({ day: "2020-01-01", list: null, dirs: {} })}\n`, "utf8");
    const third = createDisksMonitor({
      statePath,
      execImpl: async () => {
        calls += 1;
        return { stdout: DF_FIXTURE };
      },
    });
    await third.list();
    assert.equal(calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});

test("目录分析当天复用，完成结果随快照落盘恢复", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "disks-du-"));
  const statePath = path.join(dir, "cache.json");
  try {
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "a.txt"), "x".repeat(4096));
    const first = createDisksMonitor({ statePath });
    const entry = first.startDirAnalysis(dir, [dir]);
    assert.equal(entry.status, "running");
    for (let i = 0; i < 50 && first.getDirAnalysis(dir)?.status === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(first.getDirAnalysis(dir)?.status, "done");
    const doneAt = first.getDirAnalysis(dir).finishedAt;
    await settle(); // 完成回调里的落盘是 fire-and-forget，先等它落定

    // 同一实例当天复用：不重新分析
    assert.equal(first.startDirAnalysis(dir, [dir]).finishedAt, doneAt);

    // 模拟重启：新实例从落盘快照恢复 done 结果（finishedAt 一致即未重跑）
    const second = createDisksMonitor({
      statePath,
      execImpl: async () => ({ stdout: DF_FIXTURE }),
    });
    await second.list(); // 等待 hydrate 完成
    const restored = second.startDirAnalysis(dir, [dir]);
    assert.equal(restored.status, "done");
    assert.equal(restored.finishedAt, doneAt);
    assert.deepEqual(restored.items.map((item) => item.name), ["sub"]);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  }
});
