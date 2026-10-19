# תזכורות וואטסאפ לפגישות

תזכורות אוטומטיות בוואטסאפ ללקוחות של מטפלים ומאמנים: יום לפני ושעה לפני, עם כפתורי אישור וביטול.

## מדריכים

1. [docs/01-setup.md](docs/01-setup.md): הקמה חד פעמית (גוגל, וואטסאפ, קלאודפלר).
2. [docs/02-onboard-client.md](docs/02-onboard-client.md): קליטת מטפל חדש, כולל הוראות לשליחה למטפל.

---

## Technical overview (English)

| Folder | Runs in | Role |
|---|---|---|
| `central/` | Apps Script bound to your control sheet | Stores appointments, sends reminders (5-min trigger), handles replies |
| `connector/` | Apps Script bound to each therapist's sheet copy | Reads calendar + contacts every 10 min, syncs with central, marks titles ✅/❌ |
| `worker/` | Cloudflare Worker (free) | Verifies Meta webhook signature, forwards to central |

Appointment statuses: `pending`, `confirmed`, `cancelled`, `no_phone`, `deleted`.
Appointments are keyed by `eventId + startMs`, so a rescheduled event is a new appointment and the old slot becomes `deleted`.

Updating code: edit `central/` only, then Deploy → Manage deployments → Edit → New version (keeps the same URL).
Changes to `connector/` must be pasted into each therapist's copy, so keep logic in `central/`.
