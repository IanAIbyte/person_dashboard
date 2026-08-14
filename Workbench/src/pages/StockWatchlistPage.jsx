import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle,
  IconChartCandle,
  IconChevronDown,
  IconChevronUp,
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
  loadStockUniverse,
  loadStockWatchlist,
  setStockCode,
  startStockReview,
  startStockSentiment,
  unfollowStock,
  updateStockMeta,
} from "../lib/api";
import "../components/watchlist/watchlist.css";

const CHAIN_COLORS = { domestic: "accent", overseas: "ok", packaging: "warn" };

function formatPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(2);
}

export function StockWatchlistPage({ onOpenDocument, syncRevision = 0 }) {
  const reduceMotion = useReducedMotion();
  const [universe, setUniverse] = useState({ data: null, source: "loading", error: null });
  const [followed, setFollowed] = useState(() => new Map()); // name -> {group,note}
  const [quotes, setQuotes] = useState(() => new Map()); // code -> quote
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [sortKey, setSortKey] = useState("chain"); // chain | pct | name
  const [selected, setSelected] = useState(() => new Set()); // 多选对比（公司名）
  const [detailName, setDetailName] = useState(null); // 详情展开的公司名
  const [codesDraft, setCodesDraft] = useState(() => new Map()); // name -> 编辑中的代码

  const refresh = useCallback(async () => {
    setUniverse((current) => ({ ...current, source: current.data ? current.source : "loading" }));
    const [universeResult, watchlistResult] = await Promise.all([
      loadStockUniverse(),
      loadStockWatchlist(),
    ]);
    setUniverse(universeResult);
    if (watchlistResult.source === "live") {
      const map = new Map();
      for (const item of watchlistResult.data?.items ?? []) {
        map.set(item.name, { group: item.group, note: item.note });
      }
      setFollowed(map);
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
  }, [allStocks, onlyFollowed, followed, sortKey, quotes]);

  const visibleChains = useMemo(() => {
    const groups = new Map();
    for (const stock of visibleStocks) {
      if (!groups.has(stock.chainLabel)) groups.set(stock.chainLabel, []);
      groups.get(stock.chainLabel).push(stock);
    }
    return [...groups.entries()].map(([label, stocks]) => ({ label, stocks }));
  }, [visibleStocks]);

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

  const enter = reduceMotion ? {} : {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
  };

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
      <div><strong>{selected.size}</strong><span>对比中</span></div>
    </div>
  );

  return (
    <div className="page page--watchlist">
      <PageHeader
        eyebrow="STOCKS · WATCHLIST"
        title="重点个股"
        description="科技半导体三大板块。点击星标关注、点击卡片看详情，勾选多只做对比，用 AI 做情绪分析与每日复盘。"
        aside={headerAside}
      />

      <div className="watchlist-toolbar">
        <span className="watchlist-source">
          {universe.source === "live" ? "行情已连接" : universe.source === "fallback" ? "降级模式" : "—"}
        </span>
        <div className="watchlist-toolbar__actions">
          <label className="watchlist-filter">
            <input type="checkbox" checked={onlyFollowed} onChange={(e) => setOnlyFollowed(e.target.checked)} />
            <span>只看已关注</span>
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

      {selected.size >= 2 ? (
        <CompareBar
          stocks={allStocks.filter((s) => selected.has(s.name))}
          quotes={quotes}
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {visibleChains.length === 0 && !isLoading ? (
        <div className="watchlist-empty">
          <p>{onlyFollowed ? "还没有关注任何个股。" : "暂无个股数据。"}</p>
        </div>
      ) : null}

      {visibleChains.map((chain, chainIndex) => {
        const chainFollowed = chain.stocks.filter((s) => followed.has(s.name)).length;
        return (
          <motion.section
            key={chain.label}
            className="watchlist-chain"
            {...enter}
            transition={{ ...enter.transition, delay: chainIndex * 0.05 }}
          >
            <header className="watchlist-chain__head">
              <div className="watchlist-chain__title">
                <IconChartCandle size={18} stroke={1.7} />
                <h2>{chain.label}</h2>
              </div>
              <div className="watchlist-chain__meta">
                <span className="watchlist-chain__count">{chainFollowed} 关注</span>
              </div>
            </header>

            <div className="watchlist-grid">
              {chain.stocks.map((stock) => (
                <StockCard
                  key={stock.name}
                  stock={stock}
                  isFollowed={followed.has(stock.name)}
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
          </motion.section>
        );
      })}

      {detailName ? (
        <StockDetailDrawer
          stock={allStocks.find((s) => s.name === detailName)}
          quote={quotes.get(allStocks.find((s) => s.name === detailName)?.code)}
          meta={followed.get(detailName)}
          onClose={() => setDetailName(null)}
          onOpenDocument={onOpenDocument}
          onSaveMeta={(meta) => {
            updateStockMeta(detailName, meta).then(() => refresh());
            setFollowed((c) => new Map(c).set(detailName, { ...(c.get(detailName) || {}), ...meta }));
          }}
        />
      ) : null}

      <ReviewPanel stocks={allStocks.filter((s) => followed.has(s.name))} quotes={quotes} />
    </div>
  );
}

function StockCard({ stock, isFollowed, quote, isSelected, codeDraft, onToggleFollow, onToggleSelect, onOpenDetail, onCodeDraft, onSaveCode }) {
  const pct = quote?.changePct;
  const pctClass = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";
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

function CompareBar({ stocks, quotes, onClear }) {
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
              <th>链</th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((s) => {
              const q = quotes.get(s.code);
              const pct = q?.changePct;
              return (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{formatPrice(q?.price)}</td>
                  <td className={pct == null ? "" : pct > 0 ? "watchlist-up" : pct < 0 ? "watchlist-down" : ""}>
                    {formatPct(pct)}
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

function StockDetailDrawer({ stock, quote, meta, onClose, onOpenDocument, onSaveMeta }) {
  const [group, setGroup] = useState(meta?.group ?? "");
  const [note, setNote] = useState(meta?.note ?? "");
  const [news, setNews] = useState(null);
  const [analysis, setAnalysis] = useState(null);

  useEffect(() => {
    if (!stock) return;
    let cancelled = false;
    loadStockNews(stock.name, stock.code).then((r) => {
      if (!cancelled && r.source === "live") setNews(r.data?.items ?? []);
    });
    return () => { cancelled = true; };
  }, [stock]);

  if (!stock) return null;

  const runSentiment = async () => {
    setAnalysis({ status: "running" });
    const task = await startStockSentiment({ name: stock.name, note: stock.note, code: stock.code });
    const id = task?.id;
    const poll = async () => {
      const result = await getStockAnalysis(id);
      if (result?.status === "completed") {
        setAnalysis({ status: "done", data: result.result });
      } else if (result?.status === "failed") {
        setAnalysis({ status: "failed", error: result.error });
      } else {
        setTimeout(poll, 2000);
      }
    };
    poll();
  };

  return (
    <div className="watchlist-detail-mask" onClick={onClose}>
      <div className="watchlist-detail" onClick={(e) => e.stopPropagation()}>
        <div className="watchlist-detail__head">
          <div>
            <h2>{stock.name} {stock.code ? <span className="watchlist-card__code">({stock.code})</span> : null}</h2>
            <p>{stock.chainLabel} · {stock.segment}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭详情"><IconX size={20} /></button>
        </div>

        <div className="watchlist-detail__quote">
          <span className="watchlist-card__price">{formatPrice(quote?.price)}</span>
          <span className={`watchlist-card__pct watchlist-card__pct--${quote?.changePct > 0 ? "up" : quote?.changePct < 0 ? "down" : "flat"}`}>
            {formatPct(quote?.changePct)}
          </span>
        </div>

        <p className="watchlist-detail__note">{stock.note}</p>

        <div className="watchlist-detail__meta">
          <label>分组</label>
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="如 核心持仓 / 观察中" />
          <label>备注</label>
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
          <button type="button" className="watchlist-detail__ai" onClick={runSentiment} disabled={analysis?.status === "running"}>
            <IconSparkles size={16} /> {analysis?.status === "running" ? "分析中…" : "AI 新闻情绪分析"}
          </button>
        </div>

        {analysis?.status === "done" && analysis.data ? (
          <div className="watchlist-detail__analysis">
            <div className="watchlist-detail__analysis-head">
              <strong>情绪：{analysis.data.sentiment}</strong>
              {analysis.data.score != null ? <span>评分 {analysis.data.score}/5</span> : null}
            </div>
            <p className="watchlist-detail__analysis-summary">{analysis.data.summary}</p>
            {analysis.data.drivers?.length ? (
              <div><h4>催化 / 逻辑</h4><ul>{analysis.data.drivers.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
            ) : null}
            {analysis.data.risks?.length ? (
              <div><h4>风险</h4><ul>{analysis.data.risks.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
            ) : null}
            {analysis.data.watchPoints?.length ? (
              <div><h4>跟踪点</h4><ul>{analysis.data.watchPoints.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
            ) : null}
          </div>
        ) : null}
        {analysis?.status === "failed" ? (
          <div className="watchlist-detail__analysis watchlist-detail__analysis--error">{analysis.error}</div>
        ) : null}

        {news && news.length > 0 ? (
          <div className="watchlist-detail__news">
            <h3>近期新闻</h3>
            {news.slice(0, 5).map((n, i) => (
              <a key={i} href={n.url} target="_blank" rel="noreferrer">
                <span className="watchlist-detail__news-title">{n.title}</span>
                <span className="watchlist-detail__news-meta">{n.mediaName} · {n.date}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewPanel({ stocks, quotes }) {
  const [task, setTask] = useState(null);

  if (stocks.length === 0) return null;

  const runReview = async () => {
    setTask({ status: "running" });
    const payload = stocks.map((s) => ({ name: s.name, code: s.code, note: s.note }));
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
    <div className="watchlist-review">
      <div className="watchlist-review__head">
        <h2>AI 每日复盘</h2>
        <button type="button" onClick={runReview} disabled={task?.status === "running"}>
          <IconSparkles size={16} /> {task?.status === "running" ? "生成中…" : "生成复盘"}
        </button>
      </div>
      {task?.status === "done" && task.data ? (
        <div className="watchlist-review__body">
          <p className="watchlist-review__overview">{task.data.overview}</p>
          {task.data.notable?.length ? <div><h4>值得注意</h4><ul>{task.data.notable.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
          {task.data.risks?.length ? <div><h4>风险提示</h4><ul>{task.data.risks.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
          {task.data.actions?.length ? <div><h4>后续跟踪</h4><ul>{task.data.actions.map((n, i) => <li key={i}>{n}</li>)}</ul></div> : null}
        </div>
      ) : null}
      {task?.status === "failed" ? (
        <div className="watchlist-review__error">{task.error}</div>
      ) : null}
    </div>
  );
}
