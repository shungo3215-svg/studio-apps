/* ============================================================================
   sweep.js — 沿わせ配置 の核（DOM非依存の純関数群・UMD）。
   ガイドのパス(d文字列)を読み、弧長で位置決めして「並べるもの」を複製し、
   1個=1<path>のSVG文字列を組む。node でも browser でも同じ関数が動く。

   座標系・回転式は 157_線幅の抑揚/src/depth.js と同じ（z: 手前+・奥-、
   X軸回転(ax)→Y軸回転(ay)、正射投影）。rotateProject はここに式を複製する
   （drop間で import しない・spec.md 採用根拠を参照）。
   ========================================================================== */
(function (root, factory) {
  var Sweep = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Sweep;
  if (root) root.Sweep = Sweep;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==========================================================================
     1. parsePath(d) — d属性の文字列パーサ（M/L/H/V/C/S/Q/T/Z 絶対・相対）。
        戻り値: [{closed, anchors:[{x,y}], segs:[...]}]（サブパスごとに1つ）。
        segs: {type:'L', a:{x,y}, b:{x,y}} または {type:'C', p0,p1,p2,p3}（各{x,y}）。
        円弧(A)は spec.md が要求範囲外のため未対応（遭遇したらそこまでを残して終える）。
        implicit repeat（コマンド省略の連続座標）は cmd を書き換えずにループへ戻ることで
        自然に成立する（線幅の抑揚/svgin.js の parseD と同じ手筋・依存はしない）。
     ========================================================================== */
  function isWS(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ','; }
  function isDigitCh(c) { return c >= '0' && c <= '9'; }

  function parsePath(d) {
    var s = String(d == null ? '' : d);
    var n = s.length, i = 0;
    function skipSep() { while (i < n && isWS(s.charAt(i))) i++; }
    function readNumber() {
      var start = i, digits = false, c = s.charAt(i);
      if (c === '+' || c === '-') i++;
      while (i < n && isDigitCh(s.charAt(i))) { i++; digits = true; }
      if (i < n && s.charAt(i) === '.') { i++; while (i < n && isDigitCh(s.charAt(i))) { i++; digits = true; } }
      if (!digits) { i = start; return null; }
      if (i < n && (s.charAt(i) === 'e' || s.charAt(i) === 'E')) {
        var j = i + 1, ed = false;
        if (j < n && (s.charAt(j) === '+' || s.charAt(j) === '-')) j++;
        while (j < n && isDigitCh(s.charAt(j))) { j++; ed = true; }
        if (ed) i = j;
      }
      var v = parseFloat(s.slice(start, i));
      return isFinite(v) ? v : null;
    }
    function readArgs(count) {
      var out = [];
      for (var k = 0; k < count; k++) {
        skipSep();
        var v = readNumber();
        if (v === null) return null;
        out.push(v);
      }
      return out;
    }
    var CMDRE = /[MmLlHhVvCcSsQqTtZz]/;
    var subs = [], cur = null;
    var x = 0, y = 0, sx = 0, sy = 0;
    var prevCtrl = null, prevKind = '';
    var cmd = '';

    function open() { if (!cur) { cur = { closed: false, anchors: [{ x: x, y: y }], segs: [] }; sx = x; sy = y; } }
    function flush() { if (cur) { subs.push(cur); cur = null; } }

    outer:
    for (;;) {
      skipSep();
      if (i >= n) break;
      var ch = s.charAt(i);
      if (CMDRE.test(ch)) { cmd = ch; i++; skipSep(); }
      else if (!cmd) break;
      var rel = cmd >= 'a';
      var CMD = cmd.toUpperCase();
      var a, nx, ny, p1, p2, p3, q;

      switch (CMD) {
      case 'M':
        a = readArgs(2); if (!a) break outer;
        flush();
        x = rel ? x + a[0] : a[0];
        y = rel ? y + a[1] : a[1];
        cur = { closed: false, anchors: [{ x: x, y: y }], segs: [] };
        sx = x; sy = y; prevKind = '';
        cmd = rel ? 'l' : 'L';
        continue;
      case 'L':
        a = readArgs(2); if (!a) break outer;
        open();
        nx = rel ? x + a[0] : a[0]; ny = rel ? y + a[1] : a[1];
        cur.segs.push({ type: 'L', a: { x: x, y: y }, b: { x: nx, y: ny } });
        cur.anchors.push({ x: nx, y: ny });
        x = nx; y = ny; prevKind = '';
        continue;
      case 'H':
        a = readArgs(1); if (!a) break outer;
        open();
        nx = rel ? x + a[0] : a[0];
        cur.segs.push({ type: 'L', a: { x: x, y: y }, b: { x: nx, y: y } });
        cur.anchors.push({ x: nx, y: y });
        x = nx; prevKind = '';
        continue;
      case 'V':
        a = readArgs(1); if (!a) break outer;
        open();
        ny = rel ? y + a[0] : a[0];
        cur.segs.push({ type: 'L', a: { x: x, y: y }, b: { x: x, y: ny } });
        cur.anchors.push({ x: x, y: ny });
        y = ny; prevKind = '';
        continue;
      case 'C':
        a = readArgs(6); if (!a) break outer;
        open();
        p1 = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
        p2 = { x: rel ? x + a[2] : a[2], y: rel ? y + a[3] : a[3] };
        p3 = { x: rel ? x + a[4] : a[4], y: rel ? y + a[5] : a[5] };
        cur.segs.push({ type: 'C', p0: { x: x, y: y }, p1: p1, p2: p2, p3: p3 });
        cur.anchors.push({ x: p3.x, y: p3.y });
        x = p3.x; y = p3.y; prevCtrl = p2; prevKind = 'C';
        continue;
      case 'S':
        a = readArgs(4); if (!a) break outer;
        open();
        p1 = (prevKind === 'C' && prevCtrl) ? { x: 2 * x - prevCtrl.x, y: 2 * y - prevCtrl.y } : { x: x, y: y };
        p2 = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
        p3 = { x: rel ? x + a[2] : a[2], y: rel ? y + a[3] : a[3] };
        cur.segs.push({ type: 'C', p0: { x: x, y: y }, p1: p1, p2: p2, p3: p3 });
        cur.anchors.push({ x: p3.x, y: p3.y });
        x = p3.x; y = p3.y; prevCtrl = p2; prevKind = 'C';
        continue;
      case 'Q':
        a = readArgs(4); if (!a) break outer;
        open();
        q = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
        p3 = { x: rel ? x + a[2] : a[2], y: rel ? y + a[3] : a[3] };
        p1 = { x: x + 2 / 3 * (q.x - x), y: y + 2 / 3 * (q.y - y) };
        p2 = { x: p3.x + 2 / 3 * (q.x - p3.x), y: p3.y + 2 / 3 * (q.y - p3.y) };
        cur.segs.push({ type: 'C', p0: { x: x, y: y }, p1: p1, p2: p2, p3: p3 });
        cur.anchors.push({ x: p3.x, y: p3.y });
        x = p3.x; y = p3.y; prevCtrl = q; prevKind = 'Q';
        continue;
      case 'T':
        a = readArgs(2); if (!a) break outer;
        open();
        q = (prevKind === 'Q' && prevCtrl) ? { x: 2 * x - prevCtrl.x, y: 2 * y - prevCtrl.y } : { x: x, y: y };
        p3 = { x: rel ? x + a[0] : a[0], y: rel ? y + a[1] : a[1] };
        p1 = { x: x + 2 / 3 * (q.x - x), y: y + 2 / 3 * (q.y - y) };
        p2 = { x: p3.x + 2 / 3 * (q.x - p3.x), y: p3.y + 2 / 3 * (q.y - p3.y) };
        cur.segs.push({ type: 'C', p0: { x: x, y: y }, p1: p1, p2: p2, p3: p3 });
        cur.anchors.push({ x: p3.x, y: p3.y });
        x = p3.x; y = p3.y; prevCtrl = q; prevKind = 'Q';
        continue;
      case 'Z':
        if (cur) {
          if (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9) {
            cur.segs.push({ type: 'L', a: { x: x, y: y }, b: { x: sx, y: sy } });
          }
          cur.closed = true;
          flush();
        }
        x = sx; y = sy; prevKind = ''; cmd = '';
        continue;
      default:
        break outer;
      }
    }
    flush();
    return subs;
  }

  /* ==========================================================================
     2. flatten(subpath, tol) — 弧長パラメータ付き点列にする。
        戻り値: {pts:[{x,y,s}], length, anchorS:[s,...], closed}。
        anchorS は subpath.anchors と同じ長さ（各アンカーに対応する弧長）。
        ベジェは固定分割（既定24）。tol は将来の適応分割用に受け取るだけ（現状未使用）。
     ========================================================================== */
  function segStart(seg) { return seg.type === 'L' ? seg.a : seg.p0; }
  function cubicPoint(seg, t) {
    var mt = 1 - t;
    var mt2 = mt * mt, t2 = t * t;
    var a = mt2 * mt, b = 3 * mt2 * t, c = 3 * mt * t2, dd = t2 * t;
    return {
      x: a * seg.p0.x + b * seg.p1.x + c * seg.p2.x + dd * seg.p3.x,
      y: a * seg.p0.y + b * seg.p1.y + c * seg.p2.y + dd * seg.p3.y
    };
  }
  var FLATTEN_N = 24; // 1本のベジェあたりの固定分割数

  function flatten(subpath, tol) {
    if (!subpath || !subpath.segs || !subpath.segs.length) {
      var a0 = (subpath && subpath.anchors && subpath.anchors.length) ? subpath.anchors[0] : { x: 0, y: 0 };
      var anchorsN = subpath && subpath.anchors ? subpath.anchors.length : 0;
      var zeros = []; for (var z = 0; z < anchorsN; z++) zeros.push(0);
      return { pts: [{ x: a0.x, y: a0.y, s: 0 }], length: 0, anchorS: zeros, closed: !!(subpath && subpath.closed) };
    }
    var segs = subpath.segs;
    var pts = [];
    var s = 0;
    var first = segStart(segs[0]);
    pts.push({ x: first.x, y: first.y, s: 0 });
    function pushLinear(p) {
      var last = pts[pts.length - 1];
      var dx = p.x - last.x, dy = p.y - last.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-9) return;
      s += dist;
      pts.push({ x: p.x, y: p.y, s: s });
    }
    var anchorS = [0];
    var anchorTarget = (subpath.anchors ? subpath.anchors.length : segs.length + 1) - 1;
    segs.forEach(function (seg, idx) {
      if (seg.type === 'L') {
        pushLinear(seg.b);
      } else {
        for (var k = 1; k <= FLATTEN_N; k++) pushLinear(cubicPoint(seg, k / FLATTEN_N));
      }
      if (idx < anchorTarget) anchorS.push(s);
    });
    /* 段6-A-3: 始点と終点の距離が全長の1%未満なら閉じたとみなす（既定ガイドが
       ほぼ閉じているのに開いた扱いになっていた隙間対策。closedフラグだけを立てる・
       点列そのものは変えない）。 */
    var closedOut = !!subpath.closed;
    if (!closedOut && pts.length > 1 && s > 1e-9) {
      var pf = pts[0], pl = pts[pts.length - 1];
      var gap = Math.hypot(pl.x - pf.x, pl.y - pf.y);
      if (gap < s * 0.01) closedOut = true;
    }
    return { pts: pts, length: s, anchorS: anchorS, closed: closedOut };
  }

  /* ==========================================================================
     3. sampleAt(flat, s) — 弧長 s の位置・単位接線・符号付き曲率。
     ========================================================================== */
  function curvatureAtIndex(pts, idx) {
    var n = pts.length;
    var i0 = Math.max(0, idx - 1), i2 = Math.min(n - 1, idx + 1);
    var A = pts[i0], B = pts[idx], C = pts[i2];
    var v1x = B.x - A.x, v1y = B.y - A.y, v2x = C.x - B.x, v2y = C.y - B.y;
    var l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y), l3 = Math.hypot(C.x - A.x, C.y - A.y);
    if (l1 < 1e-12 || l2 < 1e-12 || l3 < 1e-12) return 0;
    var cross = v1x * v2y - v1y * v2x;
    return 2 * cross / (l1 * l2 * l3);
  }

  function sampleAt(flat, s) {
    var pts = flat.pts;
    var n = pts.length;
    if (n === 0) return { x: 0, y: 0, tx: 1, ty: 0, kappa: 0 };
    if (n === 1) return { x: pts[0].x, y: pts[0].y, tx: 1, ty: 0, kappa: 0 };
    var L = flat.length;
    var ss = Math.max(0, Math.min(L, s));
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].s <= ss) lo = mid; else hi = mid;
    }
    var A = pts[lo], B = pts[hi];
    var segLen = B.s - A.s;
    var u = segLen > 1e-12 ? (ss - A.s) / segLen : 0;
    var x = A.x + (B.x - A.x) * u;
    var y = A.y + (B.y - A.y) * u;
    var dx = B.x - A.x, dy = B.y - A.y;
    var dlen = Math.sqrt(dx * dx + dy * dy);
    var tx = dlen > 1e-12 ? dx / dlen : 1;
    var ty = dlen > 1e-12 ? dy / dlen : 0;
    return { x: x, y: y, tx: tx, ty: ty, kappa: curvatureAtIndex(pts, lo) };
  }

  /* ==========================================================================
     4. depthProfile(kind, n, opts) — z(t) の配列。
        なし: 全部0／波{cycles,phase,amp}／だんだん{from,to}／交互{amp}（要素ごとに符号反転）。
     ========================================================================== */
  function depthProfile(kind, n, opts) {
    opts = opts || {};
    var len = Math.max(0, n | 0);
    var out = new Array(len);
    for (var i = 0; i < len; i++) {
      var u = len > 1 ? i / (len - 1) : 0;
      var v = 0;
      if (kind === 'wave') {
        var cycles = opts.cycles != null ? opts.cycles : 1;
        var phase = opts.phase != null ? opts.phase : 0;
        var amp = opts.amp != null ? opts.amp : 0;
        v = amp * Math.sin(2 * Math.PI * cycles * u + phase * Math.PI / 180);
      } else if (kind === 'ramp') {
        var from = opts.from != null ? opts.from : 0;
        var to = opts.to != null ? opts.to : 0;
        v = from + (to - from) * u;
      } else if (kind === 'alt') {
        var amp2 = opts.amp != null ? opts.amp : 0;
        v = (i % 2 === 0) ? amp2 : -amp2;
      } else {
        v = 0;
      }
      out[i] = v;
    }
    return out;
  }

  /* ==========================================================================
     5. rotateProject(pts3D, ax, ay) — 線幅の抑揚/depth.js と同じ式をここに複製。
        pts3D: [[x,y,z], …] → [{x,y,z}, …]。
     ========================================================================== */
  function rotateProject(pts3D, ax, ay) {
    var rax = (ax || 0) * Math.PI / 180, ray = (ay || 0) * Math.PI / 180;
    var ca = Math.cos(rax), sa = Math.sin(rax);
    var cb = Math.cos(ray), sb = Math.sin(ray);
    return pts3D.map(function (p) {
      var x = p[0], y = p[1], z = p[2];
      var y1 = y * ca - z * sa;
      var z1 = y * sa + z * ca;
      var x1 = x;
      var x2 = x1 * cb + z1 * sb;
      var z2 = -x1 * sb + z1 * cb;
      var y2 = y1;
      return { x: x2, y: y2, z: z2 };
    });
  }

  /* ==========================================================================
     6. place(flat, mode, opts) → [{x,y,z,angle,scale,s}]
        mode: anchors / count / distance / curvature / depth
     ========================================================================== */
  function invertCumulative(pts, cum, target) {
    var n = pts.length;
    if (target <= cum[0]) return pts[0].s;
    if (target >= cum[n - 1]) return pts[n - 1].s;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    var c0 = cum[lo], c1 = cum[hi];
    var u = (c1 - c0) > 1e-12 ? (target - c0) / (c1 - c0) : 0;
    return pts[lo].s + (pts[hi].s - pts[lo].s) * u;
  }

  function place(flat, mode, opts) {
    opts = opts || {};
    var placements;

    if (mode === 'anchors') {
      var anchorS = opts.anchorS || flat.anchorS || [];
      placements = anchorS.map(function (s) {
        var smp = sampleAt(flat, s);
        return { x: smp.x, y: smp.y, z: 0, angle: Math.atan2(smp.ty, smp.tx), scale: 1, s: s };
      });
      return placements;
    }

    if (mode === 'count') {
      var count = Math.max(1, Math.round(opts.count || 1));
      placements = [];
      var denom = flat.closed ? count : Math.max(1, count - 1);
      for (var i = 0; i < count; i++) {
        var s = (count === 1) ? 0 : (i / denom) * flat.length;
        var smp = sampleAt(flat, s);
        placements.push({ x: smp.x, y: smp.y, z: 0, angle: Math.atan2(smp.ty, smp.tx), scale: 1, s: s });
      }
      return placements;
    }

    if (mode === 'distance') {
      var dist = Math.max(1e-6, opts.distance || 1);
      placements = [];
      if (flat.closed) {
        var count2 = Math.max(1, Math.round(flat.length / dist));
        for (var j = 0; j < count2; j++) {
          var s2 = (j / count2) * flat.length;
          var smp2 = sampleAt(flat, s2);
          placements.push({ x: smp2.x, y: smp2.y, z: 0, angle: Math.atan2(smp2.ty, smp2.tx), scale: 1, s: s2 });
        }
      } else {
        for (var s3 = 0; s3 <= flat.length + 1e-9; s3 += dist) {
          var ss3 = Math.min(s3, flat.length);
          var smp3 = sampleAt(flat, ss3);
          placements.push({ x: smp3.x, y: smp3.y, z: 0, angle: Math.atan2(smp3.ty, smp3.tx), scale: 1, s: ss3 });
        }
      }
      return placements;
    }

    if (mode === 'curvature') {
      var countC = Math.max(1, Math.round(opts.count || 1));
      var k = opts.k != null ? opts.k : 1;
      var pts = flat.pts, n = pts.length;
      /* 段6-B-11: κをガイド内の中央値で割ってから 1+k·κ にする（既定で差が見える）。
         中央値がほぼ0（直線に近いガイド）の時は0除算を避け、従来どおりの生κを使う。 */
      var kappasAbs = new Array(n);
      for (var ki = 0; ki < n; ki++) kappasAbs[ki] = Math.abs(curvatureAtIndex(pts, ki));
      var sortedKappas = kappasAbs.slice().sort(function (a, b) { return a - b; });
      var midIdx = Math.floor(n / 2);
      var median = n % 2 ? sortedKappas[midIdx] : (sortedKappas[Math.max(0, midIdx - 1)] + sortedKappas[midIdx]) / 2;
      var dens = new Array(n);
      if (median > 1e-9) {
        for (var di = 0; di < n; di++) dens[di] = 1 + k * (kappasAbs[di] / median);
      } else {
        for (var di2 = 0; di2 < n; di2++) dens[di2] = 1 + k * kappasAbs[di2];
      }
      var cum = new Array(n); cum[0] = 0;
      for (var ci = 1; ci < n; ci++) {
        var ds = pts[ci].s - pts[ci - 1].s;
        cum[ci] = cum[ci - 1] + (dens[ci] + dens[ci - 1]) / 2 * ds;
      }
      var total = cum[n - 1];
      placements = [];
      var denomC = flat.closed ? countC : Math.max(1, countC - 1);
      for (var kk = 0; kk < countC; kk++) {
        var target = (countC === 1) ? 0 : (kk / denomC) * total;
        var sK = invertCumulative(pts, cum, target);
        var smpK = sampleAt(flat, sK);
        placements.push({ x: smpK.x, y: smpK.y, z: 0, angle: Math.atan2(smpK.ty, smpK.tx), scale: 1, s: sK });
      }
      return placements;
    }

    if (mode === 'depth') {
      var countD = Math.max(1, Math.round(opts.count || 1));
      var kind = opts.depthKind || 'none';
      var zOpts = opts.depthOpts || {};
      var ax = opts.ax || 0, ay = opts.ay || 0;
      var base = place(flat, 'count', { count: countD });
      var zArr = depthProfile(kind, countD, zOpts);
      var m = base.length;
      var closed = !!flat.closed;
      var segN = closed ? m : m - 1;
      if (segN < 1) {
        var proj0 = rotateProject([[base[0].x, base[0].y, zArr[0]]], ax, ay)[0];
        return [{ x: proj0.x, y: proj0.y, z: proj0.z, angle: 0, scale: 1, s: base[0].s }];
      }
      var d3 = new Array(segN);
      for (var si = 0; si < segN; si++) {
        var i0 = si, i1 = (si + 1) % m;
        var ds2 = (i1 === 0) ? (flat.length - base[i0].s + base[0].s) : (base[i1].s - base[i0].s);
        var dz = zArr[i1] - zArr[i0];
        d3[si] = Math.sqrt(ds2 * ds2 + dz * dz);
      }
      var cum3 = new Array(segN + 1); cum3[0] = 0;
      for (var si2 = 0; si2 < segN; si2++) cum3[si2 + 1] = cum3[si2] + d3[si2];
      var total3 = cum3[segN];
      placements = [];
      var denomD = closed ? countD : Math.max(1, countD - 1);
      for (var kd = 0; kd < countD; kd++) {
        var targetD = (countD === 1) ? 0 : (kd / denomD) * total3;
        var lo = 0, hi = segN;
        var l = 0, h = segN;
        while (h - l > 1) { var mid2 = (l + h) >> 1; if (cum3[mid2] <= targetD) l = mid2; else h = mid2; }
        var i0b = l, i1b = (l + 1) % m;
        var segLen3 = cum3[l + 1] - cum3[l];
        var u3 = segLen3 > 1e-12 ? (targetD - cum3[l]) / segLen3 : 0;
        var x3 = base[i0b].x + (base[i1b].x - base[i0b].x) * u3;
        var y3 = base[i0b].y + (base[i1b].y - base[i0b].y) * u3;
        var z3 = zArr[i0b] + (zArr[i1b] - zArr[i0b]) * u3;
        var dx3 = base[i1b].x - base[i0b].x, dy3 = base[i1b].y - base[i0b].y, dz3 = zArr[i1b] - zArr[i0b];
        var dl3 = Math.sqrt(dx3 * dx3 + dy3 * dy3 + dz3 * dz3);
        var tx3 = dl3 > 1e-12 ? dx3 / dl3 : 1, ty3 = dl3 > 1e-12 ? dy3 / dl3 : 0, tz3 = dl3 > 1e-12 ? dz3 / dl3 : 0;
        var proj = rotateProject([[x3, y3, z3]], ax, ay)[0];
        var tanProj = rotateProject([[tx3, ty3, tz3]], ax, ay)[0];
        var angle = Math.atan2(tanProj.y, tanProj.x);
        var sSpan = (i1b === 0) ? (flat.length - base[i0b].s) : (base[i1b].s - base[i0b].s);
        placements.push({ x: proj.x, y: proj.y, z: proj.z, angle: angle, scale: 1, s: base[i0b].s + sSpan * u3 });
      }
      return placements;
    }

    return [];
  }

  /* ==========================================================================
     7. sizeRule(placements, kind, opts) → scale を書き込んで返す。
        kind: constant / depth / curvature / ramp
     ========================================================================== */
  function sizeRule(placements, kind, opts) {
    opts = opts || {};
    var gain = opts.gain != null ? opts.gain : 1;
    if (kind === 'depth') {
      var zs = placements.map(function (p) { return Math.abs(p.z || 0); });
      var zMax = Math.max.apply(null, zs.concat([1e-9]));
      placements.forEach(function (p) { p.scale = Math.max(0, 1 + (p.z || 0) / zMax * gain); });
    } else if (kind === 'curvature') {
      var flat = opts.flat;
      placements.forEach(function (p) {
        var kap = 0;
        if (flat && flat.length > 1e-9) {
          var ss = ((p.s % flat.length) + flat.length) % flat.length;
          kap = sampleAt(flat, ss).kappa;
        }
        p.scale = Math.max(0, 1 + Math.abs(kap) * gain);
      });
    } else if (kind === 'ramp') {
      var n = placements.length;
      placements.forEach(function (p, i) {
        var u = n > 1 ? i / (n - 1) : 0;
        p.scale = 1 + u * gain;
      });
    } else if (kind === 'taperEnds' || kind === 'taperCenter') {
      /* 段6-B-7: 両端をすぼめる／中央をすぼめる。配置の並び順(index)を0..1へ正規化し、
         中央(u=0.5)で1・両端(u=0/1)で0になる山形 tentShape を作る。
         taperEnds: s2=両端で1・中央で0 → scale=1+gain*s2（中央は常に1・両端はgainで動く）。
         taperCenter: s2=中央で1・両端で0 → scale=1+gain*s2（両端は常に1・中央はgainで動く）。
         gainは-1〜1想定（UI「変化の幅」-100〜100%を/100してここへ渡す）。他の変化モード
         （奥行き/曲率/位置）と同じ「負で小さく・正で大きく」の符号に統一する
         （DoD: 変化の幅-100%でtaperEndsの両端scale≈0）。 */
      var n2 = placements.length;
      placements.forEach(function (p, i) {
        var u = n2 > 1 ? i / (n2 - 1) : 0;
        var tent = 1 - Math.abs(2 * u - 1);
        var s2 = (kind === 'taperEnds') ? (1 - tent) : tent;
        p.scale = Math.max(0, 1 + gain * s2);
      });
    } else {
      placements.forEach(function (p) { p.scale = 1; });
    }
    return placements;
  }

  /* ==========================================================================
     8. bakeObject(objPaths, placement) — 配置1件ぶんのpath d文字列。
        objPaths: parsePathと同じ形の配列（複数サブパス可）。
        アフィン: 拡大(scale)→回転(angle)→平行移動(x,y) の順に制御点へ適用。
        点変換そのものは placementTf() に切り出し、bakeFlatten（10番）とも共有する。
     ========================================================================== */
  function fmt(v) { return (Math.round(v * 100) / 100).toFixed(2); }

  function placementTf(placement) {
    var angle = placement.angle || 0;
    var cosA = Math.cos(angle), sinA = Math.sin(angle);
    var sc = placement.scale != null ? placement.scale : 1;
    /* 段6-B-10: 交互に裏返す。placement.mirror=true のとき、回転前にローカルyの符号を
       反転する（局所座標はx=接線方向・y=法線方向なので、法線方向への鏡映になる）。 */
    var my = placement.mirror ? -1 : 1;
    return function (pt) {
      var x = pt.x * sc, y = pt.y * sc * my;
      var rx = x * cosA - y * sinA;
      var ry = x * sinA + y * cosA;
      return { x: rx + placement.x, y: ry + placement.y };
    };
  }

  function bakeObject(objPaths, placement) {
    var tf = placementTf(placement);
    var d = '';
    (objPaths || []).forEach(function (sub) {
      if (!sub.segs || !sub.segs.length) return;
      var start = tf(segStart(sub.segs[0]));
      d += 'M' + fmt(start.x) + ' ' + fmt(start.y);
      sub.segs.forEach(function (seg) {
        if (seg.type === 'L') {
          var b = tf(seg.b);
          d += 'L' + fmt(b.x) + ' ' + fmt(b.y);
        } else {
          var p1 = tf(seg.p1), p2 = tf(seg.p2), p3 = tf(seg.p3);
          d += 'C' + fmt(p1.x) + ' ' + fmt(p1.y) + ' ' + fmt(p2.x) + ' ' + fmt(p2.y) + ' ' + fmt(p3.x) + ' ' + fmt(p3.y);
        }
      });
      if (sub.closed) d += 'Z';
    });
    return d;
  }

  /* ==========================================================================
     8b. bakeFlatten(objPaths, placement, tol) — 配置1件ぶんを、動きの書き出しへ渡す
         頂点列（直線分割ずみ）にする。1配置の全サブパスの点を1本の配列へ連結する
         （段2・動きの書き出しへのJSON出力・units[].pts 用）。
     ========================================================================== */
  function bakeFlatten(objPaths, placement, tol) {
    var tf = placementTf(placement);
    var out = [];
    (objPaths || []).forEach(function (sub) {
      if (!sub.segs || !sub.segs.length) return;
      var tSub = {
        closed: !!sub.closed,
        anchors: (sub.anchors || []).map(tf),
        segs: sub.segs.map(function (seg) {
          if (seg.type === 'L') return { type: 'L', a: tf(seg.a), b: tf(seg.b) };
          return { type: 'C', p0: tf(seg.p0), p1: tf(seg.p1), p2: tf(seg.p2), p3: tf(seg.p3) };
        })
      };
      var flat = flatten(tSub, tol);
      flat.pts.forEach(function (p) { out.push([p.x, p.y]); });
    });
    return out;
  }

  /* ==========================================================================
     9. buildSVG(placements, objPaths, viewBox, style) — 1配置=1<path>。z昇順で描く。
     ========================================================================== */
  function buildSVG(placements, objPaths, viewBox, style) {
    style = style || {};
    var vb = viewBox || { x: -100, y: -100, w: 200, h: 200 };
    var ordered = placements.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
    var fill = style.fill != null ? style.fill : '#2b2b2b';
    var stroke = style.stroke;
    var body = ordered.map(function (p) {
      var d = bakeObject(objPaths, p);
      var attrs = 'fill="' + (fill === 'none' ? 'none' : fill) + '"';
      if (stroke && stroke !== 'none') attrs += ' stroke="' + stroke + '" stroke-width="' + (style.strokeWidth || 1) + '"';
      return '<path d="' + d + '" ' + attrs + '/>';
    }).join('\n');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h +
      '" width="' + vb.w + '" height="' + vb.h + '">\n' + body + '\n</svg>';
  }

  /* ==========================================================================
     10. builtinShape(kind, opts) — 内蔵の「並べるもの」（円・線分・矢印）。
         parsePathと同じ形（サブパス配列）を返す＝bakeObjectへそのまま渡せる。
     ========================================================================== */
  function builtinShape(kind, opts) {
    opts = opts || {};
    if (kind === 'circle') {
      var r = (opts.diameter != null ? opts.diameter : 10) / 2;
      var kk = 0.5522847498307936;
      var segs = [
        { type: 'C', p0: { x: r, y: 0 }, p1: { x: r, y: r * kk }, p2: { x: r * kk, y: r }, p3: { x: 0, y: r } },
        { type: 'C', p0: { x: 0, y: r }, p1: { x: -r * kk, y: r }, p2: { x: -r, y: r * kk }, p3: { x: -r, y: 0 } },
        { type: 'C', p0: { x: -r, y: 0 }, p1: { x: -r, y: -r * kk }, p2: { x: -r * kk, y: -r }, p3: { x: 0, y: -r } },
        { type: 'C', p0: { x: 0, y: -r }, p1: { x: r * kk, y: -r }, p2: { x: r, y: -r * kk }, p3: { x: r, y: 0 } }
      ];
      return [{ closed: true, anchors: [{ x: r, y: 0 }, { x: 0, y: r }, { x: -r, y: 0 }, { x: 0, y: -r }], segs: segs }];
    }
    if (kind === 'segment') {
      var len = opts.length != null ? opts.length : 10;
      return [{ closed: false, anchors: [{ x: -len / 2, y: 0 }, { x: len / 2, y: 0 }], segs: [{ type: 'L', a: { x: -len / 2, y: 0 }, b: { x: len / 2, y: 0 } }] }];
    }
    if (kind === 'arrow') {
      var len2 = opts.length != null ? opts.length : 10;
      var head = len2 * 0.3;
      var tip = { x: len2 / 2, y: 0 };
      var segsA = [
        { type: 'L', a: { x: -len2 / 2, y: 0 }, b: tip },
        { type: 'L', a: tip, b: { x: len2 / 2 - head, y: -head * 0.6 } },
        { type: 'L', a: tip, b: { x: len2 / 2 - head, y: head * 0.6 } }
      ];
      return [{ closed: false, anchors: [{ x: -len2 / 2, y: 0 }, tip, { x: len2 / 2 - head, y: -head * 0.6 }, tip, { x: len2 / 2 - head, y: head * 0.6 }], segs: segsA }];
    }
    return [{ closed: false, anchors: [], segs: [] }];
  }

  /* ==========================================================================
     11. parseObjectSVG(svgText, opts) — 段2「並べるものの読み取り拡張」。
         rect(rx/ry)/circle/ellipse/line/polyline/polygon/path を、全部
         path表現（M/L/C/Z・parsePathと同じsegs形）に変換して読む。
         transform（translate/scale/rotate/matrix・入れ子g可）は制御点に焼く。
         読んだ後、全要素のbboxの中心を原点へ、長辺がopts.size(px)になるよう正規化する。
         戻り値: {paths:[{d,fill,stroke,strokeWidth}], bbox:{minX,minY,maxX,maxY}}。
         読める要素がゼロならnull（呼び出し側でトースト表示する）。
     ========================================================================== */
  var IDENTITY_M = [1, 0, 0, 1, 0, 0];
  function matMul(m1, m2) { // m1∘m2（m2を先に適用してからm1）
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }
  function applyMatrix(m, pt) { return { x: m[0] * pt.x + m[2] * pt.y + m[4], y: m[1] * pt.x + m[3] * pt.y + m[5] }; }

  function parseTransformAttr(s) {
    var m = IDENTITY_M;
    if (!s) return m;
    var re = /([a-zA-Z]+)\s*\(([^)]*)\)/g, mm;
    while ((mm = re.exec(s))) {
      var name = mm[1];
      var args = mm[2].split(/[\s,]+/).filter(function (v) { return v !== ''; }).map(parseFloat);
      var fm = IDENTITY_M;
      if (name === 'translate') fm = [1, 0, 0, 1, args[0] || 0, args.length > 1 ? args[1] : 0];
      else if (name === 'scale') { var sx = args[0] != null ? args[0] : 1, sy = args.length > 1 ? args[1] : sx; fm = [sx, 0, 0, sy, 0, 0]; }
      else if (name === 'rotate') {
        var deg = args[0] || 0, rad = deg * Math.PI / 180, c = Math.cos(rad), s2 = Math.sin(rad);
        var rm = [c, s2, -s2, c, 0, 0];
        if (args.length >= 3) {
          var cx = args[1], cy = args[2];
          fm = matMul(matMul([1, 0, 0, 1, cx, cy], rm), [1, 0, 0, 1, -cx, -cy]);
        } else fm = rm;
      } else if (name === 'matrix' && args.length >= 6) fm = args.slice(0, 6);
      m = matMul(m, fm);
    }
    return m;
  }

  function parseAttrs(attrStr) {
    var attrs = {};
    var re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g, mm;
    while ((mm = re.exec(attrStr || ''))) attrs[mm[1]] = mm[3] != null ? mm[3] : mm[4];
    return attrs;
  }

  function parseStyleAttr(s) {
    var obj = {};
    if (!s) return obj;
    s.split(';').forEach(function (decl) {
      var idx = decl.indexOf(':');
      if (idx < 0) return;
      var prop = decl.slice(0, idx).trim(), val = decl.slice(idx + 1).trim();
      if (prop === 'fill' || prop === 'stroke' || prop === 'stroke-width') obj[prop] = val;
    });
    return obj;
  }

  function parseStyleBlock(svgText) {
    var map = {};
    var re = /<style[^>]*>([\s\S]*?)<\/style>/gi, mm;
    while ((mm = re.exec(svgText))) {
      var ruleRe = /\.([\w-]+)\s*\{([^}]*)\}/g, rm;
      while ((rm = ruleRe.exec(mm[1]))) {
        var cls = rm[1], obj = map[cls] || {};
        var declRe = /([\w-]+)\s*:\s*([^;]+)\s*;?/g, dm;
        while ((dm = declRe.exec(rm[2]))) {
          var prop = dm[1].trim(), val = dm[2].trim();
          if (prop === 'fill' || prop === 'stroke' || prop === 'stroke-width') obj[prop] = val;
        }
        map[cls] = obj;
      }
    }
    return map;
  }

  function resolveOwnPaint(attrs, classMap) {
    var styleObj = parseStyleAttr(attrs.style);
    var cls = attrs['class'];
    var classObj = (cls && classMap[cls]) ? classMap[cls] : {};
    function pick(name) {
      if (attrs[name] != null) return attrs[name];
      if (styleObj[name] != null) return styleObj[name];
      if (classObj[name] != null) return classObj[name];
      return undefined;
    }
    return { fill: pick('fill'), stroke: pick('stroke'), strokeWidth: pick('stroke-width') };
  }

  function numAttr(attrs, name, def) {
    var v = attrs[name];
    if (v == null || v === '') return def;
    var n = parseFloat(v);
    return isFinite(n) ? n : def;
  }

  function rectSubpath(attrs) {
    var x = numAttr(attrs, 'x', 0), y = numAttr(attrs, 'y', 0);
    var w = numAttr(attrs, 'width', 0), h = numAttr(attrs, 'height', 0);
    if (w <= 0 || h <= 0) return null;
    var rx = attrs.rx != null ? parseFloat(attrs.rx) : (attrs.ry != null ? parseFloat(attrs.ry) : 0);
    var ry = attrs.ry != null ? parseFloat(attrs.ry) : (attrs.rx != null ? parseFloat(attrs.rx) : 0);
    rx = Math.max(0, Math.min(rx || 0, w / 2));
    ry = Math.max(0, Math.min(ry || 0, h / 2));
    function pt(px, py) { return { x: px, y: py }; }
    if (rx <= 1e-9 && ry <= 1e-9) {
      var p0 = pt(x, y), p1 = pt(x + w, y), p2 = pt(x + w, y + h), p3 = pt(x, y + h);
      return [{ closed: true, anchors: [p0, p1, p2, p3], segs: [
        { type: 'L', a: p0, b: p1 }, { type: 'L', a: p1, b: p2 }, { type: 'L', a: p2, b: p3 }
      ] }];
    }
    var K = 0.5522847498307936, kx = rx * K, ky = ry * K;
    var A = pt(x + rx, y), B = pt(x + w - rx, y), C1 = pt(x + w, y + ry);
    var D = pt(x + w, y + h - ry), E = pt(x + w - rx, y + h), F = pt(x + rx, y + h);
    var G = pt(x, y + h - ry), H = pt(x, y + ry);
    var segs = [
      { type: 'L', a: A, b: B },
      { type: 'C', p0: B, p1: pt(B.x + kx, B.y), p2: pt(C1.x, C1.y - ky), p3: C1 },
      { type: 'L', a: C1, b: D },
      { type: 'C', p0: D, p1: pt(D.x, D.y + ky), p2: pt(E.x + kx, E.y), p3: E },
      { type: 'L', a: E, b: F },
      { type: 'C', p0: F, p1: pt(F.x - kx, F.y), p2: pt(G.x, G.y + ky), p3: G },
      { type: 'L', a: G, b: H },
      { type: 'C', p0: H, p1: pt(H.x, H.y - ky), p2: pt(A.x - kx, A.y), p3: A }
    ];
    return [{ closed: true, anchors: [A, B, C1, D, E, F, G, H], segs: segs }];
  }

  function ellipseSegs(cx, cy, rx, ry) {
    var K = 0.5522847498307936, kx = rx * K, ky = ry * K;
    var E = { x: cx + rx, y: cy }, S = { x: cx, y: cy + ry }, W = { x: cx - rx, y: cy }, N = { x: cx, y: cy - ry };
    var segs = [
      { type: 'C', p0: E, p1: { x: cx + rx, y: cy + ky }, p2: { x: cx + kx, y: cy + ry }, p3: S },
      { type: 'C', p0: S, p1: { x: cx - kx, y: cy + ry }, p2: { x: cx - rx, y: cy + ky }, p3: W },
      { type: 'C', p0: W, p1: { x: cx - rx, y: cy - ky }, p2: { x: cx - kx, y: cy - ry }, p3: N },
      { type: 'C', p0: N, p1: { x: cx + kx, y: cy - ry }, p2: { x: cx + rx, y: cy - ky }, p3: E }
    ];
    return [{ closed: true, anchors: [E, S, W, N], segs: segs }];
  }
  function circleSubpath(attrs) {
    var r = numAttr(attrs, 'r', 0);
    if (r <= 0) return null;
    return ellipseSegs(numAttr(attrs, 'cx', 0), numAttr(attrs, 'cy', 0), r, r);
  }
  function ellipseSubpath(attrs) {
    var rx = numAttr(attrs, 'rx', 0), ry = numAttr(attrs, 'ry', 0);
    if (rx <= 0 || ry <= 0) return null;
    return ellipseSegs(numAttr(attrs, 'cx', 0), numAttr(attrs, 'cy', 0), rx, ry);
  }
  function lineSubpath(attrs) {
    var a = { x: numAttr(attrs, 'x1', 0), y: numAttr(attrs, 'y1', 0) };
    var b = { x: numAttr(attrs, 'x2', 0), y: numAttr(attrs, 'y2', 0) };
    return [{ closed: false, anchors: [a, b], segs: [{ type: 'L', a: a, b: b }] }];
  }
  function parsePoints(str) {
    var nums = (str || '').trim().split(/[\s,]+/).filter(function (v) { return v !== ''; }).map(parseFloat);
    var pts = [];
    for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    return pts;
  }
  function polySubpath(attrs, closed) {
    var pts = parsePoints(attrs.points);
    if (pts.length < 2) return null;
    var segs = [];
    for (var i = 0; i < pts.length - 1; i++) segs.push({ type: 'L', a: pts[i], b: pts[i + 1] });
    return [{ closed: !!closed, anchors: pts.slice(), segs: segs }];
  }

  function transformSubpath(sub, m) {
    function tf(p) { return applyMatrix(m, p); }
    return {
      closed: !!sub.closed,
      anchors: (sub.anchors || []).map(tf),
      segs: (sub.segs || []).map(function (seg) {
        if (seg.type === 'L') return { type: 'L', a: tf(seg.a), b: tf(seg.b) };
        return { type: 'C', p0: tf(seg.p0), p1: tf(seg.p1), p2: tf(seg.p2), p3: tf(seg.p3) };
      })
    };
  }

  function bboxOfAllSubs(subsList) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function consider(p) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    subsList.forEach(function (subs) {
      subs.forEach(function (sub) {
        (sub.anchors || []).forEach(consider);
        (sub.segs || []).forEach(function (seg) {
          if (seg.type === 'L') { consider(seg.a); consider(seg.b); }
          else { consider(seg.p0); consider(seg.p1); consider(seg.p2); consider(seg.p3); }
        });
      });
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function parseObjectSVG(svgText, opts) {
    opts = opts || {};
    var size = opts.size != null ? opts.size : 10;
    var text = String(svgText == null ? '' : svgText);
    var classMap = parseStyleBlock(text);

    var TAG_RE = /<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*(\/)?>|<\/([a-zA-Z][\w:-]*)\s*>/g;
    var stack = [];
    var curM = IDENTITY_M;
    var curPaint = { fill: undefined, stroke: undefined, strokeWidth: undefined };
    var results = []; // {subs, fill, stroke, strokeWidth}
    var mm;
    while ((mm = TAG_RE.exec(text))) {
      if (mm[1]) {
        var tag = mm[1].toLowerCase();
        var attrs = parseAttrs(mm[2] || '');
        var selfClose = !!mm[3];
        var elemM = matMul(curM, parseTransformAttr(attrs.transform));
        var own = resolveOwnPaint(attrs, classMap);
        var elemPaint = {
          fill: own.fill != null ? own.fill : curPaint.fill,
          stroke: own.stroke != null ? own.stroke : curPaint.stroke,
          strokeWidth: own.strokeWidth != null ? own.strokeWidth : curPaint.strokeWidth
        };
        var subs = null;
        if (tag === 'rect') subs = rectSubpath(attrs);
        else if (tag === 'circle') subs = circleSubpath(attrs);
        else if (tag === 'ellipse') subs = ellipseSubpath(attrs);
        else if (tag === 'line') subs = lineSubpath(attrs);
        else if (tag === 'polyline') subs = polySubpath(attrs, false);
        else if (tag === 'polygon') subs = polySubpath(attrs, true);
        else if (tag === 'path' && attrs.d) subs = parsePath(attrs.d);

        if (subs && subs.length) {
          var baked = subs.map(function (s) { return transformSubpath(s, elemM); });
          results.push({ subs: baked, fill: elemPaint.fill, stroke: elemPaint.stroke, strokeWidth: elemPaint.strokeWidth });
        }
        if (!selfClose) { stack.push({ m: curM, paint: curPaint }); curM = elemM; curPaint = elemPaint; }
      } else if (mm[4] && stack.length) {
        var top = stack.pop(); curM = top.m; curPaint = top.paint;
      }
    }
    if (!results.length) return null;
    /* raw: 正規化せず、transformを焼いたサブパスをそのまま返す（ガイドの取り込み用・指揮者追加 2026-09-25） */
    if (opts.raw) { var rawSubs = []; results.forEach(function (r) { rawSubs = rawSubs.concat(r.subs); }); return { subs: rawSubs }; }

    var bb0 = bboxOfAllSubs(results.map(function (r) { return r.subs; }));
    if (!isFinite(bb0.minX)) return null;
    var cx = (bb0.minX + bb0.maxX) / 2, cy = (bb0.minY + bb0.maxY) / 2;
    var w = bb0.maxX - bb0.minX, h = bb0.maxY - bb0.minY;
    var longSide = Math.max(w, h);
    var scale = longSide > 1e-9 ? size / longSide : 1;
    var normM = [scale, 0, 0, scale, -cx * scale, -cy * scale];

    var normedResults = results.map(function (r) {
      return { subs: r.subs.map(function (s) { return transformSubpath(s, normM); }), fill: r.fill, stroke: r.stroke, strokeWidth: r.strokeWidth };
    });
    var bb = bboxOfAllSubs(normedResults.map(function (r) { return r.subs; }));
    var paths = normedResults.map(function (r) {
      var d = bakeObject(r.subs, { x: 0, y: 0, angle: 0, scale: 1 });
      var fill = r.fill !== undefined ? r.fill : '#000000';
      var strokeWidth = r.strokeWidth != null ? parseFloat(r.strokeWidth) : (r.stroke ? 1 : undefined);
      return { d: d, fill: fill, stroke: r.stroke, strokeWidth: strokeWidth };
    });
    return { paths: paths, bbox: bb };
  }

  /* ==========================================================================
     12. applySweepOptions(placements, flat, opts) — 段2「沿わせ方の自由度」。
         place()の後段（DOM非依存）。使う範囲・開始のずらし・離す距離(+波)・傾き・
         進行で回す・列数・ばらつき を placements に適用して新しい配列を返す。
         元の並び（sの弧長比率 s/flat.length）を保ったまま範囲を再配分するので、
         既定値（範囲0〜100%・ずらし0）では位置は変化しない（恒等）。
     ========================================================================== */
  function makeRngLocal(seed) { // studio-kit.js の makeRng と同じ式（mulberry32）
    var a = (seed >>> 0) || 1;
    var r = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.range = function (lo, hi) { return lo + (hi - lo) * r(); };
    return r;
  }
  function getRng(seed) {
    var g = typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this);
    if (g && g.Studio && typeof g.Studio.rng === 'function') return g.Studio.rng(seed);
    return makeRngLocal(seed);
  }

  function applySweepOptions(placements, flat, opts) {
    opts = opts || {};
    var n = placements ? placements.length : 0;
    if (!n || !flat || !(flat.length > 1e-9)) return (placements || []).slice();
    var L = flat.length;
    var closed = !!flat.closed;

    var rangeStart = (opts.rangeStart != null ? opts.rangeStart : 0) / 100;
    var rangeEnd = (opts.rangeEnd != null ? opts.rangeEnd : 100) / 100;
    var startShift = (opts.startShift != null ? opts.startShift : 0) / 100;
    var rangeSpan = (closed && rangeEnd < rangeStart) ? ((rangeEnd + 1) - rangeStart) : (rangeEnd - rangeStart);

    var offsetDist = opts.offset != null ? opts.offset : 0;
    var offsetWaveAmp = opts.offsetWaveAmp != null ? opts.offsetWaveAmp : 0;
    var offsetWaveCycles = opts.offsetWaveCycles != null ? opts.offsetWaveCycles : 1;
    var tiltRad = (opts.tilt != null ? opts.tilt : 0) * Math.PI / 180;
    var spinTurns = opts.spinTurns != null ? opts.spinTurns : 0;
    var cols = Math.max(1, Math.round(opts.columns != null ? opts.columns : 1));
    var colGap = opts.columnGap != null ? opts.columnGap : 0;

    var out = [];
    for (var i = 0; i < n; i++) {
      var p = placements[i];
      var u = (p.s || 0) / L; // 元の弧長比率（0..1が既定の全区間）
      var frac = rangeStart + u * rangeSpan + startShift;
      if (closed) frac = ((frac % 1) + 1) % 1;
      else frac = Math.max(0, Math.min(1, frac));
      var sAdj = frac * L;
      var smp = sampleAt(flat, sAdj);
      var nx = smp.ty, ny = -smp.tx; // 外向き法線（CCW閉曲線で外側・sampleAtの接線を-90°回す）
      var offset = offsetDist + offsetWaveAmp * Math.sin(2 * Math.PI * offsetWaveCycles * u);
      var spinRad = spinTurns * 360 * (sAdj / L) * Math.PI / 180;
      var baseAngle = (p.angle || 0) + tiltRad + spinRad;
      for (var c = 0; c < cols; c++) {
        var colOffset = (c - (cols - 1) / 2) * colGap;
        var totalOffset = offset + colOffset;
        out.push({
          x: smp.x + nx * totalOffset, y: smp.y + ny * totalOffset,
          z: p.z || 0, angle: baseAngle,
          scale: p.scale != null ? p.scale : 1, s: sAdj
        });
      }
    }

    var jitter = opts.jitter;
    if (jitter && ((jitter.pos || 0) || (jitter.size || 0) || (jitter.angle || 0))) {
      var rng = getRng(jitter.seed != null ? jitter.seed : 1);
      var pos = jitter.pos || 0, sizePct = jitter.size || 0, angDeg = jitter.angle || 0;
      out.forEach(function (pl) {
        var dx = rng.range(-pos, pos), dy = rng.range(-pos, pos);
        var dSize = rng.range(-sizePct, sizePct) / 100;
        var dAng = rng.range(-angDeg, angDeg) * Math.PI / 180;
        pl.x += dx; pl.y += dy;
        pl.scale = Math.max(0, (pl.scale || 1) * (1 + dSize));
        pl.angle += dAng;
      });
    }
    return out;
  }

  /* ==========================================================================
     13. migrateParamsV1toV2(params) — 封筒paramsVersion 1→2の移行。
         段2で増えたキー（見た目・沿わせ方の自由度）へ既定値を埋めるだけ。
         既にあるキーは上書きしない（v1のガイド・並べるもの・置き方などはそのまま保持）。
     ========================================================================== */
  function migrateParamsV1toV2(params) {
    var p = {};
    for (var k in (params || {})) p[k] = params[k];
    var defaults = {
      objSize: 16,
      useObjectColor: true, fillColor: '#2b2b2b', strokeColor: 'none', strokeWidth: 1,
      startShift: 0, rangeStart: 0, rangeEnd: 100,
      offset: 0, offsetWaveAmp: 0, offsetWaveCycles: 1,
      tilt: 0, spinTurns: 0, columns: 1, columnGap: 20,
      jitterSeed: 1, jitterPos: 0, jitterSize: 0, jitterAngle: 0
    };
    for (var key in defaults) { if (p[key] === undefined) p[key] = defaults[key]; }
    return p;
  }

  /* ==========================================================================
     14. migrateParamsV2toV3(params) — 封筒paramsVersion 2→3の移行。
         段3で増えた useDepth（既定OFF）を、旧SVGの奥行き関連設定から推定して埋める。
         旧SVG（v2以前）で奥行き規則が「なし」以外、または置き方／大きさが「奥行き」系
         だった場合は useDepth=true とみなす（既にuseDepthがあれば上書きしない）。
     ========================================================================== */
  function migrateParamsV2toV3(params) {
    var p = {};
    for (var k in (params || {})) p[k] = params[k];
    if (p.useDepth === undefined) {
      p.useDepth = !!((p.depthKind && p.depthKind !== 'none') || p.placeMode === 'depth' || p.sizeMode === 'depth');
    }
    return p;
  }

  /* ==========================================================================
     15. 立体（段5・DOM非依存）。
         frameAt: ガイドの3D曲線(z付き)上の弧長sに3Dフレーム(P/T/N/B)を作る。
         placeOnFrame: 「並べるもの」の制御点をフレームに置く（寝かす/立てる/ねじる）。
         projectPoint: 3D点を回転→透視→2Dへ。
         bakeObject3D/bakeFlatten3D: 制御点を1点ずつ3D→2Dへ通して<path>d文字列／
         動きの書き出しの頂点列を組む（アフィンで一括変換できないため）。
         shadeColor: 陰影（奥を薄くする・面の明るさ）を色に適用する。
     ========================================================================== */

  /* depthAt(u, kind, opts) — depthProfile と同じ式を「弧長比率uの連続関数」にしたもの
     （frameAtの3D曲線づくり専用。alt は交互＝弧長を周期数で区切る矩形波として連続化
     しており、離散インデックスで交互にするdepthProfileのaltとは値が一致しない。
     既存のdepthProfile自体はテスト互換のため変更しない）。 */
  function depthAt(u, kind, opts) {
    opts = opts || {};
    if (kind === 'wave') {
      var cycles = opts.cycles != null ? opts.cycles : 1;
      var phase = opts.phase != null ? opts.phase : 0;
      var amp = opts.amp != null ? opts.amp : 0;
      return amp * Math.sin(2 * Math.PI * cycles * u + phase * Math.PI / 180);
    }
    if (kind === 'ramp') {
      var from = opts.from != null ? opts.from : 0;
      var to = opts.to != null ? opts.to : 0;
      return from + (to - from) * u;
    }
    if (kind === 'alt') {
      var cyclesA = opts.cycles != null ? opts.cycles : 1;
      var ampA = opts.amp != null ? opts.amp : 0;
      return Math.sin(2 * Math.PI * cyclesA * u) >= 0 ? ampA : -ampA;
    }
    return 0;
  }

  /* build3DFlat(flat, kind, opts) — 2Dのflatten結果に、各点のz=depthAt(その点のu)を
     足した3D版。pts[].sは3D弧長（x,y,zの実距離の累積）に作り直す。 */
  function build3DFlat(flat, kind, opts) {
    var L = flat.length;
    var pts2 = flat.pts;
    var n = pts2.length;
    if (!n) return { pts: [], length: 0, closed: !!flat.closed };
    var pts3 = new Array(n);
    for (var i = 0; i < n; i++) {
      var u = L > 1e-9 ? pts2[i].s / L : 0;
      pts3[i] = { x: pts2[i].x, y: pts2[i].y, z: depthAt(u, kind, opts) };
    }
    var out = [{ x: pts3[0].x, y: pts3[0].y, z: pts3[0].z, s: 0 }];
    var s3 = 0;
    for (var j = 1; j < n; j++) {
      var a = pts3[j - 1], b = pts3[j];
      var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      s3 += Math.sqrt(dx * dx + dy * dy + dz * dz);
      out.push({ x: b.x, y: b.y, z: b.z, s: s3 });
    }
    return { pts: out, length: s3, closed: !!flat.closed };
  }

  function vlen(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
  function vcross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function vnorm(v) { var l = vlen(v); return l > 1e-12 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 0 }; }

  /* fallbackN(T) — Tが画面法線(0,0,1)とほぼ平行で外積が退化するときの代わりの基準軸。 */
  function fallbackN(T) {
    var ref = Math.abs(T.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    return vnorm(vcross(T, ref));
  }

  /* frameAt(flat3D, s, prevN) — 弧長sの位置P・接線T・法線N(=正規化(T×画面法線))・
     従法線B(=T×N)。Tが画面法線(0,0,1)とほぼ平行なとき（外積が退化）は、prevNが
     あればそれをTに直交化して使う（急な回転を避ける・spec.md「前のNを引き継ぐ」の
     ステートレス版）。無ければfallbackNで作る。 */
  function frameAt(flat3D, s, prevN) {
    var pts = flat3D.pts, n = pts.length;
    if (!n) return { P: { x: 0, y: 0, z: 0 }, T: { x: 1, y: 0, z: 0 }, N: { x: 0, y: 1, z: 0 }, B: { x: 0, y: 0, z: 1 } };
    if (n === 1) return { P: { x: pts[0].x, y: pts[0].y, z: pts[0].z }, T: { x: 1, y: 0, z: 0 }, N: { x: 0, y: 1, z: 0 }, B: { x: 0, y: 0, z: 1 } };
    var L = flat3D.length;
    var ss = Math.max(0, Math.min(L, s));
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].s <= ss) lo = mid; else hi = mid;
    }
    var A = pts[lo], Bp = pts[hi];
    var segLen = Bp.s - A.s;
    var u = segLen > 1e-12 ? (ss - A.s) / segLen : 0;
    var P = { x: A.x + (Bp.x - A.x) * u, y: A.y + (Bp.y - A.y) * u, z: A.z + (Bp.z - A.z) * u };
    var dx = Bp.x - A.x, dy = Bp.y - A.y, dz = Bp.z - A.z;
    var dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var T = dl > 1e-12 ? { x: dx / dl, y: dy / dl, z: dz / dl } : { x: 1, y: 0, z: 0 };
    var screenNormal = { x: 0, y: 0, z: 1 };
    var cross = vcross(T, screenNormal);
    var clen = vlen(cross);
    var N;
    if (clen < 1e-6) {
      if (prevN) {
        var dot = prevN.x * T.x + prevN.y * T.y + prevN.z * T.z;
        var ortho = { x: prevN.x - dot * T.x, y: prevN.y - dot * T.y, z: prevN.z - dot * T.z };
        N = vlen(ortho) > 1e-9 ? vnorm(ortho) : fallbackN(T);
      } else {
        N = fallbackN(T);
      }
    } else {
      N = { x: cross.x / clen, y: cross.y / clen, z: cross.z / clen };
    }
    var B = vcross(T, N);
    return { P: P, T: T, N: N, B: B };
  }

  /* rotateFrameAroundT(frame, angleRad) — (N,B)をT回りにangleRadだけ回した新しい
     フレームを返す（Pは変えない）。置く面「立ててねじる」に使う。 */
  function rotateFrameAroundT(frame, angleRad) {
    var N = frame.N, B = frame.B;
    var ct = Math.cos(angleRad), st = Math.sin(angleRad);
    var N2 = { x: N.x * ct + B.x * st, y: N.y * ct + B.y * st, z: N.z * ct + B.z * st };
    var B2 = { x: -N.x * st + B.x * ct, y: -N.y * st + B.y * ct, z: -N.z * st + B.z * ct };
    return { P: frame.P, T: frame.T, N: N2, B: B2 };
  }

  /* placeOnFrame(objSubs, placement, plane, twist) — 並べるものの制御点(ローカル2D)を
     3Dへ置く。plane='lay'（寝かす＝今までのplacementTf。zはframe.P.zかplacement.z）／
     'stand'（立てる＝(N,B)平面に直接置く）／'twist'（立ててねじる＝(N,B)をT回りに
     twist[ラジアン・呼び出し側で2π×回数×s/Lを計算済み]だけ回してから置く）。
     placement.frame（{P,T,N,B}・frameAtの戻り値）が無いstand/twistは原点フレームを使う。 */
  function placeOnFrame(objSubs, placement, plane, twist) {
    var sc = placement.scale != null ? placement.scale : 1;
    var frame = placement.frame || { P: { x: placement.x || 0, y: placement.y || 0, z: placement.z || 0 }, T: { x: 1, y: 0, z: 0 }, N: { x: 0, y: 1, z: 0 }, B: { x: 0, y: 0, z: 1 } };
    var effFrame = (plane === 'twist') ? rotateFrameAroundT(frame, twist || 0) : frame;
    var tf2d = placementTf(placement);
    var myFrame = placement.mirror ? -1 : 1;
    function mapPt(pt) {
      if (plane === 'stand' || plane === 'twist') {
        var u = pt.x * sc, v = pt.y * sc * myFrame;
        var N = effFrame.N, B = effFrame.B, P = effFrame.P;
        return { x: P.x + u * N.x + v * B.x, y: P.y + u * N.y + v * B.y, z: P.z + u * N.z + v * B.z };
      }
      var p2 = tf2d(pt);
      return { x: p2.x, y: p2.y, z: frame.P.z };
    }
    return (objSubs || []).map(function (sub) {
      return {
        closed: !!sub.closed,
        anchors: (sub.anchors || []).map(mapPt),
        segs: (sub.segs || []).map(function (seg) {
          if (seg.type === 'L') return { type: 'L', a: mapPt(seg.a), b: mapPt(seg.b) };
          return { type: 'C', p0: mapPt(seg.p0), p1: mapPt(seg.p1), p2: mapPt(seg.p2), p3: mapPt(seg.p3) };
        })
      };
    });
  }

  /* projectPoint(p3, {ax, ay, persp, f}) — 回転(rotateProjectと同じ式)→透視→2D。
     perspは「透視の強さ」(0=正射影)。persp>0のときだけ x'=x·f/(f−z) を掛ける
     （f=呼び出し側が「透視の強さ」から決めたカメラ距離）。 */
  function projectPoint(p3, opts) {
    opts = opts || {};
    var rp = rotateProject([[p3.x, p3.y, p3.z]], opts.ax || 0, opts.ay || 0)[0];
    var persp = opts.persp || 0;
    if (persp > 0) {
      var f = opts.f != null ? opts.f : 1000;
      var denom = f - rp.z;
      var k = denom > 1e-6 ? f / denom : 1;
      return { x: rp.x * k, y: rp.y * k, z: rp.z };
    }
    return { x: rp.x, y: rp.y, z: rp.z };
  }

  /* bakeObject3D(objPaths, placement, opts) — 配置1件ぶんのpath d文字列（立体版）。
     opts: {plane, twist, proj:{ax,ay,persp,f}}。制御点を1点ずつplaceOnFrame→
     projectPointへ通す（8番bakeObjectの3D版・アフィンで一括変換できないため）。 */
  function bakeObject3D(objPaths, placement, opts) {
    opts = opts || {};
    var proj = opts.proj || {};
    var subs3 = placeOnFrame(objPaths, placement, opts.plane || 'lay', opts.twist || 0);
    var d = '';
    subs3.forEach(function (sub) {
      if (!sub.segs || !sub.segs.length) return;
      var start = projectPoint(segStart(sub.segs[0]), proj);
      d += 'M' + fmt(start.x) + ' ' + fmt(start.y);
      sub.segs.forEach(function (seg) {
        if (seg.type === 'L') {
          var b = projectPoint(seg.b, proj);
          d += 'L' + fmt(b.x) + ' ' + fmt(b.y);
        } else {
          var p1 = projectPoint(seg.p1, proj), p2 = projectPoint(seg.p2, proj), p3 = projectPoint(seg.p3, proj);
          d += 'C' + fmt(p1.x) + ' ' + fmt(p1.y) + ' ' + fmt(p2.x) + ' ' + fmt(p2.y) + ' ' + fmt(p3.x) + ' ' + fmt(p3.y);
        }
      });
      if (sub.closed) d += 'Z';
    });
    return d;
  }

  /* bakeFlatten3D(objPaths, placement, opts, tol) — 動きの書き出しへ渡す頂点列の立体版。
     制御点を3D→2Dへ通してから（bakeObject3Dと同じ写像）、2Dのflatten()でベジェを
     直線分割する（8b番bakeFlattenの3D版）。 */
  function bakeFlatten3D(objPaths, placement, opts, tol) {
    opts = opts || {};
    var proj = opts.proj || {};
    var subs3 = placeOnFrame(objPaths, placement, opts.plane || 'lay', opts.twist || 0);
    var out = [];
    subs3.forEach(function (sub) {
      if (!sub.segs || !sub.segs.length) return;
      var projSub = {
        closed: !!sub.closed,
        anchors: (sub.anchors || []).map(function (a) { return projectPoint(a, proj); }),
        segs: sub.segs.map(function (seg) {
          if (seg.type === 'L') return { type: 'L', a: projectPoint(seg.a, proj), b: projectPoint(seg.b, proj) };
          return { type: 'C', p0: projectPoint(seg.p0, proj), p1: projectPoint(seg.p1, proj), p2: projectPoint(seg.p2, proj), p3: projectPoint(seg.p3, proj) };
        })
      };
      var flat = flatten(projSub, tol);
      flat.pts.forEach(function (p) { out.push([p.x, p.y]); });
    });
    return out;
  }

  /* arcLength2Dto3D(flat, flat3D, s2d) — 2D弧長(flat.pts基準)を、同じ点の並びで
     作ったflat3D（build3DFlatの戻り値）上の3D弧長へ変換する。並べる配置は2Dの
     弧長sで決まる（place系関数）ので、そのsに対応する3Dフレームをframeへ渡す前に
     ここで変換する（インデックス対応＝flat.pts[i]とflat3D.pts[i]は同じ点）。 */
  function arcLength2Dto3D(flat, flat3D, s2d) {
    var pts = flat.pts, n = pts.length;
    if (n < 2 || !flat3D.pts.length) return 0;
    var ss = Math.max(0, Math.min(flat.length, s2d));
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].s <= ss) lo = mid; else hi = mid;
    }
    var segLen = pts[hi].s - pts[lo].s;
    var u = segLen > 1e-12 ? (ss - pts[lo].s) / segLen : 0;
    var s3lo = flat3D.pts[lo].s, s3hi = flat3D.pts[hi].s;
    return s3lo + (s3hi - s3lo) * u;
  }

  /* ---- 色の混合（shadeColor専用の小さなヘルパー。#rgb/#rrggbbのみ対応） ---------- */
  function hexToRgb(hex) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16);
    if (!isFinite(n)) n = 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function rgbToHex(r, g, b) {
    function h(v) { return clamp255(v).toString(16).padStart(2, '0'); }
    return '#' + h(r) + h(g) + h(b);
  }
  function mixColor(c1, c2, t) {
    t = Math.max(0, Math.min(1, t));
    var a = hexToRgb(c1), b = hexToRgb(c2);
    return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
  }

  /* shadeColor(color, opts) — 陰影を色に適用する。
     opts: { depthNorm(0=奥,1=手前・正規化済み), haze(奥を薄くする%・0-100),
             facing(|法線と視線のcos|・0-1・寝かすときは1扱いでよい),
             brightness(面の明るさの強さ%・0-100), bg(既定#ffffff) }。
     手順: まず奥を薄くする（奥=depthNorm0に近いほどbgへ混ぜる）→ 次に面の明るさ
     （facingが0(視線と正対せず真横)に近いほど黒へ混ぜる）。 */
  function shadeColor(color, opts) {
    opts = opts || {};
    if (!color || color === 'none') return color;
    var bg = opts.bg || '#ffffff';
    var depthNorm = opts.depthNorm != null ? Math.max(0, Math.min(1, opts.depthNorm)) : 1;
    var haze = opts.haze != null ? opts.haze : 0;
    var facing = opts.facing != null ? Math.max(0, Math.min(1, opts.facing)) : 1;
    var brightness = opts.brightness != null ? opts.brightness : 0;
    var hazeT = (haze / 100) * (1 - depthNorm);
    var c1 = mixColor(color, bg, hazeT);
    var darkT = (brightness / 100) * (1 - facing);
    var c2 = mixColor(c1, '#000000', darkT);
    return c2;
  }

  /* ==========================================================================
     16. migrateParamsV3toV4(params) — 封筒paramsVersion 3→4の移行。
         段5で増えた立体キー（置く面・ねじれ回数・透視の強さ・霞・面の明るさ・
         奥ほど線を細く）へ既定値を埋めるだけ（既存キーは上書きしない）。
     ========================================================================== */
  function migrateParamsV3toV4(params) {
    var p = {};
    for (var k in (params || {})) p[k] = params[k];
    var defaults = {
      solidMode: 'lay', twistTurns: 1,
      perspective: 0, haze: 0, brightness: 0, thinFar: false
    };
    for (var key in defaults) { if (p[key] === undefined) p[key] = defaults[key]; }
    return p;
  }

  /* ==========================================================================
     17. migrateParamsV4toV5(params) — 封筒paramsVersion 4→5の移行。
         段6で色（塗り・線）を上部バーへ移した際に増えた背景色（bg）へ既定値（白）を
         埋めるだけ（fillColor/strokeColorのキー名はv1から変わっていないのでそのまま読める）。
     ========================================================================== */
  function migrateParamsV4toV5(params) {
    var p = {};
    for (var k in (params || {})) p[k] = params[k];
    if (p.bg === undefined) p.bg = '#FFFFFF';
    return p;
  }

  /* ==========================================================================
     18. colorRule(placements, kind, c1, c2, opts) — 段6-B-8「色の変化」。
         placements[].s（弧長）・配置順のindexを使い、各配置の色を1つ選ぶ。
         kind: none（全部c1）／gradient（位置で2色をつなぐ・並び順を0..1へ正規化）／
         alternate（交互に2色・偶数番目=c1・奇数番目=c2）／curvature（曲がりが強いほど
         2色目へ・opts.flatが必要・opts.gainで強さを調整）。
         戻り値: placementsと同じ長さの色配列（'#rrggbb'）。DOM非依存・純関数。
     ========================================================================== */
  function colorRule(placements, kind, c1, c2, opts) {
    opts = opts || {};
    var list = placements || [];
    var n = list.length;
    if (!kind || kind === 'none') return list.map(function () { return c1; });
    if (kind === 'gradient') {
      return list.map(function (p, i) {
        var u = n > 1 ? i / (n - 1) : 0;
        return mixColor(c1, c2, u);
      });
    }
    if (kind === 'alternate') {
      return list.map(function (p, i) { return (i % 2 === 0) ? c1 : c2; });
    }
    if (kind === 'curvature') {
      var flat = opts.flat;
      var gain = opts.gain != null ? opts.gain : 1;
      return list.map(function (p) {
        var kap = 0;
        if (flat && flat.length > 1e-9) {
          var ss = ((p.s % flat.length) + flat.length) % flat.length;
          kap = Math.abs(sampleAt(flat, ss).kappa);
        }
        var t = Math.max(0, Math.min(1, kap * gain));
        return mixColor(c1, c2, t);
      });
    }
    return list.map(function () { return c1; });
  }

  /* ==========================================================================
     19. objectIndexFor(i, n) — 段6-B-9「貼った要素を順に使う」。
         i番目の配置に i mod n 番目の要素を割り当てる（純関数・n<=0はいつも0）。
     ========================================================================== */
  function objectIndexFor(i, n) {
    var nn = Math.max(0, n | 0);
    if (nn <= 0) return 0;
    var idx = i % nn;
    return idx < 0 ? idx + nn : idx;
  }

  /* ==========================================================================
     20. migrateParamsV5toV6(params) — 封筒paramsVersion 5→6の移行。
         段6ブラッシュアップで増えたキー（色の変化・貼った要素を順に使う・
         交互に裏返す）へ既定値を埋めるだけ（既存キーは上書きしない）。
     ========================================================================== */
  function migrateParamsV5toV6(params) {
    var p = {};
    for (var k in (params || {})) p[k] = params[k];
    var defaults = {
      colorKind: 'none', color2: '#FFFFFF',
      useElementsInOrder: false, mirrorAlternate: false
    };
    for (var key in defaults) { if (p[key] === undefined) p[key] = defaults[key]; }
    /* 段6-B-7: 「変化の幅」の単位が倍率(0〜3・既定1)から%(-100〜100・既定100)へ変わった。
       旧SVG(v5以前)のsizeGainを等価な%へ換算する（1倍→100%）。 */
    if (typeof p.sizeGain === 'number') p.sizeGain = p.sizeGain * 100;
    return p;
  }

  /* ==========================================================================
     21. fitToArtboard(bbox, artboard, margin) — 版面フィット（段7バグ修正）。
         bbox{minX,minY,maxX,maxY} を artboard{x,y,w,h} へ、中央揃え・余白margin
         （既定8%・版面の短辺基準でpadを決め、縦横それぞれの空き幅/空き高さに対する
         比率の小さい方をscaleに採る＝横長bboxは幅基準・縦長は高さ基準で自動的に効く）
         で収める一様拡大＋平行移動を返す（Studio.fitInto と同じ考え方をsweep.js側に
         複製・drop間でimportしない・spec.md採用根拠参照）。
         戻り値 {scale, tx, ty}: 変換後の点 = 元の点*scale + (tx, ty)。
         bbox/artboardが不正（面積0等）ならscale=1・tx=ty=0（何もしない変換）。 --------- */
  function fitToArtboard(bbox, artboard, margin) {
    margin = margin == null ? 0.08 : margin;
    var ax = (artboard && artboard.x) || 0, ay = (artboard && artboard.y) || 0;
    var aw = artboard ? artboard.w : 0, ah = artboard ? artboard.h : 0;
    if (!(aw > 0) || !(ah > 0) || !bbox || !isFinite(bbox.minX) || !isFinite(bbox.maxX) || !isFinite(bbox.minY) || !isFinite(bbox.maxY)) {
      return { scale: 1, tx: 0, ty: 0 };
    }
    var short = Math.min(aw, ah);
    var pad = short * margin;
    var availW = Math.max(0, aw - 2 * pad), availH = Math.max(0, ah - 2 * pad);
    var bw = bbox.maxX - bbox.minX, bh = bbox.maxY - bbox.minY;
    var scale = 1;
    if (bw > 0 && bh > 0 && availW > 0 && availH > 0) scale = Math.min(availW / bw, availH / bh);
    var cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    var tx = (ax + aw / 2) - scale * cx;
    var ty = (ay + ah / 2) - scale * cy;
    return { scale: scale, tx: tx, ty: ty };
  }

  return {
    parsePath: parsePath,
    flatten: flatten,
    sampleAt: sampleAt,
    depthProfile: depthProfile,
    rotateProject: rotateProject,
    place: place,
    sizeRule: sizeRule,
    bakeObject: bakeObject,
    bakeFlatten: bakeFlatten,
    buildSVG: buildSVG,
    builtinShape: builtinShape,
    parseObjectSVG: parseObjectSVG,
    applySweepOptions: applySweepOptions,
    migrateParamsV1toV2: migrateParamsV1toV2,
    migrateParamsV2toV3: migrateParamsV2toV3,
    depthAt: depthAt,
    build3DFlat: build3DFlat,
    arcLength2Dto3D: arcLength2Dto3D,
    frameAt: frameAt,
    rotateFrameAroundT: rotateFrameAroundT,
    placeOnFrame: placeOnFrame,
    projectPoint: projectPoint,
    bakeObject3D: bakeObject3D,
    bakeFlatten3D: bakeFlatten3D,
    shadeColor: shadeColor,
    migrateParamsV3toV4: migrateParamsV3toV4,
    migrateParamsV4toV5: migrateParamsV4toV5,
    colorRule: colorRule,
    objectIndexFor: objectIndexFor,
    migrateParamsV5toV6: migrateParamsV5toV6,
    fitToArtboard: fitToArtboard,
    _curvatureAtIndex: curvatureAtIndex,
    _cubicPoint: cubicPoint,
    _segStart: segStart
  };
});
