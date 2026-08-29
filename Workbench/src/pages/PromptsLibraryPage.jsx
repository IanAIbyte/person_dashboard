// 提示词库：检索浏览公开提示词模板（中文 zh + 英文 chat 双源）。
// 一期为只读：搜索/语言筛选/详情展开/复制。AI 辅助检索与优化在二期接入。

import { useEffect, useRef, useState } from "react";
import { IconCopy, IconSearch, IconSparkles, IconWand } from "@tabler/icons-react";
import { PageHeader } from "../components/PageHeader";
import { PromptCollectionPanel } from "../components/prompts/PromptCollectionPanel";
import { optimizePrompt, saveCoachPrompt, searchPrompts, suggestPromptKeywords } from "../lib/api";
import "./prompts-library.css";

const LANG_OPTIONS = [
  { key: "all", label: "全部" },
  { key: "zh", label: "中文" },
  { key: "en", label: "英文" },
];

// 排版规范：模板原文中的长破折号展示与复制时统一降级为普通连字符（语义不变）。
const noDash = (text) => (typeof text === "string" ? text.replace(/[—–]/g, "-") : text);

export function PromptsLibraryPage() {
  const [tab, setTab] = useState("mine"); // mine=我的收藏（默认） | public=公开模板
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState("all");
  const [result, setResult] = useState({ items: [], total: 0, stats: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openIndex, setOpenIndex] = useState(-1);
  const [copiedIndex, setCopiedIndex] = useState(-1);
  const [suggesting, setSuggesting] = useState(false);
  const [optimizer, setOptimizer] = useState(null); // { item, idea, context, result, busy, error, applied }
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
      await navigator.clipboard.writeText(noDash(item.prompt));
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(-1), 1500);
    } catch { /* 剪贴板被拒时静默 */ }
  };

  const aiSuggest = async () => {
    if (!query.trim() || suggesting) return;
    setSuggesting(true);
    try {
      const keywords = await suggestPromptKeywords(query.trim());
      if (typeof keywords === "string" && keywords.trim()) setQuery(keywords.trim());
    } catch { /* 失败保留原词 */ }
    finally { setSuggesting(false); }
  };

  const openOptimizer = (item) => {
    setOptimizer({ item, idea: "", context: "", result: "", busy: false, error: null, applied: false });
  };

  const runOptimize = async () => {
    if (!optimizer?.idea.trim() || optimizer.busy) return;
    setOptimizer((state) => ({ ...state, busy: true, error: null }));
    try {
      const response = await optimizePrompt({
        idea: optimizer.idea.trim(),
        template: optimizer.item.prompt,
        context: optimizer.context.trim(),
      });
      setOptimizer((state) => ({ ...state, result: response?.prompt ?? "", busy: false }));
    } catch (caught) {
      setOptimizer((state) => ({ ...state, busy: false, error: caught?.message ?? "生成失败" }));
    }
  };

  const applyToCoach = async () => {
    if (!optimizer?.result?.trim()) return;
    try {
      await saveCoachPrompt(optimizer.result);
      setOptimizer((state) => ({ ...state, applied: true }));
    } catch (caught) {
      setOptimizer((state) => ({ ...state, error: caught?.message ?? "保存失败" }));
    }
  };

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(noDash(text)); } catch { /* 剪贴板被拒时静默 */ }
  };

  const stats = result.stats;

  return (
    <div className="page page--prompts">
      <PageHeader
        eyebrow="PROMPT LIBRARY"
        title="提示词"
        description="「我的收藏」沉淀自己的提示词，与 Obsidian 知识库（10_raw/prompts/）双向同步；「公开模板」检索中文与英文模板库，找适合的打底再改。"
      />

      <div className="prompts-tabs" role="tablist" aria-label="提示词库分区">
        <button
          aria-selected={tab === "mine"}
          className={`prompts-tabs__btn${tab === "mine" ? " prompts-tabs__btn--on" : ""}`}
          onClick={() => setTab("mine")}
          role="tab"
          type="button"
        >
          我的收藏
        </button>
        <button
          aria-selected={tab === "public"}
          className={`prompts-tabs__btn${tab === "public" ? " prompts-tabs__btn--on" : ""}`}
          onClick={() => setTab("public")}
          role="tab"
          type="button"
        >
          公开模板
        </button>
      </div>

      {tab === "mine" ? <PromptCollectionPanel /> : (
        <>
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
        <button
          className="prompts-suggest"
          disabled={!query.trim() || suggesting}
          onClick={aiSuggest}
          title="把中文想法转成英文关键词，检索英文库"
          type="button"
        >
          <IconWand aria-hidden="true" size={14} stroke={1.7} />
          {suggesting ? "转译中…" : "AI 找"}
        </button>
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
            <p className="prompts-item__preview">{noDash(item.prompt)}</p>
            {openIndex === index ? (
              <div className="prompts-item__body">
                <pre>{noDash(item.prompt)}</pre>
                <div className="prompts-item__ops">
                  <button
                    className="prompts-item__copy"
                    onClick={() => copy(index)}
                    type="button"
                  >
                    <IconCopy aria-hidden="true" size={13} stroke={1.7} />
                    {copiedIndex === index ? "已复制" : "复制全文"}
                  </button>
                  <button
                    className="prompts-item__optimize"
                    onClick={() => openOptimizer(item)}
                    type="button"
                  >
                    <IconSparkles aria-hidden="true" size={13} stroke={1.7} />
                    AI 优化
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      )}

      {!loading && result.items.length === 0 && !error ? (
        <div className="prompts-empty">
          <IconSparkles aria-hidden="true" size={20} stroke={1.6} />
          <p>没有匹配的模板。换个关键词，或切到「全部」语言试试。</p>
        </div>
      ) : null}

      {optimizer ? (
        <div className="prompts-optimizer" role="dialog" aria-label="AI 优化提示词">
          <header className="prompts-optimizer__head">
            <strong>AI 优化 · {optimizer.item.act}</strong>
            <button onClick={() => setOptimizer(null)} type="button">关闭</button>
          </header>
          <label className="prompts-optimizer__field">
            <span>我的想法（必填）</span>
            <textarea
              onChange={(event) => setOptimizer((state) => ({ ...state, idea: event.target.value }))}
              placeholder="想用这个模板做什么？例如：帮我复盘每日交易，指出情绪化操作"
              rows={3}
              value={optimizer.idea}
            />
          </label>
          <label className="prompts-optimizer__field">
            <span>我的上下文（可选）</span>
            <textarea
              onChange={(event) => setOptimizer((state) => ({ ...state, context: event.target.value }))}
              placeholder="补充你的具体情况、数据、约束，AI 会融进提示词"
              rows={3}
              value={optimizer.context}
            />
          </label>
          <button
            className="prompts-optimizer__run"
            disabled={!optimizer.idea.trim() || optimizer.busy}
            onClick={runOptimize}
            type="button"
          >
            <IconSparkles aria-hidden="true" size={13} stroke={1.7} />
            {optimizer.busy ? "生成中…（最长 2 分钟）" : "生成定制提示词"}
          </button>
          {optimizer.error ? <p className="prompts-optimizer__error">{optimizer.error}</p> : null}
          {optimizer.result ? (
            <>
              <textarea
                className="prompts-optimizer__result"
                onChange={(event) => setOptimizer((state) => ({ ...state, result: event.target.value }))}
                rows={10}
                value={optimizer.result}
              />
              <div className="prompts-optimizer__ops">
                <button onClick={() => copyText(optimizer.result)} type="button">复制</button>
                <button
                  className="prompts-optimizer__apply"
                  onClick={applyToCoach}
                  type="button"
                >
                  {optimizer.applied ? "✓ 已设为复盘教练提示词" : "设为复盘教练提示词"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
        </>
      )}
    </div>
  );
}
