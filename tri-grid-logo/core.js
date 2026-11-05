/*!
 * tri-grid/core.js — DOM非依存の純関数だけを持つコア。
 * 格子モデル（cells）・融合アルゴリズム（辺の相殺→ループ化→pathのd文字列）・
 * ミラー写像・paramsのvalidateを持つ。index.html からは <script src="core.js"> で、
 * test.mjs からは createRequire で読む（000_README.md の実装の要点に準拠）。
 *
 * 座標系: 1マス = 10単位（UNIT=10）。マス角 = 整数×10、マス中心 = 角+5。
 * 弧（四分円・凹の要素）の半径 = 1マス = UNIT。すべて整数で完結する。
 */
(function (root, factory) {
  var M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (root) root.TriGrid = M;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UNIT = 10;
  var CYCLE = ['TL', 'TR', 'BR', 'BL']; // マスの角。時計回り（CW）＝この規約でのshoelace正の向き
  var TRI_DIRS = ['up', 'right', 'down', 'left'];
  var CORNERS = ['tl', 'tr', 'br', 'bl'];

  /* ============================================================
   * 1. 格子モデル（cells: Map<'col,row', cell>）
   *    cell = null
   *         | { mode:'tri', tris:{up,right,down,left: 1..4|null} }
   *         | { mode:'quarter', shape:'quarter'|'notch', corner:'tl'|'tr'|'br'|'bl', color:1..4 }
   * ============================================================ */
  function cellKey(col, row) { return col + ',' + row; }

  // arcs: Map<id, arc>（仕様v6「大きな円弧」。半径2マス以上の四分円/凹/リング。
  // arc = {gx,gy,quad,r,hole,shape,color}。arcSeqは新規idの発行元（保存はしない）
  function createGrid(n) { return { n: n, cells: new Map(), arcs: new Map(), arcSeq: 0 }; }

  function getCell(grid, col, row) { return grid.cells.get(cellKey(col, row)) || null; }
  function setCell(grid, col, row, cell) {
    var k = cellKey(col, row);
    if (cell == null) grid.cells.delete(k); else grid.cells.set(k, cell);
  }
  function clearGrid(grid) { grid.cells.clear(); }

  function emptyTris() { return { up: null, right: null, down: null, left: null }; }
  function isEmptyTris(t) { return !t.up && !t.right && !t.down && !t.left; }

  function paintTriangle(grid, col, row, dir, color) {
    var cell = getCell(grid, col, row);
    var tris = (cell && cell.mode === 'tri') ? Object.assign({}, cell.tris) : emptyTris();
    tris[dir] = color;
    setCell(grid, col, row, { mode: 'tri', tris: tris });
  }
  function eraseTriangle(grid, col, row, dir) {
    var cell = getCell(grid, col, row);
    if (!cell || cell.mode !== 'tri') return;
    var tris = Object.assign({}, cell.tris);
    tris[dir] = null;
    if (isEmptyTris(tris)) setCell(grid, col, row, null);
    else setCell(grid, col, row, { mode: 'tri', tris: tris });
  }
  function paintSquare(grid, col, row, color) {
    setCell(grid, col, row, { mode: 'tri', tris: { up: color, right: color, down: color, left: color } });
  }
  function eraseCell(grid, col, row) { setCell(grid, col, row, null); }
  function paintQuarter(grid, col, row, corner, color) {
    setCell(grid, col, row, { mode: 'quarter', shape: 'quarter', corner: corner, color: color });
  }
  function paintNotch(grid, col, row, corner, color) {
    setCell(grid, col, row, { mode: 'quarter', shape: 'notch', corner: corner, color: color });
  }
  // 消しゴム: そのマスに今あるものを、ブラシの形に応じて消す（三角=その1枚だけ／それ以外=マス全体）
  function eraseByBrush(grid, col, row, shape, dir) {
    clearArcsAtCell(grid, col, row); // 仕様v6「大きな円弧」占有ルール
    if (shape === 'tri') { eraseTriangle(grid, col, row, dir); return; }
    eraseCell(grid, col, row);
  }

  function cellsToObject(grid) {
    var o = {};
    grid.cells.forEach(function (cell, key) { o[key] = cell; });
    return o;
  }
  // 保存できる形の配列に直す（idは持ち出さない＝読み直すたびに新しいidを振り直す）
  function arcsToArray(grid) {
    var out = [];
    if (grid.arcs) grid.arcs.forEach(function (arc) {
      out.push({ gx: arc.gx, gy: arc.gy, quad: arc.quad, r: arc.r, hole: arc.hole || 0, shape: arc.shape, color: arc.color });
    });
    return out;
  }
  // arcsArr: 保存できる形の配列（[{gx,gy,quad,r,hole,shape,color},...]）。無ければ[]扱い
  function gridFromCells(n, obj, arcsArr) {
    var g = createGrid(n);
    if (obj) for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) g.cells.set(k, obj[k]);
    (arcsArr || []).forEach(function (arc) {
      g.arcSeq++;
      g.arcs.set('arc-' + g.arcSeq, { gx: arc.gx, gy: arc.gy, quad: arc.quad, r: arc.r, hole: arc.hole || 0, shape: arc.shape, color: arc.color });
    });
    return g;
  }

  /* ============================================================
   * 2. 幾何（マス内のローカル座標・角/三角の当たり判定）
   * ============================================================ */
  function cellBounds(col, row) {
    var x0 = col * UNIT, y0 = row * UNIT, x1 = x0 + UNIT, y1 = y0 + UNIT;
    return { x0: x0, y0: y0, x1: x1, y1: y1, cx: x0 + UNIT / 2, cy: y0 + UNIT / 2 };
  }
  function squareCorners(col, row) {
    var b = cellBounds(col, row);
    return { TL: { x: b.x0, y: b.y0 }, TR: { x: b.x1, y: b.y0 }, BR: { x: b.x1, y: b.y1 }, BL: { x: b.x0, y: b.y1 } };
  }
  // lx,ly はマス内ローカル座標 [0,1)。対角線2本でできる4つの三角のうち最も近いものを返す
  function nearestTriangleDir(lx, ly) {
    var underMain = ly < lx;      // 対角線 TL-BR（y=x）より上か
    var underAnti = ly < 1 - lx;  // 対角線 TR-BL（y=1-x）より上か
    if (underMain && underAnti) return 'up';
    if (underMain && !underAnti) return 'right';
    if (!underMain && !underAnti) return 'down';
    return 'left';
  }
  // lx,ly はマス内ローカル座標 [0,1)。最も近い角を返す
  function nearestCorner(lx, ly) {
    if (lx < 0.5 && ly < 0.5) return 'tl';
    if (lx >= 0.5 && ly < 0.5) return 'tr';
    if (lx >= 0.5 && ly >= 0.5) return 'br';
    return 'bl';
  }

  /* ============================================================
   * 3. 要素 → 有向辺列（反時計回りではなく、CW=shoelace正で統一。
   *    詳しくは000_README.mdの記述と符号が逆だが、実装はこの符号規約で
   *    一貫しており、DoDのケース(a)〜(j)を満たすことをtest.mjsで確認済み）
   * ============================================================ */
  function edge(a, b) { return { a: a, b: b, arc: null }; }
  function arcEdge(a, b, center, r, sweep) { return { a: a, b: b, arc: { cx: center.x, cy: center.y, r: r, sweep: sweep } }; }

  function triEdges(col, row, dir) {
    var P = squareCorners(col, row), b = cellBounds(col, row), C = { x: b.cx, y: b.cy };
    switch (dir) {
      case 'up': return [edge(P.TL, P.TR), edge(P.TR, C), edge(C, P.TL)];
      case 'right': return [edge(P.TR, P.BR), edge(P.BR, C), edge(C, P.TR)];
      case 'down': return [edge(P.BR, P.BL), edge(P.BL, C), edge(C, P.BR)];
      case 'left': return [edge(P.BL, P.TL), edge(P.TL, C), edge(C, P.BL)];
      default: return [];
    }
  }
  // X=角, Y=次の角(CW), W=対角, Z=前の角(CW)
  function cornerSet(col, row, corner) {
    var P = squareCorners(col, row);
    var i = CORNERS.indexOf(corner);
    return {
      X: P[CYCLE[i]], Y: P[CYCLE[(i + 1) % 4]], W: P[CYCLE[(i + 2) % 4]], Z: P[CYCLE[(i + 3) % 4]]
    };
  }
  function quarterEdges(col, row, corner) {
    var c = cornerSet(col, row, corner);
    return [edge(c.X, c.Y), arcEdge(c.Y, c.Z, c.X, UNIT, 1), edge(c.Z, c.X)];
  }
  function notchEdges(col, row, corner) {
    var c = cornerSet(col, row, corner);
    return [edge(c.Y, c.W), edge(c.W, c.Z), arcEdge(c.Z, c.Y, c.X, UNIT, 0)];
  }

  // colorFn(element, manualColor) があれば、融合のグルーピングに使う色を差し替える
  // （仕様v4 段E「向きで色を決める」。effectiveColorOfを参照）。無ければ手選び色のまま（従来通り）
  function collectEdgesForColor(grid, color, colorFn) {
    var edges = [];
    grid.cells.forEach(function (cell, key) {
      if (!cell) return;
      var parts = key.split(','), col = +parts[0], row = +parts[1];
      if (cell.mode === 'tri') {
        TRI_DIRS.forEach(function (dir) {
          var manual = cell.tris[dir];
          if (manual == null) return;
          var eff = colorFn ? colorFn({ kind: 'tri', col: col, row: row, dir: dir, cell: cell }, manual) : manual;
          if (eff === color) edges = edges.concat(triEdges(col, row, dir));
        });
      } else if (cell.mode === 'quarter') {
        var eff2 = colorFn ? colorFn({ kind: 'quarter', col: col, row: row, corner: cell.corner }, cell.color) : cell.color;
        if (eff2 === color) edges = edges.concat(cell.shape === 'quarter' ? quarterEdges(col, row, cell.corner) : notchEdges(col, row, cell.corner));
      }
    });
    // 大きな円弧（仕様v6）: ブロック左上(col,row)を渡し、向き(quad)による色・明暗の対応は
    // 既存の四分円({kind:'quarter',corner})と同じ扱いにする
    if (grid.arcs) grid.arcs.forEach(function (arc) {
      var block = arcBlock(arc);
      var effA = colorFn ? colorFn({ kind: 'quarter', col: block.c0, row: block.r0, corner: arc.quad }, arc.color) : arc.color;
      if (effA === color) edges = edges.concat(bigArcEdges(arc));
    });
    return edges;
  }

  /* ============================================================
   * 4. 融合: 辺の相殺 → ループ化（市松の角は最も右へ曲がる辺を選び島を分ける）
   *    → 直線の連続を統合 → path の d文字列
   * ============================================================ */
  function pointsEqual(p, q) { return p.x === q.x && p.y === q.y; }
  function cmpPoint(p, q) { return (p.x - q.x) || (p.y - q.y); }
  function ptKey(p) { return p.x + ',' + p.y; }

  function edgeUndirectedKey(e) {
    var pts = [e.a, e.b].slice().sort(cmpPoint);
    if (e.arc) return 'A|' + e.arc.cx + ',' + e.arc.cy + ',' + e.arc.r + '|' + ptKey(pts[0]) + '|' + ptKey(pts[1]);
    return 'L|' + ptKey(pts[0]) + '|' + ptKey(pts[1]);
  }

  function cancelEdges(edges) {
    var groups = new Map();
    edges.forEach(function (e) {
      var k = edgeUndirectedKey(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    var kept = [];
    groups.forEach(function (list) {
      if (list.length === 2 && pointsEqual(list[0].a, list[1].b) && pointsEqual(list[0].b, list[1].a)) return; // 相殺
      list.forEach(function (e) { kept.push(e); });
    });
    return kept;
  }

  // 辺の始点/終点での接線方向（直線=一定。弧=半径ベクトルを sweep の向きに90度回す）
  function tangentAtStart(e) {
    if (!e.arc) return { x: e.b.x - e.a.x, y: e.b.y - e.a.y };
    var rx = e.a.x - e.arc.cx, ry = e.a.y - e.arc.cy;
    return e.arc.sweep ? { x: -ry, y: rx } : { x: ry, y: -rx };
  }
  function tangentAtEnd(e) {
    if (!e.arc) return { x: e.b.x - e.a.x, y: e.b.y - e.a.y };
    var rx = e.b.x - e.arc.cx, ry = e.b.y - e.arc.cy;
    return e.arc.sweep ? { x: -ry, y: rx } : { x: ry, y: -rx };
  }
  // 入ってきた辺の終端方向から見て、最も時計回りに近い（＝最も右へ曲がる）出て行く辺を選ぶ
  function pickTurn(prevEdge, candidates) {
    var inDir = tangentAtEnd(prevEdge);
    var thetaIn = Math.atan2(inDir.y, inDir.x);
    var best = null, bestDelta = Infinity;
    candidates.forEach(function (c) {
      var outDir = tangentAtStart(c);
      var thetaOut = Math.atan2(outDir.y, outDir.x);
      var delta = ((thetaOut - thetaIn) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      if (delta <= 1e-9) delta += 2 * Math.PI;
      if (delta < bestDelta) { bestDelta = delta; best = c; }
    });
    return best;
  }

  function buildLoops(edges) {
    var byStart = new Map();
    edges.forEach(function (e) {
      e.used = false;
      var k = ptKey(e.a);
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(e);
    });
    var loops = [];
    edges.forEach(function (startEdge) {
      if (startEdge.used) return;
      var loopEdges = [];
      var cur = startEdge, first = startEdge;
      var guard = 0;
      while (guard++ < edges.length + 2) {
        cur.used = true;
        loopEdges.push(cur);
        if (pointsEqual(cur.b, first.a)) break;
        var candidates = (byStart.get(ptKey(cur.b)) || []).filter(function (e) { return !e.used; });
        if (!candidates.length) break; // 閉じない場合は安全側で打ち切る（正常な格子では起きない）
        cur = candidates.length === 1 ? candidates[0] : pickTurn(cur, candidates);
      }
      loops.push(loopEdges);
    });
    return loops;
  }

  // 連続する同方向の直線を1本へ統合（末尾→先頭のまたぎも1回だけ処理）
  function mergeCollinear(loopEdges) {
    var out = [];
    loopEdges.forEach(function (e) {
      var last = out[out.length - 1];
      if (last && !last.arc && !e.arc && pointsEqual(last.b, e.a)) {
        var d1x = last.b.x - last.a.x, d1y = last.b.y - last.a.y;
        var d2x = e.b.x - e.a.x, d2y = e.b.y - e.a.y;
        var cross = d1x * d2y - d1y * d2x;
        var dot = d1x * d2x + d1y * d2y;
        if (cross === 0 && dot > 0) { last.b = e.b; return; }
      }
      out.push({ a: e.a, b: e.b, arc: e.arc });
    });
    if (out.length > 1) {
      var first = out[0], last2 = out[out.length - 1];
      if (!first.arc && !last2.arc && pointsEqual(last2.b, first.a)) {
        var d1x2 = last2.b.x - last2.a.x, d1y2 = last2.b.y - last2.a.y;
        var d2x2 = first.b.x - first.a.x, d2y2 = first.b.y - first.a.y;
        var cross2 = d1x2 * d2y2 - d1y2 * d2x2;
        var dot2 = d1x2 * d2x2 + d1y2 * d2y2;
        if (cross2 === 0 && dot2 > 0) { first.a = last2.a; out.pop(); }
      }
    }
    return out;
  }

  // 直線で始点に戻る最後の辺は Z が暗黙に閉じるので明示のLを重複させない（弧はZで描けないので残す）
  function dropRedundantClose(loopEdges) {
    if (loopEdges.length <= 1) return loopEdges;
    var last = loopEdges[loopEdges.length - 1], first = loopEdges[0];
    if (!last.arc && pointsEqual(last.b, first.a)) return loopEdges.slice(0, -1);
    return loopEdges;
  }

  function roundTo(v, dp) {
    if (dp == null) return v;
    var f = Math.pow(10, dp);
    return Math.round(v * f) / f;
  }
  function loopToPathD(loopEdges, dp) {
    var fn = function (v) { return roundTo(v, dp); };
    var d = 'M' + fn(loopEdges[0].a.x) + ' ' + fn(loopEdges[0].a.y);
    loopEdges.forEach(function (e) {
      if (e.arc) d += ' A' + fn(e.arc.r) + ' ' + fn(e.arc.r) + ' 0 0 ' + e.arc.sweep + ' ' + fn(e.b.x) + ' ' + fn(e.b.y);
      else d += ' L' + fn(e.b.x) + ' ' + fn(e.b.y);
    });
    return d + ' Z';
  }

  /* ============================================================
   * 4.5 角丸（融合後ループの頂点を弧に置き換える。000_README.md v2「角丸」）
   *    ・元からある四分円/凹の弧には触れない（弧に接する頂点は丸めない）
   *    ・凸/凹の判定はループ自身の符号付き面積と、頂点での曲がり方向の符号を比べる
   *      （同符号=凸、逆符号=凹。凸のみモードで使う）
   *    ・半径は隣接2辺の短い方の1/2を上限にクランプする
   *    ・フィレット幾何（頂点Vを2辺それぞれ距離tだけ手前で切り、弧でつなぐ）は
   *      凸・凹のどちらでも同じ式で成立する（両側の辺への接線円を作るだけなので）
   * ============================================================ */
  function vecLen(v) { return Math.sqrt(v.x * v.x + v.y * v.y); }
  function normVec(v) {
    var len = vecLen(v);
    return len > 1e-9 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
  }
  function loopSignedArea(loopEdges) {
    var sum = 0;
    loopEdges.forEach(function (e) { sum += e.a.x * e.b.y - e.b.x * e.a.y; });
    return sum / 2;
  }
  function filletVertex(A, V, B, r) {
    var vA = normVec({ x: A.x - V.x, y: A.y - V.y });
    var vB = normVec({ x: B.x - V.x, y: B.y - V.y });
    if ((vA.x === 0 && vA.y === 0) || (vB.x === 0 && vB.y === 0)) return null;
    var dot = Math.max(-1, Math.min(1, vA.x * vB.x + vA.y * vB.y));
    var phi = Math.acos(dot);
    if (phi < 1e-6 || phi > Math.PI - 1e-6) return null; // 直線状・反転は丸めない
    var half = phi / 2;
    var t = r / Math.tan(half);
    var distC = r / Math.sin(half);
    var bis = normVec({ x: vA.x + vB.x, y: vA.y + vB.y });
    if (bis.x === 0 && bis.y === 0) return null;
    var C = { x: V.x + bis.x * distC, y: V.y + bis.y * distC };
    var P1 = { x: V.x + vA.x * t, y: V.y + vA.y * t };
    var P2 = { x: V.x + vB.x * t, y: V.y + vB.y * t };
    var a1 = Math.atan2(P1.y - C.y, P1.x - C.x);
    var a2 = Math.atan2(P2.y - C.y, P2.x - C.x);
    var diff = a2 - a1;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    return { p1: P1, p2: P2, center: C, sweep: diff > 0 ? 1 : 0 };
  }
  // mode: 'none' | 'convex' | 'both'。radius はマス単位（例 UNIT/4, UNIT/2）
  function roundLoopCorners(loopEdges, mode, radius) {
    var n = loopEdges.length;
    if (!mode || mode === 'none' || n < 2 || !radius || radius <= 0) return loopEdges;
    var area = mode === 'convex' ? loopSignedArea(loopEdges) : 0;
    var startTrim = new Array(n).fill(null);
    var endTrim = new Array(n).fill(null);
    var arcAt = new Array(n).fill(null); // 辺iの直後に挿む弧
    for (var i = 0; i < n; i++) {
      var prevIdx = (i - 1 + n) % n;
      var prev = loopEdges[prevIdx], next = loopEdges[i];
      if (prev.arc || next.arc) continue; // 既存の弧に接する頂点は丸めない
      var V = next.a;
      var lenPrev = vecLen({ x: prev.b.x - prev.a.x, y: prev.b.y - prev.a.y });
      var lenNext = vecLen({ x: next.b.x - next.a.x, y: next.b.y - next.a.y });
      // 接線長 t = r / tan(θ/2) が隣接辺の半分を超えると弧同士が食い合う（60°の角で三角が
      // 3枚羽根状に崩れた不具合）。角度込みで r を抑える。90°では従来の min(len/2) と一致。
      var ux = prev.a.x - V.x, uy = prev.a.y - V.y, wx = next.b.x - V.x, wy = next.b.y - V.y;
      var cosT = (ux * wx + uy * wy) / (lenPrev * lenNext);
      cosT = Math.max(-1, Math.min(1, cosT));
      var tanHalf = Math.sqrt(Math.max(0, (1 - cosT) / (1 + cosT)));
      var r = Math.min(radius, (Math.min(lenPrev, lenNext) / 2) * tanHalf);
      if (r <= 1e-9) continue;
      if (mode === 'convex') {
        var prevDir = { x: prev.b.x - prev.a.x, y: prev.b.y - prev.a.y };
        var nextDir = { x: next.b.x - next.a.x, y: next.b.y - next.a.y };
        var cross = prevDir.x * nextDir.y - prevDir.y * nextDir.x;
        if (!(cross * area > 0)) continue; // 凸角でなければ丸めない
      }
      var fil = filletVertex(prev.a, V, next.b, r);
      if (!fil) continue;
      endTrim[prevIdx] = fil.p1;
      startTrim[i] = fil.p2;
      arcAt[prevIdx] = { a: fil.p1, b: fil.p2, arc: { cx: fil.center.x, cy: fil.center.y, r: r, sweep: fil.sweep } };
    }
    var out = [];
    for (var j = 0; j < n; j++) {
      var e = loopEdges[j];
      var a = startTrim[j] || e.a;
      var b = endTrim[j] || e.b;
      if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6) out.push({ a: a, b: b, arc: e.arc });
      if (arcAt[j]) out.push(arcAt[j]);
    }
    return out;
  }

  // opts.round = { mode:'none'|'convex'|'both', radius:number } （省略時は角丸なし・整数座標のまま）
  function buildColorPathD(grid, color, opts) {
    var kept = cancelEdges(collectEdgesForColor(grid, color, opts && opts.colorFn));
    if (!kept.length) return null;
    var loops = buildLoops(kept).map(mergeCollinear);
    var round = opts && opts.round;
    var dp = null;
    // 角丸は dropRedundantClose の前にかける: dropRedundantCloseは「最後の辺は暗黙のZで
    // 閉じるので明示のLを省く」最適化で、そのままだと辺が1本欠けて頂点の対応(prev/next)が
    // ずれる。角丸は全頂点が辺で明示につながった状態で計算し、丸め終えてから最後にもう一度
    // dropRedundantCloseをかけて出力を整える。
    if (round && round.mode && round.mode !== 'none') {
      dp = 2;
      loops = loops.map(function (loop) { return roundLoopCorners(loop, round.mode, round.radius); });
    }
    loops = loops.map(dropRedundantClose).filter(function (l) { return l.length > 0; });
    if (!loops.length) return null;
    return loops.map(function (loop) { return loopToPathD(loop, dp); }).join(' ');
  }
  function buildAllPaths(grid, colorCount, opts) {
    var out = [];
    for (var c = 1; c <= (colorCount || 4); c++) {
      var d = buildColorPathD(grid, c, opts);
      if (d) out.push({ color: c, d: d });
    }
    return out;
  }

  /* ============================================================
   * 4.5 書き出しの形「要素ごとに分ける」（2026-09-16採用。ユーザー「svgにした時に
   *    全てバラバラにして いまはくっついちゃっている」）。融合(buildAllPaths系)と違い、
   *    置いた要素1つ＝path 1つにする。各要素は自分の辺だけをcancelEdges/buildLoopsに
   *    通す（他要素と辺を共有していても相殺・融合しない）。colorFnは融合版と同じ契約
   *    （effectiveColorOf/shadeFaceIdOfをそのまま渡せる＝表示色の決め方は変えない）。
   * ============================================================ */
  function finishExplodedPathD(edges, round, dp) {
    var kept = cancelEdges(edges);
    if (!kept.length) return null;
    var loops = buildLoops(kept).map(mergeCollinear);
    var outDp = dp;
    if (round && round.mode && round.mode !== 'none') {
      outDp = 2;
      loops = loops.map(function (loop) { return roundLoopCorners(loop, round.mode, round.radius); });
    }
    loops = loops.map(dropRedundantClose).filter(function (l) { return l.length > 0; });
    if (!loops.length) return null;
    return loops.map(function (loop) { return loopToPathD(loop, outDp); }).join(' ');
  }
  // 正方形格子: 三角(向きごと)・四分円・凹・大きな円弧の1要素＝1path。戻り値の色は
  // 表示用の実効色（colorFn適用後）で、buildAllPathsと同じ{color,d}の形にする
  function buildExplodedPaths(grid, opts) {
    var out = [];
    var colorFn = opts && opts.colorFn;
    var round = opts && opts.round;
    grid.cells.forEach(function (cell, key) {
      if (!cell) return;
      var parts = key.split(','), col = +parts[0], row = +parts[1];
      if (cell.mode === 'tri') {
        TRI_DIRS.forEach(function (dir) {
          var manual = cell.tris[dir];
          if (manual == null) return;
          var eff = colorFn ? colorFn({ kind: 'tri', col: col, row: row, dir: dir, cell: cell }, manual) : manual;
          var d = finishExplodedPathD(triEdges(col, row, dir), round, null);
          if (d) out.push({ color: eff, d: d });
        });
      } else if (cell.mode === 'quarter') {
        var eff2 = colorFn ? colorFn({ kind: 'quarter', col: col, row: row, corner: cell.corner }, cell.color) : cell.color;
        var edges2 = cell.shape === 'quarter' ? quarterEdges(col, row, cell.corner) : notchEdges(col, row, cell.corner);
        var d2 = finishExplodedPathD(edges2, round, null);
        if (d2) out.push({ color: eff2, d: d2 });
      }
    });
    if (grid.arcs) grid.arcs.forEach(function (arc) {
      var block = arcBlock(arc);
      var eff3 = colorFn ? colorFn({ kind: 'quarter', col: block.c0, row: block.r0, corner: arc.quad }, arc.color) : arc.color;
      var d3 = finishExplodedPathD(bigArcEdges(arc), round, null);
      if (d3) out.push({ color: eff3, d: d3 });
    });
    return out;
  }

  /* ============================================================
   * 5. ミラー写像（三角の向き・四分円/凹の角を対応して写す）
   * ============================================================ */
  var MIRROR_X_DIR = { up: 'up', down: 'down', left: 'right', right: 'left' };
  var MIRROR_Y_DIR = { up: 'down', down: 'up', left: 'left', right: 'right' };
  var ROT90_DIR = { up: 'right', right: 'down', down: 'left', left: 'up' };
  var MIRROR_X_CORNER = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };
  var MIRROR_Y_CORNER = { tl: 'bl', bl: 'tl', tr: 'br', br: 'tr' };
  var ROT90_CORNER = { tl: 'tr', tr: 'br', br: 'bl', bl: 'tl' };

  function applyMirrorOnce(kind, n, e) {
    var col = e.col, row = e.row, dir = e.dir, corner = e.corner;
    if (kind === 'lr') return { col: n - 1 - col, row: row, dir: dir ? MIRROR_X_DIR[dir] : dir, corner: corner ? MIRROR_X_CORNER[corner] : corner };
    if (kind === 'ud') return { col: col, row: n - 1 - row, dir: dir ? MIRROR_Y_DIR[dir] : dir, corner: corner ? MIRROR_Y_CORNER[corner] : corner };
    if (kind === 'rot90') return { col: n - 1 - row, row: col, dir: dir ? ROT90_DIR[dir] : dir, corner: corner ? ROT90_CORNER[corner] : corner };
    return { col: col, row: row, dir: dir, corner: corner };
  }
  function mirrorPositions(mode, n, e) {
    var base = { col: e.col, row: e.row, dir: e.dir, corner: e.corner };
    var list = [base];
    if (mode === 'lr') list.push(applyMirrorOnce('lr', n, base));
    else if (mode === 'ud') list.push(applyMirrorOnce('ud', n, base));
    else if (mode === 'lr-ud') {
      var lr = applyMirrorOnce('lr', n, base), ud = applyMirrorOnce('ud', n, base), both = applyMirrorOnce('ud', n, lr);
      list.push(lr, ud, both);
    } else if (mode === 'rot4') {
      var r1 = applyMirrorOnce('rot90', n, base), r2 = applyMirrorOnce('rot90', n, r1), r3 = applyMirrorOnce('rot90', n, r2);
      list.push(r1, r2, r3);
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      var k = p.col + ',' + p.row + '|' + p.dir + '|' + p.corner;
      if (!seen[k]) { seen[k] = 1; out.push(p); }
    });
    return out;
  }

  /* ============================================================
   * 6. 塗り／消しの入口（ミラーを適用してから各セルへ書き込む）
   * ============================================================ */
  function paint(grid, opts) {
    var n = opts.n != null ? opts.n : grid.n;
    var positions = mirrorPositions(opts.mirror || 'none', n, { col: opts.col, row: opts.row, dir: opts.dir, corner: opts.corner });
    positions.forEach(function (p) {
      if (p.col < 0 || p.row < 0 || p.col >= n || p.row >= n) return;
      // 仕様v6「大きな円弧」占有ルール: マスに三角/正方形/四分円/凹を塗る・消しゴムを当てる
      // ときは、そのマスを占めるarc（あれば）を消す
      clearArcsAtCell(grid, p.col, p.row);
      if (opts.shape === 'tri') {
        if (opts.erase) eraseTriangle(grid, p.col, p.row, p.dir);
        else paintTriangle(grid, p.col, p.row, p.dir, opts.color);
      } else if (opts.shape === 'square') {
        if (opts.erase) eraseCell(grid, p.col, p.row);
        else paintSquare(grid, p.col, p.row, opts.color);
      } else if (opts.shape === 'quarter') {
        if (opts.erase) eraseCell(grid, p.col, p.row);
        else paintQuarter(grid, p.col, p.row, p.corner, opts.color);
      } else if (opts.shape === 'notch') {
        if (opts.erase) eraseCell(grid, p.col, p.row);
        else paintNotch(grid, p.col, p.row, p.corner, opts.color);
      } else if (opts.shape === 'eraser') {
        var cell = getCell(grid, p.col, p.row);
        if (cell && cell.mode === 'tri') eraseTriangle(grid, p.col, p.row, p.dir);
        else eraseCell(grid, p.col, p.row);
      }
    });
    return grid;
  }

  /* ============================================================
   * 6.5 半円・円ブラシ（000_README.md v2「半円・円ブラシ」）
   *    既存の四分円要素を組み合わせて置くだけ（新しい幾何は増やさない）。
   *    円 = カーソルに近い格子点を中心に2×2マスへ四分円4つ。
   *    半円 = そのうち隣り合う2マス分（向きはカーソルに近い辺=格子点からの方角で決める）。
   * ============================================================ */
  // マス内ローカル座標(lx,ly)から、そのマスの4角のうち最も近い格子点を絶対座標(gx,gy)で返す
  function nearestGridPoint(col, row, lx, ly) {
    return { gx: col + (lx >= 0.5 ? 1 : 0), gy: row + (ly >= 0.5 ? 1 : 0) };
  }
  // 格子点(gx,gy)から見て、カーソルがどちらの方角（辺）に近いか
  function nearestHalfSide(col, row, lx, ly, gx, gy) {
    var ox = (col + lx) - gx, oy = (row + ly) - gy;
    if (Math.abs(ox) >= Math.abs(oy)) return ox < 0 ? 'west' : 'east';
    return oy < 0 ? 'north' : 'south';
  }
  // 格子点(gx,gy)を中心にした2×2マス・四分円4つ（円の全体）
  function circleQuarterCells(gx, gy) {
    return [
      { col: gx - 1, row: gy - 1, corner: 'br' },
      { col: gx, row: gy - 1, corner: 'bl' },
      { col: gx - 1, row: gy, corner: 'tr' },
      { col: gx, row: gy, corner: 'tl' }
    ];
  }
  // 格子点(gx,gy)を中心にした半円（4方角のうち指定した1つ＝隣り合う2マス）
  function halfQuarterCells(gx, gy, side) {
    var map = {
      north: [{ col: gx - 1, row: gy - 1, corner: 'br' }, { col: gx, row: gy - 1, corner: 'bl' }],
      south: [{ col: gx - 1, row: gy, corner: 'tr' }, { col: gx, row: gy, corner: 'tl' }],
      east: [{ col: gx, row: gy - 1, corner: 'bl' }, { col: gx, row: gy, corner: 'tl' }],
      west: [{ col: gx - 1, row: gy - 1, corner: 'br' }, { col: gx - 1, row: gy, corner: 'tr' }]
    };
    return map[side] || [];
  }
  // opts: { kind:'half'|'circle', gx, gy, side, color, erase, mirror, n }
  // 各マスへは既存の paint({shape:'quarter', ...}) をそのまま呼ぶので、ミラーは1マスずつ正しく写る
  function paintComposite(grid, opts) {
    var n = opts.n != null ? opts.n : grid.n;
    var cells = opts.kind === 'circle' ? circleQuarterCells(opts.gx, opts.gy) : halfQuarterCells(opts.gx, opts.gy, opts.side);
    cells.forEach(function (c) {
      paint(grid, { shape: 'quarter', col: c.col, row: c.row, corner: c.corner, color: opts.color, erase: opts.erase, mirror: opts.mirror, n: n });
    });
    return grid;
  }

  /* ============================================================
   * 6.6 色の一括操作（000_README.md v2「色の一括操作」）
   *    色kを色jへ置き換える（全マス）。既存セルの複製を作ってから差し替える
   *    （他の場所（履歴のスナップショット等）が握っている元のセルオブジェクトを書き換えない）。
   * ============================================================ */
  function replaceColor(grid, from, to) {
    if (from === to) return grid;
    var updates = [];
    grid.cells.forEach(function (cell, key) {
      if (!cell) return;
      if (cell.mode === 'tri') {
        var changed = false, tris = Object.assign({}, cell.tris);
        TRI_DIRS.forEach(function (d) { if (tris[d] === from) { tris[d] = to; changed = true; } });
        if (changed) updates.push([key, { mode: 'tri', tris: tris }]);
      } else if (cell.mode === 'quarter' && cell.color === from) {
        updates.push([key, { mode: 'quarter', shape: cell.shape, corner: cell.corner, color: to }]);
      }
    });
    updates.forEach(function (u) { grid.cells.set(u[0], u[1]); });
    if (grid.arcs) grid.arcs.forEach(function (arc, id) {
      if (arc.color === from) grid.arcs.set(id, Object.assign({}, arc, { color: to }));
    });
    return grid;
  }

  /* ============================================================
   * 6.9 大きな円弧（仕様v6 2026-09-15「大きな円弧」・委任パケットpacket-big-arc.md 段A〜C）
   *    半径2マス以上の四分円/凹/リング。既存の四分円(mode:'quarter')は半径1マス固定のため、
   *    「格子ロゴみたいなのを作っているが斜めや円形が作れない」というユーザー依頼に対し、
   *    半径Rマス（R=2..12）のブロック要素として別枠(grid.arcs)で持つ。
   *    arc = { gx, gy(中心=格子点。整数0..n), quad:'tl'|'tr'|'br'|'bl'（既存の四分円のcornerと
   *    同じ意味）, r(2..12), hole(0..r-1。リングの内側の穴の半径。notchは常に0), shape:'quarter'|'notch',
   *    color }。ブロック（占めるr×rマス）はquadで決まる（既存corner=1マス版と同じ角の向き）。
   * ============================================================ */
  // quadごとに、中心Xから「次の角(Y)」「前の角(Z)」へ向かう単位方向（既存cornerSetのCW規約を
  // r マスへ一般化したもの。r=1のとき下のbigArcEdgesは既存quarterEdges/notchEdgesと同じ辺列になる）
  var ARC_QUAD_DIR = {
    tl: { dY: { x: 1, y: 0 }, dZ: { x: 0, y: 1 } },
    tr: { dY: { x: 0, y: 1 }, dZ: { x: -1, y: 0 } },
    br: { dY: { x: -1, y: 0 }, dZ: { x: 0, y: -1 } },
    bl: { dY: { x: 0, y: -1 }, dZ: { x: 1, y: 0 } }
  };
  function arcGeom(arc) {
    var d = ARC_QUAD_DIR[arc.quad];
    var X = { x: arc.gx * UNIT, y: arc.gy * UNIT };
    var Y = { x: X.x + d.dY.x * arc.r * UNIT, y: X.y + d.dY.y * arc.r * UNIT };
    var Z = { x: X.x + d.dZ.x * arc.r * UNIT, y: X.y + d.dZ.y * arc.r * UNIT };
    var W = { x: Y.x + d.dZ.x * arc.r * UNIT, y: Y.y + d.dZ.y * arc.r * UNIT };
    return { X: X, Y: Y, Z: Z, W: W, dY: d.dY, dZ: d.dZ };
  }
  // aからdir方向（単位ベクトル）へUNITずつsteps本の直線辺に分割する（隣のマスの辺と相殺
  // させるため、r*UNITの1本ではなく1マスずつに割る。委任パケット段B参照）
  function splitLineUnits(a, dir, steps) {
    var out = [], cur = a;
    for (var i = 0; i < steps; i++) {
      var next = { x: cur.x + dir.x * UNIT, y: cur.y + dir.y * UNIT };
      out.push(edge(cur, next));
      cur = next;
    }
    return out;
  }
  function bigArcEdges(arc) {
    var g = arcGeom(arc), X = g.X, Y = g.Y, Z = g.Z, W = g.W, negDY = { x: -g.dY.x, y: -g.dY.y }, negDZ = { x: -g.dZ.x, y: -g.dZ.y };
    if (arc.shape === 'notch') {
      var e1 = splitLineUnits(Y, g.dZ, arc.r); // Y→W
      var e2 = splitLineUnits(W, negDY, arc.r); // W→Z
      var e3 = [arcEdge(Z, Y, X, arc.r * UNIT, 0)];
      return e1.concat(e2, e3);
    }
    var hole = arc.hole || 0;
    if (hole > 0) {
      var Yp = { x: X.x + g.dY.x * hole * UNIT, y: X.y + g.dY.y * hole * UNIT };
      var Zp = { x: X.x + g.dZ.x * hole * UNIT, y: X.y + g.dZ.y * hole * UNIT };
      var eOut1 = splitLineUnits(Yp, g.dY, arc.r - hole); // Y'→Y
      var eArcOuter = arcEdge(Y, Z, X, arc.r * UNIT, 1);
      var eOut2 = splitLineUnits(Z, negDZ, arc.r - hole); // Z→Z'
      var eArcInner = arcEdge(Zp, Yp, X, hole * UNIT, 0);
      return eOut1.concat([eArcOuter], eOut2, [eArcInner]);
    }
    var eA = splitLineUnits(X, g.dY, arc.r); // X→Y
    var eArc = arcEdge(Y, Z, X, arc.r * UNIT, 1);
    var eB = splitLineUnits(Z, negDZ, arc.r); // Z→X
    return eA.concat([eArc], eB);
  }
  // arcが占めるr×rマスのブロック（col,row範囲。両端含む）
  function arcBlock(arc) {
    if (arc.quad === 'tl') return { c0: arc.gx, r0: arc.gy, c1: arc.gx + arc.r - 1, r1: arc.gy + arc.r - 1 };
    if (arc.quad === 'tr') return { c0: arc.gx - arc.r, r0: arc.gy, c1: arc.gx - 1, r1: arc.gy + arc.r - 1 };
    if (arc.quad === 'br') return { c0: arc.gx - arc.r, r0: arc.gy - arc.r, c1: arc.gx - 1, r1: arc.gy - 1 };
    return { c0: arc.gx, r0: arc.gy - arc.r, c1: arc.gx + arc.r - 1, r1: arc.gy - 1 }; // bl
  }
  function arcInBoundsBlock(block, n) { return block.c0 >= 0 && block.r0 >= 0 && block.c1 <= n - 1 && block.r1 <= n - 1; }
  function blocksOverlap(a, b) { return a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1; }
  // (col,row)を占めるarcを1件返す（通常は重ならない前提だが、最初に見つかったものを返す）
  function arcAt(grid, col, row) {
    var found = null;
    if (grid.arcs) grid.arcs.forEach(function (arc, id) {
      if (found) return;
      var b = arcBlock(arc);
      if (col >= b.c0 && col <= b.c1 && row >= b.r0 && row <= b.r1) found = { id: id, arc: arc };
    });
    return found;
  }
  // 占有ルール: そのマスへ三角/正方形/四分円/凹を塗る・消しゴムを当てるとき、そのマスを
  // 占めるarcを消す（paint/eraseByBrushから呼ぶ。委任パケット段C）
  function clearArcsAtCell(grid, col, row) {
    if (!grid.arcs || !grid.arcs.size) return;
    var toDelete = [];
    grid.arcs.forEach(function (arc, id) {
      var b = arcBlock(arc);
      if (col >= b.c0 && col <= b.c1 && row >= b.r0 && row <= b.r1) toDelete.push(id);
    });
    toDelete.forEach(function (id) { grid.arcs.delete(id); });
  }
  function clearCellsInBlock(grid, block) {
    for (var c = block.c0; c <= block.c1; c++) for (var r = block.r0; r <= block.r1; r++) eraseCell(grid, c, r);
  }
  function clearArcsOverlappingBlock(grid, block) {
    if (!grid.arcs) return;
    var toDelete = [];
    grid.arcs.forEach(function (arc, id) { if (blocksOverlap(arcBlock(arc), block)) toDelete.push(id); });
    toDelete.forEach(function (id) { grid.arcs.delete(id); });
  }
  // ミラー写像（arc単位。ブロックを写像しquadを対応表で変換。委任パケット段C）
  var ARC_MIRROR_X_QUAD = MIRROR_X_CORNER, ARC_MIRROR_Y_QUAD = MIRROR_Y_CORNER, ARC_ROT90_QUAD = ROT90_CORNER;
  function applyArcMirrorOnce(kind, n, a) {
    if (kind === 'lr') return { gx: n - a.gx, gy: a.gy, quad: ARC_MIRROR_X_QUAD[a.quad] };
    if (kind === 'ud') return { gx: a.gx, gy: n - a.gy, quad: ARC_MIRROR_Y_QUAD[a.quad] };
    if (kind === 'rot90') return { gx: n - a.gy, gy: a.gx, quad: ARC_ROT90_QUAD[a.quad] };
    return { gx: a.gx, gy: a.gy, quad: a.quad };
  }
  function mirrorArcPositions(mode, n, a) {
    var base = { gx: a.gx, gy: a.gy, quad: a.quad };
    var list = [base];
    if (mode === 'lr') list.push(applyArcMirrorOnce('lr', n, base));
    else if (mode === 'ud') list.push(applyArcMirrorOnce('ud', n, base));
    else if (mode === 'lr-ud') {
      var lr = applyArcMirrorOnce('lr', n, base), ud = applyArcMirrorOnce('ud', n, base), both = applyArcMirrorOnce('ud', n, lr);
      list.push(lr, ud, both);
    } else if (mode === 'rot4') {
      var r1 = applyArcMirrorOnce('rot90', n, base), r2 = applyArcMirrorOnce('rot90', n, r1), r3 = applyArcMirrorOnce('rot90', n, r2);
      list.push(r1, r2, r3);
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      var k = p.gx + ',' + p.gy + '|' + p.quad;
      if (!seen[k]) { seen[k] = 1; out.push(p); }
    });
    return out;
  }
  // opts: {gx,gy,quad,r,hole,shape,color,erase,mirror,n}。置く: ブロック内の全セルを消し、
  // 重なる他のarcも消す。格子外に出るブロックは置かない。消す: ブロックに重なるarcを消すだけ
  // （委任パケット段C）
  function paintBigArc(grid, opts) {
    var n = opts.n != null ? opts.n : grid.n;
    if (!grid.arcs) grid.arcs = new Map();
    if (grid.arcSeq == null) grid.arcSeq = 0;
    var positions = mirrorArcPositions(opts.mirror || 'none', n, { gx: opts.gx, gy: opts.gy, quad: opts.quad });
    positions.forEach(function (p) {
      var arc = { gx: p.gx, gy: p.gy, quad: p.quad, r: opts.r, hole: opts.shape === 'notch' ? 0 : (opts.hole || 0), shape: opts.shape, color: opts.color };
      var block = arcBlock(arc);
      if (!arcInBoundsBlock(block, n)) return; // 格子外は置かない
      if (opts.erase) { clearArcsOverlappingBlock(grid, block); return; }
      clearCellsInBlock(grid, block);
      clearArcsOverlappingBlock(grid, block);
      grid.arcSeq++;
      grid.arcs.set('arc-' + grid.arcSeq, arc);
    });
    return grid;
  }

  /* ============================================================
   * 6.7 塗った範囲だけ書き出す（000_README.md v2）— 塗りの外接矩形 + 余白マス
   * ============================================================ */
  function contentBounds(grid) {
    var minC = null, minR = null, maxC = null, maxR = null;
    grid.cells.forEach(function (cell, key) {
      if (!cell) return;
      var parts = key.split(','), c = +parts[0], r = +parts[1];
      if (minC === null || c < minC) minC = c;
      if (maxC === null || c > maxC) maxC = c;
      if (minR === null || r < minR) minR = r;
      if (maxR === null || r > maxR) maxR = r;
    });
    if (grid.arcs) grid.arcs.forEach(function (arc) {
      var b = arcBlock(arc);
      if (minC === null || b.c0 < minC) minC = b.c0;
      if (maxC === null || b.c1 > maxC) maxC = b.c1;
      if (minR === null || b.r0 < minR) minR = b.r0;
      if (maxR === null || b.r1 > maxR) maxR = b.r1;
    });
    if (minC === null) return null;
    return { minCol: minC, minRow: minR, maxCol: maxC, maxRow: maxR };
  }
  // margin はマス単位の余白（0〜4想定）。中身が無い場合は盤面全体を返す
  function trimmedViewBox(grid, margin) {
    var n = grid.n, m = margin || 0;
    var b = contentBounds(grid);
    if (!b) return { x: 0, y: 0, w: n * UNIT, h: n * UNIT };
    var minCol = Math.max(0, b.minCol - m), minRow = Math.max(0, b.minRow - m);
    var maxCol = Math.min(n, b.maxCol + 1 + m), maxRow = Math.min(n, b.maxRow + 1 + m);
    return { x: minCol * UNIT, y: minRow * UNIT, w: (maxCol - minCol) * UNIT, h: (maxRow - minRow) * UNIT };
  }

  /* ============================================================
   * 6.8 v1→v2 のparams移行（006_ツールの規格 §1 RESTORE-01の契約。paramsだけを扱う純関数。
   *    封筒全体の版チェックはツール側=index.htmlのRESTORE_CONTRACT.migrateが行う）
   * ============================================================ */
  function migrateParamsV1toV2(params) {
    return Object.assign({}, params, {
      round: 'none', roundR: UNIT / 2,
      exportMode: 'fill', sw: 0.5, trim: false, trimMargin: 0
    });
  }
  // v2→v3（仕様v2 段B）: 候補（variants）と文字下敷き（underlay）を追加。両方とも既定は「無し」
  function migrateParamsV2toV3(params) {
    return Object.assign({}, params, { variants: [], underlay: null });
  }

  /* ============================================================
   * 8. 選択の変形（仕様v2 段B「選択」）— 矩形の中の要素を移動・複製・回転・反転する純関数。
   *    三角の向き・四分円/凹の角の写像は §5 のミラー写像テーブルをそのまま再利用する
   *    （flipLR=MIRROR_X系、flipUD=MIRROR_Y系、rot90=ROT90系。moveは向きを変えない）。
   * ============================================================ */
  var IDENT_DIR = { up: 'up', right: 'right', down: 'down', left: 'left' };
  var IDENT_CORNER = { tl: 'tl', tr: 'tr', br: 'br', bl: 'bl' };

  // rect内（矩形の左上c0,r0〜右下c1,r1、両端含む）にある要素だけを取り出す
  function extractCells(grid, rect) {
    var items = [];
    for (var c = rect.c0; c <= rect.c1; c++) {
      for (var r = rect.r0; r <= rect.r1; r++) {
        var cell = getCell(grid, c, r);
        if (cell) items.push({ col: c, row: r, cell: cell });
      }
    }
    return items;
  }
  function remapCellOrientation(cell, dirMap, cornerMap) {
    if (!cell) return cell;
    if (cell.mode === 'tri') {
      var nt = emptyTris();
      TRI_DIRS.forEach(function (d) { nt[dirMap[d]] = cell.tris[d]; });
      return { mode: 'tri', tris: nt };
    }
    if (cell.mode === 'quarter') {
      return { mode: 'quarter', shape: cell.shape, corner: cornerMap[cell.corner], color: cell.color };
    }
    return cell;
  }
  // items: extractCellsが返す配列。rect: 対象の矩形（変形前の基準）。
  // op: {type:'move',dx,dy} | {type:'rot90'} | {type:'flipLR'} | {type:'flipUD'}
  // 戻り値: { items: 変形後の[{col,row,cell}], rect: 変形後の矩形（moveは平行移動・rot90は幅高さが入れ替わる・
  //          flipは同じ矩形のまま） }。格子外への破棄は呼び出し側（applyTransform）が行う。
  function transformCells(items, rect, op) {
    var W = rect.c1 - rect.c0 + 1, H = rect.r1 - rect.r0 + 1;
    if (op.type === 'move') {
      var dx = op.dx || 0, dy = op.dy || 0;
      var moved = items.map(function (it) { return { col: it.col + dx, row: it.row + dy, cell: it.cell }; });
      return { items: moved, rect: { c0: rect.c0 + dx, r0: rect.r0 + dy, c1: rect.c1 + dx, r1: rect.r1 + dy } };
    }
    var dirMap = IDENT_DIR, cornerMap = IDENT_CORNER;
    if (op.type === 'rot90') { dirMap = ROT90_DIR; cornerMap = ROT90_CORNER; }
    else if (op.type === 'flipLR') { dirMap = MIRROR_X_DIR; cornerMap = MIRROR_X_CORNER; }
    else if (op.type === 'flipUD') { dirMap = MIRROR_Y_DIR; cornerMap = MIRROR_Y_CORNER; }
    var out = items.map(function (it) {
      var lc = it.col - rect.c0, lr = it.row - rect.r0; // 矩形内のローカル座標
      var nlc = lc, nlr = lr;
      if (op.type === 'rot90') { nlc = (H - 1) - lr; nlr = lc; } // 矩形の左上を基準にCW90°（applyMirrorOnceのrot90と同じ式）
      else if (op.type === 'flipLR') { nlc = (W - 1) - lc; }
      else if (op.type === 'flipUD') { nlr = (H - 1) - lr; }
      return { col: rect.c0 + nlc, row: rect.r0 + nlr, cell: remapCellOrientation(it.cell, dirMap, cornerMap) };
    });
    var newRect = (op.type === 'rot90')
      ? { c0: rect.c0, r0: rect.r0, c1: rect.c0 + H - 1, r1: rect.r0 + W - 1 }
      : { c0: rect.c0, r0: rect.r0, c1: rect.c1, r1: rect.r1 };
    return { items: out, rect: newRect };
  }
  // 仕様v6「大きな円弧」選択・変形: ブロックが矩形に完全に入るarcだけを対象にする
  function arcFullyInRect(arc, rect) {
    var b = arcBlock(arc);
    return b.c0 >= rect.c0 && b.r0 >= rect.r0 && b.c1 <= rect.c1 && b.r1 <= rect.r1;
  }
  function extractArcsInRect(grid, rect) {
    var items = [];
    if (grid.arcs) grid.arcs.forEach(function (arc, id) {
      if (arcFullyInRect(arc, rect)) items.push({ id: id, arc: arc });
    });
    return items;
  }
  // rectは変形前の基準（transformCellsと同じ規約）。moveはgx,gyを平行移動。
  // flipLR/flipUD/rot90はquadを既存のミラー/回転の角対応表で写し、gx,gyはブロックの写像から
  // 再計算する（ブロックをrect内のローカル座標へ直し、transformCellsのrot90/flipLR/flipUDと
  // 同じ式でローカル矩形を写してから、新quadに対応する角からgx,gyを逆算する）
  function arcCornerToGxGy(block, quad, r) {
    if (quad === 'tl') return { gx: block.c0, gy: block.r0 };
    if (quad === 'tr') return { gx: block.c0 + r, gy: block.r0 };
    if (quad === 'br') return { gx: block.c0 + r, gy: block.r0 + r };
    return { gx: block.c0, gy: block.r0 + r }; // bl
  }
  function transformArc(arc, rect, op) {
    if (op.type === 'move') {
      var dx = op.dx || 0, dy = op.dy || 0;
      return Object.assign({}, arc, { gx: arc.gx + dx, gy: arc.gy + dy });
    }
    var quadMap = IDENT_CORNER;
    if (op.type === 'rot90') quadMap = ROT90_CORNER;
    else if (op.type === 'flipLR') quadMap = MIRROR_X_CORNER;
    else if (op.type === 'flipUD') quadMap = MIRROR_Y_CORNER;
    var b = arcBlock(arc);
    var W = rect.c1 - rect.c0 + 1, H = rect.r1 - rect.r0 + 1;
    var lc0 = b.c0 - rect.c0, lr0 = b.r0 - rect.r0, lc1 = b.c1 - rect.c0, lr1 = b.r1 - rect.r0;
    var nlc0 = lc0, nlr0 = lr0, nlc1 = lc1, nlr1 = lr1;
    if (op.type === 'rot90') { nlc0 = (H - 1) - lr1; nlc1 = (H - 1) - lr0; nlr0 = lc0; nlr1 = lc1; }
    else if (op.type === 'flipLR') { nlc0 = (W - 1) - lc1; nlc1 = (W - 1) - lc0; }
    else if (op.type === 'flipUD') { nlr0 = (H - 1) - lr1; nlr1 = (H - 1) - lr0; }
    var newQuad = quadMap[arc.quad];
    var newBlock = { c0: rect.c0 + nlc0, r0: rect.r0 + nlr0, c1: rect.c0 + nlc1, r1: rect.r0 + nlr1 };
    var gxgy = arcCornerToGxGy(newBlock, newQuad, arc.r);
    return Object.assign({}, arc, { gx: gxgy.gx, gy: gxgy.gy, quad: newQuad });
  }
  // グリッドに直接適用する版（移動元の矩形を空にしてから、変形後の要素を書き込む。格子外は捨てる）
  function applyTransform(grid, rect, op) {
    var n = grid.n;
    var items = extractCells(grid, rect);
    var result = transformCells(items, rect, op);
    var arcItems = extractArcsInRect(grid, rect);
    for (var c = rect.c0; c <= rect.c1; c++) for (var r = rect.r0; r <= rect.r1; r++) eraseCell(grid, c, r);
    if (grid.arcs) arcItems.forEach(function (it) { grid.arcs.delete(it.id); });
    result.items.forEach(function (it) {
      if (it.col < 0 || it.row < 0 || it.col >= n || it.row >= n) return; // 格子外にはみ出た分は捨てる
      setCell(grid, it.col, it.row, it.cell);
    });
    if (grid.arcs) arcItems.forEach(function (it) {
      var na = transformArc(it.arc, rect, op);
      var nb = arcBlock(na);
      if (!arcInBoundsBlock(nb, n)) return; // 格子外に出たら捨てる
      grid.arcSeq = (grid.arcSeq || 0) + 1;
      grid.arcs.set('arc-' + grid.arcSeq, na);
    });
    return result.rect;
  }

  /* ============================================================
   * 9. 線ブラシ（仕様v2 段B「線」・2026-09-13 定義修正版）
   *    — 2点から0°/45°/90°に吸着した「太さ1マスの正方形の帯」を返す純関数。
   *    p0,p1は「マス単位」の浮動小数座標（例: ポインタ位置÷UNIT。整数部=マス番地）。
   *    0°/90°: 正方形が横一列/縦一列に並ぶ（辺を共有してつながる＝線に見える）。
   *    45°/135°: 正方形が1マスずつ斜めに並ぶ階段（角だけで接する。仕様書の指定通り）。
   *    塗る要素は常に正方形（マスまるごと＝三角4枚ぶん）。
   *    （旧版は0°/90°を半マス幅の三角の帯にしていたが、隣同士が点でしか接せず
   *    「ひし形の連なり」に見えて線に見えなかったため、正方形の帯に置き換えた）
   * ============================================================ */
  function snapAngle(dx, dy) {
    if (dx === 0 && dy === 0) return null;
    var deg = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
    var snapped = Math.round(deg / 45) * 45;
    var norm = ((snapped % 180) + 180) % 180; // 0/45/90/135
    return norm;
  }
  // プレビュー用: p1を、p0からの距離を保ったまま吸着方向の直線上に載せる
  function snapEndpoint(p0, p1) {
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) return { x: p0.x, y: p0.y };
    var deg = Math.atan2(dy, dx) * 180 / Math.PI;
    var snapped = Math.round(deg / 45) * 45;
    var rad = snapped * Math.PI / 180;
    return { x: p0.x + dist * Math.cos(rad), y: p0.y + dist * Math.sin(rad) };
  }
  // p0,p1のx（または回転後の主軸）の範囲を、それぞれが属するマス番地の範囲に変換する
  function spanToCellRange(a, b) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    var c0 = Math.floor(lo + 1e-9), c1 = Math.floor(hi - 1e-9);
    if (c1 < c0) c1 = c0;
    return { c0: c0, c1: c1 };
  }
  function lineSquaresHV(p0, p1, horizontal) {
    var out = [];
    if (horizontal) {
      var row = Math.floor((p0.y + p1.y) / 2);
      var span = spanToCellRange(p0.x, p1.x);
      for (var c = span.c0; c <= span.c1; c++) out.push({ col: c, row: row });
    } else {
      var col = Math.floor((p0.x + p1.x) / 2);
      var spanY = spanToCellRange(p0.y, p1.y);
      for (var r = spanY.c0; r <= spanY.c1; r++) out.push({ col: col, row: r });
    }
    return out;
  }
  function lineSquaresDiag(p0, p1, mainDiag) {
    var out = [];
    var span = spanToCellRange(p0.x, p1.x);
    if (mainDiag) {
      var k = Math.round(((p0.y - p0.x) + (p1.y - p1.x)) / 2);
      for (var c = span.c0; c <= span.c1; c++) out.push({ col: c, row: c + k });
    } else {
      var k2 = Math.round(((p0.y + p0.x) + (p1.y + p1.x)) / 2);
      for (var cb = span.c0; cb <= span.c1; cb++) out.push({ col: cb, row: k2 - cb });
    }
    return out;
  }
  // 戻り値: { angle: 0|45|90|135, cells: [{col,row}] }（塗る正方形の一覧。0/1点しかない場合は angle:null, cells:[]）
  function lineCells(p0, p1) {
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var angle = snapAngle(dx, dy);
    if (angle == null) return { angle: null, cells: [] };
    var cells;
    if (angle === 0) cells = lineSquaresHV(p0, p1, true);
    else if (angle === 90) cells = lineSquaresHV(p0, p1, false);
    else if (angle === 45) cells = lineSquaresDiag(p0, p1, true);
    else cells = lineSquaresDiag(p0, p1, false);
    return { angle: angle, cells: cells };
  }

  /* ============================================================
   * 10. 塗りつぶし（仕様v2 段B「囲まれた所を塗る」）— 辺を共有してつながる空の三角を塗る。
   *    同じマス内の隣り合う三角（TRI_DIRSの前後）＋隣マスの向かい合う三角の両方をたどる。
   *    四分円/凹モードのマスと格子外は壁として扱う（越えない）。
   * ============================================================ */
  var TRI_NEIGHBOR_CELL = {
    up: { dc: 0, dr: -1, dir: 'down' },
    right: { dc: 1, dr: 0, dir: 'left' },
    down: { dc: 0, dr: 1, dir: 'up' },
    left: { dc: -1, dr: 0, dir: 'right' }
  };
  function isTriEmpty(grid, col, row, dir) {
    if (col < 0 || row < 0 || col >= grid.n || row >= grid.n) return false; // 格子外は壁
    if (arcAt(grid, col, row)) return false; // 大きな円弧(仕様v6)のブロックは壁として扱う
    var cell = getCell(grid, col, row);
    if (!cell) return true; // 何も置かれていないマスは4枚とも空
    if (cell.mode !== 'tri') return false; // 四分円/凹モードのマスは壁
    return cell.tris[dir] == null;
  }
  // 開始点が既に塗られている・四分円モードなら何もしない。返り値は塗った三角の枚数
  function floodFill(grid, startCol, startRow, startDir, color) {
    if (!isTriEmpty(grid, startCol, startRow, startDir)) return 0;
    var visited = {};
    var stack = [{ col: startCol, row: startRow, dir: startDir }];
    var filled = [];
    while (stack.length) {
      var cur = stack.pop();
      var key = cur.col + ',' + cur.row + ',' + cur.dir;
      if (visited[key]) continue;
      visited[key] = true;
      if (!isTriEmpty(grid, cur.col, cur.row, cur.dir)) continue;
      filled.push(cur);
      var i = TRI_DIRS.indexOf(cur.dir);
      var prevDir = TRI_DIRS[(i + 3) % 4], nextDir = TRI_DIRS[(i + 1) % 4];
      stack.push({ col: cur.col, row: cur.row, dir: prevDir });
      stack.push({ col: cur.col, row: cur.row, dir: nextDir });
      var nb = TRI_NEIGHBOR_CELL[cur.dir];
      stack.push({ col: cur.col + nb.dc, row: cur.row + nb.dr, dir: nb.dir });
    }
    filled.forEach(function (t) { paintTriangle(grid, t.col, t.row, t.dir, color); });
    return filled.length;
  }

  /* ============================================================
   * 11. 60°正三角格子（仕様v2 段C「60°の格子」・2026-09-14 差し戻し対応版）
   *    版面は長方形（幅 N・UNIT × 高さ M・TRI60_H。M は tri60Rows(N) で決める偶数）。
   *    横線は2種類が交互に並ぶ「brick wall」構成: 偶数番の横線(L)は整数点0..N(N+1個)、
   *    奇数番の横線は半整数点0.5..N-0.5(N個)。行row(0..M-1)は横線rowとrow+1の間にあり、
   *    その行の「全幅を占める向き」(majority)がrowの偶奇で down/up 入れ替わり、残りは
   *    内側だけの少数派(minority、全幅よりマスが1つ少ない)になる。この2種類が交互に
   *    並ぶ標準的な三角形ストリップ分割（帯を作る辺と内側の辺で辺の向き(shoelace符号)を
   *    そろえてある。詳細は 000_README.md 差し戻しメモ参照）。
   *    隣接三角は総当たり探索(neighborTri60)で辺の一致を見て求める（手計算の添字式より
   *    確実。近傍 dr,dc∈[-1,1] の範囲で必ず見つかることをtest.mjsで検証）。
   *    融合（辺の相殺→ループ化→共線統合）は実座標のまま行う（正方形格子と同じ手順。
   *    tri60Corners が返す実座標は同じ整数入力に対して常にビット単位で同じ値になるため
   *    辺の一致判定に浮動小数の誤差は出ない）。
   * ============================================================ */
  var SQRT3 = Math.sqrt(3);
  var TRI60_H = UNIT * SQRT3 / 2;

  // 版面の行数M（幅Nに対して高さがほぼ正方形になる偶数値）
  function tri60Rows(n) {
    var m = Math.round(n * 2 / SQRT3);
    if (m % 2 !== 0) m += 1;
    return Math.max(2, m);
  }
  // grid.orient: 「奥の頂点」で置いた三角だけを覚える追加のMap（ゴールとロードマップv5 M3
  // 「不可能図形の補助」。キーが無い=手前(front)、trueがある=奥(back)）。cellsとは別に持つのは、
  // 色の数値(1〜4)自体は手前/奥で同じ(CUBE_FACE_COLOR/CUBE_FACE_COLOR_BACKとも1/2/3)なので
  // 既存のcells形式・validateCells60Object・色の判定(effectiveColorOf等)を一切変えずに済むため。
  // 明暗の規則(shadeFaceIdOf)だけがこれを読み、奥の面を別グループ(4〜6)として扱う。
  // 委任パケットpacket-appear.md 段A「描いた順（step）の記録」: grid.step は
  // 塗った三角のキー→塗った順番(0始まり)。grid.stepCur が「今のストローク/操作の番号」
  // （beginStep60で発行）・grid.stepNext が次に発行するstepの番号。
  // grid.log: 委任パケット「描いた履歴」段A。手ごとの配列 log[step] = [[key, color|null], ...]
  // （その手で書いた三角とその時の色。同じ手で同じ三角を2回書いたら後の値で置き換える）。
  // これにより「手kの絵」は「k以下で最後に書かれた色」で組み立てられ、後から上書きされて
  // 消えた面も再生で一度は見えるようになる（cells/stepだけでは最終状態しか持てないため）。
  function createGrid60(n) { return { n: n, m: tri60Rows(n), cells: new Map(), orient: new Map(), step: new Map(), stepNext: 0, stepCur: -1, log: [] }; }
  function tri60Key(col, row, o) { return col + ',' + row + ',' + o; }
  function getTri60(grid, col, row, o) { return grid.cells.get(tri60Key(col, row, o)) || null; }
  // 呼び出し側が「今から1つの操作（立方体1個・1ストローク・1回のランダム充填等）を始める」
  // 直前に呼ぶ。以後のsetTri60はこのstep番号を記録する。戻り値は発行したstep番号。
  function beginStep60(grid) {
    if (grid.stepNext == null) grid.stepNext = 0;
    grid.stepCur = grid.stepNext++;
    return grid.stepCur;
  }
  // colorを書くたびorientは既定(front=キー無し)に戻す。「奥」を残したい呼び出し側
  // (paintCube60/paintFace60の back=true 時)は、この直後にsetTri60Orientを呼んで明示的に立てる。
  function setTri60(grid, col, row, o, color) {
    var k = tri60Key(col, row, o);
    if (color == null) {
      grid.cells.delete(k);
      if (grid.step) grid.step.delete(k);
    } else {
      grid.cells.set(k, color);
      if (!grid.step) grid.step = new Map();
      // 保険: beginStep60を呼ばずにsetTri60した経路（網羅漏れ）でもstepが未定義のままにならないようにする。
      // 一度発行したstepCurはbeginStep60が呼ばれるまでそのまま使い回す。
      if (grid.stepCur == null || grid.stepCur < 0) {
        if (grid.stepNext == null) grid.stepNext = 0;
        grid.stepCur = grid.stepNext++;
      }
      grid.step.set(k, grid.stepCur);
    }
    if (grid.orient) grid.orient.delete(k);
    // 委任パケット「描いた履歴」段A: 上のstepCur確定ロジック（保険含む）の後、必ずこの手の
    // 履歴に記録する（erase(color==null)側もstepCurが未確定なら同じ保険でここで確定させる）。
    if (grid.stepCur == null || grid.stepCur < 0) {
      if (grid.stepNext == null) grid.stepNext = 0;
      grid.stepCur = grid.stepNext++;
    }
    if (!grid.log) grid.log = [];
    if (!grid.log[grid.stepCur]) grid.log[grid.stepCur] = [];
    var logStep = grid.log[grid.stepCur];
    var logVal = color == null ? null : color;
    var replaced = false;
    for (var li = 0; li < logStep.length; li++) {
      if (logStep[li][0] === k) { logStep[li][1] = logVal; replaced = true; break; }
    }
    if (!replaced) logStep.push([k, logVal]);
  }
  function setTri60Orient(grid, col, row, o, back) {
    if (!grid.orient) grid.orient = new Map();
    var k = tri60Key(col, row, o);
    if (back) grid.orient.set(k, true); else grid.orient.delete(k);
  }
  function getTri60Orient(grid, col, row, o) {
    return !!(grid.orient && grid.orient.get(tri60Key(col, row, o)));
  }
  function cellsToObject60(grid) {
    var o = {};
    grid.cells.forEach(function (color, key) { o[key] = color; });
    return o;
  }
  // 奥(back)の三角だけをkey→trueで書き出す（前面の三角は含めない＝常に既定値に戻れる）
  function cellsToOrientObject60(grid) {
    var o = {};
    if (grid.orient) grid.orient.forEach(function (v, key) { if (v) o[key] = true; });
    return o;
  }
  // 描いた順（委任パケットpacket-appear.md 段A）を保存できる形にする。
  // {next: 次に発行するstep番号, of: {key: そのマスのstep番号}}（cellsに存在するキーだけ）
  function stepsToObject60(grid) {
    var of = {};
    if (grid.step) grid.step.forEach(function (v, key) { if (grid.cells.has(key)) of[key] = v; });
    return { next: grid.stepNext || 0, of: of };
  }
  // grid.logをJSON化できる配列にする（委任パケット「描いた履歴」段A3）。undefinedの手は[]にする。
  function logToArray60(grid) {
    var out = [];
    if (!grid.log) return out;
    for (var i = 0; i < grid.log.length; i++) {
      var step = grid.log[i];
      out.push(step ? step.map(function (pair) { return [pair[0], pair[1]]; }) : []);
    }
    return out;
  }
  // stepsObj省略時（旧保存の後方互換）は、既存cellsの全キーにstep0を与えstepNext=1にする。
  // logArr（第5引数・委任パケット「描いた履歴」段A3）: あればそのまま複元。
  // 無い旧保存は、既存cells(+step)からlog[step].push([key,color])を組み立てて補う（今と同じ見え方）。
  function gridFromCells60(n, obj, orientObj, stepsObj, logArr) {
    var g = createGrid60(n);
    if (obj) for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) g.cells.set(k, obj[k]);
    if (orientObj) for (var k2 in orientObj) if (Object.prototype.hasOwnProperty.call(orientObj, k2) && orientObj[k2]) g.orient.set(k2, true);
    if (stepsObj) {
      g.stepNext = stepsObj.next || 0;
      g.stepCur = -1;
      if (stepsObj.of) for (var k3 in stepsObj.of) if (Object.prototype.hasOwnProperty.call(stepsObj.of, k3)) g.step.set(k3, stepsObj.of[k3]);
    } else {
      g.cells.forEach(function (color, key) { g.step.set(key, 0); });
      g.stepNext = 1;
      g.stepCur = -1;
    }
    if (Array.isArray(logArr)) {
      g.log = logArr.map(function (step) {
        return Array.isArray(step) ? step.map(function (pair) { return [pair[0], pair[1]]; }) : [];
      });
    } else {
      g.log = [];
      g.cells.forEach(function (color, key) {
        var st = g.step.has(key) ? g.step.get(key) : 0;
        if (!g.log[st]) g.log[st] = [];
        g.log[st].push([key, color]);
      });
    }
    return g;
  }

  // 横線L(整数)のj番目の点の実座標。Lが偶数=整数点(0..N)・奇数=半整数点(0.5..N-0.5)
  function tri60Line(L, j) {
    return (L % 2 === 0) ? { x: j * UNIT, y: L * TRI60_H } : { x: (j + 0.5) * UNIT, y: L * TRI60_H };
  }
  // その行で全幅(N枚)を占める向き（row偶数=down、row奇数=up）。もう一方は内側だけ(N-1枚)
  function tri60Majority(row) { return row % 2 === 0 ? 'down' : 'up'; }
  function tri60IsMajority(row, o) { return tri60Majority(row) === o; }
  // 三角(col,row,o)がとり得るcolの範囲は0..maxCol（全幅=N-1・内側=N-2）
  function tri60RowMaxCol(n, row, o) { return tri60IsMajority(row, o) ? (n - 1) : (n - 2); }
  function isTri60InBounds(grid, col, row, o) {
    if (row < 0 || row >= grid.m) return false;
    return col >= 0 && col <= tri60RowMaxCol(grid.n, row, o);
  }
  // 三角の3頂点を実座標で返す（辺の向き(shoelace符号)は down/up・行の偶奇によらず統一）
  function tri60Corners(col, row, o) {
    if (row % 2 === 0) {
      if (o === 'down') return [tri60Line(row, col), tri60Line(row, col + 1), tri60Line(row + 1, col)];
      return [tri60Line(row + 1, col + 1), tri60Line(row + 1, col), tri60Line(row, col + 1)];
    }
    if (o === 'up') return [tri60Line(row + 1, col + 1), tri60Line(row + 1, col), tri60Line(row, col)];
    return [tri60Line(row, col + 1), tri60Line(row + 1, col + 1), tri60Line(row, col)];
  }
  function pointInTriangle60(p, a, b, c) {
    var d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    var d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
    var d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
    var hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0), hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }
  // 実座標(x,y)がどの三角に入るかを、近傍を総当たりして探す（境界の左右端にはごく細い未収容の
  // すき間が生じ得る＝等辺三角形だけで長方形をぴったり敷き詰めることはできないため。その範囲を
  // クリックしても何も起きない。000_README.md差し戻しメモに明記）
  function tri60FromPoint(grid, x, y) {
    var row0 = Math.floor(y / TRI60_H);
    if (row0 < 0) row0 = 0;
    if (row0 >= grid.m) row0 = grid.m - 1;
    var kGuess = Math.floor(x / UNIT);
    for (var rr = row0; rr >= Math.max(0, row0 - 1); rr--) {
      for (var dc = -2; dc <= 2; dc++) {
        var c = kGuess + dc;
        for (var oi = 0; oi < 2; oi++) {
          var o = oi === 0 ? 'up' : 'down';
          if (!isTri60InBounds(grid, c, rr, o)) continue;
          var v = tri60Corners(c, rr, o);
          if (pointInTriangle60({ x: x, y: y }, v[0], v[1], v[2])) return { col: c, row: rr, o: o };
        }
      }
    }
    return null;
  }
  // 実座標(x,y)に最も近い「格子点」(横線Lのj番目)を返す（六角形ブラシの中心決めに使う）
  function tri60NearestGridPoint(grid, x, y) {
    var rowGuess = Math.round(y / TRI60_H);
    var best = null, bestD = Infinity;
    for (var L = Math.max(0, rowGuess - 1); L <= Math.min(grid.m, rowGuess + 1); L++) {
      var isInt = (L % 2 === 0);
      var jGuess = isInt ? Math.round(x / UNIT) : Math.round(x / UNIT - 0.5);
      var jMax = isInt ? grid.n : grid.n - 1;
      for (var dj = -1; dj <= 1; dj++) {
        var j = jGuess + dj;
        if (j < 0 || j > jMax) continue;
        var p = tri60Line(L, j);
        var d = Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
        if (d < bestD) { bestD = d; best = { L: L, j: j, x: p.x, y: p.y }; }
      }
    }
    return best;
  }
  function pointSegDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy));
  }
  function ptKeyRound(p) { return Math.round(p.x * 1000) / 1000 + ',' + Math.round(p.y * 1000) / 1000; }
  // 三角(col,row,o)の辺idx(0-2)を共有する隣接三角を、近傍を総当たりして探す（見つからなければ
  // 版面の外周＝相手なし）。tri60Cornersが返す辺の並び順に対応
  function neighborTri60(grid, col, row, o, edgeIdx) {
    var v = tri60Corners(col, row, o);
    var edges = [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]];
    var e = edges[edgeIdx];
    var wantA = ptKeyRound(e[1]), wantB = ptKeyRound(e[0]); // 相手は逆向き(e[1]→e[0])のはず
    for (var dr = -1; dr <= 1; dr++) {
      var r2 = row + dr;
      if (r2 < 0 || r2 >= grid.m) continue;
      for (var dc = -1; dc <= 1; dc++) {
        var c2 = col + dc;
        for (var oi = 0; oi < 2; oi++) {
          var o2 = oi === 0 ? 'up' : 'down';
          if (r2 === row && c2 === col && o2 === o) continue;
          if (!isTri60InBounds(grid, c2, r2, o2)) continue;
          var v2 = tri60Corners(c2, r2, o2);
          var e2 = [[v2[0], v2[1]], [v2[1], v2[2]], [v2[2], v2[0]]];
          for (var k = 0; k < 3; k++) {
            if (ptKeyRound(e2[k][0]) === wantA && ptKeyRound(e2[k][1]) === wantB) return { col: c2, row: r2, o: o2 };
          }
        }
      }
    }
    return null;
  }
  function neighbors60(grid, col, row, o) {
    var out = [];
    for (var i = 0; i < 3; i++) {
      var nb = neighborTri60(grid, col, row, o, i);
      if (nb) out.push(nb);
    }
    return out;
  }
  // ひし形ブラシ: 三角(col,row,o)と、カーソルに最も近い辺を共有する隣接三角の2枚（相手が
  // 版面の外周で無ければ1枚だけになる）
  function nearestEdgeIndex60(point, col, row, o) {
    var v = tri60Corners(col, row, o);
    var edges = [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]];
    var best = 0, bd = Infinity;
    edges.forEach(function (e, i) { var d = pointSegDist(point, e[0], e[1]); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function rhombusCells60(grid, point, col, row, o) {
    var idx = nearestEdgeIndex60(point, col, row, o);
    var out = [{ col: col, row: row, o: o }];
    var nb = neighborTri60(grid, col, row, o, idx);
    if (nb) out.push(nb);
    return out;
  }
  // 六角形ブラシ: 格子点(gp={L,j,x,y})を頂点に持つ三角を総当たりで集める（通常6枚。
  // 版面の端では6枚に満たないこともある）
  function hexagonCells60(grid, gp) {
    var out = [];
    for (var row = gp.L - 1; row <= gp.L; row++) {
      if (row < 0 || row >= grid.m) continue;
      for (var dc = -2; dc <= 2; dc++) {
        var col = gp.j + dc;
        ['up', 'down'].forEach(function (o) {
          if (!isTri60InBounds(grid, col, row, o)) return;
          var v = tri60Corners(col, row, o);
          var hit = v.some(function (vp) { return Math.abs(vp.x - gp.x) < 1e-6 && Math.abs(vp.y - gp.y) < 1e-6; });
          if (hit) out.push({ col: col, row: row, o: o });
        });
      }
    }
    return out;
  }

  /* ---- 融合（色ごとにpath化。core.jsの汎用パイプライン(cancelEdges/buildLoops/
     mergeCollinear/roundLoopCorners/dropRedundantClose/loopToPathD)をそのまま実座標で使う） ---- */
  // colorFnは square版と同じ契約（仕様v4 段E）
  function collectEdgesForColor60(grid, color, colorFn) {
    var edges = [];
    grid.cells.forEach(function (manual, key) {
      if (manual == null) return;
      var parts = key.split(','), col = +parts[0], row = +parts[1], o = parts[2];
      var eff = colorFn ? colorFn({ kind: 'tri60', col: col, row: row, o: o }, manual) : manual;
      if (eff !== color) return;
      var v = tri60Corners(col, row, o);
      edges.push(edge(v[0], v[1]), edge(v[1], v[2]), edge(v[2], v[0]));
    });
    return edges;
  }
  // opts.round = { mode, radius }（省略時は角丸なし）。座標は常に小数2桁で書き出す（√3を含むため）
  function buildColorPathD60(grid, color, opts) {
    var kept = cancelEdges(collectEdgesForColor60(grid, color, opts && opts.colorFn));
    if (!kept.length) return null;
    var loops = buildLoops(kept).map(mergeCollinear);
    var round = opts && opts.round;
    if (round && round.mode && round.mode !== 'none') {
      loops = loops.map(function (loop) { return roundLoopCorners(loop, round.mode, round.radius); });
    }
    loops = loops.map(dropRedundantClose).filter(function (l) { return l.length > 0; });
    if (!loops.length) return null;
    return loops.map(function (loop) { return loopToPathD(loop, 2); }).join(' ');
  }
  function buildAllPaths60(grid, colorCount, opts) {
    var out = [];
    for (var c = 1; c <= (colorCount || 4); c++) {
      var d = buildColorPathD60(grid, c, opts);
      if (d) out.push({ color: c, d: d });
    }
    return out;
  }
  // 書き出しの形「要素ごとに分ける」（正三角格子版）: grid.cellsの1キー(=三角1枚)が1要素・1path
  function buildExplodedPaths60(grid, opts) {
    var out = [];
    var colorFn = opts && opts.colorFn;
    var round = opts && opts.round;
    grid.cells.forEach(function (manual, key) {
      if (manual == null) return;
      var parts = key.split(','), col = +parts[0], row = +parts[1], o = parts[2];
      var eff = colorFn ? colorFn({ kind: 'tri60', col: col, row: row, o: o }, manual) : manual;
      var v = tri60Corners(col, row, o);
      var edges = [edge(v[0], v[1]), edge(v[1], v[2]), edge(v[2], v[0])];
      var d = finishExplodedPathD(edges, round, 2);
      if (d) out.push({ color: eff, d: d });
    });
    return out;
  }

  /* ---- ミラー（なし/左右/上下/両方。4回回転は正三角格子では不可＝提供しない）。
     いずれも実座標で x=N·UNIT/2（左右）・y=M·TRI60_H/2（上下）を軸にした厳密な鏡像
     （1e-9の精度でtest.mjsが確認）。
     左右: 全幅(majority)三角はcol'=N-1-col、内側(minority)三角はcol'=N-2-col、行とoは
     不変（水平反転では三角の頂点が上/下どちら向きかは変わらないため）。
     上下: row'=M-1-row、colは不変、oはup/downが入れ替わる（Mが偶数なのでmajority/minority
     の関係が保たれる）。 ---- */
  function mirrorLR60(grid, t) {
    var col2 = tri60IsMajority(t.row, t.o) ? (grid.n - 1 - t.col) : (grid.n - 2 - t.col);
    return { col: col2, row: t.row, o: t.o };
  }
  function mirrorUD60(grid, t) {
    return { col: t.col, row: grid.m - 1 - t.row, o: t.o === 'up' ? 'down' : 'up' };
  }
  function mirrorPositions60(grid, mode, t) {
    var base = { col: t.col, row: t.row, o: t.o };
    var list = [base];
    if (mode === 'lr') list.push(mirrorLR60(grid, base));
    else if (mode === 'ud') list.push(mirrorUD60(grid, base));
    else if (mode === 'lr-ud') {
      var lr = mirrorLR60(grid, base), ud = mirrorUD60(grid, base), both = mirrorUD60(grid, lr);
      list.push(lr, ud, both);
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      var k = p.col + ',' + p.row + ',' + p.o;
      if (!seen[k]) { seen[k] = 1; out.push(p); }
    });
    return out;
  }

  /* ---- 塗り／消しの入口（ミラーを適用してから書き込む） ---- */
  function paintTri60(grid, opts) {
    var positions = mirrorPositions60(grid, opts.mirror || 'none', { col: opts.col, row: opts.row, o: opts.o });
    positions.forEach(function (p) {
      if (!isTri60InBounds(grid, p.col, p.row, p.o)) return;
      setTri60(grid, p.col, p.row, p.o, opts.erase ? null : opts.color);
    });
    return grid;
  }
  // cells: [{col,row,o}]（ひし形=1〜2枚・六角形=最大6枚・線=帯の各三角1枚ずつ）を同じ設定でまとめて塗る
  function paintTri60Group(grid, cells, opts) {
    cells.forEach(function (c) {
      paintTri60(grid, { col: c.col, row: c.row, o: c.o, color: opts.color, erase: opts.erase, mirror: opts.mirror });
    });
    return grid;
  }

  /* ---- 選択の変形（移動・左右反転・上下反転。90°回転は正三角格子では不可）。
     反転は選択矩形の幅W・高さHを版面のN・Mの代わりに使う、同じ厳密反射の式。 ---- */
  function extractCells60(grid, rect) {
    var items = [];
    for (var c = rect.c0; c <= rect.c1; c++) for (var r = rect.r0; r <= rect.r1; r++) {
      ['down', 'up'].forEach(function (o) {
        var color = getTri60(grid, c, r, o);
        if (color != null) items.push({ col: c, row: r, o: o, color: color });
      });
    }
    return items;
  }
  function transformCells60(items, rect, op) {
    var W = rect.c1 - rect.c0 + 1, H = rect.r1 - rect.r0 + 1;
    if (op.type === 'move') {
      var dx = op.dx || 0, dy = op.dy || 0;
      var moved = items.map(function (it) { return { col: it.col + dx, row: it.row + dy, o: it.o, color: it.color }; });
      return { items: moved, rect: { c0: rect.c0 + dx, r0: rect.r0 + dy, c1: rect.c1 + dx, r1: rect.r1 + dy } };
    }
    var out = items.map(function (it) {
      var lc = it.col - rect.c0, lr = it.row - rect.r0, no = it.o;
      if (op.type === 'flipLR') {
        lc = tri60IsMajority(it.row, it.o) ? (W - 1 - lc) : (W - 2 - lc);
      } else if (op.type === 'flipUD') {
        lr = (H - 1) - lr;
        no = it.o === 'up' ? 'down' : 'up';
      }
      return { col: rect.c0 + lc, row: rect.r0 + lr, o: no, color: it.color };
    });
    return { items: out, rect: rect };
  }
  function applyTransform60(grid, rect, op) {
    var items = extractCells60(grid, rect);
    var result = transformCells60(items, rect, op);
    for (var c = rect.c0; c <= rect.c1; c++) for (var r = rect.r0; r <= rect.r1; r++) { setTri60(grid, c, r, 'up', null); setTri60(grid, c, r, 'down', null); }
    result.items.forEach(function (it) {
      if (!isTri60InBounds(grid, it.col, it.row, it.o)) return;
      setTri60(grid, it.col, it.row, it.o, it.color);
    });
    return result.rect;
  }

  /* ---- 線ブラシ（正三角格子: 辺方向0°/60°/120°の3方向は対称・どれも辺を共有して連続
     する三角の帯(上下交互)になる。差し戻しC対応: 実際の直線(レイ)を細かくサンプリングして
     通過する三角を順番に集める方式にした（どの方向でも必ず辺で連続する。手計算の添字式で
     ジグザグの階段になっていた旧版を置き換え）。 ---- */
  function snapAngle60(dx, dy) {
    if (dx === 0 && dy === 0) return null;
    var deg = Math.atan2(dy, dx) * 180 / Math.PI;
    var norm = ((deg % 360) + 360) % 360;
    var snapped = Math.round(norm / 60) * 60;
    return snapped % 180; // 180/240/300 は 0/60/120 に畳む
  }
  function snapEndpoint60(p0, p1) {
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) return { x: p0.x, y: p0.y };
    var deg = Math.atan2(dy, dx) * 180 / Math.PI;
    var snapped = Math.round(deg / 60) * 60;
    var rad = snapped * Math.PI / 180;
    return { x: p0.x + dist * Math.cos(rad), y: p0.y + dist * Math.sin(rad) };
  }
  // p0,p1は実座標{x,y}。戻り値: { angle:0|60|120, cells:[{col,row,o}] }（帯を構成する三角の並び。
  // 隣り合う三角は必ず辺を共有する＝塗ると1つのループに融合する）
  function lineCells60(grid, p0, p1) {
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var angle = snapAngle60(dx, dy);
    if (angle == null) return { angle: null, cells: [] };
    var dist = Math.sqrt(dx * dx + dy * dy);
    var rad = angle * Math.PI / 180;
    var ex = p0.x + dist * Math.cos(rad), ey = p0.y + dist * Math.sin(rad);
    var steps = Math.max(1, Math.ceil(dist / (UNIT / 8)));
    var seen = {}, cells = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var px = p0.x + (ex - p0.x) * t, py = p0.y + (ey - p0.y) * t;
      var tri = tri60FromPoint(grid, px, py);
      if (!tri) continue;
      var k = tri.col + ',' + tri.row + ',' + tri.o;
      if (!seen[k]) { seen[k] = 1; cells.push({ col: tri.col, row: tri.row, o: tri.o }); }
    }
    return { angle: angle, cells: cells };
  }

  // 立方体の「線置き」（2026-09-17 課題感「なぞりミスすることが多々ある」の対策）: p0→p1（実座標。
  // p1はsnapEndpoint60で6方向に吸着済み）の直線上にある格子点（立方体の中心＝nearestVertex60が返す
  // {L,j}）を順番に集める。lineCells60（三角の帯）と同じ細かいサンプリング(UNIT/8刻み)で直線上を
  // なぞり、通過する格子点を重複なく並べる（隣接1マス刻みで並ぶ＝立方体を並べる単位そのもの）。
  // p0とp1が同じ点なら格子点1つだけを返す。戻り値: [{L,j}, ...]
  function vertexLineCells60(grid, p0, p1) {
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) {
      var only = tri60NearestGridPoint(grid, p0.x, p0.y);
      return only ? [{ L: only.L, j: only.j }] : [];
    }
    var steps = Math.max(1, Math.ceil(dist / (UNIT / 8)));
    var seen = {}, verts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var px = p0.x + dx * t, py = p0.y + dy * t;
      var gp = tri60NearestGridPoint(grid, px, py);
      if (!gp) continue;
      var k = gp.L + ',' + gp.j;
      if (!seen[k]) { seen[k] = 1; verts.push({ L: gp.L, j: gp.j }); }
    }
    return verts;
  }

  /* ---- 塗りつぶし（辺を共有してつながる空の三角を塗る。版面の外周は壁） ---- */
  function isTri60Empty(grid, col, row, o) {
    if (!isTri60InBounds(grid, col, row, o)) return false;
    return getTri60(grid, col, row, o) == null;
  }
  function floodFill60(grid, startCol, startRow, startO, color) {
    if (!isTri60Empty(grid, startCol, startRow, startO)) return 0;
    var visited = {};
    var stack = [{ col: startCol, row: startRow, o: startO }];
    var filled = [];
    while (stack.length) {
      var cur = stack.pop();
      var key = cur.col + ',' + cur.row + ',' + cur.o;
      if (visited[key]) continue;
      visited[key] = true;
      if (!isTri60Empty(grid, cur.col, cur.row, cur.o)) continue;
      filled.push(cur);
      neighbors60(grid, cur.col, cur.row, cur.o).forEach(function (nb) { stack.push(nb); });
    }
    filled.forEach(function (t) { setTri60(grid, t.col, t.row, t.o, color); });
    return filled.length;
  }

  /* ---- v3→v4のparams移行（仕様v2 段C「60°の格子」）。lattice既定=square・cells60既定={} ---- */
  function migrateParamsV3toV4(params) {
    return Object.assign({}, params, { lattice: 'square', cells60: {} });
  }
  function validateCells60Object(cells) {
    if (cells == null) return true;
    if (typeof cells !== 'object' || Array.isArray(cells)) return '三角格子のマスの内容が不正です';
    for (var key in cells) {
      if (!Object.prototype.hasOwnProperty.call(cells, key)) continue;
      if (!/^\d+,\d+,(up|down)$/.test(key)) return '三角格子のマスの位置が不正です';
      var v = cells[key];
      if (!Number.isInteger(v) || v < 1 || v > 4) return '三角格子の色番号が不正です';
    }
    return true;
  }
  // ゴールとロードマップv5 M3「不可能図形の補助」。cellsOrient60は任意項目(無ければ全部front)。
  // 値はtrue以外を許さない（false/0等をわざわざ書く意味が無いため）
  function validateCellsOrient60Object(orient) {
    if (orient == null) return true;
    if (typeof orient !== 'object' || Array.isArray(orient)) return '三角格子の奥/手前の指定が不正です';
    for (var key in orient) {
      if (!Object.prototype.hasOwnProperty.call(orient, key)) continue;
      if (!/^\d+,\d+,(up|down)$/.test(key)) return '三角格子の奥/手前の位置が不正です';
      if (orient[key] !== true) return '三角格子の奥/手前の値が不正です';
    }
    return true;
  }
  // 委任パケットpacket-appear.md 段A「描いた順（step）の記録」。cellsStep60は任意項目
  // （無ければ旧保存＝gridFromCells60が全キーstep0で後方互換を作る）
  function validateCellsStep60Object(steps) {
    if (steps == null) return true;
    if (typeof steps !== 'object' || Array.isArray(steps)) return '三角格子の手順の指定が不正です';
    if (!Number.isInteger(steps.next) || steps.next < 0) return '三角格子の手順の合計が不正です';
    if (!steps.of || typeof steps.of !== 'object' || Array.isArray(steps.of)) return '三角格子の手順の内容が不正です';
    for (var key in steps.of) {
      if (!Object.prototype.hasOwnProperty.call(steps.of, key)) continue;
      if (!/^\d+,\d+,(up|down)$/.test(key)) return '三角格子の手順の位置が不正です';
      var v = steps.of[key];
      if (!Number.isInteger(v) || v < 0) return '三角格子の手順の値が不正です';
    }
    return true;
  }
  // 委任パケット「描いた履歴」段A4。cellsLog60は任意項目（無ければ旧保存＝gridFromCells60が
  // cells+stepから組み立てて補う）。null OK。
  function validateCellsLog60Array(arr) {
    if (arr == null) return true;
    if (!Array.isArray(arr)) return '三角格子の履歴が不正です';
    for (var i = 0; i < arr.length; i++) {
      var step = arr[i];
      if (!Array.isArray(step)) return '三角格子の履歴の手が不正です';
      for (var j = 0; j < step.length; j++) {
        var pair = step[j];
        if (!Array.isArray(pair) || pair.length !== 2) return '三角格子の履歴の項目が不正です';
        if (typeof pair[0] !== 'string' || !/^\d+,\d+,(up|down)$/.test(pair[0])) return '三角格子の履歴の位置が不正です';
        if (pair[1] !== null && (!Number.isInteger(pair[1]) || pair[1] < 1 || pair[1] > 4)) return '三角格子の履歴の色番号が不正です';
      }
    }
    return true;
  }
  var LATTICE_MODES = ['square', 'tri60'];

  /* ============================================================
   * 12. レイヤー（仕様v4 段D）— DOM非依存。レイヤーは
   *    { id, name, lattice:'square'|'tri60', cells|cells60, visible, locked,
   *      opacity:1|.75|.5|.25, mirror } という「保存できる形」（params.layers[]の要素）。
   *    実際に編集するときの生きたgridオブジェクト（Map持ち）はindex.html側が
   *    gridFromCells/gridFromCells60・cellsToObject/cellsToObject60で
   *    このcells/cells60と相互変換する（core.jsは常にプレーンなJSオブジェクトだけを扱う）。
   * ============================================================ */
  // 汎用格子（LatticeDef）のidは実行時にLATTICE_DEFSから読むため、ここでは関数として定義する
  // （このファイル内の定義順の都合上、GENERIC_LATTICE_IDSはこの時点でまだ定義されていない）。
  function layerLatticeModes() { return ['square', 'tri60', 'hex'].concat(Object.keys(LATTICE_DEFS || {})); }
  var LAYER_OPACITY_VALUES = [1, 0.75, 0.5, 0.25];
  var COLOR_MODE_VALUES = ['manual', 'byDirection', 'shade']; // 'shade'=ゴールとロードマップv5 M2「明暗の規則」
  // 2026-09-17「色をレイヤーごとに」: レイヤーが自分の色1〜4を持つ既定値（colors引数を渡さない
  // 呼び出し・旧保存の補完で使う）。index.html側の起動時の既定色(values.c1..c4)と同じ値にしておき、
  // 「新規レイヤーは今の描画色を引き継ぐ」を壊さない
  var DEFAULT_LAYER_COLORS = ['#2B2B2B', '#B0463E', '#3B6EA5', '#D9B44A'];

  function makeLayerId(seq) { return 'layer-' + seq; }
  // colors: 省略時はDEFAULT_LAYER_COLORS。呼び出し側の配列をそのまま握らずコピーする（純関数の原則）
  function emptyLayerOfLattice(lattice, seq, mirror, colors) {
    var okColors = Array.isArray(colors) && colors.length === 4;
    var layer = {
      id: makeLayerId(seq), name: 'レイヤー' + seq, lattice: lattice,
      visible: true, locked: false, opacity: 1, mirror: mirror || 'none',
      colorMode: 'manual', // 仕様v4 段E「向きで色を決める」。既定は従来通りの手選び
      colors: (okColors ? colors : DEFAULT_LAYER_COLORS).slice() // 2026-09-17「色をレイヤーごとに」
    };
    if (lattice === 'tri60') layer.cells60 = {};
    else if (lattice === 'hex') layer.cellsHex = {};
    else if (LATTICE_DEFS && LATTICE_DEFS[lattice]) layer.cellsGeneric = {};
    else layer.cells = {};
    return layer;
  }
  // 旧形式（1つのvariantオブジェクトが直接cells/cells60/latticeを持つ）を
  // レイヤーの束{layers:[...],colors,bg}へ変換する（候補=variantsのv4→v5移行に使う）
  function migrateVariantToLayers(v) {
    if (v && Array.isArray(v.layers)) return v; // 既にv5形式ならそのまま
    var layers = [];
    var hasSquare = v.cells && Object.keys(v.cells).length > 0;
    var hasTri60 = v.cells60 && Object.keys(v.cells60).length > 0;
    if (hasSquare) { var ls = emptyLayerOfLattice('square', layers.length + 1, null, v.colors); ls.cells = v.cells; layers.push(ls); }
    if (hasTri60) { var lt = emptyLayerOfLattice('tri60', layers.length + 1, null, v.colors); lt.cells60 = v.cells60; layers.push(lt); }
    if (!layers.length) layers.push(emptyLayerOfLattice(v.lattice === 'tri60' ? 'tri60' : 'square', 1, null, v.colors));
    return { layers: layers, colors: v.colors, bg: v.bg };
  }
  // v4→v5（仕様v4 段D「レイヤー」）: 旧paramsの square(cells)/tri60(cells60) を
  // 最大2枚のレイヤーへ移す。空の格子はレイヤーにしない（両方空なら旧latticeで1枚だけ作る）。
  function migrateParamsV4toV5(params) {
    var next = Object.assign({}, params);
    var mirror = MIRROR_MODES.indexOf(params.mirror) !== -1 ? params.mirror : 'none';
    var layers = [];
    var hasSquare = params.cells && Object.keys(params.cells).length > 0;
    var hasTri60 = params.cells60 && Object.keys(params.cells60).length > 0;
    if (hasSquare) { var ls = emptyLayerOfLattice('square', layers.length + 1, mirror, params.colors); ls.cells = params.cells; layers.push(ls); }
    if (hasTri60) { var lt = emptyLayerOfLattice('tri60', layers.length + 1, mirror, params.colors); lt.cells60 = params.cells60; layers.push(lt); }
    if (!layers.length) layers.push(emptyLayerOfLattice(params.lattice === 'tri60' ? 'tri60' : 'square', 1, mirror, params.colors));
    var activeLattice = params.lattice === 'tri60' ? 'tri60' : 'square';
    var active = null;
    for (var i = 0; i < layers.length; i++) if (layers[i].lattice === activeLattice) { active = layers[i]; break; }
    if (!active) active = layers[0];
    delete next.cells; delete next.cells60; delete next.lattice; delete next.mirror;
    next.layers = layers;
    next.activeLayer = active.id;
    next.variants = Array.isArray(params.variants) ? params.variants.map(migrateVariantToLayers) : [];
    return next;
  }
  // v5→v6（仕様v4 段E「向きで色を決める」・段F「ランダム充填」）:
  // 各レイヤーへ colorMode:'manual' を補う（既にあれば上書きしない）。params.fill を新設（既定値）。
  function migrateParamsV5toV6(params) {
    var next = Object.assign({}, params);
    next.layers = (params.layers || []).map(function (l) { return Object.assign({ colorMode: 'manual' }, l); });
    next.fill = params.fill || { elements: [], density: 50, weights: [1, 1, 1, 1], seed: null, keep: 'keep' };
    return next;
  }
  // 並べ替え（ドラッグ・⌘[/⌘]・⇧⌘[/⇧⌘]で共通に使う純関数）。範囲外のtoIndexはクランプする。
  // layers[0]=最背面・末尾=最前面という規約はindex.html側の描画順が決める（この関数はただの配列移動）。
  function reorderLayers(layers, fromIndex, toIndex) {
    var n = layers.length;
    if (fromIndex < 0 || fromIndex >= n) return layers.slice();
    var clamped = Math.max(0, Math.min(n - 1, toIndex));
    var arr = layers.slice();
    var item = arr.splice(fromIndex, 1)[0];
    arr.splice(clamped, 0, item);
    return arr;
  }
  /* ============================================================
   * 12.5 色の割り当て（仕様v4 段E「向きで色を決める」）— 純関数。
   *   layer = { colorMode:'manual'|'byDirection', grid }（gridはtri60の隣接判定に使う）。
   *   element（呼び出し側=collectEdgesForColor/60が渡す）:
   *     {kind:'tri', col,row,dir,cell}    … 正方形格子の三角（cellは同じ位置のセル本体。
   *                                          4方向すべてが埋まっている＝見た目上の正方形なら色1）
   *     {kind:'quarter', col,row,corner}  … 四分円・凹（形は問わず角だけで決まる）
   *     {kind:'tri60', col,row,o}         … 正三角格子の三角。ちょうど1辺だけ隣が塗られている
   *                                          （＝孤立した2枚組=ひし形）なら、その共有辺の向き
   *                                          （辺index 0〜2。tri60Cornersの辺並びは上下・行の
   *                                          偶奇によらず同じ向きで揃っているため、ひし形の2枚は
   *                                          必ず同じ辺indexを共有し、同じ色になる＝1本のpathに
   *                                          融合する）で色1〜3。それ以外（孤立した1枚、または
   *                                          2辺以上が隣接=もっと大きな塊の一部）は上向き=色1・
   *                                          下向き=色2。
   *   manualColor: 手選びで実際に塗ってある色（colorMode='manual'ならそのまま返す・保持のため）。
   * ============================================================ */
  function effectiveColorOf(layer, element, manualColor) {
    if (!layer || layer.colorMode !== 'byDirection') return manualColor != null ? manualColor : null;
    if (element.kind === 'tri') {
      var cell = element.cell;
      var full = !!(cell && cell.tris && cell.tris.up != null && cell.tris.right != null && cell.tris.down != null && cell.tris.left != null);
      if (full) return 1;
      return { up: 1, right: 2, down: 3, left: 4 }[element.dir];
    }
    if (element.kind === 'quarter') {
      return { tl: 1, tr: 2, br: 3, bl: 4 }[element.corner];
    }
    if (element.kind === 'tri60') {
      var grid = layer.grid;
      var verts = tri60Corners(element.col, element.row, element.o);
      var edgePts = [[verts[0], verts[1]], [verts[1], verts[2]], [verts[2], verts[0]]];
      var occupiedEdges = [];
      for (var i = 0; i < 3; i++) {
        var nb = neighborTri60(grid, element.col, element.row, element.o, i);
        if (nb && getTri60(grid, nb.col, nb.row, nb.o) != null) occupiedEdges.push(i);
      }
      if (occupiedEdges.length === 1) {
        var fam = tri60EdgeFamily(edgePts[occupiedEdges[0]][0], edgePts[occupiedEdges[0]][1]);
        return TRI60_EDGE_FAMILY_COLOR[fam];
      }
      // ゴールとロードマップv5 M1「立体モード」: 6枚すべてが埋まっている（＝立方体として
      // 完成している）場合は、孤立ペアと同じ角度判定（cubeFaceFromOuterVertices）で
      // 色1(top)/2(left)/3(right)に分ける（手選びモードの立方体ブラシと同じ関係）。
      var cubeFace = tri60CubeFaceIfComplete(grid, element.col, element.row, element.o);
      if (cubeFace) return CUBE_FACE_COLOR[cubeFace];
      return element.o === 'up' ? 1 : 2;
    }
    if (element.kind === 'hex') return 1; // 六角形は向きが無いので色1固定（仕様v4 段G）
    if (element.kind === 'generic') return element.dir === 'oct' ? 1 : 2; // 仕様v4 段H: 八角形=色1・正方形=色2
    return manualColor != null ? manualColor : null;
  }
  // 辺(a,b)の「向き」を3方向(水平/斜め2種)のどれかに分類する（仕様v4 段E「ひし形は3方向」）。
  // 辺の両端点だけから決まる純粋に幾何的な値なので、ひし形の2枚のどちらから計算しても必ず一致する
  // （辺index自体は上下・行の偶奇で内部的にズレる＝000_README.md差し戻しメモにある通り辺の並び順は
  // 統一されているが「相手から見た時の同じ物理辺のindex」は一致しない。角度は順序に依らず一致する）
  function tri60EdgeFamily(a, b) {
    var deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    var norm = ((deg % 180) + 180) % 180; // 0..180
    var snapped = Math.round(norm / 60) * 60;
    return snapped % 180; // 0 | 60 | 120
  }
  // 仕様v5 M1「立体モード」に合わせて top=1/left=2/right=3 の関係になる並びへ変更
  // （2026-09-14。以前は{0:1,60:2,120:3}。テストは色の具体値を決め打ちしていないため
  // 既存assertは影響を受けない＝000_README.md 検証節に記載）。
  var TRI60_EDGE_FAMILY_COLOR = { 0: 2, 60: 3, 120: 1 };

  // 書き出し用データの組み立て（DOM非依存）。layers: [{id,name,lattice,grid,visible,opacity,colorMode,shade}]
  // gridは createGrid/createGrid60 が返す実グリッド（Mapを持つ）。非表示レイヤーは含めない。
  // colorMode:'byDirection' のレイヤーは、融合のグルーピングをeffectiveColorOfで差し替える。
  // colorMode:'shade' のレイヤーは、グルーピングをshadeFaceIdOfで差し替える（実際の色は
  // 呼び出し側=index.htmlがshadeColorForFaceで計算し、colorPathsのcolorは「面番号」になる。
  // ゴールとロードマップv5 M2「明暗の規則」）。
  // opts.explode: true なら「要素ごとに分ける」（2026-09-16採用。融合させず置いた要素1つ＝
  // path 1つにする）。無ければ従来通り「同色を融合」。colorFnの契約（表示色の決め方）は
  // 両モードで完全に同じ＝どちらのopts.colorFnも両方の経路にそのまま渡せる。
  function buildLayersExport(layers, colorCount, opts) {
    var out = [];
    var explode = opts && opts.explode;
    (layers || []).forEach(function (layer) {
      if (!layer.visible) return;
      var layerOpts = opts;
      if (layer.colorMode === 'byDirection') {
        layerOpts = Object.assign({}, opts, { colorFn: function (el, manual) { return effectiveColorOf(layer, el, manual); } });
      } else if (layer.colorMode === 'shade') {
        layerOpts = Object.assign({}, opts, { colorFn: function (el) { return shadeFaceIdOf(layer, el); } });
      }
      // tri60×光で決める は面番号が奥の面(4〜6)まで伸びる(shadeFaceIdOf参照。M3「不可能図形の
      // 補助」)ため、その時だけ6色分ループする（他は従来通りcolorCountのまま＝無関係）。
      var colorCount60 = (layer.lattice === 'tri60' && layer.colorMode === 'shade') ? Math.max(colorCount || 4, 6) : colorCount;
      var paths = explode
        ? (layer.lattice === 'tri60'
          ? buildExplodedPaths60(layer.grid, layerOpts)
          : layer.lattice === 'hex'
            ? buildExplodedPathsHex(layer.grid, layerOpts)
            : LATTICE_DEFS[layer.lattice]
              ? buildExplodedPathsGeneric(layer.grid, layerOpts)
              : buildExplodedPaths(layer.grid, layerOpts))
        : (layer.lattice === 'tri60'
          ? buildAllPaths60(layer.grid, colorCount60, layerOpts)
          : layer.lattice === 'hex'
            ? buildAllPathsHex(layer.grid, colorCount, layerOpts)
            : LATTICE_DEFS[layer.lattice]
              ? buildAllPathsGeneric(layer.grid, colorCount, layerOpts)
              : buildAllPaths(layer.grid, colorCount, layerOpts));
      out.push({ id: layer.id, name: layer.name, lattice: layer.lattice, opacity: layer.opacity, colorMode: layer.colorMode, shade: layer.shade, colors: layer.colors, colorPaths: paths });
    });
    return out;
  }
  /* ============================================================
   * 12.6 動きと空間への展開への出口（141_動きと空間への展開/scene-json.md）—
   *   1マスに塗った図形（三角・四分円・凹・正三角・六角形）を「動かす最小単位」の
   *   多角形（閉じた頂点列）へ直す。既存の辺関数（triEdges/quarterEdges/notchEdges/
   *   tri60Corners/hexOuterEdges）をそのまま呼ぶだけで、新しい幾何は増やさない。
   *   弧（四分円・凹の要素）は8分割して直線の頂点列にする（器は多角形しか動かせないため）。
   * ============================================================ */
  var UNIT_ARC_STEPS = 8;
  // edges（{a,b,arc}の列。a→bで一周してaに戻る）を頂点配列[[x,y],...]へ直す。
  // 弧はUNIT_ARC_STEPS分割・最後に始点と重なる終端は落とす（多角形の頂点だけを残す）
  function edgesToPolygon(edges) {
    var pts = [[edges[0].a.x, edges[0].a.y]];
    edges.forEach(function (e) {
      if (e.arc) {
        var cx = e.arc.cx, cy = e.arc.cy, r = e.arc.r, sweep = e.arc.sweep;
        var a0 = Math.atan2(e.a.y - cy, e.a.x - cx);
        var a1 = Math.atan2(e.b.y - cy, e.b.x - cx);
        var da = a1 - a0;
        if (sweep) { while (da <= 1e-9) da += Math.PI * 2; }
        else { while (da >= -1e-9) da -= Math.PI * 2; }
        for (var i = 1; i <= UNIT_ARC_STEPS; i++) {
          var t = a0 + da * i / UNIT_ARC_STEPS;
          pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
        }
      } else {
        pts.push([e.b.x, e.b.y]);
      }
    });
    var first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) pts.pop();
    return pts;
  }
  // grid: 実グリッド（Mapを持つ）。lattice: 'square'|'tri60'|'hex'。
  // 戻り値: [{key, color, pts:[[x,y],...]}]（塗った図形1つ=1ユニット）
  // sceneの最小単位・履歴も、融合pathと同じ面番号で色を解決する。
  function unitColorOf(layer, key, manual) {
    if (manual == null) return null;
    var parts = key.split(','), col = +parts[0], row = +parts[1];
    var element;
    if (layer.lattice === 'tri60') element = { kind: 'tri60', col: col, row: row, o: parts[2] };
    else if (layer.lattice === 'hex' || LATTICE_DEFS[layer.lattice]) element = { kind: 'generic' };
    else if (key.indexOf('arc:') === 0) {
      var arc = layer.grid.arcs.get(key.slice(4));
      element = { kind: 'quarter', corner: arc.quad };
    } else {
      var cell = layer.grid.cells.get(col + ',' + row);
      element = cell && cell.mode === 'quarter' ? { kind: 'quarter', col: col, row: row, corner: parts[2] }
        : { kind: 'tri', col: col, row: row, dir: parts[2], cell: cell };
    }
    return layer.colorMode === 'shade' ? shadeFaceIdOf(layer, element) : effectiveColorOf(layer, element, manual);
  }
  function sceneColorOf(layer, colorIdx, fallbackColors) {
    if (colorIdx == null) return null;
    if (layer.colorMode === 'shade' && layer.shade) {
      return shadeColorForFace(layer.shade.base, layer.lattice, colorIdx, layer.shade.light, layer.shade.contrast);
    }
    if (Array.isArray(layer.colors) && layer.colors.length === 4 && colorIdx >= 1 && colorIdx <= 4) {
      return layer.colors[colorIdx - 1];
    }
    return Array.isArray(fallbackColors) ? fallbackColors[colorIdx - 1] : null;
  }
  // scene/1の見た目・最小単位・履歴を同じ色解決で組み立てる。
  // fallbackColorsはlayer.colorsを持たない旧データ用で、新しいレイヤーでは使わない。
  function buildSceneGraphics(layers, opts) {
    opts = opts || {};
    var fallbackColors = opts.fallbackColors || [];
    var built = buildLayersExport(layers, 4, opts.pathOptions || {});
    var shapes = [];
    built.forEach(function (entry) {
      entry.colorPaths.forEach(function (p) {
        var hex = sceneColorOf(entry, p.color, fallbackColors);
        if (!hex || hex === 'none') return;
        shapes.push({
          id: entry.id + '/' + (entry.colorMode === 'shade' ? 'shade-' : 'color-') + p.color,
          layer: entry.id,
          color: hex,
          opacity: entry.opacity == null ? 1 : entry.opacity,
          d: p.d
        });
      });
    });
    var units = [];
    (layers || []).forEach(function (layer) {
      if (!layer.visible) return;
      unitPolygons(layer.grid, layer.lattice).forEach(function (u) {
        var hex = sceneColorOf(layer, unitColorOf(layer, u.key, u.color), fallbackColors);
        if (!hex || hex === 'none') return;
        var item = {
          id: layer.id + '/' + u.key,
          layer: layer.id,
          color: hex,
          opacity: layer.opacity == null ? 1 : layer.opacity,
          pts: u.pts
        };
        if (layer.lattice === 'tri60') item.step = u.step || 0;
        units.push(item);
      });
    });
    var stepsLog = [];
    var stepsCount = 0;
    (layers || []).forEach(function (layer) {
      if (!layer.visible || layer.lattice !== 'tri60') return;
      var logArr = logToArray60(layer.grid);
      var offset = stepsCount;
      logArr.forEach(function (stepEntries, localIdx) {
        var cells = [];
        (stepEntries || []).forEach(function (pair) {
          var key = pair[0], colorNum = pair[1];
          var parts = key.split(','), col = +parts[0], row = +parts[1], o = parts[2];
          var v = tri60Corners(col, row, o);
          var resolved = colorNum == null ? null : sceneColorOf(layer, unitColorOf(layer, key, colorNum), fallbackColors);
          cells.push({
            key: key,
            layer: layer.id,
            color: resolved || null,
            opacity: layer.opacity == null ? 1 : layer.opacity,
            pts: [[v[0].x, v[0].y], [v[1].x, v[1].y], [v[2].x, v[2].y]]
          });
        });
        stepsLog.push({ step: offset + localIdx, cells: cells });
      });
      stepsCount += logArr.length;
    });
    return { shapes: shapes, units: units, steps: { count: stepsCount, log: stepsLog } };
  }
  function unitPolygons(grid, lattice) {
    var out = [];
    if (lattice === 'tri60') {
      grid.cells.forEach(function (color, key) {
        if (color == null) return;
        var parts = key.split(','), col = +parts[0], row = +parts[1], o = parts[2];
        var v = tri60Corners(col, row, o);
        var step60 = (grid.step && grid.step.has(key)) ? grid.step.get(key) : 0;
        out.push({ key: key, color: color, pts: [[v[0].x, v[0].y], [v[1].x, v[1].y], [v[2].x, v[2].y]], step: step60 });
      });
      return out;
    }
    if (lattice === 'hex') {
      grid.cells.forEach(function (color, key) {
        if (color == null) return;
        var parts = key.split(','), L = +parts[0], j = +parts[1];
        var outer = hexOuterEdges(grid.n, L, j);
        var loops = buildLoops(outer);
        if (!loops.length) return;
        out.push({ key: key, color: color, pts: edgesToPolygon(loops[0]) });
      });
      return out;
    }
    if (LATTICE_DEFS[lattice]) {
      grid.cells.forEach(function (color, key) {
        if (color == null) return;
        var poly = grid.polyByKey[key];
        if (!poly) return;
        out.push({ key: key, color: color, pts: poly.map(function (p) { return [p.x, p.y]; }) });
      });
      return out;
    }
    grid.cells.forEach(function (cell, key) {
      if (!cell) return;
      var parts = key.split(','), col = +parts[0], row = +parts[1];
      if (cell.mode === 'tri') {
        TRI_DIRS.forEach(function (dir) {
          var color = cell.tris[dir];
          if (color == null) return;
          out.push({ key: key + ',' + dir, color: color, pts: edgesToPolygon(triEdges(col, row, dir)) });
        });
      } else if (cell.mode === 'quarter') {
        var edges = cell.shape === 'quarter' ? quarterEdges(col, row, cell.corner) : notchEdges(col, row, cell.corner);
        out.push({ key: key + ',' + cell.corner, color: cell.color, pts: edgesToPolygon(edges) });
      }
    });
    // 大きな円弧（仕様v6）: arcごとに1多角形（動きの書き出しへの出口。委任パケット段C）
    if (grid.arcs) grid.arcs.forEach(function (arc, id) {
      out.push({ key: 'arc:' + id, color: arc.color, pts: edgesToPolygon(bigArcEdges(arc)) });
    });
    return out;
  }

  // colorMode:'shade'のレイヤーが持つ光の設定（ゴールとロードマップv5 M2「明暗の規則」）
  function validateShade(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'レイヤーの光の設定が不正です';
    if (!isColorValue(s.base) || s.base === 'none') return '基準色の指定が不正です';
    if (typeof s.light !== 'number' || !isFinite(s.light) || s.light < 0 || s.light > 360) return '光源角の指定が不正です';
    if (typeof s.contrast !== 'number' || !isFinite(s.contrast) || s.contrast < 0 || s.contrast > 100) return 'コントラストの指定が不正です';
    return true;
  }
  // 仕様v6「大きな円弧」paramsVersion 12: layer.arcs（正方形レイヤーだけが持つ。無ければ[]扱い）。
  // n（マスの数）はブロックの格子内判定に使う（validateLayer経由で呼び出し側から渡ってくる）
  function validateArcsArray(arcs, n) {
    if (arcs == null) return true;
    if (!Array.isArray(arcs)) return '円弧の一覧が不正です';
    for (var i = 0; i < arcs.length; i++) {
      var a = arcs[i];
      if (!a || typeof a !== 'object' || Array.isArray(a)) return '円弧の内容が不正です';
      if (!Number.isInteger(a.gx) || !Number.isInteger(a.gy)) return '円弧の中心が不正です';
      if (CORNERS.indexOf(a.quad) === -1) return '円弧の向きが不正です';
      if (!Number.isInteger(a.r) || a.r < 2 || a.r > 12) return '円弧の半径が不正です';
      if (a.shape !== 'quarter' && a.shape !== 'notch') return '円弧の種類が不正です';
      if (a.shape === 'notch') {
        if (a.hole !== 0 && a.hole != null) return '凹の円弧に穴は指定できません';
      } else if (!Number.isInteger(a.hole == null ? 0 : a.hole) || a.hole < 0 || a.hole >= a.r) {
        return '円弧の穴の半径が不正です';
      }
      if (!Number.isInteger(a.color) || a.color < 1 || a.color > 4) return '円弧の色番号が不正です';
      if (n != null && !arcInBoundsBlock(arcBlock(a), n)) return '円弧が格子からはみ出しています';
    }
    return true;
  }
  // レイヤーのvalidate（params.layers[i]）。cells/cells60は既存の共通チェックを再利用する
  function validateLayer(layer, n) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return 'レイヤーの内容が不正です';
    if (typeof layer.id !== 'string' || !layer.id) return 'レイヤーのidが不正です';
    if (typeof layer.name !== 'string') return 'レイヤーの名前が不正です';
    if (layerLatticeModes().indexOf(layer.lattice) === -1) return 'レイヤーの格子が不正です';
    if (typeof layer.visible !== 'boolean') return 'レイヤーの表示指定が不正です';
    if (typeof layer.locked !== 'boolean') return 'レイヤーのロック指定が不正です';
    if (LAYER_OPACITY_VALUES.indexOf(layer.opacity) === -1) return 'レイヤーの不透明度が不正です';
    if (MIRROR_MODES.indexOf(layer.mirror) === -1) return 'レイヤーのミラー指定が不正です';
    if (COLOR_MODE_VALUES.indexOf(layer.colorMode) === -1) return 'レイヤーの色の割り当てが不正です';
    if (layer.colorMode === 'shade') {
      var shadeOk = validateShade(layer.shade);
      if (shadeOk !== true) return shadeOk;
    }
    // 2026-09-17「色をレイヤーごとに」: layer.colorsは任意項目（無ければ旧保存のまま＝
    // 呼び出し側が既定色やグローバル色で補う。あるなら色1〜4として妥当な形か検証する）
    if (layer.colors != null && !validateColorsArray(layer.colors)) return 'レイヤーの色1〜4の指定が不正です';
    if (layer.lattice === 'square') {
      var okC = validateCellsObject(layer.cells || {});
      if (okC !== true) return okC;
      var okArcs = validateArcsArray(layer.arcs, n);
      if (okArcs !== true) return okArcs;
    } else if (layer.lattice === 'hex') {
      var okHex = validateCellsHexObject(layer.cellsHex || {});
      if (okHex !== true) return okHex;
    } else if (layer.lattice === 'tri60') {
      var ok60 = validateCells60Object(layer.cells60 || {});
      if (ok60 !== true) return ok60;
      var okOrient60 = validateCellsOrient60Object(layer.cellsOrient60);
      if (okOrient60 !== true) return okOrient60;
      var okStep60 = validateCellsStep60Object(layer.cellsStep60);
      if (okStep60 !== true) return okStep60;
      var okLog60 = validateCellsLog60Array(layer.cellsLog60);
      if (okLog60 !== true) return okLog60;
    } else {
      var okGen = validateCellsGenericObject(layer.cellsGeneric || {}, layer.lattice);
      if (okGen !== true) return okGen;
    }
    return true;
  }
  function validateLayersArray(layers, n) {
    if (!Array.isArray(layers) || layers.length === 0) return 'レイヤーの一覧が不正です';
    for (var i = 0; i < layers.length; i++) {
      var r = validateLayer(layers[i], n);
      if (r !== true) return r;
    }
    return true;
  }

  /* ============================================================
   * 13. ランダム充填（仕様v4 段F）— DOM非依存の純関数。
   *   PRNGは 000_kit/studio-kit.js の Studio.rng（mulberry32・定数0x6D2B79F5）と同じ
   *   アルゴリズムを使う（「事実上の標準」を再実装ではなくそのまま踏襲。core.jsは
   *   test.mjsからstudio-kitに依存せず単体で読めることを保つため、ここに軽量に持つ）。
   *   候補＝選択範囲（矩形）内の「マス」（正方形格子はcol,row・正三角格子は三角col,row,o）。
   *   1候補ごとに rng() を1回引いて密度と比較し、塗るかどうかを決める（決定的：同じ種・同じ
   *   設定・同じ範囲なら同じ乱数列＝同じ結果）。塗る場合はさらに rng() で要素の種類→形の中の
   *   向き/角→色、の順に引き、既存のpaint系関数（ミラーを内蔵）でそのまま塗る。
   * ============================================================ */
  function makeFillRng(seed) {
    var a = (Number(seed) >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
    };
  }
  var SQUARE_FILL_ELEMENTS = ['tri', 'square', 'quarter', 'notch', 'half', 'circle'];
  var TRI60_FILL_ELEMENTS = ['rhombus', 'hex', 'tri', 'cube'];
  function normalizeFillWeights(w) {
    var arr = (Array.isArray(w) && w.length === 4) ? w.slice() : [1, 1, 1, 1];
    arr = arr.map(function (x) { return (typeof x === 'number' && isFinite(x) && x > 0) ? x : 0; });
    var sum = arr[0] + arr[1] + arr[2] + arr[3];
    if (sum <= 0) return [0.25, 0.25, 0.25, 0.25];
    return arr.map(function (x) { return x / sum; });
  }
  function pickWeightedColor(rng, weights) {
    var r = rng(), acc = 0;
    for (var i = 0; i < 4; i++) { acc += weights[i]; if (r < acc) return i + 1; }
    return 4;
  }
  /* ============================================================
   * 13.5 位置で変える規則（ゴールとロードマップv5 M2「オプアートの勾配」）— 純関数。
   *   ランダム充填の密度を、候補マス位置(0〜1に正規化したu,v)で変調する。密度を下げる
   *   方向にだけ倍率(factor∈[床,1])を掛ける＝'none'は常にfactor=1で既存の挙動と完全一致
   *   （densityGradient省略時の呼び出しは無変更。既存のランダム充填の決定性テストは無傷）。
   *   'lr'=左が疎・右が密／'center'=中心が密・外側が疎／'wave'=横方向に密度が波打つ。
   * ============================================================ */
  var DENSITY_GRADIENTS = ['none', 'lr', 'center', 'wave'];
  var DENSITY_GRADIENT_FLOOR = 0.15; // 最も疎な位置でも基準密度のこの割合は残す
  function densityGradientFactor(gradient, u, v) {
    var span = 1 - DENSITY_GRADIENT_FLOOR;
    if (gradient === 'lr') return DENSITY_GRADIENT_FLOOR + span * u;
    if (gradient === 'center') {
      var dx = u - 0.5, dy = v - 0.5;
      var d = Math.sqrt(dx * dx + dy * dy);
      var dMax = Math.SQRT1_2; // 中心(0.5,0.5)から矩形の角までの最大距離
      return Math.max(DENSITY_GRADIENT_FLOOR, 1 - span * Math.min(1, d / dMax));
    }
    if (gradient === 'wave') return DENSITY_GRADIENT_FLOOR + span * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * u));
    return 1;
  }
  // rect内の位置(value)を0(lo)〜1(hi)に正規化する。範囲が1点だけ(lo===hi)なら中央(0.5)扱い
  function rectNorm01(value, lo, hi) { return hi > lo ? (value - lo) / (hi - lo) : 0.5; }
  // 実座標の頂点(x,y)から、正三角格子の「格子点」表現{L,j,x,y}を復元する（六角形ブラシの
  // hexagonCells60が要求する形。tri60Line(L,j)の作り方の厳密な逆算なので誤差は出ない）
  function tri60PointFromVertex(v) {
    var L = Math.round(v.y / TRI60_H);
    var isInt = (L % 2 === 0);
    var j = isInt ? Math.round(v.x / UNIT) : Math.round(v.x / UNIT - 0.5);
    var p = tri60Line(L, j);
    return { L: L, j: j, x: p.x, y: p.y };
  }
  function placeSquareFillElement(grid, col, row, kind, color, rng, mirror, n) {
    if (kind === 'tri') {
      var dir = TRI_DIRS[Math.floor(rng() * TRI_DIRS.length)];
      paint(grid, { shape: 'tri', col: col, row: row, dir: dir, color: color, mirror: mirror, n: n });
    } else if (kind === 'square') {
      paint(grid, { shape: 'square', col: col, row: row, color: color, mirror: mirror, n: n });
    } else if (kind === 'quarter' || kind === 'notch') {
      var corner = CORNERS[Math.floor(rng() * CORNERS.length)];
      paint(grid, { shape: kind, col: col, row: row, corner: corner, color: color, mirror: mirror, n: n });
    } else if (kind === 'circle' || kind === 'half') {
      var gx = col + (rng() < 0.5 ? 0 : 1), gy = row + (rng() < 0.5 ? 0 : 1);
      if (kind === 'circle') {
        paintComposite(grid, { kind: 'circle', gx: gx, gy: gy, color: color, mirror: mirror, n: n });
      } else {
        var sides = ['north', 'south', 'east', 'west'];
        var side = sides[Math.floor(rng() * sides.length)];
        paintComposite(grid, { kind: 'half', gx: gx, gy: gy, side: side, color: color, mirror: mirror, n: n });
      }
    }
  }
  // opts: { elements:[...], density(0-100), weights:[w1..w4], seed, mirror, keep }（keepは呼び出し側=
  // index.htmlが「消してから」の事前クリアを行うので、ここは常に上書きで塗るだけでよい）
  // 戻り値: { filled: 実際に塗った候補マスの数 }
  function randomFillSquare(grid, rect, opts) {
    var allowed = (opts.elements || []).filter(function (e) { return SQUARE_FILL_ELEMENTS.indexOf(e) !== -1; });
    if (!allowed.length) return { filled: 0 };
    var rng = makeFillRng(opts.seed);
    var density = Math.max(0, Math.min(100, opts.density || 0)) / 100;
    var gradient = opts.densityGradient || 'none';
    var weights = normalizeFillWeights(opts.weights);
    var n = opts.n != null ? opts.n : grid.n;
    var filled = 0;
    for (var row = rect.r0; row <= rect.r1; row++) {
      for (var col = rect.c0; col <= rect.c1; col++) {
        if (arcAt(grid, col, row)) continue; // 仕様v6「大きな円弧」占有ルール: ブロックは占有済みとして飛ばす
        var localDensity = density * densityGradientFactor(gradient, rectNorm01(col, rect.c0, rect.c1), rectNorm01(row, rect.r0, rect.r1));
        if (rng() >= localDensity) continue;
        var kind = allowed[Math.floor(rng() * allowed.length)];
        var color = pickWeightedColor(rng, weights);
        placeSquareFillElement(grid, col, row, kind, color, rng, opts.mirror, n);
        filled++;
      }
    }
    return { filled: filled };
  }
  function placeTri60FillElement(grid, col, row, o, kind, color, rng, mirror) {
    if (kind === 'tri') {
      paintTri60(grid, { col: col, row: row, o: o, color: color, mirror: mirror });
    } else if (kind === 'rhombus') {
      var edgeIdx = Math.floor(rng() * 3);
      var nb = neighborTri60(grid, col, row, o, edgeIdx);
      var cells = nb ? [{ col: col, row: row, o: o }, nb] : [{ col: col, row: row, o: o }];
      paintTri60Group(grid, cells, { color: color, mirror: mirror });
    } else if (kind === 'hex') {
      var verts = tri60Corners(col, row, o);
      var vi = Math.floor(rng() * verts.length);
      var gp = tri60PointFromVertex(verts[vi]);
      var cells2 = hexagonCells60(grid, gp);
      paintTri60Group(grid, cells2, { color: color, mirror: mirror });
    } else if (kind === 'cube') {
      // 仕様v5 M1: 立方体は手選び/向き色モードどちらでも上=色1・左=色2・右=色3の固定（colorは使わない）
      var verts3 = tri60Corners(col, row, o);
      var vi3 = Math.floor(rng() * verts3.length);
      var gp3 = tri60PointFromVertex(verts3[vi3]);
      paintCube60(grid, gp3, CUBE_FACE_COLOR, false, mirror);
    }
  }
  // rect: {c0,r0,c1,r1}（col・row。両オリエンテーションo=up/downそれぞれについて候補判定する）
  function randomFillTri60(grid, rect, opts) {
    var allowed = (opts.elements || []).filter(function (e) { return TRI60_FILL_ELEMENTS.indexOf(e) !== -1; });
    if (!allowed.length) return { filled: 0 };
    var rng = makeFillRng(opts.seed);
    var density = Math.max(0, Math.min(100, opts.density || 0)) / 100;
    var gradient = opts.densityGradient || 'none';
    var weights = normalizeFillWeights(opts.weights);
    var filled = 0;
    for (var row = rect.r0; row <= rect.r1; row++) {
      for (var col = rect.c0; col <= rect.c1; col++) {
        var localDensity = density * densityGradientFactor(gradient, rectNorm01(col, rect.c0, rect.c1), rectNorm01(row, rect.r0, rect.r1));
        ['down', 'up'].forEach(function (o) {
          if (!isTri60InBounds(grid, col, row, o)) return;
          if (rng() >= localDensity) return;
          var kind = allowed[Math.floor(rng() * allowed.length)];
          var color = pickWeightedColor(rng, weights);
          placeTri60FillElement(grid, col, row, o, kind, color, rng, opts.mirror);
          filled++;
        });
      }
    }
    return { filled: filled };
  }
  var FILL_ELEMENT_ALL = SQUARE_FILL_ELEMENTS.concat(TRI60_FILL_ELEMENTS).filter(function (v, i, a) { return a.indexOf(v) === i; });
  // 「規則で埋める」の要素は、正方形・正三角形の形の名前に加えて LatticeDef 格子のタイルid
  // （oct/sq・cairo-a…・rh-0…・brick・読み込んだ格子のタイルid）も取る。
  // GENERIC_FILL_ELEMENTS_BY_DEF は登録のたびに増えるので、判定は呼ばれた時点の中身で行う
  function isKnownFillElement(e) {
    if (FILL_ELEMENT_ALL.indexOf(e) !== -1) return true;
    for (var defId in GENERIC_FILL_ELEMENTS_BY_DEF) {
      if (!Object.prototype.hasOwnProperty.call(GENERIC_FILL_ELEMENTS_BY_DEF, defId)) continue;
      if ((GENERIC_FILL_ELEMENTS_BY_DEF[defId] || []).indexOf(e) !== -1) return true;
    }
    return false;
  }
  function validateFill(f) {
    if (f == null) return true;
    if (typeof f !== 'object' || Array.isArray(f)) return 'ランダム充填の指定が不正です';
    if (!Array.isArray(f.elements) || f.elements.some(function (e) { return !isKnownFillElement(e); })) return 'ランダム充填の要素指定が不正です';
    if (typeof f.density !== 'number' || !isFinite(f.density) || f.density < 0 || f.density > 100) return 'ランダム充填の密度が不正です';
    if (!Array.isArray(f.weights) || f.weights.length !== 4 || f.weights.some(function (w) { return typeof w !== 'number' || !isFinite(w) || w < 0; })) return 'ランダム充填の色配分が不正です';
    if (f.seed != null && !Number.isSafeInteger(f.seed)) return 'ランダム充填の種が不正です';
    if (f.keep !== 'keep' && f.keep !== 'clear') return 'ランダム充填の既存の塗りの扱いが不正です';
    if (f.densityGradient != null && DENSITY_GRADIENTS.indexOf(f.densityGradient) === -1) return '密度の勾配の指定が不正です';
    // ゴールとロードマップv5 M4「規則で描くの一般化」で追加した項目（すべて任意項目。
    // 旧v9以前の保存にはfill.ruleが無い＝migrateParamsV9toV10が'random'を補ってから渡す）
    if (f.rule != null && FILL_RULES.indexOf(f.rule) === -1) return '規則の指定が不正です';
    if (f.seq != null) {
      var seq = f.seq;
      if (typeof seq !== 'object' || Array.isArray(seq)) return '数列の指定が不正です';
      if (seq.order != null && SEQ_ORDERS.indexOf(seq.order) === -1) return '数列の走査順が不正です';
      if (seq.ruleKind != null && SEQ_RULE_KINDS.indexOf(seq.ruleKind) === -1) return '数列の規則が不正です';
      if (seq.colorMode != null && SEQ_COLOR_MODES.indexOf(seq.colorMode) === -1) return '数列の色の決め方が不正です';
      if (seq.period != null && (typeof seq.period !== 'number' || !isFinite(seq.period) || seq.period < 1)) return '数列の周期が不正です';
      if (seq.phase != null && (typeof seq.phase !== 'number' || !isFinite(seq.phase))) return '数列の位相が不正です';
    }
    if (f.field != null) {
      var fld = f.field;
      if (typeof fld !== 'object' || Array.isArray(fld)) return '距離場の指定が不正です';
      if (fld.ref != null && FIELD_REFS.indexOf(fld.ref) === -1) return '距離場の基準が不正です';
      if (fld.waveKind != null && FIELD_WAVES.indexOf(fld.waveKind) === -1) return '距離場の波形が不正です';
      if (fld.points != null) {
        if (!Array.isArray(fld.points) || fld.points.length > 3) return '距離場の点の指定が不正です';
        for (var pi = 0; pi < fld.points.length; pi++) {
          var pt = fld.points[pi];
          if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number' || !isFinite(pt.x) || !isFinite(pt.y)) return '距離場の点の指定が不正です';
        }
      }
    }
    if (f.noise != null) {
      var ns = f.noise;
      if (typeof ns !== 'object' || Array.isArray(ns)) return 'ノイズの指定が不正です';
      if (ns.colorMode != null && NOISE_COLOR_MODES.indexOf(ns.colorMode) === -1) return 'ノイズの色の決め方が不正です';
      if (ns.octaves != null && (!Number.isInteger(ns.octaves) || ns.octaves < 1 || ns.octaves > 3)) return 'ノイズのオクターブが不正です';
      if (ns.frequency != null && (typeof ns.frequency !== 'number' || !isFinite(ns.frequency) || ns.frequency <= 0)) return 'ノイズの周波数が不正です';
      if (ns.threshold != null && (typeof ns.threshold !== 'number' || !isFinite(ns.threshold) || ns.threshold < 0 || ns.threshold > 100)) return 'ノイズのしきい値が不正です';
    }
    if (f.symmetry != null) {
      var sym = f.symmetry;
      if (typeof sym !== 'object' || Array.isArray(sym)) return '対称展開の指定が不正です';
      if (sym.group != null && SYMMETRY_GROUPS.indexOf(sym.group) === -1) return '対称展開の群が不正です';
    }
    return true;
  }

  /* ============================================================
   * 14. 六角形格子（仕様v4 段G「六角形ガイド」）— 11章(正三角格子)の座標系をそのまま使う。
   *   六角形＝1つの格子点(横線Lのj番目)を中心に、その周りの6枚の三角(hexagonCells60が返す
   *   集合)をひとまとめにしたもの。cellsは「六角形の中心点」単位(Map<'L,j', 色番号>)で持つ。
   *   版面の端で6枚に満たない位置には置けない（isFullHexCenter＝false）。
   *   隣接（＝辺を共有する）六角形は、中心(L,j)から見て距離√3・UNITの6方向にある。この
   *   6方向は、6枚の三角の"外周"の辺（放射状の内側の辺はcancelEdgesで自ら相殺して消える）の
   *   中点をはさんで中心を鏡映した点として求める（neighborsHex）。三角格子の頂点は3系統
   *   （互いに重ならない3通りのハニカム敷き詰め）に分かれ、neighborsHexは常に同じ系統だけを
   *   たどる（=辺を共有する本当の隣接だけを返す。距離UNITしか離れていない"隣の格子点"は
   *   三角を共有してしまうため隣接扱いにしない）。
   *   融合は6枚の三角の辺をそのままcancelEdges/buildLoopsに流す: 同じ六角形の中の放射状の
   *   辺(6本)は隣り合う三角どうしで自動的に相殺し、隣接する同色の六角形どうしは共有する
   *   外周の1辺がさらに相殺して1つの輪郭にまとまる（隣接2六角形→10頂点の1ループ）。
   * ============================================================ */
  function createGridHex(n) { return { n: n, m: tri60Rows(n), cells: new Map() }; }
  function hexKey(L, j) { return L + ',' + j; }
  function getHex(grid, L, j) { var v = grid.cells.get(hexKey(L, j)); return v == null ? null : v; }
  function setHex(grid, L, j, color) {
    var k = hexKey(L, j);
    if (color == null) grid.cells.delete(k); else grid.cells.set(k, color);
  }
  function cellsToObjectHex(grid) {
    var o = {};
    grid.cells.forEach(function (color, key) { o[key] = color; });
    return o;
  }
  function gridFromCellsHex(n, obj) {
    var g = createGridHex(n);
    if (obj) for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) g.cells.set(k, obj[k]);
    return g;
  }
  // 格子点(L,j)を中心にした六角形を作る三角の一覧（版面の端では6枚未満。hexagonCells60を
  // 「セルを持たないただの境界情報(n,m)」に対して呼ぶだけなので生きたgridは要らない）
  function hexCenterTriangles(n, L, j) {
    var m = tri60Rows(n);
    var p = tri60Line(L, j);
    return hexagonCells60({ n: n, m: m }, { L: L, j: j, x: p.x, y: p.y });
  }
  // 版面内に6枚すべてが入る(＝端で欠けない)六角形の中心かどうか
  function isFullHexCenter(n, L, j) {
    var m = tri60Rows(n);
    if (L < 1 || L > m - 1) return false;
    var isInt = L % 2 === 0;
    var jMax = isInt ? n : n - 1;
    if (j < 0 || j > jMax) return false;
    return hexCenterTriangles(n, L, j).length === 6;
  }
  function isHexEmpty(grid, L, j) { return getHex(grid, L, j) == null; }
  // 実座標(x,y)に最も近い「置ける」六角形の中心を返す（ブラシ・ホバー予告に使う）
  function nearestHexCenter(n, x, y) {
    var m = tri60Rows(n);
    var guess = tri60NearestGridPoint({ n: n, m: m }, x, y);
    var best = null, bestD = Infinity;
    for (var dL = -2; dL <= 2; dL++) {
      var L = guess.L + dL;
      if (L < 0 || L > m) continue;
      var isInt = L % 2 === 0;
      var jGuess = isInt ? Math.round(x / UNIT) : Math.round(x / UNIT - 0.5);
      for (var dj = -3; dj <= 3; dj++) {
        var j = jGuess + dj;
        if (!isFullHexCenter(n, L, j)) continue;
        var p = tri60Line(L, j);
        var d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
        if (d < bestD) { bestD = d; best = { L: L, j: j, x: p.x, y: p.y }; }
      }
    }
    return best;
  }
  // 六角形(L,j)の輪郭＝外周6辺（放射状の内側の辺はcancelEdgesで自ら相殺して消える）
  function hexOuterEdges(n, L, j) {
    var tris = hexCenterTriangles(n, L, j);
    var edges = [];
    tris.forEach(function (t) {
      var v = tri60Corners(t.col, t.row, t.o);
      edges.push(edge(v[0], v[1]), edge(v[1], v[2]), edge(v[2], v[0]));
    });
    return cancelEdges(edges);
  }
  // 六角形(L,j)に隣接する(＝外周の1辺を共有する)六角形の中心一覧（版面の端では6枚未満）
  function neighborsHex(n, L, j) {
    var center = tri60Line(L, j);
    var outer = hexOuterEdges(n, L, j);
    var seen = {}, out = [];
    outer.forEach(function (e) {
      var mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2;
      var nx = 2 * mx - center.x, ny = 2 * my - center.y;
      var np = tri60PointFromVertex({ x: nx, y: ny });
      if (!isFullHexCenter(n, np.L, np.j)) return;
      var k = np.L + ',' + np.j;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ L: np.L, j: np.j });
    });
    return out;
  }

  /* ---- ミラー（左右・上下・両方。tri60と同じく4回回転は不可） ---- */
  function mirrorLRHex(grid, t) {
    var n = grid.n;
    var isInt = t.L % 2 === 0;
    var j2 = isInt ? (n - t.j) : (n - 1 - t.j);
    return { L: t.L, j: j2 };
  }
  function mirrorUDHex(grid, t) { return { L: grid.m - t.L, j: t.j }; }
  function mirrorPositionsHex(grid, mode, t) {
    var base = { L: t.L, j: t.j };
    var list = [base];
    if (mode === 'lr') list.push(mirrorLRHex(grid, base));
    else if (mode === 'ud') list.push(mirrorUDHex(grid, base));
    else if (mode === 'lr-ud') {
      var lr = mirrorLRHex(grid, base), ud = mirrorUDHex(grid, base), both = mirrorUDHex(grid, lr);
      list.push(lr, ud, both);
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      var k = p.L + ',' + p.j;
      if (!seen[k]) { seen[k] = 1; out.push(p); }
    });
    return out;
  }

  /* ---- 塗り／消しの入口（端で欠ける位置には置けない） ---- */
  function paintHex(grid, opts) {
    var positions = mirrorPositionsHex(grid, opts.mirror || 'none', { L: opts.L, j: opts.j });
    positions.forEach(function (p) {
      if (!isFullHexCenter(grid.n, p.L, p.j)) return;
      setHex(grid, p.L, p.j, opts.erase ? null : opts.color);
    });
    return grid;
  }

  /* ---- 融合（色ごとにpath化。6枚の三角の辺をcancelEdges/buildLoopsへそのまま流す） ---- */
  function collectEdgesForColorHex(grid, color, colorFn) {
    var edges = [];
    grid.cells.forEach(function (manual, key) {
      if (manual == null) return;
      var parts = key.split(','), L = +parts[0], j = +parts[1];
      var eff = colorFn ? colorFn({ kind: 'hex', L: L, j: j }, manual) : manual;
      if (eff !== color) return;
      hexCenterTriangles(grid.n, L, j).forEach(function (t) {
        var v = tri60Corners(t.col, t.row, t.o);
        edges.push(edge(v[0], v[1]), edge(v[1], v[2]), edge(v[2], v[0]));
      });
    });
    return edges;
  }
  function buildColorPathDHex(grid, color, opts) {
    var kept = cancelEdges(collectEdgesForColorHex(grid, color, opts && opts.colorFn));
    if (!kept.length) return null;
    var loops = buildLoops(kept).map(mergeCollinear);
    var round = opts && opts.round;
    if (round && round.mode && round.mode !== 'none') {
      loops = loops.map(function (loop) { return roundLoopCorners(loop, round.mode, round.radius); });
    }
    loops = loops.map(dropRedundantClose).filter(function (l) { return l.length > 0; });
    if (!loops.length) return null;
    return loops.map(function (loop) { return loopToPathD(loop, 2); }).join(' ');
  }
  function buildAllPathsHex(grid, colorCount, opts) {
    var out = [];
    for (var c = 1; c <= (colorCount || 4); c++) {
      var d = buildColorPathDHex(grid, c, opts);
      if (d) out.push({ color: c, d: d });
    }
    return out;
  }
  // 書き出しの形「要素ごとに分ける」（六角形格子版）: 1つの六角形(=三角6枚)が1要素・1path
  function buildExplodedPathsHex(grid, opts) {
    var out = [];
    var colorFn = opts && opts.colorFn;
    var round = opts && opts.round;
    grid.cells.forEach(function (manual, key) {
      if (manual == null) return;
      var parts = key.split(','), L = +parts[0], j = +parts[1];
      var eff = colorFn ? colorFn({ kind: 'hex', L: L, j: j }, manual) : manual;
      var edges = [];
      hexCenterTriangles(grid.n, L, j).forEach(function (t) {
        var v = tri60Corners(t.col, t.row, t.o);
        edges.push(edge(v[0], v[1]), edge(v[1], v[2]), edge(v[2], v[0]));
      });
      var d = finishExplodedPathD(edges, round, 2);
      if (d) out.push({ color: eff, d: d });
    });
    return out;
  }

  /* ---- 塗りつぶし（辺(＝隣接)を共有してつながる空の六角形を塗る） ---- */
  function floodFillHex(grid, startL, startJ, color) {
    if (!isFullHexCenter(grid.n, startL, startJ) || !isHexEmpty(grid, startL, startJ)) return 0;
    var visited = {};
    var stack = [{ L: startL, j: startJ }];
    var filled = [];
    while (stack.length) {
      var cur = stack.pop();
      var key = cur.L + ',' + cur.j;
      if (visited[key]) continue;
      visited[key] = true;
      if (!isFullHexCenter(grid.n, cur.L, cur.j) || !isHexEmpty(grid, cur.L, cur.j)) continue;
      filled.push(cur);
      neighborsHex(grid.n, cur.L, cur.j).forEach(function (nb) { stack.push(nb); });
    }
    filled.forEach(function (c) { setHex(grid, c.L, c.j, color); });
    return filled.length;
  }

  /* ---- 線ブラシ（六角形の中心を結ぶ3方向。隣接(neighborsHex)をたどって連続する帯にする） ---- */
  function lineCellsHex(grid, p0, p1) {
    var n = grid.n;
    var start = nearestHexCenter(n, p0.x, p0.y);
    if (!start) return { angle: null, cells: [] };
    var cells = [{ L: start.L, j: start.j }];
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) return { angle: 0, cells: cells };
    var targetAngle = Math.atan2(dy, dx);
    var startNeighbors = neighborsHex(n, start.L, start.j);
    if (!startNeighbors.length) return { angle: null, cells: cells };
    var bestVec = null, bestDiff = Infinity;
    startNeighbors.forEach(function (nb) {
      var p = tri60Line(nb.L, nb.j);
      var vx = p.x - start.x, vy = p.y - start.y;
      var ang = Math.atan2(vy, vx);
      var diff = Math.abs(((ang - targetAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (diff < bestDiff) { bestDiff = diff; bestVec = { x: vx, y: vy }; }
    });
    var seen = {}; seen[start.L + ',' + start.j] = 1;
    var cur = { L: start.L, j: start.j, x: start.x, y: start.y };
    var curVec = bestVec;
    var stepLen = Math.sqrt(curVec.x * curVec.x + curVec.y * curVec.y);
    var maxSteps = Math.ceil(dist / stepLen) + 2;
    for (var i = 0; i < maxSteps; i++) {
      var nbs = neighborsHex(n, cur.L, cur.j);
      var next = null, bd = Infinity;
      nbs.forEach(function (nb) {
        var key = nb.L + ',' + nb.j;
        if (seen[key]) return;
        var p = tri60Line(nb.L, nb.j);
        var vx = p.x - cur.x, vy = p.y - cur.y;
        var ang = Math.atan2(vy, vx), tAng = Math.atan2(curVec.y, curVec.x);
        var diff = Math.abs(((ang - tAng + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (diff < bd) { bd = diff; next = { L: nb.L, j: nb.j, x: p.x, y: p.y }; }
      });
      if (!next || bd > 0.35) break;
      var distFromP0 = Math.sqrt((next.x - p0.x) * (next.x - p0.x) + (next.y - p0.y) * (next.y - p0.y));
      seen[next.L + ',' + next.j] = 1;
      cells.push({ L: next.L, j: next.j });
      cur = next;
      if (distFromP0 >= dist - 1e-6) break;
    }
    var angleDeg = Math.round(((Math.atan2(bestVec.y, bestVec.x) * 180 / Math.PI) % 180 + 180) % 180);
    return { angle: angleDeg, cells: cells };
  }

  /* ---- ランダム充填（仕様v4 段F。hex格子の要素は六角形のみ） ---- */
  var HEX_FILL_ELEMENTS = ['hex'];
  // rect: {c0,r0,c1,r1}（c=j＝横方向の番地、r=L＝横線の番地。範囲外・欠ける位置は自然にスキップする）
  function randomFillHex(grid, rect, opts) {
    var allowed = (opts.elements || []).filter(function (e) { return HEX_FILL_ELEMENTS.indexOf(e) !== -1; });
    if (!allowed.length) return { filled: 0 };
    var rng = makeFillRng(opts.seed);
    var density = Math.max(0, Math.min(100, opts.density || 0)) / 100;
    var gradient = opts.densityGradient || 'none';
    var weights = normalizeFillWeights(opts.weights);
    var filled = 0;
    for (var L = rect.r0; L <= rect.r1; L++) {
      for (var j = rect.c0; j <= rect.c1; j++) {
        if (!isFullHexCenter(grid.n, L, j)) continue;
        var localDensity = density * densityGradientFactor(gradient, rectNorm01(j, rect.c0, rect.c1), rectNorm01(L, rect.r0, rect.r1));
        if (rng() >= localDensity) continue;
        var color = pickWeightedColor(rng, weights);
        paintHex(grid, { L: L, j: j, color: color, mirror: opts.mirror });
        filled++;
      }
    }
    return { filled: filled };
  }

  // 六角形格子のcellsのvalidate（キーは"L,j"＝正方形のcellsと同じ形式だが、値は色番号そのもの＝tri60のcellsと同じ）
  function validateCellsHexObject(cells) {
    if (cells == null) return true;
    if (typeof cells !== 'object' || Array.isArray(cells)) return '六角形格子のマスの内容が不正です';
    for (var key in cells) {
      if (!Object.prototype.hasOwnProperty.call(cells, key)) continue;
      if (!/^\d+,\d+$/.test(key)) return '六角形格子のマスの位置が不正です';
      var v = cells[key];
      if (!Number.isInteger(v) || v < 1 || v > 4) return '六角形格子の色番号が不正です';
    }
    return true;
  }
  // v6→v7（仕様v4 段G「六角形ガイド」）: レイヤーの格子種にhexが増えるだけで構造変更は無いため、
  // paramsの形はそのまま・版だけを上げる（validateLayerがlattice==='hex'を新たに認める）
  function migrateParamsV6toV7(params) { return Object.assign({}, params); }

  /* ============================================================
   * 15. 汎用格子（LatticeDef。仕様v4 段H「格子定義の形式と正八角形＋正方形」）—
   *   square/tri60/hexは書き換えず、宣言的な定義から盤面を組み立てる新経路として追加する。
   *   LatticeDef = { id, name, period:{ax,ay,bx,by}（単位胞の2ベクトル・実座標）,
   *                  originOffset?:{x,y}（単位胞(0,0)の原点を版面座標のどこに置くか。省略時{0,0}）,
   *                  tiles:[{id, dir?, poly:[[x,y]...]（単位胞ローカル座標・時計回り）] }。
   *   タイルの実体は{u,v,tileId}（単位胞インデックス＋タイル番号）。cellsはMap<'u,v,tileId', 色番号>。
   *   版面内に完全に入るタイルだけを総当たりで列挙し（単位胞をu,vへ広めに敷いて外接判定する）、
   *   その一覧（grid.tiles）・実座標（grid.polyByKey）・辺の共有関係（grid.edgeMap）・
   *   重心の逆引き（grid.centroidIndex、ミラー写像に使う）を createGridGeneric 時に1回だけ作る。
   *   融合（辺の相殺→ループ化）は既存のcancelEdges/buildLoopsをそのまま実座標で使う。
   * ============================================================ */
  var GENERIC_EPS = 1e-6;
  function genericPtKey(p) { return (Math.round(p.x * 1e6) / 1e6) + ',' + (Math.round(p.y * 1e6) / 1e6); }
  function genericEdgeKey(a, b) {
    var ka = genericPtKey(a), kb = genericPtKey(b);
    return ka < kb ? ka + '|' + kb : kb + '|' + ka;
  }
  function genericTileKey(u, v, tileId) { return u + ',' + v + ',' + tileId; }

  // 正八角形＋正方形（4.8.8タイリング）: 単位胞は正方形1個ぶん（周期p=UNIT）。
  // 八角形は中心(0,0)・辺長 s=UNIT/(1+√2)。正方形（45°回転したひし形）は
  // 中心(p/2,p/2)・中心から頂点までの距離 t=s/√2（000_README.md 段H の幾何）。
  var OCT_SQUARE_S = UNIT / (1 + Math.SQRT2);
  function octSquareTileDefs() {
    var s = OCT_SQUARE_S, p = UNIT, t = s / Math.SQRT2;
    var oct = [
      [-s / 2, -p / 2], [s / 2, -p / 2], [p / 2, -s / 2], [p / 2, s / 2],
      [s / 2, p / 2], [-s / 2, p / 2], [-p / 2, s / 2], [-p / 2, -s / 2]
    ];
    var sq = [
      [p / 2, p / 2 - t], [p / 2 + t, p / 2], [p / 2, p / 2 + t], [p / 2 - t, p / 2]
    ];
    return [
      { id: 'oct', dir: 'oct', poly: oct },
      { id: 'sq', dir: 'sq', poly: sq }
    ];
  }
  /* 出典: 149_格子の編集/core.js の PRESETS（cairoTiles/rhombilleTiles/brickTiles、
   * 2026-09-14 M5「格子の編集」で導出）をそのまま値コピーしたもの。id/name/tiles[].id/dirは
   * lattice-labの出典（PRESETS['cairo']・['rhombille']・['brick']）と一致させ、
   * tri-gridのLATTICE_DEFSキー（generic経路のlattice）として使う。
   * カイロ五角形（Cairo pentagonal tiling）の導出（lattice-lab/core.js cairoTiles()のコメントより）:
   *   五角形の内角は120°,90°,120°,90°,120°。等しい4辺の長さをL、残る1辺（底辺）はL(√3−1)。
   *   直角の頂点V4を原点に置くと5頂点が決まり、V4のまわりで−90°ずつ回した4枚が原点で直角4つを作る。
   *   並進格子はL(√3,√3)とL(√3,−√3)で、これを−45°回すと軸に平行な1辺L√6の正方形になるので
   *   その向きで持つ（単位胞は1辺2×UNITの正方形）。
   */
  function cairoTileDefs() {
    var cell = 2 * UNIT; // 単位胞は1辺20の正方形
    var L = cell / Math.sqrt(6);
    var base = [
      [-(2 * SQRT3 - 1) / 2, -SQRT3 / 2],
      [-SQRT3, 0],
      [-SQRT3 / 2, 0.5],
      [0, 0],
      [-0.5, -SQRT3 / 2]
    ].map(function (p) { return [p[0] * L, p[1] * L]; });
    function rot45(p) { return [(p[0] + p[1]) / Math.SQRT2, (p[1] - p[0]) / Math.SQRT2]; }
    function rot90(p) { return [p[1], -p[0]]; }
    var p0 = base.map(rot45);
    var names = ['cairo-a', 'cairo-b', 'cairo-c', 'cairo-d'];
    var out = [], cur = p0;
    for (var k = 0; k < 4; k++) {
      out.push({ id: names[k], dir: names[k], poly: cur.map(function (q) { return [round6(q[0]), round6(q[1])]; }) });
      cur = cur.map(rot90);
    }
    return { tiles: out, cell: cell };
  }
  function round6(v) { var r = Math.round(v * 1e6) / 1e6; return r === 0 ? 0 : r; }
  /* rhombille（60°のひし形3枚が正六角形をつくる。lattice-lab/core.js rhombilleTiles()のコメントより）:
   *   1辺sの正六角形の中心Oと頂点H0…H5（角度0°,60°,…）。[O,H0,H1,H2][O,H2,H3,H4][O,H4,H5,H0]の
   *   3枚がそれぞれ60°/120°のひし形になる。
   */
  function rhombilleTileDefs() {
    var s = UNIT, h = round6(s * SQRT3 / 2);
    var H = [];
    for (var i = 0; i < 6; i++) {
      var a = i * Math.PI / 3;
      H.push([round6(s * Math.cos(a)), round6(s * Math.sin(a))]);
    }
    var O = [0, 0];
    var names = ['rh-0', 'rh-60', 'rh-120'];
    var out = [];
    for (var j = 0; j < 3; j++) {
      out.push({ id: names[j], dir: names[j], poly: [O, H[2 * j], H[2 * j + 1], H[(2 * j + 2) % 6]] });
    }
    return { tiles: out, h: h };
  }
  /* レンガ（半枚ずらして積む長方形。lattice-lab/core.js brickTiles()のコメントより）:
   *   長辺の途中（真ん中）にも頂点を置く。置かないと上下の段とは辺が半分ずつしか重ならず、
   *   「辺を共有する隣」を辺の一致で探す経路（線・塗りつぶし）で上下がつながらない。
   */
  function brickTileDefs() {
    var w = 2 * UNIT, h = UNIT;
    return [{ id: 'brick', dir: 'brick', poly: [[0, 0], [w / 2, 0], [w, 0], [w, h], [w / 2, h], [0, h]] }];
  }
  var LATTICE_DEFS = (function () {
    var cairo = cairoTileDefs();
    var rhomb = rhombilleTileDefs();
    return {
      'oct-square': {
        id: 'oct-square', name: '正八角形＋正方形',
        period: { ax: UNIT, ay: 0, bx: 0, by: UNIT },
        originOffset: { x: UNIT / 2, y: UNIT / 2 },
        tiles: octSquareTileDefs()
      },
      'cairo': {
        id: 'cairo', name: 'カイロ五角形',
        period: { ax: cairo.cell, ay: 0, bx: 0, by: cairo.cell },
        originOffset: { x: cairo.cell / 2, y: cairo.cell / 2 },
        tiles: cairo.tiles
      },
      'rhombille': {
        id: 'rhombille', name: 'ひし形3方向（rhombille）',
        period: { ax: 1.5 * UNIT, ay: rhomb.h, bx: 0, by: round6(UNIT * SQRT3) },
        originOffset: { x: UNIT, y: rhomb.h },
        tiles: rhomb.tiles
      },
      'brick': {
        id: 'brick', name: 'レンガ',
        period: { ax: 2 * UNIT, ay: 0, bx: UNIT, by: UNIT },
        originOffset: { x: 0, y: 0 },
        tiles: brickTileDefs()
      }
    };
  })();
  var GENERIC_LATTICE_IDS = Object.keys(LATTICE_DEFS);
  function getLatticeDef(defId) { return LATTICE_DEFS[defId] || null; }
  function isGenericLattice(lattice) { return GENERIC_LATTICE_IDS.indexOf(lattice) !== -1; }
  // タイル多角形の符号つき面積（shoelace）。validateLatticeDefだけで使う軽量ヘルパ
  function latticeShoelaceArea(poly) {
    var s = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }
  // 格子の編集が書き出すLatticeDef JSON（「格子の定義（JSON）を読む」）と、封筒のparams.customLatticesの
  // 両方に使う検証（lattice-lab/core.js validateDefと同じ観点。trueまたはエラー文言を返す）
  function validateLatticeDef(def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return '格子定義がオブジェクトではありません';
    if (typeof def.id !== 'string' || !def.id) return '格子定義のidが空です';
    if (typeof def.name !== 'string' || !def.name) return '格子定義のnameが空です';
    var p = def.period;
    if (!p || typeof p !== 'object') return '格子定義のperiodがありません';
    var ks = ['ax', 'ay', 'bx', 'by'];
    for (var i = 0; i < ks.length; i++) if (!Number.isFinite(p[ks[i]])) return '格子定義のperiod.' + ks[i] + ' が数値ではありません';
    if (Math.abs(p.ax * p.by - p.ay * p.bx) < 1e-6) return '格子定義の周期ベクトルa・bが平行です（単位胞の面積が0）';
    if (def.originOffset != null) {
      if (typeof def.originOffset !== 'object' || !Number.isFinite(def.originOffset.x) || !Number.isFinite(def.originOffset.y)) return '格子定義のoriginOffsetが数値の組ではありません';
    }
    if (!Array.isArray(def.tiles) || !def.tiles.length) return '格子定義にタイルが1枚もありません';
    var seen = {};
    for (var j = 0; j < def.tiles.length; j++) {
      var t = def.tiles[j];
      if (!t || typeof t.id !== 'string' || !t.id) return '格子定義のタイル' + (j + 1) + ' のidが空です';
      if (seen[t.id]) return '格子定義のタイルidが重複しています: ' + t.id;
      seen[t.id] = 1;
      if (t.dir != null && typeof t.dir !== 'string') return '格子定義のタイル' + (j + 1) + ' のdirが文字列ではありません';
      if (!Array.isArray(t.poly) || t.poly.length < 3) return '格子定義のタイル' + (j + 1) + ' のpolyの頂点が3つ未満です';
      for (var k = 0; k < t.poly.length; k++) {
        var q = t.poly[k];
        if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return '格子定義のタイル' + (j + 1) + ' のpolyに数値でない座標があります';
      }
      if (latticeShoelaceArea(t.poly) < 1e-9) return '格子定義のタイル' + (j + 1) + ' の面積が0です';
    }
    return true;
  }
  // 検証を通ったLatticeDefをLATTICE_DEFSへ登録する（「格子の定義（JSON）を読む」・封筒の復元で使う）。
  // 既存id（oct-square等の組み込みも含む）と同じidなら上書きする。trueまたはエラー文言を返す
  function registerLatticeDef(def) {
    var err = validateLatticeDef(def);
    if (err !== true) return err;
    LATTICE_DEFS[def.id] = def;
    if (GENERIC_LATTICE_IDS.indexOf(def.id) === -1) GENERIC_LATTICE_IDS.push(def.id);
    GENERIC_FILL_ELEMENTS_BY_DEF[def.id] = def.tiles.map(function (t) { return t.id; });
    return true;
  }

  function unitCellOrigin(def, u, v) {
    var off = def.originOffset || { x: 0, y: 0 };
    return { x: u * def.period.ax + v * def.period.bx + off.x, y: u * def.period.ay + v * def.period.by + off.y };
  }
  function tileAbsPoly(def, tile, origin) {
    return tile.poly.map(function (p) { return { x: origin.x + p[0], y: origin.y + p[1] }; });
  }
  // 版面の幅・高さ（n=幅方向の単位胞数×UNIT。高さは周期bの長さからほぼ同じ比になる行数）
  function genericBoardSize(def, n) {
    var W = n * UNIT;
    var bLen = Math.sqrt(def.period.bx * def.period.bx + def.period.by * def.period.by);
    var rows = Math.max(1, Math.round(W / bLen));
    return { W: W, H: rows * bLen, rows: rows };
  }
  // 版面内に完全に入るタイルだけを列挙する（単位胞(u,v)を総当たりし、そのタイルの全頂点が
  // [0,W]×[0,H]に収まるものだけ残す。端で欠けるタイルは自然に除外される）
  function enumerateGenericTiles(defId, n) {
    var def = getLatticeDef(defId);
    var empty = { def: def, board: null, tiles: [], polyByKey: {}, edgeMap: {}, centroidByKey: {}, centroidIndex: {}, tileDefs: {} };
    if (!def) return empty;
    var board = genericBoardSize(def, n);
    var margin = 3;
    var tiles = [], polyByKey = {}, edgeMap = {}, centroidByKey = {}, centroidIndex = {}, tileDefs = {};
    def.tiles.forEach(function (t) { tileDefs[t.id] = t; });
    for (var u = -margin; u <= n + margin; u++) {
      for (var v = -margin; v <= board.rows + margin; v++) {
        var origin = unitCellOrigin(def, u, v);
        def.tiles.forEach(function (tile) {
          var poly = tileAbsPoly(def, tile, origin);
          var fits = poly.every(function (p) {
            return p.x >= -GENERIC_EPS && p.x <= board.W + GENERIC_EPS && p.y >= -GENERIC_EPS && p.y <= board.H + GENERIC_EPS;
          });
          if (!fits) return;
          var key = genericTileKey(u, v, tile.id);
          tiles.push({ u: u, v: v, tileId: tile.id, dir: tile.dir });
          polyByKey[key] = poly;
          var cx = 0, cy = 0;
          poly.forEach(function (p) { cx += p.x; cy += p.y; });
          var centroid = { x: cx / poly.length, y: cy / poly.length };
          centroidByKey[key] = centroid;
          centroidIndex[genericPtKey(centroid)] = key;
          for (var i = 0; i < poly.length; i++) {
            var a = poly[i], b = poly[(i + 1) % poly.length];
            var ek = genericEdgeKey(a, b);
            if (!edgeMap[ek]) edgeMap[ek] = [];
            edgeMap[ek].push(key);
          }
        });
      }
    }
    return { def: def, board: board, tiles: tiles, polyByKey: polyByKey, edgeMap: edgeMap, centroidByKey: centroidByKey, centroidIndex: centroidIndex, tileDefs: tileDefs };
  }
  function createGridGeneric(defId, n) {
    var idx = enumerateGenericTiles(defId, n);
    return {
      n: n, defId: defId, def: idx.def, board: idx.board, tiles: idx.tiles,
      polyByKey: idx.polyByKey, edgeMap: idx.edgeMap, centroidByKey: idx.centroidByKey,
      centroidIndex: idx.centroidIndex, tileDefs: idx.tileDefs, cells: new Map()
    };
  }
  function getGeneric(grid, u, v, tileId) { var k = genericTileKey(u, v, tileId); return grid.cells.has(k) ? grid.cells.get(k) : null; }
  function setGeneric(grid, u, v, tileId, color) {
    var k = genericTileKey(u, v, tileId);
    if (color == null) grid.cells.delete(k); else grid.cells.set(k, color);
  }
  function isGenericTileValid(grid, u, v, tileId) { return !!grid.polyByKey[genericTileKey(u, v, tileId)]; }
  function cellsToObjectGeneric(grid) {
    var o = {};
    grid.cells.forEach(function (color, key) { o[key] = color; });
    return o;
  }
  function gridFromCellsGeneric(defId, n, obj) {
    var g = createGridGeneric(defId, n);
    if (obj) for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) if (g.polyByKey[k] != null) g.cells.set(k, obj[k]);
    return g;
  }
  function tileVertices(grid, ref) { return grid.polyByKey[genericTileKey(ref.u, ref.v, ref.tileId)] || null; }
  // 辺を共有するタイルを、辺の一致（実座標を1e-6で丸めたキー）から求める（総当たりせずedgeMap参照）
  function neighborsGeneric(grid, ref) {
    var poly = tileVertices(grid, ref);
    if (!poly) return [];
    var selfKey = genericTileKey(ref.u, ref.v, ref.tileId);
    var out = [], seen = {};
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var ek = genericEdgeKey(a, b);
      (grid.edgeMap[ek] || []).forEach(function (k) {
        if (k === selfKey || seen[k]) return;
        seen[k] = 1;
        var parts = k.split(','); out.push({ u: +parts[0], v: +parts[1], tileId: parts[2] });
      });
    }
    return out;
  }
  // ミラー（実座標反射→版面内タイルへ一致検索。写らないものは捨てる＝000_README.md 段H）
  function mirrorLRGeneric(grid, ref) {
    var c = grid.centroidByKey[genericTileKey(ref.u, ref.v, ref.tileId)];
    if (!c) return null;
    var k = grid.centroidIndex[genericPtKey({ x: grid.board.W - c.x, y: c.y })];
    if (!k) return null;
    var parts = k.split(','); return { u: +parts[0], v: +parts[1], tileId: parts[2] };
  }
  function mirrorUDGeneric(grid, ref) {
    var c = grid.centroidByKey[genericTileKey(ref.u, ref.v, ref.tileId)];
    if (!c) return null;
    var k = grid.centroidIndex[genericPtKey({ x: c.x, y: grid.board.H - c.y })];
    if (!k) return null;
    var parts = k.split(','); return { u: +parts[0], v: +parts[1], tileId: parts[2] };
  }
  function mirrorPositionsGeneric(grid, mode, ref) {
    var base = { u: ref.u, v: ref.v, tileId: ref.tileId };
    var list = [base];
    if (mode === 'lr') { var lr0 = mirrorLRGeneric(grid, base); if (lr0) list.push(lr0); }
    else if (mode === 'ud') { var ud0 = mirrorUDGeneric(grid, base); if (ud0) list.push(ud0); }
    else if (mode === 'lr-ud') {
      var lr = mirrorLRGeneric(grid, base), ud = mirrorUDGeneric(grid, base);
      if (lr) list.push(lr);
      if (ud) list.push(ud);
      if (lr) { var both = mirrorUDGeneric(grid, lr); if (both) list.push(both); }
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      var k = p.u + ',' + p.v + ',' + p.tileId;
      if (!seen[k]) { seen[k] = 1; out.push(p); }
    });
    return out;
  }
  function paintGeneric(grid, opts) {
    var positions = mirrorPositionsGeneric(grid, opts.mirror || 'none', { u: opts.u, v: opts.v, tileId: opts.tileId });
    positions.forEach(function (p) {
      if (!isGenericTileValid(grid, p.u, p.v, p.tileId)) return;
      setGeneric(grid, p.u, p.v, p.tileId, opts.erase ? null : opts.color);
    });
    return grid;
  }
  /* ---- 融合（色ごとにpath化。タイルの辺をそのままcancelEdges/buildLoopsへ流す） ---- */
  function collectEdgesGeneric(grid, color, colorFn) {
    var edges = [];
    grid.cells.forEach(function (manual, key) {
      if (manual == null) return;
      var parts = key.split(','), u = +parts[0], v = +parts[1], tileId = parts[2];
      var poly = grid.polyByKey[key];
      if (!poly) return;
      var tdef = grid.tileDefs[tileId];
      var eff = colorFn ? colorFn({ kind: 'generic', u: u, v: v, tileId: tileId, dir: tdef && tdef.dir }, manual) : manual;
      if (eff !== color) return;
      for (var i = 0; i < poly.length; i++) edges.push(edge(poly[i], poly[(i + 1) % poly.length]));
    });
    return edges;
  }
  function buildColorPathDGeneric(grid, color, opts) {
    var kept = cancelEdges(collectEdgesGeneric(grid, color, opts && opts.colorFn));
    if (!kept.length) return null;
    var loops = buildLoops(kept).map(mergeCollinear);
    var round = opts && opts.round;
    if (round && round.mode && round.mode !== 'none') {
      loops = loops.map(function (loop) { return roundLoopCorners(loop, round.mode, round.radius); });
    }
    loops = loops.map(dropRedundantClose).filter(function (l) { return l.length > 0; });
    if (!loops.length) return null;
    return loops.map(function (loop) { return loopToPathD(loop, 2); }).join(' ');
  }
  function buildAllPathsGeneric(grid, colorCount, opts) {
    var out = [];
    for (var c = 1; c <= (colorCount || 4); c++) {
      var d = buildColorPathDGeneric(grid, c, opts);
      if (d) out.push({ color: c, d: d });
    }
    return out;
  }
  // 書き出しの形「要素ごとに分ける」（汎用格子=LatticeDef版。カイロ五角形/rhombille/レンガ/
  // 正八角形＋正方形/読み込んだ格子に共通）: 1タイル(u,v,tileId)が1要素・1path
  function buildExplodedPathsGeneric(grid, opts) {
    var out = [];
    var colorFn = opts && opts.colorFn;
    var round = opts && opts.round;
    grid.cells.forEach(function (manual, key) {
      if (manual == null) return;
      var parts = key.split(','), u = +parts[0], v = +parts[1], tileId = parts[2];
      var poly = grid.polyByKey[key];
      if (!poly) return;
      var tdef = grid.tileDefs[tileId];
      var eff = colorFn ? colorFn({ kind: 'generic', u: u, v: v, tileId: tileId, dir: tdef && tdef.dir }, manual) : manual;
      var edges = [];
      for (var i = 0; i < poly.length; i++) edges.push(edge(poly[i], poly[(i + 1) % poly.length]));
      var d = finishExplodedPathD(edges, round, 2);
      if (d) out.push({ color: eff, d: d });
    });
    return out;
  }
  /* ---- 塗りつぶし（辺(=neighborsGeneric)を共有してつながる空きタイルを塗る） ---- */
  function isGenericEmpty(grid, u, v, tileId) {
    if (!isGenericTileValid(grid, u, v, tileId)) return false;
    return getGeneric(grid, u, v, tileId) == null;
  }
  function floodFillGeneric(grid, startU, startV, startTileId, color) {
    if (!isGenericEmpty(grid, startU, startV, startTileId)) return 0;
    var visited = {};
    var stack = [{ u: startU, v: startV, tileId: startTileId }];
    var filled = [];
    while (stack.length) {
      var cur = stack.pop();
      var key = genericTileKey(cur.u, cur.v, cur.tileId);
      if (visited[key]) continue;
      visited[key] = true;
      if (!isGenericEmpty(grid, cur.u, cur.v, cur.tileId)) continue;
      filled.push(cur);
      neighborsGeneric(grid, cur).forEach(function (nb) { stack.push(nb); });
    }
    filled.forEach(function (t) { setGeneric(grid, t.u, t.v, t.tileId, color); });
    return filled.length;
  }
  /* ---- 点あたり判定・線ブラシ（隣接タイルの中心を結ぶ帯。方向は隣接ベクトルから決める） ---- */
  function pointInPolygonGeneric(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      var hit = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  function genericUnitCellGuess(def, x, y) {
    var ax = def.period.ax, ay = def.period.ay, bx = def.period.bx, by = def.period.by;
    var off = def.originOffset || { x: 0, y: 0 };
    var lx = x - off.x, ly = y - off.y;
    var det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-9) return { u: 0, v: 0 };
    return { u: Math.round((lx * by - ly * bx) / det), v: Math.round((ax * ly - ay * lx) / det) };
  }
  function genericTileAt(grid, x, y) {
    var p = { x: x, y: y };
    var guess = genericUnitCellGuess(grid.def, x, y);
    var tileIds = grid.def.tiles.map(function (t) { return t.id; });
    for (var du = -2; du <= 2; du++) {
      for (var dv = -2; dv <= 2; dv++) {
        var u = guess.u + du, v = guess.v + dv;
        for (var ti = 0; ti < tileIds.length; ti++) {
          var key = genericTileKey(u, v, tileIds[ti]);
          var poly = grid.polyByKey[key];
          if (poly && pointInPolygonGeneric(p, poly)) return { u: u, v: v, tileId: tileIds[ti] };
        }
      }
    }
    for (var key2 in grid.polyByKey) {
      if (pointInPolygonGeneric(p, grid.polyByKey[key2])) {
        var parts = key2.split(','); return { u: +parts[0], v: +parts[1], tileId: parts[2] };
      }
    }
    return null;
  }
  function lineCellsGeneric(grid, p0, p1) {
    var start = genericTileAt(grid, p0.x, p0.y);
    if (!start) return { angle: null, cells: [] };
    var cells = [{ u: start.u, v: start.v, tileId: start.tileId }];
    var dx = p1.x - p0.x, dy = p1.y - p0.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) return { angle: 0, cells: cells };
    var targetAngle = Math.atan2(dy, dx);
    var c0 = grid.centroidByKey[genericTileKey(start.u, start.v, start.tileId)];
    var startNeighbors = neighborsGeneric(grid, start);
    if (!startNeighbors.length) return { angle: null, cells: cells };
    var bestVec = null, bestDiff = Infinity;
    startNeighbors.forEach(function (nb) {
      var c = grid.centroidByKey[genericTileKey(nb.u, nb.v, nb.tileId)];
      var vx = c.x - c0.x, vy = c.y - c0.y;
      var ang = Math.atan2(vy, vx);
      var diff = Math.abs(((ang - targetAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (diff < bestDiff) { bestDiff = diff; bestVec = { x: vx, y: vy }; }
    });
    var seen = {}; seen[genericTileKey(start.u, start.v, start.tileId)] = 1;
    var cur = { u: start.u, v: start.v, tileId: start.tileId, x: c0.x, y: c0.y };
    var curVec = bestVec;
    var stepLen = Math.sqrt(curVec.x * curVec.x + curVec.y * curVec.y) || 1;
    var maxSteps = Math.ceil(dist / stepLen) + 4;
    for (var i = 0; i < maxSteps; i++) {
      var nbs = neighborsGeneric(grid, cur);
      var next = null, bd = Infinity;
      nbs.forEach(function (nb) {
        var key = genericTileKey(nb.u, nb.v, nb.tileId);
        if (seen[key]) return;
        var c = grid.centroidByKey[key];
        var vx = c.x - cur.x, vy = c.y - cur.y;
        var ang = Math.atan2(vy, vx), tAng = Math.atan2(curVec.y, curVec.x);
        var diff = Math.abs(((ang - tAng + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (diff < bd) { bd = diff; next = { u: nb.u, v: nb.v, tileId: nb.tileId, x: c.x, y: c.y }; }
      });
      if (!next || bd > 0.5) break;
      var distFromP0 = Math.sqrt((next.x - p0.x) * (next.x - p0.x) + (next.y - p0.y) * (next.y - p0.y));
      seen[genericTileKey(next.u, next.v, next.tileId)] = 1;
      cells.push({ u: next.u, v: next.v, tileId: next.tileId });
      cur = next;
      if (distFromP0 >= dist - 1e-6) break;
    }
    var angleDeg = Math.round(((Math.atan2(bestVec.y, bestVec.x) * 180 / Math.PI) % 180 + 180) % 180);
    return { angle: angleDeg, cells: cells };
  }
  /* ---- ランダム充填（要素＝タイル種のid。候補は版面内の該当タイル全部を(u,v,tileId)順に並べ、
     1件ごとにrng()を1回引いて密度と比較する＝000_README.md 段F と同じ決定性の作り） ---- */
  var GENERIC_FILL_ELEMENTS_BY_DEF = {
    'oct-square': ['oct', 'sq'],
    'cairo': ['cairo-a', 'cairo-b', 'cairo-c', 'cairo-d'],
    'rhombille': ['rh-0', 'rh-60', 'rh-120'],
    'brick': ['brick']
  };
  function randomFillGeneric(grid, rect, opts) {
    var allowedAll = GENERIC_FILL_ELEMENTS_BY_DEF[grid.defId] || [];
    var allowed = (opts.elements || []).filter(function (e) { return allowedAll.indexOf(e) !== -1; });
    if (!allowed.length) return { filled: 0 };
    var candidates = grid.tiles.filter(function (t) {
      return allowed.indexOf(t.tileId) !== -1 && t.u >= rect.u0 && t.u <= rect.u1 && t.v >= rect.v0 && t.v <= rect.v1;
    }).slice().sort(function (a, b) { return (a.u - b.u) || (a.v - b.v) || (a.tileId < b.tileId ? -1 : 1); });
    var rng = makeFillRng(opts.seed);
    var density = Math.max(0, Math.min(100, opts.density || 0)) / 100;
    var gradient = opts.densityGradient || 'none';
    var weights = normalizeFillWeights(opts.weights);
    var filled = 0;
    candidates.forEach(function (c) {
      var localDensity = density * densityGradientFactor(gradient, rectNorm01(c.u, rect.u0, rect.u1), rectNorm01(c.v, rect.v0, rect.v1));
      if (rng() >= localDensity) return;
      var color = pickWeightedColor(rng, weights);
      paintGeneric(grid, { u: c.u, v: c.v, tileId: c.tileId, color: color, mirror: opts.mirror });
      filled++;
    });
    return { filled: filled };
  }
  // 汎用格子のcellsのvalidate（キーは"u,v,tileId"。uv は負にもなり得る）
  // 第2引数に格子id（LATTICE_DEFSのキー）を渡すと、その格子が実際に持つタイルidだけを許す。
  // 省略時は正八角形＋正方形（oct/sq）とみなす（段Hの頃の呼び出しとの後方互換）
  function validateCellsGenericObject(cells, latticeId) {
    var def = latticeId ? LATTICE_DEFS[latticeId] : null;
    var name = def ? def.name : '正八角形＋正方形';
    if (latticeId && !def) return '知らない格子です: ' + latticeId;
    var tileIds = def ? def.tiles.map(function (t) { return t.id; }) : ['oct', 'sq'];
    if (cells == null) return true;
    if (typeof cells !== 'object' || Array.isArray(cells)) return name + 'のマスの内容が不正です';
    for (var key in cells) {
      if (!Object.prototype.hasOwnProperty.call(cells, key)) continue;
      var m = /^(-?\d+),(-?\d+),(.+)$/.exec(key);
      if (!m || tileIds.indexOf(m[3]) === -1) return name + 'のマスの位置が不正です';
      var v = cells[key];
      if (!Number.isInteger(v) || v < 1 || v > 4) return name + 'の色番号が不正です';
    }
    return true;
  }
  // v7→v8（仕様v4 段H「格子定義の形式と正八角形＋正方形」）: generic経路の追加だけで構造変更は
  // 無いため、paramsの形はそのまま・版だけを上げる（validateLayerがlattice==='oct-square'を新たに認める）
  function migrateParamsV7toV8(params) { return Object.assign({}, params); }

  /* ============================================================
   * 16. 立体モード（ゴールとロードマップv5・M1「立方体ブラシ」）— 11章(正三角格子)の
   *   座標系・hexagonCells60（六角形ガイド=六角形ブラシと同じ集合）をそのまま使う。
   *   新しい幾何は増やさない: 立方体＝1つの格子点を頂点に持つ6枚の三角(hexagonCells60)を、
   *   3枚ずつのひし形(上面top・左面left・右面right)に分けたもの。
   *   面の割り当ては「格子点(中心)からの角度」だけで決まる純粋に幾何的な値: 三角の
   *   中心以外の2頂点の、中心から見た角度(up-positiveのatan2。画面はy下向きなので
   *   -(y-中心y)で符号を戻す)の中点が、60度ずつ6分割した扇形のどれに入るかを見て、
   *   扇形0・1→top、2・3→left、4・5→right（tri60Corners/hexagonCells60が返す実座標は
   *   同じ入力に対して常にビット単位で同じ値になるため、扇形の境界(0/60/.../300度)を
   *   跨ぐ誤差は出ない）。
   *   面の色は上=1・左=2・右=3で固定（手選びモードの立方体ブラシも、向き色モードの
   *   effectiveColorOfも同じ関係になる。TRI60_EDGE_FAMILY_COLORもこの並びに合わせた）。
   *   ミラー: 三角1枚単位の鏡映(mirrorLR60/UD60)では立方体の面区分が保たれない
   *   （左右反射で「内側の辺(同じ面の相方と共有)」と「境界の辺(隣の面と共有)」の
   *   役割が入れ替わるため、上面の2枚が別々の面の扇形に分かれてしまう＝差し戻しで確認
   *   済み）。そこで立方体は「格子点そのもの」を反射してから、写った先で
   *   cubeTris60を呼び直して面をその場で再判定する（＝面ラベルを写す）。結果として
   *   どこに立方体を置いても上=1・左=2・右=3の関係になるため整合は保たれる。
   * ============================================================ */
  var CUBE_FACE_COLOR = { top: 1, left: 2, right: 3 };
  var CUBE_FACE_BY_SECTOR = ['top', 'top', 'left', 'left', 'right', 'right'];
  // ゴールとロードマップv5 M3「不可能図形の補助」の隠面: 立方体ブラシに「奥の頂点から置く」
  // 切替を足す。同じ6枚(扇形の並びは手前と同じ)を 底面(bottom)・左奥面(backLeft)・右奥面(backRight)
  // として読み替える。色は底=1・左奥=2・右奥=3で、手前のtop=1/left=2/right=3と同じ扇形→同じ数値の
  // 関係をそのまま流用した（000_README.md 検証節に記載の実装判断）。「凹んだ立方体」＝ネッカーの
  // 反転を表す。
  var CUBE_FACE_COLOR_BACK = { bottom: 1, backLeft: 2, backRight: 3 };
  var CUBE_FACE_BY_SECTOR_BACK = ['bottom', 'bottom', 'backLeft', 'backLeft', 'backRight', 'backRight'];
  // 格子点O(実座標)から見た点pの角度(0..360度未満・上向きが90度になるよう符号を反転)
  function tri60AngleUp(O, p) {
    var deg = Math.atan2(-(p.y - O.y), p.x - O.x) * 180 / Math.PI;
    return ((deg % 360) + 360) % 360;
  }
  // 三角の中心以外の2頂点a,bの中点角度から、面ラベルを返す（back=trueなら奥の頂点の面名）
  function cubeFaceFromOuterVertices(O, a, b, back) {
    var na = tri60AngleUp(O, a), nb = tri60AngleUp(O, b);
    if (Math.abs(na - nb) > 180) { if (na < nb) na += 360; else nb += 360; }
    var mid = ((na + nb) / 2 + 360) % 360;
    var sector = Math.floor(mid / 60 + 1e-9) % 6;
    return (back ? CUBE_FACE_BY_SECTOR_BACK : CUBE_FACE_BY_SECTOR)[sector];
  }
  // 実座標(x,y)に最も近い「格子点」を返す（立方体ブラシの入口。中身はtri60NearestGridPointと同じ
  // ＝六角形ブラシと同じ探索をそのまま使う。呼び名だけM1の語彙(頂点=vertex)に合わせて公開する）
  function nearestVertex60(grid, x, y) { return tri60NearestGridPoint(grid, x, y); }
  // vertex: {L,j}（nearestVertex60が返す形。x,yは無視して常にtri60Lineで作り直す＝実座標のブレを防ぐ）
  // back: trueなら「奥の頂点」の面ラベル(bottom/backLeft/backRight)で返す（M3「不可能図形の補助」）。
  // 戻り値: [{col,row,o,face}]（6枚・面ラベル付き）。版面の端で6枚に満たない位置はnull（＝置けない）
  function cubeTris60(grid, vertex, back) {
    var O = tri60Line(vertex.L, vertex.j);
    var tris = hexagonCells60(grid, { L: vertex.L, j: vertex.j, x: O.x, y: O.y });
    if (tris.length !== 6) return null;
    return tris.map(function (t) {
      var verts = tri60Corners(t.col, t.row, t.o);
      var others = [];
      for (var i = 0; i < 3; i++) {
        if (!(Math.abs(verts[i].x - O.x) < 1e-6 && Math.abs(verts[i].y - O.y) < 1e-6)) others.push(verts[i]);
      }
      return { col: t.col, row: t.row, o: t.o, face: cubeFaceFromOuterVertices(O, others[0], others[1], back) };
    });
  }
  // 面ブラシ（M3「不可能図形の補助」）: 実座標(x,y)が入っている三角から、それがどの立方体の
  // どの面かを決める。tri60FromPointでカーソルが入っている三角を求め、nearestVertex60が返す
  // 格子点(=Voronoi的にその三角の中でカーソルに最も近い頂点。等辺三角形の格子ではこれが必ず
  // その三角自身の頂点の1つになる)を立方体の中心として cubeTris60 を呼び、同じ面ラベルを
  // 持つ2枚(ひし形)をまとめて返す。版面の端で立方体そのものが作れない位置はnull。
  function cubeFaceAt60(grid, x, y, back) {
    var tri = tri60FromPoint(grid, x, y);
    if (!tri) return null;
    var vertex = nearestVertex60(grid, x, y);
    var cube = cubeTris60(grid, vertex, back);
    if (!cube) return null;
    var hit = null;
    for (var i = 0; i < cube.length; i++) {
      if (cube[i].col === tri.col && cube[i].row === tri.row && cube[i].o === tri.o) { hit = cube[i]; break; }
    }
    if (!hit) return null;
    var tris = cube.filter(function (t) { return t.face === hit.face; }).map(function (t) { return { col: t.col, row: t.row, o: t.o }; });
    return { vertex: { L: vertex.L, j: vertex.j }, face: hit.face, tris: tris };
  }
  // 三角(col,row,o)が「6枚すべて埋まっている立方体」の一部なら、その面(top/left/right)を返す
  // （向き色モードのeffectiveColorOf専用。孤立ペア=占有辺1本の判定では拾えない、立方体本体
  // =占有辺2本以上のケースを補う）。3頂点のどれかを中心候補として試し、周りの6枚が
  // すべて塗ってあるものを探す。見つからなければnull（＝上/下向きの既定色にフォールバック）
  function tri60CubeFaceIfComplete(grid, col, row, o) {
    var verts = tri60Corners(col, row, o);
    for (var i = 0; i < 3; i++) {
      var gp = tri60PointFromVertex(verts[i]);
      var tris = hexagonCells60(grid, gp);
      if (tris.length !== 6) continue;
      var idx = -1;
      for (var k = 0; k < 6; k++) { if (tris[k].col === col && tris[k].row === row && tris[k].o === o) { idx = k; break; } }
      if (idx === -1) continue;
      var allPainted = true;
      for (var k2 = 0; k2 < 6; k2++) { if (getTri60(grid, tris[k2].col, tris[k2].row, tris[k2].o) == null) { allPainted = false; break; } }
      if (!allPainted) continue;
      var others = [];
      for (var vi = 0; vi < 3; vi++) { if (vi !== i) others.push(verts[vi]); }
      return cubeFaceFromOuterVertices(gp, others[0], others[1]);
    }
    return null;
  }
  // 立方体単位のミラー（実座標で格子点を反射→写った先でcubeTris60を呼び直す。上のコメント参照）
  function mirrorVertexLR60(grid, v) {
    var p = tri60Line(v.L, v.j);
    return nearestVertex60(grid, grid.n * UNIT - p.x, p.y);
  }
  function mirrorVertexUD60(grid, v) {
    var p = tri60Line(v.L, v.j);
    return nearestVertex60(grid, p.x, grid.m * TRI60_H - p.y);
  }
  function mirrorVerticesForCube60(grid, mode, v) {
    var list = [{ L: v.L, j: v.j }];
    if (mode === 'lr') list.push(mirrorVertexLR60(grid, v));
    else if (mode === 'ud') list.push(mirrorVertexUD60(grid, v));
    else if (mode === 'lr-ud') {
      var lr = mirrorVertexLR60(grid, v), ud = mirrorVertexUD60(grid, v), both = mirrorVertexUD60(grid, lr);
      list.push(lr, ud, both);
    }
    var seen = {}, out = [];
    list.forEach(function (p) {
      var k = p.L + ',' + p.j;
      if (!seen[k]) { seen[k] = 1; out.push(p); }
    });
    return out;
  }
  // colors: {top,left,right}（手前）または{bottom,backLeft,backRight}（back=true・奥の頂点）。
  // 手選びモードでも常にこの3色を書く＝仕様v5 M1。erase時はcolorsを無視して6枚とも消す。
  // mirrorが有効なら写った先でも立方体を作り直して同じcolorsで置く/消す。back(M3「不可能図形の
  // 補助」): trueなら「奥の頂点」として置く＝面ラベルがbottom/backLeft/backRightになり、
  // grid.orientにその三角が奥であることを記録する（明暗の規則で法線を反転させるため）。
  // opts.behind（委任packet-behind.md「後ろに隠す（先勝ち）」）: trueかつerase=falseのとき、
  // 既に塗ってある三角（grid.cells.get(key)!=null）は書かない・orientも触らない＝先に置いた面を
  // 上書きしない。空いている三角だけを塗るので、奥や下へ伸ばす棒が既存の面に正しく隠れる。
  // grid.lastPaintedCount に「今回実際に書いた（=空いていて新規に塗った）三角の枚数」を記録する
  // （テスト・トースト用の内部値。封筒には含めない）。
  // 戻り値: 実際に置けた（版面内に収まった）立方体の数（0なら「版面外」でトースト表示に使う）
  function paintCube60(grid, vertex, colors, erase, mirror, back, opts) {
    var behind = !!(opts && opts.behind && !erase);
    var placed = 0, paintedCount = 0;
    mirrorVerticesForCube60(grid, mirror || 'none', vertex).forEach(function (v) {
      var cube = cubeTris60(grid, v, back);
      if (!cube) return;
      placed++;
      cube.forEach(function (t) {
        if (behind && getTri60(grid, t.col, t.row, t.o) != null) return;
        setTri60(grid, t.col, t.row, t.o, erase ? null : colors[t.face]);
        setTri60Orient(grid, t.col, t.row, t.o, !erase && !!back);
        paintedCount++;
      });
    });
    grid.lastPaintedCount = paintedCount;
    return placed;
  }
  // 面ブラシ（M3「不可能図形の補助」）: 立方体1個分ではなく、1つの面(ひし形2枚)だけを置く/消す。
  // vertex・face は cubeFaceAt60 の戻り値をそのまま渡す。mirrorが有効なら写った先でも同じ面ラベルで
  // 置き直す（paintCube60と同じ考え方＝面ラベルは格子点の位置に依らない）。
  // opts.behind: paintCube60と同じ規則（既に塗ってある三角は上書きしない・grid.lastPaintedCountを記録）。
  // 戻り値: 実際に置けた面の数（0なら「版面外」でトースト表示に使う）
  function paintFace60(grid, vertex, face, color, erase, mirror, back, opts) {
    var behind = !!(opts && opts.behind && !erase);
    var placed = 0, paintedCount = 0;
    mirrorVerticesForCube60(grid, mirror || 'none', vertex).forEach(function (v) {
      var cube = cubeTris60(grid, v, back);
      if (!cube) return;
      var tris = cube.filter(function (t) { return t.face === face; });
      if (tris.length !== 2) return;
      placed++;
      tris.forEach(function (t) {
        if (behind && getTri60(grid, t.col, t.row, t.o) != null) return;
        setTri60(grid, t.col, t.row, t.o, erase ? null : color);
        setTri60Orient(grid, t.col, t.row, t.o, !erase && !!back);
        paintedCount++;
      });
    });
    grid.lastPaintedCount = paintedCount;
    return placed;
  }

  /* ============================================================
   * 17. 明暗の規則（ゴールとロードマップv5 M2「明暗の規則」）— 純関数。
   *   17.1 OKLab変換: sRGB(#hex) ⇄ 線形RGB ⇄ LMS ⇄ OKLab。行列はBjörn Ottosson氏の公開値
   *   （https://bottosson.github.io/posts/oklab/ 2026-09-14 確認）をそのまま使う。
   *   000_kit/studio-kit.js にOKLCH変換が無いためcore.jsに純関数として置く。
   * ============================================================ */
  function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function normalizeHexLocal(hex) {
    var h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.replace(/./g, function (c) { return c + c; });
    return '#' + h.toLowerCase();
  }
  // #hex → OKLab {L,a,b}（LはOKLCHのLと同じ値。極形式(C,h)が要る時だけoklabToOklchを使う）
  function hexToOklab(hex) {
    var h = normalizeHexLocal(hex).slice(1);
    var ri = parseInt(h.slice(0, 2), 16) / 255, gi = parseInt(h.slice(2, 4), 16) / 255, bi = parseInt(h.slice(4, 6), 16) / 255;
    var r = srgbToLinear(ri), g = srgbToLinear(gi), b = srgbToLinear(bi);
    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    };
  }
  // OKLab {L,a,b} → #hex（sRGB範囲外は0〜255にクランプする）
  function oklabToHex(lab) {
    var l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
    var m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
    var s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    var toByte = function (v) { return Math.round(clamp01(linearToSrgb(clamp01(v))) * 255); };
    var toHex2 = function (v) { var s2 = v.toString(16); return s2.length < 2 ? '0' + s2 : s2; };
    return '#' + toHex2(toByte(r)) + toHex2(toByte(g)) + toHex2(toByte(b));
  }
  // OKLab → OKLCH（極形式。C=彩度・h=色相度。参考用に公開するが明暗の計算自体はLだけを動かす）
  function oklabToOklch(lab) {
    var c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    var h = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
    return { L: lab.L, C: c, h: ((h % 360) + 360) % 360 };
  }

  /* ============================================================
   * 17.2 面の向き×光源角 → 明度（000_README.md ゴールとロードマップv5 M2）
   *   colorMode:'shade' のレイヤーは、effectiveColorOfと同じ向き判定で面番号(1〜4)を決め
   *   （正方形格子=三角の上/右/下/左と四分円の角4方向をまとめて90度刻みの4面、正三角格子=
   *   立方体の上/左/右=1/2/3（CUBE_FACE_COLORと同じ関係）、六角形・汎用格子(oct-square)は
   *   常に1=基準色のみで区別しない）、面ごとの法線角度と光源角のcosで基準色のLを動かす。
   *   融合のグルーピングは面番号をそのまま使う（既存のcolorFn契約=1〜colorCountの数値、と互換）。
   * ============================================================ */
  // ゴールとロードマップv5 M3「不可能図形の補助」: grid.orientに「奥」と記録された三角は、
  // 面番号(1〜3)はそのまま(色の数値はtop/bottom等で共通)だが、融合のグルーピングだけ4〜6へ
  // ずらす（手前の面1と奥の面1が隣接していても同じpathに融合させない＝法線が逆なので同じ塗りに
  // できないため）。SHADE_FACE_ANGLEのtri60に4〜6=1〜3+180度の角度を足すことで、奥の面は
  // 「法線が反転＝暗くなる」（README原文どおり）。
  function shadeFaceIdOf(layer, element) {
    if (element.kind === 'generic') return 1; // 六角形・oct-squareは基準色のみ（面を区別しない）
    var faceId = effectiveColorOf(Object.assign({}, layer, { colorMode: 'byDirection' }), element, null);
    if (element.kind === 'tri60' && faceId != null && layer && layer.grid && getTri60Orient(layer.grid, element.col, element.row, element.o)) {
      return faceId + 3;
    }
    return faceId;
  }
  // 面番号→法線角度（度・0=右・反時計回り）。正方形格子=90度刻みの4面。正三角格子(立方体)=
  // 上90度・左210度・右330度（README原文「等角投影の3面は90/210/330度」をtop=1/left=2/right=3
  // の関係=CUBE_FACE_COLORにそのまま対応させた）。4〜6は「奥の頂点」で置いた面(shadeFaceIdOfが
  // +3したもの)＝1〜3+180度（法線が反転＝暗くなる。M3「不可能図形の補助」）。テーブルに無い
  // 格子(hex/generic)は角度なし＝常に基準色のまま（「六角形・oct-squareは基準色のみ」）。
  var SHADE_FACE_ANGLE = {
    square: { 1: 90, 2: 0, 3: 270, 4: 180 },
    tri60: { 1: 90, 2: 210, 3: 330, 4: 270, 5: 30, 6: 150 }
  };
  function shadeFaceAngle(latticeKind, faceId) {
    var t = SHADE_FACE_ANGLE[latticeKind];
    return (t && t[faceId] != null) ? t[faceId] : null;
  }
  // contrast=100・光源角が面の法線と一致(cos=1)の時にLをこの分だけ動かす上限（実装判断:
  // README原文に係数の指定が無いため、OKLabのL(0〜1)が破綻しない値として選んだ＝000_README.md
  // 検証節に記載）。
  var SHADE_MAX_DELTA_L = 0.28;
  // baseHex: 基準色 #hex／latticeKind: 'square'|'tri60'|それ以外(基準色のみ)／faceId: shadeFaceIdOfの戻り値／
  // lightDeg: 光源角(0〜360)／contrast: 0〜100
  function shadeColorForFace(baseHex, latticeKind, faceId, lightDeg, contrast) {
    var angle = shadeFaceAngle(latticeKind, faceId);
    if (angle == null) return normalizeHexLocal(baseHex); // 基準色のみ（六角形・oct-square）
    var lab = hexToOklab(baseHex);
    var diff = (angle - (lightDeg || 0)) * Math.PI / 180;
    var c = Math.max(0, Math.min(100, contrast == null ? 0 : contrast));
    var delta = (c / 100) * SHADE_MAX_DELTA_L * Math.cos(diff);
    var L2 = clamp01(lab.L + delta);
    return oklabToHex({ L: L2, a: lab.a, b: lab.b });
  }
  // v8→v9（ゴールとロードマップv5 M2「明暗の規則」・「位置で変える規則」）: colorMode:'shade'と
  // layer.shade、params.fill.densityGradientはどちらも新規・任意項目（無ければ呼び出し側=
  // index.htmlが既定値を補う。旧v8の保存にcolorMode:'shade'は存在し得ないためvalidateShadeも
  // 発火しない）。構造は変わらないため他のv6→v7・v7→v8と同じくパススルーでよい。
  function migrateParamsV8toV9(params) { return Object.assign({}, params); }

  /* ============================================================
   * 18. 規則で描く（ゴールとロードマップv5 M4「規則で描くの一般化」）— DOM非依存の純関数。
   *   000_README.md「ランダムに埋める」節を「規則で埋める」に一般化する。既存の一様乱数
   *   （randomFill*・13章）はそのまま'random'として残し、新しい4規則（数列・距離場・ノイズ・
   *   対称展開）をここに追加する。4つの格子（square/tri60/hex/generic）に共通の「候補」
   *   抽象（1候補＝1つの塗れる場所。実座標cx,cy・整列用gx,gy・読む/塗るの関数を持つ）を
   *   介して、規則ごとの判定ロジックを格子の種類に依らず1本で書く（既存randomFill*は
   *   候補抽象を使わず個々に最適化されたループのままにして壊さない）。
   *   色・要素の選び方は候補の巡回順で rng() を決まった順に引く＝同じ種・同じ設定・同じ
   *   範囲なら常に同じ結果（決定性）。
   * ============================================================ */
  var FILL_RULES = ['random', 'sequence', 'field', 'noise', 'symmetry'];
  var SEQ_ORDERS = ['row', 'spiral', 'diagonal'];
  var SEQ_RULE_KINDS = ['arith', 'fib', 'square', 'prime'];
  var SEQ_COLOR_MODES = ['weights', 'mod4'];
  var FIELD_REFS = ['point', 'hline', 'vline', 'center'];
  var FIELD_WAVES = ['linear', 'sin', 'step'];
  var NOISE_COLOR_MODES = ['weights', 'value'];
  var SYMMETRY_GROUPS = ['p1', 'pmm', 'p4m', 'p3m1', 'p6m'];

  /* ---- 候補（1候補＝1つの塗れる場所）。square/tri60/hexは既存の塗り系関数をそのまま
     呼ぶ薄いラッパー、genericは既存のtiles列挙をそのまま使う ---- */
  // 正方形格子のセルは複数の小要素(tri4枚/quarter/notch)を持てるため「代表色」は先頭に
  // 見つかった色（up→right→down→left）を返す（対称展開の種読み取り専用。厳密な形の
  // 複製ではなく位置と色だけを写す簡略化＝000_README.md検証節に記載）
  function squareCellRepColor(grid, col, row) {
    var cell = getCell(grid, col, row);
    if (!cell) return null;
    if (cell.mode === 'quarter') return cell.color;
    var t = cell.tris;
    if (t.up != null) return t.up;
    if (t.right != null) return t.right;
    if (t.down != null) return t.down;
    return t.left != null ? t.left : null;
  }
  function makeCandidateSquare(grid, col, row) {
    return {
      gx: col, gy: row, cx: (col + 0.5) * UNIT, cy: (row + 0.5) * UNIT,
      readColor: function () { return squareCellRepColor(grid, col, row); },
      place: function (kind, color, rng) { placeSquareFillElement(grid, col, row, kind, color, rng, 'none', grid.n); }
    };
  }
  function buildFillCandidatesSquare(grid, rect) {
    var out = [];
    for (var row = rect.r0; row <= rect.r1; row++) for (var col = rect.c0; col <= rect.c1; col++) out.push(makeCandidateSquare(grid, col, row));
    return out;
  }
  function makeCandidateTri60(grid, col, row, o) {
    var v = tri60Corners(col, row, o);
    var cx = (v[0].x + v[1].x + v[2].x) / 3, cy = (v[0].y + v[1].y + v[2].y) / 3;
    return {
      gx: col, gy: row, o: o, cx: cx, cy: cy,
      readColor: function () { return getTri60(grid, col, row, o); },
      place: function (kind, color, rng) { placeTri60FillElement(grid, col, row, o, kind, color, rng, 'none'); }
    };
  }
  function buildFillCandidatesTri60(grid, rect) {
    var out = [];
    for (var row = rect.r0; row <= rect.r1; row++) {
      for (var col = rect.c0; col <= rect.c1; col++) {
        ['down', 'up'].forEach(function (o) {
          if (!isTri60InBounds(grid, col, row, o)) return;
          out.push(makeCandidateTri60(grid, col, row, o));
        });
      }
    }
    return out;
  }
  function makeCandidateHex(grid, L, j) {
    var p = tri60Line(L, j);
    return {
      gx: j, gy: L, cx: p.x, cy: p.y,
      readColor: function () { return getHex(grid, L, j); },
      place: function (kind, color) { paintHex(grid, { L: L, j: j, color: color, mirror: 'none' }); }
    };
  }
  function buildFillCandidatesHex(grid, rect) {
    var out = [];
    for (var L = rect.r0; L <= rect.r1; L++) for (var j = rect.c0; j <= rect.c1; j++) {
      if (!isFullHexCenter(grid.n, L, j)) continue;
      out.push(makeCandidateHex(grid, L, j));
    }
    return out;
  }
  function makeCandidateGeneric(grid, t) {
    var c = grid.centroidByKey[genericTileKey(t.u, t.v, t.tileId)];
    return {
      gx: t.u, gy: t.v, tileId: t.tileId, cx: c.x, cy: c.y,
      readColor: function () { return getGeneric(grid, t.u, t.v, t.tileId); },
      place: function (kind, color) { paintGeneric(grid, { u: t.u, v: t.v, tileId: t.tileId, color: color, mirror: 'none' }); }
    };
  }
  function buildFillCandidatesGeneric(grid, rect, allowed) {
    return grid.tiles.filter(function (t) {
      return allowed.indexOf(t.tileId) !== -1 && t.u >= rect.u0 && t.u <= rect.u1 && t.v >= rect.v0 && t.v <= rect.v1;
    }).sort(function (a, b) { return (a.u - b.u) || (a.v - b.v) || (a.tileId < b.tileId ? -1 : 1); })
      .map(function (t) { return makeCandidateGeneric(grid, t); });
  }
  // 格子ごとに使える要素だけへ絞る（square/tri60/hexの候補は位置そのものは要素に依らず
  // 全部作り、置く時の形の選び方だけをこのリストから選ぶ。genericは候補自体をtileIdで絞る）
  function elementsAllowedFor(lattice, elements) {
    var list = elements || [];
    if (lattice === 'square') return list.filter(function (e) { return SQUARE_FILL_ELEMENTS.indexOf(e) !== -1; });
    if (lattice === 'tri60') return list.filter(function (e) { return TRI60_FILL_ELEMENTS.indexOf(e) !== -1; });
    if (lattice === 'hex') return list.filter(function (e) { return HEX_FILL_ELEMENTS.indexOf(e) !== -1; });
    return list;
  }
  function buildFillCandidates(lattice, grid, rect, elements) {
    if (lattice === 'tri60') return buildFillCandidatesTri60(grid, rect);
    if (lattice === 'hex') return buildFillCandidatesHex(grid, rect);
    if (isGenericLattice(lattice)) {
      var allowedAll = GENERIC_FILL_ELEMENTS_BY_DEF[grid.defId] || [];
      var allowed = (elements || []).filter(function (e) { return allowedAll.indexOf(e) !== -1; });
      return buildFillCandidatesGeneric(grid, rect, allowed);
    }
    return buildFillCandidatesSquare(grid, rect);
  }
  // 候補へ1件塗る（square/tri60は許可要素からrng()で形を選ぶ・hex/generic/対称展開は候補の
  // 場所自体が形を決めるのでkindは使わない）
  function writeFillCandidate(lattice, c, color, allowedKinds, rng) {
    if (lattice === 'square' || lattice === 'tri60') {
      var kind = allowedKinds[Math.floor(rng() * allowedKinds.length)];
      c.place(kind, color, rng);
    } else {
      c.place(null, color, rng);
    }
  }

  /* ---- 数列（等差・フィボナッチ・平方数・素数） ----
     候補を走査順(行優先/中心から渦巻き/対角)に並べ、番号i(1始まり)が規則を満たす候補だけ塗る。 ---- */
  function orderCandidatesSequence(cands, order) {
    var arr = cands.slice();
    if (order === 'diagonal') {
      arr.sort(function (a, b) { return ((a.gx + a.gy) - (b.gx + b.gy)) || (a.gx - b.gx) || (a.gy - b.gy); });
    } else if (order === 'spiral') {
      // 中心からの渦巻き＝候補群の重心からの距離→角度の順に並べる決定的な近似
      // （どの格子形状にも使える汎用の並び。README原文に厳密な渦巻き経路の指定は無い）
      var n = arr.length, cx = 0, cy = 0;
      arr.forEach(function (c) { cx += c.gx; cy += c.gy; });
      cx /= (n || 1); cy /= (n || 1);
      arr.forEach(function (c) {
        var dx = c.gx - cx, dy = c.gy - cy;
        c._r = Math.sqrt(dx * dx + dy * dy);
        c._a = Math.atan2(dy, dx);
      });
      arr.sort(function (a, b) { return (a._r - b._r) || (a._a - b._a); });
    } else {
      arr.sort(function (a, b) { return (a.gy - b.gy) || (a.gx - b.gx) || (String(a.o || '') < String(b.o || '') ? -1 : 1); });
    }
    return arr;
  }
  function isPerfectSquareNum(i) { var s = Math.round(Math.sqrt(i)); return s * s === i; }
  function isFibonacciNum(i) {
    // i(正整数)がフィボナッチ数 ⇔ 5i²+4 か 5i²-4 のどちらかが平方数（よく知られた判定式）
    return isPerfectSquareNum(5 * i * i + 4) || isPerfectSquareNum(5 * i * i - 4);
  }
  function isPrimeNum(i) {
    if (i < 2) return false;
    if (i % 2 === 0) return i === 2;
    for (var d = 3; d * d <= i; d += 2) if (i % d === 0) return false;
    return true;
  }
  function seqAccept(i, ruleKind, period, phase) {
    if (ruleKind === 'fib') return isFibonacciNum(i);
    if (ruleKind === 'square') return isPerfectSquareNum(i);
    if (ruleKind === 'prime') return isPrimeNum(i);
    var k = Math.max(1, Math.round(period) || 1);
    var p = ((Math.round(phase) || 0) % k + k) % k;
    return ((i - 1) % k) === p;
  }
  function seqColorFor(i, colorMode, weights, rng) {
    if (colorMode === 'mod4') return ((i - 1) % 4 + 4) % 4 + 1;
    return pickWeightedColor(rng, weights);
  }
  // opts: { elements, weights, seed, order, ruleKind, period, phase, colorMode }
  function randomFillSequence(lattice, grid, rect, opts) {
    var elements = opts.elements || [];
    var allowedKinds = elementsAllowedFor(lattice, elements);
    if (!isGenericLattice(lattice) && !allowedKinds.length) return { filled: 0 };
    var cands = buildFillCandidates(lattice, grid, rect, elements);
    if (!cands.length) return { filled: 0 };
    var ordered = orderCandidatesSequence(cands, opts.order || 'row');
    var rng = makeFillRng(opts.seed);
    var weights = normalizeFillWeights(opts.weights);
    var filled = 0;
    ordered.forEach(function (c, idx) {
      var i = idx + 1;
      if (!seqAccept(i, opts.ruleKind || 'arith', opts.period != null ? opts.period : 2, opts.phase || 0)) return;
      var color = seqColorFor(i, opts.colorMode || 'weights', weights, rng);
      writeFillCandidate(lattice, c, color, allowedKinds, rng);
      filled++;
    });
    return { filled: filled };
  }

  /* ---- 距離場（点・横線・縦線・中心からの距離で密度を決める） ---- */
  function fieldDistance(ref, points, cx, cy, bbox) {
    var mx = (bbox.x0 + bbox.x1) / 2, my = (bbox.y0 + bbox.y1) / 2;
    if (ref === 'hline') return Math.abs(cy - my);
    if (ref === 'vline') return Math.abs(cx - mx);
    if (ref === 'point') {
      var pts = (points || []).length ? points : [{ x: mx, y: my }];
      var best = Infinity;
      pts.forEach(function (p) { var d = Math.hypot(cx - p.x, cy - p.y); if (d < best) best = d; });
      return best;
    }
    return Math.hypot(cx - mx, cy - my); // 'center'
  }
  // dNorm: 0(基準そのもの)〜およそ1(版面の対角ぶん離れた位置)に正規化した距離。
  // steps: waveKind='step'の時だけ使う段数k（既定4）
  function fieldDensityValue(waveKind, dNorm, period, phase, steps) {
    var d = Math.max(0, dNorm);
    if (waveKind === 'sin') {
      var per1 = Math.max(1e-6, period || 1);
      var u1 = d / per1 + (phase || 0);
      return 0.5 + 0.5 * Math.cos(2 * Math.PI * u1);
    }
    if (waveKind === 'step') {
      var per2 = Math.max(1e-6, period || 1);
      var k = Math.max(1, Math.round(steps || 4));
      var u2 = d / per2 + (phase || 0);
      var frac = ((u2 % 1) + 1) % 1;
      var idx = Math.min(k - 1, Math.floor(frac * k));
      return k > 1 ? 1 - idx / (k - 1) : 1;
    }
    // 'linear': 周期・位相を使わない単調減少（距離場の単調性テストはこの波形で確認する）
    return Math.max(0, 1 - Math.min(1, d));
  }
  // opts: { elements, weights, seed, ref, points, waveKind, period, phase, steps, density }
  function randomFillField(lattice, grid, rect, opts) {
    var elements = opts.elements || [];
    var allowedKinds = elementsAllowedFor(lattice, elements);
    if (!isGenericLattice(lattice) && !allowedKinds.length) return { filled: 0 };
    var cands = buildFillCandidates(lattice, grid, rect, elements);
    if (!cands.length) return { filled: 0 };
    var bbox = candidatesBBox(cands);
    var diag = Math.hypot(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) || 1;
    var rng = makeFillRng(opts.seed);
    var density = Math.max(0, Math.min(100, opts.density != null ? opts.density : 100)) / 100;
    var weights = normalizeFillWeights(opts.weights);
    var waveKind = opts.waveKind || 'linear';
    var steps = opts.steps || 4;
    var filled = 0;
    cands.forEach(function (c) {
      var d = fieldDistance(opts.ref || 'center', opts.points, c.cx, c.cy, bbox) / diag;
      var localDensity = density * fieldDensityValue(waveKind, d, opts.period, opts.phase, steps);
      if (rng() >= localDensity) return;
      var color = pickWeightedColor(rng, weights);
      writeFillCandidate(lattice, c, color, allowedKinds, rng);
      filled++;
    });
    return { filled: filled };
  }
  function candidatesBBox(cands) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    cands.forEach(function (c) {
      if (c.cx < x0) x0 = c.cx; if (c.cx > x1) x1 = c.cx;
      if (c.cy < y0) y0 = c.cy; if (c.cy > y1) y1 = c.cy;
    });
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = UNIT; y1 = UNIT; }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /* ---- ノイズ（決定的な2D値ノイズ。周波数・オクターブ1〜3。しきい値で塗る/塗らない） ---- */
  // 整数格子点(ix,iy)＋種から[0,1)の値を1つ返す（ハッシュ。同じ入力は常に同じ値＝決定的）
  function noiseHash2(ix, iy, seed) {
    var h = (ix * 374761393 + iy * 668265263 + (seed || 0) * 2246822519) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }
  function noiseSmoothstep(t) { return t * t * (3 - 2 * t); }
  function valueNoise2DOctave(x, y, seed) {
    var x0 = Math.floor(x), y0 = Math.floor(y), x1 = x0 + 1, y1 = y0 + 1;
    var sx = noiseSmoothstep(x - x0), sy = noiseSmoothstep(y - y0);
    var n00 = noiseHash2(x0, y0, seed), n10 = noiseHash2(x1, y0, seed);
    var n01 = noiseHash2(x0, y1, seed), n11 = noiseHash2(x1, y1, seed);
    var ix0 = n00 + (n10 - n00) * sx, ix1 = n01 + (n11 - n01) * sx;
    return ix0 + (ix1 - ix0) * sy;
  }
  // x,y: 格子座標系の実数値（マス単位程度のスケールを想定）／seed: 種／frequency: 周波数(>0)／
  // octaves: 1〜3（重ねる回数）。戻り値は常に[0,1]（fBm）。同じ引数なら常に同じ値（決定的・再現可能）
  function valueNoise2D(x, y, seed, frequency, octaves) {
    var oct = Math.max(1, Math.min(3, Math.round(octaves) || 1));
    var freq = frequency > 0 ? frequency : 0.1;
    var amp = 1, total = 0, ampSum = 0, f = freq;
    for (var o = 0; o < oct; o++) {
      total += valueNoise2DOctave(x * f, y * f, (seed || 0) + o * 101) * amp;
      ampSum += amp;
      amp *= 0.5; f *= 2;
    }
    return Math.max(0, Math.min(1, total / ampSum));
  }
  // opts: { elements, weights, seed, frequency, octaves, threshold(0-100), colorMode }
  function randomFillNoise(lattice, grid, rect, opts) {
    var elements = opts.elements || [];
    var allowedKinds = elementsAllowedFor(lattice, elements);
    if (!isGenericLattice(lattice) && !allowedKinds.length) return { filled: 0 };
    var cands = buildFillCandidates(lattice, grid, rect, elements);
    if (!cands.length) return { filled: 0 };
    var seed = opts.seed;
    var rng = makeFillRng(seed);
    var weights = normalizeFillWeights(opts.weights);
    var threshold = Math.max(0, Math.min(100, opts.threshold || 0)) / 100;
    var colorMode = opts.colorMode || 'weights';
    var filled = 0;
    cands.forEach(function (c) {
      var v = valueNoise2D(c.cx / UNIT, c.cy / UNIT, seed, opts.frequency, opts.octaves);
      if (v < threshold) return;
      var color = colorMode === 'value' ? (Math.min(4, Math.floor(v * 4) + 1)) : pickWeightedColor(rng, weights);
      writeFillCandidate(lattice, c, color, allowedKinds, rng);
      filled++;
    });
    return { filled: filled };
  }

  /* ---- 対称展開（p1平行移動／pmm左右上下鏡映／p4m正方形格子のみ90度回転＋鏡映／
     p3m1・p6m正三角格子のみ）。種＝選択範囲(無ければ左上1/4)の中身を、版面全体の実座標
     の中心を軸にした鏡映・回転で写す。形の向きまでは厳密に複製せず（正方形格子は
     セルごとに複数の小要素を持てるため）、位置と色をそのまま複製し、置く形は他の規則と
     同じくrng()と許可要素から選ぶ（000_README.md検証節に記載の簡略化）。p1だけは
     種のブロックを平行移動でそのままタイルする（形も向きも変えずに複製できるため）。
     群の元の数ぶん候補を巡回し、最初に「種の中の対応する位置が塗られている」に一致した
     元を採用する（決定的）。既定の種(左上1/4＝面積1/4)は、点群の位数が4を超える
     p4m(8元)・p3m1(6元)・p6m(12元)にとっては真の基本領域(面積1/位数)より大きくなり得る。
     その場合、種の中身自体が群のもとで互いに重なり合うことがあり得て、版面全体が
     完全対称にならない位置が出ることがある（種を選択範囲で小さく指定すれば避けられる。
     test.mjs (M4-10)(M4-11)は基本領域に収まる小さな種で厳密対称を確認している）。 ---- */
  function rectContainsGxGy(rect, gx, gy) {
    if (rect.u0 != null) return gx >= rect.u0 && gx <= rect.u1 && gy >= rect.v0 && gy <= rect.v1;
    return gx >= rect.c0 && gx <= rect.c1 && gy >= rect.r0 && gy <= rect.r1;
  }
  function rectSpan(rect) {
    if (rect.u0 != null) return { w: rect.u1 - rect.u0 + 1, h: rect.v1 - rect.v0 + 1, x0: rect.u0, y0: rect.v0 };
    return { w: rect.c1 - rect.c0 + 1, h: rect.r1 - rect.r0 + 1, x0: rect.c0, y0: rect.r0 };
  }
  function roundKeyXY(x, y) { return Math.round(x * 1000) + ',' + Math.round(y * 1000); }
  function symmetryElements(group, bbox) {
    var mx = (bbox.x0 + bbox.x1) / 2, my = (bbox.y0 + bbox.y1) / 2;
    function id(x, y) { return { x: x, y: y }; }
    function mX(x, y) { return { x: 2 * mx - x, y: y }; }
    function rot(deg) {
      var th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      return function (x, y) { var dx = x - mx, dy = y - my; return { x: mx + dx * c - dy * s, y: my + dx * s + dy * c }; };
    }
    function withMirror(list) { return list.concat(list.map(function (f) { return function (x, y) { var p = f(x, y); return mX(p.x, p.y); }; })); }
    if (group === 'pmm') return withMirror([id, rot(180)]);
    if (group === 'p4m') return withMirror([id, rot(90), rot(180), rot(270)]);
    if (group === 'p3m1') return withMirror([id, rot(120), rot(240)]);
    if (group === 'p6m') return withMirror([id, rot(60), rot(120), rot(180), rot(240), rot(300)]);
    return [id];
  }
  // p1: 種のブロックを実寸ぶんそのまま平行移動でタイルする（gx,gy(+o/tileId)をブロック幅・
  // 高さで折り返して種の対応候補を読む＝色も形もそのまま複製できる）
  function symmetryFillP1(lattice, cands, seedRect, allowedKinds, rng) {
    var span = rectSpan(seedRect);
    var bw = span.w, bh = span.h;
    var byKey = {};
    cands.forEach(function (c) { byKey[c.gx + ',' + c.gy + ',' + (c.o || '') + (c.tileId || '')] = c; });
    var filled = 0;
    cands.forEach(function (c) {
      if (rectContainsGxGy(seedRect, c.gx, c.gy)) return;
      var lgx = ((c.gx - span.x0) % bw + bw) % bw + span.x0;
      var lgy = ((c.gy - span.y0) % bh + bh) % bh + span.y0;
      var src = byKey[lgx + ',' + lgy + ',' + (c.o || '') + (c.tileId || '')];
      if (!src) return;
      var color = src.readColor();
      if (color == null) return;
      writeFillCandidate(lattice, c, color, allowedKinds, rng);
      filled++;
    });
    return filled;
  }
  // opts: { elements, seed, group }（色は種の色をそのまま使うのでweightsは使わない）
  function randomFillSymmetry(lattice, grid, rect, seedRect, opts) {
    var elements = opts.elements || [];
    var allowedKinds = elementsAllowedFor(lattice, elements);
    if (!isGenericLattice(lattice) && !allowedKinds.length) return { filled: 0 };
    var cands = buildFillCandidates(lattice, grid, rect, elements);
    if (!cands.length) return { filled: 0 };
    var group = opts.group || 'p1';
    var rng = makeFillRng(opts.seed);
    if (group === 'p1') return { filled: symmetryFillP1(lattice, cands, seedRect, allowedKinds, rng) };
    var bbox = candidatesBBox(cands);
    var els = symmetryElements(group, bbox);
    var lookup = {};
    cands.forEach(function (c) { lookup[roundKeyXY(c.cx, c.cy)] = c; });
    var filled = 0;
    cands.forEach(function (c) {
      if (rectContainsGxGy(seedRect, c.gx, c.gy)) return;
      for (var i = 0; i < els.length; i++) {
        var pt = els[i](c.cx, c.cy);
        var src = lookup[roundKeyXY(pt.x, pt.y)];
        if (src && rectContainsGxGy(seedRect, src.gx, src.gy)) {
          var color = src.readColor();
          if (color != null) { writeFillCandidate(lattice, c, color, allowedKinds, rng); filled++; }
          break;
        }
      }
    });
    return { filled: filled };
  }

  // v9→v10（ゴールとロードマップv5 M4「規則で描くの一般化」）: params.fillに新規に
  // rule/seq/field/noise/symmetryが増えるだけで既存項目は変えないため、旧保存には
  // fill.ruleが無い＝'random'を補うだけでよい（それ以外は各規則の既定値をindex.html側で補う）
  function migrateParamsV9toV10(params) {
    var p = Object.assign({}, params);
    if (p.fill && p.fill.rule == null) p.fill = Object.assign({ rule: 'random' }, p.fill);
    return p;
  }
  // v10→v11（M5「格子の編集」経由: レイヤー追加popoverが格子ギャラリーになり、書類名▾に
  // 「格子の定義（JSON）を読む」が増えた。customLatticesが無い旧保存には空配列を補うだけ
  // （構造は増えたが後方互換の追加項目のみ。既存のlayers/cells系は変更しない）
  function migrateParamsV10toV11(params) {
    var p = Object.assign({}, params);
    if (!Array.isArray(p.customLattices)) p.customLattices = [];
    return p;
  }
  // v11→v12（仕様v6「大きな円弧」）: 正方形レイヤーにarcsが無ければ[]を足すだけ（素通し。
  // 後方互換の追加項目のみ・cells系は変更しない）
  function migrateParamsV11toV12(params) {
    var p = Object.assign({}, params);
    if (Array.isArray(p.layers)) {
      p.layers = p.layers.map(function (l) {
        if (l && l.lattice === 'square' && !Array.isArray(l.arcs)) return Object.assign({}, l, { arcs: [] });
        return l;
      });
    }
    return p;
  }
  // v12→v13（2026-09-16「書き出しの形」）: 書き出しの形(exportShape)のキーが無い旧保存は
  // 「同色を融合」(merge)として読む＝従来の見え方を壊さない（新規の既定は別途index.html側でsplit）。
  // 後方互換の追加項目のみ・layers/cells系は変更しない
  function migrateParamsV12toV13(params) {
    var p = Object.assign({}, params);
    if (p.exportShape !== 'split' && p.exportShape !== 'merge') p.exportShape = 'merge';
    return p;
  }
  // v13→v14（2026-09-17「色をレイヤーごとに・プリセットの一括適用」）: 各レイヤーへcolors[4]が
  // 無ければ、当時のグローバル色(params.colors。それも不正なら既定色)を補う＝旧保存を開いても
  // 見た目が変わらない（「選択した前のレイヤーに戻った時にその時の色が保存されているように」の
  // 前提として、まず全レイヤーが自分の色を持つ状態を作る）。customPalettesが無い旧保存には
  // 空配列を補うだけ（読み込んだ色プリセットJSONの保存先。後方互換の追加項目のみ）
  function migrateParamsV13toV14(params) {
    var p = Object.assign({}, params);
    var fallbackColors = validateColorsArray(params.colors) ? params.colors : DEFAULT_LAYER_COLORS;
    if (Array.isArray(p.layers)) {
      p.layers = p.layers.map(function (l) {
        if (l && !validateColorsArray(l.colors)) return Object.assign({}, l, { colors: fallbackColors.slice() });
        return l;
      });
    }
    if (!Array.isArray(p.customPalettes)) p.customPalettes = [];
    return p;
  }

  /* ============================================================
   * 7. paramsのvalidate（封筒の復元・006_ツールの規格 §1 RESTORE-01）
   * ============================================================ */
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  function isColorValue(v) { return typeof v === 'string' && (v === 'none' || HEX_RE.test(v)); }
  var MIRROR_MODES = ['none', 'lr', 'ud', 'lr-ud', 'rot4'];

  // params.cells / variants[i].cells の両方から使う共通チェック（true または エラー文言）
  function validateCellsObject(cells) {
    if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return 'マスの内容が不正です';
    for (var key in cells) {
      if (!Object.prototype.hasOwnProperty.call(cells, key)) continue;
      if (!/^\d+,\d+$/.test(key)) return 'マスの位置が不正です';
      var cell = cells[key];
      if (!cell || typeof cell !== 'object') return 'マスの内容が不正です';
      if (cell.mode === 'tri') {
        if (!cell.tris || typeof cell.tris !== 'object') return 'マスの内容が不正です';
        for (var d = 0; d < TRI_DIRS.length; d++) {
          var v = cell.tris[TRI_DIRS[d]];
          if (v != null && (!Number.isInteger(v) || v < 1 || v > 4)) return '色番号が不正です';
        }
      } else if (cell.mode === 'quarter') {
        if (cell.shape !== 'quarter' && cell.shape !== 'notch') return '四分円の種類が不正です';
        if (CORNERS.indexOf(cell.corner) === -1) return '角の指定が不正です';
        if (!Number.isInteger(cell.color) || cell.color < 1 || cell.color > 4) return '色番号が不正です';
      } else {
        return 'マスの種類が不正です';
      }
    }
    return true;
  }
  function validateColorsArray(colors) {
    if (!Array.isArray(colors) || colors.length !== 4) return false;
    for (var i = 0; i < 4; i++) if (!isColorValue(colors[i])) return false;
    return true;
  }
  // 色プリセットJSON（2026-09-17「プリセットの一括適用・JSON読み込み」）の1件分。
  // {"name":"…","colors":["#RRGGBB"×4]}。色は色1〜4と同じ形式（validateColorsArrayを再利用）
  function validatePaletteEntry(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return '色プリセットの内容が不正です';
    if (typeof p.name !== 'string' || !p.name) return '色プリセットの名前が不正です';
    if (!validateColorsArray(p.colors)) return '色プリセットの色は4つのRRGGBBで指定してください';
    return true;
  }
  // params.customPalettes（読み込んだ色プリセットJSONの保存先。封筒に入れて次回も選べるようにする）
  function validateCustomPalettesArray(arr) {
    if (arr == null) return true;
    if (!Array.isArray(arr)) return '色プリセットの一覧が不正です';
    for (var i = 0; i < arr.length; i++) {
      var r = validatePaletteEntry(arr[i]);
      if (r !== true) return r;
    }
    return true;
  }
  // 文字を下に敷く（仕様v2 段B）。null=非表示。位置x/yはマス番地基準の自由数値（版面外にも置けてよい）
  function validateUnderlay(u) {
    if (u == null) return true;
    if (typeof u !== 'object' || Array.isArray(u)) return '下敷き文字の指定が不正です';
    if (typeof u.text !== 'string') return '下敷き文字の文言が不正です';
    if (typeof u.font !== 'string' || !u.font) return '下敷き文字のフォント指定が不正です';
    if (typeof u.size !== 'number' || !isFinite(u.size) || u.size <= 0 || u.size > 200) return '下敷き文字の大きさが不正です';
    if (typeof u.x !== 'number' || !isFinite(u.x)) return '下敷き文字のx位置が不正です';
    if (typeof u.y !== 'number' || !isFinite(u.y)) return '下敷き文字のy位置が不正です';
    if (typeof u.alpha !== 'number' || !isFinite(u.alpha) || u.alpha < 0.1 || u.alpha > 0.6) return '下敷き文字の薄さが不正です';
    return true;
  }
  // 候補（仕様v2 段B「候補に残す」）。最大12件、各候補は独立したcells/colors/bgを持つ
  // （仕様v4 段D以降は候補もレイヤーの束＝v.layers[]を持つ。v.layers があればそちらを見る）
  function validateVariants(variants, n) {
    if (variants == null) return true;
    if (!Array.isArray(variants) || variants.length > 12) return '候補の数が不正です';
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      if (!v || typeof v !== 'object') return '候補の内容が不正です';
      if (v.layers != null) {
        var layersOk = validateLayersArray(v.layers, n);
        if (layersOk !== true) return layersOk;
      } else {
        var cellsOk = validateCellsObject(v.cells);
        if (cellsOk !== true) return cellsOk;
      }
      if (!validateColorsArray(v.colors)) return '候補の色の指定が不正です';
      if (!isColorValue(v.bg)) return '候補の地色の指定が不正です';
    }
    return true;
  }

  function validateParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return '設定が不正です';
    if (!Number.isInteger(params.n) || params.n < 4 || params.n > 64) return 'マスの数が不正です';
    if (typeof params.cell !== 'number' || !isFinite(params.cell) || params.cell < 1 || params.cell > 50) return 'マスの大きさが不正です';
    if (!validateColorsArray(params.colors)) return '色1〜4の指定が不正です';
    if (!isColorValue(params.bg)) return '地色の指定が不正です';
    // v14（2026-09-17「色プリセットのJSON読み込み」）: params.customPalettesは読み込んだ
    // 色プリセットの本体（パレット選択の末尾に「（読み込み）」付きで並ぶ元）。任意項目
    var customPalettesOk = validateCustomPalettesArray(params.customPalettes);
    if (customPalettesOk !== true) return customPalettesOk;
    // v11（M5「格子の編集」経由の「格子の定義（JSON）を読む」）: params.customLatticesは
    // このparamsが使うカスタム格子定義の本体（レイヤー追加popover=格子ギャラリーの末尾に並ぶ元）。
    // 直後のlayers検証（layerLatticeModes経由）がこのidを知っている必要があるため、
    // 検証と同時にLATTICE_DEFSへ登録する（「復元時に登録し直す」の実体）
    if (params.customLattices != null) {
      if (!Array.isArray(params.customLattices)) return 'カスタム格子の一覧が配列ではありません';
      for (var ci = 0; ci < params.customLattices.length; ci++) {
        var cErr = validateLatticeDef(params.customLattices[ci]);
        if (cErr !== true) return cErr;
      }
      params.customLattices.forEach(function (d) { registerLatticeDef(d); });
    }
    // v5（仕様v4 段D「レイヤー」）: params.layers があればレイヤー配列が正本になり、
    // 旧来のmirror/cells（1枚だけの盤面）は使わない。無ければv1〜v4のまま（後方互換）。
    if (params.layers != null) {
      var layersOk = validateLayersArray(params.layers, params.n);
      if (layersOk !== true) return layersOk;
      if (typeof params.activeLayer !== 'string') return 'アクティブなレイヤーの指定が不正です';
      var hasActive = false;
      for (var li = 0; li < params.layers.length; li++) if (params.layers[li] && params.layers[li].id === params.activeLayer) { hasActive = true; break; }
      if (!hasActive) return 'アクティブなレイヤーが見つかりません';
    } else {
      if (MIRROR_MODES.indexOf(params.mirror) === -1) return 'ミラーの指定が不正です';
      var cellsOk = validateCellsObject(params.cells);
      if (cellsOk !== true) return cellsOk;
    }
    // v2で追加した項目（未指定=旧v1のまま復元されるケースを許すため任意項目にする。
    // 実際の復元は index.html の migrateParamsV1toV2 で必ず埋めてから渡す）
    if (params.round != null && ['none', 'convex', 'both'].indexOf(params.round) === -1) return '角丸の指定が不正です';
    if (params.roundR != null && (typeof params.roundR !== 'number' || !isFinite(params.roundR) || params.roundR < 0 || params.roundR > UNIT)) return '角丸の半径が不正です';
    if (params.exportMode != null && ['fill', 'stroke', 'both'].indexOf(params.exportMode) === -1) return '書き出す形式の指定が不正です';
    if (params.exportShape != null && ['split', 'merge'].indexOf(params.exportShape) === -1) return '書き出しの形の指定が不正です';
    if (params.sw != null && (typeof params.sw !== 'number' || !isFinite(params.sw) || params.sw <= 0 || params.sw > 20)) return '線幅の指定が不正です';
    if (params.trim != null && typeof params.trim !== 'boolean') return 'トリムの指定が不正です';
    if (params.trimMargin != null && (!Number.isInteger(params.trimMargin) || params.trimMargin < 0 || params.trimMargin > 4)) return '余白マス数が不正です';
    if (params.exportBg != null && typeof params.exportBg !== 'boolean') return '地色を含める指定が不正です';
    // v3で追加した項目（同様に未指定=旧v1/v2のまま復元されるケースを許すため任意項目にする）
    var variantsOk = validateVariants(params.variants, params.n);
    if (variantsOk !== true) return variantsOk;
    var underlayOk = validateUnderlay(params.underlay);
    if (underlayOk !== true) return underlayOk;
    // v4で追加した項目（仕様v2 段C「60°の格子」）。v5以降はlayers[]の中のlattice/cells60を見るので、
    // ここは旧来形式（params.layersが無い＝v1〜v4のまま復元されたケース）だけを見る
    if (params.layers == null) {
      if (params.lattice != null && LATTICE_MODES.indexOf(params.lattice) === -1) return '格子の指定が不正です';
      var cells60Ok = validateCells60Object(params.cells60);
      if (cells60Ok !== true) return cells60Ok;
    }
    // v6で追加した項目（仕様v4 段F「ランダム充填」）。同様に未指定=旧版のまま復元されるケースを許す
    var fillOk = validateFill(params.fill);
    if (fillOk !== true) return fillOk;
    return true;
  }

  return {
    UNIT: UNIT,
    createGrid: createGrid,
    getCell: getCell,
    setCell: setCell,
    clearGrid: clearGrid,
    paintTriangle: paintTriangle,
    eraseTriangle: eraseTriangle,
    paintSquare: paintSquare,
    eraseCell: eraseCell,
    paintQuarter: paintQuarter,
    paintNotch: paintNotch,
    eraseByBrush: eraseByBrush,
    cellsToObject: cellsToObject,
    gridFromCells: gridFromCells,
    cellBounds: cellBounds,
    squareCorners: squareCorners,
    nearestTriangleDir: nearestTriangleDir,
    nearestCorner: nearestCorner,
    buildColorPathD: buildColorPathD,
    buildAllPaths: buildAllPaths,
    buildExplodedPaths: buildExplodedPaths,
    mirrorPositions: mirrorPositions,
    paint: paint,
    nearestGridPoint: nearestGridPoint,
    nearestHalfSide: nearestHalfSide,
    circleQuarterCells: circleQuarterCells,
    halfQuarterCells: halfQuarterCells,
    paintComposite: paintComposite,
    replaceColor: replaceColor,
    contentBounds: contentBounds,
    trimmedViewBox: trimmedViewBox,
    migrateParamsV1toV2: migrateParamsV1toV2,
    migrateParamsV2toV3: migrateParamsV2toV3,
    validateParams: validateParams,
    extractCells: extractCells,
    transformCells: transformCells,
    applyTransform: applyTransform,
    snapAngle: snapAngle,
    snapEndpoint: snapEndpoint,
    lineCells: lineCells,
    floodFill: floodFill,
    TRI_DIRS: TRI_DIRS,
    CORNERS: CORNERS,

    // 11. 60°正三角格子
    SQRT3: SQRT3,
    TRI60_H: TRI60_H,
    tri60Rows: tri60Rows,
    createGrid60: createGrid60,
    getTri60: getTri60,
    setTri60: setTri60,
    beginStep60: beginStep60,
    stepsToObject60: stepsToObject60,
    cellsToObject60: cellsToObject60,
    gridFromCells60: gridFromCells60,
    setTri60Orient: setTri60Orient,
    getTri60Orient: getTri60Orient,
    cellsToOrientObject60: cellsToOrientObject60,
    validateCellsOrient60Object: validateCellsOrient60Object,
    validateCellsStep60Object: validateCellsStep60Object,
    logToArray60: logToArray60,
    validateCellsLog60Array: validateCellsLog60Array,
    tri60Line: tri60Line,
    tri60Majority: tri60Majority,
    tri60IsMajority: tri60IsMajority,
    tri60RowMaxCol: tri60RowMaxCol,
    isTri60InBounds: isTri60InBounds,
    tri60Corners: tri60Corners,
    tri60FromPoint: tri60FromPoint,
    tri60NearestGridPoint: tri60NearestGridPoint,
    neighbors60: neighbors60,
    neighborTri60: neighborTri60,
    nearestEdgeIndex60: nearestEdgeIndex60,
    rhombusCells60: rhombusCells60,
    hexagonCells60: hexagonCells60,
    buildColorPathD60: buildColorPathD60,
    buildAllPaths60: buildAllPaths60,
    buildExplodedPaths60: buildExplodedPaths60,
    mirrorLR60: mirrorLR60,
    mirrorUD60: mirrorUD60,
    mirrorPositions60: mirrorPositions60,
    paintTri60: paintTri60,
    paintTri60Group: paintTri60Group,
    extractCells60: extractCells60,
    transformCells60: transformCells60,
    applyTransform60: applyTransform60,
    snapAngle60: snapAngle60,
    snapEndpoint60: snapEndpoint60,
    lineCells60: lineCells60,
    floodFill60: floodFill60,
    migrateParamsV3toV4: migrateParamsV3toV4,

    // 12. レイヤー（仕様v4 段D）
    LAYER_OPACITY_VALUES: LAYER_OPACITY_VALUES,
    COLOR_MODE_VALUES: COLOR_MODE_VALUES,
    makeLayerId: makeLayerId,
    emptyLayerOfLattice: emptyLayerOfLattice,
    migrateParamsV4toV5: migrateParamsV4toV5,
    reorderLayers: reorderLayers,
    buildLayersExport: buildLayersExport,

    // 12.5 色の割り当て（仕様v4 段E）
    effectiveColorOf: effectiveColorOf,
    migrateParamsV5toV6: migrateParamsV5toV6,

    // 12.6 動きと空間への展開への出口（scene-json.md）
    unitPolygons: unitPolygons,
    unitColorOf: unitColorOf,
    sceneColorOf: sceneColorOf,
    buildSceneGraphics: buildSceneGraphics,

    // 13. ランダム充填（仕様v4 段F）
    makeFillRng: makeFillRng,
    SQUARE_FILL_ELEMENTS: SQUARE_FILL_ELEMENTS,
    TRI60_FILL_ELEMENTS: TRI60_FILL_ELEMENTS,
    FILL_ELEMENT_ALL: FILL_ELEMENT_ALL,
    normalizeFillWeights: normalizeFillWeights,
    pickWeightedColor: pickWeightedColor,
    tri60PointFromVertex: tri60PointFromVertex,
    randomFillSquare: randomFillSquare,
    randomFillTri60: randomFillTri60,
    validateFill: validateFill,

    // 14. 六角形格子（仕様v4 段G）
    createGridHex: createGridHex,
    getHex: getHex,
    setHex: setHex,
    cellsToObjectHex: cellsToObjectHex,
    gridFromCellsHex: gridFromCellsHex,
    hexCenterTriangles: hexCenterTriangles,
    isFullHexCenter: isFullHexCenter,
    isHexEmpty: isHexEmpty,
    nearestHexCenter: nearestHexCenter,
    hexOuterEdges: hexOuterEdges,
    neighborsHex: neighborsHex,
    mirrorLRHex: mirrorLRHex,
    mirrorUDHex: mirrorUDHex,
    mirrorPositionsHex: mirrorPositionsHex,
    paintHex: paintHex,
    buildColorPathDHex: buildColorPathDHex,
    buildAllPathsHex: buildAllPathsHex,
    buildExplodedPathsHex: buildExplodedPathsHex,
    floodFillHex: floodFillHex,
    lineCellsHex: lineCellsHex,
    HEX_FILL_ELEMENTS: HEX_FILL_ELEMENTS,
    randomFillHex: randomFillHex,
    validateCellsHexObject: validateCellsHexObject,
    migrateParamsV6toV7: migrateParamsV6toV7,

    // 15. 汎用格子（LatticeDef。仕様v4 段H・M5「格子の編集」でカイロ五角形/rhombille/レンガを追加）
    LATTICE_DEFS: LATTICE_DEFS,
    GENERIC_LATTICE_IDS: GENERIC_LATTICE_IDS,
    getLatticeDef: getLatticeDef,
    isGenericLattice: isGenericLattice,
    validateLatticeDef: validateLatticeDef,
    registerLatticeDef: registerLatticeDef,
    createGridGeneric: createGridGeneric,
    getGeneric: getGeneric,
    setGeneric: setGeneric,
    isGenericTileValid: isGenericTileValid,
    cellsToObjectGeneric: cellsToObjectGeneric,
    gridFromCellsGeneric: gridFromCellsGeneric,
    tileVertices: tileVertices,
    neighborsGeneric: neighborsGeneric,
    mirrorLRGeneric: mirrorLRGeneric,
    mirrorUDGeneric: mirrorUDGeneric,
    mirrorPositionsGeneric: mirrorPositionsGeneric,
    paintGeneric: paintGeneric,
    buildColorPathDGeneric: buildColorPathDGeneric,
    buildAllPathsGeneric: buildAllPathsGeneric,
    buildExplodedPathsGeneric: buildExplodedPathsGeneric,
    floodFillGeneric: floodFillGeneric,
    genericTileAt: genericTileAt,
    lineCellsGeneric: lineCellsGeneric,
    GENERIC_FILL_ELEMENTS_BY_DEF: GENERIC_FILL_ELEMENTS_BY_DEF,
    randomFillGeneric: randomFillGeneric,
    validateCellsGenericObject: validateCellsGenericObject,
    isKnownFillElement: isKnownFillElement,
    migrateParamsV7toV8: migrateParamsV7toV8,

    // 16. 立体モード（ゴールとロードマップv5 M1「立方体ブラシ」・M3「不可能図形の補助」）
    CUBE_FACE_COLOR: CUBE_FACE_COLOR,
    CUBE_FACE_COLOR_BACK: CUBE_FACE_COLOR_BACK,
    nearestVertex60: nearestVertex60,
    cubeTris60: cubeTris60,
    cubeFaceAt60: cubeFaceAt60,
    paintCube60: paintCube60,
    paintFace60: paintFace60,
    mirrorVerticesForCube60: mirrorVerticesForCube60,
    vertexLineCells60: vertexLineCells60, // 2026-09-17 立方体の「線置き」（なぞりミス対策）

    // 17. 明暗の規則（ゴールとロードマップv5 M2）
    hexToOklab: hexToOklab,
    oklabToHex: oklabToHex,
    oklabToOklch: oklabToOklch,
    shadeFaceIdOf: shadeFaceIdOf,
    shadeFaceAngle: shadeFaceAngle,
    shadeColorForFace: shadeColorForFace,
    migrateParamsV8toV9: migrateParamsV8toV9,
    DENSITY_GRADIENTS: DENSITY_GRADIENTS,
    densityGradientFactor: densityGradientFactor,
    rectNorm01: rectNorm01,
    validateShade: validateShade,

    // 18. 規則で描く（ゴールとロードマップv5 M4）
    FILL_RULES: FILL_RULES,
    SEQ_ORDERS: SEQ_ORDERS,
    SEQ_RULE_KINDS: SEQ_RULE_KINDS,
    SEQ_COLOR_MODES: SEQ_COLOR_MODES,
    FIELD_REFS: FIELD_REFS,
    FIELD_WAVES: FIELD_WAVES,
    NOISE_COLOR_MODES: NOISE_COLOR_MODES,
    SYMMETRY_GROUPS: SYMMETRY_GROUPS,
    buildFillCandidates: buildFillCandidates,
    elementsAllowedFor: elementsAllowedFor,
    orderCandidatesSequence: orderCandidatesSequence,
    isPerfectSquareNum: isPerfectSquareNum,
    isFibonacciNum: isFibonacciNum,
    isPrimeNum: isPrimeNum,
    seqAccept: seqAccept,
    randomFillSequence: randomFillSequence,
    fieldDistance: fieldDistance,
    fieldDensityValue: fieldDensityValue,
    candidatesBBox: candidatesBBox,
    randomFillField: randomFillField,
    valueNoise2D: valueNoise2D,
    randomFillNoise: randomFillNoise,
    symmetryElements: symmetryElements,
    rectContainsGxGy: rectContainsGxGy,
    randomFillSymmetry: randomFillSymmetry,
    migrateParamsV9toV10: migrateParamsV9toV10,

    // 19. M5「格子の編集」（別ツール）由来: 格子ギャラリー・「格子の定義（JSON）を読む」・v10→v11
    migrateParamsV10toV11: migrateParamsV10toV11,

    // 20. 大きな円弧（仕様v6 2026-09-15。委任パケットpacket-big-arc.md）
    arcsToArray: arcsToArray,
    bigArcEdges: bigArcEdges,
    arcBlock: arcBlock,
    arcInBoundsBlock: arcInBoundsBlock,
    arcAt: arcAt,
    clearArcsAtCell: clearArcsAtCell,
    mirrorArcPositions: mirrorArcPositions,
    paintBigArc: paintBigArc,
    extractArcsInRect: extractArcsInRect,
    transformArc: transformArc,
    validateArcsArray: validateArcsArray,
    migrateParamsV11toV12: migrateParamsV11toV12,

    // 21. 書き出しの形「要素ごとに分ける」（2026-09-16）
    migrateParamsV12toV13: migrateParamsV12toV13,

    // 22. 色のレイヤー化・立方体の線置き（2026-09-17）
    DEFAULT_LAYER_COLORS: DEFAULT_LAYER_COLORS,
    migrateParamsV13toV14: migrateParamsV13toV14
  };
});
