// Tests for the divergence layer: what it means when a student's signals DISAGREE.
//
// No database. divergence.js is pure — it takes figures the pipeline has already
// computed, plus one institution-wide probe result, and returns plain data. It does not
// even take `today`, so there is no clock to pin.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS, in the house style: what does NOT fire, what comes
// back null rather than zero, what is refused outright, and which of two true readings is
// discarded. A module whose entire job is to subtract two numbers has very few interesting
// positive cases and a great many interesting refusals, and the refusals are the half that
// looks identical to a working feature right up until somebody opens the caseload and
// finds the whole intake on it.
//
// TRAP 1 GETS A SECTION OF ITS OWN. Every combination of one-side-null must produce
// nothing, and a genuine 0 must still be a measurement — those are the same guard read
// from both ends, and getting either wrong is invisible on a row.
//
// EVERY TEST TITLE STATES WHAT ITS ASSERTIONS CHECK. A test titled "every figure is null"
// that then asserted 0 for one of them let a real defect through a 32-mutant run in this
// repo, so a title here is a claim the body is required to make good on.
//
// Run with: node --test src/prediction/divergence.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  evaluate, gap, profile,
  DIVERGENCE, DIVERGENCE_CODES, DIVERGENCE_DEFAULTS, SHAPE, SHAPE_CODES,
} = require("./divergence");

const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");
const { COHORT_CODES } = require("./cohort");
const { WORKLOAD_CODES } = require("./workload");
const { FUNDING_CODES } = require("./funding");
const { SESSIONS_CODES } = require("./sessions");

// intake.js is being written in parallel and may not exist yet. Imported defensively so
// this suite runs either way — and so that the day it lands, the collision test starts
// covering it without anybody remembering to come back. An empty array is a test that
// passes vacuously, which is why the count is reported in the assertion message rather
// than silently assumed.
let INTAKE_CODES = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  INTAKE_CODES = require("./intake").INTAKE_CODES || null;
} catch { INTAKE_CODES = null; }

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A college whose feed records whether work was handed in. */
const RECORDED = { submissionsRecorded: true };
/** A college whose feed does not — the ordinary state at a Moodle-synced institution. */
const UNRECORDED = { submissionsRecorded: false };

/** The floors, named once so a test that changes one is visibly changing a floor. */
const { minAttendanceObservations: MIN_ATT, minSubmissionObservations: MIN_SUB,
  minVleObservedDays: MIN_VLE, minGradedForAttainment: MIN_GRADED } = DIVERGENCE_DEFAULTS;

/** Every sample size comfortably above its floor, so a test that is not about sample size
 *  never accidentally becomes one. */
const AMPLE = {
  attendanceObservations: 40,
  submissionObservations: 8,
  vleObservedDays: 30,
  gradedCount: 6,
};

/** The shape profile() takes, with every figure UNMEASURABLE unless a test says
 *  otherwise. Null is the default on purpose: a fixture that starts fully populated hides
 *  which figure a test is actually exercising. */
const figures = (over = {}) => ({
  attendancePct: null,
  submissionRate: null,
  vleActiveDayRate: null,
  averageGrade: null,
  attendanceSlope: null,
  ...AMPLE,
  ...over,
});

/** The shape evaluate() takes. Past the settling-in period and with the probe on, so a
 *  test has to opt in to either. */
const input = (over = {}) => ({
  ...figures(),
  weeksIntoProgramme: 20,
  institution: RECORDED,
  ...over,
});

/** Sample sizes at their floors, for gap(). */
const ns = (over = {}) => ({ nA: 40, nB: 8, minA: MIN_ATT, minB: MIN_SUB, ...over });

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

test("every exported code is namespaced TRIP_", () => {
  // Structural, not decoration. These strings are appended to riskDriverCodes, the same
  // array engine.js fills from its six RED indicators. A code named RED_something would
  // read as the engine's own, and the next person to take redIndicatorCount off the copy
  // rather than off engine.js's internal `reds` array would silently wire a disagreement
  // between two percentages into a student's band via OVR-004.
  assert.ok(DIVERGENCE_CODES.length > 0, "the module must export a vocabulary");
  for (const code of DIVERGENCE_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with any other vocabulary writing that column", () => {
  // Seven files will write into one array and all seven sets of strings outlive the screen
  // that renders them. A duplicate would make two different findings indistinguishable on
  // the caseload, and a history row is what an appeal is argued from.
  const existing = [
    ["tripwires", TRIP_CODES],
    ["coverage", COVERAGE_CODES],
    ["cohort", COHORT_CODES],
    ["workload", WORKLOAD_CODES],
    ["funding", FUNDING_CODES],
    ["sessions", SESSIONS_CODES],
  ];
  if (INTAKE_CODES) existing.push(["intake", INTAKE_CODES]);

  for (const code of DIVERGENCE_CODES) {
    for (const [name, codes] of existing) {
      assert.equal(codes.includes(code), false, `${code} is already emitted by ${name}`);
    }
  }
  // The count is asserted so the vacuous case is visible rather than silent: if intake.js
  // has landed and this still says 6, the defensive import stopped working.
  assert.ok(existing.length >= 6, `checked against ${existing.length} vocabularies`);
});

test("the vocabulary holds no duplicate strings", () => {
  assert.equal(new Set(DIVERGENCE_CODES).size, DIVERGENCE_CODES.length);
});

test("every shape maps to a code and every code maps back to a shape", () => {
  // A shape added to SHAPE without an entry in SHAPE_CODES would be classified and then
  // silently dropped by evaluate() — a finding computed and thrown away, which is the
  // hardest kind of bug to see on a row because the row looks exactly like a student with
  // no divergence.
  for (const s of Object.values(SHAPE)) {
    assert.ok(SHAPE_CODES[s], `shape ${s} has no code`);
    assert.ok(DIVERGENCE_CODES.includes(SHAPE_CODES[s]), `${s} maps outside the vocabulary`);
  }
  assert.equal(Object.keys(SHAPE_CODES).length, Object.values(SHAPE).length);
  assert.equal(new Set(Object.values(SHAPE_CODES)).size, DIVERGENCE_CODES.length);
});

/* ========================================================================== */
/* The two keys borrowed from settings.js                                      */
/* ========================================================================== */

test("attendanceSlopeDrop and settlingInWeeks match settings.js exactly", () => {
  // These are restated in DIVERGENCE_DEFAULTS so a bare profile() call is not silently
  // inert. They are the same KEY NAMES, so a real config always overrides them — but a
  // drift between the two defaults would mean a bare call and a wired call disagreed
  // about what a falling attendance is, and only one of those is ever tested.
  const { DEFAULTS } = require("./settings");
  assert.equal(DIVERGENCE_DEFAULTS.attendanceSlopeDrop, DEFAULTS.attendanceSlopeDrop);
  assert.equal(DIVERGENCE_DEFAULTS.settlingInWeeks, DEFAULTS.settlingInWeeks);
});

/* ========================================================================== */
/* TRAP 1: NULL IS NOT ZERO — gap()                                            */
/* ========================================================================== */

test("gap returns null when the LEFT figure is null, not the right figure's distance from zero", () => {
  // The dangerous reading. `null - 20` coerced would be -20; `95 - null` coerced would be
  // 95, the loudest possible gap, produced entirely by a figure nobody measured.
  assert.equal(gap(null, 20, ns()), null);
});

test("gap returns null when the RIGHT figure is null, not the left figure's own value", () => {
  assert.equal(gap(95, null, ns()), null);
});

test("gap returns null when BOTH figures are null, and not 0", () => {
  // Two unmeasurable figures do not agree with each other. A gap of 0 would read as
  // "these two figures are in perfect accord", which is a finding, about nothing.
  assert.equal(gap(null, null, ns()), null);
});

test("gap returns null for undefined on either side", () => {
  // A caller reading a key that does not exist on its object gets undefined rather than
  // null, and undefined has its own coercion — `undefined - 20` is NaN, which would then
  // fail every threshold comparison silently rather than loudly.
  assert.equal(gap(undefined, 20, ns()), null);
  assert.equal(gap(95, undefined, ns()), null);
});

test("gap returns null for NaN and Infinity on either side", () => {
  // NaN is the one that slips a naive range check: `NaN < 0 || NaN > 100` is false, so a
  // guard written as a range test alone would treat it as in range and return NaN, which
  // then fails `>= 25` quietly. Infinity would pass a finite-only check that forgot it.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(gap(bad, 20, ns()), null, String(bad));
    assert.equal(gap(95, bad, ns()), null, String(bad));
  }
});

test("gap returns null for a string that looks like a number", () => {
  // "95" - "20" is 75 in JavaScript. A figure arriving as a string from a JSON column or a
  // query parameter would produce a real-looking divergence with no type error anywhere.
  assert.equal(gap("95", 20, ns()), null);
  assert.equal(gap(95, "20", ns()), null);
});

test("gap returns null when either figure is outside 0-100", () => {
  // Not an extreme student: a caller who handed over a different quantity — a count, a
  // mark out of 20, a score. Every shape fires on a gap being LARGE, so an out-of-range
  // operand is the one input guaranteed to manufacture a finding.
  assert.equal(gap(120, 20, ns()), null);
  assert.equal(gap(-5, 20, ns()), null);
  assert.equal(gap(95, 101, ns()), null);
  assert.equal(gap(95, -0.1, ns()), null);
});

test("gap accepts the exact endpoints 0 and 100 as measurements", () => {
  // The mirror of the test above, and the more important half. A student who attended
  // every session and handed in nothing is 100 and 0 — the textbook case this whole file
  // exists for — and a range guard written with `>` instead of `>=` would refuse it.
  assert.equal(gap(100, 0, ns()), 100);
  assert.equal(gap(0, 100, ns()), -100);
});

test("a submission rate of exactly 0 is a measurement and produces a full-size gap", () => {
  // THE OTHER END OF TRAP 1, and the reason the rule is "null is not zero" rather than
  // "treat everything cautiously". A real 0 over enough observations is the strongest
  // finding in the file. A guard that refused falsy values — `if (!a || !b) return null`
  // — would pass every test above and silently delete exactly this case.
  assert.equal(gap(95, 0, ns()), 95);
});

/* ========================================================================== */
/* TRAP 4: SAMPLE SIZE, ON BOTH SIDES — gap()                                  */
/* ========================================================================== */

test("gap returns null when the LEFT sample is below its floor", () => {
  assert.equal(gap(95, 20, ns({ nA: MIN_ATT - 1 })), null);
});

test("gap returns null when the RIGHT sample is below its floor", () => {
  // The half-guard this repo has shipped before: a floor on only the interesting side.
  // "20% submission over two assessments against 95% attendance over forty registers" is
  // not a comparison, and the small side is the one a floor is usually forgotten on.
  assert.equal(gap(95, 20, ns({ nB: MIN_SUB - 1 })), null);
});

test("gap returns a figure when both samples sit exactly ON their floors", () => {
  // The boundary, in the inclusive direction. A floor written `>` rather than `>=` would
  // silently raise both floors by one, which no other test here would catch.
  assert.equal(gap(95, 20, ns({ nA: MIN_ATT, nB: MIN_SUB })), 75);
});

test("gap returns null when a sample size is missing entirely", () => {
  // A MISSING COUNT IS NOT A SATISFIED FLOOR. Defaulting it — to 0, to Infinity, or by
  // skipping the check when it is absent — would be a way of not having the guard while
  // appearing to, and the caller could not tell from the outside.
  assert.equal(gap(95, 20, { nB: 8, minA: MIN_ATT, minB: MIN_SUB }), null);
  assert.equal(gap(95, 20, { nA: 40, minA: MIN_ATT, minB: MIN_SUB }), null);
  assert.equal(gap(95, 20, { nA: 40, nB: 8, minB: MIN_SUB }), null);
  assert.equal(gap(95, 20, { nA: 40, nB: 8, minA: MIN_ATT }), null);
});

test("gap returns null when opts is missing altogether", () => {
  assert.equal(gap(95, 20), null);
  assert.equal(gap(95, 20, null), null);
});

test("gap returns null for a non-numeric sample size", () => {
  assert.equal(gap(95, 20, ns({ nA: "40" })), null);
  assert.equal(gap(95, 20, ns({ nB: null })), null);
});

/* ========================================================================== */
/* gap(): the arithmetic itself                                                */
/* ========================================================================== */

test("gap is signed a-minus-b and keeps the sign convention in both directions", () => {
  // One convention across the whole file: attendance is always the left operand, so
  // positive always means "more present than the other thing". A reader of a stored
  // column must never have to check which way round a particular pair was written.
  assert.equal(gap(90, 30, ns()), 60);
  assert.equal(gap(30, 90, ns()), -60);
});

test("gap rounds to one decimal place AFTER subtracting, not before", () => {
  // 88.25 - 40.04 = 48.21 -> 48.2. Rounding each operand first would give 88.3 - 40 =
  // 48.3, a different stored number from the one the comparison used.
  assert.equal(gap(88.25, 40.04, ns()), 48.2);
});

/* ========================================================================== */
/* TRAP 1 AND TRAP 4, READ THROUGH profile()                                   */
/* ========================================================================== */

test("every figure null produces no shape, no candidates, and BOTH gaps null", () => {
  // The title says null, so the assertions say null. Not 0 for any of them: a student
  // nobody could measure has no divergence, and 0 would claim their figures agreed.
  const r = profile(figures());
  assert.equal(r.shape, null);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.attendanceSubmissionGap, null);
  assert.equal(r.attendanceVleGap, null);
});

test("attendance null with a submission rate of 0 raises nothing", () => {
  // The most dangerous single combination in the module. Attendance withheld because too
  // few registers were taken, submission genuinely nought — read as `null - 0` this is a
  // zero-point gap, and read as `0 - 0` it is also zero, but a careless implementation
  // reaching for the OTHER figure would produce a 0-vs-0 "agreement" and, one sign change
  // later, a finding. Nothing here may be reported.
  const r = profile(figures({ attendancePct: null, submissionRate: 0 }));
  assert.equal(r.shape, null);
  assert.equal(r.attendanceSubmissionGap, null);
});

test("attendance 95 with a null submission rate raises nothing", () => {
  // The inverse, and the one that would fire hardest: 95 against an unmeasured figure read
  // as 0 is a 95-point divergence, the loudest reading available, for a student about whom
  // the college knows least.
  const r = profile(figures({ attendancePct: 95, submissionRate: null }));
  assert.equal(r.shape, null);
  assert.equal(r.attendanceSubmissionGap, null);
});

test("a null VLE rate raises nothing however low attendance is", () => {
  // An unobservable college — a Moodle hiding lastaccess, or one nobody uses, or a college
  // that teaches face to face. All three produce no rows, and reading that as 0% online
  // would put the whole institution on the caseload for being absent from a VLE nobody
  // could see.
  const r = profile(figures({ attendancePct: 20, vleActiveDayRate: null }));
  assert.equal(r.shape, null);
  assert.equal(r.attendanceVleGap, null);
});

test("a null attendance raises nothing however high the VLE rate is", () => {
  const r = profile(figures({ attendancePct: null, vleActiveDayRate: 95 }));
  assert.equal(r.shape, null);
  assert.equal(r.attendanceVleGap, null);
});

test("a null average grade raises no attainment shape however steep the fall", () => {
  // Nothing marked is not a good record. Read as 0 it would fail the floor and stay
  // silent, which is right by luck; read as anything else it would fire for every student
  // in a cohort nobody has marked yet.
  const r = profile(figures({ averageGrade: null, attendanceSlope: -40 }));
  assert.equal(r.shape, null);
  assert.deepEqual(r.candidates, []);
});

test("a null attendance slope raises no attainment shape however good the marks", () => {
  // A slope is null when one of the two windows was too thin to compare. `null <= -10`
  // coerces to `0 <= -10` and is false today — one sign flip from firing for every
  // student whose register is too thin to have a slope at all.
  const r = profile(figures({ averageGrade: 80, attendanceSlope: null }));
  assert.equal(r.shape, null);
  assert.deepEqual(r.candidates, []);
});

test("an average grade is never subtracted from an attendance percentage", () => {
  // TRAP 3, asserted rather than only argued. Attendance 90 against a 20% average is a
  // seventy-point difference between two numbers that share a symbol and nothing else,
  // and it must produce no shape and no gap. If a fifth gap were ever added between these
  // two, this is the test that fails.
  const r = profile(figures({
    attendancePct: 90, averageGrade: 20, submissionRate: null, vleActiveDayRate: null,
  }));
  assert.equal(r.shape, null);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.attendanceSubmissionGap, null);
  assert.equal(r.attendanceVleGap, null);
});

test("too few marked sessions silences BOTH gaps, not just the submission one", () => {
  // The attendance side is the shared left operand. A floor applied to only one comparison
  // would leave the other reading a percentage the run has effectively refused.
  const r = profile(figures({
    attendancePct: 95, submissionRate: 10, vleActiveDayRate: 10,
    attendanceObservations: MIN_ATT - 1,
  }));
  assert.equal(r.attendanceSubmissionGap, null);
  assert.equal(r.attendanceVleGap, null);
  assert.equal(r.shape, null);
});

test("too few past-due assessments silences the submission gap but not the VLE gap", () => {
  // The floors are per-comparison, so a thin sample on one side must not blind the other.
  // This is the test that fails if somebody hoists one floor into a single early return.
  const r = profile(figures({
    attendancePct: 20, submissionRate: 90, vleActiveDayRate: 90,
    submissionObservations: MIN_SUB - 1,
  }));
  assert.equal(r.attendanceSubmissionGap, null);
  assert.equal(r.attendanceVleGap, -70);
  assert.equal(r.shape, SHAPE.ONLINE_NOT_ATTENDING);
});

test("too few observed VLE days silences the VLE gap but not the submission gap", () => {
  const r = profile(figures({
    attendancePct: 20, submissionRate: 90, vleActiveDayRate: 90,
    vleObservedDays: MIN_VLE - 1,
  }));
  assert.equal(r.attendanceVleGap, null);
  assert.equal(r.attendanceSubmissionGap, -70);
  assert.equal(r.shape, SHAPE.SUBMITTING_NOT_ATTENDING);
});

test("too few graded pieces silences the attainment shape and nothing else", () => {
  const r = profile(figures({
    averageGrade: 80, attendanceSlope: -30, gradedCount: MIN_GRADED - 1,
  }));
  assert.equal(r.shape, null);
  assert.deepEqual(r.candidates, []);
});

test("a null graded count silences the attainment shape", () => {
  // A missing count is not a satisfied floor here either.
  const r = profile(figures({ averageGrade: 80, attendanceSlope: -30, gradedCount: null }));
  assert.equal(r.shape, null);
});

test("each sample floor mirrors the opinion settings.js already holds", () => {
  // THE VALUES, PINNED AS LITERALS AGAINST THEIR SOURCES — and this test exists because a
  // mutation run found the hole it fills. Every floor test above derives its fixture from
  // DIVERGENCE_DEFAULTS ("one below the floor"), so lowering a floor moves the fixture with
  // it and the whole set passes unchanged. A floor quietly dropped to 1 would therefore
  // have shipped, and a floor of 1 is the half of trap 4 that is not there.
  //
  // Pinning them to settings.js also pins the ARGUMENT: none of these is a new opinion
  // about how much evidence a rate needs. Each mirrors a number this codebase already
  // committed to, so a college retuning one moves this with it.
  const { DEFAULTS } = require("./settings");
  assert.equal(DIVERGENCE_DEFAULTS.minAttendanceObservations, DEFAULTS.minMarksForRate,
    "the attendance floor is minMarksForRate");
  assert.equal(DIVERGENCE_DEFAULTS.minSubmissionObservations, DEFAULTS.lateSubmissionMinPieces,
    "the submission floor is lateSubmissionMinPieces");
  assert.equal(DIVERGENCE_DEFAULTS.minVleObservedDays, DEFAULTS.minObservedDays,
    "the VLE floor is minObservedDays");
  assert.equal(DIVERGENCE_DEFAULTS.minGradedForAttainment, DEFAULTS.gradeTrendAssessmentCount * 2,
    "the graded floor is the sample the engine's own trend requires");
  // And the literals, so a coordinated drift in both files is still visible here.
  assert.equal(DIVERGENCE_DEFAULTS.minAttendanceObservations, 6);
  assert.equal(DIVERGENCE_DEFAULTS.minSubmissionObservations, 3);
  assert.equal(DIVERGENCE_DEFAULTS.minVleObservedDays, 5);
  assert.equal(DIVERGENCE_DEFAULTS.minGradedForAttainment, 4);
  assert.equal(DIVERGENCE_DEFAULTS.divergenceGap, 25);
  assert.equal(DIVERGENCE_DEFAULTS.attainingGradeFloor, 55);
});

test("exactly three past-due assessments is enough for the submission gap", () => {
  // The inclusive end of the submission floor, with the count written as a literal rather
  // than derived from the constant. A mutation that wired the ATTENDANCE floor (6) into
  // this side would refuse a sample of 3 and silence the comparison for most of a term,
  // and every floor test phrased as "one below the floor" would still pass.
  const r = profile(figures({
    attendancePct: 95, submissionRate: 20, submissionObservations: 3,
  }));
  assert.equal(r.attendanceSubmissionGap, 75);
  assert.equal(r.shape, SHAPE.ATTENDING_NOT_SUBMITTING);
});

test("exactly four graded pieces is enough for the attainment shape", () => {
  // The inclusive end of the graded floor. Written `>` instead of `>=` it becomes five,
  // which nothing else here would notice.
  const r = profile(figures({ averageGrade: 72, gradedCount: 4, attendanceSlope: -20 }));
  assert.equal(r.shape, SHAPE.ATTAINING_NOT_ATTENDING);
});

test("exactly six marked sessions and five observed VLE days are enough", () => {
  const r = profile(figures({
    attendancePct: 20, vleActiveDayRate: 90,
    attendanceObservations: 6, vleObservedDays: 5,
  }));
  assert.equal(r.shape, SHAPE.ONLINE_NOT_ATTENDING);
});

test("a figure arriving as a numeric string raises nothing on any side", () => {
  // JavaScript will happily order strings against numbers — "80" >= 55 is true, and
  // "-30" <= -10 is true — so a figure that reached this module as a string from a JSON
  // column or a query parameter would satisfy a bare comparison and produce a finding with
  // no type error anywhere. gap() refuses strings outright, which covers the two
  // percentage pairs; the attainment conjunction has no gap in it and needs its own guard,
  // which is what `isNum` is doing on both halves of it.
  assert.equal(profile(figures({ averageGrade: "80", gradedCount: 6, attendanceSlope: -30 })).shape,
    null);
  assert.equal(profile(figures({ averageGrade: 80, gradedCount: 6, attendanceSlope: "-30" })).shape,
    null);
  assert.equal(profile(figures({ averageGrade: 80, gradedCount: "6", attendanceSlope: -30 })).shape,
    null);
});

test("a config threshold arriving as a string raises nothing", () => {
  // The same coercion one level up, and it is not hypothetical: these settings are merged
  // out of a per-tenant JSON column. `-"10"` is -10, so a threshold saved as a string would
  // silently work — until one was saved as "ten", or as "10%", and every comparison became
  // false for that college alone with nothing on any row to show it.
  const r = profile(figures({ averageGrade: 80, gradedCount: 6, attendanceSlope: -30 }),
    { attendanceSlopeDrop: "10" });
  assert.equal(r.shape, null);
});

/* ========================================================================== */
/* TRAP 2: A DIFFERENCE IS NOT A DIVERGENCE                                    */
/* ========================================================================== */

test("an ordinary 80/60 student raises nothing", () => {
  // Twenty points apart, which is a normal relationship between two figures with different
  // denominators, different granularities and different natural levels. A threshold set at
  // the like-for-like scale of attendanceSlopeDrop (10) would put this student — and most
  // of the institution — on the caseload.
  const r = profile(figures({ attendancePct: 80, submissionRate: 60 }));
  assert.equal(r.shape, null);
  assert.equal(r.attendanceSubmissionGap, 20);
});

test("a gap one tenth of a point under the threshold raises nothing", () => {
  const r = profile(figures({ attendancePct: 84.9, submissionRate: 60 }));
  assert.equal(r.attendanceSubmissionGap, 24.9);
  assert.equal(r.shape, null);
});

test("a gap exactly on the threshold raises the shape", () => {
  // The inclusive boundary, pinned in both directions by the pair of tests. A `>` written
  // where `>=` belongs moves the whole threshold by a tenth and nothing else notices.
  const r = profile(figures({ attendancePct: 85, submissionRate: 60 }));
  assert.equal(r.attendanceSubmissionGap, 25);
  assert.equal(r.shape, SHAPE.ATTENDING_NOT_SUBMITTING);
});

test("a negative gap exactly on the threshold raises the mirror shape", () => {
  const r = profile(figures({ attendancePct: 60, submissionRate: 85 }));
  assert.equal(r.attendanceSubmissionGap, -25);
  assert.equal(r.shape, SHAPE.SUBMITTING_NOT_ATTENDING);
});

test("the threshold is read from config and a college that raises it silences the shape", () => {
  // Proves the constant is a setting rather than a literal buried in the comparison. A
  // thirty-point gap fires at the default and must not fire at 50.
  const wide = figures({ attendancePct: 90, submissionRate: 60 });
  assert.equal(profile(wide).shape, SHAPE.ATTENDING_NOT_SUBMITTING);
  assert.equal(profile(wide, { divergenceGap: 50 }).shape, null);
});

/* ========================================================================== */
/* The four shapes                                                             */
/* ========================================================================== */

test("attendance 95 against submission 20 is ATTENDING_NOT_SUBMITTING", () => {
  // Present in the room, producing nothing. Academic support, not attendance chasing.
  const r = profile(figures({ attendancePct: 95, submissionRate: 20 }));
  assert.equal(r.shape, SHAPE.ATTENDING_NOT_SUBMITTING);
  assert.equal(r.attendanceSubmissionGap, 75);
});

test("attendance 30 against submission 90 is SUBMITTING_NOT_ATTENDING", () => {
  // Working, disconnected from teaching. Timetabling or mode of study.
  const r = profile(figures({ attendancePct: 30, submissionRate: 90 }));
  assert.equal(r.shape, SHAPE.SUBMITTING_NOT_ATTENDING);
  assert.equal(r.attendanceSubmissionGap, -60);
});

test("attendance 25 against a VLE rate of 85 is ONLINE_NOT_ATTENDING", () => {
  const r = profile(figures({ attendancePct: 25, vleActiveDayRate: 85 }));
  assert.equal(r.shape, SHAPE.ONLINE_NOT_ATTENDING);
  assert.equal(r.attendanceVleGap, -60);
});

test("the VLE gap threshold is inclusive: -24.9 is silent and -25 fires", () => {
  // The boundary on the VLE side, pinned separately from the submission side. The two
  // comparisons share a constant and nothing else, so a `<` written where `<=` belongs on
  // one of them moves that threshold alone and no submission-side test notices.
  assert.equal(profile(figures({ attendancePct: 60, vleActiveDayRate: 84.9 })).shape, null);
  assert.equal(profile(figures({ attendancePct: 60, vleActiveDayRate: 85 })).shape,
    SHAPE.ONLINE_NOT_ATTENDING);
});

test("a high VLE rate with HIGHER attendance raises nothing", () => {
  // The shape is directional. A student who is both in the room and online is the case the
  // whole feature is happy about, and an unsigned comparison — an absolute difference —
  // would report them as diverging.
  const r = profile(figures({ attendancePct: 95, vleActiveDayRate: 20 }));
  assert.equal(r.attendanceVleGap, 75);
  assert.equal(r.shape, null);
});

test("good marks with a falling attendance is ATTAINING_NOT_ATTENDING", () => {
  const r = profile(figures({ averageGrade: 72, gradedCount: 6, attendanceSlope: -18 }));
  assert.equal(r.shape, SHAPE.ATTAINING_NOT_ATTENDING);
});

test("good marks with a FLAT attendance raises nothing", () => {
  // Half of the conjunction. A student doing well and attending steadily is not a finding,
  // and this is the half a reader is most likely to drop when refactoring.
  const r = profile(figures({ averageGrade: 72, gradedCount: 6, attendanceSlope: 0 }));
  assert.equal(r.shape, null);
});

test("good marks with a RISING attendance raises nothing", () => {
  const r = profile(figures({ averageGrade: 72, gradedCount: 6, attendanceSlope: 25 }));
  assert.equal(r.shape, null);
});

test("a falling attendance with POOR marks raises no attainment shape", () => {
  // The other half. This student is in trouble and the composite score will say so; the
  // shape here claims specifically that the marks are HIDING the fall, which is only true
  // when the marks are good. tripwires' ATTENDANCE_FALLING already covers the fall itself.
  const r = profile(figures({ averageGrade: 35, gradedCount: 6, attendanceSlope: -30 }));
  assert.equal(r.shape, null);
  assert.deepEqual(r.candidates, []);
});

test("a bare pass does not count as attaining and a comfortable pass does", () => {
  // The band rung, pinned on both sides. 54.9 is inside "only just cleared" territory and
  // props nothing up; 55 is the ladder boundary at which this institution's own config
  // stops calling a figure concerning.
  const near = figures({ averageGrade: 54.9, gradedCount: 6, attendanceSlope: -30 });
  const clear = figures({ averageGrade: 55, gradedCount: 6, attendanceSlope: -30 });
  assert.equal(profile(near).shape, null);
  assert.equal(profile(clear).shape, SHAPE.ATTAINING_NOT_ATTENDING);
});

test("the fall threshold is the college's own attendanceSlopeDrop, inclusive", () => {
  // Reused rather than restated, so a college retuning what it calls a falling attendance
  // moves this with it. -9.9 must not fire at a drop of 10; -10 must.
  const base = { averageGrade: 72, gradedCount: 6 };
  assert.equal(profile(figures({ ...base, attendanceSlope: -9.9 })).shape, null);
  assert.equal(profile(figures({ ...base, attendanceSlope: -10 })).shape,
    SHAPE.ATTAINING_NOT_ATTENDING);
  // And a college that has widened it to 20 silences the -10 case.
  assert.equal(profile(figures({ ...base, attendanceSlope: -10 }), { attendanceSlopeDrop: 20 }).shape,
    null);
});

test("the attainment shape needs no absolute attendance floor and fires at a comfortable level", () => {
  // Deliberate: requiring the student to already be below some level would delay the code
  // until the fall had finished, which is the point at which it stops being early warning.
  // 95 -> 78 is the case this exists for and 78 is a comfortable number.
  const r = profile(figures({
    attendancePct: 78, averageGrade: 72, gradedCount: 6, attendanceSlope: -17,
  }));
  assert.equal(r.shape, SHAPE.ATTAINING_NOT_ATTENDING);
});

/* ========================================================================== */
/* Exactly one shape, and the precedence between them                          */
/* ========================================================================== */

test("the two submission shapes can never both be candidates", () => {
  // Sign-exclusive by construction: one gap cannot be both >= +25 and <= -25. Swept across
  // the range so the claim is not resting on one fixture.
  for (let a = 0; a <= 100; a += 5) {
    for (let b = 0; b <= 100; b += 5) {
      const r = profile(figures({ attendancePct: a, submissionRate: b }));
      const both = r.candidates.includes(SHAPE.ATTENDING_NOT_SUBMITTING)
        && r.candidates.includes(SHAPE.SUBMITTING_NOT_ATTENDING);
      assert.equal(both, false, `${a}/${b}`);
    }
  }
});

test("SUBMITTING_NOT_ATTENDING wins over ONLINE_NOT_ATTENDING and the loser is recorded", () => {
  // Both point the same way — engaged, absent — and describe one student. Work handed in is
  // strictly stronger evidence than a course page opened, and the compliance argument this
  // shape is used to make gets asked what it rests on.
  const r = profile(figures({ attendancePct: 20, submissionRate: 90, vleActiveDayRate: 90 }));
  assert.equal(r.shape, SHAPE.SUBMITTING_NOT_ATTENDING);
  assert.deepEqual(r.candidates,
    [SHAPE.ONLINE_NOT_ATTENDING, SHAPE.SUBMITTING_NOT_ATTENDING].sort());
});

test("ATTAINING_NOT_ATTENDING wins over SUBMITTING_NOT_ATTENDING", () => {
  // The only shape carrying a DIRECTION. The others are cross-sections and are equally true
  // of a student who has been that way since October; this one has a deadline attached.
  const r = profile(figures({
    attendancePct: 20, submissionRate: 90, averageGrade: 75, gradedCount: 6,
    attendanceSlope: -30,
  }));
  assert.equal(r.shape, SHAPE.ATTAINING_NOT_ATTENDING);
  assert.ok(r.candidates.includes(SHAPE.SUBMITTING_NOT_ATTENDING));
});

test("ATTAINING_NOT_ATTENDING wins over ATTENDING_NOT_SUBMITTING", () => {
  // The only ordering between those two that ever bites: good marks on the little that was
  // handed in, and the attendance now falling. The fall is the newer news.
  const r = profile(figures({
    attendancePct: 78, submissionRate: 30, averageGrade: 75, gradedCount: 6,
    attendanceSlope: -30,
  }));
  assert.equal(r.shape, SHAPE.ATTAINING_NOT_ATTENDING);
  assert.deepEqual(r.candidates,
    [SHAPE.ATTAINING_NOT_ATTENDING, SHAPE.ATTENDING_NOT_SUBMITTING].sort());
});

test("candidates come back sorted, so the array is stable between runs", () => {
  // A figure that moved with nothing about the student having changed is what makes a row
  // untrustworthy. The sort is what stops the array depending on the order the conditions
  // happen to be written in.
  const r = profile(figures({
    attendancePct: 20, submissionRate: 90, vleActiveDayRate: 90,
  }));
  assert.deepEqual(r.candidates, [...r.candidates].sort());
});

/* ========================================================================== */
/* evaluate(): the institution probe                                           */
/* ========================================================================== */

test("evaluate throws when the institution probe is missing", () => {
  // Loudly, at the first call, in the caller's own test run. A boolean defaulting to falsy
  // would cost the submission shapes permanently and invisibly: no test would fail, no row
  // would look wrong, and the column would be null for every student at every college for
  // as long as anybody left it alone.
  assert.throws(() => evaluate({ ...figures(), weeksIntoProgramme: 20 }), TypeError);
});

test("evaluate throws when the probe is present but not a boolean", () => {
  // undefined, null and a truthy non-boolean all refused. `submissionsRecorded: 1` from a
  // count query is the realistic mistake, and it would otherwise pass a truthiness check
  // while a count of 0 would silently disable the feature.
  for (const bad of [{}, { submissionsRecorded: undefined }, { submissionsRecorded: null },
    { submissionsRecorded: 1 }, { submissionsRecorded: "true" }]) {
    assert.throws(() => evaluate(input({ institution: bad })), TypeError, JSON.stringify(bad));
  }
});

test("evaluate throws before reading anything else, even with no raw at all", () => {
  assert.throws(() => evaluate(), TypeError);
  assert.throws(() => evaluate(null), TypeError);
});

test("a college with no submission feed gets a null submission gap and no submission code", () => {
  // The integration, not the student. At a college where nothing populates
  // AssessmentSubmission, every student would otherwise read as "attends, submits nothing"
  // — the whole institution on one caseload, with an identical reason on every row.
  const r = evaluate(input({
    attendancePct: 95, submissionRate: 5, institution: UNRECORDED,
  }));
  assert.equal(r.attendanceSubmissionGap, null);
  assert.deepEqual(r.codes, []);
  assert.equal(r.divergenceShape, null);
});

test("the submission probe does not gate the VLE side", () => {
  // The guard is submission-only on purpose: for the VLE, absence of rows IS the
  // institution guard, so a second flag over it would suppress a shape that is already
  // structurally safe. A college with no submission feed must still find its online-only
  // students.
  const r = evaluate(input({
    attendancePct: 20, vleActiveDayRate: 90, institution: UNRECORDED,
  }));
  assert.deepEqual(r.codes, [DIVERGENCE.ONLINE_NOT_ATTENDING]);
  assert.equal(r.attendanceVleGap, -70);
});

/* ========================================================================== */
/* TRAP 6: the settling-in exemption, BOTH halves                              */
/* ========================================================================== */

test("a week-one student raises no code", () => {
  // "Attends but does not submit" describes a third of a cohort in week three, and it is a
  // fact about the calendar: barely anything has been set, so the whole intake's submission
  // rate rests on the one or two diagnostics that have. The floors alone cannot fix that,
  // because in the settling-in period a cohort sits AT its floors rather than above them.
  const r = evaluate(input({
    attendancePct: 95, submissionRate: 5, weeksIntoProgramme: 1,
  }));
  assert.deepEqual(r.codes, []);
});

test("a week-one student still reports the shape and the gap that were suppressed", () => {
  // The mute is a decision about the CASELOAD, not a claim that nothing was observed.
  // Blanking the figures too would make "we saw this and chose not to raise it"
  // indistinguishable from "we saw nothing" — which is the distinction that gets asked
  // about in week four, when the code finally appears and somebody wants to know how long
  // it had been true.
  const r = evaluate(input({
    attendancePct: 95, submissionRate: 5, weeksIntoProgramme: 1,
  }));
  assert.equal(r.divergenceShape, SHAPE.ATTENDING_NOT_SUBMITTING);
  assert.equal(r.attendanceSubmissionGap, 90);
});

test("a student of UNKNOWN programme age is NOT exempt and raises the code", () => {
  // The second half of the rule, and the half most often dropped. `weeksIntoProgramme <
  // settlingInWeeks` written without an isNum compares `null < 3` as `0 < 3` and mutes
  // exactly the students the calendar cannot already account for.
  const r = evaluate(input({
    attendancePct: 95, submissionRate: 5, weeksIntoProgramme: null,
  }));
  assert.deepEqual(r.codes, [DIVERGENCE.ATTENDING_NOT_SUBMITTING]);
});

test("an undefined programme age is likewise not exempt", () => {
  const r = evaluate(input({
    attendancePct: 95, submissionRate: 5, weeksIntoProgramme: undefined,
  }));
  assert.deepEqual(r.codes, [DIVERGENCE.ATTENDING_NOT_SUBMITTING]);
});

test("the settling-in boundary is exclusive: at settlingInWeeks the code fires", () => {
  // Pinned on both sides so an off-by-one in either direction fails. The default is 3.
  const at = evaluate(input({ attendancePct: 95, submissionRate: 5, weeksIntoProgramme: 3 }));
  const under = evaluate(input({ attendancePct: 95, submissionRate: 5, weeksIntoProgramme: 2 }));
  assert.deepEqual(at.codes, [DIVERGENCE.ATTENDING_NOT_SUBMITTING]);
  assert.deepEqual(under.codes, []);
});

test("a college that lengthens settlingInWeeks mutes a student the default would flag", () => {
  // Proves the mute reads config rather than a literal.
  const r = evaluate(input({ attendancePct: 95, submissionRate: 5, weeksIntoProgramme: 5 }),
    { settlingInWeeks: 8 });
  assert.deepEqual(r.codes, []);
});

/* ========================================================================== */
/* evaluate(): the output contract                                             */
/* ========================================================================== */

test("evaluate never returns more than one code", () => {
  // Four readings of one disagreement, not four findings, and two of them are outright
  // contradictory. Swept over a grid of every figure at once rather than asserted on a
  // single fixture, because the failure would be a shape added later without a precedence
  // entry.
  const levels = [0, 25, 50, 75, 100];
  const slopes = [null, -30, 0, 30];
  const grades = [null, 20, 75];
  for (const a of levels) {
    for (const s of levels) {
      for (const v of levels) {
        for (const sl of slopes) {
          for (const g of grades) {
            const r = evaluate(input({
              attendancePct: a, submissionRate: s, vleActiveDayRate: v,
              attendanceSlope: sl, averageGrade: g,
            }));
            assert.ok(r.codes.length <= 1, `${a}/${s}/${v}/${sl}/${g} -> ${r.codes}`);
            for (const c of r.codes) assert.ok(DIVERGENCE_CODES.includes(c), c);
          }
        }
      }
    }
  }
});

test("a student whose figures all agree raises nothing", () => {
  // The ordinary case, and the one that must stay quiet: 55 across the board is a student
  // with problems the composite score will report perfectly well, and no disagreement at
  // all. A layer that fired here would fire for everybody.
  const r = evaluate(input({
    attendancePct: 55, submissionRate: 55, vleActiveDayRate: 55, averageGrade: 55,
    gradedCount: 6, attendanceSlope: 0,
  }));
  assert.deepEqual(r.codes, []);
  assert.equal(r.divergenceShape, null);
  assert.equal(r.attendanceSubmissionGap, 0);
  assert.equal(r.attendanceVleGap, 0);
});

test("evaluate does not re-report any figure that already has a column of its own", () => {
  // TRAP 5, asserted. A second copy under a slightly different name is exactly how two
  // figures that must agree begin disagreeing, and the disagreement surfaces at an appeal.
  const r = evaluate(input({
    attendancePct: 95, submissionRate: 5, averageGrade: 60, attendanceSlope: -20,
    vleActiveDayRate: 40,
  }));
  for (const forbidden of [
    "attendanceSlope", "submissionRate", "onTimeRate", "averageGrade", "gradeTrend",
    "gradeVolatility", "attendancePct", "overallAttendance", "vleActiveDayRate",
    "vleObservedDays", "attendanceObservations", "gradedCount", "weeksIntoProgramme",
  ]) {
    assert.equal(Object.hasOwn(r, forbidden), false, `re-reports ${forbidden}`);
  }
  assert.deepEqual(Object.keys(r).sort(),
    ["attendanceSubmissionGap", "attendanceVleGap", "codes", "divergenceShape"]);
});

test("no returned key looks like a day count", () => {
  // Nothing in this feature runs on a schedule — markStale fires on data events and a day
  // passing is not one — so a day count written to a column is wrong by the next morning
  // with nothing to correct it. This module returns no dates either, but the guard is
  // cheap and the next figure added here might be one.
  const r = evaluate(input());
  for (const k of Object.keys(r)) {
    assert.equal(/days?(Since|Until|Ago)|^days/i.test(k), false, k);
  }
});

/* ========================================================================== */
/* Source-level guards                                                         */
/* ========================================================================== */

test("the module contains no null-coercing idiom outside its comments", () => {
  // The claim the header makes, checked rather than trusted. `|| 0`, `?? 0`, `Number(x)`
  // and `parseFloat` are the four idioms that turn "not measurable" into "zero" without
  // looking like they are doing anything, and every one of them would fire this module's
  // codes hardest for the students the college knows least about.
  //
  // Comments are stripped first, because the header discusses all four by name.
  const src = fs.readFileSync(path.join(__dirname, "divergence.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  for (const idiom of [/\|\|\s*0\b/, /\?\?/, /\bNumber\s*\(/, /\bparseFloat\s*\(/, /\bparseInt\s*\(/]) {
    assert.equal(idiom.test(src), false, `source contains ${idiom}`);
  }
  // And the stripper must actually have work to do, or this test discriminates nothing —
  // a comment-free file would pass it vacuously.
  assert.ok(src.length > 0);
  assert.ok(src.includes("function gap"), "the stripper removed the code as well");
  assert.ok(!src.includes("TRAP 1"), "comments were not stripped, so the test proves nothing");
});
