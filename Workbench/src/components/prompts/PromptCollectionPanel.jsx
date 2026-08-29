// 我的提示词收藏：每条是 vault 10_raw/prompts/ 下的一个 md 文件。
// vault 为唯一数据源；Obsidian 端改动经 App 级 useVaultSync（revision 递增 → 页面重挂载）触发重拉。

import { useEffect, useMemo, useState } from "react";
import { IconCopy, IconPlus, IconSearch, IconSparkles } from "@tabler/icons-react";
import { createPromptItem, deletePromptItem, loadPromptCollection, updatePromptItem } from "../../lib/api";
import { apiErrorMessage } from "../../lib/api-errors";

export function PromptCollectionPanel() {
  const [items, setItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [openIndex, setOpenIndex] = useState(-1);
  const [copiedIndex, setCopiedIndex] = useState(-1);
  const [form, setForm] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadPromptCollection();
        if (cancelled) return;
        setItems(data?.items ?? []);
        setTags(data?.tags ?? []);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(apiErrorMessage(caught, "收藏加载失败"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword && !activeTag) return items;
    return items.filter((item) => {
      if (activeTag && !item.tags.includes(activeTag)) return false;
      if (!keyword) return true;
      return (
        item.title.toLowerCase().includes(keyword) ||
        item.content.toLowerCase().includes(keyword) ||
        item.tags.some((tag) => tag.toLowerCase().includes(keyword))
      );
    });
  }, [items, query, activeTag]);

  const openCreate = () =>
    setForm({ item: null, title: "", content: "", tagText: "", source: "", busy: false, error: null });

  const openEdit = (index) => {
    const item = filtered[index];
    if (!item) return;
    setForm({
      item,
      title: item.title,
      content: item.content,
      tagText: item.tags.join("、"),
      source: item.source ?? "",
      busy: false,
      error: null,
    });
  };

  const patchForm = (changes) => setForm((state) => ({ ...state, ...changes }));

  const submitForm = async () => {
    if (!form || form.busy) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      patchForm({ error: "标题和正文不能为空。" });
      return;
    }
    const tags = form.tagText.split(/[,，、\s]+/).filter(Boolean);
    setForm((state) => ({ ...state, busy: true, error: null }));
    try {
      const payload = { title, content, tags, source: form.source.trim() };
      if (form.item) {
        await updatePromptItem(form.item.id, payload);
      } else {
        await createPromptItem(payload);
      }
      setForm(null);
      setOpenIndex(-1);
      const data = await loadPromptCollection();
      setItems(data?.items ?? []);
      setTags(data?.tags ?? []);
    } catch (caught) {
      setForm((state) => ({ ...state, busy: false, error: apiErrorMessage(caught, "保存失败") }));
    }
  };

  const removeItem = async (index) => {
    const item = filtered[index];
    if (!item) return;
    if (!window.confirm(`删除「${item.title}」？vault 中的文件会一并删除。`)) return;
    try {
      await deletePromptItem(item.id);
      const data = await loadPromptCollection();
      setItems(data?.items ?? []);
      setTags(data?.tags ?? []);
      setOpenIndex(-1);
    } catch (caught) {
      setError(apiErrorMessage(caught, "删除失败"));
    }
  };

  const copy = async (index) => {
    const item = filtered[index];
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.content);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(-1), 1500);
    } catch { /* 剪贴板被拒时静默 */ }
  };

  return (
    <div className="prompts-col">
      <div className="prompts-toolbar">
        <label className="prompts-search">
          <IconSearch aria-hidden="true" size={15} stroke={1.7} />
          <input
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索：标题、正文、标签"
            value={query}
          />
        </label>
        <button className="prompts-col__new" onClick={openCreate} type="button">
          <IconPlus aria-hidden="true" size={14} stroke={1.7} />
          新建收藏
        </button>
      </div>

      {tags.length ? (
        <div className="prompts-col__tags">
          <button
            className={`prompts-col__tag${activeTag === "" ? " prompts-col__tag--on" : ""}`}
            onClick={() => setActiveTag("")}
            type="button"
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              className={`prompts-col__tag${activeTag === tag ? " prompts-col__tag--on" : ""}`}
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? "" : tag)}
              type="button"
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="prompts-error">{error}</div> : null}

      {loading ? (
        <div className="prompts-list" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div className="prompts-skeleton" key={key}>
              <div className="prompts-skeleton__line" style={{ width: "38%" }} />
              <div className="prompts-skeleton__line" />
            </div>
          ))}
        </div>
      ) : (
        <ul className="prompts-list">
          {filtered.map((item, index) => (
            <li
              className={`prompts-item${openIndex === index ? " prompts-item--open" : ""}`}
              key={item.id}
            >
              <button
                className="prompts-item__head"
                onClick={() => setOpenIndex(openIndex === index ? -1 : index)}
                type="button"
              >
                <span className="prompts-item__title">{item.title}</span>
                {item.tags.length ? (
                  <span className="prompts-item__tags">
                    {item.tags.map((tag) => (
                      <span className="prompts-item__tag" key={tag}>#{tag}</span>
                    ))}
                  </span>
                ) : null}
              </button>
              <p className="prompts-item__preview">{item.content}</p>
              {openIndex === index ? (
                <div className="prompts-item__body">
                  <pre>{item.content}</pre>
                  <div className="prompts-item__ops">
                    <button className="prompts-item__copy" onClick={() => copy(index)} type="button">
                      <IconCopy aria-hidden="true" size={13} stroke={1.7} />
                      {copiedIndex === index ? "已复制" : "复制全文"}
                    </button>
                    <button className="prompts-item__copy" onClick={() => openEdit(index)} type="button">
                      编辑
                    </button>
                    <button className="prompts-item__copy" onClick={() => removeItem(index)} type="button">
                      删除
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!loading && filtered.length === 0 && !error ? (
        <div className="prompts-empty">
          <IconSparkles aria-hidden="true" size={20} stroke={1.6} />
          <p>还没有收藏。在公开模板里找到合适的底子改造成自己的，或点「新建收藏」。</p>
        </div>
      ) : null}

      {form ? (
        <div className="prompts-optimizer" role="dialog" aria-label={form.item ? "编辑收藏" : "新建收藏"}>
          <header className="prompts-optimizer__head">
            <strong>{form.item ? "编辑收藏" : "新建收藏"}</strong>
            <button onClick={() => setForm(null)} type="button">关闭</button>
          </header>
          <label className="prompts-optimizer__field">
            <span>标题（必填）</span>
            <input
              onChange={(event) => patchForm({ title: event.target.value })}
              placeholder="例如：代码审查提示词"
              value={form.title}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>提示词正文（必填）</span>
            <textarea
              onChange={(event) => patchForm({ content: event.target.value })}
              placeholder="粘贴提示词原文，原样保存"
              rows={10}
              value={form.content}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>标签（用逗号或顿号分隔）</span>
            <input
              onChange={(event) => patchForm({ tagText: event.target.value })}
              placeholder="写作、代码、review"
              value={form.tagText}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>来源 URL（可选）</span>
            <input
              onChange={(event) => patchForm({ source: event.target.value })}
              placeholder="https://…"
              value={form.source}
            />
          </label>
          <button
            className="prompts-optimizer__run"
            disabled={form.busy}
            onClick={submitForm}
            type="button"
          >
            {form.busy ? "保存中…" : form.item ? "保存修改" : "保存到知识库"}
          </button>
          {form.error ? <p className="prompts-optimizer__error">{form.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
