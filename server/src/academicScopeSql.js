// THE PREDICATE FOR RAW SQL, WHICH THE CLIENT EXTENSION CANNOT REACH.
//
// academicScopeGuard.js extends $allModels. $queryRaw and $queryRawUnsafe are CLIENT-level
// methods and never pass through it, so the six attendance aggregates in routes/hnd.js and
// attendanceEmailService.js are protected by nothing the ORM does. routes/hnd.js:6-21
// already recorded this exact hazard from the tenant era — every raw query there scoped
// itself by hand through a requireTenant() helper that threw — and this is that helper's
// replacement, for departments instead of tenants.
//
// IT THROWS RATHER THAN RETURNING AN EMPTY STRING when no scope is bound. hnd.js:15-17
// gives the reason the tenant predicates were deleted outright rather than defaulted to a
// resolved id: "a predicate that is always true reads as a working guard to the next
// person and would be the thing they trusted."
const { currentScope, AcademicScopeError } = require("./academicScope");

// A table alias is INTERPOLATED, not parameterised — SQL has no placeholder for an
// identifier. So it is validated to a short bare word rather than escaped. Everything
// else this helper emits is a bound parameter.
const ALIAS_RE = /^[a-z][a-z0-9_]{0,29}$/i;

/**
 * A ` AND …` fragment confining a raw query to the caller's academic departments.
 *
 * @param {string} alias   SQL alias of a table carrying academicDepartmentId (e.g. "st")
 * @param {number} offset  how many $n placeholders the query already uses
 * @returns {{sql: string, params: string[]}} append `sql` to the WHERE clause and spread
 *          `params` after the query's own, in that order.
 */
function academicSqlPredicate(alias, offset = 0) {
  if (typeof alias !== "string" || !ALIAS_RE.test(alias)) {
    throw new AcademicScopeError(`Unsafe SQL alias: ${JSON.stringify(alias)}`);
  }
  const scope = currentScope();
  if (!scope) {
    throw new AcademicScopeError(
      "A raw SQL aggregate was issued with no academic scope bound. A request must pass " +
      'through requireAuth; background work must declare itself with withoutAcademicScope("<why>").',
    );
  }
  if (scope.collegeWide) return { sql: "", params: [] };

  const ids = scope.academicDepartmentIds || [];
  // No departments means NOTHING, not everything — the same rule scopePredicateFor
  // follows for `{ in: [] }`. An empty string here would hand an account narrowed off
  // college-wide the entire college's attendance figures.
  if (!ids.length) return { sql: " AND false", params: [] };

  const holders = ids.map((_, i) => `$${offset + i + 1}`).join(",");
  return { sql: ` AND ${alias}."academicDepartmentId" IN (${holders})`, params: ids };
}

// A column reference like `am."studentId"` — an alias, a dot, and a quoted or bare
// column. Interpolated into an ON clause for the same reason the alias is: SQL has no
// placeholder for an identifier. Anything with a space, a semicolon or a quote it did not
// open and close is refused rather than escaped.
const ID_EXPR_RE = /^[a-z][a-z0-9_]{0,29}\.(?:"[A-Za-z][A-Za-z0-9_]{0,60}"|[a-z][a-z0-9_]{0,60})$/i;

function assertIdExpr(expr) {
  if (typeof expr !== "string" || !ID_EXPR_RE.test(expr)) {
    throw new AcademicScopeError(`Unsafe SQL id expression: ${JSON.stringify(expr)}`);
  }
}

/**
 * Scope a mark-shaped raw query through the STUDENT it belongs to.
 *
 * @param {string} studentIdExpr e.g. `am."studentId"`
 * @param {number} offset        placeholders the query already uses
 * @returns {{join: string, sql: string, params: string[]}}
 *
 * THE JOIN IS EMPTY UNLESS IT IS ACTUALLY FILTERING, and that is the important part.
 * Always joining would change the row set for college-wide callers too — an INNER JOIN
 * drops rows whose foreign key is null — and spec 1 promises no behaviour change for
 * anybody. A college-wide caller therefore gets back exactly the query that was there
 * before this existed, character for character.
 */
function scopedStudentJoin(studentIdExpr, offset = 0) {
  assertIdExpr(studentIdExpr);
  const { sql, params } = academicSqlPredicate("sc_st", offset);
  // No predicate, or a predicate that already matches nothing: no join is needed, and
  // adding one would change the plan (and the row set) for no gain.
  if (!sql || sql === " AND false") return { join: "", sql, params };
  return { join: ` JOIN "Student" sc_st ON sc_st.id = ${studentIdExpr}`, sql, params };
}

/**
 * Scope a session-shaped raw query through its UNIT.
 *
 * A session has no student — it is a scheduled class, and the register may be empty — so it
 * reaches a department through the unit it belongs to.
 *
 * ONE JOIN SINCE SPEC 2, and collapsing the chain does more than save a join. This used to
 * go Unit -> Course because Unit carried no department column, which meant the mark path
 * (scopedStudentJoin, via Student) and this path reached a department by two DIFFERENT
 * definitions. On GET /hnd/attendance that could render a unit with populated marks beside
 * a session count of zero — the numerator and the denominator disagreeing about which
 * department they belonged to. One column, one definition, one answer.
 *
 * @param {string} unitIdExpr e.g. `se."unitId"`
 * @param {number} offset     placeholders the query already uses
 */
function scopedUnitJoin(unitIdExpr, offset = 0) {
  assertIdExpr(unitIdExpr);
  const { sql, params } = academicSqlPredicate("sc_u", offset);
  if (!sql || sql === " AND false") return { join: "", sql, params };
  return { join: ` JOIN "Unit" sc_u ON sc_u.id = ${unitIdExpr}`, sql, params };
}

module.exports = { academicSqlPredicate, scopedStudentJoin, scopedUnitJoin, ALIAS_RE, ID_EXPR_RE };
