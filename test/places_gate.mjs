// Places release gate: rebuild every built packet's survey figures from the Places snapshot files with places-core.js
// and compare them with the packet's figures.json. Exit code 1 on any unexplained mismatch.
// Usage: node test/places_gate.mjs <snapshot dir> <packets dir> [report.json] [explained.json]
// The repo holds no data: both directories live outside it (bw_out/tools/places_snapshots, bw_out/templates/out).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('../places-core.js');

const [snapDir, pktDir, reportPath] = process.argv.slice(2);
if (!snapDir || !pktDir) { console.error('usage: node test/places_gate.mjs <snapshot dir> <packets dir> [report.json]'); process.exit(2); }
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(snapDir, f))).toString());
const tracts = {};
const cols = {};
for (const st of ['PA', 'NJ', 'NY', 'DE', 'MD', 'MA', 'CT', 'RI']) {
  const f = `places_tracts_${st}.json.gz`; if (!fs.existsSync(path.join(snapDir, f))) continue;
  const d = gz(f); cols[st] = d.cols; for (const r of d.rows) tracts[r[0]] = { st, r };
}
const counties = gz('places_counties.json.gz').counties;
const ST = { '42': 'PA', '34': 'NJ', '36': 'NY', '10': 'DE', '24': 'MD', '25': 'MA', '09': 'CT', '44': 'RI' };

const REL = 1e-9;   // float tolerance: margins are square roots of sums in a different order than BigQuery's; everything printed is compared exactly
const close = (a, b) => (a === null || a === undefined || b === null || b === undefined) ? a == b : (a === b || Math.abs(a - b) <= REL * Math.max(1, Math.abs(a), Math.abs(b)));
const status = (g) => g === undefined ? undefined : (String(g).startsWith('pass') ? 'pass' : String(g).startsWith('FAIL') ? 'FAIL' : String(g));

// Explained variances: a JSON file kept outside this public repo (it names packets), passed as the 4th argument:
// [{ "packets": [folder, ...], "figures": [fid, ...], "keys": {"comparator.value": abs tolerance, "test.cmp_pct": abs tolerance}, "reason": "..." }]
// A mismatch is "explained" only if its packet, figure and key are listed and the difference is within that key's tolerance. Gates never are.
const explainedPath = process.argv[5];
const EXPL = explainedPath && fs.existsSync(explainedPath) ? JSON.parse(fs.readFileSync(explainedPath)) : [];
const EXPLAINED = (pkt, fid, key, a, b) => EXPL.find(e => e.packets.includes(pkt) && e.figures.includes(fid)
  && Object.entries(e.keys).some(([k, tol]) => key.startsWith(k) && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol));
const SURVEY = ['res_wa', 'hh_wa', 'agg_income', 'hh_change', 'pop_change', 'fb_change', 'trait_born_abroad', 'trait_lang_other', 'trait_no_car', 'trait_u18', 'trait_a1824',
  'trait_a65', 'trait_transit_walk', 'trait_renters', 'need_no_car', 'need_snap', 'need_lvw', 'need_kids', 'need_a65', 'tract_median_range', 'cmp_median', 'hh18_base',
  'pop18_base', 'fb18_base', 'n_tracts', 'jobs'];
const report = { run: new Date().toISOString(), tolerance_rel: REL, packets: [], totals: { compared: 0, matched: 0, mismatched: 0, printed_mismatch: 0 }, verdicts: { compared: 0, ok: 0, failed: 0 } };

for (const dir of fs.readdirSync(pktDir).sort()) {
  const fp = path.join(pktDir, dir, 'figures.json');
  if (dir.startsWith('_') || !fs.existsSync(fp)) continue;
  const P = JSON.parse(fs.readFileSync(fp)); const M = P.meta; const PF = P.figures;
  const rows = M.tracts.map(t => tracts[t]).filter(Boolean);
  const missing = M.tracts.filter(t => !tracts[t]);
  const st = ST[M.tracts[0].slice(0, 2)]; const C = cols[st];
  // comparator: the county holding most of the area's residents (Philadelphia for every Philadelphia packet)
  const byCty = {}; for (const x of rows) { const c = x.r[0].slice(0, 5); byCty[c] = (byCty[c] || 0) + (x.r[1 + C.indexOf('pop_e')] || 0); }
  const cty = Object.entries(byCty).sort((a, b) => b[1] - a[1])[0][0];
  const cmpRows = Object.values(tracts).filter(x => x.r[0].startsWith(cty)).map(x => x.r);
  const W = Core.aggregate(rows.map(x => x.r), C); const Cm = Core.aggregate(cmpRows, C);
  const cm = counties[cty] || {};
  const { figs } = Core.makeFigures(W, Cm, { e: cm.med, m: cm.med_m }, M.comparator.area);
  const res = { packet: dir, district_key: M.district_key, market: M.market_variant, tracts: M.tracts.length, missing_tracts: missing, comparator_county: cty,
    comparator_tracts: cmpRows.length, checks: [], mismatches: [] };
  const chk = (fid, key, a, b, printed) => {
    report.totals.compared++; const ok = close(a, b);
    res.checks.push([fid, key, ok]);
    if (!ok && EXPLAINED(dir, fid, key, a, b)) { report.totals.explained = (report.totals.explained || 0) + 1; res.explained = res.explained || []; res.explained.push({ fid, key, places: a, packet: b, reason: EXPLAINED(dir, fid, key, a, b).reason }); return; }
    if (ok) report.totals.matched++; else { report.totals.mismatched++; if (printed) report.totals.printed_mismatch++; res.mismatches.push({ fid, key, places: a, packet: b, printed: !!printed }); }
  };
  for (const fid of SURVEY) {
    const pf = PF[fid]; const af = figs[fid];
    if (!pf) continue;
    if (!af) { res.mismatches.push({ fid, key: 'figure', places: null, packet: 'present' }); report.totals.compared++; report.totals.mismatched++; continue; }
    if (fid === 'jobs') { chk(fid, 'value', af.value, pf.value, true); chk(fid, 'cmp_total', af.cmp_total, pf.cmp_total); chk(fid, 'top_tract_share', af.top_tract_share, pf.top_tract_share); chk(fid, 'G5', status(af.test.gates.G5), status(pf.test.gates.G5)); continue; }
    if (fid === 'tract_median_range') { chk(fid, 'low', af.low, pf.low, true); chk(fid, 'high', af.high, pf.high, true); chk(fid, 'n_tracts', af.n_tracts, pf.n_tracts); continue; }
    chk(fid, 'value', af.value, pf.value, true);
    if ('moe90' in pf) chk(fid, 'moe90', af.moe90, pf.moe90);
    if (pf.comparator && af.comparator) { chk(fid, 'comparator.value', af.comparator.value, pf.comparator.value, true); if (pf.comparator.moe90 !== undefined && pf.comparator.moe90 !== null) chk(fid, 'comparator.moe90', af.comparator.moe90, pf.comparator.moe90); }
    const pt = pf.test || {}; const at = af.test || {};
    for (const k of ['ratio', 'diff_pts', 'beyond_margin', 'delta', 'moe', 'pct', 'cmp_pct', 'printed_value', 'delta_occupancy_held', 'pct_occupancy_held', 'cmp_pct_occupancy_held', 'moe_share'])
      if (k in pt) chk(fid, 'test.' + k, at[k], pt[k], k === 'printed_value');
    if (pt.concentration) chk(fid, 'test.concentration.pass', at.concentration && at.concentration.pass, pt.concentration.pass);
    if (pt.backed_by_2020_count) { chk(fid, 'test.backed_by_2020_count.p20', at.backed_by_2020_count && at.backed_by_2020_count.p20, pt.backed_by_2020_count.p20); chk(fid, 'test.backed_by_2020_count.pass', at.backed_by_2020_count && at.backed_by_2020_count.pass, pt.backed_by_2020_count.pass); }
    for (const [g, v] of Object.entries(pt.gates || {})) chk(fid, 'gate.' + g, status((at.gates || {})[g]), status(v));
  }
  // printed form: the say-line pattern on every trait (fraction words or whole percent) must match the packet's rounding
  for (const t of Object.keys(Core.TRAITS)) {
    const pf = PF['trait_' + t], af = figs['trait_' + t]; if (!pf || !af) continue;
    chk('trait_' + t, 'printed.share_phrase', Core.sharePhrase(af.value, af.unit, af.verbs), Core.sharePhrase(pf.value, af.unit, af.verbs), true);
  }
  // verdict consistency (counted apart from the figure checks above): what the card says must not outrun the packet's gates.
  // 1. A household "measurable rise" needs both packet G2 gates (survey margin, and with the 2014-18 occupancy rate held).
  // 2. A "sheet strength" or "support only" tag needs the packet's G2 and G5 to pass and no one-use (G6) block.
  const vchk = (what, ok, detail) => { report.verdicts.compared++; if (ok) report.verdicts.ok++; else { report.verdicts.failed++; res.verdict_failures = res.verdict_failures || []; res.verdict_failures.push({ what, detail }); } };
  if (figs.hh_change && PF.hh_change) {
    const w = Core.changeVerdict(figs.hh_change).word; const g = PF.hh_change.test.gates || {};
    const firm = status(g.G2) === 'pass' && (g['G2-occupancy-held'] === undefined || status(g['G2-occupancy-held']) === 'pass');
    vchk('hh_change verdict', w !== 'measurable rise' || firm, `card "${w}", packet G2 ${status(g.G2)}, G2-occupancy-held ${status(g['G2-occupancy-held'])}`);
  }
  for (const t of Object.keys(Core.TRAITS)) {
    const af = figs['trait_' + t], pf = PF['trait_' + t]; if (!af || !pf) continue;
    const tag = Core.sheetTag('trait_' + t, af, Core.verdict(af, 'share')); const g = (pf.test && pf.test.gates) || {};
    const okGates = status(g.G2) === 'pass' && status(g.G5) !== 'FAIL' && status(g['G6-one-use']) !== 'FAIL';
    vchk('trait_' + t + ' tag', !(tag === 'sheet strength' || tag === 'support only') || okGates, `card tag "${tag}", packet G2 ${status(g.G2)}, G5 ${status(g.G5)}, G6 ${status(g['G6-one-use'])}`);
    if (tag === 'sheet strength') vchk('trait_' + t + ' lead', status(g.G3) === 'pass' && af.test && Core.TRAITS[t][5], `packet G3 ${status(g.G3)}`);
  }
  report.packets.push(res);
  console.log(`${res.mismatches.length ? 'FAIL' : 'ok  '} ${dir.padEnd(32)} ${res.checks.length} checks, ${res.mismatches.length} mismatches, ${(res.explained || []).length} explained${missing.length ? ', missing tracts ' + missing.join(' ') : ''}`);
  for (const m of res.mismatches.slice(0, 12)) console.log('       ', m.fid, m.key, 'places=', m.places, 'packet=', m.packet);
  for (const m of (res.verdict_failures || [])) console.log('        VERDICT', m.what, m.detail);
}
// ---------------------------------------------------------------- records (phase 2): permits, licenses, property, loans, grants
// For every packet whose area carries an address rule (places_areas.json.gz, kind "packet"), count the Philadelphia point snapshots with
// places-records.js and compare with the packet's inputs.json records block. Then, for the 17 City districts, compare the inside-boundary
// counts with the phase 1 district tables (places_phl.json.gz). Counted apart from the survey checks so those totals stay comparable.
const Rec = require('../places-records.js');
report.records = { compared: 0, matched: 0, explained: 0, mismatched: 0, packets: [], districts: [] };
if (fs.existsSync(path.join(snapDir, 'places_pts_meta.json.gz'))) {
  const R = Rec.load({ meta: gz('places_pts_meta.json.gz'), lic: gz('places_pts_lic.json.gz'), permits: gz('places_pts_permits.json.gz'), parcels: gz('places_pts_parcels.json.gz'),
    sales: gz('places_pts_sales.json.gz'), small: gz('places_pts_small.json.gz') });
  const areas = gz('places_areas.json.gz').areas;
  const rchk = (bucket, who, key, a, b) => {
    report.records.compared++; const ok = JSON.stringify(a) === JSON.stringify(b);
    if (ok) { report.records.matched++; bucket.checks.push([key, true]); return; }
    // a number within its listed tolerance, or a printed sentence listed as "text" (the packet's wording is the documented exception)
    const e = EXPL.find(x => x.records && x.packets.includes(who) && key in x.keys && ((x.keys[key] === 'text' && Array.isArray(a)) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= x.keys[key])));
    if (e) { report.records.explained++; (bucket.explained ||= []).push({ key, places: a, packet: b, reason: e.reason }); return; }
    report.records.mismatched++; bucket.mismatches.push({ key, places: a, packet: b });
  };
  const yr = (o, ys) => ys.map(y => (o || {})[y] || 0);
  for (const dir of fs.readdirSync(pktDir).sort()) {
    const ip = path.join(pktDir, dir, 'inputs.json'); if (dir.startsWith('_') || !fs.existsSync(ip)) continue;
    const I = JSON.parse(fs.readFileSync(ip)); const RI = I.records || {}; const key = (I.meta && I.meta.district_key) || dir;
    const a = areas.find(x => x.id === 'pkt:' + key); if (!a || !a.addr) continue;
    const S = Rec.summarize(R, { kind: 'addr', parts: a.addr.parts });
    const b = { packet: dir, parts: a.addr.parts, checks: [], mismatches: [] };
    const Y = ['2021', '2022', '2023', '2024', '2025'];
    if (RI.permits) {
      const p = RI.permits; rchk(b, dir, 'permits.by_year', yr(S.permits.by_year, Y), Y.map(y => p.by_year[y]));
      rchk(b, dir, 'permits.ytd', [S.permits.ytd.this, S.permits.ytd.last, S.permits.ytd.through], [p.ytd.this, p.ytd.last, p.ytd.through]);
      rchk(b, dir, 'permits.top_address_n', S.permits.top_address_n, p.top_address_n); rchk(b, dir, 'permits.top_address', S.permits.top_address, p.top_address);
      if (p.file_max) rchk(b, dir, 'permits.file_max', S.permits.as_of, p.file_max);
      // the printed claim 3 (rule S1): lead and support as the packet printed them
      const F = JSON.parse(fs.readFileSync(path.join(pktDir, dir, 'figures.json')));
      const c3 = Object.values(F.text || {}).flat().find(x => x && typeof x === 'object' && x.slot === 'F7.3' && /^S1\b/.test(x.rule || ''));
      if (c3) { const sy = Rec.permitsSay(S.permits, `${F.meta.street} addresses`); rchk(b, dir, 'permits.printed_claim3', [sy.lead, sy.support], [c3.lead, c3.support]); }
    }
    if (RI.food_licenses_active) {
      const l = RI.food_licenses_active; rchk(b, dir, 'lic.food_active', S.licenses.food_active, l.n); rchk(b, dir, 'lic.food_addresses', S.licenses.food_addresses, l.k);
      if (l.asof) rchk(b, dir, 'lic.as_of', S.licenses.as_of, l.asof);
    }
    if (RI.licenses_first_issued) rchk(b, dir, 'lic.first_issued', yr(S.licenses.first_issued, Y), Y.map(y => RI.licenses_first_issued.by_year[y]));
    if (RI.sba) {
      const s = RI.sba; rchk(b, dir, 'sba.n_since_fy2020', S.loans.n_since_fy2020, s.n_since_fy2020); rchk(b, dir, 'sba.k_addresses', S.loans.k_addresses, s.k_addresses);
      rchk(b, dir, 'sba.top_address_n', S.loans.top_address_n, s.top_address_n);
      if (s.latest) rchk(b, dir, 'sba.latest', s.latest.length === 7 ? (S.loans.latest || '').slice(0, 7) : S.loans.latest, s.latest);
      if (s.dollars_since !== undefined && s.dollars_since !== null) rchk(b, dir, 'sba.dollars_since', S.loans.dollars_since, s.dollars_since);
      if (s.asof) rchk(b, dir, 'sba.as_of', S.loans.as_of, s.asof);
    }
    if (RI.properties) {
      const q = RI.properties; rchk(b, dir, 'property.n', S.property.n, q.n); rchk(b, dir, 'property.owners', S.property.owners_raw, q.owners);
      rchk(b, dir, 'property.owners_print', S.property.owners_print, q.owners_print); rchk(b, dir, 'property.top_owner_n', S.property.top_owner_n, q.top_owner_n);
    }
    if (RI.grants && typeof RI.grants.n === 'number') rchk(b, dir, 'grants.n', S.grants.n, RI.grants.n);
    report.records.packets.push(b);
    console.log(`${b.mismatches.length ? 'FAIL' : 'ok  '} records ${dir.padEnd(28)} ${b.checks.length + b.mismatches.length + (b.explained || []).length} checks, ${b.mismatches.length} mismatches, ${(b.explained || []).length} explained`);
    for (const m of b.mismatches) console.log('        ', m.key, 'places=', JSON.stringify(m.places), 'packet=', JSON.stringify(m.packet));
  }
  // the 17 City districts: inside-boundary counts against the phase 1 district tables
  const phl = gz('places_phl.json.gz').districts;
  for (const [id, d] of Object.entries(phl)) {
    const p = d.profile; if (!p || !p.district_id) continue;
    const S = Rec.summarize(R, { kind: 'district', id });
    const b = { district: id, checks: [], mismatches: [] }; const who = 'district:' + id;
    const Y = [2021, 2022, 2023, 2024, 2025];
    rchk(b, who, 'district.permits', Y.map(y => S.permits.by_year[y] || 0), Y.map(y => p['permits_' + y]));
    rchk(b, who, 'district.new_food_lic_store4', Y.map(y => S.licenses.first_issued_store4[y] || 0).concat([S.licenses.first_issued_store4[2026] || 0]), Y.map(y => p['new_food_lic_' + y]).concat([p.new_food_lic_2026_ytd]));
    rchk(b, who, 'district.storefront_grants', S.grants.n, p.storefront_grants);
    rchk(b, who, 'district.storefront_grant_usd', S.grants.dollars, Math.round(p.storefront_grant_usd || 0));
    rchk(b, who, 'district.nonres_parcels', S.property.nonres, p.nonres_parcels);
    report.records.districts.push(b);
    console.log(`${b.mismatches.length ? 'FAIL' : 'ok  '} records district ${id.padEnd(19)} ${b.checks.length + b.mismatches.length + (b.explained || []).length} checks, ${b.mismatches.length} mismatches, ${(b.explained || []).length} explained`);
    for (const m of b.mismatches) console.log('        ', m.key, 'places=', JSON.stringify(m.places), 'table=', JSON.stringify(m.packet));
  }
  console.log(`records: ${report.records.compared} checks, ${report.records.matched} match, ${report.records.explained} explained, ${report.records.mismatched} unexplained mismatch`);
} else console.log('records: point snapshots not in this folder; records checks skipped');
// ---------------------------------------------------------------- phase 2b: jobs and commuting, transit, food extras (counted apart)
// One source of truth: the new files must agree with the phase 1 tract file where they overlap, and reproduce every figure the packets carry
// for jobs (M3), transit (M1, CL-20, CL-28) and the 17 district tables. Everything else is an integrity identity.
const Work = require('../places-work.js');
report.p2b = { compared: 0, matched: 0, explained: 0, mismatched: 0, groups: {} };
if (fs.existsSync(path.join(snapDir, 'places_transit.json.gz'))) {
  const grp = (g) => (report.p2b.groups[g] ||= { compared: 0, matched: 0, explained: 0, mismatched: 0, mismatches: [], explained_list: [] });
  const pchk = (g, who, key, a, b) => {
    const G = grp(g); report.p2b.compared++; G.compared++;
    if (JSON.stringify(a) === JSON.stringify(b)) { report.p2b.matched++; G.matched++; return true; }
    const e = EXPL.find(x => x.p2b && x.packets.includes(who) && key in x.keys && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= x.keys[key]);
    if (e) { report.p2b.explained++; G.explained++; G.explained_list.push({ who, key, places: a, packet: b, reason: e.reason }); return true; }
    report.p2b.mismatched++; G.mismatched++; G.mismatches.push({ who, key, places: a, packet: b }); return false;
  };
  const JF = {}, FF = {};
  for (const st of ['PA', 'NJ', 'NY', 'DE', 'MD', 'MA', 'CT', 'RI']) {
    if (fs.existsSync(path.join(snapDir, `places_jobs_${st}.json.gz`))) JF[st] = gz(`places_jobs_${st}.json.gz`);
    if (fs.existsSync(path.join(snapDir, `places_food_${st}.json.gz`))) FF[st] = gz(`places_food_${st}.json.gz`);
  }
  const JX = Work.jobsIndex(JF);
  // A. jobs file = phase 1 tract file (jobs and the 20 sectors), every tract; B. O-D integrity
  let aBad = 0, aN = 0, bBad = 0, bN = 0, paBelow = 0;
  for (const [t, { st, r }] of Object.entries(tracts)) {
    const C = cols[st]; const j = r[1 + C.indexOf('jobs')]; const x = JX.get(t); const w = x && x.v[0];
    if (j === null || j === undefined) { if (w && w[0]) aBad++; continue; }
    aN++; const cns = C.filter(c => /^cns\d\d$/.test(c)).map(c => r[1 + C.indexOf(c)] || 0);
    if (!w || w[0] !== j || JSON.stringify(w.slice(7)) !== JSON.stringify(cns)) aBad++;
  }
  for (const [t, x] of JX) {
    const [w, rr, hs, wb] = x.v; if (w && wb) { bN++; if (wb.reduce((a, b) => a + b, 0) !== w[0]) bBad++; }
    if (x.st === 'PA' && rr && hs !== null && rr[0] < hs) paBelow++;
  }
  pchk('jobs_tract_file', 'all', 'tracts whose jobs file disagrees with the phase 1 tract file (jobs, 20 sectors)', aBad, 0);
  pchk('od_integrity', 'all', 'work tracts whose origin bands do not sum to the jobs line', bBad, 0);
  pchk('od_integrity', 'all', 'Pennsylvania home tracts with 2024 RAC below the in-state O-D', paBelow, 0);
  report.p2b.tract_counts = { jobs_compared: aN, od_compared: bN };
  // C. the packets' jobs block; D. the packets' transit block (Philadelphia)
  const T = gz('places_transit.json.gz'); const areas2 = gz('places_areas.json.gz').areas;
  const SEC = { retail: 6, edu: 14, health: 15, food: 17, prof: 11, pubadm: 19, fin: 9 };
  for (const dir of fs.readdirSync(pktDir).sort()) {
    const ip = path.join(pktDir, dir, 'inputs.json'); if (dir.startsWith('_') || !fs.existsSync(ip)) continue;
    const I = JSON.parse(fs.readFileSync(ip)); const F = JSON.parse(fs.readFileSync(path.join(pktDir, dir, 'figures.json'))); const RI = I.records || {};
    const J = Work.jobsArea(JX, F.meta.tracts, {}, {});
    if (RI.jobs && J) {
      pchk('packet_jobs', dir, 'jobs.total', J.jobs, RI.jobs.total); pchk('packet_jobs', dir, 'jobs.top_tract', Math.round(J.topTractShare * J.jobs), RI.jobs.top_tract);
      pchk('packet_jobs', dir, 'jobs.top_tract_id', J.topTract, RI.jobs.top_tract_id); pchk('packet_jobs', dir, 'jobs.year', J.year, RI.jobs.year);
      for (const [k, i] of Object.entries(SEC)) if (RI.jobs.sectors && k in RI.jobs.sectors) pchk('packet_jobs', dir, 'jobs.sector.' + k, J.wac[7 + i], RI.jobs.sectors[k]);
      if (RI.jobs.cmp_total !== undefined) { const cw = Work.countyWac(JX, F.meta.tracts[0].slice(0, 5)); pchk('packet_jobs', dir, 'jobs.cmp_total', cw[0], RI.jobs.cmp_total);
        for (const [k, i] of Object.entries(SEC)) if (RI.jobs.cmp_sectors && k in RI.jobs.cmp_sectors) pchk('packet_jobs', dir, 'jobs.cmp_sector.' + k, cw[7 + i], RI.jobs.cmp_sectors[k]); }
    }
    const a = areas2.find(x => x.id === 'pkt:' + F.meta.district_key);
    const tr = RI.transit;
    if (tr && a && a.pkt_line) {
      const s = Work.septaSelect(T, { kind: 'line', geom: a.pkt_line }); const st = Work.stationsSelect(T, { kind: 'line', geom: a.pkt_line }, 400);
      pchk('packet_transit', dir, 'transit.n', s.ons, tr.n); pchk('packet_transit', dir, 'transit.stops', s.stops, tr.stops);
      pchk('packet_transit', dir, 'transit.bus', s.bus, tr.bus); pchk('packet_transit', dir, 'transit.trolley', s.trolley, tr.trolley);
      if (tr.second_path) { pchk('packet_transit', dir, 'transit.at40', s.at40, tr.second_path.buffer_40m); pchk('packet_transit', dir, 'transit.at80', s.at80, tr.second_path.buffer_80m); }
      const mine = st.in.filter(x => x.kind === 'rail_undated').map(x => `${x.nm}:${x.ons}`).sort(); const theirs = (tr.rail || []).filter(x => x.dist_m <= 60).map(x => `${x.name}:${x.n}`).sort();
      pchk('packet_transit', dir, 'transit.rail_within_60m', mine, theirs);
      const fb = F.figures.boardings; if (fb && fb.test && fb.test.gates) {
        pchk('packet_transit', dir, 'transit.G3', s.gates.G3.slice(0, 4), String(fb.test.gates.G3).slice(0, 4)); pchk('packet_transit', dir, 'transit.G5', s.gates.G5.slice(0, 4), String(fb.test.gates.G5).slice(0, 4));
        if (fb.test.gates.buffer_10pct) pchk('packet_transit', dir, 'transit.buffer', s.gates.buffer.slice(0, 4), String(fb.test.gates.buffer_10pct).slice(0, 4));
      }
      const rb = F.figures.rail_boardings; if (rb) pchk('packet_transit', dir, 'transit.rail_total', st.in.filter(x => x.kind === 'rail_undated').reduce((q, x) => q + x.ons, 0), rb.value);
    }
  }
  // E. the 17 City districts: boardings inside the boundary and stop-and-route rows against the phase 1 district tables
  const phl2 = gz('places_phl.json.gz').districts; const SS = T.septa.stops;
  for (const [id, d] of Object.entries(phl2)) {
    const p = d.profile; if (!p || !p.district_id) continue; const s = Work.septaSelect(T, { kind: 'district', id });
    let rowsN = 0; for (let i = 0; i < SS.sc.length; i++) if (SS.ds[i] === +id) rowsN += SS.nrow[i];
    pchk('district_transit', 'district:' + id, 'bus', s.bus, p.bus_weekday_boardings_summer2025); pchk('district_transit', 'district:' + id, 'trolley', s.trolley, p.trolley_weekday_boardings_summer2025);
    pchk('district_transit', 'district:' + id, 'stop_route_rows', rowsN, p.transit_stops_inside);
  }
  // F. SNAP history: the survey cells agree with the tract file; the store history reconciles to the Nov 13 file tract by tract
  let gBad = 0, recon = 0; const offT = [];
  for (const [st, f] of Object.entries(FF)) {
    const C = cols[st]; if (!C) continue;
    for (const [t, c] of Object.entries(f.gap)) { const x = tracts[t]; if (!x) continue; if (x.r[1 + C.indexOf('sn0_e')] !== c[0] || x.r[1 + C.indexOf('sn_e')] !== c[2]) gBad++; }
    for (const t of Object.keys(f.snap_hist)) { recon++; if (!Work.snapHistory(f.snap_hist, [t]).reconciles) offT.push(t); }
  }
  pchk('food', 'all', 'tracts whose B22003 cells disagree with the tract file (households, receiving SNAP)', gBad, 0);
  // store history = end of 2004 + openings - closings = the Nov 13 file, tract by tract. The tracts that do not reconcile must be exactly the
  // documented list (a store whose Nov 13 location is in another tract, or whose type moved to or from farmers market); none other, none missing
  const expT = new Set((EXPL.find(x => x.p2b && x.snap_reconcile_expected) || {}).snap_reconcile_expected || []);
  const unexplainedT = offT.filter(t => !expT.has(t)), missingT = [...expT].filter(t => !offT.includes(t));
  pchk('food', 'all', 'snap_hist.tracts_not_reconciling_and_not_documented', unexplainedT.length, 0);
  pchk('food', 'all', 'snap_hist.documented_tracts_that_now_reconcile', missingT.length, 0);
  if (expT.size && !unexplainedT.length && !missingT.length) { grp('food').explained_list.push({ who: 'all', key: 'snap_hist reconciliation', places: offT.length, reason: (EXPL.find(x => x.snap_reconcile_expected) || {}).reason }); }
  report.p2b.snap_reconcile = { tracts: recon, not_reconciling: offT.length, documented: expT.size };
  if (FF.PA) { pchk('food', 'PA', 'SNAP stores that take WIC, by tract = the statewide count', Object.values(FF.PA.wic).reduce((q, v) => q + v.length, 0), FF.PA.wic_stats.snap_stores_taking_wic);
    pchk('food', 'PA', 'WIC list = matched + unmatched', FF.PA.wic_stats.matched_wic_stores + FF.PA.wic_stats.unmatched_wic_stores, FF.PA.wic_stats.state_list);
    pchk('food', 'PA', 'CEP sites placed + unplaced = the PDE list', FF.PA.cep.length + FF.PA.cep_unplaced.participating + FF.PA.cep_unplaced.not_participating, FF.PA.cep_total); }
  // G. daytime identity: residents + jobs - employed residents equals residents + in-commuters - out-commuters wherever the flows are exact
  let dN = 0, dBad = 0;
  for (const a of areas2) { const J = Work.jobsArea(JX, a.tracts, Object.fromEntries(a.tracts.filter(t => tracts[t]).map(t => { const C = cols[tracts[t].st]; return [t, [tracts[t].r[1 + C.indexOf('lat')], tracts[t].r[1 + C.indexOf('lon')]]]; })), {});
    if (!J || J.internal === null) continue; const d = Work.daytime(1000, 0, J); dN++; if (d.residents + d.inCommuters - d.outCommuters !== d.value) dBad++; }
  pchk('daytime', 'all', 'areas where in/out commuters do not reproduce the daytime estimate', dBad, 0);
  report.p2b.daytime_exact_areas = dN;
  for (const [g, G] of Object.entries(report.p2b.groups)) { console.log(`${G.mismatched ? 'FAIL' : 'ok  '} 2b ${g.padEnd(20)} ${G.compared} checks, ${G.mismatched} mismatches, ${G.explained} explained`);
    for (const m of G.mismatches.slice(0, 10)) console.log('        ', m.who, m.key, 'places=', JSON.stringify(m.places), 'packet=', JSON.stringify(m.packet)); }
  console.log(`phase 2b: ${report.p2b.compared} checks, ${report.p2b.matched} match, ${report.p2b.explained} explained, ${report.p2b.mismatched} unexplained mismatch; SNAP history reconciles in ${report.p2b.snap_reconcile.tracts - report.p2b.snap_reconcile.not_reconciling} of ${report.p2b.snap_reconcile.tracts} tracts, the other ${report.p2b.snap_reconcile.not_reconciling} exactly the documented list; daytime identity exact in ${report.p2b.daytime_exact_areas} named areas`);
} else console.log('phase 2b: transit/jobs/food snapshots not in this folder; 2b checks skipped');
// ---------------------------------------------------------------- final pass (Nov 15): the phase 2a review fixes, and phase 2c (counted apart)
// References outside the repo (they hold no figures in the repo): places_gate_ref/ next to the explained file.
report.final = { compared: 0, matched: 0, mismatched: 0, checks: [] };
{
  const refDir = explainedPath ? path.join(path.dirname(explainedPath), 'places_gate_ref') : null;
  const ref = (n) => refDir && fs.existsSync(path.join(refDir, n)) ? JSON.parse(fs.readFileSync(path.join(refDir, n))) : null;
  const fchk = (who, key, a, b) => { report.final.compared++; const ok = JSON.stringify(a) === JSON.stringify(b); report.final.checks.push({ who, key, places: a, expected: b, ok });
    if (ok) report.final.matched++; else { report.final.mismatched++; console.log('FAIL final', who, key, 'places=', JSON.stringify(a), 'expected=', JSON.stringify(b)); } };
  if (fs.existsSync(path.join(snapDir, 'places_pts_meta.json.gz'))) {
    const R = Rec.load({ meta: gz('places_pts_meta.json.gz'), lic: gz('places_pts_lic.json.gz'), permits: gz('places_pts_permits.json.gz'), parcels: gz('places_pts_parcels.json.gz'),
      sales: gz('places_pts_sales.json.gz'), small: gz('places_pts_small.json.gz') });
    const areas = gz('places_areas.json.gz').areas;
    // 1. the rule-part matcher is the builder's (CL-36): every part of every area matches the same streets as the Python reference
    const pm = ref('places_gate_partmatch_expected.json');
    if (pm) for (const [part, ids] of Object.entries(pm.parts)) fchk('matcher', part, [...Rec.streetIds(R, part)].sort((a, b) => a - b), ids);
    // 2. parcels and owner names at every Philadelphia packet's address rule, against OPA `location` counted with records.in_rule (defect 3)
    const pe = ref('places_gate_parcels_expected.json');
    if (pe) for (const [k, e] of Object.entries(pe.packets)) {
      const a = areas.find(x => x.pkt_folder === k); if (!a || !a.addr) { fchk(k, 'packet area present', false, true); continue; }
      const S = Rec.summarize(R, { kind: 'addr', parts: a.addr.parts });
      fchk(k, 'property.n', S.property.n, e.parcels); fchk(k, 'property.owners_normalized', S.property.owners, e.owners_normalized);
    }
    const fe = ref('places_gate_final_expected.json') || {};
    // 3. CL-19 (defect 2): a permit sentence only when G3, G5 and G7 pass, for every packet; the listed packets offer none
    for (const a of areas.filter(x => x.kind === 'packet' && x.addr)) {
      const S = Rec.summarize(R, { kind: 'addr', parts: a.addr.parts }); const p = S.permits; if (!p || !p.ytd) continue;
      fchk(a.pkt_folder, 'permit sentence offered only when G3, G5 and G7 pass', Rec.permitSayOK(p), p.gates.G3 === 'pass' && p.gates.G5 === 'pass' && p.ytd.this >= 0.9 * p.ytd.last);
      if ((fe.no_permit_sentence_packets || []).includes(a.pkt_folder)) fchk(a.pkt_folder, 'no permit sentence (year to date under 90%)', Rec.permitSayOK(p), false);
      const say = Rec.permitsSay(p, 'x addresses'); fchk(a.pkt_folder, 'no year-to-date sentence when this year is behind', p.ytd.this < p.ytd.last ? !/against/.test(say.support) : true, true);
    }
    // 4. deeds per deed, median on single-property deeds (defect 4)
    for (const d of fe.deeds || []) {
      const sel = d.sel || { kind: 'addr', parts: (areas.find(x => x.pkt_folder === d.packet) || { addr: { parts: [] } }).addr.parts };
      const sl = Rec.summarize(R, sel).sales; fchk(d.who || d.packet, `deeds ${d.year} (documents)`, sl.by_year[d.year], d.documents);
      if (d.median_single) fchk(d.who || d.packet, `median ${d.year}, single-property deeds`, sl.median_price[d.year], d.median_single);
    }
    // 5. SBA floors (defect 6): the unplaced share among the loans the cards show (FY2020 on, mailbox stores out)
    const u = Rec.unplacedSbaShare(R); if (fe.sba_unplaced_fy2020_on) fchk('sba', 'unplaced FY2020-on loans', [u.unplaced, u.n], fe.sba_unplaced_fy2020_on);
    fchk('sba', 'no FY2010-19 loans shipped (defect 9)', [...R.L.sba.c.fy].filter(y => y < 2020).length, 0);
    // dollars tested by address (defect 10)
    const pk = areas.filter(x => x.kind === 'packet' && x.addr).map(a => [a.pkt_folder, Rec.summarize(R, { kind: 'addr', parts: a.addr.parts }).loans]);
    for (const [k, L] of pk) if (L && L.dollars_since) fchk(k, 'SBA dollar test is by address', L.gates.G5_dollars === 'pass', !(L.top_address_dollar_share > 1 / 3));
    // 6. lines trimmed to the published limits (defect 7)
    const tr = (id) => (areas.find(x => x.id === id) || {}).tracts || [];
    for (const [id, n] of Object.entries(fe.tracts || {})) fchk(id, 'tracts after the trim', tr(id).length, n);
    for (const [id, t] of Object.entries(fe.tract_out || {})) fchk(id, t + ' out', tr(id).includes(t), false);
    // East Falls: one part per street, no overlap (review 11)
    for (const a of areas.filter(x => x.addr)) { const by = {}; for (const [st, lo, hi] of a.addr.parts) (by[st] ||= []).push([lo, hi]);
      const overl = Object.values(by).some(rs => rs.sort((x, y) => x[0] - y[0]).some((r, i) => i && r[0] <= rs[i - 1][1])); if (overl) fchk(a.id, 'no overlapping parts', overl, false); }
    fchk('areas', 'no overlapping address parts anywhere', areas.filter(x => x.addr).every(a => { const by = {}; for (const [st, lo, hi] of a.addr.parts) (by[st] ||= []).push([lo, hi]); return Object.values(by).every(rs => rs.sort((x, y) => x[0] - y[0]).every((r, i) => !i || r[0] > rs[i - 1][1])); }), true);
  }
  // review H3 and DW's owner rule (Nov 15): the records files carry their own sha256s; OPA numbers line up with parcels; owner names are firms or the private label
  if (fs.existsSync(path.join(snapDir, 'places_pts_meta.json.gz'))) {
    const crypto = require('crypto'); const pm = gz('places_pts_meta.json.gz');
    for (const f of pm.files) fchk('pts_meta', 'sha256 ' + f.file, f.sha256, fs.existsSync(path.join(snapDir, f.file)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(snapDir, f.file))).digest('hex') : 'missing');
    const PP = gz('places_pts_parcels.json.gz');
    if (fs.existsSync(path.join(snapDir, 'places_pts_pn.json.gz'))) fchk('pts_pn', 'one OPA number per parcel', gz('places_pts_pn.json.gz').pn.length, PP.n);
    const fe2 = ref('places_gate_final_expected.json') || {}; const on = Object.values(PP.owner_names || {});
    if (fe2.owner_names) { fchk('owners', 'owner names listed', on.length, fe2.owner_names.listed);
      fchk('owners', 'non-individual names kept (all others read the private label)', on.filter(x => x !== fe2.owner_names.label).length, fe2.owner_names.kept_non_individual); }
  }
  // 7. versioned files (defect 1): every listed file carries the sha256 of the file in this folder; the meta carries a rev
  const crypto = require('crypto'); const meta = gz('places_meta.json.gz');
  fchk('meta', 'rev present', typeof meta.rev === 'string' && meta.rev.length === 12, true);
  for (const f of meta.files) fchk('meta', 'sha256 ' + f.file, f.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(snapDir, f.file))).digest('hex'));
  // 8. phase 2c: ZIP jobs (PA) sum to the PA tract jobs exactly; stable-ZIP decade cells present; county card covers every comparator county held
  if (fs.existsSync(path.join(snapDir, 'places_zipx.json.gz'))) {
    const ZX = gz('places_zipx.json.gz'); const PA = gz('places_tracts_PA.json.gz'); const jc = PA.cols.indexOf('jobs') + 1;
    fchk('zipx', 'PA jobs by ZIP = PA jobs by tract', Object.values(ZX.zips).reduce((a, z) => a + (z.jobs ? z.jobs[0] : 0), 0), PA.rows.reduce((a, r) => a + (r[jc] || 0), 0));
    fchk('zipx', 'stable ZIPs carried', Object.values(ZX.zips).filter(z => z.d18).length, ZX.stable_n);
    for (const z of Object.values(ZX.zips)) if (z.jobs) { const s = z.jobs.slice(7).reduce((a, b) => a + b, 0); if (s !== z.jobs[0]) { fchk('zipx', 'ZIP sectors sum to the total', s, z.jobs[0]); break; } }
    const CC = gz('places_countycard.json.gz').counties; const counties = gz('places_counties.json.gz').counties;
    const missing = Object.keys(counties).filter(c => !c.startsWith('09') && !CC[c]);
    fchk('countycard', 'every non-Connecticut comparator county has a county card', missing, []);
    for (const [c, k] of Object.entries(CC)) { const bad = (k.sectors || []).filter(s => s.emp === 0); if (bad.length) { fchk('countycard', c + ' withheld sectors shown as withheld, never 0', bad.length, 0); break; } }
    // review H1: no sector of 50+ establishments reads 0 jobs or blank (BLS withholds none that size); a gap row carries an earlier year's figure
    fchk('countycard', 'no 50+ establishment sector shown as 0 or blank this year', Object.values(CC).reduce((a, k) => a + (k.sectors || []).filter(s => s.est >= 50 && !s.gap && !(s.emp > 0)).length, 0), 0);
    // a gap row shows an earlier year's figure (labeled with that year) or, with neither year held in the warehouse (88 rows), reads "not in the file": never 0
    fchk('countycard', 'every gap row carries an earlier year and a figure, or none', Object.values(CC).reduce((a, k) => a + (k.sectors || []).filter(s => s.gap && !(s.emp === null || (s.y < k.qcew_year && s.emp > 0))).length, 0), 0);
  }
  console.log(`final pass: ${report.final.compared} checks, ${report.final.matched} match, ${report.final.mismatched} unexplained mismatch`);
}
console.log(`\n${report.totals.compared} checks, ${report.totals.matched} match, ${report.totals.explained || 0} explained variance, ${report.totals.mismatched} unexplained mismatch (${report.totals.printed_mismatch} on a printed value)`);
console.log(`verdict consistency: ${report.verdicts.compared} checks, ${report.verdicts.ok} ok, ${report.verdicts.failed} failed`);
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
process.exit(report.totals.mismatched || report.verdicts.failed || report.records.mismatched || (report.p2b && report.p2b.mismatched) || (report.final && report.final.mismatched) ? 1 : 0);
