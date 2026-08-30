// The assessment tracker's derivations. PURE: no database, no network, no clock.
//
// It is a separate file from routes/assessmentTracker.js — which does the querying and
// the HTTP — for the same reason vle/canvasNormalise.js is separate from vle/canvas.js:
// these are the judgements that get argued with, every one of them is about a real
// module's record, and every one of them fails SILENTLY if it is wrong. No exception,
// no log line, just a percentage that looks reasonable and is not true.
//
// `today` is a parameter and never read from a clock in here. Callers pass localDate()
// from clock.js, which is pinned to APP_TIMEZONE — the host clock would date a figure
// to the wrong day for a college in a different timezone, and an untestable one at that.

// One decimal place, matching pctOf() in routes/assessments.js so a rate on this screen
// never disagrees in the last digit with the same rate on the gradebook.
const pct = (n, d) => Math.round((n / d) * 1000) / 10;

// Is this a number we can actually divide with? Deliberately NOT a truthiness test:
// `!0` is true, so a truthy check would turn a legitimately-earned zero — nobody
// submitted, nothing marked — into "not measurable", which is the very distinction
// this whole file exists to preserve, inverted.
const known = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * What proportion of the enrolled cohort handed this assessment in?
 *
 * NULL, NEVER ZERO, WHEN `submitted` IS UNKNOWN. AssessmentSubmission is written by
 * nothing until the LMS sync lands, so every assessment in the college has an unknown
 * submission count today. A 0 here would report every module as having received no
 * work at all — a college-wide crisis manufactured out of a missing integration, and
 * the single failure this feature most has to avoid.
 *
 * Null also when nobody is enrolled: dividing by an empty cohort is not 0% and not
 * 100%, it is unmeasurable, and either answer would be a statement about students who
 * do not exist.
 */
function submissionRate(submitted, enrolled) {
  if (!known(submitted) || !known(enrolled) || enrolled <= 0) return null;
  return pct(submitted, enrolled);
}

/**
 * How far through marking is this assessment — marked over SUBMITTED.
 *
 * The denominator is submitted, not enrolled, because you cannot mark a script nobody
 * handed in. 20 of 50 students submitted and all 20 marked is a finished job at 100%,
 * not 40% of one; the marked-out-of-enrolled reading can never reach 100% while anyone
 * fails to submit, so a fully-marked module would read as incomplete for ever and the
 * figure would stop meaning anything to whoever is chasing markers.
 *
 * The cost of that choice is honest and accepted: with no submission data there is no
 * denominator, so this is null until the LMS sync exists. coverageRate() below is the
 * figure that IS measurable meanwhile, and it is deliberately a different name in a
 * different column rather than a fallback — see its comment.
 */
function markingRate(marked, submitted) {
  if (!known(marked) || !known(submitted) || submitted <= 0) return null;
  return pct(marked, submitted);
}

/**
 * What proportion of the enrolled cohort has a mark — marked over ENROLLED.
 *
 * A different question from markingRate(): "how far through the cohort is this module",
 * not "how much marking is outstanding". It is measurable today, from AssessmentGrade,
 * which the Moodle sync genuinely populates.
 *
 * IT IS NEVER SUBSTITUTED FOR markingRate() WHEN THAT IS NULL. A single column whose
 * denominator silently changes from row to row is worse than a blank one: the reader
 * cannot tell which question any given cell answered, so they stop trusting all of
 * them. Two names, two columns, two meanings.
 */
function coverageRate(marked, enrolled) {
  if (!known(marked) || !known(enrolled) || enrolled <= 0) return null;
  return pct(marked, enrolled);
}

/**
 * Where a date sits relative to today. Strings throughout, compared as strings, which
 * is safe for YYYY-MM-DD and is what the rest of the academic code does.
 *
 * A date of TODAY is "due", not "overdue". Work due today is not late until today is
 * over, and colouring it red at one minute past midnight trains people to ignore red.
 *
 * No date at all is "none" — a college that has not set this deadline is unmeasured,
 * not late, and must not be shown a screen of overdue rows it never opted into.
 */
function deadlineState(date, today) {
  if (!date) return "none";
  if (date < today) return "overdue";
  if (date === today) return "due";
  return "upcoming";
}

/**
 * The marking deadline's state, which is NOT simply deadlineState() of it.
 *
 * An assessment fully marked a week after its marking deadline is FINISHED, not late.
 * The deadline has passed and there is nothing anyone can do about it or needs to;
 * reporting it as overdue fills the tracker with rows nobody can act on, which is the
 * same as an empty tracker.
 *
 * And while `submitted` is unknown there is no way to tell whether anything is
 * outstanding at all, so the answer is "unknown" rather than a guess. Guessing
 * "overdue" here would accuse a named module leader of a marking backlog on the
 * strength of an integration that has not been built yet.
 */
function markingState(markingDueDate, marked, submitted, today) {
  if (!markingDueDate) return "none";
  if (!known(submitted)) return "unknown";
  const outstanding = submitted - (known(marked) ? marked : 0);
  if (outstanding <= 0) return "complete";
  return deadlineState(markingDueDate, today);
}

module.exports = { submissionRate, markingRate, coverageRate, deadlineState, markingState };
