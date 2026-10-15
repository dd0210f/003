/* v1.6.9 测试:QFEX REST 持仓/余额真实字段映射 + refdata 精度。
 * 字段依据(非编造):
 * - https://api.qfex.com/refdata 公开端点实测(2026-10-09):{type:"refdata",data:[{symbol,
 *   tick_size,lot_size,min_quantity,base_asset,quote_asset,default_max_leverage,...}]}
 * - 第三方实现 FueledByChai/FueledByChaiTrading(commons/qfex-common-api +
 *   implementations/broker-api/qfex-broker-api-impl):
 *   GET {api.qfex.com|api.qfex.io}/user/positions → {balance:{...}, positions:[...]};
 *   positions[]: symbol / position(带符号数量) / average_price;
 *   balance: available_balance, 权益=deposit+realised_pnl+unrealised_pnl+net_funding;
 *   私有头 x-qfex-public-key/x-qfex-hmac-signature/x-qfex-nonce/x-qfex-timestamp,
 *   签名 hex(HMAC_SHA256(secret, nonce+":"+unixSeconds))。
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const { QfexAdapter } = require(path.join(__dirname, "venues/qfex.js"));
const S = require(path.join(__dirname, "strategy.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra === undefined ? "" : extra); }
}

/* ---- fetch stub ---- */
const realFetch = globalThis.fetch;
let lastReq = null;
let nextResp = null;
function stubFetch(fn) {
  globalThis.fetch = async (url, init) => {
    lastReq = { url: String(url), headers: (init && init.headers) || {} };
    return fn(url, init);
  };
}
function jsonResp(obj, status) {
  return { ok: (status || 200) >= 200 && (status || 200) < 300, status: status || 200, json: async () => obj };
}
function restoreFetch() { globalThis.fetch = realFetch; }

class DummyWS { constructor() { this.readyState = 3; } close() {} }
function newAdapter(creds) {
  return new QfexAdapter({ creds: creds || { apiKey: "qfex_pub_test", apiSecret: "sec_test" }, transport: { WebSocket: DummyWS } });
}

(async () => {
  // 1. getPositions 真实映射
  {
    stubFetch(async () => jsonResp({
      balance: { available_balance: "9500.5", deposit: "10000", realised_pnl: "12.5", unrealised_pnl: "-3.2", net_funding: "0.1" },
      positions: [
        { symbol: "GOLD-USD", position: "0.5", average_price: "4180.2" },
        { symbol: "CL-USD", position: "-2", average_price: "101.5" },
        { symbol: "X-USD", position: "0", average_price: "1" },
      ],
    }));
    const ad = newAdapter();
    const ps = await ad.getPositions();
    ok("持仓条数(0仓位跳过)", ps.length === 2, JSON.stringify(ps));
    const g = ps.find((p) => p.symbol === "GOLD-USD");
    ok("GOLD long 0.5@4180.2", g && g.side === "long" && g.qty === 0.5 && g.entryPrice === 4180.2 && g.venue === "qfex", JSON.stringify(g));
    const c = ps.find((p) => p.symbol === "CL-USD");
    ok("CL short 2", c && c.side === "short" && c.qty === 2, JSON.stringify(c));
    ok("REST URL 正确", lastReq.url === "https://api.qfex.com/user/positions", lastReq.url);
    ok("认证头齐全", !!lastReq.headers["x-qfex-public-key"] && !!lastReq.headers["x-qfex-hmac-signature"] &&
      !!lastReq.headers["x-qfex-nonce"] && !!lastReq.headers["x-qfex-timestamp"]);
    // 签名可复算: hex(HMAC_SHA256(secret, nonce+":"+ts))
    const expect = crypto.createHmac("sha256", "sec_test")
      .update(lastReq.headers["x-qfex-nonce"] + ":" + lastReq.headers["x-qfex-timestamp"], "utf8").digest("hex");
    ok("签名算法正确", lastReq.headers["x-qfex-hmac-signature"] === expect);
  }
  // 2. getBalance:权益=sum
  {
    stubFetch(async () => jsonResp({
      balance: { available_balance: "9500.5", deposit: "10000", realised_pnl: "12.5", unrealised_pnl: "-3.2", net_funding: "0.1" },
      positions: [],
    }));
    const b = await newAdapter().getBalance();
    ok("权益=deposit+已实现+未实现+资金费", Math.abs(b.equity - 10009.4) < 1e-9, b.equity);
    ok("可用余额", b.available === 9500.5, b.available);
  }
  // 3. getBalance:服务端直接给 equity 则优先
  {
    stubFetch(async () => jsonResp({ balance: { equity: "10010.25", available_balance: "9500" }, positions: [] }));
    const b = await newAdapter().getBalance();
    ok("直接 equity 优先", b.equity === 10010.25, b.equity);
  }
  // 4. 401 → VENUE_AUTH
  {
    stubFetch(async () => jsonResp({ error: "unauthorized" }, 401));
    let code = null;
    try { await newAdapter().getPositions(); } catch (e) { code = e && e.code; }
    ok("401→VENUE_AUTH", code === "VENUE_AUTH", code);
  }
  // 5. 无凭证→VENUE_AUTH(不发网络)
  {
    let netHit = false;
    stubFetch(async () => { netHit = true; return jsonResp({}); });
    let code = null;
    try { await newAdapter({}).getPositions(); } catch (e) { code = e && e.code; }
    ok("无凭证 VENUE_AUTH 且不发请求", code === "VENUE_AUTH" && !netHit, code);
  }
  // 6. UAT 走 api.qfex.io
  {
    stubFetch(async () => jsonResp({ balance: {}, positions: [] }));
    await newAdapter({ apiKey: "k", apiSecret: "s", useUat: true }).getBalance();
    ok("UAT base", lastReq.url === "https://api.qfex.io/user/positions", lastReq.url);
  }
  // 7. refdata 真实样本 → getContract 精度
  {
    const realSample = { type: "refdata", data: [
      { symbol: "CL-USD", tick_size: "0.01", lot_size: "0.001", min_quantity: "0.1", max_quantity: "10000000",
        base_asset: "CL", quote_asset: "USD", default_max_leverage: 10 },
      { symbol: "GOLD-USD", tick_size: "0.1", lot_size: "0.0001", min_quantity: "0.001",
        base_asset: "GOLD", quote_asset: "USD", default_max_leverage: 20 },
    ]};
    stubFetch(async (url) => {
      assert(String(url).endsWith("/refdata"), "refdata 公开请求不应带认证头: " + url);
      return jsonResp(realSample);
    });
    const ad = newAdapter();
    const cl = await ad.getContract("CL-USD");
    ok("CL 精度", cl && cl.lotSize === 0.001 && cl.minQuantity === 0.1 && cl.tickSize === 0.01 && cl.maxLeverage === 10, JSON.stringify(cl));
    const g = await ad.getContract("GOLD-USD");
    ok("GOLD 精度", g && g.lotSize === 0.0001 && g.minQuantity === 0.001, JSON.stringify(g));
    ok("未知合约 null", (await ad.getContract("NOPE-USD")) === null);
  }
  restoreFetch();

  // 8. shim prepareOrderQty 用真实 lot_size 取整 + min_quantity 校验
  {
    const ad = {
      id: "qfex",
      getMarkets: async () => [{ symbol: "GOLD-USD" }],
      getQuote: async () => ({ bid: 4179.5, ask: 4180.5, mark: 4180 }),
      getContract: async (s) => (s === "GOLD-USD" ? { lotSize: 0.0001, minQuantity: 0.001 } : null),
    };
    const api = S.vatBuildVenueLegacyApi(ad, "qfex");
    const p = await api.prepareOrderQty("GOLD-USD-SWAP", "0.123456789", "buy");
    ok("按 lot_size 取整", p.qty === "0.1234", p.qty);
    ok("取整 note", /lot_size/.test(p.note), p.note);
    let threw = null;
    try { await api.prepareOrderQty("GOLD-USD-SWAP", "0.00001", "buy"); } catch (e) { threw = e; }
    ok("低于最小下单量抛错(含关键词)", threw && /低于最小下单量/.test(threw.message), threw && threw.message);
  }
  // 9. LIVE 门禁:qfex 放行,其余未确认 venue 仍拒绝
  {
    ok("qfex+LIVE 放行", S.vatVenueLiveGuard({ activeVenue: "qfex", mode: "profit", liveEnabled: true }) === null);
    const g = S.vatVenueLiveGuard({ activeVenue: "lighter", mode: "profit", liveEnabled: true });
    ok("lighter+LIVE 仍拒绝", typeof g === "string", g);
  }
  // 10. closeAllPositions:枚举持仓逐笔 reduce-only 市价平
  {
    const placed = [];
    const ad = newAdapter();
    ad.getPositions = async () => [
      { venue: "qfex", symbol: "GOLD-USD", side: "long", qty: 0.5 },
      { venue: "qfex", symbol: "CL-USD", side: "short", qty: 2 },
    ];
    ad.placeOrder = async (o) => { placed.push(o); return { orderId: "x", status: "filled" }; };
    const r = await ad.closeAllPositions();
    ok("平掉 2 条", r.closed === 2 && r.total === 2, JSON.stringify(r));
    ok("long→sell reduceOnly", placed[0].side === "sell" && placed[0].reduceOnly === true && placed[0].type === "MARKET");
    ok("short→buy", placed[1].side === "buy" && placed[1].symbol === "CL-USD");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { restoreFetch(); console.error("TEST CRASH", e); process.exit(1); });
