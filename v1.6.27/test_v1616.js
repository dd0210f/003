/* v1.6.17 测试:三所标的(QFEX 18/Arcus 9/Variational 16,用户截图指定)+候选与默认选中分离+三所重叠表。
 * 运行: node test_v1616.js
 */
"use strict";
const path = require("path");
const assert = require("assert");
const S = require(path.join(__dirname, "strategy.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra === undefined ? "" : extra); }
}

(async () => {
  // 1. 候选全量
  ok("QFEX 候选 18 个", S.VAT_QFEX_CANDIDATES.length === 18, S.VAT_QFEX_CANDIDATES.length);
  ok("QFEX 候选去重", new Set(S.VAT_QFEX_CANDIDATES).size === 18);
  ok("QFEX 候选前 8 为原精选", S.VAT_QFEX_CANDIDATES.slice(0, 8).join(",") ===
    "GOLD-USD,SILVER-USD,US100-USD,US500-USD,CL-USD,NVDA-USD,AAPL-USD,TSLA-USD");
  ok("Arcus 候选 9 个", S.VAT_ARCUS_CANDIDATES.length === 9, S.VAT_ARCUS_CANDIDATES.length);
  ok("Arcus 候选为截图 9 个",
    JSON.stringify(S.VAT_ARCUS_CANDIDATES) === JSON.stringify(["BTC-USD","SPY-USD","ETH-USD","NVDA-USD","QQQ-USD","AAPL-USD","SOL-USD","HYPE-USD","SNDK-USD"]));
  ok("Arcus 候选去重", new Set(S.VAT_ARCUS_CANDIDATES).size === 9);

  // 2. 候选访问器
  ok("qfex 候选访问器 18", S.vatVenueAssetCandidates({ activeVenue: "qfex" }).length === 18);
  ok("arcus 候选访问器 9", S.vatVenueAssetCandidates({ activeVenue: "arcus" }).length === 9);
  ok("variational 候选 16", S.vatVenueAssetCandidates({ activeVenue: "variational" }).length === 16);
  ok("maker qfex 候选 18", S.vatVenueMakerCandidates({ activeVenue: "qfex" }).length === 18);
  ok("maker arcus 候选为空(maker 不支持 arcus)", S.vatVenueMakerCandidates({ activeVenue: "arcus" }).length === 0);

  // 3. 默认选中保持精简(避免默认全选导致每轮询价 200+ 个标的)
  ok("qfex 默认仍 8 个", S.vatVenueAssets({ activeVenue: "qfex" }).length === 8);
  ok("arcus 默认 BTC/ETH", JSON.stringify(S.vatVenueAssets({ activeVenue: "arcus" })) === '["BTC-USD","ETH-USD"]');
  ok("variational 默认 16 个", S.vatVenueAssets({ activeVenue: "variational" }).length === 16);

  // 4. 迁移给 arcus 默认
  {
    const cfg = {};
    S.vatMigrate1610(cfg);
    ok("迁移给 arcus 默认", JSON.stringify(cfg.venueAssets.arcus) === '["BTC-USD","ETH-USD"]',
      JSON.stringify(cfg.venueAssets.arcus));
    ok("迁移 qfex 仍 8 个", cfg.venueAssets.qfex.length === 8);
  }

  // 5. 重叠表:每行引用的符号必须在对应所的候选中存在
  {
    const cand = {
      variational: new Set(S.vatVenueAssetCandidates({ activeVenue: "variational" })),
      qfex: new Set(S.VAT_QFEX_CANDIDATES),
      arcus: new Set(S.VAT_ARCUS_CANDIDATES),
    };
    const venues = ["variational", "qfex", "arcus"];
    let bad = [];
    for (const row of S.VAT_VENUE_OVERLAP) {
      row.forEach((sym, i) => {
        if (sym && !cand[venues[i]].has(sym)) bad.push(`${venues[i]}:${sym}`);
      });
    }
    ok("重叠表符号全部在候选中", bad.length === 0, bad.join(";"));
    ok("重叠表 10 行", S.VAT_VENUE_OVERLAP.length === 10);
  }

  // 6. QFEX 无 BTC/ETH(与 strategy.js 注释一致)
  ok("QFEX 候选无 BTC/ETH 永续",
    !S.VAT_QFEX_CANDIDATES.includes("BTC-USD") && !S.VAT_QFEX_CANDIDATES.includes("ETH-USD"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
