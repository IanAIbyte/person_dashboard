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

const CAREER_ID_PREFIX = "career:";

// 精确允许的入口文件（相对 CAREER_VAULT_ROOT）。
const EXACT_FILES = new Set([
  "02_Areas/职业规划/面试研究地图.md",
  "01_Projects/求职2026.md",
  "02_Areas/职业规划/题库/题库-大数据开发.md",
  "02_Areas/职业规划/题库/题库-数据仓库与建模.md",
  "02_Areas/职业规划/题库/题库-面试鸭-大数据.md",
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

// 单文档读取，供 /api/documents/:id 的 career fallback 使用。
// 返回原始内容 + frontmatter，由调用方构造成 DocumentDrawer 兼容 shape。
export async function readCareerDocument(root, relativePath) {
  if (!root || !isAllowedCareerPath(relativePath)) return null;
  const { content, frontmatter } = await readMetadata(root, relativePath);
  if (!content) return null;
  const title =
    frontmatter?.title ||
    relativePath.split("/").pop()?.replace(/\.md$/, "") ||
    "未命名";
  return {
    id: `${CAREER_ID_PREFIX}${relativePath}`,
    relativePath,
    title,
    content,
    frontmatter,
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
