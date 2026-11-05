/* tools/pencil.js — 鉛筆: なぞった線を、少ないアンカーのベジェに当てはめる（000_kit/curve-fit.js）。 */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, PA = SD.path;
  var STEP_PX = 2, TOL_PX = 2.2;   // 点を取る間隔・当てはめの許容誤差（画面の px）
  var st = null;                   // { g, pts:[[x,y] モチーフ座標], last:[版面x,y] }

  function preview() {
    var nodes = st.pts.map(function (p) { return PA.N(p[0], p[1]); });
    SD.view.setDraft(nodes.length > 1 ? T.draftSvg(nodes, false) : '');
  }

  T.register({
    name: 'pencil', label: '鉛筆', key: 'N', cursor: 'crosshair',
    icon: '<path d="M4 20L5.2 15L16 4.2L19.8 8L9 18.8Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 6.2L17.8 10" stroke="currentColor" stroke-width="1.7"/>',
    busy: function () { return !!st; },
    down: function (c) {
      var g = T.grab(c.b);
      st = { g: g, pts: [g.local(c.b)], last: c.b };
    },
    move: function (c, isDown) {
      if (!st || !isDown) return;
      if (Math.hypot(c.b[0] - st.last[0], c.b[1] - st.last[1]) * c.unit < STEP_PX) return;
      st.pts.push(st.g.local(c.b)); st.last = c.b;
      preview();
    },
    up: function (c) {
      if (!st) return;
      var g = st.g, pts = st.pts;
      var l = g.local(c.b);
      if (Math.hypot(c.b[0] - st.last[0], c.b[1] - st.last[1]) > 0) pts.push(l);
      st = null;
      var tol = TOL_PX / (SD.view.unit() * g.scale);   // 画面の px をモチーフ座標へ
      var nodes = PA.fitPoints(pts, tol);
      if (!nodes) { SD.view.setDraft(''); return; }
      T.commitShape(nodes, false);
    },
    cancel: function () { st = null; SD.view.setDraft(''); },
    finish: function () { st = null; SD.view.setDraft(''); }
  });
})();
