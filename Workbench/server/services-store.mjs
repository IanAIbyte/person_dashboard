// 云服务管理：注册表 CRUD + HTTP 健康探测。
// 数据存 vault 下 .workbench-services.json（与复盘/盯盘等状态文件同层），
// 变更经插件层 vaultSync.notifyPaths 触发前端自动刷新。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SERVICES_SCHEMA_VERSION = 1;
const MAX_NAME = 80;
const MAX_URL = 300;
const MAX_NOTE = 500;
const PROBE_TIMEOUT_MS = 5_000;

export function createServicesStore({ vaultRoot, fileName = ".workbench-services.json" } = {}) {
  const filePath = path.join(vaultRoot, "10_raw/my-thoughts/reading-notes", fileName);

  async function readAll() {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== SERVICES_SCHEMA_VERSION || !Array.isArray(parsed.items)) return null;
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: SERVICES_SCHEMA_VERSION, updatedAt: null, items: [] };
      throw error;
    }
  }

  async function persist(state) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const next = { ...state, updatedAt: new Date().toISOString() };
    const temp = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rename(temp, filePath);
    return next;
  }

  function normalize(body) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    const note = typeof body?.note === "string" ? body.note.trim() : "";
    if (!name || name.length > MAX_NAME) return { error: "服务名必填且不超过 80 字" };
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > MAX_URL) return { error: "URL 必须以 http(s):// 开头" };
    if (note.length > MAX_NOTE) return { error: "备注不超过 500 字" };
    return { value: { name, url, note } };
  }

  return {
    filePath,
    async list() {
      const state = (await readAll()) ?? { version: SERVICES_SCHEMA_VERSION, updatedAt: null, items: [] };
      return state;
    },
    async add(body) {
      const normalized = normalize(body);
      if (normalized.error) throw new Error(normalized.error);
      const state = await this.list();
      if (state.items.some((item) => item.url === normalized.value.url)) {
        throw new Error("该 URL 已注册");
      }
      const item = {
        id: randomUUID(),
        ...normalized.value,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const next = await persist({ ...state, items: [...state.items, item] });
      return { state: next, item };
    },
    async update(id, body) {
      const normalized = normalize(body);
      if (normalized.error) throw new Error(normalized.error);
      const state = await this.list();
      const index = state.items.findIndex((item) => item.id === id);
      if (index < 0) return null;
      if (state.items.some((item, i) => i !== index && item.url === normalized.value.url)) {
        throw new Error("该 URL 已被其他服务注册");
      }
      const item = { ...state.items[index], ...normalized.value, updatedAt: new Date().toISOString() };
      const items = state.items.toSpliced(index, 1, item);
      const next = await persist({ ...state, items });
      return { state: next, item };
    },
    async remove(id) {
      const state = await this.list();
      const items = state.items.filter((item) => item.id !== id);
      if (items.length === state.items.length) return false;
      await persist({ ...state, items });
      return true;
    },
  };
}

// 单服务健康探测：HEAD 优先（轻），被拒（405/501）或异常时回退 GET。
// 返回 { ok, code, latencyMs, checkedAt, error? }。
export async function checkService(url, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const started = now();
  const attempt = async (method) => {
    const response = await fetchImpl(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.status;
  };
  try {
    let code;
    try {
      code = await attempt("HEAD");
      if (code === 405 || code === 501) code = await attempt("GET");
    } catch {
      code = await attempt("GET");
    }
    return { ok: code >= 200 && code < 400, code, latencyMs: now() - started, checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      code: null,
      latencyMs: now() - started,
      checkedAt: new Date().toISOString(),
      error: error?.name === "TimeoutError" ? "超时" : (error?.message ?? "不可达"),
    };
  }
}
