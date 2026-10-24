/**
 * WhatsApp template definitions per template set (the same names TEMPLATE_SETS in Code.gs sends).
 * Used to create a set's templates on a therapist's own WhatsApp account after they connect
 * their number (admin action createTemplates). Meta rules: quick-reply buttons max 25 chars,
 * no emoji in buttons, the body can't start or end with a variable.
 * therapist_alert is not here: alerts to therapists always go out from the central number.
 */
const TEMPLATE_DEFS = {
  default: [
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
  ],
  warm: [
    {
      name: 'coach_warm_24h',
      language: 'he',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'היי {{1}} ❤️\nזו תזכורת אוטומטית לפגישה שלנו מחר בשעה {{2}}.\nנתראה עוד 24 שעות ✨',
          example: { body_text: [['נועה', '16:00']] },
        },
        { type: 'BUTTONS', buttons: [
          { type: 'QUICK_REPLY', text: 'אני מגיעה' },
          { type: 'QUICK_REPLY', text: 'התבלבלת, קבענו בשעה אחרת' },
          { type: 'QUICK_REPLY', text: 'צריכה להזיז את הפגישה' },
        ] },
      ],
    },
    {
      name: 'coach_warm_1h',
      language: 'he',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'היי {{1}}\nאנחנו נפגשות בעוד שעה 💁🏽‍♀️\nסמני לי לב על ההודעה שאת מגיעה',
          example: { body_text: [['נועה']] },
        },
      ],
    },
  ],
};
