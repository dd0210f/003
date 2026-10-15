"use strict";
/* v1.2.3 回归:连续询价失败时自动探测、每小时最多一次、全失败记 err 触发看门狗 */
let probeCalls = 0;
let probeMode = "mixed"; // mixed: 部分通过 | allfail: 全失败
global.probeQuote = async (symbol, mark) => {
  probeCalls++;
  if (probeMode === "allfail") {
    return {
      symbol, mark, markNote: "simple取价失败: HTTP 400",
      results: [
        { qty: "0.0016", ok: false, httpStatus: 400, error: "Variational 返回错误 HTTP 400" },
        { qty: "0.001", ok: false, httpStatus: 400, error: "Variational 返回错误 HTTP 400" },
      ],
    };
  }
  return {
    symbol, mark, markNote: "",
    results: [
      { qty: "0.00165", ok: false, httpStatus: 400, error: "Variational 返回错误 HTTP 400" },
      { qty: "0.001", ok: true, httpStatus: 200, tick: "0.001" },
    ],
  };
};

const S = require("./strategy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

let now = 1_700_000_000_000;
const api = {
  now: () => now,
  sleep: async () => {},
  underlyingAliases: { US100: ["US100S"] },
  getRiskMark: async (u) => (u === "US100S" ? 30344 : 0),
  prepareOrderQty: async () => { const e = new Error("Variational 返回错误 HTTP 400"); e.httpStatus = 400; e.apiRequest = { path: "/quotes/indicative", body: { qty: "0.00164", instrument: { underlying: "US100S" } } }; throw e; },
  indicativeQuote: async () => { throw new Error("not used"); },
  marginNeedFromQuote: () => 50,
};
const cfg = { ...S.VAT_DEFAULT_CONFIG, assets: ["US100"], mode: "volume", armed: true, liveEnabled: false };
function seed(st) {
  const T = now;
  S.vatPushHist(st, "US100", 30340, T - 360e3);
  S.vatPushHist(st, "US100", 30340, T - 300e3);
  S.vatPushHist(st, "US100", 30342, T - 120e3);
  S.vatPushHist(st, "US100", 30343, T - 60e3);
}
const hasLog = (st, sub, level) => (st.logs || []).some((l) => String(l.msg).includes(sub) && (!level || l.level === level));

(async () => {
  const st = S.vatBlankState();
  seed(st);

  // 3 次失败 → 触发退避 + 自动探测(mixed:部分通过)
  for (let i = 0; i < 3; i++) { now += 1000; await S.vatProcessAsset(api, st, "US100", cfg); }
  ok("3连败触发自动探测", probeCalls === 1);
  ok("探测成功记 ok 日志", hasLog(st, "自动探测: 1/2通过", "ok"));
  ok("记住精度", hasLog(st, "精度 0.001 已记住"));
  ok("autoProbe 打点", st.autoProbe && st.autoProbe.US100 > 0);

  // 退避期后(70s)再 3 连败 → 1小时内不重复探测
  now += 70e3;
  for (let i = 0; i < 3; i++) { now += 1000; await S.vatProcessAsset(api, st, "US100", cfg); }
  ok("1小时内不重复探测", probeCalls === 1);

  // 1小时后 → 再次探测
  now += 3601e3;
  seed(st);
  for (let i = 0; i < 3; i++) { now += 1000; await S.vatProcessAsset(api, st, "US100", cfg); }
  ok("1小时后可再次探测", probeCalls === 2);

  // 全失败 → err 日志(看门狗会自动上报)
  probeMode = "allfail";
  now += 3601e3;
  seed(st);
  for (let i = 0; i < 3; i++) { now += 1000; await S.vatProcessAsset(api, st, "US100", cfg); }
  ok("全失败触发第三次探测", probeCalls === 3);
  ok("全失败记 err 日志", hasLog(st, "自动探测: 2种精度全部失败", "err"));

  console.log(`v1.2.3: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("EX:", e); process.exit(1); });
