"use strict";
/* v1.3.0 Phase E: Lighter 签名器 vendor 占位(stub)。
 *
 * 签名路线结论(2026-10-04,经公开文档 + 官方 SDK 源码 + 真实 signer 输出三方核验):
 *  1. Lighter L2 交易签名是 Poseidon 曲线 Schnorr,API key 是 40 字节 Poseidon/Schnorr
 *     keypair,不是 secp256k1/ECDSA(依据:openfort recipes-hub 对官方 WASM signer 的
 *     接口文档:"GenerateAPIKey() generates a Poseidon/Schnorr API keypair (NOT an
 *     EVM key)";Go SDK types/txtypes 引用 poseidon_crypto/curve/ecgfp5 + schnorr)。
 *  2. 因此 @noble/secp256k1 路线在密码学上就是错的——本文件故意没有打包 noble,
 *     也不提供任何"看起来能签名"的假实现(铁律:不猜编码)。
 *  3. 精确的签名/哈希实现是官方 Go 仓库(elliottech/lighter-go)的 reference
 *     implementation,REST 公开文档未披露细节;且按铁律不做真实下单、无真实凭证可验,
 *     任何自研纯 JS 复刻都无法验证正确性——故本文件只定义接口,方法一律抛
 *     VENUE_UNKNOWN 并写清原因。
 *
 * 可行的后续路线(需 parent/用户决策,本 Phase 不擅自做):
 *  A. 官方预编译 WASM:lighter-signer.wasm + wasm_exec.js(来源如 lighter-ts 的 npm
 *     包、ccxt/lighter-wasm),在扩展内实例化后实现本文件定义的接口
 *     (CreateAuthToken / SignCreateOrder / SignCancelOrder …)。
 *  B. 本机 signer 服务:调官方 Go signer 编译出的本机二进制/动态库。
 *
 * 接口(真实 signer 实现时按此签名):
 *  createLighterSigner({apiPrivateKey, chainId}) -> {
 *    mintAuthToken({deadlineUnix, apiKeyIndex, accountIndex}) -> Promise<string>,
 *      // 返回 "expiry_unix:account_index:api_key_index:random_hex"
 *    signTx({txType, txInfo}) -> Promise<{txInfo:string, signature:string, txHash:string}>,
 *      // txInfo 为含 Sig 字段的 JSON 字符串;signature 为 tx_info 内的 Sig 值;
 *      // txHash 为 L2 交易哈希(首元素为 chainId:主网 304 / 测试网 300)
 *    kind: "stub" | "wasm" | "native",
 *  }
 */

let _VenueError = null;
try {
  if (typeof require === "function") _VenueError = require("../adapter.js").VenueError;
} catch (e) { /* browser: adapter.js 先行加载,走 globalThis */ }
if (!_VenueError && typeof globalThis !== "undefined" && globalThis.VenueError) {
  _VenueError = globalThis.VenueError;
}
function _venueUnknown(why) {
  const E = _VenueError || Error;
  if (_VenueError) return new _VenueError("VENUE_UNKNOWN", why, false);
  const e = new E(why); e.code = "VENUE_UNKNOWN"; return e;
}

const SIGNER_BLOCKER =
  "Lighter L2 交易签名需官方 Go signer(Poseidon 曲线 Schnorr;API key 为 40 字节 " +
  "Poseidon/Schnorr keypair,不是 EVM/secp256k1 key)。纯 JS noble-secp256k1 路线在密码学上 " +
  "不适用,REST 公开文档亦未披露签名/哈希细节,故本 stub 拒绝伪造签名。可行路线:加载官方预编译 " +
  "lighter-signer.wasm(+wasm_exec.js)或本机 Go signer 二进制,实现本文件的 signer 接口。";

/** stub 工厂:签名相关方法一律抛 VENUE_UNKNOWN,绝不返回假签名。 */
function createLighterSigner(/* {apiPrivateKey, chainId} */) {
  const bomb = (what) => async () => { throw _venueUnknown(`Lighter signer 不可用:${what}。${SIGNER_BLOCKER}`); };
  return {
    kind: "stub",
    blocker: SIGNER_BLOCKER,
    mintAuthToken: bomb("mintAuthToken"),
    signTx: bomb("signTx"),
  };
}

const LighterSignerVendor = { createLighterSigner, SIGNER_BLOCKER, SIGNER_KIND: "stub" };

if (typeof globalThis !== "undefined") globalThis.LighterSignerVendor = LighterSignerVendor;
if (typeof module !== "undefined" && module.exports) module.exports = LighterSignerVendor;
