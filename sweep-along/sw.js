/* studio-apps Service Worker（make_tablet.py が下の3つの値を埋めて sw.js を作る）
   - 起動はキャッシュ優先。通信は更新確認と、キャッシュに無い物の取得だけ。
   - install は必須ファイルを全部取れた時だけ成立する。1つでも欠けたら旧版を残す。
   - install が成立したら skipWaiting で即座に切り替え、activate で clients.claim する。
   - activate は自分の接頭辞のキャッシュだけ消す（同じ github.io に他のアプリがいる）。 */
const APP_ID = 'sweep-along';
const PREFIX = 'studio-apps:' + APP_ID + ':';
const CACHE = PREFIX + '2bb6b908c005';
const FILES = [
  "./",
  "_ext/000_kit/scene-export.js?v=0.7.6",
  "_ext/000_kit/studio-kit.js?v=0.7.10",
  "_ext/000_kit/studio-mobile.css?v=84a22e17",
  "_ext/000_kit/studio-mobile.js?v=e2c5d361",
  "_ext/000_kit/studio-tokens.css",
  "_ext/000_kit/studio-vault.js?v=e272fbb8",
  "_ext/000_kit/studio2.css?v=0.7.8",
  "angle-dial.js?v=0.6.0",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "index.html",
  "manifest.webmanifest",
  "sweep.js?v=0.6.0"
];

const okForCache = res => res && res.status === 200 && !res.redirected && res.type === 'basic';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await Promise.all(FILES.map(async f => {
        const url = new URL(f, self.registration.scope).href;
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!okForCache(res)) throw new Error('取得できない: ' + f + ' (' + (res && res.status) + ')');
        await cache.put(url, res);
      }));
    } catch (err) {
      await caches.delete(CACHE);   // 不完全な新版は捨てる。旧版はそのまま残る
      throw err;
    }
    // 全部そろった時だけ、待たずに新版へ切り替える（ホーム画面のアプリは閉じきられず、待つと旧版のまま残る）。
    // 開いている画面には studio-mobile.js が「新しい版があります［更新］」の帯を出す。
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith(PREFIX) && k !== CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.href.startsWith(self.registration.scope)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(req);
    if (!hit) hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await cache.match(new URL('./index.html', self.registration.scope).href);
      if (index) return index;
    }
    const res = await fetch(req);
    if (okForCache(res)) cache.put(req, res.clone());
    return res;
  })());
});
