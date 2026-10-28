/* Studio mobile: 元の部品とハンドラーを保持して並べ替える。 */
(function () {
  'use strict';
  if (!matchMedia('(max-width:700px)').matches && !/(?:^|[?&])m=1(?:&|$)/.test(location.search)) return;
  document.documentElement.classList.add('studio-mobile');
  var HTML = document.documentElement;
  function mk(tag, cls, text) { var n = document.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; }
  // ---- 操作の記録（実機で何が起きたかを後から見る）。版面の pointer/touch を直近 200 件だけメモリに回す。重い処理はしない ----
  var LOG_MAX = 200, logBuf = [], errBuf = [], T0 = performance.now(), logView = null;
  function now() { return Math.round(performance.now() - T0); }
  function tagOf(n) {
    if (n === window) return 'window'; if (n === document) return 'document';
    if (!n || !n.tagName) return String(n && n.nodeName || '-');
    var s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id; else if (n.classList && n.classList.length) s += '.' + n.classList[0];
    if (!n.isConnected) s += '(detached)';
    return s;
  }
  function logPush(r) { logBuf.push(r); if (logBuf.length > LOG_MAX) logBuf.shift(); }
  function logNote(kind, detail) { logPush({ t: now(), type: 'sm:' + kind, detail: String(detail || '') }); }
  function errPush(kind, msg) { errBuf.push({ t: now(), kind: kind, msg: String(msg).slice(0, 400) }); if (errBuf.length > 50) errBuf.shift(); }
  function inViewRect(x, y) { if (!logView) return false; var r = logView.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
  function onLogEvent(e) {
    if (!logView) return;
    var tg = e.target, touch = e.changedTouches && e.changedTouches[0], x = touch ? touch.clientX : e.clientX, y = touch ? touch.clientY : e.clientY;
    var mine = tg && tg.nodeType === 1 && (logView.contains(tg) || !tg.isConnected);
    // 版面の上の操作だけ。押し始めは、版面の位置に重なった幕・通知が受けた物も残す（塞がれていたかが分かる）
    if (!mine && !((e.type === 'pointerdown' || e.type === 'touchstart') && inViewRect(x, y))) return;
    logPush({ t: now(), type: e.type, pointerType: e.pointerType || (touch ? 'touch-event' : ''), pointerId: e.pointerId != null ? e.pointerId : (touch ? touch.identifier : null),
      isPrimary: e.isPrimary, trusted: e.isTrusted, target: tagOf(tg), x: Math.round(x || 0), y: Math.round(y || 0),
      touches: e.touches ? e.touches.length : undefined, ev: e });
  }
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'gesturestart'].forEach(function (ty) {
    window.addEventListener(ty, onLogEvent, { capture: true, passive: true });
  });
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.tagName) errPush('resource', tagOf(e.target) + ' ' + (e.target.src || e.target.href || ''));
    else errPush('pageerror', (e.message || '') + ' @' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { errPush('rejection', e.reason && (e.reason.stack || e.reason.message) || e.reason); });
  var nativeConsoleError = console.error;
  console.error = function () {
    try { errPush('console.error', Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : String(a); }).join(' ')); } catch (err) {}
    return nativeConsoleError.apply(console, arguments);
  };
  function buildText() { var b = HTML.dataset.smBuild; return b && b !== '__SM_BUILD__' ? b : '未ビルド（開発中の画面）'; }
  function logRecord(r) {
    var o = {}; Object.keys(r).forEach(function (k) { if (k !== 'ev' && r[k] !== undefined) o[k] = r[k]; });
    if (r.ev) o.defaultPrevented = r.ev.defaultPrevented;
    return o;
  }
  function logDump() {
    var standalone = !!navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    return { app: HTML.dataset.smApp || '', build: buildText(), at: new Date().toISOString(), ua: navigator.userAgent,
      screen: { innerWidth: innerWidth, innerHeight: innerHeight, dpr: window.devicePixelRatio, width: screen.width, height: screen.height, standalone: standalone },
      serviceWorker: navigator.serviceWorker ? (navigator.serviceWorker.controller ? 'controlled' : 'not-controlled') : 'none',
      events: logBuf.map(logRecord), errors: errBuf.slice() };
  }
  function logLines(n) {
    var out = errBuf.slice(-3).reverse().map(function (e) { return (e.t / 1000).toFixed(2) + ' エラー ' + e.kind + ': ' + e.msg.slice(0, 120); });
    logBuf.slice(-n).reverse().forEach(function (r) {
      if (/^sm:/.test(r.type)) { out.push((r.t / 1000).toFixed(2) + ' ' + r.type + ' ' + r.detail); return; }
      out.push((r.t / 1000).toFixed(2) + ' ' + r.type + ' ' + (r.pointerType || '') + '#' + r.pointerId + (r.isPrimary ? ' P' : '') + (r.trusted ? '' : ' 合成') +
        ' ' + r.target + ' ' + r.x + ',' + r.y + (r.touches != null ? ' 指' + r.touches : '') + (r.ev && r.ev.defaultPrevented ? ' 既定動作なし' : ''));
    });
    return out.length ? out.join('\n') : 'まだ記録がありません（版面に触れると記録されます）';
  }
  function pad2(v) { return (v < 10 ? '0' : '') + v; }
  function logFileName() {
    var d = new Date();
    return String(d.getFullYear()).slice(2) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '_' + (HTML.dataset.smApp || 'page') + '.json';
  }
  // ---- 新しい版: SW が新版を取り込んで切り替わったら、上端に帯を出す（押すと読み直す）----
  function showUpdate() {
    if (document.querySelector('.sm-update')) return;
    var bar = mk('div', 'sm-update'); bar.setAttribute('role', 'status');
    var go = mk('button', 'sm-update-go', '更新'); go.type = 'button'; go.setAttribute('aria-label', '新しい版に読み直す');
    var later = mk('button', 'sm-update-later', '閉じる'); later.type = 'button';
    go.addEventListener('click', function () { location.reload(); });
    later.addEventListener('click', function () { bar.remove(); });
    bar.append(mk('span', 'sm-update-text', '新しい版があります'), go, later);
    document.body.appendChild(bar);
    logNote('update-ready', '');
  }
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;   // 初回の取り込み（まだ管理されていない画面）では帯を出さない
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadController) showUpdate(); hadController = true; });
    // ホーム画面のアプリは開き直さずに戻ってくるので、前面に戻るたびに新版を確かめる
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !navigator.serviceWorker.getRegistration) return;
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) return r.update(); }).catch(function () {});
    });
  }
  // アダプタ表: <html data-sm-app="<id>">（make_tablet.py が注入）をキーに、ツールごとの部品の見つけ方を引く。
  // 既定（kit 型）は 102〜136 と同じ。自前パネルのツールだけ差分を書く。
  var DEFAULT = {
    panel: '.studio-panel', groups: '.sk-grp', title: '.sk-grp-ttl', rows: '.sk-row', stage: '#stage', bar: '#bar',
    rowRange: 'input[type=range]', rowLabel: '.sk-label', rowNum: '.sk-num', rowUnit: '.sk-unit', numDrive: false,
    undo: null, redo: null, noUndo: false, pinchUndo: false, ownPinch: false, overlay: true, scroll: false, jumpOnOpen: true, offClass: null,
    nameSel: null, extra: [], menuMove: [], saveText: null,
    // 指で押しにくい小さな点（画面上 7px ほど）。押した所から 22px 以内なら、その点を押した事にする
    hitSel: '.pt',
    // ⋯ の「全部消す」（持ち主 2026-10-27「あと全消去は必ず入れて」）。function (C) で、消せたら true。
    // 既定（null）は一覧の値の行をすべて開いた時の値へ戻す（生成型のツールの初期＝INIT-01 の形）。undo: 取り消しで戻せるか
    clear: null, clearUndo: true,
    // 148 のように全部自前の画面用: 見出しが入れ子（titleDeep）／見出しの文字だけの子（titleLabel）／道具の列（rail）／状態行（status）／
    // 上部バーの部品を ⋯ へ移さず押すだけにする（barKeep・proxies）／保存の直接指定（saveSel）／数値欄の範囲（limitsOf）／行の下ごしらえ（prepRow）
    titleDeep: null, titleLabel: null, rail: null, status: null, barKeep: false, proxies: [], saveSel: null, limitsOf: null, prepRow: null, autoConnect: false,
    // 版面が横に並ぶ案で、1 画面 1 案にして「1 / 4」と ◀ ▶ を下に置く時の横スクロール箱（pager）
    pager: null,
    // true: 行に textarea を含む群（SVG を貼る等）を末尾へ回さず、元の並びのままにする（162）
    keepOrder: false,
    // 非表示にする元の箱（既定は #main。自前の版面が #main の外へ移る前に消えてしまう画面は [] にする＝132）
    hideSelectors: ['#main'],
    // 群の名前を見出しの要素でなく別の所から引く（132: 上のタブの文字）。function (群) → 名前
    groupName: null,
    // 値の行の操作は range でなく数値欄へ書く（132: range への入力は吸着が入り、1 刻みで進めない）
    numFirst: false,
    // canvas の点（DOM 要素が無い）の画面上の位置: function (押した要素) → [{x, y}]。22px 以内なら、その点を押した事にする（H7 の canvas 版）
    hitPts: null,
    // 自前の 2 本指（ownPinch）のツールで、1 本目が置いた変化を、2 本目が来た時に元へ戻す: pinchSave() → 印、pinchRestore(印)
    pinchSave: null, pinchRestore: null,
    // 版面から指を離したら一覧の値を読み直す（版面のドラッグで値が変わるツール）
    syncPtr: false,
    // 開いた直後（行を組む前）に 1 回呼ぶ。「全部消す」の戻り先を覚える等
    init: null
  };
  var BSPLINE_INIT = null;   // 132 の「全部消す」の戻り先（開いた直後の状態）
  var ADAPTERS = {
    // 139: セクション＝section.sec / details.sec。行＝.f（range＋数値欄）。2本指は元ツールが持つ。
    'spline-draw': {
      panel: '#panel', groups: 'section.sec, details.sec', title: 'h2, summary', rows: '.f',
      rowLabel: '.top label', rowNum: 'input.n', rowUnit: '.unit', numDrive: true,
      undo: '#bUndo', redo: '#bRedo', ownPinch: true, overlay: false, jumpOnOpen: false, offClass: 'off', pinchUndo: true,
      clear: function (C) { return C.click('#bClear'); },   // 元の「全部消す」ボタン（取り消しの履歴に入る）
      extra: [{ sel: '#info', name: '状態' }]
    },
    // 162: セクション＝section.grp。行＝数値欄の行（.rng / .opt）。案は版面の中で横にスクロール。
    'palette-adjust': {
      panel: '#panel', groups: 'section.grp', title: '.grp-ttl', rows: '.rng, .opt',
      rowRange: 'input[type=range]', rowLabel: 'span', rowNum: 'input[type=number]', rowUnit: null, numDrive: true,
      ownPinch: true, scroll: true, noUndo: true, pager: '#row', keepOrder: true,
      // 貼った SVG を消し、開いた直後の入力（ツールの INIT-01: 青い円 1 つ）に戻す。値の行も開いた時の値へ
      clear: function (C) {
        var box = document.getElementById('paste-box'); if (!box) return false;
        C.resetRows();
        box.value = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400"><circle cx="150" cy="200" r="95" fill="#0044CC"/></svg>';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    },
    // 148: 全部自前。上部バーの 表示・書き出し・書類のメニュー・やり直し は元の小窓を開くだけ（⋯ から押す）。
    // 行＝.field-row（名前＋数値欄）・.range-row（range＋数値欄・名前は直前の小見出し）・単独の数値欄。
    'tri-grid-logo': {
      panel: '.app', groups: 'aside.panel > .panel-section', title: '.panel-heading, .collapsible-header', titleDeep: '.variant-head', titleLabel: '.label',
      rows: '.field-row, .range-row, .fill-weight-row, .numfield:not(.field-row *):not(.range-row *)',
      rowRange: 'input[type=range]', rowLabel: '.field-label, .subfield-label, .fw-label', rowNum: '.numfield input, .fw-val', rowUnit: '.unit', numDrive: true,
      stage: 'main.canvas', bar: 'header.topbar', undo: '#undoBtn', redo: '#redoBtn', saveSel: '#svgBtn', ownPinch: false, overlay: false, barKeep: true,
      rail: 'nav.toolrail', status: 'footer.statusbar', autoConnect: true, pinchUndo: true,
      clear: function (C) { return C.click('#clearAllItem', true); },   // 元の「全マスを消す」（確認の小窓は出さず、2 度押しで確かめる）
      proxies: [
        { sel: '#pngBtn', text: 'PNGを書き出す' },
        { sel: '#viewBtn', text: '表示の設定（グリッド線・色ごとの表示）' },
        { sel: '#exportBtn', text: '書き出しの設定（形式・線幅・メモ・PNG）' },
        { sel: '#docNameBtn', text: '書類のメニュー（SVGを開く・全マスを消す）' }
      ],
      limitsOf: function (d) {
        var nf = d.closest && d.closest('.numfield'), c = nf && window.FIELD_CFG && window.FIELD_CFG[nf.dataset.key];
        return c ? { min: c.min, max: c.max, step: c.step } : null;
      },
      // 名前が直前の小見出しにある行は、その小見出しを行の先頭へ入れる（行を押すと名前に下線が付く）
      prepRow: function (row) {
        if (row.querySelector('.field-label, .subfield-label, .fw-label')) return;
        var prev = row.previousElementSibling;
        if (prev && prev.classList.contains('subfield-label')) row.insertBefore(prev, row.firstChild);
      }
    },
    // 136: 元の「最初の形に戻す」（resetAll・履歴に入る）
    'grid-pattern': { clear: function (C) { return C.call('resetAll'); } },
    // 157・159・160: 取り消しの履歴の一番古い状態（開いた直後＝INIT-01）へ戻し、その状態を履歴に積む（取り消しで消す前へ戻れる）
    'stroke-swell': { clear: function (C) { return C.fromHistory('hist', 'applyHistState'); } },
    'solid-spline': { clear: function (C) { return C.fromHistory('hist', 'applyHistState'); } },
    'sweep-along': { clear: function (C) { return C.fromHistory('hist', 'applyHistoryState'); } },
    // 132: 版面＝canvas#view（自前の点ドラッグ・2 本指の拡縮）。基底関数の canvas（#paramCv）と再生バー（#timeline）は版面の下に残す（シート中では隠す）。
    // 右のパネルの 6 つのタブは、それぞれ一覧の群へ。上の表示切替（#viewbar）は「表示」の群へ。値の行は .ctl（label＋range＋数値欄）。
    // 上部バーの SVG は下帯が押す。取り消しは元の履歴（Studio.keys の ⌘Z）。「全部消す」は開いた直後の状態（INIT-01: 版面中央の円・各値は初期値）へ。
    'bspline': {
      panel: '#panel', groups: 'section.tabsec', rows: '.ctl', rowLabel: 'label', rowNum: 'input.num', rowUnit: '.unit', numDrive: true, numFirst: true,
      stage: '.stage', ownPinch: true, overlay: false, jumpOnOpen: false, hideSelectors: [], hitSel: null, syncPtr: true, clearUndo: false,
      groupName: function (g) { var b = document.querySelector('#tabs [data-s="' + g.dataset.s + '"]'); return b ? b.textContent.trim() : ''; },
      extra: [{ sel: '#viewbar', name: '表示' }],
      hitPts: function (target) {
        if (!target || target.id !== 'view' || typeof S === 'undefined' || (typeof LOFT !== 'undefined' && LOFT)) return [];
        var r = target.getBoundingClientRect();
        return S.P.map(function (p) { var q = toS(p); return { x: r.left + q.x, y: r.top + q.y }; });
      },
      pinchSave: function () { return typeof S === 'undefined' ? null : JSON.stringify({ P: S.P, sel: S.sel }); },
      pinchRestore: function (mark) {
        if (typeof S === 'undefined' || !mark || JSON.stringify({ P: S.P, sel: S.sel }) === mark) return;
        var m = JSON.parse(mark); S.P = m.P; S.sel = m.sel; build(); render();   // 1 本目が動かした点を、2 本指の拡縮に入る前の位置へ戻す
      },
      init: function () {
        if (typeof S === 'undefined') return;
        var k = ['P', 'ptMode', 'ends', 'deg', 'interior'], o = { mul: S.mul, loft: S.loft, warp: S.warp, time: S.time, grid: { mm: S.grid.mm, snap: S.grid.snap } };
        k.forEach(function (n) { o[n] = S[n]; });
        BSPLINE_INIT = JSON.stringify(o);
      },
      clear: function () {
        if (!BSPLINE_INIT || typeof S === 'undefined') return false;
        var o = JSON.parse(BSPLINE_INIT);
        ['P', 'ptMode', 'ends', 'deg', 'interior'].forEach(function (n) { S[n] = o[n]; });
        Object.assign(S.mul, o.mul); Object.assign(S.loft, o.loft); Object.assign(S.warp, o.warp); Object.assign(S.time, o.time);
        S.grid.mm = o.grid.mm; S.grid.snap = o.grid.snap; S.sel = null;
        syncUI(); build(); fitView(); setPlay(); render(); commit();   // 元の関数。commit は取り消しの履歴に積む
        return true;
      }
    },
    // 122: 上部バー無し。書き出しはパネルのボタン。⋯ には書き出しと説明文を入れる。
    'sphere-surface': {
      bar: null, noUndo: true, stage: 'main.studio-stage', nameSel: '.studio-panel h1',
      menuMove: [{ sel: '.studio-panel .sk-btn', text: /書き出し/ }],   // 説明文（p.note）はスマホでは出さない（CSS で非表示）
      saveText: /SVG/, clearUndo: false
    }
  };
  var APP = document.documentElement.dataset.smApp || '';
  var A = Object.assign({}, DEFAULT, ADAPTERS[APP] || {});
  if (A.hideSelectors.indexOf('#main') < 0) HTML.classList.add('sm-keep-main');   // CSS の「#main を消す」を、このアダプタでは効かせない
  function init() {
    var panel = A.panel ? document.querySelector(A.panel) : null;
    var bar = A.bar ? document.querySelector(A.bar) : null;
    var stage = document.querySelector(A.stage);
    if (!stage || (!panel && !document.querySelector(A.groups))) return;
    stage.classList.add('sm-stage');
    A.hideSelectors.forEach(function (sel) { if (sel !== '#main') document.querySelectorAll(sel).forEach(function (n) { n.classList.add('sm-original'); }); });
    if (A.init) A.init();
    function el(tag, cls, text) {
      var n = document.createElement(tag); n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function button(cls, text) { var n = el('button', cls, text); n.type = 'button'; return n; }
    var toolName = ((bar && bar.querySelector('.name') || {}).textContent || (A.nameSel && (document.querySelector(A.nameSel) || {}).textContent) || document.title).trim();
    var root = el('div', 'sm-root'); document.body.appendChild(root);
    var view = el('div', 'sm-view'); view.appendChild(stage);
    if (A.scroll) view.classList.add('sm-scroll');
    logView = view;
    // ---- 下シート: つまみ（設定）／ 1 本の縦スクロール一覧 ／ 見出しへ飛ぶ帯 ----
    var sheet = el('section', 'sm-sheet'); sheet.dataset.level = 'small';
    var grip = el('div', 'sm-grip'); grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'horizontal'); grip.tabIndex = 0;
    grip.setAttribute('aria-label', '設定の高さ（上下にドラッグか押して 小／中）');
    grip.appendChild(el('span', 'sm-grip-bar')); grip.appendChild(el('span', 'sm-grip-text', '設定'));
    var rows = el('div', 'sm-rows');
    var spacer = el('div', 'sm-spacer'); rows.appendChild(spacer);
    var tabs = el('div', 'sm-tabs'); var tabList = el('div', 'sm-tablist'); tabList.setAttribute('role', 'tablist'); tabs.appendChild(tabList);
    sheet.append(grip, rows, tabs);
    root.dataset.level = 'small';
    // ---- 下帯: ⋯ ／ 全部消す ／ 取り消し ／ やり直し ／ SVG を書き出す ----
    var bottom = el('footer', 'sm-bottom');
    var more = button('sm-more', '⋯'); more.setAttribute('aria-label', 'メニュー（読み込み・書き出し・インスタ・GitHub）'); more.setAttribute('aria-expanded', 'false');
    var undo = button('sm-undo', '取り消し'), redo = button('sm-redo', 'やり直し');
    var save = button('sm-save'); var saveLab = el('span', 'sm-save-lab', 'SVG を書き出す'); var wait = el('span', 'sm-wait'); wait.hidden = true; save.append(saveLab, wait);
    var clearBtn = button('sm-clear', '全部消す'), clearT = null;   // 持ち主 2026-10-28「全消去は常に表示される場所において」: 下帯に常時出す
    bottom.append(more, clearBtn, undo, redo, save);
    // 横スクロールの列: 右に続きがある間だけ右端を、先頭でない間だけ左端を薄くする（末尾まで行ったら最後の物を隠さない）
    function fadeEnd(n) {
      function f() {
        n.dataset.end = n.scrollLeft + n.clientWidth >= n.scrollWidth - 2 ? '1' : '0';
        n.dataset.start = n.scrollLeft > 2 ? '1' : '0';
      }
      n.addEventListener('scroll', f, { passive: true }); window.addEventListener('resize', f); f(); setTimeout(f, 300);
      if (window.ResizeObserver) new ResizeObserver(f).observe(n);
      new MutationObserver(f).observe(n, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }
    fadeEnd(tabList);
    var railEl = A.rail ? document.querySelector(A.rail) : null, statusEl = A.status ? document.querySelector(A.status) : null;
    if (railEl) {
      railEl.classList.add('sm-rail');
      // アイコンだけにしない（rules §3）: 文字ラベルを aria-label にも入れる
      railEl.querySelectorAll('button').forEach(function (b) {
        var t = (b.querySelector('span') || b).textContent.trim(); if (t && !b.getAttribute('aria-label')) b.setAttribute('aria-label', t);
      });
      root.style.setProperty('--sm-extra', '72px');   // 道具の列 48 ＋ 状態行 24
      fadeEnd(railEl);
    }
    if (statusEl) {
      statusEl.classList.add('sm-status');
      // 座標が無い時（「—, —」）は出さない（前の区切りも一緒に）
      var cur = statusEl.querySelector('#statusCursor');
      if (cur) {
        var syncCur = function () { var empty = !/[0-9]/.test(cur.textContent); cur.hidden = empty; if (cur.previousElementSibling) cur.previousElementSibling.hidden = empty; };
        new MutationObserver(syncCur).observe(cur, { childList: true, characterData: true, subtree: true }); syncCur();
      }
    }
    root.append.apply(root, [view, railEl, sheet, statusEl, bottom].filter(Boolean));
    // ---- ⋯ シート（下から・外側タップで閉じる）----
    var backdrop = el('div', 'sm-backdrop'); backdrop.hidden = true;
    var menu = el('div', 'sm-menu'); menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-modal', 'true');
    menu.setAttribute('aria-label', toolName); menu.tabIndex = -1;
    menu.appendChild(el('h2', 'sm-menu-head', toolName));
    menu.appendChild(el('p', 'sm-menu-ver', '版: ' + buildText()));
    var menuBody = el('div', 'sm-menu-body'); menu.appendChild(menuBody); backdrop.appendChild(menu);
    // bar 自体は root の中に残し（見えない箱）、⋯ のシートをその子にする。
    // 157 の「映像」のように bar への委譲リスナー（capture）で動く部品も、移した先で今まで通り効く。
    if (bar) { bar.classList.add('sm-bar-host'); root.appendChild(bar); bar.appendChild(backdrop); } else root.appendChild(backdrop);
    var svgButton = bar && bar.querySelector('#svg');
    var undoEl = A.undo ? document.querySelector(A.undo) : null, redoEl = A.redo ? document.querySelector(A.redo) : null;
    var customButtons = [], colorGroup = null, menuItems = [];
    function rank(n) {
      if (n.id === 'png' || (n.id === 'video' && /PNG/.test((n.getAttribute('aria-label') || '') + n.title))) return 10;
      if (n.id === 'video') return 20;
      if (/JSON/.test((n.getAttribute('aria-label') || '') + n.title + n.textContent) || n.id === 'json' || n.id === 'sceneJson') return 30;
      if (n.id === 'copy') return 40;
      if (n.matches('.insta-toggle')) return 50;
      if (n.matches('.insta-part')) return 55;
      if (n.matches('.baropts')) return 60;
      return 70;
    }
    // キーボードの表記（（N）・（V）・（⌘V でも可）・ ⌘C 等）は指では使わないので、表示の文字から外す（元の aria / title は保つ）
    var KEY_MID = /（[⌘⇧⌥]+[A-Z] でも可）/g, KEY_END = /\s*(?:（[⌘⇧⌥]*[A-Z](?: でも可)?）|[⌘⇧⌥]+[A-Z])\s*$/, KEY_HIT = /[⌘⇧⌥]|（[A-Z]）/;
    function stripKeys(t) { return t.replace(KEY_MID, '').replace(KEY_END, ''); }
    function stripKeyNodes(scope) {
      var w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
        return KEY_HIT.test(n.data) && n.parentElement && !n.parentElement.closest('svg,textarea,script,style,.sm-gone,.sm-original') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      } });
      var hit = [], n; while ((n = w.nextNode())) hit.push(n);
      hit.forEach(function (x) { var t = stripKeys(x.data); if (t !== x.data) x.data = t; });
    }
    // ⋯ の項目は 10px のキー表示やアイコンだけの物を出さず、文字ボタンにする（文字は元の aria-label / title から取る）
    function labelFor(n) {
      var al = (n.getAttribute('aria-label') || '').trim(), ti = (n.title || '').trim(), tx = n.textContent.replace(/[⌘⇧⌥]\S*/g, '').trim();
      if (n.id === 'png' || (n.id === 'video' && /PNG/.test(al + ti))) return 'PNG を書き出す';
      if (n.id === 'video') return '映像を書き出す';
      if (n.id === 'json' || n.id === 'sceneJson' || /JSON/.test(al + ti + tx)) return 'JSON を書き出す';
      if (n.id === 'copy') return 'コピー（SVG をクリップボードへ）';
      if (n.id === 'theme') return al || '表示を反転';
      if (n.id === 'bUnit') return '単位: ' + tx.replace(/^単位:\s*/, '').replace(/^単位を切り替える（いま\s*(.*)）$/, '$1');
      if (APP === 'sphere-surface' && n.tagName === 'BUTTON') {
        if (/SVG/.test(al + ti + tx) && /書き出し/.test(al + ti + tx)) return 'SVG を書き出す';
        if (/PNG/.test(al + ti + tx) && /書き出し/.test(al + ti + tx)) return 'PNG を書き出す（2 倍の大きさ）';
      }
      return (al.length >= 2 && !/^[A-Z]{2,4}$/.test(tx) ? al : '') || (tx.length >= 2 && !/^[A-Z]{2,4}$/.test(tx) ? tx : '') || ti || al || tx;
    }
    function setLabel(n) {
      if (n.tagName !== 'BUTTON' || n.matches('.insta-toggle')) return;
      var t = stripKeys(labelFor(n)); if (t && n.textContent !== t) n.textContent = t;
    }
    if (bar) {
      var cg = bar.querySelector('.cmn-colors'); if (cg) colorGroup = cg;
      Array.from(bar.children).forEach(function (n) {
        if (A.barKeep) return;
        if (n.matches('.name,.sub,.fill,.sep,.baropts-toggle,.sm-backdrop,.cmn-colors')) return;
        if (n === svgButton || (undoEl && n === undoEl) || (redoEl && n === redoEl)) return;   // 主ボタンと取り消し・やり直しは下帯が押す
        // ツールが bar に足した主要操作（160「全部振る」等）は ⋯ に隠さず、先頭群の一番上へ置く。
        if (n.matches('button.btn') && !n.id && !n.matches('.has-icon,.insta-toggle,.insta-part,.icon-only')) { customButtons.push(n); return; }
        menuItems.push(n);
      });
    }
    // kit のインスタ切替は旧bar配下を検索するため、移した部品の表示も同期する。
    var insta = menuItems.filter(function (n) { return n.matches('.insta-toggle'); })[0] || null;
    // ツールがパネルの中に置いた書き出しボタン・説明文は ⋯ へ（元の要素をそのまま移す）。
    A.menuMove.forEach(function (m) {
      document.querySelectorAll(m.sel).forEach(function (n) {
        if (m.text && !m.text.test(n.textContent)) return;
        menuItems.push(n);
      });
    });
    // 上部バーの部品は元の場所に置いたまま、⋯ の中の文字つきボタンから押す（元の小窓がそのまま開く）
    A.proxies.forEach(function (x) {
      var target = document.querySelector(x.sel); if (!target) return;
      var pb = button('sm-proxy', x.text);
      pb.addEventListener('click', function () { close(); target.click(); });
      if (target.matches('button')) { var syncDis = function () { pb.disabled = target.disabled; }; new MutationObserver(syncDis).observe(target, { attributes: true, attributeFilter: ['disabled'] }); syncDis(); }
      menuItems.push(pb);
    });
    // GitHub につなぐ（状態を併記）
    var gh = button('sm-gh'); var ghLab = el('span', 'sm-gh-lab', 'GitHub につなぐ'); var ghState = el('span', 'sm-gh-state', '未接続'); gh.append(ghLab, ghState);
    gh.addEventListener('click', function () { close(); if (window.StudioVault && StudioVault.connect) StudioVault.connect(); });
    menuItems.sort(function (a, b) { return rank(a) - rank(b); });
    menuItems.forEach(function (n) { menuBody.appendChild(n); setLabel(n); });
    menuBody.appendChild(gh);
    // ---- 全部消す（2 度押し。1 度目で「本当に全部消す」に変わり、3 秒で元に戻る。window.confirm は使わない）----
    function smToast(msg, error) {
      if (window.Studio && typeof Studio.toast === 'function') { Studio.toast(msg, error ? { kind: 'error' } : undefined); return; }
      var n = document.querySelector('.sv-toast');
      if (!n) { n = el('div', 'sv-toast'); n.setAttribute('role', 'status'); document.body.appendChild(n); }
      n.textContent = msg; n.classList.toggle('err', !!error); n.hidden = false;
      clearTimeout(smToast._t); smToast._t = setTimeout(function () { n.hidden = true; }, 2600);
    }
    var C = {
      // ツールのボタンを押す。noConfirm: 元のボタンが window.confirm で確かめる物は、その確認を通す（こちらの 2 度押しで確かめ済み）
      click: function (sel, noConfirm) {
        var b = document.querySelector(sel); if (!b) return false;
        var saved = window.confirm;
        if (noConfirm) window.confirm = function () { return true; };
        try { b.click(); } finally { if (noConfirm) window.confirm = saved; }
        return true;
      },
      call: function (name) { if (typeof window[name] !== 'function') return false; window[name](); return true; },
      // 取り消しの履歴（Studio.history）の一番古い状態へ戻し、それを履歴に積む。履歴の位置は元に戻してから積む
      fromHistory: function (hName, applyName) {
        var h = window[hName], apply = window[applyName];
        if (!h || typeof h.undo !== 'function' || typeof apply !== 'function') return false;
        var first = null, s, n = 0;
        while ((s = h.undo())) { first = s; n++; }
        for (var i = 0; i < n; i++) h.redo();
        if (first) { apply(first); h.push(first); }   // 履歴が 1 つだけ＝いまが一番古い状態（戻す物は無い）
        C.resetRows();   // 履歴に入らない値（視点の回転など）も開いた時の値へ
        return true;
      },
      // 一覧の値の行を、開いた時の値へ戻す
      resetRows: function () {
        var any = false;
        rows.querySelectorAll('.sm-range-row').forEach(function (row) {
          var p = row._sm; if (!p || row._initial == null) return;
          if (String(p.driver.value) !== row._initial) { setExact(p, parseFloat(row._initial)); any = true; }
        });
        syncAll(); return any || true;
      }
    };
    function disarm() { clearTimeout(clearT); clearT = null; delete clearBtn.dataset.armed; clearBtn.textContent = '全部消す'; }
    clearBtn.addEventListener('click', function () {
      if (!clearBtn.dataset.armed) {
        clearBtn.dataset.armed = '1'; clearBtn.textContent = '本当に消す';
        clearTimeout(clearT); clearT = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      var ok = false;
      try { ok = A.clear ? A.clear(C) : C.resetRows(); } catch (err) { errPush('clear', err && err.message || err); ok = false; }
      logNote('clear', ok ? 'ok' : 'failed');
      setTimeout(syncAll, 30);
      if (!ok) { smToast('この画面では全部消せませんでした', true); return; }
      smToast(A.clearUndo && !A.noUndo ? '全部消しました（取り消しで戻せます）' : '全部消しました');
    });
    // 操作の記録を送る（実機で起きた事を GitHub の logs/ へ）。直近 20 件は文字でも出す（スクショで送れる）
    var logBtn = button('sm-logsend', '操作の記録を送る');
    var logHead = el('p', 'sm-log-head', '直近の操作（新しい順に 20 件）'), logPre = el('pre', 'sm-log');
    function renderLog() { logPre.textContent = logLines(20); }
    logBtn.addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(logDump(), null, 1)], { type: 'application/json' });
      if (window.StudioVault && StudioVault.queueLog) StudioVault.queueLog(blob, logFileName());
      else if (window.Studio && Studio.toast) Studio.toast('記録を送る仕組みが読み込まれていません', { kind: 'error' });
      renderLog();
    });
    menuBody.append(logBtn, logHead, logPre);
    if (insta) {
      // スマホではアイコンだけにしない（rules §3）。kit の aria-label を文字で添える。
      if (!insta.querySelector('.sm-insta-text')) {
        var it = document.createElement('span'); it.className = 'sm-insta-text';
        it.textContent = insta.getAttribute('aria-label') || 'インスタ用の表示'; insta.appendChild(it);
      }
      var syncInsta = function () {
        var on = insta.getAttribute('aria-pressed') === 'true';
        menuBody.querySelectorAll('.insta-part').forEach(function (n) { n.hidden = !on; });
      };
      new MutationObserver(syncInsta).observe(insta, {attributes: true, attributeFilter: ['aria-pressed']});
      syncInsta();
    }
    // 大きさの選択には文字を添える（select だけを置かない）
    menuBody.querySelectorAll('.insta-part select').forEach(function (s) {
      if (s.parentNode.querySelector('.sm-menulab')) return;
      s.parentNode.insertBefore(el('span', 'sm-menulab', s.getAttribute('aria-label') === '書き出す大きさ' ? '大きさ' : (s.getAttribute('aria-label') || s.title || '選ぶ')), s);
    });
    if (panel) panel.classList.add('sm-original');
    // ---- 値の読み書き ----
    function partsOf(row) {
      var range = row.querySelector(A.rowRange), lab = row.querySelector(A.rowLabel);
      var num = row.querySelector(A.rowNum), unit = A.rowUnit ? row.querySelector(A.rowUnit) : null;
      var driver = (A.numFirst && A.numDrive && num) ? num : (range || (A.numDrive ? num : null));
      return driver && lab ? { driver: driver, isRange: !!range && driver === range, range: range, label: lab, num: num, unit: unit } : null;
    }
    function limits(p) {
      var d = p.driver;
      if (p.isRange) return { min: +d.min, max: +d.max, step: +d.step || 1 };
      var own = A.limitsOf && A.limitsOf(d);
      if (own) { var cv = parseFloat(d.value); return { min: isNaN(cv) ? own.min : Math.min(own.min, cv), max: isNaN(cv) ? own.max : Math.max(own.max, cv), step: own.step }; }
      var v = parseFloat(d.value) || 0, mn = parseFloat(d.getAttribute('min')), mx = parseFloat(d.getAttribute('max')), st = parseFloat(d.getAttribute('step'));
      if (isNaN(mn)) mn = v < 0 ? v * 4 : 0;
      if (isNaN(mx)) mx = Math.max(Math.abs(v) * 4, 10);
      if (isNaN(st)) st = Number.isInteger(v) ? 1 : 0.1;
      return { min: Math.min(mn, v), max: Math.max(mx, v), step: st };
    }
    function decimals(step) { var s = String(step), i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
    function change(input, v) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (input.type !== 'range') input.dispatchEvent(new Event('blur'));   // 数値欄は blur で確定するツールがある（139）
    }
    function isKitNum(p) { return p.num && p.num.classList && p.num.classList.contains('sk-num'); }
    // 数値の直接入力・↺ は、kit の数値欄の Enter 確定を通す（吸着せず、範囲だけ丸める）
    function setExact(p, v) {
      var lim = limits(p); v = Math.max(lim.min, Math.min(lim.max, v));
      if (p.isRange && isKitNum(p)) { p.num.value = String(v); p.num.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }
      else change(p.driver, v);
    }
    function stepBy(p, dir) {
      if (p.isRange) {
        // 元の矢印処理は吸着せず、必ず step だけ進む。
        p.driver.dispatchEvent(new KeyboardEvent('keydown', { key: dir < 0 ? 'ArrowLeft' : 'ArrowRight', bubbles: true, cancelable: true }));
      } else {
        var lim = limits(p), v = (parseFloat(p.driver.value) || 0) + dir * lim.step;
        change(p.driver, +Math.max(lim.min, Math.min(lim.max, v)).toFixed(6));
      }
    }
    function valueText(p) {
      var raw = (p.num && p.num.tagName === 'INPUT' ? p.num : p.driver).value;
      var u = p.unit ? p.unit.textContent.trim() : '';
      return raw + (u ? ' ' + u : '');
    }
    var dragging = false;
    function syncRow(row) {
      var p = row._sm; if (!p || !row.getClientRects().length) return;
      var ui = row._ui, lim = limits(p), cur = parseFloat(p.driver.value);
      var t = valueText(p);
      if (ui.valTxt.data !== t) ui.valTxt.data = t;
      var lt = stripKeys(p.label.textContent.trim()); if (ui.lab.textContent !== lt) ui.lab.textContent = lt;
      var frac = lim.max > lim.min ? (cur - lim.min) / (lim.max - lim.min) : 0;
      ui.track.style.setProperty('--sm-pos', String(Math.max(0, Math.min(1, isNaN(frac) ? 0 : frac))));
      ui.track.setAttribute('aria-valuemin', String(lim.min)); ui.track.setAttribute('aria-valuemax', String(lim.max)); ui.track.setAttribute('aria-valuenow', String(cur));
      ui.track.setAttribute('aria-valuetext', t);
      var dirty = String(p.driver.value) !== row._initial; if (ui.rst.dataset.on !== (dirty ? '1' : '0')) ui.rst.dataset.on = dirty ? '1' : '0';
    }
    function syncAll() { rows.querySelectorAll('.sm-range-row').forEach(syncRow); }
    var syncQueued = false;
    function syncSoon() { if (syncQueued) return; syncQueued = true; requestAnimationFrame(function () { syncQueued = false; syncAll(); }); }
    // ---- 群の収集（入れ子の .studio-panel の中も含め、文書順に平らに）----
    var groups = []; // {group, tab, head}
    function titleEl(g) {
      var t = Array.from(g.children).find(function (c) { return c.matches(A.title); });
      if (!t && A.titleDeep) { var h = g.querySelector(':scope > ' + A.titleDeep); t = h && Array.from(h.children).find(function (c) { return c.matches(A.title); }); }
      return t || null;
    }
    function groupTitle(g) {
      var gn = A.groupName && A.groupName(g); if (gn) return gn;
      var t = titleEl(g); if (!t) return '';
      var lab = A.titleLabel && t.querySelector(A.titleLabel); if (lab) return lab.textContent.trim();
      // 見出しの中に状態表示の span がある時（139 のグリッド）は、見出し本体の文字だけを名前にする。
      var own = Array.from(t.childNodes).filter(function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join('').trim();
      return own || t.textContent.trim();
    }
    function toolHidden(g) {
      if (A.offClass && g.classList.contains(A.offClass)) return true;
      return g.hidden || getComputedStyle(g).display === 'none';
    }
    function addGroup(group, name, first) {
      var index = groups.length;
      // 帯の見出しは 8 文字で切って「…」。一覧の見出し（sm-grp-head）は全文
      var tab = button('sm-tab', name.length > 8 ? name.slice(0, 8) + '…' : name); if (name.length > 8) { tab.title = name; tab.setAttribute('aria-label', name); }
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false');
      group.id = group.id || 'sm-group-' + index;
      tab.id = 'sm-tab-' + index; tab.setAttribute('aria-controls', group.id);
      var title = titleEl(group); if (title) title.hidden = true;
      group.classList.remove('closed'); group.classList.add('sm-grp'); if (group.classList.contains('collapsible')) group.classList.add('open'); if (group.tagName === 'DETAILS') group.open = true;
      var head = el('div', 'sm-grp-head', name); head.setAttribute('role', 'heading'); head.setAttribute('aria-level', '2');
      group.insertBefore(head, group.firstChild);
      var rec = {group: group, tab: tab, head: head, gone: false};
      if (first) { rows.insertBefore(group, rows.firstChild); tabList.insertBefore(tab, tabList.firstChild); groups.unshift(rec); }
      else { rows.insertBefore(group, spacer); tabList.appendChild(tab); groups.push(rec); }
      tab.addEventListener('click', function () { jumpTo(rec); });
      return rec;
    }
    // 見出しへ飛ぶ。一覧の先頭に見出しが来る位置へスクロールし、帯の強調を移す。
    var lockUntil = 0, current = null;
    function setCurrent(rec) {
      current = rec;
      groups.forEach(function (r) {
        var on = r === rec; r.tab.setAttribute('aria-selected', String(on)); r.tab.classList.toggle('sm-cur', on);
      });
      if (rec && tabList.scrollWidth > tabList.clientWidth) {
        var t = rec.tab, l = t.offsetLeft, r = l + t.offsetWidth;
        if (l < tabList.scrollLeft) tabList.scrollLeft = l - 8;
        else if (r > tabList.scrollLeft + tabList.clientWidth) tabList.scrollLeft = r - tabList.clientWidth + 24;
      }
    }
    function jumpTo(rec) {
      var dy = rec.group.getBoundingClientRect().top - rows.getBoundingClientRect().top;
      lockUntil = Date.now() + 400;
      rows.scrollTop = Math.max(0, rows.scrollTop + dy);
      setCurrent(rec);
    }
    function spy() {
      if (Date.now() < lockUntil) return;
      var top = rows.getBoundingClientRect().top + 2, pick = null;
      groups.forEach(function (r) { if (!r.gone && r.group.getBoundingClientRect().top <= top + 8) pick = r; });
      if (!pick) pick = groups.filter(function (r) { return !r.gone; })[0] || null;
      if (pick !== current) setCurrent(pick);
    }
    var spyQueued = false;
    rows.addEventListener('scroll', function () { if (spyQueued) return; spyQueued = true; requestAnimationFrame(function () { spyQueued = false; spy(); }); }, { passive: true });
    // 表示状態（ツールが display:none / hidden / class で出し入れする群）に合わせて帯を出し直す。
    function refreshTabs() {
      var opened = null;
      groups.forEach(function (r) {
        var hid = toolHidden(r.group);
        if (r.gone && !hid && r.ready) opened = r;
        r.gone = hid; r.tab.hidden = hid;
      });
      if (opened && A.jumpOnOpen) { jumpTo(opened); if (!backdrop.hidden) close(); return; }   // ⋯ から開いた群は、シートを閉じて見せる
      if (current && current.gone) current = null;
      if (!current) spy();
      updateSpacer();
    }
    function updateSpacer() {
      var vis = groups.filter(function (r) { return !r.gone; }), last = vis[vis.length - 1];
      if (!last) { spacer.style.height = '0px'; return; }
      var h = last.group.getBoundingClientRect().height;
      spacer.style.height = Math.max(0, Math.round(rows.clientHeight - h)) + 'px';
    }
    var pending = [];
    Array.from(document.querySelectorAll(A.groups)).filter(function (g) { return !g.parentElement.closest(A.groups); }).forEach(function (g) {
      var name = groupTitle(g);
      if (!name) {
        // 見出しの無い群は直前の群へ合流（最初の群なら次の群の先頭へ）。
        if (groups.length) groups[groups.length - 1].group.appendChild(g); else pending.push(g);
        return;
      }
      addGroup(g, name);
      var after = titleEl(g);
      pending.forEach(function (p) { g.insertBefore(p, after ? after.nextSibling : g.firstChild); }); pending = [];
    });
    if (pending.length) { var host = el('div', 'sk-grp'); pending.forEach(function (p) { host.appendChild(p); }); addGroup(host, '操作'); }
    // ---- 159 のレイヤー欄（ステージ下の #sideWrap）を最後の群へ ----
    var sideWrap = document.querySelector('#sideWrap');
    if (sideWrap) { var layerGroup = el('div', 'sk-grp sm-layer'); layerGroup.appendChild(sideWrap); addGroup(layerGroup, 'レイヤー'); }
    // ---- 自前パネルの群に入っていない部品（139 の状態欄など）を最後の群へ ----
    A.extra.forEach(function (x) {
      var n = document.querySelector(x.sel); if (!n) return;
      var host = el('div', 'sm-extra'); host.appendChild(n); addGroup(host, x.name);
    });
    // ---- 行に textarea（SVG を貼る等）を含む群は、一覧の末尾（色の前）へ回す。最初に見える物を値の行にする（keepOrder の画面は元の並び）----
    if (!A.keepOrder) {
      var tail = groups.filter(function (r) { return r.group.querySelector('textarea'); });
      if (tail.length && tail.length < groups.length) tail.forEach(function (r) {
        groups.splice(groups.indexOf(r), 1); groups.push(r);
        rows.insertBefore(r.group, spacer); tabList.appendChild(r.tab);
      });
    }
    // ---- 主要操作ボタン（bar から）を先頭群の一番上へ。文字は元の title（無ければ aria-label）があればそれにする ----
    customButtons.forEach(function (b) {
      var t = (b.title || b.getAttribute('aria-label') || '').replace(/（⌘[A-Z][^）]*）/g, '').trim();
      if (t && b.textContent.trim() !== t) { if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', b.textContent.trim()); b.textContent = t; }
    });
    if (customButtons.length && groups.length) {
      var headGrp = groups[0].group, ttl = groups[0].head;
      customButtons.slice().reverse().forEach(function (b) { headGrp.insertBefore(b, ttl.nextSibling); });
    }
    // ---- 色（stageBar の色群）: 一覧の最後の群（指揮者判断 2026-10-27: シート小で最初にパラメーター行が見えるように）。色見本 48px ＋ 文字 ----
    var colorBox = null;
    if (colorGroup) {
      colorBox = el('div', 'sk-grp sm-colorgrp'); colorBox.appendChild(colorGroup); colorGroup.classList.add('sm-colors');
      Array.from(colorGroup.querySelectorAll('.cswatch')).forEach(function (b) {
        var cell = el('div', 'sm-swcell'); b.parentNode.insertBefore(cell, b); cell.appendChild(b);
        var lb = el('span', 'sm-swlab', b.getAttribute('aria-label') || b.title || '色');
        cell.appendChild(lb); lb.addEventListener('click', function () { b.click(); });
      });
      addGroup(colorBox, '色', false);
    }
    // ---- 行の配線 ----
    function coverOf(row, node) {
      var c = node; while (c && c.parentNode !== row) c = c.parentNode;
      if (!c) return node;
      var ok = Array.from(c.querySelectorAll('button,select,textarea,input')).every(function (n) { return n.matches('input[type=range]') || n === node || n.contains(node) || node.contains(n); });
      // 子に別の操作が混じるなら、その部品だけを隠す
      var extra = Array.from(c.querySelectorAll('button,select,textarea,input')).filter(function (n) { return !(n.matches('input[type=range]') || n.matches(A.rowNum) || n === node); });
      return (ok && !extra.length) ? c : node;
    }
    function wireRow(row) {
      if (row.classList.contains('sm-range-row')) return;
      if (A.prepRow) A.prepRow(row);
      var p = partsOf(row); if (!p) return;
      row._sm = p; row._initial = String(p.driver.value);
      row.classList.add('sm-range-row');
      [p.driver, p.range, p.label, p.num, p.unit].forEach(function (n) { if (n) coverOf(row, n).classList.add('sm-gone'); });
      var ui = el('div', 'sm-ui');
      var top = el('div', 'sm-ui-top'), botl = el('div', 'sm-ui-bot');
      var lab = el('span', 'sm-lab', stripKeys(p.label.textContent.trim()));
      var val = button('sm-val'); var valTxt = document.createTextNode(valueText(p)); val.appendChild(valTxt);
      val.setAttribute('aria-label', p.label.textContent.trim() + ' の数値を入力');
      var ed = el('input', 'sm-valin'); ed.type = 'number'; ed.setAttribute('inputmode', 'decimal'); ed.step = 'any'; ed.hidden = true; ed.setAttribute('aria-label', p.label.textContent.trim());
      var neg = button('sm-neg', '−'); neg.hidden = true; neg.setAttribute('aria-label', '正負を入れ替える');
      var rst = button('sm-reset', '↺'); rst.setAttribute('aria-label', p.label.textContent.trim() + ' を初期値に戻す');
      var dec = button('sm-dec sm-stepbtn', '◀'), inc = button('sm-inc sm-stepbtn', '▶');
      dec.setAttribute('aria-label', p.label.textContent.trim() + ' を 1 つ減らす'); inc.setAttribute('aria-label', p.label.textContent.trim() + ' を 1 つ増やす');
      var track = el('div', 'sm-track'); track.setAttribute('role', 'slider'); track.tabIndex = 0; track.setAttribute('aria-label', p.label.textContent.trim());
      track.appendChild(el('span', 'sm-knob'));
      top.append(lab, val, ed, neg, rst); botl.append(dec, track, inc); ui.append(top, botl);
      row.appendChild(ui);
      row._ui = { lab: lab, valTxt: valTxt, track: track, rst: rst, ui: ui };
      // 値を押すと数値入力
      function openEdit() {
        var lim = limits(p); ed.value = String(p.driver.value); ed.min = ''; ed.max = '';
        neg.hidden = !(lim.min < 0); ui.dataset.edit = '1'; val.hidden = true; ed.hidden = false; rst.hidden = true;
        ed.focus(); try { ed.select(); } catch (e) {}
      }
      var committing = false;
      function endEdit(apply) {
        if (committing) return; committing = true;
        var v = parseFloat(ed.value);
        delete ui.dataset.edit; ed.hidden = true; neg.hidden = true; val.hidden = false; rst.hidden = false;
        if (apply && !isNaN(v)) setExact(p, v);
        syncRow(row); committing = false;
      }
      val.addEventListener('click', openEdit);
      ed.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); endEdit(true); } else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); } });
      var negBusy = false;
      ed.addEventListener('blur', function () { setTimeout(function () { if (!ed.hidden && !negBusy) endEdit(true); }, 0); });
      // − ボタンを押している間は入力欄を確定しない（Safari はボタンにフォーカスを移さないため、押した事を覚えておく）
      neg.addEventListener('pointerdown', function () { negBusy = true; });
      neg.addEventListener('mousedown', function (e) { e.preventDefault(); });
      neg.addEventListener('click', function () { var v = parseFloat(ed.value); ed.value = String(isNaN(v) ? 0 : -v); negBusy = false; ed.focus(); });
      ['pointerup', 'pointercancel'].forEach(function (ev) { neg.addEventListener(ev, function () { setTimeout(function () { negBusy = false; }, 400); }); });
      rst.addEventListener('click', function () { setExact(p, parseFloat(row._initial)); syncRow(row); });
      // ◀ ▶: 1 刻み。長押し 400ms 後に 80ms 間隔で連続
      [[dec, -1], [inc, 1]].forEach(function (pair) {
        var b = pair[0], dir = pair[1], t0 = null, iv = null, held = false;
        function stop() { clearTimeout(t0); clearInterval(iv); t0 = iv = null; }
        b.addEventListener('pointerdown', function () {
          held = false; stop();
          t0 = setTimeout(function () { held = true; stepBy(p, dir); syncRow(row); iv = setInterval(function () { stepBy(p, dir); syncRow(row); }, 80); }, 400);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { b.addEventListener(ev, stop); });
        b.addEventListener('click', function () { if (held) { held = false; return; } stepBy(p, dir); syncRow(row); });
        b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      });
      // スライダー（下半分の帯だけが当たり）。
      //  つまみの上で押す: すぐ掴む（つまみとの差を保ったまま動く）。
      //  帯のほかの所で押す: 押しただけでは値を変えない。最初の動きが横（8px 以上で縦より大きい）なら掴んで横ドラッグ、
      //  縦なら何もせず一覧のスクロールに渡す。ほとんど動かさず 300ms 以内に離した時だけ、その位置へ値を飛ばす（タップ）。
      var KNOB = 28, geo = null, grab = 0, lastV = null, pend = null;
      function valueAt(x) {
        var f = Math.max(0, Math.min(1, (x - geo.left - KNOB / 2) / Math.max(1, geo.width - KNOB)));
        var v = geo.lim.min + f * (geo.lim.max - geo.lim.min);
        v = geo.lim.min + Math.round((v - geo.lim.min) / geo.lim.step) * geo.lim.step;
        v = Math.max(geo.lim.min, Math.min(geo.lim.max, v));
        return +v.toFixed(Math.min(8, decimals(geo.lim.step) + 1));
      }
      function move(e) { var v = valueAt(e.clientX - grab); if (v !== lastV) { lastV = v; change(p.driver, v); syncRow(row); } }
      function startGrab(e, offset, first) {
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
        dragging = true; ui.dataset.drag = '1'; grab = offset; lastV = null; pend = null;
        if (first) move(e);
      }
      track.addEventListener('pointerdown', function (e) {
        if (e.button) return;
        var r = track.getBoundingClientRect(); geo = { left: r.left, width: r.width, lim: limits(p) };
        var cur = parseFloat(p.driver.value), f = geo.lim.max > geo.lim.min ? (cur - geo.lim.min) / (geo.lim.max - geo.lim.min) : 0;
        var thumbX = geo.left + KNOB / 2 + Math.max(0, Math.min(1, f)) * (geo.width - KNOB);
        if (Math.abs(e.clientX - thumbX) <= 22) startGrab(e, e.clientX - thumbX, false);
        else pend = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() };
      });
      track.addEventListener('pointermove', function (e) {
        if (pend && e.pointerId === pend.id) {
          var dx = e.clientX - pend.x, dy = e.clientY - pend.y;
          if (Math.abs(dx) >= 8 && Math.abs(dx) > Math.abs(dy)) startGrab(e, 0, true);
          else if (Math.abs(dy) >= 8 && Math.abs(dy) > Math.abs(dx)) { pend = null; geo = null; }   // 縦: 何もしない（一覧がスクロールする）
          return;
        }
        if (dragging && ui.dataset.drag) move(e);
      });
      function endDrag() { pend = null; if (!ui.dataset.drag) { geo = null; return; } delete ui.dataset.drag; dragging = false; geo = null; syncRow(row); }
      track.addEventListener('pointerup', function (e) {
        if (pend && e.pointerId === pend.id) {
          var tap = Date.now() - pend.t <= 300 && geo; pend = null;
          if (tap) { lastV = null; grab = 0; move(e); }
          geo = null; return;
        }
        endDrag();
      });
      track.addEventListener('pointercancel', endDrag); track.addEventListener('lostpointercapture', endDrag);
      track.addEventListener('keydown', function (e) {
        var d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]; if (!d) return;
        e.preventDefault(); stepBy(p, d); syncRow(row);
      });
      p.driver.addEventListener('input', function () { syncRow(row); });
      p.driver.addEventListener('change', function () { syncRow(row); });
      syncRow(row);
    }
    // ---- 仕上げ: アイコンだけの部品に文字を足す・貼り付けボタン（行の組み替えのたびに、まだの物だけ）----
    var LAYER_TXT = { 'layer-eye': ['表示', '非表示'], 'layer-lock': ['固定', '固定中'], 'layer-more': ['その他', 'その他'] };
    function decorate() {
      rows.querySelectorAll('.layer-row button').forEach(function (b) {
        if (b.querySelector('.sm-btxt')) return;
        var k = Object.keys(LAYER_TXT).filter(function (c) { return b.classList.contains(c); })[0];
        var tx = k ? LAYER_TXT[k][(k === 'layer-eye' && b.classList.contains('off')) || (k === 'layer-lock' && /解除/.test(b.title)) ? 1 : 0] : (b.getAttribute('aria-label') || b.title || '').trim();
        if (!tx) return;
        if (!b.getAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title);
        b.appendChild(el('span', 'sm-btxt', tx));
      });
      if (!(navigator.clipboard && navigator.clipboard.readText)) return;
      rows.querySelectorAll('textarea').forEach(function (ta) {
        if (ta._smPaste || ta.classList.contains('sm-valin')) return; ta._smPaste = true;
        var pb = button('sm-paste', '貼り付け'); pb.setAttribute('aria-label', 'クリップボードの内容をこの欄へ貼り付ける');
        var tmr = null;
        function say(t) { pb.textContent = t; clearTimeout(tmr); tmr = setTimeout(function () { pb.textContent = '貼り付け'; }, 2500); }
        pb.addEventListener('click', function () {
          navigator.clipboard.readText().then(function (t) {
            if (!t) { say('クリップボードが空です'); return; }
            ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); say('貼り付けました');
          }, function () { say('貼り付けできません（欄を長押しして貼り付け）'); });
        });
        ta.insertAdjacentElement('afterend', pb);
      });
    }
    function wireAll() {
      rows.querySelectorAll(A.rows).forEach(function (r) { if (!r.classList.contains('sm-row')) r.classList.add('sm-row'); });
      rows.querySelectorAll('.sm-row').forEach(wireRow);
      decorate();
    }
    wireAll(); refreshTabs();
    groups.forEach(function (r) { r.ready = true; });
    var scheduled = false;
    // 行の監視は class と hidden だけ。style（つまみの位置）と文字の更新は見ない。ドラッグ中は止める。
    new MutationObserver(function () {
      if (scheduled || dragging) return; scheduled = true;
      requestAnimationFrame(function () { scheduled = false; if (dragging) return; wireAll(); refreshTabs(); syncAll(); });
    }).observe(rows, {childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden']});
    // programmatic values.set（取り消し・復元）後も表示を同期する。
    new MutationObserver(function () { if (!dragging) syncSoon(); }).observe(stage, {childList: true, subtree: true});
    if (window.ResizeObserver) new ResizeObserver(function () { if (!dragging) updateSpacer(); }).observe(rows);
    // ---- 下シートの高さ: 小 ↔ 中（つまみの上下ドラッグか押す）----
    // 小（216px＝つまみ 28＋見出し 28＋値の行 2 本 114＋帯 44）: 開いた直後は先頭（scrollTop 0）。先頭の群の見出しと先頭 2 行が見える。自動で途中へ送らない。
    function level(v) {
      sheet.dataset.level = v; root.dataset.level = v;
      // 先頭の群の見出し程度しか送っていない時は、先頭から見せる（中の見出しは上に貼り付くため）
      var hh = groups[0] ? groups[0].head.offsetHeight || 32 : 0;
      if (rows.scrollTop <= hh) rows.scrollTop = 0;
      requestAnimationFrame(function () { updateSpacer(); spy(); });
    }
    var startY = null, swallowUntil = 0, swallowAt = null;
    // つまみで段が変わると、指の下に別の部品が来る。指を離した場所へ届く合成クリックだけを、短い間止める
    document.addEventListener('click', function (e) {
      if (Date.now() < swallowUntil && swallowAt && Math.abs(e.clientX - swallowAt.x) <= 24 && Math.abs(e.clientY - swallowAt.y) <= 24 && !grip.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    grip.addEventListener('pointerdown', function (e) { startY = e.clientY; try { grip.setPointerCapture(e.pointerId); } catch (err) {} });
    grip.addEventListener('pointerup', function (e) {
      if (startY == null) return;
      var d = e.clientY - startY; startY = null;
      swallowUntil = Date.now() + 600; swallowAt = { x: e.clientX, y: e.clientY };
      if (d < -16) level('mid'); else if (d > 16) level('small'); else level(sheet.dataset.level === 'small' ? 'mid' : 'small');
    });
    grip.addEventListener('pointercancel', function () { startY = null; });
    grip.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); level(sheet.dataset.level === 'small' ? 'mid' : 'small'); }
      else if (e.key === 'ArrowUp') level('mid'); else if (e.key === 'ArrowDown') level('small');
    });
    // ---- 下帯 ----
    if (A.noUndo) { undo.hidden = true; redo.hidden = true; }   // 取り消しの無いツールでは、何も起きないボタンを出さない
    function fireKey(shift) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: !!shift, bubbles: true, cancelable: true })); }
    undo.addEventListener('click', function () {
      if (undoEl) undoEl.click();   // 自前の履歴を持つツール（139・148）は、その取り消しボタンを押す
      else fireKey(false);
      setTimeout(syncAll, 30);
    });
    redo.addEventListener('click', function () {
      if (redoEl) redoEl.click(); else fireKey(true);
      setTimeout(syncAll, 30);
    });
    [[undoEl, undo], [redoEl, redo]].forEach(function (pair) {
      var o = pair[0], b = pair[1]; if (!o) return;
      var s = function () { b.disabled = o.disabled; };
      new MutationObserver(s).observe(o, { attributes: true, attributeFilter: ['disabled'] }); s();
    });
    save.addEventListener('click', function () {
      var b = svgButton || (A.saveSel && document.querySelector(A.saveSel));
      if (!b && A.saveText) b = Array.from(menuBody.querySelectorAll('button')).find(function (n) { return A.saveText.test(n.textContent); });
      if (b) b.click();
    });
    // GitHub の状態（studio-vault があれば受けるだけ）
    if (window.StudioVault && StudioVault.onChange) StudioVault.onChange(function (n, connected) {
      wait.textContent = '待ち ' + n + ' 件'; wait.hidden = !n;
      save.setAttribute('aria-label', 'SVG を書き出す' + (n ? '（GitHub への送信待ち ' + n + ' 件）' : ''));
      ghState.textContent = (connected ? '接続済' : '未接続') + (n ? '・待ち ' + n + ' 件' : '');
      gh.dataset.state = connected ? 'on' : 'off';
    });
    // ---- ⋯ シート ----
    // 押した後に元のツールが文字を書き換えるボタン（単位 mm/px 等）は、押した直後に表示の形へ戻す
    menuBody.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('button'); if (b) setTimeout(function () { setLabel(b); }, 0); });
    function close() { backdrop.hidden = true; more.setAttribute('aria-expanded', 'false'); more.focus(); }
    more.addEventListener('click', function () {
      menuBody.querySelectorAll('button').forEach(setLabel);
      // 同じ文字の項目が並んだら 1 つだけ残す
      var seen = {}; menuBody.querySelectorAll('button').forEach(function (b) { var t = b.textContent.trim(); if (!t || b.hidden && !b.dataset.smDup) return; if (seen[t]) { b.hidden = true; b.dataset.smDup = '1'; } else { seen[t] = 1; if (b.dataset.smDup) { b.hidden = false; delete b.dataset.smDup; } } });
      renderLog();
      backdrop.hidden = false; more.setAttribute('aria-expanded', 'true'); menu.focus();
    });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function (e) {
      if (backdrop.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        var items = Array.from(menu.querySelectorAll('button,input,select,[tabindex]')).filter(function (n) { return n.getClientRects().length && !n.disabled; });
        var first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === menu)) { e.preventDefault(); if (last) last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === menu)) { e.preventDefault(); if (first) first.focus(); }
      }
    });
    // ---- 色の小窓（kit のもの）: シートの上端に接して下から出す（版面の下 1/2 まで）。見出しに押した見本の文字・右上に「閉じる」。背面に透明の幕を敷き、幕のタップで閉じる（その 1 押しは版面にも一覧にも届かせない）----
    function decorateCpop(pop) {
      if (pop._sm) return; pop._sm = true;
      var head = el('div', 'sm-cpop-head'), ttl = el('span', 'sm-cpop-title', '色'), c = button('sm-cpop-close', '閉じる');
      c.setAttribute('aria-label', '色の小窓を閉じる');
      head.append(ttl, c); pop.insertBefore(head, pop.firstChild);
      // 背面の透明な幕（GitHub 小窓の幕と同じ作り）。幕の pointerdown で小窓を閉じ、その 1 押しを版面・一覧へ通さない。
      // 閉じた後の click も幕が受けるよう、幕は指を離すまで（click か 600ms）残す。
      var shield = el('div', 'sm-cpop-backdrop'); shield.hidden = true; document.body.insertBefore(shield, pop);
      var pending = false, pendT = 0;
      function closePop() {
        var cur = document.querySelector('.cmn-colors .cswatch[aria-pressed=true]');
        if (cur && !pop.hidden) cur.click(); else pop.hidden = true;
        if (!pop.hidden) pop.hidden = true;
      }
      // 幕は小窓が本当に見えている間だけ残す（小窓が外れた・見えない時は必ず消す）
      function popShown() { return pop.isConnected && !pop.hidden && pop.getClientRects().length > 0; }
      function release() { pending = false; clearTimeout(pendT); shield.hidden = !popShown(); }
      c.addEventListener('click', closePop);
      window.addEventListener('pointerdown', function (e) {
        if (e.target !== shield) return;
        e.stopPropagation(); e.preventDefault();   // kit の外側タップ判定より先に受ける（window の capture）
        pending = true; clearTimeout(pendT); pendT = setTimeout(release, 600);
        if (popShown()) closePop(); else pop.hidden = true;
      }, true);
      window.addEventListener('click', function (e) {
        if (e.target !== shield) return;
        e.stopPropagation(); e.preventDefault(); release();
      }, true);
      new MutationObserver(function () {
        if (pop.hidden) { if (!pending) shield.hidden = true; return; }
        shield.hidden = false;
        var cur = document.querySelector('.cmn-colors .cswatch[aria-pressed=true]');
        ttl.textContent = (cur && (cur.getAttribute('aria-label') || cur.title)) || '色';
        var sh = sheet.getBoundingClientRect(), v = view.getBoundingClientRect();
        pop.style.setProperty('--sm-cpop-bottom', Math.round(innerHeight - sh.top) + 'px');
        // 上端は版面の 1/2 以上の位置・下端はシート上端。中身が収まらない時だけ内側スクロール
        pop.style.setProperty('--sm-cpop-max', Math.max(120, Math.floor(Math.min(v.height / 2, sh.top - (v.top + v.height / 2)))) + 'px');
      }).observe(pop, { attributes: true, attributeFilter: ['hidden'] });
    }
    document.querySelectorAll('.cpop').forEach(decorateCpop);
    // ---- 通知: 2 秒・ファイル名を出さない ----
    var toastT = null;
    function watchToast(t) {
      if (t._sm) return; t._sm = true;
      new MutationObserver(function () {
        if (!t.classList.contains('on')) return;
        var first = t.firstChild;
        if (first && first.nodeType === 3) {
          var m = /^[^\s/]+\.(svg|png|mp4|json)$/i.exec(first.data.trim());
          if (m) first.data = ({ svg: 'SVG', png: 'PNG', mp4: '映像', json: 'JSON' }[m[1].toLowerCase()]) + ' を書き出しました';
        }
        clearTimeout(toastT);
        // 通知は必ず時間で消す（押せる通知が版面の上端に残り続けない）。ボタン付き（sticky）は 8 秒
        if (t.classList.contains('sticky')) toastT = setTimeout(function () { t.classList.remove('on'); }, 8000);
        else if (!t.classList.contains('err')) toastT = setTimeout(function () { t.classList.remove('on'); }, 2000);
      }).observe(t, { attributes: true, attributeFilter: ['class'], childList: true });
    }
    var tt = document.getElementById('toast'); if (tt) watchToast(tt);
    new MutationObserver(function (list) {
      list.forEach(function (m) { m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.id === 'toast') watchToast(n); if (n.classList && n.classList.contains('cpop')) decorateCpop(n);
      }); });
    }).observe(document.body, { childList: true });
    // 見る変形は SVG 自体へ書かず、外側のステージにのみ適用。（版面に触れてもシートの段は変えない）
    var gesture = null, x = 0, y = 0, scale = 1, multi = false;
    function points(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) }; }
    // ステージ内の重ね置き（position:absolute/fixed）は、見る拡縮の外へ出して版面（view）に重ねる。
    // 136 の候補シート #cand など。下のシートは覆わないので、開いたままでも押せる。
    if (A.overlay) Array.from(stage.children).forEach(function (c) {
      var pos = getComputedStyle(c).position;
      if (pos === 'absolute' || pos === 'fixed' || c.id === 'cand') { c.classList.add('sm-overlay'); view.appendChild(c); }
    });
    // ツール側が touch-action:none の canvas で自前の 2 本指（touches）を持つ時（139）と、
    // 版面そのものが横にスクロールする時（162）は、見る拡縮を切る。アダプタの ownPinch。
    function ownPinch() { return !!A.ownPinch; }
    view.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 2 || ownPinch() || multi) return;   // multi: 下の指の調停が見る拡縮を受け持つ（タッチ対象が描き直しで消えても届く）
      e.preventDefault(); gesture = { p: points(e.touches), x: x, y: y, s: scale };
    }, { passive: false });
    view.addEventListener('touchmove', function (e) {
      if (!gesture || e.touches.length !== 2) return;
      e.preventDefault(); var p = points(e.touches);
      scale = Math.max(0.25, Math.min(8, gesture.s * p.d / (gesture.p.d || 1)));
      x = gesture.x + p.x - gesture.p.x; y = gesture.y + p.y - gesture.p.y;
      stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    }, { passive: false });
    view.addEventListener('touchend', function () { gesture = null; });
    view.addEventListener('touchcancel', function () { gesture = null; });
    if (A.syncPtr) ['pointerup', 'pointercancel'].forEach(function (t) { view.addEventListener(t, function () { setTimeout(syncAll, 50); }); });
    // ---- 2本指の調停（全ツール）と 139 の「描く／動かす」 ----
    // 1 本目はツールへ素通し。2 本目が来た瞬間に 1 本目の対象へ合成の pointerup（同じ pointerId）を送り、
    // 以後その 2 本のポインター操作はツールへ渡さず、版面の見る拡縮・移動（上のタッチ処理）だけに使う。
    // 取り消しは pinchUndo のツールだけ（1 本目が絵を変えていた時だけ 1 回）。162 と 139 の「動かす」は元のまま。
    var drawMode = true, modeBtn = null;
    if (APP === 'spline-draw') {
      modeBtn = button('sm-mode', '描く'); modeBtn.setAttribute('aria-pressed', 'true');
      modeBtn.setAttribute('aria-label', '指の動き: 描く（押すと動かすに切り替え）');
      modeBtn.addEventListener('click', function () {
        drawMode = !drawMode;
        modeBtn.textContent = drawMode ? '描く' : '動かす'; modeBtn.setAttribute('aria-pressed', String(drawMode));
        modeBtn.setAttribute('aria-label', drawMode ? '指の動き: 描く（押すと動かすに切り替え）' : '指の動き: 動かす（押すと描くに切り替え）');
      });
      view.appendChild(modeBtn);   // 版面の左上に浮かせる（下帯には置かない）
    }
    var act = new Map(), gdraw = false, snap0 = null, pinch2 = null;
    // 1 本目の間に絵が変わったかを見る。1 本目を置く前の状態（版面の DOM・状態欄など extra の文字・取り消しの押せる／押せない）を覚え、
    // 2 本目が来た時に比べる（DOM の変化の回数ではなく中身で比べる。同じ文字の書き直しは変化に数えない）
    function snapState() {
      var t = stage.innerHTML;
      A.extra.forEach(function (x) { var n = document.querySelector(x.sel); if (n) t += '\u0000' + n.textContent; });
      return t + '\u0000' + (undoEl ? String(undoEl.disabled) : '');
    }
    function watchChange() { snap0 = snapState(); }
    function changedSince() { return snap0 != null && snapState() !== snap0; }
    function synth(type, id, target, x, y, ptype) {
      var down = type === 'pointerdown' || type === 'pointermove';
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: window, pointerId: id, pointerType: ptype, isPrimary: true,
        clientX: x, clientY: y, screenX: x, screenY: y, width: 1, height: 1,
        button: type === 'pointermove' ? -1 : 0, buttons: down ? 1 : 0, pressure: down ? 0.5 : 0
      }));
    }
    // 描き直しで元の要素が外れる（三角格子はマスを塗ると盤面を作り直す）時は、指の下にいま在る要素へ送る
    function liveTarget(d) {
      if (d.target.isConnected) return d.target;
      var n = document.elementFromPoint(d.x, d.y);
      return n && view.contains(n) ? n : stage;
    }
    function dist2(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; }
    function applyPinch2() {
      var ids = Array.from(act.keys()); if (!pinch2 || ids.length !== 2) return;
      var p = dist2(act.get(ids[0]), act.get(ids[1]));
      scale = Math.max(0.25, Math.min(8, pinch2.s * p.d / (pinch2.p.d || 1)));
      x = pinch2.x + p.x - pinch2.p.x; y = pinch2.y + p.y - pinch2.p.y;
      stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    }
    function stopObs() { snap0 = null; }
    function resetAct() { act.clear(); if (typeof ownDown !== 'undefined') ownDown.clear(); multi = false; gdraw = false; pinch2 = null; stopObs(); if (pend2) { clearTimeout(pend2.timer); pend2 = null; } }
    // H2: iOS で合成イベントの pointerId などに setPointerCapture が例外を投げると、ツールの pointerdown がそこで止まる。
    // 押された要素から版面までの各要素に、失敗を無視する薄い包みをインスタンスのメソッドとして置く（ツールの src は変えない）
    function guardCapture(n) {
      for (; n && n !== root; n = n.parentNode) {
        if (n.nodeType !== 1 || n._smPC) continue;
        n._smPC = true;
        n.setPointerCapture = function (id) {
          try { return Element.prototype.setPointerCapture.call(this, id); } catch (err) { logNote('capture-failed', tagOf(this) + ' id=' + id + ' ' + (err && err.name)); }
        };
        n.releasePointerCapture = function (id) { try { return Element.prototype.releasePointerCapture.call(this, id); } catch (err) {} };
      }
    }
    view.addEventListener('pointerdown', function (e) { guardCapture(e.target); }, true);
    // H7: 点（.pt）は画面上 7px ほどで、指では当たらない。押した所から 22px 以内に点があれば、その点を押した事にする
    var HIT_R = 22;
    function nearHit(target, cx, cy) {
      var sel = A.hitSel; if (!sel || !target || !target.closest || target.closest(sel) || !stage.contains(target)) return null;
      var best = null, bd = HIT_R;
      stage.querySelectorAll(sel).forEach(function (n) {
        var r = n.getBoundingClientRect(); if (!r.width && !r.height) return;
        var d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
        if (d <= bd) { bd = d; best = n; }
      });
      return best;
    }
    // canvas の点（hitPts）: 押した所から 22px 以内で一番近い点の位置。ほぼ真上（1px 未満）なら元のまま
    function nearPt(target, cx, cy) {
      if (!A.hitPts || !target || !target.closest || !stage.contains(target)) return null;
      var best = null, bd = HIT_R;
      A.hitPts(target).forEach(function (q) { var d = Math.hypot(q.x - cx, q.y - cy); if (d <= bd) { bd = d; best = q; } });
      return best && bd >= 1 ? best : null;
    }
    var ownDown = new Set(), ownMark = null;   // 自前の 2 本指のツール: 版面に置かれている指の数と、1 本目を置いた時の印
    // 1 本目の指。戻り値 true＝元の pointerdown を止めた（代わりに合成を送った）
    function startFirst(id, target, cx, cy, resend, alone) {
      var drawing = APP === 'spline-draw' && drawMode;
      if (A.ownPinch && !drawing) {
        act.delete(id);
        var np = alone ? nearPt(target, cx, cy) : null;
        if (np) { logNote('near-point', tagOf(target) + ' ' + Math.round(Math.hypot(np.x - cx, np.y - cy)) + 'px'); synth('pointerdown', id, target, np.x, np.y, 'touch'); return true; }
        if (resend) synth('pointerdown', id, target, cx, cy, 'touch');
        return resend;
      }
      gdraw = drawing; multi = false;
      var tg = gdraw ? target : (nearHit(target, cx, cy) || target);
      if (tg !== target) logNote('near-point', tagOf(target) + ' -> ' + tagOf(tg));
      act.set(id, { target: tg, x: cx, y: cy, moved: false });
      if (A.pinchUndo) watchChange();
      if (gdraw) { try { synth('pointerdown', id, target, cx, cy, 'pen'); } catch (err) {} return true; }
      if (resend || tg !== target) { synth('pointerdown', id, tg, cx, cy, 'touch'); return true; }
      return false;
    }
    // 2 本目の指（確定）: 1 本目をツールから外し、以後は見る拡縮へ
    function startSecond(q) {
      multi = true;
      var first = null, fid = null; act.forEach(function (v, k) { if (k !== q.id && !first) { first = v; fid = k; } });
      if (!first) return;
      if (gdraw) {
        // 描いていた 1 本目を pen の pointerup で終え、同じ指を touch として 139 の自前の拡縮に引き渡す。2 本目も touch で渡す
        synth('pointerup', fid, liveTarget(first), first.x, first.y, 'pen');
        var drew = A.pinchUndo && !A.noUndo && changedSince(); stopObs();
        if (drew) { if (undoEl) undoEl.click(); else fireKey(false); setTimeout(syncAll, 30); }   // 2 本指の拡縮になるので、1 本目が置いた点は取り消す
        synth('pointerdown', fid, liveTarget(first), first.x, first.y, 'touch');
        synth('pointerdown', q.id, q.target.isConnected ? q.target : liveTarget(q), q.x, q.y, 'touch');
      } else {
        var changed = changedSince(); stopObs();
        synth('pointerup', fid, liveTarget(first), first.x, first.y, 'touch');
        if (!A.ownPinch) pinch2 = { p: dist2(first, act.get(q.id)), x: x, y: y, s: scale };
        if (A.pinchUndo && changed && !A.noUndo) { if (undoEl) undoEl.click(); else fireKey(false); setTimeout(syncAll, 30); }
      }
    }
    // 2 本目らしい pointerdown は、直後の touchstart（画面に載っている指の本数）で本当に 2 本かを確かめてから扱う。
    // iOS では、ツールが描き直して外れた要素の上で指を離すと pointerup が版面まで届かず、古い指の記録が残る。
    // そのままだと次の 1 本指が「2 本目」になり、ツールに何も届かない（操作が効かない）。
    var pend2 = null;
    function viewTouches(e) {
      return Array.prototype.filter.call(e.touches || [], function (tc) { var n = tc.target; return !n || !n.isConnected || view.contains(n); }).length;
    }
    function resolve2(isMulti) {
      var q = pend2; if (!q) return; pend2 = null; clearTimeout(q.timer);
      if (isMulti) { startSecond(q); return; }
      logNote('stale-reset', 'act=' + act.size);
      act.forEach(function (v, k) { if (k !== q.id) act.delete(k); });
      multi = false; pinch2 = null; stopObs();
      startFirst(q.id, q.target.isConnected ? q.target : liveTarget(q), q.x, q.y, true);
    }
    window.addEventListener('touchstart', function (e) { if (pend2) resolve2(viewTouches(e) >= 2); }, true);
    window.addEventListener('touchend', function (e) { if (!pend2 && act.size && !viewTouches(e)) resetAct(); }, true);
    window.addEventListener('touchcancel', function (e) { if (!pend2 && act.size && !viewTouches(e)) resetAct(); }, true);
    function onPointer(e) {
      // H4: マウス以外（touch・pen。iOS が指に pen を返す事がある）はすべて指として扱う。2 本目の判定は pointerId の個数で行う
      if (!e.isTrusted || e.pointerType === 'mouse') return;
      if (e.target.closest && e.target.closest('.sm-mode') && !act.has(e.pointerId)) return;   // 「描く／動かす」の押下は指の調停に数えない
      var id = e.pointerId, ty = e.type, d = act.get(id), alone = false;
      if (A.ownPinch && A.hitPts) {
        if (ty === 'pointerdown') {
          alone = ownDown.size === 0; ownDown.add(id);
          if (alone) ownMark = A.pinchSave ? A.pinchSave() : null;
          else if (ownDown.size === 2 && A.pinchRestore && ownMark != null) A.pinchRestore(ownMark);
        } else if (ty === 'pointerup' || ty === 'pointercancel') ownDown.delete(id);
      }
      if (pend2 && (ty !== 'pointerdown' || id !== pend2.id)) resolve2(true);   // 確かめる前に別の動きが来たら、従来どおり 2 本目として扱う
      if (ty === 'pointerdown') {
        if (act.size === 0) { if (startFirst(id, e.target, e.clientX, e.clientY, false, alone)) e.stopPropagation(); return; }
        if (multi) { act.set(id, { target: e.target, x: e.clientX, y: e.clientY, moved: false }); if (!gdraw) e.stopPropagation(); return; }
        // 2 本目の指（かもしれない）。ツールへは渡さず、直後の touchstart で確かめる（来なければ 80ms で 2 本目とみなす）
        act.set(id, { target: e.target, x: e.clientX, y: e.clientY, moved: false });
        e.stopPropagation();
        pend2 = { id: id, target: e.target, x: e.clientX, y: e.clientY, timer: setTimeout(function () { resolve2(true); }, 80) };
        return;
      }
      d = act.get(id);
      if (ty === 'pointermove') {
        if (!d) return;
        d.x = e.clientX; d.y = e.clientY; d.moved = true;
        if (multi) { if (!gdraw) { e.stopPropagation(); applyPinch2(); } }
        else if (gdraw) { e.stopPropagation(); try { synth('pointermove', id, d.target, e.clientX, e.clientY, 'pen'); } catch (err) {} }
        return;
      }
      if (ty === 'pointerup' || ty === 'pointercancel') {
        if (!d) return;
        if (multi) { if (!gdraw) e.stopPropagation(); }
        else if (gdraw) { e.stopPropagation(); try { synth(ty, id, d.target, e.clientX, e.clientY, 'pen'); } catch (err) {} }
        act.delete(id);
        if (act.size < 2) pinch2 = null;
        if (!act.size) resetAct();
      }
    }
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (t) { view.addEventListener(t, onPointer, true); });
    view.addEventListener('touchend', function (e) { if (!e.touches.length) resetAct(); }, true);
    view.addEventListener('touchcancel', function (e) { if (!e.touches.length) resetAct(); }, true);
    // H3: iOS は版面の上でも長押しの選択・拡大鏡・ページ全体のピンチ拡大を始め、ツールへ pointercancel を送る。
    // 版面の絵（canvas / svg）への touchstart・touchmove は既定動作を止める（pointer イベントはそのまま届く）。
    // ボタン・入力欄・版面に重ねた部品は除く。162 は版面が横にスクロールするので止めない。
    function rawTouchTarget(n) {
      if (A.scroll || !n || !n.closest || !stage.contains(n)) return false;
      if (n.closest('button, a, input, select, textarea, label, [role=button], [contenteditable], .sm-overlay')) return false;
      return !!n.closest('canvas, svg');
    }
    function stopTouchDefault(e) { if (e.cancelable && rawTouchTarget(e.target)) e.preventDefault(); }
    view.addEventListener('touchstart', stopTouchDefault, { passive: false });
    view.addEventListener('touchmove', stopTouchDefault, { passive: false });
    ['gesturestart', 'gesturechange'].forEach(function (ty) { document.addEventListener(ty, function (e) { e.preventDefault(); }, { passive: false }); });
    // ---- キーボード表記（（N）・⌘ 等）を表示から外す。ツールが後から文字を書き換えても外す ----
    var stripQ = false;
    function stripSoon() { if (stripQ) return; stripQ = true; requestAnimationFrame(function () { stripQ = false; if (!dragging) stripKeyNodes(root); }); }
    new MutationObserver(stripSoon).observe(root, { childList: true, characterData: true, subtree: true });
    stripKeyNodes(root);
    // ---- 横に並ぶ案: 1 画面 1 案・下に「1 / N」と ◀ ▶（162）----
    var pagerBox = A.pager ? document.querySelector(A.pager) : null;
    if (pagerBox) {
      var pg = el('div', 'sm-pager'), pPrev = button('sm-pager-btn', '◀'), pNext = button('sm-pager-btn', '▶'), pPos = el('span', 'sm-pager-pos', '1 / 1');
      pPrev.setAttribute('aria-label', '前の案'); pNext.setAttribute('aria-label', '次の案'); pPos.setAttribute('aria-live', 'polite');
      pg.append(pPrev, pPos, pNext); pagerBox.insertAdjacentElement('afterend', pg);
      var cellsOf = function () { return Array.from(pagerBox.children).filter(function (c) { return c.classList.contains('cell'); }); };
      var curIdx = function () { var w = pagerBox.clientWidth || 1; return Math.max(0, Math.min(cellsOf().length - 1, Math.round(pagerBox.scrollLeft / w))); };
      var syncPager = function () {
        var n = cellsOf().length, i = curIdx(); pPos.textContent = (n ? i + 1 : 0) + ' / ' + n;
        pPrev.disabled = i <= 0; pNext.disabled = i >= n - 1; pg.hidden = n < 1;
      };
      var goPage = function (d) { var i = Math.max(0, Math.min(cellsOf().length - 1, curIdx() + d)); pagerBox.scrollTo({ left: i * pagerBox.clientWidth, behavior: 'smooth' }); };
      pPrev.addEventListener('click', function () { goPage(-1); }); pNext.addEventListener('click', function () { goPage(1); });
      pagerBox.addEventListener('scroll', syncPager, { passive: true });
      new MutationObserver(function () { requestAnimationFrame(syncPager); }).observe(pagerBox, { childList: true });
      if (window.ResizeObserver) new ResizeObserver(syncPager).observe(pagerBox);
      syncPager();
      // 値が変わったら、元の案（1/N）のままにせず最初の案（2/N）を見せる
      rows.addEventListener('input', function (e) {
        var t = e.target; if (!t || !t.matches || !t.matches('input[type=range], input[type=number]') || t.classList.contains('sm-valin')) return;
        setTimeout(function () { if (cellsOf().length >= 2 && curIdx() === 0) goPage(1); }, 120);
      }, true);
    }
    // 最初は小のシート。一覧は先頭から
    requestAnimationFrame(function () { updateSpacer(); rows.scrollTop = 0; spy(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
