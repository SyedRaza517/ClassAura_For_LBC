// The engine and the schema must agree about what "not measurable" looks like.
//
// WHY THIS FILE EXISTS
//
// The predictive-analysis feature shipped unable to score a single student, and every
// test passed. The engine correctly returns `null` for a component it could not
// measure — a grade trend with too few marks behind it, a response to an intervention
// that never happened — because the alternative is inventing a number. Two of the
// columns those values are written to were NOT NULL. So the first row a recalculation
// tried to write violated a constraint, the batch had no try/catch, and the endpoint
// answered 500 having scored nobody.
//
// Nothing caught it. The unit tests exercised the engine, which was right. The HTTP
// suite that would have written a row had never been run anywhere. The gap was not in
// either half — it was in the seam between them, and neither half could see it.
//
// So this file tests the SEAM, by parsing schema.prisma and comparing it against what
// the engine actually emits for a student in each of its awkward states. It needs no
// database, so it runs everywhere the unit tests do, and it fails the moment somebody
// adds a component that can be null to a column that cannot.
//
// Run with: node --test src/prediction/schema-contract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { score } = require("./engine");
const { DEFAULTS } = require("./settings");

/* -------------------------------------------------------------------------- */

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

/**
 * Which fields of a Prisma model accept null.
 *
 * Read from the schema text rather than from the generated client, because the schema
 * is the thing a person edits and therefore the thing a person gets wrong.
 */
function nullableFields(modelName) {
  const start = SCHEMA.indexOf(`model ${modelName} {`);
  assert.notEqual(start, -1, `model ${modelName} not found in schema.prisma`);
  const end = SCHEMA.indexOf("\n}", start);
  const body = SCHEMA.slice(start, end);

  const out = new Map();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}(\w+)\s+(\w+)(\?)?/);
    if (!m) continue;
    const [, field, , optional] = m;
    out.set(field, Boolean(optional));
  }
  return out;
}

/** The row shape runner.js builds from an engine result, minus the scope/bookkeeping
 *  fields it adds itself. Kept in one place so a new component has to appear here. */
const ENGINE_TO_COLUMN = {
  overallAttendance: (r) => r.metrics.overallAttendance,
  recentAttendance: (r) => r.metrics.recentAttendance,
  submissionRate: (r) => r.metrics.submissionRate,
  onTimeRate: (r) => r.metrics.onTimeRate,
  missingAssessmentCount: (r) => r.metrics.missingAssessmentCount,
  averageGrade: (r) => r.metrics.averageGrade,
  gradeTrend: (r) => r.gradeTrend,
  gradeTrendScore: (r) => r.gradeTrendScore,
  interventionResponse: (r) => r.interventionResponse,
  interventionResponseScore: (r) => r.interventionResponseScore,
  baseProgressionScore: (r) => r.baseProgressionScore,
  progressionScore: (r) => r.progressionScore,
  baseRiskLevel: (r) => r.baseRiskLevel,
  riskLevel: (r) => r.riskLevel,
  directionOfTravel: (r) => r.directionOfTravel,
  redIndicatorCount: (r) => r.redIndicatorCount,
  overrideApplied: (r) => r.overrideApplied,
  primaryRiskDriver: (r) => r.primaryRiskDriver,
  interventionRequired: (r) => r.interventionRequired,
  modelVersion: (r) => r.modelVersion,
};

/** The tripwire figures runner.js writes from the gather rather than from an engine
 *  result. Listed separately because they do not come off `score()` — but they are
 *  columns on both prediction tables and must obey the same nullability contract. */
const TRIPWIRE_COLUMNS = [
  "absenceStreak", "lastAttendedOn", "oldestUnmarkedDueDate", "attendanceSlope",
  "lastEngagedOn", "unexplainedShare", "latenessRate", "failCount", "nearFailCount",
  "gradeVolatility", "worstUnitId", "unitAttendanceSpread", "unpassedUnitCount",
  "attendanceRegularity", "lateSubmissionRate", "meanDaysLate", "weeksIntoProgramme",
  "assessmentsDueSoon", "gradedWithDates", "oldestOpenQueryOn", "openQueryCount", "overdueFollowUpCount",
  "weightedAverageGrade", "gradeWasWeighted", "markingLatencyDays", "firstSessionAbsenceRate", "laterSessionAbsenceRate",
  "openMitigationCount", "oldestOpenMitigationOn", "mitigatedAssessmentCount", "attendanceMitigated",
  "registerCoverageRate", "scheduledSessionCount", "markedSessionCount", "attendanceConfidence", "attendanceObservations", "lastRegisterMarkOn", "cohortAttendancePercentile", "cohortAttainmentPercentile", "cohortSize", "cohortStruggling",
  "vleLastAccessOn", "vleActiveDayRate", "vleObservedDays", "vleUnitsObserved",
  "peakFrom", "peakTo", "peakCount", "peakWeightShare", "peakWasWeighted", "undatedAssessments", "carriedBacklogCount", "fundingPosition", "fundingUnsettledSince", "fundingSettledOn", "fundingRefusedOn", "fundingApplications", "fundingNotApplied",
  "worstAbsenceWeekday", "worstWeekdayAbsenceRate", "weekdayAbsenceGap", "weekdaysMeasured", "worstAbsenceKind", "worstKindAbsenceRate", "kindAbsenceGap", "kindsMeasured", "unseenWeekRun", "unseenSinceWeekOn", "lastAttendedWeekOn", "longestUnseenWeekRun", "observedWeeks",
];

/**
 * Students in the states that actually occur, especially the unglamorous ones. The
 * first is the case that broke the feature: on day one it describes every student in
 * the college.
 */
const STUDENTS = {
  "an ordinary student — some attendance, no intervention, too few marks to trend": {
    attendance: { overall: { pct: 80, marked: 10 }, recent: { pct: 75, marked: 5 } },
    assessments: { submitted: 0, notSubmitted: 0, unknown: 0, onTime: 0, missing: 0, graded: [] },
    intervention: null,
    previous: null,
  },
  "a student with no register ever taken": {
    attendance: { overall: { pct: null, marked: 0 }, recent: { pct: null, marked: 0 } },
    assessments: { submitted: 4, notSubmitted: 0, unknown: 0, onTime: 4, missing: 0, graded: [{ pct: 70 }, { pct: 70 }, { pct: 60 }, { pct: 60 }] },
    intervention: null,
    previous: null,
  },
  "a student with an intervention too recent to judge": {
    attendance: { overall: { pct: 40, marked: 20 }, recent: { pct: 30, marked: 6 } },
    assessments: { submitted: 2, notSubmitted: 3, unknown: 1, onTime: 1, missing: 3, graded: [{ pct: 30 }, { pct: 25 }] },
    intervention: { daysSince: 2, recentAttendanceAt: 35, submissionRateAt: 40, averageGradeAt: 30 },
    previous: null,
  },
  "a student every override fires on": {
    attendance: { overall: { pct: 10, marked: 30 }, recent: { pct: 8, marked: 10 } },
    assessments: { submitted: 1, notSubmitted: 9, unknown: 0, onTime: 0, missing: 9, graded: [{ pct: 55 }, { pct: 55 }, { pct: 10 }, { pct: 10 }] },
    intervention: { daysSince: 40, recentAttendanceAt: 70, submissionRateAt: 80, averageGradeAt: 65 },
    previous: { progressionScore: 61 },
  },
};

/* -------------------------------------------------------------------------- */

test("every value the engine emits fits the column runner.js writes it to", () => {
  const current = nullableFields("StudentPredictionCurrent");
  const history = nullableFields("StudentPredictionHistory");

  for (const [description, input] of Object.entries(STUDENTS)) {
    const result = score(input, DEFAULTS);
    // An unscorable student is never written at all — the runner deletes the row
    // instead — so there is no contract to check.
    if (result.insufficientData) continue;

    for (const [column, read] of Object.entries(ENGINE_TO_COLUMN)) {
      const value = read(result);
      if (value !== null && value !== undefined) continue;

      assert.equal(current.get(column), true,
        `${description}: the engine produced null for "${column}", but StudentPredictionCurrent.${column} is NOT NULL — ` +
        `writing this student would throw and abort the whole batch`);
      assert.equal(history.get(column), true,
        `${description}: the engine produced null for "${column}", but StudentPredictionHistory.${column} is NOT NULL`);
    }
  }
});

test("the two tables agree with each other, so a score and its history cannot diverge", () => {
  const current = nullableFields("StudentPredictionCurrent");
  const history = nullableFields("StudentPredictionHistory");

  for (const column of Object.keys(ENGINE_TO_COLUMN)) {
    assert.equal(current.has(column), true, `StudentPredictionCurrent is missing "${column}"`);
    assert.equal(history.has(column), true, `StudentPredictionHistory is missing "${column}"`);
    assert.equal(current.get(column), history.get(column),
      `"${column}" is ${current.get(column) ? "nullable" : "NOT NULL"} on StudentPredictionCurrent but ` +
      `${history.get(column) ? "nullable" : "NOT NULL"} on StudentPredictionHistory — a row that can be written ` +
      `as the current score but not as history would half-succeed and lose the audit trail`);
  }
});

test("every tripwire column exists on both tables and accepts null", () => {
  // Each of these is genuinely unmeasurable for a real student — a register nobody
  // has taken gives no streak and no last-attended date. A NOT NULL column would
  // force runner.js to write a zero, and a zero here does not mean "no absences", it
  // means "we never looked": exactly the inversion this feature is built to avoid.
  const current = nullableFields("StudentPredictionCurrent");
  const history = nullableFields("StudentPredictionHistory");

  for (const column of TRIPWIRE_COLUMNS) {
    assert.equal(current.has(column), true, `StudentPredictionCurrent is missing "${column}"`);
    assert.equal(history.has(column), true, `StudentPredictionHistory is missing "${column}"`);
    assert.equal(current.get(column), true, `StudentPredictionCurrent.${column} is NOT NULL`);
    assert.equal(history.get(column), true, `StudentPredictionHistory.${column} is NOT NULL`);
  }
});

test("the intervention snapshot accepts the figures a never-scored student does not have", () => {
  // Staff may raise an intervention for a student the model has never scored — they
  // notice things it has no data for. Those columns must therefore accept null, or
  // the route is forced to invent a zero, and a zero baseline makes the student look
  // enormously improved at the next recalculation.
  const intervention = nullableFields("Intervention");

  for (const column of [
    "progressionScoreAtIntervention", "attendanceAtIntervention", "recentAttendanceAtIntervention",
    "submissionRateAtIntervention", "averageGradeAtIntervention",
  ]) {
    assert.equal(intervention.get(column), true,
      `Intervention.${column} is NOT NULL, so raising an intervention for an unscored student has to fabricate a figure`);
  }

  // Deliberately NOT nullable: the route writes the string "UNSCORED", which is a real
  // answer to "what did we think of them at the time" rather than a missing one.
  assert.equal(intervention.get("riskLevelAtIntervention"), false);
});

test("the institution probes destructure exactly as many names as they issue queries", () => {
  // THIS SEAM HAS PRODUCED THREE BUGS AND NO UNIT TEST CAUGHT ANY OF THEM.
  //
  // gather() opens with one Promise.all of institution-wide existence probes, and each
  // time a probe was added the destructuring on the left had to grow with it. Three
  // times it did not, and every one of the ~290 unit tests still passed — because none
  // of them calls gather(), which needs a database. The failure surfaced only when a
  // real recalculation threw "x is not defined", by which point it was in a commit.
  //
  // This reads the source rather than running it, exactly as the nullability tests
  // above read schema.prisma: the seam cannot be exercised without Postgres, but it
  // CAN be checked for internal consistency, and that is enough to catch the one
  // mistake that keeps being made.
  const METRICS = fs.readFileSync(path.join(__dirname, "metrics.js"), "utf8");

  const m = METRICS.match(/const \[([^\]]+)\] = await Promise\.all\(\[([\s\S]*?)\n {2}\]\);/);
  assert.ok(m, "could not find the institution-probe Promise.all in metrics.js");

  const names = m[1].split(",").map((x) => x.trim()).filter(Boolean);
  const calls = (m[2].match(/^\s+prisma\./gm) || []).length;

  assert.equal(names.length, calls,
    `${names.length} names destructured from ${calls} queries — a probe was added without ` +
    `a name, or a name without a probe. The unbound one is undefined at runtime and ` +
    `throws on the first real recalculation, which no unit test performs.`);
});

/* -------------------------------------------------------------------------- */
/* Health data must not reach the risk score                                   */
/* -------------------------------------------------------------------------- */

// A mitigating circumstance is usually Article 9 special category data: illness, mental
// health, bereavement, pregnancy, a caring responsibility. It is collected so a college
// can SUPPORT a student. Scoring it is a different processing purpose from the one it was
// collected for, and the separation is enforced in exactly one place — the select in
// metrics.js — which makes it exactly the kind of rule that is quietly widened later by
// somebody adding a field they happen to want on a screen.
//
// So it is asserted from the source text rather than trusted. The engine must know THAT a
// student has cover, never WHY.
test("the prediction pipeline never selects the reason for a mitigating circumstance", () => {
  const src = fs.readFileSync(path.join(__dirname, "metrics.js"), "utf8");

  // The claims select, isolated: from the model name to the closing of its call.
  const at = src.indexOf("prisma.mitigatingCircumstance.findMany");
  assert.notEqual(at, -1, "metrics.js no longer reads mitigating circumstances at all — if that is deliberate, delete this test deliberately too");
  const block = src.slice(at, src.indexOf("});", at));

  // Plain substring tests, deliberately. An earlier version of this used
  // new RegExp(`\b${name}\s*:`) inside a TEMPLATE LITERAL, where \b is the backspace
  // escape and \s is a bare "s" -- so it searched for a control character, matched
  // nothing, and every forbidden field passed. The test proved nothing and looked
  // thorough while doing it. The needed-fields half below is what exposed it, which is
  // why both halves are here.
  for (const forbidden of ["category:", "detail:"]) {
    assert.ok(
      !block.includes(forbidden),
      `metrics.js selects "${forbidden}" from MitigatingCircumstance. That is health data, ` +
      `collected for student support, and this select is the only thing keeping it out of a risk score.`
    );
  }

  // And the fields it MAY read are all present, so a refactor that silently drops the
  // window cannot leave the suppression looking as though it still works -- and so a
  // broken matcher here fails loudly instead of passing everything.
  for (const needed of ["status:", "coversFrom:", "coversTo:", "coversAttendance:"]) {
    assert.ok(block.includes(needed), `the claims select lost "${needed}"`);
  }
});
// The pure layer must never even be OFFERED the reason, so a future caller cannot pass a
// whole claim row through and have it quietly work.
test("adjustments.js reads nothing but the decision and the window", () => {
  const src = fs.readFileSync(path.join(__dirname, "adjustments.js"), "utf8");
  for (const forbidden of ["c.category", "c.detail", ".category", ".detail"]) {
    assert.ok(!src.includes(forbidden), `adjustments.js touches ${forbidden}`);
  }
});

/* -------------------------------------------------------------------------- */
/* One vocabulary, five files                                                  */
/* -------------------------------------------------------------------------- */

// Every TRIP_ code from every module lands in the SAME riskDriverCodes column, so staff
// read one list of reasons rather than five. Two consequences that nothing else checks:
//
//   1. A DUPLICATE STRING would make two different findings indistinguishable on the
//      screen, and the modules are written independently and cannot see each other.
//   2. THE PREFIX IS STRUCTURAL. OVR-004 worsens a band on redIndicatorCount, which
//      engine.js derives from its own internal reds array; riskDriverCodes is a copy
//      taken afterwards, so nothing appended can reach the override. A code named
//      RED_something would read as the engine own and invite a later reader to take the
//      count from the copy, silently wiring these layers into banding.
//
// Each module tests its own vocabulary. Nothing tested them TOGETHER, which is the only
// place a collision can exist.
test("the six tripwire vocabularies are disjoint and all TRIP_-prefixed", () => {
  const all = [
    ["tripwires", require("./tripwires").TRIP_CODES],
    ["coverage", require("./coverage").COVERAGE_CODES],
    ["cohort", require("./cohort").COHORT_CODES],
    ["workload", require("./workload").WORKLOAD_CODES],
    ["funding", require("./funding").FUNDING_CODES],
    ["sessions", require("./sessions").SESSIONS_CODES],
  ];

  const seen = new Map();
  for (const [name, codes] of all) {
    assert.ok(Array.isArray(codes) && codes.length, name + " exports no code vocabulary");
    for (const code of codes) {
      assert.ok(code.startsWith("TRIP_"), name + ' emits \"' + code + '\", which is not TRIP_-prefixed');
      assert.ok(!seen.has(code), code + " is emitted by both " + seen.get(code) + " and " + name);
      seen.set(code, name);
    }
  }
});
