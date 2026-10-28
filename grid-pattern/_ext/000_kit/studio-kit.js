/*!
 * studio-kit — Studio 共通ランタイム（依存ゼロ）
 * 各ツールで毎回書き直していた「seed乱数 / SVG・PNG・ZIP書き出し / コントロールパネル」を1本に集約する。
 * 使い方: <script src="../studio-kit.js"></script> で global の `Studio` が生える。
 *         Vite/React からは `import Studio from '.../studio-kit.js'`（module.exports 併対応）。
 * 出典の正準アルゴリズムは 000_kit/000_README.md 参照（011/035/036/014/038 から抽出）。
 */
(function (root, factory) {
  var Studio = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Studio;
  if (root) root.Studio = Studio;
  // ?tune 付きで開くと見た目の調整パネル（studio-tune.js）を読む（006 §6）
  if (typeof document !== 'undefined' && document.currentScript && /[?&]tune\b/.test(location.search)) {
    var tuneSrc = document.currentScript.src.replace(/studio-kit\.js(\?.*)?$/, 'studio-tune.js');
    addEventListener('DOMContentLoaded', function () {
      var el = document.createElement('script'); el.src = tuneSrc; document.body.appendChild(el);
    });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.7.10';   // 封筒の kit フィールド（006 §1）と Studio.version の唯一の出所
  var SVGNS = 'http://www.w3.org/2000/svg';
  var XLINKNS = 'http://www.w3.org/1999/xlink';
  // このスクリプト自身のsrc（同期実行中だけ有効）。000_kit/vendor/mp4-muxer.js の動的読み込みに使う（§13）。
  var KIT_SRC = (typeof document !== 'undefined' && document.currentScript) ? document.currentScript.src : null;

  /* ============================================================
   * 1. seed 付き乱数（mulberry32）
   *    011 / 035 / 104_ロゴ生成ツール に定数 0x6D2B79F5 まで同一で存在した
   *    「事実上の標準」をそのまま昇格。ヘルパを生やしただけ。
   * ============================================================ */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1; // 空欄=0 を 1 にフォールバック（全0列を避ける）
    var r = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
    };
    r.range = function (lo, hi) { return lo + (hi - lo) * r(); };
    r.int = function (lo, hi) { return Math.floor(lo + (hi - lo + 1) * r()); }; // 両端含む
    r.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    r.chance = function (p) { return r() < (p == null ? 0.5 : p); };
    r.shuffle = function (arr) { // Fisher-Yates（sort(()=>rand-.5) はバイアスありなので使わない）
      var a2 = arr.slice();
      for (var i = a2.length - 1; i > 0; i--) {
        var j = Math.floor(r() * (i + 1));
        var tmp = a2[i]; a2[i] = a2[j]; a2[j] = tmp;
      }
      return a2;
    };
    r.seed = a;
    return r;
  }

  /* ============================================================
   * 2. 共通ダウンロードヘルパ（038 term_composer の setTimeout revoke 版が正準）
   * ============================================================ */
  function dl(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000); // Safari の取りこぼし対策
  }

  /* ============================================================
   * 3. 色ユーティリティ（getComputedStyle が返す rgb()/rgba() → #hex + alpha）
   * ============================================================ */
  function colorToHex(v) {
    if (!v) return { hex: null, alpha: null, none: false };
    v = String(v).trim();
    if (v === 'none') return { hex: null, alpha: null, none: true };
    if (v === 'transparent') return { hex: null, alpha: 0, none: false };
    var m = v.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var parts = m[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean).map(Number);
      var r = parts[0], g = parts[1], b = parts[2];
      var alpha = parts.length > 3 ? parts[3] : 1;
      var hex = '#' + [r, g, b].map(function (n) {
        return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      }).join('');
      return { hex: hex, alpha: alpha, none: false };
    }
    if (v[0] === '#') return { hex: v, alpha: 1, none: false };
    return { hex: null, alpha: null, none: false }; // 未知（url() 等は呼び出し側で除外済み）
  }

  /* ============================================================
   * 4. SVG 書き出し（crown jewel）
   *    serializeSVG(svgEl, {resolveVars, background}) -> string（純粋・テスト可能）
   *    exportSVG(svgEl, {name, ...})                  -> string（serialize + DL）
   *    方針: live DOM を clone → getComputedStyle で実色を焼く → グラデを userSpaceOnUse 化
   *          → 背景 rect 任意 → XMLSerializer → Blob。全図形を個別オブジェクトのまま保つ。
   * ============================================================ */

  // 実際に描画する葉要素だけ色を焼く（g/svg/defs 等コンテナには焼かない＝ノイズと var 漏れを避ける）
  var PAINTABLE = { circle: 1, ellipse: 1, rect: 1, line: 1, polyline: 1, polygon: 1, path: 1, text: 1, tspan: 1, textpath: 1, use: 1 };
  var STYLE_PAINT = ['fill', 'stroke', 'stop-color', 'stop-opacity', 'fill-opacity', 'stroke-opacity', 'color'];

  // clone のインライン style から paint 系と CSS 変数を除去（var() 漏れの根絶）。transform 等は残す。
  function cleanInlineStyle(el) {
    if (!el.style || !el.getAttribute('style')) return;
    var st = el.style;
    STYLE_PAINT.forEach(function (p) { st.removeProperty(p); });
    var customs = [];
    for (var i = 0; i < st.length; i++) { var n = st.item(i); if (n.indexOf('--') === 0) customs.push(n); }
    customs.forEach(function (n) { st.removeProperty(n); });
    if (!st.length) el.removeAttribute('style');
  }

  // 元 DOM（アタッチ済み）と clone を同順で走査し、色を実値属性として焼き込む。
  function bakeColors(origRoot, cloneRoot) {
    var origs = [origRoot].concat(Array.prototype.slice.call(origRoot.querySelectorAll('*')));
    var clones = [cloneRoot].concat(Array.prototype.slice.call(cloneRoot.querySelectorAll('*')));
    for (var i = 0; i < origs.length; i++) {
      var o = origs[i], c = clones[i];
      if (!o || !c) continue;
      var cs;
      try { cs = getComputedStyle(o); } catch (e) { cleanInlineStyle(c); continue; }
      var tag = (o.tagName || '').toLowerCase();
      if (tag === 'stop') {
        bakePaint(c, 'stop-color', cs.getPropertyValue('stop-color'));
        var so = cs.getPropertyValue('stop-opacity');
        if (so && parseFloat(so) < 1) c.setAttribute('stop-opacity', String(+parseFloat(so).toFixed(3)));
      } else if (PAINTABLE[tag]) {
        ['fill', 'stroke'].forEach(function (p) {
          bakePaint(c, p, cs.getPropertyValue(p));
          var op = cs.getPropertyValue(p + '-opacity');
          if (op && parseFloat(op) < 1) c.setAttribute(p + '-opacity', String(+parseFloat(op).toFixed(3)));
        });
      }
      cleanInlineStyle(c);
    }
  }

  function bakePaint(c, prop, val) {
    if (!val) return;
    val = val.trim();
    if (val.indexOf('url(') !== -1) return; // グラデ等 paint server 参照は温存（後段で userSpaceOnUse 化）
    var col = colorToHex(val);
    if (col.none) { c.setAttribute(prop, 'none'); return; }
    if (col.hex) {
      c.setAttribute(prop, col.hex);
      if (col.alpha != null && col.alpha < 1) {
        // rgba の alpha は *-opacity に分離（Illustrator が alpha 付き fill を落とすのを防ぐ）
        var opName = prop === 'stop-color' ? 'stop-opacity' : prop + '-opacity';
        c.setAttribute(opName, String(+col.alpha.toFixed(3)));
      }
    }
  }

  var _gid = 0; // グラデ複製用の単調カウンタ（seed 乱数とは別枠・id 衝突回避）

  function frac(val, def) {
    if (val == null || val === '') return def;
    val = String(val).trim();
    if (val.charAt(val.length - 1) === '%') return parseFloat(val) / 100;
    return parseFloat(val);
  }

  // objectBoundingBox のグラデを、参照図形の bbox を使って userSpaceOnUse に正準化する。
  // 複数図形が同一グラデを共有していても、図形ごとに専用グラデを複製（1図形=1グラデ）。
  function convertGradients(origRoot, cloneRoot) {
    var cloneGrads = cloneRoot.querySelectorAll('linearGradient, radialGradient');
    if (!cloneGrads.length) return;
    var byId = {};
    Array.prototype.forEach.call(cloneGrads, function (g) { if (g.id) byId[g.id] = g; });

    var clones = [cloneRoot].concat(Array.prototype.slice.call(cloneRoot.querySelectorAll('*')));
    var origs = [origRoot].concat(Array.prototype.slice.call(origRoot.querySelectorAll('*')));
    var defs = cloneRoot.querySelector('defs');

    for (var i = 0; i < clones.length; i++) {
      var cs = clones[i], os = origs[i];
      if (!cs || !os || typeof os.getBBox !== 'function') continue;
      ['fill', 'stroke'].forEach(function (prop) {
        var v = cs.getAttribute(prop);
        if (!v) return;
        var m = v.match(/url\(["']?#([^"')]+)/);
        if (!m) return;
        var g = byId[m[1]];
        if (!g) return;
        if (g.getAttribute('gradientUnits') === 'userSpaceOnUse') return; // 既に正準なら触らない
        var bb;
        try { bb = os.getBBox(); } catch (e) { return; }
        if (!bb || (!bb.width && !bb.height)) return;
        var ng = makeUserSpaceGradient(g, bb);
        if (!ng) return;
        if (!defs) { defs = document.createElementNS(SVGNS, 'defs'); cloneRoot.insertBefore(defs, cloneRoot.firstChild); }
        defs.appendChild(ng);
        cs.setAttribute(prop, 'url(#' + ng.id + ')');
      });
    }
  }

  function makeUserSpaceGradient(g, bb) {
    var ng = g.cloneNode(true);
    ng.id = 'sk-grad-' + (_gid++);
    ng.setAttribute('gradientUnits', 'userSpaceOnUse');
    var tag = g.tagName.toLowerCase();
    if (tag === 'lineargradient') {
      // 座標を bbox で絶対座標に焼き込む（gradientTransform は畳まず前提なし＝現状ツールに該当なし）
      var x1 = frac(g.getAttribute('x1'), 0), y1 = frac(g.getAttribute('y1'), 0);
      var x2 = frac(g.getAttribute('x2'), 1), y2 = frac(g.getAttribute('y2'), 0);
      ng.setAttribute('x1', (bb.x + x1 * bb.width).toFixed(3));
      ng.setAttribute('y1', (bb.y + y1 * bb.height).toFixed(3));
      ng.setAttribute('x2', (bb.x + x2 * bb.width).toFixed(3));
      ng.setAttribute('y2', (bb.y + y2 * bb.height).toFixed(3));
      ng.removeAttribute('gradientTransform');
    } else {
      // radial は bbox が非正方だと userSpaceOnUse の真円で表せないため、
      // 分数座標のまま unit-box→bbox の gradientTransform を掛けて厳密に写す。
      var pre = g.getAttribute('gradientTransform') || '';
      ng.setAttribute('gradientTransform',
        'translate(' + bb.x + ' ' + bb.y + ') scale(' + bb.width + ' ' + bb.height + ')' + (pre ? ' ' + pre : ''));
    }
    return ng;
  }

  function serializeSVG(svgEl, opts) {
    opts = opts || {};
    var resolveVars = opts.resolveVars, background = opts.background;
    // resolveVars: live 要素に一時的に CSS 変数をセット→computed に反映させ、終わったら戻す
    var restore = [];
    if (resolveVars) {
      for (var k in resolveVars) {
        if (!Object.prototype.hasOwnProperty.call(resolveVars, k)) continue;
        restore.push([k, svgEl.style.getPropertyValue(k)]);
        svgEl.style.setProperty(k, resolveVars[k]);
      }
    }
    var str;
    try {
      var clone = svgEl.cloneNode(true);
      clone.setAttribute('xmlns', SVGNS);
      clone.setAttribute('xmlns:xlink', XLINKNS);
      // §4: 画面外へ一時挿入するための配置スタイル（position:fixed; left:-99999px 等）を持ち出さない。
      // 残すと映像のコマ・PNG が画面外に描かれて真っ白になる（2026-09-25 立体スプラインで発生）
      if (clone.style) {
        ['position', 'left', 'top', 'right', 'bottom', 'visibility', 'pointer-events', 'z-index'].forEach(function (k) { clone.style.removeProperty(k); });
        if (!clone.getAttribute('style') || !clone.getAttribute('style').trim()) clone.removeAttribute('style');
      }
      if (!clone.getAttribute('viewBox')) {
        var w = svgEl.getAttribute('width'), h = svgEl.getAttribute('height');
        if (w && h) clone.setAttribute('viewBox', '0 0 ' + parseFloat(w) + ' ' + parseFloat(h));
      }
      bakeColors(svgEl, clone);
      convertGradients(svgEl, clone);
      if (background) {
        var vb = (clone.getAttribute('viewBox') || '0 0 0 0').split(/\s+/).map(Number);
        var rect = document.createElementNS(SVGNS, 'rect');
        rect.setAttribute('x', vb[0]); rect.setAttribute('y', vb[1]);
        rect.setAttribute('width', vb[2]); rect.setAttribute('height', vb[3]);
        rect.setAttribute('fill', background);
        clone.insertBefore(rect, clone.firstChild);
      }
      if (opts.standard) standardizeSVG(clone); // 新規の出力だけ明示的に標準形へ
      if (opts.meta) attachProvenance(clone, opts.meta); // 006_ツールの規格 §1〜§2
      str = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    } finally {
      for (var i = 0; i < restore.length; i++) {
        if (restore[i][1]) svgEl.style.setProperty(restore[i][0], restore[i][1]);
        else svgEl.style.removeProperty(restore[i][0]);
      }
    }
    if (str.indexOf('var(') !== -1) {
      console.warn('[studio-kit] serializeSVG: 出力に var() が残っています（色以外の属性に CSS 変数が使われている可能性）');
    }
    return str;
  }

  // 編集単位を保ち、defsと記録を除いた図版をg#artへまとめる。既存出力にはオプトイン。
  function standardizeSVG(svg) {
    var vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0)
      throw new Error('有効なviewBoxが必要です');
    if (!svg.hasAttribute('width')) svg.setAttribute('width', vb[2]);
    if (!svg.hasAttribute('height')) svg.setAttribute('height', vb[3]);
    if (svg.id === 'art') svg.removeAttribute('id');
    var art = Array.from(svg.children).find(function (n) { return n.localName === 'g' && n.id === 'art'; });
    if (!art) { art = document.createElementNS(SVGNS, 'g'); art.id = 'art'; svg.appendChild(art); }
    var originalFirst = art.firstChild, beforeArt = true;
    Array.from(svg.children).forEach(function (n) {
      if (n === art) { beforeArt = false; return; }
      if (!/^(defs|metadata|title|desc)$/.test(n.localName) && n.id !== 'spec') {
        if (beforeArt) art.insertBefore(n, originalFirst); else art.appendChild(n);
      }
    });
  }

  function exportSVG(svgEl, opts) {
    opts = opts || {};
    var str = serializeSVG(svgEl, opts);
    dl(new Blob([str], { type: 'image/svg+xml' }), (opts.name || 'export') + '.svg');
    return str;
  }

  /* ============================================================
   * 4.5 出自（provenance）— 006_ツールの規格 §1〜§3
   *     封筒（<metadata id="studio"> の1行JSON・常時オン）／
   *     キャプション（<g id="spec"> の見える設定値・ON/OFF）／
   *     ファイル名（<tool>_<主要値>_<YYYYMMDD-HHMM>）
   * ============================================================ */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStamp() { return new Date().toISOString(); }
  var nameSequence = 0;
  // タブをまたぐ衝突を避けるセッションID＋呼び出し連番。同じ名前は呼び出し側で再利用する。
  var nameSession;
  function fname(tool, keys) {
    if (!nameSession) {
      var bytes = new Uint32Array(2);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
      else { bytes[0] = Math.random() * 0x100000000; bytes[1] = Math.random() * 0x100000000; }
      nameSession = Array.from(bytes).map(function (n) { return n.toString(36); }).join('');
    }
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '');
    return tool + (keys ? '_' + keys : '') + '_' + stamp + '-' + nameSession + '-' + (++nameSequence).toString(36);
  }
  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function provEnvelope(meta) {
    return {
      studio: 1,
      tool: meta.tool || '',
      pj: meta.pj || '',
      law: meta.law || '',
      params: meta.params || {},
      seed: (meta.seed === undefined ? null : meta.seed),
      date: dateStamp(),
      memo: meta.memo || '',
      toolVersion: meta.toolVersion == null ? null : meta.toolVersion,
      paramsVersion: meta.paramsVersion == null ? null : meta.paramsVersion,
      kit: VERSION            // 006 §1（2026-08-12 追加）。非kitツールは null を書く
    };
  }
  // SVG を文字列で組むツール用。<svg …> の直後に連結する
  function provenance(meta) {
    return '<metadata id="studio">' + xmlEscape(JSON.stringify(provEnvelope(meta))) + '</metadata>';
  }

  // ---- キャプションの組版（CJK=1em / 半角=0.62em の概算幅） ----
  function measureWidth(text, fs) {
    return Array.from(String(text)).reduce(function (width, ch) {
      // 結合文字・異体字セレクタ・接合子は独立した幅を持たない。
      if (/[\p{M}\u200d\ufe00-\ufe0f]/u.test(ch)) return width;
      return width + (ch.codePointAt(0) > 0x2E7F ? fs : fs * 0.62);
    }, 0);
  }
  function joinItems(items) {
    return (Array.isArray(items) ? items.map(joinItems).join(' · ') : String(items == null ? '' : items))
      .split(' · ').map(function (item) { return item.trim(); }).filter(Boolean).join(' · ');
  }
  function wrapLine(line, budget, fs, items) {
    line = String(line);
    var out = [], cur = '';
    function push() { if (cur) out.push(cur); cur = ''; }
    if (items) {
      joinItems(line).split(' · ').forEach(function (item) {
        var next = cur ? cur + ' · ' + item : item;
        if (cur && measureWidth(next, fs) > budget) { push(); next = item; }
        cur = next; // 単独で超過する項目は分割せず、captionLayout で行だけ縮小する。
      });
    } else {
      function graphemes(text) {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          return Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text), function (s) { return s.segment; });
        }
        var clusters = [];
        Array.from(text).forEach(function (ch) {
          if (clusters.length && (/[\p{M}\u200d\ufe00-\ufe0f\u{1f3fb}-\u{1f3ff}]/u.test(ch) || /\u200d$/.test(clusters[clusters.length - 1])))
            clusters[clusters.length - 1] += ch;
          else clusters.push(ch);
        });
        return clusters;
      }
      var chars = graphemes(line), tokens = [], word = '';
      function wordEnd() { if (word) tokens.push({ text: word }); word = ''; }
      for (var i = 0; i < chars.length;) {
        var rest = chars.slice(i).join('');
        var protectedText = rest.match(/^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[ \t]*(?:[\p{L}µμ]+(?:[²³]|[\/][\p{L}]+)?|[%％°×℃℉]))/u);
        if (protectedText) {
          var count = graphemes(protectedText[0]).length;
          // マッチが結合文字の途中で終わっても、書記素全体を保護する。
          wordEnd(); tokens.push({ text: chars.slice(i, i + count).join(''), atomic: true }); i += count;
        } else {
          var ch = chars[i++];
          word += ch;
          if (/[\s、。・]/u.test(ch)) wordEnd();
        }
      }
      wordEnd();
      tokens.forEach(function (token) {
        var text = token.text;
        if (cur && measureWidth(cur + text, fs) > budget) push();
        if (!token.atomic && measureWidth(text, fs) > budget) {
          graphemes(text).forEach(function (ch) {
            if (cur && measureWidth(cur + ch, fs) > budget) push();
            cur += ch;
          });
        } else cur += text;
      });
    }
    push();
    return out.length ? out : [''];
  }
  function captionLayout(lines, box) {
    var fs = box.w * 0.012, inset = fs, budget = box.w - 2 * inset;
    var lineH = fs * 1.3, padTop = fs * 0.8, padBottom = fs * 0.8;
    var blocks;
    if (lines && !Array.isArray(lines) && typeof lines === 'object') {
      // 新入力は生成済み封筒を共有。日時はUTCの分表示で設定ブロック末尾へ1回だけ置く。
      var env = lines.env;
      var name = env.tool === env.pj ? env.tool : env.tool + ' · ' + env.pj;
      var date = env.date.replace('T', ' ').slice(0, 16);
      var settings = joinItems(lines.settings).split(' · ').filter(function (item) { return item && item !== date && item !== env.date; });
      settings.push(date);
      blocks = [name + (env.law ? ' — ' + env.law : ''), joinItems(settings), 'メモ: ' + (env.memo || '')];
    } else if (Array.isArray(lines)) {
      // 旧 [見出し, 設定（配列または複数要素）, メモ] の設定境界は強制改行にしない。
      var hasMemo = lines.length > 1 && /^メモ[:：]/.test(String(lines[lines.length - 1]));
      blocks = [String(lines[0] == null ? '' : lines[0]), joinItems(lines.slice(1, hasMemo ? -1 : undefined))];
      if (hasMemo) blocks.push(String(lines[lines.length - 1]));
      if (lines.length < 2) blocks = blocks.slice(0, 1);
      blocks[0] = blocks[0].replace(/^(.+?) · \1(?= — |$)/, '$1');
    } else blocks = [null, joinItems(lines)];
    var phys = [], sizes = [];
    blocks.forEach(function (block, i) {
      if (block == null) return;
      wrapLine(block, budget, fs, i === 1).forEach(function (line) {
        var width = measureWidth(line, fs);
        phys.push(line);
        sizes.push(width > budget ? fs * budget / width : fs);
      });
    });
    return { fs: fs, lineH: lineH, inset: inset, padTop: padTop, padBottom: padBottom,
      firstBaseline: box.y + box.h + padTop + fs, lines: phys, lineFs: sizes,
      extraH: padTop + fs + (phys.length - 1) * lineH + padBottom };
  }
  // 両出力経路の属性をここで一度だけ定義する。1物理行 = 編集可能な1 text。
  function captionElements(L, box) {
    return {
      attrs: { id: 'spec', 'font-family': 'Menlo, ui-monospace, monospace', 'font-size': L.fs, fill: '#666666' },
      texts: L.lines.map(function (line, i) {
        return { text: line, attrs: { x: box.x + L.inset, y: L.firstBaseline + i * L.lineH,
          'font-size': L.lineFs[i], 'xml:space': 'preserve' } };
      })
    };
  }
  // SVG文字列用。旧linesと {env, settings} を受け、戻り値 {svg, extraH} を維持する。
  function caption(lines, box) {
    var L = captionLayout(lines, box), elements = captionElements(L, box);
    function attrs(values) {
      return Object.keys(values).map(function (key) { return ' ' + key + '="' + xmlEscape(values[key]).replace(/"/g, '&quot;') + '"'; }).join('');
    }
    var out = '<g' + attrs(elements.attrs) + '>';
    elements.texts.forEach(function (t) { out += '<text' + attrs(t.attrs) + '>' + xmlEscape(t.text) + '</text>'; });
    return { svg: out + '</g>', extraH: L.extraH };
  }

  // serializeSVG の clone に封筒（+キャプション）を差し込む DOM 経路
  function attachProvenance(clone, meta) {
    var env = provEnvelope(meta);
    Array.from(clone.querySelectorAll('metadata[id="studio"]')).forEach(function (n) { n.remove(); });
    var md = document.createElementNS(SVGNS, 'metadata');
    md.setAttribute('id', 'studio');
    md.textContent = JSON.stringify(env);
    clone.insertBefore(md, clone.firstChild);

    if (meta.caption && meta.caption.length) {
      var vbParts = (clone.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
      var vb = vbParts.map(Number);
      if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) {
        console.warn('[studio-kit] attachProvenance: 有効な viewBox が無いためキャプションを付けられません');
        return;
      }
      var box = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
      function dimension(value) {
        var match = String(value || '').trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(px|mm|cm|in|pt|pc|Q)?$/i);
        var units = { '': 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, q: 96 / 101.6 };
        if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) return null;
        return { number: Number(match[1]), unit: match[2] || '', px: Number(match[1]) * units[(match[2] || '').toLowerCase()] };
      }
      var width = dimension(clone.getAttribute('width')), height = dimension(clone.getAttribute('height'));
      var styledSize = clone.style && ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'aspect-ratio'].some(function (key) {
        return !!clone.style.getPropertyValue(key);
      });
      if (!width || !height || styledSize || Math.abs((width.px / height.px) / (box.w / box.h) - 1) > 1e-9) {
        console.warn('[studio-kit] attachProvenance: 寸法が相対値・不明、または viewBox と縦横比が不一致で縮尺維持を確認できないためキャプションを付けません');
        return;
      }
      var heightUnit = height.unit;
      var L = captionLayout({ env: env, settings: meta.caption }, box);
      var elements = captionElements(L, box);
      function setAttrs(node, values) {
        Object.keys(values).forEach(function (key) {
          if (key === 'xml:space') node.setAttributeNS('http://www.w3.org/XML/1998/namespace', key, values[key]);
          else node.setAttribute(key, values[key]);
        });
      }
      var g = document.createElementNS(SVGNS, 'g');
      setAttrs(g, elements.attrs);
      elements.texts.forEach(function (row) {
        var t = document.createElementNS(SVGNS, 'text');
        setAttrs(t, row.attrs);
        t.textContent = row.text;
        g.appendChild(t);
      });
      clone.appendChild(g);
      clone.setAttribute('viewBox', vbParts.slice(0, 3).join(' ') + ' ' + (box.h + L.extraH));
      clone.setAttribute('height', String(height.number * (box.h + L.extraH) / box.h) + heightUnit);
    }
  }

  /* ============================================================
   * 4.55 封筒を読む（006_ツールの規格 §1・再現の入口）
   *      書き出したSVGをツールに戻すと、その設定で開き直せる。
   *      readEnvelope: SVG文字列 → 封筒オブジェクト（無ければ null）
   *      onDropSVG:    要素にSVGのドロップを受けさせ、封筒を渡す
   * ============================================================ */
  var MAX_SVG_BYTES = 16 * 1024 * 1024;
  var MAX_ENVELOPE_BYTES = 1024 * 1024;
  function validateEnvelope(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return '封筒はオブジェクトである必要があります';
    if (env.studio !== 1) return '未対応の封筒の版です';
    if (typeof env.tool !== 'string' || !/^[A-Za-z0-9_-]+$/.test(env.tool)) return 'ツールIDが不正です';
    if (!env.params || typeof env.params !== 'object' || Array.isArray(env.params)) return '設定値の形式が不正です';
    if (env.seed != null && !Number.isSafeInteger(env.seed)) return '種は安全に扱える整数が必要です';
    for (var key of ['pj', 'law', 'date', 'memo', 'kit', 'toolVersion'])
      if (Object.prototype.hasOwnProperty.call(env, key) && !(env[key] === null && (key === 'kit' || key === 'toolVersion')) && typeof env[key] !== 'string') return key + 'は文字列が必要です';
    if (env.paramsVersion != null && (!Number.isSafeInteger(env.paramsVersion) || env.paramsVersion < 1)) return '設定の版が不正です';
    return null;
  }
  function inspectEnvelope(svgText) {
    var text = String(svgText), fail = function (status, message) { return {status:status, env:null, message:message}; };
    if (new TextEncoder().encode(text).length > MAX_SVG_BYTES) return fail('too-large', 'SVGが16MiBの上限を超えています');
    if (/<!ENTITY/i.test(text)) return fail('invalid', '実体宣言を含むSVGは読み込めません');
    if (typeof DOMParser === 'undefined') return fail('unavailable', 'SVGの読み取りにはDOMParserが必要です');
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') return fail('invalid', 'SVGの形式が不正です');
    var nodes = Array.from(doc.getElementsByTagNameNS('*', 'metadata')).filter(function (n) { return n.id === 'studio' || n.getAttribute('id') === 'studio'; });
    if (!nodes.length) return fail('missing', 'このSVGには出自が入っていません');
    if (nodes.length !== 1 || nodes[0].children.length) return fail('invalid', '封筒はJSONテキスト1個である必要があります');
    var raw = nodes[0].textContent;
    if (new TextEncoder().encode(raw).length > MAX_ENVELOPE_BYTES) return fail('too-large', '設定が1MiBの上限を超えています');
    var env;
    try { env = JSON.parse(raw); } catch (e) { return fail('invalid', '封筒のJSONが壊れています'); }
    var error = validateEnvelope(env);
    if (error) return fail(env && env.studio !== 1 ? 'unsupported' : 'invalid', error);
    return {status:'ok', env:env, message:''};
  }
  function readEnvelope(svgText) { return inspectEnvelope(svgText).env; }
  // 読取は無副作用。ツール固有の移行・検証がすべて通るまで画面状態を触らない。
  function prepareRestore(env, contract) {
    if (!contract || typeof contract !== 'object') throw new Error('復元の契約が必要です');
    var error = validateEnvelope(env);
    if (error) throw new Error(error);
    if (env.tool !== contract.tool) throw new Error('別のツールのSVGです');
    var next = JSON.parse(JSON.stringify(env));
    if (next.toolVersion == null && contract.legacy) next.toolVersion = contract.legacy.toolVersion;
    if (next.paramsVersion == null && contract.legacy) next.paramsVersion = contract.legacy.paramsVersion;
    if (next.toolVersion !== contract.toolVersion || next.paramsVersion !== contract.paramsVersion) {
      if (!contract.migrate) throw new Error('このツールでは復元できない設定の版です');
      next = contract.migrate(next);
    }
    error = validateEnvelope(next);
    if (error || next.tool !== contract.tool || next.toolVersion !== contract.toolVersion || next.paramsVersion !== contract.paramsVersion)
      throw new Error(error || '設定の移行に失敗しました');
    if (typeof contract.validate !== 'function') throw new Error('設定の検証が必要です');
    error = contract.validate(next.params, next.seed);
    if (error !== true) throw new Error(typeof error === 'string' ? error : '設定値が不正です');
    return next;
  }
  // 第3引数は詳細結果。既存のhandler(env, file)は引き続き使える。
  function onDropSVG(el, handler) {
    var stop = function (e) { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('dragover', function (e) { stop(e); e.dataTransfer.dropEffect = 'copy'; });
    el.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/\.svg$/i.test(f.name)) return;
      stop(e);
      if (f.size > MAX_SVG_BYTES) { handler(null, f, {status:'too-large', message:'SVGが16MiBの上限を超えています'}); return; }
      var r = new FileReader();
      r.onload = function () { var result = inspectEnvelope(r.result); handler(result.env, f, result); };
      r.onerror = function () { handler(null, f, {status:'io-error', message:'ファイルを読み込めませんでした'}); };
      r.readAsText(f);
    });
  }

  /* ============================================================
   * 4.6 規定パレット（006_ツールの規格 §5）
   *     出典は 126_カラーパレット の棚（実画像から採色・整数sRGB）と
   *     115_symmetry の既定色。ツールの「作品の色」の初期値に使う。
   *     ※ UIの色（Serendieトークン）とは別物。混ぜない。
   * ============================================================ */
  var PALETTES = [
    { id: 'navy',      name: '紺と白',     from: '115_symmetry', colors: ['#0044CC', '#FFFFFF', '#14120F'] },
    { id: 'sumi',      name: '墨と紙',     from: '135_放射パターン', colors: ['#2B2B2B', '#F0EFEE', '#8C8B87'] },
    { id: 'terracotta',name: 'テラコッタ', from: '126 P11',      colors: ['#C3503A', '#A5BEBF', '#CE7454', '#DC9569', '#B19289', '#B0A89F'] },
    { id: 'tonal-red', name: '赤の階調',   from: '126 P12',      colors: ['#D21A1A', '#D45151', '#D77D7E', '#D8A7A9', '#D2D2D6', '#F4F5F8'] },
    { id: 'cobalt',    name: 'グレーと青', from: '126 P14',      colors: ['#03358A', '#6377A7', '#DC7C7B', '#C7BCBC', '#D3D3D3', '#E7E7E7'] },
    { id: 'quiet',     name: '紙に沈む',   from: '126 M03',      colors: ['#A5BEBF', '#4C9BBE', '#EDDDD0', '#F4DCDC', '#DC9569', '#B19289'] },
    { id: 'teal-coral',name: '青緑と朱',   from: '126 M02',      colors: ['#046550', '#049EDD', '#8ECAD2', '#F85F32', '#F19079', '#F7B735'] },
    { id: 'summer',    name: '橙と青と緑', from: '126 P06',      colors: ['#FE6121', '#399CD9', '#268741', '#0B8D4A', '#F98351', '#F6F0DD'] },
    { id: 'chartreuse',name: '蛍光の黄緑', from: '126 P15',      colors: ['#D5FD00', '#CEDF43', '#C8CC69', '#C3B599', '#F0FCA6'] }
  ];

  /* ============================================================
   * 4.7 SVG をクリップボードへ（006_ツールの規格 §8）
   *     image/svg+xml と text/plain の両方を1つの ClipboardItem に載せる
   *     （Illustrator 2022 以降・Figma が ⌘V でベクターとして受ける）
   * ============================================================ */
  /* コピー結果 → 通知文（§8）。SVG形式で載った時だけ「ベクターとして貼れる」と言う */
  function copyResultMessage(result, label) {
    var head = label ? label + ' の' : '';
    if (result && result.format === 'svg') return head + 'SVGをコピーしました（Illustrator に ⌘V で貼れます）';
    return head + 'SVGを文字としてコピーしました（Illustrator には書き出したファイルで渡してください）';
  }

  /* '#abc' / 'ABCDEF' / '#aabbcc' → '#aabbcc'。不正なら null */
  function normalizeHex(s) {
    s = String(s == null ? '' : s).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, function (c) { return c + c; });
    return /^[0-9a-f]{6}$/i.test(s) ? '#' + s.toLowerCase() : null;
  }

  async function copySVG(text) {
    var failures = [];
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'image/svg+xml': new Blob([text], {type:'image/svg+xml'}),
          'text/plain': new Blob([text], {type:'text/plain'})
        })]);
        return {format:'svg', method:'clipboard', failures:failures};
      } catch (e) { failures.push(String(e.message || e)); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return {format:'text', method:'writeText', failures:failures}; }
      catch (e) { failures.push(String(e.message || e)); }
    }
    var active = document.activeElement, ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { failures.push(String(e.message || e)); }
    finally { ta.remove(); if (active && active.focus) active.focus({preventScroll:true}); }
    if (!ok) throw new Error('コピーできませんでした。SVGを書き出してください');
    return {format:'text', method:'execCommand', failures:failures};
  }

  /* ============================================================
   * 5. PNG 書き出し（canvas 直描き経路＝studio 主流 / SVG 経路＝新規正準）
   * ============================================================ */
  function exportPNG(target, opts) {
    opts = opts || {};
    var scale = opts.scale == null ? 2 : opts.scale;
    var name = (opts.name || 'export') + '.png';
    var bg = (opts.bg && opts.bg !== 'none') ? opts.bg : null;   // 'none' は透過（006_ツールの規格 §5）

    if (typeof HTMLCanvasElement !== 'undefined' && target instanceof HTMLCanvasElement) {
      var c = document.createElement('canvas');
      c.width = Math.round(target.width * scale);
      c.height = Math.round(target.height * scale);
      var g = c.getContext('2d');
      if (bg) { g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); }
      g.drawImage(target, 0, 0, c.width, c.height);
      c.toBlob(function (b) { dl(b, name); });
      return;
    }
    // SVG 経路: clone→data:URI→Image→拡大サイズで drawImage→toBlob
    var str = serializeSVG(target, { background: bg || undefined });
    var vbAttr = target.getAttribute('viewBox') ||
      ('0 0 ' + (target.getAttribute('width') || 300) + ' ' + (target.getAttribute('height') || 150));
    var vb = vbAttr.split(/\s+/).map(Number);
    var vw = vb[2], vh = vb[3];
    var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    var img = new Image();
    img.onload = function () {
      var c2 = document.createElement('canvas');
      c2.width = Math.round(vw * scale); c2.height = Math.round(vh * scale);
      var g2 = c2.getContext('2d');
      if (bg) { g2.fillStyle = bg; g2.fillRect(0, 0, c2.width, c2.height); }
      g2.drawImage(img, 0, 0, c2.width, c2.height);
      c2.toBlob(function (b) { dl(b, name); });
    };
    img.onerror = function () { console.error('[studio-kit] exportPNG: SVG を Image として読み込めませんでした'); };
    img.src = url;
  }

  /* ============================================================
   * 6. 連番 ZIP 書き出し（無圧縮 store・依存ゼロ・file:// 完結）
   *    JSZip(CDN) は Studio の外部依存禁止に反するので内蔵する。PNG は圧縮済なので store で十分。
   * ============================================================ */
  function crc32(bytes) {
    if (!crc32.tab) {
      crc32.tab = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crc32.tab[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crc32.tab[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

  function buildStoreZip(files) {
    var chunks = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nameB = new TextEncoder().encode(f.name);
      var data = f.bytes;
      var crc = crc32(data);
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0)
      );
      var localHead = new Uint8Array(local);
      chunks.push(localHead, nameB, data);
      var cen = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
      );
      central.push({ head: new Uint8Array(cen), name: nameB });
      offset += localHead.length + nameB.length + data.length;
    });
    var centralStart = offset, centralSize = 0, centralChunks = [];
    central.forEach(function (c) { centralChunks.push(c.head, c.name); centralSize += c.head.length + c.name.length; });
    var eocd = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(centralSize), u32(centralStart), u16(0)
    ));
    return new Blob(chunks.concat(centralChunks, [eocd]), { type: 'application/zip' });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // frames: [{name, blob | dataURL | bytes(Uint8Array)}]
  function exportZIP(frames, opts) {
    opts = opts || {};
    var name = (opts.name || 'frames') + '.zip';
    var jobs = frames.map(function (f) {
      if (f.bytes) return Promise.resolve({ name: f.name, bytes: f.bytes });
      if (f.blob) return f.blob.arrayBuffer().then(function (buf) { return { name: f.name, bytes: new Uint8Array(buf) }; });
      if (f.dataURL) return Promise.resolve({ name: f.name, bytes: b64ToBytes(f.dataURL.split(',')[1]) });
      return Promise.resolve(null);
    });
    return Promise.all(jobs).then(function (files) {
      dl(buildStoreZip(files.filter(Boolean)), name);
    });
  }

  /* ============================================================
   * 6.4 上部バーとトースト（006 §6・studio2.css とセット）
   *     正典 = 135_放射パターン/src/index-v2.html のバー。DOMはこの関数が所有し、
   *     ツール側は返り値のAPI（memoText / captionOn）だけを使う。
   *     キーボード（⌘C・⌘Z・X・⇧X）の配線はツール側の責務（§7の入力ガード込み）。
   *
   *     var bar = Studio.appBar('#bar', {
   *       name:'放射パターン', sub:'RADIAL',
   *       onCopy:fn, onSvg:fn, onPng:fn,   // null を渡したボタンは出さない
   *       extra:[{label:'ZIPで書き出し', onClick:fn, primary:true, title:'…'}],   // 型ごとの追加ボタン（任意。primary で主ボタン）
   *       memo:true, caption:true, theme:true            // 既定はすべて true
   *     });
   * ============================================================ */
  function appBar(mount, opt) {
    opt = opt || {};
    if (typeof mount === 'string') mount = document.querySelector(mount);
    if (!mount) { mount = document.createElement('header'); document.body.insertBefore(mount, document.body.firstChild); }
    mount.id = mount.id || 'bar';
    mount.innerHTML = '';

    function el(tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function sep() { return el('div', 'sep'); }
    /* id は135の元DOMと同じ（#copy / #svg / #png / #theme）。
       既存の検証スクリプトや外部からの参照を壊さないための契約。
       icon（SVG文字列）を渡すとアイコン付きの短いボタンになる（2026-09-25 追加・§6 アイコン表示）。
       アイコン使用時は ariaLabel に完全な文言を必ず渡す（UI-04: アイコンだけで意味を伝えない）。 */
    function btn(label, kbd, primary, onClick, id, title, icon, ariaLabel) {
      var b = el('button', 'btn' + (primary ? ' primary' : '') + (icon ? ' has-icon' : ''));
      b.type = 'button';
      if (id) b.id = id;
      if (title) b.title = title;
      if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
      b.appendChild(document.createTextNode(label));
      if (icon) {
        var ic = el('span', 'btn-ico');
        ic.innerHTML = icon;
        ic.setAttribute('aria-hidden', 'true');
        b.appendChild(ic);
      }
      if (kbd) { var k = document.createElement('kbd'); k.textContent = kbd; b.appendChild(k); }
      b.addEventListener('click', onClick);
      return b;
    }

    mount.appendChild(el('div', 'name', opt.name || ''));
    if (opt.sub) mount.appendChild(el('div', 'sub', opt.sub));
    mount.appendChild(el('div', 'fill'));

    var memo = null;
    if (opt.memo !== false) {
      memo = document.createElement('input');
      memo.id = 'memo'; memo.placeholder = 'メモ（書き出しに入る）';
      memo.setAttribute('aria-label', 'メモ');
    }
    var cap = null, lab = null;
    if (opt.caption !== false) {
      lab = el('label', 'caprow');
      lab.title = '図版の下端の外側に ツール名・設定値・メモ を付ける（図版領域は変わらない）';
      cap = document.createElement('input');
      cap.type = 'checkbox'; cap.id = 'cap';
      lab.appendChild(cap); lab.appendChild(el('span', null, 'キャプション'));
    }
    var opts = el('div', 'baropts'); opts.id = 'baropts';
    if (memo) opts.appendChild(memo);
    if (lab) opts.appendChild(lab);
    var syncBadge = function () {};
    if (memo || cap) {
      var more = btn('書き出し設定', null, false, function () {
        var open = mount.classList.toggle('opts-open');
        more.setAttribute('aria-expanded', String(open));
      }, 'baropts-toggle', 'メモとキャプションの設定を開く（狭い画面のみ）');
      more.className = 'btn baropts-toggle'; more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'baropts');
      var badge = el('span', 'baropts-badge', ''); more.appendChild(badge);
      syncBadge = function () {
        var parts = [];
        if (memo && memo.value.trim()) parts.push('メモあり');
        if (cap && cap.checked) parts.push('キャプションON');
        badge.textContent = parts.length ? '（' + parts.join('・') + '）' : '';
      };
      if (memo) memo.addEventListener('input', syncBadge);
      if (cap) cap.addEventListener('change', syncBadge);
      mount.appendChild(more);
      mount.appendChild(opts);
    }

    var acts = [];
    // copyLabel / svgLabel+svgIcon: 短いラベル・アイコン化のオプション（2026-09-25 追加・省略時は従来どおりの表記）
    if (opt.onCopy) acts.push(btn(opt.copyLabel || 'SVGをコピー', '⌘C', false, opt.onCopy, 'copy',
      'SVG形式で載った時は Illustrator に ⌘V でベクターとして貼れる。使えない環境ではSVGコードのテキストになる'));
    if (opt.onSvg) acts.push(btn(opt.svgLabel || 'SVGを書き出し', null, true, opt.onSvg, 'svg',
      opt.svgTitle || null, opt.svgIcon || null, opt.svgIcon ? (opt.svgAriaLabel || 'SVGを書き出し') : null));
    if (opt.onPng) acts.push(btn('PNG', null, false, opt.onPng, 'png'));
    // extra: 型ごとの追加ボタン。primary:true で主ボタン（候補シート型の ZIP など）・title でツールチップ（2026-08-23 追加・省略時は従来どおり）。
    // icon を渡すとアイコン付きの短いボタンになる（ariaLabel省略時は title→label の順で補う）
    (opt.extra || []).forEach(function (x) {
      acts.push(btn(x.label, x.kbd, !!x.primary, x.onClick, x.id, x.title,
        x.icon || null, x.icon ? (x.ariaLabel || x.title || x.label) : null));
    });
    if (acts.length) {
      mount.appendChild(sep());
      acts.forEach(function (b) { mount.appendChild(b); });
    }

    if (opt.theme !== false) {
      mount.appendChild(sep());
      var th = btn('◐', null, false, function () {
        var d = document.documentElement;
        d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark';
      }, 'theme');
      th.setAttribute('aria-label', '表示を反転');
      mount.appendChild(th);
    }

    return {
      el: mount,
      memoText: function () { return memo ? memo.value.trim() : ''; },
      setMemo: function (v) { if (memo) memo.value = v || ''; syncBadge(); },
      captionOn: function () { return !!(cap && cap.checked); }
    };
  }

  /* トースト（結果を必ず画面に出す・§6）。要素が無ければ作る
     opts.sticky=true : 閉じるまで残す（復元失敗・コピー失敗など、読み返す必要がある案内）
     opts.kind='error': 失敗の見た目（.err）。省略時は成功の短い通知（2.6秒で消える） */
  function toast(msg, opts) {
    opts = opts || {};
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    clearTimeout(toast._t);
    el.textContent = '';
    el.classList.toggle('err', opts.kind === 'error');
    el.classList.toggle('sticky', !!opts.sticky);
    el.setAttribute('role', opts.kind === 'error' ? 'alert' : 'status');
    el.appendChild(document.createTextNode(msg));
    if (opts.sticky) {
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'toast-close'; x.textContent = '閉じる';
      x.setAttribute('aria-label', '通知を閉じる');
      x.addEventListener('click', function () { el.classList.remove('on'); });
      el.appendChild(x);
    }
    el.classList.add('on');
    if (!opts.sticky) toast._t = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }
  toast.clear = function () { var el = document.getElementById('toast'); if (el) el.classList.remove('on'); };

  /* ============================================================
   * 6.42 映像の動き（006 §13 VID-02）— A→B→A の補間はツール非依存の純粋関数。
   *      stageBar の内部でも使うが、Node から Studio.motion として単体テストできるよう
   *      DOMに触れない形で独立させる（tests/test-motion.cjs）。
   * ============================================================ */
  var HEX6_RE = /^#[0-9a-fA-F]{6}$/;
  function lerpNum(a, b, u) { return a + (b - a) * u; }
  function lerpHex(a, b, u) {
    function ch(hex, i) { return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16); }
    function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }
    var out = '#';
    for (var i = 0; i < 3; i++) out += clamp255(lerpNum(ch(a, i), ch(b, i), u)).toString(16).padStart(2, '0');
    return out;
  }
  // A・BともキーAの値の型で分岐: 数値=線形（integerKeysは丸め）／#RRGGBB=RGB線形／それ以外=uが0.5未満ならA・以上ならB
  function interpolateParams(A, B, u, integerKeys) {
    var ints = {};
    (integerKeys || []).forEach(function (k) { ints[k] = true; });
    var out = {};
    Object.keys(A || {}).forEach(function (k) {
      var a = A[k], b = Object.prototype.hasOwnProperty.call(B || {}, k) ? B[k] : a;
      if (typeof a === 'number' && typeof b === 'number') {
        var v = lerpNum(a, b, u);
        out[k] = ints[k] ? Math.round(v) : v;
      } else if (typeof a === 'string' && typeof b === 'string' && HEX6_RE.test(a) && HEX6_RE.test(b)) {
        out[k] = lerpHex(a, b, u);
      } else {
        out[k] = u < 0.5 ? a : b;
      }
    });
    return out;
  }
  function easeFn(name) {
    // 既定はsmoothstep（なめらか）。'linear'（等速）はそのまま
    return name === 'linear' ? function (x) { return x; } : function (x) { return x * x * (3 - 2 * x); };
  }
  // A→B→Aの三角波（0=A, 1=B）にイージングを掛けたu。dur秒で1往復
  function pingpongU(t, dur, easeName) {
    dur = dur > 0 ? dur : 1;
    var p = (((t % dur) + dur) % dur) / dur;
    var tri = p < 0.5 ? p * 2 : 2 - p * 2;
    return easeFn(easeName)(tri);
  }
  /* box={x,y,w,h} を frame={x,y,w,h} に、短辺の margin 割合の余白を残して縦横比を保ったまま
   * 中央へ一様拡縮で収める（006 §0「版面」・インスタONの絵の収め方）。
   * 回転などでboxが変わっても、呼び出し側が「回しても変わらない外接」を渡せば拡縮は揺れない。 */
  function fitInto(box, frame, margin) {
    margin = margin == null ? 0.08 : margin;
    var fx = frame.x || 0, fy = frame.y || 0, fw = frame.w, fh = frame.h;
    var short = Math.min(fw, fh);
    var pad = short * margin;
    var availW = Math.max(0, fw - 2 * pad), availH = Math.max(0, fh - 2 * pad);
    var scale = 1;
    if (box && box.w > 0 && box.h > 0 && availW > 0 && availH > 0) scale = Math.min(availW / box.w, availH / box.h);
    var cx = (box ? box.x + box.w / 2 : 0), cy = (box ? box.y + box.h / 2 : 0);
    var tx = (fx + fw / 2) - scale * cx;
    var ty = (fy + fh / 2) - scale * cy;
    return { scale: scale, tx: tx, ty: ty, transform: 'matrix(' + scale + ' 0 0 ' + scale + ' ' + tx + ' ' + ty + ')' };
  }

  // 1回の書き出しにつき Studio.fname を1回だけ呼び、映像/PNGとJSONで同じ名前を共有する（§3）
  function motionFileNames(tool, keys, ext) {
    // 「4:5」の「:」は macOS のファイル名で「/」扱いになるので「4x5」にする
    var name = fname(tool, String(keys == null ? '' : keys).replace(/:/g, 'x'));
    return { name: name, media: name + '.' + ext, json: name + '.json' };
  }

  /* ============================================================
   * 6.43 上部バー共通操作（006 §6・§13・v0.7.0〜）
   *      Studio.stageBar(barEl, opts) -> { el, togglePlay, closeDialog, colors }
   *      appBar のすぐ後に呼ぶ。ツール名の右へ「大きさ・背景（または色スウォッチ）・
   *      再生・A/B・秒数」を差し込み、書き出し群（コピー/SVG/PNG）の右に「映像」を足す。
   *      ツールは値のスナップショット（getParams）・適用（apply）・1コマ描画（frame）
   *      だけを渡す。書き出し本体（大きさプリセット・A/B補間・コマ送り→mp4・情報JSON）は
   *      すべてここに1本化する（§13「実装の置き場所」）。
   *
   *      var sb = Studio.stageBar('#bar', {
   *        sizes: true,                                  // 省略時true。falseで大きさselectを出さない
   *        onSize: function(w,h,key){ … },                // 大きさ変更時（省略可）
   *        sizes: false, motion: false,                   // 大きさ／再生・A/B・映像を出さない（省略時は出す）
   *        getBg: function(){ return bg; }, setBg: function(hex){ bg=hex; render(); },  // 背景スウォッチ
   *        colors: [{key:'fill',label:'塗り',value:'#000'}, …], palettes: true,          // §5の対象チップの代わりに
   *          // 上部バーへ出すスウォッチ列（塗り・線・背景 等）。getBg/setBgと同時に'bg'キーを
   *          // 持たせない（KEY-04: 背景の入口は1つ）。onColorChangeで受け取る
   *        onColorChange: function(key, hexOrNone){ … },
   *        getParams: function(){ return {count:values.count, fg:values.fg}; },
   *        integerKeys: ['count'],
   *        apply: function(p){ for (var k in p) if (k in values) values.set(k, p[k]); render(); },
   *        play: togglePlayback,                          // A/B 未記録時の再生（ツール固有・無ければ再生を促すtoast）
   *        frame: function(ctx){ return svgString; },       // ctx = {t, dur, u, params}（A/B無しはparams:null）
   *        meta: function(){ return {tool,pj,law,params,seed,memo,toolVersion,paramsVersion}; }
   *      });
   *      Studio.keys({ play: sb.togglePlay, escSteps: [sb.closeDialog, …] });
   * ============================================================ */
  var SIZES = { '4:5': [1080, 1350], '1:1': [1080, 1080], '3:4': [1080, 1440], '9:16': [1080, 1920] };
  var DEFAULT_SIZE_KEY = '4:5';
  // インスタ切替の見た目＝カメラ（角丸の四角＋中央の円＋右上の小さな点）。18px・currentColorの線画。
  // ユーザー「インスタは アイコンにして」（2026-09-26）。文字ラベルは持たずtitle/aria-labelで説明する。
  var ICON_INSTA = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2" y="2" width="14" height="14" rx="4"/>' +
    '<circle cx="9" cy="9" r="3.3"/>' +
    '<circle class="dot" cx="13" cy="5" r="0.9" fill="currentColor" stroke="none"/>' +
    '</svg>';

  function loadMp4Muxer() {
    if (typeof window !== 'undefined' && window.Mp4Muxer) return Promise.resolve(window.Mp4Muxer);
    if (!KIT_SRC) return Promise.reject(new Error('mp4-muxerの場所が分かりません（studio-kit.jsのsrcを取得できません）'));
    var src = KIT_SRC.replace(/studio-kit\.js(\?.*)?$/, 'vendor/mp4-muxer.js');
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(window.Mp4Muxer); };
      el.onerror = function () { reject(new Error('mp4-muxerを読み込めませんでした（' + src + '）')); };
      document.head.appendChild(el);
    });
  }
  // frame() が返すSVG文字列の見かけの寸法（viewBox優先・無ければwidth/height）
  function svgBoxSize(svgText) {
    var m = String(svgText).match(/viewBox=["']\s*([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s*["']/);
    if (m && parseFloat(m[3]) > 0 && parseFloat(m[4]) > 0) return { w: parseFloat(m[3]), h: parseFloat(m[4]) };
    var mw = String(svgText).match(/\bwidth=["']([\d.]+)/), mh = String(svgText).match(/\bheight=["']([\d.]+)/);
    if (mw && mh && parseFloat(mw[1]) > 0 && parseFloat(mh[1]) > 0) return { w: parseFloat(mw[1]), h: parseFloat(mh[1]) };
    return { w: 1, h: 1 };
  }
  // sw×sh を dw×dh へ収める（contain・中央配置）
  function fitBox(sw, sh, dw, dh) {
    var scale = Math.min(dw / sw, dh / sh);
    var w = sw * scale, h = sh * scale;
    return { x: (dw - w) / 2, y: (dh - h) / 2, w: w, h: h };
  }
  // 1コマ分のSVG文字列を、大きさ選択のw×hに収めて中央配置し、背景で余白を埋めてcanvasへ描く
  function drawFrameToCanvas(ctx, dw, dh, svgText, bg) {
    return new Promise(function (resolve, reject) {
      ctx.clearRect(0, 0, dw, dh);
      if (bg && bg !== 'none') { ctx.fillStyle = bg; ctx.fillRect(0, 0, dw, dh); }
      var size = svgBoxSize(svgText);
      var box = fitBox(size.w, size.h, dw, dh);
      var blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { ctx.drawImage(img, box.x, box.y, box.w, box.h); URL.revokeObjectURL(url); resolve(); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('コマの描画に失敗しました')); };
      img.src = url;
    });
  }

  /* ---- 上部バーの色スウォッチ群（塗り／線／背景 等）。パネルのcolorset（§5）と同じ考え方を
     コンパクトなスウォッチ＋ポップオーバーに直したもの。KEY-04: 背景の入口を二重にしないため、
     opts.colorsに'bg'キーを含めたら stageBar 側の背景スウォッチ（getBg/setBg）は出さない。 ---- */
  /* v0.7.10（2026-10-13「色の小窓が他の領域を触っても引っ込まない」）: <input type="color"> が開く OS のカラーパネル
     （macOS の NSColorPanel）は、ページの外を触っても閉じない。要素を一度 DOM から外して戻すと Chromium が
     chooser を終了する（HTMLInputElement::RemovedFrom → ClosePopupView）ので、それで閉じる。
     watchNativeColor(input): その入力の外を pointerdown した時・色を決めた時に OS のパネルを閉じる。 */
  function endNativeColor(input) {
    if (!input || !input.isConnected) return;
    var p = input.parentNode, n = input.nextSibling;
    p.removeChild(input); p.insertBefore(input, n);
  }
  var nativeColorOpen = [];
  function watchNativeColor(input) {
    input.addEventListener('click', function () { if (nativeColorOpen.indexOf(input) < 0) nativeColorOpen.push(input); });
    input.addEventListener('change', function () { endNativeColor(input); });
  }
  document.addEventListener('pointerdown', function (e) {
    if (!nativeColorOpen.length) return;
    var open = nativeColorOpen; nativeColorOpen = [];
    open.forEach(function (inp) { if (inp !== e.target && !inp.contains(e.target)) endNativeColor(inp); else nativeColorOpen.push(inp); });
  }, true);

  function barColors(anchorEl, opts) {
    var items = opts.colors || [];
    if (!items.length) return null;
    function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
    var state = {}, lastHex = {}, swatchEls = {};
    var current = items[0].key;
    items.forEach(function (c) {
      var v = c.value != null ? c.value : '#000000';
      state[c.key] = v;
      lastHex[c.key] = v !== 'none' ? v : '#000000';
    });

    var box = el('div', 'cmn cmn-colors');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', '色を変える対象');
    items.forEach(function (c) {
      var b = el('button', 'cswatch');
      b.type = 'button'; b.title = c.label; b.setAttribute('aria-label', c.label);
      var fillEl = el('span', 'cswatch-fill');
      b.appendChild(fillEl);
      b.addEventListener('click', function () {
        if (current === c.key && !popover.hidden) { closePopover(); return; }
        openPopover(c.key, b);
      });
      box.appendChild(b);
      swatchEls[c.key] = { btn: b, fill: fillEl };
    });

    var popover = el('div', 'cpop'); popover.hidden = true;
    var picker = document.createElement('input'); picker.type = 'color'; picker.setAttribute('aria-label', '色');
    watchNativeColor(picker);
    var noneBtn = el('button', 'btn'); noneBtn.type = 'button'; noneBtn.textContent = 'なし';
    var hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.className = 'cpop-hex';
    hexInput.maxLength = 7; hexInput.spellcheck = false; hexInput.placeholder = '#RRGGBB';
    hexInput.setAttribute('aria-label', '色コード（#RRGGBB）');
    var pickRow = el('div', 'cpop-row');
    pickRow.appendChild(picker); pickRow.appendChild(noneBtn); pickRow.appendChild(hexInput);
    popover.appendChild(pickRow);
    var drawPal = function () {};
    if (opts.palettes !== false && PALETTES.length) {
      var palSel = document.createElement('select'); palSel.setAttribute('aria-label', 'パレット');
      PALETTES.forEach(function (pl, i) {
        var o = document.createElement('option'); o.value = String(i); o.textContent = pl.name; palSel.appendChild(o);
      });
      var swWrap = el('div', 'cpop-swatches');
      drawPal = function () {
        var pl = PALETTES[+palSel.value]; swWrap.innerHTML = '';
        pl.colors.forEach(function (c) {
          var b = document.createElement('button'); b.type = 'button'; b.style.background = c; b.title = c;
          b.setAttribute('aria-label', c);
          b.addEventListener('click', function () { setColor(current, c); closePopover(); });   // パレットの色を選んだら閉じる
          swWrap.appendChild(b);
        });
      };
      palSel.addEventListener('change', drawPal);
      popover.appendChild(palSel); popover.appendChild(swWrap);
      drawPal();
    }
    document.body.appendChild(popover);

    function syncSwatches() {
      items.forEach(function (c) {
        var v = state[c.key];
        swatchEls[c.key].fill.style.background = v === 'none' ? 'transparent' : v;
        swatchEls[c.key].btn.classList.toggle('none', v === 'none');
        swatchEls[c.key].btn.setAttribute('aria-pressed', String(c.key === current));
      });
    }
    function syncPopover() {
      var v = state[current], none = v === 'none';
      picker.value = none ? lastHex[current] : v;
      noneBtn.setAttribute('aria-pressed', String(none));
      hexInput.value = none ? '' : v.toUpperCase();
      hexInput.placeholder = none ? 'なし' : '#RRGGBB';
    }
    function setColor(key, v) {
      state[key] = v;
      if (v !== 'none') lastHex[key] = v;
      syncSwatches(); if (current === key) syncPopover();
      if (opts.onColorChange) opts.onColorChange(key, v);
    }
    function openPopover(key, anchorBtn) {
      current = key;
      syncSwatches(); syncPopover();
      var r = anchorBtn.getBoundingClientRect();
      popover.style.left = Math.round(r.left) + 'px';
      popover.style.top = Math.round(r.bottom + 6) + 'px';
      popover.hidden = false;
    }
    function closePopover() { if (popover.hidden) return false; popover.hidden = true; endNativeColor(picker); syncSwatches(); return true; }
    picker.addEventListener('input', function () { setColor(current, picker.value); });
    picker.addEventListener('change', function () { closePopover(); });   // ピッカーで決めたら閉じる（2026-09-25「小窓が閉じない」）
    noneBtn.addEventListener('click', function () { setColor(current, state[current] === 'none' ? lastHex[current] : 'none'); });
    function commitHex() {
      if (hexInput.value.trim() === '') { syncPopover(); return; }
      var h = normalizeHex(hexInput.value);
      if (!h) { syncPopover(); toast('色コードは #RRGGBB の形で入れる（例 #2B2B2B）', { kind: 'error' }); return; }
      setColor(current, h);
    }
    hexInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitHex(); hexInput.blur(); }
      if (e.key === 'Escape') { syncPopover(); hexInput.blur(); closePopover(); }
    });
    hexInput.addEventListener('blur', commitHex);
    hexInput.addEventListener('focus', function () { hexInput.select(); });
    function isOutside(target) { return !popover.contains(target) && !box.contains(target); }
    function closeIfOutside(e) { if (!popover.hidden && isOutside(e.target)) closePopover(); }
    document.addEventListener('pointerdown', closeIfOutside, true);   // capture: 版面が伝播を止めても閉じる
    // v0.7.1（2026-09-26「他のエリア触ったら閉じるように」）: フォーカスが小窓の外へ移った時（focusin）と、
    // ウィンドウが一旦フォーカスを失って（blur。OSのカラーパネル等）戻ってきた最初のpointerdownでも閉じる。
    document.addEventListener('focusin', closeIfOutside);
    window.addEventListener('blur', function () {
      if (popover.hidden) return;
      var once = function (e) { document.removeEventListener('pointerdown', once, true); closeIfOutside(e); };
      document.addEventListener('pointerdown', once, true);
    });

    anchorEl.after(box);
    syncSwatches();
    return {
      el: box,
      get: function (key) { return state[key]; },
      set: function (key, v) { state[key] = v; if (v !== 'none') lastHex[key] = v; syncSwatches(); if (current === key) syncPopover(); },
      getTarget: function () { return current; },
      setTarget: function (key) { if (state.hasOwnProperty(key)) { current = key; syncSwatches(); } },
      closePopover: closePopover
    };
  }

  function stageBar(barEl, opts) {
    opts = opts || {};
    if (typeof barEl === 'string') barEl = document.querySelector(barEl);
    if (!barEl) throw new Error('Studio.stageBar: マウント先が見つかりません');
    var nameAnchor = barEl.querySelector('.sub') || barEl.querySelector('.name');
    if (!nameAnchor) throw new Error('Studio.stageBar: Studio.appBar の後に呼んでください');

    function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
    function sep() { return el('div', 'sep'); }

    /* ---- 大きさ・背景 ---- */
    var sizeKey = DEFAULT_SIZE_KEY, sizeWH = SIZES[sizeKey].slice();
    var sizeBox = el('div', 'cmn');
    if (opts.sizes !== false) {
      var sizeSel = document.createElement('select'); sizeSel.title = '大きさ'; sizeSel.setAttribute('aria-label', '書き出す大きさ');
      Object.keys(SIZES).forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = k; if (k === sizeKey) o.selected = true;
        sizeSel.appendChild(o);
      });
      sizeSel.addEventListener('change', function () {
        sizeKey = sizeSel.value; sizeWH = SIZES[sizeKey].slice();
        if (opts.onSize) opts.onSize(sizeWH[0], sizeWH[1], sizeKey);
      });
      sizeBox.appendChild(sizeSel);
    }
    var hasBgSwatch = typeof opts.getBg === 'function';
    if (hasBgSwatch) {
      var bgSw = document.createElement('input'); bgSw.type = 'color'; bgSw.className = 'bgsw'; bgSw.title = '背景';
      bgSw.setAttribute('aria-label', '背景');
      watchNativeColor(bgSw);
      bgSw.value = normalizeHex(opts.getBg()) || '#ffffff';
      bgSw.addEventListener('input', function () { if (opts.setBg) opts.setBg(bgSw.value); });
      sizeBox.appendChild(bgSw);
    }
    var anchor = nameAnchor;
    /* ---- インスタ（大きさ・版面ガイド・再生・映像）の表示切替（2026-09-26 ユーザー「はみ出しちゃう」「非表示にもしたい」）。
       OFF＝それらを隠し、版面は 1:1 に戻して body.insta-off でガイドを消す。選択はツールごとに覚える ---- */
    var instaKey = 'studio-insta:' + ((barEl.querySelector('.name') || {}).textContent || location.pathname);
    var instaOn = false;   // 既定は非表示（2026-09-28 ユーザー「デフォルトはインスタのやつは非表示にして」）。投稿する時だけ ON
    try { if (localStorage.getItem(instaKey) === '1') instaOn = true; } catch (e) {}
    var instaBtn = null;
    if (opts.sizes !== false || opts.motion !== false) {
      instaBtn = el('button', 'btn insta-toggle icon-only'); instaBtn.type = 'button';
      instaBtn.title = 'インスタ用の表示'; instaBtn.setAttribute('aria-label', 'インスタ用の表示');
      var instaIco = el('span', 'btn-ico'); instaIco.innerHTML = ICON_INSTA; instaIco.setAttribute('aria-hidden', 'true');
      instaBtn.appendChild(instaIco);
      anchor.after(sep(), instaBtn); anchor = instaBtn;
    }
    if (sizeBox.children.length) { sizeBox.classList.add('insta-part'); anchor.after(sizeBox); anchor = sizeBox; }

    /* ---- 色スウォッチ（opts.colors。塗り・線・背景などをまとめて上部バーへ） ---- */
    var colorsApi = barColors(anchor, opts);
    if (colorsApi) anchor = colorsApi.el;

    /* ---- 再生・A/B・秒数 ---- */
    var playBox = el('div', 'cmn');
    var playBtn = el('button', 'btn play'); playBtn.type = 'button'; playBtn.textContent = '▶ 再生';
    var aBtn = el('button', 'btn ab'); aBtn.type = 'button'; aBtn.title = '今の状態をAに記録'; aBtn.setAttribute('aria-label', 'Aに記録'); aBtn.textContent = 'A';
    var bBtn = el('button', 'btn ab'); bBtn.type = 'button'; bBtn.title = '今の状態をBに記録'; bBtn.setAttribute('aria-label', 'Bに記録'); bBtn.textContent = 'B';
    var durSel = document.createElement('select'); durSel.className = 'dur'; durSel.title = '長さ'; durSel.setAttribute('aria-label', '映像の長さ');
    [5, 8, 15].forEach(function (s) {
      var o = document.createElement('option'); o.value = String(s); o.textContent = s + '秒'; if (s === 8) o.selected = true;
      durSel.appendChild(o);
    });
    playBox.appendChild(playBtn); playBox.appendChild(aBtn); playBox.appendChild(bBtn); playBox.appendChild(durSel);
    // opts.motion:false＝動きの無いツール（配色の一覧など）。再生・A/B・秒数・映像を出さない（§0「無い機能は出さない」）
    playBox.classList.add('insta-part');
    if (opts.motion !== false) anchor.after(sep(), playBox);

    var A = null, B = null, playing = false, delegatedPlaying = false, raf = null, t0 = 0, beforePlayParams = null;
    aBtn.addEventListener('click', function () { A = opts.getParams ? opts.getParams() : {}; aBtn.classList.add('set'); toast('Aに記録'); });
    bBtn.addEventListener('click', function () { B = opts.getParams ? opts.getParams() : {}; bBtn.classList.add('set'); toast('Bに記録'); });
    function duration() { return parseFloat(durSel.value) || 8; }
    function stopPlay(restore) {
      playing = false; playBtn.textContent = '▶ 再生';
      if (raf) cancelAnimationFrame(raf); raf = null;
      if (restore && beforePlayParams && opts.apply) opts.apply(beforePlayParams);
      beforePlayParams = null;
    }
    function frameTick(now) {
      if (!playing) return;
      var t = (now - t0) / 1000;
      var u = pingpongU(t, duration(), 'smooth');
      if (opts.apply) opts.apply(interpolateParams(A, B, u, opts.integerKeys || []));
      raf = requestAnimationFrame(frameTick);
    }
    function togglePlay() {
      if (playing) { stopPlay(true); return; }
      if (!A || !B) {
        if (opts.play) { opts.play(); delegatedPlaying = !delegatedPlaying; playBtn.textContent = delegatedPlaying ? '■ 停止' : '▶ 再生'; return; }
        toast('A と B を記録してください', { kind: 'error' });
        return;
      }
      beforePlayParams = opts.getParams ? opts.getParams() : null;
      playing = true; playBtn.textContent = '■ 停止'; t0 = performance.now();
      raf = requestAnimationFrame(frameTick);
    }
    playBtn.addEventListener('click', togglePlay);

    /* ---- 映像ボタン（書き出し群のいちばん右。extraで足したボタンの後ろにも回り込む） ---- */
    var mvBtn = el('button', 'btn'); mvBtn.type = 'button'; mvBtn.id = 'video'; mvBtn.textContent = '映像';
    mvBtn.title = '映像を書き出し'; mvBtn.setAttribute('aria-label', '映像を書き出し');
    // #theme（表示の反転）の直前＝書き出し群の最後に差し込む。theme が無ければ末尾に足す。
    var themeBtn = barEl.querySelector('#theme');
    mvBtn.classList.add('insta-part');
    // 動きの無いツール（motion:false）で大きさがあるなら、映像の代わりに「PNG」＝インスタ用の静止画をそのまま書き出す
    var stillOnly = opts.motion === false && opts.sizes !== false;
    if (stillOnly) { mvBtn.textContent = 'PNG'; mvBtn.title = 'インスタ用の静止画（PNG）を書き出し'; mvBtn.setAttribute('aria-label', 'インスタ用のPNGを書き出し'); }
    if (opts.motion === false && !stillOnly) { /* 映像ボタンも出さない */ }
    else if (themeBtn && themeBtn.previousElementSibling) themeBtn.previousElementSibling.before(mvBtn);
    else if (themeBtn) themeBtn.before(mvBtn);
    else barEl.appendChild(mvBtn);

    var backdrop = el('div', 'sb-dlg-backdrop'); backdrop.hidden = true;
    var dlg = el('div', 'sb-dlg');
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', '映像を書き出し');
    backdrop.appendChild(dlg);
    document.body.appendChild(backdrop);

    var easeSel, secInput, fmtSel, goBtn, progBar, progText, cancelBtn, dialogPrevFocus = null, exportCancelled = false;
    function focusable() { return Array.prototype.slice.call(dlg.querySelectorAll('select, input, button')); }
    function renderForm() {
      dlg.innerHTML = '';
      var f1 = el('label', 'sb-field'); var s1 = document.createElement('span'); s1.textContent = '速さの変化'; f1.appendChild(s1);
      easeSel = document.createElement('select');
      [['smooth', 'なめらか'], ['linear', '等速']].forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; easeSel.appendChild(o);
      });
      f1.appendChild(easeSel);

      var f2 = el('label', 'sb-field'); var s2 = document.createElement('span'); s2.textContent = '秒数'; f2.appendChild(s2);
      secInput = document.createElement('input'); secInput.type = 'number'; secInput.min = '1'; secInput.max = '60'; secInput.step = '1';
      secInput.value = String(duration());
      f2.appendChild(secInput);

      var f3 = el('label', 'sb-field'); var s3 = document.createElement('span'); s3.textContent = '形式'; f3.appendChild(s3);
      fmtSel = document.createElement('select');
      [['mp4', 'MP4'], ['png', 'PNG 1枚']].forEach(function (p) {
        var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; fmtSel.appendChild(o);
      });
      f3.appendChild(fmtSel);

      var actions = el('div', 'sb-actions');
      goBtn = el('button', 'btn primary'); goBtn.type = 'button'; goBtn.textContent = '書き出す';
      goBtn.addEventListener('click', function () { startExport(); });
      actions.appendChild(goBtn);

      dlg.appendChild(f1); dlg.appendChild(f2); dlg.appendChild(f3); dlg.appendChild(actions);
    }
    function renderProgress() {
      dlg.innerHTML = '';
      progText = el('div', 'sb-progress-text'); progText.textContent = '書き出し中… 0%';
      var wrap = el('div', 'sb-progress'); progBar = el('div', 'sb-progress-bar'); wrap.appendChild(progBar);
      cancelBtn = el('button', 'btn'); cancelBtn.type = 'button'; cancelBtn.textContent = '中止';
      cancelBtn.addEventListener('click', function () { exportCancelled = true; });
      dlg.appendChild(progText); dlg.appendChild(wrap); dlg.appendChild(cancelBtn);
    }
    function setProgress(ratio) {
      var pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      if (progBar) progBar.style.width = pct + '%';
      if (progText) progText.textContent = '書き出し中… ' + pct + '%';
    }
    function openDialog() {
      renderForm();
      backdrop.hidden = false;
      dialogPrevFocus = document.activeElement;
      easeSel.focus();
    }
    function closeDialog() {   // Esc の段: 色の小窓 → 映像ダイアログ の順に閉じる
      if (colorsApi && colorsApi.closePopover && colorsApi.closePopover()) return true;
      if (backdrop.hidden) return false;
      backdrop.hidden = true;
      if (dialogPrevFocus && dialogPrevFocus.focus) dialogPrevFocus.focus();
      return true;
    }
    mvBtn.addEventListener('click', function () { if (stillOnly) exportPng(0); else openDialog(); });
    function applyInsta() {
      if (!instaBtn) return;
      instaBtn.setAttribute('aria-pressed', String(instaOn)); instaBtn.classList.toggle('primary', instaOn);
      barEl.querySelectorAll('.insta-part').forEach(function (n) { n.hidden = !instaOn; });
      // 動きの無いツールが appBar に常時の PNG（#png）を持つ時: インスタ OFF はそれを、ON はインスタ用の PNG だけを出す（同じ入口を二重にしない・KEY-04・v0.7.7）
      if (stillOnly) { var appPng = barEl.querySelector('#png'); if (appPng) { appPng.hidden = instaOn; appPng.style.display = instaOn ? 'none' : ''; } }
      document.body.classList.toggle('insta-off', !instaOn);
      if (!instaOn && playing) stopPlay(true);
      if (opts.onSize) { if (instaOn) opts.onSize(sizeWH[0], sizeWH[1], sizeKey); else opts.onSize(SIZES['1:1'][0], SIZES['1:1'][1], '1:1'); }
    }
    if (instaBtn) instaBtn.addEventListener('click', function () {
      instaOn = !instaOn; try { localStorage.setItem(instaKey, instaOn ? '1' : '0'); } catch (e) {}
      applyInsta();
    });
    setTimeout(applyInsta, 0);   // ツールの onSize 初期化の後に1回当てる
    backdrop.addEventListener('pointerdown', function (e) { if (e.target === backdrop) closeDialog(); });
    // KEY-03: 開いたら最初の欄にフォーカス・Tabで循環・Enterで決定・Escで閉じる
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); if (goBtn) goBtn.click(); return; }
      if (e.key === 'Tab') {
        var f = focusable(); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    function currentSizeInfo() { return { w: sizeWH[0], h: sizeWH[1], key: sizeKey }; }
    function buildEnvelope(metaObj, motionInfo) {
      var env = provEnvelope(metaObj || {});
      env.size = currentSizeInfo();
      if (motionInfo) env.motion = motionInfo;
      return env;
    }
    function downloadJSON(obj, filename) { dl(new Blob([JSON.stringify(obj)], { type: 'application/json' }), filename); }

    function startExport() {
      var fmt = fmtSel.value, seconds = Math.max(1, parseFloat(secInput.value) || duration()), easeName = easeSel.value;
      if (fmt === 'png') exportPng(seconds); else exportVideo(seconds, easeName);
    }
    function exportPng(seconds) {
      var w = sizeWH[0], h = sizeWH[1];
      var metaObj = opts.meta ? opts.meta() : {};
      var toolName = metaObj.tool || 'tool';
      var params = (A && B) ? interpolateParams(A, B, 0, opts.integerKeys || []) : null;
      var svgText;
      try { svgText = opts.frame({ t: 0, dur: seconds, u: params ? 0 : null, params: params }); }
      catch (e) { toast('コマを描けませんでした: ' + (e && e.message || e), { kind: 'error', sticky: true }); return; }
      var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      var ctx2d = canvas.getContext('2d');
      var bg = hasBgSwatch ? opts.getBg() : (colorsApi ? colorsApi.get('bg') : '#ffffff');
      drawFrameToCanvas(ctx2d, w, h, svgText, bg).then(function () {
        return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
      }).then(function (blob) {
        var names = motionFileNames(toolName, sizeKey, 'png');
        dl(blob, names.media);
        downloadJSON(buildEnvelope(metaObj, null), names.json);
        closeDialog();
        toast(names.media);
      }).catch(function (e) {
        toast((e && e.message) || 'PNGの書き出しに失敗しました', { kind: 'error', sticky: true });
      });
    }
    function exportVideo(seconds, easeName) {
      if (typeof VideoEncoder === 'undefined') {
        toast('この環境は映像の書き出しに対応していません（VideoEncoderが使えません）', { kind: 'error', sticky: true });
        return;
      }
      var w = sizeWH[0], h = sizeWH[1], fps = 30, total = Math.max(1, Math.round(seconds * fps));
      var metaObj = opts.meta ? opts.meta() : {};
      var toolName = metaObj.tool || 'tool';
      var bg = hasBgSwatch ? opts.getBg() : (colorsApi ? colorsApi.get('bg') : '#ffffff');
      renderProgress();
      exportCancelled = false;
      var failed = false;
      function fail(msg) { if (failed) return; failed = true; closeDialog(); toast(msg, { kind: 'error', sticky: true }); }
      // 1080×1920 まで入る H.264 のレベルを選ぶ（3.1 の Baseline は 1080×1350 を拒否する）
      var CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.640033'];
      function pickCodec(k) {
        if (k >= CODECS.length) return Promise.reject(new Error('この大きさ（' + w + '×' + h + '）の H.264 書き出しに対応していません'));
        var cfg = { codec: CODECS[k], width: w, height: h, bitrate: 8000000, framerate: fps };
        return VideoEncoder.isConfigSupported(cfg).then(function (r) { return r.supported ? cfg : pickCodec(k + 1); });
      }
      Promise.all([loadMp4Muxer(), pickCodec(0)]).then(function (got) {
        var Mp4Muxer = got[0], cfg = got[1];
        var muxer = new Mp4Muxer.Muxer({
          target: new Mp4Muxer.ArrayBufferTarget(),
          video: { codec: 'avc', width: w, height: h, frameRate: fps },
          fastStart: 'in-memory'
        });
        var encoder = new VideoEncoder({
          output: function (chunk, meta) { muxer.addVideoChunk(chunk, meta); },
          error: function (e) { fail('書き出しに失敗しました: ' + (e && e.message || e)); }
        });
        encoder.configure(cfg);
        var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        var ctx2d = canvas.getContext('2d');

        function step(i) {
          if (failed) return;
          if (exportCancelled) { encoder.close(); closeDialog(); toast('中止しました'); return; }
          if (i >= total) { finish(); return; }
          var t = i / fps;
          var u = (A && B) ? pingpongU(t, seconds, easeName) : null;
          var params = (A && B) ? interpolateParams(A, B, u, opts.integerKeys || []) : null;
          var svgText;
          try { svgText = opts.frame({ t: t, dur: seconds, u: u, params: params }); }
          catch (e) { encoder.close(); fail('コマを描けませんでした: ' + (e && e.message || e)); return; }
          drawFrameToCanvas(ctx2d, w, h, svgText, bg).then(function () {
            var frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
            encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
            frame.close();
            setProgress((i + 1) / total);
            step(i + 1);
          }).catch(function (e) {
            encoder.close(); fail((e && e.message) || 'コマの描画に失敗しました');
          });
        }
        function finish() {
          encoder.flush().then(function () {
            muxer.finalize();
            var buffer = muxer.target.buffer;
            var names = motionFileNames(toolName, sizeKey, 'mp4');
            dl(new Blob([buffer], { type: 'video/mp4' }), names.media);
            downloadJSON(buildEnvelope(metaObj, { A: A, B: B, dur: seconds, ease: easeName, pingpong: true, fps: fps }), names.json);
            closeDialog();
            toast(names.media);
          }).catch(function (e) { fail((e && e.message) || '書き出しに失敗しました'); });
        }
        step(0);
      }).catch(function (e) {
        fail((e && e.message) || 'mp4-muxerを読み込めませんでした');
      });
    }

    return {
      el: barEl, togglePlay: togglePlay, closeDialog: closeDialog, colors: colorsApi,
      // インスタONの絵を枠に収める用（§0 版面）: 記録済みのA/Bと再生中かどうかをツール側が読める。
      // 「回しても変わらない外接」をA/Bの両方から求め、再生・映像書き出し中は開始時点の値で固定するのに使う。
      getAB: function () { return { A: A, B: B, playing: playing }; }
    };
  }

  /* ============================================================
   * 6.5 取り消し履歴（006 §7: ⌘Z/⇧⌘Z は全型共通）
   *     状態のスナップショットを積むだけの小さな道具。キー割り当てはツール側。
   *       var hist = Studio.history(100);
   *       hist.push(state);              // 変更のたび（連続変更はデバウンスして呼ぶ）
   *       var s = hist.undo() / hist.redo();   // 無ければ null
   * ============================================================ */
  function history(limit) {
    var stack = [], idx = -1, cap = limit || 100;
    return {
      push: function (state) {
        var s = JSON.stringify(state);
        if (idx >= 0 && stack[idx] === s) return;      // 同一状態は積まない
        stack.length = idx + 1; stack.push(s); idx++;
        if (stack.length > cap) { stack.shift(); idx--; }
      },
      undo: function () { return idx > 0 ? JSON.parse(stack[--idx]) : null; },
      redo: function () { return idx < stack.length - 1 ? JSON.parse(stack[++idx]) : null; }
    };
  }

  /* ============================================================
   * 7. コントロールパネル（宣言的 API ＋ escape hatch）
   *    Studio.panel(mount, spec[], onChange, opts) -> values（reactive）
   *    spec item: {type, key, label, min, max, step, value, options, decimals, format, onClick, ...}
   *    type: range / color / select / toggle / checkbox / button / group
   * ============================================================ */
  function decFromStep(step) {
    step = String(step);
    var i = step.indexOf('.');
    return i < 0 ? 0 : step.length - i - 1;
  }

  function panel(mount, spec, onChange, opts) {
    opts = opts || {};
    if (typeof mount === 'string') mount = document.querySelector(mount);
    mount.classList.add('studio-panel');
    var values = {};
    var setters = {};
    function fire(key) { if (onChange) onChange(values, key); }

    var parent = mount;
    // collapsed:true の group は折りたたんだ状態で開始する（使用頻度の低いグループ向け・2026-09-13 追加）
    function makeGroup(label, collapsed) {
      var g = document.createElement('div');
      g.className = 'sk-grp' + (collapsed ? ' closed' : '');
      if (label) {
        var t = document.createElement('button');
        t.type = 'button'; t.className = 'sk-grp-ttl';
        t.setAttribute('aria-expanded', String(!collapsed));
        t.addEventListener('click', function () {
          var closed = g.classList.toggle('closed');
          t.setAttribute('aria-expanded', String(!closed));
        });
        t.textContent = label;
        g.appendChild(t);
      }
      mount.appendChild(g);
      return g;
    }

    spec.forEach(function (item) {
      if (item.type === 'group') { parent = makeGroup(item.label, item.collapsed); return; }
      var p = parent;
      switch (item.type) {
        case 'range': case 'number': addRange(p, item); break;
        case 'color': addColor(p, item); break;
        case 'colorset': addColorSet(p, item); break;
        case 'select': addSelect(p, item); break;
        case 'toggle': addToggle(p, item); break;
        case 'checkbox': addCheckbox(p, item); break;
        case 'button': addButton(p, item); break;
        case 'actions': addActions(p, item); break;
        default: break;
      }
    });

    /* range 行（006_ツールの規格 §5 準拠）
     *   ・数値を直接入力できる（表示だけにしない）
     *   ・stops に吸着する。Shift 中は吸着を解除して 1/10 刻み
     *   ・↑↓で1刻み、⇧↑↓は10の倍数へ乗せてから±10（イラレの粗い刻みと同じ着地）
     *   ・ラベルを左右にドラッグで増減、ダブルクリックで既定値
     * 追加で使える item のキー: unit / stops / tol
     * 既定の吸着（stops 省略時）は snapsFor() が単位から決める。*/
    function snapsFor(item) {
      if (item.stops) return item.stops;
      var u = item.unit || '', lo = +item.min, hi = +item.max, span = hi - lo, step;
      if (u === '°') {
        var angles = new Set();
        [30,45].forEach(function (step) { for (var a = Math.ceil(lo / step) * step; a <= hi; a += step) angles.add(a); });
        return Array.from(angles).sort(function (a,b) { return a-b; });
      }
      if (u === '×') return [0.5,1,1.5,2].filter(function (v) { return v >= lo && v <= hi; });
      if (u === '%') step = 50;
      else if (/^(px|mm)$/.test(u)) step = span <= 12 ? 1 : span <= 60 ? 5 : 50;  // 線の太さは1〜5・寸法は50
      else if (u === '個' || u === '本') step = span <= 12 ? 1 : span <= 60 ? 5 : 50;
      else return [];
      var out = [];
      for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
      return out;
    }
    // 吸着の許容幅は「基準値どうしの間隔の8%」を既定にする（135 の実測値がこの比率）
    function tolFor(item, stops, step) {
      if (item.tol != null) return item.tol;
      var gap = stops.length > 1 ? Math.abs(stops[1] - stops[0]) : 0;
      return Math.max(step * 1.5, gap * 0.08);
    }
    function addRange(p, item) {
      var row = document.createElement('div');
      row.className = 'sk-row sk-range' + (item.inline ? ' sk-inline' : '');
      var head = document.createElement('div'); head.className = 'sk-rowhead';
      var lab = document.createElement('label');
      lab.className = 'sk-label';
      lab.textContent = item.label || item.key;
      lab.title = '左右にドラッグ ／ ダブルクリックで既定値 ／ ↑↓で1×step・⇧↑↓で10×step';

      var min = +item.min, max = +item.max;
      var step = item.step != null ? +item.step : 1;
      var def = item.value != null ? +item.value : min;
      var integer = item.integer === true || item.unit === '個' || item.unit === '本';
      var fineStep = item.fineStep != null ? +item.fineStep : step / 10;
      if (integer) fineStep = Math.max(1, fineStep);
      if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(fineStep) || fineStep <= 0) throw new Error('stepは正の数が必要です');
      var dec = item.decimals != null ? item.decimals : decFromStep(step);
      var stops = snapsFor(item), tol = tolFor(item, stops, step);

      var num = document.createElement('input');
      num.type = 'text'; num.className = 'sk-num'; num.inputMode = 'decimal';
      if (item.wide || max >= 1e6) num.classList.add('sk-wide');
      num.setAttribute('aria-label', item.label || item.key);
      var unit = document.createElement('span'); unit.className = 'sk-unit';
      unit.textContent = item.unit || '';

      var input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step; input.value = def;
      input.setAttribute('aria-label', item.label || item.key);

      var numwrap = document.createElement('span'); numwrap.className = 'sk-numwrap';
      numwrap.appendChild(num); if (item.unit) numwrap.appendChild(unit);
      head.appendChild(lab); head.appendChild(numwrap);
      row.appendChild(head); if (item.type !== 'number') row.appendChild(input);
      p.appendChild(row);

      var fmt = item.format || function (v) { return Number.isInteger(v) ? (+v).toFixed(dec) : String(Number(v)); };
      function show(v) { input.value = v; num.value = fmt(v); }
      function clamp(v) {
        if (!Number.isFinite(v)) return Number.isFinite(values[item.key]) ? values[item.key] : def;
        v = Math.max(min, Math.min(max, v));
        return integer ? Math.max(Math.ceil(min), Math.min(Math.floor(max), Math.round(v))) : v;
      }
      function commit(v, fine, quantize) {
        v = clamp(v);
        if (!fine && stops.length) {
          for (var i = 0; i < stops.length; i++) {
            if (Math.abs(v - stops[i]) <= tol) { v = stops[i]; break; }
          }
        }
        var q = fine ? fineStep : step;
        v = clamp(+(quantize === false ? v : Math.round(v / q) * q).toFixed(12));
        show(v); values[item.key] = v; fire(item.key);
      }
      function arrow(dir, shift) {
        var cur = parseFloat(num.value);
        if (isNaN(cur)) cur = def;
        var big = step * 10;
        var target = shift ? (dir > 0 ? Math.floor(cur / big + 1e-9) + 1 : Math.ceil(cur / big - 1e-9) - 1) * big : cur + dir * step;
        commit(target, true, false);
      }
      function keyArrow(e) {
        var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
        if (d === undefined) return false;
        e.preventDefault(); arrow(d, e.shiftKey); return true;
      }
      var rangeFine = false;
      function setRangeFine(fine) { rangeFine = !!fine; input.step = rangeFine ? fineStep : step; }
      input.addEventListener('pointerdown', function (e) { setRangeFine(e.shiftKey); });
      input.addEventListener('pointermove', function (e) { if (e.buttons) setRangeFine(e.shiftKey); });
      input.addEventListener('keydown', function (e) { if (e.key === 'Shift') setRangeFine(true); });
      input.addEventListener('keyup', function (e) { if (e.key === 'Shift') setRangeFine(false); });
      input.addEventListener('pointerup', function () { setRangeFine(false); });
      input.addEventListener('input', function () { commit(+input.value, rangeFine); });
      input.addEventListener('keydown', keyArrow);
      /* 直接入力は Enter と blur の両方で明示的に確定（change 頼みは「同じ文字列で Enter」に反応しない） */
      var commitField = function () { var v = num.value.trim() === '' ? NaN : Number(num.value); show(clamp(v)); values[item.key] = clamp(v); fire(item.key); };
      num.addEventListener('keydown', function (e) { if (!keyArrow(e) && e.key === 'Enter') { commitField(); num.blur(); } });
      num.addEventListener('blur', commitField);
      /* フォーカスで全選択（イラレ準拠）。クリック直後の mouseup が選択を潰すのを1回だけ止める */
      num.addEventListener('focus', function () { num.select(); num.dataset.selAt = String(performance.now()); });
      num.addEventListener('mouseup', function (e) {
        var t0 = +num.dataset.selAt || 0;
        if (t0 && performance.now() - t0 < 400) { e.preventDefault(); num.dataset.selAt = '0'; }
      });
      lab.addEventListener('dblclick', function () { commit(def, true); });
      lab.addEventListener('pointerdown', function (e) {
        if (e.detail > 1) return;
        lab.setPointerCapture(e.pointerId);
        var x0 = e.clientX, v0 = parseFloat(num.value);
        function move(ev) { commit(v0 + (ev.clientX - x0) * (ev.shiftKey ? fineStep : step), ev.shiftKey); }
        function up() { lab.removeEventListener('pointermove', move); lab.removeEventListener('pointerup', up); }
        lab.addEventListener('pointermove', move);
        lab.addEventListener('pointerup', up);
      });

      def = clamp(def); show(def); values[item.key] = def;
      setters[item.key] = function (v) { v = clamp(+v); show(v); values[item.key] = v; };
    }

    /* color 行。既定で「なし」（none）を選べる（006_ツールの規格 §5）。
       none を出したくない行だけ item.none = false にする。 */
    function addColor(p, item) {
      var row = document.createElement('div'); row.className = 'sk-row sk-colorrow';
      var span = document.createElement('span'); span.textContent = item.label || item.key;
      var input = document.createElement('input'); input.type = 'color'; watchNativeColor(input);
      var last = (item.value && item.value !== 'none') ? item.value : '#000000';
      input.value = last;
      values[item.key] = item.value || last;
      input.addEventListener('input', function () {
        last = input.value; values[item.key] = input.value;
        if (noneBtn) noneBtn.setAttribute('aria-pressed', 'false');
        fire(item.key);
      });
      row.appendChild(span); row.appendChild(input);

      var noneBtn = null;
      if (item.none !== false) {
        noneBtn = document.createElement('button');
        noneBtn.type = 'button'; noneBtn.className = 'sk-none'; noneBtn.textContent = 'なし';
        noneBtn.setAttribute('aria-pressed', String(values[item.key] === 'none'));
        noneBtn.addEventListener('click', function () {
          var off = values[item.key] === 'none';
          values[item.key] = off ? last : 'none';
          noneBtn.setAttribute('aria-pressed', String(!off));
          fire(item.key);
        });
        row.appendChild(noneBtn);
      }
      if (item.randomizable) {
        var btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'sk-mini'; btn.textContent = '🎲';
        btn.addEventListener('click', function () {
          var c = '#' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0'); // UI 操作なので非決定でOK
          input.value = c; values[item.key] = c; fire(item.key);
        });
        row.appendChild(btn);
      }
      p.appendChild(row);
      setters[item.key] = function (v) {
        values[item.key] = v;
        if (v && v !== 'none') { input.value = v; last = v; }
        if (noneBtn) noneBtn.setAttribute('aria-pressed', String(v === 'none'));
      };
    }

    /* colorset 行（006 §5・2026-08-11 決定の対象チップ方式。正典 = 135 v2）
     *   ［塗り｜線｜背景］のチップを並べ、押された1つがピッカー・「なし」・
     *   パレットの効き先になる。イラレの塗りと線の切り替えと同じ考え方。
     * item = { type:'colorset',
     *          targets: [{key,label,value}, …],      // 例: 塗り/線/背景。value は '#rrggbb' か 'none'
     *          palettes: true }                       // Studio.PALETTES のスウォッチを下に出す（既定 true）
     * 値は values[各key]。選択中の対象は values.colorTarget / values.setColorTarget(key)。
     * X（塗り⇄線）や ⇧X（入れ替え）のキー割り当てはツール側で行う（§7）。 */
    function addColorSet(p, item) {
      var targets = item.targets || [];
      var lastHex = {};   // 「なし」から戻る時の色
      var current = targets.length ? targets[0].key : null;
      // colorToHex は {hex,alpha,none} を返す。<input type=color> 用に文字列へ落とす
      function toHex(v) { var c = colorToHex(v); return (c && c.hex) ? c.hex : '#000000'; }

      var row = document.createElement('div'); row.className = 'sk-row sk-colorset';
      var chips = document.createElement('div'); chips.className = 'sk-targets';
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', '色を変える対象');
      var chipSw = {};
      targets.forEach(function (t) {
        var v = t.value != null ? t.value : '#000000';
        values[t.key] = v;
        lastHex[t.key] = v !== 'none' ? toHex(v) : '#000000';
        var b = document.createElement('button');
        b.type = 'button'; b.dataset.k = t.key; b.title = t.label;
        var col = document.createElement('span'); col.className = 'sk-chipcol';
        var sw = document.createElement('span'); sw.className = 'sk-chipsw';
        col.appendChild(sw);
        var nm = document.createElement('span'); nm.className = 'sk-chipnm'; nm.textContent = t.label;
        b.appendChild(col); b.appendChild(nm);
        chips.appendChild(b);
        chipSw[t.key] = sw;
      });
      row.appendChild(chips);

      var edit = document.createElement('div'); edit.className = 'sk-editrow';
      var picker = document.createElement('input'); picker.type = 'color';
      picker.setAttribute('aria-label', '色');
      watchNativeColor(picker);
      var noneBtn = document.createElement('button');
      noneBtn.type = 'button'; noneBtn.className = 'sk-none'; noneBtn.textContent = 'なし';
      var hex = document.createElement('input'); hex.type = 'text'; hex.className = 'sk-hex';
      hex.maxLength = 7; hex.spellcheck = false; hex.setAttribute('aria-label', '色コード（#RRGGBB）');
      hex.placeholder = '#RRGGBB';
      var tgt = document.createElement('span'); tgt.className = 'sk-edittgt';
      edit.appendChild(tgt); edit.appendChild(picker); edit.appendChild(noneBtn); edit.appendChild(hex);
      row.appendChild(edit);

      function sync() {
        targets.forEach(function (t) {
          var v = values[t.key];
          chipSw[t.key].style.background = v === 'none' ? 'transparent' : v;
          var b = chips.querySelector('[data-k="' + t.key + '"]');
          b.setAttribute('aria-pressed', String(t.key === current));
        });
        var v = values[current], none = v === 'none';
        picker.value = none ? lastHex[current] : toHex(v);
        noneBtn.setAttribute('aria-pressed', String(none));
        hex.value = none ? '' : toHex(v).toUpperCase();
        hex.placeholder = none ? 'なし' : '#RRGGBB';
        var tl = (targets.filter(function (t) { return t.key === current; })[0] || {}).label || '';
        tgt.textContent = tl + 'を編集中';
        picker.setAttribute('aria-label', '色（' + tl + '）');
      }
      function setColor(key, val) {
        values[key] = val;
        if (val !== 'none') lastHex[key] = toHex(val);
        sync(); fire(key);
      }
      function setTarget(k) { current = k; sync(); }
      chips.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (b) setTarget(b.dataset.k);
      });
      picker.addEventListener('input', function () { setColor(current, picker.value); });
      function commitHex() {
        var h = normalizeHex(hex.value);
        if (hex.value.trim() === '') { sync(); return; }
        if (!h) { sync(); toast('色コードは #RRGGBB の形で入れる（例 #2B2B2B）', {kind:'error'}); return; }
        setColor(current, h);
      }
      hex.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitHex(); hex.blur(); } if (e.key === 'Escape') { sync(); hex.blur(); } });
      hex.addEventListener('blur', commitHex);
      hex.addEventListener('focus', function () { hex.select(); });
      noneBtn.addEventListener('click', function () {
        setColor(current, values[current] === 'none' ? lastHex[current] : 'none');
      });

      if (item.palettes !== false && PALETTES.length) {
        var palRow = document.createElement('div'); palRow.className = 'sk-palrow';
        var palSel = document.createElement('select');
        palSel.setAttribute('aria-label', 'パレット');
        PALETTES.forEach(function (pl, i) {
          var o = document.createElement('option');
          o.value = String(i); o.textContent = pl.name + '（' + pl.from + '）';
          palSel.appendChild(o);
        });
        palRow.appendChild(palSel);
        var sws = document.createElement('div'); sws.className = 'sk-swatches';
        function drawSwatches() {
          var pl = PALETTES[+palSel.value];
          sws.innerHTML = '';
          pl.colors.forEach(function (c) {
            var b = document.createElement('button');
            b.type = 'button'; b.style.background = c; b.title = c;
            b.setAttribute('aria-label', c);
            b.addEventListener('click', function () { setColor(current, c); });
            sws.appendChild(b);
          });
        }
        palSel.addEventListener('change', drawSwatches);
        drawSwatches();
        row.appendChild(palRow); row.appendChild(sws);
      }
      p.appendChild(row);

      targets.forEach(function (t) {
        setters[t.key] = function (v) {
          values[t.key] = v;
          if (v && v !== 'none') lastHex[t.key] = toHex(v);
          sync();
        };
      });
      if (!Object.prototype.hasOwnProperty.call(values, 'colorTarget')) {
        Object.defineProperty(values, 'colorTarget', { get: function () { return current; }, enumerable: false });
        Object.defineProperty(values, 'setColorTarget', { value: setTarget, enumerable: false });
      }
      sync();
    }

    function addSelect(p, item) {
      var row = document.createElement('label'); row.className = 'sk-row sk-selectrow';
      var span = document.createElement('span'); span.textContent = item.label || item.key;
      var sel = document.createElement('select');
      (item.options || []).forEach(function (o) {
        var opt = document.createElement('option');
        var val = o.value != null ? o.value : o;
        opt.value = val; opt.textContent = o.label != null ? o.label : val;
        sel.appendChild(opt);
      });
      if (item.value != null) sel.value = item.value;
      values[item.key] = sel.value;
      sel.addEventListener('change', function () { values[item.key] = sel.value; fire(item.key); });
      row.appendChild(span); row.appendChild(sel);
      p.appendChild(row);
      setters[item.key] = function (v) { sel.value = v; values[item.key] = v; };
    }

    function addToggle(p, item) {
      var row = document.createElement('div'); row.className = 'sk-row sk-toggle';
      if (item.label) { var lab = document.createElement('span'); lab.className = 'sk-togglelabel'; lab.textContent = item.label; row.appendChild(lab); }
      var wrap = document.createElement('div'); wrap.className = 'sk-seg';
      // option.icon（SVG文字列）があればアイコン+名前で描く（アイコンだけで意味を伝えない・2026-09-13 追加）
      var hasIcons = (item.options || []).some(function (o) { return o && o.icon; });
      if (hasIcons) wrap.classList.add('sk-icons');
      (item.options || []).forEach(function (o) {
        var val = o.value != null ? o.value : o;
        var btn = document.createElement('button');
        btn.type = 'button'; btn.dataset.val = val;
        var lbl = o.label != null ? o.label : val;
        if (o && o.icon) {
          if (o.title) btn.title = o.title;
          btn.setAttribute('aria-label', lbl);
          var ico = document.createElement('span'); ico.className = 'sk-ico'; ico.innerHTML = o.icon; ico.setAttribute('aria-hidden', 'true');
          var nm = document.createElement('span'); nm.className = 'sk-iconame'; nm.textContent = lbl;
          btn.appendChild(ico); btn.appendChild(nm);
        } else {
          btn.textContent = lbl;
        }
        if (val === item.value) btn.classList.add('on');
        wrap.appendChild(btn);
      });
      wrap.addEventListener('click', function (e) {
        var btn = e.target.closest('button'); if (!btn) return;
        values[item.key] = btn.dataset.val;
        Array.prototype.forEach.call(wrap.children, function (x) { x.classList.toggle('on', x === btn); });
        fire(item.key);
      });
      values[item.key] = item.value != null ? item.value : (item.options && item.options[0] ? (item.options[0].value != null ? item.options[0].value : item.options[0]) : null);
      row.appendChild(wrap);
      p.appendChild(row);
      setters[item.key] = function (v) {
        values[item.key] = v;
        Array.prototype.forEach.call(wrap.children, function (x) { x.classList.toggle('on', x.dataset.val === String(v)); });
      };
    }

    function addCheckbox(p, item) {
      var row = document.createElement('label'); row.className = 'sk-row sk-checkrow';
      var input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!item.value;
      var span = document.createElement('span'); span.textContent = item.label || item.key;
      values[item.key] = input.checked;
      input.addEventListener('change', function () { values[item.key] = input.checked; fire(item.key); });
      row.appendChild(input); row.appendChild(span);
      p.appendChild(row);
      setters[item.key] = function (v) { input.checked = !!v; values[item.key] = !!v; };
    }

    function addButton(p, item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sk-btn' + (item.primary ? ' primary' : '');
      btn.textContent = item.label || item.key;
      btn.addEventListener('click', function () { if (item.onClick) item.onClick(values); });
      p.appendChild(btn);
    }

    /* actions: アイコン付きボタンの列（例: 選択の移動・回転・複製・削除）。状態は持たず押したら onClick を呼ぶだけ。
     * item = { type:'actions', label(任意), items:[{label,title,icon,onClick}] }。見た目は addToggle の sk-icons と共通。 */
    function addActions(p, item) {
      var row = document.createElement('div'); row.className = 'sk-row sk-actions';
      if (item.label) { var lab = document.createElement('span'); lab.className = 'sk-togglelabel'; lab.textContent = item.label; row.appendChild(lab); }
      var wrap = document.createElement('div'); wrap.className = 'sk-seg sk-icons';
      (item.items || []).forEach(function (o) {
        var btn = document.createElement('button');
        btn.type = 'button';
        if (o.title) btn.title = o.title;
        btn.setAttribute('aria-label', o.label || '');
        if (o.icon) {
          var ico = document.createElement('span'); ico.className = 'sk-ico'; ico.innerHTML = o.icon; ico.setAttribute('aria-hidden', 'true');
          btn.appendChild(ico);
        }
        var nm = document.createElement('span'); nm.className = 'sk-iconame'; nm.textContent = o.label || '';
        btn.appendChild(nm);
        btn.addEventListener('click', function () { if (o.onClick) o.onClick(values); });
        wrap.appendChild(btn);
      });
      row.appendChild(wrap);
      p.appendChild(row);
    }

    // 初回描画発火（各ツールが末尾で render() を手動呼びしていたのを内蔵）
    if (opts.fireOnInit !== false) fire(null);

    // escape hatch / 外部からの値更新用（非列挙で values を汚さない）
    Object.defineProperty(values, 'set', { value: function (k, v) { if (setters[k]) setters[k](v); }, enumerable: false });
    Object.defineProperty(values, 'mount', { value: mount, enumerable: false });
    if (mount.querySelectorAll) {
      mount.querySelectorAll('.sk-grp').forEach(function (g) {
        var t = g.querySelector(':scope > .sk-grp-ttl');
        if (t) t.setAttribute('aria-expanded', String(!g.classList.contains('closed')));
      });
    }
    return values;
  }

  /* ============================================================
   * 8. キー入力（006_ツールの規格 §7・KEY-00・v0.6.0〜）
   *    Studio.keys(opts) -> { destroy(), list() }
   *    ツールは持っている機能のハンドラだけを渡す。渡していないキーは無反応のまま
   *    （ボタンを増やさない・KEY-01/KEY-04）。入力ガード・段階Esc・Spaceの再生と
   *    手のひらの切り分けをここに集約し、ツール側は keydown を自前で書かない。
   *
   *    var kb = Studio.keys({
   *      history: hist, apply: applyState,       // ⌘Z/⇧⌘Z（history渡しなら自動）
   *      copy: doCopy,                            // ⌘C
   *      outline: function(){ art.classList.toggle('outline'); },  // ⌘Y
   *      swapFillStroke: fn, toggleColorTarget: fn,                // ⇧X / X
   *      reseed: fn, rulers: fn,                                   // N / ⌘R（渡した時だけ）
   *      selectTool: fn, selectAll: fn, del: fn, cut: fn, paste: fn, duplicate: fn,
   *      pasteSVG: function(svgText){ … },     // ⌘V で Illustrator 等の SVG を受ける（paste イベント経由・v0.7.7）
   *      toggleAnchors: fn,                       // ⌘H アンカーの表示を切り替え（§7・v0.7.9）
   *      play: fn, pan: function(on){ … },        // Space（短押し=再生/停止・押下ドラッグ=手のひら）
   *      escSteps: [fnStep1, fnStep2, …],          // 先頭から呼び、true を返した段で止める
   *      extra: { 'shift+meta+k': fn }             // 表にない独自キー
   *    });
   *    kb.list() -> [{keys:'⌘Z', label:'取り消し'}, …]（有効なキーだけ・チートシート用）
   * ============================================================ */
  var KEY_LIST = [
    { id: 'undo', keys: '⌘Z', label: '取り消し' },
    { id: 'redo', keys: '⇧⌘Z', label: 'やり直し' },
    { id: 'copy', keys: '⌘C', label: 'SVGをコピー' },
    { id: 'outline', keys: '⌘Y', label: 'アウトライン表示の切り替え' },
    { id: 'toggleColorTarget', keys: 'X', label: '塗りと線の切り替え' },
    { id: 'swapFillStroke', keys: '⇧X', label: '塗りと線を入れ替え' },
    { id: 'play', keys: 'Space', label: '再生／停止' },
    { id: 'esc', keys: 'Esc', label: '選択解除・モード脱出' },
    { id: 'selectTool', keys: 'V', label: '選択ツールへ切り替え' },
    { id: 'selectAll', keys: '⌘A', label: '全選択' },
    { id: 'del', keys: 'Delete', label: '選択を削除' },
    { id: 'cut', keys: '⌘X', label: 'カット' },
    { id: 'paste', keys: '⌘V', label: 'ペースト' },
    { id: 'pasteSVG', keys: '⌘V', label: 'SVGを貼る' },
    { id: 'duplicate', keys: '⌘D', label: '複製' },
    { id: 'reseed', keys: 'N', label: '種を撒き直す' },
    { id: 'rulers', keys: '⌘R', label: '定規の表示' },
    { id: 'toggleAnchors', keys: '⌘H', label: 'アンカーの表示を切り替え' }
  ];

  // 文字を打つ欄だけを「入力中」とみなす（§7 ルール3）。チェック・スライダー・色・ボタンを触った直後に
  // ⌘Z や Space が効かなくなるストレスを無くす（2026-10-10 ユーザー「スペースをしたら映像再生できない」・150/134 で実測）
  var NON_TEXT_INPUT = { range: 1, checkbox: 1, radio: 1, button: 1, submit: 1, reset: 1, color: 1, file: 1, image: 1 };
  function isEditableTarget(t) {
    if (!t) return false;
    var tag = t.tagName;
    if (tag === 'INPUT') return !NON_TEXT_INPUT[String(t.type || 'text').toLowerCase()];
    return tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }
  // Space を奪ってよい対象（ボタン・スライダー・チェック・選択欄の上でも再生を優先する。文字欄は素通し）
  function spaceTakesOver(t) {
    if (!t) return true;
    var tag = t.tagName;
    if (tag === 'TEXTAREA' || t.isContentEditable === true) return false;
    if (tag === 'INPUT') return !!NON_TEXT_INPUT[String(t.type || 'text').toLowerCase()];
    return true;   // BUTTON・SELECT・その他
  }
  function isSpaceKey(e) {
    return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
  }
  function comboKey(e) {
    var parts = [];
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey || e.ctrlKey) parts.push('meta');
    if (e.altKey) parts.push('alt');
    parts.push(String(e.key).toLowerCase());
    return parts.join('+');
  }

  function codeCombo(e) {
    var c = String(e.code || ''), k = '';
    if (/^Digit\d$/.test(c)) k = c.slice(5); else if (/^Key[A-Z]$/.test(c)) k = c.slice(3).toLowerCase();
    if (!k) return '';
    var parts = [];
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey || e.ctrlKey) parts.push('meta');
    if (e.altKey) parts.push('alt');
    parts.push(k);
    return parts.join('+');
  }

  function keys(opts) {
    opts = opts || {};
    // Node等documentもaddEventListenerも無い環境では登録せず空のAPIだけ返す（require時に例外を出さない）
    if (typeof addEventListener === 'undefined') return { destroy: function () {}, list: function () { return []; } };

    var hist = opts.history || null;
    var escSteps = opts.escSteps || [];
    var isPlaying = false;
    var spaceHeld = false, spaceDragged = false, panActive = false;

    function has(id) {
      if (id === 'undo') return !!(opts.undo || hist);
      if (id === 'redo') return !!(opts.redo || hist);
      if (id === 'esc') return escSteps.length > 0 || !!opts.play;
      return !!opts[id];
    }

    function fireUndo(shift) {
      if (shift) {
        if (opts.redo) { opts.redo(); return; }
        if (hist) { var s = hist.redo(); if (s != null && opts.apply) opts.apply(s); }
      } else {
        if (opts.undo) { opts.undo(); return; }
        if (hist) { var s2 = hist.undo(); if (s2 != null && opts.apply) opts.apply(s2); }
      }
    }

    function firePlay() {
      if (!opts.play) return;
      opts.play();
      isPlaying = !isPlaying;
    }

    function fireEsc() {
      for (var i = 0; i < escSteps.length; i++) {
        if (typeof escSteps[i] === 'function' && escSteps[i]()) return;
      }
      if (isPlaying && opts.play) { opts.play(); isPlaying = false; }
    }

    function onKeyDown(e) {
      if (e.isComposing) return;
      if (isSpaceKey(e) && (opts.play || opts.pan) && spaceTakesOver(e.target)) {
        if (!e.repeat) { spaceHeld = true; spaceDragged = false; }
        e.preventDefault();   // ボタンの押下・選択欄の展開・チェックの切替に Space を渡さない
        return;
      }
      // スライダー上の矢印は値の微調整に使う（ブラウザ標準）。kit の矢印処理に回さない
      if (e.target && e.target.type === 'range' && /^Arrow/.test(e.key)) return;
      if (isEditableTarget(e.target)) return;   // §7 ルール3（入力ガード必須）
      if (isSpaceKey(e)) {
        if (opts.play || opts.pan) {
          if (!e.repeat) { spaceHeld = true; spaceDragged = false; }
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (!has('esc')) return;
        e.preventDefault(); fireEsc(); return;
      }
      var meta = e.metaKey || e.ctrlKey;
      var k = String(e.key).toLowerCase();
      if (meta && !e.altKey && k === 'z' && has('undo')) { e.preventDefault(); fireUndo(e.shiftKey); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'c' && opts.copy) { e.preventDefault(); opts.copy(); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'y' && opts.outline) { e.preventDefault(); opts.outline(); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'a' && opts.selectAll) { e.preventDefault(); opts.selectAll(); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'x' && opts.cut) { e.preventDefault(); opts.cut(); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'v' && opts.pasteSVG) return;   // §7 ⌘V: 奪わずに paste イベントで受ける（Illustrator の SVG を読むため）
      if (meta && !e.shiftKey && !e.altKey && k === 'v' && opts.paste) { e.preventDefault(); opts.paste(); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'd' && opts.duplicate) { e.preventDefault(); opts.duplicate(); return; }
      if (meta && !e.shiftKey && !e.altKey && k === 'r' && opts.rulers) { e.preventDefault(); opts.rulers(); return; }
      // ⌘H アンカーの表示（§7・2026-10-12）。macOS Chrome の「隠す」より先に受けるので preventDefault が要る
      if (meta && !e.shiftKey && !e.altKey && k === 'h' && opts.toggleAnchors) { e.preventDefault(); opts.toggleAnchors(); return; }
      // ⌘付きの独自キー（⌘0・⌘J・⌘⇧⌥4 など）も extra で受ける。⌥で e.key が変わる配列は e.code（Digit4・KeyA）でも引く（2026-10-10・105/122/139 の要望）
      if (meta && opts.extra) {
        var mc = comboKey(e), mcode = codeCombo(e);
        var fn = opts.extra[mc] || (mcode && opts.extra[mcode]);
        if (fn) { e.preventDefault(); fn(); return; }
      }
      if (meta) return;   // §7 ルール2: ⌘S/⌘P/⌘O/⌘W/⌘R含め、割り当てていないブラウザのキーは奪わない
      if (e.shiftKey && k === 'x' && opts.swapFillStroke) { e.preventDefault(); opts.swapFillStroke(); return; }
      if (!e.shiftKey && k === 'x' && opts.toggleColorTarget) { e.preventDefault(); opts.toggleColorTarget(); return; }
      if (!e.shiftKey && k === 'v' && opts.selectTool) { e.preventDefault(); opts.selectTool(); return; }
      if (!e.shiftKey && k === 'n' && opts.reseed) { e.preventDefault(); opts.reseed(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && opts.del) { e.preventDefault(); opts.del(); return; }
      if (opts.extra) {
        var combo = comboKey(e);
        if (opts.extra[combo]) { e.preventDefault(); opts.extra[combo](); return; }
      }
    }

    function onKeyUp(e) {
      if (!isSpaceKey(e)) return;
      if (spaceHeld && spaceTakesOver(e.target)) e.preventDefault();   // ボタンは keyup で押される＝ここでも止める
      if (spaceHeld && !spaceDragged) firePlay();
      spaceHeld = false;
      if (panActive && opts.pan) { opts.pan(false); panActive = false; }
    }

    function onPointerDown() {
      if (!spaceHeld) return;
      spaceDragged = true;
      if (opts.pan) { panActive = true; opts.pan(true); }
    }

    // ⌘V（§7・§8「受ける」）: システムのクリップボードを image/svg+xml → text/plain → text/html の順に読む。
    // SVG が無ければ内部クリップボード（opts.paste）へ回す。入力欄の貼り付けは素通し
    function onPaste(e) {
      if (!opts.pasteSVG || isEditableTarget(e.target)) return;
      var cd = e.clipboardData, text = '';
      if (cd) {
        var types = ['image/svg+xml', 'text/plain', 'text/html'];
        for (var i = 0; i < types.length && !text; i++) {
          var t = cd.getData(types[i]) || '';
          if (/<svg[\s>]|<path[\s>]|<(rect|circle|ellipse|polygon|polyline|line)[\s>]/i.test(t)) text = t;
          else if (/^\s*[Mm]\s*[-+.\d]/.test(t) && /^[\sMmLlHhVvCcSsQqTtAaZz\d.,eE+-]+$/.test(t)) text = '<svg xmlns="http://www.w3.org/2000/svg"><path d="' + t.trim() + '"/></svg>';   // パスデータだけ（d 属性の中身）も SVG に包んで渡す
        }
      }
      e.preventDefault();
      if (text) { opts.pasteSVG(text); return; }
      if (opts.paste) { opts.paste(); return; }
      toast('貼れる SVG がありません（Illustrator は 環境設定 → ファイル管理とクリップボード →「SVGコード」を ON）', { kind: 'error', sticky: true });
    }

    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    addEventListener('pointerdown', onPointerDown);
    addEventListener('paste', onPaste);

    return {
      destroy: function () {
        removeEventListener('keydown', onKeyDown);
        removeEventListener('keyup', onKeyUp);
        removeEventListener('pointerdown', onPointerDown);
        removeEventListener('paste', onPaste);
      },
      list: function () {
        return KEY_LIST.filter(function (item) { return has(item.id); })
          .map(function (item) { return { keys: item.keys, label: item.label }; });
      }
    };
  }

  return {
    version: VERSION,
    rng: makeRng,
    dl: dl,
    colorToHex: colorToHex,
    serializeSVG: serializeSVG,
    exportSVG: exportSVG,
    exportPNG: exportPNG,
    exportZIP: exportZIP,
    buildStoreZip: buildStoreZip,
    panel: panel,
    appBar: appBar,           // 同 §6（上部バー。studio2.css とセット）
    stageBar: stageBar,       // 同 §6・§13（上部バー共通操作: 大きさ・背景・色・再生・A/B・映像）
    SIZES: SIZES,             // 同 §13 VID-01（大きさプリセット）
    motion: {                 // 同 §13 VID-02（補間の純粋関数。stageBarの内部実装・単体テスト用）
      interpolateParams: interpolateParams,
      pingpongU: pingpongU,
      easeFn: easeFn,
      fileNames: motionFileNames
    },
    fitInto: fitInto,         // 同 §0 版面（インスタONで絵を枠に収める一様拡縮。回しても変わらない外接を渡す）
    toast: toast,             // 同 §6（結果を必ず画面に出す）
    history: history,         // 同 §7（⌘Z/⇧⌘Z 用のスナップショット履歴）
    keys: keys,                // 同 §7・KEY-00（キー入力を1本化。入力ガード・段階Esc・Space込み）
    fname: fname,             // 006_ツールの規格 §3
    provenance: provenance,   // 同 §1（文字列組み立てツール用）
    caption: caption,         // 同 §2（文字列組み立てツール用）
    PALETTES: PALETTES,       // 同 §5（作品の色の規定パレット）
    copySVG: copySVG,         // 同 §8（イラレへ ⌘V でベクター貼り付け）
    copyResultMessage: copyResultMessage, // 同 §8（コピー3経路の結果を通知文にする）
    normalizeHex: normalizeHex,
    inspectEnvelope: inspectEnvelope,
    validateEnvelope: validateEnvelope,
    prepareRestore: prepareRestore,
    readEnvelope: readEnvelope, // 同 §1（書き出したSVGから設定を読み戻す）
    onDropSVG: onDropSVG      // 同 §1（SVGをドロップして設定を復元する）
  };
});
