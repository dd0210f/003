"use strict";
/* v1.3.0 Phase G+H 回归:vdPositionsDiff 5 种变化判定 + pnl 1U 阈值边界 + 心跳 body 含 positions 且绝不含凭证 */
const assert = require("assert");
const { vdPositionsDiff, wdBuildBody } = require("./watchdog.js");

let pass = 0;
const ok = (name, cond) => {
  assert(cond, "FAIL: " + name);
  pass++;
  console.log("PASS:", name);
};

/* ---------- vdPositionsDiff:5 种变化判定 ---------- */
{
  const p = (venue, symbol, side, qty, upnl) => ({ venue, symbol, side, qty, upnl });

  // 1. open:新 key(venue|symbol)
  let ev = vdPositionsDiff([], [p("lighter", "BTC", "long", 0.1, 5)]);
  ok("open:新key判为open", ev.length === 1 && ev[0].type === "open" &&
    ev[0].venue === "lighter" && ev[0].symbol === "BTC" && typeof ev[0].detail === "string");

  // 2. close:key 消失
  ev = vdPositionsDiff([p("variational", "XAU", "long", 1, 3)], []);
  ok("close:key消失判为close", ev.length === 1 && ev[0].type === "close" &&
    ev[0].venue === "variational" && ev[0].symbol === "XAU");

  // 3. qty:数量变化(方向/盈亏不变时只出 qty 事件)
  ev = vdPositionsDiff(
    [p("lighter", "BTC", "long", 0.1, 5)],
    [p("lighter", "BTC", "long", 0.2, 5)]);
  ok("qty:数量变化判为qty", ev.length === 1 && ev[0].type === "qty");

  // 4. side:方向变化
  ev = vdPositionsDiff(
    [p("lighter", "BTC", "long", 0.1, 5)],
    [p("lighter", "BTC", "short", 0.1, 5)]);
  ok("side:方向变化判为side", ev.length === 1 && ev[0].type === "side");

  // 5. pnl:|Δupnl|≥1U
  ev = vdPositionsDiff(
    [p("lighter", "BTC", "long", 0.1, 10)],
    [p("lighter", "BTC", "long", 0.1, 11.5)]);
  ok("pnl:Δ≥1U判为pnl", ev.length === 1 && ev[0].type === "pnl");

  // 同 venue 不同 symbol 不算变化
  ev = vdPositionsDiff(
    [p("lighter", "BTC", "long", 0.1, 5)],
    [p("lighter", "ETH", "long", 0.1, 5)]);
  ok("不同symbol:BTC判close+ETH判open", ev.length === 2 &&
    ev.some((e) => e.type === "close" && e.symbol === "BTC") &&
    ev.some((e) => e.type === "open" && e.symbol === "ETH"));

  // 同 symbol 不同 venue 是两个 key
  ev = vdPositionsDiff(
    [p("lighter", "BTC", "long", 0.1, 5)],
    [p("lighter", "BTC", "long", 0.1, 5), p("qfex", "BTC", "short", 1, 0)]);
  ok("不同venue同symbol:只判qfex open", ev.length === 1 && ev[0].type === "open" && ev[0].venue === "qfex");

  // 无变化 → 空数组
  ev = vdPositionsDiff(
    [p("lighter", "BTC", "long", 0.1, 5)],
    [p("lighter", "BTC", "long", 0.1, 5)]);
  ok("无变化:空数组", Array.isArray(ev) && ev.length === 0);

  // 空输入 → 空数组
  ok("空输入:空数组", vdPositionsDiff([], []).length === 0 && vdPositionsDiff().length === 0);
}

/* ---------- pnl 1U 阈值边界 ---------- */
{
  const p = (upnl) => ({ venue: "lighter", symbol: "BTC", side: "long", qty: 0.1, upnl });
  const pnlOnly = (o, n) => vdPositionsDiff([p(o)], [p(n)]).filter((e) => e.type === "pnl");

  ok("Δ=1.0恰好触发", pnlOnly(10, 11).length === 1);
  ok("Δ=0.99不触发", pnlOnly(10, 10.99).length === 0);
  ok("负向Δ=-1.2触发", pnlOnly(10, 8.8).length === 1);
  ok("Δ=0不触发", pnlOnly(10, 10).length === 0);
  ok("旧缺upnl不判pnl", pnlOnly(undefined, 5).length === 0);
  ok("新缺upnl不判pnl", pnlOnly(5, undefined).length === 0);
  ok("entryPrice不影响pnl判定", pnlOnly(10, 10.5).length === 0);

  // 复合:方向+数量+盈亏同时变 → 3 个事件
  const ev = vdPositionsDiff(
    [{ venue: "lighter", symbol: "BTC", side: "long", qty: 0.1, upnl: 10 }],
    [{ venue: "lighter", symbol: "BTC", side: "short", qty: 0.2, upnl: 12 }]);
  ok("复合变化:side+qty+pnl各一个事件",
    ev.filter((e) => e.type === "side").length === 1 &&
    ev.filter((e) => e.type === "qty").length === 1 &&
    ev.filter((e) => e.type === "pnl").length === 1);
}

/* ---------- 心跳 body:含 positions 数组、绝不含凭证 ---------- */
{
  const cfg = {
    label: "001", mode: "volume", liveEnabled: true, armed: true, wdEnabled: true,
    venueCreds: { lighter: { apiKey: "SECRET_API_KEY_123", privateKey: "SECRET_PRIV_456" } },
  };
  const positions = [
    { venue: "lighter", symbol: "BTC", side: "long", qty: 0.1, entryPrice: 90000, upnl: 12.5 },
    { venue: "variational", symbol: "XAU", side: "short", qty: 2 },
  ];
  const b = wdBuildBody("hb", cfg, "1.2.7", "心跳", positions);
  ok("body含positions数组(原样)", Array.isArray(b.positions) && b.positions.length === 2 &&
    b.positions[0].venue === "lighter" && b.positions[0].upnl === 12.5);
  ok("body保留原有字段", b.kind === "hb" && b.v === "1.2.7" && b.label === "001" &&
    b.live === true && b.armed === true && typeof b.t === "number" && b.text === "心跳");
  const s = JSON.stringify(b);
  ok("body绝不含凭证", !s.includes("SECRET_API_KEY_123") && !s.includes("SECRET_PRIV_456") &&
    !s.includes("venueCreds") && !s.includes("privateKey"));

  // positions 缺省 → 空数组(诚实)
  const b2 = wdBuildBody("hb", cfg, "1.2.7", "心跳");
  ok("positions缺省为空数组", Array.isArray(b2.positions) && b2.positions.length === 0);
  const b3 = wdBuildBody("alert", cfg, "1.2.7", "报警", null);
  ok("positions=null→空数组", Array.isArray(b3.positions) && b3.positions.length === 0);
}

console.log(`\n全部通过: ${pass} 项`);
