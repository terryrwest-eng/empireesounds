// Offline shell. Job sites lose signal; the app must not.
const CACHE = 'station-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/app.js',
  'js/geo.js',
  'js/alignment.js',
  'js/parse.js',
  'js/landxml.js',
  'js/dxf.js',
  'js/map.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then(hit => {
      // Serve from cache immediately, then quietly refresh it for next time.
      const net = fetch(req).then(res => {
        if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
