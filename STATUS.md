# Staff Hub — What's Built & What's Working

*Reviewed 23 Aug 2026 (evening) against `main` at `7856ea0`.*

This is the "what actually exists" companion to `README.md` (setup) and `API.md`
(endpoint reference). Read this first if you want to know where the project stands.

## How this was checked — and what that does and does not prove

This revision was produced by **reading the code**: every route mounted in
`server/src/index.js`, the Prisma schema and its migrations, `server/src/db.js`,
`tenant.js`, `integrationConfig.js`, `branding.js`, `docTemplate.js`,
`emailTemplate.js`, `email.js`, `usage.js`, `audit.js`, the schedulers, the test
runner and the header of all 21 suites, `scripts/README.md`, `API.md`, `render.yaml`,
`server/.env.example`, and the client's routing, `api.js` and the platform dashboard.

**Nothing here was re-verified by running the API.** `npm test` was deliberately not
run: `server/.env` on this machine points at a **live staging database**, and the
suites create, mutate and delete real rows. The last live verification run was 21 Jul
2026 and is now archaeology. Where a claim rests on code reading alone — which is all
of them — it is a statement about what the code says it does, not a demonstration that
it works. The honest way to close that gap is `npm test` against a scratch database
plus a manual pass over the feature areas the suites still do not reach (§5).

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

It is no longer a staff attendance app. It is a multi-tenant college management
platform with a supplier-facing operator tier above it, and the July 2026 description
of it — SQLite, 8 route files, ~50 endpoints — understated it by roughly a factor of
five.

| | July 2026 | This morning | Now |
|---|---|---|---|
| Database | SQLite file | PostgreSQL | **PostgreSQL** |
| Schema changes | `prisma db push` | `prisma migrate deploy` | **`migrate deploy`, 9 migrations** |
| Route modules | 8 | 33 | **38** |
| Endpoints | ~50 | 212 | **242** |
| Prisma models | ~20 | 39 | **44** |
| Admin dashboard pages | 10 | 28 | **28**, 27 individually grantable |
| Account kinds | staff | staff, student, applicant, operator | **same four** |
| Institutions | one | many, one database | **many, each with its own identity** |
| Tests | 5 suites, by hand | 10 suites, CI | **21 suites**, CI |

Counted, not quoted: `ls server/src/routes/*.js` → 38; `router.<method>(` across those
files → 242; `^model ` in `schema.prisma` → 44; `ls scripts/smoke-*.mjs` → 21 at the
time of reading, and 22 by the end of it — see the note at the foot of §5.

```
edtech-hub/
├── server/   Express + Prisma + PostgreSQL API  (38 route modules, 242 endpoints)
├── client/   React 18 + Vite SPA                (staff app, admin dashboard,
│                                                 student + applicant portals,
│                                                 college registration,
│                                                 Super Admin platform dashboard)
└── scripts/  setup, the test runner + 21 suites, load test, screenshots
```

**Architecture in one line:** React (Vite) SPA → REST/JSON over `fetch` (sending
`X-Tenant`) → Express with JWT + RBAC → tenant middleware → Prisma (isolation
extension) → PostgreSQL.

---

## 2. Multi-tenancy — the load-bearing change, now mostly finished

This is the part a prospective customer's IT team will ask about, so it is worth being
precise about what is and is not done.

### Done

| Piece | Where | Notes |
|---|---|---|
| `Tenant` model; `tenantId` on all 42 other tables | `server/prisma/schema.prisma` | Only `Tenant` and `PlatformAdmin` are exempt |
| **Isolation enforced centrally** in the Prisma client extension | `server/src/db.js` | Filters, stamps, and **throws** on a query with no tenant context. A new route is isolated without its author doing anything |
| `crossTenant()` / `runInTenant()` escape hatches | `server/src/db.js` | Deliberately conspicuous, so cross-institution reads show up in a diff |
| Per-request resolution: `X-Tenant` → subdomain → `DEFAULT_TENANT_SLUG` → `default` | `server/src/tenant.js` | Runs **before** auth, because `Staff.email` is unique per tenant now |
| Unknown tenant → 404 without confirming existence; suspended → 403 | `server/src/tenant.js` | Deliberately not "tenant x does not exist" |
| Sessions bound to their institution (`tid` claim checked) | `server/src/auth.js` | A valid token from college A is refused against college B |
| **The client sends `X-Tenant`** | `client/src/api.js` | `?tenant=slug` → remembered choice → `VITE_TENANT`. Deliberately *not* sent when the host already carries the tenant as a subdomain, so a stale remembered slug cannot override the hostname |
| Data-safe tenancy migration (nullable → backfill → enforce) | `migrations/20260823120000_multi_tenancy` | Prisma's generated version would have failed on any non-empty database |
| Platform-admin tier, separate from `Staff.isSuperAdmin` | `src/platformAuth.js`, `routes/platform.js` | Own token kind, own 8h expiry, mounted above the tenant middleware |
| Per-institution **Moodle, SharePoint and email** credentials, AES-256-GCM at rest | `TenantIntegration`, `src/secrets.js`, `routes/integrations.js` | Secret never returned to any client — only a hint and change metadata |
| **Env fallback scoped to one tenant** | `src/integrationConfig.js` | Only the tenant named by `DEFAULT_TENANT_SLUG` may inherit the host's settings. Every other college resolves to *not configured*, which fails safe rather than sending mail as somebody else |
| **Per-tenant token/site/drive caches** in SharePoint | `src/sharepoint.js:126` onwards | `tokenCache`, `siteIdCache`, `driveIdCache`, `rootFolderIdCache` are all `Map`s keyed by `tenantKey()`, with `forgetTenant()` to evict |
| **Per-tenant branding, letters and email wording** | `TenantBranding`, `TenantDocTemplate`, `TenantEmailTemplate` | See §3.6 |
| Schedulers fan out per tenant | `server/src/eachTenant.js` | One college's failure is logged and stepped over |
| **An isolation test suite** | `scripts/smoke-tenant-isolation.mjs` | Builds two colliding institutions and attacks one from the other over real HTTP |

### Not done, or done only partly

| # | Item | Detail |
|---|---|---|
| T5b | **Three literals of EdTech's identity survive in the client** | `client/src/StaffHub.jsx:2068` and `:12337` render "EdTech · 42 The Burroughs, London NW4 4AP · 020 8202 2007" in the staff app's App-info card and the admin console's identity card; `:11622` hard-codes the same address in the Admissions help text. The server side is clean — `grep Burroughs server/src` finds only the comment in `branding.js` explaining why it used to be there. A second college sees another college's address on two screens. |
| T6b | **Operators can be created and switched off, but not reset** | `POST /platform/admins` and `PUT /platform/admins/:id/active` exist, with guards against deactivating yourself or the last operator. There is still no password reset for an operator and no self-service bootstrap — `create-platform-admin.js` on the server command line is the only way to make the first one, and `PlatformDashboard.jsx:552` says so on screen. Deletion is deliberately absent, and the reasoning is written into `routes/platform.js:435`. |
| T8b | **One script still bypasses isolation** | `server/prisma/seed-admissions.js` constructs a bare `PrismaClient`, so it would write unscoped or fail the NOT NULL constraint. `create-admin.js`, `prisma/seed.js` and 6 of the 12 files in `server/tools/` now use the extended client; of those 6, only `seed-demo.js` wraps its work in `runInTenant`, so the other five (`audit-courses.js`, `delete-seeded-courses.js`, the three `moodle-attendance-*` ones) will **throw** rather than write unscoped. That is failing closed, which is the right failure, but it means those tools do not currently run. The remaining 6 tools never touch Prisma. |
| ~~T9~~ | ~~Deployment config predates tenancy~~ | **RESOLVED 25 Aug 2026.** `render.yaml` now declares `CREDENTIALS_KEY`, `DEFAULT_TENANT_SLUG` and `TENANT_BASE_DOMAIN` with the reason each exists, states `branch: production` explicitly rather than inheriting the repo default (this repo has two deploy branches, so the default is the last thing that should be decided by accident), and says plainly that the host-level `MOODLE_*` / `SMTP_*` values now serve exactly one college. `DEPLOY.md` gains a troubleshooting section for the two ways an API deploy fails silently. |

**T1, T2, T3, T4 and T7 are resolved.** See §6 for what was checked in each case.

---

## 3. What is implemented — feature by feature

Status here means: the code exists, is mounted, is guarded, and has a client surface.
Unless a row says otherwise, it has **not** been re-verified by running it.

### 3.1 Accounts, authentication and access — substantially complete

| Feature | Where | Status |
|---|---|---|
| Landing screen with four tiles, including **Super Admin** | `client/src/Landing.jsx` | ✅ |
| Self-service sign-up → admin approval → account created | `routes/signup.js` | ✅ |
| TOTP two-step verification (RFC 6238, hand-rolled) | `src/totp.js`, `client/src/TwoFactor.jsx` | ✅ built — but **not mandatory**, see D2 |
| Admin reset of a lost authenticator | `routes/staff.js` | ✅ |
| Forgotten password — hashed, single-use, 30 min, 2FA-gated | `routes/auth.js`, `client/src/ResetPassword.jsx` | ✅ |
| Session revocation via `tokenVersion` | `src/auth.js` | ✅ |
| Invited accounts — unusable until activated | `src/invite.js`, `client/src/AcceptInvite.jsx` | ✅ |
| Self-service account deletion (store requirement) | `routes/auth.js`, `client/src/DeleteAccount.jsx` | ✅ |
| Login rate limiting (8 per IP+email / 15 min) | `routes/auth.js` | ✅ in-process only |
| **Platform login rate limiting** (5 per IP+email / 15 min → 30 min lock, plus an address-independent account floor) | `routes/platform.js:61–91` | ✅ in-process only |
| **2FA on the platform login** | `routes/platform.js:128–275` | ✅ Challenge/verify split; `/2fa/setup`, `/enable`, `/disable`; disabling bumps `tokenVersion` |
| **Per-page admin access + Super Admin** | `src/auth.js` (`requirePage`), `AdminAccess` tab | ✅ 27 grantable pages |
| **Student accounts** — own token kind, router allowlist | `src/auth.js`, `routes/student.js` | ✅ |
| **Applicant accounts** — own token kind, router allowlist | `src/auth.js`, `routes/applicant.js` | ✅ |
| **Platform operators** — separate tier entirely | `src/platformAuth.js` | ✅ |
| **Audit trail** | `src/audit.js`, `routes/audit.js` | ✅ Secret-redacting, append-only over the API (no write route exists), read behind a page grant. Not a grantable page itself — derived |
| Push notifications (FCM HTTP v1) | `src/push.js`, `routes/devices.js` | ✅ transport verified Jul 2026; needs a Firebase project to deliver |
| Biometric app lock | `client/src/biometric.js` | ✅ native only; needs a physical device to test |

### 3.2 Staff and HR

| Feature | Mount | Notes |
|---|---|---|
| Check-in / out, daily summaries | `/api/checkins` | ✅ |
| Leave requests, approvals, allowance enforcement | `/api/leave`, `/api/adjustments` | ✅ Allowance checked server-side at approval, serialised per staff member; sick leave exempt; a decided request cannot be re-decided (409) |
| Documents, shared and personally assigned | `/api/documents` | ✅ Files live in SharePoint, falling back to a private Supabase bucket with 300s signed URLs |
| **Timesheets** | `/api/timesheets` | ✅ Log dated sessions, submit a month, admin approves or bounces back. Self-approval blocked. Admins can edit a locked entry — now visible in the audit log rather than untraceable |
| **Staff Reviews** (4 form types) | `/api/staff-reviews` | ✅ Reads are page-gated too — the content is candid commentary about a named colleague |
| **My Reviews** (self-service) | `/api/my-reviews` | ✅ Scoped by token identity. Submitting locks the form (409 on edit) |
| **KPIs / Executive Dashboard** | `/api/assessments/exec-summary` + client | ✅ |

### 3.3 Students and teaching

| Feature | Mount | Notes |
|---|---|---|
| HND attendance registers, semesters | `/api/hnd` | ✅ The largest single module (37 endpoints). P=2, L=1, E=1, A=0; unmarked sessions excluded |
| **Assessments / gradebook** | `/api/assessments` | ✅ Bulk mark entry (max 500 rows), D/M/P/F at 70/60/50. Refuses a `maxMarks` cut below an awarded mark. Manual marks stamped `source:"manual"` so a Moodle sync cannot revert them |
| **Timetable** | `/api/timetable` | ✅ Per course/year/term, autofilled from generated registers, then published |
| **Student Reviews** | `/api/student-reviews` | ✅ Any lecturer may record and list their own; listing everyone's needs the page grant |
| **PAT** (Personal Academic Tutor) | `/api/interactions` | ✅ Nine interaction types, follow-up tracking, CSV export, and a **branded** email to the student on creation. The mount name still does not match the feature name |
| **Student portal** | `/api/student` | ✅ Own attendance, grades, timetable, reviews and queries. Every query keyed on `req.user.id`; no id parameter exists |
| **Student queries** | `/api/student-queries` | ✅ Two states (open/answered). No threading, no close/reopen, and **still no notification to the student on reply** — `routes/studentQueries.js` contains no notify or email call at all |
| **Attendance Emails** | `/api/attendance-emails` | ⚠️ Built and complete, but the automation still ships switched off (`autoEnabled` defaults false) and the default template contact details ship blank for an admin to fill |
| **Moodle / VLE sync** | `/api/moodle` | ✅ One-way and non-destructive, with a dry-run preview. Unit matching is heuristic by design. Now reads the institution's own URL, token and auto-sync switch |
| **Predictive Analysis** (progression risk) | `/api/prediction` | ✅ Added 25 Aug 2026. Seven weighted components → a 0–100 progression score → R1–R5, with four override rules on top. Per-college weights, bands and thresholds (`PredictionModelSettings`), an append-only history, and an intervention record. Behind the new `prediction` page grant, so it is inert until a college grants it. **Nothing runs on a schedule and no student is ever emailed.** See §3.8 |

### 3.4 Admissions

| Feature | Mount | Notes |
|---|---|---|
| Application record, documents, interviews, offers, enrolment | `/api/admissions` | ✅ With SharePoint filing and a per-college branded email at each step. External steps are best-effort and return a `warning` rather than failing |
| Course / intake dropdown lists | `/api/admission-config` | ✅ Deliberately separate from the Moodle-synced `Course` table. Both routes now serialise through an allowlist |
| Application form and offer letter PDFs | `/api/admission-pdf` | ✅ pdfkit for the built-in layout; **pdf-lib over the college's own PDF when one is uploaded** (§3.6) |
| Public application form | `/api/admission-apply` | ⚠️ Open by design. A honeypot field is **still the only** anti-abuse measure — no rate limit, no CAPTCHA, no email verification on a public write endpoint. Compare `routes/registrations.js`, which added a limiter for exactly this shape of endpoint |
| Token-link document upload | `/api/admission-uploads` | ⚠️ Hashed 30-day token; everything normalised to PDF. The body cap is `sharepoint.MAX_BYTES` = 15 MB but `storage.MAX_BYTES` (the Supabase fallback) is 10 MB, so on a deployment without SharePoint a 12 MB file is still accepted then rejected downstream |
| Token-link offer acceptance | `/api/admission-offers` | ⚠️ Idempotent. `src/offerLetter.js:224` still tells the applicant to accept **by replying to the email**, contradicting the one-click link — and it is now in a letter a college may have replaced with its own |
| **Applicant portal** | `/api/applicant` | ✅ Register, edit a draft, submit, upload, see the interview invite and outcome, accept, download PDFs |
| **ISM** (Intention to Study Meeting) | `/api/ism` | ✅ Mirrors its "Admitted?" answer onto `Admission.ismOutcome` |
| **SLC** (Student Loans Company tracker) | `/api/slc` | ✅ Flat tracker. `admissionId` is an unenforced string with no reader |

### 3.5 What landed on 23 Aug 2026 — the Super Admin surface

Thirty-eight commits landed today; the last eleven are what this section and §3.6
describe. None of it appeared in the previous edition of this file.

| Piece | Where | What it does |
|---|---|---|
| **Its own tile** | `client/src/Landing.jsx:102` | "Super Admin — Platform operators only", visually apart from the three college tiles, with a line under it saying it is not a college sign-in. `?platform` still reaches the same component |
| **A menu-driven dashboard, black and white** | `client/src/PlatformDashboard.jsx` (1,374 lines) | Six sections behind one menu — Institutions, Registrations, Storage & usage, Operators, Server configuration, My security. The monochrome is deliberate and the reasoning is in the file header: a college can now pick its own colours, so "a different colour" no longer distinguishes the supplier's screen from a customer's. Nobody brands themselves in pure black and white |
| **Storage & usage per college** | `GET /platform/usage`, `src/usage.js` | Apportioned, not measured: per table, real on-disk size (heap + indexes + TOAST) ÷ row count × that tenant's rows. Labelled *estimated* wherever it appears, because it will end up on an invoice. File storage is **not** an estimate — those bytes are recorded on the document rows and summed directly, and reported separately |
| **Operator management** | `GET/POST /platform/admins`, `PUT /platform/admins/:id/active` | List, create, deactivate, restore. Two guards: never yourself, never the last active operator. Deactivate rather than delete, so the audit trail keeps a name attached to it |
| **Server-configuration health** | `GET /platform/health` | Answers "is this host actually set up?" — credential storage, email, file storage, SharePoint, tenant resolution. `CREDENTIALS_KEY` is **round-tripped**, not merely checked for presence, because a truncated paste parses as "set" right up until the first college tries to save a credential |
| **2FA on the platform login** | `POST /platform/login`, `/login/verify`, `/2fa/*` | Password alone yields a challenge token, never a session, once an authenticator is enrolled. Offered rather than forced — forcing it would lock out an operator with no way back |
| **"Restore access"** | `GET /platform/tenants/:id/admins`, `PUT …/admins/:staffId/password` | Resets a college administrator's password when the college has locked itself out. Deliberately awkward: administrators only (not the whole staff list), the operator must re-enter **their own** password, the new password is one-time (`mustChangePassword`), `tokenVersion` is bumped, and it is written to **the college's own audit log** so the institution can see that its supplier did it |

### 3.6 What landed on 23 Aug 2026 — each college's own identity

| Piece | Where | What it does |
|---|---|---|
| **Branding** | `TenantBranding`, `src/branding.js`, `routes/branding.js`, `client/src/BrandingSettings.jsx`, `client/src/branding.js` | Names (display, short, two-line wordmark), primary and accent colours, a logo as a data URI (≤256 KB, PNG/JPEG/SVG/WebP/GIF), address lines, contact email and phone, website, legal footer, signatory name and title. The server resolves *saved → env → neutral default* and always returns a complete object, so no caller handles a missing field. The client turns the two colours into CSS custom properties set once on `:root` — `NAVY` is now the string `var(--brand-primary)`, which is why nineteen files needed no change. `GET /api/branding` is public, because the login screen needs it before anyone is authenticated. **The fallbacks belong to nobody** (slate grey): the first version defaulted to EdTech's real identity, which just moved the hardcoding one level down |
| **Document templates** | `TenantDocTemplate`, `src/docTemplate.js`, `routes/doc-templates`, `client/src/TemplateEditor.jsx` | A college uploads its **own** offer letter or application form as a PDF and drags field chips onto it. `pdf-lib` loads that PDF and writes on top of it — **it never redraws the page**, and the file header argues the point: recreating a design cannot be exact (font substitution, kerning, a resampled crest), and *nearly* their letterhead is worse than obviously not it. Positions are stored as a **percentage** of page width and height, so a template re-exported at a different paper size still lands the name in the right place. The field list is defined once in `docTemplate.js` and is also what the editor offers, so the two cannot drift. `/api/doc-templates` gets its own 8 MB body cap; the global one is 1 MB |
| **Email wording** | `TenantEmailTemplate`, `src/emailTemplate.js`, `routes/email-templates`, `client/src/DocumentSettings.jsx` | Editable subject and body per email kind, with `{{placeholders}}`. Substituted, never evaluated — no expressions, no logic — because this is customer-authored text rendered and sent under that customer's name. Bodies are **escaped**, not trusted. Unrecognised placeholders are left alone rather than guessed at. One email (the enrolment congratulations) deliberately has no template and takes only its identity from branding |
| **Per-tenant email configuration** | `src/email.js`, `integrationConfig.js` (`PROVIDERS.email`), `client/src/IntegrationSettings.jsx` | Email now sits alongside Moodle and SharePoint as a third per-tenant integration: provider, host, port, secure, user, from-name, from-address, with the SMTP password (or Resend key) encrypted at rest. `FROM` is resolved **per send**, not once at require time — it was a module-level constant, which meant whichever college the server was configured for became the sender for every other one. The last-resort address is deliberately undeliverable: a bounce nobody owns is a better failure than a letter signed by the wrong institution |
| **College registration** | `CollegeRegistration` model, `routes/registrations.js`, `client/src/CollegeRegistration.jsx` | A public apply/activate flow, mounted **above** the tenant middleware because an applicant is not yet an institution. Two decisions by two different people are required: an operator approves and issues an access code, and the applicant redeems it. The code is stored **hashed**, like a password-reset token, with only its last four characters readable so an operator can identify it over the phone. The public submit route is rate limited (5/hour/IP) with a size-triggered sweep. Four statuses — pending, approved, activated, rejected — and a rejection is kept rather than deleted so a resubmission has history |
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

**Verification status.** Demonstrated on 26 Aug 2026:

| | |
|---|---|
| 237 unit tests | pass — the whole server, no database |
| 63 tripwire tests | pass; **13 mutants** introduced and each caught by the intended test |
| Client | **builds**; no test framework exists, so that is the whole claim |
| Migrations | **three written, none applied.** `server/.env` points at the live database |
| Smoke suites | **not run** — they need a live API and database |

Two bugs found in this work and fixed: `OUTCOMES` collided with the existing
intervention-review vocabulary on both server and client, and the first fix silently
repointed the intervention review at the wrong allowlist. Neither was caught by a test —
the review route has none.

**What it still does not do.** No VLE engagement (the connectors carry grades and
submissions only), no equity or algorithmic-governance surface, no safeguarding
triggers, and nothing on a schedule. Roughly 37 of the 138 catalogued signals are
implemented or unblocked; 7 are provably impossible without upstream data-quality
fixes — `idDateOfExpiry` has no format validation, follow-ups have no completion field,
and `SentNotification` is a dedupe ledger that never records an attendance letter.

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

### 3.7 Business rules that are actually enforced

- Leave allowance is checked **server-side at approval**, inside a per-staff lock, with
  a conditional update on `status:"pending"`. Pending requests do not consume allowance.
- Sick leave is exempt from allowance, on both client and server.
- A decided leave request cannot be re-decided (409).
- Balance adjustments must be non-zero whole numbers, range-bound to fit a 32-bit Int.
  So must `sortOrder` on admission courses and intakes, and `approxStaff` /
  `approxStudents` on a college registration — the same class of defect, closed in the
  same way, each time.
- A summary saved for a day you didn't attend does not fabricate a check-in time.
- Timesheet self-approval is refused (403).
- An assessment's `maxMarks` cannot be cut below a mark already awarded (409).
- Semester date ranges cannot overlap, so every session belongs to exactly one.
- The last remaining administrator cannot delete their own account, and the last active
  platform operator cannot be deactivated.
- No operator can deactivate their own operator account.

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
sweep across the current surface — which is now 242 endpoints, four identity tiers and
a supplier-facing dashboard — is outstanding and is a much larger job than it was in
July.

---

## 5. Testing and CI

`npm test` (`scripts/test.mjs`) applies migrations, seeds fixtures, boots its own API
on port 4010, discovers every `smoke-*.mjs` in `scripts/`, runs them, and exits
non-zero if any failed. `.github/workflows/ci.yml` runs it on every push and PR against
a throwaway Postgres container, builds the client first (so a broken import fails
before the tests start), and runs `npm audit` advisory-only.

**21 suites, up from 10.** Eleven landed today. Read from each file's own header:

| Suite | Covers |
|---|---|
| `smoke-tenant-isolation` | **One customer cannot reach another's data.** Two deliberately colliding institutions — same admin email at both — attacked from A against B over real HTTP. Every attempt must fail |
| `smoke-platform` | The tier above every customer. Deliberately lopsided towards refusals: a college admin reaching the platform, a password alone once 2FA is enrolled, a challenge token passing as a session, a revoked operator's tab still working, a deletion without the typed confirmation, the platform locking itself out of its last account |
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
| `smoke-security-d5-d9-t6` | The three defects fixed on 23 Aug stay fixed. Writes — creates a throwaway applicant and two throwaway operators, removes all three |
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

**What still has no automated coverage** — checked by grepping every suite for each
mount, not assumed: `/api/ism`, `/api/slc`, `/api/interactions` (PAT),
`/api/attendance-emails`, `/api/moodle`, `/api/doc-templates`, and the client.
`/api/timetable` is reached only indirectly, through `/student/me/timetable` in
`smoke-studentportal`; `/api/email-templates` only through the four placeholder and
escaping checks in `smoke-branding`. Neither router is covered on its own terms.
There is still no unit or component test framework and no client-side tests.

**The whole suite was run on 25 Aug 2026 and passed: 24 passed, 0 failed, 1 skipped**
— every smoke suite plus the unit tests, including `smoke-prediction.mjs` on its first
ever execution. That run is also what makes the rest of this file's claims about the
prediction HTTP surface demonstrations rather than code-reading.

**How, given there is no local Postgres or Docker and `server/.env` points at the live
database.** Not by pointing the suite at it. `assertDisposable` *would* have allowed
that — `edtech_staging` matches its disposable-name rule — which is worth knowing,
because it means a plain `npm test` on this machine seeds over live data and the guard
does not stop you.

Instead the suite ran in an isolated **Postgres schema** in the same database:

```bash
DATABASE_URL="postgresql://…/edtech_staging?schema=smoketest" npm test
```

Prisma scopes everything to the named schema, `_prisma_migrations` included, so
`migrate deploy` built all 51 tables there from nothing — which independently proves
the migration chain applies cleanly from scratch, the thing CI does on every push.
Row counts in `public` were snapshotted before and compared after: **zero drift**. The
schema was then dropped.

This is the pattern to reuse on any machine with no scratch database. It is not a
substitute for CI — same server, same connection limits — but it is a great deal
better than not running them.

**A 22nd suite, `scripts/smoke-registrations.mjs`, was written while this review was
in progress** and is not counted above or described in the table — it appeared in
`scripts/` after the headers were read, and this pass has not read it.

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

| # | Previous claim | Verified state |
|---|---|---|
| D1 | `server/create-admin.js` broken by tenancy | **Fixed.** Uses the extended client from `src/db`, resolves the tenant by `TENANT_SLUG` / `DEFAULT_TENANT_SLUG` through `crossTenant`, and does its work inside `runInTenant` so the create is stamped. `upsert({ where: { email } })` was replaced by `findFirst` + create/update, because `@@unique([tenantId, email])` means `email` is no longer a unique selector. It also refuses the passwords this project used to ship, and clears TOTP so a lost authenticator is recoverable |
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
| T7 | `lastTestedAt` / `lastTestOk` / `lastTestNote` are dead columns | **Fixed.** `POST /api/integrations/:provider/test` runs a read-only connection check and writes all three; `IntegrationSettings.jsx:244` is the button; the platform dashboard's health indicator reads the result |
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
MCP connection available in that session was authenticated to a **different** account
(LBC and one unrelated project), not EdTech's. Run the `SELECT` above against production
before assuming it deployed.

### Open defects

| # | Severity | Item |
|---|---|---|
| D2 | **high** | Mandatory 2FA is off (above). A decision, not an oversight — but an undecided one |
| D12 | medium | **`/api/admission-apply` is a public, unauthenticated write with only a honeypot.** `routes/registrations.js` added a limiter to a structurally identical endpoint the same day; this one did not get the same treatment. It writes special-category personal data |
| D13 | medium | **The upload cap disagrees with itself.** `sharepoint.MAX_BYTES` is 15 MB and `storage.MAX_BYTES` is 10 MB; `routes/admissionsUpload.js:58` and `routes/applicant.js:250` both use the SharePoint figure as the body limit. On a deployment using the Supabase fallback, a 12 MB file is accepted and then rejected downstream |
| D14 | medium | **The offer letter contradicts the accept link.** `src/offerLetter.js:224` prints "reply to the email containing this offer" while `/api/admission-offers` is a one-click acceptance. Now worse than before: a college may have replaced the letter with its own via `TenantDocTemplate`, in which case the built-in text and the college's text can say different things about the same offer |
| D15 | medium | **A student is never told their query was answered.** `routes/studentQueries.js` contains no notification or email call of any kind. The answer sits in the portal until they happen to look |
| T5b | medium | Three EdTech literals in `StaffHub.jsx` (above) |
| T8b | low | `seed-admissions.js` on a bare client; five tools now fail closed rather than running |
| ~~T9~~ | — | ~~Deployment config predates tenancy~~ — **resolved 25 Aug 2026** |
| 6 | low | `GET /student-reviews/roster` is open to any authenticated staff member with no page gate — a documented widening (a `pat`-only admin cannot call `/hnd/students`), and still the broadest read surface in that area |
| 7 | low | `admissionDocs.js` says its document-type list is duplicated in `client/src/StaffHub.jsx` and must be kept in sync by hand |
| 5 | — | "Personal template" documents (`scope:"personal"` with no assignee) are invisible to everyone. Still needs a product decision |

### Longer-standing gaps

| # | Item | Notes |
|---|---|---|
| 1 | JWT has revocation but no refresh | `tokenVersion` revokes on reset/change. A shorter expiry plus refresh tokens is still the production-grade answer, and there is no "sign out my other devices" button |
| 2 | Every rate limiter and the leave-decision lock are **in-process** | Module-level `Map`s and promises — now six of them: staff login, TOTP verify, platform login, applicant check-email, registration submit, and the leave lock. Correct for one Node process; a clustered deployment needs Redis and a database-level lock. Each one says so in a comment, which is at least honest, but it is now a systemic property rather than an exception |
| 3 | Client bundle size | 1.22 MB / 313 kB gzipped in July; `StaffHub.jsx` alone is now **12,391 lines**. **Unverified since July** — certainly larger, and today added `pdf-lib` on the server and pdfjs on the client. pdfjs is at least loaded on demand (`TemplateEditor.jsx`), which is the pattern the rest of the client still needs. Nothing else is code-split except the Capacitor plugins |
| 4 | Throughput ceiling | ~110 req/s in July, limited by synchronous bcrypt blocking the event loop. **Unverified since July**; Postgres, the tenant middleware and the audit write all change the picture. See `STRESS-TEST.md` |
| ~~8~~ | ~~SQLite, single file~~ | **RESOLVED** — PostgreSQL, 9 migrations |
| ~~9~~ | ~~Tailwind from the Play CDN~~ | **RESOLVED** — compiled at build time |
| ~~10~~ | ~~"Today" derived in UTC~~ | **RESOLVED** — `src/clock.js` pins `APP_TIMEZONE`; D8 was the last exception and is fixed |
| ~~11~~ | ~~Thin automated coverage, no CI~~ | **Largely resolved** — 21 suites and CI. The list of uncovered areas in §5 is now short enough to read |

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

> ⚠️ **`server/.env` on this machine currently points at a live staging database.**
> `npm test` seeds fixtures and the suites create, mutate and delete real rows. Set
> `DATABASE_URL` to a scratch database on the command line before running it — that is
> why this revision was produced by reading rather than running. `prisma/assertDisposable.js`
> is a backstop, not permission.

> The project sits three folders deep — `Downloads\...\edtech-hub\edtech-hub\edtech-hub`.
> That innermost one is the real root (the one with `package.json`). Still worth
> flattening.

Beware: `npm run setup` **re-seeds**, which clears the demo tables it owns.

---

## 8. Documentation state

| File | State |
|---|---|
| `STATUS.md` | This file. Rewritten 23 Aug 2026 (evening) after the previous edition was found to be listing sixteen fixed defects as open |
| `README.md` | **Partly stale.** Updated earlier on 23 Aug — setup, PostgreSQL, migrations, `npm test`, multi-tenancy, the data model and the API mount map are current. It knows nothing about anything after 17:26 today: branding, document templates, email templates, per-tenant email, college registration, the audit trail, or the Super Admin dashboard. `grep -i` finds no mention of any of them. It still says 27 grantable pages, which is right |
| `scripts/README.md` | **Partly stale.** The runner, the `PASS`/`FAIL`/`SKIP` convention, the throwaway-database warning and the "adding a suite" contract are all accurate and worth keeping. Its suite table lists **9 of the 21** — every suite added today is missing from it. The `smoke-signup-2fa` skip note is still correct |
| `API.md` | **Badly out of date, and further behind than the last estimate.** Counted: it documents **62 endpoints across 10 route modules** — auth (including password reset, activation, 2FA), sign-up, staff, check-ins, leave, adjustments, documents, notifications, devices and HND. That is **26% of the 242 endpoints and 26% of the 38 modules**. Nothing on admissions (6 modules), the applicant portal, the student portal, student queries, assessments, timesheets, timetable, the three review modules, PAT, ISM, SLC, Moodle, attendance emails, integrations, branding, document templates, email templates, audit, registrations, or the platform surface. **The single largest remaining documentation gap**, and it grew today: 30 endpoints were added and none were documented |
| `server/prisma/migrations/README.md` | Accurate. Covers why `db push` was abandoned and the rules for changing the schema |
| `DEPLOY.md`, `render.yaml` | Correct for what they cover, but predate tenancy — see T9 |
| `BUG-AUDIT.md`, `STRESS-TEST.md` | Historic. July 2026 figures, not re-measured |
| `SHAREPOINT_SETUP.md`, `MOBILE.md`, `PRIVACY.md`, `DELETE-ACCOUNT.md`, `SUBMISSION_CHECKLIST.md` | Not reviewed in this pass |

---

## 9. Bottom line

The platform is materially better than it was this morning, and the gap between it and
the previous edition of this document was the most misleading thing in the repo. Of the
24 numbered items that edition listed, **18 were already fixed outright** (D4 was a
duplicate of T2, so 17 distinct defects), 3 are partly fixed, and 3 are still open —
most of them closed within hours of being written down.

What is genuinely left, in order:

1. **Decide D2.** Mandatory 2FA is still off. Every other item from both security
   sweeps is closed; this is the one that is a decision nobody has made rather than
   work nobody has done. Setting `TOTP_ENFORCED = true` also reactivates ~35
   assertions that currently skip.
2. **Rate-limit `/api/admission-apply` (D12).** A public, unauthenticated write that
   stores special-category personal data, guarded by a honeypot. The pattern to copy
   is thirty lines away in `routes/registrations.js`.
3. **Bring `API.md` up to date.** It documents a quarter of the API and fell further
   behind today.
4. **Update `README.md` and `scripts/README.md`** for what landed this evening —
   twelve missing suites and six missing feature areas between them.
5. **Extend coverage** to the timetable, PAT, attendance emails, the Moodle sync,
   templates — the areas §5 still lists as untested. (Registration coverage is being
   written now.)
6. **Fix T9** before a second deployment: `render.yaml` and `DEPLOY.md` do not mention
   `CREDENTIALS_KEY` or `DEFAULT_TENANT_SLUG`, and without the first, no college can
   save any credential at all.
7. **Run a fresh security sweep.** The July one covered 4 of 12 planned areas against
   a much smaller product. Today's fixes closed reported findings; they were not a
   sweep.

Nothing in this file should be read as a claim that the system has been verified end to
end. It has not been run at all in this pass, and *How this was checked* says so on
purpose.
