// Tests for the cohort layer: where a student stands relative to their peers, and what
// that is — and is not — allowed to change.
//
// No database. cohort.js is pure: every population arrives as an argument.
//
// Weighted towards NEGATIVE assertions on purpose, because almost every way this feature
// can fail is a way it produces a plausible number instead of nothing:
//
//   * what does NOT fire (below average is not a risk; the top of the cohort is never an
//     outlier; a tight cohort has no outliers at all)
//   * what returns NULL (a student with no figure, a cohort too small, a cohort too flat)
//   * what is REFUSED (a population of one — the incremental path handing over its own
//     stale set — buys nothing, not a 50th percentile)
//
// Run with: node --test src/prediction/cohort.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  percentile, standing, cohortShape, evaluate,
  COHORT, COHORT_CODES,
  MIN_COHORT_SIZE, OUTLIER_PERCENTILE, OUTLIER_MIN_GAP, MIN_COHORT_SPREAD,
} = require("./cohort");
const { DEFAULTS } = require("./settings");

/** `n` students all sitting on the same figure. */
const flat = (n, v) => Array.from({ length: n }, () => v);

/** 1..12 — twelve measurable values, the smallest cohort this file will describe. */
const TWELVE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// A real-shaped cohort: wide, twelve students, mean exactly 70.
const WIDE = [30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 95, 100];

// Twelve students inside eleven points, one of whom is at the bottom. Spread clears the
// floor (sd ~2.7) so this cohort IS describable — which is what makes it the test for the
// gap rule rather than the spread rule.
const TIGHT = [80, 86, 86, 87, 87, 88, 88, 88, 89, 89, 90, 91];

/* -------------------------------------------------------------------------- */
/* The constants are named, not magic                                          */
/* -------------------------------------------------------------------------- */

test("the floors are exported constants, so a change to one is visible in a diff", () => {
  // Not decoration. Each of these is a policy decision argued at length in the module, and
  // a future reader tuning one should have to touch a named constant with the argument
  // attached rather than a number buried in an expression.
  assert.equal(typeof MIN_COHORT_SIZE, "number");
  assert.equal(typeof OUTLIER_PERCENTILE, "number");
  assert.equal(typeof OUTLIER_MIN_GAP, "number");
  assert.equal(typeof MIN_COHORT_SPREAD, "number");

  // A decile is not a decile below ten people, so the size floor cannot be under ten
  // whatever else it is set to.
  assert.ok(MIN_COHORT_SIZE >= 10, "a bottom decile needs at least ten students in it");
  // Below average is half the cohort by definition. Anything at or above 50 here would
  // make this feature a phone book.
  assert.ok(OUTLIER_PERCENTILE <= 25, "the bottom quartile is still a quarter of a college");
});

/* -------------------------------------------------------------------------- */
/* percentile — where a value sits                                             */
/* -------------------------------------------------------------------------- */

test("a percentile is the share below plus half the share equal", () => {
  // Midrank. Of the three conventions in use this is the only one that survives ties,
  // which are everywhere in this data — attendance percentages off short registers land
  // on the same handful of values.
  assert.equal(percentile(1, TWELVE), 4.2);    // (0 + 0.5) / 12
  assert.equal(percentile(6, TWELVE), 45.8);   // (5 + 0.5) / 12
  assert.equal(percentile(12, TWELVE), 95.8);  // (11 + 0.5) / 12
});

test("a value that is not itself in the population is still placed", () => {
  assert.equal(percentile(6.5, TWELVE), 50);   // six below, none equal
});

test("a cohort where EVERYBODY has the same value gives 50, not 0 and not 100", () => {
  // The degenerate case, and the two rejected conventions disagree here in opposite and
  // equally silly directions: "strictly below" says every student is in the bottom 0% of
  // their own cohort, "below or equal" says all of them are top of it — and that second
  // one reads as reassurance, which is how it would get shipped.
  //
  // 50 is the true answer: they are indistinguishable from the middle because they ARE
  // the middle. (cohortShape then refuses to rank inside such a cohort at all — see the
  // spread tests — but the arithmetic underneath must not be lying while it does so.)
  assert.equal(percentile(70, flat(12, 70)), 50);
});

test("a student with no figure has NO percentile, not the 0th", () => {
  // The whole null-is-not-zero rule, laundered through a comparison. A student whose
  // register was never taken placed at the 0th percentile is bottom of the cohort on the
  // strength of something nobody measured — and unlike a bare 0 it arrives looking like
  // evidence, because a percentile sounds like the output of a calculation.
  assert.equal(percentile(null, TWELVE), null);
  assert.equal(percentile(undefined, TWELVE), null);
  assert.equal(percentile(NaN, TWELVE), null);
});

test("nulls in the population leave BOTH sides — they are not zeros and not denominators", () => {
  // Twelve measurable students and eight who have never been marked. The answer must be
  // identical to the answer for the twelve alone.
  //
  // If the nulls were coerced to 0 and kept, the worst measurable student would read as
  // 42.5 — comfortably mid-table — because eight phantom students would be sitting below
  // them. This is the single most dangerous coercion available in this file.
  const withNulls = [...TWELVE, null, null, null, null, null, null, null, null];
  assert.equal(percentile(1, withNulls), percentile(1, TWELVE));
  assert.equal(percentile(1, withNulls), 4.2);
});

test("a population too small to describe anybody gives null, never a rank", () => {
  // ELEVEN. One short of the floor, so this fails for the reason the floor exists rather
  // than for being obviously silly.
  assert.equal(percentile(5, TWELVE.slice(0, 11)), null);
});

test("a population of ONE is the incremental path, and it buys nothing", () => {
  // This is the shape of the most repeated bug in this area. The ordinary run scores only
  // the students markStale flagged — often exactly one — and a caller who passes the batch
  // it already has in hand as "the cohort" gets a population of one. Every definition of
  // percentile returns something structurally meaningless there (0, 50 or 100, depending
  // only on which convention the author picked), and all three would be rendered.
  assert.equal(percentile(42, [42]), null);
  assert.equal(percentile(42, [17]), null);
});

test("an empty or absent population is null rather than a crash", () => {
  assert.equal(percentile(50, []), null);
  assert.equal(percentile(50, null), null);
  assert.equal(percentile(50, undefined), null);
  assert.equal(percentile(50, "not a population"), null);
});

test("the floor is a default, and opting out of it takes a deliberate argument", () => {
  // Tidiness would put the policy one level up and leave this as arithmetic. But the
  // caller who reaches for the primitive is exactly the caller who has not read the
  // header, so the safe answer is the default one and the opt-out is explicit and
  // greppable.
  assert.equal(percentile(5, [1, 2, 3, 4, 5]), null);
  assert.equal(percentile(5, [1, 2, 3, 4, 5], { minPopulation: 5 }), 90);
});

/* -------------------------------------------------------------------------- */
/* cohortShape — describing the population itself                              */
/* -------------------------------------------------------------------------- */

test("a cohort is described by its size, its middle and its spread", () => {
  const s = cohortShape(TWELVE);
  assert.equal(s.n, 12);
  assert.equal(s.mean, 6.5);
  assert.equal(s.median, 6.5);     // even n: the mean of the two middle values
  assert.equal(s.spread, 3.5);     // population sd of 1..12
  assert.equal(s.usable, true);
});

test("an odd-sized cohort takes the middle value as its median", () => {
  const s = cohortShape([...TWELVE, 13]);
  assert.equal(s.n, 13);
  assert.equal(s.median, 7);
});

test("the mean and the median differ, and both are reported", () => {
  // One student twenty points adrift drags the mean and leaves the median alone. A screen
  // showing only the mean would describe a cohort nobody is in.
  const s = cohortShape([10, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80]);
  assert.equal(s.median, 74.5);
  assert.ok(s.mean < s.median, `mean ${s.mean} should sit below median ${s.median}`);
});

test("n counts the MEASURABLE students, not the rows handed in", () => {
  // Twelve measurable and eight nulls is a cohort of twelve. Calling it twenty overstates
  // how much the comparison is worth and understates the spread.
  const s = cohortShape([...TWELVE, null, null, null, null, null, null, null, null]);
  assert.equal(s.n, 12);
  assert.equal(s.mean, 6.5);   // not 3.9, which is what coercing the nulls to 0 gives
});

test("a cohort below the size floor has NO statistics at all, not small ones", () => {
  // Everything null, including the mean. A mean of eleven is not a description of a
  // cohort; putting it on a screen invites somebody to read it as one, and the reader has
  // no way to tell it apart from a mean of eight hundred.
  const s = cohortShape(TWELVE.slice(0, 11));
  assert.equal(s.n, 11);
  assert.equal(s.mean, null);
  assert.equal(s.median, null);
  assert.equal(s.spread, null);
  assert.equal(s.usable, false);
});

test("an empty cohort is n zero and unusable, never a mean of zero", () => {
  const s = cohortShape([]);
  assert.equal(s.n, 0);
  assert.equal(s.mean, null);
  assert.equal(s.usable, false);
});

test("a cohort where everybody is identical is unusable — but its mean IS reported", () => {
  // THE ASYMMETRY, and it is deliberate. "Every student in this group is at 91%" is a
  // real, measured, useful fact about a real cohort. It is the RANK inside it that is
  // meaningless, not the description of it — so usable goes false and the mean stays.
  //
  // Nulling the mean here would throw away a true finding in order to suppress a false
  // one, which is the opposite of everything else in this file.
  const s = cohortShape(flat(12, 91));
  assert.equal(s.n, 12);
  assert.equal(s.mean, 91);
  assert.equal(s.median, 91);
  assert.equal(s.spread, 0);
  assert.equal(s.usable, false);
});

test("a cohort spanning two points is unusable for the same reason as an identical one", () => {
  // The near-degenerate case is the dangerous one, because it looks fine. Inside a couple
  // of points the ordering between students is decided by rounding and by which register
  // happened to be taken, and it reshuffles on the next run for reasons that have nothing
  // to do with any student.
  const s = cohortShape([90, 90, 90, 91, 91, 91, 91, 91, 92, 92, 92, 92]);
  assert.ok(s.spread < MIN_COHORT_SPREAD, `spread ${s.spread} should be under the floor`);
  assert.equal(s.usable, false);
  assert.equal(s.mean, 91.1);   // still reported, as above
});

test("a cohort with a real spread is usable", () => {
  const s = cohortShape(TIGHT);
  assert.ok(s.spread >= MIN_COHORT_SPREAD, `spread ${s.spread} should clear the floor`);
  assert.equal(s.usable, true);
});

/* -------------------------------------------------------------------------- */
/* standing — one student, placed                                              */
/* -------------------------------------------------------------------------- */

test("a student far adrift of a cohort that is otherwise doing well is an outlier", () => {
  // The case this whole feature exists for. Eleven students at 90% and one at 50%: the
  // absolute threshold sees one student under the line, and cannot say that nothing is
  // wrong with the programme and something is wrong with this person.
  const s = standing(50, [...flat(11, 90), 50]);
  assert.equal(s.isOutlier, true);
  assert.ok(s.percentile <= OUTLIER_PERCENTILE);
  assert.ok(s.deltaFromMean < -OUTLIER_MIN_GAP);
});

test("BEING BELOW AVERAGE IS NOT A RISK", () => {
  // The headline negative. Half of every cohort is below the median by definition, in
  // every cohort, for ever, including one in which every student is thriving.
  //
  // 50 against a mean of 70 is twenty points down and firmly in the bottom third — and it
  // is still not a finding, because a signal that fires here fires for a third of the
  // college and a caseload of a third of the college is the same as no caseload.
  const s = standing(50, WIDE);
  assert.equal(s.mean, 70);
  assert.equal(s.deltaFromMean, -20);
  assert.ok(s.percentile > OUTLIER_PERCENTILE, `${s.percentile} should be outside the tail`);
  assert.equal(s.isOutlier, false);
});

test("the bottom of a TIGHT cohort is not an outlier either", () => {
  // The mirror trap, and the one a percentile alone gets wrong. This student is bottom of
  // their group and inside the tail — and they are seven points off the mean, in a cohort
  // that spans eleven. There is no finding here, and manufacturing one is worst exactly
  // where the cohort is doing WELL: it punishes a strong cohort by inventing a laggard
  // inside it, which is this feature's own failure mode pointed at one student.
  const s = standing(80, TIGHT);
  assert.ok(s.percentile <= OUTLIER_PERCENTILE, `${s.percentile} is inside the tail`);
  assert.ok(s.deltaFromMean > -OUTLIER_MIN_GAP, `${s.deltaFromMean} is not far enough out`);
  assert.equal(s.isOutlier, false);
});

test("the BEST student in a cohort is never an outlier — the test is one-tailed", () => {
  // "Outlier" without a direction flags the top of every cohort. A caseload of the best
  // students in each group is worse than useless; it is an insult, and it would arrive on
  // the same screen as the students who have stopped attending.
  const s = standing(100, WIDE);
  assert.equal(s.percentile, 95.8);
  assert.equal(s.isOutlier, false);
});

test("a student with no figure has a NULL standing, not an average one", () => {
  // Both sides. They are out of the population (the caller's job, and measurable() catches
  // it anyway) AND they get no standing back.
  const s = standing(null, WIDE);
  assert.equal(s.percentile, null);
  assert.equal(s.mean, null);
  assert.equal(s.median, null);
  assert.equal(s.deltaFromMean, null);
  // NULL, NOT FALSE. false would say "we compared them and they are ordinary"; null says
  // "we could not compare them". A reader has to be able to tell those apart — it is the
  // null-is-not-zero rule applied to a boolean.
  assert.equal(s.isOutlier, null);
});

test("a cohort too small to describe gives a null standing, not a default one", () => {
  const s = standing(5, TWELVE.slice(0, 11));
  assert.equal(s.percentile, null);
  assert.equal(s.isOutlier, null);
  assert.equal(s.mean, null);
});

test("a cohort with no spread gives a null standing however extreme the student looks", () => {
  // Everybody at 91 and one student at 91: there is no distribution to be an outlier in.
  const s = standing(91, flat(12, 91));
  assert.equal(s.percentile, null);
  assert.equal(s.isOutlier, null);
});

test("the whole standing is null or none of it is", () => {
  // A percentile beside a null mean invites somebody to compare it against the absolute
  // thresholds instead, which is precisely the confusion this layer exists to end.
  for (const s of [standing(null, WIDE), standing(5, [1, 2, 3]), standing(91, flat(12, 91))]) {
    const values = [s.percentile, s.mean, s.median, s.deltaFromMean, s.isOutlier];
    assert.ok(values.every((v) => v === null), `expected all null, got ${JSON.stringify(s)}`);
  }
});

/* --- direction ------------------------------------------------------------- */

// Lateness rates: low is good. Two students are chronically late, one is never late.
const LATENESS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40, 45];

test("for a figure where LOW is good, the outlier is at the TOP of the cohort", () => {
  const late = standing(45, LATENESS, { lowerIsBetter: true });
  assert.equal(late.isOutlier, true);
  assert.ok(late.percentile >= 100 - OUTLIER_PERCENTILE);
});

test("and the most punctual student in that cohort is NOT flagged", () => {
  // Without the direction flag this student is bottom-decile and eleven points off the
  // mean — a textbook outlier by every rule in the file, and completely fine. Getting this
  // wrong produces a caseload of the students who are never late.
  const punctual = standing(0, LATENESS, { lowerIsBetter: true });
  assert.equal(punctual.isOutlier, false);
});

test("the same two students swap over when the direction is not set", () => {
  // Pins that the flag is doing the work rather than the data happening to be shaped
  // conveniently. With the default (higher is better) the arithmetic is identical and the
  // verdicts are exactly reversed.
  assert.equal(standing(0, LATENESS).isOutlier, true);
  assert.equal(standing(45, LATENESS).isOutlier, false);
});

test("deltaFromMean keeps its sign whichever direction is good", () => {
  // A delta that flips sign depending on a flag is a number nobody can read off a stored
  // row a year later without also knowing which flag was set at the time. Below the mean
  // is negative, always.
  assert.ok(standing(0, LATENESS).deltaFromMean < 0);
  assert.ok(standing(0, LATENESS, { lowerIsBetter: true }).deltaFromMean < 0);
  assert.equal(
    standing(0, LATENESS).deltaFromMean,
    standing(0, LATENESS, { lowerIsBetter: true }).deltaFromMean,
  );
});

/* -------------------------------------------------------------------------- */
/* evaluate — the codes                                                        */
/* -------------------------------------------------------------------------- */

// A healthy cohort: twelve students, mean 92, comfortably above every absolute threshold.
const HEALTHY = [85, 88, 89, 90, 91, 92, 92, 93, 94, 95, 96, 99];

// A cohort in trouble: mean 59, below the college's own redAttendanceThreshold of 70.
const FAILING = [50, 52, 54, 56, 58, 58, 60, 60, 62, 64, 66, 68];

const input = (over = {}) => ({
  attendancePct: null,
  cohortAttendancePcts: [],
  averageGrade: null,
  cohortAverageGrades: [],
  ...over,
});

test("a student adrift of a healthy cohort raises the attendance code", () => {
  const r = evaluate(input({
    attendancePct: 55,
    cohortAttendancePcts: [...HEALTHY.slice(0, 11), 55],
  }), DEFAULTS);

  assert.ok(r.codes.includes(COHORT.ATTENDANCE_OUTLIER));
});

test("attainment is a separate code, so the row says which figure is adrift", () => {
  const r = evaluate(input({
    averageGrade: 30,
    cohortAverageGrades: [...flat(11, 72), 30],
  }), DEFAULTS);

  assert.ok(r.codes.includes(COHORT.ATTAINMENT_OUTLIER));
  assert.equal(r.codes.includes(COHORT.ATTENDANCE_OUTLIER), false);
});

test("an ordinary student in an ordinary cohort raises nothing at all", () => {
  const r = evaluate(input({
    attendancePct: 91,
    cohortAttendancePcts: HEALTHY,
    averageGrade: 68,
    cohortAverageGrades: [...flat(6, 65), ...flat(6, 72)],
  }), DEFAULTS);

  assert.deepEqual(r.codes, []);
});

test("THE STUDENT IS ORDINARY AND THE PROGRAMME IS THE PROBLEM", () => {
  // The case the opening argument is built on. 58% attendance in a cohort averaging 59%:
  // nobody is an outlier, because the problem is uniform. Without the cohort-level code
  // this feature would find the ordinariness and drop the problem on the floor, which is
  // the same silence the absolute-only model already produces.
  const r = evaluate(input({
    attendancePct: 58,
    cohortAttendancePcts: FAILING,
  }), DEFAULTS);

  assert.equal(r.codes.includes(COHORT.ATTENDANCE_OUTLIER), false);
  assert.equal(r.cohortStruggling, true);
  assert.equal(r.cohortAttendance.mean, 59);
  assert.equal(r.cohortAttendance.n, 12);
});

test("A STUDENT AT THE TOP OF A FAILING COHORT IS STILL FAILING", () => {
  // The sharpest edge in the module. 68% is top of this cohort by a mile — 95th
  // percentile, nine points clear of the mean — and it is also below the college's own
  // attendance threshold and, at a sponsoring provider, below the conditions of somebody's
  // visa.
  //
  // The relative view must not excuse them. It emits no code that could be read as
  // clearing anybody: the ONLY thing it says about this student is that their cohort is in
  // trouble, and every absolute red the engine raises is untouched by anything here.
  const r = evaluate(input({
    attendancePct: 68,
    cohortAttendancePcts: FAILING,
  }), DEFAULTS);

  assert.equal(r.attendance.percentile, 95.8);
  assert.deepEqual(r.codes, []);
  assert.equal(r.cohortStruggling, true);
});

test("a strong cohort is not accused of struggling, and its members are not flagged for being in it", () => {
  // The other direction of the same failure. Nothing here may manufacture concern out of a
  // cohort that is doing well.
  const r = evaluate(input({
    attendancePct: 85,
    cohortAttendancePcts: HEALTHY,
  }), DEFAULTS);

  // STRICT. `notEqual(x, true)` passes for false, null, undefined, 0 and "maybe" alike,
  // so the tri-state this module argues for at length was pinned by nothing: mutating
  // `? null` to `? false` killed zero tests.
  assert.strictEqual(r.cohortStruggling, false);
  assert.equal(r.codes.includes(COHORT.ATTENDANCE_OUTLIER), false);
});

test("a cohort whose AVERAGE grade only just clears the pass mark is struggling", () => {
  // The mean is compared against the pass mark plus the near-fail margin rather than the
  // bare pass mark. A cohort averaging 44 against a pass of 40 is a cohort half of which is
  // failing; waiting for the mean itself to drop under 40 means saying something long after
  // the year is unrecoverable.
  const r = evaluate(input({
    averageGrade: 44,
    cohortAverageGrades: [30, 35, 38, 40, 42, 44, 46, 48, 50, 52, 55, 60],
  }), DEFAULTS);

  assert.equal(r.cohortStruggling, true);
});

test("a cohort comfortably above the pass mark is not struggling", () => {
  const r = evaluate(input({
    averageGrade: 60,
    cohortAverageGrades: [45, 50, 55, 58, 60, 60, 62, 65, 68, 70, 75, 80],
  }), DEFAULTS);

  // STRICT. `notEqual(x, true)` passes for false, null, undefined, 0 and "maybe" alike,
  // so the tri-state this module argues for at length was pinned by nothing: mutating
  // `? null` to `? false` killed zero tests.
  assert.strictEqual(r.cohortStruggling, false);
});

/* --- the trap this module was written against ------------------------------ */

test("THE INCREMENTAL PATH: a population of one raises nothing and reports nothing", () => {
  // gather() runs on chunks of 200 and the ordinary run scores only the students markStale
  // flagged — often exactly one. A caller who hands over the batch already in hand as "the
  // cohort" gets a population of one, and a student compared against themselves is
  // simultaneously the best and the worst in their cohort.
  //
  // The size floor catches it. Every figure comes back null, which is loud on a screen and
  // survivable, rather than a 50th percentile, which is silent and wrong.
  const r = evaluate(input({
    attendancePct: 31,
    cohortAttendancePcts: [31],
    averageGrade: 12,
    cohortAverageGrades: [12],
  }), DEFAULTS);

  assert.deepEqual(r.codes, []);
  assert.equal(r.attendance.percentile, null);
  assert.equal(r.attendance.isOutlier, null);
  assert.equal(r.attainment.isOutlier, null);
  assert.equal(r.cohortAttendance.n, 1);
  assert.equal(r.cohortAttendance.mean, null);
});

test("a chunk-sized population is reported as n so the mistake is visible on the row", () => {
  // The floor cannot catch the OTHER form of this bug: a full recalculation whose
  // population was built per chunk yields n = 200, which passes every guard and is wrong.
  // Nothing pure can detect that, so the defence is that n goes back to the caller to be
  // stored — a population whose n is exactly the chunk size is the fingerprint.
  const r = evaluate(input({
    attendancePct: 70,
    cohortAttendancePcts: Array.from({ length: 200 }, (_, i) => 40 + (i % 50)),
  }), DEFAULTS);

  assert.equal(r.cohortAttendance.n, 200);
});

/* --- the structural invariants --------------------------------------------- */

test("every code is prefixed TRIP_ so it can never be counted as a red indicator", () => {
  // These ride in riskDriverCodes beside the engine's six REDs. engine.js derives
  // redIndicatorCount from its own internal reds array and riskDriverCodes is a copy taken
  // afterwards, so nothing appended here can reach OVR-004 — but the prefix is what keeps
  // that obvious, and a code named RED_something would read as the engine's own.
  //
  // This layer moving a band is the one thing the module header says it must never do, and
  // the prefix is the structural half of that promise.
  for (const code of COHORT_CODES) {
    assert.ok(code.startsWith("TRIP_"), `${code} is not namespaced`);
  }

  const r = evaluate(input({
    attendancePct: 40,
    cohortAttendancePcts: [...flat(11, 90), 40],
    averageGrade: 20,
    cohortAverageGrades: [...flat(11, 70), 20],
  }), DEFAULTS);

  assert.ok(r.codes.length >= 2, "expected several codes from this input");
  for (const code of r.codes) assert.ok(code.startsWith("TRIP_"), `${code} is not namespaced`);
});

test("the vocabulary contains nothing that could clear a student", () => {
  // EVERY CODE THIS MODULE EMITS ADDS A FINDING; NONE REMOVES ONE. That is the promise
  // that stops this layer grading on a curve, and it is checkable by reading the
  // vocabulary — so it is pinned here rather than left to a comment.
  //
  // Adding a TRIP_COHORT_EXPLAINED, or anything else meaning "the cohort accounts for
  // this", must break this test and force the argument to be had again.
  assert.deepEqual([...COHORT_CODES].sort(), [
    "TRIP_COHORT_ATTAINMENT_OUTLIER",
    "TRIP_COHORT_ATTENDANCE_OUTLIER",
  ]);
});

test("evaluate returns figures and codes, and no suppression channel", () => {
  // The surface is pinned. A caller cannot act on a relative judgement to soften an
  // absolute one, because there is nothing here to act on: no multiplier, no adjusted
  // score, no "ignore this red" flag. The next person to add one has to change this test.
  const r = evaluate(input(), DEFAULTS);
  assert.deepEqual(Object.keys(r).sort(), [
    "attainment", "attendance", "codes", "cohortAttainment", "cohortAttendance",
    // A FIGURE, not a code. It says the programme is in trouble, which is true of every
    // student in the cohort at once -- so putting it in codes would put an identical
    // reason on a hundred caseload rows, and a caseload of a hundred is no caseload.
    // metrics.js settled the same question for assessmentsDueSoon.
    "cohortStruggling",
  ]);
});

test("codes are free of duplicates", () => {
  const r = evaluate(input({
    attendancePct: 40,
    cohortAttendancePcts: [...flat(11, 90), 40],
    averageGrade: 20,
    cohortAverageGrades: [...flat(11, 70), 20],
  }), DEFAULTS);

  assert.deepEqual([...new Set(r.codes)], r.codes);
});

test("no cohort data at all is silence, not a finding", () => {
  // The state at a college that has not yet been given a cohort query — and the state for
  // any student the grouping cannot place. Silence, and null figures.
  const r = evaluate(input(), DEFAULTS);
  assert.deepEqual(r.codes, []);
  assert.equal(r.attendance.isOutlier, null);
  assert.equal(r.cohortAttendance.n, 0);
  assert.equal(r.cohortAttendance.mean, null);
});

test("a config with no thresholds set raises nothing rather than comparing against undefined", () => {
  // A cohort mean of 59 against an undefined threshold must not fire and must not throw.
  // NaN comparisons are false in JavaScript, so the bug this guards against is not a crash
  // — it is a code that silently stops firing, or one that starts.
  const r = evaluate(input({
    attendancePct: 58,
    cohortAttendancePcts: FAILING,
  }), {});

  // STRICT. `notEqual(x, true)` passes for false, null, undefined, 0 and "maybe" alike,
  // so the tri-state this module argues for at length was pinned by nothing: mutating
  // `? null` to `? false` killed zero tests.
  assert.strictEqual(r.cohortStruggling, false);
});

test("the cohort tunables can be overridden from config without touching the module", () => {
  // A college running small specialist provision may disagree with a floor of twelve. It
  // may say so — deliberately, in its own settings — and nothing else changes.
  const eight = [30, 40, 50, 60, 70, 80, 90, 95];
  const silent = evaluate(input({ attendancePct: 30, cohortAttendancePcts: eight }), DEFAULTS);
  assert.equal(silent.attendance.percentile, null);

  const heard = evaluate(input({ attendancePct: 30, cohortAttendancePcts: eight }),
    { ...DEFAULTS, cohortMinSize: 8 });
  assert.equal(heard.attendance.percentile, 6.3);
  assert.ok(heard.codes.includes(COHORT.ATTENDANCE_OUTLIER));
});

test("a cohort too small to describe is NULL struggling, not false", () => {
  // The distinction the module spends a paragraph on: "a null mean is a cohort too small
  // to describe, not a healthy one". Nothing asserted it — every negative test used
  // notEqual(x, true), which passes for null and false alike, so mutating `? null` to
  // `? false` killed no tests.
  //
  // False would say "we checked the programme and it is fine" on the strength of no
  // check at all, which is the null-is-not-zero rule wearing a boolean.
  const r = evaluate(input({ cohortAttendancePcts: [], cohortAverageGrades: [] }), DEFAULTS);
  assert.strictEqual(r.cohortStruggling, null);
  assert.equal(r.cohortAttendance.mean, null);
  assert.equal(r.cohortAttainment.mean, null);
});
