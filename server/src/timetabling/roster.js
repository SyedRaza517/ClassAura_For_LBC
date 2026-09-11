// Who is on a register.
//
// The intersection of "in this group" and "enrolled on this module". Enrolment alone
// is not enough, because a MERGED CLASS keeps separate registers per group and every
// student on the module is enrolled on it regardless of which group they are in —
// matching on enrolment would put both groups on both registers, which is exactly the
// thing separate registers exist to prevent.
//
// That is also why a UNION of the two was rejected when this was reworked. A union can
// only ever grow the roster, so it removes the cliff described below at the price of
// the one guarantee this file exists to give: on a merged class it puts group B back on
// group A's register, and /mark-remaining-absent then writes a permanent A against
// twenty students who were in another room. The roster is bounded by the cohort in
// every branch, deliberately and without exception.
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
// THE CLIFF `enrolmentIsAuthoritative` CLOSES (11 Sep 2026).
//
// Until this argument existed the paragraph above was the WHOLE rule, and it turned on
// a count crossing zero. A count crossing zero is a cliff, not a slope. Add ONE
// Enrolment row to a module that had none and `unitHasEnrolments` flips, the roster
// becomes cohort ∩ enrolment, and a twenty-five student register becomes a one-student
// register — measured, not supposed: roster.test.js pins 25 → 1, and 25 → 0 when that
// single row names somebody outside the group.
//
// Nothing about that single row was a statement about the other twenty-four students,
// and there are three ordinary ways for it to appear:
//
//   • an administrator opens ONE student's record and ticks the module. PUT
//     /hnd/students/:id/enrolments writes one row, on a module that may have had none.
//   • the Moodle attendance import enrols everybody it is about to mark — see the long
//     comment in moodleAttendance.js. On the synthetic Tutorial unit it therefore
//     enrols whoever appeared in the sessions it happened to import, which is a handful
//     of the class rather than the class.
//   • a hand-built module gains its first student for any other reason at all.
//
// In every one of those the enrolment list is being assembled ONE STUDENT AT A TIME,
// and a list assembled one student at a time cannot be read as a complete class list.
// Its silences are missing data, not evidence. A list written by something that
// ENUMERATES a whole class — the Moodle gradebook sync walks a course section and
// records everyone in it — can be read that way, and must be, or un-enrolling a student
// who dropped the module would never take them off a register again.
//
// So the mode is now an ARGUMENT rather than an inference, and the caller answers it
// from the unit's provenance (see enrolmentIsAuthoritativeFor at the foot of this file).
// Three alternatives were weighed and rejected, and the reasons are worth keeping
// because each of them looks better than it is:
//
//   UNION — rejected above: it breaks the merged class, which is the worse bug.
//
//   A COVERAGE THRESHOLD ("trust the list once it names half the cohort") — rejected
//   because it does not remove the cliff, it MOVES it. Enrol the thirteenth student of
//   twenty-five and the register drops from twenty-five to thirteen in one click: the
//   same silent eviction, now at a number nobody chose on purpose. It also cannot tell
//   apart the two cases that matter — an administrator who deliberately enrolled the
//   eight students taking an optional module, and an import that happened to catch
//   three — because both are "some of the cohort" and only intent separates them.
//   Intent is not in the Enrolment table.
//
//   A PER-STUDENT FALLBACK ("keep a cohort member who has no enrolments anywhere") —
//   rejected because in any college that syncs Moodle at all, every student has
//   enrolments on their OTHER modules, so it keeps nobody and the cliff is untouched.
//
// The honest shape of this is a column on Unit recording the mode outright, written by
// whichever screen or sync last set the enrolment list wholesale. That is a migration
// and is not made here; the unit's Moodle provenance is the same answer read off data
// that already exists, and it has the property the count never had — a single enrolment
// cannot change it.
//
// The RULE is returned alongside the ids because the empty rosters mean opposite things
// — "nobody in this group takes this" versus "we do not know who does" — and the screen
// has to be able to say which.

/**
 * @param {object} args
 * @param {string[]} args.cohortStudentIds  Every student in the group.
 * @param {string[]} args.enrolledStudentIds Every student enrolled on the unit.
 * @param {boolean}  args.unitHasEnrolments  Does the UNIT have any enrolments at all.
 * @param {boolean}  args.enrolmentIsAuthoritative Was the unit's enrolment list written by
 *                                            something that ENUMERATES a whole class, so
 *                                            that a student's absence from it is evidence
 *                                            rather than missing data. Defaults to false,
 *                                            which is the safe side: an unanswered
 *                                            question never silently removes anybody from
 *                                            a register.
 * @returns {{ studentIds: string[], rule: "cohort-and-enrolment" | "cohort-only" | "cohort-over-partial-enrolment" }}
 */
function deriveRoster({
  cohortStudentIds = [],
  enrolledStudentIds = [],
  unitHasEnrolments = false,
  enrolmentIsAuthoritative = false,
} = {}) {
  // De-duplicated but order-preserving: the cohort's own order is the one a lecturer
  // reading a register down the page expects, and a Set alone would not keep it.
  const cohort = [...new Set(cohortStudentIds)];

  if (!unitHasEnrolments) return { studentIds: cohort, rule: "cohort-only" };

  // The list exists but was not enumerated, so it can add nobody to this group and
  // remove nobody from it. Reported under its own rule rather than folded into
  // "cohort-only", because the sentence a screen should print is not the same one: this
  // module HAS enrolment data and we are declining to read its gaps as answers, which
  // is a different fact from having none at all.
  if (!enrolmentIsAuthoritative) return { studentIds: cohort, rule: "cohort-over-partial-enrolment" };

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
// So the count is derived from the SAME branches deriveRoster applies, unioned over
// every audience the unit's registers draw from. It is a union rather than a sum
// because a merged class puts one student on one register only, but two groups on one
// module are still one module's worth of people, and someone both enrolled and in a
// scheduled group must be counted once.
//
// `enrolmentIsAuthoritative` ARRIVES HERE FOR THE SAME REASON IT ARRIVES ABOVE, and it
// has to, or the card and the register disagree again the moment a hand-built module
// gains its first enrolment: the register would list the whole group and the card would
// print "1 student". That is the original bug back, wearing a newer number.
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
 * @param {boolean}  args.enrolmentIsAuthoritative As on deriveRoster: was the enrolment
 *                                             list enumerated, or assembled one student
 *                                             at a time. Defaults to false.
 * @returns {{ studentIds: string[]|null, rule: "cohort-and-enrolment"|"cohort-only"|"cohort-over-partial-enrolment"|"enrolment-only"|"unmeasurable" }}
 */
function deriveUnitRoster({
  enrolledStudentIds = [],
  scheduledStudentIds = [],
  hasScheduledGroup = false,
  hasUngroupedRegister = false,
  enrolmentIsAuthoritative = false,
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

  // No group to intersect with, so the enrolment is the answer. True whether or not the
  // list was enumerated, because this branch REMOVES nobody: with no cohort there is
  // nothing to remove anyone from.
  if (!hasScheduledGroup) return { studentIds: enrolled, rule: "enrolment-only" };

  if (!enrolmentIsAuthoritative) {
    // Every cohort-bearing register of this unit now lists its whole group (deriveRoster's
    // middle branch), so the unit concerns all of them. If the unit ALSO holds an
    // ungrouped register, it concerns the whole enrolment as well, so the two are UNIONED
    // rather than one of them chosen. Under the authoritative rule below that union
    // collapses to `enrolled` on its own — cohort ∩ enrolment is a subset of the
    // enrolment — which is why this case did not exist before and why the ungrouped
    // branch could be written as a plain return.
    if (!hasUngroupedRegister) return { studentIds: scheduled, rule: "cohort-over-partial-enrolment" };
    const seen = new Set(scheduled);
    return {
      studentIds: [...scheduled, ...enrolled.filter((id) => !seen.has(id))],
      rule: "cohort-over-partial-enrolment",
    };
  }

  // One of this unit's registers already draws the whole enrolment, so intersecting
  // would under-count the very students that register lists.
  if (hasUngroupedRegister) return { studentIds: enrolled, rule: "enrolment-only" };

  const enrolledSet = new Set(enrolled);
  return { studentIds: scheduled.filter((id) => enrolledSet.has(id)), rule: "cohort-and-enrolment" };
}

// ---------------------------------------------------------------------------
// Is a unit's enrolment list the kind that can be read for its SILENCES?
//
// One function rather than the same two-field test written out at each of the four call
// sites, for the reason rosterForSession itself exists: a rule copied is a rule that
// drifts, and this one decides whether a register lists twenty-five people or one.
//
// THE SIGNAL IS THE UNIT'S MOODLE PROVENANCE. `moodleSectionId` and `moodleCourseId` are
// written only by the gradebook sync in moodle.js, which walks a course SECTION and
// records every student in it — an enumeration of the whole class, so a student missing
// from it is genuinely not on the module. Every other route into the Enrolment table
// adds rows one student at a time (the per-student enrolment editor, the attendance
// import enrolling whoever it is about to mark), and a hand-created unit — including the
// synthetic Tutorial unit, which moodleAttendance.js creates with no Moodle ids at all —
// therefore answers false and keeps its whole cohort.
//
// It is not a perfect proxy for "somebody stated this list in full", and a column on
// Unit would be. It was chosen because it has the one property required of any answer
// here: NO SINGLE ENROLMENT CAN CHANGE IT. Every count-derived alternative fails that
// test somewhere, which is the whole subject of the header comment above.
//
// WHAT THIS GIVES UP, said plainly: on a hand-created unit, un-enrolling one student no
// longer removes them from a register that carries a cohort. They stay on the sheet,
// flagged `enrolled: false` by GET /register, which already ships that per row. The way
// to teach a module to a subset of a group is a group. That is a real loss and it was
// accepted deliberately, because the mechanism that takes one student off is the same
// one that takes twenty-four off and only one of those is ever what somebody meant.
// Registers with NO cohort — the generator's and the Moodle import's — are untouched by
// this and still follow the enrolment exactly, which is the path a college that does not
// use Moodle mostly runs on.
//
/**
 * @param {{ moodleSectionId?: number|null, moodleCourseId?: number|null }|null|undefined} unit
 * @returns {boolean}
 */
function enrolmentIsAuthoritativeFor(unit) {
  // A caller that selected neither column gets false, not a throw — and false is the
  // side that leaves people ON a register. A caller that needs the other answer has to
  // select the columns, which is cheap and is what registers.js does.
  return Boolean(unit && (unit.moodleSectionId != null || unit.moodleCourseId != null));
}

module.exports = { deriveRoster, deriveUnitRoster, enrolmentIsAuthoritativeFor };
