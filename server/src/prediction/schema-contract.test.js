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
