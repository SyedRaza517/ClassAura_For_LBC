// Blackboard Learn's API shapes, turned into the one shape the VLE sync writes from.
//
// PURE — no network, no database, no config. The counterpart to canvasNormalise.js,
// and split out of blackboard.js (which owns auth, paging and throttling) for the same
// reason: these are the judgements that get argued with, and every one of them fails
// SILENTLY if it is wrong.
//
// Blackboard's traps are worse than Canvas's because two of them look exactly like the
// obvious reading of the API:
//
//   `GradeV2.score` is the instructor's OVERRIDE — "only used for overriding the
//   grade", null for every normally-graded student. Reading the field called `score`
//   as the score gives a gradebook of nulls with a few outliers.
//
//   `GradeV2.status` is documented in Blackboard's own specification as having "never
//   contained reliable data. Please stop using it immediately." It is not read here at
//   all; graded-ness comes from the ATTEMPT's status and from whether displayGrade is
//   populated.
//
// See blackboardNormalise.test.js, which is longer than this file deliberately.

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

// Shared with canvasNormalise, and timezone-aware — see isoDate.js for why slicing
// the UTC ISO string dates a 00:30 BST hand-in to the previous day.
const { isoDate } = require("./isoDate");

/**
 * Was this attempt late?
 *
 * DERIVED, because Blackboard has no `late` field anywhere — the only "Late" in the
 * entire specification is an attendance status. A column with no due date cannot make
 * anything late, which is the common case: the naive reading marks a whole gradebook
 * late on the first import.
 */
function isLate(attemptDate, due) {
  if (!attemptDate || !due) return false;
  const a = Date.parse(attemptDate);
  const d = Date.parse(due);
  if (!Number.isFinite(a) || !Number.isFinite(d)) return false;
  return a > d;
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                  */
/* -------------------------------------------------------------------------- */

// AttemptV2.status, sorted into the three states AssessmentSubmission stores.
// Anything not listed is deliberately absent: a status Blackboard adds later must
// become "unknown" rather than being guessed into either column.
const SUBMITTED = new Set(["Completed", "NeedsGrading", "NeedsGradingAgain"]);
const NOT_SUBMITTED = new Set(["NotAttempted", "InProgress", "InProgressAgain", "Abandoned", "Canceled"]);

/**
 * Did the student hand the work in, when, and was it on time?
 *
 * NeedsGrading counts as submitted: from the student's side the work is done, and a
 * marking backlog must not read as a cohort that submitted nothing — which is the
 * exact confusion AssessmentSubmission was added to remove.
 *
 * InProgress does NOT count. Started and saved is not handed in, and crediting it
 * would give a student a submission for a draft they never sent.
 *
 * `now` is injected rather than read from the clock so the function stays deterministic
 * under test; it decides only whether un-submitted work is overdue yet.
 */
function submissionOf(attempt, column, now = Date.now()) {
  const a = attempt || {};

  // ONE resolved date, used for BOTH the date recorded and the lateness judged.
  //
  // These were separate, with opposite precedence: submittedOn preferred the receipt
  // while lateness read attemptDate. A reopened attempt then produced a row saying
  // "submitted 28 April" and "late" against a 1 May deadline — simultaneously, in the
  // same row. That is the same class as a score disagreeing with its own band: nobody
  // can act on it and everybody stops believing both halves.
  //
  // The receipt is what Blackboard timestamps the actual hand-in with; attemptDate
  // moves when an attempt is reopened, and `created` is only the row's own birthday.
  // So they are tried in that order of authority — once.
  const when =
    (a.attemptReceipt && a.attemptReceipt.submissionDate) ||
    a.attemptDate ||
    a.created ||
    null;

  const due = column && column.grading ? column.grading.due : null;

  let status = "unknown";
  if (SUBMITTED.has(a.status)) {
    status = "submitted";
  } else if (NOT_SUBMITTED.has(a.status)) {
    // NOT-YET-DUE IS "UNKNOWN", NOT "NOT SUBMITTED".
    //
    // Canvas hands us its own `missing` flag, which is already gated on the due date.
    // Blackboard has no equivalent — NotAttempted is true from the moment a column is
    // created — so the gate has to be applied here, from the column's due date.
    //
    // Without it, every assessment a college sets for next month reports its whole
    // cohort as having failed to hand work in, which drives the missing-work count and
    // chases students over work that is not due. That is the same failure canvasNormalise
    // guards against, and the two must agree; normaliseContract.test.js holds them to it.
    //
    // No due date at all means overdue-ness cannot be established, so the honest answer
    // is unknown — which is excluded from the denominator rather than counted.
    const overdue = Boolean(due) && Date.parse(due) < now;
    status = overdue ? "not_submitted" : "unknown";
  }

  // NULL when nothing was submitted. You cannot be on time or late for work never
  // handed in, and either boolean is a value an on-time rate would count — the same
  // mistake as scoring an unmeasured student zero. canvasNormalise agrees, and
  // normaliseContract.test.js holds the two together.
  const onTime = status === "submitted" ? !isLate(when, due) : null;

  return { status, submittedOn: status === "submitted" ? isoDate(when) : null, onTime };
}

/* -------------------------------------------------------------------------- */
/* The mark                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The student's actual mark, as { score, possible }, or null.
 *
 * Null wherever a number would be a lie: not graded, exempt (excluded from the average
 * rather than scored zero), a corrupt calculated column, and any scale that is text
 * rather than a number. A genuine zero is kept.
 */
function markOf(grade) {
  if (!grade) return null;
  if (grade.exempt === true) return null;
  if (grade.corrupt === true) return null;

  const dg = grade.displayGrade || null;
  const possible = dg && typeof dg.possible === "number" ? dg.possible : null;

  // NO USABLE DENOMINATOR, NO MARK — matching canvasNormalise, which refuses the same
  // case. `possible` of 0 makes every percentage derived from it a division by zero,
  // and null makes it NaN; both are numbers that look reasonable downstream. This
  // file's own docstring says "null wherever a number would be a lie", and a score
  // with nothing to divide it by is one.
  if (!possible || possible <= 0) return null;

  // An instructor's manual override is the authoritative mark where one exists — and
  // is the ONLY thing `grade.score` ever holds.
  if (grade.overridden === true && typeof grade.score === "number") {
    return { score: grade.score, possible };
  }

  if (!dg) return null;
  if (dg.scaleType === "Text" || dg.scaleType === "CompleteIncomplete") return null;
  if (typeof dg.score !== "number") return null;

  return { score: dg.score, possible };
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The college's own student number, or null.
 *
 * Blackboard has four id spaces and only one of them is the institution's:
 *
 *   studentId   "the user's student ID name or number as defined by the school"
 *   externalId  the SIS batch key (formerly batchUid), defaults to userName
 *   userName    the login name
 *   id / uuid   Learn's own keys
 *
 * `id` (`_2545_1`) is NEVER used. It is not stable across a course copy or a site
 * migration, and it is not a number the college holds anywhere — keying on it
 * duplicates every student at the next rollover.
 */
function studentRefOf(user) {
  const u = user || {};
  for (const v of [u.studentId, u.externalId, u.userName]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Which course a membership actually belongs to.
 *
 * In a cross-listed set, enrolments are synchronised onto the PARENT and each
 * membership carries `childCourseId` naming the section the student is really in.
 * Attributing them to `courseId` merges every section of a module into one register.
 */
function unitIdOf(membership) {
  const m = membership || {};
  return m.childCourseId || m.courseId || null;
}

/**
 * Is this course a CHILD of a cross-listed set?
 *
 * Content, gradebook columns, attempts and grades live only on the parent, so children
 * are skipped when walking courses for grades: iterating them finds nothing, and
 * iterating both duplicates every student.
 */
const isChildCourse = (course) => Boolean(course && course.parentId);

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Availability is THREE states — "Yes" | "No" | "Disabled" — not a boolean.
 *
 * "Disabled" means disabled by the SIS: a suspended course, or a withdrawn student.
 * This collapses it to a boolean for the sync's purposes, but the raw enum is what
 * gets mirrored, so the distinction between "the college hid this" and "the student
 * record system withdrew it" survives where it matters.
 *
 * A row with no availability block is AVAILABLE. Absence is not a withdrawal, and
 * defaulting the other way would silently drop every row from a response fetched with
 * a `fields` filter that happened to omit it.
 */
function isAvailable(row) {
  const a = row && row.availability ? row.availability.available : undefined;
  if (a === undefined || a === null || a === "") return true;
  return a === "Yes";
}

/* -------------------------------------------------------------------------- */
/* Attendance                                                                  */
/* -------------------------------------------------------------------------- */

// Blackboard's four states onto the register's own. Excused is E and not A
// deliberately: attendance.js scores E as a point earned and A as none, so flattening
// the two costs a student attendance they were entitled to.
const ATTENDANCE = { Present: "P", Absent: "A", Late: "L", Excused: "E" };

/** One Blackboard attendance status as a register mark, or null if unrecognised. */
const attendanceToStatus = (bbStatus) => ATTENDANCE[bbStatus] || null;

module.exports = {
  submissionOf,
  markOf,
  studentRefOf,
  unitIdOf,
  isChildCourse,
  isAvailable,
  attendanceToStatus,
  isLate,
  isoDate,
  ATTENDANCE,
};
