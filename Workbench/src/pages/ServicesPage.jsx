// 服务与服务器管理：单页两段清单（服务 / 服务器），行式布局。
// 探测低频：一天自动一次，行内可手动重测，均显示上次探测时间。

import { useEffect, useState } from "react";
import {
  IconCopy,
  IconExternalLink,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconTerminal2,
} from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import {
  addService,
  getDiskDirAnalysis,
  loadDisks,
  loadServices,
  loadServers,
  openServerTerminal,
  probeServerByHost,
  probeService,
  removeService,
  startDiskDirAnalysis,
  updateService,
} from "../lib/api";
import "./services.css";

function statusTone(status) {
  if (!status) return "pending";
  if (status.ok) return "up";
  return "down";
}

const TONE_LABEL = { pending: "未探测", up: "在线", down: "离线" };
const KB_PER_GB = 1024 * 1024;

const probedAtText = (probedAt) => (probedAt
  ? new Date(probedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  : "未探测");

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

function IconOp({ label, onClick, children, disabled, danger, href }) {
  if (href) {
    return (
      <a aria-label={label} className={`services-row__op${danger ? " services-row__op--danger" : ""}`} href={href} rel="noreferrer" target="_blank" title={label}>
        {children}
      </a>
    );
  }
  return (
    <button
      aria-label={label}
      className={`services-row__op${danger ? " services-row__op--danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function ServiceRow({ item, probing, onProbe, onEdit, onRemove }) {
  const tone = statusTone(item.status);
  return (
    <div className={`services-row services-row--${tone}${probing ? " services-row--probing" : ""}`}>
      <span className="services-row__status">
        <span className={`services-row__dot services-row__dot--${tone}`} />
        {TONE_LABEL[tone]}
      </span>
      <span className="services-row__name" title={item.note || item.name}>
        {item.name}
        {item.note ? <em>{item.note}</em> : null}
      </span>
      <a className="services-row__addr" href={item.url} rel="noreferrer" target="_blank">
        {item.url.replace(/^https?:\/\//, "")}
      </a>
      <span className="services-row__metric">
        {item.status?.code ? `HTTP ${item.status.code}` : item.status?.error ?? "-"}
        {item.status ? <i>{item.status.latencyMs}ms</i> : null}
      </span>
      <span className="services-row__probed">{probedAtText(item.probedAt)}</span>
      <span className="services-row__ops">
        <IconOp href={item.url} label="打开"><IconExternalLink size={14} stroke={1.7} /></IconOp>
        <IconOp disabled={probing} label={probing ? "探测中" : "探测"} onClick={onProbe}><IconRefresh size={14} stroke={1.7} /></IconOp>
        <IconOp label="编辑" onClick={onEdit}><IconPencil size={14} stroke={1.7} /></IconOp>
        <IconOp danger label="删除" onClick={onRemove}><IconTrash size={14} stroke={1.7} /></IconOp>
      </span>
    </div>
  );
}

function ServerRow({ item, probing, onProbe, onOpen }) {
  const tone = statusTone(item.status);
  const target = `${item.user ? `${item.user}@` : ""}${item.hostName ?? item.host}:${item.port ?? 22}`;
  return (
    <div className={`services-row services-row--${tone}${probing ? " services-row--probing" : ""}`}>
      <span className="services-row__status">
        <span className={`services-row__dot services-row__dot--${tone}`} />
        {TONE_LABEL[tone]}
      </span>
      <span className="services-row__name" title={(item.profiles ?? []).join(", ") || item.host}>
        {item.host}
        {item.source === "iterm" ? <em>iTerm</em> : null}
      </span>
      <span className="services-row__addr services-row__addr--plain" title={item.status?.banner ?? ""}>
        {target}
      </span>
      <span className="services-row__metric">
        {item.status?.ok ? "SSH 22" : item.status?.error ?? "-"}
        {item.status ? <i>{item.status.latencyMs}ms</i> : null}
      </span>
      <span className="services-row__probed">{probedAtText(item.probedAt)}</span>
      <span className="services-row__ops">
        <IconOp label="复制 ssh 命令" onClick={() => navigator.clipboard?.writeText(`ssh ${item.host}`).catch(() => {})}><IconCopy size={14} stroke={1.7} /></IconOp>
        <IconOp disabled={probing} label={probing ? "探测中" : "探测"} onClick={onProbe}><IconRefresh size={14} stroke={1.7} /></IconOp>
        <IconOp label="在 iTerm 打开" onClick={onOpen}><IconTerminal2 size={14} stroke={1.7} /></IconOp>
      </span>
    </div>
  );
}

function diskTone(usePct) {
  if (usePct >= 95) return "danger";
  if (usePct >= 85) return "warn";
  return "ok";
}

function humanSize(kb) {
  if (kb >= KB_PER_GB) return `${(kb / KB_PER_GB).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

// 卷的目录分析：展开即启动（手动触发），du 流式可边跑边看，完成即停轮询。
function DiskDirPanel({ mount }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await getDiskDirAnalysis(mount);
        if (!stopped) setState(result);
        if (result?.status !== "done" && result?.status !== "failed") {
          timer = window.setTimeout(poll, 2000);
        }
      } catch {
        if (!stopped) timer = window.setTimeout(poll, 3000);
      }
    };
    void startDiskDirAnalysis(mount).then(poll).catch(poll);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [mount]);

  if (!state) return <p className="disks-dirs__hint">分析已启动…</p>;
  if (state.status === "failed") return <p className="disks-dirs__hint disks-dirs__hint--error">{state.error ?? "分析失败"}</p>;

  const maxKb = state.items?.[0]?.kb ?? 1;
  return (
    <div className="disks-dirs">
      <p className="disks-dirs__hint">
        {state.status === "running"
          ? `分析中…已发现 ${state.items.length} 个目录（du 全量遍历，大卷需数分钟）`
          : `共 ${state.items.length} 个一级目录 · 分析于 ${new Date(state.finishedAt).toLocaleTimeString("zh-CN")}`}
      </p>
      <div className="disks-dirs__list">
        {(state.items ?? []).map((item) => (
          <div className="disks-dirs__row" key={item.name}>
            <span className="disks-dirs__name" title={`${mount === "/" ? "" : mount}/${item.name}`}>{item.name}</span>
            <div className="disks-dirs__bar">
              <span style={{ width: `${Math.max((item.kb / maxKb) * 100, 1)}%` }} />
            </div>
            <span className="disks-dirs__size">{humanSize(item.kb)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiskBar({ disk }) {
  const tone = diskTone(disk.usePct);
  return (
    <div className="disks-bar" role="img" aria-label={`${disk.mount} 已用 ${disk.usePct}%`}>
      <span className={`disks-bar__used disks-bar__used--${tone}`} style={{ width: `${Math.min(disk.usePct, 100)}%` }} />
    </div>
  );
}

const ROW_HEADER = ["状态", "名称", "地址", "指标", "上次探测", ""];

export function ServicesPage() {
  const [data, setData] = useState({ items: [], total: 0 });
  const [servers, setServers] = useState({ items: [], total: 0 });
  const [disks, setDisks] = useState({ items: [], totalGb: 0, usedGb: 0 });
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [probingKey, setProbingKey] = useState(null);
  const [disksRefreshing, setDisksRefreshing] = useState(false);
  // 默认全部展开（自动启动目录分析）；点击卷行可收起/再展开。
  const [collapsedMounts, setCollapsedMounts] = useState(() => new Set());

  const refresh = async () => {
    await Promise.all([
      loadServices().then((response) => setData(response ?? { items: [], total: 0 })).catch(() => {}),
      loadServers().then((response) => setServers(response ?? { items: [], total: 0 })).catch(() => {}),
      loadDisks().then((response) => setDisks(response ?? { items: [], totalGb: 0, usedGb: 0 })).catch(() => {}),
    ]);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []); // 无自动轮询：探测一天一次由服务端缓存控制，手动按钮才重测。

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

  // 磁盘为纯手动刷新：仅按钮触发，不做定时/缓存。
  const refreshDisks = async () => {
    if (disksRefreshing) return;
    setDisksRefreshing(true);
    try {
      const response = await loadDisks();
      setDisks(response ?? { items: [], totalGb: 0, usedGb: 0 });
    } catch { /* 失败保留旧数据 */ }
    finally { setDisksRefreshing(false); }
  };

  const serviceItems = data.items ?? [];
  const serverItems = servers.items ?? [];
  const upCount = serviceItems.filter((item) => item.status?.ok).length;
  const serversUp = serverItems.filter((item) => item.status?.ok).length;
  const allProbed = [...serviceItems, ...serverItems].filter((item) => item.probedAt);
  const lastProbed = allProbed.map((item) => item.probedAt).sort().at(-1);

  return (
    <div className="page page--services">
      <PageHeader
        eyebrow="OPS · SERVICES"
        title="服务管理"
        description="云上服务与主机的统一入口。探测一天自动一次，行内可手动重测。"
        aside={
          <div className="services-head-ops">
            <button className="services-head-ops--primary" onClick={() => { setAdding(true); setEditId(null); }} type="button">
              <IconPlus aria-hidden="true" size={14} stroke={1.7} /> 添加服务
            </button>
          </div>
        }
      />

      <div className="services-meta">
        <span>服务 {serviceItems.length}（在线 {upCount}）</span>
        <span>服务器 {serverItems.length}（在线 {serversUp}）</span>
        {lastProbed ? <span>最近探测 {probedAtText(lastProbed)}</span> : null}
      </div>

      {adding ? (
        <ServiceForm busy={busy} error={formError} initial={{ name: "", url: "", note: "" }} onCancel={() => setAdding(false)} onSubmit={(draft) => submit(draft)} />
      ) : null}

      <section aria-label="服务">
        <h2 className="services-section">服务</h2>
        {loading ? (
          <div className="services-rows" aria-hidden="true">
            {[0, 1, 2].map((key) => <div className="services-row-skeleton" key={key} />)}
          </div>
        ) : serviceItems.length === 0 ? (
          <p className="services-empty-line">还没有注册服务。点右上「添加服务」把云上的入口集中到这里。</p>
        ) : (
          <div className="services-rows">
            <div aria-hidden="true" className="services-row services-row--head">
              {ROW_HEADER.map((label, index) => <span key={index}>{label}</span>)}
            </div>
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
              <ServiceRow
                item={item}
                key={item.id}
                onEdit={() => setEditId(item.id)}
                onProbe={() => probeOne(item)}
                onRemove={() => remove(item)}
                probing={probingKey === item.id}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="服务器">
        <h2 className="services-section">服务器</h2>
        {loading ? (
          <div className="services-rows" aria-hidden="true">
            {[0, 1].map((key) => <div className="services-row-skeleton" key={key} />)}
          </div>
        ) : serverItems.length === 0 ? (
          <p className="services-empty-line">没有发现主机。把服务器加进 ~/.ssh/config（Host 别名 + HostName），这里会自动出现。</p>
        ) : (
          <div className="services-rows">
            <div aria-hidden="true" className="services-row services-row--head">
              {ROW_HEADER.map((label, index) => <span key={index}>{label}</span>)}
            </div>
            {serverItems.map((item) => (
              <ServerRow
                item={item}
                key={item.host}
                onOpen={() => openServerTerminal(item.host).catch(() => {})}
                onProbe={() => probeOne(item)}
                probing={probingKey === item.host}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label="本机磁盘">
        <h2 className="services-section">
          本机磁盘
          <button
            className="services-section__refresh"
            disabled={disksRefreshing}
            onClick={() => void refreshDisks()}
            type="button"
          >
            <IconRefresh aria-hidden="true" size={13} stroke={1.7} />
            {disksRefreshing ? "读取中…" : "刷新"}
          </button>
        </h2>
        {loading ? (
          <div className="services-rows" aria-hidden="true">
            {[0, 1].map((key) => <div className="services-row-skeleton" key={key} />)}
          </div>
        ) : (disks.items ?? []).length === 0 ? (
          <p className="services-empty-line">读取磁盘信息失败。</p>
        ) : (
          <>
            <div className="services-meta">
              <span>共 {disks.items.length} 个卷</span>
              <span>总容量 {disks.totalGb} GB</span>
              <span>已用 {disks.usedGb} GB</span>
              <span>读取于 {new Date(disks.checkedAt).toLocaleTimeString("zh-CN")}</span>
            </div>
            <div className="disks-list">
              {(disks.items ?? []).map((disk) => {
                const expanded = !collapsedMounts.has(disk.mount);
                const toggle = () => setCollapsedMounts((prev) => {
                  const next = new Set(prev);
                  if (next.has(disk.mount)) next.delete(disk.mount);
                  else next.add(disk.mount);
                  return next;
                });
                return (
                  <div className={`disks-rowwrap${expanded ? " disks-rowwrap--open" : ""}`} key={disk.mount}>
                    <div
                      className={`disks-row disks-row--${diskTone(disk.usePct)}`}
                      onClick={toggle}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") toggle(); }}
                    >
                      <span className="disks-row__mount" title={`${disk.filesystem}（含 ${disk.mount}）`}>{disk.mount}</span>
                      <span className="disks-row__nums">
                        <b>{disk.usedGb} / {disk.totalGb} GB</b>
                        <i>可用 {disk.availGb} GB</i>
                      </span>
                      <DiskBar disk={disk} />
                      <span className={`disks-row__pct disks-row__pct--${diskTone(disk.usePct)}`}>{disk.usePct}%</span>
                    </div>
                    {expanded ? <DiskDirPanel mount={disk.mount} /> : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
