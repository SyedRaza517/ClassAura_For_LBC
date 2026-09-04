// The declaration that says, for every Prisma model, how it is scoped to an academic
// department — and the predicate builder that turns it into a `where` clause.
//
// No database. Run with: node --test src/academicScopeModels.test.js (from server/)
//
// WHY A DECLARATION AND NOT AN INFERENCE. The tenant extension this replaces could
// assume every model had a tenantId. This one cannot: a Semester belongs to no
// department, a Course belongs to one directly, and an AttendanceMark belongs to one only
// through its student. Inferring from the presence of a column would silently leave every
// new model unscoped — the fail-open db.js records as lost when the old guard's
// "fail-closed guard on unrecognised operations" went with it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { MODEL_SCOPE, scopePredicateFor } = require("./academicScopeModels");
const { AcademicScopeError } = require("./academicScope");

const SCOPED = { academicDepartmentIds: ["d1", "d2"], collegeWide: false };
const WIDE = { academicDepartmentIds: [], collegeWide: true };
const NARROWED_TO_NOTHING = { academicDepartmentIds: [], collegeWide: false };

/* -------------------------------------------------------------------------- */
/* Completeness — the property that makes a new model a DECISION               */
/* -------------------------------------------------------------------------- */

test("every model in schema.prisma is declared exactly once, and nothing extra is", () => {
  // The assertion that makes adding a model a decision rather than a silent unscoped
  // default. It fails in BOTH directions on purpose: an undeclared model is a leak, and
  // a declared-but-deleted model is a stale rule nobody will notice is dead.
  const schema = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const declared = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);

  const missing = declared.filter((m) => !(m in MODEL_SCOPE));
  assert.deepEqual(missing, [], `models in the schema but not declared: ${missing.join(", ")}`);

  const extra = Object.keys(MODEL_SCOPE).filter((m) => !declared.includes(m));
  assert.deepEqual(extra, [], `declared but no longer in the schema: ${extra.join(", ")}`);
});

test("every declaration is one of the three legal shapes", () => {
  // A typo like { colum: "…" } would otherwise fall through scopePredicateFor's
  // `rule.column` check into the `via` branch and produce a nonsense predicate that
  // Prisma would reject at runtime, in production, on somebody's student list.
  for (const [model, rule] of Object.entries(MODEL_SCOPE)) {
    const ok = rule === "UNSCOPED"
      || (rule && typeof rule === "object" && typeof rule.column === "string" && Object.keys(rule).length === 1)
      || (rule && typeof rule === "object" && typeof rule.via === "string" && Object.keys(rule).length === 1);
    assert.ok(ok, `${model} has an illegal declaration: ${JSON.stringify(rule)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* scopePredicateFor                                                           */
/* -------------------------------------------------------------------------- */

test("an unscoped model gets no predicate at all", () => {
  assert.equal(scopePredicateFor("Semester", SCOPED), null);
  assert.equal(scopePredicateFor("AcademicDepartment", SCOPED), null);
});

test("a column-scoped model filters on its own id list", () => {
  assert.deepEqual(scopePredicateFor("Course", SCOPED), { academicDepartmentId: { in: ["d1", "d2"] } });
  assert.deepEqual(scopePredicateFor("Student", SCOPED), { academicDepartmentId: { in: ["d1", "d2"] } });
});

test("a relation-scoped model filters through its owner", () => {
  assert.deepEqual(scopePredicateFor("AttendanceMark", SCOPED), {
    student: { academicDepartmentId: { in: ["d1", "d2"] } },
  });
  assert.deepEqual(scopePredicateFor("Enrolment", SCOPED), {
    student: { academicDepartmentId: { in: ["d1", "d2"] } },
  });
});

test("a college-wide scope produces no predicate for any model", () => {
  // This is what makes spec 1 inert. The migration marks every account college-wide, so
  // the guard is live and filters nothing. If this ever returned a predicate, the
  // "no behaviour change" promise of the whole foundation spec would be false.
  for (const model of ["Course", "Student", "AttendanceMark", "Enrolment"]) {
    assert.equal(scopePredicateFor(model, WIDE), null, `${model} must not be filtered for a college-wide caller`);
  }
});

test("a scoped model with an EMPTY department list matches nothing, never everything", () => {
  // The single most dangerous case: a member of staff narrowed off college-wide but not
  // yet given any department. `{ in: [] }` is Prisma's "matches nothing", and it is
  // deliberately NOT shortcut to null — null means "do not filter", which would hand that
  // account the entire college.
  assert.deepEqual(scopePredicateFor("Course", NARROWED_TO_NOTHING), { academicDepartmentId: { in: [] } });
  assert.deepEqual(scopePredicateFor("AttendanceMark", NARROWED_TO_NOTHING), {
    student: { academicDepartmentId: { in: [] } },
  });
});

test("an undeclared model throws rather than passing unscoped", () => {
  assert.throws(() => scopePredicateFor("SomeModelAddedTomorrow", SCOPED), AcademicScopeError);
});

test("the undeclared-model error names the model and the three legal options", () => {
  // The error is read by whoever adds a model six months from now, mid-migration, and it
  // has to tell them what to do rather than only that something is wrong.
  try {
    scopePredicateFor("BrandNewThing", SCOPED);
    assert.fail("should have thrown");
  } catch (e) {
    assert.match(e.message, /BrandNewThing/);
    assert.match(e.message, /UNSCOPED/);
    assert.match(e.message, /column/);
    assert.match(e.message, /via/);
  }
});

test("a missing scope is refused rather than treated as college-wide", () => {
  // db.js throws before it ever calls this, but the two guards are independent and this
  // one must not be the weak half: reading a null scope as "no predicate" would make any
  // future caller that forgets the db.js check silently unscoped.
  for (const bad of [null, undefined]) {
    assert.throws(() => scopePredicateFor("Course", bad), AcademicScopeError, `scope ${bad} must be refused`);
  }
});
