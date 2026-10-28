/* ============================================================================
   dual_view.js — 正面から見るとA・横から見るとBに見える、閉じた3D曲線を作る（DOM非依存・純関数）。
   正面(x,y)と横(z,y)はyを共有する。点の番号ではなく「同じ高さの点どうし」を対応させる
   （mountain climbing problem の離散解）ので、両方の投影が厳密に満たされる。
   bspline.js などと同じ UMD 形。ブラウザ（グローバル DualView）と node（module.exports）両方で読める。
   ========================================================================== */
(function (root, factory) {
  var DualView = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = DualView;
  if (root) root.DualView = DualView;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;
  var SAMPLES_PER_SEG = 40;

  function evalSeg(s, t) { // bspline.js の evalSegXY と同じ式
    if (s.type === 'L') return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    var u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [
      w0 * s.p0[0] + w1 * s.p1[0] + w2 * s.p2[0] + w3 * s.p3[0],
      w0 * s.p0[1] + w1 * s.p1[1] + w2 * s.p2[1] + w3 * s.p3[1]
    ];
  }
  function segStart(s) { return s.type === 'L' ? s.a : s.p0; }
  function segEnd(s) { return s.type === 'L' ? s.b : s.p3; }

  /* segs → 密な閉じた折れ線（先頭を末尾に重複させない）。閉じていなければ null */
  function denseClosed(segs) {
    if (!Array.isArray(segs) || segs.length < 2) return null;
    var pts = [], i, k, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (i = 0; i < segs.length; i++) {
      for (k = 0; k < SAMPLES_PER_SEG; k++) {
        var p = evalSeg(segs[i], k / SAMPLES_PER_SEG);
        if (!isFinite(p[0]) || !isFinite(p[1])) return null;
        pts.push(p);
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
    }
    var tol = Math.max(1e-9, 1e-6 * Math.hypot(maxX - minX, maxY - minY));
    for (i = 0; i < segs.length; i++) {
      var e = segEnd(segs[i]), st = segStart(segs[(i + 1) % segs.length]);
      if (Math.hypot(e[0] - st[0], e[1] - st[1]) > tol) return null; // 端がつながっていない＝閉じていない
    }
    return pts.length > MAX_DENSE ? thinClosed(pts, MAX_DENSE) : pts;
  }
  /* 点が多すぎる折れ線（Illustrator のトレース等）は弧長で等間隔に間引く。山登りの状態数（A×B）を抑えるため */
  var MAX_DENSE = 600;
  function thinClosed(pts, count) {
    var n = pts.length, cum = [0], i;
    for (i = 0; i < n; i++) { var a = pts[i], b = pts[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    var total = cum[n], out = [], seg = 0;
    if (!(total > 0)) return pts;
    for (i = 0; i < count; i++) {
      var d = (i / count) * total;
      while (seg < n - 1 && cum[seg + 1] <= d) seg++;
      var len = cum[seg + 1] - cum[seg], t = len > 0 ? (d - cum[seg]) / len : 0;
      var p0 = pts[seg], p1 = pts[(seg + 1) % n];
      out.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
    }
    return out;
  }

  function firstIndexOf(pts, comp) { // comp(a,b): aがbより「上」なら true
    var best = 0;
    for (var i = 1; i < pts.length; i++) if (comp(pts[i][1], pts[best][1])) best = i;
    return best;
  }

  /* 閉じた折れ線を最上点（y最小）→最下点（y最大）の2本の弧にする（どちらも上→下の向き） */
  function splitArcs(pts) {
    var n = pts.length;
    var top = firstIndexOf(pts, function (a, b) { return a < b; });
    var bot = firstIndexOf(pts, function (a, b) { return a > b; });
    var arc1 = [], arc2 = [], i;
    for (i = top; ; i = (i + 1) % n) { arc1.push(pts[i]); if (i === bot) break; }
    for (i = top; ; i = (i - 1 + n) % n) { arc2.push(pts[i]); if (i === bot) break; }
    return [arc1, arc2];
  }

  /* 高さ→レベル（ε=1e-9で同一視した整数番号）の表 */
  function buildLevels(heights) {
    var s = heights.slice().sort(function (a, b) { return a - b; });
    var hs = [];
    for (var i = 0; i < s.length; i++) if (!hs.length || s[i] - hs[hs.length - 1] > EPS) hs.push(s[i]);
    return hs;
  }
  function levelOf(hs, y) { // 最も近いレベル（二分探索）
    var lo = 0, hi = hs.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (hs[mid] < y) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(hs[lo - 1] - y) <= Math.abs(hs[lo] - y)) lo--;
    return lo;
  }

  /* 弧の各辺が「隣のレベル1段」か「水平」になるよう、途中のレベル交差点を挿入する。
     戻り値: {x:[…], lv:[…]}（xは弧上の座標・lvはレベル番号） */
  function levelize(arc, hs) {
    var xs = [], lv = [];
    for (var i = 0; i < arc.length; i++) {
      var l = levelOf(hs, arc[i][1]);
      if (i > 0) {
        var pl = lv[lv.length - 1], px = arc[i - 1][0], py = arc[i - 1][1];
        var step = l > pl ? 1 : -1;
        for (var m = pl + step; l !== pl && m !== l; m += step) {
          var t = (hs[m] - py) / (arc[i][1] - py);
          xs.push(px + (arc[i][0] - px) * t); lv.push(m);
        }
      }
      xs.push(arc[i][0]); lv.push(l);
    }
    return { x: xs, lv: lv };
  }

  /* 山登り: (A弧の頂点, B弧の頂点) の組でレベルが同じものをBFSでたどり、(0,0)→(末尾,末尾) の経路を返す。
     戻り値: [[i,j],…] または null */
  function climb(a, b) {
    var nA = a.lv.length, nB = b.lv.length, total = nA * nB;
    if (total > 2e8) return null; // 到達情報は1状態1バイト＝200MBまで
    var MOVES = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    var from = new Uint8Array(total); // 0=未到達・k+1=MOVES[k]で来た（逆向きにたどると親）
    var queue = [0], qh = 0, goal = (nA - 1) * nB + (nB - 1);
    from[0] = 255;
    function push(i, j, k) {
      var id = i * nB + j;
      if (from[id]) return;
      from[id] = k + 1; queue.push(id);
    }
    while (qh < queue.length) {
      var cur = queue[qh++];
      if (cur === goal) break;
      var i = (cur / nB) | 0, j = cur - i * nB, L = a.lv[i], k, i2, j2;
      for (k = 0; k < MOVES.length; k++) {
        i2 = i + MOVES[k][0]; j2 = j + MOVES[k][1];
        if (i2 < 0 || i2 >= nA || j2 < 0 || j2 >= nB) continue;
        if (a.lv[i2] !== b.lv[j2]) continue;                 // 同じレベルへ
        if (MOVES[k][0] === 0 && b.lv[j2] !== L) continue;   // Bだけ進むのはBの辺が水平な時
        if (MOVES[k][1] === 0 && a.lv[i2] !== L) continue;   // Aだけ進むのはAの辺が水平な時
        push(i2, j2, k);
      }
    }
    if (!from[goal]) return null;
    var path = [];
    for (var id = goal; ; ) {
      var ci = (id / nB) | 0, cj = id - ci * nB;
      path.push([ci, cj]);
      if (id === 0) break;
      var mv = MOVES[from[id] - 1];
      id = (ci - mv[0]) * nB + (cj - mv[1]);
    }
    return path.reverse();
  }

  function build(segsA, segsB, opts) {
    var dA = denseClosed(segsA), dB = denseClosed(segsB);
    if (!dA) return { ok: false, pts: [], error: '正面のパスが閉じていません（閉じたパスが必要です）' };
    if (!dB) return { ok: false, pts: [], error: '横から見た形のパスが閉じていません（閉じたパスが必要です）' };
    var i, aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity, bxMin = Infinity, bxMax = -Infinity;
    for (i = 0; i < dA.length; i++) { aMin = Math.min(aMin, dA[i][1]); aMax = Math.max(aMax, dA[i][1]); }
    for (i = 0; i < dB.length; i++) {
      bMin = Math.min(bMin, dB[i][1]); bMax = Math.max(bMax, dB[i][1]);
      bxMin = Math.min(bxMin, dB[i][0]); bxMax = Math.max(bxMax, dB[i][0]);
    }
    var hA = aMax - aMin, hB = bMax - bMin;
    if (!(hA > EPS) || !(hB > EPS)) return { ok: false, pts: [], error: '高さが0のパスは使えません' };
    var k = hA / hB, bxC = (bxMin + bxMax) / 2;
    // B: x→z（中心から一様拡大縮小）・y→Aの高さの範囲へ。(z,y)の点列にする
    var sB = dB.map(function (p) { return [(p[0] - bxC) * k, aMin + (p[1] - bMin) * k]; });

    var arcsA = splitArcs(dA), arcsB = splitArcs(sB);
    var heights = [];
    for (i = 0; i < dA.length; i++) heights.push(dA[i][1]);
    for (i = 0; i < sB.length; i++) heights.push(sB[i][1]);
    var hs = buildLevels(heights);

    var halves = [];
    for (var h = 0; h < 2; h++) {
      var la = levelize(arcsA[h], hs), lb = levelize(arcsB[h], hs);
      var path = climb(la, lb);
      if (!path) return { ok: false, pts: [], error: '2つの形を同じ高さで対応させる経路が見つかりません' };
      halves.push(path.map(function (st) { return [la.x[st[0]], hs[la.lv[st[0]]], lb.x[st[1]]]; }));
    }
    var seq = halves[0].concat(halves[1].slice().reverse()), pts = [];
    for (i = 0; i < seq.length; i++) {
      var p = seq[i], q = pts[pts.length - 1];
      if (q && Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS && Math.abs(p[2] - q[2]) < EPS) continue;
      pts.push(p);
    }
    while (pts.length > 1) { // 先頭と末尾の重複を除く
      var f = pts[0], l = pts[pts.length - 1];
      if (Math.abs(f[0] - l[0]) < EPS && Math.abs(f[1] - l[1]) < EPS && Math.abs(f[2] - l[2]) < EPS) pts.pop(); else break;
    }
    if (pts.length < 3) return { ok: false, pts: [], error: '3D曲線を作れませんでした' };
    return { ok: true, pts: pts, error: '' };
  }

  /* 閉じた3D折れ線を、3D弧長で等間隔にcount点へ */
  function resampleClosed3D(pts, count) {
    var n = pts.length, i;
    if (n < 2 || !(count >= 1)) return pts.map(function (p) { return p.slice(); });
    var cum = [0];
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    var total = cum[n], out = [], seg = 0;
    if (!(total > 0)) return pts.map(function (p) { return p.slice(); });
    for (i = 0; i < count; i++) {
      var d = (i / count) * total;
      while (seg < n - 1 && cum[seg + 1] <= d) seg++;
      var len = cum[seg + 1] - cum[seg], t = len > 0 ? (d - cum[seg]) / len : 0;
      var p0 = pts[seg], p1 = pts[(seg + 1) % n];
      out.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t]);
    }
    return out;
  }

  return { build: build, resampleClosed3D: resampleClosed3D };
});
