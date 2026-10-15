"use strict";
/* v1.3.0 Phase B:Variational 统一适配器。
 * 委托 api.js 的全局函数实现,不复制、不修改 api.js 的任何逻辑(api.js 冻结)。
 * 加载顺序:
 *  - service worker:api.js → venues/adapter.js → venues/variational.js(均为 importScripts 全局)
 *  - node 测试:require("./adapter.js") 取基类;api 函数缺省经 require("../api.js") 拿可导出的子集,
 *    其余(api.js 未导出的)在 node 里取不到 → 测试时必须用 opts.api 注入 mock。
 * 凭证只经构造参数 opts.creds 传入,绝不写进心跳/报警/日志/错误报告。
 */

let _VA_Base = null, _VA_Err = null;
if (typeof VenueAdapter !== "undefined" && typeof VenueError !== "undefined") {
  _VA_Base = VenueAdapter; _VA_Err = VenueError;
} else if (typeof require === "function") {
  const m = require("./adapter.js");
  _VA_Base = m.VenueAdapter; _VA_Err = m.VenueError;
} else {
  throw new Error("VariationalAdapter 需要先加载 venues/adapter.js");
}

/* strategy.js 的 vatApi() 对齐的旧函数包键(14 个) */
const VAT_LEGACY_KEYS = [
  "getRiskMark", "indicativeQuote", "prepareOrderQty", "placeMarketAuto",
  "confirmRfq", "marginNeedFromQuote", "placeMakerOrder", "cancelOrder",
  "getPositions", "positionQtyFor", "sleep", "now",
  "underlyingAliases", "listUnderlyings", "directoryDiag",
];
/* 适配器内部还要用、但不在旧函数包里的 api.js 函数 */
const VAT_EXTRA_KEYS = ["markets", "getFunding", "placeLimit", "checkSession"];

/** 缺省 api 解析:service worker 全局函数优先;node 里 require("../api.js") 补可导出子集。 */
function _defaultApi() {
  const g = (name) =>
    (typeof globalThis !== "undefined" && globalThis[name] !== undefined) ? globalThis[name] : null;
  let mod = null;
  try { if (typeof require === "function") mod = require("../api.js"); } catch (e) { mod = null; }
  const pick = (name) => {
    const gv = g(name);
    if (gv !== undefined && gv !== null) return gv;
    if (mod && mod[name] !== undefined && mod[name] !== null) return mod[name];
    return null;
  };
  const api = {};
  for (const k of VAT_LEGACY_KEYS) api[k] = pick(k);
  for (const k of VAT_EXTRA_KEYS) api[k] = pick(k);
  if (!api.sleep) api.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!api.now) api.now = () => Date.now();
  if (!api.underlyingAliases) api.underlyingAliases = g("UNDERLYING_ALIASES");
  return api;
}

/** 从候选字段里取第一个有限数字;都没有返回 null(绝不编造)。 */
function _firstNum(vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

class VariationalAdapter extends _VA_Base {
  constructor(id, opts) {
    super(id || "variational", opts);
    this._api = (opts && opts.api) ? opts.api : _defaultApi();
  }

  /** 供 strategy.js 复用的旧函数包(与 vatApi() 的键对齐)。 */
  getLegacyApi() {
    const a = this._api || {};
    return {
      getRiskMark: a.getRiskMark || null,
      indicativeQuote: a.indicativeQuote || null,
      prepareOrderQty: a.prepareOrderQty || null,
      placeMarketAuto: a.placeMarketAuto || null,
      confirmRfq: a.confirmRfq || null,
      marginNeedFromQuote: a.marginNeedFromQuote || null,
      placeMakerOrder: a.placeMakerOrder || null,
      cancelOrder: a.cancelOrder || null,
      getPositions: a.getPositions || null,
      positionQtyFor: a.positionQtyFor || null,
      sleep: a.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: a.now || (() => Date.now()),
      underlyingAliases: a.underlyingAliases || null,
      listUnderlyings: a.listUnderlyings || null,
      directoryDiag: a.directoryDiag || null,
    };
  }

  _err(e, ctx) {
    if (e instanceof _VA_Err) return e;
    if (e && e.code === "VAT_TIMEOUT") return _VA_Err.timeout(`(${ctx})`);
    const msg = String((e && e.message) || e).slice(0, 300);
    return new _VA_Err("VENUE_REJECTED", `${ctx}: ${msg}`, false);
  }

  /** 市场目录 → [{symbol, base, quote}]。symbol 用 underlying 名,quote 恒为 USDC。 */
  async getMarkets() {
    try {
      const m = await this._api.markets();
      return Object.keys(m || {}).map((u) => ({ symbol: u, base: u, quote: "USDC" }));
    } catch (e) { throw this._err(e, "读市场目录失败"); }
  }

  /** 询价 → {bid, ask, mark}(从 indicativeQuote 的 response 取真实字段)。 */
  async getQuote(symbol) {
    try {
      const q = await this._api.indicativeQuote(String(symbol).toUpperCase(), "1");
      const r = (q && q.response) || q || {};
      const bid = _firstNum([r.bid, r.bid_price, r.bidPrice]);
      const ask = _firstNum([r.ask, r.ask_price, r.askPrice]);
      const mark = _firstNum([r.mark_price, r.markPrice, r.mark, r.mid_price, r.price,
        q && q.mark]);
      return { bid, ask, mark };
    } catch (e) { throw this._err(e, `询价 ${symbol} 失败`); }
  }

  /** 5m K线 → [{time(秒),open,high,low,close,isFinal}]。
   * v1.6.19:Variational 网页端无公开 K线接口,K线由插件每 tick 的 mark 推送合成
   * (strategy.js vatPushCandle1m → globalThis.VAT_C1M,每 5 分钟持久化一次)。
   * 首次使用需插件持续运行约 4.5 小时积累;不足抛错,Hedge 策略会显示等待原因。 */
  async getCandles(symbol, tf = "5m", limit = 50) {
    try {
      if (String(tf) !== "5m") throw new Error("只支持 5m");
      const fn = (typeof vatCandles5m === "function") ? vatCandles5m
        : (typeof globalThis !== "undefined" && typeof globalThis.vatCandles5m === "function"
          ? globalThis.vatCandles5m : null);
      if (!fn) throw new Error("K线合成函数未加载(strategy.js)");
      return fn(symbol, limit, Date.now());
    } catch (e) { throw this._err(e, `读 K线 ${symbol} 失败`); }
  }

  /** 杠杆校验:Variational 下单不带杠杆参数(杠杆在网页端按市场预设),API 侧无法校验。
   * v1.6.19:只读提示,不抛错;用户需在网页端把对子两腿杠杆设成与插件配置一致。 */
  async verifyLeverage(symbol, expectedLev, expectedMarginMode) {
    return { skipped: true, note: "variational:杠杆在网页端预设,API 无法校验,请确保与插件配置一致" };
  }

  /** 预测资金费率(年化小数) → {rate, interval} | null。SWAP/取不到 → null。 */
  async getFunding(symbol) {
    try {
      const rate = await this._api.getFunding(String(symbol).toUpperCase());
      const n = _firstNum([rate]);
      if (n === null) return null;
      return { rate: n, interval: null }; // api.js 只给年化预测值,interval 未知不编造
    } catch (e) { return null; }
  }

  /** 下单 → {orderId, status}。
   *  market:placeMarketAuto(dryRun:false) + confirmRfq;拒绝抛 VENUE_REJECTED(带服务端原话)。
   *  limit:placeLimit(dryRun:false),RFQ 受理即返回 pending(成交请用持仓复核)。 */
  async placeOrder(o) {
    o = o || {};
    const symbol = String(o.symbol || "").toUpperCase();
    const side = String(o.side || "").toLowerCase();
    const qty = o.qty;
    const type = String(o.type || "market").toLowerCase();
    if (!symbol || (side !== "buy" && side !== "sell") || !(Number(qty) > 0)) {
      throw new _VA_Err("VENUE_UNKNOWN", "placeOrder 参数不全(symbol/side/qty)");
    }
    try {
      if (type === "market") {
        const r = await this._api.placeMarketAuto(symbol, side, qty,
          { dryRun: false, reduceOnly: !!o.reduceOnly });
        const rfqId = r && (r.rfqId || r.orderId);
        if (!rfqId) throw new _VA_Err("VENUE_REJECTED", "市价单被拒:服务端未返回 rfq_id");
        const c = await this._api.confirmRfq(rfqId);
        if (c && c.ok === false) {
          throw new _VA_Err("VENUE_REJECTED",
            `市价单被服务端拒绝(RFQ ${rfqId},状态:${c.status || "?"})`);
        }
        return { orderId: String(rfqId), status: (c && c.ok === true) ? "filled" : "pending" };
      }
      if (type === "limit") {
        const r = await this._api.placeLimit(symbol, side, qty, o.price, { dryRun: false });
        const oid = r && (r.orderId || r.rfqId);
        if (!oid) throw new _VA_Err("VENUE_REJECTED", "限价单被拒:服务端未返回订单号");
        return { orderId: String(oid), status: "pending" };
      }
      throw new _VA_Err("VENUE_UNKNOWN", `variational 不支持的订单类型: ${type}`);
    } catch (e) { throw this._err(e, "下单失败"); }
  }

  /** 撤单 → true|false(api 的 cancelOrder 逐字段试,成功即 true)。 */
  async cancelOrder(orderId) {
    try {
      return !!(await this._api.cancelOrder(orderId));
    } catch (e) { throw this._err(e, "撤单失败"); }
  }

  /** 持仓 → [{venue, symbol, side, qty, entryPrice?, upnl?}]。
   *  symbol:用 UNDERLYING_ALIASES 的 key,在行 JSON 里按别名匹配 underlying;
   *  side 由 qty 正负定;entryPrice/upnl 只有原始字段真实存在时才填,不存在就省略,绝不编造。 */
  async getPositions() {
    let rows;
    try {
      rows = await this._api.getPositions();
    } catch (e) { throw this._err(e, "读持仓失败"); }
    rows = Array.isArray(rows) ? rows : [];
    const aliases = (this._api.underlyingAliases) || {};
    // 别名→canonical key,按别名长度降序(长别名优先,避免 "USOIL" 误命中 "UKOILP" 一类)
    const aliasList = [];
    for (const key of Object.keys(aliases)) {
      for (const a of (aliases[key] || [])) aliasList.push([String(a).toUpperCase(), key]);
    }
    aliasList.sort((x, y) => y[0].length - x[0].length);
    const matchSymbol = (json) => {
      for (const [alias, key] of aliasList) {
        if (json.indexOf('"' + alias + '"') >= 0) return key;
      }
      return null;
    };
    const out = [];
    for (const p of rows) {
      if (!p || typeof p !== "object") continue;
      const info = (p.position_info && typeof p.position_info === "object") ? p.position_info : p;
      const n = _firstNum([info.qty, info.quantity, info.size, p.qty, p.quantity, p.size]);
      if (n === null || n === 0) continue;
      const rec = {
        venue: "variational",
        symbol: matchSymbol(JSON.stringify(p)) || "?",
        side: n > 0 ? "long" : "short",
        qty: n,
      };
      const ep = _firstNum([info.entry_price, info.entryPrice, info.avg_price, info.avgPrice,
        p.entry_price, p.entryPrice, p.avg_price, p.avgPrice]);
      if (ep !== null) rec.entryPrice = ep;
      const up = _firstNum([info.upnl, info.unrealized_pnl, info.unrealizedPnl,
        p.upnl, p.unrealized_pnl, p.unrealizedPnl]);
      if (up !== null) rec.upnl = up;
      out.push(rec);
    }
    return out;
  }

  /** 余额:端点尚未从真实网页流量确认 → 直接返回 null(铁律:绝不编造)。 */
  async getBalance() { return null; }

  /** 全部平仓:对每个 canonical 持仓用 placeMarketAuto 反向 reduceOnly 平仓 → {closed}。 */
  async closeAllPositions() {
    const pos = await this.getPositions();
    let closed = 0;
    let firstErr = null;
    for (const p of pos) {
      try {
        await this._api.placeMarketAuto(p.symbol, p.side === "long" ? "sell" : "buy",
          Math.abs(p.qty), { dryRun: false, reduceOnly: true });
        closed++;
      } catch (e) { if (!firstErr) firstErr = e; }
    }
    if (closed === 0 && firstErr) throw this._err(firstErr, "平仓失败");
    return { closed };
  }

  /** 会话检查:能调通持仓接口即有效。 */
  async checkSession() {
    try {
      await this._api.checkSession();
      return true;
    } catch (e) { throw this._err(e, "会话检查失败"); }
  }

  /** 无持久连接,断开无操作。 */
  async disconnect() { /* no-op */ }
}

/* service worker 全局注册(供 venues/index.js 经 globalThis 查找;class 声明本身不挂 globalThis) */
if (typeof globalThis !== "undefined") globalThis.VariationalAdapter = VariationalAdapter;

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { VariationalAdapter };
}
