/* tools/pen.js — ペン: 押した所にアンカー、押したままドラッグでハンドル。始点を押すと閉じる・Enter か Esc で開いたまま終える。 */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, PA = SD.path;
  var CLOSE_PX = 8, DRAG_PX = 3;
  var lastBusy = false;
  var st = null;   // { g:掴んだコピー, nodes, cursor:[x,y]|null, drag:{idx, from}|null }

  function pxDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]) * SD.view.unit(); }

  function refresh() {
    if (!!st !== lastBusy) { lastBusy = !!st; SD.emit('draft'); }   // 画面の「ペンを確定」ボタンの押せる／押せないを合わせる
    if (!st) { SD.view.setDraft(''); SD.view.setToolOverlay(''); return; }
    var nodes = st.nodes.slice();
    if (st.cursor && !st.drag) nodes.push(PA.N(st.cursor[0], st.cursor[1]));   // 次の点までの見込み線
    SD.view.setDraft(nodes.length > 1 ? T.draftSvg(nodes, false) : '');
    var u = SD.view.unit(), h = 3.5 / u, s = '';
    st.nodes.forEach(function (n, i) {
      var p = st.g.board(n.x, n.y);
      [n.in, n.out].forEach(function (hd) {
        if (!hd) return;
        var q = st.g.board(hd[0], hd[1]);
        s += '<path d="M' + p[0] + ' ' + p[1] + 'L' + q[0] + ' ' + q[1] + '" stroke="#1E90FF" stroke-width="1" vector-effect="non-scaling-stroke" fill="none"/>' +
             '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="' + h * 0.7 + '" fill="#1E90FF"/>';
      });
      s += '<rect x="' + (p[0] - h) + '" y="' + (p[1] - h) + '" width="' + h * 2 + '" height="' + h * 2 + '" fill="' +
           (i === 0 ? '#1E90FF' : '#FFFFFF') + '" stroke="#1E90FF" stroke-width="1" vector-effect="non-scaling-stroke"/>';
    });
    SD.view.setToolOverlay(s);
  }

  function commit(closed) {
    var nodes = st.nodes;
    st = null;
    if (nodes.length < 2) { refresh(); return; }
    T.commitShape(nodes, closed);
  }

  T.register({
    name: 'pen', label: 'ペン', key: 'P', cursor: 'crosshair',
    icon: '<path d="M12 2.5L18 11.5L12 15.5L6 11.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 15.5V21.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="10" r="1.5" fill="currentColor"/>',
    busy: function () { return !!st; },
    down: function (c) {
      if (!st) st = { g: T.grab(c.b), nodes: [], cursor: null, drag: null };
      if (st.nodes.length >= 3) {   // 始点を押したら閉じる
        var f = st.g.board(st.nodes[0].x, st.nodes[0].y);
        if (pxDist(f, c.b) <= CLOSE_PX) { commit(true); return; }
      }
      var sp = SD.snap.point(c.b);   // アンカー・交点・格子に吸着
      SD.snap.mark(sp);
      var l = st.g.local(sp.p);
      st.nodes.push(PA.N(l[0], l[1]));
      st.drag = { idx: st.nodes.length - 1, from: c.b, moved: false };
      refresh();
    },
    move: function (c, isDown) {
      if (!st) return;
      if (isDown && st.drag) {
        if (!st.drag.moved && pxDist(st.drag.from, c.b) > DRAG_PX) st.drag.moved = true;
        if (st.drag.moved) {
          var n = st.nodes[st.drag.idx], l = st.g.local(c.b);
          n.out = [PA.r3(l[0]), PA.r3(l[1])];
          n.in = [PA.r3(2 * n.x - l[0]), PA.r3(2 * n.y - l[1])];   // 反対側のハンドルは点対称
        }
      } else if (!isDown) { var sp = SD.snap.point(c.b); SD.snap.mark(sp); st.cursor = st.g.local(sp.p); }
      refresh();
    },
    up: function () { if (st) { st.drag = null; refresh(); } },
    cancel: function () { if (st) { st.drag = null; refresh(); } },
    finish: function () { if (st) commit(false); },
    undoStep: function () {   // 描きかけは ⌘Z で1点ずつ戻す
      if (!st) return false;
      st.nodes.pop(); st.drag = null;
      if (!st.nodes.length) st = null;
      refresh(); return true;
    }
  });
})();
