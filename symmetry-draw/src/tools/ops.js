/* tools/ops.js — 選択した図形への操作（複製・コピー・貼り付け・重ね順・矢印で動かす・見た目の変更）。道具から独立。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var PA = SD.path, S = SD.state;
  var O = SD.ops = {};
  var clip = null, pasteN = 0, lastMove = [10, 10];

  O.setLastMove = function (v) { lastMove = v; };
  O.selected = function () { return S.items.filter(function (it) { return S.sel.indexOf(it.id) >= 0; }); };
  O.byId = function (id) { for (var i = 0; i < S.items.length; i++) if (S.items[i].id === id) return S.items[i]; return null; };
  /* 選んだ図形全体の箱（モチーフ座標・曲線の広がりまで） */
  O.bbox = function (items) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    items.forEach(function (it) {
      var c = PA.curveBox(it.nodes, it.closed);
      b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0); b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1);
    });
    return isFinite(b.x0) ? b : null;
  };
  function select(ids) { S.sel = ids; S.selPts = []; SD.emit('sel'); }
  function part(it, dx, dy) {
    return { closed: it.closed, nodes: PA.mapNodes(it.nodes, [1, 0, 0, 1, dx, dy]), fill: it.fill, stroke: it.stroke, sw: it.sw, opacity: it.opacity };
  }
  /* 選んだ図形を (dx,dy) ずらした複製を、いちばん上に作って選ぶ。確定（取り消しに積む）はしない */
  O.duplicateQuiet = function (dx, dy) {
    var ids = O.selected().map(function (it) { return SD.addItem(part(it, dx, dy)).id; });
    if (ids.length) select(ids);
    return ids;
  };

  O.duplicate = function () {   // ⌘D: 前回動かした分だけずらして複製（動かしていなければ右下へ 10）
    if (!O.selected().length) return;
    O.duplicateQuiet(lastMove[0], lastMove[1]);
    SD.commit();
  };
  O.copy = function () {
    var items = O.selected();
    if (!items.length) return false;
    clip = JSON.parse(JSON.stringify(items)); pasteN = 0;
    Studio.toast(items.length + '個の図形をコピーしました');
    return true;
  };
  O.hasClip = function () { return !!clip; };
  O.paste = function () {
    if (!clip) { Studio.toast('貼り付ける図形がありません（先に図形を選んで ⌘C）', { kind: 'error' }); return; }
    pasteN++;
    var ids = clip.map(function (it) { return SD.addItem(part(it, 10 * pasteN, 10 * pasteN)).id; });
    select(ids); SD.commit();
  };
  O.cut = function () { if (O.copy()) { SD.removeIds(S.sel.slice()); SD.commit(); SD.emit('sel'); } };
  O.selectAll = function () { select(S.items.map(function (it) { return it.id; })); };

  /* 重ね順: forward / backward は1段、front / back は端まで。変わらなければ何もしない（取り消しに積まない） */
  O.reorder = function (kind) {
    if (!S.sel.length) return;
    var a = S.items.slice(), n = a.length, sel = function (it) { return S.sel.indexOf(it.id) >= 0; }, i;
    if (kind === 'forward') { for (i = n - 2; i >= 0; i--) if (sel(a[i]) && !sel(a[i + 1])) { var t = a[i]; a[i] = a[i + 1]; a[i + 1] = t; } }
    else if (kind === 'backward') { for (i = 1; i < n; i++) if (sel(a[i]) && !sel(a[i - 1])) { var u = a[i]; a[i] = a[i - 1]; a[i - 1] = u; } }
    else if (kind === 'front') a = a.filter(function (x) { return !sel(x); }).concat(a.filter(sel));
    else if (kind === 'back') a = a.filter(sel).concat(a.filter(function (x) { return !sel(x); }));
    if (a.every(function (x, k) { return x === S.items[k]; })) return;
    S.items = a; SD.commit();
  };

  /* 矢印キー: 選んだ点（ダイレクト選択）か、選んだ図形をモチーフ単位で動かす */
  O.nudge = function (dx, dy) {
    var m = [1, 0, 0, 1, dx, dy];
    if (S.selPts.length) {
      S.selPts.forEach(function (p) {
        var it = O.byId(p.id); if (!it) return;
        var n = it.nodes[p.idx], mv = function (q) { return q ? [PA.r3(q[0] + dx), PA.r3(q[1] + dy)] : q; };
        if (p.part === 'a') { n.x = PA.r3(n.x + dx); n.y = PA.r3(n.y + dy); n.in = mv(n.in); n.out = mv(n.out); }
        else n[p.part] = mv(n[p.part]);
      });
    } else {
      var items = O.selected();
      if (!items.length) return;
      items.forEach(function (it) { it.nodes = PA.mapNodes(it.nodes, m); });
    }
    SD.commitSoon();
  };

  /* 見た目の変更: 選択があれば選択だけに。無ければ呼び出し側が「次に描く物」へ */
  O.applyStyle = function (patch) {
    var items = O.selected();
    if (!items.length) return false;
    items.forEach(function (it) {
      Object.assign(it, patch);
      if (it.fill === 'none' && it.stroke === 'none') it.stroke = SD.NAVY;
    });
    SD.commitSoon();
    return true;
  };
})();
