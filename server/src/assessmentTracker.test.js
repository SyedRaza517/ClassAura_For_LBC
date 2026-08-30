// The assessment tracker's derivations, which are the part of it that gets argued with.
//
// Every assertion below is about a DENOMINATOR, and every one of them is a decision
// somebody could reasonably make the other way — which is exactly why they are pinned
// here rather than left inline in the route.
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("./assessmentTracker");

test("submission rate is null, not zero, when the submission count is unknown", () => {
  // THE MOST IMPORTANT LINE IN THE FEATURE. AssessmentSubmission is empty until the
  // LMS sync exists, so a 0 here would put every module in the college on a watchlist
  // for something nobody has measured.
  assert.equal(t.submissionRate(null, 50), null);
});

test("submission rate is a real zero when submissions ARE recorded and none arrived", () => {
  // The earned zero must stay reachable, or the guard above has quietly disabled the
  // figure rather than protecting it.
  assert.equal(t.submissionRate(0, 50), 0);
});

test("submission rate is null when nobody is enrolled", () => {
  // Dividing by an empty cohort is not 0% and not 100%; it is unmeasurable, and
  // either answer would be a statement about students who do not exist.
  assert.equal(t.submissionRate(0, 0), null);
});

test("submission rate is a percentage to one decimal place", () => {
  assert.equal(t.submissionRate(21, 50), 42);
  assert.equal(t.submissionRate(1, 3), 33.3);
});

test("marking rate divides by SUBMITTED, not by enrolled", () => {
  // 20 of 50 students submitted and all 20 are marked. That is a finished marking job,
  // not 40% of one — you cannot mark a script nobody handed in.
  assert.equal(t.markingRate(20, 20), 100);
});

test("marking rate is null when the submission count is unknown", () => {
  assert.equal(t.markingRate(12, null), null);
});

test("coverage is marked over enrolled and is measurable without any submission data", () => {
  assert.equal(t.coverageRate(20, 50), 40);
  assert.equal(t.coverageRate(0, 50), 0);
});

test("coverage is never substituted for the marking rate", () => {
  // Both figures for the same assessment, and they must disagree. A single column that
  // silently switches denominator per row is how a figure stops being trustworthy.
  assert.equal(t.markingRate(20, 20), 100);
  assert.equal(t.coverageRate(20, 50), 40);
});

test("a deadline that is today is due, not overdue", () => {
  assert.equal(t.deadlineState("2026-08-30", "2026-08-30"), "due");
  assert.equal(t.deadlineState("2026-08-29", "2026-08-30"), "overdue");
  assert.equal(t.deadlineState("2026-08-31", "2026-08-30"), "upcoming");
});

test("no deadline set is 'none', never 'overdue'", () => {
  // A college that does not set internal marking deadlines is unmeasured, not late.
  assert.equal(t.deadlineState(null, "2026-08-30"), "none");
  assert.equal(t.deadlineState("", "2026-08-30"), "none");
});

test("marking is not overdue when everything submitted has been marked", () => {
  // Past the marking deadline, but there is nothing left to mark. Reporting this as
  // overdue fills the screen with rows nobody can act on, which is the same as an
  // empty screen.
  assert.equal(t.markingState("2026-08-20", 20, 20, "2026-08-30"), "complete");
});

test("marking IS overdue when scripts remain unmarked past the deadline", () => {
  assert.equal(t.markingState("2026-08-20", 12, 20, "2026-08-30"), "overdue");
});

test("marking state is 'unknown' while the submission count is unknown", () => {
  // With no denominator there is no way to know whether anything is outstanding, and
  // guessing "overdue" would accuse a named module leader of a marking backlog on the
  // strength of an integration that has not been built yet.
  assert.equal(t.markingState("2026-08-20", 12, null, "2026-08-30"), "unknown");
});
