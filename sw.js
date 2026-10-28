/* studio-apps 入口の Service Worker（make_index.py が作る）
   - 入口の 4 ファイル（FILES）だけをキャッシュする。他アプリの <id>/ 配下は扱わない。
   - activate で消すのは接頭辞 studio-apps:index: の古い版だけ。studio-apps:<id>: と symmetry-machine 等は残す。 */
const PREFIX = 'studio-apps:index:';
const CACHE = PREFIX + 'fbb8261c5c93';
const FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png"
];
const okForCache = res => res && res.status === 200 && !res.redirected && res.type === 'basic';
const own = url => FILES.some(f => new URL(f, self.registration.scope).href === url);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await Promise.all(FILES.map(async f => {
        const url = new URL(f, self.registration.scope).href;
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!okForCache(res)) throw new Error('取得できない: ' + f);
        await cache.put(url, res);
      }));
    } catch (err) {
      await caches.delete(CACHE);
      throw err;
    }
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const href = url.origin + url.pathname;
  if (!own(href)) return;      // 入口の外（各アプリ）は触らない
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(href);
    return hit || fetch(req);
  })());
});
