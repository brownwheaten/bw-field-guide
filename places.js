/* B+W Field Guide, Places tab (phase 1 v1.1; phase 2 records v1.2, Nov 2026). Loaded only when the tab opens, so nothing here can break Today, Map, Log or Follow-ups.
   Data: snapshot files (gzip JSON) exported from the warehouse by bw_out/tools/places_export (outside this public repo), kept in DW's
   Google Drive and served by the backend action placesFile to a signed-in device. Each file is saved on the device encrypted with the
   device key, so a saved area works with no signal. No figures are stored in this repository.
   Figures and verdicts come from places-core.js (the packet builder's rules, tested against the 14 built packets). */
(function () {
  'use strict';
  const C = window.BWPlacesCore;
  const RC = window.BWPlacesRecords;   // places-records.js (phase 2): Philadelphia address records
  const WK = window.BWPlacesWork;      // places-work.js (phase 2b): jobs and commuting, transit, food extras
  const PV = '1.4.0';
  let X = null;                       // context from app.js: { S, api, idb, esc, toast }
  const P = { mem: {}, tracts: {}, geo: {}, zgeo: {}, cmpCache: {}, meeting: '', expect: {}, pins: [], place: null, map: null, status: {}, busy: new Map(), radius: 805 };
  const ST_FIPS = { '09': 'CT', '10': 'DE', '24': 'MD', '25': 'MA', '34': 'NJ', '36': 'NY', '42': 'PA', '44': 'RI' };
  const HOME = ['PA', 'NJ', 'DE'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (s, el = document) => el.querySelector(s);
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };

  // ---------------------------------------------------------------- files: device first, then the backend (or a dev folder)
  const enc = new TextEncoder();
  let devKey = null;
  async function deviceKey() {
    if (devKey) return devKey;
    const raw = await X.idb.get('kv', 'k').catch(() => null);
    if (!raw) return null;
    devKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return devKey;
  }
  async function gunzipJson(bytes) {
    const ds = new DecompressionStream('gzip');
    const txt = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
    return JSON.parse(txt);
  }
  const b64ToBytes = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  // developer/test only: a URL folder holding the snapshot files. Honoured only when the app itself runs on this machine (review: no
  // production path around the backend).
  const devSrc = () => (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? ls.get('places_src') : null);
  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
  async function fetchRemote(name) {
    const src = devSrc();
    if (src) { const r = await fetch(src.replace(/\/?$/, '/') + name + '?r=' + Date.now(), { cache: 'no-store' }); /* never a cached copy: an older service worker cached this test path */ if (!r.ok) throw new Error('dev source ' + r.status); return new Uint8Array(await r.arrayBuffer()); }
    if (!X.S.cfg.url) throw new Error('no_backend');
    const r = await X.api('placesFile', { name }, 60000);
    return b64ToBytes(r.b64);
  }
  async function saveLocal(name, bytes) {
    const key = await deviceKey(); if (!key) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    await X.idb.put('kv', { t: Date.now(), iv, ct, bytes: bytes.length, v: PV, sha: await sha256(bytes) }, 'places:' + name);
    return true;
  }
  async function readLocal(name) {
    const rec = await X.idb.get('kv', 'places:' + name).catch(() => null);
    if (!rec) return null;
    // review 2a, defect 1: a meta or area file saved by an older app is never trusted while there is signal (they say which files exist)
    if (rec.v !== PV && navigator.onLine && (name === 'places_meta.json.gz' || name === 'places_areas.json.gz')) return null;
    const key = await deviceKey(); if (!key) return null;
    try {
      const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct));
      return { bytes, t: rec.t, sha: rec.sha || await sha256(bytes) };
    } catch (e) {
      // saved under an older device key (the passphrase salt changed): drop it so the file is downloaded again
      console.warn('places: saved file could not be decrypted, removing it', name, e);
      await X.idb.del('kv', 'places:' + name).catch(() => { });
      devKey = null;
      return null;
    }
  }
  /** get a snapshot file: memory, then this device, then the network (saving it for next time) */
  async function getFile(name, { refresh = false } = {}) {
    if (P.mem[name] && !refresh) return P.mem[name];
    if (P.busy.has(name)) return P.busy.get(name);
    const p = (async () => {
      let from = 'device', bytes = null, t = null, stale = false;
      if (!refresh) {
        const loc = await readLocal(name);
        if (loc) {
          bytes = loc.bytes; t = loc.t;
          // a saved copy that differs from the file Drive now holds (meta lists every file's sha256) is replaced while there is signal;
          // with no signal it is used and marked, so the card can say so
          const want = P.expect[name];
          if (want && loc.sha !== want) { if (navigator.onLine || devSrc()) bytes = null; else stale = true; }
        }
      }
      if (!bytes) {
        if (!navigator.onLine && !devSrc()) throw new Error('offline');
        bytes = await fetchRemote(name); from = 'network'; t = Date.now();
        await saveLocal(name, bytes).catch(e => console.warn('places save', e));
      }
      const data = await gunzipJson(bytes);
      const out = { data, from, t, bytes: bytes.length, stale };
      P.mem[name] = out; P.status[name] = { from, t, bytes: bytes.length, built: data.built, stale };
      return out;
    })().finally(() => P.busy.delete(name));
    P.busy.set(name, p);
    return p;
  }
  async function haveLocal(name) { return !!(await X.idb.get('kv', 'places:' + name).catch(() => null)); }
  async function tractsFor(st) {
    if (P.tracts[st]) return P.tracts[st];
    const f = await getFile(`places_tracts_${st}.json.gz`);
    const d = f.data; const idx = new Map(); d.rows.forEach(r => idx.set(r[0], r));
    const ci = {}; d.cols.forEach((c, i) => { ci[c] = i + 1; });
    return (P.tracts[st] = { cols: d.cols, ci, rows: d.rows, idx, meta: d.meta || {}, built: d.built, from: f.from, t: f.t });
  }
  async function geoFor(st) { if (P.geo[st]) return P.geo[st]; try { const f = await getFile(`places_geo_${st}.json.gz`); return (P.geo[st] = f.data.g); } catch (e) { return null; } }
  const metaFile = () => getFile('places_meta.json.gz').then(f => f.data);
  /** the file list Drive holds now: with signal the meta is fetched fresh once a session (4 KB), so every other file can be checked against it */
  async function freshMeta() {
    let m = null;
    if ((navigator.onLine || devSrc()) && !P.metaFresh) { try { m = (await getFile('places_meta.json.gz', { refresh: true })).data; P.metaFresh = true; } catch (e) { m = null; } }
    if (!m) m = await metaFile();
    P.expect = {}; for (const f of (m.files || [])) if (f.sha256) P.expect[f.file] = f.sha256;
    return m;
  }
  const areasFile = () => getFile('places_areas.json.gz').then(f => f.data.areas);
  const countiesFile = () => getFile('places_counties.json.gz').then(f => f.data.counties);

  // ---------------------------------------------------------------- geometry helpers
  const meters = (la1, lo1, la2, lo2) => { const R = 6371000, r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
  function linesOf(g) {
    if (!g) return [];
    if (g.type === 'LineString') return [g.coordinates];
    if (g.type === 'MultiLineString') return g.coordinates;
    if (g.type === 'Polygon') return g.coordinates;
    if (g.type === 'MultiPolygon') return g.coordinates.flat();
    if (g.type === 'GeometryCollection') return g.geometries.flatMap(linesOf);
    return [];
  }
  function distToGeom(lat, lon, g) {
    const k = Math.cos(lat * Math.PI / 180) * 111320, kl = 110540; let best = Infinity;
    for (const ln of linesOf(g)) for (let i = 0; i < ln.length - 1; i++) {
      const ax = (ln[i][0] - lon) * k, ay = (ln[i][1] - lat) * kl, bx = (ln[i + 1][0] - lon) * k, by = (ln[i + 1][1] - lat) * kl;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy; best = Math.min(best, Math.hypot(px, py));
    }
    return best;
  }
  function inPoly(lat, lon, g) {
    if (!g) return false;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.some(p => { let inside = false; const r = p[0]; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside; } return inside; });
  }

  // ---------------------------------------------------------------- figures for a place
  function market(t) {
    if (t.startsWith('42101')) return 'PHL';
    const st = ST_FIPS[t.slice(0, 2)];
    if (st === 'PA' || st === 'NJ') return st;
    if (st === 'MA') return ['25025', '25017'].includes(t.slice(0, 5)) ? 'MA city' : 'MA';
    return 'national';
  }
  function tractName(t, counties) {
    const c = t.slice(5); const n = parseInt(c.slice(0, 4), 10) + (c.slice(4) !== '00' ? '.' + c.slice(4) : '');
    const cty = counties && counties[t.slice(0, 5)]; return `Census Tract ${n}${cty ? ', ' + cty.name : ''}`;
  }
  async function comparatorFor(cty) {
    if (P.cmpCache[cty]) return P.cmpCache[cty];
    const st = ST_FIPS[cty.slice(0, 2)]; const T = await tractsFor(st);
    const rows = T.rows.filter(r => r[0].startsWith(cty));
    const Cm = C.aggregate(rows, T.cols); Cm._rows = rows;
    return (P.cmpCache[cty] = Cm);
  }
  function cmpWords(cty, counties) {
    if (cty === '42101') return { label: 'Philadelphia', inPhrase: 'citywide', head: 'Philadelphia (city and county)' };
    const n = (counties[cty] || {}).name || cty; return { label: n, inPhrase: `in ${n}`, head: n };
  }
  /** build a card model from a list of tract ids */
  async function fromTracts(place) {
    const counties = await countiesFile();
    const byState = {}; for (const t of place.tracts) (byState[ST_FIPS[t.slice(0, 2)]] ||= []).push(t);
    const rows = [], missing = []; let cols = null, built = null, from = 'device';
    for (const [st, ts] of Object.entries(byState)) {
      if (!st || st === 'undefined') { missing.push(...ts); continue; }
      let T; try { T = await tractsFor(st); } catch (e) { missing.push(...ts); place.loadError = e.message; continue; }
      cols = T.cols; built = T.built; if (T.from === 'network') from = 'network';
      for (const t of ts) { const r = T.idx.get(t); if (r) rows.push(r); else missing.push(t); }
    }
    if (!rows.length) return Object.assign(place, { empty: true, missing });
    const ci = (c) => cols.indexOf(c) + 1;
    const byCty = {}; for (const r of rows) byCty[r[0].slice(0, 5)] = (byCty[r[0].slice(0, 5)] || 0) + (r[ci('pop_e')] || 0);
    const cty = Object.entries(byCty).sort((a, b) => b[1] - a[1])[0][0];
    const W = C.aggregate(rows, cols); const Cm = await comparatorFor(cty); const cw = cmpWords(cty, counties);
    const cm = counties[cty] || {};
    const { figs } = C.makeFigures(W, Cm, cm.med ? { e: cm.med, m: cm.med_m } : null, cw.label);
    return Object.assign(place, { rows, cols, ci, missing, W, Cm, cty, cw, county: cm, figs, built, from, market: market(rows[0][0]), counties });
  }
  async function fromZip(z) {
    const zf = (await getFile('places_zips.json.gz')).data; const rec = zf.zips[z];
    const counties = await countiesFile();
    if (!rec) return { kind: 'zip', name: `ZIP ${z}`, empty: true, missing: [] };
    const W = { n_tracts: 0, tract_traits: [], hh18_e: null, pop18_e: null, jobs: null, med_min: null, med_max: null, med_n: 0 };
    zf.cols.forEach((c, i) => { W[c] = rec.r[i]; });
    for (const k of Object.keys(W)) if (W[k] === undefined) W[k] = null;
    W.langs = zf.cols.filter(c => c.startsWith('lang') && c.endsWith('_e')).map(c => [W[c] || 0, W[c.replace(/_e$/, '_m')] || 0]);
    W.cob = zf.cols.filter(c => c.startsWith('cob') && c.endsWith('_e')).map(c => [W[c] || 0, W[c.replace(/_e$/, '_m')] || 0]);
    const cty = rec.cty; let Cm = {}; let cw = cmpWords(cty, counties);
    try { Cm = await comparatorFor(cty); } catch (e) { cw = { label: 'its county (not saved)', inPhrase: '', head: 'County not saved on this device' }; }
    const cm = counties[cty] || {};
    const { figs } = C.makeFigures(W, Cm, cm.med ? { e: cm.med, m: cm.med_m } : null, cw.label);
    // ZIP median income is a published median (DP03), shown as is; medians are never combined
    figs.zip_median = { value: W.med, moe90: W.med_m, comparator: { area: cw.label, value: cm.med, moe90: cm.med_m } };
    // phase 2c: the decade change only where the ZIP area did not change (2010 and 2020 ZCTAs share 99%+ of their land both ways)
    let zx = null; try { zx = (await getFile('places_zipx.json.gz')).data.zips[z] || {}; } catch (e) { zx = null; }
    if (zx && zx.d18) {
      const [a, b, c, d, e2, f, g, h, i, j] = zx.d18;
      Object.assign(W, { hh18_e: a, hh18_m: b, nv18_e: c, nv18_m: d, pop18_e: e2, pop18_m: f, fb18_e: g, fb18_m: h, sn18_e: i, sn18_m: j });
      const r2 = C.makeFigures(W, Cm, cm.med ? { e: cm.med, m: cm.med_m } : null, cw.label); for (const k of Object.keys(r2.figs)) if (/_change$/.test(k)) figs[k] = r2.figs[k];
    }
    const st = rec.st; const mk = st === 'PA' ? (cty === '42101' ? 'PHL' : 'PA') : st === 'NJ' ? 'NJ' : st === 'MA' ? 'MA' : 'national';
    return { kind: 'zip', id: 'zip:' + z, zip: z, name: `ZIP ${z}`, sub: `${rec.city || ''}${rec.city ? ', ' : ''}${st || ''}`, W, Cm, cty, cw, county: cm, figs, zrec: rec, zx, zxErr: zx === null,
      built: zf.built, from: P.mem['places_zips.json.gz'].from, market: mk, counties, rows: [], missing: [] };
  }

  // ---------------------------------------------------------------- search
  async function search(q) {
    q = (q || '').trim(); const out = [];
    if (!q) return out;
    if (looksAddress(q)) out.push({ type: 'Address', label: q, sub: 'Find this address: Philadelphia from the saved property file; elsewhere through the backend (needs signal)', go: () => findAddress(q) });
    if (/^\d{5}$/.test(q)) out.push({ type: 'ZIP', label: `ZIP ${q}`, sub: 'Census ZIP area. A ZIP is not a district.', go: () => openZip(q) });
    if (/^\d{11}$/.test(q)) out.push({ type: 'Tract', label: `Tract ${q}`, sub: 'One census tract', go: () => openTracts({ kind: 'tract', id: 'tract:' + q, tracts: [q] }) });
    const ql = q.toLowerCase();
    let areas = []; try { areas = await areasFile(); } catch (e) { out.push({ type: 'Note', label: 'Areas list not saved on this device', sub: e.message === 'offline' ? 'Connect once to save it.' : e.message }); }
    const hits = areas.filter(a => (a.name + ' ' + (P.meeting ? '' : (a.org || '') + ' ' + a.id) + ' ' + (a.neighborhood || '')).toLowerCase().includes(ql))
      .sort((a, b) => ({ packet: 0, district: 1, corridor: 2 }[a.kind] - { packet: 0, district: 1, corridor: 2 }[b.kind])).slice(0, 12);
    for (const a of hits) out.push({ type: a.kind === 'packet' ? (P.meeting ? 'Corridor' : 'Packet area') : a.kind === 'district' ? 'District' : 'Corridor', label: a.name + (a.org && !P.meeting ? ' · ' + a.org : ''),
      sub: `${a.st}${a.neighborhood ? ' · ' + a.neighborhood : ''} · ${a.tracts.length} tracts`, go: () => openArea(a) });
    // Philadelphia neighborhoods and tract numbers (home pack)
    try {
      const T = P.tracts.PA || (await haveLocal('places_tracts_PA.json.gz') || navigator.onLine ? await tractsFor('PA') : null);
      if (T && q.length >= 3) {
        const nb = {}; for (const [t, m] of Object.entries(T.meta)) if (m.n && m.n.toLowerCase().includes(ql)) (nb[m.n] ||= []).push(t);
        for (const [n, ts] of Object.entries(nb).slice(0, 6)) out.push({ type: 'Neighborhood', label: n, sub: `Philadelphia · ${ts.length} tract${ts.length > 1 ? 's' : ''}`, go: () => openTracts({ kind: 'neighborhood', id: 'nb:' + n, name: n, tracts: ts }) });
      }
      const m = ql.match(/^(?:tract\s*)?(\d{1,4})(?:\.(\d{1,2}))?$/);
      if (T && m && !/^\d{5}$/.test(q)) {
        const code = m[1].padStart(4, '0') + (m[2] ? m[2].padEnd(2, '0') : '00');
        for (const t of T.rows.map(r => r[0]).filter(t => t.startsWith('42101') && t.slice(5) === code).slice(0, 3))
          out.push({ type: 'Tract', label: `Tract ${m[1]}${m[2] ? '.' + m[2] : ''}, Philadelphia`, sub: t, go: () => openTracts({ kind: 'tract', id: 'tract:' + t, tracts: [t] }) });
      }
    } catch (e) { /* PA not saved */ }
    return out;
  }

  // ---------------------------------------------------------------- open a place
  async function openArea(a) {
    const kindWord = { packet: 'Packet area', district: 'Philadelphia district', corridor: 'Corridor' }[a.kind];
    await openTracts({ kind: a.kind, id: a.id, name: a.name, sub: [kindWord, a.org, a.neighborhood].filter(Boolean).join(' · '), subMeeting: [a.kind === 'packet' ? 'Corridor' : kindWord, a.neighborhood].filter(Boolean).join(' · '), tracts: a.tracts, area: a });
  }
  async function openZip(z) { await show(() => fromZip(z)); }
  async function openTracts(pl) { await show(() => fromTracts(pl)); }
  async function show(build) {
    const root = $('#placesCard'); root.innerHTML = '<div class="card"><p class="muted">Loading figures…</p></div>';
    try {
      const pl = await build(); P.place = pl;
      await attachRecords(pl);
      await attachWork(pl);
      if (pl.kind !== 'radius') ls.set('places_last', JSON.stringify({ id: pl.id, kind: pl.kind, tracts: pl.tracts, zip: pl.zip, name: pl.name, sub: pl.sub, area: pl.area ? { id: pl.area.id } : null }));
      await render(pl);
    } catch (e) {
      console.warn(e);
      root.innerHTML = `<div class="card"><b>Couldn't open this place.</b><p class="muted small">${esc(whyFail(e))}</p></div>`;
    }
  }
  function whyFail(e) {
    const m = e && e.message || String(e);
    if (m === 'offline') return 'Not saved on this device and there is no signal. Save it from Data status when you are back on Wi-Fi.';
    if (m === 'no_backend') return 'No backend set on this device (More tab).';
    if (m === 'unknown_action') return 'The backend has not been updated for Places yet (the placesFile action). See the build notes for the one-time deploy step.';
    return m;
  }

  // ---------------------------------------------------------------- Here: snap to a district, else tracts within a radius
  async function here() {
    const pos = X.S.pos; const box = $('#placesHere');
    if (!pos) { box.innerHTML = '<p class="muted small">No GPS fix yet. Allow location and wait for the GPS chip to show a margin, then tap Here again.</p>'; return; }
    box.innerHTML = '<p class="muted small">Looking around you…</p>';
    let areas = []; try { areas = await areasFile(); } catch (e) { }
    const acc = Math.round(pos.acc || 0), age = Math.round((Date.now() - (pos.t || Date.now())) / 1000);
    const fixWords = `GPS ±${acc.toLocaleString('en-US')} m, fix ${age < 60 ? age + ' s' : Math.round(age / 60) + ' min'} ago`;
    // a snap is only offered when the fix is at least as tight as the snap distance (150 m from a line)
    const poor = !(acc > 0) || acc > SNAP_M;
    const snaps = [];
    if (!poor) for (const a of areas) {
      if (!a.c || meters(pos.lat, pos.lon, a.c[0], a.c[1]) > 8000) continue;
      if (a.boundary && inPoly(pos.lat, pos.lon, a.boundary)) snaps.push({ a, d: 0 });
      else if (a.line) { const d = distToGeom(pos.lat, pos.lon, a.line); if (d <= 150) snaps.push({ a, d }); }
    }
    snaps.sort((x, y) => x.d - y.d);
    P.fix = { lat: pos.lat, lon: pos.lon, acc, t: pos.t || Date.now() };
    const btns = snaps.slice(0, 3).map((s, i) => `<button class="btn" data-snap="${i}">${esc(s.a.name)} <small class="muted">${s.d ? Math.round(s.d) + ' m' : 'inside'}</small></button>`).join('');
    box.innerHTML = `<p class="small pl-gps ${poor ? 'warn' : ''}"><b>${esc(fixWords)}</b>${poor ? `. The fix is looser than ${SNAP_M} m, so no district is offered: you could be on the next street. Wait for the GPS chip to tighten, then tap Here again.` : ''}</p>`
      + (snaps.length ? `<div class="eyebrow">You are on</div><div class="pl-row">${btns}</div><p class="muted small">A district's figures are steadier than a circle and match its packet.</p>` : (poor ? '' : '<p class="muted small">No district or corridor line within 150 m.</p>'))
      + `<div class="eyebrow">Or the tracts around you</div><div class="pl-row">${[400, 805, 1600].map(r => `<button class="btn${r === P.radius ? ' primary' : ''}" data-rad="${r}">${{ 400: '400 m · ¼ mi', 805: '805 m · ½ mi', 1600: '1,600 m · 1 mi' }[r]}</button>`).join('')}</div>`;
    box.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => openArea(snaps[+b.dataset.snap].a));
    box.querySelectorAll('[data-rad]').forEach(b => b.onclick = () => { P.radius = +b.dataset.rad; radius(pos.lat, pos.lon, P.radius, P.fix); });
  }
  async function radius(lat, lon, r, fix) {
    const sts = new Set(Object.keys(P.tracts));
    for (const st of Object.values(ST_FIPS)) if (await haveLocal(`places_tracts_${st}.json.gz`)) sts.add(st);
    if (!sts.size && navigator.onLine) for (const s of HOME) sts.add(s);
    const ts = [];
    for (const st of sts) { let T; try { T = await tractsFor(st); } catch (e) { continue; } const la = T.ci.lat, lo = T.ci.lon;
      for (const row of T.rows) if (row[la] !== null && Math.abs(row[la] - lat) < 0.05 && meters(lat, lon, row[la], row[lo]) <= r) ts.push(row[0]); }
    const old = $('#plRadNone'); if (old) old.remove();
    if (!ts.length) {
      // never leave an older card on screen under this message: it would describe somewhere else
      $('#placesCard').innerHTML = ''; P.place = null; if (P.map) { P.map.remove(); P.map = null; }
      $('#placesHere').insertAdjacentHTML('beforeend', `<p class="muted small" id="plRadNone">No census tract has its population center within ${r} m of you, or this state is not saved on the device.</p>`); return;
    }
    const at = new Date(fix && fix.t || Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const accW = fix && fix.acc ? `, GPS ±${fix.acc.toLocaleString('en-US')} m` : '';
    const lab = fix && fix.label;
    await openTracts({ kind: 'radius', id: `here:${lat.toFixed(4)},${lon.toFixed(4)}:${r}`, name: lab ? `Around ${lab}` : 'Around here', sub: `${lab ? 'Address located' : 'Fix'} at ${at}${accW} · ${ts.length} tract${ts.length > 1 ? 's' : ''} with population center within ${r} m`, tracts: ts, radius: r, center: [lat, lon],
      wide: fix && fix.acc > r ? fix.acc : null });
  }

  // ---------------------------------------------------------------- formatting
  const pct1 = (p) => (p === null || p === undefined || Number.isNaN(p)) ? '–' : (p * 100).toFixed(1) + '%';
  const pts1 = (m) => (m === null || m === undefined) ? '' : '±' + (m * 100).toFixed(1);
  const cnt = (n) => (n === null || n === undefined) ? '–' : Math.round(n).toLocaleString('en-US');
  const cntm = (m) => (m === null || m === undefined) ? '' : '±' + Math.round(m).toLocaleString('en-US');
  const usd = (n) => (n === null || n === undefined) ? '–' : '$' + Math.round(n).toLocaleString('en-US');
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
  const SNAP_M = 150;
  const fdate = (t) => t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  function vcell(v) { return `<span class="pl-v ${v.cls}" title="${esc(v.detail || '')}"><b aria-hidden="true">${v.mark}</b> ${esc(v.word)}${v.tag && !P.meeting ? ` <em>· ${esc(v.tag)}</em>` : ''}</span>`; }
  const tagHtml = (tags) => P.meeting ? '' : tags.filter(Boolean).map(t => `<span class="pl-tag">${esc(t)}</span>`).join('');
  function say(text) { return text ? `<button class="pl-say" data-say="${esc(text)}" aria-label="Copy this sentence">${esc(text)} <span aria-hidden="true">⧉</span></button>` : ''; }
  /** a share row: figure, margin, comparator, verdict, say-line */
  function shareRow(f, pl, opts = {}) {
    if (!f) return '';
    const internal = opts.internal || (f.flags && f.flags.internal);
    if (internal && P.meeting) return '';
    if (opts.need && P.meeting === 'district') return '';     // a district meeting hides food-need rows, as a district sheet does
    const v = C.verdict(f, 'share');
    // strength tag: packet traits only, after G5, the one-use rule, the renters cap and below-the-comparator (review defect 5)
    if (internal || opts.need) delete v.tag; else v.tag = C.sheetTag(f.id || '', f, v) || undefined;
    const fig = v.cls === 'rough' ? `${pct1(v.range[0])}–${pct1(v.range[1])}` : pct1(f.value);
    const cmp = f.comparator && f.comparator.value !== null && f.comparator.value !== undefined ? `<span class="${v.cls === 'inside' ? 'pl-strike' : ''}">${pct1(f.comparator.value)} ${pts1(f.comparator.moe90)}</span>` : '<span class="muted">–</span>';
    let line = '';
    if (!internal && !opts.noSay && f.unit && v.cls === 'solid' && f.verbs) {
      line = cap('about ' + C.sharePhrase(f.value, f.unit, f.verbs)) + (pl.cw.inPhrase ? `; ${pl.cw.inPhrase} it is ${C.pct0(f.comparator.value)}%.` : '.');
    } else if (!internal && !opts.noSay && v.cls === 'inside' && f.verbs) {
      line = cap('about ' + C.sharePhrase(f.value, f.unit, f.verbs)) + `, about the same as ${pl.cw.inPhrase || 'the comparator'}.`;
    }
    const tags = [internal ? 'internal: not for a sheet' : '', opts.need ? 'need fact: statement of need only' : '', pl.rows && pl.rows.length > 1 ? concTag(f) : '', opts.tag || ''];
    return `<tr class="${internal ? 'pl-int' : ''}"><th>${esc(opts.label || f.label)}${opts.note && !P.meeting ? `<small>${esc(opts.note)}</small>` : ''}</th><td class="num">${fig}</td><td class="num muted">${v.cls === 'rough' ? '' : pts1(f.moe90)}</td>`
      + `<td class="num">${cmp}</td><td>${vcell(v)}${tagHtml(tags)}${line ? '<div>' + say(line) + '</div>' : ''}</td></tr>`;
  }
  function concTag(f) {
    const c = f.test && f.test.concentration; if (!c || c.pass) return '';
    return `concentrated: ${c.why}`;
  }
  function countRow(label, f, pl, opts = {}) {
    if (!f || f.value === null || f.value === undefined) return `<tr><th>${esc(label)}</th><td class="num muted">–</td><td></td><td></td><td class="muted small">not held</td></tr>`;
    const v = C.verdict(f, 'count');
    const money = opts.big ? (n => Math.abs(n) >= 1e7 ? C.usdBig(n) : usd(n)) : usd;   // total income prints in the spec's style ("$2.0 billion", "$570 million")
    const fig = opts.usd ? (v.cls === 'rough' ? `${money(v.range[0])}–${money(v.range[1])}` : money(f.value)) : (v.cls === 'rough' ? `${cnt(v.range[0])}–${cnt(v.range[1])}` : cnt(f.value));
    const cmp = f.comparator && f.comparator.value !== null && f.comparator.value !== undefined ? (opts.usd ? money(f.comparator.value) : cnt(f.comparator.value)) : '–';
    return `<tr><th>${esc(label)}${opts.note && !P.meeting ? `<small>${esc(opts.note)}</small>` : ''}</th><td class="num">${fig}</td><td class="num muted">${v.cls === 'rough' ? '' : (opts.usd ? (f.moe90 !== null && f.moe90 !== undefined ? '±' + money(f.moe90).slice(1) : '') : cntm(f.moe90))}</td><td class="num muted">${cmp}</td><td>${vcell(v)}${opts.say && v.cls === 'solid' ? '<div>' + say(opts.say) + '</div>' : ''}</td></tr>`;
  }
  function changeRow(label, f, pl) {
    if (!f) return '';
    let v = C.changeVerdict(f); const pct = f.test.pct, cp = f.test.cmp_pct;
    // a ZIP has no 2014-18 housing-unit count, so the household occupancy test (G2b) cannot run: a rise is never stated as firm
    if (pl.kind === 'zip' && label === 'Households' && v.word === 'measurable rise') v = { word: 'not firm: the occupancy test cannot run for a ZIP', cls: 'inside', mark: '=' };
    if (P.meeting && f.value < 0 && f.test.measurable) return '';
    // households: the packets print the smaller of the survey change and the change at the 2014-18 occupancy rate (printed_value)
    const shown = f.test.delta_occupancy_held !== undefined && f.test.printed_value !== undefined ? f.test.printed_value : f.value;
    const held = shown !== f.value ? `<small>survey change ${f.value > 0 ? '+' : ''}${cnt(f.value)}; the smaller figure, at the 2014–18 occupancy rate, is shown</small>` : '';
    const pp = held ? f.test.pct_occupancy_held : pct, cpp = held ? f.test.cmp_pct_occupancy_held : cp;
    return `<tr><th>${esc(label)}<small>2014–18 ≈ ${cnt(f.base18)}</small>${P.meeting ? '' : held}</th><td class="num">${shown > 0 ? '+' : ''}${cnt(shown)}</td><td class="num muted">${cntm(f.moe90)}</td>`
      + `<td class="num muted">${(pp * 100).toFixed(1)}% · ${esc(pl.cw.label)} ${(cpp * 100).toFixed(1)}%</td><td>${vcell(v)}</td></tr>`;
  }
  const table = (head, rows) => `<div class="pl-tw"><table class="pl-t"><thead><tr><th>${esc(head)}</th><th class="num">Figure</th><th class="num">±</th><th class="num">Comparator</th><th>Verdict · say it</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const note = (t) => P.meeting ? '' : `<p class="pl-note">${t}</p>`;
  const notHeld = (what, why) => `<div class="pl-empty"><b>${esc(what)}:</b> ${esc(P.meeting ? 'not shown for this place' : why)}</div>`;
  const sec = (id, title, body, sub) => `<section class="card pl-sec" id="pl-${id}"><div class="row between"><h3>${esc(title)}</h3>${sub ? `<span class="muted small">${esc(sub)}</span>` : ''}</div>${body}</section>`;

  // ---------------------------------------------------------------- render the card
  async function render(pl) {
    const root = $('#placesCard'); const meta = await metaFile().catch(() => null);
    if (pl.empty) { root.innerHTML = `<div class="card"><h2>${esc(pl.name || 'This place')}</h2><p class="muted">${pl.loadError ? esc(whyFail({ message: pl.loadError })) : 'No figures for this place on this device.'}</p>${pl.missing && pl.missing.length ? `<p class="muted small">Tracts not saved: ${pl.missing.map(esc).join(', ')}</p>` : ''}</div>`; return; }
    const F = pl.figs; const W = pl.W; const nT = pl.rows.length;
    const kind = pl.kind;
    const a = pl.area;
    const title = pl.name || (nT === 1 ? tractName(pl.rows[0][0], pl.counties) : 'Selected tracts');
    const M = P.meeting;
    const covers = kind === 'zip' ? `Census ZIP area ${pl.zip} (survey figures) and the postal ZIP (stores, business counts, lending). A ZIP is not a district: keep ZIP figures off the front of a sheet.`
      : kind === 'tract' ? 'One census tract of 2020. The noisiest unit: most rows read "rough", and that is correct.'
        : kind === 'radius' ? `The ${nT} census tracts of 2020 whose population center falls within ${pl.radius} m of where you are standing (the packet's walking-area rule applied to a point). Tracts are wider than the circle; this is not a count inside the circle.`
          : a ? (a.kind === 'packet' ? (M ? `The ${nT} census tracts of 2020 whose population center is within 805 m of the corridor line.` : cap(a.rule_words) + '.') : `The ${nT} ${a.rule_words}.`)
            : kind === 'neighborhood' ? `The ${nT} census tract${nT === 1 ? '' : 's'} of 2020 in the ${pl.name} neighborhood.` : `${nT} census tract${nT === 1 ? '' : 's'}.`;
    const ruleWarn = !a ? '' : a.area_district ? note('<b>Desk only: area district.</b> This district covers many streets rather than one corridor, so no corridor line is drawn and its tracts come from the older boundary rule the spec says not to print. Read it at the desk.')
      : a.rule === 'boundary_centroid_805m' ? note('<b>Older area rule.</b> This district has no corridor line yet, so its tracts come from the boundary rule the spec says not to print. Use for desk reading; draw the line before any sheet.')
        : a.desk_only ? note(`<b>Desk only: the line is not confirmed.</b> ${esc(a.published_area || '')}`) : '';
    const pkt = a && a.kind === 'packet' ? note(`Matches the packet (${esc(a.org || '')}, ${esc(a.packet_date || '')}): the release test rebuilds this packet's survey figures from these files and they agree.`) : '';
    const miss = pl.missing && pl.missing.length ? note(`<b>${pl.missing.length} tract${pl.missing.length > 1 ? 's' : ''} not on this device</b> (${pl.missing.map(esc).join(', ')}); the figures below leave ${pl.missing.length > 1 ? 'them' : 'it'} out. Save that state in Data status.`) : '';
    const wide = pl.wide ? note(`<b>GPS ±${Math.round(pl.wide).toLocaleString('en-US')} m is wider than this ${pl.radius} m circle.</b> The tracts below may not be the ones you are standing in.`) : '';
    const warn = [];
    const stu = pl.rows.filter(r => r[pl.ci('stu')] === 1).length, gq = pl.rows.filter(r => r[pl.ci('gq')] === 1).length;
    if (stu) warn.push(`${stu} student tract${stu > 1 ? 's' : ''} (a college population distorts rates)`);
    if (gq) warn.push(`${gq} tract${gq > 1 ? 's' : ''} dominated by group quarters (a dorm, prison or care home distorts rates)`);
    const cov = M ? '' : coverageStrip(meta, pl.market);
    const sub = M ? (pl.subMeeting !== undefined ? pl.subMeeting : pl.sub) : pl.sub;
    const eyebrowKind = { zip: 'ZIP', tract: 'Tract', radius: 'Around here', packet: M ? 'Corridor' : 'Packet area', district: 'District', corridor: 'Corridor', neighborhood: 'Neighborhood' }[kind] || 'Place';
    root.innerHTML = `
      <div class="card pl-head">
        <div class="eyebrow">${esc(eyebrowKind)}${M ? '' : ' · market ' + esc(pl.market)}</div>
        <h2>${esc(title)}</h2>${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}
        <p class="small">${esc(covers)}</p>
        <p class="small"><b>Compared with</b> ${esc(pl.cw.head)}${kind === 'zip' ? ' (the ZIP\'s county)' : ''}. Survey figures: ACS 2020–24, margins at 90%.</p>
        ${ruleWarn}${pkt}${miss}${wide}${warn.length ? note('<b>Heads up:</b> ' + warn.map(esc).join('; ') + '.') : ''}
        ${cov ? `<div class="pl-cov">${cov}</div>` : ''}
        ${M ? '' : `<div class="pl-meta small muted">Files built ${esc(pl.built || '')}${P.metaCache && P.metaCache.rev ? ' · revision ' + esc(P.metaCache.rev) : ''} · ${pl.from === 'device' ? 'read from this device' : 'downloaded now and saved on this device'}</div>`}
        <div class="pl-row">${pl.cty ? `<button class="btn ghost" id="plCounty">County card: ${esc(pl.cw.label.replace(/ \(not saved\)$/, ''))}</button>` : ''}${M ? '' : `<button class="btn ghost" id="plPin">${P.pins.some(x => x.id === pinKey(pl)) ? 'Pinned' : 'Pin for side by side'}</button>`}</div>
        <div id="plMap" class="pl-map" aria-label="Map of the tracts"></div>
      </div>
      ${secPeople(pl)}${secWork(pl)}${secOpen(pl)}${P.meeting === 'food' ? '' : secMoney(pl)}${P.meeting === 'district' ? '' : secFood(pl) + secHealth(pl)}
      <p class="muted small pl-foot">${M ? 'Verdicts: <b>solid</b> margin within 30% of the figure; <b>rough</b> margin over 30%; <b>inside the margin</b> no real difference from the comparator; <b>no measurable change</b> or <b>not firm</b> a decade change inside its margin. Survey figures are estimates: say "about".</p>' : `Verdicts: <b>solid</b> margin within 30% of the figure; <b>rough</b> margin over 30% (shown as a range, no sentence); <b>inside the margin</b> the gap to the comparator is smaller than the two margins combined; <b>no measurable change</b> a decade change inside 1.1 times its margin; <b>not firm</b> a household rise that falls inside the margin once the 2014–18 occupancy rate is held. Same rules as the packet builder. Survey figures always take "about".</p>`}`;
    root.querySelectorAll('.pl-chip[title]').forEach(c => c.onclick = () => X.toast(c.textContent.replace(/^[●◐○]/, '').split(' (')[0] + ': ' + c.title));
    root.querySelectorAll('[data-say]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.say); X.toast('Copied'); } catch (e) { X.toast('Copy not allowed here'); } });
    P.view = 'place';
    const cb = $('#plCounty'); if (cb) cb.onclick = () => openCounty(pl.cty);
    const pb = $('#plPin'); if (pb) pb.onclick = () => togglePin(pl);
    drawMap(pl).catch(e => console.warn('places map', e));
  }

  function coverageStrip(meta, mk) {
    if (!meta) return '';
    const fam = {}; const mkKey = mk === 'PHL' ? ['PHL', 'PA', 'all'] : mk === 'PA' ? ['PA', 'other', 'all'] : mk === 'NJ' ? ['NJ', 'other', 'all'] : ['other', 'all'];
    for (const [f, m, s, n] of meta.coverage) { if (fam[f]) continue; if (mkKey.includes(m) || (m !== 'PHL' && m !== 'PA' && m !== 'NJ' && m !== 'other' && m !== 'all')) { if (mkKey.includes(m)) fam[f] = [s, n]; } }
    for (const [f, m, s, n] of meta.coverage) if (!fam[f] && m === 'all') fam[f] = [s, n];
    for (const [f] of meta.coverage) if (!fam[f]) fam[f] = ['none', 'Not held for this market'];
    return Object.entries(fam).map(([f, [s, n]]) => `<span class="pl-chip ${s}" title="${esc(n)}"><i aria-hidden="true">${s === 'full' ? '●' : s === 'part' ? '◐' : '○'}</i>${esc(f)}<span class="sr"> (${s === 'full' ? 'held' : s === 'part' ? 'partly held' : 'not held'}: ${esc(n)})</span></span>`).join('');
  }

  function topList(arr, names, base, baseM, n, pl, word) {
    const items = arr.map((x, i) => ({ name: names[i], e: x[0], m: x[1] })).filter(x => x.e > 0).sort((a, b) => b.e - a.e).slice(0, n);
    if (!items.length) return '<span class="muted">none counted</span>';
    return '<ol class="pl-top">' + items.map(x => {
      const p = x.e / base, pm = C.propMoe(x.e, x.m, base, baseM); const rough = !p || pm / p > 0.30;
      return `<li><b>${esc(x.name)}</b> ${cnt(x.e)} <span class="muted">${cntm(x.m)}</span> · ${pct1(p)} of ${word}${rough ? ' <span class="pl-v rough"><b aria-hidden="true">≈</b> rough</span>' : ''}</li>`;
    }).join('') + '</ol>';
  }

  function secPeople(pl) {
    const F = pl.figs, W = pl.W; const isZip = pl.kind === 'zip';
    const areaWord = pl.kind === 'radius' ? 'the tracts around here' : pl.kind === 'zip' ? `ZIP ${pl.zip}` : pl.kind === 'neighborhood' ? pl.name
      : pl.area ? (pl.area.halfmile ? `within half a mile of ${pl.area.name}` : `the neighborhoods around ${pl.area.name}`) : pl.rows.length === 1 ? 'this tract' : 'these tracts';
    // "within half a mile" only where the packet's half-mile test passed (spec 4.1); everything else says "around"
    const resSayLead = pl.area && pl.area.halfmile ? `About ${C.residents(W.pop_e, 'body')} people live ${areaWord}.` : null;
    const resSay = resSayLead || `About ${C.residents(W.pop_e, 'body')} people live in ${areaWord}.`;
    let rows = countRow('Residents', F.res_wa, pl, { say: resSay }) + countRow('Households', F.hh_wa, pl)
      + countRow('Total household income', F.agg_income, pl, { usd: true, big: true, note: 'all households, 2024 dollars' });
    if (isZip) rows += countRow('Median household income (the ZIP)', F.zip_median, pl, { usd: true, note: `${pl.cw.label} ${usd(pl.county.med)} ±${Math.round(pl.county.med_m || 0).toLocaleString()}` });
    else rows += `<tr><th>Tract median incomes<small>medians are never combined across tracts</small></th><td class="num">${W.med_n ? (W.med_n > 1 ? `${usd(W.med_min)}–${usd(W.med_max)}` : usd(W.med_min)) : '–'}</td><td></td><td class="num muted">${usd(pl.county.med)} ±${Math.round(pl.county.med_m || 0).toLocaleString()}</td><td class="small muted">${W.med_n} tract${W.med_n === 1 ? '' : 's'} with households</td></tr>`;
    rows += `<tr class="pl-sub"><th colspan="5">Born abroad, citizenship, language</th></tr>`
      + shareRow(F.trait_born_abroad, pl) + shareRow(F.x_naturalized, pl, { noSay: true }) + shareRow(F.x_noncitizen, pl)
      + shareRow(F.trait_lang_other, pl) + shareRow(F.x_lvw, pl, { need: true, noSay: true })
      + `<tr><th>Top countries of birth<small>among the 40 largest in the eight states</small></th><td colspan="4">${topList(W.cob, P.metaCache.countries, W.fb_e, W.fb_m, 5, pl, 'born abroad')}</td></tr>`
      + `<tr><th>Languages spoken at home<small>age 5+, groups as the survey reports them</small></th><td colspan="4">${topList(W.langs, P.metaCache.langs, W.c5_e, W.c5_m, 4, pl, 'residents 5+')}</td></tr>`
      + `<tr class="pl-sub"><th colspan="5">Ages and households</th></tr>`
      + shareRow(F.trait_u18, pl) + shareRow(F.trait_a1824, pl) + shareRow(F.trait_a65, pl) + shareRow(F.x_kids, pl, { noSay: true })
      + shareRow(F.trait_renters, pl) + shareRow(F.trait_no_car, pl) + shareRow(F.x_ba, pl, { noSay: true });
    // school enrollment by level (DW, Nov 14): ZIP only, with margins
    if (isZip && W.enr_e) {
      rows += `<tr class="pl-sub"><th colspan="5">School enrollment by level (age 3+)</th></tr>`;
      for (const [k, lab] of C.ENROLL) {
        const f = { value: W[k + '_e'] / W.enr_e, moe90: C.propMoe(W[k + '_e'], W[k + '_m'], W.enr_e, W.enr_m), comparator: null };
        rows += `<tr><th>${esc(lab)}<small>${cnt(W[k + '_e'])} ${cntm(W[k + '_m'])} enrolled</small></th><td class="num">${pct1(f.value)}</td><td class="num muted">${pts1(f.moe90)}</td><td class="num muted">of ${cnt(W.enr_e)} enrolled</td><td>${vcell(C.verdict(f, 'count'))}</td></tr>`;
      }
    }
    // school enrollment by level, by tract (B14007, Nov 14 night): districts, corridors, packet areas, neighborhoods, tracts, Here
    if (!isZip) {
      if (W.enr_e) {
        rows += `<tr class="pl-sub"><th colspan="5">School enrollment by level · ${cnt(W.enr_e)} ${cntm(W.enr_m)} enrolled, age 3+</th></tr>`;
        const enRow = (f) => f ? shareRow(f, pl, { noSay: true, note: `${cnt(f.count)} ${cntm(f.count_moe)} ${f.id === 'x_en_college' ? 'students' : 'enrolled'}` }) : '';
        rows += enRow(F.x_en_pre) + enRow(F.x_en_k12) + enRow(F.x_en_ug) + enRow(F.x_en_gr) + enRow(F.x_en_college);
      } else rows += `<tr><th>School enrollment by level</th><td class="num muted">–</td><td></td><td></td><td class="small muted">not held for these tracts</td></tr>`;
    }
    if (!P.meeting) rows += `<tr class="pl-sub"><th colspan="5">Internal only (never on a sheet)</th></tr>` + shareRow(F.x_poverty, pl) + shareRow(F.x_hisp, pl) + shareRow(F.x_black, pl) + shareRow(F.x_white, pl) + shareRow(F.x_asian, pl);
    let decade = '';
    if (F.pop_change) decade = table('A decade ago (2014–18 moved to 2020 tracts)', changeRow('Residents', F.pop_change, pl) + changeRow('Households', F.hh_change, pl) + changeRow('Born in another country', F.fb_change, pl)
      + changeRow('Households with no car', F.nv_change, pl) + changeRow('Households receiving SNAP', F.sn_change, pl) + changeRow('College and graduate students', F.col_change, pl))
      + (F.pop_change.test.backed_by_2020_count && F.pop_change.test.backed_by_2020_count.p20 ? note(`2020 Census count for these tracts: ${cnt(F.pop_change.test.backed_by_2020_count.p20)}.`) : '');
    else if (isZip) decade = note(pl.zxErr ? 'A decade ago: the ZIP extras file is not on this device; save it in Data status.' : 'A decade ago: not shown. This ZIP\'s area changed between 2010 and 2020 (the 2010 and 2020 ZIP areas share less than 99% of their land, Census relationship file), so the two periods do not cover the same place.');
    if (isZip && F.pop_change) decade += note('ZIP decade change: the 2014–18 figures are the 2010 ZIP area, which this ZIP keeps (99% or more of its land both ways). No 2014–18 housing-unit count is held for ZIPs, so a household rise is never called firm.');
    const enrollNote = isZip || !W.enr_e ? '' : note('School enrollment shares are of everyone enrolled (age 3+); the last row is college and graduate students among all residents 3 and over. Census table B14007. A single tract is noisy: most of these rows read "rough" there, and that is correct.');
    return sec('people', 'Who lives here', table('Measure', rows) + enrollNote + decade);
  }

  function secWork(pl) {
    const F = pl.figs, W = pl.W; const meta = P.metaCache; let body = '';
    if (F.jobs && F.jobs.value !== null) {
      const sec = F.jobs.cns.map((n, i) => ({ i, n, cmp: (F.jobs.cmp_cns || [])[i] || 0 })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 4);
      const yr = pl.rows[0][0].startsWith('42') ? '2024' : '2023';
      body += table('Jobs based here', `<tr><th>Jobs based in these tracts<small>LODES ${yr}; counts, no survey margin</small></th><td class="num">${cnt(F.jobs.value)}</td><td></td><td class="num muted">${cnt(F.jobs.cmp_total)}</td><td>${F.jobs.test.gates.G5 === 'pass' || pl.rows.length === 1 ? vcell({ cls: 'solid', mark: '✓', word: 'count' }) : `<span class="pl-tag">concentrated: one tract holds ${Math.round(F.jobs.top_tract_share * 100)}%</span>`}${F.jobs.test.gates.G5 === 'pass' || pl.rows.length === 1 ? '<div>' + say(`About ${C.round(F.jobs.value, 100)} jobs are based in ${pl.kind === 'radius' ? 'the tracts around here' : 'these tracts'}.`) + '</div>' : ''}</td></tr>`
        + sec.map(x => `<tr><th>${esc(meta.sectors[x.i])}</th><td class="num">${pct1(x.n / F.jobs.value)}</td><td class="num muted">${cnt(x.n)}</td><td class="num muted">${F.jobs.cmp_total ? pct1(x.cmp / F.jobs.cmp_total) : '–'}</td><td class="small muted">${F.jobs.cmp_total && x.n / F.jobs.value >= 1.5 * (x.cmp / F.jobs.cmp_total) ? 'well above ' + esc(pl.cw.label) : ''}</td></tr>`).join(''));
    } else if (pl.kind === 'zip' && pl.zx && pl.zx.jobs) {
      // phase 2c: jobs by ZIP, Pennsylvania (LODES 2024 blocks summed to the ZIP); no apportioning
      const j = pl.zx.jobs, tot = j[0]; const cns = j.slice(7); const cm = pl.Cm || {};
      const top = cns.map((n, i) => ({ i, n, cmp: (cm.cns || [])[i] || 0 })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 4);
      body += tableH('Jobs based in this ZIP (LODES 2024)', `<tr><th>Jobs based in ZIP ${esc(pl.zip)}<small>LODES 2024 blocks summed to the ZIP area; counts, no survey margin</small></th><td class="num">${cnt(tot)}</td><td></td><td class="num muted">${cnt(cm.jobs)}</td><td>${vcell({ cls: 'plain', mark: '·', word: 'count' })}</td></tr>`
        + top.map(x => `<tr><th>${esc(meta.sectors[x.i])}</th><td class="num">${pct1(x.n / tot)}</td><td class="num muted">${cnt(x.n)}</td><td class="num muted">${cm.jobs ? pct1(x.cmp / cm.jobs) : '–'}</td><td class="small muted">${cm.jobs && x.n / tot >= 1.5 * (x.cmp / cm.jobs) ? 'well above ' + esc(pl.cw.label) : ''}</td></tr>`).join('')
        + `<tr><th>Earning $1,250 a month or less · $1,251–3,333 · over $3,333</th><td colspan="4" class="small">${[4, 5, 6].map(k => pct1(j[k] / tot)).join(' · ')}</td></tr>`
        + `<tr><th>Workers 29 or younger · 30–54 · 55 and over</th><td colspan="4" class="small">${[1, 2, 3].map(k => pct1(j[k] / tot)).join(' · ')}</td></tr>`)
        + note(`A ZIP is not a district: keep it off the front of a sheet. The comparator column is ${esc(pl.cw.label)}. Where workers live and where residents work stay by tract.`);
    } else body += notHeld('Jobs based here', pl.kind === 'zip' ? 'jobs by ZIP are held for Pennsylvania only (the LODES block-to-ZIP crosswalk is loaded for Pennsylvania); look up a tract or district' : 'not held for these tracts');
    body += table('How residents get to work', shareRow(F.trait_transit_walk, pl) + shareRow(F.x_drove, pl, { noSay: true }) + shareRow(F.x_wfh, pl, { noSay: true }));
    const prof = phlProfile(pl);
    if (prof && !(pl.wk && pl.wk.septa)) body += table('Transit inside the district (stop-and-route rows; the transit file is not on this device)', `<tr><th>Transit stops inside</th><td class="num">${cnt(prof.transit_stops_inside)}</td><td></td><td></td><td class="small muted">SEPTA, summer 2025</td></tr><tr><th>Weekday bus boardings</th><td class="num">${cnt(prof.bus_weekday_boardings_summer2025)}</td><td></td><td></td><td class="small muted">inside the boundary</td></tr><tr><th>Weekday trolley boardings</th><td class="num">${cnt(prof.trolley_weekday_boardings_summer2025)}</td><td></td><td></td><td></td></tr>`);
    body += secWork2(pl);
    return sec('work', 'Who works and shops here', body);
  }

  function phlProfile(pl) {
    if (!P.phl || !pl.area) return null;
    const id = pl.area.district_id || (pl.area.id === 'cor:mayfair' ? '9' : null);
    const d = id && P.phl.districts[id]; return d ? d.profile : null;
  }
  function phlRec(pl) { if (!P.phl || !pl.area) return null; const id = pl.area.district_id || (pl.area.id === 'cor:mayfair' ? '9' : null); return id ? P.phl.districts[id] : null; }

  // ---------------------------------------------------------------- Philadelphia address records (phase 2)
  const PTS = ['places_pts_meta.json.gz', 'places_pts_lic.json.gz', 'places_pts_permits.json.gz', 'places_pts_parcels.json.gz', 'places_pts_sales.json.gz', 'places_pts_small.json.gz'];
  async function recordsSet() {
    if (P.rec) return P.rec;
    if (!RC) throw new Error('records code not loaded');
    const f = {}; let from = 'device';
    let stale = false;
    for (const n of PTS) { const g = await getFile(n); if (g.from === 'network') from = 'network'; if (g.stale) stale = true; f[n.replace(/^places_pts_|\.json\.gz$/g, '')] = g.data; }
    P.rec = RC.load(f); P.rec.from = from; P.rec.stale = stale;
    // review 2a, defect 8: the parsed JSON is no longer needed once decoded into typed columns
    for (const n of PTS) delete P.mem[n];
    return P.rec;
  }
  const inPhl = (pl) => pl.kind !== 'zip' && pl.rows && pl.rows.length && pl.rows.every(r => r[0].startsWith('42101'));
  /** the selection a place's records are counted on: corridor addresses, the district boundary, the tracts, or the true circle */
  function recordSel(pl) {
    const a = pl.area;
    // a district counts inside its City boundary (its legal area; the district tables count the same way), even where a line is drawn
    if (a && a.kind === 'district') return { kind: 'district', id: a.district_id };
    if (a && a.addr && a.addr.parts && a.addr.parts.length) return { kind: 'addr', parts: a.addr.parts, how: a.addr.kind };
    if (pl.kind === 'radius') return { kind: 'radius', lat: pl.center[0], lon: pl.center[1], r: pl.radius };
    if (pl.kind === 'tract' || pl.kind === 'neighborhood') return { kind: 'tracts', tracts: pl.rows.map(r => r[0]) };
    if (a && a.kind === 'corridor') return null;     // a corridor with no address rule: no records rather than a different area
    return { kind: 'tracts', tracts: pl.rows.map(r => r[0]) };
  }
  async function attachRecords(pl) {
    pl.rec = null; pl.recErr = null;
    if (pl.kind === 'zip' || !pl.rows || !pl.rows.length) return;
    const a = pl.area; const anyPhl = pl.rows.some(r => r[0].startsWith('42101'));
    // records are Philadelphia's: a district or a corridor with an address rule counts them whatever its tracts; a tract set or a circle
    // needs Philadelphia tracts, and a circle that crosses the city line says so
    const ok = (a && (a.kind === 'district' || (a.addr && a.st === 'PA'))) || (pl.kind === 'radius' ? anyPhl : inPhl(pl));
    if (!ok) { if (a && a.kind === 'corridor' && anyPhl) pl.recErr = 'no_rule'; return; }
    const sel = recordSel(pl); if (!sel) { pl.recErr = 'no_rule'; return; }
    pl.recCity = pl.kind === 'radius' && !inPhl(pl);
    try { const R = await recordsSet(); pl.rec = RC.summarize(R, sel); pl.rec.from = R.from; pl.rec.stale = R.stale; pl.rec.dates = R.meta.dates; pl.rec.unplacedShare = unplacedShares(R); pl.rec.unplacedSba = R._us || (R._us = RC.unplacedSbaShare(R)); }
    catch (e) { console.warn('places records', e); pl.recErr = e.message || String(e); }
  }
  function unplacedShares(R) {
    if (R._un) return R._un; const o = {};
    for (const [k, Ly] of Object.entries(R.L)) { let n = 0; for (let i = 0; i < Ly.n; i++) if (Ly.c.y[i] === null) n++; o[k] = Ly.n ? n / Ly.n : 0; }
    return (R._un = o);
  }
  const titleSt = (s) => s.toLowerCase().replace(/\b(\w)/g, c => c.toUpperCase()).replace(/\bAve\b/, 'Avenue').replace(/\bSt\b/, 'Street').replace(/\bBlvd\b/, 'Boulevard').replace(/\bRd\b/, 'Road')
    .replace(/^N /, 'North ').replace(/^S /, 'South ').replace(/^E /, 'East ').replace(/^W /, 'West ').replace(/(\d)(St|Nd|Rd|Th)\b/g, (m, d, t) => d + t.toLowerCase());
  /** the area in words, for row labels and say-lines */
  function recWhere(pl) {
    const sel = pl.rec && pl.rec.sel; if (!sel) return { short: '', long: '' };
    if (sel.kind === 'addr') {
      // a rule with "N 10TH ST" and "S 10TH ST" names one street to a reader ("10th Street"), as the packets print it (review 2a, 11)
      const streets = [...new Set(sel.parts.map(p => titleSt(p[0].replace(/^[NSEW] (?!(ST|AVE)$)/, ''))))];
      const lim = sel.parts.map(p => `${titleSt(p[0])} ${p[1].toLocaleString('en-US')} to ${p[2].toLocaleString('en-US')}`).join('; ');
      const nm = pl.area && pl.area.kind === 'packet' && !P.meeting ? pl.area.name : streets.length <= 2 ? streets.join(' and ') : 'corridor';
      return { short: `${nm} addresses`, long: `addresses ${lim} (both sides)`, rule: sel.how === 'packet' ? "the packet's address rule" : 'corridor addresses: the full blocks of the street(s) whose parcels front the line' };
    }
    if (sel.kind === 'district') return { short: 'addresses inside the district', long: 'inside the City boundary of the district' };
    if (sel.kind === 'radius') return { short: `addresses within ${sel.r.toLocaleString('en-US')} m of here`, long: `inside the true ${sel.r.toLocaleString('en-US')} m circle around where you are standing` };
    return { short: sel.tracts.length === 1 ? 'addresses in this tract' : 'addresses in these tracts', long: `inside the ${sel.tracts.length} census tract${sel.tracts.length === 1 ? '' : 's'} of 2020` };
  }
  const yrsCells = (o, ys) => ys.map(y => `${y}: <b>${cnt((o || {})[y] || 0)}</b>`).join(' · ');
  /** a run of yearly counts. Meeting mode never shows a run that ends below where it starts (review 2a, defect 5): it shows the total only.
   *  The last cell of a part year is always labeled with its end date, in every mode. */
  function runCells(o, ys, opts = {}) {
    o = o || {}; const v = (y) => o[y] || 0;
    const tot = ys.reduce((a, y) => a + v(y), 0);
    if (P.meeting && ys.length > 1 && v(ys[ys.length - 1]) < v(ys[0])) return `${ys[0]}–${String(ys[ys.length - 1]).slice(2)}: <b>${cnt(tot)}</b> in all`;
    let out = ys.map(y => `${y}: <b>${cnt(v(y))}</b>`).join(' · ');
    if (opts.partYear && !(P.meeting && opts.partYear.v < v(ys[ys.length - 1]) * opts.partYear.frac)) out += ` · ${esc(opts.partYear.label)}: <b>${cnt(opts.partYear.v)}</b>`;
    return out;
  }
  const monthDay = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const gateTag = (g) => (!g || g === 'pass' || P.meeting) ? '' : `<span class="pl-tag">${esc(g.replace(/^FAIL: /, 'not for a sheet: ').replace(/^hold the year to date: /, 'year to date under 90% of last year: '))}</span>`;
  const recRow = (label, fig, rest, opts = {}) => (opts.internal && P.meeting) ? '' : `<tr class="${opts.internal ? 'pl-int' : ''}"><th>${esc(label)}${opts.note && !P.meeting ? `<small>${esc(opts.note)}</small>` : ''}</th><td class="num">${fig}</td><td></td><td></td><td>${rest || ''}</td></tr>`;
  const fileDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const Y5 = [2021, 2022, 2023, 2024, 2025];

  function recPermitsLicenses(pl) {
    const r = pl.rec; const w = recWhere(pl); const p = r.permits, l = r.licenses; const M = P.meeting;
    let rows = '';
    if (p && P.meeting !== 'food') {
      // CL-19 (review 2a, defect 2): no copy-ready sentence unless G3, G5 and G7 all pass
      const okSay = RC.permitSayOK(p);
      const { lead, support } = RC.permitsSay(p, w.short);
      rows += recRow('Permits issued, 2021–25', cnt(p.five), `${runCells(p.by_year, Y5)}${gateTag(p.gates.G3)}${gateTag(p.gates.G5)}${gateTag(p.gates.G7)}${okSay ? '<div>' + say(lead + ' ' + support) + '</div>' : ''}`,
        { note: p.steady.steady ? `steady run: about ${cnt(p.steady.avg10)} a year` : 'not a steady run: give the total, not a yearly average' });
      // year to date beside the same point last year (G7); in meeting mode the pair is hidden when this year is behind (no decline on a screen a client sees)
      if (p.ytd && !(M && p.ytd.this < p.ytd.last)) rows += recRow(`${p.ytd.year} so far (through ${p.ytd.through})`, cnt(p.ytd.this), `same point in ${p.ytd.year - 1}: <b>${cnt(p.ytd.last)}</b>${p.gates.G7 !== 'pass' && !M ? ' <span class="pl-tag">year to date under 90% of last year: the sheet would leave permits out</span>' : ''}`);
      if (!M) rows += recRow('Top address (2021–25)', cnt(p.top_address_n), `${esc(p.top_address || '–')} · ${Math.round(p.top_share * 100)}% of the five years`, { internal: true });
      if (!M && p.types.length) rows += recRow('By permit type (2021–25)', '', p.types.slice(0, 6).map(([t, n]) => `${esc(t)} <b>${cnt(n)}</b>`).join(' · ') + ` · zoning and administrative ${Math.round(p.zoning_admin_share * 100)}%`);
    }
    if (l) {
      const ckOk = l.gates.CK === 'pass' && l.gates.G5 === 'pass';
      rows += recRow('Active City food licenses', cnt(l.food_active), `at ${cnt(l.food_addresses)} addresses · file of ${fileDate(l.as_of)}${gateTag(l.gates.CK)}${gateTag(l.gates.G5)}${ckOk ? '<div>' + say(`We count ${l.food_active.toLocaleString('en-US')} active City food licenses at ${l.food_addresses.toLocaleString('en-US')} ${w.short}, as of ${fileDate(l.as_of)}.`) + '</div>' : ''}`,
        { note: 'every City license type that starts "Food", as the packets count them' });
      const ly = +String(l.as_of).slice(0, 4);   // the file's year, not the device clock (review 2a, 11)
      rows += recRow('Food licenses first issued, 2021–25', cnt(l.first5), `${runCells(l.first_issued, Y5, { partYear: { label: `${ly} to ${monthDay(l.as_of)}`, v: (l.first_issued || {})[ly] || 0, frac: 0 } })}${gateTag(l.gates.S2)}`,
        { note: `restaurants and food stores only (the four storefront types): ${Y5.map(y => (l.first_issued_store4 || {})[y] || 0).join(', ')}` });
      rows += recRow('Food licenses that closed, by year', '', yrsCells(l.closed_food, Y5), { internal: true, note: 'inactive, closed, expired or revoked, by the date the City records; internal: a closure count reads as a decline' });
      if (!M) rows += recRow('Active licenses, all types', cnt(l.active_all), l.active_types.slice(0, 5).map(([t, n]) => `${esc(t)} <b>${cnt(n)}</b>`).join(' · '));
    }
    const notes = [];
    if (r.stale) notes.push('<b>An older copy of the records is on this device</b> (Drive holds a newer one). Connect and use Data status → Re-download everything saved.');
    notes.push(`<b>Where:</b> ${esc(w.long)}${w.rule ? ` (${esc(w.rule)})` : ''}. Records counted exactly; file dates: permits ${fileDate(p && p.as_of)}, licenses ${fileDate(l && l.as_of)}.`);
    notes.push('Say "permits", never "permits for work": zoning and administrative permits are part of the count. Permits and licenses count different things (work approved at an address; a business registered at one); never add them, and an active license can outlast the shop.');
    if (pl.rec.sel.kind !== 'addr') notes.push(`Records with no map location count only on corridor cards, by address: ${Math.round((pl.rec.unplacedShare.lic || 0) * 100)}% of licenses (mostly vendors with no fixed spot) and ${Math.round((pl.rec.unplacedShare.permits || 0) * 100)}% of permits are not on the map.`);
    if (pl.rec.sel.kind === 'radius') notes.push('A circle cuts across blocks: these are the records inside the true circle, not the census tracts above.' + (pl.recCity ? ' The circle crosses the city line: only Philadelphia records are counted.' : ''));
    return `<h4 class="pl-h4">City records at ${esc(w.short)}</h4>` + table(`City records at ${w.short}`, rows) + notes.map(note).join('');
  }

  function recMoney(pl) {
    const r = pl.rec; const w = recWhere(pl); const M = P.meeting; let rows = '';
    const q = r.property;
    if (q) {
      const okS5 = r.sel.kind === 'addr' && q.gates.S5 === 'pass' && q.gates.G5_owner === 'pass';
      const s5 = okS5 ? `${cnt(q.n)} properties have a ${w.short.replace(/ addresses$/, '')} address ${r.sel.parts.length === 1 ? `between ${r.sel.parts[0][1].toLocaleString('en-US')} and ${r.sel.parts[0][2].toLocaleString('en-US')}` : 'in these blocks'}. They sit under about ${q.owners_print} owner names in the City's property records.` : '';
      rows += recRow('Properties (all OPA parcels)', cnt(q.n), `under about <b>${esc(q.owners_print)}</b> owner names${M ? '' : ` (${cnt(q.owners)} after case and punctuation are set aside; ${cnt(q.owners_raw)} as recorded)`}${gateTag(q.gates.S5)}${gateTag(q.gates.G5_owner)}${s5 ? '<div>' + say(s5) + '</div>' : ''}`);
      rows += recRow('Non-residential properties', cnt(q.nonres), `${cnt(q.nonres_owners)} owner names · City market value ${C.usdBig ? C.usdBig(q.nonres_value) : usd(q.nonres_value)}${gateTag(q.gates.G5_value)}`, { note: `OPA file of ${fileDate(q.as_of)}; market value rounded to the thousand per property` });
      rows += recRow('Largest owners (by parcels)', '', q.top_owners.map(([n, k]) => `${esc(n || 'owner of fewer than 3 parcels citywide')} <b>${k}</b>`).join(' · '), { internal: true, note: 'internal: never on a sheet or a screen a client sees' });
    }
    const s = r.sales;
    if (s) {
      // review 2a, defects 4 and 5: one count per deed (a deed covering several properties once); medians from single-property deeds, shown
      // from 5 deeds; the part year labeled with its end date in every mode; meeting mode never shows a run that ends below its start
      const sy = +String(s.as_of).slice(0, 4); const part = { label: `${sy} to ${monthDay(s.as_of)}`, v: s.by_year[sy] || 0, frac: 0 };
      const meds = Y5.filter(y => s.median_price[y]).map(y => `${y}: ${usd(s.median_price[y])}`);
      rows += recRow('Recorded deeds over $1,000', '', runCells(s.by_year, Y5, { partYear: part }) + (meds.length ? `<div class="small muted">median price, single-property deeds: ${meds.join(' · ')}</div>` : ''),
        { note: `one count per deed, however many properties it covers; recorded through ${fileDate(s.as_of)}; a median is shown only where a year has 5 or more single-property deeds; ${cnt(s.nonres_sales)} deeds include a non-residential property` });
      rows += recRow('Sheriff deeds', '', runCells(s.sheriff_by_year, Y5, { partYear: { label: part.label, v: s.sheriff_by_year[sy] || 0, frac: 0 } }), { internal: true, note: 'internal: a distress signal, never on a sheet' });
    }
    const L = r.loans;
    if (L) {
      // review 2a, defect 6: only an address rule finds every loan. Counted by map position (district, tract, circle), loans that could not be
      // placed are missing, so the count is a floor: "at least N", no sentence, no dollar total, and the caveat stays in the cell (meeting mode too)
      const floor = r.sel.kind !== 'addr'; const us = r.unplacedSba;
      const ok = !floor && L.gates.G3 === 'pass' && L.gates.G5_count === 'pass';
      const lead = `Lenders approved ${cnt(L.n_since_fy2020)} SBA-backed loans at ${cnt(L.k_addresses)} ${w.short} since October 2019.` + (L.latest ? ` The latest was in ${new Date(L.latest + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.` : '');
      const fys = Object.keys(L.by_fy).sort(); const fyO = {}; for (const y of fys) fyO[y] = L.by_fy[y];
      const fyRow = fys.length ? (M && fys.length > 1 && (L.by_fy[fys[fys.length - 1]] || 0) < (L.by_fy[fys[0]] || 0) ? '' : '<div class="small">' + fys.map(y => `FY${String(y).slice(2)}: <b>${L.by_fy[y]}</b>`).join(' · ') + '</div>') : '';
      const dollars = floor ? '' : (L.gates.G5_dollars === 'pass' && L.dollars_since ? `<div class="small muted">${L.dollars_since >= 1e7 ? C.usdBig(L.dollars_since) : usd(L.dollars_since)} approved</div>` : (L.dollars_since && !M ? '<div class="small muted">dollar total withheld: one address holds over a third of it</div>' : ''));
      const fl = floor ? `<div class="small"><b>A floor:</b> ${us ? `${Math.round(us.share * 100)}% of Philadelphia's FY2020-on loans (${cnt(us.unplaced)} of ${cnt(us.n)})` : 'some loans'} could not be placed on the map and are not counted here; a corridor card counts them by address.</div>` : '';
      rows += recRow('SBA-backed loans since FY2020', floor ? `at least ${cnt(L.n_since_fy2020)}` : cnt(L.n_since_fy2020), `at ${floor ? 'least ' : ''}${cnt(L.k_addresses)} addresses${L.latest ? ' · latest ' + fileDate(L.latest) : ''}${fyRow}${dollars}${fl}`
        + gateTag(L.gates.G3) + gateTag(L.gates.G5_count) + (ok ? '<div>' + say(lead) + '</div>' : ''), { note: '7(a) and 504; cancelled, not funded and mailbox-store addresses excluded; SBA file Sept 30, 2026. No earlier-decade count: beside a smaller recent count it reads as a decline' });
    }
    const G = r.grants;
    if (G) rows += recRow('Storefront improvement grants', cnt(G.n), G.n ? `${G.fy_first === G.fy_last ? 'fiscal ' + G.fy_first : `fiscal ${G.fy_first}–${G.fy_last}`} · ${usd(G.dollars)}${gateTag(G.gates.G3)}` : 'none recorded');
    const notes = [];
    return `<h4 class="pl-h4">Property and lending at ${esc(w.short)}</h4>` + table(`Property and lending at ${w.short}`, rows) + notes.map(note).join('');
  }

  function storeRows(pl) {
    const W = pl.W; const n = W.snap_n || 0;
    if (pl.kind === 'zip') { const z = pl.W; return { n: z.snap_n, sup: z.snap_sup, gro: z.snap_gro, conv: z.snap_conv, fm: z.snap_fm, spec: z.snap_spec, oth: z.snap_oth, rmp: z.snap_rmp }; }
    return { n, sup: W.snap_sup, gro: W.snap_gro, conv: W.snap_conv, fm: W.snap_fm, spec: W.snap_spec, oth: W.snap_oth, rmp: W.snap_rmp };
  }

  function secOpen(pl) {
    let body = '';
    const s = storeRows(pl);
    if (P.meeting !== 'district') body += table('SNAP-authorized stores open now', [['All SNAP stores', s.n], ['Supermarkets and super stores', s.sup], ['Grocery stores', s.gro], ['Convenience stores', s.conv], ['Dollar, pharmacy and other', s.oth], ['Specialty stores', s.spec], ['Farmers markets', s.fm]]
      .map(([l, v]) => `<tr><th>${esc(l)}</th><td class="num">${cnt(v || 0)}</td><td></td><td></td><td class="small muted">USDA file, Nov 13, 2026</td></tr>`).join('')) + snapHistBlock(pl);
    const rec = phlRec(pl); const p = rec && rec.profile;
    if (pl.rec) body += recPermitsLicenses(pl);
    else if (p) {
      const yrs = [2021, 2022, 2023, 2024, 2025];
      body += table('City records, inside the district (Philadelphia)', `<tr><th>Permits by year</th><td colspan="4">${yrs.map(y => `${y}: <b>${cnt(p['permits_' + y])}</b>`).join(' · ')}</td></tr>`
        + `<tr><th>New food licenses by year</th><td colspan="4">${yrs.map(y => `${y}: <b>${cnt(p['new_food_lic_' + y])}</b>`).join(' · ')} · 2026 so far: <b>${cnt(p.new_food_lic_2026_ytd)}</b></td></tr>`)
        + note(`Counted inside the district boundary (B+W district tables, Nov 11). The address records are not on this device${pl.recErr ? ' (' + esc(whyFail({ message: pl.recErr })) + ')' : ''}: save them in Data status.`);
    } else if (pl.kind === 'zip' && pl.zrec) {
      const cbp = pl.zrec.cbp || [];
      // "Largest sectors" is withheld: the source view (vw_zip_cbp_sector_shares_2023) carries a total row at twice the count and
      // inflated sector counts (review defect 6). Restore once the data thread corrects the view.
      body += table(`Business locations in ZIP ${pl.zip} (labeled as the ZIP)`, `<tr><th>Locations by year</th><td colspan="4">${cbp.map(([y, n]) => `${y}: <b>${cnt(n)}</b>`).join(' · ') || '–'}</td></tr>`)
        + note('County Business Patterns. The ZIP is a postal area, not this district. Sectors by ZIP are held back until the source table is corrected.');
    } else body += notHeld('Licenses and permits', pl.market === 'PHL' ? (pl.recErr === 'no_rule' ? 'this corridor has no address rule yet (its line is not drawn on a named Philadelphia street); open the district or tap Here for a circle' : `the Philadelphia address records are not on this device${pl.recErr ? ' (' + whyFail({ message: pl.recErr }) + ')' : ''}; save them in Data status`) : 'not held for this market');
    return sec('open', "What's opening and closing", body);
  }

  function secMoney(pl) {
    let body = '';
    const rec = phlRec(pl); const p = rec && rec.profile;
    if (pl.rec) {
      body += recMoney(pl);
      if (p) { const vals = (rec.values || []).filter(v => v.tax_year >= 2021); body += table('Inside the district: value by year (B+W district tables)', `<tr><th>Taxable non-residential value</th><td colspan="4">${vals.map(v => `${v.tax_year}: <b>${C.usdBig(v.taxable_nonres_value)}</b>`).join(' · ')}</td></tr>`); }
    } else if (p) {
      const vals = (rec.values || []).filter(v => v.tax_year >= 2021);
      body += table('Property inside the district (Philadelphia)', `<tr><th>Non-residential parcels</th><td class="num">${cnt(p.nonres_parcels)}</td><td></td><td></td><td class="small muted">${cnt(p.distinct_nonres_owners)} owners${P.meeting ? '' : `, ${cnt(p.owners_with_2plus_nonres_parcels)} with 2 or more`}</td></tr>`
        + `<tr><th>Taxable non-residential value</th><td colspan="4">${vals.map(v => `${v.tax_year}: <b>${C.usdBig(v.taxable_nonres_value)}</b>`).join(' · ')}</td></tr>`
        + (P.meeting ? '' : `<tr class="pl-int"><th>Largest owners<small>internal: never on a sheet or a screen a client sees</small></th><td colspan="4">${(rec.top_owners || []).sort((a, b) => b.n - a.n).map(o => `${esc(o.owner_name)} <b>${o.n}</b>`).join(' · ')}</td></tr>`)
        + `<tr><th>Storefront improvement grants</th><td class="num">${cnt(p.storefront_grants)}</td><td></td><td></td><td class="small muted">${p.storefront_grant_usd ? usd(p.storefront_grant_usd) : ''}</td></tr>`
        + `<tr><th>SBA-backed loans, FY2020–26</th><td class="num">at least ${cnt(p.sba_loans_fy2020_26)}</td><td></td><td></td><td class="small"><b>A floor:</b> loans the district table could place inside the boundary; cancelled excluded; SBA file Sept 30, 2026</td></tr>`);
    }
    if (pl.kind === 'zip' && pl.zrec) {
      const W = pl.W; const sba = pl.zrec.sba || []; const fy = {}; for (const [y, prog, n, amt] of sba) { fy[y] = fy[y] || [0, 0]; fy[y][0] += n; fy[y][1] += amt; }
      body += table(`Money in ZIP ${pl.zip}`, `<tr><th>Average tax-return income<small>IRS, tax year 2022</small></th><td class="num">${usd(W.irs_avg_agi ? W.irs_avg_agi * (W.irs_avg_agi < 5000 ? 1000 : 1) : null)}</td><td></td><td></td><td class="small muted">${cnt(W.irs_returns)} returns; 5-year change ${W.irs_chg5 !== null ? (W.irs_chg5 * 100).toFixed(1) + '%' : '–'}</td></tr>`
        + `<tr><th>Share of filers, low and high bands</th><td colspan="4">${W.irs_low !== null ? pct1(W.irs_low) : '–'} low · ${W.irs_high !== null ? pct1(W.irs_high) : '–'} high <span class="muted small">(2022)</span></td></tr>`
        + `<tr><th>SBA 7(a) and 504 loans by fiscal year</th><td colspan="4">${Object.keys(fy).sort().map(y => `FY${String(y).slice(2)}: <b>${fy[y][0]}</b>`).join(' · ') || 'none since FY2020'}</td></tr>`);
    }
    if (!body) body = notHeld('Property and lending', pl.market === 'PHL' ? 'the Philadelphia address records are not on this device, or this corridor has no address rule; ZIP cards carry SBA lending' : pl.market === 'NJ' ? 'NJ property and sales records are phase 3; SBA lending is on the ZIP card' : 'not held for this market; SBA lending is on the ZIP card');
    body += note('Home value and rent trend: later phase.');
    return sec('money', 'Property and money', body);
  }

  function rangeOf(pl, col) {
    const vals = pl.rows.map(r => r[pl.ci(col)]).filter(v => v !== null && v !== undefined);
    if (!vals.length) return null; return [Math.min(...vals), Math.max(...vals), vals.length];
  }
  function flagCount(pl, col) { const v = pl.rows.map(r => r[pl.ci(col)]); const held = v.filter(x => x !== null && x !== undefined); return held.length ? `${held.filter(x => x === 1).length} of ${held.length}` : 'not held'; }

  function secFood(pl) {
    const F = pl.figs, W = pl.W; let body = note('The community lens (Brown + Wheaten, not a Strategy Lab sales figure). Every food row is a need fact: allowed in a statement of need, never on the front of a district sheet.');
    body += table('SNAP and getting to food', shareRow(F.x_snap, pl, { need: true, label: 'Households receiving SNAP', note: 'survey table B22003' })
      + (F.sn_change ? changeRow('SNAP households, a decade ago', F.sn_change, pl) : '') + shareRow(F.trait_no_car, pl, { need: true, noSay: true }) + shareRow(F.trait_transit_walk, pl, { need: true, noSay: true }));
    const s = storeRows(pl); const full = (s.sup || 0) > 0; const per = W.pop_e ? (s.n || 0) / W.pop_e * 1000 : null;
    body += table('Stores', `<tr><th>SNAP stores per 1,000 residents</th><td class="num">${per !== null ? per.toFixed(1) : '–'}</td><td></td><td></td><td class="small muted">${cnt(s.n)} stores; a full-line store (supermarket or super store) ${full ? 'is' : 'is <b>not</b>'} present</td></tr>`
      + (pl.kind === 'zip' ? '' : (() => { const r = rangeOf(pl, 'sm_mi'); return `<tr><th>Distance to the nearest supermarket<small>from the tract's center</small></th><td class="num">${r ? (r[0] === r[1] ? r[0].toFixed(2) : r[0].toFixed(2) + '–' + r[1].toFixed(2)) + ' mi' : '–'}</td><td></td><td></td><td class="small muted">${r ? r[2] + ' tract' + (r[2] > 1 ? 's' : '') : ''}</td></tr>`; })())
      + (pl.kind === 'zip' ? '' : `<tr><th>Local food points<small>farmers markets, CSAs, food hubs, on-farm markets</small></th><td class="num">${cnt(W.lf || 0)}</td><td></td><td></td><td class="small muted">${cnt(W.lf_snap || 0)} take SNAP · ${cnt(W.lf_wic || 0)} WIC · ${cnt(W.lf_fmnp || 0)} market coupons</td></tr>`));
    if (pl.kind !== 'zip') {
      // SRAM shares are stored as percents (0 to 100)
      const r = (c) => { const x = rangeOf(pl, c); return x ? (x[0] === x[1] ? pct1(x[0] / 100) : `${pct1(x[0] / 100)}–${pct1(x[1] / 100)}`) : '–'; };
      const sramL = pl.rows.filter(x => x[pl.ci('s_fd')] === 1).length, lramL = pl.rows.filter(x => x[pl.ci('l_fd')] === 1).length;
      const lNotS = pl.rows.filter(x => x[pl.ci('l_fd')] === 1 && x[pl.ci('s_fd')] === 0).length, sNotL = pl.rows.filter(x => x[pl.ci('s_fd')] === 1 && x[pl.ci('l_fd')] === 0).length;
      body += table('USDA food-access maps (yes/no flags by tract; no margin)', `<tr><th>SRAM 2025: food desert (standard)</th><td class="num">${flagCount(pl, 's_fd')}</td><td></td><td></td><td class="small muted">tracts flagged</td></tr>`
        + `<tr><th>SRAM: strict urban · vehicle-constrained</th><td class="num">${flagCount(pl, 's_fdu')} · ${flagCount(pl, 's_fdv')}</td><td></td><td></td><td></td></tr>`
        + `<tr><th>SRAM: low access at ½ mile · 1 mile</th><td class="num">${flagCount(pl, 's_la05')} · ${flagCount(pl, 's_la1')}</td><td></td><td></td><td></td></tr>`
        + `<tr><th>Share beyond ½ mile of a SNAP grocer<small>range across the tracts</small></th><td colspan="4" class="small">all residents ${r('s_pop')} · low-income ${r('s_li')} · SNAP households ${r('s_snap')} · no-car households ${r('s_nv')} · children ${r('s_kid')} · seniors ${r('s_sen')}</td></tr>`
        + `<tr><th>LRAM 2019: food desert · ½-mile flag<small>2010 tracts, moved where the boundary allows</small></th><td class="num">${flagCount(pl, 'l_fd')} · ${flagCount(pl, 'l_fd05')}</td><td></td><td></td><td class="small muted">${lramL || sramL ? `standard flag: LRAM flags ${lNotS} tract${lNotS === 1 ? '' : 's'} SRAM does not; SRAM flags ${sNotL} LRAM does not` : 'standard flag: neither map flags these tracts'}</td></tr>`);
    }
    body += placesTable(pl, [0, 1, 2], 'Modeled food measures (CDC PLACES 2025)');
    const mmg = pl.county && pl.county.mmg && pl.county.mmg['2024'];
    body += mmg ? table(`County food insecurity (Map the Meal Gap 2024): ${pl.cw.head}`, `<tr><th>Food insecurity, all ages</th><td class="num">${pct1(mmg[0])}</td><td></td><td></td><td class="small muted">about ${cnt(mmg[1])} people · modeled, no margin</td></tr><tr><th>Child food insecurity</th><td class="num">${pct1(mmg[2])}</td><td></td><td></td><td></td></tr><tr><th>Cost per meal</th><td class="num">${mmg[3] ? '$' + mmg[3].toFixed(2) : '–'}</td><td></td><td></td><td></td></tr>`)
      : notHeld('County food insecurity', 'not matched for this county (Connecticut planning regions may use the old county codes)');
    body += foodExtras(pl);
    body += note('Not built yet: food stores as points on the map and by true circle (counts here are by tract), WIC and school meals outside Pennsylvania (not held).');
    return sec('food', 'Food access', body);
  }

  function placesTable(pl, idx, title) {
    const meta = P.metaCache; const st = pl.kind === 'zip' ? pl.zrec.st : ST_FIPS[pl.rows[0][0].slice(0, 2)];
    if (pl.kind === 'zip') {
      // phase 2c: CDC PLACES by ZIP where published (2024 release, BRFSS 2022). No 95% range is held for ZIPs.
      const v = pl.zx && pl.zx.pl; if (!v) return notHeld(title, pl.zxErr ? 'the ZIP extras file is not on this device; save it in Data status' : 'not published for this ZIP');
      const cp = pl.county && pl.county.places;
      return table(title.replace(/2025/, '2024 release, by ZIP'), idx.map(i => { const [, lab] = meta.places[i]; const x = v[i];
        const c = cp && cp[i] !== null && cp[i] !== undefined ? cp[i].toFixed(1) + '%' : '–';
        return x === null || x === undefined ? `<tr><th>${esc(lab)}</th><td class="num muted">–</td><td></td><td></td><td class="small muted">${i < 3 ? 'not published for this ZIP (none in Pennsylvania or New York)' : 'not published for this ZIP'}</td></tr>`
          : `<tr><th>${esc(lab)}</th><td class="num">${x.toFixed(1)}%</td><td class="num muted small">no range held</td><td class="num muted">${c}<small> county, 2024</small></td><td><span class="pl-v plain"><b aria-hidden="true">~</b> modeled</span></td></tr>`; }).join(''))
        + note('CDC PLACES for the ZIP area, 2024 release (2022 survey year). The warehouse holds no 95% range for ZIPs, so read these as rough; the tract figures on district and tract cards carry their ranges.');
    }
    if (st === 'PA') return notHeld(title, 'Pennsylvania is missing from both CDC PLACES releases in the warehouse (2025 tract and 2024 county), so these rows are blank for every Pennsylvania tract, Philadelphia included. A ZIP lookup shows the ZIP-level PLACES release where published. Use the county Map the Meal Gap figure.');
    const cp = pl.county && pl.county.places;
    const rows = idx.map(i => {
      const [k, lab] = meta.places[i]; const vals = pl.rows.map(r => [r[pl.ci('pl_' + k)], r[pl.ci('pl_' + k + '_lo')], r[pl.ci('pl_' + k + '_hi')]]).filter(v => v[0] !== null && v[0] !== undefined);
      if (!vals.length) return `<tr><th>${esc(lab)}</th><td class="num muted">–</td><td></td><td></td><td class="small muted">${i < 3 ? 'blank in 11 states (CO, FL, KY, OR, PA, SD, TN, TX, VT, WA, WY) and for some tracts' : 'not modeled for these tracts'}</td></tr>`;
      const one = vals.length === 1; const lo = Math.min(...vals.map(v => v[0])), hi = Math.max(...vals.map(v => v[0]));
      const fig = one ? vals[0][0].toFixed(1) + '%' : `${lo.toFixed(1)}–${hi.toFixed(1)}%`;
      const ci = one && vals[0][1] !== null ? `95% range ${vals[0][1].toFixed(1)}–${vals[0][2].toFixed(1)}` : `range across ${vals.length} tracts`;
      const c = cp && cp[i] !== null && cp[i] !== undefined ? cp[i].toFixed(1) + '%' : '–';
      return `<tr><th>${esc(lab)}</th><td class="num">${fig}</td><td class="num muted small">${esc(ci)}</td><td class="num muted">${c}<small> county, 2024</small></td><td><span class="pl-v plain"><b aria-hidden="true">~</b> modeled</span></td></tr>`;
    }).join('');
    return table(title, rows);
  }

  function secHealth(pl) {
    const body = note('Six CDC PLACES measures, modeled from a phone survey (2023) and census data: shown as ranges, never quoted as counts. The other health measures stay at the desk.')
      + placesTable(pl, [3, 4, 5, 6, 7, 8], 'Health (CDC PLACES 2025, adults)');
    return sec('health', 'Health (small)', body);
  }

  // ---------------------------------------------------------------- phase 2b: jobs and commuting, transit, food extras
  const jobsFor = (st) => getFile(`places_jobs_${st}.json.gz`).then(f => f.data);
  const foodFor = (st) => getFile(`places_food_${st}.json.gz`).then(f => f.data);
  const foodZips = () => getFile('places_food_zips.json.gz').then(f => f.data);
  const transitFile = () => getFile('places_transit.json.gz').then(f => f.data);
  /** the selection transit is counted on: the corridor line (60 m, as the packets), the district boundary, the tracts, or the true circle */
  function transitSel(pl) {
    const a = pl.area;
    if (a && a.kind === 'district') return { kind: 'district', id: a.district_id, words: 'inside the district boundary' };
    const g = a && (a.pkt_line || (a.kind === 'corridor' ? a.line : null));
    if (g) return { kind: 'line', geom: g, words: 'within 60 m (200 ft) of the corridor line' };
    if (pl.kind === 'radius') return { kind: 'radius', lat: pl.center[0], lon: pl.center[1], r: pl.radius, words: `inside the true ${pl.radius.toLocaleString('en-US')} m circle` };
    if (pl.rows && pl.rows.length) return { kind: 'tracts', tracts: pl.rows.map(r => r[0]), words: pl.rows.length === 1 ? 'in this tract' : `in these ${pl.rows.length} tracts` };
    return null;
  }
  async function attachWork(pl) {
    pl.wk = { err: {} }; if (!WK) { pl.wk.err.all = 'phase 2b code not loaded'; return; }
    const W2 = pl.wk;
    if (pl.kind !== 'zip' && pl.rows && pl.rows.length) {
      const sts = [...new Set(pl.rows.map(r => ST_FIPS[r[0].slice(0, 2)]).filter(Boolean))];
      try {
        const files = {}; for (const st of sts) files[st] = await jobsFor(st);
        const ix = WK.jobsIndex(files); const pos = {}; const la = pl.ci('lat'), lo = pl.ci('lon');
        for (const r of pl.rows) if (r[la] !== null && r[la] !== undefined) pos[r[0]] = [r[la], r[lo]];
        const names = {}; for (const st of sts) { const T = P.tracts[st]; if (T) for (const [t, m] of Object.entries(T.meta)) if (m.n) names[t] = m.n; }
        W2.J = WK.jobsArea(ix, pl.rows.map(r => r[0]), pos, names);
        W2.cmpWac = WK.countyWac(ix, pl.cty);
        W2.day = W2.J ? WK.daytime(pl.W.pop_e, pl.W.pop_m, W2.J) : null;
      } catch (e) { W2.err.jobs = e.message || String(e); }
      try {
        const ids = pl.rows.map(r => r[0]); const F = {}; for (const st of sts) F[st] = await foodFor(st);
        const hist = Object.assign({}, ...Object.values(F).map(f => f.snap_hist)), gap = Object.assign({}, ...Object.values(F).map(f => f.gap));
        W2.snap = WK.snapHistory(hist, ids); W2.gap = WK.gapSum(gap, ids);
        const cmpIds = Object.keys(gap).filter(t => t.startsWith(pl.cty)); W2.gapCmp = WK.gapSum(gap, cmpIds);
        if (F.PA) {
          const set = new Set(ids); W2.wic = ids.flatMap(t => (F.PA.wic[t] || []));
          W2.cep = F.PA.cep.filter(c => set.has(c.t)); W2.cepUnplaced = F.PA.cep_unplaced; W2.wicStats = F.PA.wic_stats;
          // nearby: placed schools outside these tracts within 800 m of a tract outline (the outlines drawn on the map)
          const geo = await geoFor('PA'); W2.cepNear = [];
          if (geo) for (const c of F.PA.cep) { if (set.has(c.t) || c.la === null) continue; let d = Infinity;
            for (const t of ids) { const rings = geo[t]; if (!rings) continue; for (const ring of rings) { const f = ring[0]; const ln = []; for (let i = 0; i < f.length; i += 2) ln.push([f[i], f[i + 1]]); d = Math.min(d, WK.distToLine(c.la, c.lo, { type: 'LineString', coordinates: ln })); } }
            if (d <= 800) W2.cepNear.push(Object.assign({}, c, { dm: Math.round(d) })); }
          W2.cepNear.sort((a, b) => a.dm - b.dm);
        }
      } catch (e) { W2.err.food = e.message || String(e); }
    } else if (pl.kind === 'zip') {
      try {
        const Z = await foodZips(); W2.snap = WK.snapHistory(Z.snap_hist, [pl.zip]); W2.gap = WK.gapSum(Z.gap, [pl.zip]);
        try { const F = await foodFor(ST_FIPS[pl.cty.slice(0, 2)]); W2.gapCmp = WK.gapSum(F.gap, Object.keys(F.gap).filter(t => t.startsWith(pl.cty))); } catch (e) { W2.gapCmp = null; }
        W2.wicUnplacedZip = Z.wic_unplaced[pl.zip] || [];
        if (pl.zrec && pl.zrec.st === 'PA') { const F = await foodFor('PA'); W2.wic = Object.values(F.wic).flat().filter(x => x[3] === pl.zip); W2.wicStats = F.wic_stats; }
      } catch (e) { W2.err.food = e.message || String(e); }
    }
    const sel = transitSel(pl); W2.tsel = sel;
    if (sel) try {
      const T = await transitFile();
      const anyPhl = pl.rows && pl.rows.some(r => ['42101', '42045', '42091', '42017', '42029', '34007', '34005', '34015'].includes(r[0].slice(0, 5)));
      W2.septa = (anyPhl || (pl.area && pl.area.kind === 'district')) ? WK.septaSelect(T, sel) : null;
      W2.stations = WK.stationsSelect(T, sel, sel.kind === 'line' || sel.kind === 'radius' ? 800 : 0);
      W2.mbta = pl.rows && pl.rows.some(r => r[0].startsWith('25')) ? WK.mbtaBusSelect(T, sel) : null;
      W2.transitDocs = { septa: T.septa.season, mbta: T.mbta.doc, path: T.path.doc, mbtaPlaced: T.mbta.bus_placed_share };
    } catch (e) { W2.err.transit = e.message || String(e); }
  }
  // the table head hides when rows stack (iPad portrait, phone), so every 2b table carries a visible heading, as the 2a records tables do
  const tableH = (head, rows) => `<h4 class="pl-h4">${esc(head)}</h4>` + table(head, rows);
  const pctS = (x) => x === null || x === undefined ? '–' : (x * 100).toFixed(1) + '%';
  const yrRow = (o, ys, cls) => ys.map(y => `<span class="${cls || ''}">${y}: <b>${cnt(o[y] || 0)}</b></span>`).join(' · ');
  function cntyName(J, c) { return (J.countyNames && J.countyNames[c]) || c; }

  function secWork2(pl) {
    const W2 = pl.wk || { err: {} }; const J = W2.J; const M = P.meeting; let body = '';
    if (J && J.jobs !== null) {
      const cw = W2.cmpWac; const base = J.wac[0]; const cbase = cw ? cw[0] : null;
      const part = (lab, i) => `<tr><th>${esc(lab)}</th><td class="num">${pct1(J.wac[i] / base)}</td><td class="num muted">${cnt(J.wac[i])}</td><td class="num muted">${cbase ? pct1(cw[i] / cbase) : '–'}</td><td class="small muted">count; no survey margin</td></tr>`;
      body += tableH(`Jobs based here by earnings and age (LODES ${J.year || J.years.join(', ')})`, WK.EARN.map((e, k) => part('Earning ' + e, 4 + k)).join('') + WK.AGE.map((e, k) => part('Workers ' + e, 1 + k)).join(''))
        + note(`Shares of the ${cnt(base)} jobs based in these tracts; the comparator column is ${esc(pl.cw.label)}. Earnings are monthly pay on the job, before taxes. LODES counts jobs, not people: someone with two jobs counts twice; self-employed people are not counted.`);
      const wb = J.workBands, hb = J.homeBands;
      const top = (list, tot) => list.slice(0, 5).map(([c, n]) => `${esc(cntyName(J, c))} <b>${pct1(n / tot)}</b>`).join(' · ');
      const totW = wb ? wb.slice(0, 10).reduce((a, b) => a + b, 0) : 0;
      let rows = `<tr><th>Live within 5 km (3 miles)<small>of the tract where they work, center to center</small></th><td class="num">${pctS(WK.shareWithin(wb, 5))}</td><td></td><td></td><td class="small muted">count shares; LODES ${J.year || ''}</td></tr>`
        + `<tr><th>Live within 10 km (6 miles)</th><td class="num">${pctS(WK.shareWithin(wb, 10))}</td><td></td><td></td><td></td></tr>`
        + `<tr><th>Half live closer than</th><td colspan="4">${esc(WK.medianBand(wb) || '–')} <span class="muted small">(the median falls in this band)</span></td></tr>`
        + `<tr><th>Home counties</th><td colspan="4" class="small">${totW ? top(J.workerHomeCounties, totW) : '–'}</td></tr>`;
      const named = J.nearNeighborhoods.filter(([n]) => !n.startsWith('('));
      if (named.length && !M) rows += `<tr><th>Nearby home neighborhoods<small>homes within 5 km, where B+W holds a neighborhood name</small></th><td colspan="4" class="small">${named.slice(0, 5).map(([n, k]) => `${esc(n)} <b>${pct1(k / totW)}</b>`).join(' · ')}</td></tr>`;
      body += tableH(`Where the ${cnt(base)} people who work here live`, rows);
      const totH = hb ? hb.slice(0, 10).reduce((a, b) => a + b, 0) : 0;
      if (J.empRes !== null) {
        let r2 = `<tr><th>Employed residents<small>jobs held by people who live here</small></th><td class="num">${cnt(J.empRes)}</td><td></td><td></td><td class="small muted">LODES ${J.year || ''}</td></tr>`;
        if (J.pa && J.outOfState !== null) r2 += `<tr><th>Work outside Pennsylvania</th><td class="num">${cnt(J.outOfState)}</td><td></td><td></td><td class="small muted">${pct1(J.outOfState / J.empRes)} of employed residents; where, not held for 2024 (other states' 2024 files are not loaded)</td></tr>`;
        r2 += `<tr><th>Work within 5 km (3 miles)${J.pa ? '<small>of those working in Pennsylvania</small>' : ''}</th><td class="num">${pctS(WK.shareWithin(hb, 5))}</td><td></td><td></td><td></td></tr>`
          + `<tr><th>Work within 10 km (6 miles)</th><td class="num">${pctS(WK.shareWithin(hb, 10))}</td><td></td><td></td><td></td></tr>`
          + `<tr><th>Half work closer than</th><td colspan="4">${esc(WK.medianBand(hb) || '–')}</td></tr>`
          + `<tr><th>Work counties</th><td colspan="4" class="small">${totH ? J.residentWorkCounties.slice(0, 5).map(([c, n]) => `${esc(cntyName(J, c))} <b>${pct1(n / totH)}</b>`).join(' · ') : '–'}</td></tr>`;
        body += tableH('Where residents work', r2);
      }
      if (W2.day && !M) {
        const d = W2.day; const rough = d.value > 0 && d.moe90 / d.value > 0.30;
        // an estimate carries no "solid" verdict: it is marked as an estimate (rough when the residents' margin is over 30% of it)
        const v = rough ? { cls: 'rough', mark: '≈', word: 'rough estimate' } : { cls: 'plain', mark: '~', word: 'B+W estimate' };
        let r3 = `<tr class="pl-int"><th>Daytime population, B+W estimate<small>residents + jobs based here − employed residents</small></th><td class="num">${cnt(d.value)}</td><td class="num muted">${cntm(d.moe90)}</td><td></td><td>${vcell(v)}<span class="pl-tag">never quoted, never on a sheet</span></td></tr>`;
        r3 += `<tr class="pl-int"><th>From</th><td colspan="4" class="small">${cnt(d.residents)} residents (ACS 2020–24) + ${cnt(d.jobs)} jobs − ${cnt(d.empRes)} employed residents (LODES ${J.year || ''})</td></tr>`;
        if (d.inCommuters !== undefined) r3 += `<tr class="pl-int"><th>Commuting in and out</th><td colspan="4" class="small">${cnt(d.inCommuters)} come in to work · ${cnt(d.outCommuters)} leave to work · ${cnt(d.liveAndWork)} live and work here</td></tr>`;
        body += tableH('Daytime estimate (internal)', r3) + note(`Method: residents plus everyone whose job is based here, less residents who hold a job (wherever it is). People who live and work here cancel out, so this equals residents + in-commuters − out-commuters. ${d.inCommuters !== undefined ? 'The in and out counts are exact here: every tract of this area is within 5 km of the others, and B+W holds every flow between tracts that close.' : 'In and out counts are shown only where every tract of the area is within 5 km of the others (the flows held exactly).'} The ± is the survey margin on residents only; LODES has none. It mixes a survey (2020–24) with job records (${J.year || ''}), counts jobs rather than people, leaves out the self-employed, students and visitors: a B+W estimate, never a sheet figure.`);
      }
      if (J.missing.length) body += note(`${J.missing.length} tract${J.missing.length > 1 ? 's have' : ' has'} no LODES row and ${J.missing.length > 1 ? 'are' : 'is'} left out.`);
    } else if (pl.kind !== 'zip') body += notHeld('Where workers live and residents work', W2.err.jobs ? `the jobs file is not on this device (${whyFail({ message: W2.err.jobs })}); save it in Data status` : 'not held for these tracts');
    /* ZIP: the phase 1 "jobs based here" line above already says jobs are held by tract */
    body += transitBlock(pl);
    return body;
  }

  function transitBlock(pl) {
    const W2 = pl.wk || { err: {} }; const M = P.meeting; const sel = W2.tsel; let out = '';
    if (!sel) return '';
    if (W2.err.transit) return notHeld('Transit', `the transit file is not on this device (${whyFail({ message: W2.err.transit })}); save it in Data status`);
    const s = W2.septa;
    if (s) {
      const routes = [...s.busRoutes.map(r => r), ...s.trolleyRoutes].slice(0, 14).join(', ');
      const okSay = sel.kind === 'line' && s.gates.G3 === 'pass' && s.gates.G5 === 'pass' && s.gates.buffer === 'pass';
      const street = pl.area ? (pl.area.kind === 'packet' && !M ? pl.area.name : pl.area.name.split(' Business')[0].split(' Special')[0]) : '';
      const sayL = okSay ? `About ${C.round(s.ons, 100)} transit boardings at ${street} stops each weekday.` : '';
      let rows = `<tr><th>Weekday boardings, bus and trolley<small>SEPTA, ${esc(W2.transitDocs.septa)}; ${esc(sel.words)}</small></th><td class="num">${cnt(s.ons)}</td><td></td><td></td><td><span class="small muted">at ${cnt(s.stops)} stop${s.stops === 1 ? '' : 's'} (distinct stop codes) </span>${vcell({ cls: 'plain', mark: '·', word: 'count' })}${sel.kind === 'line' ? gateTag(s.gates.G3) + gateTag(s.gates.G5) + gateTag(s.gates.buffer) : ''}${sayL ? '<div>' + say(sayL) + '</div>' : ''}</td></tr>`
        + `<tr><th>By mode</th><td colspan="4" class="small">${[s.busStops ? `bus <b>${cnt(s.bus)}</b> at ${cnt(s.busStops)} stops` : '', s.trolleyStops ? `trolley <b>${cnt(s.trolley)}</b> at ${cnt(s.trolleyStops)} stops` : ''].filter(Boolean).join(' · ') || 'no stops'}${routes ? ` · routes ${esc(routes)}` : ''}</td></tr>`;
      if (sel.kind === 'line' && !M) rows += `<tr><th>Second path (CL-20)</th><td colspan="4" class="small">40 m: <b>${cnt(s.at40)}</b> · 60 m: <b>${cnt(s.ons)}</b> · 80 m: <b>${cnt(s.at80)}</b>${s.gates.buffer === 'pass' ? '' : ' · the figure depends on where the line is drawn'}</td></tr>`;
      if (!M) rows += `<tr><th>Busiest stop</th><td class="num">${cnt(s.topStop)}</td><td></td><td></td><td class="small muted">${pct1(s.topStopShare)} of the boardings</td></tr>`;
      out += tableH('Transit: boardings by stop', rows);
    }
    const st = W2.stations || { in: [], near: [] };
    const label = (x) => ({ rail_undated: 'SEPTA station (undated count)', regional_rail_2024: 'SEPTA Regional Rail, 2024', gated_fall2025: 'MBTA gated entries, fall 2025', commuter_rail_fall2024: 'MBTA commuter rail, fall 2024', path_2025: 'PATH entries, 2025' }[x.kind]);
    const stRow = (x, near) => `<tr><th>${esc(x.nm)}<small>${esc(x.ln || '')}${near ? ` · ${cnt(x.dist)} m away, not counted` : ''}</small></th><td class="num">${cnt(x.ons)}</td><td></td><td></td><td class="small muted">${esc(label(x))}</td></tr>`;
    if (st.in.length || st.near.length) out += tableH('Stations (listed beside the stops, never added to them)', st.in.map(x => stRow(x, false)).join('') + (M ? '' : st.near.slice(0, 6).map(x => stRow(x, true)).join('')))
      + note(`Stations ${esc(sel.words)} are counted here${sel.kind === 'line' || sel.kind === 'radius' ? '; stations within 800 m are listed as nearby' : ''}. Their counts come from other files and seasons than the stop counts${st.in.concat(st.near).some(x => x.kind === 'rail_undated') ? ' (the SEPTA station layer carries no date)' : ''}, so they are listed beside the stops and never added to them (CL-28).`);
    if (W2.mbta && (W2.mbta.stops || pl.rows.some(r => r[0].startsWith('25')))) out += tableH('MBTA bus (fall 2025)', `<tr><th>Weekday boardings at MBTA bus stops<small>${esc(sel.words)}; Monday to Thursday average</small></th><td class="num">${cnt(W2.mbta.ons)}</td><td></td><td></td><td class="small muted">at ${cnt(W2.mbta.stops)} stops · routes ${esc(W2.mbta.routes.slice(0, 10).join(', '))}</td></tr>`)
      + note(`MBTA stop locations come from OpenStreetMap, matched by stop id and name: ${Math.round((W2.transitDocs.mbtaPlaced || 0) * 100)}% of weekday bus boardings are placed; busway berths are placed at their station; the rest are left out, so this can undercount.`);
    if (!s && !st.in.length && !(W2.mbta && W2.mbta.stops)) out += notHeld('Transit', 'no SEPTA, MBTA or PATH stop or station held here (NJ Transit and the MTA are not loaded)');
    return out;
  }

  function snapHistBlock(pl) {
    const W2 = pl.wk || { err: {} }; const h = W2.snap; const M = P.meeting;
    if (!h) return note(W2.err.food ? `Store openings and closings: the food file is not on this device (${esc(whyFail({ message: W2.err.food }))}).` : '');
    if (!h.held) return notHeld('SNAP store openings and closings', 'no SNAP-authorized store has been recorded here since 2005');
    const Y = [2021, 2022, 2023, 2024, 2025]; const st = WK.steady(Y.map(y => h.open[y]));
    const yrsAll = []; for (let y = 2005; y <= 2025; y++) yrsAll.push(y);
    const decades = [2005, 2010, 2015, 2020, 2025];
    // CL-30 averages round to the ten; for counts this small that misstates them, so an average is offered only at 20 a year or more
    const avgW = st.steady && st.avg >= 20 ? `steady run: about ${cnt(st.avg10)} a year` : st.steady ? 'steady but small: list the years' : 'not a steady run: list the years, no yearly average';
    let rows = `<tr><th>Stores that began taking SNAP, by year<small>${avgW}</small></th><td colspan="4" class="small">${yrRow(h.open, Y)} · 2026 to Nov 13: <b>${cnt(h.open[2026])}</b></td></tr>`
      + `<tr><th>Of those, at the spot of a store that stopped<small>within six months; usually a change of owner</small></th><td colspan="4" class="small">${yrRow(h.openSame, Y)} · 2026: <b>${cnt(h.openSame[2026])}</b></td></tr>`;
    if (!M) rows += `<tr class="pl-int"><th>Stores that stopped taking SNAP, by year<small>internal: a closure count reads as a decline</small></th><td colspan="4" class="small">${yrRow(h.close, Y)} · 2026 to Nov 13: <b>${cnt(h.close[2026])}</b> · at the spot of a new store: ${Y.map(y => h.closeSame[y]).join(', ')}</td></tr>`
      + `<tr class="pl-int"><th>Stores taking SNAP on Dec 31<small>internal; counts only, no trend words</small></th><td colspan="4" class="small">${yrRow(h.yearEnd, decades)}</td></tr>`
      + `<tr><th>Openings, every year since 2005</th><td colspan="4" class="small">${yrsAll.map(y => `${y}: ${h.open[y]}`).join(' · ')}</td></tr>`
      + `<tr><th>Farmers markets<small>authorize by season; counted apart</small></th><td colspan="4" class="small">began ${Y.map(y => h.fmOpen[y]).join(', ')} (2021–25) · stopped ${Y.map(y => h.fmClose[y]).join(', ')}</td></tr>`;
    return tableH('SNAP store openings and closings (USDA)', rows) + note(`Counted ${pl.kind === 'zip' ? `by the stores' postal ZIP ${esc(pl.zip)}` : 'by the tract each store sits in'}, all store types but farmers markets; Restaurant Meals Program sites are left out (the history file does not carry them), which is why these do not add up to "open now" above. 2005–2025 from USDA's retailer history (authorization and end dates); 2026 by comparing that history with the Nov 13, 2026 file, so it has no dates within the year and no same point last year. Years are listed and never described as rising or falling.${h.reconciles ? '' : ' One store here sits in a different tract in the two files, so the history and the Nov 13 count differ by one or two.'}`);
  }

  function foodExtras(pl) {
    const W2 = pl.wk || { err: {} }; const M = P.meeting; let out = '';
    const g = W2.gap;
    if (g && g.share !== null && !M) {
      const cmp = W2.gapCmp && W2.gapCmp.share !== null ? { area: pl.cw.label, value: W2.gapCmp.share, moe90: W2.gapCmp.shareMoe } : null;
      const f = { id: 'x_gap', value: g.share, moe90: g.shareMoe, comparator: cmp, label: 'Below-poverty households not receiving SNAP', flags: { internal: true } };
      out += tableH('SNAP gap (survey; internal)', shareRow(f, pl, { internal: true, note: `${cnt(g.notReceiving)} ${cntm(g.notReceivingMoe)} of ${cnt(g.below)} ${cntm(g.belowMoe)} households below the poverty line; B22003` }))
        + note('What this is: households whose income was below the poverty line and that did not receive SNAP in the past 12 months, as a share of all households below the poverty line (Census table B22003, 2020–24). Every one of them meets SNAP\'s income test, but immigration status, student rules and assets can still bar some, and households between 100% and 200% of poverty that qualify under state rules are not counted. It is a survey share with its margin, not an estimate of eligible people: B+W does not estimate eligibility. Internal: it rests on poverty.');
    }
    if (W2.wic) {
      const list = W2.wic.slice(0, 10).map(x => `${esc(x[0])} <span class="muted">(${esc(x[1])})</span>`).join(' · ');
      out += tableH('WIC (Pennsylvania)', `<tr><th>SNAP stores that also take WIC<small>${pl.kind === 'zip' ? 'in the postal ZIP' : 'in these tracts'}; state WIC list, Nov 14, 2026</small></th><td class="num">${cnt(W2.wic.length)}</td><td></td><td></td><td class="small">${list || '<span class="muted">none</span>'}${W2.wic.length > 10 ? ' …' : ''}</td></tr>`
        + (W2.wicUnplacedZip && W2.wicUnplacedZip.length ? `<tr><th>WIC stores not matched to a SNAP store</th><td class="num">${W2.wicUnplacedZip.length}</td><td></td><td></td><td class="small">${W2.wicUnplacedZip.map(x => esc(x[0])).join(' · ')}</td></tr>` : ''))
        + (W2.wicStats ? note(`${cnt(W2.wicStats.state_list)} stores are on the state WIC list; ${cnt(W2.wicStats.matched_wic_stores)} matched a SNAP store and are placed by it. The other ${cnt(W2.wicStats.unmatched_wic_stores)} count on ZIP cards only.`) : '');
    }
    if (W2.cep) {
      const part = W2.cep.filter(c => c.cp), elig = W2.cep.filter(c => !c.cp && (c.el || c.ne));
      const en = part.reduce((a, c) => a + (c.en || 0), 0); const isp = part.map(c => c.isp).filter(x => x !== null);
      const nm = (c) => `${esc(c.n)}${c.isp !== null ? ` <span class="muted">${c.isp.toFixed(0)}%</span>` : ''}`;
      let rows = `<tr><th>Schools where every student eats free (CEP)<small>in these tracts; school year 2026–27</small></th><td class="num">${cnt(part.length)}</td><td></td><td></td><td class="small"><span class="muted">${cnt(en)} students enrolled · </span>${part.slice(0, 8).map(nm).join(' · ') || '<span class="muted">none placed here</span>'}${part.length > 8 ? ' …' : ''}</td></tr>`;
      if (isp.length) rows += `<tr><th>Identified-student share<small>students certified without an application (SNAP, TANF, foster)</small></th><td colspan="4">${isp.length > 1 ? `${Math.min(...isp).toFixed(0)}% to ${Math.max(...isp).toFixed(0)}%` : isp[0].toFixed(0) + '%'}</td></tr>`;
      if (elig.length) rows += `<tr><th>Eligible or near eligible, not taking part</th><td class="num">${cnt(elig.length)}</td><td></td><td></td><td class="small">${elig.slice(0, 6).map(nm).join(' · ')}</td></tr>`;
      if (W2.cepNear && W2.cepNear.length) rows += `<tr><th>Nearby (within 800 m of these tracts)</th><td class="num">${cnt(W2.cepNear.filter(c => c.cp).length)}</td><td></td><td></td><td class="small">${W2.cepNear.filter(c => c.cp).slice(0, 6).map(c => `${nm(c)} <span class="muted">${c.dm} m</span>`).join(' · ')}</td></tr>`;
      out += tableH('School meals (Pennsylvania)', rows) + note(`Pennsylvania Department of Education CEP list. Sites are placed by matching the school's name inside its district (NCES and City school locations); ${cnt(W2.cepUnplaced.participating)} participating sites statewide could not be placed (mostly Archdiocese, residential and suburban sites), so a count here can be short.`);
    }
    return out;
  }

  // ---------------------------------------------------------------- map (B+W geometry; street tiles optional)
  async function drawMap(pl) {
    const el = $('#plMap'); if (!el || !window.L) return;
    if (P.map) { P.map.remove(); P.map = null; }
    const m = P.map = L.map(el, { zoomControl: false, attributionControl: true, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(m);
    const layers = [];
    const sts = new Set(pl.rows.map(r => ST_FIPS[r[0].slice(0, 2)]));
    for (const st of sts) {
      const g = await geoFor(st); if (!g) continue;
      for (const r of pl.rows) { const rings = g[r[0]]; if (!rings) continue;
        for (const ring of rings) { const flat = ring[0]; const ll = []; for (let i = 0; i < flat.length; i += 2) ll.push([flat[i + 1], flat[i]]);
          layers.push(L.polygon(ll, { color: '#9C5B3A', weight: 1, fillColor: '#C9B391', fillOpacity: 0.35 }).bindTooltip(r[0])); } }
    }
    if (pl.area && pl.area.boundary) layers.push(L.geoJSON(pl.area.boundary, { style: { color: '#9C5B3A', weight: pl.area.line ? 1 : 3, dashArray: pl.area.line ? '4 3' : null, fill: true, fillOpacity: 0.05 } }));
    if (pl.area && pl.area.line) layers.push(L.geoJSON(pl.area.line, { style: { color: '#9C5B3A', weight: 4, lineCap: 'round' } }));
    else if (pl.area && pl.area.pkt_line) layers.push(L.geoJSON(pl.area.pkt_line, { style: { color: '#9C5B3A', weight: 4, lineCap: 'round' } }));
    // phase 2b: stations counted here (dark squares) and community-eligibility schools (open circles); markers do not change the map's extent
    const marks = [];
    if (pl.wk && pl.wk.stations) for (const x of pl.wk.stations.in) marks.push(L.circleMarker([x.la, x.lo], { radius: 5, color: '#2A1E16', weight: 2, fillColor: '#2A1E16', fillOpacity: 0.9 }).bindTooltip(`${x.nm}: ${Math.round(x.ons || 0).toLocaleString('en-US')} a weekday`));
    if (pl.wk && pl.wk.cep) for (const c of pl.wk.cep.filter(c => c.cp)) marks.push(L.circleMarker([c.la, c.lo], { radius: 4, color: '#5A4332', weight: 2, fill: true, fillColor: '#F2EBDC', fillOpacity: 1 }).bindTooltip(c.n + ' (school meals for all)'));
    if (pl.center) { layers.push(L.circle(pl.center, { radius: pl.radius, color: '#2A1E16', weight: 1, dashArray: '4 4', fill: false })); layers.push(L.circleMarker(pl.center, { radius: 6, color: '#fff', weight: 2, fillColor: '#2A1E16', fillOpacity: 1 })); }
    if (!layers.length && pl.rows.length) for (const r of pl.rows) { const la = r[pl.ci('lat')], lo = r[pl.ci('lon')]; if (la !== null) layers.push(L.circleMarker([la, lo], { radius: 5, color: '#9C5B3A' })); }
    // bounds before adding: a circle has no bounds until the map has a view (Leaflet), so use its own extent
    let bb = null;
    for (const l of layers) { const b = l instanceof L.Circle ? L.latLng(pl.center).toBounds(pl.radius * 2) : (l.getBounds ? l.getBounds() : L.latLngBounds([l.getLatLng(), l.getLatLng()])); bb = bb ? bb.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); }
    if (bb) m.fitBounds(bb, { padding: [12, 12], maxZoom: 15 });
    L.featureGroup(layers).addTo(m);
    if (marks.length) L.featureGroup(marks).addTo(m);
    if (pl.kind === 'zip' && pl.zrec) {
      // phase 2c: the ZIP outline (2020 ZCTA, simplified to 40 m)
      try { const st = pl.zrec.st; const g = P.zgeo[st] || (P.zgeo[st] = (await getFile(`places_zgeo_${st}.json.gz`)).data.g); const rings = g[pl.zip] || [];
        const zl = rings.map(ring => { const f = ring[0]; const ll = []; for (let i = 0; i < f.length; i += 2) ll.push([f[i + 1], f[i]]); return L.polygon(ll, { color: '#9C5B3A', weight: 2, fillColor: '#C9B391', fillOpacity: 0.3 }); });
        if (zl.length) { const fg = L.featureGroup(zl).addTo(m); m.fitBounds(fg.getBounds(), { padding: [12, 12], maxZoom: 15 }); }
        else el.insertAdjacentHTML('beforeend', '<p class="muted small" style="padding:10px">No outline held for this ZIP.</p>');
      } catch (e) { el.insertAdjacentHTML('beforeend', '<p class="muted small" style="padding:10px;position:relative;z-index:500">ZIP outline not on this device; save it in Data status.</p>'); }
    }
    setTimeout(() => m.invalidateSize(), 80);
  }

  // ---------------------------------------------------------------- data status
  const FILES_COMMON = ['places_meta.json.gz', 'places_areas.json.gz', 'places_counties.json.gz', 'places_phl.json.gz', 'places_zips.json.gz'].concat(PTS, ['places_food_zips.json.gz', 'places_transit.json.gz', 'places_countycard.json.gz', 'places_zipx.json.gz']);
  const stateFiles = (st) => [`places_tracts_${st}.json.gz`, `places_geo_${st}.json.gz`, `places_jobs_${st}.json.gz`, `places_food_${st}.json.gz`, `places_zgeo_${st}.json.gz`];
  const HOME_FILES = () => FILES_COMMON.concat(HOME.flatMap(stateFiles));
  /** saved state of one file against the list Drive holds now: 'current', 'older' (a newer file is in Drive) or 'missing' */
  async function fileState(f) {
    const rec = await X.idb.get('kv', 'places:' + f).catch(() => null);
    if (!rec) return { st: 'missing' };
    const want = P.expect[f];
    // an old record has no sha: it is compared after decrypting it
    let sha = rec.sha; if (!sha && want) { const loc = await readLocal(f).catch(() => null); sha = loc && loc.sha; }
    return { st: want && sha && sha !== want ? 'older' : (want && !sha ? 'older' : 'current'), t: rec.t, v: rec.v };
  }
  async function renderStatus() {
    const box = $('#placesStatus'); const meta = await metaFile().catch(() => null);
    // review 2a, defect 1: the meta itself and every home file are always listed, whatever an older meta says
    const files = [...new Set(['places_meta.json.gz', ...FILES_COMMON, ...(meta ? meta.files.map(f => f.file) : HOME.flatMap(stateFiles))])];
    const rows = []; let older = 0;
    for (const f of files) {
      const fs = await fileState(f); const info = meta && meta.files.find(x => x.file === f);
      if (fs.st === 'older') older++;
      const cell = fs.st === 'missing' ? '<span class="pl-tag">not saved</span>' : fs.st === 'older' ? `<span class="pl-tag">older copy, saved ${fdate(fs.t)}: re-download</span>` : `saved ${fdate(fs.t)}`;
      rows.push(`<tr><th>${esc(f.replace(/^places_|\.json\.gz$/g, ''))}</th><td>${cell}</td><td class="num muted">${info ? (info.bytes / 1e6).toFixed(1) + ' MB' : ''}</td></tr>`);
    }
    const src = devSrc() ? `developer folder (${esc(devSrc())})` : (X.S.cfg.url ? 'B+W backend (Google Drive)' : 'no backend set');
    box.innerHTML = `<p class="small">Files built ${esc(meta ? meta.built : '?')}${meta && meta.rev ? ` · revision ${esc(meta.rev)}` : ''} · source: ${src} · ${navigator.onLine ? 'online' : '<b>offline</b>'}${older ? ` · <b>${older} saved file${older > 1 ? 's are' : ' is'} older than Drive</b>` : ''}</p>
      <div class="pl-row"><button class="btn" id="plHome">Save home pack (PA, NJ, DE, Philadelphia records)</button></div>
      <div class="pl-row">${['MA', 'RI', 'CT', 'NY', 'MD'].map(s => `<button class="btn ghost" data-trip="${s}">Save ${s}</button>`).join('')}</div>
      <div class="pl-row"><button class="btn ghost" id="plRefresh">Re-download everything saved</button></div>
      <div class="pl-tw"><table class="pl-t pl-files"><tbody>${rows.join('')}</tbody></table></div>
      <p class="muted small">iPhones and iPads can clear saved files when storage runs low. Check this list before leaving Wi-Fi.</p>`;
    $('#plHome').onclick = () => savePack(HOME_FILES());
    box.querySelectorAll('[data-trip]').forEach(b => b.onclick = () => savePack(stateFiles(b.dataset.trip)));
    // every saved file, the meta first (so the list is current), then the rest
    $('#plRefresh').onclick = async () => { const saved = ['places_meta.json.gz']; for (const f of files) if (f !== 'places_meta.json.gz' && await haveLocal(f)) saved.push(f); await savePack(saved, true); };
  }
  async function savePack(files, refresh = false) {
    let ok = 0, bad = [];
    for (const f of files) { X.toast(`Saving ${f.replace(/^places_|\.json\.gz$/g, '')}…`); try { await getFile(f, { refresh }); ok++; } catch (e) { bad.push(f + ': ' + whyFail(e)); } }
    X.toast(bad.length ? `Saved ${ok}; ${bad.length} failed` : `Saved ${ok} file${ok === 1 ? '' : 's'}`);
    if (bad.length) console.warn(bad);
    // forget everything parsed from the old copies, the meta and the areas included (review 2a, defect 1)
    for (const n of Object.keys(P.mem)) delete P.mem[n];
    P.tracts = {}; P.geo = {}; P.zgeo = {}; P.cmpCache = {}; P.rec = null; P.metaFresh = false;
    try { P.metaCache = await freshMeta(); } catch (e) { }
    renderStatus();
  }

  // ---------------------------------------------------------------- phase 2c: county card (design 3.1 item 6, 3.8; section 4 keep lists)
  const countyCardFile = () => getFile('places_countycard.json.gz').then(f => f.data);
  const MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pctV = (x, d = 1) => x === null || x === undefined ? '–' : Number(x).toFixed(d) + '%';
  const signed = (x) => x === null || x === undefined ? '–' : (x > 0 ? '+' : '') + Number(x).toFixed(1) + '%';
  async function openCounty(cty) {
    const root = $('#placesCard'); P.view = 'county'; P.countyId = cty;
    root.innerHTML = '<div class="card"><p class="muted">Loading the county card…</p></div>';
    let K, counties;
    try { K = await countyCardFile(); counties = await countiesFile(); } catch (e) { root.innerHTML = `<div class="card"><b>County card not on this device.</b><p class="muted small">${esc(whyFail(e))}</p></div>`; return; }
    const c = K.counties[cty]; const nm = (counties[cty] || {}).name || cty; const M = P.meeting;
    const back = P.place ? `<button class="btn ghost" id="plBack">Back to ${esc(P.place.name || 'the place')}</button>` : '';
    if (!c) {
      root.innerHTML = `<div class="card pl-head"><div class="eyebrow">County</div><h2>${esc(nm)}</h2><p class="muted small">${cty.startsWith('09') ? 'Connecticut: the 2024 survey uses the 2022 planning regions, while the county sources (QCEW, LAUS, CRA, the Food Environment Atlas, the farm census) are held by the old counties. Not matched in this build.' : 'Not held for this county.'}</p>${back}</div>`;
      if (back) $('#plBack').onclick = () => { P.view = 'place'; render(P.place); };
      return;
    }
    const secs = (c.sectors || []).filter(x => x.est || x.emp).sort((a, b) => (b.emp || 0) - (a.emp || 0));
    const shown = secs.filter(x => x.emp !== null).reduce((a, x) => a + x.emp, 0); const withheld = secs.filter(x => x.emp === null).length;
    let econ = tableH(`Private employment and pay by sector (BLS QCEW, ${c.qcew_year} annual average)`, secs.map(x => `<tr><th>${esc(x.nm)}<small>NAICS ${esc(x.n)} · ${cnt(x.est)} establishments</small></th><td class="num">${x.emp === null ? '<span class="muted">withheld</span>' : cnt(x.emp)}</td><td class="num muted">${x.pay ? usd(x.pay) : ''}</td><td></td><td class="small muted">${x.emp === null ? 'BLS withholds this sector to protect single employers' : `jobs · average annual pay${x.emp_yoy === null || x.emp_yoy === undefined ? '' : ` · jobs against a year earlier: ${signed(x.emp_yoy)}`}`}</td></tr>`).join(''))
      + note(`Each row: jobs, average annual pay, and jobs against the year before (counts from records, no margin). The sectors shown add to ${cnt(shown)} private jobs${withheld ? `; ${withheld} sector${withheld > 1 ? 's are' : ' is'} withheld, so the total is higher` : ''}. Changes are listed, never described as rising or falling.`);
    const lm = c.laus_month, la = c.laus_year || [];
    econ += tableH('Unemployment (BLS LAUS, county, not seasonally adjusted)', (lm && lm.ur !== null ? `<tr><th>Latest month<small>${MONTHS_S[(lm.m || 1) - 1]} ${lm.y}</small></th><td class="num">${pctV(lm.ur)}</td><td></td><td></td><td class="small muted">one month; seasonal swings are not removed</td></tr>` : '')
      + la.map(a => `<tr><th>${a.y} average</th><td class="num">${pctV(a.ur)}</td><td></td><td></td><td class="small muted">labor force ${cnt(a.lf)}</td></tr>`).join(''));
    const cr = c.cra;
    if (cr && cr.n) econ += tableH(`Bank small-business lending (CRA, ${cr.y})`, `<tr><th>Small-business loans originated</th><td class="num">${cnt(cr.n)}</td><td></td><td></td><td class="small muted">${cr.usd >= 1e7 ? C.usdBig(cr.usd) : usd(cr.usd)} · average ${usd(cr.avg)}</td></tr>`
      + `<tr><th>Under $100,000</th><td class="num">${cnt(cr.n100)}</td><td></td><td></td><td class="small muted">${pctV(cr.n100 / cr.n * 100)} of loans</td></tr>`
      + `<tr><th>To firms with revenue of $1 million or less</th><td class="num">${pctV(cr.psr * 100)}</td><td></td><td></td><td class="small muted">${cnt(cr.nsr)} loans</td></tr>`
      + `<tr><th>In low- or moderate-income tracts</th><td class="num">${pctV(cr.plmi * 100)}</td><td></td><td></td><td class="small muted">${cnt(cr.nlow)} low, ${cnt(cr.nmod)} moderate</td></tr>`)
      + note('CRA reports cover banks that must report (larger banks); loans by credit unions, small banks and online lenders are not in it. County level only.');
    const o = c.own;
    if (o && o.firms) {
      const row = (lab, a, b) => `<tr><th>${esc(lab)}</th><td class="num">${pctV(a)}</td><td></td><td></td><td class="small muted">of employer firms · nonemployer firms: ${pctV(b)}</td></tr>`;
      econ += tableH(`Business ownership (${o.y}): employer firms ${cnt(o.firms)}, nonemployer firms ${cnt(o.ne_firms)}`, row('Women-owned', o.fem, o.ne_fem) + row('Minority-owned', o.min, o.ne_min) + row('Black-owned', o.blk, o.ne_blk) + row('Hispanic-owned', o.hsp, o.ne_hsp) + row('Asian-owned', o.asn, o.ne_asn) + `<tr><th>Veteran-owned</th><td class="num">${pctV(o.vet)}</td><td></td><td></td><td class="small muted">of employer firms</td></tr>`)
        + note('Shares of firms whose owners are classified (Census Annual Business Survey for employer firms; Nonemployer Statistics by Demographics for firms with no employees). County level only. The dashboard\'s "scaling gap" ratios are not carried: the warehouse view does not say how they are formed.');
    }
    const mmg = (counties[cty] || {}).mmg && counties[cty].mmg['2024'];
    let food = mmg ? tableH('Food insecurity (Feeding America, Map the Meal Gap 2024)', `<tr><th>All ages</th><td class="num">${pct1(mmg[0])}</td><td></td><td></td><td class="small muted">about ${cnt(mmg[1])} people · modeled, no margin</td></tr><tr><th>Children</th><td class="num">${pct1(mmg[2])}</td><td></td><td></td><td></td></tr><tr><th>Cost per meal</th><td class="num">${mmg[3] ? '$' + mmg[3].toFixed(2) : '–'}</td><td></td><td></td><td></td></tr>`) : '';
    const fe = c.fe;
    if (fe && fe.src) {
      const r = (lab, n, k) => `<tr><th>${esc(lab)}</th><td class="num">${cnt(n)}</td><td></td><td></td><td class="small muted">${k !== null && k !== undefined ? Number(k).toFixed(2) + ' per 1,000 residents' : ''}</td></tr>`;
      food += tableH('Food environment (USDA ERS Food Environment Atlas, 2025 release)', r('Grocery stores', fe.gro, fe.gro_k) + r('Supercenters and club stores', fe.sup) + r('Convenience stores', fe.conv, fe.conv_k) + r('Specialty food stores', fe.spec) + r('Dollar stores', fe.dol, fe.dol_k)
        + r('SNAP-authorized stores', fe.snap, fe.snap_k) + r('WIC-authorized stores', fe.wic) + r('Fast-food restaurants', fe.ff, fe.ff_k) + r('Full-service restaurants', fe.fs, fe.fs_k) + r('Food banks', fe.fb)
        + `<tr><th>SNAP benefits per person, a month</th><td class="num">${fe.snap_pc ? '$' + Number(fe.snap_pc).toFixed(2) : '–'}</td><td></td><td></td><td></td></tr>`)
        + note('The Atlas carries each measure with its own reference year, most of them earlier than the release; the SNAP store count here is the Atlas\'s, not the Nov 13, 2026 USDA file the place cards use.');
    }
    const ag = c.ag;
    if (ag && ag.farms !== null && ag.farms !== undefined) food += tableH(`Farms (USDA Census of Agriculture ${ag.y})`, `<tr><th>Farms</th><td class="num">${cnt(ag.farms)}</td><td></td><td></td><td class="small muted">${cnt(ag.acres)} acres in farms · ${ag.sales >= 1e7 ? C.usdBig(ag.sales) : usd(ag.sales)} in sales</td></tr><tr><th>Farms selling directly to people</th><td class="num">${cnt(ag.fdirect)}</td><td></td><td></td><td class="small muted">${pctV(ag.pdirect)} of farms · ${usd(ag.direct)} direct sales (${pctV(ag.sdirect)} of sales)</td></tr>`);
    root.innerHTML = `<div class="card pl-head"><div class="eyebrow">County card</div><h2>${esc(nm)}</h2><p class="small">The county's economy and its food environment. Counts from records and models, not survey figures: no margins, and nothing here is a sheet figure.</p>${back}</div>`
      + sec('cty-econ', 'The county economy', econ) + (M === 'district' ? '' : sec('cty-food', 'County food environment', food || notHeld('County food', 'not held for this county')));
    if (back) $('#plBack').onclick = () => { P.view = 'place'; render(P.place); };
  }

  // ---------------------------------------------------------------- phase 2c: address search (backend; Philadelphia also from the saved parcels)
  const looksAddress = (q) => /^\s*\d+[A-Za-z]?(?:\s*-\s*\d+)?\s+[A-Za-z0-9]/.test(q) && /[A-Za-z]{2,}/.test(q) && !/^\d{5}$/.test(q.trim());
  /** a light copy of the builder's normalizer for typed addresses (numbered streets, direction words, street types) */
  function addrParts(q) {
    let a = q.toUpperCase().split(',')[0].replace(/[.#]/g, ' ').replace(/\s+/g, ' ').trim();
    a = a.replace(/\bSTREET\b/g, 'ST').replace(/\bAVENUE\b|\bAV\b/g, 'AVE').replace(/\bROAD\b/g, 'RD').replace(/\bBOULEVARD\b/g, 'BLVD').replace(/\bLANE\b/g, 'LN').replace(/\bDRIVE\b/g, 'DR').replace(/\bPLACE\b/g, 'PL');
    a = a.replace(/\b(PHILADELPHIA|PHILA|PA)\b.*$/, '').trim();
    const m = a.match(/^(\d+)[A-Z]?(?:\s*-\s*\d+[A-Z]?)?\s+(.*)$/); if (!m) return null;
    let st = m[2].replace(/^(NORTH|SOUTH|EAST|WEST) (?!(ST|AVE)$)/, (x, d) => d[0] + ' ').replace(/\b0*(\d+)\s?(ST|ND|RD|TH)\b(?= |$)/g, (x, n) => n + ({ 1: 'ST', 2: 'ND', 3: 'RD' }[n % 100 >= 11 && n % 100 <= 13 ? 0 : n % 10] || 'TH'));
    st = st.replace(/\s(?:\d+(?:ST|ND|RD|TH)\s)?(?:STE|SUITE|FL|FLOOR|UNIT|APT|REAR)\b.*$/, '').trim();
    if (/^SOUTH ST$/.test(st)) st = 'S ST';
    return { hn: +m[1], st };
  }
  async function localPhl(q) {
    const a = addrParts(q); if (!a) return null;
    const files = await Promise.all(PTS.map(haveLocal)); if (files.some(x => !x) && !navigator.onLine && !devSrc()) return null;
    let R; try { R = await recordsSet(); } catch (e) { return null; }
    const ids = RC.streetIds(R, a.st); if (!ids.size) return null;
    const Ly = R.L.parcels, c = Ly.c; const bs = new Map();
    for (let i = 0; i < Ly.n; i++) { if (!ids.has(c.st[i]) || c.y[i] === null) continue; const h = c.hn[i]; if (!h) continue; (bs.get(c.st[i]) || bs.set(c.st[i], []).get(c.st[i])).push(i); }
    const hits = [];
    for (const [sid, list] of bs) {
      let best = null;
      for (const i of list) { const d = Math.abs(c.hn[i] - a.hn); if (c.hn[i] % 2 === a.hn % 2 && d <= 30 && (!best || d < best.d)) best = { d, i }; }
      if (best) hits.push({ lat: 39.8 + c.y[best.i] / 1e5, lon: -75.3 + c.x[best.i] / 1e5, matched: `${a.hn} ${titleSt(R.streets[sid])}, Philadelphia`, exact: best.d === 0, near: best.d });
    }
    return hits.length ? hits.sort((x, y) => x.near - y.near) : null;
  }
  async function findAddress(q) {
    const box = $('#placesHere'); box.innerHTML = '<p class="muted small">Looking up the address…</p>';
    let hits = null, source = '';
    const phlish = !/,\s*(?!PHILADELPHIA|PHILA)[A-Z]/i.test(q) || /PHILA|\b191\d\d\b/i.test(q);
    if (phlish) { hits = await localPhl(q).catch(() => null); if (hits) source = 'the City property file saved on this device (OPA parcels)'; }
    if (!hits) {
      if (!navigator.onLine) { box.innerHTML = '<p class="muted small">No signal: an address outside the saved Philadelphia property file needs the backend. Use Here or a district instead.</p>'; return; }
      try {
        const r = await X.api('placesGeocode', { q }, 30000);
        if (r && r.hits && r.hits.length) { hits = r.hits; source = r.source; }
      } catch (e) { box.innerHTML = `<p class="muted small">Address lookup failed: ${esc(e.message === 'unknown_action' ? 'the backend has not been updated for address search yet (placesGeocode)' : whyFail(e))}.</p>`; return; }
    }
    if (!hits) { box.innerHTML = '<p class="muted small">Address not found. Check the number and street, or add the town and state.</p>'; return; }
    const pick = (h) => { P.addrPin = { lat: h.lat, lon: h.lon, label: h.matched, source };
      box.innerHTML = `<div class="eyebrow">Around ${esc(h.matched)}</div><p class="muted small">Located from ${esc(source)}${h.exact === false ? ` (nearest number on the same side, ${h.near} away)` : ''}.</p><div class="pl-row">${[400, 805, 1600].map(r => `<button class="btn${r === P.radius ? ' primary' : ''}" data-arad="${r}">${{ 400: '400 m · ¼ mi', 805: '805 m · ½ mi', 1600: '1,600 m · 1 mi' }[r]}</button>`).join('')}</div>`;
      box.querySelectorAll('[data-arad]').forEach(b => b.onclick = () => { P.radius = +b.dataset.arad; radius(h.lat, h.lon, P.radius, { t: Date.now(), acc: 0, label: h.matched }); });
      radius(h.lat, h.lon, P.radius, { t: Date.now(), acc: 0, label: h.matched }); };
    if (hits.length === 1) return pick(hits[0]);
    box.innerHTML = `<div class="eyebrow">Which one?</div><div class="list tight">${hits.slice(0, 5).map((h, i) => `<div class="item" data-h="${i}"><span class="txt"><b>${esc(h.matched)}</b></span></div>`).join('')}</div>`;
    box.querySelectorAll('[data-h]').forEach(el => el.onclick = () => pick(hits[+el.dataset.h]));
  }

  // ---------------------------------------------------------------- phase 2c: side by side (internal; hidden in meeting mode)
  const pinKey = (pl) => pl.id || (pl.zip ? 'zip:' + pl.zip : (pl.tracts || []).join(','));
  function loadPins() { try { return JSON.parse(ls.get('places_pins') || '[]').slice(0, 2); } catch (e) { return []; } }
  function pinDesc(pl) { return { id: pinKey(pl), kind: pl.kind, name: pl.name || (pl.zip ? 'ZIP ' + pl.zip : 'Selected tracts'), zip: pl.zip, tracts: pl.kind === 'zip' ? null : pl.rows.map(r => r[0]), area: pl.area ? { id: pl.area.id } : null,
    radius: pl.radius, center: pl.center }; }
  function pinsUi() { const b = $('#plCmpBtn'); if (b) { b.hidden = !!P.meeting || P.pins.length < 2; b.textContent = `Side by side (${P.pins.length})`; } }
  function togglePin(pl) {
    const k = pinKey(pl); const i = P.pins.findIndex(x => x.id === k);
    if (i >= 0) P.pins.splice(i, 1); else { P.pins.push(pinDesc(pl)); if (P.pins.length > 2) P.pins.shift(); }
    ls.set('places_pins', JSON.stringify(P.pins)); pinsUi(); X.toast(i >= 0 ? 'Unpinned' : `Pinned (${P.pins.length} of 2)`);
    const b = $('#plPin'); if (b) b.textContent = i >= 0 ? 'Pin for side by side' : 'Pinned';
  }
  async function buildPinned(d) {
    let pl;
    if (d.kind === 'zip') pl = await fromZip(d.zip);
    else { let area = null; if (d.area) area = (await areasFile()).find(x => x.id === d.area.id) || null;
      pl = await fromTracts({ kind: d.kind, id: d.id, name: d.name, tracts: area ? area.tracts : d.tracts, area, radius: d.radius, center: d.center }); }
    await attachRecords(pl); return pl;
  }
  async function showCompare() {
    if (P.meeting || P.pins.length < 2) return;
    const root = $('#placesCard'); P.view = 'compare'; root.innerHTML = '<div class="card"><p class="muted">Building the side-by-side view…</p></div>';
    let A, B; try { [A, B] = [await buildPinned(P.pins[0]), await buildPinned(P.pins[1])]; } catch (e) { root.innerHTML = `<div class="card"><b>Couldn't build the view.</b><p class="muted small">${esc(whyFail(e))}</p></div>`; return; }
    const ta = new Set((A.rows || []).map(r => r[0])); const shared = (B.rows || []).filter(r => ta.has(r[0])).length;
    const indep = !shared && A.kind !== 'zip' && B.kind !== 'zip';
    const test = (fa, fb) => {
      if (!fa || !fb || fa.value === null || fb.value === null || fa.value === undefined || fb.value === undefined) return '';
      if (!indep) return '<span class="muted small">no test: the two areas overlap or one is a ZIP</span>';
      const d = Math.abs(fa.value - fb.value), m = C.rss(fa.moe90 || 0, fb.moe90 || 0);
      return d > m ? '<span class="pl-v solid"><b aria-hidden="true">≠</b> differ beyond the two margins</span>' : '<span class="pl-v inside"><b aria-hidden="true">=</b> inside the margins: don\'t quote a difference</span>';
    };
    const sh = (f) => !f || f.value === null || f.value === undefined ? '–' : `${pct1(f.value)} <span class="muted small">${pts1(f.moe90)}</span>`;
    const ct = (f, money) => !f || f.value === null || f.value === undefined ? '–' : `${money ? C.usdBig(f.value) : cnt(f.value)} <span class="muted small">${f.moe90 !== null && f.moe90 !== undefined ? (money ? '±' + C.usdBig(f.moe90).replace(/^\$/, '$') : cntm(f.moe90)) : ''}</span>`;
    const rows = [['Residents', ct(A.figs.res_wa), ct(B.figs.res_wa), test(A.figs.res_wa, B.figs.res_wa)], ['Households', ct(A.figs.hh_wa), ct(B.figs.hh_wa), test(A.figs.hh_wa, B.figs.hh_wa)],
      ['Total household income', ct(A.figs.agg_income, true), ct(B.figs.agg_income, true), test(A.figs.agg_income, B.figs.agg_income)]];
    for (const [k, lab] of [['trait_born_abroad', 'Born in another country'], ['trait_lang_other', 'Language other than English'], ['trait_u18', 'Under 18'], ['trait_a1824', '18 to 24'], ['trait_a65', '65 and over'],
      ['trait_renters', 'Renter households'], ['trait_no_car', 'Households with no car'], ['trait_transit_walk', 'Transit or walk to work'], ['x_snap', 'Households receiving SNAP'], ['x_ba', "Bachelor's degree or more"]])
      rows.push([lab, sh(A.figs[k]), sh(B.figs[k]), test(A.figs[k], B.figs[k])]);
    const jobs = (pl) => pl.figs.jobs && pl.figs.jobs.value !== null ? cnt(pl.figs.jobs.value) : '–';
    rows.push(['Jobs based here (LODES)', jobs(A), jobs(B), '<span class="muted small">counts</span>']);
    const rec = (pl, f) => pl.rec ? f(pl.rec) : '<span class="muted small">not held</span>';
    const floorOf = (pl) => pl.rec && pl.rec.sel.kind !== 'addr' ? 'at least ' : '';
    rows.push(['City permits, 2021–25', rec(A, r => r.permits ? cnt(r.permits.five) : '–'), rec(B, r => r.permits ? cnt(r.permits.five) : '–'), '<span class="muted small">counts at each area\'s own rule</span>']);
    rows.push(['Active City food licenses', rec(A, r => r.licenses ? cnt(r.licenses.food_active) : '–'), rec(B, r => r.licenses ? cnt(r.licenses.food_active) : '–'), '']);
    rows.push(['SBA-backed loans since FY2020', rec(A, r => r.loans ? floorOf(A) + cnt(r.loans.n_since_fy2020) : '–'), rec(B, r => r.loans ? floorOf(B) + cnt(r.loans.n_since_fy2020) : '–'), '']);
    rows.push(['SNAP stores open now', cnt(storeRows(A).n || 0), cnt(storeRows(B).n || 0), '']);
    const head = (pl) => `${esc(pl.name || (pl.zip ? 'ZIP ' + pl.zip : 'Selected tracts'))}<small>${pl.kind === 'zip' ? 'ZIP' : `${pl.rows.length} tract${pl.rows.length === 1 ? '' : 's'}`} · against ${esc(pl.cw.label)}</small>`;
    root.innerHTML = `<div class="card pl-head"><div class="eyebrow">Side by side · internal</div><h2>${esc(A.name || 'A')} and ${esc(B.name || 'B')}</h2>
      <p class="small">Two pinned places. A difference is called only where the two areas share no tract and the gap is larger than the two margins combined (the packets' inside-the-margin rule, applied between two places). Records are counted at each area's own rule (address, boundary, tracts or circle), so they are listed, never tested. Hidden in meeting mode.${shared ? ` <b>These areas share ${shared} tract${shared > 1 ? 's' : ''}:</b> no test is made.` : ''}</p>
      <div class="pl-row"><button class="btn ghost" id="plUnpinAll">Clear pins</button></div></div>`
      + `<section class="card pl-sec"><h4 class="pl-h4">Side by side</h4><div class="pl-tw"><table class="pl-t pl-cmp"><thead><tr><th>Measure</th><th>${head(A)}</th><th>${head(B)}</th><th>Test</th></tr></thead><tbody>${rows.map(r => `<tr><th>${esc(r[0])}</th><td class="num"><span class="pl-cl">${esc(A.name || 'A')}: </span>${r[1]}</td><td class="num"><span class="pl-cl">${esc(B.name || 'B')}: </span>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody></table></div></section>`;
    $('#plUnpinAll').onclick = () => { P.pins = []; ls.set('places_pins', '[]'); pinsUi(); P.view = 'place'; if (P.place) render(P.place); else root.innerHTML = ''; };
  }

  // ---------------------------------------------------------------- shell
  function shell(root) {
    root.innerHTML = `
      <div class="card search pl-find">
        <div class="row"><input id="plQ" type="search" placeholder="District, corridor, ZIP, tract or neighborhood" autocomplete="off" autocapitalize="none" enterkeyhint="search" aria-label="Find a place">
          <button id="plHereBtn" class="btn">Here</button></div>
        <div id="plResults" class="list tight"></div>
        <div id="placesHere"></div>
        <div class="row between pl-tools"><label class="small">Meeting mode <select id="plMeeting" aria-label="Meeting mode">
            <option value="">off</option><option value="district">district meeting</option><option value="food">food-access meeting</option></select>
            <span class="muted">(figures, margins and verdicts only)</span></label>
          <span><button id="plCmpBtn" class="link small" hidden>Side by side</button> <button id="plStatusBtn" class="link small">Data status</button></span></div>
        <div id="placesStatus" hidden></div>
      </div>
      <div id="placesCard"><div class="card"><p class="muted">Type a district or corridor (Mayfair, Frankford), a ZIP (19149), a Philadelphia neighborhood or tract number, or tap <b>Here</b>.</p></div></div>`;
    let tm; $('#plQ').oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => runSearch(e.target.value), 180); };
    $('#plQ').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(e.target.value, true); } };
    $('#plHereBtn').onclick = here;
    $('#plMeeting').value = P.meeting; $('#plMeeting').onchange = (e) => {
      P.meeting = e.target.value; ls.set('places_meeting', P.meeting);
      $('#plResults').innerHTML = '';                                  // results may carry organization names
      $('#placesStatus').hidden = true; $('#plStatusBtn').hidden = !!P.meeting; pinsUi();
      if (P.view === 'county' && P.countyId) openCounty(P.countyId); else if (P.view === 'compare') { if (P.meeting) { P.view = 'place'; if (P.place) render(P.place); } else showCompare(); } else if (P.place) render(P.place);
    };
    $('#plStatusBtn').hidden = !!P.meeting; pinsUi();
    $('#plCmpBtn').onclick = () => showCompare();
    $('#plStatusBtn').onclick = () => { const b = $('#placesStatus'); b.hidden = !b.hidden; if (!b.hidden) renderStatus(); };
  }
  async function runSearch(q, first) {
    const box = $('#plResults'); const res = await search(q);
    if (first && res.length && res[0].go) { box.innerHTML = ''; return res[0].go(); }
    box.innerHTML = res.map((r, i) => `<div class="item" data-i="${i}"><span class="txt"><b>${esc(r.label)}</b><div><small>${esc(r.type)} · ${esc(r.sub || '')}</small></div></span><span class="pill">${esc(r.type)}</span></div>`).join('')
      || (q ? '<p class="muted small">Nothing matches. Try a ZIP, a street or district name, or a Philadelphia neighborhood.</p>' : '');
    box.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { const r = res[+el.dataset.i]; box.innerHTML = ''; if (r.go) r.go(); });
  }

  // The shell is built once; the rest runs on every open until it succeeds, so a failed first load (no signal, backend not
  // yet updated, a timeout) never leaves the tab dead until the app restarts (review defect 2).
  async function open(ctx) {
    X = ctx; const root = document.getElementById('placesRoot');
    if (!P.started) { P.started = true; const m = ls.get('places_meeting'); P.meeting = m === '1' ? 'district' : (m === 'district' || m === 'food') ? m : ''; P.pins = loadPins(); shell(root); }
    if (P.ready || P.opening) return;
    P.opening = true;
    try {
      try { P.metaCache = await freshMeta(); }
      catch (e) {
        $('#placesCard').innerHTML = `<div class="card"><b>Places files are not on this device yet.</b><p class="muted small">${esc(whyFail(e))}</p><div class="pl-row"><button class="btn" id="plRetry">Try again</button></div></div>`;
        $('#plRetry').onclick = () => open(X);
        return;
      }
      try { P.phl = (await getFile('places_phl.json.gz')).data; } catch (e) { P.phl = null; }
      P.ready = true;
      $('#placesCard').innerHTML = `<div class="card"><p class="muted">Type a district or corridor (Mayfair, Frankford), a ZIP (19149), a Philadelphia neighborhood or tract number, or tap <b>Here</b>.</p></div>`;
      const last = ls.get('places_last');
      if (last) { try { const l = JSON.parse(last); if (l.kind === 'radius') { /* never restored */ } else if (l.kind === 'zip') openZip(l.zip); else if (l.area) { const a = (await areasFile()).find(x => x.id === l.area.id); if (a) openArea(a); } else if (l.tracts) openTracts(l); } catch (e) { } }
      // the home pack saves itself when the tab opens with signal and any home file is missing (an interrupted save resumes)
      if (navigator.onLine) {
        // missing home files, and saved ones older than the copy in Drive (the meta lists each file's sha256), are fetched again
        const need = [];
        for (const f of HOME_FILES()) { const fs = await fileState(f); if (fs.st !== 'current') need.push(f); }
        if (need.length) savePack(need, true).catch(() => { });
      }
    } finally { P.opening = false; }
  }
  window.BWPlaces = { open, version: PV, _P: P };
})();
