/* B+W Field Guide — app.js (v1.1, Nov 2026)
   data.enc = encrypted index (borrowers, walks, config, tile list). tiles/<x>_<y>.enc = encrypted 0.5° tiles
   (lens, corridors, territory), loaded around wherever you are, so coverage can grow to any city without app changes.
   Storefronts come from the backend in 0.02° tiles (OSM via BigQuery) and are cached on the device.
   Captures and plans live in BigQuery via the Apps Script backend; captures wait in IndexedDB until sent. */
'use strict';
const APP_VERSION = '1.3.0';
const TZ = 'America/New_York';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }, del(k) { try { localStorage.removeItem(k); } catch (e) { } } };

const S = {
  ref: null, key: null, cfg: {}, token: null, pos: null, where: null, plan: null, caps: [], outbox: [], map: null, layers: {},
  online: navigator.onLine, backend: null, tilesLoaded: new Set(), tilesLoading: new Map(), ids: new Set(),
  pois: new Map(), poiTiles: new Set(), poiLoading: new Map()
};

const TAG_COLORS = {
  'No car, far from a full-size grocer': '#B91C1C', 'Food-desert maps disagree': '#7C3AED', 'High food-license turnover': '#0E7490',
  'Zero to some (new business types)': '#15803D', 'Fast population change': '#D4A017', 'Fast income change': '#BE185D'
};
const WALK_COLORS = { A: '#E8590C', B: '#C2255C', C: '#7048E8', D: '#0B7285', E: '#2B8A3E', F: '#5C3B1E' };
const CARRY = ['Business cards', 'Leave-behinds (general)', 'Leave-behinds (Philly)', 'NFC tap card', 'Phone charged', 'Pen'];
const POI_DEG = 0.02;

// ---------------- crypto ----------------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64d = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256hex(s) { const h = await crypto.subtle.digest('SHA-256', enc.encode(s)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function fetchJson(url) {
  let r = null;
  try { r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); }
  catch (e) { r = await caches.match(url.split('?')[0], { ignoreSearch: true }); if (!r) throw e; }
  return r.json();
}
async function openBox(j) { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(j.iv) }, S.key, b64d(j.ct)))); }
async function unlockWithPass(pass) {
  const j = await fetchJson('data.enc?v=' + APP_VERSION);
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  S.key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(j.salt), iterations: j.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  const data = await openBox(j);
  return { data, keyRaw: await crypto.subtle.exportKey('raw', S.key) };
}
async function unlockWithKey(raw) {
  const j = await fetchJson('data.enc?v=' + APP_VERSION);
  S.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return openBox(j);
}

// ---------------- IndexedDB ----------------
const idb = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('bwfg', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('outbox', { keyPath: 'id' }); d.createObjectStore('kv'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out ? out.result : undefined); t.onerror = () => rej(t.error); });
  }
  return {
    put: (store, val, key) => tx(store, 'readwrite', s => s.put(val, key)),
    del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
    get: (store, key) => tx(store, 'readonly', s => s.get(key)),
    all: (store) => tx(store, 'readonly', s => s.getAll()),
  };
})();

// ---------------- backend ----------------
async function api(action, data, timeoutMs = 25000) {
  if (!S.cfg.url) throw new Error('no_backend');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(S.cfg.url, { method: 'POST', body: JSON.stringify({ token: S.token, action, data }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl.signal, redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'backend_error');
    return j;
  } finally { clearTimeout(t); }
}

// ---------------- geometry ----------------
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inGeom(lon, lat, g) {
  if (!g || g.t !== 'P') return false;
  for (const poly of g.c) { if (inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h))) return true; }
  return false;
}
function bboxOf(g) {
  if (g._bb) return g._bb;
  let a = 180, b = 90, c = -180, d = -90;
  const pts = g.t === 'P' ? g.c.flatMap(p => p[0]) : g.c;
  for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return (g._bb = [a, b, c, d]);
}
const inBox = (lon, lat, bb) => lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3];
function meters(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtDist = (m) => m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1609.34).toFixed(1) + ' mi';

// ---------------- reference tiles ----------------
function tileKeysAround(lat, lon, padDeg = 0.06) {
  const T = S.ref.tile_deg || 0.5, keys = new Set();
  for (const dx of [-padDeg, 0, padDeg]) for (const dy of [-padDeg, 0, padDeg]) keys.add(Math.floor((lon + dx) / T) + '_' + Math.floor((lat + dy) / T));
  return [...keys].filter(k => S.ref.tileSet.has(k));
}
function tileKeysInBox(w, s, e, n) {
  const T = S.ref.tile_deg || 0.5, keys = [];
  for (let x = Math.floor(w / T); x <= Math.floor(e / T); x++) for (let y = Math.floor(s / T); y <= Math.floor(n / T); y++) keys.push(x + '_' + y);
  return keys.filter(k => S.ref.tileSet.has(k));
}
async function loadTile(k) {
  if (S.tilesLoaded.has(k)) return;
  if (S.tilesLoading.has(k)) return S.tilesLoading.get(k);
  const p = (async () => {
    const j = await fetchJson('tiles/' + k + '.enc?v=' + S.ref.built);
    const t = await openBox(j);
    const added = { lens: [], cor: [], terr: [] };
    for (const kind of ['lens', 'cor', 'terr']) for (const it of t[kind] || []) {
      if (S.ids.has(it.id)) continue; S.ids.add(it.id); S.ref[kind].push(it); added[kind].push(it);
    }
    S.tilesLoaded.add(k);
    addRefToMap(added);
  })().finally(() => S.tilesLoading.delete(k));
  S.tilesLoading.set(k, p);
  return p;
}
async function ensureTilesAt(lat, lon) {
  const keys = tileKeysAround(lat, lon).filter(k => !S.tilesLoaded.has(k));
  if (!keys.length) return false;
  await Promise.all(keys.map(k => loadTile(k).catch(e => console.warn('tile', k, e))));
  return true;
}

// ---------------- storefronts (OSM via backend) ----------------
const poiKey = (x, y) => x + '_' + y;
function poiTilesAround(lat, lon, r = 1) {
  const x0 = Math.floor(lon / POI_DEG), y0 = Math.floor(lat / POI_DEG), out = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push([x0 + dx, y0 + dy]);
  return out;
}
function addPois(list) {
  const fresh = [];
  for (const a of list) {
    const id = 'osm:' + a[0]; if (S.pois.has(id)) continue;
    const p = { id, lat: a[1], lon: a[2], name: a[3], cat: a[4] || '', addr: a[5], city: a[6], web: a[7], hours: a[8] };
    S.pois.set(id, p); fresh.push(p);
  }
  if (fresh.length) addPoisToMap(fresh);
}
async function loadPoiTile(x, y, { force = false } = {}) {
  const k = poiKey(x, y);
  if (S.poiTiles.has(k) && !force) return;
  if (S.poiLoading.has(k)) return S.poiLoading.get(k);
  const p = (async () => {
    const cached = await idb.get('kv', 'poi:' + k).catch(() => null);
    if (cached && !force) { addPois(cached.pois); S.poiTiles.add(k); if (Date.now() - cached.t < 30 * 864e5 || !S.online) return; }
    if (!S.cfg.url || !S.online) return;
    const r = await api('pois', { x, y }, 30000);
    await idb.put('kv', { t: Date.now(), pois: r.pois }, 'poi:' + k);
    addPois(r.pois); S.poiTiles.add(k);
  })().catch(e => console.warn('poi', k, e)).finally(() => S.poiLoading.delete(k));
  S.poiLoading.set(k, p);
  return p;
}
async function ensurePoisAt(lat, lon) {
  await Promise.all(poiTilesAround(lat, lon).map(([x, y]) => loadPoiTile(x, y)));
}
const CAT = (c) => {
  const [k, v] = String(c || '').split(':'); if (!v) return k || '';
  const map = { fast_food: 'fast food', ice_cream: 'ice cream', hairdresser: 'hair salon', beauty: 'beauty', car_repair: 'auto repair', convenience: 'corner store', supermarket: 'supermarket', fitness_centre: 'gym', place_of_worship: 'place of worship', doctors: 'doctor', dry_cleaning: 'dry cleaner', laundry: 'laundromat' };
  return (map[v] || v.replace(/_/g, ' '));
};

// ---------------- locate ----------------
function locate(lat, lon) {
  const R = S.ref, w = { lat, lon };
  w.lens = R.lens.find(t => inBox(lon, lat, bboxOf(t.g)) && inGeom(lon, lat, t.g)) || null;
  w.cor = R.cor.find(c => inBox(lon, lat, bboxOf(c.g)) && inGeom(lon, lat, c.g)) || null;
  w.terr = R.terr.find(t => t.zone !== 'Pass-through' && inBox(lon, lat, bboxOf(t.g)) && inGeom(lon, lat, t.g))
    || R.terr.find(t => inBox(lon, lat, bboxOf(t.g)) && inGeom(lon, lat, t.g)) || null;
  w.near = R.biz.map(b => ({ b, d: meters(lat, lon, b.lat, b.lon) })).sort((a, b) => a.d - b.d).slice(0, 5);
  w.shops = [...S.pois.values()].map(p => ({ p, d: meters(lat, lon, p.lat, p.lon) })).filter(x => x.d < 250).sort((a, b) => a.d - b.d).slice(0, 8);
  w.area = w.cor ? w.cor.name : (w.lens ? w.lens.place : (w.terr ? w.terr.area_name : 'Outside the mapped territory'));
  w.market = w.terr ? w.terr.market : (w.lens ? w.lens.market : '');
  return w;
}
function relocate() { if (S.pos) { S.where = locate(S.pos.lat, S.pos.lon); renderWhere(); } }

// ---------------- GPS ----------------
let watchId = null, lastFetch = null;
function startGps() {
  if (!('geolocation' in navigator)) { setChip('gpsChip', 'No GPS', 'bad'); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(async p => {
    const prev = S.pos;
    S.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
    setChip('gpsChip', '±' + Math.round(p.coords.accuracy) + ' m', p.coords.accuracy < 60 ? 'ok' : 'warn');
    if (!prev || meters(prev.lat, prev.lon, S.pos.lat, S.pos.lon) > 20 || !S.where) { relocate(); updateMeOnMap(); }
    if (!lastFetch || meters(lastFetch.lat, lastFetch.lon, S.pos.lat, S.pos.lon) > 300) {
      lastFetch = { lat: S.pos.lat, lon: S.pos.lon };
      const got = await ensureTilesAt(S.pos.lat, S.pos.lon); if (got) relocate();
      await ensurePoisAt(S.pos.lat, S.pos.lon); relocate();
    }
  }, err => {
    setChip('gpsChip', err.code === 1 ? 'GPS off' : 'No fix', 'bad');
    if (!S.where) { $('#whereName').textContent = err.code === 1 ? 'Location is off' : 'Waiting for a GPS fix'; $('#whereSub').textContent = err.code === 1 ? 'Allow location for this site (Settings → Privacy → Location Services → Safari Websites), then tap ⟳.' : 'Step outside or wait a moment, then tap ⟳.'; }
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}

// ---------------- render: where ----------------
function setChip(id, text, cls) { const el = $('#' + id); el.textContent = text; el.className = 'chip' + (cls ? ' ' + cls : ''); }
function mailPill(b) {
  const cls = b.mailed === 'yes' ? 'mailed' : b.mailed === 'printed' ? 'printed' : 'no';
  const txt = b.mailed === 'yes' ? 'Mailed' : b.mailed === 'printed' ? 'Printed' : 'Not mailed';
  return `<span class="pill ${cls}">${txt}</span>`;
}
function renderWhere() {
  const w = S.where; if (!w) return;
  $('#whereName').textContent = w.area;
  const bits = [];
  if (w.terr) bits.push(w.terr.zone === 'Walk' ? 'Walk zone' : w.terr.zone === 'Drive' ? 'Drive zone' : 'Pass-through (detour only)');
  if (w.market) bits.push(w.market);
  if (w.lens && w.cor) bits.push(w.lens.place);
  $('#whereSub').textContent = bits.join(' · ');
  const look = [];
  if (w.lens) {
    for (const k of ['1', '2']) {
      const t = w.lens['t' + k]; if (!t) continue;
      look.push(`<div class="tag" style="--tagc:${TAG_COLORS[t] || 'var(--sienna)'}"><b>${esc(t)}</b><span>${esc(w.lens['p' + k])}</span><em>${esc(w.lens['n' + k])}</em></div>`);
    }
    if (w.lens.h) look.push(`<div class="tag" style="--tagc:#555"><b>Heads up</b><span>${esc(w.lens.h)}</span></div>`);
  }
  if (!look.length) look.push(`<div class="muted small">No "what to look for" signal on this block. Note what stands out anyway.</div>`);
  $('#whereLook').innerHTML = look.join('');
  $('#whereCor').innerHTML = w.cor ? `<div class="box"><b>${esc(w.cor.name)}</b>${w.cor.org ? ' · ' + esc(w.cor.org) : ''}<br>${esc(w.cor.headline)}<br><small class="muted">${esc(w.cor.wave)} · packet ${esc(w.cor.mailed || 'not mailed')}${w.cor.follow_up_due ? ' · follow-up ' + esc(w.cor.follow_up_due) : ''}</small></div>` : '';
  const near = w.near.filter(n => n.d < 3000).slice(0, 3);
  $('#whereNear').innerHTML = near.length ? `<div class="eyebrow" style="margin-top:4px">Nearest borrower businesses</div>` + near.map(n =>
    `<button data-biz="${esc(n.b.ref)}"><span><b>${esc(n.b.name)}</b><br><small>${esc(n.b.address)}, ${esc(n.b.city)} · ${fmtDist(n.d)}</small></span>${mailPill(n.b)}</button>`).join('') : '';
  $('#whereShops').innerHTML = w.shops.length ? `<div class="eyebrow" style="margin-top:8px">Storefronts right here</div>` + w.shops.map(s =>
    `<button data-poi="${esc(s.p.id)}"><span><b>${esc(s.p.name)}</b><br><small>${esc(CAT(s.p.cat))}${s.p.addr ? ' · ' + esc(s.p.addr) : ''} · ${fmtDist(s.d)}</small></span><span class="pill">${esc(CAT(s.p.cat))}</span></button>`).join('')
    : (S.cfg.url ? '' : '');
}

// ---------------- plan ----------------
function walkById(id) { return S.ref.walks.find(w => w.walk === id); }
function renderPlan() {
  const box = $('#planBox'); const p = S.plan;
  if (!p) {
    box.innerHTML = `<p class="muted">No plan for today yet. Pick a walk or drive, or ask Claude to set one up.</p><button class="btn wide" id="pickWalk2">Pick a walk</button>`;
    $('#pickWalk2').onclick = openPicker; renderCarry(); drawPlan(); return;
  }
  const w = p.walk ? walkById(p.walk) : null;
  const stops = (p.stops || []).map((s, i) => `<li><b>${esc(s.name)}</b>${s.why ? ' — ' + esc(s.why) : ''}${s.address ? `<br><small class="muted">${esc(s.address)}</small>` : ''}</li>`).join('');
  const look = (p.look_for || []).map(l => `<li>${esc(l)}</li>`).join('');
  const canPrep = w || (p.stops || []).some(s => s.lat);
  box.innerHTML = `<div class="plan">
    <h3>${esc(p.title || (w ? w.name : 'Today'))}</h3>
    ${p.question || (w && w.question) ? `<p class="q">${esc(p.question || w.question)}</p>` : ''}
    <div class="meta">${w ? `<span class="pill">${esc(w.length_mi)} mi · ~${esc(w.est_minutes)} min</span><span class="pill">${esc(w.mode)}</span>` : ''}${p.written_by ? `<span class="pill">Plan by ${esc(p.written_by)}</span>` : ''}</div>
    ${stops ? `<div class="eyebrow" style="margin-top:12px">Stops</div><ol>${stops}</ol>` : ''}
    ${look ? `<div class="eyebrow" style="margin-top:12px">Look for</div><ul>${look}</ul>` : ''}
    ${p.notes ? `<p class="small">${esc(p.notes)}</p>` : ''}
    ${canPrep ? `<div class="row" style="flex-wrap:wrap;margin-top:10px"><button class="btn" id="showWalk">Show on map</button><button class="btn" id="prepOffline">Save route for offline</button></div><p id="prepMsg" class="msg"></p>` : ''}
  </div>`;
  if (canPrep) {
    $('#showWalk').onclick = () => { switchView('map'); setTimeout(fitPlan, 150); };
    $('#prepOffline').onclick = prepOffline;
  }
  renderCarry(p.carry); drawPlan();
}
function renderCarry(list) {
  const items = (list && list.length ? list : CARRY);
  const key = 'carry:' + today();
  let done = {}; try { done = JSON.parse(ls.get(key) || '{}'); } catch (e) { }
  $('#carryList').innerHTML = items.map((c, i) => `<li><label><input type="checkbox" id="carry${i}" ${done[c] ? 'checked' : ''} data-c="${esc(c)}"> ${esc(c)}</label></li>`).join('');
  $$('#carryList input').forEach(cb => cb.onchange = () => { done[cb.dataset.c] = cb.checked; ls.set(key, JSON.stringify(done)); });
}
async function loadPlan() {
  const cached = ls.get('plan:' + today());
  if (cached) { try { S.plan = JSON.parse(cached); } catch (e) { } }
  renderPlan();
  try {
    const r = await api('getPlan', { date: today() });
    if (r.plan) { S.plan = Object.assign({}, r.plan, { written_by: r.written_by === 'app' ? 'you' : r.written_by }); ls.set('plan:' + today(), JSON.stringify(S.plan)); renderPlan(); }
  } catch (e) { /* offline: keep cached */ }
}
function openPicker() {
  const groups = {};
  S.ref.walks.forEach(w => (groups[w.market] = groups[w.market] || []).push(w));
  $('#pickList').innerHTML = Object.entries(groups).map(([m, ws]) => `<div class="eyebrow" style="margin-top:12px">${esc(m)}</div>` + ws.map(w =>
    `<div class="item" data-walk="${esc(w.walk)}"><span class="txt"><b>${esc(w.walk)}. ${esc(w.name)}</b><div><small>${esc(w.length_mi)} mi · ~${esc(w.est_minutes)} min · ${esc(w.mode)}</small></div><div class="small muted">${esc(w.question)}</div></span></div>`).join('')).join('')
    + `<div class="item" data-walk=""><span class="txt"><b>No set walk today</b><div><small>Just exploring. Captures still log where you are.</small></div></span></div>`;
  $$('#pickList .item').forEach(el => el.onclick = async () => {
    const w = el.dataset.walk ? walkById(el.dataset.walk) : null;
    S.plan = w ? { walk: w.walk, title: w.name, question: w.question, written_by: 'you' } : { title: 'Exploring', written_by: 'you' };
    ls.set('plan:' + today(), JSON.stringify(S.plan)); renderPlan(); closeSheets();
    api('savePlan', { date: today(), title: S.plan.title, plan: S.plan, written_by: 'app' }).catch(() => { });
  });
  $('#picker').hidden = false;
}
function planBounds() {
  const pts = [];
  const w = S.plan && S.plan.walk ? walkById(S.plan.walk) : null;
  if (w) w.g.c.forEach(([x, y]) => pts.push([y, x]));
  (S.plan && S.plan.stops || []).forEach(s => s.lat && pts.push([s.lat, s.lon]));
  return pts;
}
function fitPlan() { const pts = planBounds(); if (S.map && pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 }); }
function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function lat2tile(lat, z) { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); }
async function prepOffline() {
  const msg = $('#prepMsg'); const pts = planBounds(); if (!pts.length) return;
  let s = 90, w = 180, n = -90, e = -180;
  pts.forEach(([la, lo]) => { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); });
  s -= 0.004; n += 0.004; w -= 0.005; e += 0.005;
  msg.textContent = 'Saving the area around your route…';
  await Promise.all(tileKeysInBox(w, s, e, n).map(k => loadTile(k).catch(() => { })));
  const pk = [];
  for (let x = Math.floor(w / POI_DEG); x <= Math.floor(e / POI_DEG); x++) for (let y = Math.floor(s / POI_DEG); y <= Math.floor(n / POI_DEG); y++) pk.push([x, y]);
  await Promise.all(pk.slice(0, 16).map(([x, y]) => loadPoiTile(x, y)));
  const urls = [];
  for (const z of [14, 15, 16, 17]) for (let x = lon2tile(w, z); x <= lon2tile(e, z); x++) for (let y = lat2tile(n, z); y <= lat2tile(s, z); y++) urls.push(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
  const list = urls.slice(0, 260); let ok = 0;
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(u => fetch(u, { mode: 'no-cors' }).then(() => ok++).catch(() => { })));
    msg.textContent = `Saving map… ${ok} of ${list.length}`;
  }
  msg.textContent = `Saved: ${ok} map tiles, the area data and ${S.pois.size} storefronts. The route works without signal now.`;
}

// ---------------- captures ----------------
const cap = { kind: 'note', photo: null, audio: null, audioType: null };
function openCapture(kind, preset) {
  cap.kind = kind || 'note'; cap.photo = null; cap.audio = null;
  $('#capText').value = ''; $('#capContact').value = ''; $('#capContact').hidden = true; $('#capBizOther').value = ''; $('#capBizOther').hidden = true;
  $('#capPhotoPrev').hidden = true; $('#recPrev').hidden = true; $('#capMsg').textContent = ''; $('#capPhoto').value = '';
  $$('#sheet .chips button').forEach(b => b.classList.remove('on')); $('#fuChips [data-v=none]').classList.add('on');
  const w = S.where;
  $('#capWhere').textContent = w ? `${w.area}${S.pos ? ' · ±' + Math.round(S.pos.acc) + ' m' : ''}${S.plan && S.plan.walk ? ' · walk ' + S.plan.walk : ''}` : 'No location yet. The capture will be saved without coordinates.';
  const sel = $('#capBiz');
  const near = (w ? w.near : []).filter(n => n.d < 1500);
  const shops = w ? w.shops : [];
  let opts = `<option value="">None / not a specific business</option>`;
  if (shops.length) opts += `<optgroup label="Storefronts here">` + shops.map(s => `<option value="${esc(s.p.id)}">${esc(s.p.name)} (${fmtDist(s.d)})</option>`).join('') + `</optgroup>`;
  if (near.length) opts += `<optgroup label="Borrower businesses">` + near.map(n => `<option value="${esc(n.b.ref)}">${esc(n.b.name)} (${fmtDist(n.d)})</option>`).join('') + `</optgroup>`;
  opts += `<option value="__other">Another business (type it)</option>`;
  sel.innerHTML = opts;
  if (preset) {
    if (![...sel.options].some(o => o.value === preset)) {
      const nm = preset.startsWith('osm:') ? (S.pois.get(preset) || {}).name : (S.ref.biz.find(x => x.ref === preset) || {}).name;
      sel.insertAdjacentHTML('afterbegin', `<option value="${esc(preset)}">${esc(nm || preset)}</option>`);
    }
    sel.value = preset;
  }
  setKind(cap.kind);
  $('#sheet').hidden = false;
}
function setKind(k) {
  cap.kind = k;
  $$('#kindSeg button').forEach(b => b.classList.toggle('on', b.dataset.kind === k));
  $$('#sheet [data-for]').forEach(el => el.hidden = !el.dataset.for.split(' ').includes(k));
}
function chipVals(id) { return $$('#' + id + ' button.on').map(b => b.dataset.v); }
function bindChips() {
  $$('.sheet .chips').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (g.hasAttribute('data-single')) { $$('button', g).forEach(x => x.classList.toggle('on', x === b)); }
    else b.classList.toggle('on');
    if (g.id === 'fuChips') $('#capContact').hidden = b.dataset.v === 'none';
  }));
}
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1600, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}
const blobToB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

let rec = null, recChunks = [], recTimer = null;
async function toggleRec() {
  const btn = $('#recBtn');
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); recChunks = [];
    rec.ondataavailable = e => e.data.size && recChunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop()); clearTimeout(recTimer);
      cap.audioType = (rec.mimeType || 'audio/mp4').split(';')[0];
      cap.audio = new Blob(recChunks, { type: cap.audioType });
      const a = $('#recPrev'); a.src = URL.createObjectURL(cap.audio); a.hidden = false;
      btn.classList.remove('on'); btn.textContent = '● Record again';
    };
    rec.start(); btn.classList.add('on'); btn.textContent = '■ Stop';
    recTimer = setTimeout(() => rec.state === 'recording' && rec.stop(), 180000);
  } catch (e) { toast('Microphone not available: allow it for this site and try again.'); }
}
function resolveBiz(v, other) {
  if (v === '__other') return { ref: null, name: (other || '').trim() || null };
  if (!v) return { ref: null, name: null };
  if (v.startsWith('osm:')) { const p = S.pois.get(v); return { ref: v, name: p ? p.name : null }; }
  const b = S.ref.biz.find(x => x.ref === v); return { ref: b ? b.ref : v, name: b ? b.name : null };
}
async function saveCapture() {
  const btn = $('#capSave'); btn.disabled = true;
  try {
    const w = S.where;
    const biz = resolveBiz($('#capBiz').value, $('#capBizOther').value);
    const text = $('#capText').value.trim();
    const fu = chipVals('fuChips')[0] || 'none';
    if (cap.kind === 'photo' && !cap.photo) { $('#capMsg').textContent = 'Take or choose a photo first.'; return; }
    if (cap.kind === 'voice' && !cap.audio) { $('#capMsg').textContent = 'Record a voice note first.'; return; }
    if (cap.kind === 'note' && !text && !chipVals('sawChips').length) { $('#capMsg').textContent = 'Add a note or tap what you saw.'; return; }
    const ua = navigator.userAgent;
    const c = {
      id: crypto.randomUUID(), ts: new Date().toISOString(), local_date: today(), kind: cap.kind,
      walk: S.plan && S.plan.walk || null, market: w ? w.market : null, mode: w && w.terr ? (w.terr.zone === 'Walk' ? 'walk' : 'drive') : null,
      lat: S.pos ? +S.pos.lat.toFixed(6) : null, lon: S.pos ? +S.pos.lon.toFixed(6) : null, accuracy_m: S.pos ? Math.round(S.pos.acc) : null,
      area_name: w ? w.area : null, tract_geoid: w && w.lens ? w.lens.geoid : null, corridor_code: w && w.cor ? w.cor.code : null, zone: w && w.terr ? w.terr.zone : null,
      business_ref: biz.ref, business_name: biz.name, text: text || null, saw: chipVals('sawChips'), role: chipVals('roleChips')[0] || null, handed: chipVals('handChips'),
      followup: fu, contact: fu !== 'none' ? ($('#capContact').value.trim() || null) : null,
      device: /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : 'other'
    };
    if (cap.kind === 'photo') { c.media_type = 'image/jpeg'; c.media_b64 = await blobToB64(cap.photo); }
    if (cap.kind === 'voice') { c.media_type = cap.audioType; c.media_b64 = await blobToB64(cap.audio); }
    await idb.put('outbox', c);
    closeSheets(); toast('Saved'); await refreshOutbox(); drawCaps(); syncSoon(300);
  } catch (e) { $('#capMsg').textContent = 'Could not save: ' + e.message; }
  finally { btn.disabled = false; }
}

// ---------------- sync ----------------
let syncing = false, syncTimer = null;
function syncSoon(ms = 1000) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function refreshOutbox() { S.outbox = await idb.all('outbox'); renderSyncChip(); renderLog(); }
function renderSyncChip() {
  const n = S.outbox.length;
  if (!S.cfg.url) setChip('syncChip', 'No backend', 'bad');
  else if (n) setChip('syncChip', n + ' waiting', 'warn');
  else setChip('syncChip', S.online ? 'Synced' : 'Offline', S.online ? 'ok' : 'warn');
  $('#devInfo').textContent = `${n} capture${n === 1 ? '' : 's'} waiting on this device. ${S.pois.size} storefronts and ${S.tilesLoaded.size} area tiles saved. App ${APP_VERSION}, data built ${S.ref ? S.ref.built : '?'}.`;
}
async function sync() {
  if (syncing || !S.cfg.url) return; syncing = true;
  try {
    const items = (await idb.all('outbox')).sort((a, b) => a.ts.localeCompare(b.ts));
    for (const c of items) {
      try {
        const r = await api('saveCapture', c, 60000);
        await idb.del('outbox', c.id);
        const keep = Object.assign({}, c, { media_url: r.media_url }); delete keep.media_b64;
        S.caps = [keep].concat(S.caps.filter(x => x.id !== c.id));
      } catch (e) { if (String(e.message).includes('unauthorized')) toast('The backend rejected this device. Lock and unlock again.'); break; }
    }
    await idb.put('kv', S.caps, 'caps');
  } finally { syncing = false; await refreshOutbox(); renderFu(); }
}
async function loadCaptures() {
  try { const r = await api('listCaptures', { days: 14 }); S.caps = r.captures || []; await idb.put('kv', S.caps, 'caps'); }
  catch (e) { const c = await idb.get('kv', 'caps').catch(() => null); if (Array.isArray(c)) S.caps = c; }
  renderLog(); renderFu(); drawCaps();
}


// ---------------- command center: waiting on you, today, pulse ----------------
const PIN_MODES = ['Call', 'Text', 'Missed call'];
const MODE_TAG = { Call: 'Voicemail', Text: 'Text', 'Missed call': 'Missed call', 'Website form': 'Website form', 'Website chat': 'Website chat', 'Letter reply': 'Reply to letter', Phone: 'Phone' };
const VOICE_URL = 'https://voice.google.com/u/0/messages';
S.cmd = null;
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return Math.max(m, 1) + ' min ago';
  if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
  return Math.round(m / 1440) + ' d ago';
};
const emailIn = (s) => (String(s || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
const phoneIn = (s) => (String(s || '').match(/\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/) || [''])[0];
function waitItems() {
  if (!S.cmd || !S.cmd.waiting) return [];
  const w = S.cmd.waiting, out = [];
  (w.captures || []).forEach(c => {
    const inbound = c.kind === 'inbound';
    const body = String(c.text || '').split('\n\n').slice(1).join(' ').trim() || String(c.text || '');
    out.push({
      type: 'capture', id: c.id, ts: c.ts, mode: c.mode,
      pin: inbound && PIN_MODES.includes(c.mode), vendor: c.role === 'vendor',
      grp: !inbound ? 3 : (PIN_MODES.includes(c.mode) ? 0 : (c.role === 'vendor' ? 4 : 1)),
      tag: inbound ? (MODE_TAG[c.mode] || 'Lead') : 'Field: ' + c.followup,
      who: c.business_name || c.area_name || phoneIn(c.contact) || emailIn(c.contact) || (inbound ? 'Unknown caller' : ''),
      snip: body.slice(0, 160), email: inbound && c.role !== 'vendor' ? (emailIn(c.contact) || (c.mode === 'Call' ? emailIn(c.text) : '')) : '', phone: phoneIn(c.contact) || phoneIn(c.text)
    });
  });
  (w.pieces || []).forEach(p => out.push({
    type: 'piece', id: p.row_id, ts: p.followup_due, grp: 2, due: true,
    tag: (p.lane || 'Mail') + ' follow-up due' + (p.followup_due < today() ? ' (since ' + p.followup_due.slice(5) + ')' : ''),
    who: p.org + (p.addressed_to && !/team/i.test(p.addressed_to) ? ' · ' + p.addressed_to : ''),
    snip: [p.ref_code, p.recipient_email ? 'email: ' + p.recipient_email : '', String(p.notes || '').split('|').pop().trim()].filter(Boolean).join(' · ').slice(0, 160)
  }));
  out.sort((x, y) => x.grp - y.grp || (x.grp === 2 ? String(x.ts).localeCompare(String(y.ts)) : String(y.ts).localeCompare(String(x.ts))));
  return out;
}
function renderWaiting() {
  const items = waitItems(), el = $('#waitList');
  const live = items.filter(i => !i.vendor);
  const urgent = items.filter(i => i.pin || i.grp === 1).length;
  try { if (navigator.setAppBadge) urgent ? navigator.setAppBadge(urgent) : navigator.clearAppBadge(); } catch (e) { }
  $('#waitAsOf').textContent = S.cmd && S.cmd.at ? (S.cmd.stale ? 'as of ' : 'updated ') + new Date(S.cmd.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
  if (!S.cmd) { el.innerHTML = '<p class="muted small">Connect to load what\'s waiting.</p>'; return; }
  if (!items.length) { el.innerHTML = '<p class="muted">Nothing waiting. Go walk.</p>'; renderPulse(0); return; }
  let lastGrp = -1;
  el.innerHTML = items.map(i => {
    const sep = (i.grp >= 2 && i.grp !== lastGrp) ? `<div class="wsep">${i.grp === 2 ? 'Follow-ups due' : i.grp === 3 ? 'From the field' : 'Probably vendors'}</div>` : '';
    lastGrp = i.grp;
    const key = i.type + ':' + i.id;
    const acts = [];
    if (i.type === 'capture' && i.email) acts.push(`<button class="btn" data-book="${esc(key)}">Send booking link</button>`);
    if (i.type === 'capture' && !i.email && (i.mode === 'Text' || i.phone) && i.grp <= 1) acts.push(`<button class="btn" data-booktext="${esc(key)}">Copy link · open Voice</button>`);
    acts.push(`<button class="btn ghost" data-handled="${esc(key)}">Handled</button>`);
    return sep + `<div class="wi${i.pin ? ' pin' : ''}${i.vendor ? ' vendor' : ''}${i.due ? ' due' : ''}">
      <div class="hd"><span class="tag">${esc(i.tag)}</span><span>${i.due ? '' : esc(ago(i.ts))}</span></div>
      <div class="who">${esc(i.who)}</div>${i.snip ? `<div class="snip">${esc(i.snip)}</div>` : ''}
      <div class="acts">${acts.join('')}</div></div>`;
  }).join('');
  renderPulse(live.length);
}
function findItem(key) { return waitItems().find(i => i.type + ':' + i.id === key); }
function dropItem(it) {
  const w = S.cmd.waiting;
  if (it.type === 'piece') w.pieces = w.pieces.filter(p => p.row_id !== it.id);
  else w.captures = w.captures.filter(c => c.id !== it.id);
  idb.put('kv', S.cmd, 'cmd').catch(() => { });
  renderWaiting();
}
let armedBtn = null, armedT = null;
async function onWaitClick(e) {
  const hb = e.target.closest('[data-handled]'), bb = e.target.closest('[data-book]'), tb = e.target.closest('[data-booktext]');
  if (hb) {
    const it = findItem(hb.dataset.handled); if (!it) return;
    hb.disabled = true;
    try { await api('markHandled', { type: it.type, id: it.id }); dropItem(it); toast('Handled'); }
    catch (err) { hb.disabled = false; toast('Needs a connection.'); }
  } else if (bb) {
    const it = findItem(bb.dataset.book); if (!it) return;
    if (armedBtn !== bb) { // two taps: the second tap is your OK to send
      if (armedBtn) { armedBtn.classList.remove('armed'); armedBtn.textContent = 'Send booking link'; }
      armedBtn = bb; bb.classList.add('armed'); bb.textContent = 'Tap again: send to ' + it.email;
      clearTimeout(armedT); armedT = setTimeout(() => { bb.classList.remove('armed'); bb.textContent = 'Send booking link'; armedBtn = null; }, 6000);
      return;
    }
    armedBtn = null; clearTimeout(armedT); bb.disabled = true; bb.textContent = 'Sending…';
    try { await api('sendBookingLink', { type: it.type, id: it.id, to: it.email, first: '' }); dropItem(it); toast('Booking link sent to ' + it.email); }
    catch (err) { bb.disabled = false; bb.classList.remove('armed'); bb.textContent = 'Send booking link'; toast('Not sent: ' + err.message); }
  } else if (tb) {
    tb.disabled = true;
    try {
      const r = await api('bookingText', {});
      await navigator.clipboard.writeText(r.text);
      toast('Copied. Paste it in Voice.');
      window.open(VOICE_URL, '_blank');
    } catch (err) { toast('Couldn\'t copy: ' + err.message); }
    tb.disabled = false;
  }
}
function renderCal() {
  const el = $('#calList'), ev = (S.cmd && S.cmd.today && S.cmd.today.events) || null;
  if (!ev) { el.innerHTML = '<p class="muted small">Calendar not connected yet.</p>'; return; }
  const d = today();
  const todays = ev.filter(e => new Date(e.start).toLocaleDateString('en-CA', { timeZone: TZ }) === d || e.all_day && e.start.slice(0, 10) === d);
  const next = todays.length ? todays : ev.slice(0, 3);
  if (!next.length) { el.innerHTML = '<p class="muted small">Nothing on the calendar.</p>'; return; }
  el.innerHTML = (todays.length ? '' : '<p class="muted small">Nothing left today. Next:</p>') + next.map(e => {
    const st = new Date(e.start), mins = (st - Date.now()) / 60000;
    const t = e.all_day ? 'All day' : st.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
    const day = new Date(e.start).toLocaleDateString('en-CA', { timeZone: TZ }) === d ? '' : st.toLocaleDateString('en-US', { weekday: 'short', timeZone: TZ }) + ' ';
    return `<div class="ev${mins > 0 && mins <= 30 ? ' soon' : ''}"><div class="t">${esc(day + t)}</div><div><div>${esc(e.title)}${e.booked ? ' <span class="mk">booked call</span>' : ''}${e.deadline ? ' <span class="mk">B+W</span>' : ''}</div>${e.location ? `<div class="small muted">${esc(e.location)}</div>` : ''}</div></div>`;
  }).join('');
}
function renderPulse(waiting) {
  const p = S.cmd && S.cmd.pulse, parts = [waiting + ' waiting'];
  if (p && p.hubspot) parts.push(p.hubspot.open + (p.hubspot.open === 1 ? ' conversation open' : ' conversations open'), p.hubspot.proposals + (p.hubspot.proposals === 1 ? ' proposal out' : ' proposals out'));
  if (p && p.drafts) parts.push(p.drafts + ' drafts in Gmail');
  if (p && p.apollo_reset_days != null) parts.push('Apollo resets in ' + p.apollo_reset_days + (p.apollo_reset_days === 1 ? ' day' : ' days'));
  $('#pulseLine').textContent = parts.join(' · ');
}
let cmdLoading = false;
async function loadCommand() {
  if (cmdLoading) return; cmdLoading = true;
  try {
    const [w, t, p] = await Promise.allSettled([api('getWaiting', {}), api('getToday', {}), api('getPulse', {})]);
    if (w.status !== 'fulfilled') throw w.reason;
    S.cmd = { waiting: w.value, today: t.status === 'fulfilled' ? t.value : (S.cmd && S.cmd.today) || null, pulse: p.status === 'fulfilled' ? p.value : (S.cmd && S.cmd.pulse) || null, at: Date.now() };
    await idb.put('kv', S.cmd, 'cmd').catch(() => { });
  } catch (e) {
    const c = await idb.get('kv', 'cmd').catch(() => null);
    if (c && !S.cmd) S.cmd = c;
    if (S.cmd) S.cmd.stale = true;
  } finally { cmdLoading = false; }
  renderWaiting(); renderCal();
}

// ---------------- log, follow-ups, edit ----------------
const KIND = { note: 'Note', photo: 'Photo', voice: 'Voice', talk: 'Talked', dropoff: 'Dropped', endday: 'Day wrap', inbound: 'Inbound lead' };
function capCard(c, pending) {
  const t = new Date(c.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  const extra = [c.role, (c.saw || []).join(', '), (c.handed || []).length ? 'Handed: ' + c.handed.join(', ') : '', c.followup && c.followup !== 'none' ? 'Follow up: ' + c.followup : ''].filter(Boolean).join(' · ');
  const media = c.media_url ? `<a href="${esc(c.media_url)}" target="_blank" rel="noopener">${c.kind === 'voice' ? 'Voice note in Drive' : 'Photo in Drive'}</a>` : (pending && c.media_type ? `<span class="small muted">${c.kind === 'voice' ? 'Voice note' : 'Photo'} waiting to upload</span>` : '');
  return `<div class="cap${pending ? ' pending' : ''}"><div class="hd"><span class="kind">${KIND[c.kind] || c.kind}</span><span>${t}${pending ? ' · waiting' : ''}</span></div>
    <div><b>${esc(c.business_name || c.area_name || '')}</b>${c.business_name && c.area_name ? ` <small class="muted">· ${esc(c.area_name)}</small>` : ''}</div>
    ${c.text ? `<div>${esc(c.text)}</div>` : ''}${extra ? `<div class="small muted">${esc(extra)}</div>` : ''}${media}
    ${c.kind !== 'endday' ? `<div class="capactions"><button data-edit="${esc(c.id)}">Edit</button></div>` : ''}</div>`;
}
function renderLog() {
  if (!S.ref) return;
  const d = today();
  const mine = S.caps.filter(c => c.local_date === d && c.kind !== 'endday');
  const pend = S.outbox.filter(c => c.local_date === d);
  const all = pend.concat(mine.filter(c => !pend.some(p => p.id === c.id)));
  $('#logCount').textContent = all.length + (all.length === 1 ? ' capture' : ' captures');
  const cnt = k => all.filter(c => c.kind === k).length;
  $('#daySummary').innerHTML = [['Notes', cnt('note') + cnt('voice')], ['Photos', cnt('photo')], ['Talks', cnt('talk')], ['Follow-ups', all.filter(c => c.followup && c.followup !== 'none').length]]
    .map(([l, n]) => `<div><b>${n}</b><span>${l}</span></div>`).join('');
  const older = S.caps.filter(c => c.local_date !== d).slice(0, 40);
  $('#logList').innerHTML = (pend.map(c => capCard(c, true)).join('') + mine.filter(c => !pend.some(p => p.id === c.id)).map(c => capCard(c)).join('')
    + (older.length ? `<div class="eyebrow" style="margin-top:8px">Earlier</div>` + older.map(c => capCard(c)).join('') : ''))
    || `<p class="muted">Nothing captured yet today. Tap ＋ to log a note, photo, voice note or conversation.</p>`;
}
function renderFu() {
  const open = S.caps.filter(c => c.followup && c.followup !== 'none' && !c.followup_done);
  const b = $('#fuBadge'); b.hidden = !open.length; b.textContent = open.length;
  $('#fuList').innerHTML = open.length ? open.map(c => `<div class="cap"><div class="hd"><span class="kind">${esc(c.followup)}</span><span>${esc(c.local_date)}</span></div>
    <div><b>${esc(c.business_name || c.area_name || '')}</b></div>${c.text ? `<div>${esc(c.text)}</div>` : ''}${c.contact ? `<div class="small">Contact: ${esc(c.contact)}</div>` : ''}
    <button class="btn" data-done="${esc(c.id)}">Mark done</button></div>`).join('') : `<p class="muted">No open follow-ups.</p>`;
  $$('#fuList [data-done]').forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    try { await api('setFollowup', { id: btn.dataset.done, done: true }); const c = S.caps.find(x => x.id === btn.dataset.done); if (c) c.followup_done = true; renderFu(); toast('Marked done'); }
    catch (e) { btn.disabled = false; toast('Needs a connection to mark done.'); }
  });
}
let editing = null, delArmed = false;
function openEditor(id) {
  const pend = S.outbox.find(c => c.id === id); const c = pend || S.caps.find(x => x.id === id); if (!c) return;
  editing = { c, pending: !!pend }; delArmed = false;
  $('#edBiz').value = c.business_name || ''; $('#edText').value = c.text || ''; $('#edContact').value = c.contact || ''; $('#edMsg').textContent = '';
  $$('#edFu button').forEach(b => b.classList.toggle('on', b.dataset.v === (c.followup || 'none')));
  $('#edDelete').textContent = 'Delete this capture';
  $('#editor').hidden = false;
}
async function saveEdit() {
  const c = editing.c;
  const upd = { business_name: $('#edBiz').value.trim() || null, text: $('#edText').value.trim() || null, followup: chipVals('edFu')[0] || 'none', contact: $('#edContact').value.trim() || null };
  try {
    if (editing.pending) { Object.assign(c, upd); await idb.put('outbox', c); }
    else { await api('updateCapture', Object.assign({ id: c.id }, upd)); Object.assign(c, upd); await idb.put('kv', S.caps, 'caps'); }
    closeSheets(); toast('Updated'); await refreshOutbox(); renderFu();
  } catch (e) { $('#edMsg').textContent = 'Needs a connection to change a sent capture.'; }
}
async function deleteEdit() {
  if (!delArmed) { delArmed = true; $('#edDelete').textContent = 'Tap again to delete for good'; return; }
  const c = editing.c;
  try {
    if (editing.pending) await idb.del('outbox', c.id);
    else { await api('deleteCapture', { id: c.id }); S.caps = S.caps.filter(x => x.id !== c.id); await idb.put('kv', S.caps, 'caps'); }
    closeSheets(); toast('Deleted'); await refreshOutbox(); renderFu(); drawCaps();
  } catch (e) { $('#edMsg').textContent = 'Needs a connection to delete a sent capture.'; }
}
async function endDay() {
  const d = today(); const all = S.outbox.filter(c => c.local_date === d).concat(S.caps.filter(c => c.local_date === d && c.kind !== 'endday'));
  const areas = [...new Set(all.map(c => c.area_name).filter(Boolean))];
  const text = `Day wrap: ${all.length} captures across ${areas.length} area(s): ${areas.join('; ')}. Follow-ups flagged: ${all.filter(c => c.followup && c.followup !== 'none').length}.`;
  const c = { id: crypto.randomUUID(), ts: new Date().toISOString(), local_date: d, kind: 'endday', walk: S.plan && S.plan.walk || null, text, saw: [], handed: [], followup: 'none', device: 'app' };
  await idb.put('outbox', c); await refreshOutbox(); syncSoon(200);
  $('#endDayMsg').textContent = 'Day wrapped. Claude reads today\'s captures tomorrow morning and drafts the follow-ups.';
}

// ---------------- business and storefront sheets ----------------
function actionsHtml(lat, lon) {
  return `<div class="row" style="flex-wrap:wrap;margin-top:8px">
      <button class="btn" id="bCap">Capture here</button>
      <button class="btn" id="bApollo">Look up in Apollo</button>
      <button class="btn" id="bHub">Add to HubSpot</button>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${lat},${lon}">Apple Maps</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}">Google Maps</a>
    </div><div id="bOut" class="small" style="margin-top:10px"></div>`;
}
function wireActions(o) {
  $('#bCap').onclick = () => { closeSheets(); openCapture('note', o.ref); };
  $('#bApollo').onclick = async () => {
    const out = $('#bOut'); out.textContent = 'Looking up…';
    try {
      const r = await api('apollo', { name: o.name, city: o.city, state: o.state });
      if (!r.configured) { out.textContent = 'Apollo isn\'t connected yet (add APOLLO_KEY to the backend).'; return; }
      if (r.error) { out.textContent = 'Apollo said: ' + r.error + (r.detail ? ' — ' + r.detail : ''); return; }
      out.innerHTML = (r.orgs || []).length ? r.orgs.map(x => `<div class="cap"><b>${esc(x.name)}</b><div>${esc([x.industry, x.employees ? x.employees + ' employees' : '', x.founded ? 'founded ' + x.founded : ''].filter(Boolean).join(' · '))}</div>
        <div>${esc([x.city, x.state].filter(Boolean).join(', '))}${x.phone ? ' · ' + esc(x.phone) : ''}</div>${x.domain ? `<a target="_blank" rel="noopener" href="${/^http/.test(x.domain) ? esc(x.domain) : 'https://' + esc(x.domain)}">${esc(x.domain)}</a>` : ''}</div>`).join('') : 'No match in Apollo.';
    } catch (e) { out.textContent = 'Needs a connection: ' + e.message; }
  };
  $('#bHub').onclick = async () => {
    const out = $('#bOut'); out.textContent = 'Adding…';
    const last = S.caps.find(c => c.business_ref === o.ref);
    try {
      const r = await api('hubspot', { name: o.name, address: o.address, city: o.city, state: o.state, zip: o.zip, domain: o.domain,
        note: `Field Guide · ${today()}${o.tag ? ' · ' + o.tag : ''}${last && last.text ? '\n' + last.text : ''}` });
      out.textContent = !r.configured ? 'HubSpot isn\'t connected yet (add HUBSPOT_TOKEN to the backend).' : (r.created ? 'Added to HubSpot with a note.' : 'Already in HubSpot; note added.');
    } catch (e) { out.textContent = 'HubSpot: ' + e.message; }
  };
}
function capsFor(ref) { const m = S.caps.filter(c => c.business_ref === ref); return m.length ? `<div class="eyebrow">Your captures here</div>` + m.slice(0, 5).map(c => capCard(c)).join('') : ''; }
function openBiz(ref) {
  const b = S.ref.biz.find(x => x.ref === ref); if (!b) return;
  const d = S.pos ? fmtDist(meters(S.pos.lat, S.pos.lon, b.lat, b.lon)) + ' away · ' : '';
  $('#infoTitle').textContent = b.name;
  $('#infoBody').innerHTML = `<p>${esc(b.address)}, ${esc(b.city)} ${esc(b.state)} ${esc(b.zip)}<br><small class="muted">${d}${esc(b.ref)} · ${esc(b.batch)}</small></p>
    <p>${mailPill(b)} <span class="small">${esc(b.status)}${b.follow_up_due ? ' · follow-up due ' + esc(b.follow_up_due) : ''}</span></p>
    <p class="small">Letter greeting: <b>${esc(b.contact_name || 'To the team')}</b>${b.note ? `<br>${esc(b.note)}` : ''}</p>
    ${capsFor(ref)}${actionsHtml(b.lat, b.lon)}`;
  wireActions({ ref: b.ref, name: b.name, address: b.address, city: b.city, state: b.state, zip: b.zip, tag: `${b.ref} (${b.batch}, ${b.status})` });
  $('#info').hidden = false;
}
function openPoi(id) {
  const p = S.pois.get(id); if (!p) return;
  const d = S.pos ? fmtDist(meters(S.pos.lat, S.pos.lon, p.lat, p.lon)) + ' away' : '';
  const city = p.city || (S.where && S.where.market) || '';
  $('#infoTitle').textContent = p.name;
  $('#infoBody').innerHTML = `<p>${esc(CAT(p.cat))}${p.addr ? ' · ' + esc(p.addr) : ''}${p.city ? ', ' + esc(p.city) : ''}<br><small class="muted">${d}${d ? ' · ' : ''}OpenStreetMap listing, may be out of date</small></p>
    ${p.hours ? `<p class="small">Hours: ${esc(p.hours)}</p>` : ''}${p.web ? `<p class="small"><a target="_blank" rel="noopener" href="${esc(/^http/.test(p.web) ? p.web : 'https://' + p.web)}">${esc(p.web)}</a></p>` : ''}
    ${capsFor(id)}${actionsHtml(p.lat, p.lon)}`;
  wireActions({ ref: id, name: p.name, address: p.addr, city, state: '', domain: p.web ? p.web.replace(/^https?:\/\//, '').split('/')[0] : '', tag: CAT(p.cat) });
  $('#info').hidden = false;
}

// ---------------- map ----------------
function ll(g) { return g.t === 'P' ? g.c.map(p => p.map(r => r.map(([x, y]) => [y, x]))) : g.c.map(([x, y]) => [y, x]); }
function initMap() {
  if (S.map) { S.map.invalidateSize(); return; }
  const m = S.map = L.map('map', { zoomControl: false, preferCanvas: true });
  L.control.zoom({ position: 'bottomleft' }).addTo(m);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(m);
  const R = S.ref, Ly = S.layers;
  ['terr', 'lens', 'cor', 'walks', 'biz', 'pois', 'plan', 'caps'].forEach(k => Ly[k] = L.layerGroup());
  R.walks.forEach(w => L.polyline(ll(w.g), { color: WALK_COLORS[w.walk] || '#E8590C', weight: 6, opacity: .9 })
    .bindPopup(`<b>${esc(w.walk)}. ${esc(w.name)}</b><br>${esc(w.length_mi)} mi · ~${esc(w.est_minutes)} min<br><i>${esc(w.question)}</i>`).addTo(Ly.walks));
  R.biz.forEach(b => L.circleMarker([b.lat, b.lon], { radius: 7, color: '#fff', weight: 2, fillColor: b.mailed === 'yes' ? '#2F7D4F' : b.mailed === 'printed' ? '#B7791F' : '#888', fillOpacity: 1 })
    .on('click', () => openBiz(b.ref)).addTo(Ly.biz));
  addRefToMap({ lens: R.lens, cor: R.cor, terr: R.terr });
  addPoisToMap([...S.pois.values()]);
  ['terr', 'lens', 'cor', 'walks', 'biz', 'plan', 'caps'].forEach(k => { const cb = $(`[data-layer=${k}]`); if (cb && cb.checked) Ly[k].addTo(m); });
  $$('[data-layer]').forEach(cb => cb.onchange = () => { if (cb.dataset.layer === 'pois') return syncPoiLayer(); cb.checked ? Ly[cb.dataset.layer].addTo(m) : m.removeLayer(Ly[cb.dataset.layer]); });
  m.on('zoomend', syncPoiLayer);
  m.on('moveend', onMapMove);
  drawCaps(); drawPlan();
  if (planBounds().length) fitPlan();
  else if (S.pos) m.setView([S.pos.lat, S.pos.lon], 16);
  else m.setView([39.9526, -75.1652], 12);
  updateMeOnMap(); syncPoiLayer();
}
function addRefToMap(a) {
  if (!S.map) return; const Ly = S.layers;
  (a.terr || []).forEach(t => L.polygon(ll(t.g), { color: t.zone === 'Walk' ? '#B45309' : t.zone === 'Drive' ? '#0E7490' : '#9CA3AF', weight: 1, fillOpacity: t.zone === 'Walk' ? .14 : .05 })
    .bindPopup(`<b>${esc(t.area_name)}</b><br>${esc(t.how_to_work)}`).addTo(Ly.terr));
  (a.lens || []).forEach(t => L.polygon(ll(t.g), { color: TAG_COLORS[t.t1] || '#999', weight: .8, fillOpacity: .13 })
    .bindPopup(`<b>${esc(t.place)}</b><br><b>${esc(t.t1)}</b>: ${esc(t.p1)}${t.t2 ? `<br><b>${esc(t.t2)}</b>: ${esc(t.p2)}` : ''}`).addTo(Ly.lens));
  (a.cor || []).forEach(c => L.polygon(ll(c.g), { color: '#1E3A5F', weight: 2, fillOpacity: .04, dashArray: '4 4' })
    .bindPopup(`<b>${esc(c.name)}</b><br>${esc(c.headline)}<br><small>${esc(c.wave)} · ${esc(c.mailed)}</small>`).addTo(Ly.cor));
}
function addPoisToMap(list) {
  if (!S.map) return;
  list.forEach(p => L.circleMarker([p.lat, p.lon], { radius: 4, color: '#2A1E16', weight: 1, fillColor: '#F2EBDC', fillOpacity: 1 })
    .bindTooltip(esc(p.name), { direction: 'top' }).on('click', () => openPoi(p.id)).addTo(S.layers.pois));
}
function syncPoiLayer() {
  if (!S.map) return;
  const want = $('[data-layer=pois]').checked && S.map.getZoom() >= 16;
  const has = S.map.hasLayer(S.layers.pois);
  if (want && !has) S.layers.pois.addTo(S.map); else if (!want && has) S.map.removeLayer(S.layers.pois);
}
let moveT = null;
function onMapMove() {
  clearTimeout(moveT);
  moveT = setTimeout(async () => {
    const b = S.map.getBounds(), z = S.map.getZoom();
    if (z >= 10) { const keys = tileKeysInBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()).filter(k => !S.tilesLoaded.has(k)).slice(0, 6); keys.forEach(k => loadTile(k).catch(() => { })); }
    if (z >= 15) {
      const pk = [];
      for (let x = Math.floor(b.getWest() / POI_DEG); x <= Math.floor(b.getEast() / POI_DEG); x++) for (let y = Math.floor(b.getSouth() / POI_DEG); y <= Math.floor(b.getNorth() / POI_DEG); y++) pk.push([x, y]);
      pk.slice(0, 9).forEach(([x, y]) => loadPoiTile(x, y));
    }
  }, 600);
}
function drawPlan() {
  if (!S.map) return; const g = S.layers.plan; g.clearLayers();
  (S.plan && S.plan.stops || []).forEach((s, i) => { if (!s.lat) return;
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: `<div class="stopnum">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindPopup(`<b>${i + 1}. ${esc(s.name)}</b>${s.why ? '<br>' + esc(s.why) : ''}${s.address ? '<br><small>' + esc(s.address) + '</small>' : ''}`).addTo(g); });
}
function fitWalk(id) { const w = walkById(id); if (S.map && w) S.map.fitBounds(L.polyline(ll(w.g)).getBounds(), { padding: [40, 40] }); }
let meMarker = null, meCircle = null;
function updateMeOnMap() {
  if (!S.map || !S.pos) return;
  const p = [S.pos.lat, S.pos.lon];
  if (!meMarker) { meMarker = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(S.map); meCircle = L.circle(p, { radius: S.pos.acc, weight: 0, fillOpacity: .1 }).addTo(S.map); }
  else { meMarker.setLatLng(p); meCircle.setLatLng(p).setRadius(S.pos.acc); }
}
function drawCaps() {
  if (!S.map) return;
  const g = S.layers.caps; g.clearLayers();
  S.caps.concat(S.outbox).filter(c => c.lat && c.kind !== 'endday').forEach(c => L.circleMarker([c.lat, c.lon], { radius: 5, color: '#2A1E16', weight: 1, fillColor: '#C9B391', fillOpacity: 1 })
    .bindPopup(`<b>${KIND[c.kind] || c.kind}</b> · ${esc(c.local_date)}<br>${esc(c.business_name || c.area_name || '')}<br>${esc(c.text || '')}`).addTo(g));
}

// ---------------- search ----------------
// Local matches show instantly (borrowers, areas, storefronts already on the phone);
// then the backend searches every storefront in the territory, nearest first.
let searchTok = 0, searchTimer = null;
function search(q) {
  q = q.trim();
  const tok = ++searchTok;
  clearTimeout(searchTimer);
  if (q.length < 2) { $('#bizResults').innerHTML = ''; return; }
  renderSearch(q, tok, S.cfg.url && S.online ? 'loading' : 'offline');
  if (S.cfg.url && S.online) searchTimer = setTimeout(async () => {
    try {
      const pos = S.pos || {};
      const r = await api('searchPois', { q, lat: pos.lat ?? null, lon: pos.lon ?? null }, 20000);
      if (tok !== searchTok) return;
      addPois(r.pois || []);
      S._remoteIds = new Set((r.pois || []).map(a => 'osm:' + a[0]));
      renderSearch(q, tok, 'done');
    } catch (e) { if (tok === searchTok) renderSearch(q, tok, 'error'); }
  }, 350);
}
function renderSearch(q, tok, state) {
  if (tok !== searchTok) return;
  const ql = q.toLowerCase(), words = ql.replace(/['’]/g, '').split(/\s+/).filter(w => w.length >= 2);
  const hasAll = (s) => { s = String(s || '').toLowerCase().replace(/['’]/g, ''); return words.every(w => s.includes(w)); };
  const dist = (lat, lon) => S.pos ? meters(S.pos.lat, S.pos.lon, lat, lon) : null;
  const byDist = (a, b) => (a.d ?? 1e12) - (b.d ?? 1e12);
  const biz = S.ref.biz.filter(b => hasAll([b.name, b.address, b.city, b.ref].join(' ')))
    .map(b => ({ b, d: dist(b.lat, b.lon) })).sort(byDist).slice(0, 10);
  const remote = state === 'done' ? (S._remoteIds || new Set()) : new Set();
  const shops = [...S.pois.values()].filter(p => remote.has(p.id) || hasAll([p.name, p.addr, p.city, p.cat, CAT(p.cat)].join(' ')))
    .map(p => ({ p, d: dist(p.lat, p.lon) })).sort(byDist).slice(0, 30);
  const areas = [];
  S.ref.cor.forEach(c => hasAll(c.name + ' ' + c.org) && areas.push({ id: c.id, name: c.name, sub: c.org || 'District / corridor', g: c.g }));
  S.ref.lens.forEach(t => hasAll(t.place) && areas.push({ id: t.id, name: t.place, sub: t.t1 || 'Neighborhood', g: t.g }));
  S.ref.walks.forEach(w => hasAll(w.name) && areas.push({ id: 'walk:' + w.walk, name: w.walk + '. ' + w.name, sub: 'Walk', g: w.g }));
  const seenA = new Set();
  S._areaHits = areas.filter(a => !seenA.has(a.name) && seenA.add(a.name)).slice(0, 8);
  const dtxt = (d) => d == null ? '' : ' · ' + fmtDist(d);
  const status = state === 'loading' ? '<p class="muted small">Searching all storefronts…</p>'
    : state === 'offline' ? '<p class="muted small">Offline: showing only what\'s saved on this phone.</p>'
    : state === 'error' ? '<p class="muted small">Couldn\'t reach the full storefront list. Showing what\'s on this phone.</p>' : '';
  const html =
    (shops.length ? `<div class="eyebrow" style="margin-top:8px">Storefronts${S.pos ? ', nearest first' : ''}</div>` + shops.map(s => `<div class="item" data-poi="${esc(s.p.id)}"><span class="txt"><b>${esc(s.p.name)}</b><div><small>${esc(CAT(s.p.cat))}${s.p.addr ? ' · ' + esc(s.p.addr) : ''}${s.p.city ? ', ' + esc(s.p.city) : ''}${dtxt(s.d)}</small></div></span><span class="pill" data-mapto="${esc(s.p.id)}">Map</span></div>`).join('') : '')
    + (biz.length ? `<div class="eyebrow" style="margin-top:8px">Borrower businesses</div>` + biz.map(x => `<div class="item" data-biz="${esc(x.b.ref)}"><span class="txt"><b>${esc(x.b.name)}</b><div><small>${esc(x.b.address)}, ${esc(x.b.city)} ${esc(x.b.state)}${dtxt(x.d)}</small></div></span>${mailPill(x.b)}</div>`).join('') : '')
    + (S._areaHits.length ? `<div class="eyebrow" style="margin-top:8px">Areas</div>` + S._areaHits.map((a, i) => `<div class="item" data-area="${i}"><span class="txt"><b>${esc(a.name)}</b><div><small>${esc(a.sub)}</small></div></span><span class="pill">Map</span></div>`).join('') : '');
  $('#bizResults').innerHTML = status + (html || (state === 'loading' ? '' : '<p class="muted small">Nothing matches. Try one word from the name, or the street. For anything not listed, use ＋ and type it in.</p>'));
  $$('#bizResults [data-area]').forEach(el => el.onclick = () => {
    const a = S._areaHits[+el.dataset.area]; switchView('map');
    setTimeout(() => { const bb = bboxOf(a.g); S.map.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { padding: [30, 30], maxZoom: 16 }); }, 200);
  });
  $$('#bizResults [data-mapto]').forEach(el => el.onclick = (e) => {
    e.stopPropagation(); const p = S.pois.get(el.dataset.mapto); if (!p) return;
    switchView('map'); setTimeout(() => { S.map.setView([p.lat, p.lon], 18); }, 200);
  });
}

// ---------------- shell ----------------
function switchView(v) {
  $$('.view').forEach(el => el.hidden = el.id !== 'v-' + v);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#topTitle').textContent = { today: 'Today', map: 'Map', log: 'Log', fu: 'Follow-ups', more: 'More' }[v];
  $('#captureFab').hidden = v === 'more';
  if (v === 'map') setTimeout(initMap, 30);
  if (v === 'fu' || v === 'log') loadCaptures();
  if (v === 'today') loadCommand();
  if (v === 'more') renderSyncChip();
  ls.set('view', v);
}
function closeSheets() { $$('.sheet').forEach(s => s.hidden = true); }
let toastT; function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2600); }

async function checkBackend() {
  if (!S.cfg.url) { $('#connStatus').textContent = 'No backend set yet.'; renderSyncChip(); return; }
  try {
    const r = await api('ping', {}, 15000); S.backend = r;
    $('#connStatus').innerHTML = `Backend connected. Apollo: <b>${r.apollo ? 'on' : 'not set'}</b>. HubSpot: <b>${r.hubspot ? 'on' : 'not set'}</b>.`;
  } catch (e) { $('#connStatus').textContent = 'Backend not reachable (' + e.message + '). Captures wait on this device until it is.'; }
  renderSyncChip();
}

function bindUI() {
  $$('.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.v));
  $('#captureFab').onclick = () => openCapture('note');
  $$('[data-close]').forEach(b => b.onclick = closeSheets);
  $$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s) closeSheets(); }));
  $('#kindSeg').onclick = e => { const b = e.target.closest('button'); if (b) setKind(b.dataset.kind); };
  bindChips();
  $('#capBiz').onchange = e => { $('#capBizOther').hidden = e.target.value !== '__other'; };
  $('#capPhoto').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    cap.photo = await compressImage(f); const p = $('#capPhotoPrev'); p.src = URL.createObjectURL(cap.photo); p.hidden = false;
  };
  $('#recBtn').onclick = toggleRec;
  $('#capSave').onclick = saveCapture;
  $('#edSave').onclick = saveEdit;
  $('#edDelete').onclick = deleteEdit;
  $('#whereRefresh').onclick = () => { setChip('gpsChip', 'GPS…'); lastFetch = null; startGps(); };
  $('#pickWalkBtn').onclick = openPicker;
  $('#cardBtn').onclick = () => { $('#cardView').hidden = false; };
  $('#cardView').onclick = () => { $('#cardView').hidden = true; };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-biz]'); if (b) { closeSheets(); openBiz(b.dataset.biz); return; }
    const p = e.target.closest('[data-poi]'); if (p) { closeSheets(); openPoi(p.dataset.poi); return; }
    const ed = e.target.closest('[data-edit]'); if (ed) { closeSheets(); openEditor(ed.dataset.edit); }
  });
  $('#locateBtn').onclick = () => { if (S.pos && S.map) S.map.setView([S.pos.lat, S.pos.lon], 17); else startGps(); };
  $('#layersBtn').onclick = () => $('#layersPanel').hidden = !$('#layersPanel').hidden;
  $('#bizSearch').oninput = e => search(e.target.value);
  $('#bizSearch').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); search(e.target.value); } };
  $('#scriptUrl').value = S.cfg.url || '';
  $('#saveUrl').onclick = () => { S.cfg.url = $('#scriptUrl').value.trim(); ls.set('cfg', JSON.stringify(S.cfg)); checkBackend(); syncSoon(200); loadPlan(); };
  $('#syncNow').onclick = () => sync();
  $('#lockNow').onclick = async () => { ls.del('t'); await idb.del('kv', 'k'); location.reload(); };
  $('#endDayBtn').onclick = endDay;
  $('#waitList').addEventListener('click', onWaitClick);
  window.addEventListener('online', () => { S.online = true; renderSyncChip(); syncSoon(500); });
  window.addEventListener('offline', () => { S.online = false; renderSyncChip(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncSoon(800); loadPlan(); loadCommand(); } });
  setInterval(() => S.outbox.length && sync(), 45000);
  setInterval(() => { if (!document.hidden) loadCommand(); }, 5 * 60000);
}

async function start(index) {
  S.ref = Object.assign({ lens: [], cor: [], terr: [] }, index);
  S.ref.tileSet = new Set(index.tiles || []);
  if (index.backend_url) { S.cfg.url = index.backend_url; ls.set('cfg', JSON.stringify(S.cfg)); }
  $('#lock').hidden = true; $('#app').hidden = false;
  bindUI();
  const c = await idb.get('kv', 'caps').catch(() => null); S.caps = Array.isArray(c) ? c : [];
  await refreshOutbox();
  renderCarry();
  const cc = await idb.get('kv', 'cmd').catch(() => null); if (cc) { S.cmd = cc; S.cmd.stale = true; renderWaiting(); renderCal(); }
  startGps(); loadPlan(); checkBackend(); loadCaptures(); loadCommand(); syncSoon(1500);
  const v = ls.get('view'); switchView(v && v !== 'more' ? v : 'today');
}

async function boot() {
  try { S.cfg = JSON.parse(ls.get('cfg') || '{}'); } catch (e) { S.cfg = {}; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  const raw = await idb.get('kv', 'k').catch(() => null);
  S.token = ls.get('t');
  if (raw && S.token) {
    try { return await start(await unlockWithKey(raw)); } catch (e) { console.warn('stored key failed', e); }
  }
  $('#lock').hidden = false;
  $('#lockForm').onsubmit = async e => {
    e.preventDefault(); const pass = $('#pass').value.trim(); $('#lockMsg').textContent = 'Unlocking…';
    try {
      const { data, keyRaw } = await unlockWithPass(pass);
      S.token = await sha256hex('bwfg:' + pass);
      ls.set('t', S.token); await idb.put('kv', keyRaw, 'k');
      await start(data);
    } catch (err) { console.warn(err); $('#lockMsg').textContent = 'That passphrase didn\'t unlock the data. Check it and try again.'; }
  };
}
boot();
