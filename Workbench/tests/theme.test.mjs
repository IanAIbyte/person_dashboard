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
