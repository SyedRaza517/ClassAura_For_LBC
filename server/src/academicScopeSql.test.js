// The hand-written predicate for raw SQL, which no client extension can reach.
//
// No database. Run with: node --test src/academicScopeSql.test.js  (from server/)
//
// WHY THIS EXISTS SEPARATELY FROM THE EXTENSION. academicScopeGuard.js hooks $allModels.
// $queryRaw and $queryRawUnsafe are CLIENT-level methods and never pass through it, so
// six attendance aggregates in routes/hnd.js and attendanceEmailService.js are protected
// by nothing the ORM does. routes/hnd.js:6-21 already recorded this from the tenant era,
// where every raw query scoped itself by hand through a requireTenant() that threw.
const test = require("node:test");
const assert = require("node:assert/strict");

const { academicSqlPredicate } = require("./academicScopeSql");
const { runWithAcademicScope, withoutAcademicScope, AcademicScopeError } = require("./academicScope");

test("throws when no scope is bound, rather than returning an empty predicate", () => {
  // An always-true predicate "reads as a working guard to the next person and would be
  // the thing they trusted" — hnd.js:15-17, on why the tenant predicates were deleted
  // outright rather than defaulted to a resolved id.
  assert.throws(() => academicSqlPredicate("st"), AcademicScopeError);
});

test("a college-wide caller gets an empty predicate and no parameters", async () => {
  await withoutAcademicScope("test", async () => {
    assert.deepEqual(academicSqlPredicate("st"), { sql: "", params: [] });
  });
});

test("a scoped caller gets a parameterised IN clause on the given alias", async () => {
  await runWithAcademicScope({ academicDepartmentIds: ["d1", "d2"], collegeWide: false }, async () => {
    const { sql, params } = academicSqlPredicate("st");
    assert.equal(sql, ` AND st."academicDepartmentId" IN ($1,$2)`);
    assert.deepEqual(params, ["d1", "d2"]);
  });
});

test("a scoped caller with NO departments gets a predicate that matches nothing", async () => {
  // The same rule scopePredicateFor follows for `{ in: [] }`. An empty string here would
  // hand an account narrowed off college-wide the entire college's attendance figures.
  await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: false }, async () => {
    const { sql, params } = academicSqlPredicate("st");
    assert.equal(sql, " AND false");
    assert.deepEqual(params, []);
  });
});

test("the alias is validated, because it is interpolated and cannot be parameterised", async () => {
  // SQL has no placeholder for an identifier, so the alias is the one part of this that
  // is concatenated. It is checked rather than escaped.
  await runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, async () => {
    for (const bad of ['st"; DROP TABLE "Student', "st st", "", "1st", "st;--", null, undefined, "a".repeat(31)]) {
      assert.throws(() => academicSqlPredicate(bad), AcademicScopeError, `alias ${JSON.stringify(bad)} must be refused`);
    }
  });
});

test("the parameter offset shifts the placeholders so the clause composes", async () => {
  // Every caller already has its own $1..$n. Appending a clause that restarted at $1
  // would silently re-bind the query's own parameters to department ids.
  await runWithAcademicScope({ academicDepartmentIds: ["d1", "d2"], collegeWide: false }, async () => {
    const { sql, params } = academicSqlPredicate("st", 3);
    assert.equal(sql, ` AND st."academicDepartmentId" IN ($4,$5)`);
    assert.deepEqual(params, ["d1", "d2"]);
  });
});

test("a college-wide caller's empty predicate is safe to append at any offset", async () => {
  await withoutAcademicScope("test", async () => {
    assert.deepEqual(academicSqlPredicate("st", 7), { sql: "", params: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* The join builders                                                           */
/* -------------------------------------------------------------------------- */

const { scopedStudentJoin, scopedCourseJoinFromUnit } = require("./academicScopeSql");

test("a college-wide caller gets NO join at all, so the query is byte-identical", async () => {
  // THE POINT OF RETURNING AN EMPTY JOIN rather than always joining. An INNER JOIN to
  // Course would drop every session whose unit has no course (Unit.courseId is nullable),
  // changing the numbers for college-wide callers — and spec 1 promises no behaviour
  // change for anybody. So the join appears only when it is actually filtering.
  await withoutAcademicScope("test", async () => {
    assert.deepEqual(scopedStudentJoin('am."studentId"'), { join: "", sql: "", params: [] });
    assert.deepEqual(scopedCourseJoinFromUnit('se."unitId"'), { join: "", sql: "", params: [] });
  });
});

test("a scoped caller gets a Student join and a predicate on it", async () => {
  await runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, async () => {
    const r = scopedStudentJoin('am."studentId"');
    assert.equal(r.join, ' JOIN "Student" sc_st ON sc_st.id = am."studentId"');
    assert.equal(r.sql, ' AND sc_st."academicDepartmentId" IN ($1)');
    assert.deepEqual(r.params, ["d1"]);
  });
});

test("a scoped caller gets Unit+Course joins and a predicate on the course", async () => {
  // A session has no student. It reaches a department through its unit's course, which is
  // where the column lives — Unit does not carry one until spec 2.
  await runWithAcademicScope({ academicDepartmentIds: ["d1", "d2"], collegeWide: false }, async () => {
    const r = scopedCourseJoinFromUnit('se."unitId"', 2);
    assert.equal(r.join, ' JOIN "Unit" sc_u ON sc_u.id = se."unitId" JOIN "Course" sc_c ON sc_c.id = sc_u."courseId"');
    assert.equal(r.sql, ' AND sc_c."academicDepartmentId" IN ($3,$4)');
    assert.deepEqual(r.params, ["d1", "d2"]);
  });
});

test("a narrowed-to-nothing caller gets `AND false` and STILL no join", async () => {
  // No join, because `AND false` already matches nothing and an unnecessary join would
  // change the plan for no reason. The predicate is what does the work.
  await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: false }, async () => {
    assert.deepEqual(scopedStudentJoin('am."studentId"'), { join: "", sql: " AND false", params: [] });
    assert.deepEqual(scopedCourseJoinFromUnit('se."unitId"'), { join: "", sql: " AND false", params: [] });
  });
});

test("both join builders refuse with no scope bound", () => {
  assert.throws(() => scopedStudentJoin('am."studentId"'), AcademicScopeError);
  assert.throws(() => scopedCourseJoinFromUnit('se."unitId"'), AcademicScopeError);
});

test("the id expression is validated, because it is interpolated into the ON clause", async () => {
  await runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, async () => {
    for (const bad of ['am."studentId"; DROP TABLE "Student" --', "am.studentId OR 1=1", "", null]) {
      assert.throws(() => scopedStudentJoin(bad), AcademicScopeError, `expr ${JSON.stringify(bad)} must be refused`);
    }
  });
});
