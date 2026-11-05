/* doc.js — 状態（群・展開の設定・図形）と、取り消し・自動保存・読み込み。
   画面の更新は SD.on('change') で受ける（view.js / ui.js）。 */
(function () {
  'use strict';
  var SD = window.SD = window.SD || {};
  var STORE_KEY = 'symmetry-draw:v1';
  var NAVY = '#0044CC';
  SD.NAVY = NAVY;
  SD.TOOL_VERSION = '0.1.0';
  SD.GAP = [48, 300];
  SD.SIZE = [8, 400];   // 大きさ = モチーフ1つの実寸（版面の px）
  /* 展開の倍率（モチーフ座標 → セル）: 実寸 ÷ 間隔 */
  SD.scaleOf = function (params) { return Math.min(4, Math.max(0.05, params.size / params.gap)); };

  var listeners = [];
  SD.on = function (fn) { listeners.push(fn); };
  SD.emit = function (kind) { listeners.forEach(function (fn) { fn(kind); }); };

  /* 状態。items が図形の正本。sel は選択中の id（選択は取り消しの対象にしない） */
  var S = SD.state = {
    group: 'p4m',
    params: { gap: 120, size: 78, rows: true },
    items: [],
    nextId: 1,
    sel: [],        // 選択中の図形の id
    selPts: [],     // ダイレクト選択で選んだ点 [{id, idx, part:'a'|'in'|'out'}]
    active: 0       // 選択の枠・点を出すコピーの番号
  };
  /* 次に描く物の見た目と、表示の設定（自動保存する。doc には入れない） */
  SD.prefs = { fill: 'none', stroke: NAVY, bg: '#FFFFFF', sw: 8, opacity: 1, sides: 6, guides: false, snap: true };

  function r3(v) { return Math.round(v * 1000) / 1000; }
  function num(v, lo, hi, def) { v = +v; return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
  function color(v, def) { return typeof v === 'string' && /^(none|#[0-9a-fA-F]{6})$/.test(v) ? v : def; }
  function pt(p) {
    if (p == null) return null;
    if (!Array.isArray(p) || p.length < 2 || !isFinite(+p[0]) || !isFinite(+p[1])) throw new Error('ハンドルの座標が数ではありません');
    return [r3(+p[0]), r3(+p[1])];
  }
  function cleanItem(raw) {
    if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length < 2) throw new Error('アンカーが2つ未満の図形があります');
    var nodes = raw.nodes.map(function (n) {
      if (!n || !isFinite(+n.x) || !isFinite(+n.y)) throw new Error('アンカーの座標が数ではありません');
      return { x: r3(+n.x), y: r3(+n.y), in: pt(n.in), out: pt(n.out) };
    });
    var it = {
      id: Math.floor(num(raw.id, 1, 1e9, 0)) || 0,
      closed: !!raw.closed,
      nodes: nodes,
      fill: color(raw.fill, 'none'),
      stroke: color(raw.stroke, NAVY),
      sw: num(raw.sw, 0.1, 200, 8),
      opacity: num(raw.opacity, 0, 1, 1)
    };
    if (it.fill === 'none' && it.stroke === 'none') it.stroke = NAVY;   // 見えない図形は作らない
    return it;
  }
  /* 外から来たデータを検査して、取り込める形にする（失敗したら現在の状態は触らない） */
  SD.sanitize = function (raw) {
    if (!raw || typeof raw !== 'object') throw new Error('データの形が違います');
    var name = raw.spec && raw.spec.name;
    if (!SD.groups.byName[name]) throw new Error('対称の種類「' + name + '」は使えません');
    if (!Array.isArray(raw.items)) throw new Error('図形の一覧がありません');
    var p = raw.params || {};
    var items = raw.items.map(cleanItem), used = {}, maxId = 0;
    items.forEach(function (it) { if (it.id && !used[it.id]) { used[it.id] = true; maxId = Math.max(maxId, it.id); } else it.id = 0; });
    items.forEach(function (it) { if (!it.id) it.id = ++maxId; });
    return {
      group: name,
      params: { gap: num(p.gap, SD.GAP[0], SD.GAP[1], 120), size: num(p.size, SD.SIZE[0], SD.SIZE[1], 78), rows: p.rows !== false },
      items: items
    };
  };

  SD.doc = function () {
    var g = SD.groups.byName[S.group];
    return JSON.parse(JSON.stringify({
      v: 1, spec: { kind: g.kind, name: S.group },
      params: S.params, items: S.items
    }));
  };
  function snap() { return { group: S.group, params: S.params, items: S.items }; }

  /* ---- 取り消し ---- */
  var hist = Studio.history(300), timer = null;
  function apply(s) {
    S.group = s.group;
    S.params = JSON.parse(JSON.stringify(s.params));
    S.items = JSON.parse(JSON.stringify(s.items));
    S.nextId = Math.max(S.nextId, S.items.reduce(function (m, it) { return Math.max(m, it.id); }, 0) + 1);
    S.sel = S.sel.filter(function (id) { return S.items.some(function (it) { return it.id === id; }); });
    S.selPts = [];
    persist(); SD.emit('change'); SD.emit('sel');
  }
  /* 変更を確定して取り消しに積む */
  SD.commit = function () {
    clearTimeout(timer); timer = null;
    hist.push(snap()); persist(); SD.emit('change');
  };
  /* スライダーなど連続する変更: 画面は即更新し、取り消しには0.3秒おいて1回だけ積む */
  SD.commitSoon = function () {
    persist(); SD.emit('change');
    clearTimeout(timer); timer = setTimeout(function () { timer = null; hist.push(snap()); }, 300);
  };
  function flush() { if (timer) { clearTimeout(timer); timer = null; hist.push(snap()); } }
  SD.undo = function () {
    if (SD.tools && SD.tools.undoStep && SD.tools.undoStep()) return;   // 描きかけのペンは1点ずつ戻す
    flush(); var s = hist.undo(); if (s) apply(s);
  };
  SD.redo = function () { flush(); var s = hist.redo(); if (s) apply(s); };

  /* ---- 編集の入口 ---- */
  SD.addItem = function (part) {
    var it = cleanItem(Object.assign({}, part, { id: S.nextId }));
    it.id = S.nextId++;
    S.items.push(it);
    return it;
  };
  SD.removeIds = function (ids) {
    S.items = S.items.filter(function (it) { return ids.indexOf(it.id) < 0; });
    S.sel = S.sel.filter(function (id) { return ids.indexOf(id) < 0; });
    S.selPts = [];
  };
  SD.setGroup = function (name) {
    if (!SD.groups.byName[name]) return false;
    if (S.group !== name) { S.group = name; SD.commit(); }
    return true;
  };
  SD.clearAll = function () { S.items = []; S.sel = []; S.selPts = []; SD.commit(); SD.emit('sel'); };
  /* データを読み込む（取り消しに積む）。失敗したら例外を投げて何も変えない */
  SD.load = function (raw) {
    var c = SD.sanitize(raw);
    S.group = c.group; S.params = c.params; S.items = c.items;
    S.nextId = Math.max(S.nextId, c.items.reduce(function (m, it) { return Math.max(m, it.id); }, 0) + 1);
    S.sel = []; S.selPts = [];
    SD.commit(); SD.emit('sel');
  };

  /* ---- 初回の形（INIT-01）: 版面の中央に大きく、規定パレットの青 #0044CC ---- */
  function initialDoc() {
    return {
      v: 1, spec: { kind: 'wallpaper', name: 'p4m' }, params: { gap: 120, size: 78, rows: true },
      items: [{
        id: 1, closed: true, fill: NAVY, stroke: 'none', sw: 8, opacity: 1,
        nodes: [{ x: 60, y: 60, in: null, out: null }, { x: 60, y: 220, in: null, out: null }, { x: 220, y: 220, in: null, out: null }]
      }]
    };
  }

  /* ---- 自動保存（localStorage）と復元 ---- */
  var saveT = null;
  function saveNow() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ doc: SD.doc(), prefs: SD.prefs })); } catch (e) { /* 保存できなくても描ける */ }
  }
  function persist() { clearTimeout(saveT); saveT = setTimeout(saveNow, 250); }
  SD.persist = persist;
  window.addEventListener('pagehide', saveNow);

  SD.init = function () {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
    var c = null;
    if (saved && saved.doc) { try { c = SD.sanitize(saved.doc); } catch (e) { c = null; } }
    if (!c) c = SD.sanitize(initialDoc());
    if (saved && saved.prefs) {
      var p = saved.prefs;
      SD.prefs.fill = color(p.fill, SD.prefs.fill); SD.prefs.stroke = color(p.stroke, SD.prefs.stroke);
      SD.prefs.bg = color(p.bg, SD.prefs.bg);
      SD.prefs.sw = num(p.sw, 0.5, 60, 8); SD.prefs.opacity = num(p.opacity, 0.05, 1, 1);
      SD.prefs.sides = Math.round(num(p.sides, 3, 24, 6)); SD.prefs.guides = !!p.guides; SD.prefs.snap = p.snap !== false;
    }
    S.group = c.group; S.params = c.params; S.items = c.items;
    S.nextId = c.items.reduce(function (m, it) { return Math.max(m, it.id); }, 0) + 1;
    hist.push(snap());
  };
})();
