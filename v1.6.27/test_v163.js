"use strict";
/* v1.6.3 回归:目录抓取不缓存空结果 + 抓取诊断 + 通用手动代号 */
const freshApi = () => { delete require.cache[require.resolve("./api.js")]; return require("./api.js"); };
const S = require("./strategy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const mkResp = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

(async () => {
  // 1. 空结果不污染缓存:第一次 [] 第二次有数据
  {
    const api = freshApi();
    let n = 0;
    global.fetch = async (url) => {
      n++;
      if (url.includes("/metadata/supported_assets"))
        return n === 1 ? mkResp(200, []) : mkResp(200, [{ underlying: "XAUS", instrument_type: "swap" }]);
      return mkResp(404, {});
    };
    const r1 = await api.supportedAssets();
    ok("空目录返回[]", Array.isArray(r1) && r1.length === 0);
    ok("空目录诊断记录0条", /条目 0/.test(api.directoryDiag()));
    const r2 = await api.supportedAssets();
    ok("空结果未缓存,第二次重试拿到数据", r2.length === 1);
    ok("拿到数据后诊断更新", /条目 1/.test(api.directoryDiag()));
  }
  // 2. 抓取失败(403)诊断带状态码,不缓存
  {
    const api = freshApi();
    global.fetch = async (url) => {
      if (url.includes("/metadata/supported_assets")) return mkResp(403, { message: "forbidden" });
      return mkResp(404, {});
    };
    const r = await api.supportedAssets();
    ok("403时返回[]", Array.isArray(r) && r.length === 0);
    ok("诊断带HTTP 403", /HTTP 403/.test(api.directoryDiag()));
    let calls = 0;
    global.fetch = async () => { calls++; return mkResp(403, {}); };
    await api.supportedAssets();
    ok("失败不缓存,再次调用会重试", calls === 1);
  }
  // 3. data:[...] 形状也能解析(扩展的形状兼容)
  {
    const api = freshApi();
    global.fetch = async (url) => url.includes("/metadata/supported_assets")
      ? mkResp(200, { data: [{ underlying: "US100S", instrument_type: "swap" }] })
      : mkResp(404, {});
    const names = await api.listUnderlyings();
    ok("data形状解析出US100S", names.includes("US100S"));
  }
  // 4. resolve 失败时错误信息带抓取诊断
  {
    const api = {
      underlyingAliases: { XAU: ["XAUS", "XAU"] },
      getRiskMark: async () => 0,
      listUnderlyings: async () => [],
      directoryDiag: () => "HTTP 403; 原始形状 ?; 条目 0; 抓取失败: x",
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: {} };
    let msg = "";
    try { await S.vatResolveUnderlying(api, st, "XAU", cfg); } catch (e) { msg = e.message; }
    ok("错误信息含抓取诊断", /抓取诊断: HTTP 403/.test(msg));
  }
  // 5. 通用手动代号生效(大小写不敏感)
  {
    const api = {
      underlyingAliases: { XAU: ["XAUS", "XAU"] },
      getRiskMark: async (u) => (String(u).toUpperCase() === "XAUC" ? 2650.5 : 0),
      listUnderlyings: async () => [],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, manualUnderlyings: { XAU: "xauc" } };
    const r = await S.vatResolveUnderlying(api, st, "XAU", cfg);
    ok("手动代号解析成功(大小写不敏感)", r.underlying === "XAUC");
  }
  // 6. 旧 ukoilUnderlying 兼容
  {
    const api = {
      underlyingAliases: { UKOIL: ["UKOILP"] },
      getRiskMark: async (u) => (String(u).toUpperCase() === "BRENTS" ? 101.2 : 0),
      listUnderlyings: async () => [],
    };
    const st = S.vatBlankState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, ukoilUnderlying: "brents", manualUnderlyings: {} };
    const r = await S.vatResolveUnderlying(api, st, "UKOIL", cfg);
    ok("旧ukoilUnderlying兼容", r.underlying === "BRENTS");
  }

  console.log(`\nv1.6.3 测试: 通过 ${pass}, 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
