/* ============================================================================
   profile.js — 「幅のグラフ」パネルの純関数群（DOM非依存）。
   段2機能: 任意の起点(t0)・向きから弧長を測り直し、柱（幅ポイントのt）を
   アンカーごと／等間隔で並べ、規則（交互・波・だんだん・すべて同じ）で
   一括の幅を作る。呼び出し側（index.html）は戻り値のtをそのまま
   state.points の t として使い、生成後は個別ハンドルで上書きできる。

   概念:
   - 絶対t = outline.js の弧長パラメータそのもの（0..1未満、始点=元パスのM点）。
   - 表示t = 起点(t0)・向き(reversed)を反映した「グラフの横軸0%〜100%」。
     reversed=false: disp = mod(abs - t0, 1)
     reversed=true : disp = mod(t0 - abs, 1)
   - 柱は「表示t昇順」で並べて規則を適用する（交互・波・だんだんは順序が意味を持つ）。
   ========================================================================== */
(function (root, factory) {
  var Profile = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Profile;
  if (root) root.Profile = Profile;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mod1(x) { x = x % 1; if (x < 0) x += 1; return x; }

  function toDisplayT(t, t0, reversed) {
    return reversed ? mod1(t0 - t) : mod1(t - t0);
  }
  function toAbsoluteT(disp, t0, reversed) {
    return reversed ? mod1(t0 - disp) : mod1(t0 + disp);
  }

  // 等間隔n本の柱。表示t = 0, 1/n, 2/n, … の絶対t版。表示t昇順で返る。
  function evenTs(n, t0, reversed) {
    n = Math.max(1, Math.round(n));
    var out = [];
    for (var i = 0; i < n; i++) out.push(toAbsoluteT(i / n, t0, reversed));
    return out;
  }

  // 元パスのアンカーポイント（各セグメントの始点）を柱にする。表示t昇順で返る。
  // Outline は呼び出し側（index.html／test）から渡す（循環依存を避けるため引数注入）。
  function anchorTs(Outline, segs, tol, maxLineStep, t0, reversed) {
    var ex = Outline.flattenClosedPathEx(segs, tol, maxLineStep);
    var param = Outline.arcLengthParam(ex.pts);
    var abs = ex.vertexIdx.map(function (idx) { return param.ts[idx]; });
    abs.sort(function (a, b) { return toDisplayT(a, t0, reversed) - toDisplayT(b, t0, reversed); });
    return abs;
  }

  function smoothstep(u) { u = u < 0 ? 0 : (u > 1 ? 1 : u); return u * u * (3 - 2 * u); }

  /* 規則で柱ごとの幅（片側・左右対称値）を作る。orderedAbsTs は表示t昇順の絶対t配列。
     name: 'same' | 'alt' | 'wave' | 'ramp'
     opts: { A, B, n }（nは波の周回数。省略時1） */
  function applyRule(name, orderedAbsTs, t0, reversed, opts) {
    opts = opts || {};
    var A = opts.A != null ? opts.A : 4, B = opts.B != null ? opts.B : 4, cycles = opts.n != null ? opts.n : 1;
    return orderedAbsTs.map(function (t, i) {
      var disp = toDisplayT(t, t0, reversed);
      switch (name) {
        case 'alt': return (i % 2 === 0) ? A : B;
        case 'ramp': return A + (B - A) * disp;
        case 'wave': {
          var ratio = (Math.sin(2 * Math.PI * cycles * disp - Math.PI / 2) + 1) / 2;
          return A + (B - A) * ratio;
        }
        case 'same': default: return A;
      }
    });
  }

  /* --- 段4: 補間の切替「なめらか（Bスプライン）」（2026-09-25 ユーザー決定） -----------------
     周期一様3次Bスプライン。柱の値(values[i])を「制御点」として使うが、曲線は制御点を
     通らない（Catmull-Rom＝「柱を通す」との違い）。標準の一様3次Bスプラインブレンド行列を、
     柱の実際のt間隔（不揃いでもよい）で区間を探し、区間内はu(0..1)の一様基底関数で評価する。
     values/ts は同じ長さ・ts昇順（周期ドメイン[0,1)）を仮定。n<3は定義が薄いのでvalues[0]を返す
     （2点以下でBスプラインを名乗るほどの曲線にならないため・呼び出し側はwidthAtSmooth等へ
     フォールバックしてよい）。 --------------------------------------------------------------- */
  function bsplineClosed(values, ts, t) {
    var n = values.length;
    if (!n) return 0;
    if (n < 3) return values[0];
    t = mod1(t);
    var i1 = -1;
    for (var k = 0; k < n; k++) {
      var a = ts[k], b = ts[(k + 1) % n];
      var spanAB = mod1(b - a); if (spanAB < 1e-9) spanAB = 1;
      var da = mod1(t - a);
      if (da <= spanAB + 1e-9) { i1 = k; break; }
    }
    if (i1 === -1) i1 = n - 1;
    var p0 = values[(i1 - 1 + n) % n], p1 = values[i1], p2 = values[(i1 + 1) % n], p3 = values[(i1 + 2) % n];
    var span = mod1(ts[(i1 + 1) % n] - ts[i1]); if (span < 1e-9) span = 1;
    var u = mod1(t - ts[i1]) / span;
    u = Math.max(0, Math.min(1, u));
    var u2 = u * u, u3 = u2 * u;
    var w0 = (1 - u) * (1 - u) * (1 - u);
    var w1 = 3 * u3 - 6 * u2 + 4;
    var w2 = -3 * u3 + 3 * u2 + 3 * u + 1;
    var w3 = u3;
    return (w0 * p0 + w1 * p1 + w2 * p2 + w3 * p3) / 6;
  }

  return {
    mod1: mod1,
    toDisplayT: toDisplayT,
    toAbsoluteT: toAbsoluteT,
    evenTs: evenTs,
    anchorTs: anchorTs,
    applyRule: applyRule,
    smoothstep: smoothstep,
    bsplineClosed: bsplineClosed
  };
});
