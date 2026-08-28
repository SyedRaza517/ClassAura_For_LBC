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
  submissionsRecorded: true,
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

test("undated grades are the WORST case for a trend, not an exempt one", () => {
  // This test asserted the opposite until the review caught it. A grade with no
  // gradedOn falls back to gradedAt — the row-creation timestamp — so on a first
  // Moodle import the "trend" is import order. That is more artefactual than four
  // marks sharing a real date, not less, and stripping the nulls before the length
  // check let it through silently.
  const r = evaluate(input({ gradeDates: [null, null, null, null] }), DEFAULTS);

  assert.ok(r.codes.includes(TRIP.TREND_UNRELIABLE));
});

test("only the grades the ENGINE compares decide whether the trend is reliable", () => {
  // engine.js reads the last gradeTrendAssessmentCount * 2 marks and nothing else.
  // Testing the whole history meant a student whose four most recent marks were all
  // entered in one sitting — the exact artefact — passed as reliable because three
  // older marks carried distinct dates.
  const r = evaluate(input({
    gradeDates: ["2026-01-10", "2026-02-10", "2026-03-10",
                 "2026-05-01", "2026-05-01", "2026-05-01", "2026-05-01"],
  }), DEFAULTS);

  assert.ok(r.codes.includes(TRIP.TREND_UNRELIABLE));
});

test("older marks sharing a date do not condemn a trend built on distinct ones", () => {
  const r = evaluate(input({
    gradeDates: ["2026-01-10", "2026-01-10", "2026-01-10",
                 "2026-03-01", "2026-03-10", "2026-04-01", "2026-04-20"],
  }), DEFAULTS);

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
  const r = attendanceQuality({ P: 6, L: 0, E: 3, A: 1, marked: 10 }, { lateRecorded: true, excusedRecorded: true });
  assert.equal(r.unexplainedShare, 25);
});

test("a student with no absences at all has a NULL unexplained share", () => {
  // Not 0, and not 100. There is no absence to characterise, and 0 would read as
  // "all their absences were authorised" — a statement about absences that do not exist.
  const r = attendanceQuality({ P: 10, L: 0, E: 0, A: 0, marked: 10 }, { lateRecorded: true, excusedRecorded: true });
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

/* -------------------------------------------------------------------------- */
/* The institution guard on unmarked work                                      */
/* -------------------------------------------------------------------------- */

test("a college that records no submissions at all gets no unmarked-work finding", () => {
  // NOTHING in this codebase writes AssessmentSubmission — the Canvas and Blackboard
  // adapters issue no Prisma call at all, and the Moodle importer never touches it.
  // So at a college with assessments and no submission sync, EVERY past-due piece of
  // work looks "unmarked either way" and this fires for every student in the
  // institution at once. That is a fact about the integration, not about anybody's
  // coursework, and it is exactly the always-lit column this signal was designed to
  // avoid becoming.
  const r = evaluate(input({
    today: "2026-03-20",
    dueUnmarked: [{ dueDate: "2026-01-15" }, { dueDate: "2026-02-01" }],
    submissionsRecorded: false,
  }), DEFAULTS);

  assert.equal(r.oldestUnmarkedDueDate, null);
  assert.equal(r.codes.includes(TRIP.UNMARKED_WORK), false);
});

test("the same student IS reported at a college that does record submissions", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    dueUnmarked: [{ dueDate: "2026-01-15" }],
    submissionsRecorded: true,
  }), DEFAULTS);

  assert.equal(r.oldestUnmarkedDueDate, "2026-01-15");
  assert.ok(r.codes.includes(TRIP.UNMARKED_WORK));
});

test("a college that never records authorised absence gets null, not 100% unexplained", () => {
  // The mirror image of the lateness trap, and it errs the other way: where a missing
  // "L" understates concern, a missing "E" acronym makes EVERY absent student in the
  // institution read as 100% unexplained — presented on the panel as a finding about
  // them. Same institution-level question, same answer: null.
  const r = attendanceQuality({ P: 10, L: 1, E: 0, A: 4, marked: 15 },
    { lateRecorded: true, excusedRecorded: false });

  assert.equal(r.unexplainedShare, null);
});

test("unexplained share IS reported at a college that records authorised absence", () => {
  const r = attendanceQuality({ P: 10, L: 1, E: 2, A: 2, marked: 15 },
    { lateRecorded: true, excusedRecorded: true });

  assert.equal(r.unexplainedShare, 50);
});

/* ========================================================================== */
/* Tranche 5 — the last of what this schema can honestly answer               */
/* ========================================================================== */

const { submissionTiming, repeatConcerns } = require("./tripwires");

/* --- handing work in late -------------------------------------------------- */

test("late submission is measured from the date the work arrived", () => {
  const r = submissionTiming([
    { submittedOn: "2026-03-01", dueDate: "2026-03-01" },
    { submittedOn: "2026-03-05", dueDate: "2026-03-01" },
    { submittedOn: "2026-03-11", dueDate: "2026-03-01" },
  ], { submittedOnRecorded: true });

  assert.equal(r.lateRate, 66.7);
  assert.equal(r.meanDaysLate, 7);   // (4 + 10) / 2
});

test("work with no recorded arrival date is dropped from BOTH sides", () => {
  // A null submittedOn means "we do not know when they handed it in" — manual marks,
  // and VLE items that carry no submission timestamp. Counting it as on time would
  // reward the gap in the feed.
  const r = submissionTiming([
    { submittedOn: null, dueDate: "2026-03-01" },
    { submittedOn: "2026-03-05", dueDate: "2026-03-01" },
  ], { submittedOnRecorded: true });

  assert.equal(r.lateRate, 100);
  assert.equal(r.gradedWithDates, 1);
});

test("a college whose feed carries no submission dates gets null, not 0% late", () => {
  // Same institution-level trap as lateness and excused absence. If nothing anywhere
  // has a submittedOn, "0% late" is a statement about the integration.
  const r = submissionTiming([
    { submittedOn: null, dueDate: "2026-03-01" },
    { submittedOn: null, dueDate: "2026-03-08" },
  ], { submittedOnRecorded: false });

  assert.equal(r.lateRate, null);
  assert.equal(r.meanDaysLate, null);
});

test("work with no deadline cannot be late", () => {
  const r = submissionTiming([{ submittedOn: "2026-03-05", dueDate: null }], { submittedOnRecorded: true });
  assert.equal(r.lateRate, null);
});

test("everything on time reports zero, not null, when the feed does carry dates", () => {
  const r = submissionTiming([
    { submittedOn: "2026-02-28", dueDate: "2026-03-01" },
    { submittedOn: "2026-03-01", dueDate: "2026-03-01" },
  ], { submittedOnRecorded: true });

  assert.equal(r.lateRate, 0);
  // Null, not 0 — the mean is over the LATE pieces, and there are none. See the
  // dedicated test below.
  assert.equal(r.meanDaysLate, null);
});

/* --- the same concern raised twice ----------------------------------------- */

test("a concern raised in two separate reviews is a repeat", () => {
  const r = repeatConcerns([
    { date: "2026-01-10", concerns: ["Attendance", "Wellbeing"] },
    { date: "2026-02-10", concerns: ["Attendance"] },
  ], null);

  assert.deepEqual(r.repeated, ["Attendance"]);
});

test('"No Concerns" is a value in the list and must never count as one', () => {
  // The allowlist at routes/studentReviews.js includes "No Concerns" as a member, so a
  // naive length check turns the strongest reassurance in the dataset into a warning —
  // and two clean reviews would read as a repeated concern.
  const r = repeatConcerns([
    { date: "2026-01-10", concerns: ["No Concerns"] },
    { date: "2026-02-10", concerns: ["No Concerns"] },
  ], null);

  assert.deepEqual(r.repeated, []);
  assert.equal(r.reviewsWithConcerns, 0);
});

test("one review cannot establish a repeat", () => {
  const r = repeatConcerns([{ date: "2026-01-10", concerns: ["Attendance", "Attendance"] }], null);
  assert.deepEqual(r.repeated, []);
});

test("no reviews at all gives null, not an empty finding", () => {
  const r = repeatConcerns([], null);
  assert.equal(r.repeated, null);
});

test("chronic late submission raises a code the on-time rate cannot", () => {
  const r = evaluate(input({ timing: { lateRate: 60, meanDaysLate: 9, gradedWithDates: 5 } }),
    { ...DEFAULTS, lateSubmissionLimit: 40, lateSubmissionMinPieces: 3 });

  assert.ok(r.codes.includes(TRIP.CHRONIC_LATE));
});

test("a null late rate raises nothing", () => {
  const r = evaluate(input({ timing: { lateRate: null } }), DEFAULTS);
  assert.equal(r.codes.includes(TRIP.CHRONIC_LATE), false);
});

test("a concern raised twice raises a code", () => {
  const r = evaluate(input({ pastoral: { lastContactOn: "2026-03-18", repeated: ["Attendance"] } }), DEFAULTS);
  assert.ok(r.codes.includes(TRIP.REPEAT_CONCERN));
});

test("an intervention past its agreed review date with no outcome is the college's failing", () => {
  const r = evaluate(input({ today: "2026-03-20", interventions: { overdueReviews: 1 } }), DEFAULTS);
  assert.ok(r.codes.includes(TRIP.REVIEW_OVERDUE));
});

test("an intervention with no agreed review date is not overdue", () => {
  // Nobody promised a date, so nobody has missed one. Reporting it would put every
  // open intervention on the list the moment it was raised.
  const r = evaluate(input({ interventions: { overdueReviews: 0 } }), DEFAULTS);
  assert.equal(r.codes.includes(TRIP.REVIEW_OVERDUE), false);
});

test("a brand-new student who has started is exempt from the disengagement codes", () => {
  // Weeks-into-programme exists mainly to SUPPRESS. In week one a student has no
  // pastoral record, and firing on that would put the whole intake on the caseload.
  //
  // The streak is exempt only because this student HAS attended — see the non-starter
  // test below, which is the case the first version of this wrongly covered up.
  const r = evaluate(input({
    weeksIntoProgramme: 1,
    pastoral: { lastContactOn: null },
    marks: [mark("2026-03-16", "P"), mark("2026-03-19", "A"), mark("2026-03-20", "A"), mark("2026-03-20", "A")],
  }), { ...DEFAULTS, absenceStreakSessions: 3, settlingInWeeks: 3 });

  assert.equal(r.codes.includes(TRIP.NO_PASTORAL_CONTACT), false);
  assert.equal(r.codes.includes(TRIP.ABSENCE_STREAK), false);
});

test("the same student past the settling-in period is not exempt", () => {
  const r = evaluate(input({
    weeksIntoProgramme: 8,
    pastoral: { lastContactOn: null },
    marks: [mark("2026-03-19", "A"), mark("2026-03-20", "A"), mark("2026-03-20", "A")],
  }), { ...DEFAULTS, absenceStreakSessions: 3, settlingInWeeks: 3 });

  assert.ok(r.codes.includes(TRIP.NO_PASTORAL_CONTACT));
  assert.ok(r.codes.includes(TRIP.ABSENCE_STREAK));
});

test("an unknown programme age is NOT treated as brand new", () => {
  // A student whose cohort has no start date and no terms has an unknown age, and
  // exempting them would silently mute every code for anybody the calendar cannot
  // place — failing safe in the wrong direction.
  const r = evaluate(input({
    weeksIntoProgramme: null,
    pastoral: { lastContactOn: null },
  }), { ...DEFAULTS, settlingInWeeks: 3 });

  assert.ok(r.codes.includes(TRIP.NO_PASTORAL_CONTACT));
});

/* ========================================================================== */
/* Tranche 5 corrections                                                      */
/* ========================================================================== */

test("a student who enrolled and never turned up is NOT exempt in week one", () => {
  // The settling-in exemption was justified by "a new student has no history" — true
  // of the absence-of-record codes, and FALSE of this one. ABSENCE_STREAK needs N
  // consecutive MARKED absences; attendanceShape returns null when no register exists,
  // so it cannot fire on an intake nobody has taken a register for. It fires only when
  // the register exists and says the student was not there, which is evidence.
  //
  // And this is the student a sponsoring provider is required to identify — the
  // non-starter — inside exactly the window the exemption was covering up.
  const r = evaluate(input({
    weeksIntoProgramme: 1,
    marks: [mark("2026-03-18", "A"), mark("2026-03-19", "A"), mark("2026-03-20", "A")],
  }), { ...DEFAULTS, absenceStreakSessions: 3, settlingInWeeks: 3 });

  assert.ok(r.codes.includes(TRIP.ABSENCE_STREAK));
});

test("a new student who HAS started still gets the settling-in grace", () => {
  const r = evaluate(input({
    weeksIntoProgramme: 1,
    marks: [mark("2026-03-16", "P"), mark("2026-03-18", "A"), mark("2026-03-19", "A"), mark("2026-03-20", "A")],
  }), { ...DEFAULTS, absenceStreakSessions: 3, settlingInWeeks: 3 });

  assert.equal(r.codes.includes(TRIP.ABSENCE_STREAK), false);
});

test("a new student is still exempt from the no-contact code", () => {
  // This one IS an absence-of-record code and nobody expects a one-to-one in week one.
  const r = evaluate(input({ weeksIntoProgramme: 1, pastoral: { lastContactOn: null } }),
    { ...DEFAULTS, settlingInWeeks: 3 });

  assert.equal(r.codes.includes(TRIP.NO_PASTORAL_CONTACT), false);
});

test("one late assignment is not a pattern of lateness", () => {
  // Every sibling rate in this file has a minimum denominator for exactly this reason.
  // A single marked piece handed in a day late reads 100%, and the screen calls that
  // "work is regularly handed in late".
  const r = submissionTiming([{ submittedOn: "2026-03-02", dueDate: "2026-03-01" }], { submittedOnRecorded: true });

  assert.equal(r.gradedWithDates, 1);

  const codes = evaluate(input({ timing: r }), { ...DEFAULTS, lateSubmissionMinPieces: 3 });
  assert.equal(codes.codes.includes(TRIP.CHRONIC_LATE), false);
});

test("enough late work over enough pieces does raise the code", () => {
  const r = submissionTiming([
    { submittedOn: "2026-03-02", dueDate: "2026-03-01" },
    { submittedOn: "2026-03-09", dueDate: "2026-03-01" },
    { submittedOn: "2026-03-01", dueDate: "2026-03-01" },
  ], { submittedOnRecorded: true });

  const codes = evaluate(input({ timing: r }), { ...DEFAULTS, lateSubmissionMinPieces: 3, lateSubmissionLimit: 40 });
  assert.ok(codes.codes.includes(TRIP.CHRONIC_LATE));
});

test("nothing late is a null mean, not a mean of zero", () => {
  // The denominator is the late pieces, so with none the mean is undefined. Zero is
  // indistinguishable on the row from a real mean of 0, which cannot occur — being
  // late by zero days is the definition of on time.
  const r = submissionTiming([
    { submittedOn: "2026-02-28", dueDate: "2026-03-01" },
    { submittedOn: "2026-03-01", dueDate: "2026-03-01" },
  ], { submittedOnRecorded: true });

  assert.equal(r.lateRate, 0);
  assert.equal(r.meanDaysLate, null);
});

test("a concern from two years ago no longer counts as repeated", () => {
  // Every other pastoral signal here is windowed. This one read the student's whole
  // history, so a concern raised twice in Year 1 stayed on the row for the rest of the
  // programme and no number of clean reviews could clear it.
  const r = repeatConcerns([
    { date: "2024-10-01", concerns: ["Attendance"] },
    { date: "2024-11-01", concerns: ["Attendance"] },
    { date: "2026-03-01", concerns: ["No Concerns"] },
  ], "2025-09-01");

  assert.deepEqual(r.repeated, []);
});

test("a concern repeated inside the window still counts", () => {
  const r = repeatConcerns([
    { date: "2026-01-10", concerns: ["Wellbeing"] },
    { date: "2026-02-10", concerns: ["Wellbeing"] },
  ], "2025-09-01");

  assert.deepEqual(r.repeated, ["Wellbeing"]);
});

/* ========================================================================== */
/* Tranche 6 — the college's side of the conversation                         */
/* ========================================================================== */

const { queryBacklog, contactDeficit } = require("./tripwires");

const q = (createdOn, over = {}) => ({ createdOn, status: "open", respondedAt: null, ...over });

test("the oldest unanswered question is reported, not the most recent", () => {
  const r = queryBacklog([q("2026-03-01"), q("2026-01-15"), q("2026-02-20")], { repliesRecorded: true });
  assert.equal(r.oldestOpenQueryOn, "2026-01-15");
  assert.equal(r.openQueryCount, 3);
});

test("an answered question is not waiting, however long the college took", () => {
  const r = queryBacklog([q("2025-01-01", { status: "answered", respondedAt: "2026-03-01" })],
    { repliesRecorded: true });
  assert.equal(r.oldestOpenQueryOn, null);
  assert.equal(r.openQueryCount, 0);
});

test("a student who has never asked anything has a NULL count, not a count of zero", () => {
  // Paired with the test above, which pins 0 as a REAL value meaning "the college
  // answered everything they asked". A naive open.length returns 0 for both, printing
  // reassurance about a student who never got the chance to be ignored.
  const r = queryBacklog([], { repliesRecorded: true });
  assert.equal(r.openQueryCount, null);
  assert.equal(r.oldestOpenQueryOn, null);
});

test("a college that answers out of band does not accuse itself", () => {
  // Staff who read queries in the app and reply in person never press Respond, so every
  // query the college has ever received sits at "open" forever. That is a workflow
  // fact, not a student's wait.
  const r = queryBacklog([q("2025-01-01")], { repliesRecorded: false });
  assert.equal(r.oldestOpenQueryOn, null);
  assert.equal(r.openQueryCount, null);
});

test("a query marked open but carrying a response date is treated as answered", () => {
  const r = queryBacklog([q("2025-01-01", { respondedAt: "2025-01-03" })], { repliesRecorded: true });
  assert.equal(r.openQueryCount, 0);
});

test("an open query with no usable date is counted but never aged", () => {
  const r = queryBacklog([q(null)], { repliesRecorded: true });
  assert.equal(r.openQueryCount, 1);
  assert.equal(r.oldestOpenQueryOn, null);
});

test("a question left unanswered beyond the window is the college's failing", () => {
  const r = evaluate(input({
    today: "2026-03-20",
    queries: { oldestOpenQueryOn: "2026-03-01", openQueryCount: 1 },
  }), { ...DEFAULTS, unansweredQueryDays: 5 });

  assert.ok(r.codes.includes(TRIP.QUERY_UNANSWERED));
});

/* --- the contact deficit -------------------------------------------------- */

const deficit = (over = {}) => contactDeficit({
  riskLevel: "R4", lastContactOn: null, pastoralRecorded: true, today: "2026-03-20", ...over,
}, DEFAULTS).codes;

test("a high-risk student nobody has ever spoken to raises the deficit", () => {
  assert.ok(deficit().includes(TRIP.CONTACT_DEFICIT));
});

test("a worse band raises it too, pinning the index direction", () => {
  assert.ok(deficit({ riskLevel: "R5" }).includes(TRIP.CONTACT_DEFICIT));
});

test("the same silence at a comfortable risk level raises nothing", () => {
  // Without the risk cross this is indistinguishable from NO_PASTORAL_CONTACT.
  assert.deepEqual(deficit({ riskLevel: "R1" }), []);
});

test("a college with no pastoral module is not accused of ignoring its high-risk students", () => {
  assert.deepEqual(deficit({ riskLevel: "R5", pastoralRecorded: false }), []);
});

test("a high-risk student spoken to inside the shorter window raises nothing", () => {
  assert.deepEqual(deficit({ lastContactOn: "2026-03-18" }), []);
});

test("the deficit fires where the general contact code would not yet", () => {
  // 19 days: past contactDeficitDays (14), well inside staleContactDays (42). This is
  // the test that proves the signal adds something NO_PASTORAL_CONTACT does not.
  assert.ok(deficit({ lastContactOn: "2026-03-01" }).includes(TRIP.CONTACT_DEFICIT));
});

test("an unknown band raises nothing rather than assuming the worst", () => {
  assert.deepEqual(deficit({ riskLevel: null }), []);
  assert.deepEqual(deficit({ riskLevel: "R9" }), []);
});

test("a query the student sent counts as engagement", () => {
  const r = engagementRecency({
    lastAttendedOn: "2026-03-01", lastGradedOn: null, lastPastoralOn: null, lastQueryOn: "2026-03-11",
  });
  assert.equal(r, "2026-03-11");
});

/* ========================================================================== */
/* Tranche 7 — promises the college made and did not keep                     */
/* ========================================================================== */

const { overdueFollowUps } = require("./tripwires");

const promise = (due, over = {}) => ({ followUpDate: due, followUpCompletedOn: null, stillFlagged: true, ...over });

test("a promised follow-up past its date with nothing recording it happened is overdue", () => {
  const r = overdueFollowUps([promise("2026-02-01")], "2026-01-01", "2026-03-13");
  assert.equal(r.overdue, 1);
  assert.equal(r.judged, 1);
});

test("a follow-up that was held is not overdue, however late it was held", () => {
  const r = overdueFollowUps([promise("2026-02-01", { followUpCompletedOn: "2026-02-20", stillFlagged: false })],
    "2026-01-01", "2026-03-13");
  assert.equal(r.overdue, 0);
  assert.equal(r.judged, 1);
});

test("a follow-up inside the grace period is not yet a failure", () => {
  // Without a grace period this fires the morning after every date in the diary, and a
  // column that is always lit is one staff stop reading.
  const r = overdueFollowUps([promise("2026-03-18")], "2026-01-01", "2026-03-13");
  // NULL, not 0. Nothing about this promise has been judged yet, and the file is
  // consistent that an unjudged thing has no figure rather than a figure of zero — a
  // 0 here would read as "we looked and the college kept every promise".
  assert.equal(r.overdue, null);
  assert.equal(r.judged, 0);
});

test("a promise the college explicitly stood down is not a broken one", () => {
  // The student withdrew, or the concern resolved itself. The row keeps its date so the
  // retraction stays visible to anyone auditing the practice, but nobody failed.
  const r = overdueFollowUps([promise("2026-02-01", { stillFlagged: false })], "2026-01-01", "2026-03-13");
  assert.equal(r.overdue, 0);
});

test("a college that has never closed a follow-up reports NULL, not a backlog", () => {
  // THE MIGRATION TRAP, and it is the sharpest here. Every row written before
  // followUpCompletedOn existed carries null, for follow-ups held on the day exactly as
  // much as for ones nobody made. Reading that null as "not done" would put the
  // college's entire history on the caseload the morning the column shipped.
  const r = overdueFollowUps([promise("2026-02-01"), promise("2026-01-10")], null, "2026-03-13");
  assert.equal(r.overdue, null);
  assert.equal(r.judged, 0);
});

test("promises made before the college could record a closure are not judged", () => {
  // The watermark is the earliest closure this college ever recorded — an observed
  // lower bound on when it became ABLE to record one. Anything older cannot be judged.
  const r = overdueFollowUps([promise("2025-06-01"), promise("2026-02-01")], "2026-01-01", "2026-03-13");
  assert.equal(r.judged, 1);
  assert.equal(r.overdue, 1);
});

test("a row with no promise on it is not a kept promise either", () => {
  const r = overdueFollowUps([promise(null)], "2026-01-01", "2026-03-13");
  assert.equal(r.overdue, null);
  assert.equal(r.judged, 0);
});

test("nothing judgeable is null, not zero missed", () => {
  const r = overdueFollowUps([], "2026-01-01", "2026-03-13");
  assert.equal(r.overdue, null);
});

test("a missed promise raises the code", () => {
  const r = evaluate(input({ pastoral: { lastContactOn: "2026-03-12", overdueFollowUps: 2 } }), DEFAULTS);
  assert.ok(r.codes.includes(TRIP.FOLLOWUP_MISSED));
});

test("a null overdue count raises nothing", () => {
  const r = evaluate(input({ pastoral: { lastContactOn: "2026-03-12", overdueFollowUps: null } }), DEFAULTS);
  assert.equal(r.codes.includes(TRIP.FOLLOWUP_MISSED), false);
});
