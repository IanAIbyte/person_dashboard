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

// 解析 du -k -d 1 输出：取 mount 下的一级目录（按大小降序）。
// 每行 "size_kb\tpath"；path 等于 mount 本身的总量行跳过。
export function parseDuOutput(text, mount) {
  const prefix = mount === "/" ? "/" : `${mount}/`;
  const items = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^(\d+)\t(.+)$/);
    if (!match) continue;
    const kb = Number(match[1]);
    const dirPath = match[2];
    if (dirPath === mount) continue; // 总量行
    let rest = dirPath;
    if (mount === "/") {
      if (!rest.startsWith("/") || rest.slice(1).includes("/")) continue;
      rest = rest.slice(1);
    } else {
      if (!rest.startsWith(prefix)) continue;
      rest = rest.slice(prefix.length);
      if (rest.includes("/")) continue;
    }
    if (!rest) continue;
    items.push({ name: rest, kb });
  }
  items.sort((a, b) => b.kb - a.kb);
  return { items };
}

export function createDisksMonitor({ execImpl = execFileAsync } = {}) {
  // 目录分析任务：du -x -d 1 -k 流式输出，运行中即可返回已完成部分。
  const dirAnalyses = new Map(); // mount -> { status, startedAt, finishedAt, items, error }

  function startDirAnalysis(mount, knownMounts) {
    if (!knownMounts.includes(mount)) throw new Error("未知挂载点");
    const running = dirAnalyses.get(mount);
    if (running?.status === "running") return running;
    const entry = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, items: [], error: null };
    dirAnalyses.set(mount, entry);
    // 手动 spawn 以便流式读取进度；-x 不跨文件系统，-d 1 只取一级目录。
    const child = execFile("du", ["-x", "-d", "1", "-k", mount], { maxBuffer: 64 * 1024 * 1024 }, (error) => {
      entry.status = error && entry.items.length === 0 ? "failed" : "done";
      entry.error = entry.status === "failed" ? (error?.message ?? "分析失败") : null;
      entry.finishedAt = new Date().toISOString();
    });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      entry.items = parseDuOutput(lines.join("\n"), mount).items;
    });
    return entry;
  }

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
    startDirAnalysis,
    getDirAnalysis(mount) {
      return dirAnalyses.get(mount) ?? null;
    },
  };
}
