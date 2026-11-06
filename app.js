/* B+W Field Guide — app.js (v1, Nov 2026)
   Reference data is encrypted in data.enc (AES-GCM, key from the passphrase via PBKDF2).
   Captures and plans live in BigQuery via the Apps Script backend; captures wait in IndexedDB until sent. */
'use strict';
const APP_VERSION = '1.0.0';
const TZ = 'America/New_York';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }, del(k) { try { localStorage.removeItem(k); } catch (e) { } } };

const S = { ref: null, cfg: {}, token: null, pos: null, where: null, plan: null, planWalk: null, caps: [], outbox: [], map: null, layers: {}, online: navigator.onLine, backend: null };

const TAG_COLORS = {
  'No car, far from a full-size grocer': '#B91C1C', 'Food-desert maps disagree': '#7C3AED', 'High food-license turnover': '#0E7490',
  'Zero to some (new business types)': '#15803D', 'Fast population change': '#D4A017', 'Fast income change': '#BE185D'
};
const WALK_COLORS = { A: '#E8590C', B: '#C2255C', C: '#7048E8', D: '#0B7285', E: '#2B8A3E', F: '#5C3B1E' };
const CARRY = ['Business cards', 'Leave-behinds (general)', 'Leave-behinds (Philly)', 'NFC tap card', 'Phone charged', 'Pen'];

// ---------------- crypto ----------------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64d = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256hex(s) { const h = await crypto.subtle.digest('SHA-256', enc.encode(s)); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
async function loadData(pass) {
  const r = await fetch('data.enc?v=' + APP_VERSION, { cache: 'no-cache' }).catch(() => caches.match('data.enc'));
  const j = await r.json();
  const key = await deriveKey(pass, b64d(j.salt), j.iter);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(j.iv) }, key, b64d(j.ct));
  return { data: JSON.parse(dec.decode(plain)), keyRaw: await crypto.subtle.exportKey('raw', key), meta: j };
}
async function loadDataWithKey(raw) {
  const r = await fetch('data.enc?v=' + APP_VERSION, { cache: 'no-cache' }).catch(() => caches.match('data.enc'));
  const j = await (r || await caches.match('data.enc')).json();
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(j.iv) }, key, b64d(j.ct));
  return JSON.parse(dec.decode(plain));
}

// ---------------- IndexedDB (outbox + caches) ----------------
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
    return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out ? out.result : undefined); t.onerror = () => rej(t.error); });
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
  const url = S.cfg.url;
  if (!url) throw new Error('no_backend');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ token: S.token, action, data }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl.signal, redirect: 'follow' });
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

function locate(lat, lon) {
  const R = S.ref, w = { lat, lon };
  w.lens = R.lens.find(t => inBox(lon, lat, bboxOf(t.g)) && inGeom(lon, lat, t.g)) || null;
  w.cor = R.cor.find(c => inBox(lon, lat, bboxOf(c.g)) && inGeom(lon, lat, c.g)) || null;
  w.terr = R.terr.find(t => t.zone !== 'Pass-through' && inBox(lon, lat, bboxOf(t.g)) && inGeom(lon, lat, t.g))
    || R.terr.find(t => inBox(lon, lat, bboxOf(t.g)) && inGeom(lon, lat, t.g)) || null;
  w.near = R.biz.map(b => ({ b, d: meters(lat, lon, b.lat, b.lon) })).sort((a, b) => a.d - b.d).slice(0, 5);
  w.area = w.cor ? w.cor.name : (w.lens ? w.lens.place : (w.terr ? w.terr.area_name : 'Outside the mapped territory'));
  w.market = w.terr ? w.terr.market : (w.lens ? w.lens.market : '');
  return w;
}

// ---------------- GPS ----------------
let watchId = null;
function startGps() {
  if (!('geolocation' in navigator)) { setChip('gpsChip', 'No GPS', 'bad'); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(p => {
    const prev = S.pos;
    S.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
    setChip('gpsChip', '±' + Math.round(p.coords.accuracy) + ' m', p.coords.accuracy < 60 ? 'ok' : 'warn');
    if (!prev || meters(prev.lat, prev.lon, S.pos.lat, S.pos.lon) > 20 || !S.where) {
      S.where = locate(S.pos.lat, S.pos.lon); renderWhere(); updateMeOnMap();
    }
  }, err => {
    setChip('gpsChip', err.code === 1 ? 'GPS off' : 'No fix', 'bad');
    if (!S.where) { $('#whereName').textContent = err.code === 1 ? 'Location is off' : 'Waiting for a GPS fix'; $('#whereSub').textContent = err.code === 1 ? 'Allow location for this site in Settings → Safari → Location (or the browser prompt), then tap ⟳.' : 'Step outside or wait a moment, then tap ⟳.'; }
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
}

// ---------------- plan ----------------
function walkById(id) { return S.ref.walks.find(w => w.walk === id); }
function renderPlan() {
  const box = $('#planBox'); const p = S.plan;
  if (!p) {
    box.innerHTML = `<p class="muted">No plan for today yet. Pick a walk or drive, or ask Claude to set one up for tomorrow.</p><button class="btn wide" id="pickWalk2">Pick a walk</button>`;
    $('#pickWalk2').onclick = openPicker; return;
  }
  const w = p.walk ? walkById(p.walk) : null;
  const stops = (p.stops || []).map(s => `<li><b>${esc(s.name)}</b>${s.why ? ' — ' + esc(s.why) : ''}${s.address ? `<br><small class="muted">${esc(s.address)}</small>` : ''}</li>`).join('');
  const look = (p.look_for || []).map(l => `<li>${esc(l)}</li>`).join('');
  box.innerHTML = `<div class="plan">
    <h3>${esc(p.title || (w ? w.name : 'Today'))}</h3>
    ${p.question || (w && w.question) ? `<p class="q">${esc(p.question || w.question)}</p>` : ''}
    <div class="meta">${w ? `<span class="pill">${esc(w.length_mi)} mi · ~${esc(w.est_minutes)} min</span><span class="pill">${esc(w.mode)}</span>` : ''}${p.written_by ? `<span class="pill">Plan by ${esc(p.written_by)}</span>` : ''}</div>
    ${stops ? `<div class="eyebrow" style="margin-top:12px">Stops</div><ol>${stops}</ol>` : ''}
    ${look ? `<div class="eyebrow" style="margin-top:12px">Look for</div><ul>${look}</ul>` : ''}
    ${p.notes ? `<p class="small">${esc(p.notes)}</p>` : ''}
    ${w ? `<button class="btn wide" id="showWalk">Show on map</button>` : ''}
  </div>`;
  if (w) $('#showWalk').onclick = () => { switchView('map'); setTimeout(() => fitWalk(w.walk), 150); };
  renderCarry(p.carry);
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
    if (r.plan) { S.plan = Object.assign({}, r.plan, { written_by: r.written_by }); ls.set('plan:' + today(), JSON.stringify(S.plan)); renderPlan(); }
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

// ---------------- captures ----------------
const cap = { kind: 'note', photo: null, audio: null, audioType: null };
function openCapture(kind, bizRef) {
  cap.kind = kind || 'note'; cap.photo = null; cap.audio = null;
  $('#capText').value = ''; $('#capContact').value = ''; $('#capContact').hidden = true; $('#capBizOther').value = ''; $('#capBizOther').hidden = true;
  $('#capPhotoPrev').hidden = true; $('#recPrev').hidden = true; $('#capMsg').textContent = '';
  $$('#sheet .chips button').forEach(b => b.classList.remove('on')); $('#fuChips [data-v=none]').classList.add('on');
  const w = S.where;
  $('#capWhere').textContent = w ? `${w.area}${S.pos ? ' · ±' + Math.round(S.pos.acc) + ' m' : ''}${S.plan && S.plan.walk ? ' · walk ' + S.plan.walk : ''}` : 'No location yet. The capture will be saved without coordinates.';
  const sel = $('#capBiz'); const near = (w ? w.near : []).filter(n => n.d < 1500);
  sel.innerHTML = `<option value="">None / not a specific business</option>` + near.map(n => `<option value="${esc(n.b.ref)}">${esc(n.b.name)} (${fmtDist(n.d)})</option>`).join('') + `<option value="__other">Another business (type it)</option>`;
  if (bizRef) { if (![...sel.options].some(o => o.value === bizRef)) { const b = S.ref.biz.find(x => x.ref === bizRef); sel.insertAdjacentHTML('afterbegin', `<option value="${esc(b.ref)}">${esc(b.name)}</option>`); } sel.value = bizRef; }
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
  $$('#sheet .chips').forEach(g => g.addEventListener('click', e => {
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

async function saveCapture() {
  const btn = $('#capSave'); btn.disabled = true;
  try {
    const w = S.where, sel = $('#capBiz').value;
    let bref = null, bname = null;
    if (sel === '__other') bname = $('#capBizOther').value.trim() || null;
    else if (sel) { const b = S.ref.biz.find(x => x.ref === sel); bref = b.ref; bname = b.name; }
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
      business_ref: bref, business_name: bname, text: text || null, saw: chipVals('sawChips'), role: chipVals('roleChips')[0] || null, handed: chipVals('handChips'),
      followup: fu, contact: fu !== 'none' ? ($('#capContact').value.trim() || null) : null,
      device: /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : 'other'
    };
    if (cap.kind === 'photo') { c.media_type = 'image/jpeg'; c.media_b64 = await blobToB64(cap.photo); }
    if (cap.kind === 'voice') { c.media_type = cap.audioType; c.media_b64 = await blobToB64(cap.audio); }
    await idb.put('outbox', c);
    closeSheets(); toast('Saved'); await refreshOutbox(); syncSoon(300);
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
  $('#devInfo').textContent = `${n} capture${n === 1 ? '' : 's'} waiting on this device. App ${APP_VERSION}, data built ${S.ref ? S.ref.built : '?'}.`;
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
      } catch (e) { if (String(e.message).includes('unauthorized')) toast('Backend rejected the passphrase token. Check TOKEN_HASH.'); break; }
    }
  } finally { syncing = false; await refreshOutbox(); }
}
async function loadCaptures() {
  try { const r = await api('listCaptures', { days: 14 }); S.caps = r.captures || []; await idb.put('kv', S.caps, 'caps'); }
  catch (e) { S.caps = (await idb.get('kv', 'caps')) || S.caps; }
  renderLog(); renderFu(); drawCaps();
}

// ---------------- log, follow-ups ----------------
const KIND = { note: 'Note', photo: 'Photo', voice: 'Voice', talk: 'Talked', dropoff: 'Dropped', endday: 'Day wrap' };
function capCard(c, pending) {
  const t = new Date(c.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  const extra = [c.role, (c.saw || []).join(', '), (c.handed || []).length ? 'Handed: ' + c.handed.join(', ') : '', c.followup && c.followup !== 'none' ? 'Follow up: ' + c.followup : ''].filter(Boolean).join(' · ');
  const media = c.media_url ? `<a href="${esc(c.media_url)}" target="_blank" rel="noopener">${c.kind === 'voice' ? 'Voice note in Drive' : 'Photo in Drive'}</a>` : (pending && c.media_type ? `<span class="small muted">${c.kind === 'voice' ? 'Voice note' : 'Photo'} waiting to upload</span>` : '');
  return `<div class="cap${pending ? ' pending' : ''}"><div class="hd"><span class="kind">${KIND[c.kind] || c.kind}</span><span>${t}${pending ? ' · waiting' : ''}</span></div>
    <div><b>${esc(c.business_name || c.area_name || '')}</b>${c.business_name && c.area_name ? ` <small class="muted">· ${esc(c.area_name)}</small>` : ''}</div>
    ${c.text ? `<div>${esc(c.text)}</div>` : ''}${extra ? `<div class="small muted">${esc(extra)}</div>` : ''}${media}</div>`;
}
function renderLog() {
  if (!S.ref) return;
  const d = today();
  const mine = S.caps.filter(c => c.local_date === d && c.kind !== 'endday');
  const pend = S.outbox.filter(c => c.local_date === d);
  const all = pend.concat(mine);
  $('#logCount').textContent = all.length + (all.length === 1 ? ' capture' : ' captures');
  const cnt = k => all.filter(c => c.kind === k).length;
  $('#daySummary').innerHTML = [['Notes', cnt('note') + cnt('voice')], ['Photos', cnt('photo')], ['Talks', cnt('talk')], ['Follow-ups', all.filter(c => c.followup && c.followup !== 'none').length]]
    .map(([l, n]) => `<div><b>${n}</b><span>${l}</span></div>`).join('');
  const older = S.caps.filter(c => c.local_date !== d).slice(0, 40);
  $('#logList').innerHTML = pend.map(c => capCard(c, true)).join('') + mine.map(c => capCard(c)).join('')
    + (older.length ? `<div class="eyebrow" style="margin-top:8px">Earlier</div>` + older.map(c => capCard(c)).join('') : '')
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
async function endDay() {
  const d = today(); const all = S.outbox.filter(c => c.local_date === d).concat(S.caps.filter(c => c.local_date === d && c.kind !== 'endday'));
  const areas = [...new Set(all.map(c => c.area_name).filter(Boolean))];
  const text = `Day wrap: ${all.length} captures across ${areas.length} area(s): ${areas.join('; ')}. Follow-ups flagged: ${all.filter(c => c.followup && c.followup !== 'none').length}.`;
  const c = { id: crypto.randomUUID(), ts: new Date().toISOString(), local_date: d, kind: 'endday', walk: S.plan && S.plan.walk || null, text, saw: [], handed: [], followup: 'none', device: 'app' };
  await idb.put('outbox', c); await refreshOutbox(); syncSoon(200);
  $('#endDayMsg').textContent = 'Day wrapped. Claude will read today\'s captures and draft follow-ups next time you check in.';
}

// ---------------- business info ----------------
function openBiz(ref) {
  const b = S.ref.biz.find(x => x.ref === ref); if (!b) return;
  const d = S.pos ? fmtDist(meters(S.pos.lat, S.pos.lon, b.lat, b.lon)) + ' away · ' : '';
  const mine = S.caps.filter(c => c.business_ref === ref);
  $('#infoTitle').textContent = b.name;
  $('#infoBody').innerHTML = `<p>${esc(b.address)}, ${esc(b.city)} ${esc(b.state)} ${esc(b.zip)}<br><small class="muted">${d}${esc(b.ref)} · ${esc(b.batch)}</small></p>
    <p>${mailPill(b)} <span class="small">${esc(b.status)}${b.follow_up_due ? ' · follow-up due ' + esc(b.follow_up_due) : ''}</span></p>
    <p class="small">Letter greeting: <b>${esc(b.contact_name || 'To the team')}</b>${b.note ? `<br>${esc(b.note)}` : ''}</p>
    ${mine.length ? `<div class="eyebrow">Your captures here</div>` + mine.slice(0, 5).map(c => capCard(c)).join('') : ''}
    <div class="row" style="flex-wrap:wrap;margin-top:8px">
      <button class="btn" id="bCap">Capture here</button>
      <button class="btn" id="bApollo">Look up in Apollo</button>
      <button class="btn" id="bHub">Add to HubSpot</button>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${b.lat},${b.lon}">Apple Maps</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lon}">Google Maps</a>
    </div><div id="bOut" class="small" style="margin-top:10px"></div>`;
  $('#bCap').onclick = () => { closeSheets(); openCapture('note', ref); };
  $('#bApollo').onclick = async () => {
    const out = $('#bOut'); out.textContent = 'Looking up…';
    try {
      const r = await api('apollo', { name: b.name, city: b.city, state: b.state });
      if (!r.configured) { out.textContent = 'Apollo isn\'t connected yet (add APOLLO_KEY to the backend).'; return; }
      if (r.error) { out.textContent = 'Apollo said: ' + r.error + (r.detail ? ' — ' + r.detail : ''); return; }
      out.innerHTML = (r.orgs || []).length ? r.orgs.map(o => `<div class="cap"><b>${esc(o.name)}</b><div>${esc([o.industry, o.employees ? o.employees + ' employees' : '', o.founded ? 'founded ' + o.founded : ''].filter(Boolean).join(' · '))}</div>
        <div>${esc([o.city, o.state].filter(Boolean).join(', '))}${o.phone ? ' · ' + esc(o.phone) : ''}</div>${o.domain ? `<a target="_blank" rel="noopener" href="${/^http/.test(o.domain) ? esc(o.domain) : 'https://' + esc(o.domain)}">${esc(o.domain)}</a>` : ''}</div>`).join('') : 'No match in Apollo.';
    } catch (e) { out.textContent = 'Needs a connection: ' + e.message; }
  };
  $('#bHub').onclick = async () => {
    const out = $('#bOut'); out.textContent = 'Adding…';
    const last = mine[0];
    try {
      const r = await api('hubspot', { name: b.name, address: b.address, city: b.city, state: b.state, zip: b.zip,
        note: `Field Guide · ${today()} · ${b.ref} (${b.batch}, ${b.status})${last && last.text ? '\n' + last.text : ''}` });
      out.textContent = !r.configured ? 'HubSpot isn\'t connected yet (add HUBSPOT_TOKEN to the backend).' : (r.created ? 'Added to HubSpot with a note.' : 'Already in HubSpot; note added.');
    } catch (e) { out.textContent = 'HubSpot: ' + e.message; }
  };
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
  Ly.terr = L.layerGroup(R.terr.map(t => L.polygon(ll(t.g), { color: t.zone === 'Walk' ? '#B45309' : t.zone === 'Drive' ? '#0E7490' : '#9CA3AF', weight: 1, fillOpacity: t.zone === 'Walk' ? .18 : .06 })
    .bindPopup(`<b>${esc(t.area_name)}</b><br>${esc(t.how_to_work)}`)));
  Ly.lens = L.layerGroup(R.lens.map(t => L.polygon(ll(t.g), { color: TAG_COLORS[t.t1] || '#999', weight: .8, fillOpacity: .13 })
    .bindPopup(`<b>${esc(t.place)}</b><br><b>${esc(t.t1)}</b>: ${esc(t.p1)}${t.t2 ? `<br><b>${esc(t.t2)}</b>: ${esc(t.p2)}` : ''}`)));
  Ly.cor = L.layerGroup(R.cor.map(c => L.polygon(ll(c.g), { color: '#1E3A5F', weight: 2, fillOpacity: .05, dashArray: '4 4' })
    .bindPopup(`<b>${esc(c.name)}</b><br>${esc(c.headline)}<br><small>${esc(c.wave)} · ${esc(c.mailed)}</small>`)));
  Ly.walks = L.layerGroup(R.walks.map(w => L.polyline(ll(w.g), { color: WALK_COLORS[w.walk] || '#E8590C', weight: 6, opacity: .9 })
    .bindPopup(`<b>${esc(w.walk)}. ${esc(w.name)}</b><br>${esc(w.length_mi)} mi · ~${esc(w.est_minutes)} min<br><i>${esc(w.question)}</i>`)));
  Ly.biz = L.layerGroup(R.biz.map(b => L.circleMarker([b.lat, b.lon], { radius: 7, color: '#fff', weight: 2, fillColor: b.mailed === 'yes' ? '#2F7D4F' : b.mailed === 'printed' ? '#B7791F' : '#888', fillOpacity: 1 })
    .on('click', () => openBiz(b.ref))));
  Ly.caps = L.layerGroup();
  ['terr', 'lens', 'cor', 'walks', 'biz', 'caps'].forEach(k => { const cb = $(`[data-layer=${k}]`); if (cb.checked) Ly[k].addTo(m); });
  $$('[data-layer]').forEach(cb => cb.onchange = () => cb.checked ? Ly[cb.dataset.layer].addTo(m) : m.removeLayer(Ly[cb.dataset.layer]));
  drawCaps();
  if (S.plan && S.plan.walk) fitWalk(S.plan.walk);
  else if (S.pos) m.setView([S.pos.lat, S.pos.lon], 16);
  else m.setView([39.9526, -75.1652], 12);
  updateMeOnMap();
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
function bizSearch(q) {
  q = q.trim().toLowerCase();
  const res = q.length < 2 ? [] : S.ref.biz.filter(b => (b.name + ' ' + b.address + ' ' + b.city + ' ' + b.ref).toLowerCase().includes(q)).slice(0, 25);
  $('#bizResults').innerHTML = res.map(b => `<div class="item" data-biz="${esc(b.ref)}"><span class="txt"><b>${esc(b.name)}</b><div><small>${esc(b.address)}, ${esc(b.city)} ${esc(b.state)}</small></div></span>${mailPill(b)}</div>`).join('')
    || (q.length >= 2 ? '<p class="muted small">No match in the borrower list. For any other business, use ＋ and type its name.</p>' : '');
}

// ---------------- shell ----------------
function switchView(v) {
  $$('.view').forEach(el => el.hidden = el.id !== 'v-' + v);
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#topTitle').textContent = { today: 'Today', map: 'Map', log: 'Log', fu: 'Follow-ups', more: 'More' }[v];
  $('#captureFab').hidden = v === 'more';
  if (v === 'map') setTimeout(initMap, 30);
  if (v === 'fu' || v === 'log') loadCaptures();
  ls.set('view', v);
}
function closeSheets() { $$('.sheet').forEach(s => s.hidden = true); }
let toastT; function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2600); }

async function checkBackend() {
  if (!S.cfg.url) { $('#connStatus').textContent = 'No backend set yet. Paste the Apps Script web app URL below.'; renderSyncChip(); return; }
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
  $('#whereRefresh').onclick = () => { setChip('gpsChip', 'GPS…'); startGps(); };
  $('#pickWalkBtn').onclick = openPicker;
  document.addEventListener('click', e => { const b = e.target.closest('[data-biz]'); if (b) { closeSheets(); openBiz(b.dataset.biz); } });
  $('#locateBtn').onclick = () => { if (S.pos && S.map) S.map.setView([S.pos.lat, S.pos.lon], 17); else startGps(); };
  $('#layersBtn').onclick = () => $('#layersPanel').hidden = !$('#layersPanel').hidden;
  $('#bizSearch').oninput = e => bizSearch(e.target.value);
  $('#scriptUrl').value = S.cfg.url || '';
  $('#saveUrl').onclick = () => { S.cfg.url = $('#scriptUrl').value.trim(); ls.set('cfg', JSON.stringify(S.cfg)); checkBackend(); syncSoon(200); loadPlan(); };
  $('#syncNow').onclick = () => sync();
  $('#lockNow').onclick = async () => { ls.del('k'); ls.del('t'); await idb.del('kv', 'k'); location.reload(); };
  $('#endDayBtn').onclick = endDay;
  window.addEventListener('online', () => { S.online = true; renderSyncChip(); syncSoon(500); });
  window.addEventListener('offline', () => { S.online = false; renderSyncChip(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncSoon(800); loadPlan(); } });
  setInterval(() => S.outbox.length && sync(), 45000);
}

async function start(data) {
  S.ref = data;
  if (data.backend_url && !S.cfg.url) { S.cfg.url = data.backend_url; ls.set('cfg', JSON.stringify(S.cfg)); }
  $('#lock').hidden = true; $('#app').hidden = false;
  bindUI();
  S.caps = (await idb.get('kv', 'caps').catch(() => null)) || [];
  if (!Array.isArray(S.caps)) S.caps = [];
  await refreshOutbox();
  renderCarry();
  startGps(); loadPlan(); checkBackend(); loadCaptures(); syncSoon(1500);
  const v = ls.get('view'); switchView(v && v !== 'more' ? v : 'today');
}

async function boot() {
  try { S.cfg = JSON.parse(ls.get('cfg') || '{}'); } catch (e) { S.cfg = {}; }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  const raw = await idb.get('kv', 'k').catch(() => null);
  S.token = ls.get('t');
  if (raw && S.token) {
    try { return await start(await loadDataWithKey(raw)); } catch (e) { console.warn('stored key failed', e); }
  }
  $('#lock').hidden = false;
  $('#lockForm').onsubmit = async e => {
    e.preventDefault(); const pass = $('#pass').value.trim(); $('#lockMsg').textContent = 'Unlocking…';
    try {
      const { data, keyRaw } = await loadData(pass);
      S.token = await sha256hex('bwfg:' + pass);
      ls.set('t', S.token); await idb.put('kv', keyRaw, 'k');
      await start(data);
    } catch (err) { $('#lockMsg').textContent = 'That passphrase didn\'t unlock the data. Check it and try again.'; }
  };
}
boot();
