// Server酱推送（微信）。watchdog 进程与 vite-plugin 共用。
// 外呼仅含：标题与正文（股票名/代码/价格/幅度等公开市场数据）。

export async function pushServerChan(sendKey, title, desp) {
  if (!sendKey) return { ok: false, reason: "SENDKEY 未配置" };
  try {
    const body = new URLSearchParams({ title, desp });
    const response = await fetch(`https://sctapi.ftqq.com/${sendKey}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.code === 0) return { ok: true };
    return { ok: false, reason: payload?.message || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: error?.message || "网络失败" };
  }
}
