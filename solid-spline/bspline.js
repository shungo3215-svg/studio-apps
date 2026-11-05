/* ============================================================================
   bspline.js — 閉じた3次Bスプライン1本の核（DOM非依存・純関数のみ）。
   制御点は [x, y, z, w]（wは線幅px）。N個の制御点でN個のスパン（周期・一様ノット）。

   スパン i の基底（t=0..1）:
     b0(t) = (1-t)^3/6
     b1(t) = (3t^3-6t^2+4)/6
     b2(t) = (-3t^3+3t^2+3t+1)/6
     b3(t) = t^3/6
   スパン i は ctrl[(i-1+N)%N], ctrl[i], ctrl[(i+1)%N], ctrl[(i+2)%N] にこの順で掛ける。
   この番号付けで「スパンiの始点(t=0) = ノットiの点 = (c[i-1]+4c[i]+c[i+1])/6」になる。
   depth.js/outline.js と同じ UMD 形。ブラウザ（グローバル BSpline）と node（module.exports）両方で読める。
   ========================================================================== */
(function (root, factory) {
  var BSpline = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = BSpline;
  if (root) root.BSpline = BSpline;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* --- 基底関数 --------------------------------------------------------- */
  function basis(t) {
    var t2 = t * t, t3 = t2 * t;
    return [
      ((1 - t) * (1 - t) * (1 - t)) / 6,
      (3 * t3 - 6 * t2 + 4) / 6,
      (-3 * t3 + 3 * t2 + 3 * t + 1) / 6,
      t3 / 6
    ];
  }

  /* スパン i（0..N-1）を t（実数。0..1の外へ出しても多項式として評価できる）で評価する。
     ctrl の各要素は同じ長さの配列（[x,y,z,w] 等）。戻り値も同じ長さの配列。 */
  function evalSpanAt(ctrl, i, t) {
    var N = ctrl.length;
    var b = basis(t);
    var c0 = ctrl[((i - 1) % N + N) % N];
    var c1 = ctrl[((i) % N + N) % N];
    var c2 = ctrl[((i + 1) % N + N) % N];
    var c3 = ctrl[((i + 2) % N + N) % N];
    var dim = c0.length, out = new Array(dim);
    for (var d = 0; d < dim; d++) out[d] = b[0] * c0[d] + b[1] * c1[d] + b[2] * c2[d] + b[3] * c3[d];
    return out;
  }

  /* 閉じたBスプライン全体を密な点列にサンプルする。samplesPerSpanはスパンごとの点数
     （各スパンt=0..(samplesPerSpan-1)/samplesPerSpanをサンプル。次スパンのt=0と重複しない）。
     戻り値: {pts3D:[[x,y,z]…], w:[…], u:[…]}。uはスパン+tを N で割った 0..1 のグローバルパラメータ
     （resampleByArcLengthが弧長パラメータへ引き直す前の、元の位置を追うために持たせる）。 */
  function evalClosed(ctrl, samplesPerSpan) {
    var N = ctrl.length;
    var pts3D = [], w = [], u = [];
    for (var i = 0; i < N; i++) {
      for (var k = 0; k < samplesPerSpan; k++) {
        var t = k / samplesPerSpan;
        var p = evalSpanAt(ctrl, i, t);
        pts3D.push([p[0], p[1], p[2]]);
        w.push(p[3]);
        u.push((i + t) / N);
      }
    }
    return { pts3D: pts3D, w: w, u: u };
  }

  function dist3(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* evalClosed() の密な点列を、3D弧長で等間隔な n 点へ再サンプルする（線形補間。
     x,y,z と w を同じ点列に並べて返す。uも同じ補間で引き直す）。 */
  function resampleByArcLength(dense, n) {
    var pts = dense.pts3D, w = dense.w, u = dense.u;
    var m = pts.length;
    if (m < 2 || n <= 0) return { pts3D: [], w: [], u: [] };
    var cum = [0];
    for (var i = 1; i < m; i++) cum.push(cum[i - 1] + dist3(pts[i - 1], pts[i]));
    var closing = dist3(pts[m - 1], pts[0]);
    var total = cum[m - 1] + closing;
    var ts = cum.map(function (c) { return total > 0 ? c / total : 0; });
    var outPts = [], outW = [], outU = [];
    var j = 0;
    for (var k = 0; k < n; k++) {
      var target = k / n;
      while (j < m - 1 && ts[j + 1] <= target) j++;
      var t0 = ts[j], t1 = (j + 1 < m) ? ts[j + 1] : 1;
      var p0 = pts[j], p1 = (j + 1 < m) ? pts[j + 1] : pts[0];
      var w0 = w[j], w1 = (j + 1 < m) ? w[j + 1] : w[0];
      var u0 = u[j], u1raw = (j + 1 < m) ? u[j + 1] : (u[0] + 1);
      var span = t1 - t0;
      var uu = span > 1e-12 ? (target - t0) / span : 0;
      outPts.push([
        p0[0] + (p1[0] - p0[0]) * uu,
        p0[1] + (p1[1] - p0[1]) * uu,
        p0[2] + (p1[2] - p0[2]) * uu
      ]);
      outW.push(w0 + (w1 - w0) * uu);
      var uVal = u0 + (u1raw - u0) * uu;
      outU.push(uVal > 1 ? uVal - 1 : uVal);
    }
    return { pts3D: outPts, w: outW, u: outU };
  }

  /* --- 連立方程式 A x = b（密なN×N・ガウス消去＋部分ピボット）。Nは数十程度を想定。 --- */
  function solveLinear(A, b) {
    var n = b.length;
    var M = A.map(function (row) { return row.slice(); });
    var rhs = b.slice();
    for (var col = 0; col < n; col++) {
      var piv = col, best = Math.abs(M[col][col]);
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > best) { best = Math.abs(M[r][col]); piv = r; }
      }
      if (piv !== col) {
        var tmpRow = M[col]; M[col] = M[piv]; M[piv] = tmpRow;
        var tmpV = rhs[col]; rhs[col] = rhs[piv]; rhs[piv] = tmpV;
      }
      var pivVal = M[col][col];
      if (Math.abs(pivVal) < 1e-14) continue;
      for (var r2 = col + 1; r2 < n; r2++) {
        var factor = M[r2][col] / pivVal;
        if (factor === 0) continue;
        for (var c2 = col; c2 < n; c2++) M[r2][c2] -= factor * M[col][c2];
        rhs[r2] -= factor * rhs[col];
      }
    }
    var x = new Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var sum = rhs[i];
      for (var jj = i + 1; jj < n; jj++) sum -= M[i][jj] * x[jj];
      x[i] = sum / M[i][i];
    }
    return x;
  }

  /* anchors（ノット点を通す）から制御点を作る。周期3重対角系
     (1/6)c[i-1] + (4/6)c[i] + (1/6)c[i+1] = a[i] を各成分（x,y,z,w）で解く。
     anchors: [[x,y,z,w]…]（N個・N×Nを素直にガウス消去）。 */
  function interpolateClosed(anchors) {
    var N = anchors.length;
    if (N < 3) return anchors.map(function (a) { return a.slice(); });
    var dim = anchors[0].length;
    var A = [];
    for (var i = 0; i < N; i++) {
      var row = new Array(N);
      for (var c = 0; c < N; c++) row[c] = 0;
      row[((i - 1) % N + N) % N] += 1 / 6;
      row[i] += 4 / 6;
      row[(i + 1) % N] += 1 / 6;
      A.push(row);
    }
    var ctrl = [];
    for (var k = 0; k < N; k++) { var arr = new Array(dim); ctrl.push(arr); }
    for (var d = 0; d < dim; d++) {
      var b = anchors.map(function (a) { return a[d] != null ? a[d] : 0; });
      var x = solveLinear(A, b);
      for (var i2 = 0; i2 < N; i2++) ctrl[i2][d] = x[i2];
    }
    return ctrl;
  }

  /* 各スパンiを3次ベジェ{type:'C',p0,p1,p2,p3}へ厳密変換する（一様3次Bスプライン→ベジェの
     標準公式）。入力ctrlは2Dでも3D/4Dでもよい（先頭2成分だけ使う＝出力は常に2D点）。
     回転投影は線形変換なので「制御点をDepth.rotateProjectしてからtoBezierClosed」で
     投影後の中心線が厳密なベジェになる。 */
  function toBezierClosed(ctrl) {
    var N = ctrl.length, out = [];
    for (var i = 0; i < N; i++) {
      var cim1 = ctrl[((i - 1) % N + N) % N];
      var ci = ctrl[i];
      var cip1 = ctrl[(i + 1) % N];
      var cip2 = ctrl[(i + 2) % N];
      var p0 = [(cim1[0] + 4 * ci[0] + cip1[0]) / 6, (cim1[1] + 4 * ci[1] + cip1[1]) / 6];
      var p1 = [(2 * ci[0] + cip1[0]) / 3, (2 * ci[1] + cip1[1]) / 3];
      var p2 = [(ci[0] + 2 * cip1[0]) / 3, (ci[1] + 2 * cip1[1]) / 3];
      var p3 = [(ci[0] + 4 * cip1[0] + cip2[0]) / 6, (ci[1] + 4 * cip1[1] + cip2[1]) / 6];
      out.push({ type: 'C', p0: p0, p1: p1, p2: p2, p3: p3 });
    }
    return out;
  }

  /* SvgIn の segs（{type:'L',a,b}/{type:'C',p0..p3}）から、各セグメント始点をアンカーにする。
     戻り値: [[x,y,0,baseWidth]…]（zは常に0=元の平面。baseWidthは引数の線幅を全周で使う）。
     改訂1（2026-09-24）: 画面の貼り付けでは使わない（resamplePathEvenに置き換え）。
     アンカー点そのものが要る場合のために残す。 */
  function anchorsFromSegs(segs, baseWidth) {
    return (segs || []).map(function (s) {
      var p = s.type === 'L' ? s.a : s.p0;
      return [p[0], p[1], 0, baseWidth];
    });
  }

  function evalSegXY(s, t) {
    if (s.type === 'L') return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    var u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [
      w0 * s.p0[0] + w1 * s.p1[0] + w2 * s.p2[0] + w3 * s.p3[0],
      w0 * s.p0[1] + w1 * s.p1[1] + w2 * s.p2[1] + w3 * s.p3[1]
    ];
  }

  /* 改訂1（2026-09-24・差し戻し対応）: SvgIn形式のsegs（L/C）を細かく平坦化し、2D弧長で
     等間隔count点を取る。元パスのアンカー間隔がどれだけ不均一でも、この関数の出力は
     常に等間隔になる＝一様ノットの周期3次Bスプラインで当てはめてもオーバーシュートしにくい
     （アンカーをそのまま使うanchorsFromSegsとの違い）。戻り値: [[x,y,0,baseWidth]…]。
     node（testの簡易パーサ出力）とブラウザ（SvgIn.parseのsegs）の両方で同じ関数を使う。 */
  function resamplePathEven(segs, count, baseWidth) {
    if (baseWidth == null) baseWidth = 6;
    var SAMPLES_PER_SEG = 40;
    var dense = [];
    (segs || []).forEach(function (s) {
      for (var k = 0; k < SAMPLES_PER_SEG; k++) dense.push(evalSegXY(s, k / SAMPLES_PER_SEG));
    });
    var m = dense.length;
    if (m < 2) return [];
    var cum = [0];
    for (var i = 1; i < m; i++) {
      cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
    }
    var closing = Math.hypot(dense[0][0] - dense[m - 1][0], dense[0][1] - dense[m - 1][1]);
    var total = cum[m - 1] + closing;
    var ts = cum.map(function (c) { return total > 0 ? c / total : 0; });
    var out = [], j = 0;
    for (var k2 = 0; k2 < count; k2++) {
      var target = k2 / count;
      while (j < m - 1 && ts[j + 1] <= target) j++;
      var t0 = ts[j], t1 = (j + 1 < m) ? ts[j + 1] : 1;
      var p0 = dense[j], p1 = (j + 1 < m) ? dense[j + 1] : dense[0];
      var span = t1 - t0;
      var uu = span > 1e-12 ? (target - t0) / span : 0;
      out.push([p0[0] + (p1[0] - p0[0]) * uu, p0[1] + (p1[1] - p0[1]) * uu, 0, baseWidth]);
    }
    return out;
  }

  /* 改訂2（2026-09-24・段2・立体スプラインC）: d文字列（M/L/C/Zのみ・絶対/相対どちらも可）を
     segsへ変換する（DOM非依存。線幅の抑揚のsvgin.jsが持つフルSVG仕様のパーサとは別に、
     ここでは「線幅の抑揚が書き出すbasePath」（Geom.toDが吐くM+（C|L）+Z）を読むのに必要な
     範囲だけを持つ）。node（test）とブラウザ（swell_import.js経由）の両方でこの1つの実装を
     共用する（重複実装しない）。Zは実体のセグメントを追加しない＝closedフラグだけを立てる
     （resamplePathEven/flattenClosedPathEx側が最後→最初の距離を弧長に含めて自動的に閉じるため、
     ここで閉じ線を追加すると弧長パラメータが二重にずれる）。
     戻り値: {segs:[{type:'L',a,b}|{type:'C',p0,p1,p2,p3}…], closed:bool} */
  function scanNumberPD(s, i) {
    var n = s.length, start = i, digits = false, c = s.charAt(i);
    if (c === '+' || c === '-') i++;
    while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') { i++; digits = true; }
    if (i < n && s.charAt(i) === '.') {
      i++;
      while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') { i++; digits = true; }
    }
    if (!digits) return null;
    if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
      var j = i + 1, expDigits = false;
      if (j < n && (s.charAt(j) === '+' || s.charAt(j) === '-')) j++;
      while (j < n && s.charAt(j) >= '0' && s.charAt(j) <= '9') { j++; expDigits = true; }
      if (expDigits) i = j;
    }
    return { value: parseFloat(s.slice(start, i)), next: i };
  }
  function parsePathD(d) {
    var s = String(d == null ? '' : d), n = s.length, i = 0;
    var x = 0, y = 0, sx = 0, sy = 0, cmd = '', segs = [], closed = false;
    function isSep(c) { return c === ' ' || c === ',' || c === '\t' || c === '\n' || c === '\r'; }
    function skipSep() { while (i < n && isSep(s.charAt(i))) i++; }
    function readNum() { skipSep(); var r = scanNumberPD(s, i); if (!r) return null; i = r.next; return r.value; }
    outer:
    while (i < n) {
      skipSep();
      if (i >= n) break;
      var ch = s.charAt(i);
      if (/[MmLlCcZz]/.test(ch)) { cmd = ch; i++; }
      else if (!cmd) break;
      var rel = cmd === cmd.toLowerCase();
      var CU = cmd.toUpperCase();
      if (CU === 'M') {
        var mx = readNum(), my = readNum();
        if (mx == null || my == null) break outer;
        x = rel ? x + mx : mx; y = rel ? y + my : my;
        sx = x; sy = y;
        cmd = rel ? 'l' : 'L'; // 暗黙のlineto（Mの直後に数値が続く場合の既定コマンド）
      } else if (CU === 'L') {
        var lx = readNum(), ly = readNum();
        if (lx == null || ly == null) break outer;
        var nx = rel ? x + lx : lx, ny = rel ? y + ly : ly;
        segs.push({ type: 'L', a: [x, y], b: [nx, ny] });
        x = nx; y = ny;
      } else if (CU === 'C') {
        var vals = [], bad = false;
        for (var k = 0; k < 6; k++) { var v = readNum(); if (v == null) { bad = true; break; } vals.push(v); }
        if (bad) break outer;
        var p1 = [rel ? x + vals[0] : vals[0], rel ? y + vals[1] : vals[1]];
        var p2 = [rel ? x + vals[2] : vals[2], rel ? y + vals[3] : vals[3]];
        var p3 = [rel ? x + vals[4] : vals[4], rel ? y + vals[5] : vals[5]];
        segs.push({ type: 'C', p0: [x, y], p1: p1, p2: p2, p3: p3 });
        x = p3[0]; y = p3[1];
      } else if (CU === 'Z') {
        closed = true;
        x = sx; y = sy;
        cmd = '';
      } else {
        break outer;
      }
    }
    return { segs: segs, closed: closed };
  }

  /* 段3b（2026-09-25・立体スプライン・データモデルをアンカー中心に切り替える）:
     制御点ctrlの各ノット点（スパンiのt=0の点＝evalSpanAt(ctrl,i,0)と同じ式）を、
     x,y,z,wそれぞれ (c[i-1]+4c[i]+c[i+1])/6 で返す。interpolateClosedの逆写像
     （厳密。アンカー→制御点=interpolateClosed、制御点→アンカー=knotPoints）。
     戻り値: [[x,y,z,w]…]（ctrlと同じ長さ）。 */
  function knotPoints(ctrl) {
    var N = ctrl.length, out = [];
    for (var i = 0; i < N; i++) {
      var cim1 = ctrl[((i - 1) % N + N) % N], ci = ctrl[i], cip1 = ctrl[(i + 1) % N];
      var dim = ci.length, row = new Array(dim);
      for (var d = 0; d < dim; d++) row[d] = (cim1[d] + 4 * ci[d] + cip1[d]) / 6;
      out.push(row);
    }
    return out;
  }

  /* 改訂3（2026-09-24・段3E・立体スプライン）: 各セグメント始点（Illustratorのアンカー）を
     必ず点に採り、隣接アンカー間の弧長が「全アンカー間の弧長の中央値×maxRatio」を超える区間
     だけ、超えない本数に等分して間に点を補う。段1で見た「一様Bスプラインはアンカー間隔が
     不揃いだと制御点が飛ぶ」問題を、間隔比をmaxRatio以内に抑えることで避ける
     （resamplePathEvenの「弧長で完全等間隔に取り直す」より、元のアンカー位置を尊重する）。
     戻り値: {pts:[[x,y,0,w0]…], isAnchor:[bool…]}（ptsと同じ長さ・アンカー由来ならtrue）。 */
  function segLength(s, samples) {
    samples = samples || 40;
    var len = 0, prev = evalSegXY(s, 0);
    for (var k = 1; k <= samples; k++) {
      var cur = evalSegXY(s, k / samples);
      len += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      prev = cur;
    }
    return len;
  }
  function medianOf(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var n = a.length;
    if (!n) return 0;
    var mid = Math.floor(n / 2);
    return (n % 2) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  function resamplePathByAnchors(segs, baseWidth, maxRatio) {
    if (baseWidth == null) baseWidth = 6;
    if (maxRatio == null) maxRatio = 1.5;
    var n = (segs || []).length;
    if (n < 3) return { pts: [], isAnchor: [] };
    var lens = segs.map(function (s) { return segLength(s, 40); });
    var med = medianOf(lens);
    var threshold = med * maxRatio;
    var pts = [], isAnchor = [];
    for (var i = 0; i < n; i++) {
      var s = segs[i];
      var startXY = evalSegXY(s, 0);
      pts.push([startXY[0], startXY[1], 0, baseWidth]);
      isAnchor.push(true);
      var len = lens[i];
      if (threshold > 1e-9 && len > threshold) {
        var m = Math.max(1, Math.ceil(len / threshold));
        for (var k = 1; k < m; k++) {
          var p = evalSegXY(s, k / m);
          pts.push([p[0], p[1], 0, baseWidth]);
          isAnchor.push(false);
        }
      }
    }
    return { pts: pts, isAnchor: isAnchor };
  }

  return {
    basis: basis,
    evalSpanAt: evalSpanAt,
    evalClosed: evalClosed,
    resampleByArcLength: resampleByArcLength,
    interpolateClosed: interpolateClosed,
    toBezierClosed: toBezierClosed,
    anchorsFromSegs: anchorsFromSegs,
    resamplePathEven: resamplePathEven,
    resamplePathByAnchors: resamplePathByAnchors,
    parsePathD: parsePathD,
    knotPoints: knotPoints,
    solveLinear: solveLinear
  };
});
