/* faces.js — シェイプ形成の下ごしらえ。展開した全コピーの線を、版面座標の折れ線にして1つの平面グラフにし、
   押した所の面（線で区切られた最小の領域）と、線の「交点から交点まで」の区間を求める。
   面は geom.js の polyFaces、面のつなぎは polyBool。曲線は折れ線にしてから求める。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var PA = SD.path;
  var MAX_EDGES = 6000;   // これより多いと重くなるので、押した所の近くのコピーだけにする

  /* 全コピーの全図形の折れ線（版面座標）。win=[x,y,r] を渡すと、その範囲に触れるものだけ */
  function polylines(win) {
    var L = SD.layout.get(), items = SD.state.items, out = [], i, k;
    for (i = 0; i < L.mats.length; i++) {
      for (k = 0; k < items.length; k++) {
        var it = items[k], pts = PA.flatten(it.nodes, it.closed, 10).map(function (p) { return Geom.apply(L.mats[i], p[0], p[1]); });
        if (pts.length < 2) continue;
        if (win) {
          var near = pts.some(function (p) { return Math.abs(p[0] - win[0]) < win[2] && Math.abs(p[1] - win[1]) < win[2]; });
          if (!near) continue;
        }
        out.push({ pts: pts, item: it, copy: i });
      }
    }
    return out;
  }
  function allLines(b) {
    var lines = polylines(null), n = lines.reduce(function (s, l) { return s + l.pts.length; }, 0);
    if (n > MAX_EDGES) lines = polylines([b[0], b[1], Math.max(120, SD.layout.get().scale * SD.PAD * 2.5)]);
    return lines;
  }

  /* 面の一覧（版面座標）: [{outer, holes, area}] */
  function faces(b) {
    var lines = allLines(b);
    var res = Geom.polyFaces([], lines.map(function (l) { return l.pts; }));
    return res.map(function (f) { return { outer: f.outer, holes: f.holes, area: Math.abs(Geom.ringArea(f.outer)) }; });
  }
  /* b を含む面のうち、いちばん小さい物 */
  function faceAt(list, b) {
    var best = null;
    list.forEach(function (f) {
      if (!Geom.inRings([f.outer].concat(f.holes), b[0], b[1])) return;
      if (!best || f.area < best.area) best = f;
    });
    return best;
  }
  /* 選んだ面をつないだ外形（外周だけ・穴は埋める）。つながらない物は別々の外形になる */
  function unite(fs) {
    if (fs.length === 1) return [fs[0].outer];
    var r = Geom.polyBool(fs.map(function (f) { return [f.outer].concat(f.holes); }), [], 'union');
    return r.map(function (o) { return o.outer; });
  }
  /* 外形（版面座標）→ モチーフ座標のアンカー列。点が多い時は curve-fit で減らす */
  function ringToNodes(ring, grab) {
    var pts = ring.map(function (p) { return grab.local(p); });
    if (pts.length > 24) {
      var tol = 1.2 / (SD.view.unit() * grab.scale), fit = PA.fitClosed(pts, tol);
      if (fit) return fit;
    }
    return pts.map(function (p) { return PA.N(p[0], p[1]); });
  }

  /* ---- 線の区間（交点から交点まで） ---- */
  function cross(a, b, c, d) {
    var r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-12) return null;
    var t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
  }
  function distSeg(q, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    return { d: Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy)), t: t };
  }
  function ptAt(T, pos) {
    var s = Math.min(T.length - 2, Math.floor(pos)), t = pos - s;
    return [T[s][0] + (T[s + 1][0] - T[s][0]) * t, T[s][1] + (T[s + 1][1] - T[s][1]) * t];
  }
  function sub(T, a, b) {   // 位置 a から b（a<=b）までの折れ線
    var out = [ptAt(T, a)];
    for (var i = Math.floor(a) + 1; i <= Math.ceil(b) - 1 && i < T.length; i++) if (i > a && i < b) out.push(T[i]);
    out.push(ptAt(T, b));
    return out;
  }

  /* b の近く（画面 reachPx 以内）の線について、押した区間を求める。{item, copy, T(モチーフ座標), a, b, keep:[折れ線…], run} か null */
  function findRun(b, reachPx) {
    var L = SD.layout.get(), items = SD.state.items, tol = reachPx / (SD.view.unit() * L.scale);
    var hit = null, i, k, j;
    for (k = items.length - 1; k >= 0 && !hit; k--) {
      var T0 = PA.flatten(items[k].nodes, items[k].closed, 10), bd = Infinity, bi = -1;
      for (i = 0; i < L.inv.length; i++) {
        var q = Geom.apply(L.inv[i], b[0], b[1]), dmin = Infinity;
        for (j = 0; j + 1 < T0.length; j++) dmin = Math.min(dmin, distSeg(q, T0[j], T0[j + 1]).d);
        if (dmin > tol) continue;
        var dc = Math.hypot(L.centers[i][0] - b[0], L.centers[i][1] - b[1]);
        if (dc < bd - 1e-6) { bd = dc; bi = i; }
      }
      if (bi >= 0) hit = { item: items[k], copy: bi, T: T0 };
    }
    if (!hit) return null;
    var T = hit.T, it = hit.item, ci = hit.copy, q0 = Geom.apply(L.inv[ci], b[0], b[1]);
    // 押した位置（折れ線上の位置 = 辺の番号 + 辺の中の割合）
    var pos = 0, pd = Infinity;
    for (j = 0; j + 1 < T.length; j++) { var r = distSeg(q0, T[j], T[j + 1]); if (r.d < pd) { pd = r.d; pos = j + r.t; } }
    // 他の線との交点（全コピーの線を、この図形のコピーの座標へ戻して比べる）
    var cuts = [], m = L.inv[ci];
    for (i = 0; i < L.mats.length; i++) for (k = 0; k < items.length; k++) {
      if (i === ci && items[k] === it) continue;
      var M = Geom.mul(m, L.mats[i]), P = PA.flatten(items[k].nodes, items[k].closed, 10).map(function (p) { return Geom.apply(M, p[0], p[1]); });
      for (j = 0; j + 1 < T.length; j++) for (var n = 0; n + 1 < P.length; n++) {
        var t = cross(T[j], T[j + 1], P[n], P[n + 1]);
        if (t !== null) cuts.push(j + t);
      }
    }
    var end = T.length - 1, closed = it.closed, lo = null, hi = null;
    if (closed) cuts = cuts.map(function (c) { return c >= end - 1e-6 ? c - end : c; });   // 輪の終点＝始点
    cuts.sort(function (x, y) { return x - y; });
    cuts = cuts.filter(function (c, idx) { return idx === 0 || c - cuts[idx - 1] > 1e-6; });
    cuts.forEach(function (c) { if (c <= pos + 1e-9) lo = c; });
    for (var x = 0; x < cuts.length; x++) if (cuts[x] > pos + 1e-9) { hi = cuts[x]; break; }
    var run, keep = [];
    if (closed) {
      if (cuts.length < 2) run = T.slice();   // 交点が無い／1か所だけ: 輪ぜんぶが1つの区間
      else if (lo !== null && hi !== null) {
        run = sub(T, lo, hi);
        keep.push(sub(T, hi, end).concat(sub(T, 0, lo)));
      } else {   // 始点（輪の継ぎ目）をまたぐ区間
        var a = lo !== null ? lo : cuts[cuts.length - 1], z = hi !== null ? hi : cuts[0];
        run = sub(T, a, end).concat(sub(T, 0, z));
        keep.push(sub(T, z, a));
      }
    } else {
      var a2 = lo !== null ? lo : 0, z2 = hi !== null ? hi : end;
      run = sub(T, a2, z2);
      if (a2 > 1e-6) keep.push(sub(T, 0, a2));
      if (z2 < end - 1e-6) keep.push(sub(T, z2, end));
    }
    return { item: it, copy: ci, run: run, keep: keep };
  }
  /* 区間を消す。元の図形は、残った折れ線（開いた線）に置き換わる。消せたら true（確定はしない） */
  function eraseRun(b, reachPx) {
    var r = findRun(b, reachPx);
    if (!r) return false;
    var S = SD.state, idx = S.items.indexOf(r.item), g = SD.tools.grabIndex(r.copy);
    var tol = 1.0 / (SD.view.unit() * g.scale), pieces = [];
    r.keep.forEach(function (pl) {
      var pts = pl.filter(function (p, n) { return n === 0 || Math.hypot(p[0] - pl[n - 1][0], p[1] - pl[n - 1][1]) > 1e-6; });
      if (pts.length < 2) return;
      var nodes = pts.length > 20 ? PA.fitPoints(pts, tol) : pts.map(function (p) { return PA.N(p[0], p[1]); });
      if (nodes && nodes.length >= 2) pieces.push(nodes);
    });
    S.items.splice(idx, 1);
    pieces.forEach(function (nodes, n) {
      var it = SD.addItem({ closed: false, nodes: nodes, fill: 'none', stroke: r.item.stroke, sw: r.item.sw, opacity: r.item.opacity });
      S.items.pop(); S.items.splice(idx + n, 0, it);   // 元の重ね順の位置へ
    });
    S.sel = []; S.selPts = [];
    return true;
  }

  SD.faces = { faces: faces, faceAt: faceAt, unite: unite, ringToNodes: ringToNodes, findRun: findRun, eraseRun: eraseRun };
})();
