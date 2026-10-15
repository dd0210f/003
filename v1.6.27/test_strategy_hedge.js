"use strict";
/* Hedge 对冲策略测试:纯 node + assert,零依赖。用 mock adapter,不真实连接 Arcus(无凭证)。
 * 覆盖:RSI 三向量(bot.py test_19)、多/空/中性信号、同 bar 去重、K线缺口、sizing 公式、
 * TP 目标价 ±0.8%、PAPER 零下单、双腿异常→全平、杠杆不一致→开仓前抛错、止损触发、首仓超时、
 * 对冲下单,以及新增的 getCandles/verifyLeverage 映射。
 * 运行: node test_strategy_hedge.js
 */
const assert = require("assert");
const { hedgeTick, HedgeTest } = require("./strategy_hedge.js");
const { HEDGE, hedgeRsi, hedgeClosedRows, hedgeSignal,
        hedgeFloorStep, hedgeTpTarget } = HedgeTest;

/* node 下注入 vatLog(浏览器由 strategy.js 提供) */
globalThis.vatLog = (st, asset, msg, level) => {
  st.logs = st.logs || [];
  st.logs.push({ t: Date.now(), asset, msg, level: level || "muted" });
};
const logsOf = (st, re) => (st.logs || []).filter((x) => re.test(x.msg));

/* ---------- Mock adapter ---------- */
const MKTS = [
  { symbol: "BTC-USD", tickSize: "0.5", stepSize: "0.001", minOrderSize: "0.01",
    maxOrderSize: "100", minOrderNotional: "10", status: "ONLINE" },
  { symbol: "ETH-USD", tickSize: "0.05", stepSize: "0.01", minOrderSize: "0.1",
    maxOrderSize: "1000", minOrderNotional: "10", status: "ONLINE" },
];
function makeMock(over) {
  const calls = { placeOrder: [], cancelOrder: [], getCandles: 0 };
  const ad = {
    id: "arcus",
    _calls: calls,
    markets: MKTS,
    quotes: {},
    positions: [],
    balance: { equity: 1000, available: 1000 },
    candles: [],
    leverageOk: true,
    async getMarkets() { return this.markets; },
    async getQuote(s) {
      const q = this.quotes[s];
      if (!q) throw new Error("no mock quote for " + s);
      return q;
    },
    async getPositions() { return this.positions; },
    async getBalance() { return this.balance; },
    async getCandles() { calls.getCandles++; return this.candles; },
    async verifyLeverage() {
      if (!this.leverageOk) { const e = new Error("杠杆不一致"); e.code = "VENUE_AUTH"; throw e; }
      return true;
    },
    async placeOrder(o) {
      calls.placeOrder.push(o);
      return { orderId: "oid-" + calls.placeOrder.length, status: "pending" };
    },
    async cancelOrder(id, opts) { calls.cancelOrder.push({ id, opts }); return true; },
  };
  return Object.assign(ad, over || {});
}
/* 构造 N 根已收盘 5m K线(时间对齐、无缺口),收盘价序列由调用方给 */
function makeCandles(closes, nowSec) {
  const bar = Math.floor(nowSec / 300) * 300 - 300;
  return closes.map((c, i) => {
    const t = bar - (closes.length - 1 - i) * 300;
    return { time: t, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1, isFinal: true };
  });
}
const nowSec = () => Math.floor(Date.now() / 1000);
const falling = (n, from, step) => Array.from({ length: n }, (_, i) => from - i * step);
const rising = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);
function btcQuote(mid, spreadBps) {
  const half = mid * (spreadBps / 10000) / 2;
  return { bid: mid - half, ask: mid + half, mark: mid };
}

/* ---------- 1. RSI 三向量(bot.py test_19) ---------- */
async function t_rsiVectors() {
  assert.strictEqual(hedgeRsi(Array.from({ length: 29 }, (_, i) => i + 1), 12), 100, "单调上涨→100");
  assert.strictEqual(hedgeRsi(Array.from({ length: 29 }, (_, i) => 29 - i), 12), 0, "单调下跌→0");
  assert.strictEqual(hedgeRsi(new Array(30).fill(10), 12), 50, "全平→50");
  assert.strictEqual(hedgeRsi([1, 2, 3], 12), null, "数据不足→null");
}

/* ---------- 2/3/4. 多/空/中性信号 ---------- */
async function t_signalLong() {
  const st = {};
  const ad = makeMock({ candles: makeCandles(falling(20, 100, 1), nowSec()) });
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 0, "PAPER 不下单");
  assert.strictEqual(ad._calls.cancelOrder.length, 0, "PAPER 不撤单");
  assert.strictEqual(logsOf(st, /PAPER 信号 LONG/).length, 1, "应记录 LONG 信号");
  assert.ok(st.hedge.ledger.lastSignalBar > 0, "ledger 去重应记录 bar");
}
async function t_signalShort() {
  const st = {};
  const ad = makeMock({ candles: makeCandles(rising(20, 100, 1), nowSec()) });
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(logsOf(st, /PAPER 信号 SHORT/).length, 1, "应记录 SHORT 信号");
  assert.strictEqual(ad._calls.placeOrder.length, 0);
}
async function t_signalNeutral() {
  const st = {};
  const ad = makeMock({ candles: makeCandles(new Array(20).fill(100), nowSec()) });
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(logsOf(st, /PAPER 信号/).length, 0, "中性区间无信号");
  assert.ok(logsOf(st, /中性区间/).length >= 1, "应记录中性原因");
}

/* ---------- 5. 同 bar 去重 ---------- */
async function t_dedup() {
  const st = {};
  const candles = makeCandles(falling(20, 100, 1), nowSec());
  const ad = makeMock({ candles });
  await hedgeTick({ liveEnabled: false }, st, ad);
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(logsOf(st, /PAPER 信号 LONG/).length, 1, "同 bar 只发一次信号");
  assert.ok(logsOf(st, /已使用/).length >= 1, "第二次应记录去重原因");
}

/* ---------- 6. K线缺口 → 无信号 ---------- */
async function t_gap() {
  const st = {};
  const full = makeCandles(falling(20, 100, 1), nowSec());
  full.splice(10, 1); // 挖掉一根,制造缺口
  const ad = makeMock({ candles: full });
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(logsOf(st, /PAPER 信号/).length, 0, "缺口时无信号");
  assert.ok(logsOf(st, /缺失|不足|不可用/).length >= 1, "应记录数据不可用");
}

/* ---------- 7. sizing 公式:LIVE 首仓数量/价格 ---------- */
async function t_sizing() {
  const st = {};
  const ad = makeMock({
    candles: makeCandles(falling(20, 100000, 100), nowSec()),
    quotes: { "BTC-USD": btcQuote(100000, 0.1), "ETH-USD": btcQuote(3000, 0.1) },
  });
  await hedgeTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 1, "应下一单首仓");
  const o = ad._calls.placeOrder[0];
  assert.strictEqual(o.symbol, "BTC-USD");
  assert.strictEqual(o.side, "buy");
  assert.strictEqual(o.timeInForce, "ALO");
  assert.strictEqual(o.reduceOnly, false);
  assert.strictEqual(o.qty, 0.05, "qty=floor(1000*5/99950,0.001)=0.05");
  assert.strictEqual(o.price, 99950, "price=floor(100000*0.9995,0.5)");
  assert.ok(/^hedge-[0-9a-f]+-E$/.test(o.clientId), "clientId 格式 hedge-<cycle>-E");
  assert.ok(st.hedge.cycle && st.hedge.cycle.side === "LONG", "应建立周期");
}

/* ---------- 8. TP 目标价 ±0.8% ---------- */
async function t_tpPrices() {
  assert.strictEqual(hedgeTpTarget(100, true, "0.01"), 100.8, "多头 TP=entry*1.008");
  assert.strictEqual(hedgeTpTarget(100, false, "0.01"), 99.2, "空头 TP=entry*0.992");
}

/* ---------- 9. PAPER 零下单(显式) ---------- */
async function t_paperNoOrders() {
  const st = {};
  const ad = makeMock({
    candles: makeCandles(rising(20, 100, 1), nowSec()),
    quotes: { "BTC-USD": btcQuote(100, 0.1) },
    balance: { equity: 100000, available: 100000 },
  });
  await hedgeTick({ liveEnabled: false }, st, ad);
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 0, "PAPER 绝不 placeOrder");
  assert.strictEqual(ad._calls.cancelOrder.length, 0, "PAPER 绝不 cancelOrder");
}

/* ---------- 10. 双腿异常 → 全平 ---------- */
async function t_anomalyFlatten() {
  const st = {};
  const ad = makeMock({
    positions: [
      { venue: "arcus", symbol: "BTC-USD", side: "long", qty: "0.1", entryPrice: "100000" },
      { venue: "arcus", symbol: "ETH-USD", side: "long", qty: "0.5", entryPrice: "3000" }, // 同向=异常
    ],
    quotes: { "BTC-USD": btcQuote(100000, 0.1), "ETH-USD": btcQuote(3000, 0.1) },
  });
  st.hedge = { ledger: { lastSignalBar: 0 }, cooldownUntil: 0, day: "2000-01-01",
               dailyLoss: 0, halted: false, orders: {},
               cycle: { id: "t1", side: "LONG", createdAt: Date.now(), btcFilledEver: true, tps: {} } };
  await hedgeTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(st.hedge.cycle, null, "全平后周期清零");
  assert.strictEqual(ad._calls.placeOrder.length, 2, "两腿各一笔 IOC 平仓");
  for (const o of ad._calls.placeOrder) {
    assert.strictEqual(o.reduceOnly, true, "平仓单 reduceOnly");
    assert.strictEqual(o.timeInForce, "IOC", "平仓单 IOC");
    assert.ok(/^hedge-t1-X$/.test(o.clientId), "clientId hedge-<cycle>-X");
  }
  assert.ok(logsOf(st, /双腿方向或仓位异常/).length >= 1, "应记录异常原因");
  assert.ok(st.hedge.cooldownUntil > Date.now(), "应进入冷却");
}

/* ---------- 11. 杠杆不一致 → 开仓前抛错,不下单 ---------- */
async function t_leverageMismatch() {
  const st = {};
  const ad = makeMock({
    leverageOk: false,
    candles: makeCandles(falling(20, 100000, 100), nowSec()),
    quotes: { "BTC-USD": btcQuote(100000, 0.1), "ETH-USD": btcQuote(3000, 0.1) },
  });
  await hedgeTick({ liveEnabled: true }, st, ad); // 不应抛到外层
  assert.strictEqual(ad._calls.placeOrder.length, 0, "杠杆校验失败不下单");
  assert.ok(!st.hedge.cycle, "不建周期");
  assert.ok(logsOf(st, /开仓检查失败/).length >= 1, "应记录失败原因");
}

/* ---------- 12. 止损触发(-16%) ---------- */
async function t_stopLoss() {
  const st = {};
  const ad = makeMock({
    positions: [
      { venue: "arcus", symbol: "BTC-USD", side: "long", qty: "0.1", entryPrice: "100000" },
    ],
    quotes: { "BTC-USD": btcQuote(84000, 0.1), "ETH-USD": btcQuote(3000, 0.1) }, // -16%
  });
  st.hedge = { ledger: { lastSignalBar: 0 }, cooldownUntil: 0, day: "2000-01-01",
               dailyLoss: 0, halted: false, orders: {},
               cycle: { id: "t2", side: "LONG", createdAt: Date.now(), btcFilledEver: true, tps: {} } };
  await hedgeTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(st.hedge.cycle, null, "止损后周期清零");
  assert.strictEqual(ad._calls.placeOrder.length, 1, "只平 BTC 一腿");
  assert.ok(logsOf(st, /价格止损/).length >= 1, "应记录止损原因");
  assert.ok(st.hedge.dailyLoss < 0, "亏损应累计到今日");
}

/* ---------- 13. 首仓 300s 超时未成交 ---------- */
async function t_entryTimeout() {
  const st = {};
  const ad = makeMock({ quotes: { "BTC-USD": btcQuote(100000, 0.1), "ETH-USD": btcQuote(3000, 0.1) } });
  const placedAt = Date.now() - 400000;
  const entry = { key: "E:hedge-abc-E", orderId: "oid-1", clientId: "hedge-abc-E",
                  symbol: "BTC-USD", side: "buy", qty: 0.05, price: 99950, placedAt };
  st.hedge = { ledger: { lastSignalBar: 0 }, cooldownUntil: 0, day: "2000-01-01",
               dailyLoss: 0, halted: false, orders: { "E:hedge-abc-E": entry },
               cycle: { id: "abc", side: "LONG", createdAt: placedAt, btcFilledEver: false, tps: {}, entry } };
  await hedgeTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.cancelOrder.length, 1, "应撤首仓单");
  assert.strictEqual(ad._calls.cancelOrder[0].id, "oid-1");
  assert.strictEqual(st.hedge.cycle, null, "超时后周期清零");
  assert.ok(logsOf(st, /300s 未成交/).length >= 1);
}

/* ---------- 14. 对冲下单:BTC 有仓 → ETH 反向 IOC ---------- */
async function t_hedgeOrder() {
  const st = {};
  const ad = makeMock({
    positions: [
      { venue: "arcus", symbol: "BTC-USD", side: "long", qty: "0.1", entryPrice: "100000" },
    ],
    quotes: { "BTC-USD": btcQuote(100000, 0.1), "ETH-USD": btcQuote(3000, 0.1) },
  });
  st.hedge = { ledger: { lastSignalBar: 0 }, cooldownUntil: 0, day: "2000-01-01",
               dailyLoss: 0, halted: false, orders: {},
               cycle: { id: "x1", side: "LONG", createdAt: Date.now(), btcFilledEver: true, tps: {} } };
  await hedgeTick({ liveEnabled: true }, st, ad);
  const ioc = ad._calls.placeOrder.find((o) => o.timeInForce === "IOC" && o.symbol === "ETH-USD");
  assert.ok(ioc, "应有 ETH IOC 对冲单");
  assert.strictEqual(ioc.side, "sell", "BTC 多 → ETH 空");
  assert.strictEqual(ioc.reduceOnly, false);
  assert.strictEqual(ioc.qty, 3.33, "qty=floor(min(10000/2999,1000),0.01)=3.33");
  const tp = ad._calls.placeOrder.find((o) => o.timeInForce === "ALO" && o.reduceOnly === true);
  assert.ok(tp, "BTC 腿应挂止盈单");
  assert.strictEqual(tp.price, 100800, "TP=100000*1.008");
}

/* ---------- 15/16. 新增 adapter 方法:getCandles/verifyLeverage ---------- */
const SEED_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const ADDR = "0x1111111111111111111111111111111111111111";
function mockFetch(routes) {
  globalThis.fetch = async (url, init) => {
    for (const r of routes) {
      if (r.match(String(url))) {
        const out = typeof r.respond === "function" ? r.respond(String(url)) : r.respond;
        const status = out.status || 200;
        return { ok: status >= 200 && status < 300, status, json: async () => out.json };
      }
    }
    throw new Error("no mock route for " + url);
  };
}
function arcusAdapter() {
  const { ArcusAdapter } = require("./venues/arcus.js");
  return new ArcusAdapter("arcus", {
    creds: { walletAddress: ADDR, apiSigningKey: SEED_HEX, accountIndex: 0 },
    requestTimeoutMs: 2000,
  });
}
async function t_candlesMapping() {
  mockFetch([
    { match: (u) => u.includes("/v1/time"), respond: { json: { timeNs: "1800000000000000000" } } },
    { match: (u) => u.includes("/v1/candles"), respond: { json: { candles: [{
      openTime: "1800000000000000", open: "1", high: "2", low: "0.5",
      close: "1.5", volume: "10", isFinal: true }] } } },
  ]);
  const rows = await arcusAdapter().getCandles("BTC-USD", "5m", 10);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].time, 1800000000, "openTime 微秒→秒");
  assert.strictEqual(rows[0].close, 1.5);
  assert.strictEqual(rows[0].isFinal, true);
}
async function t_verifyLeverage() {
  const mk = (lev) => [
    { match: (u) => u.includes("/v1/time"), respond: { json: { timeNs: "1800000000000000000" } } },
    { match: (u) => /\/v1\/markets(\?|$)/.test(u), respond: { json: { markets: [{
      marketDisplayName: "BTC-USD", marketId: 1, tickSize: "0.5", stepSize: "0.001",
      minOrderSize: "0.01", maxOrderSize: "100", minOrderNotional: "10", status: "ONLINE" }] } } },
    { match: (u) => u.includes("/v1/leverages"), respond: { json: { leverages: [
      { marketId: 1, leverage: lev, marginMode: "CROSS" } ] } } },
  ];
  mockFetch(mk("40"));
  assert.strictEqual(await arcusAdapter().verifyLeverage("BTC-USD", 40, "CROSS"), true, "一致通过");
  mockFetch(mk("20"));
  let err = null;
  try { await arcusAdapter().verifyLeverage("BTC-USD", 40, "CROSS"); }
  catch (e) { err = e; }
  assert.ok(err && err.code === "VENUE_AUTH", "不一致抛 VENUE_AUTH,code=" + (err && err.code));
}

/* ---------- 17. isFinal 缺失 → 用收盘时间兜底,信号正常 ---------- */
function makeCandlesNoFinal(closes, s) {
  return makeCandles(closes, s).map(({ isFinal, ...r }) => r);
}
async function t_isFinalMissing() {
  const s = nowSec();
  const rows = hedgeClosedRows(makeCandlesNoFinal(falling(20, 100, 1), s), s);
  assert.strictEqual(rows.length, 20, "无 isFinal 字段也应接受");
  const sig = hedgeSignal(rows, { lastSignalBar: 0 });
  assert.ok(sig.signal && sig.side === "LONG", "信号应正常触发");
}
/* ---------- 18. isFinal=false 的已收盘根 → 排除 ---------- */
async function t_isFinalFalseExcluded() {
  const s = nowSec();
  const cs = makeCandles(falling(20, 100, 1), s);
  cs[cs.length - 1].isFinal = false;
  let err = null;
  try { hedgeClosedRows(cs, s); } catch (e) { err = e; }
  assert.ok(err, "最新根未 final 应抛错");
}
/* ---------- 19. PAPER 杠杆预检:失败记 err、零下单、10 分钟内不重复 ---------- */
async function t_paperLeverageCheck() {
  const st = {};
  let levCalls = 0;
  const ad = makeMock({
    candles: makeCandles(rising(20, 100, 1), nowSec()),
    verifyLeverage: async () => {
      levCalls++;
      const e = new Error("杠杆不一致"); e.code = "VENUE_AUTH"; throw e;
    },
  });
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(levCalls, 1, "PAPER 应调用一次杠杆校验");
  assert.ok(logsOf(st, /杠杆校验失败/).length >= 1, "应记 err 日志");
  assert.strictEqual(ad._calls.placeOrder.length, 0, "PAPER 零下单");
  await hedgeTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(levCalls, 1, "10 分钟内不重复校验");
}

/* ---------- runner ---------- */
(async () => {
  const tests = [
    t_rsiVectors, t_signalLong, t_signalShort, t_signalNeutral, t_dedup, t_gap,
    t_sizing, t_tpPrices, t_paperNoOrders, t_anomalyFlatten, t_leverageMismatch,
    t_stopLoss, t_entryTimeout, t_hedgeOrder, t_candlesMapping, t_verifyLeverage,
    t_isFinalMissing, t_isFinalFalseExcluded, t_paperLeverageCheck,
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
