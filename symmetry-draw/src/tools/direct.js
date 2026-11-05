/* tools/direct.js — ダイレクト選択(A): アンカーとハンドルを動かす。点を押すとその点を選んで動かし、線や面を押すとその図形を選んで動かす。
   ⇧ 点を足して選ぶ／外す  ⌥ ハンドルを動かす時、反対側のハンドルを連動させない
   点の移動は吸着する（アンカー・交点・格子）。Delete で選んだ点を消す。 */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, PA = SD.path, O = SD.ops, S = SD.state;
  var PT_PX = 7, DRAG_PX = 3, BLUE = '#1E90FF';
  var st = null;

  function same(a, b) { return a.id === b.id && a.idx === b.idx && a.part === b.part; }
  function isSel(p) { return S.selPts.some(function (q) { return same(p, q); }); }
  function activeGrab() {
    var L = SD.layout.get();
    if (S.active >= L.mats.length) S.active = 0;
    return T.grabIndex(S.active);
  }
  /* b に近い点（画面 PT_PX 以内）。選んだ点のハンドル → 選んだ図形のアンカー → 全図形のアンカー（全コピー）の順 */
  function findPoint(b, k) {
    var L = SD.layout.get(), u = SD.view.unit(), best = null, bd = PT_PX * (k || 1) / u;
    function test(it, idx, part, i, x, y) {
      var p = Geom.apply(L.mats[i], x, y), d = Math.hypot(p[0] - b[0], p[1] - b[1]);
      if (d <= bd) { bd = d; best = { id: it.id, idx: idx, part: part, i: i }; }
    }
    var ai = Math.min(S.active, L.mats.length - 1), items = O.selected();
    items.forEach(function (it) {
      it.nodes.forEach(function (n, idx) {
        if (!isSel({ id: it.id, idx: idx, part: 'a' })) return;
        if (n.in) test(it, idx, 'in', ai, n.in[0], n.in[1]);
        if (n.out) test(it, idx, 'out', ai, n.out[0], n.out[1]);
      });
    });
    if (best) return best;
    bd = PT_PX * (k || 1) / u;
    items.forEach(function (it) { it.nodes.forEach(function (n, idx) { test(it, idx, 'a', ai, n.x, n.y); }); });
    if (best) return best;
    bd = PT_PX * (k || 1) / u;
    S.items.forEach(function (it) {
      for (var i = 0; i < L.mats.length; i++) it.nodes.forEach(function (n, idx) { test(it, idx, 'a', i, n.x, n.y); });
    });
    return best;
  }
  function snapshot(ids) {
    return ids.map(function (id) { var it = O.byId(id); return { id: id, nodes: JSON.parse(JSON.stringify(it.nodes)) }; });
  }
  function collinear(n) {   // 両側のハンドルが一直線（なめらかな点）か
    if (!n.in || !n.out) return false;
    var a = [n.in[0] - n.x, n.in[1] - n.y], b = [n.out[0] - n.x, n.out[1] - n.y];
    var la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
    if (la < 1e-6 || lb < 1e-6) return false;
    return Math.abs(a[0] * b[1] - a[1] * b[0]) / (la * lb) < 0.035 && (a[0] * b[0] + a[1] * b[1]) < 0;
  }

  function movePoints(c) {
    var g = st.grab, raw = [c.b[0] + st.off[0], c.b[1] + st.off[1]], prim = st.prim;
    var orig = function (id) { return st.orig.filter(function (o) { return o.id === id; })[0].nodes; };
    if (prim.part === 'a') {
      var sp = SD.snap.point(raw, {
        skipAnchor: function (id, idx) { return S.selPts.some(function (p) { return p.id === id && p.idx === idx && p.part === 'a'; }); },
        skipItems: st.ids
      });
      SD.snap.mark(sp);
      var target = g.local(sp.p), o0 = orig(prim.id)[prim.idx];
      var dx = target[0] - o0.x, dy = target[1] - o0.y;
      S.selPts.forEach(function (p) {
        if (p.part !== 'a') return;
        var it = O.byId(p.id), n = it.nodes[p.idx], o = orig(p.id)[p.idx], mv = function (q) { return q ? [PA.r3(q[0] + dx), PA.r3(q[1] + dy)] : q; };
        n.x = PA.r3(o.x + dx); n.y = PA.r3(o.y + dy); n.in = mv(o.in); n.out = mv(o.out);
      });
    } else {
      var it2 = O.byId(prim.id), n2 = it2.nodes[prim.idx], o2 = orig(prim.id)[prim.idx], l = g.local(raw);
      var other = prim.part === 'in' ? 'out' : 'in';
      n2[prim.part] = [PA.r3(l[0]), PA.r3(l[1])];
      if (!c.alt && collinear(o2) && o2[other]) {   // なめらかな点は、反対側のハンドルを一直線のまま長さを保って動かす
        var vx = l[0] - n2.x, vy = l[1] - n2.y, vl = Math.hypot(vx, vy) || 1;
        var ol = Math.hypot(o2[other][0] - o2.x, o2[other][1] - o2.y);
        n2[other] = [PA.r3(n2.x - vx / vl * ol), PA.r3(n2.y - vy / vl * ol)];
      }
    }
    st.changed = true;
    SD.view.live();
  }

  T.register({
    name: 'direct', label: 'ダイレクト<br>選択', key: 'A', cursor: 'default', title: 'ダイレクト選択',
    icon: '<path d="M6 3.5V18.5L10 14.6L12.8 20.6L15.2 19.5L12.4 13.6L17.8 13.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    busy: function () { return false; },
    down: function (c) {
      var hit = findPoint(c.b, T.reach(c, 1));
      if (hit) {
        S.active = hit.i;
        if (c.shift) { if (isSel(hit)) S.selPts = S.selPts.filter(function (p) { return !same(p, hit); }); else S.selPts.push({ id: hit.id, idx: hit.idx, part: hit.part }); }
        else if (!isSel(hit)) S.selPts = [{ id: hit.id, idx: hit.idx, part: hit.part }];
        if (S.sel.indexOf(hit.id) < 0) { if (c.shift) S.sel.push(hit.id); else S.sel = [hit.id]; }
        SD.emit('sel');
        if (!isSel(hit)) return;
        var g = T.grabIndex(hit.i), it = O.byId(hit.id), n = it.nodes[hit.idx];
        var q = hit.part === 'a' ? [n.x, n.y] : n[hit.part], bp = g.board(q[0], q[1]);
        var ids = S.selPts.map(function (p) { return p.id; }).filter(function (v, k, a) { return a.indexOf(v) === k; });
        st = { mode: 'pts', grab: g, prim: hit, ids: ids, orig: snapshot(ids), off: [bp[0] - c.b[0], bp[1] - c.b[1]], b0: c.b, changed: false, moved: false };
        return;
      }
      var h = T.hitAt(c.b, T.reach(c, 5));
      if (h) {
        S.sel = [h.item.id]; S.selPts = []; S.active = h.i; SD.emit('sel');
        st = { mode: 'move', grab: T.grabIndex(h.i), ids: [h.item.id], orig: snapshot([h.item.id]), b0: c.b, changed: false, moved: false };
        return;
      }
      if (!c.shift && (S.sel.length || S.selPts.length)) { S.sel = []; S.selPts = []; SD.emit('sel'); }
    },
    move: function (c, isDown) {
      if (!st || !isDown) return;
      if (!st.moved) { if (Math.hypot(c.b[0] - st.b0[0], c.b[1] - st.b0[1]) * c.unit < DRAG_PX) return; st.moved = true; }
      if (st.mode === 'pts') movePoints(c);
      else {
        var d = st.grab.vec([c.b[0] - st.b0[0], c.b[1] - st.b0[1]]);
        st.orig.forEach(function (o) { var it = O.byId(o.id); if (it) it.nodes = PA.mapNodes(o.nodes, [1, 0, 0, 1, d[0], d[1]]); });
        st.changed = true; SD.view.live();
      }
    },
    up: function () {
      if (!st) return;
      var s = st; st = null; SD.view.setSnapMark(null);
      if (s.changed) SD.commit();
    },
    cancel: function () {
      if (!st) return;
      st.orig.forEach(function (o) { var it = O.byId(o.id); if (it) it.nodes = o.nodes; });
      st = null; SD.view.setSnapMark(null); SD.view.live();
    },
    finish: function () { st = null; },
    /* Delete: 選んだ点を消す（点が残り2つ未満の図形は図形ごと消える）。選んだ点が無ければ false を返して図形の削除へ */
    del: function () {
      if (!S.selPts.length) return false;
      var gone = {};
      S.selPts.forEach(function (p) {
        var it = O.byId(p.id); if (!it) return;
        if (p.part === 'a') (gone[p.id] = gone[p.id] || []).push(p.idx); else it.nodes[p.idx][p.part] = null;
      });
      Object.keys(gone).forEach(function (id) {
        var it = O.byId(+id);
        it.nodes = it.nodes.filter(function (n, k) { return gone[id].indexOf(k) < 0; });
        if (it.nodes.length < 2) SD.removeIds([+id]);
      });
      S.selPts = []; SD.commit(); SD.emit('sel');
      return true;
    },
    /* 選んだ図形のアンカー（基準のコピーの上）と、選んだアンカーのハンドル */
    overlay: function () {
      var items = O.selected();
      if (!items.length) return '';
      var g = activeGrab(), h = 3.5 / SD.view.unit(), s = '';
      items.forEach(function (it) {
        it.nodes.forEach(function (n, idx) {
          var sel = isSel({ id: it.id, idx: idx, part: 'a' }), p = g.board(n.x, n.y);
          if (sel) ['in', 'out'].forEach(function (k) {
            if (!n[k]) return;
            var q = g.board(n[k][0], n[k][1]);
            s += '<path d="M' + p[0] + ' ' + p[1] + 'L' + q[0] + ' ' + q[1] + '" stroke="' + BLUE + '" stroke-width="1" vector-effect="non-scaling-stroke" fill="none"/>' +
                 '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + h * 0.8 + '" fill="' + (isSel({ id: it.id, idx: idx, part: k }) ? BLUE : '#FFFFFF') + '" stroke="' + BLUE + '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
          });
          s += '<rect x="' + (p[0] - h) + '" y="' + (p[1] - h) + '" width="' + h * 2 + '" height="' + h * 2 + '" fill="' + (sel ? BLUE : '#FFFFFF') + '" stroke="' + BLUE + '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
        });
      });
      return s;
    }
  });
})();
