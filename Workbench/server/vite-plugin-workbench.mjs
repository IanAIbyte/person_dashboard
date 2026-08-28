import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getDocument,
  searchIndex,
} from "./vault-index.mjs";
import {
  cancelJob,
  confirmJob,
  createXhsDraftJob,
  detectCodexCli,
  getJob,
  listJobs,
  subscribeJob,
} from "./codex-runner.mjs";
import {
  createIngestSnapshot,
  createReaderNotesRepository,
  hashReaderDocumentContent,
} from "./reader-notes.mjs";
import { createReaderExplanationsService } from "./reader-explanations.mjs";
import {
  MATERIAL_READING_STATE_PATH,
  createMaterialReadingStateRepository,
} from "./material-reading-state.mjs";
import { stockUniversePayload } from "./stock-universe.mjs";
import {
  STOCK_CODES_PATH,
  createStockCodesRepository,
} from "./stock-codes.mjs";
import {
  STOCK_WATCHLIST_PATH,
  createStockWatchlistRepository,
} from "./stock-watchlist.mjs";
import {
  STOCK_RESEARCH_PATH,
  createStockResearchRepository,
} from "./stock-research.mjs";
import { createLlmClient } from "./llm-client.mjs";
import { pushServerChan } from "./serverchan.mjs";
import { computeMA, createMarketDataService, maTrend } from "./market-data.mjs";
import { createStockNewsService } from "./stock-news.mjs";
import { createStockAnalysisService } from "./stock-analysis.mjs";
import { createStockFinancialsService } from "./stock-financials.mjs";
import {
  createStockPoolRepository,
  STOCK_POOL_PATH,
} from "./stock-pool.mjs";
import {
  materialFolderPayload,
  materialReadingQueuePayload,
  materialsHomePayload,
} from "./materials.mjs";
import { booksPayload } from "./books.mjs";
import { careerPayload, careerRelativePathFromId, readCareerDocument } from "./career.mjs";
import { createReviewEventsRepository, REVIEW_EVENTS_PATH } from "./review-events.mjs";
import { createDailyReviewStore, DAILY_REVIEW_PATH } from "./daily-review-store.mjs";
import { createDailyReviewService } from "./daily-review.mjs";
import { loadDailyReviewConfig } from "./daily-review-config.mjs";
import { createPortfolioRepository, PORTFOLIO_PATH } from "./portfolio.mjs";
import { createSentimentDataService } from "./sentiment-data.mjs";
import { createPromptsLibrary } from "./prompts-library.mjs";
import { checkService, createServicesStore } from "./services-store.mjs";
import { createServersRegistry, openItermSsh, probeServer } from "./servers-registry.mjs";
import { createDisksMonitor } from "./disks.mjs";
import { createCoachPromptRepository, COACH_PROMPT_PATH } from "./coach-prompt.mjs";
import { createReviewScheduleRepository, REVIEW_SCHEDULE_PATH } from "./review-schedule.mjs";
import {
  obsidianGraphPayload,
  obsidianRelativePathFromId,
  obsidianWikiPayload,
  readObsidianDocument,
} from "./obsidian-wiki.mjs";
import {
  getSocialInsight,
  getSocialTrend,
  listSocialInsights,
  listSocialTrends,
} from "./social-insights.mjs";
import { validateVaultSelections } from "./security.mjs";
import {
  WIKI_INGEST_STATUS,
  createWikiIngestRunner,
} from "./wiki-ingest-runner.mjs";
import { createVaultSyncService } from "./vault-sync.mjs";
import { loadAttentionStrategy } from "./public-config.mjs";

const workbenchRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultVaultRoot = path.resolve(
  process.env.PERSONAL_DASHBOARD_VAULT_ROOT ||
    path.join(workbenchRoot, "..", "个人知识库"),
);
const jsonHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const imageContentTypes = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};
const maximumVaultImageBytes = 8 * 1024 * 1024;
const readerImageAllowedRoots = [
  "10_raw",
  "30_self_media",
  "40_topics",
  "50_scripts",
  "wiki",
];

function json(res, status, value) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(value));
}

async function serveVaultImage(res, index, vaultRoot, id) {
  const document = getDocument(index, id);
  const contentType = imageContentTypes[document?.extension];
  const isAllowedCover =
    document?.path.startsWith("50_scripts/") ||
    document?.path.startsWith("10_raw/books/");
  if (
    !document ||
    document.previewKind !== "image" ||
    !contentType ||
    !isAllowedCover
  ) {
    return json(res, 404, {
      error: { code: "VAULT_IMAGE_NOT_FOUND", message: "封面图片不存在。" },
    });
  }

  const validated = await validateVaultSelections([document.path], {
    vaultRoot,
    allowedRoots: ["50_scripts", "10_raw"],
  });
  const selection = validated.selections[0];
  if (
    !selection ||
    selection.kind !== "file" ||
    selection.size > maximumVaultImageBytes
  ) {
    return json(res, 413, {
      error: { code: "VAULT_IMAGE_TOO_LARGE", message: "封面图片超过读取上限。" },
    });
  }

  const buffer = await readFile(selection.absolutePath);
  res.writeHead(200, {
    "Cache-Control": "private, max-age=60",
    "Content-Length": buffer.byteLength,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buffer);
}

function readerImageDocument(index, sourceId, rawSource) {
  const sourceDocument = getDocument(index, sourceId);
  const source = String(rawSource ?? "").trim();
  if (
    !sourceDocument ||
    sourceDocument.previewKind !== "markdown" ||
    !source ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)
  ) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(source.split(/[?#]/, 1)[0]).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;

  const candidate = decoded.startsWith("/")
    ? path.posix.normalize(decoded.replace(/^\/+/, ""))
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(sourceDocument.path), decoded),
      );
  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    candidate.startsWith("../") ||
    path.posix.isAbsolute(candidate)
  ) {
    return null;
  }

  const imageDocument = getDocument(index, candidate);
  return imageDocument?.previewKind === "image" ? imageDocument : null;
}

async function serveReaderImage(res, index, vaultRoot, sourceId, source) {
  const document = readerImageDocument(index, sourceId, source);
  const contentType = imageContentTypes[document?.extension];
  if (!document || !contentType) {
    return json(res, 404, {
      error: { code: "READER_IMAGE_NOT_FOUND", message: "文章图片不存在。" },
    });
  }

  const validated = await validateVaultSelections([document.path], {
    vaultRoot,
    allowedRoots: readerImageAllowedRoots,
  });
  const selection = validated.selections[0];
  if (
    !selection ||
    selection.kind !== "file" ||
    selection.size > maximumVaultImageBytes
  ) {
    return json(res, 413, {
      error: { code: "READER_IMAGE_TOO_LARGE", message: "文章图片超过读取上限。" },
    });
  }

  const buffer = await readFile(selection.absolutePath);
  res.writeHead(200, {
    "Cache-Control": "private, max-age=60",
    "Content-Length": buffer.byteLength,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buffer);
}

function errorPayload(error) {
  return {
    error: {
      code: error?.code || "WORKBENCH_ERROR",
      message: error?.message || "工作台请求失败。",
    },
  };
}

function errorStatus(error) {
  const code = error?.code;
  if (code === "LOCAL_API_ORIGIN_DENIED") return 403;
  if (code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (
    ["JOB_NOT_FOUND", "DOCUMENT_NOT_FOUND", "READER_EXPLANATION_NOT_FOUND"].includes(code) ||
    code?.endsWith("_NOT_FOUND")
  ) return 404;
  if (
    [
      "CONCURRENCY_LIMIT",
      "CONFIRMATION_IN_PROGRESS",
      "JOB_OPERATION_IN_PROGRESS",
      "JOB_NOT_AWAITING_REVIEW",
      "INVALID_STATUS_TRANSITION",
      "SOURCE_CHANGED_SINCE_REVIEW",
      "NOTES_CHANGED_SINCE_REVIEW",
      "REVIEW_PLAN_STALE",
      "HANDOFF_PATH_CONFLICT",
      "TURN_LIMIT_REACHED",
      "TOO_MANY_READER_DOCUMENTS",
      "TOO_MANY_READER_NOTES",
      "DUPLICATE_READER_NOTE_ID",
      "DOCUMENT_PATH_ALREADY_NOTED",
      "READER_EXPLANATION_CONCURRENCY_LIMIT",
      "READER_EXPLANATION_FOLLOW_UP_LIMIT",
      "READER_EXPLANATION_SOURCE_CHANGED",
      "READER_EXPLANATION_NOT_COMPLETED",
      "CONTENT_HASH_MISMATCH",
      "FOLLOW_UP_LIMIT_REACHED",
      "EXPLANATION_NOT_COMPLETED",
      "EXPLANATION_ALREADY_SAVED",
      "TOO_MANY_EXPLANATIONS",
      "DUPLICATE_EXPLANATION_ID",
      "SERVICE_CLOSED",
      "RESERVED_READER_NOTE",
      "READER_EXPLANATION_NOTE_ID_CONFLICT",
      "TOO_MANY_MATERIAL_READING_ITEMS",
      "JOB_NOT_ACTIVE",
      "WRITEBACK_PLAN_REQUIRED",
      "WRITEBACK_PLAN_STALE",
      "WRITEBACK_PLAN_CHANGED",
    ].includes(code)
  ) {
    return 409;
  }
  if (
    code === "READER_NOTES_STORE_CORRUPT" ||
    code === "READER_NOTES_STORE_TOO_LARGE" ||
    code?.startsWith("UNSAFE_READER_NOTES_") ||
    code?.startsWith("UNSAFE_READER_EXPLANATIONS_") ||
    code?.startsWith("READER_EXPLANATIONS_STORE_") ||
    code?.startsWith("MATERIAL_READING_STATE_") ||
    code === "SYMLINK_ESCAPE"
  ) {
    return 500;
  }
  if (
    code === "INVALID_JSON" ||
    code === "REQUEST_TOO_LARGE" ||
    code?.startsWith("INVALID_") ||
    code?.startsWith("READER_NOTE") ||
    code?.startsWith("INVALID_EXPLANATION") ||
    code?.startsWith("INVALID_QUOTE") ||
    code?.startsWith("SOURCE_") ||
    code?.startsWith("NOTES_") ||
    code?.startsWith("REVIEW_") ||
    code === "PATH_TRAVERSAL" ||
    code === "NO_READER_NOTES" ||
    code === "UNSUPPORTED_EXPLANATION_OVERRIDE" ||
    code === "EXPLANATION_INPUT_TOO_LONG" ||
    code === "QUOTE_CONTEXT_MISMATCH" ||
    code === "QUOTE_NOT_IN_DOCUMENT" ||
    code === "QUESTION_REQUIRED" ||
    code === "DOCUMENT_MISMATCH" ||
    code === "QUOTE_MISMATCH" ||
    code?.startsWith("INVALID_MATERIAL")
  ) {
    return 400;
  }
  return 500;
}

function assertLocalMutationRequest(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return;
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    const error = new Error("本地工作台拒绝跨站修改请求。");
    error.code = "LOCAL_API_ORIGIN_DENIED";
    throw error;
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Invalid Origin headers are rejected below.
    }
    if (originHost !== host) {
      const error = new Error("本地工作台拒绝来自其他 Origin 的修改请求。");
      error.code = "LOCAL_API_ORIGIN_DENIED";
      throw error;
    }
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("修改请求必须使用 application/json。");
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
}

function assertAllowedObjectKeys(value, allowedKeys, code = "INVALID_READER_EXPLANATION_REQUEST") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("请求必须是 JSON 对象。");
    error.code = code;
    throw error;
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) {
    const error = new Error(`请求包含不允许的字段：${unexpected.join("、")}`);
    error.code = code;
    throw error;
  }
}

function readerExplanationDocumentId(record) {
  if (record?.document && typeof record.document === "object") {
    return record.document.id ?? record.document.documentId ?? null;
  }
  return record?.documentId ?? record?.document ?? null;
}

function readerExplanationThread(records, targetId) {
  const rows = Array.isArray(records) ? records : [];
  const byId = new Map(rows.filter((record) => record?.id).map((record) => [String(record.id), record]));
  const rootOf = (record) => {
    let current = record;
    const seen = new Set();
    while (current?.parentId && byId.has(String(current.parentId))) {
      if (seen.has(String(current.id))) break;
      seen.add(String(current.id));
      current = byId.get(String(current.parentId));
    }
    return current;
  };
  const target = byId.get(String(targetId));
  if (!target) return [];
  const rootId = String(rootOf(target)?.id || target.id);
  return rows
    .filter((record) => String(rootOf(record)?.id || record.id) === rootId)
    .sort((left, right) =>
      (Number(left.followUpDepth) || 0) - (Number(right.followUpDepth) || 0) ||
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
    );
}

function renderReaderExplanationNote(records) {
  const completed = (Array.isArray(records) ? records : [])
    .filter((record) => record?.status === "completed" && record?.result);
  const turns = completed.flatMap((record, index) => {
    const result = record.result || {};
    const answer = result.answer || result.plainLanguage || "_本轮没有生成回答。_";
    const question = String(record.question || "").trim();
    const questionLabel = index === 0 ? "我的问题" : `我的追问 ${index}`;
    const answerLabel = index === 0 ? "Codex 回答" : `Codex 继续回答 ${index}`;
    return [
      ...(index > 0 ? ["", "---", ""] : []),
      `**${questionLabel}**`,
      "",
      question || (index === 0 ? "_未填写问题，直接理解原文。_" : "_本轮问题缺失。_"),
      "",
      `**${answerLabel}**`,
      "",
      answer,
    ];
  });
  return [
    "> AI 阅读辅助，非用户判断。以下内容由 Codex 结合保存时对应版本的整篇原文生成，请回到原文核对。",
    "",
    ...turns,
  ].join("\n");
}

async function readJson(req, maximumBytes = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
      const error = new Error("请求内容超过安全上限。");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
  }

  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求 JSON 无法解析。");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function groupDefinition(key, label, count, description = undefined) {
  return { key, label, count, ...(description ? { description } : {}) };
}

function materialGroup(document) {
  const section = document.section;
  if (["articles", "deep-reading", "web-search"].includes(section)) return "reading";
  if (["my-thoughts", "personal-reviews", "diagnosis-cases"].includes(section)) return "personal";
  if (section === "douyin") return "douyin";
  if (section === "codex-sessions") return "sessions";
  return "other";
}

function collectionPayload(index, kind) {
  if (kind === "materials") {
    const items = index.documents
      .filter(
        (item) =>
          item.layer === "raw" &&
          !item.path.startsWith("10_raw/books/") &&
          !item.path.startsWith("10_raw/social-insights/"),
      )
      .map((item) => ({ ...item, group: materialGroup(item) }));
    const counts = Object.groupBy
      ? Object.groupBy(items, (item) => item.group)
      : items.reduce((result, item) => {
          (result[item.group] ||= []).push(item);
          return result;
        }, {});
    return {
      total: items.length,
      groups: [
        groupDefinition("reading", "阅读与研究", counts.reading?.length ?? 0, "文章、深度阅读与网页研究"),
        groupDefinition("personal", "个人输入", counts.personal?.length ?? 0, "每日想法、读后思考与诊断案例"),
        groupDefinition("douyin", "抖音证据", counts.douyin?.length ?? 0, "作品数据、截图与复盘证据包"),
        groupDefinition("sessions", "Codex 活动", counts.sessions?.length ?? 0, "每周 Session 轻量索引"),
      ],
      items,
    };
  }

  if (kind === "wiki") {
    const typeLabels = {
      source: "来源拆解",
      framework: "方法框架",
      concept: "核心概念",
      diagnosis: "诊断判断",
      analysis: "综合分析",
      case: "具体案例",
      comparison: "比较选型",
      topic: "主题入口",
      conflict: "争议问题",
      question: "复用问答",
      entity: "实体",
    };
    const groups = Object.entries(index.wiki.countsByType)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => groupDefinition(key, typeLabels[key] ?? key, count));
    return {
      total: index.wiki.pages.length,
      groups,
      items: index.wiki.pages,
    };
  }

  if (kind === "content") {
    const stageLabels = {
      idea: "候选",
      material_validating: "素材验证中",
      filmed: "已拍",
      published: "已发布",
      selected: "已确认",
      topic_selected: "已选题",
      ready_to_shoot: "准备完成",
    };
    const groups = Object.entries(index.topics.countsByPipelineStage)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => groupDefinition(key, stageLabels[key] ?? key, count));
    const items = index.topics.items.map((item) => ({
      ...item,
      layer: "topic",
      type: "Topic",
      section: item.series || item.folderStatus,
      status: item.pipelineStage,
      excerpt: [
        item.isFilmed ? "已拍" : null,
        item.isPublished ? "已发布" : null,
        item.displayFormat,
      ]
        .filter(Boolean)
        .join(" · "),
    }));
    return { total: items.length, groups, items };
  }

  if (kind === "archive") {
    const labels = {
      data_reviews: "数据复盘",
      weekly_reviews: "周复盘",
      content_strategy: "内容策略",
      content_reviews: "内容审查",
      system_design: "系统设计",
      rule_sync: "规则修复",
      topic_outputs: "选题探索",
      dashboards: "Dashboard",
    };
    const groups = Object.entries(index.runs.countsByCategory)
      .sort((left, right) => right[1] - left[1])
      .map(([key, count]) => groupDefinition(key, labels[key] ?? key, count));
    return { total: index.runs.items.length, groups, items: index.runs.items };
  }

  return { total: 0, groups: [], items: [] };
}

function overviewPayload(index) {
  const candidateCount = index.topics.items.filter(
    (topic) =>
      topic.folderStatus === "idea" &&
      !topic.isFilmed &&
      !topic.isPublished,
  ).length;
  const douyinAvailable = index.douyin.available === true;
  const personalKnowledgeLine = douyinAvailable
    ? index.douyin.contentLines.find((line) =>
        String(line.name || "").includes("个人知识库"),
      )
    : null;
  let cumulativePlays = 0;
  const douyinTrend = [...(douyinAvailable ? index.douyin.monthly ?? [] : [])]
    .filter((item) => item.month && Number.isFinite(item.views))
    .sort((left, right) => String(left.month).localeCompare(String(right.month)))
    .map((item) => {
      cumulativePlays += item.views;
      return {
        date: item.month,
        plays: item.views,
        cumulativePlays,
        workCount: item.workCount,
      };
    });
  const douyinRange = index.douyin.range ?? {};
  const douyinRangeLabel =
    douyinRange.from && douyinRange.to
      ? `${douyinRange.from} → ${douyinRange.to}`
      : null;
  const douyinQualityNotices = douyinAvailable
    ? [
        `来源：${index.douyin.sourcePath}；${index.douyin.comparableCount} 条可比作品${douyinRangeLabel ? `，作品发布时间范围 ${douyinRangeLabel}` : ""}。`,
        "图表按作品发布月份汇总当前累计播放，不代表账号每日新增播放。",
        ...(index.douyin.qualityIssues ?? [])
          .slice(0, 3)
          .map((issue) => `${issue.issue}${issue.affectedWorks ? `（${issue.affectedWorks}）` : ""}`),
      ]
    : [
        `抖音数据源不可用：${index.douyin.sourcePath} 未找到或无法解析。`,
      ];
  const filmedTopics = index.topics.items
    .filter((topic) => topic.isFilmed)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 2);
  const byUpdated = (left, right) =>
    (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
  const selectedRecent = [
    ...index.documents
      .filter((item) => !item.isArchived && item.layer === "wiki" && item.kind === "knowledge")
      .sort(byUpdated)
      .slice(0, 3),
    ...index.documents
      .filter((item) => !item.isArchived && item.layer === "raw")
      .sort(byUpdated)
      .slice(0, 3),
  ].sort(byUpdated);
  const sourceLabels = {
    source: "来源拆解",
    framework: "方法框架",
    concept: "核心概念",
    diagnosis: "诊断判断",
    analysis: "综合分析",
    comparison: "比较选型",
    case: "案例",
    articles: "文章原文",
    "deep-reading": "深度阅读",
    "web-search": "网页研究",
    "my-thoughts": "个人想法",
    "personal-reviews": "读后思考",
    "diagnosis-cases": "诊断案例",
    douyin: "抖音证据",
  };

  return {
    generatedAt: index.generatedAt,
    demoMode: index.demoMode === true,
    metrics: {
      raw: index.stats.rawFiles,
      wiki: index.stats.formalWikiPages,
      topics: index.stats.topics,
      candidates: candidateCount,
      filmed: index.stats.filmedTopics,
      publishedWorks: douyinAvailable ? index.stats.douyinWorks : null,
      runs: index.stats.runs,
      totalPlays: douyinAvailable
        ? index.douyin.summary.totalViews ?? null
        : null,
      profileVisits: douyinAvailable
        ? index.douyin.summary.totalProfileVisits ?? null
        : null,
      profileVisitsIsLowerBound:
        douyinAvailable &&
        index.douyin.summaryLowerBounds.totalProfileVisits === true,
      knowledgeContribution: personalKnowledgeLine?.viewSharePct ?? null,
    },
    wikiStatus: {
      active: index.wiki.countsByStatus.active ?? 0,
      needsReview:
        index.wiki.countsByStatus["needs-review"] ??
        index.wiki.countsByStatus.needs_review ??
        0,
      deprecated: index.wiki.countsByStatus.deprecated ?? 0,
    },
    recent: selectedRecent.map((item) => ({
      ...item,
      type: item.layer === "wiki" ? "Wiki" : "素材",
      section: sourceLabels[item.type] ?? sourceLabels[item.section] ?? item.section,
      relativePath: item.path,
    })),
    activity: filmedTopics.map((topic) => ({
      id: topic.id,
      documentId: topic.id,
      status: topic.isPublished ? "已拍摄 · 已发布" : "已拍摄",
      title: topic.title,
      meta: `更新于 ${String(topic.updatedAt || "").slice(5, 16).replace("T", " ")}`,
      dateTime: topic.updatedAt,
    })),
    douyinTrend,
    douyinAvailable,
    douyinQualityFlags: index.douyin.qualityFlags ?? [],
    douyinTrendTitle: douyinAvailable
      ? `作品播放汇总 · 按发布月份${douyinRange.to ? `（截至 ${String(douyinRange.to).slice(0, 10)}）` : ""}`
      : "抖音作品数据不可用",
    dataProvenance: douyinAvailable
      ? {
          sourcePath: index.douyin.sourcePath,
          sourceUpdatedAt: index.douyin.updatedAt,
          comparableWorks: index.douyin.comparableCount,
          range: douyinRange,
          trendGrain: "作品发布月份",
          trendMetric: "各月发布作品的当前累计播放",
          isRealtime: false,
        }
      : null,
    qualityNotices: douyinQualityNotices,
  };
}

function graphPayload(index) {
  const nodes = index.documents.filter(
    (document) =>
      document.layer === "wiki" &&
      document.kind === "knowledge" &&
      document.extension === "md",
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeMap = new Map();
  for (const node of nodes) {
    for (const link of node.wikiLinks ?? []) {
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
  return {
    generatedAt: index.generatedAt,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edgeMap.size,
      isolatedCount: nodes.filter((node) => !degree.has(node.id)).length,
    },
    typeCounts: index.wiki?.countsByType ?? {},
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type ?? "other",
      status: node.status ?? null,
      section: node.section ?? null,
      tags: node.tags ?? [],
      updatedAt: node.updatedAt,
      degree: degree.get(node.id) ?? 0,
      inDegree: inDegree.get(node.id) ?? 0,
      outDegree: outDegree.get(node.id) ?? 0,
    })),
    edges: [...edgeMap.values()],
  };
}

function readerBodyFromContent(content) {
  return typeof content === "string"
    ? content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "")
    : content;
}

function documentPayload(index, id) {
  const document = getDocument(index, id);
  if (!document) return null;
  const body = readerBodyFromContent(document.content);
  return {
    ...document,
    relativePath: document.path,
    body,
    contentHash:
      typeof body === "string" ? hashReaderDocumentContent(body) : null,
    outgoingLinks: (document.wikiLinks ?? [])
      .filter((link) => link.resolvedId)
      .map((link) => ({
        id: link.resolvedId,
        title: link.label || link.target,
      })),
  };
}

function requestFilters(url) {
  const filters = {};
  for (const key of ["layer", "kind", "section", "type", "status", "extension", "tags"]) {
    const values = url.searchParams.getAll(key).filter(Boolean);
    if (values.length) filters[key] = values.length === 1 ? values[0] : values;
  }
  if (url.searchParams.get("includeArchived") === "true") filters.includeArchived = true;
  filters.limit = Number(url.searchParams.get("limit") || 100);
  return filters;
}

// ===== 监控台 v2 共享：watchdog 状态文件读写 + 估值分位 + 默认配置 =====

const WATCHDOG_STATE_FILES = {
  alerts: ".workbench-stock-alerts.json",
  config: ".workbench-watchdog-config.json",
  valuation: ".workbench-valuation-history.json",
  diskCache: ".workbench-disk-cache.json",
};
const WATCHDOG_STATE_DIR = "10_raw/my-thoughts/reading-notes";

const WATCHDOG_DEFAULT_CONFIG = {
  enabled: true,
  thresholdPct: 3,
  windowMinutes: 5,
  cooldownMinutes: 15,
  pushEnabled: true,
  dailyPushLimit: 5,
  indexEnabled: true,
  indexThresholdPct: 1,
};

function watchdogStatePath(kind) {
  return path.join(vaultRootForWatchdogState(), WATCHDOG_STATE_DIR, WATCHDOG_STATE_FILES[kind]);
}
// vaultRoot 在插件工厂内；这里用模块级默认根（与 watchdog.mjs 一致：仓库旁「个人知识库」）。
function vaultRootForWatchdogState() {
  return defaultVaultRoot;
}

async function readWatchdogState(kind, fallback) {
  try {
    return JSON.parse(await readFile(watchdogStatePath(kind), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeWatchdogState(kind, value) {
  const target = watchdogStatePath(kind);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// 自建估值历史的当前分位（0-100，null 表示样本不足）。样本 <5 天不计算分位。
function valuationPercentile(series, quote) {
  const pick = (key, value) =>
    value == null ? null : (() => {
      const values = series.map((p) => p[key]).filter((v) => v != null);
      if (values.length < 5) return null;
      const below = values.filter((v) => v <= value).length;
      return Math.round((below / values.length) * 100);
    })();
  return {
    pe: pick("pe", quote.peTtm),
    pb: pick("pb", quote.pb),
    sampleDays: series.length,
  };
}


function openLocalDocument(vaultRoot, document, target) {
  const absolutePath = path.resolve(vaultRoot, document.path);
  if (target === "finder") {
    const child = spawn("/usr/bin/open", ["-R", absolutePath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }

  const vaultName = path.basename(vaultRoot);
  const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(document.path)}`;
  const child = spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export function workbenchApiPlugin({
  vaultRoot = defaultVaultRoot,
  careerVaultRoot = null,
  obsidianVaultRoot = null,
  zhipuApiKey = null,
  zhipuBaseUrl = null,
  serverChanSendKey = null,
  readerExplanationService = null,
} = {}) {
  let readerNoteApiMutationQueue = Promise.resolve();
  const readerNotes = createReaderNotesRepository({ vaultRoot });
  const materialReadingState = createMaterialReadingStateRepository({ vaultRoot });
  const stockWatchlist = createStockWatchlistRepository({ vaultRoot });
  const stockCodes = createStockCodesRepository({ vaultRoot });
  const stockResearch = createStockResearchRepository({ vaultRoot });
  const stockPool = createStockPoolRepository({ vaultRoot });
  const stockFinancials = createStockFinancialsService({ vaultRoot });
  const llmClient = createLlmClient({
    apiKey: zhipuApiKey,
    ...(zhipuBaseUrl ? { baseUrl: zhipuBaseUrl } : {}),
  });
  const marketData = createMarketDataService();
  const stockNews = createStockNewsService();
  const stockAnalysis = createStockAnalysisService({
    llmClient,
    newsService: stockNews,
    marketService: marketData,
  });
  const wikiIngest = createWikiIngestRunner({ vaultRoot });
  const reviewEvents = createReviewEventsRepository({ vaultRoot });
  const dailyReviewStore = createDailyReviewStore({ vaultRoot });
  const portfolioRepo = createPortfolioRepository({ vaultRoot });
  const sentimentService = createSentimentDataService();
  const promptsLibrary = createPromptsLibrary({ llmClient });
  const servicesStore = createServicesStore({ vaultRoot });
  const serversRegistry = createServersRegistry();
  // 磁盘每日缓存与 watchdog 状态同目录（vault 内运行态文件，git 忽略）。
  const disksMonitor = createDisksMonitor({ statePath: watchdogStatePath("diskCache") });
  // 健康探测低频策略：自动探测 1 天一次（缓存 24h），页面展示上次探测时间，
  // 手动按钮经 force 接口即时重测，避免给目标服务压力。
  const PROBE_TTL_MS = 24 * 60 * 60 * 1000;
  const servicesStatusCache = new Map(); // id -> { url, checkedAt, status }
  async function probeServiceById(id) {
    const state = await servicesStore.list();
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return null;
    const status = await checkService(item.url);
    servicesStatusCache.set(id, { url: item.url, checkedAt: new Date().toISOString(), status });
    return status;
  }
  async function servicesWithStatus() {
    const state = await servicesStore.list();
    const now = Date.now();
    const expired = (meta) => now - new Date(meta.checkedAt).getTime() > PROBE_TTL_MS;
    await Promise.all(state.items.map(async (item) => {
      const cached = servicesStatusCache.get(item.id);
      if (!cached || expired(cached) || cached.url !== item.url) {
        servicesStatusCache.set(item.id, {
          url: item.url,
          checkedAt: new Date().toISOString(),
          status: await checkService(item.url),
        });
      }
    }));
    for (const key of [...servicesStatusCache.keys()]) {
      if (!state.items.some((item) => item.id === key)) servicesStatusCache.delete(key);
    }
    return {
      updatedAt: state.updatedAt,
      total: state.items.length,
      items: state.items.map((item) => ({
        id: item.id,
        name: item.name,
        url: item.url,
        note: item.note,
        status: servicesStatusCache.get(item.id)?.status ?? null,
        probedAt: servicesStatusCache.get(item.id)?.checkedAt ?? null,
      })),
    };
  }
  // 服务器探测缓存：host -> { key, checkedAt, status }
  const serversStatusCache = new Map();
  async function serversWithStatus() {
    const items = await serversRegistry.list();
    const now = Date.now();
    await Promise.all(items.map(async (item) => {
      const target = item.hostName ?? item.host;
      const cached = serversStatusCache.get(item.host);
      const stale = !cached
        || now - new Date(cached.checkedAt).getTime() > PROBE_TTL_MS
        || cached.key !== `${target}:${item.port ?? 22}`;
      if (stale) {
        serversStatusCache.set(item.host, {
          key: `${target}:${item.port ?? 22}`,
          checkedAt: new Date().toISOString(),
          status: await probeServer({ hostName: target, port: Number(item.port) || 22 }),
        });
      }
    }));
    return {
      total: items.length,
      items: items.map((item) => {
        const cached = serversStatusCache.get(item.host);
        return {
          host: item.host,
          hostName: item.hostName,
          user: item.user,
          port: item.port,
          source: item.source,
          profiles: item.profiles,
          status: cached?.status ?? null,
          probedAt: cached?.checkedAt ?? null,
        };
      }),
    };
  }
  const coachPrompt = createCoachPromptRepository({ vaultRoot });
  const reviewSchedule = createReviewScheduleRepository({ vaultRoot });
  const dailyReview = createDailyReviewService({
    marketService: marketData,
    loadConfig: () => loadDailyReviewConfig(workbenchRoot),
    readAlerts: () => readWatchdogState("alerts", { items: [] }),
    eventsRepo: reviewEvents,
    reviewStore: dailyReviewStore,
    portfolioRepo,
    newsService: stockNews,
    sentimentService,
  });
  const readerExplanations = readerExplanationService ??
    createReaderExplanationsService({ vaultRoot });
  const vaultSync = createVaultSyncService({ vaultRoot });
  const currentIndex = () => vaultSync.currentIndex();
  const refreshIndex = (options = {}) => vaultSync.refresh({
    reason: "manual",
    ...options,
  });

  async function indexedReaderDocument(documentId) {
    const careerPath = careerRelativePathFromId(documentId);
    if (careerPath) {
      const careerDoc = await readCareerDocument(careerVaultRoot, careerPath);
      if (!careerDoc) {
        const error = new Error("文档不存在。");
        error.code = "DOCUMENT_NOT_FOUND";
        throw error;
      }
      const body = careerDoc.body ?? readerBodyFromContent(careerDoc.content);
      return {
        id: careerDoc.id,
        relativePath: careerDoc.relativePath,
        title: careerDoc.title,
        layer: careerDoc.layer,
        kind: careerDoc.kind,
        section: null,
        status: careerDoc.status,
        type: careerDoc.type,
        contentType: careerDoc.contentType,
        updatedAt: careerDoc.updatedAt,
        body,
        contentHash: typeof body === "string" ? hashReaderDocumentContent(body) : null,
        headings: careerDoc.headings ?? [],
        wikiLinks: careerDoc.wikiLinks ?? [],
      };
    }
      const obsidianPath = obsidianRelativePathFromId(documentId);
      if (obsidianPath) {
        const obsidianDoc = await readObsidianDocument(obsidianVaultRoot, obsidianPath);
        if (!obsidianDoc) {
          const error = new Error("文档不存在。");
          error.code = "DOCUMENT_NOT_FOUND";
          throw error;
        }
        const body = obsidianDoc.body ?? readerBodyFromContent(obsidianDoc.content);
        return {
          id: obsidianDoc.id,
          relativePath: obsidianDoc.relativePath,
          title: obsidianDoc.title,
          layer: obsidianDoc.layer,
          kind: obsidianDoc.kind,
          section: obsidianDoc.section,
          status: obsidianDoc.status,
          type: obsidianDoc.type,
          contentType: obsidianDoc.contentType,
          updatedAt: obsidianDoc.updatedAt,
          body,
          contentHash: typeof body === "string" ? hashReaderDocumentContent(body) : null,
          headings: obsidianDoc.headings ?? [],
          wikiLinks: obsidianDoc.wikiLinks ?? [],
        };
      }
      const document = documentPayload(await currentIndex(), documentId);
      if (!document) {
        const error = new Error("文档不存在。");
        error.code = "DOCUMENT_NOT_FOUND";
        throw error;
      }
      return document;
    }

  async function freshIndexedReaderDocument(documentId) {
    const indexed = await indexedReaderDocument(documentId);
    if (typeof indexed.body !== "string") {
      const error = new Error("当前文档没有可可靠读取的文本正文。");
      error.code = "INVALID_DOCUMENT_BODY";
      throw error;
    }
    const validated = await validateVaultSelections([indexed.relativePath], {
      vaultRoot,
    });
    const selected = validated.selections[0];
    if (!selected || selected.kind !== "file") {
      const error = new Error("当前文档路径无法重新读取。");
      error.code = "DOCUMENT_NOT_FOUND";
      throw error;
    }
    const content = await readFile(selected.absolutePath, "utf8");
    const body = readerBodyFromContent(content);
    return {
      ...indexed,
      relativePath: selected.relativePath,
      content,
      body,
      contentHash: hashReaderDocumentContent(body),
    };
  }

  function queueReaderNoteMutation(operation) {
    const result = readerNoteApiMutationQueue.then(operation, operation);
    readerNoteApiMutationQueue = result.catch(() => {});
    return result;
  }

  function saveOneReaderNote(
    document,
    note,
    { allowCodexExplanation = false } = {},
  ) {
    return queueReaderNoteMutation(async () => {
      const existing = await readerNotes.get(document.id);
      const previousNotes = existing?.notes ?? [];
      const existingIndex = note?.id
        ? previousNotes.findIndex((item) => item.id === note.id)
        : -1;
      const previousNote = existingIndex >= 0 ? previousNotes[existingIndex] : null;
      if (!allowCodexExplanation && previousNote?.origin === "codex-explanation") {
        const error = new Error("AI 阅读辅助保持原始归属，不能通过普通笔记接口改写。");
        error.code = "RESERVED_READER_NOTE";
        throw error;
      }
      if (
        allowCodexExplanation &&
        previousNote &&
        (
          previousNote.origin !== "codex-explanation" ||
          previousNote.sourceAnalysisId !== note?.sourceAnalysisId
        )
      ) {
        const error = new Error("解释笔记 ID 已被其他笔记占用，已停止保存。");
        error.code = "READER_EXPLANATION_NOTE_ID_CONFLICT";
        throw error;
      }
      const nextNotes = [...previousNotes];
      if (existingIndex >= 0) nextNotes[existingIndex] = note;
      else nextNotes.push(note);

      const previousIds = new Set(previousNotes.map((item) => item.id));
      const saved = await readerNotes.save({
        documentId: document.id,
        relativePath: document.relativePath,
        title: document.title,
        contentHash: document.contentHash,
        notes: nextNotes,
      });
      const savedNote = note?.id
        ? saved.notes.find((item) => item.id === note.id)
        : saved.notes.find((item) => !previousIds.has(item.id));
      return { saved, savedNote: savedNote ?? null };
    });
  }

  function deleteOneReaderNote(document, noteId) {
    return queueReaderNoteMutation(async () => {
      const existing = await readerNotes.get(document.id);
      const nextNotes = (existing?.notes ?? []).filter((note) => note.id !== noteId);
      if (!existing || nextNotes.length === existing.notes.length) return false;
      if (nextNotes.length === 0) {
        await readerNotes.delete(document.id);
      } else {
        await readerNotes.save({
          ...existing,
          title: document.title,
          relativePath: document.relativePath,
          contentHash: document.contentHash,
          notes: nextNotes,
        });
      }
      return true;
    });
  }

  function snapshotReaderNotes(document, snapshotId) {
    return queueReaderNoteMutation(async () => {
      const existing = await readerNotes.get(document.id);
      const saved = await readerNotes.save({
        documentId: document.id,
        relativePath: document.relativePath,
        title: document.title,
        contentHash: document.contentHash,
        notes: existing?.notes ?? [],
      });
      return createIngestSnapshot(saved, saved.notes, {
        vaultRoot,
        jobId: snapshotId,
      });
    });
  }

  function refreshWhenIngestFinishes(jobId) {
    let unsubscribe = () => {};
    unsubscribe = wikiIngest.subscribeJob(jobId, (job) => {
      if (
        ![
          WIKI_INGEST_STATUS.COMPLETED,
          WIKI_INGEST_STATUS.FAILED,
          WIKI_INGEST_STATUS.CANCELLED,
        ].includes(job.status)
      ) {
        return;
      }
      queueMicrotask(async () => {
        unsubscribe();
        if (job.status === WIKI_INGEST_STATUS.COMPLETED) {
          await refreshIndex({
            reason: "wiki-ingest",
            paths: ["wiki"],
          }).catch(() => {});
        }
      });
    });
  }

  // 收盘后自动生成「AI 每日总结」：常驻调度（交易日 ≥15:05 触发一次；
  // 当日已有收盘版则跳过，避免覆盖手动生成；失败仅记日志，当日不重试）。
  let autoReviewDoneDate = null;
  let autoReviewRunning = false;
  async function runAutoReview() {
    if (autoReviewRunning) return;
    // 调度配置每 tick 重读：页面改开关/时间即时生效（独立于盯盘配置）。
    const schedule = await reviewSchedule.get();
    if (!schedule.enabled) return;
    const at = new Date();
    const day = at.getDay();
    if (day === 0 || day === 6) return;
    const [hh, mm] = schedule.time.split(":").map(Number);
    if (at.getHours() * 100 + at.getMinutes() < hh * 100 + mm) return;
    const date = at.toISOString().slice(0, 10);
    if (autoReviewDoneDate === date) return;
    autoReviewRunning = true;
    try {
      if (await dailyReviewStore.get(date, "close")) {
        console.log(`[workbench] 收盘总结已存在（手动生成过），跳过自动生成：${date}`);
        autoReviewDoneDate = date;
        return;
      }
      const pool = await stockPool.pool(await stockCodes.overrides());
      const stocks = pool
        .filter((item) => item.code)
        .map(({ name, code, note }) => ({ name, code, note }));
      const context = await dailyReview.collectReviewContext(date, stocks);
      const { prompt: promptTemplate } = await coachPrompt.get();
      const started = await stockAnalysis.startCoachReview(context, { promptTemplate });
      // 轮询上限须覆盖 LLM 最坏情况：单次 10 分钟 + 重试 1 次 = 20 分钟。
      const deadline = Date.now() + 22 * 60_000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const task = stockAnalysis.get(started.id);
        if (task?.status === "completed") {
          await dailyReviewStore.save(date, {
            stockCount: stocks.length,
            session: "close",
            review: task.result,
          });
          vaultSync.notifyPaths([DAILY_REVIEW_PATH]);
          console.log(`[workbench] 收盘自动总结完成：${date}（${stocks.length} 只关注股）`);
          break;
        }
        if (task?.status === "failed" || Date.now() > deadline) {
          console.log(`[workbench] 收盘自动总结未完成：${task?.error?.message ?? "等待超时"}`);
          break;
        }
      }
    } catch (error) {
      console.log(`[workbench] 收盘自动总结失败：${error?.message ?? error}`);
    } finally {
      autoReviewRunning = false;
      autoReviewDoneDate = date;
    }
  }

  return {
    name: "personal-kb-workbench-api",
    async closeBundle() {
      await vaultSync.close();
      await readerExplanations.close?.();
    },
    configureServer(server) {
      vaultSync.attachWatcher(server.watcher);
      // 收盘后自动生成「AI 每日总结」：每分钟检查，到点（默认 15:05，可配）触发一次；
      // 当日已有收盘版（手动生成过）则跳过，避免覆盖。
      // unref：定时器不阻止进程退出（测试环境 instantiate 插件后能正常收尾）。
      const autoReviewTimer = setInterval(() => {
        void runAutoReview().catch(() => {});
      }, 60_000);
      autoReviewTimer.unref?.();
      server.httpServer?.once("close", () => {
        clearInterval(autoReviewTimer);
        void vaultSync.close();
      });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (!url.pathname.startsWith("/api/")) return next();

        try {
          assertLocalMutationRequest(req);
          if (
            url.pathname.startsWith("/api/brainstorm/") ||
            url.pathname === "/api/public-account/dashboard"
          ) {
            return json(res, 404, {
              code: "FEATURE_NOT_INCLUDED",
              message: "该模块未包含在公开版中。",
            });
          }
          if (req.method === "GET" && url.pathname === "/api/vault/events") {
            res.writeHead(200, {
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream; charset=utf-8",
              "X-Accel-Buffering": "no",
            });
            res.write(": connected\n\n");
            const unsubscribe = vaultSync.subscribe((event) => {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            req.on("close", unsubscribe);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/vault/sync") {
            return json(res, 200, vaultSync.getStatus());
          }

          if (req.method === "GET" && url.pathname === "/api/overview") {
            return json(res, 200, overviewPayload(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/config/attention") {
            return json(res, 200, await loadAttentionStrategy(workbenchRoot));
          }

          if (req.method === "GET" && url.pathname === "/api/materials") {
            const [current, readingState] = await Promise.all([
              currentIndex(),
              materialReadingState.list(),
            ]);
            return json(res, 200, materialsHomePayload(current, readingState));
          }

          if (req.method === "GET" && url.pathname === "/api/books") {
            return json(res, 200, booksPayload(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/materials/folder") {
            const [current, readingState] = await Promise.all([
              currentIndex(),
              materialReadingState.list(),
            ]);
            return json(
              res,
              200,
              materialFolderPayload(
                current,
                readingState,
                url.searchParams.get("path") || "10_raw",
              ),
            );
          }

          if (req.method === "GET" && url.pathname === "/api/material-reading-queue") {
            const [current, readingState] = await Promise.all([
              currentIndex(),
              materialReadingState.list(),
            ]);
            return json(res, 200, materialReadingQueuePayload(current, readingState));
          }

          if (req.method === "POST" && url.pathname === "/api/material-reading-queue") {
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["documentId", "contentHash"]),
              "INVALID_MATERIAL_READING_REQUEST",
            );
            const document = await indexedReaderDocument(body.documentId);
            if (document.layer !== "raw") {
              const error = new Error("只有素材层文档可以加入待看。");
              error.code = "INVALID_MATERIAL_DOCUMENT";
              throw error;
            }
            if (
              body.contentHash != null &&
              document.contentHash != null &&
              body.contentHash !== document.contentHash
            ) {
              const error = new Error("素材内容已经变化，请载入最新版本后再加入待看。");
              error.code = "CONTENT_HASH_MISMATCH";
              throw error;
            }
            const item = await materialReadingState.add({
              id: document.id,
              relativePath: document.relativePath,
              contentHash: document.contentHash,
              contentFingerprint: `${document.sizeBytes ?? "unknown"}:${document.modifiedAt ?? "unknown"}`,
            });
            vaultSync.notifyPaths([MATERIAL_READING_STATE_PATH]);
            return json(res, 200, item);
          }

          const materialQueueMatch = url.pathname.match(
            /^\/api\/material-reading-queue\/([^/]+)$/,
          );
          if (req.method === "DELETE" && materialQueueMatch) {
            const documentId = decodeURIComponent(materialQueueMatch[1]);
            const removed = await materialReadingState.remove({ documentId });
            if (removed) vaultSync.notifyPaths([MATERIAL_READING_STATE_PATH]);
            return json(res, 200, { removed });
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/collections/")) {
            const kind = decodeURIComponent(url.pathname.slice("/api/collections/".length));
            if (kind === "wiki" && obsidianVaultRoot) {
              return json(res, 200, await obsidianWikiPayload(obsidianVaultRoot));
            }
            return json(res, 200, collectionPayload(await currentIndex(), kind));
          }

          if (req.method === "GET" && url.pathname === "/api/search") {
            const query = url.searchParams.get("q") ?? "";
            const items = searchIndex(await currentIndex(), query, requestFilters(url));
            return json(res, 200, { query, total: items.length, items });
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/vault-images/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/vault-images/".length));
            const current = await currentIndex();
            return serveVaultImage(res, current, vaultRoot, id);
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/reader-images/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/reader-images/".length));
            const current = await currentIndex();
            return serveReaderImage(
              res,
              current,
              vaultRoot,
              id,
              url.searchParams.get("src"),
            );
          }

          if (req.method === "GET" && url.pathname.startsWith("/api/documents/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/documents/".length));
            // 求职备战文档来自外部 Obsidian，带 `career-` 前缀时走独立读取器。
            const careerPath = careerRelativePathFromId(id);
            if (careerPath) {
              const careerDoc = await readCareerDocument(careerVaultRoot, careerPath);
              if (!careerDoc) return json(res, 404, { error: { message: "文档不存在。" } });
              const body = careerDoc.body ?? readerBodyFromContent(careerDoc.content);
              const outgoingLinks = (careerDoc.wikiLinks ?? [])
                .filter((link) => link.resolvedId)
                .map((link) => ({
                  id: link.resolvedId,
                  title: link.label || link.target,
                }));
              return json(res, 200, {
                id: careerDoc.id,
                relativePath: careerDoc.relativePath,
                title: careerDoc.title,
                layer: careerDoc.layer,
                kind: careerDoc.kind,
                section: null,
                status: careerDoc.status,
                type: careerDoc.type,
                contentType: careerDoc.contentType,
                updatedAt: careerDoc.updatedAt,
                body,
                contentHash: typeof body === "string" ? hashReaderDocumentContent(body) : null,
                headings: careerDoc.headings ?? [],
                wikiLinks: careerDoc.wikiLinks ?? [],
                outgoingLinks,
              });
            }
            // 知识本体文档（知识星图/Wiki 层）来自外部 Obsidian，带 `obsidian-` 前缀。
            const obsidianPath = obsidianRelativePathFromId(id);
            if (obsidianPath) {
              const obsidianDoc = await readObsidianDocument(obsidianVaultRoot, obsidianPath);
              if (!obsidianDoc) return json(res, 404, { error: { message: "文档不存在。" } });
              const body = obsidianDoc.body ?? readerBodyFromContent(obsidianDoc.content);
              const outgoingLinks = (obsidianDoc.wikiLinks ?? [])
                .filter((link) => link.resolvedId)
                .map((link) => ({
                  id: link.resolvedId,
                  title: link.label || link.target,
                }));
              return json(res, 200, {
                id: obsidianDoc.id,
                relativePath: obsidianDoc.relativePath,
                title: obsidianDoc.title,
                layer: obsidianDoc.layer,
                kind: obsidianDoc.kind,
                section: obsidianDoc.section,
                status: obsidianDoc.status,
                type: obsidianDoc.type,
                contentType: obsidianDoc.contentType,
                updatedAt: obsidianDoc.updatedAt,
                body,
                contentHash: typeof body === "string" ? hashReaderDocumentContent(body) : null,
                headings: obsidianDoc.headings ?? [],
                wikiLinks: obsidianDoc.wikiLinks ?? [],
                outgoingLinks,
              });
            }
            const document = documentPayload(await currentIndex(), id);
            if (!document) return json(res, 404, { error: { message: "文档不存在。" } });
            return json(res, 200, document);
          }

          if (req.method === "GET" && url.pathname === "/api/reader-notes") {
            const documentId = url.searchParams.get("documentId") ?? "";
            const document = await indexedReaderDocument(documentId);
            const saved = await readerNotes.get(document.id);
            const notes = saved?.notes ?? [];
            return json(res, 200, {
              documentId: document.id,
              relativePath: document.relativePath,
              title: document.title,
              contentHash: document.contentHash,
              notes,
              items: notes,
              updatedAt: saved?.updatedAt ?? null,
            });
          }

          if (req.method === "POST" && url.pathname === "/api/reader-notes") {
            const body = await readJson(req, 128 * 1024);
            const document = await indexedReaderDocument(body.documentId);
            const note = body.note && typeof body.note === "object"
              ? Object.fromEntries(
                  Object.entries(body.note).filter(
                    ([key]) => !["origin", "sourceAnalysisId"].includes(key),
                  ),
                )
              : body.note;
            const { saved, savedNote } = await saveOneReaderNote(document, note);
            return json(res, 200, {
              documentId: saved.documentId,
              contentHash: saved.contentHash,
              note: savedNote,
              notes: saved.notes,
              updatedAt: saved.updatedAt,
            });
          }

          const readerNoteMatch = url.pathname.match(/^\/api\/reader-notes\/([^/]+)$/);
          if (req.method === "DELETE" && readerNoteMatch) {
            const noteId = decodeURIComponent(readerNoteMatch[1]);
            const documentId = url.searchParams.get("documentId") ?? "";
            const document = await indexedReaderDocument(documentId);
            if (!(await deleteOneReaderNote(document, noteId))) {
              return json(res, 404, { error: { code: "NOTE_NOT_FOUND", message: "笔记不存在。" } });
            }
            return json(res, 200, { ok: true, documentId: document.id, noteId });
          }

          if (req.method === "GET" && url.pathname === "/api/reader-explanations") {
            const documentId = url.searchParams.get("documentId") ?? "";
            const document = await indexedReaderDocument(documentId);
            const items = await readerExplanations.list(document.id);
            return json(res, 200, {
              documentId: document.id,
              contentHash: document.contentHash,
              items,
              explanations: items,
            });
          }

          if (req.method === "POST" && url.pathname === "/api/reader-explanations") {
            const body = await readJson(req, 128 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["documentId", "contentHash", "quoteText", "anchor", "mode", "question"]),
            );
            const document = await freshIndexedReaderDocument(body.documentId);
            if (body.contentHash !== document.contentHash) {
              const error = new Error("正文已变化，请重新选择需要理解的内容。");
              error.code = "CONTENT_HASH_MISMATCH";
              throw error;
            }
            const explanation = await readerExplanations.start({
              document,
              body: document.body,
              contentHash: body.contentHash,
              quoteText: body.quoteText,
              anchor: body.anchor,
              mode: body.mode,
              question: body.question,
            });
            return json(res, 202, { explanation });
          }

          const readerExplanationMatch = url.pathname.match(
            /^\/api\/reader-explanations\/([^/]+)(?:\/(follow-up|save-note))?$/,
          );
          if (readerExplanationMatch) {
            const analysisId = decodeURIComponent(readerExplanationMatch[1]);
            const action = readerExplanationMatch[2] || "read";

            if (req.method === "GET" && action === "read") {
              const documentId = url.searchParams.get("documentId") ?? "";
              const document = await indexedReaderDocument(documentId);
              const explanation = await readerExplanations.get(analysisId);
              if (readerExplanationDocumentId(explanation) !== document.id) {
                const error = new Error("解释记录不属于当前文档。");
                error.code = "EXPLANATION_NOT_FOUND";
                throw error;
              }
              return json(res, 200, {
                explanation,
              });
            }

            if (req.method === "POST" && action === "follow-up") {
              const body = await readJson(req, 32 * 1024);
              assertAllowedObjectKeys(
                body,
                new Set(["documentId", "contentHash", "mode", "question"]),
              );
              const document = await freshIndexedReaderDocument(body.documentId);
              if (body.contentHash !== document.contentHash) {
                const error = new Error("正文已变化，请重新选择内容后再提问。");
                error.code = "CONTENT_HASH_MISMATCH";
                throw error;
              }
              const explanation = await readerExplanations.followUp(analysisId, {
                document,
                body: document.body,
                contentHash: body.contentHash,
                mode: body.mode,
                question: body.question,
              });
              return json(res, 202, { explanation });
            }

            if (req.method === "POST" && action === "save-note") {
              const body = await readJson(req, 32 * 1024);
              assertAllowedObjectKeys(
                body,
                new Set(["documentId", "contentHash"]),
              );
              const document = await freshIndexedReaderDocument(body.documentId);
              const explanation = await readerExplanations.get(analysisId);
              if (readerExplanationDocumentId(explanation) !== document.id) {
                const error = new Error("解释记录不属于当前文档。");
                error.code = "INVALID_READER_EXPLANATION_DOCUMENT";
                throw error;
              }
              const explanationRecords = await readerExplanations.list(document.id);
              const thread = readerExplanationThread(explanationRecords, analysisId);
              const completedThread = thread.filter((record) =>
                record.status === "completed" && record.result,
              );
              const root = thread[0] || explanation;
              if (
                body.contentHash !== document.contentHash ||
                completedThread.some((record) => record.contentHash !== document.contentHash)
              ) {
                const error = new Error("正文已变化，请重新选择原文并生成解释后再保存。");
                error.code = "READER_EXPLANATION_SOURCE_CHANGED";
                throw error;
              }
              if (!completedThread.length || root.status !== "completed" || !root.result) {
                const error = new Error("本轮对话尚未形成完整回答，暂时不能保存到笔记。");
                error.code = "READER_EXPLANATION_NOT_COMPLETED";
                throw error;
              }

              const noteId = root.savedNoteId || `explanation-thread-${String(root.id)
                .replace(/[^A-Za-z0-9_-]/g, "-")
                .slice(0, 104)}`;
              const { savedNote } = await saveOneReaderNote(
                document,
                {
                  id: noteId,
                  type: "quote",
                  body: renderReaderExplanationNote(completedThread),
                  quoteText: root.quoteText,
                  anchor: root.anchor,
                  origin: "codex-explanation",
                  sourceAnalysisId: root.id,
                },
                { allowCodexExplanation: true },
              );
              const savedNoteId = savedNote?.id || noteId;
              const markedThread = typeof readerExplanations.markThreadSaved === "function"
                ? await readerExplanations.markThreadSaved(
                    completedThread.map((record) => record.id),
                    savedNoteId,
                  )
                : await Promise.all(completedThread.map((record) =>
                    readerExplanations.markSaved(record.id, savedNoteId),
                  ));
              const marked = markedThread.at(-1) || root;
              return json(res, 200, {
                analysisId: root.id,
                requestedAnalysisId: analysisId,
                savedNoteId,
                note: savedNote,
                explanation: marked,
                explanations: markedThread,
              });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/wiki-ingest") {
            const body = await readJson(req);
            const document = await indexedReaderDocument(body.documentId);
            if (document.layer !== "raw") {
              const error = new Error("只有素材层（10_raw）的文档可以进入正式 Wiki Ingest。");
              error.code = "INVALID_INGEST_SOURCE";
              throw error;
            }
            if (typeof document.body !== "string" || !document.body.trim()) {
              const error = new Error("当前来源没有可可靠读取的文本正文，不能开始入库评估。");
              error.code = "INVALID_INGEST_SOURCE";
              throw error;
            }

            const snapshotId = `ingest-${randomUUID()}`;
            const snapshot = await snapshotReaderNotes(document, snapshotId);
            const job = await wikiIngest.startPlan({
              rawPath: document.relativePath,
              notesPath: snapshot.relativePath,
            });
            return json(res, 202, {
              ...job,
              notesSnapshotPath: snapshot.relativePath,
              noteCount: snapshot.noteCount,
            });
          }

          if (req.method === "GET" && url.pathname === "/api/wiki-ingest/jobs") {
            return json(res, 200, { items: wikiIngest.listJobs() });
          }

          if (req.method === "GET" && url.pathname === "/api/wiki-ingest/recovery") {
            const document = await indexedReaderDocument(
              url.searchParams.get("documentId"),
            );
            if (document.layer !== "raw") {
              const error = new Error("只有素材层（10_raw）的文档可以恢复 Wiki Ingest 任务。");
              error.code = "INVALID_INGEST_SOURCE";
              throw error;
            }
            const handoff = await wikiIngest.findClientHandoff(document.relativePath);
            return json(res, 200, { handoff });
          }

          const wikiIngestMatch = url.pathname.match(
            /^\/api\/wiki-ingest\/jobs\/([^/]+)(?:\/(events|message|handoff|confirm|cancel))?$/,
          );
          if (wikiIngestMatch) {
            const jobId = decodeURIComponent(wikiIngestMatch[1]);
            const action = wikiIngestMatch[2] || "read";
            if (req.method === "GET" && action === "read") {
              return json(res, 200, wikiIngest.getJob(jobId));
            }
            if (req.method === "POST" && action === "message") {
              const body = await readJson(req, 32 * 1024);
              const job = body.kind === "query"
                ? wikiIngest.queryJob(jobId, { message: body.message })
                : wikiIngest.reviseJob(jobId, { message: body.message });
              return json(res, 202, job);
            }
            if (req.method === "POST" && action === "confirm") {
              const body = await readJson(req, 256 * 1024);
              const job = await wikiIngest.confirmJob(jobId, body);
              refreshWhenIngestFinishes(jobId);
              return json(res, 202, job);
            }
            if (req.method === "POST" && action === "handoff") {
              const body = await readJson(req, 32 * 1024);
              const job = await wikiIngest.createClientHandoffJob(jobId, body);
              return json(res, 201, job);
            }
            if (req.method === "POST" && action === "cancel") {
              return json(res, 200, wikiIngest.cancelJob(jobId));
            }
            if (req.method === "GET" && action === "events") {
              // Validate the in-memory job before committing SSE headers. After
              // a local server restart the browser may briefly retain an old
              // job id; a normal JSON 404 lets the client recover, while
              // throwing after writeHead would crash the dev server with
              // ERR_HTTP_HEADERS_SENT.
              wikiIngest.getJob(jobId);
              res.writeHead(200, {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream; charset=utf-8",
                "X-Accel-Buffering": "no",
              });
              res.write(": connected\n\n");
              let unsubscribe = () => {};
              unsubscribe = wikiIngest.subscribeJob(jobId, (job) => {
                res.write(`data: ${JSON.stringify(job)}\n\n`);
                if (
                  [
                    WIKI_INGEST_STATUS.AWAITING_REVIEW,
                    WIKI_INGEST_STATUS.HANDOFF_READY,
                    WIKI_INGEST_STATUS.COMPLETED,
                    WIKI_INGEST_STATUS.FAILED,
                    WIKI_INGEST_STATUS.CANCELLED,
                  ].includes(job.status)
                ) {
                  queueMicrotask(() => {
                    unsubscribe();
                    res.end();
                  });
                }
              });
              req.on("close", unsubscribe);
              return;
            }
          }

          if (req.method === "GET" && url.pathname === "/api/graph") {
            if (obsidianVaultRoot) {
              return json(res, 200, await obsidianGraphPayload(obsidianVaultRoot));
            }
            return json(res, 200, graphPayload(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/douyin/works") {
            const current = await currentIndex();
            return json(res, 200, {
              generatedAt: current.generatedAt,
              total: current.douyin.works.length,
              items: current.douyin.works,
              comparableCount: current.douyin.comparableCount,
              summary: current.douyin.summary,
              summaryLowerBounds: current.douyin.summaryLowerBounds,
              contentLines: current.douyin.contentLines,
              formats: current.douyin.formats,
              roles: current.douyin.roles,
              monthly: current.douyin.monthly,
              reviewStatusCounts: current.douyin.reviewStatusCounts,
              available: current.douyin.available === true,
              sourcePath: current.douyin.sourcePath,
              sourceUpdatedAt: current.douyin.updatedAt,
              range: current.douyin.range,
              qualityIssues: current.douyin.qualityIssues,
              qualityFlags: current.douyin.qualityFlags,
              analytics: current.douyin.analytics,
              demoMode: current.douyin.demoMode === true,
            });
          }

          if (req.method === "GET" && url.pathname === "/api/social-insights") {
            return json(res, 200, listSocialInsights(await currentIndex()));
          }

          if (req.method === "GET" && url.pathname === "/api/career") {
            return json(res, 200, await careerPayload(careerVaultRoot));
          }

          if (req.method === "GET" && url.pathname === "/api/stock-universe") {
            return json(res, 200, stockUniversePayload(await stockCodes.overrides()));
          }

          if (req.method === "GET" && url.pathname === "/api/stock-codes") {
            const codes = await stockCodes.list();
            return json(res, 200, {
              updatedAt: codes.updatedAt,
              items: codes.items,
            });
          }

          if (req.method === "GET" && url.pathname === "/api/services") {
            return json(res, 200, await servicesWithStatus());
          }

          if (req.method === "POST" && url.pathname === "/api/services/probe") {
            const body = await readJson(req, 1_000).catch(() => null);
            const status = await probeServiceById(String(body?.id ?? ""));
            if (!status) return json(res, 404, { error: { code: "NOT_FOUND", message: "服务不存在" } });
            return json(res, 200, { status, probedAt: new Date().toISOString() });
          }

          if (req.method === "GET" && url.pathname === "/api/servers") {
            return json(res, 200, await serversWithStatus());
          }

          if (req.method === "GET" && url.pathname === "/api/system/disks") {
            try {
              return json(res, 200, await disksMonitor.list());
            } catch (error) {
              return json(res, 502, { error: { code: "DISK_FAILED", message: error?.message ?? "读取磁盘信息失败" } });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/system/disks/refresh") {
            try {
              return json(res, 200, await disksMonitor.refresh());
            } catch (error) {
              return json(res, 502, { error: { code: "DISK_FAILED", message: error?.message ?? "读取磁盘信息失败" } });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/system/disks/dirs") {
            const body = await readJson(req, 500).catch(() => null);
            const mount = String(body?.mount ?? "");
            try {
              const { items } = await disksMonitor.list();
              return json(res, 200, disksMonitor.startDirAnalysis(mount, items.map((disk) => disk.mount)));
            } catch (error) {
              return json(res, 400, { error: { code: "BAD_REQUEST", message: error?.message ?? "启动分析失败" } });
            }
          }

          if (req.method === "GET" && url.pathname === "/api/system/disks/dirs") {
            const mount = url.searchParams.get("mount") ?? "";
            const result = disksMonitor.getDirAnalysis(mount);
            if (!result) return json(res, 404, { error: { code: "NOT_FOUND", message: "尚未分析" } });
            return json(res, 200, result);
          }

          if (req.method === "POST" && url.pathname === "/api/servers/probe") {
            const body = await readJson(req, 1_000).catch(() => null);
            const host = String(body?.host ?? "");
            const items = await serversRegistry.list();
            const item = items.find((entry) => entry.host === host);
            if (!item) return json(res, 404, { error: { code: "NOT_FOUND", message: "主机不在 ssh 配置中" } });
            const status = await probeServer({ hostName: item.hostName ?? item.host, port: Number(item.port) || 22 });
            serversStatusCache.set(host, {
              key: `${item.hostName ?? item.host}:${item.port ?? 22}`,
              checkedAt: new Date().toISOString(),
              status,
            });
            return json(res, 200, { status, probedAt: new Date().toISOString() });
          }

          if (req.method === "POST" && url.pathname === "/api/servers/open") {
            const body = await readJson(req, 1_000).catch(() => null);
            try {
              return json(res, 200, await openItermSsh(String(body?.host ?? "")));
            } catch (error) {
              return json(res, 400, { error: { code: "OPEN_FAILED", message: error?.message ?? "打开失败" } });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/services") {
            const body = await readJson(req, 4 * 1024);
            assertAllowedObjectKeys(body, new Set(["name", "url", "note"]), "INVALID_SERVICES_REQUEST");
            try {
              const { item } = await servicesStore.add(body);
              vaultSync.notifyPaths([servicesStore.filePath]);
              return json(res, 200, item);
            } catch (error) {
              return json(res, 400, { error: { code: "INVALID_SERVICES_REQUEST", message: error?.message ?? "保存失败" } });
            }
          }

          const servicesMatch = url.pathname.match(/^\/api\/services\/([^/]+)$/);
          if (servicesMatch) {
            const id = decodeURIComponent(servicesMatch[1]);
            if (req.method === "PUT") {
              const body = await readJson(req, 4 * 1024);
              assertAllowedObjectKeys(body, new Set(["name", "url", "note"]), "INVALID_SERVICES_REQUEST");
              try {
                const result = await servicesStore.update(id, body);
                if (!result) return json(res, 404, { error: { code: "NOT_FOUND", message: "服务不存在" } });
                vaultSync.notifyPaths([servicesStore.filePath]);
                return json(res, 200, result.item);
              } catch (error) {
                return json(res, 400, { error: { code: "INVALID_SERVICES_REQUEST", message: error?.message ?? "更新失败" } });
              }
            }
            if (req.method === "DELETE") {
              const removed = await servicesStore.remove(id);
              if (removed) vaultSync.notifyPaths([servicesStore.filePath]);
              return json(res, 200, { removed });
            }
          }

          if (req.method === "PUT" && url.pathname === "/api/stock-codes") {
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["name", "code"]),
              "INVALID_STOCK_CODES_REQUEST",
            );
            const item = await stockCodes.set(body.name, body.code);
            vaultSync.notifyPaths([STOCK_CODES_PATH]);
            return json(res, 200, item);
          }

          const stockCodesMatch = url.pathname.match(/^\/api\/stock-codes\/([^/]+)$/);
          if (req.method === "DELETE" && stockCodesMatch) {
            const name = decodeURIComponent(stockCodesMatch[1]);
            const removed = await stockCodes.remove(name);
            if (removed) vaultSync.notifyPaths([STOCK_CODES_PATH]);
            return json(res, 200, { removed });
          }

          if (req.method === "GET" && url.pathname === "/api/stock-watchlist") {
            const watchlist = await stockWatchlist.list();
            return json(res, 200, {
              updatedAt: watchlist.updatedAt,
              total: watchlist.items.length,
              items: watchlist.items,
            });
          }

          if (req.method === "POST" && url.pathname === "/api/stock-watchlist") {
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["name", "group", "note"]),
              "INVALID_STOCK_WATCHLIST_REQUEST",
            );
            const item = await stockWatchlist.add(body.name, {
              group: body.group,
              note: body.note,
            });
            vaultSync.notifyPaths([STOCK_WATCHLIST_PATH]);
            return json(res, 200, item);
          }

          const stockWatchlistMatch = url.pathname.match(
            /^\/api\/stock-watchlist\/([^/]+)$/,
          );
          if (req.method === "PUT" && stockWatchlistMatch) {
            const name = decodeURIComponent(stockWatchlistMatch[1]);
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["group", "note"]),
              "INVALID_STOCK_WATCHLIST_REQUEST",
            );
            const item = await stockWatchlist.updateMeta(name, {
              group: body.group,
              note: body.note,
            });
            if (!item) return json(res, 404, { error: { message: "该股尚未关注。" } });
            vaultSync.notifyPaths([STOCK_WATCHLIST_PATH]);
            return json(res, 200, item);
          }
          if (req.method === "DELETE" && stockWatchlistMatch) {
            const name = decodeURIComponent(stockWatchlistMatch[1]);
            const removed = await stockWatchlist.remove(name);
            if (removed) vaultSync.notifyPaths([STOCK_WATCHLIST_PATH]);
            return json(res, 200, { removed });
          }

          if (req.method === "GET" && url.pathname === "/api/stock-research") {
            const research = await stockResearch.list();
            return json(res, 200, {
              updatedAt: research.updatedAt,
              total: research.reports.length,
              reports: research.reports,
            });
          }

          const stockResearchMatch = url.pathname.match(
            /^\/api\/stock-research\/([^/]+)$/,
          );
          if (req.method === "PUT" && stockResearchMatch) {
            const name = decodeURIComponent(stockResearchMatch[1]);
            const body = await readJson(req, 512 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["generatedAt", "report"]),
              "INVALID_STOCK_RESEARCH_REQUEST",
            );
            const entry = await stockResearch.save(name, {
              generatedAt: body.generatedAt,
              report: body.report,
            });
            vaultSync.notifyPaths([STOCK_RESEARCH_PATH]);
            return json(res, 200, entry);
          }
          if (req.method === "DELETE" && stockResearchMatch) {
            const name = decodeURIComponent(stockResearchMatch[1]);
            const removed = await stockResearch.remove(name);
            if (removed) vaultSync.notifyPaths([STOCK_RESEARCH_PATH]);
            return json(res, 200, { removed });
          }

          if (req.method === "GET" && url.pathname === "/api/market/quotes") {
            const codes = url.searchParams.getAll("codes");
            const quotes = await marketData.getQuotes(codes);
            return json(res, 200, {
              items: [...quotes.values()],
            });
          }

          // ===== 监控台 v2：股票池 / 财务 / 技术 / 异动 / 盯盘配置 / 估值分位 =====

          if (req.method === "GET" && url.pathname === "/api/stock-pool") {
            const overrides = await stockCodes.overrides();
            const items = await stockPool.pool(overrides);
            return json(res, 200, { generatedAt: new Date().toISOString(), total: items.length, items });
          }

          if (req.method === "POST" && url.pathname === "/api/stock-pool") {
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["name", "code", "chain", "board", "segment", "note"]),
              "INVALID_STOCK_POOL_REQUEST",
            );
            const item = await stockPool.addCustom(body);
            vaultSync.notifyPaths([STOCK_POOL_PATH]);
            return json(res, 200, item);
          }

          const stockPoolMatch = url.pathname.match(/^\/api\/stock-pool\/([^/]+)$/);
          if (req.method === "DELETE" && stockPoolMatch) {
            const name = decodeURIComponent(stockPoolMatch[1]);
            const removed = await stockPool.removeCustom(name);
            if (removed) vaultSync.notifyPaths([STOCK_POOL_PATH]);
            return json(res, 200, { removed });
          }

          if (req.method === "GET" && url.pathname === "/api/stock-financials") {
            const code = url.searchParams.get("code") ?? "";
            if (!/^\d{6}$/.test(code)) {
              return json(res, 400, { error: { message: "股票代码必须是 6 位数字。" } });
            }
            const financials = await stockFinancials.getFinancials(code);
            return json(res, 200, financials);
          }

          if (req.method === "GET" && url.pathname === "/api/stock-technicals") {
            const code = url.searchParams.get("code") ?? "";
            if (!/^\d{6}$/.test(code)) {
              return json(res, 400, { error: { message: "股票代码必须是 6 位数字。" } });
            }
            const klines = await marketData.getDailyKlines(code, 120);
            const ma = computeMA(klines);
            return json(res, 200, {
              code,
              klineCount: klines.length,
              latest: klines.at(-1) ?? null,
              ma,
              trend: maTrend(ma),
            });
          }

          if (req.method === "GET" && url.pathname === "/api/stock-alerts") {
            const alerts = await readWatchdogState("alerts", { items: [] });
            return json(res, 200, {
              updatedAt: alerts.updatedAt ?? null,
              total: (alerts.items ?? []).length,
              items: [...(alerts.items ?? [])].reverse().slice(0, 50),
            });
          }

          if (req.method === "GET" && url.pathname === "/api/watchdog-config") {
            const config = await readWatchdogState("config", {});
            return json(res, 200, {
              pushConfigured: Boolean(serverChanSendKey),
              config: { ...WATCHDOG_DEFAULT_CONFIG, ...config },
            });
          }

          if (req.method === "PUT" && url.pathname === "/api/watchdog-config") {
            const body = await readJson(req, 8 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["enabled", "thresholdPct", "windowMinutes", "cooldownMinutes", "pushEnabled", "dailyPushLimit", "indexEnabled", "indexThresholdPct"]),
              "INVALID_WATCHDOG_CONFIG",
            );
            const current = await readWatchdogState("config", {});
            const next = { ...WATCHDOG_DEFAULT_CONFIG, ...current, ...body };
            await writeWatchdogState("config", next);
            return json(res, 200, { pushConfigured: Boolean(serverChanSendKey), config: next });
          }

          if (req.method === "GET" && url.pathname === "/api/valuation-history") {
            const code = url.searchParams.get("code") ?? "";
            if (!/^\d{6}$/.test(code)) {
              return json(res, 400, { error: { message: "股票代码必须是 6 位数字。" } });
            }
            const history = await readWatchdogState("valuation", {});
            const series = history[code] ?? [];
            const quotesNow = await marketData.getQuotes([code]);
            const quote = quotesNow.get(code) ?? null;
            return json(res, 200, {
              code,
              points: series,
              since: series[0]?.date ?? null,
              current: quote ? { pe: quote.peTtm, pb: quote.pb, price: quote.price } : null,
              percentile: quote ? valuationPercentile(series, quote) : null,
            });
          }

          if (req.method === "POST" && url.pathname === "/api/watchdog-test") {
            if (!serverChanSendKey) {
              return json(res, 400, { error: { message: "未配置 SERVERCHAN_SENDKEY，无法测试推送。" } });
            }
            const result = await pushServerChan(
              serverChanSendKey,
              "【测试】司南工作台盯盘推送",
              "这是一条测试消息。收到即说明 Server酱 推送链路正常。",
            );
            if (!result.ok) {
              return json(res, 502, { error: { message: `推送失败：${result.reason}` } });
            }
            return json(res, 200, { ok: true });
          }

          if (req.method === "GET" && url.pathname === "/api/stock-news") {
            const name = url.searchParams.get("name") ?? "";
            const code = url.searchParams.get("code") ?? null;
            const items = await stockNews.getStockNews({ name, code });
            return json(res, 200, { name, items });
          }

          if (req.method === "POST" && url.pathname === "/api/stock-analysis/sentiment") {
            const body = await readJson(req, 64 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["name", "note", "code", "entityContent"]),
              "INVALID_STOCK_ANALYSIS_REQUEST",
            );
            const task = await stockAnalysis.startSentiment({
              name: body.name,
              note: body.note ?? null,
              code: body.code ?? null,
              entityContent: body.entityContent ?? null,
            });
            return json(res, 202, task);
          }

          if (req.method === "POST" && url.pathname === "/api/stock-analysis/research") {
            const body = await readJson(req, 64 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["name", "note", "code", "entityContent"]),
              "INVALID_STOCK_ANALYSIS_REQUEST",
            );
            const task = await stockAnalysis.startResearch({
              name: body.name,
              note: body.note ?? null,
              code: body.code ?? null,
              entityContent: body.entityContent ?? null,
            });
            return json(res, 202, task);
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/indices") {
            const date = url.searchParams.get("date") ?? null;
            return json(res, 200, await dailyReview.getIndices(date));
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/intraday") {
            const code = url.searchParams.get("code") ?? "";
            const date = url.searchParams.get("date") ?? null;
            try {
              return json(res, 200, await dailyReview.getStockIntraday(code, date));
            } catch (error) {
              if (error?.code === "INVALID_STOCK_CODE") {
                return json(res, 400, { error: { message: error.message } });
              }
              throw error;
            }
          }

          if (req.method === "GET" && url.pathname === "/api/portfolio") {
            return json(res, 200, await dailyReview.getPortfolio());
          }

          if (req.method === "POST" && url.pathname === "/api/portfolio") {
            const body = await readJson(req, 4 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["code", "name", "shares", "costPrice", "openedAt", "targetPrice", "stopPrice", "note"]),
              "INVALID_PORTFOLIO_REQUEST",
            );
            try {
              const position = await portfolioRepo.add(body);
              vaultSync.notifyPaths([PORTFOLIO_PATH]);
              return json(res, 201, position);
            } catch (error) {
              return json(res, 400, { error: { message: error?.message || "持仓无效。" } });
            }
          }

          const portfolioMatch = url.pathname.match(/^\/api\/portfolio\/([^/]+)$/);
          if (portfolioMatch) {
            const id = decodeURIComponent(portfolioMatch[1]);
            if (req.method === "PUT") {
              const body = await readJson(req, 4 * 1024);
              assertAllowedObjectKeys(
                body,
                new Set(["code", "name", "shares", "costPrice", "openedAt", "targetPrice", "stopPrice", "note", "closedAt", "closedPrice"]),
                "INVALID_PORTFOLIO_REQUEST",
              );
              const updated = await portfolioRepo.update(id, body);
              if (!updated) return json(res, 404, { error: { message: "持仓不存在。" } });
              vaultSync.notifyPaths([PORTFOLIO_PATH]);
              return json(res, 200, updated);
            }
            if (req.method === "DELETE") {
              const removed = await portfolioRepo.remove(id);
              if (!removed) return json(res, 404, { error: { message: "持仓不存在。" } });
              vaultSync.notifyPaths([PORTFOLIO_PATH]);
              return json(res, 200, { removed: true });
            }
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/kline") {
            const symbol = url.searchParams.get("symbol") ?? "";
            const days = Number(url.searchParams.get("days") ?? 60);
            try {
              return json(res, 200, await dailyReview.getIndexDaily(symbol, days));
            } catch (error) {
              if (error?.code === "INDEX_NOT_ALLOWED") {
                return json(res, 400, { error: { message: error.message } });
              }
              throw error;
            }
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/timeline") {
            const date = url.searchParams.get("date") ?? null;
            return json(res, 200, await dailyReview.getTimeline(date));
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/events") {
            const date = url.searchParams.get("date");
            return json(res, 200, { items: await reviewEvents.list(date ? { date } : {}) });
          }

          if (req.method === "POST" && url.pathname === "/api/daily-review/events") {
            const body = await readJson(req, 8 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["ts", "title", "note", "tone"]),
              "INVALID_REVIEW_EVENT_REQUEST",
            );
            try {
              const event = await reviewEvents.add(body);
              vaultSync.notifyPaths([REVIEW_EVENTS_PATH]);
              return json(res, 201, event);
            } catch (error) {
              return json(res, 400, { error: { message: error?.message || "事件无效。" } });
            }
          }

          const reviewEventMatch = url.pathname.match(
            /^\/api\/daily-review\/events\/([^/]+)$/,
          );
          if (reviewEventMatch) {
            const id = decodeURIComponent(reviewEventMatch[1]);
            if (req.method === "PUT") {
              const body = await readJson(req, 8 * 1024);
              assertAllowedObjectKeys(
                body,
                new Set(["ts", "title", "note", "tone"]),
                "INVALID_REVIEW_EVENT_REQUEST",
              );
              const updated = await reviewEvents.update(id, body);
              if (!updated) return json(res, 404, { error: { message: "事件不存在。" } });
              vaultSync.notifyPaths([REVIEW_EVENTS_PATH]);
              return json(res, 200, updated);
            }
            if (req.method === "DELETE") {
              const removed = await reviewEvents.remove(id);
              if (!removed) return json(res, 404, { error: { message: "事件不存在。" } });
              vaultSync.notifyPaths([REVIEW_EVENTS_PATH]);
              return json(res, 200, { removed: true });
            }
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/summary") {
            const date = url.searchParams.get("date") ?? "";
            const [intraday, close] = await Promise.all([
              dailyReviewStore.get(date, "intraday"),
              dailyReviewStore.get(date, "close"),
            ]);
            return json(res, 200, { intraday, close });
          }

          if (req.method === "POST" && url.pathname === "/api/prompts/suggest") {
            const body = await readJson(req, 2_000).catch(() => null);
            const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
            if (!idea) return json(res, 400, { error: { code: "BAD_REQUEST", message: "缺少 idea" } });
            try {
              return json(res, 200, await promptsLibrary.suggestKeywords(idea));
            } catch (error) {
              return json(res, 502, { error: { code: "LLM_FAILED", message: error?.message ?? "AI 检索失败" } });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/prompts/optimize") {
            const body = await readJson(req, 32_000).catch(() => null);
            const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
            const template = typeof body?.template === "string" ? body.template : "";
            const context = typeof body?.context === "string" ? body.context : "";
            if (!idea || !template) {
              return json(res, 400, { error: { code: "BAD_REQUEST", message: "缺少 idea 或 template" } });
            }
            try {
              return json(res, 200, await promptsLibrary.optimize({ idea, template, context }));
            } catch (error) {
              return json(res, 502, { error: { code: "LLM_FAILED", message: error?.message ?? "AI 优化失败" } });
            }
          }

          if (req.method === "GET" && url.pathname === "/api/prompts") {
            const q = url.searchParams.get("q") ?? "";
            const lang = url.searchParams.get("lang") ?? "all";
            const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 50);
            try {
              return json(res, 200, await promptsLibrary.search({ q, lang, limit }));
            } catch (error) {
              return json(res, 502, { error: { code: "PROMPTS_UNAVAILABLE", message: error?.message ?? "提示词库暂不可用" } });
            }
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/sentiment") {
            if (!sentimentService) return json(res, 200, null);
            return json(res, 200, await sentimentService.getSentiment().catch(() => null));
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/schedule") {
            return json(res, 200, await reviewSchedule.get());
          }

          if (req.method === "PUT" && url.pathname === "/api/daily-review/schedule") {
            const body = await readJson(req, 2 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["enabled", "time"]),
              "INVALID_REVIEW_SCHEDULE_REQUEST",
            );
            try {
              const saved = await reviewSchedule.save(body);
              vaultSync.notifyPaths([REVIEW_SCHEDULE_PATH]);
              return json(res, 200, saved);
            } catch (error) {
              return json(res, 400, { error: { message: error?.message || "调度配置无效。" } });
            }
          }

          if (req.method === "GET" && url.pathname === "/api/daily-review/prompt") {
            const current = await coachPrompt.get();
            return json(res, 200, {
              prompt: current.prompt,
              customized: current.customized,
              variables: ["{{date}}", "{{session}}"],
            });
          }

          if (req.method === "PUT" && url.pathname === "/api/daily-review/prompt") {
            const body = await readJson(req, 32 * 1024);
            assertAllowedObjectKeys(body, new Set(["prompt"]), "INVALID_COACH_PROMPT_REQUEST");
            try {
              const saved = await coachPrompt.save(body.prompt);
              vaultSync.notifyPaths([COACH_PROMPT_PATH]);
              return json(res, 200, { ...saved, variables: ["{{date}}", "{{session}}"] });
            } catch (error) {
              return json(res, 400, { error: { message: error?.message || "提示词无效。" } });
            }
          }

          if (req.method === "DELETE" && url.pathname === "/api/daily-review/prompt") {
            const reset = await coachPrompt.reset();
            vaultSync.notifyPaths([COACH_PROMPT_PATH]);
            return json(res, 200, { ...reset, variables: ["{{date}}", "{{session}}"] });
          }

          const reviewSummaryMatch = url.pathname.match(
            /^\/api\/daily-review\/summary\/([^/]+)$/,
          );
          if (req.method === "PUT" && reviewSummaryMatch) {
            const date = decodeURIComponent(reviewSummaryMatch[1]);
            const body = await readJson(req, 32 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["stockCount", "review", "session"]),
              "INVALID_REVIEW_SUMMARY_REQUEST",
            );
            try {
              const entry = await dailyReviewStore.save(date, body);
              vaultSync.notifyPaths([DAILY_REVIEW_PATH]);
              return json(res, 200, entry);
            } catch (error) {
              return json(res, 400, { error: { message: error?.message || "总结无效。" } });
            }
          }

          if (req.method === "POST" && url.pathname === "/api/daily-review/generate") {
            const body = await readJson(req, 16 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["stocks", "date", "session"]),
              "INVALID_REVIEW_GENERATE_REQUEST",
            );
            const context = await dailyReview.collectReviewContext(
              typeof body.date === "string" ? body.date : null,
              Array.isArray(body.stocks) ? body.stocks : [],
            );
            if (body.session === "intraday" || body.session === "close") {
              context.session = {
                ...context.session,
                key: body.session,
                isTrading: body.session === "intraday",
                label: body.session === "intraday" ? "盘中" : "盘后",
              };
            }
            const { prompt: promptTemplate } = await coachPrompt.get();
            const task = await stockAnalysis.startCoachReview(context, { promptTemplate });
            return json(res, 202, task);
          }

          if (req.method === "POST" && url.pathname === "/api/stock-analysis/review") {
            const body = await readJson(req, 128 * 1024);
            assertAllowedObjectKeys(
              body,
              new Set(["stocks", "indices", "events"]),
              "INVALID_STOCK_REVIEW_REQUEST",
            );
            const task = await stockAnalysis.startReview({
              stocks: Array.isArray(body.stocks) ? body.stocks : [],
              indices: Array.isArray(body.indices) ? body.indices : [],
              events: Array.isArray(body.events) ? body.events : [],
            });
            return json(res, 202, task);
          }

          const stockAnalysisMatch = url.pathname.match(
            /^\/api\/stock-analysis\/([^/]+)$/,
          );
          if (req.method === "GET" && stockAnalysisMatch) {
            const id = decodeURIComponent(stockAnalysisMatch[1]);
            const task = stockAnalysis.get(id);
            if (!task) return json(res, 404, { error: { message: "分析任务不存在。" } });
            return json(res, 200, task);
          }

          if (req.method === "GET" && url.pathname === "/api/social-trends") {
            return json(res, 200, listSocialTrends(await currentIndex()));
          }

          const socialInsightMatch = url.pathname.match(
            /^\/api\/social-insights\/([^/]+)$/,
          );
          if (req.method === "GET" && socialInsightMatch) {
            let reportId;
            try {
              reportId = decodeURIComponent(socialInsightMatch[1]);
            } catch {
              return json(res, 400, {
                error: {
                  code: "INVALID_SOCIAL_INSIGHT_ID",
                  message: "社媒洞察报告 ID 无法解析。",
                },
              });
            }
            const report = getSocialInsight(await currentIndex(), reportId);
            if (!report) {
              return json(res, 404, {
                error: {
                  code: "SOCIAL_INSIGHT_NOT_FOUND",
                  message: "社媒洞察报告不存在或已被移动。",
                },
              });
            }
            return json(res, 200, report);
          }

          const socialTrendMatch = url.pathname.match(
            /^\/api\/social-trends\/([^/]+)$/,
          );
          if (req.method === "GET" && socialTrendMatch) {
            let reportId;
            try {
              reportId = decodeURIComponent(socialTrendMatch[1]);
            } catch {
              return json(res, 400, {
                error: {
                  code: "INVALID_SOCIAL_TREND_ID",
                  message: "社媒风向报告 ID 无法解析。",
                },
              });
            }
            const report = getSocialTrend(await currentIndex(), reportId);
            if (!report) {
              return json(res, 404, {
                error: {
                  code: "SOCIAL_TREND_NOT_FOUND",
                  message: "社媒风向报告不存在或已被移动。",
                },
              });
            }
            return json(res, 200, report);
          }

          if (req.method === "POST" && url.pathname === "/api/refresh") {
            const refreshed = await refreshIndex({ reason: "manual" });
            return json(res, 200, {
              generatedAt: refreshed.generatedAt,
              stats: refreshed.stats,
              errors: refreshed.errors.length,
              sync: vaultSync.getStatus(),
            });
          }

          if (req.method === "GET" && url.pathname === "/api/runtime") {
            const [current, codex] = await Promise.all([currentIndex(), detectCodexCli()]);
            return json(res, 200, {
              vault: {
                connected: true,
                label: path.basename(vaultRoot),
                generatedAt: current.generatedAt,
                documents: current.stats.documents,
                errors: current.errors.length,
              },
              sync: vaultSync.getStatus(),
              codex: {
                available: codex.available,
                source: codex.source,
              },
            });
          }

          if (req.method === "POST" && url.pathname === "/api/open") {
            const body = await readJson(req);
            if (!["obsidian", "finder"].includes(body.target)) {
              return json(res, 400, { error: { message: "不支持的打开方式。" } });
            }
            const careerPath = careerRelativePathFromId(body.id);
            if (careerPath) {
              if (!careerVaultRoot) {
                return json(res, 404, { error: { message: "文档不存在。" } });
              }
              const careerDoc = await readCareerDocument(careerVaultRoot, careerPath);
              if (!careerDoc) return json(res, 404, { error: { message: "文档不存在。" } });
              // 用 Obsidian 的 vault 根定位实际文件（相对路径在 careerDoc.relativePath）。
              openLocalDocument(careerVaultRoot, { path: careerDoc.relativePath }, body.target);
              return json(res, 200, { ok: true });
            }
            const obsidianPath = obsidianRelativePathFromId(body.id);
            if (obsidianPath) {
              if (!obsidianVaultRoot) {
                return json(res, 404, { error: { message: "文档不存在。" } });
              }
              const obsidianDoc = await readObsidianDocument(obsidianVaultRoot, obsidianPath);
              if (!obsidianDoc) return json(res, 404, { error: { message: "文档不存在。" } });
              openLocalDocument(obsidianVaultRoot, { path: obsidianDoc.relativePath }, body.target);
              return json(res, 200, { ok: true });
            }
            const current = await currentIndex();
            const document = getDocument(current, body.id);
            if (!document) return json(res, 404, { error: { message: "文档不存在。" } });
            openLocalDocument(vaultRoot, document, body.target);
            return json(res, 200, { ok: true });
          }

          if (req.method === "POST" && url.pathname === "/api/workflows/xiaohongshu") {
            const body = await readJson(req);
            return json(res, 202, await createXhsDraftJob(body));
          }

          if (req.method === "GET" && url.pathname === "/api/workflows/jobs") {
            return json(res, 200, { items: listJobs() });
          }

          const jobMatch = url.pathname.match(
            /^\/api\/workflows\/jobs\/([^/]+)(?:\/(events|cancel|confirm))?$/,
          );
          if (jobMatch) {
            const jobId = decodeURIComponent(jobMatch[1]);
            const action = jobMatch[2] || "read";

            if (req.method === "GET" && action === "read") {
              return json(res, 200, getJob(jobId));
            }
            if (req.method === "POST" && action === "cancel") {
              return json(res, 200, cancelJob(jobId));
            }
            if (req.method === "POST" && action === "confirm") {
              const confirmed = await confirmJob(jobId);
              await refreshIndex();
              return json(res, 200, confirmed);
            }
            if (req.method === "GET" && action === "events") {
              res.writeHead(200, {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream; charset=utf-8",
                "X-Accel-Buffering": "no",
              });
              res.write(": connected\n\n");
              let unsubscribe = () => {};
              unsubscribe = subscribeJob(jobId, (job) => {
                res.write(`data: ${JSON.stringify(job)}\n\n`);
                if (
                  ["awaiting_review", "completed", "failed", "cancelled"].includes(job.status)
                ) {
                  queueMicrotask(() => {
                    unsubscribe();
                    res.end();
                  });
                }
              });
              req.on("close", unsubscribe);
              return;
            }
          }

          return json(res, 404, { error: { message: "API 路径不存在。" } });
        } catch (error) {
          server.config.logger.error(error);
          return json(res, errorStatus(error), errorPayload(error));
        }
      });
    },
  };
}
