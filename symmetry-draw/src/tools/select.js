/* tools/select.js — 選択(V): 押した図形を選ぶ・動かす・枠の点で拡大縮小・枠の外で回転。
   どのコピーを掴んでも、掴んだコピーの向きで指に付いてくる（鏡のコピーでも）。
   何も無い所からドラッグすると、枠で選ぶ（枠に全体が入った図形・どのコピーで囲んでも可・⇧で追加）
   ⇧ 移動は45°刻み・拡大縮小は縦横比そのまま・回転は45°刻み　⌥ ドラッグで複製・拡大縮小は枠の中心から */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, PA = SD.path, O = SD.ops, S = SD.state;
  var REACH_PX = 5, HANDLE_PX = 6, ROT_PX = 22, DRAG_PX = 3;
  var st = null;
  var BLUE = '#1E90FF';

  function activeGrab() {
    var L = SD.layout.get();
    if (S.active >= L.mats.length) S.active = 0;
    return T.grabIndex(S.active);
  }
  /* 枠の点（箱の割合）。小さい箱では角だけ。r = つかめる半径（画面 px） */
  function handleSet(bx, k) {
    var L = SD.layout.get(), u = SD.view.unit();
    var wpx = (bx.x1 - bx.x0) * L.scale * u, hpx = (bx.y1 - bx.y0) * L.scale * u;
    var list = [[0, 0], [1, 0], [1, 1], [0, 1]];
    if (Math.min(wpx, hpx) >= 28) list.push([.5, 0], [1, .5], [.5, 1], [0, .5]);
    return { list: list, r: Math.max(2.5, Math.min(HANDLE_PX * (k || 1), 0.3 * Math.min(wpx, hpx))) };
  }
  function at(bx, h) { return [bx.x0 + (bx.x1 - bx.x0) * h[0], bx.y0 + (bx.y1 - bx.y0) * h[1]]; }

  function snapshot() {
    return O.selected().map(function (it) { return { id: it.id, nodes: JSON.parse(JSON.stringify(it.nodes)) }; });
  }
  function applyMatrix(m) {
    st.orig.forEach(function (o) { var it = O.byId(o.id); if (it) it.nodes = PA.mapNodes(o.nodes, m); });
    st.changed = true;
    SD.view.live();
  }

  function begin(mode, c, extra) {
    var g = extra.grab || activeGrab();
    st = Object.assign({ mode: mode, b0: c.b, grab: g, orig: snapshot(), changed: false, moved: false, dup: false }, extra);
  }

  T.register({
    name: 'select', label: '選択', key: 'V', cursor: 'default',
    icon: '<path d="M6 3.5V18.5L10 14.6L12.8 20.6L15.2 19.5L12.4 13.6L17.8 13.4Z" fill="currentColor"/>',
    busy: function () { return false; },
    down: function (c) {
      var items = O.selected(), bx = items.length ? O.bbox(items) : null, g, p, i, k = T.reach(c, 1);
      // 1. 枠の点 → 拡大縮小
      if (bx) {
        g = activeGrab();
        var H = handleSet(bx, k);
        for (i = 0; i < H.list.length; i++) {
          var bp = g.board.apply(null, at(bx, H.list[i]));
          if (Math.hypot(bp[0] - c.b[0], bp[1] - c.b[1]) * c.unit <= H.r) { begin('scale', c, { box: bx, h: H.list[i] }); return; }
        }
      }
      // 2. 図形 → 選んで動かす
      var hit = T.hitAt(c.b, REACH_PX * k);
      if (hit) {
        var id = hit.item.id, was = S.sel.indexOf(id) >= 0;
        if (c.shift) { if (was) S.sel.splice(S.sel.indexOf(id), 1); else S.sel.push(id); }
        else if (!was) S.sel = [id];
        S.selPts = []; S.active = hit.i;
        SD.emit('sel');
        if (S.sel.indexOf(id) >= 0) begin('move', c, { grab: T.grabIndex(hit.i) });
        return;
      }
      // 3. 枠の角の外 → 回転
      if (bx) {
        g = activeGrab(); p = g.local(c.b);
        var out = p[0] < bx.x0 || p[0] > bx.x1 || p[1] < bx.y0 || p[1] > bx.y1, near = Infinity;
        [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(function (h) {
          var q = g.board.apply(null, at(bx, h)); near = Math.min(near, Math.hypot(q[0] - c.b[0], q[1] - c.b[1]) * c.unit);
        });
        if (out && near <= handleSet(bx, k).r + ROT_PX * k) {
          var cx = (bx.x0 + bx.x1) / 2, cy = (bx.y0 + bx.y1) / 2;
          begin('rotate', c, { center: [cx, cy], a0: Math.atan2(p[1] - cy, p[0] - cx) });
          return;
        }
      }
      // 4. 何も無い所 → 選択を外し、ドラッグなら枠で選ぶ
      var base = c.shift ? S.sel.slice() : [];
      if (!c.shift && (S.sel.length || S.selPts.length)) { S.sel = []; S.selPts = []; SD.emit('sel'); }
      st = { mode: 'marquee', b0: c.b, base: base, moved: false, changed: false, orig: [] };
    },
    move: function (c, isDown) {
      if (!st) return;
      if (!isDown) return;
      var g = st.grab, u = c.unit, d, m;
      if (!st.moved) { if (Math.hypot(c.b[0] - st.b0[0], c.b[1] - st.b0[1]) * u < DRAG_PX) return; st.moved = true; }
      if (st.mode === 'marquee') {
        var x0 = Math.min(st.b0[0], c.b[0]), y0 = Math.min(st.b0[1], c.b[1]), x1 = Math.max(st.b0[0], c.b[0]), y1 = Math.max(st.b0[1], c.b[1]);
        st.rect = [x0, y0, x1, y1];
        SD.view.setToolOverlay('<rect x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0) + '" height="' + (y1 - y0) + '" fill="' + BLUE + '" fill-opacity="0.08" stroke="' + BLUE + '" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>');
        return;
      }
      if (st.mode === 'move') {
        if (c.alt && !st.dup) {   // ⌥ドラッグ: 元は残して、複製を動かす
          st.dup = true; O.duplicateQuiet(0, 0); st.orig = snapshot();
        }
        d = [c.b[0] - st.b0[0], c.b[1] - st.b0[1]];
        if (c.shift) { var a = Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 4)) * Math.PI / 4, r = Math.hypot(d[0], d[1]); d = [Math.cos(a) * r, Math.sin(a) * r]; }
        st.dv = g.vec(d);
        applyMatrix([1, 0, 0, 1, st.dv[0], st.dv[1]]);
      } else if (st.mode === 'scale') {
        var bx = st.box, p = g.local(c.b), h = st.h;
        var hx = bx.x0 + (bx.x1 - bx.x0) * h[0], hy = bx.y0 + (bx.y1 - bx.y0) * h[1];
        var ax = h[0] === 0 ? bx.x1 : h[0] === 1 ? bx.x0 : (bx.x0 + bx.x1) / 2;
        var ay = h[1] === 0 ? bx.y1 : h[1] === 1 ? bx.y0 : (bx.y0 + bx.y1) / 2;
        if (c.alt) { ax = (bx.x0 + bx.x1) / 2; ay = (bx.y0 + bx.y1) / 2; }
        var sx = h[0] === .5 ? 1 : (p[0] - ax) / ((hx - ax) || 1e-9);
        var sy = h[1] === .5 ? 1 : (p[1] - ay) / ((hy - ay) || 1e-9);
        if (c.shift && h[0] !== .5 && h[1] !== .5) { var k = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = sy = k; }
        else if (c.shift) { if (h[0] === .5) sx = sy; else sy = sx; }
        sx = Math.abs(sx) < 0.02 ? 0.02 : sx; sy = Math.abs(sy) < 0.02 ? 0.02 : sy;
        applyMatrix([sx, 0, 0, sy, ax - sx * ax, ay - sy * ay]);
      } else if (st.mode === 'rotate') {
        var q = g.local(c.b), da = Math.atan2(q[1] - st.center[1], q[0] - st.center[0]) - st.a0;
        if (c.shift) da = Math.round(da / (Math.PI / 4)) * Math.PI / 4;
        var cs = Math.cos(da), sn = Math.sin(da), cx = st.center[0], cy = st.center[1];
        applyMatrix([cs, sn, -sn, cs, cx - cs * cx + sn * cy, cy - sn * cx - cs * cy]);
      }
    },
    up: function () {
      if (!st) return;
      var s = st; st = null;
      if (s.mode === 'marquee') {   // 枠に全体が入った図形を、どのコピーで囲んでも選ぶ
        SD.view.setToolOverlay('');
        if (!s.rect) return;
        var L = SD.layout.get(), r = s.rect, ids = s.base.slice(), ac = S.active;
        S.items.forEach(function (it) {
          if (ids.indexOf(it.id) >= 0) return;
          var pts = PA.flatten(it.nodes, it.closed, 6);
          for (var i = 0; i < L.mats.length; i++) {
            var inside = pts.every(function (p) { var q = Geom.apply(L.mats[i], p[0], p[1]); return q[0] >= r[0] && q[0] <= r[2] && q[1] >= r[1] && q[1] <= r[3]; });
            if (inside) { ids.push(it.id); ac = i; return; }
          }
        });
        S.sel = ids; S.selPts = []; S.active = ac; SD.emit('sel');
        return;
      }
      if (s.changed) {
        if (s.mode === 'move' && s.dv) O.setLastMove(s.dv);
        SD.commit();
      }
    },
    cancel: function () {
      if (!st) return;
      if (st.mode === 'marquee') { st = null; SD.view.setToolOverlay(''); return; }
      st.orig.forEach(function (o) { var it = O.byId(o.id); if (it) it.nodes = o.nodes; });
      st = null; SD.view.live();
    },
    finish: function () { st = null; },
    /* 選択の枠と枠の点（基準にしているコピーの上） */
    overlay: function () {
      var items = O.selected();
      if (!items.length) return '';
      var bx = O.bbox(items), g = activeGrab(), u = SD.view.unit(), H = handleSet(bx);
      var pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(function (h) { return g.board.apply(null, at(bx, h)); });
      var s = '<path d="M' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join('L') + 'Z" fill="none" stroke="' + BLUE + '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      var hs = Math.max(2, H.r * 0.75) / u;
      H.list.forEach(function (h) {
        var p = g.board.apply(null, at(bx, h));
        s += '<rect x="' + (p[0] - hs) + '" y="' + (p[1] - hs) + '" width="' + hs * 2 + '" height="' + hs * 2 + '" fill="#FFFFFF" stroke="' + BLUE + '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      });
      return s;
    }
  });
})();
