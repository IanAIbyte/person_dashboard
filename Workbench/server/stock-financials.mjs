// A 股财务指标封装（新浪财务指标页，GBK HTML 表格解析）。
// 指标：ROE（摊薄）、销售毛利率、净利增速、营收增速、资产负债率、EPS。
// 日级磁盘缓存（vault 内 json），解析失败降级为 null（页面显示「财务数据不可用」）。
// 注意：新浪 HTML 结构若变化，本模块容错返回 null，不影响其他数据。

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const FINANCE_ORIGIN = "https://money.finance.sina.com.cn";
const CACHE_PATH_DIR = "10_raw/my-thoughts/reading-notes";
const CACHE_FILE = ".workbench-stock-financials.json";
const CACHE_TTL_MS = 24 * 60 * 60_000; // 财务缓存 1 天
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

function failSoft(context, error) {
  return { ok: false, context, message: error?.message || String(error) };
}

// 从 GB2312 HTML 提取指标表行：新浪的财务指标页是 <td> 列表，
// 每行形如「指标名</td><td>Q4值</td><td>Q3值…」。按指标名抓最近一期值。
function extractIndicator(html, label) {
  // 匹配「指标名」后的第一组数值单元格（跳过非数值占位）。
  const pattern = new RegExp(`${label}(?:<[^>]*>|\\s)*</td>((?:<td[^>]*>[^<]*</td>)+)`, "i");
  const match = html.match(pattern);
  if (!match) return null;
  const cells = match[1].match(/<td[^>]*>([^<]*)<\/td>/gi) ?? [];
  for (const cell of cells) {
    const text = cell.replace(/<[^>]*>/g, "").trim();
    if (!text) continue;
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchFinancialsPage(fetchImpl, code, year, timeoutMs) {
  const url = `${FINANCE_ORIGIN}/corp/go.php/vFD_FinancialGuideLine/stockid/${code}/ctrl/${year}/displaytype/4.phtml`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 解析某年四季报指标，返回按报告期倒序的数组（最新在前）。
// 页面结构（实测 2026-08）：<a ...>指标名(单位)</a></td><td>Q4</td><td>Q3</td>...
// 第一列为最新报告期；缺失值显示 "--"（保持缺失，不编造）。
function parseYearIndicators(html, year) {
  if (!html) return [];
  // 报告期列头：仅认当年四个标准报告期，倒序（与列值顺序一致）。
  const reportDates = [
    `${year}-12-31`,
    `${year}-09-30`,
    `${year}-06-30`,
    `${year}-03-31`,
  ].filter((d) => html.includes(d));
  if (reportDates.length === 0) return [];

  const indicators = [
    ["roe", "净资产收益率"],
    ["grossMargin", "销售毛利率"],
    ["netProfitGrowth", "净利润增长率"],
    ["revenueGrowth", "主营业务收入增长率"],
    ["debtRatio", "资产负债率"],
    ["eps", "摊薄每股收益"],
  ];
  const rows = [];
  for (const [key, label] of indicators) {
    // 指标名后允许「(%)」「(元)」等单位文本与闭合标签，再接数据单元格。
    const pattern = new RegExp(
      `${label}[^<]*(?:<[^>]*>)*\\s*</td>((?:\\s*<td[^>]*>[^<]*</td>)+)`,
      "i",
    );
    const match = html.match(pattern);
    if (!match) continue;
    const cells = (match[1].match(/<td[^>]*>([^<]*)<\/td>/gi) ?? [])
      .map((cell) => cell.replace(/<[^>]*>/g, "").trim());
    rows.push({ key, cells });
  }

  const periods = [];
  for (let col = 0; col < reportDates.length; col += 1) {
    const entry = { reportDate: reportDates[col] };
    let hasValue = false;
    for (const row of rows) {
      const raw = row.cells[col];
      if (raw != null && raw !== "" && raw !== "--") {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          entry[row.key] = n;
          hasValue = true;
        }
      }
    }
    if (hasValue) periods.push(entry);
  }
  return periods;
}

export function createStockFinancialsService({
  vaultRoot,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  now = () => Date.now(),
} = {}) {
  const cachePath = path.join(path.resolve(vaultRoot), CACHE_PATH_DIR, CACHE_FILE);
  const cacheDir = path.dirname(cachePath);

  async function readCache() {
    try {
      const details = await stat(cachePath);
      if (!details.isFile() || details.size > MAX_CACHE_BYTES) return {};
      return JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      return {};
    }
  }

  async function writeCache(cache) {
    try {
      await mkdir(cacheDir, { recursive: true });
      const tmp = `${cachePath}.${Date.now()}.tmp`;
      const body = JSON.stringify(cache, null, 2);
      await writeFile(tmp, body, "utf8");
      await rename(tmp, cachePath);
    } catch {
      // 缓存写失败静默（只读内存态降级）。
    }
  }

  // 获取一只股票的财务指标（跨近两年，取最新四期）。
  async function getFinancials(code) {
    if (!/^\d{6}$/.test(code)) return null;
    const cache = await readCache();
    const hit = cache[code];
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS) return hit;

    const year = new Date().getFullYear();
    const [htmlNow, htmlPrev] = await Promise.all([
      fetchFinancialsPage(fetchImpl, code, year, timeoutMs),
      fetchFinancialsPage(fetchImpl, code, year - 1, timeoutMs),
    ]);
    const periods = [
      ...parseYearIndicators(htmlNow, year),
      ...parseYearIndicators(htmlPrev, year - 1),
    ].sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));

    const entry = {
      code,
      fetchedAt: now(),
      available: periods.length > 0,
      periods,
    };
    cache[code] = entry;
    // 写缓存节流：避免每次调用都全量写盘。
    await writeCache(cache);
    return entry;
  }

  return Object.freeze({ getFinancials, failSoft });
}
