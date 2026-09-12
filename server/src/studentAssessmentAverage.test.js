// weightedAveragePct — pure. Extracted out of routes/student.js's GET /me/assessments
// (task-5 brief) so "a college with no weights set produces a byte-identical average
// to today's plain mean" is an assertion, not a claim.
//
// Run with: node --test src/studentAssessmentAverage.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { weightedAveragePct, effectiveWeight } = require("./studentAssessmentAverage");

test("no graded items: null, matching the route's existing `n ? … : null`", () => {
  assert.equal(weightedAveragePct([]), null);
  assert.equal(weightedAveragePct([{ pct: null, weight: 50 }]), null);
});

test("NO-WEIGHTS dataset is BYTE-IDENTICAL to the plain (unweighted) mean the route used before", () => {
  // Assessment.weight defaults to 0 (schema.prisma) and the Moodle importer never
  // sets it — this is the ordinary shape of a college's data, not an edge case.
  const items = [{ pct: 70, weight: 0 }, { pct: 85, weight: 0 }, { pct: 90.5, weight: 0 }];
  const plainMean = Math.round(((70 + 85 + 90.5) / 3) * 10) / 10;
  assert.equal(weightedAveragePct(items), plainMean);
});

test("NO-WEIGHTS dataset with weight entirely absent (undefined/null) is also byte-identical to the plain mean", () => {
  const items = [{ pct: 42.3 }, { pct: 100, weight: null }, { pct: 0, weight: undefined }];
  const plainMean = Math.round(((42.3 + 100 + 0) / 3) * 10) / 10;
  assert.equal(weightedAveragePct(items), plainMean);
});

test("a real, staff-set weight is used when present", () => {
  // One assessment worth 3x another: (80*30 + 40*10) / 40 = 70
  const items = [{ pct: 80, weight: 30 }, { pct: 40, weight: 10 }];
  assert.equal(weightedAveragePct(items), 70);
});

test("missing or invalid weight counts as 1, alongside a real weight on other items", () => {
  // One weighted item (weight 4) and one with no weight at all (counts as 1):
  // (100*4 + 50*1) / 5 = 90
  const items = [{ pct: 100, weight: 4 }, { pct: 50, weight: undefined }];
  assert.equal(weightedAveragePct(items), 90);
});

test("a negative or NaN weight is treated as invalid (folds to 1), never as a real negative weight", () => {
  const items = [{ pct: 60, weight: -5 }, { pct: 60, weight: "not a number" }];
  // Both fold to weight 1 -> plain mean of the two.
  assert.equal(weightedAveragePct(items), 60);
});

test("an ungraded assessment (pct null) is skipped entirely, weight and all", () => {
  const items = [{ pct: 80, weight: 10 }, { pct: null, weight: 999 }];
  assert.equal(weightedAveragePct(items), 80);
});

test("result is rounded to one decimal place, matching the route's existing rounding", () => {
  const items = [{ pct: 1, weight: 1 }, { pct: 2, weight: 1 }, { pct: 2, weight: 1 }];
  // mean = 1.666... -> 1.7
  assert.equal(weightedAveragePct(items), 1.7);
});

test("effectiveWeight: 0, negative, NaN, null and undefined all fold to 1; a positive number passes through", () => {
  assert.equal(effectiveWeight(0), 1);
  assert.equal(effectiveWeight(-3), 1);
  assert.equal(effectiveWeight(NaN), 1);
  assert.equal(effectiveWeight(null), 1);
  assert.equal(effectiveWeight(undefined), 1);
  assert.equal(effectiveWeight("abc"), 1);
  assert.equal(effectiveWeight(25), 25);
});
