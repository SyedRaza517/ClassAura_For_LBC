// What a Canvas preview found, and the one question it exists to answer.
//
// PURE. No network, no database — the seam every other vle/ helper keeps.
//
// WHY A PREVIEW AT ALL, AND WHY THIS SUMMARY SHAPE
//
// Canvas has a working connection test and no importer. The test proves a token is
// valid; it says nothing about whether the data behind it is worth importing. This
// summary answers the question that actually decides that:
//
//   DOES CANVAS GIVE US REAL HAND-IN DATES?
//
// It matters because Moodle plus Turnitin LTI does not. There, the only evidence of a
// submission is that somebody marked it, so "submitted" collapses into "marked" and the
// submission rate is the marking coverage under another name — the tracker has to show
// it as a floor ("≥ 23 / 29"). Canvas exposes `submitted_at` per submission through its
// ordinary API, so a Canvas-taught course should produce a REAL submission rate.
//
// "Should" is the word this module removes. `submissionDatesAvailable` is computed from
// what the account actually returned, not from what the API documentation promises: a
// Canvas site where every assignment is marked offline, or on-paper, would carry no
// dates either, and finding that out AFTER building an importer is the expensive order
// to discover it in.

/**
 * Fold the sampled Canvas data into counts and one verdict.
 *
 * @param courses array of
 *   { id, name, students: number, assignments: number,
 *     submissions: [{ studentId, submittedOn: string|null, status: string }] }
 *   — `submissions` already normalised through vle/canvasNormalise.submissionOf, so the
 *   judgement about what counts as a submission lives in exactly one place.
 */
function summarisePreview(courses) {
  const list = Array.isArray(courses) ? courses : [];

  let students = 0, assignments = 0;
  let submissionRows = 0, submitted = 0, withDates = 0, unknown = 0;

  for (const c of list) {
    students += Number(c?.students) || 0;
    assignments += Number(c?.assignments) || 0;
    for (const s of Array.isArray(c?.submissions) ? c.submissions : []) {
      submissionRows++;
      if (s?.status === "submitted") submitted++;
      // A date is the evidence. Counted independently of status so that a row marked
      // submitted with no date — a teacher entering a mark for offline work — does not
      // masquerade as a measured hand-in.
      if (s?.submittedOn) withDates++;
      if (s?.status === "unknown") unknown++;
    }
  }

  return {
    coursesSampled: list.length,
    students,
    assignments,
    submissionRows,
    submitted,
    withDates,
    unknown,
    // THE VERDICT. True only if Canvas returned at least one real hand-in date. With
    // none, this account is no better than the Turnitin case and an importer would
    // produce the same floors — which is exactly what the preview exists to find out
    // before anybody builds one.
    submissionDatesAvailable: withDates > 0,
    // Null rather than 0 when nothing was sampled: "no submissions were examined" and
    // "none of the submissions had dates" are different findings, and a 0% here would
    // read as the second when it was the first.
    datedPercent: submissionRows > 0 ? Math.round((withDates / submissionRows) * 1000) / 10 : null,
  };
}

/**
 * The finding, in the words an administrator reads on the screen.
 *
 * Deliberately not a bare boolean: whoever presses Preview is deciding whether to ask
 * for an importer to be built, and "0 of 412 submissions carried a hand-in date" is the
 * sentence that supports that decision.
 */
function verdictText(s) {
  if (!s || !s.coursesSampled) {
    return "No courses were visible to this token. Canvas is reachable, but the account it belongs to can see nothing to import — generate the token from an account administrator.";
  }
  if (!s.submissionRows) {
    return `Read ${s.coursesSampled} course(s), ${s.students} student(s) and ${s.assignments} assignment(s), but Canvas returned no submissions at all. Nothing has been handed in yet, or this token cannot read submissions.`;
  }
  if (s.submissionDatesAvailable) {
    return `Canvas gives real hand-in dates: ${s.withDates} of ${s.submissionRows} submission rows carry one (${s.datedPercent}%). An importer built on this would produce true submission rates, not the floors the Moodle/Turnitin route is limited to.`;
  }
  return `Canvas returned ${s.submissionRows} submission row(s) but NOT ONE carried a hand-in date. On this account an importer would be no better than the Moodle/Turnitin route — submission counts would again come only from who has been marked.`;
}

module.exports = { summarisePreview, verdictText };
