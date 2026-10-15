"use strict";
/* v1.6.5 回归:目录 instrument 必须带 underlying(之前 u= 空全 400);symbol 用解析出的真名;模糊匹配按特异度排序 */
const freshApi = () => { delete require.cache[require.resolve("./api.js")]; return require("./api.js"); };
const S = require("./strategy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const mkResp = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
// 目录值对象不带 underlying(实测形状):{"XAUS": {"instrument_type": "swap"}}
const MAP_NO_U = { "XAUS": { instrument_type: "swap" }, "GOLD": { instrument_type: "swap" } };

(async () => {
  // 1. 核心 bug:目录命中的 instrument 必须有 underlying,否则询价 u= 空全 400
  {
    const api = freshApi();
    global.fetch = async (url) => url.includes("/metadata/supported_assets")
      ? mkResp(200, MAP_NO_U) : mkResp(404, {});
    const inst = await api.resolveInstrument("XAU-SWAP");
    ok("目录命中 instrument 有 underlying", inst && inst.underlying === "XAUS");
    ok("目录值优先( instrument_type 保留)", inst && inst.instrument_type === "swap");
    ok("缺字段用本地默认补(settlement_asset)", inst && inst.settlement_asset === "USDC");
  }
  // 2. normalizeEntry 伪条目直接补 underlying
  {
    const api = freshApi();
    const e = api.normalizeEntry({ __dirKey: "UKOILP", __dirVal: { instrument_type: "swap" } });
    ok("伪条目 instrument 有 underlying", e && e.instrument && e.instrument.underlying === "UKOILP");
  }
  // 3. 模糊匹配按特异度排序:/US100/ 先扫完全部,再扫 /NAS/
  {
    const order = [];
    const api = {
      underlyingAliases: { US100: ["US100S", "US100"] },
      getRiskMark: async (u, kind) => { order.push(u); return 0; }, // 全部 0,只看尝试顺序
      prepareOrderQty: async (sym, q) => ({ qty: q, note: "", quote: {} }),
      listUnderlyings: async () => ["NASX", "US100A"],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    try { await S.vatResolveUnderlying(api, st, "US100", cfg); } catch (e) { /* 预期报错 */ }
    const iUS100A = order.indexOf("US100A"), iNASX = order.indexOf("NASX");
    ok("特异 pattern 先尝试", iUS100A >= 0 && iNASX >= 0 && iUS100A < iNASX);
  }
  // 4. 模糊匹配命中时日志提示非别名表(让用户核对)
  {
    const api = {
      underlyingAliases: { US500: ["US500S"] },
      getRiskMark: async (u) => (String(u).toUpperCase() === "SPX" ? 6700.5 : 0),
      prepareOrderQty: async (sym, q) => ({ qty: q, note: "", quote: {} }),
      listUnderlyings: async () => ["SPX", "NOPEX"],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    const r = await S.vatResolveUnderlying(api, st, "US500", cfg);
    ok("模糊匹配仍能命中", r.underlying === "SPX");
    ok("日志提示请核对", st.logs.some((l) => /请核对/.test(l.msg)));
  }
  // 5. 别名直命中不受影响(XAU→XAUS)
  {
    const api = {
      underlyingAliases: { XAU: ["XAUS", "XAU"] },
      getRiskMark: async (u, kind) => (String(u).toUpperCase() === "XAUS" && kind === "swap" ? 4137.02 : 0),
      prepareOrderQty: async (sym, q) => ({ qty: q, note: "", quote: {} }),
      listUnderlyings: async () => ["XAUS", "GOLD"],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    const r = await S.vatResolveUnderlying(api, st, "XAU", cfg);
    ok("别名直命中优先", r.underlying === "XAUS" && r.kind === "swap");
  }
  // 6. 目录 miss 时本地构造兜底仍有 underlying(回到 v1.2.1 行为)
  {
    const api = freshApi();
    global.fetch = async (url) => url.includes("/metadata/supported_assets")
      ? mkResp(200, { "ZZZ": { instrument_type: "swap" } }) : mkResp(404, {});
    const inst = await api.resolveInstrument("BTC-PERP");
    ok("兜底 instrument 有 underlying(别名第一顺位 v1.6.6:BTC)", inst && inst.underlying === "BTC");
  }
  console.log(`v1.6.5: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
