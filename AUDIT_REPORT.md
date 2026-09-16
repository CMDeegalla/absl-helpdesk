# ABSL Helpdesk — Pre-Launch Audit and Remediation Report

**Prepared for:** Director / CEO, Automated Barcode Solutions (Pvt) Ltd
**Subject:** Phase 1 platform — full code, security, data and product review
**Date:** 22 August 2026
**Scope:** Every file in the repository, the Supabase schema and policies, the
notification worker, the browser application, and the delivered product
measured against the nineteen Phase 1 sequence diagrams.

---

## 1. Executive summary

The Phase 1 design work was sound. The database carried the right ideas from
the start — optimistic locking on ticket updates, a row-locked atomic stock
decrement, a notification queue with retry and dead-letter handling. Those are
the instincts of a system built to last, and they were in place before this
review.

The implementation, as it stood, could not have been put in front of customers.
The review found **four critical security defects**, any one of which would
have handed control of the platform to a stranger, and **a migration that had
never successfully run**, which meant a third of the intended database
protections did not exist at all. Separately, several workflows that appear in
the diagram deck had no implementation behind them, and photographs uploaded by
customers were stored but never shown to anyone.

All of it has been fixed. The security defects are closed, the migration is
corrected, the missing workflows are built, and the codebase now has an
automated test suite, security headers, an error boundary and a launch runbook.

**Assessment: ready for a staged production launch** once the nine steps in
[LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) are complete. A one-week pilot with
one customer company plus the ABSL technicians is recommended before general
release — not because of any known defect, but because no real user has used
this system yet and there is no substitute for that.

---

## 2. Critical findings and their resolution

### 2.1 Anyone could register themselves as an administrator

**Severity: Critical — full platform compromise**

The signup form sent a `role` field to the database, and the database trusted
it. The dropdown offered only "Customer" and "Technician", but that dropdown
lives in the browser, where anyone can change it. A single request with
`role: "admin"` created an administrator account.

**Fixed.** The role a client sends is now treated as a *request*. Every account
is created as an unprivileged customer. A staff role is granted only by an
approved administrator through `admin_review_registration()`, a database
function that verifies the caller before it does anything. A staff request is
never auto-approved, even from a verified company domain.

### 2.2 Any user could promote themselves after signing up

**Severity: Critical — privilege escalation**

The security policy that let users edit their own profile placed no limit on
*which* fields they could edit. One request setting `role = 'admin'` and
`approval_status = 'approved'` on their own row made any customer an
administrator.

**Fixed.** PostgreSQL has no column-level row security, so a database trigger
now rejects any change a non-administrator makes to their own role, approval
status or company.

### 2.3 An unapproved account could read every ticket in the system

**Severity: Critical — data breach across all customers**

Access checks asked only "what role is this person?" and never "has this person
been approved?". The "waiting for approval" screen existed only in the browser.
An account that had registered but not been approved could bypass the interface
entirely and read every ticket belonging to every customer through the API.

**Fixed.** The role function now returns a role only for an approved profile.
Because every policy in the system routes through that one function, this
closed the hole everywhere at once.

### 2.4 The login page gave away administrator credentials

**Severity: Critical — unauthenticated administrative access**

The login screen carried "Quick Demo Login" buttons that filled in live
production credentials, including the CEO's administrator account. The
passwords were also committed to the repository in a seeding script.

**Fixed.** The buttons are removed, the seeding script now refuses to run and
has been replaced by a script that hands out no passwords at all. **The three
exposed passwords must still be rotated** — that is step 2 of the launch
runbook and only ABSL can do it.

### 2.5 A database migration had never run

**Severity: High — a third of the intended protections were absent**

`0002_production_ready.sql` referenced three columns that do not exist. The
script aborted on its first policy and rolled back entirely. The work it was
supposed to do had never reached the database: no signup trigger (so new
registrations created an account with no profile), no admin alerts table, and
four tables left with security enabled and no policy at all, making them
permanently unreadable.

**Fixed.** The column and function-signature errors are corrected and the
migration now applies cleanly.

### 2.6 Failed writes reported success

**Severity: High — silent data loss and false confidence**

When a security policy blocked a write, the API returned "success, zero rows"
and the interface showed a green confirmation. Deleting a ticket, approving a
user and retrying a notification all displayed success while the database was
untouched. Several of these actions had no policy permitting them at all, so
they had *never once* worked.

**Fixed.** Every write now asks for the affected rows back and treats an empty
result as a failure with a clear message. The missing policies have been added.

### 2.7 Customer photographs and voice notes were unreachable

**Severity: High — the product did not do what it promised**

Attachments uploaded with a ticket were stored correctly and then never shown
to anybody. The detail screen displayed the sentence "Photos and voice notes
are stored with the ticket" and nothing else. An agent could not see the
photograph of the fault the customer had taken the trouble to send.

**Fixed.** Photographs now appear as a gallery and open full size; voice notes
play in the browser. Because the storage buckets are private, each file is
served through a short-lived signed link.

### 2.8 Storage buckets had no access rules

**Severity: High — customer photographs exposed**

The three storage buckets were created by hand with no policies.

**Fixed.** All three are forced private, and access to a file is tied to access
to its ticket. Inventory imports are administrator-only.

### 2.9 The notification worker could send duplicate emails

**Severity: Medium — customer-visible defect**

Two overlapping scheduled runs would both pick up the same pending emails.

**Fixed.** The worker now claims a batch with a row lock that skips rows
another run already holds. Retry backoff is exponential rather than linear, and
the endpoint can be protected with a shared secret.

---

## 3. Phase 1 completeness

Measured against the nineteen diagrams in the Phase 1 deck.

| # | Workflow | Before | Now |
|---|---|---|---|
| 1–4 | Registration, approval, login, re-apply | Working, but role self-assignment | Working and safe |
| 5 | Ticket creation with photo and voice note | Uploads worked, nothing displayed; no way to record audio | Full: in-browser recording, validated uploads, gallery playback |
| 6 | Callback request | A checkbox that nothing acted on | Real queue: request with a number, agent works the queue, one-tap dial, completion note on the thread |
| 7 | Comment thread | Worked; every author shown as "Team member" | Real names and roles, live updates, email on reply |
| 8 | Status flow | Worked | Working, plus a full history panel showing who changed what and when |
| 9 | Location tracking | Text search only; the coordinate columns were never written | GPS capture with accuracy, map opens on the exact pin |
| 10 | Agent ticket list and detail | Showed the literal words "Customer" and "Company" | Real customer and company names, search, filters, pagination |
| 11 | Ticket creation errors | Retry dialogue present | Plus size and type validation before upload, and orphaned-file cleanup |
| 12 | Technician assignment and reassignment | Assignment only, no audit, no notification | Hand-over with a reason, note on the thread, email to the technician, audit entry |
| 13 | Parts and inventory "Work" button | Atomic decrement worked, but fired against whichever ticket was selected | Confirmation, ownership check, parts-used list, automatic low-stock alert |
| 14 | Notification dispatch | Worked | Plus assignment and reply notifications |
| 15 | Company account limits | Written against a hard-coded placeholder; never saved | Real company selection and update |
| 16 | Inventory CSV cleanup | Script worked | Unchanged; import is still a manual paste, which is the right level for a yearly task |
| 17 | Realtime updates | Worked, but every event reloaded everything for everyone | Coalesced into a single refresh |
| 18 | Concurrent update conflict | Offered "Refresh & Overwrite", discarding the other person's change | Shows what actually changed and asks the second person to decide |
| 19 | Dead-letter escalation | The alert trigger referenced columns that do not exist, so notifications could never dead-letter | Working, with an admin digest that does not silently clear unread alerts |

**All nineteen workflows are now implemented.**

---

## 4. What else was improved

**Separate role interfaces.** The four portals now load only the data their
role needs — a technician's browser no longer requests the approval queue or
the notification log. Each has its own name, accent colour and statistics.
Technicians see only jobs assigned to them; previously they saw every assigned
job in the system.

**Automated tests.** Twenty-five tests covering escaping, identifier
validation, upload rules, role permission maths, search and filtering, phone
validation and error mapping. They run against the same file the browser loads.

```bash
npm test
```

**Security headers.** A Content-Security-Policy that permits scripts only from
the site itself, plus HSTS, frame denial, MIME-sniffing protection and a
permissions policy that grants microphone and location only to this site.
Configured for Netlify, Cloudflare Pages and Vercel.

**No third-party runtime dependency.** The Supabase client was loaded from a
public CDN on every page load, meaning a compromise of that CDN would be a
compromise of ABSL's helpdesk. It is now served from the site itself at a
pinned version.

**Error handling.** A global error boundary catches anything unexpected and
tells the user plainly instead of leaving a half-drawn screen. Database errors
are translated into sentences a customer can act on. Loss of connection and
session expiry are both handled.

**Privacy at rest.** Ticket contents, customer names and comment bodies were
being written to browser storage on every screen refresh and left there after
sign-out — a genuine problem on a shared technician tablet. Only interface
preferences are stored now.

**Data quality.** Length limits on titles, descriptions and comments;
coordinate range checks; priority restricted to the three real values.

**Performance.** Nine indexes on the columns every list actually filters by;
ticket lists paginated; ticket detail assembled in one database call rather
than five.

**Accessibility.** Visible keyboard focus, labels on every control, live
regions for status messages, and reduced-motion support.

---

## 5. Architecture

```
Browser (static files, no build step)
  ├── helpers.js   pure logic, unit tested
  ├── app.js       views, state, data access
  └── vendor/      pinned Supabase client
        │
        │  HTTPS + WSS, every request carries the user's token
        ▼
Supabase
  ├── PostgreSQL       row-level security on every table
  ├── Auth             email + password, verification required
  ├── Storage          three private buckets, access tied to ticket access
  ├── Realtime         ticket, comment and alert changes
  └── Edge Function    notification worker, runs on a schedule
        │
        ▼
      Resend  →  customer and staff email
```

The security model rests on one principle: **the browser is never trusted.**
Every rule that matters — who may see a ticket, who may change a status, who
may be granted a role, who may take a part from stock — is enforced inside the
database by policies and functions. The interface hides buttons a person cannot
use, but hiding them is a courtesy, not the control.

---

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Supabase project is on the Free plan** | **Certain** | **High — see below** | **Upgrade to Pro ($25/mo) before general launch** |
| **Resend free plan caps at 100 emails/day** | **High — see below** | **High — see below** | **Upgrade to Resend Pro ($20/mo) before general launch** |
| Email domain not verified in Resend | Medium | High — no notifications reach anyone | Step 5 of the runbook; verify before launch |
| Leaked passwords not rotated | Medium | Critical | Step 2 of the runbook; only ABSL can do it |
| A regression ships unnoticed | Medium | Medium | 25 automated tests plus the manual pass in step 6 |
| Load beyond a few dozen concurrent users | Low | Medium | Paginated and coalesced; not yet load tested |
| Failure with no operator visibility | Medium | Medium | Users see errors; add a monitoring service in Phase 2 |
| Backup never restored in a drill | Low | High | Free plan has no automatic backups at all; Pro adds daily backups, 7-day retention |
| `xlsx` library has known advisories | Low | Low | Development-only, run on ABSL's own files, never in the web app |

### 6.1 The Free-plan risk in full

The database is currently on Supabase's Free tier. Three of its limits are not
theoretical — they are things this specific product will hit in ordinary use:

- **The project auto-pauses after 7 days with no API activity.** A quiet
  weekend or a slow week is enough. Every part of the app — customer,
  technician, admin — goes fully offline until someone opens the Supabase
  dashboard and resumes it by hand. The notification worker's 5-minute
  schedule happens to count as activity and staves this off today, but that
  is a side effect of a cron job, not a guarantee — if that job is ever
  paused, misconfigured, or fails silently, the auto-pause risk returns
  without anyone noticing until a customer reports the site is down.
- **1 GB of file storage, total.** Ticket photos run 2–8 MB each; a few dozen
  active tickets exhaust it within weeks. Once full, every new photo and
  voice-note upload fails.
- **No automatic backups of any kind.** If the database is ever corrupted or
  data is deleted by mistake, there is nothing to restore from. This is the
  real reason the "backup restore drill" risk above cannot even be tested
  yet — there is no backup to drill against.

**Recommendation:** upgrade to Supabase Pro ($25/month) before opening the
platform to real customers. This is a cost decision for the CEO to approve,
not a code change — Project Settings → Billing → Upgrade to Pro.

### 6.2 The Resend free-plan risk in full

Two separate email paths now run through one Resend account: Supabase Auth's
SMTP relay (verification, password reset) and the ticket notification worker
(created, assigned, replied, status changed, dead-letter alerts). Both draw
from the same quota.

Resend's free plan allows **100 emails per day** (3,000/month, but the daily
figure is the binding limit since ticket activity concentrates on business
days, not spread evenly across a month). A single ticket's ordinary life
cycle — created, assigned, two replies, resolved, closed — generates roughly
six emails. At 15–20 tickets a day across all customers, that is 90–120
emails, already at or past the free-plan ceiling on an ordinary day.

The failure mode is not quiet: when Resend returns 429, the worker's retry
logic treats it as an ordinary send failure and escalates to `dead_letter`
after five attempts, firing a critical admin alert for each one. A busy day
would present as a flood of alerts that reads like an outage, at exactly the
moment the platform is being used the most.

**Recommendation:** upgrade to Resend Pro ($20/month) before general launch —
removes the daily cap. Combined with the Supabase upgrade above, total
infrastructure cost is approximately **$45/month**, worth presenting to the
CEO as one figure rather than two separate line items discovered later.

---

## 7. Second-pass audit — every file, read in full

The findings above covered the state of the platform at the first review. A
great deal of code has been added since — migrations 0002 through 0006,
video attachments, resolution receipts, site contact numbers, portal
separation — none of which had been checked line by line as a whole. This
section is that check: all six migrations, `app.js`, `helpers.js`, the
notification worker, every HTML page and the stylesheet, read start to
finish and cross-referenced against each other, not sampled.

Two real defects were found. Both were silent — neither raised an error or
showed a broken screen, they simply did something other than what the code
around them claimed.

**7.1 — Customer replies never reached staff.** The trigger that emails
someone when a comment is added routed a customer's reply to
`tickets.assigned_agent_id` — a column that has never been written to
anywhere in this application, by any button, form, or function. Every
"customer replied" notification generated by this trigger evaluated a
recipient of `NULL` and quietly did nothing, since the day it was written.
Staff only learned of a reply if they happened to be watching the live
dashboard at that moment; anyone not looking right then was never told.
**Fixed:** replies now route to the assigned technician, the one column
that genuinely tracks who is on the job.

**7.2 — Any technician could reassign any ticket.** `reassign_ticket()`
checked only that the caller was staff — agent, technician, or admin —
with no check on whether the calling technician had anything to do with
the ticket in question. In practice, any approved technician account could
reach into a colleague's active job and hand it to someone else, with
neither the colleague nor an agent involved. **Fixed:** a technician may
now claim an unassigned job or hand off one currently assigned to them;
touching a job assigned to someone else requires an agent or admin, exactly
as the feature was described when it was built.

Both fixes are in `supabase/migrations/0006_audit_fixes.sql` — run it after
0005, same as every migration before it. (0006 was amended again in the
third pass below, in place — re-run it if it was already applied once.)

Four smaller issues were found and fixed directly in the same pass, all in
`app.js`:

| Issue | Effect | Fix |
|---|---|---|
| A conflict-resolution dialog built its message with `<strong>` tags | The modal system escapes its body as plain text; the literal characters `<strong>` showed on screen instead of bold text | Message rewritten as plain text |
| The technician "Work" button showed two success toasts | Both the low-level save function and its caller displayed a success message | Redundant one removed |
| The "Edit ticket details" form displayed for any technician, on any ticket | Saving failed with a generic "not permitted" message for a ticket not assigned to them — correct at the database, confusing on screen | Form now only offers itself when the database would actually accept the save |
| A notification's status was interpolated without escaping | Not exploitable — the column is a fixed four-value database enum, never free text — but inconsistent with escaping discipline everywhere else | Escaped for consistency |

Nothing else in the two defects above, or in the four smaller ones, affects
data that was already sent: no ticket, comment, or notification record was
corrupted. The first defect only ever meant a notification silently wasn't
queued; the second was a permission gap between staff, not a customer-facing
one. Verified with `npm test` (30/30) and `npm run build` after every change.

### 7.3 — Third pass: 9-angle automated review, plus a new page and a full responsive pass

Two more rounds of work landed after §7.1–7.2: a dedicated `tickets.html`
page (so a busy ticket list doesn't have to live entirely inside a dashboard
panel) and a full responsive-design pass across all four portals (five real
layout bugs found and fixed by measuring computed CSS at 320–1920px with
realistic stress-test content, not by eyeballing screenshots). That work was
then put through a 9-angle automated code review. Four more real, silent
defects came out of it — two of them the exact same two root causes as
§7.1–7.2, recurring in a new spot each:

| Issue | Effect | Fix |
|---|---|---|
| The agent dashboard's "Ticket Queue" panel — an agent's primary work surface — was capped to a 5-card preview by the new compact-list logic meant for secondary dashboard panels | Searching or filtering a busy queue silently hid every result past the 5th, with no way to see the rest without losing the search on click-through | Agent's Ticket Queue now gets the full, paginated, searchable list, same as `tickets.html`; only genuinely secondary panels (customer's "My Tickets", technician's "My Jobs") stay compact |
| The "Assign or hand over" control was still shown, fully enabled, to a technician viewing a colleague's ticket | `reassign_ticket()` (§7.2) rejects exactly that call — the technician saw a raw RPC error instead of the control simply not being offered | Control is now gated by the same rule the database enforces |
| `reassign_ticket()` blocked a technician from touching a colleague's *active* job (§7.2), but not from handing an *unclaimed* job straight to a colleague without ever working it themselves | "Claim" didn't actually mean claim for yourself — a technician could still redirect an unassigned ticket to whichever colleague they chose | RPC now rejects assigning an unclaimed job to anyone but the caller; the UI's technician dropdown only offers "yourself" when claiming an unclaimed job |
| A customer reply on a ticket with no technician assigned yet still notified nobody | §7.1 fixed replies once a technician exists; a reply on a still-unassigned ticket — arguably the most time-sensitive case, since nobody has looked at it yet — fell into the identical silent hole | Now broadcasts to every approved agent and admin instead of one recipient, since there's no single point of contact yet |

One more duplicate-notification issue was found and fixed alongside these:
assigning a technician inserted a hand-off comment (which the comment
trigger already emails to the customer) *and* sent a second, separate
"technician assigned" email for the same event. The explicit second email
was removed; the comment trigger already covers it.

All four fixes are in the same `supabase/migrations/0006_audit_fixes.sql`
(amended in place, idempotent, safe to re-run) and `app.js`. Verified with
`npm test` (30/30) and `npm run build` (17 files) after the changes.

---

## 8. Recommendations for Phase 2

In the order they would pay off:

1. **Error monitoring** — the single biggest operational gap. Without it, ABSL
   learns about failures from customers phoning in.
2. **End-to-end tests** for the nine workflows in the launch runbook, so a
   release stops depending on someone remembering to check them.
3. **Continuous integration** — run `npm test` on every push.
4. **Backup restore drill** in the first month, then twice yearly.
5. **SLA timers and reporting** — first response time, resolution time,
   tickets per company. The data is already being captured; nothing reads it yet.
6. **In-app inventory import**, replacing the manual SQL paste.
7. **Push notifications or WhatsApp** for technicians in the field, where email
   is the wrong channel.
8. **Customer satisfaction rating** on ticket closure.

---

## 9. Verdict

The platform is secure, complete against its Phase 1 specification, and ready
for a staged launch once the runbook is executed. The engineering judgement in
the original database design was good, and that foundation is what made this
remediation a matter of hours rather than a rewrite.

The one thing this report cannot certify is behaviour under real use. Nothing
in this system has yet been touched by a customer who did not build it. That is
the reason for the one-week pilot, and it is a reason of prudence, not of any
known defect.
