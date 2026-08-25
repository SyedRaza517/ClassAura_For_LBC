// Canvas's API shapes, turned into the one shape the VLE sync writes from.
//
// PURE. No network, no database. Given a Canvas submission row and its assignment, it
// answers the three questions the rest of the system asks: did this student hand
// anything in, when, and what mark did they get.
//
// It is a separate file from canvas.js — which handles auth, paging and throttling —
// because these are the decisions that get ARGUED with. Every one of them is a
// judgement about a real student's record, and every one of them fails silently if it
// is wrong: no exception, no log line, just a number that looks reasonable and is not
// true. See canvasNormalise.test.js, which is longer than this file on purpose.
//
// The unifying rule, the same one the prediction engine follows: WHERE CANVAS DOES NOT
// KNOW, WE DO NOT GUESS. Unknown is a real answer here, and it is excluded from the
// denominators downstream rather than counted against anybody.

// Shared with blackboardNormalise, and timezone-aware. Slicing the UTC ISO string
// dates a 00:30 BST hand-in to the previous day — see isoDate.js.
const { isoDate } = require("./isoDate");

/**
 * Did this student hand the work in, when, and was it on time?
 *
 * `submitted_at` IS THE TEST, not workflow_state. A teacher entering a mark straight
 * into the gradebook — for an exam, or for work handed in on paper — produces
 * `workflow_state: "graded"` with `submitted_at: null` and `attempt: null`. Inferring
 * submission from the state would report every such assessment as submitted online,
 * and the submission rate would be inflated for exactly the students who hand nothing
 * in digitally.
 *
 * Returns { status: "submitted" | "not_submitted" | "unknown", submittedOn, onTime }.
 * The three states are the ones AssessmentSubmission stores, and "unknown" exists so
 * that work which is simply not due yet cannot be read as work a student failed to do.
 */
function submissionOf(sub) {
  const s = sub || {};
  const submittedOn = isoDate(s.submitted_at);

  // Excused work is excluded from the student's record entirely — it is neither a
  // submission nor a failure to submit, and counting it either way misrepresents a
  // student who was released from the work.
  if (s.excused === true) {
    return { status: "unknown", submittedOn, onTime: null };
  }

  let status;
  if (submittedOn) {
    status = "submitted";
  } else if (s.missing === true) {
    // Canvas sets `missing` when work is past its due date and nothing was handed in.
    status = "not_submitted";
  } else {
    // Not submitted and not yet due — or an assignment type Canvas cannot report on.
    // Saying "not submitted" here would chase a student over work set for next month.
    status = "unknown";
  }

  // ON TIME COMES FROM CANVAS, and is not recomputed.
  //
  // With assignment overrides one assignment has many due dates, and the top-level
  // `due_at` is not necessarily the one that applied to this student. Canvas has
  // already done that arithmetic per student. A teacher's `late_policy_status`
  // outranks it: marking a submission "extended" leaves `late: true` on the row, and
  // their decision is the one that counts.
  //
  // NULL WHEN NOTHING WAS SUBMITTED. You cannot be on time or late for work that was
  // never handed in — and either boolean is a value an on-time rate would count, which
  // is the same mistake as scoring an unmeasured student zero. Work that is missing is
  // counted as missing, once. blackboardNormalise agrees, and normaliseContract.test.js
  // holds the two together.
  let onTime = null;
  if (status === "submitted") {
    onTime = true;
    if (s.late_policy_status === "late" || s.late_policy_status === "missing") onTime = false;
    else if (s.late_policy_status === "extended" || s.late_policy_status === "none") onTime = true;
    else if (s.late === true) onTime = false;
  }

  return { status, submittedOn, onTime };
}

/**
 * The mark, as { score, possible }, or null where a number would be a lie.
 *
 * Null is returned for every case that is NOT a zero: ungraded, excused (excluded from
 * the average rather than scored 0), a grade the college has not yet released, and an
 * assignment worth no points at all.
 */
function markOf(sub, assignment) {
  const s = sub || {};
  const a = assignment || {};

  if (s.excused === true) return null;

  // A manual posting policy holds a grade back from the student. Mirroring it would
  // show them a mark their own college has decided not to release yet.
  if (Object.prototype.hasOwnProperty.call(s, "posted_at") && !s.posted_at) return null;

  const possible = typeof a.points_possible === "number" ? a.points_possible : null;
  // Zero points possible makes every percentage derived from it a division by zero.
  if (!possible || possible <= 0) return null;

  if (typeof s.score !== "number") return null;

  return { score: s.score, possible };
}

/**
 * The college's OWN student number, or null.
 *
 * Canvas's numeric id is deliberately NOT a fallback: it is Canvas's identifier, not
 * the institution's, and writing it into studentRef would mint a number that matches
 * nothing in the college's own records.
 *
 * THE TRAP: `sis_user_id` is OMITTED — key absent, not null — when the token lacks
 * SIS-read permission. Code testing `=== null` sees `undefined`, treats it as present,
 * and every student silently loses their student number. Hence a truthiness check
 * across all three candidates rather than a null check on the first.
 */
function studentRefOf(user) {
  const u = user || {};
  for (const v of [u.sis_user_id, u.login_id, u.integration_id]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Rows that look like students and are not.
 *
 * Two of them, and both reach a grade import even though the users endpoint filters
 * them out:
 *
 *   Test Student — created in every course by "Student View". It appears in
 *   submissions data, so a naive import creates a real student with real-looking marks.
 *
 *   access_restricted_by_date — Canvas returns a STUB carrying only that flag in place
 *   of the real object. Importing it creates a student with no name.
 */
// WHAT THIS CANNOT CATCH, and the sync must handle instead: a user object embedded in
// a submission (`/submissions?include[]=user`) carries only id, name, display_name and
// avatar — no type, no enrollments. So Test Student IS detectable on the enrolment and
// user endpoints and IS NOT on the submissions endpoint. The sync must therefore build
// its student set from enrolments and reject submission rows whose user id is not in
// it, rather than relying on this function alone.
function isTestStudent(row) {
  const r = row || {};
  if (r.access_restricted_by_date === true) return true;
  if (r.type === "StudentViewEnrollment") return true;
  if (r.enrollment_type === "StudentViewEnrollment") return true;
  // `?include[]=enrollments` nests them, so the flat checks above miss it entirely.
  if (Array.isArray(r.enrollments) && r.enrollments.some((e) => e && e.type === "StudentViewEnrollment")) return true;
  return false;
}

module.exports = { submissionOf, markOf, studentRefOf, isTestStudent, isoDate };
