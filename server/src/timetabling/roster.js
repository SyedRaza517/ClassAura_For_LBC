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

module.exports = { deriveRoster };
