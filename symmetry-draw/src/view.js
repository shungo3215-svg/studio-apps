/* view.js — 展開の版面（SVG 1枚）。モチーフを <g id="motif"> に1つ描き、コピーは <use> で並べる。
   座標は版面座標（W×H）。画面の位置との変換と、表示の拡大縮小・移動（viewBox）はここだけが持つ。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var GUIDE = 'fill="none" stroke="#8A8A8A" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"';
  var SEL = 'fill="none" stroke="#1E90FF" stroke-width="1.5" vector-effect="non-scaling-stroke"';
  var V = SD.view = { W: 480, H: 480, svg: null, vb: { x: 0, y: 0, z: 1 } };
  var Z_MIN = 0.25, Z_MAX = 16;

  function fmt(m) { return m.map(function (v) { return Math.round(v * 1e5) / 1e5; }).join(' '); }
  V.fmt = fmt;

  /* ---- 表示（拡大縮小・移動）。データは変えない ---- */
  V.applyView = function () {
    var b = V.vb;
    V.svg.setAttribute('viewBox', b.x + ' ' + b.y + ' ' + V.W / b.z + ' ' + V.H / b.z);
    SD.emit('view');
  };
  V.resetView = function () { V.vb = { x: 0, y: 0, z: 1 }; V.applyView(); };
  V.rect = function () { return V.svg.getBoundingClientRect(); };
  /* 版面座標 ⇄ 画面。getScreenCTM は使わず、要素の見えている矩形（CSS の変形込み）と viewBox から計算する
     （iPhone の Safari は親の transform を getScreenCTM が無視してずれるため）。
     viewBox は等比で枠に収まる（preserveAspectRatio の meet）ので、余白の分の ox,oy を持つ */
  V.geom = function () {
    var r = V.rect(), b = V.vb, vw = V.W / b.z, vh = V.H / b.z;
    var k = Math.min(r.width / vw, r.height / vh);
    var top = V.mobile ? 0 : 0.5;   // スマホは版面を上に寄せる（xMidYMin）
    return { k: k, ox: r.left + (r.width - vw * k) / 2, oy: r.top + (r.height - vh * k) * top, r: r };
  };
  V.unit = function () { return V.geom().k; };                         // 画面 px / 版面座標 1
  V.toBoard = function (cx, cy) {
    var g = V.geom(), b = V.vb;
    return [b.x + (cx - g.ox) / g.k, b.y + (cy - g.oy) / g.k];
  };
  V.toClient = function (bx, by) {
    var g = V.geom(), b = V.vb;
    return [g.ox + (bx - b.x) * g.k, g.oy + (by - b.y) * g.k];
  };
  /* f 倍に拡大。(cx,cy) は画面の位置で、その下の点を動かさない（省略時は見えている範囲の中心） */
  V.zoomAt = function (f, cx, cy) {
    var g = V.geom(), b = V.vb;
    if (cx == null) { cx = g.r.left + g.r.width / 2; cy = g.r.top + g.r.height / 2; }
    var p = V.toBoard(cx, cy), z = Math.min(Z_MAX, Math.max(Z_MIN, b.z * f));
    b.z = z;
    var g2 = V.geom();   // z が変わった後の等比と余白
    b.x = p[0] - (cx - g2.ox) / g2.k;
    b.y = p[1] - (cy - g2.oy) / g2.k;
    V.applyView();
  };
  V.panBy = function (dx, dy) {
    var k = V.unit(), b = V.vb;
    b.x -= dx / k; b.y -= dy / k;
    V.applyView();
  };

  V.init = function (svg) {
    V.svg = svg;
    V.mobile = document.documentElement.classList.contains('studio-mobile');
    if (V.mobile) svg.setAttribute('preserveAspectRatio', 'xMidYMin meet'); V.applyView(); V.render(); };
  V.setSize = function (w, h) {
    V.W = w; V.H = h; V.vb = { x: 0, y: 0, z: 1 };
    document.getElementById('board').style.setProperty('--ar', w / h);
    V.applyView(); V.render();
  };

  /* ---- 補助線（格子・回転の区切り・帯の軸） ---- */
  function guides() {
    var S = SD.state, g = SD.groups.byName[S.group], W = V.W, H = V.H, s = '', i;
    function line(x0, y0, x1, y1) { return '<path ' + GUIDE + ' d="M' + x0 + ' ' + y0 + 'L' + x1 + ' ' + y1 + '"/>'; }
    var big = (W + H) * 2;
    if (g.kind === 'wallpaper') {
      SD.layout.applyParams();
      var B = Groups.basis(Groups.TABLE[S.group].lattice), v1 = [B[0], B[2]], v2 = [B[1], B[3]];
      var n = Math.min(80, Math.ceil((W + H) / S.params.gap) + 3);
      [[v1, v2], [v2, v1]].forEach(function (pair) {
        var d = pair[0], o = pair[1], len = Math.hypot(d[0], d[1]);
        for (i = -n; i <= n; i++) {
          var px = o[0] * i, py = o[1] * i;
          s += line(px - d[0] / len * big, py - d[1] / len * big, px + d[0] / len * big, py + d[1] / len * big);
        }
      });
    } else if (g.kind === 'frieze') {
      s += line(0, H / 2, W, H / 2);
      for (i = 0; i * S.params.gap <= W; i++) s += line(i * S.params.gap, 0, i * S.params.gap, H);
    } else {
      var k = +S.group.slice(1), cx = W / 2, cy = H / 2, rays = S.group[0] === 'D' ? 2 * k : k;
      for (i = 0; i < rays; i++) {
        var a = 2 * Math.PI * i / rays;
        s += line(cx, cy, cx + Math.cos(a) * big, cy + Math.sin(a) * big);
      }
    }
    return '<g id="guides" pointer-events="none">' + s + '</g>';
  }

  function motifHtml() {
    var s = '';
    SD.state.items.forEach(function (it) { s += SD.path.itemSvg(it); });
    return s + '<g id="draft"></g>';
  }

  /* ---- 全部を描き直す（図形・群・展開の設定・版面の大きさが変わった時） ---- */
  V.render = function () {
    if (!V.svg) return;
    var L = SD.layout.get(), s = '';
    if (SD.prefs.bg !== 'none') s += '<rect x="0" y="0" width="' + V.W + '" height="' + V.H + '" fill="' + SD.prefs.bg + '" pointer-events="none"/>';
    s += '<defs><g id="motif">' + motifHtml() + '</g></defs><clipPath id="boardClip"><rect x="0" y="0" width="' + V.W + '" height="' + V.H + '"/></clipPath><g id="copies" clip-path="url(#boardClip)">';
    L.mats.forEach(function (m) { s += '<use href="#motif" transform="matrix(' + fmt(m) + ')"/>'; });
    s += '</g>';
    if (SD.prefs.guides) s += guides();
    s += '<rect x="0" y="0" width="' + V.W + '" height="' + V.H + '" fill="none" stroke="#D1D0CD" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>';
    s += '<g id="selOv" pointer-events="none"></g><g id="boxOv" pointer-events="none"></g><g id="toolOv" pointer-events="none"></g><g id="snapOv" pointer-events="none"></g>';
    V.svg.innerHTML = s;
    V.drawSelection();
    if (SD.tools && SD.tools.refreshOverlay) SD.tools.refreshOverlay();
  };
  /* 図形の中身だけ更新（ドラッグ中。コピーの並びは変わらない） */
  V.live = function () {
    var m = V.svg.querySelector('#motif');
    if (m) m.innerHTML = motifHtml();
    V.drawSelection();
    if (SD.tools && SD.tools.refreshOverlay) SD.tools.refreshOverlay();
  };

  /* 描きかけの図形: モチーフの中に入れるので、全コピーへその場で出る */
  V.setDraft = function (svgString) {
    var d = V.svg.querySelector('#draft');
    if (d) d.innerHTML = svgString || '';
  };
  function setIn(id, html) { var o = V.svg.querySelector('#' + id); if (o) o.innerHTML = html || ''; }
  V.setToolOverlay = function (h) { setIn('toolOv', h); };   // ペンのアンカーなど、コピー1つだけに出す印
  V.setBoxOverlay = function (h) { setIn('boxOv', h); };     // 選択の枠・ダイレクト選択の点
  /* 吸着した位置の印（版面座標）。null で消す */
  V.setSnapMark = function (p) {
    if (!p) { setIn('snapOv', ''); return; }
    var r = 5 / V.unit();
    setIn('snapOv', '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '" fill="none" stroke="#E5007E" stroke-width="1.5" vector-effect="non-scaling-stroke"/>');
  };
  /* 選んだ図形の輪郭を、全コピーに重ねる */
  V.drawSelection = function () {
    var o = V.svg.querySelector('#selOv');
    if (!o) return;
    var S = SD.state, L = SD.layout.get(), s = '';
    if (S.sel.length) {
      var paths = S.items.filter(function (it) { return S.sel.indexOf(it.id) >= 0; })
        .map(function (it) { return '<path ' + SEL + ' d="' + SD.path.toD(it.nodes, it.closed) + '"/>'; }).join('');
      L.mats.forEach(function (m) { s += '<g transform="matrix(' + fmt(m) + ')">' + paths + '</g>'; });
    }
    o.innerHTML = s;
  };

  SD.on(function (kind) {
    if (kind === 'change') V.render();
    else if (kind === 'sel') { V.drawSelection(); if (SD.tools && SD.tools.refreshOverlay) SD.tools.refreshOverlay(); }
  });
})();
