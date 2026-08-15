import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconLayoutGrid,
  IconList,
  IconRefresh,
  IconSparkles,
  IconStar,
  IconStarFilled,
  IconX,
} from "@tabler/icons-react";

import { PageHeader } from "../components/PageHeader";
import {
  followStock,
  getStockAnalysis,
  loadMarketQuotes,
  loadStockNews,
  loadStockResearch,
  loadStockUniverse,
  loadStockWatchlist,
  saveStockResearch,
  setStockCode,
  startStockResearch,
  startStockReview,
  unfollowStock,
  updateStockMeta,
} from "../lib/api";
import "../components/watchlist/watchlist.css";

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
const COLLAPSED_STORAGE_KEY = "workbench.watchlist-collapsed.v1";
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

function loadStoredCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
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
  const [sortKey, setSortKey] = useState("chain"); // chain | pct | name
  const [viewMode, setViewMode] = useState(loadStoredView); // list（默认，扫描密度）| grid（卡片浏览）
  const [collapsedChains, setCollapsedChains] = useState(loadStoredCollapsed); // chainLabel -> 收起
  const [activeChain, setActiveChain] = useState(() => {
    try { return localStorage.getItem(CHAIN_TAB_STORAGE_KEY) ?? "all"; } catch { return "all"; }
  }); // "all" | chainLabel，链 Tab 当前分组
  const [selected, setSelected] = useState(() => new Set()); // 多选对比（公司名）
  const [detailName, setDetailName] = useState(null); // 详情展开的公司名
  const [codesDraft, setCodesDraft] = useState(() => new Map()); // name -> 编辑中的代码

  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, viewMode); } catch { /* 隐私模式等场景静默降级 */ }
  }, [viewMode]);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsedChains])); } catch { /* 同上 */ }
  }, [collapsedChains]);

  useEffect(() => {
    try { localStorage.setItem(CHAIN_TAB_STORAGE_KEY, activeChain); } catch { /* 同上 */ }
  }, [activeChain]);

  const toggleChainCollapsed = useCallback((label) => {
    setCollapsedChains((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setUniverse((current) => ({ ...current, source: current.data ? current.source : "loading" }));
    const [universeResult, watchlistResult, researchResult] = await Promise.all([
      loadStockUniverse(),
      loadStockWatchlist(),
      loadStockResearch(),
    ]);
    setUniverse(universeResult);
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
    const codes = [];
    const stack = (chains) => {
      for (const chain of chains) {
        for (const segment of chain.segments) {
          for (const stock of segment.stocks) {
            if (stock.code) codes.push(stock.code);
          }
        }
      }
    };
    stack(universe.data?.chains ?? []);
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

  const chains = universe.data?.chains ?? [];
  const total = universe.data?.total ?? 0;
  const isLoading = universe.source === "loading";
  const error = universe.error;

  const allStocks = useMemo(() => {
    const list = [];
    for (const chain of chains) {
      for (const segment of chain.segments) {
        for (const stock of segment.stocks) {
          list.push({ ...stock, chainKey: chain.key, chainLabel: chain.label, segment: segment.label });
        }
      }
    }
    return list;
  }, [chains]);

  const visibleStocks = useMemo(() => {
    let list = allStocks;
    if (onlyFollowed) list = list.filter((s) => followed.has(s.name));
    if (onlyResearched) list = list.filter((s) => research.has(s.name));
    if (sortKey === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    } else if (sortKey === "pct") {
      list = [...list].sort((a, b) => {
        const pa = quotes.get(a.code)?.changePct ?? -Infinity;
        const pb = quotes.get(b.code)?.changePct ?? -Infinity;
        return pb - pa;
      });
    }
    return list;
  }, [allStocks, onlyFollowed, onlyResearched, followed, research, sortKey, quotes]);

  const visibleChains = useMemo(() => {
    const groups = new Map();
    for (const stock of visibleStocks) {
      if (!groups.has(stock.chainLabel)) groups.set(stock.chainLabel, []);
      groups.get(stock.chainLabel).push(stock);
    }
    return [...groups.entries()].map(([label, stocks]) => ({ label, stocks }));
  }, [visibleStocks]);

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
  const displayChains = effectiveChain === "all"
    ? visibleChains
    : visibleChains.filter((chain) => chain.label === effectiveChain);

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
        eyebrow="STOCKS · RESEARCH DESK"
        title="重点个股"
        description="科技半导体三大板块。AI 按研究方法论打底座：事实梳理、四维评级、多空摆一张表、私董会找反证、验证节点盯证伪——判断留给你。研究辅助，不构成投资建议。"
        aside={headerAside}
      />

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
          <select className="watchlist-sort" value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
            <option value="chain">按链排序</option>
            <option value="pct">按涨跌幅</option>
            <option value="name">按名称</option>
          </select>
          <button type="button" className="watchlist-refresh" onClick={refresh}>
            <IconRefresh size={16} stroke={1.7} /> 刷新
          </button>
        </div>
      </div>

      {error && universe.source === "fallback" && chains.length === 0 ? (
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

      {selected.size >= 2 ? (
        <CompareBar
          stocks={allStocks.filter((s) => selected.has(s.name))}
          quotes={quotes}
          research={research}
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {displayChains.length === 0 && !isLoading ? (
        <div className="watchlist-empty">
          <p>{onlyFollowed || onlyResearched ? "当前筛选条件下暂无个股。" : "暂无个股数据。"}</p>
        </div>
      ) : null}

      {displayChains.map((chain, chainIndex) => {
        const chainFollowed = chain.stocks.filter((s) => followed.has(s.name)).length;
        const isSolo = effectiveChain !== "all";
        // 单链视图下分组信息已由链 Tab 承载：隐藏链头；且忽略折叠状态，
        // 避免「全部」视图折叠后切入单链无头可点、清单被藏死。
        const collapsed = !isSolo && collapsedChains.has(chain.label);
        return (
          <motion.section
            key={chain.label}
            className={`watchlist-chain${viewMode === "list" ? " watchlist-chain--list" : ""}${collapsed ? " watchlist-chain--collapsed" : ""}${isSolo ? " watchlist-chain--solo" : ""}`}
            {...enter}
            transition={{ ...enter.transition, delay: chainIndex * 0.05 }}
          >
            {isSolo ? null : (
              <header
                className="watchlist-chain__head watchlist-chain__head--toggle"
                onClick={() => toggleChainCollapsed(chain.label)}
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleChainCollapsed(chain.label);
                  }
                }}
              >
                <div className="watchlist-chain__title">
                  <IconChevronDown
                    size={16}
                    stroke={1.7}
                    className={`watchlist-chain__chevron${collapsed ? " watchlist-chain__chevron--collapsed" : ""}`}
                  />
                  <h2>{chain.label}</h2>
                </div>
                <div className="watchlist-chain__meta">
                  <span className="watchlist-chain__count">{chain.stocks.length} 只</span>
                  <span className="watchlist-chain__count">{chainFollowed} 关注</span>
                </div>
              </header>
            )}

            {collapsed ? null : viewMode === "list" ? (
              <div className="watchlist-list">
                <div className="watchlist-list__head" aria-hidden="true">
                  <span>公司</span>
                  <span>代码</span>
                  <span>现价</span>
                  <span>涨跌幅</span>
                  <span>研究评级</span>
                  <span />
                  <span />
                </div>
                {chain.stocks.map((stock) => (
                  <StockRow
                    key={stock.name}
                    stock={stock}
                    isFollowed={followed.has(stock.name)}
                    researchEntry={research.get(stock.name)}
                    quote={quotes.get(stock.code)}
                    onOpenDetail={() => setDetailName(stock.name)}
                    onToggleFollow={() => toggleFollow(stock.name)}
                  />
                ))}
              </div>
            ) : (
              <div className="watchlist-grid">
                {chain.stocks.map((stock) => (
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
        );
      })}

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

      <ReviewPanel
        stocks={allStocks.filter((s) => followed.has(s.name))}
        quotes={quotes}
        research={research}
      />
    </div>
  );
}

// 清单视图行：一行一股，整行可点开研究台，星标独立操作。
function StockRow({ stock, isFollowed, researchEntry, quote, onOpenDetail, onToggleFollow }) {
  const pct = quote?.changePct;
  const pctClass = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const verdict = researchEntry?.report?.rating?.verdict;
  const tone = verdictTone(verdict);
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
        {researchEntry ? (
          <span className={`watchlist-verdict-dot watchlist-verdict-dot--${tone}`} title={`研究评级：${verdict ?? "见档案"}`} />
        ) : null}
        {stock.name}
      </span>
      <span className={`watchlist-list__code${stock.code ? "" : " watchlist-list__code--none"}`}>
        {stock.code ?? "无代码"}
      </span>
      <span className="watchlist-list__price">{formatPrice(quote?.price)}</span>
      <span className={`watchlist-list__pct watchlist-list__pct--${pctClass}`}>{formatPct(pct)}</span>
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
      <span className="watchlist-list__go">详情</span>
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

function ReviewPanel({ stocks, quotes, research }) {
  const [task, setTask] = useState(null);
  const [open, setOpen] = useState(false);

  if (stocks.length === 0) return null;

  const runReview = async () => {
    setOpen(true);
    setTask({ status: "running" });
    const payload = stocks.map((s) => ({
      name: s.name,
      code: s.code,
      note: s.note,
      monitor: research.get(s.name)?.report?.monitor ?? [],
    }));
    const started = await startStockReview(payload);
    const id = started?.id;
    const poll = async () => {
      const result = await getStockAnalysis(id);
      if (result?.status === "completed") setTask({ status: "done", data: result.result });
      else if (result?.status === "failed") setTask({ status: "failed", error: result.error });
      else setTimeout(poll, 2000);
    };
    poll();
  };

  return (
    <div className={`watchlist-review${open ? " watchlist-review--open" : ""}`}>
      <div className="watchlist-review__head">
        <button
          type="button"
          className="watchlist-review__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <IconChevronDown size={16} stroke={1.7} className={`watchlist-chain__chevron${open ? "" : " watchlist-chain__chevron--collapsed"}`} />
          <h2>AI 每日复盘与验证节点</h2>
          {task?.status === "done" && task.data ? (
            <span className="watchlist-review__state">已生成 · {task.data.stockCount ?? stocks.length} 只</span>
          ) : null}
          {task?.status === "running" ? <span className="watchlist-review__state">生成中…</span> : null}
        </button>
        {open ? (
          <button type="button" onClick={runReview} disabled={task?.status === "running"}>
            <IconSparkles size={16} /> {task?.status === "running" ? "生成中…" : "生成复盘"}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="watchlist-review__body">
          {task?.status === "done" && task.data ? (
            <>
              <p className="watchlist-review__overview">{task.data.overview}</p>
              {task.data.notable?.length ? <div><h4>值得注意</h4><ul>{task.data.notable.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
              {task.data.risks?.length ? <div><h4>风险提示</h4><ul>{task.data.risks.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
              {task.data.actions?.length ? <div><h4>后续跟踪</h4><ul>{task.data.actions.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
              {task.data.verifications?.length ? (
                <div>
                  <h4>验证节点</h4>
                  <ul className="watchlist-review__verify">
                    {task.data.verifications.map((v, i) => (
                      <li key={i} className={v?.type === "falsify" ? "watchlist-review__verify-item--falsify" : undefined}>
                        <strong>{v?.stock}</strong>
                        <span className="watchlist-review__verify-type">{v?.type === "falsify" ? "证伪" : "强化"}</span>
                        {v?.event}
                        {v?.note ? <em>—— {v.note}</em> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <p className="watchlist-review__idle">收盘后基于关注股行情与监控清单生成当日复盘；验证节点按「强化 / 证伪」归类汇总。</p>
          )}
          {task?.status === "failed" ? (
            <div className="watchlist-review__error">{task.error}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
