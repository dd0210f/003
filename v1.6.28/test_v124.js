"use strict";
/* v1.2.4 回归:
 * 1. 启动对账:本地有、链上没有 → 清除本地记录(用户手动平过仓);链上有 → 保留;链上接口失败 → 不动
 * 2. 平仓前按链上数量对账:链上为0 → 不发单直接清除("gone");链上比本地少 → 按链上数量平;
 *    下单硬失败(422)时再对一次账,链上无仓位 → 清除不重试,链上有仓位 → 抛错保留重试
 * 3. vatAutoRecoverDue:只有 stopReason=session 才允许自动恢复;用户停止/紧急停止绝不恢复
 * 4. 24/7 标的退避文案不再写"可能休市" */
const S = require("./strategy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const hasLog = (st, sub) => (st.logs || []).some((l) => String(l.msg).includes(sub));

// ---- mock api ----
function mockApi(serverRows, hooks = {}) {
  const calls = { placeMarketAuto: [], indicativeQuote: 0, getPositions: 0 };
  return {
    calls,
    now: () => 1_700_000_000_000,
    getPositions: async () => { calls.getPositions++; if (hooks.getPositionsThrow) throw new Error("net err"); return serverRows; },
    positionQtyFor: (rows, symbol) => {
      const u = String(symbol).split("-")[0];
      for (const r of rows) {
        if (JSON.stringify(r).includes(u)) return Number(r.qty || 0);
      }
      return 0;
    },
    indicativeQuote: async (symbol, qty) => { calls.indicativeQuote++; return { response: { bid: 4185, ask: 4186 } }; },
    placeMarketAuto: async (symbol, side, qty, o) => {
      calls.placeMarketAuto.push({ symbol, side, qty });
      if (hooks.placeThrow) { const e = new Error(hooks.placeThrow); e.httpStatus = 422; throw e; }
      return { rfqId: "rfq-1", qty };
    },
    confirmRfq: async () => ({ ok: true }),
    marginNeedFromQuote: () => 50,
  };
}
const liveCfg = { liveEnabled: true, mode: "profit", profitSlippage: 0.003 };
const paperCfg = { liveEnabled: false, mode: "profit", profitSlippage: 0.003 };
function pos(qty) { return { symbol: "XAU-SWAP", side: "sell", qty: String(qty), entry: 4186.25, notional: 41 }; }

(async () => {
  // ===== 1. 启动对账 =====
  {
    const st = S.vatBlankState();
    st.positions = { XAU: pos(0.01002), XAG: { symbol: "XAG-SWAP", side: "sell", qty: "0.693", entry: 60.59, notional: 42 } };
    const rc = await S.vatReconcilePositions(mockApi([]), st);
    ok("对账:链上空→两条本地记录全清", rc.ok && rc.cleared.length === 2 && !st.positions.XAU && !st.positions.XAG);
    ok("对账:写 warn 日志", hasLog(st, "对账: 交易所已无此仓位"));
  }
  {
    const st = S.vatBlankState();
    st.positions = { XAU: pos(0.01002), XAG: { symbol: "XAG-SWAP", side: "sell", qty: "0.693", entry: 60.59, notional: 42 } };
    const rc = await S.vatReconcilePositions(mockApi([{ instrument: { underlying: "XAUS" }, qty: "-0.01002" }]), st);
    ok("对账:链上有XAU→保留XAU", rc.ok && st.positions.XAU && !st.positions.XAG);
    ok("对账:只清 XAG", rc.cleared.length === 1 && rc.cleared[0] === "XAG");
  }
  {
    const st = S.vatBlankState();
    st.positions = { XAU: pos(0.01002) };
    const rc = await S.vatReconcilePositions(mockApi([], { getPositionsThrow: true }), st);
    ok("对账:链上接口失败→不动本地记录", rc.ok === false && !!st.positions.XAU);
  }

  // ===== 2. 平仓前对账 =====
  {
    // 链上为 0:不发单,直接清除,返回 "gone"
    const st = S.vatBlankState(); st.positions = { XAU: pos(0.01002) };
    const api = mockApi([]);
    const r = await S.vatClosePosition(api, st, "XAU", st.positions.XAU, liveCfg, "TEST", 4185);
    ok("平仓:链上无仓位→返回gone", r === "gone");
    ok("平仓:链上无仓位→不发市价单", api.calls.placeMarketAuto.length === 0 && api.calls.indicativeQuote === 0);
    ok("平仓:链上无仓位→本地清除", !st.positions.XAU);
    ok("平仓:链上无仓位→写日志", hasLog(st, "平仓跳过:交易所已无此仓位"));
  }
  {
    // 链上比本地少:按链上数量平
    const st = S.vatBlankState(); st.positions = { XAU: pos(0.693) };
    const api = mockApi([{ instrument: { underlying: "XAUS" }, qty: "-0.3" }]);
    const r = await S.vatClosePosition(api, st, "XAU", st.positions.XAU, liveCfg, "TEST", 4185);
    ok("平仓:链上部分仓位→按链上数量下单", r === true && api.calls.placeMarketAuto.length === 1 && api.calls.placeMarketAuto[0].qty === "0.3");
    ok("平仓:链上部分仓位→写日志", hasLog(st, "按链上实际数量平仓 0.3"));
  }
  {
    // 链上数量足够:原逻辑不变
    const st = S.vatBlankState(); st.positions = { XAU: pos(0.01002) };
    const api = mockApi([{ instrument: { underlying: "XAUS" }, qty: "-0.01002" }]);
    const r = await S.vatClosePosition(api, st, "XAU", st.positions.XAU, liveCfg, "TEST", 4185);
    ok("平仓:链上足量→按本地数量下单", r === true && api.calls.placeMarketAuto[0].qty === "0.01002");
  }
  {
    // 下单 422 但链上还有仓位 → 抛错(保留重试)
    const st = S.vatBlankState(); st.positions = { XAU: pos(0.01002) };
    const api = mockApi([{ instrument: { underlying: "XAUS" }, qty: "-0.01002" }], { placeThrow: "Variational 返回错误 HTTP 422" });
    let threw = false;
    try { await S.vatClosePosition(api, st, "XAU", st.positions.XAU, liveCfg, "TEST", 4185); } catch (e) { threw = /422/.test(e.message); }
    ok("平仓:422但链上有仓位→抛错重试", threw && !!st.positions.XAU);
  }
  {
    // 下单 422 且链上已无仓位 → 清除不重试
    const st = S.vatBlankState(); st.positions = { XAU: pos(0.01002) };
    const api = mockApi([], { placeThrow: "Variational 返回错误 HTTP 422" });
    const r = await S.vatClosePosition(api, st, "XAU", st.positions.XAU, liveCfg, "TEST", 4185);
    ok("平仓:422且链上无仓位→清除返回gone", r === "gone" && !st.positions.XAU);
  }
  {
    // PAPER 模式:不查链,走老逻辑
    const st = S.vatBlankState(); st.positions = { XAU: pos(0.01002) };
    const api = mockApi([]);
    const r = await S.vatClosePosition(api, st, "XAU", st.positions.XAU, paperCfg, "TEST", 4185);
    ok("平仓:PAPER不查链", r === true && api.calls.getPositions === 0 && !st.positions.XAU);
  }

  // ===== 3. 自动恢复判定 =====
  {
    const now = Date.now();
    ok("恢复:session原因+无节流→可恢复", S.vatAutoRecoverDue({ armed: false, stopReason: "session" }, now) === true);
    ok("恢复:session原因+节流未到→不可", S.vatAutoRecoverDue({ armed: false, stopReason: "session", nextRecoverAt: now + 60000 }, now) === false);
    ok("恢复:session原因+节流已过→可恢复", S.vatAutoRecoverDue({ armed: false, stopReason: "session", nextRecoverAt: now - 1 }, now) === true);
    ok("恢复:用户手动停止→绝不恢复", S.vatAutoRecoverDue({ armed: false, stopReason: "user" }, now) === false);
    ok("恢复:紧急停止→绝不恢复", S.vatAutoRecoverDue({ armed: false, stopReason: "user", nextRecoverAt: 0 }, now) === false);
    ok("恢复:旧配置无stopReason→不恢复(保守)", S.vatAutoRecoverDue({ armed: false }, now) === false);
    ok("恢复:运行中→不恢复", S.vatAutoRecoverDue({ armed: true, stopReason: "session" }, now) === false);
    ok("恢复:节流常量15分钟", S.VAT_RECOVER_INTERVAL_MS === 900000);
  }

  // ===== 4. 24/7 标的退避文案 =====
  {
    // node 环境无 TRADFI_UNDERLYINGS → 不写"可能休市"
    const api = {
      now: () => Date.now(),
      sleep: async () => {},
      getRiskMark: async () => 80000,
      prepareOrderQty: async () => { const e = new Error("Variational 返回错误 HTTP 400"); e.apiRequest = { path: "/x", body: {} }; throw e; },
      indicativeQuote: async () => { throw new Error("no"); },
      marginNeedFromQuote: () => 50,
    };
    const cfg = { ...S.VAT_DEFAULT_CONFIG, assets: ["BTC"], mode: "volume", armed: true, liveEnabled: false };
    const st = S.vatBlankState();
    S.vatPushHist(st, "BTC", 80000, Date.now() - 300e3);
    S.vatPushHist(st, "BTC", 80000, Date.now() - 60e3);
    for (let i = 0; i < 3; i++) await S.vatProcessAsset(api, st, "BTC", cfg);
    const backoffLog = (st.logs || []).find((l) => String(l.msg).includes("询价连续失败"));
    ok("退避:24/7标的不写可能休市", !!backoffLog && !String(backoffLog.msg).includes("可能休市"));
  }
  {
    // 有 TRADFI_UNDERLYINGS 且命中 → 保留"可能休市"
    global.TRADFI_UNDERLYINGS = new Set(["XAU"]);
    const api = {
      now: () => Date.now(),
      sleep: async () => {},
      getRiskMark: async () => 4186,
      prepareOrderQty: async () => { const e = new Error("Variational 返回错误 HTTP 400"); e.apiRequest = { path: "/x", body: {} }; throw e; },
      indicativeQuote: async () => { throw new Error("no"); },
      marginNeedFromQuote: () => 50,
    };
    const cfg = { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], mode: "volume", armed: true, liveEnabled: false };
    const st = S.vatBlankState();
    S.vatPushHist(st, "XAU", 4186, Date.now() - 300e3);
    S.vatPushHist(st, "XAU", 4186, Date.now() - 60e3);
    for (let i = 0; i < 3; i++) await S.vatProcessAsset(api, st, "XAU", cfg);
    const backoffLog = (st.logs || []).find((l) => String(l.msg).includes("询价连续失败"));
    ok("退避:TradFi标的保留可能休市", !!backoffLog && String(backoffLog.msg).includes("可能休市"));
    delete global.TRADFI_UNDERLYINGS;
  }

  console.log(`\nv1.2.4: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH:", e); process.exit(1); });
