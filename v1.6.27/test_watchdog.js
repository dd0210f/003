"use strict";
/* 看门狗回归(v1.2.0 webhook.site 中转版) */
const posts = [];
let wdStore = {};
global.chrome = {
  storage: { local: {
    get: async (k) => ({ VAT_WD: wdStore }),
    set: async (o) => { wdStore = { ...wdStore, ...(o.VAT_WD || {}) }; },
  } },
};
global.fetch = async (url, opts) => {
  posts.push({ url, body: JSON.parse(opts.body) });
  return { ok: true };
};
global.AbortController = class { constructor() {} abort() {} get signal() { return undefined; } };

const fs = require("fs");
(0, eval)(fs.readFileSync(__dirname + "/watchdog.js", "utf8").replace('"use strict";', ""));

const cfg = { label: "001", mode: "volume", liveEnabled: true, armed: true, wdEnabled: true };
const mkState = (logs) => ({ logs, positions: {}, stats: { pnl: 1.23, trades: 5 } });
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

(async () => {
  // 1. 新 err → 中转站报警
  posts.length = 0; wdStore = {};
  const s1 = mkState([{ t: Date.now() - 60000, asset: "XAU", level: "err", msg: "Maker 挂单失败: HTTP 400 unknown variant" }]);
  await wdMaybeAlert(cfg, s1, "1.2.0");
  ok("新err触发报警", posts.length === 1 && posts[0].url.startsWith("https://webhook.site/"));
  const b = posts[0].body;
  ok("报警字段齐全", b.kind === "alert" && b.v === "1.2.0" && b.label === "001" && b.live === true && b.armed === true);
  ok("报警正文含关键信息", b.text.includes("v1.2.0") && b.text.includes("LIVE/volume") && b.text.includes("HTTP 400"));

  // 2. 同一错误去重
  posts.length = 0;
  await wdMaybeAlert(cfg, s1, "1.2.0");
  ok("同一错误去重", posts.length === 0);

  // 3. 旧错误不报
  posts.length = 0; wdStore = {};
  const s3 = mkState([{ t: Date.now() - 20 * 60 * 1000, asset: "XAU", level: "err", msg: "旧错误" }]);
  await wdMaybeAlert(cfg, s3, "1.2.0");
  ok("旧错误不报警", posts.length === 0);

  // 4. 心跳
  posts.length = 0; wdStore = {};
  await wdMaybeHeartbeat(cfg, mkState([]), "1.2.0", true);
  ok("心跳发送", posts.length === 1 && posts[0].body.kind === "hb" && posts[0].body.armed === true);
  posts.length = 0;
  await wdMaybeHeartbeat(cfg, mkState([]), "1.2.0", false);
  ok("心跳节流", posts.length === 0);

  // 5. 开关关闭 → 不发
  posts.length = 0; wdStore = {};
  const off = { ...cfg, wdEnabled: false };
  await wdMaybeAlert(off, s1, "1.2.0");
  await wdMaybeHeartbeat(off, mkState([]), "1.2.0", true);
  ok("关闭后不发", posts.length === 0);

  // 6. 超长截断
  posts.length = 0; wdStore = {};
  const long = mkState([{ t: Date.now(), asset: "XAU", level: "err", msg: "E".repeat(10000) }]);
  await wdMaybeAlert(cfg, long, "1.2.0");
  ok("正文≤3000+", posts.length === 1 && posts[0].body.text.length <= 3100);

  // 7. 发送失败不记去重,下轮补发
  posts.length = 0; wdStore = {};
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error("net down"); };
  await wdMaybeAlert(cfg, s1, "1.2.0");
  ok("发送失败不记去重", !wdStore.lastSig);
  global.fetch = oldFetch;
  await wdMaybeAlert(cfg, s1, "1.2.0");
  ok("恢复后补报", posts.length === 1);

  // 8. v1.6.25:gist 事件字段格式
  const { wdBuildGistEvent } = require(__dirname + "/watchdog.js");
  const ev1 = wdBuildGistEvent("hb", cfg, "1.6.25", "心跳", []);
  ok("eid 格式 YYYYMMDDTHHMMSS_4位hex", /^\d{8}T\d{6}_[0-9a-f]{4}$/.test(ev1.eid));
  ok("ts 格式 UTC 字符串", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ev1.ts));
  ok("eid/ts 为 UTC(与本地时区无关)", ev1.eid.slice(0, 15) === ev1.ts.slice(0, 10).replace(/-/g, "") + "T" + ev1.ts.slice(11, 19).replace(/:/g, ""));
  ok("gist 事件复用旧字段", ev1.kind === "hb" && ev1.v === "1.6.25" && ev1.label === "001" &&
     ev1.mode === "volume" && ev1.live === true && ev1.armed === true &&
     typeof ev1.t === "number" && Array.isArray(ev1.positions));

  // 9. v1.6.25:配了 gist → 走 api.github.com;300 条裁剪;不碰 webhook
  const manyEvents = [];
  for (let i = 0; i < 305; i++) manyEvents.push({ eid: "old" + i, kind: "hb", ts: "2026-10-01 00:00:00" });
  let patchedBody = null, gistCalls = [];
  global.fetch = async (url, opts) => {
    gistCalls.push(url);
    if (!opts.method || opts.method === "GET") {
      ok_auth(opts);
      return { ok: true, json: async () => ({ files: { "watchdog.json": { content: JSON.stringify({ events: manyEvents }) } } }) };
    }
    patchedBody = JSON.parse(opts.body);
    ok_auth(opts);
    return { ok: true };
  };
  function ok_auth(opts) {
    const h = (opts.headers || {});
    if (h.Authorization !== "Bearer ghp_x") throw new Error("Authorization 头错误");
    if (!/api\.github\.com\/gists\/abc123/.test(gistCalls[gistCalls.length - 1])) throw new Error("URL 错误");
  }
  posts.length = 0;
  const gok = await wdRelaySend("hb", { ...cfg, wdGistId: "abc123", wdGhPat: "ghp_x" }, mkState([]), "1.6.25", "心跳", []);
  ok("gist 发送成功", gok === true);
  ok("gist 先 GET 后 PATCH", gistCalls.length === 2);
  const evs = JSON.parse(patchedBody.files["watchdog.json"].content).events;
  ok("裁剪到 300 条", evs.length === 300);
  ok("新事件在末尾", evs[299].kind === "hb" && /^\d{8}T\d{6}_[0-9a-f]{4}$/.test(evs[299].eid));
  ok("配 gist 后不走 webhook", posts.length === 0);

  // 10. v1.6.25:没配 gist → 回退旧 webhook POST
  posts.length = 0;
  global.fetch = oldFetch;
  await wdRelaySend("hb", cfg, mkState([]), "1.6.25", "心跳", []);
  ok("无 gist 配置回退 webhook", posts.length === 1 && posts[0].url.startsWith("https://webhook.site/"));

  // 11. v1.6.25:gist GET 解析失败 → 从空数组起,仍能 PATCH
  let patchedBody2 = null;
  global.fetch = async (url, opts) => {
    if (!opts.method || opts.method === "GET")
      return { ok: true, json: async () => ({ files: { "watchdog.json": { content: "不是 json{{{" } } }) };
    patchedBody2 = JSON.parse(opts.body);
    return { ok: true };
  };
  const gok2 = await wdRelaySend("alert", { ...cfg, wdGistId: "abc123", wdGhPat: "ghp_x" }, mkState([]), "1.6.25", "报错", []);
  ok("坏 gist 内容容错", gok2 === true);
  const evs2 = JSON.parse(patchedBody2.files["watchdog.json"].content).events;
  ok("坏 gist 后只 1 条新事件", evs2.length === 1 && evs2[0].kind === "alert");
  global.fetch = oldFetch;

  console.log(`watchdog-relay: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("EX:", e.message); process.exit(1); });
