// Turning Blackboard Learn's API shapes into the one shape the VLE sync writes from.
//
// The Canvas equivalent guards four silent failures. Blackboard's are different and,
// if anything, worse, because two of them look like the obvious reading of the API:
//
//   1. `GradeV2.score` is the instructor's OVERRIDE, documented as "only used for
//      overriding the grade". It is null for every normally-graded student. Reading
//      the field called `score` as the score yields a gradebook of nulls with a
//      handful of outliers — and nothing anywhere says you got it wrong.
//   2. `GradeV2.status` is documented in Blackboard's own spec as having "never
//      contained reliable data. Please stop using it immediately." It looks exactly
//      like the field you want.
//   3. There is NO `late` field anywhere in the API — the only "Late" in the whole
//      specification is an attendance status. Lateness has to be derived, and a
//      column with no due date (the common case) can make nothing late.
//   4. Cross-listed courses hold enrolments AND grades on the PARENT, with
//      `childCourseId` on each membership naming the section the student is really
//      in. Walking children finds nothing; walking both double-counts every student.
//
// Run with: node --test src/vle/blackboardNormalise.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  submissionOf, markOf, studentRefOf, unitIdOf, isAvailable,
  attendanceToStatus, isLate, isChildCourse,
} = require("./blackboardNormalise");

/* -------------------------------------------------------------------------- */
/* Did the student hand anything in?                                           */
/* -------------------------------------------------------------------------- */

const column = { grading: { due: "2026-05-01T23:59:00.000Z" } };

test("a completed attempt is a submission", () => {
  const r = submissionOf({ status: "Completed", attemptDate: "2026-04-28T10:00:00.000Z" }, column);
  assert.equal(r.status, "submitted");
  assert.equal(r.submittedOn, "2026-04-28");
});

test("an attempt waiting to be marked is still a submission", () => {
  // NeedsGrading means the student handed it in and nobody has marked it. From the
  // student's side the work is done, and a marking backlog must not read as a
  // cohort that submitted nothing.
  assert.equal(submissionOf({ status: "NeedsGrading", attemptDate: "2026-04-28T10:00:00.000Z" }, column).status, "submitted");
  assert.equal(submissionOf({ status: "NeedsGradingAgain", attemptDate: "2026-04-28T10:00:00.000Z" }, column).status, "submitted");
});

test("work still in progress has NOT been submitted", () => {
  // Started and saved is not handed in. Counting it would credit a student for a
  // draft they never sent.
  assert.equal(submissionOf({ status: "InProgress" }, column).status, "not_submitted");
  assert.equal(submissionOf({ status: "InProgressAgain" }, column).status, "not_submitted");
});

test("an attempt never started is not submitted", () => {
  assert.equal(submissionOf({ status: "NotAttempted" }, column).status, "not_submitted");
});

test("a status Blackboard adds later is unknown, not a guess in either direction", () => {
  assert.equal(submissionOf({ status: "SomethingNew" }, column).status, "unknown");
  assert.equal(submissionOf({}, column).status, "unknown");
  assert.equal(submissionOf(null, column).status, "unknown");
});

test("the submission receipt is the authoritative date where one exists", () => {
  // attemptReceipt.submissionDate is what Blackboard timestamps the actual hand-in
  // with; attemptDate can move when an attempt is reopened.
  const r = submissionOf({
    status: "Completed",
    attemptDate: "2026-04-30T10:00:00.000Z",
    attemptReceipt: { submissionDate: "2026-04-28T09:00:00.000Z" },
  }, column);
  assert.equal(r.submittedOn, "2026-04-28");
});

test("created stands in when there is no attempt date at all", () => {
  assert.equal(submissionOf({ status: "Completed", created: "2026-04-27T08:00:00.000Z" }, column).submittedOn, "2026-04-27");
});

/* -------------------------------------------------------------------------- */
/* Lateness — derived, because Blackboard has no such field                     */
/* -------------------------------------------------------------------------- */

test("an attempt after the column's due date is late", () => {
  const r = submissionOf({ status: "Completed", attemptDate: "2026-05-02T09:00:00.000Z" }, column);
  assert.equal(r.onTime, false);
});

test("an attempt before the due date is on time", () => {
  assert.equal(submissionOf({ status: "Completed", attemptDate: "2026-04-30T09:00:00.000Z" }, column).onTime, true);
});

test("a column with no due date cannot make anything late", () => {
  // Most Blackboard columns carry no due date. Treating that as "everything is late"
  // would mark an entire gradebook late on the first import.
  const noDue = { grading: {} };
  assert.equal(submissionOf({ status: "Completed", attemptDate: "2026-05-02T09:00:00.000Z" }, noDue).onTime, true);
  assert.equal(submissionOf({ status: "Completed", attemptDate: "2026-05-02T09:00:00.000Z" }, {}).onTime, true);
});

test("work that was never submitted is not also reported late", () => {
  // It is missing, which is counted separately. Reporting it late as well would
  // charge the student twice for the same thing.
  assert.equal(submissionOf({ status: "NotAttempted" }, column).onTime, true);
});

/* -------------------------------------------------------------------------- */
/* The mark — the single most common Blackboard integration bug                */
/* -------------------------------------------------------------------------- */

test("the mark comes from displayGrade, not from the field called score", () => {
  assert.deepEqual(markOf({ score: null, displayGrade: { scaleType: "Score", score: 72, possible: 100 } }), { score: 72, possible: 100 });
});

test("a populated score that is NOT an override is ignored in favour of displayGrade", () => {
  // THE DISCRIMINATING CASE, and the reason the test above is not enough on its own.
  //
  // With score:null both the right implementation and the wrong one return 72, so
  // that test passes either way — it proves nothing. This one only passes if
  // displayGrade genuinely wins: a row carrying a score WITHOUT `overridden` must
  // still be read from displayGrade, because `score` is documented as the override
  // field and anything else appearing in it is not the student's mark.
  //
  // Found by reintroducing the bug and watching every test still pass.
  const r = markOf({ score: 41, displayGrade: { scaleType: "Score", score: 72, possible: 100 } });
  assert.deepEqual(r, { score: 72, possible: 100 },
    "a score present without overridden:true must not be mistaken for the mark");
});

test("an instructor's override wins", () => {
  assert.deepEqual(markOf({ score: 55, overridden: true, displayGrade: { scaleType: "Score", score: 72, possible: 100 } }), { score: 55, possible: 100 });
});

test("ungraded is null, exempt is null, corrupt is null — none of them is zero", () => {
  assert.equal(markOf({ displayGrade: null }), null);
  assert.equal(markOf({ exempt: true, displayGrade: { scaleType: "Score", score: 0, possible: 100 } }), null);
  assert.equal(markOf({ corrupt: true, displayGrade: { scaleType: "Score", score: 41, possible: 100 } }), null);
});

test("a pass/fail or text column carries no number and none is invented", () => {
  assert.equal(markOf({ displayGrade: { scaleType: "CompleteIncomplete", text: "Complete", score: null } }), null);
  assert.equal(markOf({ displayGrade: { scaleType: "Text", text: "Deferred", score: null } }), null);
});

test("a genuine zero survives", () => {
  assert.deepEqual(markOf({ displayGrade: { scaleType: "Score", score: 0, possible: 50 } }), { score: 0, possible: 50 });
});

/* -------------------------------------------------------------------------- */
/* Identity — four id spaces, and only one is the college's                     */
/* -------------------------------------------------------------------------- */

test("studentId is the college's own number and wins", () => {
  assert.equal(studentRefOf({ id: "_2545_1", uuid: "915c", externalId: "jsmith", userName: "jsmith", studentId: "21005513" }), "21005513");
});

test("externalId then userName are the fallbacks", () => {
  assert.equal(studentRefOf({ id: "_2545_1", externalId: "SIS-4471", userName: "jsmith" }), "SIS-4471");
  assert.equal(studentRefOf({ id: "_2545_1", userName: "jsmith" }), "jsmith");
});

test("the Learn primary key is NEVER used as a student number", () => {
  // `_2545_1` is not stable across a course copy or a site migration, and it is not a
  // number the college holds anywhere. Keying on it duplicates every student at the
  // next rollover.
  assert.equal(studentRefOf({ id: "_2545_1" }), null);
  assert.equal(studentRefOf({ id: "_2545_1", uuid: "915c7567d76d444abf1eed56aad3beb5" }), null);
});

test("blank id fields fall through rather than being stored as empty", () => {
  assert.equal(studentRefOf({ studentId: "", externalId: "   ", userName: "jsmith" }), "jsmith");
});

/* -------------------------------------------------------------------------- */
/* Cross-listed courses                                                        */
/* -------------------------------------------------------------------------- */

test("a membership in a cross-listed set belongs to the CHILD course", () => {
  // Enrolments are synchronised onto the parent, but childCourseId names the section
  // the student is really in. Attributing them to the parent merges every section of
  // a module into one register.
  assert.equal(unitIdOf({ courseId: "_10_1", childCourseId: "_11_1" }), "_11_1");
});

test("an ordinary membership belongs to its own course", () => {
  assert.equal(unitIdOf({ courseId: "_10_1", childCourseId: null }), "_10_1");
  assert.equal(unitIdOf({ courseId: "_10_1" }), "_10_1");
});

test("a child course is identified by its parentId, and a parent is not a child", () => {
  assert.equal(isChildCourse({ id: "_11_1", parentId: "_10_1" }), true);
  assert.equal(isChildCourse({ id: "_10_1", hasChildren: true }), false);
});

/* -------------------------------------------------------------------------- */
/* Availability is three states, not a boolean                                 */
/* -------------------------------------------------------------------------- */

test("availability distinguishes Yes, No and SIS-Disabled", () => {
  // "Disabled" means disabled BY THE SIS — a suspended course or a withdrawn student,
  // not merely something hidden. Collapsing it into a boolean loses the distinction
  // between "the college hid this" and "the student record system withdrew it".
  assert.equal(isAvailable({ availability: { available: "Yes" } }), true);
  assert.equal(isAvailable({ availability: { available: "No" } }), false);
  assert.equal(isAvailable({ availability: { available: "Disabled" } }), false);
});

test("a row with no availability block is treated as available", () => {
  // Absence is not a withdrawal. Defaulting the other way would drop every row from a
  // response fetched with a `fields` filter that omitted availability.
  assert.equal(isAvailable({}), true);
  assert.equal(isAvailable(null), true);
});

/* -------------------------------------------------------------------------- */
/* Attendance — Blackboard has it, and it maps onto the register directly        */
/* -------------------------------------------------------------------------- */

test("Blackboard's four attendance states map onto the register's own", () => {
  assert.equal(attendanceToStatus("Present"), "P");
  assert.equal(attendanceToStatus("Absent"), "A");
  assert.equal(attendanceToStatus("Late"), "L");
  assert.equal(attendanceToStatus("Excused"), "E");
});

test("an excused absence is E and never A", () => {
  // attendance.js scores E as a point earned and A as none, so flattening the two
  // costs a student attendance they were entitled to — and can drop them under a
  // warning-letter threshold.
  assert.equal(attendanceToStatus("Excused"), "E");
  assert.notEqual(attendanceToStatus("Excused"), attendanceToStatus("Absent"));
});

test("an unrecognised attendance status produces no mark at all", () => {
  // An unmarked session is excluded from the denominator; a guessed one is counted
  // against the student.
  assert.equal(attendanceToStatus("Tardy"), null);
  assert.equal(attendanceToStatus(null), null);
});

/* -------------------------------------------------------------------------- */
/* isLate, used directly by the sync for columns it has already fetched         */
/* -------------------------------------------------------------------------- */

test("isLate compares an attempt against a due date, and needs both", () => {
  assert.equal(isLate("2026-05-02T09:00:00.000Z", "2026-05-01T23:59:00.000Z"), true);
  assert.equal(isLate("2026-04-30T09:00:00.000Z", "2026-05-01T23:59:00.000Z"), false);
  assert.equal(isLate("2026-05-02T09:00:00.000Z", null), false);
  assert.equal(isLate(null, "2026-05-01T23:59:00.000Z"), false);
});
