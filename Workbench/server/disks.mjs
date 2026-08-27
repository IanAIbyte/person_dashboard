// 本机磁盘监控：解析 df -k -P，过滤伪文件系统并合并同一 APFS 容器的卷快照。
// macOS 上 / 与 /System/Volumes/Data 等共享同一容器（相同 blocks/available），
// 真实用量在 Data 卷；按容器分组取用量最大者，挂载点规范化为 /。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KB = 1024;

export function parseDfOutput(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/).slice(1)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 6) continue;
    const [filesystem, blocks, used, available, capacity, ...mountParts] = cells;
    const mount = mountParts.join(" ");
    const total = Number(blocks);
    const usedKb = Number(used);
    if (!Number.isFinite(total) || total <= 0) continue; // map auto_home 等伪卷
    if (/^(devfs|map |fdesc|nullfs)/.test(filesystem)) continue;
    // /System/Volumes 下的系统支撑卷只保留 Data（真实数据卷）
    if (mount.startsWith("/System/Volumes/") && mount !== "/System/Volumes/Data") continue;
    rows.push({ filesystem, mount, totalKb: total, usedKb, availKb: Number(available) });
  }
  // 同一 APFS 容器：相同容量且相同可用空间 → 合并，取用量最大的一行；含 Data+根时挂载点归一为 /
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.totalKb}:${row.availKb}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, members: [row.mount] });
    } else {
      existing.members.push(row.mount);
      if (row.usedKb > existing.usedKb) {
        existing.usedKb = row.usedKb;
        existing.filesystem = row.filesystem;
      }
    }
  }
  return [...groups.values()].map((group) => ({
    mount: group.members.includes("/System/Volumes/Data") && group.members.includes("/")
      ? "/"
      : group.mount,
    filesystem: group.filesystem,
    members: group.members,
    totalKb: group.totalKb,
    usedKb: group.usedKb,
    availKb: group.availKb,
  }));
}

export function createDisksMonitor({ execImpl = execFileAsync } = {}) {
  return {
    async list() {
      const { stdout } = await execImpl("df", ["-k", "-P"]);
      const gb = (kb) => Math.round((kb / KB / KB) * 10) / 10; // KB → GB 是 ÷1024²
      const parsed = parseDfOutput(stdout);
      const items = parsed.map((disk) => ({
        mount: disk.mount,
        filesystem: disk.filesystem,
        totalGb: gb(disk.totalKb),
        usedGb: gb(disk.usedKb),
        availGb: gb(disk.availKb),
        usePct: Math.round((disk.usedKb / disk.totalKb) * 100),
      }));
      return {
        checkedAt: new Date().toISOString(),
        totalGb: gb(parsed.reduce((sum, disk) => sum + disk.totalKb, 0)),
        usedGb: gb(parsed.reduce((sum, disk) => sum + disk.usedKb, 0)),
        items,
      };
    },
  };
}
