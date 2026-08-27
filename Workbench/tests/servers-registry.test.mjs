// 服务器注册表单测：ssh config 解析 / iTerm 提取 / 合并 / 探测(fake net)/ 打开校验。
import assert from "node:assert/strict";
import test from "node:test";

import {
  createServersRegistry,
  extractItermSshTargets,
  openItermSsh,
  parseSshConfig,
  probeServer,
} from "../server/servers-registry.mjs";

const SSH_FIXTURE = `
# 注释行
Host web1 web2
  HostName 10.0.0.11
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host *
  ServerAliveInterval 30

Host db
  hostname 10.0.0.20
  user root
`;

test("parseSshConfig handles multi-host, comments, wildcards, lowercase keys", () => {
  const hosts = parseSshConfig(SSH_FIXTURE);
  assert.equal(hosts.length, 3); // web1/web2/db，通配 Host * 忽略
  assert.deepEqual(hosts[0], { host: "web1", hostName: "10.0.0.11", user: "deploy", port: "2222", identityFile: "~/.ssh/id_ed25519" });
  assert.equal(hosts[2].host, "db");
  assert.equal(hosts[2].hostName, "10.0.0.20");
});

test("extractItermSshTargets pulls ssh commands from profiles", () => {
  const plist = {
    Profiles: [
      { Name: "web1-生产", "Custom Command": "ssh web1" },
      { Name: "跳板", "Custom Command": "ssh -J bastion db" },
      { Name: "本地 shell", "Custom Command": "" },
    ],
  };
  const targets = extractItermSshTargets(plist);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], { profile: "web1-生产", target: "web1", command: "ssh web1" });
  assert.equal(targets[1].target, "db");
});

test("registry merges ssh config as source of truth and attaches profiles", async () => {
  const registry = createServersRegistry({
    homeDir: "/fake-home",
    readFileImpl: async (path) => (path.endsWith(".ssh/config") ? SSH_FIXTURE : Promise.reject(new Error("ENOENT"))),
    execImpl: async () => ({
      stdout: JSON.stringify({ Profiles: [{ Name: "web1-生产", "Custom Command": "ssh web1" }, { Name: "孤儿", "Custom Command": "ssh orphan-host" }] }),
    }),
  });
  const items = await registry.list();
  assert.equal(items.length, 4); // web1/web2/db + 仅 iTerm 的 orphan-host
  const web1 = items.find((item) => item.host === "web1");
  assert.deepEqual(web1.profiles, ["web1-生产"]);
  const orphan = items.find((item) => item.host === "orphan-host");
  assert.equal(orphan.source, "iterm");
});

test("probeServer reports ok with banner, latency and checkedAt", async () => {
  const listeners = {};
  const fakeSocket = {
    on: (event, handler) => { listeners[event] = handler; return fakeSocket; },
    removeAllListeners: () => {},
    destroy: () => {},
  };
  const netImpl = { createConnection: () => fakeSocket };
  const pending = probeServer({ hostName: "10.0.0.11", port: 2222, netImpl, timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  listeners.connect();
  await new Promise((resolve) => setTimeout(resolve, 5));
  listeners.data(Buffer.from("SSH-2.0-OpenSSH_9.6\r\nxx"));
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.banner, "SSH-2.0-OpenSSH_9.6");
  assert.ok(result.latencyMs >= 0);
  assert.ok(result.checkedAt);
});

test("probeServer captures connection errors", async () => {
  const listeners = {};
  const fakeSocket = {
    on: (event, handler) => { listeners[event] = handler; return fakeSocket; },
    removeAllListeners: () => {},
    destroy: () => {},
  };
  const netImpl = { createConnection: () => fakeSocket };
  const pending = probeServer({ hostName: "nope", port: 22, netImpl, timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  listeners.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, "ECONNREFUSED");
});

test("openItermSsh rejects unsafe host names", async () => {
  await assert.rejects(() => openItermSsh('x"; rm -rf', { execImpl: async () => {} }), /非法主机名/);
  const calls = [];
  await openItermSsh("web1", { execImpl: async (cmd, args) => { calls.push([cmd, ...args]); } });
  assert.equal(calls[0][0], "osascript");
  assert.ok(calls[0][2].includes("ssh web1"));
});
