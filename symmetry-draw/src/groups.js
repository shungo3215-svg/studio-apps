/* groups.js — 対称群の定義と展開列挙（展開の唯一の真実）
   壁紙群17種: 分数座標系のテーブル（2x2整数行列M + 分数並進t）を
   格子基底Bでカルテシアンに変換して使う。
   canvas描画とSVG書き出しの両方が instances() だけを消費する。 */
const Groups = (() => {
  "use strict";

  let CELL = 72;                 // セル辺(px)。setParamsで可変（探索パラメータ）
  let MOTIF_SCALE = 0.65;        // モチーフ幅 ≒ セル辺 × これ。setParamsで可変
  const ANCHOR = [0.30, 0.20];   // モチーフ中心の分数座標（一般位置=高対称点を外す）
  const ROSETTE_SCALE = 0.62;    // ロゼットのモチーフ幅 ≒ スワッチ辺 × これ
  const FRIEZE_ANCHOR = [0.30, -0.18];   // フリーズ: 帯軸(y=0)から少し外した一般位置

  /* ==== 壁紙群テーブル（検証済み 2026-07-07） ====
     3系統の独立導出（IT general positions / 生成元合成 / orbifold幾何）が
     17群すべてで完全一致し、数値検証（閉包・位数84・逆元・直交性・
     鏡映/映進の剰余類判別・回転中心×鏡映軸のincidence）と敵対的監査をPASS。
     m: 2x2整数行列 row-major [m00,m01,m10,m11]（分数座標に作用）
     t: 分数並進 [tx,ty] ∈ [0,1)
     cm/cmm は conventional 長方形セル + センタリング並進(+1/2,+1/2)込み。
     hex は γ=120° 規約（v2 = (-1/2, √3/2)）。原点はIT標準（回転中心上）。
     p3m1: 鏡映軸が格子ベクトルに垂直（全3回中心が軸上）
     p31m: 鏡映軸が格子ベクトルに沿う（軸上にない3回中心あり）
     p4g : 鏡映は対角2方向のみ（4回中心は軸上にない）、軸平行は映進 */
  const E = { m: [1, 0, 0, 1], t: [0, 0] };
  const op = (m, t = [0, 0]) => ({ m, t });

  // 正方格子の回転・鏡映
  const R4 = [E, op([0, -1, 1, 0]), op([-1, 0, 0, -1]), op([0, 1, -1, 0])];
  const MIR4 = [op([-1, 0, 0, 1]), op([1, 0, 0, -1]), op([0, 1, 1, 0]), op([0, -1, -1, 0])];
  // 六方格子の回転（γ=120°基底での整数行列）
  const R60 = [1, -1, 1, 0], R120 = [0, -1, 1, -1], R240 = [-1, 1, -1, 0], R300 = [0, 1, -1, 1];
  // 六方格子の鏡映2族: p3m1族（3回中心が全て軸上）/ p31m族（軸外の3回中心あり）
  const M_P3M1 = [op([0, -1, -1, 0]), op([1, 0, 1, -1]), op([-1, 1, 0, 1])];
  const M_P31M = [op([0, 1, 1, 0]), op([-1, 0, -1, 1]), op([1, -1, 0, -1])];

  const centered = ops => [...ops, ...ops.map(o => op(o.m, [(o.t[0] + 0.5) % 1, (o.t[1] + 0.5) % 1]))];

  const TABLE = {
    p1:   { lattice: "oblique", ops: [E] },
    p2:   { lattice: "oblique", ops: [E, op([-1, 0, 0, -1])] },
    pm:   { lattice: "rect", ops: [E, op([-1, 0, 0, 1])] },
    pg:   { lattice: "rect", ops: [E, op([-1, 0, 0, 1], [0, 0.5])] },
    cm:   { lattice: "centered-rect", ops: centered([E, op([-1, 0, 0, 1])]) },
    pmm:  { lattice: "rect", ops: [E, op([-1, 0, 0, 1]), op([1, 0, 0, -1]), op([-1, 0, 0, -1])] },
    pmg:  { lattice: "rect", ops: [E, op([-1, 0, 0, -1]), op([1, 0, 0, -1], [0.5, 0]), op([-1, 0, 0, 1], [0.5, 0])] },
    pgg:  { lattice: "rect", ops: [E, op([-1, 0, 0, -1]), op([1, 0, 0, -1], [0.5, 0.5]), op([-1, 0, 0, 1], [0.5, 0.5])] },
    cmm:  { lattice: "centered-rect", ops: centered([E, op([-1, 0, 0, 1]), op([1, 0, 0, -1]), op([-1, 0, 0, -1])]) },
    p4:   { lattice: "square", ops: R4 },
    p4m:  { lattice: "square", ops: [...R4, ...MIR4] },
    p4g:  { lattice: "square", ops: [...R4, ...MIR4.map(o => op(o.m, [0.5, 0.5]))] },
    p3:   { lattice: "hex", ops: [E, op(R120), op(R240)] },
    p3m1: { lattice: "hex", ops: [E, op(R120), op(R240), ...M_P3M1] },
    p31m: { lattice: "hex", ops: [E, op(R120), op(R240), ...M_P31M] },
    p6:   { lattice: "hex", ops: [E, op(R60), op(R120), op([-1, 0, 0, -1]), op(R240), op(R300)] },
    p6m:  { lattice: "hex", ops: [E, op(R60), op(R120), op([-1, 0, 0, -1]), op(R240), op(R300), ...M_P3M1, ...M_P31M] },
  };

  const WALLPAPER_ORDER = ["p1", "p2", "pm", "pg", "cm", "pmm", "pmg", "pgg", "cmm", "p4", "p4m", "p4g", "p3", "p3m1", "p31m", "p6", "p6m"];
  const EXPECTED_ORDER = { p1: 1, p2: 2, pm: 2, pg: 2, cm: 4, pmm: 4, pmg: 4, pgg: 4, cmm: 8, p4: 4, p4m: 8, p4g: 8, p3: 3, p3m1: 6, p31m: 6, p6: 6, p6m: 12 };
  const FAVORITES = ["pgg", "p4", "p3", "cmm"];   // 制作者のお気に入り（DIALOGUE Q5）。ライブ集中ビューの既定

  /* ==== フリーズ群テーブル（検証済み 2026-07-10） ====
     2系統独立導出の完全一致＋数値監査PASS（閉包・位数17・帯軸保存m10=0・鏡映/映進判別・非同型性）。
     帯軸=x軸(y=0)、並進はx方向の周期1のみ。tx∈{0,1/2}、tyは常に0。
     名称はConway。IUC対応: hop=p111 / step=p1a1 / sidle=pm11 /
     spinning hop=p112 / spinning sidle=pma2(鏡映線はx=1/4に立つ) / jump=p1m1 / spinning jump=pmm2 */
  const FRIEZE_TABLE = {
    "hop":            [E],
    "step":           [E, op([1, 0, 0, -1], [0.5, 0])],
    "sidle":          [E, op([-1, 0, 0, 1])],
    "spinning hop":   [E, op([-1, 0, 0, -1])],
    "spinning sidle": [E, op([-1, 0, 0, -1]), op([1, 0, 0, -1], [0.5, 0]), op([-1, 0, 0, 1], [0.5, 0])],
    "jump":           [E, op([1, 0, 0, -1])],
    "spinning jump":  [E, op([-1, 0, 0, -1]), op([1, 0, 0, -1]), op([-1, 0, 0, 1])],
  };
  const FRIEZE_ORDER = ["hop", "step", "sidle", "spinning hop", "spinning sidle", "jump", "spinning jump"];
  const FRIEZE_EXPECTED = { "hop": 1, "step": 2, "sidle": 2, "spinning hop": 2, "spinning sidle": 4, "jump": 2, "spinning jump": 4 };

  /* ==== ロゼット群（C=回転のみ / D=回転+鏡映。v2_1プロトタイプの拡充を反映） ==== */
  const mkRosette = name => {
    const n = +name.slice(1), mats = [];
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n, c = Math.cos(a), s = Math.sin(a);
      mats.push([c, s, -s, c, 0, 0]);
      if (name[0] === "D") mats.push([-c, -s, -s, c, 0, 0]);  // 鏡映(x反転)→回転
    }
    return { name, mats };
  };
  const ROSETTES_C = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => mkRosette("C" + n));
  const ROSETTES_D = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => mkRosette("D" + n));
  const ROSETTES = [...ROSETTES_C, ...ROSETTES_D];   // 後方互換（選択復元等）

  /* ==== カスタム群: 生成元（回転n/鏡映/映進/並進）→ 有界閉包（2026-07-11） ====
     生成元はスワッチ中心を原点にした正規化空間（辺=1）で作用する2x3行列。
     閉包はBFS: 生成元（と逆元）を掛けて新しい元を集める。並進を含む群は無限なので
     |並進| ≤ CUSTOM_BOUND で打ち切り（ビュー対角+モチーフ半径をカバーする範囲）、
     さらに CUSTOM_CAP 個で強制打ち切り（発散する組み合わせ＝非結晶的な組も許す設計）。
     gen: {type:"rot",n,at?} | {type:"mirror",deg} | {type:"glide",deg,d} | {type:"trans",deg,d}
     d は「スワッチ辺に対する比」（サイズが変わっても密度が同じに見える）
     at:[x,y]（回転のみ・省略時は原点=軸）は回転中心のオフセット。**2つの中心を持つ群**が作れる
     ＝ 中心の違う180°回転2つの合成が並進になるので、生成元を並べるだけで帯や格子が生まれる。 */
  const CUSTOM_CAP = 600;
  const CUSTOM_BOUND = 1.25;

  const inv23 = m => {   // 2x3アフィンの逆行列
    const det = m[0] * m[3] - m[1] * m[2];
    const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
    return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
  };

  function genMats(gen) {
    const rad = deg => deg * Math.PI / 180;
    if (gen.type === "rot") {
      const a = 2 * Math.PI / gen.n, c = Math.cos(a), s = Math.sin(a);
      if (!gen.at) return [[c, s, -s, c, 0, 0]];   // 原点（=軸）まわり。有限位数なので逆元は累乗で出る
      /* 別の中心 p まわりの回転 = T(p)∘R∘T(−p)。これが「2つの回転体を組み合わせる」の核心で、
         2つの中心の180°回転を並べると合成が並進になる（＝帯や格子が生まれる）。
         BOUNDで打ち切られると累乗で逆元に届かないことがあるので逆元も渡す。 */
      const px = gen.at[0], py = gen.at[1];
      const m = [c, s, -s, c, px - (c * px - s * py), py - (s * px + c * py)];
      return [m, inv23(m)];
    }
    if (gen.type === "mirror") {   // 原点を通る角度degの直線での鏡映（自己逆元）
      const c = Math.cos(2 * rad(gen.deg)), s = Math.sin(2 * rad(gen.deg));
      return [[c, s, s, -c, 0, 0]];
    }
    if (gen.type === "glide") {    // 鏡映＋軸方向への並進（逆元も渡す）
      const a = rad(gen.deg), c = Math.cos(2 * a), s = Math.sin(2 * a);
      const m = [c, s, s, -c, Math.cos(a) * gen.d, Math.sin(a) * gen.d];
      return [m, inv23(m)];
    }
    if (gen.type === "trans") {    // 並進（逆元も渡す）
      const dx = Math.cos(rad(gen.deg)) * gen.d, dy = Math.sin(rad(gen.deg)) * gen.d;
      return [[1, 0, 0, 1, dx, dy], [1, 0, 0, 1, -dx, -dy]];
    }
    return [];
  }

  const opKey = m => m.map(v => Math.round(v * 1e4)).join(",");   // 数値誤差を吸収する同一判定

  function customClosure(gens) {
    const gm = (gens || []).flatMap(genMats);
    const ops = [[1, 0, 0, 1, 0, 0]];
    const seen = new Set([opKey(ops[0])]);
    let capped = false;
    for (let i = 0; i < ops.length && !capped; i++) {
      for (const g of gm) {
        const m = Geom.mul(g, ops[i]);
        if (Math.hypot(m[4], m[5]) > CUSTOM_BOUND) continue;   // 届く範囲の外は列挙しない
        const k = opKey(m);
        if (seen.has(k)) continue;
        seen.add(k); ops.push(m);
        if (ops.length >= CUSTOM_CAP) { capped = true; break; }
      }
    }
    return { ops, capped };
  }

  const customCache = new WeakMap();   // def → closure（defは不変。編集時は新オブジェクト）
  function customOps(def) {
    let c = customCache.get(def);
    if (!c) { c = customClosure(def.gens); customCache.set(def, c); }
    return c;
  }
  const customInfo = def => { const c = customOps(def); return { order: c.ops.length, capped: c.capped }; };

  function instancesCustom(def, size, sizeH, motif) {
    const S = Math.min(size, sizeH);
    const out = [];
    for (const m of customOps(def).ops) {
      const inst = [m[0], m[1], m[2], m[3], m[4] * S + size / 2, m[5] * S + sizeH / 2];   // 並進を実寸へ・ビュー中央基準
      const [x, y] = Geom.apply(inst, motif.cx, motif.cy);
      if (x < -motif.r || x > size + motif.r || y < -motif.r || y > sizeH + motif.r) continue;
      out.push(inst);
    }
    return out;
  }

  /* ==== 格子基底（カルテシアン, px） ==== */
  function basis(lattice) {
    if (lattice === "hex") return [CELL, -CELL / 2, 0, CELL * Math.sqrt(3) / 2];  // row-major、列=v1,v2
    return [CELL, 0, 0, CELL];
  }

  /* ==== セル内操作のカルテシアン変換（キャッシュ） ==== */
  const cellOpsCache = {};
  function cellOps(name) {
    if (!cellOpsCache[name]) {
      const g = TABLE[name], B = basis(g.lattice);
      cellOpsCache[name] = g.ops.map(o => Geom.fromFrac(o.m, o.t, B));
    }
    return cellOpsCache[name];
  }

  /* ==== モチーフ配置（パッド座標→セル座標。スケールはここに焼き込む） ==== */
  function placementWallpaper(padW, lattice) {
    const B = basis(lattice);
    const s = CELL * MOTIF_SCALE / padW;
    const ax = B[0] * ANCHOR[0] + B[1] * ANCHOR[1];
    const ay = B[2] * ANCHOR[0] + B[3] * ANCHOR[1];
    // translate(anchor) ∘ scale(s) ∘ translate(-padW/2)
    return { mat: Geom.mul(Geom.translate(ax, ay), Geom.mul(Geom.scaleMat(s), Geom.translate(-padW / 2, -padW / 2))), scale: s };
  }
  let ROSETTE_CENTER = null;   // 回転対称の中心（パッド座標）。null=パッド中心。axisツールで変更
  let ROWS = false;            // 帯（フリーズ）を縦に CELL ごと展開面いっぱいに重ねるか。既定 false＝従来の1列。setParams で変える（画面・SVG・PNG・スワッチは layout 経由で同じ）
  function placementRosette(padW, sw) {
    const s = sw * ROSETTE_SCALE / padW;
    const cx = ROSETTE_CENTER ? ROSETTE_CENTER[0] : padW / 2;
    const cy = ROSETTE_CENTER ? ROSETTE_CENTER[1] : padW / 2;
    return { mat: Geom.mul(Geom.scaleMat(s), Geom.translate(-cx, -cy)), scale: s };
  }

  /* ==== 展開列挙: 1スワッチ分の等長変換（2x3行列）の完全リスト ====
     motif = {cx, cy, r}: セル座標系でのモチーフ中心と外接半径（カリング用） */
  function instancesWallpaper(name, viewW, viewH, motif) {
    const g = TABLE[name], B = basis(g.lattice), ops = cellOps(name);
    const det = B[0] * B[3] - B[1] * B[2];
    const inv = [B[3] / det, -B[1] / det, -B[2] / det, B[0] / det];
    // ビューポート角±半径 を分数座標に逆変換して格子範囲を決める
    let iMin = 1e9, iMax = -1e9, jMin = 1e9, jMax = -1e9;
    for (const [x, y] of [[-motif.r, -motif.r], [viewW + motif.r, -motif.r], [-motif.r, viewH + motif.r], [viewW + motif.r, viewH + motif.r]]) {
      const fi = inv[0] * x + inv[1] * y, fj = inv[2] * x + inv[3] * y;
      iMin = Math.min(iMin, fi); iMax = Math.max(iMax, fi);
      jMin = Math.min(jMin, fj); jMax = Math.max(jMax, fj);
    }
    const out = [];
    // 操作でモチーフ中心はセル原点から最大1セル強ずれるので±2の余裕を取る（copyごとに中心カリングするので過剰列挙は無害）
    for (let i = Math.floor(iMin) - 2; i <= Math.ceil(iMax) + 2; i++) {
      for (let j = Math.floor(jMin) - 2; j <= Math.ceil(jMax) + 2; j++) {
        const ox = B[0] * i + B[1] * j, oy = B[2] * i + B[3] * j;
        for (const m of ops) {
          const [cx, cy] = Geom.apply(m, motif.cx, motif.cy);
          const x = cx + ox, y = cy + oy;
          if (x < -motif.r || x > viewW + motif.r || y < -motif.r || y > viewH + motif.r) continue;
          out.push([m[0], m[1], m[2], m[3], m[4] + ox, m[5] + oy]);
        }
      }
    }
    return out;
  }

  function instancesRosette(def, sw) {
    const c = Geom.translate(sw / 2, sw / 2);
    return def.mats.map(m => Geom.mul(c, m));
  }

  /* ==== フリーズ（帯）: 配置と展開 ====
     帯軸=スワッチの水平中心線。周期=CELL。操作は帯座標(軸原点)で作用し、
     最後に translate(0, viewH/2) で帯をスワッチ中央に置く。 */
  const friezeOpsCache = {};
  function friezeOps(name) {
    if (!friezeOpsCache[name]) {
      const B = [CELL, 0, 0, CELL];   // xの分数→px。Mは対角±1なのでBMB⁻¹=M
      friezeOpsCache[name] = FRIEZE_TABLE[name].map(o => Geom.fromFrac(o.m, o.t, B));
    }
    return friezeOpsCache[name];
  }
  function placementFrieze(padW) {
    const s = CELL * MOTIF_SCALE / padW;
    const ax = FRIEZE_ANCHOR[0] * CELL, ay = FRIEZE_ANCHOR[1] * CELL;
    return { mat: Geom.mul(Geom.translate(ax, ay), Geom.mul(Geom.scaleMat(s), Geom.translate(-padW / 2, -padW / 2))), scale: s };
  }
  /* rows=true: 帯を縦に CELL ごとに並べる（段の並進 j*CELL を足す。帯の操作テーブルは触らない）。既定は ROWS（=false＝従来の1列） */
  function instancesFrieze(name, viewW, viewH, motif, rows = ROWS) {
    const ops = friezeOps(name);
    const out = [];
    const kMin = Math.floor((-motif.r - 2 * CELL) / CELL), kMax = Math.ceil((viewW + motif.r + 2 * CELL) / CELL);
    const jMax = rows ? Math.ceil((viewH / 2 + motif.r + 2 * CELL) / CELL) : 0;
    for (let k = kMin; k <= kMax; k++) {
      const ox = k * CELL;
      for (const m of ops) {
        const [cx, cy] = Geom.apply(m, motif.cx, motif.cy);
        const x = cx + ox;
        if (x < -motif.r || x > viewW + motif.r) continue;
        if (!rows) { out.push([m[0], m[1], m[2], m[3], m[4] + ox, m[5] + viewH / 2]); continue; }   // 帯をスワッチ中央へ
        for (let j = -jMax; j <= jMax; j++) {
          const y = cy + viewH / 2 + j * CELL;
          if (y < -motif.r || y > viewH + motif.r) continue;
          out.push([m[0], m[1], m[2], m[3], m[4] + ox, m[5] + viewH / 2 + j * CELL]);
        }
      }
    }
    return out;
  }

  /* ==== レイアウト（配置+展開）の一元化: canvas描画とSVG書き出しの共通経路 ====
     spec: {kind:"wallpaper", name} | {kind:"frieze", name} | {kind:"rosette", def} | {kind:"custom", def}
     bbox: モチーフのパッド座標bbox（無ければ空リスト）。sizeH: 縦寸（省略=正方） */
  function layout(spec, size, padW, bbox, sizeH = size) {
    if (spec.kind === "wallpaper" || spec.kind === "frieze") {
      const place = spec.kind === "wallpaper"
        ? placementWallpaper(padW, TABLE[spec.name].lattice)
        : placementFrieze(padW);
      if (!bbox) return { place, insts: [] };
      const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
      const r = Math.hypot(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) / 2 * place.scale;
      const [mcx, mcy] = Geom.apply(place.mat, cx, cy);
      const insts = spec.kind === "wallpaper"
        ? instancesWallpaper(spec.name, size, sizeH, { cx: mcx, cy: mcy, r })
        : instancesFrieze(spec.name, size, sizeH, { cx: mcx, cy: mcy, r });
      return { place, insts };
    }
    if (spec.kind === "custom") {   // 配置はロゼットと同じ（axis追従）。展開は有界閉包
      const place = placementRosette(padW, Math.min(size, sizeH));
      if (!bbox) return { place, insts: [] };
      const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
      const r = Math.hypot(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) / 2 * place.scale;
      const [mcx, mcy] = Geom.apply(place.mat, cx, cy);
      return { place, insts: instancesCustom(spec.def, size, sizeH, { cx: mcx, cy: mcy, r }) };
    }
    return { place: placementRosette(padW, Math.min(size, sizeH)), insts: instancesRosette(spec.def, Math.min(size, sizeH)) };
  }

  /* ==== 探索パラメータ（Phase 2）: セルサイズ・断片スケール ====
     カルテシアン変換キャッシュはCELLに依存するため変更時に捨てる */
  function setParams(p = {}) {
    let changed = false;
    if (typeof p.cell === "number" && p.cell > 0 && p.cell !== CELL) { CELL = p.cell; changed = true; }
    if (typeof p.scale === "number" && p.scale > 0 && p.scale !== MOTIF_SCALE) { MOTIF_SCALE = p.scale; changed = true; }
    if (typeof p.rows === "boolean" && p.rows !== ROWS) { ROWS = p.rows; changed = true; }
    if ("center" in p) { ROSETTE_CENTER = p.center || null; changed = true; }   // ロゼット回転中心（キャッシュ無関係）
    if (changed) {
      for (const k in cellOpsCache) delete cellOpsCache[k];
      for (const k in friezeOpsCache) delete friezeOpsCache[k];
    }
    return changed;
  }
  const getParams = () => ({ cell: CELL, scale: MOTIF_SCALE, center: ROSETTE_CENTER, rows: ROWS });

  /* ==== 自己検証: 位数・直交性・閉包（分数座標系で厳密） ==== */
  function selfTest() {
    const problems = [];
    let total = 0;
    for (const name of WALLPAPER_ORDER) {
      const g = TABLE[name];
      total += g.ops.length;
      if (g.ops.length !== EXPECTED_ORDER[name]) problems.push(`${name}: 位数 ${g.ops.length} ≠ ${EXPECTED_ORDER[name]}`);
      // カルテシアンで直交（=剛体変換）か
      for (const m of cellOps(name)) {
        if (!Geom.isOrthogonal(m)) { problems.push(`${name}: 非直交の操作あり（基底規約ミスマッチの疑い）`); break; }
      }
      // 閉包: 任意の2操作の合成 ≡ リスト内のどれか (mod ℤ²)
      const mod1 = v => ((v % 1) + 1) % 1;
      outer:
      for (const a of g.ops) for (const b of g.ops) {
        const m = [
          a.m[0] * b.m[0] + a.m[1] * b.m[2], a.m[0] * b.m[1] + a.m[1] * b.m[3],
          a.m[2] * b.m[0] + a.m[3] * b.m[2], a.m[2] * b.m[1] + a.m[3] * b.m[3],
        ];
        const t = [mod1(a.m[0] * b.t[0] + a.m[1] * b.t[1] + a.t[0]), mod1(a.m[2] * b.t[0] + a.m[3] * b.t[1] + a.t[1])];
        const hit = g.ops.some(o =>
          o.m.every((v, k) => v === m[k]) &&
          Math.min(Math.abs(o.t[0] - t[0]), 1 - Math.abs(o.t[0] - t[0])) < 1e-9 &&
          Math.min(Math.abs(o.t[1] - t[1]), 1 - Math.abs(o.t[1] - t[1])) < 1e-9);
        if (!hit) { problems.push(`${name}: 閉包性が破れている`); break outer; }
      }
    }
    // cm/cmm はセンタリング並進込みなので合計84（原始セル換算では78）
    const expectedTotal = Object.values(EXPECTED_ORDER).reduce((a, b) => a + b, 0);
    if (total !== expectedTotal) problems.push(`全操作数 ${total} ≠ ${expectedTotal}`);

    /* --- フリーズ群: 位数・帯軸保存・直交性・閉包（xはmod 1、yは完全一致） --- */
    let ftotal = 0;
    for (const name of FRIEZE_ORDER) {
      const ops = FRIEZE_TABLE[name];
      ftotal += ops.length;
      if (ops.length !== FRIEZE_EXPECTED[name]) problems.push(`frieze ${name}: 位数 ${ops.length} ≠ ${FRIEZE_EXPECTED[name]}`);
      for (const o of ops) {
        if (o.m[2] !== 0) { problems.push(`frieze ${name}: 帯軸を保存しない操作あり(m10≠0)`); break; }
      }
      for (const m of friezeOps(name)) {
        if (!Geom.isOrthogonal(m)) { problems.push(`frieze ${name}: 非直交の操作あり`); break; }
      }
      const mod1 = v => ((v % 1) + 1) % 1;
      fouter:
      for (const a of ops) for (const b of ops) {
        const m = [
          a.m[0] * b.m[0] + a.m[1] * b.m[2], a.m[0] * b.m[1] + a.m[1] * b.m[3],
          a.m[2] * b.m[0] + a.m[3] * b.m[2], a.m[2] * b.m[1] + a.m[3] * b.m[3],
        ];
        const tx = mod1(a.m[0] * b.t[0] + a.m[1] * b.t[1] + a.t[0]);
        const ty = a.m[2] * b.t[0] + a.m[3] * b.t[1] + a.t[1];   // yは並進なし=完全一致
        const hit = ops.some(o =>
          o.m.every((v, k) => v === m[k]) &&
          Math.min(Math.abs(o.t[0] - tx), 1 - Math.abs(o.t[0] - tx)) < 1e-9 &&
          Math.abs(o.t[1] - ty) < 1e-9);
        if (!hit) { problems.push(`frieze ${name}: 閉包性が破れている`); break fouter; }
      }
    }
    const fExpected = Object.values(FRIEZE_EXPECTED).reduce((a, b) => a + b, 0);   // 17
    if (ftotal !== fExpected) problems.push(`frieze全操作数 ${ftotal} ≠ ${fExpected}`);

    if (problems.length) console.warn("[Groups.selfTest] 失敗:\n" + problems.join("\n"));
    return problems;
  }

  /* ==== カスタム閉包の自己検証（selfTestとは独立。CUSTOM_BOUND/CAP変更時は必ず通す） ==== */
  function customSelfTest() {
    const problems = [];
    // 既知の有限群: 位数が理論値と一致し、打ち切りが発生しないこと
    const finite = [
      { label: "r4+m90=D4", gens: [{ type: "rot", n: 4 }, { type: "mirror", deg: 90 }], order: 8 },
      { label: "r6=C6", gens: [{ type: "rot", n: 6 }], order: 6 },
      { label: "m0+m45=D4", gens: [{ type: "mirror", deg: 0 }, { type: "mirror", deg: 45 }], order: 8 },
    ];
    for (const c of finite) {
      const { ops, capped } = customClosure(c.gens);
      if (ops.length !== c.order || capped)
        problems.push(`custom ${c.label}: 位数 ${ops.length} ≠ ${c.order}${capped ? "（capped）" : ""}`);
    }
    // 有限群の厳密性: 全操作が直交（等長）で、任意の2操作の合成がリスト内にあること
    const d4 = customClosure(finite[0].gens).ops;
    for (const m of d4) if (!Geom.isOrthogonal(m)) { problems.push("custom: 非直交の操作あり"); break; }
    const seen = new Set(d4.map(opKey));
    outer:
    for (const a of d4) for (const b of d4)
      if (!seen.has(opKey(Geom.mul(a, b)))) { problems.push("custom: 閉包性が破れている"); break outer; }
    // 並進1本: BOUNDで自然に止まる（±3〜4歩 → 7個前後）。発散組: CAPで打ち切られる
    const tr = customClosure([{ type: "trans", deg: 0, d: 0.35 }]);
    if (tr.capped || tr.ops.length < 5 || tr.ops.length > 9)
      problems.push(`custom: 並進1本の列挙数が異常 (${tr.ops.length})`);
    const div = customClosure([{ type: "rot", n: 5 }, { type: "trans", deg: 0, d: 0.35 }]);
    if (!div.capped || div.ops.length !== CUSTOM_CAP)
      problems.push("custom: 発散する組がCAPで打ち切られていない");

    /* ==== 中心オフセットつき回転（2つの回転体の組み合わせ）====
       ①単体では位数が変わらない ②固定点が at と一致する（S4のsymSnapと同じ導出）
       ③中心の違うC2を2つ並べると合成が並進になり、フリーズ（帯）相当が生まれる */
    const off = customClosure([{ type: "rot", n: 4, at: [0.25, 0.25] }]);
    if (off.ops.length !== 4 || off.capped)
      problems.push(`custom 中心ずれC4: 位数 ${off.ops.length} ≠ 4${off.capped ? "（capped）" : ""}`);
    for (const m of off.ops) if (!Geom.isOrthogonal(m)) { problems.push("custom 中心ずれ: 非直交の操作あり"); break; }
    {   // 固定点 (I−L)⁻¹t が at に一致（恒等以外の全操作で）
      let bad = 0;
      for (const m of off.ops) {
        const det = (1 - m[0]) * (1 - m[3]) - m[2] * m[1];
        if (Math.abs(det) < 1e-9) continue;   // 恒等は固定点が定まらない
        const fx = ((1 - m[3]) * m[4] + m[2] * m[5]) / det;
        const fy = (m[1] * m[4] + (1 - m[0]) * m[5]) / det;
        if (Math.hypot(fx - 0.25, fy - 0.25) > 1e-6) bad++;
      }
      if (bad) problems.push(`custom 中心ずれC4: 固定点がatと一致しない操作が ${bad} 個`);
    }
    {   // C2@原点 × C2@(0.25,0) → 並進0.5が生成され、BOUND=1.25で k∈−2..2 の帯（回転側5＋並進5=10）
      const two = customClosure([{ type: "rot", n: 2 }, { type: "rot", n: 2, at: [0.25, 0] }]);
      const pureTrans = two.ops.filter(m =>
        Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.hypot(m[4], m[5]) > 1e-6);
      if (!pureTrans.length) problems.push("custom 2中心C2: 合成が並進になっていない（フリーズが生まれない）");
      else if (Math.abs(Math.min(...pureTrans.map(m => Math.hypot(m[4], m[5]))) - 0.5) > 1e-6)
        problems.push("custom 2中心C2: 最短並進が 2×中心間距離(0.5) になっていない");
      if (two.capped) problems.push("custom 2中心C2: BOUNDで止まるべきところがCAPで打ち切られた");
      if (two.ops.length !== 10) problems.push(`custom 2中心C2: 位数 ${two.ops.length} ≠ 10`);
      const seen2 = new Set(two.ops.map(opKey));   // 打ち切り範囲内での閉包性
      let broke = 0;
      for (const a of two.ops) for (const b of two.ops) {
        const m = Geom.mul(a, b);
        if (Math.hypot(m[4], m[5]) <= CUSTOM_BOUND && !seen2.has(opKey(m))) broke++;
      }
      if (broke) problems.push(`custom 2中心C2: 範囲内で閉包性が破れている（${broke}組）`);
    }
    // 既存def（atなし）が無改修で同じ結果になること＝後方互換
    if (customClosure([{ type: "rot", n: 6 }]).ops.length !== 6)
      problems.push("custom: atなしの回転で結果が変わった（後方互換が壊れた）");
    if (problems.length) console.warn("[Groups.customSelfTest] 失敗:\n" + problems.join("\n"));
    return problems;
  }

  return {
    ANCHOR,
    TABLE, WALLPAPER_ORDER, FAVORITES, ROSETTES, ROSETTES_C, ROSETTES_D,
    FRIEZE_TABLE, FRIEZE_ORDER,
    basis, cellOps, placementWallpaper, placementRosette, placementFrieze,
    instancesWallpaper, instancesRosette, instancesFrieze, layout, selfTest, customSelfTest,
    setParams, getParams,
    customClosure, customInfo,   // カスタム群（生成元→有界閉包）。layoutはkind:"custom"で消費
    CUSTOM_CAP,
  };
})();
