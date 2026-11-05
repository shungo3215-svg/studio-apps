/* ============================================================================
   curve-fit.js — 点列を少ないアンカーのベジェに当てはめる共通部品（依存なし・DOM非依存）。
   書き出すパスのアンカーを必要最小限にする（規格 006 §4-9「アンカーは必要最小限・
   許容誤差つきでフィット」）。アルゴリズムは Schneider の最小二乗3次ベジェ当てはめ
   （Graphics Gems「An Algorithm for Automatically Fitting Digitized Curves」）。
   157_線幅の抑揚/src/fit.js（許容誤差 0.5 で 218→47 アンカーにした実績）が元。

   公開: window.StudioCurveFit（Studio があれば Studio.curveFit も同じ物）。Node では module.exports。

   API
     fitPolyline(points, {tol, closed, corners, cornerAngle}) -> segs
        points : [[x,y],…] または [x,y,x,y,…]
        tol    : 許容誤差。入力の全点から、できた曲線までの距離の上限（既定 0.5・入力と同じ単位）
        closed : 閉じた点列（末尾が先頭と同じ点でも可）
        corners: 角にする入力点の番号の配列。角では曲線を必ず切り、両側の接線は別々になる
        cornerAngle: 折れ線の曲がり角がこの度数を超える点を自動で角にする（既定 50。0 なら自動検出しない）
        cornerSpan : 角の判定に使う弧長（既定 0=隣の点との角度）
        戻り値 segs: [{t:'M',x,y,i}, {t:'L',x,y,i}, {t:'C',x1,y1,x2,y2,x,y,i}, …, {t:'Z'}]
                    i は終点にあたる入力点の番号、sharp:true は角
     toD(segs, digits=2) -> SVG の d 文字列
     fitSequence(frames, {tol, closed, corners, cornerAngle}) -> segs の配列
        点の数が同じ連番の点列（アニメーションの各コマ）を、全コマで同じアンカー構成（個数・順序・M/C）
        に当てはめる。全コマの誤差が tol 以内になるまでアンカーを足す。
     detectCorners(points, closed, angleDeg=50, spanLen=0) -> 角の番号の配列（spanLen は弧長。細かい折れ線の丸まった角用）
     catmullRomPolyline(points, {closed, tension, corners, sub}) -> {pts, corners}
        Catmull-Rom 曲線（角の所で切る）を折れ線に刻む。曲線を見た目どおり fitPolyline に渡す用
     maxDeviation(points, segs, closed) -> 入力の全点から曲線までの最大距離（検査用）
   ========================================================================== */
(function (root, factory) {
  var Api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Api;
  if (root) {
    root.StudioCurveFit = Api;
    if (root.Studio) root.Studio.curveFit = Api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) { var l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; }
  function dist(a, b) { return len(sub(a, b)); }

  function toPairs(points) {
    if (!points || !points.length) return [];
    if (typeof points[0] === 'number') {
      var out = [];
      for (var i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]]);
      return out;
    }
    return points;
  }

  /* ---------- Schneider ---------- */
  function chordLengthParameterize(pts) {
    var u = [0];
    for (var i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i], pts[i - 1]));
    var total = u[u.length - 1] || 1;
    for (var j = 0; j < u.length; j++) u[j] /= total;
    return u;
  }
  function bezierPoint(ctrl, t) {
    var u = 1 - t;
    var w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [
      w0 * ctrl[0][0] + w1 * ctrl[1][0] + w2 * ctrl[2][0] + w3 * ctrl[3][0],
      w0 * ctrl[0][1] + w1 * ctrl[1][1] + w2 * ctrl[2][1] + w3 * ctrl[3][1]
    ];
  }
  function b0(t) { var u = 1 - t; return u * u * u; }
  function b1(t) { var u = 1 - t; return 3 * t * u * u; }
  function b2(t) { var u = 1 - t; return 3 * t * t * u; }
  function b3(t) { return t * t * t; }

  function generateBezier(pts, u, t1Hat, t2Hat) {
    var n = pts.length, p0 = pts[0], p3 = pts[n - 1];
    var C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
    for (var i = 0; i < n; i++) {
      var a1 = mul(t1Hat, b1(u[i])), a2 = mul(t2Hat, b2(u[i]));
      C00 += dot(a1, a1); C01 += dot(a1, a2); C11 += dot(a2, a2);
      var tmp = sub(pts[i], add(mul(p0, b0(u[i]) + b1(u[i])), mul(p3, b2(u[i]) + b3(u[i]))));
      X0 += dot(a1, tmp); X1 += dot(a2, tmp);
    }
    var det = C00 * C11 - C01 * C01, alpha1, alpha2;
    if (Math.abs(det) > 1e-12) { alpha1 = (X0 * C11 - X1 * C01) / det; alpha2 = (C00 * X1 - C01 * X0) / det; }
    else alpha1 = alpha2 = 0;
    var segLen = dist(p3, p0), eps = 1e-6 * (segLen || 1);
    if (alpha1 < eps || alpha2 < eps) alpha1 = alpha2 = segLen / 3;
    return [p0, add(p0, mul(t1Hat, alpha1)), add(p3, mul(t2Hat, alpha2)), p3];
  }
  function newtonRaphson(ctrl, point, u) {
    var qU = bezierPoint(ctrl, u);
    function derivPts(pts) { var o = []; for (var i = 0; i < pts.length - 1; i++) o.push(mul(sub(pts[i + 1], pts[i]), pts.length - 1)); return o; }
    var d1 = derivPts(ctrl), d2 = derivPts(d1);
    function evalD(pts, t) {
      var w = 1 - t;
      if (pts.length === 3) return [w * w * pts[0][0] + 2 * w * t * pts[1][0] + t * t * pts[2][0], w * w * pts[0][1] + 2 * w * t * pts[1][1] + t * t * pts[2][1]];
      return [w * pts[0][0] + t * pts[1][0], w * pts[0][1] + t * pts[1][1]];
    }
    var qp = evalD(d1, u), qpp = evalD(d2, u);
    var num = dot(sub(qU, point), qp), den = dot(qp, qp) + dot(sub(qU, point), qpp);
    if (Math.abs(den) < 1e-12) return u;
    return u - num / den;
  }
  function reparameterize(pts, u, ctrl) {
    var o = [];
    for (var i = 0; i < pts.length; i++) o.push(newtonRaphson(ctrl, pts[i], u[i]));
    return o;
  }
  function computeMaxError(pts, u, ctrl) {
    var maxD = 0, idx = Math.floor(pts.length / 2);
    for (var i = 0; i < pts.length; i++) {
      var d = dist(bezierPoint(ctrl, u[i]), pts[i]), d2 = d * d;
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    return { maxError: Math.sqrt(maxD), splitIdx: idx };
  }
  /* 1本のベジェを当てる（反復でパラメータを改善）。戻り値 {ctrl, err, worst} */
  function fitOne(pts, t1Hat, t2Hat, tol) {
    var u = chordLengthParameterize(pts);
    var ctrl = generateBezier(pts, u, t1Hat, t2Hat);
    var me = computeMaxError(pts, u, ctrl), uCur = u;
    for (var it = 0; it < 4 && me.maxError >= tol; it++) {
      var up = reparameterize(pts, uCur, ctrl);
      var c2 = generateBezier(pts, up, t1Hat, t2Hat);
      var m2 = computeMaxError(pts, up, c2);
      if (m2.maxError < me.maxError) { ctrl = c2; me = m2; uCur = up; } else break;
    }
    return { ctrl: ctrl, err: me.maxError, worst: me.splitIdx };
  }
  /* 再帰で分割。off = pts[0] の元配列での番号。戻り値 [{c1,c2,p,idx}]（idx は終点の元番号） */
  function fitCubic(pts, off, t1Hat, t2Hat, tol, depth) {
    var n = pts.length;
    if (n < 2) return [];
    if (n === 2) {
      var d = dist(pts[1], pts[0]) / 3;
      return [{ c1: add(pts[0], mul(t1Hat, d)), c2: add(pts[1], mul(t2Hat, d)), p: pts[1], idx: off + 1 }];
    }
    var r = fitOne(pts, t1Hat, t2Hat, tol);
    var whole = [{ c1: r.ctrl[1], c2: r.ctrl[2], p: r.ctrl[3], idx: off + n - 1 }];
    if (r.err < tol || depth >= 40) return whole;
    var s = Math.max(1, Math.min(n - 2, r.worst));
    var tc = normalize(sub(pts[s - 1], pts[s + 1]));
    if (len(tc) < 1e-9) tc = normalize(sub(pts[s], pts[s - 1]));
    var left = fitCubic(pts.slice(0, s + 1), off, t1Hat, tc, tol, depth + 1);
    var right = fitCubic(pts.slice(s), off + s, mul(tc, -1), t2Hat, tol, depth + 1);
    return left.concat(right);
  }

  /* ---------- 角の検出 ---------- */
  /* 曲がり角が angleDeg（既定 50）を超える点を角にする。
     spanLen を指定すると、前後それぞれ弧長 spanLen だけ離れた点との方向差で測る（細かく刻まれた折れ線で、
     角が数点にまたがって丸まっていても1つの角として拾う。連続する候補のうち最大の点だけ残す）。 */
  function detectCorners(points, closed, angleDeg, spanLen) {
    var P = toPairs(points), n = P.length, out = [];
    if (angleDeg == null) angleDeg = 50;
    if (!(angleDeg > 0) || n < 3) return out;
    var cosT = Math.cos(angleDeg * Math.PI / 180);
    var lo = closed ? 0 : 1, hi = closed ? n : n - 1, i;
    if (!(spanLen > 0)) {
      for (i = lo; i < hi; i++) {
        var a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n];
        var v1 = sub(b, a), v2 = sub(c, b), l1 = len(v1), l2 = len(v2);
        if (l1 < 1e-9 || l2 < 1e-9) continue;
        if (dot(v1, v2) / (l1 * l2) < cosT) out.push(i);   // 進行方向どうしの内積 = cos(曲がり角)
      }
      return out;
    }
    var turn = new Array(n);
    for (i = 0; i < n; i++) turn[i] = -1;
    for (i = lo; i < hi; i++) {
      var A = P[i], B = P[i], acc = 0, k = i;
      for (var s = 1; s < n; s++) {                         // 後ろへ弧長 spanLen
        var kk = closed ? (i - s + n) % n : i - s;
        if (kk < 0) break;
        acc += dist(P[(kk + 1) % n], P[kk]); k = kk; A = P[kk];
        if (acc >= spanLen) break;
      }
      acc = 0;
      for (s = 1; s < n; s++) {                             // 前へ弧長 spanLen
        var kf = closed ? (i + s) % n : i + s;
        if (kf > n - 1) break;
        acc += dist(P[kf], P[(kf - 1 + n) % n]); B = P[kf];
        if (acc >= spanLen) break;
      }
      var w1 = sub(P[i], A), w2 = sub(B, P[i]), m1 = len(w1), m2 = len(w2);
      if (m1 < 1e-9 || m2 < 1e-9) continue;
      var cs = dot(w1, w2) / (m1 * m2);
      if (cs < cosT) turn[i] = Math.acos(Math.max(-1, Math.min(1, cs)));
    }
    // 近い候補のうち曲がりが最大の点だけ残す（弧長 spanLen 以内で最大）
    for (i = lo; i < hi; i++) {
      if (turn[i] < 0) continue;
      var best = true, acc2 = 0;
      for (s = 1; s < n && best; s++) {
        var jb = closed ? (i - s + n) % n : i - s;
        if (jb < 0) break;
        acc2 += dist(P[(jb + 1) % n], P[jb]);
        if (acc2 > spanLen) break;
        if (turn[jb] > turn[i] || (turn[jb] === turn[i] && jb < i)) best = false;
      }
      acc2 = 0;
      for (s = 1; s < n && best; s++) {
        var jf = closed ? (i + s) % n : i + s;
        if (jf > n - 1) break;
        acc2 += dist(P[jf], P[(jf - 1 + n) % n]);
        if (acc2 > spanLen) break;
        if (turn[jf] > turn[i]) best = false;
      }
      if (best) out.push(i);
    }
    return out;
  }

  /* ---------- 直線の判定 ---------- */
  function distToLine(p, a, b) {
    var d = sub(b, a), L = len(d);
    if (L < 1e-12) return dist(p, a);
    return Math.abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / L;
  }
  function allNear(pts, a, b, thr) {
    if (dist(a, b) < 1e-9) return false;
    for (var i = 1; i < pts.length - 1; i++) if (distToLine(pts[i], a, b) > thr) return false;
    return true;
  }
  /* 制御点が弦の上にあるベジェ（実質の直線）か */
  function curveIsLine(p0, c1, c2, p3, thr) {
    var L = dist(p0, p3);
    if (L < 1e-9) return false;
    if (distToLine(c1, p0, p3) > thr || distToLine(c2, p0, p3) > thr) return false;
    var d = [(p3[0] - p0[0]) / L, (p3[1] - p0[1]) / L];
    var s1 = dot(sub(c1, p0), d), s2 = dot(sub(c2, p0), d);
    return s1 >= -thr && s1 <= L + thr && s2 >= -thr && s2 <= L + thr;
  }

  /* ---------- 自由当てはめ（分割位置は誤差で決める） ----------
     P: 重複のない点列。corner: 角の番号の昇順配列。
     戻り値 {start:{p,i}, curves:[{c1,c2,p,i,line,sharp}]}（i は P の番号。閉路の最後は start に戻る） */
  function freeFit(P, closed, corner, tol) {
    var n = P.length, curves = [], isCorner = {}, k;
    for (k = 0; k < corner.length; k++) isCorner[corner[k]] = true;

    function runInto(Q, a, b, t1, t2, rot) {
      // Q[a..b] を1ランとして当てる。rot は元番号への回転量
      var seg = Q.slice(a, b + 1), res = [], m;
      if (b - a === 1) {
        res = [{ line: true, p: Q[b], idx: b }];
      } else if (allNear(seg, Q[a], Q[b], tol * 0.5)) {
        res = [{ line: true, p: Q[b], idx: b }];
      } else {
        var cs = fitCubic(seg, a, t1, t2, tol, 0), prev = Q[a];
        for (m = 0; m < cs.length; m++) {
          var c = cs[m];
          if (curveIsLine(prev, c.c1, c.c2, c.p, 0.02)) res.push({ line: true, p: c.p, idx: c.idx });
          else res.push({ c1: c.c1, c2: c.c2, p: c.p, idx: c.idx });
          prev = c.p;
        }
      }
      for (m = 0; m < res.length; m++) {
        res[m].i = n ? (res[m].idx + rot) % n : res[m].idx;
        res[m].sharp = !!isCorner[res[m].i];
        curves.push(res[m]);
      }
    }
    function oneSided(Q, a, b) {
      var t1 = normalize(sub(Q[a + 1], Q[a])), t2 = normalize(sub(Q[b - 1], Q[b]));
      if (len(t1) < 1e-9) t1 = [1, 0];
      if (len(t2) < 1e-9) t2 = [-1, 0];
      return [t1, t2];
    }

    if (!closed) {
      var cuts = [0], cc;
      for (k = 0; k < corner.length; k++) if (corner[k] > 0 && corner[k] < n - 1) cuts.push(corner[k]);
      cuts.push(n - 1);
      for (k = 0; k + 1 < cuts.length; k++) {
        cc = oneSided(P, cuts[k], cuts[k + 1]);
        runInto(P, cuts[k], cuts[k + 1], cc[0], cc[1], 0);
      }
      return { start: { p: P[0], i: 0 }, curves: curves };
    }

    // 閉じた点列
    function tc(i) { return normalize(sub(P[(i - 1 + n) % n], P[(i + 1) % n])); }   // 後ろ向きの中心接線
    if (!corner.length) {
      // 角なし: 弧長の半分の点で2つに割り、つなぎ目は両側で同じ接線にする
      var cum = [0], j;
      for (j = 1; j <= n; j++) cum.push(cum[j - 1] + dist(P[j % n], P[j - 1]));
      var half = cum[n] / 2, m = 1;
      for (j = 1; j < n; j++) if (Math.abs(cum[j] - half) < Math.abs(cum[m] - half)) m = j;
      var Q = P.concat([P[0]]);
      var tA = tc(0), tM = tc(m);
      runInto(Q, 0, m, mul(tA, -1), tM, 0);
      runInto(Q, m, n, mul(tM, -1), tA, 0);
      return { start: { p: P[0], i: 0 }, curves: curves };
    }
    // 角あり: 最初の角から始めて、角から角までを1ランずつ当てる
    var rot = corner[0], R = [];
    for (k = 0; k < n; k++) R.push(P[(k + rot) % n]);
    R.push(R[0]);
    var rc = [];
    for (k = 0; k < corner.length; k++) rc.push((corner[k] - rot + n) % n);
    rc.sort(function (x, y) { return x - y; });
    rc.push(n);
    for (k = 0; k + 1 < rc.length; k++) {
      cc = oneSided(R, rc[k], rc[k + 1]);
      runInto(R, rc[k], rc[k + 1], cc[0], cc[1], rot);
    }
    return { start: { p: P[rot], i: rot, sharp: true }, curves: curves };
  }

  /* ---------- 固定当てはめ（アンカー位置を指定。各コマで同じ構成にする用） ----------
     1ランを1本のベジェで当てる。a,b は P の番号（閉路で b<=a なら1周ぶん足して数える）。 */
  function fitRunFixed(P, closed, a, b, sharpA, sharpB) {
    var n = P.length;
    if (closed && b <= a) b += n;
    var seg = [];
    for (var q = a; q <= b; q++) seg.push(P[q % n]);
    function tcAt(i) {
      if (closed) return normalize(sub(P[(i - 1 + n) % n], P[(i + 1) % n]));
      if (i <= 0 || i >= n - 1) return null;
      return normalize(sub(P[i - 1], P[i + 1]));
    }
    var t1, t2, c;
    if (sharpA || !(c = tcAt(a % n))) t1 = normalize(sub(seg[1], seg[0]));
    else t1 = mul(c, -1);
    if (sharpB || !(c = tcAt(b % n))) t2 = normalize(sub(seg[seg.length - 2], seg[seg.length - 1]));
    else t2 = c;
    if (len(t1) < 1e-9) t1 = [1, 0];
    if (len(t2) < 1e-9) t2 = [-1, 0];
    var one;
    if (seg.length === 2) {
      var d = dist(seg[1], seg[0]) / 3;
      one = { ctrl: [seg[0], add(seg[0], mul(t1, d)), add(seg[1], mul(t2, d)), seg[1]], err: 0, worst: 0 };
    } else one = fitOne(seg, t1, t2, 0);
    return { c1: one.ctrl[1], c2: one.ctrl[2], p: one.ctrl[3], i: b % n, err: one.err, worst: (a + one.worst) % n };
  }
  /* anchors: [{i, sharp}] 番号の昇順。閉路なら最後のアンカーから最初のアンカーへ戻るランも作る。 */
  function fixedFit(P, closed, anchors) {
    var m = anchors.length, curves = [], runs = closed ? m : m - 1;
    for (var k = 0; k < runs; k++) {
      var A = anchors[k], B = anchors[(k + 1) % m];
      var c = fitRunFixed(P, closed, A.i, B.i, A.sharp, B.sharp);
      c.sharp = !!B.sharp;
      curves.push(c);
    }
    return { start: { p: P[anchors[0].i], i: anchors[0].i, sharp: !!anchors[0].sharp }, curves: curves };
  }

  /* 指定したアンカーで区切り、誤差が許容を超えるランだけ最大誤差の点で割る（割った所は滑らか） */
  function fitFromAnchors(P, closed, anchors, tol) {
    var n = P.length, m = anchors.length, curves = [], runs = closed ? m : m - 1;
    function run(a, sa, b, sb, depth) {
      var c = fitRunFixed(P, closed, a, b, sa, sb), span = (closed && b <= a) ? b + n - a : b - a;
      if (c.err < tol || span < 2 || depth > 30) { c.sharp = sb; return [c]; }
      var w = c.worst, off = ((w - a) % n + n) % n;
      if (off < 1 || off >= span) w = (a + Math.floor(span / 2)) % n;
      return run(a, sa, w, false, depth + 1).concat(run(w, false, b, sb, depth + 1));
    }
    for (var k = 0; k < runs; k++) {
      var A = anchors[k], B = anchors[(k + 1) % m];
      curves = curves.concat(run(A.i, !!A.sharp, B.i, !!B.sharp, 0));
    }
    return { start: { p: P[anchors[0].i], i: anchors[0].i, sharp: !!anchors[0].sharp }, curves: curves };
  }

  /* 自由当てはめの結果から、誤差が許容内に収まる限り滑らかなアンカーを減らす（分割は
     「最大誤差の所で割る」ため、必要より1〜2個多くなりやすい）。始点・角・直線の両端は減らさない。 */
  function mergeAnchors(P, closed, fit, tol) {
    var runs = fit.curves.map(function (c, k) {
      return { a: k ? fit.curves[k - 1].i : fit.start.i, sharpA: k ? fit.curves[k - 1].sharp : (closed ? !!fit.start.sharp : true), c: c };
    });
    var changed = true;
    while (changed && runs.length > 1) {
      changed = false;
      for (var r = 0; r + 1 < runs.length; r++) {
        var x = runs[r], y = runs[r + 1];
        if (x.c.sharp || x.c.line || y.c.line) continue;
        var nc = fitRunFixed(P, closed, x.a, y.c.i, x.sharpA, y.c.sharp);
        if (nc.err < tol * 0.98) {
          nc.sharp = y.c.sharp;
          runs.splice(r, 2, { a: x.a, sharpA: x.sharpA, c: nc });
          changed = true; break;
        }
      }
    }
    return { start: fit.start, curves: runs.map(function (x) { return x.c; }) };
  }

  /* ---------- 出力の組み立て ---------- */
  function toSegs(fit, closed, map) {
    var mp = function (i) { return map ? map[i] : i; };
    var segs = [{ t: 'M', x: fit.start.p[0], y: fit.start.p[1], i: mp(fit.start.i) }];
    var cs = fit.curves, last = cs.length - 1;
    for (var k = 0; k < cs.length; k++) {
      var c = cs[k];
      if (c.line) {
        if (closed && k === last) continue;       // 最後の直線は Z が引くので不要
        segs.push({ t: 'L', x: c.p[0], y: c.p[1], i: mp(c.i), sharp: c.sharp });
      } else {
        segs.push({ t: 'C', x1: c.c1[0], y1: c.c1[1], x2: c.c2[0], y2: c.c2[1], x: c.p[0], y: c.p[1], i: mp(c.i), sharp: c.sharp });
      }
    }
    if (closed) segs.push({ t: 'Z' });
    return segs;
  }

  function prepare(points, opts) {
    opts = opts || {};
    var raw = toPairs(points), P = [], keep = [], i;
    for (i = 0; i < raw.length; i++) {
      if (!P.length || dist(P[P.length - 1], raw[i]) > 1e-9) { P.push(raw[i]); keep.push(i); }
    }
    var closed = !!opts.closed;
    if (closed && P.length > 1 && dist(P[0], P[P.length - 1]) <= 1e-9) { P.pop(); keep.pop(); }
    var back = {};                                   // 元の番号 -> P の番号
    for (i = 0; i < keep.length; i++) back[keep[i]] = i;
    var cs = {};
    var ang = opts.cornerAngle == null ? 50 : opts.cornerAngle;
    detectCorners(P, closed, ang, opts.cornerSpan).forEach(function (c) { cs[c] = true; });
    (opts.corners || []).forEach(function (c) {
      if (back[c] != null) cs[back[c]] = true;
      else {                                         // 重複で消えた番号は直前の残った点に寄せる
        var j = c; while (j >= 0 && back[j] == null) j--;
        if (j >= 0) cs[back[j]] = true;
      }
    });
    var corner = Object.keys(cs).map(Number).sort(function (a, b) { return a - b; });
    return { P: P, keep: keep, closed: closed, corner: corner };
  }

  function fitPolyline(points, opts) {
    opts = opts || {};
    var tol = opts.tol == null ? 0.5 : opts.tol;
    var pr = prepare(points, opts), P = pr.P;
    if (P.length < 2) return [];
    if (P.length === 2 || (pr.closed && P.length < 3)) {
      return [{ t: 'M', x: P[0][0], y: P[0][1], i: pr.keep[0] }, { t: 'L', x: P[1][0], y: P[1][1], i: pr.keep[1] }];
    }
    var Q = P, keep = pr.keep;
    if (pr.closed && !pr.corner.length && opts.rotate !== false) {
      // 角のない閉路は、いちばん左の点を始点にする（円や楕円で、アンカーが上下左右の端に乗りやすく編集しやすい）
      var r0 = 0, n = P.length, j;
      for (j = 1; j < n; j++) if (P[j][0] < P[r0][0] - 1e-9) r0 = j;
      Q = P.slice(r0).concat(P.slice(0, r0));
      keep = pr.keep.slice(r0).concat(pr.keep.slice(0, r0));
    }
    var fit = freeFit(Q, pr.closed, pr.corner, tol);
    if (opts.merge !== false) fit = mergeAnchors(Q, pr.closed, fit, tol);
    if (pr.closed && !pr.corner.length && opts.rotate !== false && Q.length >= 8) {
      // 上下左右の端の点をアンカーにした当てはめも試し、アンカー数が同じか少ないならそちらを採る（円・楕円が端で切れる）
      var ex = {}, q, ix = [0, 0, 0, 0];
      for (q = 1; q < Q.length; q++) {
        if (Q[q][0] < Q[ix[0]][0]) ix[0] = q;
        if (Q[q][0] > Q[ix[1]][0]) ix[1] = q;
        if (Q[q][1] < Q[ix[2]][1]) ix[2] = q;
        if (Q[q][1] > Q[ix[3]][1]) ix[3] = q;
      }
      ix.forEach(function (v) { ex[v] = true; });
      var al = Object.keys(ex).map(Number).sort(function (x, y) { return x - y; }).map(function (v) { return { i: v, sharp: false }; });
      if (al.length >= 2) {
        var f2 = fitFromAnchors(Q, true, al, tol);
        if (opts.merge !== false) f2 = mergeAnchors(Q, true, f2, tol);
        if (f2.curves.length <= fit.curves.length) fit = f2;
      }
    }
    return toSegs(fit, pr.closed, keep);
  }

  /* ---------- 連番（全コマで同じ構成） ---------- */
  function fitSequence(frames, opts) {
    opts = opts || {};
    var tol = opts.tol == null ? 0.5 : opts.tol;
    var closed = !!opts.closed, F = frames.map(toPairs), nF = F.length;
    if (!nF) return [];
    var n = F[0].length;
    if (n < 3 || (!closed && n < 2)) return F.map(function (P) { return fitPolyline(P, { tol: tol, closed: closed }); });

    // 角 = 指定 ∪ 全コマで検出した角
    var cs = {}, ang = opts.cornerAngle == null ? 50 : opts.cornerAngle, f;
    (opts.corners || []).forEach(function (c) { cs[c] = true; });
    for (f = 0; f < nF; f++) detectCorners(F[f], closed, ang, opts.cornerSpan).forEach(function (c) { cs[c] = true; });
    var corner = Object.keys(cs).map(Number).sort(function (a, b) { return a - b; });

    // 最初の構成: 角と、始点・中間点（閉路）または両端（開）だけ。ここから、全コマの誤差が許容内になるまで
    // 「超えたランの最大誤差の点」にアンカーを足し、足りすぎた分を後で減らす
    var anch = {}, isC = {};
    corner.forEach(function (c) { anch[c] = true; isC[c] = true; });
    if (closed) { anch[0] = true; if (!corner.length || corner.length < 2) anch[Math.floor(n / 2)] = true; }
    else { anch[0] = true; anch[n - 1] = true; }
    function list() {
      var a = Object.keys(anch).map(Number).sort(function (x, y) { return x - y; });
      return a.map(function (i) { return { i: i, sharp: !!isC[i] }; });
    }
    var fits = null, round;
    for (round = 0; round < 300; round++) {
      var A = list(), grew = false;
      fits = F.map(function (P) { return fixedFit(P, closed, A); });
      for (var k0 = 0; k0 < fits[0].curves.length; k0++) {
        var wf = -1, we = tol;
        for (f = 0; f < nF; f++) if (fits[f].curves[k0].err > we) { we = fits[f].curves[k0].err; wf = f; }
        if (wf >= 0) {
          var w = fits[wf].curves[k0].worst;
          if (!anch[w]) { anch[w] = true; grew = true; }
        }
      }
      if (!grew) break;
    }
    // 足りすぎたアンカーを減らす（外しても全コマが許容内に収まる滑らかなアンカーだけ）
    var changed = true;
    while (changed) {
      changed = false;
      var L = list();
      if (L.length <= (closed ? 2 : 2)) break;
      for (var q = closed ? 0 : 1; q < (closed ? L.length : L.length - 1); q++) {
        if (L[q].sharp || (closed && q === 0)) continue;
        var pa = L[(q - 1 + L.length) % L.length], nb = L[(q + 1) % L.length], ok = true;
        for (f = 0; f < nF && ok; f++) {
          var rr = fitRunFixed(F[f], closed, pa.i, nb.i, pa.sharp, nb.sharp);
          if (!(rr.err < tol * 0.98)) ok = false;
        }
        if (ok) { delete anch[L[q].i]; changed = true; break; }
      }
    }
    fits = F.map(function (P) { return fixedFit(P, closed, list()); });
    // 全コマで直線に近い区間は、全コマ一斉に L にする（構成を揃えたまま）
    var m = fits[0].curves.length, lineAt = [];
    for (var k = 0; k < m; k++) {
      var allLine = true;
      for (f = 0; f < nF && allLine; f++) {
        var cv = fits[f].curves[k], p0 = k ? fits[f].curves[k - 1].p : fits[f].start.p;
        if (!curveIsLine(p0, cv.c1, cv.c2, cv.p, 0.02)) allLine = false;
      }
      lineAt.push(allLine);
    }
    return fits.map(function (r) {
      r.curves.forEach(function (c, k) { if (lineAt[k]) c.line = true; });
      return toSegs(r, closed, null);
    });
  }

  /* ---------- Catmull-Rom を折れ線に刻む ---------- */
  function catmullRomPolyline(points, opts) {
    opts = opts || {};
    var P = toPairs(points), n = P.length, closed = !!opts.closed;
    var k = (opts.tension == null ? 1 : opts.tension) / 6, S = Math.max(1, opts.sub || 6);
    var isC = {};
    (opts.corners || []).forEach(function (c) { isC[c] = true; });
    var out = [], corners = [];
    if (n < 2) return { pts: P.slice(), corners: [] };
    var at = function (i) { return closed ? P[((i % n) + n) % n] : P[Math.max(0, Math.min(n - 1, i))]; };
    var segN = closed ? n : n - 1;
    for (var i = 0; i < segN; i++) {
      var i1 = (i + 1) % n;
      var p0 = P[i], p1 = P[i1];
      var pm = isC[i] ? p0 : at(i - 1), p2 = isC[i1] ? p1 : at(i + 2);
      var c1 = [p0[0] + (p1[0] - pm[0]) * k, p0[1] + (p1[1] - pm[1]) * k];
      var c2 = [p1[0] - (p2[0] - p0[0]) * k, p1[1] - (p2[1] - p0[1]) * k];
      if (isC[i]) corners.push(out.length);
      for (var s = 0; s < S; s++) out.push(bezierPoint([p0, c1, c2, p1], s / S));
    }
    if (!closed) { out.push(P[n - 1]); }
    return { pts: out, corners: corners };
  }

  /* ---------- 書き出し / 検査 ---------- */
  function fmt(v, digits) {
    var r = v.toFixed(digits).replace(/\.?0+$/, '');
    return r === '' || r === '-0' ? '0' : r;
  }
  function toD(segs, digits) {
    if (digits == null) digits = 2;
    var d = '';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.t === 'M') d += 'M' + fmt(s.x, digits) + ' ' + fmt(s.y, digits);
      else if (s.t === 'L') d += 'L' + fmt(s.x, digits) + ' ' + fmt(s.y, digits);
      else if (s.t === 'C') d += 'C' + fmt(s.x1, digits) + ' ' + fmt(s.y1, digits) + ' ' + fmt(s.x2, digits) + ' ' + fmt(s.y2, digits) + ' ' + fmt(s.x, digits) + ' ' + fmt(s.y, digits);
      else if (s.t === 'Z') d += 'Z';
    }
    return d;
  }
  /* segs を折れ線に刻む（検査・描画の比較用） */
  function flatten(segs, perCurve) {
    perCurve = perCurve || 64;
    var out = [], cur = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.t === 'M') { cur = [s.x, s.y]; out.push(cur); }
      else if (s.t === 'L') { cur = [s.x, s.y]; out.push(cur); }
      else if (s.t === 'C') {
        var c = [cur, [s.x1, s.y1], [s.x2, s.y2], [s.x, s.y]];
        for (var q = 1; q <= perCurve; q++) out.push(bezierPoint(c, q / perCurve));
        cur = [s.x, s.y];
      } else if (s.t === 'Z') { out.push(out[0]); }
    }
    return out;
  }
  function maxDeviation(points, segs) {
    var P = toPairs(points), L = flatten(segs, 200), worst = 0;
    for (var i = 0; i < P.length; i++) {
      var best = Infinity;
      for (var j = 0; j + 1 < L.length; j++) {
        var a = L[j], b = L[j + 1], ab = sub(b, a), l2 = dot(ab, ab);
        var t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(P[i], a), ab) / l2));
        var d = dist(P[i], add(a, mul(ab, t)));
        if (d < best) best = d;
      }
      if (best > worst) worst = best;
    }
    return worst;
  }
  /* アンカー数（M と、閉路で始点に戻る最後の C/L を除いた個数） */
  function countAnchors(segs) {
    var n = 0, closed = false;
    for (var i = 0; i < segs.length; i++) { if (segs[i].t === 'Z') closed = true; else n++; }
    if (closed && n > 1) {
      var m = segs[0], l = segs[segs.length - 2];
      if (l && (l.t === 'C' || l.t === 'L') && Math.abs(l.x - m.x) < 1e-6 && Math.abs(l.y - m.y) < 1e-6) n--;
    }
    return n;
  }

  return {
    fitPolyline: fitPolyline,
    fitSequence: fitSequence,
    toD: toD,
    detectCorners: detectCorners,
    catmullRomPolyline: catmullRomPolyline,
    maxDeviation: maxDeviation,
    countAnchors: countAnchors,
    flatten: flatten,
    bezierPoint: bezierPoint
  };
});
