"use strict";
/* v1.3.0 Phase E: Lighter 适配器测试。纯 node + assert,零依赖。
 * mock fetch + mock signer:不碰真实网络、不索取真实凭证、不真实下单。
 * 运行: node test_venue_lighter.js
 */
const assert = require("assert");
const { LighterAdapter, LIGHTER_SETUP_STEPS, TX_CREATE_ORDER, TX_CANCEL_ORDER } =
  require("./venues/lighter.js");
const { VenueError } = require("./venues/adapter.js");
const { createVenueAdapter } = require("./venues/index.js");
const LighterSignerVendor = require("./venues/vendor/lighter-signer.bundle.js");

const FAKE = { apiKey: "fake_api_private_key_for_test_only", accountIndex: 123456, keyIndex: 7 };

let pass = 0;
const ok = (name, cond) => { assert(cond, "FAIL: " + name); pass++; console.log("PASS:", name); };

/* ---------- mock fetch ---------- */
const sentBodies = [];
const sentUrls = [];
let nonceCounter = 900;
let failNextNonceOnce = false;
const MOCK_BOOK = {
  code: 200,
  asks: [{ price: "85001.0" }, { price: "85002.0" }],
  bids: [{ price: "84999.0" }, { price: "84998.0" }],
};
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const json = (obj, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => obj,
  });
  if (u.includes("/api/v1/orderBookDetails")) {
    return json({ code: 200, order_book_details: [
      { symbol: "BTC", market_id: 1, market_type: "perp", status: "active",
        size_decimals: 4, price_decimals: 2, supported_size_decimals: 4,
        supported_price_decimals: 2, min_base_amount: "0.0001",
        min_quote_amount: "10.000000", mark_price: "85000.5" },
      { symbol: "ETH", market_id: 0, market_type: "perp", status: "active",
        size_decimals: 4, price_decimals: 2, supported_size_decimals: 4,
        supported_price_decimals: 2, min_base_amount: "0.002",
        min_quote_amount: "10.000000", mark_price: "3100.25" },
    ]});
  }
  if (u.includes("/api/v1/orderBookOrders")) return json(MOCK_BOOK);
  if (u.includes("/api/v1/funding-rates")) {
    return json({ code: 200, funding_rates: [
      { market_id: 1, exchange: "binance", symbol: "BTC", rate: 0.0002 },
      { market_id: 1, exchange: "lighter", symbol: "BTC", rate: 0.0001 },
    ]});
  }
  if (u.includes("/api/v1/nextNonce")) {
    if (failNextNonceOnce) { failNextNonceOnce = false; throw new Error("simulated network drop"); }
    nonceCounter += 1;
    return json({ code: 200, nonce: nonceCounter });
  }
  if (u.includes("/api/v1/account?")) {
    return json({ code: 200, total: 1, accounts: [{
      index: 123456, available_balance: "1000.000000", total_asset_value: "1050.5",
      collateral: "1050.500000",
      positions: [
        { market_id: 1, symbol: "BTC", sign: 1, position: "0.1000",
          avg_entry_price: "84000.00", unrealized_pnl: "100.50" },
        { market_id: 0, symbol: "ETH", sign: -1, position: "2.0000",
          avg_entry_price: "3200.00", unrealized_pnl: "-199.50" },
        { market_id: 2, symbol: "SOL", sign: 1, position: "0.0000",
          avg_entry_price: "0", unrealized_pnl: "0" },
      ],
      assets: [{ symbol: "USDC", asset_id: 3, balance: "1000.000000", locked_balance: "0.000000" }],
    }]});
  }
  if (u.includes("/api/v1/sendTx")) {
    sentUrls.push(u);
    sentBodies.push(JSON.parse(init.body));
    return json({ code: 200, tx_hash: "0xdeadbeef" });
  }
  throw new Error("unexpected url: " + u);
};

/* ---------- mock signer:按文档格式 mint token / 返回假签名 ---------- */
let mintCalls = 0;
const mockSigner = {
  kind: "mock",
  mintAuthToken: async ({ deadlineUnix, apiKeyIndex, accountIndex }) => {
    mintCalls++;
    return `${deadlineUnix}:${accountIndex}:${apiKeyIndex}:` + "ab".repeat(16);
  },
  signTx: async ({ txType, txInfo }) => ({
    txInfo: JSON.stringify(Object.assign({}, txInfo, { Sig: "mock_sig" })),
    signature: "mock_sig",
    txHash: "0xmockhash",
  }),
};

const memStore = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); } };
};
const mk = (over) => new LighterAdapter("lighter",
  Object.assign({ creds: FAKE, storage: memStore(), signer: mockSigner }, over));

(async () => {
/* ---------- (1) token 格式 ---------- */
{
  const a = mk();
  const t = await a._ensureAuthToken();
  const m = /^(\d+):(\d+):(\d+):([0-9a-fA-F]+)$/.exec(t);
  ok("token 格式=expiry:account:keyIndex:random_hex", !!m);
  ok("token 内 account/keyIndex 与凭证一致",
    Number(m[2]) === FAKE.accountIndex && Number(m[3]) === FAKE.keyIndex);
  ok("token 有效期<=8h", Number(m[1]) - Math.floor(Date.now() / 1000) <= 8 * 3600);
}

/* ---------- (2) 剩余<1h 自动重 mint(约7h轮换) ---------- */
{
  mintCalls = 0;
  const store = memStore();
  const a = mk({ storage: store });
  const nowS = Math.floor(Date.now() / 1000);
  /* 种子:30 分钟后过期 -> 必须重 mint */
  await store.set("lighter:authToken", {
    token: `${nowS + 1800}:${FAKE.accountIndex}:${FAKE.keyIndex}:` + "cd".repeat(16),
    expiry: nowS + 1800,
  });
  const t1 = await a._ensureAuthToken();
  ok("剩余<1h 时重新 mint", mintCalls === 1 && t1.includes("ab".repeat(16)));
  /* 2 小时后过期 -> 复用,不重 mint */
  const before = mintCalls;
  const t2 = await a._ensureAuthToken();
  ok("剩余>1h 时复用缓存 token", mintCalls === before && t2 === t1);
  /* 过期 token -> 重 mint */
  await store.set("lighter:authToken", {
    token: `${nowS - 10}:${FAKE.accountIndex}:${FAKE.keyIndex}:` + "ee".repeat(16),
    expiry: nowS - 10,
  });
  await a._ensureAuthToken();
  ok("已过期 token 触发重 mint", mintCalls === before + 1);
}

/* ---------- (3) nonce 递增不重复 ---------- */
{
  const a = mk();
  const n1 = await a._nextNonce();
  const n2 = await a._nextNonce();
  const n3 = await a._nextNonce();
  ok("nonce 严格递增不重复", n2 === n1 + 1 && n3 === n2 + 1);
  /* nextNonce 失败 -> 本地计数器接力,不编造 */
  failNextNonceOnce = true;
  const n4 = await a._nextNonce();
  ok("nextNonce 失败时本地计数器接力", n4 === n3 + 1);
  /* 从无基准且服务端失败 -> 抛 VENUE_NETWORK,不敢编 nonce */
  const fresh = mk();
  failNextNonceOnce = true;
  let err = null;
  try { await fresh._nextNonce(); } catch (e) { err = e; }
  ok("无 nonce 基准且服务端失败时抛 VENUE_NETWORK",
    err && err.code === "VENUE_NETWORK");
}

/* ---------- 读路径 ---------- */
{
  const a = mk();
  const mkts = await a.getMarkets();
  ok("getMarkets 返回 perp 列表", mkts.length === 2 && mkts[0].symbol === "BTC" && mkts[0].marketId === 1);
  const q = await a.getQuote("BTC");
  ok("getQuote bid/ask/mark", q.bid === 84999 && q.ask === 85001 && q.mark === 85000.5);
  const f = await a.getFunding("BTC");
  ok("getFunding 取 exchange=lighter 行,interval=28800(8h等效)",
    f && f.rate === 0.0001 && f.interval === 28800);
  const f2 = await a.getFunding("ETH");
  ok("getFunding 无 lighter 行返回 null", f2 === null);
  const pos = await a.getPositions();
  ok("getPositions 过滤零持仓并映射 side",
    pos.length === 2 && pos[0].side === "long" && pos[0].qty === 0.1 &&
    pos[1].side === "short" && pos[1].symbol === "ETH" &&
    pos[0].entryPrice === 84000 && pos[0].upnl === 100.5 && pos[0].venue === "lighter");
  const bal = await a.getBalance();
  ok("getBalance equity/available", bal.equity === 1050.5 && bal.available === 1000);
  ok("checkSession 通过", (await a.checkSession()) === true);
  ok("getLegacyApi 返回 null", a.getLegacyApi() === null);
  let err = null;
  try { await a.getQuote("NOPE"); } catch (e) { err = e; }
  ok("未知标的不猜 market_id(抛 VENUE_REJECTED)", err && err.code === "VENUE_REJECTED");
}

/* ---------- (4) sendTx payload ---------- */
{
  sentBodies.length = 0;
  const a = mk();
  const r = await a.placeOrder({ symbol: "BTC", side: "buy", qty: 0.1, type: "limit", price: 84900 });
  ok("placeOrder 返回 {orderId,status=pending}(accepted≠executed)",
    r && typeof r.orderId === "string" && r.status === "pending");
  const b = sentBodies[0];
  ok("sendTx payload 含 tx_type/tx_info/signature",
    b.tx_type === TX_CREATE_ORDER && b.tx_type === 14 &&
    typeof b.tx_info === "string" && b.signature === "mock_sig");
  const ti = JSON.parse(b.tx_info);
  ok("tx_info 字段布局符合文档(CreateOrder)",
    ti.AccountIndex === FAKE.accountIndex && ti.ApiKeyIndex === FAKE.keyIndex &&
    ti.MarketIndex === 1 && ti.BaseAmount === 1000 && ti.Price === 8490000 &&
    ti.IsAsk === 0 && ti.Type === 0 && ti.TimeInForce === 1 && ti.Nonce > 0);
  ok("POST 路径为 /api/v1/sendTx",
    sentUrls[0] === "https://mainnet.zklighter.elliot.ai/api/v1/sendTx");
  const okCancel = await a.cancelOrder("562948923372019", { symbol: "BTC" });
  const c = sentBodies[1];
  ok("cancelOrder 走 tx_type=15(文档原文,非16)", okCancel === true && c.tx_type === TX_CANCEL_ORDER && c.tx_type === 15);
  const ci = JSON.parse(c.tx_info);
  ok("cancel tx_info 含 Index/MarketIndex", ci.Index === 562948923372019 && ci.MarketIndex === 1);
  let err = null;
  try { await a.cancelOrder("123"); } catch (e) { err = e; }
  ok("cancelOrder 缺 market 上下文不猜(抛 VENUE_REJECTED)", err && err.code === "VENUE_REJECTED");
}

/* ---------- (5) 错误形状 VenueError ---------- */
{
  const ve = new VenueError("VENUE_AUTH", "x");
  ok("VenueError 形状 {code,message,retryable,name}",
    ve.code === "VENUE_AUTH" && ve.name === "VenueError" && ve.retryable === false &&
    typeof ve.message === "string");
  /* 未配凭证 -> VENUE_AUTH,且文案不泄露 apiKey */
  const a = new LighterAdapter("lighter", { creds: {}, storage: memStore(), signer: mockSigner });
  let err = null;
  try { await a.checkSession(); } catch (e) { err = e; }
  ok("未配凭证 checkSession 抛 VENUE_AUTH", err && err.code === "VENUE_AUTH");
  ok("错误文案不含凭证", err && !String(err.message).includes("fake_api_private_key"));
  /* 默认 stub signer -> VENUE_UNKNOWN,写清原因 */
  const b = new LighterAdapter("lighter", { creds: FAKE, storage: memStore() }); /* 无 signer */
  let err2 = null;
  try { await b._ensureAuthToken(); } catch (e) { err2 = e; }
  ok("默认 stub signer 抛 VENUE_UNKNOWN 且写清原因",
    err2 && err2.code === "VENUE_UNKNOWN" && /Poseidon\/Schnorr/.test(err2.message));
  /* vendor stub 直接调用同样 VENUE_UNKNOWN */
  const stub = LighterSignerVendor.createLighterSigner({});
  let err3 = null;
  try { await stub.signTx({ txType: 14, txInfo: {} }); } catch (e) { err3 = e; }
  ok("vendor stub signTx 抛 VENUE_UNKNOWN", err3 && err3.code === "VENUE_UNKNOWN");
  let err4 = null;
  try { await stub.mintAuthToken({}); } catch (e) { err4 = e; }
  ok("vendor stub mintAuthToken 抛 VENUE_UNKNOWN", err4 && err4.code === "VENUE_UNKNOWN");
}

/* ---------- 工厂/常量/SETUP_STEPS ---------- */
{
  const a = createVenueAdapter("lighter", { creds: FAKE, storage: memStore(), signer: mockSigner });
  ok("createVenueAdapter('lighter') 建出 LighterAdapter", a instanceof LighterAdapter);
  const t = new LighterAdapter("lighter", { creds: Object.assign({}, FAKE, { useTestnet: true }) });
  ok("useTestnet 切测试网 base", t.base === "https://testnet.zklighter.elliot.ai" &&
    t.wsUrl === "wss://testnet.zklighter.elliot.ai/stream" && t.chainId === 300);
  ok("主网 base/chainId", mk().base === "https://mainnet.zklighter.elliot.ai" && mk().chainId === 304);
  ok("LIGHTER_SETUP_STEPS 非空字符串数组",
    Array.isArray(LIGHTER_SETUP_STEPS) && LIGHTER_SETUP_STEPS.length >= 8 &&
    LIGHTER_SETUP_STEPS.every((s) => typeof s === "string" && s.length > 0));
  ok("SETUP_STEPS 含关键步骤(index 4–254/私钥一次/ChangePubKey)",
    LIGHTER_SETUP_STEPS.join(" ").includes("4–254") &&
    LIGHTER_SETUP_STEPS.join(" ").includes("只显示一次") &&
    LIGHTER_SETUP_STEPS.join(" ").includes("ChangePubKey"));
}

console.log(`\nALL ${pass} TESTS PASSED`);
})().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
