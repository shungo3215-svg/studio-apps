/* layout.js — 群の一覧と、コピーごとの行列（展開の行列は Groups.layout() だけから取る）。
   モチーフ座標は一辺 SD.PAD の正方形。版面は W×H の座標（以下「版面座標」）。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  SD.PAD = 280;
  var BOX = { x0: 0, y0: 0, x1: SD.PAD, y1: SD.PAD };

  /* ---- 群の一覧（groups.js の表をそのまま並べる。45種） ---- */
  var list = [], byName = {};
  function add(name, kind, spec, section) {
    var g = { name: name, kind: kind, spec: spec, section: section };
    list.push(g); byName[name] = g;
  }
  Groups.WALLPAPER_ORDER.forEach(function (n) { add(n, 'wallpaper', { kind: 'wallpaper', name: n }, '壁紙'); });
  Groups.FRIEZE_ORDER.forEach(function (n) { add(n, 'frieze', { kind: 'frieze', name: n }, '帯'); });
  Groups.ROSETTES_C.forEach(function (d) { add(d.name, 'rosette', { kind: 'rosette', def: d }, '回転'); });
  Groups.ROSETTES_D.forEach(function (d) { add(d.name, 'rosette', { kind: 'rosette', def: d }, '回転＋鏡'); });
  SD.groups = { list: list, byName: byName, sections: ['壁紙', '帯', '回転', '回転＋鏡'] };

  /* ---- コピーの行列。W,H は版面座標。結果は「基準コピー」が 0 番になる順に並べる ---- */
  var cache = { key: '', value: null };
  function compute(name, params, W, H) {
    var g = byName[name];
    Groups.setParams({ cell: params.gap, scale: SD.scaleOf(params), rows: !!params.rows });
    var laid = Groups.layout(g.spec, W, SD.PAD, BOX, H);
    var shift = null;
    if (g.kind === 'rosette') {   // ロゼットは短辺の正方形の中心に置かれる。版面が正方形でない時は版面の中心へ寄せる
      var sw = Math.min(W, H);
      shift = Geom.translate((W - sw) / 2, (H - sw) / 2);
    }
    var mats = laid.insts.map(function (inst, idx) {
      var m = Geom.mul(inst, laid.place.mat);
      if (shift) m = Geom.mul(shift, m);
      var c = Geom.apply(m, SD.PAD / 2, SD.PAD / 2);
      return { m: m, idx: idx, d: Math.hypot(c[0] - W / 2, c[1] - H / 2), cx: c[0], cy: c[1] };
    });
    mats.sort(function (a, b) { return Math.abs(a.d - b.d) < 1e-6 ? a.idx - b.idx : a.d - b.d; });
    return {
      scale: laid.place.scale,
      mats: mats.map(function (o) { return o.m; }),
      inv: mats.map(function (o) { return Geom.invert(o.m); }),
      centers: mats.map(function (o) { return [o.cx, o.cy]; })
    };
  }
  SD.layout = {
    /* 現在の群・パラメータ・版面の大きさで計算（同じ入力ならキャッシュ） */
    get: function () {
      var S = SD.state, key = [S.group, S.params.gap, S.params.size, S.params.rows, SD.view.W, SD.view.H].join('|');
      if (cache.key !== key) cache = { key: key, value: compute(S.group, S.params, SD.view.W, SD.view.H) };
      return cache.value;
    },
    compute: compute,
    /* Groups の内部状態を今の設定に合わせる（格子の基底を引く前に呼ぶ） */
    applyParams: function () {
      var p = SD.state.params;
      Groups.setParams({ cell: p.gap, scale: SD.scaleOf(p), rows: !!p.rows });
    },
    /* 押した点（版面座標）に、モチーフ範囲の中心が一番近いコピー。同じ距離なら番号の若いほう */
    pick: function (bx, by) {
      var L = SD.layout.get(), best = 0, bd = Infinity;
      for (var i = 0; i < L.centers.length; i++) {
        var d = Math.hypot(L.centers[i][0] - bx, L.centers[i][1] - by);
        if (d < bd - 1e-6) { bd = d; best = i; }
      }
      return best;
    }
  };

  /* ---- 群ボタンの見本。向きの分かる「F」形を各群で展開した小さな図（毎回同じ） ---- */
  var F_PATH = 'M90 60H190V95H125V125H180V160H125V220H90Z';
  SD.layout.thumb = function (name, side) {
    side = side || 44;
    var res = compute(name, { gap: 17, size: 10.5, rows: true }, side, side), s = '';
    res.mats.forEach(function (m) {
      s += '<path transform="matrix(' + m.map(function (v) { return Math.round(v * 1e4) / 1e4; }).join(' ') + ')" d="' + F_PATH + '"/>';
    });
    return '<svg viewBox="0 0 ' + side + ' ' + side + '" aria-hidden="true"><g fill="currentColor">' + s + '</g></svg>';
  };
})();
