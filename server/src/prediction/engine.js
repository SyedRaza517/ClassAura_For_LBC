// The progression-risk scoring engine: raw measurements in, a scored row out.
//
// PURE. No database, no clock, no tenant, no I/O. Everything it needs arrives in
// `raw`; everything it decides comes back as a plain object. That is deliberate:
// these rules are the part a college will be asked to defend when a student appeals
// a decision taken off the back of a risk level, and they have to be checkable
// without standing up an institution's worth of fixtures. See engine.test.js.
//
// The three ideas worth understanding before reading the code:
//
// 1. UNMEASURABLE IS NOT ZERO.
//    A student whose register has never been taken has no attendance percentage.
//    Scoring that as 0 would put them in Critical Risk for something nobody has
//    measured, and the college would go and intervene with a student who is fine.
//    So a component with no evidence is dropped from BOTH sides of the division —
//    the score becomes "70 of the 95 points that were actually available" rather
//    than "70 out of a hundred, five of which could never have been earned". A
//    student with nothing measurable at all is reported as insufficient data and
//    is not scored, rather than being handed a fabricated number.
//
// 2. THE OVERRIDES CAN ONLY EVER MAKE THINGS WORSE.
//    Every override is a floor on concern, not a verdict. A student the arithmetic
//    already places in the worst band stays there; an override never pulls anybody
//    UP into the band it names as its cap. Getting this backwards would take the
//    students in the most trouble and quietly improve their risk level.
//
// 3. THE SCORE AND THE BAND MUST NEVER DISAGREE.
//    When an override moves a student down a band, the reported score is pulled to
//    the top of that band with it. A record reading "R3 — High Risk (score 100)"
//    is one nobody can act on and everybody will distrust. `baseProgressionScore`
//    and `baseRiskLevel` keep the untouched arithmetic, so "the maths said R1 and a
//    rule pulled it to R3" stays visible and auditable.
const { bandForScore, DEFAULTS } = require("./settings");

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.gradeTrend and .interventionResponse, so these
// strings end up in the database and in history rows that outlive several rewrites
// of the screen. Structured codes, never display text — the client maps them to
// wording, and rewording must not orphan a single stored row.
const GRADE_TREND = {
  IMPROVING: "IMPROVING",
  STABLE: "STABLE",
  DECLINING: "DECLINING",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
};

const INTERVENTION_RESPONSE = {
  IMPROVED: "IMPROVED",
  NO_CHANGE: "NO_CHANGE",
  DECLINED: "DECLINED",
  TOO_EARLY: "TOO_EARLY",
  NONE: "NONE",
};

const DIRECTION = {
  IMPROVING: "IMPROVING",
  STABLE: "STABLE",
  DECLINING: "DECLINING",
  NEW: "NEW",
};

// The seven components, in the order they are presented to staff. The key is also
// the weight key in the configuration — settings.WEIGHT_KEYS is derived from the
// same list of names, so a component cannot exist here without a weight.
const COMPONENT_KEYS = [
  "overallAttendance",
  "recentAttendance",
  "submissionRate",
  "onTimeRate",
  "averageGrade",
  "gradeTrend",
  "interventionResponse",
];

// The six red indicators. Exactly six, because settings.validate caps
// redIndicatorThreshold at 6 on the grounds that a seventh does not exist — if one
// is ever added here, that ceiling has to move with it or the new indicator can
// never contribute to OVR-004 at the top of its range.
const RED = {
  LOW_OVERALL_ATTENDANCE: "RED_LOW_OVERALL_ATTENDANCE",
  LOW_RECENT_ATTENDANCE: "RED_LOW_RECENT_ATTENDANCE",
  LOW_SUBMISSION_RATE: "RED_LOW_SUBMISSION_RATE",
  MISSING_ASSESSMENTS: "RED_MISSING_ASSESSMENTS",
  LOW_AVERAGE_GRADE: "RED_LOW_AVERAGE_GRADE",
  DECLINING_GRADE_TREND: "RED_DECLINING_GRADE_TREND",
};
const RED_CODES = Object.values(RED);

/* -------------------------------------------------------------------------- */
/* Engine constants — properties of the code, not policy                      */
/* -------------------------------------------------------------------------- */

// What each grade trend is worth as a component score, 0-100.
//
// IMPROVING and STABLE are BOTH 100, and that is not an oversight. This component's
// job is to catch DECLINE — a student whose attainment is falling is at risk whatever
// their current average happens to be. How good that average is already carries its
// own weight (0.25, the largest of the seven), so paying a bonus for "improving" on
// top would score the same recovery twice: once as a rising average, once again as a
// rising trend. The component is a decline detector, and it is priced like one.
const GRADE_TREND_SCORE = {
  [GRADE_TREND.IMPROVING]: 100,
  [GRADE_TREND.STABLE]: 100,
  [GRADE_TREND.DECLINING]: 20,
};

// What each intervention response is worth. NO_CHANGE is a genuine mid-point rather
// than a neutral: somebody sat down with this student and nothing moved, which is a
// weaker position than never having needed the conversation.
const INTERVENTION_RESPONSE_SCORE = {
  [INTERVENTION_RESPONSE.IMPROVED]: 100,
  [INTERVENTION_RESPONSE.NO_CHANGE]: 50,
  [INTERVENTION_RESPONSE.DECLINED]: 10,
};

// Percentage points of movement, averaged across the metrics an intervention
// snapshotted, that count as having responded to it either way. Inside this, the
// student is NO_CHANGE. It is not configurable because it is the resolution of the
// comparison rather than a policy about students: below a few points the movement is
// register noise, and above it no college would read it differently.
const INTERVENTION_MOVEMENT = 5;

// Below this share of the model being measurable, the score is still produced but is
// flagged. Half is the point at which "this is their score" stops being a fair
// summary and becomes "this is their score on the half of it we could see" — an
// honest caveat staff can weigh, rather than a number that hides how thin it is.
const LIMITED_EVIDENCE_FLOOR = 0.5;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** One decimal place — the precision attendance.js works in, and the precision the
 *  band ladder is validated against (settings.SCORE_STEP). */
const round1 = (n) => Math.round(n * 10) / 10;

/** A percentage from a numerator and denominator, or null when nothing was counted. */
const pct = (n, d) => (d > 0 ? round1((n / d) * 100) : null);

const mean = (list) => (list.length ? list.reduce((t, n) => t + n, 0) / list.length : null);

/* -------------------------------------------------------------------------- */
/* 1) The measurements                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reduce the raw material to the six figures stored on the row.
 *
 * Every one of them may be null, and null means "not measurable", never "zero".
 */
function measure(rawIn) {
  const att = rawIn.attendance || {};
  const asm = rawIn.assessments || {};

  const overall = att.overall || {};
  const recent = att.recent || {};

  const submitted = Number(asm.submitted || 0);
  const notSubmitted = Number(asm.notSubmitted || 0);
  const onTime = Number(asm.onTime || 0);

  const clean = (list) => (Array.isArray(list) ? list.filter((g) => g && isNum(g.pct)) : []);

  const graded = clean(asm.graded);

  // The average is a snapshot of the window being scored; the trend is the shape of
  // the student's whole record, and metrics.js supplies it unclipped for exactly
  // that reason — a decline that started last term is the thing worth catching, and
  // clipping would hide it. Callers that have only one list (the tests, and anything
  // scoring an unscoped student) may omit it and the scoped marks are used instead.
  const gradedForTrend = asm.gradedForTrend === undefined ? graded : clean(asm.gradedForTrend);

  return {
    // Marked sessions only. An unmarked register is not an absence — see attendance.js.
    overallAttendance: overall.marked > 0 && isNum(overall.pct) ? overall.pct : null,
    recentAttendance: recent.marked > 0 && isNum(recent.pct) ? recent.pct : null,

    // "unknown" is excluded from the denominator entirely. Most assessments here are
    // LTI/Turnitin grade items for which Moodle reports no submission state at all,
    // and counting those as not-submitted would invent a missing-work problem for a
    // whole cohort. See the AssessmentSubmission note in the migration.
    submissionRate: pct(submitted, submitted + notSubmitted),

    // Measured against what was HANDED IN, not against everything due. Work never
    // submitted is already counted by submissionRate and by missingAssessmentCount;
    // letting it drag this component too would charge the student three times.
    onTimeRate: pct(onTime, submitted),

    missingAssessmentCount: Number(asm.missing || 0),

    averageGrade: graded.length ? round1(mean(graded.map((g) => g.pct))) : null,

    // Kept for the trend, which deliberately crosses term boundaries and so is not
    // built from the scoped figures above.
    _graded: gradedForTrend,
  };
}

/* -------------------------------------------------------------------------- */
/* 2) Grade trend                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The direction of a student's marks: the mean of their latest N against the mean of
 * the N before it, where N is the college's gradeTrendAssessmentCount.
 *
 * `graded` is oldest first. 2N marks are needed before a trend exists at all — with
 * fewer, the answer is INSUFFICIENT_DATA, which is renormalised out rather than
 * scored, because a student cannot be marked down for the college not having set
 * enough work yet.
 */
function gradeTrendOf(graded, config) {
  const n = config.gradeTrendAssessmentCount;
  if (graded.length < n * 2) return GRADE_TREND.INSUFFICIENT_DATA;

  const marks = graded.map((g) => g.pct);
  const latest = mean(marks.slice(-n));
  const previous = mean(marks.slice(-n * 2, -n));
  const delta = latest - previous;

  if (delta > config.gradeTrendThreshold) return GRADE_TREND.IMPROVING;
  if (delta < -config.gradeTrendThreshold) return GRADE_TREND.DECLINING;
  return GRADE_TREND.STABLE;
}

/* -------------------------------------------------------------------------- */
/* 3) Intervention response                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether the student is better or worse than they were when somebody stepped in.
 *
 * Compared against the metrics SNAPSHOTTED on the intervention rather than against
 * anything read back live, because the question is "were they worse when we
 * intervened than they are now?" — unanswerable if the baseline moves underneath it.
 *
 * A student with no intervention is NONE, and one whose intervention is younger than
 * the college's review window is TOO_EARLY. Both are renormalised out: never having
 * needed help, and not having had time to respond to it, are not failings.
 */
function interventionResponseOf(intervention, metrics, config) {
  if (!intervention) return INTERVENTION_RESPONSE.NONE;
  if (Number(intervention.daysSince || 0) < config.interventionReviewDays) return INTERVENTION_RESPONSE.TOO_EARLY;

  // Only the pairs where BOTH sides are known. A metric that was unmeasurable then,
  // or is unmeasurable now, says nothing about the direction of travel.
  const pairs = [
    [metrics.recentAttendance, intervention.recentAttendanceAt],
    [metrics.submissionRate, intervention.submissionRateAt],
    [metrics.averageGrade, intervention.averageGradeAt],
  ].filter(([now, then]) => isNum(now) && isNum(then));

  if (!pairs.length) return INTERVENTION_RESPONSE.TOO_EARLY;

  const movement = mean(pairs.map(([now, then]) => now - then));
  if (movement > INTERVENTION_MOVEMENT) return INTERVENTION_RESPONSE.IMPROVED;
  if (movement < -INTERVENTION_MOVEMENT) return INTERVENTION_RESPONSE.DECLINED;
  return INTERVENTION_RESPONSE.NO_CHANGE;
}

/* -------------------------------------------------------------------------- */
/* 4) The weighted sum                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Each component as { key, weight, score, available }.
 *
 * `available: false` means the college could not measure this, and the component is
 * excluded from both the numerator and the denominator of the weighted mean.
 */
function componentsOf(metrics, gradeTrend, interventionResponse, config) {
  const raw0to100 = {
    overallAttendance: metrics.overallAttendance,
    recentAttendance: metrics.recentAttendance,
    submissionRate: metrics.submissionRate,
    onTimeRate: metrics.onTimeRate,
    averageGrade: metrics.averageGrade,
    // A trend with too little behind it, and a response to an intervention that never
    // happened, are both "no evidence" rather than "a bad result".
    gradeTrend: GRADE_TREND_SCORE[gradeTrend] ?? null,
    interventionResponse: INTERVENTION_RESPONSE_SCORE[interventionResponse] ?? null,
  };

  return COMPONENT_KEYS.map((key) => ({
    key,
    weight: Number(config.weights[key] ?? 0),
    score: raw0to100[key],
    available: isNum(raw0to100[key]),
  }));
}

/* -------------------------------------------------------------------------- */
/* 5) Overrides                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Apply the four override rules to a band index.
 *
 * Bands are sorted best -> worst by settings.normaliseBands, so index 0 is the best
 * band and a HIGHER index is a worse one. "Cannot be better than X" is therefore
 * `Math.max(index, indexOf(X))` — which is also why an override can never improve a
 * band: max() only ever moves the index up.
 *
 * A code is recorded whenever a rule's CONDITION is met, not only when it moved the
 * student. "Two assessments are missing" is true of this student and belongs on
 * their record whether or not the arithmetic had already placed them that low —
 * otherwise the reason a student is where they are disappears the moment a second
 * rule agrees with the first.
 */
function applyOverrides(baseIndex, metrics, gradeTrend, redCount, config, bands) {
  const indexOfKey = (key) => bands.findIndex((b) => b.key === key);
  const codes = [];
  let index = baseIndex;

  // OVR-001 — enough assessments missing that the work cannot be made up quietly.
  if (metrics.missingAssessmentCount >= config.missingOverrideCount) {
    codes.push("OVR-001");
    const cap = indexOfKey(config.missingOverrideBand);
    if (cap >= 0) index = Math.max(index, cap);
  }

  // OVR-002 — the student has effectively stopped attending, whatever the history says.
  if (isNum(metrics.recentAttendance) && metrics.recentAttendance < config.criticalRecentAttendance) {
    codes.push("OVR-002");
    const cap = indexOfKey(config.criticalAttendanceBand);
    if (cap >= 0) index = Math.max(index, cap);
  }

  // OVR-003 — averaging below the mark the college requires to pass.
  if (isNum(metrics.averageGrade) && metrics.averageGrade < config.passThreshold) {
    codes.push("OVR-003");
    const cap = indexOfKey(config.lowGradeBand);
    if (cap >= 0) index = Math.max(index, cap);
  }

  // OVR-004 — breadth rather than depth: enough separate things are wrong at once
  // that the student's difficulty is not explained by any single component. Applied
  // LAST and to the already-capped index, so it compounds with the caps above rather
  // than competing with them, and clamped at the worst band.
  if (redCount >= config.redIndicatorThreshold) {
    codes.push("OVR-004");
    index = Math.min(index + 1, bands.length - 1);
  }

  return { index, codes };
}

/* -------------------------------------------------------------------------- */
/* 6) Red indicators                                                           */
/* -------------------------------------------------------------------------- */

/** Which of the six reds are showing. An unmeasurable figure never raises one. */
function redIndicatorsOf(metrics, gradeTrend, config) {
  const reds = [];

  if (isNum(metrics.overallAttendance) && metrics.overallAttendance < config.redAttendanceThreshold) reds.push(RED.LOW_OVERALL_ATTENDANCE);
  if (isNum(metrics.recentAttendance) && metrics.recentAttendance < config.redAttendanceThreshold) reds.push(RED.LOW_RECENT_ATTENDANCE);
  if (isNum(metrics.submissionRate) && metrics.submissionRate < config.redSubmissionThreshold) reds.push(RED.LOW_SUBMISSION_RATE);
  if (metrics.missingAssessmentCount >= config.missingOverrideCount) reds.push(RED.MISSING_ASSESSMENTS);
  if (isNum(metrics.averageGrade) && metrics.averageGrade < config.passThreshold) reds.push(RED.LOW_AVERAGE_GRADE);
  if (gradeTrend === GRADE_TREND.DECLINING) reds.push(RED.DECLINING_GRADE_TREND);

  return reds;
}

/* -------------------------------------------------------------------------- */
/* 7) Explaining the result                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The component costing this student the most score: the largest
 * `weight x (100 - score)` among the components that were actually measured.
 *
 * Weighted, not raw, because "worst percentage" is the wrong answer — a component
 * carrying 5% of the model can be at zero and matter less than a 25% component
 * sitting at 60. Staff act on this line, so it has to name the thing that would
 * recover the most ground.
 */
function primaryRiskDriverOf(components) {
  let best = null;
  for (const c of components) {
    if (!c.available || c.weight <= 0) continue;
    const lost = c.weight * (100 - c.score);
    if (lost <= 0) continue;
    if (!best || lost > best.lost) best = { key: c.key, lost };
  }
  return best ? best.key : null;
}

/** What is going well, worst-first being the risk list's job — this one is best-first. */
function positiveDriversOf(components, gradeTrend, interventionResponse) {
  const positives = components
    .filter((c) => c.available && c.weight > 0 && c.score >= 80)
    .sort((a, b) => b.score - a.score)
    .map((c) => `GOOD_${c.key.replace(/([A-Z])/g, "_$1").toUpperCase()}`);

  if (gradeTrend === GRADE_TREND.IMPROVING) positives.push("GOOD_IMPROVING_GRADES");
  if (interventionResponse === INTERVENTION_RESPONSE.IMPROVED) positives.push("GOOD_RESPONDED_TO_SUPPORT");

  return [...new Set(positives)];
}

/* -------------------------------------------------------------------------- */
/* 8) Direction of travel                                                      */
/* -------------------------------------------------------------------------- */

/**
 * This score against the nearest stored score roughly a month back.
 *
 * Compared on the FINAL score rather than the base, because the final score is what
 * was stored last time and what staff saw. Comparing a post-override score against a
 * pre-override one would report movement that never happened.
 */
function directionOf(current, previous, config) {
  if (!previous || !isNum(previous.progressionScore)) return DIRECTION.NEW;

  const delta = current - previous.progressionScore;
  if (delta > config.directionOfTravelThreshold) return DIRECTION.IMPROVING;
  if (delta < -config.directionOfTravelThreshold) return DIRECTION.DECLINING;
  return DIRECTION.STABLE;
}

/* -------------------------------------------------------------------------- */
/* 9) The whole thing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Score one student.
 *
 * @param {object} rawIn - measurements gathered by metrics.js:
 *        attendance: { overall: {pct, marked}, recent: {pct, marked} }
 *        assessments: { submitted, notSubmitted, unknown, onTime, missing, graded[] }
 *        intervention: null | { daysSince, recentAttendanceAt, submissionRateAt, averageGradeAt }
 *        previous: null | { progressionScore }
 * @param {object} config - a COMPLETE config from settings.get(); never a partial one.
 * @returns {object} the scored row, or { insufficientData: true } with null scores.
 */
function score(rawIn, config = DEFAULTS) {
  const bands = Array.isArray(config.bands) && config.bands.length ? config.bands : DEFAULTS.bands;

  const metrics = measure(rawIn);
  const gradeTrend = gradeTrendOf(metrics._graded, config);
  const interventionResponse = interventionResponseOf(rawIn.intervention, metrics, config);

  const components = componentsOf(metrics, gradeTrend, interventionResponse, config);

  // The weighted mean over what could be measured. Both sides of the division skip
  // the same components, so a zero-weighted component vanishes from the model
  // entirely rather than dragging the denominator.
  let numerator = 0;
  let availableWeight = 0;
  for (const c of components) {
    if (!c.available) continue;
    numerator += c.weight * c.score;
    availableWeight += c.weight;
  }

  const out = {
    metrics: {
      overallAttendance: metrics.overallAttendance,
      recentAttendance: metrics.recentAttendance,
      submissionRate: metrics.submissionRate,
      onTimeRate: metrics.onTimeRate,
      missingAssessmentCount: metrics.missingAssessmentCount,
      averageGrade: metrics.averageGrade,
    },
    components,
    availableWeight,
    gradeTrend,
    gradeTrendScore: GRADE_TREND_SCORE[gradeTrend] ?? null,
    interventionResponse,
    interventionResponseScore: INTERVENTION_RESPONSE_SCORE[interventionResponse] ?? null,
    modelVersion: config.modelVersion || DEFAULTS.modelVersion,
  };

  // NOTHING was measurable. A student enrolled yesterday, with no register taken and
  // no work set, must not appear anywhere on a risk list — so they are not scored at
  // all, and the runner writes no row for them. A fabricated 0 here would put the
  // newest students at the top of every "Critical Risk" screen in the college.
  if (availableWeight <= 0) {
    return {
      ...out,
      insufficientData: true,
      baseProgressionScore: null,
      progressionScore: null,
      baseRiskLevel: null,
      riskLevel: null,
      directionOfTravel: DIRECTION.NEW,
      redIndicatorCount: 0,
      overrideApplied: false,
      overrideCodes: [],
      riskDriverCodes: ["NO_EVIDENCE"],
      positiveDriverCodes: [],
      primaryRiskDriver: null,
      interventionRequired: false,
    };
  }

  const baseProgressionScore = round1(numerator / availableWeight);
  const baseBand = bandForScore(baseProgressionScore, bands);
  const baseIndex = bands.indexOf(baseBand);

  const reds = redIndicatorsOf(metrics, gradeTrend, config);
  const { index: finalIndex, codes: overrideCodes } = applyOverrides(
    baseIndex, metrics, gradeTrend, reds.length, config, bands
  );
  const finalBand = bands[finalIndex];

  // The score follows the band down. Without this a student can be shown as High
  // Risk carrying a score that reads as Likely to Progress, and no member of staff
  // will believe either number again.
  //
  // FLOORED to one decimal, never rounded. The default ladder puts R3's ceiling at
  // 69.99, and round1(69.99) is 70.0 — which is R2's opening score, so rounding the
  // capped figure would hand the student back the exact band the override had just
  // taken off them. Flooring keeps the score inside the band it was capped to.
  // CLAMPED INTO the band, not merely down to its ceiling.
  //
  // Flooring alone assumes a multiple of 0.1 exists inside every band, and nothing
  // guarantees that: normaliseBands only checks that no REAL score can fall between
  // two bands, so a college may legitimately define one spanning 50.05 to 50.07.
  // Flooring 50.07 gives 50.0, which is below that band's own floor and reads as a
  // band two rungs lower — the student is stored as R3 carrying a score that reads as
  // R5, which is precisely the disagreement this whole step exists to prevent. Taking
  // the max with the band's own minimum keeps the score inside the band it was capped
  // to, whatever bounds the college chose.
  const ceiling = Math.max(finalBand.min, Math.floor(finalBand.max * 10) / 10);
  const progressionScore = finalIndex > baseIndex
    ? Math.min(baseProgressionScore, ceiling)
    : baseProgressionScore;

  const riskDriverCodes = [...reds];
  if (availableWeight < LIMITED_EVIDENCE_FLOOR) riskDriverCodes.push("LIMITED_EVIDENCE");

  const interventionIndex = bands.findIndex((b) => b.key === config.interventionBand);

  return {
    ...out,
    insufficientData: false,
    baseProgressionScore,
    progressionScore,
    baseRiskLevel: baseBand ? baseBand.key : null,
    riskLevel: finalBand ? finalBand.key : null,
    directionOfTravel: directionOf(progressionScore, rawIn.previous, config),
    redIndicatorCount: reds.length,
    overrideApplied: finalIndex !== baseIndex,
    overrideCodes,
    riskDriverCodes,
    positiveDriverCodes: positiveDriversOf(components, gradeTrend, interventionResponse),
    primaryRiskDriver: primaryRiskDriverOf(components),
    // At or below the configured band. Index counts from the best band downwards, so
    // "at or below R3" is index >= indexOf(R3).
    interventionRequired: interventionIndex >= 0 && finalIndex >= interventionIndex,
  };
}

module.exports = {
  score,
  GRADE_TREND,
  INTERVENTION_RESPONSE,
  DIRECTION,
  RED,
  RED_CODES,
  COMPONENT_KEYS,
  LIMITED_EVIDENCE_FLOOR,
};
