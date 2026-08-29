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
