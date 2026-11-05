/* ============================================================================
   svg-in.js — Illustrator などから貼った SVG を、劣化なしで読み取る共通部品
   （正本。115_symmetry/js/svg-in.js はここからの複製）

   使い方（依存なし・ブラウザ用）:
     var r = StudioSvgIn.parse(text);          // または Studio.svgIn.parse(text)
     r.shapes   : [{ subpaths:[{closed, segs}], fill, stroke, strokeWidth, ... }]
     r.bbox     : {x,y,w,h}  曲線の真の bbox（制御点ではない）
     r.warnings : ['切り抜きは無視しました: 1個', ...]  読めなかった物を件数つきで
   貼り付けイベントから SVG の文字列を取るには:
     var text = StudioSvgIn.readClipboard(event);  // image/svg+xml → text/plain → text/html

   決まり（006_ツールの規格 §8「受ける」）
     - d 属性を直接読む。getTotalLength / getPointAtLength でサンプルしない。
     - Q/T→C は厳密な昇格。A（円弧）だけ近似ベジェ（90°以下に割る）。
     - 変換（transform・入れ子 svg・use・viewBox 内の座標）は行列で畳む。
       制御点にアフィンを掛けるだけなので厳密。DOM に挿さない（レイアウトに依存しない）。
     - <style> は自前で解く: カンマ区切り・複数クラス・タグ/#id/.class の連結・
       子孫(空白)/子(>)・後勝ち（詳細度→出現順）・style 属性が最優先。
     - 色は #rrggbb + 不透明度に正規化（短縮HEX・名前色・rgb()/rgba()/hsl()/hsla()）。
     - defs / clipPath / mask / symbol / marker / pattern の中身は図形として拾わない
       （use 経由では symbol も展開する）。
     - clip-path は「凸多角形（長方形など）1個」だけ実際に切って適用する。
       できない切り抜きは warnings に出して無視する。
     - 複合パスはサブパスのまま持つ（穴を失わない）。fillRule を添える。

   segs の形（122_球体サーフェイス の Geom と同じ・M/L/C 絶対座標・変換適用済み）
     {type:'L', a:[x,y], b:[x,y]}
     {type:'C', p0:[x,y], p1:[x,y], p2:[x,y], p3:[x,y]}
   shape.d = 'M x y L … C … Z' の文字列（同じ内容）。
   ========================================================================== */
(function (global) {
  'use strict';

  var VERSION = '0.1.0';
  var EPS = 1e-9;
  var K = 0.5522847498307936;   // 4/3·tan(π/8)

  /* ==========================================================================
     1. 数値スキャナ（区切りを省いた SVG の数値列を 1 文字ずつ読む）
     "1.5.5" → 1.5 と .5 / "1-2" → 1 と -2 / "1e-5" は 1 個
     ========================================================================== */
  function scanner(str) { return { s: String(str == null ? '' : str), i: 0 }; }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  // 貼り付けが入口なので NBSP・全角空白・行区切り・BOM も区切りとして飲む
  function isWS(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' ||
      c === ' ' || c === '　' || c === ' ' || c === ' ' || c === '﻿';
  }
  function skipSep(sc) {
    var s = sc.s, n = s.length, c;
    while (sc.i < n) { c = s.charAt(sc.i); if (isWS(c) || c === ',') sc.i++; else break; }
  }
  function readNumber(sc) {
    var s = sc.s, n = s.length, i = sc.i, start = i, digits = false, c;
    c = s.charAt(i);
    if (c === '+' || c === '-') i++;
    while (i < n && isDigit(s.charAt(i))) { i++; digits = true; }
    if (i < n && s.charAt(i) === '.') {
      i++;
      while (i < n && isDigit(s.charAt(i))) { i++; digits = true; }
    }
    if (!digits) return null;
    if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
      var j = i + 1, ed = false;
      if (j < n && (s.charAt(j) === '+' || s.charAt(j) === '-')) j++;
      while (j < n && isDigit(s.charAt(j))) { j++; ed = true; }
      if (ed) i = j;
    }
    var v = parseFloat(s.slice(start, i));
    sc.i = i;                       // 先に消費する（1e999 が 999 に化けるのを防ぐ）
    return isFinite(v) ? v : null;
  }
  function readNumbers(text) {
    var sc = scanner(text), out = [], v;
    for (;;) {
      skipSep(sc);
      if (sc.i >= sc.s.length) break;
      v = readNumber(sc);
      if (v === null) { sc.i++; continue; }   // "10px" の px などは飛ばす
      out.push(v);
    }
    return out;
  }
  function readArgs(sc, count) {
    var a = [], v;
    for (var i = 0; i < count; i++) { skipSep(sc); v = readNumber(sc); if (v === null) return null; a.push(v); }
    return a;
  }
  function readFlag(sc) {
    skipSep(sc);
    var c = sc.s.charAt(sc.i);
    if (c === '0' || c === '1') { sc.i++; return c === '1' ? 1 : 0; }   // "0110 0" のように詰まっても割れる
    var v = readNumber(sc);
    return v === null ? null : (v ? 1 : 0);
  }
  // "4px" "2pt" "1.5" → 数値（単位を剥がす）。読めなければ dflt
  function numOf(v, dflt) {
    if (v == null) return dflt;
    var f = parseFloat(String(v));
    return isFinite(f) ? f : dflt;
  }

  /* ==========================================================================
     2. セグメントと行列
     ========================================================================== */
  function L(a, b) { return { type: 'L', a: [a[0], a[1]], b: [b[0], b[1]] }; }
  function C(p0, p1, p2, p3) {
    return { type: 'C', p0: [p0[0], p0[1]], p1: [p1[0], p1[1]], p2: [p2[0], p2[1]], p3: [p3[0], p3[1]] };
  }
  function segStart(s) { return s.type === 'L' ? s.a : s.p0; }
  function segEnd(s) { return s.type === 'L' ? s.b : s.p3; }

  var ID = [1, 0, 0, 1, 0, 0];
  function applyM(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
  function mul(m, n) {   // m ∘ n（n を先に適用）
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function mapSegs(segs, m) {
    return segs.map(function (s) {
      return s.type === 'L' ? L(applyM(m, s.a), applyM(m, s.b))
        : C(applyM(m, s.p0), applyM(m, s.p1), applyM(m, s.p2), applyM(m, s.p3));
    });
  }
  function matScale(m) { return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); }

  /* transform 属性 / CSS transform。rotate(-15deg) や translate(10px) も受ける */
  function parseTransform(str) {
    var m = ID.slice();
    if (!str) return m;
    var re = /([a-zA-Z]+)\s*\(([^)]*)\)/g, mt, a, t, nm, c, s, ang;
    while ((mt = re.exec(String(str)))) {
      nm = mt[1].toLowerCase(); a = readNumbers(mt[2]); t = null;
      if (nm === 'matrix') { if (a.length >= 6) t = a.slice(0, 6); }
      else if (nm === 'translate') t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
      else if (nm === 'scale') { var sx = a.length ? a[0] : 1; t = [sx, 0, 0, a.length > 1 ? a[1] : sx, 0, 0]; }
      else if (nm === 'rotate') {
        ang = (a[0] || 0) * Math.PI / 180; c = Math.cos(ang); s = Math.sin(ang);
        t = [c, s, -s, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
      }
      else if (nm === 'skewx') t = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0];
      else if (nm === 'skewy') t = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
      if (t) m = mul(m, t);
    }
    return m;
  }

  /* ==========================================================================
     3. 円弧 A → 3 次ベジェ（仕様 F.6.5。90°以下に割る）
     ========================================================================== */
  function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
    if (Math.abs(x1 - x2) < EPS && Math.abs(y1 - y2) < EPS) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx < EPS || ry < EPS) return [L([x1, y1], [x2, y2])];
    var phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    var lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { var k = Math.sqrt(lam); rx *= k; ry *= k; }
    var rx2 = rx * rx, ry2 = ry * ry;
    var den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    var co = Math.sqrt(Math.max(0, (rx2 * ry2 - den) / den));
    if (largeArc === sweep) co = -co;
    var cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
    var cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    var ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    var vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    var th1 = Math.atan2(uy, ux);
    var dth = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dth > 0) dth -= Math.PI * 2;
    if (sweep && dth < 0) dth += Math.PI * 2;
    function P(t) { var c = Math.cos(t), s = Math.sin(t); return [cx + rx * c * cp - ry * s * sp, cy + rx * c * sp + ry * s * cp]; }
    function D(t) { var c = Math.cos(t), s = Math.sin(t); return [-rx * s * cp - ry * c * sp, -rx * s * sp + ry * c * cp]; }
    var n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
    var d = dth / n, out = [], alpha = 4 / 3 * Math.tan(d / 4);
    for (var i = 0; i < n; i++) {
      var t0 = th1 + d * i, t1 = t0 + d, p0 = P(t0), p3 = P(t1), d0 = D(t0), d3 = D(t1);
      if (i === 0) p0 = [x1, y1];            // 端点は記法の値で上書き（隙間を作らない）
      if (i === n - 1) p3 = [x2, y2];
      out.push(C(p0, [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1]],
        [p3[0] - alpha * d3[0], p3[1] - alpha * d3[1]], p3));
    }
    return out;
  }

  /* ==========================================================================
     4. d 属性のパーサ → [{segs, closed}]（サブパスごと）。broken=true なら途中で諦めた
     ========================================================================== */
  var CMD = /[MmLlHhVvCcSsQqTtAaZz]/;

  function quadToCubic(p0, q, p3) {
    return C(p0, [p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])],
      [p3[0] + 2 / 3 * (q[0] - p3[0]), p3[1] + 2 / 3 * (q[1] - p3[1])], p3);
  }

  function parseD(d) {
    var sc = scanner(d), subs = [], cur = null, broken = false;
    var x = 0, y = 0, sx = 0, sy = 0, prevCtrl = null, prevKind = '';
    var cmd = '', ch, a, rel, nx, ny, p1, p2, p3, q, i, arcs, laf, swf, ep;

    function open() { if (!cur) { cur = { segs: [], closed: false }; sx = x; sy = y; } }
    function flush() { if (cur && cur.segs.length) subs.push(cur); cur = null; }
    function bail() { broken = true; flush(); return { subs: subs, broken: true }; }

    for (;;) {
      skipSep(sc);
      if (sc.i >= sc.s.length) break;
      ch = sc.s.charAt(sc.i);
      if (CMD.test(ch)) { cmd = ch; sc.i++; skipSep(sc); }
      else if (!cmd) { return bail(); }
      rel = cmd >= 'a';
      switch (cmd.toUpperCase()) {
        case 'M':
          a = readArgs(sc, 2); if (!a) return bail();
          flush();
          x = rel ? x + a[0] : a[0]; y = rel ? y + a[1] : a[1];
          open(); prevKind = '';
          cmd = rel ? 'l' : 'L';      // M の後ろの座標は暗黙の lineto
          break;
        case 'L':
          a = readArgs(sc, 2); if (!a) return bail();
          open(); nx = rel ? x + a[0] : a[0]; ny = rel ? y + a[1] : a[1];
          cur.segs.push(L([x, y], [nx, ny])); x = nx; y = ny; prevKind = '';
          break;
        case 'H':
          a = readArgs(sc, 1); if (!a) return bail();
          open(); nx = rel ? x + a[0] : a[0];
          cur.segs.push(L([x, y], [nx, y])); x = nx; prevKind = '';
          break;
        case 'V':
          a = readArgs(sc, 1); if (!a) return bail();
          open(); ny = rel ? y + a[0] : a[0];
          cur.segs.push(L([x, y], [x, ny])); y = ny; prevKind = '';
          break;
        case 'C':
          a = readArgs(sc, 6); if (!a) return bail();
          open();
          p1 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          p2 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
          p3 = [rel ? x + a[4] : a[4], rel ? y + a[5] : a[5]];
          cur.segs.push(C([x, y], p1, p2, p3));
          x = p3[0]; y = p3[1]; prevCtrl = p2; prevKind = 'C';
          break;
        case 'S':
          a = readArgs(sc, 4); if (!a) return bail();
          open();
          p1 = (prevKind === 'C' && prevCtrl) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
          p2 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          p3 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
          cur.segs.push(C([x, y], p1, p2, p3));
          x = p3[0]; y = p3[1]; prevCtrl = p2; prevKind = 'C';
          break;
        case 'Q':
          a = readArgs(sc, 4); if (!a) return bail();
          open();
          q = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          p3 = [rel ? x + a[2] : a[2], rel ? y + a[3] : a[3]];
          cur.segs.push(quadToCubic([x, y], q, p3));
          x = p3[0]; y = p3[1]; prevCtrl = q; prevKind = 'Q';
          break;
        case 'T':
          a = readArgs(sc, 2); if (!a) return bail();
          open();
          q = (prevKind === 'Q' && prevCtrl) ? [2 * x - prevCtrl[0], 2 * y - prevCtrl[1]] : [x, y];
          p3 = [rel ? x + a[0] : a[0], rel ? y + a[1] : a[1]];
          cur.segs.push(quadToCubic([x, y], q, p3));
          x = p3[0]; y = p3[1]; prevCtrl = q; prevKind = 'Q';
          break;
        case 'A':
          a = readArgs(sc, 3); if (!a) return bail();
          laf = readFlag(sc); swf = readFlag(sc);
          if (laf === null || swf === null) return bail();
          ep = readArgs(sc, 2); if (!ep) return bail();
          open();
          nx = rel ? x + ep[0] : ep[0]; ny = rel ? y + ep[1] : ep[1];
          arcs = arcToCubics(x, y, a[0], a[1], a[2], laf, swf, nx, ny);
          for (i = 0; i < arcs.length; i++) cur.segs.push(arcs[i]);
          x = nx; y = ny; prevKind = '';
          break;
        case 'Z':
          if (cur) {
            if (Math.abs(x - sx) > EPS || Math.abs(y - sy) > EPS) cur.segs.push(L([x, y], [sx, sy]));
            cur.closed = true; flush();
          }
          x = sx; y = sy; prevKind = ''; cmd = '';
          break;
        default:
          return bail();
      }
    }
    flush();
    return { subs: subs, broken: broken };
  }

  /* ==========================================================================
     5. 基本図形 → サブパス（式から直接ベジェを作る。サンプルしない）
     ========================================================================== */
  function polyline(pts, closed) {
    var segs = [], i;
    for (i = 0; i + 1 < pts.length; i++) segs.push(L(pts[i], pts[i + 1]));
    if (closed && pts.length > 1) {
      var a = pts[pts.length - 1], b = pts[0];
      if (Math.abs(a[0] - b[0]) > EPS || Math.abs(a[1] - b[1]) > EPS) segs.push(L(a, b));
    }
    return segs;
  }
  function ellipseSegs(cx, cy, rx, ry) {
    var kx = rx * K, ky = ry * K;
    return [
      C([cx + rx, cy], [cx + rx, cy + ky], [cx + kx, cy + ry], [cx, cy + ry]),
      C([cx, cy + ry], [cx - kx, cy + ry], [cx - rx, cy + ky], [cx - rx, cy]),
      C([cx - rx, cy], [cx - rx, cy - ky], [cx - kx, cy - ry], [cx, cy - ry]),
      C([cx, cy - ry], [cx + kx, cy - ry], [cx + rx, cy - ky], [cx + rx, cy])
    ];
  }
  function rectSegs(x, y, w, h, rx, ry) {
    if (!(w > 0) || !(h > 0)) return [];
    rx = Math.min(Math.max(rx || 0, 0), w / 2); ry = Math.min(Math.max(ry || 0, 0), h / 2);
    if (rx < EPS || ry < EPS) return polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    var kx = rx * K, ky = ry * K, x0 = x, x1 = x + w, y0 = y, y1 = y + h;
    return [
      L([x0 + rx, y0], [x1 - rx, y0]),
      C([x1 - rx, y0], [x1 - rx + kx, y0], [x1, y0 + ry - ky], [x1, y0 + ry]),
      L([x1, y0 + ry], [x1, y1 - ry]),
      C([x1, y1 - ry], [x1, y1 - ry + ky], [x1 - rx + kx, y1], [x1 - rx, y1]),
      L([x1 - rx, y1], [x0 + rx, y1]),
      C([x0 + rx, y1], [x0 + rx - kx, y1], [x0, y1 - ry + ky], [x0, y1 - ry]),
      L([x0, y1 - ry], [x0, y0 + ry]),
      C([x0, y0 + ry], [x0, y0 + ry - ky], [x0 + rx - kx, y0], [x0 + rx, y0])
    ];
  }

  /* ==========================================================================
     6. bbox（曲線の真の極値）・評価・分割
     ========================================================================== */
  function evalCubic(s, t) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * s.p0[0] + b * s.p1[0] + c * s.p2[0] + d * s.p3[0], a * s.p0[1] + b * s.p1[1] + c * s.p2[1] + d * s.p3[1]];
  }
  function evalSeg(s, t) {
    return s.type === 'L' ? [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t] : evalCubic(s, t);
  }
  function boundsOfSegs(segs, bb) {
    bb = bb || [Infinity, Infinity, -Infinity, -Infinity];
    function acc(p) {
      if (!isFinite(p[0]) || !isFinite(p[1])) return;
      if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1];
      if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1];
    }
    segs.forEach(function (s) {
      if (s.type === 'L') { acc(s.a); acc(s.b); return; }
      acc(s.p0); acc(s.p3);
      for (var k = 0; k < 2; k++) {
        var A = s.p1[k] - s.p0[k], B = s.p2[k] - s.p1[k], Cc = s.p3[k] - s.p2[k];
        var a = A - 2 * B + Cc, b = 2 * (B - A), c = A, ts = [];
        if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) ts.push(-c / b); }
        else {
          var disc = b * b - 4 * a * c;
          if (disc >= 0) { var sq = Math.sqrt(disc); ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a)); }
        }
        ts.forEach(function (t) { if (t > 0 && t < 1) acc(evalCubic(s, t)); });
      }
    });
    return bb;
  }
  function splitCubicAt(s, t) {   // de Casteljau → [前半, 後半]
    function lerp(a, b) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    var a = lerp(s.p0, s.p1), b = lerp(s.p1, s.p2), c = lerp(s.p2, s.p3);
    var d = lerp(a, b), e = lerp(b, c), f = lerp(d, e);
    return [C(s.p0, a, d, f), C(f, e, c, s.p3)];
  }
  function splitSegAt(s, t) {
    if (s.type === 'L') { var m = evalSeg(s, t); return [L(s.a, m), L(m, s.b)]; }
    return splitCubicAt(s, t);
  }

  /* ==========================================================================
     7. 切り抜き（凸多角形）。半平面で順に切る。曲線は交点で割ってから拾う
     ========================================================================== */
  function planeDist(pl, p) { return ((pl.bx - pl.ax) * (p[1] - pl.ay) - (pl.by - pl.ay) * (p[0] - pl.ax)) * pl.orient / pl.len; }

  function planeRoots(pl, s) {   // seg 上で距離が 0 を横切る t（0<t<1）
    if (s.type === 'L') {
      var d0 = planeDist(pl, s.a), d1 = planeDist(pl, s.b);
      if ((d0 >= 0) === (d1 >= 0)) return [];
      var t = d0 / (d0 - d1);
      return t > 1e-9 && t < 1 - 1e-9 ? [t] : [];
    }
    var q = [planeDist(pl, s.p0), planeDist(pl, s.p1), planeDist(pl, s.p2), planeDist(pl, s.p3)];
    function f(t) {
      var u = 1 - t;
      return u * u * u * q[0] + 3 * u * u * t * q[1] + 3 * u * t * t * q[2] + t * t * t * q[3];
    }
    var N = 32, out = [], prev = f(0), pt = 0, i, t1, v, lo, hi, mid, flo;
    for (i = 1; i <= N; i++) {
      t1 = i / N; v = f(t1);
      if ((prev >= 0) !== (v >= 0)) {
        lo = pt; hi = t1; flo = prev;
        for (var it = 0; it < 48; it++) {
          mid = (lo + hi) / 2;
          if ((f(mid) >= 0) === (flo >= 0)) lo = mid; else hi = mid;
        }
        mid = (lo + hi) / 2;
        if (mid > 1e-9 && mid < 1 - 1e-9) out.push(mid);
      }
      prev = v; pt = t1;
    }
    return out;
  }

  // 1 本のサブパスを 1 つの半平面で切る → サブパスの配列
  function clipSubByPlane(sub, pl) {
    var pieces = [], i, j;
    sub.segs.forEach(function (s) {
      var ts = planeRoots(pl, s), rest = s, base = 0;
      for (j = 0; j < ts.length; j++) {
        var tl = (ts[j] - base) / (1 - base), two = splitSegAt(rest, tl);
        pieces.push(two[0]); rest = two[1]; base = ts[j];
      }
      pieces.push(rest);
    });
    var ins = pieces.map(function (p) { return planeDist(pl, evalSeg(p, 0.5)) >= -1e-7; });
    var any = ins.some(Boolean), all = ins.every(Boolean);
    if (!any) return [];
    if (all) return [sub];
    var out = [];
    if (!sub.closed) {
      var run = null;
      for (i = 0; i < pieces.length; i++) {
        if (ins[i]) { if (!run) run = []; run.push(pieces[i]); }
        else if (run) { out.push({ closed: false, segs: run }); run = null; }
      }
      if (run) out.push({ closed: false, segs: run });
      return out;
    }
    // 閉じた輪: 外→内の切り替わり位置から数え直し、外側を飛ばす所は切り口の直線で橋渡し
    var n = pieces.length, k0 = -1;
    for (i = 0; i < n; i++) if (ins[i] && !ins[(i + n - 1) % n]) { k0 = i; break; }
    if (k0 < 0) return [sub];
    var segs = [], lastEnd = null, gap = false;
    for (i = 0; i < n; i++) {
      var idx = (k0 + i) % n;
      if (ins[idx]) {
        if (gap && lastEnd) {
          var st = segStart(pieces[idx]);
          if (Math.abs(lastEnd[0] - st[0]) > EPS || Math.abs(lastEnd[1] - st[1]) > EPS) segs.push(L(lastEnd, st));
        }
        gap = false; segs.push(pieces[idx]); lastEnd = segEnd(pieces[idx]);
      } else gap = true;
    }
    var f0 = segStart(segs[0]);
    if (Math.abs(lastEnd[0] - f0[0]) > EPS || Math.abs(lastEnd[1] - f0[1]) > EPS) segs.push(L(lastEnd, f0));
    return [{ closed: true, segs: segs }];
  }

  function clipSubs(subs, planes) {
    var cur = subs, p, next, i;
    for (p = 0; p < planes.length && cur.length; p++) {
      next = [];
      for (i = 0; i < cur.length; i++) {
        var r = clipSubByPlane(cur[i], planes[p]);
        for (var j = 0; j < r.length; j++) next.push(r[j]);
      }
      cur = next;
    }
    return cur;
  }

  // 凸多角形の頂点 → 半平面。凸でない・3 点未満なら null
  function planesOfPolygon(pts) {
    var q = [], i;
    for (i = 0; i < pts.length; i++) {
      var p = pts[i], last = q[q.length - 1];
      if (!last || Math.abs(p[0] - last[0]) > 1e-7 || Math.abs(p[1] - last[1]) > 1e-7) q.push(p);
    }
    if (q.length > 1 && Math.abs(q[0][0] - q[q.length - 1][0]) < 1e-7 && Math.abs(q[0][1] - q[q.length - 1][1]) < 1e-7) q.pop();
    if (q.length < 3) return null;
    var area = 0, n = q.length;
    for (i = 0; i < n; i++) { var a = q[i], b = q[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    if (Math.abs(area) < 1e-9) return null;
    var orient = area > 0 ? 1 : -1, planes = [];
    for (i = 0; i < n; i++) {
      var A = q[i], B = q[(i + 1) % n], Cc = q[(i + 2) % n];
      var cr = ((B[0] - A[0]) * (Cc[1] - B[1]) - (B[1] - A[1]) * (Cc[0] - B[0])) * orient;
      if (cr < -1e-7) return null;                  // 凹み
      planes.push({ ax: A[0], ay: A[1], bx: B[0], by: B[1], orient: orient, len: Math.hypot(B[0] - A[0], B[1] - A[1]) });
    }
    return planes;
  }
  function bboxInsidePlanes(bb, planes) {
    var cs = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]];
    for (var i = 0; i < planes.length; i++) for (var j = 0; j < 4; j++) if (planeDist(planes[i], cs[j]) < -1e-7) return false;
    return true;
  }

  /* ==========================================================================
     8. 色
     ========================================================================== */
  var NAMED = {};
  ('aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,' +
    'blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,' +
    'chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,' +
    'darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,' +
    'darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,' +
    'darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,' +
    'deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,' +
    'fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,' +
    'grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
    'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
    'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,' +
    'lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,' +
    'lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,' +
    'mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,' +
    'mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,' +
    'navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,' +
    'palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,' +
    'peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
    'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,' +
    'silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,' +
    'steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,' +
    'white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32').split(',').forEach(function (kv) {
    var p = kv.split(':'); NAMED[p[0]] = '#' + p[1];
  });

  function hex2(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); }
  function rgbHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    function f(n) {
      var k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  function cssNum(tok, pctScale) {   // "50%" → 0.5*pctScale / "12" → 12
    tok = String(tok).trim();
    if (/%$/.test(tok)) return parseFloat(tok) / 100 * pctScale;
    return parseFloat(tok);
  }
  // 戻り値 {hex:'#rrggbb'|'none', alpha:0..1}。解釈できなければ null
  function parseColor(str, currentColor) {
    var s = String(str == null ? '' : str).trim().toLowerCase(), m, p, a, h;
    if (!s) return null;
    if (s === 'none') return { hex: 'none', alpha: 1 };
    if (s === 'transparent') return { hex: '#000000', alpha: 0 };
    if (s === 'currentcolor') return currentColor && currentColor.toLowerCase() !== 'currentcolor' ? parseColor(currentColor, null) : { hex: '#000000', alpha: 1 };
    if (s.charAt(0) === '#') {
      h = s.slice(1);
      if (!/^[0-9a-f]+$/.test(h)) return null;
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length === 6) return { hex: '#' + h, alpha: 1 };
      if (h.length === 8) return { hex: '#' + h.slice(0, 6), alpha: parseInt(h.slice(6), 16) / 255 };
      return null;
    }
    m = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
    if (m) {
      p = m[2].split(/[\s,\/]+/).filter(Boolean);
      if (p.length < 3) return null;
      a = p.length > 3 ? Math.max(0, Math.min(1, cssNum(p[3], 1))) : 1;
      if (!isFinite(a)) a = 1;
      if (m[1].charAt(0) === 'r') {
        var r = cssNum(p[0], 255), g = cssNum(p[1], 255), b = cssNum(p[2], 255);
        if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
        return { hex: rgbHex(r, g, b), alpha: a };
      }
      var hh = parseFloat(p[0]), ss = cssNum(p[1], 1), ll = cssNum(p[2], 1);
      if (!isFinite(hh) || !isFinite(ss) || !isFinite(ll)) return null;
      var rgb = hslToRgb(hh, Math.max(0, Math.min(1, ss)), Math.max(0, Math.min(1, ll)));
      return { hex: rgbHex(rgb[0], rgb[1], rgb[2]), alpha: a };
    }
    if (NAMED[s]) return { hex: NAMED[s], alpha: 1 };
    return null;
  }

  /* ==========================================================================
     9. <style> の解決（自前）
     ========================================================================== */
  function stripComments(t) { return String(t).replace(/\/\*[\s\S]*?\*\//g, ''); }

  // "a:b; c:url(x;y)" → [[prop, value, important]]（括弧と引用符の中の ; は区切りにしない）
  function splitDecls(text) {
    var out = [], depth = 0, q = '', cur = '', i, c;
    function push() {
      var k = cur.indexOf(':');
      if (k > 0) {
        var prop = cur.slice(0, k).trim().toLowerCase(), val = cur.slice(k + 1).trim(), imp = false;
        if (/!\s*important\s*$/i.test(val)) { imp = true; val = val.replace(/!\s*important\s*$/i, '').trim(); }
        if (prop && val) out.push([prop, val, imp]);
      }
      cur = '';
    }
    for (i = 0; i < text.length; i++) {
      c = text.charAt(i);
      if (q) { cur += c; if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      if (c === ';' && depth === 0) { push(); continue; }
      cur += c;
    }
    push();
    return out;
  }

  var COMPOUND_RE = /^(\*|[A-Za-z][\w-]*)?((?:[.#][^\s.#:\[\]>+~,*]+)*)$/;

  // セレクタ 1 個 → {chain:[{comp,comb}], spec} / 解釈できなければ null
  function compileSelector(sel) {
    sel = sel.trim().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ');
    if (!sel || /[:\[\]+~]/.test(sel)) return null;
    var toks = sel.split(' '), chain = [], comb = ' ', ids = 0, cls = 0, tags = 0, i;
    for (i = 0; i < toks.length; i++) {
      if (toks[i] === '>') { comb = '>'; continue; }
      var m = COMPOUND_RE.exec(toks[i]);
      if (!m) return null;
      var comp = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, ids: [], classes: [] };
      if (comp.tag) tags++;
      (m[2].match(/[.#][^.#]+/g) || []).forEach(function (t) {
        if (t.charAt(0) === '#') { comp.ids.push(t.slice(1)); ids++; } else { comp.classes.push(t.slice(1)); cls++; }
      });
      chain.push({ comp: comp, comb: comb }); comb = ' ';
    }
    if (!chain.length) return null;
    return { chain: chain, spec: ids * 10000 + cls * 100 + tags };
  }

  function parseStyleSheet(text, rules, stats) {
    var css = stripComments(text), i = 0, n = css.length;
    while (i < n) {
      var open = css.indexOf('{', i);
      if (open < 0) break;
      var prelude = css.slice(i, open).trim(), depth = 1, j = open + 1;
      while (j < n && depth) { var ch = css.charAt(j); if (ch === '{') depth++; else if (ch === '}') depth--; j++; }
      var body = css.slice(open + 1, j - 1);
      i = j;
      if (prelude.charAt(0) === '@') continue;        // @media @font-face @keyframes は読まない
      var decls = splitDecls(body);
      if (!decls.length) continue;
      prelude.split(',').forEach(function (sel) {
        var cs = compileSelector(sel);
        if (!cs) { if (sel.trim()) stats.badSelectors++; return; }
        rules.push({ chain: cs.chain, spec: cs.spec, order: rules.length, decls: decls });
      });
    }
  }

  function elChildren(el) {
    var out = [], c = el.firstChild;
    for (; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
    return out;
  }
  function tagOf(el) { return String(el.localName || el.nodeName || '').toLowerCase(); }

  function matchComp(el, comp) {
    if (comp.tag && tagOf(el) !== comp.tag) return false;
    var i;
    if (comp.ids.length) { var id = el.getAttribute('id'); for (i = 0; i < comp.ids.length; i++) if (id !== comp.ids[i]) return false; }
    if (comp.classes.length) {
      var cl = (el.getAttribute('class') || '').split(/\s+/);
      for (i = 0; i < comp.classes.length; i++) if (cl.indexOf(comp.classes[i]) < 0) return false;
    }
    return true;
  }
  function matchChain(el, chain, k) {
    if (!matchComp(el, chain[k].comp)) return false;
    if (k === 0) return true;
    var comb = chain[k].comb, p = el.parentNode;
    if (comb === '>') return !!(p && p.nodeType === 1 && matchChain(p, chain, k - 1));
    for (; p && p.nodeType === 1; p = p.parentNode) if (matchChain(p, chain, k - 1)) return true;
    return false;
  }

  /* ==========================================================================
     10. 要素のたどり
     ========================================================================== */
  var PRES_ATTRS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'color', 'visibility', 'display',
    'opacity', 'mix-blend-mode', 'clip-path', 'mask', 'filter', 'stop-color', 'stop-opacity'];
  var INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'color', 'visibility'];
  var SHAPE_TAGS = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polygon: 1, polyline: 1 };
  // 描かれない・読まない入れ物。中身には入らない
  var SKIP_TAGS = { defs: 1, clippath: 1, mask: 1, marker: 1, symbol: 1, pattern: 1, lineargradient: 1, radialgradient: 1,
    style: 1, title: 1, desc: 1, metadata: 1, script: 1, filter: 1, 'font-face': 1, animate: 1, set: 1, animatetransform: 1 };

  function parse(text, opts) {
    opts = opts || {};
    var maxShapes = opts.maxShapes || 20000;
    var res = { shapes: [], bbox: null, viewBox: null, width: null, height: null, warnings: [] };
    var counts = { text: 0, image: 0, mask: 0, clip: 0, filter: 0, pattern: 0, badSelectors: 0, broken: 0, missing: 0, hiddenOnly: 0 };
    var src = String(text == null ? '' : text);
    var cut = src.search(/<\?xml|<svg[\s>]|<(?:path|rect|circle|ellipse|polygon|polyline|line|g)[\s/>]/i);
    if (cut > 0) src = src.slice(cut);
    var endSvg = src.toLowerCase().lastIndexOf('</svg>');   // text/html の貼り付けは </svg> の後ろに </body></html> が付く
    if (endSvg > 0) src = src.slice(0, endSvg + 6);
    src = src.replace(/^﻿/, '').trim();
    if (!src) { res.error = 'SVGが空です'; res.warnings.push(res.error); return res; }
    if (typeof global.DOMParser !== 'function') { res.error = 'DOMParser がありません'; res.warnings.push(res.error); return res; }

    // 断片（<path/> だけ）を貼られたら包む。xmlns・xlink の宣言漏れを補う。素性の知れない & を逃がす
    var markup = /<svg[\s>]/i.test(src) ? src : '<svg xmlns="http://www.w3.org/2000/svg">' + src + '</svg>';
    if (!/<svg[^>]*\sxmlns\s*=/i.test(markup)) markup = markup.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    if (/\sxlink:/i.test(markup) && !/xmlns:xlink\s*=/i.test(markup)) markup = markup.replace(/<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    markup = markup.replace(/&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/g, '&amp;');

    var doc;
    try { doc = new global.DOMParser().parseFromString(markup, 'image/svg+xml'); }
    catch (e) { res.error = 'SVGを読み取れませんでした'; res.warnings.push(res.error); return res; }
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length ||
      tagOf(doc.documentElement) !== 'svg') {
      res.error = 'SVGの形式を読み取れませんでした'; res.warnings.push(res.error); return res;
    }
    var root = doc.documentElement;

    // id 索引と <style>
    var ids = {}, rules = [], all = doc.getElementsByTagName('*'), ai;
    for (ai = 0; ai < all.length; ai++) {
      var idv = all[ai].getAttribute('id');
      if (idv && !ids[idv]) ids[idv] = all[ai];
    }
    var styles = doc.getElementsByTagName('style');
    for (ai = 0; ai < styles.length; ai++) parseStyleSheet(styles[ai].textContent || '', rules, counts);

    function byRef(id) {
      if (ids[id]) return ids[id];
      try { var d = decodeURIComponent(id); if (ids[d]) return ids[d]; } catch (e) { /* そのまま */ }
      return null;
    }
    function hrefId(el) {
      var h = el.getAttribute('href') || el.getAttribute('xlink:href') ||
        (el.getAttributeNS ? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : '') || '';
      var m = /^\s*#(.+?)\s*$/.exec(h);
      return m ? m[1] : null;
    }

    // 要素の宣言値: 属性 < <style> の規則（詳細度→出現順）< style 属性
    function declsOf(el) {
      var d = {}, i, k;
      for (i = 0; i < PRES_ATTRS.length; i++) {
        var av = el.getAttribute(PRES_ATTRS[i]);
        if (av != null && av !== '') d[PRES_ATTRS[i]] = String(av).trim();
      }
      var hit = [];
      for (i = 0; i < rules.length; i++) if (matchChain(el, rules[i].chain, rules[i].chain.length - 1)) hit.push(rules[i]);
      hit.sort(function (a, b) { return (a.spec - b.spec) || (a.order - b.order); });
      var imp = [];
      hit.forEach(function (r) {
        r.decls.forEach(function (x) { if (x[2]) imp.push(x); else d[x[0]] = x[1]; });
      });
      var sa = el.getAttribute('style');
      if (sa) splitDecls(sa).forEach(function (x) { if (!x[2]) d[x[0]] = x[1]; else imp.push(x); });
      for (k = 0; k < imp.length; k++) d[imp[k][0]] = imp[k][1];
      return d;
    }

    // ---- 塗り（色・グラデ・パターン） ----
    var gradCache = {};
    function gradientOf(el) {
      var gid = el.getAttribute('id') || '';
      if (gradCache[gid]) return gradCache[gid];
      var chain = [], cur = el, guard = 0;
      while (cur && guard++ < 8) { chain.push(cur); var nid = hrefId(cur); cur = nid ? byRef(nid) : null; }
      function attr(name) {
        for (var i = 0; i < chain.length; i++) { var v = chain[i].getAttribute(name); if (v != null && v !== '') return v; }
        return null;
      }
      var radial = tagOf(el) === 'radialgradient', stopsEl = null, i;
      for (i = 0; i < chain.length; i++) {
        if (elChildren(chain[i]).some(function (c) { return tagOf(c) === 'stop'; })) { stopsEl = chain[i]; break; }
      }
      var stops = [], lastOff = 0;
      if (stopsEl) elChildren(stopsEl).forEach(function (c) {
        if (tagOf(c) !== 'stop') return;
        var sd = declsOf(c), off = c.getAttribute('offset') || '0', ov;
        ov = /%$/.test(off.trim()) ? parseFloat(off) / 100 : parseFloat(off);
        if (!isFinite(ov)) ov = 0;
        ov = Math.max(lastOff, Math.max(0, Math.min(1, ov))); lastOff = ov;
        var col = parseColor(sd['stop-color'] || 'black', sd.color) || { hex: '#000000', alpha: 1 };
        var so = numOf(sd['stop-opacity'], 1);
        stops.push({ offset: ov, color: col.hex === 'none' ? '#000000' : col.hex, opacity: Math.max(0, Math.min(1, so * col.alpha)) });
      });
      function coord(name, dflt) {
        var v = attr(name); if (v == null) return dflt;
        v = String(v).trim();
        return /%$/.test(v) ? parseFloat(v) / 100 : numOf(v, dflt);
      }
      var g = {
        id: gid, name: el.getAttribute('data-name') || '', type: radial ? 'radial' : 'linear',
        units: attr('gradientUnits') || 'objectBoundingBox', transform: parseTransform(attr('gradientTransform')),
        spread: attr('spreadMethod') || 'pad', stops: stops
      };
      if (radial) { g.cx = coord('cx', 0.5); g.cy = coord('cy', 0.5); g.r = coord('r', 0.5); g.fx = coord('fx', g.cx); g.fy = coord('fy', g.cy); }
      else { g.x1 = coord('x1', 0); g.y1 = coord('y1', 0); g.x2 = coord('x2', 1); g.y2 = coord('y2', 0); }
      gradCache[gid] = g;
      return g;
    }
    function avgStopColor(g) {
      if (!g.stops.length) return { hex: '#000000', alpha: 0 };
      var r = 0, gg = 0, b = 0, a = 0;
      g.stops.forEach(function (s) {
        r += parseInt(s.color.slice(1, 3), 16); gg += parseInt(s.color.slice(3, 5), 16); b += parseInt(s.color.slice(5, 7), 16); a += s.opacity;
      });
      var n = g.stops.length;
      return { hex: rgbHex(r / n, gg / n, b / n), alpha: a / n };
    }
    // 戻り値 {hex, alpha, gradient?}
    function resolvePaint(val, curColor) {
      var v = String(val == null ? '' : val).trim();
      if (/^url\(/i.test(v)) {
        var m = /^url\(\s*['"]?#([^'")]+?)['"]?\s*\)\s*(.*)$/i.exec(v);
        var el = m ? byRef(m[1]) : null, t = el ? tagOf(el) : '';
        if (t === 'lineargradient' || t === 'radialgradient') {
          var g = gradientOf(el), a = avgStopColor(g);
          return { hex: a.hex, alpha: a.alpha, gradient: g };
        }
        if (t === 'pattern') { counts.pattern++; return { hex: 'none', alpha: 1 }; }
        if (m && m[2]) return resolvePaint(m[2], curColor);
        counts.missing++;
        return { hex: 'none', alpha: 1 };
      }
      return parseColor(v, curColor) || { hex: '#000000', alpha: 1 };
    }

    // ---- 切り抜き ----
    function shapeSubsOf(el, tag) {   // 局所座標のサブパス
      var subs = [], broken = false, n = function (a, d) { return numOf(el.getAttribute(a), d); };
      if (tag === 'path') {
        var r = parseD(el.getAttribute('d') || ''); subs = r.subs; broken = r.broken;
      } else if (tag === 'rect') {
        var rx = el.getAttribute('rx'), ry = el.getAttribute('ry'), rxv = numOf(rx, NaN), ryv = numOf(ry, NaN);
        if (!isFinite(rxv) && !isFinite(ryv)) rxv = ryv = 0;
        else if (!isFinite(rxv)) rxv = ryv; else if (!isFinite(ryv)) ryv = rxv;
        var rs = rectSegs(n('x', 0), n('y', 0), n('width', 0), n('height', 0), rxv, ryv);
        if (rs.length) subs = [{ segs: rs, closed: true }];
      } else if (tag === 'circle') {
        var rr = n('r', 0);
        if (rr > 0) subs = [{ segs: ellipseSegs(n('cx', 0), n('cy', 0), rr, rr), closed: true }];
      } else if (tag === 'ellipse') {
        var ex = n('rx', 0), ey = n('ry', 0);
        if (ex > 0 && ey > 0) subs = [{ segs: ellipseSegs(n('cx', 0), n('cy', 0), ex, ey), closed: true }];
      } else if (tag === 'line') {
        subs = [{ segs: [L([n('x1', 0), n('y1', 0)], [n('x2', 0), n('y2', 0)])], closed: false }];
      } else if (tag === 'polygon' || tag === 'polyline') {
        var nums = readNumbers(el.getAttribute('points') || ''), pts = [], i;
        for (i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        if (pts.length > 1) subs = [{ segs: polyline(pts, tag === 'polygon'), closed: tag === 'polygon' }];
      }
      return { subs: subs, broken: broken };
    }
    var clipCache = {};
    // clip-path の値と、参照した要素の座標系 → 'none' | {planes} | {unsupported:true}
    function resolveClip(val, refCtm) {
      var m = /^url\(\s*['"]?#([^'")]+?)['"]?\s*\)/i.exec(String(val).trim());
      if (!m) return { unsupported: true };
      var cel = byRef(m[1]);
      if (!cel || tagOf(cel) !== 'clippath') return { unsupported: true };
      var key = m[1] + '|' + refCtm.join(',');
      if (clipCache[key]) return clipCache[key];
      var out = { unsupported: true };
      var cd = declsOf(cel), kids = elChildren(cel).filter(function (c) { var t = tagOf(c); return t !== 'title' && t !== 'desc'; });
      if (kids.length === 1 && (cel.getAttribute('clipPathUnits') || 'userSpaceOnUse') === 'userSpaceOnUse' &&
        (!cd['clip-path'] || cd['clip-path'] === 'none')) {
        var kid = kids[0], kt = tagOf(kid), kd = declsOf(kid);
        if (SHAPE_TAGS[kt] && (!kd['clip-path'] || kd['clip-path'] === 'none') && kd.display !== 'none') {
          var cm = mul(mul(refCtm, parseTransform(cd.transform || cel.getAttribute('transform'))),
            parseTransform(kd.transform || kid.getAttribute('transform')));
          var got = shapeSubsOf(kid, kt);
          if (got.subs.length === 1 && !got.broken) {
            var segs = mapSegs(got.subs[0].segs, cm), pts = [], onlyLines = true;
            segs.forEach(function (s) { if (s.type !== 'L') onlyLines = false; else pts.push(s.a); });
            if (onlyLines && segs.length) {
              pts.push(segs[segs.length - 1].b);
              var planes = planesOfPolygon(pts);
              if (planes) out = { planes: planes };
            }
          }
        }
      }
      clipCache[key] = out;
      return out;
    }

    // ---- たどり ----
    var shapeTotal = 0, overflow = 0, useBudget = 4000;
    var rootDecls = null;

    function emitShape(el, tag, st, d) {
      shapeTotal++;
      if (res.shapes.length >= maxShapes) { overflow++; return; }
      var got = shapeSubsOf(el, tag);
      if (got.broken) counts.broken++;
      if (!got.subs.length) return;
      var subs = got.subs.map(function (s) { return { closed: s.closed, segs: mapSegs(s.segs, st.ctm) }; });
      var inh = st.inh;
      var fillP = tag === 'line' ? { hex: 'none', alpha: 1 } : resolvePaint(inh.fill, inh.color);
      var strokeP = resolvePaint(inh.stroke, inh.color);
      var sc = matScale(st.ctm), clipState;
      // 切り抜きを実際に切る
      if (st.clips.length) {
        var bb0 = [Infinity, Infinity, -Infinity, -Infinity];
        subs.forEach(function (s) { boundsOfSegs(s.segs, bb0); });
        var applied = true;
        st.clips.forEach(function (cp) {
          if (cp.unsupported) { applied = false; return; }
          if (!subs.length) return;
          if (bboxInsidePlanes(bb0, cp.planes)) return;
          var filled = fillP.hex !== 'none' && strokeP.hex === 'none';
          var input = subs.map(function (s) {
            if (filled && !s.closed && s.segs.length) {
              var a = segEnd(s.segs[s.segs.length - 1]), b = segStart(s.segs[0]);
              var segs = s.segs.slice();
              if (Math.abs(a[0] - b[0]) > EPS || Math.abs(a[1] - b[1]) > EPS) segs.push(L(a, b));
              return { closed: true, segs: segs };
            }
            return s;
          });
          subs = clipSubs(input, cp.planes);
          bb0 = [Infinity, Infinity, -Infinity, -Infinity];
          subs.forEach(function (s) { boundsOfSegs(s.segs, bb0); });
        });
        clipState = applied;
        if (!applied) counts.clip++;
        if (!subs.length) return;                    // 切り抜きの外に全部出た
      }
      var bb = [Infinity, Infinity, -Infinity, -Infinity];
      subs.forEach(function (s) { boundsOfSegs(s.segs, bb); });
      if (!isFinite(bb[0]) || !isFinite(bb[2])) return;
      var dash = null;
      if (inh['stroke-dasharray'] && inh['stroke-dasharray'] !== 'none') {
        var da = readNumbers(inh['stroke-dasharray']).map(function (v) { return v * sc; });
        if (da.length && da.some(function (v) { return v > 0; })) dash = da;
      }
      var shape = {
        id: el.getAttribute('id') || '', name: el.getAttribute('data-name') || '', tag: tag,
        groups: st.groups.slice(),
        subpaths: subs, d: '',
        fill: fillP.hex, fillOpacity: Math.max(0, Math.min(1, numOf(inh['fill-opacity'], 1) * fillP.alpha)),
        stroke: strokeP.hex, strokeOpacity: Math.max(0, Math.min(1, numOf(inh['stroke-opacity'], 1) * strokeP.alpha)),
        strokeWidth: Math.max(0, numOf(inh['stroke-width'], 1)) * sc,
        strokeLinecap: inh['stroke-linecap'] || 'butt', strokeLinejoin: inh['stroke-linejoin'] || 'miter',
        strokeMiterlimit: numOf(inh['stroke-miterlimit'], 4), strokeDasharray: dash,
        fillRule: inh['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
        opacity: Math.max(0, Math.min(1, st.opacity)), blend: st.blend || null,
        bbox: { x: bb[0], y: bb[1], w: bb[2] - bb[0], h: bb[3] - bb[1] }
      };
      if (fillP.gradient) shape.gradient = gradientWithMatrix(fillP.gradient, st.ctm);
      if (strokeP.gradient) shape.strokeGradient = gradientWithMatrix(strokeP.gradient, st.ctm);
      if (clipState !== undefined) shape.clip = clipState;
      shape.d = toPathD(shape);
      res.shapes.push(shape);
    }
    function gradientWithMatrix(g, ctm) {
      var o = {}; for (var k in g) if (Object.prototype.hasOwnProperty.call(g, k)) o[k] = g[k];
      // userSpaceOnUse: 座標を画面側(ルート)の座標へ送る行列。objectBoundingBox は図形の bbox が基準なので不要
      o.matrix = g.units === 'userSpaceOnUse' ? mul(ctm, g.transform) : null;
      return o;
    }

    function viewBoxMatrix(vb, w, h, par) {   // viewBox → (0,0,w,h) の行列（meet / slice / none）
      var sx = w / vb[2], sy = h / vb[3], s, tx, ty;
      par = String(par || 'xMidYMid meet').trim().split(/\s+/);
      if (par[0] === 'none') return [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
      s = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
      var ax = /xMin/.test(par[0]) ? 0 : /xMax/.test(par[0]) ? 1 : 0.5;
      var ay = /YMin/.test(par[0]) ? 0 : /YMax/.test(par[0]) ? 1 : 0.5;
      tx = (w - vb[2] * s) * ax - vb[0] * s; ty = (h - vb[3] * s) * ay - vb[1] * s;
      return [s, 0, 0, s, tx, ty];
    }
    function readViewBox(el) {
      var v = el.getAttribute('viewBox');
      if (!v) return null;
      var b = readNumbers(v);
      return b.length === 4 && b[2] > 0 && b[3] > 0 ? b : null;
    }

    function visit(el, st, depth) {
      var tag = tagOf(el);
      if (depth > 64) return;
      if (tag === 'text' || tag === 'tspan') { counts.text++; return; }
      if (tag === 'image' || tag === 'foreignobject') { counts.image++; return; }
      if (SKIP_TAGS[tag]) return;
      var d = declsOf(el);
      if (d.display === 'none') return;

      var inh = {}, k;
      for (k in st.inh) inh[k] = st.inh[k];
      INHERITED.forEach(function (p) {
        var v = d[p];
        if (v !== undefined && v !== 'inherit') inh[p] = v;
      });
      var ctm = mul(st.ctm, parseTransform(d.transform !== undefined ? d.transform : el.getAttribute('transform')));
      var op = st.opacity * numOf(d.opacity, 1);
      var blend = d['mix-blend-mode'] && d['mix-blend-mode'] !== 'normal' ? d['mix-blend-mode'] : st.blend;
      var clips = st.clips;
      if (d['clip-path'] && d['clip-path'] !== 'none') clips = clips.concat([resolveClip(d['clip-path'], ctm)]);
      if (d.mask && d.mask !== 'none' && (SHAPE_TAGS[tag] || tag === 'g' || tag === 'use')) counts.mask++;
      if (d.filter && d.filter !== 'none' && (SHAPE_TAGS[tag] || tag === 'g' || tag === 'use')) counts.filter++;
      var groups = st.groups;
      if (tag === 'g') {
        var gname = el.getAttribute('data-name') || el.getAttribute('id');
        if (gname) groups = groups.concat([gname]);
      }
      var ns = { ctm: ctm, inh: inh, opacity: op, blend: blend, clips: clips, groups: groups };
      if (d.visibility === 'hidden' || d.visibility === 'collapse') ns.inh.visibility = d.visibility;

      if (SHAPE_TAGS[tag]) {
        if (inh.visibility === 'hidden' || inh.visibility === 'collapse') return;
        emitShape(el, tag, ns, d);
        return;
      }
      if (tag === 'use') {
        var rid = hrefId(el), ref = rid ? byRef(rid) : null;
        if (!ref) { counts.missing++; return; }
        for (var a = el; a; a = a.parentNode) if (a === ref) return;   // 自分の祖先を参照＝無限再帰
        if (--useBudget < 0) return;
        var ux = numOf(el.getAttribute('x'), 0), uy = numOf(el.getAttribute('y'), 0);
        var uns = {
          ctm: mul(ns.ctm, [1, 0, 0, 1, ux, uy]), inh: ns.inh, opacity: ns.opacity, blend: ns.blend,
          clips: ns.clips, groups: ns.groups
        };
        var rt = tagOf(ref);
        if (rt === 'symbol' || rt === 'svg') {
          var vb = readViewBox(ref), uw = numOf(el.getAttribute('width'), NaN), uh = numOf(el.getAttribute('height'), NaN);
          if (vb) {
            var w2 = isFinite(uw) ? uw : numOf(ref.getAttribute('width'), vb[2]);
            var h2 = isFinite(uh) ? uh : numOf(ref.getAttribute('height'), vb[3]);
            uns.ctm = mul(uns.ctm, viewBoxMatrix(vb, w2, h2, ref.getAttribute('preserveAspectRatio')));
          }
          elChildren(ref).forEach(function (c) { visit(c, uns, depth + 1); });
        } else visit(ref, uns, depth + 1);
        return;
      }
      if (tag === 'svg' && el !== root) {   // 入れ子の svg: x/y と viewBox を畳む
        var nx = numOf(el.getAttribute('x'), 0), ny = numOf(el.getAttribute('y'), 0);
        var nvb = readViewBox(el), nw = numOf(el.getAttribute('width'), NaN), nh = numOf(el.getAttribute('height'), NaN);
        var nm = mul(ns.ctm, [1, 0, 0, 1, nx, ny]);
        if (nvb && isFinite(nw) && isFinite(nh) && nw > 0 && nh > 0) nm = mul(nm, viewBoxMatrix(nvb, nw, nh, el.getAttribute('preserveAspectRatio')));
        ns.ctm = nm;
      }
      // g / a / switch / svg / その他のコンテナ
      elChildren(el).forEach(function (c) { visit(c, ns, depth + 1); });
    }

    // ルートの寸法
    res.viewBox = readViewBox(root);
    var rw = root.getAttribute('width'), rh = root.getAttribute('height');
    res.width = /%$/.test(String(rw || '')) ? null : numOf(rw, null);
    res.height = /%$/.test(String(rh || '')) ? null : numOf(rh, null);

    var st0 = {
      ctm: ID.slice(), opacity: 1, blend: null, clips: [], groups: [],
      inh: {
        fill: 'black', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none', 'stroke-opacity': '1', 'stroke-width': '1',
        'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', 'stroke-dasharray': 'none',
        'stroke-dashoffset': '0', color: 'black', visibility: 'visible'
      }
    };
    rootDecls = declsOf(root);
    visit(root, st0, 0);

    // 全体の bbox（曲線の真の bbox）
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    res.shapes.forEach(function (s) { s.subpaths.forEach(function (sp) { boundsOfSegs(sp.segs, bb); }); });
    if (isFinite(bb[0])) res.bbox = { x: bb[0], y: bb[1], w: bb[2] - bb[0], h: bb[3] - bb[1] };

    // 警告（読めなかった物を件数つきで）
    var W = res.warnings;
    if (counts.text) W.push('文字は読み込めません（アウトライン化してください）: ' + counts.text + '個');
    if (counts.image) W.push('画像は読み込めません: ' + counts.image + '個');
    if (counts.mask) W.push('マスクは無視しました: ' + counts.mask + '個');
    if (counts.clip) W.push('切り抜きは無視しました: ' + counts.clip + '個');
    if (counts.filter) W.push('効果（フィルター）は無視しました: ' + counts.filter + '個');
    if (counts.pattern) W.push('パターンの塗りは読み込めません: ' + counts.pattern + '個');
    if (counts.badSelectors) W.push('解釈できないCSSの指定を無視しました: ' + counts.badSelectors + '個');
    if (counts.broken) W.push('パスの途中までしか読み取れなかった図形があります: ' + counts.broken + '個');
    if (counts.missing) W.push('参照先が見つからない指定がありました: ' + counts.missing + '個');
    if (overflow) W.push('図形が多いため先頭の' + maxShapes + '個だけ読み込みました（全部で' + shapeTotal + '個）');
    if (!res.shapes.length) W.push('図形が見つかりませんでした');
    return res;
  }

  /* shape → 'M x y L … C … Z'（absolute）。digits は小数桁 */
  function toPathD(shape, digits) {
    var dg = digits == null ? 4 : digits, pw = Math.pow(10, dg);
    function f(v) { var r = Math.round(v * pw) / pw; return String(r === 0 ? 0 : r); }
    var out = '';
    shape.subpaths.forEach(function (sp) {
      if (!sp.segs.length) return;
      var s0 = segStart(sp.segs[0]);
      out += 'M' + f(s0[0]) + ' ' + f(s0[1]);
      sp.segs.forEach(function (s, i) {
        if (s.type === 'L') {
          // 閉じる最後の直線は Z に任せる
          if (sp.closed && i === sp.segs.length - 1 && Math.abs(s.b[0] - s0[0]) < EPS && Math.abs(s.b[1] - s0[1]) < EPS) return;
          out += 'L' + f(s.b[0]) + ' ' + f(s.b[1]);
        } else out += 'C' + f(s.p1[0]) + ' ' + f(s.p1[1]) + ' ' + f(s.p2[0]) + ' ' + f(s.p2[1]) + ' ' + f(s.p3[0]) + ' ' + f(s.p3[1]);
      });
      if (sp.closed) out += 'Z';
    });
    return out;
  }

  /* セグメント列 → 折れ線の点（曲線は誤差 tol 以内に細分）。アンカーは必ず含む。
     戻り値は {pts:[[x,y]…], anchor:[bool…]}（閉じた輪でも終点=始点の重複は付けない） */
  function flattenSegs(segs, tol, closed) {
    tol = tol > 0 ? tol : 0.25;
    var pts = [], anchor = [], i;
    if (!segs.length) return { pts: pts, anchor: anchor };
    var s0 = segStart(segs[0]);
    pts.push([s0[0], s0[1]]); anchor.push(true);
    segs.forEach(function (s) {
      if (s.type === 'C') {
        var dd = Math.max(
          Math.hypot(s.p0[0] - 2 * s.p1[0] + s.p2[0], s.p0[1] - 2 * s.p1[1] + s.p2[1]),
          Math.hypot(s.p1[0] - 2 * s.p2[0] + s.p3[0], s.p1[1] - 2 * s.p2[1] + s.p3[1]));
        var n = Math.max(1, Math.min(200, Math.ceil(Math.sqrt(0.75 * dd / tol))));
        for (i = 1; i < n; i++) { pts.push(evalCubic(s, i / n)); anchor.push(false); }
      }
      var e = segEnd(s);
      pts.push([e[0], e[1]]); anchor.push(true);
    });
    if (closed && pts.length > 1) {
      var a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) { pts.pop(); anchor.pop(); }
    }
    return { pts: pts, anchor: anchor };
  }

  /* ==========================================================================
     11. 貼り付けイベントから SVG の文字列を取り出す
     image/svg+xml → text/plain → text/html の順（Illustrator は text/plain 側に入れる）
     ========================================================================== */
  function looksLikeSvg(s) {
    return /<svg[\s>]/i.test(s) || /<(?:path|rect|circle|ellipse|polygon|polyline|line|g)[\s/>]/i.test(s);
  }
  function readClipboard(ev) {
    var cd = ev && (ev.clipboardData || ev.dataTransfer || ev);
    if (!cd || typeof cd.getData !== 'function') return '';
    var types = ['image/svg+xml', 'text/plain', 'text/html'];
    for (var i = 0; i < types.length; i++) {
      var s = '';
      try { s = cd.getData(types[i]) || ''; } catch (e) { s = ''; }
      if (!s) continue;
      if (types[i] === 'text/html') {
        var m = /<svg[\s\S]*<\/svg>/i.exec(s);
        if (m) return m[0];
        continue;
      }
      if (looksLikeSvg(s)) return s;
    }
    return '';
  }

  var api = {
    version: VERSION,
    parse: parse,
    readClipboard: readClipboard,
    toPathD: toPathD,
    flattenSegs: flattenSegs,
    // 純関数（テスト・他ツール向け）
    parseColor: parseColor,
    parseTransform: parseTransform,
    parseD: function (d) { return parseD(d).subs; },
    boundsOfSegs: function (segs) { var b = boundsOfSegs(segs); return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }; },
    arcToCubics: arcToCubics
  };
  global.StudioSvgIn = api;
  if (global.Studio && typeof global.Studio === 'object') global.Studio.svgIn = api;
})(typeof window !== 'undefined' ? window : this);
