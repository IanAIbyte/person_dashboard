// 本机磁盘监控单测：df 解析（伪 fs 过滤 / APFS 容器合并 / 挂载点归一）。
import assert from "node:assert/strict";
import test from "node:test";

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
