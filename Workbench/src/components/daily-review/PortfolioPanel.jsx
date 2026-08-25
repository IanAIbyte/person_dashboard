// 持仓分析面板：手动录入持仓（股数+成本），结合行情计算市值/浮盈亏/当日盈亏/权重，
// 行点击展开当日分时（复用 IntradayChart），清仓标记保留历史。
// stocks 传入股票池用于 datalist 快速选择（池外代码可手输）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import {
  addPosition,
  loadPortfolio,
  loadStockIntraday,
  removePosition,
  updatePosition,
} from "../../lib/api";
import { IntradayChart } from "./DailyReviewPanel";

function pctText(value) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value}%`;
}

function pctClass(value) {
  return value > 0 ? "review-up" : value < 0 ? "review-down" : "review-flat";
}

// 双击就地编辑单元格：回车/失焦提交，Esc 取消。validate 返回 false 则回退不发请求。
function EditableCell({
  value,
  onCommit,
  type = "text",
  validate = null,
  className = "",
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const start = (event) => {
    event.stopPropagation();
    setDraft(value);
    setEditing(true);
  };

  if (editing) {
    const commit = () => {
      const next = type === "number" ? Number(draft) : draft.trim();
      setEditing(false);
      if (String(next) === String(value)) return;
      if (validate && !validate(next)) return;
      onCommit(next);
    };
    const cancel = () => setEditing(false);
    return (
      <input
        autoFocus
        className={`review-portfolio__edit-input ${className}`}
        onBlur={commit}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") cancel();
        }}
        type={type}
        value={draft}
      />
    );
  }

  return (
    <span
      className={`review-portfolio__editable ${className}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={start}
      title="双击修改"
    >
      {value ?? "—"}
    </span>
  );
}

function PositionForm({ stocks, editing, onDone, onCancel }) {
  const [code, setCode] = useState(editing?.code ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [shares, setShares] = useState(editing?.shares ?? "");
  const [costPrice, setCostPrice] = useState(editing?.costPrice ?? "");
  const [openedAt, setOpenedAt] = useState(editing?.openedAt ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // datalist 选中时带出名称；手输代码不强制匹配池。
    const match = stocks.find((stock) => stock.code === code);
    if (match?.name) setName((current) => current || match.name);
  }, [code, stocks]);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const payload = {
      code: code.trim(),
      name: name.trim() || null,
      shares: Number(shares),
      costPrice: Number(costPrice),
      ...(openedAt ? { openedAt } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      if (editing) {
        await updatePosition(editing.id, payload);
      } else {
        await addPosition(payload);
      }
      onDone();
    } catch (caught) {
      setError(caught?.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="review-position-form" onSubmit={submit}>
      <input
        aria-label="股票代码"
        className="review-position-form__code"
        list="review-position-codes"
        maxLength={6}
        onChange={(e) => setCode(e.target.value)}
        placeholder="代码"
        value={code}
      />
      <datalist id="review-position-codes">
        {stocks.map((stock) => (
          <option key={stock.code} value={stock.code}>{stock.name}</option>
        ))}
      </datalist>
      <input
        aria-label="名称（可自动带出）"
        className="review-position-form__name"
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        placeholder="名称"
        value={name}
      />
      <input
        aria-label="股数"
        className="review-position-form__shares"
        min="1"
        onChange={(e) => setShares(e.target.value)}
        placeholder="股数"
        type="number"
        value={shares}
      />
      <input
        aria-label="成本价"
        className="review-position-form__cost"
        min="0.01"
        onChange={(e) => setCostPrice(e.target.value)}
        placeholder="成本价"
        step="0.01"
        type="number"
        value={costPrice}
      />
      <input
        aria-label="建仓日期（可选）"
        className="review-position-form__date"
        onChange={(e) => setOpenedAt(e.target.value)}
        type="date"
        value={openedAt}
      />
      <input
        aria-label="备注（可选）"
        className="review-position-form__note"
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        placeholder="备注（可选）"
        value={note}
      />
      <button className="review-position-form__submit" disabled={busy || !/^\d{6}$/.test(code) || !shares || !costPrice} type="submit">
        <IconPlus aria-hidden="true" size={13} />
        {busy ? "保存中" : editing ? "保存修改" : "添加持仓"}
      </button>
      {editing ? (
        <button className="review-position-form__cancel" onClick={onCancel} type="button">
          <IconX aria-hidden="true" size={13} /> 取消
        </button>
      ) : null}
      {error ? <span className="review-position-form__error">{error}</span> : null}
    </form>
  );
}

function CloseForm({ position, onDone, onCancel }) {
  const [closedPrice, setClosedPrice] = useState(position.quote?.price ?? "");
  const [closedAt, setClosedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await updatePosition(position.id, {
        closedAt,
        closedPrice: Number(closedPrice),
      });
      onDone();
    } catch (caught) {
      setError(caught?.message || "清仓失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-position-close">
      <span>清仓价</span>
      <input min="0.01" onChange={(e) => setClosedPrice(e.target.value)} step="0.01" type="number" value={closedPrice} />
      <span>日期</span>
      <input onChange={(e) => setClosedAt(e.target.value)} type="date" value={closedAt} />
      <button disabled={busy || !closedPrice || !closedAt} onClick={submit} type="button">确认清仓</button>
      <button onClick={onCancel} type="button">取消</button>
      {error ? <span className="review-position-form__error">{error}</span> : null}
    </div>
  );
}

function PositionRow({ position, maxWeight, onEdit, onReload }) {
  const [expanded, setExpanded] = useState(false);
  const [intradayResult, setIntradayResult] = useState(null);
  const [closing, setClosing] = useState(false);
  const quote = position.quote;

  useEffect(() => {
    if (!expanded || intradayResult?.code === position.code) return;
    let cancelled = false;
    loadStockIntraday(position.code).then((result) => {
      if (!cancelled) setIntradayResult({ ...result.data, code: position.code });
    });
    return () => { cancelled = true; };
  }, [expanded, position.code, intradayResult?.code]);

  const weightWidth = maxWeight > 0 && position.weight != null
    ? Math.max(4, (position.weight / maxWeight) * 100)
    : 0;

  // 双击单元格就地保存；服务端校验失败时静默，重载后回显真实状态。
  const commitField = async (patch) => {
    try {
      await updatePosition(position.id, patch);
      onReload();
    } catch { /* 保留原值 */ }
  };

  return (
    <>
      <tr
        className={`review-portfolio__row${expanded ? " review-portfolio__row--open" : ""}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <td className="review-portfolio__name">
          <div>
            <strong>
              <EditableCell
                value={position.name ?? position.code}
                onCommit={(next) => commitField({ name: next })}
              />
            </strong>
            <span className="review-portfolio__code">
              <EditableCell
                value={position.code}
                className="review-portfolio__edit-code"
                onCommit={(next) => commitField({ code: next })}
              />
            </span>
          </div>
          <div className="review-portfolio__weight" title={`仓位占比 ${position.weight ?? "?"}%`}>
            <span style={{ width: `${weightWidth}%` }} />
            <em>{position.weight != null ? `${position.weight}%` : "—"}</em>
          </div>
        </td>
        <td className="review-portfolio__num" onClick={(e) => e.stopPropagation()}>
          <EditableCell
            type="number"
            value={position.shares}
            onCommit={(next) => commitField({ shares: next })}
            validate={(v) => Number.isInteger(v) && v > 0}
          />
        </td>
        <td className="review-portfolio__num" onClick={(e) => e.stopPropagation()}>
          <EditableCell
            type="number"
            value={position.costPrice}
            onCommit={(next) => commitField({ costPrice: next })}
            validate={(v) => v > 0}
          />
        </td>
        <td className="review-portfolio__num">{quote?.price ?? "—"}</td>
        <td className="review-portfolio__num">{position.marketValue ?? "—"}</td>
        <td className={`review-portfolio__num ${pctClass(position.pnlPct)}`}>
          {position.pnl != null ? position.pnl : "—"}
          <em>{pctText(position.pnlPct)}</em>
        </td>
        <td className={`review-portfolio__num ${pctClass(quote?.changePct)}`}>
          {position.dayPnl != null ? position.dayPnl : "—"}
          <em>{pctText(quote?.changePct)}</em>
        </td>
        <td className="review-portfolio__ops" onClick={(e) => e.stopPropagation()}>
          <button onClick={onEdit} type="button">编辑</button>
          {closing ? (
            <button onClick={() => setClosing(false)} type="button">取消清仓</button>
          ) : (
            <button onClick={() => setClosing(true)} type="button">清仓</button>
          )}
          <button onClick={async () => { await removePosition(position.id); onReload(); }} type="button">删除</button>
        </td>
      </tr>
      {closing ? (
        <tr className="review-portfolio__subrow">
          <td colSpan={8}>
            <CloseForm
              position={position}
              onCancel={() => setClosing(false)}
              onDone={() => { setClosing(false); onReload(); }}
            />
          </td>
        </tr>
      ) : null}
      {expanded ? (
        <tr className="review-portfolio__subrow">
          <td colSpan={8}>
            {intradayResult?.intraday?.length ? (
              <IntradayChart
                intraday={intradayResult.intraday}
                prevClose={intradayResult.prevCloseReference}
              />
            ) : (
              <div className="review-chart review-chart--empty">
                {intradayResult ? "暂无分时数据" : "分时读取中…"}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function PortfolioPanel({ stocks = [] }) {
  const [result, setResult] = useState({ data: null, source: "loading" });
  const [editingId, setEditingId] = useState(null);

  const reload = useCallback(() => {
    loadPortfolio().then(setResult);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const data = result.data;
  const positions = data?.positions ?? [];
  const totals = data?.totals;
  const closed = data?.closed ?? [];
  const editing = useMemo(
    () => positions.find((item) => item.id === editingId) ?? null,
    [positions, editingId],
  );

  return (
    <section className="review-portfolio" aria-label="持仓分析">
      <div className="review-panel__head">
        <h2>持仓分析</h2>
        <span className="review-panel__meta">
          {totals && totals.positions > 0
            ? `总市值 ${totals.marketValue} · 当日 ${totals.dayPnl > 0 ? "+" : ""}${totals.dayPnl}`
            : "暂无持仓"}
        </span>
      </div>

      <PositionForm
        key={editing?.id ?? "new"}
        editing={editing}
        stocks={stocks}
        onCancel={() => setEditingId(null)}
        onDone={() => { setEditingId(null); reload(); }}
      />

      {positions.length > 0 ? (
        <>
          <table className="review-portfolio__table">
            <thead>
              <tr>
                <th>持仓</th>
                <th>股数</th>
                <th>成本</th>
                <th>现价</th>
                <th>市值</th>
                <th>浮盈亏</th>
                <th>当日</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <PositionRow
                  key={position.id}
                  maxWeight={totals?.maxWeight ?? 0}
                  position={position}
                  onEdit={() => setEditingId(position.id)}
                  onReload={reload}
                />
              ))}
            </tbody>
          </table>
          {totals ? (
            <div className="review-portfolio__totals">
              <span>总市值 <strong>{totals.marketValue}</strong></span>
              <span>总成本 <strong>{totals.cost}</strong></span>
              <span className={pctClass(totals.pnlPct)}>
                浮盈亏 <strong>{totals.pnl > 0 ? "+" : ""}{totals.pnl}</strong>（{pctText(totals.pnlPct)}）
              </span>
              <span className={pctClass(totals.dayPnl)}>
                当日 <strong>{totals.dayPnl > 0 ? "+" : ""}{totals.dayPnl}</strong>
              </span>
              <span>最大仓位 <strong>{totals.maxWeight}%</strong></span>
            </div>
          ) : null}
        </>
      ) : (
        <p className="review-panel__empty">
          {result.source === "loading" ? "持仓读取中…" : "录入上方表单添加第一笔持仓；点击持仓行可看当日分时。"}
        </p>
      )}

      {closed.length > 0 ? (
        <details className="review-portfolio__history">
          <summary>已清仓 {closed.length} 笔</summary>
          <table className="review-portfolio__table review-portfolio__table--history">
            <thead>
              <tr><th>持仓</th><th>股数</th><th>成本</th><th>清仓价</th><th>清仓日期</th><th>最终盈亏</th><th>操作</th></tr>
            </thead>
            <tbody>
              {closed.map((item) => (
                <tr key={item.id}>
                  <td>{item.name ?? item.code} <span className="review-portfolio__code">{item.code}</span></td>
                  <td className="review-portfolio__num">{item.shares}</td>
                  <td className="review-portfolio__num">{item.costPrice}</td>
                  <td className="review-portfolio__num">{item.closedPrice}</td>
                  <td className="review-portfolio__num">{item.closedAt}</td>
                  <td className={`review-portfolio__num ${pctClass(item.finalPnlPct)}`}>
                    {item.finalPnl != null ? item.finalPnl : "—"}
                    <em>{pctText(item.finalPnlPct)}</em>
                  </td>
                  <td className="review-portfolio__ops">
                    <button
                      onClick={async () => { await updatePosition(item.id, { closedAt: null, closedPrice: null }); reload(); }}
                      type="button"
                    >
                      重新持有
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}
