# 暗色主题设计文档

**日期**: 2026-08-29
**分支**: `feature/dark-theme`（基于 main `dd44579`）
**状态**: 设计已确认，待实施

## 背景与目标

工作台当前只有亮色主题（styles.css `:root`，`color-scheme: light` 写死），无任何暗色基础设施。目标：为全站新增暗色主题。视觉参考 AIHOT（aihot.virxact.com/daily）的暗色气质：冷蓝黑阶梯 + 青色点缀；亮色模式保持现有紫色品牌**像素级不变**。

## 已确认决策

| 决策点 | 结论 |
|---|---|
| 触发方式 | 跟随系统（默认）+ 侧栏三态开关（暗/系统/亮），选择持久化 localStorage |
| 暗色点缀色 | 青色；亮色保持紫色（「暗青亮紫」） |
| 实现机制 | `data-theme` 属性 + CSS 变量覆盖块（方案 A） |
| 切换控件 | 侧栏底部三态分段控件，顺序 暗/系统/亮（与参考站一致） |
| 亮色模式 | `:root` 块零改动，像素级不变 |

## 主题机制

### 状态与数据流

```
localStorage["theme-pref"] = "light" | "dark" | "system"（默认 system）
        ↓ resolveTheme(pref, systemPrefersDark) 纯函数
<html data-theme="dark|light"> + color-scheme 同步
```

- **防白闪**：index.html `<head>` 内联脚本在 CSS 加载前读 localStorage + matchMedia，直接设 `data-theme`
- **useTheme hook**：读写偏好；system 态下 `matchMedia('(prefers-color-scheme: dark)')` 监听变化实时跟随；`document.documentElement.dataset.theme` 副作用集中在此
- **兜底**：localStorage 抛异常（隐私模式/禁用）→ try/catch 回退 system 态，不落盘
- **非法值**：localStorage 非法值 → 视同 `system`，下次写入时修正

### accent 方向反转（关键语义）

亮色：`--accent-strong` = 加深（hover 压暗）、`--accent-soft` = 变浅（边框）。暗色下方向对调：`--accent-strong` = 提亮（hover 语义不变）、`--accent-soft` = 加深（边框语义不变）。组件按语义名引用，值按主题供给，组件代码零改动。

### --on-accent（新 token）

accent 实色底上的文字/图标色。亮 `#ffffff`，暗 `#08252b`（深青黑）。
清查时把 accent 底上的 `color: #fff`（watchlist.css 7 处等）改为 `var(--on-accent)`。

## 暗色 token 色板

值来自参考站取样 + 对比度校验，实施时微调：

```css
[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0f151b;          /* 页面底（取样） */
  --surface: #151c24;        /* 卡片面 */
  --surface-sunken: #0b1117; /* 下沉面/侧栏（取样） */
  --ink: #e6edf3;
  --ink-soft: #9aa7b4;
  --ink-faint: #6b7683;      /* 实施时验证 ≥ 4.5:1，不达标提亮 */
  --line: #1f2933;
  --line-strong: #2c3a47;

  --accent: #22d3ee;         /* cyan-400 */
  --accent-strong: #67e8f9;  /* cyan-300 */
  --accent-soft: #0e7490;  /* cyan-700 */
  --accent-wash: rgba(34, 211, 238, 0.10);
  --accent-glow: rgba(34, 211, 238, 0.16);

  --ok: #4ade80;             /* 提亮一档 */
  --warn: #fbbf24;
  --danger: #f87171;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-md: 0 8px 30px rgba(0, 0, 0, 0.45);
  --shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.5);
}
```

**对比度验收**：`--ink-faint` 对 `--paper` ≥ 4.5:1（AA）；全站浅色文字对深底 ≥ 4.5:1（大字号 ≥ 3:1）。

## 图表色板量化

两处 JS hex 常量改为 CSS 变量引用（渲染层是 DOM/SVG，接受 var() 引用字符串）：

1. **知识星图**：`src/lib/graph.js` 8 个节点类型色（紫色系 hex 常量）→ CSS token `--kg-type-*`（亮紫阶/暗青蓝阶两套），`typeColor()` 改返回 `var(--kg-type-concept)` 这类引用字符串
2. **磁盘环形图**：ServicesPage.jsx DIR_COLORS 10 色板 → `var(--disk-c1..c10)`；亮色套=现有 10 色原值，暗色套=同色相提亮降饱和
3. 涨跌/状态色已走 `--danger/--ok` token，自动适配零改动

## 硬编码清查清单

原则：优先归现有 token（保证亮色视觉不变）；无语义一次性色进暗色块就近覆盖；语义就是纯白的 `#fff` 注明保留。

| 位置 | 数量 | 处理 |
|---|---|---|
| styles.css 非token hex/rgba | ~30+30 | 能归 token 归 token；无语义一次性色就近覆盖 |
| watchlist.css `color:#fff` 7 处 | 7 | → var(--on-accent) |
| 组件 CSS 散布 hex（reader 9 / kg 6 / prompts 2 / douyin 2 / DotEyes 2 / services 1） | 22 | 归 token 或暗色就近覆盖 |
| graph.js + ServicesPage 色板 | 18 | → CSS token（见上节） |
| shimmer #e9e9ec 2 处 | 2 | 新 token `--shimmer-highlight`（亮 #e9e9ec / 暗 #1c2630） |

## 开关 UI

侧栏底部（「文件已实时同步」区块上方），三态分段控件：Moon/Monitor/Sun 图标（lucide），顺序 暗/系统/亮，`aria-pressed` 标注当前态。无文字标签。样式复用 segmented-control 样式语言。

## 测试与验收

- **单测**：`resolveTheme(pref, systemDark)` 纯函数 node:test（system→matchMedia、light/dark 直出、非法值兜底）；UI 层按 repo 惯例源码文本断言
- **对比度**：脚本验证 ink-faint 对 paper ≥ 4.5:1（AA）
- **QA**：/qa 浏览器过总览/星图/复盘/服务/提示词，两主题截图对比

## 验收标准（5 条）

1. 亮色模式像素级不变（:root 零改动）
2. 暗色全页无白色/刺眼残留
3. head 内联脚本防白闪生效
4. system 态实时跟随系统切换
5. 对比度 AA 达标

## Out of scope

- 亮色模式任何视觉调整
- 切换动效（全站 transition）
- 服务端改动（纯前端特性）
- 上一分支的 P1-P3 后续项
