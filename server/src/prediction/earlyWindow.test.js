// Tests for the early-window layer: how did this student START?
//
// No database. earlyWindow.js is pure — it takes the in-memory marks and grades the gather
// has already flattened, plus the cohort's own start date, and returns plain data. It takes
// no `today` at all, which is itself asserted below rather than merely stated.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS, in the house style, and here that weighting is not
// a stylistic choice. This module's whole value is a set of refusals: it refuses to invent
// a window when the college cannot say when the programme started, it refuses to call a
// four-week silence nought per cent, it refuses to name a "first" assessment when two share
// a deadline, it refuses both halves of a gap when either is thin, and it refuses to emit a
// single code. Each of those refusals looks exactly like a working feature right up until
// somebody acts on the confident-looking number a missing guard would have produced.
//
// Run with: node --test src/prediction/earlyWindow.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  evaluate, earlyAttendance, firstAssessment, summarisePct, shiftDays,
  EARLY_WINDOW, EARLY_WINDOW_CODES, EARLY_WINDOW_DEFAULTS,
} = require("./earlyWindow");

// All ELEVEN vocabularies already writing into riskDriverCodes.
const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");
const { COHORT_CODES } = require("./cohort");
const { WORKLOAD_CODES } = require("./workload");
const { FUNDING_CODES } = require("./funding");
const { SESSIONS_CODES } = require("./sessions");
const { INTAKE_CODES } = require("./intake");
const { HISTORY_CODES } = require("./history");
const { DIVERGENCE_CODES } = require("./divergence");
const { ASSESSMENT_TYPE_CODES } = require("./assessmentType");
const { TIMETABLE_CODES } = require("./timetable");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

// A September start, chosen so the default 28-day window crosses a month boundary — an
// arithmetic case a same-month fixture would never exercise.
const START = "2026-09-07";
// 27 days after START, because the window is inclusive of both ends. Written as a LITERAL
// rather than computed, so a bug in the module's own shiftDays cannot make the expectation
// agree with it.
const WINDOW_END = "2026-10-04";

/** `n` days after an ISO date. Deliberately a SECOND implementation, independent of the
 *  module's shiftDays, so fixtures and expectations do not share a defect with the code
 *  under test. */
function plus(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** One attendance mark. */
const mk = (date, status) => ({ date, status });

/** `count` marks of one status, on consecutive days starting `offset` days after START. */
function run(offset, count, status) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(mk(plus(START, offset + i), status));
  return out;
}

/** One marked assessment. `gradedOn` rides along on several fixtures purely to prove the
 *  module never reads it. */
const gr = (dueDate, pct, gradedOn) => ({ dueDate, pct, gradedOn });

/** The shape a caller hands evaluate(), with everything benign unless a test says so. */
const input = (over = {}) => ({
  marks: [],
  grades: [],
  programmeStartOn: START,
  ...over,
});

/** Every field earlyAttendance can return. Listed once so a test asserting "everything is
 *  null" cannot quietly assert it about four of the seven — the failure mode the brief for
 *  this module names, where a test titled "every figure is null" asserted 0 for one of
 *  them and let a real defect through a whole mutation run. */
const ATTENDANCE_FIELDS = [
  "earlyAttendance", "earlyAttendanceMarked",
  "subsequentAttendance", "subsequentAttendanceMarked",
  "earlyAttendanceGap", "earlyWindowEndsOn", "preStartMarked",
];

/** Every field firstAssessment can return, for the same reason. */
const GRADE_FIELDS = [
  "firstAssessmentPct", "firstAssessmentOn",
  "subsequentAverageGrade", "subsequentGradeCount",
  "firstAssessmentGap", "undatedGradeCount",
];

/** Asserts that `got` has exactly `fields` as keys and that every one of them is null.
 *  The key-set check is the half that matters: without it, adding a field to the module
 *  and forgetting to null it in the empty branch would leave every "all null" test still
 *  passing. */
function allNull(got, fields) {
  assert.deepEqual(Object.keys(got).sort(), [...fields].sort());
  for (const f of fields) assert.equal(got[f], null, `${f} was ${JSON.stringify(got[f])}`);
}

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

test("the vocabulary is empty, and the emptiness is the design rather than an omission", () => {
  // FIGURES ONLY. A cohort's opening window is not merely shared with neighbours — it is
  // literally the same four calendar dates for every student in the cohort, because it is
  // DERIVED FROM the cohort's start date. Freshers' week, a timetable published late, a
  // room change, an induction nobody registered, a Moodle sync that began in week three:
  // every one produces poor opening attendance for the whole intake at once, and CLAUDE.md
  // is explicit that a signal firing for a whole cohort is a figure and not a caseload row.
  //
  // The non-starter — enrolled, never turned up — is already caught by TRIP_ABSENCE_STREAK
  // (which tripwires.evaluate pointedly declines to mute inside the settling-in period for
  // exactly that case) and by TRIP_WEEKS_UNSEEN. A fourth code would put a fourth row on
  // one caseload for one fact.
  //
  // The assertion is the emptiness itself, so that adding a code is a test change and
  // therefore an argued decision rather than a quiet one.
  assert.deepEqual(EARLY_WINDOW, {});
  assert.deepEqual(EARLY_WINDOW_CODES, []);
  assert.equal(Array.isArray(EARLY_WINDOW_CODES), true);
});

test("the eleven existing vocabularies all import as arrays, and ten of them are populated", () => {
  // THIS TEST EXISTS TO STOP THE NEXT ONE BEING VACUOUS IN THE WRONG DIRECTION. The
  // disjointness check iterates over EARLY_WINDOW_CODES, which is empty today, so it
  // asserts nothing about the other modules unless somebody adds a code here. What it CAN
  // check now is that all eleven imports resolve to real arrays — a misspelled export name
  // imports as `undefined`, and the day a code IS added the loop would silently compare
  // against nothing.
  //
  // TIMETABLE_CODES IS LEGITIMATELY EMPTY (timetable.js reached the same figures-only
  // conclusion this module does), so it is checked with Array.isArray and an explicit
  // deepEqual rather than with a truthiness or length test. A blanket `length > 0` here
  // would fail on a correct module, and the obvious fix — dropping timetable from the list
  // — is how a vocabulary comes to ship unchecked.
  const populated = [
    ["tripwires", TRIP_CODES],
    ["coverage", COVERAGE_CODES],
    ["cohort", COHORT_CODES],
    ["workload", WORKLOAD_CODES],
    ["funding", FUNDING_CODES],
    ["sessions", SESSIONS_CODES],
    ["intake", INTAKE_CODES],
    ["history", HISTORY_CODES],
    ["divergence", DIVERGENCE_CODES],
    ["assessmentType", ASSESSMENT_TYPE_CODES],
  ];
  assert.equal(populated.length, 10);
  for (const [name, codes] of populated) {
    assert.equal(Array.isArray(codes), true, `${name} did not export an array`);
    assert.ok(codes.length > 0, `${name} exported an empty vocabulary`);
    for (const code of codes) assert.ok(code.startsWith("TRIP_"), `${name}: ${code}`);
  }

  assert.equal(Array.isArray(TIMETABLE_CODES), true, "timetable did not export an array");
  assert.deepEqual(TIMETABLE_CODES, []);
});

test("the eleven existing vocabularies are mutually disjoint", () => {
  // NOT VACUOUS, unlike the collision check below, and it is the reason this test is here
  // as well as in schema-contract.test.js: twelve files now write into one `riskDriverCodes`
  // column, they are written independently and cannot see each other, and a duplicate string
  // would make two different findings indistinguishable on a caseload and in every history
  // row an appeal is argued from.
  const all = [
    TRIP_CODES, COVERAGE_CODES, COHORT_CODES, WORKLOAD_CODES, FUNDING_CODES,
    SESSIONS_CODES, INTAKE_CODES, HISTORY_CODES, DIVERGENCE_CODES,
    ASSESSMENT_TYPE_CODES, TIMETABLE_CODES,
  ];
  assert.equal(all.length, 11);
  const flat = all.flat();
  assert.equal(new Set(flat).size, flat.length, "two modules export the same code string");
});

test("no code here collides with any of the eleven, and any future code must be TRIP_", () => {
  // Vacuous today by construction — the loop body runs zero times — and written anyway so
  // the structure is in place before it is needed rather than after. A code added here
  // would be appended to `riskDriverCodes`, the array engine.js fills from its six RED
  // indicators, so the prefix is what stops the next reader taking `redIndicatorCount` off
  // the copy and wiring an induction week into a band through OVR-004.
  const existing = [
    TRIP_CODES, COVERAGE_CODES, COHORT_CODES, WORKLOAD_CODES, FUNDING_CODES,
    SESSIONS_CODES, INTAKE_CODES, HISTORY_CODES, DIVERGENCE_CODES,
    ASSESSMENT_TYPE_CODES, TIMETABLE_CODES,
  ];
  for (const code of EARLY_WINDOW_CODES) {
    assert.ok(code.startsWith("TRIP_"), code);
    for (const codes of existing) assert.equal(codes.includes(code), false, code);
  }
  assert.equal(new Set(EARLY_WINDOW_CODES).size, EARLY_WINDOW_CODES.length);
});

test("evaluate returns an empty codes array under every extreme input", () => {
  // The STRUCTURAL half of the figures-only decision. It is not enough that the vocabulary
  // is empty — evaluate must never push anything, under any register, including the ones a
  // code-shaped implementation would have fired hardest on.
  const extremes = [
    ["nothing at all", input()],
    ["never attended anything, ever", input({ marks: run(0, 40, "A") })],
    ["catastrophic opening, perfect since", input({
      marks: [...run(0, 12, "A"), ...run(30, 60, "P")],
    })],
    ["perfect opening, total collapse since", input({
      marks: [...run(0, 12, "P"), ...run(30, 60, "A")],
    })],
    ["failed the first assessment and everything after it", input({
      grades: [gr("2026-09-20", 4), gr("2026-10-20", 3), gr("2026-11-20", 2)],
    })],
    ["no programme start date at all", input({
      programmeStartOn: null, marks: run(0, 40, "A"),
    })],
  ];
  for (const [name, raw] of extremes) {
    const out = evaluate(raw, {});
    assert.deepEqual(out.codes, [], name);
  }
});

test("evaluate hands back a FRESH codes array each call", () => {
  // A shared constant would let one caller's push contaminate every subsequent student in
  // the chunk of 200 — a bug that is invisible until it is institution-wide, because the
  // first student in the chunk always looks right.
  const a = evaluate(input(), {});
  const b = evaluate(input(), {});
  assert.notEqual(a.codes, b.codes);
  a.codes.push("TRIP_SOMETHING");
  assert.deepEqual(b.codes, []);
  assert.deepEqual(evaluate(input(), {}).codes, []);
});

/* ========================================================================== */
/* TRAP 1: the window needs a programme start date, and there is no fallback    */
/* ========================================================================== */

test("with no programme start date EVERY attendance field is null, counts included", () => {
  // THE MOST IMPORTANT REFUSAL IN THE MODULE. The tempting fallback is "use the student's
  // earliest mark", and it fails asymmetrically: it produces its most confident-looking
  // answer for exactly the students whose records are worst. A student whose register was
  // not opened until week six would have weeks six-to-ten stored as "how they started", the
  // number would look entirely ordinary, and the six unmarked weeks would have been erased
  // by the very figure written to expose them.
  //
  // The counts are asserted null too, not zero: with no window there is nothing to have
  // counted IN, so a 0 would claim we looked at a bounded period and found it empty.
  const marks = [...run(0, 20, "A"), ...run(40, 20, "P")];
  allNull(earlyAttendance(marks, null, {}), ATTENDANCE_FIELDS);
});

test("every unusable shape of start date is refused, not coerced", () => {
  // `Date.parse` accepts "2026-8-4" and a dozen other shapes, and every window test in the
  // module is a STRING comparison — where "2026-8-4" sorts before "2026-10-01" and after
  // "2026-07-31". That is a silently wrong window rather than a loud failure, which is why
  // the guard is a regex and not a parse.
  const marks = [...run(0, 20, "A"), ...run(40, 20, "P")];
  const bad = [
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["loose month and day", "2026-8-4"],
    ["a day that does not exist", "2026-02-31"],
    ["a timestamp rather than a date", "2026-09-07T00:00:00Z"],
    ["a Date object", new Date("2026-09-07")],
    ["a number", 20260907],
    ["a UK-format date", "07/09/2026"],
  ];
  for (const [name, value] of bad) {
    const got = earlyAttendance(marks, value, {});
    allNull(got, ATTENDANCE_FIELDS);
    assert.equal(got.earlyWindowEndsOn, null, name);
  }
});

test("the window is bounded by the start date, never by where the marks happen to begin", () => {
  // The regression test for a reintroduced earliest-mark fallback that was smart enough to
  // still return nulls when the start date was absent. Identical marks, two start dates,
  // two different answers — and if the window came from the marks the two would be equal.
  const marks = [...run(0, 8, "A"), ...run(40, 8, "P")];

  const asDeclared = earlyAttendance(marks, START, {});
  // A start date 40 days later puts the "A" run before the programme and the "P" run
  // inside the window: the mirror image of the same data.
  const asLater = earlyAttendance(marks, plus(START, 40), {});

  assert.equal(asDeclared.earlyAttendance, 0);
  assert.equal(asLater.earlyAttendance, 100);
  assert.equal(asDeclared.preStartMarked, 0);
  assert.equal(asLater.preStartMarked, 8);
});

/* ========================================================================== */
/* TRAP 3: the window is date-bounded, and no output depends on the calendar    */
/* ========================================================================== */

test("earlyAttendance takes no `today` and evaluate ignores one if handed it", () => {
  // Trap three, asserted structurally rather than promised. A figure that never sees the
  // date cannot change because the date changed, and this is checkable from the signature.
  assert.equal(earlyAttendance.length, 3);          // marks, programmeStartOn, opts
  assert.equal(evaluate.length, 2);                 // raw, config

  const marks = [...run(0, 10, "P"), ...run(40, 10, "A")];
  const without = evaluate(input({ marks }), {});
  const withToday = evaluate(input({ marks, today: "2099-01-01" }), {});
  const withOther = evaluate(input({ marks, today: "2026-09-08" }), {});
  assert.deepEqual(withToday, without);
  assert.deepEqual(withOther, without);
});

test("the module's source reads no clock", () => {
  // The same guard timetable.test.js keeps. `new Date(iso)` with an ARGUMENT is fine and is
  // used once, in shiftDays; a bare `new Date()` or a `Date.now()` is the host clock, which
  // src/clock.js exists to stop this codebase reaching for.
  const src = fs.readFileSync(path.join(__dirname, "earlyWindow.js"), "utf8");
  const code = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.equal(/Date\.now\s*\(/.test(code), false, "earlyWindow.js reads Date.now");
  assert.equal(/new Date\s*\(\s*\)/.test(code), false, "earlyWindow.js constructs a bare Date");
  assert.equal(/\btoday\b/.test(code), false, "earlyWindow.js references today outside comments");
  assert.equal(/getTimezoneOffset|\.getHours\s*\(/.test(code), false);
});

test("a closed window does not move when later marks arrive", () => {
  // The property the whole module rests on: a student's week 1-4 attendance is the same
  // number in June as it was in October. Seventy marks arriving after the window — a whole
  // year of registers — must not shift the opening figure by a tenth of a point.
  const opening = [...run(0, 6, "P"), ...run(7, 6, "A")];
  const before = earlyAttendance(opening, START, {});
  const after = earlyAttendance([...opening, ...run(60, 70, "P")], START, {});

  assert.equal(before.earlyAttendance, 50);
  assert.equal(after.earlyAttendance, 50);
  assert.equal(after.earlyAttendanceMarked, before.earlyAttendanceMarked);
  assert.equal(after.earlyWindowEndsOn, before.earlyWindowEndsOn);
  // And the SUBSEQUENT side did move, which is what proves the fixture was capable of
  // moving the early one. Without this line the test above would still pass against an
  // implementation that ignored the extra marks entirely.
  assert.notEqual(after.subsequentAttendance, before.subsequentAttendance);
});

test("a backdated mark INSIDE the window does move the figure, and should", () => {
  // The complement of the test above, and it is what stops that one being read as
  // "the number is frozen". The rule is not immutability — it is that the number is a
  // function of the register and of nothing else. A register entered three months late is
  // a correction to the record of what happened in weeks one to four.
  const opening = run(0, 8, "P");
  const before = earlyAttendance(opening, START, {});
  const after = earlyAttendance([...opening, ...run(10, 8, "A")], START, {});
  assert.equal(before.earlyAttendance, 100);
  assert.equal(after.earlyAttendance, 50);
});

/* ========================================================================== */
/* The window's edges                                                          */
/* ========================================================================== */

test("earlyWindowEndsOn is 27 days after the start, not 28", () => {
  // Inclusive of both ends: a 28-day window opening on the 7th closes on the 4th of the
  // next month. Off by one and the figure silently spans 29 days, and the argument for the
  // constant — four calendar weeks, four of every weekday — quietly stops being true.
  const got = earlyAttendance(run(0, 8, "P"), START, {});
  assert.equal(got.earlyWindowEndsOn, WINDOW_END);
  assert.equal(EARLY_WINDOW_DEFAULTS.earlyWindowDays, 28);
});

test("both ends of the window are inclusive and day 29 is outside it", () => {
  // Four marks placed one per boundary. Each is asserted through the COUNTS rather than
  // through the percentage, because a count moves by one for a single misplaced mark while
  // a percentage of identical statuses would not move at all.
  const marks = [
    mk(plus(START, -1), "P"),        // the day before the programme began
    mk(START, "P"),                  // the first day, inclusive
    mk(WINDOW_END, "P"),             // the last day, inclusive
    mk(plus(START, 28), "P"),        // day 29, outside
  ];
  const got = earlyAttendance(marks, START, { earlyWindowMinMarks: 1, subsequentMinMarks: 1 });
  assert.equal(got.earlyAttendanceMarked, 2);
  assert.equal(got.subsequentAttendanceMarked, 1);
  assert.equal(got.preStartMarked, 1);
});

test("marks before the programme start leave BOTH sides of the comparison", () => {
  // An induction session, a taster day, a student transferred in from another cohort, or a
  // start date typed wrong. Counting them as early would make the lower bound "the earliest
  // mark" through the back door; counting them as subsequent would put a pre-start
  // observation on the AFTER side of a comparison about what happened after the start.
  const marks = [
    ...run(-20, 10, "A"),            // before the programme: all absent
    ...run(0, 8, "P"),               // inside the window: all present
    ...run(35, 8, "P"),              // after the window: all present
  ];
  const got = earlyAttendance(marks, START, {});
  assert.equal(got.preStartMarked, 10);
  assert.equal(got.earlyAttendanceMarked, 8);
  assert.equal(got.subsequentAttendanceMarked, 8);
  // If the ten pre-start absences had reached either side, neither of these would be 100.
  assert.equal(got.earlyAttendance, 100);
  assert.equal(got.subsequentAttendance, 100);
  assert.equal(got.earlyAttendanceGap, 0);
});

/* ========================================================================== */
/* TRAP 4: null means not measurable, zero means zero                          */
/* ========================================================================== */

test("no marks inside the window is a null percentage and a marked count of ZERO", () => {
  // A register nobody took is not an absence, and this is the state most likely to occur at
  // the start of a programme — which is when registers are least reliably opened. Scoring
  // it 0% would put a whole intake at the top of a risk list for something nobody measured.
  //
  // The COUNT is zero rather than null, and the asymmetry is the point: a rate over an empty
  // set is undefined, but a count of marks inside a window with two known ends is genuinely
  // zero. The zero is what explains the null beside it.
  const got = earlyAttendance(run(40, 20, "P"), START, {});
  assert.equal(got.earlyAttendance, null);
  assert.equal(got.earlyAttendanceMarked, 0);
  assert.equal(got.earlyAttendanceGap, null);
  assert.equal(got.earlyWindowEndsOn, WINDOW_END);
});

test("below the early floor the percentage is refused but the denominator is reported", () => {
  // "Too thin to say" and "no register at all" are different conversations with the person
  // who takes the register, and the row has to be able to tell them apart.
  const got = earlyAttendance(run(0, 3, "A"), START, {});
  assert.equal(got.earlyAttendance, null);
  assert.equal(got.earlyAttendanceMarked, 3);
});

test("the early floor is four marks inclusive, and three is one too few", () => {
  // The boundary itself, because `>=` becoming `>` is a one-character change that would
  // silence the figure for every part-time cohort and fail no other test in this file.
  assert.equal(EARLY_WINDOW_DEFAULTS.earlyWindowMinMarks, 4);
  assert.equal(earlyAttendance(run(0, 3, "P"), START, {}).earlyAttendance, null);
  assert.equal(earlyAttendance(run(0, 4, "P"), START, {}).earlyAttendance, 100);
});

test("the subsequent floor is six marks inclusive, and it is HIGHER than the early one", () => {
  // A gap is two numbers, and a floor on only the interesting one is the half-guard
  // sessions.js names: "22% at the start against the two registers taken since" is an
  // 80-point recovery drawn from two rows. The two floors are deliberately different — the
  // early window cannot grow, the rest of the programme can — so a test that only pinned
  // one of them would let the pair be collapsed into a single constant.
  assert.equal(EARLY_WINDOW_DEFAULTS.subsequentMinMarks, 6);
  assert.ok(EARLY_WINDOW_DEFAULTS.subsequentMinMarks > EARLY_WINDOW_DEFAULTS.earlyWindowMinMarks);

  const withFive = earlyAttendance([...run(0, 8, "P"), ...run(35, 5, "A")], START, {});
  assert.equal(withFive.subsequentAttendance, null);
  assert.equal(withFive.subsequentAttendanceMarked, 5);
  assert.equal(withFive.earlyAttendance, 100);

  const withSix = earlyAttendance([...run(0, 8, "P"), ...run(35, 6, "A")], START, {});
  assert.equal(withSix.subsequentAttendance, 0);
  assert.equal(withSix.subsequentAttendanceMarked, 6);
});

test("the gap needs BOTH sides and is null when either is refused", () => {
  // "We did not look" and "nothing changed" must not share a number — tripwires.js's
  // argument for a null attendanceSlope, with a much longer memory attached here.
  const earlyThin = earlyAttendance([...run(0, 2, "A"), ...run(35, 10, "P")], START, {});
  assert.equal(earlyThin.earlyAttendance, null);
  assert.equal(earlyThin.subsequentAttendance, 100);
  assert.equal(earlyThin.earlyAttendanceGap, null);

  const laterThin = earlyAttendance([...run(0, 8, "A"), ...run(35, 2, "P")], START, {});
  assert.equal(laterThin.earlyAttendance, 0);
  assert.equal(laterThin.subsequentAttendance, null);
  assert.equal(laterThin.earlyAttendanceGap, null);

  const bothThin = earlyAttendance([...run(0, 2, "A"), ...run(35, 2, "P")], START, {});
  assert.equal(bothThin.earlyAttendanceGap, null);
});

/* ========================================================================== */
/* The sign convention                                                         */
/* ========================================================================== */

test("a positive gap means RECOVERED and a negative one means fell away", () => {
  // Written down because an unstated sign convention gets flipped in a refactor by somebody
  // reading the subtraction and not the meaning, and a flipped sign would render every
  // recovery on the screen as a collapse. It matches attendanceSlope, which is also
  // positive-is-improving, so the two figures point the same way on one row.
  const recovered = earlyAttendance([...run(0, 8, "A"), ...run(35, 10, "P")], START, {});
  assert.equal(recovered.earlyAttendance, 0);
  assert.equal(recovered.subsequentAttendance, 100);
  assert.equal(recovered.earlyAttendanceGap, 100);

  const declined = earlyAttendance([...run(0, 8, "P"), ...run(35, 10, "A")], START, {});
  assert.equal(declined.earlyAttendanceGap, -100);
});

test("a bad start that never recovered and a bad start that did are distinguishable", () => {
  // The pair of cases the module exists for, asserted together so a change that collapsed
  // them into one number cannot pass. Both students carry an identical LIFETIME figure of
  // 50% — the number `overallAttendance` would report — and they are not the same student.
  const neverRecovered = earlyAttendance(
    [...run(0, 9, "A"), ...run(35, 9, "A"), ...run(60, 18, "P")], START, {},
  );
  const recovered = earlyAttendance(
    [...run(0, 9, "A"), ...run(35, 27, "P")], START, {},
  );

  assert.equal(neverRecovered.earlyAttendance, 0);
  assert.equal(recovered.earlyAttendance, 0);
  // Identical openings, opposite gaps. A single lifetime mean cannot express this.
  assert.equal(neverRecovered.earlyAttendanceGap, 66.7);
  assert.equal(recovered.earlyAttendanceGap, 100);
  assert.notEqual(neverRecovered.earlyAttendanceGap, recovered.earlyAttendanceGap);
});

/* ========================================================================== */
/* Marks the module will not read                                              */
/* ========================================================================== */

test("unreadable statuses and unreadable dates leave both sides and every count", () => {
  // Not guessed at, and not counted as absences. A mark that cannot be placed is exactly an
  // unmarked session as far as every figure here is concerned.
  const marks = [
    ...run(0, 8, "P"),
    mk(plus(START, 3), "X"),                  // not a status
    mk(plus(START, 3), null),
    mk(plus(START, 3), undefined),
    mk(null, "A"),                            // not a date
    mk("2026-9-9", "A"),                      // loose
    mk("not-a-date", "A"),
    mk("2026-02-31", "A"),                    // parses, and rolls forward to 3 March
    mk(undefined, "A"),
    null,                                     // not even a mark
    undefined,
  ];
  const got = earlyAttendance(marks, START, {});
  assert.equal(got.earlyAttendanceMarked, 8);
  assert.equal(got.earlyAttendance, 100);
  assert.equal(got.preStartMarked, 0);
  assert.equal(got.subsequentAttendanceMarked, 0);
});

test("a missing or non-array marks list is tolerated and yields a zero denominator", () => {
  for (const marks of [[], null, undefined]) {
    const got = earlyAttendance(marks, START, {});
    assert.equal(got.earlyAttendance, null);
    assert.equal(got.earlyAttendanceMarked, 0);
    assert.equal(got.earlyWindowEndsOn, WINDOW_END);
  }
});

/* ========================================================================== */
/* The college's own attendance model                                          */
/* ========================================================================== */

test("the opening figure honours attendanceMode, so it agrees with the screen beside it", () => {
  // A college chooses between "points" (P=2, L=1, E=1, A=0 — what the Attendance % tab
  // displays) and "binary" (present or not — what a provider reporting physical attendance
  // on a Student visa means). The opening figure exists to be compared against
  // overallAttendance on one screen, and two definitions of a percentage on one screen is
  // how they drift.
  //
  // The fixture is chosen so the two models must disagree: two present and two late is 75%
  // under points and 50% under binary.
  const marks = [mk(START, "P"), mk(plus(START, 1), "P"), mk(plus(START, 2), "L"), mk(plus(START, 3), "L")];
  assert.equal(earlyAttendance(marks, START, {}).earlyAttendance, 75);
  assert.equal(earlyAttendance(marks, START, { attendanceMode: "points" }).earlyAttendance, 75);
  assert.equal(earlyAttendance(marks, START, { attendanceMode: "binary" }).earlyAttendance, 50);
  // An unrecognised mode falls back to points — the platform default — rather than to the
  // stricter model, because silently reporting a lower figure than the screen is the
  // direction that harms a student.
  assert.equal(earlyAttendance(marks, START, { attendanceMode: "nonsense" }).earlyAttendance, 75);
});

test("summarisePct returns a null percentage rather than zero over an empty list", () => {
  for (const mode of ["points", "binary"]) {
    assert.deepEqual(summarisePct([], mode), { marked: 0, pct: null });
    assert.deepEqual(summarisePct([mk(START, "X")], mode), { marked: 0, pct: null });
  }
});

/* ========================================================================== */
/* A misconfigured window                                                      */
/* ========================================================================== */

test("a window length that is not a positive number yields nulls, never an inverted window", () => {
  // settings.js does not validate `earlyWindowDays` yet, so a zero, a negative or a string
  // can arrive from a config column. Unguarded, a negative produces a window whose end
  // precedes its start: every mark lands on the "subsequent" side while the row still
  // carries a confident-looking end date, which is the worst of both.
  const marks = [...run(0, 10, "P"), ...run(35, 10, "A")];
  for (const bad of [0, -5, null, undefined, NaN, Infinity, "28"]) {
    allNull(earlyAttendance(marks, START, { earlyWindowDays: bad }), ATTENDANCE_FIELDS);
  }
  // And a one-day window is legal, if eccentric — the guard is against nonsense, not
  // against a college that means it.
  const oneDay = earlyAttendance(marks, START, { earlyWindowDays: 1, earlyWindowMinMarks: 1 });
  assert.equal(oneDay.earlyWindowEndsOn, START);
  assert.equal(oneDay.earlyAttendanceMarked, 1);
});

test("shiftDays crosses month, year and BST boundaries without drifting", () => {
  // String arithmetic on a UTC midnight. A local Date would put the last Sunday in October
  // an hour out and hand back the previous day — the bug vle/isoDate.js documents.
  assert.equal(shiftDays("2026-09-07", 27), "2026-10-04");
  assert.equal(shiftDays("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDays("2026-10-24", 3), "2026-10-27");       // across the BST end
  assert.equal(shiftDays("2026-03-28", 3), "2026-03-31");       // across the BST start
  assert.equal(shiftDays("2028-02-28", 1), "2028-02-29");       // a leap day
  assert.equal(shiftDays("2026-09-07", 0), "2026-09-07");
  assert.equal(shiftDays("2026-9-7", 1), null);
  // A day that does not exist. Date.parse ACCEPTS this — the ISO grammar validates the
  // shape of the day field and not the day — and rolls it forward to 3 March, so a
  // finite-parse guard would have built the window from a date three days after the one
  // the college typed. Only a round trip catches it.
  assert.equal(shiftDays("2026-02-31", 1), null);
  assert.equal(shiftDays("2026-13-01", 1), null);
  assert.equal(shiftDays("2026-09-31", 1), null);
  assert.equal(shiftDays(null, 1), null);
  assert.equal(shiftDays("2026-09-07", null), null);
});

/* ========================================================================== */
/* The first assessment                                                        */
/* ========================================================================== */

test("with no grades EVERY grade field is null, the undated count included", () => {
  // Nothing marked is not a clean start, and there was no grade here to have failed to
  // date — so `undatedGradeCount` is null rather than the 0 it becomes as soon as one grade
  // exists. This is the test whose title and assertion have to agree: all six, not five.
  for (const grades of [[], null, undefined]) {
    allNull(firstAssessment(grades, {}), GRADE_FIELDS);
  }
});

test("grades with no usable percentage are dropped before anything else happens", () => {
  const junk = [
    { dueDate: "2026-09-20", pct: null },
    { dueDate: "2026-09-21", pct: undefined },
    { dueDate: "2026-09-22", pct: NaN },
    { dueDate: "2026-09-23", pct: "70" },
    { dueDate: "2026-09-24", pct: Infinity },
    null,
  ];
  allNull(firstAssessment(junk, {}), GRADE_FIELDS);
});

test("when NO grade carries a due date every figure is null and only the count survives", () => {
  // A college that dates no assessments produces this for every student, which is already
  // the fail-safe direction — null, never a confident zero — so no institution probe is
  // needed. `undatedGradeCount` is what makes that institution-wide state legible on the row
  // rather than inferable from a column of blanks.
  const grades = [gr(null, 70), gr(undefined, 40), gr("2026-9-1", 55)];
  const got = firstAssessment(grades, {});
  assert.equal(got.undatedGradeCount, 3);
  for (const f of GRADE_FIELDS) {
    if (f === "undatedGradeCount") continue;
    assert.equal(got[f], null, f);
  }
});

test("an undated grade can never become the first one", () => {
  // The failure this guards is quiet: an undated grade sorting to the front would make a
  // permanent record out of whichever order Postgres returned the rows in, and the number
  // would look completely ordinary.
  const grades = [gr(null, 5), gr("2026-09-20", 70), gr("2026-10-20", 60), gr("2026-11-20", 80)];
  const got = firstAssessment(grades, {});
  assert.equal(got.firstAssessmentPct, 70);
  assert.equal(got.firstAssessmentOn, "2026-09-20");
  assert.equal(got.undatedGradeCount, 1);
  // And the undated mark of 5 is not in the average either — it left BOTH sides.
  assert.equal(got.subsequentGradeCount, 2);
  assert.equal(got.subsequentAverageGrade, 70);
});

test("two pieces sharing the earliest deadline yield null rather than an arbitrary pick", () => {
  // "The first assessment" is one piece by definition. If two share the earliest deadline
  // the sequence has no first element, and averaging them would be the early/later gap
  // again with an arbitrary boundary, wearing this figure's name.
  const tied = [gr("2026-09-20", 70), gr("2026-09-20", 20), gr("2026-10-20", 60), gr("2026-11-20", 65)];
  const got = firstAssessment(tied, {});
  assert.equal(got.undatedGradeCount, 0);
  for (const f of GRADE_FIELDS) {
    if (f === "undatedGradeCount") continue;
    assert.equal(got[f], null, f);
  }
  // And the refusal does not depend on which of the tied pair arrives first — the whole
  // point is that input order must not decide it.
  const reversed = firstAssessment([...tied].reverse(), {});
  assert.deepEqual(reversed, got);
});

test("a tie LATER in the sequence does not block the first assessment", () => {
  // The guard is about the earliest deadline only. Two pieces both due in November say
  // nothing about which piece came first, and refusing there would silence the figure at
  // every college that sets two assignments in one week.
  const grades = [gr("2026-09-20", 30), gr("2026-11-20", 70), gr("2026-11-20", 90)];
  const got = firstAssessment(grades, {});
  assert.equal(got.firstAssessmentPct, 30);
  assert.equal(got.subsequentAverageGrade, 80);
  assert.equal(got.firstAssessmentGap, 50);
});

test("ordering is by due date, and gradedOn is not read at all", () => {
  // This directory already carries TRIP_TREND_UNRELIABLE, whose only job is to record that
  // `gradedOn` cannot order a term's work — a tutor marking in one sitting gives every
  // grade the same date, and "recent" is then decided by typing order. An ordering that can
  // be decided by typing order cannot decide which assessment came FIRST, and unlike the
  // trend this figure is written down as a permanent fact about how somebody started.
  //
  // Every gradedOn below points the opposite way from every dueDate, and they are all
  // identical to each other on top of that — the one-sitting case.
  const grades = [
    gr("2026-11-20", 90, "2026-11-01"),
    gr("2026-09-20", 30, "2026-11-01"),
    gr("2026-10-20", 70, "2026-11-01"),
  ];
  const got = firstAssessment(grades, {});
  assert.equal(got.firstAssessmentOn, "2026-09-20");
  assert.equal(got.firstAssessmentPct, 30);
  assert.equal(got.subsequentAverageGrade, 80);
});

test("input order does not change the answer", () => {
  const grades = [gr("2026-09-20", 30), gr("2026-10-20", 70), gr("2026-11-20", 90), gr("2026-12-20", 50)];
  const forwards = firstAssessment(grades, {});
  const backwards = firstAssessment([...grades].reverse(), {});
  const shuffled = firstAssessment([grades[2], grades[0], grades[3], grades[1]], {});
  assert.deepEqual(backwards, forwards);
  assert.deepEqual(shuffled, forwards);
});

test("the later average EXCLUDES the first piece, which is the whole trick", () => {
  // averageGrade already contains the first assessment by construction, so on a student with
  // four marks the mean is a quarter made of the thing it would be compared against and can
  // never be far from it. Excluding the first is what makes "did they find their feet"
  // answerable at all.
  const grades = [gr("2026-09-20", 0), gr("2026-10-20", 90), gr("2026-11-20", 90), gr("2026-12-20", 90)];
  const got = firstAssessment(grades, {});
  assert.equal(got.firstAssessmentPct, 0);
  assert.equal(got.subsequentAverageGrade, 90);   // 67.5 if the first were included
  assert.equal(got.subsequentGradeCount, 3);
  assert.equal(got.firstAssessmentGap, 90);
});

test("the later average needs two pieces, and one is reported as a count but not a mean", () => {
  // Two, borrowed from gradeTrendAssessmentCount rather than invented, so the engine's
  // opinion about how many marks make a comparable group and this module's cannot drift.
  assert.equal(EARLY_WINDOW_DEFAULTS.subsequentMinGrades, 2);

  const one = firstAssessment([gr("2026-09-20", 30), gr("2026-10-20", 90)], {});
  assert.equal(one.firstAssessmentPct, 30);
  assert.equal(one.subsequentGradeCount, 1);
  assert.equal(one.subsequentAverageGrade, null);
  assert.equal(one.firstAssessmentGap, null);

  const two = firstAssessment([gr("2026-09-20", 30), gr("2026-10-20", 90), gr("2026-11-20", 70)], {});
  assert.equal(two.subsequentGradeCount, 2);
  assert.equal(two.subsequentAverageGrade, 80);
  assert.equal(two.firstAssessmentGap, 50);
});

test("a lone first assessment reports its own mark and refuses every comparison", () => {
  const got = firstAssessment([gr("2026-09-20", 12)], {});
  assert.equal(got.firstAssessmentPct, 12);
  assert.equal(got.firstAssessmentOn, "2026-09-20");
  assert.equal(got.subsequentGradeCount, 0);
  assert.equal(got.subsequentAverageGrade, null);
  assert.equal(got.firstAssessmentGap, null);
  assert.equal(got.undatedGradeCount, 0);
});

test("the grade gap uses the same sign convention as the attendance gap", () => {
  // One row, two gaps, one direction of travel. A reader must not have to remember which
  // way each of them points.
  const improved = firstAssessment([gr("2026-09-20", 30), gr("2026-10-20", 70), gr("2026-11-20", 70)], {});
  const worsened = firstAssessment([gr("2026-09-20", 70), gr("2026-10-20", 30), gr("2026-11-20", 30)], {});
  assert.equal(improved.firstAssessmentGap, 40);
  assert.equal(worsened.firstAssessmentGap, -40);
});

test("figures are rounded to one decimal so two runs cannot disagree in the last digit", () => {
  const got = firstAssessment([gr("2026-09-20", 10), gr("2026-10-20", 33), gr("2026-11-20", 34), gr("2026-12-20", 34)], {});
  assert.equal(got.subsequentAverageGrade, 33.7);
  assert.equal(got.firstAssessmentGap, 23.7);

  const att = earlyAttendance([...run(0, 1, "A"), ...run(1, 2, "P"), ...run(3, 1, "L")], START, {});
  assert.equal(att.earlyAttendance, 62.5);
});

test("both gaps are rounded, so binary floating point never reaches the row", () => {
  // NOT COSMETIC, and this test exists because a mutation run found the assertion missing.
  // Both sides of each gap are ALREADY rounded to one decimal, which makes it tempting to
  // read the round on the subtraction as belt and braces — but subtracting two one-decimal
  // figures does not give a one-decimal answer in binary floating point. 66.7 - 33.3 is
  // 33.400000000000006, and that is what would be written to a Float column, rendered on a
  // screen, and compared for equality against a figure computed by any other route.
  //
  // Both fixtures are chosen to land on that exact pair: one third and two thirds.
  const drifting = earlyAttendance(
    // Six early marks at 4/12 points, six later at 8/12.
    [mk(plus(START, 0), "P"), mk(plus(START, 1), "P"),
     ...run(2, 4, "A"),
     ...run(35, 4, "P"), mk(plus(START, 39), "A"), mk(plus(START, 40), "A")],
    START, {},
  );
  assert.equal(drifting.earlyAttendance, 33.3);
  assert.equal(drifting.subsequentAttendance, 66.7);
  assert.equal(drifting.earlyAttendanceGap, 33.4);

  const grades = firstAssessment([gr("2026-09-20", 33.3), gr("2026-10-20", 66.7), gr("2026-11-20", 66.7)], {});
  assert.equal(grades.subsequentAverageGrade, 66.7);
  assert.equal(grades.firstAssessmentGap, 33.4);
});

/* ========================================================================== */
/* evaluate                                                                    */
/* ========================================================================== */

test("evaluate assembles both halves under one key set and adds nothing else", () => {
  // The key set is asserted exhaustively because these become columns. A field appearing
  // here that nobody added to the schema is a silent drop at write time, and a field
  // quietly disappearing is a column that stops being written with no error anywhere.
  const got = evaluate(input({
    marks: [...run(0, 8, "A"), ...run(35, 10, "P")],
    grades: [gr("2026-09-20", 30), gr("2026-10-20", 70), gr("2026-11-20", 70)],
  }), {});

  assert.deepEqual(
    Object.keys(got).sort(),
    [...ATTENDANCE_FIELDS, ...GRADE_FIELDS, "codes"].sort(),
  );
  assert.equal(got.earlyAttendance, 0);
  assert.equal(got.earlyAttendanceGap, 100);
  assert.equal(got.firstAssessmentPct, 30);
  assert.equal(got.firstAssessmentGap, 40);
  assert.deepEqual(got.codes, []);
});

test("evaluate survives an entirely empty input", () => {
  for (const raw of [undefined, null, {}, { marks: null, grades: null, programmeStartOn: null }]) {
    const got = evaluate(raw, {});
    assert.deepEqual(got.codes, []);
    assert.equal(got.earlyAttendance, null);
    assert.equal(got.firstAssessmentPct, null);
    assert.equal(got.earlyWindowEndsOn, null);
  }
});

test("evaluate survives a missing config and uses the platform defaults", () => {
  for (const cfg of [undefined, null, {}]) {
    const got = evaluate(input({ marks: run(0, 4, "P") }), cfg);
    assert.equal(got.earlyWindowEndsOn, WINDOW_END);
    assert.equal(got.earlyAttendance, 100);
  }
});

test("a college's retuned config reaches both halves of the module", () => {
  // The settings pattern: platform defaults in code, a college's JSON merged over them. A
  // config key that reached earlyAttendance but not firstAssessment would be the sort of
  // half-wiring that shows up a term later as two figures disagreeing on one screen.
  const raw = input({
    marks: [...run(0, 4, "P"), ...run(10, 4, "A")],
    grades: [gr("2026-09-20", 30), gr("2026-10-20", 90)],
  });

  // A seven-day window puts the second run of marks outside it.
  const short = evaluate(raw, { earlyWindowDays: 7, subsequentMinMarks: 4 });
  assert.equal(short.earlyWindowEndsOn, plus(START, 6));
  assert.equal(short.earlyAttendance, 100);
  assert.equal(short.subsequentAttendance, 0);

  // And a college content with a single later mark gets its average.
  const loose = evaluate(raw, { subsequentMinGrades: 1 });
  assert.equal(loose.subsequentAverageGrade, 90);
  assert.equal(loose.firstAssessmentGap, 60);
});

test("the defaults are the numbers the comments argue for", () => {
  // Pinned so that retuning one is a test change and therefore an argued decision. Each is
  // borrowed from a constant settings.js already carries rather than picked for looking
  // round: 28 is recentAttendanceDays, 4 is disperseMinMarks, 6 is minMarksForRate, 2 is
  // gradeTrendAssessmentCount.
  assert.deepEqual(EARLY_WINDOW_DEFAULTS, {
    earlyWindowDays: 28,
    earlyWindowMinMarks: 4,
    subsequentMinMarks: 6,
    subsequentMinGrades: 2,
  });
});
