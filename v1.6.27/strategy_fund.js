"use strict";
/* v1.6.0: 资金费率套利策略 fund(单所)/xfund(跨所)。
 *
 * 费率约定: r>0 表示多头付钱给空头(与 venues/variational.js、venues/lighter.js 一致)。
 * 做多 X、做空 Y 的组合,年化 edge = rY - rX(做空高费率腿收钱,做多低费率腿付钱少)。
 *
 * fundTick(cfg, st, ad): 单所套利,首发跑 Variational。
 *   cfg.fundPairs 默认 [{a:"USOIL-SWAP", b:"CL-PERP"}]。
 * xfundTick(cfg, st, adA, adB): 跨所套利,首发 Variational x Lighter 的 BTC。
 *   cfg.xfundVenueA/B、cfg.xfundSymbol 默认 "BTC"(两所都接受 "BTC" 写法)。
 *
 * 费率口径(重要):
 *  - Variational getFunding 返回已年化小数,interval=null → 直接用。
 *  - Lighter getFunding 返回按 8h 计的原始费率,interval=28800 → 年化 = rate*31536000/interval。
 *    fundAnnualize 统一处理:interval 有效则按区间年化,否则视为已年化。
 *  - Variational 的 SWAP 市场无费率机制,getFunding 返回 null;约定 -SWAP 后缀市场按 0 计
 *    (有日志标注 synthetic)。注意:null 也可能是接口毛刺,此时若报价正常仍按 0 计,
 *    误判风险已在日志注明;非 SWAP 市场的 null 一律跳过不清仓。
 *
 * 持仓识别(重要,见 DEVIATIONS):
 *  - Variational getPositions 的 symbol 是 canonical underlying("USOIL"),不是市场名
 *    ("USOIL-SWAP");且别名匹配按长度+稳定排序,USOIL 的持仓可能被标成 "UKOIL"。
 *    因此腿识别不用精确 symbol,而用 symMatches 模糊匹配(去后缀后相等/包含/?)。
 *  - 以 st.fund/st.xfund 记录的开仓腿为准,每轮用 getPositions 做存活校验:
 *    两腿都消失→视为外部平仓,状态清零;单腿缺失→平掉剩余腿(绝不留裸腿)。
 *
 * PAPER 铁律:cfg.liveEnabled=false 时只计算 edge 并记日志,绝不调用
 * ad.placeOrder/ad.cancelOrder。clientId 前缀: fund- / xfund-。
 * 凭证绝不进日志:日志只含市场/方向/数量/费率,不含地址与 Key。
 *
 * 纯函数+async,不依赖 chrome.*。vatLog 由 strategy.js 提供(浏览器);node 测试需注入 globalThis.vatLog。
 */

const FUND_PAIR_DEFAULT = [{ a: "USOIL-SWAP", b: "CL-PERP" }]; // 兼容旧 cfg.fundPairs
/* v1.6.1:每个单所能开的对子不一样,按 venue 分开配置。用户可在 cfg.fundPairsByVenue 里覆盖。 */
const FUND_PAIRS_BY_VENUE = {
  variational: [{ a: "USOIL-SWAP", b: "CL-PERP" }],
};
const FUND = {
  entrySpread: 0.15,   // 年化 edge > 0.15 开仓
  exitSpread: 0.05,    // 年化 edge < 0.05 平仓
  notionalUsd: 500,    // 每腿名义(USD)
  maxBasisBps: 50,     // 基差上限(两市场 mark 偏离)
};
const XFUND = {
  venueA: "variational", venueB: "lighter", symbol: "BTC",
  entrySpread: 0.10, exitSpread: 0.03, notionalUsd: 500, maxBasisBps: 80,
};
const YEAR_S = 365 * 24 * 3600;

function _flog(st, tag, msg, level) {
  if (typeof vatLog === "function") vatLog(st, tag, msg, level || "muted");
}
function _fnum(x) {
  if (x === null || x === undefined || x === "") return null; // Number(null)===0,先拦截
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ---- 费率年化 ---- */
function fundAnnualize(f) {
  if (!f || typeof f !== "object") return null;
  const r = _fnum(f.rate);
  if (r === null) return null;
  const iv = _fnum(f.interval);
  if (iv !== null && iv > 0 && iv < YEAR_S) return { rate: r * YEAR_S / iv, interval: iv };
  return { rate: r, interval: f.interval ?? null }; // 已年化(如 Variational)
}

/* 取某市场年化费率 → {rate, synthetic?} | null。
 * synthetic: -SWAP 后缀且 getFunding 返回 null → 按 0 计(Variational SWAP 无费率机制)。 */
async function fundRate(ad, market) {
  let f = null;
  try { f = await ad.getFunding(market); } catch (e) { f = null; }
  const a = fundAnnualize(f);
  if (a) return a;
  if (/-SWAP$/i.test(String(market || ""))) {
    return { rate: 0, synthetic: true };
  }
  return null;
}

async function fundMark(ad, market) {
  const q = await ad.getQuote(market);
  return _quoteMark(q);
}
/* 从已取到的 quote 对象里拿 mark(取不到用 mid 兜底) */
function _quoteMark(q) {
  let m = _fnum(q && q.mark);
  if (!(m > 0) && q) {
    const b = _fnum(q.bid), a = _fnum(q.ask);
    if (b > 0 && a > 0) m = (b + a) / 2;
  }
  return (m > 0) ? m : null;
}

/* ---- 持仓腿存活校验 ---- */
function fundNormMarket(market) {
  return String(market || "").toUpperCase().replace(/-(SWAP|PERP)$/, "");
}
/* Variational 持仓 symbol 是 canonical underlying,别名匹配还有 UKOIL/USOIL 串味问题,
 * 故模糊匹配:相等、"?"、互相包含都算命中。 */
function fundSymMatches(market, posSymbol) {
  const n = fundNormMarket(market);
  const p = String(posSymbol || "").toUpperCase();
  if (!n || !p) return false;
  return p === n || p === "?" || n.includes(p) || p.includes(n);
}
function fundLegAlive(positions, market, side, qty) {
  const list = Array.isArray(positions) ? positions : [];
  const want = String(side).toLowerCase();
  return list.some((x) => {
    if (!x) return false;
    if (String(x.side).toLowerCase() !== want) return false;
    if (!fundSymMatches(market, x.symbol)) return false;
    const q = Math.abs(_fnum(x.qty) || 0);
    const w = Math.abs(_fnum(qty) || 0);
    if (!(w > 0)) return q === 0;
    return Math.abs(q - w) / w < 0.3;
  });
}

/* 市价单:Lighter 无原生市价单,走 IOC 限价模拟,必须带 price(最差可接受价)。 */
async function fundMarketOrder(ad, symbol, side, qty, quote, clientId, reduceOnly) {
  const o = { symbol, side, qty, type: "market", reduceOnly: !!reduceOnly, clientId };
  if (ad && ad.id === "lighter") {
    const ref = side === "buy" ? _fnum(quote && quote.ask) : _fnum(quote && quote.bid);
    if (!(ref > 0)) throw new Error("Lighter 腿无有效报价,放弃下单");
    o.price = ref * (side === "buy" ? 1.005 : 0.995);
  }
  return ad.placeOrder(o);
}

/* ---- 状态 ---- */
function fundState(st) {
  st.fund = st.fund || {};
  if (!st.fund.pos) st.fund.pos = {};
  if (st.fund._wait === undefined) st.fund._wait = {};
  return st.fund;
}
function xfundState(st) {
  st.xfund = st.xfund || {};
  if (st.xfund._wait === undefined) st.xfund._wait = {};
  return st.xfund;
}
function _waitLog(st, tag, store, key, msg) {
  if (store[key] !== msg) { store[key] = msg; _flog(st, tag, msg); }
}
function fundCfg(cfg, venueId) {
  const c = cfg || {};
  const byVenue = c.fundPairsByVenue;
  let pairs = null;
  if (byVenue && Array.isArray(byVenue[venueId]) && byVenue[venueId].length) pairs = byVenue[venueId];
  else if (Array.isArray(c.fundPairs) && c.fundPairs.length) pairs = c.fundPairs;
  else pairs = FUND_PAIRS_BY_VENUE[venueId] || [];
  return {
    pairs,
    entrySpread: _fnum(c.fundEntrySpread) ?? FUND.entrySpread,
    exitSpread: _fnum(c.fundExitSpread) ?? FUND.exitSpread,
    notionalUsd: _fnum(c.fundNotionalUsd) ?? FUND.notionalUsd,
    maxBasisBps: _fnum(c.fundMaxBasisBps) ?? FUND.maxBasisBps,
    live: !!c.liveEnabled,
  };
}
function xfundCfg(cfg) {
  const c = cfg || {};
  return {
    venueA: c.xfundVenueA || XFUND.venueA,
    venueB: c.xfundVenueB || XFUND.venueB,
    symbol: c.xfundSymbol || XFUND.symbol,
    entrySpread: _fnum(c.xfundEntrySpread) ?? XFUND.entrySpread,
    exitSpread: _fnum(c.xfundExitSpread) ?? XFUND.exitSpread,
    notionalUsd: _fnum(c.xfundNotionalUsd) ?? XFUND.notionalUsd,
    maxBasisBps: _fnum(c.xfundMaxBasisBps) ?? XFUND.maxBasisBps,
    live: !!c.liveEnabled,
  };
}
const _pct = (x) => (x * 100).toFixed(2) + "%";

/* ================= fund: 单所 ================= */
async function fundTick(cfg, st, ad) {
  if (!ad) throw new Error("单所费率套利需要交易所适配器");
  const venueId = ad.id || "?";
  const F = fundCfg(cfg, venueId);
  const sf = fundState(st);
  if (!F.pairs.length) {
    await _fundDiscover(st, sf, ad, venueId);
    return st;
  }
  const scanPairs = [];
  for (const pair of F.pairs) {
    if (!pair || !pair.a || !pair.b) continue;
    const key = pair.a + "|" + pair.b;
    try {
      const s = await _fundPairTick(st, sf, ad, pair, key, F);
      if (s) scanPairs.push(s);
    } catch (e) {
      _flog(st, "FUND", `[${pair.a}/${pair.b}] 本轮异常(${String((e && e.message) || e)}),保持仓位`, "err");
      scanPairs.push({ a: pair.a, b: pair.b, edge: null, dir: "", state: "error" });
    }
  }
  sf.lastScan = { t: Date.now(), venue: venueId, pairs: scanPairs };
  return st;
}

/* 该 venue 无配置对子时:只读扫描全市场费率(10 分钟缓存),告诉用户能开什么,不下单 */
async function _fundDiscover(st, sf, ad, venueId) {
  const tag = "FUND";
  const nowMs = Date.now();
  if (sf._discoverAt && nowMs - sf._discoverAt < 600000) return;
  sf._discoverAt = nowMs;
  let markets = [];
  try { markets = await ad.getMarkets(); }
  catch (e) {
    _flog(st, tag, `[${venueId}] 单所费率套利无配置对子,且市场列表读取失败,跳过`, "err");
    return;
  }
  const rows = [];
  for (const m of (markets || []).slice(0, 20)) {
    const sym = (m && (m.symbol || m.marketDisplayName)) || "";
    if (!sym) continue;
    let r = null;
    try { r = await fundRate(ad, sym); } catch (e) { r = null; }
    if (r && !r.synthetic) rows.push({ sym, rate: r.rate });
  }
  rows.sort((x, y) => Math.abs(y.rate) - Math.abs(x.rate));
  const top = rows.slice(0, 8);
  sf.lastScan = { t: nowMs, venue: venueId, pairs: [], discover: top };
  _flog(st, tag, `[${venueId}] 单所费率套利无配置对子。费率扫描(年化 Top8): ` +
    (top.length ? top.map((r) => `${r.sym} ${_pct(r.rate)}`).join(" | ") : "该所无可用费率数据") +
    `。可在 fundPairsByVenue.${venueId} 中添加对子`, "warn");
}

async function _fundPairTick(st, sf, ad, pair, key, F) {
  const tag = "FUND";
  const sum = { a: pair.a, b: pair.b, edge: null, dir: "", state: "" }; // v1.6.1:摘要给弹窗看
  const rA = await fundRate(ad, pair.a);
  const rB = await fundRate(ad, pair.b);
  if (!rA || !rB) {
    _waitLog(st, tag, sf._wait, key + ":norate",
      `[${pair.a}/${pair.b}] 费率缺失(${!rA ? pair.a : ""}${!rA && !rB ? "," : ""}${!rB ? pair.b : ""}),跳过不清仓`);
    sum.state = "norate";
    return sum;
  }
  if (rA.synthetic || rB.synthetic) {
    _waitLog(st, tag, sf._wait, key + ":synthetic",
      `[${pair.a}/${pair.b}] ${(rA.synthetic ? pair.a : pair.b)} 为 SWAP(无费率机制),按 0 计`);
  }
  const markA = await fundMark(ad, pair.a);
  const markB = await fundMark(ad, pair.b);
  if (!(markA > 0) || !(markB > 0)) {
    _waitLog(st, tag, sf._wait, key + ":noquote", `[${pair.a}/${pair.b}] 报价缺失,跳过`);
    sum.state = "noquote";
    return sum;
  }
  const edgeLongA = rB.rate - rA.rate; // long A short B
  const edgeLongB = rA.rate - rB.rate; // long B short A
  let pos = sf.pos[key] || null;

  /* 存活校验:以我方记录为准,用交易所持仓复核 */
  if (pos) {
    let positions = null;
    try { positions = await ad.getPositions(); } catch (e) { positions = null; }
    if (positions === null) {
      _waitLog(st, tag, sf._wait, key + ":posfail", `[${pair.a}/${pair.b}] 持仓读取失败,保持不清仓`);
      sum.state = "posfail";
      return sum;
    }
    const okA = fundLegAlive(positions, pos.a, pos.sideA, pos.qtyA);
    const okB = fundLegAlive(positions, pos.b, pos.sideB, pos.qtyB);
    if (!okA && !okB) {
      _flog(st, tag, `[${pair.a}/${pair.b}] 两腿持仓均消失(外部平仓?),状态清零`, "warn");
      delete sf.pos[key];
      pos = null;
    } else if (!okA || !okB) {
      _flog(st, tag, `[${pair.a}/${pair.b}] 单腿缺失(${(okA ? pair.b : pair.a)}),全平剩余腿防裸露`, "warn");
      await _fundCloseAll(st, ad, pos, key, tag);
      delete sf.pos[key];
      sum.state = "leglost";
      return sum;
    }
  }

  if (!pos) {
    const goLongA = edgeLongA >= edgeLongB;
    const edge = goLongA ? edgeLongA : edgeLongB;
    const longM = goLongA ? pair.a : pair.b;
    const shortM = goLongA ? pair.b : pair.a;
    if (edge <= F.entrySpread) {
      _waitLog(st, tag, sf._wait, key + ":wait",
        `[${pair.a}/${pair.b}] edge=${_pct(edge)}(long ${longM}),未达开仓线 ${_pct(F.entrySpread)}`);
      sum.edge = edge; sum.dir = longM; sum.state = "wait";
      return sum;
    }
    if (!F.live) {
      _flog(st, tag, `FUND PAPER 信号 long ${longM} short ${shortM} edge=${_pct(edge)} 名义 $${F.notionalUsd}/腿(仅信号,不下单)`, "ok");
      sum.edge = edge; sum.dir = longM; sum.state = "paper";
      return sum;
    }
    /* LIVE:先开 long 腿,再开 short 腿;第二腿失败则平掉第一腿,绝不留裸腿 */
    const qL = await ad.getQuote(longM), qS = await ad.getQuote(shortM);
    const qtyL = F.notionalUsd / (longM === pair.a ? markA : markB);
    const qtyS = F.notionalUsd / (shortM === pair.a ? markA : markB);
    if (!(qtyL > 0) || !(qtyS > 0)) throw new Error("数量计算无效");
    const cid = "fund-" + Date.now().toString(36);
    await fundMarketOrder(ad, longM, "buy", qtyL, qL, cid + "-L", false);
    try {
      await fundMarketOrder(ad, shortM, "sell", qtyS, qS, cid + "-S", false);
    } catch (e2) {
      _flog(st, tag, `第二腿开仓失败(${String((e2 && e2.message) || e2)}),平掉第一腿防裸露`, "err");
      try { await fundMarketOrder(ad, longM, "sell", qtyL, qL, cid + "-X", true); }
      catch (e3) { _flog(st, tag, `第一腿回平也失败,需人工处理 ${longM}`, "err"); }
      sum.edge = edge; sum.dir = longM; sum.state = "openfail";
      return sum;
    }
    sf.pos[key] = {
      a: pair.a, b: pair.b, longM, shortM,
      sideA: longM === pair.a ? "long" : "short",
      sideB: longM === pair.a ? "short" : "long",
      qtyA: longM === pair.a ? qtyL : qtyS,
      qtyB: longM === pair.a ? qtyS : qtyL,
      openedAt: Date.now(), openEdge: edge,
    };
    sf._wait[key + ":wait"] = "";
    _flog(st, tag, `LIVE 开仓 long ${longM} ${qtyL} / short ${shortM} ${qtyS} edge=${_pct(edge)}`, "ok");
    sum.edge = edge; sum.dir = longM; sum.state = "open";
    return sum;
  }

  /* 持有中 */
  const edge = pos.longM === pair.a ? (rB.rate - rA.rate) : (rA.rate - rB.rate);
  sum.edge = edge; sum.dir = pos.longM;
  if (edge < F.exitSpread) {
    _flog(st, tag, `[${pair.a}/${pair.b}] edge=${_pct(edge)} 跌破平仓线 ${_pct(F.exitSpread)},两腿全平`, "warn");
    await _fundCloseAll(st, ad, pos, key, tag);
    delete sf.pos[key];
    sum.state = "exit-edge";
    return sum;
  }
  const basis = Math.abs(markA - markB) / ((markA + markB) / 2);
  if (basis > F.maxBasisBps / 10000) {
    _flog(st, tag, `[${pair.a}/${pair.b}] 基差 ${(basis * 10000).toFixed(0)}bps 超限 ${F.maxBasisBps}bps,两腿全平`, "warn");
    await _fundCloseAll(st, ad, pos, key, tag);
    delete sf.pos[key];
    sum.state = "exit-basis";
    return sum;
  }
  _waitLog(st, tag, sf._wait, key + ":hold",
    `[${pair.a}/${pair.b}] 持有中 edge=${_pct(edge)} 基差 ${(basis * 10000).toFixed(0)}bps`);
  sum.state = "hold";
  return sum;
}

async function _fundCloseAll(st, ad, pos, key, tag) {
  const cid = "fund-" + Date.now().toString(36) + "-X";
  const qA = await ad.getQuote(pos.a).catch(() => null);
  const qB = await ad.getQuote(pos.b).catch(() => null);
  const legs = [
    { m: pos.a, side: pos.sideA === "long" ? "sell" : "buy", qty: pos.qtyA, q: qA },
    { m: pos.b, side: pos.sideB === "long" ? "sell" : "buy", qty: pos.qtyB, q: qB },
  ];
  for (const l of legs) {
    try { await fundMarketOrder(ad, l.m, l.side, l.qty, l.q, cid, true); }
    catch (e) { _flog(st, tag, `平仓失败 ${l.m} ${l.side}: ${String((e && e.message) || e)},需人工处理`, "err"); }
  }
  _flog(st, tag, `[${pos.a}/${pos.b}] 两腿已全平`, "ok");
}

/* ================= xfund: 跨所 ================= */
async function xfundTick(cfg, st, adA, adB) {
  const tag = "XFUND";
  if (!adA || !adB) throw new Error("跨所费率套利需要两个交易所适配器");
  const X = xfundCfg(cfg);
  const sx = xfundState(st);
  const symA = X.symbol, symB = X.symbol; // 两所都接受 "BTC" 写法(已核对 _normSymbol/parseSymbol)
  let rA = null, rB = null;
  try { rA = fundAnnualize(await adA.getFunding(symA)); } catch (e) { rA = null; }
  try { rB = fundAnnualize(await adB.getFunding(symB)); } catch (e) { rB = null; }
  if (!rA || !rB) {
    _waitLog(st, tag, sx._wait, "norate",
      `[${X.venueA}/${X.venueB} ${X.symbol}] 费率缺失(${!rA ? X.venueA : ""}${!rA && !rB ? "," : ""}${!rB ? X.venueB : ""}),跳过不清仓`);
    return st;
  }
  let markA = null, markB = null, qA = null, qB = null;
  try { qA = await adA.getQuote(symA); } catch (e) { qA = null; }
  try { qB = await adB.getQuote(symB); } catch (e) { qB = null; }
  markA = _quoteMark(qA); markB = _quoteMark(qB);
  if (!(markA > 0) || !(markB > 0)) {
    _waitLog(st, tag, sx._wait, "noquote", `[${X.venueA}/${X.venueB} ${X.symbol}] 报价缺失,跳过`);
    return st;
  }
  /* 方向:做多低费率所,做空高费率所;edge = 高 - 低 */
  const longIsA = rA.rate <= rB.rate;
  const edge = Math.abs(rB.rate - rA.rate);
  const longV = longIsA ? X.venueA : X.venueB;
  const shortV = longIsA ? X.venueB : X.venueA;
  let pos = sx.pos || null;

  /* 存活校验:两所各查各的腿 */
  if (pos) {
    let pA = null, pB = null, failA = false, failB = false;
    try { pA = await adA.getPositions(); } catch (e) { failA = true; }
    try { pB = await adB.getPositions(); } catch (e) { failB = true; }
    if (failA || failB) {
      _waitLog(st, tag, sx._wait, "posfail",
        `[${X.symbol}] ${(failA ? X.venueA : "")}${(failA && failB ? "," : "")}${(failB ? X.venueB : "")} 持仓读取失败,保持不清仓`);
      return st;
    }
    const longAd = longIsA ? adA : adB, shortAd = longIsA ? adB : adA;
    const longPos = longIsA ? pA : pB, shortPos = longIsA ? pB : pA;
    const okL = fundLegAlive(longPos, X.symbol, "long", pos.longQty);
    const okS = fundLegAlive(shortPos, X.symbol, "short", pos.shortQty);
    if (!okL && !okS) {
      _flog(st, tag, `[${X.symbol}] 两腿持仓均消失(外部平仓?),状态清零`, "warn");
      sx.pos = null; pos = null;
    } else if (!okL || !okS) {
      _flog(st, tag, `[${X.symbol}] 单腿缺失(${(okL ? shortV : longV)}),平掉剩余腿防裸露`, "warn");
      await _xfundCloseAll(st, sx, X, adA, adB, pos, qA, qB);
      sx.pos = null;
      return st;
    }
  }

  if (!pos) {
    if (edge <= X.entrySpread) {
      _waitLog(st, tag, sx._wait, "wait",
        `[${X.venueA}/${X.venueB} ${X.symbol}] edge=${_pct(edge)}(long ${longV}),未达开仓线 ${_pct(X.entrySpread)}`);
      return st;
    }
    if (!X.live) {
      _flog(st, tag, `XFUND PAPER 信号 long ${longV} short ${shortV} ${X.symbol} edge=${_pct(edge)} 名义 $${X.notionalUsd}/腿(仅信号,不下单)`, "ok");
      return st;
    }
    /* LIVE:先开 long 腿,再开 short 腿;第二腿失败→立即 reduceOnly 平掉第一腿 */
    const longAd = longIsA ? adA : adB, shortAd = longIsA ? adB : adA;
    const longQ = longIsA ? qA : qB, shortQ = longIsA ? qB : qA;
    const longMark = longIsA ? markA : markB, shortMark = longIsA ? markB : markA;
    const qtyL = X.notionalUsd / longMark, qtyS = X.notionalUsd / shortMark;
    if (!(qtyL > 0) || !(qtyS > 0)) throw new Error("数量计算无效");
    const cid = "xfund-" + Date.now().toString(36);
    await fundMarketOrder(longAd, X.symbol, "buy", qtyL, longQ, cid + "-L", false);
    try {
      await fundMarketOrder(shortAd, X.symbol, "sell", qtyS, shortQ, cid + "-S", false);
    } catch (e2) {
      _flog(st, tag, `第二腿(${shortV})开仓失败(${String((e2 && e2.message) || e2)}),平掉第一腿防裸露`, "err");
      try { await fundMarketOrder(longAd, X.symbol, "sell", qtyL, longQ, cid + "-X", true); }
      catch (e3) { _flog(st, tag, `第一腿(${longV})回平也失败,需人工处理`, "err"); }
      return st;
    }
    sx.pos = { longV, shortV, longQty: qtyL, shortQty: qtyS, openedAt: Date.now(), openEdge: edge };
    sx._wait["wait"] = "";
    _flog(st, tag, `LIVE 开仓 long ${longV} ${qtyL} ${X.symbol} / short ${shortV} ${qtyS} edge=${_pct(edge)}`, "ok");
    return st;
  }

  /* 持有中:按实际方向重算 edge */
  const curLongIsA = pos.longV === X.venueA;
  const curEdge = curLongIsA ? (rB.rate - rA.rate) : (rA.rate - rB.rate);
  if (curEdge < X.exitSpread) {
    _flog(st, tag, `[${X.symbol}] edge=${_pct(curEdge)} 跌破平仓线 ${_pct(X.exitSpread)},两所各平各的`, "warn");
    await _xfundCloseAll(st, sx, X, adA, adB, pos, qA, qB);
    sx.pos = null;
    return st;
  }
  const basis = Math.abs(markA - markB) / ((markA + markB) / 2);
  if (basis > X.maxBasisBps / 10000) {
    _flog(st, tag, `[${X.symbol}] 两所基差 ${(basis * 10000).toFixed(0)}bps 超限 ${X.maxBasisBps}bps,全平`, "warn");
    await _xfundCloseAll(st, sx, X, adA, adB, pos, qA, qB);
    sx.pos = null;
    return st;
  }
  _waitLog(st, tag, sx._wait, "hold",
    `[${X.symbol}] 持有中 long ${pos.longV}/short ${pos.shortV} edge=${_pct(curEdge)} 基差 ${(basis * 10000).toFixed(0)}bps`);
  return st;
}

async function _xfundCloseAll(st, sx, X, adA, adB, pos, qA, qB) {
  const tag = "XFUND";
  const cid = "xfund-" + Date.now().toString(36) + "-X";
  const legs = [
    { ad: pos.longV === X.venueA ? adA : adB, v: pos.longV, side: "sell", qty: pos.longQty, q: pos.longV === X.venueA ? qA : qB },
    { ad: pos.shortV === X.venueA ? adA : adB, v: pos.shortV, side: "buy", qty: pos.shortQty, q: pos.shortV === X.venueA ? qA : qB },
  ];
  for (const l of legs) {
    try { await fundMarketOrder(l.ad, X.symbol, l.side, l.qty, l.q, cid, true); }
    catch (e) { _flog(st, tag, `${l.v} 平仓失败(${l.side} ${X.symbol}): ${String((e && e.message) || e)},需人工处理`, "err"); }
  }
  _flog(st, tag, `[${X.symbol}] 两所腿已全平(long ${pos.longV}/short ${pos.shortV})`, "ok");
}

/* service worker 里 importScripts 加载后挂到 globalThis */
if (typeof globalThis !== "undefined") {
  globalThis.fundTick = fundTick;
  globalThis.xfundTick = xfundTick;
  globalThis.FundTest = {
    FUND, XFUND, FUND_PAIRS_BY_VENUE, fundAnnualize, fundRate, fundSymMatches, fundLegAlive,
    fundNormMarket, fundCfg, xfundCfg,
  };
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    fundTick, xfundTick,
    FundTest: {
      FUND, XFUND, FUND_PAIRS_BY_VENUE, fundAnnualize, fundRate, fundSymMatches, fundLegAlive,
      fundNormMarket, fundCfg, xfundCfg,
    },
  };
}
