# Admissions, SLC and ISM by academic department — design

**Date:** 1 Oct 2026
**Status:** design, awaiting approval
**Follows:** `2026-09-04-academic-departments-design.md` (the six-spec plan; this is **spec 3**),
`2026-09-04-academic-departments-spec2-design.md` (the academic core), and the 28 Sep 2026
boundary-gap work recorded in `STATUS.md` §3.15.

---

## 1. What this changes, and why it is the largest remaining hole

A member of staff can be scoped to particular academic departments, and a Prisma client
extension then filters every read of `Course`, `Cohort`, `Unit`, `Student` and everything
reachable through them. `Admission`, `AdmissionDocument`, `Ism` and `SlcApplication` are
all classified `UNSCOPED`, so **every staff member holding the `admissions`, `slc` or `ism`
page sees every application, every loan record and every interview in the college.**

A school filter was added to those three screens on 12 Sep 2026. It narrows what is
displayed and grants nothing — the server returns every row either way, and
`StaffHub.jsx` says so above the component. This spec is about the boundary, not the view.

This matters more than the equivalent hole on an academic screen. An application carries
a date of birth, a national-insurance number, an ID document number and expiry, a home
address, next-of-kin details, and a criminal-record declaration. The audit of the read
paths found the per-application PDF download gated on the page alone, so a staff member
who learns an id can fetch the whole form.

### Why it was deferred, and what has changed

The original design doc recorded this as blocked: `Admission` and `SlcApplication` held
the student's name and typed college id as plain strings, so matching on them would attach
one student's record to another. That is no longer true of the schema — `Admission.linkedStudent`
and `SlcApplication.student` are real foreign keys, added by
`20260828T230000_link_finance_to_student`, and `academicScopeModels.js:205-214` already
corrects the older claim and says both "can carry a `{ via: … }` whenever spec 3 runs".

**That correction is itself wrong, and finding out why is the main result of this
investigation.** See §4.

---

## 2. Decisions taken

Recorded here because they are the institution's decisions, not the code's, and because
each one closes off a design that would otherwise look reasonable to a later reader.

| # | Decision | Ruling |
| --- | --- | --- |
| D1 | Where does an application's department come from? | **The admissions course list, which stays completely separate from Moodle.** Each course offered to applicants is assigned a department once, on the admissions screen. Applications inherit it. Nothing about admissions reads or depends on Moodle. |
| D2 | What happens to an application with no department? | **Visible to every staff member holding the page.** Null means "not sorted yet", not "secret". |
| D3 | What does a departmental staff member see on the Admission Tracker? | **College-wide figures, with a department filter available**, and access to the tracker kept at admin level. |
| D4 | What does the backfill do when it cannot match an application? | **Leaves it unassigned and reports it.** It never guesses. |

**D3 needs confirming in one respect.** "Only kept at admin level" is read here as: the
tracker keeps showing institution-wide figures to whoever can open it, gains a department
filter for slicing, and — precisely *because* it shows institution-wide figures regardless
of the viewer's own departments — is restricted to college-wide accounts so it cannot
become a back door to the college's numbers for a departmental account. If the intent was
instead "every admin keeps it, departmental ones included, still showing college-wide
figures", say so: that is a one-line difference here and a materially different disclosure.

---

## 3. Admissions stays separate from Moodle

An earlier draft of this document routed the department through Moodle: the college maps a
Moodle category to a department already, so an admissions course would have pointed at its
Moodle course and inherited the answer. **That is explicitly rejected. Admissions is to
remain completely separate from Moodle**, which is the separation the schema already
describes:

> *"Deliberately SEPARATE from the Moodle-synced `Course` table: admissions decides what a
> prospective student can apply for, independent of what's live in Moodle."*
> — `schema.prisma`, on `AdmissionCourse`; `routes/admissionApply.js:12` repeats it

So `AdmissionCourse` gains its **own** `academicDepartmentId`. No `courseId`, no join to
`Course`, no dependence on the VLE category mapping, and nothing in the admissions feature
that breaks if a college runs no VLE at all.

```
AcademicDepartment ──chosen once per course──▶ AdmissionCourse ──▶ Admission
  (the college's own list,                    (admissions'        (inherits at
   nothing to do with Moodle)                  own screen)         write time)
```

`AcademicDepartment` is the college's own list of teaching departments. Pointing an
admissions course at one is not a link to Moodle — the VLE's only role anywhere is as one
of several things that can *populate* `Course`, and `Course` is not on this chain.

### 3.1 What this costs, stated plainly

A department now has two independent assignments: the teaching side gets one from the VLE
category mapping (or by hand on the course), and the admissions side gets one here.
**Nothing enforces that they agree.** An application can be filed under Business for a
course that Computing teaches, and no screen will show the disagreement.

That drift was the argument for routing through Moodle, and it is the cost being accepted
in exchange for admissions owning its own structure and working at a college with no VLE.
Two things keep it from being invisible rather than merely tolerated:

- the department is chosen **per course, not per application**, so the whole surface is one
  short list an administrator can read in full on one screen, rather than a field on
  thousands of rows; and
- an unassigned admissions course is reported as a count on the admissions screen (§4.3),
  so "nobody has said which department this course belongs to" is on the screen rather
  than implicit in an empty list.

What is deliberately **not** built: any comparison between the two assignments, or a
warning when they differ. That would require reading the Moodle-derived department to
check it, which is the dependency this decision removes. If the college later wants the
two reconciled, that is its own piece of work and it should be asked for directly.

### 3.2 Why the department is not derived from the course name at read time

It would need no migration and no hand step: `Admission.course` holds a course name, and
`AdmissionCourse` holds names too, so the department could be looked up on every read.
Rejected on three counts, each verified rather than assumed:

- **`AdmissionCourse.name` has no unique constraint** (confirmed in the schema and against
  the live index list on `edtech_dev`), so the lookup can return two different answers.
  `POST /admission-config/courses` does no duplicate check and a rename can collide freely.
- **`Admission.course` is unvalidated free text.** Every writer goes through one helper,
  `pick()` in `admissionFields.js`, which trims and caps the length and performs no
  membership check. When the course list fails to load, the public form falls back to three
  hard-coded names (`admissionSections.js:43`), so an application can legitimately hold a
  course string that is not in the list at all.
- It would make **the access boundary depend on free text a member of staff can edit in a
  form field**. A typo would hide an application from the department that owns it — the
  fail-*closed* mirror of the "General bucket" fail-open the department migration already
  refused.

In `edtech_dev`, one of the two distinct course values on existing applications matches no
`AdmissionCourse` at all, which is the shape of that failure already present in the data.
That database is almost entirely smoke-test fixtures, so the *proportion* proves nothing
about a real college; the structural facts above are read from the schema and hold
everywhere.

---

## 4. How the department reaches an application: written, not joined

`Admission` gains its own nullable `academicDepartmentId`, resolved from the chosen
`AdmissionCourse` **at the moment the row is written** and stored.

### 4.1 Why `{ via: "linkedStudent" }` would be a blackout, not a narrowing

This is the most important finding in this document, and it contradicts the comment in
`academicScopeModels.js` that says the relations are ready to scope through.

`scopePredicateFor` emits `{ [via]: { is: { academicDepartmentId: … } } }`. **A null
relation does not match `is`.** And `Admission.linkedStudentId` is null on essentially
every row:

- It is nullable permanently and by design — *"Most applicants never become students … NOT
  NULL would make the table unwritable at the only moment it is written."*
- **Nothing in `server/src` writes it.** Verified: the only writer anywhere in the repo is
  `tools/backfill-student-links.js`, a hand-run tool. `.claude/rules/prediction-tripwires.md`
  already records this about both `Admission.linkedStudentId` and `SlcApplication.studentId`.
- In `edtech_dev`, 0 of 13 admissions carry one.

So declaring `Admission: { via: "linkedStudent" }` today would make **every** application
invisible to **every** account that is not college-wide. Worse than an empty list: each
`findUnique({ where: { id } })` becomes a 404 and each `update`/`delete` becomes a P2025,
so the screens would report applications as deleted or missing rather than as out of
scope.

It is also the wrong relation on its own terms. `linkedStudentId` is set when an applicant
*becomes a student* — the end of the funnel. The population admissions staff work on is
pending applicants, who by definition have no student record. A scope derived from
enrolment cannot scope the work that precedes enrolment.

### 4.2 Why written-at-create rather than derived-at-read

A stored column is denormalisation, and this codebase pays that cost knowingly elsewhere:
`Student.academicDepartmentId` is stored rather than derived through the cohort, and the
schema explains that the alternative leaves every cohortless student invisible. The same
argument applies here with more force, because the join would be through free text.

Writing it once, at the five `pick()` call sites, also gives one place to record honestly
that **no course matched** — a null, which under D2 means "visible to everyone" — rather
than guessing a department from a string that did not resolve.

### 4.3 What null means here, and why it differs from `Student`

| Model | Null department means | Who sees it |
| --- | --- | --- |
| `Course`, `Cohort`, `Unit`, `Student` | not assigned | college-wide accounts only |
| `TimetableSlot`, `TimetableEvent` | applies to everyone | everybody |
| **`Admission`, `AdmissionDocument`, `Ism`, `SlcApplication`** (this spec, D2) | **not sorted yet** | **everybody with the page** |

The departmental models fail *closed* because a student record is the thing the boundary
exists to protect. An application fails *open* here on the institution's instruction, and
the reasoning is worth keeping: on the day this ships no course is linked yet, so a
fail-closed rule would empty the admissions screen for every departmental account at once
— a blackout dressed as a security improvement, and one that invites somebody to re-enter
applications they were told do not exist.

`academicScopeModels.js` already has the mechanism: the kind used by `TimetableSlot` and
`TimetableEvent`, where a null column is visible to all. This spec uses that kind, not a
new one.

**This is a deliberate, stated weakening and it must be visible, not buried.** The
Settings screen already carries a permanent line reading "N of M staff have college-wide
access" and counts of unassigned courses and students, precisely so that a fail-open stays
in somebody's eyeline. This gets the same treatment: a permanent count of applications
with no department, on the admissions screen, phrased as a to-do rather than a warning.

---

## 5. Scoping, model by model

| Model | Treatment | Why |
| --- | --- | --- |
| `Admission` | own nullable column; **null visible to all** | §4 |
| `AdmissionDocument` | own nullable column, written from its admission | See below — `{ via: "admission" }` was the obvious choice and it is wrong |
| `Ism` | own nullable column, written from its admission | `Ism.admission` is nullable and `Ism` has **no** relation to `Student` at all; reaching a department means two hops, and `{ via }` resolves exactly one. A two-hop kind does not exist and this is not the place to invent one |
| `SlcApplication` | own nullable column, written from its admission or linked student | Same reasoning. `studentId` is nullable, permanently, and unwritten by any runtime code — §4.1 applies unchanged |
| `AdmissionCourse` | stays `UNSCOPED` | The public application form reads it unauthenticated and must see every active course, whatever department it belongs to. Carrying a department does not make a row a departmental record — this is the table that *assigns* the boundary, so scoping it by the boundary would hide from a departmental officer the very list they work from |

**Every model in this cluster carries its own column. `{ via: … }` is not used anywhere
here, and the reason is D2.** `{ via }` emits `{ admission: { is: { academicDepartmentId: … } } }`,
and a null does not match `is` — so a document belonging to an *unassigned* application
would be hidden from everyone but college-wide accounts, while the application itself
stayed visible to all. The boundary would disagree with itself across two screens about the
same applicant, which is worse than either rule applied consistently. The same trap applies
to `Ism` and `SlcApplication` through their nullable parents. One rule for the whole
cluster: a stored column, written from the application, null meaning "not sorted yet".

`AdmissionDocument.admission` being the only non-nullable link of the four does not rescue
it: the link is not null, the *department on the other end* is.

### 5.1 Writes are not filtered, and that is a hole to close by hand

The guard deliberately does not filter `create`, `createMany` or `upsert`. Two
consequences to handle explicitly rather than inherit:

- **`GET /ism/roster`** returns every application as a picker, with no department
  derivation of any kind. Left alone it lets a staff member link an ISM record to an
  applicant they cannot see on the admissions screen. It gets the same scoping as the
  admissions list, with unassigned rows still offered under D2.
- **`AdmissionConfigManager`** — the "Courses & intakes" editor — has no college-wide
  guard, unlike the department editor and the support-department editor beside it. A
  departmental admissions officer can today delete or hide another department's course from
  the public application form. Under D1 it also becomes the screen that *decides* which
  department an application belongs to, which makes it the admissions equivalent of the
  department editor on Settings, so it needs `requireCollegeWide` — consistent with the
  28 Sep ruling that a list affecting every department is edited only by someone who can see
  every department. A departmental officer still reads the list; they do not change it.

---

## 6. Five things that break on the day this ships unless they are wrapped

Every one of these is a read of `Admission` that happens **before any scope is bound**, or
on a path that legitimately has none. The guard throws when a scoped model is queried with
no scope — by design, so that a forgotten filter is loud. Here that would be loud in the
wrong place.

| Where | What happens | Fix |
| --- | --- | --- |
| `auth.js` applicant branch — `prisma.admission.findUnique` loading the caller's own row, **before** `bindScope` | **Every authenticated applicant request throws**, and the 401/503 handler swallows it, so it reads as "your session ended" | Wrap in `withoutAcademicScope`, exactly as the sibling student branch at `auth.js:185-188` already is. Verified: the student branch has the wrapper, the applicant branch does not |
| `routes/auth.js` login — raw SQL on `Admission` plus a `findUnique`, unauthenticated | An applicant cannot sign in | Stays unscoped: a login must match across the whole college. The raw SQL cannot be scoped anyway — `academicScopeSql.js` has no `Admission` variant and would throw with no scope bound |
| `admissionsUpload.js` — the document-upload link, token-authenticated, no `requireAuth` | The upload page an applicant was emailed dies | `withoutAcademicScope`, with the reason naming the token as the confinement |
| `admissionOffer.js` — the offer-acceptance link | An applicant cannot accept an offer | Same |
| `admissionApply.js` and `applicant.js` register / check-email — the duplicate-email checks | The public application form 500s | Same. Note `admissionApply.js:124-127` already wraps its `Student` read and gives the wording to copy |

A token already confines these to one application. `withoutAcademicScope` with a reason is
the house pattern for exactly this, and makes each site greppable.

---

## 7. The prediction engine must not notice

`.claude/rules/workload-funding-vle.md` and `prediction-tripwires.md` both record
institution-wide probes computed from a subset as the most repeated bug in this area — got
wrong three times. Four of those probes are `count()` calls on these very models
(`slcRecorded`, the status-movement probe, the ISM probe, the ID-expiry probe), and `count`
**is** filtered by the guard.

If any of them ran under a departmental scope, `slcRecorded` would flip from true to false
and, per the funding rule, every funding figure for that department would go null while
the college as a whole does record funding — "we do not know" reported about students
whose loans are on file.

Today this is safe, by one thread: `prediction/runner.js` wraps the whole of `gather()` in
`withoutAcademicScope`, and `gather()` has exactly one caller. This spec adds **a test
asserting those probes are computed college-wide**, because:

- the protection is a comment and a wrapper, with nothing failing if a second caller
  appears; and
- the probes cannot be *observed* to break today, since `studentId`/`linkedStudentId` are
  null everywhere and every funding column is already null. A regression would ship
  silently and surface only after a backfill runs — which is the worst available ordering.

---

## 8. The Admission Tracker (D3)

The tracker is already an aggregates-only screen that deliberately shows no applicant
identities. Under D3 it keeps showing **college-wide** figures, gains a **department
filter**, and is restricted to college-wide accounts.

- Its two `admission.findMany` calls run inside `withoutAcademicScope` with a reason
  saying the funnel is an institutional figure — the same declaration the prediction
  runner makes.
- The department filter is an explicit, chosen narrowing, like the existing intake and
  course filters. When one is chosen, the heading says so, and **the targets narrow with
  it or are withheld.** This is the sharpest trap on the screen: a departmental *actual*
  against a college-wide *target* renders as "Applications 90 / Target 600 ▼ -85%" — a
  confident red verdict that the college is failing. A wrong judgement is worse than a
  missing one, so if a per-department target does not exist, the variance column shows
  nothing rather than a number.
- The revenue estimate is labelled with its scope for the same reason, and its existing
  "estimated from 4 of 6 courses" coverage line keeps working.
- `admission-stats` becomes college-wide only. That removes the screen from any
  departmental admin who holds it today, which is a visible change, and is the half of D3
  most worth confirming (§2).

---

## 9. The client

The server returning fewer rows is the easy half. These are the places where it would
*mislead* rather than merely show less.

1. **Empty-state copy, on all three screens.** Admissions says "No applications yet" and
   invites the reader to "add the first application"; ISM and SLC do the same. A
   departmental user with nothing in scope would be told the college has no applications
   and invited to create one — a false statement that invites duplicate data entry. This is
   the highest-blast-radius item on the list and the cheapest to fix: distinguish "none in
   your departments" from "none at all".
2. **The SLC tiles ignore the school filter today.** Eight status counts and an "X of Y
   have applied" line are computed in the browser from the unfiltered list, so picking a
   school already shrinks the table while the tiles keep college totals. They move
   unexplained once scoping lands, so they get the same filter and a scope label.
3. **Unqualified institutional nouns.** There is no literal "College-wide" string on these
   screens, but "Total" over a browser-computed sum, "Overall conversion", "All courses",
   "All intakes" and the school filter's own "All schools" all promise breadth that a
   departmental account no longer has.
4. **"Not linked" standing in for "not visible to you".** An ISM row embeds its
   applicant's name and course from the admission; when that admission is out of scope the
   row renders as "Not linked" with a dash. A permission fact presented as a data fact.
5. **The SLC applicant picker calls the admissions endpoint**, so it already vanishes
   silently for an SLC-only staff member and will offer a shorter list than the table it
   sits beside.
6. **The per-application and offer-letter PDFs** are gated on the page alone. They inherit
   the boundary once `Admission` is scoped, but they are named here because they are the
   most sensitive payload on the feature.

The sidebar's "Viewing: Computing, Business" line already exists and helps, but it is
nowhere near these figures.

---

## 10. The backfill (D4)

A tool under `server/tools/`, dry-run by default like its siblings, following the chain in
§3 for existing rows: `Admission.course` → `AdmissionCourse.name` →
`AdmissionCourse.academicDepartmentId`. No Moodle hop, per D1.

Note what the backfill is for. The department is written at create time from here on, so
this tool exists only to place rows that already existed — it is a one-off repair, not part
of how the feature runs.

Rules:

- **Exact name match only.** Case/trim normalisation was measured on `edtech_dev` and
  bought nothing — the misses are genuinely different names, not whitespace. Fuzzy
  matching is refused: a wrong department here is a disclosure, and the string is
  unvalidated free text.
- **"Matched more than one" is its own outcome**, reported and skipped, because
  `AdmissionCourse.name` is not unique and the tool must not pick one.
- **Unmatched rows stay null** and are listed in full. Under D2 they remain visible to
  everyone, so nothing disappears while the course list is being linked up — the backfill
  is an improvement in precision, never a precondition for the screens working.
- It reports counts by outcome: assigned, no course recorded, no such admissions course,
  admissions course has no department yet, ambiguous (name matched more than one course).
- **It does not touch `linkedStudentId`.** That is `backfill-student-links.js`'s job and
  the two must not be confused.

### 10.1 One schema repair this forces

`AdmissionCourse.name` becomes unique, because it is about to be the key by which an
application finds its course. It is not unique today, `POST /admission-config/courses` does
no duplicate check, and a rename can collide freely — which already silently breaks the
tracker's fee lookup, since that keys on the name too. Making it unique needs a
pre-migration check for existing duplicates and a clear refusal if any exist, rather than a
migration that fails halfway.

---

## 11. Testing

Per `.claude/rules/testing.md`: weighted negative, and every refusal paired with the
permission that makes it mean something.

- A new smoke suite, `smoke-admissions-departments.mjs`: a narrowed admin sees their own
  department's applications and not another's; sees unassigned ones (D2); is refused the
  tracker; cannot fetch another department's application PDF; cannot pick another
  department's applicant from the ISM roster; and the college-wide half of each pair
  succeeds.
- **The five wrapped paths get positive assertions**, because their failure mode is a
  thrown error on an unauthenticated path: an applicant can sign in, load their own record,
  use an upload link, accept an offer, and submit the public form — all while the models are
  scoped. These are the assertions whose absence would ship a broken applicant portal.
- A unit test that the prediction probes run college-wide (§7).
- The suite joins `NOT_SCOPEABLE` in `scripts/test.mjs` only if it genuinely cannot run
  scoped, with the reason written out; the preference is that it runs in both passes.
- Every assertion proved able to fail by reintroducing the bug it guards.

---

## 12. What this does not do

- **No hierarchy.** Departments stay a flat list. Moodle's nested categories (Faculty →
  Department → Programme) are not modelled, and `moodle.js` does not capture a category's
  parent. That is a separate piece of work and it is the one most likely to be wanted next.
- **No department-level roles.** An account is college-wide or a plain member; there is no
  Head of Department.
- **No per-department configuration** (spec 5): admission questions, offer letters, email
  templates and branding stay one college-wide set.
- **No applicant-facing department step.** The public form keeps asking for a course, not a
  school. The department comes from the course the applicant chose, and asking an applicant
  to name a department as well would create a second answer the college then has to
  reconcile against the first.
- **No link between admissions and Moodle, in either direction** (§3), and no reconciliation
  between the admissions department and the teaching one.
- **No HR scoping** (spec 4).
- **It does not repair `Admission.course` into a relation.** That was considered and
  rejected: the string feeds a SharePoint folder path that *moves live folders* when the
  course changes, an exact-match fee lookup, a tracker filter, two PDF generators and
  three email templates. A separate department column is far cheaper and leaves the string
  exactly where every reader expects it.

---

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| The applicant portal breaks on deploy | §6 is the first task, with positive smoke assertions, not the last |
| Nothing is linked on day one, so scoping achieves nothing visible | Accepted deliberately under D2. The permanent unassigned count on the admissions screen is what stops "nothing happened" becoming "nobody noticed for a term" |
| The prediction engine silently loses funding data | §7, plus a test rather than a comment |
| A departmental actual judged against a college-wide target | §8: withhold the variance rather than show a wrong one |
| `AdmissionCourse.name` duplicates block the migration | §10.1: check and refuse clearly before migrating |
| The admissions department and the teaching department disagree about the same course | Accepted under D1 (§3.1). One short list on one screen, with an unassigned count kept visible. No automatic reconciliation, because checking would reintroduce the Moodle dependency D1 removes |
| Two environments drift | `database-safety.md`: staging and production are separate databases; the backfill runs twice and reports twice |

---

## 14. Open question

**D3, restated:** does a *departmental* admin keep the Admission Tracker?

- As written here: no — the tracker shows institution-wide figures, so it is restricted to
  college-wide accounts, who can slice it by department.
- The alternative: every admin keeps it, still showing college-wide figures, with the
  department filter available to all. Simpler, removes nothing from anyone, but means a
  departmental account can read the whole college's funnel, conversion and revenue.

One line of code apart; materially different disclosure. Confirm before implementation.
