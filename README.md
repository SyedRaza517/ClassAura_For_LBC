# EdTech — Staff Hub (Full-Stack)

A connected staff attendance & leave-management system:

- **Staff mobile app** — its own in-app **sign in / sign up**, then daily check-in/out, holiday balance, leave requests, documents, daily summaries.
- **Admin dashboard** — one data-handling page per app feature: attendance, holiday balances, leave requests, approvals, documents, daily summaries, staff management.
- **Attendance Registers — HND** *(admin)* — student registers per module: timetable sessions, mark each student **P**resent / **L**ate / **E**xcused / **A**bsent with comments, and track attendance percentages per module and overall.
- **Notifications** — a bell in the app, backed by the database: admins are told when a leave request arrives, staff are told the moment it's decided.
- **CSV export** — one click on holiday balances, leave requests, daily summaries, the staff list, and both HND views.

It has a real **database**, **login (JWT)**, **role-based access**, and a **REST API**.

```
edtech-hub/
├── server/   Express + Prisma + SQLite API (auth, RBAC, all endpoints)
└── client/   React (Vite) app — staff app + admin dashboard, wired to the API
```

---

## ⭐ Quick start (IntelliJ IDEA Ultimate / WebStorm)

> First install **Node.js LTS** from https://nodejs.org (this provides `npm`).

1. **Unzip** this folder anywhere.
2. In your IDE: **File → Open…** and select the **outer `edtech-hub` folder** (not `server` or `client`). Both appear together in the Project panel.
3. Open the terminal (**Alt+F12**) and run these **three commands once**:
   ```bash
   npm install      # installs BOTH server and client (npm workspaces)
   npm run setup     # creates .env files, builds the database, loads demo data
   npm run dev       # starts the API and the app together
   ```
4. Open **http://localhost:5173** and sign in.

That's it — `npm run dev` runs the server **and** client in one terminal, side by side.

### Even easier: click ▶ in the IDE
This project ships with ready-made **Run configurations**. In the top-right Run dropdown you'll see:
- **1 · Setup (first time)** — run this once (after `npm install`).
- **2 · Dev (server + client)** — click ▶ to launch everything.

(After unzipping, run `npm install` in the terminal once so the IDE can find the tools, then the ▶ buttons work. If the IDE asks for a Node interpreter, point it at the Node you installed.)

> **Note on `npm install`:** it needs an internet connection the first time to download dependencies.

---

## Seeded login accounts (password for all: `password123`)

| Role  | Email |
|-------|-------|
| Admin | `admin@edtech.co.uk` |
| Staff | `j.whitfield@edtech.co.uk`, `a.rahman@edtech.co.uk`, `d.okoye@edtech.co.uk`, `s.marin@edtech.co.uk`, `p.nair@edtech.co.uk` |

- **Admin** sees a VIEW MODE toggle (Staff App ↔ Admin Dashboard) and can act on all data.
- **Staff** see only their own staff app; the "Manager Approval" tile and dashboard are hidden.

Browse the database visually anytime with: **`npm run studio`** (opens Prisma Studio).

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

> **Where's the email?** SMTP is active but pointed at a test mailbox, so the message
> is sent for real and then captured rather than delivered. Look in the **server
> terminal** for the `preview:` link on the `[email] sent to …` line and open it —
> you'll see the branded email with its "Choose a new password" button, exactly as
> the recipient would. Point `SMTP_*` at your own provider and it lands in a real
> inbox instead.

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
- **New staff must set their own password.** When an admin adds someone, the account
  starts on the temporary password `password123` and is flagged `mustChangePassword`.
  On first sign-in that user hits a full-screen gate and cannot reach the app until
  they've chosen a new password.
- **Login rate limiting.** 8 failed attempts for the same IP + email inside 15 minutes
  locks that combination for 15 minutes (HTTP 429). The last few attempts warn you how
  many are left, and a successful login clears the counter. It's an in-process limiter —
  fine for one server; a multi-process deployment needs a shared store (e.g. Redis).
- **Passwords are hashed with bcrypt** (cost 10) and never returned by the API.
- **Sessions are JWTs** valid for 7 days. If a token expires or is rejected, the app
  drops you straight back to the login screen rather than leaving a broken page.

---

## Notifications & email

Notifications are stored in the database per user, so they survive a reload — unlike
the transient toasts that pop up after each action.

| Event | Who gets notified |
|---|---|
| A staff member submits a leave request | Every admin |
| An admin approves or declines a request | The requester (including the decision note) |

The bell in the staff app loads your **unread** notifications on sign-in; pressing
**Clear** marks them read on the server. Notification failures are deliberately
swallowed, so a notification problem can never break the action that triggered it —
approving leave still succeeds even if the notification doesn't.

### Push notifications on the mobile app

Every notification above is also pushed to the staff mobile app once Firebase is
configured — see **MOBILE.md** for the setup and `node scripts/check-push.mjs` to
verify it. Unconfigured, pushes are logged to the server console and the in-app bell
and email are unaffected.

### Sending real email

Mail goes out through **nodemailer**, configured entirely from `server/.env`.

> **Currently active, pointed at a test mailbox.** `server/.env` holds working
> credentials for **Ethereal**, nodemailer's throwaway SMTP service. Mail really is
> sent over SMTP — but Ethereal *captures* it rather than delivering onward, so
> **nothing reaches a real inbox**. Every send logs a `preview:` link in the server
> terminal where you can read the message exactly as the recipient would. This
> proves the whole chain works before you commit real credentials.
>
> **To go live, replace the four `SMTP_` values in `server/.env` with your
> provider's** and put your own address in `MAIL_FROM`. Nothing else changes.

To point it at a real provider, edit the SMTP block in `server/.env`:

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

| Where | File |
|---|---|
| Admin → Holiday Balances | `holiday-balances.csv` |
| Admin → Leave Requests | `leave-requests.csv` |
| Admin → Daily Summaries | `summaries-<date>.csv` |
| Admin → Settings (staff list) | `staff.csv` |
| Registers — HND → Sessions | `sessions-<module>.csv` |
| Registers — HND → Attendance % | `hnd-attendance-<scope>.csv` |

---

## Useful commands

| Command (run from the project root) | What it does |
|---|---|
| `npm install` | Install server + client dependencies |
| `npm run setup` | Create `.env` files, build & seed the database |
| `npm run dev` | Start API (port 4000) + client (port 5173) together |
| `npm run studio` | Open Prisma Studio to view/edit the database |
| `node scripts/smoke-fixes.mjs` | 10 API regression checks *(leaves a little test data)* |
| `node scripts/smoke-signup-2fa.mjs` | 46 checks over sign-up → approval → 2FA → admin reset *(self-cleaning)* |
| `node scripts/smoke-password-reset.mjs` | 38 checks over the forgotten-password flow *(self-cleaning)* |
| `node scripts/smoke-int-overflow.mjs` | 17 checks that oversized numbers can't crash the API |
| `node scripts/smoke-security-regressions.mjs` | 8 checks that the security defects found on 21 Jul stay fixed |
| `node scripts/smoke-account-deletion.mjs` | 26 checks over self-service account deletion |
| `node scripts/smoke-push.mjs` | 24 checks over push-notification device registration |
| `node scripts/smoke-invite.mjs` | 32 checks that admin-created accounts can't be used until activated |
| `node scripts/smoke-push-transport.mjs` | 28 checks over the Firebase transport *(no credentials needed)* |
| `node scripts/check-push.mjs [token]` | Verify Firebase settings, optionally send a test push |
| `node scripts/check-email.mjs [address]` | Verify SMTP settings, optionally send a test email |

To reset the database, delete `server/prisma/dev.db` and run `npm run setup` again.

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

Staff can see colleagues' names, departments and initials (the calendar needs them),
but **not** their email, allowance or account role — `GET /staff` returns a reduced
shape to non-admins, with each user's own record still full.

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

## Switching to PostgreSQL (production)

1. In `server/prisma/schema.prisma` change `provider = "sqlite"` to `provider = "postgresql"`.
2. Set `DATABASE_URL` in `server/.env` to your Postgres connection string.
3. Run `npm run setup` again.

## Security notes for production

Already in place: **bcrypt** password hashing, **login and reset rate limiting**,
**two-step verification** via an authenticator app, **admin-approved sign-up**, a
**hashed single-use password-reset flow** with session revocation, a **forced password
change** for admin-created accounts, server-side **RBAC** on every route, and a
`JWT_SECRET` that refuses to fall back to a default when `NODE_ENV=production`.

Still to do before going live:

- Set a long random `JWT_SECRET` in `server/.env` (the shipped value is a placeholder).
- Serve the API over HTTPS and restrict CORS to your client origin.
- Replace the Tailwind Play CDN (in `client/index.html`) with a proper Tailwind build.
- Shorten the token lifetime (currently 7 days) and add refresh + revocation.
- Set `CLIENT_URL` in `server/.env` so reset links point at your real domain.
- Fill in the `SMTP_*` settings so reset links actually reach people, and confirm with
  `node scripts/check-email.mjs` (console-only until you do).
- Move login and reset rate-limiting to a shared store (Redis) if you run more than one process.
- Let admins set an initial password when creating staff, so new accounts don't start
  on the shared temporary `password123`.

See **API.md** for the full endpoint reference.

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
- **SQLite** — the actual database file
- **Prisma** — lets the code talk to the database (swap to **PostgreSQL** for production)

> **In one sentence:** the **React** frontend talks to a **Node.js + Express** backend, which stores everything in a **SQLite** database (through Prisma).

---

### Full breakdown

Full-stack JavaScript monorepo managed with **npm workspaces** (`server/` + `client/`).

### Backend (`server/`)
| Layer | Choice |
|---|---|
| Runtime | **Node.js** (CommonJS) |
| Web framework | **Express 4** |
| Database | **SQLite** (swap to PostgreSQL by changing one line) |
| ORM | **Prisma 5** (`@prisma/client` + `prisma` CLI) |
| Auth | **JWT** (`jsonwebtoken`) + **bcrypt** password hashing (`bcryptjs`) |
| 2FA | **TOTP** (RFC 6238) hand-rolled on Node `crypto` — no dependency, no third-party service |
| Middleware | **cors**, **dotenv** |
| Email | **nodemailer** — SMTP from env vars, console stub when unconfigured |
| Dev reload | `node --watch` |

REST API under `/api`; role-based access enforced server-side via `requireAuth` / `requireAdmin` middleware.

### Frontend (`client/`)
| Layer | Choice |
|---|---|
| Framework | **React 18** (ESM) |
| Build tool / dev server | **Vite 6** (`@vitejs/plugin-react`) |
| Styling | **Tailwind CSS** (via Play CDN in `index.html`) |
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
| Node `.mjs` scripts | setup, seed, stress/load test, smoke tests |
| Prisma Studio | visual DB browser (`npm run studio`) |

**Architecture in one line:** React (Vite) SPA → REST/JSON over `fetch` → Express with JWT + RBAC → Prisma → SQLite. Every mutation writes to the DB and the client refetches, keeping the staff app and admin dashboard in sync.
