"use strict";
/* Variational Auto Trader - 排列熵(Permutation Entropy)入场否决器(v1.2.7)
 *
 * 研究结论(2026-10-04):
 * - 高熵 ≈ 随机游走 → 动量信号容易被 whipsaw,只否决开仓,不产生信号;
 * - 低熵 ≠ 趋势(也可能是规律震荡),方向仍由 d1/d5 阈值把关;
 * - 参数:嵌入维度 m=3(6 种序型,m! << N),τ=1,窗口 60~120 个价格点;
 *   归一化熵 > 0.85~0.9 视为"过噪",跳过开仓。
 * 纯函数,不依赖 chrome.*,可在 service worker 和 node 测试里跑。
 */

const VAT_ENTROPY_M = 3; // 嵌入维度,固定 3(6 种序型)

/** 长度 m 窗口的序型,用 Lehmer 码编码为 0..m!-1(并列按下标先后打破,保证确定性) */
function vatOrdinalCode(win) {
  const m = win.length;
  const idx = win.map((v, i) => i).sort((a, b) => (win[a] - win[b]) || (a - b));
  const rank = new Array(m);
  for (let r = 0; r < m; r++) rank[idx[r]] = r;
  let code = 0;
  for (let i = 0; i < m; i++) {
    let c = 0;
    for (let j = i + 1; j < m; j++) if (rank[j] < rank[i]) c++;
    code = code * (m - i) + c;
  }
  return code;
}

/** 归一化排列熵 ∈ [0,1];0=完全规律,1=完全随机。
 *  点数不足(默认 <12)返回 null——不断言,让调用方决定(策略里=不否决)。 */
function vatPermutationEntropy(values, m, minPoints) {
  m = m || VAT_ENTROPY_M;
  const need = Math.max(minPoints || 12, m + 1);
  if (!values || values.length < need) return null;
  let fact = 1;
  for (let i = 2; i <= m; i++) fact *= i;
  const counts = new Array(fact).fill(0);
  let total = 0;
  for (let i = 0; i + m <= values.length; i++) {
    const win = values.slice(i, i + m);
    let ok = true;
    for (const v of win) if (!Number.isFinite(v)) { ok = false; break; }
    if (!ok) continue;
    counts[vatOrdinalCode(win)]++;
    total++;
  }
  if (!total) return null;
  let h = 0;
  for (const c of counts) {
    if (c > 0) { const p = c / total; h -= p * Math.log(p); }
  }
  return h / Math.log(fact);
}

/** 入场否决判定:返回 {pe, veto, reason}。
 *  开关关闭 / 点数不足 → 不否决(保守:不断言,不拦单)。 */
function vatEntropyVeto(values, cfg) {
  const on = !!(cfg && cfg.entropyFilter);
  const winN = Math.max(12, Math.floor(Number((cfg && cfg.entropyWindow) || 60)));
  const th = Number((cfg && cfg.entropyThreshold) ?? 0.85);
  const pts = (values || []).slice(-winN);
  const pe = vatPermutationEntropy(pts, VAT_ENTROPY_M, 12);
  if (!on || pe == null) return { pe, veto: false, reason: "" };
  if (pe > th) return { pe, veto: true, reason: `熵 ${pe.toFixed(2)}>${th} 市场过噪,跳过开仓` };
  return { pe, veto: false, reason: "" };
}

/* node 测试用 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { VAT_ENTROPY_M, vatOrdinalCode, vatPermutationEntropy, vatEntropyVeto };
}
