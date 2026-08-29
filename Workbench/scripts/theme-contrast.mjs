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
