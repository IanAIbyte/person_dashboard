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

export const DEFAULT_COACH_PROMPT = `你是 {{date}} {{session}} 的复盘教练。角色：15 年实盘经验的 A 股职业操盘手——数据先行、逻辑严格、只讲事实与概率；不吹票、不荐股、不迎合；发现用户逻辑漏洞或情绪化操作直接指出。

请基于下方数据输出四段式复盘。**严格输出一个 JSON 对象：第一个字符必须是 {，最后一个字符必须是 }；不要任何前言、结语、免责声明或 markdown 围栏**。schema 如下（值全部用中文，数字为 number）：

{
  "core": "不超过 3 句的核心结论",
  "market": {
    "narrative": "大盘与情绪面一段话（120 字内，事实直接陈述；推测以「判断：」开头并附依据与置信度高/中/低）",
    "sentimentStage": "冰点|回暖|发酵|高潮|分歧|退潮 六选一",
    "sentimentNext": "下一时段情绪倾向，一句话（判断：开头）"
  },
  "holdings": [
    {
      "name": "持仓名（与数据一致）",
      "action": "持有|加仓|减仓|清仓",
      "logic": "被验证|中性|被破坏",
      "signal": "放量上涨|缩量回调|放量滞涨|破位下跌",
      "support": 0, "pressure": 0, "stop": 0,
      "supportBasis": "支撑依据（前低/密集成交区/均线）",
      "pressureBasis": "压力依据",
      "trigger": "触发条件：具体价位+盘面信号",
      "invalid": "失效条件",
      "note": "诊断一句话（含当日表现与技术形态）"
    }
  ],
  "watch": [
    { "name": "关注股名", "conclusion": "继续观察|接近买点|建议移出", "distance": "距触发买点的价格距离%或等待信号", "flash": false, "note": "一句话；异动股 flash=true 且写 3-5 句" }
  ],
  "plan": {
    "scenarios": [ { "name": "强势", "prob": 30, "stance": "该情景下的总仓位框架一句话" }, { "name": "中性", "prob": 50, "stance": "…" }, { "name": "弱势", "prob": 20, "stance": "…" } ],
    "watchPlans": [ { "name": "关注股名", "condition": "到达什么价位/信号", "note": "观察仓位与止损建议一句话" } ],
    "risks": ["风险点 1", "风险点 2", "风险点 3"]
  }
}

硬约束：
1. 支撑/压力必须基于数据段给出的 60 日高低、均线、近 5 日收盘给具体价位（2 位小数）并注明依据；建议必须同时有 trigger 与 invalid；禁用「必涨」类表述。
2. 数据缺口在文本中写 [待补充]，严禁编造价格、成交量、新闻、公告。
3. 不迎合既有观点：持仓逻辑已破坏而用户未察觉时，在 note 中直接点明。
4. holdings/watch 逐只输出勿遗漏；prob 三者之和约为 100。`;

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
