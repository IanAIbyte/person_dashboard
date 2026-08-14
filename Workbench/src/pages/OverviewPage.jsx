import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import gsap from "gsap";
import { IconArrowUpRight } from "@tabler/icons-react";
import { DecryptedText } from "../components/DecryptedText";
import { DotEyes } from "../components/DotEyes";
import { KnowledgeGraph } from "../components/KnowledgeGraph";
import { MetricStat } from "../components/MetricStat";
import {
  loadBooks,
  loadCareer,
  loadDailyHot,
  loadGraph,
  loadOverview,
  loadStockWatchlist,
} from "../lib/api";
import { formatCompactDate } from "../lib/format";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const REFRESH_INTERVAL_MS = 60_000;

let overviewEntranceHasCompleted = false;

const localWorkbench = import.meta.env.VITE_WORKBENCH_HOSTED !== "true";

export function OverviewPage({ onOpenDocument }) {
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [graph, setGraph] = useState(null);
  const [books, setBooks] = useState(null);
  const [dailyHot, setDailyHot] = useState(null);
  const [career, setCareer] = useState(null);
  const [watchlist, setWatchlist] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const refreshOverview = () => {
      loadOverview().then((res) => {
        if (!cancelled) setOverview(res);
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshOverview();
    };
    refreshOverview();
    loadGraph().then((res) => {
      if (!cancelled) setGraph(res);
    });
    loadBooks().then((res) => {
      if (!cancelled) setBooks(res);
    });
    loadDailyHot().then((res) => {
      if (!cancelled) setDailyHot(res);
    });
    if (localWorkbench) {
      loadCareer().then((res) => {
        if (!cancelled) setCareer(res);
      });
      loadStockWatchlist().then((res) => {
        if (!cancelled) setWatchlist(res);
      });
    }
    const interval = window.setInterval(refreshOverview, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshOverview);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOverview);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  // 入场编排：hero → 指标条 → 面板，GSAP 一次性时间线
  useEffect(() => {
    if (!overview || overviewEntranceHasCompleted) return undefined;
    if (prefersReducedMotion()) {
      overviewEntranceHasCompleted = true;
      return undefined;
    }
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from("[data-hero] > div > *", { y: 18, opacity: 0, duration: 0.5, stagger: 0.07 })
        .from(".metric-strip", { y: 16, opacity: 0, duration: 0.45 }, "-=0.25")
        .from(
          "[data-panel]",
          { y: 20, opacity: 0, duration: 0.5, stagger: 0.08 },
          "-=0.2",
        );
      tl.eventCallback("onComplete", () => {
        overviewEntranceHasCompleted = true;
      });
    }, rootRef);
    return () => ctx.revert();
  }, [overview]);

  const metrics = overview?.data?.metrics ?? {};
  const demoMode = overview?.data?.demoMode === true;
  const recent = overview?.data?.recent ?? [];
  const graphData = graph?.data;
  const hotItems = dailyHot?.data?.tiers?.mustRead ?? [];

  const today = useMemo(
    () =>
      new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(new Date()),
    [],
  );

  const fromFallback = overview?.source === "fallback";
  const overviewLoading = !overview;
  const liveDataReady = Boolean(overview && !fromFallback);
  const overviewSettled = Boolean(overview);

  return (
    <div ref={rootRef}>
      <section className="hero" data-hero>
        <div>
          <span className="eyebrow">
            <DecryptedText
              active={liveDataReady}
              settleWithoutAnimation={overviewSettled && !liveDataReady}
              text="PERSONAL AI WORKBENCH"
            />
            <span aria-hidden="true">·</span>
            <span>{today}</span>
          </span>
          <h1 className="hero__title">工作台总览</h1>
          <div className="hero__meta">
            <span className="badge">
              <span className="status-dot status-dot--ok" /> {demoMode ? "示例 Vault" : "本地 Vault"}
            </span>
            {overviewLoading ? (
              <span className="badge">
                <span className="status-dot" /> 索引连接中
              </span>
            ) : fromFallback ? (
              <span className="badge">
                <span className="status-dot status-dot--warn" /> 数据服务离线
              </span>
            ) : (
              <span className="badge badge--accent">索引实时</span>
            )}
          </div>
        </div>
        <DotEyes awake={liveDataReady} />
      </section>

      <div className="metric-strip">
        <MetricStat
          label="书架"
          value={books?.data?.total ?? null}
          hint={`章节 ${books?.data?.chapterTotal ?? "—"}`}
          onClick={() => navigate("/books")}
        />
        <MetricStat
          label="选题"
          value={metrics.topics ?? null}
          hint={`候选 ${metrics.candidates ?? "—"}`}
          onClick={() => navigate("/topics")}
        />
        <MetricStat
          label="知识链接"
          value={graphData?.stats?.edgeCount ?? null}
          hint="知识星图双向关系"
          onClick={() => navigate("/graph")}
        />
        {localWorkbench ? (
          <MetricStat
            label="面试题库"
            value={
              career?.source === "live"
                ? (career.data?.questionBanks?.curated ?? []).length +
                  (career.data?.questionBanks?.raw ?? []).length
                : null
            }
            hint="求职备战"
            onClick={() => navigate("/career")}
          />
        ) : null}
        {localWorkbench ? (
          <MetricStat
            label="关注个股"
            value={watchlist?.source === "live" ? watchlist.data?.total ?? 0 : null}
            hint="重点个股"
            onClick={() => navigate("/stocks")}
          />
        ) : null}
      </div>

      <div className="overview-grid">
        <div className="overview-stack">
          <section className="panel graph-preview panel--hover" data-panel>
            <div className="graph-preview__overlay">
              <span className="eyebrow">KNOWLEDGE GRAPH</span>
            </div>
            {graphData && graphData.nodes.length > 0 ? (
              <>
                <KnowledgeGraph
                  edges={graphData.edges}
                  nodes={graphData.nodes}
                  preview
                />
                <span className="graph-preview__stats">
                  {graphData.stats.nodeCount} nodes · {graphData.stats.edgeCount} links
                </span>
              </>
            ) : (
              <div className="collection-empty">图谱数据加载中…</div>
            )}
            <button
              className="graph-preview__cta graph-filter graph-filter--on"
              onClick={() => navigate("/graph")}
              type="button"
            >
              进入星图 <IconArrowUpRight size={14} />
            </button>
          </section>

          <section className="panel" data-panel>
            <div className="panel__head">
              <div>
                <span className="eyebrow">RECENT</span>
                <h2 className="panel__title" style={{ marginTop: 8 }}>
                  最近更新
                </h2>
              </div>
            </div>
            <div className="recent-list">
              {recent.length === 0 ? (
                <div className="collection-empty">暂无记录</div>
              ) : (
                recent.map((item) => (
                  <div
                    className="recent-item"
                    key={item.id}
                    onClick={() => onOpenDocument?.(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onOpenDocument?.(item);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span
                      className={`status-dot${item.type === "Wiki" ? " status-dot--accent" : ""}`}
                    />
                    <span className="recent-item__title">{item.title}</span>
                    <span className="recent-item__meta">{item.section}</span>
                    <span className="recent-item__meta">
                      {formatCompactDate(item.updatedAt, false)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="overview-stack">
          <section className="panel" data-panel>
            <div className="panel__head">
              <div>
                <span className="eyebrow">AI HOT</span>
                <h2 className="panel__title" style={{ marginTop: 8 }}>
                  今日热点
                </h2>
              </div>
              <button
                className="graph-filter"
                onClick={() => navigate("/daily-hot")}
                type="button"
              >
                查看全部
              </button>
            </div>
            <div className="recent-list">
              {dailyHot == null ? (
                <div className="collection-empty">热点加载中…</div>
              ) : hotItems.length === 0 ? (
                <div className="collection-empty">
                  {dailyHot.source === "live" ? "今日暂无必读热点" : "热点服务不可用"}
                </div>
              ) : (
                hotItems.slice(0, 3).map((item, index) => {
                  const url = item.links?.story || item.links?.aihot;
                  return (
                    <a
                      className="recent-item"
                      href={url ?? "#"}
                      key={item.id ?? index}
                      style={{ color: "inherit", textDecoration: "none" }}
                      target={url ? "_blank" : undefined}
                      rel="noreferrer"
                    >
                      <span className="status-dot status-dot--accent" />
                      <span className="recent-item__title">{item.title}</span>
                      <span className="recent-item__meta">
                        {formatCompactDate(
                          item.latestAt || item.discoveredAt || item.publishedAt,
                          false,
                        )}
                      </span>
                    </a>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
