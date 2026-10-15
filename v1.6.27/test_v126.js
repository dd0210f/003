"use strict";
/* v1.2.6 回归(用户要求:会话显示删干净 + 卡死自动恢复):
 * 1. apiFetch 请求超时:hanging 请求约 25 秒强制中止(测试用 timeoutMs 覆盖),code=VAT_TIMEOUT,带诊断信息
 * 2. background 主循环 stale/busy 看门狗:busy 卡死超 60 秒强制重置;运行代次锁,旧轮结果丢弃
 * 3. 防并发/重复下单:代次过期不保存状态;下单超时标记 orderUncertain,下轮先对账再决策
 * 4. 会话/网络/tick 异常不关闭 armed(只有用户手动停止/紧急停止才 armed=false)
 * 5. 用户停止(stopReason=user)不自动恢复;会话原因才可恢复
 * 6. 约每 60 秒真实持仓对账,仅成功时更新本地
 * 7. 手动平仓后对账清除本地显示;对账失败不误删
 * 8. 弹窗无"会话"文案;启动不依赖 10 分钟测试记录 */
const S = require("./strategy.js");
const A = require("./api.js");
const fs = require("fs");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const warnLogs = (st, sub) => (st.logs || []).filter((l) => l.level === "warn" && String(l.msg).includes(sub));

let now = 1_700_000_000_000;
const mockMark = 4115;
function quantizeDown(qtyStr, tickStr) {
  const q = Number(qtyStr), t = Number(tickStr);
  return String(Number((Math.floor(q / t + 1e-9) * t).toFixed(10)));
}
function timeoutErr() { const e = new Error("请求超时(25秒未响应),已主动中止"); e.code = "VAT_TIMEOUT"; return e; }
function baseApi(over = {}) {
  return {
    now: () => now,
    sleep: async () => {},
    underlyingAliases: { XAU: ["XAUS"], XAG: ["XAGS"] },
    getRiskMark: async () => mockMark,
    prepareOrderQty: async (symbol, qty) => ({ qty: quantizeDown(String(qty), "0.00001"), note: "", quote: { quoteId: "q" } }),
    indicativeQuote: async (symbol, qty) => ({
      quoteId: "q-1", mark: mockMark,
      response: { bid: String(mockMark - 0.1), ask: String(mockMark + 0.1), mark_price: String(mockMark),
        qty_limits: { ask: { min_qty_tick: "0.00001", min_qty: "0.00003" }, bid: { min_qty_tick: "0.00001", min_qty: "0.00003" } },
        margin_requirements: {} },
    }),
    marginNeedFromQuote: () => 50,
    placeMarketAuto: async (symbol, side, qty, o) => ({ rfqId: "rfq-1", qty }),
    confirmRfq: async () => ({ ok: true, status: "filled" }),
    getPositions: async () => [],
    positionQtyFor: () => 0,
    ...over,
  };
}
function baseCfg(over = {}) {
  return { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], armed: true, liveEnabled: false, ...over };
}
function seedMomentum(st) {
  const T = now;
  S.vatPushHist(st, "XAU", 4100, T - 360e3);
  S.vatPushHist(st, "XAU", 4100, T - 300e3);
  S.vatPushHist(st, "XAU", 4110, T - 120e3);
  S.vatPushHist(st, "XAU", 4112, T - 60e3);
}
function freshState() {
  const st = S.vatBlankState();
  st.date = S.vatDayNY(now);
  seedMomentum(st);
  return st;
}

(async () => {
  // ===== 1. apiFetch 请求超时 =====
  ok("默认超时 25 秒", A.VAT_REQUEST_TIMEOUT_MS === 25000);
  {
    global.fetch = () => new Promise(() => {}); // 永久 hanging
    const t0 = Date.now();
    let err = null;
    try { await A.apiFetch("/positions", { timeoutMs: 80 }); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    ok("hanging 请求被强制中止", !!err && err.code === "VAT_TIMEOUT");
    ok("超时报错提到超时", !!err && /超时/.test(err.message));
    ok("超时错误带诊断信息", !!err && err.apiRequest && err.apiRequest.path === "/positions");
    ok("超时约按时触发(未永久卡死)", dt < 5000);
  }
  {
    // AbortError(浏览器 abort 后的 reject)同样按超时处理
    global.fetch = async () => { const e = new Error("The operation was aborted."); e.name = "AbortError"; throw e; };
    let err = null;
    try { await A.apiFetch("/positions", { timeoutMs: 5000 }); } catch (e) { err = e; }
    ok("AbortError 映射为 VAT_TIMEOUT", !!err && err.code === "VAT_TIMEOUT");
  }
  {
    // 正常请求不受影响
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) });
    const r = await A.apiFetch("/positions", { timeoutMs: 5000 });
    ok("正常请求正常返回", r && r.hello === 1);
    // HTTP 错误仍保留诊断信息
    global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ detail: [{ msg: "bad" }] }) });
    let err = null;
    try { await A.apiFetch("/orders/new/market", { method: "POST", body: { a: 1 }, timeoutMs: 5000 }); } catch (e) { err = e; }
    ok("HTTP 错误保留状态与请求", !!err && err.httpStatus === 422 && err.apiRequest && err.apiRequest.method === "POST");
  }

  // ===== 2/3. background 主循环看门狗 + 代次锁(源码断言) =====
  {
    const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
    const mf = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
    const mver = bg.match(/VAT_VERSION = "([^"]+)"/);
    ok("版本号与 manifest 一致", !!mver && mver[1] === mf.version);
    ok("stale 阈值 60 秒", bg.includes("STALE_TICK_MS = 60000"));
    // v1.3.0:busy 卡死改走 restartStrategy 全套重启;断言等价保证:stale 分支调 restartStrategy,
    // 且 restartStrategy 内做 runGen++/busy=false(旧轮代次过期、结果丢弃)
    ok("busy 卡死超 60 秒强制重置", bg.includes("主循环卡死超过60秒") &&
      /nowMs - tickStartAt > STALE_TICK_MS[\s\S]{0,200}restartStrategy\(/.test(bg) &&
      /async function restartStrategy[\s\S]{0,300}busy\s*=\s*false/.test(bg));
    ok("运行代次锁", bg.includes("runGen") && bg.includes("const myGen = ++runGen"));
    ok("代次过期丢弃本轮结果", bg.includes("myGen !== runGen") && /myGen !== runGen[\s\S]{0,80}return/.test(bg));
    ok("被接管后 busy 归新轮管理", /finally[\s\S]{0,120}if \(myGen === runGen\) busy = false/.test(bg));
  }

  // ===== 4. 异常不关闭 armed(只有用户停止/紧急停止) =====
  {
    const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
    const lines = bg.split("\n");
    const hits = [];
    // v1.3.0:注释行里提到 armed=false(如铁律说明)不计入,只看真实代码
    lines.forEach((l, i) => { const t = l.trim(); if (/armed\s*[:=]\s*false/.test(l) && !t.startsWith("//") && !t.startsWith("*")) hits.push({ i, l: t }); });
    ok("armed=false 只出现在用户停止/紧急停止",
      hits.length > 0 && hits.every(({ i }) => /VAT_STOP|VAT_PANIC|stopReason/.test(lines.slice(Math.max(0, i - 2), i + 1).join("\n"))));
    ok("探活失败只记 err 继续运行", bg.includes("策略继续运行"));
    ok("tick 异常只记日志不 disarm", !/tick 异常[\s\S]{0,200}armed\s*=\s*false/.test(bg));
  }

  // ===== 5. 用户停止不自动恢复 =====
  {
    ok("用户手动停止不自动恢复", S.vatAutoRecoverDue({ armed: false, stopReason: "user" }, now) === false);
    ok("会话原因停止可恢复", S.vatAutoRecoverDue({ armed: false, stopReason: "session" }, now) === true);
  }

  // ===== 6. 约每 60 秒真实持仓对账(源码断言) =====
  {
    const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
    ok("tick 内约每 60 秒对账", bg.includes("reconCount % 12") && bg.includes("vatReconcilePositions(vatApi(), next)"));
    ok("只在对账成功时处理", bg.includes("rc.ok && rc.cleared.length"));
  }

  // ===== 7/8. 对账:手动平仓后清除;失败不误删 =====
  {
    const st = freshState();
    st.positions.XAU = { asset: "XAU", symbol: "XAU-SWAP", side: "sell", qty: "0.01002", entry: 4186.25, paper: false };
    const rc = await S.vatReconcilePositions(baseApi(), st);
    ok("链上无仓:对账成功", rc.ok === true);
    ok("手动平仓后本地记录被清除", !st.positions.XAU && rc.cleared.includes("XAU"));
  }
  {
    const st = freshState();
    st.positions.XAU = { asset: "XAU", symbol: "XAU-SWAP", side: "sell", qty: "0.01002", entry: 4186.25, paper: false };
    const badApi = baseApi({ getPositions: async () => { throw new Error("net down"); } });
    const rc = await S.vatReconcilePositions(badApi, st);
    ok("对账失败返回 ok=false", rc.ok === false);
    ok("对账失败不误删本地记录", !!st.positions.XAU);
  }

  // ===== 3b. 下单超时 → 标记 → 下轮先对账,不盲目重下 =====
  {
    let orderCalls = 0, reconcileCalls = 0;
    const api = baseApi({
      placeMarketAuto: async () => { orderCalls++; throw timeoutErr(); },
      getPositions: async () => { reconcileCalls++; return []; },
    });
    const st = freshState();
    const cfg = baseCfg({ liveEnabled: true });
    await S.vatProcessAsset(api, st, "XAU", cfg);
    ok("下单超时被标记 orderUncertain", !!(st.orderUncertain && st.orderUncertain.XAU));
    ok("下单超时记 warn", warnLogs(st, "不盲目重下").length >= 1);
    ok("超时未建本地仓位", !st.positions.XAU);
    // 下一轮:先对账,不直接重下
    await S.vatProcessAsset(api, st, "XAU", cfg);
    ok("下轮先对了账", reconcileCalls >= 1);
    ok("对账后标记清除", !(st.orderUncertain && st.orderUncertain.XAU));
    ok("未盲目重下(只下过 1 次)", orderCalls === 1);
  }
  {
    // 对账失败时整轮跳过,标记保留
    let orderCalls = 0;
    const api = baseApi({
      placeMarketAuto: async () => { orderCalls++; throw timeoutErr(); },
      getPositions: async () => { throw new Error("net down"); },
    });
    const st = freshState();
    const cfg = baseCfg({ liveEnabled: true });
    await S.vatProcessAsset(api, st, "XAU", cfg);
    await S.vatProcessAsset(api, st, "XAU", cfg);
    ok("对账失败标记保留", !!(st.orderUncertain && st.orderUncertain.XAU));
    ok("对账失败未重下", orderCalls === 1);
  }
  {
    // 非超时失败(如 422)不标记,行为不变
    const api = baseApi({ placeMarketAuto: async () => { const e = new Error("HTTP 422"); e.httpStatus = 422; throw e; } });
    const st = freshState();
    await S.vatProcessAsset(api, st, "XAU", baseCfg({ liveEnabled: true }));
    ok("422 失败不打超时标记", !(st.orderUncertain && st.orderUncertain.XAU));
  }

  // ===== 9. 弹窗无"会话"文案 =====
  {
    const pj = fs.readFileSync(__dirname + "/popup.js", "utf8");
    const ph = fs.readFileSync(__dirname + "/popup.html", "utf8");
    ok("popup.js 无「会话」二字", !pj.includes("会话"));
    ok("popup.html 无「会话」二字", !ph.includes("会话"));
    ok("显示策略常开", pj.includes("策略常开") && ph.includes("策略常开"));
  }

  // ===== 10. 启动不依赖 10 分钟测试记录 =====
  {
    const pj = fs.readFileSync(__dirname + "/popup.js", "utf8");
    ok("启动无 10 分钟门槛", !pj.includes("请先点「测试连接」") && !/10\s*\*\s*60\s*\*\s*1000/.test(pj));
    const bg = fs.readFileSync(__dirname + "/background.js", "utf8");
    ok("LIVE 启动仍做一次真实活检", /VAT_START[\s\S]{0,800}(checkSession|CheckSession)/.test(bg)); // v1.6.8:venue 感知
  }

  console.log(`\nv1.2.6 回归: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
