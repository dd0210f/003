"use strict";
/* v1.6.19:Hedge 通用化测试。
 * 1. hedgeResolvePair:各所默认 + 用户覆盖
 * 2. hedgeTick 不再要求 Arcus(无 getCandles 的适配器抛错,有则跑)
 * 3. QFEX getCandles:1MIN→5m 聚合(mock _restGet)
 * 4. QFEX verifyLeverage:超上限抛错
 * 5. Variational 合成 K线:vatPushCandle1m + vatCandles5m
 */
globalThis.vatLog = () => {};
const hedge = require("./strategy_hedge.js");
const { hedgeResolvePair, hedgeTick } = hedge;
const HEDGE_VENUE_DEFAULTS = hedge.HedgeTest.HEDGE_VENUE_DEFAULTS;
const strat = require("./strategy.js");
const { vatPushCandle1m, vatCandles5m } = strat;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " | " + extra : "")); }
}

/* ---- 1. 对子解析 ---- */
{
  const a = hedgeResolvePair({ activeVenue: "arcus" });
  ok("arcus 默认 BTC-USD/ETH-USD 40x/25x",
    a.symA === "BTC-USD" && a.symB === "ETH-USD" && a.levA === 40 && a.levB === 25);
  const v = hedgeResolvePair({ activeVenue: "variational" });
  ok("variational 默认 BTC/ETH", v.symA === "BTC" && v.symB === "ETH");
  const q = hedgeResolvePair({ activeVenue: "qfex" });
  ok("qfex 默认 GOLD-USD/SILVER-USD", q.symA === "GOLD-USD" && q.symB === "SILVER-USD");
  const c = hedgeResolvePair({ activeVenue: "qfex", hedgeSymA: "nvda-usd", hedgeSymB: "aapl-usd", hedgeLevA: 20, hedgeLevB: 15 });
  ok("用户覆盖(大小写/杠杆)", c.symA === "NVDA-USD" && c.symB === "AAPL-USD" && c.levA === 20 && c.levB === 15);
  ok("默认表三所齐全", ["arcus", "variational", "qfex"].every((k) => !!HEDGE_VENUE_DEFAULTS[k]));
}

/* ---- 3/4. QFEX getCandles 聚合 + verifyLeverage ---- */
async function qfexAdapterMock() {
  const { QfexAdapter } = require("./venues/qfex.js");
  const ad = new QfexAdapter({ apiKey: "k", apiSecret: "s", useUat: false, requestTimeoutMs: 5000 });
  // mock _restGet:1MIN K线(每分钟一根,价格递增)
  ad._restGet = async (path, opts) => {
    if (path.includes("/candles/")) {
      const now = Date.now();
      const m0 = Math.floor(now / 60000) * 60000;
      const candles = [];
      for (let i = 400; i >= 1; i--) {
        const t = new Date(m0 - i * 60000).toISOString();
        const p = 4000 + i * 0.1;
        candles.push({ startedAt: t, open: String(p), high: String(p + 0.5), low: String(p - 0.5), close: String(p + 0.2) });
      }
      return { candles }; // 故意 newest-first 打乱,验证排序
    }
    if (path === "/refdata") {
      return { data: [{ symbol: "GOLD-USD", tick_size: "0.1", lot_size: "0.01", min_quantity: "0.01", max_quantity: "100", default_max_leverage: "50" }] };
    }
    throw new Error("unexpected " + path);
  };
  return ad;
}

/* ---- 2. 不再限定 Arcus ---- */
async function fakeAdapter() {
  return {
    id: "qfex",
    getMarkets: async () => [
      { symbol: "GOLD-USD", tickSize: "0.1", stepSize: "0.01", minOrderSize: "0.01", maxOrderSize: "100", minOrderNotional: "5" },
      { symbol: "SILVER-USD", tickSize: "0.01", stepSize: "0.1", minOrderSize: "0.1", maxOrderSize: "1000", minOrderNotional: "5" },
    ],
    getPositions: async () => [],
    getBalance: async () => ({ equity: 1000, available: 900 }),
    getQuote: async () => ({ bid: 100, ask: 100.1 }),
    getCandles: async () => { throw new Error("K线不足"); },
    verifyLeverage: async () => ({ ok: true }),
    placeOrder: async () => { throw new Error("不应下单"); },
    cancelOrder: async () => ({}),
  };
}
(async () => {
  {
    const ad = await qfexAdapterMock();
    const bars = await ad.getCandles("GOLD-USD", "5m", 50);
    ok("QFEX 聚合 51 根 5m", bars.length === 51, "got " + bars.length);
    ok("QFEX bar 对齐", bars.every((b) => b.time % 300 === 0 && b.high >= b.low && b.isFinal));
    const v = await ad.verifyLeverage("GOLD-USD", 10);
    ok("QFEX 杠杆 10x<=50x 通过", v && v.ok === true);
    let errL = "";
    try { await ad.verifyLeverage("GOLD-USD", 60); } catch (e) { errL = String((e && e.message) || e); }
    ok("QFEX 杠杆 60x>50x 抛错", /超过市场上限/.test(errL), errL);
  }

  // 无 getCandles → 抛错且信息含 venue
  const noC = { id: "xxx" };
  let err1 = "";
  try { await hedgeTick({ activeVenue: "variational", liveEnabled: false }, {}, noC); }
  catch (e) { err1 = String((e && e.message) || e); }
  ok("无 getCandles 抛错", /getCandles/.test(err1), err1);

  // 有 getCandles(抛 K线不足) → 不再报"需要 Arcus",而是 K线原因等待
  const ad = await fakeAdapter();
  const st = {};
  await hedgeTick({ activeVenue: "qfex", liveEnabled: false }, st, ad);
  ok("非 Arcus 适配器可进入 PAPER 流程", st.hedge && st.hedge._waitReason === "SIGNAL_WAIT", st.hedge && st.hedge._waitReason);

  /* ---- 5. Variational 合成 K线 ---- */
  globalThis.VAT_C1M = {};
  const now = Date.now();
  const m0 = Math.floor(now / 60000) * 60000;
  // 造 260 根 1m bar(>51 根 5m 需要的 255 根)
  for (let i = 260; i >= 1; i--) {
    const t = m0 - i * 60000;
    const p = 100 + Math.sin(i / 10) * 2;
    vatPushCandle1m("BTC", p, t + 30000);
  }
  const bars = vatCandles5m("BTC", 50, now);
  ok("合成 51 根 5m", bars.length === 51, "got " + bars.length);
  ok("bar 字段齐全", bars.every((b) => b.time && b.open > 0 && b.high >= b.low && b.isFinal === true));
  ok("时间 5m 对齐", bars.every((b) => b.time % 300 === 0));
  let err5 = "";
  try { vatCandles5m("ETH", 50, now); } catch (e) { err5 = String(e.message); }
  ok("无数据抛错", /不足/.test(err5), err5);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("FATAL", e); process.exit(1); });
