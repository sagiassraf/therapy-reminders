/**
 * Therapist-side connector. Lives in a copy of the template spreadsheet in the
 * therapist's own Google account, reads their calendar + contacts every 10 minutes,
 * and syncs with the central reminder service.
 */

// Set once in the master template, before sharing the "make a copy" link.
const CENTRAL_URL = 'PASTE_CENTRAL_WEB_APP_URL_HERE';

const H = 60 * 60 * 1000;
const WINDOW_HOURS = 48;
const STATUS_SHEET = 'פגישות קרובות';
const PREFIX = { confirmed: '✅ ', cancelled: '❌ ', reschedule: '🔄 ', late: '⏰ ' };
const STATUS_HE = {
  pending: 'ממתין לתשובה',
  confirmed: 'אישר/ה ✅',
  cancelled: 'ביטל/ה ❌',
  reschedule: 'ביקש/ה שינוי מועד 🔄',
  late: 'מאחר/ת ⏰',
  no_phone: 'לא נמצא טלפון ⚠️',
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('תזכורות')
    .addItem('הפעלה', 'activate')
    .addItem('בחירת יומן', 'chooseCalendar')
    .addItem('סנכרון עכשיו', 'syncNow')
    .addItem('כיבוי', 'deactivate')
    .addToUi();
}

function activate() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('הפעלת תזכורות', 'הדביקו את קוד ההפעלה שקיבלתם:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const m = /^(\w+)\.(\w+)$/.exec(res.getResponseText().trim());
  if (!m) {
    ui.alert('הקוד לא תקין. ודאו שהעתקתם אותו במלואו.');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperties({ CLIENT_ID: m[1], SECRET: m[2] });

  let result;
  try {
    result = sync();
  } catch (err) {
    props.deleteProperty('CLIENT_ID');
    ui.alert('ההפעלה נכשלה: ' + err.message);
    return;
  }
  installTriggers_();
  ui.alert('התזכורות הופעלו 🎉\n\nיומן: ' + result.calendar + '\nפגישות ב-48 השעות הקרובות: ' + result.total +
    '\nמתוכן עם טלפון: ' + result.withPhone +
    '\n\nשם הפגישה צריך להיות השם של הלקוח כפי שהוא שמור באנשי הקשר. אם לא יימצא איש קשר, תקבלו התראה בוואטסאפ.' +
    '\nאירוע אישי באותו יומן? התחילו את השם שלו בנקודה, למשל: .רופא שיניים');
}

/** Sync on every calendar change (usually within seconds), plus every 10 minutes as a backup. */
function installTriggers_() {
  removeTriggers_();
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('onCalendarChange').forUserCalendar(getCalendar_().getId()).onEventUpdated().create();
}

function onCalendarChange() {
  sync();
}

function chooseCalendar() {
  const ui = SpreadsheetApp.getUi();
  const cals = CalendarApp.getAllOwnedCalendars();
  const list = cals.map((c, i) => (i + 1) + '. ' + c.getName()).join('\n');
  const res = ui.prompt('בחירת יומן', 'באיזה יומן נמצאות הפגישות? הקלידו מספר:\n\n' + list, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const cal = cals[Number(res.getResponseText().trim()) - 1];
  if (!cal) {
    ui.alert('מספר לא תקין.');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CALENDAR_ID', cal.getId());
  // Already active: move the calendar-change trigger to the new calendar.
  if (props.getProperty('CLIENT_ID') && ScriptApp.getProjectTriggers().length) installTriggers_();
  ui.alert('נבחר היומן: ' + cal.getName());
}

function syncNow() {
  CacheService.getScriptCache().remove('contacts');
  const r = sync();
  SpreadsheetApp.getUi().alert('הסנכרון הסתיים. ' + r.total + ' פגישות, ' + r.withPhone + ' עם טלפון.');
}

function deactivate() {
  removeTriggers_();
  SpreadsheetApp.getUi().alert('התזכורות כובו. אפשר להפעיל מחדש מהתפריט.');
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

// ---------------------------------------------------------------- sync

function getCalendar_() {
  const calId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  return (calId && CalendarApp.getCalendarById(calId)) || CalendarApp.getDefaultCalendar();
}

/** Calendar triggers can fire in bursts; one sync at a time. */
function sync() {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    return doSync_();
  } finally {
    lock.releaseLock();
  }
}

function doSync_() {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('CLIENT_ID');
  const secret = props.getProperty('SECRET');
  if (!clientId) throw new Error('התזכורות עדיין לא הופעלו');

  const cal = getCalendar_();
  const now = new Date();
  const end = new Date(now.getTime() + WINDOW_HOURS * H);

  const events = cal.getEvents(now, end)
    .filter(e => !e.isAllDayEvent() && e.getStartTime() >= now && !isPersonal_(e.getTitle()));
  let contacts = getContacts_(false);
  let items = events.map(e => toItem_(e, contacts));
  // A contact added a minute ago isn't in the 30-minute cache yet - re-read before reporting "no phone".
  if (items.some(it => !it.phone)) {
    contacts = getContacts_(true);
    items = events.map(e => toItem_(e, contacts));
  }

  const res = UrlFetchApp.fetch(CENTRAL_URL, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      type: 'sync',
      clientId,
      secret,
      windowStart: now.getTime(),
      windowEnd: end.getTime(),
      events: items.map(({ eventId, startMs, name, phone }) => ({ eventId, startMs, name, phone })),
    }),
  });
  let out;
  try {
    out = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error('תשובה לא צפויה מהשרת (' + res.getResponseCode() + ')');
  }
  if (!out.ok) throw new Error(out.error === 'unauthorized' ? 'קוד ההפעלה לא מוכר' : out.error);

  const byKey = {};
  items.forEach(it => { byKey[it.eventId + '|' + it.startMs] = it; });
  (out.statuses || []).forEach(s => {
    const it = byKey[s.eventId + '|' + s.startMs];
    if (!it) return;
    Object.assign(it, { status: s.status, sent24: s.sent24, sent1h: s.sent1h });
    markTitle_(it.event, PREFIX[s.status]);
  });

  writeStatusSheet_(items);
  return { total: items.length, withPhone: items.filter(i => i.phone).length, calendar: cal.getName() };
}

function toItem_(event, contacts) {
  const title = stripPrefix_(event.getTitle());
  const contact = contacts[normalizeName_(title)];
  return {
    event,
    eventId: event.getId(),
    startMs: event.getStartTime().getTime(),
    name: contact ? contact.name : title,
    phone: contact ? contact.phone : findPhone_(event.getDescription()),
  };
}

/** Personal events in a shared calendar start with a dot, e.g. ".dentist". */
function isPersonal_(title) {
  return /^\s*\./.test(String(title || ''));
}

function markTitle_(event, prefix) {
  if (!prefix) return;
  const title = event.getTitle();
  const wanted = prefix + stripPrefix_(title);
  if (title === wanted) return;
  try {
    event.setTitle(wanted);
  } catch (err) {
    console.warn('Cannot rename event', title, err);
  }
}

function writeStatusSheet_(items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(STATUS_SHEET) || ss.insertSheet(STATUS_SHEET, 0);
  sh.setRightToLeft(true);
  sh.clearContents();
  const tz = Session.getScriptTimeZone();
  const rows = items.map(it => [
    Utilities.formatDate(it.event.getStartTime(), tz, 'dd/MM HH:mm'),
    it.name,
    it.phone ? "'" + it.phone : '',
    STATUS_HE[it.status] || '',
    it.sent24 ? '✔' : '',
    it.sent1h ? '✔' : '',
  ]);
  const header = ['מועד', 'לקוח/ה', 'טלפון', 'סטטוס', 'תזכורת יום לפני', 'תזכורת שעה לפני'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.getRange(rows.length + 3, 1).setValue('עודכן: ' + Utilities.formatDate(new Date(), tz, 'dd/MM HH:mm'));
  sh.setFrozenRows(1);
}

// ---------------------------------------------------------------- contacts

/** Map of normalized name -> {name, phone}, cached for 30 minutes unless `fresh`. */
function getContacts_(fresh) {
  const cache = CacheService.getScriptCache();
  const hit = fresh ? null : cache.get('contacts');
  if (hit) return JSON.parse(hit);

  const map = {};
  let pageToken;
  do {
    const res = People.People.Connections.list('people/me', {
      personFields: 'names,phoneNumbers',
      pageSize: 1000,
      pageToken,
    });
    (res.connections || []).forEach(p => {
      const phones = p.phoneNumbers || [];
      if (!phones.length) return;
      const best = phones.find(n => n.type === 'mobile') || phones[0];
      const phone = best.canonicalForm || best.value;
      (p.names || []).forEach(n => {
        const variants = [n.displayName, [n.givenName, n.familyName].filter(Boolean).join(' '), n.unstructuredName];
        variants.forEach(v => {
          const key = normalizeName_(v || '');
          if (key && !map[key]) map[key] = { name: n.displayName || v, phone };
        });
      });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);

  try {
    cache.put('contacts', JSON.stringify(map), 30 * 60);
  } catch (err) {
    // Over 100KB - skip caching, it just means a slower sync.
  }
  return map;
}

function normalizeName_(s) {
  return String(s)
    .replace(/[֑-ׇ]/g, '')       // Hebrew niqqud / cantillation
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripPrefix_(title) {
  return String(title || '').replace(/^(\s*(✅|❌|🔄|⏰)\s*)+/u, '');
}

/** Fallback: an Israeli mobile number written in the event description. */
function findPhone_(text) {
  const m = /(?:\+?972[-\s]?|0)5\d[-\s]?\d{3}[-\s]?\d{4}/.exec(String(text || ''));
  return m ? m[0] : '';
}
