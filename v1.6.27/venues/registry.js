"use strict";
/* v1.3.0: 六所注册表。status 决定 UI 与能力:
 *  live        — 适配器已实现,可配置、可切换、可跑
 *  waitlist    — UI 置灰,只注册不写交易代码(Arcus:永续 Beta 仅 waitlist)
 *  unsupported — UI 标注原因,不写交易代码(TxFlow:条款禁止未经许可的自动化交易)
 * authType: browser-session(浏览器登录态) / api-key / agent-wallet / none
 */

/* v1.6.18:顺序=用户指定:Variational、Arcus、QFEX 靠前,其余依次。 */
const VAT_VENUES = [
  { id: "variational", name: "Variational", status: "live", authType: "browser-session",
    notes: "浏览器登录态,走网页端同款接口,无需 API Key,策略引擎已跑通" },
  { id: "arcus", name: "Arcus", status: "live", authType: "api-key",
    notes: "后端生成 Ed25519 API Signing Key(非钱包私钥)+钱包地址+accountIndex 子账户;REST+WS,实现见 venues/arcus.js;需先开通永续权限" },
  { id: "qfex", name: "QFEX", status: "live", authType: "api-key",
    notes: "需在官网 Developer Settings 生成 API Key(2FA,secret 只显示一次);交易走 WS,支持 UAT 测试环境" },
  { id: "lighter", name: "Lighter", status: "live", authType: "api-key",
    notes: "需在官网生成 API Key + ChangePubKey 注册(一次 L1 签名);auth token 每 8h 自动轮换,无需再碰 L1" },
  { id: "entropy", name: "Entropy(Hyperliquid HIP-3)", status: "live", authType: "agent-wallet",
    notes: "Hyperlink HIP-3 deployer(dex:io);主账户签 approveAgent,agent key 只可交易不可提款;仅隔离保证金" },
  { id: "txflow", name: "TxFlow", status: "unsupported", authType: "none",
    notes: "平台条款禁止未经许可的自动化交易,不做交易适配器" },
];

function vatVenueById(id) {
  return (VAT_VENUES || []).find((v) => v.id === id) || null;
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { VAT_VENUES, vatVenueById };
}
