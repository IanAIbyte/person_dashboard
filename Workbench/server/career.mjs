import matter from "gray-matter";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { getDocument } from "./vault-index.mjs";

// mdast 解析 helper，范式沿用 social-insights.mjs，保持模块独立。

function textOf(node) {
  return toString(node).replace(/\s+/g, " ").trim();
}

function sectionMap(tree) {
  const sections = new Map();
  let active = null;
  for (const node of tree.children ?? []) {
    if (node.type === "heading" && node.depth === 2) {
      active = { title: textOf(node), nodes: [] };
      sections.set(active.title, active);
      continue;
    }
    if (active) active.nodes.push(node);
  }
  return sections;
}

// 在某个 H2 section 内部按更深一层标题（如 H3）再分组，用于拆「方向 A / 方向 B」。
function subSectionMap(section, depth) {
  const sub = new Map();
  let active = null;
  for (const node of section?.nodes ?? []) {
    if (node.type === "heading" && node.depth === depth) {
      active = { title: textOf(node), nodes: [] };
      sub.set(active.title, active);
      continue;
    }
    if (active) active.nodes.push(node);
  }
  return sub;
}

function firstTable(section) {
  const table = section?.nodes.find((node) => node.type === "table");
  if (!table?.children?.length) return [];
  const headers = table.children[0].children.map(textOf);
  return table.children.slice(1).map((row) =>
    Object.fromEntries(
      headers.map((header, index) => [header, textOf(row.children[index])]),
    ),
  );
}

function findSectionByKeyword(sections, keyword) {
  for (const [title, section] of sections) {
    if (title.includes(keyword)) return section;
  }
  return null;
}

// 状态 / 优先级 emoji → 语义层级，供前端上色。
function statusLevel(value) {
  if (!value) return "unknown";
  if (value.includes("✅")) return "ok";
  if (value.includes("⚠")) return "warn";
  if (value.includes("❌")) return "missing";
  return "unknown";
}

function priorityLevel(value) {
  if (!value) return "none";
  if (value.includes("🔴")) return "high";
  if (value.includes("🟠")) return "mid-high";
  if (value.includes("🟡")) return "mid";
  return "none";
}

const ROLE_HEADER_MAP = {
  "#": "id",
  "岗位名称": "title",
  "公司": "company",
  "薪资范围": "salary",
  "工作地点": "location",
  "核心任职要求": "requirements",
  "匹配度": "match",
  "来源": "source",
};

function mapRoleRow(row) {
  const picked = {};
  for (const [header, key] of Object.entries(ROLE_HEADER_MAP)) {
    if (row[header] != null) picked[key] = row[header];
  }
  return {
    id: picked.id || null,
    title: picked.title || null,
    company: picked.company || null,
    salary: picked.salary || null,
    location: picked.location || null,
    requirements: picked.requirements || null,
    match: picked.match || null,
    source: picked.source || null,
  };
}

function roleGroup(subSections, keywords) {
  let section = null;
  let label = keywords[0];
  for (const [title, sub] of subSections) {
    if (keywords.some((kw) => title.includes(kw))) {
      section = sub;
      label = title;
      break;
    }
  }
  const items = firstTable(section).map(mapRoleRow);
  return { label, count: items.length, items };
}

function extractRolesFromTree(tree) {
  const sections = sectionMap(tree);
  const opening = findSectionByKeyword(sections, "在招岗位清单");
  const empty = {
    A: { label: "方向 A", count: 0, items: [] },
    B: { label: "方向 B", count: 0, items: [] },
  };
  if (!opening) return empty;
  const subSections = subSectionMap(opening, 3);
  return {
    A: roleGroup(subSections, ["方向 A"]),
    B: roleGroup(subSections, ["方向 B"]),
  };
}

function extractMatrixFromTree(tree) {
  const sections = sectionMap(tree);
  const matrixSection = findSectionByKeyword(sections, "技能差距矩阵");
  return firstTable(matrixSection).map((row) => ({
    skill: row["技能项"] || null,
    status: row["状态"] || null,
    statusLevel: statusLevel(row["状态"]),
    roles: row["出现岗位"] || null,
    question: row["面试典型问法"] || null,
    priority: row["学习优先级"] || null,
    priorityLevel: priorityLevel(row["学习优先级"]),
  }));
}

function parseReportTree(reportContent) {
  const parsed = matter(String(reportContent || ""));
  return unified().use(remarkParse).use(remarkGfm).parse(parsed.content);
}

function eligibleCareerDocument(document) {
  return document?.layer === "career" && document?.extension === "md";
}

// 组装 /api/career 的响应：主报告元信息 + 题库清单 + 结构化的岗位表 / 差距矩阵。
// 主报告缺失或解析失败时，roles / matrix 保持空态，遵循「缺失保持缺失」原则。
export function careerPayload(index) {
  const careerDocs = (index?.documents ?? []).filter(eligibleCareerDocument);

  let report = null;
  const banks = [];

  for (const document of careerDocs) {
    const fm = document.frontmatter || {};
    const base = {
      id: document.id,
      title: document.title,
      direction: fm.direction || null,
      updated: document.updatedAt || fm.updated || null,
    };
    if (fm.category === "strategy-report") {
      report = base;
    } else if (fm.category === "interview-prep") {
      const count = Number(fm.questionCount);
      banks.push({
        ...base,
        questionCount: Number.isFinite(count) ? count : null,
      });
    }
  }

  let roles = {
    A: { label: "方向 A", count: 0, items: [] },
    B: { label: "方向 B", count: 0, items: [] },
  };
  let matrix = [];

  if (report) {
    const full = getDocument(index, report.id);
    if (full?.content) {
      try {
        const tree = parseReportTree(full.content);
        roles = extractRolesFromTree(tree);
        matrix = extractMatrixFromTree(tree);
      } catch {
        // 主报告解析失败时保持空态。
      }
    }
  }

  banks.sort((a, b) =>
    String(a.direction || "").localeCompare(String(b.direction || ""), "zh-CN"),
  );

  return {
    generatedAt: index?.generatedAt ?? null,
    available: careerDocs.length > 0,
    report,
    banks,
    roles,
    matrix,
  };
}
