import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle,
  IconArrowsSort,
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconStar,
  IconStarFilled,
  IconX,
} from "@tabler/icons-react";

import { PageHeader } from "../components/PageHeader";
import {
  addStockPoolItem,
  followStock,
  getStockAnalysis,
  loadMarketQuotes,
  loadStockAlerts,
  loadStockFinancials,
  loadStockNews,
  loadStockPool,
  loadStockResearch,
  loadStockTechnicals,
  loadStockWatchlist,
  loadValuationHistory,
  loadWatchdogConfig,
  removeStockPoolItem,
  saveStockResearch,
  setStockCode,
  startStockResearch,
  testWatchdogPush,
  unfollowStock,
  updateStockMeta,
  updateWatchdogConfig,
} from "../lib/api";
import "../components/watchlist/watchlist.css";
import { DailyReviewPanel } from "../components/daily-review/DailyReviewPanel";
import { PortfolioPanel } from "../components/daily-review/PortfolioPanel";

function formatPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(2);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 研究评级（非涨跌）的信号灯色：积极=绿 / 中性观察=琥珀 / 谨慎回避=红。
// 与页面「涨红跌绿」是两个场景，互不混用。
function verdictTone(verdict) {
  if (!verdict) return "none";
  if (verdict.includes("积极")) return "positive";
  if (verdict.includes("谨慎") || verdict.includes("回避") || verdict.includes("卖出")) return "negative";
  if (verdict.includes("中性") || verdict.includes("观察") || verdict.includes("观望")) return "neutral";
  return "none";
}

// 私董会立场徽章色：沿用涨跌语义（看多=红 / 回避看空=绿 / 观望=琥珀）。
function stanceTone(stance) {
  if (!stance) return "none";
  if (stance.includes("看多") || stance.includes("买入") || stance.includes("持有") || stance.includes("All")) return "up";
  if (stance.includes("回避") || stance.includes("看空") || stance.includes("卖出")) return "down";
  if (stance.includes("观望") || stance.includes("等待") || stance.includes("条件")) return "wait";
  return "none";
}

// 入场动画会话内只播一次：二次进入直出内容，避免「重新加载」感。
let watchlistEntranceDone = false;

const VIEW_STORAGE_KEY = "workbench.watchlist-view.v1";
const CHAIN_TAB_STORAGE_KEY = "workbench.watchlist-chain.v1";

const STUDY_TABS = [
  { key: "overview", label: "总览" },
  { key: "debate", label: "分歧" },
  { key: "boardroom", label: "私董会" },
  { key: "monitor", label: "监控" },
  { key: "archive", label: "档案" },
];

function loadStoredView() {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function StockWatchlistPage({ onOpenDocument, syncRevision = 0 }) {
  const reduceMotion = useReducedMotion();
  const [universe, setUniverse] = useState({ data: null, source: "loading", error: null });
  const [followed, setFollowed] = useState(() => new Map()); // name -> {group,note}
  const [research, setResearch] = useState(() => new Map()); // name -> {generatedAt,report}
  const [quotes, setQuotes] = useState(() => new Map()); // code -> quote
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [onlyResearched, setOnlyResearched] = useState(false);
  // 多列排序链：[{ key, dir }]，空数组 = 池自然顺序。Shift+点击追加/翻转，单击重置单列。
  const [sortChain, setSortChain] = useState(() => []);
  const [viewMode, setViewMode] = useState(loadStoredView); // list（默认，扫描密度）| grid（卡片浏览）
  // 页面三区 Tab：今日复盘 / 个股清单 / 监控。localStorage 记忆，刷新后回到离开时的区。
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem("workbench.review-tab.v1") ?? "review"; } catch { return "review"; }
  });
  const [activeChain, setActiveChain] = useState(() => {
    try { return localStorage.getItem(CHAIN_TAB_STORAGE_KEY) ?? "all"; } catch { return "all"; }
  }); // "all" | chainLabel，链 Tab 当前分组
  const [selected, setSelected] = useState(() => new Set()); // 多选对比（公司名）
  const [detailName, setDetailName] = useState(null); // 详情展开的公司名
  const [codesDraft, setCodesDraft] = useState(() => new Map()); // name -> 编辑中的代码
  const [showAddStock, setShowAddStock] = useState(false); // 添加自选表单开关

  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, viewMode); } catch { /* 隐私模式等场景静默降级 */ }
  }, [viewMode]);

  useEffect(() => {
    try { localStorage.setItem("workbench.review-tab.v1", activeTab); } catch { /* 同上 */ }
  }, [activeTab]);

  useEffect(() => {
    try { localStorage.setItem(CHAIN_TAB_STORAGE_KEY, activeChain); } catch { /* 同上 */ }
  }, [activeChain]);

  const refresh = useCallback(async () => {
    setUniverse((current) => ({ ...current, source: current.data ? current.source : "loading" }));
    const [poolResult, watchlistResult, researchResult] = await Promise.all([
      loadStockPool(),
      loadStockWatchlist(),
      loadStockResearch(),
    ]);
    setUniverse(poolResult);
    if (watchlistResult.source === "live") {
      const map = new Map();
      for (const item of watchlistResult.data?.items ?? []) {
        map.set(item.name, { group: item.group, note: item.note });
      }
      setFollowed(map);
    }
    if (researchResult.source === "live") {
      const map = new Map();
      for (const entry of researchResult.data?.reports ?? []) {
        map.set(entry.name, { generatedAt: entry.generatedAt, report: entry.report });
      }
      setResearch(map);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, syncRevision]);

  // 拉行情（所有有代码的公司）
  useEffect(() => {
    if (universe.source !== "live") return;
    const codes = (universe.data?.items ?? []).filter((s) => s.code).map((s) => s.code);
    if (codes.length === 0) return;
    let cancelled = false;
    loadMarketQuotes(codes).then((result) => {
      if (cancelled || result.source !== "live") return;
      const map = new Map();
      for (const q of result.data?.items ?? []) map.set(q.code, q);
      setQuotes(map);
    });
    return () => { cancelled = true; };
  }, [universe.source, universe.data]);

  const total = universe.data?.total ?? 0;
  const isLoading = universe.source === "loading";
  const error = universe.error;

  const allStocks = useMemo(() => universe.data?.items ?? [], [universe.data]);

  // 列头排序：字段值取数器（行情字段从 quotes 取，其余取 stock 本身）。
  const sortValue = useCallback((stock, key) => {
    const quote = stock.code ? quotes.get(stock.code) : null;
    switch (key) {
      case "price": return quote?.price ?? null;
      case "pct": return quote?.changePct ?? null;
      case "turnover": return quote?.turnoverPct ?? null;
      case "volumeRatio": return quote?.volumeRatio ?? null;
      case "pe": return quote?.peTtm ?? null;
      case "pb": return quote?.pb ?? null;
      case "marketCap": return quote?.marketCap ?? null;
      case "code": return stock.code ?? null;
      case "board": return stock.board ?? (stock.custom ? "自选" : null);
      default: return stock[key] ?? null;
    }
  }, [quotes]);

  const visibleStocks = useMemo(() => {
    let list = allStocks;
    if (onlyFollowed) list = list.filter((s) => followed.has(s.name));
    if (onlyResearched) list = list.filter((s) => research.has(s.name));
    if (sortChain.length > 0) {
      list = [...list].sort((a, b) => {
        // 依次按排序链各列比较；缺失值统一沉底（不参与方向）。
        for (const { key, dir } of sortChain) {
          const va = sortValue(a, key);
          const vb = sortValue(b, key);
          if (va == null && vb == null) continue;
          if (va == null) return 1;
          if (vb == null) return -1;
          const cmp = typeof va === "number" && typeof vb === "number"
            ? va - vb
            : String(va).localeCompare(String(vb), "zh-CN");
          if (cmp !== 0) return cmp * dir;
        }
        return 0;
      });
    }
    return list;
  }, [allStocks, onlyFollowed, onlyResearched, followed, research, sortChain, sortValue]);

  // 列头点击：单击重置为单列降序；Shift+点击追加到链尾（已在链中则翻转方向）。
  const applySort = useCallback((key, additive) => {
    setSortChain((current) => {
      if (!additive) return [{ key, dir: -1 }];
      const existing = current.find((c) => c.key === key);
      if (existing) {
        return current.map((c) => (c.key === key ? { ...c, dir: -c.dir } : c));
      }
      return [...current, { key, dir: -1 }];
    });
  }, []);

  const resetSort = useCallback(() => setSortChain([]), []);

  // 链 Tab 选项基于全量分组（不受「只看已关注/有档案」筛选影响），保证导航稳定。
  const chainTabOptions = useMemo(() => {
    const groups = new Map();
    for (const stock of allStocks) {
      if (!groups.has(stock.chainLabel)) groups.set(stock.chainLabel, 0);
      groups.set(stock.chainLabel, groups.get(stock.chainLabel) + 1);
    }
    return [
      { key: "all", label: "全部", count: allStocks.length },
      ...[...groups.entries()].map(([label, count]) => ({ key: label, label, count })),
    ];
  }, [allStocks]);

  // 链 Tab 当前分组失效（数据变化）时回退「全部」。
  const activeChainValid = activeChain === "all" || chainTabOptions.some((t) => t.key === activeChain);
  const effectiveChain = activeChainValid ? activeChain : "all";

  // 单一表格：链 Tab 只做筛选（不再分组渲染），排序/筛选后的行按序展示。
  const displayStocks = useMemo(
    () => (effectiveChain === "all"
      ? visibleStocks
      : visibleStocks.filter((s) => s.chainLabel === effectiveChain)),
    [visibleStocks, effectiveChain],
  );

  const totalFollowed = followed.size;

  const toggleFollow = useCallback(async (name) => {
    const isFollowed = followed.has(name);
    setFollowed((current) => {
      const next = new Map(current);
      if (isFollowed) next.delete(name);
      else next.set(name, { group: null, note: null });
      return next;
    });
    try {
      if (isFollowed) await unfollowStock(name);
      else await followStock(name);
    } catch {
      setFollowed((current) => {
        const next = new Map(current);
        if (isFollowed) next.set(name, { group: null, note: null });
        else next.delete(name);
        return next;
      });
    }
  }, [followed]);

  const toggleSelect = useCallback((name) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const saveCode = useCallback(async (name) => {
    const code = (codesDraft.get(name) ?? "").trim();
    await setStockCode(name, code || null);
    setCodesDraft((current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
    void refresh();
  }, [codesDraft, refresh]);

  // 自选池：移除自选股（默认池股票不提供移除入口）。
  const removeCustomStock = useCallback(async (name) => {
    try {
      await removeStockPoolItem(name);
      void refresh();
    } catch {
      /* 移除失败静默（下次刷新回滚显示） */
    }
  }, [refresh]);

  // 抽屉生成完成后的落库回调：优先用服务端规整后的快照，失败则本地兜底展示。
  const handleResearchSaved = useCallback((name, entry) => {
    setResearch((current) => new Map(current).set(name, entry));
  }, []);

  const enter = reduceMotion || watchlistEntranceDone ? {} : {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
  };

  useEffect(() => {
    watchlistEntranceDone = true;
  }, []);

  if (isLoading) {
    return (
      <div className="page page--watchlist">
        <div className="watchlist-loading">
          <div className="skeleton" style={{ height: 28, width: "55%" }} />
          <div className="skeleton" style={{ height: 120, marginTop: 24 }} />
          <div className="skeleton" style={{ height: 260, marginTop: 16 }} />
          <div className="skeleton" style={{ height: 260, marginTop: 16 }} />
        </div>
      </div>
    );
  }

  const headerAside = (
    <div className="watchlist-summary">
      <div><strong>{total || "—"}</strong><span>总家数</span></div>
      <div><strong>{totalFollowed}</strong><span>已关注</span></div>
      <div><strong>{research.size}</strong><span>已建档案</span></div>
      <div><strong>{selected.size}</strong><span>对比中</span></div>
    </div>
  );

  return (
    <div className={`page page--watchlist${viewMode === "list" ? " page--watchlist-density" : ""}`}>
      <PageHeader
        eyebrow="MARKET · DAILY REVIEW"
        title="每日复盘"
        description="每日复盘各大指数走势与当日重要事件；下方保留科技半导体个股清单——AI 按研究方法论打底座，判断留给你。研究辅助，不构成投资建议。"
        aside={headerAside}
      />

      <div className="review-tabs" role="tablist" aria-label="复盘分区">
        {[["review", "今日复盘"], ["list", "个股清单"], ["monitor", "监控"]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            className={`review-tabs__tab${activeTab === key ? " review-tabs__tab--active" : ""}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "review" ? (
        <DailyReviewPanel
          portfolioSlot={<PortfolioPanel stocks={allStocks} />}
          stocks={allStocks}
        />
      ) : null}

      {activeTab === "list" ? (
        <>
      <div className="watchlist-toolbar">
        <span className="watchlist-source">
          {universe.source === "live" ? "行情已连接" : universe.source === "fallback" ? "降级模式" : "—"}
        </span>
        <div className="watchlist-toolbar__actions">
          <div className="watchlist-seg" role="group" aria-label="视图切换">
            <button
              type="button"
              className={`watchlist-seg__btn${viewMode === "list" ? " watchlist-seg__btn--active" : ""}`}
              onClick={() => setViewMode("list")}
              aria-pressed={viewMode === "list"}
            >
              <IconList size={15} stroke={1.7} /> 清单
            </button>
            <button
              type="button"
              className={`watchlist-seg__btn${viewMode === "grid" ? " watchlist-seg__btn--active" : ""}`}
              onClick={() => setViewMode("grid")}
              aria-pressed={viewMode === "grid"}
            >
              <IconLayoutGrid size={15} stroke={1.7} /> 卡片
            </button>
          </div>
          <label className="watchlist-filter">
            <input type="checkbox" checked={onlyFollowed} onChange={(e) => setOnlyFollowed(e.target.checked)} />
            <span>只看已关注</span>
          </label>
          <label className="watchlist-filter">
            <input type="checkbox" checked={onlyResearched} onChange={(e) => setOnlyResearched(e.target.checked)} />
            <span>只看有档案</span>
          </label>
          <button
            type="button"
            className="watchlist-refresh"
            onClick={() => setShowAddStock((v) => !v)}
            aria-expanded={showAddStock}
          >
            <IconPlus size={16} stroke={1.7} /> 添加自选
          </button>
          <button type="button" className="watchlist-refresh" onClick={refresh}>
            <IconRefresh size={16} stroke={1.7} /> 刷新
          </button>
        </div>
      </div>

      {error && universe.source === "fallback" && allStocks.length === 0 ? (
        <div className="watchlist-empty watchlist-empty--error">
          <IconAlertTriangle size={20} stroke={1.7} />
          <p>无法加载个股清单。{error?.message ? `（${error.message}）` : ""}</p>
        </div>
      ) : null}

      <div className="watchlist-chaintabs" role="tablist" aria-label="链分组">
        {chainTabOptions.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={effectiveChain === t.key}
            className={`watchlist-chaintabs__btn${effectiveChain === t.key ? " watchlist-chaintabs__btn--active" : ""}`}
            onClick={() => setActiveChain(t.key)}
          >
            {t.label}
            <span className="watchlist-chaintabs__count">{t.count}</span>
          </button>
        ))}
      </div>

      {showAddStock ? (
        <AddStockForm
          onAdded={() => { setShowAddStock(false); void refresh(); }}
          onCancel={() => setShowAddStock(false)}
        />
      ) : null}

      {selected.size >= 2 ? (
        <CompareBar
          stocks={allStocks.filter((s) => selected.has(s.name))}
          quotes={quotes}
          research={research}
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {displayStocks.length === 0 && !isLoading ? (
        <div className="watchlist-empty">
          <p>{onlyFollowed || onlyResearched ? "当前筛选条件下暂无个股。" : "暂无个股数据。"}</p>
        </div>
      ) : null}

      {displayStocks.length > 0 ? (
        <motion.section
          className={`watchlist-chain${viewMode === "list" ? " watchlist-chain--list" : ""}`}
          {...enter}
        >
          {viewMode === "list" ? (
            <div className="watchlist-list">
              <div className="watchlist-list__head" role="row">
                {[
                  ["name", "公司"],
                  ["code", "代码"],
                  ["chainLabel", "国产链/海外链"],
                  ["board", "板块"],
                  ["price", "现价"],
                  ["pct", "涨跌幅"],
                  ["turnover", "换手"],
                  ["volumeRatio", "量比"],
                  ["pe", "PE"],
                  ["pb", "PB"],
                ].map(([key, label]) => {
                  const order = sortChain.findIndex((c) => c.key === key);
                  const entry = order >= 0 ? sortChain[order] : null;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`watchlist-list__th${entry ? " watchlist-list__th--active" : ""}`}
                      onClick={(e) => applySort(key, e.shiftKey)}
                      aria-label={`按${label}排序（Shift+点击追加排序）`}
                      title={`按${label}排序（Shift+点击追加排序）`}
                    >
                      {label}
                      {entry ? (
                        <span className="watchlist-list__th-arrow">
                          {entry.dir > 0 ? "↑" : "↓"}
                          {sortChain.length > 1 ? <sub>{order + 1}</sub> : null}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                <span>研究评级</span>
                <span />
                {sortChain.length > 0 ? (
                  <button
                    type="button"
                    className="watchlist-list__sort-reset"
                    onClick={resetSort}
                    aria-label="清空排序，恢复池自然顺序"
                    title="清空排序，恢复池自然顺序"
                  >
                    <IconArrowsSort size={14} stroke={1.7} />
                  </button>
                ) : (
                  <span />
                )}
              </div>
              {displayStocks.map((stock) => (
                <StockRow
                  key={stock.name}
                  stock={stock}
                  quote={quotes.get(stock.code)}
                  isFollowed={followed.has(stock.name)}
                  researchEntry={research.get(stock.name)}
                  onOpenDetail={() => setDetailName(stock.name)}
                  onToggleFollow={() => toggleFollow(stock.name)}
                  onRemoveCustom={stock.custom ? () => removeCustomStock(stock.name) : null}
                />
              ))}
            </div>
          ) : (
            <div className="watchlist-grid">
              {displayStocks.map((stock) => (
                <StockCard
                  key={stock.name}
                  stock={stock}
                  isFollowed={followed.has(stock.name)}
                  researchEntry={research.get(stock.name)}
                  quote={quotes.get(stock.code)}
                  isSelected={selected.has(stock.name)}
                  codeDraft={codesDraft.get(stock.name)}
                  onToggleFollow={() => toggleFollow(stock.name)}
                  onToggleSelect={() => toggleSelect(stock.name)}
                  onOpenDetail={() => setDetailName(stock.name)}
                  onCodeDraft={(v) => setCodesDraft((c) => new Map(c).set(stock.name, v))}
                  onSaveCode={() => saveCode(stock.name)}
                />
              ))}
            </div>
          )}
        </motion.section>
      ) : null}

      {detailName ? (
        <StockResearchDrawer
          stock={allStocks.find((s) => s.name === detailName)}
          quote={quotes.get(allStocks.find((s) => s.name === detailName)?.code)}
          meta={followed.get(detailName)}
          researchEntry={research.get(detailName)}
          reduceMotion={reduceMotion}
          onClose={() => setDetailName(null)}
          onOpenDocument={onOpenDocument}
          onResearchSaved={handleResearchSaved}
          onSaveMeta={(meta) => {
            updateStockMeta(detailName, meta).then(() => refresh());
            setFollowed((c) => new Map(c).set(detailName, { ...(c.get(detailName) || {}), ...meta }));
          }}
        />
      ) : null}
        </>
      ) : null}

      {activeTab === "monitor" ? (
        <>
          <AlertsPanel />
          <WatchdogPanel />
        </>
      ) : null}
    </div>
  );
}

// 清单视图行：一行一股，整行可点开研究台，星标独立操作。
function StockRow({ stock, quote, isFollowed, researchEntry, onOpenDetail, onToggleFollow, onRemoveCustom }) {
  const pct = quote?.changePct;
  const pctClass = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const verdict = researchEntry?.report?.rating?.verdict;
  const tone = verdictTone(verdict);
  const num = (v, digits = 2) => (v == null ? "—" : Number(v).toFixed(digits));
  return (
    <div
      className="watchlist-list__row"
      onClick={onOpenDetail}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail();
        }
      }}
    >
      <span className="watchlist-list__name">
        {stock.name}
        {stock.custom ? <span className="watchlist-list__custom-tag">自选</span> : null}
      </span>
      <span className={`watchlist-list__code${stock.code ? "" : " watchlist-list__code--none"}`}>
        {stock.code ?? "无代码"}
      </span>
      <span className="watchlist-list__chain">{stock.chainLabel ?? "—"}</span>
      <span className="watchlist-list__board">{stock.board ?? (stock.custom ? "自选" : "—")}</span>
      <span className="watchlist-list__price">{formatPrice(quote?.price)}</span>
      <span className={`watchlist-list__pct watchlist-list__pct--${pctClass}`}>{formatPct(pct)}</span>
      <span className="watchlist-list__num">{num(quote?.turnoverPct)}</span>
      <span className="watchlist-list__num">{num(quote?.volumeRatio)}</span>
      <span className="watchlist-list__num">{num(quote?.peTtm, 1)}</span>
      <span className="watchlist-list__num">{num(quote?.pb, 1)}</span>
      <span className="watchlist-list__verdict">
        {verdict ? <span className={`watchlist-badge watchlist-badge--${tone}`}>{verdict}</span> : <span className="watchlist-list__none">未研究</span>}
      </span>
      <button
        type="button"
        className={`watchlist-list__star${isFollowed ? " watchlist-list__star--on" : ""}`}
        onClick={(e) => { e.stopPropagation(); onToggleFollow(); }}
        aria-label={isFollowed ? `取消关注 ${stock.name}` : `关注 ${stock.name}`}
      >
        {isFollowed ? <IconStarFilled size={16} /> : <IconStar size={16} />}
      </button>
      {onRemoveCustom ? (
        <button
          type="button"
          className="watchlist-list__go watchlist-list__go--remove"
          onClick={(e) => { e.stopPropagation(); onRemoveCustom(); }}
          title="从自选池移除"
        >
          移除
        </button>
      ) : (
        <span className="watchlist-list__go">详情</span>
      )}
    </div>
  );
}

function StockCard({ stock, isFollowed, researchEntry, quote, isSelected, codeDraft, onToggleFollow, onToggleSelect, onOpenDetail, onCodeDraft, onSaveCode }) {
  const pct = quote?.changePct;
  const pctClass = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const verdict = researchEntry?.report?.rating?.verdict;
  const tone = verdictTone(verdict);
  return (
    <article className={`watchlist-card${isFollowed ? " watchlist-card--followed" : ""}${isSelected ? " watchlist-card--selected" : ""}`}>
      <div className="watchlist-card__head">
        <input
          type="checkbox"
          className="watchlist-card__check"
          checked={isSelected}
          onChange={onToggleSelect}
          aria-label={`选择 ${stock.name} 对比`}
        />
        <span className="watchlist-card__name" onClick={onOpenDetail} role="button" tabIndex={0}>
          {researchEntry ? (
            <span className={`watchlist-verdict-dot watchlist-verdict-dot--${tone}`} title={`研究评级：${verdict ?? "见档案"}`} />
          ) : null}
          {stock.name}
        </span>
        <button type="button" className="watchlist-card__star" onClick={onToggleFollow}
          aria-label={isFollowed ? `取消关注 ${stock.name}` : `关注 ${stock.name}`}>
          {isFollowed ? <IconStarFilled size={18} /> : <IconStar size={18} />}
        </button>
      </div>
      <div className="watchlist-card__quote" onClick={onOpenDetail} role="button" tabIndex={0}>
        <span className={`watchlist-card__price watchlist-card__price--${pctClass}`}>
          {formatPrice(quote?.price)}
        </span>
        <span className={`watchlist-card__pct watchlist-card__pct--${pctClass}`}>
          {formatPct(quote?.changePct)}
        </span>
        {researchEntry ? <span className="watchlist-card__studied">已研究</span> : null}
      </div>
      <p className="watchlist-card__note">{stock.note}</p>
      <div className="watchlist-card__foot">
        {stock.code ? (
          <span className="watchlist-card__code">{stock.code}</span>
        ) : (
          <span className="watchlist-card__code watchlist-card__code--none">无代码</span>
        )}
        {stock.hasEntityPage && stock.entityPageId ? (
          <button type="button" className="watchlist-card__detail" onClick={() => onOpenDocument?.(stock.entityPageId)}>
            实体页
          </button>
        ) : (
          <span className="watchlist-card__pending">待建</span>
        )}
        <button type="button" className="watchlist-card__detail" onClick={onOpenDetail}>
          详情
        </button>
      </div>
      {codeDraft !== undefined ? (
        <div className="watchlist-card__code-edit">
          <input
            value={codeDraft}
            onChange={(e) => onCodeDraft(e.target.value)}
            placeholder="6 位代码"
            autoFocus
          />
          <button type="button" onClick={onSaveCode}>保存</button>
        </div>
      ) : null}
    </article>
  );
}

function CompareBar({ stocks, quotes, research, onClear }) {
  return (
    <div className="watchlist-compare">
      <div className="watchlist-compare__head">
        <strong>对比 {stocks.length} 只</strong>
        <button type="button" onClick={onClear} aria-label="清除对比"><IconX size={16} /></button>
      </div>
      <div className="watchlist-compare__table">
        <table>
          <thead>
            <tr>
              <th>公司</th>
              <th>现价</th>
              <th>涨跌幅</th>
              <th>研究评级</th>
              <th>链</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((s) => {
              const q = quotes.get(s.code);
              const pct = q?.changePct;
              const verdict = research.get(s.name)?.report?.rating?.verdict;
              return (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{formatPrice(q?.price)}</td>
                  <td className={pct == null ? "" : pct > 0 ? "watchlist-up" : pct < 0 ? "watchlist-down" : ""}>
                    {formatPct(pct)}
                  </td>
                  <td>
                    {verdict ? (
                      <span className={`watchlist-badge watchlist-badge--${verdictTone(verdict)}`}>{verdict}</span>
                    ) : "—"}
                  </td>
                  <td>{s.chainLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===== 研究台抽屉：按「事实底座 → 技术面速读 → 四维评级 → 多空分歧 → 私董会 → 监控清单」组织 =====

function StudySection({ title, tag, children }) {
  return (
    <div className="watchlist-study__section">
      <div className="watchlist-study__section-head">
        <h4>{title}</h4>
        {tag ? (
          <span className={`watchlist-tag ${tag === "事实" ? "watchlist-tag--fact" : "watchlist-tag--opinion"}`}>{tag}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function RatingBlock({ rating }) {
  if (!rating) return null;
  const { dimensions = [], total, verdict, oneLiner } = rating;
  const tone = verdictTone(verdict);
  return (
    <StudySection title="综合评级" tag="判断">
      <div className="watchlist-study__rating-top">
        <span className="watchlist-study__score">
          {total != null ? Number(total).toFixed(2) : "—"}/5
        </span>
        {verdict ? <span className={`watchlist-badge watchlist-badge--${tone}`}>{verdict}</span> : null}
      </div>
      {oneLiner ? <p className="watchlist-study__oneliner">{oneLiner}</p> : null}
      {dimensions.length ? (
        <div className="watchlist-study__dims">
          {dimensions.map((d, i) => {
            const score = Math.max(0, Math.min(5, Number(d.score) || 0));
            return (
              <div key={d.key ?? i} className="watchlist-study__dim">
                <div className="watchlist-study__dim-head">
                  <span>{d.label}</span>
                  <span className="watchlist-study__dim-score">
                    {d.score != null ? `${Number(d.score).toFixed(1)}` : "—"}
                    {d.weight != null ? ` × ${Math.round(Number(d.weight) * 100)}%` : ""}
                  </span>
                </div>
                <div className="watchlist-study__dim-bar"><span style={{ width: `${(score / 5) * 100}%` }} /></div>
                {d.comment ? <p className="watchlist-study__dim-comment">{d.comment}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </StudySection>
  );
}

function FactsBlock({ facts }) {
  if (!facts) return null;
  return (
    <StudySection title="事实底座" tag="事实">
      {facts.oneLiner ? <p className="watchlist-study__oneliner">{facts.oneLiner}</p> : null}
      <dl className="watchlist-study__facts">
        {facts.industry ? <div><dt>行业</dt><dd>{facts.industry}</dd></div> : null}
        {facts.position ? <div><dt>产业链位置</dt><dd>{facts.position}</dd></div> : null}
      </dl>
      {facts.business?.length ? (
        <ul className="watchlist-study__list">
          {facts.business.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      ) : null}
      {facts.limitations ? <p className="watchlist-study__limitations">数据边界：{facts.limitations}</p> : null}
    </StudySection>
  );
}

function TechnicalsBlock({ technicals }) {
  if (!technicals) return null;
  const hasLevels = technicals.support?.length || technicals.resistance?.length;
  return (
    <StudySection title="技术面速读" tag="判断">
      {technicals.trend ? <p className="watchlist-study__oneliner">{technicals.trend}</p> : null}
      {technicals.signals?.length ? (
        <ul className="watchlist-study__list">
          {technicals.signals.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      ) : null}
      {hasLevels ? (
        <div className="watchlist-study__levels">
          <div>
            <h5>支撑</h5>
            {(technicals.support ?? []).map((item, i) => <span key={i}>{item}</span>)}
          </div>
          <div>
            <h5>压力</h5>
            {(technicals.resistance ?? []).map((item, i) => <span key={i}>{item}</span>)}
          </div>
        </div>
      ) : null}
      {technicals.dataNote ? <p className="watchlist-study__limitations">{technicals.dataNote}</p> : null}
    </StudySection>
  );
}

function DebateBlock({ debate }) {
  if (!debate) return null;
  return (
    <div className="watchlist-study__debate">
      <div className="watchlist-study__debate-col watchlist-study__debate-col--bull">
        <h4>多方逻辑</h4>
        {debate.bulls?.length ? debate.bulls.map((item, i) => (
          <div key={i} className="watchlist-study__stance">
            <p>{item.point}</p>
            {item.evidence ? <span>{item.evidence}</span> : null}
          </div>
        )) : <p className="watchlist-study__empty">缺失</p>}
      </div>
      <div className="watchlist-study__debate-col watchlist-study__debate-col--bear">
        <h4>空方逻辑</h4>
        {debate.bears?.length ? debate.bears.map((item, i) => (
          <div key={i} className="watchlist-study__stance">
            <p>{item.point}</p>
            {item.evidence ? <span>{item.evidence}</span> : null}
          </div>
        )) : <p className="watchlist-study__empty">缺失</p>}
      </div>
      {debate.verifications?.length ? (
        <div className="watchlist-study__verifications">
          <h4>可验证的分歧</h4>
          <ul>
            {debate.verifications.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function BoardroomBlock({ boardroom }) {
  if (!boardroom?.length) return <p className="watchlist-study__empty">私董会记录缺失。</p>;
  return (
    <div className="watchlist-study__boardroom">
      <p className="watchlist-study__boardroom-hint">幕僚观点允许对立——分歧本身就是价值，不强行统一。</p>
      {boardroom.map((member, i) => (
        <div key={i} className="watchlist-study__member">
          <div className="watchlist-study__member-head">
            <strong>{member.name}</strong>
            {member.stance ? (
              <span className={`watchlist-badge watchlist-badge--${stanceTone(member.stance)}`}>{member.stance}</span>
            ) : null}
          </div>
          {member.view ? <p>{member.view}</p> : null}
        </div>
      ))}
    </div>
  );
}

function MonitorBlock({ monitor }) {
  if (!monitor?.length) return <p className="watchlist-study__empty">尚未建立监控清单。</p>;
  return (
    <div className="watchlist-study__monitor">
      {monitor.map((item, i) => (
        <div key={i} className={`watchlist-study__watch${item.type === "falsify" ? " watchlist-study__watch--falsify" : ""}`}>
          <span className="watchlist-study__watch-type">{item.type === "falsify" ? "一旦恶化 → 证伪退出" : "当事件发生 → 强化逻辑"}</span>
          <p>{item.event}</p>
          {item.action ? <span>{item.action}</span> : null}
        </div>
      ))}
    </div>
  );
}

function StudyIntro({ running, onRun }) {
  return (
    <div className="watchlist-study__intro">
      <h3>个股研究框架</h3>
      <p>AI 只做研究助理：把事实底座打牢、把多空摆上一张表、再请四位幕僚找反证——判断留给你。</p>
      <ol>
        <li><strong>事实底座</strong>它是干什么的，在产业链哪个环节</li>
        <li><strong>技术面速读</strong>趋势、信号与关键位置</li>
        <li><strong>综合评级</strong>技术 / 基本 / 估值 / 资金四维加权</li>
        <li><strong>多空分歧</strong>双方论点与可验证节点，不站队</li>
        <li><strong>私董会</strong>四位幕僚交叉辩论，逼出反证</li>
        <li><strong>监控清单</strong>当事件发生→强化；一旦恶化→证伪退出</li>
      </ol>
      <button type="button" className="watchlist-study__run" onClick={onRun} disabled={running}>
        <IconSparkles size={16} stroke={1.7} />
        {running ? "研究中…" : "AI 生成研究报告"}
      </button>
      <span className="watchlist-study__intro-note">基于近期新闻与行情生成；报告是研究辅助，不构成投资建议。</span>
    </div>
  );
}

function StockResearchDrawer({ stock, quote, meta, researchEntry, reduceMotion, onClose, onOpenDocument, onResearchSaved, onSaveMeta }) {
  const [group, setGroup] = useState(meta?.group ?? "");
  const [note, setNote] = useState(meta?.note ?? "");
  const [news, setNews] = useState(null);
  const [tab, setTab] = useState("overview");
  const [task, setTask] = useState(null); // research 生成任务

  const report = researchEntry?.report ?? null;

  useEffect(() => {
    if (!stock) return;
    let cancelled = false;
    loadStockNews(stock.name, stock.code).then((r) => {
      if (!cancelled && r.source === "live") setNews(r.data?.items ?? []);
    });
    return () => { cancelled = true; };
  }, [stock]);

  if (!stock) return null;

  const runResearch = async () => {
    setTask({ status: "running" });
    try {
      const started = await startStockResearch({ name: stock.name, note: stock.note, code: stock.code });
      const poll = async () => {
        const result = await getStockAnalysis(started?.id);
        if (result?.status === "completed") {
          const generatedAt = result.result?.generatedAt ?? new Date().toISOString();
          try {
            const entry = await saveStockResearch(stock.name, { generatedAt, report: result.result });
            onResearchSaved?.(stock.name, entry);
          } catch {
            onResearchSaved?.(stock.name, { name: stock.name, generatedAt, report: result.result });
          }
          setTask({ status: "done" });
        } else if (result?.status === "failed") {
          setTask({ status: "failed", error: result.error });
        } else {
          setTimeout(poll, 2000);
        }
      };
      poll();
    } catch (error) {
      setTask({ status: "failed", error: error?.message ?? "研究任务启动失败。" });
    }
  };

  const verdict = report?.rating?.verdict;
  const tone = verdictTone(verdict);
  const tabEnter = reduceMotion ? {} : {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
  };

  return (
    <div className="watchlist-detail-mask" onClick={onClose}>
      <div className="watchlist-detail" onClick={(e) => e.stopPropagation()}>
        <div className="watchlist-detail__head">
          <div>
            <h2>
              {stock.name} {stock.code ? <span className="watchlist-card__code">({stock.code})</span> : null}
              {verdict ? (
                <span className={`watchlist-badge watchlist-badge--${tone}`}>{verdict}</span>
              ) : null}
            </h2>
            <p>
              {stock.chainLabel} · {stock.segment}
              {researchEntry?.generatedAt ? ` · 档案生成于 ${formatDate(researchEntry.generatedAt)}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭详情"><IconX size={20} /></button>
        </div>

        <div className="watchlist-detail__quote">
          <span className="watchlist-card__price">{formatPrice(quote?.price)}</span>
          <span className={`watchlist-card__pct watchlist-card__pct--${quote?.changePct > 0 ? "up" : quote?.changePct < 0 ? "down" : "flat"}`}>
            {formatPct(quote?.changePct)}
          </span>
          {report ? (
            <button type="button" className="watchlist-study__rerun" onClick={runResearch} disabled={task?.status === "running"}>
              <IconRefresh size={14} stroke={1.7} /> {task?.status === "running" ? "重新研究中…" : "重新生成"}
            </button>
          ) : null}
        </div>

        {!report ? (
          <>
            <StudyIntro running={task?.status === "running"} onRun={runResearch} />
            {task?.status === "running" ? (
              <div className="watchlist-study__loading">
                <div className="skeleton" style={{ height: 14 }} />
                <div className="skeleton" style={{ height: 14, width: "85%" }} />
                <div className="skeleton" style={{ height: 14, width: "70%" }} />
              </div>
            ) : null}
            {task?.status === "failed" ? (
              <div className="watchlist-detail__analysis watchlist-detail__analysis--error">{task.error}</div>
            ) : null}
            {/* 真实数据基本面不依赖 AI 报告：未研究态也展示 */}
            {stock.code ? <LiveFundamentalsBlock code={stock.code} /> : null}
          </>
        ) : (
          <>
            <div className="watchlist-study__tabs" role="tablist">
              {STUDY_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`watchlist-study__tab${tab === t.key ? " watchlist-study__tab--active" : ""}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <motion.div key={tab} {...tabEnter} className="watchlist-study__panel">
              {tab === "overview" ? (
                <>
                  <RatingBlock rating={report.rating} />
                  <FactsBlock facts={report.facts} />
                  <TechnicalsBlock technicals={report.technicals} />
                  {stock.code ? <LiveFundamentalsBlock code={stock.code} /> : null}
                </>
              ) : null}
              {tab === "debate" ? <DebateBlock debate={report.debate} /> : null}
              {tab === "boardroom" ? <BoardroomBlock boardroom={report.boardroom} /> : null}
              {tab === "monitor" ? <MonitorBlock monitor={report.monitor} /> : null}
              {tab === "archive" ? (
                <>
                  {report.sentiment?.sentiment || report.sentiment?.summary ? (
                    <StudySection title="新闻情绪" tag="参考">
                      <div className="watchlist-study__rating-top">
                        {report.sentiment.sentiment ? <strong>{report.sentiment.sentiment}</strong> : null}
                        {report.sentiment.score != null ? <span className="watchlist-study__dim-score">{report.sentiment.score}/5</span> : null}
                      </div>
                      {report.sentiment.summary ? <p className="watchlist-study__oneliner">{report.sentiment.summary}</p> : null}
                    </StudySection>
                  ) : null}
                  <div className="watchlist-detail__meta">
                    <label>分组</label>
                    <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="如 核心持仓 / 观察中" />
                    <label>我的备注（判断写在这里，与 AI 报告分开）</label>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录你的判断或跟踪点" rows={3} />
                    <button type="button" className="watchlist-detail__save" onClick={() => onSaveMeta({ group: group || null, note: note || null })}>
                      保存分组备注
                    </button>
                  </div>
                  <div className="watchlist-detail__actions">
                    {stock.hasEntityPage && stock.entityPageId ? (
                      <button type="button" onClick={() => onOpenDocument?.(stock.entityPageId)}>查看实体页</button>
                    ) : (
                      <span className="watchlist-card__pending">实体页待建</span>
                    )}
                  </div>
                  {news && news.length > 0 ? (
                    <div className="watchlist-detail__news">
                      <h3>近期新闻 <span className="watchlist-study__news-hint">仅作情绪与事实参考</span></h3>
                      {news.slice(0, 5).map((n, i) => (
                        <a key={i} href={n.url} target="_blank" rel="noreferrer">
                          <span className="watchlist-detail__news-title">{n.title}</span>
                          <span className="watchlist-detail__news-meta">{n.mediaName} · {n.date}</span>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </motion.div>
          </>
        )}

        <p className="watchlist-disclaimer">AI 研究辅助 · 不构成投资建议 · 判断与风险自负</p>
      </div>
    </div>
  );
}


// ===== 监控台 v2 组件：实时基本面块 / 异动中心 / 盯盘配置 / 添加自选 =====

// 真实数据基本面：新浪财务 + 自建估值分位 + 日K均线速览（区别于 AI 研究报告的生成内容）。
function LiveFundamentalsBlock({ code }) {
  const [financials, setFinancials] = useState(null);
  const [valuation, setValuation] = useState(null);
  const [technicals, setTechnicals] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadStockFinancials(code).then((r) => { if (!cancelled) setFinancials(r); });
    loadValuationHistory(code).then((r) => { if (!cancelled) setValuation(r); });
    loadStockTechnicals(code).then((r) => { if (!cancelled) setTechnicals(r); });
    return () => { cancelled = true; };
  }, [code]);

  const trendLabel = { bullish: "多头排列", bearish: "空头排列", mixed: "均线纠缠", unknown: "样本不足" };
  const num = (v, digits = 2) => (v == null ? "—" : Number(v).toFixed(digits));
  const fin = financials?.source === "live" ? financials.data : null;
  const val = valuation?.source === "live" ? valuation.data : null;
  const tec = technicals?.source === "live" ? technicals.data : null;

  return (
    <div className="watchlist-live">
      <div className="watchlist-live__head">
        <span className="watchlist-live__tag">LIVE DATA</span>
        <h4>实时基本面（真实数据源）</h4>
      </div>

      {fin ? (
        fin.available && fin.periods?.length ? (
          <div className="watchlist-live__section">
            <h5>财务指标（新浪，最新四期）</h5>
            <div className="watchlist-live__table">
              <table>
                <thead>
                  <tr>
                    <th>报告期</th><th>ROE%</th><th>毛利率%</th><th>净利增速%</th><th>营收增速%</th><th>负债率%</th><th>EPS</th>
                  </tr>
                </thead>
                <tbody>
                  {fin.periods.slice(0, 4).map((p) => (
                    <tr key={p.reportDate}>
                      <td>{p.reportDate}</td>
                      <td>{num(p.roe)}</td>
                      <td>{num(p.grossMargin)}</td>
                      <td className={(p.netProfitGrowth ?? 0) > 0 ? "watchlist-up" : "watchlist-down"}>{num(p.netProfitGrowth, 1)}</td>
                      <td className={(p.revenueGrowth ?? 0) > 0 ? "watchlist-up" : "watchlist-down"}>{num(p.revenueGrowth, 1)}</td>
                      <td>{num(p.debtRatio)}</td>
                      <td>{num(p.eps, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="watchlist-live__empty">财务数据不可用（新浪源缺失或解析失败）。</p>
        )
      ) : <p className="watchlist-live__empty">财务数据加载中…</p>}

      {val ? (
        <div className="watchlist-live__section">
          <h5>估值水位</h5>
          <div className="watchlist-live__valuation">
            <span>PE(TTM) <strong>{num(val.current?.pe, 1)}</strong></span>
            <span>PB <strong>{num(val.current?.pb, 1)}</strong></span>
            <span>
              分位 <strong>
                {val.percentile?.pe != null ? `${val.percentile.pe}%` : "样本积累中"}
              </strong>
            </span>
            {val.since ? <em>（自建序列自 {val.since} 起，每日快照积累）</em> : <em>（watchdog 收盘后开始积累）</em>}
          </div>
        </div>
      ) : null}

      {tec ? (
        <div className="watchlist-live__section">
          <h5>均线速览（日K 前复权）</h5>
          <div className="watchlist-live__ma">
            <span>MA5 <strong>{num(tec.ma?.ma5, 1)}</strong></span>
            <span>MA20 <strong>{num(tec.ma?.ma20, 1)}</strong></span>
            <span>MA60 <strong>{num(tec.ma?.ma60, 1)}</strong></span>
            <span className={`watchlist-live__trend watchlist-live__trend--${tec.trend}`}>
              {trendLabel[tec.trend] ?? tec.trend}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// 异动中心：watchdog 触发的急拉/急跌/涨跌停记录。
function AlertsPanel() {
  const [result, setResult] = useState({ data: null, source: "loading", error: null });

  useEffect(() => {
    let cancelled = false;
    loadStockAlerts().then((r) => { if (!cancelled) setResult(r); });
    return () => { cancelled = true; };
  }, []);

  // 指数异动已在复盘时间线展示，异动中心只保留个股事件避免重复。
  const items = (result.data?.items ?? []).filter((item) => item.scope !== "index");
  const typeLabel = { surge: "急拉", plunge: "急跌", limitUp: "涨停", limitDown: "跌停" };
  const typeClass = { surge: "up", plunge: "down", limitUp: "up", limitDown: "down" };

  return (
    <div className="watchlist-alerts">
      <div className="watchlist-alerts__head">
        <h2>异动中心</h2>
        <span className="watchlist-alerts__meta">
          {result.source === "live"
            ? items.length ? `${items.length} 条记录（近 7 天）` : "近 7 天无异动"
            : "记录不可用（watchdog 未运行或无记录）"}
        </span>
      </div>
      {items.length ? (
        <div className="watchlist-alerts__list">
          {items.slice(0, 10).map((item, i) => (
            <div key={i} className="watchlist-alerts__item">
              <span className={`watchlist-alerts__type watchlist-alerts__type--${typeClass[item.type] ?? ""}`}>
                {typeLabel[item.type] ?? item.type}
              </span>
              <span className="watchlist-alerts__name">{item.name}</span>
              <span className={`watchlist-alerts__pct ${typeClass[item.type] === "up" ? "watchlist-up" : "watchlist-down"}`}>
                {item.changePct > 0 ? "+" : ""}{item.changePct}%
              </span>
              <span className="watchlist-alerts__price">{item.price}</span>
              <span className="watchlist-alerts__time">{new Date(item.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="watchlist-alerts__empty">盯盘由 watchdog 进程驱动（npm run watchdog）。触发急拉/急跌/涨跌停会记录在这里并推送微信。</p>
      )}
    </div>
  );
}

// 盯盘配置：阈值/开关/推送测试。
function WatchdogPanel() {
  const [result, setResult] = useState({ data: null, source: "loading", error: null });
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState(null);

  const load = useCallback(() => {
    loadWatchdogConfig().then(setResult);
  }, []);
  useEffect(() => { load(); }, [load]);

  const config = result.data?.config;

  const patch = async (updates) => {
    if (!config) return;
    setSaving(true);
    try {
      const next = await updateWatchdogConfig(updates);
      setResult({ data: next, source: "live", error: null });
    } catch { /* 保存失败保持现状 */ }
    setSaving(false);
  };

  const runTest = async () => {
    setTestState({ status: "running" });
    try {
      await testWatchdogPush();
      setTestState({ status: "ok", message: "已发送，请查收微信" });
    } catch (error) {
      setTestState({ status: "failed", message: error?.message || "推送失败" });
    }
  };

  if (!config) return null;

  return (
    <div className="watchdog-panel">
      <div className="watchdog-panel__head">
        <h2>盯盘配置</h2>
        <span className="watchdog-panel__meta">
          {result.data?.pushConfigured ? "Server酱已配置" : "未配置 SENDKEY（.env）——仅落库不推送"}
        </span>
      </div>
      <div className="watchdog-panel__body">
        <label className="watchdog-panel__field">
          <input type="checkbox" checked={config.enabled} disabled={saving}
            onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>盯盘开关</span>
        </label>
        <label className="watchdog-panel__field">
          <input type="checkbox" checked={config.pushEnabled} disabled={saving}
            onChange={(e) => patch({ pushEnabled: e.target.checked })} />
          <span>微信推送</span>
        </label>
        <label className="watchdog-panel__field">
          <input type="checkbox" checked={config.indexEnabled !== false} disabled={saving}
            onChange={(e) => patch({ indexEnabled: e.target.checked })} />
          <span>指数盯盘</span>
        </label>
        <label className="watchdog-panel__field">
          <span>指数阈值 ±%</span>
          <input type="number" step="0.25" min="0.25" max="10" defaultValue={config.indexThresholdPct ?? 1} disabled={saving}
            onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== (config.indexThresholdPct ?? 1)) patch({ indexThresholdPct: v }); }} />
        </label>
        <label className="watchdog-panel__field">
          <span>急拉急跌阈值 ±%</span>
          <input type="number" step="0.5" min="0.5" max="20" defaultValue={config.thresholdPct} disabled={saving}
            onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== config.thresholdPct) patch({ thresholdPct: v }); }} />
        </label>
        <label className="watchdog-panel__field">
          <span>窗口（分钟）</span>
          <input type="number" step="1" min="1" max="60" defaultValue={config.windowMinutes} disabled={saving}
            onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== config.windowMinutes) patch({ windowMinutes: v }); }} />
        </label>
        <label className="watchdog-panel__field">
          <span>冷却（分钟）</span>
          <input type="number" step="1" min="1" max="120" defaultValue={config.cooldownMinutes} disabled={saving}
            onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== config.cooldownMinutes) patch({ cooldownMinutes: v }); }} />
        </label>
        <button type="button" className="watchdog-panel__test" onClick={runTest} disabled={testState?.status === "running"}>
          {testState?.status === "running" ? "发送中…" : "测试推送"}
        </button>
      </div>
      {testState?.status === "ok" ? <p className="watchdog-panel__hint watchdog-panel__hint--ok">{testState.message}</p> : null}
      {testState?.status === "failed" ? <p className="watchdog-panel__hint watchdog-panel__hint--err">{testState.message}</p> : null}
    </div>
  );
}

// 添加自选表单：任意 A 股（名称 + 6 位代码必填）。
function AddStockForm({ onAdded, onCancel }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [chain, setChain] = useState("");
  const [board, setBoard] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError("公司名不能为空。");
    if (!/^\d{6}$/.test(code.trim())) return setError("代码必须是 6 位数字。");
    setSubmitting(true);
    try {
      await addStockPoolItem({
        name: name.trim(),
        code: code.trim(),
        chain: chain.trim() || null,
        board: board.trim() || null,
      });
      onAdded?.();
    } catch (err) {
      setError(err?.message || "添加失败。");
      setSubmitting(false);
    }
  };

  return (
    <form className="add-stock" onSubmit={submit}>
      <div className="add-stock__head">
        <h3>添加自选股</h3>
        <button type="button" onClick={onCancel} aria-label="取消添加"><IconX size={16} /></button>
      </div>
      <div className="add-stock__fields">
        <label>公司名 *<input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 贵州茅台" autoFocus /></label>
        <label>代码 *<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位数字，如 600519" inputMode="numeric" /></label>
        <label>链<input value={chain} onChange={(e) => setChain(e.target.value)} placeholder="如 自选 / 国产链（可选）" /></label>
        <label>板块<input value={board} onChange={(e) => setBoard(e.target.value)} placeholder="如 白酒（可选）" /></label>
      </div>
      {error ? <p className="add-stock__error">{error}</p> : null}
      <div className="add-stock__actions">
        <button type="submit" disabled={submitting}>{submitting ? "添加中…" : "添加到股票池"}</button>
      </div>
    </form>
  );
}
