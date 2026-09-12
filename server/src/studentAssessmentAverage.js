"use strict";

/**
 * studentAssessmentAverage.js
 *
 * PURE. Extracted out of routes/student.js's GET /me/assessments (task-5 brief) so
 * "a college with no weights set must produce byte-identical averages to today" is
 * an assertion in a unit test rather than something trusted by eye in a route body.
 *
 * WHY 0, AND EVERY OTHER NON-POSITIVE OR NON-NUMERIC WEIGHT, COUNT AS "NO WEIGHT" —
 * NEVER AS A REAL WEIGHT OF ZERO. schema.prisma: `Assessment.weight Int @default(0)
 * // percentage weighting toward the unit (0 = unset)`, and the prediction schema's
 * own comment on weightedAverageGrade says the Moodle importer never sets it either
 * — so at an ordinary college every assessment carries a literal 0. Treating that as
 * a genuine weight of zero would make every college's average a division by a
 * weight-sum of zero (NaN) the moment this shipped, in place of the plain mean the
 * screen has shown since before weighting existed. So "missing or invalid"
 * (undefined, null, NaN, <= 0) folds to 1 — equal weighting, arithmetically
 * identical to no weighting at all — and only a STAFF-SET positive weight ever tips
 * the balance away from that.
 *
 * THIS IS A DIFFERENT RULE FROM prediction/tripwires.js's weightedGrade(), ON
 * PURPOSE, not an oversight. That function DROPS every zero-weight item once ANY
 * item in the set carries a real weight — correct for a staff-facing risk signal
 * that wants to say "this figure only reflects the pieces someone actually
 * weighted", and it is explicitly a signal the prediction feature must never hand a
 * student anyway (constraints.md: predictions never reach students). A student's OWN
 * average has no such licence to quietly discard a piece of their own graded work:
 * every graded assessment counts here, weighted if the college set a weight and
 * evenly if it did not — which is also why this lives beside the ROUTE rather than
 * importing from prediction/tripwires.js: the two answer different questions and
 * sharing one function would make a future edit to one silently change the other.
 */

/** A weight as it actually counts: the value itself if it is a real positive number, else 1. */
function effectiveWeight(weight) {
  const n = Number(weight);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * `items`: `[{ pct, weight }]`, one per assessment. An item with no numeric `pct`
 * (ungraded — nothing to weigh in) is skipped entirely, weight and all. Returns
 * `null` when nothing is graded, matching the route's existing `n ? … : null`.
 */
function weightedAveragePct(items) {
  const graded = (items || []).filter((it) => it && typeof it.pct === "number" && Number.isFinite(it.pct));
  if (!graded.length) return null;

  let sumWeight = 0;
  let sumWeighted = 0;
  for (const it of graded) {
    const w = effectiveWeight(it.weight);
    sumWeight += w;
    sumWeighted += it.pct * w;
  }
  // Same rounding the route already applied to the plain mean — one decimal place.
  return Math.round((sumWeighted / sumWeight) * 10) / 10;
}

module.exports = { weightedAveragePct, effectiveWeight };
