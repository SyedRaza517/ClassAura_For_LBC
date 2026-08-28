// Workload: is this student about to be hit by more work than anyone could reasonably
// do at once, and are they already carrying a backlog into it?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments, today's
// date included — the same seam as tripwires.js, coverage.js and engine.js, and for
// the same reason: these are lines a college will be asked to defend at an appeal, so
// they have to be checkable without standing up an institution's worth of fixtures.
//
// WHY THIS LAYER EXISTS AT ALL, AND WHY IT IS NOT `assessmentsDueSoon` AGAIN.
//
// metrics.js already counts the assessments falling due in the next fourteen days,
// and it is explicit about what that figure is worth on its own:
//
//     "Assessments falling due in the near term. A fact about the timetable rather
//      than the student, so it is a figure and never a code — it would fire
//      cohort-wide."
//
// That judgement is right and this module does not reopen it. A busy fortnight is a
// property of the assessment calendar. Every student on the unit shares it, a code
// raised on it would appear on a hundred rows carrying an identical reason, and
// CLAUDE.md is blunt that a caseload containing everybody is the same as no caseload.
//
// But the same sentence is also the opportunity, and it is the whole reason for this
// file. Four deadlines in one week is ordinary for a cohort. Four deadlines in one
// week for somebody who has not handed in the last two, or who has not been in a room
// for a fortnight, is not a fact about the timetable at all — it is a fact about this
// student meeting that timetable, and nobody else on the unit necessarily shares it.
// The CONJUNCTION is the signal. Neither half may raise a code alone, and the code
// below is written so that it structurally cannot: every push is guarded by a peak AND
// by a per-student fact, and there is deliberately no code for a heavy calendar on its
// own however tempting it looks on the screen.
//
// WHAT THIS MODULE ADDS THAT THE EXISTING FIGURES DO NOT — trap six, stated up front
// so a later reader does not add a third count of the same thing:
//
//   * `assessmentsDueSoon` counts deadlines over a fixed horizon. It answers HOW MUCH
//     is coming. This module answers WHERE IT BUNCHES: two deadlines a fortnight apart
//     and two on the same Friday give an identical `assessmentsDueSoon` of 2 and are
//     not the same week of a student's life. The shape is the new information.
//   * `missingAssessmentCount` counts work positively recorded as not handed in, and
//     `oldestUnmarkedDueDate` dates the oldest piece carrying no answer either way.
//     Both are INPUTS here. Neither is re-derived, and `oldestUnmarkedDueDate` is
//     deliberately NOT returned again — a second column with a slightly different
//     definition of "oldest outstanding" is exactly how two figures that must agree
//     start disagreeing, and the disagreement surfaces at an appeal.
//   * Nothing here re-counts attendance. `recentAttendance` arrives already computed
//     by the same summariser the score uses, so the figure in the conjunction and the
//     figure on the screen can never drift apart.
//
// WHY THE CODES ARE NAMESPACED `TRIP_`.
//
// They are appended to `riskDriverCodes`, the same array engine.js builds from its six
// RED indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band
// — is derived by engine.js from its own internal `reds` array, and `riskDriverCodes`
// is a copy taken afterwards, so appending here provably cannot reach the override.
// The prefix is what keeps that visible: a code named `RED_`-anything would read as
// the engine's own, and the next person to take a count off the copy rather than off
// engine.js's `reds` would silently wire the assessment calendar into a student's
// band. Keep the prefix; keep the count off the copy.
//
// WHY NOTHING HERE MOVES THE SCORE, beyond the structural argument above.
//
// A deadline that has not arrived yet is not evidence about a student. metrics.js
// already refuses to count an assessment due next month as missing — "an assessment
// due next month must never reduce a student's score" — and scoring a student down for
// the shape of a calendar the college published would be the same error wearing a
// different hat. This layer says "somebody should speak to this person this week". It
// does not say they are doing badly.

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so
// these strings outlive several rewrites of the screen. Structured codes, never
// display text — the client maps them to wording, and rewording must not orphan a
// stored row.
const WORKLOAD = {
  // A heavy deadline window ahead AND work already outstanding going into it. The
  // per-student half is the backlog: the cohort shares the calendar, this student is
  // the one meeting it from behind.
  PILEUP: "TRIP_WORKLOAD_PILEUP",
  // A heavy deadline window ahead AND this student has not been turning up in the
  // run-up to it. Named for the register rather than for a judgement — "UNPREPARED"
  // would be an inference about a student drawn from an attendance percentage, which
  // is precisely the move this codebase spends most of its comments refusing.
  ABSENT: "TRIP_WORKLOAD_ABSENT",
};

const WORKLOAD_CODES = Object.values(WORKLOAD);

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Platform defaults, in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and a config key that nothing reads is worse than no
// key at all. Every function takes an `opts`/`config` that is spread OVER these, so
// the day these move into DEFAULTS the callers do not change.
const WORKLOAD_DEFAULTS = {
  // THE WINDOW A CLUSTER IS MEASURED OVER, in days, inclusive at both ends.
  //
  // Seven, because a week is the unit a student's timetable and a student's planning
  // are both expressed in, and it is the sentence staff actually say — "she has four
  // things due that week". Two deadlines on the same Friday and two five days apart
  // are the same week and the same problem; a shorter window would separate them, and
  // a longer one would stop distinguishing a pile-up from a term's ordinary spread.
  clusterWindowDays: 7,

  // HOW FAR AHEAD TO LOOK FOR ONE.
  //
  // Longer than dueSoonDays (14) on purpose, and the reason is arithmetic rather than
  // taste: a fourteen-day horizon can only ever see the near half of a fortnight's
  // bunching, so a cluster straddling day 14 is reported at half its size — the peak
  // is understated for exactly the student it should be loudest about. Finding it
  // EARLY is also the only thing this signal is for. A pile-up discovered in the week
  // it lands is a pile-up nobody can do anything about.
  //
  // Bounded at 28 rather than at the end of term, because deadlines move: extensions,
  // resits, a re-published timetable. A code raised on a calendar that will have
  // changed by the time anybody acts is one staff learn to scroll past. 28 is also the
  // horizon recentAttendanceDays and directionOfTravelDays already use, so the three
  // windows this feature reasons over stay commensurable.
  horizonDays: 28,

  // HOW MANY DEADLINES IN ONE WINDOW COUNT AS A PILE-UP.
  //
  // Three. Two in a week is an ordinary teaching week on most level 4/5 timetables and
  // firing on it would put half the cohort on the caseload; three inside seven days is
  // the point at which the work can no longer be sequenced — one has to be started
  // before another is finished.
  //
  // It is set at "heavy but not extreme" DELIBERATELY, and that is only defensible
  // because it is never the whole test. This half is shared by every student on the
  // unit; the discriminating is done by the per-student half of the conjunction. A
  // threshold tuned as though it were the whole signal would have to be set so high
  // that it found nobody until the week it was too late.
  peakDeadlineLimit: 3,

  // HOW MUCH OUTSTANDING WORK COUNTS AS A BACKLOG, GIVEN THE PEAK.
  //
  // One, and it is the one number here that looks wrong against the rest of the
  // codebase, so it is argued rather than assumed. lateSubmissionMinPieces is 3,
  // disperseMinMarks is 4, slopeMinMarks is 3 — this file's neighbours all refuse to
  // speak from a single observation. Every one of those floors, though, protects a
  // RATE: one piece handed in late reads 100% and the screen calls that a pattern.
  //
  // This is not a rate. It is a count of concrete, named, unfinished pieces of work,
  // and one genuinely outstanding assignment going into a week holding three deadlines
  // is not a small sample — it is four things to do in seven days. The guard against a
  // single data point here is the PEAK, which needs three deadlines of its own before
  // this number is ever consulted.
  backlogLimit: 1,

  // THE ATTENDANCE AT OR BELOW WHICH A STUDENT IS "NOT TURNING UP" GOING INTO A PEAK.
  //
  // Mirrors redAttendanceThreshold (70) rather than inventing a number, so a college
  // that retunes what it considers a concerning attendance figure moves this with it
  // instead of leaving the two to drift. It is also the second boundary of the default
  // band ladder (85/70/55/40), which is to say: the level at which this institution
  // has already said out loud that it is worried.
  peakAttendanceFloor: 70,

  // THE FEWEST MARKED SESSIONS THE RECENT WINDOW NEEDS BEFORE ITS PERCENTAGE MAY BE
  // USED HERE. Mirrors slopeMinMarks, for the reason given there: a window holding one
  // register reads 0 or 100 and neither is information. Without it a student with two
  // marks and one absence reads 50% and raises the loudest code on the screen.
  recentMinMarks: 3,
};

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** A YYYY-MM-DD string this module is prepared to treat as a date. */
const isDate = (s) =>
  typeof s === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

/**
 * YYYY-MM-DD, `days` after `iso`. String arithmetic on a UTC midnight, so it never
 * drifts across a BST boundary the way a local Date would — the same shiftDays
 * tripwires.js and metrics.js use, duplicated rather than imported because this file
 * has no other reason to depend on either, and a shared date-helper module would be a
 * change to three files for one line.
 */
function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a backlog question without an institution-wide answer to "does this
 * college record whether work was handed in at all?"
 *
 * WHY THIS THROWS INSTEAD OF DEFAULTING TO SILENCE.
 *
 * Everything the backlog side reads is derived from AssessmentSubmission, and CLAUDE.md
 * records that table as a dead end: it "is written by *nothing* — no VLE adapter, no
 * importer". At a college whose feed does not populate it, EVERY past-due assessment
 * looks unanswered while every student's `missingAssessmentCount` is simultaneously
 * zero. Both readings are facts about the integration, and a signal built on either
 * without the probe fires for the whole institution at once or for nobody at all.
 *
 * CLAUDE.md also records this as the most repeated bug in this area, got wrong three
 * times: "does this college record this at all" is an institution-wide question and it
 * keeps being answered from the chunk in front of the code. gather() runs on chunks of
 * 200 and the ordinary incremental path scores the handful of students markStale
 * flagged — often exactly one. At that size the question is invisible: one student with
 * no submission rows is entirely ordinary.
 *
 * The existing guards in tripwires.js take a boolean that defaults to falsy and fall
 * silent when it is missing. That is right for them — a missing flag there costs one
 * code that does not fire. Here it would cost the pile-up conjunction permanently and
 * silently: no test would fail, no row would look wrong, and the column would simply be
 * null for every student at every college for as long as anybody left it alone. A
 * feature that quietly does nothing is not discoverable by reading the output.
 *
 * So this fails the way db.js fails a query with no tenant context, and the way
 * coverage.js fails a missing timetable probe: loudly, at the first call, in the
 * caller's own test run. A TypeError at wiring time is recoverable; three years of
 * blank columns nobody questioned is not.
 *
 * @param {{submissionsRecorded:boolean}} institution
 */
function assertInstitutionProbe(institution, fnName) {
  if (!institution || typeof institution.submissionsRecorded !== "boolean") {
    throw new TypeError(
      `${fnName}: institution.submissionsRecorded must be a boolean — an institution-wide `
      + "probe result, decided once per run and never derived from one student's rows",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Where the deadlines bunch                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every window of `clusterWindowDays` in the horizon ahead, and how much work falls in
 * each.
 *
 * WHY WINDOWS ARE ANCHORED ON DUE DATES RATHER THAN ON CALENDAR DAYS. Any window can
 * be slid forward until its earliest member sits on its left edge without losing a
 * member, so a window anchored on a due date is at least as full as any window that is
 * not. Enumerating the distinct due dates therefore enumerates every achievable count
 * — walking all 28 calendar days would produce the same maximum and a `from` that is
 * an arbitrary Tuesday nothing happens on. A date something is actually due is the one
 * a member of staff can put in a sentence.
 *
 * TRAP TWO, AND IT IS THE REASON THIS RETURNS `null` AS WELL AS `[]`.
 *
 * An assessment with no `dueDate` cannot be placed on a calendar and leaves BOTH sides
 * — it is not in any window, and it is not evidence that any window is empty. This is
 * the rule metrics.js already applies to the same rows ("No due date means nothing can
 * be overdue against it"), pointed forwards instead of backwards, and it is counted
 * rather than dropped so the caller can see how much of the horizon was invisible.
 *
 * The consequence is a three-way answer, not a two-way one:
 *
 *   windows === null  the calendar ahead is UNKNOWN. Either nothing carries a date at
 *                     all, or nothing dated falls in the horizon while some assessment
 *                     could not be dated — in which case "no deadlines ahead" would be
 *                     a reassurance drawn from the rows we could not read.
 *   windows === []    the calendar ahead is MEASURABLY CLEAR. Something carries a date,
 *                     nothing is undated, and nothing falls in the horizon.
 *   windows.length    the windows, earliest first.
 *
 * A student with no dated assessments has an UNKNOWN workload, not a workload of zero,
 * and that difference is the whole of trap two. Where some assessments are dated and
 * some are not, the counts are a LOWER BOUND and `undated` says by how much they could
 * be wrong — which is safe in the only direction that matters here, because every code
 * in this file fires on a count being HIGH. Undercounting produces silence; it can
 * never produce a false alarm.
 *
 * @param {Array<{dueDate:string|null, weight:number|null}>} assessments  the student's
 *        in-scope assessments, already carrying the EFFECTIVE deadline — an extension
 *        is a new deadline and belongs on the calendar at its new date, and work an
 *        approved claim excluded must have been dropped by the caller entirely rather
 *        than arriving with a null dueDate (adjustments.js STATE.EXCLUDED). A null date
 *        here reads as "cannot be placed", and an excluded piece arriving that way
 *        would be counted as unplaceable rather than as removed.
 * @param {string} today  YYYY-MM-DD, in the college's zone, passed in and never read
 *        from a clock
 * @param {object} [opts]
 * @returns {{windows:Array|null, dated:number, undated:number, ahead:number|null,
 *            horizonTo:string|null}}
 */
function deadlineClusters(assessments, today, opts) {
  const cfg = { ...WORKLOAD_DEFAULTS, ...(opts || {}) };
  const list = (assessments || []).filter(Boolean);

  // A DATE THE MODULE CANNOT PARSE IS NOT TODAY. Deriving a horizon from NaN silently
  // makes every comparison false, which would report a clear calendar for every student
  // in the batch — manufactured reassurance produced by a malformed string rather than
  // by evidence. Same class of refusal as coverage.daysBetween returning null instead
  // of zero.
  if (!isDate(today)) {
    return { windows: null, dated: 0, undated: list.length, ahead: null, horizonTo: null };
  }

  const horizonTo = shiftDays(today, cfg.horizonDays);

  let dated = 0;
  let undated = 0;
  const ahead = [];

  for (const a of list) {
    if (!isDate(a.dueDate)) { undated += 1; continue; }
    dated += 1;
    // Behind us is not this function's question — that is carriedBacklog(), and
    // counting a passed deadline as future work would fold the backlog into the very
    // peak it is supposed to be compared against, turning the conjunction into one
    // number counted twice.
    if (a.dueDate < today) continue;
    if (a.dueDate > horizonTo) continue;
    ahead.push(a);
  }

  // A MEASURED ZERO NEEDS POSITIVE EVIDENCE THAT THE CALENDAR IS CLEAR, which is: this
  // college dates its assessments (something carries a date) AND none of this student's
  // is undated (nothing is hidden). Anything else with an empty horizon is unknown.
  if (!ahead.length) {
    const measurablyClear = dated > 0 && undated === 0;
    return { windows: measurablyClear ? [] : null, dated, undated, ahead: 0, horizonTo };
  }

  const anchors = [...new Set(ahead.map((a) => a.dueDate))].sort();

  const windows = anchors.map((from) => {
    // Inclusive at BOTH ends, which is why the span is one day short of the window
    // length: a seven-day window running Monday to Sunday is `from` plus six, and
    // `from` plus seven would quietly measure eight days and inflate every count by
    // whatever happens to fall on the extra day.
    const to = shiftDays(from, cfg.clusterWindowDays - 1);
    const inWindow = ahead.filter((a) => a.dueDate >= from && a.dueDate <= to);

    // TRAP THREE, AND THE SHARE IS REPORTED RATHER THAN RANKED ON — see peakLoad().
    // A weight of 0 is Assessment.weight's DEFAULT and means "unset", not "worth
    // nothing", so an unweighted piece is excluded from the share and counted, exactly
    // as tripwires.weightedGrade() excludes an unweighted mark from a weighted mean.
    const weighed = inWindow.filter((a) => isNum(a.weight) && a.weight > 0);

    return {
      from,
      to,
      count: inWindow.length,
      // Null, never 0, where nothing in the window carries a weight — which is the
      // ORDINARY state at a Moodle-synced college rather than an edge case. A share of
      // 0 printed beside three deadlines would read as "none of this counts for
      // anything", which is the opposite of what it means.
      weightShare: weighed.length ? weighed.reduce((sum, a) => sum + a.weight, 0) : null,
      weighted: weighed.length > 0,
      weightsUnset: inWindow.length - weighed.length,
    };
  });

  return { windows, dated, undated, ahead: ahead.length, horizonTo };
}

/* -------------------------------------------------------------------------- */
/* The heaviest window ahead                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The fullest window in the horizon, and WHEN it falls.
 *
 * TRAP FOUR: A DATE, NEVER A DAY COUNT. Nothing in this feature runs on a schedule —
 * markStale() fires on data events and a day passing is not an event — so "peak in 9
 * days" written to a column is wrong by the next morning with nothing to correct it,
 * while "the peak week begins on 2026-03-16" is true forever. The dates are what a
 * caller stores; the screen subtracts. There is deliberately no `daysUntilPeak` in the
 * return, and a test asserts that no key in it looks like one.
 *
 * TRAP THREE, AND WHY THE RANKING IS ALWAYS A COUNT.
 *
 * `Assessment.weight` defaults to 0 and the Moodle importer never sets it, so at a
 * synced college every assessment weighs nothing. The schema is explicit about what
 * that does to a figure built on it: a number "that appears to honour the weighting and
 * silently does not is the failure this schema is organised against", which is why
 * `gradeWasWeighted` exists beside `weightedAverageGrade`.
 *
 * The obvious move here is the same one — rank windows by summed weight, fall back to
 * the count when no weight is set, record which happened. It is WRONG, and the reason
 * is the difference between a mean and a volume:
 *
 *   tripwires.weightedGrade() may exclude an unweighted mark because it is computing an
 *   AVERAGE, and an excluded piece leaves both the numerator and the denominator. A
 *   peak load is a COUNT OF THINGS THAT MUST BE DONE. An excluded deadline leaves only
 *   one side of that — the work still has to be done — so a window holding four
 *   unweighted assignments would score 0 and rank BELOW a window holding one 10% quiz.
 *   The heavy week disappears precisely because nobody typed the weights in, and it
 *   disappears silently, at the kind of college where that is most likely to happen.
 *
 * So the COUNT chooses the window, always, at every college, and the weight share rides
 * beside it as a reported figure with `peakWasWeighted` saying whether it means
 * anything — `false` reading exactly as `gradeWasWeighted: false` does: this is a plain
 * count of deadlines, and any share below it is not a weighting you can trust.
 *
 * THE TIE-BREAK IS THE EARLIEST WINDOW, for two reasons. It is the actionable one —
 * given two equally heavy weeks, the one staff can still do something about is the near
 * one — and it is deterministic, which matters here for the reason metrics.js sorts
 * grades with an assessment-id tie-break: a peak that moved between runs with nothing
 * about the student having changed would make the row untrustworthy.
 *
 * @returns {{peakFrom, peakTo, peakCount, peakWeightShare, peakWasWeighted,
 *            weightsUnset, dated, undated, ahead, horizonTo}}
 */
function peakLoad(assessments, today, opts) {
  const clusters = deadlineClusters(assessments, today, opts);
  const base = {
    dated: clusters.dated,
    undated: clusters.undated,
    ahead: clusters.ahead,
    horizonTo: clusters.horizonTo,
  };

  // UNKNOWN. Not a peak of zero — see deadlineClusters() for the three-way contract.
  if (clusters.windows === null) {
    return {
      ...base,
      peakFrom: null,
      peakTo: null,
      peakCount: null,
      peakWeightShare: null,
      peakWasWeighted: null,
      weightsUnset: null,
    };
  }

  // MEASURABLY CLEAR. This one IS a zero rather than a null: the college dates its
  // assessments, none of this student's is undated, and there is nothing in the next
  // four weeks. That is a measurement, and it is the only place in this file where a
  // zero is the honest answer.
  if (!clusters.windows.length) {
    return {
      ...base,
      peakFrom: null,
      peakTo: null,
      peakCount: 0,
      peakWeightShare: null,
      peakWasWeighted: null,
      weightsUnset: 0,
    };
  }

  // `windows` is already ordered earliest-first by the sorted anchors, so a STRICT `>`
  // keeps the earliest of equals without a second comparison. The strictness is the
  // whole tie-break and it is easy to lose to a later `>=`.
  let peak = clusters.windows[0];
  for (const w of clusters.windows) if (w.count > peak.count) peak = w;

  return {
    ...base,
    peakFrom: peak.from,
    peakTo: peak.to,
    peakCount: peak.count,
    peakWeightShare: peak.weightShare,
    peakWasWeighted: peak.weighted,
    weightsUnset: peak.weightsUnset,
  };
}

/* -------------------------------------------------------------------------- */
/* What is already outstanding going into it                                   */
/* -------------------------------------------------------------------------- */

/**
 * Work whose deadline has passed and which has not been resolved either way.
 *
 * TWO LISTS, BECAUSE THE DATABASE ANSWERS THE QUESTION TWICE AND DIFFERENTLY.
 *
 *   `missing`     assessments an AssessmentSubmission row positively says were NOT
 *                 handed in. The same set behind missingAssessmentCount.
 *   `unresolved`  assessments past their deadline carrying no answer at all — no
 *                 submission row, or one Moodle left as "unknown". The same set behind
 *                 oldestUnmarkedDueDate, and metrics.js is clear that this silence "is
 *                 not a fact about the student".
 *
 * BOTH ARE COUNTED HERE, AND THE ASYMMETRY IS DELIBERATE. On its own, silence is not
 * evidence, which is why the existing tripwire on it says only that somebody needs to
 * find out. Under a pile-up the question changes: a student with three deadlines next
 * week and two pieces nobody can account for is somebody to speak to THIS WEEK,
 * whichever of the two the pieces turn out to be. The conjunction is what makes the
 * weaker signal usable — and it is also what stops it firing on its own.
 *
 * DEDUPED BY ASSESSMENT ID where the caller supplies one. metrics.js builds these two
 * sets disjointly — `dueUnmarked` skips anything already `decided` — so an overlap is a
 * caller fault rather than an expected state, and it would push one assessment counted
 * twice over the threshold. Where no id is present the rows are counted as they arrive,
 * which is stated here rather than silently assumed.
 *
 * THE INSTITUTION GUARD. Both lists come from AssessmentSubmission, which CLAUDE.md
 * records as written by nothing. Without the probe this returns nulls, not zeros: at a
 * college with no submission feed, "no outstanding work" describes the integration. See
 * assertInstitutionProbe for why a MISSING probe throws rather than falling silent.
 *
 * PAST DUE ONLY, AND UNDATED WORK LEAVES BOTH SIDES — the same rule metrics.js applies
 * before counting anything as missing: an assessment with no deadline cannot be late
 * against one, and one whose deadline has not arrived is not outstanding, it is
 * upcoming, and it is already counted in the peak on the other side of the conjunction.
 *
 * @param {{missing:Array<{assessmentId, dueDate}>,
 *          unresolved:Array<{assessmentId, dueDate}>}} backlog
 * @param {string} today  YYYY-MM-DD
 * @param {{submissionsRecorded:boolean}} institution  REQUIRED; throws without it
 * @returns {{carried:number|null, missing:number|null, unresolved:number|null,
 *            oldestOutstandingOn:string|null}}
 */
function carriedBacklog(backlog, today, institution) {
  assertInstitutionProbe(institution, "carriedBacklog");
  const input = backlog || {};

  const unknown = { carried: null, missing: null, unresolved: null, oldestOutstandingOn: null };

  // The integration, not the student. Null rather than 0, for the reason
  // tripwires.submissionTiming returns a null lateRate where the feed carries no dates:
  // a zero here would say "we counted and found none" about a sample nobody looked at.
  if (!institution.submissionsRecorded) return unknown;

  // An unparseable today cannot decide what is past due. Every comparison below would
  // be false and the answer would be a confident zero drawn from a bad string.
  if (!isDate(today)) return unknown;

  const seen = new Set();
  let missing = 0;
  let unresolved = 0;
  let oldestOutstandingOn = null;

  const take = (rows, bump) => {
    for (const r of rows || []) {
      if (!r) continue;
      if (!isDate(r.dueDate)) continue;   // nothing can be overdue against no deadline
      if (r.dueDate >= today) continue;   // not outstanding — upcoming, and in the peak
      if (r.assessmentId) {
        if (seen.has(r.assessmentId)) continue;
        seen.add(r.assessmentId);
      }
      bump();
      if (!oldestOutstandingOn || r.dueDate < oldestOutstandingOn) oldestOutstandingOn = r.dueDate;
    }
  };

  // `missing` first, so that where a caller HAS handed over overlapping sets the piece
  // survives as the stronger of the two readings — positively not handed in, rather
  // than merely unanswered.
  take(input.missing, () => { missing += 1; });
  take(input.unresolved, () => { unresolved += 1; });

  // A REAL ZERO. Unlike the peak above, nothing is hidden here: the college records
  // submissions, so "this student has nothing outstanding" is a measurement. That is
  // the only reading under which the conjunction below can be trusted to stay silent
  // for the right reason.
  return { carried: missing + unresolved, missing, unresolved, oldestOutstandingOn };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   today              {string} YYYY-MM-DD, passed in rather than read from a clock
 *   assessments        {Array<{dueDate, weight}>} the student's in-scope assessments at
 *                      their EFFECTIVE deadlines, excluded work already removed
 *   backlog            {{missing:[], unresolved:[]}} see carriedBacklog()
 *   recentAttendance   {{pct, marked}} the rolling window, exactly as
 *                      summariseAttendance() returns it — never recomputed here
 *   weeksIntoProgramme {number|null} accepted and deliberately unused; see below
 *   institution        {{submissionsRecorded:boolean}} REQUIRED — throws without it
 * @param {object} [config] a settings config, spread over WORKLOAD_DEFAULTS
 */
function evaluate(raw, config) {
  const cfg = { ...WORKLOAD_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller that forgot the probe finds out on their
  // first fixture rather than after a term of blank columns.
  assertInstitutionProbe(input.institution, "evaluate");

  const codes = [];

  const peak = peakLoad(input.assessments || [], input.today, cfg);
  const backlog = carriedBacklog(input.backlog || {}, input.today, input.institution);

  // THE SHARED HALF. Every code below is guarded by this AND by something else. On its
  // own it is a fact about the timetable and it raises nothing — metrics.js's judgement
  // about assessmentsDueSoon, kept structurally rather than by anybody remembering it.
  //
  // `isNum` is what keeps an UNKNOWN peak out. A null peak means the calendar could not
  // be read, and reading null as "not heavy" is right here only by luck; it is written
  // explicitly so a later reader cannot replace it with a `|| 0`, which would compare a
  // number that was never measured against a threshold and look correct doing it.
  const heavyWindowAhead = isNum(peak.peakCount) && peak.peakCount >= cfg.peakDeadlineLimit;

  /* --- already behind, and more coming ------------------------------------ */

  // THE CONJUNCTION, AND IT IS THE POINT OF THE FILE. The peak is shared by the cohort;
  // the backlog is this student's. A hundred students on the unit see the same three
  // deadlines, and the ones already carrying unfinished work into them are, on a normal
  // unit, a handful. That is a caseload.
  //
  // `isNum` again, and here it is load-bearing rather than defensive: a null carried
  // count means this college does not record submissions, and treating null as zero
  // would silence the code at exactly the colleges where it is unmeasurable, while a
  // careless `backlog.carried >= 1` on a null would silently compare against nothing.
  // Neither failure is visible on a row.
  if (heavyWindowAhead && isNum(backlog.carried) && backlog.carried >= cfg.backlogLimit) {
    codes.push(WORKLOAD.PILEUP);
  }

  /* --- not turning up in the run-up --------------------------------------- */

  // THE SECOND CONJUNCTION, and a genuinely different finding rather than a variant of
  // the first. A student with a clean submission record who has stopped attending in
  // the fortnight before three deadlines is not behind YET, and that is precisely why
  // it is worth a contact now: everything the first code describes is still avoidable.
  //
  // They may fire together, and that is accepted rather than filtered — already how
  // tripwires.js behaves, where ABSENCE_STREAK and NOT_SEEN both fire on one
  // disappearance. Two findings about the same week are two things to say in the
  // conversation.
  //
  // THE FLOOR ON `marked` IS NOT OPTIONAL. Without it a student with a single absent
  // mark in the window reads 0% and raises this beside every genuine case, and a
  // register holding one row is a fact about the register.
  const recent = input.recentAttendance || {};
  const notTurningUp = isNum(recent.pct)
    && isNum(recent.marked) && recent.marked >= cfg.recentMinMarks
    && recent.pct <= cfg.peakAttendanceFloor;

  if (heavyWindowAhead && notTurningUp) codes.push(WORKLOAD.ABSENT);

  /* --- the settling-in exemption, and why it is deliberately NOT applied --- */

  // CLAUDE.md: "`weeksIntoProgramme` mutes the disengagement codes inside a settling-in
  // period, because in week one nobody has attendance history, marks or a pastoral
  // record, and a caseload containing the whole intake is the same as no caseload. An
  // *unknown* programme age is deliberately not exempt."
  //
  // NEITHER CODE HERE IS IN THAT CLASS, and the class is the reason rather than the
  // habit. The exemption covers codes that fire on the ABSENCE OF A RECORD — no
  // pastoral contact, no attendance history, nothing marked — because in week one that
  // absence describes the calendar rather than the student. tripwires.evaluate applies
  // it to exactly one code, NO_PASTORAL_CONTACT, and pointedly does NOT apply it to
  // ABSENCE_STREAK, ATTENDANCE_FALLING or FOLLOWUP_MISSED, all of which fire on the
  // PRESENCE of evidence. Both codes above are in that second family:
  //
  //   PILEUP  needs a published deadline calendar AND positively recorded outstanding
  //           work. Neither exists by default in week one — a college that has already
  //           set a deadline and let it pass has produced evidence, not silence.
  //   ABSENT  needs a register that exists and says the student was not there, over a
  //           minimum of three marked sessions. The FLOOR, not the calendar, is what
  //           protects a thin week-one window, and it protects it in week nine too.
  //
  // AND THE HARM RUNS THE OTHER WAY HERE. Induction is when badly-planned diagnostic
  // clusters land: three pieces due in the first fortnight is a real timetable shape,
  // and a first-year drowning in week 3 is a real finding — arguably the most
  // recoverable one this whole feature can produce, because the term has not been lost
  // yet. Muting it would silence the signal in the only window where acting on it is
  // cheap, and a settling-in grace would be indistinguishable, on the row, from the
  // code simply not working.
  //
  // `weeksIntoProgramme` is accepted in the input and read by nothing, ON PURPOSE, so
  // the decision is visible at the call site rather than looking like an oversight —
  // and so anybody who later decides one of these codes DOES belong in the muted class
  // has the field in their hand and must confront the second half of the rule as well:
  // an unknown programme age is NOT exempt, because muting every code for a student the
  // calendar cannot place fails safe in the wrong direction. Two tests pin both halves:
  // a week-one student fires, and a student of unknown age fires identically.

  return {
    // DATES, NEVER DAY COUNTS. See peakLoad().
    peakFrom: peak.peakFrom,
    peakTo: peak.peakTo,
    peakCount: peak.peakCount,
    // The share, and the flag that says whether the share means anything —
    // gradeWasWeighted's contract, for the reason it exists there.
    peakWeightShare: peak.peakWeightShare,
    peakWasWeighted: peak.peakWasWeighted,
    // How much of the horizon could not be placed on a calendar, so a reader can see
    // that the peak is a lower bound rather than a measurement.
    undatedAssessments: peak.undated,
    // The conjunction's own denominator, returned so that "already behind" is auditable
    // on the day it fired. Deliberately the UNION of two sets that are stored
    // separately, so it cannot be reconstructed from either column alone — and
    // deliberately NOT accompanied by a second oldest-outstanding date, which
    // oldestUnmarkedDueDate already stores under a definition that must not fork.
    carriedBacklogCount: backlog.carried,
    codes,
  };
}

module.exports = {
  evaluate,
  deadlineClusters,
  peakLoad,
  carriedBacklog,
  WORKLOAD,
  WORKLOAD_CODES,
  WORKLOAD_DEFAULTS,
};
