/* snap.js — 吸着。アンカー → 交点 → 格子 の順で、画面 6px 以内でいちばん近い点に寄せる。
   アンカーと交点は全コピーを横断して探す（どのコピーに見えている点にも吸着する）。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var PX = 6, MAX_SEGS = 160;
  var PA = SD.path;

  function crossAt(a, b, c, d) {   // 線分 ab と cd の交点（無ければ null）
    var r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
    var den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return null;
    var t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    var u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return [a[0] + t * r[0], a[1] + t * r[1]];
  }
  function distSeg(q, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy));
  }

  function gridPoint(b, rb) {
    var S = SD.state, g = SD.groups.byName[S.group], W = SD.view.W, H = SD.view.H, best = null, bd = rb, c = [];
    if (g.kind === 'wallpaper') {
      SD.layout.applyParams();
      var B = Groups.basis(Groups.TABLE[S.group].lattice), det = B[0] * B[3] - B[1] * B[2];
      var fi = (B[3] * b[0] - B[1] * b[1]) / det, fj = (-B[2] * b[0] + B[0] * b[1]) / det;
      for (var i = Math.floor(fi); i <= Math.floor(fi) + 1; i++)
        for (var j = Math.floor(fj); j <= Math.floor(fj) + 1; j++) c.push([B[0] * i + B[1] * j, B[2] * i + B[3] * j]);
    } else if (g.kind === 'frieze') {
      c.push([Math.round(b[0] / S.params.gap) * S.params.gap, H / 2]);
    } else c.push([W / 2, H / 2]);
    c.forEach(function (p) { var d = Math.hypot(p[0] - b[0], p[1] - b[1]); if (d <= bd) { bd = d; best = p; } });
    return best;
  }

  /* b: 版面座標。opt.skipAnchor(id, idx) が true の点と、opt.skipItems（id の配列）の図形の線は対象にしない。
     戻り値 {p:[x,y], kind:'anchor'|'cross'|'grid'|null} */
  function point(b, opt) {
    opt = opt || {};
    if (!SD.prefs.snap) return { p: b, kind: null };
    var L = SD.layout.get(), items = SD.state.items, rb = PX / SD.view.unit(), rl = rb / L.scale;
    var best = null, bd = Infinity, i, k, j;
    // 1. アンカー
    for (i = 0; i < L.mats.length; i++) {
      var q = Geom.apply(L.inv[i], b[0], b[1]);
      for (k = 0; k < items.length; k++) {
        var it = items[k];
        for (j = 0; j < it.nodes.length; j++) {
          var n = it.nodes[j], d = Math.hypot(n.x - q[0], n.y - q[1]);
          if (d <= rl && d < bd && !(opt.skipAnchor && opt.skipAnchor(it.id, j))) { bd = d; best = Geom.apply(L.mats[i], n.x, n.y); }
        }
      }
    }
    if (best) return { p: best, kind: 'anchor' };
    // 2. 交点（b の近くを通る線分だけ集めて、組み合わせで調べる）
    var segs = [], flats = {};
    for (i = 0; i < L.mats.length && segs.length < MAX_SEGS; i++) {
      var ql = Geom.apply(L.inv[i], b[0], b[1]);
      for (k = 0; k < items.length; k++) {
        var im = items[k];
        if (opt.skipItems && opt.skipItems.indexOf(im.id) >= 0) continue;
        var poly = flats[im.id] || (flats[im.id] = PA.flatten(im.nodes, im.closed, 8));
        var cnt = im.closed ? poly.length : poly.length - 1;
        for (j = 0; j < cnt; j++) {
          var p0 = poly[j], p1 = poly[(j + 1) % poly.length];
          if (distSeg(ql, p0, p1) <= rl)
            segs.push({ a: Geom.apply(L.mats[i], p0[0], p0[1]), b: Geom.apply(L.mats[i], p1[0], p1[1]), key: im.id + '/' + i, j: j });
        }
      }
    }
    bd = Infinity;
    for (i = 0; i < segs.length; i++) for (k = i + 1; k < segs.length; k++) {
      var s0 = segs[i], s1 = segs[k];
      if (s0.key === s1.key && Math.abs(s0.j - s1.j) <= 1) continue;   // 同じ線の隣どうしは端でつながっているだけ
      var x = crossAt(s0.a, s0.b, s1.a, s1.b);
      if (!x) continue;
      var dd = Math.hypot(x[0] - b[0], x[1] - b[1]);
      if (dd <= rb && dd < bd) { bd = dd; best = x; }
    }
    if (best) return { p: best, kind: 'cross' };
    // 3. 格子
    var gp = gridPoint(b, rb);
    if (gp) return { p: gp, kind: 'grid' };
    return { p: b, kind: null };
  }

  SD.snap = {
    point: point,
    /* 吸着してから、印を出す */
    mark: function (res) { SD.view.setSnapMark(res && res.kind ? res.p : null); }
  };
})();
