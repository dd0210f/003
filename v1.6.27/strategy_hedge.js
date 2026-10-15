"use strict";
/* v1.6.19:对冲策略 hedge 模式通用化:对子/杠杆走配置 hedgeResolvePair(cfg),不再限定 Arcus。
 * 各所默认:arcus=BTC-USD/ETH-USD 40x/25x,variational=BTC/ETH 10x/10x,qfex=GOLD-USD/SILVER-USD 10x/10x。
 * 要求适配器实现 getCandles(symbol,"5m",50);verifyLeverage 缺失时只告警跳过。
 * Variational 的 5m K线由插件 mark 推送合成(需运行约 4.5h 积累);QFEX 走 REST 1MIN 聚合(实测)。
 * v1.4.0: BTC/ETH 对冲策略 hedge 模式(移植自第三方机器人 bot.py 的 hedge 路径,hedge_enabled=true)。
 * 源文件: ~/workspace/user/files/arcus-bot-share-001.zip 内 bot.py,行号对照均为该文件。
 *
 * 信号 evaluate_hedge(bot.py 1878):BTC 5m 已收盘K线→RSI(12);rsi<45 做多,>55 做空;45~55 无信号。
 *   每根 5m K线只发一次信号(ledger.lastSignalBar 去重,bot.py 646);有持仓或有未完成首仓单时不发新信号。
 * 开仓 tick(bot.py 2420~2440):价差 (ask-bid)/mid*10000<=10bps;两市场 verify_leverage(BTC 40x/ETH 25x/CROSS,
 *   bot.py 1275);信号到下单价格偏离<=1%;BTC 限价 mid*(1∓0.0005) 且必须挂在盘口外侧(BUY<bid/SELL>ask),
 *   tif=ALO;数量=floor(权益*5.0/price,stepSize);首仓 300s 未成交则撤单中止(bot.py 2409)。
 * 对冲 hedge_tick(bot.py 2244):BTC 有成交后,ETH 缺口=btc名义-eth已对冲名义,方向与 BTC 反向;
 *   数量=floor(min(缺口/可执行价,maxOrderSize),stepSize),须>=minOrderSize 且名义>=minOrderNotional;
 *   IOC 限价吃单(exit_limit:BUY 按 ask*(1+滑点)/SELL 按 bid*(1-滑点),滑点上限 15bps,
 *   价格不可成交则抛错,bot.py 856)。
 * 止盈 tp_tick(bot.py 2252):每腿挂 resting reduce-only 限价单,long=entry*1.008/short=entry*0.992,tif=ALO。
 * 止损/异常(bot.py 2404~2413):任一腿 pnl<=-15% → 全平;ETH 有仓但 BTC 无仓、或两腿同向 → 全平。
 * flatten_all(bot.py 2283):先撤所有本轮挂单,再两腿 IOC reduce-only 吃单全平,周期清零,cooldown 60s。
 * 日内风控:日累计亏损>=50U 则 halt 当天(简化实现:flatten 时按周期估算 PnL 累计,见 DEVIATIONS)。
 * PAPER 铁律:cfg.liveEnabled=false 时只计算信号并记日志,绝不调用 ad.placeOrder/ad.cancelOrder。
 * clientId 格式:hedge-<cycleId>-<role>(role: E 首仓/H 对冲/T 止盈/X 平仓)。
 * 凭证绝不进日志:日志只含标的/方向/数量/价格/RSSI,不含地址与 Key。
 *
 * 与原版的差异(DEVIATIONS,逐条):
 *  1. 无 WS 订单推送:成交感知靠每轮 getPositions() 轮询对账(原版 WS 即时 + REST 对账)。
 *  2. 无跨进程 runtime 文件:状态放 chrome.storage 的 state.hedge,随插件状态持久化。
 *  3. 日亏损为简化累计(flatten 时估算周期 PnL),非原版逐笔 realized 跟踪。
 *  4. 无网格模块(原版 hedge 路径下 grid_enabled=false,本来也不启用)。
 *  5. check_budget 简化为名义/保证金上限检查(阈值与原版一致:单标的 20x/账户 20x/保证金 50%/可用-10U)。
 *  6. 日期按本地时区日切(原版用服务器时间)。
 *
 * 纯函数+async,不依赖 chrome.*。vatLog 由 strategy.js 提供(浏览器);node 测试需注入 globalThis.vatLog。
 */

const HEDGE_PAIR = ["BTC-USD", "ETH-USD"]; // v1.6.19:保留作 Arcus 默认,实际对子走 hedgeResolvePair(cfg)
/* v1.6.19:各所默认对子。A腿=信号腿(跑 5m RSI),B腿=对冲腿(等名义反向)。
 * 用户在 Hedge 参数区可覆盖任意两腿代号与杠杆。 */
const HEDGE_VENUE_DEFAULTS = {
  arcus:      { symA: "BTC-USD",  symB: "ETH-USD",   levA: 40, levB: 25 },
  variational:{ symA: "BTC",      symB: "ETH",       levA: 10, levB: 10 },
  qfex:       { symA: "GOLD-USD", symB: "SILVER-USD",levA: 10, levB: 10 },
};
function hedgeResolvePair(cfg) {
  const venue = String((cfg && cfg.activeVenue) || "arcus").toLowerCase();
  const d = HEDGE_VENUE_DEFAULTS[venue] || HEDGE_VENUE_DEFAULTS.arcus;
  const symA = String((cfg && cfg.hedgeSymA) || "").trim().toUpperCase() || d.symA;
  const symB = String((cfg && cfg.hedgeSymB) || "").trim().toUpperCase() || d.symB;
  const levA = Number(cfg && cfg.hedgeLevA) > 0 ? Number(cfg.hedgeLevA) : d.levA;
  const levB = Number(cfg && cfg.hedgeLevB) > 0 ? Number(cfg.hedgeLevB) : d.levB;
  return { symA, symB, levA, levB, venue };
}
const HEDGE = {
  rsiPeriod: 12, rsiLong: 45, rsiShort: 55, barSec: 300,
  tpPct: 0.008, slPct: 0.15,
  btcLev: 40, ethLev: 25, marginMode: "CROSS", // v1.6.19:保留兼容,实际走 hedgeResolvePair
  firstOrderSize: 5.0,          // 每腿名义 = 权益 × 5.0
  entryOffsetPct: 0.0005,       // 首仓挂单相对 mid 的偏移
  maxSpreadBps: 10,             // 开仓价差上限
  maxSlippageBps: 15,           // 吃单滑点上限
  maxSignalDevPct: 0.01,        // 信号到下单价格偏离上限
  entryTimeoutSec: 300,         // 首仓未成交超时
  cooldownSec: 60,              // 周期结束冷却
  maxDailyLossUsd: 50,          // 日内亏损上限
  maxSymbolEquityPct: 20.0, maxAccountEquityPct: 20.0,
  maxMarginEquityPct: 0.5, minFreeCollateralUsd: 10,
};

function _hedgeLog(st, msg, level) {
  if (typeof vatLog === "function") vatLog(st, "HEDGE", msg, level || "muted");
}

/* ---- RSI:照抄 bot.py calc_rsi(564行),Wilder 标准 ---- */
function hedgeRsi(closes, period) {
  const values = (closes || []).map(Number).filter((x) => x > 0);
  if (values.length < period + 1) return null;
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);
  if (!deltas.length) return null;
  const ep = Math.max(1, Math.min(period || 14, deltas.length));
  let avgG = 0, avgL = 0;
  for (let i = 0; i < ep; i++) { avgG += Math.max(deltas[i], 0); avgL += Math.max(-deltas[i], 0); }
  avgG /= ep; avgL /= ep;
  for (let i = ep; i < deltas.length; i++) {
    avgG = (avgG * (ep - 1) + Math.max(deltas[i], 0)) / ep;
    avgL = (avgL * (ep - 1) + Math.max(-deltas[i], 0)) / ep;
  }
  if (avgL <= 0) return avgG > 0 ? 100 : 50;
  return 100 - 100 / (1 + avgG / avgL);
}

/* ---- 已收盘K线校验:照抄 bot.py closed_rows(621行) ----
 * candles: [{time(秒),open,high,low,close,isFinal}];只保留 isFinal 且已收盘的根。 */
function hedgeClosedRows(candles, nowSec) {
  const rows = [];
  for (const r of candles || []) {
    const t = Number(r.time);
    // v1.5.1:isFinal 缺失时用收盘时间兜底(部分 API 不返回该字段);明确 false 的才排除。
    // 时间检查本身已保证只收已收盘的根(t+300<=now)。
    if (r.isFinal === false || !(t + HEDGE.barSec <= nowSec)) continue;
    const v = { open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) };
    if (![v.open, v.high, v.low, v.close].every((x) => Number.isFinite(x) && x > 0)) throw new Error("K线价格无效");
    if (v.low > Math.min(v.open, v.close) || v.high < Math.max(v.open, v.close)) throw new Error("K线高低价无效");
    if (t % HEDGE.barSec !== 0) throw new Error("K线时间未对齐");
    rows.push({ time: t, open: v.open, high: v.high, low: v.low, close: v.close });
  }
  rows.sort((a, b) => a.time - b.time);
  if (rows.length < HEDGE.rsiPeriod + 1) throw new Error("已收盘K线不足");
  if (rows[rows.length - 1].time !== Math.floor(nowSec / HEDGE.barSec) * HEDGE.barSec - HEDGE.barSec)
    throw new Error("最新已收盘K线缺失或过期");
  for (let i = 1; i < rows.length; i++)
    if (rows[i].time - rows[i - 1].time !== HEDGE.barSec) throw new Error("K线缺失或重复");
  return rows;
}

/* ---- 信号:照抄 bot.py evaluate_hedge(1878行) 的核心 ---- */
function hedgeSignal(rows, ledger) {
  const rsi = hedgeRsi(rows.map((r) => r.close), HEDGE.rsiPeriod);
  if (rsi == null) return { signal: false, rsi: null, reason: "RSI 数据不足" };
  const longS = rsi < HEDGE.rsiLong, shortS = rsi > HEDGE.rsiShort;
  const side = longS ? "LONG" : shortS ? "SHORT" : "";
  const bar = rows[rows.length - 1].time;
  if (!side) return { signal: false, rsi, reason: "RSI 位于 45~55 中性区间" };
  const last = ledger && ledger.lastSignalBar;
  if (typeof last === "number" && bar <= last) return { signal: false, rsi, reason: "本根 5m K线已使用" };
  return { signal: true, side, rsi, bar };
}

/* ---- 数值工具 ---- */
function _dp(x) { const s = String(x).split(".")[1]; return s ? s.length : 0; }
function hedgeFloorStep(qty, step) {           // 向下取整到 step 倍数(对标 bot.py floor_step)
  const s = Number(step);
  if (!(Number(qty) > 0) || !(s > 0)) return 0;
  const n = Math.floor(Number(qty) / s + 1e-9);
  return Number((n * s).toFixed(Math.max(_dp(step), 0)));
}
function hedgeSnapTick(price, tickSize, side) { // 对标 bot.py bounded_price:向内取整(BUY 向下/SELL 向上)
  const t = Number(tickSize);
  if (!(Number(price) > 0) || !(t > 0)) throw new Error("价格/档位无效");
  const dp = Math.max(_dp(tickSize), 0);
  const n = side === "buy"
    ? Math.floor(Number(price) / t + 1e-9)
    : Math.ceil(Number(price) / t - 1e-9);
  const out = Number((n * t).toFixed(dp));
  if (!(out > 0)) throw new Error("限价无效");
  return out;
}
/* 对标 bot.py exit_limit(856行):吃单限价,滑点上限 15bps,不可成交则抛错 */
function hedgeExitLimit(quote, side, tickSize) {
  const ref = side === "buy" ? Number(quote.ask) : Number(quote.bid);
  const raw = ref * (1 + (HEDGE.maxSlippageBps / 10000) * (side === "buy" ? 1 : -1));
  const price = hedgeSnapTick(raw, tickSize, side);
  if ((side === "buy" && price < Number(quote.ask)) || (side === "sell" && price > Number(quote.bid)))
    throw new Error("价格档位无法满足平仓滑点上限");
  return price;
}
/* 止盈目标价:long=entry*1.008 / short=entry*0.992(对标 bot.py tp_target) */
function hedgeTpTarget(entry, isLong, tickSize) {
  const raw = Number(entry) * (isLong ? 1 + HEDGE.tpPct : 1 - HEDGE.tpPct);
  return hedgeSnapTick(raw, tickSize, isLong ? "sell" : "buy");
}

/* ---- 状态(挂在 st.hedge,随插件状态持久化) ---- */
function hedgeDay() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function hedgeGetState(st) {
  st.hedge = st.hedge || {};
  const h = st.hedge;
  if (!h.ledger) h.ledger = { lastSignalBar: 0 };
  if (h.cooldownUntil == null) h.cooldownUntil = 0;
  if (!h.day) { h.day = hedgeDay(); h.dailyLoss = 0; h.halted = false; }
  if (!h.orders) h.orders = {};
  if (h._waitReason === undefined) h._waitReason = "";
  return h;
}
function _waitLog(st, h, reason, detail) {
  if (h._waitReason !== reason) {
    h._waitReason = reason;
    _hedgeLog(st, "[WAIT] " + reason + (detail ? " | " + detail : ""));
  }
}
function _posQty(positions, symbol) {          // 带符号数量:long 为正,short 为负
  const p = (positions || []).find((x) => x && x.symbol === symbol);
  if (!p) return 0;
  const q = Math.abs(Number(p.qty) || 0);
  return String(p.side).toLowerCase() === "short" ? -q : q;
}
function _posEntry(positions, symbol) {
  const p = (positions || []).find((x) => x && x.symbol === symbol);
  return p && p.entryPrice != null ? Number(p.entryPrice) : 0;
}
async function _markets(ad, pair) {
  const list = await ad.getMarkets();
  const m = {};
  for (const s of pair) {
    const hit = (list || []).find((x) => x && x.symbol === s);
    if (!hit) throw new Error("未找到市场: " + s);
    m[s] = hit;
  }
  return m;
}

/* ---- 全平:对标 bot.py flatten_all(2283行) ----
 * 先撤所有本轮挂单,再两腿 IOC reduce-only 吃单全平,周期清零,cooldown 60s。 */
async function hedgeFlatten(ad, st, h, mkts, pair, reason) {
  const cyc = h.cycle || {};
  _hedgeLog(st, "全平开始(" + reason + ")", "warn");
  for (const key of Object.keys(h.orders)) {
    const o = h.orders[key];
    try {
      if (o.orderId) await ad.cancelOrder(o.orderId, { symbol: o.symbol });
      else if (o.clientId) await ad.cancelOrder(null, { clientId: o.clientId, symbol: o.symbol });
    } catch (e) { /* 撤单失败不阻断,继续平仓 */ }
  }
  h.orders = {};
  let positions = [];
  try { positions = await ad.getPositions(); } catch (e) { positions = []; }
  let cyclePnl = 0;
  for (const s of pair) {
    const qty = _posQty(positions, s);
    if (!qty) continue;
    const m = mkts[s];
    const q = await ad.getQuote(s);
    const side = qty > 0 ? "sell" : "buy";
    const entry = _posEntry(positions, s);
    const exitRef = side === "sell" ? Number(q.bid) : Number(q.ask);
    if (entry > 0) cyclePnl += (exitRef - entry) * qty; // 估算(多空符号已含在 qty 中)
    let rest = Math.abs(qty);
    let guard = 0;
    while (rest > 0 && guard++ < 20) {
      const amount = hedgeFloorStep(Math.min(rest, Number(m.maxOrderSize)), m.stepSize);
      if (!(amount > 0)) break;
      const px = hedgeExitLimit(q, side, m.tickSize);
      await ad.placeOrder({
        symbol: s, side, qty: amount, price: px,
        timeInForce: "IOC", reduceOnly: true,
        clientId: "hedge-" + (cyc.id || "x") + "-X",
      });
      rest -= amount;
    }
  }
  h.dailyLoss = (h.dailyLoss || 0) + cyclePnl;
  _hedgeLog(st, "全平完成(" + reason + ") 周期估算PnL " +
    (cyclePnl >= 0 ? "+" : "") + cyclePnl.toFixed(2) + "U,今日累计 " +
    (h.dailyLoss >= 0 ? "+" : "") + h.dailyLoss.toFixed(2) + "U", cyclePnl >= 0 ? "ok" : "warn");
  h.cycle = null;
  h.cooldownUntil = Date.now() + HEDGE.cooldownSec * 1000;
  h._waitReason = "";
  if (h.dailyLoss <= -HEDGE.maxDailyLossUsd) {
    h.halted = true;
    _hedgeLog(st, "日内亏损达上限(累计 " + h.dailyLoss.toFixed(2) + "U),今日停止", "err");
  }
}

/* ---- 主入口:每 tick 调用一次,返回 st(已变更) ----
 * cfg: {liveEnabled, activeVenue, hedgeSymA, hedgeSymB, hedgeLevA, hedgeLevB};
 * st: 插件 state(用 st.hedge 存状态); ad: 任一 venue 适配器(需 getCandles)。 */
async function hedgeTick(cfg, st, ad) {
  // v1.6.19:对子通用化,不再限定 Arcus;要求适配器提供 5m K线(getCandles)。
  // verifyLeverage 缺失时只告警跳过(如 Variational 网页端预设,API 无法校验)。
  const hp = hedgeResolvePair(cfg);
  const pair = [hp.symA, hp.symB];
  if (!ad || typeof ad.getCandles !== "function")
    throw new Error("对冲模式需要适配器提供 getCandles(5m K线),当前所 " + hp.venue + " 不支持");
  const canVerifyLev = ad && typeof ad.verifyLeverage === "function";
  const h = hedgeGetState(st);
  const nowMs = Date.now(), nowSec = Math.floor(nowMs / 1000);
  const live = !!cfg.liveEnabled;
  // 日切
  const day = hedgeDay();
  if (h.day !== day) { h.day = day; h.dailyLoss = 0; h.halted = false; }
  if (h.halted) { _waitLog(st, h, "DAILY_HALTED", "今日累计 " + Number(h.dailyLoss).toFixed(2) + "U"); return st; }

  let mkts;
  try { mkts = await _markets(ad, pair); }
  catch (e) { _hedgeLog(st, "读市场失败: " + String((e && e.message) || e), "err"); return st; }
  let positions = [];
  try { positions = await ad.getPositions(); }
  catch (e) { _hedgeLog(st, "读持仓失败: " + String((e && e.message) || e), "err"); return st; }
  let bal = { equity: 0, available: 0 };
  try { bal = await ad.getBalance() || bal; } catch (e) { /* 余额读不到则用 0,下单前再校验 */ }
  const equity = Number(bal.equity) || 0;

  const qtyA = _posQty(positions, hp.symA); // v1.6.19:A腿(原 BTC)
  const qtyB = _posQty(positions, hp.symB); // v1.6.19:B腿(原 ETH)

  /* ============ 有周期:管理 ============ */
  if (h.cycle) {
    const cyc = h.cycle;
    if (!live) { // PAPER 不应有周期(防御)
      _hedgeLog(st, "PAPER 下存在残留周期,已清理", "warn");
      h.cycle = null; return st;
    }
    // 止损:任一腿 pnl<=-15%(bot.py 2404)
    for (const s of pair) {
      const qty = _posQty(positions, s);
      if (!qty) continue;
      const entry = _posEntry(positions, s);
      if (!(entry > 0)) continue;
      let q;
      try { q = await ad.getQuote(s); } catch (e) { continue; }
      const pnl = qty > 0 ? Number(q.bid) / entry - 1 : 1 - Number(q.ask) / entry;
      if (pnl <= -HEDGE.slPct) {
        await hedgeFlatten(ad, st, h, mkts, pair, "价格止损(" + s + " " + (pnl * 100).toFixed(1) + "%)");
        return st;
      }
    }
    // 异常:ETH 有仓但 BTC 无仓,或两腿同向(bot.py 2411)
    if (qtyB !== 0 && (qtyA === 0 || qtyA * qtyB > 0)) {
      await hedgeFlatten(ad, st, h, mkts, pair, "双腿方向或仓位异常");
      return st;
    }
    // 首仓超时 300s 未成交 → 撤单中止(bot.py 2409)
    if (cyc.entry && qtyA === 0 && nowMs - cyc.entry.placedAt > HEDGE.entryTimeoutSec * 1000) {
      try {
        if (cyc.entry.orderId) await ad.cancelOrder(cyc.entry.orderId, { symbol: hp.symA });
        else await ad.cancelOrder(null, { clientId: cyc.entry.clientId, symbol: hp.symA });
      } catch (e) { /* ignore */ }
      delete h.orders[cyc.entry.key];
      _hedgeLog(st, "首仓 300s 未成交,撤单中止本轮", "warn");
      h.cycle = null;
      h.cooldownUntil = nowMs + HEDGE.cooldownSec * 1000;
      return st;
    }
    if (qtyA === 0 && qtyB === 0) {
      const entryOutstanding = !!(cyc.entry && h.orders[cyc.entry.key]);
      if (entryOutstanding) { _waitLog(st, h, "ENTRY_PENDING", "等待首仓成交"); return st; }
      if (cyc.btcFilledEver) {
        _hedgeLog(st, "两腿仓位归零(止盈完成),本轮结束", "ok");
      } else {
        _hedgeLog(st, "首仓未成交或外部平仓,本轮结束", "warn");
      }
      h.cycle = null;
      h.cooldownUntil = nowMs + HEDGE.cooldownSec * 1000;
      return st;
    }
    if (qtyA !== 0) cyc.btcFilledEver = true; // 字段名保留兼容旧状态

    // 对冲:ETH 缺口=btc名义-eth已对冲名义,反向 IOC 吃单(bot.py 2244 hedge_tick)
    try {
      const mB = mkts[hp.symB];
      const qA = await ad.getQuote(hp.symA);
      const qB = await ad.getQuote(hp.symB);
      const notionalA = Math.abs(qtyA) * ((Number(qA.bid) + Number(qA.ask)) / 2);
      const notionalB = Math.abs(qtyB) * ((Number(qB.bid) + Number(qB.ask)) / 2);
      const missing = notionalA - notionalB;
      if (missing > 0) {
        const side = qtyA > 0 ? "sell" : "buy";
        const executable = side === "sell" ? Number(qB.bid) : Number(qB.ask);
        const qty = hedgeFloorStep(Math.min(missing / executable, Number(mB.maxOrderSize)), mB.stepSize);
        if (qty >= Number(mB.minOrderSize) && qty * executable >= Number(mB.minOrderNotional)) {
          const px = hedgeExitLimit(qB, side, mB.tickSize);
          const cid = "hedge-" + cyc.id + "-H";
          const r = await ad.placeOrder({
            symbol: hp.symB, side, qty, price: px,
            timeInForce: "IOC", reduceOnly: false, clientId: cid,
          });
          _hedgeLog(st, "LIVE 对冲下单 " + hp.symB + " " + side.toUpperCase() + " " + qty + " @" + px +
            " (id=" + (r && r.orderId) + ")", "ok");
        }
      }
    } catch (e) {
      _hedgeLog(st, "对冲下单失败: " + String((e && e.message) || e), "err");
    }

    // 止盈:每腿 resting reduce-only 限价单(bot.py 2252 tp_tick)
    for (const s of pair) {
      const qty = _posQty(positions, s);
      const m = mkts[s];
      cyc.tps = cyc.tps || {};
      if (!qty) { cyc.tps[s] = []; continue; }
      const entry = _posEntry(positions, s);
      if (!(entry > 0)) continue;
      const isLong = qty > 0;
      const target = hedgeTpTarget(entry, isLong, m.tickSize);
      const tpside = isLong ? "sell" : "buy";
      const exist = cyc.tps[s] || [];
      const ok = exist.length > 0 && exist.every((o) => Number(o.price) === target && o.side === tpside);
      if (!ok) {
        for (const o of exist) {
          try {
            if (o.orderId) await ad.cancelOrder(o.orderId, { symbol: s });
            else await ad.cancelOrder(null, { clientId: o.clientId, symbol: s });
          } catch (e) { /* ignore */ }
        }
        const placed = [];
        let rest = Math.abs(qty), guard = 0;
        while (rest > 0 && guard++ < 20) {
          const amount = hedgeFloorStep(Math.min(rest, Number(m.maxOrderSize)), m.stepSize);
          if (!(amount > 0)) break;
          const cid = "hedge-" + cyc.id + "-T";
          try {
            const r = await ad.placeOrder({
              symbol: s, side: tpside, qty: amount, price: target,
              timeInForce: "ALO", reduceOnly: true, clientId: cid,
            });
            placed.push({ orderId: r && r.orderId, clientId: cid, side: tpside, price: target });
          } catch (e) {
            _hedgeLog(st, "止盈挂单失败(" + s + "): " + String((e && e.message) || e), "err");
            break;
          }
          rest -= amount;
        }
        cyc.tps[s] = placed;
        if (placed.length) _hedgeLog(st, "LIVE 止盈挂单 " + s + " " + tpside.toUpperCase() + " " +
          Math.abs(qty) + " @" + target, "muted");
      }
    }
    return st;
  }

  /* ============ 无周期:PAPER 只算信号并记日志,绝不下单 ============ */
  if (!live) {
    // v1.5.1:PAPER 也跑只读杠杆校验(最多每 10 分钟一次),提前发现 LIVE 会被拒的问题;不下单,无风险。
    if (!h._levCheckedAt || nowMs - h._levCheckedAt > 600000) {
      h._levCheckedAt = nowMs;
      if (!canVerifyLev) {
        _hedgeLog(st, "杠杆校验跳过(" + hp.venue + " 无 API 校验,请在网页端把对子两腿杠杆设成 " +
          hp.levA + "x/" + hp.levB + "x 全仓)", "warn");
      } else try {
        await ad.verifyLeverage(hp.symA, hp.levA, HEDGE.marginMode);
        await ad.verifyLeverage(hp.symB, hp.levB, HEDGE.marginMode);
      } catch (e) {
        _hedgeLog(st, "杠杆校验失败(LIVE 开仓会被拒绝,请先在网页端预设 " + hp.symA + " " + hp.levA +
          "x/" + hp.symB + " " + hp.levB + "x 全仓): " + String((e && e.message) || e), "err");
      }
    }
    let sig;
    try {
      const candles = await ad.getCandles(hp.symA, "5m", 50);
      const rows = hedgeClosedRows(candles, nowSec);
      sig = hedgeSignal(rows, h.ledger);
    } catch (e) {
      _waitLog(st, h, "SIGNAL_WAIT", String((e && e.message) || e));
      return st;
    }
    if (sig.signal) {
      h.ledger.lastSignalBar = sig.bar;
      _hedgeLog(st, "PAPER 信号 " + sig.side + " rsi=" + sig.rsi.toFixed(1) +
        " bar=" + new Date(sig.bar * 1000).toLocaleString("zh-CN", { hour12: false }) +
        " (仅信号,不下单)", "ok");
    } else {
      _waitLog(st, h, "SIGNAL_WAIT", "rsi=" + (sig.rsi == null ? "-" : sig.rsi.toFixed(1)) + " " + sig.reason);
    }
    return st;
  }

  /* ============ 无周期:LIVE 开仓 ============ */
  if (nowMs < h.cooldownUntil) {
    _waitLog(st, h, "COOLDOWN", "剩余 " + Math.ceil((h.cooldownUntil - nowMs) / 1000) + "s");
    return st;
  }
  if (qtyA !== 0 || qtyB !== 0) {
    _waitLog(st, h, "POSITION_EXISTS", hp.symA + "=" + qtyA + " " + hp.symB + "=" + qtyB + ",不抢外部仓位");
    return st;
  }
  try {
    // 1) 价差检查(bot.py:价差>10bps 抛错)
    const q = await ad.getQuote(hp.symA);
    const mid = (Number(q.bid) + Number(q.ask)) / 2;
    if ((Number(q.ask) - Number(q.bid)) / mid * 10000 > HEDGE.maxSpreadBps)
      throw new Error("价差超过上限(" + HEDGE.maxSpreadBps + "bps)");
    // 2) 两市场杠杆校验(BTC 40x/ETH 25x/CROSS,bot.py verify_leverage)
    if (canVerifyLev) {
      await ad.verifyLeverage(hp.symA, hp.levA, HEDGE.marginMode);
      await ad.verifyLeverage(hp.symB, hp.levB, HEDGE.marginMode);
    }
    // 3) 信号
    const candles = await ad.getCandles(hp.symA, "5m", 50);
    const rows = hedgeClosedRows(candles, nowSec);
    const sig = hedgeSignal(rows, h.ledger);
    if (!sig.signal) { _waitLog(st, h, "SIGNAL_WAIT", "rsi=" + sig.rsi.toFixed(1) + " " + sig.reason); return st; }
    // 4) 信号到下单价格偏离<=1%
    const q2 = await ad.getQuote(hp.symA);
    const mid2 = (Number(q2.bid) + Number(q2.ask)) / 2;
    if (Math.abs(mid2 / mid - 1) > HEDGE.maxSignalDevPct) throw new Error("信号至挂单价格偏离过大");
    // 5) 首仓限价:挂盘口外侧(BUY<bid/SELL>ask),tif=ALO
    const side = sig.side === "LONG" ? "buy" : "sell";
    const raw = mid2 * (1 + HEDGE.entryOffsetPct * (side === "buy" ? -1 : 1));
    const m = mkts[hp.symA];
    const price = hedgeSnapTick(raw, m.tickSize, side);
    if ((side === "buy" && price >= Number(q2.bid)) || (side === "sell" && price <= Number(q2.ask)))
      throw new Error("首仓距离不足以位于盘口外侧");
    // 6) 数量=floor(权益*5/price,stepSize);名义/保证金上限检查(简化版 check_budget)
    if (!(equity > 0)) throw new Error("权益不可用,无法计算仓位");
    const qty = hedgeFloorStep(equity * HEDGE.firstOrderSize / price, m.stepSize);
    if (qty < Number(m.minOrderSize) || qty * price < Number(m.minOrderNotional))
      throw new Error("首仓数量/名义低于交易所最小值");
    const notional = qty * price;
    const existNotional = (positions || []).reduce((a, p) => a + Math.abs(Number(p.qty) || 0) * mid2, 0);
    const lev = hp.levA; // v1.6.19:首仓恒为 A腿
    if (notional > equity * HEDGE.maxSymbolEquityPct) throw new Error("名义超过单标的上限");
    if (existNotional + notional > equity * HEDGE.maxAccountEquityPct) throw new Error("名义超过账户上限");
    if (notional / lev > equity * HEDGE.maxMarginEquityPct) throw new Error("保证金超过上限");
    if (notional / lev > (Number(bal.available) || 0) - HEDGE.minFreeCollateralUsd)
      throw new Error("可用保证金不足");
    // 7) 下单
    const cycleId = sig.bar.toString(16) + Math.random().toString(16).slice(2, 8);
    const cid = "hedge-" + cycleId + "-E";
    const r = await ad.placeOrder({
      symbol: hp.symA, side, qty, price,
      timeInForce: "ALO", reduceOnly: false, clientId: cid,
    });
    h.ledger.lastSignalBar = sig.bar;
    const key = "E:" + cid;
    h.cycle = {
      id: cycleId, side: sig.side, createdAt: nowMs, btcFilledEver: false, tps: {},
      entry: { key, orderId: r && r.orderId, clientId: cid, symbol: hp.symA, side, qty, price, placedAt: nowMs },
    };
    h.orders[key] = h.cycle.entry;
    h._waitReason = "";
    _hedgeLog(st, "LIVE 首仓下单 " + hp.symA + " " + side.toUpperCase() + " " + qty + " @" + price +
      " rsi=" + sig.rsi.toFixed(1) + " (id=" + (r && r.orderId) + ")", "ok");
  } catch (e) {
    _hedgeLog(st, "开仓检查失败: " + String((e && e.message) || e), "err");
  }
  return st;
}

/* service worker 里 importScripts 加载后挂到 globalThis */
if (typeof globalThis !== "undefined") {
  globalThis.hedgeTick = hedgeTick;
  globalThis.hedgeResolvePair = hedgeResolvePair;
  globalThis.HedgeTest = {
    HEDGE, HEDGE_PAIR, HEDGE_VENUE_DEFAULTS, hedgeResolvePair,
    hedgeRsi, hedgeClosedRows, hedgeSignal,
    hedgeFloorStep, hedgeSnapTick, hedgeExitLimit, hedgeTpTarget, hedgeGetState,
  };
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    hedgeTick, hedgeResolvePair,
    HedgeTest: {
      HEDGE, HEDGE_PAIR, HEDGE_VENUE_DEFAULTS, hedgeResolvePair,
      hedgeRsi, hedgeClosedRows, hedgeSignal,
      hedgeFloorStep, hedgeSnapTick, hedgeExitLimit, hedgeTpTarget, hedgeGetState,
    },
  };
}
