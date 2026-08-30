// Who handed the work in — and the case where we must refuse to answer.
//
// Longer than the module it tests, on purpose. Every rule below decides what a screen
// tells a module leader about a named student, and the expensive failures here are
// silent: a plausible number that is not true.
const test = require("node:test");
const assert = require("node:assert/strict");
const { submissionsForAssessment } = require("./moodleSubmissions");

const byId = (r) => Object.fromEntries(r.rows.map((x) => [x.studentId, x]));

test("a submission date is a submission", () => {
  const r = submissionsForAssessment([{ studentId: "a", submittedOn: "2026-05-01", hasGrade: false }]);
  assert.equal(r.observed, true);
  assert.equal(byId(r).a.status, "submitted");
  assert.equal(byId(r).a.submittedOn, "2026-05-01");
});

test("work waiting to be marked is still a submission", () => {
  // The population the marking percentage is entirely about, and the one moodle.js
  // used to skip because it had no mark yet.
  const r = submissionsForAssessment([
    { studentId: "a", submittedOn: "2026-05-01", hasGrade: false },
    { studentId: "b", submittedOn: "2026-05-02", hasGrade: true },
  ]);
  assert.equal(byId(r).a.status, "submitted");
  assert.equal(byId(r).b.status, "submitted");
});

test("A MARK IMPLIES A SUBMISSION, even with no date on record", () => {
  // Keeps marked ÷ submitted from exceeding 100%: a marked student excluded from the
  // denominator would make the numerator the larger of the two. Also just true —
  // coursework marked from a paper copy has no Moodle date and was still handed in.
  const r = submissionsForAssessment([{ studentId: "a", submittedOn: null, hasGrade: true }]);
  assert.equal(byId(r).a.status, "submitted");
  // NOT back-filled with a grading date: "handed in on the day it was marked" is a
  // fabrication, and the on-time calculation reads this field.
  assert.equal(byId(r).a.submittedOn, null);
});

test("marked can never exceed submitted, for any mix of students", () => {
  const obs = [
    { studentId: "a", submittedOn: "2026-05-01", hasGrade: true },
    { studentId: "b", submittedOn: null, hasGrade: true },
    { studentId: "c", submittedOn: "2026-05-03", hasGrade: false },
    { studentId: "d", submittedOn: null, hasGrade: false },
  ];
  const r = submissionsForAssessment(obs);
  const submitted = r.rows.filter((x) => x.status === "submitted").length;
  const marked = obs.filter((o) => o.hasGrade).length;
  assert.ok(marked <= submitted, `${marked} marked but only ${submitted} submitted`);
  assert.equal(submitted, 3);
});

test("a student the activity says nothing about did NOT submit — once the field is proven live", () => {
  const r = submissionsForAssessment([
    { studentId: "a", submittedOn: "2026-05-01", hasGrade: false },
    { studentId: "b", submittedOn: null, hasGrade: false },
  ]);
  assert.equal(byId(r).b.status, "not_submitted");
});

test("AN ACTIVITY THAT REPORTS NOTHING ABOUT ANYONE WRITES NO ROWS AT ALL", () => {
  // THE GUARD THIS MODULE EXISTS FOR. A Turnitin activity that never populates
  // gradedatesubmitted and a cohort that genuinely handed in nothing look identical.
  // Writing not_submitted here would report a whole cohort as having submitted nothing
  // — a manufactured crisis out of a field the plugin does not fill.
  const r = submissionsForAssessment([
    { studentId: "a", submittedOn: null, hasGrade: false },
    { studentId: "b", submittedOn: null, hasGrade: false },
    { studentId: "c", submittedOn: null, hasGrade: false },
  ]);
  assert.equal(r.observed, false);
  assert.deepEqual(r.rows, []);
});

test("one observed student is enough to make the whole cohort measurable", () => {
  // The field is demonstrably live for this activity, so absence is now real.
  const r = submissionsForAssessment([
    { studentId: "a", submittedOn: "2026-05-01", hasGrade: false },
    { studentId: "b", submittedOn: null, hasGrade: false },
    { studentId: "c", submittedOn: null, hasGrade: false },
  ]);
  assert.equal(r.observed, true);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.filter((x) => x.status === "submitted").length, 1);
  assert.equal(r.rows.filter((x) => x.status === "not_submitted").length, 2);
});

test("a single marked student also proves the activity is measurable", () => {
  // Evidence can be a mark rather than a date — an exam marked in the gradebook with no
  // online hand-in still proves this activity is being used.
  const r = submissionsForAssessment([
    { studentId: "a", submittedOn: null, hasGrade: true },
    { studentId: "b", submittedOn: null, hasGrade: false },
  ]);
  assert.equal(r.observed, true);
  assert.equal(byId(r).a.status, "submitted");
  assert.equal(byId(r).b.status, "not_submitted");
});

test("an empty or malformed cohort is unobserved, not a crash", () => {
  assert.deepEqual(submissionsForAssessment([]), { observed: false, rows: [] });
  assert.deepEqual(submissionsForAssessment(undefined), { observed: false, rows: [] });
  assert.deepEqual(submissionsForAssessment(null), { observed: false, rows: [] });
  // Entries with no studentId cannot be written against anybody and are dropped before
  // they can prove anything.
  assert.deepEqual(submissionsForAssessment([{ submittedOn: "2026-05-01" }]), { observed: false, rows: [] });
});

test("every student the report covered gets exactly one row", () => {
  const r = submissionsForAssessment([
    { studentId: "a", submittedOn: "2026-05-01", hasGrade: true },
    { studentId: "b", submittedOn: null, hasGrade: false },
    { studentId: "c", submittedOn: null, hasGrade: false },
  ]);
  assert.deepEqual(r.rows.map((x) => x.studentId).sort(), ["a", "b", "c"]);
});
