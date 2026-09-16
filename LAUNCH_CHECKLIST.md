# ABSL Helpdesk — Launch Runbook

Steps 1–7 are the go/no-go gate. Do not send the URL to customers until
step 7 passes. Budget about two hours, most of it waiting on email delivery.

For the full findings behind these steps, see [AUDIT_REPORT.md](AUDIT_REPORT.md).

---

## 1. Apply the database migrations (20 min)

Supabase SQL Editor → New query. Paste each file whole, run, and confirm
"Success" before moving to the next. Every file is idempotent, so a failed
run can be fixed and repeated from the top.

| Order | File | What it does |
|---|---|---|
| 1 | `supabase/migrations/0001_initial_schema.sql` | Tables, RLS, core functions. Skip if already applied. |
| 2 | `supabase/migrations/0002_production_ready.sql` | Signup trigger, admin alerts, the policies 0001 left missing. **Never applied successfully before this fix.** |
| 3 | `supabase/migrations/0003_security_hardening.sql` | Closes privilege escalation, adds write policies, private storage. |
| 4 | `supabase/migrations/0004_feature_completion.sql` | Callback queue, reassignment, GPS, attachments, audit trail, indexes. |
| 5 | `supabase/migrations/0005_video_receipts_site_contact.sql` | Video attachments, site contact number, resolution receipts. |
| 6 | `supabase/migrations/0006_audit_fixes.sql` | Two defects from the second-pass audit — see AUDIT_REPORT.md §7. |

Check whether 0001 is already in place first:

```sql
select table_name from information_schema.tables where table_schema = 'public' order by table_name;
```

Verify all six applied:

```sql
select
  (select count(*) from pg_policies where schemaname = 'public')                as policies,
  (select count(*) from pg_trigger where tgname = 'on_auth_user_created')       as signup_trigger,
  (select count(*) from pg_trigger where tgname = 'guard_profile_privileges')   as profile_guard,
  (select count(*) from pg_proc where proname = 'admin_review_registration')    as review_rpc,
  (select count(*) from pg_proc where proname = 'reassign_ticket')              as reassign_rpc,
  (select count(*) from pg_views where viewname = 'staff_directory')            as staff_view,
  (select count(*) from information_schema.tables where table_name = 'ticket_receipts') as receipts_table,
  (select count(*) from pg_proc where proname = 'generate_ticket_receipt')      as receipt_trigger_fn,
  (select pg_get_functiondef('public.queue_comment_notification'::regproc) like '%assigned_technician_id%') as reply_notify_fixed;
```

Expect 30+ policies, 1 for every other column, and `reply_notify_fixed = true`.
That last check specifically confirms 0006 applied — `queue_comment_notification()`
is `CREATE OR REPLACE`, so it has no separate object to count; the text of the
live function is the only reliable proof.

Then check nobody was left without a profile row:

```sql
select u.email from auth.users u left join public.profiles p on p.id = u.id where p.id is null;
```

Any rows: delete those users in the dashboard and have them register again.

---

## 2. Rotate the leaked credentials (10 min)

**Status: done.** `supabase/reset_for_testing.sql` deleted every account,
including the three below — the leaked passwords no longer belong to any
real account. Recorded here so the history stays honest; no live credential
is exposed by this line.

| Account | Status |
|---|---|
| `customer@automatedbarcode.net` | Leaked password, account deleted in the reset |
| `ceo@automatedbarcode.net` (admin) | Leaked password, account deleted in the reset |
| `info@chenitha.net` (technician) | Leaked password, account deleted in the reset — re-registered fresh under a new password |

If any of these three ever get re-registered under their old password by
habit, change it immediately: Dashboard → Authentication → Users → reset.

`seed_demo_accounts.sql` now aborts if run. To create staff, the person
registers in the app and an admin promotes them with
`supabase/bootstrap_staff.sql`. That is the only way to make the first admin —
the application itself can no longer grant a privileged role to anyone.

---

## 3. Upgrade off both free plans (10 min, needs CEO approval)

Two services are on their free tier, and both have limits this specific
product will hit in ordinary use, not edge cases.

**Supabase Free:**
- The project **auto-pauses after 7 days with no API activity** — a quiet
  week takes the whole platform offline until someone manually resumes it
  from the dashboard.
- **1 GB total file storage** — a few dozen ticket photos exhausts it.
- **No automatic backups at all** — nothing to restore from if data is ever
  lost or corrupted.

Upgrade: Project Settings → Billing → Upgrade to **Pro ($25/month)**. Removes
the auto-pause, raises storage to 100 GB, adds daily backups with 7-day
retention. Full case in AUDIT_REPORT.md §6.1.

**Resend Free:**
- **100 emails/day.** A single ticket's life cycle (created, assigned, a
  couple of replies, resolved, closed) is roughly 6 emails. 15–20 tickets a
  day already exceeds the cap — and this account now carries both the
  notification worker *and* the SMTP auth emails from step 4.
- Hitting the cap doesn't fail quietly: it dead-letters and fires a critical
  admin alert per email, flooding the CEO Console on the busiest days.

Upgrade: resend.com → Settings → Billing → **Pro ($20/month)**. Removes the
daily cap. Full case in AUDIT_REPORT.md §6.2.

**Combined: ~$45/month.** One figure to bring to the CEO, not two surprises
found later.

---

## 4. Auth and storage settings (10 min)

Authentication → Providers → Email:
- **Confirm email: ON**
- Minimum password length: 8 or more
- Bot protection / rate limiting on signup: ON

Authentication → URL Configuration:
- Site URL and Redirect URLs point at the real hosted domain

Database → Replication: enable for `tickets`, `ticket_comments`, `admin_alerts`

Storage: `ticket-photos`, `ticket-voice-notes`, `ticket-videos`,
`ticket-service-receipts`, `inventory-csv-imports` must all show **Private**. Migrations 0003, 0005 and 0007
set this; confirm in the UI.

**Custom SMTP — do not skip this.** Supabase's built-in mailer (used for
signup verification and password reset) is rate-limited hard and explicitly
not meant for production. It works fine in testing with 2–3 accounts and then
silently fails once real signups arrive in a batch. Point it at Resend — the
same account you set up in step 6, so there's nothing extra to buy:

Authentication → Settings → SMTP Settings → **Enable Custom SMTP**:

| Field | Value |
|---|---|
| Sender email | `helpdesk@automatedbarcode.net` |
| Sender name | `ABSL Helpdesk` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | your Resend API key |

Trigger a fresh signup afterward and confirm the verification email arrives
from the real domain, not a generic Supabase address. While in this section,
Authentication → Email Templates is worth a pass too — the defaults say
"Supabase," not ABSL.

---

## 5. Deploy the site (15 min)

**Never upload the project folder.** It contains the SQL migrations, local
tooling, and the disabled seed script whose backup still holds the old
passwords. Build a clean publish folder instead:

```bash
npm run build
```

That writes `dist/` — nothing else — and refuses to finish if
anything sensitive has crept in. Deploy `dist/`, not the repository.

Netlify, Vercel and Cloudflare Pages all work; `netlify.toml`, `vercel.json`
and `_headers` carry the security headers and the Content-Security-Policy.

If the Supabase project URL ever changes, update it in three places:
`config.js`, `_headers`, and `vercel.json`.

After deploying, put the live URL into the Site URL field from step 3.

---

## 6. Notification worker (20 min)

```bash
supabase secrets set RESEND_API_KEY=your_resend_key
```

```bash
supabase secrets set FROM_EMAIL=helpdesk@automatedbarcode.net
```

```bash
supabase secrets set WORKER_SECRET=$(openssl rand -hex 24)
```

```bash
supabase functions deploy send-notifications
```

**Verify the sending domain in Resend first.** If `automatedbarcode.net` is
not verified, every email fails and every ticket dead-letters on day one.

Schedule the function every 5 minutes (Database → Cron, or any external
scheduler) sending the header `x-worker-secret: <the value you set>`.

Check the queue drains:

```sql
select status, count(*) from public.notifications group by status;
```

---

## 7. Go / No-Go tests (30 min)

### Security — must all pass

Signed in as an ordinary customer, in the browser console:

**A. Self-promotion must fail**

```js
await supabaseClient.from("profiles").update({ role: "admin", approval_status: "approved" }).eq("id", currentUser.id).select();
```

PASS: an error mentioning *"You may not change your own role"*. FAIL: a row comes back.

**B. Signing up as an admin must produce a customer.** Register with a
personal Gmail, choosing "Technician / Field Staff", then as admin:

```sql
select p.email, p.role, p.approval_status, ar.requested_role
from public.profiles p left join public.approval_requests ar on ar.profile_id = p.id
order by p.created_at desc limit 5;
```

PASS: `role = customer`, `approval_status = pending`, `requested_role = technician`.

**C. An unapproved account must see nothing.** Signed in as that pending account:

```js
await supabaseClient.from("tickets").select("id, title");
```

PASS: an empty array.

**D. Blocked writes must say so.** As a customer, press Delete on a ticket.
PASS: the red *"That change was not permitted…"* message.

**E. No demo logins.** Hard-refresh `login.html`. There must be no
"Quick Demo Logins" panel.

### Function — one pass through the whole product

1. Customer registers, verifies email, signs in.
2. Creates a ticket with a **photo**, a **recorded voice note**, GPS location
   and a callback request.
3. Agent sees it in the queue, **opens the photo and plays the voice note**,
   replies, sees the callback in the Callback Queue and marks it done.
4. Agent assigns a technician; the technician gets an email.
5. Technician opens their job, presses **Work** on a part; stock drops by one
   and the part appears under "Parts used".
6. Technician hands the job to a colleague with a reason; the note appears on
   the thread.
7. Agent moves the ticket to Resolved, then Closed; the customer gets an
   email at each step and the History panel shows every change with names.
8. Admin approves a pending registration as a technician.
9. Admin raises a company account limit.

### Automated

```bash
npm test
```

PASS: 25 tests, 0 failures.

---

## 8. Tell the CEO what is and is not covered

Built and working: all nineteen Phase 1 diagrams.

Deliberately not attempted, and the honest risk register:

- **No end-to-end test suite.** `npm test` covers the pure logic — validation,
  permissions maths, search, error mapping. The workflows above are checked by
  a person, not by a machine.
- **Not load tested.** Realtime bursts are coalesced and lists are paginated;
  this should hold a few dozen concurrent users comfortably. Nobody has proven
  the number.
- **No error monitoring service.** The app now catches and reports its own
  errors to the user, but there is no dashboard where ABSL sees them.
- **No backup restore drill.** Supabase takes daily backups on paid plans;
  nobody has tested restoring one.
- **Single region.** Latency for customers outside Sri Lanka depends on the
  Supabase region chosen.

## 9. Recommended launch shape

Soft-launch to one pilot company plus the ABSL technicians for a week, with the
CEO Console watched daily. Full customer rollout after that week is quiet. The
security holes are closed either way; the reason to stage it is that no real
user has touched this yet.
