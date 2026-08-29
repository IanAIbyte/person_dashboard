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
