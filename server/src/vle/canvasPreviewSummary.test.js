const test = require("node:test");
const assert = require("node:assert/strict");
const { summarisePreview, verdictText } = require("./canvasPreviewSummary");

const course = (over = {}) => ({ id: 1, name: "C", students: 10, assignments: 2, submissions: [], ...over });

test("counts fold across every sampled course", () => {
  const s = summarisePreview([
    course({ students: 10, assignments: 2 }),
    course({ students: 5, assignments: 3 }),
  ]);
  assert.equal(s.coursesSampled, 2);
  assert.equal(s.students, 15);
  assert.equal(s.assignments, 5);
});

test("A REAL HAND-IN DATE IS THE VERDICT, and it is what the preview exists to find", () => {
  const s = summarisePreview([course({
    submissions: [
      { studentId: "a", submittedOn: "2026-05-01", status: "submitted" },
      { studentId: "b", submittedOn: null, status: "not_submitted" },
    ],
  })]);
  assert.equal(s.submissionDatesAvailable, true);
  assert.equal(s.withDates, 1);
  assert.match(verdictText(s), /real hand-in dates/);
});

test("submissions with NO dates anywhere is the finding that stops an importer being built", () => {
  // The Turnitin case, arriving through Canvas. Rows exist, statuses exist, but not one
  // carries a date — so an importer would again derive "submitted" from who was marked.
  const s = summarisePreview([course({
    submissions: [
      { studentId: "a", submittedOn: null, status: "submitted" },
      { studentId: "b", submittedOn: null, status: "submitted" },
    ],
  })]);
  assert.equal(s.submissionDatesAvailable, false);
  assert.equal(s.submitted, 2);
  assert.equal(s.withDates, 0);
  assert.match(verdictText(s), /NOT ONE carried a hand-in date/);
});

test("a date is counted independently of the status", () => {
  // A teacher entering a mark for offline work gives status submitted and no date. It
  // must not masquerade as a measured hand-in, or the verdict is decided by the wrong
  // evidence.
  const s = summarisePreview([course({
    submissions: [{ studentId: "a", submittedOn: null, status: "submitted" }],
  })]);
  assert.equal(s.submitted, 1);
  assert.equal(s.withDates, 0);
  assert.equal(s.submissionDatesAvailable, false);
});

test("datedPercent is NULL when nothing was examined, not 0", () => {
  // "No submissions were examined" and "none of them had dates" are different findings.
  // A 0% here would read as the second when it was the first.
  const s = summarisePreview([course({ submissions: [] })]);
  assert.equal(s.datedPercent, null);
  assert.equal(s.submissionRows, 0);
  assert.match(verdictText(s), /no submissions at all/);
});

test("no visible courses says the token is the problem, not the data", () => {
  const s = summarisePreview([]);
  assert.equal(s.coursesSampled, 0);
  assert.match(verdictText(s), /account administrator/);
});

test("malformed input summarises to zeroes rather than throwing", () => {
  // A preview must never 500 on an oddly-shaped Canvas response — the whole point is to
  // report what was found, including "something unexpected".
  assert.equal(summarisePreview(undefined).coursesSampled, 0);
  assert.equal(summarisePreview([null]).coursesSampled, 1);
  assert.equal(summarisePreview([{ submissions: "nope" }]).submissionRows, 0);
  assert.equal(summarisePreview([course({ students: "x", assignments: null })]).students, 0);
});

test("unknown submissions are counted separately from submitted", () => {
  // canvasNormalise returns "unknown" for excused work and for work not yet due. Neither
  // is a hand-in nor a failure to hand in, and folding them into either would misstate
  // the account.
  const s = summarisePreview([course({
    submissions: [
      { studentId: "a", submittedOn: null, status: "unknown" },
      { studentId: "b", submittedOn: "2026-05-01", status: "submitted" },
    ],
  })]);
  assert.equal(s.unknown, 1);
  assert.equal(s.submitted, 1);
});
