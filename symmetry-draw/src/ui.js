/* ui.js — 左の道具の列・右パネル（対称／展開／線／多角形）。上部バーとキーは index.html。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var T = SD.tools, ui = SD.ui = {};
  var RAIL = ['select', 'direct', 'pen', 'pencil', 'line', 'rect', 'ellipse', 'polygon', 'eraser', 'builder'];
  var ICON_X = '<path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  var ICON_BIN = '<path d="M5 7H19M10 7V4.5H14V7M7 7L8 20H16L17 7M10.5 10.5V16.5M13.5 10.5V16.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function svgIcon(inner) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>'; }

  /* ---- 左の道具の列（アイコン＋文字。1回押す／1キーで切り替わる） ---- */
  var toolBtns = {}, delBtn = null, clearBtn = null, armed = false, armTimer = null;
  function buildRail(nav) {
    RAIL.forEach(function (name) {
      var t = T.map[name];
      var b = el('button', 'toolbtn', svgIcon(t.icon) + '<span>' + t.label + '</span>');
      b.type = 'button'; b.dataset.tool = name; b.title = (t.title || t.label) + '（' + t.key + '）';
      b.addEventListener('click', function () { T.set(name); b.blur(); });
      nav.appendChild(b); toolBtns[name] = b;
    });
    nav.appendChild(el('div', 'tool-hr'));
    delBtn = el('button', 'toolbtn', svgIcon(ICON_X) + '<span>削除</span>');
    delBtn.type = 'button'; delBtn.title = '選んだ図形を消す（Delete）';
    delBtn.addEventListener('click', function () { T.deleteSelected(); delBtn.blur(); });
    nav.appendChild(delBtn);
    var penDone = el('button', 'toolbtn sm-only', svgIcon('<path d="M5 12.5L10 17.5L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>') + '<span>ペンを確定</span>');
    penDone.type = 'button'; penDone.id = 'penDoneBtn'; penDone.title = 'ペンで描いている線を、開いたまま確定する（キーボードの Enter と同じ）';
    penDone.addEventListener('click', function () { T.enter(); penDone.blur(); });
    nav.appendChild(penDone);
    clearBtn = el('button', 'toolbtn', svgIcon(ICON_BIN) + '<span>全部消す</span>');
    clearBtn.id = 'clearAllBtn'; clearBtn.type = 'button'; clearBtn.title = '図形をすべて消す（2回押す。⌘Z で戻せる）';
    clearBtn.addEventListener('click', function () {
      if (!armed) {   // 1回目: ボタンが「本当に全部消す」に変わる。3秒で元に戻る
        armed = true; clearBtn.classList.add('warn');
        clearBtn.querySelector('span').innerHTML = '本当に<br>全部消す';
        armTimer = setTimeout(disarm, 3000); return;
      }
      disarm(); SD.clearAll(); Studio.toast('全部消しました（⌘Z で戻せます）'); clearBtn.blur();
    });
    nav.appendChild(clearBtn);
  }
  function disarm() {
    clearTimeout(armTimer); armed = false;
    clearBtn.classList.remove('warn'); clearBtn.querySelector('span').textContent = '全部消す';
  }

  /* ---- 右パネル「対称」: 種類ごとの見出し（畳める）＋群のボタン格子（小さな見本＋名前） ---- */
  var symBtns = {}, secs = {};
  function buildSym(mount) {
    var grp = el('div', 'sk-grp'), ttl = el('button', 'sk-grp-ttl', '対称');
    ttl.type = 'button'; ttl.setAttribute('aria-expanded', 'true');
    ttl.addEventListener('click', function () { ttl.setAttribute('aria-expanded', String(!grp.classList.toggle('closed'))); });
    grp.appendChild(ttl);
    SD.groups.sections.forEach(function (sec) {
      var head = el('button', 'symsub', '<span class="symarrow"></span>' + sec);
      head.type = 'button';
      var grid = el('div', 'symgrid');
      function setOpen(on) { grid.hidden = !on; head.setAttribute('aria-expanded', String(on)); }
      head.addEventListener('click', function () { setOpen(grid.hidden); });
      SD.groups.list.filter(function (g) { return g.section === sec; }).forEach(function (g) {
        var b = el('button', 'symbtn', SD.layout.thumb(g.name) + '<span>' + g.name + '</span>');
        b.type = 'button'; b.dataset.group = g.name; b.title = sec + ' ' + g.name;
        b.addEventListener('click', function () { SD.setGroup(g.name); b.blur(); });
        grid.appendChild(b); symBtns[g.name] = b;
      });
      grp.appendChild(head); grp.appendChild(grid);
      secs[sec] = { setOpen: setOpen };
      setOpen(false);
    });
    mount.appendChild(grp);
  }

  /* ---- 右パネル「展開」「線」「多角形」（Studio.panel） ---- */
  var values = null;
  function buildParams(mount) {
    var S = SD.state, P = SD.prefs;
    values = Studio.panel(mount, [
      { type: 'group', label: '線' },
      { type: 'range', key: 'sw', label: '線幅', unit: 'px', min: 0.5, max: 60, step: 0.5, value: P.sw, stops: [] },
      { type: 'range', key: 'opacity', label: '不透明度', unit: '%', min: 5, max: 100, step: 5, value: Math.round(P.opacity * 100), stops: [] },
      { type: 'group', label: '展開' },
      { type: 'range', key: 'gap', label: '間隔', unit: 'px', min: SD.GAP[0], max: SD.GAP[1], step: 4, value: S.params.gap, stops: [] },
      { type: 'range', key: 'size', label: '大きさ', unit: 'px', min: SD.SIZE[0], max: SD.SIZE[1], step: 2, value: S.params.size, stops: [] },
      { type: 'checkbox', key: 'rows', label: '帯の段を重ねる', value: S.params.rows },
      { type: 'checkbox', key: 'guides', label: '補助線（格子・回転の区切り）を表示', value: P.guides },
      { type: 'checkbox', key: 'snap', label: '吸着する（アンカー・交点・格子）', value: P.snap },
      { type: 'group', label: '多角形' },
      { type: 'range', key: 'sides', label: '辺の数', unit: '個', min: 3, max: 24, step: 1, value: P.sides, integer: true }
    ], function (v, key) {
      if (key === null) return;
      var S2 = SD.state;
      if (key === 'gap' || key === 'size') { S2.params[key] = v[key]; SD.commitSoon(); }
      else if (key === 'rows') { S2.params.rows = !!v.rows; SD.commitSoon(); }
      else if (key === 'guides') { SD.prefs.guides = !!v.guides; SD.persist(); SD.emit('change'); }
      else if (key === 'snap') { SD.prefs.snap = !!v.snap; SD.persist(); }
      else if (key === 'sw' || key === 'opacity') {   // 選択があれば選択だけに、無ければ次に描く物に
        var patch = key === 'sw' ? { sw: v.sw } : { opacity: v.opacity / 100 };
        if (!SD.ops.applyStyle(patch)) { Object.assign(SD.prefs, patch); SD.persist(); }
      }
      else if (key === 'sides') { SD.prefs.sides = v.sides; SD.persist(); }
    });
  }
  function rowOf(label) {   // 行の見つけ方: 入力欄の aria-label か、チェックの文字
    var m = values.mount, hit = m.querySelector('input[aria-label="' + label + '"]');
    if (hit) return hit.closest('.sk-row');
    var spans = m.querySelectorAll('.sk-checkrow span');
    for (var i = 0; i < spans.length; i++) if (spans[i].textContent === label) return spans[i].closest('.sk-row');
    return null;
  }

  /* ---- 状態を画面へ ---- */
  function sync() {
    var S = SD.state, g = SD.groups.byName[S.group];
    Object.keys(symBtns).forEach(function (n) { symBtns[n].setAttribute('aria-pressed', String(n === S.group)); });
    if (S.group !== lastGroup) { secs[g.section].setOpen(true); lastGroup = S.group; }   // 選んだ群の種類は開く
    Object.keys(toolBtns).forEach(function (n) { toolBtns[n].classList.toggle('active', n === T.current); });
    delBtn.disabled = !S.sel.length;
    var pb = document.getElementById('penDoneBtn');
    if (pb) pb.disabled = !(T.map.pen && T.map.pen.busy && T.map.pen.busy());
    if (values) {
      var first = SD.ops.selected()[0];   // 選択があれば、その図形の線幅・不透明度を見せる
      values.set('gap', S.params.gap); values.set('size', S.params.size); values.set('rows', S.params.rows);
      values.set('guides', SD.prefs.guides); values.set('snap', SD.prefs.snap);
      values.set('sw', first ? first.sw : SD.prefs.sw);
      values.set('opacity', Math.round((first ? first.opacity : SD.prefs.opacity) * 100));
      // 回転の群は間隔・大きさが効かない／壁紙は帯の段が効かない: 効かない行は隠す
      [['間隔', g.kind !== 'rosette'], ['大きさ', g.kind !== 'rosette'], ['帯の段を重ねる', g.kind === 'frieze']].forEach(function (p) {
        var r = rowOf(p[0]); if (r) r.hidden = !p[1];
      });
    }
    if (SD.syncSwatches) SD.syncSwatches();
  }
  var lastGroup = null;

  ui.init = function () {
    buildRail(document.getElementById('toolrail'));
    buildParams('#params');
    buildSym(document.getElementById('symbox'));
    SD.view.svg.style.cursor = T.cur().cursor || 'crosshair';
    SD.on(sync);
    sync();
  };
  ui.sync = sync;
})();
