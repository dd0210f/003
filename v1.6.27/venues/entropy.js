"use strict";
/* v1.3.0: Entropy 适配器 —— Hyperliquid HIP-3 builder dex, dex 名 "io"。
 *
 * 要点(与调研结论 research/v130_venue_briefs.md §2 严格对齐):
 * - 认证:无 API Key,钱包签名。用户在 Hyperliquid UI 建 agent wallet,主账户签
 *   approveAgent;agent 私钥(creds.agentKey, hex)签所有 L1 action(phantom agent
 *   scheme: domain "Exchange"/chainId 1337/MessagePack→Keccak→secp256k1)。
 *   agent 可交易不可提款。签名逻辑 vendored 在 venues/vendor/hyperliquid.bundle.js
 *   (MV3 CSP 禁远程 import,必须本地打包)。
 * - 凭证只经构造参数传入(creds),只活在内存,绝不进日志/心跳/存储快照。
 * - 仅隔离保证金(HIP-3 dex 只开 isolated;meta 里 marginMode 为 strictIsolated/noCross)。
 * - 费率约 0.09% taker / 0.03% maker(约主站 2 倍,一半归 deployer)。
 * - 资金费每小时结算,费率与预言机由 deployer 定(getFunding interval 恒为 "1h")。
 * - deployer 可 haltTrading(全撤单按 mark 结算):下单/撤单遇到服务端拒绝时抛
 *   VENUE_REJECTED,调用方必须按拒绝处理,不得盲目重试。
 * - Hyperliquid 无原生市价单:市价单用 IOC 限价单代替(官方 SDK 同款做法),
 *   限价按 mark ±5% 估算(买+5%/卖-5%,SDK 默认滑点做法)。
 * - asset id 每 session 经 perpDexs + meta 实时解析,禁止硬编码:
 *   assetId = 100000 + perpDexIndex*10000 + indexInMeta。
 *   注意 perpDexs 数组里主 dex 以 null 占位,index 照数组下标算。
 * - 主网 https://api.hyperliquid.xyz;creds.useTestnet=true 时切 testnet。
 *   主网/testnet 账本与 asset index 互相独立。
 *
 * 纯类,不依赖 chrome.*,可在 service worker 与 node 测试里跑。
 */

/* 依赖解析:node 里 require("./adapter.js");SW 里 adapter.js 已先 importScripts,
 * 三个名字是全局词法绑定,直接引用即可(本文件不声明同名局部变量,避免遮蔽)。 */
const _EAD = (typeof require === "function")
  ? (() => { try { return require("./adapter.js"); } catch (e) { return null; } })()
  : null;
/* node: 取 require 结果;SW: adapter.js 已先 importScripts,类名是全局词法绑定,
 * 用 typeof 守卫取值(本文件不声明同名绑定,无遮蔽/TDZ 问题)。 */
const _EntAdapter = _EAD ? _EAD.VenueAdapter
  : (typeof VenueAdapter !== "undefined" ? VenueAdapter : null);
/* eslint-disable-next-line no-undef */
const _EntError = _EAD ? _EAD.VenueError
  : (typeof VenueError !== "undefined" ? VenueError : null);
/* eslint-disable-next-line no-undef */
const _entFetch = _EAD ? _EAD.vatFetchJson
  : (typeof vatFetchJson !== "undefined" ? vatFetchJson : null);
if (!_EntAdapter || !_EntError || !_entFetch) {
  throw new Error("entropy: 缺少 venues/adapter.js 的基类/工具(adapter.js 未加载)");
}

const ENTROPY_DEX = "io";
const HL_MAINNET = "https://api.hyperliquid.xyz";
const HL_TESTNET = "https://api.hyperliquid-testnet.xyz";
const ASSET_IDS_KEY = "entropy_asset_ids";

/** 取 vendored 签名包(SW: importScripts 预加载; node: require)。抛 VENUE_UNKNOWN 当缺失。 */
function _hlVendor() {
  if (globalThis.HyperliquidVendor) return globalThis.HyperliquidVendor;
  if (typeof require === "function") {
    try { require("./vendor/hyperliquid.bundle.js"); } catch (e) { /* ignore */ }
  }
  const v = globalThis.HyperliquidVendor;
  if (!v) throw new _EntError("VENUE_UNKNOWN", "entropy: hyperliquid.bundle.js 未加载,无法签名");
  return v;
}

function _entNum(x) {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

class EntropyAdapter extends _EntAdapter {
  constructor(id, opts) {
    super(id || "entropy", opts);
    this._vendor = null;
    this._agentAddress = null;
  }

  _baseUrl() {
    return (this.creds && this.creds.useTestnet) ? HL_TESTNET : HL_MAINNET;
  }

  _vendorLazy() {
    if (!this._vendor) this._vendor = _hlVendor();
    return this._vendor;
  }

  /** agent 私钥(hex)。只活在内存;格式不对抛 VENUE_AUTH。 */
  _agentKey() {
    const k = this.creds && this.creds.agentKey;
    if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k.trim())) {
      throw new _EntError("VENUE_AUTH", "entropy: 未配置合法的 agent 私钥(creds.agentKey, 32 字节 hex)");
    }
    return k.trim().toLowerCase();
  }

  /** agent 钱包地址(由私钥推导)。 */
  _agentWalletAddress() {
    if (!this._agentAddress) this._agentAddress = this._vendorLazy().agentAddressFromKey(this._agentKey());
    return this._agentAddress;
  }

  /** 查持仓/余额用的地址:优先主账户(creds.accountAddress,可选),缺省用 agent 地址。
   *  注意 agent 地址本身无资金、无持仓;不填 accountAddress 时持仓恒为空,属预期行为。 */
  _userAddress() {
    const a = this.creds && this.creds.accountAddress;
    if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.trim())) return a.trim().toLowerCase();
    return this._agentWalletAddress();
  }

  async _postInfo(body) {
    return _entFetch(this._baseUrl() + "/info", { method: "POST", body });
  }

  /** symbol 归一化:接受 "io:ANTH"/"ANTH"(自动补前缀)/大小写混写。 */
  _normSymbol(symbol) {
    let s = String(symbol || "").trim().toUpperCase();
    if (s.startsWith(ENTROPY_DEX.toUpperCase() + ":")) s = s.slice(3);
    if (!s) throw new _EntError("VENUE_REJECTED", "entropy: 空 symbol");
    return { coin: s, dexCoin: ENTROPY_DEX + ":" + s, symbol: ENTROPY_DEX + ":" + s };
  }

  /** 每 session 实时解析 asset id(公式 100000 + perpDexIndex*10000 + indexInMeta),
   *  结果缓存到 store;disconnect 时清掉。禁止硬编码。 */
  async _resolveMeta() {
    const cached = await this._storeGet(ASSET_IDS_KEY);
    if (cached && cached.ids) return cached;
    const dexs = await this._postInfo({ type: "perpDexs" });
    if (!Array.isArray(dexs)) throw new _EntError("VENUE_REJECTED", "entropy: perpDexs 返回异常");
    let dexIndex = -1;
    for (let i = 0; i < dexs.length; i++) {
      const d = dexs[i];
      if (d && d.name === ENTROPY_DEX) { dexIndex = i; break; } // null 条目是主 dex,照数组下标算
    }
    if (dexIndex < 0) throw new _EntError("VENUE_REJECTED", "entropy: perpDexs 未列出 dex 'io'(可能被下架或 haltTrading)");
    const meta = await this._postInfo({ type: "meta", dex: ENTROPY_DEX });
    const universe = (meta && meta.universe) || [];
    const ids = {}, sz = {};
    for (let i = 0; i < universe.length; i++) {
      const u = universe[i] || {};
      const name = String(u.name || "").toUpperCase();
      if (!name) continue;
      ids[name] = 100000 + dexIndex * 10000 + i;
      sz[name] = Number.isFinite(u.szDecimals) ? u.szDecimals : 0;
    }
    const resolved = { ids, sz, dexIndex };
    await this._storeSet(ASSET_IDS_KEY, resolved);
    return resolved;
  }

  async _assetId(symbol) {
    const { coin } = this._normSymbol(symbol);
    const meta = await this._resolveMeta();
    const id = meta.ids[coin];
    if (id === undefined) throw new _EntError("VENUE_REJECTED", `entropy: dex 'io' 无此市场: ${coin}`);
    return { id, coin, szDecimals: meta.sz[coin] || 0 };
  }

  /** size 按 szDecimals 取整,转字符串(API 要求字符串)。 */
  _fmtSize(qty, szDecimals) {
    const n = _entNum(qty);
    if (n === null || n <= 0) throw new _EntError("VENUE_REJECTED", "entropy: 下单数量必须为正数");
    return parseFloat(n.toFixed(szDecimals)).toString();
  }

  /** 价格按 Hyperliquid 5 位有效数字口径取整,转字符串(API 要求字符串)。 */
  _fmtPrice(px) {
    const n = _entNum(px);
    if (n === null || n <= 0) throw new _EntError("VENUE_REJECTED", "entropy: 价格必须为正数");
    return parseFloat(n.toPrecision(5)).toString();
  }

  /** 经 /exchange 发送已签名 action;解析 order/cancel 通用响应。 */
  async _postExchange(signed) {
    const body = await _entFetch(this._baseUrl() + "/exchange", { method: "POST", body: signed });
    if (!body || body.status !== "ok" || !body.response) {
      const why = JSON.stringify(body).slice(0, 200);
      throw new _EntError("VENUE_REJECTED", "entropy: /exchange 拒绝: " + why);
    }
    return body.response;
  }

  /** 下单 → {orderId, status:'filled'|'pending'|'rejected'}。
   *  Hyperliquid 无原生市价单:市价单用 IOC 限价单代替;限价按 mark ±5% 估算
   *  (买+5%/卖-5%,官方 SDK 默认滑点做法)。price/size 按 API 要求传字符串。 */
  async placeOrder(o) {
    o = o || {};
    const { coin, symbol } = this._normSymbol(o.symbol);
    const side = String(o.side || "").toLowerCase();
    const isBuy = side === "buy" || side === "long";
    const isSell = side === "sell" || side === "short";
    if (!isBuy && !isSell) throw new _EntError("VENUE_REJECTED", "entropy: side 须为 buy/sell");
    const { id: assetId, szDecimals } = await this._assetId(coin);
    let tif = "Gtc", pxStr;
    const type = String(o.type || (o.price != null ? "limit" : "market")).toLowerCase();
    if (type === "market") {
      // 无原生市价单 → IOC 限价单代替;按 mark ±5% 估算限价
      const q = await this.getQuote(symbol);
      const mark = q.mark != null ? q.mark : (q.bid != null && q.ask != null ? (q.bid + q.ask) / 2 : null);
      if (mark === null) throw new _EntError("VENUE_REJECTED", `entropy: 取不到 ${symbol} 的 mark,市价单无法估算限价`);
      tif = "Ioc";
      pxStr = this._fmtPrice(mark * (isBuy ? 1.05 : 0.95));
    } else if (type === "limit") {
      if (o.price == null) throw new _EntError("VENUE_REJECTED", "entropy: 限价单必须给 price");
      pxStr = this._fmtPrice(o.price);
    } else {
      throw new _EntError("VENUE_REJECTED", `entropy: 不支持的订单类型: ${o.type}`);
    }
    const vendor = this._vendorLazy();
    const isTestnet = !!(this.creds && this.creds.useTestnet);
    const signed = vendor.signOrderAction(this._agentKey(), {
      type: "order",
      orders: [{
        a: assetId,
        b: isBuy,
        p: pxStr,
        s: this._fmtSize(o.qty, szDecimals),
        r: !!o.reduceOnly, // reduce-only 透传
        t: { limit: { tif } },
      }],
      grouping: "na",
    }, { nonce: Date.now(), isTestnet });
    const resp = await this._postExchange(signed);
    if (resp.type !== "order" || !resp.data || !Array.isArray(resp.data.statuses) || !resp.data.statuses[0]) {
      throw new _EntError("VENUE_REJECTED", "entropy: 下单响应异常: " + JSON.stringify(resp).slice(0, 200));
    }
    const st = resp.data.statuses[0];
    let out;
    if (st.filled) out = { orderId: st.filled.oid, status: "filled" };
    else if (st.resting) out = { orderId: st.resting.oid, status: "pending" };
    else {
      // {error: ...}:服务端拒绝(如 haltTrading/保证金不足),携带原话,不重试
      throw new _EntError("VENUE_REJECTED", "entropy: 下单被拒: " + String(st.error || JSON.stringify(st)).slice(0, 200));
    }
    // 记录 oid→assetId,供 cancelOrder 免 openOrders 反查
    try {
      if (Number.isSafeInteger(out.orderId)) {
        if (!this._orderAssets) this._orderAssets = {};
        this._orderAssets[out.orderId] = assetId;
      }
    } catch (e) { /* 映射记不上不影响下单结果 */ }
    return out;
  }

  /** 撤单 → true|false。cancel 需要 asset id:优先用下单时记录的映射,
   *  否则经 openOrders 反查。 */
  async cancelOrder(orderId) {
    const oid = Number(orderId);
    if (!Number.isSafeInteger(oid)) throw new _EntError("VENUE_REJECTED", "entropy: 撤单 orderId 非法");
    let assetId = this._orderAssets && this._orderAssets[oid];
    if (assetId === undefined) {
      const open = await this._postInfo({ type: "openOrders", user: this._userAddress(), dex: ENTROPY_DEX });
      const hit = Array.isArray(open) ? open.find((x) => x && Number(x.oid) === oid) : null;
      if (!hit) return false; // 已不在挂单里(已成交/已撤/不存在)
      const r = await this._assetId(hit.coin);
      assetId = r.id;
    }
    const vendor = this._vendorLazy();
    const isTestnet = !!(this.creds && this.creds.useTestnet);
    const signed = vendor.signCancelAction(this._agentKey(), {
      type: "cancel",
      cancels: [{ a: assetId, o: oid }],
    }, { nonce: Date.now(), isTestnet });
    const resp = await this._postExchange(signed);
    if (resp.type !== "cancel" || !resp.data || !Array.isArray(resp.data.statuses)) {
      throw new _EntError("VENUE_REJECTED", "entropy: 撤单响应异常: " + JSON.stringify(resp).slice(0, 200));
    }
    const st = resp.data.statuses[0];
    if (st === "success") return true;
    return false; // {error}:如订单已不在,视为未撤掉,不抛
  }

  /** 持仓 → [{venue, symbol, side, qty, entryPrice?, upnl?}]。
   *  只有 API 实际返回的字段才填:position.coin/szi/entryPx/unrealizedPnl。 */
  async getPositions() {
    const st = await this._postInfo({ type: "clearinghouseState", user: this._userAddress(), dex: ENTROPY_DEX });
    const arr = (st && st.assetPositions) || [];
    const out = [];
    for (const wrap of arr) {
      const p = (wrap && wrap.position) || {};
      const szi = _entNum(p.szi);
      if (szi === null || szi === 0) continue;
      const coin = String(p.coin || "").toUpperCase().replace(/^IO:/, "");
      if (!coin) continue;
      const pos = {
        venue: "entropy",
        symbol: ENTROPY_DEX + ":" + coin,
        side: szi > 0 ? "long" : "short",
        qty: Math.abs(szi),
      };
      const entry = _entNum(p.entryPx);      // API 实际返回:平均开仓价
      if (entry !== null) pos.entryPrice = entry;
      const upnl = _entNum(p.unrealizedPnl);  // API 实际返回:未实现盈亏(USD)
      if (upnl !== null) pos.upnl = upnl;
      out.push(pos);
    }
    return out;
  }

  /** 余额 → {equity} | null。取 clearinghouseState.marginSummary.accountValue(USD);
   *  字段缺失则返回 null,绝不编造。 */
  async getBalance() {
    const st = await this._postInfo({ type: "clearinghouseState", user: this._userAddress(), dex: ENTROPY_DEX });
    const ms = st && st.marginSummary;
    const equity = ms ? _entNum(ms.accountValue) : null; // API 实际返回:账户总价值
    if (equity === null) return null;
    return { equity };
  }

  /** 报价 → {bid, ask, mark}。bid/ask 取 l2Book(coin 用 dex:COIN 前缀);
   *  mark 取 allMids(dex:"io")。 */
  async getQuote(symbol) {
    const { coin, dexCoin } = this._normSymbol(symbol);
    const book = await this._postInfo({ type: "l2Book", coin: dexCoin });
    if (!book || !Array.isArray(book.levels)) {
      throw new _EntError("VENUE_REJECTED", `entropy: 取不到 ${dexCoin} 的盘口`);
    }
    const bids = book.levels[0] || [], asks = book.levels[1] || [];
    const bid = bids.length ? _entNum(bids[0].px) : null;
    const ask = asks.length ? _entNum(asks[0].px) : null;
    let mark = null;
    try {
      const mids = await this._postInfo({ type: "allMids", dex: ENTROPY_DEX });
      if (mids && typeof mids === "object") mark = _entNum(mids[coin] != null ? mids[coin] : mids[dexCoin]);
    } catch (e) { /* mark 缺失不致命,调用方按 bid/ask 处理 */ }
    return { bid, ask, mark };
  }

  /** 资金费率 → {rate, interval} | null。取 fundingHistory 最新一条;
   *  资金费每小时结算(固定 "1h"),费率与预言机由 deployer 定。 */
  async getFunding(symbol) {
    const { dexCoin } = this._normSymbol(symbol);
    const now = Date.now();
    const hist = await this._postInfo({
      type: "fundingHistory", coin: dexCoin,
      startTime: now - 2 * 3600 * 1000, endTime: now,
    });
    if (!Array.isArray(hist) || !hist.length) return null;
    const last = hist[hist.length - 1];
    const rate = _entNum(last && last.fundingRate); // API 实际返回:该小时资金费率(小数,如 0.0001)
    if (rate === null) return null;
    return { rate, interval: "1h" }; // 资金费每小时结算;参数由 deployer 设定
  }

  /** 市场目录 → [{symbol:'io:COIN', base, quote:'USD'}]。经 meta(dex:"io") 实时列出;
   *  已下架(isDelisted)市场过滤掉。 */
  async getMarkets() {
    const meta = await this._postInfo({ type: "meta", dex: ENTROPY_DEX });
    const universe = (meta && meta.universe) || [];
    return universe
      .filter((u) => u && u.name && !u.isDelisted)
      .map((u) => {
        const base = String(u.name).toUpperCase();
        return { symbol: ENTROPY_DEX + ":" + base, base, quote: "USD" };
      });
  }

  /** 健康检查:agent 钱包能查到 clearinghouseState(账户结构合法)即 true。
   *  说明:这验证的是"私钥合法+链路通";真正的 agent 授权(approveAgent)在首次
   *  签名 /exchange 时由服务端校验。401/403 或结构非法抛 VENUE_AUTH。 */
  async checkSession() {
    let st;
    try {
      st = await this._postInfo({ type: "clearinghouseState", user: this._userAddress(), dex: ENTROPY_DEX });
    } catch (e) {
      if (e && e.code === "VENUE_REJECTED" && (e.httpStatus === 401 || e.httpStatus === 403)) {
        throw new _EntError("VENUE_AUTH", "entropy: agent 钱包未授权(401/403),请检查主账户是否已 approveAgent");
      }
      throw e;
    }
    if (!st || !st.marginSummary || typeof st.marginSummary.accountValue !== "string") {
      throw new _EntError("VENUE_AUTH", "entropy: agent 钱包无有效账户结构");
    }
    return true;
  }

  /** 断开:清掉本 session 解析的 asset id 缓存(下次重连重新实时解析)。 */
  async disconnect() {
    this._agentAddress = null;
    this._vendor = null;
    this._orderAssets = null;
    try { await this._storeSet(ASSET_IDS_KEY, null); } catch (e) { /* ignore */ }
    if (this._mem) this._mem.delete(ASSET_IDS_KEY);
  }

  /** v1.3.0 策略引擎暂只接 Variational;Entropy 返回 null。 */
  getLegacyApi() { return null; }
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { EntropyAdapter };
}
/* service worker 里 importScripts 加载后挂到 globalThis,供 venues/index.js 的 _venueClass 查找
 * (class 声明本身不挂 globalThis) */
if (typeof globalThis !== "undefined") globalThis.EntropyAdapter = EntropyAdapter;
