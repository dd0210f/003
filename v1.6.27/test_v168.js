/* v1.6.8 测试:venue 感知 legacy 接口——QFEX 行情/下单走适配器,杜绝静默回退到 Variational。
 * 背景:v1.6.7 及之前,切到 qfex 后 getRiskMark/indicativeQuote/placeMarketAuto
 * 悄悄回退到 api.js 的 Variational 全局函数(行情是 variational 的数,LIVE 会下错所)。
 */
"use strict";
const path = require("path");
const S = require(path.join(__dirname, "strategy.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra || ""); }
}

/* mock QFEX 适配器:行为对标 venues/qfex.js 的公开语义 */
function mockQfex() {
  const calls = [];
  return {
    id: "qfex",
    calls,
    async getMarkets() {
      return [{ symbol: "GOLD-USD" }, { symbol: "SILVER-USD" }, { symbol: "CL-USD" }, { symbol: "US100-USD" }];
    },
    async getQuote(symbol) {
      calls.push(["getQuote", symbol]);
      if (symbol === "GOLD-USD") return { bid: 4179.5, ask: 4180.5, mark: 4180.0 };
      if (symbol === "CL-USD") return { bid: 101.4, ask: 101.6, mark: 101.5 };
      const e = new Error("qfex: 未知市场 " + symbol); e.code = "VENUE_UNKNOWN"; throw e;
    },
    async placeOrder(o) {
      calls.push(["placeOrder", o]);
      if (o.type === "MARKET") return { orderId: "mkt-1", status: "filled" };
      return { orderId: "lmt-1", status: "pending" };
    },
    async cancelOrder(orderId) { calls.push(["cancelOrder", orderId]); return true; },
    async getPositions() {
      const e = new Error("qfex: 持仓字段待 UAT 实测确认"); e.code = "VENUE_UNKNOWN"; throw e;
    },
    async checkSession() { return true; },
  };
}

(async () => {
  const ad = mockQfex();
  const api = S.vatBuildVenueLegacyApi(ad, "qfex");

  // 1. getRiskMark 走适配器 quote
  {
    const m = await api.getRiskMark("GOLD-USD", "swap");
    ok("getRiskMark=GOLD-USD mark", m === 4180.0, m);
  }
  // 2. 未知市场抛错(上层 catch→0,不编造)
  {
    let threw = false;
    try { await api.getRiskMark("NOPE-USD", "swap"); } catch (_) { threw = true; }
    ok("未知市场 getRiskMark 抛错", threw);
  }
  // 3. indicativeQuote 形状兼容策略侧读取(response.bid/ask/mark_price)
  {
    const q = await api.indicativeQuote("GOLD-USD-SWAP", "0.1");
    ok("quote 后缀被 strip", ad.calls.some((c) => c[0] === "getQuote" && c[1] === "GOLD-USD"));
    ok("response.bid/ask/mark_price", q.response.bid === 4179.5 && q.response.ask === 4180.5 && q.response.mark_price === 4180.0);
  }
  // 4. prepareOrderQty:市场存在→过;未知市场→抛(对应 vatQuoteVerify 语义)
  // v1.6.9:mock 无 getContract → 无真实精度时数量原样通过(不编造精度)
  {
    const p = await api.prepareOrderQty("GOLD-USD-SWAP", "0.123456789", "buy");
    ok("无精度信息时数量原样", p.qty === "0.123456789", p.qty);
    let threw = false;
    try { await api.prepareOrderQty("NOPE-USD", "1", "buy"); } catch (_) { threw = true; }
    ok("未知市场 prepare 抛错", threw);
  }
  // 5. placeMarketAuto dryRun 不碰适配器
  {
    const n0 = ad.calls.length;
    const r = await api.placeMarketAuto("GOLD-USD-SWAP", "buy", "0.1", { dryRun: true });
    ok("dryRun 不下单", r.dryRun === true && ad.calls.length === n0);
  }
  // 6. placeMarketAuto 实盘走 adapter.placeOrder(MARKET),符号 strip
  {
    const r = await api.placeMarketAuto("GOLD-USD-SWAP", "buy", "0.1", { dryRun: false, reduceOnly: true });
    const c = ad.calls[ad.calls.length - 1];
    ok("placeOrder 被调用", c[0] === "placeOrder");
    ok("MARKET+reduceOnly+符号strip", c[1].type === "MARKET" && c[1].reduceOnly === true && c[1].symbol === "GOLD-USD", JSON.stringify(c[1]));
    ok("返回 rfqId", r.rfqId === "mkt-1");
    const cf = await api.confirmRfq(r.rfqId);
    ok("filled→confirmRfq ok", cf.ok === true);
  }
  // 7. pending 状态→confirmRfq 非 false(策略判 pending)
  {
    const r = await api.placeMarketAuto("CL-USD-SWAP", "sell", "1", { dryRun: false });
    // mock 里 CL 走 MARKET→filled;直接测 pending 分支:
    const api2 = S.vatBuildVenueLegacyApi({
      id: "qfex",
      getQuote: async () => ({ bid: 1, ask: 2, mark: 1.5 }),
      placeOrder: async () => ({ orderId: "p-9", status: "pending" }),
      getMarkets: async () => [],
    }, "qfex");
    const r2 = await api2.placeMarketAuto("X-SWAP", "buy", "1", { dryRun: false });
    const cf2 = await api2.confirmRfq(r2.rfqId);
    ok("pending→confirmRfq ok!==false", cf2.ok !== false && cf2.status === "pending");
  }
  // 8. placeMakerOrder → LIMIT GTC
  {
    const r = await api.placeMakerOrder("GOLD-USD-SWAP", "buy", "0.1", 4179.0, { dryRun: false });
    const c = ad.calls[ad.calls.length - 1];
    ok("maker 走 LIMIT/GTC", c[1].type === "LIMIT" && c[1].tif === "GTC" && c[1].price === 4179.0, JSON.stringify(c[1]));
    ok("返回 orderId", r.orderId === "lmt-1");
  }
  // 9. cancelOrder 透传
  {
    const r = await api.cancelOrder("lmt-1");
    ok("cancelOrder 透传", r === true);
  }
  // 10. getPositions 抛 VENUE_UNKNOWN(不编造),positionQtyFor 形状兼容
  {
    let threw = null;
    try { await api.getPositions(); } catch (e) { threw = e; }
    ok("getPositions 抛 VENUE_UNKNOWN", threw && threw.code === "VENUE_UNKNOWN");
    const rows = [{ symbol: "GOLD-USD", qty: "0.5" }, { symbol: "CL-USD", qty: "2" }];
    ok("positionQtyFor strip 后缀匹配", api.positionQtyFor(rows, "GOLD-USD-SWAP") === 0.5);
    ok("positionQtyFor 无仓位=0", api.positionQtyFor(rows, "XAU-SWAP") === 0);
  }
  // 11. listUnderlyings 返回市场符号(模糊匹配用)
  {
    const names = await api.listUnderlyings();
    ok("listUnderlyings 含 GOLD-USD", names.includes("GOLD-USD"), names.join(","));
  }
  // 12. underlyingAliases 为空对象(不泄露 variational 别名,不猜)
  {
    ok("underlyingAliases 空", api.underlyingAliases && Object.keys(api.underlyingAliases).length === 0);
  }
  // 13. marginNeedFromQuote=0(未知→策略跳过缩量)
  {
    ok("marginNeedFromQuote=0", api.marginNeedFromQuote({}) === 0);
  }

  // 14. vatWireVenueApi:接 qfex 后 vatApi() 不再是 variational 全局
  {
    S.vatWireVenueApi("qfex", ad);
    const vapi = S.vatApi();
    ok("wire 后 venueId=qfex", vapi.venueId === "qfex");
    const m = await vapi.getRiskMark("GOLD-USD", "swap");
    ok("wire 后 getRiskMark 走 mock", m === 4180.0 && ad.calls.some((c) => c[0] === "getQuote" && c[1] === "GOLD-USD"));
    ok("wire 后无 variational 别名", !vapi.underlyingAliases || !vapi.underlyingAliases.XAU);
  }
  // 15. vatWireVenueApi:切回 variational 后恢复(无覆盖)
  {
    S.vatWireVenueApi("variational", null);
    const vapi = S.vatApi();
    ok("切回后 venueId 未设置", vapi.venueId == null);
    // node 下无全局 getRiskMark→null,关键是 shim 已清除
    ok("切回后 getRiskMark 非 shim", typeof vapi.getRiskMark !== "function" || vapi.getRiskMark.name !== "");
  }
  // 16. vatWireVenueApi:ad 为 null→reset,不抛
  {
    let threw = false;
    try { S.vatWireVenueApi("qfex", null); } catch (_) { threw = true; }
    ok("ad null 不抛", !threw);
    S.vatResetApi();
  }

  // 17. vatVenueLiveGuard:v1.6.9 qfex 持仓/余额已落实→LIVE 放行;PAPER 放行;variational 放行
  {
    ok("qfex+LIVE+profit 放行(v1.6.9)", S.vatVenueLiveGuard({ activeVenue: "qfex", mode: "profit", liveEnabled: true }) === null);
    const gOther = S.vatVenueLiveGuard({ activeVenue: "lighter", mode: "profit", liveEnabled: true });
    ok("未确认 venue+LIVE 仍拒绝", typeof gOther === "string", gOther);
    ok("qfex+PAPER 放行", S.vatVenueLiveGuard({ activeVenue: "qfex", mode: "profit", liveEnabled: false }) === null);
    ok("variational+LIVE 放行", S.vatVenueLiveGuard({ activeVenue: "variational", mode: "profit", liveEnabled: true }) === null);
    ok("qfex+LIVE+hedge 放行(独立 tick)", S.vatVenueLiveGuard({ activeVenue: "qfex", mode: "hedge", liveEnabled: true }) === null);
  }

  // 18. 端到端:qfex 下 vatResolveUnderlying 走目录模糊匹配命中 GOLD-USD(非 variational 代号)
  {
    S.vatWireVenueApi("qfex", ad);
    const vapi = S.vatApi();
    const st = { resolved: {}, markets: {}, stats: {}, logs: [] };
    const cfg = { mode: "profit" };
    const ru = await S.vatResolveUnderlying(vapi, st, "XAU", cfg);
    ok("XAU 解析到 GOLD-USD", ru && ru.underlying === "GOLD-USD", JSON.stringify(ru));
    S.vatResetApi();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH", e); process.exit(1); });
