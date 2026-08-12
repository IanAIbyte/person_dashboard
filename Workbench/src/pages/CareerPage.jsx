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
import { MetricStat } from "../components/MetricStat";
import { loadCareer } from "../lib/api";
import "../components/career/career.css";

const STATUS_LABEL = {
  ok: "已具备",
  warn: "需补强",
  missing: "缺失",
  unknown: "—",
};
// 缺失 / 需补强置顶，已具备沉底。
const STATUS_RANK = { missing: 0, warn: 1, unknown: 2, ok: 3 };
const PRIORITY_RANK = { high: 0, "mid-high": 1, mid: 2, none: 3, unknown: 4 };
const PRIORITY_LABEL = { high: "高", "mid-high": "中高", mid: "中", none: "—" };

function formatUpdated(value) {
  if (!value) return "—";
  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

// 匹配度高/中高/中 → 用于卡片左侧色条与匹配度文字上色。
function matchTone(match) {
  if (!match) return "unknown";
  if (match.startsWith("高")) return "high";
  if (match.includes("中高")) return "mid-high";
  if (match.startsWith("中")) return "mid";
  return "unknown";
}

function RoleCard({ role }) {
  const tone = matchTone(role.match);
  return (
    <article className={`career-role-card career-role-card--${tone}`}>
      <div className="career-role-card__head">
        <span className="career-role-card__id">{role.id || "—"}</span>
        <span className={`career-role-card__match career-role-card__match--${tone}`}>
          {role.match || "—"}
        </span>
      </div>
      <h3 className="career-role-card__title">{role.title || "未命名岗位"}</h3>
      {role.company ? <div className="career-role-card__company">{role.company}</div> : null}
      <dl className="career-role-card__facts">
        <div>
          <dt>薪资</dt>
          <dd>{role.salary || "未公开"}</dd>
        </div>
        <div>
          <dt>地点</dt>
          <dd>{role.location || "—"}</dd>
        </div>
      </dl>
      {role.requirements ? (
        <p className="career-role-card__requirements">{role.requirements}</p>
      ) : null}
      {role.source ? <div className="career-role-card__source">{role.source}</div> : null}
    </article>
  );
}

function MatrixRow({ row }) {
  return (
    <tr className={`career-matrix__row career-matrix__row--${row.statusLevel}`}>
      <td className="career-matrix__skill">{row.skill || "—"}</td>
      <td>
        <span className={`career-status career-status--${row.statusLevel}`}>
          {row.status || STATUS_LABEL[row.statusLevel]}
        </span>
      </td>
      <td className="career-matrix__roles">{row.roles || "—"}</td>
      <td className="career-matrix__question">{row.question || "—"}</td>
      <td>
        <span className={`career-priority career-priority--${row.priorityLevel}`}>
          {row.priority || PRIORITY_LABEL[row.priorityLevel]}
        </span>
      </td>
    </tr>
  );
}

export function CareerPage({ onOpenDocument, syncRevision = 0 }) {
  const reduceMotion = useReducedMotion();
  const [result, setResult] = useState({ data: null, source: "loading", error: null });
  const [activeTab, setActiveTab] = useState("A");

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
  const banks = data?.banks ?? [];
  const roles =
    data?.roles ?? { A: { label: "方向 A", count: 0, items: [] }, B: { label: "方向 B", count: 0, items: [] } };
  const matrixRaw = data?.matrix ?? [];

  const totalQuestions = banks.reduce((sum, bank) => sum + (bank.questionCount || 0), 0);
  const roleTotal = (roles.A?.count ?? 0) + (roles.B?.count ?? 0);
  const gapCount = matrixRaw.filter(
    (row) => row.statusLevel === "warn" || row.statusLevel === "missing",
  ).length;
  const matrixSorted = [...matrixRaw].sort(
    (a, b) =>
      (STATUS_RANK[a.statusLevel] ?? 9) - (STATUS_RANK[b.statusLevel] ?? 9) ||
      (PRIORITY_RANK[a.priorityLevel] ?? 9) - (PRIORITY_RANK[b.priorityLevel] ?? 9),
  );
  const activeRoles = roles[activeTab] ?? { items: [] };

  return (
    <div className="page page--career">
      <PageHeader
        eyebrow="CAREER · LOCAL"
        title="求职备战"
        description="岗位机会、技能差距矩阵与面试题库的本地备战面板。数据仅本地可见，不随公开版发布。"
        aside={
          <div className="metric-strip">
            <MetricStat label="题库" value={banks.length} accent />
            <MetricStat label="总题量" value={totalQuestions} />
            <MetricStat label="在招岗位" value={roleTotal} />
            <MetricStat label="待补强技能" value={gapCount} />
          </div>
        }
      />

      <div className="career-toolbar">
        <span className="career-source">
          {source === "live" ? "已连接本地 Vault" : source === "fallback" ? "降级模式" : "—"}
        </span>
        <button type="button" className="career-refresh" onClick={refresh}>
          <IconRefresh size={16} stroke={1.7} />
          刷新
        </button>
      </div>

      {error && source === "fallback" && !report ? (
        <div className="career-empty career-empty--error">
          <IconAlertTriangle size={20} stroke={1.7} />
          <p>无法加载求职备战数据。{error?.message ? `（${error.message}）` : ""}</p>
        </div>
      ) : null}

      {report ? (
        <motion.section className="career-panel career-report" {...enter}>
          <div className="career-report__main">
            <span className="career-report__eyebrow">策略主报告</span>
            <h2 className="career-report__title">{report.title || "求职策略主报告"}</h2>
            <div className="career-report__meta">
              <span>
                <IconBriefcase size={14} stroke={1.7} /> {report.direction || "求职策略"}
              </span>
              <span>更新 {formatUpdated(report.updated)}</span>
            </div>
          </div>
          <button
            type="button"
            className="career-report__action"
            onClick={() => onOpenDocument?.(report.id)}
          >
            <IconFileText size={16} stroke={1.7} />
            阅读完整报告
          </button>
        </motion.section>
      ) : null}

      <motion.section
        className="career-panel"
        {...enter}
        transition={{ ...enter.transition, delay: 0.05 }}
      >
        <header className="career-section__head">
          <h2>岗位机会</h2>
          <p>主报告梳理的在招岗位，按方向分组。</p>
        </header>
        <div className="career-tabs">
          {["A", "B"].map((key) => {
            const group = roles[key] ?? { items: [], count: 0 };
            const label =
              group.label || (key === "A" ? "方向 A · 匹配岗位" : "方向 B · AI 方向");
            return (
              <button
                key={key}
                type="button"
                className={`career-tabs__tab${activeTab === key ? " career-tabs__tab--active" : ""}`}
                onClick={() => setActiveTab(key)}
              >
                {label}（{group.count ?? group.items.length}）
              </button>
            );
          })}
        </div>
        {activeRoles.items?.length ? (
          <div className="career-roles">
            {activeRoles.items.map((role) => (
              <RoleCard key={role.id || role.title} role={role} />
            ))}
          </div>
        ) : (
          <div className="career-empty">
            <p>该方向暂无岗位数据。</p>
          </div>
        )}
      </motion.section>

      <motion.section
        className="career-panel"
        {...enter}
        transition={{ ...enter.transition, delay: 0.1 }}
      >
        <header className="career-section__head">
          <h2>技能差距矩阵</h2>
          <p>按面试考察频率排序；缺失与需补强项置顶，便于优先补齐。</p>
        </header>
        {matrixSorted.length ? (
          <div className="career-matrix-scroll">
            <table className="career-matrix">
              <thead>
                <tr>
                  <th>技能项</th>
                  <th>状态</th>
                  <th>出现岗位</th>
                  <th>面试典型问法</th>
                  <th>学习优先级</th>
                </tr>
              </thead>
              <tbody>
                {matrixSorted.map((row) => (
                  <MatrixRow key={row.skill} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="career-empty">
            <p>暂无技能差距数据。</p>
          </div>
        )}
      </motion.section>

      <motion.section
        className="career-panel"
        {...enter}
        transition={{ ...enter.transition, delay: 0.15 }}
      >
        <header className="career-section__head">
          <h2>面试题库</h2>
          <p>点击卡片在阅读器中打开题库原文。</p>
        </header>
        {banks.length ? (
          <div className="career-banks">
            {banks.map((bank) => (
              <button
                key={bank.id}
                type="button"
                className="career-bank-card"
                onClick={() => onOpenDocument?.(bank.id)}
              >
                <div className="career-bank-card__head">
                  <IconBook2 size={18} stroke={1.7} />
                  <span className="career-bank-card__direction">{bank.direction || "题库"}</span>
                </div>
                <div className="career-bank-card__title">{bank.title || "面试题库"}</div>
                <div className="career-bank-card__meta">
                  <span>{bank.questionCount != null ? `${bank.questionCount} 题` : "题量未知"}</span>
                  <span>更新 {formatUpdated(bank.updated)}</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="career-empty">
            <p>暂无题库数据。</p>
          </div>
        )}
      </motion.section>
    </div>
  );
}
