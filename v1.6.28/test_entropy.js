"use strict";
/* v1.2.7 回归:排列熵入场否决(Entropy veto)
 * 1. 序型编码:单调增→0,单调减→5(m=3 时最大码),全相等→0(并列按下标打破)
 * 2. 归一化熵:单调/常数→0,规律震荡→低,伪随机→高(>0.85)
 * 3. 点数不足→null;NaN 窗口跳过;全 NaN→null
 * 4. 否决逻辑:开+高熵→否决;开+低熵→放行;关+高熵→放行;阈值 1→放行
 * 5. 集成:vatProcessAsset 里高熵时不开仓(status=entropy_skip)+记录熵值;关闭开关后正常开 PAPER 仓
 * 6. 默认配置:entropyFilter=true, entropyWindow=60, entropyThreshold=0.85 */
const S = require("./strategy.js");
const E = require("./entropy.js");
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

let now = 1_700_000_000_000;
// 确定性伪随机(LCG),保证测试可重复
let _s = 12345;
const rnd = () => (_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

(async () => {
  // ===== 1. 序型编码 =====
  ok("单调增序型=0", E.vatOrdinalCode([1, 2, 3]) === 0);
  ok("单调减序型=5", E.vatOrdinalCode([3, 2, 1]) === 5);
  ok("全相等并列=0", E.vatOrdinalCode([2, 2, 2]) === 0);
  ok("编码范围 0..5", (() => { const c = E.vatOrdinalCode([2, 1, 3]); return c >= 0 && c <= 5; })());

  // ===== 2. 归一化熵 =====
  const mono = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
  ok("单调序列熵=0", E.vatPermutationEntropy(mono) === 0);
  ok("常数序列熵=0", E.vatPermutationEntropy(new Array(60).fill(7)) === 0);
  const alt = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 100 : 101));
  const peAlt = E.vatPermutationEntropy(alt);
  ok("规律震荡熵低(<0.5)", peAlt != null && peAlt < 0.5);
  _s = 12345;
  const noisy = Array.from({ length: 300 }, () => rnd() * 100);
  const peNoise = E.vatPermutationEntropy(noisy);
  ok("伪随机序列熵高(>0.85)", peNoise != null && peNoise > 0.85);

  // ===== 3. 边界 =====
  ok("点数不足返回 null", E.vatPermutationEntropy([1, 2, 3, 4, 5]) === null);
  ok("空数组返回 null", E.vatPermutationEntropy([]) === null);
  const withNaN = [1, 2, NaN, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const peNaN = E.vatPermutationEntropy(withNaN);
  ok("NaN 窗口被跳过仍可算", peNaN != null && peNaN >= 0 && peNaN <= 1);
  ok("全 NaN 返回 null", E.vatPermutationEntropy(new Array(20).fill(NaN)) === null);

  // ===== 4. 否决逻辑 =====
  const cfgOn = { entropyFilter: true, entropyWindow: 60, entropyThreshold: 0.85 };
  _s = 999;
  const noisy60 = Array.from({ length: 60 }, () => rnd() * 100);
  const v1 = E.vatEntropyVeto(noisy60, cfgOn);
  ok("高熵被否决", v1.veto === true && /市场过噪/.test(v1.reason));
  const v2 = E.vatEntropyVeto(mono, cfgOn);
  ok("低熵放行", v2.veto === false && v2.pe === 0);
  const v3 = E.vatEntropyVeto(noisy60, { ...cfgOn, entropyFilter: false });
  ok("开关关闭不否决", v3.veto === false);
  const v4 = E.vatEntropyVeto(noisy60, { ...cfgOn, entropyThreshold: 1 });
  ok("阈值=1 不否决", v4.veto === false);
  const v5 = E.vatEntropyVeto([1, 2, 3], cfgOn);
  ok("点数不足不否决", v5.veto === false && v5.pe === null);
  ok("只取窗口内最近 N 个点", (() => {
    const long = new Array(200).fill(0).map((_, i) => i); // 单调,熵 0
    const v = E.vatEntropyVeto(long, { ...cfgOn, entropyWindow: 60 });
    return v.pe === 0 && v.veto === false;
  })());

  // ===== 5. 集成:vatProcessAsset =====
  const mockMark = 4114.0;
  function baseApi(over = {}) {
    return {
      now: () => now,
      sleep: async () => {},
      underlyingAliases: { XAU: ["XAUS"] },
      getRiskMark: async () => mockMark,
      prepareOrderQty: async (symbol, qty) => ({ qty: String(qty), note: "", quote: { quoteId: "q" } }),
      indicativeQuote: async (symbol, qty) => ({
        quoteId: "q-1", mark: mockMark,
        response: { bid: String(mockMark - 0.1), ask: String(mockMark + 0.1), mark_price: String(mockMark),
          qty_limits: { ask: { min_qty_tick: "0.00001" }, bid: { min_qty_tick: "0.00001" } },
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
  // 40 个点 / 300 秒:前 32 点噪声(高熵)+后 8 点干净上漂(保证 d1/d5 方向一致且过阈值)
  function seedNoisyMomentum(st) {
    _s = 777;
    for (let i = 0; i < 40; i++) {
      const noise = i < 32 ? (rnd() - 0.5) * 3.0 : 0;
      S.vatPushHist(st, "XAU", 4100 + i * 0.2 + noise, now - 300000 + i * 7500);
    }
  }
  function freshState() {
    const st = S.vatBlankState();
    st.date = S.vatDayNY(now);
    seedNoisyMomentum(st);
    return st;
  }
  {
    const st = freshState();
    const hist = st.history.XAU.map((x) => x.p);
    const pe = S.vatPermutationEntropy(hist.slice(-60));
    ok("集成用历史确为高熵(>0.85)", pe != null && pe > 0.85);
    const cfg = { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], armed: true, liveEnabled: false,
      mode: "volume", entropyFilter: true, entropyWindow: 60, entropyThreshold: 0.85 };
    await S.vatProcessAsset(baseApi(), st, "XAU", cfg);
    const mk = st.markets.XAU;
    ok("高熵时不开仓", !st.positions.XAU && mk.status === "entropy_skip");
    ok("否决原因提到熵", /熵/.test(mk.reason || ""));
    ok("markets 记录熵值", typeof mk.entropy === "number" && mk.entropy > 0.85);
    ok("否决写了日志", (st.logs || []).some((l) => /熵否决/.test(l.msg)));
  }
  {
    // 对照:关闭开关 → 正常开 PAPER 仓
    const st = freshState();
    const cfg = { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], armed: true, liveEnabled: false,
      mode: "volume", entropyFilter: false };
    await S.vatProcessAsset(baseApi(), st, "XAU", cfg);
    ok("关闭开关后正常开仓", !!st.positions.XAU && st.markets.XAU.status === "paper_open");
  }
  {
    // 对照:低熵(干净上漂)+开关开 → 正常开仓
    const st = S.vatBlankState();
    st.date = S.vatDayNY(now);
    for (let i = 0; i < 40; i++) S.vatPushHist(st, "XAU", 4100 + i * 0.35, now - 300000 + i * 7500);
    const cfg = { ...S.VAT_DEFAULT_CONFIG, assets: ["XAU"], armed: true, liveEnabled: false,
      mode: "volume", entropyFilter: true, entropyWindow: 60, entropyThreshold: 0.85 };
    await S.vatProcessAsset(baseApi(), st, "XAU", cfg);
    ok("低熵放行开仓", !!st.positions.XAU && st.markets.XAU.status === "paper_open");
    ok("低熵熵值≈0", (st.markets.XAU.entropy || 0) < 0.2);
  }

  // ===== 6. 默认配置 =====
  ok("默认开熵否决", S.VAT_DEFAULT_CONFIG.entropyFilter === true);
  ok("默认窗口 60", S.VAT_DEFAULT_CONFIG.entropyWindow === 60);
  ok("默认阈值 0.85", S.VAT_DEFAULT_CONFIG.entropyThreshold === 0.85);
  ok("strategy 导出熵函数", typeof S.vatPermutationEntropy === "function" && typeof S.vatEntropyVeto === "function");

  console.log(`\ntest_entropy: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
