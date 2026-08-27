// Tripwires: the facts about a student that a weighted mean structurally cannot say.
//
// PURE. No database, no clock, no tenant. Everything arrives in `raw`, including
// today's date — same seam as engine.js, and for the same reason: these are the
// lines a college will be asked to defend, so they have to be checkable without
// standing up an institution's worth of fixtures.
//
// WHY THIS IS A SEPARATE LAYER AND NOT SEVEN MORE WEIGHTED COMPONENTS.
//
// A weighted mean answers "how is this student doing, overall". It is very bad at
// "this student has not been seen for three weeks", because averaging that against
// six other numbers is exactly what hides it. A student can sit at a perfectly
// respectable 78 while having stopped attending a fortnight ago, and the score is
// not wrong — it is answering a different question from the one staff need answered.
//
// So none of this moves the number. Each tripwire is a condition with an action
// attached, and it rides alongside the score rather than inside it. The research
// this was built from is blunt on the point: an early warning system that predicted
// accurately still changed no outcomes, because prediction without a named next step
// is not an intervention.
//
// WHY THE CODES ARE NAMESPACED `TRIP_`.
//
// They are appended to `riskDriverCodes`, which is the same array engine.js builds
// from its six RED indicators — and `redIndicatorCount` is derived from that same
// set of reds, then compared against `redIndicatorThreshold` to decide whether
// OVR-004 worsens a band. engine.js takes its count from the `reds` array directly
// and `riskDriverCodes` is a *copy*, so appending here provably cannot reach the
// override. The prefix exists so that stays obvious to the next person, and so a
// future reader adding a code cannot accidentally name it `RED_` something.
//
// WHY DATES ARE STORED AND DAY-COUNTS ARE NOT.
//
// Nothing in this feature runs on a schedule — scores exist once somebody presses
// Recalculate, and `markStale` is called on data events. A day passing is not an
// event. So "days since last attended" computed here and written to a column is
// wrong by tomorrow morning and nothing will ever correct it, while the DATE the
// student last attended is true forever. The columns carry dates; the codes are a
// snapshot of what was true at calculation time, and the client derives freshness
// from the dates rather than trusting the codes' age.
const { isStatus } = require("../attendance");

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so
// these strings outlive several rewrites of the screen. Structured codes, never
// display text — the client maps them to wording, and rewording must not orphan a
// stored row.
const TRIP = {
  ABSENCE_STREAK: "TRIP_ABSENCE_STREAK",
  NOT_SEEN: "TRIP_NOT_SEEN",
  UNMARKED_WORK: "TRIP_UNMARKED_WORK",
  ATTENDANCE_FALLING: "TRIP_ATTENDANCE_FALLING",
  TREND_UNRELIABLE: "TRIP_TREND_UNRELIABLE",
  RECENT_FAIL: "TRIP_RECENT_FAIL",
  NO_SHOW: "TRIP_NO_SHOW",
  TUTOR_AT_RISK: "TRIP_TUTOR_AT_RISK",
  // The only code here that describes the INSTITUTION rather than the student.
  NO_PASTORAL_CONTACT: "TRIP_NO_PASTORAL_CONTACT",
  UNIT_ABANDONED: "TRIP_UNIT_ABANDONED",
  UNITS_UNPASSED: "TRIP_UNITS_UNPASSED",
};

const TRIP_CODES = Object.values(TRIP);

// Turning up. L is late but present — the student was in the room, and a register
// that treats a late arrival as a disappearance would raise a contact alert on
// somebody who was sitting in the class.
const ATTENDED = new Set(["P", "L"]);

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/** Whole days between two YYYY-MM-DD dates, `to` minus `from`. */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** YYYY-MM-DD, `days` before `iso`. String arithmetic on a UTC midnight, so it never
 *  drifts across a BST boundary the way a local Date would. */
function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Attendance shape                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The trailing run of unexplained absences, and the last date the student turned up.
 *
 * Returns nulls — never zeros — when there is no register to read. A student whose
 * marks have never been taken has no streak; reporting 0 would read as "we checked
 * and they are fine", which is the inversion this whole codebase is organised to
 * avoid, and it would put every newly-enrolled student on a contact list.
 *
 * E (excused) BREAKS a streak without counting as attendance. The question this
 * signal answers is "have we lost contact with this person", and a student who rang
 * in to report an absence has not been lost. Counting E as disappearance would fire
 * hardest on the students who did exactly what they were asked to do.
 */
function attendanceShape(marks) {
  // gather() groups these in Node from a query with no ORDER BY, so arrival order is
  // whatever Postgres returned. Sorting here rather than there keeps the ordering
  // requirement next to the code that depends on it.
  //
  // The start time is the second key and it is load-bearing, not tidiness. A
  // six-hour teaching day carries two registers — Teaching then Seminar — and a
  // student who attended the morning and missed the afternoon has a live streak of
  // one, while one who missed the morning and came back after lunch has none. On
  // date alone those two are indistinguishable, and which answer a student got would
  // depend on the order Postgres happened to return the rows in. Marks with no start
  // time sort together and keep their date ordering, so a register created before
  // that column meant anything is unaffected.
  const known = marks
    .filter((m) => m && isStatus(m.status) && m.date)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const at = a.startTime || "";
      const bt = b.startTime || "";
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

  if (!known.length) return { absenceStreak: null, lastAttendedOn: null };

  let absenceStreak = 0;
  for (let i = known.length - 1; i >= 0; i -= 1) {
    if (known[i].status !== "A") break;
    absenceStreak += 1;
  }

  let lastAttendedOn = null;
  for (let i = known.length - 1; i >= 0; i -= 1) {
    if (ATTENDED.has(known[i].status)) { lastAttendedOn = known[i].date; break; }
  }

  return { absenceStreak, lastAttendedOn };
}

/* -------------------------------------------------------------------------- */
/* Attendance quality — the same marks, asked different questions              */
/* -------------------------------------------------------------------------- */

/**
 * Two figures a percentage cannot carry: how much of the absence was unexplained,
 * and how often the student arrives late.
 *
 * @param {{P,L,E,A,marked}} counts  as attendance.summarise() returns them
 * @param {{lateRecorded:boolean}} opts  whether this college records lateness AT ALL
 */
function attendanceQuality(counts, opts) {
  const c = counts || {};
  const absences = (c.A || 0) + (c.E || 0);

  // A student with no absences has no absence to characterise. Zero would read as
  // "all of their absences were authorised", which is a claim about absences that do
  // not exist, and it would sit on the screen looking like a finding.
  const unexplainedShare = absences > 0 ? round1(((c.A || 0) / absences) * 100) : null;

  // THE ZERO HERE IS A TRAP AND THIS GUARD IS THE WHOLE POINT.
  //
  // The Moodle importer maps attendance statuses by acronym from whatever status set
  // the college's plugin defines. A college with no "L" acronym produces zero L rows
  // for every student who has ever enrolled. The resulting lateness rate of exactly
  // 0.0% is not "never late" — it is "not recorded", and shipping it as a clean sheet
  // tells a comforting lie about every student in the institution simultaneously.
  //
  // `lateRecorded` is decided once per batch by looking for any L anywhere in the
  // college, which is the only level at which the question is answerable: a single
  // student having no L marks is perfectly ordinary.
  const latenessRate = opts && opts.lateRecorded && c.marked > 0
    ? round1(((c.L || 0) / c.marked) * 100)
    : null;

  return { unexplainedShare, latenessRate };
}

/* -------------------------------------------------------------------------- */
/* Attainment shape — the same marks, asked different questions                */
/* -------------------------------------------------------------------------- */

/**
 * What an average grade hides: how many marks were actually failures, how many only
 * just cleared, and how erratic the series is.
 *
 * A mean of 60 can be four steady 60s or a 95 and a 25. Those are not the same
 * student and the same intervention does not help both.
 *
 * @param {number[]} pcts  marks as percentages of their own maxMarks
 * @param {{passThreshold, nearFailMargin}} config
 */
function attainmentShape(pcts, config) {
  const list = (pcts || []).filter(isNum);

  // No marks is not a clean record. Counting zero failures for a student nobody has
  // marked yet is the same error as scoring their attendance at 0.
  if (!list.length) return { failCount: null, nearFailCount: null, volatility: null };

  let failCount = 0, nearFailCount = 0;
  for (const p of list) {
    if (p < config.passThreshold) failCount += 1;
    else if (p < config.passThreshold + config.nearFailMargin) nearFailCount += 1;
  }

  // Population standard deviation, and order-independent — which matters, because the
  // grade ordering in this codebase is only as trustworthy as the gradedOn dates
  // behind it (see TRIP_TREND_UNRELIABLE). A spread does not care what order the
  // marks arrived in, so this figure stays honest where the trend cannot.
  //
  // One mark has no spread. Reporting 0 would say "perfectly consistent" about a
  // student who has been assessed once.
  let volatility = null;
  if (list.length >= 2) {
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    const variance = list.reduce((acc, p) => acc + (p - mean) ** 2, 0) / list.length;
    volatility = round1(Math.sqrt(variance));
  }

  return { failCount, nearFailCount, volatility };
}

/* -------------------------------------------------------------------------- */
/* Attendance spread across units                                              */
/* -------------------------------------------------------------------------- */

/**
 * The worst unit against the best, and which unit it is.
 *
 * An overall attendance figure of 75% is the number that HIDES a student who has
 * quietly stopped going to one unit while attending everything else. This is the
 * number that finds them — and because it names the unit, it turns a rating into a
 * conversation: a timetable clash, one lecturer, one subject they are lost in.
 *
 * @param {Array<{unitId, pct, marked}>} perUnit
 */
function unitDispersion(perUnit, config) {
  // A unit holding one or two registers reads 0% or 100% and neither is information.
  // Left in the comparison it would always be the "worst unit", and the signal would
  // be pointing at the register rather than at the student.
  const usable = (perUnit || []).filter((u) => u && isNum(u.pct) && u.marked >= config.disperseMinMarks);

  if (usable.length < 2) return { worstUnitId: null, spread: null };

  let worst = usable[0], best = usable[0];
  for (const u of usable) {
    if (u.pct < worst.pct) worst = u;
    if (u.pct > best.pct) best = u;
  }

  return { worstUnitId: worst.unitId, spread: round1(best.pct - worst.pct) };
}

/* -------------------------------------------------------------------------- */
/* Units with nothing banked                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many of this student's units have marked work, none of which reached the pass
 * mark. This is the ACTUAL progression question on a unit-based qualification: you
 * progress by achieving units, not by averaging marks, and a respectable mean can sit
 * on top of three units with nothing banked in them.
 *
 * THE TRAP, and the reason this is not a one-liner: a unit with nothing marked yet is
 * NOT a unit without passing evidence. It is unmeasurable, and it comes out of BOTH
 * the numerator and the denominator. Counting it as unpassed would report every
 * student on a newly-started unit as failing it — which on day one of a term is
 * everybody.
 *
 * @param {Array<{unitId, pcts:number[]}>} perUnit
 */
function unpassedUnits(perUnit, config) {
  let unpassed = 0, measured = 0;

  for (const u of perUnit || []) {
    const marks = (u && u.pcts ? u.pcts : []).filter(isNum);
    if (!marks.length) continue;          // unmeasurable — dropped from both sides
    measured += 1;
    if (marks.every((p) => p < config.passThreshold)) unpassed += 1;
  }

  // Nothing marked anywhere is not "zero units unpassed". It is no evidence.
  if (!measured) return { unpassed: null, measured: 0 };
  return { unpassed, measured };
}

/* -------------------------------------------------------------------------- */
/* Attendance regularity                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How erratic attendance is week to week, as a standard deviation of weekly
 * percentages. Two students can share an overall figure while one attends steadily
 * and the other alternates full weeks with empty ones; the research is consistent
 * that the irregular pattern predicts trouble independently of the volume.
 *
 * WEEKS WITH NO MARKS ARE NOT WEEKS. A reading week, a holiday, or a unit that had no
 * timetabled sessions is not a week of nought per cent — inserting a zero for the gap
 * would manufacture volatility out of a term calendar. Only weeks the register
 * actually covers appear in the series, which is why this takes marks rather than a
 * date range.
 *
 * Null below three weeks: two points always look either perfectly steady or maximally
 * erratic, and neither is a pattern.
 */
function weeklyRegularity(marks) {
  const buckets = new Map();

  for (const m of marks || []) {
    if (!m || !isStatus(m.status) || !m.date) continue;
    // Bucket by the Monday of the mark's week. String arithmetic on a UTC midnight,
    // never a locale-sensitive Date method.
    const d = new Date(`${m.date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const dow = (d.getUTCDay() + 6) % 7;           // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
    const key = d.toISOString().slice(0, 10);

    const b = buckets.get(key) || { attended: 0, marked: 0 };
    b.marked += 1;
    if (ATTENDED.has(m.status)) b.attended += 1;
    buckets.set(key, b);
  }

  const weekly = [...buckets.values()].map((b) => (b.attended / b.marked) * 100);
  if (weekly.length < 3) return null;

  const mean = weekly.reduce((a, b) => a + b, 0) / weekly.length;
  const variance = weekly.reduce((acc, p) => acc + (p - mean) ** 2, 0) / weekly.length;
  return round1(Math.sqrt(variance));
}

/* -------------------------------------------------------------------------- */
/* Engagement recency                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The most recent date this student did ANYTHING the college can see — turned up,
 * had work marked, or spoke to somebody.
 *
 * This is the single strongest thing the database can answer today, because every
 * input is populated by a real write path rather than an integration that may never
 * have run. It is also the regulator's definition of engagement rather than
 * attendance: a sponsoring provider must evidence academic engagement, and a student
 * who is not in class but is submitting work is engaged.
 *
 * Null when nothing has ever happened. Never an epoch date, and never "9999 days" —
 * a student who enrolled on Monday has no engagement history, and a very large
 * number would sort them to the top of exactly the list they do not belong on.
 */
function engagementRecency(dates) {
  const d = dates || {};
  const known = [d.lastAttendedOn, d.lastGradedOn, d.lastPastoralOn].filter(Boolean);
  if (!known.length) return null;
  return known.reduce((max, cur) => (cur > max ? cur : max));
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today        {string}   YYYY-MM-DD, passed in rather than read from a clock
 *   marks        {Array<{date, status}>}  every mark in scope, any order
 *   recent       {{pct, marked}}  the rolling window, as summariseAttendance returns it
 *   prior        {{pct, marked}}  the window immediately before it, same length
 *   dueUnmarked  {Array<{dueDate}>}  work past its deadline with no submission record
 *   gradeDates   {Array<string|null>}  gradedOn per grade, oldest first
 * @param {object} config - a complete config from settings.get()
 * @returns {{absenceStreak, lastAttendedOn, oldestUnmarkedDueDate, attendanceSlope, codes}}
 */
function evaluate(raw, config) {
  const today = raw.today;
  const codes = [];

  const { absenceStreak, lastAttendedOn } = attendanceShape(raw.marks || []);

  if (isNum(absenceStreak) && absenceStreak >= config.absenceStreakSessions) {
    codes.push(TRIP.ABSENCE_STREAK);
  }

  // Only meaningful for a student who HAS attended. A student with nothing but
  // absences may have enrolled yesterday, and "not seen since never" is not a fact
  // about them — it is a fact about the register.
  if (lastAttendedOn && daysBetween(lastAttendedOn, today) >= config.notSeenDays) {
    codes.push(TRIP.NOT_SEEN);
  }

  /* --- work that was due and never marked either way -------------------- */

  // A grace period, because marking takes time. Without one this fires on every
  // assessment the morning after its deadline, and a column that is always lit is a
  // column staff stop reading.
  const cutoff = shiftDays(today, -config.unmarkedGraceDays);
  let oldestUnmarkedDueDate = null;
  for (const a of raw.dueUnmarked || []) {
    const due = a && a.dueDate;
    if (!due || due > cutoff) continue;
    if (!oldestUnmarkedDueDate || due < oldestUnmarkedDueDate) oldestUnmarkedDueDate = due;
  }
  if (oldestUnmarkedDueDate) codes.push(TRIP.UNMARKED_WORK);

  /* --- attendance slope -------------------------------------------------- */

  // Two windows of the same length, so the comparison is like for like. Either
  // window being unmeasurable gives a null slope rather than a flat one: "we did not
  // look" and "nothing changed" are different findings and must not share a number.
  //
  // The minimum-marks floor exists because a window holding one register yields 0 or
  // 100 and neither is information; a slope of -100 off two single marks would be
  // the loudest signal on the screen and mean nothing at all.
  const recent = raw.recent || {};
  const prior = raw.prior || {};
  const enough = (w) => isNum(w.pct) && w.marked >= config.slopeMinMarks;

  const attendanceSlope = enough(recent) && enough(prior)
    ? round1(recent.pct - prior.pct)
    : null;

  if (attendanceSlope !== null && attendanceSlope <= -config.attendanceSlopeDrop) {
    codes.push(TRIP.ATTENDANCE_FALLING);
  }

  /* --- whether the grade trend can be believed --------------------------- */

  // The engine reads the most recent N marks against the previous N and calls the
  // difference a direction of travel. That assumes the marks are ordered in time.
  // When a tutor marks a term's work in one sitting every grade carries the same
  // gradedOn, so "recent" and "previous" are decided by the order rows were typed —
  // and a DECLINING trend off that ordering is an artefact, one that flips a red
  // indicator and can tip OVR-004 into worsening a band.
  //
  // This does not suppress the trend. It records, on the row, that the trend rests
  // on dates that cannot support it, so a member of staff arguing the case at an
  // appeal can see why.
  const dates = (raw.gradeDates || []).filter(Boolean);
  const needed = config.gradeTrendAssessmentCount * 2;
  if (dates.length >= needed && new Set(dates).size === 1) {
    codes.push(TRIP.TREND_UNRELIABLE);
  }

  /* --- a mark under the pass threshold ----------------------------------- */

  // The average grade cannot say this. A student averaging 55 with one mark of 12 has
  // a unit in trouble, and the mean reports the same 55 as somebody scoring steadily.
  // Null means nothing has been marked, which is not a clean record.
  const attainment = raw.attainment || {};
  if (isNum(attainment.failCount) && attainment.failCount >= 1) {
    codes.push(TRIP.RECENT_FAIL);
  }

  /* --- one unit going while the rest are fine ---------------------------- */

  // Deliberately a code and not a component. The overall attendance figure is not
  // WRONG for this student — it is answering "how much teaching have they had", and
  // the answer is "most of it". This answers a different question: is there one unit
  // they have quietly stopped going to. Averaging the two would destroy both.
  const dispersion = raw.dispersion || {};
  if (isNum(dispersion.spread) && dispersion.spread >= config.unitSpreadLimit) {
    codes.push(TRIP.UNIT_ABANDONED);
  }

  // Nothing banked in a unit that HAS been marked. On a unit-based qualification this
  // is the real progression question, and a comfortable average can sit on top of it.
  const banked = raw.banked || {};
  if (isNum(banked.unpassed) && banked.unpassed >= 1) {
    codes.push(TRIP.UNITS_UNPASSED);
  }

  /* --- pastoral: what the college has, and has not, done ----------------- */

  // `null` means this college does not use the pastoral module at all. That is not
  // the same as "nobody has spoken to this student", and treating it as such would
  // put every student in the institution on a contact list on the first day — which
  // is indistinguishable from having no list.
  const pastoral = raw.pastoral;
  if (pastoral) {
    if (isNum(pastoral.noShowCount) && pastoral.noShowCount >= config.noShowLimit) {
      codes.push(TRIP.NO_SHOW);
    }

    // A qualified human's judgement, surfaced rather than scored. It sits beside the
    // number instead of inside it so that when the two disagree — a tutor saying At
    // Risk over a comfortable score — the disagreement is visible rather than averaged
    // into invisibility.
    if (pastoral.progress === "At Risk") codes.push(TRIP.TUTOR_AT_RISK);

    // THE COLLEGE'S FAILING, NOT THE STUDENT'S. Contemplating withdrawal is strongly
    // linked to low one-to-one contact with staff, and the college is the party that
    // can fix that. Unlike attendance, absence of a record here IS the finding: every
    // conversation that happens gets logged, so no log means no conversation.
    const never = !pastoral.lastContactOn;
    if (never || daysBetween(pastoral.lastContactOn, today) >= config.staleContactDays) {
      codes.push(TRIP.NO_PASTORAL_CONTACT);
    }
  }

  return { absenceStreak, lastAttendedOn, oldestUnmarkedDueDate, attendanceSlope, codes };
}

module.exports = {
  evaluate, attendanceShape, attendanceQuality, attainmentShape, engagementRecency,
  unitDispersion, unpassedUnits, weeklyRegularity,
  TRIP, TRIP_CODES,
};
