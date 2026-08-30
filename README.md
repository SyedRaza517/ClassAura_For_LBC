# EdTech — Staff Hub (Full-Stack)

A college management platform. It started as staff attendance and leave, and is now
the system a whole institution runs on — admissions through to grades. One deployment
serves one college, with its own database.

**Staff and HR**

- **Staff mobile app** — its own in-app **sign in / sign up**, then daily check-in/out, holiday balance, leave requests, documents, daily summaries.
- **Admin dashboard** — 28 pages, 27 of which can be granted to an admin individually (see *Per-page admin access*).
- **Timesheets** — staff log dated work sessions, submit a month as a batch, and an admin approves it or sends it back.
- **Staff Reviews / My Reviews** — structured review forms (strategic, monthly, evaluation, teaching quality) that the reviewee fills in and an admin reviews.
- **Notifications** — a bell in the app, backed by the database, plus push to the mobile app.

**Students and teaching**

- **Attendance Registers — HND** *(admin)* — student registers per module: timetable sessions, mark each student **P**resent / **L**ate / **E**xcused / **A**bsent with comments, and track attendance percentages per module and overall.
- **Assessments** — the HND gradebook: assessments per unit, bulk mark entry, and Distinction/Merit/Pass/Fail analytics.
- **Timetable** — a weekly timetable per course/year/term, auto-seeded from the generated registers and then published to students.
- **Student Reviews** and **PAT** (Personal Academic Tutor) records.
- **Attendance Emails** — banded automatic emails to students based on their attendance percentage.
- **Student portal** — students sign in to see their own attendance, timetable and grades, and raise queries.

**Admissions**

- **Admissions** — the application record, document collection, interview invitations, offer letters and enrolment, with SharePoint filing.
- **Applicant portal** — a prospective student registers, fills in their own application, uploads documents and accepts their offer.
- **ISM** (Intention to Study Meeting) — the admission interview record.
- **SLC** — a tracker for each student's Student Loans Company application.

**Platform**

- **Per-institution configuration** — branding, letters, email wording, attendance bands and integration credentials are all supplied by the college rather than compiled in. See *One deployment, one college* below.
- **Moodle / VLE sync** — imports courses, students and attendance from the institution's own Moodle.
- **CSV export** — one click on holiday balances, leave requests, daily summaries, the staff list, and both HND views.

It has a real **PostgreSQL database**, **login (JWT)**, **role-based access**, and a
**REST API** — 33 route modules and roughly 210 endpoints under `/api`.

```
edtech-hub/
├── server/   Express + Prisma + PostgreSQL API (auth, RBAC, all endpoints)
├── client/   React (Vite) app — staff app, admin dashboard, student + applicant portals
└── scripts/  setup, the test runner and its suites, load test, screenshots
```

---

## ⭐ Quick start

> First install **Node.js LTS** from https://nodejs.org (this provides `npm`).

**You need a PostgreSQL database before you start.** SQLite is gone — the schema uses
Postgres-specific features and the migrations are Postgres SQL. Any Postgres will do:
a local install, Docker, or a free Supabase/Neon project.

1. **Install dependencies** (one command installs both workspaces):
   ```bash
   npm install
   ```
2. **Create `server/.env`.** `npm run setup` copies `server/.env.example` for you, but
   that file still ships a SQLite `DATABASE_URL`, so setup fails until you replace it.
   Write the file yourself, or copy it and fix the one line:
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech"
   JWT_SECRET="a-long-random-string-you-generate"
   CLIENT_URL="http://localhost:5173"
   ```
3. **Choose a demo password.** The seed refuses to run without one — a password
   literal in a committed seed file is a published credential, so there is no default.
   It must be at least 12 characters.
   ```bash
   export SEED_PASSWORD='choose-a-long-demo-password'   # PowerShell: $env:SEED_PASSWORD='…'
   ```
4. **Build and seed the database, then start everything:**
   ```bash
   npm run setup    # prisma generate + prisma migrate deploy + seed demo data
   npm run dev      # API on :4000 and client on :5173, together
   ```
5. Open **http://localhost:5173** and sign in.

`npm run setup` applies the migrations in `server/prisma/migrations` with
**`prisma migrate deploy`** — forward-only, reviewed SQL. It is deliberately *not*
`prisma db push`, which reconciles the database to `schema.prisma` with no history and
can drop a column and its data without asking. See
`server/prisma/migrations/README.md` for the full reasoning and the rules.

> **`npm run setup` re-seeds, which clears the demo tables it owns.** Run it once on a
> fresh database, not against data you care about.

### Which database am I pointed at?

There is no local database file to look at any more, so check the env var:

```bash
npm run studio      # Prisma Studio, against whatever DATABASE_URL says
```

---

## Seeded login accounts

The seed creates this deployment's institution (slug `default`) and these accounts in it.
**They all share whatever you set `SEED_PASSWORD` to** — there is no fixed password.

| Role  | Email |
|-------|-------|
| Admin | `admin@edtech.co.uk` |
| Staff | `j.whitfield@edtech.co.uk`, `a.rahman@edtech.co.uk`, `d.okoye@edtech.co.uk`, `s.marin@edtech.co.uk`, `p.nair@edtech.co.uk` |

- **Admin** sees a VIEW MODE toggle (Staff App ↔ Admin Dashboard) and can act on all data.
- **Staff** see only their own staff app; the "Manager Approval" tile and dashboard are hidden.

`SEED_TENANT_SLUG` names that institution row and defaults to `default`. It does not
choose between institutions — there is only one — so leave it alone unless the row
already exists under a different slug: changing it makes the seed create a *second*
institution row rather than rename the first.

For a real (non-demo) administrator, use the recovery script rather than the seed:

```bash
cd server
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' node create-admin.js
```

It creates the super admin if that email is new and resets it if not. A reset bumps
`tokenVersion`, so every session and reset link issued under the old password dies at
once, and clears two-step verification — this is the documented recovery path, and an
account locked out by a lost authenticator cannot be rescued any other way, because the
super-admin guard stops other admins resetting it. The password must be at least 12
characters, the defaults this project once shipped are refused outright, and it is
never printed.

Browse the database visually anytime with: **`npm run studio`** (opens Prisma Studio).

---

## One deployment, one college

Each college gets its own deployment and its own database. There is no `X-Tenant`
header, no subdomain to resolve and no "which institution is this request for?"
question — every request is about this institution, because it is the only one whose
data the database holds.

That was not always so. Until 30 Aug 2026 several colleges shared one database, and
isolation was enforced centrally in `server/src/db.js`: a Prisma client extension
filtered every read by the caller's tenant, stamped the tenant onto every write, and
threw rather than return rows if a query ran with no tenant context at all.
`scripts/smoke-tenant-isolation.mjs` proved it, by building two institutions that
deliberately collided and failing to reach one from the other through the real HTTP API.

Both are gone, and the trade is worth stating plainly. Isolation is now a property of
the infrastructure rather than of the code: a query that forgets a filter can only
reach rows belonging to the institution whose server it is running on, because there
are no others. But there is also no longer any automated proof that one college cannot
read another's data. If this product ever serves two institutions from one database
again, `db.js` and that suite are the first things that have to come back — both are in
git history at the commit that removed them.

`20260830T210000_remove_multi_tenancy` is the migration that took the columns out. It
**refuses to run** against a database holding more than one institution, because
`tenantId` was half of 18 unique constraints: dropping it does not separate the
colleges, it merges them, and the only record of who belonged to whom is the column
being dropped.

### The institution's own record

One `Tenant` row survives. It is no longer a registry of customers but this
deployment's own settings row — the institution's name, and the parent of its branding,
letters, email templates and integration credentials. `SEED_TENANT_SLUG` names it. Its
only remaining direct reader is `server/src/branding.js`, which uses the institution's
name as the display name until somebody types one on the branding screen.

### Per-institution integration credentials

Moodle, Canvas, Blackboard, SharePoint and SMTP credentials are rows in
`TenantIntegration`, one per provider, managed by the college's own admin under
**Settings → Integrations** (`/api/integrations`) rather than set as process-level
environment variables and redeployed.

What the college has saved wins; `process.env` is the fallback, so a deployment
configured entirely by environment keeps working unchanged. That fallback used to be
fenced off to one named institution, because `MOODLE_*`, `SMTP_*` and `SP_*` describe
**one** college's systems, and handing them to a college that had configured none of
its own is how a student receives an offer letter "from" another institution. With one
college per deployment the host's environment describes the only institution there is,
so the fence is gone — `server/src/integrationConfig.js` sets out the reasoning at
length.

The secret half is **encrypted at rest** with AES-256-GCM (`server/src/secrets.js`) and
is never returned to any client — the API reports only whether it is configured, the
last four characters, and when it was last changed. Non-secret settings (a Moodle URL, a
SharePoint site path) are stored in the clear so the UI can show them back.

Encryption needs **`CREDENTIALS_KEY`**, 32 bytes as base64 or hex:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The key is read per call rather than at import, so a missing key fails the one request
that tries to save a credential instead of stopping the server from booting.

### Institution environment variables

| Variable | Default | What it does |
|---|---|---|
| `SEED_TENANT_SLUG` | `default` | The slug of the single institution row the seed creates or updates. It *names* this deployment's institution; it does not choose between several. |
| `CREDENTIALS_KEY` | *(unset)* | 32-byte base64/hex key encrypting this institution's Moodle, Canvas, Blackboard, SharePoint and SMTP credentials. Unset, those credentials cannot be saved (`503`); everything else works. |

`DEFAULT_TENANT_SLUG`, `TENANT_BASE_DOMAIN` and `TENANT_CACHE_MS` are gone and nothing
reads them. If they are still set on a service that has already been deployed, take
them off by hand: a Render Blueprint only applies `render.yaml` when a service is
*created*, so removing them from that file does not unset them on an existing one.

---

## Two front doors

Anyone who isn't signed in lands on a **landing screen** with two choices:

| Choice | What it opens |
|---|---|
| **Staff App** | The phone UI, with its **own sign in and sign up** built in |
| **Admin Dashboard** | The full-screen administrator login (unchanged) |

Signing out of the staff app returns you to the staff app's sign-in, not the landing
screen. An admin who enters through **Staff App** lands in the staff app and can still
switch to the dashboard with the VIEW MODE toggle.

### The other entry points

Several audiences reach the same client through a URL rather than the landing screen.
These are checked before the sign-in gate, so they work whether or not a stale staff
session exists:

| URL | Who it's for |
|---|---|
| `?apply` | A prospective student filling in the public application form. No account needed. |
| `?upload=<token>` | An applicant uploading their documents from an emailed link (30-day token). |
| `?offer=<token>` | An applicant accepting their offer from an emailed link. |
| `?invite=<token>` | A new staff member activating an admin-created account (7-day link). |
| `?reset=<token>` | Someone completing a password reset (30-minute, single-use link). |

Students and registered applicants sign in normally and are routed to the **student
portal** or the **applicant portal** by the kind of account they hold, not by a
separate URL.

---

## Staff sign-up (in the app, approved by an admin)

Staff create their own accounts from the mobile app — nobody has to be added by hand.

1. **Staff App → Create a staff account.** They enter full name, email, position,
   department, password and confirmation.
2. The request goes to **Sign-Up Requests** on the admin dashboard, and **every admin
   is notified**. No account exists yet: the applicant cannot sign in, and doesn't
   appear in the staff list, calendars or registers.
3. An admin **approves** (setting the holiday allowance) or **declines** with a reason.
   Approval is what creates the staff account — the applicant keeps the password they chose.
4. On first sign-in they must set up an **authenticator app** before they can use the hub.

Applying with an email that already exists returns the same "request sent" message as
any other, so the form can't be used to discover who works at the college. A declined
applicant can apply again.

---

## Two-step verification (authenticator app)

Accounts created through the app are protected by a **TOTP authenticator app** —
Google Authenticator, Microsoft Authenticator, Authy or 1Password. It's implemented
with Node's built-in crypto (RFC 6238), so there's **no third-party service, no API
key and no cost**, and it works offline.

- **First sign-in** shows a QR code plus a typed setup key for anyone who can't scan.
  2FA only switches on once a generated code proves the app was really added.
- **Every later sign-in** asks for the current 6-digit code after the password.
- Codes are 6 digits on a 30-second cycle, and the previous/next code is accepted too,
  so a slightly out-of-sync phone clock still works.
- A correct password on its own is **never** enough: it yields a short-lived challenge
  token that the rest of the API rejects.
- Staff whose 2FA is mandatory cannot switch it off. Anyone who enables it voluntarily
  can remove it by confirming their password.
- **Turning 2FA on from inside the app also needs your password** — otherwise someone
  who found an unlocked screen could add an authenticator only they hold and lock the
  real owner out. (Setting it up during first sign-in doesn't ask again, because you
  just typed your password.)
- **Wrong codes are limited**: 10 inside 15 minutes locks code entry for 15 minutes.
  The limit follows the account, so starting a fresh sign-in doesn't reset it.

### Lost or replaced phone

**Admin Dashboard → Settings** lists every staff member's two-step status —
**On**, **Setup due** or **Off** — and shows a shield button beside anyone who is
enrolled. Resetting them:

- stops their old authenticator codes working immediately;
- forces a fresh enrolment at the next sign-in where 2FA is mandatory, or returns a
  voluntary user to password-only;
- leaves their **password untouched**, so a reset on its own never lets anyone in;
- **notifies the account holder**, so an unexpected reset doesn't go unnoticed.

> **Seeded accounts and the admin dashboard are unchanged** — they still sign in with
> just email and password. 2FA applies to accounts created through the app's sign-up.

---

## Forgotten password

**Forgotten your password?** sits under the sign-in button in both the staff app and the
admin login. Enter your email and a reset link arrives; it opens a page where you choose
a new password.

> **Where's the email?** That depends on how mail is configured — see *Sending real
> email* below. With nothing configured the server runs a console stub and prints the
> whole message, reset link included, to the **server terminal**. That is fine for
> local development and is exactly why it must not be left that way in production.

How it's kept safe:

- **The reply never says whether the address exists.** Known, unknown and rate-limited
  requests all get the same message, so the form can't be used to discover who works here.
- **Only a hash of the token is stored.** The link itself is the only place the real
  token exists, so reading the database doesn't let anyone reset an account.
- **Links expire after 30 minutes and work once.** Asking for a new link, finishing a
  reset, or changing your password kills any older link immediately.
- **Two-step accounts must also enter their authenticator code.** Otherwise anyone who
  reached the mailbox could walk straight past 2FA — the link would become a way *around*
  the second factor instead of a route through it.
- **A reset signs you out on every device**, since people usually reset a password
  precisely because they think someone else has it. That includes any half-finished
  sign-in, so someone holding the old password can't complete one that was already
  under way.
- **A reset clears the login lockout.** Guessing a few times and getting locked out is
  the usual reason people end up here, so the new password works immediately.
- **You are not signed in automatically** afterwards — you sign in fresh, 2FA included.
- Limited to 5 requests per hour for the same address.

Changing your password from inside the app behaves the same way, except the device you
changed it on stays signed in — only the *other* devices are logged out.

---

## Deleting your account

Staff App → **More** → **Delete my account**. It asks for your password, your
authenticator code if two-step verification is on, and the word `DELETE` typed out —
three separate steps, because it cannot be undone.

Deleting removes your profile, check-in history, leave requests, balance adjustments,
notifications and any outstanding password-reset links, plus the original sign-up
record. Documents shared with all staff are untouched; ones assigned personally to
you are detached rather than deleted. Remaining administrators are notified, and your
email address becomes free to sign up again.

The **last remaining administrator cannot delete their own account** — otherwise
nobody could approve leave, take registers, or appoint a replacement. Make someone
else an administrator first.

> This exists because the App Store requires any app offering account creation to
> offer account deletion inside the app; Google Play expects the same.

---

## The two ways an account is created

| Route | What happens |
|---|---|
| **Staff signs themselves up** in the app | Nothing exists yet. The request waits in **Sign-Up Requests** until an admin approves it — only then is an account created, and only then can they sign in. |
| **Admin adds someone** in Settings | The account is created but **cannot be signed into**. That person gets an email with a link to choose their own password, which is what activates it. |

Either way, **nobody can sign in to an account they did not set a password for**.

Settings shows an **Invited** badge against anyone who hasn't activated yet, with a
✉ button to re-send the invitation (links last 7 days). An admin who prefers the old
behaviour can still supply a password when creating the account — then it works
immediately and no invitation is sent.

> **Why this changed.** Admin-created accounts used to be given the shared password
> `password123`, which meant anyone who knew or guessed a colleague's email address
> could sign straight in as them. Accounts now start with a password nobody knows.

If someone signs up with an email that already has an account, the form still shows
the same "request sent" message — otherwise it could be used to check who works at
the college — but the real account holder is emailed so they know, and so a genuine
applicant is told to sign in rather than wait for an approval that will never come.

---

## Passwords & account security

- **Change your own password** anytime — the **Change password** button sits in the
  top bar, next to Sign out. Minimum 8 characters, and it must differ from the current one.
  Other devices are signed out; the one you're using stays signed in.
- **New staff must set their own password.** An admin-created account is given an
  unguessable random password and flagged `pendingActivation` — it cannot be signed
  into at all until that person sets their own password from the emailed invitation.
  (An admin who supplies a password when creating the account skips the invitation;
  such an account is flagged `mustChangePassword` and hits a full-screen gate on first
  sign-in.)
- **Login rate limiting.** 8 failed attempts for the same IP + email inside 15 minutes
  locks that combination for 15 minutes (HTTP 429). The last few attempts warn you how
  many are left, and a successful login clears the counter. It's an in-process limiter —
  fine for one server; a multi-process deployment needs a shared store (e.g. Redis).
- **Passwords are hashed with bcrypt** (cost 10) and never returned by the API.
- **Sessions are JWTs**, 7 days by default and `JWT_EXPIRES=1d` in the shipped Render
  config. If a token expires or is rejected, the app drops you straight back to the
  login screen rather than leaving a broken page.

### Per-page admin access

The admin dashboard is 28 pages, and an admin does not have to get all of them. The
**Super Admin** (`Staff.isSuperAdmin`, exactly one account) assigns which of the 27
grantable pages each admin may open, on the **Access** tab — which is itself Super Admin
only. The server enforces this per route with `requirePage` / `requireAnyPage`, not just
in the UI.

`adminPages` of `NULL` means "never configured" and grants everything, so admins who
predate the feature are not locked out. Note that granting *any* page makes the account
an `ADMIN` — which is why route guards test page grants rather than the role.

---

## Notifications & email

Notifications are stored in the database per user, so they survive a reload — unlike
the transient toasts that pop up after each action.

| Event | Who gets notified |
|---|---|
| A staff member submits a leave request | Every admin |
| An admin approves or declines a request | The requester (including the decision note) |
| A staff member submits a timesheet month | Every timesheets admin |
| An admin approves or bounces back a timesheet month | The staff member |
| A student sends a query | Every admin with the Student Queries page |
| A timesheet month is nearly due | Staff with nothing submitted, the day before month end |
| Birthdays, bank-holiday closures, assessment deadlines | Run daily at 08:00 |

The bell in the staff app loads your **unread** notifications on sign-in; pressing
**Clear** marks them read on the server. Notification failures are deliberately
swallowed, so a notification problem can never break the action that triggered it —
approving leave still succeeds even if the notification doesn't.

The scheduled jobs above run in-process on an hourly tick, not on external cron. Each
run catches its own failures, so an unreachable mailbox or an expired Moodle token is
logged and stepped over rather than killing the timer. (They used to be fanned out per
institution by `server/src/eachTenant.js`; with one college there is nothing to
iterate, and the `.catch` that wrapper also provided is still there.)

> A reply to a student query does **not** currently notify the student — they see it
> the next time they open their queries.

### Push notifications on the mobile app

Every notification above is also pushed to the staff mobile app once Firebase is
configured — see **MOBILE.md** for the setup and `node scripts/check-push.mjs` to
verify it. Unconfigured, pushes are logged to the server console and the in-app bell
and email are unaffected.

### Sending real email

Mail is configured entirely from `server/.env`, and there are three modes. The server
**prints which one is active on startup**, so a stubbed deployment cannot quietly look
healthy:

| Set this | What happens |
|---|---|
| `RESEND_API_KEY` | Sent over Resend's HTTPS API. **Preferred** — it works on hosts that block outbound SMTP ports, which includes Render's free tier. |
| `SMTP_URL`, or `SMTP_HOST` and friends | Sent over SMTP through **nodemailer**. |
| *nothing* | Console stub. Messages are printed to the server terminal and nobody receives anything. |

The stub keeps `npm run dev` working with zero configuration, but note what it means in
production: **the password-reset link is printed into the log stream**, where anyone
with log access can use it. Configure real email before going live.

Different kinds of automated mail go out from different addresses so replies reach the
right team — attendance, PAT, ASK and wellbeing each have their own `MAIL_FROM_*`
override (`server/src/mailFrom.js`). On Microsoft 365 the authenticated mailbox needs
**Send As** permission on each shared mailbox, or the send is rejected.

To use SMTP, edit the SMTP block in `server/.env`:

```env
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587                 # 587 = STARTTLS (usual), 465 = implicit TLS
SMTP_SECURE=false             # true only for port 465
SMTP_USER="no-reply@edtech.co.uk"
SMTP_PASS="your-app-password"
MAIL_FROM="EdTech Staff Hub <no-reply@edtech.co.uk>"
```

A single `SMTP_URL="smtp://user:pass@host:587"` works too. Then check it:

```bash
node scripts/check-email.mjs                  # connect + authenticate only
node scripts/check-email.mjs you@example.com  # also send a test message
```

It tells you exactly which setting is wrong rather than leaving you waiting for an
email that never arrives. The server also prints the active mode on startup, so a
stubbed deployment can't quietly look healthy.

> **Gmail / Google Workspace** need an **App Password** (Google Account → Security →
> 2-Step Verification → App passwords); your normal password will be rejected.
> **Microsoft 365** uses `smtp.office365.com` on port 587.

Delivery is best-effort by design: if the mail server is unreachable the failure is
logged and the action that triggered it still succeeds. Approving leave never fails
because email is down.

---

## CSV export

Every table with an **Export** button writes a CSV straight from the browser (no
server round-trip, no dependencies — see `client/src/csv.js`). Commas, quotes and
newlines inside a value are escaped correctly.

There are around twenty of them now. A representative list:

| Where | File |
|---|---|
| Admin → Holiday Balances | `holiday-balances.csv` |
| Admin → Leave Requests | `leave-requests.csv` |
| Admin → Sign-Up Requests | `signup-requests.csv` |
| Admin → Daily Summaries | `summaries-<date>.csv` |
| Admin → Staff / Settings | `staff.csv` |
| Admin → KPIs | `staff-kpis.csv` |
| Admin → Timesheets | `timesheets-<month>.csv` |
| Registers — HND → Sessions | `sessions-<module>.csv` |
| Registers — HND → one register | `register-<module>-<date>.csv` |
| Registers — HND → Attendance % | `hnd-attendance-<scope>.csv` |
| Admin → Students | `students.csv` |
| Admin → Assessments | `assessment-averages.csv` |
| Admin → Staff Reviews | `staff-reviews.csv` |
| Admin → Student Reviews | `student-reviews.csv` |
| Admin → PAT | `pat-interactions.csv` |
| Admin → SLC | `slc-records.csv` |
| Admin → Admissions | `admissions.csv`, `admissions-selected.csv`, `admission-<name>.csv` |

---

## Tests

```bash
npm test                      # every suite
npm test -- smoke-invite      # one suite (matches on name)
```

`npm test` applies the migrations to `DATABASE_URL`, seeds the fixtures, starts its own
API on port 4010, runs every suite against it, and stops it again. The exit code is 0
only if every suite passed, which is what lets CI gate on it. GitHub Actions runs this
on every push and pull request against a throwaway Postgres container.

> **`DATABASE_URL` must point at a scratch database.** The suites are not read-only —
> they create staff, submit leave, plant password-reset tokens and delete accounts.
> Never point them at production.

`PASS`/`FAIL` mean what they look like. **`SKIP`** means a suite found the feature it
covers switched off in this build, so the gap stays visible instead of reading as
coverage. `smoke-signup-2fa` is currently skipped — mandatory two-factor enrolment is
deliberately off (`TOTP_ENFORCED = false`).

The suites are deliberately weighted toward **negative** assertions — who is refused,
what never leaves the building, which decisions cannot be made twice. Full details,
including how to add a suite, are in `scripts/README.md`.

> `smoke-tenant-isolation`, `smoke-platform` and `smoke-registrations` were deleted
> rather than adapted when the platform stopped being multi-tenant. With no tenancy
> their assertions would have passed while discriminating nothing, which reads as
> coverage on the summary line and is the failure mode `SKIP` exists to avoid.

---

## Useful commands

| Command (run from the project root) | What it does |
|---|---|
| `npm install` | Install server + client dependencies |
| `npm run setup` | Generate the Prisma client, apply migrations, seed demo data |
| `npm run dev` | Start API (port 4000) + client (port 5173) together |
| `npm test` | Run every test suite against a throwaway database |
| `npm run studio` | Open Prisma Studio to view/edit the database |
| `npm run migrate --workspace server` | Create + apply a migration *(development only)* |
| `npm run migrate:deploy --workspace server` | Apply pending migrations *(production — never resets)* |
| `npm run migrate:status --workspace server` | Show which migrations this database has |
| `node scripts/check-push.mjs [token]` | Verify Firebase settings, optionally send a test push |
| `node scripts/check-email.mjs [address]` | Verify SMTP settings, optionally send a test email |
| `node scripts/stress-test.mjs [workers] [secs]` | Closed-loop load test — see `STRESS-TEST.md` |

To start the database over, drop and recreate the Postgres database, then run
`npm run setup` again. (There is no `dev.db` file any more.)

---

## How the two stay connected

Every action hits the API and writes to the database, then the client refetches.
A leave request created in the staff app immediately appears in the admin
**Leave Requests** and **Approvals** pages; approving it there updates the staff
member's **Holiday Balance** and the decision note shows in their history.

## Role-based access (enforced server-side)

| Capability | STAFF | ADMIN |
|------------|:----:|:----:|
| Check in/out, write own daily summary | ✅ | ✅ |
| Request own leave; see own balance/documents | ✅ | ✅ |
| Change own password; read/clear own notifications | ✅ | ✅ |
| See **all** staff data, attendance, summaries | — | ✅ |
| Approve / decline leave | — | ✅ |
| Adjust balances, edit allowances | — | ✅ |
| Upload / delete documents | — | ✅ |
| Add / edit / remove staff | — | ✅ |
| Approve / decline app sign-ups | — | ✅ |
| Reset another staff member's two-step verification | — | ✅ |
| Take HND registers; add students, modules, sessions | — | ✅ |
| Log own timesheet entries and submit a month | ✅ | ✅ |
| Approve or bounce back someone else's timesheet month | — | ✅ |
| Fill in own self-service review | ✅ | ✅ |
| Record a student review about a student they teach | ✅ | ✅ |
| Read every staff review, PAT record or student review | — | ✅ |
| Admissions, ISM, SLC, Assessments, Timetable, Attendance Emails | — | ✅ |
| Manage this institution's Moodle / SharePoint credentials | — | ✅ |
| Assign which admin pages other admins may open | — | Super Admin only |

"ADMIN" above means an admin **who has been granted that page** — see *Per-page admin
access*.

Staff can see colleagues' names, departments and initials (the calendar needs them),
but **not** their email, allowance or account role — `GET /staff` returns a reduced
shape to non-admins, with each user's own record still full.

Students and applicants are separate account kinds, not staff with fewer rights. A
student token reaches only `/api/student` and `/api/auth`, and an applicant token only
`/api/applicant` and `/api/auth` — enforced by an allowlist, so every other router is
closed to them by default.

## How HND attendance is calculated

Registers use the same four marks as the college's Moodle register, each worth points:

| Mark | Meaning | Points |
|------|---------|:------:|
| **P** | Present | 2 |
| **L** | Late | 1 |
| **E** | Excused (authorised absence) | 1 |
| **A** | Absent | 0 |

A student's percentage is the points they earned divided by the points available
across the sessions they were **actually marked for**:

```
pct = points earned / (2 × marked sessions)
```

*Example — 8 Present, 1 Late, 1 Absent:  (8×2 + 1 + 0) = 17 of 20 = **85%***

Sessions where the register hasn't been taken are excluded, so an unmarked
register never drags a student's figure down. The dashboard shows this per
module, per student, and overall across all modules; below 70% shows red,
70–85% amber, 85%+ green.

> Note that the **Attendance Emails** feature bands the same percentage more finely —
> six bands from *Excellent* (85+) down to *High Risk* (under 40) — because each band
> gets a different letter. The three register colours and the six email bands are
> separate scales; don't expect them to line up.

### Per semester

Add teaching periods on the **Semesters** tab — a semester is just a name and a
date range (e.g. *Semester 2, 01 Feb → 30 Jun*). Sessions dated inside the range
count toward it automatically; there's nothing to tag by hand, and ranges can't
overlap, so every session belongs to exactly one semester.

The **Semester** picker at the top of the page then scopes everything —
each student's percentage per module, their overall across all modules, the
cohort averages, and the sessions list. Choose *All semesters* for the
full-year view.

> Sessions whose date falls outside every semester still count under *All
> semesters*, and the picker offers **Outside any semester** so they're never
> silently lost. The Semesters tab flags them with an amber badge.

## Moodle / VLE sync

Registers, students and grades do not all have to be typed in. The sync imports them
from the institution's Moodle, using that institution's own credentials (see
*Per-institution integration credentials*).

It is **one-way, additive, and never destructive**. Nothing is written back to Moodle,
nothing is deleted here, and **existing marks entered in the Hub are never overwritten**
— conflicts are counted and reported instead. Bulk grade entry stamps `source: "manual"`
for exactly this reason, so a sync cannot revert a correction someone made by hand.

| Moodle | becomes |
|---|---|
| Course | `Course` |
| `"Unit N - …"` section | `Unit` |
| LTI / Turnitin grade item | `Assessment` |
| Enrolled student | `Student` + `Enrolment` |
| Grade | `AssessmentGrade` |
| `mod_attendance` register | `HndSession` + `AttendanceMark` |

Moodle keeps attendance registers at course level, while the Hub keeps them per unit, so
the import fans one register out across units by matching acronyms and unit names.
**That matching is heuristic** — it has an ambiguity margin and a history of charging
attendance to the wrong unit. Course-level sessions that belong to no single unit go to
a synthetic per-course "Tutorial / Seminar" unit rather than being guessed at.

Use **`GET /api/moodle/preview`** first: it reports exactly what a sync would change and
writes nothing. `POST /api/moodle/sync` returns `202` immediately and the caller polls
`/api/moodle/status`; runs are recorded in `MoodleSync`, and a run stuck in `running`
for over an hour is swept to `failed`. A nightly sync also runs at **02:00**
Europe/London.

> The nightly sync is switched on and off in **Settings → Connected systems**;
> `MOODLE_AUTO_SYNC` is only the server-wide default, used when nothing is saved there.
> `GET /api/moodle/status` reports the institution's own saved URL, and says whether
> that came from Settings or from the environment — both readings used to be about the
> server's configuration rather than the college's.

## Database & migrations

**PostgreSQL, everywhere.** The old "SQLite locally, swap one line for production"
arrangement is gone: development, CI and production all run Postgres, so the database
you test against behaves like the one you deploy to.

### The data model

The schema is `server/prisma/schema.prisma` — 62 models. Not one of them carries a
`tenantId` any more: the column, and the 18 compound uniques it was half of, came out
when the platform stopped being multi-tenant.

| Area | Models |
|---|---|
| **This institution** | `Tenant`, `TenantIntegration`, `TenantBranding` |
| **People & accounts** | `Staff`, `Student`, `SignupRequest`, `DeviceToken`, `PasswordReset`, `Notification`, `SentNotification` |
| **Attendance, leave & documents** | `CheckIn`, `Leave`, `Adjustment`, `Document` |
| **Curriculum & timetable** | `Course`, `Unit`, `Cohort`, `Term`, `Semester`, `Enrolment`, `TimetableSlot`, `TermCalendar` |
| **Teaching & assessment** | `Assessment`, `AssessmentGrade`, `HndSession`, `AttendanceMark`, `MoodleSync` |
| **Reviews & pastoral** | `StaffReview`, `StudentReview`, `Interaction` *(PAT)*, `StudentQuery` |
| **Admissions** | `Admission`, `AdmissionDocument`, `AdmissionCourse`, `AdmissionIntake`, `Ism`, `SlcApplication` |
| **Staff operations** | `TimesheetEntry`, `AttendanceEmailConfig` |

A few relationships are worth knowing because they are not obvious from the names:

- **`Admission` doubles as the applicant account.** A prospective student who registers
  on the portal gets a `passwordHash` and `tokenVersion` on their `Admission` row —
  there is no separate applicant table.
- **`Unit` is a module; `Course` is a programme.** Registers, assessments and timetable
  slots hang off `Unit`; enrolment and admissions hang off `Course`.
- **`AdmissionCourse` / `AdmissionIntake` are not `Course`.** They are the admin-managed
  dropdown lists on the application form, deliberately separate from the Moodle-synced
  `Course` table.
- **`SlcApplication.admissionId` is an unenforced string**, not a foreign key — nothing
  currently reads it.
- **`Interaction` is the PAT record**, served from `/api/interactions`.

Every schema change is recorded as a numbered folder of reviewed SQL in
`server/prisma/migrations`, and **nothing changes a database except a file in that
directory**. `prisma db push` is not used and must not be: it reconciles the database
to whatever `schema.prisma` currently says, which means a rename is a drop-and-add that
silently destroys the column's data, there is no history of how production reached its
shape, and there is no way back.

```bash
npm run migrate --workspace server          # create + apply one (development)
npm run migrate:deploy --workspace server   # apply pending ones (production)
npm run migrate:status --workspace server   # what has this database got?
```

`0_init` is the whole schema as it stood on 23 Aug 2026, verified against the live
database before it was written. The migrations that added tenancy and the platform tier
are still in the directory and always will be: Prisma identifies a migration by its
directory name, so renaming or deleting one that has been applied anywhere makes it
look new, it re-runs, fails, and every later migration is then refused with P3009.

`20260830T210000_remove_multi_tenancy` takes it back out. It is hand-written rather
than Prisma-generated, for the same reason the tenancy migration was: the generated
version is correct against an empty database and destructive against one with rows in
it. It raises before any destructive statement if `Tenant` holds more than one row, and
it renumbers the five config singletons onto a constant primary key first — their id
used to be a cuid guaranteed unique per tenant, and an upsert on the new literal would
otherwise insert a second row beside the real one.

Read `server/prisma/migrations/README.md` before changing the schema. It has the rules
that matter — never edit an applied migration, never run `migrate dev` or
`migrate reset` against production, always read the generated SQL before committing it.

## The API surface

Every mount in `server/src/index.js`.

| Mount | What it covers | Who |
|---|---|---|
| `/api/health` | Liveness. No authentication needed | Anyone |
| `/api/auth` | Login, 2FA, password change, `/me`, account deletion | All account kinds |
| `/api/signup` | Self-service staff sign-up and the admin approval queue | Public → admin |
| `/api/passwords` | Admin-initiated password resets | Admin |
| `/api/staff` | Staff records, invitations, 2FA reset, per-page access | Staff / admin |
| `/api/checkins` | Daily check-in, check-out and summaries | Staff |
| `/api/leave` | Leave requests and decisions | Staff / admin |
| `/api/adjustments` | Holiday balance adjustments | Admin |
| `/api/documents` | Shared and personally-assigned documents | Staff / admin |
| `/api/notifications` | The in-app bell | Staff |
| `/api/devices` | Push-notification device registration | Staff |
| `/api/hnd` | HND registers, students, modules, sessions, semesters *(the largest module)* | Admin |
| `/api/assessments` | Gradebook: assessments, bulk marks, grade analytics | Admin |
| `/api/timetable` | Weekly timetable per course/year/term, autofill and publish | Admin |
| `/api/timesheets` | Staff work logs, monthly submission and review | Staff / admin |
| `/api/interactions` | **PAT** — personal academic tutor interaction records | Admin |
| `/api/staff-reviews` | Formal staff appraisals (four form types) | Admin |
| `/api/my-reviews` | A lecturer's own self-service reflection | Staff |
| `/api/student-reviews` | Lecturer records of student progress conversations | Staff / admin |
| `/api/student-queries` | The admin side of student queries | Admin |
| `/api/student` | The student portal: own attendance, grades, timetable, reviews, queries | Student |
| `/api/attendance-emails` | Banded automatic attendance emails and their templates | Admin |
| `/api/admissions` | The application record, documents, interviews, offers, enrolment | Admin |
| `/api/admission-config` | The course and intake dropdown lists | Admin |
| `/api/admission-pdf` | Application form and offer letter PDFs | Admin |
| `/api/admission-apply` | The public application form | Public |
| `/api/admission-uploads` | Document upload from an emailed token link | Token |
| `/api/admission-offers` | Offer acceptance from an emailed token link | Token |
| `/api/applicant` | The applicant portal: register, edit, upload, accept, download | Applicant |
| `/api/ism` | Intention to Study Meeting records | Admin |
| `/api/slc` | Student Loans Company application tracker | Admin |
| `/api/moodle` | VLE sync status, dry-run preview, and sync | Admin |
| `/api/integrations` | This institution's own VLE / SharePoint / SMTP credentials | Admin |

## Security notes for production

Already in place: **bcrypt** password hashing, **login and reset rate limiting**,
**two-step verification** via an authenticator app, **admin-approved sign-up**, a
**hashed single-use password-reset flow** with session revocation, **invited accounts**
that cannot be signed into until activated, server-side **RBAC** on every route with
per-page admin grants, **encrypted integration credentials**, security headers and a CORS allowlist on every
response, and a `JWT_SECRET` that refuses to fall back to a default when
`NODE_ENV=production`.

Still to do before going live:

- Set a long random `JWT_SECRET` in `server/.env` (the shipped value is a placeholder).
- Set `CREDENTIALS_KEY`, or this institution's integration credentials cannot be saved.
- Serve the API over HTTPS and restrict CORS to your client origin (`CORS_ORIGINS`).
- Shorten the token lifetime and add refresh tokens. Revocation exists
  (`tokenVersion`); refresh does not.
- Set `CLIENT_URL` in `server/.env` so reset links point at your real domain.
- Configure `RESEND_API_KEY` (or `SMTP_*`) so reset links actually reach people, and
  confirm with `node scripts/check-email.mjs`. Until then the console stub prints reset
  links into the log.
- Move login and reset rate-limiting, and the leave-decision lock, to a shared store
  (Redis) if you run more than one process. They are in-process module-level maps.

See **API.md** for the endpoint reference — but note it currently documents only the
original auth/leave/HND surface, not the ~20 feature areas added since. **DEPLOY.md**
covers hosting, and `render.yaml` is a working Blueprint. It now lists
`CREDENTIALS_KEY`, but a Blueprint only applies its settings when a service is
*created*, so an already-deployed service still needs that key set by hand.

## Tech stack

### In simple terms

**Frontend (what you see on screen)**
- **React** — builds the screens and buttons
- **Vite** — runs and bundles the app
- **Tailwind CSS** — the styling / design
- **lucide-react** — the icons
- **Recharts** — the charts on the admin dashboard

**Backend (the server / logic)**
- **Node.js** — runs the server code
- **Express** — handles the API requests
- **JWT** — logs users in securely (tokens)
- **bcrypt** — scrambles passwords so they're stored safely

**Database (where data is stored)**
- **PostgreSQL** — the database, one per college
- **Prisma** — lets the code talk to the database

> **In one sentence:** the **React** frontend talks to a **Node.js + Express** backend, which stores everything in a **PostgreSQL** database (through Prisma).

---

### Full breakdown

Full-stack JavaScript monorepo managed with **npm workspaces** (`server/` + `client/`).

### Backend (`server/`)
| Layer | Choice |
|---|---|
| Runtime | **Node.js** (CommonJS) |
| Web framework | **Express 4** |
| Database | **PostgreSQL** |
| ORM | **Prisma 5** (`@prisma/client` + `prisma` CLI) |
| Migrations | `prisma migrate deploy` over reviewed SQL in `server/prisma/migrations` |
| Auth | **JWT** (`jsonwebtoken`) + **bcrypt** password hashing (`bcryptjs`) |
| 2FA | **TOTP** (RFC 6238) hand-rolled on Node `crypto` — no dependency, no third-party service |
| Secrets at rest | **AES-256-GCM** on Node `crypto` (`src/secrets.js`) |
| Middleware | **cors**, **compression**, **dotenv** |
| Email | **Resend** HTTP API, or **nodemailer** over SMTP; console stub when unconfigured |
| PDFs | **pdfkit** — application forms and offer letters |
| File storage | **SharePoint** via Microsoft Graph, falling back to **Supabase Storage** (private bucket, signed URLs) — both over plain `fetch`, no SDK |
| Scheduling | in-process hourly `setInterval`s |
| Dev reload | `node --watch` |

REST API under `/api` — 33 route modules, roughly 210 endpoints. Access is enforced
server-side via `requireAuth`, `requireAdmin`, `requireSuperAdmin`, `requirePage` /
`requireAnyPage`, and the `requireStudent` / `requireApplicant` guards. Student and
applicant tokens are additionally confined to an **allowlist** of routers, so a router
added tomorrow is closed to them by default.

### Frontend (`client/`)
| Layer | Choice |
|---|---|
| Framework | **React 18** (ESM) |
| Build tool / dev server | **Vite 6** (`@vitejs/plugin-react`) |
| Styling | **Tailwind CSS**, compiled at build time (`tailwind.config.js` + PostCSS). It used to load from the Play CDN, which needed the internet on every launch. |
| Icons | **lucide-react** |
| Charts | **Recharts** |
| QR codes | **qrcode** (renders the authenticator enrolment QR client-side) |
| State | React hooks + Context (`useApiStore`, `AuthProvider`) |
| Data fetching | native `fetch` (thin wrapper in `api.js`); JWT stored in `localStorage` |

### Tooling
| Tool | Purpose |
|---|---|
| **npm workspaces** | one install drives both server + client |
| **concurrently** | runs API + client together (`npm run dev`) |
| `scripts/test.mjs` | the test runner behind `npm test` — boots an API, seeds, runs every suite |
| **GitHub Actions** | `.github/workflows/ci.yml` — build, migrate and test on every push and PR |
| **Capacitor** | packages the client as native iOS and Android apps (see `MOBILE.md`) |
| Node `.mjs` scripts | setup, seed, stress/load test, screenshots |
| Prisma Studio | visual DB browser (`npm run studio`) |

**Architecture in one line:** React (Vite) SPA → REST/JSON over `fetch` → Express with
JWT + RBAC → Prisma → PostgreSQL. Every
mutation writes to the DB and the client refetches, keeping the staff app and admin
dashboard in sync.
