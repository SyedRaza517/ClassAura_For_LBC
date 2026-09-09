// Who is on a register.
//
// The intersection of "in this group" and "enrolled on this module". Enrolment alone
// is not enough, because a MERGED CLASS keeps separate registers per group and every
// student on the module is enrolled on it regardless of which group they are in —
// matching on enrolment would put both groups on both registers, which is exactly the
// thing separate registers exist to prevent.
//
// THE FALLBACK IS THE HALF WORTH READING TWICE.
//
// `unitHasEnrolments` is a question about the UNIT, asked once, unfiltered by student:
// "does this module have any enrolment rows at all". It is NOT "did anyone in this
// cohort enrol", which has the same shape and the wrong answer. A module with no
// enrolments anywhere means Moodle has not synced or somebody added the module by
// hand, and falling back to the whole cohort is right there — an empty register would
// otherwise be indistinguishable from a class nobody joined.
//
// But a module that HAS enrolments and none of them in this group is DATA. It says
// nobody in this group takes this module, and widening to the cohort there would put
// students on a register for a module they are not taking. So the probe must be
// hoisted out of any per-group or per-chunk loop by its caller; computed from the
// group it collapses into the second question and silently gets it wrong. That
// mistake has been made repeatedly in the prediction code and has its own paragraph
// in CLAUDE.md.
//
// The RULE is returned alongside the ids because the two empty rosters mean opposite
// things — "nobody in this group takes this" versus "we do not know who does" — and
// the screen has to be able to say which.

/**
 * @param {object} args
 * @param {string[]} args.cohortStudentIds  Every student in the group.
 * @param {string[]} args.enrolledStudentIds Every student enrolled on the unit.
 * @param {boolean}  args.unitHasEnrolments  Does the UNIT have any enrolments at all.
 * @returns {{ studentIds: string[], rule: "cohort-and-enrolment" | "cohort-only" }}
 */
function deriveRoster({ cohortStudentIds = [], enrolledStudentIds = [], unitHasEnrolments = false } = {}) {
  // De-duplicated but order-preserving: the cohort's own order is the one a lecturer
  // reading a register down the page expects, and a Set alone would not keep it.
  const cohort = [...new Set(cohortStudentIds)];

  if (!unitHasEnrolments) return { studentIds: cohort, rule: "cohort-only" };

  const enrolled = new Set(enrolledStudentIds);
  return { studentIds: cohort.filter((id) => enrolled.has(id)), rule: "cohort-and-enrolment" };
}

// ---------------------------------------------------------------------------
// The same rule again, asked about a WHOLE UNIT rather than one register.
//
// THE BUG THIS EXISTS TO CLOSE. The Registers → Units cards read `studentCount`
// straight off a count of Enrolment rows, so BUS701–BUS705 — hand-created modules that
// Moodle never synced and therefore carry no enrolments at all — printed "0 students ·
// 20 sessions" while the registers for those very classes correctly listed the twenty
// students of the group scheduled against them. The card and the register were reading
// two different definitions of "who is on this module", and the card's was the one that
// did not know about the fallback branch.
//
// So the count is derived from the SAME two branches deriveRoster applies, unioned over
// every audience the unit's registers draw from. It is a union rather than a sum
// because a merged class puts one student on one register only, but two groups on one
// module are still one module's worth of people, and someone both enrolled and in a
// scheduled group must be counted once.
//
// WHY `null` IS A REAL ANSWER HERE. A module with no enrolments AND no group scheduled
// against it has no route to a student at all: the enrolment branch has nothing to
// intersect and the cohort branch has no cohort. "0 students" would be the same
// sentence a genuinely empty module says, which is precisely the confusion roster.js
// exists to prevent one register at a time — and null-is-not-zero is the house rule for
// exactly this. It is returned as null and excluded, never coerced.
//
// `hasUngroupedRegister` is the case that looks like an edge and is not: registers made
// by the three-hour-block generator and by the Moodle import carry no cohortId, and
// registers.rosterForSession gives those the module's whole enrolment. A module holding
// one of those therefore concerns every enrolled student regardless of which groups are
// timetabled against it, so the intersection would UNDER-count — the direction of the
// original bug.

/**
 * @param {object} args
 * @param {string[]} args.enrolledStudentIds   Every student enrolled on the unit.
 * @param {string[]} args.scheduledStudentIds  Every student in every cohort that reaches
 *                                             the unit through a timetabled class or an
 *                                             existing register.
 * @param {boolean}  args.hasScheduledGroup    Does ANY group reach the unit at all —
 *                                             asked about the unit, not derived from
 *                                             `scheduledStudentIds`, because a group with
 *                                             no students in it is an answer and an
 *                                             absent group is not.
 * @param {boolean}  args.hasUngroupedRegister Does the unit hold a register with no
 *                                             cohort (generator- or Moodle-created).
 * @returns {{ studentIds: string[]|null, rule: "cohort-and-enrolment"|"cohort-only"|"enrolment-only"|"unmeasurable" }}
 */
function deriveUnitRoster({
  enrolledStudentIds = [],
  scheduledStudentIds = [],
  hasScheduledGroup = false,
  hasUngroupedRegister = false,
} = {}) {
  const enrolled = [...new Set(enrolledStudentIds)];
  const scheduled = [...new Set(scheduledStudentIds)];
  // The unit-level probe, exactly as deriveRoster means it: "does this module record any
  // enrolment at all", never "did anyone in some group enrol".
  const unitHasEnrolments = enrolled.length > 0;

  if (!unitHasEnrolments) {
    // Nothing to measure. Not zero — see above.
    if (!hasScheduledGroup) return { studentIds: null, rule: "unmeasurable" };
    return { studentIds: scheduled, rule: "cohort-only" };
  }

  // Either there is no group to intersect with, or one of the unit's registers already
  // draws the whole enrolment. Both make the enrolment the answer.
  if (!hasScheduledGroup || hasUngroupedRegister) return { studentIds: enrolled, rule: "enrolment-only" };

  const enrolledSet = new Set(enrolled);
  return { studentIds: scheduled.filter((id) => enrolledSet.has(id)), rule: "cohort-and-enrolment" };
}

module.exports = { deriveRoster, deriveUnitRoster };
