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
| **Per-page admin access + Super Admin** | `src/auth.js` (`requirePage`), `AdminAccess` tab | ✅ 31 grantable pages, the two copies of `ADMIN_PAGES` verified identical by set *and* order. Two of them — `prediction` and `mitigations` — have no entry in the client's `PAGE_LABELS`, so they render as blank rows on the Access tab (D16) |
| **Student accounts** — own token kind, router allowlist | `src/auth.js`, `routes/student.js` | ✅ |
| **Applicant accounts** — own token kind, router allowlist | `src/auth.js`, `routes/applicant.js` | ✅ |
| ~~**Platform operators** — separate tier entirely~~ | ~~`src/platformAuth.js`~~ | **Removed 30 Aug 2026** with multi-tenancy (§2). Three identity kinds remain: staff, student, applicant |
| **Audit trail** | `src/audit.js`, `routes/audit.js` | ✅ Secret-redacting, append-only over the API (no write route exists), read behind a page grant. Not a grantable page itself — derived |
| Push notifications (FCM HTTP v1) | `src/push.js`, `routes/devices.js` | ✅ transport verified Jul 2026; needs a Firebase project to deliver |
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
| **Assessments / gradebook** | `/api/assessments` | ✅ Bulk mark entry (max 500 rows), D/M/P/F at 70/60/50. Refuses a `maxMarks` cut below an awarded mark. Manual marks stamped `source:"manual"` so a Moodle sync cannot revert them |
| **Timetable** | `/api/timetable` | ✅ Per course/year/term, autofilled from generated registers, then published |
| **Student Reviews** | `/api/student-reviews` | ✅ Any lecturer may record and list their own; listing everyone's needs the page grant |
| **PAT** (Personal Academic Tutor) | `/api/interactions` | ✅ Nine interaction types, follow-up tracking, CSV export, and a **branded** email to the student on creation. The mount name still does not match the feature name |
| **Student portal** | `/api/student` | ✅ Own attendance, grades, timetable, reviews and queries. Every query keyed on `req.user.id`; no id parameter exists |
| **Student queries** | `/api/student-queries` | ✅ Two states (open/answered). No threading, no close/reopen, and **still no notification to the student on reply** — `routes/studentQueries.js` contains no notify or email call at all |
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
| **Per-college settings** | `AttendanceTapConfig`, `attendanceTapSettings.js` (pure) + `attendanceTapConfig.js` (resolver) | The `attendanceBandConfig` shape again: defaults in code, one JSON column merged over them, no row until a college edits something, an allowlist on the way out, a 30 s cache invalidated on save. Five settings — `enabled`, `lateAfterMins` (15), `earlyGraceMins` (0), `armSeconds` (60), `staffTapEnabled` (true) — capped at 120 minutes and 600 seconds, because a typo of 600 in the grace field is not a setting, it is an outage in the attendance record. `PUT /tags/settings` is a **patch**, so switching the feature on does not silently reset a threshold somebody tuned last term, and the switch itself is audited on its own |
| **The student's tap** | `GET /api/student/me/tap-context`, `POST /api/student/me/tap-check-in` | Inside the student router allowlist and keyed on `req.user.id`; no id parameter exists. Candidates are built from `Enrolment`, so a tap cannot attach a student to a unit they were never on. Rate limited 10 per minute per student — in-process, like the other six limiters (§6). Writing a mark flags the student's progression score stale but deliberately does **not** rescore: a check-in must not wait on arithmetic |
| **The staff tap** | `POST /api/checkins/tap-check-in` | `site` is not accepted and not asked for. Somebody who touched a sticker in the building cannot be working online — the tap is what proves they are here — so recording anything but `Onsite` would store a claim the tap itself disproves. This is the first time a staff clock-in has meant "was in the building" rather than "said so"; `POST /check-in`, which records one from anywhere, still exists and still takes a site |
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
in the same period, so the arithmetic does not simply give 23. Read from each file's own
header:

| Suite | Covers |
|---|---|
| `smoke-branding` | That a college which has configured **nothing** receives nothing belonging to anybody else. Mostly negative assertions — the defect it guards is a student getting an offer letter from the wrong institution |
| `smoke-attendance-bands` | Each college's own attendance thresholds, and which of them send a letter. Mostly about what a bad ladder does to a student: a gap swallows them silently, an overlap makes their letter depend on array order, a ladder short of 0% or 100% loses the two students it matters most not to lose. Also pins that an unconfigured college still gets exactly the six built-in bands |
| `smoke-admissions` | The pipeline holding the most dangerous data in the product — DOB, NI number, ID numbers, criminal-conviction and medical declarations, ethnicity, religion — with three of its six routers public. Almost all negative: who is refused, what never leaves the building, which decisions cannot be made twice |
| `smoke-applicant` | The one surface a stranger may create an account on. Can that account become anything other than an applicant? Reach a second applicant's application? Overwrite a decision the college recorded? Does an upload with no storage configured degrade honestly, or swallow a document and claim it was filed? |
| `smoke-assessments` | The gradebook. Admin-only; marks outside range, non-integers, duplicate students and non-enrolled students all rejected; `maxMarks` cannot be cut below an awarded mark (which would inflate every derived percentage at once); D/M/P/F really at 70/60/50; re-saving is idempotent, because the grade screen resubmits the whole unit on every save |
| `smoke-hnd` | Registers — the most-audited number the product holds (UKVI, funding body, a student disputing an absence). Builds its own course, cohort, terms, units and students, tries what must not work, and removes everything it made |
| `smoke-studentportal` | Two things at once: a student session reaches nothing but `/api/student`, and inside it sees only their own row. Also pins the attendance and band arithmetic a college defends at an appeal |
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
| D16 | low | **Two grantable pages have no label on the screen that grants them.** `PAGE_LABELS` in `StaffHub.jsx` has 29 entries against `ADMIN_PAGES`' 31; `prediction` and `mitigations` are missing, so the Access tab renders them as a checkbox with no words beside it. The two `ADMIN_PAGES` copies *are* in sync — this is a third hand-maintained list in the same file that nothing checks. Predates the NFC work; `live-attendance` and `attendance-tags` were both labelled when they were added |
| T5b | medium | Three EdTech literals in `StaffHub.jsx` (above). Less severe than it was — the deployment's one college now sees the supplier's address rather than another customer's — but still text nobody can edit |
| ~~D17~~ | — | **FIXED 30 Aug, same day it was filed.** `server/create-admin.js` imported `runInTenant` and `crossTenant` from `src/db`, which exports neither, so the documented way to create or recover the first administrator threw on require. It no longer resolves an institution at all — there is one — and `Staff.email` is a plain unique again. Not covered by any suite, so this is code-read and `node --check`, not a demonstrated run |
| ~~D18~~ | — | **RESOLVED 30 Aug by deletion.** `src/usage.js` had no caller once the platform dashboard went. It was deleted rather than kept against a Settings screen that does not exist; the tenant-aware original is in git history at the commit before the removal, and the de-tenanted rewrite in that commit's parent working tree was not kept |
| D19 | low | **`sharepoint.forgetCached()` has no caller.** The old `forgetTenant(tenantId)` was called when a college saved its SharePoint credentials; the de-tenanted replacement is not called by anything. The three id caches have no TTL, so an administrator who corrects a wrong site address waits for a restart. Its own doc comment says as much — it is not dead code, it is uncalled code |
| ~~T8b~~ | — | ~~`seed-admissions.js` on a bare client; five tools fail closed~~ — **dissolved 30 Aug**, see §2 |
| ~~T9~~ | — | ~~Deployment config predates tenancy~~ — **resolved 25 Aug 2026**; its `DEFAULT_TENANT_SLUG` / `TENANT_BASE_DOMAIN` entries now name variables nothing in `server/src` reads |
| 6 | low | `GET /student-reviews/roster` is open to any authenticated staff member with no page gate — a documented widening (a `pat`-only admin cannot call `/hnd/students`), and still the broadest read surface in that area |
| 7 | low | `admissionDocs.js` says its document-type list is duplicated in `client/src/StaffHub.jsx` and must be kept in sync by hand |
| 5 | — | "Personal template" documents (`scope:"personal"` with no assignee) are invisible to everyone. Still needs a product decision |

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
