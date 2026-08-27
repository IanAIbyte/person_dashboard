// 服务管理：云上自部署服务的统一入口与健康状态仪表盘。
// 数据自治（GET /api/services 含 60s 服务端探测缓存），增删改经 vaultSync 自动刷新。

import { useEffect, useState } from "react";
import { IconExternalLink, IconPlus, IconPencil, IconTrash, IconRefresh, IconServer2 } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { addService, loadServices, removeService, updateService } from "../lib/api";
import "./services.css";

function statusTone(status) {
  if (!status) return "pending";
  if (status.ok) return "up";
  return "down";
}

const TONE_LABEL = { pending: "检测中", up: "在线", down: "离线" };

function ServiceForm({ initial, busy, error, onSubmit, onCancel }) {
  const [draft, setDraft] = useState(initial);
  const set = (key) => (event) => setDraft((state) => ({ ...state, [key]: event.target.value }));
  return (
    <form
      className="services-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft);
      }}
    >
      <input aria-label="服务名" onChange={set("name")} placeholder="服务名（如 Reactive Resume）" value={draft.name} />
      <input aria-label="地址" onChange={set("url")} placeholder="http(s)://host:port" value={draft.url} />
      <input aria-label="备注（可选）" onChange={set("note")} placeholder="备注（可选）" value={draft.note} />
      <div className="services-form__ops">
        <button disabled={busy || !draft.name.trim() || !draft.url.trim()} type="submit">
          {busy ? "保存中…" : "保存"}
        </button>
        {onCancel ? <button onClick={onCancel} type="button">取消</button> : null}
        {error ? <span className="services-form__error">{error}</span> : null}
      </div>
    </form>
  );
}

export function ServicesPage() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const refresh = async () => {
    try {
      const response = await loadServices();
      setData(response ?? { items: [], total: 0 });
    } catch { /* 降级：保留旧数据 */ }
    finally { setLoading(false); }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 60_000); // 页面活跃期间刷新健康状态
    return () => window.clearInterval(timer);
  }, []);

  const submit = async (draft, id) => {
    setBusy(true);
    setFormError(null);
    try {
      if (id) await updateService(id, draft);
      else await addService(draft);
      setAdding(false);
      setEditId(null);
      await refresh();
    } catch (caught) {
      setFormError(caught?.message ?? "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`删除服务「${item.name}」？`)) return;
    await removeService(item.id).catch(() => {});
    await refresh();
  };

  const items = data.items ?? [];
  const upCount = items.filter((item) => item.status?.ok).length;
  const probed = items.filter((item) => item.status);
  const avgLatency = probed.length
    ? Math.round(probed.reduce((sum, item) => sum + (item.status.latencyMs ?? 0), 0) / probed.length)
    : null;
  const lastChecked = probed
    .map((item) => item.status.checkedAt)
    .sort()
    .at(-1);

  return (
    <div className="page page--services">
      <PageHeader
        eyebrow="OPS · SERVICES"
        title="服务管理"
        description="云上自部署服务的统一入口：健康状态每分钟探测一次（HEAD），离线一眼可见。"
        aside={
          <div className="services-head-ops">
            <button onClick={() => void refresh()} type="button">
              <IconRefresh aria-hidden="true" size={14} stroke={1.7} /> 刷新
            </button>
            <button className="services-head-ops--primary" onClick={() => { setAdding(true); setEditId(null); }} type="button">
              <IconPlus aria-hidden="true" size={14} stroke={1.7} /> 添加服务
            </button>
          </div>
        }
      />

      <div className="services-meta">
        <span>{items.length} 个服务</span>
        <span className="services-meta__up">在线 {upCount}</span>
        <span>离线 {items.length - upCount}</span>
        {avgLatency != null ? <span>平均延迟 {avgLatency}ms</span> : null}
        {lastChecked ? <span>最近检查 {new Date(lastChecked).toLocaleTimeString("zh-CN")}</span> : null}
      </div>

      {adding ? (
        <ServiceForm busy={busy} error={formError} initial={{ name: "", url: "", note: "" }} onCancel={() => setAdding(false)} onSubmit={(draft) => submit(draft)} />
      ) : null}

      {loading ? (
        <div className="services-grid" aria-hidden="true">
          {[0, 1, 2].map((key) => <div className="services-skeleton" key={key} />)}
        </div>
      ) : items.length === 0 && !adding ? (
        <div className="services-empty">
          <IconServer2 aria-hidden="true" size={22} stroke={1.6} />
          <p>还没有注册服务。点「添加服务」，把云上的入口集中到这里。</p>
        </div>
      ) : (
        <div className="services-grid">
          {items.map((item) => editId === item.id ? (
            <ServiceForm
              busy={busy}
              error={formError}
              initial={{ name: item.name, url: item.url, note: item.note ?? "" }}
              key={item.id}
              onCancel={() => setEditId(null)}
              onSubmit={(draft) => submit(draft, item.id)}
            />
          ) : (
            <article className={`services-card services-card--${statusTone(item.status)}`} key={item.id}>
              <header className="services-card__head">
                <span className={`services-card__dot services-card__dot--${statusTone(item.status)}`} title={TONE_LABEL[statusTone(item.status)]} />
                <strong>{item.name}</strong>
                <span className="services-card__state">{TONE_LABEL[statusTone(item.status)]}</span>
              </header>
              <a className="services-card__url" href={item.url} rel="noreferrer" target="_blank">
                {item.url.replace(/^https?:\/\//, "")}
              </a>
              <div className="services-card__stats">
                <span>{item.status?.code ? `HTTP ${item.status.code}` : item.status?.error ?? "-"}</span>
                <span>{item.status ? `${item.status.latencyMs}ms` : "-"}</span>
              </div>
              {item.note ? <p className="services-card__note">{item.note}</p> : null}
              <footer className="services-card__ops">
                <a href={item.url} rel="noreferrer" target="_blank">
                  <IconExternalLink aria-hidden="true" size={13} stroke={1.7} /> 打开
                </a>
                <button onClick={() => { setEditId(item.id); setAdding(false); }} type="button">
                  <IconPencil aria-hidden="true" size={13} stroke={1.7} /> 编辑
                </button>
                <button className="services-card__remove" onClick={() => remove(item)} type="button">
                  <IconTrash aria-hidden="true" size={13} stroke={1.7} /> 删除
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
