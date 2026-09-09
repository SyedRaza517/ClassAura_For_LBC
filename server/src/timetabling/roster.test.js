// Run with: node --test src/timetabling/roster.test.js   (from server/)
const { test } = require("node:test");
const assert = require("node:assert");
const { deriveRoster, deriveUnitRoster } = require("./roster");

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

// --------------------------------------------------- the whole-unit count ---

test("a unit with NO enrolments counts the whole group scheduled against it", () => {
  // The reported bug exactly: BUS701 printed "0 students · 20 sessions" beside a
  // register that correctly listed the group.
  const r = deriveUnitRoster({
    enrolledStudentIds: [],
    scheduledStudentIds: ["a", "b", "c"],
    hasScheduledGroup: true,
  });
  assert.deepEqual(r.studentIds, ["a", "b", "c"]);
  assert.equal(r.rule, "cohort-only");
});

test("a unit WITH enrolments still counts the intersection, not the enrolment", () => {
  // "d" is enrolled but in no scheduled group, so no register of this unit lists them.
  const r = deriveUnitRoster({
    enrolledStudentIds: ["b", "c", "d"],
    scheduledStudentIds: ["a", "b", "c"],
    hasScheduledGroup: true,
  });
  assert.deepEqual(r.studentIds, ["b", "c"]);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("somebody both enrolled and in a scheduled group is counted ONCE", () => {
  const r = deriveUnitRoster({
    enrolledStudentIds: ["a", "a", "b"],
    scheduledStudentIds: ["a", "b", "b"],
    hasScheduledGroup: true,
  });
  assert.equal(r.studentIds.length, 2);
});

test("two groups on one unit are unioned, not summed twice", () => {
  // A merged class keeps two registers; the module is still one module's worth of
  // people, and a student appearing on both would be double-counted by a sum.
  const r = deriveUnitRoster({
    enrolledStudentIds: ["a", "b", "c"],
    scheduledStudentIds: ["a", "b", "b", "c"],
    hasScheduledGroup: true,
  });
  assert.deepEqual(r.studentIds, ["a", "b", "c"]);
});

test("no enrolments AND no group is NULL, not zero", () => {
  // Nothing to measure: the enrolment branch has nothing to intersect and the cohort
  // branch has no cohort. Reporting 0 would say the same thing an empty module says.
  const r = deriveUnitRoster({ enrolledStudentIds: [], scheduledStudentIds: [], hasScheduledGroup: false });
  assert.equal(r.studentIds, null);
  assert.equal(r.rule, "unmeasurable");
});

test("enrolments but no group at all falls back to the enrolment", () => {
  // A Moodle-synced module nobody has timetabled yet. There is no group to intersect
  // with, and reporting 0 here would be the original bug in the other direction.
  const r = deriveUnitRoster({ enrolledStudentIds: ["a", "b"], scheduledStudentIds: [], hasScheduledGroup: false });
  assert.deepEqual(r.studentIds, ["a", "b"]);
  assert.equal(r.rule, "enrolment-only");
});

test("an UNGROUPED register widens the count back to the whole enrolment", () => {
  // Generator- and Moodle-created registers carry no cohortId, and rosterForSession
  // gives those the module's whole enrolment. Intersecting would under-count the very
  // students one of this unit's own registers lists.
  const r = deriveUnitRoster({
    enrolledStudentIds: ["a", "b", "d"],
    scheduledStudentIds: ["a", "b", "c"],
    hasScheduledGroup: true,
    hasUngroupedRegister: true,
  });
  assert.deepEqual(r.studentIds, ["a", "b", "d"]);
  assert.equal(r.rule, "enrolment-only");
});

test("a group that is scheduled but EMPTY is zero, not null", () => {
  // An answer, not missing data: a group exists and nobody is in it yet.
  const r = deriveUnitRoster({ enrolledStudentIds: [], scheduledStudentIds: [], hasScheduledGroup: true });
  assert.deepEqual(r.studentIds, []);
  assert.equal(r.rule, "cohort-only");
});

test("a unit that HAS enrolments, none of them in the scheduled group, is zero", () => {
  // The mirror of deriveRoster's third test. Enrolment data exists and says nobody in
  // the timetabled group takes this module; widening to the group would put students on
  // a count for a module they are not taking.
  const r = deriveUnitRoster({ enrolledStudentIds: ["z"], scheduledStudentIds: ["a"], hasScheduledGroup: true });
  assert.deepEqual(r.studentIds, []);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("missing arguments do not throw", () => {
  const r = deriveUnitRoster({});
  assert.equal(r.studentIds, null);
});
