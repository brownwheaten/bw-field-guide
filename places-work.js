/* B+W Field Guide, Places phase 2b: jobs and commuting, transit, and food extras. Pure functions, no data, no DOM; loaded by places.js
   and by the release test (test/places_gate.mjs).
   - Jobs (LEHD LODES): jobs based in an area by sector, earnings and age; where those workers live (distance bands, counties, nearby
     neighborhoods); where residents work; a daytime-population estimate. Pennsylvania uses 2024 files, the other states 2023, as the jobs
     line in phase 1 does. Counts, no survey margin.
   - Transit: SEPTA stops counted by distinct stop code (spec CL-28), at 60 m of a corridor line with the 40 m and 80 m second paths (CL-20),
     inside a district, in tracts, or inside a true circle; stations listed beside the stops, never summed with them. MBTA and PATH the same way.
   - Food: SNAP-authorized store openings and closings by year (no direction words; years listed), the below-poverty-not-receiving-SNAP survey
     share, Pennsylvania WIC stores and community-eligibility schools. */
(function (root) {
  'use strict';
  const R_EARTH = 6371008.8;
  const BAND_KM = [1, 2, 3, 5, 10, 15, 25, 50, 100];                 // band i covers [BAND_KM[i-1], BAND_KM[i]) km; band 9 is 100 km and over; 10 has no location
  const BAND_LABEL = ['under 1 km', '1 to 2 km', '2 to 3 km', '3 to 5 km', '5 to 10 km', '10 to 15 km', '15 to 25 km', '25 to 50 km', '50 to 100 km', '100 km or more'];
  const SECTORS = ['Agriculture', 'Mining', 'Utilities', 'Construction', 'Manufacturing', 'Wholesale trade', 'Retail trade', 'Transportation and warehousing',
    'Information', 'Finance and insurance', 'Real estate', 'Professional services', 'Management of companies', 'Administrative and support',
    'Education', 'Health care and social assistance', 'Arts and recreation', 'Food service and lodging', 'Other services', 'Public administration'];
  const EARN = ['$1,250 a month or less', '$1,251 to $3,333 a month', 'over $3,333 a month'];
  const AGE = ['29 or younger', '30 to 54', '55 or older'];

  // ---------------------------------------------------------------- distances (spherical, as BigQuery's ST_DISTANCE)
  const rad = Math.PI / 180;
  function meters(la1, lo1, la2, lo2) {
    const a = Math.sin((la2 - la1) * rad / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin((lo2 - lo1) * rad / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  /** distance from a point to a (Multi)LineString in metres: segments in a local plane centred on the point (exact to well under 0.1 m at 100 m) */
  function distToLine(la, lo, g) {
    const lines = !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'GeometryCollection' ? g.geometries.flatMap(x => x.type === 'LineString' ? [x.coordinates] : x.type === 'MultiLineString' ? x.coordinates : []) : [];
    const kx = R_EARTH * rad * Math.cos(la * rad), ky = R_EARTH * rad; let best = Infinity;
    for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) {
      const ax = (ln[i][0] - lo) * kx, ay = (ln[i][1] - la) * ky, bx = (ln[i + 1][0] - lo) * kx, by = (ln[i + 1][1] - la) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }

  // ---------------------------------------------------------------- jobs and commuting
  /** files: {ST: parsed places_jobs_ST}; returns an index with get(tract) -> row (decoded) */
  function jobsIndex(files) {
    const ix = new Map();
    for (const [st, f] of Object.entries(files)) for (const [t, v] of Object.entries(f.rows)) ix.set(t, { st, f, v });
    return ix;
  }
  const add = (a, b) => { if (!b) return a; if (!a) return b.slice(); for (let i = 0; i < b.length; i++) a[i] += b[i] || 0; return a; };
  /** area aggregate. tracts: card tract ids; pos: tract -> [lat, lon] (population centres, for the 5 km test); names: tract -> neighborhood name */
  function jobsArea(ix, tracts, pos, names) {
    const A = new Set(tracts); const rowsIn = []; const missing = [];
    for (const t of tracts) { const r = ix.get(t); if (r) rowsIn.push([t, r]); else missing.push(t); }
    if (!rowsIn.length) return null;
    const years = new Set(rowsIn.map(([, r]) => r.f.year)); const states = new Set(rowsIn.map(([, r]) => r.st));
    let wac = null, rac = null, wb = null, hb = null, hs = 0, hsAny = false;
    const wc = new Map(), hc = new Map(), nearHome = new Map(); let internal = 0; const perTract = [];
    for (const [t, { f, v }] of rowsIn) {
      const [w, r, h, b1, c1, n1, b2, c2] = v;
      wac = add(wac, w); rac = add(rac, r); wb = add(wb, b1); hb = add(hb, b2);
      if (h !== null && h !== undefined) { hs += h; hsAny = true; }
      if (c1) for (let i = 0; i < c1.length; i += 2) { const k = f.counties[c1[i]]; wc.set(k, (wc.get(k) || 0) + c1[i + 1]); }
      if (c2) for (let i = 0; i < c2.length; i += 2) { const k = f.counties[c2[i]]; hc.set(k, (hc.get(k) || 0) + c2[i + 1]); }
      if (n1) for (let i = 0; i < n1.length; i += 2) { const ht = n1[i], n = n1[i + 1]; nearHome.set(ht, (nearHome.get(ht) || 0) + n); if (A.has(ht)) internal += n; }
      perTract.push({ t, jobs: w ? w[0] : 0, res: r ? r[0] : 0 });
    }
    const cn = {}; for (const [, r] of rowsIn) Object.assign(cn, r.f.county_names);
    // every pair of the area's tracts within 5 km (so the exact pairs cover every flow inside the area), one state, one year
    let within5 = states.size === 1 && years.size === 1;
    if (within5) { const ps = tracts.map(t => pos[t]).filter(Boolean); if (ps.length !== tracts.length) within5 = false;
      else for (let i = 0; i < ps.length && within5; i++) for (let j = i + 1; j < ps.length; j++) if (meters(ps[i][0], ps[i][1], ps[j][0], ps[j][1]) > 5000) { within5 = false; break; } }
    const year = years.size === 1 ? [...years][0] : null;
    const pa = states.size === 1 && states.has('PA');
    // employed residents: Pennsylvania 2024 RAC (O-D held for jobs in Pennsylvania only); elsewhere the O-D total for the home tracts (all states)
    const empRes = pa ? (rac ? rac[0] : null) : (hsAny ? hs : null);
    const outOfState = pa && rac && hsAny ? rac[0] - hs : null;
    const jobs = wac ? wac[0] : null;
    const top = perTract.reduce((a, x) => x.jobs > a.jobs ? x : a, { jobs: -1 });
    const sortMap = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
    const nb = new Map(); let nearN = 0;
    for (const [ht, n] of nearHome) { nearN += n; const nm = names && names[ht] ? names[ht] : null; const k = nm || '(tracts without a neighborhood name)'; nb.set(k, (nb.get(k) || 0) + n); }
    return { tracts: rowsIn.length, missing, year, years: [...years], states: [...states], pa, jobs, wac, rac, empRes, outOfState, hs: hsAny ? hs : null,
      workBands: wb, homeBands: hb, workerHomeCounties: sortMap(wc, 50), residentWorkCounties: sortMap(hc, 50), countyNames: cn,
      nearNeighborhoods: sortMap(nb, 8), nearTotal: nearN, internal: within5 ? internal : null, within5,
      topTract: top.t, topTractShare: jobs ? top.jobs / jobs : null };
  }
  /** share of a band vector under a distance (km must be one of BAND_KM); the no-location band is left out of the base */
  function shareWithin(b, km) { if (!b) return null; const k = BAND_KM.indexOf(km); const base = b.slice(0, 10).reduce((s, x) => s + x, 0); if (!base) return null; return b.slice(0, k + 1).reduce((s, x) => s + x, 0) / base; }
  /** the band holding the median (half live closer, half farther): returns its label */
  function medianBand(b) { if (!b) return null; const base = b.slice(0, 10).reduce((s, x) => s + x, 0); if (!base) return null; let c = 0; for (let i = 0; i < 10; i++) { c += b[i]; if (c >= base / 2) return BAND_LABEL[i]; } return null; }
  /** daytime estimate (B+W method): residents + jobs based here - employed residents. Equal to residents + in-commuters - out-commuters,
      because people who live and work here cancel. ACS residents carry a margin; LODES counts do not. */
  function daytime(res, resMoe, J) {
    if (!J || J.jobs === null || J.empRes === null || res === null || res === undefined) return null;
    const est = res + J.jobs - J.empRes;
    const o = { value: est, moe90: resMoe, residents: res, jobs: J.jobs, empRes: J.empRes };
    if (J.internal !== null) { o.inCommuters = J.jobs - J.internal; o.outCommuters = J.empRes - J.internal; o.liveAndWork = J.internal; }
    return o;
  }
  /** county comparator for sector, earnings and age shares: sum of every tract in the county */
  function countyWac(ix, cty) { let w = null; for (const [t, r] of ix) if (t.startsWith(cty)) w = add(w, r.v[0]); return w; }

  // ---------------------------------------------------------------- transit
  /** sel: {kind:'line', geom} | {kind:'district', id} | {kind:'tracts', tracts} | {kind:'radius', lat, lon, r}. T: parsed places_transit */
  function septaSelect(T, sel) {
    const S = T.septa.stops; const n = S.sc.length; const inT = sel.kind === 'tracts' ? new Set(sel.tracts) : null;
    const res = (b) => ({ buffer: b, ons: 0, codes: new Set(), bus: 0, trolley: 0, busCodes: new Set(), trolleyCodes: new Set(), routes: new Set(), entries: 0, byCode: new Map() });
    const B = sel.kind === 'line' ? [40, 60, 80].map(res) : [res(null)];
    for (let i = 0; i < n; i++) {
      let ok;
      if (sel.kind === 'line') { const d = distToLine(S.la[i], S.lo[i], sel.geom); ok = (b) => d <= b; if (d > 80) continue; }
      else if (sel.kind === 'district') { if (S.ds[i] !== +sel.id) continue; ok = () => true; }
      else if (sel.kind === 'tracts') { if (!inT.has(S.t[i])) continue; ok = () => true; }
      else if (sel.kind === 'radius') { if (meters(sel.lat, sel.lon, S.la[i], S.lo[i]) > sel.r) continue; ok = () => true; }
      else continue;
      for (const x of B) {
        if (x.buffer !== null && !ok(x.buffer)) continue;
        const o = S.ons[i] || 0; x.ons += o; x.codes.add(S.sc[i]); x.entries++; x.byCode.set(S.sc[i], (x.byCode.get(S.sc[i]) || 0) + o);
        if (S.m[i] === 't') { x.trolley += o; x.trolleyCodes.add(S.sc[i]); } else { x.bus += o; x.busCodes.add(S.sc[i]); }
        for (const r of String(S.rs[i] || '').split(' ')) if (r) x.routes.add((S.m[i] === 't' ? 't:' : 'b:') + r);
      }
    }
    const fin = (x) => { const top = [...x.byCode.values()].reduce((a, b) => Math.max(a, b), 0);
      return { buffer: x.buffer, ons: Math.round(x.ons), stops: x.codes.size, bus: Math.round(x.bus), trolley: Math.round(x.trolley), busStops: x.busCodes.size, trolleyStops: x.trolleyCodes.size,
        busRoutes: [...x.routes].filter(r => r.startsWith('b:')).map(r => r.slice(2)).sort(), trolleyRoutes: [...x.routes].filter(r => r.startsWith('t:')).map(r => r.slice(2)).sort(),
        topStop: Math.round(top), topStopShare: x.ons ? top / x.ons : 0, entries: x.entries }; };
    const out = B.map(fin);
    const main = sel.kind === 'line' ? out[1] : out[0];
    // packet gates for boardings (spec 4.2 G3, G5; CL-20 buffer test, line cards only)
    main.gates = { G3: main.ons >= 1000 ? 'pass' : `FAIL: ${main.ons.toLocaleString('en-US')} a weekday (needs 1,000)`,
      G5: main.ons && main.topStopShare > 0.5 ? `FAIL: one stop holds ${Math.round(main.topStopShare * 100)}%` : 'pass' };
    if (sel.kind === 'line') { const [a, , c] = out; main.gates.buffer = (Math.abs(a.ons - main.ons) <= 0.1 * main.ons && Math.abs(c.ons - main.ons) <= 0.1 * main.ons) ? 'pass' : `FAIL: 40 m ${a.ons.toLocaleString('en-US')}, 80 m ${c.ons.toLocaleString('en-US')} against ${main.ons.toLocaleString('en-US')} at 60 m`; main.at40 = a.ons; main.at80 = c.ons; }
    return main;
  }
  /** stations: SEPTA rail (h: undated City layer, r: Regional Rail 2024), MBTA gated and commuter rail, PATH. Counted (in) and nearby (listed only). */
  function stationsSelect(T, sel, nearM) {
    const all = [];
    for (const x of T.septa.rail) all.push({ agency: 'SEPTA', kind: x.k === 'h' ? 'rail_undated' : 'regional_rail_2024', nm: x.nm, ln: x.ln, ons: x.ons, la: x.la, lo: x.lo, t: x.t, ds: x.ds });
    for (const x of T.mbta.gated) if (x.la !== null) all.push({ agency: 'MBTA', kind: 'gated_fall2025', nm: x.nm, ln: x.ln, ons: x.ons, la: x.la, lo: x.lo, t: x.t });
    for (const x of T.mbta.cr) if (x.la !== null) all.push({ agency: 'MBTA', kind: 'commuter_rail_fall2024', nm: x.nm, ln: x.ln, ons: x.ons, la: x.la, lo: x.lo, t: x.t });
    for (const x of T.path.stations) if (x.la !== null) all.push({ agency: 'PATH', kind: 'path_2025', nm: x.nm, ln: 'PATH', ons: x.ons, la: x.la, lo: x.lo, t: x.t });
    const inT = sel.kind === 'tracts' ? new Set(sel.tracts) : null; const inn = [], near = [];
    for (const s of all) {
      let d = null, isIn = false;
      if (sel.kind === 'line') { d = distToLine(s.la, s.lo, sel.geom); isIn = d <= 60; }
      else if (sel.kind === 'district') isIn = s.ds === +sel.id;
      else if (sel.kind === 'tracts') isIn = inT.has(s.t);
      else if (sel.kind === 'radius') { d = meters(sel.lat, sel.lon, s.la, s.lo); isIn = d <= sel.r; }
      if (isIn) inn.push(Object.assign({ dist: d === null ? null : Math.round(d) }, s));
      else if (d !== null && nearM && d <= nearM) near.push(Object.assign({ dist: Math.round(d) }, s));
    }
    const ord = (a, b) => (b.ons || 0) - (a.ons || 0);
    return { in: inn.sort(ord), near: near.sort((a, b) => a.dist - b.dist) };
  }
  function mbtaBusSelect(T, sel) {
    const inT = sel.kind === 'tracts' ? new Set(sel.tracts) : null; let ons = 0, n = 0; const routes = new Set(); let top = 0;
    for (const x of T.mbta.bus) {
      if (x.la === null) continue; let ok = false;
      if (sel.kind === 'line') ok = distToLine(x.la, x.lo, sel.geom) <= 60;
      else if (sel.kind === 'tracts') ok = inT.has(x.t);
      else if (sel.kind === 'radius') ok = meters(sel.lat, sel.lon, x.la, x.lo) <= sel.r;
      if (!ok) continue; ons += x.ons; n++; top = Math.max(top, x.ons); for (const r of String(x.rs || '').split(' ')) if (r) routes.add(r);
    }
    return { ons: Math.round(ons), stops: n, routes: [...routes].sort(), topStopShare: ons ? top / ons : 0 };
  }

  // ---------------------------------------------------------------- SNAP store history
  const GROUPS = { s: 'Supermarkets and super stores', g: 'Grocery stores', c: 'Convenience stores', p: 'Specialty stores', o: 'Combination and other', f: 'Farmers markets' };
  function parseHist(v) {
    const [b, o, c, n] = v.split('|');
    const g = (s) => { const r = {}; for (const x of (s ? s.split(',') : [])) r[x[0]] = (r[x[0]] || 0) + +x.slice(1); return r; };
    const ev = (s) => (s ? s.split(',') : []).map(x => { const [y, gg, k, ns] = x.split('.'); return [+y, gg, +k, +ns]; });
    return { base: g(b), open: ev(o), close: ev(c), now: g(n) };
  }
  /** sum the history over ids (tracts or ZIPs). Stores = every group but farmers markets (they authorize by season and are counted apart). */
  function snapHistory(hist, ids) {
    const Y0 = 2005, Y1 = 2026; const yrs = []; for (let y = Y0; y <= Y1; y++) yrs.push(y);
    const z = () => Object.fromEntries(yrs.map(y => [y, 0]));
    const o = { open: z(), close: z(), openSame: z(), closeSame: z(), fmOpen: z(), fmClose: z(), base: 0, fmBase: 0, now: 0, fmNow: 0, byGroupOpen: {}, byGroupClose: {}, held: 0 };
    for (const id of ids) {
      const v = hist[id]; if (!v) continue; o.held++; const h = parseHist(v);
      for (const [g, n] of Object.entries(h.base)) if (g === 'f') o.fmBase += n; else o.base += n;
      for (const [g, n] of Object.entries(h.now)) if (g === 'f') o.fmNow += n; else o.now += n;
      for (const [y, g, k, ns] of h.open) { if (y < Y0) continue; if (g === 'f') { o.fmOpen[y] += k; continue; } o.open[y] += k; o.openSame[y] += ns; (o.byGroupOpen[g] ||= z())[y] += k; }
      for (const [y, g, k, ns] of h.close) { if (y < Y0) continue; if (g === 'f') { o.fmClose[y] += k; continue; } o.close[y] += k; o.closeSame[y] += ns; (o.byGroupClose[g] ||= z())[y] += k; }
    }
    // stores open on Dec 31 of each year (history only, 2005 to 2025): end of 2004 plus openings less closings
    o.yearEnd = {}; let s = o.base; for (let y = Y0; y <= 2025; y++) { s += o.open[y] - o.close[y]; o.yearEnd[y] = s; }
    o.reconciles = s + o.open[2026] - o.close[2026] === o.now;   // the Nov 13 file, by the same tract rule (relocated stores can break it by one)
    return o;
  }
  /** CL-30-style: "about N a year" only for a steady run of the last five full years; otherwise list the years */
  function steady(vals) {
    const n = vals.length; const avg = vals.reduce((a, b) => a + b, 0) / n; if (!avg) return { steady: false, avg };
    const within = vals.filter(v => Math.abs(v - avg) <= 0.25 * avg).length;
    return { steady: within >= 3 && vals[n - 1] >= 0.75 * avg && vals.every(v => v <= 1.5 * avg), avg, avg10: Math.round(avg / 10) * 10 };
  }

  // ---------------------------------------------------------------- SNAP gap (survey): below-poverty households not receiving SNAP
  const rss = (...m) => Math.sqrt(m.reduce((s, x) => s + (x || 0) ** 2, 0));
  function propMoe(x, mx, n, mn) { if (!n) return null; const p = x / n; let r = mx ** 2 - p ** 2 * mn ** 2; if (r < 0) r = mx ** 2 + p ** 2 * mn ** 2; return Math.sqrt(r) / n; }
  /** cells: id -> [001E,001M,002E,002M,003E,003M,006E,006M]. Returns sums and the share with its margin (Census proportion formula, as the packets) */
  function gapSum(cells, ids) {
    let below = 0, belowQ = 0, not = 0, notQ = 0, rec = 0, recQ = 0, tot = 0, totQ = 0, n = 0;
    for (const id of ids) { const c = cells[id]; if (!c || c[4] === null || c[6] === null) continue; n++;
      const [t, tm, , , r, rm, x, xm] = c; tot += t || 0; totQ += (tm || 0) ** 2; rec += r; recQ += (rm || 0) ** 2; not += x; notQ += (xm || 0) ** 2;
      below += r + x; belowQ += (rm || 0) ** 2 + (xm || 0) ** 2; }
    if (!n) return null;
    const notM = Math.sqrt(notQ), belowM = Math.sqrt(belowQ);
    return { n, below, belowMoe: belowM, notReceiving: not, notReceivingMoe: notM, receivingBelow: rec, households: tot,
      share: below ? not / below : null, shareMoe: below ? propMoe(not, notM, below, belowM) : null };
  }

  const Work = { BAND_KM, BAND_LABEL, SECTORS, EARN, AGE, GROUPS, meters, distToLine, jobsIndex, jobsArea, shareWithin, medianBand, daytime, countyWac,
    septaSelect, stationsSelect, mbtaBusSelect, parseHist, snapHistory, steady, gapSum, propMoe, rss, VERSION: '2b.1.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = Work;
  else root.BWPlacesWork = Work;
})(typeof window !== 'undefined' ? window : globalThis);
