// THE NESTED-READ LEAK, held closed permanently.
//
// academicScopeGuard.js rewrites the TOP-LEVEL query. A Prisma client extension cannot reach
// a nested `include`, so an UNSCOPED parent reaching a SCOPED child hands back rows the
// caller may not see. Measured 4 Sep 2026 with a scope owning nothing:
// student.findMany() returned 0 while hndSession.findMany({include:{marks:true}}) returned
// 194 attendance marks and unit.findMany({include:{enrolments:true}}) returned 34 enrolments.
//
// This is the leak that stopped spec 1 shipping its Access control, and the spec 1 design
// predicted it in its own §9.2 -- "a claim to be tested, not assumed" -- and then did not
// test it. The fix is to scope the PARENT, which is what spec 2 does. This suite is how we
// know it worked, and how we would find out if a later migration added a model that reopened
// it.
//
// THE SCOPE USED IS A REAL DEPARTMENT THAT OWNS NOTHING, not an empty id list. `{ in: [] }`
// and `{ in: ["real-but-empty"] }` take different paths through scopePredicateFor, and the
// second is what an actually-narrowed account sends.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}

console.log("\n=== nested reads: an unscoped parent must not reach a scoped child ===\n");

// The guard is applied to THIS suite's own client rather than by requiring server/src/db.js,
// which constructs a client with no explicit datasource — see smoke-academic-scope.mjs.
const { withAcademicScopeGuard } = require(`${ROOT}/server/src/academicScopeGuard`);
const { runWithAcademicScope, withoutAcademicScope } = require(`${ROOT}/server/src/academicScope`);
const guarded = withAcademicScopeGuard(db);

try {
  await db.academicDepartment.count();
} catch {
  console.log("SKIP — AcademicDepartment is not migrated in this build");
  await db.$disconnect();
  process.exit(2);
}

const stamp = Date.now();
const emptyDept = await db.academicDepartment.create({
  data: { key: `empty-${stamp}`, name: `Owns Nothing ${stamp}` },
});
const EMPTY = { academicDepartmentIds: [emptyDept.id], collegeWide: false };

// FIXTURES FOR THE SHAPES THE SEED DOES NOT COVER.
//
// The seeded college has units, sessions, marks and enrolments, but no predictions, no
// pastoral records, no reviews and no graded assessments -- so nine of the thirteen shapes
// below would assert "0 leaked" against a table that is simply empty. That is the failure
// CLAUDE.md records twice: a test that passes while discriminating nothing. The control at
// the end names any shape still without data, so this cannot rot silently either.
//
// Every row hangs off ONE student in a real department, so a scope owning nothing must see
// none of it and a college-wide caller must see all of it.
const fx = { ids: {} };
const fxDept = await db.academicDepartment.create({ data: { key: `nest-${stamp}`, name: `Nested Fixture ${stamp}` } });
const fxCourse = await db.course.create({ data: { name: `Nested Course ${stamp}`, academicDepartmentId: fxDept.id } });
const fxCohort = await db.cohort.create({ data: { name: `Nested Cohort ${stamp}`, courseId: fxCourse.id, academicDepartmentId: fxDept.id } });
const fxUnit = await db.unit.create({ data: { code: `NST${stamp}`, name: "Nested Unit", courseId: fxCourse.id, academicDepartmentId: fxDept.id } });
const fxStudent = await db.student.create({
  data: {
    firstName: "Nested", lastName: "Fixture", studentRef: `NST${stamp}`,
    email: `nested.${stamp}@edtech.co.uk`, initials: "NF", colour: "#334455",
    cohortId: fxCohort.id, academicDepartmentId: fxDept.id,
  },
});
const fxAssessment = await db.assessment.create({ data: { unitId: fxUnit.id, title: `Nested Assessment ${stamp}` } });
await db.assessmentGrade.create({ data: { assessmentId: fxAssessment.id, studentId: fxStudent.id, marks: 55 } });
await db.interaction.create({ data: { studentId: fxStudent.id, date: "2026-09-01", time: "10:00", queryType: "1 to 1 Meeting" } });
await db.studentQuery.create({ data: { studentId: fxStudent.id, message: "Nested fixture query" } });
await db.studentReview.create({ data: { studentId: fxStudent.id, date: "2026-09-01", progress: "Good" } });
await db.intervention.create({ data: { studentId: fxStudent.id, interventionDate: "2026-09-01", interventionType: "Meeting", riskLevelAtIntervention: "AMBER", missingAtIntervention: 1 } });
await db.mitigatingCircumstance.create({ data: { studentId: fxStudent.id, coversFrom: "2026-09-01", coversTo: "2026-09-30", raisedOn: "2026-09-01" } });
await db.studentPredictionCurrent.create({
  data: {
    studentId: fxStudent.id, missingAssessmentCount: 0, gradeTrend: "steady", interventionResponse: "none",
    baseProgressionScore: 70, progressionScore: 70, baseRiskLevel: "GREEN", riskLevel: "GREEN",
    directionOfTravel: "steady", overrideCodes: [], riskDriverCodes: [], positiveDriverCodes: [],
    modelVersion: "test", lastCalculated: new Date(),
  },
});
fx.ids = { fxDept, fxCourse, fxCohort, fxUnit, fxStudent, fxAssessment };

// Every (parent -> child) shape where the parent has historically been unscoped and the
// child holds student data. Each returns a count so a leak is a number rather than a boolean.
const NESTED = [
  { label: "hndSession -> marks", run: (p) => p.hndSession.findMany({ include: { marks: true } }),
    count: (r) => r.reduce((n, x) => n + x.marks.length, 0) },
  { label: "unit -> enrolments", run: (p) => p.unit.findMany({ include: { enrolments: true } }),
    count: (r) => r.reduce((n, x) => n + x.enrolments.length, 0) },
  { label: "unit -> sessions -> marks", run: (p) => p.unit.findMany({ include: { sessions: { include: { marks: true } } } }),
    count: (r) => r.reduce((n, x) => n + x.sessions.reduce((m, s) => m + s.marks.length, 0), 0) },
  { label: "cohort -> students", run: (p) => p.cohort.findMany({ include: { students: true } }),
    count: (r) => r.reduce((n, x) => n + x.students.length, 0) },
  { label: "unit -> _count.enrolments", run: (p) => p.unit.findMany({ include: { _count: { select: { enrolments: true } } } }),
    count: (r) => r.reduce((n, x) => n + x._count.enrolments, 0) },
  { label: "prediction -> student", run: (p) => p.studentPredictionCurrent.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "interaction -> student", run: (p) => p.interaction.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "studentQuery -> student", run: (p) => p.studentQuery.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "studentReview -> student", run: (p) => p.studentReview.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "assessmentGrade -> student", run: (p) => p.assessmentGrade.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "intervention -> student", run: (p) => p.intervention.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "mitigation -> student", run: (p) => p.mitigatingCircumstance.findMany({ include: { student: true } }),
    count: (r) => r.length },
  { label: "assessment -> grades", run: (p) => p.assessment.findMany({ include: { grades: true } }),
    count: (r) => r.reduce((n, x) => n + x.grades.length, 0) },
];

try {
  for (const t of NESTED) {
    await check(`${t.label} leaks nothing to a scope that owns nothing`, async () => {
      const rows = await runWithAcademicScope(EMPTY, () => t.run(guarded));
      const n = t.count(rows);
      assert.equal(n, 0, `returned ${n} row(s) a scoped account must not see`);
      return "0";
    });
  }

  // THE CONTROL, once, over the whole set.
  //
  // Without it every assertion above passes against a database that simply has no data —
  // which is exactly how smoke-tenant-isolation.mjs came to discriminate nothing and was
  // deleted rather than adapted. If this fails, the suite above proves nothing and the seed
  // needs more fixtures, not the guard needs changing.
  await check("...and a college-wide caller still sees the same data", async () => {
    const seen = [];
    await withoutAcademicScope("nested-read control: proves the shapes above hold data at all", async () => {
      for (const t of NESTED) seen.push(t.count(await t.run(guarded)));
    });
    const total = seen.reduce((a, b) => a + b, 0);
    const empty = NESTED.filter((_, i) => seen[i] === 0).map((t) => t.label);
    assert.ok(total > 0, "the college-wide caller saw nothing either, so none of the above proves anything");
    return `${total} row(s) across ${NESTED.length - empty.length}/${NESTED.length} shapes` +
      (empty.length ? ` — no fixtures for: ${empty.join(", ")}` : "");
  });
} finally {
  // Children first, then the student, then the curriculum, then the departments — the
  // relations are a mix of Cascade and SetNull, so leaving it to cascades would leave rows
  // behind for whichever suite runs next.
  const sid = fx.ids.fxStudent?.id;
  if (sid) {
    for (const m of ["assessmentGrade", "interaction", "studentQuery", "studentReview", "intervention", "mitigatingCircumstance", "studentPredictionCurrent"]) {
      await db[m].deleteMany({ where: { studentId: sid } }).catch(() => {});
    }
    await db.student.deleteMany({ where: { id: sid } }).catch(() => {});
  }
  if (fx.ids.fxAssessment) await db.assessment.deleteMany({ where: { id: fx.ids.fxAssessment.id } }).catch(() => {});
  if (fx.ids.fxUnit) await db.unit.deleteMany({ where: { id: fx.ids.fxUnit.id } }).catch(() => {});
  if (fx.ids.fxCohort) await db.cohort.deleteMany({ where: { id: fx.ids.fxCohort.id } }).catch(() => {});
  if (fx.ids.fxCourse) await db.course.deleteMany({ where: { id: fx.ids.fxCourse.id } }).catch(() => {});
  if (fx.ids.fxDept) await db.academicDepartment.deleteMany({ where: { id: fx.ids.fxDept.id } }).catch(() => {});
  await db.academicDepartment.deleteMany({ where: { id: emptyDept.id } }).catch(() => {});
  await db.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
