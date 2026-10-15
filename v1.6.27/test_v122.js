"use strict";
/* v1.2.2 回归:探测 fallback mark + 明细 */
const api = require("./api.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  const mkResp = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
  if (url.includes("/metadata/supported_assets")) return mkResp(200, []);
  if (url.includes("/quotes/simple")) return mkResp(400, {}); // US100 的 simple 也挂
  if (url.includes("/quotes/indicative")) {
    const decimals = (String(body.qty).split(".")[1] || "").length;
    if (decimals > 3) return mkResp(400, {});
    return mkResp(200, {
      quote_id: "q1", mark_price: "30299",
      qty_limits: { ask: { min_qty_tick: "0.001" }, bid: { min_qty_tick: "0.001" } },
    });
  }
  return mkResp(404, {});
};

(async () => {
  // 1. simple 挂了 + 有 fallback mark → 照样探测几种精度
  const p1 = await api.probeQuote("US100-SWAP", 30344.05);
  ok("fallback 下有多个结果", p1.results.length >= 3);
  ok("markNote 说明 simple 失败", (p1.markNote || "").includes("simple取价失败"));
  ok("fallback 下仍能学到 tick", (await api.tickCacheGet("US100")) === "0.001");

  // 2. simple 挂了 + 无 fallback → 0/1 错误结果,带原因
  const p2 = await api.probeQuote("US100-SWAP", 0);
  ok("无 fallback 时 0/1", p2.results.length === 1 && !p2.results[0].ok);
  ok("错误带 HTTP 状态", p2.results[0].httpStatus === 400);

  console.log(`v1.2.2: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("EX:", e); process.exit(1); });
