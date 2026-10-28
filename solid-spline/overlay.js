/* ============================================================================
   overlay.js — 「載せるもの」（立体と一緒に動く文字・グラフィック）の純関数群。
   DOM に依存しない（ブラウザの index.html からも node のテストからも同じファイルを読む）。
   depth.js/outline.js/bspline.js/swell_import.js と同じ UMD 形。

   貼った SVG は window.SvgIn.parse（DOMParser/getScreenCTM 前提）を使えない
   （SvgIn.parse は window 直結でブラウザ専用・node で require できない）ため、
   ここでは文字列だけを読む簡易パーサを独自に持つ（正規表現ベース。<defs>等の非表示
   サブツリーは丸ごと除去し、<g>のtransform/fill/strokeは親から子へ引き継ぐ）。

   段: 2026-09-25 追加。「立体といっしょにグニャッてなってほしい」（沿わせる）と
   「置き方はどちらも選びたい」（空間に置く）の2つの置き方を持つ。
   ========================================================================== */
(function (root, factory) {
  var Overlay = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Overlay;
  if (root) root.Overlay = Overlay;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;
  var K = 0.5522847498307936; // 4/3*(sqrt(2)-1)。円弧の3次ベジェ近似の腕の長さ係数。

  /* ==========================================================================
     1. アフィン変換（transform属性の文字列 → [a,b,c,d,e,f]）
     ========================================================================== */
  function matMul(m, n) { // m∘n（nを先に適用）。svgin.jsと同じ規約。
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  function applyMat(m, p) {
    return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  }
  function parseTransform(str) {
    if (!str) return [1, 0, 0, 1, 0, 0];
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    var acc = [1, 0, 0, 1, 0, 0], m;
    while ((m = re.exec(str))) {
      var fn = m[1];
      var args = m[2].split(/[\s,]+/).filter(function (s) { return s !== ''; }).map(parseFloat);
      var mm = [1, 0, 0, 1, 0, 0];
      if (fn === 'matrix' && args.length >= 6) mm = args.slice(0, 6);
      else if (fn === 'translate') mm = [1, 0, 0, 1, args[0] || 0, args.length > 1 ? args[1] : 0];
      else if (fn === 'scale') { var sx = args[0] != null ? args[0] : 1, sy = args.length > 1 ? args[1] : sx; mm = [sx, 0, 0, sy, 0, 0]; }
      else if (fn === 'rotate') {
        var deg = args[0] || 0, rad = deg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
        if (args.length >= 3) {
          var cx = args[1], cy = args[2];
          mm = matMul(matMul([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        } else mm = [c, s, -s, c, 0, 0];
      } else if (fn === 'skewX') { var kx = Math.tan((args[0] || 0) * Math.PI / 180); mm = [1, 0, kx, 1, 0, 0]; }
      else if (fn === 'skewY') { var ky = Math.tan((args[0] || 0) * Math.PI / 180); mm = [1, ky, 0, 1, 0, 0]; }
      acc = matMul(acc, mm);
    }
    return acc;
  }

  /* ==========================================================================
     2. d 属性のパーサ（M/L/H/V/C/S/Q/T/A/Z・絶対/相対）
     戻り値: [{segs:[{type:'L',a,b}|{type:'C',p0,p1,p2,p3}], closed:bool}, …]（サブパスごと）
     ========================================================================== */
  function quadToCubic(p0, q, p3) {
    return { type: 'C', p0: p0, p1: [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])], p2: [p3[0] + 2 / 3 * (q[0] - p3[0]), p3[1] + 2 / 3 * (q[1] - p3[1])], p3: p3 };
  }
  function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
    if (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < EPS || ry < EPS) return [{ type: 'L', a: [x1, y1], b: [x2, y2] }];
    var phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    var lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { var k = Math.sqrt(lam); rx *= k; ry *= k; }
    var rx2 = rx * rx, ry2 = ry * ry;
    var den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    var num = rx2 * ry2 - den;
    var co = Math.sqrt(Math.max(0, num / den));
    if (largeArc === sweep) co = -co;
    var cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    var cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    var ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry, vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    var th1 = Math.atan2(uy, ux);
    var dth = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dth > 0) dth -= Math.PI * 2;
    if (sweep && dth < 0) dth += Math.PI * 2;
    function P(t) { var c = Math.cos(t), s = Math.sin(t); return [cx + rx * c * cp - ry * s * sp, cy + rx * c * sp + ry * s * cp]; }
    function D(t) { var c = Math.cos(t), s = Math.sin(t); return [-rx * s * cp - ry * c * sp, -rx * s * sp + ry * c * cp]; }
    var n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
    var d = dth / n, out = [], alpha = 4 / 3 * Math.tan(d / 4);
    for (var i = 0; i < n; i++) {
      var t0 = th1 + d * i, t1 = t0 + d;
      var p0 = P(t0), p3 = P(t1), d0 = D(t0), d3 = D(t1);
      if (i === 0) p0 = [x1, y1];
      if (i === n - 1) p3 = [x2, y2];
      out.push({ type: 'C', p0: p0, p1: [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1]], p2: [p3[0] - alpha * d3[0], p3[1] - alpha * d3[1]], p3: p3 });
    }
    return out;
  }
  function parsePathD(d) {
    var s = String(d == null ? '' : d), n = s.length, i = 0;
    function isWS(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ','; }
    function skipSep() { while (i < n && isWS(s.charAt(i))) i++; }
    function readNumber() {
      skipSep();
      var start = i, digits = false, c = s.charAt(i);
      if (c === '+' || c === '-') i++;
      while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') { i++; digits = true; }
      if (i < n && s.charAt(i) === '.') { i++; while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') { i++; digits = true; } }
      if (!digits) return null;
      if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
        var j = i + 1, ed = false;
        if (j < n && (s.charAt(j) === '+' || s.charAt(j) === '-')) j++;
        while (j < n && s.charAt(j) >= '0' && s.charAt(j) <= '9') { j++; ed = true; }
        if (ed) i = j;
      }
      var v = parseFloat(s.slice(start, i));
      return isFinite(v) ? v : null;
    }
    function readFlag() {
      skipSep();
      var c = s.charAt(i);
      if (c === '0' || c === '1') { i++; return c === '1' ? 1 : 0; }
      var v = readNumber();
      return v == null ? null : (v ? 1 : 0);
    }
    var subs = [], cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', prevCtrl = null, prevKind = '';
    function open() { if (!cur) { cur = { segs: [], closed: false }; sx = x; sy = y; } }
    function flush() { if (cur && cur.segs.length) subs.push(cur); cur = null; }
    function bail() { flush(); return subs; }
    var CMD = /[MmLlHhVvCcSsQqTtAaZz]/;
    for (;;) {
      skipSep();
      if (i >= n) break;
      var ch = s.charAt(i);
      if (CMD.test(ch)) { cmd = ch; i++; skipSep(); }
      else if (!cmd) break;
      var rel = cmd >= 'a' && cmd <= 'z';
      var CU = cmd.toUpperCase();
      var a1, a2, nx, ny, p1, p2, p3, q;
      if (CU === 'M') {
        a1 = readNumber(); a2 = readNumber(); if (a1 == null || a2 == null) return bail();
        flush();
        x = rel ? x + a1 : a1; y = rel ? y + a2 : a2; open();
        prevKind = ''; cmd = rel ? 'l' : 'L';
      } else if (CU === 'L') {
        a1 = readNumber(); a2 = readNumber(); if (a1 == null || a2 == null) return bail();
        open();
        nx = rel ? x + a1 : a1; ny = rel ? y + a2 : a2;
        cur.segs.push({ type: 'L', a: [x, y], b: [nx, ny] });
        x = nx; y = ny; prevKind = '';
      } else if (CU === 'H') {
        a1 = readNumber(); if (a1 == null) return bail();
        open();
        nx = rel ? x + a1 : a1;
        cur.segs.push({ type: 'L', a: [x, y], b: [nx, y] });
        x = nx; prevKind = '';
      } else if (CU === 'V') {
        a1 = readNumber(); if (a1 == null) return bail();
        open();
        ny = rel ? y + a1 : a1;
        cur.segs.push({ type: 'L', a: [x, y], b: [x, ny] });
        y = ny; prevKind = '';
      } else if (CU === 'C') {
        var vs = []; for (var k = 0; k < 6; k++) { var v = readNumber(); if (v == null) return bail(); vs.push(v); }
        open();
        p1 = [rel ? x + vs[0] : vs[0], rel ? y + vs[1] : vs[1]];
        p2 = [rel ? x + vs[2] : vs[2], rel ? y + vs[3] : vs[3]];
        p3 = [rel ? x + vs[4] : vs[4], rel ? y + vs[5] : vs[5]];
        cur.segs.push({ type: 'C', p0: [x, y], p1: p1, p2: p2, p3: p3 });
        x = p3[0]; y = p3[1]; prevCtrl = p2; prevKind = 'C';
      } else if (CU === 'S') {
        var vs2 = []; for (var k2 = 0; k2 < 4; k2++) { var v2 = readNumber(); if (v2 == null) return bail(); vs2.push(v2); }
        open();
        p1 = (prevKind === 'C' && prevCtrl) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
        p2 = [rel ? x + vs2[0] : vs2[0], rel ? y + vs2[1] : vs2[1]];
        p3 = [rel ? x + vs2[2] : vs2[2], rel ? y + vs2[3] : vs2[3]];
        cur.segs.push({ type: 'C', p0: [x, y], p1: p1, p2: p2, p3: p3 });
        x = p3[0]; y = p3[1]; prevCtrl = p2; prevKind = 'C';
      } else if (CU === 'Q') {
        var qx = readNumber(), qy = readNumber(), p3x = readNumber(), p3y = readNumber();
        if (qx == null || qy == null || p3x == null || p3y == null) return bail();
        open();
        q = [rel ? x + qx : qx, rel ? y + qy : qy];
        p3 = [rel ? x + p3x : p3x, rel ? y + p3y : p3y];
        cur.segs.push(quadToCubic([x, y], q, p3));
        x = p3[0]; y = p3[1]; prevCtrl = q; prevKind = 'Q';
      } else if (CU === 'T') {
        var tx2 = readNumber(), ty2 = readNumber();
        if (tx2 == null || ty2 == null) return bail();
        open();
        q = (prevKind === 'Q' && prevCtrl) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
        p3 = [rel ? x + tx2 : tx2, rel ? y + ty2 : ty2];
        cur.segs.push(quadToCubic([x, y], q, p3));
        x = p3[0]; y = p3[1]; prevCtrl = q; prevKind = 'Q';
      } else if (CU === 'A') {
        var rx = readNumber(), ry = readNumber(), rot = readNumber();
        if (rx == null || ry == null || rot == null) return bail();
        var laf = readFlag(), swf = readFlag();
        if (laf == null || swf == null) return bail();
        var ex = readNumber(), ey = readNumber();
        if (ex == null || ey == null) return bail();
        open();
        nx = rel ? x + ex : ex; ny = rel ? y + ey : ey;
        var arcs = arcToCubics(x, y, rx, ry, rot, laf, swf, nx, ny);
        for (var ai = 0; ai < arcs.length; ai++) cur.segs.push(arcs[ai]);
        x = nx; y = ny; prevKind = '';
      } else if (CU === 'Z') {
        if (cur) {
          if (Math.abs(x - sx) > EPS || Math.abs(y - sy) > EPS) cur.segs.push({ type: 'L', a: [x, y], b: [sx, sy] });
          cur.closed = true;
          flush();
        }
        x = sx; y = sy; prevKind = ''; cmd = '';
      } else {
        return bail();
      }
    }
    flush();
    return subs;
  }

  /* ==========================================================================
     3. 基本図形（rect/circle/ellipse/polygon/polyline）を segs へ
     ========================================================================== */
  function rectSegs(x, y, w, h, rx, ry) {
    if (!(w > 0) || !(h > 0)) return [];
    rx = Math.min(Math.max(rx || 0, 0), w / 2); ry = Math.min(Math.max(ry || 0, 0), h / 2);
    if (rx < EPS || ry < EPS) {
      return [
        { type: 'L', a: [x, y], b: [x + w, y] },
        { type: 'L', a: [x + w, y], b: [x + w, y + h] },
        { type: 'L', a: [x + w, y + h], b: [x, y + h] },
        { type: 'L', a: [x, y + h], b: [x, y] }
      ];
    }
    var kx = rx * K, ky = ry * K, x0 = x, x1 = x + w, y0 = y, y1 = y + h, s = [];
    s.push({ type: 'L', a: [x0 + rx, y0], b: [x1 - rx, y0] });
    s.push({ type: 'C', p0: [x1 - rx, y0], p1: [x1 - rx + kx, y0], p2: [x1, y0 + ry - ky], p3: [x1, y0 + ry] });
    s.push({ type: 'L', a: [x1, y0 + ry], b: [x1, y1 - ry] });
    s.push({ type: 'C', p0: [x1, y1 - ry], p1: [x1, y1 - ry + ky], p2: [x1 - rx + kx, y1], p3: [x1 - rx, y1] });
    s.push({ type: 'L', a: [x1 - rx, y1], b: [x0 + rx, y1] });
    s.push({ type: 'C', p0: [x0 + rx, y1], p1: [x0 + rx - kx, y1], p2: [x0, y1 - ry + ky], p3: [x0, y1 - ry] });
    s.push({ type: 'L', a: [x0, y1 - ry], b: [x0, y0 + ry] });
    s.push({ type: 'C', p0: [x0, y0 + ry], p1: [x0, y0 + ry - ky], p2: [x0 + rx - kx, y0], p3: [x0 + rx, y0] });
    return s;
  }
  function ellipseSegs(cx, cy, rx, ry) {
    var kx = rx * K, ky = ry * K;
    return [
      { type: 'C', p0: [cx + rx, cy], p1: [cx + rx, cy + ky], p2: [cx + kx, cy + ry], p3: [cx, cy + ry] },
      { type: 'C', p0: [cx, cy + ry], p1: [cx - kx, cy + ry], p2: [cx - rx, cy + ky], p3: [cx - rx, cy] },
      { type: 'C', p0: [cx - rx, cy], p1: [cx - rx, cy - ky], p2: [cx - kx, cy - ry], p3: [cx, cy - ry] },
      { type: 'C', p0: [cx, cy - ry], p1: [cx + kx, cy - ry], p2: [cx + rx, cy - ky], p3: [cx + rx, cy] }
    ];
  }
  function circleSegs(cx, cy, r) { return ellipseSegs(cx, cy, r, r); }
  function polySegsFromPts(pts, closed) {
    var segs = [];
    for (var i = 0; i < pts.length - 1; i++) segs.push({ type: 'L', a: pts[i], b: pts[i + 1] });
    if (closed && pts.length > 1) segs.push({ type: 'L', a: pts[pts.length - 1], b: pts[0] });
    return segs;
  }
  function readAllNumbers(str) {
    var s = String(str || ''), n = s.length, i = 0, out = [];
    function isSep(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ','; }
    while (i < n) {
      while (i < n && isSep(s.charAt(i))) i++;
      if (i >= n) break;
      var start = i, digits = false, c = s.charAt(i);
      if (c === '+' || c === '-') i++;
      while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') { i++; digits = true; }
      if (i < n && s.charAt(i) === '.') { i++; while (i < n && s.charAt(i) >= '0' && s.charAt(i) <= '9') { i++; digits = true; } }
      if (!digits) { i++; continue; }
      if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
        var j = i + 1, ed = false;
        if (j < n && (s.charAt(j) === '+' || s.charAt(j) === '-')) j++;
        while (j < n && s.charAt(j) >= '0' && s.charAt(j) <= '9') { j++; ed = true; }
        if (ed) i = j;
      }
      var v = parseFloat(s.slice(start, i));
      if (isFinite(v)) out.push(v);
    }
    return out;
  }

  /* ==========================================================================
     4. 折れ線化（曲線を適応分割・1個あたりの点数に上限）
     ========================================================================== */
  function evalCubic(s, t) {
    var u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [w0 * s.p0[0] + w1 * s.p1[0] + w2 * s.p2[0] + w3 * s.p3[0], w0 * s.p0[1] + w1 * s.p1[1] + w2 * s.p2[1] + w3 * s.p3[1]];
  }
  function subdivideCubic(s, t0, t1, tol, out, depth) {
    var p0 = evalCubic(s, t0), p1 = evalCubic(s, t1), tm = (t0 + t1) / 2, pm = evalCubic(s, tm);
    var dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy), dist;
    if (len < 1e-9) dist = Math.hypot(pm[0] - p0[0], pm[1] - p0[1]);
    else { var tt = ((pm[0] - p0[0]) * dx + (pm[1] - p0[1]) * dy) / (len * len); var px = p0[0] + dx * tt, py = p0[1] + dy * tt; dist = Math.hypot(pm[0] - px, pm[1] - py); }
    if (dist <= tol || depth >= 14) { out.push(p1); return; }
    subdivideCubic(s, t0, tm, tol, out, depth + 1);
    subdivideCubic(s, tm, t1, tol, out, depth + 1);
  }
  function decimate(pts, maxPoints) {
    var m = pts.length;
    if (m <= maxPoints || maxPoints < 2) return pts;
    var out = [];
    for (var i = 0; i < maxPoints; i++) out.push(pts[Math.round(i * (m - 1) / (maxPoints - 1))]);
    return out;
  }
  function flattenSubpath(segs, tol, maxPoints) {
    if (!segs || !segs.length) return [];
    var pts = [(segs[0].type === 'L' ? segs[0].a : segs[0].p0).slice()];
    segs.forEach(function (s) {
      if (s.type === 'L') pts.push(s.b.slice());
      else subdivideCubic(s, 0, 1, tol, pts, 0);
    });
    return decimate(pts, maxPoints);
  }

  /* ==========================================================================
     5. SVG文字列 → shapes/texts（正規表現ベースの簡易タグ走査。DOM非依存）
     <defs>/<clipPath>/<mask>/<symbol>/<pattern>/<style>/<script> は中身ごと除去。
     <g>のtransform/fill/stroke/stroke-widthは子へ継承（CSSの初期値: fill=黒・stroke=なし）。
     display:noneの祖先を持つ要素は読まない。
     ========================================================================== */
  var STRIP_TAGS = ['defs', 'clippath', 'mask', 'symbol', 'pattern', 'style', 'script'];
  function stripSubtreeOne(text, tag) {
    var openRe = new RegExp('<' + tag + '(?:\\s[^>]*)?(/)?>', 'gi');
    var closeTag = '</' + tag + '>';
    var result = '', pos = 0, m;
    openRe.lastIndex = 0;
    while ((m = openRe.exec(text))) {
      var selfClose = m[1] === '/';
      result += text.slice(pos, m.index);
      if (selfClose) { pos = m.index + m[0].length; openRe.lastIndex = pos; continue; }
      var searchFrom = m.index + m[0].length;
      var depth = 1, endIdx = text.length;
      var scanRe = new RegExp('<' + tag + '(?:\\s[^>]*)?(/?)>|</' + tag + '>', 'gi');
      scanRe.lastIndex = searchFrom;
      var mm;
      while ((mm = scanRe.exec(text))) {
        if (mm[0].toLowerCase() === closeTag) { depth--; if (depth === 0) { endIdx = mm.index + mm[0].length; break; } }
        else if (mm[1] !== '/') depth++;
      }
      pos = endIdx;
      openRe.lastIndex = pos;
    }
    result += text.slice(pos);
    return result;
  }
  function stripSubtrees(text) {
    STRIP_TAGS.forEach(function (tag) { text = stripSubtreeOne(text, tag); });
    return text;
  }
  function styleMap(styleStr) {
    var out = {};
    (styleStr || '').split(';').forEach(function (kv) {
      var idx = kv.indexOf(':'); if (idx < 0) return;
      var k = kv.slice(0, idx).trim().toLowerCase(), v = kv.slice(idx + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }
  function resolveFill(attrs, parentFill) {
    var st = styleMap(attrs.style);
    var v = st.fill != null ? st.fill : attrs.fill;
    if (v == null) return parentFill;
    if (v === 'none' || v === 'transparent') return null;
    return v;
  }
  function resolveStroke(attrs, parentStroke) {
    var st = styleMap(attrs.style);
    var v = st.stroke != null ? st.stroke : attrs.stroke;
    if (v == null) return parentStroke;
    if (v === 'none') return null;
    return v;
  }
  function resolveStrokeWidth(attrs, parentWidth) {
    var st = styleMap(attrs.style);
    var v = st['stroke-width'] != null ? st['stroke-width'] : attrs['stroke-width'];
    if (v == null) return parentWidth;
    var n = parseFloat(v);
    return isFinite(n) ? n : parentWidth;
  }
  /* 段9: fill-rule（穴の判定規則）。style優先・属性・継承の順（fill/strokeと同じ規約）。
     初期値はSVGの初期値どおりnonzero。値が不正ならparentへフォールバックする。 */
  function resolveFillRule(attrs, parentRule) {
    var st = styleMap(attrs.style);
    var v = st['fill-rule'] != null ? st['fill-rule'] : attrs['fill-rule'];
    if (v == null) return parentRule;
    v = String(v).trim().toLowerCase();
    return (v === 'evenodd' || v === 'nonzero') ? v : parentRule;
  }
  function sanitizeText(raw) {
    var t = String(raw || '').replace(/<[^>]+>/g, '');
    t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }
  var ELS = 'path|rect|circle|ellipse|line|polygon|polyline|text|g';
  var TAG_RE = new RegExp('<(/?)(' + ELS + ')\\b((?:[^<>"\']|"[^"]*"|\'[^\']*\')*?)(/?)>', 'gi');
  var ATTR_RE = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-\w:.]*)\s*=\s*'([^']*)'/g;
  function parseAttrs(s) {
    var out = {}, m; ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s))) { if (m[1] != null) out[m[1].toLowerCase()] = m[2]; else out[m[3].toLowerCase()] = m[4]; }
    return out;
  }
  function extractShapes(text) {
    text = String(text || '').replace(/<!--[\s\S]*?-->/g, '');
    text = stripSubtrees(text);
    var stack = [{ mat: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: null, strokeWidth: 1, fillRule: 'nonzero', hidden: false }];
    var shapes = [], texts = [], textCapture = null;
    TAG_RE.lastIndex = 0;
    var m;
    while ((m = TAG_RE.exec(text))) {
      var closing = !!m[1], tag = m[2].toLowerCase(), attrStr = m[3] || '', selfClose = !!m[4];
      if (closing) {
        if (tag === 'g') { if (stack.length > 1) stack.pop(); }
        else if (tag === 'text') {
          if (textCapture) {
            var raw = text.slice(textCapture.startIdx, m.index);
            var content = sanitizeText(raw);
            if (content) texts.push({ x: textCapture.x, y: textCapture.y, text: content, fontSize: textCapture.fontSize, fill: textCapture.fill, mat: textCapture.mat });
            textCapture = null;
          }
          if (stack.length > 1) stack.pop();
        }
        continue;
      }
      var parent = stack[stack.length - 1];
      var attrs = parseAttrs(attrStr);
      var hidden = parent.hidden || attrs.display === 'none' || /display\s*:\s*none/.test(attrs.style || '');
      var mat = matMul(parent.mat, parseTransform(attrs.transform || ''));
      var fill = resolveFill(attrs, parent.fill);
      var stroke = resolveStroke(attrs, parent.stroke);
      var strokeWidth = resolveStrokeWidth(attrs, parent.strokeWidth);
      var fillRule = resolveFillRule(attrs, parent.fillRule);
      if (tag === 'g') {
        if (!selfClose) stack.push({ mat: mat, fill: fill, stroke: stroke, strokeWidth: strokeWidth, fillRule: fillRule, hidden: hidden });
        continue;
      }
      if (hidden) {
        if (tag === 'text' && !selfClose) stack.push({ mat: mat, fill: fill, stroke: stroke, strokeWidth: strokeWidth, fillRule: fillRule, hidden: true });
        continue;
      }
      if (tag === 'text') {
        if (!selfClose) {
          textCapture = { startIdx: m.index + m[0].length, x: parseFloat(attrs.x) || 0, y: parseFloat(attrs.y) || 0, fontSize: parseFloat(attrs['font-size']) || 16, fill: fill, mat: mat };
          stack.push({ mat: mat, fill: fill, stroke: stroke, strokeWidth: strokeWidth, fillRule: fillRule, hidden: false });
        }
        continue;
      }
      var segsList = null, closedList = null;
      if (tag === 'path') {
        var subs = parsePathD(attrs.d || '');
        segsList = subs.map(function (sp) { return sp.segs; });
        closedList = subs.map(function (sp) { return sp.closed; });
      } else if (tag === 'rect') {
        var rxA = attrs.rx, ryA = attrs.ry, rx = parseFloat(rxA), ry = parseFloat(ryA);
        if (!isFinite(rx) && !isFinite(ry)) rx = ry = 0;
        else if (!isFinite(rx)) rx = ry; else if (!isFinite(ry)) ry = rx;
        var rs = rectSegs(parseFloat(attrs.x) || 0, parseFloat(attrs.y) || 0, parseFloat(attrs.width) || 0, parseFloat(attrs.height) || 0, rx, ry);
        if (rs.length) { segsList = [rs]; closedList = [true]; }
      } else if (tag === 'circle') {
        var r = parseFloat(attrs.r) || 0;
        if (r > 0) { segsList = [circleSegs(parseFloat(attrs.cx) || 0, parseFloat(attrs.cy) || 0, r)]; closedList = [true]; }
      } else if (tag === 'ellipse') {
        var erx = parseFloat(attrs.rx) || 0, ery = parseFloat(attrs.ry) || 0;
        if (erx > 0 && ery > 0) { segsList = [ellipseSegs(parseFloat(attrs.cx) || 0, parseFloat(attrs.cy) || 0, erx, ery)]; closedList = [true]; }
      } else if (tag === 'line') {
        segsList = [[{ type: 'L', a: [parseFloat(attrs.x1) || 0, parseFloat(attrs.y1) || 0], b: [parseFloat(attrs.x2) || 0, parseFloat(attrs.y2) || 0] }]];
        closedList = [false];
        fill = null; // 線分に面積は無いので塗りは付けない
      } else if (tag === 'polygon' || tag === 'polyline') {
        var nums = readAllNumbers(attrs.points || ''), pts = [];
        for (var pi = 0; pi + 1 < nums.length; pi += 2) pts.push([nums[pi], nums[pi + 1]]);
        if (pts.length > 1) {
          var pClosed = (tag === 'polygon');
          segsList = [polySegsFromPts(pts, pClosed)];
          closedList = [pClosed];
        }
      }
      if (segsList) {
        // 段9: 1要素（path等）が持つ複数サブパス（穴を含む）を1つのshapeにまとめる（subs配列）。
        // 別々のshapeに分けると、穴のサブパスが独立して塗られてしまう（文字の中の穴が黒くなる不具合）。
        var subsMapped = [];
        segsList.forEach(function (segs, idx) {
          if (!segs || !segs.length) return;
          var mapped = segs.map(function (s) {
            return s.type === 'L' ? { type: 'L', a: applyMat(mat, s.a), b: applyMat(mat, s.b) }
              : { type: 'C', p0: applyMat(mat, s.p0), p1: applyMat(mat, s.p1), p2: applyMat(mat, s.p2), p3: applyMat(mat, s.p3) };
          });
          subsMapped.push({ segs: mapped, closed: !!closedList[idx] });
        });
        if (subsMapped.length) shapes.push({ subs: subsMapped, fill: fill, stroke: stroke, strokeWidth: strokeWidth, fillRule: fillRule });
      }
    }
    return { shapes: shapes, texts: texts };
  }

  /* ==========================================================================
     6. importSvg（段1本体）: SVG文字列 → parts（bboxで(s,t)∈[0,1]²に正規化）
     ========================================================================== */
  function importSvg(text, opts) {
    opts = opts || {};
    var tol = opts.tol != null ? opts.tol : 0.2;
    var maxPointsPerShape = opts.maxPointsPerShape != null ? opts.maxPointsPerShape : 160;
    var ext;
    try { ext = extractShapes(text); } catch (e) { return { ok: false, error: 'SVGを読めませんでした', parts: [], bboxW: 1, bboxH: 1 }; }
    var raw = [];
    ext.shapes.forEach(function (sh) {
      // 段9: 同じ元要素のサブパス（穴を含む）を subpaths 配列にまとめて1個の part にする。
      var subpaths = [], closedArr = [];
      (sh.subs || []).forEach(function (sp) {
        var pts = flattenSubpath(sp.segs, tol, maxPointsPerShape);
        if (pts.length < 2) return;
        subpaths.push(pts);
        closedArr.push(!!sp.closed);
      });
      if (!subpaths.length) return;
      raw.push({ kind: 'poly', subpaths: subpaths, closed: closedArr, fill: sh.fill, stroke: sh.stroke, strokeWidth: sh.strokeWidth, fillRule: sh.fillRule || 'nonzero' });
    });
    ext.texts.forEach(function (tx) {
      var p = applyMat(tx.mat, [tx.x, tx.y]);
      raw.push({ kind: 'text', pt: p, text: tx.text, fontSize: tx.fontSize, fill: tx.fill });
    });
    if (!raw.length) return { ok: false, error: '図形が見つかりませんでした（対応する要素が無いか、SVGの形式が不正です）', parts: [], bboxW: 1, bboxH: 1 };
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function acc(p) { if (!isFinite(p[0]) || !isFinite(p[1])) return; if (p[0] < minX) minX = p[0]; if (p[1] < minY) minY = p[1]; if (p[0] > maxX) maxX = p[0]; if (p[1] > maxY) maxY = p[1]; }
    raw.forEach(function (it) { if (it.kind === 'poly') it.subpaths.forEach(function (sp) { sp.forEach(acc); }); else acc(it.pt); });
    if (!isFinite(minX) || !isFinite(maxX)) return { ok: false, error: '図形の範囲を測れませんでした', parts: [], bboxW: 1, bboxH: 1 };
    var w = maxX - minX, h = maxY - minY;
    if (w < 1e-9) w = 1;
    if (h < 1e-9) h = 1;
    var parts = raw.map(function (it) {
      if (it.kind === 'poly') return {
        kind: 'poly',
        subpaths: it.subpaths.map(function (sp) { return sp.map(function (p) { return [(p[0] - minX) / w, (p[1] - minY) / h]; }); }),
        closed: it.closed, fill: it.fill, stroke: it.stroke, strokeWidth: it.strokeWidth, fillRule: it.fillRule
      };
      return { kind: 'text', s: (it.pt[0] - minX) / w, t: (it.pt[1] - minY) / h, text: it.text, fontSize: it.fontSize, fill: it.fill };
    });
    return { ok: true, error: null, parts: parts, bboxW: w, bboxH: h };
  }

  /* ==========================================================================
     7. 置き方「線に沿わせる」: (s,t) → 帯（centerline/left/right・閉ループ想定）上の位置
     ========================================================================== */
  function dist2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function arcLenParam(pts, closed) {
    var n = pts.length;
    if (!n) return { ts: [], total: 0 };
    var cum = [0];
    for (var i = 1; i < n; i++) cum.push(cum[i - 1] + dist2(pts[i - 1], pts[i]));
    var total = cum[n - 1];
    if (closed) total += dist2(pts[n - 1], pts[0]);
    var ts = cum.map(function (c) { return total > 0 ? c / total : 0; });
    return { ts: ts, total: total };
  }
  function interpAtT(pts, ts, target, closed) {
    var m = pts.length;
    if (m === 0) return [0, 0];
    if (m === 1) return [pts[0][0], pts[0][1]];
    var j = 0;
    while (j < m - 1 && ts[j + 1] <= target) j++;
    var t0 = ts[j], t1 = (j + 1 < m) ? ts[j + 1] : 1;
    var p0 = pts[j], p1 = (j + 1 < m) ? pts[j + 1] : (closed ? pts[0] : pts[m - 1]);
    var span = t1 - t0;
    var u = span > 1e-12 ? (target - t0) / span : 0;
    return [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u];
  }
  /* pts_st: [[s,t]…]。centerline/left/right は同じ長さの閉ループ配列（正面2D座標）。
     opts: { pos:0..100, len:0..(任意%), widthMult, offsetPx, flip }
     s → 弧長パラメータu（pos+len*s を0..1へ巻き戻す＝閉じた線をまたいでも連続）。
     t → left/right の間を widthMult・offsetPx 込みで補間（帯がねじれれば絵も一緒に曲がる）。 */
  /* 直線の途中に点を足す（写像が非線形なので、角だけだと帯に沿って曲がらず弦になる・2026-09-25）。
     step は正規化座標（0〜1）での最大の間隔。closed なら最後→最初の辺も足す */
  function densify(pts, step, closed) {
    if (!pts || pts.length < 2) return pts || [];
    step = step || 0.005;
    var out = [], n = pts.length, last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (var j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    if (!closed) out.push(pts[n - 1]);
    return out;
  }

  function mapAlongLine(pts_st, centerline, left, right, opts) {
    opts = opts || {};
    var n = centerline ? centerline.length : 0;
    if (n < 2 || !left || !right || left.length !== n || right.length !== n) return pts_st.map(function () { return [0, 0]; });
    var param = arcLenParam(centerline, true);
    var ts = param.ts;
    var pos = (opts.pos != null ? opts.pos : 0) / 100;
    var len = (opts.len != null ? opts.len : 100) / 100;
    var widthMult = opts.widthMult != null ? opts.widthMult : 1;
    var offsetPx = opts.offsetPx || 0;
    var flip = !!opts.flip;
    return pts_st.map(function (p) {
      var s = p[0], t = p[1];
      var u = pos + len * s;
      u = ((u % 1) + 1) % 1;
      var c = interpAtT(centerline, ts, u, true);
      var l = interpAtT(left, ts, u, true);
      var r = interpAtT(right, ts, u, true);
      var nx = l[0] - r[0], ny = l[1] - r[1];
      var norm = Math.hypot(nx, ny) || 1;
      var ux = nx / norm, uy = ny / norm;
      var halfW = norm / 2;
      var tt = flip ? (1 - t) : t;
      var lateral = (2 * tt - 1) * halfW * widthMult + offsetPx;
      return [c[0] + ux * lateral, c[1] + uy * lateral];
    });
  }

  /* ==========================================================================
     8. 置き方「空間に置く」: 平面カード → 立体と同じ回転（rotateProject・累積回転P）
     rotateProjectPointはdepth.js(Depth.rotateProject)と同じ式を書き写したもの
     （overlay.jsはDOM非依存の純関数のみでdepth.js自体をrequireしない設計のため）。
     ========================================================================== */
  function rotateProjectPoint(x, y, z, ax, ay) {
    var rax = (ax || 0) * Math.PI / 180, ray = (ay || 0) * Math.PI / 180;
    var ca = Math.cos(rax), sa = Math.sin(rax), cb = Math.cos(ray), sb = Math.sin(ray);
    var y1 = y * ca - z * sa, z1 = y * sa + z * ca, x1 = x;
    var x2 = x1 * cb + z1 * sb, z2 = -x1 * sb + z1 * cb, y2 = y1;
    return [x2, y2, z2];
  }
  function mat3Apply(m, p) {
    return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
  }
  var MAT3_IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /* pts_st: [[s,t]…]。opts: { x,y,depth,size,rotation(度), aspectW,aspectH }（大きい方の辺=size）。
     ax,ay: 向きの角度（°）。viewP: 再生の累積回転（3x3・省略時は単位行列）。
     戻り値: [[x,y]…]（投影後2D）。 */
  function projectSpaceItem(pts_st, opts, ax, ay, viewP) {
    opts = opts || {};
    var aspectW = opts.aspectW || 1, aspectH = opts.aspectH || 1;
    var maxA = Math.max(aspectW, aspectH) || 1;
    var size = opts.size != null ? opts.size : 60;
    var rot = (opts.rotation || 0) * Math.PI / 180;
    var cr = Math.cos(rot), sr = Math.sin(rot);
    var P = viewP || MAT3_IDENTITY;
    var ox = opts.x || 0, oy = opts.y || 0, oz = opts.depth || 0;
    return pts_st.map(function (p) {
      var s = p[0], t = p[1];
      var lx = (s - 0.5) * size * (aspectW / maxA);
      var ly = (t - 0.5) * size * (aspectH / maxA);
      var rx = lx * cr - ly * sr, ry = lx * sr + ly * cr;
      var wp = rotateProjectPoint(ox + rx, oy + ry, oz, ax, ay);
      var vp = mat3Apply(P, wp);
      return [vp[0], vp[1]];
    });
  }

  /* ==========================================================================
     9. A/B・映像用: 載せたもの各項目の数値設定をov{idx}_key形式へ平らにする／戻す
     ========================================================================== */
  var OVERLAY_NUM_KEYS = ['pos', 'len', 'width', 'offset', 'x', 'y', 'depth', 'size', 'rot'];
  function flattenOverlayParams(overlays) {
    var p = {};
    (overlays || []).forEach(function (ov, i) {
      var pre = 'ov' + i + '_';
      OVERLAY_NUM_KEYS.forEach(function (k) { if (ov[k] != null) p[pre + k] = ov[k]; });
    });
    return p;
  }
  function applyOverlayParams(flat, overlays) {
    (overlays || []).forEach(function (ov, i) {
      var pre = 'ov' + i + '_';
      OVERLAY_NUM_KEYS.forEach(function (k) {
        var key = pre + k;
        if (Object.prototype.hasOwnProperty.call(flat, key) && typeof flat[key] === 'number') ov[k] = flat[key];
      });
    });
  }

  return {
    MAX_ITEMS: 8,
    parseTransform: parseTransform,
    matMul: matMul,
    applyMat: applyMat,
    parsePathD: parsePathD,
    rectSegs: rectSegs,
    circleSegs: circleSegs,
    ellipseSegs: ellipseSegs,
    polySegsFromPts: polySegsFromPts,
    readAllNumbers: readAllNumbers,
    flattenSubpath: flattenSubpath,
    extractShapes: extractShapes,
    importSvg: importSvg,
    arcLenParam: arcLenParam,
    interpAtT: interpAtT,
    densify: densify,
    mapAlongLine: mapAlongLine,
    rotateProjectPoint: rotateProjectPoint,
    mat3Apply: mat3Apply,
    projectSpaceItem: projectSpaceItem,
    flattenOverlayParams: flattenOverlayParams,
    applyOverlayParams: applyOverlayParams,
    resolveFillRule: resolveFillRule
  };
});
