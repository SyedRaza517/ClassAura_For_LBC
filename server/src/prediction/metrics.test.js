// Tests for the parts of the gather that are pure: how attendance is counted under
// each of the two models a college may choose, how a score's scope is resolved, and
// the date arithmetic underneath both.
//
// No database. The Prisma client is required by metrics.js but never connects until
// a query runs, and nothing here runs one.
//
// Run with: node --test src/prediction/metrics.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { summariseAttendance, resolveScope, shiftDays, daysBetween } = require("./metrics");
const { DEFAULTS } = require("./settings");

const marks = (...statuses) => statuses.map((status) => ({ status }));

/* -------------------------------------------------------------------------- */
/* Attendance models                                                           */
/* -------------------------------------------------------------------------- */

test("the points model matches the Attendance % tab: P=2, L=1, E=1, A=0", () => {
  // The engine must produce the same number the attendance screen already shows, or
  // staff will not trust either of them.
  const r = summariseAttendance(marks("P", "P", "L", "A"), "points");
  assert.equal(r.marked, 4);
  assert.equal(r.pct, 62.5, "5 points earned of 8 available");
});

test("the binary model counts a late or excused student as absent", () => {
  // "Present or not." A college running a Student-visa cohort reports on physical
  // attendance, and a student who arrived an hour late was not there for the hour.
  const r = summariseAttendance(marks("P", "P", "L", "A"), "binary");
  assert.equal(r.marked, 4);
  assert.equal(r.pct, 50, "2 present of 4 marked");
});

test("the two models genuinely disagree, so choosing one has to mean something", () => {
  const list = marks("P", "L", "E", "A");
  assert.notEqual(
    summariseAttendance(list, "points").pct,
    summariseAttendance(list, "binary").pct,
    "if these agree, the attendance-mode setting is doing nothing and should not be offered"
  );
});

test("an unmarked register is not an absence under either model", () => {
  // A register nobody has taken must not drag a student's figure down — the same
  // rule attendance.js has carried since the HND screens were built.
  for (const mode of ["points", "binary"]) {
    const r = summariseAttendance([{ status: null }, { status: "" }, { status: "X" }], mode);
    assert.equal(r.marked, 0, mode);
    assert.equal(r.pct, null, `${mode}: no marked sessions must be null, never 0`);
  }
});

test("a student with no sessions at all has no percentage, not a zero", () => {
  for (const mode of ["points", "binary"]) {
    assert.equal(summariseAttendance([], mode).pct, null, mode);
  }
});

test("an unrecognised mode falls back to points rather than scoring nobody", () => {
  assert.equal(summariseAttendance(marks("P", "A"), "sideways").pct, summariseAttendance(marks("P", "A"), "points").pct);
});

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

const terms = [
  { id: "t1", year: 1, index: 1, name: "Year 1 · Term 1", start: "2000-01-01", end: "2000-03-31" },
  { id: "t2", year: 1, index: 2, name: "Year 1 · Term 2", start: "2000-04-01", end: "2000-06-30" },
  { id: "t3", year: 2, index: 1, name: "Year 2 · Term 1", start: "2099-01-01", end: "2099-12-31" },
];
const student = { cohort: { id: "c1", terms } };

test("a student whose cohort has no calendar is scored on their whole record", () => {
  const scope = resolveScope({ cohort: null }, DEFAULTS);
  assert.equal(scope.from, null);
  assert.equal(scope.to, null);
});

test("'all' ignores the term calendar entirely", () => {
  const scope = resolveScope(student, { ...DEFAULTS, scope: "all" });
  assert.equal(scope.from, null);
  assert.equal(scope.to, null);
});

test("a cohort with no term running today falls back to the whole record, not an empty window", () => {
  // An empty window would score every student in the cohort as unmeasurable and
  // silently empty the risk register between terms — the failure nobody notices.
  const past = [{ id: "t0", year: 1, index: 1, name: "Long ago", start: "2000-01-01", end: "2000-03-31" }];
  const scope = resolveScope({ cohort: { id: "c", terms: past } }, DEFAULTS);
  assert.equal(scope.from, null);
  assert.equal(scope.to, null);
  assert.match(scope.label, /no term/i, scope.label);
});

test("'current-year' spans every term of that year, not just the one running", () => {
  const scope = resolveScope({ cohort: { id: "c", terms: [terms[0], terms[1]] } }, { ...DEFAULTS, scope: "current-year" });
  assert.equal(scope.from, "2000-01-01", "the earliest start of the year");
  assert.equal(scope.to, "2000-06-30", "the latest end of the year");
});

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

test("shifting days crosses a month boundary correctly", () => {
  assert.equal(shiftDays("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDays("2026-01-31", 1), "2026-02-01");
});

test("shifting days does not drift across a British Summer Time boundary", () => {
  // The clocks go forward on 29 March 2026. Local-Date arithmetic loses an hour here
  // and can land a 28-day window a day out, which would silently move every student's
  // recent-attendance figure.
  assert.equal(shiftDays("2026-04-05", -28), "2026-03-08");
  assert.equal(daysBetween("2026-03-08", "2026-04-05"), 28);
});

test("days between two dates is a plain count, and is zero for the same day", () => {
  assert.equal(daysBetween("2026-08-25", "2026-08-25"), 0);
  assert.equal(daysBetween("2026-08-01", "2026-08-25"), 24);
});
