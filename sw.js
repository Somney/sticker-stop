// Service worker: makes Sticker Stop installable and usable offline.
// App files: served from cache, refreshed in the background (stale-while-revalidate).
// AI model + MediaPipe runtime: cached on first use so AI cutouts also work offline later.

const VERSION = 'sticker-stop-v2';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/export.js',
  'js/keyer.js',
  'js/layout.js',
  'js/mask.js',
  'js/processor.js',
  'js/segmenter.js',
  'js/sticker.js',
  'js/store.js',
  'js/vendor/jszip.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];
const RUNTIME = 'sticker-stop-runtime-v1';
const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit || (req.mode === 'navigate' ? cache.match('index.html') : Response.error()));
      return hit || net;
    }),
  );
});
