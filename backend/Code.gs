/**
 * B+W Field Guide — backend (Google Apps Script web app).
 * Runs as Darryl Wooten. The field guide app (GitHub Pages) talks only to this.
 *
 * Script properties (Project Settings → Script properties):
 *   TOKEN_HASH      required  SHA-256 hex of the field guide passphrase token (Claude gives you this value)
 *   BQ_PROJECT      optional  default bw-national-insights-001
 *   BQ_DATASET      optional  default national_insights
 *   MEDIA_FOLDER_ID optional  created automatically on first photo ("B+W Field Guide media")
 *   APOLLO_KEY      optional  Apollo API key, for "Look up in Apollo"
 *   HUBSPOT_TOKEN   optional  HubSpot private app token, for "Add to HubSpot"
 *   SHEET_ID        optional  B+W Field Notes (responses) sheet; captures are mirrored to a "Guide captures" tab
 *   BOOKING_URL     optional  private appointment-schedule link, used only by "Send booking link" (never put it in the repo)
 *   PUSH_URL        optional  phase 2: push helper endpoint; PUSH_SECRET its shared secret
 */

const P = PropertiesService.getScriptProperties();
const BQ_PROJECT = () => P.getProperty('BQ_PROJECT') || 'bw-national-insights-001';
const BQ_DATASET = () => P.getProperty('BQ_DATASET') || 'national_insights';

function doGet() {
  return json_({ ok: true, service: 'bw-field-guide', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (!checkToken_(req.token)) return json_({ ok: false, error: 'unauthorized' });
  try {
    const fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: 'unknown_action' });
    return json_(Object.assign({ ok: true }, fn(req.data || {})));
  } catch (err) {
    console.error(req.action, err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

const ACTIONS = {
  ping: () => ({ pong: true, apollo: !!P.getProperty('APOLLO_KEY'), hubspot: !!P.getProperty('HUBSPOT_TOKEN') }),
  getPlan: (d) => getPlan_(d.date),
  listPlans: () => listPlans_(),
  savePlan: (d) => savePlan_(d),
  saveCapture: (d) => saveCapture_(d),
  listCaptures: (d) => listCaptures_(d),
  setFollowup: (d) => setFollowup_(d),
  apollo: (d) => apollo_(d),
  hubspot: (d) => hubspot_(d),
  pois: (d) => pois_(d),
  searchPois: (d) => searchPois_(d),
  updateCapture: (d) => updateCapture_(d),
  deleteCapture: (d) => deleteCapture_(d),
  getWaiting: () => getWaiting_(),
  markHandled: (d) => markHandled_(d),
  getToday: () => getToday_(),
  getPulse: () => getPulse_(),
  sendBookingLink: (d) => sendBookingLink_(d),
  bookingText: (d) => ({ text: bookingText_(d.first) }),
};

// ---------- helpers ----------
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function checkToken_(t) {
  const want = P.getProperty('TOKEN_HASH');
  if (!want || !t) return false;
  const got = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(t), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return got === want;
}
function bq_(sql, params) {
  const req = { query: sql, useLegacySql: false, parameterMode: 'NAMED', queryParameters: params || [] };
  let res = BigQuery.Jobs.query(req, BQ_PROJECT());
  const jobId = res.jobReference.jobId, loc = res.jobReference.location;
  let n = 0;
  while (!res.jobComplete && n++ < 30) {
    Utilities.sleep(500);
    res = BigQuery.Jobs.getQueryResults(BQ_PROJECT(), jobId, { location: loc });
  }
  const fields = (res.schema && res.schema.fields) || [];
  return (res.rows || []).map(r => {
    const o = {};
    r.f.forEach((c, i) => {
      const f = fields[i];
      let v = c.v;
      if (f.mode === 'REPEATED') v = (v || []).map(x => x.v);
      else if (v !== null && (f.type === 'FLOAT' || f.type === 'FLOAT64')) v = Number(v);
      else if (v !== null && (f.type === 'BOOLEAN' || f.type === 'BOOL')) v = v === 'true';
      else if (v !== null && f.type === 'TIMESTAMP') v = new Date(Number(v) * 1000).toISOString();
      o[f.name] = v;
    });
    return o;
  });
}
function p_(name, type, value) {
  if (Array.isArray(value)) {
    return { name, parameterType: { type: 'ARRAY', arrayType: { type } }, parameterValue: { arrayValues: value.map(v => ({ value: String(v) })) } };
  }
  return { name, parameterType: { type }, parameterValue: value === null || value === undefined ? {} : { value: String(value) } };
}
const T = (t) => '`' + BQ_PROJECT() + '.' + BQ_DATASET() + '.' + t + '`';

// ---------- plans ----------
function getPlan_(date) {
  const rows = bq_('SELECT plan_date, title, plan_json, written_by, updated_ts FROM ' + T('field_plans') +
    ' WHERE plan_date = @d ORDER BY updated_ts DESC LIMIT 1', [p_('d', 'DATE', date)]);
  if (!rows.length) return { plan: null };
  const r = rows[0];
  let plan = null; try { plan = JSON.parse(r.plan_json); } catch (e) { }
  return { plan: plan, title: r.title, written_by: r.written_by, updated_ts: r.updated_ts };
}
function listPlans_() {
  const rows = bq_('SELECT plan_date, ANY_VALUE(title HAVING MAX updated_ts) title FROM ' + T('field_plans') +
    ' WHERE plan_date >= DATE_SUB(CURRENT_DATE("America/New_York"), INTERVAL 7 DAY) GROUP BY plan_date ORDER BY plan_date', []);
  return { plans: rows };
}
function savePlan_(d) {
  bq_('INSERT INTO ' + T('field_plans') + ' (plan_date, title, plan_json, written_by, updated_ts) VALUES (@d, @t, @j, @w, CURRENT_TIMESTAMP())',
    [p_('d', 'DATE', d.date), p_('t', 'STRING', d.title || ''), p_('j', 'STRING', JSON.stringify(d.plan || {})), p_('w', 'STRING', d.written_by || 'app')]);
  return { saved: true };
}

// ---------- captures ----------
function mediaFolder_() {
  let id = P.getProperty('MEDIA_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  const f = DriveApp.createFolder('B+W Field Guide media');
  P.setProperty('MEDIA_FOLDER_ID', f.getId());
  return f;
}
function saveCapture_(c) {
  if (!c.id) throw new Error('missing id');
  // idempotent: skip if this id is already stored (the outbox may resend)
  const seen = bq_('SELECT id, media_drive_id, media_url FROM ' + T('field_captures') + ' WHERE id = @id LIMIT 1', [p_('id', 'STRING', c.id)]);
  if (seen.length) return { id: c.id, duplicate: true, media_url: seen[0].media_url };
  let mediaId = null, mediaUrl = null;
  if (c.media_b64) {
    const ext = (c.media_type || '').indexOf('audio') === 0 ? (c.media_type.indexOf('mp4') > -1 ? 'm4a' : 'webm') : 'jpg';
    const name = (c.local_date || 'undated') + '_' + (c.kind || 'capture') + '_' + c.id.slice(0, 8) + '.' + ext;
    const blob = Utilities.newBlob(Utilities.base64Decode(c.media_b64), c.media_type || 'application/octet-stream', name);
    const file = mediaFolder_().createFile(blob);
    file.setDescription([c.area_name, c.business_name, c.text].filter(Boolean).join(' · ').slice(0, 900));
    mediaId = file.getId(); mediaUrl = file.getUrl();
  }
  const S = 'STRING', F = 'FLOAT64';
  bq_('INSERT INTO ' + T('field_captures') + ' (id, ts, local_date, kind, walk, market, mode, lat, lon, accuracy_m, area_name, tract_geoid, corridor_code, zone, business_ref, business_name, text, saw, role, handed, followup, followup_done, contact, media_type, media_drive_id, media_url, device, received_ts, source) VALUES ' +
    '(@id, TIMESTAMP(@ts), DATE(@ld), @kind, @walk, @market, @mode, @lat, @lon, @acc, @area, @tract, @cor, @zone, @bref, @bname, @text, @saw, @role, @handed, @fu, FALSE, @contact, @mt, @mid, @murl, @dev, CURRENT_TIMESTAMP(), "guide")',
    [p_('id', S, c.id), p_('ts', S, c.ts), p_('ld', S, c.local_date), p_('kind', S, c.kind), p_('walk', S, c.walk), p_('market', S, c.market), p_('mode', S, c.mode),
     p_('lat', F, c.lat), p_('lon', F, c.lon), p_('acc', F, c.accuracy_m), p_('area', S, c.area_name), p_('tract', S, c.tract_geoid), p_('cor', S, c.corridor_code), p_('zone', S, c.zone),
     p_('bref', S, c.business_ref), p_('bname', S, c.business_name), p_('text', S, c.text), p_('saw', S, c.saw || []), p_('role', S, c.role), p_('handed', S, c.handed || []),
     p_('fu', S, c.followup || 'none'), p_('contact', S, c.contact), p_('mt', S, c.media_type), p_('mid', S, mediaId), p_('murl', S, mediaUrl), p_('dev', S, c.device)]);
  mirror_(c, mediaUrl);
  return { id: c.id, media_url: mediaUrl };
}
function mirror_(c, mediaUrl) {
  const sid = P.getProperty('SHEET_ID');
  if (!sid) return;
  try {
    const ss = SpreadsheetApp.openById(sid);
    let sh = ss.getSheetByName('Guide captures');
    if (!sh) {
      sh = ss.insertSheet('Guide captures');
      sh.appendRow(['Time', 'Date', 'Kind', 'Walk', 'Market', 'Mode', 'Area', 'Business', 'Note', 'Saw', 'Talked to', 'Handed over', 'Follow up', 'Contact', 'Media', 'Lat', 'Lon', 'ID']);
    }
    sh.appendRow([c.ts, c.local_date, c.kind, c.walk, c.market, c.mode, c.area_name, c.business_name, c.text, (c.saw || []).join(', '), c.role,
      (c.handed || []).join(', '), c.followup, c.contact, mediaUrl, c.lat, c.lon, c.id]);
  } catch (e) { console.warn('mirror failed', e); }
}
function listCaptures_(d) {
  const days = Math.min(Number(d.days || 14), 120);
  const rows = bq_('SELECT id, ts, local_date, kind, walk, market, mode, lat, lon, area_name, corridor_code, business_ref, business_name, text, saw, role, handed, followup, followup_done, contact, media_type, media_url, source FROM ' +
    T('field_captures') + ' WHERE local_date >= DATE_SUB(CURRENT_DATE("America/New_York"), INTERVAL @n DAY) OR (followup != "none" AND NOT IFNULL(followup_done, FALSE)) ORDER BY ts DESC LIMIT 500',
    [p_('n', 'INT64', days)]);
  return { captures: rows };
}
function setFollowup_(d) {
  bq_('UPDATE ' + T('field_captures') + ' SET followup_done = @v, followup_done_ts = IF(@v, CURRENT_TIMESTAMP(), NULL) WHERE id = @id',
    [p_('v', 'BOOL', !!d.done), p_('id', 'STRING', d.id)]);
  return { id: d.id, done: !!d.done };
}

// ---------- storefronts (OSM) ----------
// Tiles are 0.02 x 0.02 degrees; x = floor(lon/0.02), y = floor(lat/0.02).
function pois_(d) {
  const S = 0.02, x = Number(d.x), y = Number(d.y);
  const rows = bq_('SELECT osm_id, lat, lon, name, cat, addr, city, website, hours FROM ' + T('fg_osm_pois') +
    ' WHERE lon >= @x0 AND lon < @x1 AND lat >= @y0 AND lat < @y1 AND name IS NOT NULL LIMIT 3000',
    [p_('x0', 'FLOAT64', x * S), p_('x1', 'FLOAT64', (x + 1) * S), p_('y0', 'FLOAT64', y * S), p_('y1', 'FLOAT64', (y + 1) * S)]);
  return { x: x, y: y, pois: rows.map(r => [String(r.osm_id), r.lat, r.lon, r.name, r.cat, r.addr || '', r.city || '', r.website || '', r.hours || '']) };
}

// Search storefronts anywhere in the territory by name, address, city or type, nearest first.
function searchPois_(d) {
  const q = String(d.q || '').trim().toLowerCase().replace(/[\\%_]/g, ' ').slice(0, 60);
  if (q.length < 2) return { pois: [] };
  const words = q.replace(/['’]/g, '').split(/\s+/).filter(w => w.length >= 2).slice(0, 4);
  if (!words.length) return { pois: [] };
  const hasPos = d.lat != null && d.lon != null && d.lat !== '' && isFinite(Number(d.lat)) && isFinite(Number(d.lon));
  // everyday words → OpenStreetMap type names
  const SYN = { coffee: ['cafe'], barber: ['hairdresser'], barbershop: ['hairdresser'], salon: ['hairdresser', 'beauty'], nails: ['beauty'],
    laundromat: ['laundry'], bodega: ['convenience'], corner: ['convenience'], grocery: ['supermarket', 'convenience', 'greengrocer'],
    grocer: ['supermarket', 'convenience', 'greengrocer'], gym: ['fitness'], church: ['place_of_worship'], mosque: ['place_of_worship'],
    doctor: ['doctors', 'clinic'], auto: ['car_repair', 'car'], mechanic: ['car_repair'], liquor: ['alcohol'], deli: ['deli', 'sandwich'],
    daycare: ['childcare', 'kindergarten'], pharmacy: ['pharmacy', 'chemist'], drugstore: ['pharmacy', 'chemist'], food: ['restaurant', 'fast_food'] };
  const params = [];
  const conds = words.map((w, i) => {
    const alts = [w].concat(SYN[w] || []);
    return '(' + alts.map((a, j) => {
      const n = '@w' + i + '_' + j; params.push(p_(n.slice(1), 'STRING', '%' + a + '%'));
      return 'LOWER(name) LIKE ' + n + ' OR LOWER(IFNULL(addr, "")) LIKE ' + n + ' OR LOWER(IFNULL(city, "")) LIKE ' + n + ' OR LOWER(IFNULL(cat, "")) LIKE ' + n;
    }).join(' OR ') + ')';
  });
  let dist = 'NULL';
  if (hasPos) {
    dist = 'ST_DISTANCE(ST_GEOGPOINT(lon, lat), ST_GEOGPOINT(@lon, @lat))';
    params.push(p_('lat', 'FLOAT64', Number(d.lat)), p_('lon', 'FLOAT64', Number(d.lon)));
  }
  const rows = bq_('SELECT osm_id, lat, lon, name, cat, addr, city, website, hours, ' + dist + ' AS d FROM ' + T('fg_osm_pois') +
    ' WHERE name IS NOT NULL AND ' + conds.join(' AND ') +
    ' ORDER BY ' + (hasPos ? 'd' : 'name') + ' LIMIT 40', params);
  return { pois: rows.map(r => [String(r.osm_id), r.lat, r.lon, r.name, r.cat, r.addr || '', r.city || '', r.website || '', r.hours || '']) };
}

// ---------- edit / delete ----------
function updateCapture_(d) {
  bq_('UPDATE ' + T('field_captures') + ' SET text = @text, followup = @fu, contact = @contact, business_name = IFNULL(@bname, business_name) WHERE id = @id',
    [p_('text', 'STRING', d.text), p_('fu', 'STRING', d.followup || 'none'), p_('contact', 'STRING', d.contact), p_('bname', 'STRING', d.business_name), p_('id', 'STRING', d.id)]);
  return { id: d.id, updated: true };
}
function deleteCapture_(d) {
  const rows = bq_('SELECT media_drive_id FROM ' + T('field_captures') + ' WHERE id = @id', [p_('id', 'STRING', d.id)]);
  rows.forEach(r => { if (r.media_drive_id) { try { DriveApp.getFileById(r.media_drive_id).setTrashed(true); } catch (e) { } } });
  bq_('DELETE FROM ' + T('field_captures') + ' WHERE id = @id', [p_('id', 'STRING', d.id)]);
  return { id: d.id, deleted: true };
}

// ---------- Apollo ----------
function apollo_(d) {
  const key = P.getProperty('APOLLO_KEY');
  if (!key) return { configured: false };
  const body = { q_organization_name: d.name, page: 1, per_page: 5 };
  if (d.city || d.state) body.organization_locations = [[d.city, d.state].filter(Boolean).join(', ')];
  const r = UrlFetchApp.fetch('https://api.apollo.io/api/v1/mixed_companies/search', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Api-Key': key, 'Cache-Control': 'no-cache' }, payload: JSON.stringify(body)
  });
  const code = r.getResponseCode();
  if (code >= 300) return { configured: true, error: 'apollo_' + code, detail: r.getContentText().slice(0, 300) };
  const j = JSON.parse(r.getContentText());
  const orgs = (j.organizations || j.accounts || []).slice(0, 5).map(o => ({
    name: o.name, domain: o.primary_domain || o.website_url, phone: o.phone || (o.primary_phone && o.primary_phone.number),
    city: o.city, state: o.state, employees: o.estimated_num_employees, industry: o.industry,
    founded: o.founded_year, linkedin: o.linkedin_url, apollo_id: o.id
  }));
  return { configured: true, orgs: orgs };
}

// ---------- HubSpot ----------
function hs_(method, path, body) {
  const tok = P.getProperty('HUBSPOT_TOKEN');
  const r = UrlFetchApp.fetch('https://api.hubapi.com' + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + tok }, payload: body ? JSON.stringify(body) : undefined
  });
  const code = r.getResponseCode();
  const txt = r.getContentText();
  if (code >= 300) throw new Error('hubspot_' + code + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : {};
}
function hubspot_(d) {
  if (!P.getProperty('HUBSPOT_TOKEN')) return { configured: false };
  const found = hs_('post', '/crm/v3/objects/companies/search', {
    filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: d.name }] }], properties: ['name', 'city'], limit: 5
  });
  let id, created = false;
  const match = (found.results || []).find(x => !d.city || !x.properties.city || x.properties.city.toLowerCase() === String(d.city).toLowerCase());
  if (match) id = match.id;
  else {
    const c = hs_('post', '/crm/v3/objects/companies', { properties: {
      name: d.name, address: d.address || '', city: d.city || '', state: d.state || '', zip: d.zip || '', domain: d.domain || ''
    } });
    id = c.id; created = true;
  }
  if (d.note) {
    hs_('post', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: d.note },
      associations: [{ to: { id: id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 190 }] }]
    });
  }
  return { configured: true, company_id: id, created: created };
}

// ---------- inbound leads from Gmail ----------
// Runs every 15 minutes (installInboundTrigger, once). Files each new lead email as a Field Guide capture
// (kind "inbound") so it shows in "Waiting on you". Sources:
//   Inbound/Phone   Google Voice: voicemail → mode "Call", text → "Text", missed call → "Missed call"
//                   (voicemails come from voice-noreply@google.com, texts from …@txt.voice.google.com)
//   Inbound/Website Squarespace form → "Website form"   (vendor/sales pitches filed with role "vendor": never buzz)
//   Inbound/Chat    HubSpot chat notification → "Website chat"
//   Letter replies  inbox mail from a recipient of a mailed piece (outreach_pieces domain or email) or quoting a ref code → "Letter reply"
// Each message is filed once (id = gm:<message id>); Voice threads keep growing, so dedupe is by message, not thread.
const FREEMAIL_ = /@(gmail|yahoo|aol|hotmail|outlook|icloud|me|comcast|verizon|msn|live|protonmail)\./i;
const REF_RE_ = /\b(PHL1-\d{3}|MA1-\d{3}|NJ1-\d{3}|BAL1-\d{3}|[A-Z0-9]{3}-1103|BOS-HP)\b/;
const VENDOR_RE_ = /\b(offering (?:a |our )?(?:service|services)|our (?:agency|services) can|seo|web design|lead generation|marketing agency|we help (?:businesses|companies)|partnership opportunity|sponsored post|guest post|recruit(?:er|ing)|staffing|survey invitation|book a demo)\b/i;

function cleanBody_(m) {
  return String(m.getPlainBody() || '')
    .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n')
    .split(/\n(?:YOUR ACCOUNT|HELP CENTER|HELP FORUM|Google LLC|To unsubscribe|You received this|Sent via form submission|On .{5,80} wrote:)/i)[0]
    .trim().slice(0, 1800);
}
function voiceMode_(subj) {
  if (/voicemail/i.test(subj)) return 'Call';
  if (/text message|new message|group message/i.test(subj)) return 'Text';
  if (/missed call/i.test(subj)) return 'Missed call';
  return null; // welcome / account mail: not a lead
}
function outreachIndex_() {
  const c = CacheService.getScriptCache().get('outreach_idx');
  if (c) return JSON.parse(c);
  const rows = bq_('SELECT ref_code, org, recipient_domain, recipient_email FROM ' + T('outreach_pieces') + ' WHERE recipient_domain IS NOT NULL OR recipient_email IS NOT NULL OR ref_code IS NOT NULL', []);
  const idx = { dom: {}, email: {}, ref: {} };
  rows.forEach(r => {
    if (r.recipient_domain && !FREEMAIL_.test('@' + r.recipient_domain)) idx.dom[r.recipient_domain.toLowerCase()] = r.org;
    if (r.recipient_email) idx.email[r.recipient_email.toLowerCase()] = r.org;
    if (r.ref_code) idx.ref[r.ref_code] = r.org;
  });
  CacheService.getScriptCache().put('outreach_idx', JSON.stringify(idx), 3600);
  return idx;
}
function addrOf_(from) { const m = String(from || '').match(/<([^>]+)>/); return (m ? m[1] : String(from || '')).trim().toLowerCase(); }

function pullInbound() {
  const filedLbl = GmailApp.getUserLabelByName('FG-filed') || GmailApp.createLabel('FG-filed');
  const me = Session.getActiveUser().getEmail().toLowerCase();
  const cand = []; // {m, channel, th}
  // 1. labeled inbound (phone, form, chat)
  GmailApp.search('(label:Inbound/Phone OR label:Inbound/Website OR label:Inbound/Chat) newer_than:7d', 0, 50).forEach(th => {
    const labels = th.getLabels().map(l => l.getName());
    const channel = labels.indexOf('Inbound/Phone') > -1 ? 'Phone' : labels.indexOf('Inbound/Chat') > -1 ? 'Website chat' : 'Website form';
    th.getMessages().forEach(m => { if (addrOf_(m.getFrom()) !== me) cand.push({ m: m, channel: channel, th: th }); });
  });
  // 2. replies to mailed letters / follow-up emails
  let idx = null;
  try { idx = outreachIndex_(); } catch (e) { console.warn('outreach index failed', e); }
  if (idx) {
    const doms = Object.keys(idx.dom), ems = Object.keys(idx.email);
    const parts = doms.map(d => 'from:' + d).concat(ems.map(e => 'from:' + e)).concat(['PHL1', 'MA1', '1103', '"BOS-HP"']);
    const q = 'in:inbox newer_than:7d -from:me -label:Vendor -label:Inbound/Phone -label:Inbound/Website -label:Inbound/Chat {' + parts.join(' ') + '}';
    GmailApp.search(q, 0, 30).forEach(th => th.getMessages().forEach(m => {
      const a = addrOf_(m.getFrom());
      if (a === me || /@bwimpact\.org$/.test(a)) return;
      const dom = a.split('@')[1] || '';
      const hay = (m.getSubject() || '') + '\n' + String(m.getPlainBody() || '').slice(0, 4000);
      const ref = (hay.match(REF_RE_) || [])[1];
      const org = idx.email[a] || (!FREEMAIL_.test(a) && idx.dom[dom]) || (ref && idx.ref[ref]);
      if (org) cand.push({ m: m, channel: 'Letter reply', th: th, org: org, ref: ref });
    }));
  }
  if (!cand.length) return { filed: 0 };
  // dedupe against what is already filed
  const ids = cand.map(c => 'gm:' + c.m.getId());
  const seen = {};
  bq_('SELECT id FROM ' + T('field_captures') + ' WHERE id IN UNNEST(@ids)', [p_('ids', 'STRING', ids)]).forEach(r => seen[r.id] = 1);
  const fresh = [];
  cand.forEach(c => {
    const id = 'gm:' + c.m.getId();
    if (seen[id]) return; seen[id] = 1;
    const m = c.m, subj = m.getSubject() || '', body = cleanBody_(m);
    let mode = c.channel, role = null;
    if (c.channel === 'Phone') { mode = voiceMode_(subj); if (!mode) return; }
    if (c.channel === 'Website form' && VENDOR_RE_.test(body)) role = 'vendor';
    const phone = ((subj + ' ' + body).match(/\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/) || [''])[0];
    const replyTo = m.getReplyTo && m.getReplyTo();
    const notMine = (e) => e && !/@bwimpact\.org|noreply|no-reply|squarespace|google\.com|hubspot/i.test(e);
    const bodyEmail = (body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).filter(notMine)[0] || '';
    let email = '';
    if (c.channel === 'Letter reply') email = addrOf_(m.getFrom());
    else if (c.channel !== 'Phone') email = notMine(replyTo) ? replyTo : bodyEmail;
    const org = c.org || ((body.match(/(?:Organization(?: Name)?|Company|Business)\s*[:\n]\s*(.+)/i) || [])[1] || '').replace(/\*+/g, '').trim().slice(0, 120);
    const d = m.getDate();
    const label = { Call: 'Voicemail', Text: 'Text', 'Missed call': 'Missed call', 'Website form': 'Website form', 'Website chat': 'Website chat', 'Letter reply': 'Reply to letter' }[mode];
    saveCapture_({
      id: id, ts: d.toISOString(), local_date: Utilities.formatDate(d, 'America/New_York', 'yyyy-MM-dd'),
      kind: 'inbound', mode: mode, role: role, business_name: org || null,
      business_ref: c.ref || null,
      text: label + ': ' + subj + (body ? '\n\n' + body : ''),
      followup: mode === 'Missed call' ? 'call' : (mode === 'Text' ? 'text' : 'email'),
      contact: [email, phone].filter(Boolean).join(' · ') || null,
      device: 'gmail'
    });
    c.th.addLabel(filedLbl);
    fresh.push({ id: id, mode: mode, org: org, vendor: role === 'vendor', subj: subj });
  });
  if (fresh.length) notifyLeads_(fresh);
  return { filed: fresh.length };
}
// Run once from the editor to schedule pullInbound every 15 minutes.
function installInboundTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pullInbound').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pullInbound').timeBased().everyMinutes(15).create();
  return pullInbound();
}

// ---------- buzz (phase 2 hook) ----------
// Quiet hours live here: weekdays 10:00–18:00 ET only; anything outside is dropped (it still sits in the list).
// Sends only if PUSH_URL (+ PUSH_SECRET) is set; until then this is a no-op.
function inWorkHours_(d) {
  const dow = Number(Utilities.formatDate(d || new Date(), 'America/New_York', 'u')); // 1=Mon … 7=Sun
  const h = Number(Utilities.formatDate(d || new Date(), 'America/New_York', 'H'));
  return dow <= 5 && h >= 10 && h < 18;
}
function notifyLeads_(items) {
  const buzz = items.filter(i => !i.vendor && i.mode !== 'Missed call');
  if (!buzz.length || !inWorkHours_()) return;
  const url = P.getProperty('PUSH_URL'); if (!url) return;
  const title = buzz.length > 1 ? buzz.length + ' new leads' : ({ Call: 'Voicemail', Text: 'Text', 'Website form': 'Website form', 'Website chat': 'Website chat', 'Letter reply': 'Reply to your letter' }[buzz[0].mode] || 'New lead');
  const body = buzz.map(i => i.org || i.subj).filter(Boolean).join(' · ').slice(0, 140) || 'Open the Field Guide';
  try {
    UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'X-Push-Secret': P.getProperty('PUSH_SECRET') || '' }, payload: JSON.stringify({ title: title, body: body, url: './#today' }) });
  } catch (e) { console.warn('push failed', e); }
}

// ---------- command center: Waiting on you ----------
function getWaiting_() {
  const caps = bq_('SELECT id, ts, local_date, kind, mode, role, business_name, area_name, text, followup, contact FROM ' + T('field_captures') +
    ' WHERE NOT IFNULL(followup_done, FALSE) AND ((kind = "inbound" AND local_date >= DATE_SUB(CURRENT_DATE("America/New_York"), INTERVAL 30 DAY))' +
    ' OR (kind != "inbound" AND followup != "none" AND local_date >= DATE_SUB(CURRENT_DATE("America/New_York"), INTERVAL 1 DAY))) ORDER BY ts DESC LIMIT 60', []);
  const pieces = bq_('SELECT row_id, ref_code, batch, lane, org, addressed_to, city, state, status, mailed_date, followup_due, notes, recipient_email FROM ' + T('outreach_pieces') +
    ' WHERE NOT handled AND followup_due <= CURRENT_DATE("America/New_York") AND NOT STARTS_WITH(status, "Built")' +
    ' AND (lane LIKE "District%" OR recipient_email IS NOT NULL) ORDER BY followup_due, org LIMIT 40', []);
  return { captures: caps, pieces: pieces, as_of: new Date().toISOString() };
}
function markHandled_(d) {
  if (d.type === 'piece') {
    bq_('UPDATE ' + T('outreach_pieces') + ' SET handled = TRUE, handled_at = CURRENT_TIMESTAMP(), next_step = IFNULL(@n, next_step) WHERE row_id = @id',
      [p_('id', 'INT64', d.id), p_('n', 'STRING', d.note || null)]);
  } else {
    bq_('UPDATE ' + T('field_captures') + ' SET followup_done = TRUE, followup_done_ts = CURRENT_TIMESTAMP(), text = IF(@n IS NULL, text, CONCAT(IFNULL(text, ""), "\\n[", @n, "]")) WHERE id = @id',
      [p_('id', 'STRING', d.id), p_('n', 'STRING', d.note || null)]);
  }
  return { id: d.id, handled: true };
}

// ---------- command center: calendar ----------
function getToday_() {
  const now = new Date(), until = new Date(now.getTime() + 36 * 3600 * 1000);
  const cals = [CalendarApp.getDefaultCalendar()].concat(CalendarApp.getCalendarsByName('Brown + Wheaten'));
  const out = [];
  cals.forEach((cal, ci) => cal.getEvents(now, until).forEach(ev => {
    if (ev.getMyStatus && ev.getMyStatus() === CalendarApp.GuestStatus.NO) return;
    const desc = ev.getDescription() || '';
    out.push({ title: ev.getTitle(), start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(), all_day: ev.isAllDayEvent(),
      location: ev.getLocation() || '', booked: /booked by|appointment schedul/i.test(desc + ' ' + ev.getTitle()), deadline: ci > 0 });
  }));
  out.sort((a, b) => a.start < b.start ? -1 : 1);
  return { events: out.slice(0, 12) };
}

// ---------- command center: pulse ----------
function getPulse_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('pulse');
  if (hit) return JSON.parse(hit);
  const out = { hubspot: null, drafts: null, apollo_reset_days: null };
  // Apollo: credits reset on the 16th of each month
  const now = new Date(), y = now.getFullYear(), mo = now.getMonth();
  let reset = new Date(y, mo, 16); if (now >= reset) reset = new Date(y, mo + 1, 16);
  out.apollo_reset_days = Math.ceil((reset - now) / 86400000);
  try { out.drafts = GmailApp.search('in:draft newer_than:2d', 0, 50).length; } catch (e) { }
  if (P.getProperty('HUBSPOT_TOKEN')) {
    try {
      const n = (vals) => hs_('post', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'bw_status', operator: 'IN', values: vals }] }], limit: 1 }).total || 0;
      out.hubspot = { open: n(['Replied', 'Talked']), proposals: n(['Proposal']), clients: n(['Client']) };
    } catch (e) { console.warn('pulse hubspot', e); }
  }
  cache.put('pulse', JSON.stringify(out), 900);
  return out;
}

// ---------- command center: send booking link ----------
// The booking URL lives only in Script Properties (BOOKING_URL); never in the app or repo.
function bookingText_(first) {
  const url = P.getProperty('BOOKING_URL');
  if (!url) throw new Error('BOOKING_URL not set in Script Properties');
  return (first ? 'Hi ' + first + ',\n\n' : 'Hi there,\n\n') +
    'Thanks for reaching out to Brown + Wheaten. Here\'s a link to pick a 30-minute slot that works for you: ' + url +
    '\n\nIf none of those fit, reply with a couple of times and we\'ll make one work.\n\nDarryl';
}
function sendBookingLink_(d) {
  const to = String(d.to || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(to)) throw new Error('no valid email for this lead');
  if (/@bwimpact\.org$/i.test(to)) throw new Error('that is your own address');
  const first = String(d.first || '').trim().split(/\s+/)[0].replace(/[^A-Za-z'’-]/g, '').slice(0, 30);
  MailApp.sendEmail({ to: to, subject: 'Finding a time to talk', body: bookingText_(first), name: 'Darryl Wooten' });
  markHandled_({ type: d.type, id: d.id, note: 'booking link sent to ' + to + ' ' + Utilities.formatDate(new Date(), 'America/New_York', 'MMM d h:mm a') });
  return { sent: true, to: to };
}

// Run once from the editor (Run → authorize) to grant BigQuery, Drive, Sheets and external-request access.
function authorize() {
  Logger.log(bq_('SELECT COUNT(*) n FROM ' + T('field_captures'), []));
  Logger.log(DriveApp.getRootFolder().getName());
  Logger.log(CalendarApp.getDefaultCalendar().getName());
  Logger.log(MailApp.getRemainingDailyQuota());
}
