import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  IconAlertTriangle,
  IconChartCandle,
  IconRefresh,
  IconStar,
  IconStarFilled,
} from "@tabler/icons-react";

import { PageHeader } from "../components/PageHeader";
import {
  followStock,
  loadStockUniverse,
  loadStockWatchlist,
  unfollowStock,
} from "../lib/api";
import "../components/watchlist/watchlist.css";

export function StockWatchlistPage({ onOpenDocument, syncRevision = 0 }) {
  const reduceMotion = useReducedMotion();
  const [universe, setUniverse] = useState({ data: null, source: "loading", error: null });
  const [followed, setFollowed] = useState(() => new Set());
  const [onlyFollowed, setOnlyFollowed] = useState(false);

  const refresh = useCallback(async () => {
    setUniverse((current) => ({
      ...current,
      source: current.data ? current.source : "loading",
    }));
    const [universeResult, watchlistResult] = await Promise.all([
      loadStockUniverse(),
      loadStockWatchlist(),
    ]);
    setUniverse(universeResult);
    if (watchlistResult.source === "live") {
      setFollowed(new Set(watchlistResult.data?.items ?? []));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, syncRevision]);

  const enter = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
      };

  const toggleFollow = useCallback(async (name) => {
    const isFollowed = followed.has(name);
    // 乐观更新
    setFollowed((current) => {
      const next = new Set(current);
      if (isFollowed) next.delete(name);
      else next.add(name);
      return next;
    });
    try {
      if (isFollowed) await unfollowStock(name);
      else await followStock(name);
    } catch {
      // 失败回滚
      setFollowed((current) => {
        const next = new Set(current);
        if (isFollowed) next.add(name);
        else next.delete(name);
        return next;
      });
    }
  }, [followed]);

  const chains = universe.data?.chains ?? [];
  const total = universe.data?.total ?? 0;
  const isLoading = universe.source === "loading";
  const error = universe.error;

  const totalFollowed = followed.size;

  const visibleChains = useMemo(() => {
    if (!onlyFollowed) return chains;
    return chains
      .map((chain) => ({
        ...chain,
        segments: chain.segments
          .map((segment) => ({
            ...segment,
            stocks: segment.stocks.filter((stock) => followed.has(stock.name)),
          }))
          .filter((segment) => segment.stocks.length > 0),
      }))
      .filter((chain) => chain.segments.length > 0);
  }, [chains, onlyFollowed, followed]);

  const headerAside = (
    <div className="watchlist-summary">
      <div>
        <strong>{total || "—"}</strong>
        <span>总家数</span>
      </div>
      <div>
        <strong>{totalFollowed}</strong>
        <span>已关注</span>
      </div>
    </div>
  );

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

  return (
    <div className="page page--watchlist">
      <PageHeader
        eyebrow="STOCKS · WATCHLIST"
        title="重点个股"
        description="科技半导体三大板块：国产链、海外链、封测。点击星标关注，聚焦你重点跟踪的标的。"
        aside={headerAside}
      />

      <div className="watchlist-toolbar">
        <span className="watchlist-source">
          {universe.source === "live" ? "已载入个股清单" : universe.source === "fallback" ? "降级模式" : "—"}
        </span>
        <div className="watchlist-toolbar__actions">
          <label className="watchlist-filter">
            <input
              type="checkbox"
              checked={onlyFollowed}
              onChange={(event) => setOnlyFollowed(event.target.checked)}
            />
            <span>只看已关注</span>
          </label>
          <button type="button" className="watchlist-refresh" onClick={refresh}>
            <IconRefresh size={16} stroke={1.7} />
            刷新
          </button>
        </div>
      </div>

      {error && universe.source === "fallback" && chains.length === 0 ? (
        <div className="watchlist-empty watchlist-empty--error">
          <IconAlertTriangle size={20} stroke={1.7} />
          <p>无法加载个股清单。{error?.message ? `（${error.message}）` : ""}</p>
        </div>
      ) : null}

      {visibleChains.length === 0 && !isLoading ? (
        <div className="watchlist-empty">
          <p>{onlyFollowed ? "还没有关注任何个股。" : "暂无个股数据。"}</p>
        </div>
      ) : null}

      {visibleChains.map((chain, chainIndex) => {
        const chainFollowed = chain.segments.reduce(
          (sum, segment) => sum + segment.stocks.filter((s) => followed.has(s.name)).length,
          0,
        );
        return (
          <motion.section
            key={chain.key}
            className="watchlist-chain"
            {...enter}
            transition={{ ...enter.transition, delay: chainIndex * 0.06 }}
          >
            <header className="watchlist-chain__head">
              <div className="watchlist-chain__title">
                <IconChartCandle size={18} stroke={1.7} />
                <h2>{chain.label}</h2>
              </div>
              <div className="watchlist-chain__meta">
                <span>{chain.description}</span>
                <span className="watchlist-chain__count">{chainFollowed} 关注</span>
              </div>
            </header>

            {chain.segments.map((segment) => (
              <div key={segment.label} className="watchlist-segment">
                <h3 className="watchlist-segment__title">
                  {segment.label}
                  <span className="watchlist-segment__count">{segment.stocks.length}</span>
                </h3>
                <div className="watchlist-grid">
                  {segment.stocks.map((stock) => {
                    const isFollowed = followed.has(stock.name);
                    return (
                      <article
                        key={stock.name}
                        className={`watchlist-card${isFollowed ? " watchlist-card--followed" : ""}`}
                      >
                        <div className="watchlist-card__head">
                          <span className="watchlist-card__name">{stock.name}</span>
                          {stock.code ? (
                            <span className="watchlist-card__code">{stock.code}</span>
                          ) : null}
                          <button
                            type="button"
                            className="watchlist-card__star"
                            aria-label={isFollowed ? `取消关注 ${stock.name}` : `关注 ${stock.name}`}
                            title={isFollowed ? "取消关注" : "关注"}
                            onClick={() => toggleFollow(stock.name)}
                          >
                            {isFollowed ? (
                              <IconStarFilled size={18} stroke={1.5} />
                            ) : (
                              <IconStar size={18} stroke={1.5} />
                            )}
                          </button>
                        </div>
                        <p className="watchlist-card__note">{stock.note}</p>
                        <div className="watchlist-card__foot">
                          {stock.hasEntityPage && stock.entityPageId ? (
                            <button
                              type="button"
                              className="watchlist-card__detail"
                              onClick={() => onOpenDocument?.(stock.entityPageId)}
                            >
                              查看实体页
                            </button>
                          ) : (
                            <span className="watchlist-card__pending">实体页待建</span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </motion.section>
        );
      })}
    </div>
  );
}
