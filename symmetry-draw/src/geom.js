/* geom.js — 幾何ユーティリティ（純粋関数のみ・DOM非依存）
   点列 → リサンプル → centripetal Catmull-Rom → 3次ベジェ（幾何の唯一の真実）
   速度 → 線幅、可変幅アウトライン、2x3アフィン行列（canvas/SVGのmatrix順） */
const Geom = (() => {
  "use strict";

  const W_BASE = 3;      // 基準線幅（パッド座標系, px）
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ================= 点列 ================= */

  // 最小距離リサンプル。先頭・末尾は必ず残す。t（時刻）などの追加成分は保持
  function resample(pts, minDist = 3) {
    if (pts.length <= 2) return pts.slice();
    const out = [pts[0]];
    let last = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const dx = pts[i][0] - last[0], dy = pts[i][1] - last[1];
      if (dx * dx + dy * dy >= minDist * minDist) { out.push(pts[i]); last = pts[i]; }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // Douglas-Peucker 簡略化。端点を保持し、線分から eps 未満しかずれない点を間引く。
  // 元の点オブジェクト（t 等を含む）をそのまま残すので幅計算を壊さない
  function simplifyDP(pts, eps) {
    if (eps <= 0 || pts.length <= 2) return pts;
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a][0], ay = pts[a][1];
      const dx = pts[b][0] - ax, dy = pts[b][1] - ay;
      const len2 = dx * dx + dy * dy || 1;
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const t = clamp(((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2, 0, 1);
        const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // centripetal Catmull-Rom (α=0.5) → 3次ベジェ列
  // pts (n≥2) → [{p0,c1,c2,p1}]（各点は[x,y]）。端点は複製で処理
  function toBeziers(pts) {
    const n = pts.length;
    if (n < 2) return [];
    const P = [pts[0], ...pts, pts[n - 1]];   // 前後を複製
    const segs = [];
    for (let i = 1; i <= n - 1; i++) {
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      // 弦長^0.5 をノット間隔に（centripetal）。重複点はεでガード
      const dt0 = Math.sqrt(Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 1e-4));
      const dt1 = Math.sqrt(Math.max(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 1e-4));
      const dt2 = Math.sqrt(Math.max(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 1e-4));
      // 非一様CRの接線（Hermite形）
      let t1x = (p1[0] - p0[0]) / dt0 - (p2[0] - p0[0]) / (dt0 + dt1) + (p2[0] - p1[0]) / dt1;
      let t1y = (p1[1] - p0[1]) / dt0 - (p2[1] - p0[1]) / (dt0 + dt1) + (p2[1] - p1[1]) / dt1;
      let t2x = (p2[0] - p1[0]) / dt1 - (p3[0] - p1[0]) / (dt1 + dt2) + (p3[0] - p2[0]) / dt2;
      let t2y = (p2[1] - p1[1]) / dt1 - (p3[1] - p1[1]) / (dt1 + dt2) + (p3[1] - p2[1]) / dt2;
      segs.push({
        p0: [p1[0], p1[1]],
        c1: [p1[0] + t1x * dt1 / 3, p1[1] + t1y * dt1 / 3],
        c2: [p2[0] - t2x * dt1 / 3, p2[1] - t2y * dt1 / 3],
        p1: [p2[0], p2[1]],
      });
    }
    return segs;
  }

  /* ================= 曲線パス（スムース点・S3） =================
     path item {curve:true, corners:[index...]} の幾何。cornersに無い点を滑らかに通る。
     canvas(render)とSVG(export)が同じベジェ列を消費する（既存不変条件と同じ流儀）。 */

  // 閉ループ全体をcentripetal CRで一周（端点複製でなく巻き込みで滑らかに閉じる）
  function loopBeziers(pts) {
    const n = pts.length;
    if (n < 3) return toBeziers(pts);
    const P = [pts[n - 1], ...pts, pts[0], pts[1]];
    const segs = [];
    for (let i = 1; i <= n; i++) {
      const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
      const dt0 = Math.sqrt(Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 1e-4));
      const dt1 = Math.sqrt(Math.max(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 1e-4));
      const dt2 = Math.sqrt(Math.max(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 1e-4));
      let t1x = (p1[0] - p0[0]) / dt0 - (p2[0] - p0[0]) / (dt0 + dt1) + (p2[0] - p1[0]) / dt1;
      let t1y = (p1[1] - p0[1]) / dt0 - (p2[1] - p0[1]) / (dt0 + dt1) + (p2[1] - p1[1]) / dt1;
      let t2x = (p2[0] - p1[0]) / dt1 - (p3[0] - p1[0]) / (dt1 + dt2) + (p3[0] - p2[0]) / dt2;
      let t2y = (p2[1] - p1[1]) / dt1 - (p3[1] - p1[1]) / (dt1 + dt2) + (p3[1] - p2[1]) / dt2;
      segs.push({
        p0: [p1[0], p1[1]],
        c1: [p1[0] + t1x * dt1 / 3, p1[1] + t1y * dt1 / 3],
        c2: [p2[0] - t2x * dt1 / 3, p2[1] - t2y * dt1 / 3],
        p1: [p2[0], p2[1]],
      });
    }
    return segs;
  }

  // 曲線パス: 角（corners）で分割し、区間ごとにCR。角はクランプされた端点として残る
  /* 3次一様B-スプライン → ベジェ列。Catmull-Rom（toBeziers）との違いは
     **制御点が曲線の上に乗らない**こと。だから角が丸まり、点を動かしても曲線が暴れない。
     各区間 i は制御点 P[i-1..i+2] から
       B0=(P0+4P1+P2)/6 / B1=(2P1+P2)/3 / B2=(P1+2P2)/3 / B3=(P1+4P2+P3)/6
     開いた線は端点を複製して端まで届かせる（clamped）。 */
  function bsplineBeziers(pts, closed) {
    const n = pts.length;
    if (n < 2) return [];
    const at = i => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
    const mix = (a, b, c, wa, wb, wc, d) => [
      (wa * a[0] + wb * b[0] + wc * c[0]) / d,
      (wa * a[1] + wb * b[1] + wc * c[1]) / d,
    ];
    const out = [];
    const last = closed ? n - 1 : n - 2;
    for (let i = 0; i <= last; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      out.push({
        p0: mix(p0, p1, p2, 1, 4, 1, 6),
        c1: mix(p1, p1, p2, 1, 1, 1, 3),
        c2: mix(p1, p2, p2, 1, 1, 1, 3),
        p1: mix(p1, p2, p3, 1, 4, 1, 6),
      });
    }
    return out;
  }

  /* mode="bspline" なら B-スプラインで解釈する（cornersは無視＝全体が滑らか）。
     既定は従来どおり centripetal Catmull-Rom（制御点が曲線に乗る） */
  function pathBeziers(points, closed, corners, mode) {
    if (mode === "bspline") return bsplineBeziers(points, !!closed);
    const n = points.length;
    if (n < 2) return [];
    const isC = new Set((corners || []).filter(i => i >= 0 && i < n));
    if (!isC.size) return closed ? loopBeziers(points) : toBeziers(points);
    const runs = [];
    if (closed) {
      const ci = [...isC].sort((a, b) => a - b);
      for (let k = 0; k < ci.length; k++) {
        const a = ci[k], b = ci[(k + 1) % ci.length];
        const run = [];
        for (let i = a; ; i = (i + 1) % n) {
          run.push(points[i]);
          if (i === b && run.length > 1) break;
          if (run.length > n + 1) break;   // 角が1個のとき一周
        }
        runs.push(run);
      }
    } else {
      let cur = [points[0]];
      for (let i = 1; i < n; i++) {
        cur.push(points[i]);
        if (isC.has(i) && i < n - 1) { runs.push(cur); cur = [points[i]]; }
      }
      runs.push(cur);
    }
    const out = [];
    for (const run of runs) if (run.length >= 2) out.push(...toBeziers(run));
    return out;
  }

  // ベジェ列を折れ線へ（ブール演算・ヒット判定の入力用）
  function flattenBeziers(beziers, step = 2.5) {
    const out = [];
    for (let i = 0; i < beziers.length; i++) {
      const b = beziers[i];
      const chord = Math.hypot(b.p1[0] - b.p0[0], b.p1[1] - b.p0[1]);
      const k = clamp(Math.ceil(chord / step), 2, 24);
      for (let j = (i === 0 ? 0 : 1); j <= k; j++) {
        const t = j / k, u = 1 - t;
        out.push([
          u * u * u * b.p0[0] + 3 * u * u * t * b.c1[0] + 3 * u * t * t * b.c2[0] + t * t * t * b.p1[0],
          u * u * u * b.p0[1] + 3 * u * u * t * b.c1[1] + 3 * u * t * t * b.c2[1] + t * t * t * b.p1[1],
        ]);
      }
    }
    return out;
  }

  /* ================= 角丸フィレット =================
     折れ線/多角形の頂点を半径rの真円弧フィレットに置き換えた「セグメント列」。
     canvas(render.js segsToPath: arcTo)と SVG(export.js segsD: Aコマンド)が
     同一の円を描くための単一ソース。
     戻り値: {start:[x,y], closed, segs:[{t:"L",to}|{t:"A",corner,to,r,sweep}]}
     消費契約: moveTo(start) → L=lineTo / A=arcTo(corner,to,r) → closedならclosePath。
     各Aセグの直前で現在点が必ず円弧の進入点に来るようセグ列を構成してある。 */
  function roundedSegs(ptsIn, closed, r) {
    if (!(r > 0) || !Array.isArray(ptsIn)) return null;
    const pts = [];
    for (const p of ptsIn) {   // 連続重複点を除去
      const q = [p[0], p[1]];
      if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 1e-9) pts.push(q);
    }
    if (closed && pts.length > 1 &&
        Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
    const n = pts.length;
    if (n < 3) return null;
    // 頂点iのフィレット。P→V→N の挟角φから t=r/tan(φ/2)、tは両隣接辺の半分まで
    const corner = i => {
      const P = pts[(i - 1 + n) % n], V = pts[i], N = pts[(i + 1) % n];
      const l1 = Math.hypot(V[0] - P[0], V[1] - P[1]);
      const l2 = Math.hypot(N[0] - V[0], N[1] - V[1]);
      if (l1 < 1e-9 || l2 < 1e-9) return null;
      const u1x = (P[0] - V[0]) / l1, u1y = (P[1] - V[1]) / l1;   // V→P
      const u2x = (N[0] - V[0]) / l2, u2y = (N[1] - V[1]) / l2;   // V→N
      const cosPhi = clamp(u1x * u2x + u1y * u2y, -1, 1);
      const phi = Math.acos(cosPhi);
      if (phi < 1e-3 || Math.PI - phi < 1e-3) return null;   // 折返し / ほぼ直線は円弧なし
      let t = r / Math.tan(phi / 2);
      t = Math.min(t, l1 / 2, l2 / 2);   // 隣の頂点のフィレットと取り合わない
      const rEff = t * Math.tan(phi / 2);
      if (rEff < 1e-6) return null;
      const A = [V[0] + u1x * t, V[1] + u1y * t];   // 進入点（P側の辺上）
      const B = [V[0] + u2x * t, V[1] + u2y * t];   // 脱出点（N側の辺上）
      // 円心 = 二等分線上・距離 rEff/sin(φ/2)。sweepは円心まわりの回転方向から決定的に求める
      const bl = Math.hypot(u1x + u2x, u1y + u2y);
      const C = [V[0] + (u1x + u2x) / bl * (rEff / Math.sin(phi / 2)),
                 V[1] + (u1y + u2y) / bl * (rEff / Math.sin(phi / 2))];
      const cross = (A[0] - C[0]) * (B[1] - C[1]) - (A[1] - C[1]) * (B[0] - C[0]);
      return { A, B, r: rEff, sweep: cross > 0 ? 1 : 0, V: [V[0], V[1]], C };
    };
    const segs = [];
    let start;
    const pushL = to => {   // 距離0のLは出さない
      const cur = segs.length ? segs[segs.length - 1].to : start;
      if (Math.hypot(to[0] - cur[0], to[1] - cur[1]) > 1e-9) segs.push({ t: "L", to: [to[0], to[1]] });
    };
    if (closed) {
      const cs = [];
      for (let i = 0; i < n; i++) cs.push(corner(i));
      start = cs[0] ? cs[0].A : [pts[0][0], pts[0][1]];
      for (let i = 0; i < n; i++) {
        const c = cs[i];
        if (c) {
          if (i > 0) pushL(c.A);
          segs.push({ t: "A", corner: c.V, to: c.B, r: c.r, sweep: c.sweep });
        } else if (i > 0) pushL(pts[i]);
      }
      // 閉じ（最後のB→start）はclosePath / "Z" が担う
    } else {
      start = [pts[0][0], pts[0][1]];
      for (let i = 1; i < n - 1; i++) {
        const c = corner(i);
        if (c) { pushL(c.A); segs.push({ t: "A", corner: c.V, to: c.B, r: c.r, sweep: c.sweep }); }
        else pushL(pts[i]);
      }
      pushL(pts[n - 1]);
    }
    return { start, closed: !!closed, segs };
  }

  /* ================= 多角形ブール演算（シェイプ演算の核） =================
     polyBool(groupA, groupB, op): op="unite"(A∪B・groupB空なら自己正規化) | "subtract"(A−B) | "intersect"(A∩B)
     group = poly[] / poly = ring[]（even-oddで解釈・ring=[[x,y],...] 暗黙閉）
     戻り値: [{outer, holes}] — 巻きは outer:符号面積>0 / holes:<0 を保証（nonzeroで穴が抜ける）
     方式: 全辺の相互交差分割 → 各フラグメント中点の左右オフセット内外判定で境界だけ残す
           → 領域が左に来る向きに揃えて縫合 → 包含の偶奇で outer/hole 階層化。
     決定的（乱数なし）。退化（辺の完全一致等）はring毎の固定微小ジッタで回避し、
     出力頂点は元の入力頂点へweld（≈1e-3px）してジッタを外に漏らさない。 */
  function ringArea(ring) {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }
  // even-odd内外（rings=ringの配列）
  function inRings(rings, x, y) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  const inGroup = (group, x, y) => group.some(rings => inRings(rings, x, y));

  function polyBool(groupA, groupB, op) {
    // 正規化 + ring毎の決定的ジッタ。重複点/縮退ringを除去。
    // ジッタ総量は入力ring数に応じてスケールし、必ずノード融合閾値(2.5e-3)未満に収める
    //（上限がないと約60ring以上で「本来同一の角」が別ノードに割れて縫合が破棄される）
    let jk = 0;
    const nRings = (groupA || []).reduce((s, p) => s + p.length, 0) + (groupB || []).reduce((s, p) => s + p.length, 0);
    const JX = Math.min(3.7e-5, 1.5e-3 / Math.max(1, nRings));
    const JY = JX * (2.3 / 3.7);
    const prep = group => (group || []).map(rings => rings.map(ring => {
      jk++;
      const out = [];
      for (const p of ring) {
        const q = [p[0] + jk * JX, p[1] + jk * JY];
        if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > 1e-9) out.push(q);
      }
      while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
      return out;
    }).filter(rg => rg.length >= 3)).filter(poly => poly.length);
    const A = prep(groupA), B = prep(groupB);
    if (!A.length) return [];   // subtractの被減算が無い / uniteでBだけ渡す用法は不使用
    if (op === "intersect" && !B.length) return [];   // 交差は相手が必須（空との交差は空）
    // 全辺収集
    const edges = [];
    for (const group of [A, B]) for (const poly of group) for (const ring of poly)
      for (let i = 0; i < ring.length; i++) edges.push({ a: ring[i], b: ring[(i + 1) % ring.length] });
    // 相互交差でパラメータ分割（O(S²)・入力は高々数百辺）
    const splitTs = edges.map(() => [0, 1]);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const d1x = e.b[0] - e.a[0], d1y = e.b[1] - e.a[1];
      for (let j = i + 1; j < edges.length; j++) {
        const f = edges[j];
        const d2x = f.b[0] - f.a[0], d2y = f.b[1] - f.a[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;   // 平行（完全重なりはジッタ済みで存在しない）
        const ex = f.a[0] - e.a[0], ey = f.a[1] - e.a[1];
        const t = (ex * d2y - ey * d2x) / den;
        const u = (ex * d1y - ey * d1x) / den;
        if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) {
          splitTs[i].push(clamp(t, 0, 1));
          splitTs[j].push(clamp(u, 0, 1));
        }
      }
    }
    // フラグメント分類: 中点の左右 5e-3 オフセットで内外を見る。
    // ジッタ由来の分離（最大 3.7e-5×ring数 ≈ 1.5e-3）を必ず飛び越える=元々一致していた辺は
    // 「両側とも内側」と判定されて自然に消える。実寸の形状（≥0.5px）には影響しない
    const DELTA = 5e-3;
    const inside = op === "subtract"
      ? (x, y) => inGroup(A, x, y) && !inGroup(B, x, y)
      : op === "intersect"
      ? (x, y) => inGroup(A, x, y) && inGroup(B, x, y)
      : (x, y) => inGroup(A, x, y) || inGroup(B, x, y);
    const frags = [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const ts = [...new Set(splitTs[i].map(t => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
      for (let s = 0; s + 1 < ts.length; s++) {
        const ax = e.a[0] + (e.b[0] - e.a[0]) * ts[s], ay = e.a[1] + (e.b[1] - e.a[1]) * ts[s];
        const bx = e.a[0] + (e.b[0] - e.a[0]) * ts[s + 1], by = e.a[1] + (e.b[1] - e.a[1]) * ts[s + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-9) continue;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const nx = -(by - ay) / len, ny = (bx - ax) / len;   // 左法線
        const inL = inside(mx + nx * DELTA, my + ny * DELTA);
        const inR = inside(mx - nx * DELTA, my - ny * DELTA);
        if (inL === inR) continue;                            // 境界でない（共有辺は両側内側→自然に消える）
        frags.push(inL ? { a: [ax, ay], b: [bx, by] } : { a: [bx, by], b: [ax, ay] });   // 領域を左に
      }
    }
    if (!frags.length) return [];
    // 端点ノード化（空間ハッシュで2.5e-3以内をマージ。ジッタでズレた「本来同一の角」を束ねる）
    const grid = new Map();
    const nodes = [];
    const nodeOf = p => {
      const gx = Math.round(p[0] * 400), gy = Math.round(p[1] * 400);   // 2.5e-3セル
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx},${gy + dy}`);
        if (cell) for (const nd of cell) if (Math.hypot(nd.x - p[0], nd.y - p[1]) < 2.5e-3) return nd;
      }
      const nd = { x: p[0], y: p[1], out: [] };
      const kk = `${gx},${gy}`;
      if (!grid.has(kk)) grid.set(kk, []);
      grid.get(kk).push(nd);
      nodes.push(nd);
      return nd;
    };
    for (const f of frags) {
      const na = nodeOf(f.a), nb = nodeOf(f.b);
      if (na !== nb) na.out.push({ to: nb, from: na, used: false });
    }
    // 縫合: 未使用の出エッジを辿る。分岐点では「逆入射方向から反時計回りに最初」の出エッジ
    //（領域が左の半辺で面をなぞる標準規則）。行き止まりは数値不整合として破棄
    const loops = [];
    for (const nd of nodes) for (const e0 of nd.out) {
      if (e0.used) continue;
      const loop = [];
      let prev = nd, e = e0;
      let guard = frags.length + 4;
      while (guard-- > 0) {
        e.used = true;
        loop.push([prev.x, prev.y]);
        const cur = e.to;
        const inx = cur.x - prev.x, iny = cur.y - prev.y;
        let pick = null, bestA = Infinity;
        for (const cand of cur.out) {
          if (cand.used) continue;
          const ox = cand.to.x - cur.x, oy = cand.to.y - cur.y;
          let a = Math.atan2((-inx) * oy - (-iny) * ox, (-inx) * ox + (-iny) * oy);
          if (a <= 1e-12) a += 2 * Math.PI;
          if (a < bestA) { bestA = a; pick = cand; }
        }
        if (!pick) {
          if (cur === nd && loop.length >= 3) loops.push(loop);
          break;
        }
        prev = cur; e = pick;
      }
    }
    // 出力整形: 元の入力頂点へweld（ジッタを外に漏らさない）→ 共線間引き → 面積フィルタ
    const origGrid = new Map();
    for (const group of [groupA, groupB || []]) for (const poly of group) for (const ring of poly)
      for (const p of ring) {
        const kk = `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)}`;   // 2e-3セル
        if (!origGrid.has(kk)) origGrid.set(kk, []);
        origGrid.get(kk).push(p);
      }
    const weld = p => {
      const gx = Math.round(p[0] * 500), gy = Math.round(p[1] * 500);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cell = origGrid.get(`${gx + dx},${gy + dy}`);
        if (cell) for (const q of cell)
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 2e-3) return [q[0], q[1]];
      }
      return p;
    };
    const cleaned = [];
    for (let loop of loops) {
      loop = loop.map(weld);
      // 閉ringの共線間引き（simplifyDPは端点保持なので先頭を複製して回す）
      const dp = simplifyDP([...loop, loop[0]], 0.02);
      dp.pop();
      if (dp.length < 3) continue;
      if (Math.abs(ringArea(dp)) < 0.05) continue;   // ジッタ由来のスリバー等を捨てる
      cleaned.push(dp);
    }
    if (!cleaned.length) return [];
    // 階層化: 代表点（第1辺中点+左法線オフセット=領域側）を他ループで数えて偶奇
    const rep = loop => {
      const a = loop[0], b = loop[1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(a[0] + b[0]) / 2 - (b[1] - a[1]) / len * 1e-3,   // 中点 + 左法線×1e-3（領域側）
              (a[1] + b[1]) / 2 + (b[0] - a[0]) / len * 1e-3];
    };
    const info = cleaned.map(loop => {
      const p = rep(loop);
      let depth = 0;
      for (const other of cleaned) {
        if (other === loop) continue;
        if (inRings([other], p[0], p[1])) depth++;
      }
      return { loop, depth, area: Math.abs(ringArea(loop)), p };
    });
    const outers = info.filter(x => x.depth % 2 === 0);
    const out = outers.map(o => ({
      outer: ringArea(o.loop) > 0 ? o.loop : [...o.loop].reverse(),
      holes: [],
    }));
    for (const h of info) {
      if (h.depth % 2 === 0) continue;
      // この穴を含む最小のouterへ割り当て
      let best = -1, bestArea = Infinity;
      for (let i = 0; i < outers.length; i++) {
        if (outers[i].area > h.area && outers[i].area < bestArea && inRings([outers[i].loop], h.p[0], h.p[1])) {
          best = i; bestArea = outers[i].area;
        }
      }
      if (best >= 0) out[best].holes.push(ringArea(h.loop) < 0 ? h.loop : [...h.loop].reverse());
    }
    return out;
  }

  /* ================= 平面分割（面の抽出） =================
     閉じた図形の輪郭（closed=itemごとのring列: [外周, 穴...]）と、切る線（knives=折れ線）を
     ひとつの平面グラフにして、囲まれた最小の面をすべて返す。
     イラレの「パスファインダー: 分割」＋シェイプ形成ツールの土台。
     polyBoolと同じ決定的ジッタ＋weld方式（乱数は使わない）。

     **開いた線だけでも面を返す**（closedが空でもよい）。線が交わってできる閉じた領域は
     ちゃんと面であり、そこを塗る／消すのがイラレのシェイプ形成ツールの主用途だから。
     閉じた図形があるときは「その内側の面」だけを採る（＝図形の外に漏れた領域を拾わない）が、
     線しかないときはその制限をかけない——かけると面が全部消える。

     戻り: [{outer, holes}]（outerは面積>0＝内側が左。座標は入力頂点へweld済み）
     `planarEdges(closed, knives)` は同じ平面グラフから**線**を返す（枝刈りなし・面の内外に依らない）。 */
  // 平面グラフの「線」だけが欲しいとき（枝も含む・面の内外に依らない）
  const planarEdges = (closed, knives) => polyFaces(closed, knives, { edges: true });

  function polyFaces(closedIn, knivesIn, opts) {
    const closed = (closedIn || []).filter(rings => rings && rings.length);
    const knives = (knivesIn || []).filter(pl => pl && pl.length >= 2);
    if (!closed.length && !knives.length) return [];
    let jk = 0;
    const nRings = closed.reduce((s, p) => s + p.length, 0) + knives.length;
    const JX = Math.min(3.7e-5, 1.5e-3 / Math.max(1, nRings));
    const JY = JX * (2.3 / 3.7);
    const prep = (pts, close) => {
      jk++;
      const out = [];
      for (const p of pts) {
        const q = [p[0] + jk * JX, p[1] + jk * JY];
        if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > 1e-9) out.push(q);
      }
      if (close) while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
      return out;
    };
    const A = closed.map(rings => rings.map(rg => prep(rg, true)).filter(rg => rg.length >= 3)).filter(p => p.length);
    const K = knives.map(pl => prep(pl, false)).filter(pl => pl.length >= 2);
    if (!A.length && !K.length) return [];
    const edges = [];
    for (const poly of A) for (const ring of poly)
      for (let i = 0; i < ring.length; i++) edges.push({ a: ring[i], b: ring[(i + 1) % ring.length] });
    for (const pl of K) for (let i = 0; i + 1 < pl.length; i++) edges.push({ a: pl[i], b: pl[i + 1] });
    // 交点でパラメータ分割（polyBoolと同じ O(S²)）
    const splitTs = edges.map(() => [0, 1]);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const d1x = e.b[0] - e.a[0], d1y = e.b[1] - e.a[1];
      for (let j = i + 1; j < edges.length; j++) {
        const f = edges[j];
        const d2x = f.b[0] - f.a[0], d2y = f.b[1] - f.a[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;
        const ex = f.a[0] - e.a[0], ey = f.a[1] - e.a[1];
        const t = (ex * d2y - ey * d2x) / den;
        const u = (ex * d1y - ey * d1x) / den;
        if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) {
          splitTs[i].push(clamp(t, 0, 1));
          splitTs[j].push(clamp(u, 0, 1));
        }
      }
    }
    // 端点ノード化（2.5e-3以内をマージ＝ジッタでズレた「本来同一の角」を束ねる）
    const grid = new Map();
    const nodes = [];
    const nodeOf = p => {
      const gx = Math.round(p[0] * 400), gy = Math.round(p[1] * 400);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx},${gy + dy}`);
        if (cell) for (const nd of cell) if (Math.hypot(nd.x - p[0], nd.y - p[1]) < 2.5e-3) return nd;
      }
      const nd = { x: p[0], y: p[1], out: [] };
      const kk = `${gx},${gy}`;
      if (!grid.has(kk)) grid.set(kk, []);
      grid.get(kk).push(nd);
      nodes.push(nd);
      return nd;
    };
    const halves = [];
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const ts = [...new Set(splitTs[i].map(t => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
      for (let s = 0; s + 1 < ts.length; s++) {
        const ax = e.a[0] + (e.b[0] - e.a[0]) * ts[s], ay = e.a[1] + (e.b[1] - e.a[1]) * ts[s];
        const bx = e.a[0] + (e.b[0] - e.a[0]) * ts[s + 1], by = e.a[1] + (e.b[1] - e.a[1]) * ts[s + 1];
        if (Math.hypot(bx - ax, by - ay) < 1e-9) continue;
        const na = nodeOf([ax, ay]), nb = nodeOf([bx, by]);
        if (na === nb) continue;
        if (na.out.some(h => h.to === nb)) continue;   // 重なった辺は1本に畳む
        const e1 = { from: na, to: nb, used: false, dead: false };
        const e2 = { from: nb, to: na, used: false, dead: false };
        e1.twin = e2; e2.twin = e1;
        na.out.push(e1); nb.out.push(e2);
        halves.push(e1, e2);
      }
    }
    // 出力整形: 入力頂点へweld（ジッタを外に漏らさない）→ 共線間引き
    const origGrid = new Map();
    const remember = p => {
      const kk = `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)}`;
      if (!origGrid.has(kk)) origGrid.set(kk, []);
      origGrid.get(kk).push(p);
    };
    for (const rings of closed) for (const ring of rings) for (const p of ring) remember(p);
    for (const pl of knives) for (const p of pl) remember(p);   // 線だけのときもジッタを外に漏らさない
    const weld = p => {
      const gx = Math.round(p[0] * 500), gy = Math.round(p[1] * 500);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const cell = origGrid.get(`${gx + dx},${gy + dy}`);
        if (cell) for (const q of cell) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 2e-3) return [q[0], q[1]];
      }
      return p;
    };

    /* edges モード: **枝刈りをせず**に、次数≠2のノード（端点・分岐点）で区切った
       「交点から交点まで」の線を全部返す。面を囲まない枝＝ぴょっと出たパスも含む
       （面から線を作ると、刈られた枝は永久に触れない。線を消す道具にはそれが要る） */
    if (opts && opts.edges) {
      const segs = [], done = new Set();
      const walk = h => {
        const pts = [[h.from.x, h.from.y]];
        let cur = h;
        for (;;) {
          done.add(cur); done.add(cur.twin);
          pts.push([cur.to.x, cur.to.y]);
          const nd = cur.to;
          if (nd.out.length !== 2) break;                       // 端点 or 分岐点で切る
          const nxt = nd.out.find(o => o !== cur.twin && !done.has(o));
          if (!nxt) break;
          cur = nxt;
        }
        return pts;
      };
      for (const nd of nodes) {
        if (nd.out.length === 2) continue;                      // 通過点は起点にしない
        for (const h of nd.out) if (!done.has(h)) segs.push(walk(h));
      }
      for (const h of halves) if (!done.has(h)) segs.push(walk(h));   // 全部が次数2＝閉じた輪だけの場合
      return segs.map(pts => pts.map(weld)).filter(pts => pts.length >= 2);
    }

    // 次数1のノードを刈る（ナイフのはみ出し＝面を囲まない枝）
    for (let pass = 0; pass < nodes.length + 1; pass++) {
      let changed = false;
      for (const nd of nodes) {
        const live = nd.out.filter(h => !h.dead);
        if (live.length === 1) { live[0].dead = true; live[0].twin.dead = true; changed = true; }
      }
      if (!changed) break;
    }
    /* 面の追跡: 分岐点では「逆向き入射から時計回りに最初の出辺」＝最小の面を左に見て一周する。
       （polyBoolの境界縫合は反時計回りに最初＝和の外形をなぞる規則。ここは最小面が欲しいので逆） */
    const loops = [];
    for (const e0 of halves) {
      if (e0.dead || e0.used) continue;
      const loop = [];
      let e = e0;
      let guard = halves.length + 4;
      while (guard-- > 0) {
        e.used = true;
        loop.push([e.from.x, e.from.y]);
        const cur = e.to;
        const inx = cur.x - e.from.x, iny = cur.y - e.from.y;
        let pick = null, bestA = -Infinity, back = null;
        for (const cand of cur.out) {
          if (cand.dead) continue;
          const ox = cand.to.x - cur.x, oy = cand.to.y - cur.y;
          let a = Math.atan2((-inx) * oy - (-iny) * ox, (-inx) * ox + (-iny) * oy);
          if (a <= 1e-12) a += 2 * Math.PI;
          if (a > 2 * Math.PI - 1e-9) { back = cand; continue; }   // 逆行は行き止まり(橋)のときだけ
          if (a > bestA) { bestA = a; pick = cand; }
        }
        if (!pick) pick = back;
        if (!pick) break;
        if (pick === e0) { if (loop.length >= 3) loops.push(loop); break; }
        if (pick.used) break;   // 数値不整合は捨てる
        e = pick;
      }
    }
    const cleaned = [];
    for (let loop of loops) {
      loop = loop.map(weld);
      const dp = simplifyDP([...loop, loop[0]], 0.02);
      dp.pop();
      if (dp.length < 3) continue;
      if (Math.abs(ringArea(dp)) < 0.05) continue;
      cleaned.push(dp);
    }
    // 内部の代表点（第1辺の中点 + 左法線ε＝面の側）
    const rep = loop => {
      const a = loop[0], b = loop[1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(a[0] + b[0]) / 2 - (b[1] - a[1]) / len * 1e-3,
              (a[1] + b[1]) / 2 + (b[0] - a[0]) / len * 1e-3];
    };
    /* 面積>0＝面（内側が左）/ 面積<0＝穴の境界 or 外側の面。
       閉じた図形があるときだけ「その内側」に絞る（図形の外へ漏れた領域を拾わないため）。
       線しかないときに絞ると、線が囲む面が全部落ちて何も返らなくなる */
    const bounded = closed.length > 0;
    const faces = [], holes = [];
    for (const loop of cleaned) {
      const p = rep(loop);
      if (ringArea(loop) > 0) {
        if (!bounded || inGroup(closed, p[0], p[1])) faces.push({ loop, p, area: ringArea(loop) });
      } else holes.push({ loop, p, area: -ringArea(loop) });
    }
    const out = faces.map(f => ({ outer: f.loop, holes: [] }));
    for (const h of holes) {
      let best = -1, bestArea = Infinity;
      for (let i = 0; i < faces.length; i++) {
        if (faces[i].area > h.area && faces[i].area < bestArea && inRings([faces[i].loop], h.p[0], h.p[1])) {
          best = i; bestArea = faces[i].area;
        }
      }
      if (best >= 0) out[best].holes.push([...h.loop].reverse());   // 穴は逆巻き（nonzeroで抜ける）
    }
    return out;
  }

  /* ================= 2x3 アフィン行列 =================
     [a,b,c,d,e,f]: x' = a·x + c·y + e / y' = b·x + d·y + f
     （canvas setTransform / SVG matrix() と同順） */

  const identity = () => [1, 0, 0, 1, 0, 0];
  const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
  const scaleMat = s => [s, 0, 0, s, 0, 0];

  // m∘n（nを先に適用）
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // 分数座標系の操作（2x2整数行列 M[m00,m01,m10,m11]・分数並進 t）を
  // 格子基底 B（2x2 row-major、列ベクトルが v1,v2）でカルテシアンへ:
  // M_cart = B·M·B⁻¹, t_cart = B·t
  function fromFrac(M, t, B) {
    const [b00, b01, b10, b11] = B;
    const det = b00 * b11 - b01 * b10;
    // BM
    const bm00 = b00 * M[0] + b01 * M[2], bm01 = b00 * M[1] + b01 * M[3];
    const bm10 = b10 * M[0] + b11 * M[2], bm11 = b10 * M[1] + b11 * M[3];
    // (BM)·B⁻¹
    const c00 = (bm00 * b11 - bm01 * b10) / det, c01 = (-bm00 * b01 + bm01 * b00) / det;
    const c10 = (bm10 * b11 - bm11 * b10) / det, c11 = (-bm10 * b01 + bm11 * b00) / det;
    const tx = b00 * t[0] + b01 * t[1], ty = b10 * t[0] + b11 * t[1];
    // canvas順: a=c00, b=c10, c=c01, d=c11
    return [c00, c10, c01, c11, tx, ty];
  }

  /* ================= オフセット（パスの外側/内側に平行線） =================
     辺を法線方向に d だけ平行移動し、角は**マイター**で繋ぐ（マイター長が上限を超えたらベベルに落とす）。
     巻きの規約は polyBool と同じ（外周=符号面積>0 / 穴=<0）で、**辺 a→b の右法線 (dy,-dx) が外側**。
     したがって d>0 = 図形が太る / d<0 = 細る。穴は逆巻きなので同じ式で自動的に「穴が縮む」。
     凹角では自己交差が出るのが正常なので、必ず polyBool(unite) に通して掃除する（offsetPoly が担当）。 */
  const MITER_LIMIT = 4;

  // 辺列（縮退辺を除いた {a,b,ux,uy} 列）を作る。closed=false なら最後の辺は繋がない
  function offsetSides(pts, d, closed) {
    const n = pts.length;
    const last = closed ? n : n - 1;
    const sides = [];
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;                      // 縮退辺は捨てる
      const nx = dy / len * d, ny = -dx / len * d;   // 右法線 × d
      sides.push({ a: [a[0] + nx, a[1] + ny], b: [b[0] + nx, b[1] + ny], ux: dx / len, uy: dy / len, v: b });
    }
    return sides;
  }

  // 隣り合う2辺の継ぎ目を out に足す（マイター or ベベル）。v=元の頂点
  function offsetJoin(out, s, t, d, miterLimit) {
    const den = s.ux * t.uy - s.uy * t.ux;
    if (Math.abs(den) < 1e-9) { out.push([s.b[0], s.b[1]]); return; }   // 平行＝そのまま直進
    const ex = t.a[0] - s.b[0], ey = t.a[1] - s.b[1];
    const k = (ex * t.uy - ey * t.ux) / den;
    const px = s.b[0] + s.ux * k, py = s.b[1] + s.uy * k;
    if (Math.hypot(px - s.v[0], py - s.v[1]) <= miterLimit * Math.abs(d)) out.push([px, py]);   // マイター
    else { out.push([s.b[0], s.b[1]]); out.push([t.a[0], t.a[1]]); }                            // ベベル（角を切る）
  }

  // 閉リング → オフセットした閉リング（自己交差はあり得る）
  function offsetRing(ring, d, miterLimit = MITER_LIMIT) {
    if (!d) return ring.map(p => [p[0], p[1]]);
    const sides = offsetSides(ring, d, true);
    if (sides.length < 3) return [];
    const out = [];
    for (let i = 0; i < sides.length; i++) offsetJoin(out, sides[i], sides[(i + 1) % sides.length], d, miterLimit);
    return out;
  }

  // 開いた折れ線 → 片側だけオフセットした開いた折れ線（端は延長しない＝バット）
  function offsetSide(pts, d, miterLimit = MITER_LIMIT) {
    const sides = offsetSides(pts, d, false);
    if (!sides.length) return [];
    const out = [[sides[0].a[0], sides[0].a[1]]];
    for (let i = 0; i < sides.length - 1; i++) offsetJoin(out, sides[i], sides[i + 1], d, miterLimit);
    const e = sides[sides.length - 1];
    out.push([e.b[0], e.b[1]]);
    return out;
  }

  // 点と線分の距離 / 点とリング群の最小距離（オフセットの妥当性判定に使う）
  function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let t = L2 > 1e-18 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
  }
  function minDistToRings(rings, p) {
    let m = Infinity;
    for (const rg of rings) for (let i = 0; i < rg.length; i++) {
      const d = distToSeg(p, rg[i], rg[(i + 1) % rg.length]);
      if (d < m) m = d;
    }
    return m;
  }

  /* poly（[外周, 穴...]・巻きは任意）を d オフセットして掃除まで済ませる。
     戻り: polyBool と同じ [{outer, holes}]（細らせて消えたら []）

     潰れの判定は**巻きの符号では効かない**（10角形を半幅以上細らせると、位置は裏返るのに
     巡回の向きは保存されるので符号面積は正のまま＝小さな幽霊が残る）。
     正しい不変条件は「オフセット結果の全頂点は、元の輪郭から |d| 以上離れている」
     （辺の平行移動端点=ちょうど|d| / マイター点=|d|/sin(θ/2)≥|d| / ベベル端点=|d|）。
     これを polyBool で自己交差を解いた**後**に poly/hole 単位で当てる。 */
  function offsetPoly(rings, d, miterLimit = MITER_LIMIT) {
    const norm = (rings || []).filter(rg => rg && rg.length >= 3).map((rg, i) => {
      const want = i === 0 ? 1 : -1;                              // 外周は正巻き・穴は負巻きに正規化
      const pts = rg.map(p => [p[0], p[1]]);
      return (ringArea(rg) > 0 ? 1 : -1) === want ? pts : pts.reverse();
    });
    if (!norm.length) return [];
    if (!d) return polyBool([norm], [], "unite");
    const off = norm.map(rg => offsetRing(rg, d, miterLimit)).filter(rg => rg.length >= 3);
    if (!off.length) return [];
    const res = polyBool([off], [], "unite");                     // 凹角の自己交差をここで掃除
    const lim = Math.abs(d) * 0.999 - 1e-6;                       // weld・交点計算の誤差ぶん緩める
    const alive = ring => ring.every(p => minDistToRings(norm, p) >= lim);
    return res.filter(p => alive(p.outer)).map(p => ({ outer: p.outer, holes: p.holes.filter(alive) }));
  }

  /* 開いた折れ線 → 幅 2|d| の輪郭（閉じた面）。太らせた側と細らせた側を繋ぐ。
     戻り: [{outer, holes}] */
  function outlinePath(pts, d, miterLimit = MITER_LIMIT) {
    const w = Math.abs(d);
    if (!(w > 0) || !pts || pts.length < 2) return [];
    const fwd = offsetSide(pts, w, miterLimit);
    const bwd = offsetSide([...pts].reverse(), w, miterLimit);   // 逆走＝反対側
    if (fwd.length < 2 || bwd.length < 2) return [];
    return polyBool([[[...fwd, ...bwd]]], [], "unite");
  }

  // 2x3行列の線形部が直交（等長変換）か
  function isOrthogonal(m, eps = 1e-6) {
    const dot = m[0] * m[2] + m[1] * m[3];
    const l1 = m[0] * m[0] + m[1] * m[1];
    const l2 = m[2] * m[2] + m[3] * m[3];
    return Math.abs(dot) < eps && Math.abs(l1 - 1) < eps && Math.abs(l2 - 1) < eps;
  }

  const det2 = m => m[0] * m[3] - m[1] * m[2];

  // 2x3アフィンの逆行列（編集モードの逆写像=ビュー座標→モチーフ座標 で使う）
  function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  }

  return {
    W_BASE, clamp,
    resample, simplifyDP, toBeziers,
    pathBeziers, flattenBeziers,       // 曲線パス（スムース点）: canvas/SVG共通のベジェ列と平坦化
    roundedSegs, polyBool, polyFaces, planarEdges, ringArea, bsplineBeziers,   // 角丸フィレット / シェイプ演算 / 平面分割 / 符号面積
    offsetPoly, outlinePath, offsetRing, offsetSide,   // オフセット（面の内外 / 線の輪郭化）
    inRings,                           // even-odd内外（面の当たり判定）
    identity, translate, scaleMat, mul, apply, invert, fromFrac, isOrthogonal, det2,
  };
})();
