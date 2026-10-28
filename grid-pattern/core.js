/* ============================================================================
   core.js — グリッドパターンの純関数（DOM・Studio に依存しない）。
   node からは require、ブラウザでは window.GridCore。
   中身: パターン・並び順（ペアノ・Z順などを含む）・ルールの評価・対称・ランダムの型・候補（固定・残す）（開始位置・帯の値）（2本目の重ね・範囲・手で直した値）・図形の形（角丸・多角形・星・貼った図形）・グリッドの形（四角・行ずらし・六角・三角）・状態の検査・プリセット。
   座標は呼び出し側が渡す「1マスの大きさ s」の単位で書く（書き出しは小数2桁）。
   ========================================================================== */
(function (root, factory) {
  var GridCore = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = GridCore;
  if (root) root.GridCore = GridCore;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var K = 0.5523;
  function f(n) { n = Math.round(n * 100) / 100; return isFinite(n) ? n : 0; }   // 小数2桁。NaN・Infinity は出さない
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ============ パターン ============ */
  function hashInt(i, s) {
    var h = (i + s * 374761393) | 0; h = Math.imul(h ^ (h >>> 15), 2246822519); h ^= h >>> 13;
    h = Math.imul(h, 3266489917); h ^= h >>> 16; return h >>> 0;
  }
  var fibCache = {};
  function fibMod(i, p) {
    p = Math.max(2, p | 0); var a = fibCache[p] || (fibCache[p] = [0, 1]);
    while (a.length <= i) a.push((a[a.length - 1] + a[a.length - 2]) % p); return a[i];
  }
  function isPrime(n) {
    if (n < 2) return 0; if (n % 2 === 0) return n === 2 ? 1 : 0;
    for (var d = 3; d * d <= n; d += 2) if (n % d === 0) return 0; return 1;
  }

  /* 引数 a の入力欄の値 ⇄ 内部の a。交互だけ 2^a で見せる（入力は最も近い 2 のべき乗に丸める。対数の上で丸めるので 6 → 8（a=3）、5 → 4（a=2）） */
  function argShow(key, a) { var p = PATTERN[key]; return p && p.show ? p.show(a) : a; }
  function argRead(key, x) { var p = PATTERN[key]; return p && p.read ? p.read(x) : (+x || 0); }

  var PATTERN = {
    even:    { n: "均等割り", a: "個数", b: "周期", d: [5, 13],
               f: function (i, a, b) { return ((i * clamp(a, 0, 999)) % Math.max(1, b) < clamp(a, 0, 999)) ? 1 : 0; } },
    cycle:   { n: "くり返し", a: "周期", b: null, d: [4, 0], f: function (i, a) { return i % Math.max(1, a); } },
    block:   { n: "かたまり", a: "大きさ", b: null, d: [16, 0], f: function (i, a) { return Math.floor(i / Math.max(1, a)); } },
    pingpong: { n: "往復", a: "周期", b: null, d: [4, 0],
               f: function (i, a) { var p = Math.max(2, a), L = 2 * p - 2, m = ((i % L) + L) % L; return m < p ? m : L - m; } },
    serial:  { n: "連番", a: null, b: null, d: [0, 0], f: function (i) { return i; } },
    altern:  { n: "交互", a: "間隔", b: null, d: [1, 0], f: function (i, a) { return (i >> clamp(a, 0, 20)) & 1; },
               // 入力欄には 2^a（1, 2, 4, 8…）を見せる。内部の a は 2 を底とする対数のまま（旧状態・プリセットの見た目が変わらない）
               show: function (a) { return Math.pow(2, clamp(Math.round(+a || 0), 0, 20)); },
               read: function (x) { x = +x; return x >= 1 ? clamp(Math.round(Math.log2(x)), 0, 20) : 0; } },
    fib:     { n: "フィボナッチ", a: "周期", b: null, d: [5, 0], f: function (i, a) { return fibMod(i, a); } },
    prime:   { n: "素数", a: null, b: null, d: [0, 0], f: function (i) { return isPrime(i); } },
    random:  { n: "ランダム", a: "段数", b: "番号", d: [2, 1], f: function (i, a, b) { return hashInt(i, b) % Math.max(1, a); } },
    rowNo:   { n: "行番号", a: null, b: null, d: [0, 0], cell: function (r, c) { return r; } },
    colNo:   { n: "列番号", a: null, b: null, d: [0, 0], cell: function (r, c) { return c; } },
    center:  { n: "中心からの距離", a: null, b: null, d: [0, 0],
               cell: function (r, c, R, C) { return Math.round(Math.hypot(r - (R - 1) / 2, c - (C - 1) / 2)); } }
  };

  /* ============ 並び順 ============ */
  function byRow(R, C, z) { var o = []; for (var r = 0; r < R; r++) for (var k = 0; k < C; k++) o.push(r * C + ((z && r % 2) ? C - 1 - k : k)); return o; }
  function byCol(R, C, z) { var o = []; for (var c = 0; c < C; c++) for (var k = 0; k < R; k++) o.push(((z && c % 2) ? R - 1 - k : k) * C + c); return o; }
  function byDiag(R, C, z) {
    var o = []; for (var s = 0; s < R + C - 1; s++) {
      var g = [];
      for (var r = 0; r < R; r++) { var c = s - r; if (c >= 0 && c < C) g.push(r * C + c); }
      if (z && s % 2) g.reverse(); for (var i = 0; i < g.length; i++) o.push(g[i]);
    } return o;
  }
  function bySpiral(R, C) {
    var o = [], t = 0, b = R - 1, l = 0, g = C - 1;
    while (t <= b && l <= g) {
      for (var c = l; c <= g; c++) o.push(t * C + c); t++;
      for (var r = t; r <= b; r++) o.push(r * C + g); g--;
      if (t <= b) { for (var c2 = g; c2 >= l; c2--) o.push(b * C + c2); b--; }
      if (l <= g) { for (var r2 = b; r2 >= t; r2--) o.push(r2 * C + l); l++; }
    } return o;
  }
  function byHilbert(R, C) {
    var s = 1; while (s < Math.max(R, C)) s *= 2; var o = [];
    for (var d = 0; d < s * s; d++) {
      var t = d, x = 0, y = 0, rx, ry;
      for (var q = 1; q < s; q *= 2) {
        rx = 1 & (t >> 1); ry = 1 & (t ^ rx);
        if (ry === 0) { if (rx === 1) { x = q - 1 - x; y = q - 1 - y; } var w = x; x = y; y = w; }
        x += q * rx; y += q * ry; t >>= 2;
      }
      if (x < C && y < R) o.push(y * C + x);
    } return o;
  }
  function byRing(R, C) {
    var cr = (R - 1) / 2, cc = (C - 1) / 2, o = [];
    for (var i = 0; i < R * C; i++) o.push(i);
    return o.sort(function (p, q) {
      var dp = Math.hypot(((p / C) | 0) - cr, (p % C) - cc), dq = Math.hypot(((q / C) | 0) - cr, (q % C) - cc);
      if (dp !== dq) return dp - dq;
      return Math.atan2(((p / C) | 0) - cr, (p % C) - cc) - Math.atan2(((q / C) | 0) - cr, (q % C) - cc);
    });
  }
  function byShuffle(R, C) {
    var o = []; for (var i = 0; i < R * C; i++) o.push(i);
    for (var j = o.length - 1; j > 0; j--) { var k = hashInt(j, 20260802) % (j + 1); var t = o[j]; o[j] = o[k]; o[k] = t; }
    return o;
  }

  /* ペアノ曲線（3進）。R・C を超える 3^k の正方形で作り、範囲内のマスだけ拾う */
  function byPeano(R, C) {
    var k = 0, s = 1; while (s < Math.max(R, C)) { s *= 3; k++; }
    var o = [], n = s * s, d, i, t;
    for (d = 0; d < n; d++) {
      var digs = []; t = d;
      for (i = 0; i < 2 * k; i++) { digs.unshift(t % 3); t = Math.floor(t / 3); }
      var x = 0, y = 0, sx = 0, sy = 0;
      for (i = 0; i < k; i++) {
        var ax = digs[2 * i], ay = digs[2 * i + 1];
        var px = (sy % 2) ? 2 - ax : ax;   // x の桁は、上の桁の y の和が奇数なら反転
        sx += ax;
        var py = (sx % 2) ? 2 - ay : ay;   // y の桁は、ここまでの x の和が奇数なら反転
        sy += ay;
        x = x * 3 + px; y = y * 3 + py;
      }
      if (x < C && y < R) o.push(y * C + x);
    }
    return o;
  }
  /* Z順（Morton order）。2進の桁を x・y で交互に取る。R・C を超える 2 のべき乗の正方形で作り、範囲内だけ拾う */
  function byMorton(R, C) {
    var s = 1; while (s < Math.max(R, C)) s *= 2;
    var o = [], n = s * s, d, b;
    for (d = 0; d < n; d++) {
      var x = 0, y = 0;
      for (b = 0; (1 << b) < s; b++) { x |= ((d >> (2 * b)) & 1) << b; y |= ((d >> (2 * b + 1)) & 1) << b; }
      if (x < C && y < R) o.push(y * C + x);
    }
    return o;
  }
  /* 斜めのジグザグ（JPEG の zigzag）。左上から右下へ、斜めごとに向きを交互に。奇数番目の斜めは上から下へ・偶数番目は下から上へ */
  function byZigzag(R, C) {
    var o = [];
    for (var s = 0; s < R + C - 1; s++) {
      var g = [];
      for (var r = 0; r < R; r++) { var c = s - r; if (c >= 0 && c < C) g.push(r * C + c); }
      if (s % 2 === 0) g.reverse();
      for (var i = 0; i < g.length; i++) o.push(g[i]);
    } return o;
  }

  var ORDER = {
    row:      { n: "行", f: function (R, C) { return byRow(R, C, 0); } },
    rowWrap:  { n: "行（折り返し）", f: function (R, C) { return byRow(R, C, 1); } },
    col:      { n: "列", f: function (R, C) { return byCol(R, C, 0); } },
    colWrap:  { n: "列（折り返し）", f: function (R, C) { return byCol(R, C, 1); } },
    diag:     { n: "斜め", f: function (R, C) { return byDiag(R, C, 0); } },
    diagWrap: { n: "斜め（折り返し）", f: function (R, C) { return byDiag(R, C, 1); } },
    zigzag:   { n: "斜めのジグザグ", f: byZigzag },
    spiral:   { n: "スパイラル", f: bySpiral },
    spiralIn: { n: "外から中へ", f: function (R, C) { return bySpiral(R, C).reverse(); } },
    ring:     { n: "中心から外へ", f: byRing },
    hilbert:  { n: "ヒルベルト", f: byHilbert },
    peano:    { n: "ペアノ", f: byPeano },
    morton:   { n: "Z順", f: byMorton },
    shuffle:  { n: "ランダムな順", f: byShuffle }
  };

  /* ============ 図形の種類 ============ */
  /* 旧形式（PARAMS_VERSION 1）は図形を番号で持っていた。番号→type の対応（変えない）。 */
  var OLD_TYPES = ["square", "circle", "triangle", "diamond", "fan", "half", "rect", "cross", "slash", "arc"];
  /* 既製12種（既存10種＋多角形・星）。roundable = 角丸の欄を出す図形。always = 常に線で描く図形 */
  var SHAPE_TYPES = [
    { type: "square",   n: "正方形", roundable: true },
    { type: "circle",   n: "円" },
    { type: "triangle", n: "三角形", roundable: true },
    { type: "diamond",  n: "菱形", roundable: true },
    { type: "fan",      n: "扇形" },
    { type: "half",     n: "半円" },
    { type: "rect",     n: "長方形", roundable: true, def: { h: 50 } },   // 旧「長方形」は幅いっぱい・高さ半分。同じ見た目で始める
    { type: "cross",    n: "十字", roundable: true },
    { type: "slash",    n: "斜線", always: true },
    { type: "arc",      n: "円弧", always: true },
    { type: "polygon",  n: "多角形", roundable: true, def: { sides: 6 } },
    { type: "star",     n: "星", roundable: true, def: { sides: 5 } }
  ];
  var TYPE_INFO = {};
  SHAPE_TYPES.forEach(function (t) { TYPE_INFO[t.type] = t; });
  TYPE_INFO.custom = { type: "custom", n: "貼った図形" };
  var CUSTOM_NAME = "貼った図形";
  var MAX_SHAPES = 12, MAX_CUSTOM_SEGS = 2000;

  function typeName(sh) { return TYPE_INFO[sh.type] ? TYPE_INFO[sh.type].n : ""; }
  function canRound(type) { return !!(TYPE_INFO[type] && TYPE_INFO[type].roundable); }
  function alwaysLine(type) { return !!(TYPE_INFO[type] && TYPE_INFO[type].always); }

  function makeShape(type, over) {
    var info = TYPE_INFO[type] || TYPE_INFO.square;
    var sh = { type: info.type, w: 100, h: 100, angle: 0, round: 0, line: false, stroke: 18,
      sides: info.type === "star" ? 5 : 6, inner: 45, custom: null };
    if (info.def) for (var k in info.def) sh[k] = info.def[k];
    if (over) for (var k2 in over) sh[k2] = over[k2];
    return normalizeShape(sh);
  }

  function intIn(v, lo, hi, dv) {
    if (v == null || v === "" || typeof v === "boolean") return dv;
    v = Math.round(+v); return isFinite(v) ? clamp(v, lo, hi) : dv;
  }
  function num4(v) { v = Math.round(v * 10000) / 10000; return isFinite(v) ? v : 0; }
  function pt4(p) { return [num4(clamp(+p[0], -10, 10)), num4(clamp(+p[1], -10, 10))]; }
  function isPt(p) { return Array.isArray(p) && p.length >= 2 && isFinite(+p[0]) && isFinite(+p[1]) && p[0] !== null && p[1] !== null; }

  /* 貼った図形の検査。0〜1 の正方形内に正規化済みの {name, subs:[{segs, closed}], fillRule} だけを通す */
  function normalizeCustom(c) {
    if (!c || typeof c !== "object" || !Array.isArray(c.subs) || !c.subs.length || c.subs.length > 400) return null;
    var subs = [], total = 0;
    for (var i = 0; i < c.subs.length; i++) {
      var sp = c.subs[i];
      if (!sp || !Array.isArray(sp.segs) || !sp.segs.length) continue;
      var segs = [];
      for (var j = 0; j < sp.segs.length; j++) {
        var s = sp.segs[j];
        if (!s) return null;
        if (s.type === "L" && isPt(s.a) && isPt(s.b)) segs.push({ type: "L", a: pt4(s.a), b: pt4(s.b) });
        else if (s.type === "C" && isPt(s.p0) && isPt(s.p1) && isPt(s.p2) && isPt(s.p3))
          segs.push({ type: "C", p0: pt4(s.p0), p1: pt4(s.p1), p2: pt4(s.p2), p3: pt4(s.p3) });
        else return null;
      }
      total += segs.length;
      if (total > MAX_CUSTOM_SEGS) return null;
      subs.push({ segs: segs, closed: !!sp.closed });
    }
    if (!subs.length) return null;
    return { name: (typeof c.name === "string" && c.name) ? c.name.slice(0, 40) : CUSTOM_NAME, subs: subs,
      fillRule: c.fillRule === "evenodd" ? "evenodd" : "nonzero" };
  }

  /* 図形1つの検査・既定値の補完 */
  function normalizeShape(o) {
    if (!o || typeof o !== "object" || !TYPE_INFO[o.type]) return null;
    var type = o.type;
    var sh = { type: type,
      w: intIn(o.w, 10, 200, 100), h: intIn(o.h, 10, 200, 100),
      angle: 0, round: 0, line: false, stroke: intIn(o.stroke, 1, 40, 18),
      sides: intIn(o.sides, 3, 12, type === "star" ? 5 : 6), inner: intIn(o.inner, 10, 90, 45), custom: null };
    var a = Math.round(+o.angle);
    sh.angle = isFinite(a) ? ((a % 360) + 360) % 360 : 0;
    if (canRound(type)) sh.round = intIn(o.round, 0, 50, 0);
    if (!alwaysLine(type)) sh.line = o.line === true;
    if (type === "custom") { sh.custom = normalizeCustom(o.custom); if (!sh.custom) return null; }
    return sh;
  }

  /* ============ 図形の形 ============ */
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function lineSeg(a, b) { return { type: "L", a: a, b: b }; }
  function cubicSeg(p0, p1, p2, p3) { return { type: "C", p0: p0, p1: p1, p2: p2, p3: p3 }; }

  /* 閉じた多角形。r > 0 のとき、各頂点を隣の辺に沿って r（辺の半分まで）さかのぼった2点を結ぶ3次ベジェで丸める */
  function polySubs(pts, r) {
    var n = pts.length, segs = [], i;
    if (!(r > 1e-9)) {
      for (i = 0; i < n; i++) segs.push(lineSeg(pts[i], pts[(i + 1) % n]));
      return [{ segs: segs, closed: true }];
    }
    var A = [], B = [];
    for (i = 0; i < n; i++) {
      var V = pts[i], P = pts[(i + n - 1) % n], N = pts[(i + 1) % n];
      var lp = dist(V, P), ln = dist(V, N), t = Math.min(r, lp / 2, ln / 2);
      if (!(t > 1e-9) || !(lp > 1e-9) || !(ln > 1e-9)) { A[i] = V; B[i] = V; continue; }
      A[i] = [V[0] + (P[0] - V[0]) * t / lp, V[1] + (P[1] - V[1]) * t / lp];
      B[i] = [V[0] + (N[0] - V[0]) * t / ln, V[1] + (N[1] - V[1]) * t / ln];
    }
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n, Vi = pts[i];
      if (A[i] !== B[i])
        segs.push(cubicSeg(A[i], [A[i][0] + (Vi[0] - A[i][0]) * K, A[i][1] + (Vi[1] - A[i][1]) * K],
          [B[i][0] + (Vi[0] - B[i][0]) * K, B[i][1] + (Vi[1] - B[i][1]) * K], B[i]));
      if (dist(B[i], A[j]) > 1e-9) segs.push(lineSeg(B[i], A[j]));
    }
    return [{ segs: segs, closed: true }];
  }
  function ellipseSubs(cx, cy, rx, ry) {
    var kx = rx * K, ky = ry * K;
    return [{ closed: true, segs: [
      cubicSeg([cx + rx, cy], [cx + rx, cy + ky], [cx + kx, cy + ry], [cx, cy + ry]),
      cubicSeg([cx, cy + ry], [cx - kx, cy + ry], [cx - rx, cy + ky], [cx - rx, cy]),
      cubicSeg([cx - rx, cy], [cx - rx, cy - ky], [cx - kx, cy - ry], [cx, cy - ry]),
      cubicSeg([cx, cy - ry], [cx + kx, cy - ry], [cx + rx, cy - ky], [cx + rx, cy])] }];
  }
  function mapPt(m, p) { return m(p[0], p[1]); }
  function mapSubs(subs, m) {
    return subs.map(function (sp) {
      return { closed: sp.closed, segs: sp.segs.map(function (s) {
        return s.type === "L" ? lineSeg(mapPt(m, s.a), mapPt(m, s.b))
          : cubicSeg(mapPt(m, s.p0), mapPt(m, s.p1), mapPt(m, s.p2), mapPt(m, s.p3));
      }) };
    });
  }

  /* 図形（箱 s × sy の中の幅 w%・高さ h% に合わせる。sy を省くと s × s）→ サブパスの配列。角度はここで焼き込む */
  function shapeSubs(sh, s, sy) {
    if (sy == null) sy = s;
    var W = s * sh.w / 100, H = sy * sh.h / 100, ox = (s - W) / 2, oy = (sy - H) / 2;
    var r = canRound(sh.type) ? Math.min(W, H) * sh.round / 100 : 0;
    var subs, i;
    switch (sh.type) {
      case "square": case "rect":
        subs = polySubs([[0, 0], [W, 0], [W, H], [0, H]], r); break;
      case "circle": subs = ellipseSubs(W / 2, H / 2, W / 2, H / 2); break;
      case "triangle": subs = polySubs([[0, 0], [W, 0], [0, H]], r); break;
      case "diamond": subs = polySubs([[W / 2, 0], [W, H / 2], [W / 2, H], [0, H / 2]], r); break;
      case "fan":
        subs = [{ closed: true, segs: [lineSeg([0, 0], [W, 0]), cubicSeg([W, 0], [W, K * H], [K * W, H], [0, H]), lineSeg([0, H], [0, 0])] }]; break;
      case "half": {
        var hx = W / 2, hy = H / 2;
        subs = [{ closed: true, segs: [
          cubicSeg([0, hy], [0, hy - K * hy], [hx - K * hx, 0], [hx, 0]),
          cubicSeg([hx, 0], [hx + K * hx, 0], [W, hy - K * hy], [W, hy]),
          lineSeg([W, hy], [0, hy])] }]; break;
      }
      case "cross": {
        var xa = W / 3, xb = W * 2 / 3, ya = H / 3, yb = H * 2 / 3;
        subs = polySubs([[xa, 0], [xb, 0], [xb, ya], [W, ya], [W, yb], [xb, yb], [xb, H], [xa, H], [xa, yb], [0, yb], [0, ya], [xa, ya]], r); break;
      }
      case "slash": subs = [{ closed: false, segs: [lineSeg([0, 0], [W, H])] }]; break;
      case "arc": {
        var ax = W / 2, ay = H / 2;
        subs = [
          { closed: false, segs: [cubicSeg([ax, 0], [ax + K * ax, 0], [W, ay - K * ay], [W, ay])] },
          { closed: false, segs: [cubicSeg([ax, H], [ax - K * ax, H], [0, ay + K * ay], [0, ay])] }]; break;
      }
      case "polygon": case "star": {
        var n = intIn(sh.sides, 3, 12, 6), pts = [], rx = W / 2, ry = H / 2;
        var k = sh.type === "star" ? intIn(sh.inner, 10, 90, 45) / 100 : 1, cnt = sh.type === "star" ? n * 2 : n;
        for (i = 0; i < cnt; i++) {
          var ang = -Math.PI / 2 + Math.PI * 2 * i / cnt, q = (sh.type === "star" && i % 2) ? k : 1;
          pts.push([rx + rx * q * Math.cos(ang), ry + ry * q * Math.sin(ang)]);
        }
        subs = polySubs(pts, r); break;
      }
      case "custom":
        subs = mapSubs(sh.custom.subs, function (x, y) { return [x * W, y * H]; }); break;
      default: subs = [];
    }
    subs = mapSubs(subs, function (x, y) { return [x + ox, y + oy]; });
    var a = sh.angle || 0;
    if (a) {
      var rad = a * Math.PI / 180, c = Math.cos(rad), sn = Math.sin(rad), mx = s / 2, my = sy / 2;
      subs = mapSubs(subs, function (x, y) { var dx = x - mx, dy = y - my; return [mx + dx * c - dy * sn, my + dx * sn + dy * c]; });
    }
    return subs;
  }
  function pathD(subs) {
    var P = function (p) { return f(p[0]) + " " + f(p[1]); };
    return subs.map(function (sp) {
      if (!sp.segs.length) return "";
      var s0 = sp.segs[0], d = "M" + P(s0.type === "L" ? s0.a : s0.p0);
      sp.segs.forEach(function (s) {
        d += s.type === "L" ? "L" + P(s.b) : "C" + P(s.p1) + " " + P(s.p2) + " " + P(s.p3);
      });
      return d + (sp.closed ? "Z" : "");
    }).join("");
  }
  /* 図形1つの <path>（1マス s の座標）。線だけ・斜線・円弧は fill="none" と stroke-width */
  function shapeSVG(sh, s, sy) {
    var d = pathD(shapeSubs(sh, s, sy)), attrs = "";
    if (sh.line || alwaysLine(sh.type))
      attrs += ' fill="none" stroke-width="' + f(Math.min(s, sy == null ? s : sy) * sh.stroke / 100) + '"' + (sh.type === "slash" ? ' stroke-linecap="square"' : "");
    if (sh.type === "custom") attrs += ' fill-rule="' + sh.custom.fillRule + '"';
    return "<path" + attrs + ' d="' + d + '"/>';
  }

  /* ============ 貼った図形（svgparse.js の extractShapes の結果 → custom） ============ */
  function cubicPt(sg, t) {
    var u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [a * sg.p0[0] + b * sg.p1[0] + c * sg.p2[0] + d * sg.p3[0], a * sg.p0[1] + b * sg.p1[1] + c * sg.p2[1] + d * sg.p3[1]];
  }
  /* 戻り値: {custom} か {error} */
  function customFromShapes(shapes) {
    var subs = [], total = 0, evenodd = false, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function grow(p) {
      if (!isFinite(p[0]) || !isFinite(p[1])) return false;
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); return true;
    }
    for (var i = 0; i < (shapes || []).length; i++) {
      var sh = shapes[i];
      if (sh.fillRule === "evenodd") evenodd = true;
      for (var j = 0; j < (sh.subs || []).length; j++) {
        var sp = sh.subs[j];
        if (!sp.segs || !sp.segs.length) continue;
        total += sp.segs.length;
        if (total > MAX_CUSTOM_SEGS) return { error: "図形が複雑すぎて読めません（線の数が" + MAX_CUSTOM_SEGS + "を超えています）" };
        for (var k = 0; k < sp.segs.length; k++) {
          var sg = sp.segs[k];
          if (sg.type === "L") { if (!grow(sg.a) || !grow(sg.b)) return { error: "SVGの座標を読めませんでした" }; }
          else for (var t = 0; t <= 16; t++) if (!grow(cubicPt(sg, t / 16))) return { error: "SVGの座標を読めませんでした" };
        }
        subs.push(sp);
      }
    }
    if (!subs.length) return { error: "SVGに図形が見つかりません" };
    var bw = maxX - minX, bh = maxY - minY, m = Math.max(bw, bh);
    if (!(m > 1e-9)) return { error: "図形の大きさが0です" };
    var sc = 1 / m, offX = (1 - bw * sc) / 2 - minX * sc, offY = (1 - bh * sc) / 2 - minY * sc;
    var norm = mapSubs(subs, function (x, y) { return [x * sc + offX, y * sc + offY]; });
    var custom = normalizeCustom({ name: CUSTOM_NAME, subs: norm, fillRule: evenodd ? "evenodd" : "nonzero" });
    return custom ? { custom: custom } : { error: "SVGを図形として読めませんでした" };
  }

  /* ============ ルール ============ */
  var UNIT = 100;           // 1マスの大きさ（版面に合わせて拡縮する前の値）
  var FIT_MARGIN = 0.18;    // 版面の短辺に対する余白の割合（6x6 の初期形がちょうど短辺の約64%になる）
  var WORLD = 1000;         // 版面の短辺（書き出しSVGの座標）

  var STEP_OPTS = [15, 30, 45, 60, 90, 120, 180];   // 向きの刻み（°）
  var OPS = [{ k: "add", n: "足す" }, { k: "mul", n: "かける" }, { k: "over", n: "上書き" }];
  var AREAS = [
    { k: "all", n: "全部" },
    { k: "circleIn", n: "円の内側", size: true }, { k: "circleOut", n: "円の外側", size: true },
    { k: "boxIn", n: "四角の内側", size: true }, { k: "boxOut", n: "四角の外側", size: true },
    { k: "top", n: "上半分" }, { k: "bottom", n: "下半分" }, { k: "left", n: "左半分" }, { k: "right", n: "右半分" }
  ];
  var AREA_INFO = {}, OP_INFO = {};
  AREAS.forEach(function (a) { AREA_INFO[a.k] = a; });
  OPS.forEach(function (o) { OP_INFO[o.k] = o; });
  function mod(x, m) { return ((x % m) + m) % m; }

  /* ルールごとの追加項目。無い・壊れている値は既定値で補う（旧状態はそのまま読める） */
  function orientP(w) {
    var s = Math.round(+(w && w.step)); if (STEP_OPTS.indexOf(s) < 0) s = 90;
    return { step: s, mirror: !(w && w.mirror === false) };
  }
  function orientCount(w) { var p = orientP(w); return (360 / p.step) * (p.mirror ? 2 : 1); }
  /* 値 v → 角度（刻みの倍数）と左右反転。v ≥ 360/刻み のとき反転 */
  function orientOf(w, v) {
    var p = orientP(w), nb = 360 / p.step, n = nb * (p.mirror ? 2 : 1); v = mod(Math.round(+v) || 0, n);
    return { angle: (v % nb) * p.step, mirror: v >= nb };
  }
  function scaleP(w) {
    return { min: intIn(w && w.min, 5, 200, 25), max: intIn(w && w.max, 5, 200, 100), steps: intIn(w && w.steps, 2, 10, 5) };
  }
  /* 段ごとの倍率（%）。min > max でもよい（逆向き） */
  function scaleTable(w) {
    var p = scaleP(w), out = [];
    for (var v = 0; v < p.steps; v++) out.push(p.min + (p.max - p.min) * v / (p.steps - 1));
    return out;
  }
  /* 値 v → 倍率（1 = 100%）。v < 0（ルールが無い・範囲の外）は 100% */
  function scaleOf(w, v) {
    if (!(v >= 0)) return 1;
    var t = scaleTable(w); return t[Math.min(Math.round(v), t.length - 1)] / 100;
  }
  function colorP(w) { return { count: intIn(w && w.count, 2, 4, 2) }; }
  function shiftP(w) { return { steps: intIn(w && w.steps, 2, 9, 3), amount: intIn(w && w.amount, 0, 100, 25) }; }
  /* 段ごとのずれ（%・マスに対して）。−最大〜+最大 */
  function shiftTable(w) {
    var p = shiftP(w), out = [];
    for (var v = 0; v < p.steps; v++) out.push((2 * v / (p.steps - 1) - 1) * p.amount);
    return out;
  }
  function shiftOf(w, v) {
    if (!(v >= 0)) return 0;
    var t = shiftTable(w); return t[Math.min(Math.round(v), t.length - 1)];
  }
  function colorCount(S) { return colorP(S && S.rules && S.rules.fill).count; }

  function OFF() { return { pattern: "cycle", a: 4, b: 0, order: "row", off: true, extra: null, area: defaultArea() }; }
  function ON(p, a, b, o) { return { pattern: p, a: a, b: b, order: o, off: false, extra: null, area: defaultArea() }; }
  function defaultArea() { return { type: "all", size: 50 }; }
  function defaultExtra() { return { pattern: "cycle", a: 2, b: 0, order: "col", op: "add", start: 0 }; }
  /* 数え始めの位置（並び順で数えるパターンだけ。値 = f(i + start)）。無い・壊れていれば 0 */
  var MAX_START = 999;
  function startOf(w) { return intIn(w && w.start, 0, MAX_START, 0); }
  function normArea(a) {
    if (!a || typeof a !== "object" || !AREA_INFO[a.type]) return defaultArea();
    return { type: a.type, size: intIn(a.size, 5, 100, 50) };
  }
  function normExtra(e) {
    if (!e || typeof e !== "object" || !PATTERN[e.pattern] || !ORDER[e.order]) return null;
    return { pattern: e.pattern, a: +e.a || 0, b: +e.b || 0, order: e.order, op: OP_INFO[e.op] ? e.op : "add", start: startOf(e) };
  }
  var RULE_EXTRA = {
    orient: function (w) { return orientP(w); },
    scale: function (w) { return scaleP(w); },
    fill: function (w) { return colorP(w); },
    dx: function (w) { return shiftP(w); },
    dy: function (w) { return shiftP(w); }
  };
  /* ルール1つの検査・既定値の補完（パターンと並び順が壊れていれば既定のくり返し・行） */
  function normRule(id, w) {
    w = w || {};
    var o = { pattern: PATTERN[w.pattern] ? w.pattern : "cycle", order: ORDER[w.order] ? w.order : "row", a: +w.a || 0, b: +w.b || 0,
      off: !!w.off, extra: normExtra(w.extra), area: normArea(w.area), start: startOf(w) };
    var sp = RULE_EXTRA[id];
    if (sp) { var s = sp(w); for (var k in s) o[k] = s[k]; }
    return o;
  }
  function ruleOf(S, id) { return (S && S.rules && S.rules[id]) || normRule(id, OFF()); }

  /* steps(S, w) = 段数。def(S, w) = ルールが無い・範囲の外のときの値（-1 は「標準」: 倍率 100%・ずれ 0） */
  var RULES = [
    { id: "visible", n: "表示",     steps: function () { return 2; },                                         def: function () { return 1; } },
    { id: "shape",   n: "図形",     steps: function (S) { return Math.max(1, S.shapes.length); },            def: function () { return 0; } },
    { id: "orient",  n: "向き",     steps: function (S, w) { return orientCount(w || ruleOf(S, "orient")); }, def: function () { return 0; } },
    { id: "scale",   n: "倍率",     steps: function (S, w) { return scaleP(w || ruleOf(S, "scale")).steps; }, def: function () { return -1; } },
    { id: "fill",    n: "色",       steps: function (S, w) { return colorP(w || ruleOf(S, "fill")).count; },  def: function () { return 0; } },
    { id: "dx",      n: "横のずれ", steps: function (S, w) { return shiftP(w || ruleOf(S, "dx")).steps; },    def: function () { return -1; } },
    { id: "dy",      n: "縦のずれ", steps: function (S, w) { return shiftP(w || ruleOf(S, "dy")).steps; },    def: function () { return -1; } }
  ];
  var RULE_INFO = {};
  RULES.forEach(function (r) { RULE_INFO[r.id] = r; });

  /* パターン + 並び順 → 全マスの値（M で割った余り） */
  function rawValues(pw, R, C, M) {
    var out = new Array(R * C).fill(0), p = PATTERN[pw.pattern];
    if (!p || !(M >= 1)) return out;
    if (p.cell) { for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) out[r * C + c] = mod(Math.round(p.cell(r, c, R, C)) || 0, M); return out; }
    var ord = (ORDER[pw.order] || ORDER.row).f(R, C), a = +pw.a || 0, b = +pw.b || 0, st = startOf(pw);
    ord.forEach(function (cell, i) { out[cell] = mod(Math.round(p.f(i + st, a, b)) || 0, M); });
    return out;
  }
  /* 重ね方: 足す = (v1+v2) mod M ／ かける = (v1×v2) mod M ／ 上書き = v2 が 0 でなければ v2、0 なら v1 */
  function combine(op, v1, v2, M) {
    if (op === "mul") return mod(v1 * v2, M);
    if (op === "over") return v2 !== 0 ? v2 : v1;
    return mod(v1 + v2, M);
  }
  /* 範囲の中にあるマス（true）。マスの中心を、グリッド全体の外接の中心からの位置で見る。
     円 = 外接の短辺 × size% を直径とする円／四角 = 外接と同じ比率で size% の四角／半分 = 中心より上・下・左・右（中心の行・列そのものはどちらにも入らない） */
  function areaMask(S, ar, L) {
    var b = L.box, mx = b.x + b.w / 2, my = b.y + b.h / 2, s = clamp(+ar.size || 50, 5, 100) / 100, eps = 1e-6 * Math.max(b.w, b.h, 1);
    var rad = s * Math.min(b.w, b.h) / 2;
    return L.cells.map(function (cl) {
      var dx = cl.cx - mx, dy = cl.cy - my;
      switch (ar.type) {
        case "circleIn": return Math.hypot(dx, dy) <= rad + eps;
        case "circleOut": return Math.hypot(dx, dy) > rad + eps;
        case "boxIn": return Math.abs(dx) <= s * b.w / 2 + eps && Math.abs(dy) <= s * b.h / 2 + eps;
        case "boxOut": return !(Math.abs(dx) <= s * b.w / 2 + eps && Math.abs(dy) <= s * b.h / 2 + eps);
        case "top": return dy < -eps;
        case "bottom": return dy > eps;
        case "left": return dx < -eps;
        case "right": return dx > eps;
        default: return true;
      }
    });
  }
  function cellKey(r, c) { return r + "," + c; }

  /* ルール1つを全マスの値にする。順序: パターン → 2本目を重ねる → 範囲で絞る → 手で直した値で上書き。L = layoutGrid（範囲に使う。省くと自分で作る） */
  function evalRule(rule, S, L) {
    var R = S.rows, C = S.cols, w = ruleOf(S, rule.id), M = rule.steps(S, w), dv = rule.def(S, w);
    var out = new Array(R * C).fill(dv);
    if (!w.off) {
      var v = rawValues(w, R, C, M);
      if (w.extra && PATTERN[w.extra.pattern] && ORDER[w.extra.order]) {
        var v2 = rawValues(w.extra, R, C, M);
        for (var i = 0; i < v.length; i++) v[i] = combine(w.extra.op, v[i], v2[i], M);
      }
      var ar = w.area && AREA_INFO[w.area.type] ? w.area : defaultArea();
      var mask = ar.type === "all" ? null : areaMask(S, ar, L || layoutGrid(S, UNIT));
      for (var j = 0; j < v.length; j++) out[j] = (mask && !mask[j]) ? dv : v[j];
    }
    var ov = S.overrides && S.overrides[rule.id];
    if (ov) for (var k in ov) {
      var m = /^(\d+),(\d+)$/.exec(k); if (!m) continue;
      var rr = +m[1], cc = +m[2]; if (rr >= R || cc >= C) continue;   // 行・列を減らして外に出たものは無視（消さない）
      var val = Math.round(+ov[k]); if (!isFinite(val)) continue;
      out[rr * C + cc] = clamp(val, 0, M - 1);
    }
    return out;
  }

  /* ============ 数値と段階の対応を見せる帯 ============ */
  /* ルール1つの「並び順の先頭から最大 max マス」の値（1本目＋2本目。範囲・手で直した値は除く）と段数。
     場所で決まるパターンは、行番号 = 1列目の行方向／列番号 = 1行目／中心からの距離 = 中央の行。OFF は null */
  function bandOf(S, id, max) {
    var R = S.rows, C = S.cols, w = ruleOf(S, id), rule = RULE_INFO[id];
    if (!rule || w.off) return null;
    max = max || 48;
    var M = rule.steps(S, w), v = rawValues(w, R, C, M);
    if (w.extra && PATTERN[w.extra.pattern] && ORDER[w.extra.order]) {
      var v2 = rawValues(w.extra, R, C, M);
      for (var i = 0; i < v.length; i++) v[i] = combine(w.extra.op, v[i], v2[i], M);
    }
    var p = PATTERN[w.pattern], out = [], n, k;
    if (!p.cell) {
      var ord = (ORDER[w.order] || ORDER.row).f(R, C); n = Math.min(max, ord.length);
      for (k = 0; k < n; k++) out.push(v[ord[k]]);
      return { values: out, steps: M, kind: "order" };
    }
    if (w.pattern === "rowNo") { n = Math.min(max, R); for (k = 0; k < n; k++) out.push(v[k * C]); return { values: out, steps: M, kind: "rows" }; }
    var row = w.pattern === "colNo" ? 0 : Math.floor((R - 1) / 2);
    n = Math.min(max, C); for (k = 0; k < n; k++) out.push(v[row * C + k]);
    return { values: out, steps: M, kind: w.pattern === "colNo" ? "firstRow" : "midRow" };
  }

  /* ============ 手で直す ============ */
  /* 画面上の 2 点（layoutGrid の座標）を結ぶ線分が通ったマス。マスの大きさの 1/4 以下の間隔で調べ、通った順に重複なしで返す（ドラッグで途中のマスを飛ばさない） */
  function cellsAlong(L, x0, y0, x1, y1) {
    var step = Infinity, out = [], last = null, i;
    for (i = 0; i < L.cells.length; i++) { var cl = L.cells[i]; step = Math.min(step, cl.bw, cl.bh); }
    step = isFinite(step) && step > 0 ? step / 4 : 1;
    var len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.min(4000, Math.ceil(len / step)));
    for (i = 0; i <= n; i++) {
      var t = i / n, c = cellAt(L, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      if (c && c !== last) { out.push(c); last = c; }
    }
    return out;
  }
  function overrideCount(S, id) {
    var ov = S.overrides && S.overrides[id], n = 0;
    if (ov) for (var k in ov) { var m = /^(\d+),(\d+)$/.exec(k); if (m && +m[1] < S.rows && +m[2] < S.cols) n++; }
    return n;
  }
  /* 手で直したマスの一覧（今の行・列の範囲内。どの項目でも） */
  function overrideCells(S) {
    var seen = {}, out = [];
    RULES.forEach(function (R) {
      var ov = S.overrides && S.overrides[R.id];
      if (ov) for (var k in ov) { var m = /^(\d+),(\d+)$/.exec(k); if (m && +m[1] < S.rows && +m[2] < S.cols && !seen[k]) { seen[k] = 1; out.push([+m[1], +m[2]]); } }
    });
    return out;
  }
  function setOverride(S, id, r, c, v) {
    if (!RULE_INFO[id]) return false;
    if (!S.overrides) S.overrides = {};
    if (!S.overrides[id]) S.overrides[id] = {};
    var k = cellKey(r, c);
    if (S.overrides[id][k] === v) return false;
    S.overrides[id][k] = v; return true;
  }
  function clearOverride(S, id, r, c) {
    var ov = S.overrides && S.overrides[id], k = cellKey(r, c);
    if (!ov || !(k in ov)) return false;
    delete ov[k]; if (!Object.keys(ov).length) delete S.overrides[id]; return true;
  }
  function clearOverrides(S, id) {
    if (!S.overrides || !S.overrides[id]) return 0;
    var n = Object.keys(S.overrides[id]).length; delete S.overrides[id]; return n;
  }
  function pctText(x) { x = Math.round(x * 10) / 10; if (Object.is(x, -0)) x = 0; return String(x); }
  /* 手で直すときに選べる値（その項目の段を人が読める語で） */
  function valueOptions(S, id) {
    var w = ruleOf(S, id), out = [], i, n;
    if (id === "visible") return [{ v: 1, label: "出す" }, { v: 0, label: "消す" }];
    if (id === "shape") { S.shapes.forEach(function (sh, k) { out.push({ v: k, label: (k + 1) + " " + typeName(sh) }); }); return out; }
    if (id === "orient") {
      n = orientCount(w);
      for (i = 0; i < n; i++) { var o = orientOf(w, i); out.push({ v: i, label: o.angle + "°" + (o.mirror ? " 反転" : "") }); }
      return out;
    }
    if (id === "scale") { scaleTable(w).forEach(function (x, k) { out.push({ v: k, label: pctText(x) + "%" }); }); return out; }
    if (id === "fill") { n = colorP(w).count; for (i = 0; i < n; i++) out.push({ v: i, label: (i + 1) + "色目" }); return out; }
    shiftTable(w).forEach(function (x, k) { out.push({ v: k, label: (x > 0 ? "+" : "") + pctText(x) + "%" }); });
    return out;
  }
  /* キャプション用: ON のルールごとに「向き ← くり返し／行 ＋足す くり返し／列・円の内側・手で3マス」 */
  function ruleCaption(S) {
    var items = [];
    RULES.forEach(function (R) {
      var w = ruleOf(S, R.id), n = overrideCount(S, R.id);
      if (w.off) { if (n) items.push(R.n + " ← 手で" + n + "マス"); return; }
      var p = PATTERN[w.pattern], s = R.n + " ← " + p.n + (p.cell ? "" : "／" + ORDER[w.order].n + (startOf(w) ? "・開始 " + startOf(w) : ""));
      if (w.extra && PATTERN[w.extra.pattern] && ORDER[w.extra.order]) {
        var xp = PATTERN[w.extra.pattern];
        s += " ＋" + OP_INFO[w.extra.op].n + " " + xp.n + (xp.cell ? "" : "／" + ORDER[w.extra.order].n + (startOf(w.extra) ? "・開始 " + startOf(w.extra) : ""));
      }
      if (w.area && w.area.type !== "all" && AREA_INFO[w.area.type]) s += "・" + AREA_INFO[w.area.type].n;
      if (n) s += "・手で" + n + "マス";
      items.push(s);
    });
    return items;
  }

  /* ============ グリッドの形 ============ */
  /* マスの番号付け（行 r・列 c・i = r*C + c）は形によらず同じ。変わるのは中心の位置・マスの輪郭・図形の箱だけ */
  var GRIDS = [
    { k: "square", n: "四角" }, { k: "brick", n: "行ずらし" }, { k: "hex", n: "六角" }, { k: "tri", n: "三角" }
  ];
  var GRID_INFO = {};
  GRIDS.forEach(function (g) { GRID_INFO[g.k] = g; });
  var SQ3 = Math.sqrt(3);
  var TRI_BOX = 0.6;        // 三角の図形の箱（u に対する割合。三角形の中に収まる目安）
  var DEF_SHIFT = 50;
  function gridKind(S) { return (S && GRID_INFO[S.grid]) ? S.grid : "square"; }
  function gridName(k) { return GRID_INFO[k] ? GRID_INFO[k].n : ""; }
  /* 列の幅・行の高さを規則で変えられる形（四角・行ずらしだけ） */
  function sizeable(kind) { return kind === "square" || kind === "brick"; }
  /* 列の幅・行の高さに使えるパターン（列番号・行番号・中心からの距離のような場所で決まるものは除く） */
  function sizePatternKeys() { return Object.keys(PATTERN).filter(function (k) { return !PATTERN[k].cell; }); }
  function defaultSizeRule() { return { off: true, pattern: "cycle", a: 3, b: 0, min: 50 }; }

  /* 規則の段数 N（くり返し・往復はその周期、それ以外は n 本の範囲の v の最大 + 1） */
  function sizeSteps(w, n) {
    var p = PATTERN[w.pattern], a = Math.round(+w.a) || 0, b = Math.round(+w.b) || 0;
    if (w.pattern === "cycle") return clamp(Math.max(1, a), 1, 9999);
    if (w.pattern === "pingpong") return clamp(Math.max(2, a), 2, 9999);
    var mx = 0;
    for (var i = 0; i < n; i++) { var v = p.f(i, a, b); if (isFinite(v) && v > mx) mx = v; }
    return Math.max(1, Math.floor(mx) + 1);
  }
  /* n 本ぶんの幅（高さ）。u が基準の 100%。off・使えないパターンなら全部 u */
  function axisSizes(w, n, u) {
    var out = [], i;
    if (!w || w.off || !PATTERN[w.pattern] || PATTERN[w.pattern].cell) { for (i = 0; i < n; i++) out.push(u); return out; }
    var p = PATTERN[w.pattern], a = Math.round(+w.a) || 0, b = Math.round(+w.b) || 0;
    var mn = clamp(+w.min || 0, 1, 100), N = sizeSteps(w, n);
    for (i = 0; i < n; i++) {
      var v = Math.round(p.f(i, a, b)); if (!isFinite(v)) v = 0;
      v = clamp(v, 0, N - 1);
      var frac = N > 1 ? v / (N - 1) : 1;
      out.push(u * (mn + (100 - mn) * frac) / 100);
    }
    return out;
  }

  /* 全マスの中心・図形の箱・輪郭と、その外接（間隔が負のときのはみ出しを含む）。u = 1マスの大きさ、原点 = グリッドの左上 */
  function layoutGrid(S, u) {
    var R = S.rows, C = S.cols, kind = gridKind(S), cells = [], r, c, k;
    var gf = 1 - (S.gap || 0) / 100;
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    function grow(x, y) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); }
    function add(r, c, cx, cy, bw, bh, poly, up, pw, ph) {   // pw・ph = ずれの基準（マスの幅・高さ）
      cells.push({ r: r, c: c, cx: cx, cy: cy, bw: bw, bh: bh, poly: poly, up: up, pw: pw, ph: ph });
      poly.forEach(function (p) { grow(p[0], p[1]); });
      grow(cx - bw * gf / 2, cy - bh * gf / 2); grow(cx + bw * gf / 2, cy + bh * gf / 2);
    }
    if (sizeable(kind)) {
      var cw = axisSizes(S.colSize, C, u), rh = axisSizes(S.rowSize, R, u), x0 = [], y0 = [], acc = 0;
      for (c = 0; c < C; c++) { x0.push(acc); acc += cw[c]; }
      var meanW = acc / C; acc = 0;
      for (r = 0; r < R; r++) { y0.push(acc); acc += rh[r]; }
      var d = kind === "brick" ? clamp(S.shift == null ? DEF_SHIFT : +S.shift, 0, 100) / 100 * meanW : 0;
      for (r = 0; r < R; r++) for (c = 0; c < C; c++) {
        var xl = x0[c] + ((r % 2) ? d : 0), xr = xl + cw[c], yt = y0[r], yb = yt + rh[r];
        var bw = S.stretch ? cw[c] : Math.min(cw[c], rh[r]), bh = S.stretch ? rh[r] : bw;
        add(r, c, (xl + xr) / 2, (yt + yb) / 2, bw, bh, [[xl, yt], [xr, yt], [xr, yb], [xl, yb]], true, cw[c], rh[r]);
      }
    } else if (kind === "hex") {
      var rp = u * SQ3 / 2, rr = u / SQ3;
      for (r = 0; r < R; r++) for (c = 0; c < C; c++) {
        var hx = u / 2 + c * u + ((r % 2) ? u / 2 : 0), hy = rr + r * rp, poly = [];
        for (k = 0; k < 6; k++) { var an = (-90 + 60 * k) * Math.PI / 180; poly.push([hx + rr * Math.cos(an), hy + rr * Math.sin(an)]); }
        add(r, c, hx, hy, u, u, poly, true, u, rp);
      }
    } else {
      var th = u * SQ3 / 2;
      for (r = 0; r < R; r++) for (c = 0; c < C; c++) {
        var up = ((r + c) % 2) === 0, tx = u / 2 + c * u / 2, top = r * th;
        var tp = up ? [[tx, top], [tx + u / 2, top + th], [tx - u / 2, top + th]]
                    : [[tx - u / 2, top], [tx + u / 2, top], [tx, top + th]];
        add(r, c, tx, top + (up ? 2 * th / 3 : th / 3), u * TRI_BOX, u * TRI_BOX, tp, up, u, th);
      }
    }
    return { cells: cells, box: { x: lo[0], y: lo[1], w: hi[0] - lo[0], h: hi[1] - lo[1] } };
  }

  /* マスの中心の位置 (x, y)（layoutGrid の原点からの座標）にあるマス。輪郭（多角形）に対する点の内外判定。なければ null */
  function pointInPoly(poly, x, y) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function cellAt(L, x, y) {
    for (var n = 0; n < L.cells.length; n++) {
      var cl = L.cells[n], p = cl.poly, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var k = 0; k < p.length; k++) { x0 = Math.min(x0, p[k][0]); x1 = Math.max(x1, p[k][0]); y0 = Math.min(y0, p[k][1]); y1 = Math.max(y1, p[k][1]); }
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (pointInPoly(p, x, y)) return cl;
    }
    return null;
  }

  /* ============ 対称（規則を評価したあとのマスごとの値を、位置で写し取る） ============ */
  var SYMS = [{ k: "none", n: "なし" }, { k: "lr", n: "左右" }, { k: "tb", n: "上下" }, { k: "lrtb", n: "左右と上下" }, { k: "rot4", n: "4回転" }];
  var SYM_INFO = {};
  SYMS.forEach(function (x) { SYM_INFO[x.k] = x; });
  function symType(S) { var t = S && S.sym && S.sym.type; return SYM_INFO[t] ? t : "none"; }
  function symName(t) { return SYM_INFO[t] ? SYM_INFO[t].n : ""; }
  /* キャプション用: 対称が「なし」なら空 */
  function symCaption(S) { var t = symType(S); return t === "none" ? "" : "対称 " + symName(t); }
  function neg(x) { return 0 - x; }   // -0 を作らない
  /* 角度 a（°）を刻み step の倍数のうち最も近いものへ（0〜359） */
  function snapAngle(a, step) { var s = Math.max(1, +step || 90), m = mod(a, 360); return mod(Math.round(m / s) * s, 360); }

  /* 全マスの値を、規則ごとに評価して 1 マス 1 つの状態にまとめる（対称より前）。
     状態 = {vis: 表示, shape: 図形の番号, angle: 向き（°）, mirror: 左右反転, sc: 倍率（1 = 100%）, fill: 色の番号, mx・my: 横・縦のずれ（マスに対する%）} */
  function rawCells(S, L) {
    var C = S.cols, R = S.rows, V = {};
    RULES.forEach(function (r) { V[r.id] = evalRule(r, S, L); });
    var nc = colorCount(S), wOri = ruleOf(S, "orient"), wSc = ruleOf(S, "scale"), wDx = ruleOf(S, "dx"), wDy = ruleOf(S, "dy"), out = [];
    for (var i = 0; i < R * C; i++) {
      var ori = orientOf(wOri, V.orient[i]);
      out.push({ vis: V.visible[i] ? 1 : 0, shape: V.shape[i] % Math.max(1, S.shapes.length), angle: ori.angle, mirror: ori.mirror,
        sc: scaleOf(wSc, V.scale[i]), fill: clamp(V.fill[i], 0, nc - 1), mx: shiftOf(wDx, V.dx[i]), my: shiftOf(wDy, V.dy[i]) });
    }
    return out;
  }
  /* 1マスの状態を、鏡映・回転した位置へ移したときの状態。
     左右の鏡映 = 反転を足し、角度 −θ・横のずれの符号を反転／上下の鏡映 = 反転を足し、角度 180°−θ・縦のずれの符号を反転
     （描画は「角度で回してから反転」なので、図形そのものを鏡に映した向きはこの式になる）／90° 回転 k 回 = 角度に 90°×k・ずれ (mx, my) → (−my, mx)。
     角度は向きの刻み step の倍数へ丸める */
  function moveCell(q, op, step) {
    var c = Object.assign({}, q);
    if (op.lr) { c.angle = snapAngle(neg(c.angle), step); c.mirror = !c.mirror; c.mx = neg(c.mx); }
    if (op.tb) { c.angle = snapAngle(180 - c.angle, step); c.mirror = !c.mirror; c.my = neg(c.my); }
    if (op.rot) {
      for (var k = 0; k < op.rot; k++) { var t = c.mx; c.mx = neg(c.my); c.my = t; }
      c.angle = snapAngle(c.angle + 90 * op.rot, step);
    }
    return c;
  }
  /* 4回転で、正方形（M×M）の中の (a, b) が、左上の 1/4 のどの (sa, sb) を何回（k）回したものか。{a, b, k} */
  function rotSource(M, a, b) {
    var h = Math.floor(M / 2);
    for (var k = 0; k < 4; k++) {
      var inD = (M % 2) ? ((a < h && b <= h) || (a === h && b === h)) : (a < h && b < h);
      if (inD) return { a: a, b: b, k: k };
      var na = M - 1 - b, nb = a; a = na; b = nb;   // 逆向きに 90° 戻す
    }
    return { a: a, b: b, k: 0 };
  }
  /* 状態の配列（R×C）に対称を掛けて、新しい配列を返す。type = none / lr / tb / lrtb / rot4 */
  function symmetrize(cells, R, C, type, step) {
    if (!SYM_INFO[type] || type === "none") return cells;
    var out = cells.slice(), r, c;
    function lr(a) { for (r = 0; r < R; r++) for (c = 0; c < C; c++) if (2 * c > C - 1) a[r * C + c] = moveCell(a[r * C + (C - 1 - c)], { lr: 1 }, step); }
    function tb(a) { for (r = 0; r < R; r++) if (2 * r > R - 1) for (c = 0; c < C; c++) a[r * C + c] = moveCell(a[(R - 1 - r) * C + c], { tb: 1 }, step); }
    if (type === "lr") lr(out);
    else if (type === "tb") tb(out);
    else if (type === "lrtb" || (type === "rot4" && R !== C)) { lr(out); tb(out); }
    if (type === "rot4") {
      var M = Math.min(R, C), oy = (R - M) >> 1, ox = (C - M) >> 1, src = out.slice();   // 回すのは真ん中の min(R,C) の正方形。はみ出た帯は左右と上下で埋めてある
      for (var a = 0; a < M; a++) for (var b = 0; b < M; b++) {
        var q = rotSource(M, a, b);
        out[(oy + a) * C + ox + b] = moveCell(src[(oy + q.a) * C + ox + q.b], { rot: q.k }, step);
      }
    }
    return out;
  }
  /* 全マスの状態（対称を掛けたあと）。L = layoutGrid（範囲に使う。省くと自分で作る）。i = 行 × 列の数 + 列 */
  function resolveCells(S, L) {
    L = L || layoutGrid(S, UNIT);
    return symmetrize(rawCells(S, L), S.rows, S.cols, symType(S), orientP(ruleOf(S, "orient")).step);
  }

  /* 全マスの図形（<g transform> の文字列）を色ごとに分けて返す（g1〜g4 と gs）。u = 1マスの大きさ、(ox, oy) = グリッドの左上 */
  function buildCells(S, u, ox, oy) {
    var C = S.cols, gs = [[], [], [], []], L = layoutGrid(S, u), st = resolveCells(S, L);
    var gf = 1 - S.gap / 100, flip = gridKind(S) === "tri" && S.flipDown !== false, nc = colorCount(S);
    for (var n = 0; n < L.cells.length; n++) {
      var cl = L.cells[n], q = st[cl.r * C + cl.c]; if (!q.vis) continue;
      var sh = S.shapes[q.shape];
      var sc = q.sc * gf, sx = cl.bw * sc, sy = cl.bh * sc;
      if (q.angle % 180 === 90) { var tmp = sx; sx = sy; sy = tmp; }   // 90°・270° で回すと箱の縦横が入れ替わるので、先に入れ替えて回したあとにマスへ合わせる
      var mx = q.mx / 100 * cl.pw, my = q.my / 100 * cl.ph;   // マスの幅・高さに対するずれ（中心から）
      var t = "translate(" + f(ox + cl.cx + mx) + " " + f(oy + cl.cy + my) + ")" + ((flip && !cl.up) ? " scale(1 -1)" : "") +
        " rotate(" + q.angle + ")" + (q.mirror ? " scale(-1 1)" : "") + " translate(" + f(-sx / 2) + " " + f(-sy / 2) + ")";
      gs[clamp(q.fill, 0, nc - 1)].push('<g transform="' + t + '">' + shapeSVG(sh, sx, sy) + "</g>");
    }
    return { g1: gs[0], g2: gs[1], g3: gs[2], g4: gs[3], gs: gs };
  }
  /* 書き出す色のグループ（g#color1〜g#color4・色の数だけ） */
  function colorGroups(S, cells) {
    var nc = colorCount(S), out = "", inks = [S.ink1, S.ink2, S.ink3 || INK3, S.ink4 || INK4];
    for (var k = 0; k < nc; k++) out += '<g id="color' + (k + 1) + '" fill="' + inks[k] + '" stroke="' + inks[k] + '">' + cells.gs[k].join("") + "</g>";
    return out;
  }

  /* ============ 使う図形の追加・削除・並べ替え（図形ルールの周期を図形の数に合わせる） ============ */
  /* 図形ルールが ON でパターンが「くり返し」「往復」なら、周期（引数 a）を図形の数にする。変えたら true */
  function fitShapePeriod(S) {
    var w = S.rules && S.rules.shape;
    if (!w || w.off || (w.pattern !== "cycle" && w.pattern !== "pingpong")) return false;
    var a = Math.max(w.pattern === "pingpong" ? 2 : 1, S.shapes.length);
    if (w.a === a) return false;
    w.a = a; return true;
  }
  function addShapeToState(S, sh) {
    if (!sh || S.shapes.length >= MAX_SHAPES) return false;
    S.shapes.push(sh);
    if (S.shapes.length > 1 && S.rules.shape.off) S.rules.shape = ON("cycle", S.shapes.length, 0, "diag");
    else fitShapePeriod(S);
    return true;
  }
  function removeShapeFromState(S, i) {
    if (S.shapes.length <= 1 || i < 0 || i >= S.shapes.length) return false;
    S.shapes.splice(i, 1); fitShapePeriod(S); return true;
  }
  /* 戻り値: 動かした先の番号（動かせなければ -1） */
  function moveShapeInState(S, i, d) {
    var j = i + d; if (i < 0 || i >= S.shapes.length || j < 0 || j >= S.shapes.length) return -1;
    var t = S.shapes[i]; S.shapes[i] = S.shapes[j]; S.shapes[j] = t; fitShapePeriod(S); return j;
  }

  /* ============ 状態 ============ */
  /* 1色目・2色目は規定パレット navy（§5 COLOR-00）。navy の残りは白（背景と同じ）だけなので、3色目・4色目は規定パレットの sumi の灰・cobalt の青灰 */
  var INK1 = "#0044CC", INK2 = "#14120F", INK3 = "#8C8B87", INK4 = "#6377A7", PAPER = "#FFFFFF";
  function blankRules() { var r = {}; RULES.forEach(function (R) { r[R.id] = normRule(R.id, OFF()); }); return r; }
  function present(rules) {
    var r = {}; rules = rules || {};
    RULES.forEach(function (R) { r[R.id] = normRule(R.id, rules[R.id] || OFF()); });
    return r;
  }
  /* INIT-01 最初の形: 6x6 の正方形を、交互のパターンを行（折り返し）の並び順で置いた市松 */
  function initState() {
    return { cols: 6, rows: 6, gap: 0, grid: "square", shift: DEF_SHIFT, flipDown: true,
      colSize: defaultSizeRule(), rowSize: defaultSizeRule(), stretch: false,
      shapes: [makeShape("square")], showGrid: false, ink1: INK1, ink2: INK2, ink3: INK3, ink4: INK4, bg: PAPER,
      rules: present({ visible: ON("altern", 0, 0, "rowWrap") }), overrides: {}, sym: { type: "none" } };
  }

  var HEXRE = /^#[0-9a-fA-F]{6}$/;
  /* 図形の配列の検査。旧形式（番号の配列）は昇順・重複なしで新形式へ。新形式は順番を保つ */
  function sanitizeShapes(list) {
    if (!Array.isArray(list)) return [];
    var allNum = list.every(function (g) { return typeof g === "number"; });
    if (allNum) {
      var ids = Array.from(new Set(list.filter(function (g) { return Number.isInteger(g) && g >= 0 && g < OLD_TYPES.length; }))).sort(function (x, y) { return x - y; });
      return ids.map(function (g) { return makeShape(OLD_TYPES[g]); });
    }
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_SHAPES; i++) {
      var g = list[i], sh = null;
      if (typeof g === "number") sh = (Number.isInteger(g) && g >= 0 && g < OLD_TYPES.length) ? makeShape(OLD_TYPES[g]) : null;
      else sh = normalizeShape(g);
      if (sh) out.push(sh);
    }
    return out;
  }
  /* 列の幅・行の高さの規則の検査。無い・壊れている項目は既定値で補う（旧状態はそのまま読める） */
  function sanitizeSizeRule(w) {
    var d = defaultSizeRule();
    if (!w || typeof w !== "object") return d;
    var pattern = (PATTERN[w.pattern] && !PATTERN[w.pattern].cell) ? w.pattern : null;
    if (!pattern) return Object.assign(d, { off: w.off === undefined ? true : !!w.off });
    return { off: w.off === undefined ? true : !!w.off, pattern: pattern, a: +w.a || 0, b: +w.b || 0, min: intIn(w.min, 10, 100, 50) };
  }
  /* 手で直した値の検査。壊れたキー（"行,列" の形でない・64 以上）と数でない値は落とす。行・列の数を超えるものは残す（数を戻すと復活する） */
  function sanitizeOverrides(ov) {
    var out = {};
    if (!ov || typeof ov !== "object" || Array.isArray(ov)) return out;
    RULES.forEach(function (R) {
      var m = ov[R.id]; if (!m || typeof m !== "object" || Array.isArray(m)) return;
      var d = {};
      for (var k in m) {
        var mm = /^(\d{1,2}),(\d{1,2})$/.exec(k);
        if (!mm || +mm[1] >= 64 || +mm[2] >= 64 || typeof m[k] !== "number" || !isFinite(m[k])) continue;
        d[k] = clamp(Math.round(m[k]), 0, 99);
      }
      if (Object.keys(d).length) out[R.id] = d;
    });
    return out;
  }
  /* 状態の検査（URL・書き出したSVGから戻す時の共通）。PARAMS_VERSION 1（図形が番号）も 2 も読む。旧形式（invert）も読む */
  function sanitize(o) {
    if (!o || typeof o !== "object" || !o.rules || !Array.isArray(o.shapes)) return null;
    var rules = {}, OLD_IDS = { visible: 1, shape: 1, orient: 1, scale: 1, fill: 1 };
    for (var i = 0; i < RULES.length; i++) {
      var R = RULES[i], w = o.rules[R.id];
      if (!w && !OLD_IDS[R.id]) { rules[R.id] = normRule(R.id, OFF()); continue; }   // 段3で増えたルール（横のずれ・縦のずれ）は旧状態に無い
      if (!w || !PATTERN[w.pattern] || !ORDER[w.order]) return null;
      rules[R.id] = normRule(R.id, w);
    }
    var shapes = sanitizeShapes(o.shapes);
    if (!shapes.length) return null;
    var ink1 = o.ink1, bg = o.bg;
    if (o.invert !== undefined && ink1 === undefined) { ink1 = o.invert ? "#F0F0F0" : "#232322"; bg = o.invert ? "#232322" : "#FFFFFF"; }
    var col = function (v, d) { return (v === "none" || HEXRE.test(v)) ? v : d; };
    return { cols: clamp(o.cols | 0, 2, 64), rows: clamp(o.rows | 0, 2, 64), gap: clamp(o.gap | 0, -25, 45),
      grid: GRID_INFO[o.grid] ? o.grid : "square", shift: intIn(o.shift, 0, 100, DEF_SHIFT), flipDown: o.flipDown !== false,
      colSize: sanitizeSizeRule(o.colSize), rowSize: sanitizeSizeRule(o.rowSize), stretch: o.stretch === true,
      shapes: shapes, showGrid: !!o.showGrid, ink1: col(ink1, INK1), ink2: col(o.ink2, INK2), ink3: col(o.ink3, INK3), ink4: col(o.ink4, INK4), bg: col(bg, PAPER),
      rules: rules, overrides: sanitizeOverrides(o.overrides), sym: { type: symType(o) } };   // 対称が無い旧状態は「なし」
  }

  /* ============ ランダム（薄い結果・効かないルール・形と合わない図形を出さない） ============ */
  /* 形ごとに合う図形。六角は円・多角形(6)・星・扇形・半円／三角は多角形(3)・三角形・円／行ずらしは長方形・半円・扇形・斜線・円弧／四角は全部。
     sides を持つ項目はその辺の数だけ */
  var SHAPE_FIT = {
    square: SHAPE_TYPES.map(function (t) { return { type: t.type }; }),
    brick: [{ type: "rect" }, { type: "half" }, { type: "fan" }, { type: "slash" }, { type: "arc" }],
    hex: [{ type: "circle" }, { type: "polygon", sides: 6 }, { type: "star" }, { type: "fan" }, { type: "half" }],
    tri: [{ type: "polygon", sides: 3 }, { type: "triangle" }, { type: "circle" }]
  };
  function shapeFits(grid, sh) {
    var list = SHAPE_FIT[GRID_INFO[grid] ? grid : "square"];
    for (var i = 0; i < list.length; i++) if (list[i].type === sh.type && (list[i].sides == null || list[i].sides === sh.sides)) return true;
    return false;
  }
  var ROT_BLIND = { circle: 1, square: 1, cross: 1, diamond: 1 };   // 90° の刻みで回しても見た目が変わらない図形（向きのルールが効かない）

  /* 見た目が同じになる向きの周期（°。0 = 周期なし）と、左右反転しても同じか */
  function rotPeriod(sh) {
    switch (sh.type) {
      case "circle": return 1;
      case "square": case "diamond": case "cross": return sh.w === sh.h ? 90 : 180;
      case "rect": case "slash": case "arc": return 180;
      case "polygon": case "star": return 360 / Math.max(3, sh.sides || 6);
      default: return 0;
    }
  }
  function mirrorSame(sh) { return { circle: 1, square: 1, diamond: 1, cross: 1, rect: 1, polygon: 1, star: 1 }[sh.type] === 1; }
  /* 1マスの「見た目」の印。同じ見た目なら同じ文字列（図形の対称性で変わらない向き・反転は区別しない） */
  function lookKey(S, q) {
    var sh = S.shapes[q.shape] || S.shapes[0], per = rotPeriod(sh), ang = q.angle;
    if (per) ang = Math.round(mod(ang, per) * 1000) / 1000;
    return [q.shape, ang, (q.mirror && !mirrorSame(sh)) ? 1 : 0, Math.round(q.sc * 1000), q.fill, Math.round(q.mx * 100), Math.round(q.my * 100)].join(",");
  }
  function lookSig(S) { return resolveCells(S).map(function (q) { return q.vis ? lookKey(S, q) : "-"; }).join("|"); }
  /* 薄い結果か: 表示されるマスが全体の 15% 未満、または表示されるマスがすべて同じ見た目（図形・向き・倍率・色・ずれ） */
  function isThin(S) {
    var cells = resolveCells(S), n = cells.length, vis = 0, first = null, same = true;
    for (var i = 0; i < n; i++) {
      var q = cells[i]; if (!q.vis) continue;
      vis++;
      var k = lookKey(S, q);
      if (first === null) first = k; else if (k !== first) same = false;
    }
    return vis === 0 || vis / n < 0.15 || same;
  }
  /* ルール id を OFF にすると見た目が変わるか（効いているか）。手で直した値は無い前提 */
  function ruleMatters(S, id) {
    var T = clone(S); T.rules[id].off = true; T.overrides = {};
    return lookSig(T) !== lookSig(S);
  }

  /* 型: ルールの組と、使う並び順・図形・対称の候補。型を 1 つ引いてから引数だけ揺らす。
     rules の各項目 = {id, p: パターンの候補, o: 並び順の候補, a・b: 引数の候補, x: そのルールだけの項目の候補, aFromSteps: 周期を段数に合わせる}
     shapes: "rot" = 回して見た目が変わる図形だけ／"any" = 形に合う図形ならどれでも。sym: 対称の候補（空 = 対称を入れない） */
  var ALL_GRIDS = ["square", "brick", "hex", "tri"];
  var RAND_TYPES = [
    { k: "stripeOrient", n: "縞と向き", grids: ALL_GRIDS, shapes: "rot", sym: ["lr", "tb", "lrtb"], rules: [
      { id: "visible", p: ["even"], o: ["row", "col", "rowWrap", "colWrap", "diag"], a: [3, 4, 5], b: [9, 11, 13] },
      { id: "orient", p: ["cycle", "pingpong"], o: ["row", "col", "diag", "rowWrap"], a: [2, 3, 4] }] },
    { k: "checkRadial", n: "市松と放射", grids: ALL_GRIDS, shapes: "any", sym: [], rules: [
      { id: "visible", p: ["altern"], o: ["rowWrap"], a: [0] },
      { id: "scale", p: ["center"], o: ["row"] }] },
    { k: "brickTurn", n: "行ずらしの向き", grids: ["brick"], shapes: "rot", sym: ["lr"], rules: [
      { id: "orient", p: ["cycle"], o: ["row", "rowWrap"], a: [2, 3, 4] },
      { id: "fill", p: ["altern"], o: ["rowWrap", "row"], a: [0, 1], x: { count: [2] } }] },
    { k: "randomColor", n: "ランダムな表示と3色", grids: ALL_GRIDS, shapes: "any", sym: ["lr", "lrtb", "rot4"], rules: [
      { id: "visible", p: ["random"], o: ["row"], a: [2, 2, 3], b: [1, 3, 5, 7, 11, 13] },
      { id: "fill", p: ["random"], o: ["row"], a: [3], b: [2, 4, 6, 8, 10], x: { count: [3] } }] },
    { k: "blockHilbert", n: "かたまりとヒルベルト", grids: ALL_GRIDS, shapes: "any", sym: ["rot4", "lrtb"], rules: [
      { id: "scale", p: ["block"], o: ["hilbert"], a: [4, 8, 16] },
      { id: "fill", p: ["altern"], o: ["hilbert"], a: [0, 1, 2], x: { count: [2] } }] },
    { k: "peanoZ", n: "ペアノとZ順", grids: ALL_GRIDS, shapes: "rot", sym: ["lr", "lrtb"], rules: [
      { id: "fill", p: ["altern"], o: ["peano", "morton"], a: [0, 1, 2], x: { count: [2] } },
      { id: "orient", p: ["cycle"], o: ["peano", "morton", "zigzag"], a: [2, 4] }] },
    { k: "mirror", n: "ランダムな向きと往復", grids: ALL_GRIDS, shapes: "rot", sym: ["lr", "tb", "lrtb", "rot4"], rules: [
      { id: "orient", p: ["random"], o: ["row"], a: [4, 6, 8], b: [1, 3, 5, 7] },
      { id: "scale", p: ["pingpong"], o: ["col", "row", "diag"], a: [3, 4] }] },
    { k: "wave", n: "ずれの往復", grids: ALL_GRIDS, shapes: "any", sym: ["lr", "tb", "lrtb"], rules: [
      { id: "dx", p: ["pingpong"], o: ["row", "col"], x: { steps: [3, 5], amount: [15, 25, 40] }, aFromSteps: true },
      { id: "dy", p: ["pingpong"], o: ["col", "row"], x: { steps: [3, 5], amount: [15, 25, 40] }, aFromSteps: true }] },
    { k: "diagScale", n: "斜めの表示と倍率", grids: ALL_GRIDS, shapes: "any", sym: ["lrtb", "rot4"], rules: [
      { id: "visible", p: ["even"], o: ["diag", "diagWrap", "zigzag", "spiralIn", "spiral"], a: [3, 4, 5], b: [9, 11, 13] },
      { id: "scale", p: ["cycle"], o: ["row", "col", "diag", "ring"], a: [3, 4, 5] },
      { id: "fill", p: ["altern"], o: ["row", "colWrap"], a: [0, 1], x: { count: [2] } }] },
    { k: "tile", n: "六角・三角の色と倍率", grids: ["hex", "tri"], shapes: "any", sym: ["lr", "tb", "lrtb"], rules: [
      { id: "fill", p: ["altern"], o: ["row", "rowWrap", "diag", "col"], a: [0, 1], x: { count: [2] } },
      { id: "scale", p: ["center", "cycle"], o: ["row", "diag"], a: [3, 4] }] }
  ];

  function pickOf(rand, a) { return a[Math.min(a.length - 1, Math.max(0, Math.floor(rand() * a.length)))]; }
  /* パターン 1 本ぶん（1本目・2本目共通の部分） */
  function randPat(rand, key, order, a, b) {
    var p = PATTERN[key];
    return { pattern: key, order: order, off: false,
      a: a != null ? a : (p.a ? 1 + Math.floor(rand() * 8) : p.d[0]),
      b: b != null ? b : (p.b ? 1 + Math.floor(rand() * 13) : p.d[1]),
      start: (!p.cell && rand() < 0.3) ? 1 + Math.floor(rand() * 12) : 0 };   // 開始は 30% で 1〜12
  }
  function randRule(rand, spec) {
    var key = pickOf(rand, spec.p), order = pickOf(rand, spec.o);
    var w = randPat(rand, key, order, spec.a ? pickOf(rand, spec.a) : null, spec.b ? pickOf(rand, spec.b) : null);
    if (rand() < 0.15) {   // 2本目は各ルール 15%
      var xk = pickOf(rand, Object.keys(PATTERN)), x = randPat(rand, xk, pickOf(rand, Object.keys(ORDER)));
      w.extra = { pattern: x.pattern, a: x.a, b: x.b, order: x.order, op: pickOf(rand, OPS).k, start: x.start };
    }
    if (rand() < 0.15) w.area = { type: pickOf(rand, AREAS.slice(1)).k, size: pickOf(rand, [30, 50, 70]) };   // 範囲も 15%
    switch (spec.id) {
      case "orient": w.step = rand() < 0.7 ? 90 : pickOf(rand, STEP_OPTS); w.mirror = rand() < 0.7; break;   // 刻みは 70% で 90°
      case "scale": w.min = pickOf(rand, [15, 25, 35]); w.max = pickOf(rand, [80, 100, 120]); w.steps = pickOf(rand, [4, 5, 6]); break;
      case "fill": w.count = pickOf(rand, [2, 2, 2, 2, 3, 4]); break;
      case "dx": case "dy": w.steps = pickOf(rand, [3, 3, 5]); w.amount = pickOf(rand, [15, 25, 40]); break;
    }
    if (spec.x) for (var k in spec.x) w[k] = pickOf(rand, spec.x[k]);
    if (spec.aFromSteps) w.a = w.steps;
    return normRule(spec.id, w);
  }
  /* 効かない 2本目・範囲・対称を外す（外しても見た目が変わらないものだけ） */
  function pruneNoEffect(S) {
    var sig = lookSig(S);
    RULES.forEach(function (R) {
      var w = S.rules[R.id]; if (w.off) return;
      if (w.extra) { var T = clone(S); T.rules[R.id].extra = null; if (lookSig(T) === sig) w.extra = null; }
      if (w.area && w.area.type !== "all") { var U = clone(S); U.rules[R.id].area = defaultArea(); if (lookSig(U) === sig) w.area = defaultArea(); }
    });
    if (symType(S) !== "none") { var V = clone(S); V.sym = { type: "none" }; if (lookSig(V) === sig) S.sym = { type: "none" }; }
    return S;
  }
  function onRuleIds(S) { return RULES.filter(function (R) { return !S.rules[R.id].off; }).map(function (R) { return R.id; }); }
  /* 受け入れ条件: ルール ON が 2〜4 本・薄くない・ON のルールがすべて効いている */
  function acceptable(S) {
    var ids = onRuleIds(S);
    if (ids.length < 2 || ids.length > 4 || isThin(S)) return false;
    for (var i = 0; i < ids.length; i++) if (!ruleMatters(S, ids[i])) return false;
    return true;
  }
  function randomBuild(rand, avoid) {
    var S = initState();
    S.grid = rand() < 0.7 ? "square" : pickOf(rand, ["brick", "hex", "tri"]);   // 形は 70% で四角・残りを他の3つに等分
    var cands = RAND_TYPES.filter(function (t) { return t.grids.indexOf(S.grid) >= 0; });
    var fresh = cands.filter(function (t) { return t.k !== avoid; });
    var T = pickOf(rand, fresh.length ? fresh : cands);
    var pool = SHAPE_FIT[S.grid].filter(function (e) { return T.shapes !== "rot" || !ROT_BLIND[e.type]; });
    if (!pool.length) pool = SHAPE_FIT[S.grid];
    var two = T.rules.length <= 3 && pool.length > 1 && rand() < 0.3;   // 図形が 2 つのときも同じ表の中から
    var first = pickOf(rand, pool), picked = [first];
    if (two) { var rest = pool.filter(function (e) { return e !== first; }); picked.push(pickOf(rand, rest)); }
    S.shapes = picked.map(function (e) { return makeShape(e.type, e.sides ? { sides: e.sides } : null); });
    S.rules = blankRules();
    T.rules.forEach(function (spec) { S.rules[spec.id] = randRule(rand, spec); });
    if (two) S.rules.shape = normRule("shape", ON("cycle", 2, 0, pickOf(rand, ["row", "col", "diag", "rowWrap"])));
    S.cols = S.rows = pickOf(rand, [8, 12, 16, 20]);
    S.shift = pickOf(rand, [25, 50, 75]); S.flipDown = true; S.stretch = false;
    var sizeKeys = sizePatternKeys();
    ["colSize", "rowSize"].forEach(function (key) {   // 列の幅・行の高さは四角・行ずらしのときだけ各 20%
      var pt = pickOf(rand, sizeKeys), p = PATTERN[pt];
      S[key] = { off: !(sizeable(S.grid) && rand() < 0.2), pattern: pt, a: p.a ? 1 + Math.floor(rand() * 5) : p.d[0], b: p.b ? 1 + Math.floor(rand() * 13) : p.d[1], min: pickOf(rand, [30, 50, 70]) };
    });
    if (T.sym.length && rand() < 0.35) S.sym = { type: pickOf(rand, T.sym) };   // 対称は 35%
    return { S: pruneNoEffect(S), kind: T.k };
  }
  /* 薄くならない確実な形（作り直しが 5 回続いたときだけ使う） */
  function safeBuild(rand) {
    var S = initState(); S.cols = S.rows = pickOf(rand, [8, 12, 16]);
    S.shapes = [makeShape("circle")];
    S.rules = present({ visible: ON("altern", 0, 0, "rowWrap"), scale: ON("center", 0, 0, "row") });
    return { S: S, kind: "safe" };
  }
  /* ランダムな状態を作る。rand は 0 以上 1 未満を返す関数（テストでは固定した乱数列を渡す）。avoid = 直前の型（続けて同じ系統にしない）。
     戻り値 {S, kind}。S は形・列の数・行の数・図形・ルール・対称・列の幅・行の高さだけを決める（色・間隔・グリッド線は初期値） */
  function randomPick(rand, avoid) {
    rand = rand || Math.random;
    for (var i = 0; i < 5; i++) { var r = randomBuild(rand, avoid); if (acceptable(r.S)) return r; }   // 薄い・効かないものは最大 5 回作り直す
    return safeBuild(rand);
  }
  function randomState(rand, avoid) { return randomPick(rand, avoid).S; }

  /* ============ 候補（ランダムを 8 つ並べて見比べる） ============ */
  var CAND_COUNT = 8;
  /* 候補 cand（randomPick の S）の一部を、今の版面 base で上書きした新しい状態を返す。locks = {grid: 形, shapes: 図形, color: 色}
     形 = grid・shift・flipDown・colSize・rowSize・stretch／図形 = shapes（図形ルールの周期も図形の数に合わせる）／色 = ink1〜ink4・bg。それ以外は cand のまま */
  function applyLocks(base, cand, locks) {
    var s = clone(cand); locks = locks || {};
    if (locks.grid) {
      s.grid = base.grid; s.shift = base.shift; s.flipDown = base.flipDown;
      s.colSize = clone(base.colSize); s.rowSize = clone(base.rowSize); s.stretch = base.stretch;
    }
    if (locks.shapes) { s.shapes = clone(base.shapes); fitShapePeriod(s); }
    if (locks.color) { s.ink1 = base.ink1; s.ink2 = base.ink2; s.ink3 = base.ink3; s.ink4 = base.ink4; s.bg = base.bg; }
    return s;
  }
  /* 8 枚の候補 [{S, kind, pinned}]。prev = 今ある 8 枚（pinned が true の枚はそのまま残し、ほかを作り直す）。avoid = 直前の型。
     並べたときに型が重ならないよう、同じ型が出たら最大 3 回引き直す（avoid には直前の枚の型を渡して系統を散らす） */
  function makeCandidates(rand, prev, avoid) {
    rand = rand || Math.random;
    var out = [], used = {}, last = avoid || null, i, p;
    for (i = 0; i < CAND_COUNT; i++) { p = prev && prev[i]; if (p && p.pinned) used[p.kind] = 1; }
    for (i = 0; i < CAND_COUNT; i++) {
      p = prev && prev[i];
      if (p && p.pinned) { out.push(p); last = p.kind; continue; }
      var r = null;
      for (var t = 0; t < 4; t++) { r = randomPick(rand, last); if (!used[r.kind]) break; }
      used[r.kind] = 1; last = r.kind;
      out.push({ S: r.S, kind: r.kind, pinned: false });
    }
    return out;
  }
  /* 候補 1 枚を、今の版面 base に重ねた状態（固定を掛ける。間隔は版面のものを使う・手で直した値は無い）。版面へ入れるときもこの状態をそのまま使う */
  function candidateState(base, entry, locks) {
    var s = applyLocks(base, entry.S, locks);
    s.gap = base.gap; s.showGrid = base.showGrid; s.overrides = {};
    return s;
  }

  /* ============ プリセット（図形は種類の名前で持つ。{type, sides…} で細かく指定してもよい） ============ */
  /* 形 grid・ずらし量 shift・対称 sym は省くと 四角・50・なし。上の 12 種は四角・対称なしのまま */
  var PRESETS = [
    { k: "縦じま",   rows: 13, cols: 13, s: ["square"],   w: { visible: ON("even", 5, 13, "row") } },
    { k: "ずれじま", rows: 13, cols: 13, s: ["square"],   w: { visible: ON("even", 5, 13, "rowWrap") } },
    { k: "うずまき", rows: 13, cols: 13, s: ["square"],   w: { visible: ON("even", 5, 13, "spiral") } },
    { k: "のこぎり", rows: 12, cols: 12, s: ["triangle"], w: { orient: ON("cycle", 4, 0, "rowWrap") } },
    { k: "かさね",   rows: 12, cols: 12, s: ["fan"],      w: { orient: ON("cycle", 4, 0, "col") } },
    { k: "めいろ",   rows: 16, cols: 16, s: ["slash"],    w: { orient: ON("random", 2, 7, "row") } },
    { k: "チェック", rows: 16, cols: 16, s: ["square"],   w: { fill: ON("altern", 2, 0, "hilbert") } },
    { k: "いれこ",   rows: 16, cols: 16, s: ["circle"],   w: { scale: ON("block", 16, 0, "hilbert") } },
    { k: "放射",     rows: 15, cols: 15, s: ["circle"],   w: { scale: ON("center", 0, 0, "row"), fill: ON("center", 0, 0, "row") } },
    { k: "わ",       rows: 15, cols: 15, s: ["arc"],      w: { orient: ON("cycle", 4, 0, "ring") } },
    { k: "たてよこ", rows: 12, cols: 12, s: ["rect"],     w: { orient: ON("cycle", 2, 0, "rowWrap") } },
    { k: "ちらし",   rows: 16, cols: 16, s: ["half"],     w: { visible: ON("even", 3, 8, "shuffle"), orient: ON("random", 8, 3, "row") } },
    /* 段5で足した 8 種（対称・新しい並び順・形を使うもの） */
    { k: "六角の花", rows: 13, cols: 13, s: ["circle"], grid: "hex", w: { scale: ON("center", 0, 0, "row") } },
    { k: "三角のうろこ", rows: 12, cols: 12, s: [{ type: "polygon", sides: 3 }], grid: "tri", w: { fill: ON("altern", 1, 0, "row") } },
    { k: "鏡",       rows: 12, cols: 12, s: ["triangle"], sym: "lr", w: { orient: ON("random", 8, 5, "row") } },
    { k: "風車",     rows: 12, cols: 12, s: ["fan"],      sym: "rot4", w: { orient: ON("cycle", 4, 0, "row") } },
    { k: "レンガ",   rows: 14, cols: 10, s: [{ type: "rect", w: 90, h: 60 }], grid: "brick", shift: 75, w: { fill: ON("altern", 0, 0, "rowWrap") } },
    { k: "ペアノ",   rows: 18, cols: 18, s: ["circle"],   w: { scale: ON("block", 9, 0, "peano") } },
    { k: "Z順",      rows: 16, cols: 16, s: ["square"],   w: { visible: ON("even", 5, 13, "morton") } },
    { k: "波",       rows: 12, cols: 12, s: ["circle"],   w: { dx: ON("pingpong", 3, 0, "row"), dy: ON("pingpong", 3, 0, "col") } }
  ];
  function presetShapes(p) { return p.s.map(function (t) { return typeof t === "string" ? makeShape(t) : makeShape(t.type, t); }); }
  /* プリセットの形・ずらし量・対称 */
  function presetGrid(p) { return GRID_INFO[p.grid] ? p.grid : "square"; }
  function presetShift(p) { return p.shift == null ? DEF_SHIFT : p.shift; }
  function presetSym(p) { return { type: SYM_INFO[p.sym] ? p.sym : "none" }; }

  return {
    K: K, f: f, clamp: clamp, clone: clone,
    PATTERN: PATTERN, ORDER: ORDER, RULES: RULES, UNIT: UNIT, FIT_MARGIN: FIT_MARGIN, WORLD: WORLD,
    OLD_TYPES: OLD_TYPES, SHAPE_TYPES: SHAPE_TYPES, MAX_SHAPES: MAX_SHAPES, CUSTOM_NAME: CUSTOM_NAME,
    typeName: typeName, canRound: canRound, alwaysLine: alwaysLine,
    makeShape: makeShape, normalizeShape: normalizeShape, normalizeCustom: normalizeCustom,
    shapeSubs: shapeSubs, pathD: pathD, shapeSVG: shapeSVG, customFromShapes: customFromShapes,
    evalRule: evalRule, buildCells: buildCells, colorGroups: colorGroups, colorCount: colorCount,
    STEP_OPTS: STEP_OPTS, OPS: OPS, AREAS: AREAS, ruleOf: ruleOf, normRule: normRule, defaultArea: defaultArea, defaultExtra: defaultExtra,
    orientP: orientP, orientCount: orientCount, orientOf: orientOf, scaleP: scaleP, scaleTable: scaleTable, scaleOf: scaleOf,
    colorP: colorP, shiftP: shiftP, shiftTable: shiftTable, shiftOf: shiftOf, areaMask: areaMask, combine: combine,
    pointInPoly: pointInPoly, cellAt: cellAt, cellKey: cellKey, cellsAlong: cellsAlong, bandOf: bandOf, argShow: argShow, argRead: argRead, startOf: startOf,
    overrideCount: overrideCount, overrideCells: overrideCells, setOverride: setOverride, clearOverride: clearOverride, clearOverrides: clearOverrides,
    valueOptions: valueOptions, ruleCaption: ruleCaption,
    GRIDS: GRIDS, TRI_BOX: TRI_BOX, DEF_SHIFT: DEF_SHIFT, gridKind: gridKind, gridName: gridName, sizeable: sizeable,
    sizePatternKeys: sizePatternKeys, defaultSizeRule: defaultSizeRule, sizeSteps: sizeSteps, axisSizes: axisSizes, layoutGrid: layoutGrid,
    fitShapePeriod: fitShapePeriod, addShapeToState: addShapeToState, removeShapeFromState: removeShapeFromState, moveShapeInState: moveShapeInState,
    INK1: INK1, INK2: INK2, INK3: INK3, INK4: INK4, PAPER: PAPER, OFF: OFF, ON: ON, blankRules: blankRules, present: present, initState: initState,
    sanitize: sanitize, PRESETS: PRESETS, presetShapes: presetShapes, presetGrid: presetGrid, presetShift: presetShift, presetSym: presetSym,
    SYMS: SYMS, symType: symType, symName: symName, symCaption: symCaption, snapAngle: snapAngle, rawCells: rawCells, moveCell: moveCell, symmetrize: symmetrize, resolveCells: resolveCells,
    SHAPE_FIT: SHAPE_FIT, shapeFits: shapeFits, RAND_TYPES: RAND_TYPES, isThin: isThin, ruleMatters: ruleMatters, lookSig: lookSig, onRuleIds: onRuleIds,
    randomState: randomState, randomPick: randomPick,
    CAND_COUNT: CAND_COUNT, applyLocks: applyLocks, makeCandidates: makeCandidates, candidateState: candidateState
  };
});
