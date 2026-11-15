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
      const c3 = Object.values(F.text || {}).flat().find(x => x && typeof x === 'object' && x.slot === 'F7.3' && x.rule === 'S1');
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
console.log(`\n${report.totals.compared} checks, ${report.totals.matched} match, ${report.totals.explained || 0} explained variance, ${report.totals.mismatched} unexplained mismatch (${report.totals.printed_mismatch} on a printed value)`);
console.log(`verdict consistency: ${report.verdicts.compared} checks, ${report.verdicts.ok} ok, ${report.verdicts.failed} failed`);
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
process.exit(report.totals.mismatched || report.verdicts.failed || report.records.mismatched ? 1 : 0);
