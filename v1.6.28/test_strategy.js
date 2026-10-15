"use strict";
/* 策略引擎 mock 回归测试:信号→开仓→TP/SL/超时平仓→风控熔断→冷却→LIVE 路径 */
const S = require("./strategy.js");
const assert = (c, m) => { if (!c) { console.error("断言失败:", m); process.exit(1); } };

let now = 1_700_000_000_000;
let mockMark = 4115;
let spreadAbs = 0.2;
const calls = { placeMarketAuto: [], confirmRfq: 0 };

function quantizeDown(qtyStr, tickStr) {
  const q = Number(qtyStr), t = Number(tickStr);
  const v = Math.floor(q / t + 1e-9) * t;
  return String(Number(v.toFixed(10)));
}

const api = {
  now: () => now,
  sleep: async () => {},
  underlyingAliases: { XAU: ["XAUS"], XAG: ["XAGS"] },
  getRiskMark: async () => mockMark,
  prepareOrderQty: async (symbol, qty, side) => {
    const q = quantizeDown(String(qty), "0.00001");
    if (Number(q) < 0.00003) throw new Error(`数量 ${q} 低于最小下单量 0.00003`);
    return { qty: q, note: "", quote: { quoteId: "q-mock" } };
  },
  indicativeQuote: async (symbol, qty) => ({
    quoteId: "q-" + Math.random().toString(36).slice(2, 8),
    mark: mockMark,
    response: {
      bid: String(mockMark - spreadAbs / 2),
      ask: String(mockMark + spreadAbs / 2),
      mark_price: String(mockMark),
      qty_limits: { ask: { min_qty_tick: "0.00001", min_qty: "0.00003" }, bid: { min_qty_tick: "0.00001", min_qty: "0.00003" } },
      margin_requirements: {},
    },
  }),
  marginNeedFromQuote: () => 50,
  placeMarketAuto: async (symbol, side, qty, opts) => {
    calls.placeMarketAuto.push({ symbol, side, qty, opts });
    return { rfqId: "rfq-" + calls.placeMarketAuto.length, qty };
  },
  confirmRfq: async () => { calls.confirmRfq++; return { ok: true, status: "filled" }; },
};

function baseCfg(over = {}) {
  return { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], armed: true, liveEnabled: false, ...over };
}
/* 构造动量历史:now=T 时 d1≈+7bps,d5≈+36bps */
function seedMomentum(st) {
  const T = now;
  S.vatPushHist(st, "XAU", 4100, T - 360e3);
  S.vatPushHist(st, "XAU", 4100, T - 300e3);
  S.vatPushHist(st, "XAU", 4110, T - 120e3);
  S.vatPushHist(st, "XAU", 4112, T - 60e3);
}

(async () => {
  // 1) 预热
  {
    const st = S.vatBlankState(); st.date = S.vatDayNY(now);
    await S.vatProcessAsset(api, st, "XAU", baseCfg());
    assert(st.markets.XAU.status === "warming", "应预热中,实际:" + st.markets.XAU.status);
    console.log("1. 预热逻辑 ✅", st.markets.XAU.reason);
  }
  // 2) PAPER 信号开仓
  let st = S.vatBlankState(); st.date = S.vatDayNY(now);
  seedMomentum(st);
  await S.vatProcessAsset(api, st, "XAU", baseCfg());
  const pos = st.positions.XAU;
  assert(pos && pos.side === "buy" && pos.paper === true, "应 PAPER 开多,实际:" + JSON.stringify(pos));
  assert(calls.placeMarketAuto.length === 0, "PAPER 不应真实下单");
  assert(Math.abs(pos.entry - 4115.1) < 0.01, "入场应为 ask,实际:" + pos.entry);
  console.log(`2. PAPER 信号开仓 ✅ side=${pos.side} entry=${pos.entry} tp=${pos.tp.toFixed(2)} sl=${pos.sl.toFixed(2)}`);
  // 3) TP 平仓
  mockMark = 4145;
  now += 60e3;
  await S.vatProcessAsset(api, st, "XAU", baseCfg());
  assert(!st.positions.XAU, "TP 后应无持仓");
  assert(st.stats.wins === 1 && st.stats.pnl > 0, "胜场+盈利记账");
  console.log(`3. TP 平仓 ✅ pnl=+${st.stats.pnl.toFixed(2)}U wins=${st.stats.wins}`);
  // 4) 冷却期不重复开仓
  mockMark = 4115; now += 60e3;
  seedMomentum(st);
  await S.vatProcessAsset(api, st, "XAU", baseCfg());
  assert(st.markets.XAU.status === "cooldown", "冷却中不应开仓,实际:" + st.markets.XAU.status);
  console.log("4. 冷却期 ✅", st.markets.XAU.reason);
  // 5) SL 平仓记连亏
  now += 6 * 60e3; // 过冷却
  seedMomentum(st);
  await S.vatProcessAsset(api, st, "XAU", baseCfg());
  assert(st.positions.XAU, "应再次开仓");
  mockMark = 4090; now += 30e3; // 跌破 SL≈4099.5
  await S.vatProcessAsset(api, st, "XAU", baseCfg());
  assert(!st.positions.XAU && st.stats.losses === 1 && st.stats.consecutiveLosses === 1, "SL 平仓记亏");
  console.log(`5. SL 平仓 ✅ pnl=${st.stats.pnl.toFixed(2)}U 连亏=${st.stats.consecutiveLosses}`);
  // 6) 连续亏损熔断(v1.2.5 起只报警不拦单)
  st.stats.consecutiveLosses = 3;
  now += 6 * 60e3; mockMark = 4115; seedMomentum(st);
  await S.vatProcessAsset(api, st, "XAU", baseCfg());
  assert(st.positions.XAU && st.positions.XAU.paper === true, "熔断只报警,仍应开仓");
  assert(st.markets.XAU.status !== "loss_circuit", "不再有 loss_circuit 状态");
  assert(st.logs.some((x) => x.level === "warn" && /熔断告警/.test(x.msg)), "应记熔断告警");
  console.log("6. 连续亏损熔断(只报警不拦单) ✅");
  // 7) 超时平仓(volume 8分钟)
  {
    const st2 = S.vatBlankState(); st2.date = S.vatDayNY(now);
    const cfgV = baseCfg({ mode: "volume" });
    now += 6 * 60e3; mockMark = 4115; seedMomentum(st2);
    // volume 阈值:d1>=2,d5>=4(sp<=4):d1≈7.3✓ d5≈36✓ spread 0.49✓
    await S.vatProcessAsset(api, st2, "XAU", cfgV);
    assert(st2.positions.XAU, "volume 应开仓,实际:" + st2.markets.XAU.status + st2.markets.XAU.reason);
    now += 9 * 60e3; // 超 8 分钟
    await S.vatProcessAsset(api, st2, "XAU", cfgV);
    assert(!st2.positions.XAU, "超时应平仓");
    const lastLog = st2.logs[0].msg;
    assert(/TIMEOUT/.test(lastLog), "日志应记 TIMEOUT,实际:" + lastLog);
    console.log("7. 超时平仓 ✅");
  }
  // 8) LIVE 开仓+平仓走真实下单路径(含 reduceOnly)
  {
    const st3 = S.vatBlankState(); st3.date = S.vatDayNY(now);
    const cfgL = baseCfg({ liveEnabled: true });
    calls.placeMarketAuto.length = 0;
    now += 6 * 60e3; mockMark = 4115; seedMomentum(st3);
    await S.vatProcessAsset(api, st3, "XAU", cfgL);
    assert(st3.positions.XAU && st3.positions.XAU.paper === false, "LIVE 应记录实盘仓位");
    assert(calls.placeMarketAuto.length === 1, "LIVE 开仓应调 placeMarketAuto");
    const openCall = calls.placeMarketAuto[0];
    assert(openCall.side === "buy" && openCall.opts.reduceOnly === false, "开仓 side 小写 buy,非 reduceOnly");
    assert(openCall.opts.dryRun === false, "LIVE 必须 dryRun=false");
    // 平仓
    mockMark = 4145; now += 60e3;
    await S.vatProcessAsset(api, st3, "XAU", cfgL);
    assert(calls.placeMarketAuto.length === 2, "平仓应再调一次");
    const closeCall = calls.placeMarketAuto[1];
    assert(closeCall.side === "sell" && closeCall.opts.reduceOnly === true, "平仓 side=sell 且 reduceOnly");
    console.log("8. LIVE 开平仓路径 ✅ 开仓buy/平仓sell+reduceOnly,side 全小写");
  }
  // 9) 方向冲突无信号
  {
    const st4 = S.vatBlankState(); st4.date = S.vatDayNY(now);
    const T = now;
    S.vatPushHist(st4, "XAU", 4100, T - 300e3);
    S.vatPushHist(st4, "XAU", 4120, T - 60e3); // 1m 上涨
    mockMark = 4115; // 但 5m 相对 4100 上涨... 构造冲突:让 p5 高
    st4.history.XAU = [{ t: T - 300e3, p: 4130 }, { t: T - 60e3, p: 4112 }];
    await S.vatProcessAsset(api, st4, "XAU", baseCfg());
    assert(st4.markets.XAU.status === "no_signal" && /direction conflict/.test(st4.markets.XAU.reason),
      "方向冲突应无信号,实际:" + st4.markets.XAU.status + st4.markets.XAU.reason);
    console.log("9. 方向冲突拦截 ✅");
  }
  // 10) 日亏损熔断(v1.2.5 起只报警不拦单)
  {
    const st5 = S.vatBlankState(); st5.date = S.vatDayNY(now);
    st5.stats.pnl = -60; // equity1000*dailyLoss5%=50
    now += 6 * 60e3; mockMark = 4115; seedMomentum(st5);
    await S.vatProcessAsset(api, st5, "XAU", baseCfg());
    assert(st5.positions.XAU, "熔断只报警,仍应开仓");
    assert(st5.markets.XAU.status !== "daily_loss_limit", "不再有 daily_loss_limit 状态");
    assert(st5.logs.some((x) => x.level === "warn" && /熔断告警/.test(x.msg)), "应记熔断告警");
    console.log("10. 日亏损熔断(只报警不拦单) ✅");
  }
  console.log("\n全部 10 项策略回归通过 ✅");

  /* ============ Maker 模式回归 ============ */
  {
  let mNow = 1_700_000_000_000;
  let btcMark = 100000;
  const mcalls = { placeMakerOrder: [], placeMarketAuto: [], cancelled: [] };
  let mockPositions = [];
  const mapi = {
    now: () => mNow,
    sleep: async () => {},
    underlyingAliases: { BTC: ["BTCS", "BTC"], ETH: ["ETHS", "ETH"] },
    getRiskMark: async (u) => (String(u).startsWith("XAU") ? 4148.92 : btcMark),
    prepareOrderQty: async (symbol, qty) => {
      if (String(symbol).startsWith("XAU")) {
        const q = Math.floor(Number(qty) * 1e6) / 1e6; // 简单 tick 取整
        if (!(q > 0)) throw new Error("qty 过小");
        return { qty: String(q), note: "", quote: { quoteId: "q" } };
      }
      return { qty: "0.002", note: "", quote: { quoteId: "q" } };
    },
    indicativeQuote: async (symbol) => {
      if (String(symbol).startsWith("TWI")) throw new Error("休市无报价");
      const mk = String(symbol).startsWith("XAU") ? 4148.92 : btcMark;
      return {
        quoteId: "q1", mark: mk,
        response: { bid: String(mk * 0.9999), ask: String(mk * 1.0001), mark_price: String(mk), margin_requirements: {} },
      };
    },
    marginNeedFromQuote: () => 50,
    placeMakerOrder: async (symbol, side, qty, price, opts) => {
      mcalls.placeMakerOrder.push({ symbol, side, qty, price, opts });
      return { orderId: "m" + mcalls.placeMakerOrder.length, qty };
    },
    cancelOrder: async (id) => { mcalls.cancelled.push(id); return true; },
    getPositions: async () => mockPositions,
    positionQtyFor: (rows, symbol) => {
      const u = String(symbol).split("-")[0];
      for (const p of rows) {
        if (JSON.stringify(p).includes(u)) {
          const info = p.position_info || p;
          const q = info.qty ?? info.quantity ?? info.size;
          if (q != null) return Number(q);
        }
      }
      return 0;
    },
    placeMarketAuto: async (symbol, side, qty, opts) => {
      mcalls.placeMarketAuto.push({ symbol, side, qty, opts });
      return { rfqId: "rfq-m" + mcalls.placeMarketAuto.length, qty };
    },
    confirmRfq: async () => ({ ok: true, status: "filled" }),
  };
  const mCfg = (over = {}) => ({
    ...S.VAT_DEFAULT_CONFIG, mode: "maker", makerAssets: ["BTC"], armed: true,
    liveEnabled: false, makerMinDelay: 30, makerMaxDelay: 60, ...over,
  });
  const newSt = () => { const s = S.vatBlankState(); s.date = S.vatDayNY(mNow); return s; };

  // 11) PAPER 首单立即成交建仓
  {
    const st = newSt();
    await S.vatTick(mCfg(), st, mapi);
    const pos = st.positions.BTC;
    assert(pos && pos.maker === true && pos.paper === true && pos.side === "buy",
      "PAPER 应建 maker 多仓,实际:" + JSON.stringify(pos));
    assert(st.stats.turnover > 0, "成交额应记账");
    assert(S.vatMakerState(st).nextAt > mNow, "应排好下一次挂单时间");
    console.log(`11. PAPER Maker 建仓 ✅ side=${pos.side} entry=${pos.entry} turnover=${st.stats.turnover.toFixed(0)}U`);
  }
  // 12) 超时平仓(TIMEOUT)+记账(平掉旧仓后若到挂单时间会开新仓,属正常)
  {
    const st = newSt();
    await S.vatTick(mCfg(), st, mapi);
    assert(st.positions.BTC, "应先有仓位");
    mNow += 130e3; // 超 makerMaxHoldSecs=120
    btcMark = 100050;
    await S.vatTick(mCfg(), st, mapi);
    assert(st.stats.trades === 1, "旧仓应平仓记1笔");
    assert(st.logs.some((x) => /TIMEOUT/.test(x.msg)), "日志应记 TIMEOUT");
    console.log(`12. Maker 超时平仓 ✅ pnl=${st.stats.pnl.toFixed(2)}U`);
  }
  // 13) 波动过滤跳过
  {
    const st = newSt();
    const T = mNow;
    S.vatPushHist(st, "BTC", 100000, T - 60e3);
    btcMark = 100500; // 1m +50bps > 30bps 阈值
    const n0 = mcalls.placeMakerOrder.length;
    await S.vatTick(mCfg(), st, mapi);
    assert(mcalls.placeMakerOrder.length === n0, "波动超阈不应挂单");
    assert(st.markets.BTC.status === "maker_vol_skip", "应标记波动跳过,实际:" + st.markets.BTC.status);
    console.log("13. 波动过滤 ✅", st.markets.BTC.reason);
    btcMark = 100000;
  }
  // 14) LIVE 挂单→超时未成交→撤单
  {
    const st = newSt();
    mockPositions = [];
    const n0 = mcalls.placeMakerOrder.length;
    await S.vatTick(mCfg({ liveEnabled: true }), st, mapi);
    assert(mcalls.placeMakerOrder.length === n0 + 1, "LIVE 应真实挂单");
    const pend = S.vatMakerState(st).pending;
    assert(pend && pend.orderId === "m" + mcalls.placeMakerOrder.length, "应有 pending");
    const o = mcalls.placeMakerOrder[mcalls.placeMakerOrder.length - 1];
    assert(o.side === "buy" && o.symbol === "BTCS-SWAP", "首单交替方向=buy, symbol 解析对");
    assert(Math.abs(o.price - btcMark * 0.9999 * (1 - 0.0001)) < 1, "买单限价=bid-1bp,实际:" + o.price);
    mNow += 65e3; // 超 monitorSecs=60,无成交
    await S.vatTick(mCfg({ liveEnabled: true }), st, mapi);
    assert(mcalls.cancelled.includes(pend.orderId), "超时应撤单");
    assert(!S.vatMakerState(st).pending, "pending 应清除");
    console.log("14. LIVE 超时撤单 ✅ orderId=" + pend.orderId);
  }
  // 15) LIVE 挂单→成交→建仓
  {
    const st = newSt();
    mockPositions = [];
    await S.vatTick(mCfg({ liveEnabled: true }), st, mapi);
    const pend = S.vatMakerState(st).pending;
    assert(pend, "应有 pending");
    mockPositions = [{ position_info: { qty: "0.002" }, instrument: { underlying: "BTCS" } }];
    mNow += 10e3;
    await S.vatTick(mCfg({ liveEnabled: true }), st, mapi);
    const pos = st.positions.BTC;
    assert(pos && pos.maker === true && pos.paper === false, "成交后应建 LIVE 仓");
    assert(Math.abs(Number(pos.qty) - 0.002) < 1e-9, "数量应为成交量");
    console.log(`15. LIVE 成交建仓 ✅ qty=${pos.qty} entry=${pos.entry}`);
    mockPositions = [];
  }
  // 16) Maker 平仓走 reduce-only 市价单
  {
    const st = newSt();
    const pos = { asset: "BTC", side: "buy", qty: "0.002", entry: 100000, tp: 110000, sl: 95000,
      opened: mNow, notional: 200, paper: false, maker: true, symbol: "BTCS-SWAP", underlying: "BTCS", kind: "swap" };
    st.positions.BTC = pos;
    mockPositions = [{ position_info: { qty: "0.002" }, instrument: { underlying: "BTCS" } }]; // v1.2.4:实盘平仓前先对链上仓位
    const n0 = mcalls.placeMarketAuto.length;
    await S.vatClosePosition(mapi, st, "BTC", pos, mCfg({ liveEnabled: true }), "TIMEOUT", 100050);
    assert(mcalls.placeMarketAuto.length === n0 + 1, "应调平仓");
    const c = mcalls.placeMarketAuto[mcalls.placeMarketAuto.length - 1];
    assert(c.side === "sell" && c.opts.reduceOnly === true, "平仓 sell + reduceOnly");
    assert(c.symbol === "BTCS-SWAP", "用解析后的 symbol,实际:" + c.symbol);
    console.log("16. Maker reduce-only 平仓 ✅");
  }
  // 17) 风控闸:连续亏损熔断只报警不拦单(v1.2.5)
  {
    const st = newSt();
    st.stats.consecutiveLosses = 3;
    const n0 = mcalls.placeMakerOrder.length;
    await S.vatTick(mCfg({ liveEnabled: true }), st, mapi);
    assert(mcalls.placeMakerOrder.length === n0 + 1, "熔断只报警,仍应挂单");
    assert(st.logs.some((x) => x.level === "warn" && /熔断告警/.test(x.msg)), "应记熔断告警");
    console.log("17. Maker 熔断只报警不拦单 ✅");
  }
  // 18) TradFi 按 USDC 名义换算 qty(XAU)
  {
    const st = newSt();
    const c = mCfg({ makerAssets: ["XAU"], makerSizes: {}, makerNotionals: { XAU: [10, 30] } });
    await S.vatTick(c, st, mapi);
    const pos = st.positions.XAU;
    assert(pos && pos.maker === true, "XAU 应建仓");
    const notion = Number(pos.qty) * 4148.92;
    assert(notion >= 9.9 && notion <= 30.1, `名义应在[10,30]U,实际${notion.toFixed(2)}U qty=${pos.qty}`);
    assert(pos.symbol === "XAU-SWAP", "symbol 应为 XAU-SWAP,实际:" + pos.symbol);
    console.log(`18. XAU 名义换算 ✅ qty=${pos.qty} 名义=${notion.toFixed(2)}U`);
  }
  // 19) 没配 size/名义的标的不进交易轮转
  {
    const st = newSt();
    const c = mCfg({ makerAssets: ["BTC", "XAU"], makerSizes: { BTC: [0.001, 0.003] }, makerNotionals: {} });
    const uni = S.vatMakerUniverse(c);
    assert(uni.length === 1 && uni[0] === "BTC", "universe 应只有 BTC,实际:" + JSON.stringify(uni));
    await S.vatTick(c, st, mapi);
    assert(st.positions.BTC && !st.positions.XAU, "只应交易 BTC");
    console.log("19. Universe 过滤 ✅");
  }
  // 20) 休市无报价 → 长退避,不刷日志空转
  {
    const st = newSt();
    const c = mCfg({ makerAssets: ["TWI"], makerSizes: {}, makerNotionals: { TWI: [10, 30] }, liveEnabled: false });
    const t0 = mNow;
    await S.vatTick(c, st, mapi);
    assert(st.markets.TWI.status === "no_quote", "应标记无报价,实际:" + st.markets.TWI.status);
    const wait = (S.vatMakerState(st).nextAt - t0) / 1000;
    assert(wait >= 60, `退避应>=60s,实际${wait}s`);
    assert(!st.positions.TWI, "休市不应建仓");
    console.log(`20. 休市退避 ✅ ${Math.round(wait)}s 后重试`);
  }
  // 21) 限价取整方向:买向下不穿 bid,卖向上不穿 ask
  {
    assert(S.vatDecimals("4158.65") === 2, "小数位识别");
    assert(S.vatDecimals("100") === 0, "整数0位");
    const b = S.vatTickPrice(4158.65 * 0.9999, 2, "buy");
    assert(b <= 4158.65 && b === 4158.23, `买应向下取整,实际${b}`);
    const s = S.vatTickPrice(4159.07 * 1.0001, 2, "sell");
    assert(s >= 4159.07 && s === 4159.49, `卖应向上取整,实际${s}`);
    console.log("21. 限价取整方向 ✅");
  }
  console.log("\nMaker 模式 10 项回归通过 ✅");
  }
})();
