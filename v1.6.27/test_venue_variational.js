"use strict";
/* v1.3.0 Phase B 回归:Variational 适配器(venues/variational.js) + strategy.js 三级回退。
 * 1. getLegacyApi 键与 vatApi() 对齐(14 个),mock 注入下值全非空
 * 2. strategy.js:显式注入(VAT_A) > 适配器 getLegacyApi() > 全局(globalThis)
 * 3. placeOrder market 走 placeMarketAuto(dryRun:false)+confirmRfq,filled/pending 映射
 * 4. placeOrder 被拒 → VenueError(VENUE_REJECTED,带服务端原话)
 * 5. getPositions:qty 正负→long/short;entryPrice 缺失不编造;真实存在时才填
 * 6. getBalance 恒返回 null(铁律:绝不编造)
 * 7. cancelOrder → boolean; closeAllPositions 反向 reduceOnly → {closed}
 * 8. createVenueAdapter('variational') 经 index.js 工厂可用
 * 纯 node + assert 风格,无网络,全 mock。 */
const { VenueError } = require("./venues/adapter.js");
const { VariationalAdapter } = require("./venues/variational.js");
const { createVenueAdapter } = require("./venues/index.js");
const S = require("./strategy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

const LEGACY_KEYS = ["getRiskMark", "indicativeQuote", "prepareOrderQty", "placeMarketAuto",
  "confirmRfq", "marginNeedFromQuote", "placeMakerOrder", "cancelOrder",
  "getPositions", "positionQtyFor", "sleep", "now",
  "underlyingAliases", "listUnderlyings"];

function baseApi(over) {
  return {
    getRiskMark: async () => 4115,
    indicativeQuote: async (symbol, qty) => ({
      quoteId: "q-1", mark: 4115,
      response: { bid: "4114.9", ask: "4115.1", mark_price: "4115.0" },
    }),
    prepareOrderQty: async (symbol, qty) => ({ qty: String(qty), note: "", quote: { quoteId: "q" } }),
    placeMarketAuto: async (symbol, side, qty, o) => ({ rfqId: "rfq-9", qty }),
    confirmRfq: async () => ({ ok: true, status: "cleared" }),
    marginNeedFromQuote: () => 50,
    placeMakerOrder: async () => ({ orderId: "m-1" }),
    placeLimit: async () => ({ orderId: "l-1", note: "" }),
    cancelOrder: async () => true,
    getPositions: async () => [],
    positionQtyFor: () => 0,
    checkSession: async () => true,
    markets: async () => ({ XAUS: ["swap"], BTC: ["perpetual_future"] }),
    getFunding: async (symbol) => (/BTC/.test(symbol) ? 0.001 : null),
    sleep: async () => {},
    now: () => 1700000000000,
    underlyingAliases: { XAU: ["XAUS", "XAU"], XAG: ["XAGS", "XAG"], BTC: ["BTC"] },
    listUnderlyings: async () => ["XAUS", "BTC"],
    ...(over || {}),
  };
}

(async () => {
  // ===== 1. getLegacyApi 键齐全 =====
  {
    const a = new VariationalAdapter("variational", { creds: {}, storage: null, api: baseApi() });
    const leg = a.getLegacyApi();
    ok("getLegacyApi 含 14 个键", LEGACY_KEYS.every((k) => k in leg));
    ok("getLegacyApi mock 下全非空", LEGACY_KEYS.every((k) => leg[k] !== null && leg[k] !== undefined));
    ok("venueId", a.id === "variational");
  }

  // ===== 2. strategy.js 三级回退 =====
  {
    const marker = async () => 123;
    const a = new VariationalAdapter("variational", { creds: {}, api: baseApi({ getRiskMark: marker }) });
    S.vatSetApi({});                       // VAT_A 为空(新进程)
    S.vatSetVenueAdapter(a);
    const api1 = S.vatApi();
    ok("适配器回退:vatApi 取到 adapter 的 getRiskMark", api1.getRiskMark === marker);
    ok("vatActiveAdapter 返回适配器", S.vatActiveAdapter() === a);
    S.vatSetApi({ getRiskMark: async () => 999 }); // 显式注入应赢
    const api2 = S.vatApi();
    ok("显式注入 VAT_A 优先于适配器", (await api2.getRiskMark()) === 999);
    S.vatSetVenueAdapter(null);
    ok("vatActiveAdapter 清空", S.vatActiveAdapter() === null);
    S.vatSetApi({}); // 不清历史键:重新建进程级隔离不做,这里只回归三级存在
  }

  // ===== 3. placeOrder market =====
  {
    const calls = [];
    const api = baseApi({
      placeMarketAuto: async (symbol, side, qty, o) => {
        calls.push({ symbol, side, qty, o }); return { rfqId: "rfq-9", qty };
      },
      confirmRfq: async (rfq) => ({ ok: true, status: "cleared" }),
    });
    const a = new VariationalAdapter("variational", { creds: {}, api });
    const r = await a.placeOrder({ symbol: "XAU", side: "buy", qty: "0.01", type: "market" });
    ok("market 返回 orderId=rfqId", r.orderId === "rfq-9");
    ok("confirm ok→filled", r.status === "filled");
    ok("placeMarketAuto 走实盘(dryRun:false)", calls[0].o.dryRun === false);
    ok("side 透传", calls[0].side === "buy" && calls[0].symbol === "XAU");
  }
  // confirm pending → pending
  {
    const a = new VariationalAdapter("variational", { creds: {},
      api: baseApi({ confirmRfq: async () => ({ ok: null, status: "pending" }) }) });
    const r = await a.placeOrder({ symbol: "XAU", side: "sell", qty: "0.01", type: "market" });
    ok("confirm pending→pending", r.status === "pending");
  }
  // confirm rejected → VENUE_REJECTED
  {
    const a = new VariationalAdapter("variational", { creds: {},
      api: baseApi({ confirmRfq: async () => ({ ok: false, status: "rejected" }) }) });
    let e = null;
    try { await a.placeOrder({ symbol: "XAU", side: "buy", qty: "0.01", type: "market" }); }
    catch (err) { e = err; }
    ok("confirm rejected 抛 VenueError", e instanceof VenueError);
    ok("confirm rejected code=VENUE_REJECTED", e && e.code === "VENUE_REJECTED");
  }
  // placeMarketAuto 被拒 → VENUE_REJECTED 带服务端原话
  {
    const a = new VariationalAdapter("variational", { creds: {},
      api: baseApi({ placeMarketAuto: async () => {
        const e = new Error("市价单被拒: {\"detail\":[\"qty 精度不对\"]}");
        e.httpStatus = 422; throw e;
      } }) });
    let e = null;
    try { await a.placeOrder({ symbol: "XAU", side: "buy", qty: "0.01", type: "market" }); }
    catch (err) { e = err; }
    ok("下单被拒抛 VenueError", e instanceof VenueError);
    ok("被拒 code=VENUE_REJECTED", e && e.code === "VENUE_REJECTED");
    ok("带服务端原话", e && /qty 精度不对/.test(e.message));
  }
  // limit
  {
    const a = new VariationalAdapter("variational", { creds: {}, api: baseApi() });
    const r = await a.placeOrder({ symbol: "BTC", side: "buy", qty: "0.001", type: "limit", price: "90000" });
    ok("limit 返回 orderId", r.orderId === "l-1");
    ok("limit status=pending", r.status === "pending");
  }
  // 参数不全
  {
    const a = new VariationalAdapter("variational", { creds: {}, api: baseApi() });
    let e = null;
    try { await a.placeOrder({ symbol: "XAU", side: "buy", qty: 0, type: "market" }); }
    catch (err) { e = err; }
    ok("qty<=0 抛 VenueError", e instanceof VenueError);
  }

  // ===== 4. getQuote / getMarkets / getFunding =====
  {
    const a = new VariationalAdapter("variational", { creds: {}, api: baseApi() });
    const q = await a.getQuote("XAU");
    ok("getQuote bid/ask/mark", q.bid === 4114.9 && q.ask === 4115.1 && q.mark === 4115.0);
    const ms = await a.getMarkets();
    ok("getMarkets 形状", ms.length === 2 && ms[0].symbol === "XAUS" && ms[0].quote === "USDC");
    const f1 = await a.getFunding("BTC");
    ok("getFunding perp 有值", f1 && f1.rate === 0.001);
    const f2 = await a.getFunding("XAU-SWAP");
    ok("getFunding swap→null", f2 === null);
  }

  // ===== 5. getPositions 映射 =====
  {
    const rows = [
      { position_info: { qty: "0.5", underlying: "XAUS", entry_price: "4100.5" },
        instrument: { underlying: "XAUS" }, unrealized_pnl: "7.25" },
      { position_info: { qty: "-0.02", underlying: "BTC" }, instrument: { underlying: "BTC" } },
      { position_info: { qty: "0", underlying: "ETH" }, instrument: { underlying: "ETH" } },
      null, "junk",
    ];
    const a = new VariationalAdapter("variational", { creds: {},
      api: baseApi({ getPositions: async () => rows }) });
    const ps = await a.getPositions();
    ok("零仓位/脏行被过滤", ps.length === 2);
    ok("qty>0→long", ps[0].side === "long" && ps[0].qty === 0.5);
    ok("别名 XAUS→canonical XAU", ps[0].symbol === "XAU");
    ok("entryPrice 真实存在才填", ps[0].entryPrice === 4100.5);
    ok("upnl 真实存在才填", ps[0].upnl === 7.25);
    ok("qty<0→short", ps[1].side === "short" && ps[1].qty === -0.02);
    ok("entryPrice 缺失不编造(键不存在)", !("entryPrice" in ps[1]) && !("upnl" in ps[1]));
    ok("venue 字段", ps[0].venue === "variational");
  }

  // ===== 6. getBalance 恒 null =====
  {
    const a = new VariationalAdapter("variational", { creds: {}, api: baseApi() });
    ok("getBalance 返回 null", (await a.getBalance()) === null);
  }

  // ===== 7. cancelOrder / closeAllPositions / checkSession / disconnect =====
  {
    const a = new VariationalAdapter("variational", { creds: {}, api: baseApi() });
    ok("cancelOrder→true", (await a.cancelOrder("rfq-1")) === true);
    ok("checkSession→true", (await a.checkSession()) === true);
    await a.disconnect(); ok("disconnect 无操作", true);
    const bad = new VariationalAdapter("variational", { creds: {},
      api: baseApi({ cancelOrder: async () => { throw new Error("boom"); } }) });
    let e = null;
    try { await bad.cancelOrder("x"); } catch (err) { e = err; }
    ok("cancelOrder 异常包成 VenueError", e instanceof VenueError);
  }
  {
    const rows = [
      { position_info: { qty: "0.5", underlying: "XAUS" }, instrument: { underlying: "XAUS" } },
      { position_info: { qty: "-0.02", underlying: "BTC" }, instrument: { underlying: "BTC" } },
    ];
    const calls = [];
    const a = new VariationalAdapter("variational", { creds: {},
      api: baseApi({
        getPositions: async () => rows,
        placeMarketAuto: async (symbol, side, qty, o) => { calls.push({ symbol, side, qty, o }); return { rfqId: "c" }; },
      }) });
    const r = await a.closeAllPositions();
    ok("closeAllPositions closed=2", r.closed === 2);
    ok("long 反向 sell reduceOnly", calls[0].side === "sell" && calls[0].o.reduceOnly === true && calls[0].o.dryRun === false);
    ok("short 反向 buy", calls[1].side === "buy" && calls[1].qty === 0.02);
  }

  // ===== 8. 工厂可用 =====
  {
    const a = createVenueAdapter("variational", { creds: {}, storage: null, api: baseApi() });
    ok("createVenueAdapter 返回 VariationalAdapter", a instanceof VariationalAdapter);
    ok("工厂 legacy 包可用", typeof a.getLegacyApi === "function" && a.getLegacyApi().placeMarketAuto !== null);
  }

  console.log(`\nvenue-variational 回归: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("EX:", e && e.stack || e); process.exit(1); });
