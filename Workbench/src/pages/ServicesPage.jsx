// 服务与服务器管理：云上 HTTP 服务统一入口 + ssh.config 派生的主机面板。
// 探测低频策略：服务端缓存 24h（自动一天一次），卡片可手动重测；显示上次探测时间。

import { useEffect, useState } from "react";
import {
  IconExternalLink,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconServer2,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import {
  addService,
  loadServices,
  loadServers,
  openServerTerminal,
  probeServerByHost,
  probeService,
  removeService,
  updateService,
} from "../lib/api";
import "./services.css";

function statusTone(status) {
  if (!status) return "pending";
  if (status.ok) return "up";
  return "down";
}

const TONE_LABEL = { pending: "未探测", up: "在线", down: "离线" };

const probedAtText = (probedAt) => (probedAt ? new Date(probedAt).toLocaleString("zh-CN", { hour12: false }) : "未探测");

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

function ServiceCard({ item, probing, onProbe, onEdit, onRemove }) {
  const tone = statusTone(item.status);
  return (
    <article className={`services-card services-card--${tone}`}>
      <header className="services-card__head">
        <span className={`services-card__dot services-card__dot--${tone}`} title={TONE_LABEL[tone]} />
        <strong>{item.name}</strong>
        <span className="services-card__state">{TONE_LABEL[tone]}</span>
      </header>
      <a className="services-card__url" href={item.url} rel="noreferrer" target="_blank">
        {item.url.replace(/^https?:\/\//, "")}
      </a>
      <div className="services-card__stats">
        <span>{item.status?.code ? `HTTP ${item.status.code}` : item.status?.error ?? "-"}</span>
        <span>{item.status ? `${item.status.latencyMs}ms` : "-"}</span>
      </div>
      {item.note ? <p className="services-card__note">{item.note}</p> : null}
      <p className="services-card__probed">上次探测 {probedAtText(item.probedAt)}</p>
      <footer className="services-card__ops">
        <a href={item.url} rel="noreferrer" target="_blank">
          <IconExternalLink aria-hidden="true" size={13} stroke={1.7} /> 打开
        </a>
        <button disabled={probing} onClick={onProbe} type="button">
          <IconRefresh aria-hidden="true" size={13} stroke={1.7} /> {probing ? "探测中…" : "探测"}
        </button>
        <button onClick={onEdit} type="button">
          <IconPencil aria-hidden="true" size={13} stroke={1.7} /> 编辑
        </button>
        <button className="services-card__remove" onClick={onRemove} type="button">
          <IconTrash aria-hidden="true" size={13} stroke={1.7} /> 删除
        </button>
      </footer>
    </article>
  );
}

function ServerCard({ item, probing, onProbe, onOpen }) {
  const tone = statusTone(item.status);
  const sshCommand = `ssh ${item.host}`;
  return (
    <article className={`services-card services-card--${tone}`}>
      <header className="services-card__head">
        <span className={`services-card__dot services-card__dot--${tone}`} title={TONE_LABEL[tone]} />
        <strong>{item.host}</strong>
        <span className="services-card__state">{TONE_LABEL[tone]}</span>
      </header>
      <div className="services-card__stats">
        <span>{item.hostName ?? item.host}</span>
        {item.user ? <span>{item.user}@</span> : null}
        <span>:{item.port ?? 22}</span>
      </div>
      {item.status?.banner ? <p className="services-card__note">{item.status.banner}</p> : null}
      {item.status && !item.status.ok && item.status.error ? (
        <p className="services-card__note services-card__note--error">{item.status.error}</p>
      ) : null}
      <div className="services-card__tags">
        <span className="services-card__tag">{item.source === "iterm" ? "iTerm" : "ssh config"}</span>
        {item.status ? <span className="services-card__tag">{item.status.latencyMs}ms</span> : null}
        {(item.profiles ?? []).slice(0, 2).map((profile) => (
          <span className="services-card__tag" key={profile}>{profile}</span>
        ))}
      </div>
      <p className="services-card__probed">上次探测 {probedAtText(item.probedAt)}</p>
      <footer className="services-card__ops">
        <button onClick={() => navigator.clipboard?.writeText(sshCommand).catch(() => {})} type="button">
          <IconTerminal2 aria-hidden="true" size={13} stroke={1.7} /> 复制 ssh
        </button>
        <button disabled={probing} onClick={onProbe} type="button">
          <IconRefresh aria-hidden="true" size={13} stroke={1.7} /> {probing ? "探测中…" : "探测"}
        </button>
        <button className="services-card__open" onClick={onOpen} type="button">
          <IconTerminal2 aria-hidden="true" size={13} stroke={1.7} /> iTerm 打开
        </button>
      </footer>
    </article>
  );
}

export function ServicesPage() {
  const [tab, setTab] = useState("services");
  const [data, setData] = useState({ items: [], total: 0 });
  const [servers, setServers] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [probingKey, setProbingKey] = useState(null);

  const refresh = async () => {
    await Promise.all([
      loadServices().then((response) => setData(response ?? { items: [], total: 0 })).catch(() => {}),
      loadServers().then((response) => setServers(response ?? { items: [], total: 0 })).catch(() => {}),
    ]);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []); // 无自动轮询：探测一天一次由服务端缓存控制，手动点按钮才重测。

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

  const probeOne = async (item) => {
    setProbingKey(item.id ?? item.host);
    try {
      if (item.id) {
        const { status, probedAt } = await probeService(item.id);
        setData((state) => ({
          ...state,
          items: state.items.map((entry) => (entry.id === item.id ? { ...entry, status, probedAt } : entry)),
        }));
      } else {
        const { status, probedAt } = await probeServerByHost(item.host);
        setServers((state) => ({
          ...state,
          items: state.items.map((entry) => (entry.host === item.host ? { ...entry, status, probedAt } : entry)),
        }));
      }
    } catch { /* 探测失败保留旧状态 */ }
    finally { setProbingKey(null); }
  };

  const remove = async (item) => {
    if (!window.confirm(`删除服务「${item.name}」？`)) return;
    await removeService(item.id).catch(() => {});
    await refresh();
  };

  const openTerminal = async (item) => {
    await openServerTerminal(item.host).catch(() => {});
  };

  const serviceItems = data.items ?? [];
  const upCount = serviceItems.filter((item) => item.status?.ok).length;
  const probed = serviceItems.filter((item) => item.status);
  const avgLatency = probed.length
    ? Math.round(probed.reduce((sum, item) => sum + (item.status.latencyMs ?? 0), 0) / probed.length)
    : null;
  const serverItems = servers.items ?? [];
  const serversUp = serverItems.filter((item) => item.status?.ok).length;

  return (
    <div className="page page--services">
      <PageHeader
        eyebrow="OPS · SERVICES"
        title="服务管理"
        description="云上服务与主机的统一入口。健康探测一天自动一次，卡片可手动重测，均显示上次探测时间。"
        aside={
          <div className="services-head-ops">
            {tab === "services" ? (
              <button className="services-head-ops--primary" onClick={() => { setAdding(true); setEditId(null); }} type="button">
                <IconPlus aria-hidden="true" size={14} stroke={1.7} /> 添加服务
              </button>
            ) : null}
          </div>
        }
      />

      <div className="services-tabs" role="tablist">
        <button
          aria-selected={tab === "services"}
          className={`services-tabs__tab${tab === "services" ? " services-tabs__tab--on" : ""}`}
          onClick={() => setTab("services")}
          role="tab"
          type="button"
        >
          服务 {serviceItems.length}
        </button>
        <button
          aria-selected={tab === "servers"}
          className={`services-tabs__tab${tab === "servers" ? " services-tabs__tab--on" : ""}`}
          onClick={() => setTab("servers")}
          role="tab"
          type="button"
        >
          服务器 {serverItems.length}
        </button>
      </div>

      {tab === "services" ? (
        <>
          <div className="services-meta">
            <span>{serviceItems.length} 个服务</span>
            <span className="services-meta__up">在线 {upCount}</span>
            <span>离线 {serviceItems.length - upCount}</span>
            {avgLatency != null ? <span>平均延迟 {avgLatency}ms</span> : null}
          </div>
          {adding ? (
            <ServiceForm busy={busy} error={formError} initial={{ name: "", url: "", note: "" }} onCancel={() => setAdding(false)} onSubmit={(draft) => submit(draft)} />
          ) : null}
          {loading ? (
            <div className="services-grid" aria-hidden="true">
              {[0, 1, 2].map((key) => <div className="services-skeleton" key={key} />)}
            </div>
          ) : serviceItems.length === 0 && !adding ? (
            <div className="services-empty">
              <IconServer2 aria-hidden="true" size={22} stroke={1.6} />
              <p>还没有注册服务。点「添加服务」，把云上的入口集中到这里。</p>
            </div>
          ) : (
            <div className="services-grid">
              {serviceItems.map((item) => editId === item.id ? (
                <ServiceForm
                  busy={busy}
                  error={formError}
                  initial={{ name: item.name, url: item.url, note: item.note ?? "" }}
                  key={item.id}
                  onCancel={() => setEditId(null)}
                  onSubmit={(draft) => submit(draft, item.id)}
                />
              ) : (
                <ServiceCard
                  item={item}
                  key={item.id}
                  onEdit={() => { setEditId(item.id); setAdding(false); }}
                  onProbe={() => probeOne(item)}
                  onRemove={() => remove(item)}
                  probing={probingKey === item.id}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="services-meta">
            <span>{serverItems.length} 台主机</span>
            <span className="services-meta__up">在线 {serversUp}</span>
            <span>离线 {serverItems.length - serversUp}</span>
            <span>来源 ~/.ssh/config + iTerm</span>
          </div>
          {loading ? (
            <div className="services-grid" aria-hidden="true">
              {[0, 1, 2].map((key) => <div className="services-skeleton" key={key} />)}
            </div>
          ) : serverItems.length === 0 ? (
            <div className="services-empty">
              <IconTerminal2 aria-hidden="true" size={22} stroke={1.6} />
              <p>没有发现主机。把服务器加进 ~/.ssh/config（Host 别名 + HostName），这里会自动出现。</p>
            </div>
          ) : (
            <div className="services-grid">
              {serverItems.map((item) => (
                <ServerCard
                  item={item}
                  key={item.host}
                  onOpen={() => openTerminal(item)}
                  onProbe={() => probeOne(item)}
                  probing={probingKey === item.host}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
