// Early window: HOW DID THIS STUDENT START?
//
// PURE. No database, no clock, no tenant — and, unusually for this directory, no `today`
// either (see "WHY THERE IS NO `today`" below, which is the same argument timetable.js
// makes and here it does more work). The same seam engine.js, tripwires.js, sessions.js,
// history.js and timetable.js keep, and for the same reason: these are lines a college
// will be asked to defend at an appeal, so they have to be checkable without standing up
// an institution's worth of fixtures.
//
// ============================================================================
// WHY THIS EXISTS
// ============================================================================
//
// The on-track literature is more consistent about the OPENING of a programme than about
// almost anything else it measures. Balfanz's indicators are built on the first weeks;
// the broader finding is that attendance and engagement in the first few weeks predict
// withdrawal better than most things measured later, and better than the same figures
// measured over the whole year.
//
// Nothing in this pipeline can express it. Every attendance figure here is one of two
// shapes and both wash the start out:
//
//   * LIFETIME-TO-DATE (`overallAttendance`). The opening is a strict subset of the
//     denominator, and it is the part the mean dilutes hardest. By week thirty the first
//     four weeks are about a seventh of the figure, and a disastrous start is worth four
//     percentage points on it.
//   * A ROLLING RECENT WINDOW (`recentAttendance`, and `attendanceSlope` built from two
//     of them). Anchored to TODAY, so it walks away from the start at one day per day and
//     by the second term cannot see it at all.
//
// TWO DIFFERENT QUESTIONS, AND BOTH MATTER — which is why this module returns a pair of
// figures and a signed gap rather than one number:
//
//   * A student who STARTED BADLY AND RECOVERED is a success the college should be able
//     to see. Nothing else here can show it: the lifetime figure has averaged the two
//     halves into one mediocre number, and the slope went flat the month the recovery
//     finished. This is the only figure in the pipeline that can evidence "we intervened
//     and it worked" on the student's own attendance.
//   * A student who STARTED BADLY AND NEVER RECOVERED was visible in week three, and the
//     record should show that they were. That matters at an appeal, at a sponsoring
//     provider's audit, and in any honest review of whether the college acted — a
//     lifetime figure of 48% in June does not tell anyone that it was 22% in October.
//
// ============================================================================
// TRAP 1: THE WINDOW NEEDS A PROGRAMME START DATE, AND IT IS NOT `Student.createdAt`
// ============================================================================
//
// `programmeStartOn` is a REQUIRED input and there is no fallback. metrics.js already
// states the rule where it derives `weeksIntoProgramme` (~line 338): the cohort's own
// `startDate` wins, the earliest term is the fallback, and NEVER `Student.createdAt` —
// for a Moodle-imported college that is the SYNC date, which says when the row was made
// rather than when the student arrived. The same is true of `Enrolment.createdAt`. On
// both of this platform's databases today every one of those timestamps is the seed date,
// which is the strongest possible demonstration that they measure the import and not the
// student.
//
// SO A NULL START DATE MEANS NO WINDOW AND EVERY FIGURE NULL. The tempting fallback —
// "use the student's earliest mark" — is refused, and the refusal is the single most
// important line in this file. That fallback defines the window as "whenever we happened
// to start looking", which is not a property of the student at all. Worse, it fails
// asymmetrically: it produces its most confident-looking answer for exactly the students
// whose records are worst. A student whose register was not opened until week six would
// have their week-six-to-week-ten attendance stored as "how they started", the number
// would look completely ordinary, and the six weeks nobody marked them would have been
// erased by the very figure written to expose that kind of gap.
//
// A null figure for a student the calendar cannot place is the honest answer, and it is
// NOT the same operation as muting a code (see TRAP 2). Refusing to print a figure says
// "we cannot answer this"; muting a code says "there is nothing here" about a student
// nobody looked at.
//
// ============================================================================
// TRAP 2: A STUDENT STILL INSIDE THE WINDOW, AND WHY THIS IS NOT THE SETTLING-IN MUTE
// ============================================================================
//
// In week two of a four-week window, "early attendance" is a partial measurement that
// will change. Three options, and the third is what this does:
//
//   (a) RETURN NULL UNTIL THE WINDOW CLOSES. Rejected, and it is the option that looks
//       most rigorous. This module exists to make a bad start visible IN week three; a
//       figure that first appears in week five has conceded the whole argument. It would
//       also be null for precisely the intake a sponsoring provider has the least time to
//       act on.
//   (b) STORE A `complete: false` FLAG. Rejected, and the reason is CLAUDE.md's, not
//       taste: nothing in this feature runs on a schedule, so a stored boolean saying
//       "provisional" is wrong the morning the window closes with nothing to correct it.
//       That is the "19 days since last attended" bug wearing a different hat.
//   (c) COMPUTE THE FIGURE, AND STORE THE WINDOW'S END DATE. `earlyWindowEndsOn` is true
//       for ever. The screen compares it against today and labels the figure provisional
//       while it is in the future — store dates, derive at render, exactly as the rest of
//       this feature does. The minimum denominator below does the rest of the work: a
//       student three days in has too few marks and gets null anyway, so the partial
//       figures that do appear are ones with a real register behind them.
//
// AND THIS IS THE OPPOSITE SHAPE FROM THE SETTLING-IN MUTE, which is worth saying plainly
// because the two look superficially alike. `settlingInWeeks` suppresses signals EARLY,
// because in week one an absence of records describes the calendar rather than the
// student. This signal IS ABOUT EARLY: suppressing it inside the settling-in period would
// suppress it inside its own subject matter, and there would be nothing left. The two
// rules do not conflict here, because THIS MODULE EMITS NO CODES AT ALL (see TRAP 5), so
// there is nothing to mute — a figure is not a caseload row, and the settling-in argument
// is entirely about caseload rows.
//
// The second half of CLAUDE.md's rule is respected too and it is the half that gets
// dropped: an UNKNOWN programme age is not exempt. Here that reads as — a student with no
// start date gets NULL FIGURES, never a quietly-computed confident one, and never a
// blanket exemption from every other module's codes. Nothing in this file suppresses
// anything for anybody.
//
// ============================================================================
// TRAP 3: ONCE THE WINDOW CLOSES THE FIGURE IS A HISTORICAL FACT AND MUST NOT DRIFT
// ============================================================================
//
// This is unlike every other figure in this pipeline. `overallAttendance`,
// `recentAttendance`, `attendanceSlope`, `absenceStreak` and `averageGrade` all describe a
// CURRENT STATE and are supposed to move. A student's week 1-4 attendance is the same
// number in June as it was in October, and if it moves, something is wrong.
//
// FOUR THINGS MAKE THAT TRUE, and they are properties of the implementation rather than
// promises about it:
//
//   1. THE WINDOW IS BOUNDED BY TWO DATES, both computed from `programmeStartOn` and one
//      constant. Neither moves. `programmeStartOn` is the cohort's own start date, and a
//      cohort's start date does not change after the cohort has started.
//   2. MARKS ARE SELECTED BY STRING COMPARISON AGAINST THOSE BOUNDS — `date >= from` and
//      `date <= to` — never by "the first N marks", never by "marks before the median",
//      never relative to the end of the series. A selection rule that counts rows drifts
//      the moment a row is added; a selection rule that compares dates does not.
//   3. THERE IS NO `today` PARAMETER, so no output of this module can be a function of
//      the calendar. This is the strongest of the four because it is checkable by reading
//      the signature: a figure that never sees the date cannot change because the date
//      changed.
//   4. THE ROUNDING IS FIXED at one decimal, in one helper, so two runs cannot disagree in
//      the last digit and present as drift.
//
// WHAT *CAN* CHANGE IT, and should: a backdated register. If somebody enters a mark dated
// inside the opening window three months late, the figure moves — and that is a correction
// to the record of what happened in weeks 1-4, which is exactly right. `markStale()` fires
// on that write, so the recomputation happens on the data event. The rule is not "the
// number is frozen", it is "the number is a function of the register and of nothing else".
//
// WHY THERE IS NO `today`, stated once more because the parameter is in every neighbouring
// module and its absence must not read as an oversight. sessions.consecutiveWeeks takes one
// and refuses without it, because it measures a RUN anchored to the present. history.js
// takes one, because "how long have they been in this band" is elapsed time. Nothing here
// is elapsed: the window is anchored to the cohort's calendar at both ends, and the one
// question that WOULD need today — "has the window closed yet" — is answered by storing
// the end date and subtracting at render. Taking `today` "for consistency" would teach the
// next reader that the parameter is ceremony, and then it gets dropped from the one module
// where it was load-bearing.
//
// ============================================================================
// TRAP 4: NULL MEANS NOT MEASURABLE; ZERO MEANS ZERO
// ============================================================================
//
// NO MARKS INSIDE THE WINDOW IS NOT 0% ATTENDANCE. It may be a register nobody took, and
// CLAUDE.md is explicit that a student whose register was never taken has no attendance
// percentage — scoring them 0 puts them top of a risk list for something nobody measured.
// It is also the single most likely state at the start of a programme, which is when
// registers are least reliably opened, so this module would get it wrong more often than
// any other module in the directory if it got it wrong at all.
//
// BOTH SIDES OF THE GAP CARRY A FLOOR, in the shape sessions.js argues for weekdays
// (`weekdayMinMarks: 4` against `weekdayMinOtherMarks: 6`). A floor on only the
// interesting side is the classic half-guard: "22% in the opening month against the two
// registers taken since" is a gap drawn from two rows, and it would be the loudest number
// on the screen.
//
// THE COUNTS ARE ZEROS, NOT NULLS, and the asymmetry is deliberate. A RATE over an empty
// set is undefined; a COUNT of marks inside a bounded date window is genuinely zero — we
// looked, in a window with two known ends, and there were none. history.js returns
// `observedDays` beside its nulls for exactly this reason: the denominator is what explains
// the null next to it, rather than leaving a reader to guess the feature is broken. With NO
// window at all the counts are null too, because there is then nothing to have counted in.
//
// ============================================================================
// TRAP 5: WHY THERE ARE NO CODES. THIS IS THE DESIGN, NOT AN OMISSION.
// ============================================================================
//
// `EARLY_WINDOW_CODES` is empty and `evaluate()` returns `codes: []` under every input.
// CLAUDE.md, applied honestly rather than argued around:
//
//     "A signal that fires for a whole cohort at once is a FIGURE, not a code."
//
// A START DATE IS THE MOST COHORT-WIDE FACT THERE IS. It is not merely that neighbouring
// students share it — the window is literally the same four calendar dates for every
// student in the cohort, by construction, because the window is DERIVED FROM the cohort's
// own start date. timetable.js reached this conclusion about a nine o'clock start and
// called it a stronger version of sessions.js's weekday argument; this is stronger again.
// A weekday varies between units. A start time varies between cohorts. A cohort's opening
// window does not vary at all within the group it is computed for.
//
// And the opening month is the part of the year most reliably disrupted for everybody at
// once: freshers' week, a timetable published late, a room change, an induction programme
// nobody registered, a Moodle sync that started in week three. Every one of those produces
// poor opening attendance for the entire intake, and a hundred caseload rows carrying one
// reason is the same as no caseload.
//
// FOUR WAYS OUT WERE CONSIDERED AND ALL FOUR FAIL:
//
//   1. "FIRE ONLY WHEN THE OPENING IS VERY BAD." No. If the cohort's induction was chaos,
//      every student in it is very bad, and the threshold selects the whole intake.
//   2. "FIRE ONLY ON THE GAP — bad start, good since." That is the RECOVERY case, and it
//      is a SUCCESS. `riskDriverCodes` is a caseload of risk drivers; putting the
//      college's own best outcome on it is a category error, and it is the same mistake
//      history.js names when it explains why a student who dipped at Christmas and came
//      back must not be reported as unstable.
//   3. "FIRE ON BAD START AND STILL BAD." The "still bad" half is `overallAttendance`,
//      which is already a weighted component of the score and has already moved the band.
//      The code would restate, in small type, what the band beside it says in large type —
//      history.js's own phrase for why TRIP_CHRONIC_RISK had to say something the band
//      could not.
//   4. "PAIR IT WITH SOMETHING ABOUT THIS STUDENT", the workload.js pattern where every
//      `codes.push` is guarded by the shared half AND by the student's own backlog. That
//      works there because the two halves are independent. Here the thing that would
//      distinguish this student from their neighbours IS the opening attendance, and the
//      opening attendance is what the cohort shares.
//
// THE NON-STARTER IS ALREADY CAUGHT, THREE TIMES OVER, which settles the one code that
// might otherwise have survived the test ("TRIP_NEVER_STARTED": enrolled, never turned up).
// `TRIP_ABSENCE_STREAK` fires on it and tripwires.evaluate explicitly declines to mute it
// inside the settling-in period FOR THIS EXACT CASE — "the non-starter: somebody who
// enrolled and never once turned up, which is precisely who a sponsoring provider has to
// identify". `TRIP_WEEKS_UNSEEN` (sessions.js) fires on it. `TRIP_NOT_SEEN` fires once
// they have attended at all and stopped. A fourth code would put a fourth row on one
// caseload for one fact, which is the caseload-of-everybody failure arriving by a
// different route.
//
// The half that would separate this student from their cohort is THE REST OF THE COHORT'S
// OPENING WINDOW, and it does not live here — it lives in cohort.js, built once per run
// from StudentPredictionCurrent, which carries no per-window baseline. Until somebody
// threads one through, the honest output is a pair of figures a human reads next to the
// cohort's own start date, exactly as sessions.js concluded for two of its three axes,
// timetable.js concluded for all three of its, coverage.js refuses to add a "coverage
// unknown" code, and metrics.js refuses to raise one on `assessmentsDueSoon`.
//
// An empty vocabulary is exported anyway rather than omitted, so the disjointness
// assertion in schema-contract.test.js has an operand and so the structure is already
// there the day somebody adds a code. IF ONE IS EVER ADDED IT MUST BE `TRIP_`-PREFIXED:
// it would be appended to `riskDriverCodes`, the same array engine.js fills from its six
// RED indicators, and a code named `RED_`-anything would read as the engine's own to the
// next person who takes `redIndicatorCount` off the copy rather than off engine.js's
// internal `reds` array — silently wiring the shape of an induction week into a student's
// band through OVR-004.
//
// ============================================================================
// TRAP 7: WHAT THIS DELIBERATELY DOES NOT RE-REPORT
// ============================================================================
//
// Stated up front so a later reader does not add a second copy of a figure that already
// has a column and a definition.
//
//   * `attendanceSlope` IS THE CLOSEST AND IT IS WORTH THE MOST WORDS. It is
//     `recentAttendance - priorAttendance`, two equal windows BOTH ANCHORED TO TODAY. It
//     is a local derivative: "is the last month worse than the month before it".
//     `earlyAttendanceGap` is a FIXED-BASELINE comparison against a window that never
//     moves. The two answer different questions and diverge in four concrete ways:
//       - A student who opened at 40% and has sat at 85% ever since has a slope of ZERO —
//         nothing has changed recently — and a gap of +45. The slope was able to see that
//         recovery for about a month and has not been able to since. This is the success
//         case, and the slope is structurally blind to it.
//       - A student who opened at 95% and has slid to 60% across two terms has a small
//         negative slope every month, never enough to reach `attendanceSlopeDrop`, and a
//         gap of -35. A slow decline is invisible to a derivative with a 28-day baseline
//         and obvious against a fixed one.
//       - The slope is NULL whenever either 28-day window is thin, which is every summer
//         and every reading fortnight. The early figure does not go dark, because its
//         window is in the past and stays populated.
//       - The slope changes on every run by design. The early figure changes only when the
//         opening register is corrected. One is a current state and one is a historical
//         fact — the distinction history.js is built around, applied to attendance instead
//         of to the band.
//   * `overallAttendance` INCLUDES the opening window; that is the point. This is the
//     subset the mean dilutes, reported on its own.
//   * `recentAttendance` is the same LENGTH of window (28 days, deliberately — see the
//     constant) anchored at the opposite end. For a student in week four the two figures
//     are the same measurement, and they diverge permanently after that. The anchoring is
//     the entire difference and it is why both are worth storing.
//   * `attendanceRegularity` (tripwires.weeklyRegularity) is a standard deviation of
//     WEEKLY PERCENTAGES. A weekly percentage has already thrown away where in the
//     programme the week sat, so it cannot distinguish a bad first month from a bad
//     fourth one.
//   * `averageGrade` INCLUDES the first assessment by construction, which is the reason
//     first-assessment performance is a distinct predictor rather than a redundant one:
//     the mean it would be compared against contains it, so the mean can never be far from
//     it on a student with few marks. `firstAssessment` below excludes the first piece from
//     the average it is compared against, which is the whole trick.
//   * `gradeTrend` is the last N marks against the previous N, anchored to the END of the
//     series, and it is `INSUFFICIENT_DATA` for precisely the student this module is about
//     — one or two marks, early in a first term.
//   * `weeksIntoProgramme` IS NOT TAKEN AS AN INPUT, deliberately, even though every
//     neighbouring module takes it. It is derived from the same cohort start date this
//     module takes directly, collapsed against `today` into a DAY COUNT — the derived
//     quantity this codebase stores dates instead of. Taking both would put two
//     representations of one fact in one function where they could disagree, and the
//     day-count representation is the one that goes stale. There are no codes here to mute,
//     so the only thing it could be used for is the thing it must not be used for.
//   * `history.js` reads what the SCORE has done and needs three distinct scored days to
//     say anything. This reads what the STUDENT did, and answers for a student being scored
//     for the first time today, which history.js structurally cannot.
//   * `intake.js` is what the student said BEFORE they arrived — Ism answers, admission
//     records. This is what they DID once they had. Adjacent, and disjoint.
//   * `registerCoverage` (coverage.js) is whether the register was TAKEN. Nothing here
//     re-derives it; every figure below reads only marks that exist, and the marked counts
//     are returned so a thin window is visible rather than silently averaged.
const attendance = require("../attendance");

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// EMPTY, AND DELIBERATELY SO — see TRAP 5 in the header. Exported as an object rather than
// skipped so the shape matches the eleven other modules that write `riskDriverCodes`, and
// so the disjointness assertion has something to hold.
const EARLY_WINDOW = {};

const EARLY_WINDOW_CODES = Object.values(EARLY_WINDOW);

/* -------------------------------------------------------------------------- */
/* Constants, and the arguments for them                                       */
/* -------------------------------------------------------------------------- */

// Platform defaults in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and a config key nothing reads is worse than no key at all.
// Every function takes an `opts`/`config` spread OVER these, so the day they move into
// DEFAULTS the callers do not change.
const EARLY_WINDOW_DEFAULTS = {
  // HOW LONG THE OPENING WINDOW IS, IN DAYS, INCLUSIVE OF BOTH ENDS.
  //
  // 28, and there are two independent arguments for it landing on the same number.
  //
  // COMMENSURABILITY. `recentAttendanceDays` is 28, `directionOfTravelDays` is 28 and
  // history.js's `chronicRunDays` is 28. Four windows appear on one screen and they should
  // all mean the same thing by "a month", or a reader comparing the early figure against
  // the recent one is comparing a month to something else without being told.
  //
  // AND FOUR CALENDAR WEEKS EXACTLY, which 30 is not, and this is the argument that is
  // specific to this figure rather than borrowed. The window contains precisely four of
  // each weekday. sessions.js's entire subject is that a college's Monday and its Friday
  // have different attendance; a 30-day window contains five of two weekdays and four of
  // the other five, so the figure would be weighted towards whichever days the cohort's
  // start date happened to double up — and two cohorts starting three days apart would get
  // systematically different opening figures from identical behaviour. 28 cannot do that.
  //
  // DELIBERATELY LONGER THAN `settlingInWeeks` (3 weeks, 21 days), and the mismatch is not
  // an oversight. Those two numbers are answers to different questions: `settlingInWeeks`
  // says how long a student is spared a CASELOAD ROW, and this says how much of the opening
  // is MEASURED AND RECORDED. Forcing them equal would make the fact expire with the alert,
  // and the fact is the half that has to survive to an appeal.
  //
  // THE LENGTH IS LOAD-BEARING FOR THE FLOOR BELOW. The window cannot be widened to collect
  // more marks the way a lifetime figure widens on its own, which is why `earlyWindowMinMarks` is
  // argued down to 4 rather than up to 6.
  earlyWindowDays: 28,

  // THE FEWEST MARKS INSIDE THE WINDOW BEFORE THE OPENING PERCENTAGE MAY BE NAMED.
  //
  // Four — `disperseMinMarks` and `weekdayMinMarks` exactly — because it is the same shape
  // of question they answer: a bounded SLICE of the register, reported on its own and
  // compared against the rest of it. sessions.js's argument for four transfers word for
  // word, and so does its argument against six.
  //
  // NOT `minMarksForRate` (6). Six is the floor for the OVERALL figure, which spans the
  // whole programme and grows all year, so waiting for it costs a delay and nothing else.
  // This window is 28 days wide and then it is over. At a provider teaching one session a
  // week — evening and part-time provision, where a missed start is hardest to recover — 28
  // days holds at most four marks, so a floor of six would silence this figure PERMANENTLY
  // for exactly the cohorts it would help most. That is a different and worse failure from
  // a delay.
  //
  // THE COST IS REAL AND IS MITIGATED RATHER THAN DENIED: at four marks one absence is
  // worth twenty-five points. `earlyAttendanceMarked` is returned alongside so the
  // denominator is on the row and never hidden behind the percentage, and the fact that
  // this figure raises no code (TRAP 5) is what makes a noisy four-mark reading tolerable —
  // nobody is put on a caseload by it.
  // NAMED FOR THE WINDOW, not just "early". timetable.js already reads an
  // `earlyWindowMinMarks` meaning marks in early-STARTING sessions, and both modules are
  // handed the SAME config object -- so the shorter name silently gave this floor
  // timetable's 6 instead of the 4 argued below. Caught by a collision check before it
  // shipped; the OUTCOMES collision CLAUDE.md describes cost three bugs.
  earlyWindowMinMarks: 4,

  // THE FEWEST MARKS ON THE OTHER SIDE OF THE GAP.
  //
  // Six — `minMarksForRate`, and `weekdayMinOtherMarks` for the identical reason. The other
  // side is "the whole register minus the opening window", which is the population
  // `minMarksForRate` was chosen for. A gap is two numbers, and a floor on only the
  // interesting one is the half-guard sessions.js names: "22% at the start against the two
  // registers taken since" is an 80-point recovery drawn from two rows.
  //
  // Higher than the early floor on purpose. The two sides are not symmetric: the early side
  // is a window that cannot grow, the later side is the rest of the programme and grows
  // every week, so making it wait costs a delay and nothing permanent.
  subsequentMinMarks: 6,

  // THE FEWEST MARKED PIECES AFTER THE FIRST ONE BEFORE THEIR AVERAGE MAY BE NAMED.
  //
  // Two — `gradeTrendAssessmentCount`, which is the engine's own already-configured opinion
  // about how many marks make a group worth comparing (it reads the last two against the
  // previous two). Borrowed rather than reinvented so the two opinions cannot drift apart
  // the first time somebody retunes one.
  //
  // AND THE OTHER SIDE OF THIS GAP HAS A DENOMINATOR OF EXACTLY ONE, BY CONSTRUCTION. That
  // is stated rather than dressed up with a fake symmetric guard: "the first assessment" is
  // one piece of work, so `firstAssessmentGap` is a single observation against a mean and
  // not a comparison of two means. No floor can exist on that side, which is a limit of the
  // figure and is a further reason it raises no code — a caseload entry resting on one mark
  // is the pattern-from-one-data-point failure `lateSubmissionMinPieces` exists to prevent.
  subsequentMinGrades: 2,
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/** A YYYY-MM-DD string this module is prepared to treat as a date.
 *
 *  TWO CHECKS, AND THE SECOND IS NOT THE ONE THE NEIGHBOURING MODULES USE.
 *
 *  The regex is not decoration, and sessions.js gives the reason: `Date.parse` accepts
 *  "2026-8-4" and a dozen other shapes, and every window test in this file is a STRING
 *  comparison, where "2026-8-4" sorts before "2026-10-01" and after "2026-07-31" — a
 *  silently wrong window rather than a loud failure.
 *
 *  The second check is a ROUND TRIP, not `Number.isFinite(Date.parse(...))`, and the
 *  difference is a real defect rather than a stylistic preference. The ECMAScript Date
 *  Time String Format validates the SHAPE of a day field (01-31) and not the day itself,
 *  so `Date.parse("2026-02-31T00:00:00Z")` does not fail — it succeeds and silently rolls
 *  forward to the 3rd of March. A finite-parse guard therefore accepts an impossible date
 *  and this module would build its whole window three days later than the string says,
 *  with a confident percentage and a plausible-looking `earlyWindowEndsOn` on the row.
 *  Formatting the parsed instant back out and requiring it to equal the input is what
 *  catches the roll-forward. A test caught this; the guard was written the other way first.
 *
 *  THE TWO CHECKS OVERLAP, AND A MUTATION RUN CONFIRMED IT: deleting the regex alone
 *  changes no answer, because `toISOString().slice(0, 10)` always yields exactly ten
 *  characters in YYYY-MM-DD shape, so equality with the input already implies the pattern.
 *  Deleting BOTH breaks immediately. The regex stays for two reasons that are not
 *  behavioural — it states the accepted shape where a reader looks for it, and it rejects
 *  the common wrong shapes without allocating a Date — so do not "simplify" it away on the
 *  grounds that a test still passes without it.
 */
const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === s;
};

/** YYYY-MM-DD, `days` after `iso`. Arithmetic on a UTC midnight, so it never drifts across
 *  a BST boundary the way a local Date would — the bug vle/isoDate.js documents at length.
 *  Null for anything unparseable, so a caller cannot build a window out of nonsense. */
function shiftDays(iso, days) {
  if (!isDate(iso) || !isNum(days)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const out = d.toISOString().slice(0, 10);
  return isDate(out) ? out : null;
}

/**
 * A percentage and a denominator, under the college's own attendance model.
 *
 * WHY THIS IS PARTLY DUPLICATED FROM metrics.summariseAttendance RATHER THAN IMPORTED.
 *
 * A college chooses between two models and `settings.js` stores the choice:
 *   "points"  P=2, L=1, E=1, A=0 — what the Attendance % tab already displays
 *   "binary"  present or not — what a provider reporting physical attendance means
 *
 * The opening figure MUST use whichever one the college chose, because its entire purpose
 * is to be compared against `overallAttendance` on the same screen, and two definitions of
 * a percentage on one screen is how they drift (assessmentType.js says exactly this about
 * re-deriving `pct` from marks and maxMarks).
 *
 * The obvious move — import `summariseAttendance` from metrics.js — is refused because
 * metrics.js requires the Prisma client, and importing it here would drag a database into
 * a module whose first line promises there is not one. The next move — import
 * `../attendance` and use `summarise` — silently ignores the binary college.
 *
 * So: the POINTS model has exactly one definition and it is `attendance.summarise`, called
 * rather than retyped. Only the binary branch is duplicated, line for line with
 * metrics.summariseAttendance, and it is four lines with no thresholds in it. `isStatus`
 * comes from the shared module too, so the set of valid statuses also has one definition.
 */
function summarisePct(marks, mode) {
  if (mode !== "binary") {
    const s = attendance.summarise(marks);
    return { marked: s.marked, pct: s.pct };
  }
  let present = 0, marked = 0;
  for (const m of marks) {
    if (!attendance.isStatus(m.status)) continue;
    marked += 1;
    if (m.status === "P") present += 1;
  }
  // Null rather than 0 with nothing marked, for the reason every other rate here is null:
  // a register nobody took is not an absence.
  return { marked, pct: marked > 0 ? Math.round((present / marked) * 1000) / 10 : null };
}

/* -------------------------------------------------------------------------- */
/* Attendance in the opening window, and the gap against everything after it   */
/* -------------------------------------------------------------------------- */

/**
 * How the student attended in the first `earlyWindowDays` of the programme, how they have
 * attended since, and the signed difference.
 *
 * THE SIGN CONVENTION IS `subsequent - early`, SO POSITIVE MEANS RECOVERED. Written down
 * because an unstated sign convention gets flipped in a refactor by somebody reading the
 * subtraction and not the meaning, and a flipped sign here would turn every recovery into
 * a collapse on the screen. It matches `attendanceSlope`, which is `recent - prior` and is
 * also positive-is-improving, so the two figures point the same way on one row.
 *
 * MARKS DATED BEFORE `programmeStartOn` LEAVE BOTH SIDES and are counted separately.
 * A mark before the cohort started is an induction or taster session, a student transferred
 * in from another cohort, or a start date typed wrong. Counting it as early would make the
 * window's lower bound effectively "the earliest mark", which is TRAP 1's forbidden
 * fallback arriving through the back door. Counting it as subsequent is worse still: it
 * would put a pre-start observation on the AFTER side of a comparison about what happened
 * after the start. So it leaves both, and `preStartMarked` is returned — a college with a
 * systematically wrong start date shows up as a population with pre-start marks, rather
 * than as a population with mysteriously thin opening windows.
 *
 * @param {Array<{status, date}>} marks  every mark in scope, any order, as metrics.js
 *        already flattens them for tripwires.js and sessions.js
 * @param {string|null} programmeStartOn  YYYY-MM-DD. The cohort's own `startDate`, falling
 *        back to its earliest term — the same derivation `weeksIntoProgramme` uses. NEVER
 *        `Student.createdAt` or `Enrolment.createdAt`; see TRAP 1.
 * @param {object} [opts] spread over EARLY_WINDOW_DEFAULTS; `attendanceMode` is read from
 *        the same config the rest of the pipeline uses.
 */
function earlyAttendance(marks, programmeStartOn, opts) {
  const cfg = { ...EARLY_WINDOW_DEFAULTS, ...(opts || {}) };

  // NULLS, NOT ZEROS, AND THE COUNTS ARE NULL TOO in this branch specifically. With no
  // window there is nothing to have counted IN, so a marked count of 0 would claim we
  // looked at a bounded period and found it empty. Below, where a window exists, 0 is the
  // right answer to the same field. The distinction is the whole of TRAP 4.
  const empty = {
    earlyAttendance: null,
    earlyAttendanceMarked: null,
    subsequentAttendance: null,
    subsequentAttendanceMarked: null,
    earlyAttendanceGap: null,
    earlyWindowEndsOn: null,
    preStartMarked: null,
  };

  // TRAP 1, and this is the line. No start date, no window, no figures — and emphatically
  // no fallback to the earliest mark, which would define the window as "whenever we
  // happened to start looking" and would produce its most confident answer for the students
  // whose records are worst.
  //
  // REDUNDANT WITH THE `!earlyWindowEndsOn` BACKSTOP BELOW, and a mutation run confirmed
  // that deleting either one alone changes no answer (shiftDays validates its own input, so
  // an unusable start date yields a null end date anyway). Deleting both breaks immediately.
  // This one stays because it is the guard the argument above belongs to: a reader looking
  // for "what happens when the college cannot say when the programme started" must find it
  // stated at the top of the function, not inferred from a helper three calls down.
  if (!isDate(programmeStartOn)) return empty;

  // A window shorter than a day is not a window. Guarded rather than trusted because
  // `earlyWindowDays` is spread in from a caller's config, and settings.js does not yet
  // validate it — a zero or a negative would silently produce a window whose end precedes
  // its start, and every mark would land on the "subsequent" side while the row still
  // carried a confident-looking end date.
  if (!isNum(cfg.earlyWindowDays) || cfg.earlyWindowDays < 1) return empty;

  // MINUS ONE, AND IT MATTERS. The window is inclusive of both ends, so a 28-day window
  // opening on the 1st closes on the 28th. Without the -1 it would close on the 29th, the
  // figure would silently span 29 days, and the four-calendar-weeks argument for the
  // constant would quietly stop being true.
  const earlyWindowEndsOn = shiftDays(programmeStartOn, cfg.earlyWindowDays - 1);
  if (!earlyWindowEndsOn) return empty;

  const early = [], subsequent = [];
  let preStartMarked = 0;

  for (const m of marks || []) {
    // A mark with an unreadable status or an unreadable date cannot be placed and is not
    // guessed at. It leaves both sides, exactly as an unmarked session does.
    if (!m || !attendance.isStatus(m.status) || !isDate(m.date)) continue;
    if (m.date < programmeStartOn) { preStartMarked += 1; continue; }
    if (m.date <= earlyWindowEndsOn) early.push(m); else subsequent.push(m);
  }

  const e = summarisePct(early, cfg.attendanceMode);
  const s = summarisePct(subsequent, cfg.attendanceMode);

  // The two floors, and they are applied to the PERCENTAGES rather than by dropping the
  // marks — so the counts stay truthful about how much evidence there was even where the
  // rate is refused. A reader seeing `earlyAttendance: null` beside
  // `earlyAttendanceMarked: 2` can tell "too thin to say" from "no register at all", and
  // those are different conversations with the person who takes the register.
  const earlyPct = e.marked >= cfg.earlyWindowMinMarks ? e.pct : null;
  const subsequentPct = s.marked >= cfg.subsequentMinMarks ? s.pct : null;

  return {
    earlyAttendance: earlyPct,
    earlyAttendanceMarked: e.marked,
    subsequentAttendance: subsequentPct,
    subsequentAttendanceMarked: s.marked,
    // Both sides or nothing. "We did not look" and "nothing changed" must not share a
    // number — the argument tripwires.js makes for a null `attendanceSlope` when either of
    // its windows is thin, and it is the same failure here with a longer memory attached.
    earlyAttendanceGap: isNum(earlyPct) && isNum(subsequentPct)
      ? round1(subsequentPct - earlyPct)
      : null,
    // STORED SO THE FIGURE IS SELF-DESCRIBING AND SO COMPLETENESS IS DERIVABLE. This is
    // TRAP 2's answer and TRAP 3's evidence in one field: the screen compares it against
    // today to label a still-open window provisional, and an auditor reading a row three
    // years later can see the exact bound the percentage was taken over rather than having
    // to trust that the constant has never been retuned.
    //
    // The window's START is deliberately NOT returned: it is the cohort's own `startDate`,
    // already stored on `Cohort` and shared by every student in it, and a per-student copy
    // would be a second source of truth for a fact that has one. The END cannot be
    // recovered from anything else, because it depends on a platform constant a college
    // could change.
    earlyWindowEndsOn,
    preStartMarked,
  };
}

/* -------------------------------------------------------------------------- */
/* The first marked piece, against everything marked after it                  */
/* -------------------------------------------------------------------------- */

/**
 * The first assessment this student had marked, and how it compares to the average of
 * everything after it.
 *
 * WHY THIS IS A DISTINCT PREDICTOR FROM `averageGrade`, WHICH IS THE OBVIOUS OBJECTION.
 * `averageGrade` CONTAINS the first assessment, so on a student with four marks the mean
 * is a quarter made of the thing it would be compared against and cannot be far from it.
 * The average here EXCLUDES the first piece, which is the entire trick: it makes "did they
 * start badly and then find their feet" answerable, and that is a different question from
 * "are they doing well", which the mean already answers.
 *
 * ORDERED BY DUE DATE, NOT BY `gradedOn`, AND THAT IS THE SHARP EDGE.
 *
 * "First" needs an ordering, and this directory already contains a signal whose only job is
 * to say that the obvious ordering cannot be trusted: `TRIP_TREND_UNRELIABLE` fires when a
 * tutor marks a term's work in one sitting, because every grade then carries the same
 * `gradedOn` and "recent" is decided by the order rows were typed. An ordering that can be
 * decided by typing order cannot decide which assessment came FIRST — and unlike the grade
 * trend, this figure is written down as a permanent fact about how somebody started.
 *
 * `dueDate` is what the CURRICULUM says came first. It does not move when marking is late,
 * it does not collapse when a term's work is marked in one sitting, and it is stable across
 * runs. Its own failure mode — a shared first deadline — is DETECTED AND REFUSED below
 * rather than resolved arbitrarily.
 *
 * A TIE ON THE EARLIEST DUE DATE RETURNS NULL. Averaging the tied pieces was considered and
 * rejected: "the first assessment" is one piece by definition, and a mean of two compared
 * against a mean of the rest is a different figure wearing this one's name — it is the
 * early/later gap again, on grades, with an arbitrary boundary. If the sequence has no
 * first element then there is no first assessment, and that is the honest answer.
 *
 * WHAT THE CALLER MUST PASS, AND IT IS NOT `Assessment.dueDate` RAW.
 * `dueDate` must be `adjustments.effectiveDeadline(...).due` — the date the college
 * actually decided, which an extension moves later. That is in the "WHAT the college
 * decided" half of the mitigating-circumstances split, never the "why", so this layer may
 * read it. And a piece whose claim state is EXCLUDED must be OMITTED from the array
 * entirely rather than passed with a null date: a suppressed assessment leaves BOTH sides
 * of every fraction, and a null date here would merely make it unplaceable, which is a
 * different and quieter thing. Where the first piece is suppressed, this figure describes
 * the first JUDGEABLE piece — which is the correct reading and is worth knowing when
 * reading the number.
 *
 * NO INSTITUTION PROBE, AND THE ABSENCE IS DELIBERATE. Every neighbouring module carries
 * one, so its absence must not read as the repeated bug CLAUDE.md warns about. Those probes
 * exist to stop a dimension the college does not record AT ALL from being reported as a
 * confident ZERO — no "L" acronym becoming a 0.0% lateness rate. Here a college that dates
 * no assessments produces no placeable grades and every figure comes back NULL, which is
 * already the fail-safe direction; a probe could only turn null into null. `undatedGradeCount`
 * is returned so that institution-wide state is legible on the row instead of being
 * inferred from a column of blanks.
 *
 * @param {Array<{pct, dueDate}>} grades  every in-scope marked piece, any order, as
 *        percentages of their own maxMarks — the same `pct` metrics.js already computes for
 *        `weightedGrade`, taken rather than re-derived.
 * @param {object} [opts] spread over EARLY_WINDOW_DEFAULTS.
 */
function firstAssessment(grades, opts) {
  const cfg = { ...EARLY_WINDOW_DEFAULTS, ...(opts || {}) };

  const empty = {
    firstAssessmentPct: null,
    firstAssessmentOn: null,
    subsequentAverageGrade: null,
    subsequentGradeCount: null,
    firstAssessmentGap: null,
    undatedGradeCount: null,
  };

  const list = (grades || []).filter((g) => g && isNum(g.pct));
  // Nothing marked is not a clean start. Counting a first-assessment score of zero for a
  // student nobody has marked yet is the same error as scoring their attendance at 0, and
  // `undatedGradeCount` stays null because there was no grade to fail to date.
  if (!list.length) return empty;

  const placeable = list.filter((g) => isDate(g.dueDate));
  // A count of grades we could not place: zero once there is at least one grade and all of
  // them carry a date. Measurable, so a number rather than a null — the same rule the
  // marked counts follow above.
  const undatedGradeCount = list.length - placeable.length;
  if (!placeable.length) return { ...empty, undatedGradeCount };

  const sorted = placeable.slice().sort((a, b) => (
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0
  ));

  const firstAssessmentOn = sorted[0].dueDate;

  // THE TIE GUARD. Two pieces sharing the earliest deadline means the sequence has no first
  // element, and picking one of them would make a permanent record out of whichever order
  // Postgres happened to return the rows in. Refused; see the header.
  if (sorted.length > 1 && sorted[1].dueDate === firstAssessmentOn) {
    return { ...empty, undatedGradeCount };
  }

  const firstAssessmentPct = round1(sorted[0].pct);
  const later = sorted.slice(1);

  // The floor on the LATER side only, because the early side is one piece by construction
  // and no floor can exist there. Stated in the constant, and it is why this raises no code.
  const subsequentAverageGrade = later.length >= cfg.subsequentMinGrades
    ? round1(later.reduce((acc, g) => acc + g.pct, 0) / later.length)
    : null;

  return {
    firstAssessmentPct,
    // A DATE, not "assessment 1 of 6" and not a day count — the deadline the piece was
    // judged against is true for ever, and a position in a sequence changes the moment
    // another assessment is added to the unit.
    firstAssessmentOn,
    subsequentAverageGrade,
    subsequentGradeCount: later.length,
    // Same sign convention as the attendance gap: positive means they improved on their
    // opening. One row, two gaps, one direction of travel — a reader must not have to
    // remember which way each of them points.
    firstAssessmentGap: isNum(subsequentAverageGrade)
      ? round1(subsequentAverageGrade - firstAssessmentPct)
      : null,
    undatedGradeCount,
  };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   marks            {Array<{status, date}>}  every attendance mark in scope, any order.
 *                    The RAW marks, not the rate-adjusted ones: a session an approved
 *                    mitigating-circumstances claim excuses is still a session the student
 *                    was not at, and "how did they start" is exactly the kind of thing a
 *                    claim explains rather than erases — the reason sessions.js and
 *                    timetable.js read the raw list too.
 *   grades           {Array<{pct, dueDate}>}  every in-scope marked piece, any order,
 *                    EXCLUDED pieces omitted and `dueDate` already the effective deadline.
 *                    See firstAssessment's header.
 *   programmeStartOn {string|null} YYYY-MM-DD, the cohort's own start date. REQUIRED for
 *                    any attendance figure; null yields nulls and never a guess.
 *
 * There is deliberately NO `today` (see TRAP 3), no `weeksIntoProgramme` (see TRAP 7) and
 * no institution probe (see firstAssessment). Each absence is argued rather than incidental.
 *
 * @param {object} [config] a settings config, spread over EARLY_WINDOW_DEFAULTS. Only
 *        `attendanceMode` is read from it today; the rest of the tunables live in the
 *        defaults above until somebody wires them into settings.js.
 * @returns figures plus `codes`, which is ALWAYS empty — see TRAP 5.
 */
function evaluate(raw, config) {
  const cfg = { ...EARLY_WINDOW_DEFAULTS, ...(config || {}) };
  const input = raw || {};

  const attend = earlyAttendance(input.marks || [], input.programmeStartOn || null, cfg);
  const first = firstAssessment(input.grades || [], cfg);

  return {
    ...attend,
    ...first,
    // A NEW ARRAY EVERY CALL, never a shared constant. The caller concatenates this into
    // `riskDriverCodes`, and handing out one frozen-by-convention array would let a caller
    // that pushed into it corrupt every subsequent student in the chunk. Cheap insurance
    // against a bug that would be invisible until it was institution-wide.
    codes: [],
  };
}

module.exports = {
  evaluate, earlyAttendance, firstAssessment, summarisePct, shiftDays,
  EARLY_WINDOW, EARLY_WINDOW_CODES, EARLY_WINDOW_DEFAULTS,
};
