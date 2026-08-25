// Turning Canvas's API shapes into the one shape the sync writes from.
//
// EVERY FAILURE IN THIS FILE IS SILENT. None of them throws, none of them shows up in
// a log; they each produce a number that looks entirely reasonable and is wrong about
// a real student's record. That is why this layer is pure and tested to death, and why
// the mapping decisions live here rather than inline in a 400-line sync.
//
// The four that a first implementation gets wrong, from the API research:
//
//   1. `workflow_state: "graded"` does NOT mean the student submitted anything. A
//      teacher typing a mark straight into the gradebook produces exactly that, with
//      submitted_at null. Inferring submission from workflow_state marks every
//      on-paper and gradebook-entered assessment as handed in online.
//   2. `excused: true` is not a zero. It is excluded from the average entirely.
//      Coercing it to 0 drags down the average of a student who was excused the work.
//   3. `late` is teacher-overridable via late_policy_status, and is computed against
//      the due date THAT STUDENT had — which, with assignment overrides, is not the
//      assignment's top-level due_at.
//   4. SIS ids are OMITTED, not null, when the token lacks permission — so
//      `row.sis_user_id === null` misfires and every student silently loses their
//      college student number.
//
// Run with: node --test src/vle/canvasNormalise.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { submissionOf, markOf, studentRefOf, isTestStudent } = require("./canvasNormalise");

/* -------------------------------------------------------------------------- */
/* Did the student actually hand anything in?                                  */
/* -------------------------------------------------------------------------- */

test("a submitted assignment is recorded as submitted, with its date", () => {
  const r = submissionOf({ workflow_state: "submitted", submitted_at: "2026-05-01T10:00:00Z" });
  assert.equal(r.status, "submitted");
  assert.equal(r.submittedOn, "2026-05-01");
});

test("a mark typed into the gradebook is NOT a submission", () => {
  // workflow_state "graded" with no submitted_at: the teacher entered a mark for work
  // handed in on paper, or for an exam. Reading state alone would report it as an
  // online submission, and the submission rate would count work that was never
  // uploaded — inflating it for exactly the students who hand nothing in digitally.
  const r = submissionOf({ workflow_state: "graded", submitted_at: null, score: 72 });
  assert.notEqual(r.status, "submitted");
  assert.equal(r.submittedOn, null);
});

test("work that is missing past its due date is recorded as not submitted", () => {
  const r = submissionOf({ workflow_state: "unsubmitted", submitted_at: null, missing: true });
  assert.equal(r.status, "not_submitted");
});

test("work not yet submitted and not yet due is UNKNOWN, never 'not submitted'", () => {
  // The difference decides whether a student is chased. An assignment set for next
  // month is not a student failing to hand work in, and the engine excludes unknown
  // from the denominator precisely so it cannot push anyone toward risk.
  const r = submissionOf({ workflow_state: "unsubmitted", submitted_at: null, missing: false });
  assert.equal(r.status, "unknown");
});

test("an excused student is unknown, not a failure to submit", () => {
  const r = submissionOf({ workflow_state: "unsubmitted", submitted_at: null, missing: true, excused: true });
  assert.equal(r.status, "unknown");
});

test("lateness comes from Canvas, which computed it against that student's own due date", () => {
  // Assignment overrides mean one assignment has many due dates; the top-level due_at
  // is not necessarily the one that applied. Canvas already did this arithmetic per
  // student, so recomputing it here would be both redundant and wrong.
  assert.equal(submissionOf({ workflow_state: "submitted", submitted_at: "2026-05-02T09:00:00Z", late: true }).onTime, false);
  assert.equal(submissionOf({ workflow_state: "submitted", submitted_at: "2026-04-30T09:00:00Z", late: false }).onTime, true);
});

test("a teacher's late-policy override beats Canvas's computed late flag", () => {
  // A tutor marking an obviously-late submission "extended" leaves late:true on the
  // row. Their decision is the one that counts.
  const r = submissionOf({ workflow_state: "submitted", submitted_at: "2026-05-02T09:00:00Z", late: true, late_policy_status: "extended" });
  assert.equal(r.onTime, true);
});

test("a submission with no lateness information is treated as on time, not as late", () => {
  // Absence of evidence is not lateness. Defaulting the other way would mark an
  // entire import late.
  assert.equal(submissionOf({ workflow_state: "submitted", submitted_at: "2026-05-01T10:00:00Z" }).onTime, true);
});

/* -------------------------------------------------------------------------- */
/* The mark                                                                    */
/* -------------------------------------------------------------------------- */

test("a scored submission gives its score", () => {
  assert.deepEqual(markOf({ workflow_state: "graded", score: 72 }, { points_possible: 100 }), { score: 72, possible: 100 });
});

test("a genuine zero is kept", () => {
  assert.deepEqual(markOf({ workflow_state: "graded", score: 0 }, { points_possible: 50 }), { score: 0, possible: 50 });
});

test("an ungraded submission is null, never zero", () => {
  // NOT NULL DEFAULT 0 on a marks column turns every ungraded student into a fail.
  assert.equal(markOf({ workflow_state: "submitted", score: null }, { points_possible: 100 }), null);
  assert.equal(markOf({ workflow_state: "unsubmitted", score: null }, { points_possible: 100 }), null);
});

test("an excused student is excluded from the marks, not scored zero", () => {
  assert.equal(markOf({ workflow_state: "graded", score: null, excused: true }, { points_possible: 100 }), null);
  // Even where Canvas has left a score on the row, excused wins.
  assert.equal(markOf({ workflow_state: "graded", score: 0, excused: true }, { points_possible: 100 }), null);
});

test("an unposted grade is not imported — it is hidden from the student", () => {
  // posted_at null means a manual posting policy is holding the grade back. Mirroring
  // it into our gradebook would show a student a mark their college has not released.
  assert.equal(markOf({ workflow_state: "graded", score: 88, posted_at: null }, { points_possible: 100 }), null);
  assert.deepEqual(markOf({ workflow_state: "graded", score: 88, posted_at: "2026-05-03T12:00:00Z" }, { points_possible: 100 }), { score: 88, possible: 100 });
});

test("an assignment worth no points yields no mark", () => {
  // points_possible 0 or null would make every derived percentage a division by zero.
  assert.equal(markOf({ workflow_state: "graded", score: 5 }, { points_possible: 0 }), null);
  assert.equal(markOf({ workflow_state: "graded", score: 5 }, { points_possible: null }), null);
});

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

test("the college's own student number is preferred over anything Canvas generated", () => {
  assert.equal(studentRefOf({ id: 991, sis_user_id: "21005513", login_id: "jsmith", integration_id: "X" }), "21005513");
});

test("login_id is the fallback when there is no SIS id", () => {
  assert.equal(studentRefOf({ id: 991, login_id: "jsmith" }), "jsmith");
});

test("a missing SIS id is an ABSENT key, not null — both must fall through", () => {
  // The trap: Canvas omits sis_user_id entirely when the token lacks SIS-read
  // permission. Code testing `=== null` sees undefined, treats it as present, and
  // every student silently loses their student number.
  assert.equal(studentRefOf({ id: 991, login_id: "jsmith" }), "jsmith");             // key absent
  assert.equal(studentRefOf({ id: 991, sis_user_id: null, login_id: "jsmith" }), "jsmith"); // key null
  assert.equal(studentRefOf({ id: 991, sis_user_id: "", login_id: "jsmith" }), "jsmith");   // key empty
});

test("a student with no identifiers at all yields null rather than a Canvas id", () => {
  // Falling back to the Canvas numeric id would mint a student number that is not the
  // college's, and it would collide with nothing and match nothing.
  assert.equal(studentRefOf({ id: 991 }), null);
});

/* -------------------------------------------------------------------------- */
/* Things that are not students                                                */
/* -------------------------------------------------------------------------- */

test("Canvas's Test Student is excluded", () => {
  // Every course has one, created by "Student View". It is filtered from the users
  // endpoint but DOES appear in submissions data, so it arrives in a grade import and
  // would be created as a real student with real-looking marks.
  assert.equal(isTestStudent({ type: "StudentViewEnrollment" }), true);
  assert.equal(isTestStudent({ type: "StudentEnrollment" }), false);
});

test("a row Canvas restricted by date is excluded", () => {
  // Canvas returns a stub carrying access_restricted_by_date instead of the real
  // object. Importing it creates a student with no name.
  assert.equal(isTestStudent({ access_restricted_by_date: true }), true);
});
