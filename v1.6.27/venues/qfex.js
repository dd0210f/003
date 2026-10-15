"use strict";
/* v1.3.0: QFEX 适配器 (qfex.com / UAT qfex.io)。
 *
 * 调研依据: research/v130_venue_briefs.md 第 1 节,严格遵守——
 * - 交易 WS wss://trade.qfex.com/(下单只能走 WS);行情 WS wss://mds.qfex.com/;
 *   creds.useUat=true 时切 wss://trade.qfex.io/ + wss://mds.qfex.io/。
 *   REST base URL 文档未明确:不猜,不实现 REST。
 * - 认证:API Key qfex_pub_…/qfex_secret_… 经 creds {apiKey, apiSecret, useUat} 传入;
 *   交易 WS 发 auth 消息,HMAC-SHA256 签名原文严格为 nonce + ":" + unixSeconds(brief 原话)。
 * - 下单 add_order(MARKET order_time_in_force=IOC / LIMIT order_time_in_force=GTC|IOC|FOK,reduce_only 独立布尔);
 *   撤单 cancel_order(order_id);订单 ACK 与成交两阶段异步(先 ACK 拿 order_id,再等
 *   FILLED/CANCELLED/REJECTED 执行报告)。
 * - 坑:500ms speed bump 只影响限价单(市价单不受影响);cancel_on_disconnect 掉线自动全撤。
 * - 持仓/余额:v1.6.9 已用 REST 落实 —— GET {api.qfex.com|api.qfex.io}/user/positions
 *   → {balance:{...}, positions:[...]}(第三方实现 FueledByChai QfexBroker 实锤字段:
 *   positions[] 内 symbol/position(带符号)/average_price;
 *   balance 内 available_balance,权益=deposit+realised_pnl+unrealised_pnl+net_funding)。
 *   私有请求头 x-qfex-public-key/x-qfex-hmac-signature/x-qfex-nonce/x-qfex-timestamp,
 *   签名原文 nonce+":"+unixSeconds(与 WS auth 一致)。base URL 经 /refdata 公开端点实测确认。
 * - 资金费每小时结算,但查询端点未确认:getFunding 返回 null。
 * - 市场符号实测(2026-10-09 /refdata,250 个市场):GOLD-USD(黄金)/SILVER-USD(白银)/
 *   US100-USD/US500-USD(股指)/CL-USD(WTI 原油);无 BRENT/UKOIL(只有 WTI)。
 *
 * 铁律(沿用 venues/adapter.js):
 * - 所有网络请求 25 秒强制超时(VAT_REQUEST_TIMEOUT_MS);成交不确定时调用方必须先对账。
 * - 统一错误形状 VenueError{code,message,retryable}。
 * - 凭证只经构造参数传入,绝不进日志/心跳/报警/错误报告(本文件无任何 console 输出)。
 * - 传输可注入:opts.transport={WebSocket};缺省用 globalThis.WebSocket(service worker 原生支持 WS)。
 * - 签名可注入:opts.hmac=async(message,secret)=>hex;缺省优先 globalThis.crypto.subtle,无则 node crypto。
 *
 * 未确认、需 UAT 实测的点(见各方法注释):
 *  1) auth/add_order/cancel_order/subscribe 等消息的精确字段名(按公开文档实现,UAT 复核);
 *  2) 持仓/余额私有查询的响应字段映射(已留 plumbing,映射前抛 VENUE_UNKNOWN);
 *  3) CL 等 TradFi 代码的确切 market symbol(用 market symbols 实查,不猜)。
 *
 * 纯类+函数,不依赖 chrome.*,可在 service worker 与 node 测试里跑。
 */

/* ---- 基类来源:node 下 require("./adapter.js");浏览器/MV3 下 adapter.js 先加载,
 * 顶层 class 绑定在全局词法环境,直接引用(不用 new Function,避开 MV3 CSP)。 ---- */
let VA_Adapter = null, VA_Error = null, VA_TIMEOUT_MS = 25000, VA_FetchJson = null;
if (typeof require === "function") {
  try {
    const _b = require("./adapter.js");
    VA_Adapter = _b.VenueAdapter;
    VA_Error = _b.VenueError;
    VA_TIMEOUT_MS = _b.VAT_REQUEST_TIMEOUT_MS;
    VA_FetchJson = _b.vatFetchJson || null;
  } catch (e) { /* 浏览器分支:走下面的全局引用 */ }
}
if (!VA_Adapter && typeof VenueAdapter !== "undefined") VA_Adapter = VenueAdapter;
if (!VA_Error && typeof VenueError !== "undefined") VA_Error = VenueError;
if (!VA_FetchJson && typeof vatFetchJson !== "undefined") VA_FetchJson = vatFetchJson;
if (typeof VAT_REQUEST_TIMEOUT_MS !== "undefined") VA_TIMEOUT_MS = VAT_REQUEST_TIMEOUT_MS;

const QFEX_TRADE_WS_PROD = "wss://trade.qfex.com/";
const QFEX_MD_WS_PROD = "wss://mds.qfex.com/";
const QFEX_TRADE_WS_UAT = "wss://trade.qfex.io/";
const QFEX_MD_WS_UAT = "wss://mds.qfex.io/";
/* v1.6.9:REST base(实测确认)。依据:
 * - https://api.qfex.com/refdata 公开可达(2026-10-09 实测,250 个市场,符号如 GOLD-USD/CL-USD);
 * - 第三方实现 FueledByChai/FueledByChaiTrading commons/qfex-common-api(QfexConfiguration:
 *   prod=https://api.qfex.com, uat=https://api.qfex.io; QfexRestApi:GET /user/positions;
 *   私有请求头 x-qfex-public-key/x-qfex-hmac-signature/x-qfex-nonce/x-qfex-timestamp)。 */
const QFEX_REST_PROD = "https://api.qfex.com";
const QFEX_REST_UAT = "https://api.qfex.io";

/** 缺省 HMAC-SHA256 实现,返回 hex。优先浏览器/MV3 的 crypto.subtle(异步),无则 node crypto。 */
async function defaultHmacSha256Hex(message, secret) {
  const G = (typeof globalThis !== "undefined") ? globalThis : {};
  const subtle = (G.crypto && G.crypto.subtle) ? G.crypto.subtle : null;
  if (subtle) {
    const enc = new TextEncoder();
    const key = await subtle.importKey("raw", enc.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await subtle.sign("HMAC", key, enc.encode(String(message)));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (typeof require === "function") {
    const crypto = require("crypto");
    return crypto.createHmac("sha256", String(secret)).update(String(message), "utf8").digest("hex");
  }
  throw new VA_Error("VENUE_UNKNOWN", "qfex: 当前环境无可用的 HMAC-SHA256 实现");
}

function _qxNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 极简 WS 客户端:request/response 按 request_id 相关(25s 超时),
 * 执行报告等异步推送按 order_id 分发给 waitForFill,订阅推送走 waitPush。 */
class _QfexWs {
  constructor(WSImpl, url, opts) {
    this._WSImpl = WSImpl;
    this.url = url;
    this.timeoutMs = (opts && opts.timeoutMs) || VA_TIMEOUT_MS;
    this.ws = null;
    this._seq = 0;
    this._pending = new Map();    // request_id -> {resolve,reject,timer}
    this._fillWaiters = new Map(); // orderId -> Set<entry>
    this._pushWaiters = [];        // [{key,match,resolve,reject,timer}]
  }
  isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }
  connect() {
    const self = this;
    // v1.6.26:错误信息里隐去 URL 查询参数(api_key),避免公钥进日志/看门狗上报
    const safeUrl = String(self.url).split("?")[0];
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { if (self.ws) self.ws.close(); } catch (e) { /* ignore */ }
        reject(VA_Error.timeout("qfex: WS 连接超时: " + safeUrl));
      }, self.timeoutMs);
      let ws;
      try {
        ws = new self._WSImpl(self.url);
      } catch (e) {
        clearTimeout(timer);
        reject(new VA_Error("VENUE_NETWORK", "qfex: WS 构造失败: " + String((e && e.message) || e), true));
        return;
      }
      self.ws = ws;
      ws.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new VA_Error("VENUE_NETWORK", "qfex: WS 连接失败: " + safeUrl, true));
      };
      ws.onclose = () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new VA_Error("VENUE_NETWORK", "qfex: WS 连接被关闭: " + safeUrl, true));
          return;
        }
        self._failAll(new VA_Error("VENUE_NETWORK", "qfex: WS 已断开,未完成的请求已取消", true));
      };
      ws.onmessage = (ev) => self._onMessage(ev);
    });
  }
  _onMessage(ev) {
    let msg = null;
    try {
      const raw = (ev && typeof ev.data === "string") ? ev.data : String(ev && ev.data);
      msg = JSON.parse(raw);
    } catch (e) { return; /* 非 JSON 帧忽略 */ }
    if (!msg || typeof msg !== "object") return;
    // 1) 请求/响应相关
    if (msg.request_id != null) {
      const key = String(msg.request_id);
      const p = this._pending.get(key);
      if (p) {
        this._pending.delete(key);
        clearTimeout(p.timer);
        if (msg.ok === false || msg.error) {
          p.reject(new VA_Error("VENUE_REJECTED",
            "qfex: 请求被拒(" + String(msg.type || "?") + "): " +
            String(msg.error || msg.message || msg.reason || "未知原因").slice(0, 200)));
        } else {
          p.resolve(msg);
        }
        return;
      }
    }
    // 2) 执行报告等异步推送:按 order_id 分发
    const oid = msg.order_id != null ? String(msg.order_id)
      : (msg.orderId != null ? String(msg.orderId) : null);
    const mtype = String(msg.type || msg.msg_type || "").toLowerCase();
    if (oid && (mtype.indexOf("execution") >= 0 || mtype.indexOf("order") >= 0 || mtype.indexOf("fill") >= 0)) {
      const set = this._fillWaiters.get(oid);
      if (set && set.size) {
        for (const w of Array.from(set)) {
          set.delete(w);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
        return;
      }
    }
    // 3) 订阅推送:走 waitPush 的 match
    for (let i = this._pushWaiters.length - 1; i >= 0; i--) {
      const w = this._pushWaiters[i];
      let hit = false;
      try { hit = !!w.match(msg); } catch (e) { hit = false; }
      if (hit) {
        this._pushWaiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }
  request(type, params, opts) {
    const self = this;
    const timeoutMs = (opts && opts.timeoutMs) || this.timeoutMs;
    return new Promise((resolve, reject) => {
      if (!self.isOpen()) {
        reject(new VA_Error("VENUE_NETWORK", "qfex: WS 未连接,无法发送 " + type, true));
        return;
      }
      const request_id = "vat" + Date.now().toString(36) + "_" + (++self._seq);
      // v1.6.10:官方 trade WS 信封为 {"type","params"}(官方 CLI server.go/trade_ws.go 实锤),
      // 参数一律包进 params,不再平铺
      const msg = { type, request_id };
      if (params && Object.keys(params).length) msg.params = params;
      const timer = setTimeout(() => {
        self._pending.delete(request_id);
        reject(VA_Error.timeout("qfex: " + type + " 请求超时"));
      }, timeoutMs);
      self._pending.set(request_id, { resolve, reject, timer });
      try {
        self.ws.send(JSON.stringify(msg));
      } catch (e) {
        self._pending.delete(request_id);
        clearTimeout(timer);
        reject(new VA_Error("VENUE_NETWORK", "qfex: WS 发送失败: " + String((e && e.message) || e), true));
      }
    });
  }
  /** 等待某订单的执行报告(异步推送),超时抛 VAT_TIMEOUT。 */
  waitForFill(orderId, timeoutMs) {
    const self = this;
    const key = String(orderId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const set = self._fillWaiters.get(key);
        if (set) set.delete(entry);
        reject(VA_Error.timeout("qfex: 等待订单 " + key + " 的执行报告超时(10秒未收到 FILLED/CANCELLED/REJECTED)"));
      }, timeoutMs);
      const entry = { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject, timer };
      if (!self._fillWaiters.has(key)) self._fillWaiters.set(key, new Set());
      self._fillWaiters.get(key).add(entry);
    });
  }
  /** 等待订阅推送命中 match 的首条消息。 */
  waitPush(key, match, timeoutMs) {
    const self = this;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = self._pushWaiters.indexOf(entry);
        if (i >= 0) self._pushWaiters.splice(i, 1);
        reject(VA_Error.timeout("qfex: 等待推送(" + key + ")超时"));
      }, timeoutMs || self.timeoutMs);
      const entry = { key, match, resolve: (m) => { clearTimeout(timer); resolve(m); }, reject, timer };
      self._pushWaiters.push(entry);
    });
  }
  _failAll(err) {
    for (const [, p] of this._pending) { clearTimeout(p.timer); try { p.reject(err); } catch (e) {} }
    this._pending.clear();
    for (const [, set] of this._fillWaiters) {
      for (const w of set) { clearTimeout(w.timer); try { w.reject(err); } catch (e) {} }
    }
    this._fillWaiters.clear();
    for (const w of this._pushWaiters.splice(0)) { clearTimeout(w.timer); try { w.reject(err); } catch (e) {} }
  }
  close() {
    this._failAll(new VA_Error("VENUE_NETWORK", "qfex: WS 已关闭", true));
    try { if (this.ws) this.ws.close(); } catch (e) { /* ignore */ }
    this.ws = null;
  }
}

class QfexAdapter extends VA_Adapter {
  constructor(id, opts) {
    if (id && typeof id === "object") { opts = id; id = "qfex"; }
    super("qfex", opts);
    opts = opts || {};
    const useUat = !!(this.creds && this.creds.useUat);
    this.tradeUrl = useUat ? QFEX_TRADE_WS_UAT : QFEX_TRADE_WS_PROD;
    this.mdUrl = useUat ? QFEX_MD_WS_UAT : QFEX_MD_WS_PROD;
    const G = (typeof globalThis !== "undefined") ? globalThis : {};
    this._WSImpl = (opts.transport && opts.transport.WebSocket) || G.WebSocket;
    if (!this._WSImpl) {
      throw new VA_Error("VENUE_UNKNOWN", "qfex: 无可用 WebSocket 实现(请经 opts.transport 注入)");
    }
    this._hmac = (typeof opts.hmac === "function") ? opts.hmac : defaultHmacSha256Hex;
    this.requestTimeoutMs = opts.requestTimeoutMs || VA_TIMEOUT_MS; // 缺省 25s 铁律
    this.fillWaitMs = (opts.fillWaitMs != null) ? opts.fillWaitMs : 10000; // 执行报告最多等 10 秒
    this._tradeWs = null;
    this._mdWs = null;
    this._cancelOnDisconnect = false;
    this._lastTradeWsFailAt = 0; // v1.6.24:上次 trade WS 握手失败时间戳,用于握手退避
  }

  /** 交易 WS:连接 + auth。auth 成功即视为会话健康。 */
  async _ensureTradeWs() {
    if (this._tradeWs && this._tradeWs.isOpen()) return this._tradeWs;
    // v1.6.24:握手退避——上次握手失败 10 分钟内不再建连。QFEX 文档明确"初始 WS 握手有独立管控",
    // 高频 hammering 只会加重限流;退避期间直接失败并提示,窗口过后自动恢复。
    const nowMs = Date.now();
    if (this._lastTradeWsFailAt && nowMs - this._lastTradeWsFailAt < 600000) {
      const waitMin = Math.max(1, Math.ceil((600000 - (nowMs - this._lastTradeWsFailAt)) / 60000));
      throw new VA_Error("VENUE_NETWORK",
        "qfex: WS 握手退避中(距上次失败不足 10 分钟,还差约 " + waitMin + " 分钟):为避免触发 QFEX 握手层限流已跳过建连;点 QFEX 探测看一次定位结论", true);
    }
    const apiKey = this.creds && this.creds.apiKey;
    const apiSecret = this.creds && this.creds.apiSecret;
    if (!apiKey || !apiSecret) {
      throw new VA_Error("VENUE_AUTH",
        "qfex: 未配置 API Key(creds.apiKey/apiSecret)。请在官网 Developer Settings 生成(需 2FA,secret 只显示一次)后填入插件本机存储");
    }
    const wsUrl = this.tradeUrl + (this.tradeUrl.indexOf("?") >= 0 ? "&" : "?") +
      "api_key=" + encodeURIComponent(apiKey);
    // v1.6.26:trade WS 握手必须在 URL 上带 api_key 查询参数,浏览器 WebSocket 无法自定义握手头,
    // 查询参数是唯一可行方式。实测(2026-10-15):裸 wss://trade.qfex.com/ 握手 → 401
    // "no authentication credentials provided";带 ?api_key=xxx → 网关识别为凭证(假 key 报
    // "invalid credentials");mds 公开 WS 裸连 101 不受影响。结论:握手层按 api_key 识别用户
    // (与文档"初始 WS 握手有独立管控"一致),之前"裸连上再发 auth 消息"的假设是错的——根本连不上。
    // 连上后仍按原流程发 auth 消息(HMAC),完成真正的身份认证。
    const ws = new _QfexWs(this._WSImpl, wsUrl, { timeoutMs: this.requestTimeoutMs });
    try { await ws.connect(); }
    catch (e) { this._lastTradeWsFailAt = Date.now(); throw e; } // v1.6.24:记录握手失败,触发退避
    // HMAC-SHA256 签名,原文格式严格为 nonce + ":" + unixSeconds(brief 原话)。
    // auth 消息字段名按公开文档实现;UAT 实测时复核。凭证绝不进日志(本文件无日志)。
    const nonce = Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
    const unixSeconds = Math.floor(Date.now() / 1000);
    let signature;
    try {
      signature = await this._hmac(nonce + ":" + unixSeconds, apiSecret);
    } catch (e) {
      try { ws.close(); } catch (_) { /* ignore */ }
      throw new VA_Error("VENUE_AUTH", "qfex: 签名失败: " + String((e && e.message) || e));
    }
    let resp;
    try {
      // v1.6.10:auth 消息按官方 CLI(trade_ws.go buildAuthMessage)格式:
      // {"type":"auth","params":{"hmac":{"public_key","nonce","unix_ts","signature"}}}
      // (request() 会把参数包进 params)
      resp = await ws.request("auth",
        { hmac: { public_key: apiKey, nonce, unix_ts: unixSeconds, signature } },
        { timeoutMs: this.requestTimeoutMs });
    } catch (e) {
      try { ws.close(); } catch (_) { /* ignore */ }
      throw e;
    }
    const ok = !!resp && (resp.ok === true || resp.authenticated === true ||
      resp.authorized === true || String(resp.status || "").toLowerCase() === "ok");
    if (!ok) {
      try { ws.close(); } catch (_) { /* ignore */ }
      throw new VA_Error("VENUE_AUTH",
        "qfex: WS 认证失败: " + String((resp && (resp.error || resp.message || resp.reason)) || "服务端未确认认证"));
    }
    this._tradeWs = ws;
    if (this._cancelOnDisconnect) {
      try {
        await ws.request("cancel_on_disconnect", { enabled: true }, { timeoutMs: this.requestTimeoutMs });
      } catch (e) { /* 认证已过;设置失败不阻断,下次重连再试 */ }
    }
    return ws;
  }

  /** 行情 WS(mds):公开行情,无需认证。 */
  async _ensureMdWs() {
    if (this._mdWs && this._mdWs.isOpen()) return this._mdWs;
    const ws = new _QfexWs(this._WSImpl, this.mdUrl, { timeoutMs: this.requestTimeoutMs });
    await ws.connect();
    this._mdWs = ws;
    return ws;
  }

  /** 交易 WS 私有查询的请求/响应 plumbing(按 request_id 相关,25s 超时)。
   * 字段映射不在这里做——各查询方法在映射前按"字段未确认"抛 VENUE_UNKNOWN。 */
  async _privateQuery(type, params) {
    const ws = await this._ensureTradeWs();
    return ws.request(type, params || {}, { timeoutMs: this.requestTimeoutMs });
  }

  /* v1.6.9:REST 私有请求。认证头(第三方实现 QfexRestApi 实锤,签名原文与 WS auth 一致
   * nonce+":"+unixSeconds):x-qfex-public-key/x-qfex-hmac-signature/x-qfex-nonce/x-qfex-timestamp。
   * 401→VENUE_AUTH(凭证错),429→VENUE_RATE_LIMIT,其余→原错误。凭证绝不进日志。 */
  _restBase() {
    const useUat = !!(this.creds && this.creds.useUat);
    return useUat ? QFEX_REST_UAT : QFEX_REST_PROD;
  }
  _restCreds() {
    const apiKey = this.creds && this.creds.apiKey;
    const apiSecret = this.creds && this.creds.apiSecret;
    if (!apiKey || !apiSecret) {
      throw new VA_Error("VENUE_AUTH",
        "qfex: 未配置 API Key(creds.apiKey/apiSecret)。请在官网 Developer Settings 生成(需 2FA,secret 只显示一次)后填入插件本机存储");
    }
    return { apiKey, apiSecret };
  }
  async _restGet(path, { auth = true } = {}) {
    if (!VA_FetchJson) throw new VA_Error("VENUE_UNKNOWN", "qfex: 无可用 fetch 实现");
    const headers = {};
    if (auth) {
      const { apiKey, apiSecret } = this._restCreds();
      const nonce = Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
      const unixSeconds = Math.floor(Date.now() / 1000);
      let signature;
      try { signature = await this._hmac(nonce + ":" + unixSeconds, apiSecret); }
      catch (e) { throw new VA_Error("VENUE_AUTH", "qfex: 签名失败: " + String((e && e.message) || e)); }
      headers["x-qfex-public-key"] = apiKey;
      headers["x-qfex-hmac-signature"] = signature;
      headers["x-qfex-nonce"] = nonce;
      headers["x-qfex-timestamp"] = String(unixSeconds);
    }
    try {
      return await VA_FetchJson(this._restBase() + path, { headers, timeoutMs: this.requestTimeoutMs });
    } catch (e) {
      if (e && e.httpStatus === 401) {
        throw new VA_Error("VENUE_AUTH", "qfex: REST 认证失败(401),请检查 API Key 是否正确/过期", false);
      }
      if (e && e.httpStatus === 429) {
        throw new VA_Error("VENUE_RATE_LIMIT", "qfex: REST 限流(429),稍后重试", true);
      }
      throw e;
    }
  }

  /* v1.6.9:市场精度缓存(公开 refdata,无需认证,5 分钟 TTL)。
   * 实测字段(2026-10-09):data[] 内 symbol/tick_size/lot_size/min_quantity/max_quantity/
   * base_asset/quote_asset/default_max_leverage。 */
  async _refdata() {
    const now = Date.now();
    if (this._refdataCache && now - this._refdataAt < 5 * 60 * 1000) return this._refdataCache;
    const r = await this._restGet("/refdata", { auth: false });
    const arr = (r && (Array.isArray(r.data) ? r.data : (Array.isArray(r) ? r : []))) || [];
    const out = {};
    for (const m of arr) {
      const sym = m && (m.symbol || m.market);
      if (!sym) continue;
      const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
      out[sym] = {
        symbol: sym,
        tickSize: num(m.tick_size), lotSize: num(m.lot_size),
        minQuantity: num(m.min_quantity), maxQuantity: num(m.max_quantity),
        baseAsset: m.base_asset || null, quoteAsset: m.quote_asset || null,
        maxLeverage: num(m.default_max_leverage),
      };
    }
    this._refdataCache = out;
    this._refdataAt = now;
    return out;
  }
  /** 合约精度 → {tickSize, lotSize, minQuantity, maxQuantity, maxLeverage} | null */
  async getContract(symbol) {
    if (!symbol) return null;
    const all = await this._refdata().catch(() => ({}));
    return all[symbol] || null;
  }

  /* v1.6.19:5m K线 → [{time(秒),open,high,low,close,isFinal}]。
   * QFEX REST /candles 只支持 1MIN/1HOUR/1DAY 等(2026-10-11 实测 5m 报 unsupported resolution),
   * 用 resolution=1MIN 拉最近 ~6 小时再本地聚成 5m。公开接口,无需认证。 */
  async getCandles(symbol, tf = "5m", limit = 50) {
    if (!symbol) throw new VA_Error("VENUE_UNKNOWN", "qfex: getCandles 缺少 symbol");
    if (String(tf) !== "5m") throw new VA_Error("VENUE_UNKNOWN", "qfex: getCandles 只支持 5m");
    const need = (Number(limit) || 50) + 1;
    const nowMs = Date.now();
    const toISO = new Date(nowMs).toISOString();
    const fromISO = new Date(nowMs - 400 * 60000).toISOString(); // 多拉一点防缺口
    let r;
    try {
      r = await this._restGet(
        "/candles/" + encodeURIComponent(symbol) + "?resolution=1MIN&fromISO=" +
        encodeURIComponent(fromISO) + "&toISO=" + encodeURIComponent(toISO), { auth: false });
    } catch (e) { throw new VA_Error("VENUE_NETWORK", "qfex: 拉 1m K线失败: " + String((e && e.message) || e)); }
    const rows = (r && Array.isArray(r.candles) ? r.candles : []);
    // 按 startedAt 升序
    rows.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const cur5m = Math.floor(nowMs / 300000) * 300000;
    const groups = {};
    for (const c of rows) {
      const t = Date.parse(c.startedAt);
      if (!Number.isFinite(t)) continue;
      const g5 = Math.floor(t / 300000) * 300000;
      if (g5 >= cur5m) continue; // 丢弃未收盘的 5m
      const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      if (![o, h, l, cl].every((x) => Number.isFinite(x) && x > 0)) continue;
      const g = groups[g5] || (groups[g5] = { t: g5, o, h, l, c: cl });
      g.h = Math.max(g.h, h); g.l = Math.min(g.l, l); g.c = cl;
    }
    const bars = Object.keys(groups).map(Number).sort((a, b) => a - b).map((k) => groups[k]);
    if (bars.length < need)
      throw new VA_Error("VENUE_DATA", "qfex: 5m K线不足(仅 " + bars.length + " 根,需 " + need + " 根)");
    return bars.slice(-need).map((b) => ({
      time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, isFinal: true,
    }));
  }

  /* v1.6.19:杠杆校验(只读)。QFEX 杠杆按市场在 refdata 的 default_max_leverage 上限约束,
   * 请求杠杆不得超过该上限;实际生效杠杆以账户/网页端设置为准。 */
  async verifyLeverage(symbol, expectedLev, expectedMarginMode) {
    const c = await this.getContract(symbol);
    const maxL = c && c.maxLeverage;
    const want = Number(expectedLev);
    if (!(want > 0)) throw new VA_Error("VENUE_UNKNOWN", "qfex: verifyLeverage 杠杆无效");
    if (maxL && want > maxL)
      throw new VA_Error("VENUE_AUTH", "qfex: 请求杠杆 " + want + "x 超过市场上限 " + maxL + "x(" + symbol + ")");
    return { ok: true, maxLeverage: maxL || null };
  }

  async getMarkets() {
    // v1.6.10:市场目录改走公开 REST /refdata(2026-10-09 实测 250 个市场,字段已确认),
    // 不再猜 WS "markets" 频道。
    const ref = await this._refdata();
    return Object.values(ref).map((c) => ({
      venue: "qfex", symbol: c.symbol,
      base: c.baseAsset || null, quote: c.quoteAsset || null,
      tickSize: c.tickSize, lotSize: c.lotSize, minQuantity: c.minQuantity,
    }));
  }

  async getQuote(symbol) {
    if (!symbol) throw new VA_Error("VENUE_UNKNOWN", "qfex: getQuote 缺少 symbol");
    // v1.6.10:QFEX MDS 没有 "ticker" 频道(官方 CLI mds.go 实锤:只有 bbo/level2/trade/mark_price/…)。
    // 改走公开 REST GET /md/orderbook/{symbol}(2026-10-09 实测返回
    // {"ticker_id","timestamp","bids":[["4184.9","0.1031"],…],"asks":[…]}),跳过数量为 0 的档位。
    const data = await this._restGet(`/md/orderbook/${encodeURIComponent(symbol)}`, { auth: false });
    const bids = Array.isArray(data.bids) ? data.bids : [];
    const asks = Array.isArray(data.asks) ? data.asks : [];
    const best = (levels) => {
      for (const p of levels) {
        const px = _qxNum(Array.isArray(p) ? p[0] : p.price);
        const q = _qxNum(Array.isArray(p) ? p[1] : p.qty);
        if (px != null && px > 0 && q != null && q > 0) return { price: px, qty: q };
      }
      return null;
    };
    const b = best(bids), a = best(asks);
    if (!b || !a) throw new VA_Error("VENUE_QUOTE_UNAVAILABLE", `qfex: ${symbol} 盘口无有效买卖价`);
    return {
      venue: "qfex", symbol,
      bid: b.price, ask: a.price, mark: (b.price + a.price) / 2,
      bidQty: b.qty, askQty: a.qty,
      ts: Number(data.timestamp) > 0 ? Number(data.timestamp) : Date.now(),
    };
  }

  async getFunding(_symbol) {
    // brief 确认资金费每小时结算,但查询端点未确认 → 返回 null,不编造。
    return null;
  }

  /** 下单 → {orderId, status:'filled'|'pending'};REJECTED 抛 VENUE_REJECTED(带服务端原话)。
   * 两阶段异步:先等 ACK(含 order_id),再等 FILLED/CANCELLED/REJECTED 执行报告(最多 10 秒)。
   * 注意:500ms speed bump 只影响限价单(进队列前延迟 500ms),市价单不受影响。 */
  async placeOrder(o) {
    o = o || {};
    const symbol = o.symbol;
    const side = String(o.side || "").toLowerCase();
    const qty = o.qty;
    if (!symbol || qty == null || !(qty > 0) || (side !== "buy" && side !== "sell")) {
      throw new VA_Error("VENUE_UNKNOWN", "qfex: placeOrder 缺少合法的 symbol/side/qty");
    }
    const type = String(o.type || "MARKET").toUpperCase();
    const params = { symbol, side, quantity: qty, reduce_only: !!o.reduceOnly };
    if (type === "MARKET") {
      // 市价单:QFEX 原生 MARKET + order_time_in_force=IOC(官方 CLI PlaceOrderParams 线格式);不受 500ms speed bump 影响。
      params.order_type = "MARKET";
      params.order_time_in_force = "IOC";
    } else if (type === "LIMIT") {
      const tif = String(o.tif || "GTC").toUpperCase();
      if (tif !== "GTC" && tif !== "IOC" && tif !== "FOK") {
        throw new VA_Error("VENUE_UNKNOWN", "qfex: LIMIT 的 tif 只支持 GTC|IOC|FOK,收到: " + tif);
      }
      if (o.price == null || !(o.price > 0)) {
        throw new VA_Error("VENUE_UNKNOWN", "qfex: LIMIT 订单缺少合法 price");
      }
      // 限价单受 500ms speed bump 影响(进队列前延迟 500ms),这是 QFEX 撮合机制,非本适配器延迟。
      // 线字段名 order_time_in_force(官方 CLI protocol.go PlaceOrderParams 实锤;旧版误用 tif)。
      params.order_type = "LIMIT";
      params.price = o.price;
      params.order_time_in_force = tif;
    } else {
      throw new VA_Error("VENUE_UNKNOWN", "qfex: 不支持的订单类型: " + type + "(仅支持 MARKET/LIMIT)");
    }
    const ws = await this._ensureTradeWs();
    // 阶段 1:ACK(25s 超时铁律)
    const ack = await ws.request("add_order", params, { timeoutMs: this.requestTimeoutMs });
    const orderId = ack && (ack.order_id != null ? String(ack.order_id)
      : (ack.orderId != null ? String(ack.orderId) : null));
    if (!orderId) {
      throw new VA_Error("VENUE_REJECTED", "qfex: 下单 ACK 未返回 order_id,状态不确定,请先对账再决策");
    }
    // 阶段 2:等执行报告 FILLED/CANCELLED/REJECTED,最多 10 秒
    let report = null;
    try {
      report = await ws.waitForFill(orderId, this.fillWaitMs);
    } catch (e) {
      // 10 秒未收到报告:成交不确定 → status pending,调用方必须先对账(查订单/持仓),禁止盲目重下。
      return { orderId, status: "pending" };
    }
    const st = String(report.status || report.state || "").toUpperCase();
    if (st === "REJECTED" || st === "REJECT") {
      throw new VA_Error("VENUE_REJECTED",
        "qfex: 订单被拒: " + String(report.reason || report.message || report.error || "未知原因").slice(0, 300));
    }
    if (st === "FILLED" || st === "FILL") return { orderId, status: "filled" };
    // CANCELLED / EXPIRED / 未知状态:未成交,返回 pending,由调用方对账后决策。
    return { orderId, status: "pending" };
  }

  async cancelOrder(orderId) {
    if (orderId == null || orderId === "") {
      throw new VA_Error("VENUE_UNKNOWN", "qfex: cancelOrder 缺少 orderId");
    }
    const ws = await this._ensureTradeWs();
    // 成功字段名 UAT 实测复核;做防御性判断。
    const resp = await ws.request("cancel_order", { order_id: orderId }, { timeoutMs: this.requestTimeoutMs });
    return !!resp && (resp.ok === true || resp.cancelled === true ||
      String(resp.status || "").toUpperCase() === "CANCELLED");
  }

  /* v1.6.9:持仓。GET /user/positions → {balance:{...}, positions:[...]}。
   * 字段映射(第三方实现 QfexBroker.toPosition 实锤):
   * positions[] 内 symbol(字符串) / position(带符号数量,正=long,负=short,0 跳过) /
   * average_price(开仓均价)。返回统一形状 [{venue,symbol,side,qty,entryPrice}]。 */
  async getPositions() {
    const r = await this._restGet("/user/positions");
    const list = (r && Array.isArray(r.positions)) ? r.positions : [];
    const out = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const symbol = p.symbol || p.market || p.instrument || null;
      const signed = Number(p.position);
      if (!symbol || !Number.isFinite(signed) || signed === 0) continue;
      const ep = Number(p.average_price != null ? p.average_price : p.entry_price);
      out.push({
        venue: "qfex", symbol: String(symbol),
        side: signed > 0 ? "long" : "short",
        qty: Math.abs(signed),
        entryPrice: Number.isFinite(ep) ? ep : undefined,
      });
    }
    return out;
  }

  /* v1.6.9:余额。同接口的 balance 对象。
   * 字段映射(第三方实现 QfexBroker.onBalance 实锤):
   * available_balance(可用);权益 = deposit + realised_pnl + unrealised_pnl + net_funding。
   * 若服务端直接给了 equity/total_equity/account_value 则优先用。返回 {equity, available}。 */
  async getBalance() {
    const r = await this._restGet("/user/positions");
    const b = (r && typeof r.balance === "object" && r.balance) || {};
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const direct = num(b.equity != null ? b.equity : (b.total_equity != null ? b.total_equity : b.account_value));
    const sum = (num(b.deposit) || 0) + (num(b.realised_pnl) || 0) +
      (num(b.unrealised_pnl) || 0) + (num(b.net_funding) || 0);
    const hasParts = b.deposit != null || b.realised_pnl != null || b.unrealised_pnl != null || b.net_funding != null;
    return {
      equity: direct != null ? direct : (hasParts ? sum : null),
      available: num(b.available_balance != null ? b.available_balance : b.available),
      deposit: num(b.deposit), realisedPnl: num(b.realised_pnl),
      unrealisedPnl: num(b.unrealised_pnl), netFunding: num(b.net_funding),
      currency: b.currency || b.asset || "USDC",
    };
  }

  async closeAllPositions() {
    // v1.6.9:getPositions 字段已确认 → 枚举持仓后逐笔 reduce-only 市价平
    const poss = await this.getPositions();
    let closed = 0;
    const errors = [];
    for (const p of poss) {
      try {
        await this.placeOrder({
          symbol: p.symbol, side: p.side === "long" ? "sell" : "buy",
          qty: String(p.qty), type: "MARKET", reduceOnly: true,
        });
        closed++;
      } catch (e) { errors.push(`${p.symbol}:${String((e && e.message) || e).slice(0, 80)}`); }
    }
    return { closed, total: poss.length, errors };
  }

  /** QFEX 掉线自动全撤开关。供重启逻辑用:插件异常重启/重连后打开,保证掉线不留裸单。
   * WS 未连接时先记下,下次建连认证后自动下发。 */
  async setCancelOnDisconnect(on) {
    this._cancelOnDisconnect = !!on;
    if (this._tradeWs && this._tradeWs.isOpen()) {
      await this._tradeWs.request("cancel_on_disconnect",
        { enabled: !!on }, { timeoutMs: this.requestTimeoutMs });
    }
    return this._cancelOnDisconnect;
  }

  /** v1.6.8:实测探测——返回各查询的原始形状(截断),供字段映射用,不进心跳/报警。
   *  positions/balance 字段未确认:这里只透传原始响应,不做映射、不编造。 */
  async probeRaw(symbols) {
    const clip = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return String(v).slice(0, 2000); } };
    const out = { marketsCount: 0, marketSample: [], quotes: {}, positionsRaw: null, balanceRaw: null };
    try {
      const mkts = await this.getMarkets();
      out.marketsCount = mkts.length;
      out.marketSample = mkts.slice(0, 10).map((m) => m.symbol);
    } catch (e) { out.marketsError = String((e && e.message) || e).slice(0, 200); }
    // 未指定符号时,对目录前 3 个市场取行情(不猜代码)
    const qs = (symbols && symbols.length ? symbols : out.marketSample.slice(0, 3));
    for (const s of qs) {
      try { out.quotes[s] = await this.getQuote(s); }
      catch (e) { out.quotes[s] = { error: String((e && e.message) || e).slice(0, 200) }; }
    }
    try { out.positionsRaw = clip(await this._privateQuery("get_positions", {})); }
    catch (e) { out.positionsRaw = { error: String((e && e.message) || e).slice(0, 300) }; }
    try { out.balanceRaw = clip(await this._privateQuery("get_balance", {})); }
    catch (e) { out.balanceRaw = { error: String((e && e.message) || e).slice(0, 300) }; }
    return out;
  }

  /** 健康检查:auth 成功即视为健康。若私有查询字段确认后,可顺手查一次持仓数(当前未确认,从略)。 */
  async checkSession() {
    try {
      await this._ensureTradeWs();
      return true;
    } catch (e) {
      if (e && e.code === "VENUE_AUTH") throw e;
      throw new VA_Error("VENUE_NETWORK",
        "qfex: 会话检查失败: " + String((e && e.message) || e).slice(0, 160), true);
    }
  }

  async disconnect() {
    try { if (this._tradeWs) this._tradeWs.close(); } catch (e) { /* ignore */ }
    try { if (this._mdWs) this._mdWs.close(); } catch (e) { /* ignore */ }
    this._tradeWs = null;
    this._mdWs = null;
  }

  /** v1.3.0 策略引擎暂只接 Variational,QFEX 返回 null。 */
  getLegacyApi() { return null; }
}

/* service worker 里 importScripts 加载后挂到 globalThis,供 venues/index.js 的 _venueClass 查找 */
if (typeof globalThis !== "undefined") {
  globalThis.QfexAdapter = QfexAdapter;
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { QfexAdapter };
}
