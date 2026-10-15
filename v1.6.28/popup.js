"use strict";
/* Variational Auto Trader - 弹窗 */
const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];
const ASSETS = ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI", "BTC", "ETH"];
/* v1.6.10:分交易所标的(与 strategy.js 的 VAT_VENUE_ASSETS 保持一致) */
/* v1.6.17:候选(勾选列表用)与默认选中分开,QFEX 18 个、Arcus 9 个 */
/* v1.6.17:QFEX 候选=用户截图指定的 18 个。前 8 个默认选中。 */
const QFEX_CANDIDATES = [
  "GOLD-USD",
  "SILVER-USD",
  "US100-USD",
  "US500-USD",
  "CL-USD",
  "NVDA-USD",
  "AAPL-USD",
  "TSLA-USD",
  "SNDK-USD",
  "MU-USD",
  "ZM-USD",
  "SOXL-USD",
  "FLEX-USD",
  "TAIEX-USD",
  "CIEN-USD",
  "AMD-USD",
  "COPPER-USD",
  "ALAB-USD"
];

/* v1.6.17:Arcus 候选=用户截图指定的 9 个。 */
const ARCUS_CANDIDATES = [
  "BTC-USD",
  "SPY-USD",
  "ETH-USD",
  "NVDA-USD",
  "QQQ-USD",
  "AAPL-USD",
  "SOL-USD",
  "HYPE-USD",
  "SNDK-USD"
];

const VENUE_ASSET_CANDIDATES = {
  variational: ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI", "BTC", "ETH",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: QFEX_CANDIDATES,
  arcus: ARCUS_CANDIDATES,
};
const VENUE_ASSETS = {
  variational: ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI", "BTC", "ETH",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: ["GOLD-USD", "SILVER-USD", "US100-USD", "US500-USD", "CL-USD", "NVDA-USD", "AAPL-USD", "TSLA-USD"],
  arcus: ["BTC-USD", "ETH-USD"],
};
const VENUE_MAKER_CANDIDATES = {
  variational: ["BTC", "ETH", "XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: QFEX_CANDIDATES,
  arcus: [],
};
const VENUE_MAKER_ASSETS = {
  variational: ["BTC", "ETH", "XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
    "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"],
  qfex: ["GOLD-USD", "SILVER-USD", "US100-USD", "US500-USD", "CL-USD", "NVDA-USD", "AAPL-USD", "TSLA-USD"],
};
const venueCandidates = () => VENUE_ASSETS[activeVenue()] || VENUE_ASSETS.variational;
const venueAssetCandidates = () => VENUE_ASSET_CANDIDATES[activeVenue()] || VENUE_ASSET_CANDIDATES.variational;
const venueMakerCandidates = () => VENUE_MAKER_ASSETS[activeVenue()] || VENUE_MAKER_ASSETS.variational;
const venueMakerAssetCandidates = () => VENUE_MAKER_CANDIDATES[activeVenue()] || VENUE_MAKER_CANDIDATES.variational;
const venueSelectedAssets = () => {
  const v = activeVenue();
  const s = cfg.venueAssets && cfg.venueAssets[v];
  return (Array.isArray(s) && s.length) ? s : (VENUE_ASSETS[v] || []).slice();
};
const venueSelectedMakerAssets = () => {
  const v = activeVenue();
  const s = cfg.venueMakerAssets && cfg.venueMakerAssets[v];
  return (Array.isArray(s) && s.length) ? s : (VENUE_MAKER_ASSETS[v] || []).slice();
};
const MAKER_ASSETS = ["BTC", "ETH", "XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
  "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"]; // v1.6.7:16 个
const MAKER_NOTIONAL_ASSETS = ["XAU", "XAG", "US100", "US500", "UKOIL", "USOIL", "TWI",
  "DXI", "COPP", "CNA50", "GASOL", "USFNG", "COCOA", "VXI"]; // 按 USDC 名义定 size
let cfg = null, state = null, version = "", sessionOkAt = 0, timer = null;
let venueStatus = null, credFormVenue = null; // v1.3.0:多所切换。venueStatus 来自后台 VAT_GET;凭证永不读回展示。
let acctBalance = null; // v1.6.9:QFEX 余额(后台 60s 缓存)

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: "无响应" })));
const n = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toast(msg, cls) { logLine("SYSTEM", msg, cls || "muted"); }

async function refresh() {
  const r = await send({ type: "VAT_GET" });
  if (!r.ok) return;
  cfg = r.config; state = r.state; version = r.version; sessionOkAt = r.sessionOkAt || 0;
  venueStatus = r.venueStatus || null;
  acctBalance = r.balance || null; // v1.6.9
  render();
}

function render() {
  $("#ver").textContent = "v" + version;
  const il = $("#instLabel");
  il.textContent = cfg.label ? `【${cfg.label}】` : "";
  $("#footVer").textContent = "v" + version;
  $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.mode === cfg.mode));
  // v1.3.0:交易所 sec(下拉/状态行/持仓策略/凭证表单)
  renderVenue();
  ["equity", "marginPct", "targetLev", "dailyLossPct", "maxPositions", "maxLosses", "maxTrades", "profitSlippage", "volumeSlippage", "label", "ukoilUnderlying", "initialFunds", "lifetimeSeed", "hedgeSymA", "hedgeSymB", "hedgeLevA", "hedgeLevB"]
    .forEach((id) => { const el = $("#" + id); if (el && document.activeElement !== el) el.value = cfg[id] ?? ""; });
  const sw = $("#liveSwitch");
  sw.classList.toggle("on", !!cfg.liveEnabled);
  const lm = $("#liveMode");
  lm.textContent = cfg.liveEnabled ? "LIVE" : "PAPER";
  lm.className = "live-lock " + (cfg.liveEnabled ? "live" : "paper");
  // v1.2.6:删除连接有效期状态显示——测试连接仅作诊断,不作运行许可;策略常开,异常自动恢复
  const ss = $("#sessStatus");
  ss.textContent = "策略常开｜异常自动恢复";
  ss.className = "status on";
  // 看门狗
  const we = $("#wdEnabled");
  if (we) we.checked = !!cfg.wdEnabled;
  // v1.6.25:看门狗 GitHub gist 中继配置
  const gi = $("#wdGistId"); if (gi) gi.value = cfg.wdGistId || "";
  const gp = $("#wdGhPat"); if (gp) gp.value = cfg.wdGhPat || "";
  // v1.6.3:通用手动代号渲染(对象→"K=V,..."字符串)
  renderManualUnderlyings();
  // 标的:v1.6.10 只显示当前交易所的候选;换所时重建
  const box = $("#assets");
  const vNow = activeVenue();
  if (box && box.dataset.venue !== vNow) {
    box.dataset.venue = vNow;
    box.innerHTML = venueAssetCandidates().map((a) =>
      `<label class="asset"><input type="checkbox" value="${a}"> ${a}</label>`).join("");
    $$("#assets input").forEach((x) => { x.onchange = () => {
      cfg.venueAssets = cfg.venueAssets || {};
      cfg.venueAssets[vNow] = $$("#assets input:checked").map((i) => i.value);
      saveCfg();
    }; });
  }
  if (box) $$("#assets input").forEach((x) => { x.checked = venueSelectedAssets().includes(x.value); });
  // Maker 参数区显隐
  $("#makerSec").style.display = cfg.mode === "maker" ? "" : "none";
  // Hedge 参数区显隐(v1.4.0)
  $("#hedgeSec").style.display = cfg.mode === "hedge" ? "" : "none";
  // Fund/XFund 参数区显隐(v1.6.0)
  $("#fundSec").style.display = cfg.mode === "fund" ? "" : "none";
  $("#xfundSec").style.display = cfg.mode === "xfund" ? "" : "none";
  renderFundPairs(); // v1.6.1:按当前交易所显示可开对子 + 实时 edge
  const mbox = $("#makerAssets");
  const mvNow = activeVenue();
  if (mbox && mbox.dataset.venue !== mvNow) { // v1.6.10:Maker 标的也按所重建
    mbox.dataset.venue = mvNow;
    mbox.innerHTML = venueMakerAssetCandidates().map((a) =>
      `<label class="asset"><input type="checkbox" value="${a}"> ${a}</label>`).join("");
    $$("#makerAssets input").forEach((x) => x.onchange = () => {
      cfg.venueMakerAssets = cfg.venueMakerAssets || {};
      cfg.venueMakerAssets[mvNow] = $$("#makerAssets input:checked").map((i) => i.value);
      saveCfg(); renderMakerSizeGrid(true);
    });
  }
  if (mbox) $$("#makerAssets input").forEach((x) => { x.checked = venueSelectedMakerAssets().includes(x.value); });
  renderMakerSizeGrid();
  setNum("#makerMinDelay", cfg.makerMinDelay); setNum("#makerMaxDelay", cfg.makerMaxDelay);
  setNum("#makerPriceOffsetBp", (cfg.makerPriceOffset || 0) * 10000);
  setNum("#makerMonitorSecs", cfg.makerMonitorSecs); setNum("#makerMaxHoldSecs", cfg.makerMaxHoldSecs);
  setNum("#makerTpPct", (cfg.makerTpPct || 0) * 100); setNum("#makerSlPct", (cfg.makerSlPct || 0) * 100);
  setNum("#makerMaxVolPct", (cfg.makerMaxVolPct || 0) * 100);
  setNum("#makerSlippage", cfg.makerSlippage);
  const ma = $("#makerAlternate");
  if (ma && document.activeElement !== ma) ma.checked = !!cfg.makerAlternate;
  // v1.2.7:熵否决
  setNum("#entropyThreshold", cfg.entropyThreshold);
  setNum("#entropyWindow", cfg.entropyWindow);
  const ef = $("#entropyFilter");
  if (ef && document.activeElement !== ef) ef.checked = !!cfg.entropyFilter;
  // 运行态
  $("#startBtn").disabled = cfg.armed;
  $("#stopBtn").disabled = !cfg.armed;
  $("#startBtn").textContent = cfg.armed ? "运行中" : (cfg.liveEnabled ? "▶ 启动 LIVE 实盘" : "▶ 启动 PAPER 模拟");
  const rs = $("#runState");
  rs.textContent = cfg.armed ? (cfg.liveEnabled ? "LIVE 运行中:满足信号会真实下单" : "PAPER 运行中:只模拟,不下单") : "已停止";
  rs.style.color = cfg.armed ? (cfg.liveEnabled ? "#f87171" : "#34d399") : "#8b93a7";
  // 市场( maker 模式显示 makerAssets )
  const mktAssets = cfg.mode === "maker" ? venueSelectedMakerAssets() : venueSelectedAssets(); // v1.6.10:只显示当前所
  const tb = $("#mktBody");
  tb.innerHTML = mktAssets.map((a) => {
    const m = (state.markets || {})[a] || {};
    const pos = (state.positions || {})[a];
    const st = pos ? (cfg.liveEnabled && !pos.paper ? "live_open" : "paper_open") : (m.status || "monitoring");
    const reason = pos
      ? `${pos.side.toUpperCase()} ${pos.qty} 入场${m.mark ? ` 现价${fmtP(m.mark)}` : ""}`
      : esc((m.reason || statusText(m.status)) + (m.entropy != null ? ` [熵${Number(m.entropy).toFixed(2)}]` : ""));
    return `<tr><td><b>${a}</b></td><td class="num">${m.mark ? fmtP(m.mark) : "-"}</td>` +
      `<td class="num">${m.spread != null ? m.spread.toFixed(2) : "-"}</td>` +
      `<td class="num">${m.d1 != null ? m.d1.toFixed(1) : "-"}</td>` +
      `<td class="num">${m.d5 != null ? m.d5.toFixed(1) : "-"}</td>` +
      `<td><span class="st ${st}">${statusText(st)}</span><br><span class="hint">${reason}</span></td></tr>`;
  }).join("") || `<tr><td colspan="6" class="hint">未选择标的</td></tr>`;
  // 统计
  const s = state.stats || {};
  const pnlEl = $("#sPnl");
  pnlEl.textContent = (s.pnl >= 0 ? "+" : "") + (s.pnl || 0).toFixed(2) + "U";
  pnlEl.className = s.pnl >= 0 ? "pos" : "neg";
  $("#sTrades").textContent = s.trades || 0;
  $("#sWins").textContent = s.wins || 0;
  $("#sLosses").textContent = s.losses || 0;
  $("#sTurn").textContent = Math.round(s.turnover || 0);
  // v1.6.2:当前模式统计(自切换起)
  const ms = state.modeStats || {};
  const modeName = { profit: "Profit", volume: "Volume", maker: "Maker", hedge: "Hedge", fund: "Fund", xfund: "XFund" }[ms.mode] || ms.mode || "-";
  const mPnlEl = $("#mPnl");
  if (mPnlEl) {
    mPnlEl.textContent = ((ms.pnl || 0) >= 0 ? "+" : "") + (ms.pnl || 0).toFixed(2) + "U";
    mPnlEl.className = (ms.pnl || 0) >= 0 ? "pos" : "neg";
    $("#mMode").textContent = modeName;
    $("#mSince").textContent = ms.since ? new Date(ms.since).toLocaleTimeString("zh-CN", { hour12: false }) : "-";
    $("#mTrades").textContent = ms.trades || 0;
    $("#mWins").textContent = ms.wins || 0;
    $("#mLosses").textContent = ms.losses || 0;
  }
  // v1.6.7:跨天累计已实现 + 初始资金/估算净值
  const lt = state.lifetime || {};
  const ltReal = (lt.realizedPnl || 0) + (cfg.lifetimeSeed || 0);
  const ltFunds = cfg.initialFunds || 0;
  const lPnlEl = $("#lPnl");
  if (lPnlEl) {
    lPnlEl.textContent = (ltReal >= 0 ? "+" : "") + ltReal.toFixed(2) + "U";
    lPnlEl.className = ltReal >= 0 ? "pos" : "neg";
    $("#lFunds").textContent = Math.round(ltFunds);
    $("#lTrades").textContent = lt.trades || 0;
    $("#lSince").textContent = lt.startedAt ? new Date(lt.startedAt).toLocaleDateString("zh-CN") : "-";
    $("#lEquity").textContent = Math.round(ltFunds + ltReal);
  }
  // v1.6.9:QFEX 余额行(有值才显示)
  try {
    const balRow = $("#balRow");
    if (balRow) {
      if (acctBalance && (acctBalance.equity != null || acctBalance.available != null)) {
        balRow.style.display = "";
        const eq = acctBalance.equity != null ? Math.round(acctBalance.equity) + "U" : "-";
        const av = acctBalance.available != null ? Math.round(acctBalance.available) + "U" : "-";
        $("#lBal").textContent = `权益${eq}/可用${av}`;
        const bh = $("#balHint");
        if (bh) bh.textContent = "余额为交易所实时值";
      } else { balRow.style.display = "none"; }
    }
  } catch (_) {}
  // 日志
  const lg = $("#logs");
  lg.innerHTML = (state.logs || []).slice(0, 40).map((x) =>
    `<div class="log ${x.level}"><span class="t">${new Date(x.t).toLocaleTimeString("zh-CN", { hour12: false })}</span><span class="a">${esc(x.asset)}</span>${esc(x.msg)}</div>`
  ).join("");
}

function fmtP(p) { return Number(p) >= 100 ? Number(p).toFixed(2) : Number(p).toFixed(4); }
function setNum(sel, v) {
  const el = $(sel);
  if (el && document.activeElement !== el) el.value = v ?? "";
}
/* v1.6.1:Fund 按当前交易所显示可开对子 + 实时 edge(来自 state.fund.lastScan)。
 * 对子来源与 strategy_fund.js 的 fundCfg 一致:cfg.fundPairsByVenue[venue] > cfg.fundPairs > 内置默认。 */
const FUND_PAIRS_BUILTIN = { variational: [{ a: "USOIL-SWAP", b: "CL-PERP" }] };
function renderFundPairs() {
  const box = $("#fundPairs");
  if (!box) return;
  const venue = (cfg && cfg.activeVenue) || "variational";
  const byVenue = (cfg && cfg.fundPairsByVenue) || {};
  let pairs = (byVenue[venue] && byVenue[venue].length) ? byVenue[venue]
    : (cfg.fundPairs && cfg.fundPairs.length) ? cfg.fundPairs
    : (FUND_PAIRS_BUILTIN[venue] || []);
  const scan = state && state.fund && state.fund.lastScan;
  const useScan = scan && scan.venue === venue;
  const edgeMap = {};
  if (useScan) for (const p of scan.pairs || []) edgeMap[p.a + "|" + p.b] = p;
  let html = `<div class="hint" style="margin-top:4px">当前交易所：${esc(venue)}</div>`;
  if (!pairs.length) {
    html += `<div class="hint">该所暂无配置对子（不下单）。</div>`;
    if (useScan && scan.discover && scan.discover.length) {
      html += `<div class="hint">费率扫描 Top：` +
        scan.discover.map((r) => `${esc(r.sym)} ${(n(r.rate) * 100).toFixed(2)}%`).join(" / ") + `</div>`;
    } else if (useScan) {
      html += `<div class="hint">费率扫描：该所无可用费率数据。</div>`;
    }
  } else {
    html += pairs.map((p) => {
      const e = edgeMap[p.a + "|" + p.b];
      const extra = e && e.edge != null
        ? `｜edge=${(n(e.edge) * 100).toFixed(2)}%${e.dir ? "（做多 " + esc(e.dir) + "）" : ""} [${esc(e.state)}]`
        : "";
      return `<div class="hint">对子：${esc(p.a)} / ${esc(p.b)}${extra}</div>`;
    }).join("");
  }
  box.innerHTML = html;
}
/** Maker size 输入区:BTC/ETH 按币数量,TradFi 按 USDC 名义 */
function renderMakerSizeGrid(force) {
  const grid = $("#makerSizeGrid");
  if (!grid) return;
  const gvNow = activeVenue();
  const mAssets = venueSelectedMakerAssets(); // v1.6.16:size 网格只给已选中的 maker 标的建输入,避免 QFEX 221 个候选一次渲染 442 个输入框
  const isNotion = (a) => gvNow === "qfex" ? true : MAKER_NOTIONAL_ASSETS.includes(a); // v1.6.10:QFEX 全按名义
  if (force || grid.dataset.venue !== gvNow) { // v1.6.10:换所重建
    grid.dataset.venue = gvNow;
    grid.innerHTML = mAssets.map((a) => {
      const notion = isNotion(a);
      const unit = notion ? "名义(USDC)" : "数量(币)";
      const step = notion ? "1" : (a === "BTC" ? "0.0001" : "0.001");
      return `<div class="field"><label>${a} 最小 ${unit}</label><input id="mksz_${a}_0" type="number" step="${step}" min="0"></div>` +
        `<div class="field"><label>${a} 最大 ${unit}</label><input id="mksz_${a}_1" type="number" step="${step}" min="0"></div>`;
    }).join("");
    mAssets.forEach((a) => {
      const notion = isNotion(a);
      [0, 1].forEach((i) => {
        $(`#mksz_${a}_${i}`).onchange = (e) => {
          const key = notion ? "makerNotionals" : "makerSizes";
          const dflt = notion ? [10, 30] : (a === "BTC" ? [0.001, 0.003] : [0.03, 0.06]);
          cfg[key] = cfg[key] || {};
          const cur = cfg[key][a] || dflt.slice();
          cur[i] = n(e.target.value, cur[i]);
          cfg[key][a] = cur; saveCfg();
        };
      });
    });
  }
  const ms = cfg.makerSizes || {}, mn = cfg.makerNotionals || {};
  mAssets.forEach((a) => {
    const arr = isNotion(a) ? (mn[a] || []) : (ms[a] || []);
    setNum(`#mksz_${a}_0`, arr[0]); setNum(`#mksz_${a}_1`, arr[1]);
  });
}
function statusText(st) {
  return { monitoring: "监控中", warming: "预热中", no_signal: "无信号", cooldown: "冷却中",
    paper_open: "PAPER持仓", live_open: "LIVE持仓", in_position: "持仓中",
    maker_wait: "等挂单", maker_pending: "等成交", maker_timeout: "超时已撤",
    maker_vol_skip: "波动跳过", no_quote: "无报价",
    entropy_skip: "熵过噪跳过",
    position_limit: "达持仓上限", loss_circuit: "连续亏损熔断", trade_limit: "达开仓上限", order_blocked: "下单被拒停手",
    daily_loss_limit: "日亏损熔断", error: "错误", order_fail: "下单失败",
    rejected: "被拒", size_fail: "数量校验失败", resolve_fail: "标的解析失败", no_mark: "无行情" }[st] || st || "-";
}

/* v1.3.0:交易所 sec(多所切换+凭证+持仓策略)。静态注册表 + 后台 venueStatus 合并渲染。 */
function activeVenue() { return (venueStatus && venueStatus.activeVenue) || "variational"; }
function venueInfo(id) {
  const reg = (typeof VAT_VENUES !== "undefined" ? VAT_VENUES : []).find((v) => v.id === id) || {};
  const st = (venueStatus && venueStatus.list || []).find((v) => v.id === id) || {};
  return { id, name: st.name || reg.name || id, status: st.status || reg.status || "live",
    authType: st.authType || reg.authType || "api-key", notes: st.notes || reg.notes || "",
    configured: !!st.configured, running: !!st.running };
}
function venueLabel(v) {
  if (v.status === "waitlist") return `${v.name}（waitlist，未开放）`;
  if (v.status === "unsupported") return `${v.name}（不支持：条款禁止自动化交易）`;
  return v.name;
}
function venueBadge(v) {
  if (v.status === "unsupported") return `<span class="badge err">不支持</span>`;
  if (v.status === "waitlist") return `<span class="badge mut">waitlist</span>`;
  if (v.running) return `<span class="badge ok">运行中</span>`;
  if (v.configured) return `<span class="badge warn">连接中</span>`;
  return `<span class="badge mut">未配置</span>`;
}
function renderVenue() {
  const venues = (typeof VAT_VENUES !== "undefined" ? VAT_VENUES : []).map((v) => venueInfo(v.id));
  const act = activeVenue();
  // 下拉框:只建一次(waitlist/unsupported 置灰)
  const sel = $("#venueSelect");
  if (sel && !sel.options.length) {
    sel.innerHTML = venues.map((v) => {
      const dis = (v.status === "waitlist" || v.status === "unsupported") ? " disabled" : "";
      return `<option value="${esc(v.id)}"${dis}>${esc(venueLabel(v))}</option>`;
    }).join("");
  }
  if (sel && document.activeElement !== sel) sel.value = act;
  // 每所状态行
  const box = $("#venueList");
  if (box) box.innerHTML = venues.map((v) => // v1.6.18:只显示名称+配置状态徽章,不再显示介绍文字
    `<div class="vrow"><b>${esc(v.name)}</b>${venueBadge(v)}</div>`).join("");
  // 切换持仓策略三选一(默认 remind)
  const pol = (cfg.venuePolicy && cfg.venuePolicy.onSwitch) || "remind";
  $$('input[name="vpol"]').forEach((r) => { if (document.activeElement !== r) r.checked = r.value === pol; });
  // 凭证表单:只在切换所时重建,避免 3 秒刷新打断密钥输入
  if (credFormVenue !== act) { renderCredForm(venueInfo(act)); credFormVenue = act; }
}
function renderCredForm(v) {
  const box = $("#credForm");
  if (!box) return;
  const secHint = `<div class="hint" style="margin-top:6px">密钥只存本机 chrome.storage.local，绝不随心跳/报警外发</div>`;
  let html = `<h2 style="margin-bottom:6px">${esc(v.name)} · 凭证</h2>`;
  if (v.authType === "browser-session") {
    html += `<div class="row"><span class="hint">浏览器登录态，无需配置</span>` +
      `<button class="ghost" id="venueTestBtn">测试连接</button></div>` + secHint;
  } else if (v.authType === "api-key" && v.id === "lighter") {
    html += `<div class="grid" style="grid-template-columns:1fr 1fr">` +
      `<div class="field" style="grid-column:1/3"><label>API 私钥(只存本机,绝不回显)</label>` +
      `<input id="vc_priv" type="password" autocomplete="off" placeholder="0x..."></div>` +
      `<div class="field"><label>account_index</label><input id="vc_acct" type="number" min="0"></div>` +
      `<div class="field"><label>keyIndex</label><input id="vc_key" type="number" min="0"></div></div>` +
      `<div class="row" style="margin-top:8px"><button class="ghost" id="venueSaveBtn">保存(只存本机)</button></div>` + secHint;
  } else if (v.authType === "api-key" && v.id === "qfex") {
    html += `<div class="field" style="margin-bottom:8px"><label>apiKey(只存本机,绝不回显)</label>` +
      `<input id="vc_keyid" type="password" autocomplete="off"></div>` +
      `<div class="field" style="margin-bottom:8px"><label>apiSecret(只存本机,绝不回显)</label>` +
      `<input id="vc_secret" type="password" autocomplete="off"></div>` +
      `<div class="row" style="margin-bottom:8px"><label class="asset"><input type="checkbox" id="vc_uat"> 使用 UAT 测试环境</label></div>` +
      `<div class="row"><button class="ghost" id="venueSaveBtn">保存(只存本机)</button>` +
      `<button class="ghost" id="qfexProbeBtn" style="margin-left:8px">QFEX 探测(持仓/余额字段映射用)</button></div>` + secHint;
  } else if (v.authType === "api-key" && v.id === "arcus") {
    html += `<div class="field" style="margin-bottom:8px"><label>钱包地址(0x...)</label>` +
      `<input id="vc_addr" type="text" autocomplete="off" placeholder="0x..."></div>` +
      `<div class="field" style="margin-bottom:8px"><label>API Signing Key(Ed25519,后端生成,非钱包私钥,只存本机,绝不回显)</label>` +
      `<input id="vc_signkey" type="password" autocomplete="off" placeholder="64位hex"></div>` +
      `<div class="field" style="margin-bottom:8px"><label>子账户编号 account_index</label>` +
      `<input id="vc_sub" type="number" min="0" value="0"></div>` +
      `<div class="row" style="margin-bottom:8px"><label class="asset"><input type="checkbox" id="vc_testnet"> 使用测试网(testnet)</label></div>` +
      `<div class="row"><button class="ghost" id="venueSaveBtn">保存(只存本机)</button></div>` + secHint;
  } else if (v.authType === "agent-wallet") {
    html += `<div class="field" style="margin-bottom:8px"><label>agent 私钥(只存本机,绝不回显)</label>` +
      `<input id="vc_agent" type="password" autocomplete="off" placeholder="0x..."></div>` +
      `<div class="row" style="margin-bottom:8px"><label class="asset"><input type="checkbox" id="vc_testnet"> 使用测试网</label></div>` +
      `<div class="hint" style="margin-bottom:8px">agent 只可交易不可提款</div>` +
      `<div class="row"><button class="ghost" id="venueSaveBtn">保存(只存本机)</button></div>` + secHint;
  } else {
    html += `<div class="hint">${esc(v.notes)}</div>`;
  }
  box.innerHTML = html;
  bindCredForm(v);
}
/** 凭证表单内的动态按钮。输入框重建后永远是空的:已保存的密钥绝不回显。 */
function bindCredForm(v) {
  const tb = $("#venueTestBtn");
  if (tb) tb.onclick = async () => {
    toast(`正在测试 ${v.name} 连接...`, "warn");
    const r = await send({ type: "VAT_TEST_VENUE", venue: v.id });
    toast(r.ok ? `${v.name} 连接正常` : `连接失败: ${r.error}`, r.ok ? "ok" : "err");
    refresh();
  };
  // v1.6.8:QFEX 实测探测(持仓/余额原始字段→日志,用户贴回给 Muse 做映射)
  const pb = $("#qfexProbeBtn");
  if (pb) pb.onclick = async () => {
    toast("QFEX 探测中(约30秒,含出口IP+UAT对照)...", "warn");
    const r = await send({ type: "VAT_PROBE_QFEX" });
    toast(r.ok ? "探测完成,看日志里「结论」那条(4选1),贴给 Muse" : `探测失败: ${r.error}`, r.ok ? "ok" : "err");
    refresh();
  };
  const sv = $("#venueSaveBtn");
  if (sv) sv.onclick = async () => {
    const creds = {};
    if (v.id === "lighter") {
      creds.privateKey = $("#vc_priv").value.trim();
      creds.accountIndex = n($("#vc_acct").value, 0);
      creds.keyIndex = n($("#vc_key").value, 0);
      if (!creds.privateKey) { toast("请填写 API 私钥", "err"); return; }
    } else if (v.id === "qfex") {
      creds.apiKey = $("#vc_keyid").value.trim();
      creds.apiSecret = $("#vc_secret").value.trim();
      creds.useUat = !!$("#vc_uat").checked;
      if (!creds.apiKey || !creds.apiSecret) { toast("请填写 apiKey 与 apiSecret", "err"); return; }
    } else if (v.id === "arcus") {
      creds.walletAddress = $("#vc_addr").value.trim();
      creds.apiSigningKey = $("#vc_signkey").value.trim();
      creds.accountIndex = n($("#vc_sub").value, 0);
      creds.useTestnet = !!$("#vc_testnet").checked;
      if (!creds.walletAddress || !creds.apiSigningKey) { toast("请填写钱包地址与 API Signing Key", "err"); return; }
    } else if (v.id === "entropy") {
      creds.agentPrivateKey = $("#vc_agent").value.trim();
      creds.useTestnet = !!$("#vc_testnet").checked;
      if (!creds.agentPrivateKey) { toast("请填写 agent 私钥", "err"); return; }
    }
    const r = await send({ type: "VAT_SAVE_VENUE_CREDS", venue: v.id, creds });
    if (r.ok) {
      toast("凭证已保存(只存本机 chrome.storage.local)", "ok");
      renderCredForm(v); // 清空输入框,绝不回显
    } else { toast(`保存失败: ${r.error}`, "err"); }
    refresh();
  };
}

function logLine(asset, msg, cls) {
  const lg = $("#logs");
  const d = document.createElement("div");
  d.className = "log " + (cls || "muted");
  d.innerHTML = `<span class="t">${new Date().toLocaleTimeString("zh-CN", { hour12: false })}</span><span class="a">${esc(asset)}</span>${esc(msg)}`;
  lg.prepend(d);
}

async function saveCfg() { await send({ type: "VAT_SAVE_CONFIG", config: cfg }); render(); }

function buildErrorReport() {
  const L = [];
  L.push("## Variational 自动交易错误报告");
  L.push(`- 版本: v${version}`);
  L.push(`- 时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  L.push(`- 备注: ${cfg.label || "(未设)"}`);
  L.push(`- 交易所: ${activeVenue()}`);
  L.push(`- 模式: ${cfg.mode} / ${cfg.liveEnabled ? "LIVE" : "PAPER"} / 运行中:${!!cfg.armed} / 探活:每6分钟(不限时)`);
  const repAssets = cfg.mode === "maker" ? venueSelectedMakerAssets() : venueSelectedAssets(); // v1.6.10
  L.push(`- 标的: ${repAssets.join(",")}`);
  if (cfg.mode === "maker") {
    const ms = cfg.makerSizes || {}, mn = cfg.makerNotionals || {};
    const sz = Object.keys(ms).map((k) => `${k}[${(ms[k] || []).join("-")}币]`).join(" ");
    const nz = Object.keys(mn).map((k) => `${k}[${(mn[k] || []).join("-")}U]`).join(" ");
    L.push(`- Maker: 延迟${cfg.makerMinDelay}-${cfg.makerMaxDelay}s 偏移${(cfg.makerPriceOffset * 10000).toFixed(1)}bp ` +
      `等成交${cfg.makerMonitorSecs}s 持仓${cfg.makerMaxHoldSecs}s TP${(cfg.makerTpPct * 100).toFixed(1)}%/SL${(cfg.makerSlPct * 100).toFixed(1)}% ` +
      `size ${sz} ${nz} 交替:${!!cfg.makerAlternate}`);
  }
  L.push("");
  L.push("### 各标的状态");
  for (const a of repAssets) {
    const m = (state.markets || {})[a] || {};
    const pos = (state.positions || {})[a];
    L.push(`- ${a}: ${statusText(pos ? "in_position" : m.status)}${m.reason ? " | " + m.reason : ""}${m.mark ? ` | mark=${m.mark}` : ""}${pos ? ` | ${pos.side} ${pos.qty} @${pos.entry}` : ""}`);
  }
  L.push("");
  const s = state.stats || {};
  L.push(`### 今日统计: PnL ${(s.pnl || 0).toFixed(2)}U, 开仓 ${s.trades || 0}, 胜 ${s.wins || 0} / 负 ${s.losses || 0}, 连亏 ${s.stats?.consecutiveLosses ?? s.consecutiveLosses ?? 0}`);
  const ms = state.modeStats || {};
  if (ms.mode) L.push(`### 当前模式(${ms.mode},自${ms.since ? new Date(ms.since).toLocaleTimeString("zh-CN", { hour12: false }) : "-"}起): PnL ${(ms.pnl || 0).toFixed(2)}U, 开仓 ${ms.trades || 0}, 胜 ${ms.wins || 0} / 负 ${ms.losses || 0}`);
  // v1.6.7:累计统计(跨天不清零)
  const lt0 = state.lifetime || {};
  const ltReal0 = (lt0.realizedPnl || 0) + (cfg.lifetimeSeed || 0);
  L.push(`### 累计统计: 初始资金 ${Math.round(cfg.initialFunds || 0)}U, 累计已实现 ${ltReal0 >= 0 ? "+" : ""}${ltReal0.toFixed(2)}U, 开仓 ${lt0.trades || 0}, 估算净值 ${Math.round((cfg.initialFunds || 0) + ltReal0)}U(不含未实现/费率/手续费)` +
    (acctBalance && (acctBalance.equity != null || acctBalance.available != null)
      ? `, QFEX余额 权益${Math.round(acctBalance.equity || 0)}U/可用${Math.round(acctBalance.available || 0)}U` : ""));
  L.push("");
  L.push("### 最近日志(脱敏,无 Cookie)");
  for (const x of (state.logs || []).slice(0, 20)) {
    L.push(`- [${new Date(x.t).toLocaleTimeString("zh-CN", { hour12: false })}] ${x.asset} ${x.msg}`);
  }
  return L.join("\n");
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove(); return ok;
  }
}

/** v1.6.3:通用手动代号,格式 XAU=XAUS,US100=US100S(逗号/空格分隔),留空=自动解析 */
function renderManualUnderlyings() {
  const el = $("#manualUnderlyings");
  if (el && document.activeElement !== el) {
    const m = cfg.manualUnderlyings || {};
    el.value = Object.keys(m).map((k) => k + "=" + m[k]).join(",");
  }
}
function bind() {
  $$(".tab").forEach((x) => x.onclick = () => { cfg.mode = x.dataset.mode; saveCfg(); toast(`切换到 ${x.dataset.mode}`, "ok"); });
  ["equity", "marginPct", "targetLev", "dailyLossPct", "maxPositions", "maxLosses", "maxTrades", "profitSlippage", "volumeSlippage", "initialFunds", "lifetimeSeed"]
    .forEach((id) => $("#" + id).onchange = (e) => { cfg[id] = n(e.target.value, cfg[id]); saveCfg(); });
  $("#label").onchange = (e) => { cfg.label = e.target.value.trim().slice(0, 20); saveCfg(); };
  $("#ukoilUnderlying").onchange = (e) => { cfg.ukoilUnderlying = e.target.value.trim().toUpperCase().slice(0, 12); saveCfg(); };
  // v1.6.19:Hedge 对子配置
  $("#hedgeSymA").onchange = (e) => { cfg.hedgeSymA = e.target.value.trim().toUpperCase().slice(0, 16); saveCfg(); };
  $("#hedgeSymB").onchange = (e) => { cfg.hedgeSymB = e.target.value.trim().toUpperCase().slice(0, 16); saveCfg(); };
  ["hedgeLevA", "hedgeLevB"].forEach((id) => $("#" + id).onchange = (e) => { cfg[id] = n(e.target.value, 0); saveCfg(); });
  // v1.6.3:通用手动代号,格式 XAU=XAUS,US100=US100S(逗号/空格分隔),留空=自动解析
  $("#manualUnderlyings").onchange = (e) => {
    const m = {};
    String(e.target.value || "").split(/[,\s;]+/).forEach((p) => {
      const kv = p.split("=");
      if (kv.length === 2 && kv[0].trim() && kv[1].trim())
        m[kv[0].trim().toUpperCase()] = kv[1].trim().toUpperCase().slice(0, 12);
    });
    cfg.manualUnderlyings = m; saveCfg(); renderManualUnderlyings();
  };
  $("#makerMinDelay").onchange = (e) => { cfg.makerMinDelay = n(e.target.value, cfg.makerMinDelay); saveCfg(); };
  $("#makerMaxDelay").onchange = (e) => { cfg.makerMaxDelay = n(e.target.value, cfg.makerMaxDelay); saveCfg(); };
  $("#makerPriceOffsetBp").onchange = (e) => { cfg.makerPriceOffset = n(e.target.value, 1) / 10000; saveCfg(); };
  $("#makerMonitorSecs").onchange = (e) => { cfg.makerMonitorSecs = n(e.target.value, cfg.makerMonitorSecs); saveCfg(); };
  $("#makerMaxHoldSecs").onchange = (e) => { cfg.makerMaxHoldSecs = n(e.target.value, cfg.makerMaxHoldSecs); saveCfg(); };
  $("#makerTpPct").onchange = (e) => { cfg.makerTpPct = n(e.target.value, 10) / 100; saveCfg(); };
  $("#makerSlPct").onchange = (e) => { cfg.makerSlPct = n(e.target.value, -5) / 100; saveCfg(); };
  $("#makerMaxVolPct").onchange = (e) => { cfg.makerMaxVolPct = n(e.target.value, 0.3) / 100; saveCfg(); };
  $("#makerSlippage").onchange = (e) => { cfg.makerSlippage = n(e.target.value, cfg.makerSlippage); saveCfg(); };
  $("#makerAlternate").onchange = (e) => { cfg.makerAlternate = !!e.target.checked; saveCfg(); };
  // v1.2.7:熵否决
  $("#entropyThreshold").onchange = (e) => { cfg.entropyThreshold = Math.min(1, Math.max(0, n(e.target.value, 0.85))); saveCfg(); };
  $("#entropyWindow").onchange = (e) => { cfg.entropyWindow = Math.max(12, Math.floor(n(e.target.value, 60))); saveCfg(); };
  $("#entropyFilter").onchange = (e) => { cfg.entropyFilter = !!e.target.checked; saveCfg(); };
  $("#liveSwitch").onclick = () => {
    if (!cfg.liveEnabled) {
      if (!confirm("开启 LIVE 后,满足信号会发送真实市价单。确认开启?")) return;
      cfg.liveEnabled = true; toast("LIVE 已解锁", "err");
    } else { cfg.liveEnabled = false; toast("已切回 PAPER", "ok"); }
    saveCfg();
  };
  $("#testBtn").onclick = async () => {
    toast("正在测试连接(仅诊断,不影响运行)...", "warn");
    const r = await send({ type: "VAT_TEST" });
    if (r.ok) { toast(`连接正常,可读持仓 ${r.positions} 条(仅诊断)`, "ok"); }
    else toast(`连接测试失败: ${r.error}`, "err");
    refresh();
  };
  $("#probeBtn").onclick = async () => {
    toast("正在探测各标的询价(只询价不下单)...", "warn");
    const r = await send({ type: "VAT_PROBE_QUOTE" });
    if (!r || !r.ok) { toast(`探测失败: ${(r && r.error) || "未知"}`, "err"); return; }
    const lines = Object.entries(r.probes || {}).map(([a, p]) => {
      const rs = p.results || [];
      const okN = rs.filter((x) => x.ok).length;
      const tick = (rs.find((x) => x.ok && x.tick) || {}).tick;
      return `${a}: ${okN}/${rs.length}通过${tick ? `,精度${tick}` : ""}`;
    });
    toast(lines.join(" | ") || "无标的", "ok");
    refresh();
  };
  $("#startBtn").onclick = async () => {
    // v1.2.6:启动不再要求"10分钟内测过连接";测试连接仅作诊断。LIVE 启动时后台仍会做一次真实活检(人在场)。
    if (cfg.liveEnabled) {
      if (!confirm(`将以 ${cfg.mode.toUpperCase()} 模式启动 LIVE 自动交易,确认?`)) return;
    }
    const r = await send({ type: "VAT_START", config: cfg });
    toast(r.ok ? "已启动" : `启动失败: ${r.error}`, r.ok ? "ok" : "err");
    refresh();
  };
  $("#stopBtn").onclick = async () => { await send({ type: "VAT_STOP" }); toast("已停止", "warn"); refresh(); };
  $("#restartBtn").onclick = async () => {
    if (!confirm("重启将中断当前轮次并重建连接，确认？")) return;
    const r = await send({ type: "VAT_RESTART" });
    toast(r.ok ? "已发送重启,策略将重建连接" : `重启失败: ${r.error}`, r.ok ? "ok" : "err");
    refresh();
  };
  $("#panicBtn").onclick = async () => {
    if (!confirm("紧急停止:不再开新仓,已有仓位请手动处理。继续?")) return;
    await send({ type: "VAT_PANIC" }); toast("已紧急停止所有策略", "err"); refresh();
  };
  $("#copyReport").onclick = async () => {
    const ok = await copyText(buildErrorReport());
    toast(ok ? "错误报告已复制" : "复制失败,请手动选择", ok ? "ok" : "err");
  };
  $("#wdEnabled").onchange = (e) => { cfg.wdEnabled = !!e.target.checked; saveCfg(); };
  // v1.6.25:看门狗 gist 中继配置保存
  $("#wdGistId").onchange = (e) => { cfg.wdGistId = String(e.target.value || "").trim(); saveCfg(); };
  $("#wdGhPat").onchange = (e) => { cfg.wdGhPat = String(e.target.value || "").trim(); saveCfg(); };
  // v1.3.0:交易所切换 + 切换持仓策略三选一
  $("#venueSelect").onchange = async (e) => {
    const nv = e.target.value;
    const r = await send({ type: "VAT_SET_VENUE", venue: nv });
    if (r.ok) {
      toast(`交易所切换: ${r.detail || r.action}`, "ok");
      if (r.action === "remind") toast("旧所持仓未动，请手动处理", "warn");
      credFormVenue = null; // 下轮 render 重建新所凭证表单
    } else {
      toast(`切换失败: ${r.error}`, "err");
      e.target.value = activeVenue();
    }
    refresh();
  };
  $$('input[name="vpol"]').forEach((r) => r.onchange = (e) => {
    cfg.venuePolicy = Object.assign({}, cfg.venuePolicy, { onSwitch: e.target.value });
    saveCfg();
    toast(`切换持仓策略: ${{ keep: "旧所持仓留着不管", close: "切换前自动平掉旧所全部持仓", remind: "只提醒手动处理" }[e.target.value]}`, "muted");
  });  $("#wdTestBtn").onclick = async () => {
    toast("正在发送测试报警...", "warn");
    const r = await send({ type: "VAT_WD_TEST" });
    toast(r.ok ? "测试已发送,Muse 那边能收到就说明链路通" : `发送失败: ${r.error}`, r.ok ? "ok" : "err");
    refresh();
  };
}

document.addEventListener("DOMContentLoaded", async () => { bind(); await refresh(); timer = setInterval(refresh, 3000); });
