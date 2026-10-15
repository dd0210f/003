"use strict";
/* v1.3.0: venue 工厂。按 id 建适配器;txflow(unsupported) 返回 null。
 * service worker 里各 XxxAdapter 经 importScripts 先加载为全局;node 测试里按需 require。 */

function _venueClass(id) {
  const map = {
    variational: "VariationalAdapter",
    qfex: "QfexAdapter",
    entropy: "EntropyAdapter",
    lighter: "LighterAdapter",
    arcus: "ArcusAdapter",
  };
  const gname = map[id];
  if (!gname) return null;
  if (typeof globalThis !== "undefined" && globalThis[gname]) return globalThis[gname];
  if (typeof require === "function") {
    try {
      const m = require("./" + id + ".js");
      if (m && m[gname]) return m[gname];
    } catch (e) { /* ignore */ }
  }
  return null;
}

/** 建适配器。opts: {creds, storage}。未知/不支持的 id 返回 null。 */
function createVenueAdapter(id, opts) {
  const C = _venueClass(id);
  return C ? new C(id, opts || {}) : null;
}

/* node 测试用导出(浏览器里 module 未定义,不影响) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createVenueAdapter };
}
