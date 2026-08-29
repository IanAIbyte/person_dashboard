// watchdog 检测核心（纯函数，从 watchdog.mjs 抽出便于测试）。
// 个股与指数统一处理：指数（scope="index"）只做急拉/急跌判定——
// 指数行情的涨跌停字段为空（Number("")=0），照搬个股逻辑会误报 limitUp。

export function detectAlerts({
  quotes,
  bySymbolMeta,
  samples,
  cooldowns,
  config,
  now = Date.now(),
}) {
  const alerts = [];
  if (!(quotes instanceof Map)) return alerts;
  const windowMs = config.windowMinutes * 60_000;
  const cooldownMs = config.cooldownMinutes * 60_000;

  for (const [code, quote] of quotes) {
    if (quote?.price == null) continue;
    const meta = bySymbolMeta?.get(code) ?? {};
    const scope = meta.scope === "index" ? "index" : "stock";
    const thresholdPct = scope === "index"
      ? (config.indexThresholdPct ?? config.thresholdPct)
      : config.thresholdPct;

    // 滚动窗口采样（samples/cooldowns 由调用方持有，跨 tick 存活）。
    const deque = samples.get(code) ?? [];
    deque.push({ ts: now, price: quote.price });
    while (deque.length && now - deque[0].ts > windowMs) deque.shift();
    samples.set(code, deque);

    const base = deque[0]?.price;
    if (base == null || base === quote.price) continue;
    const changePct = ((quote.price - base) / base) * 100;

    let type = null;
    if (scope !== "index") {
      if (quote.limitUp != null && quote.price >= quote.limitUp) type = "limitUp";
      else if (quote.limitDown != null && quote.price <= quote.limitDown) type = "limitDown";
    }
    if (!type) {
      if (changePct >= thresholdPct) type = "surge";
      else if (changePct <= -thresholdPct) type = "plunge";
    }
    if (!type) continue;

    // 冷却：同标的同向。
    const coolKey = `${code}:${type}`;
    const last = cooldowns.get(coolKey);
    if (last && now - last < cooldownMs) continue;
    cooldowns.set(coolKey, now);

    alerts.push({
      ts: new Date(now).toISOString(),
      code,
      name: meta.name ?? quote.name ?? code,
      type,
      changePct: Number(changePct.toFixed(2)),
      price: quote.price,
      windowMinutes: config.windowMinutes,
      ...(scope === "index" ? { scope } : {}),
    });
  }
  return alerts;
}
