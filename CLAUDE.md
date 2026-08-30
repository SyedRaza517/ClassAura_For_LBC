# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A college management platform, sold as **one deployment per institution**: one server,
one database, one college. Three identity kinds exist and are enforced separately:
**staff**, **student** and **applicant**.

It was multi-tenant until 30 Aug 2026, and that matters more than a removed feature
usually would — see *It was multi-tenant, and the code still shows it* below, because
that history is the reason for several conventions that otherwise look like overkill.

npm workspaces monorepo: `server/` (Express + Prisma + PostgreSQL), `client/` (React 18
+ Vite SPA, wrapped by Capacitor for iOS/Android), `scripts/` (test runner and suites).

Read `STATUS.md` first for what is actually built and what is not — it is maintained as
the honest map and is explicit about which claims are demonstrated versus code-read.
`API.md` is the endpoint reference.

## Commands

```bash
npm run dev                        # server + client together
npm test                           # unit tests, then every smoke suite (see below)
npm test -- smoke-invite           # one suite, matched on name

npm run --workspace client build   # the client build; also what Vercel runs
npm --workspace server run migrate:deploy   # forward-only migrations
npm --workspace server run generate         # prisma generate
```

Unit tests, from `server/`:

```bash
node --test "src/**/*.test.js"          # all of them
node --test src/prediction/engine.test.js  # one file
```

**Use the glob, not `node --test src/`.** Given a bare directory the runner walks into
`src/index.js`, which binds a port and starts the schedulers, and the run never
terminates.

`npm test` applies migrations, seeds fixtures, boots its own API on port 4010, runs
every `scripts/smoke-*.mjs` against it, and exits non-zero if any failed. `SKIP` reads
differently from `PASS` on purpose, so a switched-off feature stays visible instead of
counting as coverage.

## The database is the sharpest edge here

**`DATABASE_URL` in `server/.env` points at a live database, not a scratch copy.** The
smoke suites create, mutate and delete real rows, and `npm test` seeds fixtures. Check
where it points before running anything that migrates, seeds or tests.

`prisma/assertDisposable.js` guards this, but read its rules before relying on it — it
allows any database whose *name* looks disposable, which has not always matched the
database that actually was.

There are **two databases, in two Supabase projects**: staging and production. They
drift. When you fix one by hand, check the other.

**There is a local PostgreSQL on the development machine, and the whole suite runs
against it.** Two services are installed (`postgresql-x64-16`, `postgresql-x64-18`) and
16.13 answers on `127.0.0.1:5432` with the credentials `server/.env.example` documents.
This is the route to use:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

Create it once with `CREATE DATABASE edtech_dev`, then `npx prisma migrate deploy` with
the same URL. `edtech_dev` is safe on two counts at once — `localhost` is in
`LOCAL_HOSTS`, and `dev` matches the disposable-name regex.

**Always pass `DATABASE_URL` on the command line. Never let it fall through to
`server/.env`.**

An isolated **schema** in the remote database was previously documented here as the safe
fallback. It is not, and the reason matters: **`assertDisposable` parses only the host
and the database name — it never looks at `?schema=`.** So
`…/postgres?schema=smoketest` fails the guard exactly as `public` does, and the only way
past is `DESTRUCTIVE_DB_CONFIRM=postgres@<supabase-host>` — a token which, because the
schema is not part of it, equally authorises seeding straight over `public`. One dropped
query parameter between typing the token and running the command is the whole live
database. Use the local one.

**Never rename a migration directory once it has been applied anywhere.** Prisma
identifies a migration by directory name; a rename makes an applied migration look new,
it re-runs, hits "already exists", and is recorded as failed — after which Prisma
refuses *every* later migration with P3009. Since `migrate:deploy` runs in the deploy
build command, every deploy then fails while the old build keeps serving happily. This
has happened twice. `server/tools/resolve-failed-migration.js` is the guarded remedy:
it verifies every object the failed migration creates already exists before marking it
applied, and refuses otherwise.

**The de-tenanting migration refuses to run against a database holding more than one
`Tenant` row**, and that guard is not negotiable.
`prisma/migrations/20260830T210000_remove_multi_tenancy` drops `tenantId`, which is half
of 18 unique constraints. Where two institutions share a student number or an email, the
plain unique cannot be created and the migration fails — an ordinary, recoverable
failure. Where it *succeeds*, the drop does not separate the institutions, it **merges**
them: every student, register and pastoral note lands in one undifferentiated pile, and
the only record of who belonged to whom is the column just dropped. That second outcome
is unrecoverable from the data afterwards, so the migration raises before any destructive
statement rather than trusting that the database holds one college. Postgres runs it in a
transaction, so the raise leaves nothing half-applied. If it fires, the fix is to split
the database or delete the surplus tenants deliberately — never to weaken the check.

## It was multi-tenant, and the code still shows it

Until 30 Aug 2026 one deployment served every college out of one database, so isolation
was a property of the *code*: a single query that forgot `tenantId` was a cross-tenant
data leak. Rather than ask ~200 endpoints to remember a filter, `server/src/db.js`
extended the Prisma client so every query was filtered and stamped by the current tenant,
and a query issued with no tenant at all threw (`TenantScopeError`) rather than quietly
returning everyone's rows. `tenantMiddleware` resolved an `X-Tenant` header → subdomain →
`DEFAULT_TENANT_SLUG` before authentication, because `Staff.email` was unique only *per
tenant*; sessions carried a `tid` claim so a token from college A could not be replayed
against college B; and a supplier-facing **platform operator** tier sat above every
institution, mounted above the middleware because an operator was not an institution.

**All of that is gone.** `db.js` is a plain `PrismaClient`. `tenant.js`, `eachTenant.js`,
`platformAuth.js`, `routes/platform.js` and `routes/registrations.js` are deleted, as are
`runInTenant`, `crossTenant`, `TenantScopeError`, the `X-Tenant` header, subdomain
resolution and the `PlatformDashboard` / `CollegeRegistration` client screens. Isolation
is now a property of the **infrastructure**: a query that forgets a filter can only reach
rows belonging to the institution whose server it is running on, because there are no
others.

Why this is worth knowing rather than merely deleting:

- **It explains the shape of a lot of code.** Allowlisted serialisers, configuration
  held in the database instead of constants, per-send resolution of the mail `FROM`
  address rather than a module-level one, branding fallbacks that deliberately belong to
  nobody — all written against a failure mode where the wrong college's identity leaks
  into another college's letter. They are cheap, they are still correct, and none of them
  should be unwound on the grounds that there is only one college now. (The caches that
  had to be keyed by tenant — SharePoint's token, site, drive and root folder — are
  single slots again, because a `Map` that only ever holds one entry is not a `Map`.)
- **Comments across `server/src` describe both states on purpose.** Files say what used
  to be there and why it isn't, in the house style. That is not stale text to tidy away.
- **`Tenant` survives**, as the single institution settings row rather than a registry.
  Its only remaining reader is a display-name fallback in `branding.js`. Deleting it was
  the rejected option: a single `Tenant` row already *is* the singleton settings table
  the alternative would have had to build.
- **The coverage given up is real.** `smoke-tenant-isolation.mjs`, `smoke-platform.mjs`
  and `smoke-registrations.mjs` were deleted rather than adapted, because with no tenancy
  their assertions would pass while discriminating nothing — which reads as coverage on
  the summary line. If this ever serves two institutions from one database again, `db.js`
  and those suites are what has to come back **first**, before any route is written
  against the shared database. Both are in git history at the commit that removed them.

## Access control

- `requirePage("…")` gates admin pages. The grantable list is `ADMIN_PAGES` in
  `server/src/validate.js` and **must stay in sync with `ADMIN_PAGES` in
  `client/src/StaffHub.jsx`** — two hand-maintained copies.
- Student and applicant tokens are confined by router allowlists (`STUDENT_ROUTERS`,
  `APPLICANT_ROUTERS` in `auth.js`), not by per-route checks.
- The `tid` claim is neither issued nor checked any more. It is **ignored, not
  rejected**: every session in the wild at the moment of the deploy carries one, and
  treating its presence as invalid would sign out every member of staff and every student
  at once, mid-term, for a change that is otherwise invisible to them.

## Per-institution configuration, not hardcoded identity

**This is still true, and still the pattern to match.** The college supplies its own
integrations, branding, letters, email wording and academic thresholds; what changed is
that there is one college rather than many. Configuration did **not** move to environment
variables when tenancy went, and should not: an administrator changes these from the
Settings screen, and a value only changeable by a deploy is not a setting.

> platform defaults in code → one JSON column merged over them → no row until the
> college edits something → an allowlist on the way out → a short cache invalidated on
> save.

`attendanceBandConfig.js` and `prediction/settings.js` are the reference
implementations. Integration secrets are AES-256-GCM encrypted at rest via
`secrets.js`; the secret is never returned to any client.

**The single-row guarantee is now a constant primary key.** `TenantBranding`,
`AttendanceBandConfig`, `PredictionModelSettings`, `AttendanceTapConfig` and
`TimetableSettings` each held one row per institution, guaranteed by `@@unique([tenantId])`.
That column is gone, so `id String @id @default("singleton")` is what replaced it, and the
save path **upserts on the literal `"singleton"`**. Not find-then-create: that is not
atomic, so two administrators saving at the same moment both find nothing, both insert,
and `findFirst` afterwards returns whichever row the planner picks — a college's branding,
attendance bands or progression thresholds becoming a coin toss between two rows. The
constant key makes the second writer collide with the first instead, which is the whole
point of it. Reads stay on `findFirst`, because a read that must not create a row should
not be able to, and the key is what guarantees there is at most one row to find. Any sixth
config table of this shape wants the same two halves.

`integrationConfig.js` holds the provider registry (`moodle`, `canvas`, `blackboard`,
`email`, `sharepoint`). Precedence is: what the college saved through Settings, then
`process.env`. That env fallback **used to be fenced** to the single tenant named by
`DEFAULT_TENANT_SLUG`, because `MOODLE_*` / `SMTP_*` / `SP_*` describe one institution's
systems and handing them to a college that had not configured its own is how a student
receives an offer letter "from" the wrong institution. The fence is gone, and correctly:
the host's environment now describes the only institution there is, so inheriting it is
right rather than a leak. A deployment configured entirely by environment keeps working
unchanged.

## Conventions that are load-bearing

**Null means "not measurable"; zero means zero.** Throughout the academic and
prediction code, a figure that could not be measured is `null` and is excluded from
denominators — never coerced to 0. A student whose register was never taken has no
attendance percentage, and scoring that as 0 puts them top of a risk list for something
nobody measured. Match this when adding columns: make them nullable.

**Serialise through allowlists, never blocklists.** `sAdmission` once stripped a fixed
list of secrets, so every column added afterwards shipped to the browser by default.

**Rate limiters and locks are in-process** module-level `Map`s. Correct for one Node
process; a clustered deployment needs Redis. Each one says so in a comment.

**Dates are strings.** `YYYY-MM-DD` for academic dates, compared as strings.
`src/clock.js` pins `APP_TIMEZONE` — never use the host clock for a user-facing date.

**Comments explain WHY**, often at length, including why an alternative was rejected.
Match that density; it is the house style and it is load-bearing.

## Tripwires: a second layer beside the progression score

**They cannot move the band, and that is structural.** `prediction/tripwires.js` appends
`TRIP_*` codes to `riskDriverCodes` — the same array carrying the engine's six RED
indicators. OVR-004 worsens a band on `redIndicatorCount`, which `engine.js` derives from
its own internal `reds` array; `riskDriverCodes` is a copy taken afterwards, so nothing
appended here can reach the override. The prefix keeps that visible: a code named
`RED_`-something would read as the engine's, and anyone later taking the count from the
copy silently wires tripwires into banding. Keep the prefix, and keep the count off the
copy.

**Store dates; derive day-counts at render time.** Nothing in this feature runs on a
schedule — `markStale()` fires on data events, and a day passing is not an event. "19 days
since last attended" written to a column is wrong by the next morning with nothing to
correct it, while `lastAttendedOn` is true forever. Columns hold dates; the screen
subtracts.

**"Does this college record this field at all" is an institution-wide question, and
computing it from the chunk is the most repeated bug in this area.** `gather()` runs on
chunks of 200, and the ordinary incremental path scores only the handful of students
`markStale` flagged — often one. One student with no late marks is ordinary; a college
whose Moodle plugin has no "L" acronym records no lateness at all, and only the second
makes `latenessRate` `null` ("not recorded") rather than `0.0` ("never late"). Five guards
share this shape — lateness, excused absence (no "E"), submission dates in the feed,
whether `AssessmentSubmission` is populated, and whether the pastoral module is used. That
last one, decided per chunk, suppressed `TRIP_NO_PASTORAL_CONTACT` for exactly the students
it exists to find, because a chunk of never-contacted students contains no contacts. Probe
once per run, unfiltered by student, hoisted out of the chunk loop. This has been got wrong
three times.

**Some signals exist to suppress.** `weeksIntoProgramme` mutes the disengagement codes
inside a settling-in period, because in week one nobody has attendance history, marks or a
pastoral record, and a caseload containing the whole intake is the same as no caseload. An
*unknown* programme age is deliberately not exempt — muting every code for a student the
calendar cannot place fails safe in the wrong direction.

**Two tables are dead ends.** `AssessmentSubmission` is written by *nothing* — no VLE
adapter, no importer — so a signal reading it measures the integration, not the student.
`Admission` and `SlcApplication` hold a student's name and typed college ID as plain
strings with no relation to `Student`, so nothing on them is reachable from this pipeline,
however useful the columns look.

**"Outcome" means two different things and the collision has caused three bugs.** An
intervention's `outcome` is the response to something staff did; a `StudentOutcome` is what
became of the student. Two vocabularies (`OUTCOMES`, `STUDENT_OUTCOMES`), and a fix aimed
at one has twice landed on the other. Name the variable for which one you mean.

**Nullability is a contract enforced across two tables.** `schema-contract.test.js` parses
`schema.prisma` and fails if anything the engine can emit as `null` lands in a NOT NULL
column. A new figure must be nullable on **both** `StudentPredictionCurrent` and
`StudentPredictionHistory`, and identically so.

## Mitigating circumstances: the engine knows THAT, never WHY

**A claim is Article 9 health data and the schema is split around that.** `status`,
`coversFrom`, `coversTo`, `coversAttendance` and the adjustments say WHAT the college
decided; `category` and `detail` say WHY. The prediction pipeline selects the first group
and nothing else. `schema-contract.test.js` reads `metrics.js` as text and fails if
`category` or `detail` appear in that select, because the rule lives in exactly one place
and that is the kind of rule a later reader widens for a screen they are building. Same
reason the audit summary names the student and the decision but never the reason — the
audit log is read on Settings by admins never granted this page.

**A suppressed assessment leaves BOTH sides of every fraction.** Never counted as
submitted, never as on time, never as missing. This is null-is-not-zero pointed the other
way, and getting it backwards is the MIRROR of the bug the feature fixes: counting an
extended assessment as handed in on time inflates the score of a student in real
difficulty and quietly removes them from the register. Excluded work must leave a list
entirely rather than arrive with a null date — a null `dueDate` reads as "nothing to be
late against", which counts the piece as on time.

**Attendance cover keeps two lists.** Covered sessions leave the percentages. They stay in
`lastAttendedOn`, the absence streak, the weekly pattern and every pastoral code: a student
on approved mitigating circumstances is one the college should be speaking to MORE, and a
sponsoring provider still has to evidence engagement.

**An undecided claim suppresses, and that is a setting rather than a constant.**
`pendingClaimSuppresses`. With a claim pending, "did this student fail to hand work in" is
not a question about the student — the answer depends on a decision the institution has not
taken, and counting it against them punishes the student for the length of the college's
own decision queue. But a college whose regulations say otherwise is entitled to say so,
and hardcoding one reading of somebody else's regulations is the worse failure.

## Cohort standing and register coverage

**The cohort population and the timetable probe are both built ONCE per run, hoisted.** The
population comes from `StudentPredictionCurrent`, institution-wide, unfiltered by the stale
set — which is one run behind for students being rescored, and that is the lesser evil
against a second implementation of the points model drifting from `attendance.js`.
`cohortSize` is STORED so the classic failure stays detectable: a population size exactly
equal to the chunk size is the fingerprint of it having been built from the chunk.

**The timetable probe counts sessions with NO marks, not sessions.** `count(HndSession) > 0`
is true at every college that ever took one register, because `AttendanceMark.sessionId` is
NOT NULL. If sessions only exist once somebody takes a register, scheduled and marked are
the same set by construction and coverage reads 100% for everybody — manufactured
reassurance, which is the harder mirror of the failure the figure exists to catch.

**`registerCoverage` needs `sessionId` on every mark and refuses without it.** A mark that
cannot be tied to a session cannot be reconciled against the scheduled set, so it returns
null rather than reporting a college with a perfect register as having taken none of it.
The first wiring omitted `sessionId` from the select, and that guard is what caught it —
the marks are flattened from `session.date`, so it is easy to forget the id comes from the
mark itself.

**A signal that fires for a whole cohort at once is a FIGURE, not a code.**
`riskDriverCodes` is a per-student caseload array; a hundred rows carrying an identical
reason is the same as no caseload. `assessmentsDueSoon` and `cohortStruggling` are both
figures for this reason.

**Being below average is not a risk.** Half of every cohort is below the median by
definition, so a cohort signal needs BOTH a rank test and an absolute gap — the bottom
decile of a cohort sitting between 88% and 92% is three points off the mean.

## Workload, funding and VLE engagement

**Five modules now emit `TRIP_` codes into one `riskDriverCodes` column** — `tripwires`,
`coverage`, `cohort`, `workload`, `funding`. They are written independently and cannot see
each other, so `schema-contract.test.js` asserts the five vocabularies are disjoint and
all `TRIP_`-prefixed. A duplicate string would make two different findings
indistinguishable on the screen.

**A busy calendar is a figure; a busy calendar PLUS something about this student is a
code.** `assessmentsDueSoon` already established that a timetable fact fires cohort-wide
and must not be a caseload entry. `workload.js` keeps that structurally: every `codes.push`
is guarded by the heavy window AND by this student's own backlog or absence, so neither
half can fire alone.

**VLE engagement costs no extra Moodle calls.** `core_enrol_get_enrolled_users` is already
issued once per course by `syncFromMoodle` and `lastcourseaccess` is already in the
response. A ROW MEANS "WE LOOKED": observed-but-inactive is `accessed: false`, unobservable
is no row at all. This is the one place where absence IS the institution guard, because no
count can separate a disengaged cohort from a Moodle with `$CFG->hiddenuserfields` set from
a college that teaches face to face — all three are zero. The engagement denominator is
DAYS, not rows: a student on four units gets four rows a day, and counting rows makes
someone who opens one course of four every day look 75% disengaged.

**Funding: no `SlcApplication` row means "we do not know", never "no funding".**
Self-funded, employer-sponsored and international students legitimately have none, and
putting them on a risk register for a loan they never wanted is the failure. Every funding
code fires on the PRESENCE of a row saying something specific; none fires on an absence,
and that invariant is the constraint any fourth code must satisfy.

**The funding probe requires a LINKED row.** `count(SlcApplication) > 0` is true at a
college holding four thousand unlinked rows, and the pipeline would then report "no funding
record" about four thousand people who have one. `studentName` and `studentRef` on that
table are plain strings with no relation to `Student`, so matching on them would attach one
student's loan status to another — a data-protection incident, not a bug.

**`SlcApplication.statusChangedOn` is written only when the status actually moves.**
`routes/slc.js` never wrote it at all until recently, so it is null on every older row and
`funding.js` falls back to `applicationDate` — which measures time in the PIPELINE rather
than time in THIS state, and therefore carries a much longer threshold. Do NOT backfill it
from `updatedAt`: that moves when somebody corrects a typo, and the figure would look
freshest for exactly the claims being fussed over rather than the ones nobody has touched.

## Testing approach

Pure logic lives in its own file with tests beside it and no database — see
`src/prediction/` and `src/vle/*Normalise.js`. Everything else is covered by HTTP smoke
suites in `scripts/`, which are deliberately weighted toward **negative** assertions:
who is refused, what never leaves the building, which decisions cannot be made twice.

There is **no client-side test framework at all**. `StaffHub.jsx` (~12k lines) is
verified only by building.

When adding a regression test, prove it can fail: reintroduce the bug and confirm the
test catches it. Twice in recent work a test passed while discriminating nothing.

## Deployment

`main` → staging, `production` branch → production. Both auto-deploy: Render for the
API, Vercel for the client. The two frontends and two APIs are separate services with
separate databases. Staging and production are two *environments*, not two customers —
now that a deployment serves one college, a second college means another pair of
services and another database, not another row.

`/api/health` answers 200 on *any* build and proves nothing about which code is
running. To tell whether a deploy landed, probe a route only the new code has: **401
means mounted, 404 means not deployed**, with an existing route as the control.

`render.yaml` declares the API service; note that a Blueprint only applies its settings
when a service is **created**, so editing it does not move an existing service.
