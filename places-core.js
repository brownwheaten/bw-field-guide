/* B+W Field Guide, Places: core figures and margin rules (v1.1, Nov 2026).
   A JavaScript copy of the packet builder's survey rules (templates/builder/lib/select.py and fmt.py, Nov 14 version):
   sums with root-sum-of-squares margins, the Census proportion formula, gates G2, G3, G5 and the decade-change test.
   The release test (test/places_gate.mjs) rebuilds the 14 packets' survey figures from the snapshot files with these
   functions and fails on any mismatch. No data lives in this file. Loaded in the browser and in Node. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ number rules (select.py, fmt.py)
  const rss = (...m) => Math.sqrt(m.reduce((s, x) => s + (x || 0) ** 2, 0));
  function propMoe(x, mx, n, mn) {            // Census Bureau formula for the margin of p = x/n; falls back to the ratio form
    if (!n) return null;
    const p = x / n;
    let rad = mx ** 2 - (p ** 2) * (mn ** 2);
    if (rad < 0) rad = mx ** 2 + (p ** 2) * (mn ** 2);
    return Math.sqrt(rad) / n;
  }
  const hu = (x) => Math.sign(x) * Math.round(Math.abs(x) + 1e-9);   // ROUND_HALF_UP on the printed value
  const pct0 = (p) => String(hu(p * 100));
  const comma = (n) => hu(n).toLocaleString('en-US');
  const round = (n, unit) => (hu(n / unit) * unit).toLocaleString('en-US');
  function fraction(p) {                      // spec 4.9 bands, on the whole-percent value
    const w = hu(p * 100);
    const T = [[8, 12, 'one in ten'], [13, 15, 'one in seven'], [16, 17, 'one in six'], [18, 22, 'one in five'], [23, 27, 'one in four'],
      [28, 31, 'three in ten'], [32, 35, 'one in three'], [48, 52, 'half']];
    for (const [lo, hi, w2] of T) if (w >= lo && w <= hi) return w2;
    return null;
  }
  const NOUNS = { person: ['neighbor', 'neighbors', 'resident', 'residents'], household: ['household', 'households', 'household', 'households'],
    worker: ['working neighbor', 'working neighbors', 'worker', 'workers'] };
  function sharePhrase(p, unit, verbs, lead = true) {
    const [sing, plur] = verbs; const [, nn, , cn] = NOUNS[unit]; const noun = lead ? nn : cn;
    if (!lead) return `${pct0(p)}% of ${noun} ${plur}`;
    const fr = fraction(p);
    if (fr === 'half') return `half of ${noun} ${plur}`;
    if (fr && fr.startsWith('one in')) return `${fr} ${noun} ${sing}`;
    if (fr) return `${fr} ${noun} ${plur}`;
    return `${pct0(p)}% of ${noun} ${plur}`;
  }
  const usdK = (n) => '$' + (hu(n / 1000) * 1000).toLocaleString('en-US');
  function usdBig(n) {
    if (n >= 1e9) return '$' + (Math.round(n / 1e8) / 10).toFixed(1) + ' billion';
    return '$' + (hu(n / 1e7) * 10).toLocaleString('en-US') + ' million';
  }
  const residents = (n, where) => (where === 'head' && n >= 20000) ? round(n, 1000) : round(n, 100);

  // ------------------------------------------------------------------ measures (the packet's TRAITS and NEED, plus DW's Nov 14 additions)
  // id: [num, num moe, base, base moe, unit, lead-eligible, polarity, verbs, label, table, group, flags]
  const TRAITS = {
    born_abroad: ['fb_e', 'fb_m', 'pop_e', 'pop_m', 'person', true, 'neutral', ['was born in another country', 'were born in another country'], 'Born in another country', 'B05002'],
    lang_other: ['lo_e', 'lo_m', 'c5_e', 'c5_m', 'person', true, 'neutral', ['speaks a language other than English at home', 'speak a language other than English at home'], 'Language other than English at home (5+)', 'C16001'],
    no_car: ['nv_e', 'nv_m', 'hh_e', 'hh_m', 'household', true, 'neutral', ['has no car', 'have no car'], 'Households with no car', 'B25044'],
    u18: ['u18_e', 'u18_m', 'pop_e', 'pop_m', 'person', true, 'neutral', ['is under 18', 'are under 18'], 'Under 18', 'B01001'],
    a1824: ['a1824_e', 'a1824_m', 'pop_e', 'pop_m', 'person', true, 'neutral', ['is 18 to 24', 'are 18 to 24'], 'Aged 18 to 24', 'B01001'],
    a65: ['a65_e', 'a65_m', 'pop_e', 'pop_m', 'person', true, 'neutral', ['is 65 or older', 'are 65 or older'], '65 and over', 'B01001'],
    transit_walk: ['tw_e', 'tw_m', 'wk_e', 'wk_m', 'worker', true, 'neutral', ['commutes by transit or on foot', 'commute by transit or on foot'], 'Commute by transit or on foot', 'B08301'],
    renters: ['rent_e', 'rent_m', 'hh_e', 'hh_m', 'household', false, 'neutral', ['rents its home', 'rent their homes'], 'Renter households', 'B25044'],
  };
  const NEED = {
    no_car: ['nv_e', 'nv_m', 'hh_e', 'hh_m', 'have no car', 'household'],
    snap: ['sn_e', 'sn_m', 'sn0_e', 'hh_m', 'receive SNAP benefits', 'household'],
    lvw: ['lvw_e', 'lvw_m', 'c5_e', 'c5_m', 'speak English less than very well', 'person'],
    kids: ['hhk_e', 'hhk_m', 'hh_e', 'hh_m', 'have children under 18', 'household'],
    a65: ['a65_e', 'a65_m', 'pop_e', 'pop_m', 'are 65 or older', 'person'],
  };
  // Shares that are not packet traits (shown with the same verdicts; flagged where the spec keeps them off a sheet)
  const EXTRA = {
    naturalized: ['nat_e', 'nat_m', 'fb_e', 'fb_m', 'Naturalized citizens, among residents born abroad', 'B05002_014', 'person', { base: 'born abroad' }],
    noncitizen: ['ncit_e', 'ncit_m', 'fb_e', 'fb_m', 'Not a U.S. citizen, among residents born abroad', 'B05002_021', 'person', { base: 'born abroad', internal: true }],
    lvw: ['lvw_e', 'lvw_m', 'c5_e', 'c5_m', 'Speak English less than very well (5+)', 'C16001', 'person', {}],
    kids: ['hhk_e', 'hhk_m', 'hh_e', 'hh_m', 'Households with children under 18', 'B11005', 'household', {}],
    snap: ['sn_e', 'sn_m', 'sn0_e', 'sn0_m', 'Households receiving SNAP', 'B22003', 'household', { need: true }],
    poverty: ['pv_e', 'pv_m', 'pvu_e', 'pvu_m', 'Below the poverty line', 'B17001', 'person', { internal: true, notsheet: 'poverty' }],
    ba: ['ba_e', 'ba_m', 'a25_e', 'a25_m', "Bachelor's degree or more (25+)", 'curated pop25_bachelors_plus / B01001 25+', 'person', {}],
    drove: ['da_e', 'da_m', 'wk_e', 'wk_m', 'Drive alone to work', 'B08301_003', 'worker', {}],
    wfh: ['wfh_e', 'wfh_m', 'wk_e', 'wk_m', 'Work from home', 'B08301_021', 'worker', {}],
    hisp: ['hsp_e', 'hsp_m', 'pop_e', 'pop_m', 'Hispanic or Latino', 'B03002 (curated)', 'person', { internal: true, notsheet: 'race' }],
    black: ['bnh_e', 'bnh_m', 'pop_e', 'pop_m', 'Black, not Hispanic', 'B03002 (curated)', 'person', { internal: true, notsheet: 'race' }],
    white: ['wnh_e', 'wnh_m', 'pop_e', 'pop_m', 'White, not Hispanic', 'B03002 (curated)', 'person', { internal: true, notsheet: 'race' }],
    asian: ['anh_e', 'anh_m', 'pop_e', 'pop_m', 'Asian, not Hispanic', 'B03002 (curated)', 'person', { internal: true, notsheet: 'race' }],
  };
  const ENROLL = [['enr_pre', 'Nursery or preschool'], ['enr_k', 'Kindergarten'], ['enr_18', 'Grades 1 to 8'], ['enr_912', 'Grades 9 to 12'], ['enr_col', 'College or graduate school']];
  // School enrollment by level, by tract (B14007, added Nov 14 night). Shares of everyone enrolled (age 3+), plus the college share of residents 3+.
  // id: [num, num moe, base, base moe, label]
  const ENROLL_T = {
    en_pre: ['enp_e', 'enp_m', 'enr_e', 'enr_m', 'Preschool (nursery school)'],
    en_k12: ['enk12_e', 'enk12_m', 'enr_e', 'enr_m', 'Kindergarten to grade 12'],
    en_ug: ['enug_e', 'enug_m', 'enr_e', 'enr_m', 'Undergraduate college'],
    en_gr: ['engr_e', 'engr_m', 'enr_e', 'enr_m', 'Graduate or professional school'],
    en_college: ['encol_e', 'encol_m', 'en3_e', 'en3_m', 'In college or graduate school, among residents 3 and over'],
  };

  // ------------------------------------------------------------------ sums (queries.sql A, agg CTE)
  const SUMMED = ['pop_e', 'hh_e', 'hhk_e', 'occ_e', 'nv_e', 'rent_e', 'a1824_e', 'u18_e', 'a65_e', 'a25_e', 'fb_e', 'nat_e', 'ncit_e', 'wk_e', 'tw_e', 'da_e', 'wfh_e',
    'sn0_e', 'sn_e', 'pvu_e', 'pv_e', 'c5_e', 'lo_e', 'lvw_e', 'ai_e', 'hu_e', 'ba_e', 'hsp_e', 'wnh_e', 'bnh_e', 'anh_e',
    'hh18_e', 'pop18_e', 'fb18_e', 'nv18_e', 'sn18_e',
    'en3_e', 'enr_e', 'enp_e', 'enk12_e', 'enug_e', 'engr_e', 'encol_e', 'en318_e', 'enr18_e', 'col18_e'];
  const PLAIN = ['cur_pop', 'cur_hh', 'hh18hu_e', 'core18_hu', 'p20', 'pop2020', 'snap_n', 'snap_sup', 'snap_gro', 'snap_conv', 'snap_fm', 'snap_spec', 'snap_oth', 'snap_rmp',
    'lf', 'lf_snap', 'lf_wic', 'lf_fmnp', 'jobs'];

  /** rows: array of {t, get(col)} ; returns W in the packet's agg shape */
  function aggregate(rows, cols) {
    const ix = {}; cols.forEach((c, i) => { ix[c] = i + 1; });    // row[0] is the tract id
    const val = (r, c) => (ix[c] === undefined ? null : r[ix[c]]);
    const W = { n_tracts: rows.length, n_missing: 0, tracts: rows.map(r => r[0]) };
    for (const k of SUMMED) {
      const m = k.replace(/_e$/, '_m'); let s = 0, q = 0, any = false;
      for (const r of rows) { const v = val(r, k); if (v !== null && v !== undefined) { s += v; any = true; } const mm = val(r, m); if (mm !== null && mm !== undefined) q += mm * mm; }
      W[k] = any ? s : null; W[m] = Math.sqrt(q);
    }
    for (const k of PLAIN) { let s = 0, any = false; for (const r of rows) { const v = val(r, k); if (v !== null && v !== undefined) { s += v; any = true; } } W[k] = any ? s : null; }
    for (const r of rows) if (val(r, 'pop_e') === null) W.n_missing++;
    const meds = rows.map(r => val(r, 'med')).filter(v => v !== null && v > 0);
    W.med_min = meds.length ? Math.min(...meds) : null; W.med_max = meds.length ? Math.max(...meds) : null; W.med_n = meds.length;
    // language groups, countries of birth, job sectors (sums; margins RSS)
    const sumKeys = (prefix) => cols.filter(c => c.startsWith(prefix) && c.endsWith('_e'));
    W.langs = sumKeys('lang').map(c => { let s = 0, q = 0; for (const r of rows) { s += val(r, c) || 0; q += (val(r, c.replace(/_e$/, '_m')) || 0) ** 2; } return [s, Math.sqrt(q)]; });
    W.cob = sumKeys('cob').map(c => { let s = 0, q = 0; for (const r of rows) { s += val(r, c) || 0; q += (val(r, c.replace(/_e$/, '_m')) || 0) ** 2; } return [s, Math.sqrt(q)]; });
    W.cns = cols.filter(c => /^cns\d\d$/.test(c)).map(c => rows.reduce((s, r) => s + (val(r, c) || 0), 0));
    // per-tract rows for concentration tests (G5)
    W.tract_traits = rows.map(r => ({ t: r[0], pop: val(r, 'pop_e') || 0, a1824: val(r, 'a1824_e') || 0, u18: val(r, 'u18_e') || 0, a65: val(r, 'a65_e') || 0,
      hh: val(r, 'hh_e') || 0, nv: val(r, 'nv_e') || 0, rent: val(r, 'rent_e') || 0, fb: val(r, 'fb_e') || 0, wk: val(r, 'wk_e') || 0, tw: val(r, 'tw_e') || 0,
      c5: val(r, 'c5_e') || 0, lo: val(r, 'lo_e') || 0, jobs: val(r, 'jobs') || 0 }));
    return W;
  }

  // ------------------------------------------------------------------ figures (select.py make_figures, survey part)
  const gate = (passed, why) => passed ? 'pass' : `FAIL: ${why}`;
  const fmt0 = (n) => Math.round(n).toLocaleString('en-US');
  const TT_KEYS = { a1824: ['a1824', 'pop'], u18: ['u18', 'pop'], a65: ['a65', 'pop'], born_abroad: ['fb', 'pop'], no_car: ['nv', 'hh'], renters: ['rent', 'hh'], transit_walk: ['tw', 'wk'], lang_other: ['lo', 'c5'] };

  function concentration(TT, t) {
    if (!TT || !TT.length || !TT_KEYS[t]) return null;
    const [xk, bk] = TT_KEYS[t]; const tot = TT.reduce((s, r) => s + r[xk], 0); const bt = TT.reduce((s, r) => s + r[bk], 0);
    if (!tot || !bt) return null;
    const srt = [...TT].sort((a, b) => b[xk] - a[xk]); const top1 = srt[0][xk] / tot;
    const top3 = srt.slice(0, 3).reduce((s, r) => s + r[xk], 0) / tot; const base3 = srt.slice(0, 3).reduce((s, r) => s + r[bk], 0) / bt;
    const ok1 = top1 <= 0.5; const ok3 = !(top3 > 2 / 3 && top3 > 1.5 * base3);
    return { top_tract: srt[0].t, top1_share: top1, top3: srt.slice(0, 3).map(r => r.t), top3_share: top3, top3_base_share: base3, pass: ok1 && ok3,
      why: (ok1 ? '' : `tract ${srt[0].t} holds ${Math.round(top1 * 100)}%`) + (ok3 ? '' : `${ok1 ? '' : '; '}tracts ${srt.slice(0, 3).map(r => r.t).join(', ')} hold ${Math.round(top3 * 100)}% of it and ${Math.round(base3 * 100)}% of the base`) };
  }

  /** W: area sums, Cm: comparator sums, cmpMedian {e,m}, cmpLabel; returns {figs, notes} in figures.json shape (survey part) */
  function makeFigures(W, Cm, cmpMedian, cmpLabel) {
    const figs = {}; const notes = [];
    const fig = (name, value, kw = {}) => { figs[name] = Object.assign({ id: name, value, moe90: null, comparator: null, test: null }, kw); return figs[name]; };
    const pop = W.pop_e, popm = W.pop_m, hh = W.hh_e, hhm = W.hh_m;
    fig('res_wa', pop, { moe90: popm, comparator: { area: cmpLabel, value: Cm.pop_e, moe90: Cm.pop_m }, format: 'residents' });
    fig('hh_wa', hh, { moe90: hhm, comparator: { area: cmpLabel, value: Cm.hh_e, moe90: Cm.hh_m }, format: 'r100' });
    const ai = W.ai_e, aim = W.ai_m;
    fig('agg_income', ai, { moe90: aim, comparator: { area: cmpLabel, value: Cm.ai_e, moe90: Cm.ai_m }, format: 'usd_big',
      test: { moe_share: ai ? aim / ai : null, gates: { G2: gate(ai && aim / ai <= 0.30, 'margin over 30%') } } });

    function change(name, e24, m24, e18, m18, ce24, ce18, label, adj) {
      const d = e24 - e18, m = rss(m18, m24), pct = e18 ? d / e18 : 0, cpct = ce24 / ce18 - 1;
      let g2 = d > 1.1 * m, g3 = pct >= 0.10 && (pct - cpct) >= 0.05;
      const gates = { G2: gate(g2, `change ${fmt0(d)} not beyond 1.1 x margin ${fmt0(m)}`), G3: gate(g3, `change ${(pct * 100).toFixed(1)}% vs comparator ${(cpct * 100).toFixed(1)}% (needs 10% and 5 pts above)`) };
      const test = { delta: d, moe: m, pct, cmp_pct: cpct, excess_over_comparator_pts: (pct - cpct) * 100, gates };
      let printed = d;
      if (adj) {
        const da = adj[0] - e18, pa = e18 ? da / e18 : 0, cpa = adj[1] / ce18 - 1;
        const g2a = da > 1.1 * m, g3a = pa >= 0.10 && (pa - cpa) >= 0.05;
        gates['G2-occupancy-held'] = gate(g2a, `at the 2014-18 occupancy rate the change is ${fmt0(da)}, not beyond 1.1 x margin ${fmt0(m)}`);
        gates['G3-occupancy-held'] = gate(g3a, `at the 2014-18 occupancy rate ${(pa * 100).toFixed(1)}% vs comparator ${(cpa * 100).toFixed(1)}%`);
        Object.assign(test, { delta_occupancy_held: da, pct_occupancy_held: pa, cmp_pct_occupancy_held: cpa });
        g2 = g2 && g2a; g3 = g3 && g3a; printed = Math.min(d, da);
      }
      test.printed_value = printed;
      // "no measurable change" (design 3.4): the change is inside 1.1 times its combined margin, either direction
      test.measurable = Math.abs(d) > 1.1 * m;
      fig(name, d, { moe90: m, comparator: { area: cmpLabel, value: ce24 - ce18, moe90: null, pct: cpct }, test, label, format: 'r100', base18: e18 });
      return g2 && g3;
    }
    const have18 = W.hh18_e !== null && W.pop18_e !== null;
    if (have18) {
      let occAdj = null;
      if (W.core18_hu && Cm.core18_hu && W.hu_e && Cm.hu_e) occAdj = [W.hu_e * W.hh18_e / W.core18_hu, Cm.hu_e * Cm.hh18_e / Cm.core18_hu];
      change('hh_change', hh, hhm, W.hh18_e, W.hh18_m, Cm.hh_e, Cm.hh18_e, 'Households, 2014-18 to 2020-24', occAdj);
      change('pop_change', pop, popm, W.pop18_e, W.pop18_m, Cm.pop_e, Cm.pop18_e, 'Residents, 2014-18 to 2020-24');
      const p20 = W.p20; const backed = !!(p20 && W.pop18_e < p20 && p20 <= pop * 1.05);
      figs.pop_change.test.backed_by_2020_count = { p20, pass: backed };
      change('fb_change', W.fb_e, W.fb_m, W.fb18_e, W.fb18_m, Cm.fb_e, Cm.fb18_e, 'Born in another country, 2014-18 to 2020-24');
      change('nv_change', W.nv_e, W.nv_m, W.nv18_e, W.nv18_m, Cm.nv_e, Cm.nv18_e, 'Households with no car, 2014-18 to 2020-24');
      change('sn_change', W.sn_e, W.sn_m, W.sn18_e, W.sn18_m, Cm.sn_e, Cm.sn18_e, 'Households receiving SNAP, 2014-18 to 2020-24');
    }

    const trRes = {};
    for (const [t, [xk, xm, nk, nm, unit, leadOk, pol, verbs, label, tbl]] of Object.entries(TRAITS)) {
      if (!W[nk] || !Cm[nk]) continue;
      const p = W[xk] / W[nk], pm = propMoe(W[xk], W[xm], W[nk], W[nm]);
      const pc = Cm[xk] / Cm[nk], pcm = propMoe(Cm[xk], Cm[xm], Cm[nk], Cm[nm]);
      const lvl = p ? pm / p <= 0.30 : false; const beyond = Math.abs(p - pc) > rss(pm, pcm); const ratio = pc ? p / pc : 0;
      const lead = leadOk && ratio >= 1.5 && (p - pc) >= 0.05; const sup = ratio >= 1.25;
      const conc = concentration(W.tract_traits, t); const g5 = conc ? conc.pass : true;
      trRes[t] = { p, pm, pc, pcm, ratio, lead: lead && lvl && beyond && g5, support: sup && lvl && beyond && g5 };
      const gts = { G2: gate(lvl && beyond, !lvl ? 'level margin over 30%' : 'gap inside combined margin'),
        G3: gate(leadOk ? lead : sup, `ratio ${ratio.toFixed(2)}, ${((p - pc) * 100).toFixed(1)} pts` + (leadOk ? '' : ' (support only)')),
        G5: conc ? gate(g5, conc.why) : 'not tested (no tract rows)' };
      fig(`trait_${t}`, p, { moe90: pm, comparator: { area: cmpLabel, value: pc, moe90: pcm }, count: W[xk], count_moe: W[xm], label, table: tbl, unit, verbs, polarity: pol,
        format: 'share', test: { ratio, diff_pts: (p - pc) * 100, beyond_margin: beyond, concentration: conc, gates: gts } });
    }
    const needRes = {};
    for (const [t, [xk, xm, nk, nm, words, unit]] of Object.entries(NEED)) {
      if (!W[nk]) continue;
      const p = W[xk] / W[nk], pm = propMoe(W[xk], W[xm], W[nk], W[nm]), pc = Cm[xk] / Cm[nk], pcm = propMoe(Cm[xk], Cm[xm], Cm[nk], Cm[nm]);
      const ok = p > pc && Math.abs(p - pc) > rss(pm, pcm) && pm / p <= 0.30;
      needRes[t] = { p, pm, pc, pcm, ok };
      fig(`need_${t}`, p, { moe90: pm, comparator: { area: cmpLabel, value: pc, moe90: pcm }, count: W[xk], polarity: 'need', format: 'share', words, unit,
        test: { gates: { G2: gate(ok, 'not above the comparator beyond the combined margin, or level margin over 30%') } } });
    }
    // one use per sheet (spec 4.8) and the CL-32 floor: a passing need fact keeps that trait off the front
    let needsPre = ['no_car', 'snap', 'lvw', 'kids', 'a65'].filter(t => needRes[t] && needRes[t].ok).slice(0, 2);
    if (needsPre.length === 1 && needRes[needsPre[0]].p < 1.25 * needRes[needsPre[0]].pc) needsPre = [];
    for (const t of needsPre) if (trRes[t] && (trRes[t].lead || trRes[t].support)) {
      trRes[t].lead = trRes[t].support = false;
      figs[`trait_${t}`].test.gates['G6-one-use'] = 'FAIL: used as a need fact in the statement of need, so it stays off the front (spec 4.8)';
    }
    figs._statement_of_need = needsPre;
    fig('tract_median_range', W.med_max, { low: W.med_min, high: W.med_max, n_tracts: W.med_n, comparator: { area: cmpLabel, value: cmpMedian ? cmpMedian.e : null, moe90: cmpMedian ? cmpMedian.m : null }, format: 'usd_k' });
    if (cmpMedian) fig('cmp_median', cmpMedian.e, { moe90: cmpMedian.m, format: 'usd_k' });
    if (have18) {
      fig('hh18_base', W.hh18_e, { moe90: W.hh18_m }); fig('pop18_base', W.pop18_e, { moe90: W.pop18_m }); fig('fb18_base', W.fb18_e, { moe90: W.fb18_m });
    }
    fig('n_tracts', W.n_tracts);
    // shares beyond the packet traits (same tests)
    for (const [id, [xk, xm, nk, nm, label, tbl, unit, fl]] of Object.entries(EXTRA)) {
      if (!W[nk] || W[xk] === null || W[xk] === undefined) continue;
      const p = W[xk] / W[nk], pm = propMoe(W[xk], W[xm], W[nk], W[nm]);
      const hasC = Cm && Cm[nk] && Cm[xk] !== null && Cm[xk] !== undefined;
      const pc = hasC ? Cm[xk] / Cm[nk] : null, pcm = hasC ? propMoe(Cm[xk], Cm[xm], Cm[nk], Cm[nm]) : null;
      fig(`x_${id}`, p, { moe90: pm, comparator: hasC ? { area: cmpLabel, value: pc, moe90: pcm } : null, count: W[xk], count_moe: W[xm], label, table: tbl, unit, flags: fl, format: 'share',
        test: { ratio: pc ? p / pc : null, beyond_margin: hasC ? Math.abs(p - pc) > rss(pm, pcm) : null } });
    }
    // school enrollment by level, by tract (B14007): same share tests, no strength tag (not a packet trait)
    if (W.enr_e) for (const [id, [xk, xm, nk, nm, label]] of Object.entries(ENROLL_T)) {
      if (!W[nk] || W[xk] === null || W[xk] === undefined) continue;
      const p = W[xk] / W[nk], pm = propMoe(W[xk], W[xm], W[nk], W[nm]);
      const hasC = Cm && Cm[nk] && Cm[xk] !== null && Cm[xk] !== undefined;
      const pc = hasC ? Cm[xk] / Cm[nk] : null, pcm = hasC ? propMoe(Cm[xk], Cm[xm], Cm[nk], Cm[nm]) : null;
      fig(`x_${id}`, p, { moe90: pm, comparator: hasC ? { area: cmpLabel, value: pc, moe90: pcm } : null, count: W[xk], count_moe: W[xm], label, table: 'B14007', unit: 'person',
        flags: { enroll: true }, format: 'share', test: { ratio: pc ? p / pc : null, beyond_margin: hasC ? Math.abs(p - pc) > rss(pm, pcm) : null } });
    }
    // college and graduate students a decade ago (2014-18 B14007 moved to 2020 tracts with the same population-weight crosswalk)
    if (W.col18_e !== null && W.col18_e !== undefined && W.encol_e !== null && W.encol_e !== undefined && Cm && Cm.col18_e && Cm.encol_e !== null && Cm.encol_e !== undefined)
      change('col_change', W.encol_e, W.encol_m, W.col18_e, W.col18_m, Cm.encol_e, Cm.col18_e, 'College and graduate students, 2014-18 to 2020-24');
    // jobs (M3): count, top tract share
    if (W.jobs !== null && W.jobs !== undefined) {
      const top = W.tract_traits.reduce((a, r) => r.jobs > a.jobs ? r : a, { jobs: -1 });
      fig('jobs', W.jobs, { cmp_total: Cm.jobs, top_tract_share: W.jobs ? top.jobs / W.jobs : null, top_tract: top.t, cns: W.cns, cmp_cns: Cm.cns, format: 'r100',
        test: { gates: { G5: gate(W.jobs && top.jobs / W.jobs <= 0.5, `tract ${top.t} holds ${W.jobs ? Math.round(top.jobs / W.jobs * 100) : 0}%`) } } });
    }
    return { figs, notes };
  }

  // ------------------------------------------------------------------ verdicts (design 3.4)
  /** returns {word, cls, mark, detail, range} for a share or count figure */
  function verdict(f, kind = 'share') {
    if (f.value === null || f.value === undefined || Number.isNaN(f.value)) return { word: 'not held', cls: 'none', mark: '–' };
    const m = f.moe90;
    if (m === null || m === undefined) return { word: 'no margin', cls: 'plain', mark: '·' };
    const rel = f.value ? Math.abs(m / f.value) : Infinity;
    if (rel > 0.30) {
      const lo = Math.max(0, f.value - m), hi = f.value + m;
      return { word: 'rough', cls: 'rough', mark: '≈', range: [lo, hi], detail: 'margin is more than 30% of the figure' };
    }
    if (kind === 'share' && f.comparator && f.comparator.value !== null && f.comparator.value !== undefined && f.comparator.moe90 !== null && f.comparator.moe90 !== undefined) {
      const inside = Math.abs(f.value - f.comparator.value) <= rss(m, f.comparator.moe90);
      if (inside) return { word: "inside the margin: don't quote a difference", cls: 'inside', mark: '=', detail: `can't say it differs from ${f.comparator.area}` };
      const ratio = f.value / f.comparator.value, diff = f.value - f.comparator.value;
      const tag = (ratio >= 1.5 && diff >= 0.05) ? 'sheet strength' : ratio >= 1.25 ? 'support only' : 'not distinctive';
      return { word: 'solid', cls: 'solid', mark: '✓', detail: (diff > 0 ? 'above ' : 'below ') + f.comparator.area, tag };
    }
    return { word: 'solid', cls: 'solid', mark: '✓' };
  }
  function changeVerdict(f) {
    if (!f || !f.test) return { word: 'not held', cls: 'none', mark: '–' };
    if (!f.test.measurable) return { word: 'no measurable change', cls: 'inside', mark: '=', detail: 'the change is inside 1.1 times its combined margin' };
    // households (packet gate G2b): a rise must also clear 1.1 times the margin with the 2014-18 occupancy rate held
    const t = f.test;
    if (f.value > 0 && t.delta_occupancy_held !== undefined && !(t.delta_occupancy_held > 1.1 * t.moe))
      return { word: 'not firm: inside the margin once occupancy is held', cls: 'inside', mark: '=',
        detail: 'with the 2014-18 occupancy rate the change is ' + Math.round(t.delta_occupancy_held), held: true };
    if (f.value < 0) return { word: 'measurable decline', cls: 'solid', mark: '↓', tag: 'not for a sheet (declines)' };
    return { word: 'measurable rise', cls: 'solid', mark: '↑' };
  }

  /** the working tag beside a solid share (design 3.4 plus packet gates G5, one-use and the renters rule; review defect 5).
      id: the figure id (trait_x, x_y); v: verdict(f). Returns the tag text or null. Only packet traits carry a strength tag. */
  function sheetTag(id, f, v) {
    if (!v || v.cls !== 'solid' || !v.tag) return null;
    if (!id.startsWith('trait_')) return null;
    const g = (f.test && f.test.gates) || {};
    if (g['G6-one-use']) return 'used as a need fact: off the front';
    if (f.comparator && f.value < f.comparator.value) return `below ${f.comparator.area === 'Philadelphia' ? 'the city' : f.comparator.area}: not for the front`;
    if (f.test && f.test.concentration && !f.test.concentration.pass) return null;     // the "concentrated" tag says why
    if (id === 'trait_renters' && v.tag === 'sheet strength') return 'support only';   // renters are never lead-eligible (spec)
    return v.tag;
  }

  const Core = { rss, sheetTag, propMoe, hu, pct0, comma, round, fraction, sharePhrase, usdK, usdBig, residents, TRAITS, NEED, EXTRA, ENROLL, ENROLL_T, aggregate, concentration, makeFigures, verdict, changeVerdict, VERSION: '1.1.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.BWPlacesCore = Core;
})(typeof self !== 'undefined' ? self : this);
