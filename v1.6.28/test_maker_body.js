"use strict";
/* 抓包断言:限价单请求体必须符合服务端真实反序列化规则。
 * 2026-09-30 用户实测:服务端返回
 *   unknown variant `LIMIT`, expected one of `limit`, `stop_limit`, `take_profit`, `stop_loss`
 * 本测试用 mock fetch 模拟该行为:大写 LIMIT 直接回 400,断言当前代码能一次通过。 */
const api = require("./api.js");
const assert = (c, m) => { if (!c) { console.error("断言失败:", m); process.exit(1); } };

const captured = [];
global.fetch = async (url, init = {}) => {
  const path = String(url).replace("https://omni.variational.io/api", "");
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (obj, ok = true, status = 200) => ({ ok, status, json: async () => obj });
  if (path.startsWith("/metadata/supported_assets")) return json([]); // 目录挂了,走本地构造
  if (path.startsWith("/metadata/v2/risk_limits")) return json({});
  if (path === "/quotes/indicative") return json({
    quote_id: "q-test", mark_price: "4145.0",
    qty_limits: { ask: { min_qty_tick: "0.00001", min_qty: "0.00003" },
                  bid: { min_qty_tick: "0.00001", min_qty: "0.00003" } },
  });
  if (path === "/orders/new/limit") {
    // ---- 服务端真实行为(照抄用户实测的报错原文逻辑) ----
    const allowed = ["limit", "stop_limit", "take_profit", "stop_loss"];
    if (!body || !allowed.includes(body.order_type)) {
      return json({ error_message:
        `Failed to deserialize the JSON body into the target type: unknown variant ` +
        `\`${body && body.order_type}\`, expected one of \`limit\`, \`stop_limit\`, ` +
        `\`take_profit\`, \`stop_loss\` at line 1 column 299` }, false, 400);
    }
    captured.push(body);
    return json({ rfq_id: "rfq-test-1" });
  }
  throw new Error("未 stub 的路径: " + path);
};

(async () => {
  const r = await api.placeMakerOrder("XAU", "buy", "0.00012", "4144.5", { dryRun: false });
  assert(r.orderId === "rfq-test-1", "应返回服务端订单 id,实际:" + JSON.stringify(r));
  assert(captured.length === 1, "应恰好发送一次限价单");
  const b = captured[0];
  assert(b.order_type === "limit", "order_type 必须小写 limit,实际:" + b.order_type);
  assert(b.side === "buy", "side 必须小写 buy/sell,实际:" + b.side);
  assert(b.tif === "GOOD_TIL_CANCELED", "tif 枚举,实际:" + b.tif);
  assert(typeof b.limit_price === "string" && typeof b.qty === "string",
    "价格/数量应为十进制字符串");
  assert(b.qty === "0.00012", "数量应按 tick 取整,实际:" + b.qty);
  assert(b.is_reduce_only === false, "is_reduce_only 应为布尔");
  assert(b.instrument && b.instrument.underlying === "XAUS",
    "instrument 应为本地构造的 XAUS,实际:" + JSON.stringify(b.instrument));

  // placeLimit 同样路径
  captured.length = 0;
  await api.placeLimit("XAU", "sell", "0.00012", "4145.5", { dryRun: false });
  assert(captured[0].order_type === "limit", "placeLimit 的 order_type 也必须小写");
  assert(captured[0].side === "sell", "placeLimit side 小写");

  console.log("抓包断言通过: order_type=limit, side 小写, tif=" + b.tif + ", instrument=XAUS");
})().catch((e) => { console.error("断言失败:", e.message); process.exit(1); });
