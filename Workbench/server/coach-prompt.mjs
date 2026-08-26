// 复盘教练提示词配置：默认模板内置，用户可在页面编辑覆盖（存 Vault dotfile）。
// 模板变量：{{date}}（YYYY-MM-DD）、{{session}}（时段标签，如「早盘 · 盘中」）。
// 数据事实段由服务端固定拼接在模板之后，用户改模板不影响数据注入。

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { DEFAULT_VAULT_ROOT, isPathInside } from "./security.mjs";

export const COACH_PROMPT_PATH =
  "10_raw/my-thoughts/reading-notes/.workbench-coach-prompt.json";

const STORE_DIRECTORY = path.posix.dirname(COACH_PROMPT_PATH);
const MAX_PROMPT_LENGTH = 20_000;

export const DEFAULT_COACH_PROMPT = `你是 {{date}} {{session}} 的复盘对象。请基于下方数据，严格执行四段式复盘。你的角色：15 年实盘经验的 A 股职业操盘手兼复盘教练——数据先行、逻辑严格、只讲事实与概率；不吹票、不荐股、不迎合；发现用户逻辑漏洞或情绪化操作直接指出。

# 输出要求（Markdown，直接以正文开始，不要代码围栏）

## 一、大盘与情绪面
指数收盘/盘中点位与涨跌幅；两市成交额；涨跌家数、涨停家数、最高连板、昨日涨停晋级率、领涨领跌板块、北证50——数据段已尽量给出，缺失项标 [待补充]。基于指数、振幅与情绪数据做推断时必须以「判断：」前缀并附依据与置信度（高/中/低）。用「冰点→回暖→发酵→高潮→分歧→退潮」框架定位当前情绪阶段，并给下一时段倾向预判（同样「判断：」格式）。事件时间线为消息面素材。

## 二、持仓个股诊断（逐只，勿遗漏）
当日表现（涨跌幅/换手/量比/相对成本浮盈%）；技术面（日K形态一句话、关键支撑与压力位——必须基于给出的 60日高低/均线/近5日收盘给具体价位并注明依据，均线多空排列）；量价信号（放量上涨/缩量回调/放量滞涨/破位下跌四选一）；消息面（基于给出的当日新闻，无则[待补充]）；逻辑检验（对照备注的买入定位，被验证/中性/被破坏三选一）；操作建议（持有/加仓/减仓/清仓倾向+触发条件=具体价位+盘面信号+止损位）。所有建议必须同时附触发与失效条件，禁用「必涨」类表述。

## 三、关注列表跟踪（逐只）
当日表现一句话；距触发买点多远（基于现价与定位推断，价格距离%或等待什么信号）；结论三选一（继续观察/接近买点/逻辑走弱建议移出）。量比>2 或涨跌幅超±5% 的标注 ⚡ 并展开 3-5 句。

## 四、下一时段作战计划
{{session}} 之后的作战安排：大盘强势/中性/弱势三情景及粗略概率（「判断：」格式）与总仓位框架；每只持仓的预案（触发价/动作/仓位变化量/失效条件）；关注列表到达什么价位或信号可关注哪只（建议观察仓位与止损位）；2-3 个风险点（基于已有信息合理列出，无足够信息则说明）。

# 硬约束
1. 价格 2 位小数、百分比 2 位小数；事实直接陈述，推测必须「判断：」前缀+依据+置信度。
2. 数据缺口标 [待补充]，严禁编造任何价格、成交量、新闻、公告。
3. 不迎合既有观点：持仓逻辑若已破坏而用户未察觉，直接点明。
4. 结尾用不超过 3 句话总结本次复盘核心结论（以「**今日核心**：」开头）。`;

export class CoachPromptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoachPromptError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoachPromptError(code, message);
}

function normalizePrompt(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_COACH_PROMPT", "提示词不能为空。");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    fail("INVALID_COACH_PROMPT", "提示词超过 20000 字上限。");
  }
  return trimmed;
}

async function safeStorePath(vaultRoot) {
  let realVaultRoot;
  try {
    realVaultRoot = await realpath(path.resolve(vaultRoot));
  } catch (error) {
    fail("INVALID_VAULT", "Vault 不存在或不可访问。", { cause: error?.code });
  }
  let parent = realVaultRoot;
  for (const segment of STORE_DIRECTORY.split("/")) {
    const candidate = path.join(parent, segment);
    let details;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(candidate, { mode: 0o700 });
      details = await lstat(candidate);
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      fail("UNSAFE_COACH_PROMPT_DIRECTORY", `${segment} 必须是 Vault 内的真实目录。`);
    }
    const resolved = await realpath(candidate);
    if (!isPathInside(realVaultRoot, resolved) || !isPathInside(parent, resolved)) {
      fail("SYMLINK_ESCAPE", "提示词目录越出了 Vault。");
    }
    parent = resolved;
  }
  const target = path.join(parent, path.posix.basename(COACH_PROMPT_PATH));
  const realTarget = await realpath(target).catch(() => target);
  if (!isPathInside(parent, realTarget)) {
    fail("SYMLINK_ESCAPE", "提示词文件必须是 Vault 内的真实文件。");
  }
  return target;
}

export function createCoachPromptRepository({ vaultRoot = DEFAULT_VAULT_ROOT } = {}) {
  const resolvedRoot = path.resolve(vaultRoot);
  const absoluteStorePath = path.resolve(resolvedRoot, COACH_PROMPT_PATH);
  if (!isPathInside(resolvedRoot, absoluteStorePath)) {
    fail("UNSAFE_COACH_PROMPT", "提示词路径越出了 Vault。");
  }

  // 返回 {prompt, customized}：未配置时给默认模板。
  async function get() {
    try {
      const target = await safeStorePath(resolvedRoot);
      const raw = JSON.parse(await readFile(target, "utf8"));
      if (typeof raw?.prompt === "string" && raw.prompt.trim()) {
        return { prompt: raw.prompt.trim(), customized: true };
      }
    } catch {
      // 文件不存在/损坏 → 默认模板。
    }
    return { prompt: DEFAULT_COACH_PROMPT, customized: false };
  }

  async function save(prompt) {
    const normalized = normalizePrompt(prompt);
    const target = await safeStorePath(resolvedRoot);
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), prompt: normalized }, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, target);
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    return { prompt: normalized, customized: true };
  }

  async function reset() {
    try {
      await unlink(await safeStorePath(resolvedRoot));
    } catch {
      // 文件本就不存在时视为已重置。
    }
    return { prompt: DEFAULT_COACH_PROMPT, customized: false };
  }

  return Object.freeze({ get, save, reset });
}

// 模板变量插值（纯函数，便于测试）。
export function renderCoachPrompt(template, { date, session } = {}) {
  return String(template ?? "")
    .replaceAll("{{date}}", date ?? "")
    .replaceAll("{{session}}", session ?? "");
}
