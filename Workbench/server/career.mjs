import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

// 求职备战数据源：只读外部 Obsidian 知识库的「职业规划」部分。
// 本模块绕开主 vault index，直接按「白名单」遍历 CAREER_VAULT_ROOT，
// 因此素材层/书架/wiki/抖音等模块完全不受影响。
//
// 隐私红线：walker 只走下方列出的精确文件与目录前缀，且只读 .md；
// `简历/` 目录、一切非 md 文件、以及目录名/文件名含「简历」的路径一律不进入。
// 本模块绝不写文件。

const CAREER_ID_PREFIX = "career-";

// career 文档 id 采用 `career-<base64url(相对路径)>`，与主 vault 的 encodeId
// 同法：既符合笔记存储的 `[A-Za-z0-9_-]+` 约束，又能可靠区分外部文档。
function encodeCareerId(relativePath) {
  return `${CAREER_ID_PREFIX}${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

// 从 career 文档 id 反解出相对路径；非 career id 或非法编码返回 null。
export function careerRelativePathFromId(id) {
  if (typeof id !== "string" || !id.startsWith(CAREER_ID_PREFIX)) return null;
  const encoded = id.slice(CAREER_ID_PREFIX.length);
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

// 精确允许的入口文件（相对 CAREER_VAULT_ROOT）。
// 含空占位文件（待编译的题库方向），点击打开「暂无内容」占位说明。
const EXACT_FILES = new Set([
  "02_Areas/职业规划/面试研究地图.md",
  "01_Projects/求职2026.md",
  "02_Areas/职业规划/题库/题库-大数据开发.md",
  "02_Areas/职业规划/题库/题库-数据仓库与建模.md",
  "02_Areas/职业规划/题库/题库-面试鸭-大数据.md",
  "知识库迭代机制.md",
  "02_Areas/职业规划/Prompts/面试准备提示词.md",
  "题库-云平台与迁移.md",
  "题库-AI Agent开发.md",
]);

// 允许遍历的目录前缀。
const RAW_QUESTION_DIR = "02_Areas/职业规划/题库/来源/面试鸭/";
const CONCEPT_DIR = "02_Areas/职业规划/概念/";

// 自编题库 → 方向（这些文件的 frontmatter.tags 已含方向，但此处显式兜底）。
const CURATED_DIRECTION = {
  "题库-大数据开发.md": "大数据开发",
  "题库-数据仓库与建模.md": "数仓建模",
};

// 面试鸭 raw 题目没有方向标签，靠文件名中的主题词（Spark/Hive/Kafka/Flink/SQL）
// 推断。这些主题全部来自面试鸭「大数据开发」分类（台账 `题库-面试鸭-大数据.md`
// 即「方向 1 大数据开发」），故统一归入「大数据开发」。
const RAW_TOPIC_KEYWORDS = ["Spark", "Hive", "Kafka", "Flink", "SQL"];

const DIRECTION_TAGS = [
  "大数据开发",
  "数仓建模",
  "AI Agent",
  "云平台",
];

function normalizeRelPath(relativePath) {
  const rel = String(relativePath || "").replaceAll("\\", "/");
  if (!rel || rel.includes("..") || !rel.endsWith(".md")) return null;
  return rel;
}

// 隐私双防线之一：只允许白名单内的相对路径（防目录穿越 + 防简历泄漏）。
export function isAllowedCareerPath(relativePath) {
  const rel = normalizeRelPath(relativePath);
  if (!rel) return false;
  if (rel.includes("简历")) return false;
  if (EXACT_FILES.has(rel)) return true;
  for (const dir of [RAW_QUESTION_DIR, CONCEPT_DIR]) {
    if (rel.startsWith(dir)) {
      const base = rel.slice(dir.length).split("/").pop() || "";
      if (base.startsWith("_")) return false; // 排除 _模板/_说明 等辅助文件
      return true;
    }
  }
  return false;
}

// 从 frontmatter.tags（概念页有方向标签）或文件名主题词（raw 题目）推断方向。
function inferDirection(frontmatter, relativePath, fileName) {
  const tags = Array.isArray(frontmatter?.tags) ? frontmatter.tags : [];
  for (const tag of tags) {
    const hit = DIRECTION_TAGS.find((d) => String(tag).includes(d));
    if (hit) return hit;
  }
  const explicit = CURATED_DIRECTION[fileName];
  if (explicit) return explicit;
  for (const keyword of RAW_TOPIC_KEYWORDS) {
    if (fileName.includes(keyword)) return "大数据开发";
  }
  return "未分类";
}

function extractQuestionCount(content) {
  // 自编题库用 `### Q1...` 编号；计数 `### Q` 开头的标题行。
  const matches = String(content || "").match(/^###\s+Q\d+/gm);
  return matches ? matches.length : null;
}

function excerptOf(content, length = 160) {
  const body = String(content || "")
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "")
    .replace(/^#+\s+.*$/gm, "")
    .replace(/^\s*>\s+.*$/gm, "")
    .trim();
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.slice(0, length) || null;
}

async function listMdFiles(root, relativeDir) {
  const dir = path.join(root, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_"))
    .map((e) => path.posix.join(relativeDir, e.name));
}

async function readMetadata(root, relativePath) {
  const content = await readFile(path.join(root, relativePath), "utf8");
  const parsed = matter(content);
  const frontmatter = parsed.data ?? {};
  return { content, frontmatter };
}

async function statOptional(root, relativePath) {
  return stat(path.join(root, relativePath)).catch(() => null);
}

// 解析正文中的 Obsidian 双链 [[target|label#heading]]，字段结构与主 vault 的
// parseWikiLinks 对齐（target/label/heading/embedded/resolvedId）。
function parseWikiLinks(body) {
  const links = [];
  const pattern = /(!?)\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = pattern.exec(body)) !== null) {
    const raw = match[2].trim();
    const pipeIndex = raw.indexOf("|");
    const targetWithAnchor = pipeIndex >= 0 ? raw.slice(0, pipeIndex).trim() : raw;
    const label = pipeIndex >= 0 ? raw.slice(pipeIndex + 1).trim() : null;
    const [target, heading = null] = targetWithAnchor.split("#", 2);
    if (!target.trim()) continue;

    links.push({
      target: target.trim(),
      label: label || null,
      heading: heading || null,
      embedded: match[1] === "!",
      resolvedId: null,
    });
  }

  return links;
}

function parseHeadings(body) {
  const headings = [];
  for (const line of String(body || "").split("\n")) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    headings.push({ level: match[1].length, title: match[2].trim() });
  }
  return headings;
}

// 建立白名单内所有文件的 basename → 相对路径 + 大小 索引，用于双链按短名解析。
async function buildCareerLinkIndex(root) {
  const files = new Set([...EXACT_FILES]);
  for (const rel of await listMdFiles(root, RAW_QUESTION_DIR)) files.add(rel);
  for (const rel of await listMdFiles(root, CONCEPT_DIR)) files.add(rel);

  const rels = [...files];
  const stats = await Promise.all(rels.map((rel) => statOptional(root, rel)));
  const basenames = new Map();

  rels.forEach((rel, index) => {
    const base = rel.split("/").pop()?.replace(/\.md$/, "") || "";
    if (!base) return;
    const size = stats[index]?.size ?? 0;
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base).push({ relativePath: rel, size });
  });

  return basenames;
}

// 把白名单内的双链目标解析为 career: 前缀的 resolvedId。
// 优先级：相对当前文档目录的精确路径 → 根相对精确路径 → basename 唯一匹配；
// 空文件（0 字节占位）一律跳过。
async function resolveCareerWikiLinks(root, relativePath, wikiLinks, index) {
  const sourceDirectory = path.posix.dirname(relativePath);

  for (const link of wikiLinks) {
    const rawTarget = link.target
      .replace(/^\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
    const candidates = [
      path.posix.normalize(path.posix.join(sourceDirectory, rawTarget)),
      path.posix.normalize(rawTarget),
    ];

    let resolved = null;
    for (const candidate of candidates) {
      const exact = isAllowedCareerPath(`${candidate}.md`) ? `${candidate}.md`
        : isAllowedCareerPath(candidate) ? candidate
          : null;
      if (!exact) continue;
      // 精确命中即解析（含空占位文件）；「空占位 vs 真实文件」的歧义由
      // 下方 basename 匹配的 size 过滤兜底。
      resolved = exact;
      break;
    }

    if (!resolved && !rawTarget.includes("/")) {
      const matches = (index.get(rawTarget) || []).filter((item) => item.size > 0);
      if (matches.length === 1) resolved = matches[0].relativePath;
    }

    if (resolved) link.resolvedId = encodeCareerId(resolved);
  }

  return wikiLinks;
}

// 单文档读取，供 /api/documents/:id 的 career fallback 使用。
// 返回原始内容 + frontmatter + 解析后的 headings/wikiLinks，由调用方构造成
// DocumentDrawer 兼容 shape。
export async function readCareerDocument(root, relativePath) {
  if (!root || !isAllowedCareerPath(relativePath)) return null;
  const { content, frontmatter } = await readMetadata(root, relativePath);
  const title =
    frontmatter?.title ||
    relativePath.split("/").pop()?.replace(/\.md$/, "") ||
    "未命名";

  // 空占位文件（如待编译的题库方向）：返回占位文档，避免点击 404。
  if (!content) {
    return {
      id: encodeCareerId(relativePath),
      relativePath,
      title,
      content: "",
      body: `> 该文档暂无内容。\n\n「${title}」尚未编译（待生成）。`,
      frontmatter,
      headings: [],
      wikiLinks: [],
      status: frontmatter?.status || "active",
      type: frontmatter?.type || "note",
      updatedAt: frontmatter?.updated || frontmatter?.created || null,
      layer: "career",
      kind: "career",
      contentType: "markdown",
    };
  }

  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  const wikiLinks = await resolveCareerWikiLinks(
    root,
    relativePath,
    parseWikiLinks(body),
    await buildCareerLinkIndex(root),
  );
  return {
    id: encodeCareerId(relativePath),
    relativePath,
    title,
    content,
    body,
    frontmatter,
    headings: parseHeadings(body),
    wikiLinks,
    status: frontmatter?.status || "active",
    type: frontmatter?.type || "note",
    updatedAt: frontmatter?.updated || frontmatter?.created || null,
    layer: "career",
    kind: "career",
    contentType: "markdown",
  };
}

// 主 payload：主报告 MOC + 战役页 + 题库（自编 + raw）+ 概念。
// coverage.roles/matrix 恒为 false（Obsidian 目前无岗位/差距数据），驱动前端占位区。
export async function careerPayload(root) {
  if (!root) {
    return {
      generatedAt: new Date().toISOString(),
      available: false,
      report: null,
      campaign: null,
      questionBanks: { curated: [], raw: [] },
      concepts: [],
      coverage: { roles: false, matrix: false },
      placeholderHints: {
        roles: "待运行岗位扫描（见「面试准备提示词」第一步）",
        matrix: "待运行技能差距分析（见「面试准备提示词」第二步）",
      },
    };
  }

  const reportRel = "02_Areas/职业规划/面试研究地图.md";
  const campaignRel = "01_Projects/求职2026.md";

  const [reportMeta, campaignMeta, curated, raw, concepts] = await Promise.all([
    readCareerDocument(root, reportRel),
    readCareerDocument(root, campaignRel),
    (async () => {
      const items = [];
      for (const file of Object.keys(CURATED_DIRECTION)) {
        const rel = `02_Areas/职业规划/题库/${file}`;
        const doc = await readCareerDocument(root, rel);
        if (!doc) continue;
        const st = await statOptional(root, rel);
        items.push({
          id: doc.id,
          title: doc.title,
          direction: CURATED_DIRECTION[file],
          questionCount: extractQuestionCount(doc.content),
          kind: file.includes("面试鸭") ? "ledger" : "answer-bank",
          updated: doc.updatedAt || (st ? st.mtime.toISOString().slice(0, 10) : null),
        });
      }
      return items;
    })(),
    (async () => {
      const files = await listMdFiles(root, RAW_QUESTION_DIR);
      const items = [];
      for (const rel of files) {
        const doc = await readCareerDocument(root, rel);
        if (!doc) continue;
        const fileName = rel.split("/").pop();
        items.push({
          id: doc.id,
          title: doc.title,
          direction: inferDirection(doc.frontmatter, rel, fileName),
          sourceUrl: doc.frontmatter?.source_url || null,
          updated: doc.updatedAt,
        });
      }
      return items;
    })(),
    (async () => {
      const files = await listMdFiles(root, CONCEPT_DIR);
      const items = [];
      for (const rel of files) {
        const doc = await readCareerDocument(root, rel);
        if (!doc) continue;
        const fileName = rel.split("/").pop();
        items.push({
          id: doc.id,
          title: doc.title,
          direction: inferDirection(doc.frontmatter, rel, fileName),
          excerpt: excerptOf(doc.content),
          updated: doc.updatedAt,
        });
      }
      return items;
    })(),
  ]);

  const report =
    reportMeta == null
      ? null
      : {
          id: reportMeta.id,
          title: reportMeta.title,
          updated: reportMeta.updatedAt,
        };
  const campaign =
    campaignMeta == null
      ? null
      : {
          id: campaignMeta.id,
          title: campaignMeta.title,
          updated: campaignMeta.updatedAt,
        };

  const available = report != null || campaign != null || curated.length > 0;

  return {
    generatedAt: new Date().toISOString(),
    available,
    report,
    campaign,
    questionBanks: { curated, raw },
    concepts,
    coverage: { roles: false, matrix: false },
    placeholderHints: {
      roles: "待运行岗位扫描（见「面试准备提示词」第一步）",
      matrix: "待运行技能差距分析（见「面试准备提示词」第二步）",
    },
  };
}
