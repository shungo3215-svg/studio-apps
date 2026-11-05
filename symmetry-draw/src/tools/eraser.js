/* tools/eraser.js — 消しゴム(⇧E): 押した所・なぞった所に触れた図形を、丸ごと消す。なぞり1回＝取り消し1回。 */
(function () {
  'use strict';
  var SD = window.SD, T = SD.tools, S = SD.state;
  var REACH_PX = 4, STEP_PX = 2;
  var st = null;   // { last:[版面座標], removed:数 }

  function wipe(b, reach) {   // b に触れている図形を、見つかる限り消す
    var h;
    while ((h = T.hitAt(b, reach))) { SD.removeIds([h.item.id]); st.removed++; }
  }
  T.register({
    name: 'eraser', label: '消しゴム', key: '⇧E', cursor: 'crosshair',
    icon: '<g transform="rotate(-30 12 12)"><rect x="4.5" y="8" width="15" height="8.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 8V16.5" stroke="currentColor" stroke-width="1.7"/></g>',
    busy: function () { return !!st; },
    down: function (c) {
      st = { last: c.b, removed: 0, reach: T.reach(c, REACH_PX) };
      wipe(c.b, st.reach);
      if (st.removed) SD.view.live();
    },
    move: function (c, isDown) {
      if (!st || !isDown) return;
      var a = st.last, b = c.b, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * c.unit / STEP_PX));
      var before = st.removed;
      for (var i = 1; i <= n; i++) wipe([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], st.reach);
      st.last = b;
      if (st.removed !== before) SD.view.live();
    },
    up: function () {
      if (!st) return;
      var s = st; st = null;
      if (s.removed) { SD.commit(); SD.emit('sel'); }
    },
    cancel: function () { var s = st; st = null; if (s && s.removed) SD.commit(); },
    finish: function () { st = null; }
  });
})();
