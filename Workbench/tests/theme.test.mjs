// Workbench/tests/theme.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme, THEME_PREF_KEY } from "../src/lib/theme.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("resolveTheme: system 跟随 matchMedia 结果", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("resolveTheme: light/dark 直出，非法值兜底 system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("banana", true), "dark"); // 非法 → system → 跟随
});

test("index.html 内联脚本在 CSS 前设 data-theme 且键名一致", () => {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  assert.ok(html.includes('data-theme'), "index.html 应包含 data-theme 引导脚本");
  assert.ok(html.includes('"theme-pref"'), "内联脚本应使用同一存储键");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.ok(/theme-pref/.test(head), "脚本必须位于 </head> 之前（防白闪）");
  assert.ok(!head.includes("src/main.jsx"), "脚本须先于模块加载");
});

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

test("图表色板走 CSS 变量引用", () => {
  const graph = readFileSync(join(process.cwd(), "src/lib/graph.js"), "utf8");
  assert.ok(graph.includes('color: "var(--kg-type-concept)"'), "concept 色应引用 token");
  assert.ok(!/#7c3aed|#6d28d9|#5b21b6/.test(graph), "不应再有紫色 hex 常量");
  const services = readFileSync(join(process.cwd(), "src/pages/ServicesPage.jsx"), "utf8");
  assert.ok(services.includes("var(--disk-c"), "磁盘色板应引用 token");
  assert.ok(!/#0ea5e9|#8b5cf6/.test(services), "ServicesPage 不应再有DIR_COLORS hex");
});

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

test("canvas 渲染器用 resolveTypeColor 解析主题色", () => {
  const renderer = readFileSync(join(process.cwd(), "src/graph/graph-renderer.js"), "utf8");
  assert.ok(renderer.includes("resolveTypeColor"), "canvas fillStyle 必须经 resolveTypeColor 解析");
  assert.ok(!renderer.includes("typeColor("), "canvas 内不得直接用 typeColor(var() 字符串)");
  const graph = readFileSync(join(process.cwd(), "src/lib/graph.js"), "utf8");
  assert.ok(graph.includes("export function resolveTypeColor"), "graph.js 应导出 resolveTypeColor");
});
