import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle,
  IconBook2,
  IconBriefcase,
  IconFileText,
  IconRefresh,
} from "@tabler/icons-react";

import { PageHeader } from "../components/PageHeader";
import { loadCareer } from "../lib/api";
import "../components/career/career.css";

function formatUpdated(value) {
  if (!value) return "—";
  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

function groupByDirection(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.direction || "未分类";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

export function CareerPage({ onOpenDocument, syncRevision = 0 }) {
  const reduceMotion = useReducedMotion();
  const [result, setResult] = useState({ data: null, source: "loading", error: null });
  const [openRawGroups, setOpenRawGroups] = useState(() => new Set());

  const refresh = useCallback(async () => {
    setResult((current) => ({
      ...current,
      source: current.data ? current.source : "loading",
    }));
    const next = await loadCareer();
    setResult(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, syncRevision]);

  const { data, source, error } = result;
  const isLoading = source === "loading";

  const enter = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
      };

  if (isLoading) {
    return (
      <div className="page page--career">
        <div className="career-loading">
          <div className="skeleton" style={{ height: 28, width: "55%" }} />
          <div className="skeleton" style={{ height: 110, marginTop: 24 }} />
          <div className="skeleton" style={{ height: 320, marginTop: 16 }} />
          <div className="skeleton" style={{ height: 200, marginTop: 16 }} />
        </div>
      </div>
    );
  }

  const report = data?.report ?? null;
  const campaign = data?.campaign ?? null;
  const curated = data?.questionBanks?.curated ?? [];
  const raw = data?.questionBanks?.raw ?? [];
  const concepts = data?.concepts ?? [];
  const coverage = data?.coverage ?? { roles: false, matrix: false };
  const hints = data?.placeholderHints ?? { roles: "", matrix: "" };

  const rawGroups = groupByDirection(raw);
  const conceptGroups = groupByDirection(concepts);
  const curatedCount = curated.filter((b) => b.kind !== "ledger").length;
  const ledgerCount = curated.filter((b) => b.kind === "ledger").length;
  const directionCount = new Set([...raw, ...concepts].map((i) => i.direction)).size;

  const toggleRawGroup = (key) => {
    setOpenRawGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const headerAside = (
    <div className="career-summary">
      <div>
        <strong>{curatedCount || "—"}</strong>
        <span>自编题库</span>
      </div>
      <div>
        <strong>{raw.length || "—"}</strong>
        <span>面试鸭原题</span>
      </div>
      <div>
        <strong>{concepts.length || "—"}</strong>
        <span>概念</span>
      </div>
      <div>
        <strong>{directionCount || "—"}</strong>
        <span>覆盖方向</span>
      </div>
    </div>
  );

  return (
    <div className="page page--career">
      <PageHeader
        eyebrow="CAREER · OBSIDIAN"
        title="求职备战"
        description="岗位机会、技能差距与面试题库的本地备战面板，只读来自 Obsidian 知识库的内容。"
        aside={headerAside}
      />

      <div className="career-toolbar">
        <span className="career-source">
          {source === "live" ? "已连接 Obsidian 知识库" : source === "fallback" ? "未配置数据源" : "—"}
        </span>
        <button type="button" className="career-refresh" onClick={refresh}>
          <IconRefresh size={16} stroke={1.7} />
          刷新
        </button>
      </div>

      {error && source === "fallback" && !data?.available ? (
        <div className="career-empty career-empty--error">
          <IconAlertTriangle size={20} stroke={1.7} />
          <p>
            无法加载求职备战数据。请确认已在 Workbench/.env 配置 CAREER_VAULT_ROOT。
            {error?.message ? `（${error.message}）` : ""}
          </p>
        </div>
      ) : null}

      {/* 主报告区：MOC + 战役页 */}
      {(report || campaign) && (
        <motion.section className="career-panel" {...enter}>
          <header className="career-section__head">
            <h2>主报告</h2>
            <p>求职备战的知识入口与战役页。</p>
          </header>
          <div className="career-report-grid">
            {report && (
              <button
                type="button"
                className="career-report-card"
                onClick={() => onOpenDocument?.(report.id)}
              >
                <div className="career-report-card__head">
                  <IconBriefcase size={18} stroke={1.7} />
                  <span className="career-report-card__eyebrow">知识地图 · MOC</span>
                </div>
                <div className="career-report-card__title">{report.title}</div>
                <div className="career-report-card__meta">更新 {formatUpdated(report.updated)}</div>
              </button>
            )}
            {campaign && (
              <button
                type="button"
                className="career-report-card"
                onClick={() => onOpenDocument?.(campaign.id)}
              >
                <div className="career-report-card__head">
                  <IconFileText size={18} stroke={1.7} />
                  <span className="career-report-card__eyebrow">战役页</span>
                </div>
                <div className="career-report-card__title">{campaign.title}</div>
                <div className="career-report-card__meta">更新 {formatUpdated(campaign.updated)}</div>
              </button>
            )}
          </div>
        </motion.section>
      )}

      {/* 面试题库区（主力） */}
      <motion.section
        className="career-panel"
        {...enter}
        transition={{ ...enter.transition, delay: 0.05 }}
      >
        <header className="career-section__head">
          <h2>面试题库</h2>
          <p>自编答案库与面试鸭原文题库，点击在阅读器中打开。</p>
        </header>

        {curated.length > 0 && (
          <div className="career-subsection">
            <h3 className="career-subsection__title">自编答案库</h3>
            <div className="career-banks">
              {curated.map((bank) => (
                <button
                  key={bank.id}
                  type="button"
                  className="career-bank-card"
                  onClick={() => onOpenDocument?.(bank.id)}
                >
                  <div className="career-bank-card__head">
                    <IconBook2 size={18} stroke={1.7} />
                    <span className="career-bank-card__direction">{bank.direction}</span>
                  </div>
                  <div className="career-bank-card__title">{bank.title}</div>
                  <div className="career-bank-card__meta">
                    <span>
                      {bank.kind === "ledger"
                        ? "来源台账"
                        : bank.questionCount != null
                          ? `${bank.questionCount} 题`
                          : "题量未知"}
                    </span>
                    <span>更新 {formatUpdated(bank.updated)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {raw.length > 0 && (
          <div className="career-subsection">
            <h3 className="career-subsection__title">面试鸭原文（{raw.length}）</h3>
            <div className="career-raw-groups">
              {rawGroups.map(([direction, items]) => {
                const isOpen = openRawGroups.has(direction);
                return (
                  <div key={direction} className="career-raw-group">
                    <button
                      type="button"
                      className="career-raw-group__toggle"
                      onClick={() => toggleRawGroup(direction)}
                    >
                      <span>{direction}</span>
                      <span className="career-raw-group__count">{items.length}</span>
                    </button>
                    {isOpen && (
                      <div className="career-raw-group__list">
                        {items.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="career-raw-item"
                            onClick={() => onOpenDocument?.(item.id)}
                          >
                            <span className="career-raw-item__title">{item.title}</span>
                            <span className="career-raw-item__date">
                              {formatUpdated(item.updated)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {curated.length === 0 && raw.length === 0 && (
          <div className="career-empty">
            <p>暂无题库数据。</p>
          </div>
        )}
      </motion.section>

      {/* 知识概念区（新区） */}
      <motion.section
        className="career-panel"
        {...enter}
        transition={{ ...enter.transition, delay: 0.1 }}
      >
        <header className="career-section__head">
          <h2>知识概念</h2>
          <p>已编译的概念笔记，按方向分组。</p>
        </header>
        {concepts.length > 0 ? (
          <div className="career-concepts">
            {conceptGroups.map(([direction, items]) => (
              <div key={direction} className="career-concept-group">
                <h3 className="career-subsection__title">
                  {direction} <span className="career-raw-group__count">{items.length}</span>
                </h3>
                <div className="career-concept-grid">
                  {items.map((concept) => (
                    <button
                      key={concept.id}
                      type="button"
                      className="career-concept-card"
                      onClick={() => onOpenDocument?.(concept.id)}
                    >
                      <div className="career-concept-card__title">{concept.title}</div>
                      {concept.excerpt && (
                        <div className="career-concept-card__excerpt">{concept.excerpt}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="career-empty">
            <p>暂无概念笔记。</p>
          </div>
        )}
      </motion.section>

      {/* 岗位机会 / 技能差距 —— 占位（Obsidian 暂无数据） */}
      <motion.section
        className="career-panel"
        {...enter}
        transition={{ ...enter.transition, delay: 0.15 }}
      >
        <header className="career-section__head">
          <h2>岗位机会 · 技能差距</h2>
          <p>这两区依赖岗位扫描与差距分析的产出，目前知识库尚未生成。</p>
        </header>
        <div className="career-placeholder-grid">
          <div className="career-placeholder">
            <span className="career-placeholder__tag">岗位机会</span>
            <p>{coverage.roles ? "已生成" : hints.roles}</p>
          </div>
          <div className="career-placeholder">
            <span className="career-placeholder__tag">技能差距矩阵</span>
            <p>{coverage.matrix ? "已生成" : hints.matrix}</p>
          </div>
        </div>
      </motion.section>
    </div>
  );
}
