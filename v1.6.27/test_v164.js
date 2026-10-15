"use strict";
/* v1.6.4 回归:map 形状目录解析 + 目录模糊匹配兜底 */
const freshApi = () => { delete require.cache[require.resolve("./api.js")]; return require("./api.js"); };
const S = require("./strategy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const mkResp = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
// 实测形状:{"4":...,"FIL":...,"XTZ":...,"BSB":...,"DELL":...} 的 map
const MAP_DIR = {
  "4": { instrument_type: "swap" },
  "FIL": { instrument_type: "perpetual_future" },
  "XTZ": [{ underlying: "XTZ", instrument_type: "swap" }],
  "GOLD": { instrument_type: "swap" },
  "XAUS": { swap: { mark_price: 2650 }, perpetual_future: { mark_price: 2651 } },
  "BRENT": "BRENT",
};

(async () => {
  // 1. map 形状能解析出条目,不再是 0
  {
    const api = freshApi();
    global.fetch = async (url) => url.includes("/metadata/supported_assets")
      ? mkResp(200, MAP_DIR) : mkResp(404, {});
    const arr = await api.supportedAssets();
    ok("map目录解析出条目", arr.length >= 6);
    ok("诊断标注map形状已展开", /map形状已展开/.test(api.directoryDiag()));
  }
  // 2. listUnderlyings 返回真名;rawAssetKeys 兜底
  {
    const api = freshApi();
    global.fetch = async (url) => url.includes("/metadata/supported_assets")
      ? mkResp(200, MAP_DIR) : mkResp(404, {});
    const names = await api.listUnderlyings();
    ok("真名GOLD在目录里", names.includes("GOLD"));
    ok("真名XAUS在目录里", names.includes("XAUS"));
    ok("真名BRENT在目录里", names.includes("BRENT"));
    ok("rawAssetKeys兜底有key", api.rawAssetKeys().includes("FIL"));
  }
  // 3. 嵌套 {swap:{...},perp:{...}} 形状展开
  {
    const api = freshApi();
    const e = api.normalizeEntry({ __dirKey: "XAUS", __dirType: "swap", __dirVal: { mark_price: 2650 } });
    ok("嵌套伪条目规范化", e && e.underlying === "XAUS" && e.instrument_type === "swap");
  }
  // 4. 别名全灭时,目录模糊匹配 GOLD 命中(XAU)
  {
    const api = {
      underlyingAliases: { XAU: ["XAUS", "XAU"] },
      getRiskMark: async (u, kind) =>
        (String(u).toUpperCase() === "GOLD" && kind === "swap" ? 2650.5 : 0),
      listUnderlyings: async () => ["4", "FIL", "XTZ", "GOLD", "DELL"],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    const r = await S.vatResolveUnderlying(api, st, "XAU", cfg);
    ok("模糊匹配命中GOLD", r.underlying === "GOLD" && r.kind === "swap");
    ok("命中记日志", st.logs.some((l) => /目录模糊匹配命中 GOLD/.test(l.msg)));
  }
  // 5. 模糊匹配不瞎猜:目录里没有相关名,照样报错且带目录名
  {
    const api = {
      underlyingAliases: { XAU: ["XAUS", "XAU"] },
      getRiskMark: async () => 0,
      listUnderlyings: async () => ["FIL", "XTZ", "DELL"],
      directoryDiag: () => "HTTP 200; 原始形状 4,FIL,XTZ; 条目 3; map形状已展开",
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    let msg = "";
    try { await S.vatResolveUnderlying(api, st, "XAU", cfg); } catch (e) { msg = e.message; }
    ok("无候选时报错", /未能解析可用 underlying/.test(msg));
    ok("报错带目录标的数量", /目录共 3 个标的/.test(msg));
  }
  // 6. UKOIL 经 BRENT 命中
  {
    const api = {
      underlyingAliases: { UKOIL: ["UKOILP", "UKOIL"] },
      getRiskMark: async (u, kind) =>
        (String(u).toUpperCase() === "BRENT" && kind === "swap" ? 100.2 : 0),
      listUnderlyings: async () => ["BRENT", "FIL"],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    const r = await S.vatResolveUnderlying(api, st, "UKOIL", cfg);
    ok("UKOIL经BRENT命中", r.underlying === "BRENT");
  }
  // 7. Maker 路径同样走模糊匹配
  {
    const api = {
      underlyingAliases: { XAG: ["XAGS", "XAG"] },
      getRiskMark: async (u, kind) =>
        (String(u).toUpperCase() === "SILVER" && kind === "swap" ? 31.2 : 0),
      listUnderlyings: async () => ["SILVER", "FIL"],
      now: () => Date.now(),
    };
    const st = S.vatBlankState();
    const r = await S.vatMakerSymbol(api, st, "XAG");
    ok("Maker模糊匹配命中SILVER", r.underlying === "SILVER" && r.symbol === "SILVER-SWAP");
  }
  // 8. 数组形状回归(老形状不断)
  {
    const api = freshApi();
    global.fetch = async (url) => url.includes("/metadata/supported_assets")
      ? mkResp(200, [{ underlying: "BTC", instrument_type: "perpetual_future" }])
      : mkResp(404, {});
    const names = await api.listUnderlyings();
    ok("数组形状仍可用", names.includes("BTC"));
  }
  console.log(`v1.6.4: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
