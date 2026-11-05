/* tools/index.js — 道具の登録と、版面でのポインター操作の受け渡し（表示の移動・拡大縮小もここ）。
   新しい道具は tools/ に1ファイル作って SD.tools.register するだけ。
   道具は { name, label, key, icon, cursor, down(c), move(c,isDown), up(c), cancel(), finish(), busy(), undoStep(), overlay(), del() } のうち要るものを持つ。
   c = { b:[版面座標x,y], shift, alt, e, unit } */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var T = SD.tools = { map: {}, order: [], current: 'pencil' };

  T.register = function (t) { T.map[t.name] = t; T.order.push(t.name); };
  T.cur = function () { return T.map[T.current]; };
  T.set = function (name) {
    if (!T.map[name] || name === T.current) return T.current;
    var prev = T.cur();
    if (prev && prev.finish) prev.finish();
    T.current = name;
    if (SD.state.selPts.length) SD.state.selPts = [];
    if (SD.view.svg) SD.view.svg.style.cursor = T.map[name].cursor || 'crosshair';
    SD.view.setSnapMark(null);
    SD.emit('tool');
    return T.current;
  };

  /* 指（touch）で押す時は、点や枠を押せる範囲を広げる（指は 7px の点に当たらない） */
  T.reach = function (c, px) { return c && c.e && c.e.pointerType === 'touch' ? px * 2.4 : px; };

  /* 掴んだコピー: 描き始めに決め、描き終えるまで同じコピーの向きで描く */
  T.grabIndex = function (i) {
    var L = SD.layout.get();
    return {
      i: i, M: L.mats[i], inv: L.inv[i], scale: L.scale,
      local: function (p) { return Geom.apply(L.inv[i], p[0], p[1]); },
      board: function (x, y) { return Geom.apply(L.mats[i], x, y); },
      /* 版面での移動量 → モチーフ座標での移動量 */
      vec: function (d) { var m = L.inv[i]; return [m[0] * d[0] + m[2] * d[1], m[1] * d[0] + m[3] * d[1]]; }
    };
  };
  T.grab = function (b) { return T.grabIndex(SD.layout.pick(b[0], b[1])); };

  /* 画面の reachPx 以内にある図形を、全コピーの中から探す（上の図形から）。{item, i} か null */
  T.hitAt = function (b, reachPx) {
    var L = SD.layout.get(), items = SD.state.items, tol = reachPx / (SD.view.unit() * L.scale);
    for (var k = items.length - 1; k >= 0; k--) {
      var best = -1, bd = Infinity;
      for (var i = 0; i < L.inv.length; i++) {
        var p = Geom.apply(L.inv[i], b[0], b[1]);
        if (!SD.path.hit(items[k], p[0], p[1], tol)) continue;
        // 重なったコピーのどれも触れている時は、モチーフ範囲の中心が押した点にいちばん近いコピー（描き始めと同じ決め方）
        var d = Math.hypot(L.centers[i][0] - b[0], L.centers[i][1] - b[1]);
        if (d < bd - 1e-6) { bd = d; best = i; }
      }
      if (best >= 0) return { item: items[k], i: best };
    }
    return null;
  };

  /* 次に描く物の見た目。閉じた図形だけ塗る。見えない組み合わせは作らない */
  T.style = function (closed) {
    var P = SD.prefs, fill = closed ? P.fill : 'none', stroke = P.stroke;
    if (fill === 'none' && stroke === 'none') stroke = SD.NAVY;
    return { closed: closed, fill: fill, stroke: stroke, sw: P.sw, opacity: P.opacity };
  };
  T.draftSvg = function (nodes, closed) {
    var st = T.style(closed);
    return SD.path.itemSvg({ nodes: nodes, closed: closed, fill: st.fill, stroke: st.stroke, sw: st.sw, opacity: st.opacity });
  };
  T.commitShape = function (nodes, closed) {
    var st = T.style(closed);
    SD.addItem({ closed: closed, nodes: nodes, fill: st.fill, stroke: st.stroke, sw: st.sw, opacity: st.opacity });
    SD.view.setDraft(''); SD.view.setToolOverlay(''); SD.view.setSnapMark(null);
    SD.commit();
  };

  /* キーから呼ばれる口 */
  T.enter = function () { var t = T.cur(); if (t && t.finish) t.finish(); };
  T.undoStep = function () { var t = T.cur(); return !!(t && t.undoStep && t.undoStep()); };
  /* Esc: 途中の操作 → 選んだ点 → 選択 の順に1段ずつ */
  T.escape = function () {
    var t = T.cur(), S = SD.state;
    if (t && t.busy && t.busy()) { t.finish(); return true; }
    if (S.selPts.length) { S.selPts = []; SD.emit('sel'); return true; }
    if (S.sel.length) { S.sel = []; SD.emit('sel'); return true; }
    return false;
  };
  T.deleteSelected = function () {
    var S = SD.state, t = T.cur();
    if (t && t.del && t.del()) return;
    if (!S.sel.length) return;
    SD.removeIds(S.sel.slice()); SD.commit(); SD.emit('sel');
  };
  T.refreshOverlay = function () {
    var t = T.cur();
    if (SD.view.svg) SD.view.setBoxOverlay(t && t.overlay ? t.overlay() : '');
  };
  SD.on(function (kind) { if (kind === 'tool' || kind === 'view') T.refreshOverlay(); });

  /* 版面のポインター（マウス・指・ペン共通）。Space を押している間と、トラックパッドのスクロール・ピンチは表示の移動・拡大縮小 */
  T.attach = function (svg) {
    var downId = null, spaceDown = false, panning = null;
    function ctx(e) { return { e: e, b: SD.view.toBoard(e.clientX, e.clientY), shift: e.shiftKey, alt: e.altKey, unit: SD.view.unit() }; }
    function typing(t) { return t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|color)$/.test(t.type))); }
    function restoreCursor() { svg.style.cursor = spaceDown ? 'grab' : (T.cur().cursor || 'crosshair'); }
    // Space を押しているかを知るためだけの監視（キーの割り当ては Studio.keys）
    window.addEventListener('keydown', function (e) { if (e.code === 'Space' && !typing(e.target)) { spaceDown = true; restoreCursor(); } });
    window.addEventListener('keyup', function (e) { if (e.code === 'Space') { spaceDown = false; restoreCursor(); } });
    window.addEventListener('blur', function () { spaceDown = false; restoreCursor(); });

    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || downId !== null) return;
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch (x) { /* 取れなくても描ける */ }
      if (spaceDown) { downId = e.pointerId; panning = { x: e.clientX, y: e.clientY }; svg.style.cursor = 'grabbing'; return; }
      var t = T.cur(); if (!t || !t.down) return;
      downId = e.pointerId;
      t.down(ctx(e));
    });
    svg.addEventListener('pointermove', function (e) {
      if (panning) {
        if (e.pointerId === downId) { SD.view.panBy(e.clientX - panning.x, e.clientY - panning.y); panning.x = e.clientX; panning.y = e.clientY; }
        return;
      }
      var t = T.cur(); if (!t || !t.move) return;
      if (downId !== null && e.pointerId !== downId) return;
      t.move(ctx(e), downId !== null);
    });
    function end(e, cancel) {
      if (downId === null || e.pointerId !== downId) return;
      downId = null;
      if (panning) { panning = null; restoreCursor(); return; }
      var t = T.cur(); if (!t) return;
      if (cancel) { if (t.cancel) t.cancel(); } else if (t.up) t.up(ctx(e));
    }
    svg.addEventListener('pointerup', function (e) { end(e, false); });
    svg.addEventListener('pointercancel', function (e) { end(e, true); });
    svg.addEventListener('dragstart', function (e) { e.preventDefault(); });
    // トラックパッド: 2本指のスクロール＝移動・ピンチ（⌘＋スクロールも）＝拡大縮小
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) SD.view.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else SD.view.panBy(-e.deltaX, -e.deltaY);
    }, { passive: false });
    var gz = 1;   // Safari のピンチ
    svg.addEventListener('gesturestart', function (e) { e.preventDefault(); gz = 1; });
    svg.addEventListener('gesturechange', function (e) { e.preventDefault(); SD.view.zoomAt(e.scale / gz, e.clientX, e.clientY); gz = e.scale; });
  };
})();
