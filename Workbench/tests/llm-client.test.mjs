import assert from "node:assert/strict";
import test from "node:test";

import { createLlmClient, LlmClientError } from "../server/llm-client.mjs";

// 重试契约（回归）：仅 429/5xx 与网络错误重试；
// 4xx（如密钥错误）与空结果是确定性失败，重试只会重复计费。
function jsonResponse(status) {
  return {
    ok: false,
    status,
    text: async () => `upstream ${status}`,
  };
}

test("500 重试一次后成功", async () => {
  let calls = 0;
  const client = createLlmClient({
    apiKey: "k",
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(500);
      return {
        ok: true,
        body: (async function* () {
          yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      };
    },
  });
  const content = await client.chatCompletion({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(content, "ok");
  assert.equal(calls, 2);
});

test("401 快速失败，不重试", async () => {
  let calls = 0;
  const client = createLlmClient({
    apiKey: "k",
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(401);
    },
  });
  await assert.rejects(
    () => client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error instanceof LlmClientError && error.code === "LLM_UPSTREAM_ERROR",
  );
  assert.equal(calls, 1);
});

test("空结果不重试", async () => {
  let calls = 0;
  const client = createLlmClient({
    apiKey: "k",
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        body: (async function* () {
          yield new TextEncoder().encode("data: [DONE]\n\n");
        })(),
      };
    },
  });
  await assert.rejects(
    () => client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "LLM_EMPTY_RESULT",
  );
  assert.equal(calls, 1);
});

test("网络错误重试一次后失败", async () => {
  let calls = 0;
  const client = createLlmClient({
    apiKey: "k",
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    },
  });
  await assert.rejects(
    () => client.chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "LLM_REQUEST_FAILED",
  );
  assert.equal(calls, 2);
});
