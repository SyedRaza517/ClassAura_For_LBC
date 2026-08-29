// Tests for the assessment-type layer: does this student fail a particular KIND of work?
//
// No database. assessmentType.js is pure — it takes the percentages metrics.js has
// already computed, the type string off each assessment, and an institution-wide probe
// result, and returns plain data.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS on purpose, in the house style: what does NOT
// fire, what comes back null rather than zero, and what is refused outright. This module
// has exactly one code and five separate reasons to say nothing, so most of what is worth
// testing is what it declines to say — and a refusal is the thing that looks identical to
// a working feature right up until somebody opens the caseload and finds a hundred
// identical rows.
//
// EVERY TEST TITLE STATES EXACTLY WHAT ITS ASSERTIONS CHECK. A test here titled "every
// figure is null" must assert null for every figure it names, including the counts — a
// title that over-claims by one field is how a real defect walked through a thirty-two
// mutant run in this directory.
//
// Run with: node --test src/prediction/assessmentType.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluate, typeShape, assertInstitutionProbe,
  ASSESSMENT_TYPE, ASSESSMENT_TYPE_CODES, ASSESSMENT_TYPE_DEFAULTS,
} = require("./assessmentType");

// All nine vocabularies that already write into riskDriverCodes, imported one by one
// rather than through a loop over filenames. A loop would be shorter and would go quiet
// the day a module was renamed; these nine lines fail to resolve instead.
const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");
const { COHORT_CODES } = require("./cohort");
const { WORKLOAD_CODES } = require("./workload");
const { FUNDING_CODES } = require("./funding");
const { SESSIONS_CODES } = require("./sessions");
const { INTAKE_CODES } = require("./intake");
const { HISTORY_CODES } = require("./history");
const { DIVERGENCE_CODES } = require("./divergence");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A college whose gradebook distinguishes assessment types. */
const TYPED = { assessmentTypesRecorded: true };
/** A college where Assessment.type is "Assignment" on every row — the ordinary state,
 *  and the guaranteed state at any Moodle-synced college, because moodle.js hardcodes it. */
const UNTYPED_COLLEGE = { assessmentTypesRecorded: false };

/** The prediction pass mark, as settings.js defaults it. Stated once so a test that
 *  changes it has to say so. */
const PASS = { passThreshold: 40 };

const grade = (pct, type) => ({ pct, type });

/** `n` marked pieces of one type, all at the same percentage. */
const many = (n, pct, type) => Array.from({ length: n }, () => grade(pct, type));

/** The shape a caller hands evaluate(), with everything benign unless a test says so. */
const input = (over = {}) => ({
  grades: [],
  weeksIntoProgramme: 20,
  institution: TYPED,
  ...over,
});

/**
 * THE CANONICAL FIRING CASE, and every negative test below is this with one thing
 * changed. Three exams, all failed, against four assignments, all passed:
 *
 *   Exam        3 graded, 0 passed, passRate 0,   mean 20
 *   Assignment  4 graded, 4 passed, passRate 100, mean 75
 *   passRateGap 100, meanGap 55
 *
 * It clears every floor by exactly one piece of work on the thin side, so a test that
 * removes one assignment or one exam lands directly on the guard it is aimed at.
 */
const FAILS_EXAMS = [...many(3, 20, "Exam"), ...many(4, 75, "Assignment")];

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

test("the vocabulary holds exactly one code, and it is namespaced TRIP_", () => {
  // The count is pinned deliberately, not incidentally. The design decision recorded in
  // the header is that there is ONE code and the type arrives beside it as a figure —
  // never TRIP_FAILS_EXAMS, TRIP_FAILS_PRESENTATIONS and three more, because
  // Assessment.type is a mutable array in a route file and a vocabulary that grows when
  // somebody adds "Viva" cannot be asserted disjoint against the nine below.
  //
  // The prefix is structural. These strings are appended to riskDriverCodes, the same
  // array engine.js fills from its six RED indicators. A code named RED_something would
  // read as the engine's own, and the next person to take redIndicatorCount off the copy
  // rather than off engine.js's internal `reds` array would silently wire the shape of an
  // exam timetable into a student's band via OVR-004.
  assert.equal(ASSESSMENT_TYPE_CODES.length, 1);
  for (const code of ASSESSMENT_TYPE_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with any of the nine vocabularies already writing that column", () => {
  // Ten files will write into the same array and all ten sets of strings outlive the
  // screen that renders them. A duplicate would make two different findings
  // indistinguishable on the caseload, and history rows are what an appeal is argued from.
  const existing = [
    ["tripwires", TRIP_CODES],
    ["coverage", COVERAGE_CODES],
    ["cohort", COHORT_CODES],
    ["workload", WORKLOAD_CODES],
    ["funding", FUNDING_CODES],
    ["sessions", SESSIONS_CODES],
    ["intake", INTAKE_CODES],
    ["history", HISTORY_CODES],
    ["divergence", DIVERGENCE_CODES],
  ];

  // THE LIST ITSELF IS ASSERTED BEFORE IT IS USED, and this is not ceremony. A duplicated
  // entry in a list exactly like this one — the same array imported under two names —
  // once let eleven codes ship from a module nobody was comparing against, because the
  // loop below ran nine times over eight distinct vocabularies and looked green. Three
  // checks: nine entries, nine distinct names, and nine sets whose union is as large as
  // their total length, which is the only one of the three that catches the same array
  // arriving twice.
  assert.equal(existing.length, 9, "nine vocabularies already write riskDriverCodes");
  assert.equal(new Set(existing.map(([n]) => n)).size, 9, "the nine names must be distinct");
  const total = existing.reduce((n, [, codes]) => n + codes.length, 0);
  const union = new Set(existing.flatMap(([, codes]) => codes));
  assert.equal(union.size, total, "a vocabulary appears twice, or two of the nine collide");
  for (const [name, codes] of existing) {
    assert.ok(codes.length > 0, `${name} exported an empty vocabulary — wrong import?`);
  }

  for (const code of ASSESSMENT_TYPE_CODES) {
    for (const [name, codes] of existing) {
      assert.equal(codes.includes(code), false, `${code} is already emitted by ${name}`);
    }
  }
});

/* ========================================================================== */
/* TRAP TWO: the institution probe, and it throws                              */
/* ========================================================================== */

test("typeShape throws when the institution probe is missing entirely", () => {
  // Loudly, at the first call, the way db.js fails a query with no tenant context. A
  // boolean that defaults to falsy would cost the whole type dimension permanently and
  // silently — every figure null for every student at every college, no test failing, no
  // row looking wrong.
  assert.throws(() => typeShape(FAILS_EXAMS, undefined, PASS), TypeError);
  assert.throws(() => typeShape(FAILS_EXAMS, null, PASS), TypeError);
  assert.throws(() => typeShape(FAILS_EXAMS, {}, PASS), TypeError);
});

test("typeShape throws on a truthy probe that is not a boolean", () => {
  // The mistake this catches is a caller writing `{ assessmentTypesRecorded: rowCount }`
  // or `"true"` from a query string. Both are truthy, both would sail past a `!probe`
  // check, and a count of 0 would then read as false while a count of 4000 read as true —
  // which happens to be right, until somebody passes the count of a DIFFERENT thing.
  assert.throws(() => typeShape(FAILS_EXAMS, { assessmentTypesRecorded: "yes" }, PASS), TypeError);
  assert.throws(() => typeShape(FAILS_EXAMS, { assessmentTypesRecorded: 1 }, PASS), TypeError);
  assert.throws(() => typeShape(FAILS_EXAMS, { assessmentTypesRecorded: 0 }, PASS), TypeError);
  assert.throws(() => typeShape(FAILS_EXAMS, { kindRecorded: true }, PASS), TypeError);
});

test("typeShape accepts a boolean probe of either value without throwing", () => {
  // The positive control for the three refusals above: false is a legitimate answer and
  // must not be mistaken for a missing one. Without this, a guard written as
  // `if (!institution.assessmentTypesRecorded) throw` would pass every test above.
  assert.doesNotThrow(() => typeShape(FAILS_EXAMS, { assessmentTypesRecorded: false }, PASS));
  assert.doesNotThrow(() => typeShape(FAILS_EXAMS, { assessmentTypesRecorded: true }, PASS));
});

test("evaluate throws without the probe, before it looks at anything else", () => {
  assert.throws(() => evaluate(input({ institution: undefined }), PASS), TypeError);
  assert.throws(() => evaluate(input({ institution: {} }), PASS), TypeError);
  assert.throws(() => evaluate(undefined, PASS), TypeError);
  // Even with a perfectly firing corpus in hand. A caller who forgot the probe finds out
  // on their first fixture rather than after a term of blank columns.
  assert.throws(() => evaluate({ grades: FAILS_EXAMS }, PASS), TypeError);
});

test("assertInstitutionProbe names the calling function in its message", () => {
  // The message is the only thing a wiring author sees, and "must be a boolean" with no
  // caller is a message that sends somebody to the wrong file.
  assert.throws(() => assertInstitutionProbe(null, "someCaller"), /someCaller/);
  assert.throws(() => assertInstitutionProbe(null, "someCaller"), /assessmentTypesRecorded/);
});

test("a college that records no types: every figure is null, typesMeasured is null, and nothing fires", () => {
  // The whole corpus comes back as `untyped` so a reader can see nothing was measured
  // rather than that nothing was found — sessions.kindShape's kindUnset, pointed at a
  // gradebook. Returning zeroes here would say "we looked at the types and there were
  // none" about a college where every row says "Assignment".
  const r = typeShape(FAILS_EXAMS, UNTYPED_COLLEGE, PASS);
  assert.deepEqual(r.types, []);
  assert.equal(r.worstType, null);
  assert.equal(r.worstTypePassRate, null);
  assert.equal(r.worstTypeMeanPct, null);
  assert.equal(r.passRateGap, null);
  assert.equal(r.meanGap, null);
  assert.equal(r.typesMeasured, null);
  assert.equal(r.typesSeen, 0);
  assert.equal(r.untyped, 7);
  assert.equal(r.unscored, 0);

  const e = evaluate(input({ grades: FAILS_EXAMS, institution: UNTYPED_COLLEGE }), PASS);
  assert.deepEqual(e.codes, []);
  assert.equal(e.worstAssessmentType, null);
  assert.equal(e.assessmentTypesMeasured, null);
  assert.equal(e.untypedGradeCount, 7);
});

test("typesMeasured separates 'the college does not record types' from 'this student has one type'", () => {
  // THE BUG THE PROBE EXISTS FOR, and the reason the floor below cannot stand in for it.
  // Eight marked pieces all carrying "Assignment" are the same array in both colleges. At
  // a college that USES types it is a real absence of evidence — no exam record yet, one
  // may arrive next term — and typesMeasured is 1: the question was asked. At a college
  // that has never set the field it is eight rows of unknown type wearing a default, and
  // typesMeasured is null: the question could not be asked.
  //
  // Both produce a null worstType, which is why a test asserting only the nulls would
  // discriminate nothing. The counts are the discriminating half.
  const allCoursework = many(8, 70, "Assignment");

  const asked = typeShape(allCoursework, TYPED, PASS);
  assert.equal(asked.typesMeasured, 1);
  assert.equal(asked.typesSeen, 1);
  assert.equal(asked.untyped, 0);
  assert.equal(asked.worstType, null);

  const unaskable = typeShape(allCoursework, UNTYPED_COLLEGE, PASS);
  assert.equal(unaskable.typesMeasured, null);
  assert.equal(unaskable.typesSeen, 0);
  assert.equal(unaskable.untyped, 8);
  assert.equal(unaskable.worstType, null);

  assert.notEqual(asked.typesMeasured, unaskable.typesMeasured);
});

/* ========================================================================== */
/* TRAP ONE: minimum denominators, on BOTH sides                               */
/* ========================================================================== */

test("the canonical case fires — the positive control every negative below is measured against", () => {
  // Without this, every "does not fire" assertion in this file would pass against a
  // module that never fires at all.
  const r = evaluate(input({ grades: FAILS_EXAMS }), PASS);
  assert.deepEqual(r.codes, [ASSESSMENT_TYPE.TYPE_FAILING]);
  assert.equal(r.worstAssessmentType, "Exam");
  assert.equal(r.worstAssessmentTypePassRate, 0);
  assert.equal(r.worstAssessmentTypeMeanPct, 20);
  assert.equal(r.assessmentTypePassRateGap, 100);
  assert.equal(r.assessmentTypeMeanGap, 55);
  assert.equal(r.assessmentTypesMeasured, 2);
});

test("one failed exam names no worst type and raises nothing — a superlative over one candidate", () => {
  // "Failed 100% of exams" from a single exam is the loudest thing on the screen and the
  // emptiest. The Exam bucket has its own arithmetic and it is still reported — a
  // measurement is a measurement — but it is not `measurable`, so it cannot be named.
  const r = typeShape([grade(20, "Exam"), ...many(6, 75, "Assignment")], TYPED, PASS);
  const exam = r.types.find((t) => t.type === "Exam");
  assert.equal(exam.graded, 1);
  assert.equal(exam.passRate, 100 - 100);   // 0% — the arithmetic is right
  assert.equal(exam.measurable, false);     // and it is still not reportable
  assert.equal(r.typesMeasured, 1);
  assert.equal(r.worstType, null);
  assert.equal(r.passRateGap, null);
  assert.equal(r.meanGap, null);

  const e = evaluate(input({ grades: [grade(20, "Exam"), ...many(6, 75, "Assignment")] }), PASS);
  assert.deepEqual(e.codes, []);
});

test("two failed exams still name no worst type — the floor is three, not two", () => {
  // Two pieces reach pass rates of 0, 50 and 100 only, so a single resit failure reads
  // exactly like a student who cannot sit exams.
  const r = typeShape([...many(2, 20, "Exam"), ...many(5, 75, "Assignment")], TYPED, PASS);
  assert.equal(r.typesMeasured, 1);
  assert.equal(r.worstType, null);
  assert.deepEqual(evaluate(input({ grades: [...many(2, 20, "Exam"), ...many(5, 75, "Assignment")] }), PASS).codes, []);
});

test("a thin OTHER side names the worst type but withholds both gaps and raises nothing", () => {
  // THE HALF-GUARD THIS FILE IS MOST AT RISK OF. Three failed exams against three passed
  // assignments is a hundred-point gap drawn from three rows on the side that is supposed
  // to be the steady one. The worst type's OWN rates survive — they cleared their own
  // floor — and the gaps, which are what the code is gated on, do not.
  const grades = [...many(3, 20, "Exam"), ...many(3, 75, "Assignment")];
  const r = typeShape(grades, TYPED, PASS);
  assert.equal(r.typesMeasured, 2, "both types cleared their own floor");
  assert.equal(r.worstType, "Exam");
  assert.equal(r.worstTypePassRate, 0);
  assert.equal(r.worstTypeMeanPct, 20);
  assert.equal(r.passRateGap, null, "the pooled side holds three pieces, one short of four");
  assert.equal(r.meanGap, null);

  assert.deepEqual(evaluate(input({ grades }), PASS).codes, []);
});

test("one more piece on the other side is all that separates silence from the code", () => {
  // The pair with the test above, and it is what proves that guard discriminates rather
  // than the module simply being quiet. Three assignments: nothing. Four: the code.
  const three = [...many(3, 20, "Exam"), ...many(3, 75, "Assignment")];
  const four = [...many(3, 20, "Exam"), ...many(4, 75, "Assignment")];
  assert.deepEqual(evaluate(input({ grades: three }), PASS).codes, []);
  assert.deepEqual(evaluate(input({ grades: four }), PASS).codes, [ASSESSMENT_TYPE.TYPE_FAILING]);
});

test("a student assessed on only one type has no comparison, whatever the pass rate", () => {
  // Not "0% gap". Nine failed assignments and nothing else is a student in trouble and
  // TRIP_RECENT_FAIL and TRIP_UNITS_UNPASSED are the codes for it; this module's question
  // — is there a KIND of work they fail — has no answer for them.
  const grades = many(9, 15, "Assignment");
  const r = typeShape(grades, TYPED, PASS);
  assert.equal(r.typesSeen, 1);
  assert.equal(r.typesMeasured, 1);
  assert.equal(r.worstType, null);
  assert.equal(r.worstTypePassRate, null);
  assert.equal(r.passRateGap, null);
  assert.equal(r.meanGap, null);
  assert.deepEqual(evaluate(input({ grades }), PASS).codes, []);
});

/* ========================================================================== */
/* TRAP FIVE: what a whole cohort could share, and the three gates             */
/* ========================================================================== */

test("a student failing EVERY type raises nothing — there is no gap to find", () => {
  // The struggling-cohort guard, and it is arithmetic rather than a fourth constant: with
  // both sides failing, the pass-rate gap is nil however bad the marks are. This is also
  // what stops the module from being a second, worse copy of the low-average red
  // indicator.
  const grades = [...many(4, 15, "Exam"), ...many(4, 18, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.deepEqual(r.codes, []);
  assert.equal(r.assessmentTypePassRateGap, 0);
});

test("a uniformly borderline student raises nothing despite a hundred-point pass-rate gap", () => {
  // THE SHARPEST TEST IN THIS FILE, and the whole reason meanGap exists as a second gate.
  // Exams at 38, 39, 39 against coursework at 41, 42, 41, 42: a pass rate of 0% against
  // 100%, the loudest reading the module can produce, from marks under three points
  // apart. This student fails everything narrowly. Telling them the answer is exam
  // technique is worse than telling them nothing — it is specific, confident and wrong,
  // and it costs them the general academic support they need.
  const grades = [grade(38, "Exam"), grade(39, "Exam"), grade(39, "Exam"),
                  grade(41, "Assignment"), grade(42, "Assignment"),
                  grade(41, "Assignment"), grade(42, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.assessmentTypePassRateGap, 100, "the threshold says they are opposites");
  assert.ok(r.assessmentTypeMeanGap < ASSESSMENT_TYPE_DEFAULTS.typeMeanGap,
    "and the marks say they are the same student");
  assert.deepEqual(r.codes, []);
});

test("doing worse at one type while still PASSING it raises nothing", () => {
  // The absolute half, and the reason the gap alone is a figure. Exams at 55 against
  // coursework at 85 is a thirty-point difference in marks and is the ordinary shape of
  // assessment design at nearly every college — coursework is done with notes, over
  // weeks, with feedback; an exam is done once, against a clock. A code fired on that
  // lands on a whole cohort at once.
  const grades = [...many(3, 55, "Exam"), ...many(4, 85, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.worstAssessmentType, "Exam");
  assert.equal(r.worstAssessmentTypePassRate, 100);
  assert.equal(r.assessmentTypeMeanGap, 30, "the marks differ by thirty points");
  assert.equal(r.assessmentTypePassRateGap, 0, "and nobody has failed anything");
  assert.deepEqual(r.codes, []);
});

test("passing half of one type raises nothing — the ceiling is 34, not 'below average'", () => {
  // Two exams passed out of four is a 50% pass rate against 100% elsewhere: a fifty-point
  // pass-rate gap and a forty-seven-point mean gap, both well over their thresholds. It
  // still does not fire, because at half the student passes this type sometimes and the
  // finding is not "they fail it". CLAUDE.md: "Being below average is not a risk."
  const grades = [grade(55, "Exam"), grade(55, "Exam"), grade(20, "Exam"), grade(20, "Exam"),
                  ...many(4, 85, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.worstAssessmentTypePassRate, 50);
  assert.ok(r.assessmentTypePassRateGap >= ASSESSMENT_TYPE_DEFAULTS.typePassRateGap);
  assert.ok(r.assessmentTypeMeanGap >= ASSESSMENT_TYPE_DEFAULTS.typeMeanGap);
  assert.deepEqual(r.codes, [], "both relative gates clear; the absolute one does not");
});

test("passing one of three fires — the ceiling was chosen against the quantisation", () => {
  // At the minimum denominator of three the reachable pass rates are 0, 33.3, 66.7 and
  // 100. A ceiling of 33 would exclude "passed one of three exams" by a rounding artefact
  // rather than by a decision, and nobody would ever notice the decision had been made.
  const grades = [grade(60, "Exam"), grade(20, "Exam"), grade(20, "Exam"), ...many(4, 90, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.worstAssessmentTypePassRate, 33.3);
  assert.deepEqual(r.codes, [ASSESSMENT_TYPE.TYPE_FAILING]);

  // And the same corpus under a college that set the ceiling at 33 goes silent — which is
  // what pins 34 as a decision rather than an accident of rounding.
  const strict = evaluate(input({ grades }), { ...PASS, typePassRateCeiling: 33 });
  assert.deepEqual(strict.codes, []);
});

/* ========================================================================== */
/* Thresholds: each gate, one step either side                                 */
/* ========================================================================== */

test("the pass-rate gap gate holds at exactly 40 and refuses at 41", () => {
  // Exams 0% against a pooled rest of exactly 40%, which is the threshold on the nose.
  // Boundaries are tested by moving the CONFIG rather than by contriving a fixture one
  // tenth of a point away, so what is being pinned is the comparison and not the
  // arithmetic that feeds it.
  const grades = [...many(3, 20, "Exam"),
                  grade(60, "Assignment"), grade(60, "Assignment"),
                  grade(20, "Assignment"), grade(20, "Assignment"), grade(20, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.assessmentTypePassRateGap, 40);
  assert.deepEqual(r.codes, [ASSESSMENT_TYPE.TYPE_FAILING], "at the threshold it fires");
  assert.deepEqual(evaluate(input({ grades }), { ...PASS, typePassRateGap: 41 }).codes, [],
    "one point above it, nothing");
});

test("the mean gap gate holds at exactly 10 and refuses at 10.1", () => {
  const grades = [...many(3, 30, "Exam"), ...many(4, 40, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.assessmentTypeMeanGap, 10);
  assert.equal(r.assessmentTypePassRateGap, 100);
  assert.deepEqual(r.codes, [ASSESSMENT_TYPE.TYPE_FAILING]);
  assert.deepEqual(evaluate(input({ grades }), { ...PASS, typeMeanGap: 10.1 }).codes, []);
});

test("the pass-rate ceiling holds at exactly 34 and refuses at 33.2", () => {
  const grades = [grade(60, "Exam"), grade(20, "Exam"), grade(20, "Exam"), ...many(4, 90, "Assignment")];
  assert.deepEqual(evaluate(input({ grades }), { ...PASS, typePassRateCeiling: 34 }).codes,
    [ASSESSMENT_TYPE.TYPE_FAILING]);
  assert.deepEqual(evaluate(input({ grades }), { ...PASS, typePassRateCeiling: 33.2 }).codes, []);
});

test("the defaults are the ones the module documents", () => {
  // Pinned so a change to a constant is a change to a test, with the argument beside it in
  // the module, rather than a number quietly moving under a green suite.
  assert.deepEqual(ASSESSMENT_TYPE_DEFAULTS, {
    // Restated from settings.js rather than owned here — see the test below. Without it a
    // bare call compares every mark against undefined and reports a straight-A student as
    // failing everything.
    passThreshold: 40,
    typeMinGrades: 3,
    typeMinOtherGrades: 4,
    minTypesMeasured: 2,
    typePassRateCeiling: 34,
    typePassRateGap: 40,
    typeMeanGap: 10,
  });
});

/* ========================================================================== */
/* TRAP THREE: null means not measurable, zero means zero                      */
/* ========================================================================== */

test("a student with no marked work: every rate and gap is null, and typesMeasured is 0", () => {
  // ZERO, NOT NULL, for typesMeasured — and the title says so, because the distinction is
  // the point. This college records types, so the question WAS asked; the answer is that
  // no type of this student's work cleared the floor. That is a statement about a sample,
  // and it is a different statement from the null the probe branch returns.
  const r = typeShape([], TYPED, PASS);
  assert.deepEqual(r.types, []);
  assert.equal(r.worstType, null);
  assert.equal(r.worstTypePassRate, null);
  assert.equal(r.worstTypeMeanPct, null);
  assert.equal(r.passRateGap, null);
  assert.equal(r.meanGap, null);
  assert.equal(r.typesMeasured, 0);
  assert.equal(r.typesSeen, 0);
  assert.equal(r.untyped, 0);
  assert.equal(r.unscored, 0);
  assert.deepEqual(evaluate(input({ grades: [] }), PASS).codes, []);
});

test("a type the student has never been assessed on gets no bucket, not a 0% one", () => {
  // Trap three, and it falls out of building the buckets FROM the grades rather than from
  // the five known types. An implementation that seeded the type list to "make the array
  // complete" would report every student as failing 100% of Presentations, Projects and
  // Portfolios that nobody has ever set them.
  const r = typeShape(FAILS_EXAMS, TYPED, PASS);
  assert.deepEqual(r.types.map((t) => t.type), ["Assignment", "Exam"]);
  assert.equal(r.types.find((t) => t.type === "Presentation"), undefined);
  for (const t of r.types) assert.ok(t.graded > 0, `${t.type} has an empty denominator`);
});

test("untyped grades leave both sides of every fraction and are counted", () => {
  // Five untyped zeroes added to the canonical case. If any of them reached the pooled
  // rest the mean gap would collapse from 55 and the pass-rate gap from 100; if they
  // reached the Exam bucket its mean would move off 20. Every figure is asserted equal to
  // the canonical one, so nothing can slip into either side unnoticed.
  const noise = [grade(0, ""), grade(0, "   "), grade(0, null), grade(0, undefined), { pct: 0 }];
  const r = evaluate(input({ grades: [...FAILS_EXAMS, ...noise] }), PASS);
  assert.equal(r.untypedGradeCount, 5);
  assert.equal(r.worstAssessmentType, "Exam");
  assert.equal(r.worstAssessmentTypeMeanPct, 20);
  assert.equal(r.assessmentTypePassRateGap, 100);
  assert.equal(r.assessmentTypeMeanGap, 55);
  assert.equal(r.assessmentTypesSeen, 2);
  assert.deepEqual(r.codes, [ASSESSMENT_TYPE.TYPE_FAILING]);
});

test("a grade with no usable percentage is not a mark of zero", () => {
  // Three unscorable exam rows on top of three real ones. If they were coerced to 0 the
  // Exam bucket would hold six pieces at a mean of 10 instead of three at 20 — a figure
  // that looks like evidence and is a description of a broken gather.
  const broken = [{ pct: null, type: "Exam" }, { pct: undefined, type: "Exam" },
                  { pct: NaN, type: "Exam" }, { pct: "20", type: "Exam" }, null];
  const r = typeShape([...FAILS_EXAMS, ...broken], TYPED, PASS);
  const exam = r.types.find((t) => t.type === "Exam");
  assert.equal(exam.graded, 3);
  assert.equal(exam.meanPct, 20);
  assert.equal(r.unscored, 5);
  assert.equal(r.untyped, 0, "an unscorable row is unscored, never untyped");
});

test("a corpus of nothing but untyped work reports it as untyped, not as a clean sheet", () => {
  const grades = many(9, 70, "");
  const r = typeShape(grades, TYPED, PASS);
  assert.equal(r.untyped, 9);
  assert.equal(r.typesSeen, 0);
  assert.equal(r.typesMeasured, 0);
  assert.equal(r.worstType, null);
  assert.deepEqual(evaluate(input({ grades }), PASS).codes, []);
});

/* ========================================================================== */
/* TRAP FOUR: the percentage is taken, never re-derived                        */
/* ========================================================================== */

test("only `pct` is read — `marks` and `maxMarks` on the same row are ignored", () => {
  // metrics.js line 866 already divides marks by maxMarks, with the `maxMarks > 0 ? … :
  // 100` guard that a second implementation forgets. These rows carry a pct of 90 beside
  // a marks/maxMarks pair that would derive 1%: if anything here re-derived, every Exam
  // would be a fail and the module would name Exam as the worst type.
  const grades = [
    { pct: 90, type: "Exam", marks: 1, maxMarks: 100 },
    { pct: 90, type: "Exam", marks: 1, maxMarks: 100 },
    { pct: 90, type: "Exam", marks: 1, maxMarks: 100 },
    ...many(4, 70, "Assignment"),
  ];
  const r = typeShape(grades, TYPED, PASS);
  const exam = r.types.find((t) => t.type === "Exam");
  assert.equal(exam.passed, 3, "a re-derivation would score these 1% and fail all three");
  assert.equal(exam.meanPct, 90);
  assert.equal(r.worstType, "Assignment", "Assignment is the lower mean at an equal pass rate");
  assert.deepEqual(evaluate(input({ grades }), PASS).codes, []);
});

test("a maxMarks of zero on the row cannot produce a NaN, because the row is never divided", () => {
  // The specific shape of the drift this refusal avoids: a second division would hit
  // `marks / 0` and put Infinity or NaN into a mean, which then propagates silently
  // through every comparison as `false`.
  const grades = [...many(3, 25, "Exam").map((g) => ({ ...g, marks: 5, maxMarks: 0 })),
                  ...many(4, 80, "Assignment")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.worstAssessmentTypeMeanPct, 25);
  assert.equal(Number.isFinite(r.assessmentTypeMeanGap), true);
});

/* ========================================================================== */
/* The pass threshold is the college's, not a literal                          */
/* ========================================================================== */

test("the pass threshold comes from config — the same marks answer differently at 40 and 50", () => {
  // routes/assessments.js bands the gradebook screen at 50 and settings.js defaults the
  // prediction pass mark to 40. A college that raises its progression pass mark in
  // Settings is entitled to expect this figure to move with it, and a literal here would
  // silently disagree with the failCount sitting beside it on the same row.
  const grades = [...many(3, 45, "Exam"), ...many(4, 85, "Assignment")];

  const at40 = evaluate(input({ grades }), { passThreshold: 40 });
  assert.equal(at40.worstAssessmentTypePassRate, 100, "45 clears a pass mark of 40");
  assert.deepEqual(at40.codes, []);

  const at50 = evaluate(input({ grades }), { passThreshold: 50 });
  assert.equal(at50.worstAssessmentTypePassRate, 0, "45 does not clear a pass mark of 50");
  assert.equal(at50.worstAssessmentType, "Exam");
  assert.deepEqual(at50.codes, [ASSESSMENT_TYPE.TYPE_FAILING]);
});

test("a mark sitting exactly on the pass mark passes", () => {
  // Stated the same way up as tripwires.attainmentShape's `p < passThreshold` counts a
  // fail. Two definitions of "pass" in one pipeline is how a pass rate comes to disagree
  // with the fail count printed next to it.
  const r = typeShape([...many(3, 40, "Exam"), ...many(4, 90, "Assignment")], TYPED, PASS);
  assert.equal(r.types.find((t) => t.type === "Exam").passed, 3);
  assert.equal(r.types.find((t) => t.type === "Exam").failed, 0);
});

/* ========================================================================== */
/* Determinism, ordering and the tie-break                                     */
/* ========================================================================== */

test("the answer does not depend on the order Postgres returned the grades in", () => {
  // Map iteration order is insertion order, and the gather has no ORDER BY on grades. A
  // figure that changed between two runs with nothing about the student having changed
  // makes the whole row untrustworthy.
  const forward = [...many(3, 20, "Exam"), ...many(4, 75, "Assignment"), ...many(2, 60, "Project")];
  const backward = [...forward].reverse();
  const shuffled = [forward[4], forward[8], forward[0], forward[6], forward[2],
                    forward[7], forward[1], forward[5], forward[3]];
  const a = typeShape(forward, TYPED, PASS);
  assert.deepEqual(typeShape(backward, TYPED, PASS), a);
  assert.deepEqual(typeShape(shuffled, TYPED, PASS), a);
  assert.deepEqual(a.types.map((t) => t.type), ["Assignment", "Exam", "Project"]);
});

test("tied pass rates break to the lower mean, not to whichever arrived first", () => {
  // Two types at 0% are not equally bad if one averages 38 and the other 9, and the mean
  // is the finer instrument. Both orderings are asserted, because a tie-break that reads
  // the first element is right half the time by luck.
  const low = [...many(3, 9, "Exam"), ...many(3, 38, "Project"), ...many(4, 90, "Assignment")];
  assert.equal(typeShape(low, TYPED, PASS).worstType, "Exam");
  assert.equal(typeShape([...low].reverse(), TYPED, PASS).worstType, "Exam");
});

test("a genuine tie on both figures breaks alphabetically and stays there under reordering", () => {
  // The last resort, and it has to be stable: two types identical on every number must
  // not swap places between runs, because the type is STORED and a history row that
  // alternated between "Exam" and "Project" would be unarguable at an appeal.
  const tied = [...many(3, 20, "Exam"), ...many(3, 20, "Project"), ...many(4, 90, "Assignment")];
  assert.equal(typeShape(tied, TYPED, PASS).worstType, "Exam");
  assert.equal(typeShape([...tied].reverse(), TYPED, PASS).worstType, "Exam");
});

test("a leading or trailing space is the same type, not a second bucket", () => {
  // Two buckets would halve both denominators and could put a type under its own floor.
  const r = typeShape([grade(20, "Exam"), grade(20, " Exam"), grade(20, "Exam "), ...many(4, 75, "Assignment")],
    TYPED, PASS);
  assert.equal(r.typesSeen, 2);
  assert.equal(r.types.find((t) => t.type === "Exam").graded, 3);
});

test("casing is NOT folded — the stored string is the one the college typed", () => {
  // routes/assessments.js validates hand-entered types against a fixed list and moodle.js
  // writes the literal "Assignment", so neither write path can produce a casing variant.
  // Folding would put a type name the college never typed onto a screen and into a stored
  // history row, to solve a problem that cannot occur.
  const r = typeShape([...many(3, 20, "Exam"), ...many(3, 20, "exam"), ...many(4, 90, "Assignment")], TYPED, PASS);
  assert.equal(r.typesSeen, 3);
  assert.deepEqual(r.types.map((t) => t.type), ["Assignment", "Exam", "exam"]);
});

/* ========================================================================== */
/* The pooled side: thin types in, gaps unclamped                              */
/* ========================================================================== */

test("types too thin to be named still count in the pooled rest", () => {
  // The pooled side is meant to be the large denominator, and excluding the pieces that
  // could not be named would shrink the only number in the comparison that is supposed to
  // be steady. Two Portfolio marks at 10 drag the pooled mean down; if they had been
  // dropped the mean gap would be larger.
  const withThin = [...many(3, 20, "Exam"), ...many(4, 75, "Assignment"), ...many(2, 10, "Portfolio")];
  const r = typeShape(withThin, TYPED, PASS);
  assert.equal(r.typesSeen, 3);
  assert.equal(r.typesMeasured, 2, "Portfolio holds two pieces and cannot be named");
  assert.equal(r.worstType, "Exam");
  // Pooled rest: four at 75 and two at 10 → mean 53.3, pass rate 66.7.
  assert.equal(r.meanGap, 33.3);
  assert.equal(r.passRateGap, 66.7);
});

test("a negative gap is reported as negative, never clamped to zero", () => {
  // The worst NAMEABLE type can sit above the pooled rest, because the pool holds types
  // too thin to name and one of them may be worse. Clamping would manufacture a tie
  // between that and a student whose work is genuinely flat.
  const grades = [...many(3, 60, "Exam"), ...many(3, 90, "Assignment"), ...many(2, 10, "Portfolio")];
  const r = evaluate(input({ grades }), PASS);
  assert.equal(r.worstAssessmentType, "Exam");
  assert.ok(r.assessmentTypeMeanGap < 0, `expected a negative mean gap, got ${r.assessmentTypeMeanGap}`);
  assert.ok(r.assessmentTypePassRateGap < 0, `expected a negative pass-rate gap, got ${r.assessmentTypePassRateGap}`);
  assert.deepEqual(r.codes, []);
});

test("the pooled mean is weighted by pieces, not averaged over the per-type means", () => {
  // A mean of means would weight a two-piece portfolio as heavily as a nine-piece
  // assignment record. Nine assignments at 80 and two portfolios at 20: the weighted
  // pooled mean is 69.1, the mean of means would be 50, and the difference is what decides
  // whether the mean gap clears its gate.
  const grades = [...many(3, 20, "Exam"), ...many(9, 80, "Assignment"), ...many(2, 20, "Portfolio")];
  const r = typeShape(grades, TYPED, PASS);
  assert.equal(r.worstType, "Exam");
  assert.equal(r.meanGap, 49.1);   // (9*80 + 2*20)/11 - 20 = 69.09… - 20
});

test("a per-type mean is rounded to one decimal place before it is stored", () => {
  // Exams at 38, 39, 39 average 38.6666…, and an unrounded float is what a stored column
  // and a screen would then carry. It also feeds the mean gap, where a repeating tail can
  // sit either side of a threshold; every other figure in this pipeline is round1'd on the
  // way out and a lone raw float here would be the one nobody noticed.
  const r = typeShape([grade(38, "Exam"), grade(39, "Exam"), grade(39, "Exam"),
                       ...many(4, 90, "Assignment")], TYPED, PASS);
  assert.equal(r.types.find((t) => t.type === "Exam").meanPct, 38.7);
  // And the pass rate beside it, for the same reason: one of three is 33.3, not
  // 33.33333333333333.
  const third = typeShape([grade(60, "Exam"), grade(20, "Exam"), grade(20, "Exam"),
                           ...many(4, 90, "Assignment")], TYPED, PASS);
  assert.equal(third.types.find((t) => t.type === "Exam").passRate, 33.3);
});

test("the pooled mean is computed from raw sums, not from the worst type's ROUNDED mean", () => {
  // The precision trap, and it is only visible when the worst bucket is as large as the
  // pooled rest — which is exactly the shape this module exists to find. Six exams
  // averaging 20.05 round to 20.1; subtracting 6 x 20.1 from the running total instead of
  // the raw sum shifts the pooled mean by 0.075 and the reported gap from 54.9 to 54.8.
  //
  // A tenth of a point is not a wrong answer, but it is enough to move a gap across a
  // threshold, and it is the kind of drift that is impossible to reconstruct at an appeal.
  const grades = [grade(20.3, "Exam"), ...many(5, 20, "Exam"), ...many(4, 75, "Assignment")];
  const r = typeShape(grades, TYPED, PASS);
  assert.equal(r.worstType, "Exam");
  assert.equal(r.worstTypeMeanPct, 20.1, "the stored per-type mean is the rounded one");
  assert.equal(r.meanGap, 54.9, "and the gap behind it is not");
});

test("a pass rate sitting exactly ON the ceiling still fires", () => {
  // The comparison is `<=`, and no fixture reaches the default 34 exactly — the reachable
  // rates at small denominators are 0, 25, 33.3, 50 and so on. So the equality is pinned
  // by moving the ceiling onto a rate the fixture does reach. Without this, a `<=` quietly
  // narrowed to `<` would pass every other test in this file.
  const grades = [grade(60, "Exam"), grade(20, "Exam"), grade(20, "Exam"), ...many(4, 90, "Assignment")];
  assert.deepEqual(evaluate(input({ grades }), { ...PASS, typePassRateCeiling: 33.3 }).codes,
    [ASSESSMENT_TYPE.TYPE_FAILING]);
});

/* ========================================================================== */
/* TRAP SIX: no dates, and no day counts either                                */
/* ========================================================================== */

test("evaluate returns exactly nine fields, none of them a date or a day count", () => {
  // The module answers a SHAPE question and a shape has no date. Nothing may be stored
  // that would be wrong by the next morning with nothing to correct it — CLAUDE.md's
  // "19 days since last attended". The key set is pinned rather than sampled, so a later
  // reader adding `daysSinceWorstTypeFailed` has to change this test and read the reason.
  const r = evaluate(input({ grades: FAILS_EXAMS }), PASS);
  assert.deepEqual(Object.keys(r).sort(), [
    "assessmentTypeMeanGap",
    "assessmentTypePassRateGap",
    "assessmentTypesMeasured",
    "assessmentTypesSeen",
    "codes",
    "untypedGradeCount",
    "worstAssessmentType",
    "worstAssessmentTypeMeanPct",
    "worstAssessmentTypePassRate",
  ]);
  for (const key of Object.keys(r)) {
    assert.equal(/days?$/i.test(key), false, `${key} reads as a day count`);
    assert.equal(/(^|[a-z])(on|At|Date)$/.test(key), false, `${key} reads as a date`);
  }
  for (const [key, value] of Object.entries(r)) {
    assert.equal(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), false,
      `${key} carries a date string`);
  }
});

test("evaluate takes no `today` and ignores one if a caller passes it", () => {
  // Pinned so that a later reader who needs a date has to add the argument deliberately
  // rather than finding one already threaded through and reaching for it.
  const withDate = evaluate(input({ grades: FAILS_EXAMS, today: "2026-08-29" }), PASS);
  const without = evaluate(input({ grades: FAILS_EXAMS }), PASS);
  assert.deepEqual(withDate, without);
});

/* ========================================================================== */
/* The settling-in exemption, deliberately not applied                         */
/* ========================================================================== */

test("a student in week zero still fires — the exemption is for codes that fire on silence", () => {
  // tripwires.evaluate mutes NO_PASTORAL_CONTACT inside the settling-in window and
  // pointedly does not mute ABSENCE_STREAK, because the exemption covers codes firing on
  // the ABSENCE of a record. This fires on the PRESENCE of seven marked pieces of work,
  // which cannot exist in week one at any real college — so muting it would be ceremony,
  // and ceremony is how a guard gets dropped from the one place it was load-bearing.
  assert.deepEqual(evaluate(input({ grades: FAILS_EXAMS, weeksIntoProgramme: 0 }), PASS).codes,
    [ASSESSMENT_TYPE.TYPE_FAILING]);
});

test("an unknown programme age still fires — muting the uncountable fails safe the wrong way", () => {
  // The second half of CLAUDE.md's rule, and the half that gets forgotten: "An *unknown*
  // programme age is deliberately not exempt", because silence about the students the
  // calendar cannot place is the wrong direction to fail in.
  for (const weeks of [null, undefined, NaN, "12"]) {
    assert.deepEqual(evaluate(input({ grades: FAILS_EXAMS, weeksIntoProgramme: weeks }), PASS).codes,
      [ASSESSMENT_TYPE.TYPE_FAILING], `weeksIntoProgramme=${String(weeks)}`);
  }
});

test("every branch that refuses to compare returns a NULL gap, never a zero", () => {
  // THE INVARIANT THE THREE isNum GUARDS IN evaluate() REST ON, pinned directly, because a
  // mutation pass showed the guards themselves are unobservable: removing all three changes
  // no behaviour today and no test can catch it.
  //
  // The reason they are still there is visible here. `null >= 40` is false, which is what
  // makes the pass-rate gate fail safe by accident — but `null <= 34` is TRUE, so the
  // absolute ceiling is held shut only by the gap being null in the same breath. If any
  // branch below started returning 0 instead of null, the code would begin firing on
  // students with nothing measured. These are the four branches, and each is asserted to
  // return nulls rather than zeros for both gaps.
  const branches = [
    ["the college records no types", typeShape(FAILS_EXAMS, UNTYPED_COLLEGE, PASS)],
    ["the student has no marked work", typeShape([], TYPED, PASS)],
    ["only one type clears the floor", typeShape(many(9, 15, "Assignment"), TYPED, PASS)],
    ["the pooled side is too thin",
      typeShape([...many(3, 20, "Exam"), ...many(3, 75, "Assignment")], TYPED, PASS)],
  ];
  for (const [why, shape] of branches) {
    assert.equal(shape.passRateGap, null, `${why}: passRateGap must be null, not 0`);
    assert.equal(shape.meanGap, null, `${why}: meanGap must be null, not 0`);
  }
  // And the one branch that names a worst type while withholding the gaps is the reason
  // "gap null implies worst null" is NOT the invariant — it is the weaker "gap null implies
  // no code", which is what the three guards are written to state out loud.
  assert.equal(branches[3][1].worstTypePassRate, 0, "the thin-pooled branch does name a rate");
  assert.deepEqual(evaluate(input({ grades: [...many(3, 20, "Exam"), ...many(3, 75, "Assignment")] }), PASS).codes, []);
});

/* ========================================================================== */
/* Defensive shapes                                                            */
/* ========================================================================== */

test("a missing grades array is not an error and is not a finding", () => {
  const r = evaluate(input({ grades: undefined }), PASS);
  assert.deepEqual(r.codes, []);
  assert.equal(r.worstAssessmentType, null);
  assert.equal(r.assessmentTypesMeasured, 0);
  assert.deepEqual(typeShape(null, TYPED, PASS).types, []);
});

test("evaluate falls back to the module defaults when config omits every floor", () => {
  // The wiring has not happened yet: settings.js carries none of these keys, so the first
  // real caller will pass a config without them. If the spread were the wrong way round
  // every floor would be undefined and every comparison silently false.
  const r = evaluate(input({ grades: FAILS_EXAMS }), { passThreshold: 40 });
  assert.deepEqual(r.codes, [ASSESSMENT_TYPE.TYPE_FAILING]);
  const noConfig = evaluate(input({ grades: FAILS_EXAMS }));
  assert.equal(noConfig.assessmentTypesMeasured, 2, "the floors still apply with no config at all");
});

test("a caller's config overrides the module default rather than the other way round", () => {
  // The direction of the spread, pinned. With typeMinGrades raised to four the canonical
  // three exams stop being nameable; if the default won, nothing would change.
  const r = typeShape(FAILS_EXAMS, TYPED, { ...PASS, typeMinGrades: 4 });
  assert.equal(r.typesMeasured, 1);
  assert.equal(r.worstType, null);
});

test("passThreshold is restated from settings.js, so a bare call is not confidently wrong", () => {
  // Without this default, `g.pct >= cfg.passThreshold` compares against undefined and is
  // false for every mark: a student passing everything at 75-90% is stored as failing
  // 100% of both types. The CODE cannot fire (the gap is 0), so no caseload is harmed —
  // but the ROW says a straight-A student fails all their exams, and this module is
  // exported and callable directly.
  //
  // Failing toward a confidently wrong figure is the wrong direction for a file whose
  // whole argument is that a missing measurement must be silent.
  const settings = require("./settings");
  assert.equal(ASSESSMENT_TYPE_DEFAULTS.passThreshold, settings.DEFAULTS.passThreshold,
    "restated, never a second opinion — these must not drift");

  const straightA = [
    { pct: 85, type: "Assignment" }, { pct: 78, type: "Assignment" }, { pct: 90, type: "Assignment" },
    { pct: 75, type: "Exam" }, { pct: 82, type: "Exam" }, { pct: 88, type: "Exam" },
  ];
  const r = typeShape(straightA, { assessmentTypesRecorded: true }, ASSESSMENT_TYPE_DEFAULTS);
  for (const t of r.types) {
    assert.equal(t.passRate, 100, `${t.type} reported ${t.passRate}% for a student who passed everything`);
    assert.equal(t.failed, 0);
  }
});
