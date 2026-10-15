"use strict";
/* Variational Auto Trader - 后台 service worker
 * importScripts 顺序:api.js(直连执行层) → entropy.js(排列熵) → strategy.js(策略引擎) →
 * watchdog.js(看门狗) → venues/*(多所适配器,api.js 必须在 venues/variational.js 之前)
 */
importScripts("api.js", "entropy.js", "strategy.js", "strategy_hedge.js", "strategy_fund.js", "watchdog.js",
  "venues/adapter.js", "venues/registry.js",
  "venues/vendor/hyperliquid.bundle.js", "venues/vendor/lighter-signer.bundle.js",
  "venues/variational.js", "venues/qfex.js", "venues/entropy.js", "venues/lighter.js",
  "venues/arcus.js",
  "venues/index.js");

const VAT_VERSION = "1.6.27";
/* v1.6.9:QFEX 余额缓存(60s) */
let __vatBalCache = null;

/* v1.6.8:venue 感知的会话检查。variational→浏览器会话;其他 venue→适配器 checkSession。
 * 401/凭证错误的提示文案也按 venue 区分,不再对 qfex 说"去网页端重新登录"。 */
function vatVenueId() {
  try {
    const ad = (typeof vatActiveAdapter === "function") ? vatActiveAdapter() : null;
    return (ad && ad.id) || "variational";
  } catch (_) { return "variational"; }
}
function vatVenueAuthHint(e) {
  const venue = vatVenueId();
  const m = String((e && e.message) || e).slice(0, 160);
  // v1.6.13:区分"建连失败"(网络/VPN 拦 wss)和"认证失败"(Key 真有问题),别误导用户去换 Key
  const isNet = /WS 连接失败|VENUE_NETWORK|超时|timeout|ECONN|ENOTFOUND/i.test(m + " " + String((e && e.code) || ""));
  if (venue === "qfex") {
    if (isNet) return `QFEX 下单通道(WS)连不上(${m}):Key 是好的(余额能读到)。点「QFEX 探测」一次看定位结论(出口IP/UAT对照/4选1解法);优先把 VPN 切到东京/新加坡节点`;
    return `QFEX 凭证无效(${m}):请检查插件本机存储的 API Key(官网 Developer Settings 生成,需 2FA)`;
  }
  return `Variational 登录无效(${m}):请先在网页端登录`;
}
async function vatVenueCheckSession() {
  const venue = vatVenueId();
  const ad = (typeof vatActiveAdapter === "function") ? vatActiveAdapter() : null;
  if (venue !== "variational" && ad && typeof ad.checkSession === "function") {
    try { await ad.checkSession(); }
    catch (e) { throw new Error(vatVenueAuthHint(e)); }
    return;
  }
  await checkSession();
}
const TICK_MS = 5000;
let busy = false;
let timer = null;
let probeCount = 0;
/* v1.2.6 主循环健康:busy 卡死超过 60 秒 → 强制接管继续跑。
 * 运行代次锁:旧轮被接管后醒来,因代次过期丢弃结果,不覆盖新轮状态、不重复下单。 */
let tickStartAt = 0;
let runGen = 0;
const STALE_TICK_MS = 60000;
let reconCount = 0; // 约每 12 轮(60 秒)做一次真实持仓对账
let tickErrStreak = 0;
let candleSaveTick = 0; // v1.6.19:1m K线持久化计数
let candleLoaded = false; // v1.6.19:启动时只读回一次 K线   // v1.3.0:连续 tick 异常计数,≥3 触发重启,成功一轮清零
let venueHealthStreak = 0; // v1.3.0:venue 健康检查连续失败计数,≥3 触发重启

const store = {
  async load() {
    const r = await chrome.storage.local.get(["VAT_CONFIG", "VAT_STATE", "VAT_SESSION_OK_AT", "VAT_CANDLES1M"]);
    // v1.6.19:读回 1m K线(供 Variational Hedge 合成 5m 信号);只在启动时做一次,之后内存累积
    if (!candleLoaded) { candleLoaded = true;
    try {
      const c1m = r.VAT_CANDLES1M || {};
      const g = (typeof globalThis !== "undefined") ? globalThis : {};
      g.VAT_C1M = {};
      for (const k of Object.keys(c1m)) {
        const arr = Array.isArray(c1m[k]) ? c1m[k].filter((b) => b && Number(b.t) > Date.now() - 340 * 60000) : [];
        if (arr.length) g.VAT_C1M[String(k).toUpperCase()] = arr.slice(-320);
      }
    } catch (_) {} }
    const config = { ...VAT_DEFAULT_CONFIG, ...(r.VAT_CONFIG || {}) };
    if (vatMigrate167(config)) { try { await chrome.storage.local.set({ VAT_CONFIG: config }); } catch (_) {} }
    if (vatMigrate1610(config)) { try { await chrome.storage.local.set({ VAT_CONFIG: config }); } catch (_) {} } // v1.6.10:分交易所标的
    return {
      config,
      state: r.VAT_STATE || (() => { const s = vatBlankState(); s.date = ""; return s; })(),
      sessionOkAt: Number(r.VAT_SESSION_OK_AT || 0),
    };
  },
  async saveConfig(c) { await chrome.storage.local.set({ VAT_CONFIG: c }); },
  async saveState(s) { await chrome.storage.local.set({ VAT_STATE: s }); },
  async saveSessionOk(t) { await chrome.storage.local.set({ VAT_SESSION_OK_AT: t }); },
};

/* v1.3.0:chrome.storage.local 的 {get,set} 包装,供 venue 适配器做 token 缓存 */
function vatChromeStore() {
  return {
    get: async (k) => {
      try { const r = await chrome.storage.local.get([k]); return r[k]; } catch (_) { return undefined; }
    },
    set: async (k, v) => {
      try { await chrome.storage.local.set({ [k]: v }); } catch (_) {}
    },
  };
}

/* v1.3.0:按 config.activeVenue(缺省 variational)建 venue 适配器。
 * 失败或返回 null 时不抛——vatApi() 会回退全局函数(api.js),策略继续跑。
 * over 可覆盖 {venue, creds}(VAT_START 里用合并后的新配置,先于落盘)。 */
async function vatEnsureAdapter(over) {
  let venue = "variational";
  let creds = null;
  try {
    const { config } = await store.load();
    venue = config.activeVenue || "variational";
    creds = ((config.venueCreds || {})[venue]) || null;
  } catch (_) { /* 用缺省 */ }
  if (over && over.venue) {
    venue = over.venue;
    creds = (over.creds !== undefined) ? over.creds : null;
  }
  try {
    const ad = createVenueAdapter(venue, { creds, storage: vatChromeStore() });
    vatSetVenueAdapter(ad || null);
    // v1.6.8:按 venue 装配策略引擎的 legacy 接口。非 variational 时用适配器方法,
    // 禁止悄悄回退到 Variational 全局函数(之前 qfex 下行情/下单实际走的 variational)。
    try { vatWireVenueApi(venue, ad); } catch (e) { /* 接线失败也不抛,下轮 tick 会暴露 */ }
    return !!ad;
  } catch (_) {
    vatSetVenueAdapter(null);
    try { vatWireVenueApi("variational", null); } catch (_) {}
    return false;
  }
}

/* v1.6.0:xfund 跨所费率套利用——按 venue 建两个独立适配器,内存缓存(key=venue+凭证指纹),
 * 避免每 5 秒重建。凭证只取指纹(字段名),不进 key、不进日志。建不出返回 null,由调用方记日志跳过。 */
const __xfundAdCache = {};
async function vatXfundAdapters(config) {
  const out = { adA: null, adB: null };
  const venues = [config.xfundVenueA || "variational", config.xfundVenueB || "lighter"];
  const credsOf = (v) => (((config.venueCreds || {})[v]) || null);
  for (const [slot, venue] of [["adA", venues[0]], ["adB", venues[1]]]) {
    try {
      const creds = credsOf(venue);
      const fp = venue + ":" + (creds ? Object.keys(creds).sort().join(",") : "-");
      const hit = __xfundAdCache[fp];
      if (hit) { out[slot] = hit; continue; }
      const ad = createVenueAdapter(venue, { creds, storage: vatChromeStore() });
      if (ad) { __xfundAdCache[fp] = ad; out[slot] = ad; }
    } catch (_) { out[slot] = null; }
  }
  return out;
}

/* v1.3.0:统一重启——停当前轮、断开 venue 连接、清计时器,然后按 armed 决定是否恢复。
 * 铁律:用户手动停止/紧急停止(→armed=false)绝不触发自动重启,用 !config.armed 统一拦截。 */
async function restartStrategy(reason) {
  runGen++;
  busy = false;
  tickErrStreak = 0;
  venueHealthStreak = 0;
  try {
    const ad = vatActiveAdapter();
    if (ad && typeof ad.disconnect === "function") await ad.disconnect();
  } catch (_) {}
  try { if (timer) { clearInterval(timer); timer = null; } } catch (_) {}
  try { if (chrome.alarms) chrome.alarms.clear("VAT_WAKE"); } catch (_) {}
  const { config, state } = await store.load();
  if (!config.armed) {
    vatLog(state, "SYSTEM", `重启被忽略(${reason}):策略未在运行`, "warn");
    await store.saveState(state);
    ensureLoop(); // 重建 loop 后返回
    return { restarted: false };
  }
  vatManualRestartReset(state);
  vatLog(state, "SYSTEM", `策略已重启(${reason})`, "warn");
  await store.saveState(state);
  await vatEnsureAdapter(); // 重建适配器(凭证可能更新了)
  ensureLoop();
  try { await wdMaybeHeartbeat(config, state, VAT_VERSION, true); } catch (_) {}
  return { restarted: true };
}

async function tick() {
  const nowMs = Date.now();
  if (busy) {
    // v1.3.0:busy 卡死超过 60 秒 → 走 restartStrategy 全套重启(停轮/断连/清计时器/重建),
    // fire-and-forget 不 await(避免死锁);runGen++ 会让旧轮醒来后代次过期、结果被丢弃
    if (nowMs - tickStartAt > STALE_TICK_MS) {
      restartStrategy("主循环卡死超过60秒").catch(() => {});
    }
    return;
  }
  busy = true;
  tickStartAt = nowMs;
  const myGen = ++runGen;
  try {
    const { config, state } = await store.load();
    // 看门狗:先报警。心跳统一在对账之后发送(携带持仓快照);没启动也要发心跳(用来判断插件掉线),
    // 所以在 !armed 的各返回路径上补发。
    try { await wdMaybeAlert(config, state, VAT_VERSION); } catch (_) {}
    const hbSend = async (positions) => {
      try { await wdMaybeHeartbeat(config, state, VAT_VERSION, false, positions); } catch (_) {}
    };
    if (!config.armed) {
      // v1.2.4 自动重启:只恢复"会话原因"自动停止的;用户手动停止/紧急停止绝不自动重启。
      // 每 15 分钟试一次 checkSession(),会话真恢复了才重新 armed(等同于手动"测试连接"通过)。
      const recoverDue = (typeof vatAutoRecoverDue !== "undefined")
        ? vatAutoRecoverDue(config, Date.now())
        : (!config.stopReason || config.stopReason === "session");
      if (recoverDue && config.liveEnabled && config.mode !== "hedge") {
        try {
          await vatVenueCheckSession(); // v1.6.8:venue 感知(之前裸调 variational 会话)
          await store.saveSessionOk(Date.now());
          config.armed = true;
          config.stopReason = null;
          config.nextRecoverAt = 0;
          await store.saveConfig(config);
          vatLog(state, "SYSTEM", "连接已恢复,策略自动重启", "ok");
          await store.saveState(state);
        } catch (e) {
          config.nextRecoverAt = Date.now() +
            ((typeof VAT_RECOVER_INTERVAL_MS !== "undefined") ? VAT_RECOVER_INTERVAL_MS : 900000);
          await store.saveConfig(config);
          await hbSend(); // 未启动也要发心跳(掉线判断)
          return;
        }
      } else { await hbSend(); return; } // 未启动也要发心跳(掉线判断)
    }
    // v1.2.5:会话彻底不限时——定时器永不自动停策略(用户要求)。
    // 每6分钟真实探活一次;会话失效只记 err 日志(看门狗会报警),策略继续跑,重登后自动恢复。
    // v1.4.0:hedge 模式不探 Variational 会话(venue 健康检查已覆盖 Arcus,见下)。
    if (config.liveEnabled && config.mode !== "hedge") {
      probeCount++;
      if (probeCount % 12 === 0) {
        try { await vatVenueCheckSession(); await store.saveSessionOk(Date.now()); }
        catch (e) {
          vatLog(state, "SYSTEM", `连接探活失败(${e.message}),策略继续运行,恢复后自动恢复`, "err");
          await store.saveState(state);
        }
      }
    }
    // v1.4.0:hedge 模式走独立策略;其余模式沿用 vatTick。本体不动。
    // v1.6.0:fund(单所费率套利)/xfund(跨所费率套利)走独立策略。
    // v1.6.20:hedge 对子通用化,不再限定 Arcus(接口要求由 strategy_hedge.js 检查)。
    let next;
    if (config.mode === "hedge") {
      const ad = (typeof vatActiveAdapter === "function") ? vatActiveAdapter() : null;
      if (!ad) {
        vatLog(state, "HEDGE", "对冲模式需要先选择交易所并配置凭证,本轮跳过", "err");
        next = state;
      } else {
        next = await hedgeTick(config, state, ad);
      }
    } else if (config.mode === "fund") {
      const ad = (typeof vatActiveAdapter === "function") ? vatActiveAdapter() : null;
      if (!ad) {
        vatLog(state, "FUND", "单所费率套利需要先选择交易所(首发 Variational)并配置凭证,本轮跳过", "err");
        next = state;
      } else {
        if (ad.id !== "variational") {
          vatLog(state, "FUND", `当前交易所为 ${ad.id},单所费率套利首发只验证过 Variational,继续运行`, "warn");
        }
        next = await fundTick(config, state, ad);
      }
    } else if (config.mode === "xfund") {
      const pair = await vatXfundAdapters(config);
      if (!pair.adA || !pair.adB) {
        vatLog(state, "XFUND",
          `跨所费率套利需要 ${config.xfundVenueA || "variational"} 与 ${config.xfundVenueB || "lighter"} 两所凭证都配好,本轮跳过`, "err");
        next = state;
      } else {
        next = await xfundTick(config, state, pair.adA, pair.adB);
      }
    } else {
      next = await vatTick(config, state, vatApi());
    }
    // v1.2.6:约每 60 秒用交易所真实持仓对一次账(手动平仓后显示自动纠正);
    // 只在对账成功时更新本地状态,对账失败保留本地记录、不误删。
    reconCount++;
    if (reconCount % 12 === 0) {
      try {
        const rc = await vatReconcilePositions(vatApi(), next);
        if (rc.ok && rc.cleared.length)
          vatLog(next, "SYSTEM", `定时对账:已清除过期本地仓位 ${rc.cleared.join(",")}`, "warn");
      } catch (_) { /* 对账失败不影响运行,本地记录保留 */ }
      // v1.3.0:venue 健康检查——失败记 err(看门狗会自动报警),连续失败≥3 触发重启;
      // 健康失败绝不设 armed=false(v1.2.5 逻辑延续,策略继续跑)
      try {
        const ad = vatActiveAdapter();
        if (ad && typeof ad.checkSession === "function") {
          await ad.checkSession();
          venueHealthStreak = 0;
        }
      } catch (e) {
        venueHealthStreak++;
        vatLog(next, "VENUE",
          `venue健康检查失败(${String((e && e.message) || e).slice(0, 120)}),策略继续运行`, "err");
        if (venueHealthStreak >= 3) {
          venueHealthStreak = 0;
          restartStrategy("venue掉线").catch(() => {});
        }
      }
    }
    // v1.3.0:心跳携带持仓快照(看门狗对比后只在变化时通知);只取脱敏字段,凭证绝不进心跳
    let hbPositions = [];
    try {
      const ad = vatActiveAdapter();
      const rows = ad ? await ad.getPositions().catch(() => []) : [];
      hbPositions = (rows || []).map((p) => ({
        venue: p.venue, symbol: p.symbol, side: p.side, qty: p.qty,
        ...(p.entryPrice != null ? { entryPrice: p.entryPrice } : {}),
        ...(p.upnl != null ? { upnl: p.upnl } : {}),
      }));
    } catch (_) { hbPositions = []; }
    await hbSend(hbPositions);
    if (myGen !== runGen) return; // 已被新轮接管:丢弃本轮结果,不覆盖新轮状态
    await store.saveState(next);
    // v1.6.19:每 60 tick(约5分钟)持久化一次 1m K线,不随每轮 state 写
    if (++candleSaveTick >= 60) {
      candleSaveTick = 0;
      try {
        const g = (typeof globalThis !== "undefined") ? globalThis : {};
        await chrome.storage.local.set({ VAT_CANDLES1M: g.VAT_C1M || {} });
      } catch (_) {}
    }
    tickErrStreak = 0; // 成功一轮:连续 tick 异常计数清零
  } catch (e) {
    tickErrStreak++;
    try {
      const { state } = await store.load();
      vatLog(state, "SYSTEM", `tick 异常: ${e.message}`, "err");
      await store.saveState(state);
    } catch (_) { /* ignore */ }
    if (tickErrStreak >= 3) {
      tickErrStreak = 0;
      restartStrategy("连续tick异常").catch(() => {});
    }
  } finally {
    // v1.2.6:只有本轮仍是最新代次才清 busy;被接管后 busy 归新轮管理
    if (myGen === runGen) busy = false;
  }
}

function ensureLoop() {
  vatEnsureAdapter().catch(() => {}); // v1.3.0:启动时按 config.activeVenue 建适配器(失败不抛,回退全局函数)
  if (!timer) timer = setInterval(tick, TICK_MS);
  try { chrome.alarms.create("VAT_WAKE", { periodInMinutes: 0.5 }); } catch (e) {}
  tick();
}

chrome.runtime.onInstalled.addListener(() => ensureLoop());
chrome.runtime.onStartup.addListener(() => ensureLoop());
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === "VAT_WAKE") tick(); });
}
ensureLoop();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const { config, state, sessionOkAt } = await store.load();
    switch (msg && msg.type) {
      case "VAT_GET": {
        // v1.3.0:六所状态(弹窗切换用);configured 只表示"存过凭证",凭证本身绝不回传
        const venueList = (typeof VAT_VENUES !== "undefined" && VAT_VENUES) || [];
        const venueActive = config.activeVenue || "variational";
        // v1.6.9:QFEX 余额(60 秒缓存,失败→null,不阻塞弹窗)
        let balance = null;
        try {
          const ad = (typeof vatActiveAdapter === "function") ? vatActiveAdapter() : null;
          if (ad && ad.id === "qfex" && typeof ad.getBalance === "function") {
            const nowB = Date.now();
            if (!__vatBalCache || nowB - __vatBalCache.t > 60000 || __vatBalCache.venue !== "qfex") {
              let v = null;
              try { v = await ad.getBalance(); } catch (_) { v = null; }
              __vatBalCache = { t: nowB, venue: "qfex", v };
            }
            balance = __vatBalCache.v;
          }
        } catch (_) { balance = null; }
        sendResponse({
          ok: true, version: VAT_VERSION, config, state, sessionOkAt, balance,
          venueStatus: {
            activeVenue: venueActive,
            list: venueList.map((v) => ({
              id: v.id, name: v.name, status: v.status, authType: v.authType,
              configured: !!((config.venueCreds || {})[v.id]),
              running: v.id === venueActive && !!config.armed,
            })),
          },
        });
        break;
      }
      case "VAT_WD_TEST": {
        const okA = await wdRelaySend("test", config, state, VAT_VERSION, "看门狗链路测试(用户手动触发)");
        await wdMaybeHeartbeat(config, state, VAT_VERSION, true);
        sendResponse(okA ? { ok: true } : { ok: false, error: "中转站发送失败,可能是网络问题,告诉 Muse 换后备方案" });
        break;
      }
      case "VAT_PROBE_QUOTE": {
        // 询价探测(只询价不下单):把各标的试几种 qty 精度,定位 400 空响应是精度问题还是别的
        const assets = vatVenueAssets(config).filter(Boolean); // v1.6.10:只探测当前所的标的
        const probes = {};
        for (const a of assets) {
          const fbMark = Number(((state.markets || {})[a] || {}).mark || 0);
          try {
            probes[a] = await probeQuote(a + "-SWAP", fbMark);
          } catch (e) {
            probes[a] = { symbol: a + "-SWAP", underlying: a, markNote: String(e.message).slice(0, 120), results: [] };
          }
          const p = probes[a];
          // 明细进日志(用 warn,不触发看门狗 err 报警);用户点"复制错误报告"发我即可定位
          if (p.markNote) vatLog(state, a, `探测取价: ${p.markNote}`, "warn");
          for (const r of (p.results || [])) {
            const detail = r.ok
              ? `通过${r.tick ? ` tick=${r.tick}` : ""}`
              : `失败${r.httpStatus ? ` HTTP ${r.httpStatus}` : ""} ${(r.error || "").slice(0, 160)}`;
            vatLog(state, a, `探测 qty=${r.qty}: ${detail}`, r.ok ? "ok" : "warn");
          }
        }
        const sum = Object.entries(probes).map(([a, p]) => {
          const rs = p.results || [];
          const okN = rs.filter((r) => r.ok).length;
          const tick = (rs.find((r) => r.ok && r.tick) || {}).tick;
          return `${a} ${okN}/${rs.length}通过${tick ? ` tick=${tick}` : ""}`;
        }).join(" | ");
        vatLog(state, "SYSTEM", `询价探测: ${sum || "无标的"}`, "warn");
        await store.saveState(state);
        sendResponse({ ok: true, probes });
        break;
      }
      case "VAT_SAVE_CONFIG":
        await store.saveConfig({ ...config, ...(msg.config || {}) });
        sendResponse({ ok: true });
        break;
      case "VAT_START": {
        // v1.2.4:手动启动清 stopReason(用户接管,不再自动重启逻辑);stopReason 写死 null 防止旧配置残留
        const c = { ...config, ...(msg.config || {}), armed: true, stopReason: null, nextRecoverAt: 0 };
        // v1.3.0:先按(可能刚更新的)venue 建适配器,再做会话活检;建失败不抛,vatApi()回退全局函数
        await vatEnsureAdapter({
          venue: c.activeVenue || "variational",
          creds: ((c.venueCreds || {})[c.activeVenue || "variational"]) || null,
        });
        if (c.liveEnabled) {
          // v1.6.8:非 variational 的 trend/scalp/maker 模式,持仓对账字段待实测,LIVE 直接拒绝(防下错所)
          const guard = vatVenueLiveGuard(c);
          if (guard) { sendResponse({ ok: false, error: `LIVE 启动被阻止:${guard}` }); return; }
          // v1.2.5:会话不限时;启动时只做一次真实活检,会话真死了就明确告诉用户(人在场),不靠定时器
          try { await vatVenueCheckSession(); await store.saveSessionOk(Date.now()); }
          catch (e) {
            sendResponse({ ok: false, error: `LIVE 启动被阻止:${e.message}` });
            return;
          }
        }
        await store.saveConfig(c);
        vatManualRestartReset(state); // 手动重启:清连续亏损计数、熔断告警复位
        // v1.2.4:启动时对账——本地仓位记录 vs 交易所真实持仓,防止手动平仓后残留导致 422 死循环
        try {
          const rc = await vatReconcilePositions(vatApi(), state);
          if (!rc.ok) vatLog(state, "SYSTEM", `启动对账跳过:交易所持仓读取失败(${rc.reason})`, "warn");
          else if (rc.cleared.length) vatLog(state, "SYSTEM", `启动对账:已清除过期本地仓位 ${rc.cleared.join(",")}`, "warn");
        } catch (e) { /* 对账失败不阻塞启动 */ }
        vatLog(state, "SYSTEM",
          `${c.liveEnabled ? "LIVE 实盘" : "PAPER 模拟"} ${c.mode} 已启动${c.liveEnabled ? "" : "(不发送真实订单)"}`,
          c.liveEnabled ? "err" : "ok");
        await store.saveState(state);
        wdMaybeHeartbeat(c, state, VAT_VERSION, true).catch(() => {});
        sendResponse({ ok: true });
        tick();
        break;
      }
      case "VAT_STOP": {
        const c = { ...config, armed: false, stopReason: "user" }; // v1.2.4:用户手动停止,绝不自动重启
        await store.saveConfig(c);
        vatLog(state, "SYSTEM", "策略已停止(已有实盘仓位不会被盲目强平)", "warn");
        await store.saveState(state);
        wdMaybeHeartbeat(c, state, VAT_VERSION, true).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "VAT_TEST": {
        try {
          await vatVenueCheckSession(); // v1.6.8:venue 感知
          let rows = [];
          try {
            const r = (vatVenueId() === "variational")
              ? await getPositions()
              : await vatActiveAdapter().getPositions();
            rows = Array.isArray(r) ? r : [];
          } catch (_) { rows = []; }
          const t = Date.now();
          await store.saveSessionOk(t);
          vatLog(state, "SYSTEM", `连接测试成功,可读取持仓(${rows.length}条)`, "ok");
          await store.saveState(state);
          sendResponse({ ok: true, positions: rows.length, at: t });
        } catch (e) {
          vatLog(state, "SYSTEM", `连接测试失败: ${e.message}`, "err");
          await store.saveState(state);
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }
      case "VAT_PANIC": {
        const c = { ...config, armed: false, stopReason: "user" }; // v1.2.4:紧急停止是用户意志,绝不自动重启
        await store.saveConfig(c);
        vatLog(state, "SYSTEM", "紧急停止:不再开新仓,已有仓位请手动处理", "err");
        await store.saveState(state);
        wdMaybeHeartbeat(c, state, VAT_VERSION, true).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "VAT_RESTART": {
        // v1.3.0:手动重启键。未运行时 restartStrategy 内部拒绝并记日志,仍回 ok
        const r = await restartStrategy("用户手动重启").catch(() => ({ restarted: false }));
        sendResponse({ ok: true, restarted: !!r.restarted });
        break;
      }
      case "VAT_SET_VENUE": {
        // v1.3.0:切换交易所。waitlist/unsupported 拒绝;按 venuePolicy.onSwitch 处理旧所持仓
        const v = (typeof vatVenueById === "function") ? vatVenueById(msg.venue) : null;
        if (!v) { sendResponse({ ok: false, error: "未知交易所" }); break; }
        if (v.status === "waitlist") { sendResponse({ ok: false, error: `${v.name} 还在 waitlist,拿到权限后再切换` }); break; }
        if (v.status === "unsupported") { sendResponse({ ok: false, error: `${v.name} 不支持自动化交易,已跳过` }); break; }
        const cur = config.activeVenue || "variational";
        if (cur === v.id) { sendResponse({ ok: true, action: "noop", detail: `已在 ${v.name},无需切换` }); break; }
        const oldAd = vatActiveAdapter();
        const pol = (config.venuePolicy && config.venuePolicy.onSwitch) || "remind";
        let action = pol, detail = "";
        if (pol === "close") {
          if (config.liveEnabled && oldAd && typeof oldAd.closeAllPositions === "function") {
            try {
              const r = await oldAd.closeAllPositions();
              detail = `已自动平掉旧所全部持仓(${r.closed || 0} 条),已切换到 ${v.name}`;
            } catch (e) {
              sendResponse({ ok: false, error: `旧所自动平仓失败(${String((e && e.message) || e).slice(0, 120)}),切换已取消` });
              break;
            }
          } else {
            action = "skip";
            detail = config.liveEnabled
              ? "旧所无适配器,跳过自动平仓"
              : `PAPER 模式跳过真实平仓,已切换到 ${v.name}`;
          }
        } else if (pol === "keep") {
          detail = `旧所持仓留着不管,已切换到 ${v.name}`;
        } else { // remind
          detail = `提醒:旧所持仓请手动处理,已切换到 ${v.name}`;
        }
        config.activeVenue = v.id;
        await store.saveConfig(config);
        await vatEnsureAdapter(); // 按新 venue 重建适配器
        sendResponse({ ok: true, action, detail });
        break;
      }
      case "VAT_TEST_VENUE": {
        // v1.3.0:用已存凭证临时建适配器做 checkSession,不影响当前运行
        const v = (typeof vatVenueById === "function") ? vatVenueById(msg.venue) : null;
        if (!v || v.status !== "live") { sendResponse({ ok: false, error: "该交易所当前不可用" }); break; }
        try {
          const creds = ((config.venueCreds || {})[v.id]) || null;
          const ad = createVenueAdapter(v.id, { creds, storage: vatChromeStore() });
          if (!ad) { sendResponse({ ok: false, error: "适配器创建失败" }); break; }
          await ad.checkSession();
          try { await ad.disconnect(); } catch (_) {}
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
        }
        break;
      }
      /* v1.6.8:QFEX 实测探测。调适配器 probeRaw() 拿市场目录/行情/持仓/余额的原始形状,
       * 脱敏后记日志,用户贴回给 Muse 做字段映射(持仓/余额字段未确认前不编造)。 */
      case "VAT_PROBE_QFEX": {
        try {
          const ad = (typeof vatActiveAdapter === "function") ? vatActiveAdapter() : null;
          if (!ad || ad.id !== "qfex" || typeof ad.probeRaw !== "function") {
            sendResponse({ ok: false, error: "当前 venue 不是 qfex 或适配器不支持探测" });
            break;
          }
          const raw = await ad.probeRaw(null);
          const clip = (o, n) => String(JSON.stringify(o)).slice(0, n || 1200);
          vatLog(state, "QFEX", `探测: 市场 ${raw.marketsCount} 个,样本 ${clip(raw.marketSample, 300)}`, "ok");
          for (const [s, q] of Object.entries(raw.quotes || {})) {
            vatLog(state, "QFEX", `探测行情 ${s}: ${clip(q, 300)}`, q && q.error ? "err" : "ok");
          }
          // v1.6.24:一次定位——出口 IP/国家 + UAT 对照 + 握手耗时分类,最后给 verdict(4 选 1)。
          // 背景:官方 CLI 确认裸 wss://trade.qfex.com/ 就是正确地址,auth 是连上之后的消息,
          // 所以握手失败与 Key 无关,是传输层/路径问题;QFEX 文档明确"初始 WS 握手有独立管控"。
          let egress = null;
          try {
            const r = await fetch("https://ip-api.com/json/?fields=status,country,countryCode,query");
            const j = await r.json();
            if (j && j.status === "ok") {
              egress = j;
              vatLog(state, "QFEX", `出口 IP: ${j.query} (${j.countryCode}/${j.country || "?"})`, "ok");
            } else { vatLog(state, "QFEX", "出口 IP 查询失败(不影响结论)", "warn"); }
          } catch (e) { vatLog(state, "QFEX", "出口 IP 查询失败(不影响结论)", "warn"); }
          // v1.6.11:WS 分层诊断——区分"主机不可达"和"WS 升级被拦"(保留)
          try {
            const r = await fetch("https://trade.qfex.com/", { method: "GET" });
            vatLog(state, "QFEX", `WS诊断: https://trade.qfex.com/ 可达(HTTP ${r.status}),主机/DNS/TLS 正常`, "ok");
          } catch (e) {
            vatLog(state, "QFEX", `WS诊断: https://trade.qfex.com/ 不可达(${String((e && e.message) || e).slice(0, 100)}),主机层被拦,换节点/DNS`, "err");
          }
          // 8 秒握手探测,返回 {ok, ms, err}
          const wsProbe = (url) => new Promise((resolve) => {
            const t0 = Date.now();
            let done = false, ws = null;
            const finish = (ok, err) => {
              if (done) return; done = true;
              clearTimeout(to);
              try { if (ws) ws.close(); } catch (_) {}
              resolve({ ok: ok, ms: Date.now() - t0, err: err || "" });
            };
            const to = setTimeout(() => finish(false, "握手超时 8s"), 8000);
            try { ws = new WebSocket(url); }
            catch (e) { finish(false, "构造失败:" + String((e && e.message) || e).slice(0, 60)); return; }
            ws.onopen = () => finish(true, "");
            ws.onerror = () => finish(false, "onerror");
            ws.onclose = (ev) => finish(false, "close code=" + ev.code + (ev.reason ? " reason=" + String(ev.reason).slice(0, 40) : ""));
          });
          const prod = await wsProbe("wss://trade.qfex.com/");
          if (prod.ok) {
            vatLog(state, "QFEX", `WS诊断: wss://trade.qfex.com/ 握手成功(${prod.ms}ms),下单通道正常`, "ok");
          } else {
            const kind = prod.ms < 3000
              ? "快速拒绝(服务端/WAF 主动掐升级→指向握手限流或地理风控)"
              : "8s 超时(升级请求石沉大海→指向中间设备黑洞)";
            vatLog(state, "QFEX", `WS诊断: wss 握手失败(${prod.err},${prod.ms}ms):${kind}`, "err");
          }
          // v1.6.24:UAT 对照——同一套 API 的另一台主机,区分"只拦 prod"vs"全拦 QFEX"(握手无需 Key)
          const uat = await wsProbe("wss://trade.qfex.io/");
          vatLog(state, "QFEX", uat.ok
            ? `WS诊断对照(UAT): wss://trade.qfex.io/ 握手成功(${uat.ms}ms)`
            : `WS诊断对照(UAT): 握手失败(${uat.err},${uat.ms}ms)`, uat.ok ? "ok" : "err");
          // v1.6.12:对照测试——公共 WS 回声服务器,区分"本机拦所有 wss"vs"只拦 QFEX"(保留)
          const echo = await wsProbe("wss://ws.postman-echo.com/raw");
          vatLog(state, "QFEX", echo.ok
            ? "WS诊断对照(公共): 回声服务器握手成功→本机 wss 栈正常"
            : `WS诊断对照(公共): 也失败(${echo.err})→本机/代理拦掉了所有 wss`, echo.ok ? "ok" : "err");
          // verdict:4 选 1
          const cc = (egress && egress.countryCode) || "?";
          const banned = ["US", "GB", "FR", "ES", "UA", "RU", "KP"].indexOf(cc) >= 0;
          let verdict;
          if (prod.ok) {
            verdict = "结论:prod 握手成功,通道已恢复(之前多为限流/抖动)。可重试下单;若再失败,优先看是否触发 10 分钟握手退避";
          } else if (echo.ok && uat.ok) {
            verdict = "结论:QFEX 只拦了 prod(trade.qfex.com),UAT 正常→出口 IP 被 prod 握手层限流/风控。解法:①停插件 1-2 小时等衰减 ②VPN 换节点(首选东京/新加坡)" +
              (banned ? ` ③出口 ${cc} 在 QFEX 公开禁区名单,换节点优先` : "");
          } else if (echo.ok) {
            verdict = "结论:到 QFEX 两台主机(prod+UAT)的 wss 都被拦,本机 wss 正常→代理/VPN 针对 QFEX 拦截。解法:换 VPN 协议/节点,或给 trade.qfex.com 做直连分流" +
              (banned ? `;另:出口 ${cc} 在 QFEX 公开禁区名单,也建议换节点` : "");
          } else {
            verdict = "结论:本机连公共 wss 都失败→代理/VPN 拦掉了所有 wss。解法:换 VPN 协议或直连后再测";
          }
          vatLog(state, "QFEX", verdict, prod.ok ? "ok" : "warn");
          vatLog(state, "QFEX", `探测持仓原始: ${clip(raw.positionsRaw, 1500)}`, "warn");
          vatLog(state, "QFEX", `探测余额原始: ${clip(raw.balanceRaw, 1500)}`, "warn");
          vatLog(state, "QFEX", "探测完成:请把上面 2 条 warn 日志贴给 Muse 做字段映射", "warn");
          await store.saveState(state);
          sendResponse({ ok: true });
        } catch (e) {
          vatLog(state, "QFEX", `探测失败: ${String((e && e.message) || e).slice(0, 200)}`, "err");
          await store.saveState(state);
          sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
        }
        break;
      }
      case "VAT_SAVE_VENUE_CREDS": {        // v1.3.0:存某所凭证到本机(整体存 chrome.storage.local);凭证绝不回传给弹窗
        const venue = String(msg.venue || "");
        if (!venue) { sendResponse({ ok: false, error: "缺少 venue" }); break; }
        config.venueCreds = { ...(config.venueCreds || {}), [venue]: msg.creds || {} };
        await store.saveConfig(config);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // 异步回复
});
