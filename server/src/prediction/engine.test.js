// Tests for the progression-risk scoring engine.
//
// The engine is pure — no database, no clock, no tenant — so every rule a college
// would be asked to defend at an appeal is checkable here in milliseconds. That is
// the whole reason the arithmetic lives in its own file.
//
// These tests are written against the DEFAULT configuration unless a case says
// otherwise, because the defaults are what a college with no stored row runs on.
//
// Run with: node --test src/prediction/engine.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { score, GRADE_TREND, INTERVENTION_RESPONSE, DIRECTION } = require("./engine");
const { DEFAULTS } = require("./settings");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A student with every component measurable and every measurement perfect. */
const perfect = () => ({
  attendance: {
    overall: { pct: 100, marked: 30 },
    recent: { pct: 100, marked: 10 },
  },
  assessments: {
    submitted: 10,
    notSubmitted: 0,
    unknown: 0,
    onTime: 10,
    missing: 0,
    graded: [{ pct: 100 }, { pct: 100 }, { pct: 100 }, { pct: 100 }],
  },
  intervention: null,
  previous: null,
});

/** Deep-merge `patch` into a fresh `perfect()`; one level of nesting is enough here. */
function raw(patch = {}) {
  const base = perfect();
  for (const [k, v] of Object.entries(patch)) {
    base[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...base[k], ...v } : v;
  }
  return base;
}

/* -------------------------------------------------------------------------- */
/* 1) The weighted sum                                                         */
/* -------------------------------------------------------------------------- */

test("a student who is perfect on every component scores 100 and lands in the top band", () => {
  const r = score(perfect(), DEFAULTS);

  assert.equal(r.insufficientData, false);
  assert.equal(r.baseProgressionScore, 100);
  assert.equal(r.progressionScore, 100);
  assert.equal(r.riskLevel, "R1");
  assert.equal(r.overrideApplied, false);
});

test("each component is weighted, so a single weak component moves the score by its weight only", () => {
  // Average grade carries 0.25. Dropping it from 100 to 0 loses that 0.25 of the
  // model and nothing else — grade trend across four identical zeroes is Stable, so
  // no other component moves.
  //
  // The result is 73.7, not 75, and the difference is the point of renormalisation:
  // this student has never had an intervention, so that component (0.05) is not
  // measurable and is excluded from BOTH sides of the division. The score is
  // 70 / 0.95, i.e. "70 of the 95 available points", rather than 70 out of a
  // hundred points five of which nobody could ever have earned.
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 0 }, { pct: 0 }, { pct: 0 }, { pct: 0 }] } }), DEFAULTS);

  assert.equal(r.metrics.averageGrade, 0);
  assert.ok(Math.abs(r.availableWeight - 0.95) < 1e-9, `got ${r.availableWeight}`);
  assert.equal(r.baseProgressionScore, 73.7);
});

test("the score carries one decimal place, matching the attendance percentages it is built from", () => {
  const r = score(raw({ attendance: { overall: { pct: 83.3, marked: 6 }, recent: { pct: 83.3, marked: 6 } } }), DEFAULTS);

  // 0.2*83.3 + 0.15*83.3 = 29.155 -> the total must not carry more than one decimal.
  assert.equal(Math.round(r.baseProgressionScore * 10) / 10, r.baseProgressionScore, `got ${r.baseProgressionScore}`);
});

/* -------------------------------------------------------------------------- */
/* 2) Missing evidence — the case that must never invent a bad score           */
/* -------------------------------------------------------------------------- */

test("a component with no evidence is renormalised out, not scored as zero", () => {
  // No register has ever been taken for this student. Scoring attendance as 0 would
  // put them in Critical Risk for something nobody has measured.
  const r = score(raw({ attendance: { overall: { pct: null, marked: 0 }, recent: { pct: null, marked: 0 } } }), DEFAULTS);

  assert.equal(r.metrics.overallAttendance, null);
  assert.equal(r.metrics.recentAttendance, null);
  assert.equal(r.baseProgressionScore, 100, "the remaining components are all perfect, so the score must still be 100");
  assert.equal(r.riskLevel, "R1");
});

test("the weight actually used is reported, so a score resting on thin evidence is visible", () => {
  const r = score(raw({ attendance: { overall: { pct: null, marked: 0 }, recent: { pct: null, marked: 0 } } }), DEFAULTS);

  // Both attendance components are unmeasurable (0.2 + 0.15) and so is the response
  // to an intervention this student has never had (0.05): 1 - 0.4 = 0.6.
  assert.ok(Math.abs(r.availableWeight - 0.6) < 1e-9, `got ${r.availableWeight}`);
  assert.equal(r.riskDriverCodes.includes("LIMITED_EVIDENCE"), false, "0.6 is above the limited-evidence floor");
});

test("a student with nothing measurable at all is reported as insufficient data, not scored", () => {
  const r = score({
    attendance: { overall: { pct: null, marked: 0 }, recent: { pct: null, marked: 0 } },
    assessments: { submitted: 0, notSubmitted: 0, unknown: 0, onTime: 0, missing: 0, graded: [] },
    intervention: null,
    previous: null,
  }, DEFAULTS);

  assert.equal(r.insufficientData, true, "a student enrolled yesterday must not appear as Critical Risk");
  assert.equal(r.progressionScore, null);
  assert.equal(r.riskLevel, null);
});

test("a score resting on less than half the model is flagged LIMITED_EVIDENCE", () => {
  // Only attendance is measurable: 0.2 + 0.15 = 0.35 of the model.
  const r = score({
    attendance: { overall: { pct: 90, marked: 20 }, recent: { pct: 90, marked: 8 } },
    assessments: { submitted: 0, notSubmitted: 0, unknown: 0, onTime: 0, missing: 0, graded: [] },
    intervention: null,
    previous: null,
  }, DEFAULTS);

  assert.equal(r.insufficientData, false);
  assert.ok(r.riskDriverCodes.includes("LIMITED_EVIDENCE"), "staff must be told the score rests on partial evidence");
});

/* -------------------------------------------------------------------------- */
/* 3) Submission and on-time rates                                             */
/* -------------------------------------------------------------------------- */

test("unknown submissions are excluded from the denominator and never push a student toward risk", () => {
  // 8 submitted, 0 not submitted, 3 unknown. The rate is 8/8, not 8/11 — most
  // assessments here are LTI grade items for which Moodle reports nothing.
  const r = score(raw({ assessments: { ...perfect().assessments, submitted: 8, notSubmitted: 0, unknown: 3, onTime: 8 } }), DEFAULTS);

  assert.equal(r.metrics.submissionRate, 100);
});

test("the submission rate is submitted over submitted-plus-not-submitted", () => {
  const r = score(raw({ assessments: { ...perfect().assessments, submitted: 6, notSubmitted: 2, unknown: 5, onTime: 6 } }), DEFAULTS);
  assert.equal(r.metrics.submissionRate, 75);
});

test("the on-time rate is measured against what was submitted, not against everything due", () => {
  const r = score(raw({ assessments: { ...perfect().assessments, submitted: 8, notSubmitted: 2, unknown: 0, onTime: 4 } }), DEFAULTS);
  assert.equal(r.metrics.onTimeRate, 50);
});

/* -------------------------------------------------------------------------- */
/* 4) Grade trend                                                              */
/* -------------------------------------------------------------------------- */

test("a trend needs twice the configured assessment count before it exists at all", () => {
  // gradeTrendAssessmentCount is 2, so four graded pieces are needed. Three is not enough.
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 40 }, { pct: 50 }, { pct: 60 }] } }), DEFAULTS);
  assert.equal(r.gradeTrend, GRADE_TREND.INSUFFICIENT_DATA);
});

test("insufficient trend data is renormalised out rather than scored badly", () => {
  const withTrend = score(perfect(), DEFAULTS);
  const withoutTrend = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 100 }, { pct: 100 }, { pct: 100 }] } }), DEFAULTS);

  assert.equal(withoutTrend.gradeTrend, GRADE_TREND.INSUFFICIENT_DATA);
  assert.equal(withoutTrend.baseProgressionScore, withTrend.baseProgressionScore,
    "a student with too few grades to trend must score the same as one whose trend is fine");
});

test("the grade trend is measured across all marks, not only those inside the scored window", () => {
  // The average is a snapshot of the term being scored; the trend is the shape of
  // the student's whole record. Clipping the trend to the term would hide the one
  // thing it exists to catch — a collapse that began before the term did — and with
  // only two marks inside the window there would not even be enough for a trend.
  const r = score(raw({
    assessments: {
      ...perfect().assessments,
      graded: [{ pct: 40 }, { pct: 40 }],
      gradedForTrend: [{ pct: 90 }, { pct: 90 }, { pct: 40 }, { pct: 40 }],
    },
  }), DEFAULTS);

  assert.equal(r.metrics.averageGrade, 40, "the average covers the scored window only");
  assert.equal(r.gradeTrend, GRADE_TREND.DECLINING, "the trend reaches back across the term boundary");
});

test("without a separate trend list the scoped marks are used, so the caller may omit it", () => {
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 70 }, { pct: 70 }, { pct: 50 }, { pct: 50 }] } }), DEFAULTS);
  assert.equal(r.gradeTrend, GRADE_TREND.DECLINING);
});

test("grades rising by more than the threshold read as improving", () => {
  // Latest two average 70, previous two average 50: +20 points, well past the 5-point threshold.
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 50 }, { pct: 50 }, { pct: 70 }, { pct: 70 }] } }), DEFAULTS);
  assert.equal(r.gradeTrend, GRADE_TREND.IMPROVING);
});

test("grades falling by more than the threshold read as declining", () => {
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 70 }, { pct: 70 }, { pct: 50 }, { pct: 50 }] } }), DEFAULTS);
  assert.equal(r.gradeTrend, GRADE_TREND.DECLINING);
});

test("movement inside the threshold is stable, so ordinary variation is not reported as a trend", () => {
  // +3 points: real, but not a trend. Reporting it would cry wolf on every cohort.
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 60 }, { pct: 60 }, { pct: 63 }, { pct: 63 }] } }), DEFAULTS);
  assert.equal(r.gradeTrend, GRADE_TREND.STABLE);
});

/* -------------------------------------------------------------------------- */
/* 5) Intervention response                                                    */
/* -------------------------------------------------------------------------- */

test("a student nobody has intervened with has that component renormalised out, not scored", () => {
  const none = score(perfect(), DEFAULTS);
  assert.equal(none.interventionResponse, INTERVENTION_RESPONSE.NONE);
  assert.equal(none.baseProgressionScore, 100, "never having needed an intervention must not cost a student anything");
});

test("an intervention too recent to judge is not scored either way", () => {
  const r = score(raw({ intervention: { daysSince: 3, recentAttendanceAt: 20, submissionRateAt: 20, averageGradeAt: 20 } }), DEFAULTS);
  assert.equal(r.interventionResponse, INTERVENTION_RESPONSE.TOO_EARLY);
});

test("metrics better than they were at the intervention read as improved", () => {
  const r = score(raw({ intervention: { daysSince: 30, recentAttendanceAt: 40, submissionRateAt: 40, averageGradeAt: 40 } }), DEFAULTS);
  assert.equal(r.interventionResponse, INTERVENTION_RESPONSE.IMPROVED);
});

test("metrics worse than they were at the intervention read as declined", () => {
  const r = score(raw({
    attendance: { overall: { pct: 30, marked: 30 }, recent: { pct: 30, marked: 10 } },
    assessments: { submitted: 3, notSubmitted: 7, unknown: 0, onTime: 3, missing: 0, graded: [{ pct: 30 }, { pct: 30 }, { pct: 30 }, { pct: 30 }] },
    intervention: { daysSince: 30, recentAttendanceAt: 80, submissionRateAt: 80, averageGradeAt: 80 },
  }), DEFAULTS);
  assert.equal(r.interventionResponse, INTERVENTION_RESPONSE.DECLINED);
});

/* -------------------------------------------------------------------------- */
/* 6) Overrides                                                                */
/* -------------------------------------------------------------------------- */

test("OVR-001: enough missing assessments caps the band, however good the score", () => {
  const r = score(raw({ assessments: { ...perfect().assessments, missing: 2 } }), DEFAULTS);

  assert.equal(r.baseRiskLevel, "R1", "the arithmetic still says R1");
  assert.equal(r.riskLevel, "R3", "but two missing assessments cap the student at R3");
  assert.equal(r.overrideApplied, true);
  assert.ok(r.overrideCodes.includes("OVR-001"), r.overrideCodes.join(","));
});

test("OVR-002: recent attendance below the critical threshold caps the band at R4", () => {
  const r = score(raw({ attendance: { overall: { pct: 100, marked: 30 }, recent: { pct: 40, marked: 10 } } }), DEFAULTS);

  assert.ok(r.overrideCodes.includes("OVR-002"), r.overrideCodes.join(","));
  assert.equal(r.riskLevel, "R4");
});

test("OVR-003: an average below the pass threshold caps the band at R3", () => {
  // 35% average against a 40% pass mark, but everything else perfect.
  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 35 }, { pct: 35 }, { pct: 35 }, { pct: 35 }] } }), DEFAULTS);

  assert.ok(r.overrideCodes.includes("OVR-003"), r.overrideCodes.join(","));
  assert.equal(r.riskLevel, "R3");
});

test("OVR-004: reaching the red-indicator threshold worsens the band by one level", () => {
  // Three reds: low overall attendance, low recent attendance, low submission rate.
  const r = score(raw({
    attendance: { overall: { pct: 60, marked: 30 }, recent: { pct: 55, marked: 10 } },
    assessments: { ...perfect().assessments, submitted: 6, notSubmitted: 4, onTime: 6 },
  }), DEFAULTS);

  assert.equal(r.redIndicatorCount, 3, `reds: ${r.riskDriverCodes.join(",")}`);
  assert.ok(r.overrideCodes.includes("OVR-004"), r.overrideCodes.join(","));
});

test("an override can only ever worsen a band, never improve one", () => {
  // A student already in the worst band with every override firing must stay there
  // rather than being pulled UP to the band an override names as its cap.
  const r = score({
    attendance: { overall: { pct: 5, marked: 30 }, recent: { pct: 5, marked: 10 } },
    assessments: { submitted: 0, notSubmitted: 10, unknown: 0, onTime: 0, missing: 5, graded: [{ pct: 5 }, { pct: 5 }, { pct: 5 }, { pct: 5 }] },
    intervention: null,
    previous: null,
  }, DEFAULTS);

  assert.equal(r.riskLevel, "R5");
  assert.ok(r.overrideCodes.length >= 3, r.overrideCodes.join(","));
});

test("the reported score is pulled down to match an overridden band, so score and band never disagree", () => {
  const r = score(raw({ assessments: { ...perfect().assessments, missing: 2 } }), DEFAULTS);

  assert.equal(r.baseProgressionScore, 100);
  assert.equal(r.riskLevel, "R3");
  assert.ok(r.progressionScore <= 69.99, `a student shown as R3 must not carry an R1 score; got ${r.progressionScore}`);
});

test("the reported score always falls inside the band it is reported with", () => {
  // The invariant behind the test above, checked across every override combination
  // rather than one case. It is easy to break by rounding: R3's ceiling is 69.99 and
  // round-to-one-decimal turns that into 70.0, which is R2's opening score — so a
  // capped student would be handed back the band the override had just removed.
  const cases = [
    ["OVR-001 alone", raw({ assessments: { ...perfect().assessments, missing: 2 } })],
    ["OVR-002 alone", raw({ attendance: { overall: { pct: 100, marked: 30 }, recent: { pct: 40, marked: 10 } } })],
    ["OVR-003 alone", raw({ assessments: { ...perfect().assessments, graded: [{ pct: 35 }, { pct: 35 }, { pct: 35 }, { pct: 35 }] } })],
    ["everything at once", {
      attendance: { overall: { pct: 20, marked: 30 }, recent: { pct: 20, marked: 10 } },
      assessments: { submitted: 1, notSubmitted: 9, unknown: 0, onTime: 0, missing: 6, graded: [{ pct: 55 }, { pct: 55 }, { pct: 15 }, { pct: 15 }] },
      intervention: null,
      previous: null,
    }],
  ];

  for (const [name, input] of cases) {
    const r = score(input, DEFAULTS);
    const band = DEFAULTS.bands.find((b) => r.progressionScore >= b.min);
    assert.equal(band.key, r.riskLevel,
      `${name}: score ${r.progressionScore} reads as ${band.key} but the student is recorded as ${r.riskLevel}`);
  }
});

test("a band whose bounds fall between two decimal steps still gets a score inside it", () => {
  // The capped score is floored to a 0.1 grid, but nothing requires a college's band
  // bounds to sit on that grid — normaliseBands only probes one point 0.1 above each
  // band's ceiling, so a band spanning 50.05-50.07 validates. Flooring 50.07 gives
  // 50.0, which is BELOW that band's own floor and lands two bands lower. The student
  // is then stored as R3 carrying a score that reads as R5.
  const bands = [
    { key: "R1", label: "Top", min: 50.08, max: 100 },
    { key: "R3", label: "Middle", min: 50.05, max: 50.07 },
    { key: "R5", label: "Bottom", min: 0, max: 50.04 },
  ];
  const config = { ...DEFAULTS, bands, lowGradeBand: "R3", missingOverrideBand: "R3", criticalAttendanceBand: "R3", interventionBand: "R3" };

  const r = score(raw({ assessments: { ...perfect().assessments, graded: [{ pct: 35 }, { pct: 35 }, { pct: 35 }, { pct: 35 }] } }), config);

  assert.equal(r.riskLevel, "R3", "OVR-003 should cap this student at R3");
  const reads = bands.find((b) => r.progressionScore >= b.min);
  assert.equal(reads.key, r.riskLevel,
    `score ${r.progressionScore} reads as ${reads.key} but the student is recorded as ${r.riskLevel}`);
});

/* -------------------------------------------------------------------------- */
/* 7) Red indicators                                                           */
/* -------------------------------------------------------------------------- */

test("a student in no difficulty has no red indicators", () => {
  assert.equal(score(perfect(), DEFAULTS).redIndicatorCount, 0);
});

test("there are exactly six red indicators, so the configured threshold can always fire", () => {
  const r = score({
    attendance: { overall: { pct: 10, marked: 30 }, recent: { pct: 10, marked: 10 } },
    assessments: { submitted: 1, notSubmitted: 9, unknown: 0, onTime: 1, missing: 9, graded: [{ pct: 60 }, { pct: 60 }, { pct: 10 }, { pct: 10 }] },
    intervention: null,
    previous: null,
  }, DEFAULTS);

  assert.equal(r.redIndicatorCount, 6, `got: ${r.riskDriverCodes.join(",")}`);
});

/* -------------------------------------------------------------------------- */
/* 8) Direction of travel                                                      */
/* -------------------------------------------------------------------------- */

test("a student with no earlier score has no direction of travel yet", () => {
  assert.equal(score(perfect(), DEFAULTS).directionOfTravel, DIRECTION.NEW);
});

test("a score well above the earlier one is improving", () => {
  const r = score(raw({ previous: { progressionScore: 60 } }), DEFAULTS);
  assert.equal(r.directionOfTravel, DIRECTION.IMPROVING);
});

test("a score well below the earlier one is declining", () => {
  const r = score(raw({
    attendance: { overall: { pct: 40, marked: 30 }, recent: { pct: 40, marked: 10 } },
    previous: { progressionScore: 95 },
  }), DEFAULTS);
  assert.equal(r.directionOfTravel, DIRECTION.DECLINING);
});

test("a small movement is stable, so noise is not reported as a direction", () => {
  const r = score(raw({ previous: { progressionScore: 99 } }), DEFAULTS);
  assert.equal(r.directionOfTravel, DIRECTION.STABLE);
});

/* -------------------------------------------------------------------------- */
/* 9) Explaining the score                                                     */
/* -------------------------------------------------------------------------- */

test("the primary risk driver is the component costing the student the most score", () => {
  // Attendance is dreadful (weight 0.2, losing 0.2*90 = 18) while the grade average
  // is merely poor (weight 0.25, losing 0.25*40 = 10). Attendance is the bigger loss.
  const r = score(raw({
    attendance: { overall: { pct: 10, marked: 30 }, recent: { pct: 100, marked: 10 } },
    assessments: { ...perfect().assessments, graded: [{ pct: 60 }, { pct: 60 }, { pct: 60 }, { pct: 60 }] },
  }), DEFAULTS);

  assert.equal(r.primaryRiskDriver, "overallAttendance", `drivers: ${r.riskDriverCodes.join(",")}`);
});

test("a student in no difficulty has no primary risk driver and reports what is going well", () => {
  const r = score(perfect(), DEFAULTS);

  assert.equal(r.primaryRiskDriver, null);
  assert.ok(r.positiveDriverCodes.length > 0, "a perfect student must have something recorded in their favour");
});

test("intervention is required at and below the configured band, and not above it", () => {
  assert.equal(score(perfect(), DEFAULTS).interventionRequired, false);

  const atRisk = score(raw({ assessments: { ...perfect().assessments, missing: 2 } }), DEFAULTS);
  assert.equal(atRisk.riskLevel, "R3");
  assert.equal(atRisk.interventionRequired, true);
});

/* -------------------------------------------------------------------------- */
/* 10) The configuration is actually honoured                                  */
/* -------------------------------------------------------------------------- */

test("a college that weights attendance at zero is not scored on attendance", () => {
  const config = {
    ...DEFAULTS,
    weights: { ...DEFAULTS.weights, overallAttendance: 0, recentAttendance: 0, averageGrade: 0.6 },
  };
  const r = score(raw({ attendance: { overall: { pct: 0, marked: 30 }, recent: { pct: 100, marked: 10 } } }), config);

  assert.equal(r.baseProgressionScore, 100, "a zero-weighted component must not move the score");
});

test("a college with a higher pass mark gets OVR-003 firing for students a 40% mark would miss", () => {
  const config = { ...DEFAULTS, passThreshold: 50 };
  const marks = { ...perfect().assessments, graded: [{ pct: 45 }, { pct: 45 }, { pct: 45 }, { pct: 45 }] };

  assert.equal(score(raw({ assessments: marks }), DEFAULTS).overrideCodes.includes("OVR-003"), false);
  assert.equal(score(raw({ assessments: marks }), config).overrideCodes.includes("OVR-003"), true);
});

test("the engine stamps its own model version, so two rows scored by different code are distinguishable", () => {
  assert.equal(score(perfect(), DEFAULTS).modelVersion, DEFAULTS.modelVersion);
});
