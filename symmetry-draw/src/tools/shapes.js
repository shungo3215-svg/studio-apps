/* tools/shapes.js — 直線・長方形・楕円・多角形。ドラッグした形を「掴んだコピーの画面どおり」に描き、
   モチーフ座標へ戻して保存する（どのコピーの上で描いても、見たままの形が全コピーに出る）。
   直線の端は吸着する（長方形・楕円・多角形は吸着しない）。
   ⇧: 直線は45°刻み・長方形は正方形・楕円は正円・多角形は上向き　⌥: 長方形と楕円は押した点が中心 */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, PA = SD.path;
  var MIN_PX = 3;   // これより小さいドラッグは図形にしない

  function box(a, b, c) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    if (c.shift) { var m = Math.max(Math.abs(dx), Math.abs(dy)); dx = dx < 0 ? -m : m; dy = dy < 0 ? -m : m; }
    var x0 = a[0], y0 = a[1], x1 = a[0] + dx, y1 = a[1] + dy;
    if (c.alt) { x0 = a[0] - dx; y0 = a[1] - dy; }
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
  /* 版面座標での形（アンカー列, 閉じるか） */
  var BUILD = {
    line: function (a, b, c) {
      var dx = b[0] - a[0], dy = b[1] - a[1];
      if (c.shift) { var ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, r = Math.hypot(dx, dy); dx = Math.cos(ang) * r; dy = Math.sin(ang) * r; }
      return { nodes: PA.lineNodes(a[0], a[1], a[0] + dx, a[1] + dy), closed: false };
    },
    rect: function (a, b, c) { var q = box(a, b, c); return { nodes: PA.rectNodes(q[0], q[1], q[2], q[3]), closed: true }; },
    ellipse: function (a, b, c) {
      var q = box(a, b, c);
      return { nodes: PA.ellipseNodes((q[0] + q[2]) / 2, (q[1] + q[3]) / 2, (q[2] - q[0]) / 2, (q[3] - q[1]) / 2), closed: true };
    },
    polygon: function (a, b, c) {
      var r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var a0 = c.shift ? -Math.PI / 2 : Math.atan2(b[1] - a[1], b[0] - a[0]);
      return { nodes: PA.polygonNodes(a[0], a[1], r, a0, SD.prefs.sides), closed: true };
    }
  };

  var st = null;   // { g, from, shape:{nodes,closed}|null }
  function make(kind) {
    function build(c) {
      var to = c.b;
      if (kind === 'line' && !c.shift) { var sp = SD.snap.point(to); SD.snap.mark(sp); to = sp.p; }   // 直線の端は吸着する
      var s = BUILD[kind](st.from, to, c);
      return { nodes: PA.mapNodes(s.nodes, st.g.inv), closed: s.closed };   // 画面どおりの形をモチーフ座標へ
    }
    return {
      busy: function () { return !!st; },
      down: function (c) {
        var from = c.b;
        if (kind === 'line') { var sp = SD.snap.point(from); SD.snap.mark(sp); from = sp.p; }
        st = { g: T.grab(c.b), from: from, shape: null };
      },
      move: function (c, isDown) {
        if (!st || !isDown) return;
        st.shape = build(c);
        SD.view.setDraft(T.draftSvg(st.shape.nodes, st.shape.closed));
      },
      up: function (c) {
        if (!st) return;
        var far = Math.hypot(c.b[0] - st.from[0], c.b[1] - st.from[1]) * c.unit >= MIN_PX;
        SD.view.setSnapMark(null);
        var shape = far ? build(c) : null;
        st = null;
        if (!shape) { SD.view.setDraft(''); return; }
        T.commitShape(shape.nodes, shape.closed);
      },
      cancel: function () { st = null; SD.view.setDraft(''); },
      finish: function () { st = null; SD.view.setDraft(''); }
    };
  }
  function reg(kind, label, key, icon) {
    var t = make(kind);
    t.name = kind; t.label = label; t.key = key; t.icon = icon; t.cursor = 'crosshair';
    T.register(t);
  }
  reg('line', '直線', '\\', '<path d="M5 19L19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
  reg('rect', '長方形', 'M', '<rect x="4.5" y="6.5" width="15" height="11" fill="none" stroke="currentColor" stroke-width="1.8"/>');
  reg('ellipse', '楕円', 'L', '<ellipse cx="12" cy="12" rx="8" ry="6" fill="none" stroke="currentColor" stroke-width="1.8"/>');
  reg('polygon', '多角形', 'Y', '<path d="M12 3.5L19.5 8V16L12 20.5L4.5 16V8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
})();
