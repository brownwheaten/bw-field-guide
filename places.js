/* B+W Field Guide, Places tab (phase 1, v1.0, Nov 2026). Loaded only when the tab opens, so nothing here can break Today, Map, Log or Follow-ups.
   Data: snapshot files (gzip JSON) exported from the warehouse by bw_out/tools/places_export (outside this public repo), kept in DW's
   Google Drive and served by the backend action placesFile to a signed-in device. Each file is saved on the device encrypted with the
   device key, so a saved area works with no signal. No figures are stored in this repository.
   Figures and verdicts come from places-core.js (the packet builder's rules, tested against the 14 built packets). */
(function () {
  'use strict';
  const C = window.BWPlacesCore;
  const PV = '1.0.0';
  let X = null;                       // context from app.js: { S, api, idb, esc, toast }
  const P = { mem: {}, tracts: {}, geo: {}, cmpCache: {}, meeting: false, place: null, map: null, status: {}, busy: new Map(), radius: 805 };
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
  const devSrc = () => ls.get('places_src');       // developer/test only: a URL folder holding the snapshot files
  async function fetchRemote(name) {
    const src = devSrc();
    if (src) { const r = await fetch(src.replace(/\/?$/, '/') + name, { cache: 'no-cache' }); if (!r.ok) throw new Error('dev source ' + r.status); return new Uint8Array(await r.arrayBuffer()); }
    if (!X.S.cfg.url) throw new Error('no_backend');
    const r = await X.api('placesFile', { name }, 60000);
    return b64ToBytes(r.b64);
  }
  async function saveLocal(name, bytes) {
    const key = await deviceKey(); if (!key) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    await X.idb.put('kv', { t: Date.now(), iv, ct, bytes: bytes.length, v: PV }, 'places:' + name);
    return true;
  }
  async function readLocal(name) {
    const rec = await X.idb.get('kv', 'places:' + name).catch(() => null);
    if (!rec) return null;
    const key = await deviceKey(); if (!key) return null;
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct));
    return { bytes, t: rec.t };
  }
  /** get a snapshot file: memory, then this device, then the network (saving it for next time) */
  async function getFile(name, { refresh = false } = {}) {
    if (P.mem[name] && !refresh) return P.mem[name];
    if (P.busy.has(name)) return P.busy.get(name);
    const p = (async () => {
      let from = 'device', bytes = null, t = null;
      if (!refresh) { const loc = await readLocal(name); if (loc) { bytes = loc.bytes; t = loc.t; } }
      if (!bytes) {
        if (!navigator.onLine && !devSrc()) throw new Error('offline');
        bytes = await fetchRemote(name); from = 'network'; t = Date.now();
        await saveLocal(name, bytes).catch(e => console.warn('places save', e));
      }
      const data = await gunzipJson(bytes);
      const out = { data, from, t, bytes: bytes.length };
      P.mem[name] = out; P.status[name] = { from, t, bytes: bytes.length, built: data.built };
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
    const st = rec.st; const mk = st === 'PA' ? (cty === '42101' ? 'PHL' : 'PA') : st === 'NJ' ? 'NJ' : st === 'MA' ? 'MA' : 'national';
    return { kind: 'zip', id: 'zip:' + z, zip: z, name: `ZIP ${z}`, sub: `${rec.city || ''}${rec.city ? ', ' : ''}${st || ''}`, W, Cm, cty, cw, county: cm, figs, zrec: rec,
      built: zf.built, from: P.mem['places_zips.json.gz'].from, market: mk, counties, rows: [], missing: [] };
  }

  // ---------------------------------------------------------------- search
  async function search(q) {
    q = (q || '').trim(); const out = [];
    if (!q) return out;
    if (/^\d{5}$/.test(q)) out.push({ type: 'ZIP', label: `ZIP ${q}`, sub: 'Census ZIP area. A ZIP is not a district.', go: () => openZip(q) });
    if (/^\d{11}$/.test(q)) out.push({ type: 'Tract', label: `Tract ${q}`, sub: 'One census tract', go: () => openTracts({ kind: 'tract', id: 'tract:' + q, tracts: [q] }) });
    const ql = q.toLowerCase();
    let areas = []; try { areas = await areasFile(); } catch (e) { out.push({ type: 'Note', label: 'Areas list not saved on this device', sub: e.message === 'offline' ? 'Connect once to save it.' : e.message }); }
    const hits = areas.filter(a => (a.name + ' ' + (a.org || '') + ' ' + (a.neighborhood || '') + ' ' + a.id).toLowerCase().includes(ql))
      .sort((a, b) => ({ packet: 0, district: 1, corridor: 2 }[a.kind] - { packet: 0, district: 1, corridor: 2 }[b.kind])).slice(0, 12);
    for (const a of hits) out.push({ type: a.kind === 'packet' ? 'Packet area' : a.kind === 'district' ? 'District' : 'Corridor', label: a.name + (a.org ? ' · ' + a.org : ''),
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
    await openTracts({ kind: a.kind, id: a.id, name: a.name, sub: [kindWord, a.org, a.neighborhood].filter(Boolean).join(' · '), tracts: a.tracts, area: a });
  }
  async function openZip(z) { await show(() => fromZip(z)); }
  async function openTracts(pl) { await show(() => fromTracts(pl)); }
  async function show(build) {
    const root = $('#placesCard'); root.innerHTML = '<div class="card"><p class="muted">Loading figures…</p></div>';
    try {
      const pl = await build(); P.place = pl; ls.set('places_last', JSON.stringify({ id: pl.id, kind: pl.kind, tracts: pl.tracts, zip: pl.zip, name: pl.name, sub: pl.sub, area: pl.area ? { id: pl.area.id } : null, radius: pl.radius, center: pl.center }));
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
    const snaps = [];
    for (const a of areas) {
      if (!a.c || meters(pos.lat, pos.lon, a.c[0], a.c[1]) > 8000) continue;
      if (a.boundary && inPoly(pos.lat, pos.lon, a.boundary)) snaps.push({ a, d: 0 });
      else if (a.line) { const d = distToGeom(pos.lat, pos.lon, a.line); if (d <= 150) snaps.push({ a, d }); }
    }
    snaps.sort((x, y) => x.d - y.d);
    const btns = snaps.slice(0, 3).map((s, i) => `<button class="btn" data-snap="${i}">${esc(s.a.name)} <small class="muted">${s.d ? Math.round(s.d) + ' m' : 'inside'}</small></button>`).join('');
    box.innerHTML = (snaps.length ? `<div class="eyebrow">You are on</div><div class="pl-row">${btns}</div><p class="muted small">A district's figures are steadier than a circle and match its packet.</p>` : '')
      + `<div class="eyebrow">Or the tracts around you</div><div class="pl-row">${[400, 805, 1600].map(r => `<button class="btn${r === P.radius ? ' primary' : ''}" data-rad="${r}">${{ 400: '400 m · ¼ mi', 805: '805 m · ½ mi', 1600: '1,600 m · 1 mi' }[r]}</button>`).join('')}</div>`;
    box.querySelectorAll('[data-snap]').forEach(b => b.onclick = () => openArea(snaps[+b.dataset.snap].a));
    box.querySelectorAll('[data-rad]').forEach(b => b.onclick = () => { P.radius = +b.dataset.rad; radius(pos.lat, pos.lon, P.radius); });
  }
  async function radius(lat, lon, r) {
    const sts = new Set(Object.keys(P.tracts));
    for (const st of Object.values(ST_FIPS)) if (await haveLocal(`places_tracts_${st}.json.gz`)) sts.add(st);
    if (!sts.size && navigator.onLine) for (const s of HOME) sts.add(s);
    const ts = [];
    for (const st of sts) { let T; try { T = await tractsFor(st); } catch (e) { continue; } const la = T.ci.lat, lo = T.ci.lon;
      for (const row of T.rows) if (row[la] !== null && Math.abs(row[la] - lat) < 0.05 && meters(lat, lon, row[la], row[lo]) <= r) ts.push(row[0]); }
    if (!ts.length) { $('#placesHere').insertAdjacentHTML('beforeend', `<p class="muted small">No census tract has its population center within ${r} m of you, or this state is not saved on the device.</p>`); return; }
    await openTracts({ kind: 'radius', id: `here:${lat.toFixed(4)},${lon.toFixed(4)}:${r}`, name: 'Around here', sub: `${ts.length} tract${ts.length > 1 ? 's' : ''} with population center within ${r} m`, tracts: ts, radius: r, center: [lat, lon] });
  }

  // ---------------------------------------------------------------- formatting
  const pct1 = (p) => (p === null || p === undefined || Number.isNaN(p)) ? '–' : (p * 100).toFixed(1) + '%';
  const pts1 = (m) => (m === null || m === undefined) ? '' : '±' + (m * 100).toFixed(1);
  const cnt = (n) => (n === null || n === undefined) ? '–' : Math.round(n).toLocaleString('en-US');
  const cntm = (m) => (m === null || m === undefined) ? '' : '±' + Math.round(m).toLocaleString('en-US');
  const usd = (n) => (n === null || n === undefined) ? '–' : '$' + Math.round(n).toLocaleString('en-US');
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
  const fdate = (t) => t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  function vcell(v) { return `<span class="pl-v ${v.cls}" title="${esc(v.detail || '')}"><b aria-hidden="true">${v.mark}</b> ${esc(v.word)}${v.tag ? ` <em>· ${esc(v.tag)}</em>` : ''}</span>`; }
  function say(text) { return text ? `<button class="pl-say" data-say="${esc(text)}" aria-label="Copy this sentence">${esc(text)} <span aria-hidden="true">⧉</span></button>` : ''; }
  /** a share row: figure, margin, comparator, verdict, say-line */
  function shareRow(f, pl, opts = {}) {
    if (!f) return '';
    const internal = opts.internal || (f.flags && f.flags.internal);
    if (internal && P.meeting) return '';
    const v = C.verdict(f, 'share');
    if (internal || opts.need) delete v.tag;
    const fig = v.cls === 'rough' ? `${pct1(v.range[0])}–${pct1(v.range[1])}` : pct1(f.value);
    const cmp = f.comparator && f.comparator.value !== null && f.comparator.value !== undefined ? `<span class="${v.cls === 'inside' ? 'pl-strike' : ''}">${pct1(f.comparator.value)} ${pts1(f.comparator.moe90)}</span>` : '<span class="muted">–</span>';
    let line = '';
    if (!internal && !opts.noSay && f.unit && v.cls === 'solid' && f.verbs) {
      line = cap('about ' + C.sharePhrase(f.value, f.unit, f.verbs)) + (pl.cw.inPhrase ? `; ${pl.cw.inPhrase} it is ${C.pct0(f.comparator.value)}%.` : '.');
    } else if (!internal && !opts.noSay && v.cls === 'inside' && f.verbs) {
      line = cap('about ' + C.sharePhrase(f.value, f.unit, f.verbs)) + `, about the same as ${pl.cw.inPhrase || 'the comparator'}.`;
    }
    const tags = [internal ? 'internal: not for a sheet' : '', opts.need ? 'need fact: statement of need only' : '', concTag(f)].filter(Boolean);
    return `<tr class="${internal ? 'pl-int' : ''}"><th>${esc(opts.label || f.label)}${opts.note ? `<small>${esc(opts.note)}</small>` : ''}</th><td class="num">${fig}</td><td class="num muted">${v.cls === 'rough' ? '' : pts1(f.moe90)}</td>`
      + `<td class="num">${cmp}</td><td>${vcell(v)}${tags.map(t => `<span class="pl-tag">${esc(t)}</span>`).join('')}${line ? '<div>' + say(line) + '</div>' : ''}</td></tr>`;
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
    return `<tr><th>${esc(label)}${opts.note ? `<small>${esc(opts.note)}</small>` : ''}</th><td class="num">${fig}</td><td class="num muted">${v.cls === 'rough' ? '' : (opts.usd ? (f.moe90 !== null && f.moe90 !== undefined ? '±' + money(f.moe90).slice(1) : '') : cntm(f.moe90))}</td><td class="num muted">${cmp}</td><td>${vcell(v)}${opts.say && v.cls === 'solid' ? '<div>' + say(opts.say) + '</div>' : ''}</td></tr>`;
  }
  function changeRow(label, f, pl) {
    if (!f) return '';
    const v = C.changeVerdict(f); const pct = f.test.pct, cp = f.test.cmp_pct;
    if (P.meeting && f.value < 0 && f.test.measurable) return '';
    return `<tr><th>${esc(label)}<small>2014–18 ≈ ${cnt(f.base18)}</small></th><td class="num">${f.value > 0 ? '+' : ''}${cnt(f.value)}</td><td class="num muted">${cntm(f.moe90)}</td>`
      + `<td class="num muted">${(pct * 100).toFixed(1)}% · ${pl.cw.label} ${(cp * 100).toFixed(1)}%</td><td>${vcell(v)}</td></tr>`;
  }
  const table = (head, rows) => `<div class="pl-tw"><table class="pl-t"><thead><tr><th>${esc(head)}</th><th class="num">Figure</th><th class="num">±</th><th class="num">Comparator</th><th>Verdict · say it</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const note = (t) => `<p class="pl-note">${t}</p>`;
  const notHeld = (what, why) => `<div class="pl-empty"><b>${esc(what)}:</b> ${esc(why)}</div>`;
  const sec = (id, title, body, sub) => `<section class="card pl-sec" id="pl-${id}"><div class="row between"><h3>${esc(title)}</h3>${sub ? `<span class="muted small">${esc(sub)}</span>` : ''}</div>${body}</section>`;

  // ---------------------------------------------------------------- render the card
  async function render(pl) {
    const root = $('#placesCard'); const meta = await metaFile().catch(() => null);
    if (pl.empty) { root.innerHTML = `<div class="card"><h2>${esc(pl.name || 'This place')}</h2><p class="muted">${pl.loadError ? esc(whyFail({ message: pl.loadError })) : 'No figures for this place on this device.'}</p>${pl.missing && pl.missing.length ? `<p class="muted small">Tracts not saved: ${pl.missing.map(esc).join(', ')}</p>` : ''}</div>`; return; }
    const F = pl.figs; const W = pl.W; const nT = pl.rows.length;
    const kind = pl.kind;
    const a = pl.area;
    const title = pl.name || (nT === 1 ? tractName(pl.rows[0][0], pl.counties) : 'Selected tracts');
    const covers = kind === 'zip' ? `Census ZIP area ${pl.zip} (survey figures) and the postal ZIP (stores, business counts, lending). A ZIP is not a district: keep ZIP figures off the front of a sheet.`
      : kind === 'tract' ? 'One census tract of 2020. The noisiest unit: most rows read "rough", and that is correct.'
        : kind === 'radius' ? `The ${nT} census tracts of 2020 whose population center falls within ${pl.radius} m of where you are standing (the packet's walking-area rule applied to a point). Tracts are wider than the circle; this is not a count inside the circle.`
          : a ? (a.kind === 'packet' ? cap(a.rule_words) + '.' : `The ${nT} ${a.rule_words}.`) : `${nT} census tracts.`;
    const ruleWarn = a && a.rule === 'boundary_centroid_805m' ? note('<b>Older area rule.</b> This district has no corridor line yet, so its tracts come from the boundary rule the spec says not to print. Use for desk reading; draw the line before any sheet.') : '';
    const pkt = a && a.kind === 'packet' ? note(`Matches the packet (${esc(a.org || '')}, ${esc(a.packet_date || '')}): the release test rebuilds this packet's survey figures from these files and they agree.`) : '';
    const miss = pl.missing && pl.missing.length ? note(`<b>${pl.missing.length} tract${pl.missing.length > 1 ? 's' : ''} not on this device</b> (${pl.missing.map(esc).join(', ')}); the figures below leave ${pl.missing.length > 1 ? 'them' : 'it'} out. Save that state in Data status.`) : '';
    const warn = [];
    const stu = pl.rows.filter(r => r[pl.ci('stu')] === 1).length, gq = pl.rows.filter(r => r[pl.ci('gq')] === 1).length;
    if (stu) warn.push(`${stu} student tract${stu > 1 ? 's' : ''} (a college population distorts rates)`);
    if (gq) warn.push(`${gq} tract${gq > 1 ? 's' : ''} dominated by group quarters (a dorm, prison or care home distorts rates)`);
    const cov = coverageStrip(meta, pl.market);
    root.innerHTML = `
      <div class="card pl-head">
        <div class="eyebrow">${esc({ zip: 'ZIP', tract: 'Tract', radius: 'Around here', packet: 'Packet area', district: 'District', corridor: 'Corridor', neighborhood: 'Neighborhood' }[kind] || 'Place')} · market ${esc(pl.market)}</div>
        <h2>${esc(title)}</h2>${pl.sub ? `<div class="muted small">${esc(pl.sub)}</div>` : ''}
        <p class="small">${esc(covers)}</p>
        <p class="small"><b>Compared with</b> ${esc(pl.cw.head)}${kind === 'zip' ? ' (the ZIP\'s county)' : ''}. Survey figures: ACS 2020–24, margins at 90%.</p>
        ${ruleWarn}${pkt}${miss}${warn.length ? note('<b>Heads up:</b> ' + warn.map(esc).join('; ') + '.') : ''}
        <div class="pl-cov">${cov}</div>
        <div class="pl-meta small muted">Files built ${esc(pl.built || '')} · ${pl.from === 'device' ? 'read from this device' : 'downloaded now and saved on this device'}</div>
        <div id="plMap" class="pl-map" aria-label="Map of the tracts"></div>
      </div>
      ${secPeople(pl)}${secWork(pl)}${secOpen(pl)}${secMoney(pl)}${secFood(pl)}${secHealth(pl)}
      <p class="muted small pl-foot">Verdicts: <b>solid</b> margin within 30% of the figure; <b>rough</b> margin over 30% (shown as a range, no sentence); <b>inside the margin</b> the gap to the comparator is smaller than the two margins combined; <b>no measurable change</b> a decade change inside 1.1 times its margin. Same rules as the packet builder. Survey figures always take "about".</p>`;
    root.querySelectorAll('[data-say]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.say); X.toast('Copied'); } catch (e) { X.toast('Copy not allowed here'); } });
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
      return `<li><b>${esc(x.name)}</b> ${cnt(x.e)} <span class="muted">${cntm(x.m)}</span> · ${pct1(p)} of ${word}${rough ? ' <span class="pl-tag">rough</span>' : ''}</li>`;
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
    if (!P.meeting) rows += `<tr class="pl-sub"><th colspan="5">Internal only (never on a sheet)</th></tr>` + shareRow(F.x_poverty, pl) + shareRow(F.x_hisp, pl) + shareRow(F.x_black, pl) + shareRow(F.x_white, pl) + shareRow(F.x_asian, pl);
    let decade = '';
    if (F.pop_change) decade = table('A decade ago (2014–18 moved to 2020 tracts)', changeRow('Residents', F.pop_change, pl) + changeRow('Households', F.hh_change, pl) + changeRow('Born in another country', F.fb_change, pl)
      + changeRow('Households with no car', F.nv_change, pl) + changeRow('Households receiving SNAP', F.sn_change, pl))
      + (F.pop_change.test.backed_by_2020_count && F.pop_change.test.backed_by_2020_count.p20 ? note(`2020 Census count for these tracts: ${cnt(F.pop_change.test.backed_by_2020_count.p20)}.`) : '');
    else if (isZip) decade = note('A decade ago: not shown for ZIPs in phase 1 (the ZIP area must be checked for boundary changes first).');
    const enrollNote = isZip ? '' : note('School enrollment by level: held for ZIPs only. The warehouse has no tract-level table for it yet (data-thread request in the build notes).');
    return sec('people', 'Who lives here', table('Measure', rows) + enrollNote + decade);
  }

  function secWork(pl) {
    const F = pl.figs, W = pl.W; const meta = P.metaCache; let body = '';
    if (F.jobs && F.jobs.value !== null) {
      const sec = F.jobs.cns.map((n, i) => ({ i, n, cmp: (F.jobs.cmp_cns || [])[i] || 0 })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 4);
      const yr = pl.rows[0][0].startsWith('42') ? '2024' : '2023';
      body += table('Jobs based here', `<tr><th>Jobs based in these tracts<small>LODES ${yr}; counts, no survey margin</small></th><td class="num">${cnt(F.jobs.value)}</td><td></td><td class="num muted">${cnt(F.jobs.cmp_total)}</td><td>${F.jobs.test.gates.G5 === 'pass' ? vcell({ cls: 'solid', mark: '✓', word: 'count' }) : `<span class="pl-tag">concentrated: one tract holds ${Math.round(F.jobs.top_tract_share * 100)}%</span>`}${F.jobs.test.gates.G5 === 'pass' ? '<div>' + say(`About ${C.round(F.jobs.value, 100)} jobs are based in ${pl.kind === 'radius' ? 'the tracts around here' : 'these tracts'}.`) + '</div>' : ''}</td></tr>`
        + sec.map(x => `<tr><th>${esc(meta.sectors[x.i])}</th><td class="num">${pct1(x.n / F.jobs.value)}</td><td class="num muted">${cnt(x.n)}</td><td class="num muted">${F.jobs.cmp_total ? pct1(x.cmp / F.jobs.cmp_total) : '–'}</td><td class="small muted">${F.jobs.cmp_total && x.n / F.jobs.value >= 1.5 * (x.cmp / F.jobs.cmp_total) ? 'well above ' + esc(pl.cw.label) : ''}</td></tr>`).join(''));
    } else body += notHeld('Jobs based here', pl.kind === 'zip' ? 'LODES is held by tract; a ZIP lookup does not carry it in phase 1. Look up a tract or district.' : 'not held for these tracts');
    body += table('How residents get to work', shareRow(F.trait_transit_walk, pl) + shareRow(F.x_drove, pl, { noSay: true }) + shareRow(F.x_wfh, pl, { noSay: true }));
    const prof = phlProfile(pl);
    if (prof) body += table('Transit inside the district', `<tr><th>Transit stops inside</th><td class="num">${cnt(prof.transit_stops_inside)}</td><td></td><td></td><td class="small muted">SEPTA, summer 2025</td></tr><tr><th>Weekday bus boardings</th><td class="num">${cnt(prof.bus_weekday_boardings_summer2025)}</td><td></td><td></td><td class="small muted">inside the boundary</td></tr><tr><th>Weekday trolley boardings</th><td class="num">${cnt(prof.trolley_weekday_boardings_summer2025)}</td><td></td><td></td><td></td></tr>`);
    body += note('Phase 2: where workers here live and where residents work, boardings by stop for any area, and the daytime estimate.');
    return sec('work', 'Who works and shops here', body);
  }

  function phlProfile(pl) {
    if (!P.phl || !pl.area) return null;
    const id = pl.area.district_id || (pl.area.id === 'cor:mayfair' ? '9' : null);
    const d = id && P.phl.districts[id]; return d ? d.profile : null;
  }
  function phlRec(pl) { if (!P.phl || !pl.area) return null; const id = pl.area.district_id || (pl.area.id === 'cor:mayfair' ? '9' : null); return id ? P.phl.districts[id] : null; }

  function storeRows(pl) {
    const W = pl.W; const n = W.snap_n || 0;
    if (pl.kind === 'zip') { const z = pl.W; return { n: z.snap_n, sup: z.snap_sup, gro: z.snap_gro, conv: z.snap_conv, fm: z.snap_fm, spec: z.snap_spec, oth: z.snap_oth, rmp: z.snap_rmp }; }
    return { n, sup: W.snap_sup, gro: W.snap_gro, conv: W.snap_conv, fm: W.snap_fm, spec: W.snap_spec, oth: W.snap_oth, rmp: W.snap_rmp };
  }

  function secOpen(pl) {
    let body = '';
    const s = storeRows(pl);
    body += table('SNAP-authorized stores open now', [['All SNAP stores', s.n], ['Supermarkets and super stores', s.sup], ['Grocery stores', s.gro], ['Convenience stores', s.conv], ['Dollar, pharmacy and other', s.oth], ['Specialty stores', s.spec], ['Farmers markets', s.fm]]
      .map(([l, v]) => `<tr><th>${esc(l)}</th><td class="num">${cnt(v || 0)}</td><td></td><td></td><td class="small muted">USDA file, Nov 13, 2026</td></tr>`).join('')) + note('Openings and closings by year come in phase 2 (address-level store history back to 2005).');
    const rec = phlRec(pl); const p = rec && rec.profile;
    if (p) {
      const yrs = [2021, 2022, 2023, 2024, 2025];
      body += table('City records, inside the district (Philadelphia)', `<tr><th>Permits by year</th><td colspan="4">${yrs.map(y => `${y}: <b>${cnt(p['permits_' + y])}</b>`).join(' · ')}</td></tr>`
        + `<tr><th>New food licenses by year</th><td colspan="4">${yrs.map(y => `${y}: <b>${cnt(p['new_food_lic_' + y])}</b>`).join(' · ')} · 2026 so far: <b>${cnt(p.new_food_lic_2026_ytd)}</b></td></tr>`)
        + note('Counted inside the district boundary (B+W district tables, Nov 11). Any corridor or radius: phase 2.');
    } else if (pl.kind === 'zip' && pl.zrec) {
      const cbp = pl.zrec.cbp || []; const sec = pl.zrec.sec || [];
      body += table(`Business locations in ZIP ${pl.zip} (labeled as the ZIP)`, `<tr><th>Locations by year</th><td colspan="4">${cbp.map(([y, n]) => `${y}: <b>${cnt(n)}</b>`).join(' · ') || '–'}</td></tr>`
        + `<tr><th>Largest sectors, 2023</th><td colspan="4">${sec.map(([n, e]) => `${esc(n)} <b>${cnt(e)}</b>`).join(' · ') || '–'}</td></tr>`) + note('County Business Patterns. The ZIP is a postal area, not this district.');
    } else body += notHeld('Licenses and permits', pl.market === 'PHL' ? 'held for the 17 Philadelphia districts in phase 1; any corridor or radius is phase 2' : 'not held for this market in phase 1');
    return sec('open', "What's opening and closing", body);
  }

  function secMoney(pl) {
    let body = '';
    const rec = phlRec(pl); const p = rec && rec.profile;
    if (p) {
      const vals = (rec.values || []).filter(v => v.tax_year >= 2021);
      body += table('Property inside the district (Philadelphia)', `<tr><th>Non-residential parcels</th><td class="num">${cnt(p.nonres_parcels)}</td><td></td><td></td><td class="small muted">${cnt(p.distinct_nonres_owners)} owners${P.meeting ? '' : `, ${cnt(p.owners_with_2plus_nonres_parcels)} with 2 or more`}</td></tr>`
        + `<tr><th>Taxable non-residential value</th><td colspan="4">${vals.map(v => `${v.tax_year}: <b>${C.usdBig(v.taxable_nonres_value)}</b>`).join(' · ')}</td></tr>`
        + (P.meeting ? '' : `<tr class="pl-int"><th>Largest owners<small>internal: never on a sheet or a screen a client sees</small></th><td colspan="4">${(rec.top_owners || []).sort((a, b) => b.n - a.n).map(o => `${esc(o.owner_name)} <b>${o.n}</b>`).join(' · ')}</td></tr>`)
        + `<tr><th>Storefront improvement grants</th><td class="num">${cnt(p.storefront_grants)}</td><td></td><td></td><td class="small muted">${p.storefront_grant_usd ? usd(p.storefront_grant_usd) : ''}</td></tr>`
        + `<tr><th>SBA-backed loans, FY2020–26</th><td class="num">${cnt(p.sba_loans_fy2020_26)}</td><td></td><td></td><td class="small muted">${p.sba_dollars_fy2020_26 ? (p.sba_dollars_fy2020_26 >= 1e7 ? C.usdBig(p.sba_dollars_fy2020_26) : usd(p.sba_dollars_fy2020_26)) : ''}; cancelled excluded; SBA file Sept 30, 2026</td></tr>`);
    }
    if (pl.kind === 'zip' && pl.zrec) {
      const W = pl.W; const sba = pl.zrec.sba || []; const fy = {}; for (const [y, prog, n, amt] of sba) { fy[y] = fy[y] || [0, 0]; fy[y][0] += n; fy[y][1] += amt; }
      body += table(`Money in ZIP ${pl.zip}`, `<tr><th>Average tax-return income<small>IRS, tax year 2022</small></th><td class="num">${usd(W.irs_avg_agi ? W.irs_avg_agi * (W.irs_avg_agi < 5000 ? 1000 : 1) : null)}</td><td></td><td></td><td class="small muted">${cnt(W.irs_returns)} returns; 5-year change ${W.irs_chg5 !== null ? (W.irs_chg5 * 100).toFixed(1) + '%' : '–'}</td></tr>`
        + `<tr><th>Share of filers, low and high bands</th><td colspan="4">${W.irs_low !== null ? pct1(W.irs_low) : '–'} low · ${W.irs_high !== null ? pct1(W.irs_high) : '–'} high <span class="muted small">(2022)</span></td></tr>`
        + `<tr><th>SBA 7(a) and 504 loans by fiscal year</th><td colspan="4">${Object.keys(fy).sort().map(y => `FY${String(y).slice(2)}: <b>${fy[y][0]}</b>`).join(' · ') || 'none since FY2020'}</td></tr>`);
    }
    if (!body) body = notHeld('Property and lending', pl.market === 'PHL' ? 'held for the 17 Philadelphia districts and by ZIP in phase 1; any corridor or radius is phase 2' : pl.market === 'NJ' ? 'NJ property and sales records are phase 3; SBA lending is on the ZIP card' : 'not held for this market; SBA lending is on the ZIP card');
    body += note('Home value and rent trend, deeds and sales: phase 2.');
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
    body += note('WIC stores and school-meal sites (Pennsylvania), SNAP enrollment gap, food stores on the map and by radius: phase 2.');
    return sec('food', 'Food access', body);
  }

  function placesTable(pl, idx, title) {
    const meta = P.metaCache; const st = pl.kind === 'zip' ? pl.zrec.st : ST_FIPS[pl.rows[0][0].slice(0, 2)];
    if (st === 'PA') return notHeld(title, 'Pennsylvania is missing from both CDC PLACES releases in the warehouse (2025 tract and 2024 county), so these rows are blank for every Pennsylvania place, Philadelphia included. Use the county Map the Meal Gap figure.');
    if (pl.kind === 'zip') return notHeld(title, 'held by tract; look up a tract or district (ZIP-level PLACES is a phase 2 check)');
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
    if (pl.area && (pl.area.line || pl.area.boundary)) layers.push(L.geoJSON(pl.area.line || pl.area.boundary, { style: { color: '#9C5B3A', weight: 3, fill: !!pl.area.boundary, fillOpacity: 0.05 } }));
    if (pl.center) { layers.push(L.circle(pl.center, { radius: pl.radius, color: '#2A1E16', weight: 1, dashArray: '4 4', fill: false })); layers.push(L.circleMarker(pl.center, { radius: 6, color: '#fff', weight: 2, fillColor: '#2A1E16', fillOpacity: 1 })); }
    if (!layers.length && pl.rows.length) for (const r of pl.rows) { const la = r[pl.ci('lat')], lo = r[pl.ci('lon')]; if (la !== null) layers.push(L.circleMarker([la, lo], { radius: 5, color: '#9C5B3A' })); }
    // bounds before adding: a circle has no bounds until the map has a view (Leaflet), so use its own extent
    let bb = null;
    for (const l of layers) { const b = l instanceof L.Circle ? L.latLng(pl.center).toBounds(pl.radius * 2) : (l.getBounds ? l.getBounds() : L.latLngBounds([l.getLatLng(), l.getLatLng()])); bb = bb ? bb.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast()); }
    if (bb) m.fitBounds(bb, { padding: [12, 12], maxZoom: 15 });
    L.featureGroup(layers).addTo(m);
    if (layers.length) { /* drawn */ } else if (pl.kind === 'zip') { el.innerHTML = '<p class="muted small" style="padding:10px">ZIP outlines are not drawn in phase 1.</p>'; }
    setTimeout(() => m.invalidateSize(), 80);
  }

  // ---------------------------------------------------------------- data status
  const FILES_COMMON = ['places_meta.json.gz', 'places_areas.json.gz', 'places_counties.json.gz', 'places_phl.json.gz', 'places_zips.json.gz'];
  const stateFiles = (st) => [`places_tracts_${st}.json.gz`, `places_geo_${st}.json.gz`];
  async function renderStatus() {
    const box = $('#placesStatus'); const meta = await metaFile().catch(() => null);
    const files = meta ? meta.files.map(f => f.file) : FILES_COMMON.concat(HOME.flatMap(stateFiles));
    const rows = [];
    for (const f of files) {
      const rec = await X.idb.get('kv', 'places:' + f).catch(() => null); const info = meta && meta.files.find(x => x.file === f);
      rows.push(`<tr><th>${esc(f.replace(/^places_|\.json\.gz$/g, ''))}</th><td>${rec ? `saved ${fdate(rec.t)}` : '<span class="pl-tag">not saved</span>'}</td><td class="num muted">${info ? (info.bytes / 1e6).toFixed(1) + ' MB' : ''}</td></tr>`);
    }
    const src = devSrc() ? `developer folder (${esc(devSrc())})` : (X.S.cfg.url ? 'B+W backend (Google Drive)' : 'no backend set');
    box.innerHTML = `<p class="small">Files built ${esc(meta ? meta.built : '?')} · source: ${src} · ${navigator.onLine ? 'online' : '<b>offline</b>'}</p>
      <div class="pl-row"><button class="btn" id="plHome">Save home pack (PA, NJ, DE)</button></div>
      <div class="pl-row">${['MA', 'RI', 'CT', 'NY', 'MD'].map(s => `<button class="btn ghost" data-trip="${s}">Save ${s}</button>`).join('')}</div>
      <div class="pl-row"><button class="btn ghost" id="plRefresh">Re-download everything saved</button></div>
      <div class="pl-tw"><table class="pl-t pl-files"><tbody>${rows.join('')}</tbody></table></div>
      <p class="muted small">iPhones and iPads can clear saved files when storage runs low. Check this list before leaving Wi-Fi.</p>`;
    $('#plHome').onclick = () => savePack(FILES_COMMON.concat(HOME.flatMap(stateFiles)));
    box.querySelectorAll('[data-trip]').forEach(b => b.onclick = () => savePack(stateFiles(b.dataset.trip)));
    $('#plRefresh').onclick = async () => { const saved = []; for (const f of files) if (await haveLocal(f)) saved.push(f); await savePack(saved, true); };
  }
  async function savePack(files, refresh = false) {
    let ok = 0, bad = [];
    for (const f of files) { X.toast(`Saving ${f.replace(/^places_|\.json\.gz$/g, '')}…`); try { await getFile(f, { refresh }); ok++; } catch (e) { bad.push(f + ': ' + whyFail(e)); } }
    X.toast(bad.length ? `Saved ${ok}; ${bad.length} failed` : `Saved ${ok} file${ok === 1 ? '' : 's'}`);
    if (bad.length) console.warn(bad);
    P.tracts = {}; P.geo = {}; P.cmpCache = {};
    renderStatus();
  }

  // ---------------------------------------------------------------- shell
  function shell(root) {
    root.innerHTML = `
      <div class="card search pl-find">
        <div class="row"><input id="plQ" type="search" placeholder="District, corridor, ZIP, tract or neighborhood" autocomplete="off" autocapitalize="none" enterkeyhint="search" aria-label="Find a place">
          <button id="plHereBtn" class="btn">Here</button></div>
        <div id="plResults" class="list tight"></div>
        <div id="placesHere"></div>
        <div class="row between pl-tools"><label class="small"><input type="checkbox" id="plMeeting"> Meeting mode <span class="muted">(hides internal rows)</span></label>
          <button id="plStatusBtn" class="link small">Data status</button></div>
        <div id="placesStatus" hidden></div>
      </div>
      <div id="placesCard"><div class="card"><p class="muted">Type a district or corridor (Mayfair, Frankford), a ZIP (19149), a Philadelphia neighborhood or tract number, or tap <b>Here</b>.</p></div></div>`;
    let tm; $('#plQ').oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => runSearch(e.target.value), 180); };
    $('#plQ').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(e.target.value, true); } };
    $('#plHereBtn').onclick = here;
    $('#plMeeting').checked = P.meeting; $('#plMeeting').onchange = (e) => { P.meeting = e.target.checked; ls.set('places_meeting', P.meeting ? '1' : ''); if (P.place) render(P.place); };
    $('#plStatusBtn').onclick = () => { const b = $('#placesStatus'); b.hidden = !b.hidden; if (!b.hidden) renderStatus(); };
  }
  async function runSearch(q, first) {
    const box = $('#plResults'); const res = await search(q);
    if (first && res.length && res[0].go) { box.innerHTML = ''; return res[0].go(); }
    box.innerHTML = res.map((r, i) => `<div class="item" data-i="${i}"><span class="txt"><b>${esc(r.label)}</b><div><small>${esc(r.type)} · ${esc(r.sub || '')}</small></div></span><span class="pill">${esc(r.type)}</span></div>`).join('')
      || (q ? '<p class="muted small">Nothing matches. Try a ZIP, a street or district name, or a Philadelphia neighborhood.</p>' : '');
    box.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { const r = res[+el.dataset.i]; box.innerHTML = ''; if (r.go) r.go(); });
  }

  async function open(ctx) {
    X = ctx; const root = document.getElementById('placesRoot');
    if (!P.started) {
      P.started = true; P.meeting = ls.get('places_meeting') === '1'; shell(root);
      try { P.metaCache = await metaFile(); } catch (e) { $('#placesCard').innerHTML = `<div class="card"><b>Places files are not on this device yet.</b><p class="muted small">${esc(whyFail(e))}</p></div>`; return; }
      try { P.phl = (await getFile('places_phl.json.gz')).data; } catch (e) { P.phl = null; }
      const last = ls.get('places_last');
      if (last) { try { const l = JSON.parse(last); if (l.kind === 'zip') openZip(l.zip); else if (l.area) { const a = (await areasFile()).find(x => x.id === l.area.id); if (a) openArea(a); } else if (l.tracts) openTracts(l); } catch (e) { } }
      // home pack saves itself the first time the tab opens with signal
      if (navigator.onLine && !(await haveLocal('places_tracts_PA.json.gz'))) savePack(FILES_COMMON.concat(HOME.flatMap(stateFiles))).catch(() => { });
    }
  }
  window.BWPlaces = { open, version: PV, _P: P };
})();
