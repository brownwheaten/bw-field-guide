/* B+W Field Guide, Places: address records (phase 2). Pure functions, no data, no DOM; loaded by places.js and by the release test.
   Philadelphia point snapshots (licenses, permits, parcels, deeds, SBA loans, storefront grants) are counted for any area with the
   packet builder's rules (template spec 4.1, 4.2, 4.4, CL-5, CL-19, CL-30):
   - a corridor or packet card counts at corridor addresses: the street and the house-number range (both sides) of each part;
   - a district card counts inside the City boundary, a tract or neighborhood card inside its 2020 tracts (both assigned exactly at export);
   - a radius counts inside the true circle.
   Counts are exact; years are listed, never summarised as "about N a year" unless the run is steady (CL-30); no direction words. */
(function (root) {
  'use strict';
  const EPOCH = Date.UTC(2000, 0, 1), DAY = 86400000;
  const ymd = (d) => new Date(EPOCH + d * DAY).toISOString().slice(0, 10);
  const yearOf = (d) => new Date(EPOCH + d * DAY).getUTCFullYear();
  const dayOf = (s) => Math.round((Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) - EPOCH) / DAY);
  const DIRS = ['N ', 'S ', 'E ', 'W '];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** undo the export's delta encoding (enc[k] === 'd': running sum over non-null values; nulls stay null) */
  function decodeCols(cols) {
    const enc = cols._enc || {}; const out = {};
    for (const [k, a] of Object.entries(cols)) {
      if (k === '_enc') continue;
      if (enc[k] !== 'd') { out[k] = a; continue; }
      const b = new Array(a.length); let run = 0;
      for (let i = 0; i < a.length; i++) { const v = a[i]; if (v === null) b[i] = null; else { run += v; b[i] = run; } }
      out[k] = b;
    }
    return out;
  }
  function layer(data, name) {
    const c = decodeCols(data.cols); const n = (c.y || c.st).length;
    return { name, n, c, data, byStreet: null, byTract: null };
  }
  /** R: the decoded record set. files: {meta, lic, permits, parcels, sales, small} as parsed JSON */
  function load(files) {
    const R = { meta: files.meta, streets: files.meta.streets, L: {} };
    if (files.lic) R.L.lic = layer(files.lic, 'lic');
    if (files.permits) R.L.permits = layer(files.permits, 'permits');
    if (files.parcels) R.L.parcels = layer(files.parcels, 'parcels');
    if (files.sales) R.L.sales = layer(files.sales, 'sales');
    if (files.small) { R.L.sba = layer(files.small.sba, 'sba'); R.L.grants = layer(files.small.grants, 'grants'); R.small = files.small; }
    R.tractIx = new Map(files.meta.tracts.map((t, i) => [t, i]));
    R.partCache = new Map();
    return R;
  }

  // ---------------------------------------------------------------- selecting records
  /** street ids whose text is the part's street, the street followed by more words (a unit), or, for a part with no
   *  direction, the street with a leading direction letter (the builder's regex allowed "N LANCASTER AVE") */
  function streetIds(R, part) {
    if (R.partCache.has(part)) return R.partCache.get(part);
    const ids = new Set(); const hasDir = DIRS.includes(part.slice(0, 2));
    R.streets.forEach((s, i) => {
      if (s === part || s.startsWith(part + ' ')) ids.add(i);
      else if (!hasDir && DIRS.includes(s.slice(0, 2)) && (s.slice(2) === part || s.slice(2).startsWith(part + ' '))) ids.add(i);
    });
    R.partCache.set(part, ids); return ids;
  }
  function byStreet(Ly) {
    if (Ly.byStreet) return Ly.byStreet;
    const m = new Map(); const st = Ly.c.st;
    for (let i = 0; i < Ly.n; i++) { const s = st[i]; if (s < 0) continue; let a = m.get(s); if (!a) m.set(s, a = []); a.push(i); }
    return (Ly.byStreet = m);
  }
  function byTract(Ly) {
    if (Ly.byTract) return Ly.byTract;
    const m = new Map(); const tr = Ly.c.tr;
    for (let i = 0; i < Ly.n; i++) { const t = tr[i]; if (t < 0) continue; let a = m.get(t); if (!a) m.set(t, a = []); a.push(i); }
    return (Ly.byTract = m);
  }
  const meters = (la1, lo1, la2, lo2) => { const R = 6371000, r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
  /** indices of a layer's records inside a selection; for an address selection each index also gets the part it matched (for distinct addresses) */
  function select(R, name, sel) {
    const Ly = R.L[name]; if (!Ly) return null;
    const c = Ly.c; const out = []; out.part = [];
    if (sel.kind === 'addr') {
      const bs = byStreet(Ly);
      // first matching part wins, in the rule's order (as the builder's in_rule)
      const seen = new Set();
      sel.parts.forEach(([part, lo, hi], pi) => {
        for (const sid of streetIds(R, part)) for (const i of (bs.get(sid) || [])) {
          const h = c.hn[i]; if (!h || h < lo || h > hi || seen.has(i)) continue;
          seen.add(i); out.push(i); out.part.push(pi);
        }
      });
      return out;
    }
    if (sel.kind === 'tracts') {
      const bt = byTract(Ly);
      for (const t of sel.tracts) { const ix = R.tractIx.get(t); if (ix === undefined) continue; for (const i of (bt.get(ix) || [])) out.push(i); }
      return out;
    }
    if (sel.kind === 'district') { const d = +sel.id; for (let i = 0; i < Ly.n; i++) if (c.ds[i] === d) out.push(i); return out; }
    if (sel.kind === 'radius') {
      const y0 = Math.round((sel.lat - 39.8) * 1e5), x0 = Math.round((sel.lon + 75.3) * 1e5);
      const dy = sel.r / 1.1054 + 50, dx = sel.r / (1.11320 * Math.cos(sel.lat * Math.PI / 180)) + 50;   // box in 1e-5 degrees, padded
      for (let i = 0; i < Ly.n; i++) {
        const y = c.y[i], x = c.x[i]; if (y === null || x === null || Math.abs(y - y0) > dy || Math.abs(x - x0) > dx) continue;
        if (meters(sel.lat, sel.lon, 39.8 + y / 1e5, -75.3 + x / 1e5) <= sel.r) out.push(i);
      }
      return out;
    }
    return out;
  }
  /** how many records in a layer have no map location (they count by address only) */
  function unplaced(R, name, idx) { const c = R.L[name].c; let n = 0; for (const i of idx) if (c.y[i] === null) n++; return n; }

  /** the address as the source wrote it (for "top address"): the prefix ("215-19") and the street, or the stored original */
  function addrText(R, name, i) {
    const Ly = R.L[name]; const raw = Ly.data.raw && Ly.data.raw[i]; if (raw) return raw;
    const pre = (Ly.data.pre && Ly.data.pre[i]) || (Ly.c.hn[i] ? String(Ly.c.hn[i]) : '');
    const s = Ly.c.st[i] >= 0 ? R.streets[Ly.c.st[i]] : '';
    return (pre ? pre + ' ' : '') + s;
  }
  function topOf(keys) {
    const m = new Map(); let best = null, bn = 0;
    for (const k of keys) { const n = (m.get(k) || 0) + 1; m.set(k, n); if (n > bn || (n === bn && k < best)) { bn = n; best = k; } }
    return { key: best, n: bn, distinct: m.size };
  }

  // ---------------------------------------------------------------- packet rules for runs of years
  /** CL-30: "about N a year" only for a steady run: at least three of the five years within 25% of the average, the last full year
   *  no more than 25% below it, and no year more than 50% above it */
  function steady(vals) {
    const n = vals.length; if (!n) return { steady: false };
    const avg = vals.reduce((a, b) => a + b, 0) / n;
    if (!avg) return { steady: false, avg };
    const within = vals.filter(v => Math.abs(v - avg) <= 0.25 * avg).length;
    const ok = within >= 3 && vals[n - 1] >= 0.75 * avg && vals.every(v => v <= 1.5 * avg);
    return { steady: ok, avg, avg10: Math.round(avg / 10) * 10 };
  }
  /** year-to-date window: January 1 through the end of the last full month before the file's cut-off, this year and last (G7) */
  function ytdWindow(asOf) {
    const y = +asOf.slice(0, 4), m = +asOf.slice(5, 7);           // cut-off month; the window ends at the end of the month before
    const endM = m - 1; if (endM < 1) return null;
    const endDay = new Date(Date.UTC(y, endM, 0)).getUTCDate();
    const mmdd = String(endM).padStart(2, '0') + String(endDay).padStart(2, '0');
    return { year: y, through: MONTHS[endM - 1], mmdd };
  }
  const mmddOf = (d) => ymd(d).slice(5).replace('-', '');
  /** G4: a direction word needs a base of 20 or a move of 3. The app never prints one; this only marks whether the packet would allow it */
  const directionAllowed = (a, b) => Math.max(a, b) >= 20 || Math.abs(a - b) >= 3;

  // ---------------------------------------------------------------- summaries
  const YEARS5 = [2021, 2022, 2023, 2024, 2025];
  function permits(R, idx) {
    const Ly = R.L.permits; const c = Ly.c; const asOf = Ly.data.as_of; const W = ytdWindow(asOf);
    const by = {}; for (let y = 2021; y <= +asOf.slice(0, 4); y++) by[y] = 0;
    let ytdThis = 0, ytdLast = 0, zoningAdmin = 0, five = 0; const typeN = {}; const crN = [0, 0, 0];
    const zIx = Ly.data.types.indexOf('Zoning'), aIx = Ly.data.types.indexOf('Administrative');
    const top5 = [];
    for (const i of idx) {
      const y = yearOf(c.d[i]); by[y] = (by[y] || 0) + 1;
      if (W && y === W.year && mmddOf(c.d[i]) <= W.mmdd) ytdThis++;
      if (W && y === W.year - 1 && mmddOf(c.d[i]) <= W.mmdd) ytdLast++;
      if (y >= 2021 && y <= 2025) { five++; top5.push(addrText(R, 'permits', i)); if (c.ty[i] === zIx || c.ty[i] === aIx) zoningAdmin++; typeN[c.ty[i]] = (typeN[c.ty[i]] || 0) + 1; crN[c.cr[i]]++; }
    }
    const vals = YEARS5.map(y => by[y] || 0); const top = topOf(top5);
    return { kind: 'permits', as_of: asOf, by_year: by, five, ytd: W ? { this: ytdThis, last: ytdLast, through: W.through, year: W.year } : null,
      steady: steady(vals), top_address: top.key, top_address_n: top.n, top_share: five ? top.n / five : 0, zoning_admin_share: five ? zoningAdmin / five : 0,
      types: Object.entries(typeN).map(([t, n]) => [Ly.data.types[t], n]).sort((a, b) => b[1] - a[1]), commercial: crN[1], residential: crN[2],
      gates: { G3: five >= 100 ? 'pass' : `FAIL: ${five} over five years (needs 100)`, G5: five && top.n / five > 0.5 ? `FAIL: one address holds ${Math.round(top.n / five * 100)}%` : 'pass',
        G7: W ? (ytdThis >= 0.9 * ytdLast ? 'pass' : `hold the year to date: ${ytdThis} against ${ytdLast}`) : 'pass' },
      unplaced: unplaced(R, 'permits', idx) };
  }
  function licenses(R, idx) {
    const Ly = R.L.lic; const c = Ly.c; const types = Ly.data.types; const asOf = Ly.data.as_of;
    const food = types.map(t => t.startsWith('Food'));
    const store4 = types.map(t => ['Food Establishment, Retail Perm Location (Large)', 'Food Establishment, Retail Permanent Location', 'Food Preparing and Serving', 'Food Preparing and Serving (30+ SEATS)'].includes(t));
    const ACT = Ly.data.statuses.indexOf('Active');
    let foodActive = 0, active = 0; const foodAddr = new Set(), topKeys = []; const first = {}, first4 = {}, closed = {}; const actTypes = {};
    idx.forEach((i, j) => {
      const f = food[c.ty[i]];
      if (c.s[i] === ACT) { active++; actTypes[c.ty[i]] = (actTypes[c.ty[i]] || 0) + 1; if (f) { foodActive++; foodAddr.add((idx.part && idx.part.length ? idx.part[j] + ':' : c.st[i] + ':') + c.hn[i]); topKeys.push(addrText(R, 'lic', i)); } }
      if (f && c.d0[i] !== null) { const y = yearOf(c.d0[i]); first[y] = (first[y] || 0) + 1; if (store4[c.ty[i]]) first4[y] = (first4[y] || 0) + 1; }
      if (f && c.s[i] !== ACT && c.d1[i] !== null) { const y = yearOf(c.d1[i]); closed[y] = (closed[y] || 0) + 1; }
    });
    const top = topOf(topKeys); const firstVals = YEARS5.map(y => first[y] || 0); const first5 = firstVals.reduce((a, b) => a + b, 0);
    return { kind: 'licenses', as_of: asOf, food_active: foodActive, food_addresses: foodAddr.size, active_all: active,
      active_types: Object.entries(actTypes).map(([t, n]) => [types[t], n]).sort((a, b) => b[1] - a[1]),
      first_issued: first, first_issued_store4: first4, first5, first_steady: steady(firstVals), closed_food: closed, top_address: top.key, top_address_n: top.n,
      gates: { CK: foodActive >= 10 ? 'pass' : `FAIL: ${foodActive} active (needs 10)`, S2: first5 >= 50 ? 'pass' : `FAIL: ${first5} first issued over five years (needs 50)`,
        G5: foodActive && top.n / foodActive > 0.5 ? `FAIL: one address holds ${Math.round(top.n / foodActive * 100)}%` : 'pass' },
      unplaced: unplaced(R, 'lic', idx) };
  }
  function loans(R, idx) {
    const Ly = R.L.sba; const c = Ly.c;
    const keep = idx.filter(i => !c.mb[i]); const since = keep.filter(i => c.fy[i] >= 2020);
    const keys = since.map(i => c.ak[i]); const top = topOf(keys);
    const amt = since.map(i => c.amt[i]); const tot = amt.reduce((a, b) => a + b, 0); const mx = amt.length ? Math.max(...amt) : 0;
    const byFy = {}; for (const i of since) byFy[c.fy[i]] = (byFy[c.fy[i]] || 0) + 1;
    const latest = since.length ? ymd(Math.max(...since.map(i => c.d[i]))) : null;
    const pass = since.length >= 5 && top.distinct >= 4;
    return { kind: 'loans', as_of: R.small.sba.as_of, n_since_fy2020: since.length, k_addresses: top.distinct, top_address_n: top.n,
      top_address: top.key !== null ? R.small.sba.addr_keys[top.key] : null, latest, dollars_since: tot, top_loan_dollar_share: tot ? mx / tot : null, by_fy: byFy,
      mailbox_dropped: idx.length - keep.length, program_504: since.filter(i => c.p[i] === 1).length,
      gates: { G3: pass ? 'pass' : `FAIL: ${since.length} loans at ${top.distinct} addresses (needs 5 at 4)`, G5_count: since.length && top.n / since.length > 1 / 3 ? `FAIL: one address holds ${top.n} of ${since.length}` : 'pass',
        G5_dollars: tot && mx / tot > 1 / 3 ? `FAIL: one loan is ${Math.round(mx / tot * 100)}% of the dollars` : 'pass' },
      unplaced: unplaced(R, 'sba', idx) };
  }
  function grants(R, idx) {
    const c = R.L.grants.c; const byFy = {}; let usd = 0;
    for (const i of idx) { byFy[c.fy[i]] = (byFy[c.fy[i]] || 0) + 1; usd += c.amt[i] || 0; }
    usd = Math.round(usd / 100);   // amounts are stored in cents
    const fys = Object.keys(byFy).map(Number).filter(Boolean).sort();
    return { kind: 'grants', n: idx.length, by_fy: byFy, dollars: usd, fy_first: fys[0] || null, fy_last: fys[fys.length - 1] || null, gates: { G3: idx.length >= 10 ? 'pass' : `FAIL: ${idx.length} grants (needs 10)` } };
  }
  function property(R, idx) {
    const Ly = R.L.parcels; const c = Ly.c; const nonres = new Set(Ly.data.nonres.map(Number));
    const o = new Set(), on = new Set(), onN = new Map(); let nr = 0, nrVal = 0; const vals = []; const onNR = new Set();
    for (const i of idx) {
      const n2 = c.o[i] + c.ond[i]; o.add(c.o[i]); on.add(n2); onN.set(n2, (onN.get(n2) || 0) + 1);
      if (nonres.has(c.c[i])) { nr++; onNR.add(n2); if (c.mvk[i] !== null) { nrVal += c.mvk[i] * 1000; vals.push(c.mvk[i] * 1000); } }
    }
    let topOn = null, topN = 0; for (const [k, n] of onN) if (n > topN) { topN = n; topOn = k; }
    // the name shown for the top owner: the raw id of the first parcel under that normalized id, if that owner holds 3+ parcels citywide
    let topName = null; if (topOn !== null) for (const i of idx) if (c.o[i] + c.ond[i] === topOn) { topName = Ly.data.owner_names[c.o[i]] || null; if (topName) break; }
    vals.sort((a, b) => b - a); const k10 = Math.max(1, Math.ceil(vals.length * 0.10)); const topVal = vals.slice(0, k10).reduce((a, b) => a + b, 0);
    const owners = [...onN.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => {
      let nm = null; for (const i of idx) if (c.o[i] + c.ond[i] === k) { nm = Ly.data.owner_names[c.o[i]] || null; if (nm) break; } return [nm, n]; });
    return { kind: 'property', as_of: Ly.data.as_of, n: idx.length, owners_raw: o.size, owners: on.size, owners_print: String(Math.round(on.size / 10) * 10),
      top_owner_n: topN, top_owner: topName, top_owners: owners, nonres: nr, nonres_owners: onNR.size, nonres_value: nrVal,
      gates: { S5: idx.length >= 50 ? 'pass' : `FAIL: ${idx.length} properties (needs 50)`, G5_owner: idx.length && topN / idx.length > 0.5 ? `FAIL: one owner name holds ${topN}` : 'pass',
        G5_value: nrVal && topVal / nrVal > 0.5 ? `FAIL: ${k10} of ${vals.length} non-residential properties hold ${Math.round(topVal / nrVal * 100)}% of the value` : 'pass' },
      unplaced: unplaced(R, 'parcels', idx) };
  }
  function sales(R, idx) {
    const c = R.L.sales.c; const by = {}, sheriff = {}, prices = {}; const nonres = new Set(R.L.parcels ? R.L.parcels.data.nonres.map(Number) : []); let nrN = 0;
    for (const i of idx) {
      const y = yearOf(c.d[i]);
      if (c.k[i] === 1) { sheriff[y] = (sheriff[y] || 0) + 1; continue; }
      by[y] = (by[y] || 0) + 1; (prices[y] ||= []).push(c.amt[i]); if (nonres.has(c.c[i])) nrN++;
    }
    const med = {}; for (const [y, a] of Object.entries(prices)) { a.sort((p, q) => p - q); const m = a.length; med[y] = m % 2 ? a[(m - 1) / 2] : (a[m / 2 - 1] + a[m / 2]) / 2; }
    return { kind: 'sales', as_of: R.L.sales.data.as_of, by_year: by, median_price: med, sheriff_by_year: sheriff, nonres_sales: nrN, unplaced: unplaced(R, 'sales', idx) };
  }
  /** everything for one selection; layers not loaded come back null */
  function summarize(R, sel) {
    const s = (n) => R.L[n] ? select(R, n, sel) : null;
    const ix = { permits: s('permits'), lic: s('lic'), parcels: s('parcels'), sales: s('sales'), sba: s('sba'), grants: s('grants') };
    return { sel, permits: ix.permits && permits(R, ix.permits), licenses: ix.lic && licenses(R, ix.lic), property: ix.parcels && property(R, ix.parcels),
      sales: ix.sales && sales(R, ix.sales), loans: ix.sba && loans(R, ix.sba), grants: ix.grants && grants(R, ix.grants) };
  }
  /** the packet's claim 3 sentences for permits (spec 4.4 S1, CL-19, CL-30); where = "Frankford Avenue addresses" */
  function permitsSay(p, where) {
    const c = (n) => Number(n).toLocaleString('en-US');
    const lead = p.steady.steady ? `About ${c(p.steady.avg10)} City permits a year at ${where}.` : `${c(p.five)} City permits in five years at ${where}.`;
    const ytd = p.ytd && p.gates.G7 === 'pass' ? ` Through ${p.ytd.through} ${p.ytd.year} it issued ${c(p.ytd.this)}, against ${c(p.ytd.last)} at the same point in ${p.ytd.year - 1}.` : '';
    return { lead, support: `The City issued ${p.steady.steady ? c(p.five) : 'them'} from 2021 through 2025.` + ytd };
  }
  const Records = { permitsSay, decodeCols, load, select, summarize, permits, licenses, loans, grants, property, sales, steady, ytdWindow, directionAllowed, streetIds, addrText, ymd, dayOf, VERSION: '2.0.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = Records;
  else root.BWPlacesRecords = Records;
})(typeof window !== 'undefined' ? window : globalThis);
