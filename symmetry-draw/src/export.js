/* export.js — 書き出し用の SVG（コピーごとの <g transform="matrix"> ＋ path。<use> は使わない）と、JSON の出入り。
   ファイルを保存するボタンの処理は index.html（Studio.exportSVG / copySVG）にある。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var NS = 'http://www.w3.org/2000/svg';
  var LAW = '描いた線を、選んだ対称の種類に従って全コピーへ展開する';
  var X = SD.exp = { TOOL: 'symmetry-draw', PJ: '000_drop/シンメトリー描画', LAW: LAW, PARAMS_VERSION: 1 };

  function fmt(m) { return m.map(function (v) { return Math.round(v * 1e5) / 1e5; }).join(' '); }

  /* 版面と同じ範囲（W×H）の SVG 要素。背景は includeBg の時だけ */
  X.buildSvg = function (includeBg) {
    var S = SD.state, V = SD.view, L = SD.layout.get();
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('viewBox', '0 0 ' + V.W + ' ' + V.H);
    svg.setAttribute('width', V.W); svg.setAttribute('height', V.H);
    var body = '<defs><clipPath id="board-clip"><rect x="0" y="0" width="' + V.W + '" height="' + V.H + '"/></clipPath></defs>';
    if (includeBg && SD.prefs.bg !== 'none')
      body += '<rect id="background" x="0" y="0" width="' + V.W + '" height="' + V.H + '" fill="' + SD.prefs.bg + '"/>';
    var paths = S.items.map(SD.path.itemSvg).join('');
    body += '<g id="copies" clip-path="url(#board-clip)">';
    L.mats.forEach(function (m) { body += '<g transform="matrix(' + fmt(m) + ')">' + paths + '</g>'; });
    svg.innerHTML = body + '</g>';
    return svg;
  };

  X.fileBase = function () { return Studio.fname(X.TOOL, SD.state.group.replace(/[^A-Za-z0-9]+/g, '-')); };

  X.meta = function () {
    var S = SD.state, d = SD.doc(), memo = SD.bar ? SD.bar.memoText() : '';
    var m = {
      tool: X.TOOL, pj: X.PJ, law: LAW, seed: null, memo: memo,
      toolVersion: SD.TOOL_VERSION, paramsVersion: X.PARAMS_VERSION,
      params: { group: S.group, gap: S.params.gap, size: S.params.size, rows: S.params.rows, items: d.items, bg: SD.prefs.bg }
    };
    if (SD.bar && SD.bar.captionOn())
      m.caption = ['対称 ' + S.group + ' · 間隔 ' + S.params.gap + ' · 大きさ ' + S.params.size + ' · 図形 ' + S.items.length + '個'];
    return m;
  };

  /* ---- 書き出したSVGをドロップすると、その図形で開き直す（006 §1） ---- */
  X.contract = {
    tool: X.TOOL, toolVersion: SD.TOOL_VERSION, paramsVersion: X.PARAMS_VERSION,
    legacy: { toolVersion: SD.TOOL_VERSION, paramsVersion: 1 },
    validate: function (p) {
      try { SD.sanitize({ spec: { name: p.group }, params: p, items: p.items }); return true; }
      catch (e) { return e.message; }
    }
  };
  X.restoreEnvelope = function (env) {
    var next = Studio.prepareRestore(env, X.contract), p = next.params;
    SD.load({ spec: { name: p.group }, params: p, items: p.items });
    if (p.bg && /^(none|#[0-9a-fA-F]{6})$/.test(p.bg)) { SD.prefs.bg = p.bg; SD.persist(); SD.emit('change'); SD.emit('prefs'); }
    if (SD.bar) SD.bar.setMemo(next.memo || '');
  };

  /* ---- JSON ---- */
  X.jsonText = function () { return JSON.stringify(SD.doc()); };
  X.loadJsonText = function (text) {
    var raw;
    try { raw = JSON.parse(text); } catch (e) { throw new Error('JSONとして読めません'); }
    SD.load(raw);
  };
})();
