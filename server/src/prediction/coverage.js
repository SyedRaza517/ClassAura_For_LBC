// Coverage: how much do we actually KNOW about this student, and is the attendance
// percentage we are about to print worth anything?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments, today's
// date included — the same seam as tripwires.js and engine.js, and for the same
// reason: these are lines a college will be asked to defend at an appeal, so they
// have to be checkable without standing up an institution's worth of fixtures.
//
// WHY THIS LAYER EXISTS AT ALL.
//
// `overallAttendance` is earned points over available points across the sessions a
// student was MARKED for (see attendance.js — unmarked sessions are deliberately
// excluded so an untaken register cannot drag a figure down). That exclusion is
// right, and it has a consequence nobody sees on the screen: the percentage says
// nothing about how much was excluded.
//
//   Student A: 3 sessions marked, 3 present            -> 100%
//   Student B: 60 sessions marked, 57 present          -> 95%
//
// Those two numbers appear in the same column, sort against each other, and feed the
// same weighted component at the same weight. One rests on sixty observations and the
// other on three. Sorted descending, A is above B, and A is above B on no evidence.
//
// Worse, and this is the case the module is really for: A may have had SIXTY sessions
// timetabled, with the register taken three times. The other fifty-seven are not
// absences and they are not attendances — they are a tutor who did not take a
// register. That is a fact about the COLLEGE, and today it is displayed, sorted and
// scored as a fact about the STUDENT.
//
// WHY NOTHING HERE MOVES THE SCORE.
//
// Two of the three codes below describe STAFF PRACTICE, not the student. Scoring a
// student down because their lecturer does not take registers would be indefensible
// at an appeal, and scoring them UP for the same reason is what happens today. So
// this behaves like markingLatencyDays on StudentPredictionCurrent — "a STAFF signal
// reported beside the score rather than inside it", in the schema's own words — and
// the only thing it does to the number is REMOVE it when it cannot be supported.
//
// WHY THE CODES ARE NAMESPACED `TRIP_`.
//
// They are appended to `riskDriverCodes`, the same array engine.js builds from its six
// RED indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band
// — is derived by engine.js from its own internal `reds` array, and `riskDriverCodes`
// is a copy taken afterwards, so appending here provably cannot reach the override.
// The prefix is what keeps that visible: a code named `RED_`-anything would read as
// the engine's own, and the next person to take a count off the copy would silently
// wire register-keeping into a student's band. Keep the prefix; keep the count off
// the copy.
const { isStatus } = require("../attendance");

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so
// these strings outlive several rewrites of the screen. Structured codes, never
// display text — the client maps them to wording, and rewording must not orphan a
// stored row.
const COVERAGE = {
  // ABOUT THE DATA. The percentage rests on too few observations to be reported, so
  // it has been withheld. It exists so the blank cell reads as "not enough register
  // data" rather than as a bug: a column that is empty for no stated reason gets
  // filled in by whoever is looking at it, usually with the worst assumption.
  ATTENDANCE_UNRELIABLE: "TRIP_ATTENDANCE_UNRELIABLE",
  // ABOUT THE COLLEGE. Sessions were timetabled for this student and the register was
  // not taken in most of them. Named for what happened rather than for the student —
  // "TRIP_LOW_ATTENDANCE_DATA" would read on the caseload as something they did.
  REGISTER_NOT_TAKEN: "TRIP_REGISTER_NOT_TAKEN",
  // ABOUT THE COLLEGE. Sessions have run since the last time anybody marked this
  // student either way. Not "the student has not attended" — that is TRIP_NOT_SEEN in
  // tripwires.js and it is a finding about them. This one is about us.
  REGISTER_STALE: "TRIP_REGISTER_STALE",
};

const COVERAGE_CODES = Object.values(COVERAGE);

// Confidence levels. Strings rather than numbers because they are a vocabulary the
// client renders, and because a 0-1 "confidence score" would be averaged into
// something by somebody within the year — which is exactly the move this module
// exists to prevent.
const CONFIDENCE = { NONE: "none", LOW: "low", MODERATE: "moderate", HIGH: "high" };

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Platform defaults, in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and a config key that nothing reads is worse than no
// key at all. Every function takes an `opts`/`config` that is spread OVER these, so
// the day these move into DEFAULTS the callers do not change.
const COVERAGE_DEFAULTS = {
  // THE FLOOR AT WHICH A PERCENTAGE MAY BE PRINTED AT ALL.
  //
  // With five marks each observation is worth twenty percentage points. The default
  // band ladder is fifteen points wide (85 / 70 / 55 / 40), so at five marks a single
  // register moves a student more than a whole band — the figure is not a measurement
  // of the student, it is a measurement of how many times somebody opened the
  // register. Six is also in line with the floors this codebase already carries for
  // narrower questions: slopeMinMarks 3 for one rolling window, disperseMinMarks 4 for
  // one unit. The overall figure spans every unit in scope, so its floor is higher
  // than either.
  minMarksForRate: 6,

  // THE POINT AT WHICH THE FIGURE STOPS WOBBLING ACROSS BANDS.
  //
  // At twelve observations one mark is worth 8.3 points, which is less than the
  // fifteen-point width of the narrowest default band — so a single register can no
  // longer walk a student from one risk level to the next. That is the arithmetic
  // reason for the number, and it is why it is expressed against the band ladder
  // rather than picked for looking round.
  confidentMarks: 12,

  // The fewest TIMETABLED sessions before a coverage percentage means anything. One
  // scheduled session with no mark reads 0% coverage, and 0% coverage is an accusation
  // about a college's register-keeping drawn from a single row. Same guard as
  // disperseMinMarks, same value, for the same reason.
  minScheduledForCoverage: 4,

  // AT OR BELOW THIS SHARE OF SESSIONS CARRYING A MARK, THE REGISTER IS A FINDING.
  //
  // Set deliberately low — two sessions in five unrecorded — and the reason is a data
  // shape this module cannot see. HndSession carries an `audience` field ("All
  // students", or a named group), so some scheduled sessions legitimately do not apply
  // to every student on the unit. The caller is expected to filter by audience, and
  // when it does not, a tighter limit here would silently convert that filtering
  // mistake into an accusation about staff. A conservative limit misses some genuine
  // gaps; a tight one manufactures institutional findings out of a join.
  lowCoverageLimit: 60,

  // Days since anybody marked this student ANY status before that is worth reporting.
  //
  // Longer than notSeenDays (14), and the ordering is deliberate rather than
  // incidental: notSeenDays is about the student, this is about the register, and if
  // this fired first then every disappeared student would also generate a staff
  // finding and the caseload would carry two rows for one event. Three teaching weeks
  // also cannot be explained away — a fortnight can be a reading week plus a bank
  // holiday at almost any college; three weeks with sessions timetabled in them cannot.
  staleRegisterDays: 21,

  // Mirrors settings.DEFAULTS.settlingInWeeks so this module is usable on its own; a
  // config spread over these replaces it with the college's own value.
  settlingInWeeks: 3,
};

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Whole days between two YYYY-MM-DD dates, `to` minus `from`, or NULL if either date
 * cannot be parsed.
 *
 * DELIBERATELY NOT tripwires.daysBetween, which returns 0 for an unparseable date.
 * Zero is the right shrug there — it makes a code fail to fire, which is silence. Here
 * zero would mean "marked today", which is the strongest possible reassurance about a
 * register nobody can date, and it would be produced by a bad string rather than by
 * evidence. Same class of error as reporting 0 marking latency for a college that
 * recorded no dates.
 */
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a coverage question without an institution-wide answer to
 * "does this college schedule sessions ahead of taking the register at all?"
 *
 * WHY THIS THROWS INSTEAD OF DEFAULTING TO SILENCE.
 *
 * CLAUDE.md records this as the most repeated bug in this area, got wrong three times:
 * "does this college record this at all" is an institution-wide question, and it keeps
 * being answered from the chunk in front of the code. gather() runs on chunks of 200,
 * and the ordinary incremental path scores the handful of students markStale flagged —
 * often exactly one. Every fact this module needs is invisible at that size.
 *
 * The existing guards in tripwires.js take a boolean that defaults to falsy and fall
 * silent when it is missing. That is right for them: a missing flag there costs one
 * code that does not fire. Here a missing flag would cost the whole feature, silently
 * and permanently — coverage would be null for every student at every college, no test
 * would fail, no row would look wrong, and the signal would simply never appear. A
 * feature that quietly does nothing is not discoverable by reading the output.
 *
 * So this fails the way db.js fails a query with no tenant context: loudly, at the
 * first call, in the caller's own test run. A TypeError at wiring time is recoverable;
 * three years of blank columns nobody questioned is not.
 *
 * WHAT THE FLAG ACTUALLY HAS TO MEAN, because the obvious probe is wrong.
 *
 * In this schema the register IS the session: AttendanceMark.sessionId is NOT NULL and
 * points at HndSession. So `count(HndSession) > 0` is true at every college that has
 * ever taken a register, and it answers nothing. If a college's sessions only ever
 * come into existence at the moment somebody takes a register — generated on the fly
 * rather than published from a timetable — then the scheduled set and the marked set
 * are THE SAME ROWS, coverage is 100% by construction for every student in the
 * institution, and the module reports a spotless register-keeping record it has not
 * measured. That is the mirror image of the failure it was written for: manufactured
 * reassurance instead of manufactured alarm, and it is the harder one to notice.
 *
 * The probe therefore has to establish that a session CAN exist without a mark:
 *
 *   at least one HndSession in this tenant, any unit, any date, with no AttendanceMark
 *   rows at all
 *
 * run once per batch, unfiltered by student, hoisted out of the chunk loop. One
 * student with no unmarked sessions is ordinary. A college with none has no timetable
 * this module can measure against, and every code that depends on coverage must fall
 * silent rather than report 0% or 100%.
 *
 * @param {{timetableRecorded:boolean}} institution
 */
function assertInstitutionProbe(institution, fnName) {
  if (!institution || typeof institution.timetableRecorded !== "boolean") {
    throw new TypeError(
      `${fnName}: institution.timetableRecorded must be a boolean — an institution-wide ` +
      "probe result, decided once per run and never derived from one student's rows",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Register coverage — the missing denominator                                 */
/* -------------------------------------------------------------------------- */

/**
 * What fraction of the sessions this student should have been marked in actually
 * carries a mark.
 *
 * THE DISTINCTION THIS EXISTS TO DRAW: "the student was not there" and "nobody wrote
 * it down" are indistinguishable if you count only marks, because both produce the
 * same absence of a row. Only the scheduled side separates them, which is why this
 * takes two arrays and not one.
 *
 * ZERO SCHEDULED SESSIONS IS NOT ZERO PER CENT COVERAGE. It is an unanswerable
 * question, and it returns null: a student whose units have no sessions in scope has
 * nothing their register could have failed to cover.
 *
 * @param {Array<{id, date}>} scheduledSessions  every session in scope this student
 *        should have been marked in, already filtered by unit, date scope and audience
 * @param {Array<{sessionId, status}>} marks  this student's marks, any order
 * @param {{timetableRecorded:boolean}} institution  see assertInstitutionProbe
 * @param {{minScheduledForCoverage}} [opts]
 * @returns {{scheduled:number|null, marked:number, coverageRate:number|null, usable:boolean}}
 */
function registerCoverage(scheduledSessions, marks, institution, opts) {
  assertInstitutionProbe(institution, "registerCoverage");
  const cfg = { ...COVERAGE_DEFAULTS, ...(opts || {}) };

  // A row with an unrecognised status is not a register having been taken; it is a
  // row. isStatus is the same filter attendance.summarise() applies before counting
  // anything, so the two sides of any comparison a caller makes stay in step.
  const known = (marks || []).filter((m) => m && isStatus(m.status));

  // Deduped by session. The unique constraint on (sessionId, studentId) makes a
  // duplicate impossible in the database, but the caller may have concatenated two
  // overlapping fetches, and a duplicate would push the numerator above the
  // denominator and print coverage over 100% — a number that would be read as a bug in
  // the arithmetic rather than as a bug in the fetch.
  const markedIds = new Set();
  let unattributable = 0;
  for (const m of known) {
    if (m.sessionId) markedIds.add(m.sessionId);
    else unattributable += 1;
  }

  const scheduledIds = new Set();
  for (const s of scheduledSessions || []) {
    if (s && s.id) scheduledIds.add(s.id);
  }

  // THE INSTITUTION GUARD. Not 0%, not 100% — null. See assertInstitutionProbe for why
  // this cannot be decided from the arrays in front of us.
  if (!institution.timetableRecorded) {
    return { scheduled: null, marked: markedIds.size + unattributable, coverageRate: null, usable: false };
  }

  // A mark that cannot be tied to a session cannot be reconciled against the scheduled
  // set. AttendanceMark.sessionId is NOT NULL, so this is defensive rather than
  // expected — it catches a caller that passed a summarised counts object, or marks
  // reshaped by an importer. Counting such marks as missing would report a college with
  // a perfect register as having taken none of it, which is the worst output this
  // module can produce, so an unreconcilable input yields no figure at all.
  if (unattributable) {
    return { scheduled: null, marked: markedIds.size + unattributable, coverageRate: null, usable: false };
  }

  const scheduled = scheduledIds.size;
  let markedInScope = 0;
  for (const id of scheduledIds) if (markedIds.has(id)) markedInScope += 1;

  // Marks for sessions OUTSIDE the scheduled set are ignored rather than treated as an
  // error. A student who transferred units mid-term legitimately carries marks for
  // sessions that are no longer in their scope, and refusing to answer for them would
  // withhold coverage from exactly the students whose record is most disrupted. The
  // cost is that a caller who fetches sessions for every unit and marks for one will
  // see falsely low coverage; that is a scope mismatch in the caller and it is stated
  // in the parameter docs rather than guessed at here.

  // THE FLOOR. The count is a fact and is returned either way; only the RATE is
  // withheld, because a percentage over three scheduled sessions is a claim about a
  // college's practice drawn from three rows.
  if (scheduled < cfg.minScheduledForCoverage) {
    return { scheduled, marked: markedInScope, coverageRate: null, usable: false };
  }

  return {
    scheduled,
    marked: markedInScope,
    coverageRate: round1((markedInScope / scheduled) * 100),
    usable: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Confidence — should this percentage be reported at all?                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether a percentage built on this many observations should be printed, and how
 * firmly.
 *
 * THIS ONE TAKES NO INSTITUTION PROBE, and the asymmetry is worth stating because the
 * next person will wonder. "How many times was this student marked" is a fact about
 * the student, answerable from their own rows, and one student having three marks
 * says nothing about the college. "Was a register taken" is not: one student with no
 * unmarked sessions is ordinary, a college with none has no timetable. The guard
 * belongs where the question is institution-wide and nowhere else — a probe threaded
 * through every function "for consistency" teaches the next reader that it is
 * ceremony, and then it gets dropped from the one place it was load-bearing.
 *
 * NOT REPORTABLE MEANS NULL, AND NULL IS THE WHOLE POINT. See sanitise() below: the
 * caller must delete the figure, not soften it, not clamp it, and above all not
 * replace it with 0. Zero attendance puts a student at the top of every risk list in
 * the building for something nobody measured.
 *
 * @param {number|null} markCount  how many marks the percentage was computed from
 * @param {{minMarksForRate, confidentMarks}} [opts]
 * @returns {{observations:number|null, level:string|null, reportable:boolean}}
 */
function confidence(markCount, opts) {
  const cfg = { ...COVERAGE_DEFAULTS, ...(opts || {}) };

  // An UNKNOWN count is not a count of nought. A caller that could not establish how
  // many marks a figure rests on has told us nothing, and "none" would be a claim.
  // Reportable is false either way, so the fail-safe direction is identical; the two
  // are distinguished so a row can say which happened.
  if (!isNum(markCount) || markCount < 0) {
    return { observations: null, level: null, reportable: false };
  }

  const observations = Math.floor(markCount);

  // Genuinely zero observations. This one IS a zero rather than a null: nobody has
  // marked this student, and that is a measured fact about the register, not a gap in
  // what we could measure.
  if (observations === 0) return { observations, level: CONFIDENCE.NONE, reportable: false };

  // BELOW THE FLOOR. The figure exists and is arithmetically correct and must not be
  // printed. 3 present out of 3 is 100% and it is true; it is also indistinguishable
  // from 60 out of 60 in every column it appears in, and it outranks it when sorted.
  if (observations < cfg.minMarksForRate) {
    return { observations, level: CONFIDENCE.LOW, reportable: false };
  }

  if (observations < cfg.confidentMarks) {
    return { observations, level: CONFIDENCE.MODERATE, reportable: true };
  }

  return { observations, level: CONFIDENCE.HIGH, reportable: true };
}

/**
 * The rule from trap one, in one place so it cannot be re-implemented differently in
 * two: a percentage that is not reportable becomes NULL.
 *
 * Not 0 (top of every risk list, for a measurement nobody took), not clamped to a
 * neutral 50 (a fabricated observation, and it would sit in the same column as real
 * ones), not left alone with a flag beside it (every consumer that forgets to read the
 * flag gets the wrong number, and the flag is the thing most likely to be dropped in a
 * serialiser). The figure goes. Nullability on both StudentPredictionCurrent and
 * StudentPredictionHistory is what makes that storable, and schema-contract.test.js is
 * what enforces it.
 */
function sanitise(pct, conf) {
  if (!conf || !conf.reportable) return null;
  return isNum(pct) ? pct : null;
}

/* -------------------------------------------------------------------------- */
/* Staleness — pure day arithmetic                                             */
/* -------------------------------------------------------------------------- */

/**
 * How long since anybody marked this student anything.
 *
 * TODAY IS AN ARGUMENT AND THERE IS NO CLOCK IN THIS FILE. src/clock.js pins
 * APP_TIMEZONE precisely because the host clock is not the college's day — a register
 * taken at 23:30 in London is a different date on a server in UTC-5, and a module that
 * called `new Date()` would report a different answer depending on which machine ran
 * the batch. The caller resolves the date once, in the college's own zone.
 *
 * `lastMarkOn` IS ANY MARK, NOT AN ATTENDANCE. This is the distinction the whole
 * module rests on and it is the opposite of tripwires.attendanceShape, whose
 * lastAttendedOn counts only P and L. A student marked Absent every day for a month
 * has a perfectly fresh register and a terrible attendance record; a student marked
 * Present daily until a tutor stopped opening the register has an excellent attendance
 * record and no register at all. Those are opposite findings that need opposite
 * actions, and reading one date for both questions collapses them.
 *
 * THE DAY COUNT IS A SNAPSHOT AND MUST NOT BE STORED. CLAUDE.md is explicit: nothing
 * in this feature runs on a schedule, markStale() fires on data events, and a day
 * passing is not an event — so "21 days since the last mark" written to a column is
 * wrong by the next morning with nothing to correct it. `lastMarkOn` is true forever.
 * The count is returned so a code can be decided at calculation time; the DATE is what
 * a caller stores, and the screen subtracts.
 *
 * @param {string|null} lastMarkOn  YYYY-MM-DD, or null if never marked
 * @param {string} today  YYYY-MM-DD, in the college's zone
 * @param {{staleRegisterDays}} [opts]
 * @returns {{lastMarkOn:string|null, daysSinceLastMark:number|null, stale:boolean|null}}
 */
function staleness(lastMarkOn, today, opts) {
  const cfg = { ...COVERAGE_DEFAULTS, ...(opts || {}) };

  // NEVER MARKED IS NULL, NOT A VERY LARGE NUMBER, and `stale` is null rather than
  // true. A student enrolled on Monday has no last mark, and a register that has never
  // been taken has not gone stale — it has not started. Answering `true` here would
  // put a whole intake on a staff caseload on day one; answering 9999 days would sort
  // them to the top of it.
  if (!lastMarkOn) return { lastMarkOn: null, daysSinceLastMark: null, stale: null };

  const days = daysBetween(lastMarkOn, today);

  // An unparseable date is unknown, not current. Zero would read as "marked today",
  // which is the strongest reassurance in this module produced by a malformed string.
  if (days === null) return { lastMarkOn, daysSinceLastMark: null, stale: null };

  // A NEGATIVE GAP IS RETURNED AS IT IS, and there is deliberately no branch for it.
  // Two clocks feed these dates — the college's zone and whatever the importer used —
  // and a session marked in advance is legitimate besides. Clamping to 0 would claim
  // the register was taken today, which is a stronger statement than the data supports;
  // the comparison below already answers the only question that matters, because a
  // register dated in the future is certainly not one nobody has opened for three weeks.
  // A guard here would be behaviourally identical to this line and could not be tested,
  // which is its own small trap: an untestable branch is one a later reader trusts.
  return { lastMarkOn, daysSinceLastMark: days, stale: days >= cfg.staleRegisterDays };
}

/** The most recent date carrying a mark of ANY valid status. Null when there are none —
 *  never an epoch date, which would sort a never-marked student to the top of a list of
 *  neglected registers on no evidence at all. */
function lastMarkDate(marks) {
  let latest = null;
  for (const m of marks || []) {
    if (!m || !isStatus(m.status) || !m.date) continue;
    if (!latest || m.date > latest) latest = m.date;
  }
  return latest;
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today              {string} YYYY-MM-DD, passed in rather than read from a clock
 *   overallAttendance  {number|null} the figure the engine computed, to be withheld
 *                      here if it cannot be supported
 *   marks              {Array<{sessionId, date, status}>} every mark in scope, any order
 *   scheduledSessions  {Array<{id, date}>} every session in scope the student should
 *                      have been marked in
 *   weeksIntoProgramme {number|null} for the settling-in exemption
 *   institution        {{timetableRecorded:boolean}} the institution-wide probe; see
 *                      assertInstitutionProbe. REQUIRED — this throws without it.
 * @param {object} [config] a settings config, spread over COVERAGE_DEFAULTS
 * @returns {{overallAttendance, coverageRate, scheduledSessions, markedSessions,
 *            lastMarkOn, confidence, codes}}
 */
function evaluate(raw, config) {
  const cfg = { ...COVERAGE_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller that forgot the probe finds out on their
  // first fixture rather than after a term of blank columns.
  assertInstitutionProbe(input.institution, "evaluate");

  const codes = [];
  const marks = (input.marks || []).filter((m) => m && isStatus(m.status));

  const cover = registerCoverage(input.scheduledSessions || [], marks, input.institution, cfg);
  const conf = confidence(marks.length, cfg);
  const lastMarkOn = lastMarkDate(marks);
  const fresh = staleness(lastMarkOn, input.today, cfg);

  // TRAP ONE, ENFORCED UNCONDITIONALLY AND BEFORE THE EXEMPTION BELOW.
  //
  // The settling-in exemption suppresses CODES. It must never suppress this. In week
  // one every student has two or three marks, and muting the null would print 100%
  // attendance across a whole intake — a wall of figures that look like measurements
  // and are not, at the exact moment staff are forming their impression of the cohort.
  // The code is noise in week one; the number is a lie in week one.
  const overallAttendance = sanitise(input.overallAttendance, conf);

  // THE SETTLING-IN EXEMPTION, and it exists to SUPPRESS rather than to find.
  //
  // All three codes here fire on the ABSENCE of a record — too few marks, too few
  // registers taken, no recent register — which is precisely the class CLAUDE.md
  // describes: in week one nobody has attendance history, and a caseload containing the
  // whole intake is the same as no caseload. None of the three is like ABSENCE_STREAK
  // or FOLLOWUP_MISSED, which fire on the PRESENCE of evidence and are correctly left
  // outside the grace.
  //
  // AN UNKNOWN PROGRAMME AGE IS DELIBERATELY NOT EXEMPT. A student whose cohort has no
  // start date and no terms cannot be placed on a calendar, and muting every code for
  // them fails safe in the wrong direction — silence about the students the timetable
  // already cannot account for. `isNum` is what makes null fall through to "not exempt"
  // rather than to "brand new".
  const weeks = input.weeksIntoProgramme;
  const settlingIn = isNum(weeks) && weeks < cfg.settlingInWeeks;

  /* --- the figure cannot be supported ------------------------------------- */

  // Fires whenever the figure was withheld, including for a student with no marks at
  // all. It is the label on the blank cell, not an accusation.
  if (!settlingIn && !conf.reportable) codes.push(COVERAGE.ATTENDANCE_UNRELIABLE);

  /* --- the register was not taken ----------------------------------------- */

  // ABOUT STAFF. `usable` already carries both guards — the institution probe and the
  // minimum scheduled count — so an unknown coverage falls silent here rather than
  // reading as 0%.
  //
  // AND THERE IS DELIBERATELY NO "COVERAGE UNKNOWN" CODE. It is the obvious next
  // addition and it is the mass-alarm failure in a fresh disguise: at a college that
  // does not publish a timetable it would fire for every student in the institution on
  // every run, saying nothing about any of them. Unknown is silence.
  if (!settlingIn && cover.usable && isNum(cover.coverageRate)
      && cover.coverageRate <= cfg.lowCoverageLimit) {
    codes.push(COVERAGE.REGISTER_NOT_TAKEN);
  }

  /* --- nobody has opened the register since --------------------------------- */

  // ABOUT STAFF, and it needs BOTH sides to say so. A student's last mark being three
  // weeks old is only a staff finding if sessions actually ran in those three weeks:
  // without the scheduled side, a reading week, the end of a term, a unit that finished
  // and a tutor who stopped taking the register are one indistinguishable shape, and
  // firing on it would light up every student in the college during every holiday.
  //
  // So this asks for a session timetabled AFTER the last mark and not in the future,
  // which is a positive piece of evidence that something happened and was not recorded.
  // At a college with no timetable to compare against it can never fire — accepted, and
  // preferable to a code that means "term ended" for two thirds of the year.
  const sessionsSinceLastMark = input.institution.timetableRecorded && lastMarkOn
    ? (input.scheduledSessions || []).filter(
        (s) => s && s.date && s.date > lastMarkOn && s.date <= input.today,
      ).length
    : 0;

  if (!settlingIn && fresh.stale === true && sessionsSinceLastMark >= 1) {
    codes.push(COVERAGE.REGISTER_STALE);
  }

  return {
    // The sanitised figure — null wherever it could not be supported. The caller stores
    // THIS, not the one it passed in.
    overallAttendance,
    coverageRate: cover.coverageRate,
    scheduledSessions: cover.scheduled,
    markedSessions: cover.marked,
    // A DATE, not a day count. See staleness() for why the count is not stored.
    lastMarkOn,
    confidence: conf.level,
    observations: conf.observations,
    codes,
  };
}

module.exports = {
  evaluate,
  registerCoverage,
  confidence,
  sanitise,
  staleness,
  lastMarkDate,
  COVERAGE,
  COVERAGE_CODES,
  CONFIDENCE,
  COVERAGE_DEFAULTS,
};
