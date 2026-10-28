/* ============================================================================
   angle-dial.js — 「角度は端で止まらず循環する」入力部品（段3・UMD）。
   normAngle() は DOM非依存の純関数（node でも動く）。
   createRow() はブラウザ専用（document が無い環境では呼ばない・呼んだら例外）。

   対象キー（sweep-along/spec.md 段3-2）: 位相・固定角・傾き・縦に回す・横に回す。
   ・数値欄はどんな値でも受け、blur/Enterで0〜360未満へ正規化（-10→350）。
   ・帯（高さ約24px・cursor:ew-resize）を左右にドラッグすると増減する。端が無い
     （値は常にmod 360）。1px=0.5°・Shiftで0.1°。↑↓/←→で±1°（Shiftで±10°）。
   ・帯には10°ごとの目盛りをcanvasで描き、値が変わるたびに流れて見えるようにする
     （中央に固定の目印を置き、目盛り側が動く＝ドラッグ量がそのまま見える）。
   ========================================================================== */
(function (root, factory) {
  var AngleDial = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = AngleDial;
  if (root) root.AngleDial = AngleDial;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==========================================================================
     normAngle(v) — 任意の数値を 0 <= v < 360 へ正規化する（循環）。
     ========================================================================== */
  function normAngle(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return 0;
    var m = n % 360;
    if (m < 0) m += 360;
    /* 浮動小数点の丸めで、ごく小さい負の値(-1e-15など)が m+=360 の加算で
       ちょうど360.0に丸まってしまうことがある（circularLerpがatan2経由でこの
       境界に落ちるケースで実際に発生）。契約(0<=v<360)を保証するため、
       360ちょうどになった場合だけ0へ戻す。 */
    if (m >= 360) m -= 360;
    return m;
  }

  /* ==========================================================================
     circularLerp(a, b, t) — 角度の円形補間（段6-A-4）。
     (cos,sin) 成分をそれぞれ線形補間してから atan2 で戻す＝常に短い方の経路を通る
     （350→10 は 340 進むのではなく 20 進む）。t=0→a・t=1→b・戻り値は0〜360未満。
     ========================================================================== */
  function circularLerp(a, b, t) {
    var ra = normAngle(a) * Math.PI / 180, rb = normAngle(b) * Math.PI / 180;
    var ca = Math.cos(ra), sa = Math.sin(ra);
    var cb = Math.cos(rb), sb = Math.sin(rb);
    var cx = ca + (cb - ca) * t, cy = sa + (sb - sa) * t;
    return normAngle(Math.atan2(cy, cx) * 180 / Math.PI);
  }

  /* ==========================================================================
     createRow(opts) — 角度行のDOMを1つ作る（kitのrange行と見た目を揃える）。
     opts: { key, label, unit('°'既定), initial(数値・任意), onChange(normalizedValue) }
     戻り値: { el, getValue(), setValue(v) }。setValue はonChangeを呼ばない
     （封筒からの復元など、静かに値だけ合わせたい場面向け・kitのvalues.setと同じ約束）。
     ========================================================================== */
  function createRow(opts) {
    if (typeof document === 'undefined') throw new Error('AngleDial.createRow はブラウザ専用です');
    opts = opts || {};
    var label = opts.label || opts.key || '';
    var unit = opts.unit || '°';
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    var current = normAngle(opts.initial != null ? opts.initial : 0);

    var row = document.createElement('div');
    row.className = 'sk-row sk-anglerow';

    var head = document.createElement('div'); head.className = 'sk-rowhead';
    var lab = document.createElement('label'); lab.className = 'sk-label'; lab.textContent = label;
    var numwrap = document.createElement('span'); numwrap.className = 'sk-numwrap';
    var num = document.createElement('input');
    num.type = 'text'; num.className = 'sk-num'; num.inputMode = 'decimal';
    num.setAttribute('aria-label', label);
    var unitEl = document.createElement('span'); unitEl.className = 'sk-unit'; unitEl.textContent = unit;
    numwrap.appendChild(num); numwrap.appendChild(unitEl);
    head.appendChild(lab); head.appendChild(numwrap);
    row.appendChild(head);

    var band = document.createElement('div');
    band.className = 'sk-angleband';
    band.tabIndex = 0;
    band.setAttribute('role', 'slider');
    band.setAttribute('aria-label', label);
    band.setAttribute('aria-valuemin', '0');
    band.setAttribute('aria-valuemax', '360');
    var canvas = document.createElement('canvas');
    band.appendChild(canvas);
    row.appendChild(band);

    var ctx = canvas.getContext && canvas.getContext('2d');

    function sizeCanvas() {
      var w = band.clientWidth || 260, h = band.clientHeight || 24;
      var ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      canvas.width = Math.max(1, Math.round(w * ratio));
      canvas.height = Math.max(1, Math.round(h * ratio));
      if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function colors() {
      var cs = (typeof getComputedStyle === 'function') ? getComputedStyle(document.documentElement) : null;
      function v(name, fallback) { var s = cs && cs.getPropertyValue(name); s = s && s.trim(); return s || fallback; }
      return { minor: v('--outline', '#999'), major: v('--onSurfaceVariant', '#666'), mark: v('--primary', '#006066') };
    }

    /* 目盛りは中央(帯の真ん中)を基準に、値からの差分(°)×pxPerDegでxを決める。
       中央の目印は固定なので、値が動くと目盛り側が流れて見える。
       pxPerDeg=2はドラッグの「1px=0.5°」と対になる換算（操作量と目盛りの流れが一致する）。 */
    function draw() {
      if (!ctx) return;
      var w = band.clientWidth || 260, h = band.clientHeight || 24;
      ctx.clearRect(0, 0, w, h);
      var col = colors();
      var pxPerDeg = 2;
      var cx = w / 2;
      var startDeg = Math.floor((current - w / (2 * pxPerDeg)) / 10) * 10;
      var endDeg = current + w / (2 * pxPerDeg);
      ctx.lineWidth = 1;
      for (var d = startDeg; d <= endDeg; d += 10) {
        var x = cx + (d - current) * pxPerDeg;
        var major = normAngle(Math.round(d)) % 90 === 0;
        ctx.strokeStyle = major ? col.major : col.minor;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, major ? 3 : h * 0.32);
        ctx.lineTo(x + 0.5, major ? h - 3 : h * 0.68);
        ctx.stroke();
      }
      ctx.strokeStyle = col.mark;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, 1); ctx.lineTo(cx, h - 1); ctx.stroke();
    }

    function fmt(v) { return String(Math.round(v * 10) / 10); }
    function show() {
      num.value = fmt(current);
      band.setAttribute('aria-valuenow', String(Math.round(current)));
      draw();
    }
    function apply(v, fire) {
      current = normAngle(v);
      show();
      if (fire) onChange(current);
    }

    /* ドラッグ: 帯を左右に引っ張り続けられる（端が無い＝常にmod 360）。
       1px=0.5°・Shiftで0.1°。kitのrange行のラベルドラッグ(絶対アンカー方式)と同じ考え方。 */
    band.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      band.focus();
      band.setPointerCapture(e.pointerId);
      var x0 = e.clientX, v0 = current;
      function move(ev) {
        var perPx = ev.shiftKey ? 0.1 : 0.5;
        apply(v0 + (ev.clientX - x0) * perPx, true);
      }
      function up() {
        band.removeEventListener('pointermove', move);
        band.removeEventListener('pointerup', up);
      }
      band.addEventListener('pointermove', move);
      band.addEventListener('pointerup', up);
    });

    /* キーボード: ↑→で+1、↓←で-1。Shiftで±10（kitのkeyArrowと同じ割り当て）。 */
    band.addEventListener('keydown', function (e) {
      var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d === undefined) return;
      e.preventDefault();
      apply(current + d * (e.shiftKey ? 10 : 1), true);
    });

    /* 数値欄: 入力中はそのまま受け、Enter/blurで確定・正規化する */
    function commitField() {
      var raw = num.value.trim();
      var v = raw === '' ? current : Number(raw);
      apply(Number.isFinite(v) ? v : current, true);
    }
    num.addEventListener('keydown', function (e) { if (e.key === 'Enter') { commitField(); num.blur(); } });
    num.addEventListener('blur', commitField);
    num.addEventListener('focus', function () { num.select(); });

    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () { sizeCanvas(); draw(); });
      ro.observe(band);
    }
    sizeCanvas(); show();
    // 挿入直後はclientWidthが0のことがある（レイアウト未確定）ため、次フレームで合わせ直す
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { sizeCanvas(); draw(); });

    return {
      el: row,
      getValue: function () { return current; },
      setValue: function (v) { apply(v, false); }
    };
  }

  return { normAngle: normAngle, circularLerp: circularLerp, createRow: createRow };
});
