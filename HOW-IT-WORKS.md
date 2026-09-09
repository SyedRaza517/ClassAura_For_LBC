# How the system actually works

*Written 30 August 2026 by reading the code on `main` at `f65711c`, plus the working
tree (which carries uncommitted NFC/QR work).*

This is the **mechanism** document. It answers "what happens, in what order, and why is
it built that way" — not "what is finished" (that is `STATUS.md`) and not "what is the
shape of every endpoint" (that is `API.md`). Where this document and `STATUS.md`
disagree about completeness, believe `STATUS.md`; where it and a comment in the code
disagree about behaviour, believe the code.

---

## 1. What this is, in one paragraph

A **multi-tenant college management platform**. One deployment — one Express API, one
React SPA, one PostgreSQL database — serves many institutions at once, with a
supplier-facing **platform operator** tier sitting above all of them. Inside a college it
covers staff HR (check-in, leave, timesheets, documents, appraisals), the academic
machine (courses → cohorts → terms → units → sessions → registers → assessments →
grades), admissions from enquiry to enrolment, student finance tracking, pastoral
records, and a progression-risk prediction engine. Four kinds of identity exist and are
enforced separately: **staff**, **student**, **applicant**, **platform operator**.

```
edtech-hub/                       npm workspaces monorepo
├── server/   Express 4 + Prisma 5 + PostgreSQL   (41 route modules, 276 endpoints)
├── client/   React 18 + Vite SPA, wrapped by Capacitor for iOS/Android
└── scripts/  the test runner + 26 HTTP smoke suites, seeds, load test, screenshots
```

**Architecture in one line:**
React SPA (sends `X-Tenant`) → REST/JSON over `fetch` → Express → security headers →
CORS → tenant middleware → JWT auth + RBAC → Prisma client with a tenant-isolation
extension → PostgreSQL.

---

## 2. The lifecycle of a request

`server/src/index.js` is the whole wiring diagram, and the **order is load-bearing**.

1. **`compression()`** — gzip. The big admin lists (1000+ students, whole attendance
   matrices) shrink 80–90% on the wire.
2. **ETags off + `Cache-Control: no-store`** on every response. Together these remove
   the conditional-request/304 path entirely, so a client can never be served stale JSON.
3. **Security headers** — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
   `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`,
   `X-Permitted-Cross-Domain-Policies: none`.
4. **`trust proxy = 1`.** Behind Render every caller shares one `req.ip`, which collapsed
   the login limiter's IP+email key down to email alone — eight wrong guesses could lock
   a real person out, and spraying one guess across many accounts was never limited at
   all. Trusting the first hop restores the caller's own address.
5. **CORS**, restricted to `CORS_ORIGINS` (falling back to `CLIENT_URL`). Requests with
   no `Origin` (curl, health checks, native apps) pass. The Capacitor WebView origins —
   `capacitor://localhost`, `ionic://localhost`, `https://localhost`, `http://localhost`
   — are **always** allowed regardless of configuration; without that iOS is blocked from
   every API call while Android happens to work.
6. **Body limits** — 1 MB by default, with two deliberate exceptions mounted *before* the
   default: `/api/doc-templates` at 8 MB (a college's letterhead PDF) and `/api/branding`
   at 2 MB (a logo as base64).
7. **`GET /api/health`** — mounted here, above everything, so a missing header can never
   take the service down.
8. **`/api/platform` and `/api/registrations`** — mounted **above** the tenant
   middleware. An operator sits above every institution and a prospective customer is not
   yet one; demanding a tenant here would be circular.
9. **`tenantMiddleware`** on `/api` — resolves the institution and runs the *entire
   remainder of the request* inside that tenant's scope.
10. **Every feature router**, each of which applies its own `requireAuth` + page guard.
11. **404 handler**, then the **error handler**, which classifies body-parser failures as
    400/413 (the caller's fault) rather than burying them among genuine 500s.

`wrapAsync` (`asyncRoutes.js`) wraps each router so a rejected promise inside an async
handler reaches the error middleware rather than terminating the process.

On boot the server prints how email, push, file storage and SharePoint are configured —
so a stubbed deployment is visible immediately rather than at the moment somebody waits
for a password-reset email that never arrives. It then starts a **keep-alive** (pinging
its own `/api/health` every 12 minutes, under Render's 15-minute idle window) and three
schedulers.

---

## 3. Multi-tenancy — the load-bearing mechanism

### 3.1 Resolving which college a request is for (`src/tenant.js`)

First match wins:

1. **`X-Tenant` header** — what the web and mobile clients send.
2. **Subdomain**, but **only** under `TENANT_BASE_DOMAIN` (e.g. `brookes.edtech.co.uk`
   → `brookes`). This restriction is not cosmetic: reading the first label of *any*
   hostname broke staging the moment it deployed, because
   `edtech-staging-api.onrender.com` resolved to a tenant called
   `edtech-staging-api`, which does not exist — so every request 404'd before reaching
   the default. Platform hosts, preview URLs and bare service names are not customer
   subdomains, and no denylist of them could ever be complete.
3. **`DEFAULT_TENANT_SLUG`** — single-institution deployments.
4. **`"default"`** — the tenant the tenancy migration adopted every pre-existing row into.

Lookups are cached by slug for 60 s (`TENANT_CACHE_MS`, set to 0 in CI). The stated
consequence: suspending a customer takes up to a minute to bite.

An **unknown** tenant gets `404 Unknown institution` — deliberately not "tenant x does
not exist", which would let anyone probe which institutions use the platform. A
**suspended** one gets 403.

Exempt paths: `/health`, and anything under `/platform` or `/registrations`.

### 3.2 Enforcing it (`src/db.js`)

This is the single most important file in the repo. Isolation is a property of *code*,
not infrastructure — 64 server files import the Prisma client and there are 276 endpoints, so
asking every author to remember a `tenantId` filter "is not a security model, it is a
hope".

So the client itself refuses. A Prisma `$extends` hook intercepts `$allOperations` on
`$allModels`:

| Operation class | Members | What happens |
|---|---|---|
| `FILTERED` | `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `updateMany`, `deleteMany` | `where` is AND-ed with `{ tenantId }` |
| `FILTERED_UNIQUE` | `findUnique`, `findUniqueOrThrow`, `update`, `delete` | `tenantId` merged **flat** into `where` — Prisma requires the unique field at the top level, so AND-wrapping would leave no top-level unique and be rejected outright |
| `STAMPED` | `create`, `createMany`, `createManyAndReturn` | `tenantId` stamped onto `data` |
| `upsert` | | `where` and `create` are scoped/stamped; the `update` payload deliberately is **not**, so an upsert can never move an existing row between tenants |
| anything else | | **throws** — fails closed, so a Prisma upgrade that adds an operation cannot leak through silently |

Only `Tenant` and `PlatformAdmin` are exempt (`UNSCOPED_MODELS`).

Context lives in an `AsyncLocalStorage`, not a threaded parameter — "a broken thread here
is a data leak, not a bug report."

- **A query with no tenant context throws `TenantScopeError`.** Code outside a request
  (schedulers, scripts, tools) must say `runInTenant(tenantId, fn)` or `crossTenant(fn)`.
- **`crossTenant()` is deliberately conspicuous**, so a cross-institution read is always
  visible in a diff.
- `runInTenant` awaits `fn` *inside* the context, because Prisma invokes the extension
  callback asynchronously — otherwise a non-async caller would have the context torn down
  before the query was inspected.

**Raw SQL is NOT covered.** `$queryRaw` is a client-level method that never reaches
`$allModels`. `routes/hnd.js` therefore carries its own `requireTenant()` / `sqlTenant()`
helpers that throw rather than emit a query spanning customers.

### 3.3 Background work (`src/eachTenant.js`)

`forEachTenant(label, fn)` lists active tenants under `crossTenant`, then runs `fn` once
per tenant inside `runInTenant`, **each in its own try/catch**. One college with a broken
Moodle token or an unreachable mailbox must not cancel month-end attendance emails for
every other customer.

### 3.4 Per-tenant configuration — the recurring pattern

Worth matching when adding more:

> platform defaults in code → **one JSON column** per tenant merged over them → **no row**
> until a college edits something → an **allowlist** on the way out → a **short cache**
> invalidated on save.

Reference implementations: `attendanceBandConfig.js`, `prediction/settings.js`,
`attendanceTapConfig.js` + `attendanceTapSettings.js`, `branding.js`.

Why the whole list is one JSON column and not a row per band: a band list is only valid
as a **set** (it must tile 0–100 with no gap and no overlap), so one column means the set
is replaced atomically — a reader sees the old complete list or the new complete list,
never half of either. A row-per-band write window is a window in which a student is
classified against a ladder with a hole in it.

### 3.5 Integration credentials (`integrationConfig.js`, `secrets.js`)

Five providers: `moodle`, `canvas`, `blackboard`, `email`, `sharepoint`. Each stores a
secret (AES-256-GCM encrypted at rest, format `v1.<iv>.<tag>.<ciphertext>` base64url) plus
non-secret settings as JSON.

Resolution order per tenant: **what the college saved** → **`process.env`**. But the env
fallback serves **exactly one tenant** — the one named by `DEFAULT_TENANT_SLUG`. Every
other college resolves to `{}` ("not configured"), which fails safe. This is not
hypothetical: the platform ran for a period with one college emailing as another and
uploading into that other college's SharePoint library, purely because those were the
host's values.

`moodle.js` and `sharepoint.js` read config through **synchronous** accessors deep inside
request handling, so the config is *primed once per request* at each module's choke point
(`moodle.call()`, `sharepoint.getAccessToken()/graphFetch()`) and then `peek()`ed
synchronously. An **unprimed** `peek()` reports "not configured" rather than falling back
to env — falling back there would reintroduce exactly the leak `load()` prevents.

The secret is **never** returned to any client — only `hint()` (last four characters
behind bullets) and change metadata. `CREDENTIALS_KEY` is resolved **per call**, not at
import, so a missing key fails the one request that tries to save a credential rather
than preventing the server from starting.

---

## 4. Identity and access control

### 4.1 Four kinds, four token shapes

All JWTs are signed with one `JWT_SECRET` (which **must** be set in production — no dev
fallback). Every token carries `purpose`, and `requireAuth` rejects anything whose
`purpose` is not `"session"`, so the short-lived two-factor **challenge** token can never
be exchanged for API access.

| Kind | `kind` | Lifetime | Bound to a tenant | Reach |
|---|---|---|---|---|
| Staff | `staff` | `JWT_EXPIRES`, default `1d` | yes (`tid`) | every router, subject to page grants |
| Student | `student` | `1d` | yes | **only** `/api/student` and `/api/auth` |
| Applicant | `applicant` | `1d` | yes | **only** `/api/applicant` and `/api/auth` |
| Platform operator | `platform` | `PLATFORM_JWT_EXPIRES`, default `8h` | **no** | `/api/platform`, `/api/registrations` admin half |

Two structural guards:

- **`tid` is checked against the resolved tenant.** Without it, a token issued by college
  A could be presented against college B just by changing the `X-Tenant` header: the
  signature is valid and the account exists, and every query would then run in B's scope.
  Tokens minted before tenancy carry no `tid` and are still accepted, so upgrading did
  not sign everyone out.
- **`ver` carries the row's `tokenVersion`.** Bumping that column kills every token
  already issued — the revocation a password reset needs.

**`STUDENT_ROUTERS` / `APPLICANT_ROUTERS` are allowlists, not per-route checks.** A router
added tomorrow is closed to students without anyone remembering to close it. This is
called out in `auth.js` as the one line in the file most worth not breaking.

Platform operators are kept in an entirely separate file (`platformAuth.js`) rather than a
boolean on the staff path: "sharing a code path between the two is how 'our support
engineer' and 'a customer's admin' end up one boolean apart." A `PlatformAdmin` is not a
`Staff` row, has no `tenantId`, and its `kind:"platform"` token falls through
`requireAuth`'s staff branch, finds no Staff row and 401s.

### 4.2 Staff RBAC

- `accountRole` is `STAFF` or `ADMIN`. **Being granted any single admin page flips an
  account to ADMIN**, which has bitten several features (see the timesheet reminder, §11).
- `Staff.adminPages` is a JSON string of granted page keys. `null` = never configured =
  full access, so a college that never opens the Access screen does not find its
  administrators locked out.
- `requirePage("x")` / `requireAnyPage([...])` guard routes. The grantable list is
  `ADMIN_PAGES` in `server/src/validate.js` and **must stay in sync with `ADMIN_PAGES` in
  `client/src/StaffHub.jsx`** — two hand-maintained copies. The client additionally
  maintains `PAGE_LABELS` and `allNav`, and ships a **dev-only three-list drift check**
  (`warnOnPageListDrift`) because a key missing from `PAGE_LABELS` renders as an
  unlabelled checkbox and a key missing from `allNav` is grantable but reaches no screen —
  both of which have shipped.
- **`EXPLICIT_ONLY = { "mitigations" }`.** An unconfigured admin holds every page *except*
  these. `mitigations` carries UK GDPR **Article 9 health data**; under the old rule,
  adding it to `ADMIN_PAGES` would have silently granted it to every existing admin at
  every unconfigured college on deploy — a decision nobody made, arriving with a
  migration. A Super Admin always reaches it, so a college cannot be locked out. The
  client mirrors this in `canAccessPage`.
- **`audit` and `access` are deliberately not grantable.** `audit` is *derived* from the
  pages somebody already holds (giving it its own key would let an operator grant the
  trail without the authority it describes); `access` is Super-Admin-only.
- **`outranks(actor, target)` is rank, not "is the target the Super Admin".** You may only
  act on an account whose authority your own already covers. Before this, an admin holding
  only `passwords` could take over any other admin in one request, and one holding only
  `staff` could strip a colleague's 2FA and repoint their email.
- `parseAdminPages` fails **closed**: corrupt or non-array JSON returns `[]` (deny all),
  never `null` (allow all). "An admin who suddenly has no pages is a loud, safe failure;
  an admin who suddenly has all of them is a silent, dangerous one."

The 31 grantable pages: `executive, overview, kpi, checkin, balances, calendar, requests,
documents, approvals, signups, summaries, registers, live-attendance, attendance-tags,
students, attendance-emails, assessments, pat, prediction, mitigations, staffreviews,
studentreviews, studentqueries, staff, timesheets, timetable, admissions, ism, slc,
passwords, settings` — plus the two non-grantable tabs `audit` and `access`.

### 4.3 Sign-in (`routes/auth.js`)

`POST /api/auth/login` is one endpoint for three identities. It tries **staff → student →
applicant**, in that order, and on a total miss runs one bcrypt against a fixed
`DUMMY_HASH` so a non-existent account costs the same ~100 ms as a real one — otherwise
the response time is a clean account-existence oracle.

- Body values are **type-checked**, not merely truthy. `{}` is truthy and
  `bcrypt.compareSync` throws on a non-string, which produced 500 for real accounts and
  401 for missing ones — an oracle that also bypassed both rate limiters entirely.
- **Two rate limiters**: per (IP + email) and per account. The account one is the floor
  that still holds when the address cannot be trusted. Lockout is 15 minutes. Both are
  in-process `Map`s — correct for one Node process; a clustered deployment needs Redis.
- Failed sign-ins are audited with `audit.anonymous(email)`, because "an attempt against
  an address that does not exist is itself the finding".
- **2FA (TOTP)**: `TOTP_ENFORCED = false`, so 2FA is not mandatory. But an account that
  *deliberately enrolled* is always challenged — previously that was gated on the same
  flag, so the app reported "two-step verification: On" while letting a password alone in.
  Between password and code the caller holds a `purpose:"mfa"` challenge carrying `ver`,
  so a sign-in begun with the old password cannot survive a reset performed while it was
  in flight.
- A `pendingActivation` staff account (created by an admin, waiting on an invitation)
  cannot be signed into — its password is random and unknown, and it is treated as a
  non-match so the generic error applies.

Password reset, invitation acceptance and account deletion all live in this router and
all bump `tokenVersion`.

---

## 5. The data model

57 Prisma models. `Tenant` and `PlatformAdmin` are unscoped; every other table carries
`tenantId` with a cascade to `Tenant`. Grouped by what they are for:

**Platform / tenancy**
`Tenant`, `PlatformAdmin`, `CollegeRegistration`, `TenantIntegration`, `TenantBranding`,
`TenantDocTemplate`, `TenantEmailTemplate`, `AuditLog`.

**Staff / HR**
`Staff`, `SignupRequest`, `PasswordReset`, `DeviceToken`, `Notification`, `CheckIn`,
`Leave`, `Adjustment`, `Document`, `TimesheetEntry`, `StaffReview`.

**Academic structure**
`Semester`, `Course`, `Cohort`, `Term`, `Unit`, `Enrolment`, `HndSession`,
`AttendanceMark`, `TimetableSlot`, `TermCalendar`, `Assessment`, `AssessmentGrade`,
`AssessmentSubmission`, `MoodleSync`, `VleEngagement`.

**Students & pastoral**
`Student`, `StudentQuery`, `Interaction`, `StudentReview`, `StudentOutcome`,
`MitigatingCircumstance`, `AssessmentAdjustment`.

**Attendance capture & policy**
`AttendanceTag`, `TagTap`, `AttendanceTapConfig`, `AttendanceBandConfig`,
`AttendanceEmailConfig`, `SentNotification`.

**Admissions & finance**
`Admission`, `AdmissionDocument`, `AdmissionCourse`, `AdmissionIntake`, `Ism`,
`SlcApplication`.

**Prediction**
`PredictionModelSettings`, `StudentPredictionCurrent` (≈200 columns),
`StudentPredictionHistory` (the same shape, append-only), `Intervention`.

### Conventions that are load-bearing

- **Null means "not measurable"; zero means zero.** A figure that could not be measured is
  `null` and is excluded from denominators — never coerced to 0. A student whose register
  was never taken has no attendance percentage, and scoring that as 0 puts them top of a
  risk list for something nobody measured. New columns must be nullable.
- **Dates are strings.** `YYYY-MM-DD`, compared as strings (zero-padded, so string order
  *is* date order). `HH:MM` for times, same property. `src/clock.js` pins `APP_TIMEZONE`
  (default `Europe/London`) — **never use the host clock for a user-facing date**. Render
  and most hosts run UTC, so a 09:30 London check-in would be stamped 08:30 through BST.
  `localDate()` uses `en-CA` formatting because that yields ISO order.
- **Serialise through allowlists, never blocklists.** Named explicitly in
  `routes/admissions.js`: `sAdmission` once stripped a fixed list of secrets, so every
  column added afterwards shipped to the browser by default — which is exactly how the
  applicant portal's bcrypt hash got out when `passwordHash`, `active` and `tokenVersion`
  were added to `Admission` long after the serializer was written.
- **Comments explain WHY**, often at length, including why an alternative was rejected.
  This is the house style and it is load-bearing.
- **Rate limiters and locks are in-process module-level `Map`s.** Correct for one Node
  process; each says so in a comment.
- **Int columns are range-checked before writing** (`validate.js`). Prisma's `Int` is
  32-bit; one oversized number makes every subsequent read of that table fail with P2023,
  permanently breaking a feature for everyone until the row is deleted by hand.
- **Dates are validated for calendar reality, not just shape.** `"2026-02-30"` matches the
  regex and V8 rolls it over to 2 March rather than returning Invalid Date; a record filed
  on a date that does not exist is invisible to every view that filters by the real date,
  so it can never be found and corrected.

### Two dead-end tables, and two dangerous string columns

- **`AssessmentSubmission` is written by nothing** — no VLE adapter, no importer. A signal
  reading it measures the integration, not the student.
- **`Admission.studentId` and `SlcApplication.studentName`/`studentRef` are plain strings**
  typed by an administrator with no relation to `Student`. Matching on them would attach
  one student's loan status or visa expiry to another — "a data-protection incident rather
  than a bug". `src/linkRules.js` exists precisely to govern this: a pure module whose
  governing rule is **a wrong match is worse than no match**, requiring **two independent
  identifiers that agree** before proposing an automatic link, with three tiers
  (`auto` / `review` / `none`). It also refuses to count a *minted* email
  (`moodle-<id>@placeholder.invalid`, or `<studentRef>@domain`) as corroboration, because
  that is the same evidence as the reference counted twice.

---

## 6. Attendance — the core academic loop

### 6.1 Structure

```
Course ──< Cohort ──< Term
   └──< Unit ──< HndSession ──< AttendanceMark
        └──< Enrolment >── Student
        └──< Assessment ──< AssessmentGrade
```

- A `Unit` may carry `year`, `termNumber`, `startDate`, `endDate`, a free-text `tutor`
  **and** a `tutorStaffId` FK. The live-attendance dashboard matches on the **FK only** —
  "a name typed into a box is not an identity, and matching on it would hand one lecturer
  another's register whenever two people share a surname."
- `HndSession` is unique on `(unitId, date, startTime)`.
- `AttendanceMark` is unique on `(sessionId, studentId)` and `sessionId` is **NOT NULL**.

### 6.2 The points model (`src/attendance.js`)

```
Present = 2, Late = 1, Excused = 1, Absent = 0
pct = earned / (2 × markedSessions)          rounded to one decimal
```

Sessions with **no mark** are excluded — a register that has not been taken must not drag
a student's figure down. A student with nothing marked has `pct: null`, not 0.

`summariseCounts(P,L,E,A)` gives the same answer from database `GROUP BY` totals.

The prediction engine supports a second **binary** mode (present or not; late and excused
count as absent) for providers reporting physical attendance on a Student visa — but
`points` is the default because it is what the Attendance % tab already shows, "and the
engine must produce the same number the tab does or staff will not trust either."

### 6.3 Saving a register (`PUT /api/hnd/sessions/:id/register`)

Every guard here exists because of a specific failure:

1. **Term gate.** If the unit belongs to a term, only its *active* window accepts marks;
   outside it the route returns **423 Locked** unless the caller passes `override: true`.
2. **Row cap** (`MAX_REGISTER_ROWS`) — one 1 MB request would otherwise become ~15,000
   operations in a single transaction, holding a connection long enough to starve the API.
3. **Duplicate detection** — the same student twice previously slipped past the existence
   check and became repeated writes to one row.
4. **Enrolment, not mere existence.** Checking only that a student exists let a mistyped or
   stale id attach a mark — and therefore a whole unit — to somebody never on the course.
   Marks *already on the register* stay editable even after un-enrolment, so historic
   registers remain correctable.
5. **Out-of-term corrections are stamped**: `takenBy` becomes
   `"<name> (out-of-term correction)"`. Without it nothing distinguished a mark taken on
   the day from one added months after the term closed — "the first question an audit asks".
6. **A prior snapshot is read before the write**, because `takenBy` is overwritten by the
   next save; without it a mark changed from A to P months later leaves nothing saying it
   was ever an A.
7. **Only marks that actually moved** are audited and only those students are flagged for
   rescoring. A register save re-sends the whole class whether or not anything changed.
8. `status: null` **deletes** the mark rather than storing an empty one.

`POST /sessions/:id/mark-remaining-absent` fills the rest of a class in one action.
`GET /my-sessions/today` and `GET /sessions/:id/live` drive the lecturer's live view;
both are gated on `live-attendance` **or** `registers`, so a college can grant *watching*
without granting *editing*.

Note the deliberate narrowness recorded as **DEF-01** at the top of `routes/hnd.js`: the
whole router — reads included — requires one of `registers`, `students` or `executive`.
HND registers are an admin-dashboard feature; an ordinary teaching account cannot reach
them at all. A college wanting every tutor to watch their own register has to grant them
the page.

### 6.4 Attendance bands and the month-end letter

`attendanceBands.js` (pure) defines six default bands, best→worst: `excellent` 85+,
`great` 70–84, `good` 60–69, `average` 50–59, `risk` 40–49, `highrisk` 0–39. Each has a
stable `key` (so renaming a band does not orphan the letter a college spent an afternoon
writing), a `colour` and an `emailTrigger`.

**`bandForPct` matches on the lower bound only, walking best→worst.** This is a bug fix,
not a shortcut: percentages carry one decimal, so a student on 69.5% satisfied *neither*
`>=70 && <=84` *nor* `>=60 && <=69` under the old inclusive test, came back with
`bandKey: null`, showed no band on the admin table and was **silently skipped by the
month-end send** — and a student halfway between two bands is exactly who an attendance
letter is for. `normaliseBands` guarantees the stored list is sorted, gap-free and starts
at 0, so "first band whose lower bound this figure reaches" is total. A band's `max` is
therefore display-only.

`attendanceBandConfig.js` resolves a college's own ladder (per-tenant JSON column,
allowlisted through `BAND_FIELDS`, 30 s cache) and **re-validates on the way out** — a row
can predate a rule or be edited by hand in a console, and a ladder with a gap silently
drops students out of the send.

`attendanceRunner.js` owns the single `AttendanceEmailConfig` row and the monthly run,
de-duplicated on a `YYYY-MM` period so a restart on the last day of the month cannot
double-send. `attendanceScheduler.js` ticks hourly, does nothing unless `autoEnabled`,
and only fires on the last calendar day at/after `sendHour` **on the London clock**. If no
mailer is configured it logs loudly — "this is the one failure nobody would otherwise
notice: the month's letters went to the console and every student is still waiting for
theirs."

Templates carry `{token}` placeholders (`{firstName} {pct} {period} {modules}
{respondByDate} {tutorName} {wellbeingContact} …`) filled by `fillTemplate`. The band
ladder travels **with** the templates in `resolveConfig`, so no caller can pair one
college's letters with another's thresholds.

### 6.5 NFC tap check-in

**Shipped switched off** (`AttendanceTapConfig.settings.enabled = false`) — "a feature
that writes to the attendance record must not switch itself on at every college on the
next deploy."

**What a tap proves, stated honestly** (and the comments were *corrected* to say this):
that somebody was at that sticker once, with this account signed in. **Not** that they
are there now. The sticker's code is static and any phone with a generic NFC reader can
lift it, so a student who notes one down can mark themselves present from home. The
lecturer's live view and the `TagTap` log (which carries the IP) make that visible after
the fact; nothing prevents it. "An overclaim in an attendance record is worse than a gap
somebody knows about."

**`attendanceTap.js` is pure** — it takes the candidate sessions the route already read
plus `{date, time}` from `clock.js`:

- Candidates come from **`Enrolment`**, which is what makes a student eligible for a
  register at all.
- A session is *running* if `now ∈ [start − earlyGraceMins, end]`, both ends inclusive —
  "a student who tapped as the class ended did arrive".
- `subMinutes`/`addMinutes` **clamp** rather than wrap: a lecture does not cross midnight,
  and wrapping "fifteen minutes before 00:05" to 23:50 would produce a string that sorts
  later than every other time of day and accept taps around the clock. An unparseable
  time is handed back untouched rather than becoming `"NaN:NaN"`.
- Nothing running → `no_session_now`, reported **before** the term check, so a student who
  tapped at the wrong time is not told their term is closed.
- Term locked → `term_locked` (mirroring the register's 423).
- Two lectures genuinely running at once → `ambiguous`, and the student picks. `statusFor`
  is exported separately so the chosen class's *own* start time decides P vs L — reusing
  the first candidate's verdict would mark a punctual student late.
- `now.time <= start + lateAfterMins` → **P**, else **L**.

Three things the student route must never do, each of which would damage a record the
college is asked to evidence: **overwrite a lecturer's mark** (the human in the room
wins), **write an A** (absence is what an untaken register already means, and scoring
"did not tap" as absent turns a flat battery into a permanent academic record), or
**bypass the term lock**.

`SELF_CHECKIN_STAMP = "Self check-in (NFC)"` is written into `AttendanceMark.takenBy` and
read back by the live view with **exact equality**, so it is frozen — changing the string
would silently reclassify every self check-in ever recorded as staff-marked. A prefix or
case-insensitive test would read a lecturer who typed "self check-in" as a machine.

`GET /api/student/me/tap-context` returns the student's **whole timetable for today**
whether or not the college has switched tapping on — each entry carrying
`state: upcoming | now | over`, the existing mark (`null` ≠ absent), `checkedInAt`, and
`termOpen`. "A college that never switches tap check-in on still gets a student's day out
of this route."

**Staff taps** (`POST /api/checkins/tap-check-in`) clock a staff member in as `Onsite` —
`site` is not accepted, because someone who touched a sticker in the building cannot be
working online. Re-tapping never rewrites the arrival time, and the "fill in the sentinel"
path uses `updateMany … where timeIn: ""` so the *database* settles two concurrent taps
rather than a read-then-write race; a P2002 on `@@unique([staffId,date])` is reported as
"already checked in" rather than as a 500.

**Tag administration** (`routes/tags.js`): the code is 16 random bytes base64url, returned
**exactly once** at creation. There is deliberately no endpoint that reads a code back —
the remedy for a leak is to retire the sticker and write a new one. `AttendanceTag.code`
is **globally unique**, so registering a sticker performs the one `crossTenant` read in
the feature and returns a **boolean only**: which college holds it stays invisible.
Every refusal (`disabled`, `rate_limited`, `tag_unknown`, `already_checked_in`) is logged
to `TagTap` — which is why `TagTap.tagId` is nullable — and the attempted code is **never
stored**, so the log an administrator reads does not become a list of codes somebody has
been trying. Both tap endpoints carry an in-process limiter of 10 attempts per minute.

`GET /api/tags/settings` is declared **before** `GET /:id/log` and `PATCH /:id`, because
Express matches in declaration order and a literal path that sorts after a parameter
route is a route that never runs.

### 6.6 Rotating QR check-in — built, tested, **not yet wired**

`src/attendanceQr.js` + `attendanceQr.test.js` exist in the working tree, and
`attendanceTapSettings.js` already carries `qrEnabled: false` and `qrRotateSeconds: 30`.
**No route imports it yet** (`grep attendanceQr src/routes` returns nothing), so the
feature is not reachable from the API. The design note is
`docs/superpowers/specs/2026-08-29-qr-check-in-design.md`.

The mechanism, and why:

- **The code must rotate.** `AttendanceTag.code` is permanent, and its schema comment
  explains why it is deliberately not a URL — "a readable link is one a student can read
  off the wall with any phone and replay from home". That is fatal to the obvious version:
  NFC is safe from replay because reading needs physical proximity, and a printed square
  has no such property. One photograph would produce a register full of fabricated
  presents, which is *harder to challenge at an audit than an empty one*.
- **Derived, never stored.** The code is an HMAC over `(sessionId, windowIndex)` where
  `windowIndex = floor(epochSeconds / rotateSeconds)`. No table of live codes, nothing to
  sweep, no row that can go stale, and two servers behind a load balancer derive the same
  code without coordinating — which the in-process limiters elsewhere cannot claim.
- **`ACCEPTED_WINDOWS = 2`** — the current window and the one before it. Latency
  tolerance, not generosity: a student who raised their phone at 29.8 s would otherwise be
  refused by their own network round trip, and "scan again" twice is how a feature gets
  abandoned in week one.
- **`DIAGNOSED_WINDOWS = 20`** (≈10 min) — how far back we keep *claiming to recognise* a
  code, purely so "that code has expired — scan the new one" and "that code was never one
  of ours" stay different sentences with different next steps.
- **`CODE_LENGTH = 22`** base64url characters (~132 bits). Shorter is a less dense square,
  and scannability from the back of a lecture hall is the real constraint, not brute force.
- `windowIndexFor` floors the period at 1 second: a settings blob can be hand-edited, and
  dividing by 0 yields `Infinity`, which would make every code in the institution verify
  against every other one — "a silent, total failure that presents as everything working".
- The canonical string is **length-prefixed**, not joined on a separator, so
  `("ab", 1)` and `("a", "b1")` cannot be made to collide — a collision here is one
  lecture's code opening another's register.
- The session id travels **in the clear**. That is safe and load-bearing: knowing which
  register is on screen grants nothing without a current signature, and naming the session
  deletes the entire ambiguity branch the NFC path needs. It proves nothing about *who*
  scanned, so the route must still check enrolment, the session window and the term lock.
- A **second stamp**, `SELF_CHECKIN_QR_STAMP = "Self check-in (QR)"`, exists because the
  live view's exact-equality test would otherwise report every QR check-in as
  staff-marked — and because an administrator reconciling a disputed register needs to
  know whether a mark came off a sticker in the room or a code on a screen: "a sticker
  needs physical proximity, a screen can be photographed." `SELF_CHECKIN_STAMPS` is the
  frozen list, and `isSelfCheckIn()` is the single predicate over it.
- `qrEnabled` is a **separate** switch from `enabled`, not implied by it: two capture
  methods with different physical properties, and inferring one from the other would
  silently hand a college a second way of writing to its attendance record on deploy.
- `qrRotateSeconds` is bounded at **both** ends (10–300). Too long and it is the permanent
  code this design exists to avoid, reachable by typing a big number into a settings box;
  too short and a phone camera plus a round trip cannot finish, which presents as "the QR
  never works" and gets the feature switched off.

---

## 7. Predictive analysis — the progression-risk engine

The largest subsystem: 17 modules under `server/src/prediction/`, plus `routes/prediction.js`.

### 7.1 The seam

```
metrics.js  (the ONLY file here that touches the database)
    │  gather(studentIds, config) → Map<studentId, { scope, raw, tripwires }>
    ▼
engine.js   (PURE: no DB, no clock, no tenant, no I/O)
    │  score(raw, config) → the scored row
    ▼
runner.js   writes StudentPredictionCurrent (in place) and
            StudentPredictionHistory (append-only)
```

The seam is deliberate: "the arithmetic is the part that gets argued with, and it stays
testable without fixtures." These are the rules a college will be asked to defend when a
student appeals a decision taken off the back of a risk level.

Every satellite module (`tripwires`, `coverage`, `cohort`, `workload`, `funding`,
`sessions`, `intake`, `history`, `divergence`, `assessmentType`, `timetable`,
`earlyWindow`, `adjustments`) is likewise **pure**, taking already-fetched shapes.

### 7.2 The three ideas in `engine.js`

1. **Unmeasurable is not zero.** A component with no evidence is dropped from **both**
   sides of the weighted mean — the score becomes "70 of the 95 points that were actually
   available", not "70 out of a hundred, five of which could never have been earned". A
   student with *nothing* measurable is reported `insufficientData` and **not scored at
   all**; the runner then *deletes* any stored row for them. A fabricated 0 "would put the
   newest students at the top of every Critical Risk screen in the college."
2. **Overrides can only ever make things worse.** Bands are sorted best→worst, so "cannot
   be better than X" is `Math.max(index, indexOf(X))` — `max()` only moves the index up.
   An override is a floor on concern, never a verdict that pulls somebody up.
3. **The score and the band must never disagree.** When an override moves a student down,
   the reported score is pulled into that band with it, while `baseProgressionScore` and
   `baseRiskLevel` keep the untouched arithmetic. The clamp is
   `max(band.min, floor(band.max × 10) / 10)` — *floored*, because `round1(69.99)` is
   `70.0`, which is the next band's opening score and would hand back the exact band the
   override had just taken away; and *clamped to `band.min`*, because nothing guarantees a
   multiple of 0.1 exists inside every band a college might define.

### 7.3 The seven components

| Component | Default weight |
|---|---|
| `overallAttendance` | 0.20 |
| `recentAttendance` | 0.15 |
| `submissionRate` | 0.15 |
| `onTimeRate` | 0.10 |
| `averageGrade` | 0.25 |
| `gradeTrend` | 0.10 |
| `interventionResponse` | 0.05 |

Weights must total 1 (with a `1e-6` epsilon, because the defaults sum to
`0.9999999999999999` in IEEE 754).

- `submissionRate` excludes `"unknown"` from the denominator entirely — most assessments
  are LTI/Turnitin grade items for which Moodle reports no submission state, and counting
  those as not-submitted would invent a missing-work problem for a whole cohort.
- `onTimeRate` is measured against what was **handed in**, not against everything due.
  Work never submitted is already counted by `submissionRate` and `missingAssessmentCount`;
  letting it drag this too would charge the student three times.
- **`gradeTrend` is a decline detector and is priced like one.** `IMPROVING` and `STABLE`
  are both 100: how good the average is already carries the largest weight, so paying a
  bonus for improving would score the same recovery twice. `DECLINING` is 20;
  `INSUFFICIENT_DATA` (fewer than `2N` marks) is renormalised out, never scored badly —
  "a student cannot be marked down for the college not having set enough work yet."
- **`interventionResponse`** compares today's figures against the ones **snapshotted on
  the intervention**, not read back live, because "were they worse when we intervened than
  they are now?" is unanswerable if the baseline moves underneath it. Only pairs where
  *both* sides are known are used. `NO_CHANGE` scores 50 — a genuine mid-point: somebody
  sat down with this student and nothing moved, which is weaker than never having needed
  the conversation. `NONE` and `TOO_EARLY` are renormalised out.
- `INTERVENTION_MOVEMENT = 5` percentage points is **not** configurable: it is the
  resolution of the comparison, not a policy about students.

### 7.4 Bands, overrides and red indicators

Default ladder (best→worst): `R1` 85+ Very High Progression Confidence, `R2` 70–84.99
Likely to Progress, `R3` 55–69.99 Moderate Risk, `R4` 40–54.99 High Risk, `R5` 0–39.99
Critical Risk. `key` is stable and is what the database stores, so a college renaming a
band does not orphan history.

Six **red indicators** — exactly six, which is why `redIndicatorThreshold` is capped at 6:

`RED_LOW_OVERALL_ATTENDANCE`, `RED_LOW_RECENT_ATTENDANCE`, `RED_LOW_SUBMISSION_RATE`,
`RED_MISSING_ASSESSMENTS`, `RED_LOW_AVERAGE_GRADE`, `RED_DECLINING_GRADE_TREND`.
An unmeasurable figure never raises one.

Four **overrides**:

| Code | Condition (default) | Effect |
|---|---|---|
| OVR-001 | `missingAssessmentCount >= 2` | cannot be better than `missingOverrideBand` (R3) |
| OVR-002 | `recentAttendance < 50` | cannot be better than `criticalAttendanceBand` (R4) |
| OVR-003 | `averageGrade < passThreshold` (40) | cannot be better than `lowGradeBand` (R3) |
| OVR-004 | `redIndicatorCount >= 3` | worsens the band by one, clamped at the worst |

OVR-004 is applied **last and to the already-capped index**, so it compounds with the caps
rather than competing with them. Override bands are named by **key**, not position, and
`validate()` refuses a config naming a band that does not exist — "a college cannot end up
with a dead override it believes is protecting students."

A code is recorded whenever its **condition** is met, not only when it moved the student,
"otherwise the reason a student is where they are disappears the moment a second rule
agrees with the first."

Also emitted: `primaryRiskDriver` (largest `weight × (100 − score)` among *measured*
components — weighted, because a 5% component at zero matters less than a 25% component at
60), `positiveDriverCodes` (`GOOD_*`), `directionOfTravel` (this score against the nearest
stored score ~28 days back, compared on the **final** score because that is what was
stored and what staff saw), and `LIMITED_EVIDENCE` when less than half the model was
measurable.

### 7.5 Configuration (`prediction/settings.js`)

~90 keys, all per-tenant, all validated. Validation is the point of the file, because
**a bad configuration fails silently and fails for a whole cohort at once**:

- Weights totalling 0.9 produce a weighted sum 10% too low for every student, walking the
  entire college one band down the ladder — and staff would believe it and act on it.
- A **gap** in the bands means a student whose score lands in the hole is classified
  against nothing: no band, no action, no flag.
- An **overlap** means which band a student lands in depends on array order, so a student
  can change risk level because an administrator dragged a row.
- An **unknown key** stored verbatim is a setting somebody believes they changed and which
  nothing reads. Unknown keys are **refused**, not dropped.

`SCORE_STEP = 0.1` is used to prove the ladder has no gap a real score could fall into.
`validate()` runs on the way **out** of `get()` as well as on the way in, because a stored
row can predate a rule or be hand-edited. `DEFAULTS` is `deepFreeze`d, because it is
shared by every tenant in the process. Cache TTL 30 s. Saving settings calls
`markAllStale()` — every stored score was produced under the old policy and is not
comparable.

`scope` is `current-term` by default: "a strong Year 1 must not mask a collapse happening
now." A student whose cohort has no term containing today falls back to the whole record,
not an empty window, because an empty window would score everyone unmeasurable and empty
the risk register. The **grade trend deliberately ignores scope** and crosses term
boundaries — a decline that started last term is exactly the thing worth catching.

### 7.6 Tripwires — a second layer beside the score

**They cannot move the band, and that is structural.** The satellite modules append
`TRIP_*` codes to `riskDriverCodes` — the same array carrying the engine's reds, so staff
read *one* list of reasons. But `engine.js` derives `redIndicatorCount` from its own
internal `reds` array and `riskDriverCodes` is a **copy taken afterwards**, so nothing
appended can reach OVR-004. The prefix keeps that visible: a code named `RED_`-something
would read as the engine's. `schema-contract.test.js` asserts the vocabularies are
disjoint and all `TRIP_`-prefixed, because a duplicate string would make two different
findings indistinguishable on screen.

The vocabularies, by module:

| Module | Codes |
|---|---|
| `tripwires.js` | `ABSENCE_STREAK`, `NOT_SEEN`, `UNMARKED_WORK`, `ATTENDANCE_FALLING`, `TREND_UNRELIABLE`, `RECENT_FAIL`, `NO_SHOW`, `TUTOR_AT_RISK`, `NO_PASTORAL_CONTACT`, `UNIT_ABANDONED`, `UNITS_UNPASSED`, `CHRONIC_LATE`, `REPEAT_CONCERN`, `REVIEW_OVERDUE`, `QUERY_UNANSWERED`, `CONTACT_DEFICIT`, `FOLLOWUP_MISSED` |
| `coverage.js` | `ATTENDANCE_UNRELIABLE`, `REGISTER_NOT_TAKEN`, `REGISTER_STALE` |
| `cohort.js` | `COHORT_ATTENDANCE_OUTLIER`, `COHORT_ATTAINMENT_OUTLIER` |
| `workload.js` | `WORKLOAD_PILEUP`, `WORKLOAD_ABSENT` |
| `funding.js` | `FUNDING_STALLED`, `FUNDING_EVIDENCE_OUTSTANDING`, `FUNDING_REFUSED` |
| `sessions.js` | `WEEKS_UNSEEN` |
| `intake.js` | `INTAKE_NO_WIFI`, `INTAKE_DIGITAL_SKILLS`, `INTAKE_RESERVATION`, `INTAKE_ID_EXPIRING`, `INTAKE_ID_EXPIRED` |
| `history.js` | `CHRONIC_RISK`, `RISK_OSCILLATING` |
| `divergence.js` | `DIVERGENCE_ATTENDING_NOT_SUBMITTING`, `DIVERGENCE_SUBMITTING_NOT_ATTENDING`, `DIVERGENCE_ONLINE_NOT_ATTENDING`, `DIVERGENCE_ATTAINING_NOT_ATTENDING` |
| `assessmentType.js` | `ASSESSMENT_TYPE_FAILING` |
| `timetable.js` | **none, deliberately** |
| `earlyWindow.js` | **none, deliberately** |

(all prefixed `TRIP_`).

**Store dates; derive day-counts at render time.** Nothing in this feature runs on a
schedule — `markStale()` fires on data events, and a day passing is not an event. "19 days
since last attended" written to a column is wrong by the next morning with nothing to
correct it, while `lastAttendedOn` is true forever. So columns hold dates and the screen
subtracts.

**A signal that fires for a whole cohort at once is a FIGURE, not a code.**
`assessmentsDueSoon` and `cohortStruggling` are figures for exactly this reason: "a
hundred rows carrying an identical reason is the same as no caseload."

**Some signals exist to suppress.** `weeksIntoProgramme` mutes the disengagement codes
inside `settlingInWeeks` (3), because in week one nobody has attendance history, marks or
a pastoral record, and a caseload containing the whole intake is the same as no caseload.
An **unknown** programme age is deliberately *not* exempt — muting every code for a student
the calendar cannot place fails safe in the wrong direction.

### 7.7 The institution probes — the most repeated bug in this area

**"Does this college record this field at all" is an institution-wide question, and
computing it from the chunk is the mistake that has been made three times.** `gather()`
runs on chunks of 200, and the ordinary incremental path scores only the handful of
students `markStale` flagged — often one. One student with no late marks is ordinary; a
college whose Moodle plugin has no "L" acronym records no lateness at all, and only the
second makes `latenessRate` `null` ("not recorded") rather than `0.0` ("never late"). The
worst case: the pastoral pair, decided per chunk, suppressed `TRIP_NO_PASTORAL_CONTACT`
for exactly the students it exists to find, because a chunk of never-contacted students
contains no contacts.

So **sixteen cheap existence probes** are issued once per run, unfiltered by student,
hoisted out of the chunk loop and run concurrently. Several are subtler than a bare count:

- `timetableRecorded` counts sessions **with no marks**, not sessions. `count(HndSession)
  > 0` is true at every college that ever took one register, because
  `AttendanceMark.sessionId` is NOT NULL — so if sessions only exist once somebody takes a
  register, scheduled and marked are the same set by construction and coverage reads 100%
  for everybody. That is *manufactured reassurance*, the harder mirror of the failure the
  figure exists to catch.
- `kindRecorded` counts sessions with a **non-empty** `kind`, because the column defaults
  to `""`.
- `assessmentTypesRecorded` counts assessments whose `type` is **not** the default
  `"Assignment"` and not `""`.
- `slcRecorded` and `ismRecorded`/`idExpiryRecorded` count **linked** rows only. A college
  holding four thousand unlinked claims would otherwise have the pipeline report "no
  funding record" about four thousand people who have one.
- `slcStatusesMaintained` asks a *different* question from `slcRecorded`: whether anybody
  ever moves a claim's status. A college that raises claims here and works its finance
  queue elsewhere has linked rows whose status never changes — reproduced in review as 200
  of 200 students tripped for 184 days.
- The **follow-up watermark** is derived, never stamped: a constant would be a *deploy*
  date and the two databases migrate on different days. It is `_min(updatedAt)` over rows
  carrying a completion, **not** `_min(followUpCompletedOn)` — the routes deliberately
  accept a backdated completion, so the first honest backdated close would drag the
  watermark months into the past and make every untouched promise judgeable in one run.
  Null means the signal stays **silent**, which under-reports (the safe direction), is
  bounded, and converges.
- `vleEngagement` needs **no** probe: a college that is not observable has written no rows
  at all, so absence *is* the guard — which is the whole reason the table stores absence
  (`accessed: false`) rather than zero.

### 7.8 Cohort standing and register coverage

**The cohort population is built ONCE per run, hoisted, institution-wide, unfiltered by
the stale set.** It is read from `StudentPredictionCurrent`, which is one run behind for
anybody being rescored — a real weakness, and the lesser one: the alternative is a second
implementation of the points model in SQL, which would drift from `attendance.js` and
produce a cohort mean the screen cannot reconcile with the figures beside it. With the
cohort floor at 12, one stale peer moves a mean by at most a twelfth of its own error.
**`cohortSize` is stored** so the classic failure stays detectable: a population size
exactly equal to the chunk size is the fingerprint of it having been built from the chunk.

**Being below average is not a risk.** Half of every cohort is below the median by
definition, so a cohort signal needs **both** a rank test (`cohortOutlierPercentile`, 10)
**and** an absolute gap (`cohortOutlierGap`, 10) — "the bottom decile of a cohort sitting
between 88% and 92% is three points off the mean." Plus `cohortMinSize` 12 (below ten,
"in the bottom 10%" and "is the worst student in the room" are the same statement) and
`cohortMinSpread` 2 (a near-uniform cohort still looks like a ranking).

**Register coverage** (`coverage.js`) is where a caption becomes arithmetic. Below
`minMarksForRate` (6) the attendance percentage is **withheld entirely** — `null`, never a
low number and never zero — and passed to the engine as `null`, which renormalises the
component out. At five marks one observation is worth twenty points while the narrowest
band is fifteen wide: "the figure measures how often somebody opened the register, not the
student." `marked` is still reported so the screen can say what was withheld and why.
`registerCoverage` **requires `sessionId` on every mark** and returns null without it — a
mark that cannot be tied to a session cannot be reconciled. `lowCoverageLimit` is
deliberately generous (60%) because `HndSession.audience` means some scheduled sessions
legitimately do not apply to a student and this pipeline cannot see which.

### 7.9 Mitigating circumstances — the engine knows THAT, never WHY

**A claim is Article 9 health data and the schema is split around it.** `status`,
`coversFrom`, `coversTo`, `coversAttendance` and the adjustments say *what the college
decided*; `category` and `detail` say *why*. The prediction pipeline selects the first
group and nothing else, and `schema-contract.test.js` reads `metrics.js` **as text** and
fails if `category` or `detail` ever appear in that select — "the rule lives in exactly one
place and that is the kind of rule a later reader widens for a screen they are building."
Same reason the audit summary names the student and the decision but never the reason: the
audit log is read on Settings by admins never granted the `mitigations` page.

The one rule everything else follows from (`prediction/adjustments.js`):

> **A suppressed assessment leaves BOTH sides of every fraction.** Never counted as
> submitted, never as on time, never as missing.

This is null-is-not-zero pointed the other way, and getting it backwards is the *mirror*
of the bug the feature fixes: counting an extended assessment as handed in on time
inflates the score of a student in real difficulty and quietly removes them from the
register — the quieter and worse failure. Excluded work must leave a list **entirely**
rather than arrive with a null date, because a null `dueDate` reads as "nothing to be late
against", which counts the piece as on time.

`effectiveDeadline()` resolves per assessment: `measured` (no adjustment), `deferred` (a
revised deadline, compared against today exactly as the original would be) or `excluded`.
**Most generous wins** where claims overlap, and an "extension" that moves a deadline
*earlier* is treated as a data-entry fault and ignored — "a mistyped row can only ever be
harmless."

**Attendance cover keeps two lists.** `rateMarks` drops covered sessions and feeds the
*percentages*; `overallMarks` stays raw and feeds `lastAttendedOn`, the absence streak, the
weekly pattern, the day-shape modules and every pastoral code — "a student on approved
mitigating circumstances is one the college should be speaking to MORE, and a sponsoring
provider still has to evidence engagement." Muting the dates would turn a support measure
into a way of losing sight of the student it supports.

**An undecided claim suppresses by default, and that is a per-tenant setting**
(`pendingClaimSuppresses`). With a claim pending, "did this student fail to hand work in"
is not a question about the student — the answer depends on a decision the institution has
not taken, and counting it against them punishes the student for the length of the
college's own decision queue. But a college whose regulations say otherwise is entitled to
say so, and "hardcoding one reading of somebody else's regulations is the worse failure."

`mitigationWindowMaxDays` (120) exists because an unbounded window is a permanent
suppression, indistinguishable from having taken the student off the register altogether; a
year out for treatment belongs on `StudentOutcome`.

### 7.10 The runner

- `markStale(ids)` is cheap and safe from a request path — every route that touches
  attendance, marks, enrolments, term dates or unit structure calls it and returns. A
  student with **no row** is stale by definition, which is also why the column defaults to
  `true`; otherwise a new student would never enter the register.
- `recalculate({studentIds | all | limit})` chunks at **200** — large enough that a
  500-student college is three round trips per table, small enough that the `IN (...)`
  parameter list stays inside what a pooled Postgres connection accepts.
- **History is append-only** — never updated, never deleted. Direction of travel is
  literally "this score minus the row nearest a month ago", and any model later trained on
  real progression outcomes trains on these rows. But a row is not appended every run:
  `shouldAppend()` writes when the student is new, when risk level / score /
  `interventionRequired` moved, or when the last row is `HISTORY_HEARTBEAT_DAYS` (7) old.
- **`divergence` and `contactDeficit` are computed in the runner, not in `gather()`**, and
  the position is the point. Both need something only available *after* scoring: divergence
  needs `submissionRate`, which `engine.measure()` derives; contact deficit crosses the
  **current** risk level with pastoral dates, and the only non-stale risk level is the one
  `score()` just returned — computing it upstream would measure a student who has just
  deteriorated against the comfortable band they held a fortnight ago, and stay silent.
  This is also how `divergence` came to **ship dark**: an earlier version called it inline
  and returned only its three figures, silently discarding `codes`, so all four
  `TRIP_DIVERGENCE_*` codes were computed on every run and thrown away while their labels
  sat unused in the client.

### 7.11 What the prediction feature deliberately does not do

Recorded at the top of `routes/prediction.js`:

- **No student-facing route.** The student app cannot reach this router at all, and "a
  student being shown a machine's prediction that they are likely to fail is a product
  decision nobody has taken."
- **No automatic email.** Compare attendance emails, which *do* write to students — that
  feature has a template a human wrote and a band a human set.
- **No delete** for a history row or an intervention. Both are records of what the college
  knew and when, "which is exactly what an appeal turns on."
- **Reads are gated as tightly as writes**, because a risk level is a judgement about a
  named student, not a statistic — a wider disclosure than the gradebook, which is already
  page-gated.

`StudentOutcome` records what became of a student (and `POST /outcomes/calibration` scores
the model against reality). Note the vocabulary collision flagged in `CLAUDE.md`: an
`Intervention.outcome` is the response to something staff did; a `StudentOutcome` is what
became of the student. Two vocabularies (`OUTCOMES`, `STUDENT_OUTCOMES`), and a fix aimed
at one has twice landed on the other.

---

## 8. Admissions, the applicant portal, and documents

### 8.1 The pipeline

```
enquiry / public form   →  Admission row
        ↓
applicant registers a portal account (passwordHash on the same row)
        ↓
documents requested  →  emailed magic link  →  uploads land in SharePoint (or Supabase)
        ↓
interview invitation  →  ISM (interview record)  →  interviewStatus
        ↓
offer letter  →  emailed accept link  →  offerAcceptedAt
        ↓
enrolment  →  induction email  →  linkedStudentId points at a real Student
```

`Admission` is one wide row of ~90 mostly free-text columns "so the form can change
without a migration". It holds special-category data: ID document numbers, NI number,
criminal-conviction answers, medical conditions, learning difficulties, ethnicity,
religion. Three consequences run through the code:

- The whole router is gated on the `admissions` page.
- `ADMISSION_OUT` is a strict **allowlist** (built from the shared `admissionFields.FIELDS`
  plus named workflow columns). `passwordHash`, `uploadTokenHash`, `offerTokenHash`,
  `tokenVersion`, `active` and `tenantId` are each absent *with a written reason* so a
  later reader does not helpfully add them back.
- The audit trail uses **`audit.changedKeys()`** — the *names* of the fields that changed,
  with none of their values. "Eleven fields on this application were edited, and these are
  their names" answers the question an audit trail is asked without the log becoming a
  second copy of the data. `SECRET_FIELDS` would not help here, because none of it is a
  secret; it is simply personal.

Magic links are stored as **SHA-256 hashes** (`uploadTokenHash`, `offerTokenHash`, both
`@unique`); the raw token exists only in the email. Upload links last 30 days — reusable,
because applicants add documents over several days, but not forever.

`routes/admissionApply.js` and the public halves of `routes/applicant.js` and
`routes/admissionOffer.js` are the unauthenticated surface: the application form, the
course/intake pickers, the upload page and the offer-acceptance page.

### 8.2 Letters: the college's own PDF is used as the page

`docTemplate.js` + `TenantDocTemplate` hold a college's own offer letter / application
form as **bytes**, with a `fields` map of where to write on it. The applicant's details
are written *onto* their document — never redrawn — so the letter that goes out is the
college's own letterhead. `applicationPdf.js` and `offerLetter.js` are the fallbacks when
no template is uploaded, drawn with `pdfkit`; `uploadToPdf.js` converts an uploaded image
to PDF.

`TenantEmailTemplate` does the same for wording: per-college subject/body per email kind,
with the system's own text as the default. The "you're enrolled" email is the one with no
template — its wording is the system's, and only the identity in it comes from branding.

`mailAssets.js` builds the logo/wordmark/venue/footer fragments from branding, and every
one **collapses to nothing** when the college has not set the field — "so a sentence loses
a clause rather than gaining the word 'undefined' or, worse, the name and street address
of a different college."

### 8.3 File storage — two backends

- **SharePoint** (`sharepoint.js`, ~570 lines) via Microsoft Graph, **app-only** client
  credentials. Resolves site → drive → base folder, then a folder per applicant. Per-tenant
  `tokenCache`, `siteIdCache`, `driveIdCache`, `rootFolderIdCache`, all keyed by
  `tenantKey()` with `forgetTenant()` to evict. Site configuration is accepted in any of
  four shapes (full URL, Graph site id, host+path) because a copy from the browser's
  address bar should just work.
- **Supabase Storage** (`storage.js`) for staff `Document` rows. Plain `fetch`, no SDK —
  "three endpoints do not justify a dependency". **The bucket must be private**: documents
  include payroll and HR files assigned to one named person. Reads go through 300-second
  signed URLs minted only *after* the API has checked the caller may see the document.
  Render's free tier has no persistent disk, so the server's own filesystem is not an
  option — a policy uploaded on Monday would be gone on Tuesday with no error and no trace.

---

## 9. The other college-facing features

### 9.1 Staff HR

- **Check-in** (`CheckIn`, unique on `(staffId, date)`) — one row per person per day, with
  `timeIn`, optional `timeOut`, a free-text `summary`, a `site` (`Onsite` | `Online`) and
  an optional `tagId`. `timeIn: ""` is the sentinel for "wrote a summary, never checked
  in".
- **Leave** — request, decide, with `Adjustment` rows for manual balance corrections.
  Deciding requires one of the leave pages (`requests`, `approvals`, `calendar`); the
  client's Manager Approval tile mirrors that guard, because gating it on "is an admin"
  meant a finance-only admin saw the tile, opened an empty queue and got a 403 on every tap.
  `bankHolidays.js` supplies UK closures.
- **Timesheets** — draft → submitted → reviewed, with a month-end reminder (§11).
- **Documents** — scoped `all` or assigned to one staff member; download is authorised
  first, then signed.
- **Sign-ups and invitations** — `SignupRequest` is a self-service application an admin
  approves; `invite.js` + `PasswordReset` (with `purpose`) drives admin-created accounts,
  which sit at `pendingActivation: true` until the invitation is accepted.
- **Staff reviews** (`reviewForms.js`, 735 lines) — the questions *and* their validation
  live in one server file and the client renders whatever it is given, so adding a review
  type is a one-file edit with no front-end work and no risk of the two drifting. Field
  kinds: `text`, `textarea`, `date`, `select`, `radio`, `grid`, `confirm`, `checkbox`.
  Forms marked `selfService: true` also appear in the staff app under "My reviews".
- **Notifications** — persisted `Notification` rows, plus best-effort email and FCM push to
  every registered `DeviceToken`. Dead tokens reported by FCM are deleted. Every channel is
  best-effort: "a delivery problem must never break the primary action."

### 9.2 Pastoral

- **`Interaction`** (the PAT log) — dated, timed, typed (`queryType` is free text in the
  schema but allowlisted at the route), with `followUpRequired` / `followUpDate` /
  `followUpCompletedOn`.
- **`StudentReview`** — progress, a JSON array of concerns (stored in a `String` column, so
  it is parsed in Node and every parse is wrapped in try/catch), agreed actions, and its own
  follow-up pair. Can spawn an `Intervention`.
- **`StudentQuery`** — the one channel a student has. `status` moves `open → answered`.
  The prediction pipeline reads only four scalars from it (`status`, `respondedAt`,
  `createdAt`, `studentId`); `subject`, `message` and `response` are free text a student
  wrote about their own circumstances and are gated behind a *different* page grant.

### 9.3 Timetable

`TimetableSlot` rows scoped to `(course, year, termNumber)`, auto-filled from a unit's
generated sessions (`scheduleOf` derives the distinct weekly pattern by
`(weekday, start, end, kind)`), then edited by hand. `TermCalendar` holds the academic
calendar for one exact `(course, year, term)` and a `weeks` JSON array. `published`
controls whether students see it. Students read it through
`GET /api/student/me/timetable`.

`AUTO-TIMETABLING.md` and `AUTO-TIMETABLING-SOLVER.md` describe a planned constraint
solver; per the memory note, timetabling is parked and the resumption point is clash
detection.

### 9.4 The student app

Six tabs: **Home, Check In, Attendance, Results, Ask, More**. Every route in
`routes/student.js` is keyed on `req.user.id` — there is no id parameter anywhere in the
file, so there is nothing to tamper with, and the allowlist in `auth.js` blocks the token
from every other router regardless. Grade bands shown to students (70 Distinction,
60 Merit, 50 Pass) must match `routes/assessments.js` and the client. Percentages are
clamped 0–100, matching the admin gradebook, so a historic mark above its assessment
maximum does not show as over 100%.

### 9.5 Student finance

`SlcApplication` tracks a loan claim: `status`, `loanType`, `crn`, `applicationDate`,
`decisionDate`, `amount`. Two things matter to the rest of the system:

- **No row means "we do not know", never "no funding".** Self-funded, employer-sponsored
  and international students legitimately have none, and putting them on a risk register
  for a loan they never wanted is the failure. Every funding code fires on the **presence**
  of a row saying something specific.
- **`statusChangedOn` is written only when the status actually moves.** `routes/slc.js`
  never wrote it at all until recently, so it is null on every older row and `funding.js`
  falls back to `applicationDate` — which measures time *in the pipeline* rather than time
  *in this state*, and therefore carries a much longer threshold (56 days vs 28). It must
  **not** be backfilled from `updatedAt`: that moves when somebody corrects a typo, so the
  figure would look freshest for exactly the claims being fussed over.

---

## 10. Integrations

### 10.1 Moodle (`moodle.js`, `moodleAttendance.js`) — the only one that imports

**One way only: Moodle → Staff Hub.** Nothing is written back and nothing is deleted. A
re-run updates what it created before, matched on the stored `moodle*` ids.

The mapping:

```
Moodle course                        → Course
  section "Unit 1 - …"               →   Unit
    lti activity (grade item)        →     Assessment
enrolled user with role "student"    → Student + Enrolment
that user's grade for an item        → AssessmentGrade
```

Notable mechanics:

- Sections that are not units (Introduction, Study Skills, Library) are ignored, as are
  the Moodle attendance grade item and the course-total item.
- Year/term placement is read **structurally**: a section named `"Year 1 - Term 1"` holds
  one `subsection` activity per unit whose `customdata` points at that unit's section id.
  Matching on the **id** rather than the repeated unit name matters, because the same unit
  name appears in several courses with inconsistent punctuation.
- Where Moodle does *not* place a unit, the existing year/term is **left alone**.
  Previously it wrote null every run, so a placement an admin set by hand — which the sync's
  own note tells them to do — was wiped again at 02:00 night after night.
- A same-named course is adopted **only if unclaimed**. Two Moodle courses sharing a
  `fullname` both adopted one row and rewrote `moodleCourseId`, so a Staff Hub course
  flip-flopped between them on alternate nights, merging two intakes' registers into one.
- Every branch is individually guarded, because `Course.name` is `@unique` and a colliding
  rename threw P2002 straight out of the sync, **abandoning every course after it** — no
  marks, no attendance, for the whole night.
- `CALL_TIMEOUT_MS = 120000`. Without a deadline a stalled VLE pinned the in-flight lock:
  status reported "running" indefinitely, every later sync 409'd, the nightly job skipped
  every night, and only a restart recovered — with nothing logged. `sweepStaleRuns()`
  resolves abandoned runs, and it is called **before** the nightly dedupe counts them,
  because a ghost "running" row otherwise reads as "tonight's run already happened".
- Moodle answers HTTP 200 with an exception object rather than an error code, so the
  response body is checked.
- `dryRun` performs every lookup and reports exactly what *would* change.
- **Everything the sync touched is flagged for rescoring once, at the end** — a `Set`,
  flushed in one call, because flagging per write would be a query per mark. Where a change
  moves a *denominator* rather than one person's mark, the whole unit cohort is flagged.
- **VLE engagement costs no extra Moodle calls**: `core_enrol_get_enrolled_users` is
  already issued once per course and `lastcourseaccess` is already in the response. **A row
  means "we looked"** — observed-but-inactive is `accessed: false`, unobservable is *no row
  at all*. This is the one place where absence *is* the institution guard, because no count
  can separate a disengaged cohort from a Moodle with `$CFG->hiddenuserfields` set from a
  college that teaches face to face — all three are zero. The engagement denominator is
  **days**, not rows: a student on four units gets four rows a day, and counting rows makes
  someone who opens one course of four every day look 75% disengaged.

### 10.2 Canvas and Blackboard — connection tests only

`vle/canvas.js` and `vle/blackboard.js` are complete, careful HTTP clients — pagination,
concurrency limits, rate-limit detection — but **neither makes a single Prisma call**.
They are reachable only from `POST /api/integrations/:provider/test`. There is no importer
behind either.

Both files record decisions worth keeping:

- **Canvas** uses a manual access token, and says why OAuth is not used *yet*: this is one
  administrator configuring their own institution's sync as themselves, which is the narrow
  case Canvas's API policy is not aimed at. "If this ever grows into asking individual
  tutors for tokens, that is the point at which OAuth stops being optional." Canvas's
  throttled response is **403, not 429** (429 is behind a per-instance flag that ships off),
  and 403 is also permission-denied — so `isRateLimited()` reads the body and the
  `X-Rate-Limit-Remaining` header instead of the status.
- **Blackboard** needs a second person at the customer: their own Learn administrator must
  create a REST API Integration quoting the Application ID and nominating a Learn user.
  Until they do, every token request is 401 no matter how correct the key and secret are —
  so the setup text says so and the 401 message names it. Two entitlements are
  counter-intuitive: reading gradebook *attempts* needs `course.gradebook.MODIFY` (a write
  entitlement gating a read), and attendance needs `course.attendance.VIEW`. A service
  account short of either produces a sync that connects, runs, and silently returns nothing.

Canvas and Blackboard are separate providers rather than one "VLE" row with a type field
because a college mid-migration needs both sets of credentials live at once.

### 10.3 Email (`email.js`, `mailFrom.js`)

Two transports: **Resend** over HTTPS (preferred where set, because Render's free tier
blocks outbound SMTP) and **nodemailer/SMTP**. With neither configured, messages are
printed to the console and the app still runs — "that keeps `npm run dev` working out of
the box while making the production path a config change rather than a code change."

`FROM` is resolved **per send**, not once at require time. It was a module-level constant,
"which is the whole defect in miniature: whichever institution the server was configured
for became the sender for every other institution on the platform." Order: what this
college saved → its SMTP username if that is an address → the server-wide setting → a
deliberately undeliverable `no-reply@localhost`. There is no fallback *domain*: "a bounce
nobody owns is a better failure than a letter signed by the wrong institution, and it
surfaces on the first send rather than months later in somebody else's inbox."

Sending is always best-effort and never throws into the caller.

---

## 11. Background work

Three in-process schedulers, all started from `index.js`, all fanned out with
`forEachTenant`, all ticking **hourly** with a guard inside deciding whether this hour is
the one. No external cron service is needed.

| Scheduler | When | What |
|---|---|---|
| `scheduler.js` | hourly | timesheet month-end reminders (the day **before** month end) + the **02:00** Moodle import |
| `attendanceScheduler.js` | hourly | month-end banded attendance emails, on the last calendar day at/after `sendHour` |
| `notificationsScheduler.js` | hourly | at **08:00**: birthdays, bank-holiday closures, assessment-deadline reminders |

Every job is idempotent by construction:

- The timesheet reminder de-dupes against the **notifications table** on its **own** link
  (`timesheet:reminder`) within a 2-day window. It used to match the shared `"timesheet"`
  link, which the review outcomes also use — so a staff member whose timesheet was bounced
  back yesterday matched the dedupe and was skipped: "the one person who provably had an
  unsent timesheet was the one person never reminded to send it." It also selects on
  `pendingActivation: false` rather than `accountRole: "STAFF"`, because being granted any
  single admin page flips an account to ADMIN — so a lecturer who also manages one
  dashboard section had stopped receiving reminders entirely, for ever.
- The nightly Moodle import de-dupes on `MoodleSync` rows in the last 12 hours with
  `status ∈ {ok, failed}` — "a run that never finished is not a run that happened". The
  **institution's own** `autoSync` setting now decides; `MOODLE_AUTO_SYNC` is only the
  fallback for a deployment that has saved nothing. Before that fix, `TenantIntegration.
  autoSync` was saved by the Settings screen and read by nothing.
- The three daily notification jobs de-dupe through the `SentNotification` ledger on a
  stable key, so a restart, a double tick or a re-run in the same hour cannot double-send.
- **All three read the London clock**, not the host's. `notificationsScheduler` used
  `new Date().getHours()`, which on a UTC host meant the "08:00" emails actually went out
  at 09:00 through BST and the comment above them was a lie for half the year.

Timers are `unref()`'d where appropriate so they never keep the process alive on their own.

---

## 12. Audit (`audit.js`)

Two rules govern everything:

1. **An audit failure must never break the action it was recording.** `record()` is
   fire-and-forget, callers do not await it, and it cannot reject. "A system that refuses
   to work when it cannot write history is worse than one with a gap in its history."
2. **Nothing secret is ever written.** Diffs pass through a redactor first, because "what
   changed" on a staff record includes `passwordHash`, and an audit log is read by more
   people, kept for longer, and exported more often than the table it describes.

Mechanics: `SECRET_FIELDS` is matched case-insensitively on the whole field name (so
`passwordHash` is caught but `passwordChangedAt` — a useful thing to see change — is not).
The secret check happens in `diff()` **as well as** in `redact()`, because `redact()` only
consults the list while walking an object's entries and `diff()` hands it a *value* already
separated from its key — so a top-level secret arrived as a bare string with nothing to
match on, and passing a whole Staff row wrote the bcrypt hash straight into the log.
Values are truncated at 500 characters, objects at 40 keys, depth at 4.

`actorType` is one of `platform | staff | student | applicant | anonymous | system`, because
`actorId` alone is ambiguous — a `PlatformAdmin` is not a `Staff` row, and a Student id and
a Staff id come from different tables. `audit.anonymous(email)` files a failed sign-in
against the address that was claimed; `audit.asActor(row, kind)` files the events that
happen *before* a session exists (a successful sign-in, an invitation accepted, a reset link
followed) — "without it those would all be filed as 'system', which is precisely the wrong
answer for the events a security reviewer looks at first."

The write is `crossTenant()` with an **explicit** `tenantId`: a platform operator acts
outside any tenant scope, but the row belongs to the institution they affected. A dropped
entry is logged loudly to the console rather than silently discarded.

`GET /api/audit` is gated on the same pages the trail describes.

---

## 13. The platform operator tier

`routes/platform.js` (~918 lines), mounted above the tenant middleware.

- Sign-in is password → optional TOTP challenge → 8-hour session. Every read is
  `crossTenant`.
- **Tenants**: create, suspend/reactivate (`PUT /tenants/:id/active`), delete. Creating one
  calls `tenant.forget(slug)` to drop the cache.
- **Operators**: create, deactivate. There are guards against deactivating yourself or the
  last operator. There is **no delete**, and the reasoning is written into the route; there
  is also no password reset and no self-service bootstrap — `create-platform-admin.js` on
  the server command line is the only way to make the first one, and the dashboard says so
  on screen.
- **`GET /usage`** (`usage.js`) apportions database size per tenant. It is an **estimate**
  and is labelled as one everywhere it surfaces, because every institution's rows live in
  the same tables: Postgres knows the size of the `Student` table, not which slice belongs
  to which college, and the exact answer is a full scan of the whole database per call.
  So: real on-disk size (heap + indexes + TOAST) ÷ row count × that tenant's rows. Tables
  carrying `tenantId` are **discovered** from `information_schema`, not hand-listed, so a
  new one counts automatically. Least accurate on small tables (Postgres allocates a
  minimum 8 KB page) and wide rows; dead tuples awaiting VACUUM are counted because they
  genuinely occupy disk. **File storage is not an estimate** — those bytes are recorded on
  the rows and summed directly, and reported separately, because "a college with 4 GB of
  scanned passports has a tiny database and a large footprint."
- **`GET /monitoring`**, **`GET /health`** — cross-tenant operational views.
- **`PUT /tenants/:id/admins/:staffId/password`** — the support path into a customer.

### College self-registration (`routes/registrations.js`)

Two of these routes are **public**. The control has a deliberate shape:

> Filling in a form grants nothing. An application becomes a live institution only when
> **both** an operator approved it and issued an access code, **and** the applicant
> redeemed that code.

Two different people agreeing, rather than one form being submitted. Either half alone is
worthless. The access code is stored hashed with an expiry and an attempt counter; the
public submit endpoint carries an in-process limiter (5 per hour per IP, with a size sweep
so the map cannot leak). Slugs are validated against a regex and a reserved list
(`www, api, app, admin, staging, platform, default, test`).

---

## 14. The client

React 18 + Vite, one SPA serving **five** distinct surfaces, chosen in `App.jsx` from the
signed-in user's `kind` and the front-door `Landing` choice:

| Surface | Component | Who |
|---|---|---|
| Staff app (phone-first) | `StaffHub.StaffApp` | staff |
| Admin dashboard (33 tabs) | `StaffHub.AdminDashboard` | admins, by page grant |
| Student app | `StudentApp` | students |
| Applicant portal | `ApplicantPortal` | applicants |
| Platform dashboard | `PlatformDashboard` | operators |

Plus token-driven public pages: `AcceptInvite`, `ResetPassword`, `AdmissionUpload`,
`AdmissionOffer`, `AdmissionApply`, `CollegeRegistration`, `DeleteAccount`.

`StaffHub.jsx` is ~14,360 lines and holds both the staff app and the whole admin console.

**`api.js`** is the only place that talks to the server:

- **Base URL**: `VITE_API_URL` wins; otherwise follow the page's own host on port 4000 (so
  opening the dev client at `http://192.168.1.5:5173` on a phone just works); otherwise
  localhost. A packaged mobile app **must** set `VITE_API_URL`, because "localhost" inside
  the app means the phone.
- **Tenant**: `?tenant=slug` (remembered) → remembered choice → `VITE_TENANT` → nothing.
  Deliberately **not sent** when the host already carries the tenant as a subdomain — the
  header would override it and a stale remembered slug could quietly point someone at the
  wrong college. `setTenant()` also clears the token, because a token from one institution
  is rejected by another.
- **Token storage differs by platform**: native app → `sessionStorage` (survives
  backgrounding, but a killed app starts empty, so reopening requires signing in); web/PWA
  → `localStorage`. On native, any token left by an older persistent build is discarded on
  load.
- **Every request has a 30 s deadline.** Without one, a weak signal or a cold-starting
  free-tier server left the app awaiting a promise that never settled — a skeleton screen
  forever, with no error and no way to retry. An abort is reported as a timeout, because
  the two need different things from the user.
- `cache: "no-store"` on every call, because a mobile WebView can otherwise return stale
  data after a mutation's refetch.

Other client mechanics: `branding.js` fetches `/api/branding` before React mounts and
repaints when it arrives (blocking first paint on a decorative fetch would trade a colour
for a blank screen); `biometric.js` + `BiometricGate` add an app lock in front of
everything a signed-in user can see; `backButton.js` maps Android hardware back onto
overlays and tabs; `nfc.js` wraps `@capgo/capacitor-nfc`; `push.js` registers FCM tokens;
an `ErrorBoundary` in `main.jsx` turns a crash into a recoverable screen with the message
in a collapsed `<details>`, because "something went wrong" alone is impossible to act on.

**There is no client-side test framework at all.** `StaffHub.jsx` and the platform
dashboard are verified only by building.

---

## 15. Testing

**Pure logic lives in its own file with tests beside it and no database** — everything in
`src/prediction/` and `src/vle/*Normalise.js`, plus `attendanceTap`, `attendanceQr`,
`attendanceTapSettings`, `linkRules`, `dateText`. Run from `server/`:

```bash
node --test "src/**/*.test.js"          # all of them
node --test src/prediction/engine.test.js
```

**Use the glob, not `node --test src/`.** Given a bare directory the runner walks into
`src/index.js`, which binds a port and starts the schedulers, and the run never terminates.

**Everything else is covered by 26 HTTP smoke suites** in `scripts/`, deliberately weighted
toward **negative** assertions: who is refused, what never leaves the building, which
decisions cannot be made twice. `npm test` applies migrations, seeds fixtures, boots its
own API on port 4010, runs every `scripts/smoke-*.mjs` against it, and exits non-zero if
any failed. `SKIP` reads differently from `PASS` on purpose, so a switched-off feature stays
visible instead of counting as coverage. `smoke-push-transport.mjs` is standalone — it
stands in for Google's endpoints itself and needs no database.

`scripts/test.mjs` refuses to run without `DATABASE_URL` and calls
`prisma/assertDisposable.js` **before** applying migrations, so the refusal arrives before
a schema change lands somewhere you did not mean it to.

Two schema-level guards worth knowing:

- **`prediction/schema-contract.test.js`** parses `schema.prisma` and fails if anything the
  engine can emit as `null` lands in a NOT NULL column. A new figure must be nullable on
  **both** `StudentPredictionCurrent` and `StudentPredictionHistory`, and identically so.
  It also reads `metrics.js` **as text** and fails if `category` or `detail` appear in the
  mitigating-circumstances select, and asserts the five-plus `TRIP_` vocabularies are
  disjoint.
- **`vle/normaliseContract.test.js`** pins the normaliser contracts.

**When adding a regression test, prove it can fail**: reintroduce the bug and confirm the
test catches it. Twice in recent work a test passed while discriminating nothing.

### The database is the sharpest edge here

- **`DATABASE_URL` in `server/.env` points at a live database, not a scratch copy.** Check
  where it points before running anything that migrates, seeds or tests.
- There are **two databases in two Supabase projects** (staging and production). They
  drift; fixing one by hand means checking the other.
- **Use the local Postgres.** `postgresql-x64-16` answers on `127.0.0.1:5432`:

  ```bash
  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
  ```

  `edtech_dev` is safe on two counts: `localhost` is in `LOCAL_HOSTS`, and `dev` matches the
  disposable-name regex. **Always pass `DATABASE_URL` on the command line.**
- An isolated **schema** in the remote database is **not** a safe fallback:
  `assertDisposable` parses only the host and the database name and never looks at
  `?schema=`, so the only way past it is a `DESTRUCTIVE_DB_CONFIRM` token which — because
  the schema is not part of it — equally authorises seeding straight over `public`.

---

## 16. Deployment

- `main` → **staging**, `production` branch → **production**. Render for the API, Vercel for
  the client; two frontends and two APIs as separate services.
- `render.yaml` declares the API: `rootDir: server`, `buildCommand: npm install && npm run
  migrate:deploy`, `startCommand: npm start`, `healthCheckPath: /api/health`,
  `branch: production` stated **explicitly** (this repo has two deploy branches, so the
  default is the last thing that should be decided by accident). **A Blueprint only applies
  its settings when a service is created** — editing the file does not move an existing
  service.
- **`/api/health` answers 200 on *any* build and proves nothing about which code is
  running.** To tell whether a deploy landed, probe a route only the new code has: **401
  means mounted, 404 means not deployed**, with an existing route as the control.
- **Never rename a migration directory once it has been applied anywhere.** Prisma
  identifies a migration by directory name; a rename makes an applied migration look new, it
  re-runs, hits "already exists", and is recorded as failed — after which Prisma refuses
  *every* later migration with P3009. Since `migrate:deploy` runs in the deploy build
  command, every deploy then fails while the old build keeps serving happily. **This has
  happened twice.** `server/tools/resolve-failed-migration.js` is the guarded remedy: it
  verifies every object the failed migration creates already exists before marking it
  applied, and refuses otherwise.
- Mobile builds go through Capacitor (`codemagic.yaml` for CI); `MOBILE.md` covers the
  packaging, including the standing note that the JWT in WebView `localStorage` is not the
  Keychain / Android Keystore.

### Environment variables that change behaviour

| Variable | Effect |
|---|---|
| `DATABASE_URL` | **the** sharp edge (§15) |
| `JWT_SECRET` | mandatory in production; no fallback |
| `JWT_EXPIRES` / `PLATFORM_JWT_EXPIRES` | session lifetimes (1d / 8h) |
| `CREDENTIALS_KEY` | 32 bytes (hex or base64). Without it **no college can save an integration at all**, and the failure surfaces only when one tries. Rotating it makes every stored secret unreadable. |
| `DEFAULT_TENANT_SLUG` | the fallback tenant **and** the only tenant that may inherit host-level `MOODLE_*` / `SMTP_*` / `SP_*`. Blank disables that inheritance entirely — the right setting for a genuine multi-tenant deployment. |
| `TENANT_BASE_DOMAIN` | enables subdomain tenant resolution, and *only* under this domain |
| `TENANT_CACHE_MS` | 60 s default; CI sets 0 |
| `APP_TIMEZONE` | the organisation's wall clock (default `Europe/London`) |
| `CORS_ORIGINS` / `CLIENT_URL` | allowed browser origins |
| `RESEND_API_KEY` or `SMTP_*` | without either, mail is printed to the console |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_BUCKET` | staff document storage (bucket must be private) |
| `MOODLE_AUTO_SYNC` | server-wide default for the nightly import, overridden per college |
| `KEEPALIVE_URL` / `KEEPALIVE_MINUTES` | free-tier cold-start prevention; `off` disables |

---

## 17. What is built but dark, and what is known to be missing

Read alongside `STATUS.md` §6, which is the maintained list.

**Built, tested, not reachable**
- **Rotating QR check-in** — `attendanceQr.js` is complete and unit-tested; no route
  imports it and `qrEnabled` defaults false (§6.6).
- **Canvas and Blackboard** — full HTTP clients with connection tests, but **no importer**;
  neither makes a Prisma call (§10.2).

**Reachable but structurally silent today**
- **`AssessmentSubmission` is written by nothing**, so `submissionRate`, `onTimeRate` and
  `TRIP_UNMARKED_WORK` have no source. `submissionsRecorded` is false everywhere, which is
  the guard working.
- **`HndSession.kind` is empty on every row in both databases**, so every session-kind
  figure is null. Likewise `earlyStartBeforeMinutes` (09:30): every session on both
  databases starts at 10:00, 14:00 or 18:00, so nothing is "early" and the three
  early-start figures are null for everyone.
- **`SlcApplication.studentId` and `Admission.linkedStudentId` are unpopulated**, so
  `slcRecorded`, `ismRecorded` and `idExpiryRecorded` are all false and every funding and
  intake figure stays null. Correct, not broken — and `linkRules.js` is the machinery that
  will decide those links when a backfill runs.

**Known gaps**
- **Three literals of one college's identity survive in `StaffHub.jsx`** (defect T5b) — an
  address rendered in the App-info card, the admin identity card and the Admissions help
  text. The server side is clean.
- **No client test framework**, at all.
- **`seed-admissions.js` constructs a bare `PrismaClient`** and so bypasses isolation
  (defect T8b); several `server/tools/` scripts now *throw* rather than write unscoped,
  which is the right failure but means they do not currently run.
- **In-process rate limiters and locks** do not survive clustering.
- **Operators cannot be password-reset**, and the first one can only be created from the
  server command line (defect T6b).
- **Two hand-maintained copies of `ADMIN_PAGES`** (server `validate.js` / client
  `StaffHub.jsx`), plus `PAGE_LABELS` and `allNav` in the client — joined only by a
  dev-only console warning.

---

## 18. The shortest possible summary

- **`db.js` is the security model.** A query with no tenant refuses to run.
- **`auth.js`'s router allowlists are the second one.** Students and applicants cannot
  reach a router that did not name them.
- **Null is not zero, everywhere.** Unmeasured figures leave both sides of every fraction.
- **Store dates, derive day-counts at render time.** Nothing recalculates on a clock.
- **Allowlist on the way out.** Every serialiser names what leaves; nothing is stripped.
- **Institution-wide questions are asked once per run, hoisted.** Deciding "does this
  college record this at all" from a chunk is the mistake this codebase has made three
  times.
- **Features that write to a record ship switched off**, and every threshold that is really
  a college's policy is a per-tenant setting rather than a constant.
