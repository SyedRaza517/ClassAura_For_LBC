// Run with: node --test src/timetabling/roster.test.js   (from server/)
const { test } = require("node:test");
const assert = require("node:assert");
const { deriveRoster, deriveUnitRoster, enrolmentIsAuthoritativeFor } = require("./roster");

test("the roster is the intersection of cohort and enrolment", () => {
  // enrolmentIsAuthoritative is what this test always MEANT — a module whose enrolment
  // list was enumerated by the Moodle sync rather than typed in one student at a time.
  // It used to be implied by unitHasEnrolments alone, and that implication is the cliff
  // roster.js now documents at length.
  const r = deriveRoster({
    cohortStudentIds: ["a", "b", "c"],
    enrolledStudentIds: ["b", "c", "d"],
    unitHasEnrolments: true,
    enrolmentIsAuthoritative: true,
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
  // Only on an ENUMERATED list. On a list assembled one student at a time this same
  // shape is the cliff — see "one enrolment for somebody OUTSIDE the group" below,
  // which is the identical call with twenty-five students and the flag off.
  const r = deriveRoster({
    cohortStudentIds: ["a"],
    enrolledStudentIds: ["z"],
    unitHasEnrolments: true,
    enrolmentIsAuthoritative: true,
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
    enrolmentIsAuthoritative: true,
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
    enrolmentIsAuthoritative: true,
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
  const r = deriveUnitRoster({ enrolledStudentIds: ["z"], scheduledStudentIds: ["a"], hasScheduledGroup: true, enrolmentIsAuthoritative: true });
  assert.deepEqual(r.studentIds, []);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("missing arguments do not throw", () => {
  const r = deriveUnitRoster({});
  assert.equal(r.studentIds, null);
});

// ------------------------------------------------- the cliff at one enrolment ---
//
// THE DEFECT THESE TESTS DESCRIBE. `unitHasEnrolments` is a count crossing zero, and a
// count crossing zero is a cliff rather than a slope: the module that had none and got
// one did not learn anything about the other twenty-four students, but the register
// behaved as though it had.

test("one enrolment does not evict a cohort from its own register", () => {
  const cohort = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const before = deriveRoster({ cohortStudentIds: cohort, enrolledStudentIds: [], unitHasEnrolments: false });
  assert.equal(before.studentIds.length, 25);

  // A single Enrolment row now exists on the module — an administrator ticked this
  // module on ONE student's record, or an attendance import enrolled the handful of
  // students it happened to be marking. Nothing was said about the other twenty-four.
  const after = deriveRoster({
    cohortStudentIds: cohort,
    enrolledStudentIds: ["s0"],
    unitHasEnrolments: true,
    enrolmentIsAuthoritative: false,
  });
  assert.equal(after.studentIds.length, 25,
    `one enrolment cut the register from ${before.studentIds.length} to ${after.studentIds.length}`);
});

test("one enrolment for somebody OUTSIDE the group does not empty the register either", () => {
  // The same cliff in its other direction: the single row names a student who is not in
  // this group at all, so the intersection is empty and a lecturer standing in front of
  // twenty-five people is handed a sheet with nobody on it.
  const cohort = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const r = deriveRoster({
    cohortStudentIds: cohort,
    enrolledStudentIds: ["someone-else"],
    unitHasEnrolments: true,
    enrolmentIsAuthoritative: false,
  });
  assert.equal(r.studentIds.length, 25);
});

test("an enumerated enrolment list still narrows the cohort", () => {
  // The half that must NOT change. Where the enrolment list was written by something
  // that enumerates a whole class, its silences are evidence, and un-enrolling one
  // student still takes them off the register.
  const r = deriveRoster({
    cohortStudentIds: ["a", "b", "c"],
    enrolledStudentIds: ["a", "b"],
    unitHasEnrolments: true,
    enrolmentIsAuthoritative: true,
  });
  assert.deepEqual(r.studentIds, ["a", "b"]);
  assert.equal(r.rule, "cohort-and-enrolment");
});

test("a MERGED CLASS still keeps its two groups apart", () => {
  // Load-bearing, and the reason UNION was rejected: every student on the module is
  // enrolled on it regardless of group, so a roster that could grow beyond the cohort
  // would put group B on group A's register — and mark-remaining-absent would then
  // write an A against twenty students who were in another room.
  const groupA = ["a1", "a2", "a3"];
  const groupB = ["b1", "b2", "b3"];
  for (const authoritative of [true, false]) {
    const r = deriveRoster({
      cohortStudentIds: groupA,
      enrolledStudentIds: [...groupA, ...groupB],
      unitHasEnrolments: true,
      enrolmentIsAuthoritative: authoritative,
    });
    assert.deepEqual(r.studentIds, groupA, `merged class leaked with enrolmentIsAuthoritative=${authoritative}`);
  }
});

test("the unit CARD does not collapse when one enrolment appears either", () => {
  // The card and the register must not disagree; that is a bug this file has closed
  // once already. A unit whose enrolment list was assembled one student at a time
  // concerns everybody its registers list, which is the whole scheduled group.
  const scheduled = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const before = deriveUnitRoster({ enrolledStudentIds: [], scheduledStudentIds: scheduled, hasScheduledGroup: true });
  assert.equal(before.studentIds.length, 25);

  const after = deriveUnitRoster({
    enrolledStudentIds: ["s0"],
    scheduledStudentIds: scheduled,
    hasScheduledGroup: true,
    enrolmentIsAuthoritative: false,
  });
  assert.equal(after.studentIds.length, 25,
    `the card fell from ${before.studentIds.length} to ${after.studentIds.length} on one enrolment`);
});

test("a partially-enrolled unit reports its OWN rule, not \"no enrolment data\"", () => {
  // Three rules now, not two, and the third is not cosmetic: registers.js prints a
  // sentence into `audience` from it, and "no enrolment data for this module" would be
  // a false statement about a module that has some.
  const none = deriveRoster({ cohortStudentIds: ["a"], enrolledStudentIds: [], unitHasEnrolments: false });
  const partial = deriveRoster({ cohortStudentIds: ["a"], enrolledStudentIds: ["a"], unitHasEnrolments: true });
  assert.equal(none.rule, "cohort-only");
  assert.equal(partial.rule, "cohort-over-partial-enrolment");
  assert.notEqual(none.rule, partial.rule);
});

test("the CARD and the REGISTER agree on a partially-enrolled unit", () => {
  // The disagreement this file already closed once, re-asked at the new branch. The
  // register lists the whole group, so the card must count the whole group.
  const cohort = ["a", "b", "c", "d"];
  const register = deriveRoster({ cohortStudentIds: cohort, enrolledStudentIds: ["a"], unitHasEnrolments: true });
  const card = deriveUnitRoster({ enrolledStudentIds: ["a"], scheduledStudentIds: cohort, hasScheduledGroup: true });
  assert.equal(card.studentIds.length, register.studentIds.length);
  assert.deepEqual(card.studentIds, register.studentIds);
});

test("a partially-enrolled unit with an UNGROUPED register counts both audiences", () => {
  // Two kinds of register on one unit: the cohort ones now list their whole group, and
  // the ungrouped one lists the whole enrolment. The unit concerns the union — an
  // enrolled student reachable only through the ungrouped register must not be dropped,
  // and a group member the enrolment never named must not be either.
  const r = deriveUnitRoster({
    enrolledStudentIds: ["a", "d"],
    scheduledStudentIds: ["a", "b", "c"],
    hasScheduledGroup: true,
    hasUngroupedRegister: true,
  });
  assert.deepEqual(r.studentIds, ["a", "b", "c", "d"]);
  assert.equal(r.rule, "cohort-over-partial-enrolment");
});

test("enrolmentIsAuthoritativeFor reads the unit, never the enrolment count", () => {
  // The property no count-derived answer has: adding an Enrolment row cannot move it.
  assert.equal(enrolmentIsAuthoritativeFor({ moodleSectionId: 12, moodleCourseId: 3 }), true);
  assert.equal(enrolmentIsAuthoritativeFor({ moodleSectionId: null, moodleCourseId: 3 }), true);
  assert.equal(enrolmentIsAuthoritativeFor({ moodleSectionId: 12, moodleCourseId: null }), true);
  // A hand-created unit, and the synthetic Tutorial unit the attendance import makes:
  // neither carries a Moodle id, and both are where the cliff was actually reachable.
  assert.equal(enrolmentIsAuthoritativeFor({ moodleSectionId: null, moodleCourseId: null }), false);
  // Zero is a real Moodle id only in theory, but it must not read as absent, and a
  // caller that selected neither column must not read as "enumerated".
  assert.equal(enrolmentIsAuthoritativeFor({ moodleSectionId: 0 }), true);
  assert.equal(enrolmentIsAuthoritativeFor({}), false);
  assert.equal(enrolmentIsAuthoritativeFor(null), false);
  assert.equal(enrolmentIsAuthoritativeFor(undefined), false);
});
