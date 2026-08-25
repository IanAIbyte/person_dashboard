// 每日复盘盯盘 watchdog（独立进程：npm run watchdog）。
// 与 dev server 解耦常驻运行：交易时段轮询股票池行情 → 急拉/急跌/涨跌停
// 检测 → Server酱微信推送 + 异动记录落库（页面「异动中心」读取展示）。
// 收盘后落估值快照（自建 PE/PB 历史）+ 预热财务缓存。
//
// 配置：SERVERCHAN_SENDKEY 读 Workbench/.env；阈值/开关读 vault 内
// .workbench-watchdog-config.json（页面可改，watchdog 每 tick 重读生效）。

import { readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMarketDataService } from "./market-data.mjs";
import { createStockFinancialsService } from "./stock-financials.mjs";
import { createStockPoolRepository } from "./stock-pool.mjs";
import { createStockCodesRepository } from "./stock-codes.mjs";
import { pushServerChan } from "./serverchan.mjs";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vaultRoot = path.resolve(workbenchRoot, "..", "个人知识库");
const STATE_DIR = path.join(vaultRoot, "10_raw/my-thoughts/reading-notes");
const ALERTS_PATH = path.join(STATE_DIR, ".workbench-stock-alerts.json");
const CONFIG_PATH = path.join(STATE_DIR, ".workbench-watchdog-config.json");
const VALUATION_PATH = path.join(STATE_DIR, ".workbench-valuation-history.json");

const TICK_MS = 30_000;
const MAX_ALERT_ITEMS = 500;

const DEFAULT_CONFIG = {
  enabled: true,
  thresholdPct: 3,        // 窗口内涨跌幅阈值（%）
  windowMinutes: 5,       // 急拉急跌检测窗口（分钟）
  cooldownMinutes: 15,    // 同股同向冷却（分钟）
  pushEnabled: true,      // Server酱推送开关
  dailyPushLimit: 5,      // Server酱免费额度（条/天）
};

// ---- .env 解析（仅 SERVERCHAN_SENDKEY）----
async function loadEnv() {
  try {
    const text = await readFile(path.join(workbenchRoot, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env 不存在时静默（SENDKEY 缺失仅禁用推送，不阻断盯盘与落库）。
  }
}

// ---- json 状态读写（原子写）----
async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, filePath);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function log(...args) {
  console.log(`[watchdog ${new Date().toLocaleTimeString("zh-CN")}]`, ...args);
}

// ---- 交易时段（A 股：工作日 9:30-11:30 / 13:00-15:00）----
function isTradingHours(now = new Date()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hm = now.getHours() * 100 + now.getMinutes();
  return (hm >= 930 && hm <= 1130) || (hm >= 1300 && hm < 1500);
}

// ---- Server酱推送：见 serverchan.mjs（与 vite-plugin 共用）----

// ---- 主逻辑 ----
async function main() {
  await loadEnv();
  const sendKey = process.env.SERVERCHAN_SENDKEY || null;
  const market = createMarketDataService();
  const financials = createStockFinancialsService({ vaultRoot });
  const poolRepo = createStockPoolRepository({ vaultRoot });
  const codesRepo = createStockCodesRepository({ vaultRoot });

  // code -> [{ts, price}]（窗口内采样）；code+方向 -> 上次触发时间；今日推送计数
  const samples = new Map();
  const cooldowns = new Map();
  let pushedToday = 0;
  let pushCountDate = today();
  let eodDoneDate = null;

  async function loadConfig() {
    const saved = await readJson(CONFIG_PATH, {});
    return { ...DEFAULT_CONFIG, ...saved };
  }

  async function recordAlert(alert, config) {
    const store = await readJson(ALERTS_PATH, { date: today(), items: [] });
    // 跨天滚动：保留近 7 天记录。
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    const items = [...(store.items ?? []), alert]
      .filter((item) => Date.parse(item.ts) >= cutoff)
      .slice(-MAX_ALERT_ITEMS);
    await writeJsonAtomic(ALERTS_PATH, { date: today(), updatedAt: new Date().toISOString(), items });
    log(`异动记录：${alert.name} ${alert.type} ${alert.changePct}%`);

    if (!config.pushEnabled) return;
    if (pushCountDate !== today()) {
      pushCountDate = today();
      pushedToday = 0;
    }
    if (pushedToday >= config.dailyPushLimit) {
      log(`已达每日推送上限（${config.dailyPushLimit}），仅记录不推送`);
      return;
    }
    const typeLabel = alert.type === "surge" ? "急拉" : alert.type === "plunge" ? "急跌"
      : alert.type === "limitUp" ? "触及涨停" : alert.type === "limitDown" ? "触及跌停" : "异动";
    const direction = alert.changePct > 0 ? "+" : "";
    const title = `【${typeLabel}】${alert.name} ${direction}${alert.changePct}%`;
    const desp = [
      `**${alert.name}（${alert.code}）**`,
      `- 类型：${typeLabel}`,
      `- 幅度：${direction}${alert.changePct}%（${config.windowMinutes} 分钟窗口）`,
      `- 现价：${alert.price}`,
      `- 时间：${new Date(alert.ts).toLocaleString("zh-CN")}`,
      "",
      "*来自 司南工作台 · 每日复盘盯盘*",
    ].join("\n");
    const result = await pushServerChan(sendKey, title, desp);
    if (result.ok) {
      pushedToday += 1;
      log(`已推送（今日 ${pushedToday}/${config.dailyPushLimit}）`);
    } else {
      log(`推送失败：${result.reason}`);
    }
  }

  // 收盘后任务：估值快照落库 + 财务缓存预热（每日一次）。
  async function endOfDay() {
    const date = today();
    if (eodDoneDate === date) return;
    eodDoneDate = date;
    const overrides = await codesRepo.overrides();
    const stocks = await poolRepo.pool(overrides);
    const codes = stocks.filter((s) => s.code).map((s) => s.code);
    const quotes = await market.getQuotes(codes);
    const history = await readJson(VALUATION_PATH, {});
    for (const [code, quote] of quotes) {
      if (quote.peTtm == null && quote.pb == null) continue;
      const series = history[code] ?? [];
      if (series.some((point) => point.date === date)) continue;
      series.push({ date, pe: quote.peTtm, pb: quote.pb, price: quote.price });
      history[code] = series.slice(-2500); // 约十年日频上限
    }
    await writeJsonAtomic(VALUATION_PATH, history);
    log(`收盘快照落库：${quotes.size} 只`);
    // 预热财务缓存（失败静默，页面按需再拉）。
    await Promise.allSettled(codes.slice(0, 40).map((code) => financials.getFinancials(code)));
  }

  // 自建估值历史的分位计算（供页面读取时用，watchdog 内不调用）。
  async function tick() {
    const config = await loadConfig();
    if (!config.enabled) return;

    if (!isTradingHours()) {
      // 收盘后 15:05-23:59 执行一次收盘任务。
      const hm = new Date().getHours() * 100 + new Date().getMinutes();
      if (hm >= 1505) await endOfDay();
      return;
    }

    const overrides = await codesRepo.overrides();
    const stocks = await poolRepo.pool(overrides);
    const tradable = stocks.filter((s) => s.code);
    if (tradable.length === 0) return;
    const quotes = await market.getQuotes(tradable.map((s) => s.code));
    const byCode = new Map(tradable.map((s) => [s.code, s]));
    const windowMs = config.windowMinutes * 60_000;
    const cooldownMs = config.cooldownMinutes * 60_000;
    const now = Date.now();

    for (const [code, quote] of quotes) {
      if (quote.price == null) continue;
      // 滚动窗口采样
      const deque = samples.get(code) ?? [];
      deque.push({ ts: now, price: quote.price });
      while (deque.length && now - deque[0].ts > windowMs) deque.shift();
      samples.set(code, deque);

      const base = deque[0]?.price;
      if (base == null || base === quote.price) continue;
      const changePct = ((quote.price - base) / base) * 100;
      const stock = byCode.get(code);

      let type = null;
      if (quote.limitUp != null && quote.price >= quote.limitUp) type = "limitUp";
      else if (quote.limitDown != null && quote.price <= quote.limitDown) type = "limitDown";
      else if (changePct >= config.thresholdPct) type = "surge";
      else if (changePct <= -config.thresholdPct) type = "plunge";
      if (!type) continue;

      // 冷却：同股同向
      const coolKey = `${code}:${type}`;
      const last = cooldowns.get(coolKey);
      if (last && now - last < cooldownMs) continue;
      cooldowns.set(coolKey, now);

      await recordAlert({
        ts: new Date(now).toISOString(),
        code,
        name: stock?.name ?? quote.name ?? code,
        type,
        changePct: Number(changePct.toFixed(2)),
        price: quote.price,
        windowMinutes: config.windowMinutes,
      }, config);
    }
  }

  log(`启动（vault: ${vaultRoot}）`);
  log(`推送：${sendKey ? "Server酱已配置" : "SENDKEY 未配置（仅落库不推送）"}`);
  if (!sendKey) log("提示：在 Workbench/.env 加 SERVERCHAN_SENDKEY=<你的key> 开启微信推送");
  await tick();
  const timer = setInterval(() => {
    void tick().catch((error) => log("tick 失败:", error?.message || error));
  }, TICK_MS);

  const shutdown = () => {
    clearInterval(timer);
    log("已停止");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[watchdog] 启动失败:", error);
  process.exit(1);
});
