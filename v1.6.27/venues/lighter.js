"use strict";
/* v1.3.0 Phase E: Lighter 适配器(LighterAdapter extends _LtAdapter)。
 *
 * 依据(2026-10-04 核验):
 *  - REST 文档 https://apidocs.lighter.xyz/docs/api-keys / core-concepts / signing-transactions
 *  - 官方 Go SDK types/txtypes/constants.go:TxTypeL2CreateOrder=14、
 *    TxTypeL2CancelOrder=15、TxTypeL2CancelAllOrders=16(注意:任务书"16=cancel"有误,
 *    16 是取消全部,已按文档原文用 15)
 *  - 真实 signer 输出的 tx_info 字段布局(lighter-python issue #98):
 *    CreateOrder: AccountIndex/ApiKeyIndex/MarketIndex/ClientOrderIndex/BaseAmount/
 *      Price/IsAsk/Type/TimeInForce/ReduceOnly/TriggerPrice/OrderExpiry/ExpiredAt/Nonce/Sig
 *    Cancel: AccountIndex/ApiKeyIndex/MarketIndex/Index/ExpiredAt/Nonce/Sig
 *  - 公开端点实测(mainnet,2026-10-04):orderBookDetails / orderBookOrders /
 *    funding-rates / nextNonce / account(by=index) 均返回 {code:200,...}
 *
 * 签名现状:交易签名与 auth token mint 需官方 Go signer(Poseidon/Schnorr),
 * 纯 JS noble-secp256k1 路线不适用——签名相关调用经 this.signer(默认走
 * venues/vendor/lighter-signer.bundle.js 的 stub,抛 VENUE_UNKNOWN 并写清原因)。
 * 读行情/账户(公开端点)不受影响。WS(v1.3.0)未实现,见底部注释。
 *
 * 凭证:creds={apiKey(API 私钥,只显示一次的那个),accountIndex,keyIndex},只活在内存,
 * 绝不进心跳/日志/错误报告(错误文案里不拼接凭证)。
 * 纯类+函数,不依赖 chrome.*,可在 service worker 与 node 测试里跑。
 */

let _AD = null;
try {
  if (typeof require === "function") _AD = require("./adapter.js");
} catch (e) { /* browser: adapter.js 先行 importScripts,走全局词法绑定 */ }
/* 注意:SW 里顶层 class 进全局词法环境、不挂 globalThis,必须用 typeof 守卫直接引用;
 * 且不能声明同名 const(会与 adapter.js 冲突),故用 _Lt 前缀别名。 */
const _LtAdapter = _AD ? _AD.VenueAdapter : (typeof VenueAdapter !== "undefined" ? VenueAdapter : null);
const _LtError = _AD ? _AD.VenueError : (typeof VenueError !== "undefined" ? VenueError : null);
const _ltFetch = _AD ? _AD.vatFetchJson : (typeof vatFetchJson !== "undefined" ? vatFetchJson : null);
if (!_LtAdapter || !_LtError) throw new Error("LighterAdapter 需要先加载 venues/adapter.js");

const LIGHTER_MAINNET_BASE = "https://mainnet.zklighter.elliot.ai";
const LIGHTER_TESTNET_BASE = "https://testnet.zklighter.elliot.ai";
const LIGHTER_MAINNET_WS = "wss://mainnet.zklighter.elliot.ai/stream";
const LIGHTER_TESTNET_WS = "wss://testnet.zklighter.elliot.ai/stream";

/* L2 tx 类型:官方 Go SDK types/txtypes/constants.go 原文 */
const TX_CREATE_ORDER = 14;
const TX_CANCEL_ORDER = 15;        /* 任务书误写 16=cancel;16 实际是 CancelAllOrders */
const TX_CANCEL_ALL_ORDERS = 16;
/* 订单类型 / TIF:官方文档 Signing Transactions 章节 */
const ORDER_TYPE_LIMIT = 0;
const ORDER_TYPE_MARKET = 1;
const TIF_IOC = 0;
const TIF_GTT = 1;
const TIF_POST_ONLY = 2;
/* L2 签名 chain_id:官方 signer 用,tx hash 首元素(mainnet 304 / testnet 300) */
const LIGHTER_CHAIN_ID_MAINNET = 304;
const LIGHTER_CHAIN_ID_TESTNET = 300;

/* auth token:文档格式 {expiry_unix}:{account_index}:{api_key_index}:{random_hex},
 * 最长 8h;剩余不足 1h 则重 mint(约 7h 轮换);mint 后无需再碰 L1。 */
const AUTH_TOKEN_TTL_S = 7 * 3600;
const AUTH_TOKEN_REFRESH_BEFORE_S = 3600;
const AUTH_TOKEN_RE = /^(\d+):(\d+):(\d+):([0-9a-fA-F]+)$/;
/* funding-rates 端点返回的是 8h 等效费率(官方 lighter-agent-kit),供跨所对比;
 * Lighter 本所按小时计提。interval 取 28800,注释写清口径。 */
const FUNDING_INTERVAL_S = 28800;

function _nowS() { return Math.floor(Date.now() / 1000); }
function _ltNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

class LighterAdapter extends _LtAdapter {
  constructor(id, opts) {
    super(id || "lighter", opts);
    opts = opts || {};
    const c = this.creds || {};
    this.apiKey = c.apiKey || null;            /* API 私钥:只活在内存 */
    this.accountIndex = (c.accountIndex !== undefined && c.accountIndex !== null)
      ? Number(c.accountIndex) : null;
    this.apiKeyIndex = (c.keyIndex !== undefined && c.keyIndex !== null)
      ? Number(c.keyIndex) : null;
    this.useTestnet = !!(c.useTestnet || opts.useTestnet);
    this.base = this.useTestnet ? LIGHTER_TESTNET_BASE : LIGHTER_MAINNET_BASE;
    this.wsUrl = this.useTestnet ? LIGHTER_TESTNET_WS : LIGHTER_MAINNET_WS;
    this.chainId = this.useTestnet ? LIGHTER_CHAIN_ID_TESTNET : LIGHTER_CHAIN_ID_MAINNET;
    /* 签名器可注入(测试用 mock);缺省走 vendor stub(抛 VENUE_UNKNOWN,见文件头)。 */
    this.signer = opts.signer || null;
    this._marketsAt = 0;
    this._markets = [];
    this._bySymbol = new Map();
    this._byId = new Map();
    this._nonceKnown = null; /* 本地 nonce 计数器:仅 nextNonce 失败时用,种子来自上次成功值 */
  }

  /* ---------- 内部:签名器 ---------- */
  _getSigner() {
    if (this.signer) return this.signer;
    try {
      if (typeof require === "function") {
        const v = require("./vendor/lighter-signer.bundle.js");
        if (v && typeof v.createLighterSigner === "function") {
          this.signer = v.createLighterSigner({ chainId: this.chainId });
          return this.signer;
        }
      }
    } catch (e) { /* fallthrough */ }
    if (typeof globalThis !== "undefined" && globalThis.LighterSignerVendor) {
      this.signer = globalThis.LighterSignerVendor.createLighterSigner({ chainId: this.chainId });
      return this.signer;
    }
    throw new _LtError("VENUE_UNKNOWN",
      "lighter: 无可用 signer(vendor stub 缺失)。交易签名需官方 Go signer(Poseidon/Schnorr)。", false);
  }

  /* ---------- 内部:凭证与请求 ---------- */
  _needCreds() {
    if (!this.apiKey || this.accountIndex === null || this.apiKeyIndex === null) {
      throw new _LtError("VENUE_AUTH",
        "lighter: 未配置凭证(需 {apiKey, accountIndex, keyIndex});请按 LIGHTER_SETUP_STEPS 在官网生成后填入。", false);
    }
  }

  async _apiGet(path, { auth = false } = {}) {
    const headers = {};
    if (auth) headers.Authorization = await this._ensureAuthToken();
    const data = await _ltFetch(this.base + path, { headers });
    if (data && typeof data.code !== "undefined" && data.code !== 200) {
      throw new _LtError("VENUE_REJECTED",
        `lighter: ${path} 返回 code=${data.code}${data.message ? ": " + data.message : ""}`,
        data.code >= 500);
    }
    return data;
  }

  async _apiPost(path, body, { auth = false } = {}) {
    const headers = {};
    if (auth) headers.Authorization = await this._ensureAuthToken();
    const data = await _ltFetch(this.base + path, { method: "POST", headers, body });
    if (data && typeof data.code !== "undefined" && data.code !== 200) {
      const err = new _LtError("VENUE_REJECTED",
        `lighter: ${path} 返回 code=${data.code}${data.message ? ": " + data.message : ""}`,
        data.code === 429 || data.code >= 500);
      err.response = data;
      throw err;
    }
    return data;
  }

  /* ---------- auth token(8h,全自动轮换) ---------- */
  _tokenStoreKey() { return "lighter:authToken"; }

  async _ensureAuthToken() {
    this._needCreds();
    const now = _nowS();
    try {
      const cached = await this._storeGet(this._tokenStoreKey());
      if (cached && cached.token && cached.expiry) {
        const m = AUTH_TOKEN_RE.exec(cached.token);
        /* 格式校验:expiry/account/keyIndex 须与当前凭证一致,且剩余>1h 才复用 */
        if (m && Number(m[1]) === cached.expiry &&
            Number(m[2]) === this.accountIndex && Number(m[3]) === this.apiKeyIndex &&
            cached.expiry - now > AUTH_TOKEN_REFRESH_BEFORE_S) {
          return cached.token;
        }
      }
    } catch (e) { /* 缓存坏了就重 mint;若是 VenueError 则透出 */ if (e && e.code) throw e; }
    /* 重 mint:deadline 取 now+7h(<8h 上限),约 7h 轮换;之后无需再碰 L1。 */
    const deadline = now + AUTH_TOKEN_TTL_S;
    const signer = this._getSigner();
    const token = await signer.mintAuthToken({
      deadlineUnix: deadline, apiKeyIndex: this.apiKeyIndex, accountIndex: this.accountIndex,
    });
    const m = AUTH_TOKEN_RE.exec(String(token || ""));
    if (!m) {
      throw new _LtError("VENUE_AUTH",
        "lighter: signer 返回的 auth token 格式不符合 {expiry}:{account}:{keyIndex}:{random_hex}。", false);
    }
    const expiry = Number(m[1]);
    if (!(expiry > now && expiry <= now + 8 * 3600)) {
      throw new _LtError("VENUE_AUTH", "lighter: auth token 有效期异常(须为未来 8h 内)。", false);
    }
    await this._storeSet(this._tokenStoreKey(), { token, expiry });
    return token;
  }

  /* ---------- nonce(per-API-key 递增) ---------- */
  _nonceStoreKey() { return `lighter:nonce:${this.apiKeyIndex}`; }

  async _nextNonce() {
    this._needCreds();
    /* 路径一:问服务端(权威)。失败则走路径二。 */
    try {
      const data = await this._apiGet(
        `/api/v1/nextNonce?account_index=${this.accountIndex}&api_key_index=${this.apiKeyIndex}`);
      const n = Number(data.nonce);
      if (!Number.isFinite(n) || n < 0) throw new Error("bad nonce");
      this._nonceKnown = n + 1;
      try { await this._storeSet(this._nonceStoreKey(), this._nonceKnown); } catch (e) { /* ignore */ }
      return n;
    } catch (e) {
      if (e && e.code === "VENUE_REJECTED") throw e; /* 服务端明确拒绝:不猜,直接抛 */
      /* 路径二:本地严格递增计数器。种子必须来自历史上成功获取的值,绝不凭空编造。 */
      if (this._nonceKnown === null) {
        try { this._nonceKnown = await this._storeGet(this._nonceStoreKey()); } catch (se) { /* ignore */ }
      }
      if (this._nonceKnown === null || !Number.isFinite(Number(this._nonceKnown))) {
        throw new _LtError("VENUE_NETWORK",
          "lighter: nextNonce 请求失败且本地无可用 nonce 基准,不敢凭空编造 nonce(会撞车)。稍后重试。", true);
      }
      const n = Number(this._nonceKnown);
      this._nonceKnown = n + 1;
      try { await this._storeSet(this._nonceStoreKey(), this._nonceKnown); } catch (se) { /* ignore */ }
      return n;
    }
  }

  /* ---------- 市场 ---------- */
  _normSymbol(s) {
    s = String(s || "").trim().toUpperCase();
    return s.replace(/-(PERP|SWAP)$/, "").replace(/_PERP$/, "");
  }

  async _loadMarkets(force) {
    if (!force && this._markets.length && Date.now() - this._marketsAt < 5 * 60 * 1000) return;
    const data = await this._apiGet("/api/v1/orderBookDetails");
    const list = Array.isArray(data.order_book_details) ? data.order_book_details : [];
    this._markets = list.map((m) => ({
      symbol: m.symbol,
      marketId: Number(m.market_id),
      marketType: m.market_type,
      status: m.status,
      sizeDecimals: Number(m.size_decimals),
      priceDecimals: Number(m.price_decimals),
      minBaseAmount: _ltNum(m.min_base_amount),
      minQuoteAmount: _ltNum(m.min_quote_amount),
      markPrice: _ltNum(m.mark_price),
    }));
    this._bySymbol = new Map();
    this._byId = new Map();
    for (const m of this._markets) {
      if (m.marketType === "perp") {
        this._byId.set(m.marketId, m);
        if (!this._bySymbol.has(m.symbol)) this._bySymbol.set(m.symbol, m);
      }
    }
    this._marketsAt = Date.now();
  }

  async _marketFor(symbol) {
    await this._loadMarkets(false);
    const norm = this._normSymbol(symbol);
    const m = this._bySymbol.get(norm) || this._bySymbol.get(String(symbol || "").toUpperCase());
    if (!m) {
      throw new _LtError("VENUE_REJECTED",
        `lighter: 未知标的 ${symbol}(orderBookDetails 无此 perp 市场,不猜 market_id)。`, false);
    }
    return m;
  }

  async getMarkets() {
    await this._loadMarkets(false);
    return this._markets
      .filter((m) => m.marketType === "perp" && m.status === "active")
      .map((m) => ({
        symbol: m.symbol, marketId: m.marketId,
        sizeDecimals: m.sizeDecimals, priceDecimals: m.priceDecimals,
      }));
  }

  async getQuote(symbol) {
    const m = await this._marketFor(symbol);
    const data = await this._apiGet(`/api/v1/orderBookOrders?market_id=${m.marketId}&limit=5`);
    const asks = Array.isArray(data.asks) ? data.asks : [];
    const bids = Array.isArray(data.bids) ? data.bids : [];
    /* asks/bids 按价格排序,首个即最优 */
    return {
      bid: bids.length ? _ltNum(bids[0].price) : null,
      ask: asks.length ? _ltNum(asks[0].price) : null,
      mark: m.markPrice,
    };
  }

  async getFunding(symbol) {
    const m = await this._marketFor(symbol);
    const data = await this._apiGet("/api/v1/funding-rates");
    const rows = Array.isArray(data.funding_rates) ? data.funding_rates : [];
    const row = rows.find((r) => r.exchange === "lighter" &&
      (Number(r.market_id) === m.marketId || r.symbol === m.symbol));
    if (!row) return null;
    return { rate: _ltNum(row.rate), interval: FUNDING_INTERVAL_S };
  }

  /* ---------- 账户 ---------- */
  async _account() {
    this._needCreds();
    const data = await this._apiGet(
      `/api/v1/account?by=index&value=${this.accountIndex}`, { auth: true });
    const acc = data && Array.isArray(data.accounts) && data.accounts[0];
    if (!acc) throw new _LtError("VENUE_REJECTED", "lighter: account 接口未返回账户数据。", false);
    return acc;
  }

  async getPositions() {
    const acc = await this._account();
    const positions = Array.isArray(acc.positions) ? acc.positions : [];
    const out = [];
    for (const p of positions) {
      /* Position 形状见官方 lighter-agent-kit schemas-read:sign(1=long,-1=short),
       * position 为绝对数量字符串;只有实际返回的字段才填。 */
      const qty = _ltNum(p.position);
      if (qty === null || qty === 0) continue; /* 持平/历史行跳过 */
      const entry = {
        venue: "lighter",
        symbol: p.symbol || null,
        marketId: (p.market_id !== undefined && p.market_id !== null) ? Number(p.market_id) : null,
        side: Number(p.sign) === -1 ? "short" : "long",
        qty,
      };
      const ep = _ltNum(p.avg_entry_price);
      if (ep !== null) entry.entryPrice = ep;
      const up = _ltNum(p.unrealized_pnl);
      if (up !== null) entry.upnl = up;
      out.push(entry);
    }
    return out;
  }

  async getBalance() {
    const acc = await this._account();
    const equity = _ltNum(acc.total_asset_value);
    const available = _ltNum(acc.available_balance);
    if (equity === null && available === null) return null;
    const out = {};
    if (equity !== null) out.equity = equity;
    if (available !== null) out.available = available;
    return out;
  }

  /* ---------- 下单/撤单(需 signer;默认 stub 抛 VENUE_UNKNOWN) ---------- */
  _scaleQty(m, qty) {
    const d = Number.isFinite(m.sizeDecimals) ? m.sizeDecimals : 0;
    return Math.round(Number(qty) * Math.pow(10, d));
  }
  _scalePrice(m, price) {
    const d = Number.isFinite(m.priceDecimals) ? m.priceDecimals : 0;
    return Math.round(Number(price) * Math.pow(10, d));
  }

  async placeOrder(o) {
    o = o || {};
    this._needCreds();
    const side = String(o.side || "").toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new _LtError("VENUE_REJECTED", "lighter.placeOrder: side 须为 buy/sell。", false);
    }
    const qty = Number(o.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new _LtError("VENUE_REJECTED", "lighter.placeOrder: qty 须为正数。", false);
    }
    const type = String(o.type || "limit").toLowerCase();
    if (type !== "limit" && type !== "market" && type !== "postonly") {
      throw new _LtError("VENUE_REJECTED", "lighter.placeOrder: type 须为 limit/market/postonly。", false);
    }
    /* Lighter 无原生市价单;market 走 IOC 限价单模拟,price 为最差可接受价(文档原文),
     * 故所有类型都要求传 price。 */
    const price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new _LtError("VENUE_REJECTED",
        "lighter.placeOrder: price 必填(market 单的 price 为最差可接受价,按文档 taker 语义)。", false);
    }
    const m = await this._marketFor(o.symbol);
    const baseAmount = this._scaleQty(m, qty);
    const priceInt = this._scalePrice(m, price);
    if (baseAmount < 1 || priceInt < 1) {
      throw new _LtError("VENUE_REJECTED",
        `lighter.placeOrder: 数量/价格经精度缩放后为 0(标的 ${m.symbol}:sizeDecimals=${m.sizeDecimals},priceDecimals=${m.priceDecimals})。`, false);
    }
    const orderType = type === "market" ? ORDER_TYPE_MARKET : ORDER_TYPE_LIMIT;
    const tif = type === "postonly" ? TIF_POST_ONLY : (type === "market" ? TIF_IOC : TIF_GTT);
    /* post-only 标记透传:maker-only key(0-3 不能设 maker-only,见文档)走 0ms 路径;
     * key 是否 maker-only 由用户在官网 setMakerOnlyApiKeys 设置,插件只透传意图。 */
    const nowMs = Date.now();
    /* client_order_index:uint48 内唯一;order_expiry:IOC 取 60s,GTT/PO 取 28 天
     * (对齐 Python SDK DEFAULT_IOC_EXPIRY / DEFAULT_28_DAY_ORDER_EXPIRY 命名);
     * ExpiredAt:tx 级过期,文档要求距今 >~5s,取 5 分钟。 */
    const clientOrderIndex = (nowMs % 281474976) * 1000 + Math.floor(Math.random() * 1000);
    const orderExpiry = type === "market" ? nowMs + 60000 : nowMs + 28 * 86400 * 1000;
    const expiredAt = nowMs + 5 * 60000;
    const nonce = await this._nextNonce();
    /* tx_info 字段布局:真实 signer 输出(lighter-python#98);IsAsk/ReduceOnly 取 0/1。 */
    const txInfo = {
      AccountIndex: this.accountIndex,
      ApiKeyIndex: this.apiKeyIndex,
      MarketIndex: m.marketId,
      ClientOrderIndex: clientOrderIndex,
      BaseAmount: baseAmount,
      Price: priceInt,
      IsAsk: side === "sell" ? 1 : 0,
      Type: orderType,
      TimeInForce: tif,
      ReduceOnly: o.reduceOnly ? 1 : 0,
      TriggerPrice: 0,
      OrderExpiry: orderExpiry,
      ExpiredAt: expiredAt,
      Nonce: nonce,
    };
    const signer = this._getSigner();
    const signed = await signer.signTx({ txType: TX_CREATE_ORDER, txInfo, chainId: this.chainId });
    /* sendTx 请求体按 v1.3.0  brief:{tx_type, tx_info, signature}。
     * 注:文档 WS 示例为 {tx_type, tx_info},且真实 tx_info 内已含 Sig 字段;
     * REST 体的 signature 字段确切语义待真实 signer 联调时以服务端为准,此处先按 brief。 */
    const resp = await this._apiPost("/api/v1/sendTx", {
      tx_type: TX_CREATE_ORDER,
      tx_info: signed.txInfo,
      signature: signed.signature,
    });
    /* code=200 仅表示 accepted,不保证执行(文档原文);成交走对账确认。 */
    return {
      orderId: String(clientOrderIndex),
      txHash: signed.txHash || resp.tx_hash || null,
      status: "pending",
    };
  }

  async cancelOrder(orderId, opts) {
    opts = opts || {};
    this._needCreds();
    const idx = Number(orderId);
    if (!Number.isFinite(idx)) {
      throw new _LtError("VENUE_REJECTED", "lighter.cancelOrder: orderId 须为数字(order_index 或 client_order_index,文档称二者可互换)。", false);
    }
    /* cancel tx 需 MarketIndex:优先用 opts.symbol/marketId 解析 */
    let marketId = opts.marketId !== undefined ? Number(opts.marketId) : null;
    if (marketId === null && opts.symbol) marketId = (await this._marketFor(opts.symbol)).marketId;
    if (marketId === null || !Number.isFinite(marketId)) {
      throw new _LtError("VENUE_REJECTED",
        "lighter.cancelOrder: 需提供 symbol 或 marketId 以定位 MarketIndex(不猜)。", false);
    }
    const nowMs = Date.now();
    const nonce = await this._nextNonce();
    /* tx_info 字段布局:文档 Transaction 示例(type 15)原文 */
    const txInfo = {
      AccountIndex: this.accountIndex,
      ApiKeyIndex: this.apiKeyIndex,
      MarketIndex: marketId,
      Index: idx,
      ExpiredAt: nowMs + 5 * 60000,
      Nonce: nonce,
    };
    const signer = this._getSigner();
    const signed = await signer.signTx({ txType: TX_CANCEL_ORDER, txInfo, chainId: this.chainId });
    await this._apiPost("/api/v1/sendTx", {
      tx_type: TX_CANCEL_ORDER,
      tx_info: signed.txInfo,
      signature: signed.signature,
    });
    return true;
  }

  /* ---------- 会话检查 ---------- */
  async checkSession() {
    this._needCreds(); /* 缺凭证 -> VENUE_AUTH */
    await this._ensureAuthToken(); /* signer 不可用 -> VENUE_UNKNOWN(写清原因);网络问题 -> VENUE_NETWORK */
    await this._account(); /* 账户可查 */
    return true;
  }

  /* v1.3.0: WebSocket 只实现 REST,WS 留空(按任务要求注释)。
   * 文档 WS 地址:wss://mainnet.zklighter.elliot.ai/stream(2 分钟 keepalive);
   * 订阅示例 {type:"subscribe",channel:"order_book/{market_id}"},私有 channel 需 auth token。
   * v1.3.0 先只实现 REST,WS 在后续 phase 接入。 */
  async disconnect() { /* no-op:无 WS 连接 */ }

  /* v1.3.0 策略引擎暂只接 Variational;Lighter 返回 null(只做持仓快照/手动)。 */
  getLegacyApi() { return null; }
}

/* 用户手动步骤:一句话一条,供弹窗展示。顺序即官网操作顺序。 */
const LIGHTER_SETUP_STEPS = [
  "打开 app.lighter.xyz,连接你的钱包(L1),并完成入金。",
  "如需隔离资金,先新建一个交易子账户,记下它的 account_index(主账户也可用自己的 index)。",
  "进入 /apikeys 页面点 Generate 生成 API key:选一个未使用的 index(4–254;0–3 留给官方 App,255 为查询哨兵)。",
  "API 私钥只显示一次——立即复制并离线保存,丢失无法找回,任何人索要都不要给。",
  "用钱包做一次 ChangePubKey 签名,把该 API key 注册到你的 Lighter 账户(只需一次,需 L1 签名;之后交易不再碰 L1)。",
  "把 {API 私钥, account_index, api_key_index} 填进插件的 Lighter 设置(只存本机 chrome.storage.local,不进聊天/中转站)。",
  "选择账户档位:Standard(默认,零费率)或 Premium(需质押 LIT;maker-only key 可走 0ms 路径)。",
  "maker-only(可选):如需纯做市 key,在官网 setMakerOnlyApiKeys 设置(index 0–3 不能设 maker-only);插件下单时 postOnly 标记会自动透传。",
  "之后 8h auth token 由插件用 API 私钥全自动 mint、约 7h 轮换,nonce 自动管理,无需你再动手。",
];

/* service worker 里 importScripts 加载后挂到 globalThis,供 venues/index.js 的 _venueClass 查找 */
if (typeof globalThis !== "undefined") {
  globalThis.LighterAdapter = LighterAdapter;
  globalThis.LIGHTER_SETUP_STEPS = LIGHTER_SETUP_STEPS;
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LighterAdapter,
    LIGHTER_SETUP_STEPS,
    TX_CREATE_ORDER,
    TX_CANCEL_ORDER,
    TX_CANCEL_ALL_ORDERS,
    LIGHTER_MAINNET_BASE,
    LIGHTER_TESTNET_BASE,
  };
}
