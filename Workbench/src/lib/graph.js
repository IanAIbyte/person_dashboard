// 图谱只使用产品既定的紫色轴与中性灰。类型差异依靠明度、节点大小和文字标签表达，
// 避免把知识层变成一张彩虹分类图。
export const TYPE_META = {
  concept: { color: "var(--kg-type-concept)", label: "概念", code: "CPT" },
  framework: { color: "var(--kg-type-framework)", label: "框架", code: "FRM" },
  entity: { color: "var(--kg-type-entity)", label: "实体", code: "ENT" },
  diagnosis: { color: "var(--kg-type-diagnosis)", label: "诊断", code: "DIA" },
  analysis: { color: "var(--kg-type-analysis)", label: "分析", code: "ANA" },
  comparison: { color: "var(--kg-type-comparison)", label: "比较", code: "CMP" },
  case: { color: "var(--kg-type-case)", label: "案例", code: "CAS" },
  "source-summary": { color: "var(--kg-type-source-summary)", label: "来源拆解", code: "SRC" },
  source: { color: "var(--kg-type-source)", label: "来源", code: "SRC" },
  topic: { color: "var(--kg-type-topic)", label: "主题", code: "TOP" },
  conflict: { color: "var(--kg-type-conflict)", label: "冲突", code: "CFL" },
  question: { color: "var(--kg-type-question)", label: "问答", code: "QST" },
  other: { color: "var(--kg-type-other)", label: "其他", code: "ETC" },
};

export function typeMetaOf(type) {
  return TYPE_META[type] || TYPE_META.other;
}

export function typeColor(type) {
  return typeMetaOf(type).color;
}

export function typeLabelOf(type) {
  return typeMetaOf(type).label;
}

export function typeCodeOf(type) {
  return typeMetaOf(type).code;
}

export function nodeRadius(node) {
  const degree = Math.max(0, Number(node?.degree) || 0);
  return Math.min(19, 4.2 + Math.sqrt(degree) * 1.85);
}

export function nodeLabelPriority(node) {
  const degree = Math.max(0, Number(node?.degree) || 0);
  const statusWeight = node?.status === "active" ? 3 : 0;
  return degree * 10 + statusWeight;
}

export function truncateGraphTitle(value, maximum = 24) {
  const title = String(value || "未命名页面").trim();
  if (title.length <= maximum) return title;
  return `${title.slice(0, Math.max(1, maximum - 1))}…`;
}
