// 每日复盘面板：指数走势 + 当日事件时间线 + AI 总结。
// 自取数自治组件（仿 AlertsPanel），stocks 由页面传入用于 AI 生成上下文。
// vault 状态文件变更会经 Routes key 重挂载自动刷新，无需额外轮询。

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import {
  Bar,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  addReviewEvent,
  getStockAnalysis,
  loadCoachPrompt,
  loadDailyReviewIndices,
  loadDailyReviewKline,
  loadDailyReviewSummary,
  loadDailyReviewTimeline,
  removeReviewEvent,
  resetCoachPrompt,
  saveCoachPrompt,
  saveDailyReviewSummary,
  startDailyReviewGenerate,
} from "../../lib/api";
import "./daily-review.css";

const TONE_LABELS = { info: "记录", up: "偏多", down: "偏空", note: "备注" };
const SOURCE_LABELS = { watchdog: "异动", manual: "手动", ai: "AI" };

function formatTime(ts) {
  if (!ts) return "--:--";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function pctClass(value) {
  return value > 0 ? "review-up" : value < 0 ? "review-down" : "review-flat";
}

export function IntradayChart({ intraday, prevClose }) {
  if (!intraday || intraday.length === 0) {
    return <div className="review-chart review-chart--empty">暂无分时数据</div>;
  }
  return (
    <div className="review-chart">
      <ResponsiveContainer height={110} width="100%">
        <LineChart data={intraday} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
          <XAxis
            dataKey="time"
            tickFormatter={(value) => String(value).slice(11)}
            minTickGap={36}
            tick={{ fontSize: 9, fill: "var(--ink-soft)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis hide domain={["auto", "auto"]} />
          <Tooltip
            formatter={(value) => [value, "点位"]}
            labelFormatter={(value) => String(value).slice(11)}
            contentStyle={{ fontSize: 11 }}
          />
          {prevClose ? (
            <ReferenceLine stroke="var(--line-strong)" strokeDasharray="4 3" y={prevClose} />
          ) : null}
          <Line
            dataKey="close"
            dot={false}
            stroke="var(--accent)"
            strokeWidth={1.4}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DailyKlineChart({ klines }) {
  return (
    <div className="review-chart review-chart--daily">
      <ResponsiveContainer height={150} width="100%">
        <ComposedChart data={klines} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
          <XAxis dataKey="date" minTickGap={48} tick={{ fontSize: 9, fill: "var(--ink-soft)" }} />
          <YAxis yAxisId="price" hide domain={["auto", "auto"]} />
          <YAxis yAxisId="volume" hide />
          <Tooltip
            formatter={(value, name) => [value, name === "close" ? "收盘" : "成交量"]}
            contentStyle={{ fontSize: 11 }}
          />
          <Bar yAxisId="volume" dataKey="volume" fill="var(--accent)" opacity={0.18} />
          <Line
            yAxisId="price"
            dataKey="close"
            dot={false}
            stroke="var(--accent)"
            strokeWidth={1.4}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function IndexCard({ index }) {
  const [expanded, setExpanded] = useState(false);
  const [days, setDays] = useState(60);
  const [klineResult, setKlineResult] = useState(null);
  const quote = index.quote;
  const changePct = quote?.changePct ?? null;

  useEffect(() => {
    if (!expanded || klineResult?.days === days) return;
    let cancelled = false;
    loadDailyReviewKline(index.symbol, days).then((result) => {
      if (!cancelled) setKlineResult(result.data);
    });
    return () => { cancelled = true; };
  }, [expanded, days, index.symbol, klineResult?.days]);

  return (
    <article className={`review-index${expanded ? " review-index--open" : ""}`}>
      <button
        className="review-index__head"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className="review-index__name">{index.name}</span>
        <span className="review-index__price">
          {quote?.price ?? "—"}
        </span>
        <span className={`review-index__pct ${pctClass(changePct)}`}>
          {changePct == null ? "—" : `${changePct > 0 ? "+" : ""}${changePct}%`}
        </span>
      </button>
      <div className="review-index__meta">
        <span>振幅 {quote?.amplitudePct ?? "—"}%</span>
        <span>高 {quote?.high ?? "—"} / 低 {quote?.low ?? "—"}</span>
      </div>
      <IntradayChart intraday={index.intraday} prevClose={index.prevCloseReference} />
      {expanded ? (
        <div className="review-index__daily">
          <div className="review-index__days" role="group" aria-label="日K周期">
            {[60, 120].map((value) => (
              <button
                className={days === value ? "review-index__day review-index__day--on" : "review-index__day"}
                key={value}
                onClick={() => setDays(value)}
                type="button"
              >
                {value}日
              </button>
            ))}
          </div>
          {klineResult?.klines?.length ? (
            <DailyKlineChart klines={klineResult.klines} />
          ) : (
            <div className="review-chart review-chart--empty">
              {klineResult ? "暂无日K数据" : "读取中…"}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ManualEventForm({ onAdded }) {
  const [title, setTitle] = useState("");
  const [tone, setTone] = useState("info");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addReviewEvent({
        title: trimmed,
        tone,
        ...(time ? { ts: new Date(time).toISOString() } : {}),
      });
      setTitle("");
      setTime("");
      onAdded?.();
    } catch (caught) {
      setError(caught?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="review-event-form" onSubmit={submit}>
      <input
        aria-label="事件内容"
        className="review-event-form__title"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="补录事件：如 14:00 半导体设备板块放量拉升"
        value={title}
      />
      <select
        aria-label="事件倾向"
        className="review-event-form__tone"
        onChange={(e) => setTone(e.target.value)}
        value={tone}
      >
        {Object.entries(TONE_LABELS).map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
      <input
        aria-label="事件时间（可回填）"
        className="review-event-form__time"
        onChange={(e) => setTime(e.target.value)}
        type="datetime-local"
        value={time}
      />
      <button className="review-event-form__submit" disabled={busy || !title.trim()} type="submit">
        <IconPlus aria-hidden="true" size={13} />
        {busy ? "保存中" : "添加"}
      </button>
      {error ? <span className="review-event-form__error">{error}</span> : null}
    </form>
  );
}

function TimelineRow({ item, onRemoved }) {
  const manual = item.source === "manual";
  const remove = async () => {
    try {
      await removeReviewEvent(item.id);
      onRemoved?.();
    } catch { /* 删除失败静默，重挂载后会恢复真态 */ }
  };
  return (
    <li className={`review-timeline__item review-timeline__item--${item.tone ?? "info"}`}>
      <span className="review-timeline__time">{formatTime(item.ts)}</span>
      <span className={`review-timeline__badge review-timeline__badge--${item.source}`}>
        {SOURCE_LABELS[item.source] ?? item.source}
        {item.kind === "index" ? "·指数" : ""}
      </span>
      <span className="review-timeline__title">
        {item.source === "watchdog" ? `${item.name} ${item.title}` : item.title}
        {item.changePct != null ? (
          <span className={pctClass(item.changePct)}>
            {" "}{item.changePct > 0 ? "+" : ""}{item.changePct}%
          </span>
        ) : null}
      </span>
      {item.note ? <span className="review-timeline__note">{item.note}</span> : null}
      {manual ? (
        <button aria-label="删除事件" className="review-timeline__remove" onClick={remove} type="button">
          <IconTrash aria-hidden="true" size={13} />
        </button>
      ) : null}
    </li>
  );
}

function SessionSummaryCard({ title, session, entry, stocks, date, onSaved }) {
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (task?.status !== "running") return undefined;
    const timer = setInterval(async () => {
      try {
        const next = await getStockAnalysis(task.id);
        if (next.status === "completed") {
          clearInterval(timer);
          try {
            await saveDailyReviewSummary(date, {
              stockCount: stocks.length,
              session,
              review: next.result,
            });
            setTask(null);
            onSaved?.();
          } catch (caught) {
            setTask(null);
            setError(caught?.message || "总结保存失败");
          }
        } else if (next.status === "failed") {
          clearInterval(timer);
          setTask(null);
          setError(next.error?.message || "生成失败");
        }
      } catch {
        // 轮询失败继续等下一轮。
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [task, date, session, stocks.length, onSaved]);

  const generate = async () => {
    setError(null);
    try {
      const started = await startDailyReviewGenerate(stocks, session, date);
      setTask({ id: started.id, status: "running" });
    } catch (caught) {
      setError(caught?.message || "无法启动生成");
    }
  };

  const running = task?.status === "running";
  const review = entry?.review;

  return (
    <div className="review-summary">
      <div className="review-summary__head">
        <h3>{title}</h3>
        <button className="review-summary__generate" disabled={running} onClick={generate} type="button">
          <IconSparkles aria-hidden="true" size={13} />
          {running ? "生成中…" : entry ? "重新生成" : "生成"}
        </button>
      </div>
      {review ? (
        <div className="review-summary__body">
          {review.markdown ? (
            <div className="review-summary__markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{review.markdown}</ReactMarkdown>
            </div>
          ) : (
            <p className="review-summary__overview">{review.overview}</p>
          )}
          <span className="review-summary__meta">
            生成于 {entry.generatedAt ? new Date(entry.generatedAt).toLocaleString("zh-CN") : "—"}
          </span>
        </div>
      ) : (
        <p className="review-summary__empty">
          {session === "intraday"
            ? "尚无盘中总结。交易时段点「生成」做盘中快照（侧重当下异动与剩余时段应对）。"
            : "尚无收盘复盘。收盘后点「生成」出完整四段式复盘。"}
        </p>
      )}
      {error ? <p className="review-summary__error">{error}</p> : null}
    </div>
  );
}

function PromptEditor() {
  const [promptResult, setPromptResult] = useState({ data: null, source: "loading" });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);

  const reload = useCallback(() => {
    loadCoachPrompt().then((result) => {
      setPromptResult(result);
      setDraft(result.data?.prompt ?? "");
    });
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    setBusy(true);
    setState(null);
    try {
      await saveCoachPrompt(draft);
      setState({ ok: true, message: "已保存,下次生成即生效" });
      reload();
    } catch (caught) {
      setState({ ok: false, message: caught?.message || "保存失败" });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setState(null);
    try {
      const result = await resetCoachPrompt();
      setDraft(result.prompt);
      setState({ ok: true, message: "已恢复默认模板" });
    } catch (caught) {
      setState({ ok: false, message: caught?.message || "重置失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="review-prompt">
      <summary>
        自定义提示词{promptResult.data?.customized ? "（已自定义）" : "（默认）"}
      </summary>
      <p className="review-prompt__hint">
        变量：<code>{"{{date}}"}</code> 日期、<code>{"{{session}}"}</code> 时段标签。
        数据事实段（指数/持仓/情绪面/事件）由系统自动拼接在模板之后，不受编辑影响。
      </p>
      <textarea
        aria-label="复盘提示词模板"
        className="review-prompt__editor"
        onChange={(e) => setDraft(e.target.value)}
        rows={14}
        value={draft}
      />
      <div className="review-prompt__ops">
        <button disabled={busy || !draft.trim()} onClick={save} type="button">保存</button>
        <button disabled={busy} onClick={reset} type="button">恢复默认</button>
        {state ? (
          <span className={state.ok ? "review-prompt__ok" : "review-prompt__err"}>{state.message}</span>
        ) : null}
      </div>
    </details>
  );
}

function ReviewSummaryBlock({ stocks, date, onSaved }) {
  const [summaries, setSummaries] = useState({ intraday: null, close: null });

  const reload = useCallback(() => {
    loadDailyReviewSummary(date).then((result) => {
      setSummaries({
        intraday: result.data?.intraday ?? null,
        close: result.data?.close ?? null,
      });
    });
  }, [date]);
  useEffect(() => { reload(); }, [reload]);

  const saved = useCallback(() => {
    reload();
    onSaved?.();
  }, [reload, onSaved]);

  return (
    <div className="review-summary-block">
      <div className="review-summary-grid">
        <SessionSummaryCard
          date={date}
          entry={summaries.intraday}
          onSaved={saved}
          session="intraday"
          stocks={stocks}
          title="AI 盘中总结"
        />
        <SessionSummaryCard
          date={date}
          entry={summaries.close}
          onSaved={saved}
          session="close"
          stocks={stocks}
          title="AI 收盘复盘"
        />
      </div>
      <PromptEditor />
    </div>
  );
}

export function DailyReviewPanel({ stocks = [], portfolioSlot = null }) {
  const [indicesResult, setIndicesResult] = useState({ data: null, source: "loading" });
  const [timelineResult, setTimelineResult] = useState({ data: null, source: "loading" });
  const [date] = useState(() => new Date().toISOString().slice(0, 10));

  const reload = useCallback(() => {
    loadDailyReviewIndices(date).then(setIndicesResult);
    loadDailyReviewTimeline(date).then(setTimelineResult);
  }, [date]);

  useEffect(() => { reload(); }, [reload]);

  const indices = indicesResult.data?.indices ?? [];
  const timeline = timelineResult.data?.items ?? [];

  return (
    <section className="review-panel" aria-label="每日复盘">
      <div className="review-panel__head">
        <h2>今日复盘 · {date}</h2>
        <span className="review-panel__meta">
          {indices.length > 0 ? `${indices.length} 大指数 · ${timeline.filter((i) => i.source !== "ai").length} 条事件` : "读取中"}
        </span>
      </div>

      <div className="review-indices">
        {indices.length > 0 ? indices.map((index) => (
          <IndexCard index={index} key={index.symbol} />
        )) : (
          <div className="review-panel__empty">
            {indicesResult.source === "loading" ? "指数数据读取中…" : "指数数据暂不可用。"}
          </div>
        )}
      </div>

      {portfolioSlot}

      <ReviewSummaryBlock stocks={stocks} date={date} onSaved={reload} />

      <div className="review-timeline-block">
        <h3>当日事件时间线</h3>
        <ManualEventForm onAdded={reload} />
        {timeline.length > 0 ? (
          <ul className="review-timeline">
            {timeline.map((item) => (
              <TimelineRow item={item} key={item.id} onRemoved={reload} />
            ))}
          </ul>
        ) : (
          <p className="review-panel__empty">今日暂无事件。盯盘异动与手动补录都会汇总在这里。</p>
        )}
      </div>
    </section>
  );
}
