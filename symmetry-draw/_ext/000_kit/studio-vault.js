/* Studio vault: スマホの書き出しを GitHub 非公開リポへ自動保存する（待ち行列つき）。
   kit の書き出しは a.download + blob: href + a.click() に揃っているので、click を包んで中身を横取りする。 */
(function () {
  'use strict';
  if (!matchMedia('(max-width:700px)').matches && !/(?:^|[?&])m=1(?:&|$)/.test(location.search)) return;
  var DEFAULT_REPO = 'shungo3215-svg/studio-vault';
  var TOKEN_KEY = 'studio-mobile.ghtoken';
  var REPO_KEY = 'studio-vault.repo';
  var LIMIT = 20 * 1024 * 1024; // spec §4 ★仮
  var count = 0, listeners = [], busy = false, warned = false, modal = null, backdrop = null;
  var memQ = [];   // IndexedDB に入れられない環境（一部の WebKit 等）では、この画面を開いている間だけメモリに待たせる

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function repo() { return ls(REPO_KEY) || DEFAULT_REPO; }

  /* ---------- IndexedDB ---------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (ok, ng) {
      var r = indexedDB.open('studio-vault', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('queue', { autoIncrement: true }); };
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { ng(r.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ng) {
        var t = d.transaction('queue', mode), res = fn(t.objectStore('queue'));
        t.oncomplete = function () { ok(res && res.result); };
        t.onerror = t.onabort = function () { ng(t.error); };
      });
    });
  }
  function put(item) {
    return tx('readwrite', function (s) { return s.add(item); }).then(function () { return true; }, function () { memQ.push(item); return false; });
  }
  function del(key) {
    if (key && key.mem) { var i = memQ.indexOf(key.item); if (i >= 0) memQ.splice(i, 1); return Promise.resolve(); }
    return tx('readwrite', function (s) { return s.delete(key); });
  }
  function first() {
    return db().then(function (d) {
      return new Promise(function (ok, ng) {
        var r = d.transaction('queue', 'readonly').objectStore('queue').openCursor();
        r.onsuccess = function () { var c = r.result; ok(c ? { key: c.key, item: c.value } : null); };
        r.onerror = function () { ng(r.error); };
      });
    }).catch(function () { return null; }).then(function (e) { return e || (memQ.length ? { key: { mem: true, item: memQ[0] }, item: memQ[0] } : null); });
  }
  function refresh() {
    return tx('readonly', function (s) { return s.count(); }).then(function (n) {
      count = (n || 0) + memQ.length; emit();
    }, function () { count = memQ.length; emit(); });
  }
  function emit() { listeners.forEach(function (fn) { try { fn(count, !!ls(TOKEN_KEY)); } catch (e) {} }); }

  /* ---------- 表示 ---------- */
  // action = { label, run }: 通知にボタンを添える（保存直後の「配色を検討」）
  function actionButton(action) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'sv-act'; b.textContent = action.label;
    b.addEventListener('click', action.run); return b;
  }
  function notify(msg, error, action) {
    var S = window.Studio;
    if (S && typeof S.toast === 'function') {
      S.toast(msg, error ? { kind: 'error' } : (action ? { sticky: true } : undefined));
      var t = action && document.getElementById('toast');
      if (t) t.appendChild(actionButton(action));
      return;
    }
    var n = document.querySelector('.sv-toast');
    if (!n) { n = document.createElement('div'); n.className = 'sv-toast'; n.setAttribute('role', 'status'); document.body.appendChild(n); }
    n.textContent = msg; n.classList.toggle('err', !!error); n.hidden = false;
    if (action) n.appendChild(actionButton(action));
    clearTimeout(notify._t); notify._t = setTimeout(function () { n.hidden = true; }, action ? 8000 : 2000);
  }
  // 162（配色の調整）自身では「配色を検討」を出さない
  function isSvg(type) { return /^image\/svg\+xml/.test(type || ''); }
  function selfIsPalette() { return document.documentElement.dataset.smApp === 'palette-adjust'; }
  function stashSVG(blob, name) {
    if (!isSvg(blob.type) || selfIsPalette() || blob.size > 1024 * 1024) return;
    blob.text().then(function (txt) {
      try { localStorage.setItem('studio-vault.lastSVG', txt); localStorage.setItem('studio-vault.lastName', name); } catch (e) {}
    });
  }
  function paletteAction(it) {
    if (!isSvg(it.type) || selfIsPalette() || it.size > 1024 * 1024) return null;
    return { label: '配色を検討', run: function () { location.href = '../palette-adjust/'; } };
  }
  // ⋯ の「GitHub につなぐ」から開く、画面中央の小窓（保存のたびには出さない）
  function connect() {
    if (modal) return;
    // 背面に半透明の幕を敷く（裏の版面へ触れが届かない・幕のタップで閉じる）
    backdrop = document.createElement('div'); backdrop.className = 'sv-backdrop';
    modal = document.createElement('div'); modal.className = 'sv-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'GitHub につなぐ');
    var p1 = document.createElement('p'); p1.className = 'sv-lead'; p1.textContent = 'GitHub の合言葉（トークン）を貼ってください';
    var p2 = document.createElement('p'); p2.className = 'sv-how'; p2.textContent = 'github.com → Settings → Developer settings → Fine-grained tokens。対象 studio-vault、Contents: Read and write';
    var input = document.createElement('input'); input.type = 'password'; input.className = 'sv-token';
    input.autocomplete = 'off'; input.setAttribute('aria-label', 'GitHub の合言葉（トークン）');
    var row = document.createElement('div'); row.className = 'sv-row';
    var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'sv-ok'; ok.textContent = 'つなぐ';
    var later = document.createElement('button'); later.type = 'button'; later.className = 'sv-later'; later.textContent = '閉じる';
    row.append(later, ok); modal.append(p1, p2, input, row); backdrop.appendChild(modal); document.body.appendChild(backdrop);
    function close() { if (backdrop) { backdrop.remove(); backdrop = null; modal = null; } }
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function esc(e) { if (!modal) { document.removeEventListener('keydown', esc); return; } if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(); } });
    ok.addEventListener('click', function () {
      var v = input.value.trim(); if (!v) { input.focus(); return; }
      try { localStorage.setItem(TOKEN_KEY, v); } catch (e) { notify('合言葉を端末に保存できませんでした', true); return; }
      close(); emit(); flush();
    });
    later.addEventListener('click', close);
    input.focus();
  }

  /* ---------- 送信 ---------- */
  function b64(blob) {
    return new Promise(function (ok, ng) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { ng(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function jsonBlob(o) { return new Blob([JSON.stringify(o)], { type: 'application/json' }); }
  // dir: 置き場所（書き出しは items/・操作の記録は logs/）
  function send(name, blob, token, dir) {
    return b64(blob).then(function (content) {
      return fetch('https://api.github.com/repos/' + repo() + '/contents/' + (dir || 'items') + '/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'vault: ' + name, content: content })
      });
    });
  }
  function bump(name) { var m = /^(.*?)(\.[^.]*)?$/.exec(name); return m[1] + '-2' + (m[2] || ''); }
  function flush() {
    if (busy) return Promise.resolve();
    busy = true;
    function step() {
      var token = ls(TOKEN_KEY);
      if (!token) return Promise.resolve();
      return first().then(function (e) {
        if (!e) return;
        var it = e.item, name = it.name, body = it.blob;
        if (it.size > LIMIT) {
          name = name.replace(/\.[^.]*$/, '') + '.json';
          body = jsonBlob({ name: it.name, size: it.size, type: it.type, tool: it.tool, at: it.at, skipped: 'size' });
        }
        function done() { return del(e.key).then(refresh).then(function () { notify('GitHub に保存しました', false, paletteAction(it)); return step(); }); }
        return send(name, body, token, it.dir).then(function (r) {
          if (r.status === 201 || r.status === 200) return done();
          if (r.status === 401 || r.status === 403) {
            lsDel(TOKEN_KEY); emit(); notify('GitHub の合言葉が無効です。⋯ → GitHub につなぐ で貼り直してください', true); return;
          }
          if (r.status === 422) {
            name = bump(name);
            return send(name, body, token, it.dir).then(function (r2) {
              if (r2.status === 201 || r2.status === 200) return done();
              notify('GitHub に保存できませんでした（' + r2.status + '）。送信待ちに残しています', true);
            });
          }
          notify('GitHub に保存できませんでした（' + r.status + '）。送信待ちに残しています', true);
        });
      });
    }
    return step().catch(function () {
      notify('GitHub に送れませんでした（通信エラー）。送信待ちに残しています', true);
    }).then(function () { busy = false; });
  }

  /* ---------- 横取り ---------- */
  // 書き出した 1 ファイルを行列に入れ、トークンがあれば送る（a[download] と navigator.share で共通）
  function kindOf(blob, name) {
    var t = (blob.type || '') + ' ' + name;
    if (/svg/i.test(t)) return 'SVG'; if (/png/i.test(t)) return 'PNG'; if (/mp4|video/i.test(t)) return '映像'; if (/json/i.test(t)) return 'JSON';
    return 'ファイル';
  }
  function enqueue(blob, name) {
    var t = document.querySelector('.name');
    stashSVG(blob, name);
    notify(kindOf(blob, name) + ' を書き出しました', false, null);
    return put({ name: name, type: blob.type, blob: blob, size: blob.size, tool: ((t && t.textContent) || document.title || '').trim(), at: new Date().toISOString() })
      .then(refresh).then(function () {
        if (!ls(TOKEN_KEY)) {
          // 小窓は出さない。未接続の案内は 1 回だけ、書き出しの通知のあとに出す
          if (!warned) { warned = true; setTimeout(function () { notify('GitHub には未接続です（⋯ → GitHub につなぐ）', false, null); }, 1400); }
          return;
        }
        return flush();
      }).catch(function () { notify('この端末の送信待ちに入れられませんでした', true); });
  }
  var nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var a = this, href = a.href;
    if (a.download && /^blob:/.test(href)) {
      var name = a.download;
      fetch(href).then(function (r) { return r.blob(); }).then(function (blob) { return enqueue(blob, name); })
        .catch(function () { notify('この端末の送信待ちに入れられませんでした', true); });
    }
    return nativeClick.apply(this, arguments);
  };
  // 実機の iPhone は共有シート（navigator.share）で書き出すツールがある。File が付く時だけ同じ行列に入れる。
  // 共有シートはユーザー操作の直後にしか開けないので、行列への追加は待たずに元の share を同じ呼び出しの中で呼ぶ。
  if (typeof navigator.share === 'function') {
    var nativeShare = navigator.share;
    navigator.share = function (data) {
      var files = data && data.files;
      if (files && files.length) Array.prototype.forEach.call(files, function (f) { enqueue(f, f.name); });
      return nativeShare.apply(this, arguments);
    };
  }

  // 操作の記録（studio-mobile.js の ⋯ →「操作の記録を送る」）: logs/<name> として同じ待ち行列に入れる
  function queueLog(blob, name) {
    var t = document.querySelector('.name');
    return put({ name: name, dir: 'logs', type: blob.type, blob: blob, size: blob.size, tool: ((t && t.textContent) || document.title || '').trim(), at: new Date().toISOString() })
      .then(refresh).then(function () {
        if (!ls(TOKEN_KEY)) { notify('操作の記録を送信待ちに入れました（⋯ → GitHub につなぐ と送られます）', false, null); return; }
        notify('操作の記録を GitHub へ送ります', false, null);
        return flush();
      }).catch(function () { notify('操作の記録を送信待ちに入れられませんでした', true); });
  }
  window.StudioVault = {
    queueLog: queueLog,
    onChange: function (fn) { listeners.push(fn); try { fn(count, !!ls(TOKEN_KEY)); } catch (e) {} },
    count: function () { return count; },
    connected: function () { return !!ls(TOKEN_KEY); },
    connect: connect,
    flush: flush
  };
  window.addEventListener('online', function () { flush(); });
  refresh().then(function () { if (count) flush(); });
})();
