"use strict";
/* v1.6.2 回归测试:下单硬失败熔断(3连拒停手+30分钟冷却+手动重启解除)+双栏统计(今日总计/当前模式) */
const S = require("./strategy.js");
const assert = (c, m) => { if (!c) { console.error("断言失败:", m); process.exit(1);}};

let mNow = 1_760_000_000_000;
let failMode = "ok"; // ok | throw422 | reject
const mcalls = { placeMarketAuto: 0, confirmRfq: 0};

const mapi = {
now: () => mNow,
sleep: async () => {},
getPositions: async () => [{ position_info: { qty: "3.044"}, instrument: { underlying: "UKOIL"}}],
positionQtyFor: () => 3.044,
indicativeQuote: async () => ({
quoteId: "q1", mark: 99.83,
response: { bid: "99.82", ask: "99.84", qty_limits: { ask: { min_qty_tick: "0.001"}, bid: { min_qty_tick: "0.001"}}},
}),
placeMarketAuto: async (symbol, side, qty, opts) => {
mcalls.placeMarketAuto++;
if (failMode === "throw422") { const e = new Error("Variational 返回错误 HTTP 422"); throw e;}
return { rfqId: "rfq-" + mcalls.placeMarketAuto, qty};
},
confirmRfq: async () => {
mcalls.confirmRfq++;
if (failMode === "reject") return { ok: false, status: "rejected_by_venue"};
return { ok: true, status: "filled"};
},
};
const mCfg = (over = {}) => ({...S.VAT_DEFAULT_CONFIG, mode: "maker", makerAssets: ["UKOIL"], armed: true, liveEnabled: true,...over});
const newSt = () => { const s = S.vatBlankState(); s.date = S.vatDayNY(mNow); return s;};
const mkPos = () => ({
asset: "UKOIL", side: "sell", qty: "3.044", entry: 100.198, tp: 90, sl: 105,
opened: mNow - 60e3, notional: 304, paper: false, maker: true, symbol: "UKOIL-SWAP",
});

(async () => {
// 1) 平仓 422 三连 → 第4次返回 blocked，且不再调下单接口
{
const st = newSt();
const cfg = mCfg();
failMode = "throw422";
for (let i = 0; i < 2; i++) {
const r = await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83).catch((e) => "thrown:" + e.message);
assert(r === "thrown:Variational 返回错误 HTTP 422", `前2次应抛错,实际:${r}`);
}
const r3 = await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83).catch((e) => "thrown:" + e.message);
assert(r3 === "blocked", "第3次应触发停手返回 blocked,实际:" + r3);
const n0 = mcalls.placeMarketAuto;
const r4 = await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83);
assert(r4 === "blocked", "第4次应返回 blocked,实际:" + r4);
assert(mcalls.placeMarketAuto === n0, "停手后不应再调下单接口");
assert(st.logs.some((x) => /需手动处理/.test(x.msg)), "应记告警");
console.log("1. 平仓422三连停手 ✅");
}
// 2) 30分钟冷却后允许再试一次
{
const st = newSt();
const cfg = mCfg();
failMode = "throw422";
for (let i = 0; i < 3; i++) await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83).catch(() => {});
assert(S.vatOrderFailBlocked(st, "UKOIL", "close", mNow) === true, "冷却中应被拦");
mNow += 31 * 60 * 1000;
assert(S.vatOrderFailBlocked(st, "UKOIL", "close", mNow) === false, "31分钟后应放行重试");
console.log("2. 30分钟冷却后放行 ✅");
}
// 3) 手动重启立即解除
{
const st = newSt();
failMode = "throw422";
for (let i = 0; i < 3; i++) await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), mCfg(), "TIMEOUT", 99.83).catch(() => {});
assert(S.vatOrderFailBlocked(st, "UKOIL", "close", mNow) === true, "应被拦");
S.vatManualRestartReset(st);
assert(S.vatOrderFailBlocked(st, "UKOIL", "close", mNow) === false, "手动重启后应解除");
console.log("3. 手动重启解除熔断 ✅");
}
// 4) 成功平仓清零计数
{
const st = newSt();
const cfg = mCfg();
failMode = "throw422";
await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83).catch(() => {});
assert((S.vatOrderFailGet(st, "UKOIL", "close") || {}).n === 1, "应计1次");
failMode = "ok";
st.positions.UKOIL = mkPos();
const r = await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83);
assert(r === true, "应平仓成功,实际:" + r);
assert(S.vatOrderFailGet(st, "UKOIL", "close") === null, "成功后应清零");
console.log("4. 成功平仓清零 ✅");
}
// 5) confirmRfq 被拒也计入熔断
{
const st = newSt();
failMode = "reject";
for (let i = 0; i < 3; i++) await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), mCfg(), "TIMEOUT", 99.83);
assert(S.vatOrderFailBlocked(st, "UKOIL", "close", mNow) === true, "被拒3次应停手");
failMode = "ok";
console.log("5. 被拒计入熔断 ✅");
}
// 6) 双栏统计:平仓双记账 + 切换模式重置
{
const st = newSt();
const cfg = mCfg();
failMode = "ok";
st.positions.UKOIL = mkPos();
await S.vatClosePosition(mapi, st, "UKOIL", mkPos(), cfg, "TIMEOUT", 99.83);
assert(st.stats.trades === 1, "今日总计应记1笔");
const ms = S.vatModeStats(st, cfg, mNow);
assert(ms.trades === 1 && ms.mode === "maker", "当前模式应记1笔");
assert(Math.abs(ms.pnl - st.stats.pnl) < 1e-9, "双栏 PnL 应一致");
// 切换模式
const cfg2 = mCfg({ mode: "profit"});
const ms2 = S.vatModeStats(st, cfg2, mNow + 1000);
assert(ms2.mode === "profit" && ms2.trades === 0 && ms2.since === mNow + 1000, "切换模式应重置");
assert(st.stats.trades === 1, "今日总计不受影响");
console.log("6. 双栏统计 ✅");
}
// 7) 开仓硬失败三连 → open 被拦
{
const st = newSt();
const cfg = mCfg();
failMode = "throw422";
for (let i = 0; i < 3; i++) S.vatOrderFailTrack(st, "UKOIL", "open", "HTTP 422", mNow);
assert(S.vatOrderFailBlocked(st, "UKOIL", "open", mNow) === true, "开仓应被拦");
assert(S.vatOrderFailBlocked(st, "UKOIL", "close", mNow) === false, "平仓不应受影响(分开计数)");
failMode = "ok";
console.log("7. 开/平分开计数 ✅");
}
console.log("\nv1.6.2 全部 7 项通过 ✅");
})().catch((e) => { console.error("测试异常:", e); process.exit(1);});
