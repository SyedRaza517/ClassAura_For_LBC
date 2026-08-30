// Who handed the work in, decided from what Moodle's grade report already tells us.
//
// PURE. No network, no database — the seam moodleItemType.js and moodleActivityDates.js
// keep, for the same reason: every rule here is a statement about a named student's
// record, and every one of them fails SILENTLY if it is wrong.
//
// WHY NOT mod_assign_get_submissions, THE OBVIOUS ANSWER
//
// Because it cannot see this college's assessments. mod_assign only knows about Moodle
// `assign` activities, and STATUS.md records that most assessments here are Turnitin /
// LTI grade items. An ingest built on mod_assign would report "no submissions" for the
// very activities the tracker exists to measure.
//
// `gradedatesubmitted` comes back from gradereport_user_get_grade_items for EVERY item
// type, Turnitin included, for every enrolled user — and moodle.js already receives it
// and throws it away, because it skips any student whose graderaw is null. That skip is
// precisely the submitted-but-unmarked population the marking percentage is about. The
// data was on the wire, exactly like the activity dates and lastcourseaccess before it.
//
// THE GUARD THAT MAKES THIS SAFE WITHOUT KNOWING THE COLLEGE'S MOODLE IN ADVANCE
//
// A field that is never populated and a cohort that submitted nothing look identical:
// both are "no dates anywhere". Writing not_submitted on that basis would report an
// entire college as having handed in nothing — the manufactured crisis this whole
// feature is built to avoid.
//
// So the decision is made PER ASSESSMENT, from the whole cohort at once: if not one
// student on an assessment has either a submission date or a mark, we did not observe
// anything, and NO ROWS ARE WRITTEN. The tracker then reads null and says "Not synced",
// which is true. If even one student is observed, the field is demonstrably live for
// that activity, and its absence for another student is a real "did not submit".
//
// This is "a row means we looked" from vle/engagementNormalise.js, applied per activity
// rather than per institution — because the answer genuinely varies by activity type
// within one Moodle, which the institution-wide version cannot express.

/**
 * Decide the submission rows for ONE assessment, from every enrolled student's grade
 * report entry for it.
 *
 * @param observations array of { studentId, submittedOn: string|null, hasGrade: boolean }
 *        — one entry per student the grade report returned for this item. `submittedOn`
 *        is already an academic YYYY-MM-DD (see moodleActivityDates.dateFromEpoch).
 * @returns { observed: boolean, rows: [{ studentId, status, submittedOn }] }
 *        `observed:false` means write nothing and leave the assessment unmeasured.
 */
function submissionsForAssessment(observations) {
  const list = Array.isArray(observations) ? observations.filter((o) => o && o.studentId) : [];

  // Did this activity tell us ANYTHING about ANYONE? A mark counts as evidence just as
  // much as a date: somebody marked a script, so a script existed.
  const observed = list.some((o) => o.submittedOn || o.hasGrade);
  if (!observed) return { observed: false, rows: [] };

  return {
    observed: true,
    rows: list.map((o) => ({
      studentId: o.studentId,
      // A MARK IMPLIES A SUBMISSION, and this is not a convenience — it is what keeps
      // the marking percentage from exceeding 100%. That figure is marked ÷ submitted,
      // so a marked student who was not counted as having submitted would make the
      // numerator larger than the denominator. It is also simply true: you cannot mark
      // work that was never handed in. Coursework marked from a paper copy has no
      // Moodle submission date and is still a submission.
      status: (o.submittedOn || o.hasGrade) ? "submitted" : "not_submitted",
      // NULL for work marked with no submission date recorded. Deliberately not
      // back-filled with the grading date: "handed in on the day it was marked" is a
      // fabrication, and the on-time calculation downstream reads this field. A null
      // here means "submitted, date unknown", which is the truth.
      submittedOn: o.submittedOn || null,
    })),
  };
}

module.exports = { submissionsForAssessment };
