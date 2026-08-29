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

// 聚合 OpenAI 兼容 SSE 流：data: {choices[0].delta.content} … data: [DONE]。
export async function readStreamContent(response) {
  const parts = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    // chunk 是 Uint8Array，.toString() 会变成逗号数字串，必须走 TextDecoder。
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") parts.push(delta);
      } catch {
        // 半行/心跳行忽略，等下一片补全。
      }
    }
  }
  return parts.join("");
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
          // 长文生成必须流式：非流式连接静默数分钟会被网络层掐断（fetch failed）。
          body: JSON.stringify({ model, messages, stream: true }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const status = response.status;
          const text = await response.text().catch(() => "");
          const error = new LlmClientError(
            "LLM_UPSTREAM_ERROR",
            `LLM 接口返回 ${status}`,
            { status, body: text.slice(0, 400) },
          );
          // 仅 429/5xx 可重试；4xx（密钥/参数错误）是确定性失败，重试只会重复计费。
          if (attempt < maxRetries && (status === 429 || status >= 500)) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const content = await readStreamContent(response);
        if (typeof content !== "string" || !content.trim()) {
          throw new LlmClientError("LLM_EMPTY_RESULT", "LLM 未返回有效内容。");
        }
        return content.trim();
      } catch (error) {
        if (error instanceof LlmClientError) {
          throw error;
        }
        // 网络错误 / 超时可重试。
        if (attempt < maxRetries) {
          lastError = new LlmClientError("LLM_REQUEST_FAILED", error?.message || "LLM 请求失败。");
          continue;
        }
        throw new LlmClientError("LLM_REQUEST_FAILED", error?.message || "LLM 请求失败。");
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
