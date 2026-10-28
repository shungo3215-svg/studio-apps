/* ============================================================================
   outline.js — 閉じたパスの中心線に「幅ポイント」で太さの抑揚を付け、
   輪郭化した塗りパス（d文字列）を作る純関数群。DOM に依存しない
   （ブラウザの index.html からも node のテストからも同じファイルを読む）。

   概念モデルは Illustrator の線幅ツール（幅ポイント: 位置t・左幅・右幅）と同じ。
   points: [{ t: 0..1（弧長比）, left: px, right: px }] 昇順ソート想定。
   閉じたパスなので t=1 側は t=0 側へそのまま連続する（wrap）。

   入力セグメント形式は geom.js と同じ:
     {type:'L', a:[x,y], b:[x,y]}
     {type:'C', p0,p1,p2,p3:[x,y]}
   ========================================================================== */
(function (root, factory) {
  var Outline = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Outline;
  if (root) root.Outline = Outline;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function evalSeg(s, t) {
    if (s.type === 'L') return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    var u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [
      w0 * s.p0[0] + w1 * s.p1[0] + w2 * s.p2[0] + w3 * s.p3[0],
      w0 * s.p0[1] + w1 * s.p1[1] + w2 * s.p2[1] + w3 * s.p3[1]
    ];
  }
  function segStart(s) { return s.type === 'L' ? s.a : s.p0; }

  /* 1本のセグメントを、弦からの距離が tol 以下になるまで再帰2分割して密な点列にする
     （getPointAtLength は使わない・規格§8。あくまで自前の適応的フラット化）。
     2026-09-25 追加: 曲率がほぼ0（＝弦との距離がほぼ0）だが弦そのものが長い区間は、
     flatness判定だけでは「もう十分平らだ」と早期終了してしまい、その長い1本の弦が
     弧長パラメータ上の空白（大きなtの跳び）になる。回転して奥行きが付いたときに、
     この空白の前後で法線が急に変わり「角」として見えていた（実測: 交互12本・sample-loop.svg・
     角度60°/90°で、隣接点間のなす角が最大89.3°になる区間を発見。t が0.0014刻みの中で
     0.0142も跳ぶ1点があった＝直線(L)区間の旧バグと同じ形の別バグ）。
     直線(L)と同じ考え方で、曲線も弦の長さ自体に上限（maxChordLen）を設け、
     flatnessが十分でも弦が長ければ強制的に分割する。 */
  function subdivide(s, t0, t1, tol, out, depth, maxChordLen) {
    var p0 = evalSeg(s, t0), p1 = evalSeg(s, t1), tm = (t0 + t1) / 2, pm = evalSeg(s, tm);
    var dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy);
    var dist;
    if (len < 1e-9) dist = Math.hypot(pm[0] - p0[0], pm[1] - p0[1]);
    else {
      var t = ((pm[0] - p0[0]) * dx + (pm[1] - p0[1]) * dy) / (len * len);
      var px = p0[0] + dx * t, py = p0[1] + dy * t;
      dist = Math.hypot(pm[0] - px, pm[1] - py);
    }
    if ((dist <= tol && len <= maxChordLen) || depth >= 16) { out.push(p1); return; }
    subdivide(s, t0, tm, tol, out, depth + 1, maxChordLen);
    subdivide(s, tm, t1, tol, out, depth + 1, maxChordLen);
  }
  /* 直線(L)は曲率が0なので、tolベースの適応分割（subdivide）が一度も発火せず
     終点1個しか出さない。長い直線1本が弧長パラメータ上の巨大な空白になり、
     その空白の中に落ちた幅ポイントは実際の頂点として出力されず消える
     （2026-09-24 実測で発見: 角丸四角の直線区間がts=0→0.207のように1段跳びに
     なり、そこに置いた幅ポイントの太さが輪郭に反映されなかった）。
     直線も最大区間長 maxLineStep で必ず分割し、密度を曲線側と揃える。 */
  function flattenSeg(s, tol, out, maxLineStep) {
    if (s.type === 'L') {
      var len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      var n = Math.max(1, Math.ceil(len / maxLineStep));
      for (var k = 1; k <= n; k++) {
        var u = k / n;
        out.push([s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u]);
      }
      return;
    }
    subdivide(s, 0, 1, tol, out, 0, maxLineStep);
  }
  /* 閉じたパスの全セグメントを1本の密な点列にする（始点1個＋各セグメントの終点列）。
     vertexIdx = 元のアンカーポイント（各セグメントの始点）が pts 配列の何番目かの一覧
     （幅のグラフの「アンカーポイントごと」の柱の位置を拾うのに使う。profile.js 参照）。 */
  function flattenClosedPathEx(segs, tol, maxLineStep) {
    if (!segs || !segs.length) return { pts: [], vertexIdx: [] };
    if (maxLineStep == null) maxLineStep = 4; // 世界座標px。直線区間の最大分割幅
    var pts = [segStart(segs[0]).slice()];
    var vertexIdx = [0];
    for (var i = 0; i < segs.length; i++) {
      flattenSeg(segs[i], tol, pts, maxLineStep);
      if (i < segs.length - 1) vertexIdx.push(pts.length - 1);
    }
    var n = pts.length;
    if (n > 1) {
      var a = pts[0], b = pts[n - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
    }
    return { pts: pts, vertexIdx: vertexIdx };
  }
  function flattenClosedPath(segs, tol, maxLineStep) {
    return flattenClosedPathEx(segs, tol, maxLineStep).pts;
  }

  /* 閉じた点列を弧長で等間隔にn点へ再サンプルする（既存点の間を線形補間するだけ・新しい
     曲率情報は増やさない。密度を底上げして、回転投影後の直線つなぎ（帯の小片・法線計算）が
     粗いカクつきに見えるのを抑えるために使う。n が現在の点数以下なら元の点列をそのまま返す）。
     戻り値の点は元の点列のどのインデックス間か分からないため、呼び出し側は改めて
     arcLengthParam() で ts を取り直すこと。 */
  function resampleClosedEven(pts, n) {
    var m = pts.length;
    if (m < 2 || n <= m) return pts.slice();
    var param = arcLengthParam(pts);
    var ts = param.ts, total = param.total;
    if (total <= 0) return pts.slice();
    var out = [];
    var j = 0;
    for (var i = 0; i < n; i++) {
      var target = i / n;
      while (j < m - 1 && ts[j + 1] <= target) j++;
      var t0 = ts[j], t1 = (j + 1 < m) ? ts[j + 1] : 1;
      var p0 = pts[j], p1 = (j + 1 < m) ? pts[j + 1] : pts[0];
      var span = t1 - t0;
      var u = span > 1e-12 ? (target - t0) / span : 0;
      var pt = []; // [x,y] でも [x,y,z] でも動くように全要素を線形補間する
      for (var k = 0; k < p0.length; k++) pt.push(p0[k] + (p1[k] - p0[k]) * u);
      out.push(pt);
    }
    return out;
  }

  // 点列の弧長パラメータ（t=0..1未満。最後の点→最初の点の閉じる辺も長さに含める）
  function arcLengthParam(pts) {
    var n = pts.length;
    if (!n) return { ts: [], total: 0 };
    var cum = [0];
    for (var i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    var closing = Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
    var total = cum[n - 1] + closing;
    var ts = cum.map(function (c) { return total > 0 ? c / total : 0; });
    return { ts: ts, total: total };
  }

  // 各点の法線（前後点の平均接線に対する左法線）。閉路なので wrap する
  function normalsFor(pts) {
    var n = pts.length, out = [];
    for (var i = 0; i < n; i++) {
      var a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      var tx = b[0] - a[0], ty = b[1] - a[1];
      var len = Math.hypot(tx, ty) || 1;
      out.push([-ty / len, tx / len]);
    }
    return out;
  }

  function smoothstep(u) { u = u < 0 ? 0 : (u > 1 ? 1 : u); return u * u * (3 - 2 * u); }

  /* t における左右幅を返す。points は t 昇順ソート済みを仮定。
     0個なら baseWidth の対称（left=right=baseWidth/2）。1個ならその値を全周で使う。
     2個以上なら隣接点間を smoothstep 補間し、最後の点→最初の点も閉路として補間する。 */
  function widthAt(sortedPoints, t, baseWidth) {
    var baseHalf = baseWidth / 2;
    if (!sortedPoints || !sortedPoints.length) return { left: baseHalf, right: baseHalf };
    var n = sortedPoints.length;
    if (n === 1) return { left: sortedPoints[0].left, right: sortedPoints[0].right };
    var lo = null, hi = null;
    for (var i = 0; i < n; i++) if (sortedPoints[i].t <= t) lo = sortedPoints[i];
    for (var j = 0; j < n; j++) if (sortedPoints[j].t >= t) { hi = sortedPoints[j]; break; }
    if (lo && hi && lo === hi) return { left: lo.left, right: lo.right };
    if (!lo || !hi) {
      // t が最初の点より前、または最後の点より後ろ ＝ 最後の点→最初の点の弧をまたぐ
      var lo2 = sortedPoints[n - 1], hi2 = sortedPoints[0];
      var span = (hi2.t + 1) - lo2.t;
      var tt = !lo ? (t + 1) : t;
      var u = span > 0 ? (tt - lo2.t) / span : 0;
      var e = smoothstep(u);
      return { left: lo2.left + (hi2.left - lo2.left) * e, right: lo2.right + (hi2.right - lo2.right) * e };
    }
    var span2 = hi.t - lo.t;
    var u2 = span2 > 0 ? (t - lo.t) / span2 : 0;
    var e2 = smoothstep(u2);
    return { left: lo.left + (hi.left - lo.left) * e2, right: lo.right + (hi.right - lo.right) * e2 };
  }

  /* t における左右幅を返す（周期的Catmull-Rom版）。widthAt()と同じ入出力だが、
     区間の両端でスロープが0になるsmoothstepではなく、前後の点も使ったCatmull-Romで
     補間する（区間の継ぎ目でも曲率が連続＝回転して奥行きが付いたときに角に見えない）。
     2026-09-24: ユーザー指摘「回していくと滑らかでなく角がついて見える」の原因調査で採用。
     smoothstepは各区間の両端でスロープ0（C1連続）だが、2階微分（曲率）が区間の継ぎ目で
     符号反転して不連続になり、3D回転後の法線・投影でその不連続がはっきり角として見えていた。
     密なサンプリング（別途検証・効果なし・notes.md参照）では直らず、この補間方式の変更で
     解消した。3点未満はwidthAt()と同じ結果になる（Catmull-Romが成立しないため）。 */
  function widthAtSmooth(sortedPoints, t, baseWidth) {
    var baseHalf = baseWidth / 2;
    if (!sortedPoints || !sortedPoints.length) return { left: baseHalf, right: baseHalf };
    var n = sortedPoints.length;
    if (n < 3) return widthAt(sortedPoints, t, baseWidth);
    var i1 = -1;
    for (var k = 0; k < n; k++) {
      var a = sortedPoints[k].t, b = sortedPoints[(k + 1) % n].t;
      var spanAB = (b - a + 1) % 1; if (spanAB < 1e-9) spanAB = 1;
      var da = ((t - a) % 1 + 1) % 1;
      if (da <= spanAB + 1e-9) { i1 = k; break; }
    }
    if (i1 === -1) i1 = n - 1;
    var p0 = sortedPoints[(i1 - 1 + n) % n], p1 = sortedPoints[i1], p2 = sortedPoints[(i1 + 1) % n], p3 = sortedPoints[(i1 + 2) % n];
    var span = (p2.t - p1.t + 1) % 1; if (span < 1e-9) span = 1;
    var u = (((t - p1.t) % 1 + 1) % 1) / span;
    u = Math.max(0, Math.min(1, u));
    function crInterp(v0, v1, v2, v3) {
      var u2 = u * u, u3 = u2 * u;
      return 0.5 * ((2 * v1) + (-v0 + v2) * u + (2 * v0 - 5 * v1 + 4 * v2 - v3) * u2 + (-v0 + 3 * v1 - 3 * v2 + v3) * u3);
    }
    return { left: crInterp(p0.left, p1.left, p2.left, p3.left), right: crInterp(p0.right, p1.right, p2.right, p3.right) };
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  // 弦長重み付き Catmull-Rom → 3次ベジェ（閉ループ）。geom.js の smooth() と同じ式。
  function catmullRomClosedSegments(pts) {
    var n = pts.length, segs = [];
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      var d01 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      var d12 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var d23 = Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
      var wa = d12 / ((d01 + d12) || 1), wb = d12 / ((d12 + d23) || 1);
      var c1 = [p1[0] + (p2[0] - p0[0]) * wa / 3, p1[1] + (p2[1] - p0[1]) * wa / 3];
      var c2 = [p2[0] - (p3[0] - p1[0]) * wb / 3, p2[1] - (p3[1] - p1[1]) * wb / 3];
      segs.push({ p0: p1, p1: c1, p2: c2, p3: p2 });
    }
    return segs;
  }
  function segsToClosedD(segs) {
    if (!segs.length) return '';
    var f = function (p) { return round2(p[0]) + ' ' + round2(p[1]); };
    var d = 'M' + f(segs[0].p0);
    for (var i = 0; i < segs.length; i++) { var s = segs[i]; d += 'C' + f(s.p1) + ' ' + f(s.p2) + ' ' + f(s.p3); }
    return d + 'Z';
  }

  /* 輪郭化本体。segs（閉じたパス）＋ baseWidth ＋ points から、
     左オフセット線を順方向・右オフセット線を逆方向に繋いだ closed path の
     d文字列（fill-rule=nonzero・自己交差は許容）を作る。
     戻り値: { d, samples:[[x,y]], ts:[0..1], left:[[x,y]], right:[[x,y]] } */
  /* パス依存（segs・tol・maxLineStepだけで決まる）部分だけを切り出したもの。
     平坦化・弧長パラメータ・法線はbaseWidth/pointsに一切依存しないため、パスを貼った
     瞬間に1回計算してキャッシュしてよい（段6性能改善・2026-09-25）。
     戻り値: {samples, ts, normals, total}（buildOutlineのopts.geomにそのまま渡せる）。 */
  function computeGeom(segs, tol, maxLineStep) {
    var samples = flattenClosedPath(segs, tol, maxLineStep);
    if (samples.length < 3) return { samples: [], ts: [], normals: [], total: 0 };
    var param = arcLengthParam(samples);
    return { samples: samples, ts: param.ts, normals: normalsFor(samples), total: param.total };
  }

  /* opts.geom に computeGeom() の戻り値を渡すと、平坦化・弧長・法線の再計算を省いて
     baseWidth/points由来の幅オフセットだけをやり直す（呼び出し側がキャッシュの有効性
     ＝segs/tol/maxLineStepが変わっていないことを保証すること）。 */
  function buildOutline(segs, baseWidth, points, opts) {
    opts = opts || {};
    var tol = opts.tol != null ? opts.tol : 0.05;
    var maxLineStep = opts.maxLineStep != null ? opts.maxLineStep : 4;
    var geom = opts.geom || computeGeom(segs, tol, maxLineStep);
    var samples = geom.samples;
    if (samples.length < 3) return { d: '', samples: [], ts: [], left: [], right: [] };
    var ts = geom.ts;
    var normals = geom.normals;
    var sorted = (points || []).slice().sort(function (a, b) { return a.t - b.t; });
    var left = [], right = [];
    for (var i = 0; i < samples.length; i++) {
      var w = widthAt(sorted, ts[i], baseWidth);
      var nx = normals[i][0], ny = normals[i][1];
      left.push([samples[i][0] + nx * w.left, samples[i][1] + ny * w.left]);
      right.push([samples[i][0] - nx * w.right, samples[i][1] - ny * w.right]);
    }
    var rightRev = right.slice().reverse();
    var d = segsToClosedD(catmullRomClosedSegments(left)) + ' ' + segsToClosedD(catmullRomClosedSegments(rightRev));
    return { d: d, samples: samples, ts: ts, normals: normals, left: left, right: right, total: geom.total };
  }

  return {
    evalSeg: evalSeg,
    flattenClosedPath: flattenClosedPath,
    flattenClosedPathEx: flattenClosedPathEx,
    arcLengthParam: arcLengthParam,
    normalsFor: normalsFor,
    smoothstep: smoothstep,
    widthAt: widthAt,
    widthAtSmooth: widthAtSmooth,
    computeGeom: computeGeom,
    buildOutline: buildOutline,
    catmullRomClosedSegments: catmullRomClosedSegments,
    segsToClosedD: segsToClosedD,
    resampleClosedEven: resampleClosedEven
  };
});
