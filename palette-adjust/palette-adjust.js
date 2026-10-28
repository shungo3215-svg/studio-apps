/* 配色の調整: SVG の色の抽出・OKLCH 変換・案の生成・置換。
   oklch / hexOf / normColor / generate / apply は DOM 非依存（node で読める）。parse だけ DOMParser を使う。
   OKLab の係数は Björn Ottosson 版（03_knowledge/010_制作技法/スキル/配色の調整/oklch.py の写し）。 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PaletteAdjust = api;
})(this, function () {
  'use strict';

  /* ---------- 色の変換 ---------- */
  function h2r(h) { h = h.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }); }
  function r2h(r) {
    return '#' + r.map(function (v) {
      var n = Math.max(0, Math.min(255, Math.round(v * 255)));
      return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
    }).join('');
  }
  function lin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function gam(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  function oklch(hex) {
    var rgb = h2r(hex).map(lin), r = rgb[0], g = rgb[1], b = rgb[2];
    var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    l = Math.cbrt(l); m = Math.cbrt(m); s = Math.cbrt(s);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    var a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    var H = Math.atan2(bb, a) * 180 / Math.PI; H = ((H % 360) + 360) % 360;
    return { L: L, C: Math.hypot(a, bb), H: H };
  }
  function hexOf(L, C, H) {
    var a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180);
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    var bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return r2h([r, g, bl].map(function (c) { return gam(Math.max(0, Math.min(1, c))); }));
  }

  /* 色の文字列 → '#RRGGBB'。none / transparent / url() / 未対応の名前は null */
  var NAMED = { white: '#FFFFFF', black: '#000000' };
  function normColor(s) {
    if (s == null) return null;
    s = String(s).trim();
    var m;
    if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return '#' + m[1].toUpperCase();
    if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s))) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
    if ((m = /^rgb\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*\)$/i.exec(s))) {
      var v = [[m[1], m[2]], [m[3], m[4]], [m[5], m[6]]].map(function (p) {
        var n = parseFloat(p[0]); if (p[1]) n = n * 2.55; return Math.max(0, Math.min(255, Math.round(n))) / 255;
      });
      return r2h(v);
    }
    var k = s.toLowerCase();
    return NAMED[k] || null;
  }

  /* 系統名（暗端の色相から） */
  function hueName(hex) {
    var o = oklch(hex);
    if (o.C < 0.02) return '無彩色';
    var H = o.H;
    if (H >= 345 || H < 40) return '赤系';
    if (H < 70) return '橙系';
    if (H < 115) return '黄系';
    if (H < 195) return '緑系';
    if (H < 275) return '青系';
    return '紫系';
  }

  /* ---------- 色の出所を拾う（文字列走査: 属性・style・<style> を同じ規則で） ---------- */
  var PROP_RE = /(?<![\w-])(fill|stroke|stop-color)(\s*[:=]\s*["']?\s*)(#[0-9a-fA-F]{3,6}\b|rgb\([^)]*\)|[a-zA-Z]+)/g;

  function scanColors(text) {
    var map = {}, order = [];
    var m; PROP_RE.lastIndex = 0;
    while ((m = PROP_RE.exec(text))) {
      var hex = normColor(m[3]); if (!hex) continue;
      var e = map[hex]; if (!e) { e = map[hex] = { hex: hex, uses: { fill: 0, stroke: 0, stop: 0 }, count: 0 }; order.push(hex); }
      var u = m[1] === 'stop-color' ? 'stop' : m[1];
      e.uses[u]++; e.count++;
    }
    return order.map(function (h) { return map[h]; });
  }

  function cssRules(doc) {
    var rules = {}, styles = doc.getElementsByTagName('style');
    for (var i = 0; i < styles.length; i++) {
      var css = styles[i].textContent, re = /\.([\w-]+)\s*\{([^}]*)\}/g, m;
      while ((m = re.exec(css))) {
        var d = rules[m[1]] || (rules[m[1]] = {});
        m[2].split(';').forEach(function (kv) {
          var p = kv.split(':'); if (p.length < 2) return;
          d[p[0].trim()] = p.slice(1).join(':').trim();
        });
      }
    }
    return rules;
  }
  function elProp(el, prop, rules) {
    var v = el.getAttribute(prop);
    var st = el.getAttribute('style');
    if (st) {
      st.split(';').forEach(function (kv) { var p = kv.split(':'); if (p.length > 1 && p[0].trim() === prop) v = p.slice(1).join(':').trim(); });
    }
    var cls = el.getAttribute('class');
    if (v == null && cls) cls.split(/\s+/).forEach(function (c) { if (rules[c] && rules[c][prop] != null) v = rules[c][prop]; });
    return v;
  }

  function parse(svgText) {
    if (typeof DOMParser === 'undefined') throw new Error('parse は DOMParser が要ります');
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement || doc.documentElement.localName !== 'svg') {
      throw new Error('SVG として読めませんでした');
    }
    var rules = cssRules(doc);
    var svg = doc.documentElement;

    // グラデ: 自分の stop か、xlink:href の先の stop
    var gEls = Array.prototype.slice.call(doc.querySelectorAll('linearGradient, radialGradient'));
    var byId = {}; gEls.forEach(function (g) { if (g.getAttribute('id')) byId[g.getAttribute('id')] = g; });
    function stopsOf(g, depth) {
      var own = Array.prototype.filter.call(g.children, function (c) { return c.localName === 'stop'; });
      if (own.length) return own.map(function (s) { return normColor(elProp(s, 'stop-color', rules)) || '#000000'; });
      var ref = g.getAttribute('xlink:href') || g.getAttribute('href');
      if (ref && ref.charAt(0) === '#' && byId[ref.slice(1)] && (depth || 0) < 8) return stopsOf(byId[ref.slice(1)], (depth || 0) + 1);
      return [];
    }
    var sys = {}, gradients = [];
    gEls.forEach(function (g) {
      var st = stopsOf(g); if (!st.length) return;
      var key = st.join(','), e = sys[key];
      if (!e) {
        var dark = st.reduce(function (a, b) { return oklch(b).L < oklch(a).L ? b : a; });
        e = sys[key] = { id: key, ids: [], stops: st, hueName: hueName(dark) };
        gradients.push(e);
      }
      if (g.getAttribute('id')) e.ids.push(g.getAttribute('id'));
    });

    // 単色: stop 以外の fill / stroke
    var all = scanColors(svgText);
    var colors = [];
    all.forEach(function (c) {
      if (c.uses.fill + c.uses.stroke > 0) colors.push({ hex: c.hex, uses: c.uses, count: c.count - c.uses.stop });
    });

    // 背景: viewBox と同寸の rect の fill
    var bgHex = null;
    var vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4) {
      var rects = svg.getElementsByTagName('rect');
      for (var i = 0; i < rects.length && !bgHex; i++) {
        var r = rects[i];
        var w = parseFloat(r.getAttribute('width')), h = parseFloat(r.getAttribute('height'));
        var x = parseFloat(r.getAttribute('x') || 0), y = parseFloat(r.getAttribute('y') || 0);
        if (Math.abs(w - vb[2]) < 0.5 && Math.abs(h - vb[3]) < 0.5 && Math.abs(x - vb[0]) < 0.5 && Math.abs(y - vb[1]) < 0.5) {
          bgHex = normColor(elProp(r, 'fill', rules));
        }
      }
    }
    return { colors: colors, gradients: gradients, bgHex: bgHex };
  }

  /* ---------- 案の生成 ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* 幅の中でランダムに。0 に近すぎると案が見分けにくいので大きさは幅の 40〜100% */
  function draw(rng, w) { if (!w) return 0; var s = rng() < 0.5 ? -1 : 1; return s * w * (0.4 + 0.6 * rng()); }

  /* model: parse の戻り値。opts: {L, C(%), H, lockHue, fixed:{ '#HEX' | 'g:<番号>': true }, names:{ 'g:<番号>': '名前' }} */
  function generate(model, opts, seed) {
    var rng = mulberry32(seed | 0), mapping = {}, deltas = [];
    var fixed = opts.fixed || {}, names = opts.names || {};
    function pick() {
      return { dL: draw(rng, opts.L), dC: draw(rng, opts.C), dH: opts.lockHue ? (draw(rng, opts.H), 0) : draw(rng, opts.H) };
    }
    model.gradients.forEach(function (g, gi) {
      var key = 'g:' + gi;
      var d = pick();
      if (fixed[key]) return;
      var Ls = g.stops.map(function (s) { return oklch(s).L; });
      var lo = Math.min.apply(null, Ls), hi = Math.max.apply(null, Ls);
      var Ld = clamp(lo + d.dL, 0, 1), Ll = clamp(hi + d.dL, 0, 1);
      g.stops.forEach(function (s) {
        var o = oklch(s), t = hi > lo ? (o.L - lo) / (hi - lo) : 0;
        mapping[s] = hexOf(Ld + (Ll - Ld) * t, Math.max(0, o.C + d.dC), o.H + d.dH);
      });
      deltas.push({ kind: 'gradient', key: key, name: names[key] || g.hueName, dL: d.dL, dC: d.dC, dH: d.dH });
    });
    model.colors.forEach(function (c) {
      var d = pick();
      if (fixed[c.hex]) return;
      var o = oklch(c.hex);
      mapping[c.hex] = hexOf(clamp(o.L + d.dL, 0, 1), Math.max(0, o.C + d.dC), o.H + d.dH);
      deltas.push({ kind: 'color', key: c.hex, name: c.hex, dL: d.dL, dC: d.dC, dH: d.dH });
    });
    return { mapping: mapping, deltas: deltas, seed: seed };
  }

  /* 元の全出所（属性・style・<style>）の色を置換した SVG 文字列 */
  function apply(svgText, mapping) {
    var up = {}; Object.keys(mapping).forEach(function (k) { up[k.toUpperCase()] = mapping[k].toUpperCase(); });
    return svgText.replace(PROP_RE, function (all, prop, sep, tok) {
      var hex = normColor(tok);
      return hex && up[hex] ? prop + sep + up[hex] : all;
    });
  }

  function signed(v, digits, unit) {
    var n = Math.abs(v).toFixed(digits);
    if (Number(n) === 0) return '0' + unit;
    return (v < 0 ? '−' : '+') + n + unit;
  }
  function deltaText(d) {
    return d.name + ' L ' + signed(d.dL, 2, '') + ' / C ' + signed(d.dC, 3, '') + ' / H ' + signed(d.dH, 0, '°');
  }

  return { oklch: oklch, hexOf: hexOf, normColor: normColor, hueName: hueName, parse: parse, scanColors: scanColors,
    generate: generate, apply: apply, deltaText: deltaText, mulberry32: mulberry32 };
});
