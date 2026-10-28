/* ============================================================================
   depth.js — 段3「奥行き」の純関数群（DOM非依存）。
   中心線に奥行き z(t) を持たせ、2つの角度で回転して正射投影し、投影後の帯を
   前後関係（zの昇順=奥から）で小片に分けて描くための計算だけを持つ。
   幅(w)と奥行き(z)のリンク（線幅↔奥行き）もここに置く。

   座標系: z は手前が＋・奥が−・0が元の平面（ユーザー決定・notes.md参照）。
   角度: ax=縦に回す（X軸・-90〜90°）、ay=横に回す（Y軸・-180〜180°）。
   回転順序: X軸回転（ax）→ Y軸回転（ay）。正射投影は回転後の(x,y)をそのまま使う。
   ========================================================================== */
(function (root, factory) {
  var Depth = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Depth;
  if (root) root.Depth = Depth;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* pts3D: [[x,y,z], …] → [{x,y,z}, …]（回転後・z=投影後の奥行き＝前後判定に使う） */
  function rotateProject(pts3D, ax, ay) {
    var rax = (ax || 0) * Math.PI / 180, ray = (ay || 0) * Math.PI / 180;
    var ca = Math.cos(rax), sa = Math.sin(rax);
    var cb = Math.cos(ray), sb = Math.sin(ray);
    return pts3D.map(function (p) {
      var x = p[0], y = p[1], z = p[2];
      // X軸回転（縦に回す）: y-z 面
      var y1 = y * ca - z * sa;
      var z1 = y * sa + z * ca;
      var x1 = x;
      // Y軸回転（横に回す）: x-z 面
      var x2 = x1 * cb + z1 * sb;
      var z2 = -x1 * sb + z1 * cb;
      var y2 = y1;
      return { x: x2, y: y2, z: z2 };
    });
  }

  /* 「線幅に連動」（段5・2026-09-25 UI再編）: widthsの最小〜最大を −50〜+50%（固定の奥行き軸
     いっぱい）へ線形に割り当てる。invert=false（既定）＝太い方が手前(+)・細い方が奥(-)。
     invert=true（「太い方を奥にする」ON）＝符号を反転（太い方が奥(-)・細い方が手前(+)）。
     widthsが全部同じならどちらもz=0。呼び出し側は毎フレーム（連動ON時の3D計算・グラフの
     右軸目盛り）と、連動OFFへ切り替えた瞬間の奥行き柱への引き継ぎの両方でこれを呼ぶ
     （段3にあった「線幅と同じ形にする」ボタンは廃止＝常時この関数で計算するため不要になった）。 */
  function linkedDepth(widths, invert) {
    var HALF = 50;
    if (!widths.length) return [];
    var min = Math.min.apply(null, widths), max = Math.max.apply(null, widths);
    var range = max - min;
    if (range < 1e-9) return widths.map(function () { return 0; });
    return widths.map(function (w) {
      var pct = ((w - min) / range * 2 - 1) * HALF;
      return invert ? -pct : pct;
    });
  }

  /* 投影後の帯（left/right の2D点列・zは中心線のz）を弧長順に pieceCount 個へ分ける。
     隣どうしは1サンプル重ねて継ぎ目を消す。sequential=幾何順（隣接判定用）、
     byDepth=meanZ昇順（奥から描く順）。閉じたパスなので末尾は先頭へ繋がる想定。 */
  function splitBandPieces(n, zValues, pieceCount) {
    pieceCount = Math.max(1, Math.round(pieceCount));
    if (n < 2) return { sequential: [], byDepth: [] };
    var per = n / pieceCount;
    var sequential = [];
    for (var i = 0; i < pieceCount; i++) {
      var startIdx = Math.floor(i * per);
      var endIdxRaw = Math.floor((i + 1) * per);
      var endIdx = Math.min(n - 1, endIdxRaw);
      var idxs = [];
      for (var j = startIdx; j <= endIdx; j++) idxs.push(j);
      // 次の片の先頭（endIdx+1、末尾は0へwrap）を1個重ねて継ぎ目を消す
      var nextHead = (endIdx + 1) % n;
      idxs.push(nextHead);
      var zs = idxs.map(function (idx) { return zValues[idx]; });
      var meanZ = zs.reduce(function (a, b) { return a + b; }, 0) / zs.length;
      sequential.push({ order: i, indices: idxs, meanZ: meanZ });
    }
    var byDepth = sequential.slice().sort(function (a, b) { return a.meanZ - b.meanZ; });
    return { sequential: sequential, byDepth: byDepth };
  }

  /* --- 段7-1: 小片は「重なる所だけ」切る（2026-09-25 ユーザー決定）。
     投影後の中心線（samples）が、弧に沿って近い所（|i-j|<=minGap）以外の場所で自分自身に
     近づく（＝bboxの粗判定→距離の精判定）区間だけを「hot」とし、hotな区間だけ細かく
     小片に分ける。重ならない区間はそのまま1本の長い片にする（円のように一度も自己接近
     しない形は、回しても常に1個の片になる）。
     samples: 投影後の2D中心線点列。halfWidths[i]: そのサンプルの半幅（左右の平均で十分・
     重なり判定の目安値）。zValues: 前後関係の並べ替えに使うz（サンプルと同じ長さ）。
     戻り値はsplitBandPiecesと同じ形（{sequential, byDepth}）。 --------------------------- */
  function detectHotIndices(samples, halfWidths, minGap) {
    var n = samples.length;
    var hot = new Array(n);
    for (var k = 0; k < n; k++) hot[k] = false;
    // bbox（半幅ぶん膨らませた矩形）の粗判定→距離の精判定（隣接=|i-j|<=minGapは自明に近いので除外）
    var boxes = samples.map(function (p, i) {
      var r = halfWidths[i];
      return { x0: p[0] - r, x1: p[0] + r, y0: p[1] - r, y1: p[1] + r };
    });
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var gap = Math.min(j - i, n - (j - i));
        if (gap <= minGap) continue;
        var a = boxes[i], b = boxes[j];
        if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) continue; // bbox不重複→スキップ
        var d = Math.hypot(samples[i][0] - samples[j][0], samples[i][1] - samples[j][1]);
        if (d < halfWidths[i] + halfWidths[j]) { hot[i] = true; hot[j] = true; }
      }
    }
    return hot;
  }
  function splitBandAdaptive(samples, halfWidths, zValues, opts) {
    opts = opts || {};
    var n = samples.length;
    // minGapの既定はサンプル密度に合わせてスケールする（固定値6だと、1つの角の中で
    // 隣接する密サンプルどうしが「自分自身に近い」と誤検出され、実際には重ならない
    // 区間まで大量にhot判定されてしまうことが実測で分かった＝サンプル数の多い形ほど
    // 1個の角が多くのサンプルにまたがるため）。n/20を目安にする（実測: n=584でminGap
    // ≈6だとhot 200/584(34%)・片数89、minGap≈30だとhot 33/584(6%)・片数がだいぶ減る）。
    var minGap = opts.minGap != null ? opts.minGap : Math.max(6, Math.round(n / 20));
    var hotChunk = opts.hotChunk != null ? opts.hotChunk : 8; // hot区間内の細分割の粒度（片あたりサンプル数）
    // 段7-3: 隣の片との重なりサンプル数（既定1）。動画/PNG（ラスタ化）だけ2にして継ぎ目
    // （白い細線）を埋める（ユーザー決定・2026-09-25）。SVG書き出しは1のまま
    // （Illustratorで合体して使うため）。
    var overlap = Math.max(1, opts.overlap != null ? opts.overlap : 1);
    if (n < 2) return { sequential: [], byDepth: [] };
    var hot = detectHotIndices(samples, halfWidths, minGap);
    var anyHot = hot.some(function (h) { return h; });
    if (!anyHot) {
      // 自己接近が一度も無い形（円など）→回しても常に1個の片
      var idxsAll = [];
      for (var i = 0; i < n; i++) idxsAll.push(i);
      var zsAll = idxsAll.map(function (idx) { return zValues[idx]; });
      var meanZAll = zsAll.reduce(function (a, b) { return a + b; }, 0) / zsAll.length;
      var seqAll = [{ order: 0, indices: idxsAll, meanZ: meanZAll }];
      return { sequential: seqAll, byDepth: seqAll };
    }
    // hot/not-hotの連続区間（run）に分ける。閉路なので先頭と末尾が同じ状態ならまたぐ。
    var runs = []; // {start, len, hot}
    var startIdx = 0;
    // 先頭のhot状態が末尾と同じ場合、run境界を「状態が変わる場所」まで回して合わせる
    var rot = 0;
    for (var k = 1; k < n; k++) { if (hot[k] !== hot[0]) { rot = k; break; } }
    function idxAt(k) { return (rot + k) % n; }
    var curHot = hot[idxAt(0)], runStart = 0;
    for (var k = 1; k <= n; k++) {
      var h = k < n ? hot[idxAt(k)] : !curHot; // 番兵で最後のrunを確定させる
      if (h !== curHot) {
        runs.push({ startK: runStart, lenK: k - runStart, hot: curHot });
        runStart = k; curHot = h;
      }
    }
    var sequential = [];
    var order = 0;
    runs.forEach(function (run) {
      var idxsOfRun = [];
      for (var t = 0; t < run.lenK; t++) idxsOfRun.push(idxAt(run.startK + t));
      if (!run.hot) {
        // 非hot区間はそのまま1本（次の片の先頭をoverlapサンプル重ねて継ぎ目を消す）
        var idxs = idxsOfRun.slice();
        for (var ov = 0; ov < overlap; ov++) idxs.push(idxAt(run.startK + run.lenK + ov) % n);
        pushPiece(idxs);
      } else {
        // hot区間だけ従来どおり細かく割る
        var per = hotChunk;
        for (var s = 0; s < idxsOfRun.length; s += per) {
          var chunk = idxsOfRun.slice(s, Math.min(idxsOfRun.length, s + per));
          for (var ov2 = 0; ov2 < overlap; ov2++) chunk.push(idxAt(run.startK + Math.min(idxsOfRun.length, s + per) + ov2) % n);
          pushPiece(chunk);
        }
      }
    });
    function pushPiece(idxs) {
      var zs = idxs.map(function (idx) { return zValues[idx]; });
      var meanZ = zs.reduce(function (a, b) { return a + b; }, 0) / zs.length;
      sequential.push({ order: order++, indices: idxs, meanZ: meanZ });
    }
    var byDepth = sequential.slice().sort(function (a, b) { return a.meanZ - b.meanZ; });
    return { sequential: sequential, byDepth: byDepth };
  }

  /* --- 段4: 折り返し（ヘアピン）を丸く見せる（2026-09-25 ユーザー決定「丸く見せる案Bで」） ---
     Illustratorの線の角＝ラウンド結合と同じ考え方。投影後の中心線で法線が急に回る箇所
     （隣接する法線どうしのなす角がthresholdDeg以上）を検出し、その点を中心にした半円弧
     （半径＝その位置の左/右の幅）を帯の輪郭に挟む。左右非対称でも左右それぞれの半径で描く。
     samples/normals/leftW/rightWは同じ長さ・投影後の2D中心線に対応するインデックス。
     戻り値: { left, right, sourceIdx }（left/rightは弧の分だけ点が増える。sourceIdxは
     各出力点が元のどのインデックス由来か＝zやピースの割り当てに使う）。 ------------------- */
  function angleBetweenUnit(a, b) {
    var dot = a[0] * b[0] + a[1] * b[1];
    dot = Math.max(-1, Math.min(1, dot));
    return Math.acos(dot) * 180 / Math.PI;
  }
  function roundHairpinCorners(samples, normals, leftW, rightW, thresholdDeg, arcSteps) {
    thresholdDeg = thresholdDeg == null ? 120 : thresholdDeg;
    arcSteps = arcSteps == null ? 12 : arcSteps;
    var n = samples.length;
    var left = [], right = [], sourceIdx = [];
    for (var i = 0; i < n; i++) {
      var prevN = normals[(i - 1 + n) % n], nextN = normals[(i + 1) % n];
      var ang = angleBetweenUnit(prevN, nextN);
      var nx = normals[i][0], ny = normals[i][1];
      var wl = leftW[i], wr = rightW[i];
      if (ang >= thresholdDeg && n >= 3) {
        var pivot = samples[i];
        var din = [samples[i][0] - samples[(i - 1 + n) % n][0], samples[i][1] - samples[(i - 1 + n) % n][1]];
        var dout = [samples[(i + 1) % n][0] - samples[i][0], samples[(i + 1) % n][1] - samples[i][1]];
        var cross = din[0] * dout[1] - din[1] * dout[0];
        var sign = cross >= 0 ? 1 : -1;
        var startAngle = Math.atan2(ny, nx);
        for (var k = 0; k <= arcSteps; k++) {
          var a = startAngle + sign * Math.PI * (k / arcSteps); // 半円=π
          left.push([pivot[0] + Math.cos(a) * wl, pivot[1] + Math.sin(a) * wl]);
          right.push([pivot[0] - Math.cos(a) * wr, pivot[1] - Math.sin(a) * wr]);
          sourceIdx.push(i);
        }
      } else {
        left.push([samples[i][0] + nx * wl, samples[i][1] + ny * wl]);
        right.push([samples[i][0] - nx * wr, samples[i][1] - ny * wr]);
        sourceIdx.push(i);
      }
    }
    return { left: left, right: right, sourceIdx: sourceIdx };
  }

  return {
    rotateProject: rotateProject,
    linkedDepth: linkedDepth,
    splitBandPieces: splitBandPieces,
    splitBandAdaptive: splitBandAdaptive,
    roundHairpinCorners: roundHairpinCorners
  };
});
