# ABSL Helpdesk

Client support, field service and helpdesk platform for
**Automated Barcode Solutions (Pvt) Ltd**.

Four role portals over one Supabase project: customers raise tickets with
photos, voice notes and a GPS pin; agents triage, reply and dispatch;
technicians work assigned jobs and draw parts from stock; the CEO console
handles approvals, account limits and platform health.

| Document | Read it when |
|---|---|
| [AUDIT_REPORT.md](AUDIT_REPORT.md) | You want the full pre-launch review and what was fixed |
| [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) | You are deploying — **follow this, not the notes below** |

---

## Run it locally

```bash
npm install
```

```bash
npm start
```

Then open <http://localhost:4173/login.html>.

Point it at a Supabase project by editing `config.js`:

```js
window.ABSL_SUPABASE = {
  url: "https://YOUR_PROJECT.supabase.co",
  anonKey: "YOUR_PUBLISHABLE_KEY"
};
```

The publishable key is designed to be visible in a browser. Access is
controlled by row-level security in the database, not by hiding this key. If
the project URL changes, update it in `config.js`, `_headers` and `vercel.json`.

## Tests

```bash
npm test
```

25 unit tests over `helpers.js` — escaping, upload rules, role permissions,
search, phone validation, error mapping. The manual pass for the full
workflows is step 6 of the launch checklist.

## Database

Apply in order, in the Supabase SQL editor:

| File | Contents |
|---|---|
| `supabase/migrations/0001_initial_schema.sql` | Tables, RLS, ticket versioning, atomic stock decrement |
| `supabase/migrations/0002_production_ready.sql` | Signup trigger, admin alerts, missing policies |
| `supabase/migrations/0003_security_hardening.sql` | Privilege-escalation fixes, write policies, private storage |
| `supabase/migrations/0004_feature_completion.sql` | Callbacks, reassignment, GPS, attachments, audit trail, indexes |

Staff accounts are **not** created by signing up. Everyone registers as a
customer; an administrator grants agent, technician or admin. The first
administrator is made with `supabase/bootstrap_staff.sql`.

## Notification worker

`supabase/functions/send-notifications/index.ts` claims a batch of pending
emails, sends them through Resend, retries with exponential backoff, and
escalates permanent failures to the CEO console. Run it on a five-minute
schedule. Secrets: `RESEND_API_KEY`, `FROM_EMAIL`, `WORKER_SECRET`.

## Inventory import

```bash
node scripts/import_inventory_csv.js old_inventory.csv cleaned_inventory.csv
```

Produces a cleaned file and a rejects file. Import the cleaned one into
`inventory_items`.

## Layout

```
helpers.js              pure logic, unit tested, loaded before app.js
app.js                  views, state, data access
styles.css              design system and portal theming
customer|agent|technician|admin.html    the four role portals
login|register|index|404.html           public pages
vendor/                 pinned Supabase client, served from this site
supabase/migrations/    schema, security, features
supabase/functions/     notification worker
scripts/                one-off inventory tooling
tests/                  npm test
_headers, netlify.toml, vercel.json     security headers and hosting config
```
