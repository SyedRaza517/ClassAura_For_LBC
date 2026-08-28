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
  CHRONIC_LATE: "TRIP_CHRONIC_LATE",
  REPEAT_CONCERN: "TRIP_REPEAT_CONCERN",
  // Institutional: an intervention nobody went back to.
  REVIEW_OVERDUE: "TRIP_REVIEW_OVERDUE",
  // Institutional: a question the student asked and nobody answered.
  QUERY_UNANSWERED: "TRIP_QUERY_UNANSWERED",
  // Institutional: the engine flagged this student and nobody went.
  CONTACT_DEFICIT: "TRIP_CONTACT_DEFICIT",
  // Institutional: a follow-up the college promised and did not hold.
  FOLLOWUP_MISSED: "TRIP_FOLLOWUP_MISSED",
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
 * @param {{lateRecorded:boolean, excusedRecorded:boolean}} opts  what this college
 *        records AT ALL — both are institution-level facts, not student ones.
 */
function attendanceQuality(counts, opts) {
  const c = counts || {};
  const absences = (c.A || 0) + (c.E || 0);

  // Two guards, not one.
  //
  // A student with no absences has no absence to characterise. Zero would read as
  // "all of their absences were authorised", which is a claim about absences that do
  // not exist, and it would sit on the screen looking like a finding.
  //
  // AND: a college whose register has no "E" — the Moodle importer maps statuses by
  // acronym, so a plugin without an excused code produces zero E rows institution-wide
  // — makes every absent student read as 100% unexplained. That is the mirror image of
  // the lateness trap below and it errs the other way: it manufactures alarm rather
  // than reassurance. Same institution-level question, same null answer.
  // AND A MINIMUM DENOMINATOR, like every other rate in this file. One unexcused
  // absence reads 100%, and the screen renders "Absence unexplained — 100%": a pattern
  // claimed from a single data point. slopeMinMarks, disperseMinMarks,
  // lateSubmissionMinPieces and the two-mark floor on volatility are all this same
  // guard; this one was written without it.
  const floor = (opts && opts.minAbsences) || 1;
  const unexplainedShare = opts && opts.excusedRecorded && absences >= floor
    ? round1(((c.A || 0) / absences) * 100)
    : null;

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
/* Handing work in late                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How much of this student's marked work arrived after its deadline, and by how far.
 *
 * WHY THIS READS GRADES RATHER THAN SUBMISSIONS. The obvious source is
 * AssessmentSubmission.submittedOn — but nothing in this codebase writes that table,
 * so it is empty everywhere. AssessmentGrade.submittedAt is populated by the Moodle
 * importer and carries the same fact for work that has been MARKED. That is a biased
 * sample (unmarked work is invisible here) and the bias is stated rather than hidden.
 *
 * The importer truncates Moodle's timestamp to a date, so this is day resolution.
 * "Handed in four days late" is answerable; "handed in eleven minutes before the
 * deadline" is not, and never will be from this data — the time is discarded at the
 * boundary rather than merely unqueried.
 *
 * @param {Array<{submittedOn, dueDate}>} marked
 * @param {{submittedOnRecorded:boolean}} opts  whether the feed carries dates AT ALL
 */
function submissionTiming(marked, opts) {
  // The institution guard again, third of its kind. If nothing anywhere carries a
  // submission date, "0% late" describes the integration rather than the students.
  // gradedWithDates is NULL here, not 0. This branch returns before counting anything,
  // because the institution carries no submission dates at all — so a stored 0 would
  // say "we counted and found none" about a sample nobody looked at. The migration
  // that added the column says exactly this.
  if (!opts || !opts.submittedOnRecorded) {
    return { lateRate: null, meanDaysLate: null, gradedWithDates: null };
  }

  let onTime = 0, late = 0, totalDaysLate = 0;

  for (const g of marked || []) {
    // Both halves required. No deadline means nothing to be late against; no arrival
    // date means we do not know when it came, which is not the same as on time.
    if (!g || !g.submittedOn || !g.dueDate) continue;
    const days = daysBetween(g.dueDate, g.submittedOn);
    if (days > 0) { late += 1; totalDaysLate += days; } else { onTime += 1; }
  }

  const n = onTime + late;
  if (!n) return { lateRate: null, meanDaysLate: null, gradedWithDates: 0 };

  return {
    lateRate: round1((late / n) * 100),
    // The denominator here is the LATE pieces, so with none the mean is undefined
    // rather than zero. A stored 0 is indistinguishable on the row from a real mean of
    // nought days, which cannot occur — being late by zero days is the definition of
    // on time.
    meanDaysLate: late ? round1(totalDaysLate / late) : null,
    // Returned so the caller can refuse to draw a conclusion from one assignment, and
    // so the figure behind a percentage is visible at an appeal.
    gradedWithDates: n,
  };
}

/* -------------------------------------------------------------------------- */
/* The same concern, raised twice                                              */
/* -------------------------------------------------------------------------- */

/**
 * Concerns a tutor has raised in more than one review.
 *
 * One review saying "Attendance" is a conversation. Two separate reviews saying it is
 * an unresolved problem, and the difference is the whole signal — the engine's own
 * figures cannot see it because they are about the student's data, not about what
 * staff have already noticed and said out loud.
 *
 * "NO CONCERNS" IS A MEMBER OF THE ALLOWLIST, not an empty array. A naive count turns
 * the strongest reassurance in the dataset into a warning, and two clean reviews would
 * read as a repeated concern. It is stripped before anything else happens.
 *
 * WINDOWED, because every other pastoral signal here is. Read over a whole programme
 * this never clears: a concern raised twice in the first term stays on the row for two
 * more years, and no number of subsequent clean reviews can lift it — "No Concerns" is
 * stripped before counting, so the only evidence of resolution is invisible to it.
 *
 * @param {Array<{date, concerns:string[]}>} perReview
 * @param {string|null} since  YYYY-MM-DD; reviews older than this are not counted
 */
function repeatConcerns(perReview, since) {
  const list = (perReview || []).filter((r) => r && (!since || !r.date || r.date >= since));
  if (!list.length) return { repeated: null, reviewsWithConcerns: 0 };

  const seen = new Map();
  let reviewsWithConcerns = 0;

  for (const entry of list) {
    const raw = entry.concerns;
    // Deduped WITHIN a review: the same concern twice on one form is one concern, and
    // counting it twice would let a single review manufacture a repeat.
    const concerns = [...new Set((raw || []).filter((c) => c && c !== "No Concerns"))];
    if (concerns.length) reviewsWithConcerns += 1;
    for (const c of concerns) seen.set(c, (seen.get(c) || 0) + 1);
  }

  return {
    repeated: [...seen.entries()].filter(([, n]) => n >= 2).map(([c]) => c).sort(),
    reviewsWithConcerns,
  };
}

/* -------------------------------------------------------------------------- */
/* Questions the college has not answered                                      */
/* -------------------------------------------------------------------------- */

/**
 * The oldest question this student asked that nobody has answered.
 *
 * THE COLLEGE'S FAILING, NOT THE STUDENT'S. A student who used the one channel the
 * college gave them and got silence back is the clearest evidence in the dataset of
 * an institution failing a person, and no weighted mean of their attendance can
 * express it.
 *
 * A DATE, NOT A DAY COUNT, like everything else here.
 *
 * @param {Array<{createdOn, status, respondedAt}>} queries  createdAt already
 *        truncated to the college's own zone by the caller
 * @param {{repliesRecorded:boolean}} opts
 */
function queryBacklog(queries, opts) {
  const list = (queries || []).filter(Boolean);

  // THE INSTITUTION GUARD, one level in from the obvious one. A college with no
  // queries produces no open queries and cannot fire, so that case needs no guard.
  // The case that does: staff who read queries in the app and reply in person never
  // press Respond, so every query the college ever received sits at "open" for ever.
  // That is a fact about the workflow, not about anybody's wait, and without this the
  // code fires for the whole institution at once.
  if (!opts || !opts.repliesRecorded) return { oldestOpenQueryOn: null, openQueryCount: null };

  // NO QUERIES AT ALL IS NULL, NOT ZERO, and this is the trap. A student who sent
  // three questions and had all three answered has an open count of ZERO, and that
  // zero is real news: this college answers this person. A student who never asked
  // anything also has nothing open, and reporting 0 for them claims the college
  // answered questions that were never asked.
  if (!list.length) return { oldestOpenQueryOn: null, openQueryCount: null };

  let oldestOpenQueryOn = null;
  let openQueryCount = 0;

  for (const item of list) {
    if (item.status === "answered" || item.respondedAt) continue;
    openQueryCount += 1;
    // Still open and still counted, but it cannot be placed on a calendar and so
    // cannot be aged. Dropping it would hide a waiting student; dating it to the epoch
    // would put them top of the list on no evidence.
    if (!item.createdOn) continue;
    if (!oldestOpenQueryOn || item.createdOn < oldestOpenQueryOn) oldestOpenQueryOn = item.createdOn;
  }

  return { oldestOpenQueryOn, openQueryCount };
}

/* -------------------------------------------------------------------------- */
/* A high-risk student nobody has spoken to                                    */
/* -------------------------------------------------------------------------- */

/**
 * The college's own promise, unkept: this student sits at or below the band at which
 * somebody is supposed to make contact, and nobody has.
 *
 * WHY THE RISK LEVEL IS A PARAMETER AND NOT READ FROM THE DATABASE — which is the
 * whole reason this is not called from evaluate().
 *
 * StudentPredictionCurrent.riskLevel is stale BY CONSTRUCTION for anybody being
 * scored: a student is in this batch BECAUSE stale is true, and the row is about to be
 * overwritten by the very run asking the question. A deficit computed from it is a
 * deficit against last month's risk, and it would be worst exactly where it matters —
 * a student who has just deteriorated into the band would be measured against the
 * comfortable band they held a fortnight ago, and stay silent. So this takes the band
 * the engine produced THIS run, handed over by runner.js downstream of score().
 *
 * WHY IT MAY FIRE ALONGSIDE NO_PASTORAL_CONTACT. It may, and that is accepted rather
 * than filtered. Overlap is already how this file behaves — ABSENCE_STREAK and
 * NOT_SEEN both fire on one disappearance. These are two findings, and this one names
 * an urgency the other does not: silence around a student the college's own engine has
 * flagged is a different failure from silence around a student who is fine.
 */
function contactDeficit(state, config) {
  const s = state || {};
  const codes = [];

  // The same institution guard NO_PASTORAL_CONTACT needs. A null lastContactOn means
  // "nobody has spoken to them" OR "this college has no pastoral module", and at a
  // college of the second kind EVERY student's date is null — so a per-chunk guard
  // would look correct and be inverted.
  if (!s.pastoralRecorded) return { codes };

  // THE SETTLING-IN EXEMPTION APPLIES HERE TOO, and its absence was an oversight rather
  // than a decision. This fires on the ABSENCE of a pastoral record, which is exactly
  // the class the exemption covers — and because it runs in runner.js rather than in
  // evaluate(), it sat outside the guard that mutes NO_PASTORAL_CONTACT beside it. A
  // week-one intake scored into the band would otherwise fire on day one, which is the
  // caseload-of-everybody failure the exemption exists to prevent. An UNKNOWN programme
  // age is not exempt, for the same reason it is not exempt anywhere else.
  if (isNum(s.weeksIntoProgramme) && s.weeksIntoProgramme < config.settlingInWeeks) return { codes };

  const bands = config.bands || [];
  const at = bands.findIndex((b) => b.key === s.riskLevel);
  const threshold = bands.findIndex((b) => b.key === config.contactDeficitBand);
  // Bands run best to worst, so a higher index is worse — the comparison engine.js
  // already uses for interventionRequired. An unknown band raises nothing rather than
  // assuming the worst: a null riskLevel is a configuration fault, not a finding about
  // this student.
  if (at < 0 || threshold < 0 || at < threshold) return { codes };

  const never = !s.lastContactOn;
  if (never || daysBetween(s.lastContactOn, s.today) >= config.contactDeficitDays) {
    codes.push(TRIP.CONTACT_DEFICIT);
  }

  return { codes };
}

/* -------------------------------------------------------------------------- */
/* Promises the college made and did not keep                                  */
/* -------------------------------------------------------------------------- */

/**
 * Follow-ups this college arranged, whose date has passed by more than the grace
 * period, with nothing recording that they happened.
 *
 * INSTITUTIONAL. The student did not fail to turn up to it — that is a No Show, it is
 * already TRIP_NO_SHOW, and it is a signal about them. This one is about us.
 *
 * THE MIGRATION TRAP, and it is the sharpest in this file.
 *
 * `followUpCompletedOn` did not exist before the migration that added it, so it is
 * null on every row written earlier — for follow-ups held on the morning they fell due
 * exactly as much as for ones nobody ever made. Reading that null as "not done" would
 * put the college's entire accumulated history on the caseload the day the column
 * shipped: the same monotonic pile the column exists to end, delivered all at once.
 *
 * So the caller passes a WATERMARK: the earliest completion this college has ever
 * recorded anywhere. It is an observed lower bound on when the college became ABLE to
 * record one, and anything promised before it cannot be judged. Derived from the data
 * rather than stamped as a constant, because a constant would be a DEPLOY date and the
 * two databases are migrated on different days — a value right for one would be
 * silently wrong for the other.
 *
 * Until a college closes its first follow-up the watermark is null and this returns
 * null, exactly as latenessRate is null where the register has no "L". That will look
 * broken to whoever ships it, and somebody will be tempted to fix it with a stamped
 * date or a backfill. Both reintroduce the mass alarm this design exists to avoid.
 *
 * @param {Array<{followUpDate, followUpCompletedOn, stillFlagged}>} promises  from BOTH
 *        Interaction and StudentReview — a signal that could see only half would be
 *        worse than none, because which half depends on the screen a tutor happens to use
 * @param {string|null} closureFrom  the earliest completion this college ever recorded
 * @param {string} cutoff  YYYY-MM-DD; a promise is judged only once its date is this old
 */
function overdueFollowUps(promises, closureFrom, cutoff, since) {
  // The institution guard. Not a zero: before this college closed its first follow-up,
  // "promised and not done" and "promised, done, never written down" are the same row.
  if (!closureFrom) return { overdue: null, judged: 0 };

  let overdue = 0, judged = 0;

  for (const p of promises || []) {
    const due = p && p.followUpDate;
    if (!due) continue;               // no promise — nothing to keep
    if (due < closureFrom) continue;  // promised before a closure could be recorded
    // AND A WINDOW, which the first version did not have. Without one the count is
    // monotonic — a follow-up promised eighteen months ago and never held sits on the
    // row for the rest of the programme — which is precisely the accumulating pile this
    // signal was written to replace. TRIP_NO_SHOW and TRIP_REPEAT_CONCERN beside it are
    // both windowed for that reason, and this was written a commit later without it.
    if (since && due < since) continue;
    if (due > cutoff) continue;       // still inside the grace period
    judged += 1;
    // Retraction is not failure. A follow-up the college explicitly stood down — the
    // student withdrew, the concern resolved — was not missed, and the row still
    // carries its date so the retraction stays visible to anyone auditing the practice.
    if (!p.stillFlagged) continue;
    if (!p.followUpCompletedOn) overdue += 1;
  }

  // NOTHING JUDGEABLE IS NOT ZERO MISSED. One rule covers both a student who was never
  // promised anything and one whose only promises predate the watermark: there is no
  // evidence, so there is no figure. Exactly unpassedUnits()'s `if (!measured)`.
  if (!judged) return { overdue: null, judged: 0 };
  return { overdue, judged };
}

/* -------------------------------------------------------------------------- */
/* The weighting the engine has always ignored                                 */
/* -------------------------------------------------------------------------- */

/**
 * An average grade that respects what each piece of work is actually worth.
 *
 * `Assessment.weight` is stored, validated on the way in and displayed on the
 * assessment itself — and the engine has never read it, so a 20% quiz and a 60%
 * project count the same. The client already says so in words; this makes it a number.
 *
 * THE TRAP, AND WHY THERE IS A FLAG RATHER THAN A SILENT FALLBACK. The Moodle importer
 * never sets weight, so at a synced college EVERY assessment carries 0. Quietly
 * returning the unweighted mean there would produce a figure that LOOKS like it honours
 * the weighting and does not — which is precisely the class of failure the null-is-not-
 * zero rule exists to prevent, and it would be invisible because the number is
 * plausible. So the fallback is explicit and the row records which one it got.
 *
 * A PARTIALLY weighted set is different again. An assessment with no weight is not
 * worth nothing — it is worth an unknown amount. Averaging it in at zero would silently
 * discard a real mark, so it is excluded and counted, and the caller can see how many.
 */
function weightedGrade(marks) {
  const list = (marks || []).filter((m) => m && isNum(m.pct));
  if (!list.length) return { value: null, weighted: false, ignored: 0 };

  const weighed = list.filter((m) => isNum(m.weight) && m.weight > 0);

  // Nothing carries a weight — the ordinary state at a Moodle-synced college. Fall back
  // to the plain mean and SAY that is what happened.
  if (!weighed.length) {
    const mean = list.reduce((a, m) => a + m.pct, 0) / list.length;
    return { value: round1(mean), weighted: false, ignored: 0 };
  }

  const total = weighed.reduce((a, m) => a + m.weight, 0);
  const sum = weighed.reduce((a, m) => a + m.pct * m.weight, 0);
  return { value: round1(sum / total), weighted: true, ignored: list.length - weighed.length };
}

/* -------------------------------------------------------------------------- */
/* How long marking takes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Days between work arriving and being marked.
 *
 * A STAFF SIGNAL, NOT A STUDENT ONE, and it is reported rather than scored for exactly
 * that reason: a lecturer's backlog is not a fact about the student sitting under it.
 * It belongs beside the score as context — a student whose work is unmarked has an
 * average built on less than it appears to be.
 *
 * NULL WHEN NOTHING CAN BE TIMED, never zero. Zero reads as "marked the same day",
 * which is praise for a college that recorded no dates at all.
 *
 * A NEGATIVE GAP IS DISCARDED rather than counted. Two different clocks feed these —
 * Moodle's own date and the date the mark landed here — and the schema warns about the
 * distinction. A mark dated before its submission is a data fault, not a college that
 * marks work before it arrives, and averaging it in would drag the mean towards a
 * flattering number.
 */
function markingLatency(marked) {
  let total = 0, judged = 0;

  for (const g of marked || []) {
    if (!g || !g.submittedAt || !g.gradedOn) continue;
    const days = daysBetween(g.submittedAt, g.gradedOn);
    if (days < 0) continue;
    total += days;
    judged += 1;
  }

  if (!judged) return { meanDays: null, judged: 0 };
  return { meanDays: round1(total / judged), judged };
}

/* -------------------------------------------------------------------------- */
/* Can they get here in the morning?                                           */
/* -------------------------------------------------------------------------- */

/**
 * Absence in the first session of a teaching day, against absence in the rest of it.
 *
 * This separates "cannot get here" — transport, caring, a night shift, a commute that
 * does not work — from "not engaged". They need opposite conversations, and an overall
 * attendance percentage cannot tell them apart: both produce the same number.
 *
 * ONLY DAYS WITH MORE THAN ONE SESSION COUNT. A single-register day has no later
 * session to compare against, so it carries no information about the pattern and is
 * excluded from BOTH sides rather than counted as a first-session absence — otherwise
 * a college that timetables one session a day would report every absent student as
 * unable to get out of bed.
 */
function firstSessionAbsence(marks, config) {
  const byDay = new Map();

  for (const m of marks || []) {
    if (!m || !isStatus(m.status) || !m.date) continue;
    if (!byDay.has(m.date)) byDay.set(m.date, []);
    byDay.get(m.date).push(m);
  }

  let firstAbs = 0, firstTotal = 0, laterAbs = 0, laterTotal = 0, days = 0;

  for (const list of byDay.values()) {
    if (list.length < 2) continue;   // nothing to compare against
    days += 1;
    const ordered = [...list].sort((a, b) => (a.startTime || "") < (b.startTime || "") ? -1 : 1);
    ordered.forEach((m, i) => {
      const absent = m.status === "A";
      if (i === 0) { firstTotal += 1; if (absent) firstAbs += 1; }
      else { laterTotal += 1; if (absent) laterAbs += 1; }
    });
  }

  if (days < (config && config.minDays ? config.minDays : 3) || !firstTotal || !laterTotal) {
    return { firstSessionRate: null, laterRate: null, days };
  }

  return {
    firstSessionRate: round1((firstAbs / firstTotal) * 100),
    laterRate: round1((laterAbs / laterTotal) * 100),
    days,
  };
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
  // A query the STUDENT sent is the strongest of the four: the other three are things
  // the college did to them — a register taken, work marked, a meeting logged — and a
  // query is the one they initiated. Included for RECENCY only. How many queries a
  // student sends is deliberately not built: high volume is an engaged student or a
  // struggling one, the field that would separate them is free text this layer never
  // reads, and the count varies by an order of magnitude between colleges purely by
  // which channel each one told its students to use.
  // VLE ACCESS IS THE FIFTH, and it is the one that most changes the answer. The other
  // four all require somebody at the college to have done something -- taken a register,
  // marked work, logged a meeting, received a query. A student who has stopped coming in
  // but is opening the course and reading the material is ENGAGED, and every one of the
  // other four would report them as silent. A sponsoring provider is now required to
  // evidence academic engagement rather than attendance, and this is what answers it.
  //
  // Null when the college is not observable at all, which drops out of the filter below
  // exactly as the other four do when they are missing.
  const known = [d.lastAttendedOn, d.lastGradedOn, d.lastPastoralOn, d.lastQueryOn, d.lastVleAccessOn].filter(Boolean);
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

  // THE SETTLING-IN EXEMPTION, and it exists to SUPPRESS rather than to find.
  //
  // In week one a student has no attendance history, no marks and no pastoral record.
  // Every "we have not seen this" code would fire across the whole intake at once, and
  // a caseload containing everybody is the same as no caseload — staff stop reading it,
  // and the students who are genuinely disappearing in week nine are buried under a
  // hundred who simply started on Monday.
  //
  // An UNKNOWN age is deliberately NOT exempt. A student whose cohort has no start
  // date and no terms cannot be placed on a calendar, and muting every code for them
  // would fail safe in the wrong direction — silence about the students the timetable
  // already cannot account for.
  //
  // AND IT DOES NOT COVER ABSENCE_STREAK, which the first version of this got wrong.
  // The argument above is about codes that fire on the ABSENCE of a record. A streak is
  // not one: attendanceShape returns null when no register exists, and the code needs
  // several consecutive MARKED absences, so it cannot fire on an intake whose register
  // nobody has taken. It fires only when the register exists and says the student was
  // not there — evidence, not silence. Suppressing it hid the non-starter: somebody who
  // enrolled and never once turned up, which is precisely who a sponsoring provider has
  // to identify, inside precisely the window they have to do it in.
  const weeks = raw.weeksIntoProgramme;
  const settlingIn = isNum(weeks) && weeks < config.settlingInWeeks;

  const { absenceStreak, lastAttendedOn } = attendanceShape(raw.marks || []);

  // The grace applies only to somebody who has actually started. A new student with a
  // run of absences and no attendance at all has not settled in slowly; they have not
  // arrived, and that is the finding.
  const streakGrace = settlingIn && Boolean(lastAttendedOn);
  if (!streakGrace && isNum(absenceStreak) && absenceStreak >= config.absenceStreakSessions) {
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
  //
  // AND AN INSTITUTION GUARD, for a sharper version of the same failure. "Unmarked
  // either way" is derived from the ABSENCE of an AssessmentSubmission row — but
  // nothing in this codebase writes that table. The Canvas and Blackboard adapters
  // issue no Prisma call at all, and the Moodle importer never touches it. So at a
  // college with assessments and no submission sync, every past-due piece of work
  // looks unmarked and this fires for the entire institution at once.
  //
  // That is a fact about the integration, not about anybody's coursework. Same shape
  // of guard as lateRecorded: decided once for the batch, because ONE student having
  // no submission rows is ordinary and every student having none is a broken feed.
  const cutoff = shiftDays(today, -config.unmarkedGraceDays);
  let oldestUnmarkedDueDate = null;
  for (const a of (raw.submissionsRecorded ? raw.dueUnmarked : []) || []) {
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
  // THE SLICE MATTERS. engine.js compares the last N against the N before them and
  // reads nothing older, so testing the whole history answers a different question:
  // a student whose four most recent marks were all typed in one sitting passed as
  // reliable because three older marks happened to carry distinct dates.
  //
  // AND NULLS COUNT. A grade with no gradedOn falls back to gradedAt — the row's
  // creation timestamp — so on a first Moodle import the ordering is import order.
  // That is MORE artefactual than four marks sharing a real date, not exempt from the
  // check, so a missing date is treated as its own indistinguishable value rather than
  // filtered out before the length test.
  const needed = config.gradeTrendAssessmentCount * 2;
  const all = raw.gradeDates || [];
  if (all.length >= needed) {
    const window = all.slice(-needed).map((d) => d || "");
    if (new Set(window).size === 1) codes.push(TRIP.TREND_UNRELIABLE);
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
    if (!settlingIn && (never || daysBetween(pastoral.lastContactOn, today) >= config.staleContactDays)) {
      codes.push(TRIP.NO_PASTORAL_CONTACT);
    }

    // The same concern in two separate reviews. One is a conversation; two is a problem
    // nobody has resolved, and no figure the engine computes can see the difference.
    if ((pastoral.repeated || []).length) codes.push(TRIP.REPEAT_CONCERN);

    // A PROMISE THE COLLEGE MADE AND DID NOT KEEP. Institutional, like the contact
    // codes around it. `isNum` is what keeps the migration null out — a later reader
    // coercing it would put the whole historic backlog on the caseload at once.
    //
    // NOT muted by settlingIn, for the reason ABSENCE_STREAK is not: the exemption is
    // for codes firing on the ABSENCE of a record, and this fires on the PRESENCE of a
    // promise. A follow-up arranged in week one and missed in week two is exactly what
    // a settling-in grace must not hide — week one is when a non-starter gets one.
    if (isNum(pastoral.overdueFollowUps) && pastoral.overdueFollowUps >= 1) {
      codes.push(TRIP.FOLLOWUP_MISSED);
    }
  }

  /* --- a question nobody answered ---------------------------------------- */

  // INSTITUTIONAL, and NOT covered by the settling-in exemption. That exemption
  // suppresses codes firing on the ABSENCE of a record; this fires on the PRESENCE of
  // an unanswered one, so it belongs with ABSENCE_STREAK. A student who asked
  // something in week one and heard nothing for a fortnight is precisely who a
  // settling-in grace must not silence.
  // A FLOOR AND A CEILING. The floor is the point at which a reply is overdue; the
  // ceiling is the point past which nobody is going to answer it and a permanently-lit
  // row is one staff scroll past. Without the ceiling this is monotonic — one query
  // answered face-to-face in a first term pins the code on for the rest of the
  // programme, with no way to clear it from the prediction side.
  const queries = raw.queries || {};
  const waited = queries.oldestOpenQueryOn ? daysBetween(queries.oldestOpenQueryOn, today) : null;
  if (isNum(waited) && waited >= config.unansweredQueryDays && waited <= config.unansweredQueryCeilingDays) {
    codes.push(TRIP.QUERY_UNANSWERED);
  }

  /* --- handing work in late ---------------------------------------------- */

  // A MINIMUM DENOMINATOR, like every other rate in this file. One marked piece handed
  // in a day late reads 100%, and the screen renders that as "work is regularly handed
  // in late" — a pattern claimed from a single data point. The sample is smaller than
  // it looks: Moodle reports no submission date for anything that is not
  // submission-based, so quizzes and offline marks never reach this denominator at all.
  const timing = raw.timing || {};
  if (isNum(timing.lateRate)
      && (timing.gradedWithDates || 0) >= config.lateSubmissionMinPieces
      && timing.lateRate >= config.lateSubmissionLimit) {
    codes.push(TRIP.CHRONIC_LATE);
  }

  /* --- an intervention nobody went back to -------------------------------- */

  // INSTITUTIONAL. The college agreed a date to look again and the date has passed with
  // no outcome recorded. The schema is explicit that a null outcome means "no response
  // measured yet", so absence IS the finding here — the opposite of almost everything
  // else in this file. An intervention with no review date is NOT overdue: nobody
  // promised a date, so nobody has missed one.
  const interventions = raw.interventions || {};
  if (isNum(interventions.overdueReviews) && interventions.overdueReviews >= 1) {
    codes.push(TRIP.REVIEW_OVERDUE);
  }

  return { absenceStreak, lastAttendedOn, oldestUnmarkedDueDate, attendanceSlope, codes };
}

module.exports = {
  evaluate, attendanceShape, attendanceQuality, attainmentShape, engagementRecency,
  unitDispersion, unpassedUnits, weeklyRegularity, submissionTiming, repeatConcerns,
  queryBacklog, contactDeficit, overdueFollowUps,
  weightedGrade, markingLatency, firstSessionAbsence,
  TRIP, TRIP_CODES,
};
