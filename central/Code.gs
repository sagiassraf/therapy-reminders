/**
 * Central reminder service.
 *  - doPost {type:'sync'}     from each therapist's connector script
 *  - doPost {type:'webhook'}  forwarded by the Cloudflare Worker (button taps / replies)
 *  - doPost {type:'admin'}    operator tasks (set properties, test send, read log), INTERNAL_TOKEN
 *  - sendDueReminders()       every 5 minutes
 */

const TZ = 'Asia/Jerusalem';
const MIN = 60 * 1000;
const H = 60 * MIN;
const DAY = 24 * H;
const WEEKDAYS = ['שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון']; // formatDate 'u': 1 = Monday

const REMINDER_24H_WINDOW = 24 * H;
const REMINDER_1H_WINDOW = 65 * MIN;
// A booking made less than this before the meeting skips the day-before reminder.
const MIN_LEAD_FOR_24H = 23 * H;

// Quick-reply payload prefix -> appointment status. Button order per template:
//   reminder_24h: confirm, cancel, reschedule     reminder_1h: confirm, cancel, late
const REPLY_STATUS = { c: 'confirmed', x: 'cancelled', r: 'reschedule', l: 'late' };
const ALERT_TEXT = {
  cancelled: 'ביטל/ה את הפגישה ❌',
  reschedule: 'ביקש/ה לשנות מועד 🔄',
  late: 'מאחר/ת בכמה דקות ⏰',
  no_phone: '⚠️ לא נמצא איש קשר בשם הזה, לכן לא תישלח תזכורת. תקנו את שם הפגישה כך שיהיה זהה לשם באנשי הקשר',
};

// Reminder templates. Script property TEMPLATE_SET picks the set; 'legacy' uses older approved
// templates (no therapist name) while new ones wait for Meta's review. Button order must match
// the payloads in sendReminder_: 24h = confirm, cancel, reschedule; 1h = confirm, cancel, late.
const TEMPLATE_SETS = {
  default: {
    reminder_24h: { name: 'reminder_24h', params: (a, c, d) => [firstName_(a.name), c.displayName, dayText_(d), timeText_(d)] },
    reminder_1h: { name: 'reminder_1h', params: (a, c, d) => [firstName_(a.name), c.displayName, timeText_(d)] },
  },
  legacy: {
    reminder_24h: { name: 'reminder_day_with_a_button', params: (a, c, d) => [firstName_(a.name), timeText_(d)] },
    reminder_1h: { name: 'reminder_hour_butten', params: (a, c, d) => [firstName_(a.name), timeText_(d)] },
  },
};

// Properties the admin endpoint may change.
const ADMIN_KEYS = ['WA_TOKEN', 'WA_PHONE_ID', 'TEST_PHONE', 'TEMPLATE_SET', 'TEMPLATE_LANG', 'GRAPH_VERSION'];

function templateFor_(kind) {
  const set = PropertiesService.getScriptProperties().getProperty('TEMPLATE_SET') || 'default';
  return (TEMPLATE_SETS[set] || TEMPLATE_SETS.default)[kind];
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('תזכורות')
    .addItem('הוספת מטפל/ת', 'addClient')
    .addItem('שליחת הודעת בדיקה', 'testSend')
    .addItem('שליחת תזכורות עכשיו', 'sendDueReminders')
    .addToUi();
}

function doGet() {
  return ContentService.createTextOutput('ok');
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad json' });
  }
  try {
    if (body.type === 'sync') return json_(handleSync_(body));
    if (body.type === 'webhook') return json_(handleWebhook_(body));
    if (body.type === 'admin') return json_(handleAdmin_(body));
    return json_({ ok: false, error: 'unknown type' });
  } catch (err) {
    log_('ERROR', body.type + ': ' + (err.stack || err));
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- sync

function handleSync_(body) {
  const clientsTable = loadTable_('Clients');
  const client = clientsTable.rows.find(c => String(c.id) === String(body.clientId));
  if (!client || client.secret !== body.secret) return { ok: false, error: 'unauthorized' };
  if (!isActive_(client)) return { ok: false, error: 'inactive' };

  const winStart = Number(body.windowStart);
  const winEnd = Number(body.windowEnd);
  const inWindow = r => Number(r.startMs) >= winStart && Number(r.startMs) < winEnd;
  const now = new Date();
  // On the very first sync everything is "new"; the activation screen already lists unmatched events.
  const firstSync = !client.lastSync;

  const result = withLock_(() => {
    const t = loadTable_('Appointments');
    const mine = t.rows.filter(r => String(r.clientId) === client.id);
    const byKey = {};
    mine.forEach(r => { byKey[r.eventId + '|' + r.startMs] = r; });

    const seen = {};
    const added = [];
    (body.events || []).forEach(ev => {
      const startMs = Number(ev.startMs);
      const key = ev.eventId + '|' + startMs;
      seen[key] = true;
      const phone = normalizePhone_(ev.phone);
      const name = String(ev.name || '').slice(0, 100);
      const r = byKey[key];
      if (!r) {
        added.push({
          id: randomId_(10), clientId: client.id, eventId: ev.eventId, startMs, start: new Date(startMs),
          name, phone, status: phone ? 'pending' : 'no_phone', firstSeen: now, updated: now,
        });
        return;
      }
      // A rescheduled event shows up under a new key (different startMs), so its flags start fresh.
      let status = r.status;
      if (!phone) status = 'no_phone';
      else if (status === 'no_phone' || status === 'deleted') status = 'pending';
      if (r.name !== name || String(r.phone) !== phone || r.status !== status) {
        Object.assign(r, { name, phone, status, updated: now });
        saveRow_(t, r);
      }
    });

    mine.forEach(r => {
      if (inWindow(r) && !seen[r.eventId + '|' + r.startMs] && r.status !== 'deleted') {
        Object.assign(r, { status: 'deleted', updated: now });
        saveRow_(t, r);
      }
    });
    appendRows_(t, added);

    client.lastSync = now;
    saveRow_(clientsTable, client);

    const statuses = t.rows
      .filter(r => String(r.clientId) === client.id && inWindow(r) && r.status !== 'deleted')
      .map(r => ({
        eventId: r.eventId, startMs: Number(r.startMs), status: r.status,
        sent24: !!r.sent24, sent1h: !!r.sent1h,
      }));
    return { ok: true, statuses, unmatched: firstSync ? [] : added.filter(a => a.status === 'no_phone') };
  });

  // Tell the therapist right away about a new meeting we can't remind (once per meeting).
  result.unmatched.forEach(a => alertUnmatched_(client, a));
  delete result.unmatched;
  return result;
}

function alertUnmatched_(client, appt) {
  if (!client.therapistPhone) return;
  const d = new Date(Number(appt.startMs));
  try {
    sendTemplate_(String(client.therapistPhone), 'therapist_alert',
      [appt.name || 'ללא שם', dayText_(d), timeText_(d), ALERT_TEXT.no_phone], []);
  } catch (err) {
    log_('ERROR', `No-phone alert to ${client.displayName}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- reminders

function sendDueReminders() {
  withLock_(() => {
    const clients = {};
    loadTable_('Clients').rows.forEach(c => { clients[c.id] = c; });
    const t = loadTable_('Appointments');
    const now = Date.now();

    t.rows.forEach(r => {
      if (r.status !== 'pending' && r.status !== 'confirmed') return;
      const client = clients[r.clientId];
      if (!client || !isActive_(client)) return;
      const startMs = Number(r.startMs);
      const left = startMs - now;
      if (left <= 0) return;

      let field;
      if (!r.sent1h && left <= REMINDER_1H_WINDOW) field = 'sent1h';
      else if (!r.sent24 && left <= REMINDER_24H_WINDOW && left > REMINDER_1H_WINDOW &&
               startMs - toMs_(r.firstSeen) >= MIN_LEAD_FOR_24H) field = 'sent24';
      else return;

      try {
        sendReminder_(field === 'sent24' ? 'reminder_24h' : 'reminder_1h', r, client);
        r[field] = new Date();
      } catch (err) {
        // Marked so we don't retry every 5 minutes; details are in the Log tab.
        r[field] = 'failed';
        log_('ERROR', `${field} ${r.id} (${client.displayName}): ${err.message}`);
      }
      r.updated = new Date();
      saveRow_(t, r);
    });
  });
}

function sendReminder_(kind, appt, client) {
  const d = new Date(Number(appt.startMs));
  const tpl = templateFor_(kind);
  const buttons = kind === 'reminder_24h' ? ['c', 'x', 'r'] : ['c', 'x', 'l'];
  sendTemplate_(String(appt.phone), tpl.name, tpl.params(appt, client, d), buttons.map(b => b + ':' + appt.id));
}

// ---------------------------------------------------------------- webhook

function handleWebhook_(body) {
  const token = PropertiesService.getScriptProperties().getProperty('INTERNAL_TOKEN');
  if (!token || body.token !== token) return { ok: false, error: 'unauthorized' };

  const entries = (body.payload && body.payload.entry) || [];
  entries.forEach(entry => (entry.changes || []).forEach(change => {
    const v = change.value || {};
    (v.messages || []).forEach(m => {
      try {
        handleIncoming_(m);
      } catch (err) {
        log_('ERROR', 'incoming ' + m.id + ': ' + (err.stack || err));
      }
    });
    (v.statuses || []).forEach(s => {
      if (s.status === 'failed') log_('WARN', 'Delivery failed to ' + s.recipient_id + ': ' + JSON.stringify(s.errors || []));
    });
  }));
  return { ok: true };
}

function handleIncoming_(m) {
  let payload = '';
  if (m.type === 'button' && m.button) payload = m.button.payload || '';
  else if (m.type === 'interactive' && m.interactive && m.interactive.button_reply) payload = m.interactive.button_reply.id || '';

  const match = /^([cxrl]):(\w+)$/.exec(payload);
  if (match) {
    handleReply_(m.from, REPLY_STATUS[match[1]], match[2]);
  } else if (['text', 'audio', 'image', 'video', 'document'].includes(m.type)) {
    replyNotMonitored_(m.from);
  }
}

function handleReply_(from, status, apptId) {
  const result = withLock_(() => {
    const t = loadTable_('Appointments');
    const r = t.rows.find(x => String(x.id) === apptId);
    if (!r || String(r.phone) !== String(from) || r.status === 'deleted') return null;
    const prev = r.status;
    Object.assign(r, { status, replyAt: new Date(), updated: new Date() });
    saveRow_(t, r);
    return { appt: r, prev };
  });
  if (!result) {
    log_('WARN', `Reply ${status} for unknown/mismatched appointment ${apptId} from ${from}`);
    return;
  }

  const { appt, prev } = result;
  const client = findClient_(appt.clientId);
  const d = new Date(Number(appt.startMs));
  const when = `ביום ${dayText_(d)} בשעה ${timeText_(d)}`;
  const g = (male, female, neutral) => gendered_(client, male, female, neutral);
  const replies = {
    confirmed: `תודה ${firstName_(appt.name)}, ההגעה אושרה ✅\nנתראה ${when}.`,
    cancelled: `קיבלנו, הפגישה ${when} בוטלה. ${client.displayName} ${g('קיבל', 'קיבלה', 'קיבל/ה')} עדכון.`,
    reschedule: `קיבלנו 🙏 ${client.displayName} ${g('יחזור', 'תחזור', 'יחזור/תחזור')} אליך לתיאום מועד חדש.`,
    late: `תודה על העדכון! ${client.displayName} ${g('מעודכן', 'מעודכנת', 'מעודכן/ת')} 🙏`,
  };
  sendText_(from, replies[status]);

  // The therapist hears about everything except a plain confirmation, once per change.
  if (status === 'confirmed' || prev === status || !client.therapistPhone) return;
  try {
    sendTemplate_(String(client.therapistPhone), 'therapist_alert',
      [appt.name, dayText_(d), timeText_(d), ALERT_TEXT[status]], []);
  } catch (err) {
    log_('ERROR', `Alert to ${client.displayName}: ${err.message}`);
  }
}

/** The business number isn't read by anyone - point the client to their therapist (max once per 6h). */
function replyNotMonitored_(from) {
  const cache = CacheService.getScriptCache();
  if (cache.get('nm:' + from)) return;
  const appt = loadTable_('Appointments').rows
    .filter(r => String(r.phone) === String(from))
    .sort((a, b) => Number(b.startMs) - Number(a.startMs))[0];
  if (!appt) return;
  const client = findClient_(appt.clientId);
  if (!client) return;
  const contact = client.therapistPhone ? ` בטלפון ${formatLocalPhone_(client.therapistPhone)}` : '';
  sendText_(from, `היי, זהו מספר לתזכורות בלבד והודעות כאן לא נקראות.\nלתיאום מול ${client.displayName} אפשר לפנות ישירות${contact}.`);
  cache.put('nm:' + from, '1', 6 * 60 * 60);
}

// ---------------------------------------------------------------- admin (menu)

function addClient() {
  const ui = SpreadsheetApp.getUi();
  const nameRes = ui.prompt('הוספת מטפל/ת', 'השם כפי שיופיע בהודעה ללקוחות (למשל: דנה לוי):', ui.ButtonSet.OK_CANCEL);
  if (nameRes.getSelectedButton() !== ui.Button.OK || !nameRes.getResponseText().trim()) return;
  const phoneRes = ui.prompt('הוספת מטפל/ת', 'הטלפון של המטפל/ת (לקבלת התראות על ביטולים):', ui.ButtonSet.OK_CANCEL);
  if (phoneRes.getSelectedButton() !== ui.Button.OK) return;

  const phone = normalizePhone_(phoneRes.getResponseText());
  if (!phone) {
    ui.alert('מספר הטלפון לא תקין.');
    return;
  }
  const genderRes = ui.prompt('הוספת מטפל/ת', 'מטפל או מטפלת? הקלידו ז או נ (לניסוח ההודעות):', ui.ButtonSet.OK_CANCEL);
  if (genderRes.getSelectedButton() !== ui.Button.OK) return;
  const genderText = genderRes.getResponseText().trim();
  const gender = genderText.startsWith('נ') ? 'f' : genderText.startsWith('ז') ? 'm' : '';
  const client = {
    id: randomId_(8),
    displayName: nameRes.getResponseText().trim(),
    therapistPhone: phone,
    secret: randomId_(24),
    active: true,
    created: new Date(),
    gender,
  };
  withLock_(() => {
    const table = loadTable_('Clients');
    appendRows_(table, [client]);
    table.sh.getRange(client._row, TABLES.Clients.indexOf('active') + 1).insertCheckboxes();
  });
  ui.alert('קוד ההפעלה של ' + client.displayName + ':\n\n' + client.id + '.' + client.secret +
    '\n\nשלחו את הקוד למטפל/ת יחד עם קישור ההעתקה של גיליון המטפל.');
}

/** Sends a sample day-before reminder to the TEST_PHONE script property. */
function testSend() {
  const phone = normalizePhone_(PropertiesService.getScriptProperties().getProperty('TEST_PHONE'));
  if (!phone) throw new Error('Set TEST_PHONE in script properties first');
  const d = new Date(Date.now() + DAY);
  const tpl = templateFor_('reminder_24h');
  const res = sendTemplate_(phone, tpl.name, tpl.params({ name: 'ישראל' }, { displayName: 'דנה לוי' }, d),
    ['c:test', 'x:test', 'r:test']);
  Logger.log(JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------- admin (remote)

/**
 * Lets the operator manage the deployment without opening the editor:
 *   {type:'admin', token, set:{WA_TOKEN:'...'}}   update whitelisted script properties
 *   {type:'admin', token, action:'testSend'}       send the sample reminder to TEST_PHONE
 *   {type:'admin', token, action:'log'}            last 20 Log rows
 *   {type:'admin', token, action:'status'}         property names that are set + appointment counts
 *   {type:'admin', token, action:'setClient', id, fields:{gender:'f'}}   edit a therapist row
 *   {type:'admin', token, action:'headers'}        rewrite header rows after columns were added
 */
function handleAdmin_(body) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('INTERNAL_TOKEN');
  if (!token || body.token !== token) return { ok: false, error: 'unauthorized' };

  const updated = Object.keys(body.set || {}).filter(k => ADMIN_KEYS.includes(k));
  updated.forEach(k => props.setProperty(k, String(body.set[k])));

  const out = { ok: true, updated };
  if (body.action === 'testSend') out.result = testSend();
  if (body.action === 'headers') {
    Object.keys(TABLES).forEach(name => {
      ss_().getSheetByName(name).getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
    });
  }
  if (body.action === 'setClient') {
    const editable = ['displayName', 'therapistPhone', 'gender', 'active'];
    out.client = withLock_(() => {
      const t = loadTable_('Clients');
      const c = t.rows.find(r => String(r.id) === String(body.id));
      if (!c) return null;
      Object.keys(body.fields || {}).filter(k => editable.includes(k)).forEach(k => {
        c[k] = k === 'therapistPhone' ? normalizePhone_(body.fields[k]) : body.fields[k];
      });
      saveRow_(t, c);
      return { id: c.id, displayName: c.displayName, gender: c.gender, active: isActive_(c) };
    });
    if (!out.client) return { ok: false, error: 'client not found' };
  }
  if (body.action === 'log') {
    out.log = loadTable_('Log').rows.slice(-20).map(r => [r.time, r.level, r.message]);
  }
  if (body.action === 'status') {
    const all = props.getProperties();
    out.properties = ADMIN_KEYS.filter(k => all[k]).concat(all.INTERNAL_TOKEN ? ['INTERNAL_TOKEN'] : []);
    out.templateSet = all.TEMPLATE_SET || 'default';
    out.appointments = {};
    loadTable_('Appointments').rows.forEach(r => {
      out.appointments[r.status] = (out.appointments[r.status] || 0) + 1;
    });
    out.clients = loadTable_('Clients').rows.map(c => ({ id: c.id, name: c.displayName, active: isActive_(c), lastSync: c.lastSync }));
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function dayText_(d) {
  return WEEKDAYS[Number(Utilities.formatDate(d, TZ, 'u')) - 1] + ' ' + Utilities.formatDate(d, TZ, 'd.M');
}

function timeText_(d) {
  return Utilities.formatDate(d, TZ, 'HH:mm');
}

/** Therapist-gendered wording; clients' gender is unknown so client-facing verbs stay neutral. */
function gendered_(client, male, female, neutral) {
  const gender = String(client.gender || '').trim().toLowerCase();
  if (gender === 'm' || gender === 'ז') return male;
  if (gender === 'f' || gender === 'נ') return female;
  return neutral;
}

function firstName_(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function toMs_(v) {
  if (v instanceof Date) return v.getTime();
  const n = new Date(v).getTime();
  return isNaN(n) ? 0 : n;
}
