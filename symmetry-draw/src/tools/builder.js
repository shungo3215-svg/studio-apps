/* tools/builder.js — シェイプ形成(⇧M): Illustrator のシェイプ形成ツールと同じ動き。対象は展開した全コピーの線。
   クリック: 押した面（線で区切られた最小の領域）を、閉じた塗りの図形にする
   ドラッグ: なぞった面を全部つないで1つの図形にする（1回＝取り消し1回）
   ⌥クリック／⌥ドラッグ: 押した線を、交点から交点までの区間だけ消す
   押す前に、対象の面（⌥なら区間）を薄く表示する。塗りは上部バーの塗りの色（「なし」なら線の色）。 */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, F = SD.faces;
  var ERASE_PX = 6, STEP_PX = 3, HOVER_MAX = 4000;
  var st = null;       // ドラッグ中 { mode:'face'|'erase', grab, faces:[], picked:{key:face}, last, changed }
  var hoverQ = null;   // 次の描画で見せるホバー { b, alt }

  var TINT = 'fill="#1E90FF" fill-opacity="0.28" stroke="#1E90FF" stroke-width="1" vector-effect="non-scaling-stroke" stroke-linejoin="round"';
  function ringD(r) { return 'M' + r.map(function (p) { return p[0] + ' ' + p[1]; }).join('L') + 'Z'; }
  function faceKey(f) { return f.outer.length + ':' + f.outer[0][0].toFixed(3) + ',' + f.outer[0][1].toFixed(3) + ':' + f.area.toFixed(2); }
  function fillColor() { var P = SD.prefs; return P.fill !== 'none' ? P.fill : (P.stroke !== 'none' ? P.stroke : SD.NAVY); }

  function showFaces(list) {
    SD.view.setToolOverlay(list.map(function (f) { return '<path ' + TINT + ' fill-rule="evenodd" d="' + ringD(f.outer) + f.holes.map(ringD).join('') + '"/>'; }).join(''));
  }
  function showRun(run) {
    if (!run) { SD.view.setToolOverlay(''); return; }
    var g = SD.tools.grabIndex(run.copy);
    var d = 'M' + run.run.map(function (p) { var q = g.board(p[0], p[1]); return q[0] + ' ' + q[1]; }).join('L');
    SD.view.setToolOverlay('<path d="' + d + '" fill="none" stroke="#E5007E" stroke-opacity="0.55" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>');
  }
  function hover() {   // 押す前の薄い表示（描画の合間に1回だけ）
    var q = hoverQ; hoverQ = null;
    if (!q || st) return;
    if (q.alt) { showRun(F.findRun(q.b, ERASE_PX)); return; }
    var lines = SD.state.items.length;
    if (lines * SD.layout.get().mats.length > HOVER_MAX) { SD.view.setToolOverlay(''); return; }   // 重い時は表示を省く（押せば効く）
    var f = F.faceAt(F.faces(q.b), q.b);
    showFaces(f ? [f] : []);
  }

  function commitFaces() {   // 選んだ面を図形にする（確定は呼び出し側）
    var g = st.grab, picked = Object.keys(st.picked).map(function (k) { return st.picked[k]; });
    if (!picked.length) return 0;
    var color = fillColor(), n = 0;
    F.unite(picked).forEach(function (ring) {
      var nodes = F.ringToNodes(ring, g);
      if (nodes.length < 3) return;
      SD.addItem({ closed: true, nodes: nodes, fill: color, stroke: 'none', sw: SD.prefs.sw, opacity: SD.prefs.opacity });
      n++;
    });
    return n;
  }

  T.register({
    name: 'builder', label: 'シェイプ<br>形成', key: '⇧M', title: 'シェイプ形成', cursor: 'crosshair',
    icon: '<circle cx="9" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="15" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.6C13.4 8.7 14.2 10.2 14.2 12S13.4 15.3 12 16.4C10.6 15.3 9.8 13.8 9.8 12S10.6 8.7 12 7.6Z" fill="currentColor"/>',
    busy: function () { return !!st; },
    down: function (c) {
      SD.view.setToolOverlay('');
      if (c.alt) {
        st = { mode: 'erase', last: c.b, changed: false };
        st.changed = F.eraseRun(c.b, ERASE_PX);
        if (st.changed) SD.view.live();
        return;
      }
      st = { mode: 'face', grab: T.grab(c.b), faces: F.faces(c.b), picked: {}, changed: false };
      var f = F.faceAt(st.faces, c.b);
      if (f) st.picked[faceKey(f)] = f;
      showFaces(Object.keys(st.picked).map(function (k) { return st.picked[k]; }));
    },
    move: function (c, isDown) {
      if (!isDown) {   // ホバー
        if (!hoverQ) requestAnimationFrame(hover);
        hoverQ = { b: c.b, alt: c.alt };
        return;
      }
      if (!st) return;
      if (st.mode === 'face') {
        var f = F.faceAt(st.faces, c.b);
        if (f && !st.picked[faceKey(f)]) {
          st.picked[faceKey(f)] = f;
          showFaces(Object.keys(st.picked).map(function (k) { return st.picked[k]; }));
        }
      } else {   // なぞった線上の点ごとに、触れた区間を消す
        var a = st.last, b = c.b, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * c.unit / STEP_PX)), any = false;
        for (var i = 1; i <= n; i++) any = F.eraseRun([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], ERASE_PX) || any;
        st.last = b;
        if (any) { st.changed = true; SD.view.live(); }
      }
    },
    up: function () {
      if (!st) return;
      var s = st; st = null;
      SD.view.setToolOverlay('');
      if (s.mode === 'face') {
        st = s; var n = commitFaces(); st = null;
        if (n) SD.commit();
      } else if (s.changed) { SD.commit(); SD.emit('sel'); }
    },
    cancel: function () { var s = st; st = null; SD.view.setToolOverlay(''); if (s && s.mode === 'erase' && s.changed) SD.commit(); },
    finish: function () { st = null; SD.view.setToolOverlay(''); }
  });
})();
