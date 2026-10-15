// The leaver rule on GET /hnd/attendance/monthly, and the fold behind its figures.
//
// No database. Run with: node --test src/routes/hnd.monthly.test.js  (from server/)
// Never `node --test src/` — a bare directory walks into src/index.js, which binds a
// port and starts the schedulers, and the run never terminates.
//
// WHY THESE ASSERTIONS AND NOT A ROW COUNT. The counting for this endpoint happens in
// Postgres (GROUP BY on left(date,7)), deliberately: grouping every AttendanceMark in
// Node is what OOM-crashed this server at scale, and moving it back here to make it
// testable would reintroduce the bug the comment in hnd.js warns about. So the part of
// the handler that can be exercised in process is the QUERY IT BUILDS plus the Node-side
// fold, and that is exactly where the defect lived: the query joined Enrolment nowhere,
// while GET /attendance and GET /students/:id/attendance-terms both count only marks on
// units the student is still enrolled on. Live, the three endpoints reported one student
// (0 enrolments, 10 marks) as pct 100 / marked 10, pct null / marked 0, and pct null
// respectively, and the college-wide totals differed by 82 marks while both rounded to
// 65.6% — which is why nobody caught it by comparing headlines.
//
// What this file therefore CANNOT prove is that the predicate is true of the live data;
// that is an HTTP-level question for a scripts/smoke-*.mjs suite against seeded
// fixtures. What it does prove is that the predicate is in the query, that it correlates
// on BOTH columns (a student-only EXISTS would fix the zero-enrolment student and leave
// the other eleven wrong), that it cannot renumber the filters' bound parameters, and
// that the fold still answers null — never 0% — for a caller with nothing measurable.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const hndRouter = require("./hnd");
const { buildMonthlyMarkQuery, buildMonthlySessionQuery, foldMonthlyBuckets } = hndRouter;
const { runWithAcademicScope, withoutAcademicScope } = require("../academicScope");
const { summariseCounts } = require("../attendance");

// scopedStudentJoin/scopedUnitJoin THROW when no academic scope is bound (see
// academicScopeSql.js on why an empty predicate was rejected as a default), so every
// builder call has to declare one. withoutAcademicScope is the college-wide case: no
// join, no predicate, and the query is character-for-character what a college-wide
// caller has always received — plus the leaver rule, which is the point.
const collegeWide = (fn) => withoutAcademicScope("test", fn);

// Whitespace-insensitive containment. The builder's SQL is a template literal with
// indentation in it, and a test that cared about that would fail on reformatting while
// still not noticing a missing predicate.
const squash = (s) => String(s).replace(/\s+/g, " ").trim();

test("the router is still the router, and the three helpers hang off it", () => {
  // The seam: index.js mounts this module as Express middleware, so `module.exports`
  // must stay a callable Router. Replacing it with `{ router, buildMonthlyMarkQuery }`
  // is a natural-looking refactor that Express does not reject at require time — every
  // HND route would 500 on its first request instead. routes/mitigations.test.js
  // guards the identical trap for the same file-level reason.
  assert.equal(typeof hndRouter, "function");
  assert.ok(hndRouter.stack, "an Express Router carries a .stack");
  assert.equal(typeof buildMonthlyMarkQuery, "function");
  assert.equal(typeof buildMonthlySessionQuery, "function");
  assert.equal(typeof foldMonthlyBuckets, "function");
});

/* ------------------------- the leaver rule in the query ------------------------- */

test("the unfiltered college-wide month query carries the leaver rule", async () => {
  // THE REGRESSION TEST. This is the shape that reported marked=13185 against the
  // matrix's 13103 — no studentId, no unit, no course, no filters at all, which is
  // precisely the shape whose `conds` array used to be empty and whose WHERE clause
  // used to be omitted entirely.
  await collegeWide(() => {
    const { sql, params } = buildMonthlyMarkQuery({});
    assert.deepEqual(params, [], "an unfiltered college-wide query binds nothing");
    assert.match(squash(sql), /WHERE EXISTS \(/, "the WHERE clause can no longer be omitted");
    assert.ok(
      squash(sql).includes(
        `EXISTS (SELECT 1 FROM "Enrolment" en WHERE en."studentId" = am."studentId" AND en."unitId" = se."unitId")`,
      ),
      "every month bucket must be restricted to marks on units the student is enrolled on",
    );
  });
});

test("the per-student month query carries the leaver rule too", async () => {
  // The other half of the reproduction: ?studentId=<id> for a student with no
  // enrolments returned pct 100 / marked 10 while the drill-down said null / 0.
  await collegeWide(() => {
    const { sql, params } = buildMonthlyMarkQuery({ studentId: "stu-1" });
    assert.deepEqual(params, ["stu-1"]);
    assert.ok(squash(sql).includes(`EXISTS (SELECT 1 FROM "Enrolment" en`));
    assert.ok(squash(sql).includes(`am."studentId" = $1`));
  });
});

test("the leaver rule correlates on BOTH the student and the unit", async () => {
  // A HALF-FIX WOULD PASS THE TWO TESTS ABOVE. `EXISTS (SELECT 1 FROM "Enrolment" en
  // WHERE en."studentId" = am."studentId")` — "has any enrolment at all" — excludes the
  // three students with zero enrolments and keeps counting the other eleven's marks on
  // units they have left. On the live data that recovers some of the 82 marks and none
  // of the disagreement, which is the worst possible outcome: the headline moves, the
  // tiles still differ, and the next person believes it is fixed.
  await collegeWide(() => {
    const sql = squash(buildMonthlyMarkQuery({}).sql);
    const exists = sql.slice(sql.indexOf("EXISTS ("));
    assert.ok(exists.includes(`en."studentId" = am."studentId"`), "must match the mark's student");
    assert.ok(exists.includes(`en."unitId" = se."unitId"`), "must match the session's unit");
  });
});

test("the leaver rule is a semi-join, never a join that could count a mark twice", async () => {
  // Enrolment is @@unique([studentId, unitId]) today, so `JOIN "Enrolment"` would count
  // identically — but that correctness would rest on the constraint surviving every
  // future migration, and a fan-out inflates `marked` while leaving `pct` plausible.
  await collegeWide(() => {
    const sql = squash(buildMonthlyMarkQuery({}).sql);
    assert.ok(!/JOIN "Enrolment"/.test(sql), "an inner join on Enrolment can fan out; EXISTS cannot");
  });
});

test("the leaver rule is ANDed with the filters, not ORed past them", async () => {
  await collegeWide(() => {
    const sql = squash(buildMonthlyMarkQuery({ studentId: "stu-1", unitId: "u-1" }).sql);
    assert.ok(!/ OR /i.test(sql), "an OR anywhere in this WHERE clause would widen it, not narrow it");
    assert.match(sql, /WHERE EXISTS \(.*\) AND am\."studentId" = \$1 AND se\."unitId" = \$2/);
  });
});

test("the leaver rule binds no parameter, so it cannot renumber the filters", async () => {
  // It is pushed onto `conds` FIRST, ahead of every filter. That is only safe because it
  // contributes nothing to `params`: a parameterised predicate in that position would
  // shift every $n after it and silently re-bind courseId to a year, which Postgres
  // would accept for the string filters and reject for the integer ones — intermittently.
  await collegeWide(() => {
    const { sql, params } = buildMonthlyMarkQuery({
      studentId: "stu-1", unitId: "u-1", courseId: "c-1", year: "2", termNumber: "3",
      academicDepartmentId: "dep-1",
    });
    assert.deepEqual(params, ["stu-1", "u-1", "c-1", 2, 3, "dep-1"]);
    const used = [...new Set(squash(sql).match(/\$\d+/g) || [])].map((p) => Number(p.slice(1))).sort((a, b) => a - b);
    assert.deepEqual(used, [1, 2, 3, 4, 5, 6], "every placeholder is bound exactly once, in order");
  });
});

test("a department-scoped caller keeps their predicate after the filters' parameters", async () => {
  // The scope is appended by hand because $queryRawUnsafe never reaches the client
  // extension. Its placeholders are offset by params.length, so the leaver rule going
  // in first must not have disturbed that either.
  await runWithAcademicScope({ academicDepartmentIds: ["d1", "d2"], collegeWide: false }, () => {
    const { sql, params } = buildMonthlyMarkQuery({ studentId: "stu-1" });
    assert.deepEqual(params, ["stu-1", "d1", "d2"]);
    const squashed = squash(sql);
    assert.ok(squashed.includes(`JOIN "Student" sc_st ON sc_st.id = am."studentId"`));
    assert.ok(squashed.includes(`sc_st."academicDepartmentId" IN ($2,$3)`));
    assert.ok(squashed.includes(`EXISTS (SELECT 1 FROM "Enrolment" en`), "scoped callers get the leaver rule too");
  });
});

test("a scoped caller with no departments still sees nothing, leaver rule or not", async () => {
  // " AND false" rather than an empty string — an account narrowed off college-wide must
  // not be handed the college. The leaver rule narrows further; it must never widen.
  await runWithAcademicScope({ academicDepartmentIds: [], collegeWide: false }, () => {
    const { sql } = buildMonthlyMarkQuery({});
    assert.match(squash(sql), /AND false/);
  });
});

test("a stray year or term is still ignored rather than emptying the chart", async () => {
  // Unchanged behaviour, asserted because the builder now owns the parsing the handler
  // used to do inline, and a regression here empties a dashboard rather than erroring.
  await collegeWide(() => {
    for (const bad of ["", "nonsense", "0", "99", "1.5", null, undefined]) {
      assert.deepEqual(buildMonthlyMarkQuery({ year: bad, termNumber: bad }).params, [],
        `year/termNumber ${JSON.stringify(bad)} must not reach the query`);
    }
  });
});

/* ------------------------- the sessions count, untouched ------------------------- */

test("the sessions count is NOT scoped by student and does NOT get the leaver rule", async () => {
  // A session is a scheduled class with no student, so neither question applies to it.
  // A per-student request therefore reads `marked: 19` beside `sessions: 601`, which is
  // confusing and is a PRESENTATION problem for whichever dashboard renders the two
  // together. This test exists so that nobody fixes it here by quietly narrowing a count
  // that GET /attendance also publishes (as scope.sessionCount) and that every
  // college-wide caller reads — which would recreate, one screen over, the exact
  // disagreement the leaver rule above was added to end.
  await collegeWide(() => {
    const { sql, params } = buildMonthlySessionQuery({ studentId: "stu-1" });
    assert.deepEqual(params, [], "studentId is not a filter a session can carry");
    assert.ok(!squash(sql).includes("studentId"), "a session has no student");
    assert.ok(!squash(sql).includes("Enrolment"), "and so cannot have left a unit");
    assert.equal(squash(sql), `SELECT count(*)::int n FROM "HndSession" se`);
  });
});

test("the sessions count still tracks the course, stage and school filters", async () => {
  await collegeWide(() => {
    const { sql, params } = buildMonthlySessionQuery({ courseId: "c-1", year: "1", termNumber: "2" });
    assert.deepEqual(params, ["c-1", 1, 2]);
    assert.ok(squash(sql).includes(`JOIN "Unit" u ON u.id = se."unitId"`));
    const none = buildMonthlySessionQuery({ academicDepartmentId: "none" });
    assert.ok(squash(none.sql).includes(`u."academicDepartmentId" IS NULL`));
    assert.deepEqual(none.params, []);
  });
});

/* --------------------------- the fold: null is not zero -------------------------- */

test("no countable marks reads null, never 0%", () => {
  // THE MOST IMPORTANT RULE IN THIS CODEBASE, and the one the fix had to not break.
  // After the leaver rule, the student this was reported against — ten marks, no
  // enrolments — contributes no rows at all, so the fold is handed an empty set. Their
  // percentage is NOT MEASURABLE, which is null; 0% is a lie that puts them top of a
  // risk list for something nobody measured. `marked` is a genuine 0: zero were counted.
  const { months, totals } = foldMonthlyBuckets([]);
  assert.deepEqual(months, []);
  assert.equal(totals.pct, null);
  assert.notEqual(totals.pct, 0, "0 and null are different answers here");
  assert.equal(totals.marked, 0);
  assert.deepEqual([totals.present, totals.late, totals.excused, totals.absent], [0, 0, 0, 0]);
});

test("a month with no marks reads null too, while a month of absences reads 0", () => {
  // The distinction, side by side in one response: nobody marked vs everybody absent.
  const [empty, allAbsent] = foldMonthlyBuckets([
    { ym: "2026-01", p: 0, l: 0, e: 0, a: 0 },
    { ym: "2026-02", p: 0, l: 0, e: 0, a: 4 },
  ]).months;
  assert.equal(empty.pct, null);
  assert.equal(empty.marked, 0);
  assert.equal(allAbsent.pct, 0, "a genuine zero must survive as zero");
  assert.equal(allAbsent.marked, 4);
});

test("the totals are the sum of the buckets, so one leaver rule governs both", () => {
  // WHY THE FOLD IS ONE FUNCTION. The rule is applied once, in SQL, to one population;
  // the buckets and the totals are both read off it. Applying it to only one of them is
  // the shape of the bug the matrix's comment describes — columns and headline computed
  // over different sets of marks, agreeing closely enough, often enough, to look right.
  // The two populated months are deliberately DIFFERENT SIZES (10 marks and 20), so a
  // mean-of-months headline and a pooled one cannot coincide — with equal months they
  // are the same number and the last assertion in this test would prove nothing.
  const rows = [
    { ym: "2026-01", p: 7, l: 1, e: 0, a: 2 },
    { ym: "2026-02", p: 3, l: 0, e: 2, a: 15 },
    { ym: "2026-03", p: 0, l: 0, e: 0, a: 0 },
  ];
  const { months, totals } = foldMonthlyBuckets(rows);
  assert.equal(months.length, 3);
  assert.deepEqual(months.map((m) => m.month), ["2026-01", "2026-02", "2026-03"]);
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  assert.equal(totals.present, sum("p"));
  assert.equal(totals.late, sum("l"));
  assert.equal(totals.excused, sum("e"));
  assert.equal(totals.absent, sum("a"));
  assert.equal(totals.marked, sum("p") + sum("l") + sum("e") + sum("a"));
  // And the headline percentage is the one the shared points model gives for that sum,
  // not an average of the months' percentages — which would weight a quiet month equally
  // with a busy one and drift away from the matrix's figure by a little, every time.
  assert.equal(totals.pct, summariseCounts(sum("p"), sum("l"), sum("e"), sum("a")).pct);
  assert.notEqual(totals.pct, Math.round((months.filter((m) => m.pct !== null)
    .reduce((n, m) => n + m.pct, 0) / 2) * 10) / 10);
});

test("the fold agrees with the matrix's arithmetic over the same population", () => {
  // The three endpoints can only agree if they apply the same RULE and the same POINTS
  // MODEL. The rule is SQL and is covered above; this is the model. Given one fixture of
  // marks plus enrolments, the matrix's loop (skip any (student, unit) pair with no
  // enrolment, then summariseCounts the survivors) and this fold over the same survivors
  // grouped by month must produce the identical headline — including when the leaver
  // marks are the only ones a student has.
  const enrolments = new Set(["s1|u1", "s2|u1"]); // s3 is enrolled on nothing
  const marks = [
    { sid: "s1", mid: "u1", ym: "2026-01", status: "P" },
    { sid: "s1", mid: "u1", ym: "2026-02", status: "A" },
    { sid: "s2", mid: "u1", ym: "2026-01", status: "L" },
    { sid: "s2", mid: "u9", ym: "2026-01", status: "P" }, // left u9
    { sid: "s3", mid: "u9", ym: "2026-02", status: "P" }, // no enrolments at all
  ];
  const counted = marks.filter((m) => enrolments.has(`${m.sid}|${m.mid}`));
  assert.equal(counted.length, 3, "two of the five marks are on units nobody is enrolled on");

  const g = { P: 0, L: 0, E: 0, A: 0 };
  for (const m of counted) g[m.status] += 1;
  const matrixOverall = summariseCounts(g.P, g.L, g.E, g.A);

  const byMonth = new Map();
  for (const m of counted) {
    const r = byMonth.get(m.ym) || { ym: m.ym, p: 0, l: 0, e: 0, a: 0 };
    r[m.status.toLowerCase()] += 1;
    byMonth.set(m.ym, r);
  }
  const { totals } = foldMonthlyBuckets([...byMonth.values()].sort((a, b) => a.ym.localeCompare(b.ym)));
  assert.equal(totals.pct, matrixOverall.pct);
  assert.equal(totals.marked, matrixOverall.marked);

  // And had the leaver rule been skipped, as it was, the two would disagree — which is
  // the whole defect, in five marks instead of thirteen thousand.
  const unfiltered = { P: 0, L: 0, E: 0, A: 0 };
  for (const m of marks) unfiltered[m.status] += 1;
  assert.notEqual(summariseCounts(unfiltered.P, unfiltered.L, unfiltered.E, unfiltered.A).pct, matrixOverall.pct);
});
