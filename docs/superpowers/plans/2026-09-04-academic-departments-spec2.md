# Academic Departments — Spec 2 (Close the Boundary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make departmental scoping actually confine an account, so the refusal spec 1 shipped can be lifted and a Business tutor genuinely cannot see Computing students.

**Architecture:** A leak is an UNSCOPED parent reaching a SCOPED child — measured, not assumed. Declaring the parent scoped closes it. The blocker is that `via` resolves one hop and needs the related model to carry `academicDepartmentId` itself, so `Unit` and `Cohort` gain that column first; every remaining path is then a single hop. `TimetableSlot` and `TimetableEvent` get their own column because a course-less workshop must stay visible to everyone.

**Tech Stack:** Node 20 + Express, Prisma 5 + PostgreSQL, `node:test` for unit tests, `scripts/smoke-*.mjs` for HTTP suites, React 18 + Vite.

**Spec:** [docs/superpowers/specs/2026-09-04-academic-departments-spec2-design.md](../specs/2026-09-04-academic-departments-spec2-design.md)

## Global Constraints

- **Naming: `academicDepartment`, never bare `department`.** `academicDepartmentNaming.test.js` fails on any bare `department…` field outside the four support-referral models.
- **`ADMIN_PAGES` gains no keys.** Membership is a column, not a grantable page.
- **Never rename a migration directory once applied anywhere** — P3009, twice on this project.
- **Always pass `DATABASE_URL` on the command line.** Never let it fall through to `server/.env`, which points at live Supabase. Every command here uses `postgresql://postgres:postgres@localhost:5432/edtech_dev`.
- **Never use `node --test src/`** — the runner walks into `src/index.js`, binds a port, starts schedulers, and never terminates. Use the glob `"src/**/*.test.js"`.
- **Null means "not measurable", never zero.**
- **Serialise through allowlists, never blocklists.**
- **Prove every new test can fail** by reintroducing the bug it guards.
- **Comments explain WHY, at length, including why an alternative was rejected.**
- **A refusal assertion always comes with a permission assertion.** A server returning nothing passes every refusal test ever written; `smoke-tenant-isolation.mjs` was deleted for exactly that.
- **The prediction pipeline stays institution-wide.** Scoping `StudentPredictionCurrent` affects *routes* reading predictions, never `prediction/runner.js`, which runs under `withoutAcademicScope`. CLAUDE.md records that computing its probes from a subset is the most repeated bug in that area.

---

### Task 1: The enabling columns

`via` resolves one hop and needs the related model to carry the column. `Unit` and `Cohort` do not, which is why `HndSession` as `{ via: "unit" }` throws rather than filters. This task is what unblocks Tasks 3 and 4.

**Files:**
- Modify: `server/prisma/schema.prisma` (`Unit`, `Cohort`, `TimetableSlot`, `TimetableEvent`)
- Create: `server/prisma/migrations/20260905T090000_scope_curriculum/migration.sql`
- Modify: `server/src/academicDepartments.js` (`assignCourses`)
- Modify: `server/src/academicDepartmentNaming.test.js`

**Interfaces:**
- Consumes: `academicDepartments.assignCourses(prismaOrTx, courseIds, academicDepartmentId)` from spec 1.
- Produces: `Unit.academicDepartmentId`, `Cohort.academicDepartmentId`, `TimetableSlot.academicDepartmentId`, `TimetableEvent.academicDepartmentId`. Tasks 3–5 all depend on these exact names. `assignCourses` returns `{courseCount, studentCount, unitCount, cohortCount}`. The two new counts are returned for the audit summary in `routes/vleDepartmentMapping.js` and `routes/hnd.js`; no task in this plan renders them, and adding them to a screen is out of scope.

- [ ] **Step 1: Write the failing test**

Append to `server/src/academicDepartmentNaming.test.js`:

```js
test("the curriculum models carry their own academicDepartmentId", () => {
  // WHY A COLUMN AND NOT A `via` PATH. scopePredicateFor emits
  // { [via]: { academicDepartmentId: { in: [...] } } }, which requires the RELATED model to
  // carry the column. Unit does not, so HndSession declared { via: "unit" } does not filter
  // — it throws PrismaClientValidationError. Every spec 2 path is one hop only because
  // these four columns exist.
  for (const model of ["Unit", "Cohort", "TimetableSlot", "TimetableEvent"]) {
    const block = SCHEMA.split(/^model /m).find((b) => b.startsWith(model + " "));
    assert.ok(block, `model ${model} not found`);
    assert.match(block, /academicDepartmentId\s+String\?/, `${model} has no academicDepartmentId`);
    assert.match(block, /onDelete: SetNull/, `${model} must SetNull — deleting a department cannot delete curriculum`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd server && node --test src/academicDepartmentNaming.test.js
```

Expected: FAIL — `Unit has no academicDepartmentId`.

- [ ] **Step 3: Add the four columns**

In `model Unit`:

```prisma
  /// Which academic department teaches this unit. Denormalised from the course, exactly as
  /// Student.academicDepartmentId is denormalised through the cohort.
  ///
  /// A COLUMN RATHER THAN A DERIVED PATH, and this one is not a performance choice. The
  /// scope guard's `via` resolves a SINGLE hop and needs the related model to carry the
  /// column itself, so HndSession -> Unit -> Course is unreachable: declared { via: "unit" }
  /// it throws rather than filters. This column is what makes every spec 2 path one hop.
  ///
  /// Maintained by academicDepartments.assignCourses(), the one implementation of "move a
  /// course and everything hanging off it".
  academicDepartment   AcademicDepartment? @relation(fields: [academicDepartmentId], references: [id], onDelete: SetNull)
  academicDepartmentId String?
```

...plus `@@index([academicDepartmentId])`. Identical block in `model Cohort` (wording adjusted to "this intake").

In `model TimetableSlot` and `model TimetableEvent`:

```prisma
  /// Which academic department this belongs to — and here NULL MEANS "SHOWN TO EVERYONE",
  /// which is the opposite of the rule everywhere else in this feature.
  ///
  /// It is the one place fail-OPEN is right, and the reason is what the row IS. `courseId`
  /// is nullable because slots deliberately carry sessions that are not units at all —
  /// "Academic Skills Workshop", "Study Support". Scoping those through the course would
  /// fail closed on the null and delete most of what this model exists for from every
  /// departmental tutor's timetable. A workshop is not a student record: hiding it removes a
  /// service, showing it reveals that the college runs a workshop on Tuesday.
  ///
  /// A column rather than a blanket "null FK is public" rule, because a blanket rule is
  /// indistinguishable from somebody forgetting to set a value. Here the null is a decision.
  academicDepartment   AcademicDepartment? @relation(fields: [academicDepartmentId], references: [id], onDelete: SetNull)
  academicDepartmentId String?
```

...plus `@@index([academicDepartmentId])` on both.

- [ ] **Step 4: Generate the migration, rename it once, and add the backfill**

```bash
cd server
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate dev --name scope_curriculum --create-only
```

Rename the generated directory to exactly `20260905T090000_scope_curriculum` **now, before it is applied anywhere** — this repo uses `YYYYMMDDTHHMMSS` and `0` sorts before `T`, so Prisma's own name would order before the spec 1 migrations. After this moment it is never renamed again.

Append to the generated `migration.sql`:

```sql
-- Backfill from the course each row already belongs to.
--
-- Units and cohorts inherit their course's department. Both are plain correlated updates on
-- indexed keys -- row locks only, no table rewrite, and safe to re-run.
UPDATE "Unit"   u  SET "academicDepartmentId" = c."academicDepartmentId"
  FROM "Course" c  WHERE c.id = u."courseId"   AND u."academicDepartmentId" IS NULL;
UPDATE "Cohort" co SET "academicDepartmentId" = c."academicDepartmentId"
  FROM "Course" c  WHERE c.id = co."courseId"  AND co."academicDepartmentId" IS NULL;

-- TIMETABLE ROWS ARE DELIBERATELY NOT BACKFILLED, and that is the decision, not an omission.
--
-- Null here means "shown to everyone". Backfilling from the course would silently confine
-- every existing slot to a department, which for a course-less workshop or study-support
-- session is exactly the regression this column exists to prevent. A college that wants a
-- slot placed in a department says so on the timetable screen.
```

- [ ] **Step 5: Apply and regenerate**

```bash
cd server
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma generate
```

- [ ] **Step 6: Extend `assignCourses` so the columns stay true**

In `server/src/academicDepartments.js`, replace the body of `assignCourses`:

```js
async function assignCourses(prismaOrTx, courseIds, academicDepartmentId) {
  if (!courseIds.length) return { courseCount: 0, studentCount: 0, unitCount: 0, cohortCount: 0 };
  // UNITS AND COHORTS MOVE WITH THE COURSE, in the same transaction as the students.
  //
  // They carry their own copy of the department now (see the schema), and a copy that is
  // only correct on the day it is written is worse than no copy: a unit left behind is a
  // register the department that now owns the course cannot open, and a unit that moved
  // without its cohort is a timetable that disagrees with itself.
  //
  // This is still the ONE implementation. Both writers of Course.academicDepartmentId --
  // the course routes and the VLE category mapping -- call it, so neither can drift from
  // the other, and breaking it fails both of their assertions.
  const [courses, students, units, cohorts] = await prismaOrTx.$transaction([
    prismaOrTx.course.updateMany({ where: { id: { in: courseIds } }, data: { academicDepartmentId } }),
    prismaOrTx.student.updateMany({
      where: { cohort: { courseId: { in: courseIds } } },
      data: { academicDepartmentId },
    }),
    prismaOrTx.unit.updateMany({ where: { courseId: { in: courseIds } }, data: { academicDepartmentId } }),
    prismaOrTx.cohort.updateMany({ where: { courseId: { in: courseIds } }, data: { academicDepartmentId } }),
  ]);
  return {
    courseCount: courses.count, studentCount: students.count,
    unitCount: units.count, cohortCount: cohorts.count,
  };
}
```

- [ ] **Step 7: Run the tests**

```bash
cd server && node --test src/academicDepartmentNaming.test.js
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node --test "src/**/*.test.js"
```

Expected: PASS.

- [ ] **Step 8: Prove the new test can fail**

Temporarily delete `academicDepartmentId` from `model Cohort`, re-run `node --test src/academicDepartmentNaming.test.js`, confirm it fails naming `Cohort`. Restore.

- [ ] **Step 9: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260905T090000_scope_curriculum server/src/academicDepartments.js server/src/academicDepartmentNaming.test.js
git commit -m "Unit, Cohort and the timetable models carry their own department

The enabling change, not an optimisation: the guard's via resolves ONE hop and
needs the related model to carry the column, so HndSession via unit THREW rather
than filtered. These columns make every spec 2 path a single hop.

Timetable rows are deliberately NOT backfilled -- null there means shown to
everyone, and confining an existing study-support session to a department is the
regression the column exists to prevent."
```

---

### Task 2: The nested-read regression suite

The leak that stopped spec 1. Written now, as a permanent assertion, so Tasks 3 and 4 have something to turn green — and so it can never come back silently.

**Files:**
- Create: `scripts/smoke-academic-nested-reads.mjs`

**Interfaces:**
- Consumes: `withAcademicScopeGuard`, `runWithAcademicScope` from spec 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the suite**

Create `scripts/smoke-academic-nested-reads.mjs`, using the same header as `scripts/smoke-academic-scope.mjs` (`ROOT` / `createRequire` / `PrismaClient` built explicitly from `DATABASE_URL`, the `ok`/`bad`/`check` helpers, the `DATABASE_URL` guard, non-zero exit on failure).

```js
// THE LEAK THAT STOPPED SPEC 1, held closed permanently.
//
// academicScopeGuard.js rewrites the TOP-LEVEL query. A Prisma client extension cannot
// reach a nested include, so an UNSCOPED parent reaching a SCOPED child returns rows the
// caller may not see. Measured 4 Sep 2026 with a scope owning nothing: student.findMany()
// gave 0 while hndSession.findMany({include:{marks:true}}) gave 194 attendance marks.
//
// The fix is to scope the PARENT, which is what tasks 3 and 4 do. This suite is how we know
// it worked, and how we would know if a later migration added a model that reopened it.
const { withAcademicScopeGuard } = require(`${ROOT}/server/src/academicScopeGuard`);
const { runWithAcademicScope, withoutAcademicScope } = require(`${ROOT}/server/src/academicScope`);
const guarded = withAcademicScopeGuard(db);

// A scope owning a department that exists but holds nothing. Deliberately NOT an empty id
// list: `{ in: [] }` and `{ in: ["real-but-empty"] }` take different code paths, and the
// second is the one a real narrowed account uses.
const EMPTY = { academicDepartmentIds: [emptyDept.id], collegeWide: false };

// Every (parent, child) pair where the parent is unscoped-looking and the child holds
// student data. Each is asserted to return NOTHING under EMPTY and SOMETHING for a
// college-wide caller — the pair, so a broken client cannot pass by returning nothing.
const NESTED = [
  { label: "hndSession -> marks",            run: (p) => p.hndSession.findMany({ include: { marks: true } }),                 count: (r) => r.reduce((n, x) => n + x.marks.length, 0) },
  { label: "unit -> enrolments",             run: (p) => p.unit.findMany({ include: { enrolments: true } }),                  count: (r) => r.reduce((n, x) => n + x.enrolments.length, 0) },
  { label: "unit -> sessions -> marks",      run: (p) => p.unit.findMany({ include: { sessions: { include: { marks: true } } } }), count: (r) => r.reduce((n, x) => n + x.sessions.reduce((m, s) => m + s.marks.length, 0), 0) },
  { label: "prediction -> student",          run: (p) => p.studentPredictionCurrent.findMany({ include: { student: true } }), count: (r) => r.length },
  { label: "interaction -> student",         run: (p) => p.interaction.findMany({ include: { student: true } }),              count: (r) => r.length },
  { label: "studentQuery -> student",        run: (p) => p.studentQuery.findMany({ include: { student: true } }),             count: (r) => r.length },
  { label: "studentReview -> student",       run: (p) => p.studentReview.findMany({ include: { student: true } }),            count: (r) => r.length },
  { label: "assessmentGrade -> student",     run: (p) => p.assessmentGrade.findMany({ include: { student: true } }),          count: (r) => r.length },
  { label: "intervention -> student",        run: (p) => p.intervention.findMany({ include: { student: true } }),             count: (r) => r.length },
  { label: "mitigation -> student",          run: (p) => p.mitigatingCircumstance.findMany({ include: { student: true } }),   count: (r) => r.length },
  { label: "cohort -> students",             run: (p) => p.cohort.findMany({ include: { students: true } }),                  count: (r) => r.reduce((n, x) => n + x.students.length, 0) },
  { label: "unit -> _count.enrolments",      run: (p) => p.unit.findMany({ include: { _count: { select: { enrolments: true } } } }), count: (r) => r.reduce((n, x) => n + x._count.enrolments, 0) },
];

for (const t of NESTED) {
  await check(`${t.label} leaks nothing to a scope that owns nothing`, async () => {
    const rows = await runWithAcademicScope(EMPTY, () => t.run(guarded));
    const n = t.count(rows);
    assert.equal(n, 0, `${t.label} returned ${n} row(s) a scoped account must not see`);
    return "0";
  });
}

// THE CONTROL, once, over the whole set. Without it every assertion above passes against a
// database that is simply empty — which is exactly how smoke-tenant-isolation.mjs came to
// discriminate nothing.
await check("...and a college-wide caller still sees the same data", async () => {
  const seen = [];
  await withoutAcademicScope("nested-read control", async () => {
    for (const t of NESTED) seen.push(t.count(await t.run(guarded)));
  });
  const total = seen.reduce((a, b) => a + b, 0);
  assert.ok(total > 0, "the college-wide caller saw nothing either, so none of the above proves anything");
  return `${total} row(s) across ${NESTED.length} shapes`;
});
```

**Fixtures:** one `AcademicDepartment` named `emptyDept` that owns no course, no student and
no unit — it must EXIST but hold nothing, because `{ in: [] }` and `{ in: ["real-but-empty"] }`
take different code paths in `scopePredicateFor` and the second is what a narrowed account
actually sends. Removed in a `finally`.

- [ ] **Step 2: Run it and watch it fail**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-nested-reads
```

Expected: the control PASSES and several leak assertions FAIL with non-zero counts. Record which — that list is Tasks 3 and 4's worklist.

**If every leak assertion already passes, stop.** The seeded database has nothing to leak and the suite proves nothing; seed more fixtures until the control reports a healthy total.

- [ ] **Step 3: Commit the failing suite**

```bash
git add scripts/smoke-academic-nested-reads.mjs
git commit -m "The nested-read leak, as a permanent suite (currently RED)

Committed failing on purpose: this is the leak that stopped spec 1 shipping its
Access control, and tasks 3 and 4 are what turn it green. One control over the
whole set, so an empty database cannot pass it."
```

---

### Task 3: Scope the student-owned models

Eleven models whose shortest path is `via: student`. Each closes a top-level route AND the nested reads hanging off it.

**Files:**
- Modify: `server/src/academicScopeModels.js`
- Modify: `scripts/smoke-academic-scope.mjs`

**Interfaces:**
- Consumes: `MODEL_SCOPE`, `scopePredicateFor` from spec 1.
- Produces: nothing new; changes the behaviour Tasks 6 and 7 verify.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-academic-scope.mjs`. The fixture student belongs to Business; the assertions run as an account scoped to Computing:

```js
// EACH PAIR IS A REFUSAL AND A PERMISSION. A refusal alone passes against a server that
// returns nothing for everybody, which is why smoke-tenant-isolation.mjs was deleted rather
// than adapted when tenancy went.
const STUDENT_OWNED = [
  ["studentPredictionCurrent", (p, where) => p.studentPredictionCurrent.findMany({ where })],
  ["interaction",              (p, where) => p.interaction.findMany({ where })],
  ["studentQuery",             (p, where) => p.studentQuery.findMany({ where })],
  ["studentReview",            (p, where) => p.studentReview.findMany({ where })],
  ["assessmentGrade",          (p, where) => p.assessmentGrade.findMany({ where })],
  ["intervention",             (p, where) => p.intervention.findMany({ where })],
  ["studentOutcome",           (p, where) => p.studentOutcome.findMany({ where })],
  ["mitigatingCircumstance",   (p, where) => p.mitigatingCircumstance.findMany({ where })],
  ["vleEngagement",            (p, where) => p.vleEngagement.findMany({ where })],
  ["assessmentSubmission",     (p, where) => p.assessmentSubmission.findMany({ where })],
  ["studentPredictionHistory", (p, where) => p.studentPredictionHistory.findMany({ where })],
];

for (const [model, run] of STUDENT_OWNED) {
  await check(`${model} is refused for another department's student`, async () => {
    const rows = await runWithAcademicScope(
      { academicDepartmentIds: [computing.id], collegeWide: false },
      () => run(guarded, { studentId: businessStudent.id }),
    );
    assert.equal(rows.length, 0, `${model} returned a Business student's rows to a Computing scope`);
    return "0";
  });
  await check(`...and ${model} IS returned to the student's own department`, async () => {
    const rows = await runWithAcademicScope(
      { academicDepartmentIds: [business.id], collegeWide: false },
      () => run(guarded, { studentId: businessStudent.id }),
    );
    assert.ok(rows.length > 0, `${model} returned nothing to its OWN department, so the refusal above proves nothing`);
    return `${rows.length}`;
  });
}
```

**Fixtures these assertions need**, added to `smoke-academic-scope.mjs`'s existing fixture
block and removed in its `finally`: `business` and `computing` (`AcademicDepartment` rows —
the suite already creates these), `businessCourse` in `business`, `businessCohort` on that
course, and `businessStudent` in that cohort with **one row in each of the eleven models**.
`guarded` and `runWithAcademicScope` are already in scope inside that suite's `try` block —
these assertions go inside it, not after it.

- [ ] **Step 2: Run and watch the refusals fail**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-scope
```

Expected: every `is refused` FAILS (rows come back), every `IS returned` passes.

- [ ] **Step 3: Declare the eleven models**

In `server/src/academicScopeModels.js`, move each from the `UNSCOPED` block into a new section:

```js
  /* ---- Student-owned: everything hanging off one student --------------------- */
  // Declared in spec 2. Each of these has a top-level listing route, and scoping the model
  // closes BOTH that route and every nested include reading a Student through it -- which
  // is the leak that stopped spec 1 (see smoke-academic-nested-reads.mjs).
  //
  // The prediction models are declared here for the ROUTES that read them. The pipeline
  // that WRITES them runs under withoutAcademicScope and is unaffected: CLAUDE.md records
  // that computing its institution-wide probes from a subset is the most repeated bug in
  // that area, got wrong three times.
  StudentPredictionCurrent: { via: "student" },
  StudentPredictionHistory: { via: "student" },
  Intervention: { via: "student" },
  StudentOutcome: { via: "student" },
  Interaction: { via: "student" },
  StudentQuery: { via: "student" },
  StudentReview: { via: "student" },
  AssessmentGrade: { via: "student" },
  AssessmentSubmission: { via: "student" },
  VleEngagement: { via: "student" },
  // Article 9 health data. routes/mitigations.js already carries a confidentiality split
  // that the departmental boundary must not weaken or duplicate -- read its header before
  // touching that route.
  MitigatingCircumstance: { via: "student" },
  // studentId is NULLABLE here: a tap of an unrecognised tag belongs to nobody. Those rows
  // fail closed and are visible only to college-wide accounts, which is right -- an
  // unmatched tap is an administrative diagnostic, not a departmental record.
  TagTap: { via: "student" },
```

- [ ] **Step 4: Run and watch them pass**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-scope
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-nested-reads
```

Expected: `smoke-academic-scope` fully green; several of the nested-read assertions now green too.

- [ ] **Step 5: Prove one pair can fail**

Change `StudentQuery` back to `"UNSCOPED"`, re-run, confirm exactly `studentQuery is refused for another department's student` fails and its permission half still passes. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/src/academicScopeModels.js scripts/smoke-academic-scope.mjs
git commit -m "Scope the eleven student-owned models

Each closes a top-level listing route AND the nested includes reading a Student
through it. Every assertion is a refusal paired with a permission, so a server
returning nothing cannot pass.

The prediction models are scoped for the ROUTES that read them; the pipeline that
writes them still runs institution-wide."
```

---

### Task 4: Scope the curriculum models

Seven models reaching a department through the columns Task 1 added.

**Files:**
- Modify: `server/src/academicScopeModels.js`
- Modify: `scripts/smoke-academic-scope.mjs`

**Interfaces:**
- Consumes: the four columns from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-academic-scope.mjs`, same refusal-and-permission shape as Task 3, over:

```js
const CURRICULUM = [
  ["unit",                (p, w) => p.unit.findMany({ where: w })],
  ["cohort",              (p, w) => p.cohort.findMany({ where: w })],
  ["hndSession",          (p, w) => p.hndSession.findMany({ where: w })],
  ["assessment",          (p, w) => p.assessment.findMany({ where: w })],
  ["term",                (p, w) => p.term.findMany({ where: w })],
  ["termCalendar",        (p, w) => p.termCalendar.findMany({ where: w })],
  ["timetableEventGroup", (p, w) => p.timetableEventGroup.findMany({ where: w })],
];
```

Plus the decision this task exists to protect. These need `createdSlotIds` (an array
declared beside the suite's other fixture ids and emptied in its `finally`) and reuse
`business` / `computing` from Task 3:

```js
// NULL MEANS SHOWN TO EVERYONE, for timetable rows and ONLY for timetable rows.
//
// Breaks if: TimetableSlot is declared { via: "course" }, or its own column is treated like
// every other null in this feature. A course-less slot is a workshop or a study-support
// session -- what the model exists to carry -- and failing closed on it deletes those from
// every departmental tutor's timetable.
await check("a course-less timetable slot stays visible to a scoped account", async () => {
  const slot = await db.timetableSlot.create({
    data: { day: 2, startTime: "14:00", endTime: "15:00", title: `Study Support ${stamp}`, published: true },
  });
  createdSlotIds.push(slot.id);
  const rows = await runWithAcademicScope(
    { academicDepartmentIds: [computing.id], collegeWide: false },
    () => guarded.timetableSlot.findMany({ where: { id: slot.id } }),
  );
  assert.equal(rows.length, 1, "a course-less workshop vanished from a scoped timetable");
  return "visible";
});

await check("...but a slot placed IN a department is refused to another one", async () => {
  const slot = await db.timetableSlot.create({
    data: { day: 3, startTime: "09:00", endTime: "10:00", title: `Business Only ${stamp}`, published: true, academicDepartmentId: business.id },
  });
  createdSlotIds.push(slot.id);
  const rows = await runWithAcademicScope(
    { academicDepartmentIds: [computing.id], collegeWide: false },
    () => guarded.timetableSlot.findMany({ where: { id: slot.id } }),
  );
  assert.equal(rows.length, 0, "a Business-only slot reached a Computing scope");
  return "refused";
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-scope
```

Expected: the seven refusals FAIL; the course-less-slot assertion passes (nothing filters it yet); the Business-only refusal FAILS.

- [ ] **Step 3: Declare the seven, and the two timetable models**

```js
  /* ---- Curriculum: reached through the columns spec 2 added ------------------ */
  Unit: { column: "academicDepartmentId" },
  Cohort: { column: "academicDepartmentId" },
  HndSession: { via: "unit" },
  Assessment: { via: "unit" },
  Term: { via: "cohort" },
  TimetableEventGroup: { via: "cohort" },
  TermCalendar: { via: "course" },

  /* ---- Timetable: null means SHOWN TO EVERYONE ------------------------------- */
  // The one inversion in the feature, and it is on the model whose own schema comment says
  // it deliberately carries sessions that are not units -- workshops, study support. Scoped
  // by their OWN column rather than through the course, so a null is a decision somebody
  // took rather than a course that happens to be missing.
  //
  // scopePredicateFor's `{ column }` form emits { academicDepartmentId: { in: ids } }, which
  // EXCLUDES nulls. These two therefore need the OR form below, which is why they are their
  // own kind rather than another { column } entry.
  TimetableSlot: { columnOrNull: "academicDepartmentId" },
  TimetableEvent: { columnOrNull: "academicDepartmentId" },
```

- [ ] **Step 4: Teach `scopePredicateFor` the `columnOrNull` kind**

In `server/src/academicScopeModels.js`, before the `rule.column` branch:

```js
  // SHOWN TO EVERYONE WHEN NULL. The only kind in this map that lets a row through on the
  // absence of a department, and it exists for exactly two models -- see their declaration
  // above for why a workshop must not disappear from a departmental tutor's timetable.
  if (rule.columnOrNull) {
    return { OR: [{ [rule.columnOrNull]: match }, { [rule.columnOrNull]: null }] };
  }
```

...and extend the "every declaration is one of the legal shapes" test in
`academicScopeModels.test.js` to accept it, with a unit test:

```js
test("columnOrNull lets a null through, and still filters a set value", () => {
  assert.deepEqual(scopePredicateFor("TimetableSlot", SCOPED), {
    OR: [{ academicDepartmentId: { in: ["d1", "d2"] } }, { academicDepartmentId: null }],
  });
  // A college-wide caller is still unfiltered, and a narrowed-to-nothing caller still sees
  // the public rows — which is the point of the kind.
  assert.equal(scopePredicateFor("TimetableSlot", WIDE), null);
  assert.deepEqual(scopePredicateFor("TimetableSlot", NARROWED_TO_NOTHING), {
    OR: [{ academicDepartmentId: { in: [] } }, { academicDepartmentId: null }],
  });
});
```

- [ ] **Step 5: Run everything**

```bash
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node --test "src/**/*.test.js"
cd .. && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-scope
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-nested-reads
```

Expected: all green, including every nested-read assertion from Task 2.

- [ ] **Step 6: Prove the timetable inversion can fail**

Change `TimetableSlot` to `{ via: "course" }`, re-run, confirm `a course-less timetable slot stays visible to a scoped account` fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add server/src/academicScopeModels.js server/src/academicScopeModels.test.js scripts/smoke-academic-scope.mjs
git commit -m "Scope the curriculum, and invert the rule for timetable rows

Seven models reach a department through the columns task 1 added. The nested-read
suite from task 2 is now fully green.

TimetableSlot and TimetableEvent get a new columnOrNull kind: null means SHOWN TO
EVERYONE. It is the one inversion in the feature and it is on the model whose own
schema comment says it deliberately carries workshops and study support."
```

---

### Task 5: Re-point the raw SQL at the new column

`scopedCourseJoinFromUnit` joins `Unit → Course` because `Unit` had no column. It does now, which removes a join, removes a redundant duplicate `Unit` join an audit found, and removes the two-definitions-of-department split on one screen.

**Files:**
- Modify: `server/src/academicScopeSql.js`
- Modify: `server/src/academicScopeSql.test.js`
- Modify: `server/src/routes/hnd.js` (the two session aggregates)

**Interfaces:**
- Consumes: `Unit.academicDepartmentId` from Task 1.
- Produces: `scopedUnitJoin(unitIdExpr, offset)` replacing `scopedCourseJoinFromUnit`.

- [ ] **Step 1: Write the failing test**

In `server/src/academicScopeSql.test.js`, replace the `scopedCourseJoinFromUnit` tests with:

```js
test("a session is scoped through its unit in ONE join", async () => {
  // Unit carries the column since spec 2, so the Unit -> Course hop is gone. Fewer joins,
  // and — more importantly — the SAME definition of "which department" that the mark path
  // uses, instead of a second one that could disagree with it on the same screen.
  await runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, async () => {
    const r = scopedUnitJoin('se."unitId"');
    assert.equal(r.join, ' JOIN "Unit" sc_u ON sc_u.id = se."unitId"');
    assert.equal(r.sql, ' AND sc_u."academicDepartmentId" IN ($1)');
    assert.deepEqual(r.params, ["d1"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd server && node --test src/academicScopeSql.test.js
```

Expected: FAIL — `scopedUnitJoin is not defined`.

- [ ] **Step 3: Replace the helper**

In `server/src/academicScopeSql.js`:

```js
/**
 * Scope a session-shaped raw query through its UNIT.
 *
 * ONE JOIN SINCE SPEC 2. This used to go Unit -> Course because Unit carried no department
 * column. It does now, and collapsing the chain does more than save a join: the mark path
 * (scopedStudentJoin) and this path previously reached a department by two DIFFERENT routes,
 * so on GET /hnd/attendance a unit could report populated marks beside a session count of
 * zero. One column, one definition, one answer.
 */
function scopedUnitJoin(unitIdExpr, offset = 0) {
  assertIdExpr(unitIdExpr);
  const { sql, params } = academicSqlPredicate("sc_u", offset);
  if (!sql || sql === " AND false") return { join: "", sql, params };
  return { join: ` JOIN "Unit" sc_u ON sc_u.id = ${unitIdExpr}`, sql, params };
}
```

Export `scopedUnitJoin` and delete `scopedCourseJoinFromUnit`.

- [ ] **Step 4: Update both call sites in `hnd.js`**

Replace `scopedCourseJoinFromUnit('se."unitId"', sParams.length)` with `scopedUnitJoin(...)` and `scopedCourseJoinFromUnit('hs."unitId"')` with `scopedUnitJoin('hs."unitId"')`. Update the file header, which currently explains the two-hop shape.

- [ ] **Step 5: Run everything**

```bash
cd server && node --test src/academicScopeSql.test.js
cd .. && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

Expected: all green, including `a scoped caller counts none of another department's attendance`.

- [ ] **Step 6: Commit**

```bash
git add server/src/academicScopeSql.js server/src/academicScopeSql.test.js server/src/routes/hnd.js
git commit -m "Scope sessions through Unit in one join, not two

Unit carries the column since spec 2. This removes a join, removes a redundant
duplicate Unit join, and removes the split where the mark path and the session
path reached a department by two different routes -- which could show a unit with
populated marks beside a session count of zero on the same screen."
```

---

### Task 6: Run every existing suite as a SCOPED account

The gap that let spec 1 ship green: every suite runs as a college-wide admin, so nothing exercised the filtered path.

**Files:**
- Modify: `scripts/test.mjs` (the runner `npm test` invokes)

**Interfaces:**
- Consumes: everything above.
- Produces: `SMOKE_SCOPED_DEPARTMENT` environment flag.

- [ ] **Step 1: Add the flag**

Teach the runner that when `SMOKE_SCOPED_DEPARTMENT=1`, the seeded admin is narrowed to a department that owns every seeded course, rather than left college-wide.

```js
// EVERY SUITE, AS A SCOPED ACCOUNT. Spec 1 shipped green because every suite ran as a
// college-wide admin, so the filtered path was never executed once. Narrowing the seeded
// admin to a department that owns ALL the seeded data means every existing assertion should
// still pass -- and any that does not has found a query the scoping broke.
```

- [ ] **Step 2: Run the whole suite scoped**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" SMOKE_SCOPED_DEPARTMENT=1 npm test
```

Expected: **every suite still passes.** Each failure is a real finding — a route whose query the guard now filters differently. Fix the route, not the guard.

- [ ] **Step 3: Add it to CI**

In `.github/workflows/ci.yml`, run the suite twice — once college-wide, once scoped. Two runs, because the two paths are genuinely different code and only one of them was ever exercised.

- [ ] **Step 4: Commit**

```bash
git add scripts/test.mjs .github/workflows/ci.yml
git commit -m "Run every suite as a SCOPED account too

The gap that let spec 1 ship green: every suite ran college-wide, so the filtered
path was never executed once. CI now runs both."
```

---

### Task 7: Lift the refusal

Only now is the Access screen telling the truth.

**Files:**
- Modify: `server/src/routes/academicDepartments.js` (remove the narrowing 400)
- Modify: `client/src/StaffHub.jsx` (re-enable the toggle)
- Modify: `scripts/smoke-academic-departments.mjs`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: a working boundary.

- [ ] **Step 1: Flip the assertions**

In `scripts/smoke-academic-departments.mjs`, replace `narrowing an account is REFUSED while nested reads are unfiltered` with:

```js
await check("an account can now be narrowed to a department", async () => {
  const list = await call("/academic-departments", { token: adminToken });
  const biz = list.body.departments.find((d) => d.key === BIZ);
  const res = await call(`/academic-departments/staff/${plain.id}`, {
    method: "PUT", token: boss.token, body: { academicDepartmentIds: [biz.id], collegeWide: false },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body)}`);
  const s = await db.staff.findUnique({ where: { id: plain.id } });
  assert.equal(s.collegeWide, false);
  return "narrowed to Business";
});

// AND THE NARROWING ACTUALLY CONFINES THEM. The assertion above only proves the flag was
// written; this proves it means something, which is the entire point of spec 2.
await check("...and that account is then refused another department's student", async () => {
  const token = (await call("/auth/login", { method: "POST", body: { email: plain.email, password: plain.pw } })).body.token;
  // `computing.id` — the department the fixture student in Task 3 does NOT belong to.
  const res = await call(`/hnd/students?academicDepartmentId=${computing.id}`, { token });
  assert.equal((res.body || []).length, 0, "a Business-scoped account read Computing students");
  return "confined";
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-academic-departments
```

Expected: FAIL with 400 — the refusal is still in place.

- [ ] **Step 3: Remove the refusal**

Delete the `if (!collegeWide) return res.status(400)…` block in `server/src/routes/academicDepartments.js`, and with it the long comment explaining why it was there. Keep the `collegeWide` presence check and the self-lockout guard — both are still right.

- [ ] **Step 4: Re-enable the client toggle**

In `client/src/StaffHub.jsx`, remove `disabled` and the `title` from the college-wide button, and restore the conditional warning:

```jsx
{collegeWide ? (
  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-semibold text-amber-700">
    <AlertCircle size={13} className="mt-px shrink-0" />
    Sees every department&apos;s students, registers, predictions and pastoral records.
  </p>
) : academicMembership.length === 0 ? (
  <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-amber-600">
    <AlertCircle size={13} className="mt-px shrink-0" />
    Not college-wide and on no department — they will see no students, courses or registers at all.
  </p>
) : null}
```

- [ ] **Step 5: Run everything, both ways**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" SMOKE_SCOPED_DEPARTMENT=1 npm test
cd server && DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node --test "src/**/*.test.js"
cd .. && npm --workspace client run build
```

- [ ] **Step 6: Update the specs**

Mark spec 1 §9.2 resolved with the measurement, and spec 2 §1 as closed. Update `STATUS.md`.

- [ ] **Step 7: Commit**

```bash
git add -A server/ client/ scripts/ docs/ STATUS.md
git commit -m "Lift the refusal: an account can be narrowed, and it confines them

Spec 1 shipped a 400 on every narrowing request because the boundary did not hold.
Tasks 1-6 closed it and the nested-read suite proves it. The Access screen is now
telling the truth.

Both assertions matter: one proves the flag was written, the other proves it means
something."
```

---

## Definition of done

- [ ] `smoke-academic-nested-reads.mjs` fully green, with its control reporting a healthy row count.
- [ ] Every model in the spec's §3 marked "spec 2" is declared AND has a refusal/permission pair.
- [ ] A course-less timetable slot is visible to a scoped account; a departmental one is not.
- [ ] `npm test` green **twice** — college-wide and `SMOKE_SCOPED_DEPARTMENT=1`.
- [ ] `node --test "src/**/*.test.js"` green.
- [ ] Client builds; the college-wide toggle works.
- [ ] `PUT /staff/:staffId` accepts `collegeWide: false`.
- [ ] Each new assertion demonstrated able to fail.
- [ ] Migrations applied to local, staging and production; both remote databases checked for drift.

## Still blocked

- **The Moodle probe** needs a working web-service token, or `CREDENTIALS_KEY` for the environment holding one. Unrelated to this plan, still outstanding from spec 1.
