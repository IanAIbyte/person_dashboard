# 暗色主题实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作台新增暗色主题：跟随系统 + 侧栏三态开关，暗色青色点缀/冷蓝黑阶梯，亮色模式像素级不变。

**Architecture:** `data-theme` 属性 + CSS 变量覆盖。`localStorage["theme-pref"]`（light/dark/system，默认 system）经 `resolveTheme` 纯函数解析到 `<html data-theme>`；index.html 内联脚本防白闪；两处 JS 色板常量改为 CSS 变量引用；全站硬编码色清查归 token。

**Tech Stack:** React 18 + Vite 6、纯 CSS 自定义属性、@tabler/icons-react、node:test。

**设计文档:** `docs/superpowers/specs/2026-08-29-dark-theme-design.md`

## Global Constraints

- `:root` 既有声明**一个值都不改**；新 token 只能以追加块方式加入（亮色像素不变）
- 亮色模式验收 = 像素级不变；暗色 AA 对比度：正文文字 ≥ 4.5:1
- 不新增 npm 依赖；不改服务端；测试跑 `node --test`（UI 层用 repo 惯例源码文本断言）
- 提交格式 `<type>: 中文描述`，无 attribution 尾注
- 所有命令在 `Workbench/` 目录下执行（除 git 提交在仓库根）
- 暗色色板定案值（已算对比度）：`--ink-faint: #7a8592`（paper 4.90 / surface 4.58，达 AA）

---

### Task 1: theme.js — resolveTheme 纯函数 + 安全存储

**Files:**
- Create: `Workbench/src/lib/theme.js`
- Test: `Workbench/tests/theme.test.mjs`

**Interfaces:**
- Produces: `THEME_PREF_KEY = "theme-pref"`；`resolveTheme(pref: string, systemDark: boolean) => "light" | "dark"`；`readThemePref(): "light" | "dark" | "system"`；`writeThemePref(pref: string): void`。Task 2 的内联脚本、Task 4 的 hook 都消费这些。

- [ ] **Step 1: 写失败测试**

```js
// Workbench/tests/theme.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme, THEME_PREF_KEY } from "../src/lib/theme.js";

test("resolveTheme: system 跟随 matchMedia 结果", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("resolveTheme: light/dark 直出，非法值兜底 system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("banana", true), "dark"); // 非法 → system → 跟随
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL（ Cannot find module '../src/lib/theme.js'）

- [ ] **Step 3: 最小实现**

```js
// Workbench/src/lib/theme.js
// 主题解析与持久化。解析是纯函数；存储读写做 try/catch 兜底（隐私模式）。
export const THEME_PREF_KEY = "theme-pref";
const THEME_PREFS = new Set(["light", "dark", "system"]);

export function resolveTheme(pref, systemDark) {
  const effective = THEME_PREFS.has(pref) ? pref : "system";
  if (effective === "system") return systemDark ? "dark" : "light";
  return effective;
}

export function readThemePref() {
  try {
    const value = window.localStorage.getItem(THEME_PREF_KEY);
    return THEME_PREFS.has(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function writeThemePref(pref) {
  try {
    window.localStorage.setItem(THEME_PREF_KEY, pref);
  } catch {
    /* 存储不可用：保留本次会话内生效，不落盘 */
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/theme.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add Workbench/src/lib/theme.js Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - resolveTheme 纯函数与安全存储读取"
```

---

### Task 2: index.html 防白闪内联脚本

**Files:**
- Modify: `Workbench/index.html:5-16`（`<head>` 内，`<meta name="theme-color">` 之后）

**Interfaces:**
- Consumes: Task 1 的 `THEME_PREF_KEY`（同一存储键名字符串 `"theme-pref"`，内联脚本无法 import，键名以字面量保持一致）
- Produces: `<html data-theme="light|dark">` 在 CSS 加载前就位

- [ ] **Step 1: 写失败测试（源码文本断言）**

在 `Workbench/tests/theme.test.mjs` 追加：

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("index.html 内联脚本在 CSS 前设 data-theme 且键名一致", () => {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  assert.ok(html.includes('data-theme'), "index.html 应包含 data-theme 引导脚本");
  assert.ok(html.includes('"theme-pref"'), "内联脚本应使用同一存储键");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(/theme-pref/.test(head), "脚本必须位于 </head> 之前（防白闪）");
  assert.ok(!head.includes("src/main.jsx"), "脚本须先于模块加载");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: 新增 case FAIL（index.html 尚无 data-theme）

- [ ] **Step 3: 修改 index.html**

在 `<head>` 内 `<meta name="theme-color" content="#ffffff" />` 之后插入：

```html
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafafa" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f151b" />
    <script>
      // 防白闪：CSS 加载前解析主题（与 src/lib/theme.js 的键名/解析规则保持一致）。
      (function () {
        try {
          var stored = localStorage.getItem("theme-pref");
          var valid = stored === "light" || stored === "dark" || stored === "system";
          var pref = valid ? stored : "system";
          var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          var theme = pref === "system" ? (systemDark ? "dark" : "light") : pref;
          document.documentElement.dataset.theme = theme;
        } catch (e) {
          document.documentElement.dataset.theme = "light";
        }
      })();
    </script>
```

同时把原 `<meta name="theme-color" content="#ffffff" />` 一行**替换**为上面两条带 `media` 的 meta。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/theme.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add Workbench/index.html Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - index.html 内联引导脚本防白闪"
```

---

### Task 3: styles.css — 暗色 token 覆盖块 + 新 token

**Files:**
- Modify: `Workbench/src/styles.css`（`:root` 块之后、首个组件样式之前插入暗色块；文件顶部 token 区追加新 token）

**Interfaces:**
- Produces: `[data-theme="dark"]` 覆盖块；新 token `--on-accent`、`--shimmer-highlight`、`--kg-type-*`（13 个类型）、`--disk-c1..c10`（亮色值定义在追加的 `:root` 追加块，暗色值在 dark 块）。Task 5/6 消费。

- [ ] **Step 1: 写失败测试（源码文本断言）**

在 `Workbench/tests/theme.test.mjs` 追加：

```js
test("styles.css 定义暗色 token 覆盖块与新 token", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  const dark = css.slice(css.indexOf('[data-theme="dark"]'));
  for (const token of ["--paper:", "--surface:", "--surface-sunken:", "--ink:", "--ink-soft:",
    "--ink-faint:", "--line:", "--line-strong:", "--accent:", "--accent-strong:",
    "--accent-soft:", "--accent-wash:", "--accent-glow:", "--ok:", "--warn:", "--danger:",
    "--on-accent:", "--shimmer-highlight:", "--shadow-sm:"]) {
    assert.ok(dark.slice(0, 2000).includes(token), `dark 块缺少 ${token}`);
  }
  assert.ok(dark.slice(0, 2000).includes("color-scheme: dark"), "dark 块应设 color-scheme");
  assert.ok(dark.includes("--kg-type-concept:"), "dark 块应含知识星图类型色");
  assert.ok(dark.includes("--disk-c1:"), "dark 块应含磁盘色板");
  assert.ok(css.includes("--on-accent"), ":root 应定义 --on-accent 亮色值");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: 新增 case FAIL

- [ ] **Step 3: 插入 CSS**

在 `:root { ... }` 块结束后追加新 token（**不改任何既有行**）：

```css
/* 追加 token（暗色主题引入；亮色值 = 现视觉等价物） */
:root {
  --on-accent: #ffffff;        /* accent 实色底上的文字 */
  --shimmer-highlight: #e9e9ec;
  /* 知识星图节点类型色（原 src/lib/graph.js TYPE_META 值） */
  --kg-type-concept: #7c3aed;
  --kg-type-framework: #6d28d9;
  --kg-type-entity: #7c3aed;
  --kg-type-diagnosis: #8b5cf6;
  --kg-type-analysis: #5b21b6;
  --kg-type-comparison: #a78bfa;
  --kg-type-case: #8b5cf6;
  --kg-type-source-summary: #a1a1aa;
  --kg-type-source: #71717a;
  --kg-type-topic: #7c3aed;
  --kg-type-conflict: #4c1d95;
  --kg-type-question: #c4b5fd;
  --kg-type-other: #d4d4d8;
  /* 磁盘环形图分类色板（原 ServicesPage.jsx DIR_COLORS） */
  --disk-c1: #0ea5e9;  --disk-c2: #8b5cf6;  --disk-c3: #f59e0b;
  --disk-c4: #10b981;  --disk-c5: #ec4899;  --disk-c6: #14b8a6;
  --disk-c7: #6366f1;  --disk-c8: #f97316;  --disk-c9: #06b6d4;
  --disk-c10: #a855f7; --disk-c11: #94a3b8;
}
```

然后在 `:root` 块后插入暗色覆盖块：

```css
/* ============================================================
   暗色主题 · 冷蓝黑阶梯 + 青色点缀（参考 AIHOT）
   规则：只覆盖语义 token；组件层零改动。accent-strong/soft
   方向反转——暗色下 strong=提亮(hover)、soft=加深(边框)。
   ============================================================ */
[data-theme="dark"] {
  color-scheme: dark;

  --paper: #0f151b;
  --surface: #151c24;
  --surface-sunken: #0b1117;
  --ink: #e6edf3;
  --ink-soft: #9aa7b4;
  --ink-faint: #7a8592;      /* paper 4.90:1 / surface 4.58:1，达 AA */

  --line: #1f2933;
  --line-strong: #2c3a47;

  --accent: #22d3ee;         /* cyan-400 */
  --accent-strong: #67e8f9;  /* cyan-300，hover 提亮 */
  --accent-soft: #0e7490;    /* cyan-700，边框加深 */
  --accent-wash: rgba(34, 211, 238, 0.10);
  --accent-glow: rgba(34, 211, 238, 0.16);

  --ok: #4ade80;
  --warn: #fbbf24;
  --danger: #f87171;

  --on-accent: #08252b;      /* 青底上的深字 */
  --shimmer-highlight: #1c2630;

  --kg-type-concept: #67e8f9;
  --kg-type-framework: #38bdf8;
  --kg-type-entity: #22d3ee;
  --kg-type-diagnosis: #7dd3fc;
  --kg-type-analysis: #0ea5e9;
  --kg-type-comparison: #a5f3fc;
  --kg-type-case: #2dd4bf;
  --kg-type-source-summary: #9aa7b4;
  --kg-type-source: #7a8592;
  --kg-type-topic: #22d3ee;
  --kg-type-conflict: #f87171;
  --kg-type-question: #bae6fd;
  --kg-type-other: #6b7683;

  --disk-c1: #38bdf8;  --disk-c2: #a78bfa;  --disk-c3: #fbbf24;
  --disk-c4: #34d399;  --disk-c5: #f472b6;  --disk-c6: #2dd4bf;
  --disk-c7: #818cf8;  --disk-c8: #fb923c;  --disk-c9: #22d3ee;
  --disk-c10: #c084fc; --disk-c11: #9aa7b4;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 8px 30px rgba(0, 0, 0, 0.45);
  --shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.5);
  --shadow-accent: 0 12px 34px var(--accent-glow);
}
```

注意 `DIR_SLICE_LIMIT = 10` 但数组有 11 色（第 11 个是"其他"兜底）——token 到 c11。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/theme.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add Workbench/src/styles.css Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - dark token 覆盖块与色板 token(星图/磁盘/on-accent/shimmer)"
```

---

### Task 4: useTheme hook + 侧栏三态开关

**Files:**
- Create: `Workbench/src/hooks/useTheme.js`
- Modify: `Workbench/src/components/AppShell.jsx:214-218`（`sidebar__bottom` 内、`sidebar__sync` 之前插开关）
- Modify: `Workbench/src/styles.css`（追加 `.theme-toggle` 分段控件样式，用既有 token）
- Test: `Workbench/tests/theme.test.mjs`（追加源码断言）

**Interfaces:**
- Consumes: Task 1 的 `resolveTheme/readThemePref/writeThemePref/THEME_PREF_KEY`
- Produces: `useTheme()` → `{ pref: "light"|"dark"|"system", setPref(pref): void, theme: "light"|"dark" }`。AppShell 消费。

- [ ] **Step 1: 写失败测试**

`Workbench/tests/theme.test.mjs` 追加：

```js
test("useTheme hook 存在且写入 dataset + matchMedia 监听", () => {
  const hook = readFileSync(join(process.cwd(), "src/hooks/useTheme.js"), "utf8");
  assert.ok(hook.includes("addEventListener"), "应监听 matchMedia change");
  assert.ok(hook.includes("dataset.theme"), "应写 document.documentElement.dataset.theme");
  assert.ok(hook.includes("resolveTheme"), "应复用 resolveTheme");
});

test("AppShell 渲染三态开关且顺序为 暗/系统/亮", () => {
  const shell = readFileSync(join(process.cwd(), "src/components/AppShell.jsx"), "utf8");
  assert.ok(shell.includes("useTheme"), "AppShell 应消费 useTheme");
  const moon = shell.indexOf("IconMoon");
  const monitor = shell.indexOf("IconDeviceDesktop");
  const sun = shell.indexOf("IconSun");
  assert.ok(moon > -1 && monitor > -1 && sun > -1, "三个图标都要有");
  assert.ok(moon < monitor && monitor < sun, "顺序必须 暗/系统/亮");
  assert.ok(shell.includes("aria-pressed"), "当前态要 aria-pressed");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: 新增 2 case FAIL

- [ ] **Step 3: 实现 useTheme**

```js
// Workbench/src/hooks/useTheme.js
import { useCallback, useEffect, useState } from "react";
import { readThemePref, resolveTheme, writeThemePref } from "../lib/theme.js";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function useTheme() {
  const [pref, setPrefState] = useState(readThemePref);
  const [theme, setTheme] = useState(() => resolveTheme(readThemePref(), media.matches));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onChange = (event) => setTheme(resolveTheme(pref, event.matches));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((next) => {
    setPrefState(next);
    writeThemePref(next);
    setTheme(resolveTheme(next, media.matches));
  }, []);

  return { pref, theme, setPref };
}
```

- [ ] **Step 4: AppShell 接入**

顶部 import 追加（@tabler/icons-react 现有 import 块加三项）：`IconMoon, IconDeviceDesktop, IconSun`；组件内 `const { pref, setPref } = useTheme();`；`sidebar__bottom` 内 `sidebar__sync` 之前插入：

```jsx
<div className="theme-toggle" role="group" aria-label="主题">
  <button type="button" className={`theme-toggle__btn${pref === "dark" ? " theme-toggle__btn--on" : ""}`}
    aria-pressed={pref === "dark"} title="暗色" onClick={() => setPref("dark")}>
    <IconMoon size={15} stroke={1.7} />
  </button>
  <button type="button" className={`theme-toggle__btn${pref === "system" ? " theme-toggle__btn--on" : ""}`}
    aria-pressed={pref === "system"} title="跟随系统" onClick={() => setPref("system")}>
    <IconDeviceDesktop size={15} stroke={1.7} />
  </button>
  <button type="button" className={`theme-toggle__btn${pref === "light" ? " theme-toggle__btn--on" : ""}`}
    aria-pressed={pref === "light"} title="亮色" onClick={() => setPref("light")}>
    <IconSun size={15} stroke={1.7} />
  </button>
</div>
```

样式追加到 styles.css（token 驱动，双主题自动适配）：

```css
.theme-toggle {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--surface-sunken);
}
.theme-toggle__btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 22px;
  border: none;
  border-radius: var(--r-pill);
  background: none;
  color: var(--ink-faint);
  cursor: pointer;
}
.theme-toggle__btn--on {
  background: var(--surface);
  color: var(--accent);
  box-shadow: var(--shadow-sm);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/theme.test.mjs`
Expected: PASS（7 tests）

- [ ] **Step 6: 提交**

```bash
git add Workbench/src/hooks/useTheme.js Workbench/src/components/AppShell.jsx Workbench/src/styles.css Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - useTheme hook 与侧栏三态开关(暗/系统/亮)"
```

---

### Task 5: 图表色板改 CSS 变量引用

**Files:**
- Modify: `Workbench/src/lib/graph.js:3-19`（TYPE_META 的 color 字段）
- Modify: `Workbench/src/pages/ServicesPage.jsx:166-180`（DIR_COLORS）

**Interfaces:**
- Consumes: Task 3 的 `--kg-type-*` 与 `--disk-c1..c11` token
- Produces: `typeColor(type)` 返回 `"var(--kg-type-xxx)"` 字符串；`DIR_COLORS[i]` 返回 `"var(--disk-cN)"`。下游 GraphPage/PortfolioPanel/recharts 不改（SVG/DOM fill 接受 var() 引用）。

- [ ] **Step 1: 写失败测试**

`Workbench/tests/theme.test.mjs` 追加：

```js
test("图表色板走 CSS 变量引用", () => {
  const graph = readFileSync(join(process.cwd(), "src/lib/graph.js"), "utf8");
  assert.ok(graph.includes('color: "var(--kg-type-concept)"'), "concept 色应引用 token");
  assert.ok(!/#7c3aed|#6d28d9|#5b21b6/.test(graph), "不应再有紫色 hex 常量");
  const services = readFileSync(join(process.cwd(), "src/pages/ServicesPage.jsx"), "utf8");
  assert.ok(services.includes("var(--disk-c"), "磁盘色板应引用 token");
  assert.ok(!/#0ea5e9|#8b5cf6/.test(services), "ServicesPage 不应再有DIR_COLORS hex");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: 新增 case FAIL

- [ ] **Step 3: 改 graph.js**

TYPE_META 每项 color 改为 token 引用（13 项全部，注释保留）：

```js
export const TYPE_META = {
  concept: { color: "var(--kg-type-concept)", label: "概念", code: "CPT" },
  framework: { color: "var(--kg-type-framework)", label: "框架", code: "FRM" },
  entity: { color: "var(--kg-type-entity)", label: "实体", code: "ENT" },
  diagnosis: { color: "var(--kg-type-diagnosis)", label: "诊断", code: "DIA" },
  analysis: { color: "var(--kg-type-analysis)", label: "分析", code: "ANA" },
  comparison: { color: "var(--kg-type-comparison)", label: "比较", code: "CMP" },
  case: { color: "var(--kg-type-case)", label: "案例", code: "CAS" },
  "source-summary": { color: "var(--kg-type-source-summary)", label: "来源拆解", code: "SRC" },
  source: { color: "var(--kg-type-source)", label: "来源", code: "SRC" },
  topic: { color: "var(--kg-type-topic)", label: "主题", code: "TOP" },
  conflict: { color: "var(--kg-type-conflict)", label: "冲突", code: "CFL" },
  question: { color: "var(--kg-type-question)", label: "问答", code: "QST" },
  other: { color: "var(--kg-type-other)", label: "其他", code: "ETC" },
};
```

- [ ] **Step 4: 改 ServicesPage.jsx**

```js
// 分类色板（避开 danger 红，目录无好坏语义）：引用 styles.css token，超出循环取用。
const DIR_SLICE_LIMIT = 10;
const DIR_COLORS = Array.from({ length: 11 }, (_, i) => `var(--disk-c${i + 1})`);
```

- [ ] **Step 5: 跑测试确认通过 + 全套回归**

Run: `node --test tests/theme.test.mjs && npm run test`
Expected: theme 8 tests PASS；全套 211+ PASS（build 含在内，验证 recharts/var 引用不炸）

- [ ] **Step 6: 提交**

```bash
git add Workbench/src/lib/graph.js Workbench/src/pages/ServicesPage.jsx Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - 星图与磁盘色板改 token 引用(双主题自适应)"
```

---

### Task 6: 组件 CSS 硬编码清查

**Files:**
- Modify: `Workbench/src/components/watchlist/watchlist.css:452,581,608,677,1166,1806,1848`
- Modify: `Workbench/src/components/reader/reader-explanation.css:151,186,207,234,314,463,569,643,651`
- Modify: `Workbench/src/styles/knowledge-graph.css:34,319,507,569,631,691`
- Modify: `Workbench/src/pages/prompts-library.css:287,349`
- Modify: `Workbench/src/components/douyin/douyin-dashboard.css:118,152`
- Modify: `Workbench/src/components/DotEyes.css:118`
- Modify: `Workbench/src/pages/services.css:298`

**Interfaces:**
- Consumes: Task 3 的 `--on-accent`、`--shimmer-highlight`

- [ ] **Step 1: 写失败测试（残量断言）**

`Workbench/tests/theme.test.mjs` 追加：

```js
test("组件 CSS 不再硬编码亮色专用值", () => {
  const cases = [
    ["src/components/watchlist/watchlist.css"],
    ["src/components/reader/reader-explanation.css"],
    ["src/styles/knowledge-graph.css"],
    ["src/pages/services.css"],
  ];
  for (const [file] of cases) {
    const css = readFileSync(join(process.cwd(), file), "utf8");
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(css), `${file} 仍含 hex 色值`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL（列出仍含 hex 的文件）

- [ ] **Step 3: 逐文件替换（亮色视觉等价）**

处置映射（值语义 → token）：
- `color: #fff`（accent 实色底上的字，7+2+2 处）→ `color: var(--on-accent);`
  watchlist 452/581/608/677/1166/1806/1848、reader 186/314、douyin 118/152
- `background: #fbfbfc / #f7f7f8 / #f5f5f6`（浅灰面）→ `background: var(--surface-sunken);`
  reader 151/207/234/463/569/643/651
- `background: #fff`（纯白面）→ `background: var(--surface);`
  knowledge-graph 34/319/507/631
- `color: #fff`（深色底上的字，kg 569/691）→ `color: var(--on-accent);`
- prompts-library 349 与 services 298 的 `#e9e9ec`（shimmer 高光）→ `var(--shimmer-highlight)`
- DotEyes 118 `background: #24103f`（深紫底，装饰一次性）→ 保留 hex，行尾加注释 `/* 主题无关装饰色 */`；DotEyes 53 的 `#000` 是 mask 不改
- prompts-library 287 `color: #fff`（accent 底）→ `color: var(--on-accent);`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/theme.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add Workbench/src/components/watchlist/watchlist.css Workbench/src/components/reader/reader-explanation.css Workbench/src/styles/knowledge-graph.css Workbench/src/pages/prompts-library.css Workbench/src/components/douyin/douyin-dashboard.css Workbench/src/components/DotEyes.css Workbench/src/pages/services.css Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - 组件CSS硬编码色归 token(on-accent/shimmer/surface)"
```

---

### Task 7: styles.css 本体清查

**Files:**
- Modify: `Workbench/src/styles.css`（:root 块外的 hex/rgba，行号清单见 Step 3）

**Interfaces:**
- Consumes: 既有语义 token + Task 3 新 token

- [ ] **Step 1: 写失败测试（残量断言，:root 与暗色块豁免）**

`Workbench/tests/theme.test.mjs` 追加：

```js
test("styles.css 组件区不再硬编码主题相关 hex", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  // 组件样式位于暗色块之后（:root 原/追加块与 dark 块都豁免）。
  const darkStart = css.indexOf('[data-theme="dark"]');
  const darkEnd = css.indexOf("\n}", darkStart);
  const componentArea = css.slice(darkEnd + 2);
  const offenders = componentArea
    .split("\n")
    .map((line) => (/#(?:[0-9a-fA-F]{6})\b/.test(line) ? line.trim() : null))
    .filter(Boolean)
    .filter((line) => !line.includes("/* 主题无关装饰色 */"));
  assert.deepEqual(offenders, [], `组件区仍有 hex: ${offenders.slice(0, 5)}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL（列出组件区 hex 残量）

- [ ] **Step 3: 按清单替换（亮色等价映射）**

处置映射（33 处，语义 → token）：
- `background: #fff / #fbfbfc / #f8f8f9 / #f8f8fa / #f1f1f3 / #fcfbff`（各类浅面）→ `var(--surface)` 或更浅语义不明显时 `var(--surface)`（fbfbfc/f8f8fa/f1f1f3/fcfbff 视觉差 < 2%，统一归 surface 视觉等价）
  行号：3737/3812/3833/3850/4022/4080/4089/4147/4183/4463/4529/6289
- `color: #27272a / #3f3f46 / #40364f`（深字）→ `var(--ink)`
  行号：2846/3038/3797
- `color: #fff`（accent/danger 实色底上的字，630/1384/2965/3417/4055/4404/4637/5448/5682/6399）→ `var(--on-accent)`
- `background: #57a773`（813，一次性好牌绿）→ `var(--ok)`
- `border: 1px solid #211a2f; background: #18141f`（3395/3397，本来就是深色装饰块）→ 保留，行尾加 `/* 主题无关装饰色 */`（测试豁免该标记）
- `#eeedf1`（2220 shimmer）→ `var(--shimmer-highlight)`
- `mask-image` 里的 `#000`（608/609）不动（遮罩非颜色语义）

- [ ] **Step 4: rgba 审计**

Run: `grep -n "rgba(" Workbench/src/styles.css | grep -v "var(--" | grep -v ":root" | grep -v 'data-theme'`
逐条判断：阴影/辉光类 rgba(10,10,10,*) 与 rgba(124,58,237,*) 若已在 :root token（--shadow-*/--accent-glow）定义则该处已是 `var()` 引用（grep 已排除）；散落在 gradient/motif 里的 rgba 属装饰层，暗色下检查可见性，刺眼的就地加暗色覆盖或改引用 `--accent-glow`。此项无测试断言（装饰层），QA 走查兜底。

- [ ] **Step 5: 跑测试确认通过 + 全套回归**

Run: `node --test tests/theme.test.mjs && npm run test`
Expected: theme 10 tests PASS；全套 PASS

- [ ] **Step 6: 提交**

```bash
git add Workbench/src/styles.css Workbench/tests/theme.test.mjs
git commit -m "feat: 暗色主题 - styles.css 组件区硬编码色归 token"
```

---

### Task 8: 对比度验证 + 双主题 QA 走查

**Files:**
- Create: `Workbench/scripts/theme-contrast.mjs`
- Test: `Workbench/tests/theme.test.mjs`（追加色板对比度断言）

- [ ] **Step 1: 写失败测试（对比度数值断言）**

`Workbench/tests/theme.test.mjs` 追加：

```js
import { relativeLuminance, contrastRatio } from "../scripts/theme-contrast.mjs";

test("暗色色板对比度达 AA", () => {
  assert.ok(contrastRatio("#e6edf3", "#0f151b") >= 4.5);
  assert.ok(contrastRatio("#9aa7b4", "#0f151b") >= 4.5);
  assert.ok(contrastRatio("#7a8592", "#0f151b") >= 4.5);
  assert.ok(contrastRatio("#7a8592", "#151c24") >= 4.5);
  assert.ok(contrastRatio("#22d3ee", "#0f151b") >= 4.5);
  assert.ok(contrastRatio("#08252b", "#22d3ee") >= 4.5);
  assert.ok(contrastRatio("#f87171", "#0f151b") >= 4.5);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/theme.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现对比度脚本**

```js
// Workbench/scripts/theme-contrast.mjs
// WCAG 2.x 相对亮度与对比度。既供测试 import，也可 node 直接跑打印全表。
export function relativeLuminance(hex) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground, background) {
  const [a, b] = [relativeLuminance(foreground), relativeLuminance(background)];
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

if (process.argv[1]?.endsWith("theme-contrast.mjs")) {
  const pairs = [
    ["ink/paper", "#e6edf3", "#0f151b"], ["ink-soft/paper", "#9aa7b4", "#0f151b"],
    ["ink-faint/paper", "#7a8592", "#0f151b"], ["ink-faint/surface", "#7a8592", "#151c24"],
    ["accent/paper", "#22d3ee", "#0f151b"], ["on-accent/accent", "#08252b", "#22d3ee"],
    ["danger/paper", "#f87171", "#0f151b"], ["ok/paper", "#4ade80", "#0f151b"],
    ["warn/paper", "#fbbf24", "#0f151b"],
  ];
  for (const [name, fg, bg] of pairs) {
    console.log(`${name.padEnd(20)} ${contrastRatio(fg, bg).toFixed(2)}:1`);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/theme-contrast.mjs && node --test tests/theme.test.mjs`
Expected: 全表 ≥ 4.5:1；theme 11 tests PASS

- [ ] **Step 5: 双主题 QA 走查（dev server 实测）**

dev server 已在 http://localhost:5173 运行。用浏览器逐页走查（每页两主题各一次）：
`/`（总览）、`/graph`（星图：13 种节点色两套色板）、`/stocks`（复盘：K线/持仓/环形）、`/services`（磁盘环形图 11 色板）、`/prompts`（收藏/模板/表单弹层）、`/career`、`/daily-hot`、`/books`。
每页检查：无白色残留块、无刺眼饱和色、开关三态可用、system 态改 macOS 外观实时跟随、刷新无白闪。
发现问题就地在对应 CSS 归 token 或暗色块覆盖，重跑 `node --test tests/theme.test.mjs && npm run test` 后再走查。

- [ ] **Step 6: 提交 + 推送**

```bash
git add Workbench/scripts/theme-contrast.mjs Workbench/tests/theme.test.mjs
git commit -m "test: 暗色主题 - WCAG 对比度脚本与色板断言"
git push -u origin feature/dark-theme
```
