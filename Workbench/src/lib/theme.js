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
