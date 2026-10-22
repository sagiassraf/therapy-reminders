/**
 * Control-sheet access. The script is bound to the control spreadsheet.
 */

const TABLES = {
  // gender: 'm' / 'f' (empty = neutral "יודע/ת" wording)
  // templateSet: key of TEMPLATE_SETS in Code.gs (empty = default)
  Clients: ['id', 'displayName', 'therapistPhone', 'secret', 'active', 'created', 'lastSync', 'gender', 'templateSet'],
  // msg24 / msg1h: WhatsApp message ids of the reminders, to match ❤️ reactions
  Appointments: ['id', 'clientId', 'eventId', 'startMs', 'start', 'name', 'phone', 'status',
    'firstSeen', 'sent24', 'sent1h', 'replyAt', 'updated', 'msg24', 'msg1h'],
  Log: ['time', 'level', 'message'],
};

// Columns stored as plain text so Sheets never turns ids/phones into numbers.
const TEXT_COLUMNS = ['id', 'clientId', 'eventId', 'therapistPhone', 'phone', 'secret', 'name', 'displayName'];

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Last row with a value in column A. getLastRow() alone is fooled by
 * pre-filled cells such as unchecked checkboxes further down the sheet.
 */
function lastRow_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return last;
  const colA = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = colA.length - 1; i >= 0; i--) {
    if (colA[i][0] !== '' && colA[i][0] !== null) return i + 2;
  }
  return 1;
}

function loadTable_(name) {
  const sh = ss_().getSheetByName(name);
  const headers = TABLES[name];
  const last = lastRow_(sh);
  const values = last > 1 ? sh.getRange(2, 1, last - 1, headers.length).getValues() : [];
  const rows = values.map((r, i) => {
    const rec = { _row: i + 2 };
    headers.forEach((h, j) => { rec[h] = r[j]; });
    return rec;
  });
  return { sh, headers, rows };
}

function toValues_(table, rec) {
  return table.headers.map(h => (rec[h] === undefined || rec[h] === null ? '' : rec[h]));
}

function saveRow_(table, rec) {
  table.sh.getRange(rec._row, 1, 1, table.headers.length).setValues([toValues_(table, rec)]);
}

function appendRows_(table, recs) {
  if (!recs.length) return;
  const start = lastRow_(table.sh) + 1;
  table.sh.getRange(start, 1, recs.length, table.headers.length)
    .setValues(recs.map(rec => toValues_(table, rec)));
  recs.forEach((rec, i) => { rec._row = start + i; table.rows.push(rec); });
}

function deleteRows_(table, recs) {
  recs.map(r => r._row).sort((a, b) => b - a).forEach(row => table.sh.deleteRow(row));
}

function findClient_(id) {
  return loadTable_('Clients').rows.find(c => String(c.id) === String(id)) || null;
}

function isActive_(client) {
  return client.active === true || String(client.active).toLowerCase() === 'true';
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function log_(level, message) {
  try {
    ss_().getSheetByName('Log').appendRow([new Date(), level, String(message).slice(0, 2000)]);
  } catch (e) {
    console.error(level, message, e);
  }
}

/** Random id that always starts with a letter (so Sheets keeps it as text). */
function randomId_(length) {
  const hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  return 'k' + hex.slice(0, length - 1);
}

/** Run once from the editor: creates tabs, formats columns and installs triggers. */
function setup() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(TABLES).forEach(name => {
    const headers = TABLES[name];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    headers.forEach((h, i) => {
      if (TEXT_COLUMNS.includes(h)) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });
  const appts = ss.getSheetByName('Appointments');
  appts.getRange(2, TABLES.Appointments.indexOf('startMs') + 1, appts.getMaxRows() - 1, 1).setNumberFormat('0');

  const sheet1 = ss.getSheetByName('Sheet1') || ss.getSheetByName('גיליון1');
  if (sheet1 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('INTERNAL_TOKEN')) props.setProperty('INTERNAL_TOKEN', randomId_(32));

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendDueReminders').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(3).create();

  Logger.log('Setup done. INTERNAL_TOKEN (paste into the Cloudflare Worker): %s',
    props.getProperty('INTERNAL_TOKEN'));
}

/** Daily: drop appointments that ended more than 3 days ago and log rows older than 30 days. */
function cleanup() {
  withLock_(() => {
    const now = Date.now();
    const appts = loadTable_('Appointments');
    deleteRows_(appts, appts.rows.filter(r => Number(r.startMs) < now - 3 * DAY));
    const logs = loadTable_('Log');
    deleteRows_(logs, logs.rows.filter(r => r.time instanceof Date && r.time.getTime() < now - 30 * DAY));
  });
}
