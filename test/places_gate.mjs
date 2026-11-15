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
const report = { run: new Date().toISOString(), tolerance_rel: REL, packets: [], totals: { compared: 0, matched: 0, mismatched: 0, printed_mismatch: 0 } };

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
  report.packets.push(res);
  console.log(`${res.mismatches.length ? 'FAIL' : 'ok  '} ${dir.padEnd(32)} ${res.checks.length} checks, ${res.mismatches.length} mismatches, ${(res.explained || []).length} explained${missing.length ? ', missing tracts ' + missing.join(' ') : ''}`);
  for (const m of res.mismatches.slice(0, 12)) console.log('       ', m.fid, m.key, 'places=', m.places, 'packet=', m.packet);
}
console.log(`\n${report.totals.compared} checks, ${report.totals.matched} match, ${report.totals.explained || 0} explained variance, ${report.totals.mismatched} unexplained mismatch (${report.totals.printed_mismatch} on a printed value)`);
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
process.exit(report.totals.mismatched ? 1 : 0);
