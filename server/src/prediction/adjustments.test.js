// Tests for the deadline that actually applies to a student.
//
// The failure being fixed is a college punishing somebody for an accommodation it
// granted them. The MIRROR of that failure — counting an extended assessment as handed
// in on time — is quieter and worse, because it inflates the score of a student in real
// difficulty and removes them from the register. Both directions are tested, and the
// second is the one a careless version of this file would omit.
//
// Run with: node --test src/prediction/adjustments.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { effectiveDeadline, buildCoverage, attendanceCovered, STATE } = require("./adjustments");

const TODAY = "2026-03-20";
const work = (id, due) => ({ id, dueDate: due });
const claim = (over = {}) => ({
  status: "approved", coversFrom: "2026-03-01", coversTo: "2026-03-31",
  coversAttendance: false, adjustments: [], ...over,
});

/* -------------------------------------------------------------------------- */
/* An extension moves the deadline                                             */
/* -------------------------------------------------------------------------- */

test("work with an extension whose new deadline has not passed is not yet due", () => {
  // No new logic is needed for this case — the existing "not yet due" rule becomes
  // correct the moment it is given the right date.
  const cov = buildCoverage([claim({
    adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-03-25" }],
  })]);
  const r = effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY);

  assert.equal(r.state, STATE.DEFERRED);
  assert.equal(r.due, "2026-03-25");
  assert.ok(r.due > TODAY, "the revised deadline is in the future, so nothing is missing");
});

test("an extension that has itself run out makes the work due again", () => {
  const cov = buildCoverage([claim({
    adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-03-15" }],
  })]);
  const r = effectiveDeadline(work("a1", "2026-03-01"), cov, TODAY);

  assert.equal(r.state, STATE.DEFERRED);
  assert.ok(r.due < TODAY, "an extension is a new deadline, not an exemption");
});

test("an extension that moves a deadline EARLIER is refused, not honoured", () => {
  // Honouring it would turn this table into a way of manufacturing lateness. The later
  // date wins, so a mistyped row can only ever be harmless.
  const cov = buildCoverage([claim({
    adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-02-01" }],
  })]);
  const r = effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY);

  assert.equal(r.due, "2026-03-10");
});

/* -------------------------------------------------------------------------- */
/* Which claims count                                                          */
/* -------------------------------------------------------------------------- */

test("a REJECTED claim contributes nothing and the work is measured as it always was", () => {
  // The case the design must not soften. A rejection is a decision the college took,
  // with a decider and a date on the row, and the score reflecting it is the score
  // being consistent with the college's own act.
  const cov = buildCoverage([claim({
    status: "rejected",
    adjustments: [{ assessmentId: "a1", adjustmentType: "exclusion", revisedDueDate: null }],
  })]);
  const r = effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY);

  assert.equal(r.state, STATE.MEASURED);
  assert.equal(r.due, "2026-03-10");
});

test("a WITHDRAWN claim contributes nothing either", () => {
  const cov = buildCoverage([claim({ status: "withdrawn" })]);
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).state, STATE.MEASURED);
});

test("an UNDECIDED claim excludes the work — neither missing nor submitted", () => {
  // The argued case. With a claim pending, "did this student fail to hand work in" is
  // not a question about the student: the answer depends on a decision the institution
  // has not taken. That is the definition of not measurable, and the answer to
  // not-measurable here is to leave both sides.
  //
  // Treating it as rejected would punish the student for the length of the college's
  // own decision queue — the OIA scenario exactly inverted.
  const cov = buildCoverage([claim({ status: "open" })]);
  const r = effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY);

  assert.equal(r.state, STATE.EXCLUDED);
  assert.equal(r.due, null);
});

/* -------------------------------------------------------------------------- */
/* Blanket windows                                                             */
/* -------------------------------------------------------------------------- */

test("an approved claim with no per-assessment rows covers the work due inside it", () => {
  // The ordinary state the moment a claim is approved, before anybody has set new
  // dates — and precisely when the student most needs the suppression. It cannot be
  // made to wait on administrative work that has not happened.
  const cov = buildCoverage([claim({ coversFrom: "2026-03-01", coversTo: "2026-03-31" })]);

  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).state, STATE.EXCLUDED);
  // And nothing outside the window.
  assert.equal(effectiveDeadline(work("a2", "2026-02-10"), cov, TODAY).state, STATE.MEASURED);
  assert.equal(effectiveDeadline(work("a3", "2026-04-10"), cov, TODAY).state, STATE.MEASURED);
});

test("work with no deadline is never swept up by a blanket window", () => {
  // An assessment with no due date cannot be placed on a calendar, so it cannot be
  // inside one — the same rule the submission counts already apply.
  const cov = buildCoverage([claim()]);
  assert.equal(effectiveDeadline(work("a1", null), cov, TODAY).state, STATE.MEASURED);
});

/* -------------------------------------------------------------------------- */
/* Most generous wins                                                          */
/* -------------------------------------------------------------------------- */

test("an exclusion beats an overlapping extension", () => {
  // Failing toward the student is the only safe direction for a rule whose failure mode
  // is punishing somebody for an accommodation.
  const cov = buildCoverage([
    claim({ adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-03-25" }] }),
    claim({ adjustments: [{ assessmentId: "a1", adjustmentType: "exclusion", revisedDueDate: null }] }),
  ]);
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).state, STATE.EXCLUDED);
});

test("the later of two extensions wins", () => {
  const cov = buildCoverage([
    claim({ adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-03-22" }] }),
    claim({ adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-04-05" }] }),
  ]);
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).due, "2026-04-05");
});

test("a rejected claim cannot cancel an approved one", () => {
  const cov = buildCoverage([
    claim({ adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-03-25" }] }),
    claim({ status: "rejected", adjustments: [{ assessmentId: "a1", adjustmentType: "extension", revisedDueDate: "2026-03-11" }] }),
  ]);
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).due, "2026-03-25");
});

/* -------------------------------------------------------------------------- */
/* Nothing at all                                                              */
/* -------------------------------------------------------------------------- */

test("a student with no claims is measured exactly as before", () => {
  // The overwhelmingly common case, and it must be untouched: this feature adds a
  // suppression, it does not change the default.
  const cov = buildCoverage([]);
  const r = effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY);

  assert.equal(r.state, STATE.MEASURED);
  assert.equal(r.due, "2026-03-10");
});

/* -------------------------------------------------------------------------- */
/* Attendance is opt-in, and never reaches the pastoral signals                */
/* -------------------------------------------------------------------------- */

test("an ordinary claim does NOT excuse absence", () => {
  // Suppressing attendance removes sessions from both sides of the percentage, which is
  // a much larger act than suppressing a submission count. An extension on a deadline
  // must not silently also excuse three weeks of absence.
  const claims = [claim({ coversAttendance: false })];
  assert.equal(attendanceCovered({ date: "2026-03-10" }, claims), false);
});

test("a claim that opted in covers marks inside its window only", () => {
  const claims = [claim({ coversAttendance: true, coversFrom: "2026-03-01", coversTo: "2026-03-15" })];
  assert.equal(attendanceCovered({ date: "2026-03-10" }, claims), true);
  assert.equal(attendanceCovered({ date: "2026-03-20" }, claims), false);
});

test("a rejected claim excuses no absence however broad its window", () => {
  const claims = [claim({ status: "rejected", coversAttendance: true })];
  assert.equal(attendanceCovered({ date: "2026-03-10" }, claims), false);
});

/* -------------------------------------------------------------------------- */
/* The policy switch                                                           */
/* -------------------------------------------------------------------------- */

test("a college whose regulations say pending has no effect gets the narrower set", () => {
  // pendingClaimSuppresses:false. The undecided claim stops suppressing and the work is
  // measured as it always was -- which is a defensible reading of a set of academic
  // regulations, and not ours to overrule.
  const cov = buildCoverage([claim({ status: "open" })], { pendingSuppresses: false });
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).state, STATE.MEASURED);
});

test("the switch narrows what suppresses and never widens it", () => {
  // The failure to guard against is the flag accidentally letting a REJECTED claim
  // through. Turning pending off must only ever remove a status from the live set.
  const cov = buildCoverage([claim({ status: "rejected" })], { pendingSuppresses: false });
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), cov, TODAY).state, STATE.MEASURED);
  const approved = buildCoverage([claim({ status: "approved" })], { pendingSuppresses: false });
  assert.equal(effectiveDeadline(work("a1", "2026-03-10"), approved, TODAY).state, STATE.EXCLUDED);
});

test("attendance cover honours the same switch", () => {
  const claims = [claim({ status: "open", coversAttendance: true })];
  assert.equal(attendanceCovered({ date: "2026-03-10" }, claims), true);
  assert.equal(attendanceCovered({ date: "2026-03-10" }, claims, { pendingSuppresses: false }), false);
});
