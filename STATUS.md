# Staff Hub — What's Built & What's Working

*Reviewed 23 Aug 2026 against the code on `feat/tenancy`.*

This is the "what actually exists" companion to `README.md` (setup) and `API.md`
(endpoint reference). Read this first if you want to know where the project stands.

## How this was checked — and what that does and does not prove

This revision was produced by **reading the code**: every route mounted in
`server/src/index.js`, the Prisma schema, the migrations, the test runner and its
suites, the schedulers, and the client's routing and navigation.

**Nothing here was re-verified by running the API.** The last live verification run was
21 Jul 2026, before roughly two dozen features landed, so its results tell you little
about the system as it stands. Where a claim rests on code reading alone — which is most
of them — it is a statement about what the code says it does, not a demonstration that
it works. Anything genuinely uncertain is marked **unverified**, and the honest way to
close that gap is `npm test` against a scratch database plus a manual pass over the
feature areas the suites do not reach (§5).

The previous edition of this file said "everything described in README.md is built and
working" and "nothing is half-finished or broken". Neither claim was supportable then
at that confidence, and neither is made here.

---

## 1. What this is now

It is no longer a staff attendance app. It is a multi-tenant college management
platform, and the July 2026 description of it — SQLite, 8 route files, ~50 endpoints —
understated it by roughly a factor of four.

| | July 2026 | Now |
|---|---|---|
| Database | SQLite file | **PostgreSQL** |
| Schema changes | `prisma db push` | **`prisma migrate deploy`** over reviewed SQL |
| Route modules | 8 | **33** |
| Endpoints | ~50 | **212** |
| Prisma models | ~20 | **39** |
| Admin dashboard pages | 10 | **28**, 27 of them individually grantable |
| Account kinds | staff | staff, **student, applicant, platform operator** |
| Institutions | one | **many, on one shared database** |
| Tests | 5 suites, run by hand | **10 suites** behind `npm test`, run by **CI** |

```
edtech-hub/
├── server/   Express + Prisma + PostgreSQL API  (33 route modules, 212 endpoints)
├── client/   React 18 + Vite SPA                (staff app, admin dashboard,
│                                                 student + applicant portals,
│                                                 platform dashboard)
└── scripts/  setup, the test runner + suites, load test, screenshots
```

**Architecture in one line:** React (Vite) SPA → REST/JSON over `fetch` → Express with
JWT + RBAC → tenant middleware → Prisma (isolation extension) → PostgreSQL.

---

## 2. Multi-tenancy — the newest and most load-bearing change

This is the part a prospective customer's IT team will ask about, so it is worth being
precise about what is and is not done.

### Done

| Piece | Where | Notes |
|---|---|---|
| `Tenant` model; `tenantId` on all 37 other tables | `server/prisma/schema.prisma` | Only `Tenant` and `PlatformAdmin` are exempt |
| **Isolation enforced centrally** in the Prisma client extension | `server/src/db.js` | Filters, stamps, and **throws** on a query with no tenant context. A new route is isolated without its author doing anything |
| `crossTenant()` / `runInTenant()` escape hatches | `server/src/db.js` | Deliberately conspicuous, so cross-institution reads show up in a diff |
| Per-request tenant resolution: `X-Tenant` → subdomain → `DEFAULT_TENANT_SLUG` → `default` | `server/src/tenant.js` | Runs **before** auth, because `Staff.email` is unique per tenant now |
| Unknown tenant → 404 without confirming existence; suspended → 403 | `server/src/tenant.js` | Deliberately not "tenant x does not exist" |
| Sessions bound to their institution (`tid` claim checked) | `server/src/auth.js` | A valid token from college A is refused against college B |
| Data-safe tenancy migration (nullable → backfill → enforce) | `migrations/20260823120000_multi_tenancy` | Prisma's generated version would have failed on any non-empty database |
| Platform-admin tier, separate from `Staff.isSuperAdmin` | `server/src/platformAuth.js`, `routes/platform.js` | Own token kind, own 8h expiry, mounted above the tenant middleware |
| Platform dashboard at `?platform` | `client/src/PlatformDashboard.jsx` | List, provision, suspend, delete institutions |
| Per-institution Moodle / SharePoint credentials, AES-256-GCM at rest | `TenantIntegration`, `src/secrets.js`, `routes/integrations.js` | Secret never returned to any client — only a hint and change metadata |
| Schedulers fan out per tenant | `server/src/eachTenant.js` | One college's failure is logged and stepped over |
| **An isolation test suite** | `scripts/smoke-tenant-isolation.mjs` | Builds two colliding institutions and attacks one from the other over real HTTP |

### Not done, or done only partly

| # | Item | Detail |
|---|---|---|
| T1 | **The web client never sends `X-Tenant`** | Confirmed by grep: the header appears nowhere in `client/src` except as label text in the platform dashboard. The browser client therefore depends on the subdomain or `DEFAULT_TENANT_SLUG`. Multi-tenant use on a single hostname does not work from the web client today. |
| T2 | **SharePoint's Graph token cache is not tenant-keyed** | `server/src/sharepoint.js:119` holds one module-level `tokenCache`. Credentials are resolved per tenant, but the *token* is not, so within its ~1h lifetime institution A's token can be reused for institution B's upload. `integrationConfig` was carefully keyed by tenant; this cache was missed. **Likely a genuine cross-tenant defect. Not runtime-verified — verify before any second customer goes live.** |
| T3 | Per-tenant Moodle `autoSync` is stored but never read | The nightly sync's switch is the process-wide `MOODLE_AUTO_SYNC`. Turning auto-sync off for one college does nothing. |
| T4 | `GET /api/moodle/status` reports `process.env.MOODLE_URL` | Not the institution's saved URL, and it can report "not set up" for a tenant whose credentials are saved but whose 30s config cache is cold. |
| T5 | Branding and addresses are hard-coded per file | The PAT email, the offer letter, the application PDF and the admissions emails all carry literal EdTech names, addresses and a default signatory. There is no per-tenant branding. |
| T6 | Platform-operator management is incomplete | No self-service bootstrap (CLI only), no password reset, and no endpoint to deactivate or delete an operator. |
| T7 | `TenantIntegration.lastTestedAt` / `lastTestOk` / `lastTestNote` are dead columns | Read and displayed on the platform dashboard, written by nothing. There is no "test connection" endpoint or button, so the health indicator is permanently null. |
| T8 | Scripts outside the request path bypass isolation | `server/create-admin.js`, `server/prisma/seed-admissions.js` and `server/tools/*` construct a bare `PrismaClient`. See D1. |
| T9 | Deployment config does not mention the tenancy variables | Neither `render.yaml` nor `DEPLOY.md` lists `CREDENTIALS_KEY` or `DEFAULT_TENANT_SLUG`; `render.yaml` still passes `MOODLE_URL`/`MOODLE_TOKEN` as process-wide env vars. |

---

## 3. What is implemented — feature by feature

Status here means: the code exists, is mounted, is guarded, and has a client surface.
Unless a row says otherwise, it has **not** been re-verified by running it.

### 3.1 Accounts, authentication and access — substantially complete

| Feature | Where | Status |
|---|---|---|
| Landing screen; in-app sign in / sign up | `client/src/Landing.jsx`, `MobileAuth.jsx` | ✅ |
| Self-service sign-up → admin approval → account created | `routes/signup.js` | ✅ |
| TOTP two-step verification (RFC 6238, hand-rolled) | `src/totp.js`, `client/src/TwoFactor.jsx` | ✅ built — but **not mandatory**, see D2 |
| Admin reset of a lost authenticator | `routes/staff.js` | ✅ |
| Forgotten password — hashed, single-use, 30 min, 2FA-gated | `routes/auth.js`, `client/src/ResetPassword.jsx` | ✅ |
| Session revocation via `tokenVersion` | `src/auth.js` | ✅ |
| Invited accounts — unusable until activated | `src/invite.js`, `client/src/AcceptInvite.jsx` | ✅ |
| Self-service account deletion (store requirement) | `routes/auth.js`, `client/src/DeleteAccount.jsx` | ✅ |
| Login rate limiting (8 per IP+email / 15 min) | `routes/auth.js` | ✅ in-process only |
| **Per-page admin access + Super Admin** | `src/auth.js` (`requirePage`), `AdminAccess` tab | ✅ |
| **Student accounts** — own token kind, router allowlist | `src/auth.js`, `routes/student.js` | ✅ |
| **Applicant accounts** — own token kind, router allowlist | `src/auth.js`, `routes/applicant.js` | ✅ |
| **Platform operators** — separate tier entirely | `src/platformAuth.js` | ✅ |
| Push notifications (FCM HTTP v1) | `src/push.js`, `routes/devices.js` | ✅ transport verified Jul 2026; needs a Firebase project to deliver |
| Biometric app lock | `client/src/biometric.js` | ✅ native only; needs a physical device to test |

### 3.2 Staff and HR

| Feature | Mount | Notes |
|---|---|---|
| Check-in / out, daily summaries | `/api/checkins` | ✅ |
| Leave requests, approvals, allowance enforcement | `/api/leave`, `/api/adjustments` | ✅ Allowance is checked server-side at approval, serialised per staff member; sick leave is exempt; a decided request cannot be re-decided (409) |
| Documents, shared and personally assigned | `/api/documents` | ✅ Files live in SharePoint, falling back to a private Supabase bucket with 300s signed URLs |
| **Timesheets** | `/api/timesheets` | ✅ Log dated sessions, submit a month, admin approves or bounces back. Self-approval is blocked. Admins can edit a locked entry with no audit trail |
| **Staff Reviews** (4 form types) | `/api/staff-reviews` | ✅ Reads are page-gated too — the content is candid commentary about a named colleague |
| **My Reviews** (self-service) | `/api/my-reviews` | ✅ Scoped by token identity, no admin page needed. Submitting locks the form (409 on edit) |
| **KPIs / Executive Dashboard** | `/api/assessments/exec-summary` + client | ✅ |

### 3.3 Students and teaching

| Feature | Mount | Notes |
|---|---|---|
| HND attendance registers, semesters | `/api/hnd` | ✅ The largest single module (37 endpoints). P=2, L=1, E=1, A=0; unmarked sessions excluded |
| **Assessments / gradebook** | `/api/assessments` | ✅ Bulk mark entry (max 500 rows), Distinction/Merit/Pass/Fail bands at 70/60/50. Refuses a `maxMarks` cut below an awarded mark. Manual marks are stamped `source:"manual"` so a Moodle sync cannot revert them |
| **Timetable** | `/api/timetable` | ✅ Per course/year/term, autofilled from generated registers, then published. `TermCalendar` is treated as possibly-unmigrated in three places — see D6 |
| **Student Reviews** | `/api/student-reviews` | ✅ Any lecturer may record and list their own; listing everyone's needs the page grant |
| **PAT** (Personal Academic Tutor) | `/api/interactions` | ✅ Nine interaction types, follow-up tracking, CSV export, and a branded email to the student on creation. Note the mount name does not match the feature name |
| **Student portal** | `/api/student` | ✅ Own attendance, grades, timetable, reviews and queries. Every query keyed on `req.user.id`; no id parameter exists |
| **Student queries** | `/api/student-queries` | ✅ Two states (open/answered). No threading, no close/reopen, and **no notification to the student on reply** |
| **Attendance Emails** | `/api/attendance-emails` | ⚠️ Built and complete, but **the automation ships switched off** (`autoEnabled` defaults false) and the default template contact details ship **blank** for an admin to fill. See D7 |
| **Moodle / VLE sync** | `/api/moodle` | ⚠️ Works one-way and non-destructively, with a dry-run preview. Unit matching is heuristic by design. Tenancy leftovers T3 and T4 apply |

### 3.4 Admissions

| Feature | Mount | Notes |
|---|---|---|
| Application record, documents, interviews, offers, enrolment | `/api/admissions` | ✅ With SharePoint filing and branded email at each step. External steps are best-effort and return a `warning` rather than failing |
| Course / intake dropdown lists | `/api/admission-config` | ✅ Deliberately separate from the Moodle-synced `Course` table |
| Application form and offer letter PDFs | `/api/admission-pdf` | ✅ pdfkit |
| Public application form | `/api/admission-apply` | ⚠️ Open by design. A honeypot field is the **only** anti-abuse measure — no rate limit, no CAPTCHA, no email verification on a public write endpoint |
| Token-link document upload | `/api/admission-uploads` | ✅ Hashed 30-day token; everything normalised to PDF. Body limit is 15 MB but the Supabase fallback caps at 10 MB, so a 12 MB file is accepted then rejected downstream |
| Token-link offer acceptance | `/api/admission-offers` | ✅ Idempotent. The generated PDF still tells the applicant to accept **by replying to the email**, contradicting the one-click link |
| **Applicant portal** | `/api/applicant` | ✅ Register, edit a draft, submit, upload, see the interview invite and outcome, accept, download PDFs |
| **ISM** (Intention to Study Meeting) | `/api/ism` | ✅ Mirrors its "Admitted?" answer onto `Admission.ismOutcome` — which the applicant portal shows the applicant |
| **SLC** (Student Loans Company tracker) | `/api/slc` | ✅ Flat tracker. `admissionId` is an unenforced string with no reader |

### 3.5 Business rules that are actually enforced

- Leave allowance is checked **server-side at approval**, inside a per-staff lock, with a
  conditional update on `status:"pending"`. Pending requests do not consume allowance.
- Sick leave is exempt from allowance, on both client and server.
- A decided leave request cannot be re-decided (409) — the audit trail can't be overwritten.
- Balance adjustments must be non-zero whole numbers, range-bound to fit a 32-bit Int.
- A summary saved for a day you didn't attend does not fabricate a check-in time.
- Timesheet self-approval is refused (403).
- An assessment's `maxMarks` cannot be cut below a mark already awarded (409).
- Semester date ranges cannot overlap, so every session belongs to exactly one.
- The last remaining administrator cannot delete their own account.

---

## 4. Security history — the July 2026 sweep

Kept because it is real history and the regression tests still guard it.

A multi-agent sweep on 21 Jul 2026 ran 403 assertions across 4 of 12 planned areas
before a session limit cut it short. It raised **12 defects; all 12 were reproduced and
fixed**, each with a regression test.

| Severity | Defect | Fix |
|---|---|---|
| **critical** | `POST /adjustments` accepted `days` beyond a 32-bit Int. The row was stored, Prisma could then never read the table, and the API process died — permanently, since the row survived restarts. | Range-bound `days`/`allowance`; `wrapAsync` on every router |
| **critical** | `/auth/totp/setup` and `/enable` skipped the `tokenVersion` check, so a revoked session could be traded for a fresh valid one — defeating password-reset revocation. | `resolveEnroller` performs the same staleness check as `requireAuth` |
| **high** | Challenge tokens carried no `tokenVersion`, so a sign-in started with the old password survived the victim's reset. | Challenges carry `ver`; `readChallenge` rejects stale ones |
| **high** | No rate limit on second-factor verification. | Per-account limiter: 10 wrong codes in 15 min → 429 |
| **high** | Leave allowance was a read-then-write race: two concurrent approvals both passed. | Serialised per staff member, re-checked inside the lock |
| **high** | A non-string `note` on a leave decision crashed the process. | Type- and length-checked |
| medium | Enrolling 2FA from a live session needed no password. | Now requires the password |
| medium | A successful password reset left the login lockout in place. | Reset clears the lockout |
| low | Two simultaneous submissions of one single-use reset link both succeeded. | Claimed with an atomic conditional update |

Guarded by `scripts/smoke-security-regressions.mjs` (8 checks) and
`scripts/smoke-int-overflow.mjs` (17 checks), both of which run in `npm test`.

**The sweep never covered** sign-up/approval, check-ins, HND registers,
staff/documents/notifications, input robustness, the browser UI, or a static code
review — and it predates every feature in §2 and most of §3. A fresh sweep across the
current surface is outstanding, and is now a much larger job than it was in July.

---

## 5. Testing and CI — real, and honestly incomplete

`npm test` (`scripts/test.mjs`) applies migrations, seeds fixtures, boots its own API on
port 4010, runs every suite, and exits non-zero if any failed. `.github/workflows/ci.yml`
runs it on every push and PR against a throwaway Postgres container, and also builds the
client. Before this the suites could only be run by hand, one at a time, against a server
someone had already started — which meant in practice they were rarely run.

| Suite | Covers |
|---|---|
| `smoke-tenant-isolation` | **One customer cannot reach another's data.** Two colliding institutions, attacked over real HTTP |
| `smoke-account-deletion` | Password, 2FA, typed confirmation, dependent records |
| `smoke-fixes` | Role scoping on `/staff`, adjustment validation, re-decision guard |
| `smoke-int-overflow` | Oversized numbers can't crash the API |
| `smoke-invite` | Admin-created accounts are unusable until activated |
| `smoke-password-reset` | Hashed single-use links, expiry, revocation, 2FA gating |
| `smoke-push` | Device registration and scoping |
| `smoke-push-transport` | The FCM transport, standing in for Google — no network needed |
| `smoke-security-regressions` | The July 2026 defects stay fixed |
| `smoke-signup-2fa` | **SKIPPED** — see D2 |

**What has no automated coverage at all**: admissions and the applicant portal,
assessments, timesheets, timetable, ISM, SLC, PAT, staff and student reviews, attendance
emails, the Moodle sync, the student portal, and the platform surface. That is most of
§3. There is also still no unit or component test framework and no client-side tests.

`SKIP` deliberately reads differently from `PASS`, so a switched-off feature stays
visible rather than counting as coverage.

---

## 6. Known gaps, defects and open decisions

### Defects found by reading the code (23 Aug 2026)

None of these were runtime-verified. They are reported as findings, not as reproductions.

| # | Severity | Item |
|---|---|---|
| D1 | **high** | **`server/create-admin.js` is expected to be broken by tenancy.** It calls `prisma.staff.upsert({ where: { email } })` on a bare `PrismaClient`, but `Staff.email` is no longer globally unique — it is `@@unique([tenantId, email])` — and the create path supplies no `tenantId`. This is the documented recovery script for a locked-out super admin, so it needs to work. `seed-admissions.js` and `server/tools/*` use a bare client too, and would write unscoped or fail on the NOT NULL constraint. |
| D2 | **high** | **Mandatory 2FA is switched off.** `TOTP_ENFORCED = false` in `routes/auth.js`, the enrolment branches in `/login` are commented out, and sign-up approval sets `mustSetupTotp: false`. Accounts that opted in *are* always challenged, so the feature works — it is simply not compulsory. `smoke-signup-2fa` (~35 assertions) skips as a result. `scripts/README.md` records this as a Critical item in the SaaS readiness plan (§2, MFA for privileged users). |
| D3 | **high** | **`POST /api/platform/login` has no rate limiter and no 2FA**, while the ordinary staff login has both. It is the highest-privilege login in the product. |
| D4 | **high** | The SharePoint Graph token cache is not tenant-keyed — see T2. |
| D5 | medium | `sAdmission` in `routes/admissions.js` strips only the two token hashes. For portal-registered applicants it still returns `passwordHash`, `active` and `tokenVersion`, so bcrypt hashes reach the admin client. |
| D6 | medium | `TermCalendar` is treated as possibly-unmigrated in three places (`GET /` degrades to `null`, `POST /publish` ignores the failure, `PUT /calendar` maps the error to a 503 saying "run the database setup"). Now that migrations are authoritative, that fallback hides a genuine fault. `admissionConfig.js` does the same, returning `[]` for any error. |
| D7 | medium | When email is unconfigured, an attendance-email run counts every student as **`skipped`, not `failed`**, and the response carries no signal distinguishing "email is off" from "these students had no address". A run against a stubbed mailer looks successful. |
| D8 | medium | `notificationsScheduler.js` uses `now.getHours()` — the **host** clock — while `attendanceScheduler.js` correctly uses `clock.localTime()` for Europe/London. Its comment says "local time", so during BST the daily 08:00 notifications actually fire at 09:00 London. |
| D9 | low | `POST /api/applicant/check-email` is unauthenticated and unthrottled, so it confirms whether an address already has an account. |
| D10 | low | `reviewForms.js` never sets `form.pending`, but two routers branch on it — dead code. `denormalise()` and its hand-kept list of date question ids are duplicated between `staffReviews.js` and `myReviews.js` and must be kept in sync by hand. |
| D11 | low | Stale-run sweeping for `MoodleSync` is implemented twice with the same 1-hour constant (`routes/moodle.js` and `scheduler.js`). |

### Setup and configuration

| # | Item |
|---|---|
| S1 | **`npm run setup` does not work out of the box.** It copies `server/.env.example`, which still ships `DATABASE_URL="file:./dev.db"` — a SQLite URL against a `postgresql` datasource — and then runs a seed that refuses to start without `SEED_PASSWORD` (12+ chars). `.env.example` also omits `DEFAULT_TENANT_SLUG`, `CREDENTIALS_KEY`, `TENANT_CACHE_MS`, `APP_TIMEZONE`, `RESEND_API_KEY` and the `SUPABASE_*` variables. `README.md` now documents the working path; the example file itself still needs fixing. |
| S2 | `setup.mjs` still prints `admin@edtech.co.uk / password123` on success. That password no longer exists. |
| S3 | The header comment in `schema.prisma` still says "SQLite for zero-config local dev… change provider to postgresql", directly above `provider = "postgresql"`. |
| S4 | `render.yaml` and `DEPLOY.md` predate tenancy — see T9. |

### Longer-standing gaps

| # | Item | Notes |
|---|---|---|
| 1 | JWT has revocation but no refresh | `tokenVersion` revokes on reset/change. A shorter expiry plus refresh tokens is still the production-grade answer, and there is no "sign out my other devices" button. |
| 2 | Rate limiters and the leave-decision lock are **in-process** | Module-level Maps and promises. Correct for one Node process; a clustered deployment needs Redis and a database-level lock. |
| 3 | Client bundle size | Was 1.22 MB / 313 kB gzipped in July, and `StaffHub.jsx` alone is now 12,151 lines. **Unverified since July** — almost certainly larger. Nothing is code-split except the Capacitor plugins; `React.lazy` on the chart-heavy views remains the highest-leverage fix. |
| 4 | Throughput ceiling | ~110 req/s in July, limited by synchronous bcrypt blocking the event loop. **Unverified since July**, and the move to Postgres changes the picture. See `STRESS-TEST.md`. |
| 5 | "Personal template" documents (`scope:"personal"` with no assignee) are invisible to everyone | Still needs a product decision. |
| 6 | Cross-feature coupling in the client | A `pat`-only admin cannot call `/hnd/students`, so the PAT student picker falls back to `/student-reviews/roster`. `GET /student-reviews/roster` is open to any authenticated staff member with no page gate — a documented widening, and the broadest read surface in that area. |
| 7 | `admissionDocs.js` says its document-type list is duplicated in `client/src/StaffHub.jsx` and must be kept in sync by hand | A drift waiting to happen. |
| ~~8~~ | ~~SQLite, single file~~ | **RESOLVED** — PostgreSQL everywhere, with a migration history. |
| ~~9~~ | ~~Tailwind loads from the Play CDN~~ | **RESOLVED** — compiled at build time via `tailwind.config.js` + PostCSS. |
| ~~10~~ | ~~"Today" is derived in UTC~~ | **Mostly resolved** — `src/clock.js` pins a configurable `APP_TIMEZONE`, defaulting to Europe/London. D8 is the remaining exception. |
| ~~11~~ | ~~Thin automated coverage, no CI~~ | **Partly resolved** — a runner and CI exist (§5), but most feature areas still have no suite. |

---

## 7. Running it on this machine

Node **v24.15.0** / npm **11.12.1** are on PATH in Git Bash. If `npm` is not found in a
fresh PowerShell window, either add `C:\Program Files\nodejs` to PATH permanently or
prefix the session:

```powershell
$env:Path += ";C:\Program Files\nodejs"
```

You also need a **PostgreSQL** database and a `server/.env` pointing at it — there is no
local database file any more, so nothing runs until `DATABASE_URL` is a real Postgres
URL. See *Quick start* in `README.md`.

> The project sits three folders deep — `Downloads\...\edtech-hub\edtech-hub\edtech-hub`.
> That innermost one is the real root (the one with `package.json`). Still worth
> flattening.

Beware: `npm run setup` **re-seeds**, which clears the demo tables it owns. Don't run it
against data you want to keep.

---

## 8. Documentation state

| File | State |
|---|---|
| `README.md` | **Updated 23 Aug 2026** — setup, PostgreSQL, migrations, `npm test`, multi-tenancy, the data model and the full API mount map. |
| `STATUS.md` | This file. Updated 23 Aug 2026. |
| `scripts/README.md` | Accurate. Covers the test runner, the suites and how to add one. |
| `server/prisma/migrations/README.md` | Accurate. Covers why `db push` was abandoned and the rules for changing the schema. |
| `API.md` | **Badly out of date.** It documents auth, password reset, activation, 2FA, sign-up, notifications, devices, staff, check-ins, leave, adjustments, documents and HND — about 11 areas of 33. Nothing on admissions, the applicant portal, SLC, ISM, assessments, timesheets, timetable, reviews, PAT, the student portal, Moodle, integrations or the platform surface. **The single largest remaining documentation gap.** |
| `DEPLOY.md`, `render.yaml` | Correct for what they cover, but predate tenancy — see T9. |
| `BUG-AUDIT.md`, `STRESS-TEST.md` | Historic. Their figures are July 2026 and were not re-measured. |
| `SHAREPOINT_SETUP.md`, `MOBILE.md`, `PRIVACY.md`, `DELETE-ACCOUNT.md` | Not reviewed in this pass. |

---

## 9. Bottom line

The platform is far larger and considerably better engineered than the July 2026
snapshot: PostgreSQL with a reviewed migration history, a test runner behind CI, three
separate identity tiers with allowlists rather than denylists, and tenant isolation
enforced in one place that fails closed rather than in 212 places that might not.

The honest summary of what stands between this and a second paying customer:

1. **Verify T2** — the SharePoint token cache is the one finding that could actually
   leak data between institutions.
2. **Fix D1** — the super-admin recovery script does not survive tenancy.
3. **Decide D2 and fix D3** — mandatory 2FA is off, and the platform login, which can
   read every customer's data, has neither a rate limit nor a second factor.
4. **Make the client tenant-aware (T1)** or commit to subdomain-per-customer.
5. **Extend test coverage** past the account-security suites into the feature areas that
   now make up most of the product.
6. **Bring `API.md` up to date** — the endpoint reference documents about a third of the
   API.

Items 1–3 are security. Nothing in this file should be read as a claim that the system
has been verified end to end; it has not, and *How this was checked* says so on purpose.
