"use strict";
/* v1.2.1 回归:熔断手动重启 + US100 询价探测/tick 缓存 */
const S = require("./strategy.js");
const api = require("./api.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

// ---- mock fetch:模拟 US100 询价端点按精度 400 ----
let capturedQuoteQty = null;
global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const mkResp = (status, data) => ({
    status, ok: status >= 200 && status < 300,
    json: async () => data,
  });
  if (url.includes("/metadata/supported_assets")) return mkResp(200, []);
  if (url.includes("/quotes/simple")) return mkResp(200, { mark_price: "30299" });
  if (url.includes("/quotes/indicative")) {
    capturedQuoteQty = body.qty;
    const decimals = (String(body.qty).split(".")[1] || "").length;
    if (decimals > 3) return mkResp(400, {}); // 空响应,和真实 US100 一样
    return mkResp(200, {
      quote_id: "q-probe",
      mark_price: "30299",
      qty_limits: {
        ask: { min_qty_tick: "0.001", min_qty: "0.001" },
        bid: { min_qty_tick: "0.001", min_qty: "0.001" },
      },
    });
  }
  return mkResp(404, {});
};

(async () => {
  const cfg = { ...S.VAT_DEFAULT_CONFIG };

  // 1. 熔断只报警不拦单(v1.2.5)
  const st1 = S.vatBlankState();
  st1.stats.consecutiveLosses = 4;
  ok("连亏4风控闸放行(只报警)", S.vatRiskGate(st1, cfg) === null);
  ok("连亏4记熔断告警", (st1.logs || []).some((l) => l.level === "warn" && String(l.msg).includes("熔断告警")));

  // 2. 手动重启重置
  S.vatManualRestartReset(st1);
  ok("重启清零连续亏损", st1.stats.consecutiveLosses === 0);
  ok("重启设置 dailyLossOverride", st1.dailyLossOverride === true);
  ok("重启后风控闸通过", S.vatRiskGate(st1, cfg) === null);
  ok("重启写日志", (st1.logs || []).some((l) => String(l.msg).includes("连续亏损计数已清零")));

  // 3. 日亏损熔断:只报警不拦单(v1.2.5)
  const st2 = S.vatBlankState();
  st2.stats.pnl = -100; // equity 1000 * 5% = 50, -100 超了
  ok("日亏损放行(只报警)", S.vatRiskGate(st2, cfg) === null);
  ok("日亏损记熔断告警", (st2.logs || []).some((l) => l.level === "warn" && String(l.msg).includes("熔断告警")));
  st2.dailyLossOverride = true;
  ok("日亏损有override放行", S.vatRiskGate(st2, cfg) === null);

  // 4. 跨天重置:vatBlankState 不带 override(天然清除)
  const st3 = S.vatBlankState();
  ok("跨天新 state 无 override", !st3.dailyLossOverride);

  // 5. 询价探测:US100 raw 精度 400,3位小数通过,并记住 tick
  const probe = await api.probeQuote("US100-SWAP");
  const oks = probe.results.filter((r) => r.ok);
  const fails = probe.results.filter((r) => !r.ok);
  ok("探测有成功也有失败", oks.length >= 1 && fails.length >= 1);
  ok("失败的是 400", fails.every((r) => r.httpStatus === 400));
  ok("探测记住 tick=0.001", (await api.tickCacheGet("US100")) === "0.001");

  // 6. 下次询价自动预取整:0.00138618 → 0.001
  capturedQuoteQty = null;
  const prep = await api.prepareOrderQty("US100-SWAP", "0.00138618", "buy");
  ok("预取整后询价 qty=0.001", capturedQuoteQty === "0.001");
  ok("预取整返回 qty=0.001", prep.qty === "0.001");
  ok("note 说明预取整", prep.note.includes("预取整"));

  console.log(`v1.2.1: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("EX:", e); process.exit(1); });
