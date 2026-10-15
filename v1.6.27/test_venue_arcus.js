"use strict";
/* Arcus 适配器测试:纯 node + assert,零依赖。用 mock fetch,不真实连接 Arcus(无凭证)。
 * 覆盖:SHA-512/Ed25519 已知答案向量、规范 JSON、order/cancel payload 映射、
 * 下单请求头与签名可验签、写操作不重试、撤单两种模式、parse_account 映射与校验、
 * 精度校验抛错、报价新鲜度、checkSession。
 * 运行: node test_venue_arcus.js
 */
const assert = require("assert");
const crypto = require("crypto");
const { ArcusAdapter, ArcusEd25519, ArcusTest } = require("./venues/arcus.js");
const { createVenueAdapter } = require("./venues/index.js");

/* ---------- Mock fetch ---------- */
const routes = [];
let fetchCalls = [];
function resetRoutes() { routes.length = 0; fetchCalls = []; }
function mockRoute(match, respond) { routes.push({ match, respond }); }
globalThis.fetch = async (url, init) => {
  init = init || {};
  fetchCalls.push({ url: String(url), init });
  for (const r of routes) {
    if (r.match(String(url), init)) {
      const out = typeof r.respond === "function" ? await r.respond(String(url), init) : r.respond;
      const status = out.status || 200;
      return { ok: status >= 200 && status < 300, status, json: async () => out.json };
    }
  }
  throw new Error("no mock route for " + url);
};

/* ---------- 测试凭证(与已知答案向量一致,非真实凭证) ---------- */
const SEED_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const PUBKEY_HEX = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
const ADDR = "0x1111111111111111111111111111111111111111";
const TIME_NS = "1800000000000000000";

function makeAdapter(extra) {
  return new ArcusAdapter("arcus", Object.assign({
    creds: { walletAddress: ADDR, apiSigningKey: SEED_HEX, accountIndex: 0 },
    requestTimeoutMs: 2000,
  }, extra || {}));
}
function routeTime() {
  mockRoute((u) => u.includes("/v1/time"), { json: { timeNs: TIME_NS } });
}
function routeMarkets() {
  mockRoute((u) => /\/v1\/markets(\?|$)/.test(u), {
    json: { markets: [{
      marketDisplayName: "BTC-USD", marketId: 1, tickSize: "0.5", stepSize: "0.001",
      minOrderSize: "0.01", maxOrderSize: "100", minOrderNotional: "10",
      status: "ONLINE", initialMarginFraction: "0.025",
    }] },
  });
}
function routeApiKeys(status) {
  mockRoute((u) => u.includes("/v1/apiKeys"), {
    json: { apiKeys: [{ apiKey: PUBKEY_HEX, status: status || "ACTIVE", allSubaccounts: true, accountIndex: 0, validUntil: "0" }] },
  });
}

/* ---------- 用例 ---------- */

// (1) SHA-512 与 node crypto 一致
async function t_sha512() {
  for (const s of ["", "abc", "The quick brown fox jumps over the lazy dog"]) {
    const mine = Buffer.from(ArcusEd25519.sha512(Buffer.from(s, "utf8"))).toString("hex");
    const ref = crypto.createHash("sha512").update(s, "utf8").digest("hex");
    assert.strictEqual(mine, ref, "SHA-512 不一致: " + JSON.stringify(s));
  }
}

// (2) Ed25519 已知答案向量(公钥推导 + 确定性签名逐字节一致)
async function t_kat() {
  const pub = ArcusEd25519.hex(ArcusEd25519.pubkeyFromSeed(ArcusEd25519.unhex(SEED_HEX)));
  assert.strictEqual(pub, PUBKEY_HEX, "公钥推导与向量不一致");
  const msg = ArcusTest.canonical({
    ad: ADDR, ai: 0, c: "test1", ct: 1800000000000000000n, g: 1803456000000000000n,
    m: 1, op: 1, p: 990, q: 1000, r: 0, s: 0, t: 3, v: 1,
  });
  assert.strictEqual(Buffer.from(msg).toString(),
    '{"ad":"0x1111111111111111111111111111111111111111","ai":0,"c":"test1","ct":1800000000000000000,"g":1803456000000000000,"m":1,"op":1,"p":990,"q":1000,"r":0,"s":0,"t":3,"v":1}',
    "规范 JSON 与向量原文不一致");
  const sig = ArcusEd25519.hex(ArcusEd25519.sign(ArcusEd25519.unhex(SEED_HEX), msg));
  assert.strictEqual(sig,
    "466a65fb72f2cd29b746aa4471346d1a31b47b965a0a435f93bc26727fbc541680f63d77c827b2af4f7c2937e1954e2403524cbd0338c0a0559ec3225aa0600a",
    "确定性签名与向量不一致");
  assert.ok(ArcusEd25519.verify(ArcusEd25519.unhex(sig), msg, ArcusEd25519.unhex(PUBKEY_HEX)), "自验签应通过");
  // node crypto 独立交叉验证
  const pubKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(PUBKEY_HEX, "hex").toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify(null, Buffer.from(msg), pubKey, Buffer.from(sig, "hex")), "node crypto 验签应通过");
}

// (3) 规范 JSON:键排序 + 紧凑分隔符 + BigInt
async function t_canonical() {
  const s = Buffer.from(ArcusTest.canonical({ b: 1, a: 2, n: { z: [3, 1], m: 1800000000000000000n } })).toString();
  assert.strictEqual(s, '{"a":2,"b":1,"n":{"m":1800000000000000000,"z":[3,1]}}');
  assert.ok(!s.includes(" "), "不应含空格");
}

// (4) order_payload / cancel_payload 字段映射(与 bot.py 一致)
async function t_payloads() {
  const p = ArcusTest.orderPayload({
    address: ADDR, accountIndex: 0, timestamp: 1800000000000000000n,
    goodTilMicros: "1800000000000000", marketId: 1,
    priceTicks: 134001n, qtySteps: 2000n, reduceOnly: false,
    side: "buy", timeInForce: "ALO", clientId: "test1",
  });
  assert.deepStrictEqual(p, {
    ad: ADDR, ai: 0, ct: 1800000000000000000n, g: 1800000000000000000n,
    m: 1, op: 1, p: 134001n, q: 2000n, r: 0, s: 0, t: 3, v: 1, c: "test1",
  });
  const p2 = ArcusTest.orderPayload({
    address: ADDR.toUpperCase(), accountIndex: 2, timestamp: 1n,
    goodTilMicros: "2", marketId: 7, priceTicks: 1n, qtySteps: 1n,
    reduceOnly: true, side: "sell", timeInForce: "IOC",
  });
  assert.strictEqual(p2.ad, ADDR, "地址应转小写");
  assert.strictEqual(p2.s, 1, "SELL=1");
  assert.strictEqual(p2.t, 2, "IOC=2");
  assert.strictEqual(p2.r, 1, "reduceOnly=1");
  assert.ok(!("c" in p2), "无 clientId 时不应有 c 字段");
  const c1 = ArcusTest.cancelPayload({ address: ADDR, accountIndex: 0, timestamp: 5n, marketId: 1, orderId: "ord1" });
  assert.deepStrictEqual(c1, { ad: ADDR, ai: 0, ct: 5n, m: 1, op: 2, v: 1, id: "ord1" });
  const c2 = ArcusTest.cancelPayload({ address: ADDR, accountIndex: 0, timestamp: 5n, marketId: 1, clientId: "cid9" });
  assert.deepStrictEqual(c2, { ad: ADDR, ai: 0, ct: 5n, m: 1, op: 2, v: 1, c: "cid9" });
}

// (5) 下单:请求头、签名可验签、payload 字段、单次尝试
async function t_placeOrder() {
  resetRoutes();
  routeTime(); routeMarkets();
  mockRoute((u, init) => u.includes("/v1/placeOrder") && init.method === "POST", { json: { orderId: "ord123" } });
  let capturedMsg = null;
  const a = makeAdapter({
    signer: async (seedHex, msg) => {
      capturedMsg = msg;
      assert.strictEqual(seedHex, SEED_HEX, "签名器应收到 seed hex");
      return ArcusEd25519.hex(ArcusEd25519.sign(ArcusEd25519.unhex(seedHex), msg));
    },
  });
  const r = await a.placeOrder({ symbol: "BTC-USD", side: "buy", qty: "0.02", price: "67000.5", timeInForce: "ALO", clientId: "test1" });
  assert.strictEqual(r.orderId, "ord123");
  assert.strictEqual(r.status, "pending");
  assert.strictEqual(r.clientId, "test1");
  const calls = fetchCalls.filter((c) => c.url.includes("/v1/placeOrder"));
  assert.strictEqual(calls.length, 1, "下单应只尝试一次");
  const h = calls[0].init.headers;
  assert.strictEqual(h["X-API-Key"], PUBKEY_HEX, "X-API-Key 应为公钥 hex");
  assert.ok(/^\d+$/.test(h["X-Timestamp"]), "X-Timestamp 应为数字字符串");
  assert.ok(/^[0-9a-f]{128}$/.test(h["X-Signature"]), "X-Signature 应为 128 hex");
  assert.ok(ArcusEd25519.verify(ArcusEd25519.unhex(h["X-Signature"]), capturedMsg, ArcusEd25519.unhex(PUBKEY_HEX)),
    "服务端应能验签通过");
  const payload = JSON.parse(Buffer.from(capturedMsg).toString());
  assert.strictEqual(payload.op, 1);
  assert.strictEqual(payload.s, 0, "buy=0");
  assert.strictEqual(payload.t, 3, "ALO=3");
  assert.strictEqual(payload.m, 1);
  assert.strictEqual(payload.p, 134001, "67000.5/0.5=134001");
  assert.strictEqual(payload.q, 20, "0.02/0.001=20");
  assert.strictEqual(payload.r, 0);
  assert.strictEqual(payload.c, "test1");
  assert.strictEqual(payload.v, 1);
  assert.strictEqual(String(payload.ct), h["X-Timestamp"], "签名体 ct 应与请求头一致");
  const sentBody = JSON.parse(calls[0].init.body);
  assert.strictEqual(String(sentBody.timestamp), h["X-Timestamp"], "body timestamp 应与请求头一致");
  assert.strictEqual(sentBody.orderSide, "BUY");
  assert.strictEqual(sentBody.timeInForce, "ALO");
  assert.strictEqual(sentBody.reduceOnly, false);
  assert.strictEqual(sentBody.marketId, 1);
  assert.ok(calls[0].url.includes("address=" + ADDR) && calls[0].url.includes("accountIndex=0"), "query 应带账户参数");
  await a.disconnect();
}

// (6) 写操作失败不重试(500 只尝试一次,直接上抛)
async function t_noRetryOnWrite() {
  resetRoutes();
  routeTime(); routeMarkets();
  mockRoute((u, init) => u.includes("/v1/placeOrder") && init.method === "POST",
    { status: 500, json: { error: "boom" } });
  const a = makeAdapter();
  let err = null;
  try { await a.placeOrder({ symbol: "BTC-USD", side: "buy", qty: "0.02", price: "67000.5" }); }
  catch (e) { err = e; }
  assert.ok(err && err.code === "VENUE_REJECTED", "500 应抛 VENUE_REJECTED,实际: " + (err && err.code));
  const n = fetchCalls.filter((c) => c.url.includes("/v1/placeOrder")).length;
  assert.strictEqual(n, 1, "写操作绝不自动重试,实际尝试 " + n + " 次");
  await a.disconnect();
}

// (7) 精度/最小值校验抛错
async function t_precision() {
  resetRoutes();
  routeTime(); routeMarkets();
  mockRoute((u, init) => u.includes("/v1/placeOrder") && init.method === "POST", { json: { orderId: "x" } });
  const a = makeAdapter();
  let e1 = null;
  try { await a.placeOrder({ symbol: "BTC-USD", side: "buy", qty: "0.002", price: "67000.3" }); }
  catch (e) { e1 = e; }
  assert.ok(e1 && e1.code === "VENUE_REJECTED" && /精度/.test(e1.message), "价格非 tick 整数倍应抛错");
  let e2 = null;
  try { await a.placeOrder({ symbol: "BTC-USD", side: "buy", qty: "0.005", price: "67000.5" }); }
  catch (e) { e2 = e; }
  assert.ok(e2 && /minOrderSize/.test(e2.message), "数量低于 minOrderSize 应抛错");
  let e3 = null;
  try { await a.placeOrder({ symbol: "BTC-USD", side: "buy", qty: "0.002", price: "67000.5", timeInForce: "XYZ" }); }
  catch (e) { e3 = e; }
  assert.ok(e3 && /timeInForce/.test(e3.message), "非法 tif 应抛错");
  // reduceOnly 跳过最小值检查
  const r = await a.placeOrder({ symbol: "BTC-USD", side: "sell", qty: "0.005", price: "67000.5", reduceOnly: true });
  assert.strictEqual(r.status, "pending", "reduceOnly 应跳过 minOrderSize 检查");
  await a.disconnect();
}

// (8) 撤单:orderId 模式与 clientId 模式
async function t_cancel() {
  resetRoutes();
  routeTime();
  let capturedMsg = null;
  mockRoute((u, init) => u.includes("/v1/cancelOrder") && init.method === "POST", { json: {} });
  const a = makeAdapter({
    signer: async (seedHex, msg) => {
      capturedMsg = msg;
      return ArcusEd25519.hex(ArcusEd25519.sign(ArcusEd25519.unhex(seedHex), msg));
    },
  });
  assert.strictEqual(await a.cancelOrder("ord123", { marketId: 1 }), true);
  let call = fetchCalls.find((c) => c.url.includes("/v1/cancelOrder"));
  let payload = JSON.parse(Buffer.from(capturedMsg).toString());
  assert.deepStrictEqual(payload, { ad: ADDR, ai: 0, ct: payload.ct, m: 1, op: 2, v: 1, id: "ord123" });
  assert.ok(!("c" in payload), "orderId 模式不应有 c");
  let body = JSON.parse(call.init.body);
  assert.strictEqual(body.kind, "orderId");
  assert.strictEqual(body.orderId, "ord123");
  const h = call.init.headers;
  assert.ok(ArcusEd25519.verify(ArcusEd25519.unhex(h["X-Signature"]), capturedMsg, ArcusEd25519.unhex(PUBKEY_HEX)));

  resetRoutes();
  routeTime();
  mockRoute((u, init) => u.includes("/v1/cancelOrder") && init.method === "POST", { json: {} });
  capturedMsg = null;
  assert.strictEqual(await a.cancelOrder(null, { clientId: "cid9", marketId: 1 }), true);
  payload = JSON.parse(Buffer.from(capturedMsg).toString());
  assert.strictEqual(payload.c, "cid9");
  assert.ok(!("id" in payload), "clientId 模式不应有 id");
  body = JSON.parse(fetchCalls.find((c) => c.url.includes("/v1/cancelOrder")).init.body);
  assert.strictEqual(body.kind, "clientId");
  assert.strictEqual(body.clientId, "cid9");
  await a.disconnect();
}

// (9) parse_account 映射与校验
function accountJson(over) {
  return Object.assign({
    address: ADDR, accountIndex: 0, equity: "1000.5", freeCollateral: "800.25",
    netDeposits: "1000", sequenceNumber: "42",
    positions: { 1: {
      marketId: 1, address: ADDR, accountIndex: 0, size: "0.5", side: "LONG",
      averageEntryPrice: "67000", markPx: "67100", positionValueNotional: "33550",
      marketDisplayName: "BTC-USD",
    } },
  }, over || {});
}
async function t_parseAccount() {
  resetRoutes();
  routeTime();
  mockRoute((u) => u.includes("/v1/account"), { json: accountJson() });
  const a = makeAdapter();
  const poss = await a.getPositions();
  assert.strictEqual(poss.length, 1);
  assert.strictEqual(poss[0].venue, "arcus");
  assert.strictEqual(poss[0].symbol, "BTC-USD");
  assert.strictEqual(poss[0].side, "long");
  assert.strictEqual(poss[0].qty, 0.5);
  assert.strictEqual(poss[0].entryPrice, 67000);
  assert.ok(!("upnl" in poss[0]), "无 upnl 字段,不应编造");
  const bal = await a.getBalance();
  assert.deepStrictEqual(bal, { equity: 1000.5, available: 800.25 });

  // 身份不匹配抛错
  resetRoutes(); routeTime();
  mockRoute((u) => u.includes("/v1/account"), { json: accountJson({ address: "0x2222222222222222222222222222222222222222" }) });
  let e1 = null;
  try { await a.getPositions(); } catch (e) { e1 = e; }
  assert.ok(e1 && /身份/.test(e1.message), "账户身份不匹配应抛错");

  // 量纲不一致抛错(名义金额差 >2%)
  resetRoutes(); routeTime();
  const bad = accountJson();
  bad.positions[1].positionValueNotional = "100";
  mockRoute((u) => u.includes("/v1/account"), { json: bad });
  let e2 = null;
  try { await a.getPositions(); } catch (e) { e2 = e; }
  assert.ok(e2 && /量纲/.test(e2.message), "量纲不一致应抛错");

  // 数量方向不一致抛错
  resetRoutes(); routeTime();
  const bad2 = accountJson();
  bad2.positions[1].side = "SHORT";
  mockRoute((u) => u.includes("/v1/account"), { json: bad2 });
  let e3 = null;
  try { await a.getPositions(); } catch (e) { e3 = e; }
  assert.ok(e3 && /方向/.test(e3.message), "数量方向不一致应抛错");
  await a.disconnect();
}

// (10) checkSession
async function t_checkSession() {
  resetRoutes();
  routeTime(); routeApiKeys("ACTIVE");
  const a = makeAdapter();
  assert.strictEqual(await a.checkSession(), true);

  resetRoutes(); routeTime(); routeApiKeys("REVOKED");
  let e1 = null;
  try { await a.checkSession(); } catch (e) { e1 = e; }
  assert.ok(e1 && e1.code === "VENUE_AUTH", "REVOKED 应抛 VENUE_AUTH");

  const b = new ArcusAdapter("arcus", { creds: {} });
  let e2 = null;
  try { await b.checkSession(); } catch (e) { e2 = e; }
  assert.ok(e2 && e2.code === "VENUE_AUTH", "缺凭证应抛 VENUE_AUTH");
  await a.disconnect();
}

// (11) 报价新鲜度
async function t_quote() {
  resetRoutes();
  routeTime();
  const freshMicros = "1800000000000000"; // 与 mock 服务器时间一致
  mockRoute((u) => u.includes("/v1/bbo/"), { json: {
    bestBid: { price: "67000" }, bestAsk: { price: "67000.5" }, timestamp: freshMicros,
  } });
  const a = makeAdapter();
  const q = await a.getQuote("BTC-USD");
  assert.strictEqual(q.bid, 67000);
  assert.strictEqual(q.ask, 67000.5);
  assert.strictEqual(q.mark, 67000.25);

  resetRoutes(); routeTime();
  mockRoute((u) => u.includes("/v1/bbo/"), { json: {
    bestBid: { price: "67000" }, bestAsk: { price: "67000.5" }, timestamp: "1799999970000000", // 30 秒前
  } });
  let e = null;
  try { await a.getQuote("BTC-USD"); } catch (err) { e = err; }
  assert.ok(e && /过期/.test(e.message), "过期报价应抛错");
  await a.disconnect();
}

// (12) closeAllPositions:reduce-only IOC 按盘口平
async function t_closeAll() {
  resetRoutes();
  routeTime(); routeMarkets();
  mockRoute((u) => u.includes("/v1/account"), { json: accountJson() });
  mockRoute((u) => u.includes("/v1/bbo/"), { json: {
    bestBid: { price: "67000" }, bestAsk: { price: "67000.5" }, timestamp: "1800000000000000",
  } });
  let capturedMsg = null;
  mockRoute((u, init) => u.includes("/v1/placeOrder") && init.method === "POST", { json: { orderId: "close1" } });
  const a = makeAdapter({
    signer: async (seedHex, msg) => {
      capturedMsg = msg;
      return ArcusEd25519.hex(ArcusEd25519.sign(ArcusEd25519.unhex(seedHex), msg));
    },
  });
  const r = await a.closeAllPositions();
  assert.strictEqual(r.closed, 1);
  const payload = JSON.parse(Buffer.from(capturedMsg).toString());
  assert.strictEqual(payload.s, 1, "long 平仓应为 sell");
  assert.strictEqual(payload.r, 1, "应为 reduce-only");
  assert.strictEqual(payload.t, 2, "应为 IOC");
  assert.strictEqual(payload.q, 500, "0.5/0.001=500");
  const body = JSON.parse(fetchCalls.find((c) => c.url.includes("/v1/placeOrder")).init.body);
  assert.strictEqual(body.price, "67000", "sell 按 bid 吃单");
  assert.strictEqual(body.timeInForce, "IOC");
  assert.strictEqual(body.reduceOnly, true);
  await a.disconnect();
}

// (13) getFunding/getLegacyApi
async function t_misc() {
  const a = makeAdapter();
  assert.strictEqual(await a.getFunding("BTC-USD"), null, "getFunding 应返回 null");
  assert.strictEqual(a.getLegacyApi(), null, "getLegacyApi 应返回 null(策略引擎不接 Arcus)");
  await a.disconnect();
}

// (14) 工厂与 testnet 开关
async function t_factory() {
  resetRoutes();
  const a = createVenueAdapter("arcus", { creds: { walletAddress: ADDR, apiSigningKey: SEED_HEX, accountIndex: 0 } });
  assert.ok(a instanceof ArcusAdapter, "工厂应建出 ArcusAdapter");
  assert.strictEqual(a.base, "https://api.arcus.xyz");
  const t = createVenueAdapter("arcus", { creds: { walletAddress: ADDR, apiSigningKey: SEED_HEX, accountIndex: 0, useTestnet: true } });
  assert.strictEqual(t.base, "https://api.testnet.arcus.xyz");
  assert.strictEqual(createVenueAdapter("txflow", {}), null, "unsupported 应返回 null");
  assert.strictEqual(createVenueAdapter("nope", {}), null, "未知 id 应返回 null");
  await a.disconnect(); await t.disconnect();
}

/* ---------- runner ---------- */
(async () => {
  const tests = [
    t_sha512, t_kat, t_canonical, t_payloads, t_placeOrder, t_noRetryOnWrite,
    t_precision, t_cancel, t_parseAccount, t_checkSession, t_quote,
    t_closeAll, t_misc, t_factory,
  ];
  let pass = 0;
  for (const t of tests) {
    try {
      await t();
      pass++;
      console.log("ok - " + t.name);
    } catch (e) {
      console.error("FAIL - " + t.name + ": " + ((e && e.stack) || e));
      process.exitCode = 1;
    }
  }
  console.log(pass + "/" + tests.length + " passed");
})();
