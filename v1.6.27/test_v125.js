"use strict";
/* v1.2.5 回归(用户要求:不限时 + 熔断只报警不拦单):
 * 1. 连续亏损熔断:consecutiveLosses>=maxLosses → 只记一次 warn,不拦单(仍可开仓),mk.status 不再是 loss_circuit
 * 2. 熔断告警只发一次;条件解除后复位,下次触发再报警
 * 3. 日亏损熔断:stats.pnl<=-maxLoss → 只报警不拦单
 * 4. vatRiskGate:熔断返回 null(只报警);达开仓上限仍返回原因
 * 5. vatManualRestartReset:清熔断告警标记
 * 6. background.js:不再有定时器自动停策略(会话限时/探活失败自动停止已删除) */
const S = require("./strategy.js");
const fs = require("fs");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const warnLogs = (st, sub) => (st.logs || []).filter((l) => l.level === "warn" && String(l.msg).includes(sub));

let now = 1_700_000_000_000;
let mockMark = 4115;
function quantizeDown(qtyStr, tickStr) {
  const q = Number(qtyStr), t = Number(tickStr);
  return String(Number((Math.floor(q / t + 1e-9) * t).toFixed(10)));
}
const api = {
  now: () => now,
  sleep: async () => {},
  underlyingAliases: { XAU: ["XAUS"], XAG: ["XAGS"] },
  getRiskMark: async () => mockMark,
  prepareOrderQty: async (symbol, qty) => ({ qty: quantizeDown(String(qty), "0.00001"), note: "", quote: { quoteId: "q" } }),
  indicativeQuote: async (symbol, qty) => ({
    quoteId: "q-1", mark: mockMark,
    response: { bid: String(mockMark - 0.1), ask: String(mockMark + 0.1), mark_price: String(mockMark),
      qty_limits: { ask: { min_qty_tick: "0.00001", min_qty: "0.00003" }, bid: { min_qty_tick: "0.00001", min_qty: "0.00003" } },
      margin_requirements: {} },
  }),
  marginNeedFromQuote: () => 50,
  placeMarketAuto: async (symbol, side, qty, o) => ({ rfqId: "rfq-1", qty }),
  confirmRfq: async () => ({ ok: true, status: "filled" }),
};
function baseCfg(over = {}) {
  return { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], armed: true, liveEnabled: false, ...over };
}
function seedMomentum(st) {
  const T = now;
  S.vatPushHist(st, "XAU", 4100, T - 360e3);
  S.vatPushHist(st, "XAU", 4100, T - 300e3);
  S.vatPushHist(st, "XAU", 4110, T - 120e3);
  S.vatPushHist(st, "XAU", 4112, T - 60e3);
}
function freshFuseState() {
  const st = S.vatBlankState();
  st.date = S.vatDayNY(now);
  seedMomentum(st);
  return st;
}

(async () => {
  // ===== 1. 连续亏损熔断只报警不拦单 =====
  {
    const st = freshFuseState();
    st.stats.consecutiveLosses = 3; // == maxLosses(默认3)
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    ok("连续亏损熔断:不拦单,仍可开仓", !!st.positions.XAU);
    ok("连续亏损熔断:mk.status 不再是 loss_circuit", st.markets.XAU.status !== "loss_circuit");
    ok("连续亏损熔断:记一次 warn 告警", warnLogs(st, "熔断告警").length === 1 && warnLogs(st, "连续亏损 3 次").length === 1);
    // 再跑一次:告警不重复
    delete st.positions.XAU;
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    ok("连续亏损熔断:告警只发一次不刷屏", warnLogs(st, "熔断告警").length === 1);
  }

  // ===== 2. 条件解除后告警复位,下次触发再报警 =====
  {
    const st = freshFuseState();
    st.stats.consecutiveLosses = 3;
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    ok("复位前:告警标记已置", !!st.fuseWarned.loss);
    st.stats.consecutiveLosses = 0; // 模拟盈利,计数清零
    delete st.positions.XAU;
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    ok("计数清零后:告警标记复位", !st.fuseWarned.loss);
    st.stats.consecutiveLosses = 3; // 再次触发
    delete st.positions.XAU;
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    ok("再次触发:重新报警", warnLogs(st, "熔断告警").length === 2);
  }

  // ===== 3. 日亏损熔断只报警不拦单 =====
  {
    const st = freshFuseState();
    st.stats.pnl = -100; // equity 1000 * dailyLossPct 5% = 50 阈值
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    ok("日亏损熔断:不拦单,仍可开仓", !!st.positions.XAU);
    ok("日亏损熔断:mk.status 不再是 daily_loss_limit", st.markets.XAU.status !== "daily_loss_limit");
    ok("日亏损熔断:记一次 warn 告警", warnLogs(st, "今日亏损 -100.00U").length === 1);
  }

  // ===== 4. vatRiskGate(maker):熔断返回 null,只报警 =====
  {
    const st = S.vatBlankState();
    st.stats.consecutiveLosses = 5;
    st.stats.pnl = -200;
    const r = S.vatRiskGate(st, baseCfg());
    ok("vatRiskGate:熔断时返回 null(不拦单)", r === null);
    ok("vatRiskGate:连续亏损告警", warnLogs(st, "连续亏损 5 次").length === 1);
    ok("vatRiskGate:日亏损告警", warnLogs(st, "今日亏损").length === 1);
    st.stats.trades = 30; // == maxTrades
    ok("vatRiskGate:达开仓上限仍返回原因", S.vatRiskGate(st, baseCfg()) === "达开仓上限");
  }

  // ===== 5. vatManualRestartReset 清告警标记 =====
  {
    const st = S.vatBlankState();
    S.vatFuseWarn(st, "XAU", "loss", "测试");
    ok("告警标记已置", !!st.fuseWarned.loss);
    S.vatManualRestartReset(st);
    ok("手动重启:告警标记已清", !st.fuseWarned.loss);
    ok("手动重启:连续亏损计数已清", st.stats.consecutiveLosses === 0);
  }

  // ===== 6. background.js:定时器永不自动停策略 =====
  {
    const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
    ok("background:删除会话限时自动停止", !bg.includes("会话测试已过期") && !bg.includes("LIVE 被自动停止"));
    ok("background:探活失败不再 disarm", !/探活[\s\S]{0,200}armed\s*=\s*false/.test(bg));
    ok("background:tick 内不再有 armed=false", !/probeCount[\s\S]{0,400}armed\s*=\s*false/.test(bg));
    ok("background:探活失败记 err 继续运行", bg.includes("连接探活失败") && bg.includes("策略继续运行")); // v1.2.6:"会话探活失败"→"连接探活失败"(弹窗不再出现"会话")
    ok("background:启动时仍做一次真实活检", /VAT_START[\s\S]{0,800}(checkSession|CheckSession)/.test(bg)); // v1.6.8:venue 感知
  }

  console.log(`\nv1.2.5 回归: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
