// Run with: node --test src/timetabling/roster.test.js   (from server/)
const { test } = require("node:test");
const assert = require("node:assert");
const { deriveRoster } = require("./roster");

test("the roster is the intersection of cohort and enrolment", () => {
  const r = deriveRoster({
    cohortStudentIds: ["a", "b", "c"],
    enrolledStudentIds: ["b", "c", "d"],
    unitHasEnrolments: true,
  });
  assert.deepEqual(r.studentIds, ["b", "c"]);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("a unit with NO enrolment data at all falls back to the whole cohort", () => {
  // Moodle has not synced, or the module was added by hand. An empty register here
  // would look exactly like a class nobody joined.
  const r = deriveRoster({
    cohortStudentIds: ["a", "b"],
    enrolledStudentIds: [],
    unitHasEnrolments: false,
  });
  assert.deepEqual(r.studentIds, ["a", "b"]);
  assert.equal(r.rule, "cohort-only");
});

test("a unit that HAS enrolments but none in this cohort yields an EMPTY roster", () => {
  // The case the fallback must not swallow: enrolment data exists and says nobody in
  // this group takes this module. That is an answer, not missing data, and widening
  // to the whole cohort here would put students on a register for a module they
  // are not taking.
  const r = deriveRoster({
    cohortStudentIds: ["a"],
    enrolledStudentIds: ["z"],
    unitHasEnrolments: true,
  });
  assert.deepEqual(r.studentIds, []);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("order follows the cohort and duplicates collapse", () => {
  const r = deriveRoster({
    cohortStudentIds: ["c", "a", "a"],
    enrolledStudentIds: ["a", "c"],
    unitHasEnrolments: true,
  });
  assert.deepEqual(r.studentIds, ["c", "a"]);
});

test("an empty cohort is empty under both rules", () => {
  assert.deepEqual(deriveRoster({ cohortStudentIds: [], enrolledStudentIds: ["a"], unitHasEnrolments: true }).studentIds, []);
  assert.deepEqual(deriveRoster({ cohortStudentIds: [], enrolledStudentIds: [], unitHasEnrolments: false }).studentIds, []);
});

test("the rule is reported, because the two empties mean opposite things", () => {
  // An empty register under cohort-and-enrolment means "nobody in this group takes
  // this module". An empty one under cohort-only means "we do not know who does".
  // The screen has to be able to tell the reader which.
  const a = deriveRoster({ cohortStudentIds: [], enrolledStudentIds: [], unitHasEnrolments: true });
  const b = deriveRoster({ cohortStudentIds: [], enrolledStudentIds: [], unitHasEnrolments: false });
  assert.notEqual(a.rule, b.rule);
});

test("missing arguments do not throw", () => {
  // Called from a route with a half-built object, this must degrade rather than 500.
  const r = deriveRoster({});
  assert.deepEqual(r.studentIds, []);
  assert.equal(r.rule, "cohort-only");
});
