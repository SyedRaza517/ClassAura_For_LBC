// Tests for the timetable layer: is the SHAPE of a student's teaching day the reason they
// are not there?
//
// No database. timetable.js is pure — it takes the in-memory marks the gather has already
// flattened plus an institution-wide probe result, and returns plain data.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS on purpose, in the house style. This module emits
// NO CODES AT ALL and refuses to answer far more often than it answers, so almost
// everything worth testing is what it declines to say: which comparison it will not draw,
// which figure comes back null rather than zero, which mark leaves both sides of a
// fraction, and which confident-looking number it will not manufacture from a field the
// caller forgot to select. A refusal is the thing that looks identical to a working
// feature right up until somebody acts on it.
//
// Run with: node --test src/prediction/timetable.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  evaluate, earlyStartShape, dayLengthShape, gapShape, twoGroupShape, buildDays,
  minutesOf, assertInstitutionProbe,
  TIMETABLE, TIMETABLE_CODES, TIMETABLE_DEFAULTS,
} = require("./timetable");

// All nine vocabularies already writing into riskDriverCodes.
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

/** A college whose register records lateness. */
const LATE_KNOWN = { lateRecorded: true };
/** A college whose Moodle plugin has no "L" acronym — zero late marks, institution-wide. */
const LATE_UNKNOWN = { lateRecorded: false };

/** March 2026, so every fixture date is two digits and sorts as a string. `n` is the day
 *  of the month. No weekday arithmetic is involved anywhere in this module, so the dates
 *  are pure bucket keys and nothing depends on which day of the week they land on. */
const d = (n) => `2026-03-${String(n).padStart(2, "0")}`;

/** One mark. `endTime` is passed explicitly — including as undefined — because the whole
 *  point of several tests below is what happens when the caller does not carry it. */
const mk = (date, startTime, endTime, status) => ({
  status,
  date,
  startTime,
  endTime,
  // Carried because metrics.js carries it and evaluate()'s documented input shape names
  // it. Nothing in the module reads it; a test that stopped passing it would prove
  // nothing, and a test that DID depend on it would be pinning a coupling that does not
  // exist.
  sessionId: `${date}T${startTime}`,
  unitId: "unit-1",
});

/** `count` consecutive days, each holding one session at `startTime`, all of `status`. */
function singleSessionDays(fromDay, count, startTime, endTime, status) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(mk(d(fromDay + i), startTime, endTime, status));
  return out;
}

/** The shape a caller hands evaluate(), with everything benign unless a test says so. */
const input = (over = {}) => ({
  marks: [],
  weeksIntoProgramme: 20,
  institution: LATE_KNOWN,
  ...over,
});

/** A deterministic shuffle, so a determinism test cannot pass by luck of ordering. */
function shuffled(list) {
  const out = [...list];
  let seed = 12345;
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ========================================================================== */
/* The vocabulary — which is empty, and that is the design                     */
/* ========================================================================== */

test("the vocabulary is empty: this module emits no codes at all", () => {
  // NOT AN OVERSIGHT AND NOT A STUB. Every figure this module produces is a comparison
  // within one student's own register against a threshold on the timetable — a nine
  // o'clock start, a six-hour day, a two-hour hole. All three are shared by everybody on
  // the timetable, so a badly-timetabled unit produces the identical finding for its whole
  // cohort at once, and CLAUDE.md is explicit that a signal which fires for a whole cohort
  // is a figure rather than a caseload entry. The evidence that would separate this
  // student from their neighbours is the rest of the cohort's nine o'clock, and it lives
  // in cohort.js, which carries no per-start-time baseline.
  //
  // The assertion is the emptiness itself, so that adding a code is a test change and
  // therefore an argued decision rather than a quiet one.
  assert.deepEqual(TIMETABLE, {});
  assert.deepEqual(TIMETABLE_CODES, []);
  assert.equal(Array.isArray(TIMETABLE_CODES), true);
});

test("the nine existing vocabularies are all importable and non-empty", () => {
  // THIS TEST EXISTS TO STOP THE NEXT ONE BEING VACUOUS IN THE WRONG DIRECTION. The
  // disjointness check below iterates over TIMETABLE_CODES, which is empty today, so it
  // asserts nothing about the other modules unless somebody adds a code. What it CAN check
  // now is that the nine imports resolve to real, populated arrays — because a misspelled
  // export name would import as undefined, and the day a code IS added the disjointness
  // loop would then silently compare against nothing.
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
  assert.equal(existing.length, 9);
  for (const [name, codes] of existing) {
    assert.equal(Array.isArray(codes), true, `${name} did not export an array`);
    assert.ok(codes.length > 0, `${name} exported an empty vocabulary`);
    for (const code of codes) assert.ok(code.startsWith("TRIP_"), `${name}: ${code}`);
  }
});

test("no code collides with any of the nine vocabularies, and any future code must be TRIP_", () => {
  // Ten files will write into one array and all ten sets of strings outlive the screen
  // that renders them. A duplicate would make two different findings indistinguishable on
  // the caseload, and a history row is what an appeal is argued from.
  //
  // Vacuous today by construction — the loop body runs zero times — and written anyway so
  // that the structure is in place before it is needed rather than after.
  const existing = [
    TRIP_CODES, COVERAGE_CODES, COHORT_CODES, WORKLOAD_CODES, FUNDING_CODES,
    SESSIONS_CODES, INTAKE_CODES, HISTORY_CODES, DIVERGENCE_CODES,
  ];
  for (const code of TIMETABLE_CODES) {
    assert.ok(code.startsWith("TRIP_"), code);
    for (const codes of existing) assert.equal(codes.includes(code), false, code);
  }
  assert.equal(new Set(TIMETABLE_CODES).size, TIMETABLE_CODES.length);
});

test("evaluate returns an empty codes array under every extreme input", () => {
  // The structural half of the "figures only" decision. It is not enough that the
  // vocabulary is empty — evaluate must never push anything, under any register, including
  // the ones a code-shaped implementation would fire hardest on.
  const extremes = [
    ["nothing at all", []],
    ["never attended anything", [
      ...singleSessionDays(1, 12, "09:00", "10:00", "A"),
    ]],
    ["misses every early start, perfect afterwards", [
      ...singleSessionDays(1, 8, "09:00", "10:00", "A"),
      ...singleSessionDays(10, 8, "13:00", "14:00", "P"),
    ]],
    ["misses every long day, perfect on short ones", [
      ...Array.from({ length: 8 }, (_, i) => [
        mk(d(1 + i), "09:00", "12:00", "A"), mk(d(1 + i), "13:00", "16:00", "A"),
      ]).flat(),
      ...singleSessionDays(12, 8, "09:00", "10:00", "P"),
    ]],
    ["never returns after a long gap", [
      ...Array.from({ length: 8 }, (_, i) => [
        mk(d(1 + i), "09:00", "10:00", "P"), mk(d(1 + i), "13:00", "14:00", "A"),
      ]).flat(),
      ...Array.from({ length: 8 }, (_, i) => [
        mk(d(12 + i), "09:00", "10:00", "P"), mk(d(12 + i), "10:30", "11:30", "P"),
      ]).flat(),
    ]],
  ];
  for (const [label, marks] of extremes) {
    const r = evaluate(input({ marks }), {});
    assert.deepEqual(r.codes, [], label);
  }
});

/* ========================================================================== */
/* TRAP FOUR: times are HH:MM strings and must never go through a Date         */
/* ========================================================================== */

test("minutesOf reads a hand-checked table of HH:MM strings", () => {
  const table = [
    ["00:00", 0],      // midnight is 0, and 0 is a value — see the next test
    ["00:01", 1],
    ["09:00", 540],
    ["09:30", 570],    // the early-start boundary
    ["12:00", 720],
    ["13:45", 825],
    ["23:59", 1439],
  ];
  for (const [s, expected] of table) assert.equal(minutesOf(s), expected, s);
});

test("minutesOf refuses everything that is not strictly HH:MM, and returns null not zero", () => {
  // NULL, NEVER 0. Zero is midnight — the earliest possible start — so a malformed string
  // coerced to 0 would be classified as the earliest session of its day AND as an early
  // start, which is the most confident possible answer manufactured from a typo. Every
  // rejection below is asserted to be null specifically, not merely falsy, because 0 is
  // falsy too and an assertion on falsiness would pass for the bug.
  const rejected = [
    "9:00",          // unpadded — Date.parse-ish leniency is exactly what is refused
    "09:00:00",      // seconds
    "0900",
    "09:60",         // minutes out of range
    "24:00",         // not a start time; a day that begins at 24:00 begins at 00:00
    "25:00",
    "-1:00",
    " 09:00",
    "09:00 ",
    "09:00Z",
    "",
    "abc",
    null,
    undefined,
    540,             // already minutes — a caller confusing the two must not be trusted
    new Date("2026-03-01T09:00:00Z"),
  ];
  for (const s of rejected) {
    assert.equal(minutesOf(s), null, `${String(s)} should be refused`);
  }
});

test("the module source contains no Date arithmetic on times", () => {
  // STRUCTURAL, AND IT IS THE ACTUAL GUARANTEE. A date-TIME string with no offset parses
  // as LOCAL time in JavaScript while a date-only string parses as UTC, so a Date-based
  // duration is right on a UTC runner and wrong on a laptop west of Greenwich — the same
  // shape as D8 in STATUS.md, the 08:00 notifications that fired at 09:00 through BST. And
  // on the two British clock-change Sundays a Date subtraction would make a 09:00–14:00
  // session four or six hours long, when a timetable's five hours is five hours of
  // teaching whatever the clocks did.
  //
  // A behavioural test cannot prove the absence: it would pass on a UTC CI runner for a
  // broken implementation. The absence of the construct can be proved, so it is.
  const src = fs.readFileSync(path.join(__dirname, "timetable.js"), "utf8");
  const code = src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  assert.equal(/new Date\s*\(/.test(code), false, "timetable.js constructs a Date");
  assert.equal(/\.getHours\s*\(|\.getMinutes\s*\(|getTimezoneOffset/.test(code), false);
});

/* ========================================================================== */
/* The institution probe                                                       */
/* ========================================================================== */

test("earlyStartShape and evaluate throw without a boolean lateRecorded", () => {
  // Loudly, at the first call, the way db.js refuses a query with no tenant context. A
  // falsy default would cost the whole lateness dimension permanently and silently — null
  // for every student at every college, no test failing, no row looking wrong — and the
  // lateness half is the one that makes an early-start finding actionable, because at nine
  // o'clock arriving at 09:20 is the same phenomenon as not arriving.
  const bad = [undefined, null, {}, { lateRecorded: undefined }, { lateRecorded: "yes" },
    { lateRecorded: 1 }, { lateRecorded: 0 }, { lateKnown: true }];
  for (const institution of bad) {
    assert.throws(() => earlyStartShape([], institution, {}), TypeError, String(institution));
    assert.throws(() => evaluate(input({ institution }), {}), TypeError, String(institution));
    assert.throws(() => assertInstitutionProbe(institution, "x"), TypeError);
  }
});

test("a probe of false is accepted — it is an answer, not a missing one", () => {
  // The distinction the whole guard rests on. `false` says "this college records no
  // lateness"; `undefined` says "nobody asked". Refusing both would make the guard
  // unusable at exactly the colleges it protects.
  assert.doesNotThrow(() => earlyStartShape([], LATE_UNKNOWN, {}));
  assert.doesNotThrow(() => evaluate(input({ institution: LATE_UNKNOWN }), {}));
});

test("evaluate throws before reading anything else", () => {
  // So a caller who forgot the probe finds out on their first fixture rather than after a
  // term of blank columns. Passed deliberately hostile marks: if the probe were checked
  // after the marks were walked, this would throw the wrong error.
  assert.throws(
    () => evaluate({ marks: [null, {}, { status: "A" }] }, {}),
    (e) => e instanceof TypeError && /lateRecorded/.test(e.message),
  );
});

/* ========================================================================== */
/* TRAP TWO: minimum denominators on BOTH sides                                */
/* ========================================================================== */

test("a clean early-start pattern produces both rates and the gap", () => {
  // The positive case, stated once so every refusal below is provably a refusal rather
  // than the module being unable to answer anything.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartAbsenceRate, 100);
  assert.equal(r.laterStartAbsenceRate, 0);
  assert.equal(r.earlyStartAbsenceGap, 100);
  assert.equal(r.earlyStartDays, 6);
  assert.equal(r.laterStartDays, 6);
});

test("every session starting at nine: no comparison exists, so both rates are null", () => {
  // TRAP TWO'S SECOND HALF, and the one an implementation gets wrong by reporting the one
  // group it can see. Twelve nine o'clock mornings, half of them missed. There is nothing
  // that is not an early start, so this student does not have "early sessions" — they have
  // sessions. Reporting 50 under a column named earlyStartAbsenceRate would state a
  // contrast that was never drawn.
  //
  // The title says both rates are null and the assertion says both rates are null. Asserted
  // individually rather than through a loop so a failure names which one leaked.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "09:00", "10:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartAbsenceRate, null);
  assert.equal(r.laterStartAbsenceRate, null);
  assert.equal(r.earlyStartAbsenceGap, null);
  assert.equal(r.earlyStartLatenessRate, null);
  assert.equal(r.laterStartLatenessRate, null);
  assert.equal(r.earlyStartLatenessGap, null);
  // The denominators are still reported, so a reader can see WHY: twelve early days and
  // no later ones. This is the figure that distinguishes "we refused" from "we found
  // nothing", and it is the only thing on the row that does.
  assert.equal(r.earlyStartDays, 12);
  assert.equal(r.laterStartDays, 0);
});

test("a thin side withholds BOTH rates, not just the gap", () => {
  // The half-guard this module deliberately does not have. sessions.sliceShape reports the
  // worst slice's own rate even when the pooled rest is too thin, because "her Friday rate
  // is 40%" is a sentence that stands alone. "Her early-start rate is 100%" is not: the
  // label means nothing except in contrast, so the whole comparison is withheld together.
  //
  // Five early days is one below earlyMinMarks.
  const thinEarly = earlyStartShape([
    ...singleSessionDays(1, 5, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 8, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(thinEarly.earlyStartAbsenceRate, null);
  assert.equal(thinEarly.laterStartAbsenceRate, null);
  assert.equal(thinEarly.earlyStartAbsenceGap, null);

  // And symmetrically, with the thin side being the uninteresting one. The floor is the
  // same number on both sides on purpose: unlike sessions.sliceShape's pooled rest, neither
  // side here is the big one by construction, so an asymmetric floor would make the module
  // answer or refuse depending on which way round the timetable happened to fall.
  const thinLater = earlyStartShape([
    ...singleSessionDays(1, 8, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 5, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(thinLater.earlyStartAbsenceRate, null);
  assert.equal(thinLater.laterStartAbsenceRate, null);
  assert.equal(thinLater.earlyStartAbsenceGap, null);
  assert.equal(TIMETABLE_DEFAULTS.earlyMinMarks, 6);
});

test("six early marks spread over two days do not clear the day floor", () => {
  // MARKS WITHIN A DAY ARE NOT INDEPENDENT OBSERVATIONS. Three parallel nine o'clock
  // registers — two units both starting at nine, which HndSession's unique key on
  // (unit, date, start) permits — give six marks from two mornings. One decision to stay
  // in bed produces three absences.
  //
  // This is also the test that proves earlyMinDays is load-bearing here rather than
  // ceremonial: without it the mark floor alone would pass this fixture.
  const parallel = [];
  for (let i = 0; i < 2; i += 1) {
    parallel.push(mk(d(1 + i), "09:00", "10:00", "A"));
    parallel.push(mk(d(1 + i), "09:00", "10:00", "A"));
    parallel.push(mk(d(1 + i), "09:00", "10:00", "A"));
  }
  const r = earlyStartShape([
    ...parallel,
    ...singleSessionDays(10, 8, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartDays, 2);
  assert.equal(r.earlyStartAbsenceRate, null);
  assert.equal(r.laterStartAbsenceRate, null);
  assert.equal(r.earlyStartAbsenceGap, null);
  assert.equal(TIMETABLE_DEFAULTS.earlyMinDays, 4);
});

/* ========================================================================== */
/* earlyStartShape: only the first sitting of the day is in scope              */
/* ========================================================================== */

test("sessions that are not the first sitting of their day leave both sides", () => {
  // THE CONTROL THAT MAKES THE FIGURE MEAN ANYTHING. Restricting both sides to the first
  // sitting holds position-in-day constant, so what is left is the clock rather than the
  // effect firstSessionAbsenceRate already reports. Each 13:00 day here carries a 16:00
  // session that is entirely absent; if those leaked into the comparison the later-start
  // rate would be 50 rather than 0.
  const marks = [
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
  ];
  for (let i = 0; i < 6; i += 1) {
    marks.push(mk(d(10 + i), "13:00", "14:00", "P"));
    marks.push(mk(d(10 + i), "16:00", "17:00", "A"));
  }
  const r = earlyStartShape(marks, LATE_KNOWN, {});
  assert.equal(r.laterStartAbsenceRate, 0, "a later session leaked into the first-sitting group");
  assert.equal(r.earlyStartAbsenceRate, 100);
  assert.equal(r.notFirstSitting, 6);
});

test("two registers sharing the day's earliest start are BOTH the first sitting", () => {
  // No tie-break, no sorting, nothing that depends on the order Postgres returned the rows
  // in. Both nine o'clock registers are evidence about getting there for nine, so both
  // count; an implementation that sorted and took index 0 would count one and silently
  // discard the other, and which one would depend on a comparator.
  const marks = [];
  for (let i = 0; i < 5; i += 1) {
    marks.push(mk(d(1 + i), "09:00", "10:00", "A"));
    marks.push(mk(d(1 + i), "09:00", "10:00", "P"));
  }
  const r = earlyStartShape([...marks, ...singleSessionDays(10, 8, "13:00", "14:00", "P")],
    LATE_KNOWN, {});
  assert.equal(r.earlyStartDays, 5);
  // Ten marks, five absent. Taking one per day would give either 0 or 100.
  assert.equal(r.earlyStartAbsenceRate, 50);
  assert.equal(r.notFirstSitting, 0);
});

test("a one-session day is a first sitting and is included", () => {
  // The asymmetry against gapShape, which excludes single-session days. There the reason is
  // structural — a gap needs two sessions to exist — and it would be easy to copy the rule
  // across as though it were a general principle. "Could they get here for the start" is a
  // question a one-session day answers perfectly well.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartDays, 6);
  assert.equal(r.earlyStartAbsenceRate, 100);
});

test("a half-past-nine start is NOT early: the boundary sits between the two shapes", () => {
  // The threshold is 570 = 09:30 and the comparison is strictly `<`, so a session starting
  // AT 09:30 is a later start. Pinned because a mutation pass showed `<` flipping to `<=`
  // with every other test still passing — which is exactly the property the constant was
  // chosen for (colleges start at 09:00 or 10:00, so nothing real sits on the boundary)
  // and is therefore precisely the thing that must be nailed down here rather than left to
  // the fixtures. A threshold of 540 would put the most common start time in the country
  // on the boundary and make the whole figure depend on one character.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:30", "10:30", "A"),
    ...singleSessionDays(10, 6, "09:00", "10:00", "P"),
  ], LATE_KNOWN, {});
  // 09:00 is the early group; 09:30 is not. So the ABSENT days are the later starts.
  assert.equal(TIMETABLE_DEFAULTS.earlyStartBeforeMinutes, 570);
  assert.equal(r.earlyStartAbsenceRate, 0, "09:30 was classified as an early start");
  assert.equal(r.laterStartAbsenceRate, 100);
  assert.equal(r.earlyStartAbsenceGap, -100);
});

test("earlyStartShape needs no endTime and is unaffected by its absence", () => {
  // The wiring degradation, pointed at the one function that does not depend on the field.
  // metrics.js does not carry endTime today, so this is the only shape that can produce a
  // value on either database as they stand — and a change that made all three depend on it
  // would silently take this one out too.
  const withEnd = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  const without = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", undefined, "A"),
    ...singleSessionDays(10, 6, "13:00", undefined, "P"),
  ], LATE_KNOWN, {});
  assert.deepEqual(without, withEnd);
});

/* ========================================================================== */
/* earlyStartShape: lateness, and the institution guard on it                  */
/* ========================================================================== */

test("L counts as attendance in the absence rate and as lateness separately", () => {
  // A late student was in the room. A module that folded L into absence would find patterns
  // in the traffic; one that ignored it would be blind to the commonest form of "cannot get
  // here for nine", which is arriving at ten past.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "L"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartAbsenceRate, 0, "L was counted as an absence");
  assert.equal(r.earlyStartLatenessRate, 100);
  assert.equal(r.laterStartLatenessRate, 0);
  assert.equal(r.earlyStartLatenessGap, 100);
});

test("E counts as absence: an excused nine o'clock is still one they were not taught", () => {
  // The same choice sessions.js makes and a deliberate divergence from tripwires' absence
  // streak, which counts A only. That signal asks "have we lost contact"; this asks "was
  // the shape of the day the obstacle", and a standing Tuesday-morning caring commitment is
  // exactly the timetable conversation this exists to start.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "E"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartAbsenceRate, 100);
});

test("the lateness gap is not clamped at zero either", () => {
  // A NEGATIVE lateness gap is the honest reading — they get to the nine o'clock on time
  // and drift in late after lunch, which is a different conversation from a transport
  // problem and points at a different fix. Clamping would manufacture a tie between that
  // and a student who is equally punctual all day. Pinned separately from the absence
  // gap because a mutation pass showed a Math.max(0, …) on this one surviving every other
  // test in the file: every other lateness fixture happens to lean the same way.
  const r = earlyStartShape([
    ...singleSessionDays(1, 6, "09:00", "10:00", "P"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "L"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartLatenessRate, 0);
  assert.equal(r.laterStartLatenessRate, 100);
  assert.equal(r.earlyStartLatenessGap, -100);
});

test("a college that records no lateness gets null lateness rates, never 0.0%", () => {
  // CLAUDE.md's most repeated bug in this area. The Moodle importer maps statuses by
  // acronym; a plugin with no "L" produces zero late marks for every student who ever
  // enrolled, and 0.0% is not "never late" — it is "not recorded". The absence rates are
  // unaffected, because the probe governs the lateness dimension only.
  const marks = [
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ];
  const r = earlyStartShape(marks, LATE_UNKNOWN, {});
  assert.equal(r.earlyStartLatenessRate, null);
  assert.equal(r.laterStartLatenessRate, null);
  assert.equal(r.earlyStartLatenessGap, null);
  assert.equal(r.earlyStartAbsenceRate, 100);
  assert.equal(r.laterStartAbsenceRate, 0);
  assert.equal(r.earlyStartAbsenceGap, 100);
});

test("lateness rates are withheld with the rest when the comparison is not drawable", () => {
  // Five early days, one below the floor. The lateness half must not survive a refusal the
  // absence half was subject to — it is the same comparison and it would read as a finding
  // about early starts on a row where no early-start comparison was made.
  const r = earlyStartShape([
    ...singleSessionDays(1, 5, "09:00", "10:00", "L"),
    ...singleSessionDays(10, 8, "13:00", "14:00", "P"),
  ], LATE_KNOWN, {});
  assert.equal(r.earlyStartLatenessRate, null);
  assert.equal(r.laterStartLatenessRate, null);
  assert.equal(r.earlyStartLatenessGap, null);
});

/* ========================================================================== */
/* dayLengthShape: the unit of observation is a DAY                            */
/* ========================================================================== */

/** A long day: 09:00–12:00 then 13:00–16:00, a span of seven hours. */
function longDay(day, morning, afternoon) {
  return [mk(d(day), "09:00", "12:00", morning), mk(d(day), "13:00", "16:00", afternoon)];
}

test("long days missed whole and short days attended produce the gap", () => {
  const marks = [];
  for (let i = 0; i < 5; i += 1) marks.push(...longDay(1 + i, "A", "A"));
  marks.push(...singleSessionDays(10, 5, "09:00", "10:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.longDayMissedRate, 100);
  assert.equal(r.shortDayMissedRate, 0);
  assert.equal(r.longDayMissedGap, 100);
  assert.equal(r.longDaysMeasured, 5);
  assert.equal(r.shortDaysMeasured, 5);
  assert.equal(r.daysWithoutSessionEnd, 0);
});

test("the outcome is per DAY, not per mark, and the two disagree in sign", () => {
  // THE MOST IMPORTANT TEST IN THE FILE. Counting marks carries a bias built into the
  // arithmetic: a long day holds several registers, so leaving at lunch scores 50% absent
  // on that day while missing a one-session short day scores 100%. Long days would look
  // BETTER than short ones for exactly the partial attendance a long day causes.
  //
  // Five long days attended in the morning and missed in the afternoon: nought days missed
  // whole, but half the marks absent. Five short days of which two are missed: 40% either
  // way.
  //
  //   per DAY  (correct):   0 - 40  = -40   "the long days are not the problem"
  //   per MARK (the bug):  50 - 40  = +10   "the long days are the problem"
  //
  // The two answers differ in SIGN, so this test cannot be satisfied by a mark-counting
  // implementation with a different constant.
  const marks = [];
  for (let i = 0; i < 5; i += 1) marks.push(...longDay(1 + i, "P", "A"));
  marks.push(...singleSessionDays(10, 3, "09:00", "10:00", "P"));
  marks.push(...singleSessionDays(13, 2, "09:00", "10:00", "A"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.longDayMissedRate, 0);
  assert.equal(r.shortDayMissedRate, 40);
  assert.equal(r.longDayMissedGap, -40);
  assert.notEqual(r.longDayMissedGap, 10, "the figure is counting marks, not days");
});

test("the gap is not clamped at zero", () => {
  // A negative gap is the honest reading — the long days are the ones they manage — and
  // clamping it would manufacture a tie between that and a student whose week is flat.
  // coverage.staleness and sessions.sliceShape leave their negatives alone for the same
  // reason. Pinned separately from the sign test above so that a `Math.max(0, …)` cannot
  // hide behind it.
  const marks = [];
  for (let i = 0; i < 5; i += 1) marks.push(...longDay(1 + i, "P", "P"));
  marks.push(...singleSessionDays(10, 5, "09:00", "10:00", "A"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.longDayMissedGap, -100);
});

test("partial attendance on a long day is not a missed day", () => {
  // The conservative direction, and deliberate: the student DID make the journey. Why they
  // left early is gapShape's question and laterSessionAbsenceRate's, not a day-length
  // comparison's.
  const marks = [];
  for (let i = 0; i < 5; i += 1) marks.push(...longDay(1 + i, "A", "P"));
  marks.push(...singleSessionDays(10, 5, "09:00", "10:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.longDayMissedRate, 0);
});

test("a one-session day is a short day and is included", () => {
  // Excluding it was the earlier draft, and the reason for excluding it — that a
  // one-session day cannot be partially attended, so it is not comparable per mark —
  // disappears entirely once the outcome is per day. Excluding it now would leave the short
  // side empty at every college that teaches one session a day, which on the data in both
  // databases today (32 sessions across 24 dates) is most of them.
  const marks = [];
  for (let i = 0; i < 5; i += 1) marks.push(...longDay(1 + i, "A", "A"));
  marks.push(...singleSessionDays(10, 5, "14:00", "15:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.shortDaysMeasured, 5);
  assert.equal(r.shortDayMissedRate, 0);
});

/* ========================================================================== */
/* TRAP ONE: a missing endTime degrades to null, never to a wrong duration     */
/* ========================================================================== */

test("no endTime anywhere: every day-length figure is null and the count says why", () => {
  // metrics.js selects date, startTime, unitId and kind — NOT endTime — so this is the
  // state on both databases the day the module is wired. Null is the correct output. The
  // count is what makes it legible: every figure null on its own reads as "this student's
  // timetable is uniform"; null WITH the count equal to the day total reads as "the field
  // is not being carried", which is the true statement and the one that gets it fixed.
  //
  // The title says every figure is null and the assertion says every figure is null —
  // including longDaysMeasured, which is 0 and is asserted as 0 rather than being quietly
  // grouped with the nulls.
  const marks = [];
  for (let i = 0; i < 5; i += 1) {
    marks.push(mk(d(1 + i), "09:00", undefined, "A"), mk(d(1 + i), "13:00", undefined, "A"));
  }
  marks.push(...singleSessionDays(10, 5, "09:00", undefined, "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.longDayMissedRate, null);
  assert.equal(r.shortDayMissedRate, null);
  assert.equal(r.longDayMissedGap, null);
  assert.equal(r.longDaysMeasured, 0);
  assert.equal(r.shortDaysMeasured, 0);
  assert.equal(r.daysWithoutSessionEnd, 10);
});

test("a day with one missing endTime leaves both sides rather than being called short", () => {
  // The specific wrong answer this guards. Taking the maximum over the ends that ARE
  // present computes a confidently SHORT day from a partially-wired select: here the 09:00
  // session ends at 12:00 and the afternoon's end is unknown, so a max-over-what-we-have
  // implementation reports a three-hour day, classifies it short, and reports it with total
  // confidence. Falling back to the last START would give seven hours minus the final
  // session — systematically understating every long day at every college.
  //
  // Four long days survive, which is below dayLengthMinDays, so everything is null. That is
  // the point: one unwired session removes a day rather than mis-sorting it.
  const marks = [];
  for (let i = 0; i < 4; i += 1) marks.push(...longDay(1 + i, "A", "A"));
  marks.push(mk(d(5), "09:00", "12:00", "A"), mk(d(5), "13:00", undefined, "A"));
  marks.push(...singleSessionDays(10, 6, "09:00", "10:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.daysWithoutSessionEnd, 1);
  assert.equal(r.longDaysMeasured, 4, "the incomplete day was sorted into a group");
  assert.equal(r.shortDaysMeasured, 6, "the incomplete day was counted as short");
  assert.equal(r.longDayMissedRate, null);
  assert.equal(r.shortDayMissedRate, null);
  assert.equal(r.longDayMissedGap, null);
});

test("an endTime before its own startTime is unusable, not a negative duration", () => {
  // A typo, or a session somebody meant to run past midnight. A negative length would
  // classify the day as short with total confidence, which is a wrong answer where null is
  // the true one.
  const marks = [];
  for (let i = 0; i < 5; i += 1) {
    marks.push(mk(d(1 + i), "09:00", "08:00", "A"), mk(d(1 + i), "13:00", "16:00", "A"));
  }
  marks.push(...singleSessionDays(10, 5, "09:00", "10:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.daysWithoutSessionEnd, 5);
  assert.equal(r.longDaysMeasured, 0);
  assert.equal(r.longDayMissedRate, null);
});

test("an unparseable endTime is unusable in exactly the same way", () => {
  const marks = [];
  for (let i = 0; i < 5; i += 1) {
    marks.push(mk(d(1 + i), "09:00", "12:00:00", "A"), mk(d(1 + i), "13:00", "16:00", "A"));
  }
  marks.push(...singleSessionDays(10, 5, "09:00", "10:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.daysWithoutSessionEnd, 5);
  assert.equal(r.longDayMissedRate, null);
});

test("the long-day threshold sits between the two shapes a timetable produces", () => {
  // A four-hour day is short, a seven-hour day is long, and 5h30 is where the boundary sits
  // because nothing real is 5h30 — so `>=` versus `>` cannot change an answer. A threshold
  // of 300 would put the 09:00–14:00 day, which colleges genuinely timetable, exactly on
  // the boundary.
  assert.equal(TIMETABLE_DEFAULTS.longDayMinMinutes, 330);
  const build = (span) => {
    const marks = [];
    for (let i = 0; i < 6; i += 1) {
      // A single session of the given span, so the day length is exactly `span`.
      const endH = 9 + Math.floor(span / 60);
      const endM = span % 60;
      marks.push(mk(d(1 + i), "09:00", `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`, "A"));
    }
    // A comparison side of unambiguously short days.
    marks.push(...singleSessionDays(10, 6, "09:00", "10:00", "P"));
    return dayLengthShape(marks, {});
  };
  // 5h29 is short: it joins the comparison side, so there is only one group and the whole
  // comparison is refused.
  assert.equal(build(329).longDaysMeasured, 0);
  assert.equal(build(329).longDayMissedRate, null);
  // 5h30 is long.
  assert.equal(build(330).longDaysMeasured, 6);
  assert.equal(build(330).longDayMissedRate, 100);
});

test("four long days do not clear the day floor", () => {
  const marks = [];
  for (let i = 0; i < 4; i += 1) marks.push(...longDay(1 + i, "A", "A"));
  marks.push(...singleSessionDays(10, 8, "09:00", "10:00", "P"));
  const r = dayLengthShape(marks, {});
  assert.equal(r.longDaysMeasured, 4);
  assert.equal(r.longDayMissedRate, null);
  assert.equal(r.shortDayMissedRate, null);
  assert.equal(TIMETABLE_DEFAULTS.dayLengthMinDays, 5);
});

/* ========================================================================== */
/* TRAP FIVE / gapShape: a day with one session has NO gap, not a zero gap     */
/* ========================================================================== */

/** A day with a three-hour hole: 09:00–10:00, then 13:00–14:00. */
const gappyDay = (day, first, second) =>
  [mk(d(day), "09:00", "10:00", first), mk(d(day), "13:00", "14:00", second)];
/** A day with a half-hour turnaround: 09:00–10:00, then 10:30–11:30. */
const compactDay = (day, first, second) =>
  [mk(d(day), "09:00", "10:00", first), mk(d(day), "10:30", "11:30", second)];

test("returns after a long gap against returns after a short one", () => {
  const marks = [];
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(1 + i, "P", "A"));
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  assert.equal(r.afterLongGapAbsenceRate, 100);
  assert.equal(r.afterShortGapAbsenceRate, 0);
  assert.equal(r.longGapAbsenceGap, 100);
  assert.equal(r.longGapSessions, 6);
  assert.equal(r.shortGapSessions, 6);
  assert.equal(r.singleSessionDays, 0);
});

test("single-session days contribute NOTHING — not a gap of zero", () => {
  // TRAP FIVE. A day with one session has no gap; there is nothing to wait through. Scoring
  // it as a zero-minute gap would flood the comparison side, and at a college teaching one
  // session a day — which, on 32 sessions across 24 dates in both databases, is most days —
  // the "compact" side would BE the entire register. The finding would then read as "this
  // student attends single-session days better than gappy ones", which compares two shapes
  // of timetable rather than two versions of the same day.
  //
  // Ten single-session days, every one of them entirely absent. If they were counted as
  // zero-gap returns the short-gap rate would be 10/16 = 62.5%.
  const marks = [];
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(1 + i, "P", "A"));
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
  marks.push(...singleSessionDays(20, 10, "09:00", "10:00", "A"));
  const r = gapShape(marks, {});
  assert.equal(r.afterShortGapAbsenceRate, 0, "single-session days entered the comparison");
  assert.equal(r.shortGapSessions, 6);
  assert.equal(r.singleSessionDays, 10);
  assert.equal(r.longGapAbsenceGap, 100);
});

test("the first sitting of a day is never a return", () => {
  // Every morning here is absent and every afternoon present — the exact inverse of the
  // finding. If the first sitting were counted as a return with an unmeasurable gap it
  // would land in `unclassified`; if it were counted with a gap it would invert both rates.
  const marks = [];
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(1 + i, "A", "P"));
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "A", "P"));
  const r = gapShape(marks, {});
  assert.equal(r.afterLongGapAbsenceRate, 0);
  assert.equal(r.afterShortGapAbsenceRate, 0);
  assert.equal(r.longGapSessions, 6);
  assert.equal(r.shortGapSessions, 6);
  assert.equal(r.gapsUnmeasurable, 0);
});

test("two registers sharing the earliest start are both first sittings, neither a return", () => {
  // Strict `<` when looking for earlier sessions. Two parallel nine o'clock registers are
  // not earlier than one another, so neither is a return and neither generates a gap of
  // zero against the other.
  const marks = [];
  for (let i = 0; i < 6; i += 1) {
    marks.push(mk(d(1 + i), "09:00", "10:00", "P"));
    marks.push(mk(d(1 + i), "09:00", "10:00", "P"));
    marks.push(mk(d(1 + i), "13:00", "14:00", "A"));
  }
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  assert.equal(r.longGapSessions, 6, "a parallel first register was counted as a return");
  assert.equal(r.afterLongGapAbsenceRate, 100);
});

test("an unknown earlier endTime makes the gap unmeasurable, not large", () => {
  // THE DEGRADATION THAT WOULD MANUFACTURE THE FINDING. With the morning's end unknown, a
  // fallback to start-to-start would measure 09:00 to 13:00 — four hours — and classify
  // every one of these as a long gap with total confidence. The unknown end could be
  // 12:55, in which case it is a five-minute turnaround.
  const marks = [];
  for (let i = 0; i < 6; i += 1) {
    marks.push(mk(d(1 + i), "09:00", undefined, "P"), mk(d(1 + i), "13:00", "14:00", "A"));
  }
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  assert.equal(r.gapsUnmeasurable, 6);
  assert.equal(r.longGapSessions, 0);
  assert.equal(r.afterLongGapAbsenceRate, null);
  assert.equal(r.afterShortGapAbsenceRate, null);
  assert.equal(r.longGapAbsenceGap, null);
});

test("the gap is measured from the LATEST earlier end, not the immediately preceding one", () => {
  // The student is free from the moment the last of their earlier classes finishes. A day
  // of 09:00–13:00, 10:00–10:30 and then 12:30 has a NEGATIVE gap before the 12:30 session
  // — the long morning session is still running — whereas walking back one entry in a
  // sorted list finds the 10:30 finish and reports a two-hour hole. The two classify
  // differently, so this cannot pass by accident.
  const marks = [];
  for (let i = 0; i < 6; i += 1) {
    marks.push(
      mk(d(1 + i), "09:00", "13:00", "P"),
      mk(d(1 + i), "10:00", "10:30", "P"),
      mk(d(1 + i), "12:30", "13:30", "A"),
    );
  }
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  // The 10:00 and 12:30 sessions are both returns; both fall on the short side.
  assert.equal(r.longGapSessions, 6, "a 12:30 session was called a long-gap return");
  assert.equal(r.shortGapSessions, 12);
  assert.equal(r.afterShortGapAbsenceRate, 50);
  assert.equal(r.afterLongGapAbsenceRate, 0);
});

test("an overlapping pair of registers is a short gap, not a discarded one", () => {
  // A negative gap means two registers overlap, which is a data error at the college. The
  // session still ran and the student was still marked in it, so discarding it would
  // quietly shrink the comparison side — the side a thin denominator damages most.
  const marks = [];
  for (let i = 0; i < 6; i += 1) {
    marks.push(mk(d(1 + i), "09:00", "14:00", "P"), mk(d(1 + i), "10:00", "11:00", "A"));
  }
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  assert.equal(r.shortGapSessions, 6);
  assert.equal(r.gapsUnmeasurable, 0);
  assert.equal(r.afterShortGapAbsenceRate, 100);
});

test("the gap threshold sits above a long lunch and below a rare hole", () => {
  // 60 or 90 would classify nearly every full teaching day at nearly every college as
  // gappy, which is a fact about the sector rather than about a student and would leave the
  // comparison side empty. 180 is the vivid version and is rare enough that the group would
  // essentially never clear its floor.
  assert.equal(TIMETABLE_DEFAULTS.longGapMinMinutes, 120);
  const build = (gapMinutes) => {
    const marks = [];
    const startH = 10 + Math.floor(gapMinutes / 60);
    const startM = gapMinutes % 60;
    const at = `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`;
    for (let i = 0; i < 6; i += 1) {
      marks.push(mk(d(1 + i), "09:00", "10:00", "P"), mk(d(1 + i), at, "23:00", "A"));
    }
    for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
    return gapShape(marks, {});
  };
  assert.equal(build(119).longGapSessions, 0);
  assert.equal(build(120).longGapSessions, 6);
});

test("six long-gap returns from two days do not clear the day floor", () => {
  // Three parallel one o'clock registers on each of two afternoons. Six marks from two
  // decisions to go home. The day floor is what stops "absent after every long gap" resting
  // on a fortnight.
  const marks = [];
  for (let i = 0; i < 2; i += 1) {
    marks.push(mk(d(1 + i), "09:00", "10:00", "P"));
    marks.push(mk(d(1 + i), "13:00", "14:00", "A"));
    marks.push(mk(d(1 + i), "13:00", "14:00", "A"));
    marks.push(mk(d(1 + i), "13:00", "14:00", "A"));
  }
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  assert.equal(r.longGapSessions, 6);
  assert.equal(r.longGapDays, 2);
  assert.equal(r.afterLongGapAbsenceRate, null);
  assert.equal(r.afterShortGapAbsenceRate, null);
  assert.equal(TIMETABLE_DEFAULTS.gapMinDays, 4);
});

test("gapShape reports no lateness figures at all", () => {
  // Deliberate. "L" after a gap is indistinguishable from "L" for any other reason, and the
  // mechanism this function is about is not coming back at all. Two more numbers with no
  // sentence attached is how a row becomes unreadable.
  const marks = [];
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(1 + i, "P", "L"));
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(10 + i, "P", "P"));
  const r = gapShape(marks, {});
  assert.equal(Object.keys(r).some((k) => /late/i.test(k)), false);
  // And L is attendance, so the long-gap absence rate is 0 rather than 100.
  assert.equal(r.afterLongGapAbsenceRate, 0);
});

/* ========================================================================== */
/* Nulls, not zeros, and nothing thrown on rubbish                             */
/* ========================================================================== */

test("no marks at all: every figure is null and every count is zero", () => {
  // Null means "not measurable"; zero means zero. A student nobody has marked has not
  // attended 0% of their early starts — the question has not been asked of them. The counts
  // ARE zero and are asserted as zero, because "how many early mornings did we see" has the
  // answer none.
  const r = evaluate(input({ marks: [] }), {});
  for (const key of [
    "earlyStartAbsenceRate", "laterStartAbsenceRate", "earlyStartAbsenceGap",
    "earlyStartLatenessRate", "laterStartLatenessRate", "earlyStartLatenessGap",
    "longDayMissedRate", "shortDayMissedRate", "longDayMissedGap",
    "afterLongGapAbsenceRate", "afterShortGapAbsenceRate", "longGapAbsenceGap",
  ]) {
    assert.equal(r[key], null, key);
  }
  for (const key of ["earlyStartDays", "longDaysMeasured", "longGapSessions",
    "daysWithoutSessionEnd", "singleSessionDays"]) {
    assert.equal(r[key], 0, key);
  }
  assert.deepEqual(r.codes, []);
});

test("rubbish in the marks array is counted, never thrown on and never guessed at", () => {
  const rubbish = [
    null, undefined, {},
    { status: "X", date: d(1), startTime: "09:00", endTime: "10:00" },   // unrecognised status
    { status: "A", date: "2026-3-1", startTime: "09:00", endTime: "10:00" }, // loose date
    { status: "A", date: "not-a-date", startTime: "09:00", endTime: "10:00" },
    { status: "A", date: d(1), startTime: "9:00", endTime: "10:00" },    // loose time
    { status: "A", date: d(1), startTime: null, endTime: "10:00" },
    { status: "A", date: null, startTime: "09:00", endTime: "10:00" },
  ];
  const r = earlyStartShape(rubbish, LATE_KNOWN, {});
  assert.equal(r.earlyStartAbsenceRate, null);
  assert.equal(r.earlyStartDays, 0);
  // Three rows carry a recognised status and a usable-looking shape but fail on the date or
  // the time; the two with an unrecognised status or no fields at all are not observations
  // and are not counted here.
  assert.equal(r.unplaceableMarks, 5);
  assert.doesNotThrow(() => dayLengthShape(rubbish, {}));
  assert.doesNotThrow(() => gapShape(rubbish, {}));
  assert.doesNotThrow(() => evaluate(input({ marks: rubbish }), {}));
  assert.doesNotThrow(() => evaluate({ institution: LATE_KNOWN }, undefined));
  assert.doesNotThrow(() => earlyStartShape(null, LATE_KNOWN, undefined));
});

test("a loose date spelling would have split one day in two, and is refused instead", () => {
  // The reason isDate is strict here is specific and is not sessions.js's reason. Dates are
  // bucket keys: "2026-3-01" and "2026-03-01" would be two separate days, splitting one
  // six-hour day into two three-hour ones and silently halving its length. Both spellings
  // of the same morning are supplied; the loose one must not create a second day.
  const { days, unplaceable } = buildDays([
    mk("2026-03-01", "09:00", "12:00", "P"),
    mk("2026-3-01", "13:00", "16:00", "A"),
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, "2026-03-01");
  assert.equal(unplaceable, 1);
});

/* ========================================================================== */
/* Determinism, and the config seam                                            */
/* ========================================================================== */

test("the answer does not depend on the order the marks arrived in", () => {
  // The marks query in metrics.js has no ORDER BY, so arrival order is whatever Postgres
  // returned. A figure that changed between two runs with nothing about the student having
  // changed makes the whole row untrustworthy — and this module has three places where a
  // naive implementation would depend on order: picking the first sitting, finding the last
  // end of a day, and walking back to the previous session.
  const marks = [];
  for (let i = 0; i < 6; i += 1) marks.push(...longDay(1 + i, "P", "A"));
  for (let i = 0; i < 6; i += 1) marks.push(...gappyDay(10 + i, "P", "A"));
  for (let i = 0; i < 6; i += 1) marks.push(...compactDay(20 + i, "L", "P"));
  const a = evaluate(input({ marks }), {});
  const b = evaluate(input({ marks: shuffled(marks) }), {});
  const c = evaluate(input({ marks: shuffled(shuffled(marks)) }), {});
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test("config overrides the defaults and can collapse a comparison to nothing", () => {
  // The settings.js seam: defaults in code, overridden by whatever the caller merges over
  // them. With the early boundary moved to 08:00, a nine o'clock start is no longer early,
  // both groups collapse into one, and the honest answer becomes null.
  const marks = [
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ];
  assert.equal(evaluate(input({ marks }), {}).earlyStartAbsenceGap, 100);
  const moved = evaluate(input({ marks }), { earlyStartBeforeMinutes: 480 });
  assert.equal(moved.earlyStartAbsenceRate, null);
  assert.equal(moved.laterStartAbsenceRate, null);
  assert.equal(moved.earlyStartAbsenceGap, null);
  assert.equal(moved.earlyStartDays, 0);
});

test("weeksIntoProgramme is accepted and changes nothing", () => {
  // Accepted and read by nothing ON PURPOSE, so the decision is visible at the call site
  // rather than looking like an oversight. With no codes there is nothing to mute, and the
  // FIGURES must not be muted either: a rate with a minimum denominator on both sides
  // cannot fire on an intake nobody has marked, because with no marks both sides are empty
  // and every figure is null already.
  //
  // Both halves of CLAUDE.md's rule are pinned: week one is not exempt, and an UNKNOWN
  // programme age is not exempt either — muting for a student the calendar cannot place
  // fails safe in the wrong direction.
  const marks = [
    ...singleSessionDays(1, 6, "09:00", "10:00", "A"),
    ...singleSessionDays(10, 6, "13:00", "14:00", "P"),
  ];
  const base = evaluate(input({ marks, weeksIntoProgramme: 30 }), {});
  for (const weeks of [0, 1, 2, null, undefined, -1]) {
    assert.deepEqual(evaluate(input({ marks, weeksIntoProgramme: weeks }), {}), base,
      `weeksIntoProgramme ${String(weeks)} changed the answer`);
  }
});

/* ========================================================================== */
/* The wiring state as it will actually be on the day this lands               */
/* ========================================================================== */

test("with endTime unwired, early-start figures survive and the other two do not", () => {
  // metrics.js flattens { status, sessionId, date, startTime, unitId, kind } — no endTime.
  // This is what the row looks like on both databases until that select is widened, and it
  // is asserted rather than described so that the wiring change has a test that notices it.
  const marks = [];
  for (let i = 0; i < 6; i += 1) {
    marks.push(mk(d(1 + i), "09:00", undefined, "A"), mk(d(1 + i), "13:00", undefined, "A"));
  }
  for (let i = 0; i < 6; i += 1) {
    marks.push(mk(d(10 + i), "13:00", undefined, "P"), mk(d(10 + i), "15:00", undefined, "P"));
  }
  const r = evaluate(input({ marks }), {});

  // The one shape that needs only startTime, which IS carried.
  assert.equal(r.earlyStartAbsenceRate, 100);
  assert.equal(r.laterStartAbsenceRate, 0);
  assert.equal(r.earlyStartAbsenceGap, 100);

  // The two that need endTime: null, with the count naming the reason.
  assert.equal(r.longDayMissedRate, null);
  assert.equal(r.shortDayMissedRate, null);
  assert.equal(r.longDayMissedGap, null);
  assert.equal(r.afterLongGapAbsenceRate, null);
  assert.equal(r.afterShortGapAbsenceRate, null);
  assert.equal(r.longGapAbsenceGap, null);
  assert.equal(r.daysWithoutSessionEnd, 12, "the unwired state is not visible on the row");
});

/* ========================================================================== */
/* twoGroupShape directly — the arithmetic under all three                     */
/* ========================================================================== */

test("twoGroupShape reports a group's own arithmetic even when it refuses to name it", () => {
  // The separation sessions.sliceShape also keeps: a thin group's rate is computed and
  // available for inspection, and only the REPORTED figures are withheld. A test that could
  // not see the arithmetic would not be able to tell a refusal from a miscount.
  const rows = [
    { group: true, absent: true, late: null, dayKey: "a" },
    { group: true, absent: false, late: null, dayKey: "b" },
    { group: false, absent: false, late: null, dayKey: "c" },
  ];
  const r = twoGroupShape(rows, { minObservations: 6, minDays: 4 });
  assert.equal(r.comparable, false);
  assert.equal(r.in.absenceRate, 50);
  assert.equal(r.out.absenceRate, 0);
  assert.equal(r.inRate, null);
  assert.equal(r.outRate, null);
  assert.equal(r.gap, null);
});

test("a group with no observations has a null rate, not a zero one", () => {
  const r = twoGroupShape([{ group: true, absent: true, late: null, dayKey: "a" }],
    { minObservations: 1, minDays: 1 });
  assert.equal(r.out.marks, 0);
  assert.equal(r.out.absenceRate, null);
  assert.equal(r.out.latenessRate, null);
  assert.equal(r.comparable, false);
});

test("lateness stays null unless some observation carried a boolean for it", () => {
  // Null-is-not-zero applied to a DIMENSION rather than to a measurement. A caller that
  // passes `late: null` throughout — because the college records no lateness, or because
  // the question is not about arriving — must get null, not a confident 0.0%.
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({ group: true, absent: false, late: null, dayKey: `a${i}` });
    rows.push({ group: false, absent: false, late: null, dayKey: `b${i}` });
  }
  const nulled = twoGroupShape(rows, { minObservations: 6, minDays: 4 });
  assert.equal(nulled.comparable, true);
  assert.equal(nulled.inLatenessRate, null);
  assert.equal(nulled.outLatenessRate, null);
  assert.equal(nulled.latenessGap, null);
  assert.equal(nulled.gap, 0, "the absence half must still be answered");

  // The same rows with an explicit false — which is a measurement — do give 0.
  const measured = twoGroupShape(rows.map((r) => ({ ...r, late: false })),
    { minObservations: 6, minDays: 4 });
  assert.equal(measured.inLatenessRate, 0);
  assert.equal(measured.latenessGap, 0);

  // AND A NON-BOOLEAN IS NOT A MEASUREMENT EITHER. `typeof === "boolean"` rather than a
  // null check, because a caller handing over a status string or a count would otherwise
  // switch the whole dimension on and report a rate derived from truthiness. Pinned
  // because a mutation pass showed the weaker `!= null` test surviving every other case:
  // the real callers only ever pass true, false or null, so nothing else exercises it.
  const truthyJunk = twoGroupShape(rows.map((r) => ({ ...r, late: "L" })),
    { minObservations: 6, minDays: 4 });
  assert.equal(truthyJunk.inLatenessRate, null);
  assert.equal(truthyJunk.outLatenessRate, null);
  assert.equal(truthyJunk.latenessGap, null);
});

test("lateness is withheld unless BOTH groups measured it", () => {
  // A gap between a measured rate and an unmeasured one is not a gap, it is a rate minus
  // nothing. No caller in this module can produce the state today — the institution probe
  // governs both groups at once — so it is asserted here, at the helper, where the
  // contract lives rather than where it happens not to be exercised.
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({ group: true, absent: false, late: true, dayKey: `a${i}` });
    rows.push({ group: false, absent: false, late: null, dayKey: `b${i}` });
  }
  const r = twoGroupShape(rows, { minObservations: 6, minDays: 4 });
  assert.equal(r.comparable, true);
  assert.equal(r.in.latenessRate, 100, "the group's own arithmetic is still visible");
  assert.equal(r.inLatenessRate, null);
  assert.equal(r.outLatenessRate, null);
  assert.equal(r.latenessGap, null);
});

test("an unclassified observation leaves both sides and is counted", () => {
  const rows = [
    { group: null, absent: true, late: null, dayKey: "a" },
    { group: undefined, absent: true, late: null, dayKey: "b" },
    { group: "early", absent: true, late: null, dayKey: "c" },   // a string is not a group
    { group: 1, absent: true, late: null, dayKey: "d" },
    { group: true, absent: false, late: null, dayKey: "e" },
  ];
  const r = twoGroupShape(rows, { minObservations: 1, minDays: 1 });
  assert.equal(r.unclassified, 4);
  assert.equal(r.in.marks, 1);
  assert.equal(r.in.absent, 0, "an unclassified absence leaked into a group");
  assert.equal(r.out.marks, 0);
});

test("rates are rounded to one decimal place, matching every other figure in the pipeline", () => {
  const rows = [];
  for (let i = 0; i < 7; i += 1) rows.push({ group: true, absent: i < 2, late: null, dayKey: `a${i}` });
  for (let i = 0; i < 7; i += 1) rows.push({ group: false, absent: false, late: null, dayKey: `b${i}` });
  const r = twoGroupShape(rows, { minObservations: 6, minDays: 4 });
  assert.equal(r.inRate, 28.6);
  assert.equal(r.gap, 28.6);
});

/* ========================================================================== */
/* The output contract                                                         */
/* ========================================================================== */

test("evaluate returns exactly these keys, and none of them is a derived day count", () => {
  // TWO RULES PINNED AT ONCE, both of which a mutation pass showed nothing else catching.
  //
  // First, the shape is the thing the wiring reads. A key added here has to land in a
  // nullable column on BOTH StudentPredictionCurrent and StudentPredictionHistory
  // (schema-contract.test.js enforces the nullability; nothing enforces that somebody
  // noticed the key appeared), and a key REMOVED here silently writes null to a column
  // that has been populated for a term.
  //
  // Second, and the reason the assertion is a list rather than a count: CLAUDE.md's "store
  // dates; derive day-counts at render time". Nothing in this feature runs on a schedule —
  // markStale fires on data events and a day passing is not an event — so an elapsed
  // figure written to a column is wrong by the next morning with nothing to correct it.
  // This module satisfies that by emitting no elapsed quantity AT ALL, which is why it
  // needs no `today` argument; the list is what makes an added "…Days ago" or "…WindowDays"
  // fail a test rather than ship.
  const expected = [
    "earlyStartAbsenceRate", "laterStartAbsenceRate", "earlyStartAbsenceGap",
    "earlyStartLatenessRate", "laterStartLatenessRate", "earlyStartLatenessGap",
    "earlyStartDays",
    "longDayMissedRate", "shortDayMissedRate", "longDayMissedGap", "longDaysMeasured",
    "afterLongGapAbsenceRate", "afterShortGapAbsenceRate", "longGapAbsenceGap",
    "longGapSessions",
    "daysWithoutSessionEnd", "singleSessionDays",
    "codes",
  ];
  const actual = Object.keys(evaluate(input({ marks: [] }), {}));
  assert.deepEqual(actual.slice().sort(), expected.slice().sort());

  // The counts that ARE returned count THINGS OBSERVED — days seen, sessions seen — never
  // time elapsed. "earlyStartDays" is how many early mornings were in the register, which
  // is true forever; "daysSinceLastEarlyStart" would be wrong tomorrow.
  for (const key of actual) {
    assert.equal(/since|ago|elapsed|window|current/i.test(key), false,
      `${key} reads as an elapsed quantity, which nothing recomputes`);
  }
});
