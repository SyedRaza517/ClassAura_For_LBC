// Tests for the tripwire layer: the facts about a student that a weighted mean
// cannot express.
//
// No database. tripwires.js is pure — it takes the in-memory shapes the gather has
// already built and returns plain data.
//
// Run with: node --test src/prediction/tripwires.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluate, TRIP } = require("./tripwires");
const { DEFAULTS } = require("./settings");

/** Marks in date order. `mark("2026-03-01", "A")` reads better than an object literal. */
const mark = (date, status) => ({ date, status });

/** The shape gather() hands over, with everything empty unless a test fills it. */
const input = (over = {}) => ({
  today: "2026-03-20",
  marks: [],
  recent: { pct: null, marked: 0 },
  prior: { pct: null, marked: 0 },
  dueUnmarked: [],
  gradeDates: [],
  ...over,
});

/* -------------------------------------------------------------------------- */
/* Absence streak                                                              */
/* -------------------------------------------------------------------------- */

test("the streak counts only absences at the END of the record", () => {
  // Three absences in January and perfect attendance since is a recovered student,
  // not a disappeared one. A percentage cannot tell those apart; this is the whole
  // reason the signal exists.
  const r = evaluate(input({
    marks: [
      mark("2026-03-01", "A"), mark("2026-03-02", "A"), mark("2026-03-03", "A"),
      mark("2026-03-04", "P"), mark("2026-03-05", "P"),
    ],
  }), DEFAULTS);

  assert.equal(r.absenceStreak, 0);
});

test("a trailing run of absences is the streak", () => {
  const r = evaluate(input({
    marks: [
      mark("2026-03-01", "P"), mark("2026-03-02", "A"),
      mark("2026-03-03", "A"), mark("2026-03-04", "A"),
    ],
  }), DEFAULTS);

  assert.equal(r.absenceStreak, 3);
});

test("an excused absence breaks the streak, an unexplained one does not", () => {
  // E means the student told somebody. The signal is "we have lost contact", and a
  // student who reports an absence has not been lost — scoring E as disappearance
  // would raise this on exactly the students who did the right thing.
  const r = evaluate(input({
    marks: [
      mark("2026-03-01", "A"), mark("2026-03-02", "E"),
      mark("2026-03-03", "A"), mark("2026-03-04", "A"),
    ],
  }), DEFAULTS);

  assert.equal(r.absenceStreak, 2);
});

test("late still counts as turning up, so it breaks a streak", () => {
  const r = evaluate(input({
    marks: [mark("2026-03-01", "A"), mark("2026-03-02", "A"), mark("2026-03-03", "L")],
  }), DEFAULTS);

  assert.equal(r.absenceStreak, 0);
});

test("marks arrive in any order and are sorted before the streak is read", () => {
  // gather() groups in Node from a query with no ORDER BY. Reading the streak off
  // arrival order would make it depend on how Postgres felt that morning.
  const r = evaluate(input({
    marks: [
      mark("2026-03-04", "A"), mark("2026-03-01", "P"),
      mark("2026-03-03", "A"), mark("2026-03-02", "A"),
    ],
  }), DEFAULTS);

  assert.equal(r.absenceStreak, 3);
});

test("two registers on the same day are ordered by start time, not arrival order", () => {
  // A six-hour day carries two registers — Teaching then Seminar. Sorting on date
  // alone leaves same-day marks in whatever order Postgres returned, so a student who
  // attended the morning and missed the afternoon reads as a live streak of one on
  // one run and a broken streak on the next, with nothing about them having changed.
  const r = evaluate(input({
    marks: [
      { date: "2026-03-04", startTime: "13:00", status: "A" },
      { date: "2026-03-04", startTime: "09:00", status: "P" },
      { date: "2026-03-03", startTime: "09:00", status: "A" },
    ],
  }), DEFAULTS);

  assert.equal(r.absenceStreak, 1);
  assert.equal(r.lastAttendedOn, "2026-03-04");
});

test("a streak at or over the threshold raises the code", () => {
  const r = evaluate(input({
    marks: [mark("2026-03-01", "A"), mark("2026-03-02", "A"), mark("2026-03-03", "A")],
  }), { ...DEFAULTS, absenceStreakSessions: 3 });

  assert.ok(r.codes.includes(TRIP.ABSENCE_STREAK));
});

test("a streak under the threshold does not", () => {
  const r = evaluate(input({
    marks: [mark("2026-03-01", "A"), mark("2026-03-02", "A")],
  }), { ...DEFAULTS, absenceStreakSessions: 3 });

  assert.equal(r.codes.includes(TRIP.ABSENCE_STREAK), false);
});

/* -------------------------------------------------------------------------- */
/* Never measured is not zero                                                  */
/* -------------------------------------------------------------------------- */

test("a student with no marks at all has a NULL streak, not a streak of zero", () => {
  // A register nobody has taken is not attendance. Zero would read as "we checked
  // and found nothing wrong", which is the exact inversion this codebase exists to
  // avoid, and it would put a brand-new student on a caseload.
  const r = evaluate(input({ marks: [] }), DEFAULTS);

  assert.equal(r.absenceStreak, null);
  assert.equal(r.lastAttendedOn, null);
  assert.deepEqual(r.codes, []);
});

test("marks that are all unrecognised statuses count as no evidence", () => {
  const r = evaluate(input({ marks: [mark("2026-03-01", "?"), mark("2026-03-02", "")] }), DEFAULTS);

  assert.equal(r.absenceStreak, null);
  assert.deepEqual(r.codes, []);
});

/* -------------------------------------------------------------------------- */
/* Last attended                                                               */
/* -------------------------------------------------------------------------- */

test("last attended is the most recent date the student actually turned up", () => {
  const r = evaluate(input({
    marks: [
      mark("2026-03-01", "P"), mark("2026-03-05", "L"),
      mark("2026-03-09", "A"), mark("2026-03-11", "A"),
    ],
  }), DEFAULTS);

  assert.equal(r.lastAttendedOn, "2026-03-05");
});

test("a student who has never attended has a null last-attended date", () => {
  const r = evaluate(input({ marks: [mark("2026-03-01", "A"), mark("2026-03-02", "A")] }), DEFAULTS);

  assert.equal(r.lastAttendedOn, null);
});

test("not seen for longer than the threshold raises the code", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    marks: [mark("2026-03-01", "P"), mark("2026-03-10", "A")],
  }), { ...DEFAULTS, notSeenDays: 14 });

  assert.ok(r.codes.includes(TRIP.NOT_SEEN));
});

test("seen inside the threshold does not raise the code", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    marks: [mark("2026-03-15", "P")],
  }), { ...DEFAULTS, notSeenDays: 14 });

  assert.equal(r.codes.includes(TRIP.NOT_SEEN), false);
});

test("never having attended does not raise NOT_SEEN", () => {
  // NOT_SEEN means "stopped coming". A student who has never been marked present
  // may have enrolled yesterday. Absent evidence is not evidence of absence.
  const r = evaluate(input({
    today: "2026-03-20",
    marks: [mark("2026-03-19", "A")],
  }), { ...DEFAULTS, notSeenDays: 14 });

  assert.equal(r.codes.includes(TRIP.NOT_SEEN), false);
});

/* -------------------------------------------------------------------------- */
/* Work that was due and never marked either way                               */
/* -------------------------------------------------------------------------- */

test("the oldest overdue unmarked piece of work is reported", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    dueUnmarked: [{ dueDate: "2026-02-10" }, { dueDate: "2026-01-15" }, { dueDate: "2026-03-01" }],
  }), { ...DEFAULTS, unmarkedGraceDays: 7 });

  assert.equal(r.oldestUnmarkedDueDate, "2026-01-15");
  assert.ok(r.codes.includes(TRIP.UNMARKED_WORK));
});

test("work inside the grace period is not overdue yet", () => {
  // Marking takes time. Without a grace period this fires on every assessment the
  // morning after its deadline and staff learn to ignore the whole column.
  const r = evaluate(input({
    today: "2026-03-20",
    dueUnmarked: [{ dueDate: "2026-03-18" }],
  }), { ...DEFAULTS, unmarkedGraceDays: 7 });

  assert.equal(r.oldestUnmarkedDueDate, null);
  assert.equal(r.codes.includes(TRIP.UNMARKED_WORK), false);
});

test("work with no due date at all is ignored rather than treated as overdue", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    dueUnmarked: [{ dueDate: null }, { dueDate: "" }],
  }), DEFAULTS);

  assert.equal(r.oldestUnmarkedDueDate, null);
});

/* -------------------------------------------------------------------------- */
/* Attendance slope                                                            */
/* -------------------------------------------------------------------------- */

test("a fall beyond the threshold raises the falling code", () => {
  const r = evaluate(input({
    recent: { pct: 55, marked: 10 },
    prior: { pct: 90, marked: 10 },
  }), { ...DEFAULTS, attendanceSlopeDrop: 10 });

  assert.equal(r.attendanceSlope, -35);
  assert.ok(r.codes.includes(TRIP.ATTENDANCE_FALLING));
});

test("a rise is reported as a positive slope and raises nothing", () => {
  const r = evaluate(input({
    recent: { pct: 90, marked: 10 },
    prior: { pct: 60, marked: 10 },
  }), DEFAULTS);

  assert.equal(r.attendanceSlope, 30);
  assert.equal(r.codes.includes(TRIP.ATTENDANCE_FALLING), false);
});

test("the slope is null when either window was never measured", () => {
  // Not "flat". A student whose prior window has no register has no slope, and
  // reporting 0 would say attendance is steady when nobody looked.
  const noPrior = evaluate(input({
    recent: { pct: 55, marked: 10 },
    prior: { pct: null, marked: 0 },
  }), DEFAULTS);

  assert.equal(noPrior.attendanceSlope, null);
  assert.equal(noPrior.codes.includes(TRIP.ATTENDANCE_FALLING), false);

  const noRecent = evaluate(input({
    recent: { pct: null, marked: 0 },
    prior: { pct: 90, marked: 10 },
  }), DEFAULTS);

  assert.equal(noRecent.attendanceSlope, null);
});

test("a window with too few marks to mean anything yields no slope", () => {
  // One register in a fortnight is 0% or 100% and neither is information.
  const r = evaluate(input({
    recent: { pct: 0, marked: 1 },
    prior: { pct: 100, marked: 1 },
  }), { ...DEFAULTS, slopeMinMarks: 3 });

  assert.equal(r.attendanceSlope, null);
});

/* -------------------------------------------------------------------------- */
/* Grade trend reliability                                                     */
/* -------------------------------------------------------------------------- */

test("grades all entered on one day cannot support a trend", () => {
  // A tutor marking a term's work in one sitting produces four grades whose order is
  // the order they were typed. The engine reads the last two against the previous
  // two and calls that a direction of travel. It is not one.
  const r = evaluate(input({
    gradeDates: ["2026-03-10", "2026-03-10", "2026-03-10", "2026-03-10"],
  }), DEFAULTS);

  assert.ok(r.codes.includes(TRIP.TREND_UNRELIABLE));
});

test("grades spread across days support a trend", () => {
  const r = evaluate(input({
    gradeDates: ["2026-01-10", "2026-02-10", "2026-03-01", "2026-03-10"],
  }), DEFAULTS);

  assert.equal(r.codes.includes(TRIP.TREND_UNRELIABLE), false);
});

test("too few grades to trend at all raises nothing", () => {
  // The engine already reports INSUFFICIENT_DATA for this. A second code saying the
  // same thing is noise on the row.
  const r = evaluate(input({ gradeDates: ["2026-03-10"] }), DEFAULTS);

  assert.equal(r.codes.includes(TRIP.TREND_UNRELIABLE), false);
});

test("missing graded-on dates do not fabricate a collapse", () => {
  const r = evaluate(input({ gradeDates: [null, null, null, null] }), DEFAULTS);

  assert.equal(r.codes.includes(TRIP.TREND_UNRELIABLE), false);
});

/* -------------------------------------------------------------------------- */
/* The invariant the whole tranche rests on                                    */
/* -------------------------------------------------------------------------- */

test("every code is prefixed TRIP_ so it can never be counted as a red indicator", () => {
  // engine.js builds riskDriverCodes from the six REDs and derives redIndicatorCount
  // from that same array. These codes ride the same column. If one of them were ever
  // mistaken for a red it would tip OVR-004 and worsen a band on evidence the
  // override rules were never written against.
  const r = evaluate(input({
    marks: [mark("2026-03-01", "A"), mark("2026-03-02", "A"), mark("2026-03-03", "A")],
    recent: { pct: 20, marked: 8 },
    prior: { pct: 90, marked: 8 },
    dueUnmarked: [{ dueDate: "2026-01-01" }],
    gradeDates: ["2026-03-10", "2026-03-10", "2026-03-10", "2026-03-10"],
  }), DEFAULTS);

  assert.ok(r.codes.length >= 4, "expected several codes from this input");
  for (const code of r.codes) {
    assert.ok(code.startsWith("TRIP_"), `${code} is not namespaced`);
  }
});

test("codes are stable in order and free of duplicates", () => {
  const r = evaluate(input({
    marks: [mark("2026-03-01", "A"), mark("2026-03-02", "A"), mark("2026-03-03", "A")],
  }), DEFAULTS);

  assert.deepEqual([...new Set(r.codes)], r.codes);
});

/* ========================================================================== */
/* Tranche 2 — figures the gather can answer with no extra round trip         */
/* ========================================================================== */

const { attendanceQuality, attainmentShape, engagementRecency } = require("./tripwires");

/* -------------------------------------------------------------------------- */
/* Authorised vs unexplained absence                                           */
/* -------------------------------------------------------------------------- */

test("the unexplained share of absence is a ratio of A to A plus E", () => {
  // Same attendance percentage, opposite meaning. Three absences all phoned in is a
  // student managing an illness; three unexplained is a student nobody has heard from.
  const r = attendanceQuality({ P: 6, L: 0, E: 3, A: 1, marked: 10 }, { lateRecorded: true });
  assert.equal(r.unexplainedShare, 25);
});

test("a student with no absences at all has a NULL unexplained share", () => {
  // Not 0, and not 100. There is no absence to characterise, and 0 would read as
  // "all their absences were authorised" — a statement about absences that do not exist.
  const r = attendanceQuality({ P: 10, L: 0, E: 0, A: 0, marked: 10 }, { lateRecorded: true });
  assert.equal(r.unexplainedShare, null);
});

/* -------------------------------------------------------------------------- */
/* Lateness                                                                    */
/* -------------------------------------------------------------------------- */

test("lateness is a rate of its own, not folded into the attendance model", () => {
  const r = attendanceQuality({ P: 6, L: 2, E: 0, A: 2, marked: 10 }, { lateRecorded: true });
  assert.equal(r.latenessRate, 20);
});

test("a college that never records lateness gets null, not a spotless zero", () => {
  // The Moodle importer maps statuses by acronym, so a college whose plugin has no
  // "L" produces zero L rows for everybody. A rate of exactly 0 there means "not
  // recorded", not "never late" — and reporting it as good news is a lie told to
  // every student in the institution at once.
  const r = attendanceQuality({ P: 8, L: 0, E: 0, A: 2, marked: 10 }, { lateRecorded: false });
  assert.equal(r.latenessRate, null);
});

test("zero lateness IS reported when the college does record lateness", () => {
  const r = attendanceQuality({ P: 8, L: 0, E: 0, A: 2, marked: 10 }, { lateRecorded: true });
  assert.equal(r.latenessRate, 0);
});

/* -------------------------------------------------------------------------- */
/* Attainment shape                                                            */
/* -------------------------------------------------------------------------- */

test("marks below the pass mark are counted, and near-misses separately", () => {
  const r = attainmentShape([70, 44, 38, 20], { passThreshold: 40, nearFailMargin: 10 });
  assert.equal(r.failCount, 2);      // 38 and 20
  assert.equal(r.nearFailCount, 1);  // 44 is within 10 above 40
});

test("no marks at all gives null counts rather than a clean sheet", () => {
  const r = attainmentShape([], { passThreshold: 40, nearFailMargin: 10 });
  assert.equal(r.failCount, null);
  assert.equal(r.nearFailCount, null);
  assert.equal(r.volatility, null);
});

test("volatility separates a steady student from an erratic one at the same average", () => {
  // Both average 60. The engine's averageGrade cannot tell them apart, and they are
  // not the same student.
  const steady = attainmentShape([60, 60, 60, 60], { passThreshold: 40, nearFailMargin: 10 });
  const erratic = attainmentShape([95, 25, 90, 30], { passThreshold: 40, nearFailMargin: 10 });

  assert.equal(steady.volatility, 0);
  assert.ok(erratic.volatility > 25, `expected a wide spread, got ${erratic.volatility}`);
});

test("a single mark has no volatility to measure", () => {
  const r = attainmentShape([60], { passThreshold: 40, nearFailMargin: 10 });
  assert.equal(r.volatility, null);
});

/* -------------------------------------------------------------------------- */
/* Engagement recency — any contact of any kind                                */
/* -------------------------------------------------------------------------- */

test("the last engagement is the most recent of every kind of contact", () => {
  const r = engagementRecency({
    lastAttendedOn: "2026-03-01",
    lastGradedOn: "2026-03-09",
    lastPastoralOn: "2026-03-05",
  });
  assert.equal(r, "2026-03-09");
});

test("engagement recency ignores the kinds that never happened", () => {
  const r = engagementRecency({ lastAttendedOn: null, lastGradedOn: "2026-03-02", lastPastoralOn: null });
  assert.equal(r, "2026-03-02");
});

test("a student with no engagement of any kind has null, never an epoch date", () => {
  const r = engagementRecency({ lastAttendedOn: null, lastGradedOn: null, lastPastoralOn: null });
  assert.equal(r, null);
});

/* ========================================================================== */
/* Tranche 3 — pastoral: what the college has (and has not) done              */
/* ========================================================================== */

test("repeated no-shows to arranged meetings raise a code", () => {
  // A student missing their OWN support meeting is among the strongest disengagement
  // markers available, and no attendance percentage contains it.
  const r = evaluate(input({ pastoral: { noShowCount: 2, lastContactOn: "2026-03-18" } }),
    { ...DEFAULTS, noShowLimit: 2 });

  assert.ok(r.codes.includes(TRIP.NO_SHOW));
});

test("a single missed meeting is not a pattern", () => {
  const r = evaluate(input({ pastoral: { noShowCount: 1, lastContactOn: "2026-03-18" } }),
    { ...DEFAULTS, noShowLimit: 2 });

  assert.equal(r.codes.includes(TRIP.NO_SHOW), false);
});

test("a tutor's own judgement of At Risk is surfaced without being scored", () => {
  const r = evaluate(input({ pastoral: { progress: "At Risk", lastContactOn: "2026-03-18" } }), DEFAULTS);

  assert.ok(r.codes.includes(TRIP.TUTOR_AT_RISK));
});

test("a tutor saying On Track raises nothing", () => {
  const r = evaluate(input({ pastoral: { progress: "On Track", lastContactOn: "2026-03-18" } }), DEFAULTS);

  assert.equal(r.codes.includes(TRIP.TUTOR_AT_RISK), false);
});

test("nobody having spoken to the student in a long time is the COLLEGE's failing", () => {
  // This one is about the institution, not the student. Low one-to-one staff contact
  // is directly linked to students contemplating withdrawal, and it is the college
  // that can fix it.
  const r = evaluate(input({
    today: "2026-03-20",
    pastoral: { lastContactOn: "2026-01-01" },
  }), { ...DEFAULTS, staleContactDays: 42 });

  assert.ok(r.codes.includes(TRIP.NO_PASTORAL_CONTACT));
});

test("recent contact raises nothing", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    pastoral: { lastContactOn: "2026-03-10" },
  }), { ...DEFAULTS, staleContactDays: 42 });

  assert.equal(r.codes.includes(TRIP.NO_PASTORAL_CONTACT), false);
});

test("a student nobody has EVER spoken to raises the contact code", () => {
  // Distinct from the attendance case, where never-attended is not evidence. Here the
  // absence IS the finding: the college has a record of every conversation it has
  // had, so no record means no conversation.
  const r = evaluate(input({ pastoral: { lastContactOn: null } }), DEFAULTS);

  assert.ok(r.codes.includes(TRIP.NO_PASTORAL_CONTACT));
});

test("no pastoral data at all is not treated as a college failing", () => {
  // A college that does not use the pastoral module at all would otherwise have this
  // fire on every student on day one — a caseload of the entire institution, which is
  // the same as no caseload.
  const r = evaluate(input({ pastoral: null }), DEFAULTS);

  assert.equal(r.codes.includes(TRIP.NO_PASTORAL_CONTACT), false);
});

test("marks below the pass mark raise a code the average can hide", () => {
  const r = evaluate(input({ attainment: { failCount: 1 } }), DEFAULTS);

  assert.ok(r.codes.includes(TRIP.RECENT_FAIL));
});

test("a null fail count means unmarked work, not a clean record", () => {
  const r = evaluate(input({ attainment: { failCount: null } }), DEFAULTS);

  assert.equal(r.codes.includes(TRIP.RECENT_FAIL), false);
});

/* ========================================================================== */
/* Tranche 4 — the rest of what the database can honestly answer              */
/* ========================================================================== */

const { unitDispersion, unpassedUnits, weeklyRegularity } = require("./tripwires");

/* --- attendance spread across units --------------------------------------- */

test("a student abandoning one unit is found even when the average looks fine", () => {
  // 75% overall hides 0% in one unit. The average is the number that hides it and the
  // dispersion is the number that finds it — and it names the unit, which is what
  // turns it into a conversation rather than a rating.
  const r = unitDispersion([
    { unitId: "u1", pct: 100, marked: 8 },
    { unitId: "u2", pct: 100, marked: 8 },
    { unitId: "u3", pct: 0, marked: 8 },
  ], { disperseMinMarks: 4 });

  assert.equal(r.worstUnitId, "u3");
  assert.equal(r.spread, 100);
});

test("units with too few marks are excluded from the comparison", () => {
  // A unit with one register reads 0% or 100% and neither is information. Left in, it
  // would always be the "worst unit" and the signal would point at the register rather
  // than the student.
  const r = unitDispersion([
    { unitId: "u1", pct: 90, marked: 8 },
    { unitId: "u2", pct: 0, marked: 1 },
  ], { disperseMinMarks: 4 });

  assert.equal(r.worstUnitId, null);
  assert.equal(r.spread, null);
});

test("one measurable unit is not a spread", () => {
  const r = unitDispersion([{ unitId: "u1", pct: 60, marked: 9 }], { disperseMinMarks: 4 });
  assert.equal(r.spread, null);
});

/* --- units with nothing banked -------------------------------------------- */

test("a unit whose marked work is all below the pass mark has no passing evidence", () => {
  const r = unpassedUnits([
    { unitId: "u1", pcts: [70, 65] },
    { unitId: "u2", pcts: [30, 20] },
  ], { passThreshold: 40 });

  assert.equal(r.unpassed, 1);
  assert.equal(r.measured, 2);
});

test("a unit with nothing marked yet is dropped from BOTH sides, not counted as failed", () => {
  // This is the whole trap. A unit nobody has marked is unmeasurable — counting it as
  // "no passing evidence" would report every student on a new unit as failing it.
  const r = unpassedUnits([
    { unitId: "u1", pcts: [70] },
    { unitId: "u2", pcts: [] },
  ], { passThreshold: 40 });

  assert.equal(r.unpassed, 0);
  assert.equal(r.measured, 1);
});

test("a student with nothing marked anywhere has null, not zero units passed", () => {
  const r = unpassedUnits([{ unitId: "u1", pcts: [] }], { passThreshold: 40 });
  assert.equal(r.unpassed, null);
  assert.equal(r.measured, 0);
});

/* --- attendance regularity ------------------------------------------------ */

test("erratic weeks and steady weeks differ at the same overall percentage", () => {
  const steady = weeklyRegularity([
    { date: "2026-03-02", status: "P" }, { date: "2026-03-09", status: "P" },
    { date: "2026-03-16", status: "A" }, { date: "2026-03-23", status: "P" },
    { date: "2026-03-30", status: "P" }, { date: "2026-04-06", status: "P" },
  ]);
  const erratic = weeklyRegularity([
    { date: "2026-03-02", status: "P" }, { date: "2026-03-09", status: "A" },
    { date: "2026-03-16", status: "P" }, { date: "2026-03-23", status: "A" },
    { date: "2026-03-30", status: "P" }, { date: "2026-04-06", status: "A" },
  ]);

  assert.ok(erratic > steady, `erratic ${erratic} should exceed steady ${steady}`);
});

test("fewer than three weeks of register is not a pattern", () => {
  const r = weeklyRegularity([
    { date: "2026-03-02", status: "P" }, { date: "2026-03-09", status: "A" },
  ]);
  assert.equal(r, null);
});

test("weeks with no timetabled sessions are absent from the series, not zeros", () => {
  // A reading week is not a week of 0% attendance. Only weeks that have marks are
  // weeks; inserting zeros for the gaps would manufacture volatility out of a holiday.
  const r = weeklyRegularity([
    { date: "2026-03-02", status: "P" },
    { date: "2026-03-09", status: "P" },
    { date: "2026-04-20", status: "P" },
  ]);
  assert.equal(r, 0);
});

test("abandoning one unit while attending the rest raises a code", () => {
  const r = evaluate(input({ dispersion: { worstUnitId: "u3", spread: 60 } }),
    { ...DEFAULTS, unitSpreadLimit: 40 });

  assert.ok(r.codes.includes(TRIP.UNIT_ABANDONED));
});

test("an even spread across units raises nothing", () => {
  const r = evaluate(input({ dispersion: { worstUnitId: "u3", spread: 10 } }),
    { ...DEFAULTS, unitSpreadLimit: 40 });

  assert.equal(r.codes.includes(TRIP.UNIT_ABANDONED), false);
});

test("units with nothing banked raise a code the average grade cannot", () => {
  const r = evaluate(input({ banked: { unpassed: 2, measured: 4 } }), DEFAULTS);
  assert.ok(r.codes.includes(TRIP.UNITS_UNPASSED));
});

test("a student with no marked units anywhere raises no banked code", () => {
  const r = evaluate(input({ banked: { unpassed: null, measured: 0 } }), DEFAULTS);
  assert.equal(r.codes.includes(TRIP.UNITS_UNPASSED), false);
});
