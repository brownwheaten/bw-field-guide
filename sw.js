// B+W Field Guide service worker: app shell offline, map tiles cached as you go, backend always live.
const V = 'bwfg-v1.0.0';
const SHELL = ['./', 'index.html', 'style.css?v=1', 'app.js?v=1', 'data.enc', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png',
  'vendor/leaflet.css', 'vendor/leaflet.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== 'tiles').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('script.google.com') || u.hostname.endsWith('googleusercontent.com')) return;
  if (u.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open('tiles').then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (u.pathname.endsWith('data.enc') || u.pathname.endsWith('/') || u.pathname.endsWith('index.html')) {
    // network first for data and page, so updates land; cache when offline
    e.respondWith(fetch(e.request).then(r => { const cl = r.clone(); caches.open(V).then(c => c.put(e.request, cl)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const cl = r.clone(); caches.open(V).then(c => c.put(e.request, cl)); return r; })));
});
