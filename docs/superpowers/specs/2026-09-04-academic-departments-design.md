# Academic departments — design

*Written 4 Sep 2026, against `main` at `0b7831b`, by reading the working tree.*

Every claim in §3 was verified against the code and carries a file reference. Nothing
in §3 is carried forward from an earlier document. §7 contains one claim about
Moodle's API that has **not** been checked against a live site, and says so.

---

## 1. What this is

The platform is written around one academic area. The college wants it to work at
**departmental level**: Business, Computing, Law, Health & Social Care and whatever
else the institution runs, each with its own courses, students, staff and
configuration, and with staff seeing only their own department.

Two separable goals, and the college asked for both:

- **Scoping** — a Business tutor cannot see Computing students. An access-control and
  data-partitioning change.
- **Breadth** — the Business-shaped content (admission form questions, offer letters,
  email wording, curriculum defaults) becomes per-department configuration.

It has to land on the admin dashboard, the Android app and the iOS app.

### The three "systems" are one codebase

`client/` is a single React SPA. Capacitor wraps that same build into
`client/android/` and `client/ios/`; `MOBILE.md` states it plainly — "one codebase,
not three". There is no separate Android or iOS source tree to change.

So the work is **server + one client**, followed by a Capacitor sync and two store
releases. The college explicitly did **not** ask for separate per-department store
listings, which is the right call: distinct bundle IDs per department would multiply
the release burden for no user-visible gain.

---

## 2. Decisions taken

Recorded here so the plan does not relitigate them.

| Question | Decision |
|---|---|
| What does "departmental" mean? | **Both** scoping and breadth. |
| Where does Department sit? | **A new level above `Course`.** Department → Courses → Cohorts → Terms → Units. |
| How hard is the boundary? | **Hard, server-enforced, with an explicit college-wide role** (Principal, Registrar, Super Admin) that lifts it. |
| What is scoped? | **Everything** — academic core, curriculum, admissions/SLC, and HR (staff, leave, timesheets, check-ins). |
| Cross-department students? | **No.** One student, exactly one department. |
| Mobile scope | Staff department switcher + scoped lists; student sees their department, branded; applicant picks department then course. **No separate store listings.** |

---

## 3. What exists today

Verified by reading the tree.

**The academic hierarchy already supports many programmes.**
`Course → Cohort → Term → Unit → Student` exists (`server/prisma/schema.prisma:563`).
`Course` *is* "HND Business". What is missing is a level above it and any notion of
who may see it.

**Access control is page-level only, never row-level.** `ADMIN_PAGES` in
`server/src/validate.js` grants a *tab*. Any admin holding `students` sees every
student in the college. Student and applicant tokens are confined by router
allowlists (`STUDENT_ROUTERS`, `APPLICANT_ROUTERS` in `auth.js`), which is also not a
row filter.

**`Staff.dept` exists and means nothing.** Free text, written at sign-up, read by no
query. `Staff.site` (`HND | FE | SL`) looks like an academic division but is not one —
it is where a person physically clocks in, used by check-ins and a Staff-tab filter
(`server/src/routes/checkins.js:72`, `:89`).

**A department concept already exists, for support teams only.**
`SupportDepartmentConfig`, `Referral.department`, `Staff.supportDepartments`,
`server/src/supportDepartments.js`. It is a runtime-editable list held as JSON with
plain-string keys and **deliberately no foreign keys**, so a referral survives its
team being deleted. It is a good precedent for the *shape* of configuration and a bad
one for the *storage* of a security boundary — see §6.

**The scoping machinery this asks for existed and was deleted.** Until 30 Aug 2026
`server/src/db.js` extended the Prisma client so every query carried the caller's
`tenantId`, and a query with no tenant **threw** rather than returning everyone's
rows. `db.js` still carries the full account of what went and why, and states that if
scoping ever returns, that file is where it must return **first**. It is recoverable
from git history, along with `scripts/smoke-tenant-isolation.mjs`.

**Raw SQL bypasses any such extension, and this is already documented.**
`server/src/routes/hnd.js:6-21` records that the old extension hooked `$allModels`
while `$queryRaw` is a client-level method that never reached it, so every raw query
scoped itself by hand through a `requireTenant()` helper that threw. **Six raw
queries remain** — `server/src/routes/hnd.js:1559`, `:1576`, `:1614`, `:1624` and
`server/src/attendanceEmailService.js:256` — all attendance aggregates, all over data
that is about to become departmental.

**There is no `AsyncLocalStorage` in `server/src`.** Scope propagation is an open
choice, not an existing pattern.

**Only Moodle has a working sync.** `syncFromMoodle` in `server/src/moodle.js` imports
courses, units, students, grades and attendance. The Canvas and Blackboard adapters
are **transport only** — auth, pagination, rate-limit detection, `testConnection`, and
normalisers with unit tests. Their exports stop at `get`/`paginate`
(`server/src/vle/canvas.js:227`, `server/src/vle/blackboard.js:334`).

**The client has no test framework**, and `StaffHub.jsx` is ~12k lines, verified only
by building. That is the least verifiable part of everything below.

---

## 4. Naming: `AcademicDepartment`, never bare `department`

The word is taken. `Referral.department`, `Staff.supportDepartments` and
`SupportDepartmentConfig` all mean Wellbeing / ASK / Student Support — a
**confidentiality** boundary about who reads a student's disclosures.

CLAUDE.md records that the `outcome` collision (an intervention's outcome versus a
`StudentOutcome`) caused three bugs, twice landing a fix on the wrong vocabulary. This
collision is worse, because both meanings are access boundaries and a mix-up grants
the wrong people the wrong records.

**Rule: every new identifier is `academicDepartment`.** No bare `department` variable,
column, parameter or route segment is introduced by this work.
`schema-contract.test.js` gains an assertion that the two vocabularies are disjoint,
the way it already asserts the five `TRIP_` vocabularies are.

---

## 5. Programme of work: six specs

One design document cannot carry a change that touches ~275 endpoints. Vertical
slices, each shippable and independently verifiable:

| # | Spec | Ships | Risk |
|---|---|---|---|
| 1 | **Foundation** | `AcademicDepartment`, columns, join table, Settings UI, staff assignment, scope resolution + guard, background-work wrapping, migration, and Moodle category capture + mapping screen (§7). **Nothing is filtered yet.** | Low |
| 2 | **Scope the academic core** | Students, cohorts, units, registers, attendance marks, predictions, timetables, assessments — server + dashboard. Filtering switched on. | **Highest** |
| 3 | **Scope admissions + SLC** | Includes repairing `Admission.course` / `SlcApplication` from plain strings to a real `Course` relation. | High |
| 4 | **Scope HR** | Staff, leave, timesheets, check-ins. | Medium |
| 5 | **Per-department configuration** | Admission questions, offer letters, email templates, branding, curriculum defaults. The "breadth" half. | Medium |
| 6 | **Mobile release** | Student department view, applicant department-first apply, staff switcher polish, Capacitor sync, store submissions. | Low, slow |

Spec 1 is deliberately **inert**: the model, plumbing and UI land while every account
stays college-wide, so behaviour is unchanged. That is what makes specs 2–4 reviewable
one at a time instead of as one 275-endpoint diff.

This document specifies **spec 1 in full**, and fixes the decisions specs 2–6 depend
on. Specs 2–6 get their own design documents.

---

## 6. Spec 1 — the foundation

### 6.1 A real table, not a JSON config list

`SupportDepartmentConfig` stores its list as JSON with no foreign keys, because a
referral must outlive its team. Academic departments need the opposite: `Course`
carries a real FK, because scoping is a join on the hottest query path in the
application and a JSON blob cannot be indexed. Deletion safety comes from
`onDelete: SetNull` instead — the choice `Unit.courseId` already makes so registers
never vanish when a course is removed.

```prisma
model AcademicDepartment {
  id        String   @id @default(cuid())
  key       String   @unique   // slug [a-z0-9-]{1,40}, never editable after creation
  name      String
  colour    String   @default("#1a3a8f")
  active    Boolean  @default(true)
  createdAt DateTime @default(now())

  courses  Course[]
  students Student[]
  staff    StaffAcademicDepartment[]
}
```

Wrapped by `server/src/academicDepartments.js`, copying `supportDepartments.js`
exactly — platform defaults, allowlist serialiser (`key`, `name`, `colour`, `active`
and nothing else), short cache invalidated on save — minus the singleton row, because
this is a real table with many rows.

`key` is immutable after creation for the same reason `SupportDepartmentConfig`'s is:
it is what a URL fragment and a saved filter carry.

### 6.2 Columns

- **`Course.academicDepartmentId`** — nullable, `onDelete: SetNull`.
- **`Student.academicDepartmentId`** — nullable, `onDelete: SetNull`. **A stored
  column, not derived.** `Student.cohortId` is itself nullable, so deriving
  `Student → Cohort → Course → Department` leaves cohortless students belonging to no
  department and therefore invisible to every scoped account. It is also a two-hop
  join on the most frequent query in the app. The denormalisation is the price of
  closing that hole; §6.6 says how the drift is caught.
- **`Staff.collegeWide Boolean @default(false)`** — the all-access role.
- **`StaffAcademicDepartment`** — a join table, not a `Staff.supportDepartments`-style
  JSON array. Membership here is a security boundary and wants referential integrity:
  a JSON array can hold a key that is typo'd (granting nothing, silently) or renamed
  (granting something else, silently). `@@unique([staffId, academicDepartmentId])`.

### 6.3 The guard

A declaration, not an inference. Every Prisma model is classified exactly once:

- `SCOPED_BY_COLUMN` — the model has its own `academicDepartmentId` (`Course`,
  `Student`).
- `SCOPED_VIA(relation)` — reachable through an owner (`AttendanceMark` → student,
  `HndSession` → unit → course, `Enrolment` → student).
- `UNSCOPED` — explicitly college-wide (`Semester`, `TenantBranding`, every config
  table).

**A model absent from the declaration throws.** Adding a model then forces a decision
instead of defaulting to fail-open, which is the property the old fail-closed guard on
unrecognised operations had and which `db.js` records as lost.

**The guard is live in spec 1, and still filters nothing.** The extension is installed
with its declaration and its throw from day one. Because §6.6 makes every existing
account college-wide, the predicate it injects is empty and no row is removed from any
result. What the throw catches in spec 1 is the *other* case: a query running with no
bound scope at all. That is the background work of §6.4, so wrapping the schedulers,
the prediction runner and the VLE sync in `withoutAcademicScope` is **part of spec 1**,
not deferred to spec 2. Installing the guard late would mean discovering every such
call site during the highest-risk spec.

### 6.4 Scope propagation

Middleware, mounted after authentication, resolves
`{ academicDepartmentIds: string[], collegeWide: boolean }` and binds it for the
request via `AsyncLocalStorage`. Routes pass nothing; a forgotten route cannot fail
open, because the extension refuses a scoped model with no bound scope.

**Work outside a request runs college-wide by declaration.** Schedulers, the
prediction runner and the VLE sync legitimately span every department. They call
`withoutAcademicScope("<why>")`, which is loud and greppable. This deliberately avoids
the cost `db.js` names for the old design — "a tax on writing anything outside a
request" — while keeping the widening visible rather than implicit.

**This needs the college's explicit agreement**, because it partially reverses a
decision this project already took. See §9.1.

### 6.5 Raw SQL is scoped by hand

The extension cannot reach the six `$queryRawUnsafe` calls; `hnd.js:6-21` already
records exactly this. They take an explicit predicate from a helper that **throws**
when no scope is bound — the shape of the removed `requireTenant()`. `hnd.js`'s
comment is updated in the same commit rather than left describing a world that has
changed back.

A predicate that is always true is forbidden. `hnd.js:15-17` gives the reason: it
"reads as a working guard to the next person and would be the thing they trusted".

### 6.6 Migration, and two fail directions

The migration `20260904T120000_academic_departments` — the name is fixed here and
**never renamed once applied anywhere**:

1. Creates the table, columns and join table.
2. Creates one department from the existing institution and assigns every existing
   `Course` and `Student` to it.
3. Sets `collegeWide = true` on **every existing `Staff` row**.

**Fail direction 1 — the deploy fails open, loudly.** Every existing account keeps
seeing everything. The alternative locks the entire college out of every student
mid-term for a change that is otherwise invisible to them, which is the reasoning
CLAUDE.md gives for *ignoring* rather than rejecting the stale `tid` claim. Mitigation
is visibility, not tightening: the Departments screen carries a permanent line reading
*"N staff have college-wide access"*, so the state is never silent.

**Fail direction 2 — an unassigned row fails closed.** A `Course` or `Student` with a
null `academicDepartmentId` is visible only to college-wide accounts. Null means "not
assigned", and for a boundary the safe direction is closed. The same screen shows the
count of unassigned courses and students, so it reads as a to-do rather than a black
hole.

**Drift guard.** Assigning or changing a student's cohort writes
`Student.academicDepartmentId` in the same transaction. A smoke assertion proves a
student whose cohort moves to another department's course has their column moved too.

**Migration hygiene.** Forward-only, and the directory is never renamed once applied
anywhere — CLAUDE.md records that a rename has caused P3009 twice, failing every
subsequent deploy. Staging and production drift, so both databases get checked.

### 6.7 Testing

`scripts/smoke-academic-departments.mjs`, negative-weighted like its siblings:

- A scoped staff member is **refused** another department's student by direct ID.
- A departmental query with no bound scope **throws**.
- A raw-SQL aggregate with no bound scope **throws**.
- A college-wide account **is** allowed.
- A student moved between cohorts has their stored department moved with them.

Each assertion is proved able to fail by reintroducing the bug it guards.
`smoke-tenant-isolation.mjs` was deleted precisely because, with tenancy gone, it
would have passed while discriminating nothing — and CLAUDE.md notes that twice in
recent work a test passed while discriminating nothing. The proof is not optional.

Unit tests for `academicDepartments.js` (allowlist, key validation, duplicate
collapse) sit beside it, as `supportDepartments.test.js` does.

---

## 7. Where the department comes from on a VLE sync

The question that decides whether departments stay populated or rot within a term.

**Which spec owns what.** The probe (§7.4), the capture columns and the mapping table
and screen (§7.2 steps 1–2) are **spec 1**. Capture has to start with the foundation
because the Moodle sync is already running nightly: every night it runs without
capturing is a night of evidence the college does not get, and the mapping screen is
useless until some has accumulated. The pattern-rule fallback (§7.2 step 3) is **spec
5**, with the rest of the per-department configuration. Canvas and Blackboard capture
lands whenever those syncs are written — the field is specified here so it is not
retrofitted, which §7.4 explains is the expensive order for Blackboard.

### 7.1 Every VLE already carries the signal

| VLE | Native grouping | Today |
|---|---|---|
| **Moodle** | `categoryid` per course; categories are a tree, readable via `core_course_get_categories` | Already in the response `moodle.js:156` fetches. **Discarded.** The only `category` reference in the file (`moodle.js:152`) filters *grade* categories and is unrelated. |
| **Canvas** | `account_id` — Canvas sub-accounts *are* departments. Plus `sis_course_id`, which usually encodes a department prefix | `canvas.js:211` calls `/accounts` as a connection test only. `account_id` is not read. No sync exists. |
| **Blackboard** | Course categories, terms, and `courseId` (`BUS-101-2025`) | `blackboardNormalise.js:195` reads `courseId` only, to avoid merging sections. No sync exists. |

### 7.2 Capture, then map, never guess

1. **Capture** — `Course.vleCategoryExternalId` and `vleCategoryName`, written by
   every adapter. Lands *before* any mapping exists: it is free, and it is the
   evidence the college maps from.
2. **Map, once, in Settings** — `VleDepartmentMapping { source, externalId,
   externalName, academicDepartmentId }`. The admin sees *"Moodle category 12
   'Business & Management' — 14 courses — map to → [Business]"* and confirms it once.
   Later syncs auto-assign.
3. **Pattern rules as fallback** — a college that keeps everything in Moodle's
   "Miscellaneous" has no category signal, so it also gets ordered, college-written
   rules on the course code (`^BUS-` → Business, first match wins) with a live preview
   of what each rule matches. Configuration the college writes, in the house pattern —
   not constants in code.
4. **Unmapped is null.** It joins the unassigned queue of §6.6 and is visible only to
   college-wide accounts. Never auto-assigned to a default.

### 7.3 Two rules written into the sync

**Never infer the department from the course name by keyword.** "Contains the word
Business" is the class of error CLAUDE.md calls a data-protection incident rather than
a bug — the same reasoning that forbids matching `SlcApplication.studentName` to
`Student` by string. Under hard scoping a wrong assignment is a Law tutor reading
Health & Social Care pastoral records. Pattern rules are acceptable only because the
college writes them and sees what they match.

**A sync never silently moves a course between departments.** A reorganised Moodle
category would otherwise migrate whole cohorts across a security boundary overnight.
Assignment happens on **create**; on a later run a changed category becomes a
*proposed* change an admin approves. `syncFromMoodle` already has `dryRun` and a
preview culture (`moodle.js:172`), so this fits the file rather than fighting it.

### 7.4 Cost

No VLE charges per call. Cost is extra requests plus a permission somebody at the
institution must grant — and the permission is what actually bites.

| | Extra calls for the category **id** | For category **names** | The real cost |
|---|---|---|---|
| **Moodle** | **0** | **1 per sync** (`core_course_get_categories`, once, not per course) | A Moodle site admin must add that function to the token's external service |
| **Canvas** | **0** (`account_id` rides on the course object the sync will already fetch) | **1–2 per sync** | The token must be **account-scoped, not teacher-scoped** |
| **Blackboard** | **0** (`courseId` is already on `/v3/courses`) | **~C per sync**, C = number of categories | REST app needs catalog entitlements — **and the loop must be inverted**, see below |

Moodle's `readMoodle()` costs `1 + 3N` calls for N courses today (one listing, then
contents + enrolled users + grade items per course). Categories make it `2 + 3N`. At
40 courses, 121 calls instead of 120.

**The Blackboard trap.** Course categories are a *per-course* endpoint, so the obvious
loop costs one call per course and roughly doubles the sync. Inverting it — list
categories once, then list each category's courses — makes the cost proportional to
categories, not courses. Cheap to decide now, painful to retrofit into a sync already
written the other way round. This is an argument for settling it **before** the
Blackboard sync is written.

**Unverified claim.** That `categoryid` is present on `core_course_get_courses` is
taken from Moodle's API documentation and has **not** been checked against this
college's site; web-service permissions and site config vary. The first task of spec 1
is a read-only probe reporting which of `categoryid` and `core_course_get_categories`
the live token can actually see. One call, no writes, and it decides whether §7.2
layer 2 or layer 3 is the primary path before any mapping UI is designed.

**Graceful middle.** Even with no permission to read category *names*, a bare
`categoryid` still works: the mapping screen shows *"Moodle category 12 — 14 courses —
[name it]"* and the admin maps it by looking at what is inside. A locked-down Moodle
stays on the mapping path rather than dropping to pattern matching.

---

## 8. Mechanics that specs 2–4 inherit

Fixed here so three later documents do not each invent an answer.

- **Denormalise onto entity tables, scope events through their owner.** `Course`,
  `Cohort`, `Unit` and `Student` carry `academicDepartmentId` directly, so the
  predicate is one indexed column. Event tables — `AttendanceMark`, `HndSession`,
  `Enrolment`, the prediction tables — scope through their owner via a nested `where`,
  because they are always queried by student or unit anyway.
  *(Spec 1 adds the column to `Course` and `Student` only; `Cohort` and `Unit` follow
  in spec 2, where they are first read.)*
- **`sStudent`, `sCourse` and their siblings gain `academicDepartment`.** Serialise
  through allowlists, never blocklists — the `sAdmission` lesson.
- **Null stays "not measurable".** A student with no department is excluded from
  per-department denominators, never counted as zero. This is the convention the whole
  prediction pipeline runs on.
- **The prediction pipeline runs college-wide.** Cohort standing, the timetable probe
  and the five institution-wide probes are explicitly *institution*-wide questions;
  CLAUDE.md records that computing them from a subset is the most repeated bug in that
  area. Departmental scoping must not narrow them. They run under
  `withoutAcademicScope("prediction: institution-wide probes")`.
- **`ADMIN_PAGES` gains no keys.** Department membership is a column, exactly as
  `supportDepartments` is, for the reason that file gives: a college adding "Law" at
  four in the afternoon cannot also add a permission key to two hand-maintained
  copies. The page grants the feature; membership decides the rows.

---

## 9. Risks and open questions

### 9.1 This partially reverses a decision the project already took

CLAUDE.md and the project's memory both say multi-tenancy was removed and
`runInTenant` / `crossTenant` must never come back. §6.4 proposes machinery of a
similar *shape*.

The differences are real: this is one institution, not many; the boundary is
hierarchical rather than flat; scoping is **partial** (a `Semester` belongs to no
department) rather than total; and there is a designed all-access role, which tenancy
deliberately had none of. A blanket extension would therefore be wrong, which is why
§6.3 requires an explicit declaration per model.

**This is a decision for the college, not an implementation detail.** It is recorded
here so it is taken deliberately rather than discovered in review.

### 9.2 Nested reads may not be reachable by the extension

A Prisma extension over `$allModels` rewrites the top-level query. An
`include: { student: true }` reached from an *unscoped* parent is a plausible leak.
Mitigation is that the entry model of every departmental read is itself scoped — but
this is a **claim to be tested, not assumed**, and it is the first thing spec 2's
smoke suite must attack.

### 9.3 The client is the least verifiable part

`StaffHub.jsx` is ~12k lines with no test framework, verified only by building. Every
department filter, switcher and picker lands there. There is no automated way to prove
a list is scoped in the browser, so the server-side assertions carry the whole burden
and the client must never be the only thing enforcing a boundary.

### 9.4 Admissions and SLC have no link to scope

`Admission` and `SlcApplication` hold the student's name and typed college ID as plain
strings with **no relation to `Student`** — CLAUDE.md is explicit that matching on
them would attach one student's record to another and calls that a data-protection
incident. Spec 3 therefore has to build the real relation *before* it can scope
anything, which is why it is sequenced after specs 1–2 rather than bundled with them.

### 9.5 Open questions

1. **§9.1 — is the `AsyncLocalStorage` + extension approach accepted**, given the
   project's standing instruction against the tenant-era machinery? A per-route
   explicit helper is the alternative; it fails open when forgotten, which is exactly
   why `db.js` rejected it for ~200 endpoints.
2. **Does the Moodle probe run before spec 1 starts?** It costs one read-only call and
   decides whether §7.2 layer 2 or layer 3 is the primary path.
3. **Do departments need their own branding**, or only a name and colour? Spec 5
   depends on the answer; spec 1 ships `colour` either way.
4. **Should `Staff.dept` (free text, unread) be retired** in favour of
   `StaffAcademicDepartment`, or kept as an HR-facing label distinct from the academic
   boundary?

---

## 10. Definition of done for spec 1

- Migration applied to local, staging and production, and both remote databases
  checked for drift.
- `npm test` green on `edtech_dev`, including the new suite, with each new assertion
  demonstrated able to fail.
- `node --test "src/**/*.test.js"` green, including `academicDepartments.test.js` and
  the extended `schema-contract.test.js`.
- The client builds.
- Departments screen shows the department list, the college-wide staff count, and the
  unassigned courses/students counts.
- Every scheduler, the prediction runner and the VLE sync run under
  `withoutAcademicScope`, and a `grep` proves no background entry point is unwrapped.
- A Moodle sync captures `vleCategoryExternalId` on the courses it touches, and the
  mapping screen lists the categories found with their course counts.
- **No behaviour change for any existing user.**
