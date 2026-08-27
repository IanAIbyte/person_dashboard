// 服务器注册表：~/.ssh/config 为主数据源（只读派生），iTerm2 plist 补充
// （发现仅存在于 profile 命令中的主机）。不做第二份存储。
// 健康探测 = TCP 22 连通性 + 可选 SSH banner；打开终端 = osascript 驱动 iTerm。

import net from "node:net";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

// 解析 ~/.ssh/config：支持多 Host 一行、注释、大小写关键字；忽略通配 Host 与 Include。
export function parseSshConfig(text) {
  const hosts = [];
  let group = []; // 同一 Host 行的所有别名共享后续配置
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(/\s+/);
    const key = rawKey.toLowerCase();
    const value = rest.join(" ");
    if (key === "host") {
      group = [];
      for (const name of value.split(/\s+/).filter(Boolean)) {
        if (/[*?]/.test(name)) continue; // 通配块（Host *）不作为可登录主机
        const entry = { host: name, hostName: null, user: null, port: null, identityFile: null };
        group.push(entry);
        hosts.push(entry);
      }
    } else if (group.length > 0 && (key === "hostname" || key === "user" || key === "port" || key === "identityfile")) {
      const field = { hostname: "hostName", user: "user", port: "port", identityfile: "identityFile" }[key];
      for (const entry of group) entry[field] = value || null;
    }
  }
  return hosts;
}

// 从 iTerm2 plist 提取 ssh 目标：profile 的自定义命令里 ssh 的目标主机。
// 启发式：最后一个 token 视为目标（覆盖 `ssh host` 与 `ssh -J bastion host` 等带参形式）。
export function extractItermSshTargets(plistJson) {
  const parsed = typeof plistJson === "string" ? JSON.parse(plistJson) : plistJson;
  const profiles = Array.isArray(parsed?.Profiles)
    ? parsed.Profiles
    : Object.values(parsed?.Profiles ?? {});
  const targets = [];
  for (const profile of profiles) {
    const name = typeof profile?.Name === "string" ? profile.Name : null;
    const command = String(profile?.["Custom Command"] ?? "").trim();
    if (!/^ssh\s/.test(command)) continue;
    const tokens = command.split(/\s+/);
    const target = tokens.at(-1);
    if (target && /^[A-Za-z0-9._@:-]+$/.test(target)) {
      targets.push({ profile: name, target, command });
    }
  }
  return targets;
}

export function createServersRegistry({
  homeDir = process.env.HOME ?? "",
  readFileImpl = readFile,
  execImpl = execFileAsync,
} = {}) {
  async function readSshConfig() {
    try {
      return parseSshConfig(await readFileImpl(path.join(homeDir, ".ssh/config"), "utf8"));
    } catch {
      return [];
    }
  }

  async function readItermTargets() {
    try {
      const plistPath = path.join(homeDir, "Library/Preferences/com.googlecode.iterm2.plist");
      const { stdout } = await execImpl("plutil", ["-convert", "json", "-o", "-", plistPath]);
      return extractItermSshTargets(stdout);
    } catch {
      return []; // iTerm 未装/偏好未生成：静默降级
    }
  }

  // 合并：ssh.config 为主；iTerm 目标若匹配别名或 HostName 则挂 profile 名，
  // 否则作为「仅 iTerm」条目（无 port/user 细节）。
  async function list() {
    const [hosts, targets] = await Promise.all([readSshConfig(), readItermTargets()]);
    const items = hosts.map((host) => ({ ...host, source: "ssh-config", profiles: [] }));
    const findByTarget = (target) =>
      items.find((item) => item.host === target || item.hostName === target) ?? null;
    for (const { profile, target } of targets) {
      const matched = findByTarget(target);
      if (matched) matched.profiles.push(profile ?? target);
      else items.push({ host: target, hostName: null, user: target.includes("@") ? target.split("@")[0] : null, port: null, identityFile: null, source: "iterm", profiles: profile ? [profile] : [] });
    }
    return items;
  }

  return { list };
}

// TCP 22 探测：连通即在线，记录握手延迟，尽力读 SSH banner（500ms 容忍）。
export function probeServer({ hostName, port = 22, netImpl = net, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = netImpl.createConnection({ host: hostName, port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() });
    };
    const timer = setTimeout(() => finish({ ok: false, error: "超时", banner: null }), timeoutMs);
    socket.on("connect", () => {
      // 等 banner 最多 500ms，等不到也不算失败。
      const bannerTimer = setTimeout(() => finish({ ok: true, banner: null }), 500);
      socket.on("data", (chunk) => {
        clearTimeout(bannerTimer);
        const banner = String(chunk).split(/\r?\n/)[0]?.trim() ?? null;
        finish({ ok: true, banner });
      });
      socket.on("error", () => {
        clearTimeout(bannerTimer);
        finish({ ok: true, banner: null });
      });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: error?.code ?? error?.message, banner: null });
    });
  });
}

// 在 iTerm2 新窗口执行 ssh <host>。host 限定安全字符防 shell 注入。
export async function openItermSsh(host, { execImpl = execFileAsync } = {}) {
  if (!/^[A-Za-z0-9._@-]+$/.test(host)) throw new Error("非法主机名");
  const script = `tell application "iTerm2" to create window with default profile command "ssh ${host}"`;
  await execImpl("osascript", ["-e", script]);
  return { opened: true };
}
