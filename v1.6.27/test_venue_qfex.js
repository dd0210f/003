"use strict";
/* v1.3.0 QFEX 适配器测试:纯 node + assert,零依赖。
 * 用 mock WebSocket transport + mock hmac,不真实连接 qfex(无凭证;PAPER/mock 原则)。
 * 运行: node test_venue_qfex.js
 */
const assert = require("assert");
const { QfexAdapter } = require("./venues/qfex.js");
const { VenueError } = require("./venues/adapter.js");

/* ---------- Mock WebSocket ---------- */
class MockWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0; // CONNECTING
    MockWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (typeof this.onopen === "function") this.onopen();
    }, 0);
  }
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (typeof MockWS.onSend === "function") MockWS.onSend(this, msg);
  }
  close() {
    this.readyState = 3; // CLOSED
    if (typeof this.onclose === "function") this.onclose();
  }
  receive(obj) {
    if (typeof this.onmessage === "function") this.onmessage({ data: JSON.stringify(obj) });
  }
  lastSentOf(type) {
    const arr = this.sent.filter((m) => m.type === type);
    return arr.length ? arr[arr.length - 1] : null;
  }
}
MockWS.instances = [];
MockWS.onSend = null;
MockWS.reset = () => { MockWS.instances = []; MockWS.onSend = null; };

function authOkResponder(ws, msg) {
  if (msg.type === "auth") ws.receive({ type: "auth_response", request_id: msg.request_id, ok: true });
}

function makeAdapter(extraOpts) {
  return new QfexAdapter(Object.assign({
    creds: { apiKey: "qfex_pub_test", apiSecret: "s3cr3t", useUat: true },
    transport: { WebSocket: MockWS },
    hmac: async () => "deadbeef",
    requestTimeoutMs: 2000,
    fillWaitMs: 2000,
  }, extraOpts || {}));
}

/* ---------- 用例 ---------- */

// (1) HMAC 签名原文格式为 nonce:unixSeconds
async function t_hmacFormat() {
  MockWS.reset();
  let captured = null;
  const a = makeAdapter({
    hmac: async (message, secret) => { captured = { message, secret }; return "sig"; },
  });
  MockWS.onSend = (ws, msg) => authOkResponder(ws, msg);
  await a.checkSession();
  assert.ok(captured, "hmac 应在 auth 时被调用");
  assert.match(captured.message, /^[^:]+:\d+$/, "签名原文格式应为 nonce:unixSeconds,实际: " + captured.message);
  const parts = captured.message.split(":");
  assert.strictEqual(parts.length, 2, "原文应恰含一个冒号分隔符");
  assert.ok(/^\d{9,}$/.test(parts[1]), "冒号后应为 unix 秒时间戳,实际: " + parts[1]);
  assert.strictEqual(captured.secret, "s3cr3t", "hmac 应收到 creds.apiSecret");
  await a.disconnect();
}

// (2) UAT 开关切换 WS URL
async function t_uatUrls() {
  MockWS.reset();
  const prod = new QfexAdapter({ creds: {}, transport: { WebSocket: MockWS } });
  assert.strictEqual(prod.tradeUrl, "wss://trade.qfex.com/");
  assert.strictEqual(prod.mdUrl, "wss://mds.qfex.com/");
  const uat = new QfexAdapter({ creds: { useUat: true }, transport: { WebSocket: MockWS } });
  assert.strictEqual(uat.tradeUrl, "wss://trade.qfex.io/");
  assert.strictEqual(uat.mdUrl, "wss://mds.qfex.io/");
}

// (3) add_order 市价单 payload 含 MARKET + order_time_in_force=IOC(官方线格式)
async function t_marketPayload() {
  MockWS.reset();
  const a = makeAdapter();
  MockWS.onSend = (ws, msg) => {
    authOkResponder(ws, msg);
    if (msg.type === "add_order") {
      ws.receive({ type: "ack", request_id: msg.request_id, order_id: "OID-3", ok: true });
      setTimeout(() => ws.receive({ type: "execution_report", order_id: "OID-3", status: "FILLED" }), 20);
    }
  };
  const res = await a.placeOrder({ symbol: "AAPL-USD", side: "buy", qty: 10, type: "MARKET", reduceOnly: true });
  assert.deepStrictEqual(res, { orderId: "OID-3", status: "filled" });
  const m = MockWS.instances[0].lastSentOf("add_order");
  assert.ok(m, "应发出 add_order");
  assert.ok(m.params, "v1.6.10:参数应包进 params(官方信封格式)");
  assert.strictEqual(m.params.order_type, "MARKET");
  assert.strictEqual(m.params.order_time_in_force, "IOC");
  assert.strictEqual(m.params.side, "buy");
  assert.strictEqual(m.params.symbol, "AAPL-USD");
  assert.strictEqual(m.params.quantity, 10);
  assert.strictEqual(m.params.reduce_only, true, "reduce_only 应为独立布尔");
  await a.disconnect();
}

// (4) ACK→FILLED 两阶段返回 status filled
async function t_ackThenFilled() {
  MockWS.reset();
  const a = makeAdapter();
  let ackSeen = false, fillSeen = false;
  MockWS.onSend = (ws, msg) => {
    authOkResponder(ws, msg);
    if (msg.type === "add_order") {
      ackSeen = true;
      // 先 ACK(含 order_id),再异步推送执行报告 —— 模拟两阶段
      ws.receive({ type: "ack", request_id: msg.request_id, order_id: "OID-4", ok: true });
      setTimeout(() => {
        fillSeen = true;
        ws.receive({ type: "execution_report", order_id: "OID-4", status: "FILLED" });
      }, 30);
    }
  };
  const res = await a.placeOrder({ symbol: "AAPL-USD", side: "sell", qty: 5, type: "MARKET" });
  assert.ok(ackSeen && fillSeen, "应经历 ACK 与执行报告两阶段");
  assert.strictEqual(res.orderId, "OID-4");
  assert.strictEqual(res.status, "filled");
  await a.disconnect();
}

// (5) REJECTED 抛 VenueError 且 code=VENUE_REJECTED(带服务端原话)
async function t_rejected() {
  MockWS.reset();
  const a = makeAdapter();
  MockWS.onSend = (ws, msg) => {
    authOkResponder(ws, msg);
    if (msg.type === "add_order") {
      ws.receive({ type: "ack", request_id: msg.request_id, order_id: "OID-5", ok: true });
      setTimeout(() => ws.receive({
        type: "execution_report", order_id: "OID-5", status: "REJECTED", reason: "INSUFFICIENT_MARGIN",
      }), 20);
    }
  };
  let err = null;
  try {
    await a.placeOrder({ symbol: "AAPL-USD", side: "buy", qty: 999999, type: "MARKET" });
  } catch (e) { err = e; }
  assert.ok(err, "REJECTED 应抛错");
  assert.ok(err instanceof VenueError, "应为 VenueError");
  assert.strictEqual(err.code, "VENUE_REJECTED");
  assert.ok(String(err.message).includes("INSUFFICIENT_MARGIN"), "应带服务端原话,实际: " + err.message);
  await a.disconnect();
}

// (6) cancel_order payload
async function t_cancelPayload() {
  MockWS.reset();
  const a = makeAdapter();
  MockWS.onSend = (ws, msg) => {
    authOkResponder(ws, msg);
    if (msg.type === "cancel_order") {
      ws.receive({ type: "cancel_ack", request_id: msg.request_id, ok: true });
    }
  };
  const ok = await a.cancelOrder("X9");
  assert.strictEqual(ok, true);
  const m = MockWS.instances[0].lastSentOf("cancel_order");
  assert.ok(m, "应发出 cancel_order");
  assert.strictEqual(m.params.order_id, "X9"); // v1.6.10:params 嵌套
  await a.disconnect();
}

// (7) 超时抛 VenueError code=VAT_TIMEOUT
async function t_timeout() {
  MockWS.reset();
  const a = makeAdapter({ requestTimeoutMs: 250, fillWaitMs: 250 });
  MockWS.onSend = (ws, msg) => {
    authOkResponder(ws, msg);
    // add_order 故意不回:触发 25s(测试用 250ms)超时
  };
  let err = null;
  try {
    await a.placeOrder({ symbol: "AAPL-USD", side: "buy", qty: 1, type: "MARKET" });
  } catch (e) { err = e; }
  assert.ok(err, "超时应抛错");
  assert.ok(err instanceof VenueError, "应为 VenueError");
  assert.strictEqual(err.code, "VAT_TIMEOUT", "超时 code 应为 VAT_TIMEOUT,实际: " + (err && err.code));
  await a.disconnect();
}

// v1.6.9:字段已确认(getPositions/getBalance 走 REST 真实映射,不再抛 VENUE_UNKNOWN)
// 字段依据见 test_v169.js 头注释
async function t_unconfirmedFields() {
  MockWS.reset();
  const a = makeAdapter();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => {
      assert.ok(String(url).startsWith("https://api.qfex.io/user/positions"), "UAT 应走 api.qfex.io: " + url);
      return {
        balance: { available_balance: "9000", deposit: "10000", realised_pnl: "5", unrealised_pnl: "-1", net_funding: "0" },
        positions: [{ symbol: "GOLD-USD", position: "0.25", average_price: "4180" }],
      };
    },
  });
  try {
    const ps = await a.getPositions();
    assert.strictEqual(ps.length, 1, "应解析出 1 条持仓");
    assert.strictEqual(ps[0].symbol, "GOLD-USD");
    assert.strictEqual(ps[0].side, "long");
    assert.strictEqual(ps[0].qty, 0.25);
    const b = await a.getBalance();
    assert.strictEqual(b.available, 9000, "可用余额");
    assert.ok(Math.abs(b.equity - 10004) < 1e-9, "权益=sum,实际:" + b.equity);
  } finally {
    globalThis.fetch = realFetch;
  }
  // closeAllPositions:现在可枚举持仓 → 不再抛 VENUE_UNKNOWN(用 mock 覆盖 placeOrder 验证方向)
  const a2 = makeAdapter();
  const placed = [];
  a2.getPositions = async () => [{ venue: "qfex", symbol: "GOLD-USD", side: "long", qty: 0.5 }];
  a2.placeOrder = async (o) => { placed.push(o); return { orderId: "x", status: "filled" }; };
  const r = await a2.closeAllPositions();
  assert.strictEqual(r.closed, 1);
  assert.ok(placed[0].reduceOnly === true && placed[0].side === "sell", "long 用 sell reduce-only 平");
  assert.strictEqual(await a.getFunding("AAPL-USD"), null, "getFunding 应返回 null");
  assert.strictEqual(a.getLegacyApi(), null, "getLegacyApi 应返回 null");
  // setCancelOnDisconnect:未连接时只记 flag,不抛
  const flag = await a.setCancelOnDisconnect(true);
  assert.strictEqual(flag, true);
  await a.disconnect();
}

// 附加:缺凭证时 checkSession 抛 VENUE_AUTH
async function t_authMissing() {
  MockWS.reset();
  const a = new QfexAdapter({ creds: {}, transport: { WebSocket: MockWS } });
  let err = null;
  try { await a.checkSession(); } catch (e) { err = e; }
  assert.ok(err && err.code === "VENUE_AUTH", "缺凭证应抛 VENUE_AUTH,实际: " + (err && err.code));
  await a.disconnect();
}

// (10) v1.6.26:trade WS 握手 URL 必须带 ?api_key=<公钥>(网关握手层按此识别用户;
// 实测:裸握手 401 "no authentication credentials provided")
async function t_tradeWsUrlHasApiKey() {
  MockWS.reset();
  const a = makeAdapter(); // useUat:true, apiKey=qfex_pub_test
  MockWS.onSend = (ws, msg) => authOkResponder(ws, msg);
  await a.checkSession();
  assert.ok(MockWS.instances.length >= 1, "应建过 WS 连接");
  const tradeWs = MockWS.instances[0];
  assert.ok(tradeWs.url.startsWith("wss://trade.qfex.io/"),
    "trade WS 仍走 UAT 地址,实际: " + tradeWs.url);
  assert.ok(tradeWs.url.indexOf("?api_key=") >= 0 || tradeWs.url.indexOf("&api_key=") >= 0,
    "握手 URL 应带 api_key 查询参数,实际: " + tradeWs.url);
  assert.ok(tradeWs.url.indexOf(encodeURIComponent("qfex_pub_test")) >= 0,
    "api_key 参数值应为公钥,实际: " + tradeWs.url);
  assert.ok(tradeWs.url.indexOf("s3cr3t") < 0, "URL 里绝不能出现 secret");
  await a.disconnect();
}

/* ---------- runner ---------- */
(async () => {
  const tests = [
    t_hmacFormat, t_uatUrls, t_marketPayload, t_ackThenFilled,
    t_rejected, t_cancelPayload, t_timeout, t_unconfirmedFields, t_authMissing,
    t_tradeWsUrlHasApiKey,
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
