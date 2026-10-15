/* Variational Omni API 客户端(浏览器内运行)。
 * 直接调用网页端同款接口,用浏览器已登录的 session(无需导出 Cookie、
 * 无需私钥,密钥只活在内存里,不写任何存储)。
 * 注意:这是非官方逆向接口,可能随网页更新失效;官方交易 API 发布后迁移。
 * 所有网络错误都抛 Error,附带中文说明,不裸奔。 */
"use strict";

const VARIATIONAL_API = "https://omni.variational.io/api";

// 有交易时段的 TradFi 标的(裸 symbol 或 -SWAP 后缀时按此时段做客户端风控)
const TRADFI_UNDERLYINGS = new Set([
  "US100", "US500", "US30", "USTECH", "JP225", "GER40",
  "UK100", "HK50", "XAU", "XAG", "UKOIL", "USOIL", "TWI",
]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 转成 API 要求的十进制字符串,去掉浮点噪音(0.30000000000000004 -> "0.3") */
function dec(x) {
  let s = Number(x).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" || s === "-0" ? "0" : s;
}

/** "US100-SWAP" -> ["US100","swap"]; "BTC" -> ["BTC","perp"](加密默认) */
function parseSymbol(symbol) {
  const s = String(symbol).toUpperCase().trim();
  if (s.endsWith("-SWAP")) return [s.slice(0, -5), "swap"];
  if (s.endsWith("-PERP")) return [s.slice(0, -5), "perp"];
  return [s, TRADFI_UNDERLYINGS.has(s) ? "swap" : "perp"];
}

/** TradFi SWAP 交易时段(UTC 粗略规则,仅客户端风控,最终以交易所为准) */
function tradfiOpenNow(dt) {
  dt = dt || new Date();
  const wd = dt.getUTCDay(); // 0=周日
  const mins = dt.getUTCHours() * 60 + dt.getUTCMinutes();
  if (wd === 6) return false;                       // 周六
  if (wd === 0) return mins >= 22 * 60;              // 周日 22:00 后开市
  if (wd === 5 && mins >= 21 * 60) return false;     // 周五 21:00 后收市
  return !(21 * 60 <= mins && mins < 22 * 60);       // 日结算休市
}

function isTradable(symbol) {
  const [, kind] = parseSymbol(symbol);
  if (kind === "perp") return true;
  try { return tradfiOpenNow(); } catch (e) { return true; }
}

/* v1.2.6:每个网络请求 25 秒强制超时,防永久 hanging 卡死主循环(busy 恒 true 冻住整轮)。
 * 超时错误带 code="VAT_TIMEOUT":成交状态不确定,调用方必须先对账再决策,禁止盲目重下。 */
const VAT_REQUEST_TIMEOUT_MS = 25000;

async function apiFetch(path, { method = "GET", body = null, timeoutMs = VAT_REQUEST_TIMEOUT_MS } = {}) {
  const init = {
    method,
    credentials: "include", // 带上浏览器里已登录的 session
    headers: { Accept: "application/json" },
  };
  if (body !== null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const req = { method, path, body };
  const timeoutErr = () => {
    const err = new Error(
      `请求超时(${Math.round(timeoutMs / 1000)}秒未响应),已主动中止。` +
      "成交状态不确定:如为下单请求,请先对账(查订单/持仓)再决定是否重下,不要盲目重下。");
    err.code = "VAT_TIMEOUT";
    err.apiRequest = req; // 当时发了什么,方便诊断
    return err;
  };
  let timer = null;
  const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  if (ctrl) init.signal = ctrl.signal;
  let resp;
  try {
    resp = await Promise.race([
      fetch(VARIATIONAL_API + path, init),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { if (ctrl) ctrl.abort(); } catch (e) { /* ignore */ }
          reject(timeoutErr());
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e && e.code === "VAT_TIMEOUT") throw e;
    // 浏览器里 abort 后 fetch 自己 reject(AbortError):同样按超时处理,不裸奔
    const msg = String((e && e.message) || e);
    if (e && (e.name === "AbortError" || /abort/i.test(msg))) {
      const te = timeoutErr();
      te.message += `(底层: ${msg.slice(0, 80)})`;
      throw te;
    }
    throw new Error(
      "连不上 Variational,可能是网络问题或当前 IP 被 Cloudflare 拦截。" +
      "请确认你能正常打开 omni.variational.io 网页端。");
  }
  if (timer) clearTimeout(timer);
  if (resp.status === 403) {
    throw new Error("被拒绝访问(HTTP 403),请确认已在浏览器里登录 omni.variational.io。");
  }
  if (resp.status === 401) {
    throw new Error("登录已过期(401),请在网页端重新登录后再试。");
  }
  let data = {};
  try { data = await resp.json(); } catch (e) { /* 空响应 */ }
  if (!resp.ok) {
    // 服务端是 FastAPI/pydantic 风格:422 的解释在 {"detail":[...]} 里,之前只读 message/error 会吞掉原因
    const msg = data && (data.message || data.error) ? String(data.message || data.error) : "";
    let dt = data && data.detail;
    const detailStr = Array.isArray(dt) ? JSON.stringify(dt).slice(0, 500)
      : (dt && typeof dt === "object" ? JSON.stringify(dt).slice(0, 500) : String(dt || ""));
    const why = (msg || detailStr).slice(0, 300);
    const err = new Error(`Variational 返回错误 HTTP ${resp.status}${why ? ": " + why : ""}`);
    err.response = data;                       // 完整响应体,方便诊断
    err.detail = detailStr || msg;              // 服务端原话(脱敏后可进日志)
    err.apiRequest = { method, path, body };   // 当时发了什么
    err.httpStatus = resp.status;
    throw err;
  }
  return data;
}

let _assets = null;
/** 最近一次目录抓取的诊断(给错误报告用,绝不含凭证)。v1.6.3:空结果不再污染缓存 */
let _assetsDiag = "尚未抓取";
/** 最近一次目录原文的全部 key(map 形状时即 underlying 真名列表),诊断兜底用 */
let _assetsRawKeys = [];
function directoryDiag() { return _assetsDiag; }
function rawAssetKeys() { return _assetsRawKeys.slice(); }
/** map 形状目录 {UNDERLYING: {...}|[...]|str} 的值展开成伪条目,key 即 underlying 真名 */
function dirMapEntries(key, val, out) {
  if (val == null) return;
  if (Array.isArray(val)) {
    for (const e of val) out.push({ __dirKey: key, __dirVal: e });
    return;
  }
  if (typeof val === "object") {
    const inner = Array.isArray(val.instruments) ? val.instruments
      : Array.isArray(val.markets) ? val.markets : null;
    if (inner) { for (const e of inner) out.push({ __dirKey: key, __dirVal: e }); return; }
    const subVals = Object.values(val);
    const looksNested = subVals.length > 0 && subVals.every((sv) =>
      sv && typeof sv === "object" && !Array.isArray(sv) &&
      (sv.instrument || sv.instrument_type || sv.underlying || sv.mark_price != null));
    if (looksNested) {
      for (const sk of Object.keys(val)) out.push({ __dirKey: key, __dirType: sk, __dirVal: val[sk] });
      return;
    }
    out.push({ __dirKey: key, __dirVal: val });
    return;
  }
  if (typeof val === "string" || typeof val === "number") {
    out.push({ __dirKey: key, __dirVal: { underlying: String(val) } });
  }
}
/** 抓目录:只缓存非空结果,空结果/失败不污染缓存(下次重试);每次都更新诊断 */
async function supportedAssets() {
  if (!_assets) {
    let status = 0, rawKeys = "", parsed = 0, note = "";
    try {
      const r = await apiFetch("/metadata/supported_assets");
      status = 200;
      let arr;
      if (Array.isArray(r)) { arr = r; rawKeys = "array"; }
      else if (r && typeof r === "object") {
        const keys = Object.keys(r);
        rawKeys = keys.slice(0, 8).join(",");
        _assetsRawKeys = keys;
        arr = r.assets || r.result || r.data;
        if (!Array.isArray(arr)) {
          // v1.6.4:目录是 {UNDERLYING: {...}|[...]} 的 map 形状(实测 key 如 FIL/XTZ/BSB/DELL/...)
          arr = [];
          for (const k of keys) dirMapEntries(k, r[k], arr);
          if (arr.length) note = "map形状已展开";
        }
      } else { arr = []; }
      parsed = Array.isArray(arr) ? arr.length : 0;
      if (parsed > 0) _assets = arr;
      else note = "解析出0条,未缓存(下次重试)";
    } catch (e) {
      status = (e && e.httpStatus) || 0;
      note = "抓取失败: " + String((e && e.message) || e).slice(0, 120);
    }
    _assetsDiag = (`HTTP ${status || "?"}; 原始形状 ${rawKeys || "?"}; 条目 ${parsed}; ${note || "ok"}`).slice(0, 300);
  }
  return _assets || [];
}

/** 某些标的在目录里的真名和常用名不一样,按顺序试 */
/* 真名来自用户浏览器 URL 实测 + 官方 swap 市场名单(Castle Labs 研报:首批 swap 为
 * US100/US500/XAU/XAG/USOIL,均为 plain 名)+官网 BTC PERP。
 * v1.6.6:顺序按"证据强度"排,实测成交过的放最前;但最终以真实询价验证为准(见 vatQuoteVerify),
 * 顺序只影响试错次数,不决定对错。 */
const UNDERLYING_ALIASES = {
  XAU: ["XAUS", "XAU"], // XAUS 已实测成交
  XAG: ["XAGS", "XAG"], // XAGS 已实测成交
  US100: ["US100", "US100S", "NDX", "NAS100"], // 研报:swap 真名为 US100
  US500: ["US500", "US500S", "SPX", "SP500"], // 研报:swap 真名为 US500
  UKOIL: ["UKOILP", "UKOILS", "UKOIL", "BRENT", "USOIL", "WTI", "OIL"], // UKOILP 已实测成交
  USOIL: ["USOIL", "USOILP", "USOILS"], // 研报:swap 真名为 USOIL;USOILP 未实测确认,解析时自动试
  TWI: ["TWI", "TWIS"],
  BTC: ["BTC", "BTCS"], // 官网首页为 BTC PERP
  ETH: ["ETH", "ETHS"],
  /* v1.6.7:新增 TradFi SWAP(用户 2026-10-09 浏览器 URL 实测,顺序即验证顺序) */
  DXI: ["DXIP", "DXI"],       // /swap/DXIP
  COPP: ["COPPP", "COPP"],    // /swap/COPPP
  CNA50: ["CNA50S", "CNA50"], // /swap/CNA50S
  GASOL: ["GASOLP", "GASOL"], // /swap/GASOLP
  USFNG: ["USFNGS", "USFNG"], // /swap/USFNGS
  COCOA: ["COCOAP", "COCOA"], // /swap/COCOAP
  VXI: ["VXIP", "VXI"],       // /swap/VXIP
};

/** 把目录条目规范成 {underlying, instrument_type, instrument},形状不对返回 null */
function normalizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  if (e.__dirVal !== undefined) {
    // v1.6.4:map 形状目录展开的伪条目,key 即 underlying 真名
    const v = e.__dirVal;
    const base = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    const underlying = base.underlying || base.symbol || e.__dirKey || "";
    if (!underlying) return null;
    const t = base.instrument_type || e.__dirType || "";
    // v1.6.5:目录值对象经常不带 underlying,询价用的 instrument 必须补上(之前 u= 空全 400)
    const srcInst = (base.instrument && typeof base.instrument === "object") ? base.instrument : base;
    const instrument = Object.assign({}, srcInst);
    if (!instrument.underlying) instrument.underlying = String(underlying).toUpperCase();
    return {
      underlying: String(underlying).toUpperCase(),
      instrument_type: /swap|perp|future/i.test(String(t)) ? String(t).toLowerCase() : "",
      instrument,
    };
  }
  const inst = e.instrument && typeof e.instrument === "object" ? e.instrument : e;
  const underlying = e.underlying || inst.underlying || e.symbol || "";
  if (!underlying) return null;
  return {
    underlying: String(underlying).toUpperCase(),
    instrument_type: String(e.instrument_type || inst.instrument_type || "").toLowerCase(),
    instrument: e.instrument && typeof e.instrument === "object" ? e.instrument : inst,
  };
}

/** 目录 underlying 名列表(解析失败时的诊断用);规范化为空时兜底用原文 key */
async function listUnderlyings() {
  try {
    const ks = Object.keys(await markets());
    if (ks.length) return ks;
  } catch (e) { /* fall through */ }
  try { return rawAssetKeys(); } catch (e) { return []; }
}

async function markets() {
  const out = {};
  for (const e of await supportedAssets()) {
    const n = normalizeEntry(e);
    if (!n) continue;
    (out[n.underlying] = out[n.underlying] || new Set()).add(n.instrument_type || "?");
  }
  const r = {};
  for (const u of Object.keys(out).sort()) r[u] = [...out[u]].sort();
  return r;
}

/** 已知的 kind(来自真实持仓返回),不知道的不填 */
const UNDERLYING_KIND = { XAUS: "commodity", XAGS: "commodity", UKOILS: "commodity", UKOILP: "commodity" };
/* v1.6.22:asset_class(网站前端询价会带,逆向自 omni.variational.io 前端 JS)。
 * BTC/ETH 不带会被 /quotes/* 直接 400(TradFi 不带也能过)。值取网站枚举小写: crypto/equity/... */
const UNDERLYING_ASSET_CLASS = {
  BTC: "crypto", ETH: "crypto", SOL: "crypto",
  BTCP: "crypto", ETHP: "crypto", SOLP: "crypto",
  BTCS: "crypto", ETHS: "crypto", SOLS: "crypto",
};

/** 本地构造 instrument(目录不可用时的兜底)。
 *  形状来自官方文档 + 真实持仓返回:
 *  SWAP: {instrument_type:"swap", underlying, settlement_asset:"USDC", funding_interval_s:0}
 *  PERP: {instrument_type:"perpetual_future", underlying, settlement_asset:"USDC", funding_interval_s:3600} */
function buildInstrument(underlying, kind) {
  const inst = kind === "swap"
    ? { instrument_type: "swap", underlying, settlement_asset: "USDC", funding_interval_s: 0 }
    : { instrument_type: "perpetual_future", underlying, settlement_asset: "USDC", funding_interval_s: 3600 };
  if (UNDERLYING_KIND[underlying]) inst.kind = UNDERLYING_KIND[underlying];
  if (UNDERLYING_ASSET_CLASS[underlying]) inst.asset_class = UNDERLYING_ASSET_CLASS[underlying];
  inst.symbol = underlying; /* v1.6.23:网站前端 instrument 用 symbol(逆向 omni 前端 JS),双字段都带 */
  return inst;
}

/** 用官方目录里的原始 instrument 对象,不自己猜编码,找不到就报错不下单 */
async function resolveInstrument(symbol) {
  const key = String(symbol).toUpperCase().trim();
  const [underlying, kind] = parseSymbol(key);
  const names = UNDERLYING_ALIASES[underlying] || [underlying];
  const want = kind === "swap" ? "swap" : "perp";
  const typeMatch = (t) =>
    !t || t === want || t.indexOf(want) === 0 ||
    (want === "perp" && t === "perpetual_future") ||
    (want === "swap" && t === "swap");
  // 1) 先试官方目录(如果它还能用)
  let dir = [];
  try { dir = (await supportedAssets()).map(normalizeEntry).filter(Boolean); }
  catch (e) { dir = []; }
  for (const pass of [0, 1]) {
    for (const u of names) {
      const hit = dir.find((a) =>
        (pass === 0 ? a.underlying === u : a.underlying.indexOf(u) >= 0) &&
        typeMatch(a.instrument_type));
      if (hit) {
        resolveInstrument.note = `目录命中 ${hit.underlying}(${hit.instrument_type || "?"})`;
        // v1.6.5:目录 instrument 为准,缺的字段用本地构造补(v1.2.1 的形状曾可询价),underlying 必有
        const inst = Object.assign(buildInstrument(hit.underlying, kind), hit.instrument);
        inst.underlying = hit.underlying;
        return inst;
      }
    }
  }
  // 2) 目录里没有(或目录接口挂了):本地构造,不拿目录卡脖子
  const resolved = names[0]; // 别名第一顺位即真名(如 XAU→XAUS)
  resolveInstrument.note = dir.length
    ? `目录无此标的,本地构造 ${resolved}(形状来自官方文档与真实持仓)`
    : `目录接口无返回,本地构造 ${resolved}(形状来自官方文档与真实持仓)`;
  return buildInstrument(resolved, kind);
}
resolveInstrument.note = "";

async function getMid(symbol) {
  const base = await resolveInstrument(symbol);
  let r = null, lastErr = null;
  const order = [vatDiag.instrumentVariant, 0, 1, 2].filter((x, i, a) => a.indexOf(x) === i);
  for (const v of order) {
    try {
      r = await apiFetch("/quotes/simple", {
        method: "POST", body: { instrument: instrumentVariant(base, v), qty: "1" },
      });
      if (v !== vatDiag.instrumentVariant) {
        vatDiag.instrumentVariant = v;
        log("WARN", "instrument 形状自适应(simple): " + symbol + " 命中 variant=" + v);
      }
      break;
    } catch (e) { lastErr = e; }
  }
  if (!r) throw lastErr;
  for (const k of ["mark_price", "markPrice", "mid_price", "price"]) {
    if (r[k] != null) return Number(r[k]);
  }
  throw new Error("取价失败,返回里没有 mark_price");
}

/** 预测资金费率(年化小数);SWAP 或取不到返回 null */
async function getFunding(symbol) {
  const [underlying, kind] = parseSymbol(symbol);
  if (kind !== "perp") return null;
  try {
    const r = await apiFetch(
      `/funding/v2?underlying=${encodeURIComponent(underlying)}&instrument_type=perpetual_future`);
    return r.predicted_funding_rate != null ? Number(r.predicted_funding_rate) : null;
  } catch (e) { return null; }
}

/** 登录探测:能读到持仓接口即视为已登录 */
async function checkSession() {
  await apiFetch("/positions");
  return true;
}

async function getPositions() {
  const r = await apiFetch("/positions");
  const rows = Array.isArray(r) ? r : (r.positions || r.result || []);
  return rows.filter((p) => p && typeof p === "object");
}

function positionQtyFor(rows, symbol) {
  const [underlying] = parseSymbol(symbol);
  for (const p of rows) {
    if (!JSON.stringify(p).includes(underlying)) continue;
    const info = p.position_info || p;
    const q = info.qty ?? info.quantity ?? info.size;
    if (q != null) return Number(q); // 正多负空
  }
  return 0;
}

async function getOpenOrders(symbol) {
  const r = await apiFetch("/orders/v2?limit=100");
  const rows = Array.isArray(r) ? r : (r.result || r.rows || []);
  const [underlying] = parseSymbol(symbol);
  return rows.filter((od) => od && typeof od === "object" &&
    JSON.stringify(od).includes(underlying) &&
    ["open", "pending", "new"].includes(String(od.status || "").toLowerCase()));
}

/** 撤单:rfq_id / order_id / id 逐个试(限价单返回的 id 字段名不固定),成功返回 true */
async function cancelOrder(orderId) {
  const id = String(orderId);
  for (const key of ["rfq_id", "order_id", "id"]) {
    try {
      await apiFetch("/orders/cancel", { method: "POST", body: { [key]: id } });
      return true;
    } catch (e) { /* 换下一个字段名试 */ }
  }
  return false;
}

async function cancelAll(symbol) {
  let n = 0;
  for (const od of await getOpenOrders(symbol)) {
    const rid = od.rfq_id || od.rfqId || od.id;
    if (rid && await cancelOrder(rid)) n++;
  }
  return n;
}

/** Maker 限价挂单(刷量用):字段形状来自 AlphaLabs R2 实测。
 *  成功返回 {orderId};dryRun=true 只返回将发内容。 */
/** 限价 Maker 单。dryRun=true 只返回请求预览。
 *  tif 枚举实测自 AlphaLabs R2 混淆包:GOOD_TIL_CANCELED / FILL_OR_KILL / IMMEDIATE_OR_CANCEL */
async function placeMakerOrder(symbol, side, qty, limitPrice,
  { tif = "GOOD_TIL_CANCELED", reduceOnly = false, dryRun = true } = {}) {
  const inst = await resolveInstrument(symbol);
  const prep = dryRun ? { qty: dec(qty), note: "" } : await prepareOrderQty(symbol, qty, side);
  const body = {
    order_type: "limit", // 服务端实锤:小写 snake_case(limit/stop_limit/take_profit/stop_loss),R2 包里的大写 LIMIT 是错的
    instrument: inst,
    side: side === "buy" ? "buy" : "sell",
    limit_price: dec(limitPrice),
    qty: prep.qty,
    is_reduce_only: !!reduceOnly,
    is_auto_resize: false,
    use_mark_price: false,
    tif,
  };
  if (dryRun) return { dryRun: true, method: "POST", path: "/orders/new/limit", body, note: "演练模式:未真实挂单" };
  const r = await apiFetch("/orders/new/limit", { method: "POST", body });
  const oid = r.rfq_id || r.rfqId || r.order_id || r.id;
  if (!oid) throw new Error("Maker 单被拒: " + JSON.stringify(r).slice(0, 300));
  return { orderId: String(oid), qty: prep.qty, qtyNote: prep.note, raw: r };
}

/** 限价单。dryRun=true 时只返回将要发送的请求预览,不真发。 */
async function placeLimit(symbol, side, qty, price, { dryRun = true } = {}) {
  const inst = await resolveInstrument(symbol);
  const body = {
    order_type: "limit", // 小写,见 placeMakerOrder 注释
    instrument: inst,
    side: side === "buy" ? "buy" : "sell",
    qty: dec(qty),
    limit_price: dec(price),
    is_reduce_only: false,
    is_auto_resize: false,
    use_mark_price: false,
    tif: "GOOD_TIL_CANCELED",
  };
  if (dryRun) return { dryRun: true, method: "POST", path: "/orders/new/limit", body };
  const r = await apiFetch("/orders/new/limit", { method: "POST", body });
  const rfq = r.rfq_id || r.rfqId;
  if (!rfq) throw new Error("限价单被拒: " + JSON.stringify(r).slice(0, 300));
  return { orderId: String(rfq), note: "RFQ已受理(成交请用持仓复核)" };
}

/** 询价(RFQ第一步,只询价不下单)。返回 {quoteId, mark, request, response} */
/* ---- tick 缓存:记住每个 underlying 的 min_qty_tick,询价前先取整 ----
 * US100 这类标的询价端点也会校验 qty 精度(400 空响应),不能像 XAU 那样先裸 qty 询价再取整。
 * 成功一次就记住,存在 chrome.storage.local,重启不丢。 */
const _tickMem = {};
async function tickCacheGet(underlying) {
  const u = String(underlying || "").toUpperCase();
  if (_tickMem[u]) return _tickMem[u];
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const r = await chrome.storage.local.get(["VAT_TICKS"]);
      const t = (r.VAT_TICKS || {})[u];
      if (t) { _tickMem[u] = t; return t; }
    }
  } catch (e) { /* ignore */ }
  return null;
}
async function tickCacheSet(underlying, tick) {
  const u = String(underlying || "").toUpperCase();
  _tickMem[u] = tick;
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const r = await chrome.storage.local.get(["VAT_TICKS"]);
      const all = r.VAT_TICKS || {};
      all[u] = tick;
      await chrome.storage.local.set({ VAT_TICKS: all });
    }
  } catch (e) { /* ignore */ }
}
function tickFromQuote(resp, side) {
  const lim = (((resp || {}).qty_limits || {})[side === "buy" ? "ask" : "bid"]) || {};
  return lim.min_qty_tick ? String(lim.min_qty_tick) : null;
}
/** 询价探测(只询价不下单,零风险):对某标的试几种 qty 精度,看哪个能过,顺手记住 tick。
 *  用于定位 US100 这类"询价 400 空响应"到底是精度问题还是别的。
 *  fallbackMark: /quotes/simple 取不到价时,用风控 mark 继续探测(只影响 $50 名义换算)。 */
async function probeQuote(symbol, fallbackMark) {
  const [underlying] = parseSymbol(symbol);
  const out = [];
  let mark = 0, markNote = "";
  try { mark = await getMid(symbol); }
  catch (e) {
    markNote = "simple取价失败: " + String(e.message).slice(0, 120);
    if (Number(fallbackMark) > 0) { mark = Number(fallbackMark); markNote += "(用风控mark继续探测)"; }
    else return { symbol, underlying, mark: 0, markNote, results: [{ qty: "-", ok: false, httpStatus: e.httpStatus || null, error: markNote }] };
  }
  const base = 50 / mark; // $50 名义
  const cands = [];
  const seen = new Set();
  const push = (v) => { const s = dec(v); if (Number(s) > 0 && !seen.has(s)) { seen.add(s); cands.push(s); } };
  push(base);
  for (const d of [6, 4, 3, 2]) push(Math.floor(base * Math.pow(10, d)) / Math.pow(10, d));
  for (const q of cands) {
    try {
      const r = await indicativeQuote(symbol, q);
      const tick = tickFromQuote(r.response, "buy") || tickFromQuote(r.response, "sell");
      if (tick) await tickCacheSet(underlying, tick);
      out.push({ qty: q, ok: true, httpStatus: 200, tick: tick || null });
    } catch (e) {
      out.push({ qty: q, ok: false, httpStatus: e.httpStatus || null, error: String(e.message).slice(0, 160) });
    }
  }
  return { symbol, underlying, mark, markNote, results: out };
}
/** 数量按 tick 向下取整(字符串运算,避免浮点误差)。tick 如 "0.00001" */
/** 数量按 tick 向下取整(字符串运算,避免浮点误差)。tick 如 "0.00001" */
function quantizeDown(qtyStr, tickStr) {
  const q = Number(qtyStr), t = Number(tickStr);
  if (!(q > 0) || !(t > 0)) return String(qtyStr);
  const n = Math.floor(q / t + 1e-9);
  if (n <= 0) return "0";
  const decimals = (String(tickStr).split(".")[1] || "").length;
  return (n * t).toFixed(decimals);
}

/** 下单前准备数量:先按已知精度预取整,再询价拿到 qty_limits 确认精度并检查 min_qty。
 *  返回 {qty(取整后), note, quote(第一次询价结果)} */
async function prepareOrderQty(symbol, qty, side = "buy") {
  const [underlying] = parseSymbol(symbol);
  let q = dec(qty);
  const rawQ = q;
  let note = "";
  // 有些标的(如 US100)询价端点也会校验 qty 精度,裸 qty 直接 400:先用缓存精度预取整
  const cached = await tickCacheGet(underlying);
  if (cached) {
    const qq = quantizeDown(q, cached);
    if (qq !== q && Number(qq) > 0) { note = `数量按已知精度 ${cached} 预取整: ${q} → ${qq}`; q = qq; }
  }
  // v1.6.21:冷启动数量精度试错。询价端点校验 qty 精度,裸 qty(如 8 位小数)可能直接 400
  // (US100 踩过:有精度缓存后正常,冷启动裸 qty 400)。无缓存时把精度逐级收紧(8→6→4→2 位)
  // 重试,命中即停并记 note;全 400 则按原逻辑抛给上层(由 vatQuoteVerify 判 false)。
  let first = null, last400 = null;
  if (cached) {
    first = await indicativeQuote(symbol, q);
  } else {
    for (const p of [8, 6, 4, 2]) {
      const qq = Number(q).toFixed(p).replace(/0+$/, "").replace(/\.$/, "");
      if (!(Number(qq) > 0)) continue;
      try {
        first = await indicativeQuote(symbol, qq);
        if (p !== 8) note += `${note ? ";" : ""}数量精度试错 ${p} 位小数通过(qty=${qq})`;
        q = qq;
        break;
      } catch (e) {
        if (e && e.httpStatus === 400) { last400 = e; continue; }
        throw e;
      }
    }
    if (!first) throw last400;
  }
  const tick = tickFromQuote(first.response, side) || tickFromQuote(first.response, side === "buy" ? "sell" : "buy");
  if (tick) await tickCacheSet(underlying, tick);
  const lim = (((first.response || {}).qty_limits || {})[side === "buy" ? "ask" : "bid"]) || {};
  if (lim.min_qty_tick && Number(lim.min_qty_tick) > 0) {
    const qq = quantizeDown(q, String(lim.min_qty_tick));
    if (qq !== q) {
      note = `数量按最小变动单位 ${lim.min_qty_tick} 取整: ${q} → ${qq}`;
      q = qq;
    }
  }
  if (lim.min_qty && Number(q) < Number(lim.min_qty)) {
    const mark = Number((first.response || {}).mark_price ?? (first.response || {}).markPrice ?? 0);
    const minUsd = mark > 0 ? `,该标的约需 ≥ ${(Number(lim.min_qty) * mark).toFixed(2)} USDC 名义` : "";
    throw new Error(`数量 ${rawQ} 取整后为 ${q},低于最小下单量 ${lim.min_qty}${minUsd},请调大金额后再试`);
  }
  return { qty: q, note, quote: first };
}

/* v1.6.23 自诊断:依次试三种 instrument 形状,命中即用并记住。
 * variant 0=当前(含 symbol+underlying 双字段);1=只留 symbol;2=只留 underlying。 */
const vatDiag = { instrumentVariant: 0 };
function instrumentVariant(inst, variant) {
  const o = Object.assign({}, inst);
  if (variant === 1) delete o.underlying;
  if (variant === 2) delete o.symbol;
  return o;
}
async function indicativeQuote(symbol, qty) {
  const base = await resolveInstrument(symbol);
  let lastErr = null, q = null, usedVariant = vatDiag.instrumentVariant, body = null;
  const order = [vatDiag.instrumentVariant, 0, 1, 2].filter((x, i, a) => a.indexOf(x) === i);
  for (const v of order) {
    body = { instrument: instrumentVariant(base, v), qty: dec(qty) };
    try {
      q = await apiFetch("/quotes/indicative", { method: "POST", body });
      usedVariant = v;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!q) throw lastErr;
  if (usedVariant !== vatDiag.instrumentVariant) {
    vatDiag.instrumentVariant = usedVariant;
    log("WARN", "instrument 形状自适应: " + symbol + " 命中 variant=" + usedVariant);
  }
  const qid = q.quote_id || q.quoteId;
  if (!qid) throw new Error("询价失败(RFQ): " + JSON.stringify(q).slice(0, 300));
  return {
    quoteId: qid,
    mark: q.mark_price ?? q.markPrice ?? null,
    request: { method: "POST", path: "/quotes/indicative", body },
    response: q,
  };
}

/** 市价单:RFQ 两步(先 /quotes/indicative 询价,再 /orders/new/market)。
 *  ack 不等于成交:用下单前后持仓变化对账(约 6 秒),对不上就明确告诉你。 */
async function placeMarket(symbol, side, qty, { maxSlippageBps = 50, dryRun = true } = {}) {
  const inst = await resolveInstrument(symbol);
  if (dryRun) {
    return {
      dryRun: true,
      steps: [
        { method: "POST", path: "/quotes/indicative",
          body: { instrument: inst, qty: dec(qty) } },
        { method: "POST", path: "/orders/new/market",
          body: { quote_id: "<询价返回的 quote_id>", side: side === "buy" ? "buy" : "sell",
                  max_slippage: maxSlippageBps / 1e4, instrument: inst, qty: dec(qty) } },
      ],
      note: "演练模式:以上是第一步询价、第二步下单将要发送的内容,都没真发。",
    };
  }
  // 实盘:先按交易所的 qty_limits 把数量取整,再用取整后的数量询价+下单
  const prep = await prepareOrderQty(symbol, qty, side);
  const qstr = prep.qty;
  const { quoteId: qid, mark, request: qReq, response: qRes } =
    qstr === dec(qty) ? prep.quote : await indicativeQuote(symbol, qstr);
  const before = positionQtyFor(await getPositions().catch(() => []), symbol);
  const body = {
    quote_id: qid,
    side: side === "buy" ? "buy" : "sell",
    max_slippage: maxSlippageBps / 1e4, // 注意:线上是小数(0.005=0.5%),不是 bps
    instrument: inst,
    qty: qstr,
  };
  const r = await apiFetch("/orders/new/market", { method: "POST", body });
  const rfq = r.rfq_id || r.rfqId;
  if (!rfq) throw new Error("市价单被拒: " + JSON.stringify(r).slice(0, 300));
  // 对账:下单前后持仓变化
  let filled = false;
  for (let i = 0; i < 3; i++) {
    await sleep(2000);
    const after = positionQtyFor(await getPositions().catch(() => []), symbol);
    if (Math.abs(Math.abs(after - before) - Number(qstr)) <= Math.max(Number(qstr) * 0.02, 1e-9)) {
      filled = true; break;
    }
  }
  return {
    orderId: String(rfq),
    filled,
    fillPrice: mark != null ? Number(mark) : null,
    qty: qstr,
    qtyNote: prep.note,
    note: filled ? "持仓对账确认成交" : "RFQ已受理但持仓对账未确认,请手动在持仓里复核",
    steps: [
      qReq,
      { method: "POST", path: "/orders/new/market", body, response: r },
    ],
    quoteResponse: qRes,
  };
}

/* ============ 自动交易扩展:mark 查找 / 订单确认 / reduce-only ============ */

/** 深搜 mark_price/mark(来自 R3 的 findMark,处理 risk_limits 嵌套返回) */
function findMark(o, seen) {
  seen = seen || new Set();
  if (o == null) return 0;
  if (typeof o !== "object" || seen.has(o)) return 0;
  seen.add(o);
  if ("mark_price" in o) { const v = Number(o.mark_price); if (Number.isFinite(v) && v > 0) return v; }
  if ("mark" in o) { const v = Number(o.mark); if (Number.isFinite(v) && v > 0) return v; }
  for (const v of Object.values(o)) { const m = findMark(v, seen); if (m > 0) return m; }
  return 0;
}

/** 用 risk_limits 校验某个 underlying 是否真实可交易,返回 mark(0 表示不可用)。
 *  instrumentType: "swap" 或 "perpetual_future"(加密标的可能是 perp) */
async function getRiskMark(underlying, instrumentType) {
  const it = instrumentType === "perpetual_future" ? "perpetual_future" : "swap";
  try {
    const r = await apiFetch(
      "/metadata/v2/risk_limits?underlying=" + encodeURIComponent(underlying) + "&instrument_type=" + it);
    return findMark(r);
  } catch (e) { return 0; }
}

/** 从询价返回里算保证金需求(取 bid/ask 两侧 initial_margin 的较大值;
 *  兼容嵌套 bid_margin_delta 与扁平 initial_margin 两种返回形状) */
function marginNeedFromQuote(q) {
  const mr = (q && q.margin_requirements) || {};
  const vals = [mr?.bid_margin_delta?.initial_margin, mr?.ask_margin_delta?.initial_margin, mr?.initial_margin]
    .map(Number).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : 0;
}

/** 最近订单(给 confirmRfq 轮询用) */
async function getOrdersV2() {
  const r = await apiFetch("/orders/v2?order_by=created_at&order=desc&limit=50&offset=0");
  if (Array.isArray(r)) return r;
  return r?.result || r?.data?.result || r?.rows || [];
}

/** 按 rfq_id 轮询订单状态:成功(cleared/filled/success)→{ok:true};
 *  拒绝(rejected/failed)→{ok:false};5 轮没定论→{ok:null,status:'pending'} */
async function confirmRfq(rfqId) {
  if (!rfqId) return { ok: false, status: "missing_rfq" };
  for (let i = 0; i < 5; i++) {
    await sleep(700);
    try {
      const list = await getOrdersV2();
      const x = Array.isArray(list) ? list.find((o) => String(o.rfq_id || o.rfqId || "") === String(rfqId)) : null;
      if (x) {
        const st = String(x.status || "").toLowerCase();
        const cs = String(x.clearing_status || x.clearingStatus || "").toLowerCase();
        if (st === "rejected" || cs.includes("rejected") || cs.includes("failed"))
          return { ok: false, status: st || cs, order: x };
        if (st === "cleared" || st === "filled" || cs.includes("success"))
          return { ok: true, status: st || cs, order: x };
      }
    } catch (e) { /* 下一轮 */ }
  }
  return { ok: null, status: "pending" };
}

/** 市价单(自动交易版):支持 reduceOnly 平仓、decimal 滑点、返回 rfq 供 confirm 轮询。
 *  dryRun=true 只返回将发内容,不真发。 */
async function placeMarketAuto(symbol, side, qty, { maxSlippage = 0.003, reduceOnly = false, dryRun = true } = {}) {
  const inst = await resolveInstrument(symbol);
  const body = {
    quote_id: "<询价返回的 quote_id>",
    side: side === "buy" ? "buy" : "sell", // 服务端只要小写(2026-09-29 实测)
    max_slippage: Number(maxSlippage),
    instrument: inst,
    qty: dec(qty),
  };
  if (reduceOnly) body.is_reduce_only = true;
  if (dryRun) {
    return { dryRun: true, body, note: "演练模式:未真实下单" };
  }
  const prep = await prepareOrderQty(symbol, qty, side);
  const qstr = prep.qty;
  const { quoteId: qid } = qstr === dec(qty) ? prep.quote : await indicativeQuote(symbol, qstr);
  body.quote_id = qid;
  body.qty = qstr;
  const r = await apiFetch("/orders/new/market", { method: "POST", body });
  const rfq = r.rfq_id || r.rfqId || r?.data?.rfq_id;
  if (!rfq) throw new Error("市价单被拒: " + JSON.stringify(r).slice(0, 300));
  return { rfqId: String(rfq), qty: qstr, raw: r };
}

/* node 回归测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { placeMakerOrder, placeLimit, placeMarket, indicativeQuote, probeQuote,
    tickCacheGet, tickCacheSet, UNDERLYING_ALIASES,
    prepareOrderQty, resolveInstrument, quantizeDown, dec, apiFetch, VAT_REQUEST_TIMEOUT_MS,
    supportedAssets, listUnderlyings, directoryDiag, rawAssetKeys, normalizeEntry,
    UNDERLYING_ASSET_CLASS };
}
