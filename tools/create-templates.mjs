// Creates the three WhatsApp templates the system uses. Run: npm run templates
// Reads WA_TOKEN and WABA_ID from .env in the repo root (never committed).
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]));
const API = `https://graph.facebook.com/v25.0/${env.WABA_ID}/message_templates`;

const templates = [
  {
    name: 'reminder_24h',
    language: 'he',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'היי {{1}}!\nתזכורת לפגישה שלך עם {{2}} מחר, ביום {{3}} בשעה {{4}}.\nנשמח לדעת אם את/ה מגיע/ה 🙏',
        example: { body_text: [['דניאל', 'דנה לוי', 'שלישי 21.10', '16:00']] },
      },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'מגיע/ה' },
        { type: 'QUICK_REPLY', text: 'צריך/ה לבטל' },
        { type: 'QUICK_REPLY', text: 'שינוי מועד' },
      ] },
    ],
  },
  {
    name: 'reminder_1h',
    language: 'he',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'היי {{1}}!\nהפגישה שלך עם {{2}} מתחילה בעוד שעה, בשעה {{3}}.\nנתראה!',
        example: { body_text: [['דניאל', 'דנה לוי', '16:00']] },
      },
      { type: 'BUTTONS', buttons: [
        { type: 'QUICK_REPLY', text: 'מגיע/ה' },
        { type: 'QUICK_REPLY', text: 'לא אוכל להגיע' },
        { type: 'QUICK_REPLY', text: 'מאחר/ת בכמה דקות' },
      ] },
    ],
  },
  {
    name: 'therapist_alert',
    language: 'he',
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: 'עדכון לגבי הפגישה עם {{1}} ביום {{2}} בשעה {{3}}:\n{{4}}\n\nנשלח אוטומטית ממערכת התזכורות.',
        example: { body_text: [['דניאל כהן', 'שלישי 21.10', '16:00', 'ביטל/ה את הפגישה ❌']] },
      },
    ],
  },
];

for (const t of templates) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  console.log(t.name, res.status, await res.text());
}
