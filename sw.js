// B+W Field Guide service worker: app shell offline, area tiles and map tiles cached as you go, backend always live.
const V = 'bwfg-v1.5.0';
const SHELL = ['./', 'index.html', 'style.css?v=6', 'app.js?v=10', 'data.enc', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png', 'card-qr.png',
  'vendor/leaflet.css', 'vendor/leaflet.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => ![V, 'tiles', 'areas'].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const put = (name, req, res) => { if (res && (res.ok || res.type === 'opaque')) { const cl = res.clone(); caches.open(name).then(c => c.put(req, cl)); } return res; };
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('script.google.com') || u.hostname.endsWith('googleusercontent.com')) return;
  if (u.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.match(e.request, { ignoreVary: true }).then(hit => hit || fetch(e.request).then(r => put('tiles', e.request, r))));
    return;
  }
  if (u.pathname.includes('/tiles/')) {   // encrypted area tiles: versioned by ?v=build date
    e.respondWith(caches.open('areas').then(async c => { const hit = await c.match(e.request); if (hit) return hit;
      const r = await fetch(e.request); if (r.ok) { c.put(e.request, r.clone()); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  if (u.pathname.endsWith('data.enc') || u.pathname.endsWith('/') || u.pathname.endsWith('index.html')) {
    e.respondWith(fetch(e.request).then(r => put(V, e.request, r)).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => put(V, e.request, r))));
});

// Buzz: show every push (iOS revokes permission for pushes that show nothing), badge the icon, tap opens Today.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Field Guide', body: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Field Guide', { body: d.body || '', tag: d.tag || 'lead', icon: 'icon-192.png', badge: 'icon-192.png', data: { url: d.url || './' } }),
    (self.navigator && self.navigator.setAppBadge && d.badge) ? self.navigator.setAppBadge(d.badge).catch(() => { }) : Promise.resolve()
  ]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => 'focus' in x); if (c) { c.postMessage({ goto: 'today' }); return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
