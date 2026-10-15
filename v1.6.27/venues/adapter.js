"use strict";
/* v1.3.0: 多所适配器基类与统一接口。
 * 设计原则(铁律):
 * - 所有网络请求 25 秒强制超时(沿用 v1.2.6)。
 * - 统一错误形状:抛 VenueError{code, message, retryable}。
 * - getPositions()/getBalance():有什么给什么,没有的不猜、不编造;查不到返回 null。
 * - 凭证只经构造参数传入,绝不写进心跳/报警/日志/错误报告。
 * 纯类+函数,不依赖 chrome.*,可在 service worker 与 node 测试里跑。
 */

const VAT_ADAPTER_TIMEOUT_MS = 25000;

/** 统一错误。code 取值:
 *  VAT_TIMEOUT(超时:成交不确定,调用方必须先对账再决策,禁止盲目重下)、
 *  VENUE_AUTH(凭证/签名/授权失败)、VENUE_RATE_LIMIT(限流,可重试)、
 *  VENUE_REJECTED(服务端拒绝,携带服务端原话)、
 *  VENUE_NETWORK(网络/解析失败,可重试)、VENUE_UNKNOWN(未知/未实现)。
 */
class VenueError extends Error {
  constructor(code, message, retryable = false, extra) {
    super(message);
    this.name = "VenueError";
    this.code = code;
    this.retryable = !!retryable;
    if (extra && typeof extra === "object") this.detail = extra;
  }
  static timeout(suffix) {
    return new VenueError("VAT_TIMEOUT",
      "请求超时(25秒未响应),已主动中止。" +
      "成交状态不确定:如为下单请求,请先对账(查订单/持仓)再决定是否重下,不要盲目重下。" +
      (suffix ? suffix : ""),
      true);
  }
}

/** 25 秒超时 fetch,返回解析后的 JSON(空响应返回 {})。失败抛 VenueError。 */
async function vatFetchJson(url, { method = "GET", headers = {}, body = null, timeoutMs = VAT_ADAPTER_TIMEOUT_MS } = {}) {
  const init = { method, headers: { Accept: "application/json", ...headers } };
  if (body !== null && body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
  }
  const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  if (ctrl) init.signal = ctrl.signal;
  let timer = null, resp;
  try {
    resp = await Promise.race([
      fetch(url, init),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { if (ctrl) ctrl.abort(); } catch (e) { /* ignore */ }
          reject(VenueError.timeout());
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.code === "VAT_TIMEOUT") throw e;
    const msg = String((e && e.message) || e);
    if (e && (e.name === "AbortError" || /abort/i.test(msg))) throw VenueError.timeout(`(底层:${msg.slice(0, 80)})`);
    throw new VenueError("VENUE_NETWORK", "网络请求失败:" + msg.slice(0, 160), true);
  }
  if (timer) clearTimeout(timer);
  let data = {};
  try { data = await resp.json(); } catch (e) { /* 空响应 */ }
  if (!resp.ok) {
    const why = (data && (data.message || data.error || data.msg)
      ? String(data.message || data.error || data.msg)
      : JSON.stringify(data).slice(0, 300)).slice(0, 300);
    const retryable = resp.status === 429 || resp.status >= 500;
    const err = new VenueError("VENUE_REJECTED", `服务端返回 HTTP ${resp.status}${why ? ": " + why : ""}`, retryable);
    err.httpStatus = resp.status;
    err.response = data;
    throw err;
  }
  return data;
}

/** 统一适配器接口。各 venue 子类实现;不支持的方法保持基类默认(抛 VENUE_UNKNOWN 或返回 null)。 */
class VenueAdapter {
  constructor(id, opts) {
    this.venueId = id;
    opts = opts || {};
    this.creds = opts.creds || {};     // 凭证:调用方从 chrome.storage.local 读出后传入
    this.storage = opts.storage || null; // 可选 {get(k),set(k,v)}:token 缓存等用;缺省用内存 Map
    this._mem = new Map();
  }
  get id() { return this.venueId; }

  /** 市场目录 → [{symbol, base, quote}]。symbol 为本 venue 下单用的标准符号。 */
  async getMarkets() { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: getMarkets 未实现`); }
  /** 报价 → {bid, ask, mark} */
  async getQuote(_symbol) { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: getQuote 未实现`); }
  /** 资金费率 → {rate, interval} | null(无则 null) */
  async getFunding(_symbol) { return null; }
  /** 下单 → {orderId, status:'filled'|'pending'|'rejected'}。
   *  无原生市价单的 venue 用 IOC 限价单模拟(在实现里注明)。 */
  async placeOrder(_o) { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: placeOrder 未实现`); }
  /** 撤单 → true|false */
  async cancelOrder(_orderId) { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: cancelOrder 未实现`); }
  /** 持仓 → [{venue, symbol, side:'long'|'short', qty, entryPrice?, upnl?}]。
   *  只有 venue 实际返回的字段才填,没有的不猜。 */
  async getPositions() { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: getPositions 未实现`); }
  /** 余额 → {equity?, available?} | null。查不到返回 null,绝不编造。 */
  async getBalance() { return null; }
  /** 全部平仓 → {closed} */
  async closeAllPositions() { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: closeAllPositions 未实现`); }
  /** 健康检查:凭证/连接有效返回 true,失效抛 VenueError(VENUE_AUTH/VENUE_NETWORK)。 */
  async checkSession() { throw new VenueError("VENUE_UNKNOWN", `${this.venueId}: checkSession 未实现`); }
  /** 关闭连接(WS 等)。默认无操作。 */
  async disconnect() { /* no-op */ }
  /** 供 strategy.js 复用的旧函数包(与 vatApi() 的键对齐);不支持策略引擎的 venue 返回 null。 */
  getLegacyApi() { return null; }

  async _storeGet(k) {
    try {
      if (this.storage && typeof this.storage.get === "function") return await this.storage.get(k);
    } catch (e) { /* fallthrough */ }
    return this._mem.has(k) ? this._mem.get(k) : null;
  }
  async _storeSet(k, v) {
    try {
      if (this.storage && typeof this.storage.set === "function") { await this.storage.set(k, v); return; }
    } catch (e) { /* fallthrough */ }
    this._mem.set(k, v);
  }
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { VenueError, VenueAdapter, vatFetchJson, VAT_REQUEST_TIMEOUT_MS: VAT_ADAPTER_TIMEOUT_MS, VAT_ADAPTER_TIMEOUT_MS };
}
