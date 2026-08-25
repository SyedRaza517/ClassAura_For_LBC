// Tests for the Blackboard client's pure parts.
//
// No network. These cover the four things a Blackboard integration gets wrong first.
// Three of them fail SILENTLY — they produce a number, just the wrong one:
//
//   1. GradeV2.score is the instructor's OVERRIDE, not the student's mark. It is null
//      for every normally-graded student. Reading it as the mark gives a gradebook
//      full of nulls and a handful of overridden outliers.
//   2. Attendance statuses have to land on our P/L/E/A model, and Blackboard's
//      "Excused" is not our "Absent".
//   3. Lateness does not exist as a field. It has to be derived against the column's
//      due date, and a column with no due date cannot make anything late.
//   4. Cross-listed courses hold their enrolments on the PARENT and their grades on
//      the parent too, so iterating children double-counts or finds nothing.
//
// Run with: node --test src/vle/blackboard.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { apiBase, nextPageUrl, attendanceToStatus, markOf, isLate, isChildCourse } = require("./blackboard");

/* -------------------------------------------------------------------------- */
/* The address                                                                 */
/* -------------------------------------------------------------------------- */

test("a bare host becomes the public API root", () => {
  assert.equal(apiBase("https://bb.college.ac.uk"), "https://bb.college.ac.uk/learn/api/public");
});

test("a trailing slash, or a pasted API path, resolves to the same root", () => {
  assert.equal(apiBase("https://bb.college.ac.uk/"), "https://bb.college.ac.uk/learn/api/public");
  assert.equal(apiBase("https://bb.college.ac.uk/learn/api/public"), "https://bb.college.ac.uk/learn/api/public");
  assert.equal(apiBase("https://bb.college.ac.uk/learn/api/public/v1"), "https://bb.college.ac.uk/learn/api/public");
});

test("a Learn page the administrator had open is trimmed back", () => {
  assert.equal(apiBase("https://bb.college.ac.uk/ultra/course"), "https://bb.college.ac.uk/learn/api/public");
  assert.equal(apiBase("  https://bb.college.ac.uk/webapps/login/  "), "https://bb.college.ac.uk/learn/api/public");
});

/* -------------------------------------------------------------------------- */
/* Pagination — a RELATIVE nextPage                                            */
/* -------------------------------------------------------------------------- */

test("nextPage is relative and must be resolved against the host", () => {
  // Blackboard returns a path, not an absolute URL — unlike Canvas. Passing it
  // straight to fetch() resolves against the wrong base and 404s, or worse, hits
  // whatever the process's default base happens to be.
  const body = { results: [], paging: { nextPage: "/learn/api/public/v1/courses/_1_1/users?offset=100&limit=100" } };
  assert.equal(
    nextPageUrl(body, "https://bb.college.ac.uk"),
    "https://bb.college.ac.uk/learn/api/public/v1/courses/_1_1/users?offset=100&limit=100"
  );
});

test("no paging block, or no nextPage, is the end of the collection", () => {
  assert.equal(nextPageUrl({ results: [] }, "https://bb.college.ac.uk"), null);
  assert.equal(nextPageUrl({ results: [], paging: {} }, "https://bb.college.ac.uk"), null);
  assert.equal(nextPageUrl(null, "https://bb.college.ac.uk"), null);
});

test("an absolute nextPage is honoured as-is, should Blackboard ever send one", () => {
  const body = { paging: { nextPage: "https://bb.college.ac.uk/learn/api/public/v1/x?offset=100" } };
  assert.equal(nextPageUrl(body, "https://bb.college.ac.uk"), "https://bb.college.ac.uk/learn/api/public/v1/x?offset=100");
});

/* -------------------------------------------------------------------------- */
/* Attendance — Blackboard's four states onto our four                         */
/* -------------------------------------------------------------------------- */

test("Blackboard's attendance statuses map onto the register's own", () => {
  assert.equal(attendanceToStatus("Present"), "P");
  assert.equal(attendanceToStatus("Absent"), "A");
  assert.equal(attendanceToStatus("Late"), "L");
  assert.equal(attendanceToStatus("Excused"), "E");
});

test("an excused absence is E, never A", () => {
  // They score differently — E earns a point in attendance.js, A earns none — so
  // flattening Excused into Absent quietly costs every affected student attendance
  // they were entitled to, and can push them under a warning-letter threshold.
  assert.notEqual(attendanceToStatus("Excused"), attendanceToStatus("Absent"));
  assert.equal(attendanceToStatus("Excused"), "E");
});

test("a status Blackboard adds later is ignored rather than guessed at", () => {
  // An unrecognised status must not become a mark. An unmarked session is excluded
  // from the denominator; a wrongly-guessed one is counted against the student.
  assert.equal(attendanceToStatus("Tardy"), null);
  assert.equal(attendanceToStatus(""), null);
  assert.equal(attendanceToStatus(null), null);
  assert.equal(attendanceToStatus(undefined), null);
});

/* -------------------------------------------------------------------------- */
/* The mark — the single most common Blackboard integration bug                */
/* -------------------------------------------------------------------------- */

test("the mark comes from displayGrade, not from the override field", () => {
  // GradeV2.score is documented as "the OVERRIDDEN score ... only used for overriding
  // the grade" — null for every normally graded student. Reading it as the mark gives
  // a gradebook of nulls.
  const grade = { score: null, displayGrade: { scaleType: "Score", score: 72, possible: 100 } };
  assert.deepEqual(markOf(grade), { score: 72, possible: 100 });
});

test("an instructor's override wins over the displayed grade", () => {
  const grade = { score: 55, overridden: true, displayGrade: { scaleType: "Score", score: 72, possible: 100 } };
  assert.deepEqual(markOf(grade), { score: 55, possible: 100 });
});

test("an ungraded student is null, never zero", () => {
  // NOT NULL DEFAULT 0 on a mark column turns every ungraded student into a fail.
  assert.equal(markOf({ score: null, displayGrade: null }), null);
  assert.equal(markOf({}), null);
  assert.equal(markOf(null), null);
});

test("an exempt student is excluded, not scored zero", () => {
  // "the score ... is ignored when computing the course grade". Counting it as 0
  // drags down the average of a student who was excused the work.
  assert.equal(markOf({ exempt: true, displayGrade: { scaleType: "Score", score: 0, possible: 100 } }), null);
});

test("a pass/fail or text column carries no number, and is not invented", () => {
  assert.equal(markOf({ displayGrade: { scaleType: "CompleteIncomplete", text: "Complete", score: null } }), null);
  assert.equal(markOf({ displayGrade: { scaleType: "Text", text: "Deferred", score: null } }), null);
});

test("a corrupt calculated column is not a score", () => {
  assert.equal(markOf({ corrupt: true, displayGrade: { scaleType: "Score", score: 41, possible: 100 } }), null);
});

test("a genuine zero is kept", () => {
  assert.deepEqual(markOf({ displayGrade: { scaleType: "Score", score: 0, possible: 50 } }), { score: 0, possible: 50 });
});

/* -------------------------------------------------------------------------- */
/* Lateness — derived, because Blackboard has no such field                     */
/* -------------------------------------------------------------------------- */

test("an attempt after the due date is late", () => {
  assert.equal(isLate("2026-05-02T09:00:00.000Z", "2026-05-01T23:59:00.000Z"), true);
});

test("an attempt before the due date is not late", () => {
  assert.equal(isLate("2026-04-30T09:00:00.000Z", "2026-05-01T23:59:00.000Z"), false);
});

test("a column with no due date cannot make anything late", () => {
  // Most Blackboard columns carry no due date at all. Treating "no due date" as
  // "everything is late" would mark an entire gradebook late.
  assert.equal(isLate("2026-05-02T09:00:00.000Z", null), false);
  assert.equal(isLate("2026-05-02T09:00:00.000Z", undefined), false);
});

test("an attempt with no date is not late — it is unknown", () => {
  assert.equal(isLate(null, "2026-05-01T23:59:00.000Z"), false);
});

/* -------------------------------------------------------------------------- */
/* Cross-listed courses                                                        */
/* -------------------------------------------------------------------------- */

test("a child of a cross-listed set is identified by its parentId", () => {
  // Content, gradebook columns and grades live only on the PARENT, while the parent's
  // membership list carries childCourseId to say which section a student is really
  // in. Iterating children for grades finds nothing; iterating both double-counts.
  assert.equal(isChildCourse({ id: "_2_1", parentId: "_1_1" }), true);
  assert.equal(isChildCourse({ id: "_1_1", parentId: null, hasChildren: true }), false);
  assert.equal(isChildCourse({ id: "_9_1" }), false);
});
