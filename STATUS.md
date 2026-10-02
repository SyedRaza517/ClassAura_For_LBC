# Staff Hub — What's Built & What's Working

*Reviewed 23 Aug 2026 (evening) against `main` at `7856ea0`.*
*§1, §3.9, §5 and §7 updated 28 Aug 2026 (evening) against `nfc-tap-check-in` at
`74774a9`. Every count in §1 was re-counted on that commit, not carried forward.*

*§1, §2, §3.1, §3.4–3.7, §3.9, §5, §6, §8 and §9 updated 30 Aug 2026 for the removal of
multi-tenancy, by reading the working tree. **No count was re-taken and no claim was
promoted**: rows describing machinery that no longer exists were removed or moved into
the past tense, and nothing was upgraded from code-read to demonstrated. The suite has
not been run since the change as this was written.*

*§3.10 added and §5 updated 1 Sep 2026, for referrals to support departments. Unlike the
30 Aug edit this one IS backed by a run: the whole suite passed on the local
`edtech_dev` (27 passed, 0 failed, 1 skipped, plus 1,239 unit tests), which is also the
first run to cover the de-tenanted code. The three assertions that carry §3.10 were each
proved able to fail by reintroducing the bug they guard.*

*12 Sep 2026: a school (AcademicDepartment) filter was added to every admin list that
can reach one — students, attendance, courses, units, sessions, groups, sign-ups, PAT,
queries, reviews, mitigations, prediction, staff, attendance emails, assessments,
admissions, SLC and ISM. Backed by a run: the whole suite passed on the local
`edtech_dev` (35 passed, 0 failed, 1 skipped, plus 1,622 unit tests), and the new
assertions in `smoke-academic-departments.mjs` were proved able to fail by re-gating
the endpoint they guard. The filter is a view, not a boundary — scoping is enforced
server-side. This paragraph said "this file still has no section describing the
academic-departments feature itself"; that was true until 28 Sep 2026 and §3.15 is now
that section.*

*28 Sep 2026: five gaps in the departmental boundary closed — whole-college jobs a
narrowed admin could start, the audit trail and sync issue lists, deleting a school whose
in-use count could not see other departments, filing a course into a department the caller
is not in, and an extension on another department's claim. The Moodle sync now stamps the
units and students it creates with their course's department. See §3.15, which also states
what is still open: admissions/SLC/ISM are not scoped at all, and departments are flat.*

This is the "what actually exists" companion to `README.md` (setup) and `API.md`
(endpoint reference). Read this first if you want to know where the project stands.

## How this was checked — and what that does and does not prove

This revision was produced by **reading the code**: every route mounted in
`server/src/index.js`, the Prisma schema and its migrations, `server/src/db.js`,
`tenant.js`, `integrationConfig.js`, `branding.js`, `docTemplate.js`,
`emailTemplate.js`, `email.js`, `usage.js`, `audit.js`, the schedulers, the test
runner and the header of all 21 suites as they stood then, `scripts/README.md`, `API.md`, `render.yaml`,
`server/.env.example`, and the client's routing, `api.js` and the platform dashboard.
(Several of those files — `tenant.js`, the platform dashboard — were deleted on 30 Aug.
The list is left as a record of what the 23 Aug pass actually read, not as a claim that
all of it still exists.)

**That was true of the 23 Aug pass, and it is no longer true of the whole file.** At the
time, `npm test` was deliberately not run, because `server/.env` points at a **live
staging database** and the suites create, mutate and delete real rows. Since then the
suite has been run three times against a database it is safe to destroy — 25 Aug (24
passed, 1 skipped), 28 Aug (**25 passed, 1 skipped**), and the 29 Aug prediction work —
and §3.8, §3.8.1, §3.8.2 and §3.9 each carry a *Verification status* table separating
what was demonstrated from what was read.

So read every claim by its section. A row in §3 with no verification table behind it is
still a statement about what the code says it does, not a demonstration that it works.
The gap that remains is the client, which has no test framework at all, and the feature
areas the suites do not reach (§5).

**The previous edition of this file was wrong, and wrong in the expensive direction.**
It listed **eighteen** defects as open that had already been fixed — D1, D3, D4, D5,
D6, D7, D8, D9, D10, D11, T1, T2, T3, T4, T7, S1, S2, S3 — and it described none of
the eleven features that landed on 23 Aug between 16:36 and 21:08. People spent time
investigating bugs that did not exist. §6 now records what was checked and what the
check found, per item, so the same thing does not happen twice.

The edition before that said "everything described in README.md is built and working"
and "nothing is half-finished or broken". Neither claim was supportable then, and
neither is made here.

---

## 1. What this is now

It is no longer a staff attendance app. It is a college management platform sold as
**one deployment per institution** — one server, one database, one college — and the
July 2026 description of it (SQLite, 8 route files, ~50 endpoints) understated it by
roughly a factor of five.

It was multi-tenant, with a supplier-facing operator tier above it, from 23 Aug to
30 Aug 2026. §2 records what that was and what remains of it.

| | July 2026 | 23 Aug 2026 | Now (28 Aug) |
|---|---|---|---|
| Database | SQLite file | PostgreSQL | **PostgreSQL** |
| Schema changes | `prisma db push` | `prisma migrate deploy` | **`migrate deploy`, 30 migrations** |
| Route modules | 8 | 38 | **41** |
| Endpoints | ~50 | 242 | **275** |
| Prisma models | ~20 | 44 | **57** |
| Admin dashboard pages | 10 | 28 | **33 tabs, 31 individually grantable** |
| Account kinds | staff | staff, student, applicant, operator | **same four** |
| Institutions | one | many, one database | **many, each with its own identity** |
| Tests | 5 suites, by hand | 21 suites, CI | **26 suites**, CI |

**Two rows of that table stopped being true on 30 Aug 2026 and have not been
re-counted.** *Account kinds* is now **three** — staff, student, applicant; the operator
tier was deleted. *Institutions* is **one per deployment, with its own database**. The
counted figures (route modules, endpoints, models, migrations, suites) all moved in the
same change — two route modules and three suites went, and other work has been landing
alongside — so **treat every number above as stale**. They are left at their 28 Aug
values rather than replaced by a fresh count, because a count taken while several
branches are mid-flight would be no more trustworthy and would look more current than it
is. Re-count before quoting any of them.

Counted on `74774a9`, not quoted: `ls server/src/routes/*.js` → 41;
`router.<method>(` across those files → 275; `^model ` in `schema.prisma` → 57;
`ls -d server/prisma/migrations/*/` → 30; `ls scripts/smoke-*.mjs` → 26. The page
figures come from `ADMIN_PAGES` in `validate.js` (31, identical in list *and order* to
the client's) plus the two tabs that are not grantable — `audit`, which is derived from
the grants somebody already holds, and `access`, which is Super Admin only.

```
edtech-hub/
├── server/   Express + Prisma + PostgreSQL API  (41 route modules, 275 endpoints)
├── client/   React 18 + Vite SPA                (staff app, admin dashboard,
│                                                 student + applicant portals)
└── scripts/  setup, the test runner + suites, load test, screenshots
```

**Architecture in one line:** React (Vite) SPA → REST/JSON over `fetch` → Express with
JWT + RBAC → Prisma → PostgreSQL. One database per institution, so isolation is a
property of the deployment rather than of the query.

---

## 2. Multi-tenancy — built 23 Aug, removed 30 Aug

The product is now sold as one deployment per institution, each with its own database,
so the tenancy machinery has been taken out rather than left switched off. This section
is kept because a prospective customer's IT team will still ask how institutions are
kept apart, and because the answer changed.

**How isolation works now:** by deployment. One database holds one college, so a query
that forgets a filter can only reach rows belonging to the institution whose server it is
running on, because there are no others. There is no runtime enforcement of it and no
test of it, because there is nothing left to enforce or test.

### What was removed

Verified by reading the working tree on 30 Aug 2026 — the files below are absent and
`server/src/db.js` is a plain `PrismaClient`. This has **not** been re-verified by
running the suite.

| Was | Where it lived | Gone |
|---|---|---|
| `tenantId` on 61 models, 18 compound uniques | `schema.prisma` | Dropped by `migrations/20260830T210000_remove_multi_tenancy`. `Tenant` itself **survives** as the single institution settings row |
| Isolation enforced in a Prisma client extension — filter, stamp, and throw `TenantScopeError` on a query with no context | `server/src/db.js` | Deleted, with the reasoning kept in the file header |
| `crossTenant()` / `runInTenant()` escape hatches | `server/src/db.js` | Deleted; schedulers, scripts and tools call directly |
| Per-request resolution `X-Tenant` → subdomain → `DEFAULT_TENANT_SLUG`, unknown → 404, suspended → 403 | `server/src/tenant.js` | File deleted, middleware unmounted |
| Sessions bound to their institution by a `tid` claim | `server/src/auth.js` | Neither issued nor checked. **Ignored rather than rejected**, so live sessions carrying one are not signed out by the deploy |
| The client sending `X-Tenant` | `client/src/api.js` | Removed |
| Platform-admin tier, separate from `Staff.isSuperAdmin` | `src/platformAuth.js`, `routes/platform.js`, `PlatformDashboard.jsx` | All deleted. `PlatformAdmin` carried no `tenantId`, so the migration did not force this — a tier defined as *above every institution* is simply incoherent when there is one, and a second login kind is a security surface with no remaining purpose |
| College registration (public apply → operator approves → code redeemed) | `CollegeRegistration` model, `routes/registrations.js`, `client/src/CollegeRegistration.jsx` | All deleted |
| Schedulers fanning out per tenant | `server/src/eachTenant.js` | Deleted |
| The isolation test suite, the platform suite and the registrations suite | `scripts/smoke-*.mjs` | Deleted, not adapted — see §5 for the coverage that gives up |

### What survives, and why

| Piece | Notes |
|---|---|
| `Tenant`, as one settings row | Not a registry any more. Its only remaining reader is a display-name fallback in `branding.js`. Deleting it was the rejected option: a single row already *is* the singleton settings table the alternative would have had to build |
| Per-institution **Moodle, SharePoint and email** credentials, AES-256-GCM at rest | `TenantIntegration`, `src/secrets.js`, `routes/integrations.js`. Unchanged — the secret is still never returned to any client |
| Configuration in the database rather than in env vars or constants | Branding, letters, email wording, attendance bands, prediction thresholds, tap settings. An administrator changes these from Settings; a value only changeable by a deploy is not a setting |
| A **constant primary key** as the single-row guarantee | `TenantBranding`, `AttendanceBandConfig`, `PredictionModelSettings`, `AttendanceTapConfig` and `TimetableSettings` each held one row per institution under `@@unique([tenantId])`. That is now `id @default("singleton")`, with the save path **upserting on that literal** — find-then-create is not atomic, and two saves arriving together would leave two rows for `findFirst` to choose between |
| The env fallback for integrations, now **unfenced** | It used to be restricted to the one tenant named by `DEFAULT_TENANT_SLUG`, so no college could inherit another's Moodle or SMTP. The host's environment now describes the only institution there is, so inheriting it is correct rather than a leak (`src/integrationConfig.js`) |

### Left over

| # | Item | Detail |
|---|---|---|
| T5b | **Three literals of EdTech's identity survive in the client** | `client/src/StaffHub.jsx` renders "EdTech · 42 The Burroughs, London NW4 4AP · 020 8202 2007" in the staff app's App-info card and the admin console's identity card, and hard-codes the same address in the Admissions help text. The server side is clean — `grep Burroughs server/src` finds only the comment in `branding.js` explaining why it used to be there. **Line numbers not re-checked since 28 Aug.** Lower severity than it was — a customer now sees the supplier's address rather than another customer's — but it is still text no college can edit |
| T8b | ~~One script still bypasses isolation~~ | **Dissolved rather than fixed.** `seed-admissions.js` constructing a bare `PrismaClient` was a defect only because the extended client was the one that stamped `tenantId`; there is no extended client now, and the five tools that failed closed under `runInTenant` have nothing left to fail on. Not re-run, so "they work again" is inference from the removal, not a demonstration |
| ~~T9~~ | ~~Deployment config predates tenancy~~ | Resolved 25 Aug 2026 by declaring `CREDENTIALS_KEY`, `DEFAULT_TENANT_SLUG` and `TENANT_BASE_DOMAIN` in `render.yaml`, with `branch: production` stated explicitly. **The last two of those variables no longer have a reader in `server/src`**; whether `render.yaml` and `server/.env.example` have been cleaned up was not checked in this pass |

**T1, T2, T3, T4, T6 and T7 were resolved before the removal.** §6 keeps the record of
what was checked in each case; several of those items describe machinery that has since
been deleted outright.

---

## 3. What is implemented — feature by feature

Status here means: the code exists, is mounted, is guarded, and has a client surface.
Unless a row says otherwise, it has **not** been re-verified by running it.

### 3.1 Accounts, authentication and access — substantially complete

| Feature | Where | Status |
|---|---|---|
| Landing screen with three tiles — staff, student, applicant | `client/src/Landing.jsx` | ✅ The fourth, **Super Admin**, went with the operator tier on 30 Aug (§2). Code-read, not re-run |
| Self-service sign-up → admin approval → account created | `routes/signup.js` | ✅ |
| TOTP two-step verification (RFC 6238, hand-rolled) | `src/totp.js`, `client/src/TwoFactor.jsx` | ✅ built — but **not mandatory**, see D2 |
| Admin reset of a lost authenticator | `routes/staff.js` | ✅ |
| Forgotten password — hashed, single-use, 30 min, 2FA-gated | `routes/auth.js`, `client/src/ResetPassword.jsx` | ✅ |
| Session revocation via `tokenVersion` | `src/auth.js` | ✅ |
| Invited accounts — unusable until activated | `src/invite.js`, `client/src/AcceptInvite.jsx` | ✅ |
| Self-service account deletion (store requirement) | `routes/auth.js`, `client/src/DeleteAccount.jsx` | ✅ |
| Login rate limiting (8 per IP+email / 15 min) | `routes/auth.js` | ✅ in-process only |
| **Per-page admin access + Super Admin** | `src/auth.js` (`requirePage`), `AdminAccess` tab | ✅ **35** grantable pages (recounted 5 Sep 2026; this said 31). The two copies of `ADMIN_PAGES` are identical by set *and* order, and that is now **asserted by a test** rather than by hand — `src/adminPages-contract.test.js` reads `StaffHub.jsx` as text and fails on drift in either direction, on the labels, and on `EXPLICIT_ONLY`. Every page has a `PAGE_LABELS` entry; the two that did not are fixed (was D16) |
| **Student accounts** — own token kind, router allowlist | `src/auth.js`, `routes/student.js` | ✅ |
| **Applicant accounts** — own token kind, router allowlist | `src/auth.js`, `routes/applicant.js` | ✅ |
| ~~**Platform operators** — separate tier entirely~~ | ~~`src/platformAuth.js`~~ | **Removed 30 Aug 2026** with multi-tenancy (§2). Three identity kinds remain: staff, student, applicant |
| **Audit trail** | `src/audit.js`, `routes/audit.js` | ✅ Secret-redacting, append-only over the API (no write route exists), read behind a page grant. Not a grantable page itself — derived |
| Push notifications (FCM HTTP v1) | `src/push.js`, `routes/devices.js` | ✅ transport verified Jul 2026; needs a Firebase project to deliver. **Students got their own owner column on `DeviceToken`/`Notification` 12 Sep 2026** (§3.13) — until then a student push was structurally impossible, not merely unconfigured: there was no row a student's registration could ever write. The lock-screen title now differs by audience (`notify.js#titleFor`) — the college's own display name where set, else "Staff Hub" for staff and "ClassAura" for students, never the other product's name |
| Biometric app lock | `client/src/biometric.js` | ✅ native only; needs a physical device to test |

### 3.2 Staff and HR

| Feature | Mount | Notes |
|---|---|---|
| Check-in / out, daily summaries | `/api/checkins` | ✅ Now with `POST /tap-check-in`, which clocks a staff member in by touching an NFC sticker and refuses to accept a `site` — see §3.9. Switched off by default |
| Leave requests, approvals, allowance enforcement | `/api/leave`, `/api/adjustments` | ✅ Allowance checked server-side at approval, serialised per staff member; sick leave exempt; a decided request cannot be re-decided (409) |
| Documents, shared and personally assigned | `/api/documents` | ✅ Files live in SharePoint, falling back to a private Supabase bucket with 300s signed URLs |
| **Timesheets** | `/api/timesheets` | ✅ Log dated sessions, submit a month, admin approves or bounces back. Self-approval blocked. Admins can edit a locked entry — now visible in the audit log rather than untraceable |
| **Staff Reviews** (4 form types) | `/api/staff-reviews` | ✅ Reads are page-gated too — the content is candid commentary about a named colleague |
| **My Reviews** (self-service) | `/api/my-reviews` | ✅ Scoped by token identity. Submitting locks the form (409 on edit) |
| **KPIs / Executive Dashboard** | `/api/assessments/exec-summary` + client | ✅ |

### 3.3 Students and teaching

| Feature | Mount | Notes |
|---|---|---|
| HND attendance registers, semesters | `/api/hnd` | ✅ The largest single module (40 endpoints). P=2, L=1, E=1, A=0; unmarked sessions excluded. Three of the 40 are the lecturer's live view, added 28 Aug — see §3.9 |
| **NFC tap check-in** | `/api/tags`, `/api/student/me/tap-*`, `/api/checkins/tap-check-in`, `/api/hnd` live view | ⚠️ Built, tested over HTTP, and **switched off**: `enabled` defaults to `false`, so no college has it. Never once run against real NFC hardware. §3.9 |
| **QR check-in** | `GET /api/hnd/sessions/:id/qr-code`, `POST /api/student/me/qr-check-in`, `POST /api/hnd/sessions/:id/check-in-window`, deep link `/#checkin=`, in-app scanner | ⚠️ Built end to end — rotating code on every session row of the Registers page, in Live Attendance and in the lecturer's own app (a plain staff account that tutors the unit); scanned by a phone camera or the scanner inside the student app; marked automatically; the lecturer can end check-in early or hold it open — and **switched ON since 4 Sep 2026**: `qrEnabled` defaults to `true`, independent of the NFC switch, which stays off. Walked in a real browser 3-5 Sep (49 checks). **Ships ON since 4 Sep** (the sticker switch stays off). **Merged to main and on `production` since 4 Sep; production-hardened 5 Sep** (pooler check, settings-cache resilience, health `version`, department-scoped test pass, the 401 re-stash). §3.9.1 |
| **Assessments / gradebook** | `/api/assessments` | ✅ Bulk mark entry (max 500 rows), D/M/P/F at 70/60/50. Refuses a `maxMarks` cut below an awarded mark. Manual marks stamped `source:"manual"` so a Moodle sync cannot revert them |
| **Timetable** | `/api/timetable` | ✅ Per course/year/term, autofilled from generated registers, then published |
| **Student Reviews** | `/api/student-reviews` | ✅ Any lecturer may record and list their own; listing everyone's needs the page grant |
| **PAT** (Personal Academic Tutor) | `/api/interactions` | ✅ Nine interaction types, follow-up tracking, CSV export, and a **branded** email to the student on creation. The mount name still does not match the feature name |
| **Student portal** | `/api/student` | ✅ Own attendance, grades, timetable, reviews, queries, referrals, mitigating circumstances, notifications, streaks and attendance bands. Every query keyed on `req.user.id`; no id parameter exists. **Substantially extended 12-13 Sep 2026** — see §3.13 |
| **Student queries** | `/api/student-queries` | ✅ Two states (open/answered). No threading, no close/reopen. **The "no notification to the student on reply" gap this row used to record is CLOSED as of 12 Sep 2026** — `PUT /:id/respond` now calls `notifyStudent`; see §3.13 |
| **Attendance Emails** | `/api/attendance-emails` | ⚠️ Built and complete, but the automation still ships switched off (`autoEnabled` defaults false) and the default template contact details ship blank for an admin to fill |
| **Moodle / VLE sync** | `/api/moodle` | ✅ One-way and non-destructive, with a dry-run preview. Unit matching is heuristic by design. Now reads the institution's own URL, token and auto-sync switch |
| **Predictive Analysis** (progression risk) | `/api/prediction` | ✅ Added 25 Aug 2026. Seven weighted components → a 0–100 progression score → R1–R5, with four override rules on top. Per-college weights, bands and thresholds (`PredictionModelSettings`), an append-only history, and an intervention record. Behind the new `prediction` page grant, so it is inert until a college grants it. **Nothing runs on a schedule and no student is ever emailed.** See §3.8, §3.8.1 and §3.8.2. **Extended substantially 28-29 Aug 2026** — mitigating circumstances (which fixed a live harm), register coverage, cohort standing, VLE engagement, workload, student finance and the shape of the absence. About half of it renders null on both databases for want of data; §3.8.2 says exactly which half and why. |

### 3.4 Admissions

| Feature | Mount | Notes |
|---|---|---|
| Application record, documents, interviews, offers, enrolment | `/api/admissions` | ✅ With SharePoint filing and a per-college branded email at each step. External steps are best-effort and return a `warning` rather than failing |
| Course / intake dropdown lists | `/api/admission-config` | ✅ Deliberately separate from the Moodle-synced `Course` table. Both routes now serialise through an allowlist |
| Application form and offer letter PDFs | `/api/admission-pdf` | ✅ pdfkit for the built-in layout; **pdf-lib over the college's own PDF when one is uploaded** (§3.6) |
| Public application form | `/api/admission-apply` | ⚠️ Open by design. A honeypot field is **still the only** anti-abuse measure — no rate limit, no CAPTCHA, no email verification on a public write endpoint. The pattern that was thirty lines away in `routes/registrations.js` is now only in git history, so copying it means fetching it from there |
| Token-link document upload | `/api/admission-uploads` | ⚠️ Hashed 30-day token; everything normalised to PDF. The body cap is `sharepoint.MAX_BYTES` = 15 MB but `storage.MAX_BYTES` (the Supabase fallback) is 10 MB, so on a deployment without SharePoint a 12 MB file is still accepted then rejected downstream |
| Token-link offer acceptance | `/api/admission-offers` | ⚠️ Idempotent. `src/offerLetter.js:224` still tells the applicant to accept **by replying to the email**, contradicting the one-click link — and it is now in a letter a college may have replaced with its own |
| **Applicant portal** | `/api/applicant` | ✅ Register, edit a draft, submit, upload, see the interview invite and outcome, accept, download PDFs |
| **ISM** (Intention to Study Meeting) | `/api/ism` | ✅ Mirrors its "Admitted?" answer onto `Admission.ismOutcome` |
| **SLC** (Student Loans Company tracker) | `/api/slc` | ✅ Flat tracker. `admissionId` is an unenforced string with no reader |
| **Admission Tracker** (funnel analytics) | `/api/admission-stats` | ✅ Added 2 Sep 2026. A seven-stage funnel (enquiry → application → documents → interview → offer sent → offer accepted → enrolled) with conversion rates, period-on-period comparison, a monthly trend, source and geography breakdowns, per-course yield and configurable targets. Behind a **new `admissions-tracker` page grant**, and the endpoint emits **aggregates only** — no applicant id, name, email, address or document number — so a principal or marketing lead can be given the funnel without the `admissions` grant that opens passport and NI numbers. Demonstrated: 90 unit tests and `smoke-admission-tracker.mjs` (20 assertions, run against the local database), including that the aggregates-only rule and the funnel-monotonicity rule both fail when their bug is reintroduced. **Revenue (est.) is a placeholder**: enrolments × a fee an admin types per course, isolated in one function (`estimateRevenue`) to be swapped for real data when SLC is developed. A course with no fee is excluded from the estimate and the coverage is shown beside it, never counted as £0 |

### 3.5 ~~The Super Admin surface~~ — built 23 Aug, deleted 30 Aug 2026

The supplier-facing operator tier is gone. It was a whole surface — its own landing
tile, a monochrome dashboard (Institutions, Registrations, Storage & usage, Operators,
Server configuration, My security), operator accounts with their own token kind, their
own rate limiter and their own 2FA, an apportioned per-college storage estimate, a server
configuration health check, and a "restore access" flow that let an operator reset a
locked-out college administrator's password into that college's own audit log.

It was removed because a tier defined as *above every institution* is incoherent when a
deployment holds one institution, and a second login kind with no remaining purpose is
security surface for nothing. Deleted: `routes/platform.js`, `src/platformAuth.js`, the
`PlatformAdmin` model, `client/src/PlatformDashboard.jsx`, `client/src/platformApi.js`
and the `?platform` entry point. **Recoverable from git history** if a supplier-support
login is ever wanted.

Two consequences worth knowing:

- **`src/usage.js` is gone.** Its only caller was the platform dashboard. It was briefly
  rewritten for one database per college — `pg_database_size()` as the figure rather than
  an apportioned share — and then deleted, because nothing routed to it and dead code that
  looks live is worse than no code. If a storage panel is ever wanted on Settings, the
  tenant-aware original is in git history at the commit before the removal. See D18.
- **A college that locks itself out has no supplier remedy through the API any more.**
  "Restore access" went with the dashboard, so the only route back in is
  `server/create-admin.js` on the server command line — and **as this was written that
  file still imports `runInTenant` and `crossTenant` from `src/db`, which no longer
  exports either**, so it would throw on require. It is D1 all over again in the
  opposite direction (§6) and needs re-checking before anyone relies on it.

### 3.6 What landed on 23 Aug 2026 — each college's own identity

| Piece | Where | What it does |
|---|---|---|
| **Branding** | `TenantBranding`, `src/branding.js`, `routes/branding.js`, `client/src/BrandingSettings.jsx`, `client/src/branding.js` | Names (display, short, two-line wordmark), primary and accent colours, a logo as a data URI (≤256 KB, PNG/JPEG/SVG/WebP/GIF), address lines, contact email and phone, website, legal footer, signatory name and title. The server resolves *saved → env → neutral default* and always returns a complete object, so no caller handles a missing field. The client turns the two colours into CSS custom properties set once on `:root` — `NAVY` is now the string `var(--brand-primary)`, which is why nineteen files needed no change. `GET /api/branding` is public, because the login screen needs it before anyone is authenticated. **The fallbacks belong to nobody** (slate grey): the first version defaulted to EdTech's real identity, which just moved the hardcoding one level down |
| **Document templates** | `TenantDocTemplate`, `src/docTemplate.js`, `routes/doc-templates`, `client/src/TemplateEditor.jsx` | A college uploads its **own** offer letter or application form as a PDF and drags field chips onto it. `pdf-lib` loads that PDF and writes on top of it — **it never redraws the page**, and the file header argues the point: recreating a design cannot be exact (font substitution, kerning, a resampled crest), and *nearly* their letterhead is worse than obviously not it. Positions are stored as a **percentage** of page width and height, so a template re-exported at a different paper size still lands the name in the right place. The field list is defined once in `docTemplate.js` and is also what the editor offers, so the two cannot drift. `/api/doc-templates` gets its own 8 MB body cap; the global one is 1 MB |
| **Email wording** | `TenantEmailTemplate`, `src/emailTemplate.js`, `routes/email-templates`, `client/src/DocumentSettings.jsx` | Editable subject and body per email kind, with `{{placeholders}}`. Substituted, never evaluated — no expressions, no logic — because this is customer-authored text rendered and sent under that customer's name. Bodies are **escaped**, not trusted. Unrecognised placeholders are left alone rather than guessed at. One email (the enrolment congratulations) deliberately has no template and takes only its identity from branding |
| **The institution's email configuration** | `src/email.js`, `integrationConfig.js` (`PROVIDERS.email`), `client/src/IntegrationSettings.jsx` | Email sits alongside Moodle and SharePoint as a third configurable integration: provider, host, port, secure, user, from-name, from-address, with the SMTP password (or Resend key) encrypted at rest. `FROM` is resolved **per send**, not once at require time — it was a module-level constant, which meant whichever college the server was configured for became the sender for every other one. The last-resort address is deliberately undeliverable: a bounce nobody owns is a better failure than a letter signed by the wrong institution |
| ~~**College registration**~~ | ~~`CollegeRegistration` model, `routes/registrations.js`, `client/src/CollegeRegistration.jsx`~~ | **Deleted 30 Aug 2026** (§2). It was a public apply/activate flow requiring two decisions by two different people — an operator approved and issued a hashed access code, the applicant redeemed it — and it existed to manufacture a new institution inside a shared platform. There is nothing for it to manufacture now. Its rate-limiting pattern (5/hour/IP with a size-triggered sweep) is the one D12 still wants, and it is now only in git history |
| **Pinned Prisma generator output** | `schema.prisma:11–28` | `output = "../node_modules/.prisma/client"`. npm workspaces installs `@prisma/client` twice — hoisted at the repo root and under `server/` — so `prisma generate` wrote into one copy while `server/src` loaded the other, throwing "@prisma/client did not initialize yet". It survived locally only because an older `node_modules` happened to be in the right state; CI, which always installs fresh, failed on the seed *after* migrations had applied cleanly, which is what made it confusing. The path is relative to `schema.prisma`, so it always lands where `server/src` resolves from |

### 3.8 Predictive Analysis — progression risk (25 Aug 2026)

A progression score out of 100 per student, banded R1–R5, from seven weighted
components. It is deliberately **not** called a probability of graduating: nothing here
has been validated against real outcomes, so the screen may only ever say "progression
risk". Every component is stored, current and historic, so a model *can* be trained
against real outcomes later without redesigning the tables.

| Piece | Where | What it does |
|---|---|---|
| **The engine** | `server/src/prediction/engine.js` | Pure — no database, no clock, no tenant. Raw measurements in, a scored row out. That seam is why the arithmetic has 40 tests that run in milliseconds with no Postgres: these rules are what a college is asked to defend when a student appeals a decision taken off the back of a risk level |
| **The gather** | `src/prediction/metrics.js` | The only part that touches Prisma. Batched (a fixed number of queries per 200 students, grouped in Node) — the per-student shape would be ~3,000 round trips for a 500-student college |
| **The batch** | `src/prediction/runner.js` | `markStale()` is cheap and safe in a request path; scoring happens later. Taking a register must not wait on a cohort's worth of arithmetic — hence the indexed `stale` column |
| **Per-college policy** | `src/prediction/settings.js`, `PredictionModelSettings` | Weights, bands, thresholds and which band each override caps at. Same shape as `attendanceBandConfig`: defaults in code, one JSON column merged over them, no row until a college edits something |
| **The API** | `routes/prediction.js` | 13 endpoints behind the `prediction` page grant. (This line said 11 from 25 Aug until 26 Aug; there were 10. Counted with `grep -n "^router\.\(get\|post\|put\|delete\|patch\)"`) |
| **The screen** | `client/src/StaffHub.jsx` → `AdminPrediction` | Three views: the register, the interventions caseload, and the model |

**The three decisions worth knowing about.**

*Unmeasurable is not zero.* A student whose register has never been taken has no
attendance percentage. Scoring that as 0 would put every newly-enrolled student at the
top of the Critical Risk list, and staff would go and intervene with students who are
fine. An unmeasurable component is dropped from **both sides** of the weighted mean, so
a score reads "70 of the 95 points that were actually available". A student with
nothing measurable at all is **not scored and gets no row**. The five rate columns are
nullable for the same reason and the screen renders a dash, never a zero. A score
resting on less than half the model carries a `LIMITED_EVIDENCE` flag.

*An override can only ever make things worse.* Each of OVR-001…004 is a floor on
concern, not a verdict, so a student the arithmetic already places in the worst band
stays there. Which band each caps at is named **by key** and validated against the
college's own ladder at save time — "cannot be better than R3" is meaningless at a
college that replaced R3, and a rule pointing at a band that does not exist would sit
on the settings screen looking like protection and never fire for anybody.

*The score and the band never disagree.* An override that moves a student down pulls
the reported score with it, **floored** rather than rounded — R3's ceiling is 69.99, and
rounding that to one decimal gives 70.0, which is R2's opening score, so the student
would be handed back the exact band the override had just taken off them.
`baseProgressionScore` / `baseRiskLevel` keep the untouched arithmetic, so "the maths
said R1 and a rule pulled it to R3" stays visible.

### 3.8.1 Tripwires and outcomes (26 Aug 2026)

A second layer beside the score, and the table that will eventually let anybody check
whether the score was ever right.

**The tripwires.** `server/src/prediction/tripwires.js` — pure, no database, 63 tests.
Eleven `TRIP_*` codes and fourteen stored figures covering things a weighted mean
structurally cannot express: an absence streak, the date last attended, work past its
deadline with no record either way, an attendance slope, a grade trend resting on marks
all entered the same day, marks under the pass mark, missed arranged meetings, a
tutor's own "At Risk", nobody having spoken to the student, one unit abandoned while
the rest are attended, and units with nothing banked.

None of it moves the score. That is the point: an early-warning system that predicted
accurately still changed no outcomes in a randomised trial, because prediction without
a named next step is not an intervention. The codes ride `riskDriverCodes` alongside
the engine's six reds — provably unable to reach OVR-004, because `redIndicatorCount`
is derived from the internal `reds` array and `riskDriverCodes` is a copy of it.

**Three decisions worth knowing about.**

*Dates are stored; day-counts are not.* Nothing here runs on a schedule — `markStale`
fires on data events and a day passing is not an event. A stored "19 days since last
attended" is wrong by the next morning with nothing to correct it, so the column holds
`lastAttendedOn` and the screen derives the age at render time.

*A zero can be a lie.* The lateness rate is `null`, never `0`, when the college does not
record lateness at all — the Moodle importer maps statuses by acronym, so a college
whose plugin has no "L" produces zero late marks for everybody, and a clean 0.0% there
means "not recorded". Decided once per batch, because one student having no late marks
is ordinary. The same guard covers unexplained-absence share (null with no absences),
volatility (null below two marks), per-unit spread (null below two comparable units)
and weekly regularity (null below three weeks).

*A unit nobody has marked is not a unit the student failed.* It comes out of both sides
of the count, or every student on a new unit reads as failing it.

**Outcomes.** `StudentOutcome` plus `GET/POST /prediction/outcomes` and
`GET /prediction/outcomes/calibration`. Nothing anywhere recorded what actually
happened to a student, which meant every weight in the model was reasoning rather than
evidence and any future trained model had no labels. Withdrawal carries a separate
reason because voluntary and academic withdrawal have different predictors; `"unknown"`
is a first-class reason so nobody is forced to guess by a required field; and
`effectiveOn` is the date the outcome took effect, never the date it was typed, because
those differ by weeks and a model trained on the latter learns when administrators do
paperwork. The calibration endpoint buckets outcomes by the band the student carried at
the time — the only screen in the feature that can show the model to be wrong.

**Tranches two to five** added: unexplained-absence share, lateness rate, fail and
near-fail counts, grade volatility, unified engagement recency, per-unit attendance
dispersion, units with nothing banked, weekly regularity, no-shows, the tutor's own
"At Risk", days since pastoral contact, repeat concerns, overdue intervention reviews,
late-submission rate and mean days late, weeks into programme, and work due soon.
Fourteen `TRIP_*` codes and eighteen stored figures in total.

`StudentOutcome` and `GET /prediction/outcomes/calibration` are the other half:
nothing anywhere recorded what happened to a student, so every weight was reasoning
rather than evidence and a future trained model had no labels. Calibration buckets
outcomes by the band the student carried at the time — the only screen here that can
show the model to be wrong.

**Defects found and fixed during this work**, all after the first commit and mostly by
adversarial review rather than by tests:

| Was | Now |
|---|---|
| `POST /outcomes` called `audit.log`, which does not exist. The call sat after the row was written, Express does not catch async rejections there, and Node terminates on one — so the outcome was saved, no 201 returned, no audit entry made, and the API process died. A retry would have created a duplicate | `audit.record`, with a summary carrying no student name |
| `lateRecorded` and `pastoralInUse` claimed institution-wide scope in their own comments and were computed from the 200-student chunk. A single-student rescore stored `latenessRate: null` ("not recorded") where a full rebuild stored `0.0` ("never late"), and the pastoral guard suppressed `TRIP_NO_PASTORAL_CONTACT` for precisely the students it exists to find | Existence probes over the whole institution, hoisted out of the chunk loop |
| `submissionsRecorded` was the fifth guard of the same family and the one missed when the others were hoisted. Harmless only because `AssessmentSubmission` is empty everywhere, so it always failed safe | Hoisted with the rest |
| `unexplainedShare` had no institution guard at all, though a commit message said it did. A college whose register has no "E" acronym made every absent student read as 100% unexplained | Gated on `excusedRecorded` |
| `TRIP_UNMARKED_WORK` is derived from the absence of an `AssessmentSubmission` row, and nothing writes that table. At any college with coursework it would have fired for every student | Institution guard; the signal is withheld when the college records no submissions |
| `TRIP_TREND_UNRELIABLE` tested the whole grade history rather than the last 2N the engine compares, and stripped undated grades before the length check — though an undated grade falls back to a row-creation timestamp, which is the most artefactual case of all. A test asserted the wrong behaviour | Slice of the compared window; a missing date counts as its own value; the test inverted |
| The two windows either side of the attendance slope were 29 and 28 days | Equal |
| `GET /outcomes` had no `studentId` filter behind a 500-row cap while the client filtered in the browser, so past 500 outcomes a student's record read "No outcome recorded" | Filtered server-side; unknown `?outcome=` refused; a future `effectiveOn` rejected |
| `OUTCOMES` collided with the intervention-review vocabulary on server and client; the first fix repointed the review route at the wrong allowlist | Namespaced `STUDENT_OUTCOMES`; the review route validates against its own |

**Verification status.** Demonstrated on 28 Aug 2026:

| | |
|---|---|
| 260 unit tests | pass |
| 86 tripwire tests | pass; **18 mutants** introduced across five rounds, each caught by the test written for it |
| Four migrations | **applied to the live database.** Columns 33→51 and 31→49, `StudentOutcome` created, row counts unchanged |
| Real scoring | **10 students scored, 0 insufficient, 0 score/band disagreements** |
| OVR-004 isolation | verified against live rows: no `TRIP_` code inflates `redIndicatorCount` |
| Chunk-of-one rescore | verified — the case the scope bugs depended on |
| Client | **builds**; there is no client test framework, so that is the whole claim |
| `smoke-prediction.mjs` | **not run.** `assertDisposable.js` refuses a live database, correctly. Needs a scratch database |

**Signals implemented: 42 of the 138 catalogued.** Seven are provably impossible without
upstream data-quality fixes; roughly sixty need capture surfaces or VLE access logs that
do not exist. The two highest-leverage unblocks are small: a `followUpCompletedOn` column
on `Interaction`/`StudentReview`, and a `studentId` FK on `SlcApplication`.


### 3.8.2 Mitigating circumstances, cohort standing, coverage, VLE, workload, finance and absence shape (28–29 Aug 2026)

Six more layers beside the score, one live harm fixed, and a screen that finally shows
any of it. The honest headline is at the bottom: **about half of what is described here
renders as a dash on both databases today, because the tables behind it are empty.**

**The live harm.** `TRIP_CHRONIC_LATE` was firing on real students. `moodle.js` populates
`AssessmentGrade.submittedAt` from `gradedatesubmitted`, `metrics.js` compared it against
the assessment's own `dueDate`, and nothing in the schema recorded that a college had
granted an extension — so a college reported a student as chronically late for using an
accommodation it had granted them itself, with nothing on the screen saying so.
`MitigatingCircumstance` + `AssessmentAdjustment` + `prediction/adjustments.js` fix it.

The governing rule: **a suppressed assessment leaves BOTH sides of every fraction.** Never
counted as submitted, never as on time, never as missing. That is null-is-not-zero pointed
the other way, and getting it backwards is the *mirror* harm — counting an extended piece
as handed in on time inflates the score of a student in real difficulty and quietly
removes them from the register. Proven end to end in an isolated schema: the same student
scored three times, `TRIP_CHRONIC_LATE` present with no claim, gone with approved
extensions, and `lateSubmissionRate` **null rather than 0** under a pending blanket claim.

**Health data never reaches the score.** A claim is Article 9 data — illness, bereavement,
mental health — collected for student support, not for scoring. `status` / the window /
`coversAttendance` / the adjustments say WHAT was decided and are the only fields the
prediction pipeline selects; `category` and `detail` say WHY and are selected by nothing
under `src/prediction/`. Enforced in one place, so `schema-contract.test.js` reads
`metrics.js` as text and fails if either appears. Its own page grant (`mitigations`), and
the audit summary names the student and the decision but never the reason — the audit log
is read on Settings by admins never granted this page.

**The other five layers.**

| Module | Answers | Codes |
|---|---|---|
| `coverage.js` | is the attendance % worth anything — how much of the timetable was registered | 3 |
| `cohort.js` | where the student stands against their own cohort | 2 |
| `workload.js` | where deadlines bunch, crossed with this student's own backlog or absence | 2 |
| `funding.js` | is student finance a reason they may not continue | 3 |
| `sessions.js` | the SHAPE of the absence — worst weekday, whole weeks unseen | 1 |
| `vle/engagementNormalise.js` | did they open the course at all | — |

Two design rules held throughout. **A signal that fires for a whole cohort at once is a
FIGURE, not a code** — `riskDriverCodes` is a per-student caseload array, and a hundred
rows carrying an identical reason is the same as no caseload. `assessmentsDueSoon` set the
precedent; `cohortStruggling` follows it, and every workload code is structurally guarded
by a per-student conjunction so a busy fortnight alone can never fire. And **the sanitised
attendance figure reaches the ENGINE, not just the screen**: a percentage resting on three
marks is a measurement of how often somebody opened the register, so below the floor it is
null and `engine.js` renormalises around it.

**VLE engagement costs no extra Moodle calls.** `core_enrol_get_enrolled_users` was already
issued once per course and `lastcourseaccess` was already in the response, being discarded.
A ROW MEANS "WE LOOKED": observed-but-inactive is `accessed: false`, unobservable is no row.
This is the one place where absence *is* the institution guard, because no count separates
a disengaged cohort from a Moodle with `hiddenuserfields` set from a college that teaches
face to face — all three are zero. The denominator is DAYS, not rows.

**Defects found and fixed in this work**

| | |
|---|---|
| `SlcApplication.statusChangedOn` was **dead schema** — `routes/slc.js` never wrote it, nor `studentId`, `studentLinkSource`, `studentLinkedAt`. `funding.js` measures a stall from it | Written, and only when the status actually moves: stamping it on every save would turn "how long at Awaiting evidence" into "when did somebody last fix a typo" |
| `registerCoverage` received marks with no `sessionId` — they are flattened from `session.date`, and the id comes from the mark itself | Carried through. The module's own guard caught it by returning null rather than reporting a perfect register as untaken |
| `const sessions = require("./sessions")` was silently shadowed by `gather()`'s local `sessions` array. **All 697 unit tests passed** — they import `evaluate` directly | Renamed. First symptom was a live run failing |
| `kindsMeasured` returned 0 where a college records no session kinds. Zero claims a sample that was never taken | Null. It survived a 32-mutant run because the test was **titled** "every kind figure is NULL" while asserting 0 |
| A health-data guard used `new RegExp(\`\\b${name}\\s*:\`)` inside a **template literal**, where `\b` is backspace and `\s` is a bare "s". It searched for a control character and passed everything | Substring tests, mutation-checked three ways |
| Eleven codes reached the client with no label, so a tutor would have read `TRIP_WORKLOAD_PILEUP` where a sentence should be | Labelled; `schema-contract.test.js` now reads `StaffHub.jsx` as text — the `ADMIN_PAGES` problem again |

**Verification status.** Demonstrated on 29 Aug 2026:

| | |
|---|---|
| 699 unit tests | pass |
| Mutation testing | every new guard broken deliberately and caught; survivors reported as equivalent rather than counted as kills |
| Six migrations | **applied to BOTH databases.** `edtech_staging` was 12 behind and is now level. Row counts identical on both |
| Full smoke suite | **25 passed, 0 failed, 1 skipped**, in an isolated schema. `public` row counts identical before and after; schema dropped |
| `smoke-mitigations.mjs` | **new, 13 checks, passed.** Mostly refusals, and two that matter: the audit trail carries no category or detail, and the prediction payload carries neither |
| Real scoring | 10 students on each database, **no score moved**, weekday shape populated for all 20 |
| End-to-end suppression | **proven discriminating** — code fires without cover, gone with it, rate null under a pending claim |
| Client | **builds**; there is no client test framework, so that is the whole claim |

**Signals implemented: about 101 of the 138 catalogued** — but the number flatters the
state of things and should be read with the next paragraph.

**What is inert, and why.** Both databases hold **zero** assessments, grades, submissions,
SLC rows and admissions; `HndSession.kind` is empty on all 32 rows; every student has
`cohortId` null; and no Moodle sync has run since the VLE capture was added. So workload,
funding, cohort standing, submission timing, VLE engagement and the session-kind figures
all render null. That is the modules refusing to invent figures from nothing — the correct
behaviour, and the new screen shows *why* a figure is missing rather than a bare dash — but
nobody should read those columns as working until there is data behind them. The
attendance-derived layers (coverage, weekday shape, weeks unseen) **do** produce real
values today: 10/10 students on both databases carry a measurable weekday pattern.

**The highest-leverage unblock is a Moodle sync**, which lights up assessments, grades and
VLE engagement together. After that: assigning students to cohorts, and the SLC backfill —
still dry-run, and staying that way until the CSV is read per database, because a wrong
match attaches one student's loan status to another.

**Equity monitoring is deliberately not built.** It means processing protected
characteristics, and it needs a DPO rather than a developer's judgement.

**What it deliberately does not do.** No student-facing route (the student app cannot
reach the router). No automatic email — compare Attendance Emails, which *does* write to
students, but with a template a human wrote and a band a human set; this one would be a
machine telling somebody they are likely to fail. No schedule: scores exist only once
somebody presses Recalculate. No delete for a history row or an intervention — both are
records of what the college knew and when, which is what an appeal turns on.

**Defects it found on the way in**, all fixed in the same commit:

| Was | Now |
|---|---|
| `PUT /prediction/settings` with a truncated body silently replaced a college's model with the platform defaults and marked every score in the institution stale, answering 200. `validate(undefined)` legitimately means "the defaults" inside the resolver — over HTTP it must not | 400, and resetting has its own route (`DELETE`) |
| `attendanceMode` was offered in the settings and read by nothing, so a college choosing "binary" was silently scored on the points model | Implemented, with tests that assert the two models genuinely disagree — otherwise the setting should not be offered |
| A test in `settings.test.js` failed on its own premise: it asserted the default weights do **not** sum to exactly 1 (they do), so the floating-point tolerance it existed to guard was never exercised | Carries its own weight set that genuinely misses 1 by one ulp |
| `npm test` only ever discovered `scripts/smoke-*.mjs`, so unit tests beside the code were decoration — 71 assertions no push ever ran | `scripts/test.mjs` runs `node --test` over `server/src` first. (An explicit glob: a bare directory makes the runner walk into `src/index.js`, which binds a port, and the run never terminates) |

**Verification status.** Everything below was demonstrated on 25 Aug 2026, not
inferred:

| | |
|---|---|
| 75 unit tests | pass — pure arithmetic, no database |
| `smoke-prediction.mjs`, 25 checks | **passed**, in an isolated schema (see §5) |
| Whole suite, 24 files | **24 passed, 0 failed, 1 skipped** — nothing else broke |
| Scoring against real data | 10 students scored, 0 errors, **0 score/band disagreements** |
| Invalidation loop | flag → rescore only that student → cleared |
| Migration chain from nothing | all 13 applied cleanly into an empty schema |

The one thing still unproven end-to-end is the **client**, which has no test framework
at all (§5) — the Predictive Analysis tab has been built and deployed but not driven by
anything except a person.

### 3.9 NFC tap check-in (28 Aug 2026)

A student holds their phone against a sticker on the classroom wall and an ordinary P or
L is written into the register with the minute they arrived. A member of staff taps the
same sticker and is clocked in Onsite. A lecturer watches the register fill during the
class and closes it off at the end.

**It ships switched off.** `enabled` is `false` in the platform defaults, exactly as
Attendance Emails does, and for the same reason: a feature that writes to the attendance
record must not switch itself on at every college on the next deploy. **No college has
this today**, and nothing about it is reachable until an administrator turns it on.

| Piece | Where | What it does |
|---|---|---|
| **The tag register** | `AttendanceTag`, `routes/tags.js` (6 endpoints, `attendance-tags` page grant) | Register a sticker, rename it, retire it, read its taps. The code is returned **exactly once**, to the administrator who creates it, because that is the moment somebody writes it onto the tag — there is deliberately no endpoint that reads one back, and `code` is absent from the serialiser, which is an allowlist. Two rollouts are supported on purpose: generate a secret and write it on with a phone app, or tap a **blank** sticker and register its factory UID, which needs no NFC writing tool at all |
| ~~**The one cross-tenant read**~~ | ~~`crossTenantTagExists()` in `routes/tags.js`~~ | **Gone 30 Aug 2026.** `AttendanceTag.code` was unique across every college in one shared database, so registering a sticker another institution already held needed a probe that answered "yes, spoken for" and nothing else — never which college, never what they call it. One database per college deletes the case rather than rephrasing it: a code either is in this table or is not |
| **The window** | `src/attendanceTap.js` — pure, no database, no clock | The lecture's own hours *are* the window; there is nothing for a lecturer to open and nothing to forget to switch off. Taps are accepted from `startTime − earlyGraceMins` to `endTime`, **both ends inclusive**; `P` until `startTime + lateAfterMins`, `L` after. Two classes genuinely running at once return `ambiguous` and the student picks — and the status is then recomputed for the chosen session, because inheriting the first candidate's verdict would mark a punctual student late. The term lock is honoured, matching the 423 on `PUT /sessions/:id/register`, so a tap is not a back door around a closed term |
| **Per-college settings** | `AttendanceTapConfig`, `attendanceTapSettings.js` (pure) + `attendanceTapConfig.js` (resolver) | The `attendanceBandConfig` shape again: defaults in code, one JSON column merged over them, no row until a college edits something, an allowlist on the way out, a 30 s cache invalidated on save. **Fourteen settings now, not seven** — `SETTING_FIELDS` in `attendanceTapSettings.js` is the count to trust, since this row has gone stale on the number before: `enabled`, `qrEnabled` (TRUE since 4 Sep 2026, its own switch — see §3.9.1), `lateAfterMins` (15), `earlyGraceMins` (0), `armSeconds` (60), `qrRotateSeconds` (20, down from 30 on 11 Sep 2026, floor 10 so a phone can scan in time), `declareEnabled` (false, and deliberately never following `qrEnabled`'s default — see the long comment on it in code for why), `staffTapEnabled` (FALSE since 13 Sep 2026, decoupled from `enabled` — see its own comment), and — new with staff presence, §3.14 — `networkCheck`, `allowedNetworks`, `geofenceCheck`, `geofenceRadiusM`, `staffNetworkCheck`, `staffGeofenceCheck`, every one of the last six off or empty by default. The minute fields are capped at 120 and the second fields at 600/300, because a typo of 600 in the grace field is not a setting, it is an outage in the attendance record. `PUT /tags/settings` is a **patch**, so switching the feature on does not silently reset a threshold somebody tuned last term, and the switch itself is audited on its own |
| **The student's tap** | `GET /api/student/me/tap-context`, `POST /api/student/me/tap-check-in` | Inside the student router allowlist and keyed on `req.user.id`; no id parameter exists. Candidates are built from `Enrolment`, so a tap cannot attach a student to a unit they were never on. Rate limited 10 per minute per student — in-process, like the other six limiters (§6). Writing a mark flags the student's progression score stale but deliberately does **not** rescore: a check-in must not wait on arithmetic |
| **The staff tap** | `POST /api/checkins/tap-check-in` | `site` is not accepted and not asked for — a tap always records `Onsite`, because recording anything else would store a claim the tap itself contradicts. What a staff clock-in does and does not prove is §3.14's territory now, not this row's — see "What this can and cannot prove" there rather than trust a summary of it repeated twice; `POST /check-in`, which records a clock-in from anywhere, still exists and still takes a site |
| **The lecturer's live view** | `GET /api/hnd/my-sessions/today`, `GET /api/hnd/sessions/:id/live`, `POST /api/hnd/sessions/:id/mark-remaining-absent` | Who is in, who is late, who has not appeared, and the minute each of them tapped. Today's classes are found through `Unit.tutorStaffId` and never through the free-text `tutor` field — a name typed into a box is not an identity. "Accepting taps" is derived at read time, not stored, because it changes every minute |
| **The tap log** | `TagTap`, `GET /api/tags/:id/log` | Every tap, accepted or refused. The refusals are the valuable half: "I tapped and it didn't work" is answerable here and nowhere else, and so is a pattern — one address checking in six students inside a minute — which is invisible in `AttendanceMark`. Names are resolved for the screen; **no email addresses**, so a tag log cannot become a way to harvest the roster |
| **The apps** | `client/src/nfc.js`, `CheckInCard.jsx`, `AdminNfcTags.jsx`, `AdminLiveAttendance.jsx` | One check-in card serves both apps — the student marks a register, staff clock in, and what differs is one API call and the words on the result. The button is dead until a sticker is read and dead again 60 seconds later, and the code is dropped on failure too: a refused tap is not a credential to retry with |

**Four things it will not do**, each of which would damage a record the college is asked
to evidence at a funding audit, a visa compliance check or a student's appeal.

*A tap never overwrites a mark a lecturer already set.* The human in the room wins — the
same invariant the Moodle importer holds. The suite plants an `A`, taps, and asserts the
`A` survived with `checkedInAt` still null.

*A tap never writes an `A`.* Absence is what an untaken register already means, and
scoring "did not tap" as absent turns a flat battery, a forgotten handset or a phone with
no NFC into a permanent academic record — most often for the students least able to argue
about it. The only path from this feature to an absence is
`POST /sessions/:id/mark-remaining-absent`, with a named human on the end of it, the same
term gate as the register save, and `createMany` rather than `upsert` so the route is
*structurally* incapable of overwriting an existing mark.

*`checkedInAt` is its own column, not `takenAt`.* `takenAt` is reset every time the
register is saved, so a lecturer correcting one row an hour later would silently rewrite
everybody's arrival time. The suite taps, saves a correction over it, and asserts the
arrival time did not move.

*Nothing runs on a schedule.* There is no sweep that closes registers, no job that marks
anybody, and no email to a student at any point.

**Two notes on scope, so nobody reads more into this than is there.** The
`live-attendance` page grant gates the **menu item**, not the data: `my-sessions/today`
is self-scoped by `tutorStaffId`, but `GET /sessions/:id/live` is `requireAuth` only —
which is the convention `hnd.js` already follows for reads (`GET /students` and
`GET /sessions/:id/register` are the same), with writes page-gated. And the settings and
tag routes *are* gated, behind `attendance-tags`.

**Verification status.** Demonstrated on 28 Aug 2026 — this is a run, not a code read:

| | |
|---|---|
| Whole suite, 26 files | **25 passed, 0 failed, 1 skipped**, plus the unit tests (655 at that commit) |
| Where it ran | **A local PostgreSQL 16 on this machine** — `edtech_dev` on `localhost:5432`, created for the purpose. Not the staging database, not an isolated schema inside it. See §5 |
| `smoke-nfc-tap.mjs` | **new, 48 checks, passed.** Mostly refusals: a tap while the feature is off, an unknown code, a retired tag, a tag belonging to another college, a tap before the class and after it, a student reaching the tag admin or the lecturer's live view, a student closing a register, a second tap creating a second mark or moving the arrival time |
| `attendanceTap.test.js` (23 tests), `attendanceTapSettings.test.js` (7) | pass — pure boundary arithmetic and the settings merge, no database |
| Client | **builds**; there is still no client test framework, so that is the whole claim |
| Native config | `cap sync` has been run and committed. Android declares the NFC permission with `android:required="false"` — load-bearing, because declaring the permission makes Google Play *infer* a hardware requirement whose default is REQUIRED, which would hide the app from every phone without an NFC chip. iOS gets `NFCReaderUsageDescription` and an entitlements file requesting NDEF only |
| iOS entitlement, end to end | **not done.** The file exists; the Xcode project references no entitlements file at all, so two manual steps remain on a Mac — adding the Near Field Communication Tag Reading capability and pointing `CODE_SIGN_ENTITLEMENTS` at it. A build that skips them compiles, installs, and then refuses every scan |
| An Android build | **not produced.** No Java and no `ANDROID_HOME` on this machine |
| **A physical tap** | **has never been performed.** Not once, on any handset, against any sticker. Everything above is the HTTP surface and the pure logic; the half that touches a radio — `@capgo/capacitor-nfc`, reader mode, Apple's scan sheet, NDEF decoding, a factory UID — has been read and reasoned about and never executed. Treat the device half as unproven |

**What would close the gap**, in order: buy tags, run the app on one Android handset
(reader mode is silent there, so it needs no Apple capability), register a sticker by
tapping it, and check the log. Only then the two Xcode steps and an iPhone.

### 3.9.1 QR check-in (2–3 Sep 2026)

The second capture method, for a college with no stickers: the lecturer's Live
Attendance screen shows a rotating code — with a full-screen mode sized for the
projector — and a student points their phone camera at it, follows the link, and the
same ordinary P or L is written with the minute they arrived. Present up to
`lateAfterMins` after the start (15 by default, changed on the same settings card as
everything else), Late after that, refused entirely outside the class's own hours.
Every invariant §3.9 lists holds unchanged: a scan never overwrites a lecturer's mark,
never writes an A, `checkedInAt` is written once, and nothing runs on a schedule.

**It ships switched ON** behind `qrEnabled`, changed deliberately on 4 Sep 2026 (owner's
decision; `attendanceTapSettings.js` carries the reasoning and two tests pin it). The
original default was OFF, reasoned from a time when one deployment served every college —
"somebody deployed" then meant every institution at once. One deployment now serves one
institution, so the blast radius is the single college whose server it is, and QR check-in
is the capability that college is buying; shipping it off meant the feature was invisible
until an administrator found a settings screen. What makes the default safe is unchanged:
a scan cannot overwrite a member of staff's mark, cannot record an absence, cannot land
outside the class's timetabled window and cannot reach a closed term. **The STICKER switch
stays OFF**, and separately — it needs hardware somebody has to buy and place, and a
capture method nobody has installed must not appear to be running.

| Piece | Where | What it does |
|---|---|---|
| **The code itself** | `src/attendanceQr.js` (pure, was already in main, previously imported by nothing) + `qrSigningKey()` in `secrets.js` | An HMAC over the session id and the current rotation window, under a key HKDF-derived from the SESSION secret (`JWT_SECRET`) — derived, never stored, so there is nothing to leak and nothing to revoke. It derived from `CREDENTIALS_KEY` first, which was wrong in a way worth recording: that variable is OPTIONAL (it encrypts stored integration credentials) and a deployment with no integrations never sets it — the live service's own start-up log reports email, files and SharePoint all unconfigured — so the one feature that must work in front of a room hung off the one secret nobody had a reason to set, and failed as a 503 at the first scan. `JWT_SECRET` is mandatory: the process refuses to start without it in production, so a deployment that can sign a code is exactly one that can log somebody in, and the feature needs no new configuration to deploy A code is valid for its own window plus one, so a code scanned at the moment it turns over still lands. A photograph of the screen stops working within a minute |
| **Minting** | `GET /api/hnd/sessions/:id/qr-code`, gated like the live view | Answers the code, how long it has left, and whether check-in is open at all — through the same shared window-and-term predicate the scan is judged by, so the screen cannot advertise what the server will refuse. Outside the window no code is minted, and the card says when check-in opens instead; a closed term answers `phase: "closed"` and the register stays shut |
| **The scan** | `POST /api/student/me/qr-check-in`, inside the student router allowlist | Verifies the signature before touching the database, then enrolment, the window, the term (423, matching the register save), and only then writes — the same order of refusals the suite asserts one by one. Shares the NFC path's 10-a-minute budget rather than getting its own. The code string is never stored and never logged |
| **The window, once** | `withinSessionWindow` / `termOpenOn` in `src/attendanceTap.js` | The "is this class open now" test used to exist four times across two route files and had already drifted; it is now one pure, unit-tested predicate used by the mint route, both dashboard reads and the scan itself |
| **The deep link** | `client/src/pendingQr.js`, captured in `App.jsx` | The QR encodes `/#checkin=<sessionId>.<code>` — a **fragment**, so the code never reaches any server's access log and never enters browser history. Captured once at load (and on hashchange, for a scan arriving in an already-open app), stashed in sessionStorage for ten minutes, stripped from the address bar immediately. A signed-out scan lands straight on the sign-in; a non-student session clears the stash |
| **The student's card** | `QrCheckInCard` in `StudentApp.jsx`, above the NFC card and sharing nothing with it | Submits the scan exactly once, then shows what the server decided: marked Present, marked Late (with why), already marked, expired (scan again — signed in now, it takes a second), not recognised, not running, register closed. The check-in screen's copy now knows both switches: a QR-only college's students are told to scan the screen, not that check-in "isn't switched on" |
| **The projector** | `AdminLiveAttendance.jsx` | Full screen, white, the code, one instruction and the live tallies — and deliberately **silent**: no countdown and no new-code moment, because the rotation is not the room's problem. The lecturer's own card keeps its countdown as a staff diagnostic. A failed fetch shows "fetching a fresh code" and retries itself every five seconds; one blip no longer parks an error banner on the wall for the rest of the class |
| **Provenance** | `TagTap.method` (`"nfc"` / `"qr"`, nullable, no backfill — null means "before the column existed") and the roster icon | A disputed register can be answered with *which way* the mark arrived. Every log site stamps it, including the staff route's refusals |
| **Where the code is** (3 Sep, evening) | `HndSessions` / `HndRegister` in `StaffHub.jsx`, `LiveSession` exported from `AdminLiveAttendance.jsx` | Every session row on the Registers page carries a **QR code** action, and the paper register a **Show QR code** button; both open the same live view Live Attendance uses, in place, with a way back to where it was opened from. Offered only when a check-in method is on (`GET /hnd/check-in-settings`; `checkInAction.js`, pure, tested): a button that only ever leads to "switched off" is a dead end. The settings page is now named **Check-in: QR & NFC** (key unchanged), the live view links to it when nothing is on, and the console honours `hashchange` so in-app page links work at runtime |
| **The lecturer's door** | `LECTURER_PATHS` + `lecturerGate` in `routes/hnd.js`; `My Classes` tile in the staff app | An ordinary STAFF account that `Unit.tutorStaffId` names reaches five routes for that unit's classes — today's list, the live register, the code, the close-off, the window — and nothing else on the HND router (directory, matrix, paper register still 403; asserted). The staff app shows **My Classes** only when the server says the account tutors something (`teaches`). Found on the way and fixed: an admin granted only `live-attendance` never passed the router's blanket gate, so that page opened nothing; and the live view now says `canClose`, so a watch-only admin is not offered a close button that 403s |
| **The lecturer's hand on the window** | `HndSession.checkInClosedAt` / `checkInOpenUntil` (migration `20260903T190000`), `POST /hnd/sessions/:id/check-in-window`, the same `withinSessionWindow` | **End check-in now** stops scans and taps for this class the moment it is pressed (the code leaves the projector at once — the card refetches on a phase change rather than a rotation later); **Reopen for 10 minutes** holds a finished or ended class open for late arrivals, the later of the timetabled end and now + minutes, marked Present/Late against the original start. Today's class only, inside an open term, audited both ways. The mint route answers `phase: "ended"` for a lecturer's close, distinct from the clock's `over` |
| **The scanner in the app** | `QrScanner.jsx` + `scanText.js` (pure, tested) + `stashScan()` in `pendingQr.js`; `CAMERA` permission in the Android manifest, `NSCameraUsageDescription` in the iOS plist | **Open the scanner** on the student's check-in screen: the camera, `jsqr` loaded only when pressed (a separate 47 kB gzip chunk), frames scaled to 640 px, and one answer that takes exactly the road a scanned link does. It reads only our own link shape; a `?checkin=` form is refused so the code is never taught to travel where servers log it. This is also what makes the **packaged app** usable before deep links exist: a student stays in the app and scans from there. Native permission strings added, untested on a device |
| **The device trail** | `TagTap.deviceId` (same migration), `X-Device-Id` from `client/src/deviceId.js` | Every self check-in carries a random id the app made up once and keeps. It proves nothing about who holds the phone and never refuses a scan on its own; it is the trail behind "did one handset scan for six accounts in a minute". Sanitised to id characters and 64 chars server-side. No screen reads it yet (see Known gap) |

**Production hardening (5 Sep 2026), after the merge and the academic-department scoping landed on main.** Reconciled against the 3 Sep production-readiness audit: the `CREDENTIALS_KEY` blocker was already closed by the key's move to `JWT_SECRET`, the packaged-app link problem by `canPresentCode`, and the default is ON. What remained, and what changed:

| Concern | What changed |
|---|---|
| A Supabase **transaction** pooler URL (port 6543) pasted into Render hangs `prisma migrate deploy` and breaks Prisma's prepared statements; nothing checked | `npm run migrate:deploy` now runs `prisma/check-database-url.js` first and refuses a 6543 URL with the fix in the message (`src/databaseUrl.js`, 8 unit tests). The ONLY hard refusal is a confirmed transaction pooler: an address the URL parser cannot read (this project has met a Supabase password it rejects) is handed to Prisma with a note, so the gate can never itself stop a working deploy, and host and port are still read from behind an awkward password; the boot banner prints the host, port and mode, never the credentials. Not `directUrl` in the schema: declaring it makes the CLI demand a variable an existing Render service would not have, which would break the next deploy of the live service |
| A settings read that failed (a pooler blip) was treated as "no row", merged the defaults and **cached them for 30 s**, so a hall of students was told scanning is not switched on for what was a connectivity fault | `attendanceTapConfig.get()` serves the last value the database confirmed, throws when there is none, and never caches a failure; only Prisma's "table does not exist" keeps the defaults. A successful `save()` counts as a confirmation, so an administrator's switch-off followed by a blip is served as off (5 unit tests, the first to stub the database client rather than open a connection) |
| `/api/health` said only "up" | It now carries `version` (the commit Render built), which is how to tell which build is answering without signing in. It deliberately does NOT say whether codes are signed with a real secret: the independent security review pointed out that the signing key derives from the SESSION secret, so "dev-secret" on a public endpoint would tell an anonymous caller that every login token on a misconfigured non-production deployment is forgeable. The boot banner says it; a production process refuses to start without a real secret |
| The QR and NFC suites were exempt from the department-**scoped** test pass (`SMOKE_SCOPED_DEPARTMENT=1`), because their fixtures carried no department, so "a narrowed administrator can run a register" was untested | Both suites stamp their fixtures with the signing-in admin's department (`scripts/lib/fixture-department.mjs`) and run in both passes; the QR suite additionally builds two real departments and an account narrowed to one, and asserts it mints its own department's code, gets "not found" for the other's, and that a **student's** scan is never caught by the boundary (student tokens bind a router-confined scope) |
| The mint and the scan were paired only for the closed term; `earlyGraceMins` never left zero in the route-level suite | Three paired assertions with a real ten-minute grace: inside grace (code + Present), before grace (no code, "before", scan refused), and grace removed (both sides say "before") |
| A session expiring **mid-scan** lost the scan: the stash was cleared before the request and the 401 forced sign-in | A 401, and only a 401, re-stashes the scan so it submits itself after sign-in (`keepScanAfter`, tested) |
| `pendingQr.js` had no tests | Eight, pinning the fragment shape, the ten-minute shelf life, peek-not-take, the hashchange pickup and junk tolerance |
| Copy | The Check In tab's glyph follows what is on (a code, not the NFC wave, for a QR-only college); the More screen sends students to the Check In tab rather than "the home screen"; "tapped in" → "checked in" on the day's list; "Not accepting check-ins" → "Check-in closed"; "Session not found" → "That class could not be found." on the lecturer's four routes; the student's switched-off and out-of-term refusals reworded; the settings page's dashes and shorthand gone; the lecturer card only says "Trying again automatically" for a failure its retry can outlive |

Two properties of the department boundary worth knowing, both now asserted or recorded rather than assumed. A member of staff narrowed to one department who is recorded as tutor of a unit in **another** department gets "You can only open the classes you teach" for that unit: the boundary wins over the tutor link, by the scoping design, and is left that way pending the owner's call. And a narrowed administrator's roster reads enrolments through the student, so a **student with no department** (one not yet reached by the cohort denormalisation) is invisible on that roster even though their scan is written; the college-wide view shows them. Both are the guard doing what it should; the second is a data-completeness question for whoever assigns departments.

**Assessed against the owner's technology-agnostic spec (3 Sep):** rotating tokens ✓ (derived, not stored — stronger than a `current_token` column), short validity ✓, only active sessions mint ✓, authenticated scanner ✓ (now in-app as well as via the camera app), rate limits ✓, specific errors ✓, per-session and per-student reporting ✓, late window ✓, lecturer sees the live count ✓, end early / reopen ✓ (new), device trail ✓ (new). Deliberately **not** applied: a "tap to confirm" before submitting (it does not stop a script, which calls the API directly, and it costs every honest student a tap), and GPS / Wi-Fi location checks (a proportionality and Article-9-adjacent question for a UK college, and trivially spoofed on a handset — left as an option, not built).

**Verification status.** Demonstrated 2–3 Sep 2026 — runs, not code reads:

| | |
|---|---|
| Whole suite, 5 Sep 2026 | **College-wide pass 32 passed, 0 failed, 1 skipped; department-scoped pass 30 passed, 0 failed, 1 skipped** (the two suites that build the boundary itself are the only exemptions left). 1,436 server unit tests, 72 client pure-module tests, both passes. `smoke-qr-checkin.mjs` **114 checks** in each pass, `smoke-nfc-tap.mjs` 97 in each. Real browser, isolated instance: the two earlier walks **26 + 12** (the second feeding a rendered code through Chromium's fake camera into the in-app scanner) plus a new **11-check walk as a department-narrowed administrator**: sees and mints only their department's class, gets "That class could not be found." for the other's at the API, the super admin still opens everything, a student's scan is unaffected, the tab bar shows the code glyph, and the narrowed roster shows the scan |
| Whole suite, 3 Sep | **29 passed, 0 failed, 1 skipped** (Node 22, local `edtech_test`), including `smoke-qr-checkin.mjs` — **107 checks** (37 → 50 on the 3 Sep morning fixes → 82 with the lecturer's door, the window controls and the device trail), refusal-weighted, each guard broken once to prove the suite catches it — and the extended `smoke-nfc-tap.mjs` (97). 1,358 server unit tests (`attendanceTap.test.js` 47, incl. the close/hold-open rules), 59 client pure-module tests |
| End to end, real browser (3 Sep evening) | Two scripted Chromium walks, **26 + 12 checks, all passing**, each with a sign-in gate that throws rather than pass vacuously. The first: admin → Registers → Sessions → **QR code** on a row → live view with the code → projector → Escape → paper register → **Show QR code** → back lands on the register; a fragment change switches console pages; a plain STAFF lecturer signs in to the staff app → **My Classes** → their class → code → projector; a member of staff who teaches nothing is not offered the tile; a signed-out scan → sign-in → marked; the scan appears on the lecturer's roster as a scan. The second: the lecturer presses **End check-in now** → the code leaves the screen, the badge turns, a student's scan is refused → **Reopen for 10 minutes** → the code is back; the student opens the **in-app scanner**, Chromium's fake camera plays a rendered video of the live class's current code, the decoder reads it and the student is checked in. Two real faults were found only by these walks: a state hook declared after an early return (crashed the live view), and the card keeping a dead code on the wall for a rotation after End |
| End to end, real browser | A scripted Chromium walk, 15 checks: admin signs in → opens the live view → projector shows the silent code → a **signed-out** phone-sized context opens the deep link → sign-in appears with the fragment already stripped → the student is marked automatically (Late, correctly, past the cut-off) → the mark and its QR icon appear on the lecturer's roster on the next poll → a garbage code is refused with its own next step |
| What those walks do not prove | A physical phone camera on a physical projector: the in-app scanner was fed a synthetic video, and the camera-app route opens the link directly. The **native app** still has no URL-scheme/App Links registration, so a scan with the phone's camera app opens the web SPA in the browser; the in-app scanner is the packaged app's route until deep links are configured (needs the public web domain, the Android signing fingerprint and the Apple team id from the owner, then a rebuild). The native camera permission strings have not been exercised on a device |
| Where the link points | The code encodes the address the **lecturer's screen** is open on: `localhost:5173` on the development machine, the deployed web app's own domain in staging and production, composed client-side so staging can never mint production links. A phone can only open what it can reach, so testing a real handset against the development machine needs the app exposed on the LAN (the owner hub's manual steps say how) |
| Switching it on and off | Asserted as a CYCLE, twice over, because the risk is not the switch but what holds a decision taken a moment earlier: a code minted while on is refused the instant it is off (`qr_off`, and it writes nothing), the mint route answers 409 rather than handing out a dead code, the live view drops to not-accepting, and a student still gets their timetable with every method off. Two full cycles later a fresh code still marks, and still by the clock |
| The lecturer still owns the register | The converse of "a scan cannot overwrite a lecturer's mark", added 4 Sep: a lecturer CAN correct a scanned mark, the correction is attributed to them rather than to the code, the minute the student actually arrived survives it, and the student cannot scan their way back over the decision |
| Known gap | QR tap-log rows carry no `tagId`, and the only tap-log reader (`GET /tags/:id/log`) is per-sticker — so QR refusals and the new device trail are written but not yet readable on any screen. A per-session or per-student log read (and a "same device, many accounts" flag on it) is the next piece of this feature, not a blocker for it |

### 3.10 Referrals to support departments (30 Aug – 1 Sep 2026)

A PAT meeting surfaces something the tutor cannot act on — a wellbeing concern, a
coursework question, a student-support need. Before this there was nowhere to send it.
The only gesture in that direction was `routes/interactions.js` sending the meeting
email *from* the wellbeing mailbox when the free-text `queryType` matched `/wellbeing/`,
which routed an email and created no work anybody could pick up.

**The department list is configuration, not a constant.** Platform defaults are
Wellbeing / ASK / Student Support; the college adds, renames and retires from Settings.
That is not politeness — "ASK" is one institution's word, and the next college runs
Wellbeing and Student Support as one team. `supportDepartments.js` is the
`attendanceBandConfig` shape again: defaults in code, one JSON column merged over them,
no row until the college edits something, an allowlist out, a 30 s cache invalidated on
save, and `id @default("singleton")` as the single-row guarantee.

**The whole feature is one confidentiality rule with four visibilities around it.**

| Who | Sees | Built by |
|---|---|---|
| **The department holding the case** | Everything: the reason, its own case notes, the closing detail, the hand-off trail, its own thread | `sReferralForDepartment` |
| **The tutor who raised it** | Status, the outcome **code**, the dates, why it was handed on — never case notes, never the closing prose | `sReferralForReferrer`, an allowlist naming 14 keys |
| **The student it is about** | Which team, when, where it got to — never the reason written about them | `sReferralForStudent`, 8 keys, and a `studentNotified: true` **WHERE clause** |
| **A department that handed it on** | Its own archived notes and its own thread; nothing the next team has written since | `notesAtTransfer` on `ReferralTransfer`, added back one entry at a time |

Each serialiser is an **allowlist** rather than a payload trimmed afterwards, which is
the `sAdmission` lesson: it stripped a fixed list of secrets, so every column added
after it shipped to the browser by default.

| Piece | Where | What it does |
|---|---|---|
| **The department list** | `SupportDepartmentConfig`, `supportDepartments.js`, `GET`/`PUT /referrals/departments` | Reading needs `referrals` **or** `settings` — the nav cannot be built without it and the settings editor cannot render an editor for a list it may not fetch. Writing needs `settings` alone: retiring the ASK desk is an administrative act, and a wellbeing officer holds this feature to work a queue. Keys are slugs and **immutable once used**; retiring is `active: false`, never a deletion |
| **The referral** | `Referral`, `routes/referrals.js` | `department` is a plain **string, not a foreign key** — a college merging two teams must not cascade a term of case records away, and a referral to a desk that no longer exists still has to render. Same reasoning that keeps `loggedBy` a string on `Interaction` |
| **Who sees which queue** | `Staff.supportDepartments`, a JSON array like `adminPages` | One grantable page, `referrals`, opens the feature; membership decides the queues. A permission per department is **impossible rather than unchosen**: the list is edited at runtime, and a college adding "Careers" at 4pm cannot add a key to four source files. **A Super Admin is not exempted** — holding every admin page is a claim about administrative authority, not about who reads a student's disclosures |
| **Handing it on** | `ReferralTransfer`, `PUT /referrals/:id/transfer` | **The case notes do not travel.** They are archived onto the transfer row under the department that wrote them and cleared from the referral, in one transaction, because the receiving team reads `Referral.notes`. Deleting them was rejected: an officer who mis-clicked would destroy their own record. Status resets to `open` — a case arriving already marked accepted, stamped with another team's name, is a case nobody picks up. A **closed** referral cannot be moved (409): that would erase an outcome the referrer has already been shown |
| **The conversation** | `ReferralMessage`, `GET`/`POST /referrals/:id/messages` | A **third visibility**, and it exists because the first two forced a bad choice: the reason is the tutor talking once, the notes are the department talking to itself, and "which unit is this about?" had nowhere to go — so it went into the case notes where the person who asked could not read the answer, or into email, which is worse. Scoped to the department it was written under, so a hand-off draws the same line through the thread as through the notes. **Reading is wider than writing**: a previous department reads its own thread and cannot reply, because a case answered by two teams at once is how a student gets two different answers |
| **What the student is told** | `GET /api/student/me/referrals` | Filtered on `studentNotified`, **in the query rather than the serialiser**. The tickbox defaults off so a tutor raising a safeguarding concern does not have to remember to suppress anything; a portal listing every referral would surface that concern to the student the same evening. A serialiser could be trusted to omit a field — only a query can be trusted not to load the row |
| **Notification** | `Notification` rows, one per member of the receiving team | In-app, not an email to a shared inbox: a queue nobody is told about is a queue nobody works, but a shared mailbox widens the surface for nothing. **It names no student and carries no reason.** The link is the queue's own fragment (`referrals-<key>`), because there is no page keyed `referrals` and the bare word routed to home |
| **The optional student email** | `mailFrom` categories | Only when the tickbox was ticked. Sent from the department's own mailbox where the college configured one; **an unmapped department sends as the server**, because mapping a Careers desk onto the wellbeing mailbox would land a careers reply with the safeguarding team |
| **The screens** | `StaffHub.jsx` — a Referrals nav parent, one queue per department the signed-in person is on, plus **Sent by me**; `StudentApp.jsx` — a Support screen under More | The nav parent is the only one **not written down in `allNav`**: the children are generated from the config crossed with membership, so a group whose children all filter out must not render — the invariant `navGroups.test.js` pins |

**Audit records who and where, never why.** Six verbs — `raised`, `accepted`, `noted`,
`closed`, `transferred`, `messaged`. The reason, the notes, the closing detail, the
hand-off reason and every message body stay out of it, because the audit log is read on
Settings by administrators who were never granted this page. Same line the mitigating
circumstances summary draws between what the college decided and why.

| Checked | Result |
|---|---|
| `scripts/smoke-referrals.mjs` | **75 checks, 0 failed**, against local `edtech_dev`. Weighted toward refusals: ASK reading the Wellbeing queue (403, not an empty list), the referrer's payload asserted as an **exact key set**, a referral accepted twice, closed with no outcome, raised against a retired desk, attached to another student's meeting; and for this change, a hand-off by a team that does not hold the case, case notes crossing a hand-off, a previous team reading the next team's thread, and a student seeing a referral the tickbox withheld |
| Proved able to fail | Yes. Three bugs were reintroduced — notes travelling with a transfer, the thread scoped to the referral instead of the department, and the `studentNotified` filter dropped — and the suite failed on exactly the four assertions that name them |
| Whole suite after the change | **27 passed, 0 failed, 1 skipped**, plus 1,239 unit tests |
| Client | **builds.** There is still no client test framework, so that is the whole claim |
| In use by a college | **No.** Nothing here has been exercised by a real support desk against real students |

**Two things fixed on 1 Sep 2026, after the queues turned out to be unreachable.**

*The Super Admin could not join a department, so they saw no queue at all.*
`canReadDepartment` deliberately does not exempt them — holding every page is a claim
about administrative authority, being on the wellbeing team is a claim about who reads a
student's disclosures — and `supportDepartments.js` documents the way out as "a Super
Admin who needs the wellbeing queue can put themselves on the team". That escape hatch
did not exist: `PUT /staff/:id/access` refused **every** edit to a Super Admin, and the
Access screen rendered a notice instead of an editor. So the account that sets a college
up held the Referrals page, saw the parent in the sidebar, and found nothing under it but
Sent by me. Membership is now editable on that account and pages still are not; six smoke
checks cover the round trip, and three of them fail if the blanket refusal is restored.

*PAT and the queues now sit under one **Pastoral** parent.* They were adjacent in a long
sidebar and still read as unrelated, because the queues are named after the college's own
departments — nothing in "Wellbeing" or "ASK" says it has anything to do with PAT. The
group is named for the job rather than for one of its screens, and still not "Student
Support", which is a *department* and therefore a child of it.

**Deliberately not built:** threaded replies *between two departments* (the thread is
referrer↔department by design), reopening a closed referral, and any student-facing view
of the conversation. Each widens the confidentiality surface, and none is needed for the
queue to work.

### 3.11 Teams auto-attendance (12 Sep 2026)

Reads each online class's Microsoft Teams attendance report once the class has ended and
writes Present, Late or Absent onto its register from how long a student was actually in
the meeting, on the same never-overwrite, null-means-not-measurable, ships-off invariants
NFC tap check-in already established for a feature that writes to the attendance record.

**It ships switched off, and off means nothing runs at all.** `enabled` is `false` in
`teamsAttendanceSettings.js`'s platform defaults. This section used to say discovery and
matching kept running in the background even while the switch was off, so a class was
already matched by the time an administrator turned marking on — that described a real
earlier design, and a real gap in it: `POST /sync` checked only whether Teams was
*configured*, never whether it was *enabled*, and the setup guide's own Step 11 walks an
administrator through saving credentials and pressing Test connection **before** ever
switching this on — exactly the window in which `isConfigured()` already answers true.
A "Sync now" press in that window ran a real sync against a real Microsoft tenant and
wrote real marks, while the college had, by its own choice, left the feature off. Fixed:
`POST /sync` now refuses with 409 while `enabled` is `false`, so nothing — no calendar
read, no matching, no mark — happens until the switch is on. Matching begins on the
**first sync after switch-on**, not before it. **No college has this today.**

| Piece | Where | What it does |
|---|---|---|
| **Matching a meeting to a class** | `teamsAttendance.js` (`matchMeeting`, pure, tested) | Narrows on date + start time first, and only falls back to a case-insensitive substring test of the meeting's subject against the class's title when more than one class shares a slot (a split group). A failed title tiebreak, or none at all surviving it, is reported **ambiguous** rather than resolved by picking one — the same "no automatic guess on a real student's record" rule tap check-in's own ambiguous-tap branch follows |
| **Clipping and merging attendance intervals** | `teamsAttendance.js` (`attendedMinutes`, pure, tested) | Clips every joined/left interval to the *timetabled* session window before summing, so a lecturer who opens the meeting fifteen minutes early to test their camera does not hand every early arrival free "attendance" minutes; merges overlapping intervals (join, drop, rejoin) so a flaky connection cannot double-count. `firstJoin` is kept unclipped, deliberately, because lateness is judged against the real arrival time, not the clipped one |
| **The threshold** | `teamsAttendance.js` (`decideStatus`, pure, tested) | `minutes >= ceil(sessionMinutes * minAttendancePct / 100)` — below it is always Absent, with a remark (`"Joined N of M min"`) that tells it apart from a student never seen at all, which is Absent with no remark. Lateness is judged independently, on `firstJoin` against the session start plus the tap-settings `lateAfterMins` — arriving late but staying long enough to clear the threshold is Late, not Present, because lateness is about when they turned up |
| **The sync engine** | `teamsSync.js` | Wiring only, by design: discovers meetings on each organizer's calendar for `[today − 7 days, today + 7 days]`, fills a session's `teamsJoinUrl` only when it is currently `null` (an admin's pasted link, or an earlier match, is never overwritten), then for ended sessions with a link and no `teamsCollectedAt`, resolves the meeting id, fetches its attendance report, and writes marks with `createMany({ skipDuplicates: true })` against `AttendanceMark`'s `@@unique([sessionId, studentId])` — the same structural guarantee `moodleAttendance.js` and NFC tap check-in's register write both rely on, so a lecturer's mark (or an earlier sync's) cannot be overwritten by construction, not by a check that could be missed |
| **The retry window** | `teamsSync.js` (`RETRY_DAYS = 7`) | A session with a link and no `teamsCollectedAt` stays eligible for a week, so a weekend Graph outage self-heals on Monday without polling forever. A session outside its term when collection is attempted is marked collected with no marks written and an issue noted — retrying it tomorrow would ask the same unanswerable question every day until the window gave up anyway |
| **Never guessing an absence** | `teamsSync.js` | A calendar or attendance-report fetch that fails leaves the session untouched (still eligible, bounded by the retry window) rather than marking anybody — Absent is only ever written after a **successful** fetch. A participant the report shows but cannot match to any student on the roster (by cached Microsoft user id, then by email) gets **no mark**, counted in `participantsUnmatched` and named in `issues` — reported, never guessed, the spec's own words |
| **The audit trail** | `TagTap`, method `"teams"` | Every mark this feature writes (`outcome: "marked"`) or declines to write over an existing one (`outcome: "already_marked"`) is logged, read back from the database after `createMany` rather than inferred from its return count — `skipDuplicates` reports how many rows were skipped, never which ones, so only a re-read can tell "just written" from "already stood" per student |
| **Settings** | `TeamsAttendanceConfig`, `teamsAttendanceSettings.js` (pure) + `teamsAttendanceConfig.js` (resolver) | The `attendanceBandConfig` shape again: two settings — `enabled` (false) and `minAttendancePct` (50, clamped 1–100 on save, an unusable value on a PATCH ignored rather than reset to the platform default) — a 30 s cache invalidated on save, and a read that fails serves the **last confirmed value** rather than inventing defaults, so a pooler blip mid-sync cannot masquerade as "the college switched this off" |
| **The scheduler** | hourly poll (§3.8's scheduler shape) | Runs `runSync({ mode: "scheduled" })` on the same engine a manual "Sync now" uses, plus `sweepStaleRuns()`, which fails any `TeamsSync` row still `"running"` after 60 minutes so a killed process cannot wedge every future tick behind an in-process `running` flag that a new process can never see set |
| **Settings screen** | `AdminNfcTags.jsx` (`TeamsAttendance`), `client/src/api.js` | A "Teams online classes" section on the same screen as NFC/QR check-in settings: the switch, the threshold, a "Sync now" button that runs a pass immediately and shows its own `summary`/`issues`, and the 20 most recent runs with their own issues lines — "reported, never guessed" needs a screen a human actually reads, both for a run just pressed and for last night's scheduled one nobody was watching |
| **Setup guide** | `TEAMS_SETUP.md` | The app registration, its three Graph application permissions (`Calendars.Read`, `OnlineMeetings.Read.All`, `OnlineMeetingArtifact.Read.All`), and — the part SharePoint's setup does not need — the two Microsoft application access policies (`New-ApplicationAccessPolicy -AccessRight RestrictAccess` in Exchange, `New-CsApplicationAccessPolicy` + `Grant-CsApplicationAccessPolicy` in Teams) that scope those permissions from "every mailbox and meeting in the tenant" down to a named set of organizer accounts. Documents the scheduling rules the matcher depends on: meetings scheduled (never "Meet now"), from an organizer account, at the timetabled time, with the class name in the title as a tiebreak, teachers added as co-organizers rather than as organizer, and attendance reporting left on in the Teams admin center |

**Verification status.** This is the honest split the house style asks for — what a run
proved versus what reading the code establishes:

| | |
|---|---|
| `teamsAttendance.test.js`, `teamsAttendanceSettings.test.js` | **Code-read as present and passing at commit time** — the matcher's date/time/title tiebreaks and ambiguity refusal, the interval-clip-and-merge arithmetic, and the threshold's exact rounding boundary, all pure and all database-free |
| `scripts/smoke-teams-attendance.mjs` | Weighted, per the spec's own emphasis, toward the refusals: a sync while unconfigured (409) — the "already running" 409 is a real branch in the route but the suite does not exercise it, so it is not claimed here — a failed Graph call writing no marks (502, nothing written), a mark that already stands surviving a sync untouched, an unmatched participant appearing in `issues` and `participantsUnmatched` rather than as a guessed Absent, and — the fix-wave assertion that closes the gap this section used to describe wrongly — `POST /sync` answering 409 with `/switched off/i` once Teams is configured but before `enabled` is set true, proving OFF means nothing runs even when Graph credentials are already valid. Confirmed by the full test run this fix wave records (see the verification log) |
| Edge cases, and the proof they discriminate | **78 new unit tests added 1 Oct 2026** across `teamsAttendance.edge.test.js`, `teamsGraph.edge.test.js` and `teamsSettings.edge.test.js`, taking the Teams unit count from 36 to 114 — the cases that only appear against a real tenant on a bad day: a titleless class in a contested slot (which `"".includes("")` would otherwise make match every subject), a join link of the wrong Teams shape, an interval nested inside another, an inverted or zero-length interval, a malformed session window, a threshold of exactly 0, `ceil()` at 50% of 91 minutes, a late-evening UTC instant landing on the college's own calendar day, and the weekday mapping under three host timezones. **Each one was proved able to fail**: 42 mutations were introduced into the source in turn — dropping the empty-title guard, removing the interval merge, flooring the threshold instead of ceiling it, keying participants on email before the Microsoft id, parsing dates in host-local time, merging a settings patch over DEFAULTS instead of the college's own values — and all 42 turned the suite red, which is the standard testing.md sets after two earlier tests were found passing while discriminating nothing |
| The settings contract, end to end | **11 new assertions in `smoke-teams-attendance.mjs`** (35 → 46), also 1 Oct 2026, covering what a unit test on `merge()` cannot reach: a PATCH carrying an unusable threshold answers 200 and leaves the college's own 75% standing **in the database**, not reset to the platform 50; 0% is clamped up to 1 and 250% down to 100 through the real route; an unknown key is dropped by the allowlist; and the switch **closes** as well as opens — a college that turned Teams attendance on and thought better of it gets the same 409 back from a warm process with valid credentials, writing no run row at all. Four route- and config-level mutations were proved to turn these red |
| Client | **Walked in a real browser 1 Oct 2026** — this row used to say only that it *builds*, and that the settings section "has not been clicked in a browser". It has now: a Playwright pass over Attendance → Settings as an admin renders the whole "Teams online classes" card correctly with no console errors — the not-connected banner, the switch reading `Teams auto-attendance is OFF`, the threshold at 50, "Sync now", and the recent-runs list. There is still no client test *framework*, so this is a looked-at-once claim, not a regression guard. It earned its keep immediately: `max-w-xs` sat on the threshold field's whole `<label>` rather than on its input row, wrapping three lines of explanation into a 320px column inside a 1050px card while every sibling description ran full width. Nothing asserts a width, so only looking could have found it; fixed the same day |
| In use by a college | **No.** Nothing here has been exercised against a real Microsoft 365 tenant, a real organizer account, or a real online class — every claim above is a code read or a unit test, never a live Graph call |

**Deliberately not built**, matching the spec: live in-meeting presence (this reads a
report **after** a meeting ends, never during it), Zoom or any platform besides Teams,
and meetings created by the platform itself (a college creates its own meetings the way
it always has — this only ever reads what already exists).

### 3.12 Teams automation — auto-creating meetings, provisioning class Teams (12 Sep 2026)

The direction §3.11 deliberately left out: instead of only reading meetings a college
already created by hand, this creates them. Two independent switches, both shipped
**false** — `autoCreateMeetings` (Phase A, `teamsMeetings.js`) books, updates and cancels
one Teams meeting per timetabled online class; `provisionTeams` (Phase B,
`teamsProvisioning.js`) creates one Microsoft Team per cohort, a channel per unit, and
keeps owners/members current. A college can run either without the other — they are
gated, scheduled and journalled separately, and share only a settings row
(`TeamsAutomationConfig`) and a run log (`TeamsProvisionSync`, discriminated by `job`).

**This section used to describe Phase A as one meeting per timetabled class, full stop,
and that is now only half true.** Since 14 Sep 2026 a class that belongs to a *series*
gets ONE recurring meeting for the whole series instead of one per week, created by a
separate series pass that runs ahead of the per-event pass described below — see
**§3.12.1**. Everything in this section still holds exactly as written for **one-off**
events (`seriesId` null), which are what the per-event pass now handles, and for legacy
series created before that date, which are deliberately never converted.

| Piece | Where | What it does |
|---|---|---|
| **The pasted-link override** | `teamsMeetings.js` (`runMeetingsSync`) | A human's `teamsJoinUrl`, pasted with no `teamsCalendarEventId`, always wins — the reconciler skips that event entirely rather than create a second meeting beside it. `teamsCalendarEventId` is this system's own mark of ownership, and it is the only thing a cancel ever acts on: an event that stops wanting a meeting (unpublished, or the checkbox cleared) is cancelled only when the machine owns the meeting on it, never a pasted one |
| **The reconcile gate** | `teamsMeetings.js` (`meetingFingerprint`, pure, tested) | A meeting is only re-PATCHed when the subject, date, time or attendee list actually differ from what was stored after the last successful write — this REPLACED comparing `TimetableEvent.updatedAt` against a synced-at timestamp, which an engine review found never actually closed (the write that recorded the timestamp itself re-bumped `updatedAt` to a later instant, so the comparison was permanently true and every owned meeting was re-PATCHed, and every attendee re-notified by Microsoft, on every single hourly tick forever) |
| **Cancel clears both copies** | `teamsMeetings.js` | Cancelling nulls the event's own Teams fields **and** `updateMany`s every `HndSession` built from it back to no join details — the registers carry their own copies so attendance can work from the register alone, and leaving those pointed at a meeting Microsoft has deleted would have the attendance sync (§3.11) retry a fetch against it for its whole 7-day retry window, reporting failures for a class the college already knows is cancelled |
| **Provisioning is additive-only, always** | `teamsProvisioning.js` | Creates and adds; never removes a member or a channel, never renames a Team after creation (constraints.md) — undoing any of that is a human's decision in the Teams admin center, not something an unattended nightly sweep should infer from a timetable change. Follows publication the same way the meetings engine does: only cohorts and units named by a **published** event get a Team or a channel |
| **Unmatched people are reported, never guessed** | `teamsProvisioning.js` (`resolveAndCacheMsId`) | A staff member or student whose email does not resolve to a Microsoft account is skipped for that run, counted in `peopleUnmatched`, and named in `issues` — the same "reported, never guessed" rule §3.11's own unmatched-participant handling follows. Two people sharing one Microsoft account (a demo login, a data error) is also reported rather than crashing the run — an engine review found the P2002 collision was being silently swallowed with a comment claiming it was reported, which was never true until this fix |
| **New-creation counters only count what is provably new** | `teamsProvisioning.js` | `teamsCreated`/`channelsCreated`/`ownersAdded`/`membersAdded` count a **brand-new** Team's owners and members as added; re-adding the same roster on every later run (required by additive-only, since the same cohort is provisioned every run) is not counted again, because Graph's own membership-add call cannot tell "just added" from "already was one" on an existing Team |
| **The channel-email invite, and its degrade path** | `teamsProvisioning.js`, `teamsMeetings.js` (`channelEmailsFor`) | Once a unit's channel exists, its own Microsoft email address is fetched once and cached (`""` = never asked, `null` = asked and this tenant has none, a string = the address) and, when present, invited to that unit's meetings alongside staff — the join link lands in the channel automatically. Some tenants disable channel email entirely; when that is the case this is **not** an error, it is counted (`channelEmailMissing`) and named once per channel in the run log, never re-asked once confirmed absent. The meeting is still created regardless — the guaranteed route for a student to find their class link is the student app reading the session's own `teamsJoinUrl`, not the channel invite. **That sentence was aspirational when this row was written, and is now true.** `GET /api/student/me/timetable` built its own event shape from scratch and never read `HndSession.teamsJoinUrl` at all — the "guaranteed route" did not exist yet, which is exactly the gap a claim-vs-code survey of this file would have found. Closed 12 Sep 2026 (commit `bffc9fb`, §3.13): `studentEvents()` now serves the session's own copy (the register's, not the event's paste — the per-class truth once a class has a register), null for a class with none, verified by a round-trip fixture in `smoke-studentportal.mjs` |
| **The creator account** | `teamsGraph.js` (`creatorEmail`, `resolveCreatorId`) | One organizer account, among the ones already configured for attendance, actually creates meetings and owns new Teams — `TEAMS_CREATOR_ACCOUNT` / the Settings screen's Creator account field, defaulting to the first organizer account when blank so an attendance-only deployment needs to change nothing |
| **The scheduler** | `scheduler.js` | Meetings hourly (`maybeRunTeamsMeetings`), same cadence as §3.11's attendance poll, because "events whose publish state or content changed since last look" is naturally incremental. Provisioning nightly at the same 02:00 hour-band Moodle's import uses (`maybeRunTeamsProvisioning`), deliberately **not** hourly — a full sweep touches every cohort, unit and student in the college on each run, and nobody's roster changes fast enough to need that hourly. Each dedupes against `TeamsProvisionSync` on its own `job` value (30-minute window for the hourly job, 12-hour for the nightly one, matching Moodle's own reasoning), and each is its own statement in the scheduler tick so one failing job never stops any other, including each other |
| **Settings and run history** | `routes/teamsAutomation.js`, `AdminNfcTags.jsx` | Two switches and two "Run now" buttons on the same Attendance settings screen as §3.11, sharing one run-history list (`GET /runs`, most recent 20 across **both** jobs, discriminated by `job` on each row) so a college that runs one far more than the other still sees a genuinely recent history of both |
| **Setup guide** | `TEAMS_SETUP.md` Step 13 | The `Calendars.Read` → `Calendars.ReadWrite` upgrade for Phase A (still scoped by the Exchange application access policy already in place for attendance — nothing there needs redoing), and, in bold, the four Phase B permissions (`Team.Create`, `TeamMember.ReadWrite.All`, `Group.ReadWrite.All`, `User.Read.All`) with the honest statement that **no Microsoft mechanism scopes Team creation, tenant-wide group membership or a tenant-wide user lookup** the way an application access policy scopes the calendar/meeting permissions — turning Phase B on is a deliberate tenant-wide trade a college's administrator makes, not a scoped grant this feature quietly narrows for them |

**Verification status.** The same honest split §3.11 uses — what a run has proved versus
what reading the code establishes:

| | |
|---|---|
| `teamsMeetings.test.js` | **Code-read as present and passing at commit time** — `meetingFingerprint`'s exact field set and its sorted-attendee-list normalisation, pure and database-free, the one piece of Phase A's decision logic that was worth extracting rather than leaving as wiring (the same split `teamsAttendance.js`'s pure functions have from `teamsSync.js`'s wiring) |
| `teamsProvisioning.test.js` | **Code-read as present and passing at commit time** — `teamNameFor`'s "course — cohort" naming and both name-length truncations against Graph's own `displayName` limits (120 for a Team, 50 for a channel), pure and database-free |
| `scripts/smoke-teams-automation.mjs` | **Green — 114 assertions, all passing** (re-run 1 Oct 2026; this row said **83** when written, and the 31 added since are §3.12.1's series scenario). Weighted toward refusals the same way §3.11's own suite is: both switches off answering 409 on a manual run (the ship-off proof), a meeting created then left alone on a second run (idempotence), a reschedule producing exactly one update and no duplicate create, a pasted link producing no create at all, an unpublish producing a cancel that clears both the event's and its registers' Teams fields, a provisioning run creating a Team/channels/owners/members with an unmatched student reported rather than silently dropped, a second provisioning run adding no duplicate Team or channel, and (added in the final review fix wave) a channel's own email actually landing in a new meeting's attendee list, not merely resolved and cached. The controller's full sweep of this branch — every unit test plus every smoke suite — ran 35 passed / 0 failed / 1 documented skip |
| Client | **Walked in a real browser 1 Oct 2026**, same pass as §3.11's — this row used to say the settings card "has not been clicked in a browser". The "Teams automation" card renders correctly: its own not-connected banner, both switches reading `Meeting creation is OFF` and `Team provisioning is OFF`, both "Run now" buttons, and the shared run-history list showing a `MEETINGS`-tagged row. No console errors. That pass also found and fixed a real width bug in the sibling card — see §3.11 |
| In use by a college | **No.** Nothing here has been exercised against a real Microsoft 365 tenant — every claim above is a code read or a unit test, never a live Graph call, exactly as §3.11 |

**Deliberately not built**: removing anyone from a Team or a channel, renaming a Team or
channel after creation, and any provisioning of a Team for a cohort that has no
published timetable — all three are the additive-only boundary constraints.md sets, not
gaps this feature intends to close later.

### 3.12.1 Recurring series meetings — one meeting per class, not one per week (14 Sep 2026)

Extends §3.12's Phase A. A weekly class is **one** recurring Teams meeting spanning the
series' real first→last dates, not twelve separate meetings — and the single join link
that follows from it is fanned onto every occurrence's event, its register and the
student app. This is the shape a college actually recognises: students see one recurring
entry in their calendar, the link never changes mid-term, and a teacher promoted to
co-organizer is promoted once rather than weekly.

The hard part is not creating the meeting. It is that **one meeting id now reports twelve
weeks of attendance**, and a collector that flattened those into one list would credit a
student present in week 1 to every week of the term. That is the risk the spec named
highest, and the reason this is its own section rather than a line in §3.12.

| Decision | Where | Why |
| --- | --- | --- |
| **The series owns the meeting, not an occurrence** | `TeamsSeriesMeeting`, keyed `@unique` on `seriesId` | A recurring meeting belongs to the whole series, so pinning it to an arbitrary "first" `TimetableEvent` would lose it the moment that week was unpublished or deleted. One-off events (`seriesId` null) keep the per-event columns on `TimetableEvent` and the per-event pass — `teamsMeetings.js` runs **two passes**, the series pass first, and a one-off is untouched by it |
| **The range is computed from the WHOLE series, never the reconcile window** | `teamsMeetings.js` (`reconcileSeries`), a second query selecting `date` only across every published, wanted event | The reconcile window starts at yesterday, so computing `firstDate`/`weekdays` from the events *in* that window would walk them forward as past weeks age out — the fingerprint would change every week, and Microsoft would re-notify every attendee every week forever. This is the same class of bug the per-event fingerprint already fixed once (§3.12) reappearing by a different route, and it is why the range is queried separately rather than taken from the group already in hand |
| **Per-occurrence attendance, matched on date** | `teamsGraph.js` (`attendanceByOccurrence`), `teamsAttendance.js` (`occurrenceForDate`, pure), `teamsSync.js` | Each occurrence's report keeps **its own date**, and a register reads only the occurrence whose date equals the session's date. A one-off meeting reports a single occurrence whose date equals that session's date, so the same lookup serves both paths without a branch. An occurrence that does not exist yet is a **note and no marks** — it stays eligible inside the 7-day retry window — never an Absent, because "the meeting had not happened yet" and "nobody came" are not the same fact |
| **Reports are fetched once per run, per meeting id** | `teamsSync.js` (`occurrencesFor`, a `Map` keyed by meeting id) | Twelve registers sharing one recurring meeting would otherwise fetch the same report twelve times in a single run. The cache stores the **error** too, so a Graph failure is not retried twelve times either — each register notes it and stays eligible |
| **The one link is fanned to blanks only** | `teamsMeetings.js`, `updateMany` filtered on `teamsJoinUrl: ""` / `null` | The never-overwrite rule §3.11 and §3.12 both follow, applied to the fan-out: an admin's pasted link, or a link already set, stands. The resolved `onlineMeeting` id is fanned the same way, so attendance collection reads it from the session rather than re-resolving it once per week |
| **Co-organizers are written once, and again only on a real change** | `teamsMeetings.js`, gated on `coorganizersSetAt` plus a fingerprint difference | Promoting the teacher is the point of the model — they co-host every week without ever being the organizer whose calendar discovery reads. Rewriting that set on every hourly tick is the same re-notification problem in miniature. A failure to resolve or promote is a **note**, never a thrown run: the meeting and its link already stand, and losing those over a co-organizer write would be the worse outcome |
| **Legacy series are left alone, deliberately** | `teamsMeetings.js`, `legacySeriesIds` computed once across **every** event, not just the window | The spec's rollout choice (a): a series already carrying per-event meetings is never converted, because converting means cancelling twelve meetings and re-notifying everyone on them. The set is computed across all events rather than the reconcile window for a reason worth stating — a legacy series' brand-new occurrence, rolling into the window after this deploy with no `teamsCalendarEventId` of its own yet, would otherwise be skipped by the per-event loop *and* by `reconcileSeries`, owned by neither and stranded with no meeting at all |
| **Cancelling clears both copies, as §3.12** | `teamsMeetings.js` | A series that stops wanting meetings (unpublished across the board, or the checkbox cleared) has **its** recurring meeting cancelled — the clear is matched on the join URL this system wrote, so a pasted link is not cleared by it — and every occurrence's register put back to no join details, for the same reason §3.12 gives: leaving registers pointed at a meeting Microsoft has deleted has the attendance sync retry against it for its whole 7-day window |

**Verification status.**

| | |
|---|---|
| `teamsMeetings.test.js` (series fingerprint) | **Re-run 1 Oct 2026 — part of 114 Teams unit tests, 0 failed** (36 when this row was first written; see §3.11's edge-case row for the 78 added the same day). The series fingerprint's field set and its order-insensitivity: the same inputs in any order give the same fingerprint, while a changed lecturer, a changed end date or an added weekday each change it — the three inputs whose drift would cause the weekly re-notify this design exists to prevent |
| `scripts/smoke-teams-automation.mjs` scenario 10 | **Re-run 1 Oct 2026 — 114 assertions, 0 failed.** One recurring meeting for a three-week series and **zero** per-occurrence `createClassMeeting` calls; all three occurrences carrying the same non-null join URL; co-organizers written exactly once, naming the resolved teacher; a second sync creating and updating nothing (the anti-churn gate); and a lecturer swap producing exactly one `updateRecurringClassMeeting`, no second create, and a rewritten co-organizer list naming the new lecturer |
| `scripts/smoke-teams-attendance.mjs` | **Re-run 1 Oct 2026 — PASS.** The cross-contamination guard this section exists for: two registers a week apart share one recurring meeting id, alice attended week 1 only and bob week 2 only, and each register is marked from **its own** occurrence — alice is not Present in week 2, bob is not Present in week 1 |
| Client | **No new client surface.** The series pass writes through the same `teamsJoinUrl` fields the timetable planner, staff timetable and student app already read (§3.12, §3.13). The settings cards that drive it were walked in a browser 1 Oct 2026 (§3.11, §3.12); the *series* behaviour itself has no screen of its own to look at |
| In use by a college | **No.** As §3.11 and §3.12 — no real Microsoft 365 tenant, no real organizer account, no live Graph call. The whole phase is proved by the `TEAMS_GRAPH_FIXTURES`/`TEAMS_GRAPH_JOURNAL` seam and by unit tests |

**Deliberately not built**, matching the spec's own non-goals: **single-week exceptions** —
moving or cancelling one occurrence of a running series uses Graph recurrence exceptions,
which this does not model, so a single moved occurrence may fall out of the recurring
meeting until they ship, and v1's advice is to edit the whole series; **non-weekly
patterns** — the entry form produces weekly-by-weekday series, and fortnightly or monthly
ones are not modelled; and **private per-class channels**. A **conversion path for legacy
per-event series** is likewise absent by choice, not by omission — see the rollout row
above.

### 3.13 The student app refresh — a notification channel, self-service, one band ladder (12-13 Sep 2026)

The 12 Sep survey (line 19 above) added a school filter to every admin list and, in the
same pass, noted that the student app itself had **no section here at all** despite
having grown a real feature set of its own. This is that section, and it also closes two
gaps this file recorded elsewhere as open: the "still no notification to the student on
reply" line under Student queries (§3.3) and the "guaranteed route… is the student app
reading `teamsJoinUrl`" claim in §3.12's channel-email-invite row, which was true of the
design and not yet of the code — corrected in place there.

**Before this work, a student had no notification channel at all — not a smaller one, an
absent one.** `Notification` and `DeviceToken` carried a `staffId` FK with no student
equivalent, so nothing a student did could ever produce a row: a query answered, a
review filed, a mark released, a class moved, a referral updated — none of it reached a
student anywhere except by opening the right screen and noticing. That is the shape a
"student push is unconfigured" gap and a "student push cannot exist" gap look identical
from the outside, and it is why §3.1's push row above says "structurally impossible", not
"switched off": there was no Firebase project to configure and no code path a project
would have lit up.

| Piece | Where | What it does |
|---|---|---|
| **One table, widened, not duplicated** | `Notification`, `DeviceToken`; migration `20260912T190000_student_notifications` | `staffId` dropped `NOT NULL`, `studentId` added nullable, on both tables — a `StudentNotification`/`StudentDeviceToken` twin was the rejected option, for the same reason `Tenant` survived as a singleton rather than a new table (§2): a second copy of an identical shape is a second place the same bug gets fixed once. Existing staff rows are untouched — `DROP NOT NULL` changes no value. A raw-SQL `CHECK (("staffId" IS NULL) <> ("studentId" IS NULL))` on each table is the actual enforcement (Prisma cannot express a cross-column constraint, the same limitation `HndSession`'s two partial unique indexes hit), so a row owned by nobody or by both is rejected at the database, not merely discouraged by route code. `routes/devices.js` and `routes/student.js` set the owner fields explicitly from `req.user.kind` before the CHECK is ever asked to fire |
| **The channel** | `notify.js` (`notifyStudent`, `pushToStudentDevices`), `routes/devices.js`, `routes/student.js` (`GET/PUT /me/notifications*`) | Mirrors `notifyStaff` exactly — the `Notification` row is written first (so the in-app inbox works even if push fails entirely), delivery attempted after, every failure swallowed. **No email leg**: `Student.email` is for password resets, not a college-issued mailbox, and nothing else in this codebase sends student mail; in-app + push is the whole channel, extendable the same way `notifyStaff`'s email leg was added if that ever changes. Push title resolved by audience (`titleFor`, pure, unit-tested): the college's own display name where branded, else "Staff Hub" for staff (unchanged) and "ClassAura" for students (never the staff product's name) |
| **Device registration** | `routes/devices.js` | One router, two audiences, discriminated by `req.user.kind`. Upsert **on the token**, not on (owner, token): a handset that changes hands — staff to student, student to a different student — moves the row to its new owner rather than leaving it dual-registered or stuck on whoever held it first, mirroring the staff-only behaviour this router already had |
| **Five write-path triggers wired** | `studentQueries.js`, `studentReviews.js`, `assessments.js`, `timetabling.js`, `referrals.js` | One `notifyStudent` call at the point each event actually happens, not a poll: a query answered (`PUT /:id/respond`), a review filed (`POST /` only — editing does not re-fire), a mark released (`PUT /:id/grades`, deduped to one notification per student per save regardless of how many rows or resubmits the bulk save carries — a **correction** fires again, an identical resave or a clear-to-null does not), a timetable change inside 48 hours (`PUT /events/:id`, fanned out over every rostered student across a merged event's registers, deduplicated into one `Set` so a student reachable through two registers of the same class is notified once, not once per register), and a referral's status changing or a department replying (gated on `studentNotified`/`selfReferred` exactly as the student's own read endpoint is, so a notification never points at a message the student is not shown) |
| **Self-service mitigating circumstances** | `GET/POST /api/student/me/mitigations` | The only route onto `MitigatingCircumstance` used to be `requirePage("mitigations")` — a member of staff typing up what a student told them. A student can now raise their own claim, reusing (not re-implementing) the staff route's own window-cap and category validation via a second `require("./mitigations")` — Node's module cache makes it the same function object, so the two routes cannot drift on what counts as a valid window. `status` is always `"open"` and cannot be set by the caller; one open claim per overlapping window is enforced (409, naming the claim already standing); the response allowlist stops at status/window/category — never `detail` (the student's own words, still withheld from their own read), `decisionNote`, `decidedBy`, or the adjustment rows, matching `mitigations.js`'s own "shown to staff" comment on `decisionNote`. Staff holding the `mitigations` page (an `EXPLICIT_ONLY` grant, §access-control — an unconfigured admin does **not** hold it by default) are notified when a student self-raises; the student is notified once when staff decide, naming the outcome and never the note or category |
| **Notifications reaching the app the student actually filed the claim in** | same | The pattern this closes is the one `mitigations.js`'s own file header opens with — `TRIP_CHRONIC_LATE` firing on a student using an extension the college itself granted, because nothing told the scoring pipeline the extension existed. A self-raised claim with no signal to a human is the identical shape one step earlier: a claim nobody told a **person** about, sitting unseen until somebody happens to open the admin screen |
| **Bands, streaks, weighted average** | `GET /me/attendance-bands`, `GET /me/streaks`, `GET /me/assessments` | The app previously hand-rolled its own attendance colour thresholds (85/70, independent of whatever the college had configured in Settings) and averaged assessments as a plain mean regardless of any weight a college had actually set. `GET /me/attendance-bands` now serves the college's own resolved ladder (allowlisted to `{key,label,min,colour}` — never `max` or `emailTrigger`, the latter a staff-only fact about whether a band fires the automated warning letter). `GET /me/streaks` is pure, per-student, computed fresh from `AttendanceMark`/`HndSession` on every read — nothing stored, so there is no cross-student table a wider query could ever misuse, and no leaderboard is possible even by accident (constraints.md). A mixed Present/Excused day counts as attended in full, corrected after review — see `studentStreaks.js`'s own header for why discounting it twice was wrong. `GET /me/assessments`'s average now uses `weightedAveragePct` (pure, `studentAssessmentAverage.js`): a missing or non-positive weight (the ordinary case — `Assessment.weight` defaults to 0 and the Moodle importer never sets it) folds to equal weighting, arithmetically identical to the plain mean that shipped before weighting existed; only a real, college-set positive weight moves the figure, and `averageIsWeighted` tells the screen which case it is looking at |
| **The Teams join link, actually served** | `GET /me/timetable` (`studentEvents()`) | §3.12's own words for the intended design — "the guaranteed route for a student to find their class link is the student app reading the session's own `teamsJoinUrl`" — were not yet true of the code: this endpoint built its event shape from scratch and never read the field. Fixed 12 Sep 2026: the session's own `teamsJoinUrl` (not the event's admin-pasted one — the register's copy is the per-class truth once a class has a register at all) is now carried through, null for a class with no meeting, never a dash or empty string standing in for "nothing here" |
| **The client split** | `client/src/student/**` (Task 3, mechanical), Task 6 (visual kit) | `StudentApp.jsx` (2,411 lines, one file) moved to `client/src/student/` — one file per screen, `ui/` primitives, `tokens.js` — with **no markup change** (verified by diffing moved blocks against the pre-split file: byte-identical apart from `export` keywords). `App.jsx`'s student route is now `React.lazy` + `Suspense`. Before: no student-specific chunk existed at all — everything shipped in the one 1,967 kB main bundle. After: a dedicated `StudentApp-*.js` chunk, **83.69 kB** (gzip 21.84 kB), and the main chunk dropped by almost exactly that (82.91 kB) — the code moved, it did not duplicate, confirmed by grepping the student chunk for staff-only symbols (`AdminDashboard`, `ADMIN_PAGES`, `Super Admin`, …) and finding none. Then, on the same split: `darkMode: "media"` and `dark:*` pairs across every primitive and screen; one attendance-band ladder (`attendanceTone`) replacing four inconsistent scales, fed from the same `/me/attendance-bands` endpoint above; Plus Jakarta Sans actually applied to the student root (it was imported but never set as the root `fontFamily` — every other entry point in `App.jsx` had it, the student one alone did not); a native status bar overlay (`overlaysWebView: true`, unconditionally `Style.Dark` against the header's own always-dark gradient) with safe-area header padding; and a custom pull-to-refresh on `PhoneShell`'s scrollport, gated behind new optional props so `StaffHub` and every other caller is unaffected |

**Verification status.** The same honest split every other section here uses:

| | |
|---|---|
| `smoke-student-notifications.mjs` | **New. 34 assertions, run green at least twice, standalone and via `npm test -- smoke-student-notifications`.** Exactly-one-owner on `DeviceToken` for both audiences, a handset that changes hands moving rather than duplicating, the unread badge counting every unread row (not just the 50-row page), a forged notification id from another student touching nothing, and every one of the five triggers driven through its real endpoint rather than asserted against `notify.js` in isolation — including the timetable fan-out's dedupe, added in a follow-up fix round after review flagged it as the one trigger with zero coverage, and proven able to fail by temporarily de-duplicating with an array instead of a `Set` (a student on two registers of the moved class was paged twice; reverted) |
| `smoke-mitigations-student.mjs` | **New. 29 assertions**, including the one the suite calls its own reason for existing: `decisionNote` is asserted **absent** from a student's own re-read of their claim **after a real decision has written one** — proving the withholding survives contact with an actual decision, not just an empty row. The shared-validator claim is proven by string equality (identical bad body → identical `error` text on both routes), not merely "both refused". The self-raise notification is proven scoped to `hasPage(staff, "mitigations")`, not `notifyAdmins` — a freshly-granted officer gets exactly one, an admin with no pages configured gets zero, because `mitigations` is `EXPLICIT_ONLY` |
| `smoke-studentportal.mjs` | **Extended with 9 new assertions (42 → 51), all green.** The weighted-average fixture was changed from a uniform `weight: 25` (which cannot distinguish "weighted" from "coincidentally equal") to the schema default of 0, then one lopsided real weight added — the average visibly moves and `averageIsWeighted` flips. A drift-guard compares the server's `DEFAULT_BANDS` against the client's mirrored `DEFAULT_ATTENDANCE_BANDS` literal in `tokens.js` field-by-field, closing the "mirrored, not imported, and nothing enforces they stay equal" gap Task 6's own report flagged. A `teamsJoinUrl` round-trip proves the session's link is served and null is served for a class with none |
| `smoke-mitigations.mjs` | **Unmodified, still 16/16** — the pre-existing staff-facing suite, re-run after every run of the new suites above to prove the self-service addition does not interfere with it |
| Server unit tests | **1,666 passed, 0 failed** (`node --test "src/**/*.test.js"` from `server/`), including `studentStreaks.test.js`, `studentAssessmentAverage.test.js` and `notify.test.js#titleFor` |
| Client pure-logic tests | 91/91 as of Task 6's own pass (`checkInAction`, `navGroups`, `pendingQr`, `qrResultView`, `scanLink`, `scanText`, `timetableView`); Task 8's own client work adds `dueNext.test.js`, not yet landed on this branch as this was written (see below) |
| Client screens (Inbox, due-next, streaks, the Teams join button) | **Built on this branch, but a concurrent agent was still finishing this half as this file was written** — `client/src/student/screens/Inbox.jsx` and `dueNext.js`/`dueNext.test.js` exist in the working tree untracked at the time of writing. Described here as shipped-with-this-branch on the strength of the server-side round-trips above (the endpoints they read are proven); the screens' own Playwright/visual pass is that agent's to report, and no client-surface screenshot claim is made in this section that isn't already backed by §3.13's server table or Task 6's own report (`task-6-report.md`) |
| In production | **No.** Nothing in this section has reached staging or production; every claim above is a local `edtech_dev` run or a code read |

**Deliberately not built**, matching constraints.md: predictions, interventions or risk
data reaching any student route (none of the endpoints above touch `src/prediction/`);
a cross-student leaderboard of any kind (streaks are computed per-request from that
student's own rows, nothing is stored); an email leg for student notifications (see the
channel row above); and a markup change anywhere in the Task 3 split (verified by diff,
not by inspection).

**Also deliberately not built: self-service mitigating circumstances (above) carries no
per-unit or per-assessment linkage.** The spec this task worked from listed it — a
student raising a claim could, in principle, name which unit or which assessment the
circumstance covers, the same way a staff-filed claim's `adjustments` rows can name an
`assessmentId`. This v1 dropped it: `POST /api/student/me/mitigations` takes a window
(`coversFrom`/`coversTo`) and a category, nothing narrower, and a student cannot attach
their self-raised claim to a specific unit or assessment the way staff can when writing
adjustments after the fact. Not a bug and not an oversight caught by review — a scope
cut, recorded here rather than silently dropped, because the college may reasonably ask
for it as a follow-up and the honest map this file is meant to be should say what was
asked for and not shipped, not just what was shipped.

### 3.14 Staff presence check-in (21 Sep 2026)

Staff clock-in gained the same question the student side has asked since 10 Sep: is the
phone actually in the building? A member of staff clocking in now picks **On site** or
**Online** from two tabs, with the Check In button dead until one is chosen. Online is one
button and is never checked, under any setting — somebody working from home is by
definition off the college network and away from every campus, so a rule that caught them
would make the honest answer unrecordable. On site can be required to prove itself by up
to three independent switches, **all defaulting off**: `staffTapEnabled` (tap an NFC
sticker — this existed before this work; see §3.9's staff row), and two new ones,
`staffNetworkCheck` (the request must arrive from a college IP range) and
`staffGeofenceCheck` (the phone must report a position near a campus). This closes a gap
the design doc for this work opens by naming directly: the presence engine (`presence.js`,
§3.8.2 and the 10 Sep design it names) and the settings screen for it already existed and
were already applied to students — `checkPresence` was simply never called from a staff
route. It is now, from both `POST /api/checkins/check-in` (when `site === "Onsite"`) and
`POST /api/checkins/tap-check-in` (always, because a tap is an onsite claim by
construction).

| Piece | Where | What it does |
|---|---|---|
| **The two new switches** | `AttendanceTapConfig` (`staffNetworkCheck`, `staffGeofenceCheck`), `attendanceTapSettings.js` | Separate from the student `networkCheck`/`geofenceCheck` pair, deliberately — the settings screen labels those as not affecting staff, so widening them would start refusing staff clock-ins at any college that had ticked one for students, on a deploy nobody connected to the change. They **share** `allowedNetworks` and `geofenceRadiusM` with the student pair: one college, one network, one set of campuses, and two lists that had to be kept in sync would drift silently |
| **The translation layer** | `refusedForStaffPlace()` in `routes/checkins.js` | Translates the staff switches into the shape `presence.js` expects rather than teaching the engine about staff — the engine stays pure, database-free and shared. Every failing reason is logged to `TagTap`, not only the one returned, so a college switching both checks on for the first time sees that its IP list is wrong *and* its coordinates are, in one pass, rather than discovering the second a week after fixing the first |
| **`campusesFor` lifted out of `routes/student.js`** | shared module | Staff pass no session, so they need the "every located campus" branch. Copying it was rejected on this codebase's own evidence (§3.8.2's cohort work): six independently-grown answers to "who is on this register" disagreed and were fixed six separate times |
| **A site is now required on a self clock-in** | `POST /api/checkins/check-in` | `isSite` permits `null` (`v == null || SITES.includes(v)`) because the administrator's `PUT /checkins` legitimately fills in a missed clock-in with no known site — but the self route had reused the same check, so an empty body passed validation, the tap requirement never fired, and a row was written with `site: null`. Answers 400 now. `PUT /checkins` is untouched |
| **Already-clocked-in wins over presence** | both routes | A second tap or press on the way past the door writes nothing, so there is nothing for a presence check to protect — answering "you're off campus" to a no-op would teach staff the feature is flaky on the one screen they use every morning. This deliberately differs from the student path, where every capture method writes |
| **Check-out stays ungated** | `POST /api/checkins/:id/check-out` | Requiring proof of presence to clock *out* would strand anyone who has already left the building, with no recoverable path from the app. Accepted cost: hours-on-site is provable at one end, not both |
| **The Android location permission** | `client/android` manifest | `ACCESS_FINE_LOCATION`, newly added. **Its absence was not a staff-only bug** — `wherePhoneIs()` calls `navigator.geolocation` inside the Capacitor WebView, which Android refuses without the permission, so the **student geofence could never have worked on Android before this**, and nobody had noticed because it ships off and no college had switched it on. Fine, not coarse: coarse alone lets Android 12+ offer an "approximate" toggle accurate to 1–3 km, which `presence.js` correctly refuses as `accuracy_too_poor` — the feature would appear to work, ask for a permission, receive it, and still refuse everybody |
| **The client's own resolver** | `GET /api/checkins/tap-settings`, `staffPositionIfNeeded()` in `client/src/api.js` | The client used to ask the student-only `GET /student/me/tap-context` whether a position was needed; a staff caller got 403, the catch answered `false`, and every onsite clock-in with the geofence on would have been refused `position_missing` — the feature would have appeared completely broken. `tap-settings` (already `requireAuth`-only, already read by the staff screen) answers `needsLocation` instead. Its cache lives under its own `localStorage` key, cleared on sign-out by `forgetNeedsLocation()` — staff and students share handsets, so a cached `"0"` written by a student session must never silently stop a colleague's phone from ever sending a position |
| **The screen** | `StaffHub.jsx`, `TapOnsiteSheet` | Reverses the 14 Sep "ONE TAP, EITHER WAY" collapse back to two tabs, on an explicit later instruction — recorded in the design doc precisely so a future reader does not find the 14 Sep comment, conclude the tabs were an accident, and tidy them away. The location request starts the moment the popup opens, in parallel with arming the NFC reader, because a cold indoor GPS fix can take the full 15-second timeout plus a 2-second backstop, and asking for it only after the sticker is read would leave someone holding a phone against a wall watching a spinner |

**What this can and cannot prove**, unchanged from the 10 Sep design and worth restating
because a college will be asked this at a funding audit: the network check proves the
request reached the server from an address the college says is theirs — it does not prove
which room, and a VPN defeats it. The geofence proves the device reported a position
within a radius of a campus; indoor GPS is 10–50 metres and worse through concrete, so it
can never prove which room. The sticker proves somebody was at that wall once, with this
account signed in — the code is static, so a member of staff who notes it down can tap
from home. **None of the three is proof.** Together they are a good deal more than a
login on a phone, which is all that stood behind a staff clock-in before this work.

**What is still unproven, in full, so nobody reads more into the run below than is
there:**

- **No physical NFC tap has ever been performed**, on any handset, against any sticker.
  §3.9 said this about the student/staff tap route when it was built on 28 Aug and it is
  still true: this work changed who the checks apply to, not whether the radio half has
  ever been exercised.
- **No real GPS fix has ever been taken.** Every geofence assertion in the suite supplies
  a position directly in the request body. A cold indoor fix, a permission prompt, a
  refused permission — none of it has executed once.
- **No real college network.** Every network assertion spoofs `X-Forwarded-For`, which
  only works in the suite because there is no proxy in front of it. In production,
  Render's proxy is the trusted hop (`trust proxy: 1`), and the header a phone sends is
  overwritten by what Render observed — see the long comment above
  `refusedForStaffPlace` in `routes/checkins.js`.
- **The Android location permission is declared and has never run on a device.**
  `cap sync` copies web assets and config into the native project; it does not invoke
  Gradle, so the merged `AndroidManifest.xml` — the file Android actually reads the
  permission from — only regenerates on a real build, and no build has been produced on
  this machine (no Java, no `ANDROID_HOME`, matching §3.9's existing note).
- **The browser walkthrough cannot ever exercise the NFC popup's listening state.**
  `client/src/nfc.js` returns `{ ok: false, reason: "web" }` whenever
  `Capacitor.isNativePlatform()` is false — which is every case a browser can reach — so
  On site with a sticker required renders "Use the app to tap in" in Edge/Chrome/Playwright
  and never the live "Please tap the NFC sticker" popup. `_walk-staff-checkin.mjs`
  (`docs/testing/2026-09-21-staff-check-in-e2e-test-plan.md` §3.2, step D) proves the
  desktop fallback wording; the tap popup itself is provable only in the packaged app on a
  real handset.

**Verification status.** Re-measured 24 Sep 2026, one suite at a time, against a local
PostgreSQL 16 (`edtech_dev` on `localhost:5432`) — this is a run, not a code read:

| | |
|---|---|
| Whole platform suite (`npm test`) | **41 passed, 0 failed, 1 skipped** (the skip is `smoke-signup-2fa`, D2 — a switched-off feature, not a failure) |
| `smoke-nfc-tap.mjs` | **228 checks, all passed** — up from 97 at the 3 Sep measurement (§5); the growth is this work's own staff-presence refusal assertions (off-network, off-campus, no-position, poor-accuracy, misconfiguration, the Online exemption under every combination of the two new switches) |
| `smoke-qr-checkin.mjs` | **168 checks, all passed** — re-run alongside `smoke-nfc-tap.mjs` specifically to prove the geofence fixture the new suite exercises did not leak into the sibling suite |
| Server unit tests | **1,750 passed, 0 failed** (`node --test "src/**/*.test.js"` from `server/`) |
| Client pure-module tests | **125 passed, 0 failed** (`node --test "src/**/*.test.js"` from `client/`) |
| Client build | `npm run --workspace client build` — succeeds |
| Native config | `npm run --workspace client build` then `npx cap sync android`, re-run for this work because the Task 5 sync predates every client change on this branch — the two-tab screen, the checkboxes and the `api.js` resolver did not exist in the web assets `client/android` was carrying until this pass |

Read `docs/testing/2026-09-21-staff-check-in-e2e-test-plan.md` for the full journey,
including the eight-combination configuration matrix, every refusal's exact wording, the
ordering rules, and the stress/concurrency script — its own baseline table is kept in step
with the figures above.

### 3.15 Academic departments — the boundary's remaining gaps closed (28 Sep 2026)

**This is the first section in this file about the academic-departments feature itself.**
The 12 Sep note at the top of this file flagged its own absence and is now answered here.
What that note said about the *filter* remains exactly true — the school dropdown on ~20
admin lists is a view, not a boundary — and what follows is about the boundary, which is
older than the filter and enforced server-side by a Prisma client extension
(`academicScopeGuard.js`), not by per-route checks.

**Nothing is narrowed for any college by default.** `Staff.collegeWide` defaults to
`true`, and sign-up approval deliberately leaves it alone, so the filtered branch of the
guard runs only for an account a Super Admin has explicitly narrowed. That matters for
reading everything below: these were holes in a door most colleges have not yet closed.

Five gaps, each demonstrated and each proved able to fail by reintroducing it:

| Gap | What a departmental admin could do | Now |
| --- | --- | --- |
| Whole-college jobs | Start the monthly attendance-letter run, a Moodle sync or preview, a Canvas preview, either Teams run — each declares itself institution-wide with `withoutAcademicScope`, so the guard was never asked. **The Teams half of that sentence was not true when it was written, and a live deployment proved it on 2 Oct 2026**: none of `runSync`, `runMeetingsSync` or `runProvisioning` declared anything. An HTTP request binds a scope in `requireAuth`, so "Sync now" worked every time, while every *scheduled* pass died with `HndSession.findMany was issued with no academic scope bound`, wrote no marks and logged a FAILED run — manual success and unattended failure from the same engine, which is why no suite caught it (they all drive it over HTTP). Fixed by wrapping all three at the engine entry, the same placement `moodle.js` and `prediction/runner.js` use, with `teamsScope.test.js` as the regression guard — a deliberately weak source-reading proxy, proved able to fail. The letter run wrote to every student in the college. | `requireCollegeWide` (in `auth.js`) refuses them, with `code: "COLLEGE_WIDE_REQUIRED"` so the client can tell this apart from a missing page grant |
| Free text naming students | Read the whole college's audit trail, and every sync run's issue list. Neither is filterable: they are strings, not rows | The audit trail is college-wide only; run issue lists are withheld with `issuesWithheld: true`, so a screen cannot read the absence as "no issues" |
| Deleting a school | Hard-delete a school full of another department's students. The "is it in use?" counts ran under the caller's own scope, so every count for another department was 0 and `SetNull` then detached the lot | The counts run institution-wide, and rename/retire/delete are college-wide only. Creating a school stays open to any planner: a school with nobody in it grants nothing |
| Filing a course | Create a course in another department, move one of theirs into it, or un-assign it entirely | `resolveAcademicDepartment` refuses a department the caller is not in, and refuses null — 403, because the request is well formed and the caller is not allowed to make it |
| A nested include | Delete an extension on another department's mitigating-circumstances claim, holding both ids. `AssessmentAdjustment` is `UNSCOPED` and the guard does not rewrite nested `include`s | The claim is read on its own first, which is the read the guard can see |

**The Moodle sync also created rows nobody could see.** A unit was created with its
`courseId` but no `academicDepartmentId`, and a student with neither — so every unit,
session, assessment and student a sync added to a course mapped to Business was visible
only to college-wide accounts, while the sync reported them as created, which they were.
Both now take the department of their course, on create; an existing student's is filled
in but never overwritten, because rewriting it nightly would move people across an access
boundary depending on the order Moodle listed their courses in.

**Two client fixes, one of them a plain bug:** the department editor and the Moodle
category mapping were rendered inside a `canAccessPage(…, "referrals")` block, so an
administrator holding `settings` but not `referrals` could not see either — the referrals
reasoning is about *support* departments and never applied to these. The sidebar now also
says which departments the signed-in account can see ("Viewing: Computing, Business"), and
the school filter offers only the caller's own schools.

**What this does NOT do.** Specs 3–6 of
`docs/superpowers/specs/2026-09-04-academic-departments-design.md` are still open, and the
first of them is the largest remaining hole in the boundary: **admissions, SLC and ISM
return every row to any staff member with the page**, with the department attached only as
a display label. `Admission.course` is a plain string with no `Course` relation, so there
is nothing to scope through until that is repaired. HR (spec 4) has no department axis,
every configuration table is still a single college-wide row (spec 5), and the mobile work
(spec 6) has not started. Departments remain **flat** — there is no Faculty → Department
nesting of the kind Moodle and Canvas categories have — and there is no department-level
role: an account is college-wide or a plain member, with no Head of Department.

| Check | Result |
| --- | --- |
| New suite | `scripts/smoke-department-gaps.mjs` — **14 passed, 0 failed**. Weighted negative, and every refusal paired with the permission that makes it mean something (the same account succeeding inside its own department, or a college-wide account succeeding where it is refused) |
| Proved able to fail | Each of the five gaps reintroduced in turn; the delete case is the clearest — with the scoped count restored it answered `{"retired":false,"inUse":0}` for a school holding 4 records |
| Moodle stamping | `server/src/moodleDepartmentStamp.test.js` — 3 passed. A **text** test, and it says so: `syncFromMoodle` talks to a real Moodle and there is no fake, so this reads the source. A weak proxy, stated as one |
| Full suite | **42 passed, 0 failed, 1 skipped** (`DATABASE_URL=…edtech_dev npm test`) |
| Scoped suite | `SMOKE_SCOPED_DEPARTMENT=1` — **36 passed, 3 failed, 1 skipped**. The 3 failed before this work too (`smoke-student-notifications`, `smoke-teams-automation`, `smoke-timetable-registers`) and none of them fails on a department refusal; `smoke-teams-attendance` was a fourth and now passes |
| Server unit tests | **1,753 passed, 0 failed** (1,750 before this work, plus the 3 above) |
| Client pure-module tests | **125 passed, 0 failed** |
| Client build | succeeds |

Four suites read the audit trail as evidence and would have stopped doing so in the scoped
pass, where `scope-all-staff.js` narrows every account including the Super Admin. Those
assertions are Article 9 privacy properties — that the trail records a decision and never
its reason, carries no intervention notes, says who and where and never why — so
`scripts/lib/college-wide-reader.mjs` supplies a college-wide reader in that pass only,
rather than the assertions being weakened or skipped.

### 3.7 Business rules that are actually enforced

- Leave allowance is checked **server-side at approval**, inside a per-staff lock, with
  a conditional update on `status:"pending"`. Pending requests do not consume allowance.
- Sick leave is exempt from allowance, on both client and server.
- A decided leave request cannot be re-decided (409).
- Balance adjustments must be non-zero whole numbers, range-bound to fit a 32-bit Int.
  So must `sortOrder` on admission courses and intakes — the same class of defect,
  closed in the same way, each time. (`approxStaff` / `approxStudents` on a college
  registration was a third instance; that table is gone.)
- A summary saved for a day you didn't attend does not fabricate a check-in time.
- Timesheet self-approval is refused (403).
- An assessment's `maxMarks` cannot be cut below a mark already awarded (409).
- Semester date ranges cannot overlap, so every session belongs to exactly one.
- The last remaining administrator cannot delete their own account. (The matching
  operator guards — never yourself, never the last active operator — went with the
  operator tier on 30 Aug.)

---

## 4. Security history

### The July 2026 sweep

Kept because it is real history and the regression tests still guard it.

A multi-agent sweep on 21 Jul 2026 ran 403 assertions across 4 of 12 planned areas
before a session limit cut it short. It raised **12 defects; all 12 were reproduced and
fixed**, each with a regression test.

| Severity | Defect | Fix |
|---|---|---|
| **critical** | `POST /adjustments` accepted `days` beyond a 32-bit Int. The row was stored, Prisma could then never read the table, and the API process died — permanently, since the row survived restarts. | Range-bound `days`/`allowance`; `wrapAsync` on every router |
| **critical** | `/auth/totp/setup` and `/enable` skipped the `tokenVersion` check, so a revoked session could be traded for a fresh valid one. | `resolveEnroller` performs the same staleness check as `requireAuth` |
| **high** | Challenge tokens carried no `tokenVersion`, so a sign-in started with the old password survived the victim's reset. | Challenges carry `ver`; `readChallenge` rejects stale ones |
| **high** | No rate limit on second-factor verification. | Per-account limiter: 10 wrong codes in 15 min → 429 |
| **high** | Leave allowance was a read-then-write race. | Serialised per staff member, re-checked inside the lock |
| **high** | A non-string `note` on a leave decision crashed the process. | Type- and length-checked |
| medium | Enrolling 2FA from a live session needed no password. | Now requires the password |
| medium | A successful password reset left the login lockout in place. | Reset clears the lockout |
| low | Two simultaneous submissions of one single-use reset link both succeeded. | Claimed with an atomic conditional update |

Guarded by `scripts/smoke-security-regressions.mjs` (8 checks) and
`scripts/smoke-int-overflow.mjs` (17 checks), both of which run in `npm test`.

### The 23 Aug 2026 fixes

Nine of the defects the previous edition of this file reported were fixed the same
day, in four commits. They have their own regression suite,
`scripts/smoke-security-d5-d9-t6.mjs`, written the same way as the July one: each
section reproduces the **original** defect, and "CONFIRMED" means it is back, which is
a failure.

| Was | Now |
|---|---|
| D5 — `sAdmission` stripped a fixed list of secrets, so every column added to `Admission` afterwards (`passwordHash`, `active`, `tokenVersion`) shipped to the browser by default | An **allowlist**, `ADMISSION_OUT`, with a written note under it listing what is deliberately absent and why |
| D9 — `POST /applicant/check-email` was an unauthenticated, unthrottled roster oracle | Rate limited 40/15 min/IP. Over budget it answers "available" rather than 429, because `api.js` turns any failure into "taken" and would have told a throttled honest applicant to pick a different address |
| T6 — an operator who left kept a working password against every customer's data | Deactivate/restore, with two guards |
| T2/D4 — one module-level SharePoint token cache shared across institutions | Four `Map`s keyed by tenant, plus `forgetTenant()` |
| D3 — the highest-privilege login had neither a rate limit nor a second factor | Both, and tighter than the staff login |
| D8 — `notificationsScheduler` read the **host** clock, so during BST the 08:00 notifications fired at 09:00 London | `clock.localTime()`, matching `attendanceScheduler` |
| D7 — an attendance-email run with email switched off returned 200 full of `skipped`, and read on screen as a successful send | 400 with a specific message naming how many students were due one |
| D6 — `TermCalendar` and `admissionConfig` swallowed database errors as "not migrated" / empty | Removed. A fault is now a 500 in the error middleware, visibly |
| D10 — dead `form.pending` branches; `denormalise()` duplicated between two routers | Branches removed; `denormalise` lives in `reviewForms.js` and both routers import it |

**The July sweep never covered** sign-up/approval, check-ins, HND registers,
staff/documents/notifications, input robustness, the browser UI, or a static code
review. The August work closed specific reported findings; it was not a sweep. A fresh
sweep across the current surface — roughly 275 endpoints across three identity kinds; the
fourth tier and the supplier dashboard it guarded were removed on 30 Aug — is outstanding
and is a much larger job than it was in July.

**Four of the fixes above now guard deleted code.** D3 (a rate limiter and 2FA on the
platform login), T6 (deactivating a departed operator), T2/D4 (a SharePoint token cache
shared across institutions) and the isolation work generally were real fixes to real
defects, and the surfaces they hardened no longer exist. They are kept here because the
history is true and because two of them — a privileged login without a limiter, a
module-level cache holding one caller's credentials — are mistakes shaped generically
enough to be made again somewhere else.

---

## 5. Testing and CI

`npm test` (`scripts/test.mjs`) applies migrations, seeds fixtures, boots its own API
on port 4010, discovers every `smoke-*.mjs` in `scripts/`, runs them, and exits
non-zero if any failed. `.github/workflows/ci.yml` runs it on every push and PR against
a throwaway Postgres container, builds the client first (so a broken import fails
before the tests start), and runs `npm audit` advisory-only.

**26 suites on 28 Aug 2026, up from 10 in July and 21 on 23 Aug. Three were deleted on
30 Aug and the total has not been re-counted** — other branches have been adding suites
in the same period, so the arithmetic does not simply give 23. **Two more (`smoke-student-
notifications`, `smoke-mitigations-student`) were added 12-13 Sep 2026** alongside
`smoke-teams-attendance` and `smoke-teams-automation` from the same week (§3.11, §3.12);
the running total in this paragraph is left uncorrected rather than guessed at — `ls
scripts/smoke-*.mjs | wc -l` on this branch is the number to trust, not this sentence.
Read from each file's own header:

| Suite | Covers |
|---|---|
| `smoke-branding` | That a college which has configured **nothing** receives nothing belonging to anybody else. Mostly negative assertions — the defect it guards is a student getting an offer letter from the wrong institution |
| `smoke-attendance-bands` | Each college's own attendance thresholds, and which of them send a letter. Mostly about what a bad ladder does to a student: a gap swallows them silently, an overlap makes their letter depend on array order, a ladder short of 0% or 100% loses the two students it matters most not to lose. Also pins that an unconfigured college still gets exactly the six built-in bands |
| `smoke-admissions` | The pipeline holding the most dangerous data in the product — DOB, NI number, ID numbers, criminal-conviction and medical declarations, ethnicity, religion — with three of its six routers public. Almost all negative: who is refused, what never leaves the building, which decisions cannot be made twice |
| `smoke-applicant` | The one surface a stranger may create an account on. Can that account become anything other than an applicant? Reach a second applicant's application? Overwrite a decision the college recorded? Does an upload with no storage configured degrade honestly, or swallow a document and claim it was filed? |
| `smoke-assessments` | The gradebook. Admin-only; marks outside range, non-integers, duplicate students and non-enrolled students all rejected; `maxMarks` cannot be cut below an awarded mark (which would inflate every derived percentage at once); D/M/P/F really at 70/60/50; re-saving is idempotent, because the grade screen resubmits the whole unit on every save |
| `smoke-hnd` | Registers — the most-audited number the product holds (UKVI, funding body, a student disputing an absence). Builds its own course, cohort, terms, units and students, tries what must not work, and removes everything it made |
| `smoke-studentportal` | Two things at once: a student session reaches nothing but `/api/student`, and inside it sees only their own row. Also pins the attendance and band arithmetic a college defends at an appeal. **Extended 13 Sep 2026** with 9 more checks (42 → 51): a weighted-vs-plain-mean assessment average, an attendance-bands round-trip plus a drift-guard against the client's mirrored copy, and a `teamsJoinUrl` round-trip on the timetable — see §3.13 |
| `smoke-reviews` | The three routers holding the most sensitive free text. Guards confidentiality and integrity, not uptime: a lecturer reading the management review about them, an appraisal silently re-attributed, a submitted reflection rewritten after it was read, the student roster's emails reaching every member of staff |
| `smoke-timesheets` | The payroll surface — timesheets, leave, check-ins, adjustments. Almost all negative: no self-approval, no editing an approved month, no approval past allowance, no invented clock-in for a day nobody came in |
| `smoke-audit` | Three properties: it records the right things, it never leaks a secret into a log read by more people and kept longer than the table it describes, and it cannot be edited or deleted through the API |
| `smoke-security-d5-d9-t6` | The three defects fixed on 23 Aug stay fixed — **now two.** The T6 section (an operator who left keeps a working password) was removed on 30 Aug with the operator tier and is recorded in the file as **DELETED, not as passing**: its three assertions proved real things and nothing covers them any more. The name is unchanged, so the suite's title claims one more defect than it guards |
| `smoke-security-regressions` | The 8 July 2026 defects stay fixed |
| `smoke-int-overflow` | Oversized numbers can't crash the API; the database refuses out-of-range values |
| `smoke-account-deletion` | Password, 2FA, typed confirmation, dependent records — the guards as hard as the happy path |
| `smoke-invite` | Admin-created accounts are unusable until activated |
| `smoke-password-reset` | Hashed single-use links, expiry, revocation, 2FA gating |
| `smoke-push` | Device registration and scoping, with FCM unconfigured |
| `smoke-push-transport` | The FCM transport, standing in for Google — no server or network needed |
| `smoke-fixes` | Role scoping on `/staff`, adjustment validation, re-decision guard |
| `smoke-signup-2fa` | **SKIPPED** — see D2 |
| `smoke-prediction` | **Added 25 Aug 2026.** Progression risk — the feature that tells a college which named students are likely to fail. Almost all negative: a configuration that cannot be honoured is refused rather than stored (weights off 100%, a gap or overlap in the ladder, an override naming a band that does not exist, a save with nothing in it); no stored score may disagree with the band beside it; no override may move a student *up*; and a member of staff without the page grant cannot read the register at all. 25 checks; **passed on 25 Aug 2026** |
| `smoke-mitigations` | **Added 28 Aug 2026.** Mitigating circumstances. Mostly refusals, and two that matter: the audit trail carries no `category` or `detail`, and neither does the prediction payload — health data is collected for student support and must not reach a score. 13 checks; **passed** |
| `smoke-nfc-tap` | **Added 28 Aug 2026.** What a tap must never be able to do — a tap while the feature is off, an unknown or retired tag, a tag belonging to another college, a tap before the class or after it, a student reaching the tag admin or the lecturer's live view or closing a register, a second tap creating a second mark. The two that would otherwise be missed: a tap cannot overwrite a mark a lecturer already set, and a later register save cannot overwrite `checkedInAt`. 48 checks; **passed on 28 Aug 2026** |
| `smoke-referrals` | **Added 30 Aug 2026, extended 1 Sep.** Referrals to support departments, and mostly who is refused: ASK reading the Wellbeing queue (403, never an empty list), the referrer's payload asserted as an **exact key set** rather than by the absence of two names, a referral accepted twice or closed with no outcome, a retired desk refusing new work while its queue stays readable. The 1 Sep additions are the ones a later reader is most likely to widen: case notes crossing a hand-off, a team reading the thread of the team it handed a case to, and a student being shown a referral the tickbox withheld. 75 checks; **passed on 1 Sep 2026**, and each of those three was proved able to fail by reintroducing the bug |
| `smoke-student-notifications` | **New, 12-13 Sep 2026.** The student notification channel end to end — see §3.13. Exactly-one-owner on `DeviceToken` for both audiences, a handset moving rather than duplicating on re-registration, the unread badge counting every unread row rather than the 50-row page, a forged notification id touching nothing, all five write-path triggers driven through their real endpoints (including the timetable-change fan-out's dedupe, closed in a follow-up round after review flagged it as the one trigger with no coverage). 34 checks; **passed, run at least twice standalone and via the project runner** |
| `smoke-mitigations-student` | **New, 12-13 Sep 2026.** The self-service mitigating-circumstances route — see §3.13. The shared-validator claim proven by string-equal error messages against the staff route, the response allowlist proven by absence of `detail`/`decisionNote`/`decidedBy`/`createdBy` (including after a real decision has written a `decisionNote`), the self-raise notification scoped to `hasPage(staff, "mitigations")` rather than every admin, the decision notification firing exactly once and never carrying the note or category. 29 checks; **passed, run at least twice**; the pre-existing `smoke-mitigations` stays 16/16 alongside it |

**Three suites were deleted on 30 Aug 2026, and the coverage they held is given up
rather than replaced.**

| Deleted suite | What it proved |
|---|---|
| `smoke-tenant-isolation` | **One customer could not reach another's data.** Two deliberately colliding institutions — same admin email at both — attacked from A against B over real HTTP. Every attempt had to fail |
| `smoke-platform` | The tier above every customer. Deliberately lopsided towards refusals: a college admin reaching the platform, a password alone once 2FA was enrolled, a challenge token passing as a session, a revoked operator's tab still working, the platform locking itself out of its last account |
| `smoke-registrations` | How an organisation became a customer — the one route that manufactured an institution from outside the platform. A form submission, a guessed code, a stolen code, a spent code, a rejected code and a locked-out code each had to be worth nothing on its own. 41 checks |

They were **deleted rather than adapted**, deliberately: with no tenancy their assertions
would pass while discriminating nothing, which is the failure mode this repo has hit twice
before and which reads as coverage on the summary line. Recorded honestly — this removes
the only automated proof that one institution cannot read another's data. That proof is no
longer *meaningful*, but it is no longer *available* either, and if the product ever
becomes multi-tenant again these suites are the first thing that has to come back.

**What still has no automated coverage** — checked by grepping every suite for each
mount, not assumed: `/api/ism`, `/api/slc`, `/api/interactions` (PAT),
`/api/attendance-emails`, `/api/moodle`, `/api/doc-templates`, and the client.
`/api/timetable` is reached only indirectly, through `/student/me/timetable` in
`smoke-studentportal`; `/api/email-templates` only through the four placeholder and
escaping checks in `smoke-branding`. Neither router is covered on its own terms.
There is still no unit or component test framework and no client-side tests.

**The whole suite was run on 28 Aug 2026 and passed: 25 passed, 0 failed, 1 skipped**
— every smoke suite plus the unit tests, including `smoke-nfc-tap.mjs` on its first ever
execution. That run is what makes this file's claims about the tap HTTP surface
demonstrations rather than code-reading. The 25 Aug run (24 passed, 1 skipped) did the
same for the prediction surface.

**The whole suite was run again on 1 Sep 2026 and passed: 27 passed, 0 failed, 1 skipped**,
plus 1,239 unit tests, against the local `edtech_dev`. That run is *after* the removal of
multi-tenancy on 30 Aug — which touched the schema, `db.js`, every suite's setup and most
of the client — so the earlier caveat that no run covered the de-tenanted code no longer
holds. It also covers the referral transfers, the referrer/department thread and the
student-facing view added the same day.

**What that run still does not cover** is anything in the table above marked as having no
automated coverage, and the whole client beyond `npm run build`.

**There IS a local PostgreSQL on this machine, and earlier editions of this file were
wrong to say otherwise.** Two services are installed and 16.13 answers on
`127.0.0.1:5432` with the credentials `server/.env.example` documents. The 28 Aug run
used a database created there for the purpose:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

`edtech_dev` is safe on two counts at once — `localhost` is in `assertDisposable`'s
`LOCAL_HOSTS`, and `dev` matches its disposable-name regex. `CLAUDE.md` has been
corrected to say this, and it is now the documented route.

**The isolated-schema trick this file previously recommended is not safe, and the reason
matters.** `DATABASE_URL="…/edtech_staging?schema=smoketest"` was used successfully on
25 Aug, but `assertDisposable` parses only the **host and the database name** — it never
looks at `?schema=`. So that URL fails the guard exactly as `public` does, and the only
way past it is a `DESTRUCTIVE_DB_CONFIRM` token which, because the schema is not part of
it, equally authorises seeding straight over `public`. One dropped query parameter
between typing the token and running the command is the whole live database. Use the
local one.

Worth keeping from that run: `migrate deploy` built every table into an empty schema
from nothing, which independently proves the migration chain applies cleanly from
scratch — the thing CI does on every push. Neither route is a substitute for CI.

**`server/.env` still points at live staging, and `assertDisposable` would allow it** —
`edtech_staging` matches the disposable-name rule. A plain `npm test` on this machine
seeds over live data and the guard does not stop you. Always pass `DATABASE_URL` on the
command line; never let it fall through.

`SKIP` deliberately reads differently from `PASS`, so a switched-off feature stays
visible rather than counting as coverage. Exactly one suite reports it —
`smoke-signup-2fa` is the only file in `scripts/` containing `exit(2)`.

Commit `d85d7ab` ("Integration coverage for eight feature areas, and four bugs it
found") is worth noting: the suites are already earning their keep.

---

## 6. Known gaps, defects and open decisions

### Every defect the previous edition listed, re-checked against the code

None of the *resolutions* below were runtime-verified either. "Fixed" means the code no
longer does the thing described and, where relevant, a comment or a suite says why.

**This table is a record as at 28 Aug 2026 and has not been re-verified since.** Several
rows — D1, D3, D4, T1, T2, T3, T8, T9, S1 — describe tenancy machinery that was deleted
on 30 Aug, so their *defect* is now moot even where their *fix* is gone too. The
exception worth acting on is **D1**: `server/create-admin.js` was fixed by teaching it
`runInTenant` / `crossTenant`, and `src/db.js` no longer exports either, so the fix is
now the breakage. See §3.5.

| # | Previous claim | Verified state |
|---|---|---|
| D1 | `server/create-admin.js` broken by tenancy | **Was fixed 23 Aug; broken again 30 Aug, in the opposite direction.** The fix taught it `crossTenant` / `runInTenant` and replaced `upsert({ where: { email } })` with `findFirst` + create/update, because `@@unique([tenantId, email])` meant `email` was no longer a unique selector. `src/db.js` exports neither function now, so the file would throw on require — tracked as **D17**. The parts worth keeping either way: it refuses the passwords this project used to ship, and clears TOTP so a lost authenticator is recoverable |
| D2 | Mandatory 2FA is switched off | **Still true.** `TOTP_ENFORCED = false` at `routes/auth.js:33`, the enrolment branch at `:225` is commented out, `routes/signup.js:356` sets `mustSetupTotp: false`. Accounts that opted in *are* always challenged. `smoke-signup-2fa` skips. Still a Critical item in the readiness plan |
| D3 | Platform login has no rate limiter and no 2FA | **Fixed, both.** See §3.5 |
| D4 | SharePoint token cache not tenant-keyed (= T2) | **Fixed.** See §2 |
| D5 | `sAdmission` leaks `passwordHash` | **Fixed.** Allowlist, plus a regression suite |
| D6 | `TermCalendar` treated as possibly-unmigrated in three places | **Fixed.** `routes/timetable.js:233` explains the removal; `admissionConfig.js` lost its swallow-everything fallback on reads and now maps only P2025 to a 404 |
| D7 | Attendance-email run counts "email off" as `skipped` | **Fixed.** `routes/attendanceEmails.js:76` returns 400 with a count of students who were due one |
| D8 | `notificationsScheduler` uses the host clock | **Fixed.** `clock.localTime()` |
| D9 | `check-email` unauthenticated and unthrottled | **Fixed.** See §4 |
| D10 | Dead `form.pending`; `denormalise()` duplicated | **Fixed.** Both routers import it from `reviewForms.js` |
| D11 | Stale-run sweeping implemented twice | **Fixed.** One `sweepStaleRuns()` in `src/moodle.js`, called from both `scheduler.js:111` and `routes/moodle.js:38` |
| T1 | The client never sends `X-Tenant` | **Fixed.** `client/src/api.js:121` |
| T2 | SharePoint token cache not tenant-keyed | **Fixed** |
| T3 | Per-tenant Moodle `autoSync` stored but never read | **Fixed.** `scheduler.js:101–103` prefers the saved value and falls back to `MOODLE_AUTO_SYNC` only when it is unset |
| T4 | `/moodle/status` reports `process.env.MOODLE_URL` | **Fixed.** Primes `cfg.load("moodle")` first and reports the institution's own configuration |
| T5 | Branding hard-coded per file | **Mostly fixed** — see §3.6. Three literals survive in `StaffHub.jsx`; tracked as T5b |
| T6 | Platform-operator management incomplete | **Mostly fixed** — see T6b |
| T7 | `lastTestedAt` / `lastTestOk` / `lastTestNote` are dead columns | **Fixed.** `POST /api/integrations/:provider/test` runs a read-only connection check and writes all three; `IntegrationSettings.jsx:244` is the button. The second reader — the platform dashboard's health indicator — went on 30 Aug, so the college's own Settings screen is now the only one |
| T8 | Scripts outside the request path bypass isolation | **Mostly fixed** — see T8b |
| T9 | Deployment config does not mention the tenancy variables | **Still true** |
| S1 | `npm run setup` does not work out of the box | **Fixed.** `server/.env.example` now ships a PostgreSQL `DATABASE_URL` and documents `DEFAULT_TENANT_SLUG`, `TENANT_BASE_DOMAIN`, `TENANT_CACHE_MS`, `CREDENTIALS_KEY` and `APP_TIMEZONE`, with the reason each exists. `prisma/assertDisposable.js` now refuses to seed a remote database whose name does not mark it disposable |
| S2 | `setup.mjs` prints a password that no longer exists | **Fixed.** `scripts/setup.mjs:50–51` names the account and says the password is the `SEED_PASSWORD` you set, which is never printed |
| S3 | `schema.prisma` header still says SQLite | **Fixed.** The header now explains why the SQLite-locally arrangement was abandoned — the two disagree on typing and case-sensitivity in ways that hid real bugs |
| S4 | `render.yaml` and `DEPLOY.md` predate tenancy | **Fixed** — see T9 |

### The 24–25 Aug deploy stoppage — a renamed migration

**Staging's API had not deployed for a day, and nothing said so.** Found on 25 Aug 2026
while deploying predictive analysis; fixed the same day. It is written down here
because the failure was silent in the one place that matters: the API went on serving
happily, `/api/health` answered 200, and the only symptom was that new code never
appeared.

**What happened.** `20260824090000_attendance_bands` was applied to staging, then
renamed on disk to `20260824093000_attendance_bands` so the `090000` slot could go to
`_branding_button_colours`. Prisma identifies a migration by its **directory name**, so
the rename made an already-applied migration look like a brand new one. The next
`migrate deploy` re-ran its `CREATE TABLE "AttendanceBandConfig"`, hit *already exists*,
and left a row in `_prisma_migrations` with `finished_at = NULL`.

Prisma then refuses **every** subsequent migration while a failed one sits in the
history. `render.yaml` runs `npm run migrate:deploy` in `buildCommand`, and a failing
build command fails the build — which is the correct design (better than an API running
against a schema it does not match) and is why nothing broke. But it meant every Render
build from 24 Aug onward failed at the same step, and `58f7151` — the attendance-bands
feature itself — was never live on staging either.

**How it was diagnosed.** Not from the Render dashboard, which was not reachable. From
the database:

```sql
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at;
```

One row with a null `finished_at` is the whole story. Before resolving it, every object
the failed migration creates was checked to exist already — the table and all five
columns, `AttendanceBandConfig_pkey`, `AttendanceBandConfig_tenantId_key` and
`AttendanceBandConfig_tenantId_fkey` — because marking a migration applied when it was
*not* would skip a real schema change and leave the database silently short of a column.

**The fix**, which changes no schema and touches no application data:

```
cd server && npx prisma migrate resolve --applied 20260824093000_attendance_bands
```

**Two things this leaves behind.** `20260824090000_attendance_bands` is still recorded
in staging's `_prisma_migrations` and no longer exists in the repo, so `migrate status`
reports the history as divergent on every run. `migrate deploy` tolerates a DB-only
migration and proceeds, so this is noise — but it is noise that looks exactly like a
real problem, and the next person to read it will lose the same twenty minutes.

**The rule that follows: never rename a migration directory once it has been applied
anywhere.** Ordering against a migration created later is not worth a stopped pipeline.
If two migrations need reordering, the honest options are to leave the timestamps alone
or to write a new migration.

**Worth checking on production.** The same commits reached the `production` branch, so
production's `_prisma_migrations` may hold the same unfinished row. It could not be
checked from this machine — there is no production `DATABASE_URL` here, and the Supabase
MCP connection available in that session was authenticated to a **different** account,
holding two unrelated projects and not EdTech's. Run the `SELECT` above against
production before assuming it deployed.

### Open defects

| # | Severity | Item |
|---|---|---|
| D2 | **high** | Mandatory 2FA is off (above). A decision, not an oversight — but an undecided one |
| D12 | medium | **`/api/admission-apply` is a public, unauthenticated write with only a honeypot.** It writes special-category personal data. `routes/registrations.js` had a limiter on a structurally identical endpoint and was never copied here; that file was deleted on 30 Aug, so the pattern now has to be fetched from git history or written again |
| D13 | medium | **The upload cap disagrees with itself.** `sharepoint.MAX_BYTES` is 15 MB and `storage.MAX_BYTES` is 10 MB; `routes/admissionsUpload.js:58` and `routes/applicant.js:250` both use the SharePoint figure as the body limit. On a deployment using the Supabase fallback, a 12 MB file is accepted and then rejected downstream |
| D14 | medium | **The offer letter contradicts the accept link.** `src/offerLetter.js:224` prints "reply to the email containing this offer" while `/api/admission-offers` is a one-click acceptance. Now worse than before: a college may have replaced the letter with its own via `TenantDocTemplate`, in which case the built-in text and the college's text can say different things about the same offer |
| D15 | medium | **A student is never told their query was answered.** `routes/studentQueries.js` contains no notification or email call of any kind. The answer sits in the portal until they happen to look |
| ~~D16~~ | ~~low~~ | **FIXED (verified 5 Sep 2026).** `prediction` and `mitigations` are both labelled, and `PAGE_LABELS` now has an entry for all 35 pages — asserted by `src/adminPages-contract.test.js`, which also pins the two `ADMIN_PAGES` copies together. Original report: **Two grantable pages have no label on the screen that grants them.** `PAGE_LABELS` in `StaffHub.jsx` has 29 entries against `ADMIN_PAGES`' 31; `prediction` and `mitigations` are missing, so the Access tab renders them as a checkbox with no words beside it. The two `ADMIN_PAGES` copies *are* in sync — this is a third hand-maintained list in the same file that nothing checks. Predates the NFC work; `live-attendance` and `attendance-tags` were both labelled when they were added |
| T5b | medium | Three EdTech literals in `StaffHub.jsx` (above). Less severe than it was — the deployment's one college now sees the supplier's address rather than another customer's — but still text nobody can edit |
| ~~D17~~ | — | **FIXED 30 Aug, same day it was filed.** `server/create-admin.js` imported `runInTenant` and `crossTenant` from `src/db`, which exports neither, so the documented way to create or recover the first administrator threw on require. It no longer resolves an institution at all — there is one — and `Staff.email` is a plain unique again. Not covered by any suite, so this is code-read and `node --check`, not a demonstrated run |
| ~~D18~~ | — | **RESOLVED 30 Aug by deletion.** `src/usage.js` had no caller once the platform dashboard went. It was deleted rather than kept against a Settings screen that does not exist; the tenant-aware original is in git history at the commit before the removal, and the de-tenanted rewrite in that commit's parent working tree was not kept |
| D19 | low | **`sharepoint.forgetCached()` has no caller.** The old `forgetTenant(tenantId)` was called when a college saved its SharePoint credentials; the de-tenanted replacement is not called by anything. The three id caches have no TTL, so an administrator who corrects a wrong site address waits for a restart. Its own doc comment says as much — it is not dead code, it is uncalled code |
| D20 | low | **Two more `upsert` + empty `update: {}` sites carry the same shape that caused the P2002 → HTTP 500 defect fixed on the staff presence branch** (see the long comment above `POST /check-in`'s create-catch in `routes/checkins.js`, and the assertion in `scripts/smoke-nfc-tap.mjs` under "two presses at once"). `routes/hnd.js:1136` (`replaceUnitEnrolments`) and `routes/hnd.js:1382` (`replaceStudentEnrolments`) both `prisma.enrolment.upsert({ ..., update: {} })` inside a loop. Prisma only compiles `upsert` to a single `INSERT ... ON CONFLICT` when the `update` branch is non-empty; with `update: {}` it degrades to a bare `SELECT` followed by a bare `INSERT`, so two concurrent requests that both try to enrol the same student on the same unit can both miss each other's row and the loser surfaces as an unhandled P2002 — a 500 on a bulk-enrolment save rather than the harmless idempotent write the code reads as. **Deliberately not fixed here** — diagnosed while reviewing the staff presence branch, out of that branch's scope, and recorded so the diagnosis is not lost before somebody next touches either route |
| ~~T8b~~ | — | ~~`seed-admissions.js` on a bare client; five tools fail closed~~ — **dissolved 30 Aug**, see §2 |
| ~~T9~~ | — | ~~Deployment config predates tenancy~~ — **resolved 25 Aug 2026**; its `DEFAULT_TENANT_SLUG` / `TENANT_BASE_DOMAIN` entries now name variables nothing in `server/src` reads |
| 6 | low | `GET /student-reviews/roster` is open to any authenticated staff member with no page gate — a documented widening (a `pat`-only admin cannot call `/hnd/students`), and still the broadest read surface in that area |
| 7 | low | `admissionDocs.js` says its document-type list is duplicated in `client/src/StaffHub.jsx` and must be kept in sync by hand |
| 5 | — | "Personal template" documents (`scope:"personal"` with no assignee) are invisible to everyone. Still needs a product decision |

**Five minors found reviewing the staff presence work (§3.14), deliberately left as recorded rather than fixed on the spot** — each is small enough that fixing it in the same pass as the documentation task would have been an undisclosed behaviour change, which this file's own conventions treat as worse than a known gap:

| # | Severity | Item |
|---|---|---|
| SP1 | low | **A tap-route presence refusal logs `TagTap.tagId` as `null`.** The design intends this — presence is checked before the tag is looked up, matching the student route's own reasoning ("somebody off the college network should be told THAT, not handed 'tag not recognised'") — but `TagTap`'s own schema comment calls a resolved `tagId` "the valuable half" of the log, and the tap route goes to the trouble of resolving it anyway on the already-clocked-in path for exactly that reason. A presence refusal from `refusedForStaffPlace` does not receive the same treatment, silently, and nobody has decided whether that inconsistency is acceptable or worth the extra query |
| SP2 | low | **A duplicate `AttendanceTag` lookup on the rare already-clocked-in-plus-unknown-code path** in `POST /tap-check-in`: the row is read once to resolve `tagId` for the log (SP1's fix would need it anyway), and if the code does not match a live tag the route falls through to the ordinary tag-lookup below, reading the same table again. Harmless — this path runs at most once per person per day — and left rather than restructured mid-documentation-pass |
| SP3 | low | **The staff geofence settings copy omits the student panel's honesty caveat.** `AdminNfcTags.jsx`'s student geofence checkbox says outright: "it can't prove the reading was honest, because the position is sent by the phone." The staff geofence checkbox, added in the same feature, does not repeat it — an administrator reading only the staff card would not be told the same limitation applies there too |
| SP4 | low | **A narrow first-render race in `StaffHub.jsx`'s check-in screen — previously misdescribed here, corrected 24 Sep 2026.** Before `api.staffTapSettings()` resolves, `tapRequired` reads `false`, so choosing **On site** in that window does *not* relabel the button to "Tap the sticker" and the first press is *not* a no-op, as an earlier edition of this row claimed. `checkInButton()` (`client/src/staffCheckInView.js`) returns `{ label: "Check in", enabled: true }` exactly as it would with no sticker required, the press sends `POST /check-in` with `site: "Onsite"`, and it is the **server**, not the client, that catches the case: `tap_required` comes back 409 and the client renders the correct refusal banner from `staffPlaceRefusal("tap_required")`, indistinguishable on screen from any other refusal. That is the server backstopping a client-side race window the client cannot yet know it is in — the correct architecture, not a defect — and the window closes the moment the settings fetch resolves, which is ordinarily well inside the time it takes a person to read the screen |
| SP5 | low | **`forgetNeedsLocation()` does not clear an in-flight lookup promise.** If a `staffContextInFlight` request is still in the air when sign-out fires, that promise resolves after `forgetNeedsLocation()` has already reset the cached value, and its `.then()` writes the old session's answer back in. Harmless in practice — `needsLocation` is an institution-wide fact (does this college require a position), not a per-user one, so the value the stale promise writes back is correct regardless of who is signed in — but it is a real race in the code, not merely a theoretical one, and is recorded here rather than patched silently |

### Longer-standing gaps

| # | Item | Notes |
|---|---|---|
| 1 | JWT has revocation but no refresh | `tokenVersion` revokes on reset/change. A shorter expiry plus refresh tokens is still the production-grade answer, and there is no "sign out my other devices" button |
| 2 | Every rate limiter and the leave-decision lock are **in-process** | Module-level `Map`s and promises. Seven were counted on 28 Aug; the platform-login and registration-submit limiters went with their routes on 30 Aug, and `routes/tags.js` has one on new-sticker claims, so **the count has not been re-taken**. Staff login, TOTP verify, applicant check-email, the student tap limiter and the leave lock are certainly still there. Correct for one Node process; a clustered deployment needs Redis and a database-level lock. Each one says so in a comment, which is at least honest, but it is a systemic property rather than an exception |
| 3 | Client bundle size | 1.22 MB / 313 kB gzipped in July; `StaffHub.jsx` alone is now **14,256 lines**. **Unverified since July** — certainly larger, with `pdf-lib` on the server and pdfjs on the client since 23 Aug and `@capgo/capacitor-nfc` since 28 Aug. pdfjs is loaded on demand (`TemplateEditor.jsx`) and the NFC plugin is imported lazily and only on a native platform (`nfc.js`), which is the pattern the rest of the client still needs. Nothing else is code-split except the Capacitor plugins |
| 4 | Throughput ceiling | ~110 req/s in July, limited by synchronous bcrypt blocking the event loop. **Unverified since July**; Postgres and the audit write change the picture, and the tenant middleware and per-query isolation extension that were also in it have since been removed. See `STRESS-TEST.md` |
| ~~8~~ | ~~SQLite, single file~~ | **RESOLVED** — PostgreSQL, 9 migrations |
| ~~9~~ | ~~Tailwind from the Play CDN~~ | **RESOLVED** — compiled at build time |
| ~~10~~ | ~~"Today" derived in UTC~~ | **RESOLVED** — `src/clock.js` pins `APP_TIMEZONE`; D8 was the last exception and is fixed |
| ~~11~~ | ~~Thin automated coverage, no CI~~ | **Largely resolved** — a suite per feature area and CI, and there is now a local PostgreSQL to run them against (§5). The list of uncovered areas in §5 is short enough to read. Three suites were deleted on 30 Aug and the total has not been re-counted |

---

## 7. Running it on this machine

Node **v24.15.0** / npm **11.12.1** are on PATH in Git Bash. If `npm` is not found in a
fresh PowerShell window, either add `C:\Program Files\nodejs` to PATH permanently or
prefix the session:

```powershell
$env:Path += ";C:\Program Files\nodejs"
```

You also need a **PostgreSQL** database and a `server/.env` pointing at it. See *Quick
start* in `README.md`.

**There is a local PostgreSQL here** — 16.13 on `127.0.0.1:5432`, with `edtech_dev`
created for the test suite. That is the database to run anything destructive against:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

> ⚠️ **`server/.env` on this machine still points at a live staging database.**
> `npm test` seeds fixtures and the suites create, mutate and delete real rows, and
> `assertDisposable` does **not** stop you — `edtech_staging` matches its
> disposable-name rule. Always pass `DATABASE_URL` on the command line and never let it
> fall through to `.env`. `prisma/assertDisposable.js` is a backstop, not permission.

> The repo is now flat at `Documents\Edtech` (the folder with `package.json`). Earlier
> editions of this file described it as three folders deep under `Downloads`; that copy
> is stale.

Beware: `npm run setup` **re-seeds**, which clears the demo tables it owns.

---

## 8. Documentation state

| File | State |
|---|---|
| `STATUS.md` | This file. Rewritten 23 Aug 2026 (evening) after the previous edition was found to be listing sixteen fixed defects as open; extended 25, 28 and 29 Aug; de-tenanted 30 Aug. **Not current for the last two commits on `nfc-tap-check-in`** — prediction trajectory, intake profile and divergence (`17b1a96`, `74774a9`) landed after §3.8.2 was written and have no section here. It is also not current for the timetabling and assessment-tracker work landing alongside the 30 Aug change, and no count in it was re-taken on that date |
| `README.md` | **Stale, and now wrong rather than merely incomplete.** Updated on 23 Aug — setup, PostgreSQL, migrations and `npm test` are current, but its **multi-tenancy section describes machinery deleted on 30 Aug**, and the data model and API mount map predate several features. It knows nothing about branding, document templates, email templates, the institution's email configuration or the audit trail. Its page figures are stale too: `README.md:449` says "28 pages … 27 grantable" where the 28 Aug count was 33 tabs and 31 grantable. **Not touched by the 30 Aug documentation pass**, which covered only `CLAUDE.md`, `STATUS.md` and `API.md` |
| `scripts/README.md` | **Partly stale.** The runner, the `PASS`/`FAIL`/`SKIP` convention, the throwaway-database warning and the "adding a suite" contract are all accurate and worth keeping. Its suite table lists **9 of the 26** — every suite added since 23 Aug is missing from it. The `smoke-signup-2fa` skip note is still correct. Worth noting that its database advice was right all along: it tells you to create a local scratch database (`postgresql://postgres:postgres@localhost:5432/edtech_test`), which is what §5 has only now caught up with. It names `edtech_test`; the one that exists is `edtech_dev` |
| `API.md` | **Badly out of date.** Counted on 23 Aug: **62 endpoints across 10 route modules** — auth (including password reset, activation, 2FA), sign-up, staff, check-ins, leave, adjustments, documents, notifications, devices and HND. Nothing on admissions (6 modules), the applicant portal, the student portal, student queries, assessments, timesheets, timetable, the three review modules, PAT, ISM, SLC, Moodle, attendance emails, integrations, branding, document templates, email templates, audit, prediction, mitigations or NFC tags. **That numerator has not been re-measured, and the denominator has moved several times since**; on 28 Aug the API was 275 endpoints across 41 modules, so 62 would have been 23%. **Re-count before quoting a figure.** It was edited on 30 Aug only to remove tenancy — the platform and registration surfaces it never documented are now also gone, and `X-Tenant` is no longer sent — which changes nothing about its coverage. It remains the single largest documentation gap |
| `server/prisma/migrations/README.md` | Accurate. Covers why `db push` was abandoned and the rules for changing the schema |
| `DEPLOY.md`, `render.yaml` | Brought up to date for tenancy on 25 Aug (T9), which has now made them wrong in the other direction: `render.yaml` declares `DEFAULT_TENANT_SLUG` and `TENANT_BASE_DOMAIN`, and nothing in `server/src` reads either. Not reviewed in the 30 Aug pass |
| `BUG-AUDIT.md`, `STRESS-TEST.md` | Historic. July 2026 figures, not re-measured |
| `SHAREPOINT_SETUP.md`, `MOBILE.md`, `PRIVACY.md`, `DELETE-ACCOUNT.md`, `SUBMISSION_CHECKLIST.md` | Not reviewed in this pass |

---

## 9. Bottom line

The platform is materially better than it was this morning, and the gap between it and
the previous edition of this document was the most misleading thing in the repo. Of the
24 numbered items that edition listed, **18 were already fixed outright** (D4 was a
duplicate of T2, so 17 distinct defects), 3 are partly fixed, and 3 are still open —
most of them closed within hours of being written down.

**That paragraph describes 23 Aug and is kept as written.** The largest change since is
the 30 Aug removal of multi-tenancy: the product is one deployment per college, the
supplier-facing operator tier is gone, and isolation moved from the query layer to the
infrastructure. The honest summary of that is that a whole category of defect stopped
being possible and a whole category of proof stopped being available at the same time.

What is genuinely left, in order:

0. **Run the suite.** Nothing has been run since the de-tenanting, so every
   demonstration in this file is currently a claim about older code (§5). Two items
   found by reading — D17 (`create-admin.js` importing functions that no longer exist)
   and D18 (`usage.js` with no caller) — were both closed on 30 Aug, and the suite has
   since been run: 26 passed, 0 failed, 1 skipped against local edtech_dev, alongside
   1,207 server unit tests. Three suites fewer than the 28 Aug baseline of 29, which is
   exactly the three that were deleted.
1. **Decide D2.** Mandatory 2FA is still off. Every other item from both security
   sweeps is closed; this is the one that is a decision nobody has made rather than
   work nobody has done. Setting `TOTP_ENFORCED = true` also reactivates ~35
   assertions that currently skip.
2. **Rate-limit `/api/admission-apply` (D12).** A public, unauthenticated write that
   stores special-category personal data, guarded by a honeypot. The pattern to copy
   used to be thirty lines away in `routes/registrations.js`; that file was deleted on
   30 Aug, so it now comes out of git history.
3. **Bring `API.md` up to date.** It documents a quarter of the API and fell further
   behind today.
4. **Update `README.md` and `scripts/README.md`** — seventeen missing suites between
   them, six missing feature areas, and `README.md`'s page counts are now wrong (§8).
5. **Prove the NFC tap on a handset (§3.9).** The HTTP surface passes 48 checks and the
   window arithmetic has 23 unit tests, but no physical tap has ever been performed.
   One Android phone and a packet of stickers closes it; iOS additionally needs two
   manual Xcode steps that nobody has done.
6. **Extend coverage** to the timetable, PAT, attendance emails, the Moodle sync,
   templates — the areas §5 still lists as untested. Mitigations and the NFC tap have
   since got suites of their own.
7. **Run a fresh security sweep.** The July one covered 4 of 12 planned areas against a
   much smaller product, which is now a few hundred endpoints across three identity
   kinds and — newly — a route by which a student writes their own attendance mark. The
   August fixes closed reported findings; they were not a sweep. The supplier tier that
   would have been a fourth area no longer exists.

Nothing in this file should be read as a claim that the system has been verified end to
end. The HTTP surface has been exercised (§5); the client has no test framework at all;
and the NFC feature's device half has never been run against hardware (§3.9). *How this
was checked* says which is which.
