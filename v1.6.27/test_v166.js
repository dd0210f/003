/* v1.6.6 测试:真实询价验证代号(vatQuoteVerify)。
 * 背景:v1.6.5 实测 BTCS/swap 有 risk mark 但询价 400,插件把坏代号缓存后每轮 400。
 * v1.6.6:解析时用 prepareOrderQty 真实试单,400 就试下一个组合;全失败冷却 5 分钟。 */
"use strict";
const path = require("path");
const S = require(path.join(__dirname, "strategy.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra || ""); }
}
function err400() { const e = new Error("Variational 返回错误 HTTP 400"); e.httpStatus = 400; return e; }
function errTimeout() { const e = new Error("请求超时"); e.code = "VAT_TIMEOUT"; return e; }

// mock api: quotable 集合决定哪些 (symbol) 能过 prepareOrderQty
function mockApi(quotable, marks) {
  return {
    underlyingAliases: {
      BTC: ["BTC", "BTCS"], ETH: ["ETH", "ETHS"],
      US100: ["US100", "US100S"], TWI: ["TWI", "TWIS"],
    },
    getRiskMark: async (u, kind) => (marks[u + "/" + kind] > 0 ? marks[u + "/" + kind] : 0),
    prepareOrderQty: async (symbol, qty, side) => {
      if (quotable.has(symbol)) return { qty, note: "", quote: {} };
      throw err400();
    },
    listUnderlyings: async () => [],
  };
}
const st0 = () => ({ resolved: {}, markets: {}, stats: {}, logs: [] });
const cfg0 = { mode: "profit", equity: 1000, marginPct: 20, targetLev: 10 };

(async () => {
  // 1. verify: quotable → true
  {
    const api = mockApi(new Set(["BTC-PERP"]), { "BTC/swap": 80000, "BTC/perpetual_future": 80000 });
    const r = await S.vatQuoteVerify(api, st0(), "BTC", "BTC", "perpetual_future", 80000, cfg0);
    ok("verify 通过 quotable → true", r === true);
  }
  // 2. verify: 400 → false
  {
    const api = mockApi(new Set([]), {});
    const r = await S.vatQuoteVerify(api, st0(), "BTC", "BTCS", "swap", 80000, cfg0);
    ok("verify 400 → false", r === false);
  }
  // 3. verify: min_qty 报错也算通过(询价本身通了)
  {
    const api = mockApi(new Set([]), {});
    api.prepareOrderQty = async () => { throw new Error("数量 0.001 取整后为 0,低于最小下单量 0.01,请调大金额后再试"); };
    const r = await S.vatQuoteVerify(api, st0(), "XAU", "XAUS", "swap", 4100, cfg0);
    ok("verify min_qty 报错→true(代号是对的)", r === true);
  }
  // 4. verify: 超时错误要抛给上层,不断言为 false
  {
    const api = mockApi(new Set([]), {});
    api.prepareOrderQty = async () => { throw errTimeout(); };
    let threw = false;
    try { await S.vatQuoteVerify(api, st0(), "BTC", "BTC", "swap", 80000, cfg0); }
    catch (e) { threw = e.code === "VAT_TIMEOUT"; }
    ok("verify 超时→抛给上层", threw);
  }
  // 5. resolve: BTCS/swap 有 mark 但 400,自动落到 BTC/perp
  {
    const api = mockApi(new Set(["BTC-PERP"]),
      { "BTCS/swap": 82000, "BTCS/perpetual_future": 0, "BTC/swap": 0, "BTC/perpetual_future": 82000 });
    // 注意别名顺序 BTC 在前;这里故意把 BTCS 放前面测"跳过坏的"
    api.underlyingAliases.BTC = ["BTCS", "BTC"];
    const st = st0();
    const r = await S.vatResolveUnderlying(api, st, "BTC", cfg0);
    ok("resolve 跳过 400 的 BTCS,选中 BTC/perp",
      r.underlying === "BTC" && r.kind === "perpetual_future", JSON.stringify(r));
    ok("resolve 结果已缓存", st.resolved.BTC && st.resolved.BTC.underlying === "BTC");
  }
  // 6. resolve: 全部 400 → 抛错 + 5 分钟冷却(第二次直接抛缓存错,不再打询价)
  {
    let calls = 0;
    const api = mockApi(new Set([]), { "TWIS/swap": 4270, "TWI/swap": 4270 });
    const origPrep = api.prepareOrderQty;
    api.prepareOrderQty = async (...a) => { calls++; return origPrep(...a); };
    const st = st0();
    let e1 = "";
    try { await S.vatResolveUnderlying(api, st, "TWI", cfg0); } catch (e) { e1 = e.message; }
    ok("resolve 全 400 → 抛错", /未能解析/.test(e1), e1.slice(0, 60));
    const c1 = calls;
    let e2 = "";
    try { await S.vatResolveUnderlying(api, st, "TWI", cfg0); } catch (e) { e2 = e.message; }
    ok("resolve 冷却期内不再打询价", calls === c1 && e2 === e1, `calls ${c1}→${calls}`);
  }
  // 7. maker: vatMakerSymbol 同样跳过 400 组合
  {
    const api = mockApi(new Set(["US100-SWAP"]),
      { "US100S/swap": 30900, "US100/swap": 30900 });
    api.underlyingAliases.US100 = ["US100S", "US100"];
    const st = { markets: {}, stats: {}, logs: [] };
    const cfg = { mode: "maker", makerNotionals: { US100: [10, 30] } };
    const r = await S.vatMakerSymbol(api, st, "US100", cfg);
    ok("maker 跳过 400 的 US100S,选中 US100/swap",
      r.underlying === "US100" && r.symbol === "US100-SWAP", JSON.stringify(r));
  }
  // 8. 别名顺序:plain 名优先(研报证据)
  {
    const api = require(path.join(__dirname, "api.js"));
    // api.js 在 node 下走 module.exports,不暴露 UNDERLYING_ALIASES;用 venues 适配器逻辑验证
    // 这里直接读文件断言顺序
    const fs = require("fs");
    const src = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");
    ok("US100 别名首位是 US100",
      /US100:\s*\["US100",\s*"US100S"/.test(src));
    ok("BTC 别名首位是 BTC",
      /BTC:\s*\["BTC",\s*"BTCS"/.test(src));
    ok("USOIL 别名首位是 USOIL",
      /USOIL:\s*\["USOIL",\s*"USOILP"/.test(src));
    ok("XAU 别名首位仍是 XAUS(已实测成交)",
      /XAU:\s*\["XAUS",\s*"XAU"\]/.test(src));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST CRASH", e); process.exit(1); });
