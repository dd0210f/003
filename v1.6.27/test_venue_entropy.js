"use strict";
/* v1.3.0 Entropy 适配器测试:纯 node + assert,全部 mock fetch,不碰真实网络/私钥。
 * 覆盖:
 *  (1) 两份不同 meta fixture 解析出不同 asset id(断言无硬编码);
 *  (2) 市价单 payload 是 IOC limit 且 price/size 为字符串;
 *  (3) 持仓映射只填 API 实际返回字段;
 *  (4) disconnect 后 asset id 缓存被清;
 *  (5) 错误形状为 VenueError。
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { VenueError } = require("./venues/adapter.js");
const { EntropyAdapter } = require("./venues/entropy.js");

const FAKE_KEY = "0x" + crypto.randomBytes(32).toString("hex"); // 随机假 key,非真实私钥

/* ---------- mock fetch ---------- */
function mockResp(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}
/** routes: (url, body) => mockResp | null(未命中则 404) */
function installMock(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { /* ignore */ }
    calls.push({ url, body });
    const r = routes(url, body, calls);
    return r || mockResp({ error: "no mock route" }, 404);
  };
  return calls;
}

/* ---------- fixtures ---------- */
function perpDexsFixture(ioIndex) {
  const arr = [null];
  for (let i = 1; i < ioIndex; i++) arr.push({ name: "dex" + i, fullName: "D" + i, deployer: "0x" + "11".repeat(20) });
  arr.push({ name: "io", fullName: "Entropy", deployer: "0x" + "22".repeat(20) });
  return arr;
}
const META_A = { universe: [
  { name: "ANTH", szDecimals: 2, maxLeverage: 10, marginTableId: 1 },
  { name: "SNDK", szDecimals: 3, maxLeverage: 5, marginTableId: 1 },
], marginTables: [], collateralToken: 0 };
const META_B = { universe: [
  { name: "SNDK", szDecimals: 3, maxLeverage: 5, marginTableId: 1 },
  { name: "ANTH", szDecimals: 2, maxLeverage: 10, marginTableId: 1 },
], marginTables: [], collateralToken: 0 };

function infoRoutes({ dexs, meta }) {
  return (url, body) => {
    if (url.endsWith("/info") && body) {
      if (body.type === "perpDexs") return mockResp(dexs);
      if (body.type === "meta") return mockResp(meta);
    }
    return null;
  };
}

async function run() {
  /* (1) 两份不同 fixture → 不同 asset id;源码无硬编码 */
  {
    const mk = (ioIndex, meta) => {
      installMock(infoRoutes({ dexs: perpDexsFixture(ioIndex), meta }));
      return new EntropyAdapter("entropy", { creds: { agentKey: FAKE_KEY } });
    };
    const aA = mk(1, META_A);
    const idA = (await aA._assetId("ANTH")).id;
    const aB = mk(2, META_B);
    const idB = await (async () => (await aB._assetId("io:ANTH")).id)();
    assert.strictEqual(idA, 100000 + 1 * 10000 + 0, "fixture A 的 ANTH id 应为 110000");
    assert.strictEqual(idB, 100000 + 2 * 10000 + 1, "fixture B 的 ANTH id 应为 120001");
    assert.notStrictEqual(idA, idB, "不同 dex 布局必须解析出不同 id");
    const src = fs.readFileSync(path.join(__dirname, "venues", "entropy.js"), "utf8");
    assert.ok(!src.includes("110000") && !src.includes("120001"), "源码不得硬编码具体 asset id");
    console.log("ok 1: asset id 实时解析,无硬编码 (110000 vs 120001)");
  }

  /* (2) 市价单 → IOC limit,price/size 为字符串,简写 symbol 自动补 io: 前缀 */
  {
    let exchangeBody = null, l2BookCoin = null;
    const calls = installMock((url, body) => {
      const base = infoRoutes({ dexs: perpDexsFixture(1), meta: META_A })(url, body);
      if (base) return base;
      if (url.endsWith("/info") && body && body.type === "l2Book") {
        l2BookCoin = body.coin;
        return mockResp({ coin: body.coin, time: 1, levels: [[{ px: "10.0", sz: "5", n: 1 }], [{ px: "10.2", sz: "5", n: 1 }]] });
      }
      if (url.endsWith("/info") && body && body.type === "allMids") return mockResp({ ANTH: "10.1" });
      if (url.endsWith("/exchange") && body) {
        exchangeBody = body;
        const oid = 777 + (exchangeBody.action.orders[0].a === 110000 ? 0 : 1);
        return mockResp({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid } }] } } });
      }
      return null;
    });
    const ad = new EntropyAdapter("entropy", { creds: { agentKey: FAKE_KEY } });
    const r = await ad.placeOrder({ symbol: "ANTH", side: "buy", qty: 1.5, type: "market" });
    assert.deepStrictEqual(r, { orderId: 777, status: "pending" });
    assert.strictEqual(l2BookCoin, "io:ANTH", "l2Book coin 须带 io: 前缀");
    const ord = exchangeBody.action.orders[0];
    assert.strictEqual(exchangeBody.action.type, "order");
    assert.strictEqual(ord.t.limit.tif, "Ioc", "无原生市价单,必须用 IOC limit 代替");
    assert.strictEqual(typeof ord.p, "string", "price 必须为字符串");
    assert.strictEqual(typeof ord.s, "string", "size 必须为字符串");
    assert.strictEqual(ord.a, 110000, "asset id 走实时解析");
    assert.strictEqual(ord.b, true);
    assert.strictEqual(ord.r, false);
    assert.ok(exchangeBody.signature && exchangeBody.signature.r.length === 66, "签名三件套齐全");
    assert.ok(!JSON.stringify(exchangeBody).includes(FAKE_KEY.slice(2)), "私钥不得进请求体");
    // 限价单路径
    exchangeBody = null;
    const r2 = await ad.placeOrder({ symbol: "io:SNDK", side: "sell", qty: 2, type: "limit", price: 3.5, reduceOnly: true });
    assert.strictEqual(r2.status, "pending");
    assert.strictEqual(exchangeBody.action.orders[0].t.limit.tif, "Gtc");
    assert.strictEqual(exchangeBody.action.orders[0].r, true, "reduceOnly 透传");
    assert.strictEqual(typeof exchangeBody.action.orders[0].p, "string");
    // cancelOrder 走下单记录的 oid→assetId 映射(不应再调 openOrders)
    let exchangeCancel = null;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.endsWith("/exchange")) {
        exchangeCancel = body;
        return mockResp({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } } );
      }
      throw new Error("cancel 不应再调 openOrders,url=" + url);
    };
    const ok = await ad.cancelOrder(777);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(exchangeCancel.action.cancels, [{ a: 110000, o: 777 }]);
    console.log("ok 2: 市价单=IOC limit,price/size 字符串,签名/撤单链路通");
  }

  /* (3) 持仓映射只填实际返回字段 */
  {
    installMock((url, body) => {
      if (url.endsWith("/info") && body && body.type === "clearinghouseState") {
        return mockResp({
          marginSummary: { accountValue: "1000.5", totalNtlPos: "50", totalRawUsd: "1000", totalMarginUsed: "10" },
          assetPositions: [
            { type: "oneWay", position: { coin: "ANTH", szi: "-2.5", entryPx: "10.0", unrealizedPnl: "-1.25", leverage: { type: "isolated", value: 5, rawUsd: "50" } } },
            { type: "oneWay", position: { coin: "SNDK", szi: "3", leverage: { type: "isolated", value: 3 } } },
            { type: "oneWay", position: { coin: "BTC", szi: "0", entryPx: "1", unrealizedPnl: "0" } },
          ],
        });
      }
      return null;
    });
    const ad = new EntropyAdapter("entropy", { creds: { agentKey: FAKE_KEY, accountAddress: "0x" + "aa".repeat(20) } });
    const poss = await ad.getPositions();
    assert.strictEqual(poss.length, 2, "szi=0 的持仓跳过");
    assert.deepStrictEqual(poss[0], {
      venue: "entropy", symbol: "io:ANTH", side: "short", qty: 2.5, entryPrice: 10, upnl: -1.25,
    });
    assert.strictEqual(poss[1].symbol, "io:SNDK");
    assert.strictEqual(poss[1].side, "long");
    assert.ok(!("entryPrice" in poss[1]) && !("upnl" in poss[1]), "API 没返回的字段不得编造");
    const bal = await ad.getBalance();
    assert.deepStrictEqual(bal, { equity: 1000.5 }, "余额取 marginSummary.accountValue");
    console.log("ok 3: 持仓/余额只填实际返回字段");
  }

  /* (4) disconnect 清掉 asset id 缓存 */
  {
    let infoCalls = 0;
    installMock((url, body) => {
      if (url.endsWith("/info") && (body.type === "perpDexs" || body.type === "meta")) { infoCalls++; }
      const base = infoRoutes({ dexs: perpDexsFixture(1), meta: META_A })(url, body);
      return base;
    });
    const ad = new EntropyAdapter("entropy", { creds: { agentKey: FAKE_KEY } });
    await ad._assetId("ANTH");
    await ad._assetId("SNDK");
    assert.strictEqual(infoCalls, 2, "session 内只解析一次(perpDexs+meta)");
    await ad.disconnect();
    assert.strictEqual(await ad._storeGet("entropy_asset_ids"), null, "disconnect 后缓存清空");
    await ad._assetId("ANTH");
    assert.strictEqual(infoCalls, 4, "清缓存后重新实时解析");
    console.log("ok 4: disconnect 清缓存,下次重连重新解析");
  }

  /* (5) 错误形状为 VenueError */
  {
    installMock(infoRoutes({ dexs: perpDexsFixture(1), meta: META_A }));
    const ad = new EntropyAdapter("entropy", { creds: { agentKey: FAKE_KEY } });
    // 未知市场
    try {
      await ad.placeOrder({ symbol: "NOPE", side: "buy", qty: 1, type: "limit", price: 1 });
      assert.fail("应抛错");
    } catch (e) {
      assert.ok(e instanceof VenueError, "须为 VenueError 实例");
      assert.strictEqual(e.code, "VENUE_REJECTED");
    }
    // 未配 agentKey(构造时没给) → VENUE_AUTH,且不发网络请求
    const ad2 = new EntropyAdapter("entropy", { creds: {} });
    try {
      await ad2.checkSession();
      assert.fail("应抛错");
    } catch (e) {
      assert.ok(e instanceof VenueError && e.code === "VENUE_AUTH", "缺私钥应为 VENUE_AUTH");
    }
    // 服务端 401 → VENUE_AUTH
    installMock((url) => url.endsWith("/info")
      ? mockResp({ error: "unauthorized" }, 401)
      : null);
    const ad3 = new EntropyAdapter("entropy", { creds: { agentKey: FAKE_KEY } });
    try {
      await ad3.checkSession();
      assert.fail("应抛错");
    } catch (e) {
      assert.ok(e instanceof VenueError && e.code === "VENUE_AUTH", "401 应转为 VENUE_AUTH,got " + e.code);
    }
    // 正常 checkSession → true
    installMock((url, body) => url.endsWith("/info") && body.type === "clearinghouseState"
      ? mockResp({ marginSummary: { accountValue: "10" } })
      : null);
    assert.strictEqual(await ad3.checkSession(), true);
    // getLegacyApi → null
    assert.strictEqual(ad.getLegacyApi(), null);
    console.log("ok 5: 错误形状均为 VenueError(code 正确)");
  }

  console.log("\nALL ENTROPY ADAPTER TESTS PASS");
}

run().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
