"use strict";
/* v1.4.0: Arcus 适配器 (api.arcus.xyz)。Arcus 从 waitlist 转为 live。
 *
 * 调研依据:第三方机器人 ~/workspace/user/files/arcus-bot-share-001.zip 内 bot.py 的 ArcusClient
 * (1092~1303行) + order_payload(1046) + canonical(1043) + parse_account(1062) +
 * make_body(1439) + cancel(1291) + OrderStream 订阅格式(1303起)。只抄 API 层,不抄策略。
 *  - 基址: https://api.arcus.xyz (mainnet); creds.useTestnet=true 切 https://api.testnet.arcus.xyz。
 *  - 凭证:后端生成的 Ed25519 API Signing Key(64 hex seed,不是钱包私钥) + 钱包地址 +
 *    accountIndex 子账户,经构造参数 creds {walletAddress, apiSigningKey, accountIndex, useTestnet} 传入。
 *  - 认证:请求头 X-API-Key=Ed25519公钥hex;GET 私有接口只带该头;
 *    POST 下单/撤单另带 X-Timestamp(纳秒) + X-Signature=hex(Ed25519签名(规范JSON))。
 *  - 规范JSON = Python json.dumps(separators=(',',':'), sort_keys=True, ensure_ascii=True) 的等价实现。
 *  - 下单签名体 {ad,ai,ct,g,m,op:1,p,q,r,s,t,v,c?},撤单体 {ad,ai,ct,m,op:2,v:1,id?|c?};
 *    side BUY=0/SELL=1;tif GTT=0/FOK=1/IOC=2/ALO=3;价格/数量先转 tick/step 整数。
 *  - WS wss://api.arcus.xyz/v1/ws 可订阅 orders/userFills(格式见 OrderStream),本适配器
 *    暂只用 REST 轮询(持仓/挂单),不断 WS,不断开不断连,无后台推送。
 *
 * 铁律(沿用 venues/adapter.js):
 *  - 所有网络请求 25 秒强制超时(vatFetchJson);写操作单次尝试,绝不自动重试
 *    (超时/429/5xx 上抛 VenueError,由调用方先对账再决策,禁止盲目重下)。
 *  - 统一错误形状 VenueError{code,message,retryable}。
 *  - 凭证只经构造参数传入,绝不进日志/心跳/报警/错误报告(本文件无任何 console 输出)。
 *  - 纯类+函数,不依赖 chrome.*,可在 service worker 与 node 测试里跑。
 *  - Ed25519 不依赖 crypto.subtle:本文件自带纯 JS 实现(SHA-512+Ed25519,BigInt),
 *    已用 RFC8032 已知答案向量逐字节验证(见 test_venue_arcus.js)。
 *  - 策略引擎(v1.3.0)仍只跑 Variational:Arcus 只做可切换+凭证+持仓+下单 plumbing,
 *    getLegacyApi() 返回 null,不接入 strategy.js。
 *
 * 未确认、需实盘/测试网复核的点:
 *  1) HTTP body 里 timestamp 用 JSON number 发送(>2^53,JS 只能取整到 256ns);
 *     签名体 ct / 请求头 X-Timestamp / body timestamp 三处保持同一取整值,实盘若被拒
 *     再改 string 形式。
 *  2) POST /v1/placeOrder 与 /v1/cancelOrder 的响应字段(orderId 命名等)——按 bot 的
 *     WS 对账习惯做了防御性映射(orderId/order_id/id),实盘复核。
 *  3) GET /v1/openOrders 的 market 参数是否必填——实现为可选,实盘复核。
 *  4) /v1/bbo/{market} 的 market 参数用 marketDisplayName(如 BTC-USD)——按 bot 实现,实盘复核。
 *  5) 资金费率查询端点未确认:getFunding 返回 null。
 */

/* 依赖解析:node 里 require("./adapter.js");SW 里 adapter.js 已先 importScripts,
 * 三个名字是全局词法绑定,直接引用即可(本文件不声明同名局部变量,避免遮蔽)。 */
const _ARD = (typeof require === "function")
  ? (() => { try { return require("./adapter.js"); } catch (e) { return null; } })()
  : null;
/* eslint-disable-next-line no-undef */
const _ArcAdapter = _ARD ? _ARD.VenueAdapter
  : (typeof VenueAdapter !== "undefined" ? VenueAdapter : null);
/* eslint-disable-next-line no-undef */
const _ArcError = _ARD ? _ARD.VenueError
  : (typeof VenueError !== "undefined" ? VenueError : null);
/* eslint-disable-next-line no-undef */
const _arcFetch = _ARD ? _ARD.vatFetchJson
  : (typeof vatFetchJson !== "undefined" ? vatFetchJson : null);
/* eslint-disable-next-line no-undef */
const _ARC_TIMEOUT = _ARD ? _ARD.VAT_ADAPTER_TIMEOUT_MS
  : (typeof VAT_ADAPTER_TIMEOUT_MS !== "undefined" ? VAT_ADAPTER_TIMEOUT_MS : 25000);
if (!_ArcAdapter || !_ArcError || !_arcFetch) {
  throw new Error("arcus: 缺少 venues/adapter.js 的基类/工具(adapter.js 未加载)");
}

const ARCUS_BASE_MAINNET = "https://api.arcus.xyz";
const ARCUS_BASE_TESTNET = "https://api.testnet.arcus.xyz";
const ARCUS_QUOTE_MAX_AGE_MS = 15000;   // 报价新鲜度上限,跟 bot.py quote_max_age_seconds=15 一致
const ARCUS_GOOD_TIL_DAYS = 40;        // goodTilTime,跟 bot.py good_til_days=40 一致
const ARCUS_TIF = { GTT: 0, FOK: 1, IOC: 2, ALO: 3 };
const ARCUS_SIDE = { BUY: 0, SELL: 1 };

/* ================= 纯 JS SHA-512 (BigInt,无外部依赖) =================
 * K 常量由整数开立方根精确推导(前 80 个素数立方根小数部分 * 2^64),与 FIPS 180-4 一致;
 * 实现已用 node crypto 交叉验证(见 test_venue_arcus.js)。 */
const _SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];
const _SHA512_H = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const _M64 = (1n << 64n) - 1n;
function _rotr64(x, n) { return ((x >> n) | (x << (64n - n))) & _M64; }

/** SHA-512,返回 Uint8Array(64)。输入 Uint8Array。 */
function _arcSha512(msg) {
  const bytes = Array.from(msg);
  const bitLen = BigInt(msg.length) * 8n;
  bytes.push(0x80);
  while (bytes.length % 128 !== 112) bytes.push(0);
  for (let i = 15; i >= 0; i--) bytes.push(Number((bitLen >> BigInt(i * 8)) & 0xffn));
  let h = _SHA512_H.slice();
  const nBlocks = bytes.length / 128;
  for (let b = 0; b < nBlocks; b++) {
    const w = new Array(80);
    for (let t = 0; t < 16; t++) {
      let v = 0n;
      for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(bytes[b * 128 + t * 8 + k]);
      w[t] = v;
    }
    for (let t = 16; t < 80; t++) {
      const s0 = _rotr64(w[t - 15], 1n) ^ _rotr64(w[t - 15], 8n) ^ (w[t - 15] >> 7n);
      const s1 = _rotr64(w[t - 2], 19n) ^ _rotr64(w[t - 2], 61n) ^ (w[t - 2] >> 6n);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & _M64;
    }
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 80; t++) {
      const S1 = _rotr64(e, 14n) ^ _rotr64(e, 18n) ^ _rotr64(e, 41n);
      const ch = (e & f) ^ ((~e) & g);
      const t1 = (hh + S1 + ch + _SHA512_K[t] + w[t]) & _M64;
      const S0 = _rotr64(a, 28n) ^ _rotr64(a, 34n) ^ _rotr64(a, 39n);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) & _M64;
      hh = g; g = f; f = e; e = (d + t1) & _M64; d = c; c = bb; bb = a; a = (t1 + t2) & _M64;
    }
    const nv = [a, bb, c, d, e, f, g, hh];
    h = h.map((x, i) => (x + nv[i]) & _M64);
  }
  const out = new Uint8Array(64);
  h.forEach((x, i) => { for (let k = 0; k < 8; k++) out[i * 8 + k] = Number((x >> BigInt(56 - 8 * k)) & 0xffn); });
  return out;
}

/* ================= 纯 JS Ed25519 (BigInt,确定性 RFC8032) =================
 * 已用已知答案向量逐字节验证:seed 00..1f → 公钥 03a107bf…5531b8,签名 466a65fb…aa0600a。 */
const _ED_P = (1n << 255n) - 19n;
const _ED_L = (1n << 252n) + 27742317777372353535851937790883648493n;
function _edMod(a) { a %= _ED_P; return a < 0n ? a + _ED_P : a; }
function _edPow(a, e) {
  let r = 1n; a = _edMod(a);
  while (e > 0n) { if (e & 1n) r = _edMod(r * a); a = _edMod(a * a); e >>= 1n; }
  return r;
}
const _ED_D = _edMod(-121665n * _edPow(121666n, _ED_P - 2n));
function _edPt(x, y) { return [_edMod(x), _edMod(y), 1n, _edMod(x * y)]; }
const _ED_G = _edPt(
  15112221349535400772501151409588531511454012693041857206046113283949847762202n,
  46316835694926478169428394003475163141307993866256225615783033603165251855960n);
const _ED_ID = [0n, 1n, 1n, 0n];
function _edAdd(p, q) {
  const X1 = p[0], Y1 = p[1], Z1 = p[2], T1 = p[3];
  const X2 = q[0], Y2 = q[1], Z2 = q[2], T2 = q[3];
  const A = _edMod((Y1 - X1) * (Y2 - X2));
  const B = _edMod((Y1 + X1) * (Y2 + X2));
  const C = _edMod(T1 * 2n * _ED_D * T2);
  const Dd = _edMod(2n * Z1 * Z2);
  const E = _edMod(B - A), F = _edMod(Dd - C), Gg = _edMod(Dd + C), Hh = _edMod(B + A);
  return [_edMod(E * F), _edMod(Gg * Hh), _edMod(F * Gg), _edMod(E * Hh)];
}
function _edDbl(p) {
  const X1 = p[0], Y1 = p[1], Z1 = p[2];
  const A = _edMod(X1 * X1), B = _edMod(Y1 * Y1), C = _edMod(2n * Z1 * Z1);
  const Dd = _edMod(-A);
  const E = _edMod((X1 + Y1) * (X1 + Y1) - A - B);
  const Gg = _edMod(Dd + B), F = _edMod(Gg - C), Hh = _edMod(Dd - B);
  return [_edMod(E * F), _edMod(Gg * Hh), _edMod(F * Gg), _edMod(E * Hh)];
}
function _edMult(p, s) {
  let q = _ED_ID;
  for (let i = 255; i >= 0; i--) {
    q = _edDbl(q);
    if ((s >> BigInt(i)) & 1n) q = _edAdd(q, p);
  }
  return q;
}
function _edEncode(p) {
  const invZ = _edPow(p[2], _ED_P - 2n);
  const x = _edMod(p[0] * invZ), y = _edMod(p[1] * invZ);
  const out = new Uint8Array(32);
  let yy = y;
  for (let i = 0; i < 32; i++) { out[i] = Number(yy & 0xffn); yy >>= 8n; }
  if (x & 1n) out[31] |= 0x80;
  return out;
}
function _edDecodeLE(b) {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}
function _edEncodeLE32(v) {
  const o = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { o[i] = Number(v & 0xffn); v >>= 8n; }
  return o;
}
function _edClamp(v) { return (v & ~(7n | (3n << 254n))) | (1n << 254n); }
function _edConcat() {
  let n = 0;
  for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
  const o = new Uint8Array(n);
  let j = 0;
  for (let i = 0; i < arguments.length; i++) { o.set(arguments[i], j); j += arguments[i].length; }
  return o;
}
function _edHex(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
function _edUnhex(s) {
  s = String(s);
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return o;
}

/** 由 32 字节 seed 推 Ed25519 公钥,返回 Uint8Array(32)。 */
function _edPubkeyFromSeed(seed) {
  const h = _arcSha512(seed);
  const a = _edClamp(_edDecodeLE(h.subarray(0, 32)));
  return _edEncode(_edMult(_ED_G, a));
}
/** Ed25519 确定性签名,返回 Uint8Array(64)。 */
function _edSign(seed, msg) {
  const h = _arcSha512(seed);
  const a = _edClamp(_edDecodeLE(h.subarray(0, 32)));
  const A = _edEncode(_edMult(_ED_G, a));
  const r = _edDecodeLE(_arcSha512(_edConcat(h.subarray(32, 64), msg))) % _ED_L;
  const R = _edEncode(_edMult(_ED_G, r));
  const k = _edDecodeLE(_arcSha512(_edConcat(R, A, msg))) % _ED_L;
  const S = (r + k * a) % _ED_L;
  return _edConcat(R, _edEncodeLE32(S));
}
function _edDecodePoint(enc) {
  if (enc.length !== 32) return null;
  const y = _edDecodeLE(enc) & ((1n << 255n) - 1n);
  const xOdd = (enc[31] >> 7) & 1;
  const y2 = _edMod(y * y);
  const x2 = _edMod(_edMod(y2 - 1n) * _edPow(_edMod(_ED_D * y2 + 1n), _ED_P - 2n));
  let x = _edPow(x2, (_ED_P + 3n) / 8n);
  if (_edMod(x * x) !== x2) x = _edMod(x * _edPow(2n, (_ED_P - 1n) / 4n));
  if (_edMod(x * x) !== x2) return null;
  if ((x & 1n) !== BigInt(xOdd)) x = _edMod(-x);
  return _edPt(x, y);
}
/** 验签(测试用),返回 bool。 */
function _edVerify(sig, msg, pub) {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  if (!(pub instanceof Uint8Array) || pub.length !== 32) return false;
  const R = _edDecodePoint(sig.subarray(0, 32));
  const A = _edDecodePoint(pub);
  if (!R || !A) return false;
  const S = _edDecodeLE(sig.subarray(32, 64));
  if (S >= _ED_L) return false;
  const k = _edDecodeLE(_arcSha512(_edConcat(sig.subarray(0, 32), pub, msg))) % _ED_L;
  const lhs = _edMult(_ED_G, S);
  const rhs = _edAdd(R, _edMult(A, k));
  const iz1 = _edPow(lhs[2], _ED_P - 2n), iz2 = _edPow(rhs[2], _ED_P - 2n);
  return _edMod(lhs[0] * iz1) === _edMod(rhs[0] * iz2) &&
         _edMod(lhs[1] * iz1) === _edMod(rhs[1] * iz2);
}

/* ================= 规范 JSON =================
 * 等价 Python: json.dumps(value, separators=(',',':'), sort_keys=True, ensure_ascii=True)。
 * Arcus 签名原文必须逐字节一致;payload 里只有 ASCII 字符串/整数/布尔。 */
function _arcJsonString(s) {
  let out = JSON.stringify(s);
  out = out.replace(/[^\x20-\x7e]/g, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp <= 0xffff) return "\\u" + cp.toString(16).padStart(4, "0");
    const hi = ((cp - 0x10000) >> 10) + 0xd800, lo = ((cp - 0x10000) & 0x3ff) + 0xdc00;
    return "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
  });
  return out;
}
/** 规范 JSON,返回 Uint8Array(utf8)。BigInt 按十进制整数序列化(纳秒时间戳超 2^53,必须用 BigInt)。 */
function _arcCanonical(value) {
  const parts = [];
  (function enc(v) {
    if (v === null || v === undefined) { parts.push("null"); return; }
    if (typeof v === "bigint") { parts.push(v.toString()); return; }
    if (typeof v === "number") {
      if (!Number.isInteger(v)) throw new _ArcError("VENUE_UNKNOWN", "arcus: 规范 JSON 不支持非整数 number");
      parts.push(String(v)); return;
    }
    if (typeof v === "boolean") { parts.push(v ? "true" : "false"); return; }
    if (typeof v === "string") { parts.push(_arcJsonString(v)); return; }
    if (Array.isArray(v)) {
      parts.push("[");
      for (let i = 0; i < v.length; i++) { if (i) parts.push(","); enc(v[i]); }
      parts.push("]"); return;
    }
    if (typeof v === "object") {
      const ks = Object.keys(v).sort();
      parts.push("{");
      for (let i = 0; i < ks.length; i++) {
        if (i) parts.push(",");
        parts.push(_arcJsonString(ks[i])); parts.push(":"); enc(v[ks[i]]);
      }
      parts.push("}"); return;
    }
    throw new _ArcError("VENUE_UNKNOWN", "arcus: 规范 JSON 不支持类型 " + typeof v);
  })(value);
  return new TextEncoder().encode(parts.join(""));
}

/* ================= 十进制精确运算(避开浮点) ================= */
function _arcExpandSci(s) {
  s = String(s).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const neg = m[1] === "-";
  let digits = m[2] + (m[3] || "");
  let exp = parseInt(m[4], 10) - (m[3] || "").length;
  while (exp > 0) { digits += "0"; exp--; }
  if (exp < 0) {
    const pos = digits.length + exp;
    digits = pos > 0 ? digits.slice(0, pos) + "." + digits.slice(pos)
                     : "0." + "0".repeat(-pos) + digits;
  }
  return (neg ? "-" : "") + digits;
}
function _arcFracDigits(s) {
  s = _arcExpandSci(String(s));
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}
/** 十进制字符串 → BigInt(s * 10^scale)。格式非法抛 VENUE_REJECTED。 */
function _arcScaled(s, scale) {
  s = _arcExpandSci(String(s).trim());
  const neg = s[0] === "-";
  if (neg || s[0] === "+") s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new _ArcError("VENUE_REJECTED", "arcus: 数值格式无效: " + String(s).slice(0, 40));
  const ps = s.split(".");
  const ip = ps[0] || "0", fp = ps[1] || "";
  if (fp.length > scale) throw new _ArcError("VENUE_UNKNOWN", "arcus: 内部精度错误");
  const v = BigInt(ip + fp.padEnd(scale, "0"));
  return neg ? -v : v;
}
/** value 必须是 unit 的整数倍,返回 BigInt 倍数;否则抛(对应 bot.py order_payload 的 integer())。 */
function _arcToTicks(valueStr, unitStr, what) {
  const sc = Math.max(_arcFracDigits(valueStr), _arcFracDigits(unitStr));
  const v = _arcScaled(valueStr, sc), u = _arcScaled(unitStr, sc);
  if (u <= 0n) throw new _ArcError("VENUE_REJECTED", "arcus: 市场精度无效(" + what + ")");
  if (v <= 0n) throw new _ArcError("VENUE_REJECTED", "arcus: " + what + "必须为正数");
  if (v % u !== 0n) throw new _ArcError("VENUE_REJECTED", "arcus: " + what + "不符合交易所精度(非 tick/step 整数倍)");
  return v / u;
}
/** 价格向 tick 对齐:up=true 向上取整(买单,保证吃单),false 向下取整(卖单)。返回十进制字符串。 */
function _arcSnapToTick(valueStr, tickStr, up) {
  const sc = Math.max(_arcFracDigits(valueStr), _arcFracDigits(tickStr));
  const v = _arcScaled(valueStr, sc), t = _arcScaled(tickStr, sc);
  if (t <= 0n || v <= 0n) throw new _ArcError("VENUE_REJECTED", "arcus: 价格/精度无效");
  let q = v / t;
  if (v % t !== 0n && up) q += 1n;
  const scaled = q * t, base = 10n ** BigInt(sc);
  const ip = scaled / base;
  if (sc === 0) return ip.toString();
  const fp = (scaled % base).toString().padStart(sc, "0").replace(/0+$/, "");
  return fp ? ip.toString() + "." + fp : ip.toString();
}
/** 十进制字符串规范化(去科学计数法/多余零),用于 HTTP body 的 quantity/price。 */
function _arcNormDec(s) {
  s = _arcExpandSci(String(s).trim());
  const neg = s[0] === "-";
  if (neg || s[0] === "+") s = s.slice(1);
  const ps = s.split(".");
  let ip = (ps[0] || "0").replace(/^0+(?=\d)/, "");
  let fp = (ps[1] || "").replace(/0+$/, "");
  return (neg ? "-" : "") + ip + (fp ? "." + fp : "");
}
function _arcBig(v, what) {
  try {
    const b = BigInt(String(v).trim());
    return b;
  } catch (e) {
    throw new _ArcError("VENUE_REJECTED", "arcus: " + what + "不是整数: " + String(v).slice(0, 40));
  }
}

/** 下单签名体构造(与 bot.py order_payload 字段一一对应),返回可直接 canonical 的对象。 */
function _arcOrderPayload(o) {
  // o: {address, accountIndex, timestamp(BigInt|number), goodTilMicros(BigInt|str),
  //     marketId, priceTicks(BigInt), qtySteps(BigInt), reduceOnly, side('buy'|'sell'),
  //     timeInForce('GTT'|'FOK'|'IOC'|'ALO'), clientId?}
  const tifCode = ARCUS_TIF[o.timeInForce];
  if (tifCode === undefined) throw new _ArcError("VENUE_REJECTED", "arcus: 不支持的 timeInForce: " + o.timeInForce);
  const payload = {
    ad: String(o.address).toLowerCase(),
    ai: Number(o.accountIndex),
    ct: typeof o.timestamp === "bigint" ? o.timestamp : BigInt(Number(o.timestamp)),
    g: BigInt(o.goodTilMicros) * 1000n,
    m: Number(o.marketId),
    op: 1,
    p: typeof o.priceTicks === "bigint" ? o.priceTicks : BigInt(o.priceTicks),
    q: typeof o.qtySteps === "bigint" ? o.qtySteps : BigInt(o.qtySteps),
    r: o.reduceOnly ? 1 : 0,
    s: o.side === "buy" ? ARCUS_SIDE.BUY : ARCUS_SIDE.SELL,
    t: tifCode,
    v: 1,
  };
  if (o.clientId) payload.c = String(o.clientId);
  return payload;
}
/** 撤单签名体构造(与 bot.py cancel 的 payload 对应)。 */
function _arcCancelPayload(o) {
  // o: {address, accountIndex, timestamp, marketId, orderId?|clientId?}
  const payload = {
    ad: String(o.address).toLowerCase(),
    ai: Number(o.accountIndex),
    ct: typeof o.timestamp === "bigint" ? o.timestamp : BigInt(Number(o.timestamp)),
    m: Number(o.marketId),
    op: 2,
    v: 1,
  };
  if (o.orderId != null) payload.id = String(o.orderId);
  else if (o.clientId) payload.c = String(o.clientId);
  else throw new _ArcError("VENUE_UNKNOWN", "arcus: 撤单签名体需要 orderId 或 clientId");
  return payload;
}

/* ================= Arcus 适配器 ================= */
class ArcusAdapter extends _ArcAdapter {
  constructor(id, opts) {
    super(id, opts);
    opts = opts || {};
    const c = this.creds || {};
    this.base = c.useTestnet ? ARCUS_BASE_TESTNET : ARCUS_BASE_MAINNET;
    this.requestTimeoutMs = opts.requestTimeoutMs || _ARC_TIMEOUT;
    // 签名可注入:opts.signer=async(seedHex, msgBytes)=>sigHex;缺省用内置纯 JS Ed25519。
    this._signer = opts.signer || (async (seedHex, msgBytes) =>
      _edHex(_edSign(_edUnhex(seedHex), msgBytes)));
    this._clockNs = null;      // BigInt,服务器纳秒
    this._clockEpochMs = 0;    // Date.now() 对应时刻
    this._lastNonce = 0n;
    this._pubkeyHex = null;
    this._markets = null;
  }

  /* ---- 凭证与身份 ---- */
  _creds() {
    const c = this.creds || {};
    const address = String(c.walletAddress || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new _ArcError("VENUE_AUTH", "arcus: 钱包地址无效,应为 0x 开头的 40 位 hex");
    }
    const seedHex = String(c.apiSigningKey || "").replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(seedHex)) {
      throw new _ArcError("VENUE_AUTH", "arcus: API Signing Key 无效,应为 64 位 hex 的 Ed25519 seed(后端生成,不是钱包私钥)");
    }
    const accountIndex = c.accountIndex == null || c.accountIndex === "" ? 0 : Number(c.accountIndex);
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
      throw new _ArcError("VENUE_AUTH", "arcus: accountIndex 必须为非负整数");
    }
    return { address, seedHex, accountIndex };
  }
  async _pubkey() {
    if (!this._pubkeyHex) {
      const { seedHex } = this._creds();
      this._pubkeyHex = _edHex(_edPubkeyFromSeed(_edUnhex(seedHex)));
    }
    return this._pubkeyHex;
  }
  _acctParams() {
    const { address, accountIndex } = this._creds();
    return { address, accountIndex: String(accountIndex) };
  }

  /* ---- 时钟与 nonce(跟 bot.py sync_time/now_ns/nonce 一致) ---- */
  async _syncTime() {
    const data = await _arcFetch(this.base + "/v1/time", {
      method: "GET", headers: { "X-API-Key": await this._pubkey() },
      timeoutMs: this.requestTimeoutMs,
    });
    const ns = _arcBig(data && data.timeNs, "/v1/time 返回");
    if (ns < 1000000000000000000n) throw new _ArcError("VENUE_REJECTED", "arcus: 服务器时间不是 Unix 纳秒");
    this._clockNs = ns;
    this._clockEpochMs = Date.now();
  }
  async _nowNs() {
    if (this._clockNs == null || Date.now() - this._clockEpochMs > 60000) await this._syncTime();
    return this._clockNs + BigInt(Date.now() - this._clockEpochMs) * 1000000n;
  }
  async _nonce() {
    const now = await this._nowNs();
    this._lastNonce = this._lastNonce + 1n > now ? this._lastNonce + 1n : now;
    return this._lastNonce;
  }

  /* ---- 签名请求头 ---- */
  async _signedHeaders(tsNum, payloadObj) {
    const { seedHex } = this._creds();
    const msg = _arcCanonical(payloadObj);
    const sigHex = await this._signer(seedHex, msg);
    if (!/^[0-9a-f]{128}$/i.test(String(sigHex || ""))) {
      throw new _ArcError("VENUE_UNKNOWN", "arcus: 签名器返回无效");
    }
    return {
      "X-API-Key": await this._pubkey(),
      "X-Timestamp": String(tsNum),
      "X-Signature": String(sigHex).toLowerCase(),
    };
  }
  /** 私有 GET:只带 X-API-Key(跟 bot.py 一致,GET 不逐请求签名)。 */
  async _privGet(path, params, extraHeaders) {
    const qs = new URLSearchParams(params || {}).toString();
    const headers = Object.assign({ "X-API-Key": await this._pubkey() }, extraHeaders || {});
    return _arcFetch(this.base + path + (qs ? "?" + qs : ""), {
      method: "GET", headers, timeoutMs: this.requestTimeoutMs,
    });
  }

  /* ---- 会话检查:调 /v1/apiKeys 校验(跟 bot.py verify_key 一致) ---- */
  async checkSession() {
    const { address, accountIndex } = this._creds();
    const pubkey = await this._pubkey();
    const data = await this._privGet("/v1/apiKeys", { address });
    const rows = Array.isArray(data && data.apiKeys) ? data.apiKeys : [];
    const matches = rows.filter((k) => k &&
      String(k.apiKey || "").toLowerCase() === pubkey &&
      k.status === "ACTIVE" &&
      (k.allSubaccounts === true || Number(k.accountIndex) === accountIndex));
    if (matches.length !== 1) {
      throw new _ArcError("VENUE_AUTH", "arcus: API Key 未授权/未激活/子账户范围不符(需 ACTIVE 且覆盖当前 accountIndex)");
    }
    const vu = matches[0].validUntil;
    if (vu != null && String(vu) !== "0" && Number(vu) <= Date.now()) {
      throw new _ArcError("VENUE_AUTH", "arcus: API Key 已过期");
    }
    await this._syncTime(); // 顺带验证时钟端点可达
    return true;
  }

  /* ---- 市场 ---- */
  async getMarkets() {
    if (this._markets) return this._markets;
    const data = await this._privGet("/v1/markets");
    const list = Array.isArray(data && data.markets) ? data.markets : [];
    this._markets = list
      .filter((m) => m && m.marketDisplayName)
      .map((m) => ({
        symbol: String(m.marketDisplayName),
        base: m.baseAsset != null ? String(m.baseAsset) : null,
        quote: m.quoteAsset != null ? String(m.quoteAsset) : null,
        marketId: Number(m.marketId),
        tickSize: String(m.tickSize),
        stepSize: String(m.stepSize),
        minOrderSize: String(m.minOrderSize),
        maxOrderSize: String(m.maxOrderSize),
        minOrderNotional: String(m.minOrderNotional),
        status: m.status != null ? String(m.status) : null,
        initialMarginFraction: m.initialMarginFraction != null ? String(m.initialMarginFraction) : null,
      }));
    return this._markets;
  }
  async _market(symbol) {
    const ms = await this.getMarkets();
    const m = ms.find((x) => x.symbol === symbol);
    if (!m) throw new _ArcError("VENUE_UNKNOWN", "arcus: 未找到市场 " + symbol + ",请用 getMarkets() 确认确切代码");
    for (const k of ["tickSize", "stepSize", "minOrderSize", "maxOrderSize", "minOrderNotional"]) {
      if (!(Number(m[k]) > 0)) throw new _ArcError("VENUE_REJECTED", "arcus: 市场精度/数量限制无效: " + k);
    }
    return m;
  }

  /* ---- 报价(含新鲜度检查,跟 bot.py quote 一致) ---- */
  async getQuote(symbol) {
    if (!symbol) throw new _ArcError("VENUE_UNKNOWN", "arcus: getQuote 缺少 symbol");
    const data = await this._privGet("/v1/bbo/" + encodeURIComponent(symbol));
    const tsMicros = _arcBig(data && data.timestamp, "/v1/bbo 返回");
    const ageMs = Number(await this._nowNs() / 1000000n - tsMicros / 1000n);
    if (!(ageMs >= -5000 && ageMs <= ARCUS_QUOTE_MAX_AGE_MS)) {
      throw new _ArcError("VENUE_REJECTED", "arcus: 报价过期(超 " + ARCUS_QUOTE_MAX_AGE_MS / 1000 + " 秒),拒绝使用");
    }
    const bid = Number(data.bestBid && data.bestBid.price);
    const ask = Number(data.bestAsk && data.bestAsk.price);
    if (!(bid > 0) || !(ask > 0) || !(bid <= ask)) {
      throw new _ArcError("VENUE_REJECTED", "arcus: 报价无效");
    }
    return { bid, ask, mark: (bid + ask) / 2 };
  }

  /* ---- K线(跟 bot.py candles 一致):GET /v1/candles?market=&timeframe=&to(微秒)=&countback= ----
   * 返回 [{time(秒,整数),open,high,low,close,volume,isFinal}]。time 由 openTime(微秒)换算。 */
  async getCandles(symbol, timeframe, count) {
    if (!symbol) throw new _ArcError("VENUE_UNKNOWN", "arcus: getCandles 缺少 symbol");
    timeframe = timeframe || "5m";
    count = Math.max(1, Math.min(1000, Number(count) || 50));
    const toMicros = (await this._nowNs() / 1000n).toString();
    const data = await this._privGet("/v1/candles", {
      market: symbol, timeframe, to: toMicros, countback: String(count),
    });
    const rows = Array.isArray(data && data.candles) ? data.candles : [];
    return rows.map((r) => ({
      time: Math.floor(Number(r.openTime) / 1e6),
      open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      volume: r.volume != null ? Number(r.volume) : 0,
      isFinal: r.isFinal === true,
    }));
  }

  /* ---- 杠杆校验(跟 bot.py verify_leverage 一致) ----
   * GET /v1/leverages?address=&accountIndex=&market=,按 marketId 匹配;
   * 杠杆或保证金模式与期望不一致抛 VENUE_AUTH(需用户在交易所预设好)。 */
  async verifyLeverage(symbol, expectedLev, expectedMarginMode) {
    if (!symbol) throw new _ArcError("VENUE_UNKNOWN", "arcus: verifyLeverage 缺少 symbol");
    const m = await this._market(symbol);
    const { address, accountIndex } = this._creds();
    const data = await this._privGet("/v1/leverages", { address, accountIndex, market: symbol });
    const rows = Array.isArray(data && data.leverages) ? data.leverages : [];
    const hit = rows.find((x) => x && Number(x.marketId) === m.marketId);
    if (!hit) throw new _ArcError("VENUE_AUTH", "arcus: 未找到市场杠杆配置: " + symbol);
    const mode = String(expectedMarginMode || "CROSS").toUpperCase();
    if (Number(hit.leverage) !== Number(expectedLev) ||
        String(hit.marginMode || "").toUpperCase() !== mode) {
      throw new _ArcError("VENUE_AUTH",
        "arcus: 杠杆/保证金模式与配置不一致(期望 " + expectedLev + "x/" + mode +
        ",实际 " + hit.leverage + "x/" + hit.marginMode + "),请在交易所预设");
    }
    return true;
  }

  /* ---- 账户/持仓/余额(跟 bot.py parse_account 一致:身份/量纲不一致抛错) ---- */
  async getAccount() {
    const { address, accountIndex } = this._creds();
    const data = await this._privGet("/v1/account", this._acctParams(),
      { "Cache-Control": "no-cache", Pragma: "no-cache" });
    if (!data || typeof data !== "object" || !data.positions || typeof data.positions !== "object") {
      throw new _ArcError("VENUE_REJECTED", "arcus: /v1/account 响应格式异常,不按空仓处理");
    }
    if (String(data.address || "").toLowerCase() !== address || Number(data.accountIndex) !== accountIndex) {
      throw new _ArcError("VENUE_REJECTED", "arcus: 账户身份不匹配");
    }
    const positions = {};
    for (const mid of Object.keys(data.positions)) {
      const p = data.positions[mid];
      if (!p || typeof p !== "object") continue;
      if (Number(p.marketId) !== Number(mid)) throw new _ArcError("VENUE_REJECTED", "arcus: 持仓 marketId 不匹配");
      if (String(p.address || "").toLowerCase() !== address || Number(p.accountIndex) !== accountIndex) {
        throw new _ArcError("VENUE_REJECTED", "arcus: 持仓账户不匹配");
      }
      const qty = Number(p.size);
      if (!qty) continue;
      if ((qty > 0 && p.side !== "LONG") || (qty < 0 && p.side !== "SHORT")) {
        throw new _ArcError("VENUE_REJECTED", "arcus: 持仓数量与方向不一致");
      }
      const entry = Number(p.averageEntryPrice), mark = Number(p.markPx);
      const notional = Math.abs(Number(p.positionValueNotional));
      if (!(entry > 0) || !(mark > 0) || !(notional > 0)) {
        throw new _ArcError("VENUE_REJECTED", "arcus: 持仓价格/名义金额异常");
      }
      const calculated = Math.abs(qty) * mark;
      if (Math.abs(calculated - notional) / Math.max(calculated, notional) > 0.02) {
        throw new _ArcError("VENUE_REJECTED", "arcus: 持仓数量与名义金额量纲不一致(>2%),拒绝猜测");
      }
      positions[String(p.marketDisplayName)] = {
        qty, qtyStr: _arcNormDec(String(p.size).replace(/^-/, "")),
        side: qty > 0 ? "long" : "short",
        entryPrice: entry, mark, notional, marketId: Number(mid),
      };
    }
    return {
      equity: String(data.equity), freeCollateral: String(data.freeCollateral),
      netDeposits: data.netDeposits != null ? String(data.netDeposits) : null,
      sequence: data.sequenceNumber != null ? Number(data.sequenceNumber) : null,
      positions,
    };
  }
  async getPositions() {
    const acct = await this.getAccount();
    return Object.keys(acct.positions).map((symbol) => {
      const p = acct.positions[symbol];
      const r = { venue: "arcus", symbol, side: p.side, qty: Math.abs(p.qty), entryPrice: p.entryPrice };
      r.qtyStr = p.qtyStr; // 保留原始精度字符串,供 closeAllPositions 下单用
      // 注意:Arcus 持仓无 upnl 字段,不填,不编造
      return r;
    });
  }
  async getBalance() {
    const acct = await this.getAccount();
    return { equity: Number(acct.equity), available: Number(acct.freeCollateral) };
  }

  /* ---- 下单 ----
   * 写操作单次尝试,绝不自动重试:超时/429/5xx 直接上抛 VenueError,
   * 调用方必须先对账(查订单/持仓)再决定是否重下,禁止盲目重下。 */
  async placeOrder(o) {
    o = o || {};
    const { address, accountIndex } = this._creds();
    const symbol = o.symbol;
    if (!symbol) throw new _ArcError("VENUE_UNKNOWN", "arcus: placeOrder 缺少 symbol");
    const m = await this._market(symbol);
    if (m.status !== "ONLINE") throw new _ArcError("VENUE_REJECTED", "arcus: 市场未开放(status=" + m.status + ")");
    const side = String(o.side || "").toLowerCase();
    if (side !== "buy" && side !== "sell") throw new _ArcError("VENUE_REJECTED", "arcus: side 必须为 buy/sell");
    const tif = String(o.timeInForce || "ALO").toUpperCase();
    if (ARCUS_TIF[tif] === undefined) throw new _ArcError("VENUE_REJECTED", "arcus: 不支持的 timeInForce: " + tif);
    const reduceOnly = !!o.reduceOnly;
    const qtyStr = _arcNormDec(o.qty), priceStr = _arcNormDec(o.price);
    const qtyNum = Number(qtyStr), priceNum = Number(priceStr);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) throw new _ArcError("VENUE_REJECTED", "arcus: 数量必须为正数");
    if (!Number.isFinite(priceNum) || priceNum <= 0) throw new _ArcError("VENUE_REJECTED", "arcus: 价格必须为正数");
    // 精度校验:价格/数量必须为 tickSize/stepSize 整数倍(跟 bot.py order_payload 的 integer() 一致)
    const pTicks = _arcToTicks(priceStr, m.tickSize, "价格");
    const qSteps = _arcToTicks(qtyStr, m.stepSize, "数量");
    if (qtyNum > Number(m.maxOrderSize)) throw new _ArcError("VENUE_REJECTED", "arcus: 数量超过 maxOrderSize");
    if (!reduceOnly) {
      if (qtyNum < Number(m.minOrderSize)) throw new _ArcError("VENUE_REJECTED", "arcus: 数量低于 minOrderSize,不自动放大");
      if (qtyNum * priceNum < Number(m.minOrderNotional)) {
        throw new _ArcError("VENUE_REJECTED", "arcus: 名义金额低于 minOrderNotional");
      }
    }
    const ts = await this._nonce(); // BigInt 纳秒,单调递增
    // 注意:JSON number 只能精确到 2^53,纳秒取整到 256ns;签名体 ct / 请求头 X-Timestamp /
    // HTTP body timestamp 三处用同一取整值,保持一致(未确认点,见文件头)。
    const tsNum = Number(ts);
    const goodTilMicros = (ts / 1000n + BigInt(ARCUS_GOOD_TIL_DAYS) * 86400n * 1000000n).toString();
    const cid = o.clientId ? String(o.clientId) : ("arc-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 46656).toString(36));
    if (!/^[\x20-\x7e]{1,64}$/.test(cid)) throw new _ArcError("VENUE_REJECTED", "arcus: clientId 必须为 ASCII 字符串");
    const body = {
      address, accountIndex,
      marketId: m.marketId,
      orderSide: side === "buy" ? "BUY" : "SELL",
      orderType: "LIMIT",
      timeInForce: tif,
      quantity: qtyStr,
      price: priceStr,
      goodTilTime: goodTilMicros,
      timestamp: tsNum,
      clientId: cid,
      reduceOnly: reduceOnly,
    };
    const payload = _arcOrderPayload({
      address, accountIndex, timestamp: tsNum, goodTilMicros,
      marketId: m.marketId, priceTicks: pTicks, qtySteps: qSteps,
      reduceOnly, side, timeInForce: tif, clientId: cid,
    });
    const headers = await this._signedHeaders(tsNum, payload);
    const qs = new URLSearchParams(this._acctParams()).toString();
    const data = await _arcFetch(this.base + "/v1/placeOrder?" + qs, {
      method: "POST", headers, body, timeoutMs: this.requestTimeoutMs,
    });
    if (data && data.error) {
      throw new _ArcError("VENUE_REJECTED", "arcus: 下单被拒: " + String(data.error).slice(0, 200));
    }
    const orderId = data && (data.orderId != null ? data.orderId
      : data.order_id != null ? data.order_id : data.id);
    return {
      orderId: orderId != null ? String(orderId) : null,
      status: orderId != null ? "pending" : "rejected",
      clientId: cid, raw: data,
    };
  }

  /* ---- 挂单查询(撤单解析 marketId 用;market 参数可选,未确认,见文件头) ---- */
  async _openOrders(symbol) {
    const params = this._acctParams();
    if (symbol) params.market = symbol;
    const data = await this._privGet("/v1/openOrders", params);
    return Array.isArray(data && data.orders) ? data.orders : [];
  }

  /* ---- 撤单:orderId 或 opts.clientId 二选一;marketId 可经 opts 传入或从挂单解析 ---- */
  async cancelOrder(orderId, opts) {
    opts = opts || {};
    const { address, accountIndex } = this._creds();
    const clientId = opts.clientId != null ? String(opts.clientId) : null;
    if (orderId == null && !clientId) {
      throw new _ArcError("VENUE_UNKNOWN", "arcus: cancelOrder 需要 orderId 或 opts.clientId");
    }
    let marketId = opts.marketId != null ? Number(opts.marketId) : null;
    if (opts.symbol && marketId == null) marketId = (await this._market(opts.symbol)).marketId;
    if (marketId == null) {
      const opens = await this._openOrders();
      const row = opens.find((r) => r &&
        ((orderId != null && String(r.orderId) === String(orderId)) ||
         (clientId && String(r.clientId) === String(clientId))));
      if (!row || row.marketId == null) {
        throw new _ArcError("VENUE_REJECTED", "arcus: 撤单失败:未在挂单中找到该订单,无法确定 marketId");
      }
      marketId = Number(row.marketId);
    }
    const ts = await this._nonce();
    const tsNum = Number(ts);
    const body = { address, accountIndex, marketId, timestamp: tsNum };
    const payload = _arcCancelPayload({ address, accountIndex, timestamp: tsNum, marketId, orderId, clientId });
    if (orderId != null) { body.kind = "orderId"; body.orderId = String(orderId); }
    else { body.kind = "clientId"; body.clientId = clientId; }
    const headers = await this._signedHeaders(tsNum, payload);
    const qs = new URLSearchParams(this._acctParams()).toString();
    const data = await _arcFetch(this.base + "/v1/cancelOrder?" + qs, {
      method: "POST", headers, body, timeoutMs: this.requestTimeoutMs,
    });
    if (data && data.error) {
      throw new _ArcError("VENUE_REJECTED", "arcus: 撤单被拒: " + String(data.error).slice(0, 200));
    }
    return true;
  }

  /* ---- 全部平仓:逐仓 reduce-only IOC,按盘口吃单(long→按 bid 卖,short→按 ask 买) ---- */
  async closeAllPositions() {
    const poss = await this.getPositions();
    const results = [];
    for (const p of poss) {
      const m = await this._market(p.symbol);
      const q = await this.getQuote(p.symbol);
      const sell = p.side === "long";
      const ref = sell ? q.bid : q.ask;
      if (!(ref > 0)) throw new _ArcError("VENUE_REJECTED", "arcus: " + p.symbol + " 报价无效,无法平仓");
      const price = _arcSnapToTick(String(ref), m.tickSize, !sell); // buy 向上取整,sell 向下取整,保证立即成交
      const r = await this.placeOrder({
        symbol: p.symbol, side: sell ? "sell" : "buy",
        qty: p.qtyStr || String(p.qty), price,
        timeInForce: "IOC", reduceOnly: true,
      });
      results.push({ symbol: p.symbol, side: sell ? "sell" : "buy", qty: p.qtyStr || String(p.qty), price, orderId: r.orderId, clientId: r.clientId });
    }
    return { closed: results.length, results };
  }

  /** 资金费率查询端点未确认,返回 null。 */
  async getFunding(_symbol) { return null; }

  /** v1.3.0 策略引擎只接 Variational,Arcus 返回 null(见文件头)。 */
  getLegacyApi() { return null; }

  async disconnect() { /* REST 无状态,无操作 */ }
}

/* service worker 里 importScripts 加载后挂到 globalThis,供 venues/index.js 的 _venueClass 查找 */
if (typeof globalThis !== "undefined") {
  globalThis.ArcusAdapter = ArcusAdapter;
  globalThis.ArcusEd25519 = { sha512: _arcSha512, pubkeyFromSeed: _edPubkeyFromSeed, sign: _edSign, verify: _edVerify, hex: _edHex, unhex: _edUnhex };
  globalThis.ArcusTest = { canonical: _arcCanonical, orderPayload: _arcOrderPayload, cancelPayload: _arcCancelPayload, toTicks: _arcToTicks, snapToTick: _arcSnapToTick, normDec: _arcNormDec };
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ArcusAdapter,
    ArcusEd25519: { sha512: _arcSha512, pubkeyFromSeed: _edPubkeyFromSeed, sign: _edSign, verify: _edVerify, hex: _edHex, unhex: _edUnhex },
    ArcusTest: { canonical: _arcCanonical, orderPayload: _arcOrderPayload, cancelPayload: _arcCancelPayload, toTicks: _arcToTicks, snapToTick: _arcSnapToTick, normDec: _arcNormDec },
  };
}
