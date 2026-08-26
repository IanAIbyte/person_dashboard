// 提示词库：检索浏览公开提示词模板（中文 zh + 英文 chat 双源）。
// 一期为只读：搜索/语言筛选/详情展开/复制。AI 辅助检索与优化在二期接入。

import { useEffect, useRef, useState } from "react";
import { IconCopy, IconSearch, IconSparkles } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { searchPrompts } from "../lib/api";
import "./prompts-library.css";

const LANG_OPTIONS = [
  { key: "all", label: "全部" },
  { key: "zh", label: "中文" },
  { key: "en", label: "英文" },
];

export function PromptsLibraryPage() {
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState("all");
  const [result, setResult] = useState({ items: [], total: 0, stats: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openIndex, setOpenIndex] = useState(-1);
  const [copiedIndex, setCopiedIndex] = useState(-1);
  const debounceRef = useRef(0);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        // request() 直接返回 body：{ total, items, stats }。
        const response = await searchPrompts(query.trim(), lang);
        setResult(response?.items ? response : { items: [], total: 0, stats: null });
        setOpenIndex(-1);
      } catch (caught) {
        setError(caught?.message ?? "检索失败");
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [query, lang]);

  const copy = async (index) => {
    const item = result.items[index];
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.prompt);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(-1), 1500);
    } catch { /* 剪贴板被拒时静默 */ }
  };

  const stats = result.stats;

  return (
    <div className="page page--prompts">
      <PageHeader
        eyebrow="PROMPT LIBRARY"
        title="提示词"
        description="检索公开提示词模板，找适合的打底，再结合自己的上下文修改。中文源 124 条 + 英文源 1.2 万条，本地缓存。"
      />

      <div className="prompts-toolbar">
        <label className="prompts-search">
          <IconSearch aria-hidden="true" size={15} stroke={1.7} />
          <input
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索：角色、场景、关键词（如「写作」「代码」「terminal」）"
            value={query}
          />
        </label>
        <div className="prompts-seg" role="group" aria-label="语言筛选">
          {LANG_OPTIONS.map((option) => (
            <button
              aria-pressed={lang === option.key}
              className={`prompts-seg__btn${lang === option.key ? " prompts-seg__btn--on" : ""}`}
              key={option.key}
              onClick={() => setLang(option.key)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="prompts-meta">
        {stats ? (
          <span>
            中文 {stats.zhCount} · 英文 {stats.enCount}
            {stats.stale ? "（缓存，刷新失败）" : ""}
          </span>
        ) : null}
        <span>{loading ? "检索中…" : query.trim() ? `${result.total} 条命中` : `前 ${result.items.length} 条`}</span>
      </div>

      {error ? <div className="prompts-error">{error}</div> : null}

      <ul className="prompts-list">
        {result.items.map((item, index) => (
          <li className={`prompts-item${openIndex === index ? " prompts-item--open" : ""}`} key={`${item.source}-${item.act}`}>
            <button
              className="prompts-item__head"
              onClick={() => setOpenIndex(openIndex === index ? -1 : index)}
              type="button"
            >
              <span className="prompts-item__title">{item.act}</span>
              <span className={`prompts-item__lang${item.lang === "zh" ? " prompts-item__lang--zh" : ""}`}>
                {item.lang === "zh" ? "中文" : "EN"}
              </span>
            </button>
            <p className="prompts-item__preview">{item.prompt}</p>
            {openIndex === index ? (
              <div className="prompts-item__body">
                <pre>{item.prompt}</pre>
                <button
                  className="prompts-item__copy"
                  onClick={() => copy(index)}
                  type="button"
                >
                  <IconCopy aria-hidden="true" size={13} stroke={1.7} />
                  {copiedIndex === index ? "已复制" : "复制全文"}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {!loading && result.items.length === 0 && !error ? (
        <div className="prompts-empty">
          <IconSparkles aria-hidden="true" size={20} stroke={1.6} />
          <p>没有匹配的模板。换个关键词，或切到「全部」语言试试。</p>
        </div>
      ) : null}
    </div>
  );
}
