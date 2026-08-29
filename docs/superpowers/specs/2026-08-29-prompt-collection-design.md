# 提示词收藏（Prompt Collection）设计文档

日期：2026-08-29
状态：已与用户逐节确认，待实施
分支：feature/ZCode-fit-my-situation

## 背景与目标

用户在网上看到好的提示词，希望在工作台里有一个地方记录下来，并沉淀到本地 Obsidian 知识库。

现有 `/prompts` 页面（导航「提示词」）是**只读的公开模板库**（中文 124 条 + 英文 1.2 万条，搜索/复制/AI 优化），不承载个人收藏。本设计新增「我的收藏」，并与公开模板并列在同一页面。

**核心决策（用户已确认）：**

1. **Vault 为唯一数据源**：每条收藏就是 vault 里的一个 markdown 文件；dashboard 与 Obsidian 双向实时生效，无第二数据源。
2. **UI 入口**：现有「提示词」页顶部加 tab：「我的收藏 | 公开模板」，导航不加新项。
3. **v1 能力范围**：新建/编辑/删除 + 搜索/标签筛选。不含 AI 优化结果存入收藏、不含来源跳转/快速收藏入口（后续可加）。
4. **实现方案 A**：新建专用 repository 模块，复刻仓库已有仓模式（coach-prompt / material-reading-state）。不复用 vault-index 通用索引（无标签聚合/排序接口，写入端仍需新写，复杂度更高）。

## 数据与文件格式

**目录**：`<vaultRoot>/10_raw/prompts/`（硬编码，沿用 coach-prompt 的 `10_raw/...` 先例；目录不存在时自动创建，逐段 mkdir + symlink 校验）。

**一条收藏 = 一个 md 文件**：

```markdown
---
title: 代码审查提示词
tags:
  - 代码
  - review
source: https://example.com/post
created: 2026-08-29
updated: 2026-08-29T14:30:00.000Z
---

（正文 = 提示词原文，原样保存，不做任何加工）
```

- **文件名**：`YYYY-MM-DD-<标题slug>.md`（上海时区 `formatShanghaiDate` + `sanitizeFilenamePart`；重名自动追加 `-2`、`-3` 后缀）。
- **ID = vault 内相对 posix 路径**（如 `10_raw/prompts/2026-08-29-代码审查提示词.md`），与库内其它 vault 文档一致。
- **`update()` 不重命名文件**：文件名（日期+slug）只是稳定标识符，展示永远读 frontmatter 的 `title`；编辑不改 ID，Obsidian 双链不断。
- **frontmatter 键即为 Obsidian properties 面板可编辑字段**；source 为空时不写该键。
- **冲突策略**：last-write-wins（本地单人使用，dashboard 编辑整体覆盖文件，不做字段级合并）。
- **隐私边界**：本仓库内置 vault 是公开示例库；用户若通过 `PERSONAL_DASHBOARD_VAULT_ROOT` 指向私人 vault，收藏落到私人 vault，与 coach-prompt 行为一致。

## 服务端模块与 API

**新文件 `Workbench/server/prompt-collection.mjs`**（仿 `coach-prompt.mjs`）：

```
createPromptCollectionRepository({ vaultRoot })
  ├─ list()                 扫目录 + gray-matter 解析 → { items, tags }
  ├─ create(input)          校验 → 唯一文件名 → 原子写 → 返回条目
  ├─ update(id, input)      校验 + 越界检查 → 原子覆盖 → 返回条目
  └─ remove(id)             越界检查 → unlink
```

**行为细节：**

- `list()` 容错：缺 title 用文件名兜底、缺 tags 给空数组；非 `.md` 与点文件跳过；按 `updated` 倒序。手改坏的文件不炸列表。
- 校验上限：title ≤ 200 字；content ≤ 20000 字（同 coach-prompt）；tags ≤ 20 个、每个 ≤ 32 字；source 必须为 http(s) URL 或空。
- 安全：目录逐段 mkdir + realpath symlink 逃逸检查（照抄 coach-prompt `safeStorePath`）；`update/remove` 的 id 做 `isPathInside` 越界校验，防路径穿越。
- 原子写：`.tmp`（`wx` + 0o600）+ `rename`，finally 清理临时文件。
- 错误：`PromptCollectionError(code, message)`，码含 `INVALID_TITLE` / `INVALID_CONTENT` / `INVALID_TAG` / `INVALID_SOURCE` / `PROMPT_NOT_FOUND` / `UNSAFE_PATH` / `INVALID_VAULT`，经既有 `errorStatus`/`errorPayload` 映射 HTTP 状态。

**端点（挂 `vite-plugin-workbench.mjs`，遵循现有约定）：**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/prompts/collection` | 列表 + 标签聚合，直读无缓存 |
| POST | `/api/prompts/collection` | 新建；`assertLocalMutationRequest` + `assertAllowedObjectKeys` |
| PATCH | `/api/prompts/collection?id=<相对路径>` | 更新 |
| DELETE | `/api/prompts/collection?id=<相对路径>` | 删除 |

写操作完成后 `vaultSync.notifyPaths([该文件绝对路径])` → 搜索/星图即时收录（既有流程）；响应当次条目，前端免二次拉取。

## 前端 UI

**`api.js` 新增**：`loadPromptCollection` / `createPromptItem` / `updatePromptItem` / `deletePromptItem`。

**`PromptsLibraryPage` 改造为 tab 容器：**

```
┌──────────────────────────────────────────┐
│ PROMPT LIBRARY · 提示词                    │
│ [ 我的收藏 ] [ 公开模板 ]   ← tab，默认收藏  │
├──────────────────────────────────────────┤
│ 🔍 搜索…        #代码 #写作 #review  ＋新建 │
│ ┌────────────────────────────────────┐  │
│ │ 代码审查提示词   #代码 #review        │  │
│ │   正文预览两行……                     │  │
│ │   展开 → <pre>全文</pre>             │  │
│ │         [复制] [编辑] [删除]          │  │
│ └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

- 收藏面板抽成 `src/components/prompts/PromptCollectionPanel.jsx`（页面已 277 行，避免再膨胀）；公开模板逻辑留在原页面，原样不动。
- 搜索为客户端过滤（标题/正文/标签）；标签 chips 单选 toggle。
- 新建/编辑弹层复用现有 optimizer 弹层风格：标题、正文、标签（逗号分隔输入）、来源 URL（可选）。
- 删除走原生 `confirm()`（与 ReaderWorkspace 一致）；接口错误用 `apiErrorMessage` 展示。
- 样式扩展 `prompts-library.css`，复用现有卡片/弹层类。
- **Obsidian 端改动实时感知**：面板内用 `useVaultSync` 订阅 vault 事件触发重拉；实现时核对 `scopeForPath` 覆盖 `10_raw/prompts`，必要时扩 scope 常量。

## 测试与验证

- **服务端** `tests/prompt-collection.test.mjs`（node:test + 临时 vault fixture，仿 `material-reading-state.test.mjs`）：
  - create → list 往返（frontmatter 字段齐全）
  - update 重写内容且文件名/ID 不变；remove 后 list 不再返回
  - 重名自动加 `-2` 后缀
  - 手改坏文件（缺 frontmatter/空正文）不炸列表，title 回退文件名
  - 路径穿越 id（`../`、绝对路径、越出 prompts 目录）拒绝
  - symlink 逃逸拒绝
- **API 冒烟**：并入同一个 `tests/prompt-collection.test.mjs`，仿 `reader-api.test.mjs` 的 `startFixture` 模式起本地插件实例，覆盖 GET/POST/PATCH/DELETE 各 1 例（含写后 `notifyPaths` 不报错）。
- **前端**：与其他页面一致不加组件测试；用 `/qa`（Playwright）过建/改/删/搜索/标签。
- **验收标准**：全量测试套件通过；dashboard 新建一条 → Obsidian 打开对应 md 可见且 properties 字段正确；Obsidian 改正文 → dashboard 列表自动更新。

## 不做的事（v1 明确排除）

- AI 优化结果一键存入收藏（两个 tab 打通，后续可加）
- 从收藏跳转来源网页、每日热点快速收藏入口
- 多选标签筛选、服务端搜索
- 字段级冲突合并；update 时重命名文件
- 公开模板库的任何改动
