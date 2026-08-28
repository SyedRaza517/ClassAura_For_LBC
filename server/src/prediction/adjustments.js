// The deadline that actually applies to one student for one piece of work.
//
// PURE. No database, no clock, no tenant — the same seam engine.js and tripwires.js
// keep, and for the same reason: these are the lines a college will be asked to defend
// when a student appeals a decision taken off the back of a risk level.
//
// WHY THIS EXISTS.
//
// Nothing in this schema records that a college granted somebody extra time. So the
// prediction layer sees only that the work arrived late, or has not arrived. It reports
// the student as handing work in late, raises TRIP_CHRONIC_LATE, and — once anything
// starts writing AssessmentSubmission — will count the piece as missing, fire
// RED_MISSING_ASSESSMENTS and cap the band through OVR-001.
//
// THE COLLEGE PUNISHES A STUDENT FOR AN ACCOMMODATION THE COLLEGE ITSELF GRANTED, and
// nothing on the screen says so. That is not a gap in the model's coverage; it is the
// model being wrong about a fact the institution already knows.
//
// The OIA sharpens it in both directions: the majority of academic-appeal complaints
// involve students in personal or health difficulty who did NOT request additional
// consideration in time. So a claim's PRESENCE must suppress, and its ABSENCE alongside
// a genuine deterioration is itself a finding — about the college, which is the party
// that can explain its own process.
//
// THE ONE RULE EVERYTHING ELSE FOLLOWS FROM:
//
//     A suppressed assessment leaves BOTH sides of every fraction. It is never counted
//     as submitted, never counted as on time, and never counted as missing.
//
// This is the null-is-not-zero rule pointed the other way, and getting it backwards is
// the MIRROR-IMAGE harm of the bug being fixed: counting an extended assessment as
// "submitted on time" inflates the score of a student who is genuinely in difficulty
// and quietly removes them from the risk register. That failure is harder to notice
// than the one it replaces, and worse. engine.js already renormalises a component with
// no evidence out of both numerator and denominator; suppression must feed that
// machinery rather than fake a success.
const STATE = Object.freeze({ MEASURED: "measured", DEFERRED: "deferred", EXCLUDED: "excluded" });

/** Inclusive at both ends, YYYY-MM-DD compared as strings — the house convention. */
const inWindow = (date, from, to) => Boolean(date) && date >= from && date <= to;

/**
 * What deadline applies to this assessment for this student, and whether it counts.
 *
 * @param {{id, dueDate}} assessment
 * @param {{byAssessment: Map, windows: Array<{coversFrom, coversTo, status}>}} coverage
 *        built per student by the gather; `byAssessment` maps assessmentId to an
 *        adjustment, `windows` are blanket claims with no per-assessment rows yet
 * @returns {{state: string, due: string|null}}
 *
 *   measured  no adjustment; the assessment's own deadline applies unchanged
 *   deferred  an extension is in force; `due` is the revised deadline and is compared
 *             against today exactly as the original would have been
 *   excluded  not required of this student in this scope, or covered by a blanket
 *             window with no revised date set yet. Leaves both sides of every fraction.
 */
function effectiveDeadline(assessment, coverage, today) {
  const a = assessment || {};
  const cov = coverage || {};
  const byAssessment = cov.byAssessment instanceof Map ? cov.byAssessment : new Map();
  const windows = cov.windows || [];

  const adj = byAssessment.get(a.id);

  // MOST GENEROUS WINS, and the direction is deliberate. Where two live claims overlap,
  // an exclusion beats an extension and a later deadline beats an earlier one. Failing
  // toward the student is the only safe direction for a rule whose failure mode is
  // punishing somebody for an accommodation their college granted.
  if (adj) {
    if (adj.adjustmentType === "exclusion") return { state: STATE.EXCLUDED, due: null };
    if (adj.revisedDueDate) {
      // An "extension" that moves a deadline EARLIER is a data-entry fault, and honouring
      // it would turn this table into a way of manufacturing lateness. The later of the
      // two dates wins, so a mistyped row can only ever be harmless.
      const due = !a.dueDate || adj.revisedDueDate > a.dueDate ? adj.revisedDueDate : a.dueDate;
      return { state: STATE.DEFERRED, due };
    }
  }

  // A BLANKET CLAIM — approved or undecided — with no per-assessment rows yet. This is
  // the ordinary state at the moment a claim is approved, before anybody has sat down to
  // set new dates, and it is precisely the moment the student most needs the
  // suppression. It cannot be made to depend on administrative work that has not
  // happened yet.
  if (a.dueDate) {
    for (const w of windows) {
      if (inWindow(a.dueDate, w.coversFrom, w.coversTo)) return { state: STATE.EXCLUDED, due: null };
    }
  }

  return { state: STATE.MEASURED, due: a.dueDate || null };
}

/**
 * Which claims contribute coverage, and which contribute nothing.
 *
 * APPROVED and OPEN suppress. REJECTED and WITHDRAWN do not.
 *
 * THE UNDECIDED CASE IS THE HARD ONE, and it is argued rather than assumed. Three
 * options existed:
 *
 *   Treat as approved  — pre-empts a decision nobody has taken, and lets a claim work
 *                        as a self-service score suppressant.
 *   Treat as rejected  — punishes the student for the length of the college's own
 *                        decision queue. The same class of failure as
 *                        TRIP_QUERY_UNANSWERED, and precisely the OIA scenario
 *                        inverted: the college tells students to claim, the student
 *                        claims, and the model penalises them while the college thinks.
 *   Treat as unmeasurable — neither.
 *
 * The third is right, and it is this codebase's existing convention rather than a new
 * one. With a claim pending, "did this student fail to hand work in" is not a question
 * about the student at all: the answer depends on a decision the institution has not
 * made. That is the definition of not measurable, and the answer to not-measurable here
 * is to remove it from both sides and let the engine renormalise — exactly as
 * unpassedUnits treats a unit with nothing marked.
 *
 * Three properties keep it safe: the claim's window is capped at validation so it cannot
 * suppress indefinitely; deciding it marks the student stale so it resolves either way;
 * and the pending count is stored and queued, so the delay is reported to the people who
 * can end it.
 *
 * NOT VERIFIED AGAINST ACADEMIC REGULATION. This is a policy judgement wearing code. If
 * a college's own regulations say a pending claim has no effect until determined, this
 * belongs in settings.js as `pendingClaimSuppresses` rather than as a constant here.
 */
const SUPPRESSING = new Set(["approved", "open"]);
const APPROVED_ONLY = new Set(["approved"]);

/** Which statuses suppress, under this college's regulations.
 *
 *  DEFAULTS TO INCLUDING PENDING, which is the argued position above. A college whose
 *  academic regulations say a claim has no effect until determined sets
 *  pendingClaimSuppresses false in its prediction settings and gets the narrower set. It
 *  is a setting rather than a constant because it is a policy judgement wearing code, and
 *  hardcoding one reading of somebody else's regulations is the worse failure. */
const suppressing = (opts) => (opts && opts.pendingSuppresses === false ? APPROVED_ONLY : SUPPRESSING);

function buildCoverage(claims, opts) {
  const live = suppressing(opts);
  const byAssessment = new Map();
  const windows = [];

  for (const c of claims || []) {
    if (!c || !live.has(c.status)) continue;

    const adjustments = c.adjustments || [];
    if (adjustments.length) {
      for (const adj of adjustments) {
        if (!adj || !adj.assessmentId) continue;
        const existing = byAssessment.get(adj.assessmentId);
        // Most generous wins across overlapping claims, as above.
        if (!existing) { byAssessment.set(adj.assessmentId, adj); continue; }
        if (existing.adjustmentType === "exclusion") continue;
        if (adj.adjustmentType === "exclusion") { byAssessment.set(adj.assessmentId, adj); continue; }
        if ((adj.revisedDueDate || "") > (existing.revisedDueDate || "")) byAssessment.set(adj.assessmentId, adj);
      }
    } else if (c.coversFrom && c.coversTo) {
      windows.push({ coversFrom: c.coversFrom, coversTo: c.coversTo, status: c.status });
    }
  }

  return { byAssessment, windows };
}

/**
 * Sessions a claim covers, for the claims that opted in.
 *
 * OPT-IN PER CLAIM, never implied by a category. Suppressing attendance is a much
 * larger act than suppressing a submission count — it removes sessions from BOTH sides
 * of the percentage — so an extension on a deadline must not silently also excuse three
 * weeks of absence.
 *
 * AND IT NEVER REACHES THE PASTORAL SIGNALS. The caller keeps two lists: this filtered
 * one for the percentages, and the raw one for lastAttendedOn, lastEngagedOn, the
 * absence streak and every contact code. A student on approved mitigating circumstances
 * is one the college should be speaking to MORE, not one it should stop noticing — and
 * a sponsoring provider still has to evidence engagement, which those dates are what
 * answers.
 */
function attendanceCovered(mark, claims, opts) {
  if (!mark || !mark.date) return false;
  const live = suppressing(opts);
  for (const c of claims || []) {
    if (!c || !c.coversAttendance || !live.has(c.status)) continue;
    if (inWindow(mark.date, c.coversFrom, c.coversTo)) return true;
  }
  return false;
}

/** Does ANY live claim excuse attendance for this student?
 *
 *  Exists so the caller never has to ask which statuses count -- that question has one
 *  answer and it lives in this file. A copy of the status test in metrics.js would be a
 *  second place for the policy switch to be got wrong, and the two would drift.
 *
 *  Returns null for a student with NO CLAIMS AT ALL, which is not the same as false.
 *  "No claim covers attendance" is a finding; "this student has nothing on file" is the
 *  absence of one, and the column it feeds is nullable for exactly that reason. */
function coversAnyAttendance(claims, opts) {
  if (!claims || !claims.length) return null;
  const live = suppressing(opts);
  return claims.some((c) => c && c.coversAttendance && live.has(c.status));
}

module.exports = {
  effectiveDeadline, buildCoverage, attendanceCovered, coversAnyAttendance,
  STATE, SUPPRESSING, APPROVED_ONLY,
};
