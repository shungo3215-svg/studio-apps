/* paste.js — SVG の貼り付け。⌘V の時、自前でコピーした図形があればそれを貼り、無くて SVG の文字列があれば
   000_kit/svg-in.js（StudioSvgIn）で読んで、モチーフ範囲に収めて図形に足す。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var PA = SD.path, MAX_ITEMS = 300;

  function nodesOf(segs, closed) {
    var first = segs[0], a = first.type === 'L' ? first.a : first.p0, nodes = [{ x: a[0], y: a[1], in: null, out: null }];
    segs.forEach(function (sg) {
      if (sg.type === 'L') nodes.push({ x: sg.b[0], y: sg.b[1], in: null, out: null });
      else { nodes[nodes.length - 1].out = sg.p1; nodes.push({ x: sg.p3[0], y: sg.p3[1], in: sg.p2, out: null }); }
    });
    if (closed && nodes.length > 2) {   // 終点が始点に重なる時は、1つのアンカーにまとめる
      var f = nodes[0], l = nodes[nodes.length - 1];
      if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) { f.in = l.in; nodes.pop(); }
    }
    return nodes;
  }

  /* SVG の文字列から図形を足す。足した数を返す（0 なら足していない・理由は画面に出す） */
  function importSvg(text) {
    var r = StudioSvgIn.parse(text);
    if (r.error || !r.shapes.length) { Studio.toast(r.error || '貼れる図形が見つかりませんでした', { kind: 'error', sticky: true }); return 0; }
    var bb = r.bbox, big = Math.max(bb.w, bb.h, 1e-6);
    var s = Math.min(1, SD.PAD * 0.8 / big);           // 大きい時だけ、モチーフ範囲の8割に縮める
    var cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2, half = SD.PAD / 2;
    var m = [s, 0, 0, s, half - cx * s, half - cy * s];
    var ids = [], skipped = 0;
    r.shapes.forEach(function (sh) {
      sh.subpaths.forEach(function (sp) {
        if (!sp.segs.length) return;
        if (ids.length >= MAX_ITEMS) { skipped++; return; }
        var nodes = PA.mapNodes(nodesOf(sp.segs, sp.closed), m);
        if (nodes.length < 2) return;
        ids.push(SD.addItem({
          closed: !!sp.closed, nodes: nodes, fill: sh.fill || 'none', stroke: sh.stroke || 'none',
          sw: Math.max(0.1, (sh.strokeWidth || 1) * s), opacity: sh.opacity == null ? 1 : sh.opacity
        }).id);
      });
    });
    if (!ids.length) { Studio.toast('貼れる図形が見つかりませんでした', { kind: 'error', sticky: true }); return 0; }
    SD.state.sel = ids; SD.state.selPts = [];
    SD.commit(); SD.emit('sel');
    Studio.toast(ids.length + '個の図形を貼りました' + (skipped ? '（多すぎるため ' + skipped + '個は省きました）' : '') +
      (r.warnings.length ? '。読めなかった物: ' + r.warnings.join('、') : ''));
    return ids.length;
  }

  var P = SD.paste = { importSvg: importSvg };
  /* ⌘V（キー）: 自前の図形があればそれ、無ければクリップボードの SVG */
  P.key = function () {
    if (SD.ops.hasClip()) { SD.ops.paste(); return; }
    var fail = function () { Studio.toast('貼れる図形がありません（図形を選んで ⌘C するか、SVG をコピーしてから）', { kind: 'error' }); };
    if (!navigator.clipboard || !navigator.clipboard.readText) { fail(); return; }
    navigator.clipboard.readText().then(function (t) { if (!/<svg[\s>]|<path[\s>]|<(rect|circle|ellipse|polygon|polyline|line)[\s>]/i.test(t || '')) fail(); else importSvg(t); }, fail);
  };
  /* 貼り付けイベント（メニューからの貼り付け・キーボードで届いた paste）も同じ順で受ける */
  document.addEventListener('paste', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|color)$/.test(t.type)))) return;
    if (SD.ops.hasClip()) { e.preventDefault(); SD.ops.paste(); return; }
    var text = StudioSvgIn.readClipboard(e);
    if (text) { e.preventDefault(); importSvg(text); }
  });
})();
