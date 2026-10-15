"use strict";
/* 看门狗:webhook.site 中转 + Muse 发邮件通知(v1.2.0)。
 * 架构定稿:ntfy.sh 被 Muse 侧网络挡,Telegram 在国内被墙(插件在用户浏览器里同样连不上),
 * 改走 webhook.site 中转——插件 POST 脱敏报警/心跳,Muse 每 5 分钟拉一次,有新报错就修,
 * 修好发邮件(zhy2923@163.com)通知用户;心跳断了(插件掉线)也发邮件喊用户。
 * 用户零配置,不用装任何 App,不用建 bot。
 * 消息里只有版本/时间/标的/步骤状态/服务端原话,不含 Cookie、key、私钥。 */
const WD_RELAY = "https://webhook.site/f93d5747-6f2e-49df-84bc-27bdec885c3b";
const WD_HB_MS = 5 * 60 * 1000;         // 心跳间隔
const WD_ALERT_WIN_MS = 10 * 60 * 1000; // 只报 10 分钟内的新错误
const WD_RESEND_MS = 30 * 60 * 1000;    // 同一错误 30 分钟内不重复报

async function wdLoad() {
  try {
    const r = await chrome.storage.local.get(["VAT_WD"]);
    return r.VAT_WD || {};
  } catch (e) { return {}; }
}
async function wdSave(patch) {
  try {
    const cur = await wdLoad();
    await chrome.storage.local.set({ VAT_WD: { ...cur, ...patch } });
  } catch (e) { /* ignore */ }
}
function wdSig(asset, msg) {
  const s = String(asset) + "|" + String(msg).slice(0, 160);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/** 纯函数:构造中转站 body。只含脱敏字段,凭证绝不能出现在这里
 * (positions 只有 venue/symbol/side/qty/entryPrice/upnl)。 */
function wdBuildBody(kind, config, version, text, positions) {
  return {
    kind, v: version, label: (config && config.label) || "",
    mode: config ? config.mode : undefined,
    live: !!(config && config.liveEnabled), armed: !!(config && config.armed),
    t: Date.now(), text: text || "",
    positions: Array.isArray(positions) ? positions : [],
  };
}
/* v1.6.25:GitHub gist 中继事件。字段复用 wdBuildBody,新增:
 * eid=<UTC时间戳YYYYMMDDTHHMMSS>_<4位随机hex>(Date.now() 生成),
 * ts=UTC "YYYY-MM-DD HH:MM:SS"。 */
function wdUtcStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}
function wdUtcString(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}
function wdBuildGistEvent(kind, config, version, text, positions) {
  const body = wdBuildBody(kind, config, version, text, positions);
  const now = Date.now();
  const rnd = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return Object.assign({}, body, {
    eid: wdUtcStamp(now) + "_" + rnd,
    ts: wdUtcString(now),
  });
}
const WD_GIST_EVENTS_MAX = 300; // gist 只保留最后 300 条事件
/** v1.6.25:GitHub gist 中继(带 PAT 写)。串行:GET→push→slice(-300)→PATCH。
 * 返回是否成功,失败静默(不影响交易,由 wdMaybeHeartbeat 的 relayFail 计数记账)。 */
async function wdGistFetch(url, pat, opts, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    return await fetch(url, Object.assign({}, opts, {
      signal: ctrl.signal,
      headers: Object.assign(
        { Authorization: "Bearer " + pat, Accept: "application/vnd.github+json" },
        (opts && opts.headers) || {}),
    }));
  } finally { clearTimeout(to); }
}
async function wdGistSend(kind, config, state, version, text, positions) {
  const gistId = config && config.wdGistId, pat = config && config.wdGhPat;
  if (!gistId || !pat) return false;
  const url = "https://api.github.com/gists/" + encodeURIComponent(gistId);
  const ev = wdBuildGistEvent(kind, config, version, text, positions);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const g = await wdGistFetch(url, pat, {}, 20000);
      if (!g || !g.ok) throw new Error("gist GET " + (g && g.status));
      const j = await g.json();
      let events = [];
      try {
        const fc = j && j.files && j.files["watchdog.json"] && j.files["watchdog.json"].content;
        const parsed = fc ? JSON.parse(fc) : null;
        if (parsed && Array.isArray(parsed.events)) events = parsed.events;
      } catch (_) { events = []; }
      events.push(ev);
      events = events.slice(-WD_GIST_EVENTS_MAX);
      const p = await wdGistFetch(url, pat, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: { "watchdog.json": { content: JSON.stringify({ events }) } } }),
      }, 20000);
      if (p && p.ok) return true;
    } catch (_) { /* 下面重试 */ }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
/** 往中转站发一条消息,返回是否成功。失败静默(不影响交易,本地日志和复制按钮还在)。 */
/* v1.6.6:超时 10s→20s,失败重试一次。之前 10 秒一刀切,弱网下心跳发不出去还是静默的。 */
/* v1.6.25:配了 wdGistId+wdGhPat 走 GitHub gist 中继,否则回退旧 webhook.site POST(兼容过渡)。 */
async function wdRelaySend(kind, config, state, version, text, positions) {
  if (!config.wdEnabled) return false;
  if (config.wdGistId && config.wdGhPat)
    return wdGistSend(kind, config, state, version, text, positions);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(WD_RELAY, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wdBuildBody(kind, config, version, text, positions)),
      });
      clearTimeout(to);
      if (r && r.ok) return true;
    } catch (e) { /* 下面重试 */ } finally { clearTimeout(to); }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
/** 紧凑报警正文(≤3000字) */
function wdCompactReport(config, state, version) {
  const L = [];
  const s = state.stats || {};
  const posCount = Object.keys(state.positions || {}).length;
  L.push(`[VAT报警] v${version} [${config.label || "未设"}] ${config.liveEnabled ? "LIVE" : "PAPER"}/${config.mode} armed=${config.armed ? 1 : 0}`);
  L.push(`持仓${posCount} PnL=${Number(s.pnl || 0).toFixed(2)}U 开仓${s.trades || 0}`);
  const errs = (state.logs || []).filter((x) => x.level === "err").slice(0, 3);
  for (const x of errs) {
    let t = "";
    try { t = new Date(x.t).toLocaleTimeString("zh-CN", { hour12: false }); } catch (e) { t = "?"; }
    L.push(`[${t}] ${x.asset} ${String(x.msg).slice(0, 500)}`);
  }
  let out = L.join("\n");
  if (out.length > 3000) out = out.slice(0, 3000) + "…(截断,完整报告请在插件点复制)";
  return out;
}
/** 扫描最近的 err 日志,有新的就报警(去重)。 */
async function wdMaybeAlert(config, state, version) {
  if (!config.wdEnabled) return;
  const errs = (state.logs || []).filter((x) => x.level === "err");
  if (!errs.length) return;
  const newest = errs[0];
  if (Date.now() - newest.t > WD_ALERT_WIN_MS) return;
  const sig = wdSig(newest.asset, newest.msg);
  const wd = await wdLoad();
  if (wd.lastSig === sig && Date.now() - (wd.lastAt || 0) < WD_RESEND_MS) return;
  const ok = await wdRelaySend("alert", config, state, version, wdCompactReport(config, state, version));
  if (ok) await wdSave({ lastSig: sig, lastAt: Date.now() });
}
/** 心跳:Muse 用它判断插件掉线。positions 透传给中转站(可空数组,诚实)。 */
async function wdMaybeHeartbeat(config, state, version, force, positions) {
  if (!config.wdEnabled) return;
  const wd = await wdLoad();
  if (!force && Date.now() - (wd.lastHbAt || 0) < WD_HB_MS) return;
  const s = state.stats || {};
  const ok = await wdRelaySend("hb", config, state, version,
    `心跳 pos=${Object.keys(state.positions || {}).length} pnl=${Number(s.pnl || 0).toFixed(2)}U`,
    positions);
  if (ok) { await wdSave({ lastHbAt: Date.now(), relayFail: 0 }); return; }
  // v1.6.6:中继失败不再静默。记连续失败次数,第 3 次和之后每 12 次(约 1 小时)打一条 warn 日志,
  // 用户在错误报告里能看到"心跳发不出去",不再误以为看门狗掉线。插件本身运行不受影响。
  const n = (wd.relayFail || 0) + 1;
  await wdSave({ relayFail: n, relayFailAt: Date.now() });
  if (n === 3 || n % 12 === 0) {
    try {
      if (typeof vatLog === "function") {
        vatLog(state, "SYSTEM",
          `看门狗中继连续失败 ${n} 次(心跳/报警发不到中转站,多为网络问题,可点"发送测试报警"验证);插件本身运行正常`, "warn");
      }
    } catch (_) { /* 日志失败不影响主流程 */ }
  }
}

/* v1.3.0:持仓快照差异(纯函数,node 可测)。
 * oldArr/newArr: [{venue,symbol,side,qty,entryPrice?,upnl?}]。
 * 返回变化事件数组,事件形状 {type:'open'|'close'|'qty'|'side'|'pnl', venue, symbol, detail}。
 * 判定:key=venue|symbol;新 key→open;key 消失→close;数量变化→qty;方向变化→side;
 * |Δupnl|≥1U 才算"明显"→pnl(有一方缺 upnl 则不判)。 */
function vdPositionsDiff(oldArr, newArr) {
  const ev = [];
  const keyOf = (p) => String(p && p.venue) + "|" + String(p && p.symbol);
  const oldMap = new Map();
  for (const p of (oldArr || [])) { if (p) oldMap.set(keyOf(p), p); }
  const newMap = new Map();
  for (const p of (newArr || [])) { if (p) newMap.set(keyOf(p), p); }
  for (const [, p] of newMap) {
    const o = oldMap.get(keyOf(p));
    if (!o) {
      ev.push({ type: "open", venue: p.venue, symbol: p.symbol,
        detail: `新开仓 ${p.venue}/${p.symbol} ${p.side || "?"} ${p.qty}` });
      continue;
    }
    if (String(o.side) !== String(p.side))
      ev.push({ type: "side", venue: p.venue, symbol: p.symbol,
        detail: `方向变化 ${p.venue}/${p.symbol}: ${o.side}→${p.side}` });
    if (Number(o.qty) !== Number(p.qty))
      ev.push({ type: "qty", venue: p.venue, symbol: p.symbol,
        detail: `数量变化 ${p.venue}/${p.symbol}: ${o.qty}→${p.qty}` });
    const ou = (o.upnl == null || o.upnl === "") ? null : Number(o.upnl);
    const nu = (p.upnl == null || p.upnl === "") ? null : Number(p.upnl);
    if (ou !== null && nu !== null && Number.isFinite(ou) && Number.isFinite(nu) &&
        Math.abs(nu - ou) >= 1)
      ev.push({ type: "pnl", venue: p.venue, symbol: p.symbol,
        detail: `盈亏变化≥1U ${p.venue}/${p.symbol}: ${ou}→${nu}` });
  }
  for (const [k, o] of oldMap) {
    if (!newMap.has(k))
      ev.push({ type: "close", venue: o.venue, symbol: o.symbol,
        detail: `已平仓 ${o.venue}/${o.symbol}` });
  }
  return ev;
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { vdPositionsDiff, wdBuildBody, wdBuildGistEvent, wdUtcStamp, wdUtcString, WD_GIST_EVENTS_MAX, wdGistSend, wdRelaySend };
}
