"use strict";
/* 资金费率套利测试:纯 node + assert,零依赖。用 mock 双 adapter,不真实连接。
 * 覆盖:edge 计算与自动选方向、SWAP 按 0 计、Lighter 费率年化、PAPER 零下单、
 * LIVE 双腿同名义开仓、edge 跌破退出阈值全平、基差超限全平、funding null 跳过不清仓、
 * 第二腿失败→第一腿回平(无裸腿);xfund 方向选择、PAPER 零下单、第二腿失败回平、
 * 退出阈值两所各平各的、持仓读失败不清仓、基差超限全平。
 * 运行: node test_strategy_fund.js
 */
const assert = require("assert");
const { fundTick, xfundTick, FundTest } = require("./strategy_fund.js");
const { fundAnnualize, fundSymMatches, fundLegAlive, fundCfg, FUND_PAIRS_BY_VENUE } = FundTest;

/* node 下注入 vatLog(浏览器由 strategy.js 提供) */
globalThis.vatLog = (st, asset, msg, level) => {
  st.logs = st.logs || [];
  st.logs.push({ t: Date.now(), asset, msg, level: level || "muted" });
};
const logsOf = (st, re) => (st.logs || []).filter((x) => re.test(x.msg));

/* ---------- Mock venue adapter ---------- */
function makeVenueMock(id, over) {
  const calls = { placeOrder: [], cancelOrder: [] };
  const ad = {
    id,
    _calls: calls,
    funding: {},   // market -> {rate, interval} | null(缺失)
    quotes: {},    // market -> {bid, ask, mark}
    positions: [], // 或 'throw' 模拟读取失败
    failOpenSide: null, // 设为 'buy'/'sell' 时该方向的开仓单(reduceOnly=false)抛错,回平单不受影响
    async getFunding(m) {
      const v = this.funding[m];
      if (v === "throw") throw new Error("funding boom");
      return v === undefined ? null : v;
    },
    async getQuote(m) {
      const q = this.quotes[m];
      if (!q) throw new Error("no mock quote for " + m);
      return q;
    },
    async getPositions() {
      if (this.positions === "throw") throw new Error("positions boom");
      return this.positions;
    },
    async placeOrder(o) {
      if (this.failOpenSide && o.side === this.failOpenSide && !o.reduceOnly)
        throw new Error("下单被拒 " + o.side);
      calls.placeOrder.push(o);
      return { orderId: "oid-" + calls.placeOrder.length };
    },
    async cancelOrder() { calls.cancelOrder.push(1); return true; },
  };
  return Object.assign(ad, over || {});
}
const Q = (mark, sprdBps) => {
  const half = mark * (sprdBps / 10000) / 2;
  return { bid: mark - half, ask: mark + half, mark };
};
const PAIR = { a: "USOIL-SWAP", b: "CL-PERP" };
const KEY = PAIR.a + "|" + PAIR.b;
function fundPos(longM, qtyA, qtyB) {
  return {
    [KEY]: {
      a: PAIR.a, b: PAIR.b, longM, shortM: longM === PAIR.a ? PAIR.b : PAIR.a,
      sideA: longM === PAIR.a ? "long" : "short",
      sideB: longM === PAIR.a ? "short" : "long",
      qtyA, qtyB, openedAt: 1, openEdge: 0.2,
    },
  };
}

/* ---------- fund: 1. edge 计算与自动选方向 ---------- */
async function t_edgeDirection() {
  const st = {};
  const ad = makeVenueMock("variational", {
    funding: { "USOIL-SWAP": { rate: 0.05, interval: null }, "CL-PERP": { rate: 0.25, interval: null } },
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
  });
  await fundTick({}, st, ad); // PAPER
  assert.strictEqual(ad._calls.placeOrder.length, 0, "PAPER 零下单");
  const logs = logsOf(st, /PAPER 信号/);
  assert.ok(logs.length === 1, "应有一条 PAPER 信号");
  assert.ok(/long USOIL-SWAP short CL-PERP/.test(logs[0].msg), "edge 大的方向:做多低费率 " + logs[0].msg);
  assert.ok(/edge=20\.00%/.test(logs[0].msg), "edge=0.25-0.05=20%");
}
/* ---------- fund: 2. SWAP 无费率按 0 计 ---------- */
async function t_swapSyntheticZero() {
  const st = {};
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": { rate: 0.20, interval: null } }, // USOIL-SWAP 缺失 → synthetic 0
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
  });
  await fundTick({}, st, ad);
  const logs = logsOf(st, /PAPER 信号/);
  assert.ok(logs.length === 1 && /edge=20\.00%/.test(logs[0].msg), "SWAP 按 0 计,edge=20%");
  assert.ok(logsOf(st, /按 0 计/).length >= 1, "应标注 synthetic");
}
/* ---------- fund: 3. Lighter 费率按区间年化 ---------- */
async function t_annualize() {
  const r = fundAnnualize({ rate: 0.0001, interval: 28800 });
  assert.ok(Math.abs(r.rate - 0.1095) < 1e-9, "0.0001/8h → 年化 10.95%,得 " + r.rate);
  const r2 = fundAnnualize({ rate: 0.2, interval: null });
  assert.strictEqual(r2.rate, 0.2, "已年化不重复乘");
  assert.strictEqual(fundAnnualize(null), null, "null → null");
  assert.strictEqual(fundAnnualize({ rate: null }), null, "rate null → null");
}
/* ---------- fund: 4. PAPER 零下单(重复确认) ---------- */
async function t_paperNoOrders() {
  const st = {};
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": { rate: 0.30, interval: null } },
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
  });
  await fundTick({ liveEnabled: false }, st, ad);
  await fundTick({ liveEnabled: false }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 0, "PAPER 绝不 placeOrder");
  assert.strictEqual(ad._calls.cancelOrder.length, 0, "PAPER 绝不 cancelOrder");
  assert.ok(!st.fund.pos[KEY], "PAPER 不建仓位状态");
}
/* ---------- fund: 5. LIVE 双腿同名义开仓 ---------- */
async function t_liveOpen() {
  const st = {};
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": { rate: 0.25, interval: null } }, // SWAP=0 → long USOIL-SWAP
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
  });
  await fundTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 2, "两条腿");
  const [o1, o2] = ad._calls.placeOrder;
  assert.strictEqual(o1.side, "buy"); assert.strictEqual(o1.symbol, "USOIL-SWAP");
  assert.strictEqual(o2.side, "sell"); assert.strictEqual(o2.symbol, "CL-PERP");
  assert.ok(Math.abs(o1.qty * 70 - 500) < 1e-6, "long 腿名义 $500");
  assert.ok(Math.abs(o2.qty * 65 - 500) < 1e-6, "short 腿名义 $500");
  assert.ok(/^fund-/.test(o1.clientId), "clientId 前缀 fund-");
  const pos = st.fund.pos[KEY];
  assert.ok(pos && pos.longM === "USOIL-SWAP", "状态记录方向");
}
/* ---------- fund: 6. edge 跌破退出阈值 → 全平 ---------- */
async function t_exitOnEdgeDrop() {
  const st = { fund: { pos: fundPos("USOIL-SWAP", 7.14, 7.69), _wait: {} } };
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": { rate: 0.02, interval: null } }, // edge=2% < 5%
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
    positions: [
      { symbol: "USOIL", side: "long", qty: 7.14 },
      { symbol: "CL", side: "short", qty: 7.69 },
    ],
  });
  await fundTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 2, "两腿全平");
  for (const o of ad._calls.placeOrder) assert.strictEqual(o.reduceOnly, true, "平仓 reduceOnly");
  const sides = ad._calls.placeOrder.map((o) => o.side).sort();
  assert.deepStrictEqual(sides, ["buy", "sell"], "一买一卖对平");
  assert.ok(!st.fund.pos[KEY], "状态清零");
  assert.ok(logsOf(st, /跌破平仓线/).length >= 1, "应记原因");
}
/* ---------- fund: 7. 基差超限 → 全平 ---------- */
async function t_basisBreach() {
  const st = { fund: { pos: fundPos("USOIL-SWAP", 7.14, 7.69), _wait: {} } };
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": { rate: 0.30, interval: null } }, // edge 仍高
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(80, 2) }, // 基差 13% >> 50bps
    positions: [
      { symbol: "USOIL", side: "long", qty: 7.14 },
      { symbol: "CL", side: "short", qty: 7.69 },
    ],
  });
  await fundTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 2, "基差超限全平");
  assert.ok(!st.fund.pos[KEY], "状态清零");
  assert.ok(logsOf(st, /基差.*超限/).length >= 1, "应记基差原因");
}
/* ---------- fund: 8. funding null → 跳过不清仓 ---------- */
async function t_fundingNullSkip() {
  const st = { fund: { pos: fundPos("USOIL-SWAP", 7.14, 7.69), _wait: {} } };
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": null }, // 非 SWAP 的 null → 跳过
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
    positions: [
      { symbol: "USOIL", side: "long", qty: 7.14 },
      { symbol: "CL", side: "short", qty: 7.69 },
    ],
  });
  await fundTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 0, "不清仓");
  assert.ok(st.fund.pos[KEY], "状态保留");
  assert.ok(logsOf(st, /费率缺失/).length >= 1, "应记 warn");
}
/* ---------- fund: 9. 第二腿失败 → 第一腿回平(无裸腿) ---------- */
async function t_secondLegFail() {
  const st = {};
  const ad = makeVenueMock("variational", {
    funding: { "CL-PERP": { rate: 0.25, interval: null } },
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(65, 2) },
    failOpenSide: "sell", // short 腿开仓失败(回平单 reduceOnly 不受影响)
  });
  await fundTick({ liveEnabled: true }, st, ad);
  assert.strictEqual(ad._calls.placeOrder.length, 2, "开一腿+回平一腿");
  const [o1, o2] = ad._calls.placeOrder;
  assert.strictEqual(o1.side, "buy"); assert.strictEqual(o2.side, "sell");
  assert.strictEqual(o2.reduceOnly, true, "回平 reduceOnly");
  assert.ok(!st.fund.pos[KEY], "不建仓位状态");
  assert.ok(logsOf(st, /防裸露/).length >= 1, "应记 err");
}

/* ---------- xfund: 10. 自动选方向(long 低费率所) ---------- */
async function t_xDirection() {
  const st = {};
  const adA = makeVenueMock("variational", {
    funding: { BTC: { rate: 0.005, interval: null } }, // edge=10.45% > 10% 开仓线
    quotes: { BTC: Q(100000, 1) },
  });
  const adB = makeVenueMock("lighter", {
    funding: { BTC: { rate: 0.0001, interval: 28800 } }, // 年化 10.95%
    quotes: { BTC: Q(100100, 1) },
  });
  await xfundTick({}, st, adA, adB); // PAPER
  assert.strictEqual(adA._calls.placeOrder.length + adB._calls.placeOrder.length, 0, "PAPER 零下单");
  const logs = logsOf(st, /XFUND PAPER 信号/);
  assert.ok(logs.length === 1, "应有一条 PAPER 信号");
  assert.ok(/long variational short lighter/.test(logs[0].msg), "做多低费率所: " + logs[0].msg);
}
/* ---------- xfund: 11. PAPER 双所零下单 ---------- */
async function t_xPaperNoOrders() {
  const st = {};
  const adA = makeVenueMock("variational", {
    funding: { BTC: { rate: 0.30, interval: null } },
    quotes: { BTC: Q(100000, 1) },
  });
  const adB = makeVenueMock("lighter", {
    funding: { BTC: { rate: 0.00001, interval: 28800 } },
    quotes: { BTC: Q(100100, 1) },
  });
  await xfundTick({ liveEnabled: false }, st, adA, adB);
  await xfundTick({ liveEnabled: false }, st, adA, adB);
  assert.strictEqual(adA._calls.placeOrder.length, 0);
  assert.strictEqual(adB._calls.placeOrder.length, 0);
  assert.strictEqual(adA._calls.cancelOrder.length + adB._calls.cancelOrder.length, 0);
  assert.ok(!st.xfund.pos, "PAPER 不建仓位状态");
}
/* ---------- xfund: 12. 第二腿失败 → 第一腿被平掉 ---------- */
async function t_xSecondLegFail() {
  const st = {};
  const adA = makeVenueMock("variational", {
    funding: { BTC: { rate: 0.005, interval: null } }, // long A,edge=10.45%
    quotes: { BTC: Q(100000, 1) },
  });
  const adB = makeVenueMock("lighter", {
    funding: { BTC: { rate: 0.0001, interval: 28800 } },
    quotes: { BTC: Q(100100, 1) },
    failOpenSide: "sell",
  });
  await xfundTick({ liveEnabled: true }, st, adA, adB);
  assert.strictEqual(adA._calls.placeOrder.length, 2, "A 所:开 long + 回平");
  assert.strictEqual(adB._calls.placeOrder.length, 0, "B 所第二腿没开成");
  const [o1, o2] = adA._calls.placeOrder;
  assert.strictEqual(o1.side, "buy"); assert.strictEqual(o2.side, "sell");
  assert.strictEqual(o2.reduceOnly, true, "回平 reduceOnly");
  assert.ok(/^xfund-/.test(o1.clientId), "clientId 前缀 xfund-");
  assert.ok(!st.xfund.pos, "无裸腿状态");
  assert.ok(logsOf(st, /防裸露/).length >= 1);
}
/* ---------- xfund: 13. 退出阈值 → 两所各平各的 ---------- */
async function t_xExit() {
  const st = { xfund: { pos: { longV: "variational", shortV: "lighter", longQty: 0.005, shortQty: 0.005, openedAt: 1, openEdge: 0.2 }, _wait: {} } };
  const adA = makeVenueMock("variational", {
    funding: { BTC: { rate: 0.10, interval: null } },
    quotes: { BTC: Q(100000, 1) },
    positions: [{ symbol: "BTC", side: "long", qty: 0.005 }],
  });
  const adB = makeVenueMock("lighter", {
    funding: { BTC: { rate: 0.0001, interval: 28800 } }, // 年化 10.95% → edge=0.95% < 3%
    quotes: { BTC: Q(100050, 1) },
    positions: [{ symbol: "BTC", side: "short", qty: 0.005 }],
  });
  await xfundTick({ liveEnabled: true }, st, adA, adB);
  assert.strictEqual(adA._calls.placeOrder.length, 1, "A 所平 long");
  assert.strictEqual(adB._calls.placeOrder.length, 1, "B 所平 short");
  assert.strictEqual(adA._calls.placeOrder[0].side, "sell");
  assert.strictEqual(adB._calls.placeOrder[0].side, "buy");
  assert.ok(adA._calls.placeOrder[0].reduceOnly && adB._calls.placeOrder[0].reduceOnly, "都 reduceOnly");
  assert.ok(adB._calls.placeOrder[0].price > 0, "Lighter 腿带 price");
  assert.ok(!st.xfund.pos, "状态清零");
}
/* ---------- xfund: 14. 任一所持仓读失败 → 不清仓 ---------- */
async function t_xPosReadFail() {
  const st = { xfund: { pos: { longV: "variational", shortV: "lighter", longQty: 0.005, shortQty: 0.005, openedAt: 1, openEdge: 0.2 }, _wait: {} } };
  const adA = makeVenueMock("variational", {
    funding: { BTC: { rate: 0.10, interval: null } },
    quotes: { BTC: Q(100000, 1) },
    positions: [{ symbol: "BTC", side: "long", qty: 0.005 }],
  });
  const adB = makeVenueMock("lighter", {
    funding: { BTC: { rate: 0.0001, interval: 28800 } },
    quotes: { BTC: Q(100050, 1) },
    positions: "throw",
  });
  await xfundTick({ liveEnabled: true }, st, adA, adB);
  assert.strictEqual(adA._calls.placeOrder.length + adB._calls.placeOrder.length, 0, "不清仓");
  assert.ok(st.xfund.pos, "状态保留");
  assert.ok(logsOf(st, /持仓读取失败/).length >= 1);
}
/* ---------- xfund: 15. 基差超限 → 全平 ---------- */
async function t_xBasisBreach() {
  const st = { xfund: { pos: { longV: "variational", shortV: "lighter", longQty: 0.005, shortQty: 0.005, openedAt: 1, openEdge: 0.2 }, _wait: {} } };
  const adA = makeVenueMock("variational", {
    funding: { BTC: { rate: 0.02, interval: null } }, // edge 仍高
    quotes: { BTC: Q(100000, 1) },
    positions: [{ symbol: "BTC", side: "long", qty: 0.005 }],
  });
  const adB = makeVenueMock("lighter", {
    funding: { BTC: { rate: 0.0001, interval: 28800 } },
    quotes: { BTC: Q(101000, 1) }, // 基差 ~100bps > 80bps
    positions: [{ symbol: "BTC", side: "short", qty: 0.005 }],
  });
  await xfundTick({ liveEnabled: true }, st, adA, adB);
  assert.strictEqual(adA._calls.placeOrder.length + adB._calls.placeOrder.length, 2, "两所全平");
  assert.ok(!st.xfund.pos, "状态清零");
  assert.ok(logsOf(st, /基差.*超限/).length >= 1);
}

/* ---------- fund: 16. 按 venue 取对子 + 无对子时费率发现 ---------- */
async function t_fundPerVenue() {
  // variational 走内置默认对子
  assert.deepStrictEqual(
    fundCfg({}, "variational").pairs, FUND_PAIRS_BY_VENUE.variational, "variational 默认对子");
  assert.deepStrictEqual(fundCfg({}, "lighter").pairs, [], "lighter 无默认对子");
  const st1 = {};
  const adV = makeVenueMock("variational", {
    funding: { "USOIL-SWAP": null, "CL-PERP": { rate: 0.25, interval: null } },
    quotes: { "USOIL-SWAP": Q(70, 2), "CL-PERP": Q(70, 2) },
  });
  await fundTick({ liveEnabled: false }, st1, adV);
  assert.ok(st1.fund.lastScan && st1.fund.lastScan.venue === "variational", "应写 lastScan");
  assert.strictEqual(st1.fund.lastScan.pairs.length, 1, "variational 默认 1 对");
  assert.ok(Math.abs(st1.fund.lastScan.pairs[0].edge - 0.25) < 1e-9, "edge=25%");
  // lighter 无配置 → discovery,不下单
  const st2 = {};
  const adL = makeVenueMock("lighter", {
    funding: { "BTC": { rate: 0.0001, interval: 28800 } },
    quotes: { "BTC": Q(100000, 2) },
    getMarkets: async () => [{ symbol: "BTC" }, { symbol: "ETH" }],
  });
  await fundTick({ liveEnabled: false }, st2, adL);
  assert.strictEqual(adL._calls.placeOrder.length, 0, "无对子不下单");
  assert.ok(st2.fund.lastScan && Array.isArray(st2.fund.lastScan.discover), "应有 discovery 扫描");
  assert.strictEqual(st2.fund.lastScan.discover[0].sym, "BTC", "扫描到 BTC 费率");
  assert.ok(logsOf(st2, /无配置对子/).length >= 1, "应提示无配置对子");
  // 10 分钟内不重复扫描
  const n1 = logsOf(st2, /费率扫描/).length;
  await fundTick({ liveEnabled: false }, st2, adL);
  assert.strictEqual(logsOf(st2, /费率扫描/).length, n1, "缓存期内不重复扫描");
}
/* ---------- fund: 17. fundPairsByVenue 自定义 ---------- */
async function t_fundCustomPairs() {
  const st = {};
  const ad = makeVenueMock("lighter", {
    funding: { "X": { rate: 0.01, interval: null }, "Y": { rate: 0.30, interval: null } },
    quotes: { "X": Q(100, 2), "Y": Q(100, 2) },
  });
  const cfg = { liveEnabled: false, fundPairsByVenue: { lighter: [{ a: "X", b: "Y" }] } };
  assert.strictEqual(fundCfg(cfg, "lighter").pairs.length, 1, "自定义对子生效");
  assert.strictEqual(fundCfg(cfg, "variational").pairs.length, 1, "不影响其他所");
  await fundTick(cfg, st, ad);
  assert.strictEqual(st.fund.lastScan.pairs.length, 1, "lastScan 记录自定义对子");
  assert.ok(Math.abs(st.fund.lastScan.pairs[0].edge - 0.29) < 1e-9, "edge=29%");
  assert.ok(logsOf(st, /PAPER 信号/).length >= 1, "应触发 PAPER 信号");
  assert.strictEqual(ad._calls.placeOrder.length, 0, "PAPER 零下单");
}

/* ---------- runner ---------- */
(async () => {
  const tests = [
    t_edgeDirection, t_swapSyntheticZero, t_annualize, t_paperNoOrders,
    t_liveOpen, t_exitOnEdgeDrop, t_basisBreach, t_fundingNullSkip, t_secondLegFail,
    t_xDirection, t_xPaperNoOrders, t_xSecondLegFail, t_xExit, t_xPosReadFail, t_xBasisBreach,
    t_fundPerVenue, t_fundCustomPairs,
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
