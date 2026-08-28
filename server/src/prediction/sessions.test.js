// Tests for the sessions layer: what SHAPE a student's absence takes, beyond how much of
// it there is.
//
// No database. sessions.js is pure — it takes the in-memory marks the gather has already
// flattened, plus today's date and an institution-wide probe result, and returns plain
// data.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS on purpose, in the house style: what does NOT
// fire, what comes back null rather than zero, and what is refused outright. This module
// has exactly one code and two deliberate refusals, so most of what it is worth testing
// is what it declines to say — and a refusal is the thing that looks identical to a
// working feature until somebody opens the caseload and finds a hundred identical rows.
//
// Run with: node --test src/prediction/sessions.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluate, dayOfWeekShape, kindShape, consecutiveWeeks, weekdayOf, weekStartOf,
  SESSIONS, SESSIONS_CODES, SESSIONS_DEFAULTS,
} = require("./sessions");

const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");
const { COHORT_CODES } = require("./cohort");
const { WORKLOAD_CODES } = require("./workload");
const { FUNDING_CODES } = require("./funding");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A college whose registers carry a session kind. */
const KINDED = { kindRecorded: true };
/** A college where HndSession.kind is "" on every row — the ordinary state. */
const UNKINDED = { kindRecorded: false };

/** 2026-01-05 is a Monday (2026-01-01 was a Thursday). Every fixture date below is
 *  derived from it so a week index and an ISO weekday are all a test has to state. */
const WEEK_ZERO = "2026-01-05";

/** The date of ISO weekday `weekday` (1 = Monday) in week `week` after WEEK_ZERO.
 *  UTC arithmetic throughout — the test must not be the thing that reintroduces a
 *  local-clock date. */
function day(week, weekday) {
  const d = new Date(`${WEEK_ZERO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + week * 7 + (weekday - 1));
  return d.toISOString().slice(0, 10);
}

/** The Monday of week `week`. */
const monday = (week) => day(week, 1);

const mark = (date, status, kind) => ({ status, date, kind });

/** `n` weekly marks on one weekday, all of the same status. */
function weekly(weekday, count, status, opts = {}) {
  const from = opts.from || 0;
  const kind = opts.kind;
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(mark(day(from + i, weekday), status, kind));
  return out;
}

/** The shape a caller hands evaluate(), with everything benign unless a test says so. */
const input = (over = {}) => ({
  today: day(9, 5),
  marks: [],
  weeksIntoProgramme: 20,
  institution: KINDED,
  ...over,
});

/* ========================================================================== */
/* The vocabulary                                                              */
/* ========================================================================== */

test("every code is namespaced TRIP_", () => {
  // Structural, and not decoration. These strings are appended to riskDriverCodes, the
  // same array engine.js fills from its six RED indicators. A code named RED_something
  // would read as the engine's own, and the next person to take redIndicatorCount off the
  // copy rather than off engine.js's internal `reds` array would silently wire the shape
  // of a timetable into a student's band via OVR-004.
  assert.ok(SESSIONS_CODES.length > 0, "the module must export a vocabulary");
  for (const code of SESSIONS_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with any of the five vocabularies already writing that column", () => {
  // Six files will write into the same array and all six sets of strings outlive the
  // screen that renders them. A duplicate would make two different findings
  // indistinguishable on the caseload, and history rows are what an appeal is argued
  // from. schema-contract.test.js makes exactly this assertion across the five wired
  // modules; this is the same test, run early, so the collision is found before wiring
  // rather than by it.
  const existing = [
    ["tripwires", TRIP_CODES],
    ["coverage", COVERAGE_CODES],
    ["cohort", COHORT_CODES],
    ["workload", WORKLOAD_CODES],
    ["funding", FUNDING_CODES],
  ];
  for (const code of SESSIONS_CODES) {
    for (const [name, codes] of existing) {
      assert.equal(codes.includes(code), false, `${code} is already emitted by ${name}`);
    }
  }
});

/* ========================================================================== */
/* TRAP FOUR: the weekday must not come from a clock                           */
/* ========================================================================== */

test("weekdayOf matches a hand-checked table of known dates", () => {
  // Pinned against dates whose weekday is independently checkable, and chosen to cover
  // the arithmetic's edges: the epoch itself (which is where the +3 comes from), both
  // century leap rules, and a year boundary.
  const table = [
    ["1970-01-01", 4],   // Thursday — the anchor the whole algorithm rests on
    ["1999-12-31", 5],   // Friday, and the last day of a year
    ["2000-02-29", 2],   // Tuesday — a century that IS a leap year (divisible by 400)
    ["2024-02-29", 4],   // Thursday — an ordinary leap day
    ["2026-01-01", 4],   // Thursday
    ["2026-01-05", 1],   // Monday — WEEK_ZERO, which every other fixture derives from
    ["2026-08-28", 5],   // Friday
  ];
  for (const [iso, expected] of table) {
    assert.equal(weekdayOf(iso), expected, iso);
  }
});

test("weekdayOf is unaffected by the British clock changes", () => {
  // THE TEST THAT WOULD HAVE CAUGHT D8. STATUS.md records the 08:00 notifications firing
  // at 09:00 because something read the host clock through BST. A weekday derived by
  // converting a date to an instant and back is exactly that shape of bug: the two
  // Sundays below are the ones on which a London clock jumps, and an implementation that
  // went through a local Date would be a day out on one side of each of them for any
  // host west of Greenwich.
  //
  // These pass on a UTC runner AND on a London laptop AND on a machine in New York,
  // because there is no Date object in weekdayOf at all — which is the actual guarantee,
  // and the reason the assertion is worth having even though it cannot fail here.
  assert.equal(weekdayOf("2026-03-28"), 6);   // the Saturday before the spring change
  assert.equal(weekdayOf("2026-03-29"), 7);   // BST begins
  assert.equal(weekdayOf("2026-03-30"), 1);   // the Monday after
  assert.equal(weekdayOf("2026-10-24"), 6);
  assert.equal(weekdayOf("2026-10-25"), 7);   // GMT returns
  assert.equal(weekdayOf("2026-10-26"), 1);
});

test("weekdayOf refuses anything that is not a YYYY-MM-DD date", () => {
  // The regex is not decoration. Date.parse accepts "2026-8-4", and this module compares
  // dates AS STRINGS, where "2026-8-4" sorts before "2026-10-01" and after "2026-07-31" —
  // a silently wrong ordering rather than a loud failure.
  for (const junk of ["2026-8-4", "26-08-04", "2026/08/04", "", "   ", "not a date",
                      null, undefined, 20260804, {}, ["2026-08-04"], "2026-13-01"]) {
    assert.equal(weekdayOf(junk), null, String(junk));
  }
});

test("an impossible calendar date ROLLS OVER, exactly as every other date helper here does", () => {
  // Written down as behaviour rather than fixed, and the reason is consistency rather
  // than laziness. V8 rejects a 13th month and silently rolls a 30th of February forward
  // to the 2nd of March, and `Date.parse` is what tripwires.daysBetween,
  // coverage.daysBetween, workload.isDate and shiftDays all rest on — so every module in
  // this pipeline already treats "2026-02-30" as the 2nd of March.
  //
  // A strict calendar check HERE would make sessions.js the one module that disagrees:
  // the same string would be bucketed into a week by consecutiveWeeks and refused by the
  // weekday, and the mark would land in one figure and not the other. Two modules
  // disagreeing about what a date is, is worse than both rolling it over in the same
  // direction — and the input is a NOT NULL string column written by a date picker, so
  // the case is defensive to begin with.
  assert.equal(weekdayOf("2026-02-30"), weekdayOf("2026-03-02"));
  assert.equal(weekStartOf("2026-02-30"), weekStartOf("2026-03-02"));
});

test("weekStartOf returns the Monday, and a Monday is its own week start", () => {
  assert.equal(weekStartOf("2026-01-05"), "2026-01-05");   // Monday
  assert.equal(weekStartOf("2026-01-11"), "2026-01-05");   // the Sunday of the same week
  assert.equal(weekStartOf("2026-01-12"), "2026-01-12");   // the next Monday
  assert.equal(weekStartOf("junk"), null);
});

test("week keys sort chronologically across a year boundary", () => {
  // WHY THE BUCKET KEY IS A DATE AND NOT AN ISO WEEK NUMBER. Week 1 of 2027 sorts before
  // week 53 of 2026 under every comparison there is, so a run spanning Christmas would
  // silently break in the middle and nobody would find it until January — during the
  // exact fortnight the register is quietest and the signal matters most.
  const before = weekStartOf("2026-12-30");
  const after = weekStartOf("2027-01-06");
  assert.ok(before < after, `${before} must sort before ${after}`);
});

/* ========================================================================== */
/* TRAP THREE: the institution probe is not optional                           */
/* ========================================================================== */

test("kindShape THROWS without an institution-wide probe result", () => {
  // Not "falls silent" — throws. tripwires.js can afford a falsy default because a
  // missing flag there costs one code that does not fire. Here it would cost the whole
  // kind dimension permanently and invisibly: nulls for every student at every college,
  // no test failing, no row looking wrong. A feature that quietly does nothing is not
  // discoverable by reading the output, so it fails the way db.js fails a query with no
  // tenant context.
  const marks = weekly(1, 8, "P", { kind: "Teaching" });
  for (const bad of [undefined, null, {}, { kindRecorded: undefined },
                     { kindRecorded: "yes" }, { kindRecorded: 1 }, { kindRecorded: null },
                     { timetableRecorded: true }]) {
    assert.throws(() => kindShape(marks, bad), TypeError, JSON.stringify(bad));
  }
});

test("evaluate THROWS without the probe, before it reads anything else", () => {
  // The point of failing here rather than deeper is that a caller who forgot the probe
  // finds out on their first fixture. A missing probe is a wiring bug, and a wiring bug
  // that produces plausible output is the one that ships.
  assert.throws(() => evaluate({ today: day(9, 5), marks: [] }, {}), TypeError);
  assert.throws(() => evaluate(input({ institution: {} }), {}), TypeError);
  assert.throws(() => evaluate(undefined, {}), TypeError);
});

test("a probe of FALSE is accepted — it is an answer, not a missing one", () => {
  // The guard must distinguish "this college does not record kind" from "nobody told us".
  // A guard that threw on both would make the ordinary college the error case.
  assert.doesNotThrow(() => kindShape([], UNKINDED));
  assert.doesNotThrow(() => evaluate(input({ institution: UNKINDED }), {}));
});

test("with no kind recorded anywhere, every kind figure is NULL and the marks are counted as unset", () => {
  // NOT ZEROES. A college that does not use the field has not been measured and found to
  // have one kind of session; the concept does not exist there. Zeroes would say "we
  // looked at the kinds and there were none", and a later reader would take a clean sheet
  // from it.
  const marks = [
    ...weekly(1, 8, "P", { kind: "Teaching" }),   // kinds present on the ROWS...
    ...weekly(5, 8, "A", { kind: "Seminar" }),
  ];
  // ...but the INSTITUTION probe says otherwise, and the probe wins. This is the exact
  // inversion the guard exists for: a chunk of 200 students can carry kinds that the
  // institution as a whole does not record, and a chunk that carries none can sit inside
  // a college that does.
  const r = kindShape(marks, UNKINDED);
  assert.equal(r.worstKind, null);
  assert.equal(r.worstKindAbsenceRate, null);
  assert.equal(r.kindAbsenceGap, null);
  // NULL, not 0. This test was titled "every kind figure is NULL" while asserting 0 for
  // this one, and the disagreement between the title and the assertion is how the defect
  // survived a full mutation run: zero says "we counted and found none", which is a claim
  // about a sample that was never taken.
  assert.equal(r.kindsMeasured, null);
  assert.equal(r.kindUnset, 16, "the whole register is reported as unmeasured");
});

test('kind "" is UNSET, not a session kind called nothing', () => {
  // HndSession.kind is @default(""), so at a Moodle-synced college every row carries it.
  // Treating "" as a bucket puts the entire register in one slice that is 100% of itself,
  // which reads either as a perfectly concentrated finding for the whole institution or —
  // once somebody "fixes" that — as a clean sheet for everybody. Both from one string.
  const r = kindShape([...weekly(1, 8, "A", { kind: "" }),
                       ...weekly(3, 8, "A", { kind: "   " })], KINDED);
  assert.equal(r.worstKind, null);
  assert.equal(r.kindsSeen, 0, "an empty kind creates no bucket");
  assert.equal(r.kindUnset, 16);
});

test("a probe of TRUE with no kinds on the rows says the SELECT is missing, not the college", () => {
  // The state metrics.js is in today: it does not carry `kind` on a flattened mark. The
  // figures are null either way, and `kindUnset` is what distinguishes "this college has
  // no kinds" from "this pipeline did not fetch them" — which is the difference between
  // nothing to do and a one-line wiring fix.
  const noKindField = weekly(1, 8, "A").concat(weekly(3, 8, "P"));
  const r = kindShape(noKindField, KINDED);
  assert.equal(r.worstKind, null);
  assert.equal(r.kindUnset, 16);
  assert.equal(r.kindsSeen, 0);
});

/* ========================================================================== */
/* TRAP ONE: unmeasured is neither 0% nor 100%                                 */
/* ========================================================================== */

test("a weekday the student has never had a session on appears NOWHERE", () => {
  // TRAP ONE, AND THE CENTRAL TEST OF dayOfWeekShape. A weekday with no sessions is not
  // 100% attendance and not 0% — it is unmeasured, and it must leave both sides. It falls
  // out of the structure (buckets are built FROM the marks) rather than from a branch,
  // which is exactly why the tidy-up of seeding seven zeroed weekdays "to make the array
  // complete" is so tempting and so wrong: at a college that timetables nothing on
  // Fridays it would give every student in the institution a perfect Friday.
  const r = dayOfWeekShape([...weekly(1, 8, "P"), ...weekly(3, 8, "P")]);

  assert.equal(r.weekdaysSeen, 2, "only Monday and Wednesday exist for this student");
  assert.deepEqual(r.weekdays.map((w) => w.key), [1, 3]);
  for (const w of r.weekdays) assert.ok(w.key === 1 || w.key === 3);
  // And nothing anywhere claims a Friday.
  assert.equal(r.weekdays.some((w) => w.key === 5), false);
});

test("a student with no marks at all gets nulls, not a clean sheet", () => {
  const r = dayOfWeekShape([]);
  assert.equal(r.worstWeekday, null);
  assert.equal(r.worstWeekdayAbsenceRate, null);
  assert.equal(r.weekdayAbsenceGap, null);
  assert.equal(r.weekdaysMeasured, 0);
  assert.equal(r.weekdaysSeen, 0);
});

test("rows with an unrecognised status are not observations", () => {
  // isStatus is the same filter attendance.summarise() applies before counting anything,
  // so the two sides of any comparison a caller makes stay in step. A row with a status
  // an importer invented is a row, not a register having been taken.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "X"),
    ...weekly(3, 8, "?"),
    ...weekly(5, 8, "P"),
  ]);
  assert.equal(r.weekdaysSeen, 1);
  assert.deepEqual(r.weekdays.map((w) => w.key), [5]);
});

test("a mark whose date will not parse leaves both sides and is counted", () => {
  // The rule metrics.js already applies to an assessment with no due date, pointed at a
  // register. Dropping it silently would make the denominator quietly wrong; counting it
  // as absent would invent an absence.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "P"),
    ...weekly(3, 8, "P"),
    { status: "A", date: "2026-8-4" },
    { status: "A", date: null },
  ]);
  assert.equal(r.undated, 2);
  assert.equal(r.weekdays.reduce((n, w) => n + w.marked, 0), 16, "the 16 dated marks only");
});

/* ========================================================================== */
/* TRAP TWO: minimum denominators on both sides of every rate                  */
/* ========================================================================== */

test("a weekday below the floor cannot be NAMED the worst, however bad it looks", () => {
  // Three Fridays, all missed. 100% absent, and it is arithmetically true — and it is
  // also the loudest number this module can produce, drawn from three rows. The same
  // guard disperseMinMarks gives a unit: "left in the comparison it is always the worst,
  // and the signal would be pointing at the register rather than at the student".
  const r = dayOfWeekShape([
    ...weekly(1, 8, "P"),
    ...weekly(3, 8, "P"),
    ...weekly(5, 3, "A"),
  ]);

  assert.notEqual(r.worstWeekday, 5, "Friday is not nameable on three marks");
  assert.equal(r.weekdaysMeasured, 2, "only Monday and Wednesday clear the floor");
  // The thin slice's own arithmetic is still visible for an auditor — what is withheld is
  // the CLAIM that it is the worst, not the count behind it.
  const friday = r.weekdays.find((w) => w.key === 5);
  assert.equal(friday.marked, 3);
  assert.equal(friday.measurable, false);
});

test("one measurable weekday is not a comparison, and the superlative is withheld", () => {
  // unitDispersion's `usable.length < 2`, in a second place. "The worst weekday" over one
  // candidate is that day's rate wearing a comparative's clothes, and on the screen it
  // reads as though six other days had been ruled out.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "A"),
    ...weekly(3, 2, "P"),
    ...weekly(5, 2, "P"),
  ]);
  assert.equal(r.weekdaysMeasured, 1);
  assert.equal(r.worstWeekday, null);
  assert.equal(r.worstWeekdayAbsenceRate, null);
  assert.equal(r.weekdayAbsenceGap, null);
});

test("the OTHER side of the gap carries its own floor", () => {
  // THE HALF-GUARD, which is the classic version of this mistake: a floor on the
  // interesting number and none on the one it is compared against. Four absent Mondays
  // against four present Wednesdays is a 100-point gap resting on a four-mark denominator.
  // The slice's own rate survives — it is a measurement — but the GAP, which is the thing
  // that reads as a pattern, does not.
  const r = dayOfWeekShape([...weekly(1, 4, "A"), ...weekly(3, 4, "P")]);

  assert.equal(r.weekdaysMeasured, 2);
  assert.equal(r.worstWeekday, 1);
  assert.equal(r.worstWeekdayAbsenceRate, 100, "the rate is a fact and is reported");
  assert.equal(r.weekdayAbsenceGap, null, "the comparison is not");
});

test("the floors are the DEFAULTS, and a caller may not be handed a rate below them", () => {
  // Pins the constants themselves. They are argued in the module against the floors
  // settings.js already carries — slopeMinMarks 3, disperseMinMarks 4, minMarksForRate 6
  // — and a later reader lowering one to "make the signal appear" should have to change a
  // test that says which existing number it was matched to.
  assert.equal(SESSIONS_DEFAULTS.weekdayMinMarks, 4, "disperseMinMarks — one slice");
  assert.equal(SESSIONS_DEFAULTS.weekdayMinOtherMarks, 6, "minMarksForRate — the rest");
  assert.equal(SESSIONS_DEFAULTS.minWeekdaysMeasured, 2, "unitDispersion's two");
  assert.equal(SESSIONS_DEFAULTS.kindMinMarks, 4);
  assert.equal(SESSIONS_DEFAULTS.kindMinOtherMarks, 6);
  assert.equal(SESSIONS_DEFAULTS.minKindsMeasured, 2);
  assert.equal(SESSIONS_DEFAULTS.zeroWeekMinMarks, 3, "absenceStreakSessions/slopeMinMarks");
  assert.equal(SESSIONS_DEFAULTS.zeroWeekLimit, 2);
  assert.equal(SESSIONS_DEFAULTS.runRecencyDays, 21, "coverage.staleRegisterDays");
});

test("a college's own floors override the defaults", () => {
  // The settings.js pattern: defaults in code, a config spread over them. Without this the
  // constants are unreachable from a tenant's configuration and the module would have to
  // be edited to retune, which is the thing per-tenant config exists to avoid.
  const marks = [...weekly(1, 3, "A"), ...weekly(3, 3, "P"), ...weekly(5, 3, "P")];
  assert.equal(dayOfWeekShape(marks).worstWeekday, null, "nothing clears the default floor");

  const loosened = dayOfWeekShape(marks, { weekdayMinMarks: 3, weekdayMinOtherMarks: 6 });
  assert.equal(loosened.worstWeekday, 1);
  assert.equal(loosened.weekdayAbsenceGap, 100);
});

/* ========================================================================== */
/* The weekday shape itself                                                    */
/* ========================================================================== */

test("a real Friday pattern is found, named and measured", () => {
  // The positive case, so the negative ones above are known to be discriminating rather
  // than merely quiet. Eight weeks of Monday/Wednesday/Friday teaching, every Friday
  // missed, everything else attended.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "P"),
    ...weekly(3, 8, "P"),
    ...weekly(5, 8, "A"),
  ]);

  assert.equal(r.worstWeekday, 5, "ISO 5 — Friday");
  assert.equal(r.worstWeekdayAbsenceRate, 100);
  assert.equal(r.weekdayAbsenceGap, 100, "100% against 0% across the rest of the week");
  assert.equal(r.weekdaysMeasured, 3);
});

test("EXCUSED absence counts towards the shape, and that is deliberate", () => {
  // The question is the shape of the gap in somebody's week, and an excused Friday is
  // still a Friday they were not taught — a standing hospital appointment or a caring day
  // is a timetable conversation the college can actually have. Whether the absence was
  // explained is already answered once, by `unexplainedShare`; re-deriving it per weekday
  // would put four thin percentages on the row where one solid one already sits.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "P"),
    ...weekly(3, 8, "P"),
    ...weekly(5, 8, "E"),
  ]);
  assert.equal(r.worstWeekday, 5);
  assert.equal(r.worstWeekdayAbsenceRate, 100);
});

test("LATE is present — a late arrival is not a disappearance", () => {
  // tripwires.js's rule, kept identical here so the two layers cannot disagree about what
  // "attended" means. A shape built on treating L as absence finds patterns in the
  // traffic.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "P"),
    ...weekly(3, 8, "P"),
    ...weekly(5, 8, "L"),
  ]);
  assert.equal(r.worstWeekdayAbsenceRate, 0, "every Friday was attended, just late");
  assert.equal(r.weekdayAbsenceGap, 0);
});

test("the gap may be NEGATIVE, and is not clamped", () => {
  // The worst NAMEABLE weekday can sit below the pooled rest, because the pool contains
  // slices too thin to name and one of them may be worse. "The day we can measure is not
  // the problem" is the honest reading; clamping to 0 would manufacture a tie between that
  // and a student whose week is genuinely flat. coverage.staleness leaves a negative day
  // count alone for the same reason.
  const r = dayOfWeekShape([
    ...weekly(1, 8, "P"),
    ...weekly(3, 8, "P"),
    ...weekly(5, 3, "A"),
  ]);
  assert.ok(r.weekdayAbsenceGap < 0, `expected a negative gap, got ${r.weekdayAbsenceGap}`);
});

test("ties break on the lowest weekday, deterministically", () => {
  // A figure that moved between two runs with nothing about the student having changed
  // makes the whole row untrustworthy. Map iteration order is insertion order, which is
  // the order Postgres happened to return the marks in — so the sort is load-bearing, not
  // tidiness. Same reason workload.peakLoad breaks its tie on the earliest window.
  const marks = [
    ...weekly(1, 2, "A"), ...weekly(1, 2, "P", { from: 2 }),
    ...weekly(3, 2, "A"), ...weekly(3, 2, "P", { from: 2 }),
    ...weekly(4, 6, "P"),
  ];
  assert.equal(dayOfWeekShape(marks).worstWeekday, 1);
  assert.equal(dayOfWeekShape([...marks].reverse()).worstWeekday, 1, "and order cannot move it");
});

test("the kind shape is the same machine, on a different axis", () => {
  const marks = [
    ...weekly(1, 8, "P", { kind: "Teaching" }),
    ...weekly(3, 8, "A", { kind: "Seminar" }),
  ];
  const r = kindShape(marks, KINDED);
  assert.equal(r.worstKind, "Seminar");
  assert.equal(r.worstKindAbsenceRate, 100);
  assert.equal(r.kindAbsenceGap, 100);
  assert.equal(r.kindsMeasured, 2);
  assert.equal(r.kindUnset, 0);
});

test("a kind below the floor cannot be named either", () => {
  const r = kindShape([
    ...weekly(1, 8, "P", { kind: "Teaching" }),
    ...weekly(3, 8, "P", { kind: "Workshop" }),
    ...weekly(5, 3, "A", { kind: "Seminar" }),
  ], KINDED);
  assert.notEqual(r.worstKind, "Seminar");
  assert.equal(r.kindsMeasured, 2);
  assert.equal(r.kindsSeen, 3);
});

/* ========================================================================== */
/* consecutiveWeeks — and why it is NOT absenceStreak                          */
/* ========================================================================== */

test("a week with NO sessions is not a week of nought per cent", () => {
  // The rule weeklyRegularity already states: "weeks with no marks are not weeks". A
  // reading week, a bank holiday or a unit with nothing timetabled is not a week the
  // student failed to attend, and inserting one would manufacture a disappearance out of
  // a term calendar — at a whole college at once, every half term.
  const r = consecutiveWeeks([
    ...weekly(1, 3, "P"),                    // weeks 0,1,2 attended
    // weeks 3 and 4: nothing timetabled at all
    ...weekly(1, 1, "P", { from: 5 }),
  ], day(5, 5));

  assert.equal(r.observedWeeks, 4, "four weeks carried a register; the holidays are not weeks");
  assert.equal(r.currentZeroWeeks, 0);
});

test("a week with no sessions does not BREAK a run either — it is transparent", () => {
  // The other half of the same rule, and the one that decides whether this signal survives
  // contact with a term calendar. A student absent either side of a reading week has been
  // gone for three weeks; resetting the count at the holiday would hide exactly the
  // students a holiday hides, which is the failure mode of every signal that reads a
  // calendar instead of a register.
  const r = consecutiveWeeks([
    ...weekly(1, 1, "P", { from: 4 }),        // week 4: seen
    ...weekly(1, 2, "A", { from: 5 }), ...weekly(3, 2, "A", { from: 5 }),  // weeks 5,6 absent
    // week 7: reading week — no marks at all
    ...weekly(1, 1, "A", { from: 8 }), ...weekly(3, 1, "A", { from: 8 }),  // week 8 absent
  ], day(8, 5));

  assert.equal(r.currentZeroWeeks, 3, "weeks 5, 6 and 8 — the holiday is neither");
  assert.equal(r.unseenSinceWeekOn, monday(5));
  assert.equal(r.observedWeeks, 4);
});

test("EXCUSED absence does NOT break this run, and that is the sharpest divergence from absenceStreak", () => {
  // tripwires.absenceShape counts only A and lets E break the streak, because it is
  // asking "have we LOST CONTACT with this person" and somebody who rang in has not been
  // lost. That is right there and wrong here: this asks the regulator's question — has
  // this person been in a room — and a fortnight of authorised absence is still a
  // fortnight of no teaching, which a sponsoring provider must evidence and cannot
  // evidence with a phone call.
  const r = consecutiveWeeks([
    ...weekly(1, 1, "P", { from: 6 }),
    ...weekly(1, 2, "E", { from: 7 }), ...weekly(3, 2, "E", { from: 7 }),
  ], day(8, 5));

  assert.equal(r.currentZeroWeeks, 2, "two weeks of excused absence is still two weeks unseen");
  assert.equal(r.marksInRun, 4);
});

test("a PARTIAL week breaks the run — somebody sees them every Monday", () => {
  // The mirror of the test above, and the case absenceStreak gets wrong in the other
  // direction: a student who comes in on Mondays and misses the rest of every week carries
  // a permanent absence streak and has no unseen weeks at all. That pattern is
  // dayOfWeekShape's question, not this one's, and reporting it here would double-count
  // one student across two signals.
  const r = consecutiveWeeks([
    ...weekly(1, 4, "P", { from: 5 }),       // Mondays attended
    ...weekly(3, 4, "A", { from: 5 }),       // Wednesdays missed
    ...weekly(5, 4, "A", { from: 5 }),       // Fridays missed
  ], day(8, 5));

  assert.equal(r.currentZeroWeeks, 0, "no week in which they attended nothing");
  assert.equal(r.unseenSinceWeekOn, null);
});

test("LATE breaks the run — they were in the room", () => {
  const r = consecutiveWeeks([
    ...weekly(1, 2, "A", { from: 7 }), ...weekly(3, 2, "A", { from: 7 }),
    mark(day(8, 5), "L"),
  ], day(8, 5));
  assert.equal(r.currentZeroWeeks, 0);
  assert.equal(r.lastAttendedWeekOn, monday(8));
});

test("no register at all is NULL, never zero weeks unseen", () => {
  // A student nobody has marked has not been seen for nought weeks; the question has not
  // been asked of them. Reporting 0 would read as "we checked the register and they are
  // fine" and would put a clean figure against an entire intake before a session had run.
  const r = consecutiveWeeks([], day(9, 5));
  assert.equal(r.currentZeroWeeks, null);
  assert.equal(r.longestZeroWeeks, null);
  assert.equal(r.currentRunFresh, null);
  assert.equal(r.observedWeeks, 0);
  assert.equal(r.lastMarkOn, null);
});

test("a genuinely attended week IS a zero, and the two are different answers", () => {
  // coverage.confidence's distinction, in a second place: "genuinely zero observations…
  // this one IS a zero rather than a null". A student the register saw last week has a
  // measured run of nought; a student nobody has marked has none.
  const r = consecutiveWeeks(weekly(1, 4, "P", { from: 5 }), day(8, 5));
  assert.equal(r.currentZeroWeeks, 0);
  assert.notEqual(r.currentZeroWeeks, null);
});

test("marks dated after today are ignored", () => {
  // Registers can be generated ahead of the sessions they belong to, so a register saved
  // early for next week would otherwise extend a run into the future — a disappearance
  // dated forward, which is not a thing that can be true.
  const r = consecutiveWeeks([
    ...weekly(1, 1, "P", { from: 8 }),
    ...weekly(1, 2, "A", { from: 9 }), ...weekly(3, 2, "A", { from: 9 }),
  ], day(9, 1));       // today is the Monday of week 9

  assert.equal(r.currentZeroWeeks, 1, "only week 9's Monday mark is in the past");
  assert.equal(r.marksInRun, 1);
});

test("an unparseable today refuses to answer rather than answering confidently", () => {
  // Every comparison would silently be false and the result would be "no unseen weeks",
  // drawn from a malformed string rather than from a register. workload.deadlineClusters
  // and coverage.daysBetween refuse the same way.
  for (const bad of ["today", "", null, undefined, "2026-3-9"]) {
    const r = consecutiveWeeks(weekly(1, 4, "A", { from: 5 }), bad);
    assert.equal(r.currentZeroWeeks, null, String(bad));
    assert.equal(r.observedWeeks, 0);
  }
});

test("an unrecognised status does not create an observed week", () => {
  // The same filter dayOfWeekShape applies, in the place where forgetting it is worse: a
  // row carrying a status an importer invented would count towards `marked` and never
  // towards `attended`, so it would read as a week the register ran and saw nobody — an
  // unseen fortnight manufactured out of two rows nobody can interpret. isStatus is what
  // attendance.summarise() uses, so the two sides of any comparison stay in step.
  const r = consecutiveWeeks([
    ...weekly(1, 2, "X", { from: 7 }),
    ...weekly(3, 2, "", { from: 7 }),
  ], day(8, 5));

  assert.equal(r.observedWeeks, 0);
  assert.equal(r.currentZeroWeeks, null, "not a run — nothing was observed at all");
});

test("an unrecognised status cannot raise the code either", () => {
  // The same thing at the seam a caller actually uses, because the filter lives in
  // consecutiveWeeks and a later refactor could move the loop without moving the guard.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 2, "X", { from: 7 }), ...weekly(3, 2, "X", { from: 7 }),
      ...weekly(1, 2, "?", { from: 8 }), ...weekly(3, 2, "?", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.unseenWeekRun, null);
});

test("the longest run is the LONGEST, not the total number of unseen weeks", () => {
  // The mutation that survived the first pass of this file, which is why it is written
  // down: a counter that never resets on an attended week reports the SUM of every gap in
  // the record. On a fixture with one gap the two are identical and the test discriminates
  // nothing — CLAUDE.md records that happening four times — so this one has two separate
  // gaps of two, and a summing implementation says four.
  const r = consecutiveWeeks([
    ...weekly(1, 1, "A", { from: 0 }), ...weekly(1, 1, "A", { from: 1 }),
    ...weekly(1, 1, "P", { from: 2 }),
    ...weekly(1, 1, "A", { from: 3 }), ...weekly(1, 1, "A", { from: 4 }),
    ...weekly(1, 1, "P", { from: 5 }),
  ], day(5, 5));

  assert.equal(r.longestZeroWeeks, 2, "two gaps of two, not one of four");
  assert.equal(r.currentZeroWeeks, 0);
});

test("the longest historical run is reported, and the CURRENT one is not it", () => {
  // A student who vanished for three weeks in October and has attended every session
  // since is a student who came back. The history is worth a great deal as context — a
  // first disappearance and a fourth are different conversations — and it is a figure
  // precisely because a caseload entry for it could never be cleared.
  const r = consecutiveWeeks([
    ...weekly(1, 1, "P", { from: 0 }),
    ...weekly(1, 1, "A", { from: 1 }), ...weekly(1, 1, "A", { from: 2 }), ...weekly(1, 1, "A", { from: 3 }),
    ...weekly(1, 1, "P", { from: 4 }),
    ...weekly(1, 1, "P", { from: 8 }),
  ], day(8, 5));

  assert.equal(r.longestZeroWeeks, 3);
  assert.equal(r.currentZeroWeeks, 0, "they came back");
  assert.equal(r.unseenSinceWeekOn, null);
});

test("a run that nobody has added to for three weeks is no longer CURRENT", () => {
  // Empty weeks are transparent by design, which is what lets a run survive a reading
  // week — and, unguarded, is also what would keep a run lit all summer for a student who
  // stopped coming in May, with no event able to clear it because a day passing is not an
  // event. Past runRecencyDays the finding belongs to coverage.js's TRIP_REGISTER_STALE:
  // it is no longer "this student is not coming in", it is "nobody is marking this
  // student", and that is a fact about the college.
  const marks = [...weekly(1, 2, "A", { from: 0 }), ...weekly(3, 2, "A", { from: 0 })];

  const fresh = consecutiveWeeks(marks, day(1, 5));
  assert.equal(fresh.currentRunFresh, true);
  assert.equal(fresh.currentZeroWeeks, 2);

  const stale = consecutiveWeeks(marks, day(6, 5));   // 5 weeks on
  assert.equal(stale.currentZeroWeeks, 2, "the run is still two weeks — that is history");
  assert.equal(stale.currentRunFresh, false, "but it is no longer a live finding");
});

test("the run reports DATES, and marksInRun is the denominator behind it", () => {
  const r = consecutiveWeeks([
    ...weekly(1, 1, "P", { from: 5 }),
    ...weekly(1, 1, "A", { from: 6 }), ...weekly(3, 1, "A", { from: 6 }),
    ...weekly(1, 1, "A", { from: 7 }), ...weekly(3, 1, "A", { from: 7 }),
  ], day(7, 5));

  assert.equal(r.unseenSinceWeekOn, monday(6));
  assert.equal(r.lastAttendedWeekOn, monday(5));
  assert.equal(r.lastMarkOn, day(7, 3));
  assert.equal(r.marksInRun, 4);
});

/* ========================================================================== */
/* TRAP SIX: a cohort-wide pattern must not become a caseload entry            */
/* ========================================================================== */

test("a total, unmissable weekday pattern raises NOTHING", () => {
  // THE CENTRAL TEST OF THIS FILE. Eight weeks, every single Friday missed, everything
  // else attended — the loudest weekday shape the data can produce. It raises no code,
  // because within one student's marks there is nothing to distinguish "this student
  // avoids Fridays" from "nobody attends the Friday nine o'clock", and CLAUDE.md names
  // that second thing as a fact about the timetable. The evidence that would separate
  // them is the rest of the cohort's Friday, which lives in cohort.js.
  const r = evaluate(input({
    marks: [...weekly(1, 8, "P"), ...weekly(3, 8, "P"), ...weekly(5, 8, "A")],
    today: day(7, 7),
  }), {});

  assert.equal(r.worstAbsenceWeekday, 5, "the shape is measured and reported");
  assert.equal(r.weekdayAbsenceGap, 100);
  assert.deepEqual(r.codes, [], "and it raises nothing");
});

test("a total session-kind pattern raises NOTHING either", () => {
  // A cohort that skips seminars is a real and common thing, and one student's marks
  // cannot tell that apart from this student skipping seminars.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 8, "P", { kind: "Teaching" }),
      ...weekly(3, 8, "A", { kind: "Seminar" }),
    ],
    today: day(7, 7),
  }), {});

  assert.equal(r.worstAbsenceKind, "Seminar");
  assert.equal(r.kindAbsenceGap, 100);
  assert.deepEqual(r.codes, []);
});

test("both patterns at once still raise nothing", () => {
  // No amount of shared timetable becomes a per-student finding. The threshold is not
  // what stops this — the absence of a code is — so stacking the two shapes must not tip
  // anything over.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 8, "P", { kind: "Teaching" }),
      ...weekly(3, 8, "P", { kind: "Teaching" }),
      ...weekly(5, 8, "A", { kind: "Seminar" }),
    ],
    today: day(7, 7),
  }), {});

  assert.equal(r.worstAbsenceWeekday, 5);
  assert.equal(r.worstAbsenceKind, "Seminar");
  assert.deepEqual(r.codes, []);
});

/* ========================================================================== */
/* The one code                                                                */
/* ========================================================================== */

test("two consecutive weeks in which the register ran and saw nobody DOES fire", () => {
  // The positive case, so every negative above is known to be discriminating. Without
  // this the file would be a long list of things that do not happen, which is exactly the
  // "test that passed while discriminating nothing" CLAUDE.md records four times.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 6 }),
      ...weekly(1, 1, "A", { from: 7 }), ...weekly(3, 1, "A", { from: 7 }),
      ...weekly(1, 1, "A", { from: 8 }), ...weekly(3, 1, "A", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});

  assert.deepEqual(r.codes, [SESSIONS.WEEKS_UNSEEN]);
  assert.equal(r.unseenWeekRun, 2);
  assert.equal(r.unseenSinceWeekOn, monday(7));
});

test("ONE unseen week is a bad week, not a disappearance", () => {
  // A virus, a funeral, a train strike, childcare that fell through. Firing on it would
  // put a large slice of any cohort on the caseload in any given week, which CLAUDE.md is
  // blunt is the same as no caseload.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 7 }),
      ...weekly(1, 1, "A", { from: 8 }), ...weekly(3, 1, "A", { from: 8 }),
      ...weekly(5, 1, "A", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});

  assert.equal(r.unseenWeekRun, 1);
  assert.deepEqual(r.codes, []);
});

test("two unseen weeks resting on two marks do not fire", () => {
  // THE MINIMUM DENOMINATOR, and the reason it sits on the RUN rather than on each week.
  // Two weeks holding one register each is a fortnight claimed from two rows — and at a
  // provider teaching one session a week it is the ordinary state of a student who missed
  // two classes.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 6 }),
      ...weekly(1, 1, "A", { from: 7 }),
      ...weekly(1, 1, "A", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});

  assert.equal(r.unseenWeekRun, 2, "the run is real and is reported");
  assert.deepEqual(r.codes, [], "it is the evidence behind it that is too thin");
});

test("a third week tips the same thin register over, because the floor is on the run", () => {
  // The other side of the trade-off the run-level floor buys: one session a week fires at
  // three weeks, four sessions a week fires at two. A per-week floor of two would make
  // this structurally unable to fire at such a college however long the student had gone.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 5 }),
      ...weekly(1, 1, "A", { from: 6 }),
      ...weekly(1, 1, "A", { from: 7 }),
      ...weekly(1, 1, "A", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});

  assert.equal(r.unseenWeekRun, 3);
  assert.equal(r.marksInRun, undefined, "the denominator is not stored on the row");
  assert.deepEqual(r.codes, [SESSIONS.WEEKS_UNSEEN]);
});

test("a stale run does not fire, however long it is", () => {
  // The monotonic failure this guard exists to stop. Without it a student who vanished in
  // May still fires in October — the accumulating pile every windowed signal in
  // tripwires.js was rewritten to avoid — and nothing could ever clear it, because a day
  // passing is not an event and markStale only fires on data.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 2, "A", { from: 0 }), ...weekly(3, 2, "A", { from: 0 }),
    ],
    today: day(9, 5),
  }), {});

  assert.equal(r.unseenWeekRun, 2, "the history is still reported");
  assert.deepEqual(r.codes, [], "but it is coverage.js's REGISTER_STALE now, not this");
});

test("a holiday in the middle of a run does not save the student from being found", () => {
  // The transparency rule, end to end. Two absent weeks, a reading week with nothing
  // timetabled, another absent week: three weeks unseen, and the code fires. An
  // implementation that let the holiday break the run would go quiet for exactly the
  // students a holiday hides.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 5 }),
      ...weekly(1, 1, "A", { from: 6 }), ...weekly(3, 1, "A", { from: 6 }),
      // week 7 — reading week, no marks
      ...weekly(1, 1, "A", { from: 8 }), ...weekly(3, 1, "A", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});

  // TWO, not three: the count is of weeks the register OBSERVED, and week 7 was not one.
  // That is the honest number — the college taught nothing that week, so there is nothing
  // it can say about the student — while the DATE spans the whole gap and is what a
  // member of staff reads. Counting the holiday as a third unseen week would be the
  // manufactured-absence error; letting it reset the count to one would be the
  // manufactured-reassurance one. It does neither.
  assert.equal(r.unseenWeekRun, 2);
  assert.equal(r.unseenSinceWeekOn, monday(6), "and the run reaches back across the holiday");
  assert.deepEqual(r.codes, [SESSIONS.WEEKS_UNSEEN]);
});

test("an EXCUSED fortnight fires here even though it raises no absence streak", () => {
  // The divergence from tripwires stated as a behaviour rather than as a comment. E
  // breaks an absence streak by design — the student rang in, so contact was not lost —
  // and it does not break this, because a sponsoring provider has to evidence that
  // somebody was taught, and a phone call is not evidence of that.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 6 }),
      ...weekly(1, 1, "E", { from: 7 }), ...weekly(3, 1, "E", { from: 7 }),
      ...weekly(1, 1, "E", { from: 8 }), ...weekly(3, 1, "E", { from: 8 }),
    ],
    today: day(8, 5),
  }), {});

  assert.deepEqual(r.codes, [SESSIONS.WEEKS_UNSEEN]);
});

test("a student nobody has ever marked raises nothing at all", () => {
  // The non-starter with no register is NOT this module's finding — with no marks there
  // are no observed weeks, the run is null rather than long, and the code cannot fire.
  // That is what makes the settling-in exemption unnecessary below rather than merely
  // omitted.
  const r = evaluate(input({ marks: [], today: day(9, 5) }), {});
  assert.deepEqual(r.codes, []);
  assert.equal(r.unseenWeekRun, null);
  assert.equal(r.observedWeeks, 0);
});

/* ========================================================================== */
/* The settling-in exemption, and both halves of the rule                      */
/* ========================================================================== */

test("a week-one student with a register that ran and saw nobody DOES fire", () => {
  // CLAUDE.md's exemption covers codes that fire on the ABSENCE of a record, because in
  // week one that absence describes the calendar. This one fires on the PRESENCE of a
  // register that ran and said the student was not there — evidence, not silence — which
  // is ABSENCE_STREAK's class, and tripwires.js records that suppressing it hid the
  // non-starter: somebody who enrolled and never once turned up, which is exactly who a
  // sponsoring provider has to find and exactly inside the window they have to find them
  // in.
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "A", { from: 0 }), ...weekly(3, 1, "A", { from: 0 }),
      ...weekly(1, 1, "A", { from: 1 }), ...weekly(3, 1, "A", { from: 1 }),
    ],
    today: day(1, 5),
    weeksIntoProgramme: 1,
  }), {});

  assert.deepEqual(r.codes, [SESSIONS.WEEKS_UNSEEN]);
});

test("a student of UNKNOWN programme age fires identically", () => {
  // The second half of the rule, which is the half that gets dropped. "An *unknown*
  // programme age is deliberately not exempt — muting every code for a student the
  // calendar cannot place fails safe in the wrong direction." Both halves are pinned
  // because a later reader who decides this code DOES belong in the muted class must
  // confront both.
  const marks = [
    ...weekly(1, 1, "A", { from: 0 }), ...weekly(3, 1, "A", { from: 0 }),
    ...weekly(1, 1, "A", { from: 1 }), ...weekly(3, 1, "A", { from: 1 }),
  ];
  const known = evaluate(input({ marks, today: day(1, 5), weeksIntoProgramme: 1 }), {});
  const unknown = evaluate(input({ marks, today: day(1, 5), weeksIntoProgramme: null }), {});
  const absent = evaluate(input({ marks, today: day(1, 5), weeksIntoProgramme: undefined }), {});

  assert.deepEqual(known.codes, [SESSIONS.WEEKS_UNSEEN]);
  assert.deepEqual(unknown.codes, known.codes);
  assert.deepEqual(absent.codes, known.codes);
});

/* ========================================================================== */
/* What the row carries                                                        */
/* ========================================================================== */

test("the return carries DATES and never a day count", () => {
  // Trap four, asserted structurally the way workload.test.js asserts it of peakLoad.
  // Nothing in this feature runs on a schedule — markStale fires on data events and a day
  // passing is not an event — so any stored "days since" is wrong by the next morning with
  // nothing to correct it, while a date is true forever.
  //
  // The regex allows "weekdaysMeasured" and "worstAbsenceWeekday" (a weekday is not a day
  // COUNT) and catches the shapes a day count actually takes: a leading `days`, or a key
  // ending in `Days`.
  const r = evaluate(input({
    marks: [...weekly(1, 4, "A", { from: 5 }), ...weekly(3, 4, "A", { from: 5 })],
    today: day(8, 5),
  }), {});

  for (const key of Object.keys(r)) {
    assert.equal(/(^|[^a-zA-Z])days|Days$/.test(key), false, `${key} looks like a day count`);
  }
  assert.equal(r.unseenSinceWeekOn, monday(5), "a date, which stays true");
});

test("every key that names a week holds a YYYY-MM-DD string or null", () => {
  const r = evaluate(input({
    marks: [
      ...weekly(1, 1, "P", { from: 6 }),
      ...weekly(1, 2, "A", { from: 7 }), ...weekly(3, 2, "A", { from: 7 }),
    ],
    today: day(8, 5),
  }), {});

  for (const key of ["unseenSinceWeekOn", "lastAttendedWeekOn"]) {
    const v = r[key];
    assert.ok(v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), `${key} = ${v}`);
  }
});

test("evaluate never emits a code outside its own vocabulary", () => {
  // Six modules write into one array. A stray string from here would be indistinguishable
  // on the caseload from a finding one of the other five made, and history rows are what
  // an appeal is argued from.
  const cases = [
    input({ marks: [], today: day(9, 5) }),
    input({ marks: [...weekly(1, 8, "P"), ...weekly(5, 8, "A")], today: day(7, 7) }),
    input({
      marks: [...weekly(1, 3, "A", { from: 6 }), ...weekly(3, 3, "A", { from: 6 })],
      today: day(8, 5),
    }),
    input({ marks: weekly(1, 12, "E"), today: day(11, 5), institution: UNKINDED }),
  ];
  for (const raw of cases) {
    for (const code of evaluate(raw, {}).codes) {
      assert.ok(SESSIONS_CODES.includes(code), code);
    }
  }
});

test("evaluate is total: no input shape makes it throw once the probe is present", () => {
  // Everything except the probe is optional, and a gather that produced an odd row must
  // not take a whole batch down. The probe is the one exception, and it is deliberate.
  assert.doesNotThrow(() => evaluate({ institution: KINDED }, {}));
  assert.doesNotThrow(() => evaluate({ institution: KINDED, marks: null, today: null }, {}));
  assert.doesNotThrow(() => evaluate({
    institution: KINDED,
    today: day(9, 5),
    marks: [null, undefined, {}, { status: "P" }, { date: day(1, 1) }, 7, "x"],
  }, {}));
});

test("a college that records no session kinds measures NULL kinds, not zero", () => {
  // The null-is-not-zero rule, in the one place this module can break it. Zero would say
  // "we counted the kinds that cleared the floor and found none", which is a claim about
  // a sample. When the college records no kinds at all there was no sample: the question
  // could not be asked, and every figure describing it has to say so.
  //
  // The other three already returned null. kindsMeasured did not, and a reader comparing
  // "0 kinds measured" against a college that genuinely has one kind would see the same
  // number for two different situations.
  const marks = [
    { status: "P", date: "2026-08-03", sessionId: "a", kind: null },
    { status: "A", date: "2026-08-10", sessionId: "b", kind: null },
  ];
  const r = evaluate({ today: "2026-08-28", marks, weeksIntoProgramme: 10, institution: { kindRecorded: false } }, {});

  assert.equal(r.kindsMeasured, null, "kindsMeasured must be null when the college records no kinds");
  assert.equal(r.worstAbsenceKind, null);
  assert.equal(r.worstKindAbsenceRate, null);
  assert.equal(r.kindAbsenceGap, null);
});
