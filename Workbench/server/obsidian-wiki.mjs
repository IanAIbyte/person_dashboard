import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import matter from "gray-matter";

// Obsidian 知识本体 walker：只读外部 Obsidian 知识库中「可对外展示的知识」部分，
// 供知识星图（/api/graph）与 Wiki 层（/api/collections/wiki）复用。
// 与 career.mjs 同构：绕开主 vault index，按「白名单目录 + 黑名单」遍历，绝不写文件。

const OBSIDIAN_ID_PREFIX = "obsidian-";

function encodeObsidianId(relativePath) {
  return `${OBSIDIAN_ID_PREFIX}${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

// 从 obsidian 文档 id 反解相对路径；非 obsidian id 或非法编码返回 null。
export function obsidianRelativePathFromId(id) {
  if (typeof id !== "string" || !id.startsWith(OBSIDIAN_ID_PREFIX)) return null;
  const encoded = id.slice(OBSIDIAN_ID_PREFIX.length);
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

// 白名单目录（递归遍历其中的 .md）。只收「知识本体」，不含 raw/模板/敏感。
const WHITELIST_DIRS = [
  "02_Areas/股票/实体",
  "02_Areas/股票/概念",
  "02_Areas/股票/主题研究",
  "02_Areas/股票/选股方法论",
  "02_Areas/职业规划/概念",
  "02_Areas/AI方法论",
  "03_Resources",
];

// 精确允许的入口文件（MOC、题库台账、战役页）。
const EXACT_FILES = new Set([
  "02_Areas/股票/股票研究地图.md",
  "02_Areas/职业规划/面试研究地图.md",
  "02_Areas/职业规划/题库/题库-大数据开发.md",
  "02_Areas/职业规划/题库/题库-数据仓库与建模.md",
  "02_Areas/职业规划/题库/题库-面试鸭-大数据.md",
  "01_Projects/求职2026.md",
]);

// 路径段黑名单：任何一段命中即排除（防真实凭据/身份泄漏，防御性）。
const FORBIDDEN_SEGMENTS = new Set(["简历", "账号", "密码", "Attachments"]);

// 路径前缀黑名单：完整排除的敏感/非知识目录。
const FORBIDDEN_PREFIXES = [
  "02_Areas/个人资料/",
  "02_Areas/各种软件会员/",
  "02_Areas/职业规划/简历/",
  "02_Areas/职业规划/题库/来源/",
  "02_Areas/股票/三线文案大锅饭/",
  "02_Areas/股票/Prompts/",
  "02_Areas/股票/Skills/",
  "01_Projects/微信小程序/",
  "Clippings/",
  "90_Templates/",
  "00_Inbox/",
  "05_Daily/",
  "04_Archives/",
];

function normalizeRelPath(relativePath) {
  const rel = String(relativePath || "").replaceAll("\\", "/");
  if (!rel || rel.includes("..") || !rel.endsWith(".md")) return null;
  return rel;
}

function forbiddenPath(rel) {
  if (rel.split("/").some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return true;
  return FORBIDDEN_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

export function isAllowedObsidianPath(relativePath) {
  const rel = normalizeRelPath(relativePath);
  if (!rel || forbiddenPath(rel)) return false;
  if (EXACT_FILES.has(rel)) return true;
  return WHITELIST_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

// Obsidian type → 项目 type。entity/moc/note 在项目 10 类里无对应，做如下映射：
//   moc → topic（MOC=主题入口）、entity → entity（新增）、note → other。
function mapType(frontmatterType) {
  const type = String(frontmatterType ?? "").trim();
  if (type === "moc") return "topic";
  if (type === "entity") return "entity";
  if (type === "concept") return "concept";
  if (type === "source") return "source";
  if (type === "note") return "other";
  return type || "other";
}

// 与主 vault collectionPayload 的 wiki typeLabels 保持一致的中文分组名。
const TYPE_LABELS = {
  concept: "核心概念",
  framework: "方法框架",
  entity: "实体",
  source: "来源拆解",
  topic: "主题入口",
  other: "其他",
};

// 主题域（section）：PARA 第二级目录，用于 Wiki 层的副标题与星图分组。
function sectionOf(relativePath) {
  const parts = relativePath.split("/");
  if (parts[0] === "02_Areas") return parts[1] || null;
  if (parts[0] === "03_Resources") return "资源";
  if (parts[0] === "01_Projects") return "项目";
  return parts[0] || null;
}

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

async function readMetadata(root, relativePath) {
  const content = await readFile(path.join(root, relativePath), "utf8");
  const parsed = matter(content);
  return { content, frontmatter: parsed.data ?? {} };
}

// 递归收集某个白名单目录下所有 .md 文件的相对路径。
async function collectDir(root, relativeDir) {
  const dir = path.join(root, relativeDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const rel = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (forbiddenPath(rel)) continue;
      files.push(...(await collectDir(root, rel)));
    } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
      if (!forbiddenPath(rel)) files.push(rel);
    }
  }
  return files;
}

// 收集白名单内全部文件的相对路径。
async function collectAllFiles(root) {
  const files = new Set([...EXACT_FILES]);
  for (const dir of WHITELIST_DIRS) {
    for (const rel of await collectDir(root, dir)) files.add(rel);
  }
  return [...files].filter(isAllowedObsidianPath);
}

// 建立 basename → 相对路径索引，用于双链按短名解析。
function buildLinkIndex(files) {
  const basenames = new Map();
  for (const rel of files) {
    const base = rel.split("/").pop()?.replace(/\.md$/, "") || "";
    if (!base) continue;
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base).push(rel);
  }
  return basenames;
}

// 把白名单内的双链目标解析为 obsidian- 前缀 id。
// 优先级：相对当前文档目录的精确路径 → 根相对精确路径 → basename 唯一匹配。
function resolveWikiLinks(relativePath, wikiLinks, files, linkIndex) {
  const fileSet = new Set(files);
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
      const exact = fileSet.has(`${candidate}.md`) ? `${candidate}.md`
        : fileSet.has(candidate) ? candidate
          : null;
      if (exact) {
        resolved = exact;
        break;
      }
    }

    if (!resolved && !rawTarget.includes("/")) {
      const matches = linkIndex.get(rawTarget) || [];
      if (matches.length === 1) resolved = matches[0];
    }

    if (resolved) link.resolvedId = encodeObsidianId(resolved);
  }

  return wikiLinks;
}

async function readDocument(root, relativePath, files, linkIndex) {
  if (!root || !isAllowedObsidianPath(relativePath)) return null;
  const { content, frontmatter } = await readMetadata(root, relativePath);
  const title =
    frontmatter?.title ||
    relativePath.split("/").pop()?.replace(/\.md$/, "") ||
    "未命名";

  if (!content) {
    return {
      id: encodeObsidianId(relativePath),
      relativePath,
      title,
      content: "",
      body: `> 该文档暂无内容。\n\n「${title}」尚未编译（待生成）。`,
      frontmatter,
      headings: [],
      wikiLinks: [],
      status: frontmatter?.status || "active",
      type: mapType(frontmatter?.type),
      updatedAt: frontmatter?.updated || frontmatter?.created || null,
      layer: "wiki",
      kind: "knowledge",
      section: sectionOf(relativePath),
      contentType: "markdown",
    };
  }

  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  const wikiLinks = resolveWikiLinks(
    relativePath,
    parseWikiLinks(body),
    files,
    linkIndex,
  );

  return {
    id: encodeObsidianId(relativePath),
    relativePath,
    title,
    content,
    body,
    frontmatter,
    headings: parseHeadings(body),
    wikiLinks,
    status: frontmatter?.status || "active",
    type: mapType(frontmatter?.type),
    updatedAt: frontmatter?.updated || frontmatter?.created || null,
    layer: "wiki",
    kind: "knowledge",
    section: sectionOf(relativePath),
    contentType: "markdown",
  };
}

// 单文档读取，供 /api/documents/:id 的 obsidian fallback 使用。
export async function readObsidianDocument(root, relativePath) {
  if (!root || !isAllowedObsidianPath(relativePath)) return null;
  const files = await collectAllFiles(root);
  const linkIndex = buildLinkIndex(files);
  return readDocument(root, relativePath, files, linkIndex);
}

// 知识星图 payload（同构 graphPayload 的 nodes[]/edges[] 契约）。
export async function obsidianGraphPayload(root) {
  if (!root) {
    return {
      generatedAt: new Date().toISOString(),
      stats: { nodeCount: 0, edgeCount: 0, isolatedCount: 0 },
      typeCounts: {},
      nodes: [],
      edges: [],
    };
  }

  const files = await collectAllFiles(root);
  const linkIndex = buildLinkIndex(files);
  const nodes = [];
  for (const rel of files) {
    const doc = await readDocument(root, rel, files, linkIndex);
    if (doc) nodes.push(doc);
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeMap = new Map();
  for (const node of nodes) {
    for (const link of node.wikiLinks) {
      if (!link.resolvedId || !nodeIds.has(link.resolvedId)) continue;
      if (link.resolvedId === node.id) continue;
      const key = `${node.id}__${link.resolvedId}`;
      const existing = edgeMap.get(key);
      if (existing) existing.weight += 1;
      else edgeMap.set(key, { source: node.id, target: link.resolvedId, weight: 1 });
    }
  }

  const degree = new Map();
  const inDegree = new Map();
  const outDegree = new Map();
  for (const edge of edgeMap.values()) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const typeCounts = {};
  for (const node of nodes) {
    typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edgeMap.size,
      isolatedCount: nodes.filter((node) => !degree.has(node.id)).length,
    },
    typeCounts,
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      section: node.section,
      tags: Array.isArray(node.frontmatter?.tags) ? node.frontmatter.tags : [],
      updatedAt: node.updatedAt,
      degree: degree.get(node.id) ?? 0,
      inDegree: inDegree.get(node.id) ?? 0,
      outDegree: outDegree.get(node.id) ?? 0,
    })),
    edges: [...edgeMap.values()],
  };
}

// Wiki 层 payload（同构 collectionPayload 的 wiki 分支：total/groups/items）。
export async function obsidianWikiPayload(root) {
  if (!root) {
    return { total: 0, groups: [], items: [] };
  }

  const files = await collectAllFiles(root);
  const linkIndex = buildLinkIndex(files);
  const docs = [];
  for (const rel of files) {
    const doc = await readDocument(root, rel, files, linkIndex);
    if (doc) docs.push(doc);
  }

  const typeCounts = {};
  for (const doc of docs) {
    typeCounts[doc.type] = (typeCounts[doc.type] ?? 0) + 1;
  }

  const groups = Object.entries(typeCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => ({ key, label: TYPE_LABELS[key] ?? key, count }));

  return {
    total: docs.length,
    groups,
    items: docs.map((doc) => ({
      id: doc.id,
      path: doc.relativePath,
      fileName: doc.relativePath.split("/").pop(),
      layer: doc.layer,
      section: doc.section,
      kind: doc.kind,
      title: doc.title,
      type: doc.type,
      status: doc.status,
      tags: Array.isArray(doc.frontmatter?.tags) ? doc.frontmatter.tags : [],
      updatedAt: doc.updatedAt,
    })),
  };
}
