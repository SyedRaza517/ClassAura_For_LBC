// Tests for the prediction settings resolver.
//
// These cover the four failures that are DANGEROUS BECAUSE THEY ARE SILENT: a
// configuration that is wrong in any of these ways produces no error at runtime, it
// produces a whole cohort scored against a policy nobody chose. There is no database
// here — validate() is pure, and get() answers from the defaults when there is no
// tenant context (see db.js), which is the same path a college with no stored row
// takes.
//
// Run with: node --test   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("./settings");
const { DEFAULTS, validate } = settings;

/** The defaults with `patch` applied on top — the shape a real save arrives in. */
const withWeights = (patch) => ({ weights: { ...DEFAULTS.weights, ...patch } });

test("the platform defaults are themselves a valid configuration", () => {
  const result = validate(DEFAULTS);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.config, DEFAULTS);
});

test("weights that do not sum to 1 are rejected, and the message names the actual sum", () => {
  // 0.25 -> 0.15 on average grade: the seven now total 0.9. Nothing about this is
  // visible at runtime — every student simply scores 10% lower than they should.
  const result = validate(withWeights({ averageGrade: 0.15 }));

  assert.equal(result.ok, false, "weights totalling 0.9 must not be accepted");
  assert.match(result.error, /0\.9 \(90%\)/, `the error must name the actual sum; got: ${result.error}`);
  assert.match(result.error, /must total 1/);
});

test("weights that sum above 1 are rejected too", () => {
  const result = validate(withWeights({ averageGrade: 0.45 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /1\.2 \(120%\)/, result.error);
});

test("floating point does not reject a set that genuinely totals 1", () => {
  // The point of the epsilon in validate(): a weight set an administrator entered as
  // 70/5/5/5/5/5/5 sums to 1.0000000000000002 in IEEE 754, and an exact `=== 1` would
  // refuse it with a message saying the weights total 100%.
  //
  // The platform defaults are NOT such a set — 0.2 + 0.15 + 0.15 + 0.1 + 0.25 + 0.1 +
  // 0.05 sums to exactly 1 in this order — so this test carries its own, and asserts
  // that first. An earlier version of this test asserted the opposite about the
  // defaults and failed on its own premise rather than on anything validate() did.
  const weights = { ...DEFAULTS.weights };
  const keys = Object.keys(weights);
  keys.forEach((k, i) => { weights[k] = i === 0 ? 0.7 : 0.05; });

  const sum = Object.values(weights).reduce((t, n) => t + n, 0);
  assert.notEqual(sum, 1, "this test is pointless unless the set genuinely misses 1");
  assert.ok(Math.abs(sum - 1) < 1e-9, `the set must miss by a rounding error, not a real amount; got ${sum}`);

  assert.equal(validate({ weights }).ok, true, "a set that misses 1 by one ulp must be accepted");
});

test("the platform defaults sum to exactly 1, and are accepted", () => {
  const sum = Object.values(DEFAULTS.weights).reduce((t, n) => t + n, 0);
  assert.equal(sum, 1);
  assert.equal(validate(DEFAULTS).ok, true);
});

test("overlapping bands are rejected", () => {
  // R2 stretched from 84.99 up to 90: a student on 87 now matches both R1 and R2,
  // and which risk level they get depends on the order of the array.
  const bands = DEFAULTS.bands.map((b) => (b.key === "R2" ? { ...b, max: 90 } : b));
  const result = validate({ bands });

  assert.equal(result.ok, false, "an overlapping ladder must not be accepted");
  assert.match(result.error, /overlaps/, result.error);
  assert.match(result.error, /Likely to Progress/, result.error);
});

test("a gap in the bands is rejected and the message names an orphaned score", () => {
  // R2 stops at 80 while R1 starts at 85. A student on 80.1 lands in no band at all,
  // gets no risk level, and is skipped by every action the score should trigger.
  const bands = DEFAULTS.bands.map((b) => (b.key === "R2" ? { ...b, max: 80 } : b));
  const result = validate({ bands });

  assert.equal(result.ok, false);
  assert.match(result.error, /gap/, result.error);
  assert.match(result.error, /80\.1/, result.error);
});

test("bands that do not reach 0 or 100 are rejected", () => {
  const short = DEFAULTS.bands.map((b) => (b.key === "R5" ? { ...b, min: 10 } : b));
  assert.match(validate({ bands: short }).error, /must cover 0/);

  const capped = DEFAULTS.bands.map((b) => (b.key === "R1" ? { ...b, max: 99 } : b));
  assert.match(validate({ bands: capped }).error, /must cover 100/);
});

test("a band list in the wrong order is sorted best -> worst rather than trusted", () => {
  const shuffled = [...DEFAULTS.bands].reverse();
  const result = validate({ bands: shuffled });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.config.bands.map((b) => b.key), ["R1", "R2", "R3", "R4", "R5"]);
});

test("an unknown scope is rejected", () => {
  const result = validate({ scope: "whole-course" });

  assert.equal(result.ok, false, '"whole-course" is not a scope this engine implements');
  assert.match(result.error, /whole-course/, result.error);
  assert.match(result.error, /current-term/, result.error);
});

test("an unknown attendance mode is rejected", () => {
  assert.match(validate({ attendanceMode: "percentage" }).error, /percentage/);
});

test("unknown keys are rejected rather than stored silently", () => {
  // The failure mode this prevents: the save succeeds, the administrator believes
  // the setting is live, and nothing anywhere reads it.
  const result = validate({ passMark: 50 });

  assert.equal(result.ok, false);
  assert.match(result.error, /passMark/, result.error);

  const badWeight = validate({ weights: { ...DEFAULTS.weights, punctuality: 0 } });
  assert.equal(badWeight.ok, false);
  assert.match(badWeight.error, /punctuality/, badWeight.error);
});

test("out-of-range scalars are rejected", () => {
  assert.match(validate({ recentAttendanceDays: 0 }).error, /between 1 and 365/);
  assert.match(validate({ recentAttendanceDays: 400 }).error, /between 1 and 365/);
  assert.match(validate({ passThreshold: 101 }).error, /between 0 and 100/);
  assert.match(validate({ recentAttendanceDays: 28.5 }).error, /whole number/);
  // There are exactly six red indicators, so a threshold of 7 could never fire.
  assert.match(validate({ redIndicatorThreshold: 7 }).error, /between 1 and 6/);
});

test("an empty stored config resolves to the defaults, unchanged", () => {
  // This is what a college that has never opened the settings screen is running on,
  // and what get() falls back to when a stored row turns out to be unusable.
  const result = validate({});

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.config, DEFAULTS);
  assert.deepEqual(validate(null).config, DEFAULTS);
});

test("a partial config is merged over the defaults, not stored on its own", () => {
  const result = validate({ passThreshold: 50 });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.config.passThreshold, 50);
  assert.equal(result.config.recentAttendanceDays, DEFAULTS.recentAttendanceDays);
  assert.deepEqual(result.config.weights, DEFAULTS.weights);
  assert.deepEqual(result.config.bands, DEFAULTS.bands);
});

test("modelVersion always comes from the code, never from the stored row", () => {
  // It identifies the ENGINE, not the college's policy. A stored value would win the
  // merge and go on stamping a version string that no longer describes the code.
  const result = validate({ modelVersion: "PROG-0.1-someones-experiment" });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.config.modelVersion, DEFAULTS.modelVersion);
});

test("get() with no tenant context returns the defaults without touching the database", async () => {
  const config = await settings.get();
  assert.deepEqual(config, DEFAULTS);

  // A clone, not the shared object: a caller that edits what it was handed must not
  // be able to change the policy every other college falls back to.
  config.passThreshold = 99;
  assert.equal(DEFAULTS.passThreshold, 40);
});

test("bandForScore matches on the lower bound, so one-decimal scores always land", () => {
  const b = (score) => settings.bandForScore(score, DEFAULTS.bands).key;

  assert.equal(b(100), "R1");
  assert.equal(b(85), "R1");
  // The value an inclusive min/max test would drop on the floor: above R2's stated
  // max of 84.99 and below R1's min of 85.
  assert.equal(b(84.995), "R2");
  assert.equal(b(84.9), "R2");
  assert.equal(b(55), "R3");
  assert.equal(b(54.99), "R4");
  assert.equal(b(0), "R5");
  assert.equal(settings.bandForScore(null, DEFAULTS.bands), null);
});
