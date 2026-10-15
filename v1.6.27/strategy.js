"use strict";
/* Variational Auto Trader - 策略引擎
 * 逻辑移植自 AlphaLabs R3 v0.6.3 的 Profit/Volume 模式(已验证可读部分),
 * 执行层换成 v1.1.7 实测通过的直连 fetch(小写 side / tick 取整 / 本地 instrument)。
 * 本文件不依赖 chrome.*,可在 service worker 和 node 测试里跑。
 */

/* 策略参数:sp/d1/d5 单位都是 bps(万分之一);tp/sl 是小数;timeout 秒 */
const VAT_PARAMS = {
  profit: {
    XAU: { sp: 6, d1: 3, d5: 8, tp: 0.0065, sl: 0.0038, timeout: 45 * 60 },
    XAG: { sp: 8, d1: 4, d5: 10, tp: 0.009, sl: 0.0055, timeout: 45 * 60 },
    DEFAULT: { sp: 7, d1: 3, d5: 8, tp: 0.006, sl: 0.004, timeout: 45 * 60 },
  },
  volume: {
    XAU: { sp: 4, d1: 2, d5: 4, tp: 0.0018, sl: 0.0024, timeout: 8 * 60 },
    XAG: { sp: 5, d1: 2.5, d5: 5, tp: 0.0022, sl: 0.0030, timeout: 8 * 60 },
    DEFAULT: { sp: 5, d1: 2.5, d5: 5, tp: 0.0020, sl: 0.0028, timeout: 8 * 60 },
  },
};
const VAT_HARD_CAP = { XAU: 10, XAG: 10, US100: 10, US500: 10, UKOIL: 5, USOIL: 5, TWI: 10, BTC: 20, ETH: 20 };
const VAT_ASSETS = ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI", "BTC", "ETH"];

/* v1.6.7:新增 7 个 TradFi SWAP 的 maker 名义默认(USD)。DXI 深盘跟现有档;
 * 中盘 400-600;薄盘(VXI/USFNG/COCOA)减半。用户可在弹窗里改。 */
const VAT_MAKER167_NOTIONALS = { DXI: [400, 700], COPP: [400, 600], CNA50: [400, 600], GASOL: [400, 600], USFNG: [200, 350], COCOA: [200, 350], VXI: [200, 350] };

const VAT_DEFAULT_CONFIG = {
  mode: "profit",
  equity: 1000,        // 账户权益 USDC(只用于仓位计算,不读链上)
  marginPct: 20,       // 每标的保证金预算 = equity * marginPct / 100
  targetLev: 10,       // 目标杠杆(逐标的取 min(目标, 平台上限))
  dailyLossPct: 5,     // 日亏损只报警不拦单(v1.2.5 起熔断不停机)
  maxPositions: 2,     // 最大同时持仓标的数
  maxLosses: 3,        // 连续亏损只报警不拦单(v1.2.5 起熔断不停机)
  maxTrades: 30,       // 每日最大开仓数
  assets: ["XAU", "XAG", "US100", "US500", "UKOIL"],
  profitSlippage: 0.003,  // 小数:0.003=0.3%
  volumeSlippage: 0.0015,
  liveEnabled: false,  // 默认 PAPER
  armed: false,
  label: "",           // 本机备注名(多开区分用,不影响交易)
  sessionTtlMin: 1440,  // 已废弃:v1.2.5 起会话彻底不限时,定时器永不自动停策略(保留字段兼容旧配置)
  wdEnabled: true,      // 看门狗:出错自动经中转站报警 + 每5分钟心跳,Muse 每5分钟拉一次,有事先修再发邮件通知
  ukoilUnderlying: "",  // UKOIL 真实 underlying 手动覆盖(留空自动解析;保留兼容)
  manualUnderlyings: {}, // v1.6.3:各标的真实代号手动覆盖{XAU:"XAUS",US100:"US100S",...}(留空自动解析)
  /* v1.6.7:账户基准(用户手动填,插件永不自动改)+历史收益补录 */
  initialFunds: 0,    // 初始资金(USDC),手动填;估算净值=初始资金+累计已实现
  lifetimeSeed: 0,    // 历史收益补录(U):v1.6.7 之前已实现的收益,手动填一次计入累计
  /* Maker 刷量模式(学 AlphaLabs R2):限价挂单,不吃 spread,随机延迟,短持仓 */
  makerAssets: ["BTC", "ETH", "XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"], // v1.6.7:16 个 TradFi+加密
  makerSizes: { BTC: [0.001, 0.003], ETH: [0.03, 0.06] }, // 每笔 size 区间(基础币,均匀随机)
  makerNotionals: Object.assign({ // TradFi 标的按 USDC 名义定 size(价格跨度大),qty=名义/mark
    XAU: [10, 30], XAG: [10, 30], US100: [10, 30], US500: [10, 30],
    UKOIL: [10, 30], USOIL: [10, 30], TWI: [10, 30],
  }, VAT_MAKER167_NOTIONALS),
  makerMinDelay: 30, makerMaxDelay: 60,   // 相邻两笔间隔(秒,均匀随机)
  makerPriceOffset: 0.0001,               // 限价相对盘口偏移(小数,0.0001=1bp)
  makerMonitorSecs: 60,                   // 挂单最多等待成交秒数,超时撤单
  makerMaxHoldSecs: 120,                  // 成交后最长持仓秒数,到时市价平
  makerTpPct: 0.10, makerSlPct: -0.05,    // 相对名义的止盈/止损(小数)
  makerMaxVolPct: 0.003,                  // 1m 波动超过此值跳过(防吃到 adverse selection)
  makerSlippage: 0.001,                   // 平仓市价单滑点(小数)
  makerAlternate: true,                   // true=多空交替,false=随机方向
  /* v1.2.7:排列熵入场否决(高熵=随机游走,跳过开仓;只否决,不产生信号;持仓管理不受影响) */
  entropyFilter: true,                    // true=开仓前算熵,过噪否决
  entropyWindow: 60,                      // 取最近 N 个价格点算熵(5 秒一 tick,60 点≈5 分钟)
  entropyThreshold: 0.85,                 // 归一化熵超过此值否决开仓(0~1,越大越松)
  /* v1.3.0 六所:当前 venue + 凭证 + 切换策略 */
  activeVenue: "variational",             // 当前启用的 venue id(见 venues/registry.js)
  venueCreds: {},                        // 各所凭证:只经适配器构造参数传入,绝不进心跳/日志
  venuePolicy: { onSwitch: "remind" },    // 切换时旧所持仓处理:keep(留着)|close(自动平)|remind(只提醒)
  /* v1.6.19:Hedge 对冲对子(通用,各所可配)。留空=用该所默认 */
  hedgeSymA: "",  // A腿(信号腿,跑 5m RSI):arcus 默认 BTC-USD,variational 默认 BTC,qfex 默认 GOLD-USD
  hedgeSymB: "",  // B腿(对冲腿,等名义反向):arcus 默认 ETH-USD,variational 默认 ETH,qfex 默认 SILVER-USD
  hedgeLevA: 0,   // A腿杠杆(0=用所默认:arcus 40x,其余 10x)
  hedgeLevB: 0,   // B腿杠杆(0=用所默认:arcus 25x,其余 10x)
};

/* API 注入:默认用全局(api.js),测试时可替换 */
const VAT_A = {};
function vatSetApi(overrides) { Object.assign(VAT_A, overrides); }
/* v1.3.0 Phase B:venue 适配器接入。优先级:显式注入 VAT_A(测试用) >
 * VAT_V.adapter.getLegacyApi() > 全局函数(api.js)。globalThis 取全局,
 * node 里取不到则 null(与原来的 typeof 检查等价)。 */
const VAT_V = {};
function vatSetVenueAdapter(a) { VAT_V.adapter = a || null; }
function vatActiveAdapter() { return VAT_V.adapter || null; }
function vatApi() {
  let leg = null;
  try {
    const ad = VAT_V.adapter;
    if (ad && typeof ad.getLegacyApi === "function") leg = ad.getLegacyApi() || null;
  } catch (e) { leg = null; }
  const gfn = (n) => (typeof globalThis !== "undefined" && globalThis[n] !== undefined)
    ? globalThis[n] : null;
  const pick = (fn, globalName) => VAT_A[fn] || (leg && leg[fn]) || gfn(globalName || fn) || null;
  return {
    venueId: VAT_A.venueId || null, // v1.6.8:当前接线的 venue(null=variational 默认)
    getRiskMark: pick("getRiskMark"),
    indicativeQuote: pick("indicativeQuote"),
    prepareOrderQty: pick("prepareOrderQty"),
    placeMarketAuto: pick("placeMarketAuto"),
    confirmRfq: pick("confirmRfq"),
    marginNeedFromQuote: pick("marginNeedFromQuote"),
    placeMakerOrder: pick("placeMakerOrder"),
    cancelOrder: pick("cancelOrder"),
    getPositions: pick("getPositions"),
    positionQtyFor: pick("positionQtyFor"),
    sleep: pick("sleep") || ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: pick("now") || (() => Date.now()),
    underlyingAliases: VAT_A.underlyingAliases || (leg && leg.underlyingAliases) || gfn("UNDERLYING_ALIASES"),
    listUnderlyings: pick("listUnderlyings"),
    directoryDiag: pick("directoryDiag"),
  };
}

/* v1.6.8:非 variational venue 的 profit/volume/maker 模式,持仓对账字段待实测,
 * LIVE 下单会因无法对账产生不可控风险→启动时直接拒绝,PAPER 不受影响。
 * v1.6.9:qfex 的 getPositions/getBalance 已用 REST 落实,放开 qfex;其余 venue 保持门禁。 */
function vatVenueLiveGuard(c) {
  const venue = (c && c.activeVenue) || "variational";
  const mode = (c && c.mode) || "";
  if (c && c.liveEnabled && venue !== "variational" && venue !== "qfex" && ["profit", "volume", "maker"].includes(mode)) {
    return `${venue} 的持仓对账/余额字段待实测确认,LIVE 下单无法安全对账,暂不可用。请先跑 PAPER,或切回 Variational`;
  }
  return null;
}

/* v1.6.8:清除 VAT_A 的 venue 覆盖,回到 variational 全局函数(默认行为) */
function vatResetApi() {
  try {
    for (const k of ["venueId", "getRiskMark", "indicativeQuote", "prepareOrderQty", "placeMarketAuto",
      "confirmRfq", "marginNeedFromQuote", "placeMakerOrder", "cancelOrder",
      "getPositions", "positionQtyFor", "sleep", "now",
      "underlyingAliases", "listUnderlyings", "directoryDiag"]) {
      try { delete VAT_A[k]; } catch (_) { VAT_A[k] = undefined; }
    }
  } catch (_) { /* 忽略 */ }
}

/* v1.6.8:按 venue 装配 legacy 接口。
 * variational → 清除覆盖(走全局函数,行为与旧版一致);
 * 其他 venue → 用适配器方法装配完整 legacy 接口(VAT_A 优先于一切),
 * 彻底杜绝"切到 qfex 却悄悄用 Variational 行情/下单"的静默回退。 */
function vatWireVenueApi(venueId, ad) {
  if (!venueId || venueId === "variational" || !ad) { vatResetApi(); return; }
  try { vatSetApi(vatBuildVenueLegacyApi(ad, venueId)); }
  catch (e) { vatResetApi(); throw e; }
}

/* v1.6.8:用 venue 适配器的方法拼出策略引擎要的 legacy 接口。
 * 符号:策略侧习惯带 -SWAP/-PERP 后缀,QFEX 下单用裸市场符号(如 GOLD-USD),
 * shim 统一 strip 后缀后再调适配器。行情缓存 3 秒,减少 WS 订阅 churn。 */
function vatBuildVenueLegacyApi(ad, venueId) {
  const VID = String(venueId || "venue");
  const stripSym = (s) => String(s || "").replace(/-(SWAP|PERP)$/i, "");
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const needAd = () => { if (!ad) throw new Error(VID + ": 适配器未就绪"); };
  let mkCache = null, mkAt = 0;
  async function marketSymbols() {
    needAd();
    const now = Date.now();
    if (mkCache && now - mkAt < 60000) return mkCache;
    const list = await ad.getMarkets();
    mkCache = (list || []).map((m) => m && m.symbol).filter(Boolean);
    mkAt = now;
    return mkCache;
  }
  const qCache = new Map(); // symbol -> {t, q}
  async function quote(sym) {
    needAd();
    const s = stripSym(sym);
    if (!s) throw new Error(VID + ": 空符号");
    const now = Date.now();
    const hit = qCache.get(s);
    if (hit && now - hit.t < 3000) return hit.q;
    const q = await ad.getQuote(s);
    qCache.set(s, { t: now, q });
    if (qCache.size > 64) { const k = qCache.keys().next().value; qCache.delete(k); }
    return q;
  }
  const lastFill = {}; // orderId -> 'filled'|'pending'
  return {
    venueId: VID,
    underlyingAliases: {}, // QFEX:不猜别名,走目录模糊匹配(VAT_DIR_FUZZY 已有 GOLD/SILVER/CL/BRENT)
    listUnderlyings: () => marketSymbols(),
    directoryDiag: async () => {
      const syms = await marketSymbols().catch(() => []);
      return { venue: VID, markets: syms.length, sample: syms.slice(0, 8) };
    },
    getRiskMark: async (u, _kind) => {
      const q = await quote(u);
      const m = num(q.mark != null ? q.mark : q.last);
      return (m != null && m > 0) ? m : 0;
    },
    indicativeQuote: async (symbol, qty) => {
      const s = stripSym(symbol);
      const q = await quote(s);
      const bid = num(q.bid), ask = num(q.ask);
      let mark = num(q.mark != null ? q.mark : q.last);
      if (mark == null && bid != null && ask != null) mark = (bid + ask) / 2;
      if (bid == null && ask == null && mark == null) throw new Error(VID + ": 无行情 " + s);
      return {
        quoteId: null, mark,
        request: { venue: VID, symbol: s, qty: String(qty == null ? "" : qty) },
        response: { bid, ask, mark_price: mark, venue: VID },
      };
    },
    prepareOrderQty: async (symbol, qty, _side) => {
      const s = stripSym(symbol);
      await quote(s); // 市场不存在/无行情直接抛=不可交易(对应 vatQuoteVerify 的验证语义)
      const n = num(qty);
      if (n == null || !(n > 0)) throw new Error(VID + ": 非法数量 " + String(qty));
      let q = n, note = "";
      // v1.6.9:用 refdata 真实精度(lot_size/min_quantity),不再瞎猜
      try {
        const c = (ad && typeof ad.getContract === "function") ? await ad.getContract(s) : null;
        if (c && c.lotSize > 0) {
          const qq = Math.floor(q / c.lotSize + 1e-9) * c.lotSize;
          const qqn = Number(qq.toFixed(12));
          if (qqn !== q && qqn > 0) { note = `数量按 lot_size ${c.lotSize} 取整: ${q} → ${qqn}`; q = qqn; }
        }
        if (c && c.minQuantity > 0 && q < c.minQuantity) {
          throw new Error(`数量 ${q} 低于最小下单量 ${c.minQuantity},请调大金额后再试`);
        }
      } catch (e) {
        if (/低于最小下单量/.test(String((e && e.message) || e))) throw e; // v1.6.6 语义:询价本身通了
        /* 精度查不到就用原数量,不阻断 */
      }
      return { qty: String(q), note, quote: null };
    },
    placeMarketAuto: async (symbol, side, qty, opts) => {
      needAd();
      opts = opts || {};
      const s = stripSym(symbol);
      if (opts.dryRun) return { dryRun: true, body: { venue: VID, symbol: s, side, qty: String(qty) }, note: "演练模式:未真实下单" };
      const r = await ad.placeOrder({ symbol: s, side, qty: String(qty), type: "MARKET", reduceOnly: !!opts.reduceOnly });
      const st = String((r && r.status) || "").toLowerCase();
      const rfqId = String(r.orderId);
      lastFill[rfqId] = st;
      return { rfqId, qty: String(qty), _venue: VID, _fillStatus: st };
    },
    confirmRfq: async (rfqId) => {
      const st = lastFill[rfqId];
      if (st === "filled") return { ok: true };
      if (st === "pending") return { ok: undefined, status: "pending" };
      return { ok: undefined, status: st || "unknown" };
    },
    // QFEX 不返回保证金需求:0=未知,策略侧 need>budget&&need>0 的判断会跳过缩量(安全)
    marginNeedFromQuote: () => 0,
    placeMakerOrder: async (symbol, side, qty, limitPrice, opts) => {
      needAd();
      opts = opts || {};
      const s = stripSym(symbol);
      if (opts.dryRun) return { dryRun: true, note: "演练模式:未真实挂单" };
      // QFEX 限价单受 500ms speed bump 影响;adapter 等 10 秒执行报告,未成交返回 pending
      const r = await ad.placeOrder({ symbol: s, side, qty: String(qty), type: "LIMIT", price: Number(limitPrice), tif: "GTC", reduceOnly: !!opts.reduceOnly });
      return { orderId: String(r.orderId), qty: String(qty) };
    },
    cancelOrder: async (orderId) => { needAd(); return ad.cancelOrder(orderId); },
    // 持仓/余额字段待实测:adapter 主动抛 VENUE_UNKNOWN,上层按"对账跳过"处理,不编造
    getPositions: async () => { needAd(); return ad.getPositions(); },
    positionQtyFor: (rows, symbol) => {
      const s = stripSym(symbol).toLowerCase();
      let qty = 0;
      for (const r of (rows || [])) {
        const rs = String((r && (r.symbol || r.market || r.instrument)) || "").toLowerCase();
        if (rs === s) {
          const q = num(r.qty != null ? r.qty : (r.quantity != null ? r.quantity : (r.size != null ? r.size : r.amount)));
          if (q != null) qty += q;
        }
      }
      return qty;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

function vatProfile(mode, asset) {
  const p = VAT_PARAMS[mode] || VAT_PARAMS.profit;
  return p[asset] || p.DEFAULT;
}
function vatBps(a, b) { return b ? (a / b - 1) * 10000 : 0; }

/* v1.2.7:熵否决函数解析(service worker 里 entropy.js 经 importScripts 先加载,是全局;
 * node 测试里则 require。都取不到时返回 null,策略照常跑、无否决)。 */
function vatGetEntropyVeto() {
  if (typeof vatEntropyVeto !== "undefined") return vatEntropyVeto;
  if (typeof require === "function") {
    try { return require("./entropy.js").vatEntropyVeto; } catch (e) { return null; }
  }
  return null;
}

function vatBlankState() {
  return {
    date: "", history: {}, positions: {}, lastSignal: {}, resolved: {},
    stats: { pnl: 0, turnover: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0 },
    markets: {}, logs: [], quoteBackoff: {}, // quoteBackoff: 询价连续失败的退避(可能休市),{n, until}
  };
}
function vatLog(st, asset, msg, level) {
  st.logs = st.logs || [];
  st.logs.unshift({ t: Date.now(), asset, msg, level: level || "muted" });
  if (st.logs.length > 60) st.logs.length = 60;
}
function vatPushHist(st, asset, mark, now) {
  st.history = st.history || {};
  const a = st.history[asset] || (st.history[asset] = []);
  a.push({ t: now, p: mark });
  st.history[asset] = a.filter((x) => x.t >= now - 7 * 60 * 1000);
}
/* v1.6.19:1 分钟 K 线存储(供 Variational 适配器 getCandles 合成 5m K线,给 Hedge 信号用)。
 * 全局内存 globalThis.VAT_C1M: symbol → [{t(分钟起始ms),o,h,l,c}],保留最近 320 根。
 * 持久化由 background.js 每 60 tick 存 VAT_CANDLES1M,启动时读回。 */
function vatPushCandle1m(symbol, price, nowMs) {
  const p = Number(price);
  if (!(p > 0) || !Number.isFinite(nowMs)) return;
  const g = (typeof globalThis !== "undefined") ? globalThis : {};
  g.VAT_C1M = g.VAT_C1M || {};
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return;
  const arr = g.VAT_C1M[sym] || (g.VAT_C1M[sym] = []);
  const t = Math.floor(nowMs / 60000) * 60000;
  const last = arr[arr.length - 1];
  if (last && last.t === t) {
    last.h = Math.max(last.h, p); last.l = Math.min(last.l, p); last.c = p;
  } else {
    arr.push({ t, o: p, h: p, l: p, c: p });
    if (arr.length > 320) arr.splice(0, arr.length - 320);
  }
}
/* v1.6.19:从 1m 存储合成 5m K线 → [{time(秒),open,high,low,close,isFinal}]。
 * 要求:至少 limit+1 根已收盘 5m(与 hedgeClosedRows 的 RSI 需求对齐);缺数据抛错。 */
function vatCandles5m(symbol, limit, nowMs) {
  const g = (typeof globalThis !== "undefined") ? globalThis : {};
  const arr = (g.VAT_C1M || {})[String(symbol || "").toUpperCase()] || [];
  const need = (Number(limit) || 50) + 1;
  const now = Number(nowMs) || Date.now();
  const cur5m = Math.floor(now / 300000) * 300000;
  const bars5 = [];
  const groups = {};
  for (const b of arr) {
    const g5 = Math.floor(b.t / 300000) * 300000;
    if (g5 >= cur5m) continue; // 丢弃当前未收盘的 5m
    const gbar = groups[g5] || (groups[g5] = { t: g5, o: b.o, h: b.h, l: b.l, c: b.c });
    gbar.h = Math.max(gbar.h, b.h); gbar.l = Math.min(gbar.l, b.l); gbar.c = b.c;
  }
  const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
  for (const k of keys) bars5.push(groups[k]);
  if (bars5.length < need)
    throw new Error("5m K线不足(仅 " + bars5.length + " 根,需 " + need + " 根):插件需持续运行约 " +
      Math.ceil(need * 5 / 60) + " 小时积累");
  const out = bars5.slice(-need).map((b) => ({
    time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, isFinal: true,
  }));
  return out;
}
function vatBefore(st, asset, ms, now) {
  const a = (st.history && st.history[asset]) || [];
  const target = now - ms;
  let x = null;
  for (const p of a) if (p.t <= target) x = p;
  return x ? x.p : null;
}

/** v1.6.4:目录真名模糊匹配(别名表试不出时用)。每个候选都用 risk_limits mark>0 实证,不瞎猜。 */
const VAT_DIR_FUZZY = {
  XAU: [/XAU/i, /GOLD/i, /^GC$/i, /XAUUSD/i],
  XAG: [/XAG/i, /SILVER/i, /^SI$/i, /XAGUSD/i],
  US100: [/US100/i, /NDX/i, /NAS/i, /QQQ/i],
  US500: [/US500/i, /SPX/i, /SP500/i, /^ES$/i],
  UKOIL: [/UKOIL/i, /BRENT/i, /^BZ$/i],
  USOIL: [/USOIL/i, /WTI/i, /^CL$/i],
  TWI: [/TWI/i],
  BTC: [/^BTC/i],
  ETH: [/^ETH/i],
};

/** 目录模糊匹配兜底(共用):别名试不出时,用目录真名 × {swap,perp} 再试 risk_limits,mark>0 才认 */
async function vatDirFuzzyResolve(api, st, asset, tried, cfg) {
  const names = await api.listUnderlyings().catch(() => []);
  if (!names || !names.length) return null;
  const pats = VAT_DIR_FUZZY[asset] ||
    [new RegExp(String(asset).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")];
  // v1.6.5:pattern 按特异度排序外循环——/US100/ 先扫完全部名字,再扫 /NAS/,
  // 避免目录 key 随机排序时误命中不知名代币(之前 US100 命中了 mark=0.007 的怪东西)
  const cands = [];
  for (const p of pats) {
    for (const n of names) {
      if (tried.has(n) || cands.includes(n)) continue;
      if (p.test(n)) cands.push(n);
    }
  }
  for (const n of cands) {
    for (const kind of ["swap", "perpetual_future"]) {
      const m = await api.getRiskMark(n, kind).catch(() => 0);
      if (!(m > 0)) continue;
      // v1.6.20:有 mark 不等于能询价(如 ETHFI 有 mark 但根本不是 ETH)。
      // 必须用真实询价验证,400 就继续试下一个,不瞎认。
      let ok = false;
      try { ok = await vatQuoteVerify(api, st, asset, n, kind, m, cfg); }
      catch (e) { throw e; } // 超时/网络:直接抛给上层
      if (ok) {
        vatLog(st, asset, `目录模糊匹配命中 ${n}(${kind}),mark=${m},询价验证通过（非别名表，请核对）`);
        return { underlying: n, kind };
      }
      vatLog(st, asset, `目录模糊匹配 ${n}(${kind}) 有 mark 但询价 400,跳过`, "warn");
    }
  }
  return null;
};

/** v1.6.6: 用真实询价验证 (underlying, kind) 是否真的可交易。
 *  背景:risk_limits 有 mark 不等于 RFQ 能接单(v1.6.5 实测:BTCS/swap 有 mark 但询价 400)。
 *  逻辑:prepareOrderQty 成功→true;报"低于最小下单量"→true(询价本身通了,拿到了 qty_limits);
 *  HTTP 400→false(代号/类型不对,上层试下一个);超时/网络等→抛给上层(不断言)。
 *  试单数量按各模式公式估一个,不求精确,只求"交易所认这个代号"。 */
async function vatQuoteVerify(api, st, asset, underlying, kind, mark, cfg) {
  const symbol = underlying + (kind === "perpetual_future" ? "-PERP" : "-SWAP");
  let qtyStr = "0.001";
  try {
    if (cfg && cfg.mode === "maker") {
      const not = (cfg.makerNotionals || {})[asset];
      const range = (cfg.makerSizes || {})[asset];
      if (not) qtyStr = String(Math.max(0.000001, not[0] / mark));
      else if (range) qtyStr = String(range[0]);
    } else if (cfg) {
      const budget = Math.max(0, Number(cfg.equity) * Number(cfg.marginPct) / 100);
      const lev = Number(cfg.targetLev) || 1;
      qtyStr = String(Math.max(0.000001, budget * lev / mark));
    }
  } catch (e) { /* 用默认 */ }
  try {
    await api.prepareOrderQty(symbol, qtyStr, "buy");
    return true;
  } catch (e) {
    if (e && e.httpStatus === 400) return false;
    if (/低于最小下单量/.test(String((e && e.message) || ""))) return true;
    throw e;
  }
}

/** 解析并校验 underlying:手动覆盖 > 别名顺序(risk_limits 的 mark>0 验证),缓存结果 */
/** 解析 profit/volume 标的:别名 × {swap, perpetual_future} 试 risk_limits,返回 {underlying, kind}。
 *  (BTC/ETH 这类加密标的可能只有 perpetual_future,没有 swap——之前只试 swap 会误判为"解析失败") */
async function vatResolveUnderlying(api, st, asset, cfg) {
  const cached = st.resolved && st.resolved[asset];
  if (cached) return typeof cached === "string" ? { underlying: cached, kind: "swap" } : cached;
  // v1.6.6:解析失败冷却 5 分钟(休市时所有组合都 400,不必每轮重打十几个 400;5 分钟后自动再试,开市能恢复)
  const rc = st.resolveCool && st.resolveCool[asset];
  if (rc && Date.now() < rc.until) throw new Error(rc.err);
  const coolFail = (err) => {
    st.resolveCool = st.resolveCool || {};
    st.resolveCool[asset] = { until: Date.now() + 5 * 60 * 1000, err: String(err) };
  };
  const save = (r) => { st.resolved = st.resolved || {}; st.resolved[asset] = r; return r; };
  // 手动覆盖优先(用户已知的真实代号):cfg.manualUnderlyings{XAU:"XAUS",...},兼容旧的 cfg.ukoilUnderlying
  const manualMap = (cfg && cfg.manualUnderlyings) || {};
  const manual = String(manualMap[asset] || (asset === "UKOIL" ? (cfg && cfg.ukoilUnderlying) : "") || "")
    .trim().toUpperCase();
  if (manual) {
    const m = await api.getRiskMark(manual).catch(() => 0);
    if (m > 0) return save({ underlying: manual, kind: "swap" });
    throw new Error(`${asset} 手动代号 ${manual} 无效(risk_limits 无 mark),请检查后重试`);
  }
  const aliases = (api.underlyingAliases && api.underlyingAliases[asset]) || [asset];
  const tried = new Set();
  const failed400 = [];
  for (const u of aliases) {
    for (const kind of ["swap", "perpetual_future"]) {
      tried.add(u);
      const m = await api.getRiskMark(u, kind).catch(() => 0);
      if (!(m > 0)) continue;
      // v1.6.6:有 mark 不等于能询价。用真实询价验证,400 就试下一个组合,不再把"有 mark 但 RFQ 拒单"
      // 的代号(如 BTCS)缓存下来导致每轮 400。只有验证通过的才 save。
      let ok = false;
      try { ok = await vatQuoteVerify(api, st, asset, u, kind, m, cfg); }
      catch (e) { throw e; } // 超时/网络:不断言,直接抛给上层
      if (ok) return save({ underlying: u, kind });
      failed400.push(u + "/" + kind);
    }
  }
  if (failed400.length) {
    vatLog(st, asset, `代号试错:${failed400.join(",")} 询价均 400,转目录模糊匹配`, "warn");
  }
  // v1.6.4:目录模糊匹配兜底。目录是 {UNDERLYING:...} map 形状,真名可能不在别名表里
  // (如 GOLD/XAUUSD)。用 risk_limits 的 mark>0 做实证校验,命中才用,不瞎猜。
  try {
    const hit = await vatDirFuzzyResolve(api, st, asset, tried, cfg);
    if (hit) return save(hit);
  } catch (e) { /* 兜底失败就走下面的报错,诊断里带目录名 */ }
  // 诊断:把目录里的真实名字打出来,用户贴回即可写死
  let diag = "";
  try {
    const names = await api.listUnderlyings();
    if (names && names.length) {
      const oilish = names.filter((n) => /OIL|BRENT|WTI|GAS/i.test(n));
      diag = `；目录共 ${names.length} 个标的` +
        (oilish.length ? `，疑似油相关: ${oilish.join(",")}` : "，无油相关名字") +
        "；可在配置里手动填写真实代号";
      // v1.6.20:BTC/ETH 类解析失败时,把目录里名字含 BTC/ETH 的候选也打出来,方便定位真实代号
      try {
        if (/^(BTC|ETH|SOL)$/i.test(asset)) {
          const cryptoish = names.filter((n) => new RegExp(asset, "i").test(n)).slice(0, 20);
          if (cryptoish.length) diag += `；疑似${asset}相关: ${cryptoish.join(",")}`;
          else diag += `；目录里无${asset}相关名字(已搜 ${names.length} 个)`;
          // v1.6.21:把目录条目的 instrument_type 与 instrument 关键字段打出来,定位询价 400 根因
          try {
            const dir = await api.supportedAssets().catch(() => []);
            const hits = [];
            for (const e of (dir || [])) {
              const u = String((e && (e.underlying || (e.instrument && e.instrument.underlying))) || "").toUpperCase();
              if (u === asset.toUpperCase()) {
                const inst = (e.instrument && typeof e.instrument === "object") ? e.instrument : e;
                const keys = Object.keys(inst || {}).slice(0, 12).join("|");
                hits.push(`type=${e.instrument_type || inst.instrument_type || "?"} keys=${keys}`);
                if (hits.length >= 3) break;
              }
            }
            if (hits.length) diag += `；目录条目[${asset}]: ${hits.join(" / ")}`;
          } catch (_) {}
        }
      } catch (_) {}
    } else {
      // v1.6.3:把最近一次目录抓取的诊断带上,下次错误报告直接告诉我是 403/401/空/形状变了
      let dd = "";
      try { dd = (api.directoryDiag ? String(api.directoryDiag()) : ""); } catch (e) { dd = ""; }
      diag = "；目录无返回" + (dd ? `(抓取诊断: ${dd})` : "");
    }
  } catch (e) { diag = "；目录获取失败"; }
  const errMsg = `${asset} 未能解析可用 underlying(试过 ${aliases.join("/")} × swap/perp)${diag}`;
  coolFail(errMsg);
  throw new Error(errMsg);
}

/** 仓位计算:预算→杠杆→名义→数量→tick 取整→保证金校验(超预算则等比缩小) */
async function vatSizedQuote(api, st, asset, cfg, mark, symbol) {
  symbol = symbol || asset + "-SWAP";
  const budget = Math.max(0, Number(cfg.equity) * Number(cfg.marginPct) / 100);
  const lev = Math.min(Number(cfg.targetLev) || 1, VAT_HARD_CAP[asset] || Number(cfg.targetLev) || 1);
  const notional = budget * lev;
  let qty = Math.max(0.000001, notional / mark);
  // tick 取整 + 最小下单量校验(低于 min 直接抛错,不发交易所)
  const prep = await api.prepareOrderQty(symbol, String(qty), "buy");
  qty = Number(prep.qty);
  let q = await api.indicativeQuote(symbol, String(qty));
  let need = api.marginNeedFromQuote(q.response);
  if (need > budget && need > 0) {
    qty *= Math.max(0.05, (budget / need) * 0.96);
    const prep2 = await api.prepareOrderQty(symbol, String(qty), "buy");
    qty = Number(prep2.qty);
    q = await api.indicativeQuote(symbol, String(qty));
    need = api.marginNeedFromQuote(q.response);
  }
  return { q, qty: String(qty), need, budget, lev, notional: qty * mark, quote: q };
}

/* v1.2.4:自动重启判定(纯函数,可测试)。
 * 只有"会话原因"自动停止的才允许自动恢复;用户手动停止/紧急停止绝不自动重启。
 * 恢复节流:每 15 分钟最多尝试一次,避免频繁打登录接口。 */
function vatAutoRecoverDue(config, nowMs) {
  return !!(config && !config.armed && config.stopReason === "session" &&
    (!config.nextRecoverAt || nowMs >= config.nextRecoverAt));
}
const VAT_RECOVER_INTERVAL_MS = 15 * 60 * 1000;

/* v1.2.5:熔断只报警、不拦单(用户要求:熔断后不再卡死)。
 * 同一熔断只告警一次;条件解除后自动复位,下次触发再报警。 */
function vatFuseWarn(st, asset, key, msg) {
  st.fuseWarned = st.fuseWarned || {};
  if (st.fuseWarned[key]) return;
  st.fuseWarned[key] = true;
  vatLog(st, asset || "SYSTEM", `熔断告警(不停机,只提醒):${msg}`, "warn");
}
function vatFuseReset(st, key) {
  if (st.fuseWarned) delete st.fuseWarned[key];
}

/* v1.6.2:下单/平仓硬失败熔断。同一标的同一操作(op=open/close)连续被拒(非超时,
 * 如 422)达到阈值后停手:不再每 tick 盲重试;30 分钟后给一次重试机会(先对账);
 * 手动重启立即解除。解决 v1.2.1 UKOIL 平仓 422 每 5 秒死循环刷屏的问题。 */
const VAT_ORDER_FAIL_MAX = 3;
const VAT_ORDER_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
function vatOrderFailKey(asset, op) { return asset + ":" + op; }
function vatOrderFailGet(st, asset, op) {
  return (st.orderFail || {})[vatOrderFailKey(asset, op)] || null;
}
/** 本轮是否被拦下(冷却中) */
function vatOrderFailBlocked(st, asset, op, now) {
  const f = vatOrderFailGet(st, asset, op);
  if (!f || f.n < VAT_ORDER_FAIL_MAX) return false;
  return now < (f.nextRetry || 0);
}
/** 记录一次硬失败,返回累计次数。达到阈值时记一笔醒目告警(只记一次)。 */
function vatOrderFailTrack(st, asset, op, errMsg, now) {
  st.orderFail = st.orderFail || {};
  const k = vatOrderFailKey(asset, op);
  const f = st.orderFail[k] || (st.orderFail[k] = { n: 0 });
  f.n += 1; f.lastErr = String(errMsg || "").slice(0, 120); f.lastAt = now;
  if (f.n === VAT_ORDER_FAIL_MAX) {
    f.nextRetry = now + VAT_ORDER_FAIL_COOLDOWN_MS;
    vatLog(st, asset,
      `【需手动处理】${op === "close" ? "平仓" : "下单"}连续${VAT_ORDER_FAIL_MAX}次被拒(${f.lastErr})，已暂停自动重试；30分钟后会再试一次(先对账)，或手动重启立即恢复`,
      "err");
  } else if (f.n > VAT_ORDER_FAIL_MAX) {
    f.nextRetry = now + VAT_ORDER_FAIL_COOLDOWN_MS;
  }
  return f.n;
}
/** 成功一次即清零 */
function vatOrderFailClear(st, asset, op) {
  if (st.orderFail) delete st.orderFail[vatOrderFailKey(asset, op)];
}

/* v1.6.2:模式统计。st.modeStats={mode,since,pnl,turnover,trades,wins,losses}，
 * 切换模式时重置；今日总计(st.stats)不受影响，继续按天累计。 */
function vatModeStats(st, cfg, now) {
  let ms = st.modeStats;
  if (!ms || ms.mode !== cfg.mode) {
    ms = st.modeStats = { mode: cfg.mode, since: now, pnl: 0, turnover: 0, trades: 0, wins: 0, losses: 0 };
  }
  return ms;
}
/** 双记账:今日总计 + 当前模式 */
function vatBumpModeStats(st, cfg, now, d) {
  try {
    const ms = vatModeStats(st, cfg, now);
    for (const k of ["pnl", "turnover", "trades", "wins", "losses"]) {
      if (d[k]) ms[k] += d[k];
    }
  } catch (_) { /* 忽略 */ }
}

/* v1.6.10:分交易所标的(用户要求:切所就只显示该所的标的)。
 * v1.6.17:候选(供勾选)与默认选中分开:QFEX 候选 18 个、Arcus 候选 9 个(均为用户截图指定);
 * 默认选中保持精简(QFEX 8 个、Arcus BTC/ETH)。
 * (QFEX 无 BTC/ETH 永续,只有 COIN-USD 这类股票;BRENT-USD 不存在,只有 WTI 的 CL-USD) */
/* v1.6.17:QFEX 候选=用户截图指定的 18 个(原 8 精选 + 截图新增 SNDK/MU/ZM/SOXL/FLEX/TAIEX/CIEN/AMD/COPPER/ALAB)。前 8 个默认选中。 */
const VAT_QFEX_CANDIDATES = [
  "GOLD-USD",
  "SILVER-USD",
  "US100-USD",
  "US500-USD",
  "CL-USD",
  "NVDA-USD",
  "AAPL-USD",
  "TSLA-USD",
  "SNDK-USD",
  "MU-USD",
  "ZM-USD",
  "SOXL-USD",
  "FLEX-USD",
  "TAIEX-USD",
  "CIEN-USD",
  "AMD-USD",
  "COPPER-USD",
  "ALAB-USD"
];

/* v1.6.17:Arcus 候选=用户截图指定的 9 个(BTC/SPY/ETH/NVDA/QQQ/AAPL/SOL/HYPE/SNDK)。 */
const VAT_ARCUS_CANDIDATES = [
  "BTC-USD",
  "SPY-USD",
  "ETH-USD",
  "NVDA-USD",
  "QQQ-USD",
  "AAPL-USD",
  "SOL-USD",
  "HYPE-USD",
  "SNDK-USD"
];

/* v1.6.17:三所重叠标的(候选均为用户截图指定范围)。
 * Variational↔QFEX: XAU↔GOLD-USD; XAG↔SILVER-USD; US100↔US100-USD; US500↔US500-USD; USOIL↔CL-USD。
 * Variational↔QFEX↔Arcus: US100↔US100-USD↔QQQ-USD; US500↔US500-USD↔SPY-USD。
 * Variational↔Arcus: BTC↔BTC-USD; ETH↔ETH-USD(QFEX 无加密永续)。
 * QFEX↔Arcus 同名: NVDA-USD; AAPL-USD; SNDK-USD。
 * 注意:Arcus 与 QFEX 的 getFunding 均返回 null(费率端点未确认),XFund 跨所目前只支持 Variational×Lighter。 */
const VAT_VENUE_OVERLAP = [
  ["XAU", "GOLD-USD", null],
  ["XAG", "SILVER-USD", null],
  ["US100", "US100-USD", "QQQ-USD"],
  ["US500", "US500-USD", "SPY-USD"],
  ["USOIL", "CL-USD", null],
  ["BTC", null, "BTC-USD"],
  ["ETH", null, "ETH-USD"],
  [null, "NVDA-USD", "NVDA-USD"],
  [null, "AAPL-USD", "AAPL-USD"],
  [null, "SNDK-USD", "SNDK-USD"],
];
/* 候选(全量):弹窗勾选列表用 */
const VAT_VENUE_ASSET_CANDIDATES = {
  variational: ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI", "BTC", "ETH",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"], // v1.6.16:9→16,新增 7 个均为 2026-10-09 浏览器 URL 实测
  qfex: VAT_QFEX_CANDIDATES,
  arcus: VAT_ARCUS_CANDIDATES,
};
/* 默认选中(新用户/迁移):保持精简 */
const VAT_VENUE_ASSETS = {
  variational: ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI", "BTC", "ETH",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: ["GOLD-USD", "SILVER-USD", "US100-USD", "US500-USD", "CL-USD", "NVDA-USD", "AAPL-USD", "TSLA-USD"],
  arcus: ["BTC-USD", "ETH-USD"], // v1.6.16:Hedge 对冲对子
};
const VAT_VENUE_MAKER_ASSETS = {
  variational: ["BTC", "ETH", "XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: ["GOLD-USD", "SILVER-USD", "US100-USD", "US500-USD", "CL-USD", "NVDA-USD", "AAPL-USD", "TSLA-USD"],
};
const VAT_VENUE_MAKER_CANDIDATES = {
  variational: ["BTC", "ETH", "XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: VAT_QFEX_CANDIDATES, // v1.6.16:maker 候选同步全量
  arcus: [], // maker 模式只支持 variational/qfex
};
/* 当前交易所的标的(选中)/Maker 标的:优先 cfg.venueAssets[venue],否则默认表,最后回退旧 cfg.assets */
function vatActiveVenue(cfg) { return (cfg && cfg.activeVenue) || "variational"; }
function vatVenueAssets(cfg) {
  const v = vatActiveVenue(cfg);
  const sel = cfg && cfg.venueAssets && cfg.venueAssets[v];
  if (Array.isArray(sel) && sel.length) return sel;
  return (VAT_VENUE_ASSETS[v] || []).slice();
}
function vatVenueMakerAssets(cfg) {
  const v = vatActiveVenue(cfg);
  const sel = cfg && cfg.venueMakerAssets && cfg.venueMakerAssets[v];
  if (Array.isArray(sel) && sel.length) return sel;
  return (VAT_VENUE_MAKER_ASSETS[v] || []).slice();
}
/* v1.6.16:候选(全量)访问器:弹窗勾选列表用;与"选中"(实际跑的)分开 */
function vatVenueAssetCandidates(cfg) {
  const v = vatActiveVenue(cfg);
  return (VAT_VENUE_ASSET_CANDIDATES[v] || []).slice();
}
function vatVenueMakerCandidates(cfg) {
  const v = vatActiveVenue(cfg);
  return (VAT_VENUE_MAKER_CANDIDATES[v] || []).slice();
}
/* v1.6.10 迁移:旧 cfg.assets → venueAssets.variational;各所给默认表(只跑一次) */
function vatMigrate1610(cfg) {
  if (!cfg || cfg._mig1610) return false;
  let changed = false;
  try {
    cfg.venueAssets = cfg.venueAssets || {};
    if (!Array.isArray(cfg.venueAssets.variational) || !cfg.venueAssets.variational.length) {
      cfg.venueAssets.variational = (Array.isArray(cfg.assets) && cfg.assets.length)
        ? cfg.assets.slice() : VAT_VENUE_ASSETS.variational.slice();
      changed = true;
    }
    if (!Array.isArray(cfg.venueAssets.qfex) || !cfg.venueAssets.qfex.length) {
      cfg.venueAssets.qfex = VAT_VENUE_ASSETS.qfex.slice();
      changed = true;
    }
    if (!Array.isArray(cfg.venueAssets.arcus) || !cfg.venueAssets.arcus.length) {
      cfg.venueAssets.arcus = VAT_VENUE_ASSETS.arcus.slice(); // v1.6.16
      changed = true;
    }
    cfg.venueMakerAssets = cfg.venueMakerAssets || {};
    if (!Array.isArray(cfg.venueMakerAssets.variational) || !cfg.venueMakerAssets.variational.length) {
      cfg.venueMakerAssets.variational = (Array.isArray(cfg.makerAssets) && cfg.makerAssets.length)
        ? cfg.makerAssets.slice() : VAT_VENUE_MAKER_ASSETS.variational.slice();
      changed = true;
    }
    if (!Array.isArray(cfg.venueMakerAssets.qfex) || !cfg.venueMakerAssets.qfex.length) {
      cfg.venueMakerAssets.qfex = VAT_VENUE_MAKER_ASSETS.qfex.slice();
      changed = true;
    }
    cfg._mig1610 = true;
  } catch (_) {}
  return changed;
}
/* v1.6.7:老用户配置迁移(只跑一次,调用方用 cfg._mig167 标记)。
 * - makerAssets 补齐 7 个新标的(用户自己删掉的不再补回)
 * - makerNotionals 给新标的默认值(已有不覆盖)
 * - initialFunds/lifetimeSeed 兜底 0 */
const VAT_MIG167_ASSETS = ["DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"];
const VAT_MIG167_NOTIONALS = VAT_MAKER167_NOTIONALS;
function vatMigrate167(cfg) {
  if (!cfg || cfg._mig167) return false;
  let changed = false;
  try {
    if (!Array.isArray(cfg.makerAssets)) cfg.makerAssets = [];
    for (const a of VAT_MIG167_ASSETS) {
      if (!cfg.makerAssets.includes(a)) { cfg.makerAssets.push(a); changed = true; }
    }
    cfg.makerNotionals = cfg.makerNotionals || {};
    for (const a of VAT_MIG167_ASSETS) {
      if (!cfg.makerNotionals[a]) { cfg.makerNotionals[a] = VAT_MIG167_NOTIONALS[a].slice(); changed = true; }
    }
    if (cfg.initialFunds === undefined) { cfg.initialFunds = 0; changed = true; }
    if (cfg.lifetimeSeed === undefined) { cfg.lifetimeSeed = 0; changed = true; }
  } catch (_) { /* 忽略 */ }
  cfg._mig167 = true;
  return changed;
}

/* v1.6.7:跨天累计已实现(vatLifetime)。跨天 vatBlankState() 重置时保留,
 * 手动重启/浏览器重启都不清零(存在 chrome.storage.local 的 state 里)。
 * 形状 {realizedPnl, trades, wins, losses, startedAt} */
function vatLifetime(st) {
  let lt = st.lifetime;
  if (!lt || typeof lt !== "object") {
    lt = st.lifetime = { realizedPnl: 0, trades: 0, wins: 0, losses: 0, startedAt: 0 };
  }
  return lt;
}
function vatBumpLifetime(st, d) {
  try {
    const lt = vatLifetime(st);
    if (!lt.startedAt) lt.startedAt = Date.now();
    if (d.pnl) lt.realizedPnl += d.pnl;
    if (d.trades) lt.trades += d.trades;
    if (d.wins) lt.wins += d.wins;
    if (d.losses) lt.losses += d.losses;
  } catch (_) { /* 忽略 */ }
}

/* v1.2.4:启动/重启时用交易所真实持仓对账。
 * 本地有记录、链上没有 → 直接清除(用户可能手动平过仓),避免之后平仓被 422 拒绝死循环。
 * 链上接口失败时什么都不动(宁可残留,不误删)。返回 {ok, cleared[]}。 */
async function vatReconcilePositions(api, st) {
  let rows = null;
  try { rows = await api.getPositions(); } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
  if (!rows) return { ok: false, reason: "no data" };
  const cleared = [];
  for (const asset of Object.keys(st.positions || {})) {
    const pos = st.positions[asset];
    const symbol = (pos && pos.symbol) || asset + "-SWAP";
    let qty = 0;
    try { qty = Math.abs(Number(api.positionQtyFor(rows, symbol)) || 0); } catch (_) { qty = 0; }
    if (!qty) { delete st.positions[asset]; cleared.push(asset); }
  }
  for (const a of cleared) vatLog(st, a, "对账: 交易所已无此仓位(可能已手动平仓),本地记录已清除", "warn");
  return { ok: true, cleared };
}

async function vatClosePosition(api, st, asset, pos, cfg, reason, mark) {
  const symbol = pos.symbol || asset + "-SWAP";
  // v1.6.2:硬失败熔断冷却中 → 本轮直接跳过，不碰 API、不刷日志
  if (vatOrderFailBlocked(st, asset, "close", api.now())) return "blocked";
  // v1.2.4:实盘平仓前先问交易所还有多少仓位(用户可能手动部分/全部平过仓):
  // 链上为 0 → 本地记录作废,直接清除,不发单(之前这里 422 死循环);
  // 链上比本地少 → 按链上数量平,避免 reduce-only 超量被拒。
  let closeQty = String(pos.qty);
  if (cfg.liveEnabled && api.getPositions && api.positionQtyFor) {
    let srvQty = null;
    try { srvQty = Math.abs(Number(api.positionQtyFor(await api.getPositions(), symbol)) || 0); }
    catch (_) { srvQty = null; }
    if (srvQty === 0) {
      delete st.positions[asset];
      vatLog(st, asset, "平仓跳过:交易所已无此仓位(可能已手动平仓),本地记录已清除", "warn");
      vatOrderFailClear(st, asset, "close");
      return "gone";
    }
    if (srvQty != null && srvQty < Number(pos.qty)) {
      closeQty = String(srvQty);
      vatLog(st, asset, `按链上实际数量平仓 ${closeQty}(本地记录 ${pos.qty})`, "warn");
    }
  }
  const q = await api.indicativeQuote(symbol, closeQty);
  const side = pos.side === "buy" ? "sell" : "buy";
  const slip = pos.maker ? (cfg.makerSlippage ?? cfg.volumeSlippage)
    : (cfg.mode === "volume" ? cfg.volumeSlippage : cfg.profitSlippage);
  if (cfg.liveEnabled) {
    try {
      const r = await api.placeMarketAuto(symbol, side, closeQty,
        { maxSlippage: slip, reduceOnly: true, dryRun: false });
      const cf = await api.confirmRfq(r.rfqId);
      if (cf.ok === false) {
        // v1.6.2:被拒计入硬失败熔断，达到阈值停手
        const nrej = vatOrderFailTrack(st, asset, "close", `平仓被拒:${cf.status}`, api.now());
        if (nrej >= VAT_ORDER_FAIL_MAX) return "blocked";
        vatLog(st, asset, `平仓被拒: ${cf.status},下轮重试`, "err");
        return false;
      }
      pos.closeStatus = cf.ok === true ? "confirmed" : "pending";
    } catch (e) {
      // v1.2.6:平仓请求超时(成交不确定)→标记,下轮先对账再决策,不盲目重下
      if (e && e.code === "VAT_TIMEOUT") {
        st.orderUncertain = st.orderUncertain || {};
        st.orderUncertain[asset] = { t: api.now(), op: "close" };
        vatLog(st, asset, "平仓请求超时(成交不确定),已标记:下轮先对账再决策,不盲目重下", "warn");
      }
      // v1.2.4:下单硬失败(如 422)时再对一次账;链上已无仓位 → 本地记录作废,不再重试
      let srvQty = null;
      if (api.getPositions && api.positionQtyFor) {
        try { srvQty = Math.abs(Number(api.positionQtyFor(await api.getPositions(), symbol)) || 0); }
        catch (_) { srvQty = null; }
      }
      if (srvQty === 0) {
        delete st.positions[asset];
        vatLog(st, asset, `平仓被拒(${String((e && e.message) || e).slice(0, 100)}),但交易所已无此仓位,本地记录已清除`, "warn");
        vatOrderFailClear(st, asset, "close");
        return "gone";
      }
      // v1.6.2:硬失败计数；达到阈值停手，不再每 tick 盲重试
      const nfail = vatOrderFailTrack(st, asset, "close", (e && e.message) || e, api.now());
      if (nfail >= VAT_ORDER_FAIL_MAX) return "blocked";
      throw e;
    }
  }
  const bid = Number(q.response.bid), ask = Number(q.response.ask);
  const px = side === "sell" ? bid : ask;
  const pnl = (pos.side === "buy" ? px - pos.entry : pos.entry - px) * Number(closeQty);
  delete st.positions[asset];
  st.stats.pnl += pnl;
  st.stats.turnover += pos.notional;
  st.stats.trades++;
  if (pnl >= 0) { st.stats.wins++; st.stats.consecutiveLosses = 0; }
  else { st.stats.losses++; st.stats.consecutiveLosses++; }
  vatBumpLifetime(st, { pnl, trades: 1, wins: pnl >= 0 ? 1 : 0, losses: pnl >= 0 ? 0 : 1 }); // v1.6.7:跨天累计
  vatOrderFailClear(st, asset, "close");
  vatBumpModeStats(st, cfg, api.now(), { pnl, turnover: pos.notional, trades: 1, wins: pnl >= 0 ? 1 : 0, losses: pnl >= 0 ? 0 : 1 });
  vatLog(st, asset,
    `${cfg.liveEnabled ? "LIVE" : "PAPER"} 平仓 ${reason} PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}U`,
    pnl >= 0 ? "ok" : "err");
  return true;
}

async function vatProcessAsset(api, st, asset, cfg) {
  const now = api.now();
  const mk = st.markets[asset] || (st.markets[asset] = {});
  // v1.2.6:上轮下单/平仓请求超时(成交不确定)→先对账再决策,禁止盲目重下。
  // 对账成功:用冷却挡住立刻重下(等信号自然冷却);对账失败:整轮跳过,标记保留。
  if (st.orderUncertain && st.orderUncertain[asset]) {
    let rc = { ok: false, reason: "no api" };
    try { rc = await vatReconcilePositions(api, st); }
    catch (e) { rc = { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; }
    if (!rc.ok) {
      mk.status = "error"; mk.reason = "上轮下单超时,对账失败,本轮跳过"; mk.updated = now;
      vatLog(st, asset, "上轮下单超时且对账失败,本轮跳过(不盲目重下)", "warn");
      return;
    }
    delete st.orderUncertain[asset];
    st.lastSignal[asset] = now; // 对账成功:冷却挡住立刻重下
    vatLog(st, asset, "上轮下单超时已对账,本轮跳过开仓(防重复下单)", "warn");
  }
  let ru;
  try {
    ru = await vatResolveUnderlying(api, st, asset, cfg);
  } catch (e) {
    mk.status = "resolve_fail"; mk.reason = e.message; mk.updated = now;
    throw e;
  }
  const u = ru.underlying;
  // v1.6.5:symbol 必须用解析出的真实 underlying(如 GOLD),不能用配置名(如 XAU),
  // 否则询价/下单走错市场(之前 u= 空导致全 400)
  const symbol = u + (ru.kind === "perpetual_future" ? "-PERP" : "-SWAP");
  // 用 risk_limits 的 mark 记历史(便宜且能感知 venue 开关);信号用 indicative 的 bid/ask
  const riskMark = await api.getRiskMark(u, ru.kind).catch(() => 0);
  if (!(riskMark > 0)) { mk.status = "no_mark"; mk.reason = "risk_limits 无 mark"; mk.updated = now; return; }
  vatPushHist(st, asset, riskMark, now);
  vatPushCandle1m(u, riskMark, now); // v1.6.19:Hedge 5m K线原料

  const p1 = vatBefore(st, asset, 60e3, now);
  const p5 = vatBefore(st, asset, 300e3, now);

  // 持仓管理(不需要 indicative 也能判 TP/SL;平仓时才询价)
  const pos = st.positions[asset];
  if (pos) {
    const prof = vatProfile(cfg.mode, asset);
    const elapsed = (now - pos.opened) / 1000;
    let why = "";
    if (pos.side === "buy") { if (riskMark >= pos.tp) why = "TP"; else if (riskMark <= pos.sl) why = "SL"; }
    else { if (riskMark <= pos.tp) why = "TP"; else if (riskMark >= pos.sl) why = "SL"; }
    if (!why && elapsed >= prof.timeout) why = "TIMEOUT";
    mk.mark = riskMark; mk.updated = now;
    mk.status = "in_position";
    mk.reason = `${pos.side.toUpperCase()} ${pos.qty} 开仓${Math.round(elapsed)}s前`;
    if (why) {
      const cr = await vatClosePosition(api, st, asset, pos, cfg, why, riskMark);
      if (cr === "blocked") {
        const f = vatOrderFailGet(st, asset, "close");
        mk.status = "order_blocked"; mk.updated = now;
        mk.reason = `平仓连续被拒已停手(${f ? f.lastErr : ""})，${f && f.nextRetry ? Math.max(1, Math.ceil((f.nextRetry - now) / 60000)) + "分钟后重试" : "等手动重启"}`;
      }
      return;
    }
    return;
  }

  // 预热:要满 300 秒历史才给信号
  if (!p1 || !p5) {
    const a = (st.history[asset] || []);
    const age = a.length ? Math.max(0, (now - a[0].t) / 1000) : 0;
    mk.status = "warming"; mk.reason = `历史 ${age.toFixed(0)}s / 300s`;
    mk.mark = riskMark; mk.updated = now;
    return;
  }

  // 风控闸(v1.2.5:连续亏损/日亏损熔断只报警不拦单,用户要求熔断后不再卡死;每日开仓数上限保留)
  if (Object.keys(st.positions).length >= cfg.maxPositions) { mk.status = "position_limit"; mk.updated = now; return; }
  if (st.stats.consecutiveLosses >= cfg.maxLosses) vatFuseWarn(st, asset, "loss", `连续亏损 ${st.stats.consecutiveLosses} 次(阈值 ${cfg.maxLosses})`);
  else vatFuseReset(st, "loss");
  if (st.stats.trades >= cfg.maxTrades) { mk.status = "trade_limit"; mk.updated = now; return; }
  const maxLoss = Number(cfg.equity) * Number(cfg.dailyLossPct) / 100;
  if (st.stats.pnl <= -maxLoss) vatFuseWarn(st, asset, "daily", `今日亏损 ${st.stats.pnl.toFixed(2)}U(阈值 -${maxLoss.toFixed(2)}U)`);
  else vatFuseReset(st, "daily");

  // 询价拿 spread(只在要判断信号时才花这一次)
  // 休市退避:某标的询价连续失败(大概率休市报不出价)时退避 60-120s,不空转刷日志;持仓管理不受影响
  st.quoteBackoff = st.quoteBackoff || {};
  const qb0 = st.quoteBackoff[asset];
  if (qb0 && qb0.until > now) {
    mk.status = "no_quote"; mk.mark = riskMark; mk.updated = now;
    mk.reason = `可能休市,${Math.ceil((qb0.until - now) / 1000)}s后重试询价`;
    return;
  }
  let sq;
  try {
    sq = await vatSizedQuote(api, st, asset, cfg, riskMark, symbol);
  } catch (e) {
    let sent = "";
    try {
      const rq = e && e.apiRequest;
      if (rq && rq.body && typeof rq.body === "object") {
        const b = rq.body, iu = (b.instrument || {}).underlying || "";
        sent = ` | 发: ${rq.path} qty=${b.qty || "-"} u=${iu}`;
      }
    } catch (_) { /* 忽略 */ }
    const qbf = (st.quoteBackoff[asset] = st.quoteBackoff[asset] || { n: 0, until: 0 });
    qbf.n++;
    if (qbf.n >= 3) {
      const wait = 60 + Math.floor(Math.random() * 60);
      qbf.until = now + wait * 1000; qbf.n = 0;
      mk.status = "no_quote"; mk.mark = riskMark; mk.updated = now;
      // v1.2.4:只有 TradFi 标的才可能是休市;BTC/ETH 这类 24/7 标的不写误导文案
      const maybeClosed = (typeof TRADFI_UNDERLYINGS !== "undefined" && TRADFI_UNDERLYINGS.has(asset)) ? "可能休市," : "";
      mk.reason = `连续询价失败,${maybeClosed}${wait}s后重试 | ${e.message}${sent}`;
      vatLog(st, asset, `询价连续失败,${maybeClosed}${wait}s后重试 | ${e.message}${sent}`, "warn");
      // 自动诊断:连续询价失败时自己跑一遍精度探测,每小时最多一次,不用用户动手;
      // 全失败记 err,看门狗会自动把诊断发给 Muse
      st.autoProbe = st.autoProbe || {};
      const probeFn = (typeof probeQuote !== "undefined") ? probeQuote : (api && api.probeQuote);
      if (probeFn && now - (st.autoProbe[asset] || 0) > 3600e3) {
        st.autoProbe[asset] = now;
        try {
          const p = await probeFn(symbol, riskMark);
          const rs = p.results || [];
          const okN = rs.filter((r) => r.ok).length;
          const tick = (rs.find((r) => r.ok && r.tick) || {}).tick;
          if (p.markNote) vatLog(st, asset, `自动探测取价: ${p.markNote}`, "warn");
          if (okN > 0) {
            vatLog(st, asset, `自动探测: ${okN}/${rs.length}通过${tick ? `,精度 ${tick} 已记住,下次询价自动取整` : ""}`, "ok");
          } else {
            const det = rs.map((r) => `qty=${r.qty}→${r.httpStatus ? `HTTP${r.httpStatus}` : "?"}`).join(" ");
            vatLog(st, asset, `自动探测: ${rs.length}种精度全部失败 ${det} ${p.markNote || ""}`.slice(0, 480), "err");
          }
        } catch (pe) {
          vatLog(st, asset, `自动探测异常: ${String((pe && pe.message) || pe).slice(0, 120)}`, "warn");
        }
      }
      return;
    }
    mk.status = "size_fail"; mk.reason = e.message + sent; mk.mark = riskMark; mk.updated = now;
    vatLog(st, asset, `询价失败: ${e.message}${sent}`, "err");
    return;
  }
  st.quoteBackoff[asset] = { n: 0, until: 0 }; // 询价恢复,清退避
  const bid = Number(sq.q.response.bid), ask = Number(sq.q.response.ask);
  const mark = Number(sq.q.response.mark_price ?? sq.q.response.markPrice ?? riskMark);
  const spread = mark > 0 ? ((ask - bid) / mark) * 10000 : 999;
  const d1 = vatBps(mark, p1), d5 = vatBps(mark, p5);
  Object.assign(mk, {
    underlying: u, mark, bid, ask, spread, d1, d5,
    qty: sq.qty, margin: sq.need, notional: sq.notional, updated: now, status: "monitoring",
  });

  const prof = vatProfile(cfg.mode, asset);
  mk.thresholds = { spread: prof.sp, d1: prof.d1, d5: prof.d5 };
  const blockers = [];
  if (spread > prof.sp) blockers.push(`spread ${spread.toFixed(2)}>${prof.sp}`);
  if (Math.abs(d1) < prof.d1) blockers.push(`1m ${d1.toFixed(2)}<${prof.d1}`);
  if (Math.abs(d5) < prof.d5) blockers.push(`5m ${d5.toFixed(2)}<${prof.d5}`);
  if (d1 * d5 <= 0) blockers.push("direction conflict");
  if (blockers.length) { mk.status = "no_signal"; mk.reason = blockers.join(" | "); return; }

  // v1.2.7:排列熵入场否决(只否决开仓,不产生信号;点数不足或开关关闭时不否决)
  const entropyVeto = vatGetEntropyVeto();
  if (cfg.entropyFilter && entropyVeto) {
    const hist = ((st.history || {})[asset] || []).map((x) => x.p);
    const ev = entropyVeto(hist, cfg);
    if (ev.pe != null) mk.entropy = Number(ev.pe.toFixed(3));
    if (ev.veto) {
      mk.status = "entropy_skip"; mk.reason = ev.reason; mk.updated = now;
      vatLog(st, asset, `熵否决: ${ev.reason}`, "muted");
      return;
    }
  }

  const last = st.lastSignal[asset] || 0;
  const cool = cfg.mode === "volume" ? 90e3 : 5 * 60e3;
  if (now - last < cool) { mk.status = "cooldown"; mk.reason = `冷却中 ${Math.ceil((cool - (now - last)) / 1000)}s`; return; }

  const side = d5 > 0 ? "buy" : "sell";
  const entry = side === "buy" ? ask : bid;
  const tp = side === "buy" ? entry * (1 + prof.tp) : entry * (1 - prof.tp);
  const sl = side === "buy" ? entry * (1 - prof.sl) : entry * (1 + prof.sl);
  st.lastSignal[asset] = now;

  if (!cfg.liveEnabled) {
    st.positions[asset] = {
      asset, symbol, side, qty: sq.qty, entry, tp, sl,
      opened: now, notional: sq.notional, paper: true,
    };
    st.stats.turnover += sq.notional;
    vatBumpModeStats(st, cfg, now, { turnover: sq.notional });
    mk.status = "paper_open";
    vatLog(st, asset,
      `PAPER ${side.toUpperCase()} qty=${Number(sq.qty).toFixed(6)} entry=${entry} TP=${tp.toFixed(4)} SL=${sl.toFixed(4)}`,
      "warn");
    return;
  }

  const slip = cfg.mode === "volume" ? cfg.volumeSlippage : cfg.profitSlippage;
  // v1.6.2:下单硬失败熔断冷却中 → 本轮跳过
  if (vatOrderFailBlocked(st, asset, "open", now)) {
    const fo = vatOrderFailGet(st, asset, "open");
    mk.status = "order_blocked"; mk.updated = now;
    mk.reason = `下单连续被拒已停手(${fo ? fo.lastErr : ""})`;
    return;
  }
  let r;
  try {
    r = await api.placeMarketAuto(symbol, side, sq.qty, { maxSlippage: slip, reduceOnly: false, dryRun: false });
  } catch (e) {
    // v1.2.6:下单请求超时(成交不确定)→标记,下轮先对账再决策,不盲目重下
    if (e && e.code === "VAT_TIMEOUT") {
      st.orderUncertain = st.orderUncertain || {};
      st.orderUncertain[asset] = { t: now, op: "open" };
      vatLog(st, asset, "下单请求超时(成交不确定),已标记:下轮先对账再决策,不盲目重下", "warn");
    } else {
      // v1.6.2:硬失败计数，达到阈值停手
      const n = vatOrderFailTrack(st, asset, "open", (e && e.message) || e, now);
      if (n >= VAT_ORDER_FAIL_MAX) { mk.status = "order_blocked"; mk.updated = now; mk.reason = "下单连续被拒已停手，见日志"; return; }
    }
    mk.status = "order_fail"; mk.reason = e.message;
    vatLog(st, asset, `下单失败: ${e.message}`, "err");
    return;
  }
  const cf = await api.confirmRfq(r.rfqId);
  if (cf.ok === false) {
    // v1.6.2:被拒计入硬失败熔断
    const n2 = vatOrderFailTrack(st, asset, "open", `下单被拒:${cf.status}`, now);
    if (n2 >= VAT_ORDER_FAIL_MAX) { mk.status = "order_blocked"; mk.updated = now; mk.reason = "下单连续被拒已停手，见日志"; return; }
    mk.status = "rejected"; mk.reason = `下单被拒: ${cf.status}`;
    vatLog(st, asset, `LIVE 下单被拒: ${cf.status}`, "err");
    return;
  }
  st.positions[asset] = {
    asset, symbol, side, qty: r.qty || sq.qty, entry, tp, sl,
    opened: now, notional: sq.notional, rfq_id: r.rfqId, paper: false,
    status: cf.ok === true ? "confirmed" : "pending",
  };
  st.stats.turnover += sq.notional;
  vatBumpModeStats(st, cfg, now, { turnover: sq.notional });
  vatOrderFailClear(st, asset, "open");
  mk.status = "live_open";
  vatLog(st, asset,
    `LIVE ${side.toUpperCase()} 已提交 rfq=${r.rfqId} qty=${Number(r.qty || sq.qty).toFixed(6)} entry≈${entry}`,
    "ok");
}

/* ================= Maker 刷量模式(学 AlphaLabs R2) =================
 * 逻辑:限价挂单(不吃 spread)→等成交(超时撤)→短持仓→TP/SL/超时市价平。
 * 相邻订单间隔随机,方向可交替/随机,波动过大时跳过。 */

function vatRand(a, b) { return a + Math.random() * (b - a); }

/** 字符串数字的小数位数 */
function vatDecimals(s) {
  const p = String(s).split(".");
  return p.length > 1 ? p[1].length : 0;
}
/** 按盘口小数位取整:买向下(不穿 bid)、卖向上(不穿 ask),保证始终是 maker 方向 */
function vatTickPrice(x, decimals, side) {
  const f = Math.pow(10, decimals);
  return (side === "buy"
    ? Math.floor(x * f + 1e-9)
    : Math.ceil(x * f - 1e-9)) / f;
}

function vatMakerState(st) {
  return st.maker || (st.maker = { nextAt: 0, idx: 0, flip: false, pending: null, sym: {} });
}

function vatMakerSchedule(api, st, cfg, minS, maxS) {
  const a = minS != null ? minS : Number(cfg.makerMinDelay);
  const b = maxS != null ? maxS : Number(cfg.makerMaxDelay);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  vatMakerState(st).nextAt = api.now() + Math.round(vatRand(lo, hi) * 1000);
}

/** 风控闸:通过返回 null,否则返回原因(v1.2.5:连续亏损/日亏损熔断只报警不拦单) */
function vatRiskGate(st, cfg) {
  if (st.stats.consecutiveLosses >= cfg.maxLosses) vatFuseWarn(st, "MAKER", "loss", `连续亏损 ${st.stats.consecutiveLosses} 次(阈值 ${cfg.maxLosses})`);
  else vatFuseReset(st, "loss");
  if (st.stats.trades >= cfg.maxTrades) return "达开仓上限";
  const maxLoss = Number(cfg.equity) * Number(cfg.dailyLossPct) / 100;
  if (st.stats.pnl <= -maxLoss) vatFuseWarn(st, "MAKER", "daily", `今日亏损 ${st.stats.pnl.toFixed(2)}U(阈值 -${maxLoss.toFixed(2)}U)`);
  else vatFuseReset(st, "daily");
  return null;
}
/** 手动重启:清连续亏损计数、清熔断告警标记(跨天自动恢复)。v1.2.5 熔断只报警不拦单,重启主要清告警标记。v1.6.2:同时解除下单硬失败熔断。 */
function vatManualRestartReset(st) {
  st.stats = st.stats || {};
  st.stats.consecutiveLosses = 0;
  st.dailyLossOverride = true;
  st.fuseWarned = {};
  st.orderFail = {};
  vatLog(st, "SYSTEM", "手动重启:连续亏损计数已清零,熔断告警已复位(跨天自动恢复),下单失败熔断已解除", "warn");
  return st;
}

/** Maker 可交易标的:在 makerAssets 里且配了 size(基础币)或名义(USDC) */
function vatMakerUniverse(cfg) {
  return vatVenueMakerAssets(cfg).filter((a) =>
    (cfg.makerSizes && cfg.makerSizes[a]) || (cfg.makerNotionals && cfg.makerNotionals[a]));
}

/** 解析 maker 标的:别名 × {swap, perpetual_future} 试 risk_limits,返回 {symbol, underlying, kind}。
 *  v1.6.6:有 mark 的组合必须再过真实询价验证(vatQuoteVerify),400 的跳过,不再缓存"有 mark 但 RFQ 拒单"的代号。 */
async function vatMakerSymbol(api, st, asset, cfg) {
  const mk = vatMakerState(st);
  if (mk.sym[asset]) return mk.sym[asset];
  // v1.6.6:解析失败冷却 5 分钟(与 vatResolveUnderlying 同理,休市时不每轮重打)
  const rc = mk.symCool && mk.symCool[asset];
  if (rc && Date.now() < rc.until) throw new Error(rc.err);
  const aliases = (api.underlyingAliases && api.underlyingAliases[asset]) || [asset];
  const tried = new Set(aliases);
  const failed400 = [];
  for (const u of aliases) {
    for (const kind of ["swap", "perpetual_future"]) {
      const m = await api.getRiskMark(u, kind).catch(() => 0);
      if (!(m > 0)) continue;
      let ok = false;
      try { ok = await vatQuoteVerify(api, st, asset, u, kind, m, Object.assign({ mode: "maker" }, cfg)); }
      catch (e) { throw e; }
      if (!ok) { failed400.push(u + "/" + kind); continue; }
      const r = { symbol: u + (kind === "swap" ? "-SWAP" : "-PERP"), underlying: u, kind };
      mk.sym[asset] = r;
      return r;
    }
  }
  if (failed400.length) {
    vatLog(st, asset, `代号试错:${failed400.join(",")} 询价均 400,转目录模糊匹配`, "warn");
  }
  // v1.6.4:目录模糊匹配兜底(与 profit/volume 共用逻辑)
  try {
    const hit = await vatDirFuzzyResolve(api, st, asset, tried, cfg);
    if (hit) {
      const r = { symbol: hit.underlying + (hit.kind === "swap" ? "-SWAP" : "-PERP"),
        underlying: hit.underlying, kind: hit.kind };
      mk.sym[asset] = r;
      return r;
    }
  } catch (e) { /* fall through */ }
  const errMsg = `${asset} 未能解析可用 underlying(试过 ${aliases.join("/")} × swap/perp)`;
  mk.symCool = mk.symCool || {};
  mk.symCool[asset] = { until: Date.now() + 5 * 60 * 1000, err: errMsg };
  throw new Error(errMsg);
}

/** 成交落定:建仓(市价平仓复用 vatClosePosition) */
function vatMakerOnFill(api, st, cfg, pend, filledQty) {
  const mk = vatMakerState(st);
  const now = api.now();
  const entry = pend.limitPrice;
  const tpPct = Number(cfg.makerTpPct), slPct = Number(cfg.makerSlPct);
  const tp = pend.side === "buy" ? entry * (1 + tpPct) : entry * (1 - tpPct);
  const sl = pend.side === "buy" ? entry * (1 + slPct) : entry * (1 - slPct);
  const notional = filledQty * entry;
  st.positions[pend.asset] = {
    asset: pend.asset, side: pend.side, qty: String(filledQty), entry, tp, sl,
    opened: now, notional, paper: !cfg.liveEnabled, maker: true,
    symbol: pend.symbol, underlying: pend.underlying, kind: pend.kind,
  };
  st.stats.turnover += notional;
  vatBumpModeStats(st, cfg, now, { turnover: notional });
  vatOrderFailClear(st, pend.asset, "open");
  mk.pending = null;
  vatMakerSchedule(api, st, cfg);
  const mkt = st.markets[pend.asset] || (st.markets[pend.asset] = {});
  mkt.status = "in_position"; mkt.updated = now;
  vatLog(st, pend.asset,
    `${cfg.liveEnabled ? "LIVE" : "PAPER"} Maker 成交 ${pend.side.toUpperCase()} ${filledQty.toFixed(6)} @${entry}`, "ok");
}

/** 盯挂单:成交→建仓;超时→撤单(有部成就按部分建仓) */
async function vatMakerWatchPending(api, st, cfg) {
  const mk = vatMakerState(st);
  const pend = mk.pending;
  const now = api.now();
  const mkt = st.markets[pend.asset] || (st.markets[pend.asset] = {});
  let afterQty = pend.beforeQty;
  if (cfg.liveEnabled && api.getPositions && api.positionQtyFor) {
    try { afterQty = api.positionQtyFor(await api.getPositions(), pend.symbol); }
    catch (e) { /* 下轮再看 */ }
  }
  const raw = pend.side === "buy" ? afterQty - pend.beforeQty : pend.beforeQty - afterQty;
  const filled = Math.max(0, raw);
  const want = Number(pend.qty);
  const elapsed = (now - pend.placedAt) / 1000;
  if (filled >= want * 0.98) { vatMakerOnFill(api, st, cfg, pend, filled); return; }
  if (elapsed >= Number(cfg.makerMonitorSecs)) {
    if (cfg.liveEnabled && api.cancelOrder) { try { await api.cancelOrder(pend.orderId); } catch (e) {} }
    if (filled > 0) {
      vatLog(st, pend.asset, `Maker 单超时,部分成交 ${filled.toFixed(6)},已撤余单`, "warn");
      vatMakerOnFill(api, st, cfg, pend, filled);
      return;
    }
    vatLog(st, pend.asset, `Maker 单 ${Math.round(elapsed)}s 未成交,已撤单`, "muted");
    mkt.status = "maker_timeout"; mkt.reason = "未成交已撤"; mkt.updated = now;
    mk.pending = null;
    vatMakerSchedule(api, st, cfg);
    return;
  }
  mkt.status = "maker_pending";
  mkt.reason = `等成交 ${Math.round(elapsed)}/${cfg.makerMonitorSecs}s${filled > 0 ? ` 已部成${filled.toFixed(6)}` : ""}`;
  mkt.updated = now;
}

/** 管 maker 持仓:TP/SL/超时→市价平(复用 vatClosePosition) */
async function vatMakerManage(api, st, cfg) {
  const now = api.now();
  for (const asset of Object.keys(st.positions)) {
    const pos = st.positions[asset];
    if (!pos.maker) continue;
    const mark = await api.getRiskMark(pos.underlying, pos.kind).catch(() => 0);
    const mkt = st.markets[asset] || (st.markets[asset] = {});
    mkt.mark = mark; mkt.updated = now;
    if (!(mark > 0)) { mkt.status = "no_mark"; continue; }
    const elapsed = (now - pos.opened) / 1000;
    let why = "";
    if (pos.side === "buy") { if (mark >= pos.tp) why = "TP"; else if (mark <= pos.sl) why = "SL"; }
    else { if (mark <= pos.tp) why = "TP"; else if (mark >= pos.sl) why = "SL"; }
    if (!why && elapsed >= Number(cfg.makerMaxHoldSecs)) why = "TIMEOUT";
    mkt.status = "in_position";
    mkt.reason = `${pos.side.toUpperCase()} ${pos.qty} 开仓${Math.round(elapsed)}s前`;
    if (why) {
      const crm = await vatClosePosition(api, st, asset, pos, cfg, why, mark);
      if (crm === "blocked") {
        const fm = vatOrderFailGet(st, asset, "close");
        mkt.status = "order_blocked"; mkt.updated = now;
        mkt.reason = `平仓连续被拒已停手(${fm ? fm.lastErr : ""})，${fm && fm.nextRetry ? Math.max(1, Math.ceil((fm.nextRetry - now) / 60000)) + "分钟后重试" : "等手动重启"}`;
      }
    }
  }
}

/** 挂下一单:轮转标的→风控→波动过滤→随机 size/方向→限价挂单 */
async function vatMakerPlace(api, st, cfg) {
  const now = api.now();
  const mk = vatMakerState(st);
  const uni = vatMakerUniverse(cfg);
  if (!uni.length) {
    vatLog(st, "MAKER", "makerAssets 为空或无 size/名义配置,不下单", "err");
    vatMakerSchedule(api, st, cfg, 60, 60);
    return;
  }
  const asset = uni[mk.idx++ % uni.length];
  const mkt = st.markets[asset] || (st.markets[asset] = {});
  if (st.positions[asset]) { vatMakerSchedule(api, st, cfg, 5, 10); return; }
  const gate = vatRiskGate(st, cfg);
  if (gate) {
    mkt.status = "loss_circuit"; mkt.reason = gate; mkt.updated = now;
    vatMakerSchedule(api, st, cfg, 60, 60);
    return;
  }
  let sym;
  try { sym = await vatMakerSymbol(api, st, asset, cfg); }
  catch (e) {
    mkt.status = "resolve_fail"; mkt.reason = e.message; mkt.updated = now;
    vatMakerSchedule(api, st, cfg, 30, 30);
    return;
  }
  const mark = await api.getRiskMark(sym.underlying, sym.kind).catch(() => 0);
  if (!(mark > 0)) {
    mkt.status = "no_mark"; mkt.reason = "risk_limits 无 mark"; mkt.updated = now;
    vatMakerSchedule(api, st, cfg, 15, 15);
    return;
  }
  vatPushHist(st, asset, mark, now);
  vatPushCandle1m(sym.underlying, mark, now); // v1.6.19:Hedge 5m K线原料
  const p1 = vatBefore(st, asset, 60e3, now);
  if (p1) {
    const d1 = vatBps(mark, p1);
    mkt.d1 = d1;
    if (Math.abs(d1) / 10000 > Number(cfg.makerMaxVolPct)) {
      mkt.status = "maker_vol_skip"; mkt.reason = `1m 波动 ${(d1 / 100).toFixed(3)}% 超阈,跳过`;
      mkt.updated = now;
      vatLog(st, asset, `波动过大(${(d1 / 100).toFixed(3)}%),跳过本轮`, "muted");
      vatMakerSchedule(api, st, cfg, 10, 20);
      return;
    }
  }
  const range = cfg.makerSizes[asset];
  const side = cfg.makerAlternate
    ? (mk.flip = !mk.flip, mk.flip ? "buy" : "sell")
    : (Math.random() < 0.5 ? "buy" : "sell");
  let qty;
  try {
    // TradFi 按 USDC 名义换算 qty;币按基础币 size
    const not = (cfg.makerNotionals || {})[asset];
    const raw = not
      ? String(vatRand(not[0], not[1]) / mark)
      : String(vatRand(range[0], range[1]));
    const prep = await api.prepareOrderQty(sym.symbol, raw, side);
    qty = prep.qty;
  } catch (e) {
    mkt.status = "size_fail"; mkt.reason = e.message; mkt.updated = now;
    vatMakerSchedule(api, st, cfg, 15, 15);
    return;
  }
  let bid, ask, bidRaw, askRaw;
  try {
    const q = await api.indicativeQuote(sym.symbol, String(qty));
    bidRaw = String(q.response.bid); askRaw = String(q.response.ask);
    bid = Number(bidRaw); ask = Number(askRaw);
    if (!(bid > 0 && ask > 0)) throw new Error("无 bid/ask");
    mkt.mark = mark; mkt.bid = bid; mkt.ask = ask;
    mkt.spread = ((ask - bid) / mark) * 10000;
  } catch (e) {
    mkt.status = "no_quote"; mkt.reason = e.message + "(可能休市)";
    mkt.updated = now;
    vatMakerSchedule(api, st, cfg, 60, 120); // 休市时拉长重试间隔,避免空转刷日志
    return;
  }
  const off = Number(cfg.makerPriceOffset);
  const pxDec = Math.max(vatDecimals(bidRaw), vatDecimals(askRaw));
  const limitPrice = vatTickPrice(side === "buy" ? bid * (1 - off) : ask * (1 + off), pxDec, side);
  mkt.updated = now;
  if (!cfg.liveEnabled) {
    vatMakerOnFill(api, st, cfg,
      { asset, symbol: sym.symbol, underlying: sym.underlying, kind: sym.kind,
        side, qty, limitPrice, orderId: "paper", placedAt: now, beforeQty: 0 },
      Number(qty));
    return;
  }
  let beforeQty = 0;
  try { beforeQty = api.positionQtyFor(await api.getPositions(), sym.symbol); } catch (e) {}
  let r;
  try {
    r = await api.placeMakerOrder(sym.symbol, side, String(qty), limitPrice, { dryRun: false });
  } catch (e) {
    const detail = e.response ? ` 响应:${JSON.stringify(e.response).slice(0, 200)}` : "";
    mkt.status = "order_fail"; mkt.reason = e.message; mkt.updated = now;
    vatLog(st, asset, `Maker 挂单失败: ${e.message}${detail}`, "err");
    vatMakerSchedule(api, st, cfg, 15, 30);
    return;
  }
  mk.pending = {
    asset, symbol: sym.symbol, underlying: sym.underlying, kind: sym.kind,
    side, qty: r.qty || String(qty), limitPrice, orderId: r.orderId, placedAt: now, beforeQty,
  };
  mkt.status = "maker_pending"; mkt.reason = `已挂 ${side.toUpperCase()} @${limitPrice}`; mkt.updated = now;
  vatLog(st, asset, `LIVE Maker 挂单 ${side.toUpperCase()} ${Number(r.qty || qty).toFixed(6)} @${limitPrice.toFixed(2)}`, "warn");
}

/** Maker 主循环:管仓位→盯挂单→到时间挂下一单 */
async function vatMakerTick(api, st, cfg) {
  const mk = vatMakerState(st);
  const now = api.now();
  await vatMakerManage(api, st, cfg);
  if (mk.pending) { await vatMakerWatchPending(api, st, cfg); return st; }
  if (now >= mk.nextAt) { await vatMakerPlace(api, st, cfg); return st; }
  // 等待期:刷一下标的 mark 供展示,并在下一个标的上显示倒计时
  const uni = vatMakerUniverse(cfg);
  for (const a of uni) {
    const sym = mk.sym[a];
    if (!sym || st.positions[a]) continue;
    try {
      const m = await api.getRiskMark(sym.underlying, sym.kind).catch(() => 0);
      if (m > 0) {
        const mkt = st.markets[a] || (st.markets[a] = {});
        mkt.mark = m; mkt.updated = now;
        if (!mkt.status || mkt.status === "maker_wait") {
          mkt.status = "maker_wait";
          mkt.reason = `${Math.max(0, Math.ceil((mk.nextAt - now) / 1000))}s 后挂单`;
        }
      }
    } catch (e) {}
  }
  return st;
}

/** 跑一轮全部标的;返回 state(调用方负责持久化) */
async function vatTick(cfg, st, api) {
  api = api || vatApi();
  const day = vatDayNY(api.now());
  if (st.date !== day) {
    // maker 模式跨天:先撤掉未成交的挂单,避免孤儿单
    const pend = st.maker && st.maker.pending;
    if (pend && cfg.liveEnabled && api.cancelOrder) {
      try { await api.cancelOrder(pend.orderId); vatLog(st, pend.asset, "跨天已撤未成交挂单", "warn"); }
      catch (e) { /* 忽略 */ }
    }
    const keepLogs = st.logs || [];
    const keepResolved = st.resolved || {};
    const keepLifetime = st.lifetime || null; // v1.6.7:跨天累计不清零
    st = vatBlankState();
    st.date = day; st.logs = keepLogs; st.resolved = keepResolved;
    if (keepLifetime) st.lifetime = keepLifetime;
  }
  // v1.6.2:模式统计初始化/切换检测(切换模式时重置当前模式计数)
  vatModeStats(st, cfg, api.now());
  const uni = cfg.mode === "maker" ? vatVenueMakerAssets(cfg) : vatVenueAssets(cfg);
  if (!(cfg.armed && uni.length)) return st;
  if (cfg.mode === "maker") return vatMakerTick(api, st, cfg);
  for (const asset of vatVenueAssets(cfg)) {
    try {
      await vatProcessAsset(api, st, asset, cfg);
    } catch (e) {
      const mk = st.markets[asset] || (st.markets[asset] = {});
      mk.status = "error"; mk.reason = String(e.message || e); mk.updated = api.now();
      // 把"当时发了什么"也记进日志,下次错误报告里直接能看到服务端原话+请求摘要
      let sent = "";
      try {
        const rq = e && e.apiRequest;
        if (rq && rq.body && typeof rq.body === "object") {
          const b = rq.body, iu = (b.instrument || {}).underlying || "";
          sent = ` | 发: ${rq.path} side=${b.side || "-"} qty=${b.qty || "-"} u=${iu}`;
        } else if (rq) { sent = ` | 发: ${rq.path}`; }
      } catch (_) { /* 忽略 */ }
      vatLog(st, asset, `错误: ${e.message}${sent}`, "err");
    }
  }
  return st;
}

function vatDayNY(nowMs) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(nowMs));
  } catch (e) { return new Date(nowMs).toISOString().slice(0, 10); }
}

/* node 测试用 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    VAT_PARAMS, VAT_HARD_CAP, VAT_ASSETS, VAT_DEFAULT_CONFIG,
    vatSetApi, vatApi, vatSetVenueAdapter, vatActiveAdapter, vatProfile, vatBps, vatBlankState, vatLog,
    vatPushHist, vatBefore, vatPushCandle1m, vatCandles5m, vatResolveUnderlying, vatSizedQuote, vatQuoteVerify,
    vatClosePosition, vatProcessAsset, vatTick, vatDayNY,
    vatRand, vatMakerState, vatMakerSymbol, vatMakerTick, vatRiskGate, vatMakerUniverse,
    vatManualRestartReset, vatReconcilePositions, vatAutoRecoverDue, VAT_RECOVER_INTERVAL_MS,
    vatFuseWarn, vatFuseReset,
    vatDecimals, vatTickPrice,
    vatOrderFailGet, vatOrderFailBlocked, vatOrderFailTrack, vatOrderFailClear,
    VAT_ORDER_FAIL_MAX, VAT_ORDER_FAIL_COOLDOWN_MS, vatModeStats, vatBumpModeStats,
    vatLifetime, vatBumpLifetime, vatMigrate167, vatMigrate1610, vatVenueAssets, vatVenueMakerAssets, vatActiveVenue, VAT_VENUE_ASSETS, VAT_VENUE_MAKER_ASSETS, VAT_MIG167_ASSETS, VAT_MIG167_NOTIONALS, VAT_MAKER167_NOTIONALS, // v1.6.7
  vatVenueAssetCandidates, vatVenueMakerCandidates, VAT_VENUE_ASSET_CANDIDATES, VAT_VENUE_MAKER_CANDIDATES, VAT_VENUE_OVERLAP, VAT_QFEX_CANDIDATES, VAT_ARCUS_CANDIDATES, // v1.6.16
    vatResetApi, vatWireVenueApi, vatBuildVenueLegacyApi, vatVenueLiveGuard, // v1.6.8
  };
  /* v1.2.7:熵模块(entropy.js)在 service worker 里先于本文件加载;node 测试里按需 require */
  try {
    const _ent = require("./entropy.js");
    Object.assign(module.exports, {
      VAT_ENTROPY_M: _ent.VAT_ENTROPY_M,
      vatOrdinalCode: _ent.vatOrdinalCode,
      vatPermutationEntropy: _ent.vatPermutationEntropy,
      vatEntropyVeto: _ent.vatEntropyVeto,
    });
  } catch (e) { /* entropy.js 缺失时策略照常跑(无否决) */ }
}
