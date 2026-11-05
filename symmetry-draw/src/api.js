/* api.js — テスト用の窓口 window.Sym（受け入れ検査が使う。消さない・SPEC.md「テスト用の窓口」） */
(function () {
  'use strict';
  var SD = window.SD;
  window.Sym = {
    doc: function () { return SD.doc(); },
    groups: function () { return SD.groups.list.map(function (g) { return g.name; }); },
    setGroup: function (name) { return SD.setGroup(name); },
    group: function () { return SD.state.group; },
    tool: function (name) { if (name) SD.tools.set(name); return SD.tools.current; },
    /* コピーごとの行列 [a,b,c,d,e,f]（モチーフ座標 → 版面SVGの getBoundingClientRect 基準の画面 px）。0番が基準コピー */
    copies: function () {
      var V = SD.view, k = V.unit(), o = V.toClient(0, 0);
      return SD.layout.get().mats.map(function (m) {
        return [m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k + o[0], m[5] * k + o[1]];
      });
    },
    motifBox: function () { return { x0: 0, y0: 0, x1: SD.PAD, y1: SD.PAD }; },
    toClient: function (x, y, i) {
      var b = Geom.apply(SD.layout.get().mats[i || 0], x, y), c = SD.view.toClient(b[0], b[1]);
      return { x: c[0], y: c[1] };
    },
    selection: function () { return SD.state.sel.slice(); },
    exportSVG: function () { return Studio.serializeSVG(SD.exp.buildSvg(true), { standard: true, meta: SD.exp.meta() }); },
    load: function (d) { SD.load(d); }
  };
})();
