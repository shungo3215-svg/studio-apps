/* ============================================================================
   fit.js — 段6「書き出しSVGのアンカー数を減らす」の純関数群（DOM非依存）。
   密サンプル点列（1点=1本のベジェになっていた書き出しの原因）に、Schneiderの
   最小二乗3次ベジェ当てはめ（Graphics Gems「An Algorithm for Automatically
   Fitting Digitized Curves」と同じアルゴリズム）を掛けて、少ないアンカー数の
   閉じたベジェパスへ変換する。画面表示（密サンプルそのまま）は一切変えない。
   ユーザー決定（2026-09-25・段6）: 丸めた折り返し部（round-hairpin-corners由来の
   半円弧）も「角」として特別扱いしない＝すでに滑らかなので、誤差だけを基準に
   連続的に当てる（分割は誤差超過のときだけ）。
   ========================================================================== */
(function (root, factory) {
  var Fit = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Fit;
  if (root) root.Fit = Fit;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function normalize(a) { var l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; }

  // 弦長パラメータ化（各点にu(0..1)を割り当てる）
  function chordLengthParameterize(pts) {
    var u = [0];
    for (var i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
    var total = u[u.length - 1] || 1;
    for (var i = 0; i < u.length; i++) u[i] /= total;
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

  // 与えられたu列・両端の接線方向から、最小二乗で制御点(1,2)を求める（Graphics Gems方式）
  function generateBezier(pts, u, t1Hat, t2Hat) {
    var n = pts.length;
    var p0 = pts[0], p3 = pts[n - 1];
    var A = [];
    for (var i = 0; i < n; i++) {
      A.push([mul(t1Hat, b1(u[i])), mul(t2Hat, b2(u[i]))]);
    }
    function b0(t) { var u2 = 1 - t; return u2 * u2 * u2; }
    function b1(t) { var u2 = 1 - t; return 3 * t * u2 * u2; }
    function b2(t) { var u2 = 1 - t; return 3 * t * t * u2; }
    function b3(t) { return t * t * t; }
    var C = [[0, 0], [0, 0]], X = [0, 0];
    for (var i = 0; i < n; i++) {
      var a1 = A[i][0], a2 = A[i][1];
      C[0][0] += dot(a1, a1);
      C[0][1] += dot(a1, a2);
      C[1][0] = C[0][1];
      C[1][1] += dot(a2, a2);
      var tmp = sub(pts[i], add(mul(p0, b0(u[i]) + b1(u[i])), mul(p3, b2(u[i]) + b3(u[i]))));
      X[0] += dot(a1, tmp);
      X[1] += dot(a2, tmp);
    }
    var det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
    var alpha1, alpha2;
    if (Math.abs(det) > 1e-12) {
      var detC0X = C[0][0] * X[1] - C[1][0] * X[0];
      var detXC1 = X[0] * C[1][1] - X[1] * C[0][1];
      alpha1 = detXC1 / det;
      alpha2 = detC0X / det;
    } else {
      alpha1 = alpha2 = 0;
    }
    var segLen = len(sub(p3, p0));
    var eps = 1e-6 * (segLen || 1);
    if (alpha1 < eps || alpha2 < eps) {
      // 縮退：端点間の距離ベースの既定制御点にフォールバック
      alpha1 = alpha2 = segLen / 3;
    }
    return [p0, add(p0, mul(t1Hat, alpha1)), add(p3, mul(t2Hat, alpha2)), p3];
  }

  function newtonRaphsonRootFind(ctrl, point, u) {
    var qU = bezierPoint(ctrl, u);
    function derivPts(pts) { var out = []; for (var i = 0; i < pts.length - 1; i++) out.push(mul(sub(pts[i + 1], pts[i]), pts.length - 1)); return out; }
    var d1 = derivPts(ctrl), d2 = derivPts(d1);
    function evalD(pts, t) {
      if (pts.length === 1) return pts[0];
      var u2 = 1 - t;
      if (pts.length === 3) return [u2 * u2 * pts[0][0] + 2 * u2 * t * pts[1][0] + t * t * pts[2][0], u2 * u2 * pts[0][1] + 2 * u2 * t * pts[1][1] + t * t * pts[2][1]];
      return [u2 * pts[0][0] + t * pts[1][0], u2 * pts[0][1] + t * pts[1][1]];
    }
    var qp = evalD(d1, u), qpp = evalD(d2, u);
    var num = dot(sub(qU, point), qp);
    var den = dot(qp, qp) + dot(sub(qU, point), qpp);
    if (Math.abs(den) < 1e-12) return u;
    return u - num / den;
  }
  function reparameterize(pts, u, ctrl) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(newtonRaphsonRootFind(ctrl, pts[i], u[i]));
    return out;
  }

  function computeMaxError(pts, u, ctrl) {
    var maxDist = 0, splitIdx = Math.floor(pts.length / 2);
    for (var i = 0; i < pts.length; i++) {
      var p = bezierPoint(ctrl, u[i]);
      var d = len(sub(p, pts[i]));
      var d2 = d * d;
      if (d2 > maxDist) { maxDist = d2; splitIdx = i; }
    }
    return { maxError: Math.sqrt(maxDist), splitIdx: splitIdx };
  }

  // 3点以上のptsを、両端接線t1Hat/t2Hat・誤差errorで再帰的に当てる。戻り値: [{p0,p1,p2,p3}, ...]
  // 2026-09-25 修正: 旧実装は「n<=4なら誤差を見ずに受け入れる」フォールバックがあり、
  // 誤差が許容値の何倍も残ったまま打ち切っていた（半円200点・tol0.15pxの実測で誤差0.79px
  // まで残る不具合を発見）。n==2（それ以上割れない）まで割ってから受け入れる形に直した。
  function fitCubic(pts, t1Hat, t2Hat, error, depth) {
    depth = depth || 0;
    var n = pts.length;
    if (n < 2) return [];
    if (n === 2) {
      var d = len(sub(pts[1], pts[0])) / 3;
      return [{ p0: pts[0], p1: add(pts[0], mul(t1Hat, d)), p2: add(pts[1], mul(t2Hat, d)), p3: pts[1] }];
    }
    var u = chordLengthParameterize(pts);
    var ctrl = generateBezier(pts, u, t1Hat, t2Hat);
    var me = computeMaxError(pts, u, ctrl);
    // 反復的パラメータ再推定（改善したときだけ採用・最大4回）
    var uCur = u;
    for (var iter = 0; iter < 4 && me.maxError >= error; iter++) {
      var uPrime = reparameterize(pts, uCur, ctrl);
      var ctrl2 = generateBezier(pts, uPrime, t1Hat, t2Hat);
      var me2 = computeMaxError(pts, uPrime, ctrl2);
      if (me2.maxError < me.maxError) { ctrl = ctrl2; me = me2; uCur = uPrime; } else break;
    }
    if (me.maxError < error || depth >= 40) return [{ p0: ctrl[0], p1: ctrl[1], p2: ctrl[2], p3: ctrl[3] }];
    // 最大誤差点で分割し再帰（これ以上割れない場合はここで受け入れる＝無限再帰の防止のみ）
    var splitIdx = Math.max(1, Math.min(n - 2, me.splitIdx));
    if (splitIdx < 1 || splitIdx > n - 2) return [{ p0: ctrl[0], p1: ctrl[1], p2: ctrl[2], p3: ctrl[3] }];
    var tHatCenter = normalize(sub(pts[splitIdx - 1], pts[splitIdx + 1]));
    if (len(tHatCenter) < 1e-9) tHatCenter = normalize(sub(pts[splitIdx], pts[splitIdx - 1]));
    var left = fitCubic(pts.slice(0, splitIdx + 1), t1Hat, tHatCenter, error, depth + 1);
    var right = fitCubic(pts.slice(splitIdx), mul(tHatCenter, -1), t2Hat, error, depth + 1);
    return left.concat(right);
  }

  /* 開いた点列（端点あり）をベジェ列に当てる。tolは許容誤差px。 */
  function fitOpenPolyline(pts, tol) {
    if (!pts || pts.length < 2) return [];
    tol = tol == null ? 0.5 : tol;
    var t1 = normalize(sub(pts[1], pts[0]));
    var t2 = normalize(sub(pts[pts.length - 2], pts[pts.length - 1]));
    if (len(t1) < 1e-9) t1 = [1, 0];
    if (len(t2) < 1e-9) t2 = [-1, 0];
    return fitCubic(pts, t1, t2, tol, 0);
  }

  /* 閉じた点列を1周ぶんのベジェ列に当てる（始点を複製して開いた列として当てる簡易法。
     ユーザー決定: 丸めた折り返し部も角として特別扱いしない＝分割は誤差だけで決める）。
     戻り値: [{p0,p1,p2,p3}, ...]（末尾のp3は先頭のp0に一致＝閉路）。 */
  function fitClosedPolyline(pts, tol) {
    if (!pts || pts.length < 3) return [];
    var open = pts.concat([pts[0]]);
    return fitOpenPolyline(open, tol);
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  /* ベジェ列 → 閉じたSVG d文字列（M〜C…Z）。fitClosedPolylineの戻り値をそのまま渡せる。 */
  function segsToD(segs, closed) {
    if (!segs.length) return '';
    var f = function (p) { return round2(p[0]) + ' ' + round2(p[1]); };
    var d = 'M' + f(segs[0].p0);
    for (var i = 0; i < segs.length; i++) { var s = segs[i]; d += 'C' + f(s.p1) + ' ' + f(s.p2) + ' ' + f(s.p3); }
    if (closed) d += 'Z';
    return d;
  }

  return {
    fitOpenPolyline: fitOpenPolyline,
    fitClosedPolyline: fitClosedPolyline,
    segsToD: segsToD,
    bezierPoint: bezierPoint
  };
});
