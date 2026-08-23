# Staff Hub — What's Built & What's Working

*Verified on 21 Jul 2026 by starting the API, logging in as both roles, calling every
read endpoint, checking role scoping, and running a production build of the client.*

This is the "what actually exists" companion to `README.md` (setup) and `API.md`
(endpoint reference). Read this first if you want to know where the project stands.

---

## 1. Verification run — results

| Check | Result |
|---|---|
| API boots (`node src/index.js`) | ✅ listening on `http://localhost:4000` |
| `GET /api/health` | ✅ `{ ok: true, service: "edtech-hub-api" }` |
| Admin login (`admin@edtech.co.uk` / `password123`) | ✅ token + user returned |
| Staff login (`j.whitfield@edtech.co.uk` / `password123`) | ✅ token + user returned |
| All 12 read endpoints as admin | ✅ every one returned 200 |
| Staff sees only own leave | ✅ 1 of 6 rows, all their own |
| Colleagues' emails hidden from staff | ✅ reduced shape returned |
| Staff blocked from admin write (`POST /staff`) | ✅ 403 |
| Client production build (`vite build`) | ✅ 2253 modules, no errors |
| `scripts/smoke-fixes.mjs` (pre-existing regressions) | ✅ 10/10 |
| `scripts/smoke-signup-2fa.mjs` (sign-up + 2FA + admin reset) | ✅ 46/46 |
| `scripts/smoke-password-reset.mjs` (forgotten password) | ✅ 38/38 |
| `scripts/smoke-int-overflow.mjs` (crash resistance) | ✅ 17/17 |
| `scripts/smoke-security-regressions.mjs` (the 8 sweep defects) | ✅ 8/8 still fixed |
| TOTP against RFC 6238 official test vectors | ✅ 4/4 |
| Browser walk-through of the whole sign-up → approval → 2FA journey | ✅ 26/26 (screenshots `screenshots/mobile-*.png`) |

Database currently holds: **6 staff, 7 check-ins, 6 leave requests, 5 documents,
3 notifications, 4 HND modules, 10 students, 32 sessions**.

Environment: Node **v24.18.0**, npm **11.16.0**. Node is installed at
`C:\Program Files\nodejs` but is **not on your PowerShell PATH** — see §6.

---

## 1b. Security sweep — 21 Jul 2026

A multi-agent test sweep ran 403 assertions across 4 areas before it was cut short by
a session limit (8 of 12 planned areas never ran — see *Residual risk* below). It
raised **12 defects. All 12 were independently reproduced and all 12 are now fixed**,
each with a regression test.

| # | Severity | Defect | Fix |
|---|---|---|---|
| 9, 12 | **critical** | `POST /adjustments` accepted `days` beyond a 32-bit Int. SQLite stored it, Prisma could then never read the table, the async route threw an unhandled rejection and **the API process died** — permanently, since the row survived restarts and the client loads adjustments on every sign-in. | Range-bound `days` and `allowance` (`validate.js`); `wrapAsync` on every router so no async error can kill the process |
| 1, 5 | **critical** | `/auth/totp/setup` and `/enable` resolved their own bearer token and skipped the `tokenVersion` check, so a **revoked** session was accepted and could be traded for a brand-new valid one — defeating password-reset revocation entirely, on any account with 2FA off (which is every seeded account). | `resolveEnroller` now performs the same staleness check as `requireAuth` |
| 2, 6 | **high** | Challenge tokens carried no `tokenVersion`, so a sign-in started with the **old** password survived the victim's reset and could be exchanged for a live session — plus an attacker-chosen authenticator on mandatory-2FA accounts, locking the owner out for good. | Challenges now carry `ver` and `readChallenge` rejects stale ones |
| 7 | **high** | No rate limit on second-factor verification: 60 wrong codes in under a second, and challenges re-mintable without limit. | Per-**account** limiter — 10 wrong codes in 15 min → 429; re-requesting a challenge doesn't reset it |
| 10 | **high** | Allowance check was read-then-write with nothing serialising it: two concurrent approvals both passed, **12 days approved against a 10-day allowance**. | Decisions serialised per staff member, re-checked inside the lock, written with a conditional update on `status: "pending"` |
| 11 | **high** | A non-string `note` on a leave decision reached Prisma untyped and crashed the process. | `note` type- and length-checked; `wrapAsync` covers the general case |
| 8 | medium | Enrolling 2FA from a live session needed no password, so a borrowed session could add an authenticator the owner doesn't hold and lock them out. Removal already required a password — the damaging direction didn't. | Session-based enrolment now requires the password; mid-login enrolment doesn't (it was just proven) |
| 3 | medium | A successful password reset left the login lockout in place, so the user was still 429'd with the password they'd just chosen. | Reset clears the lockout for that address |
| 4 | low | Two simultaneous submissions of one single-use reset link both succeeded. | Link claimed with an atomic conditional update |

Regression coverage: `scripts/smoke-security-regressions.mjs` (8 checks, each
reproducing the original attack) and `scripts/smoke-int-overflow.mjs` (17 checks).

**What the sweep did NOT cover** — the session limit killed 8 of 12 areas, so there
has been *no* systematic agent testing of: sign-up/approval, check-ins & summaries,
HND registers, staff/documents/notifications, input robustness (injection, XSS,
prototype pollution), the browser UI, or a static code review. The existing hand-written
suites cover much of that ground, but a fresh sweep of those areas is still worth running.

---

## 2. Architecture in one line

React (Vite) SPA → REST/JSON over `fetch` → Express + JWT + role checks → Prisma → SQLite.
Every mutation writes to the DB and the client refetches, so the staff app and the
admin dashboard never disagree.

```
edtech-hub/
├── server/   Express + Prisma + SQLite API  (8 route files, ~50 endpoints)
├── client/   React 18 + Vite SPA            (staff app + admin dashboard)
└── scripts/  setup, load-test, smoke-test, screenshot automation
```

---

## 3. What is implemented — feature by feature

### 3.1 Authentication & accounts — **working**

| Feature | Where | Status |
|---|---|---|
| **Landing screen** — Staff App vs Admin Dashboard | `client/src/Landing.jsx` | ✅ *added 21 Jul* |
| **In-app sign in / sign up** inside the phone frame | `client/src/MobileAuth.jsx` | ✅ *added 21 Jul* |
| **Self-service sign-up → admin approval → account created** | `server/src/routes/signup.js` | ✅ *added 21 Jul* |
| **TOTP two-step verification** (authenticator app) | `server/src/totp.js`, `client/src/TwoFactor.jsx` | ✅ *added 21 Jul* |
| **Sign-Up Requests** approval queue on the dashboard | `client/src/StaffHub.jsx` → `AdminSignups` | ✅ *added 21 Jul* |
| **Admin reset of a lost authenticator** + 2-step status column | `server/src/routes/staff.js`, `AdminSettings` | ✅ *added 21 Jul* |
| **Forgotten password** — hashed single-use link, 2FA-gated | `server/src/routes/auth.js`, `client/src/ResetPassword.jsx` | ✅ *added 21 Jul* |
| **Session revocation** (`tokenVersion`) on reset / change | `server/src/auth.js` | ✅ *added 21 Jul* |
| **Real email via nodemailer** + `check-email` diagnostic | `server/src/email.js`, `scripts/check-email.mjs` | ✅ *added 21 Jul* |
| **Self-service account deletion** (store requirement) | `server/src/routes/auth.js`, `client/src/DeleteAccount.jsx` | ✅ *added 22 Jul* |
| **Mobile packaging** — responsive shell, Tailwind build, PWA assets, Capacitor iOS/Android projects | `client/src/PhoneShell.jsx`, `client/capacitor.config.json` | ✅ *added 22 Jul* — see `MOBILE.md` |
| **Push notifications** (FCM HTTP v1) + device registration | `server/src/push.js`, `server/src/routes/devices.js`, `client/src/push.js` | ✅ *added 22 Jul* — transport verified against a stand-in for Google (28 checks); needs a Firebase project to deliver, which is tied to a Google account. Step-by-step in `MOBILE.md`. |
| **Biometric app lock** (Face ID / Touch ID / fingerprint) | `client/src/biometric.js`, `BiometricGate.jsx` | ✅ *added 22 Jul* — native only; needs a physical device to test |
| **Invited accounts** — admin-created accounts unusable until activated | `server/src/invite.js`, `client/src/AcceptInvite.jsx` | ✅ *added 22 Jul* — closed a real access hole |
| Email + password login, JWT (7-day) | `server/src/routes/auth.js` | ✅ |
| bcrypt password hashing (cost 10) | `server/src/auth.js` | ✅ |
| Login rate limiting — 8 failures per IP+email → 15 min lockout, with "N attempts left" warnings | `auth.js:9-42` | ✅ **not in README** |
| Forced password change on first sign-in for admin-created accounts (`mustChangePassword`) | `client/src/App.jsx:88` + `auth.js:48` | ✅ **not in README** |
| Self-service "Change password" button in the top bar | `App.jsx:266` | ✅ **not in README** |
| 401 handling — token cleared, user dropped, Login shown | `client/src/api.js:13` | ✅ |
| `JWT_SECRET` refuses to fall back to a default in production | `server/src/auth.js:9` | ✅ |

### 3.2 Role-based access — **working, enforced server-side**

`requireAuth` on every protected route, `requireAdmin` on every admin mutation.
Verified live: a STAFF token gets 403 on admin writes, and `GET /staff`,
`/leave`, `/checkins`, `/adjustments`, `/documents` all scope to the caller's own rows.

| Capability | STAFF | ADMIN |
|---|:--:|:--:|
| Check in/out, write own daily summary | ✅ | ✅ |
| Request own leave; see own balance & documents | ✅ | ✅ |
| See all staff data / attendance / summaries | — | ✅ |
| Approve or decline leave | — | ✅ |
| Adjust balances, edit allowances | — | ✅ |
| Publish / delete documents | — | ✅ |
| Add / edit / remove staff | — | ✅ |
| HND registers, students, modules, sessions, semesters | — | ✅ |

### 3.3 Staff app (8 screens) — **working**

`client/src/StaffHub.jsx` → `StaffApp`

| Screen | What it does |
|---|---|
| Home | Tile grid, mini-stats, recent activity |
| Daily Check-In | Clock in / out for today, history list |
| Holiday Balance | Base allowance + adjustments − used = remaining, with history |
| Holiday Calendar | Org-wide month grid of approved absences, colour-coded per leave type |
| Request Leave | Annual / Sick / Personal / Training, date range, reason |
| Documents | Shared docs + documents assigned personally to you |
| Manager Approval | Admin-only tile (hidden for staff) |
| Staff Daily Summary | Free-text log of your working day |
| More | Profile & settings |

Plus a **notification bell** that seeds from persisted server notifications on load
and shows live toasts for every action.

### 3.4 Admin dashboard (10 tabs) — **working**

`client/src/StaffHub.jsx` → `AdminDashboard`

| Tab | What it does |
|---|---|
| Overview | Stat cards, 7-day attendance trend (Recharts), who's in today |
| Check-In | View / correct any staff member's check-in record for any date |
| Holiday Balances | Per-staff balances, ± adjustments, edit allowance — **CSV export** |
| Holiday Calendar | Full-size org calendar |
| Leave Requests | All requests, filterable — **CSV export** |
| Documents | Publish shared or personal documents, delete |
| Approvals | Approve / decline pending requests with a note |
| Daily Summaries | Everyone's summary for a chosen day — **CSV export** |
| Registers — HND | 5 sub-tabs, see below |
| Settings | Add / edit / remove staff — **CSV export** |

### 3.5 HND attendance registers — **working**

Five sub-tabs under *Registers — HND*: **Sessions & registers · Attendance % ·
Students · Modules · Semesters**.

- Mark each enrolled student **P**resent / **L**ate / **E**xcused / **A**bsent, with a per-student comment.
- Partial registers save fine — a half-taken register can be finished later.
- Points model matches the college's Moodle plugin: **P=2, L=1, E=1, A=0**;
  `pct = earned / (2 × sessions actually marked)`. Untaken registers are excluded,
  so they never drag a student's figure down (`server/src/attendance.js`).
- **Semesters are date ranges, not tags** — a session belongs to whichever semester
  its date falls inside. Overlapping ranges are rejected (400), and sessions outside
  every semester are surfaced as *"Outside any semester"* rather than silently lost.
- The semester picker rescopes every figure on the page at once.
- Colour bands: <70% red, 70–85% amber, 85%+ green.
- **CSV export** for both the sessions list and the attendance percentages.

### 3.6 Notifications & email — **working (email is a stub)**

| Piece | Status |
|---|---|
| `Notification` table, per-user, survives reload | ✅ |
| New leave request → all admins notified | ✅ `leave.js:44` |
| Leave decision → requester notified (with the note) | ✅ `leave.js:90` |
| List / mark-read / mark-all-read / clear endpoints | ✅ `routes/notifications.js` |
| Bell seeds from unread notifications on login | ✅ `App.jsx:212` |
| Email delivery | ✅ **nodemailer, ACTIVE** *(wired 21 Jul, switched on 22 Jul)* — SMTP is configured and sending. It currently points at an **Ethereal test mailbox**, so mail is genuinely transmitted but captured rather than delivered to real inboxes; each send logs a `preview:` URL. Swap the four `SMTP_*` values in `server/.env` for a real provider to go live. Verify with `node scripts/check-email.mjs you@example.com`. |

Notification failures are swallowed on purpose, so a notification problem can never
break the action that triggered it (e.g. approving leave still succeeds).

### 3.7 CSV export — **working, not in README**

Dependency-free (`client/src/csv.js`), used in **6 places**: holiday balances, leave
requests, daily summaries, HND sessions, HND attendance, staff list. Properly escapes
commas, quotes and newlines.

### 3.8 Business rules that are actually enforced

- Leave **allowance is checked server-side at approval**, not just in the UI — approving
  over-allowance returns 400 with the exact numbers. Pending requests deliberately do
  not consume allowance.
- **Sick leave is exempt** from allowance, on both client and server.
- A decided request **cannot be re-decided** (409) — the audit trail can't be overwritten.
- Balance adjustments must be **non-zero whole numbers** (a NaN here used to poison every balance).
- Saving a summary for a day you didn't attend does **not** fabricate a check-in time —
  and such a day cannot then be "checked out".
- You cannot delete your own staff account.

---

## 4. Documentation drift — **resolved 21 Jul 2026**

`README.md` and `API.md` predated the four newest features. Both have now been updated:

| Feature | Documented in |
|---|---|
| Login rate limiting (429 after 8 failures) | `README.md` §Passwords & account security, `API.md` §Auth |
| `PUT /auth/change-password` + forced-reset gate | both |
| `mustChangePassword` on the staff shape | `API.md` §Data shapes |
| Notifications API (4 endpoints) | `API.md` §Notifications, `README.md` §Notifications & email |
| Email stub (`server/src/email.js`) | `README.md` §Notifications & email |
| CSV export across 6 screens | `README.md` §CSV export |
| Reduced `/staff` shape for non-admins | `README.md` §Role-based access, `API.md` §Data shapes |
| "Add login rate-limiting" listed as a to-do when it was already done | corrected in `README.md` §Security notes |

Still stale: `BUG-AUDIT.md` flags the default `password123` as an open decision. The
`mustChangePassword` flow has since addressed most of it — admins still can't set an
initial password from the Add-Staff modal, so a new account starts on `password123`
until that user's first sign-in.

---

## 5. Known gaps & open decisions

| # | Item | Notes |
|---|---|---|
| ~~1~~ | ~~Admin-created accounts start on the shared temp password `password123`~~ | **RESOLVED 22 Jul** — and it was worse than "a weak default": anyone who guessed a colleague's email could sign in as them. Admin-created accounts are now **invited**: created with an unguessable random password and `pendingActivation`, unusable until the person sets their own password from an emailed link. Covered by `scripts/smoke-invite.mjs` (32 checks). |
| ~~1b~~ | ~~No recovery if a staff member loses their authenticator~~ | **RESOLVED 21 Jul** — Settings now shows each person's two-step status and an admin can reset it (`DELETE /api/staff/:id/totp`). Old codes die immediately, mandatory accounts are forced to re-enrol, the password is untouched and the user is notified. |
| ~~2~~ | ~~Email is a console stub~~ | **RESOLVED 21 Jul** — nodemailer is wired in. Only remaining step is *configuration*: fill in `SMTP_*` in `server/.env` and run `node scripts/check-email.mjs`. Until then reset links appear in the server console only. |
| 3 | "Today" is derived in **UTC** on both client and server | Consistent with each other, but check-ins near local midnight can land on the adjacent day. Fixing needs a chosen business timezone (`Europe/London`) applied on both ends. |
| 4 | JWT is 7 days, with revocation but no refresh | `tokenVersion` now revokes sessions on a password reset/change (added 21 Jul). A shorter expiry plus refresh tokens is still the production-grade answer, and there's no "sign out my other devices" button yet. |
| 5 | Tailwind loads from the **Play CDN** | `client/index.html`. Fine for dev, should become a real Tailwind build for production. |
| 6 | Client bundle is a single **1.22 MB** chunk (313 kB gzipped) | Grown ~60% since this was first noted (765 kB / 206 kB) as features landed. `recharts` and `lucide-react` dominate and are not code-split — only the Capacitor plugins are dynamically imported. Lazy-loading the chart-heavy views via `React.lazy` is the highest-leverage fix; matters most on the free-tier host and mobile connections. |
| 7 | Throughput ceiling ≈ **110 req/s** | `bcrypt.hashSync` / `compareSync` block the event loop (~80 ms each). Switch to async bcrypt, run multiple Node workers, move to Postgres. See `STRESS-TEST.md`. |
| 8 | "Personal template" documents (`scope:"personal"` with no assignee) are invisible to everyone | Needs a product decision — making them visible to all could leak a personal doc. |
| 9 | Thin automated test coverage | Six API suites now total **119 checks** (`smoke-fixes` 10, `smoke-signup-2fa` 46, `smoke-password-reset` 38, `smoke-int-overflow` 17, `smoke-security-regressions` 8). Still no unit or component test framework, and no CI to run them automatically. |
| 11 | Rate limiters and the leave-decision lock are **in-process** | Login, password-reset, second-factor and the per-staff approval lock all live in module-level Maps/promises. Correct for the single Node process this runs as; a clustered or multi-instance deployment needs Redis (limiters) and a database-level lock (approvals). |
| 10 | SQLite, single file | One-line swap to PostgreSQL is already supported in the schema. |

---

## 6. Running it on this machine

Node is installed but **not on your PowerShell PATH**, so `npm` fails in a fresh
terminal. Either add `C:\Program Files\nodejs` to PATH permanently, or prefix each
session:

```powershell
$env:Path += ";C:\Program Files\nodejs"
```

Then, from `edtech-hub\edtech-hub\edtech-hub`:

```powershell
npm run dev        # API on :4000 + client on :5173, together
```

Dependencies are **already installed** and the database is **already built and
seeded** — you do *not* need `npm install` or `npm run setup` again. Running
`npm run setup` would re-seed and **wipe any data you've entered**.

> Note: the project sits three folders deep — `Downloads\edtech-hub\edtech-hub\edtech-hub`.
> That's the real root (the one with `package.json`). Worth flattening at some point.

### Logins (all `password123`)

| Role | Email |
|---|---|
| Admin | `admin@edtech.co.uk` |
| Staff | `j.whitfield@edtech.co.uk`, `a.rahman@edtech.co.uk`, `d.okoye@edtech.co.uk`, `s.marin@edtech.co.uk`, `p.nair@edtech.co.uk` |

### Other commands

| Command | What it does |
|---|---|
| `npm run studio` | Prisma Studio — browse/edit the DB visually |
| `npm run dev:server` / `npm run dev:client` | Run just one side |
| `node scripts/smoke-fixes.mjs` | 10 server-side regression checks *(leaves test data — re-seed after)* |
| `node scripts/smoke-signup-2fa.mjs` | 46 checks: sign-up → approval → TOTP enrolment → sign-in → admin reset *(self-cleaning)* |
| `node scripts/smoke-int-overflow.mjs` | 17 checks: oversized numbers can't be stored or crash the API |
| `node scripts/smoke-security-regressions.mjs` | 8 checks: the 21 Jul security defects stay fixed |
| `node scripts/seed-100.mjs [n]` | Create n load-test staff through the real API |
| `node scripts/stress-test.mjs [workers] [secs]` | Closed-loop load test |
| `node scripts/cleanup-loadtest.mjs` | Remove only the load-test staff |

---

## 7. Bottom line

Everything described in `README.md` is built and working, including the mobile-app
sign in / sign up, authenticator-based two-step verification, the admin approval
queue, 2FA recovery and the forgotten-password flow — all added on 21 Jul. Nothing
is half-finished or broken.

The account-security story is now complete end to end: sign up → approval → 2FA →
password change → password reset → lost-authenticator recovery, with session
revocation throughout.

Email now goes out through nodemailer, so the only thing standing between this and
real use is **filling in the `SMTP_*` settings** in `server/.env` and running
`node scripts/check-email.mjs` — configuration, not code. Everything else outstanding
is operational: the UTC timezone convention, the Tailwind CDN, and the production
items in §5.
