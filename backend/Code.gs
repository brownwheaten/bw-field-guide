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

// Run once from the editor (Run → authorize) to grant BigQuery, Drive, Sheets and external-request access.
function authorize() {
  Logger.log(bq_('SELECT COUNT(*) n FROM ' + T('field_captures'), []));
  Logger.log(DriveApp.getRootFolder().getName());
}
