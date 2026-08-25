// 智谱（Zhipu）LLM 客户端 —— OpenAI 兼容 chat/completions 的 fetch 封装。
// 项目此前只有本地 Codex CLI 调用，无外部 LLM API；本模块是首个外部 LLM 客户端。
// 采用可注入 fetch + 超时 + 重试，对齐 shared/ai-hot.mjs 的封装范式。

export const ZHIPU_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZHIPU_DEFAULT_MODEL = "glm-5.2";

export class LlmClientError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "LlmClientError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new LlmClientError(code, message, details);
}

// 去掉模型可能返回的 ```json 围栏，取纯 JSON 文本。
export function stripJsonFence(value) {
  const text = String(value ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : text).trim();
}

export function createLlmClient({
  baseUrl = process.env.ZHIPU_BASE_URL?.trim() || ZHIPU_DEFAULT_BASE_URL,
  apiKey = process.env.ZHIPU_API_KEY,
  model = process.env.WORKBENCH_AI_MODEL?.trim() || ZHIPU_DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 180_000,
  maxRetries = 1,
} = {}) {
  async function chatCompletion({ messages, signal, timeoutMs: callTimeoutMs } = {}) {
    if (!apiKey) {
      fail("LLM_NOT_CONFIGURED", "未配置 ZHIPU_API_KEY，无法调用 AI 分析。");
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      fail("INVALID_LLM_MESSAGES", "LLM 请求缺少消息。");
    }
    // 单次调用可覆盖超时（长文生成如四段式复盘需要更长时间）。
    const effectiveTimeoutMs = Number.isFinite(Number(callTimeoutMs)) && callTimeoutMs > 0
      ? callTimeoutMs
      : timeoutMs;

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      const abortHandler = () => controller.abort();
      signal?.addEventListener?.("abort", abortHandler, { once: true });
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const status = response.status;
          const text = await response.text().catch(() => "");
          lastError = fail(
            "LLM_UPSTREAM_ERROR",
            `LLM 接口返回 ${status}`,
            { status, body: text.slice(0, 400) },
          );
          // 429/5xx 可重试
          if (attempt < maxRetries && (status === 429 || status >= 500)) continue;
          throw lastError;
        }
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw fail("LLM_EMPTY_RESULT", "LLM 未返回有效内容。");
        }
        return content.trim();
      } catch (error) {
        if (error instanceof LlmClientError) {
          lastError = error;
          if (attempt < maxRetries) continue;
          throw error;
        }
        // 网络错误 / 超时
        lastError = fail("LLM_REQUEST_FAILED", error?.message || "LLM 请求失败。");
        if (attempt < maxRetries) continue;
        throw lastError;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", abortHandler);
      }
    }
    throw lastError;
  }

  // 便捷方法：要求返回 JSON，自动去围栏并解析；解析失败抛 LLM_INVALID_JSON。
  async function chatJson({ messages, signal } = {}) {
    const content = await chatCompletion({ messages, signal });
    try {
      return JSON.parse(stripJsonFence(content));
    } catch {
      fail("LLM_INVALID_JSON", "LLM 返回的内容不是有效 JSON。");
    }
  }

  return Object.freeze({ chatCompletion, chatJson, get model() { return model; } });
}
