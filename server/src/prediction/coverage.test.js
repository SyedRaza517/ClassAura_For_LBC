// Tests for the coverage layer: how much we actually know about a student, and
// whether the attendance percentage on the screen is worth anything.
//
// No database. coverage.js is pure — it takes the in-memory arrays the gather has
// already built, plus today's date and an institution-wide probe result, and returns
// plain data.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS on purpose, in the house style: what does NOT
// fire, what comes back null rather than zero, and what is refused outright. Almost
// every failure this module exists to prevent is a number that looked fine.
//
// Run with: node --test src/prediction/coverage.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluate, registerCoverage, confidence, sanitise, staleness, lastMarkDate,
  COVERAGE, COVERAGE_CODES, CONFIDENCE, COVERAGE_DEFAULTS,
} = require("./coverage");
const { TRIP_CODES } = require("./tripwires");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A college that publishes a timetable: sessions exist before the register is taken. */
const TIMETABLED = { timetableRecorded: true };
/** A college whose sessions only ever appear when somebody takes a register. */
const UNTIMETABLED = { timetableRecorded: false };

/** `session("s1", "2026-03-01")` reads better than an object literal. */
const session = (id, date) => ({ id, date });
/** A mark tied to a session. Status defaults to Present; the tests that care say so. */
const mark = (sessionId, date, status = "P") => ({ sessionId, date, status });

/** n sessions on consecutive-ish dates, ids s1..sn. */
function sessions(n, startDay = 1) {
  return Array.from({ length: n }, (_, i) =>
    session(`s${i + 1}`, `2026-02-${String(startDay + i).padStart(2, "0")}`));
}

/** Marks for the first `n` of those sessions. */
function marksFor(list, n, status = "P") {
  return list.slice(0, n).map((s) => mark(s.id, s.date, status));
}

/** The shape a caller hands evaluate(), with everything empty unless a test fills it. */
const input = (over = {}) => ({
  today: "2026-03-20",
  overallAttendance: null,
  marks: [],
  scheduledSessions: [],
  weeksIntoProgramme: 20,
  institution: TIMETABLED,
  ...over,
});

/* ========================================================================== */
/* The codes themselves                                                        */
/* ========================================================================== */

test("every code is namespaced TRIP_", () => {
  // Structural, and it is not decoration. These strings are appended to
  // riskDriverCodes, the same array engine.js fills from its six RED indicators. A code
  // named RED_something would read as the engine's own, and the next person to take
  // redIndicatorCount off the copy rather than off engine.js's internal `reds` array
  // would silently wire register-keeping into a student's band via OVR-004.
  for (const code of COVERAGE_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with one tripwires.js already stores", () => {
  // Both files write into the same array and both sets of strings outlive the screen
  // that renders them. A collision would make a stored history row mean two things.
  for (const code of COVERAGE_CODES) assert.equal(TRIP_CODES.includes(code), false, code);
});

/* ========================================================================== */
/* The institution probe                                                       */
/* ========================================================================== */

test("coverage REFUSES to answer without an institution-wide probe result", () => {
  // CLAUDE.md records this as the most repeated bug in this area, got wrong three
  // times: "does this college record this at all" answered from the chunk in front of
  // the code. gather() runs on chunks of 200 and the incremental path often scores one
  // student, at which size the question is invisible.
  //
  // The existing tripwires guards default to falsy and fall silent. That is right
  // there — one code does not fire. Here a missing flag would null the whole feature
  // silently and permanently, and nothing in any output would look wrong. So it throws,
  // the way db.js throws on a query with no tenant context.
  assert.throws(() => registerCoverage(sessions(10), [], undefined), /institution-wide/);
  assert.throws(() => registerCoverage(sessions(10), [], {}), /institution-wide/);
});

test("a truthy non-boolean probe is refused, not coerced", () => {
  // The shape somebody reaches for when wiring in a hurry: a count, or the result of a
  // findFirst. `if (institution.timetableRecorded)` would accept all three and be right
  // by accident for two of them; `0` and `null` would be silently read as "this college
  // has no timetable" and take the feature off the air for everyone.
  assert.throws(() => registerCoverage([], [], { timetableRecorded: 1 }), /boolean/);
  assert.throws(() => registerCoverage([], [], { timetableRecorded: "yes" }), /boolean/);
  assert.throws(() => registerCoverage([], [], { timetableRecorded: null }), /boolean/);
});

test("evaluate refuses the same way, before it computes anything", () => {
  assert.throws(() => evaluate({ ...input(), institution: undefined }, {}), /institution-wide/);
});

/* ========================================================================== */
/* registerCoverage — the missing denominator                                  */
/* ========================================================================== */

test("coverage is the share of scheduled sessions that carry a mark", () => {
  const list = sessions(10);
  const r = registerCoverage(list, marksFor(list, 6), TIMETABLED);

  assert.equal(r.scheduled, 10);
  assert.equal(r.marked, 6);
  assert.equal(r.coverageRate, 60);
  assert.equal(r.usable, true);
});

test("a college with no timetable has UNKNOWN coverage, not 0%", () => {
  // THE TRAP. Ten marks and no scheduled sessions to compare them against is not a
  // college that took none of its registers — it is a college whose sessions only come
  // into existence at the moment a register is taken, in which case the scheduled set
  // and the marked set are the same rows and coverage would be 100% by construction for
  // every student in the institution. Neither 0 nor 100 is a measurement. Null is.
  const list = sessions(10);
  const r = registerCoverage(list, marksFor(list, 6), UNTIMETABLED);

  assert.equal(r.coverageRate, null);
  assert.equal(r.scheduled, null);
  assert.equal(r.usable, false);
});

test("no scheduled sessions at all is unknown coverage, not a perfect record and not a gap", () => {
  const r = registerCoverage([], [], TIMETABLED);
  assert.equal(r.coverageRate, null);
  assert.equal(r.usable, false);
  assert.equal(r.scheduled, 0);   // the COUNT is a fact; only the rate is withheld
});

test("too few scheduled sessions withholds the rate but keeps the count", () => {
  // One scheduled session with no mark reads 0% coverage, and 0% coverage is an
  // accusation about a college's register-keeping drawn from a single row. Same floor
  // as disperseMinMarks, for the same reason.
  const list = sessions(3);
  const r = registerCoverage(list, [], TIMETABLED);

  assert.equal(r.coverageRate, null);
  assert.equal(r.usable, false);
  assert.equal(r.scheduled, 3);
  assert.equal(r.marked, 0);
});

test("the floor is configurable and a college that lowers it gets its figure", () => {
  // Proves the floor is read from config rather than hardcoded at the comparison.
  const list = sessions(3);
  const r = registerCoverage(list, marksFor(list, 3), TIMETABLED, { minScheduledForCoverage: 2 });
  assert.equal(r.coverageRate, 100);
  assert.equal(r.usable, true);
});

test("duplicate marks for one session cannot push coverage over 100%", () => {
  // The unique constraint on (sessionId, studentId) makes this impossible in the
  // database, so the duplicate that reaches here comes from a caller concatenating two
  // overlapping fetches — and "coverage: 133%" would be read as broken arithmetic
  // rather than as a broken fetch.
  const list = sessions(6);
  const dupes = [...marksFor(list, 6), ...marksFor(list, 2)];
  const r = registerCoverage(list, dupes, TIMETABLED);

  assert.equal(r.marked, 6);
  assert.equal(r.coverageRate, 100);
});

test("marks for sessions outside the scope are ignored, not counted as coverage", () => {
  // A transferred student legitimately carries marks for sessions no longer in their
  // scope. They are not evidence that the register was taken for the sessions that ARE.
  const list = sessions(10);
  const r = registerCoverage(
    list,
    [...marksFor(list, 4), mark("elsewhere-1", "2026-01-05"), mark("elsewhere-2", "2026-01-06")],
    TIMETABLED,
  );

  assert.equal(r.marked, 4);
  assert.equal(r.coverageRate, 40);
});

test("a mark that cannot be tied to a session yields no figure rather than a bad one", () => {
  // AttendanceMark.sessionId is NOT NULL, so this is defensive: it catches a caller
  // passing a summarised counts object or marks reshaped by an importer. Counting such
  // marks as missing would report a college with a perfect register as having taken
  // none of it — the worst output this module can produce.
  const list = sessions(10);
  const r = registerCoverage(list, [...marksFor(list, 9), { status: "P", date: "2026-02-11" }], TIMETABLED);

  assert.equal(r.coverageRate, null);
  assert.equal(r.usable, false);
});

test("a row with an unrecognised status is not a register having been taken", () => {
  // isStatus is the filter attendance.summarise() applies before counting anything. A
  // row carrying "X" is a row, not a mark, and letting it into the numerator would
  // report coverage the college does not have.
  const list = sessions(10);
  const r = registerCoverage(list, [...marksFor(list, 5), mark("s6", "2026-02-06", "X")], TIMETABLED);

  assert.equal(r.marked, 5);
  assert.equal(r.coverageRate, 50);
});

test("an absent mark still counts as the register having been taken", () => {
  // Coverage asks whether somebody wrote something down, not what they wrote. A
  // register full of A is a register that was kept, and treating it as a gap would
  // convert a well-run register of a disengaged student into a finding about staff.
  const list = sessions(8);
  const r = registerCoverage(list, marksFor(list, 8, "A"), TIMETABLED);
  assert.equal(r.coverageRate, 100);
});

/* ========================================================================== */
/* confidence                                                                  */
/* ========================================================================== */

test("a percentage built on three observations is NOT reportable", () => {
  // 3 present out of 3 is 100% and arithmetically correct. In the column it sits above
  // 57 out of 60, and it rests on a twentieth of the evidence.
  const r = confidence(3);
  assert.equal(r.reportable, false);
  assert.equal(r.level, CONFIDENCE.LOW);
  assert.equal(r.observations, 3);
});

test("zero observations is a measured zero and still not reportable", () => {
  const r = confidence(0);
  assert.equal(r.observations, 0);
  assert.equal(r.level, CONFIDENCE.NONE);
  assert.equal(r.reportable, false);
});

test("an UNKNOWN mark count is null, not none", () => {
  // A caller that could not establish how many marks the figure rests on has told us
  // nothing; "none" would be a claim about the register. Both refuse to report, so the
  // fail-safe direction is identical — the distinction is what the row can say.
  for (const bad of [null, undefined, NaN, "12", -1]) {
    const r = confidence(bad);
    assert.equal(r.observations, null, String(bad));
    assert.equal(r.level, null, String(bad));
    assert.equal(r.reportable, false, String(bad));
  }
});

test("at the floor the figure becomes reportable, one observation below it does not", () => {
  // Pins the boundary itself rather than a value comfortably either side of it.
  assert.equal(confidence(COVERAGE_DEFAULTS.minMarksForRate - 1).reportable, false);
  assert.equal(confidence(COVERAGE_DEFAULTS.minMarksForRate).reportable, true);
  assert.equal(confidence(COVERAGE_DEFAULTS.minMarksForRate).level, CONFIDENCE.MODERATE);
});

test("confidence only reaches high when one mark can no longer move a band", () => {
  // The threshold is arithmetic, not taste: at twelve observations one mark is worth
  // 8.3 points, under the fifteen-point width of the narrowest default band, so a
  // single register can no longer walk a student from one risk level to the next.
  assert.equal(confidence(COVERAGE_DEFAULTS.confidentMarks - 1).level, CONFIDENCE.MODERATE);
  assert.equal(confidence(COVERAGE_DEFAULTS.confidentMarks).level, CONFIDENCE.HIGH);
});

test("a college may set its own floor", () => {
  assert.equal(confidence(4, { minMarksForRate: 4 }).reportable, true);
  assert.equal(confidence(4, { minMarksForRate: 8 }).reportable, false);
});

/* ========================================================================== */
/* sanitise — the single most important rule in the repo                       */
/* ========================================================================== */

test("an unsupportable percentage becomes NULL, never zero and never a low number", () => {
  // Zero attendance puts a student top of every risk list in the building for something
  // nobody measured. This is the rule the whole codebase is organised around.
  assert.equal(sanitise(100, confidence(3)), null);
  assert.equal(sanitise(0, confidence(3)), null);
  assert.equal(sanitise(37.5, confidence(0)), null);
});

test("a supportable percentage is passed through untouched", () => {
  // The other half. A guard that nulls everything is safe and useless.
  assert.equal(sanitise(95, confidence(60)), 95);
  assert.equal(sanitise(0, confidence(60)), 0);   // a real, measured zero survives
});

test("a missing percentage stays null even at high confidence", () => {
  assert.equal(sanitise(null, confidence(60)), null);
});

/* ========================================================================== */
/* staleness — pure day arithmetic, today is an argument                       */
/* ========================================================================== */

test("staleness reads the date it is GIVEN, not the host clock", () => {
  // src/clock.js pins APP_TIMEZONE precisely because the host clock is not the
  // college's day. A register taken at 23:30 in London is a different date on a server
  // in UTC-5, and a module calling new Date() would answer differently depending on
  // which machine ran the batch. The date below is years from any real "now"; if this
  // file ever reaches for a clock, this test stops making sense.
  const r = staleness("2019-01-01", "2019-01-22");
  assert.equal(r.daysSinceLastMark, 21);
  assert.equal(r.stale, true);
});

test("a register nobody has ever taken is NOT stale — it has not started", () => {
  // Answering `true` would put a whole intake on a staff caseload on day one;
  // answering 9999 days would sort them to the top of it.
  const r = staleness(null, "2026-03-20");
  assert.equal(r.stale, null);
  assert.equal(r.daysSinceLastMark, null);
  assert.equal(r.lastMarkOn, null);
});

test("the staleness boundary is pinned on both sides", () => {
  const days = COVERAGE_DEFAULTS.staleRegisterDays;
  assert.equal(staleness("2026-03-01", "2026-03-22", { staleRegisterDays: days }).stale, days <= 21);
  assert.equal(staleness("2026-03-01", "2026-03-21").daysSinceLastMark, 20);
  assert.equal(staleness("2026-03-01", "2026-03-21").stale, false);
  assert.equal(staleness("2026-03-01", "2026-03-22").daysSinceLastMark, 21);
  assert.equal(staleness("2026-03-01", "2026-03-22").stale, true);
});

test("an unparseable date is unknown, not 'marked today'", () => {
  // tripwires.daysBetween returns 0 for a bad date, which is the right shrug there —
  // it makes a code fail to fire. Here 0 would be the strongest reassurance in the
  // module, produced by a malformed string rather than by evidence.
  const r = staleness("not-a-date", "2026-03-20");
  assert.equal(r.daysSinceLastMark, null);
  assert.equal(r.stale, null);
});

test("a mark dated in the future is certainly not a register nobody has opened", () => {
  const r = staleness("2026-04-01", "2026-03-20");
  assert.equal(r.stale, false);
  assert.equal(r.daysSinceLastMark, -12);   // honest, rather than clamped to a false 0
});

test("staleness crosses a BST boundary without drifting a day", () => {
  // The clocks go forward on 2026-03-29. Local-time Date arithmetic loses an hour there
  // and rounds a 21-day gap to 20.
  assert.equal(staleness("2026-03-20", "2026-04-10").daysSinceLastMark, 21);
});

/* ========================================================================== */
/* lastMarkOn — the register's date, not the student's                         */
/* ========================================================================== */

test("the last mark is ANY status, which is the opposite of lastAttendedOn", () => {
  // The distinction the module rests on. A student marked Absent every day for a month
  // has a perfectly fresh register and a terrible attendance record; a student marked
  // Present daily until a tutor stopped opening the register has an excellent record
  // and no register at all. tripwires.attendanceShape counts only P and L because it is
  // asking about the student. This is asking about us.
  assert.equal(lastMarkDate([mark("s1", "2026-03-01", "P"), mark("s2", "2026-03-10", "A")]), "2026-03-10");
  assert.equal(lastMarkDate([mark("s1", "2026-03-01", "P"), mark("s2", "2026-03-10", "E")]), "2026-03-10");
});

test("no marks gives null, never an epoch date", () => {
  // An epoch date would sort a never-marked student to the top of a list of neglected
  // registers on no evidence at all.
  assert.equal(lastMarkDate([]), null);
  assert.equal(lastMarkDate([{ status: "X", date: "2026-03-01" }]), null);
});

test("marks arrive in any order and the latest is still found", () => {
  // gather() groups these in Node from a query with no ORDER BY.
  assert.equal(lastMarkDate([
    mark("s3", "2026-03-03"), mark("s1", "2026-03-11"), mark("s2", "2026-03-07"),
  ]), "2026-03-11");
});

/* ========================================================================== */
/* evaluate — the assembly                                                     */
/* ========================================================================== */

test("100% off three marks is WITHHELD and the withholding is explained", () => {
  // The case the module exists for. This student outranks a 95%-off-sixty student in
  // every sort in the building until the figure is removed.
  const list = sessions(3);
  const r = evaluate(input({
    overallAttendance: 100,
    marks: marksFor(list, 3),
    scheduledSessions: list,
  }), {});

  assert.equal(r.overallAttendance, null);
  assert.notEqual(r.overallAttendance, 0);
  assert.ok(r.codes.includes(COVERAGE.ATTENDANCE_UNRELIABLE));
});

test("95% off sixty marks is kept, and raises nothing", () => {
  // The other half, and the one that proves the guard discriminates. A module that
  // withheld both figures would pass the test above and be worthless.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 95,
    marks: marksFor(list, 20),
    scheduledSessions: list,
    today: "2026-02-25",
  }), {});

  assert.equal(r.overallAttendance, 95);
  assert.equal(r.confidence, CONFIDENCE.HIGH);
  assert.deepEqual(r.codes, []);
});

test("a register nobody took makes the figure unsupportable AND names the college", () => {
  // Sixty sessions timetabled, three registers taken, three present. The 100% is not a
  // fact about the student at all, and the second code says whose fact it is.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 100,
    marks: marksFor(list, 3),
    scheduledSessions: list,
    today: "2026-02-25",
  }), {});

  assert.equal(r.overallAttendance, null);
  assert.ok(r.codes.includes(COVERAGE.ATTENDANCE_UNRELIABLE));
  assert.ok(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN));
  assert.equal(r.coverageRate, 15);
});

test("the same student at a college with no timetable raises no institutional code", () => {
  // THE INSTITUTION GUARD, at the level that matters. Identical student rows; the only
  // difference is a probe result that cannot be derived from them. Without the guard
  // this college's entire roll would carry a register-keeping finding on every run.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 100,
    marks: marksFor(list, 3),
    scheduledSessions: list,
    institution: UNTIMETABLED,
    today: "2026-02-25",
  }), {});

  assert.equal(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN), false);
  assert.equal(r.coverageRate, null);
  assert.equal(r.scheduledSessions, null);
  // The student-side finding is unaffected: three marks is three marks either way.
  assert.ok(r.codes.includes(COVERAGE.ATTENDANCE_UNRELIABLE));
  assert.equal(r.overallAttendance, null);
});

test("good coverage raises no register finding", () => {
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 90,
    marks: marksFor(list, 19),
    scheduledSessions: list,
    today: "2026-02-25",
  }), {});

  assert.equal(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN), false);
  assert.equal(r.coverageRate, 95);
});

test("the coverage limit is pinned on both sides", () => {
  const list = sessions(20);
  const at = evaluate(input({
    marks: marksFor(list, 12), scheduledSessions: list, today: "2026-02-25",
  }), { lowCoverageLimit: 60 });
  const above = evaluate(input({
    marks: marksFor(list, 13), scheduledSessions: list, today: "2026-02-25",
  }), { lowCoverageLimit: 60 });

  assert.equal(at.coverageRate, 60);
  assert.ok(at.codes.includes(COVERAGE.REGISTER_NOT_TAKEN), "at the limit it fires");
  assert.equal(above.coverageRate, 65);
  assert.equal(above.codes.includes(COVERAGE.REGISTER_NOT_TAKEN), false);
});

/* --- the settling-in exemption, and the half of it that must NOT apply ------ */

test("in the settling-in period the codes are muted", () => {
  // In week one every student has two or three marks and no register history. Firing
  // all three codes across the whole intake produces a caseload containing everybody,
  // which is the same as no caseload — staff stop reading it, and the students genuinely
  // disappearing in week nine are buried under a hundred who started on Monday.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 100,
    marks: marksFor(list, 3),
    scheduledSessions: list,
    weeksIntoProgramme: 1,
    today: "2026-02-25",
  }), { settlingInWeeks: 3 });

  assert.deepEqual(r.codes, []);
});

test("but the FIGURE is still withheld in week one — the exemption covers codes only", () => {
  // THE TEST THAT PINS THE ORDERING. Muting the null as well would print 100%
  // attendance across a whole intake at the exact moment staff are forming their
  // impression of a cohort. The code is noise in week one; the number is a lie in week
  // one, and a lie does not become true because the student is new.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 100,
    marks: marksFor(list, 3),
    scheduledSessions: list,
    weeksIntoProgramme: 1,
    today: "2026-02-25",
  }), { settlingInWeeks: 3 });

  assert.equal(r.overallAttendance, null);
});

test("past the settling-in period the same student raises everything", () => {
  // Proves the exemption is a window and not an off switch.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 100,
    marks: marksFor(list, 3),
    scheduledSessions: list,
    weeksIntoProgramme: 9,
    today: "2026-02-25",
  }), { settlingInWeeks: 3 });

  assert.ok(r.codes.includes(COVERAGE.ATTENDANCE_UNRELIABLE));
  assert.ok(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN));
});

test("an UNKNOWN programme age is deliberately NOT exempt", () => {
  // Both halves of the rule CLAUDE.md states. A student whose cohort has no start date
  // and no terms cannot be placed on a calendar, and muting every code for them fails
  // safe in the wrong direction — silence about exactly the students the timetable
  // already cannot account for.
  const list = sessions(20);
  for (const weeks of [null, undefined, NaN]) {
    const r = evaluate(input({
      overallAttendance: 100,
      marks: marksFor(list, 3),
      scheduledSessions: list,
      weeksIntoProgramme: weeks,
      today: "2026-02-25",
    }), { settlingInWeeks: 3 });

    assert.ok(r.codes.includes(COVERAGE.ATTENDANCE_UNRELIABLE), String(weeks));
    assert.ok(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN), String(weeks));
  }
});

/* --- a register that stopped being taken ------------------------------------ */

test("a term that ended is not a register nobody took", () => {
  // THE HOLIDAY CASE, and the reason staleness alone cannot raise this code. Every mark
  // is a month old because teaching stopped, not because a tutor did. Firing on the day
  // count alone would light up every student in the college during every vacation, on
  // every run, which is a column staff learn to scroll past by February.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 90,
    marks: marksFor(list, 20),
    scheduledSessions: list,        // nothing timetabled after the last mark
    today: "2026-03-20",
  }), {});

  assert.equal(r.codes.includes(COVERAGE.REGISTER_STALE), false);
  assert.equal(r.lastMarkOn, "2026-02-20");
});

test("a session that ran with no register taken IS a register nobody took", () => {
  // The positive evidence the code needs: something was timetabled after the last mark,
  // it is not in the future, and nothing was written down.
  const list = [...sessions(20), session("s21", "2026-03-05")];
  const r = evaluate(input({
    overallAttendance: 90,
    marks: marksFor(list, 20),
    scheduledSessions: list,
    today: "2026-03-20",
  }), {});

  assert.ok(r.codes.includes(COVERAGE.REGISTER_STALE));
  // ...and it is NOT a coverage finding: 20 of 21 sessions carry a mark.
  assert.equal(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN), false);
});

test("a session still in the future is not one anybody has failed to mark", () => {
  const list = [...sessions(20), session("s21", "2026-04-05")];
  const r = evaluate(input({
    overallAttendance: 90,
    marks: marksFor(list, 20),
    scheduledSessions: list,
    today: "2026-03-20",
  }), {});

  assert.equal(r.codes.includes(COVERAGE.REGISTER_STALE), false);
});

test("a fresh register raises nothing however bad the attendance", () => {
  // Absent marks keep the register fresh. This code is about whether somebody wrote
  // something down, and a month of A is a month of somebody writing something down —
  // the student-side finding for that is TRIP_NOT_SEEN, in the file next door.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 0,
    marks: marksFor(list, 20, "A"),
    scheduledSessions: list,
    today: "2026-02-25",
  }), {});

  assert.equal(r.codes.includes(COVERAGE.REGISTER_STALE), false);
  assert.equal(r.overallAttendance, 0, "a measured zero is real and survives");
});

test("a stale register at a college with no timetable stays silent", () => {
  // Without a timetable, a reading week, the end of a term, a unit that finished and a
  // tutor who stopped taking the register are one indistinguishable shape.
  const list = sessions(20);
  const r = evaluate(input({
    overallAttendance: 90,
    marks: marksFor(list, 20),
    scheduledSessions: [...list, session("s21", "2026-03-05")],
    institution: UNTIMETABLED,
    today: "2026-03-20",
  }), {});

  assert.equal(r.codes.includes(COVERAGE.REGISTER_STALE), false);
});

/* --- what the result carries ------------------------------------------------ */

test("the result stores a DATE and never a day count", () => {
  // Nothing in this feature runs on a schedule — markStale() fires on data events, and
  // a day passing is not an event. "21 days since the last mark" written to a column is
  // wrong by the next morning with nothing to correct it; lastMarkOn is true forever.
  // The screen subtracts.
  const list = sessions(20);
  const r = evaluate(input({ marks: marksFor(list, 20), scheduledSessions: list }), {});

  assert.equal(r.lastMarkOn, "2026-02-20");
  for (const key of Object.keys(r)) {
    assert.equal(/days/i.test(key), false, `${key} looks like a stored day count`);
  }
});

test("no marks at all reports nulls and a zero count, not a zero percentage", () => {
  const r = evaluate(input({ overallAttendance: null, scheduledSessions: sessions(20) }), {});

  assert.equal(r.overallAttendance, null);
  assert.equal(r.lastMarkOn, null);
  assert.equal(r.observations, 0);
  assert.equal(r.markedSessions, 0);
  assert.equal(r.coverageRate, 0, "zero of twenty registers taken IS a measured zero");
  assert.ok(r.codes.includes(COVERAGE.REGISTER_NOT_TAKEN));
});
