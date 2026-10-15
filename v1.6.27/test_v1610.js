/* v1.6.10 测试:分交易所标的 + WS 修正(getQuote 走 REST 盘口、auth 官方格式)。
 * 运行: node test_v1610.js
 */
"use strict";
const path = require("path");
const assert = require("assert");
const S = require(path.join(__dirname, "strategy.js"));
const { QfexAdapter } = require(path.join(__dirname, "venues/qfex.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra === undefined ? "" : extra); }
}

class DummyWS { constructor() { this.readyState = 3; } close() {} }

(async () => {
  // 1. 迁移:旧 cfg.assets → venueAssets.variational;qfex 给默认
  {
    const cfg = { assets: ["XAU", "BTC"] };
    const changed = S.vatMigrate1610(cfg);
    ok("迁移返回 true", changed === true);
    ok("variational 继承旧 assets", JSON.stringify(cfg.venueAssets.variational) === '["XAU","BTC"]');
    ok("qfex 给默认 8 个", cfg.venueAssets.qfex.length === 8 && cfg.venueAssets.qfex[0] === "GOLD-USD",
      JSON.stringify(cfg.venueAssets.qfex));
    ok("maker qfex 默认", cfg.venueMakerAssets.qfex.includes("GOLD-USD"));
    ok("迁移只跑一次", S.vatMigrate1610(cfg) === false);
  }
  // 2. vatVenueAssets 按所返回
  {
    const cfg = { activeVenue: "qfex", venueAssets: { qfex: ["GOLD-USD"], variational: ["XAU"] } };
    ok("qfex 所返回 qfex 标的", JSON.stringify(S.vatVenueAssets(cfg)) === '["GOLD-USD"]');
    cfg.activeVenue = "variational";
    ok("切回 variational", JSON.stringify(S.vatVenueAssets(cfg)) === '["XAU"]');
    ok("无配置时回退默认表", S.vatVenueAssets({ activeVenue: "qfex" }).includes("CL-USD"));
    ok("maker 按所", S.vatVenueMakerAssets({ activeVenue: "qfex", venueMakerAssets: { qfex: ["CL-USD"] } })[0] === "CL-USD");
  }
  // 3. 默认表内容符合用户要求
  {
    ok("var 有 SWAP 几个", ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI"]
      .every((a) => S.VAT_VENUE_ASSETS.variational.includes(a)));
    ok("var 有 PERP BTC/ETH", S.VAT_VENUE_ASSETS.variational.includes("BTC") && S.VAT_VENUE_ASSETS.variational.includes("ETH"));
    ok("qfex 8 个且无 BTC-USD", S.VAT_VENUE_ASSETS.qfex.length === 8 && !S.VAT_VENUE_ASSETS.qfex.includes("BTC-USD"));
  }

  // 4. auth 用官方格式 params.hmac{public_key,nonce,unix_ts,signature}
  {
    const realFetch = globalThis.fetch;
    let captured = null;
    class CapWS extends DummyWS {
      constructor() { super(); this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(d) { captured = JSON.parse(d); setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ type: "auth_response", request_id: captured.request_id, ok: true }) }), 0); }
    }
    const ad = new QfexAdapter({
      creds: { apiKey: "pk_test", apiSecret: "sk_test" },
      transport: { WebSocket: CapWS }, hmac: async () => "sig",
    });
    await ad.checkSession().catch(() => {});
    await ad.disconnect().catch(() => {});
    globalThis.fetch = realFetch;
    const p = captured && captured.params;
    ok("auth 有 hmac 嵌套", !!(p && p.hmac), JSON.stringify(p));
    ok("public_key 正确", p && p.hmac.public_key === "pk_test");
    ok("nonce/unix_ts/signature 齐全", p && p.hmac.nonce && p.hmac.unix_ts && p.hmac.signature === "sig");
    ok("无旧平铺 api_key", !(p && p.api_key));
  }

  // 5. getQuote 走 REST 盘口,跳过 0 数量档
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert(String(url).includes("/md/orderbook/GOLD-USD"), "应请求 orderbook: " + url);
      return { ok: true, status: 200, json: async () => ({
        ticker_id: "GOLD-USD", timestamp: 1791548157828,
        bids: [["4184.9", "0"], ["4184.5", "0.1031"]],
        asks: [["4186.4", "0.0843"], ["4187.0", "1"]],
      }) };
    };
    const ad = new QfexAdapter({ creds: { apiKey: "k", apiSecret: "s" }, transport: { WebSocket: DummyWS } });
    const q = await ad.getQuote("GOLD-USD");
    globalThis.fetch = realFetch;
    ok("跳过 0 数量买档", q.bid === 4184.5, q.bid);
    ok("卖一", q.ask === 4186.4, q.ask);
    ok("mark=中点", Math.abs(q.mark - 4185.45) < 1e-9, q.mark);
    ok("ts 透传", q.ts === 1791548157828);
  }
  // 6. getQuote 无有效盘口 → VENUE_QUOTE_UNAVAILABLE
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ bids: [], asks: [] }) });
    const ad = new QfexAdapter({ creds: { apiKey: "k", apiSecret: "s" }, transport: { WebSocket: DummyWS } });
    let code = null;
    try { await ad.getQuote("X-USD"); } catch (e) { code = e && e.code; }
    globalThis.fetch = realFetch;
    ok("空盘口抛 VENUE_QUOTE_UNAVAILABLE", code === "VENUE_QUOTE_UNAVAILABLE", code);
  }
  // 7. getMarkets 走 refdata
  {
    const realFetch = globalThis.fetch;
    let refdataHit = false;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/refdata")) {
        refdataHit = true;
        return { ok: true, status: 200, json: async () => ({ type: "refdata", data: [
          { symbol: "GOLD-USD", tick_size: "0.1", lot_size: "0.0001", min_quantity: "0.001", base_asset: "GOLD", quote_asset: "USD" },
        ] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const ad = new QfexAdapter({ creds: { apiKey: "k", apiSecret: "s" }, transport: { WebSocket: DummyWS } });
    const ms = await ad.getMarkets();
    globalThis.fetch = realFetch;
    ok("走 refdata", refdataHit && ms.length === 1 && ms[0].symbol === "GOLD-USD", JSON.stringify(ms));
    ok("带精度", ms[0].lotSize === 0.0001);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH", e); process.exit(1); });
