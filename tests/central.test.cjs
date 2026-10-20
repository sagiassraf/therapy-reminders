// Simulates Apps Script globals and runs the central script end-to-end.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'central');
let NOW = new Date('2026-10-20T08:00:00+03:00').getTime();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}

function makeSheet(name) {
  const data = [];
  const sh = {
    name, data,
    getLastRow: () => data.length,
    getMaxRows: () => 1000,
    setFrozenRows() {}, setRightToLeft() {},
    appendRow(r) { data.push(r.slice()); },
    deleteRow(row) { data.splice(row - 1, 1); },
    getRange(row, col, nr = 1, nc = 1) {
      return {
        getValues: () => data.slice(row - 1, row - 1 + nr).map(r => r.slice(col - 1, col - 1 + nc)),
        setValues(vals) {
          vals.forEach((v, i) => {
            const idx = row - 1 + i;
            if (idx >= 1000) return;
            while (data.length <= idx) data.push([]);
            v.forEach((x, j) => { data[idx][col - 1 + j] = x; });
          });
          return this;
        },
        setFontWeight() { return this; }, setNumberFormat() { return this; }, insertCheckboxes() { return this; },
      };
    },
  };
  return sh;
}
const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n)),
  setSpreadsheetTimeZone() {}, getSheets: () => Object.values(sheets), deleteSheet() {},
};
const props = { WA_TOKEN: 'tok', WA_PHONE_ID: '123', TEST_PHONE: '0501112222' };
const cache = {};
const sent = [];
let failNext = false;

function formatDate(d, tz, pattern) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { u: String(u), 'd.M': `${p.day}.${p.month}`, 'HH:mm': `${p.hour}:${p.minute}` }[pattern];
}

const ctx = {
  Date: FakeDate, console, JSON, Math, Object, String, Number, Array, isNaN, Error,
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, getProperties: () => ({ ...props }),
  }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  Utilities: { getUuid: () => crypto.randomUUID(), formatDate },
  UrlFetchApp: { fetch(url, opt) {
    const body = JSON.parse(opt.payload);
    if (failNext) { failNext = false; return { getResponseCode: () => 400, getContentText: () => '{"error":"bad"}' }; }
    sent.push(body);
    return { getResponseCode: () => 200, getContentText: () => '{"messages":[{"id":"wamid.x"}]}' };
  } },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Logger: { log: (...a) => console.log('  [Logger]', ...a) },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({
    timeBased: () => ({ everyMinutes: () => ({ create() {} }), everyDays: () => ({ atHour: () => ({ create() {} }) }) }),
  }) },
};
vm.createContext(ctx);
for (const f of ['Code.gs', 'WhatsApp.gs', 'Sheet.gs']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });

const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).s);
const H = 3600e3, MIN = 60e3;
const table = n => ctx.loadTable_(n).rows;

// --- setup + client
ctx.setup();
assert(props.INTERNAL_TOKEN && props.INTERNAL_TOKEN.startsWith('k'));
// Unchecked checkboxes down column E make getLastRow() report row 1000; rows must still start at 2.
for (let i = 1; i < 1000; i++) sheets.Clients.data[i] = ['', '', '', '', false, ''];
const client = { id: 'kclient1', displayName: 'דנה לוי', therapistPhone: '972509998888', secret: 'ksecret', active: true, created: new FakeDate() };
ctx.appendRows_(ctx.loadTable_('Clients'), [client]);
assert.strictEqual(client._row, 2, 'client must land in row 2 despite checkboxes below');
assert.strictEqual(ctx.loadTable_('Clients').rows.length, 1);

// --- sync
const evA = { eventId: 'A@google.com', startMs: NOW + 30 * H, name: 'יוסי כהן', phone: '+972 50-123-4567' }; // far ahead
const evB = { eventId: 'B@google.com', startMs: NOW + 3 * H, name: 'רותי', phone: '0521234567' };        // booked late
const evC = { eventId: 'C@google.com', startMs: NOW + 5 * H, name: 'אירוע אישי', phone: '' };           // no phone
const sync = (events, extra = {}) => post(Object.assign({ type: 'sync', clientId: 'kclient1', secret: 'ksecret',
  windowStart: NOW, windowEnd: NOW + 48 * H, events }, extra));

assert.deepStrictEqual(sync([evA], { secret: 'wrong' }), { ok: false, error: 'unauthorized' });
let r = sync([evA, evB, evC]);
assert(r.ok, JSON.stringify(r));
assert.strictEqual(r.statuses.length, 3);
let rows = table('Appointments');
assert.strictEqual(rows.find(x => x.eventId === 'A@google.com').phone, '972501234567');
assert.strictEqual(rows.find(x => x.eventId === 'C@google.com').status, 'no_phone');
assert.strictEqual(sent.length, 0, 'first sync must not alert about unmatched events');
console.log('✓ sync: insert, phone normalization, no_phone, auth');

// A new unmatched meeting after the first sync -> immediate WhatsApp alert to the therapist, once.
const evU = { eventId: 'U@google.com', startMs: NOW + 20 * H, name: 'ראובן', phone: '' };
sync([evA, evB, evC, evU]);
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].to, '972509998888');
assert.strictEqual(sent[0].template.name, 'therapist_alert');
const up = sent[0].template.components[0].parameters.map(x => x.text);
assert.strictEqual(up[0], 'ראובן');
assert.match(up[3], /לא נמצא איש קשר/);
sync([evA, evB, evC, evU]);
assert.strictEqual(sent.length, 1, 'no repeat alert for the same meeting');
// Therapist fixes the title -> it gets a phone and becomes a normal pending appointment.
sync([evA, evB, evC, Object.assign({}, evU, { name: 'ראובן כהן', phone: '0581234567' })]);
assert.strictEqual(table('Appointments').find(x => x.eventId === 'U@google.com').status, 'pending');
sync([evA, evB, evC]); // drop it again so later counts stay simple
sent.length = 0;
console.log('✓ unmatched meeting: one immediate alert, cleared after fix');

// --- reminders at T+0: nothing due (A is 30h away, B is 3h away but booked late -> no 24h)
ctx.sendDueReminders();
assert.strictEqual(sent.length, 0, 'nothing should be sent yet');

// T+2h05: B is 55 min away -> 1h reminder
NOW += 2 * H + 5 * MIN;
ctx.sendDueReminders();
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].template.name, 'reminder_1h');
assert.strictEqual(sent[0].to, '972521234567');
assert.strictEqual(sent[0].template.components[0].parameters[0].text, 'רותי');
const bId = table('Appointments').find(x => x.eventId === 'B@google.com').id;
assert.strictEqual(sent[0].template.components[1].parameters[0].payload, 'c:' + bId);
ctx.sendDueReminders();
assert.strictEqual(sent.length, 1, 'no duplicate');
console.log('✓ 1h reminder for late booking, no 24h, no duplicates');

// T+6h: A is 24h away -> 24h reminder with weekday/date
NOW = evA.startMs - 24 * H + 2 * MIN;
ctx.sendDueReminders();
const m24 = sent[sent.length - 1];
assert.strictEqual(m24.template.name, 'reminder_24h');
const p = m24.template.components[0].parameters.map(x => x.text);
console.log('  24h params:', p);
assert.strictEqual(p[1], 'דנה לוי');
assert.match(p[2], /^\S+ \d{1,2}\.\d{1,2}$/);
console.log('✓ 24h reminder');

// --- webhook auth
assert.strictEqual(post({ type: 'webhook', token: 'nope', payload: {} }).ok, false);

// client taps "cancel" on A
const aId = table('Appointments').find(x => x.eventId === 'A@google.com').id;
const tap = (from, payload) => post({ type: 'webhook', token: props.INTERNAL_TOKEN, payload: { entry: [{ changes: [{ value: {
  messages: [{ from, id: 'wamid.in', type: 'button', button: { payload, text: 'x' } }] } }] }] } });
const before = sent.length;
assert(tap('972501234567', 'x:' + aId).ok);
assert.strictEqual(table('Appointments').find(x => x.id === aId).status, 'cancelled');
const newMsgs = sent.slice(before);
assert.strictEqual(newMsgs.length, 2);
assert.strictEqual(newMsgs[0].type, 'text');
assert.strictEqual(newMsgs[1].template.name, 'therapist_alert');
assert.strictEqual(newMsgs[1].to, '972509998888');
// duplicate webhook delivery -> no second alert
tap('972501234567', 'x:' + aId);
assert.strictEqual(sent.filter(m => m.template && m.template.name === 'therapist_alert').length, 1);
// wrong phone can't touch it
tap('972500000000', 'c:' + aId);
assert.strictEqual(table('Appointments').find(x => x.id === aId).status, 'cancelled');
console.log('✓ cancel flow: client reply, therapist alert once, phone check');

// cancelled -> no 1h reminder
NOW = evA.startMs - 50 * MIN;
const n = sent.length;
ctx.sendDueReminders();
assert.strictEqual(sent.length, n, 'cancelled appointment must not get 1h reminder');
console.log('✓ no reminder after cancel');

// --- reschedule + delete via sync
NOW = new Date('2026-10-22T08:00:00+03:00').getTime();
const evD = { eventId: 'D@google.com', startMs: NOW + 26 * H, name: 'מיכל', phone: '0541234567' };
sync([evD]);
const moved = Object.assign({}, evD, { startMs: NOW + 28 * H });
r = sync([moved]);
rows = table('Appointments').filter(x => x.eventId === 'D@google.com');
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows.find(x => Number(x.startMs) === evD.startMs).status, 'deleted');
assert.strictEqual(rows.find(x => Number(x.startMs) === moved.startMs).status, 'pending');
assert.strictEqual(r.statuses.length, 1);
console.log('✓ reschedule: old slot deleted, new slot pending');

// confirm -> statuses returned to connector
const dId = rows.find(x => x.status === 'pending').id;
tap('972541234567', 'c:' + dId);
r = sync([moved]);
assert.strictEqual(r.statuses[0].status, 'confirmed');
console.log('✓ confirm reflected back to connector');

// reschedule request: client reply + therapist alert with reason, no more reminders
const evR = { eventId: 'R@google.com', startMs: NOW + 30 * H, name: 'נועה', phone: '0551234567' };
sync([moved, evR]);
const rId = table('Appointments').find(x => x.eventId === 'R@google.com').id;
let k = sent.length;
tap('972551234567', 'r:' + rId);
assert.strictEqual(table('Appointments').find(x => x.id === rId).status, 'reschedule');
assert.strictEqual(sent.length - k, 2);
assert.match(sent[k].text.body, /מועד חדש/);
assert.strictEqual(sent[k + 1].template.name, 'therapist_alert');
assert.match(sent[k + 1].template.components[0].parameters[3].text, /לשנות מועד/);
NOW = evR.startMs - 50 * MIN;
k = sent.length;
ctx.sendDueReminders();
assert.strictEqual(sent.filter((m, i) => i >= k && m.to === '972551234567').length, 0, 'no reminder after reschedule request');
console.log('✓ reschedule request: alert with reason, reminders stop');

// 1h template carries confirm / cancel / late payloads; "late" alerts the therapist
const evL = { eventId: 'L@google.com', startMs: NOW + 62 * MIN, name: 'עמית', phone: '0561234567' };
sync([evL], { windowStart: NOW, windowEnd: NOW + 48 * H });
ctx.sendDueReminders();
const m1h = sent[sent.length - 1];
assert.strictEqual(m1h.template.name, 'reminder_1h');
const lId = table('Appointments').find(x => x.eventId === 'L@google.com').id;
assert.deepStrictEqual(m1h.template.components.slice(1).map(c => c.parameters[0].payload), ['c:' + lId, 'x:' + lId, 'l:' + lId]);
k = sent.length;
tap('972561234567', 'l:' + lId);
assert.strictEqual(table('Appointments').find(x => x.id === lId).status, 'late');
assert.match(sent[k + 1].template.components[0].parameters[3].text, /מאחר/);
console.log('✓ late button: 3 payloads on 1h template, therapist alerted');

// free text -> "not monitored" once
const t0 = sent.length;
const text = () => post({ type: 'webhook', token: props.INTERNAL_TOKEN, payload: { entry: [{ changes: [{ value: {
  messages: [{ from: '972541234567', id: 'w2', type: 'text', text: { body: 'אפשר להזיז?' } }] } }] }] } });
text(); text();
assert.strictEqual(sent.length - t0, 1);
assert.match(sent[sent.length - 1].text.body, /050-9998888/);
console.log('✓ free text auto-reply, rate limited');

// send failure is marked, not retried
const evE = { eventId: 'E@google.com', startMs: NOW + 40 * MIN, name: 'אבי', phone: '0531234567' };
sync([moved, evE]);
failNext = true;
ctx.sendDueReminders();
const e = table('Appointments').find(x => x.eventId === 'E@google.com');
assert.strictEqual(e.sent1h, 'failed');
assert(table('Log').some(l => /sent1h/.test(l.message)));
console.log('✓ send failure logged and not retried');

// cleanup
NOW += 10 * 24 * H;
ctx.cleanup();
assert.strictEqual(table('Appointments').length, 0);
console.log('✓ cleanup');

// admin endpoint: auth, whitelist, never echoes values
assert.strictEqual(post({ type: 'admin', token: 'nope', set: { WA_TOKEN: 'x' } }).ok, false);
let adm = post({ type: 'admin', token: props.INTERNAL_TOKEN, set: { WA_TOKEN: 'newtok', INTERNAL_TOKEN: 'hijack', TEMPLATE_SET: 'legacy' } });
assert.deepStrictEqual(adm.updated, ['WA_TOKEN', 'TEMPLATE_SET']);
assert.strictEqual(props.WA_TOKEN, 'newtok');
assert.notStrictEqual(props.INTERNAL_TOKEN, 'hijack');
adm = post({ type: 'admin', token: props.INTERNAL_TOKEN, action: 'status' });
assert(adm.properties.includes('WA_TOKEN') && !JSON.stringify(adm).includes('newtok'));
console.log('✓ admin: auth, whitelist, no secret echo');

// gender: setClient via admin, reply wording follows it
assert.strictEqual(post({ type: 'admin', token: props.INTERNAL_TOKEN, action: 'setClient', id: 'nope', fields: {} }).ok, false);
adm = post({ type: 'admin', token: props.INTERNAL_TOKEN, action: 'setClient', id: 'kclient1', fields: { gender: 'f', secret: 'hack' } });
assert.strictEqual(adm.client.gender, 'f');
assert.strictEqual(ctx.findClient_('kclient1').secret, 'ksecret');
assert.strictEqual(ctx.gendered_({ gender: 'f' }, 'יודע', 'יודעת', 'יודע/ת'), 'יודעת');
assert.strictEqual(ctx.gendered_({ gender: 'm' }, 'יודע', 'יודעת', 'יודע/ת'), 'יודע');
assert.strictEqual(ctx.gendered_({}, 'יודע', 'יודעת', 'יודע/ת'), 'יודע/ת');
const evF = { eventId: 'F@google.com', startMs: NOW + 30 * H, name: 'שירה', phone: '0591234567' };
sync([evF], { windowStart: NOW, windowEnd: NOW + 48 * H });
let kf = sent.length;
tap('972591234567', 'r:' + table('Appointments').find(x => x.eventId === 'F@google.com').id);
assert.match(sent[kf].text.body, /דנה לוי תחזור אליך/);
console.log('✓ therapist gender wording');

// legacy template set: old approved names, [first name, time] params, same 3 payloads
let k2 = sent.length;
post({ type: 'admin', token: props.INTERNAL_TOKEN, action: 'testSend' });
const lt = sent[k2];
assert.strictEqual(lt.template.name, 'reminder_day_with_a_button');
assert.strictEqual(lt.template.components[0].parameters.length, 2);
assert.strictEqual(lt.template.components.length, 4);
const evLeg = { eventId: 'G@google.com', startMs: NOW + 60 * MIN, name: 'גלעד', phone: '0571234567' };
sync([evLeg], { windowStart: NOW, windowEnd: NOW + 48 * H });
ctx.sendDueReminders();
assert.strictEqual(sent[sent.length - 1].template.name, 'reminder_hour_butten');
post({ type: 'admin', token: props.INTERNAL_TOKEN, set: { TEMPLATE_SET: 'default' } });
console.log('✓ legacy template set');

// phone helpers
assert.strictEqual(ctx.normalizePhone_('050-123-4567'), '972501234567');
assert.strictEqual(ctx.normalizePhone_('00972501234567'), '972501234567');
assert.strictEqual(ctx.normalizePhone_('123'), '');
assert.strictEqual(ctx.formatLocalPhone_('972501234567'), '050-1234567');
assert.strictEqual(ctx.formatLocalPhone_('97231234567'), '03-1234567');
console.log('✓ phone helpers\n\nALL CENTRAL TESTS PASSED');
