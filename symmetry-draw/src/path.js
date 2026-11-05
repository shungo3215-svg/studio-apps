/* path.js — 図形はすべてベジェのパス1種: nodes:[{x,y,in:[x,y]|null,out:[x,y]|null}]。
   ここは DOM に触らない純粋な関数だけ（座標はモチーフ座標）。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var K = 0.5522847498;   // 楕円を4点のベジェで近似する係数

  function r3(v) { return Math.round(v * 1000) / 1000; }
  function P(p) { return p ? [r3(p[0]), r3(p[1])] : null; }
  function N(x, y, i, o) { return { x: r3(x), y: r3(y), in: P(i), out: P(o) }; }

  function seg(a, b) {
    if (a.out || b.in) {
      var o = a.out || [a.x, a.y], i = b.in || [b.x, b.y];
      return 'C' + o[0] + ' ' + o[1] + ' ' + i[0] + ' ' + i[1] + ' ' + b.x + ' ' + b.y;
    }
    return 'L' + b.x + ' ' + b.y;
  }
  /* SVG の d。閉じる最後の辺が直線なら Z だけで閉じる（始点と重なるアンカーを増やさない） */
  function toD(nodes, closed) {
    if (!nodes.length) return '';
    var d = 'M' + nodes[0].x + ' ' + nodes[0].y;
    for (var i = 1; i < nodes.length; i++) d += seg(nodes[i - 1], nodes[i]);
    if (closed && nodes.length > 1) {
      var a = nodes[nodes.length - 1], b = nodes[0];
      if (a.out || b.in) d += seg(a, b);
      d += 'Z';
    }
    return d;
  }

  /* ---- 図形の元になるアンカー列（座標は呼び出し側が決めた平面。あとで mapNodes で戻す） ---- */
  function rectNodes(x0, y0, x1, y1) { return [N(x0, y0), N(x1, y0), N(x1, y1), N(x0, y1)]; }
  function lineNodes(x0, y0, x1, y1) { return [N(x0, y0), N(x1, y1)]; }
  function ellipseNodes(cx, cy, rx, ry) {
    return [
      N(cx, cy - ry, [cx - K * rx, cy - ry], [cx + K * rx, cy - ry]),
      N(cx + rx, cy, [cx + rx, cy - K * ry], [cx + rx, cy + K * ry]),
      N(cx, cy + ry, [cx + K * rx, cy + ry], [cx - K * rx, cy + ry]),
      N(cx - rx, cy, [cx - rx, cy + K * ry], [cx - rx, cy - K * ry])
    ];
  }
  function polygonNodes(cx, cy, r, a0, n) {
    var out = [];
    for (var k = 0; k < n; k++) {
      var a = a0 + 2 * Math.PI * k / n;
      out.push(N(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    return out;
  }
  /* 行列 m=[a,b,c,d,e,f] でアンカーとハンドルを写す（コピーの逆行列で、画面の図形をモチーフ座標へ戻す） */
  function mapNodes(nodes, m) {
    function ap(p) { return Geom.apply(m, p[0], p[1]); }
    return nodes.map(function (n) {
      var q = ap([n.x, n.y]);
      return N(q[0], q[1], n.in && ap(n.in), n.out && ap(n.out));
    });
  }

  /* ---- 点列 → 少ないアンカーのベジェ（000_kit/curve-fit.js） ---- */
  function segsToNodes(segs) {
    var nodes = [], closed = false;
    segs.forEach(function (s) {
      if (s.t === 'M' || s.t === 'L') nodes.push({ x: s.x, y: s.y, in: null, out: null });
      else if (s.t === 'C') {
        nodes[nodes.length - 1].out = [s.x1, s.y1];
        nodes.push({ x: s.x, y: s.y, in: [s.x2, s.y2], out: null });
      } else if (s.t === 'Z') closed = true;
    });
    if (closed && nodes.length > 1) {
      var a = nodes[nodes.length - 1], b = nodes[0];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) { b.in = a.in; nodes.pop(); }
    }
    return { nodes: nodes.map(function (n) { return N(n.x, n.y, n.in, n.out); }), closed: closed };
  }
  /* 閉じた点列 → 少ないアンカーの閉じたベジェ（面を作る時、折れ線が長すぎる場合に減らす） */
  function fitClosed(points, tol) {
    var pts = points.slice();
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
    if (pts.length < 3) return null;
    var segs = StudioCurveFit.fitPolyline(pts.concat([pts[0]]), { tol: tol, closed: true });
    var r = segsToNodes(segs);
    return r.nodes.length >= 3 ? r.nodes : null;
  }
  function fitPoints(points, tol) {
    var pts = [];
    points.forEach(function (p) {
      var q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) pts.push(p);
    });
    if (pts.length < 2) return null;
    if (pts.length === 2) return [N(pts[0][0], pts[0][1]), N(pts[1][0], pts[1][1])];
    var segs = StudioCurveFit.fitPolyline(pts, { tol: tol, closed: false });
    return segsToNodes(segs).nodes;
  }

  /* ---- 当たり判定: ベジェを折れ線にして、線からの距離と塗りの内側で見る ---- */
  function flatten(nodes, closed, per) {
    per = per || 10;
    var out = [];
    if (!nodes.length) return out;
    out.push([nodes[0].x, nodes[0].y]);
    var n = nodes.length, last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var a = nodes[i], b = nodes[(i + 1) % n];
      if (!(a.out || b.in)) { out.push([b.x, b.y]); continue; }
      var o = a.out || [a.x, a.y], q = b.in || [b.x, b.y];
      for (var t = 1; t <= per; t++) {
        var u = t / per, v = 1 - u;
        out.push([
          v * v * v * a.x + 3 * v * v * u * o[0] + 3 * v * u * u * q[0] + u * u * u * b.x,
          v * v * v * a.y + 3 * v * v * u * o[1] + 3 * v * u * u * q[1] + u * u * u * b.y
        ]);
      }
    }
    return out;
  }
  function distSeg(x, y, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  }
  function inside(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var pi = poly[i], pj = poly[j];
      if ((pi[1] > y) !== (pj[1] > y) && x < (pj[0] - pi[0]) * (y - pi[1]) / (pj[1] - pi[1]) + pi[0]) c = !c;
    }
    return c;
  }
  /* it の上（または線の近く tol 以内）か */
  function hit(it, x, y, tol) {
    var bb = bbox(it.nodes, true), pad = (it.stroke === 'none' ? 0 : it.sw / 2) + tol;
    if (x < bb.x0 - pad || x > bb.x1 + pad || y < bb.y0 - pad || y > bb.y1 + pad) return false;
    var poly = flatten(it.nodes, it.closed);
    if (it.closed && it.fill !== 'none' && inside(poly, x, y)) return true;
    if (it.stroke === 'none' && !(it.closed && it.fill !== 'none')) return false;
    var reach = (it.stroke === 'none' ? 0 : it.sw / 2) + tol;
    var n = it.closed ? poly.length : poly.length - 1;
    for (var i = 0; i < n; i++) if (distSeg(x, y, poly[i], poly[(i + 1) % poly.length]) <= reach) return true;
    return false;
  }

  /* アンカー（と、withHandles ならハンドル）を囲む箱 */
  function bbox(nodes, withHandles) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    function add(x, y) { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); }
    nodes.forEach(function (n) {
      add(n.x, n.y);
      if (withHandles) { if (n.in) add(n.in[0], n.in[1]); if (n.out) add(n.out[0], n.out[1]); }
    });
    return b;
  }
  /* ベジェの実際の広がり（曲線を折れ線にして囲む）。選択の枠に使う */
  function curveBox(nodes, closed) {
    var pts = flatten(nodes, closed, 12), b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    pts.forEach(function (p) { b.x0 = Math.min(b.x0, p[0]); b.y0 = Math.min(b.y0, p[1]); b.x1 = Math.max(b.x1, p[0]); b.y1 = Math.max(b.y1, p[1]); });
    return b;
  }

  /* <path> 1本ぶんの SVG 文字列（画面にも書き出しにも同じものを使う） */
  function itemSvg(it) {
    var fill = it.closed ? it.fill : 'none';
    var s = '<path d="' + toD(it.nodes, it.closed) + '" fill="' + fill + '" stroke="' + it.stroke + '"';
    if (it.stroke !== 'none') s += ' stroke-width="' + it.sw + '" stroke-linecap="round" stroke-linejoin="round"';
    if (it.opacity < 1) s += ' opacity="' + it.opacity + '"';
    return s + '/>';
  }

  SD.path = {
    r3: r3, N: N, toD: toD, rectNodes: rectNodes, lineNodes: lineNodes, ellipseNodes: ellipseNodes,
    polygonNodes: polygonNodes, mapNodes: mapNodes, fitPoints: fitPoints, fitClosed: fitClosed, flatten: flatten, hit: hit, bbox: bbox, curveBox: curveBox, itemSvg: itemSvg
  };
})();
