// 我的提示词收藏：每条是 vault 10_raw/prompts/ 下的一个 md 文件。
// vault 为唯一数据源；Obsidian 端改动经 App 级 useVaultSync（revision 递增 → 页面重挂载）触发重拉。

import { useEffect, useMemo, useState } from "react";
import { IconCopy, IconPlus, IconSearch, IconSparkles } from "@tabler/icons-react";
import { loadPromptCollection } from "../../lib/api";
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
        <button className="prompts-col__new" type="button">
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
    </div>
  );
}
