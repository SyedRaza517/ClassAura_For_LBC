// Timetable: is the SHAPE OF THE TEACHING DAY the reason this student is not there?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments — the same seam
// as tripwires.js, sessions.js, coverage.js and engine.js, and for the same reason: these
// are lines a college will be asked to defend at an appeal, so they have to be checkable
// without standing up an institution's worth of fixtures.
//
// WHAT THIS ASKS THAT NOTHING ELSE ASKS.
//
// Every existing attendance figure describes the student's relationship to the register.
// This one describes the register's relationship to a bus timetable. Three shapes of a
// teaching day, each with a concrete and cheap remedy:
//
//   * A NINE O'CLOCK START. The fix is a timetable change, a later cohort, or a
//     conversation about the first bus. It is the single most common thing a further
//     education student cannot do, and it is invisible in a percentage.
//   * A SIX-HOUR DAY. The fix is a split week, or knowing that the reason is childcare
//     pick-up at three.
//   * A TWO-HOUR HOLE IN THE MIDDLE. A student with nowhere to be between twelve and
//     three goes home, and does not come back. The fix is a room, a compacted day, or a
//     bus pass that lets them leave and return.
//
// None of the three can be read off any figure the pipeline already stores, and the
// difference between them matters: they have different fixes and they are argued to
// different people. A tutor argues the first, a curriculum manager the second and third.
//
// WHAT THIS DELIBERATELY DOES NOT RE-REPORT — and the closest neighbour is very close.
//
//   * `firstSessionAbsenceRate` / `laterSessionAbsenceRate` (tripwires.firstSessionAbsence)
//     split a multi-session day into its first register and the rest, and the schema
//     comment states the purpose exactly: separating "cannot get here" from "not engaged".
//     That is the CLOSEST thing here, and the relationship to each function below is
//     stated rather than left for a reader to work out:
//       - earlyStartShape does not re-derive it. It looks ONLY at the first sitting of
//         each day — the population firstSessionAbsenceRate reports as a single number —
//         and splits THAT by clock time. "The first register is the bad one" and "the
//         first register is bad when it is at nine" are different sentences with
//         different remedies, and the pair cannot say the second: a college whose days
//         all start at nine and a college whose days all start at two produce identical
//         firstSessionAbsenceRates.
//       - gapShape is the same operation on the other half. `laterSessionAbsenceRate`
//         pools every non-first session of every multi-session day; gapShape PARTITIONS
//         exactly that population by whether a long idle gap preceded the session. The
//         existing figure is, arithmetically, a weighted mean of the two numbers gapShape
//         separates — which is precisely why it cannot see the effect.
//       - dayLengthShape steps outside the pair altogether: its unit of observation is a
//         DAY, not a session, and its outcome is "did not come in at all", which neither
//         half of the pair can express.
//   * `worstAbsenceWeekday` / `weekdayAbsenceGap` (sessions.dayOfWeekShape) is WHICH DAY.
//     This is WHAT SHAPE the day is. They coincide only where a college gives one weekday
//     a distinctive timetable, and where they coincide they agree.
//   * `attendanceRegularity` is a standard deviation of WEEKLY PERCENTAGES; a weekly
//     percentage has thrown away the clock before the figure is computed.
//   * `unitAttendanceSpread` splits by UNIT. A unit and a start time are the same slice
//     only at a college that teaches one unit each morning.
//   * `latenessRate` (tripwires.attendanceQuality) is ONE number for the whole register.
//     earlyStartShape reports lateness split by start time, which is a different claim:
//     10% late overall is unremarkable, and 10% overall made of 35% at nine and 2% after
//     lunch is a transport problem with a name.
//   * `registerCoverage` (coverage.js) is about whether the register was TAKEN. Nothing
//     here re-derives it, and every function below reads only marks that exist. See the
//     limitation stated under dayLengthShape, which is the one place that bites.
//
// WHY THERE ARE NO CODES AT ALL. THIS IS THE DESIGN, NOT AN OMISSION.
//
// `TIMETABLE_CODES` is empty and `evaluate()` returns `codes: []` under every input. The
// argument is CLAUDE.md's, applied honestly rather than argued around:
//
//     "A signal that fires for a whole cohort at once is a FIGURE, not a code."
//
// A start time is the most cohort-wide fact in a college. Every student on a unit shares
// its nine o'clock, its six-hour Wednesday and its two-hour hole, so a college that
// timetables badly produces the identical finding for everybody on the timetable at once
// — a hundred caseload rows carrying one reason, which is the same as no caseload. This
// is not a weaker version of sessions.js's weekday argument; it is a stronger one. A
// weekday at least varies between units. A nine o'clock start does not vary at all.
//
// THREE WAYS OUT WERE CONSIDERED AND ALL THREE FAIL:
//
//   1. "Fire only when the gap is large." No. If the cohort's nine o'clock absence is 60%
//      and their afternoon is 5%, every student in the cohort has a 55-point gap. The size
//      of a within-student gap says nothing about whether the student's neighbours share
//      it, because the gap is measured against that same student's own afternoon, which
//      the cohort also shares.
//   2. "Fire only when the OTHER group is clean" — 80% absent at nine, 5% after lunch, so
//      they demonstrably can attend. Still no: that describes every student on a
//      badly-timetabled unit who is otherwise fine, and it is the majority of them.
//   3. "Pair it with something about this student", the workload.js pattern, where every
//      `codes.push` is guarded by the shared half AND by this student's own backlog. That
//      pattern works there because the two halves are independent. Here they are the same
//      half: the thing that would be true of this student and not their neighbours IS the
//      gap, and the gap is what the cohort shares.
//
// The half that would separate them is the REST OF THE COHORT's nine o'clock, and it does
// not live in this module — it lives in cohort.js, built once per run from
// StudentPredictionCurrent, and no per-start-time baseline is threaded through it. Until
// somebody does that, the honest output is a set of figures a human reads next to the
// timetable, exactly as sessions.js reached the same conclusion for its weekday and kind
// axes, coverage.js refuses to add a "coverage unknown" code, and metrics.js refuses to
// raise one on `assessmentsDueSoon`.
//
// An empty vocabulary is exported anyway, rather than omitted, so that the disjointness
// assertion in schema-contract.test.js has something to hold and so the day somebody adds
// a code the structure is already there to stop it colliding. If a code is ever added it
// MUST be `TRIP_`-prefixed, for the reason every other module in this directory states:
// it would be appended to `riskDriverCodes`, the same array engine.js fills from its six
// RED indicators, and a code named `RED_`-anything would read as the engine's own to the
// next person who takes `redIndicatorCount` off the copy rather than off engine.js's
// internal `reds` array — silently wiring the shape of a timetable into a student's band
// through OVR-004.
//
// WHY THERE IS NO `today` PARAMETER.
//
// sessions.consecutiveWeeks takes one and refuses without it, because it measures a RUN
// that must be anchored to the present. Nothing here does. Every figure below is a rate
// over the whole register, and a mark that exists is an observation of a session that
// happened whatever its date. There is no elapsed quantity to compute, so there is
// nothing that would be wrong by tomorrow morning — which is the same rule
// ("store dates, derive day-counts at render") satisfied by having no day-count at all
// rather than by storing a date to subtract from. Taking `today` "for consistency" would
// teach the next reader that the parameter is ceremony, and then it gets dropped from the
// one module where it was load-bearing.
const { isStatus } = require("../attendance");

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// EMPTY, AND DELIBERATELY SO — see the header. Exported as an object rather than skipped
// so the shape matches the other nine modules writing `riskDriverCodes` and so the
// disjointness test has an operand.
const TIMETABLE = {};

const TIMETABLE_CODES = Object.values(TIMETABLE);

// Turning up. Identical to tripwires.ATTENDED and sessions.ATTENDED, and duplicated
// rather than imported for the reason sessions.js gives for duplicating it: this file has
// no other reason to depend on either of them, and a shared constants module would be a
// change to five files for one line.
//
// L IS ATTENDANCE HERE. A late student was in the room, and a shape built on treating a
// late arrival as a disappearance would find patterns in the traffic. That is also
// exactly why earlyStartShape reports lateness SEPARATELY rather than folding it in: for
// a nine o'clock start, arriving at 09:20 is the same phenomenon as not arriving, and a
// module that could only count absence would be structurally blind to the commonest form
// of the very thing it exists to find.
const ATTENDED = new Set(["P", "L"]);

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/** A YYYY-MM-DD string this module is prepared to treat as a date.
 *
 *  Dates are used ONLY as a grouping key here — a day is a bucket of sessions — so a
 *  loose parse makes two spellings of one day into two days, splitting a six-hour day
 *  into two three-hour ones and silently halving its length. Same predicate sessions.js
 *  uses, for a related but not identical reason (there it is about string ORDERING).
 *
 *  HONESTLY: the regex is belt and braces over the parse rather than the load-bearing
 *  half of it. `Date.parse("2026-3-01T00:00:00Z")` is NaN in V8 — the ISO grammar wants
 *  padded components — so the appended `T00:00:00Z` already refuses the shapes the regex
 *  names, and a mutation pass that loosened the regex to `\d{1,2}` killed no test. It
 *  stays because the parse's leniency is an engine detail nobody should have to re-derive
 *  to know what this module accepts, and because "2026-03-01T05:00" reaching a bucket key
 *  is a real shape to refuse. */
const isDate = (s) =>
  typeof s === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

/* -------------------------------------------------------------------------- */
/* Clock arithmetic — integers, never a Date                                   */
/* -------------------------------------------------------------------------- */

// HH:MM, 24-hour, and nothing else. Anchored at both ends so "09:00:00", "9:00", "0900"
// and "09:00 " are all refused rather than half-read.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Minutes past midnight for an "HH:MM" string, or NULL for anything this module will not
 * treat as a time.
 *
 * WHY THIS IS INTEGER ARITHMETIC AND NOT A `Date`.
 *
 * The obvious implementation — `new Date("2026-03-29T09:00")` for each end and subtract —
 * is wrong here in three separate ways, and only the third is obvious:
 *
 *   1. A date-TIME with no offset parses as LOCAL time in JavaScript, while a date-ONLY
 *      string parses as UTC. That asymmetry is the single most misremembered thing about
 *      JavaScript dates and it is why every date helper in this codebase appends
 *      `T00:00:00Z`. A local parse makes the answer depend on the host's zone, and
 *      STATUS.md records D8 — the 08:00 notifications firing at 09:00 through BST — as
 *      exactly that bug. `src/clock.js` pins APP_TIMEZONE precisely because the host clock
 *      is not the college's day.
 *   2. Worse, a Date-based subtraction is right on 363 days a year and wrong on two. On
 *      the British clock-change Sundays a wall-clock span of 09:00 to 14:00 is four or six
 *      hours of elapsed time, not five. But these are TIMETABLE times: a session listed
 *      09:00–14:00 is five hours of teaching in the room whatever the clocks did that
 *      morning, and a student's day is measured in wall clock, not in elapsed seconds.
 *      Converting to instants would introduce a physical fact that has no business in the
 *      answer, and it would be introduced twice a year, in one direction each time.
 *   3. It is slower and allocates, on a path that runs for every mark of every student in
 *      a chunk of 200.
 *
 * So the class of bug is removed rather than guarded: there is no Date object anywhere in
 * this file, nothing for a later reader to change one half of, and the tests can pin the
 * clock-change weekends knowing the answer cannot depend on them.
 *
 * A time this refuses is null, never 0. Zero is midnight — the earliest possible start —
 * so a malformed string coerced to 0 would classify the session as the earliest start of
 * its day and as an early start, which is a confident answer manufactured from a typo.
 */
function minutesOf(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = TIME_RE.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a LATENESS question without an institution-wide answer to "does this
 * college record lateness at all?"
 *
 * This is CLAUDE.md's most repeated bug in this area, and it is repeated here because the
 * guard has to be re-established every time a new module reaches for an "L". The Moodle
 * importer maps attendance statuses by acronym from whatever set the college's plugin
 * defines; a plugin with no "L" produces zero late marks for every student who has ever
 * enrolled, and the resulting lateness rate of exactly 0.0% is not "never late", it is
 * "not recorded". Shipping it as a clean sheet tells a comforting lie about an entire
 * institution simultaneously — and here it would tell it about the ONE dimension that
 * makes an early-start finding actionable.
 *
 * IT CANNOT BE COMPUTED FROM THE CHUNK. `gather()` runs on chunks of 200 and the ordinary
 * incremental path scores the handful of students `markStale` flagged, often exactly one.
 * One student with no late marks is entirely ordinary; a college with no late marks is a
 * college without the concept. The two are the same array at chunk size. metrics.js
 * already answers this once per run, unfiltered by student and hoisted out of the chunk
 * loop, as `lateRecorded` — so wiring costs nothing but passing it down.
 *
 * WHY IT THROWS RATHER THAN DEFAULTING TO SILENCE. The existing guards in tripwires.js
 * take a boolean that defaults to falsy; a missing flag there costs one code that does not
 * fire. Here a falsy default costs the whole lateness dimension permanently and silently
 * — null for every student at every college, no test failing, no row looking wrong. A
 * feature that quietly does nothing is not discoverable by reading the output, so this
 * fails the way db.js fails a query with no tenant context: loudly, at the first call, in
 * the caller's own test run.
 *
 * WHY IT IS POSITIONAL rather than a key on `opts`, matching coverage.registerCoverage,
 * workload.carriedBacklog and sessions.kindShape: an options bag is the thing a caller
 * assembles from a config object and forgets to add to, and `earlyStartShape(marks, opts)`
 * would still be a legal-looking call.
 *
 * WHY THERE IS NO PROBE FOR `endTime`, WHICH IS THE OTHER MISSING FIELD. The two look
 * alike and are not. "Does this college record lateness" is a genuine per-institution
 * question whose answer differs between colleges and is invisible in a chunk. `endTime` is
 * NOT NULL on HndSession, so every session at every college has one; if it is absent from
 * a mark, the SELECT omitted it, uniformly, for every student in every chunk of every
 * college on that deployment. There is no per-student/per-institution ambiguity to guard
 * against, so a probe would be ceremony — and sessions.js is explicit that a ceremonial
 * probe teaches the next reader that probes are ceremony, after which it gets dropped from
 * the one place it was load-bearing. What the missing field gets instead is a degradation
 * to null and a COUNT (`daysWithoutSessionEnd`), so the unwired state is legible on the
 * row rather than silent.
 *
 * @param {{lateRecorded:boolean}} institution
 */
function assertInstitutionProbe(institution, fnName) {
  if (!institution || typeof institution.lateRecorded !== "boolean") {
    throw new TypeError(
      `${fnName}: institution.lateRecorded must be a boolean — an institution-wide probe `
      + "result, decided once per run and never derived from one student's rows",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Platform defaults, in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change and a config key nothing reads is worse than no key at all.
// Every function takes an `opts`/`config` spread OVER these, so the day they move into
// DEFAULTS the callers do not change.
//
// TWO KINDS OF NUMBER LIVE HERE AND THEY ARE CHOSEN BY DIFFERENT ARGUMENTS.
//
// The THRESHOLDS (what counts as early, long, a gap) are each placed deliberately in the
// EMPTY SPACE BETWEEN the values a real timetable contains, never on one of them. A
// college types times on the hour and the half hour, so a threshold sitting exactly on a
// common value makes the entire classification — and therefore the entire finding — turn
// on whether the comparison is `<` or `<=`, which is the sort of thing that gets flipped
// in a refactor by somebody who reads the operator and not the constant. A threshold in
// the gap cannot be flipped into a different answer.
//
// The FLOORS are minimum denominators and are argued against the ones settings.js already
// carries — slopeMinMarks 3, disperseMinMarks 4, minMarksForRate 6, weekdayMinMarks 4 —
// rather than picked for looking round.
const TIMETABLE_DEFAULTS = {
  /* --- early start ------------------------------------------------------- */

  // A DAY WHOSE FIRST SESSION STARTS STRICTLY BEFORE THIS IS AN EARLY DAY.
  //
  // 570 = 09:30, and the half hour is the whole point. Colleges start teaching at 09:00
  // or at 10:00; almost nothing starts at 09:30. So the boundary sits in the empty space
  // between the two shapes, a 09:00 start is early, a 10:00 start is not, and `<` versus
  // `<=` cannot change a single real answer. A threshold of 540 (09:00) would put the
  // most common start time in the country exactly on the boundary, and the entire figure
  // for every student at every nine-o'clock college would then depend on one character.
  //
  // Minutes past midnight rather than an hour number, because settings.js validates
  // numbers with checkNumber and a string "09:30" would need a validator that does not
  // exist — and because an hour number cannot express a half-hour boundary at all, which
  // is the one thing this constant needs to do.
  earlyStartBeforeMinutes: 570,

  // THE FEWEST FIRST-SITTING MARKS ON EACH SIDE BEFORE EITHER RATE MAY BE NAMED.
  //
  // Six, which is minMarksForRate, and SYMMETRIC — the same number on both sides. That
  // symmetry is the deliberate divergence from sessions.sliceShape, which uses 4 on the
  // slice and 6 on the pooled rest. It can do that because its "rest" is the whole
  // register minus one weekday and is therefore the big side by construction. Here the
  // split is a genuine binary and either side can be the small one: a student timetabled
  // at nine four mornings a week and at two on the fifth has an "other" side of one day.
  // An asymmetric floor would mean the module answered or refused depending on which way
  // round the timetable happened to fall, which is not a property anybody could defend.
  //
  // NOT 4. Four is disperseMinMarks, the floor for a slice reported ALONGSIDE its
  // siblings, where being one of several is itself context. These two numbers are reported
  // as a contrast and nothing else stands next to them, so each carries the weight
  // minMarksForRate was chosen for.
  earlyMinMarks: 6,

  // THE FEWEST DISTINCT DAYS ON EACH SIDE.
  //
  // Four, matching disperseMinMarks, and it is a SECOND floor rather than a replacement
  // because marks within a day are not independent observations. It is close to vacuous
  // for this function — the first sitting of a day is normally one register, so marks and
  // days are nearly the same count and the mark floor binds first — and it is retained
  // anyway for two reasons: a day CAN carry two parallel registers at the same earliest
  // start (see earlyStartShape, which counts both), and the floor is the same guard
  // gapShape genuinely needs, so having one shape of floor across all three functions
  // means a reader who understands one understands all three. A mutation pass will show
  // this one surviving here; that is expected and it is recorded rather than hidden.
  earlyMinDays: 4,

  /* --- day length -------------------------------------------------------- */

  // A DAY WHOSE SPAN IS THIS OR MORE IS A LONG DAY.
  //
  // 330 = five and a half hours, measured from the start of the first session to the end
  // of the last. Between the two shapes a college timetable actually produces: a half day
  // (three or four hours) and a full day (six hours or more). Nothing real is 5h30, so the
  // classification does not turn on whether a lecturer typed 16:00 or 16:30, and — as with
  // the early threshold — `>=` versus `>` cannot change an answer.
  //
  // NOT 300 (five hours), which is a 09:00–14:00 day and therefore a value a timetable
  // genuinely contains. NOT 360 (six hours), which would classify the 09:00–15:00 day —
  // long enough to be the whole problem for a student collecting a child at three — as
  // short.
  longDayMinMinutes: 330,

  // THE FEWEST DAYS ON EACH SIDE BEFORE EITHER RATE MAY BE NAMED.
  //
  // FIVE, and this is the only floor in the file that is not lifted from settings.js.
  // The other two functions carry a pair — six observations AND four days — because their
  // unit of observation is a session and several sessions share a day. Here the unit of
  // observation IS the day: a whole six-hour day collapses to one yes-or-no, which is the
  // right measurement (see dayLengthShape) and which means the two floors collapse into a
  // single number.
  //
  // That single number takes the HIGHER of the two roles rather than the lower. Rounding
  // down to four would leave the question with the smallest denominator by construction as
  // the LOOSEST guarded of the three, which is backwards; taking six would make the
  // headline figure the one that almost never clears its floor at a college teaching two
  // days a week. Five sits between them, and at five days one missed day reads as 20%
  // rather than as 25% or 33%.
  dayLengthMinDays: 5,

  /* --- gaps -------------------------------------------------------------- */

  // AN IDLE GAP OF THIS MANY MINUTES OR MORE, BETWEEN THE END OF ONE SESSION AND THE
  // START OF THE NEXT, MAKES THE SESSION AFTER IT A "RETURN AFTER A LONG GAP".
  //
  // 120 — two hours. Below it, and the group stops being about timetable holes: colleges
  // schedule 30, 45 and 60 minute lunch breaks, so a threshold of 60 or 90 would classify
  // nearly every full teaching day at nearly every college as gappy, which is a fact about
  // the sector rather than about a student and would leave the comparison side empty. At
  // 120 the group means what the sentence means — dead time the student has nowhere to
  // spend, long enough that going home is the rational choice and long enough that coming
  // back is a second journey.
  //
  // NOT 180. Three hours is the vivid version of the story and it is rare enough that the
  // group would essentially never clear its floor, which is a signal that cannot fire
  // dressed as a strict one.
  //
  // Again placed off the common values: lunch is 30/45/60, a hole is 120 or more, and
  // nothing is timetabled to leave exactly two hours by design.
  longGapMinMinutes: 120,

  // The same pair of floors as the early-start question, and identical values on purpose:
  // it is the same shape of question (a partition of session-level marks into two groups
  // that each get a rate), and inventing a second opinion for it would leave two numbers
  // to drift apart with no reason ever recorded for why they differed.
  //
  // Here the DAY floor is the one that genuinely binds. A single long day carrying three
  // registers after the gap would clear a six-mark floor with two days, and "absent 80% of
  // the time after a long gap" drawn from two afternoons is a claim about a fortnight
  // wearing a pattern's clothes. Four days is four independent decisions to go home.
  gapMinMarks: 6,
  gapMinDays: 4,
};

/* -------------------------------------------------------------------------- */
/* The shared two-group comparison                                             */
/* -------------------------------------------------------------------------- */

/**
 * The engine behind all three shapes: given observations already labelled with a boolean
 * group and an outcome, how far apart are the two groups?
 *
 * WHY A BINARY COMPARISON RATHER THAN sessions.sliceShape's WORST-AGAINST-THE-REST.
 *
 * They answer different shapes of question and the difference is not stylistic.
 * sliceShape is given N unordered categories — seven weekdays, a handful of session kinds
 * — and must first DISCOVER which is worst, which is why it needs a superlative, a
 * tie-break, a minimum number of measurable slices, and a note about the maximum of seven
 * noisy numbers being noisier than the maximum of three. Here the two groups are named in
 * advance by a threshold: there is no superlative to compute, nothing to discover and no
 * multiple-comparison problem, so importing sliceShape would mean labelling every
 * observation with the string "early"/"late" and then asking a function to work out which
 * of two things is bigger. The two functions share no interesting logic beyond
 * "accumulate and divide", and a shared abstraction over both would have to carry
 * sliceShape's superlative machinery through a call site that has no use for it.
 *
 * ABSENCE HERE MEANS "NOT IN THE ROOM" — A OR E — AND THAT IS DELIBERATE.
 *
 * The same choice sessions.js makes and for the same reason: an excused nine o'clock is
 * still a nine o'clock they were not taught. A student with a standing caring commitment
 * on Tuesday mornings shows up here, and that IS the point — it is a timetable
 * conversation and it is one the college can actually have. Whether the absence was
 * explained is a different question, already answered once by `unexplainedShare`. It
 * diverges from tripwires' absence streak, which counts A only, because that signal asks
 * "have we lost contact" and this one asks "was the shape of the day the obstacle".
 *
 * AN OBSERVATION WITH NO GROUP LEAVES BOTH SIDES and is counted rather than dropped,
 * exactly as workload.deadlineClusters counts undated assessments and sessions.sliceShape
 * counts unkeyed marks. It is not evidence about either group and it is not evidence that
 * either group is clean; the count is returned so a caller can see how much of the
 * register was invisible.
 *
 * BOTH SIDES MUST CLEAR BOTH FLOORS OR NEITHER RATE IS REPORTED — not just the gap.
 *
 * This is stricter than sessions.sliceShape, which reports the worst slice's own rate even
 * when the pooled rest is too thin to draw a gap against, and the divergence is argued
 * rather than accidental. There, the slice's rate is independently meaningful: "her Friday
 * rate is 40%" is a sentence about Fridays that stands whether or not the rest of the week
 * is measurable. Here the group label means NOTHING except in contrast. A student every
 * one of whose sessions starts at nine does not have "early sessions"; they have sessions.
 * Reporting 80% under a column named `earlyStartAbsenceRate` would state a contrast that
 * was never drawn, and it would read on the screen as a finding about early starts for a
 * student for whom no other kind of start exists — the strongest possible statement of a
 * comparison nobody made. Null, not 80, and not 100.
 *
 * TWO FLOORS, NOT ONE, BECAUSE MARKS WITHIN A DAY ARE NOT INDEPENDENT. A student who
 * arrives, sees the three-hour hole in their afternoon and goes home produces three absent
 * marks from ONE decision. A mark-count floor alone would let "absent 100% of the time
 * after a long gap" rest on a single afternoon. The day count is also returned, always, so
 * the row can show that a rate rests on four days rather than on twelve marks.
 *
 * THE GAP IS NOT CLAMPED AT ZERO. A negative gap is the honest reading — "the early
 * sessions are the ones they get to" — and clamping would manufacture a tie between that
 * and a student whose day is genuinely flat. coverage.staleness and sessions.sliceShape
 * leave their negatives alone for the same reason.
 *
 * @param {Array<{group:boolean|null, absent:boolean, late:boolean|null, dayKey:string}>} rows
 * @param {{minObservations:number, minDays:number}} floors
 */
function twoGroupShape(rows, floors) {
  const mk = () => ({ marks: 0, absent: 0, late: 0, lateObserved: false, dayKeys: new Set() });
  const inG = mk();
  const outG = mk();
  let unclassified = 0;

  for (const row of rows || []) {
    if (!row) continue;
    if (row.group !== true && row.group !== false) { unclassified += 1; continue; }
    const g = row.group ? inG : outG;
    g.marks += 1;
    if (row.absent) g.absent += 1;
    // A boolean `late` is the caller saying "lateness is meaningful for this question".
    // Anything else — undefined, null — means it is not, and the rate stays null rather
    // than becoming a 0 that reads as "never late". Null is not zero, applied to a
    // dimension rather than to a measurement.
    if (typeof row.late === "boolean") {
      g.lateObserved = true;
      if (row.late) g.late += 1;
    }
    if (typeof row.dayKey === "string" && row.dayKey) g.dayKeys.add(row.dayKey);
  }

  const summarise = (g) => ({
    marks: g.marks,
    days: g.dayKeys.size,
    absent: g.absent,
    late: g.late,
    // The raw arithmetic, always computed when the group holds anything at all — this is
    // the group's OWN denominator, which is at least 1 by construction. Whether it may be
    // REPORTED is the floors' question, below, and the two are kept apart so a test can
    // see a thin group's arithmetic without the module having claimed anything about it.
    absenceRate: g.marks ? round1((g.absent / g.marks) * 100) : null,
    latenessRate: g.marks && g.lateObserved ? round1((g.late / g.marks) * 100) : null,
  });

  const inSummary = summarise(inG);
  const outSummary = summarise(outG);

  const clears = (g) => g.marks >= floors.minObservations && g.dayKeys.size >= floors.minDays;
  const comparable = clears(inG) && clears(outG);

  const base = {
    in: inSummary,
    out: outSummary,
    unclassified,
    comparable,
  };

  if (!comparable) {
    return {
      ...base,
      inRate: null,
      outRate: null,
      gap: null,
      inLatenessRate: null,
      outLatenessRate: null,
      latenessGap: null,
    };
  }

  const bothLate = inSummary.latenessRate !== null && outSummary.latenessRate !== null;

  return {
    ...base,
    inRate: inSummary.absenceRate,
    outRate: outSummary.absenceRate,
    gap: round1(inSummary.absenceRate - outSummary.absenceRate),
    inLatenessRate: bothLate ? inSummary.latenessRate : null,
    outLatenessRate: bothLate ? outSummary.latenessRate : null,
    latenessGap: bothLate ? round1(inSummary.latenessRate - outSummary.latenessRate) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Assembling the days                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Group the marks into teaching days, with each day's sessions carrying parsed times.
 *
 * NO DE-DUPLICATION, AND THAT IS SAFE BY A DATABASE CONSTRAINT RATHER THAN BY HOPE.
 * `AttendanceMark` is `@@unique([sessionId, studentId])`, so for one student the marks on
 * a day ARE that day's sessions, one apiece. `sessionId` is accepted in the input shape
 * and read by nothing here as a result — noted so the next reader does not add a
 * de-duplication pass that silently drops a genuine parallel register.
 *
 * A MARK WITH AN UNRECOGNISED STATUS IS NOT AN OBSERVATION. `isStatus` is the same filter
 * `attendance.summarise()` applies before counting anything, so the two sides of any
 * comparison a caller makes stay in step.
 *
 * A MARK WITH NO USABLE DATE OR START TIME CANNOT BE PLACED IN A DAY AT ALL and is
 * counted, not silently dropped. `date` and `startTime` are both NOT NULL on HndSession,
 * so in practice this counts only marks whose session row failed to join — but the count
 * is what would make that visible rather than making a college look like it teaches
 * fewer days than it does.
 */
function buildDays(marks) {
  const days = new Map();
  let unplaceable = 0;

  for (const m of marks || []) {
    if (!m || !isStatus(m.status)) continue;
    if (!isDate(m.date)) { unplaceable += 1; continue; }
    const startMin = minutesOf(m.startTime);
    if (startMin === null) { unplaceable += 1; continue; }

    // endMin is allowed to be null and that is the whole degradation strategy — see the
    // header of dayLengthShape. An end BEFORE its own start is a data error (a typo, or a
    // session somebody meant to run past midnight) and is treated as unknown rather than
    // as a negative duration: a negative length would classify the day as short with
    // total confidence, which is a wrong answer where null is the true one.
    const rawEnd = minutesOf(m.endTime);
    const endMin = rawEnd !== null && rawEnd >= startMin ? rawEnd : null;

    const day = days.get(m.date) || { date: m.date, sessions: [] };
    day.sessions.push({
      startMin,
      endMin,
      absent: !ATTENDED.has(m.status),
      late: m.status === "L",
    });
    days.set(m.date, day);
  }

  // Sorted by date. NOTHING THIS MODULE RETURNS TODAY DEPENDS ON IT, and that is recorded
  // rather than hidden: a mutation pass removed the sort and every test still passed,
  // because every figure above is an aggregate over sets and counts, which do not care
  // what order they were filled in. It stays for the next output that DOES care. Map
  // iteration order is insertion order, which is the order Postgres happened to return
  // the marks in — the marks query has no ORDER BY — so the first figure that names a day
  // rather than counting them would be non-deterministic between two runs with nothing
  // about the student having changed, which makes a whole row untrustworthy. Cheaper to
  // keep than to remember.
  const ordered = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { days: ordered, unplaceable };
}

/* -------------------------------------------------------------------------- */
/* Does the day start too early?                                               */
/* -------------------------------------------------------------------------- */

/**
 * Is this student worse at getting here when the day starts early?
 *
 * ONLY THE FIRST SITTING OF EACH DAY IS IN SCOPE, AND THAT IS THE CONTROL THAT MAKES THE
 * FIGURE MEAN ANYTHING.
 *
 * The naive version compares "every session starting before 09:30" against "every other
 * session", and it is confounded by exactly the effect `firstSessionAbsenceRate` exists to
 * report: an early session is always the first of its day, while the comparison side is
 * mostly later sessions, which have their own dynamics. That comparison would measure
 * position-in-day and start time mixed together, and would show a gap at a college whose
 * days all begin at ten simply because first sessions are missed more than later ones.
 *
 * Restricting both sides to the first sitting holds position constant. What is left is the
 * clock: among the days this student was expected to start, are the early starts the ones
 * they miss? That composes cleanly with the existing pair rather than competing with it —
 * `firstSessionAbsenceRate` says the first register is the difficult one, and this says
 * which first registers.
 *
 * "THE FIRST SITTING" IS EVERY MARK AT THE DAY'S EARLIEST START TIME, not one chosen mark.
 * Two registers can share a start time — `HndSession` is unique on (unit, date, start), so
 * two units may both begin at nine — and both are evidence about getting there for nine.
 * Defining the group by the earliest START rather than by "the first mark after sorting"
 * also removes the tie-break entirely: there is no ordering to be unstable, no dependence
 * on the order Postgres returned the rows in, and nothing for a `>=` to flip.
 * tripwires.firstSessionAbsence sorts and takes index 0, which needs a stable comparator
 * to be deterministic; this needs none.
 *
 * MARKS THAT ARE NOT AT THE DAY'S EARLIEST START LEAVE BOTH SIDES and are counted as
 * unclassified. They are not evidence about the start of the day.
 *
 * A DAY WITH ONE SESSION IS INCLUDED, unlike in gapShape. Its single session IS the first
 * sitting of the day, and "could they get here for the start" is a question a one-session
 * day answers perfectly well. gapShape excludes single-session days because a gap needs
 * two sessions to exist at all — a different reason, not the same rule applied
 * inconsistently.
 *
 * LATENESS IS REPORTED SEPARATELY AND IS THE POINT OF THIS FUNCTION. For a nine o'clock
 * start, arriving at 09:20 is the same phenomenon as not arriving: a bus, a school run, a
 * night shift that finished at seven. L counts as attendance in the absence rate — a late
 * student was in the room — so a module measuring only absence would be structurally blind
 * to the commonest form of the thing it exists to find. It requires the institution probe
 * because a college whose register has no "L" produces 0.0% for everybody, which is "not
 * recorded" wearing a clean sheet's clothes.
 *
 * @param {Array<{status, date, startTime}>} marks  any order; endTime not needed
 * @param {{lateRecorded:boolean}} institution  REQUIRED — throws without it
 * @param {{earlyStartBeforeMinutes, earlyMinMarks, earlyMinDays}} [opts]
 */
function earlyStartShape(marks, institution, opts) {
  assertInstitutionProbe(institution, "earlyStartShape");
  const cfg = { ...TIMETABLE_DEFAULTS, ...(opts || {}) };

  const { days, unplaceable } = buildDays(marks);

  const rows = [];
  for (const day of days) {
    let earliest = Infinity;
    for (const s of day.sessions) if (s.startMin < earliest) earliest = s.startMin;

    for (const s of day.sessions) {
      if (s.startMin !== earliest) {
        // Not the start of the day. Explicitly unclassified rather than absent from the
        // array, so `unclassified` reports how much of the register this question could
        // not use — the same visibility sliceShape's `unkeyed` gives.
        rows.push({ group: null, absent: s.absent, late: null, dayKey: day.date });
        continue;
      }
      rows.push({
        group: earliest < cfg.earlyStartBeforeMinutes,
        absent: s.absent,
        // Only claimed as a measurable dimension where the college records it at all.
        // Passing `false` for a college with no "L" would make lateObserved true and turn
        // an unrecorded dimension into a confident 0.0%.
        late: institution.lateRecorded ? s.late : null,
        dayKey: day.date,
      });
    }
  }

  const shape = twoGroupShape(rows, {
    minObservations: cfg.earlyMinMarks,
    minDays: cfg.earlyMinDays,
  });

  return {
    earlyStartAbsenceRate: shape.inRate,
    laterStartAbsenceRate: shape.outRate,
    earlyStartAbsenceGap: shape.gap,
    earlyStartLatenessRate: shape.inLatenessRate,
    laterStartLatenessRate: shape.outLatenessRate,
    earlyStartLatenessGap: shape.latenessGap,
    earlyStartDays: shape.in.days,
    laterStartDays: shape.out.days,
    // Marks that were not the first sitting of their day, plus anything buildDays could
    // not place. Not a fault — at a college with six-hour days most of the register lands
    // here by design — but a reader comparing this with the overall mark count should not
    // have to guess why the numbers differ.
    notFirstSitting: shape.unclassified,
    unplaceableMarks: unplaceable,
  };
}

/* -------------------------------------------------------------------------- */
/* Is the day too long?                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Does this student stop coming in on the long days?
 *
 * THE UNIT OF OBSERVATION IS A DAY, AND THE OUTCOME IS "DID NOT COME IN AT ALL".
 *
 * This is the single most important decision in the file and the obvious alternative is
 * wrong in a way that would have been very hard to see on a screen. Counting marks — "what
 * share of the marks on long days are absences, against short days" — carries a
 * systematic bias built into the arithmetic: a long day holds three or four registers, so
 * a student who attends the morning and leaves at lunch scores 50% absent on that day,
 * while a student who misses a one-session short day scores 100%. Long days would
 * therefore look BETTER than short ones for exactly the partial attendance that a long day
 * causes, and the figure would point the wrong way at precisely the colleges with the
 * worst timetables.
 *
 * A per-day yes-or-no removes the bias outright rather than correcting for it: one day,
 * one observation, whether it carried one register or five. And it is the sentence a tutor
 * actually says — "she doesn't come in on the long days" — rather than a fraction of a
 * fraction.
 *
 * "DID NOT COME IN AT ALL" means every mark on that day is A or E: the student appears in
 * the day's register and was in the room for none of it. Partial attendance on a long day
 * counts as coming in, which is deliberate and is the conservative direction — the student
 * DID make the journey, and the reason they left early is a question `gapShape` and
 * `laterSessionAbsenceRate` are better placed to answer than a day-length comparison is.
 *
 * A ONE-SESSION DAY IS A SHORT DAY AND IS INCLUDED, having been excluded from an earlier
 * draft. The reason for excluding it was the mark-count bias above — a one-session day
 * cannot be partially attended, so under per-mark counting it is not comparable with a
 * four-session day. Measuring per day removes that objection completely: "did they come in
 * on 12 March" is the same question whether 12 March held one class or four. What remains
 * is that a one-session day is genuinely the shortest kind of day a timetable can produce,
 * which is exactly what this function is comparing against, so excluding it would remove
 * the cleanest evidence available and would leave the "short" side empty at every college
 * that teaches one session a day — which, on the data in both databases today (32 sessions
 * across 24 dates), is most of them.
 *
 * DAY LENGTH IS THE SPAN FROM THE FIRST SESSION'S START TO THE LAST SESSION'S END, and it
 * is derived from that day's OWN sessions rather than from any timetable template. There
 * is no template to read: `HndSession` rows are what a college generated, and two
 * Wednesdays in the same unit can differ.
 *
 * A DAY WITH ANY MISSING OR UNUSABLE `endTime` HAS NO LENGTH AND LEAVES BOTH SIDES.
 *
 * This is the degradation trap and it is handled by refusing rather than by estimating.
 * Three tempting alternatives, all rejected:
 *   - Take the max over the ends that ARE present. The unknown end could be the latest
 *     one, so this computes a confidently SHORT day from a partially-wired select, which
 *     is a wrong answer where null is the true one.
 *   - Fall back to the last session's START. Systematically understates every day by the
 *     length of its final session, which is roughly the difference between a short day
 *     and a long one, and it would silently make a whole college look short-day.
 *   - Assume a default session length. Inventing a duration model this layer has no
 *     business owning — sessions.js declined to build one for the same reason.
 * `endTime` is NOT NULL on HndSession, so a missing one means the SELECT omitted it (see
 * the note in assertInstitutionProbe on why that is a wiring question and not an
 * institution one). The count is returned as `daysWithoutSessionEnd` so the unwired state
 * is visible on the row: every figure null AND that count equal to the day count says
 * "the field is not being carried", where every figure null on its own would say
 * "this student's timetable is uniform".
 *
 * WHAT THIS CANNOT SEE, stated because it is a real limitation rather than a
 * hypothetical: the day is measured AS THE REGISTER RECORDS IT. A six-hour day whose
 * afternoon register was never taken produces no afternoon marks and reads as a short day.
 * That is coverage.js's question — whether the register was taken at all — and this module
 * deliberately does not re-derive it; a reader should hold `registerCoverage` next to
 * these figures before acting on them.
 *
 * @param {Array<{status, date, startTime, endTime}>} marks  any order
 * @param {{longDayMinMinutes, dayLengthMinDays}} [opts]
 */
function dayLengthShape(marks, opts) {
  const cfg = { ...TIMETABLE_DEFAULTS, ...(opts || {}) };

  const { days, unplaceable } = buildDays(marks);

  const rows = [];
  let daysWithoutSessionEnd = 0;

  for (const day of days) {
    let firstStart = Infinity;
    let lastEnd = -Infinity;
    let complete = true;

    for (const s of day.sessions) {
      if (s.startMin < firstStart) firstStart = s.startMin;
      if (s.endMin === null) { complete = false; break; }
      if (s.endMin > lastEnd) lastEnd = s.endMin;
    }

    if (!complete) {
      daysWithoutSessionEnd += 1;
      // Leaves both sides. `late` is null throughout this function: lateness is a
      // statement about arriving, and the mechanism a long day has is leaving early, not
      // arriving late. Reporting a lateness split here would put two more numbers on the
      // row with no sentence attached to either, and a number nobody can turn into a
      // sentence is a number somebody will eventually turn into the wrong one.
      rows.push({ group: null, absent: false, late: null, dayKey: day.date });
      continue;
    }

    const span = lastEnd - firstStart;
    // EVERY mark on the day, or it is not a fully missed day. `.every` on an empty array
    // is true, but a day exists here only because at least one mark built it, so the
    // vacuous case cannot arise — noted because it is the kind of thing a later reader
    // "fixes" by adding a length check that then changes nothing.
    const missedWholeDay = day.sessions.every((s) => s.absent);

    rows.push({
      group: span >= cfg.longDayMinMinutes,
      absent: missedWholeDay,
      late: null,
      dayKey: day.date,
    });
  }

  const shape = twoGroupShape(rows, {
    // The unit of observation IS the day here, so the observation floor and the day floor
    // are the same number. Passing dayLengthMinDays for both is not a shortcut: setting
    // them differently would be setting one number twice and watching it drift.
    minObservations: cfg.dayLengthMinDays,
    minDays: cfg.dayLengthMinDays,
  });

  return {
    longDayMissedRate: shape.inRate,
    shortDayMissedRate: shape.outRate,
    longDayMissedGap: shape.gap,
    longDaysMeasured: shape.in.days,
    shortDaysMeasured: shape.out.days,
    // The wiring signal. Equal to the total day count means `endTime` is not being
    // carried at all; a handful means a few sessions have odd data.
    daysWithoutSessionEnd,
    unplaceableMarks: unplaceable,
  };
}

/* -------------------------------------------------------------------------- */
/* Is there a hole in the middle of the day?                                   */
/* -------------------------------------------------------------------------- */

/**
 * When this student has to wait a long time between two classes, do they come back?
 *
 * THE UNIT OF OBSERVATION IS A SESSION THAT SOMEBODY HAD TO RETURN FOR — every session
 * that is not the first sitting of its day — and it is classified by the size of the idle
 * gap immediately before it. The two groups are "came back after a long gap" and "came
 * back after a short one".
 *
 * WHY THAT IS THE RIGHT OUTCOME AND "MISSED THE WHOLE DAY" IS NOT. The story a gap tells
 * is specific: the student came in for the morning class, found three hours with nowhere
 * to be, went home, and did not come back. That is not a missed day — they attended part
 * of it — so a day-level outcome of the kind dayLengthShape uses would score it as
 * attendance and see nothing. The effect lives entirely in the sessions AFTER the hole.
 *
 * WHAT THIS IS AGAINST `laterSessionAbsenceRate`, WHICH IS THE CLOSEST EXISTING FIGURE.
 * That figure pools every non-first session of every multi-session day into one rate. This
 * takes exactly that population and PARTITIONS it by whether a long gap preceded the
 * session. Arithmetically the existing figure is a weighted mean of the two numbers here,
 * which is precisely why it cannot show the effect: a student who reliably returns after
 * lunch and never returns after a three-hour hole has an unremarkable
 * `laterSessionAbsenceRate` made of two very different numbers.
 *
 * A DAY WITH ONE SESSION HAS NO GAP — NOT A GAP OF ZERO — AND CONTRIBUTES NOTHING.
 * It falls out of the structure rather than needing a branch: there is no session after
 * the first sitting, so no row is produced. This matters because a zero would be a lie
 * with a number attached, and because at a college teaching one session a day (which, on
 * the 32 sessions across 24 dates in both databases today, is most days) a "compact day"
 * side built from single-session days would be the entire register — and the finding would
 * then read as "this student attends single-session days better than gappy ones", which is
 * a comparison between two different shapes of timetable rather than between two versions
 * of the same day.
 *
 * THE GAP BEFORE A SESSION IS MEASURED FROM THE LATEST END AMONG ALL EARLIER SESSIONS ON
 * THAT DAY, not from the immediately preceding one in a sorted list. The student is free
 * from the moment the last of their earlier classes finishes, and taking the maximum
 * handles overlapping registers, two units running in parallel, and any ordering question
 * without a tie-break. Sessions sharing a start time are not "earlier" than one another —
 * the comparison is strictly `<` — so two parallel nine o'clock registers are both the
 * first sitting and neither is a return.
 *
 * IF ANY EARLIER SESSION ON THE DAY HAS AN UNUSABLE `endTime`, THE GAP IS UNKNOWN AND THE
 * SESSION LEAVES BOTH SIDES. The unknown end could be the latest one, so a maximum taken
 * over the ends that happen to be present would produce a confidently LARGE gap from a
 * partially-wired select — manufacturing the exact finding the function exists to make.
 * Same rule as dayLengthShape, pointed at the other end of the problem.
 *
 * A NEGATIVE GAP CLASSIFIES AS SHORT rather than being discarded. It means two registers
 * overlap, which is a data error at the college, but the session still ran and the student
 * was still marked in it, and discarding it would quietly shrink the comparison side —
 * which is the side a thin denominator does the most damage to.
 *
 * LATENESS IS NOT REPORTED HERE, deliberately. Returning late from a two-hour gap is a
 * real thing, but "L" on a register after a gap is indistinguishable from "L" for any
 * other reason, and the mechanism this function is about is not coming back at all. Two
 * more numbers with no sentence attached is how a row becomes unreadable.
 *
 * @param {Array<{status, date, startTime, endTime}>} marks  any order
 * @param {{longGapMinMinutes, gapMinMarks, gapMinDays}} [opts]
 */
function gapShape(marks, opts) {
  const cfg = { ...TIMETABLE_DEFAULTS, ...(opts || {}) };

  const { days, unplaceable } = buildDays(marks);

  const rows = [];
  let singleSessionDays = 0;
  let gapsUnmeasurable = 0;

  for (const day of days) {
    if (day.sessions.length < 2) { singleSessionDays += 1; continue; }

    let earliest = Infinity;
    for (const s of day.sessions) if (s.startMin < earliest) earliest = s.startMin;

    for (const s of day.sessions) {
      // The first sitting is not a return. Every mark at the day's earliest start is the
      // first sitting, including a parallel register — the same rule earlyStartShape uses
      // to define its group, stated once in each place because the two functions are read
      // separately.
      if (s.startMin === earliest) continue;

      let prevEnd = -Infinity;
      let known = true;
      for (const other of day.sessions) {
        if (other.startMin >= s.startMin) continue;
        if (other.endMin === null) { known = false; break; }
        if (other.endMin > prevEnd) prevEnd = other.endMin;
      }

      // `prevEnd === -Infinity` IS UNREACHABLE and is kept deliberately. A session
      // reaches here only when its start is later than the day's earliest, so at least
      // one earlier session exists and either set prevEnd or cleared `known`. A mutation
      // pass confirmed removing it changes no behaviour and no test can catch it — the
      // same state coverage.staleness and sessions.consecutiveWeeks each record about one
      // of their own branches. It stays because the INVARIANT is the load-bearing part: a
      // later reader who initialises prevEnd to 0, or who relaxes the `>=` above to `>` so
      // that a parallel register counts as earlier, would turn an empty search into a gap
      // measured from midnight — a fourteen-hour hole reported with total confidence.
      if (!known || prevEnd === -Infinity) {
        gapsUnmeasurable += 1;
        rows.push({ group: null, absent: s.absent, late: null, dayKey: day.date });
        continue;
      }

      rows.push({
        group: (s.startMin - prevEnd) >= cfg.longGapMinMinutes,
        absent: s.absent,
        late: null,
        dayKey: day.date,
      });
    }
  }

  const shape = twoGroupShape(rows, {
    minObservations: cfg.gapMinMarks,
    minDays: cfg.gapMinDays,
  });

  return {
    afterLongGapAbsenceRate: shape.inRate,
    afterShortGapAbsenceRate: shape.outRate,
    longGapAbsenceGap: shape.gap,
    longGapSessions: shape.in.marks,
    longGapDays: shape.in.days,
    shortGapSessions: shape.out.marks,
    // Days that could never have carried a gap. Reported because "no gap finding" and
    // "this college does not timetable two sessions in a day" look identical on a row
    // otherwise, and they are opposite readings.
    singleSessionDays,
    gapsUnmeasurable,
    unplaceableMarks: unplaceable,
  };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   marks              {Array<{status, date, startTime, endTime, sessionId, unitId}>}
 *                      every mark in scope, any order, as metrics.js flattens them —
 *                      plus `endTime`, which metrics.js does NOT carry yet. See the
 *                      wiring note below.
 *   weeksIntoProgramme {number|null} accepted and deliberately unused; see below
 *   institution        {{lateRecorded:boolean}} REQUIRED — throws without it
 * @param {object} [config] a settings config, spread over TIMETABLE_DEFAULTS
 */
function evaluate(raw, config) {
  const cfg = { ...TIMETABLE_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller who forgot the probe finds out on their first
  // fixture rather than after a term of blank lateness columns.
  assertInstitutionProbe(input.institution, "evaluate");

  const marks = input.marks || [];

  const early = earlyStartShape(marks, input.institution, cfg);
  const length = dayLengthShape(marks, cfg);
  const gaps = gapShape(marks, cfg);

  /* --- NOTHING HERE RAISES A CODE, AND THAT IS STRUCTURAL ------------------ */

  // `codes` is built empty and never appended to. It is returned anyway so the shape
  // matches every other module feeding `riskDriverCodes`, and so a caller does not have to
  // special-case this one — a caller that special-cased it would be the thing that breaks
  // when somebody later adds a code.
  //
  // The argument is in the file header at length and is CLAUDE.md's own: a signal that
  // fires for a whole cohort at once is a figure, not a code, and a start time is the most
  // cohort-wide fact a college has. Three ways of rescuing a code were considered and all
  // three fail, because the thing that would distinguish this student from their
  // neighbours IS the gap, and the gap is what the cohort shares.
  //
  // ANYBODY ADDING ONE LATER has to satisfy the test workload.js already meets: every
  // push guarded by the shared half AND by something true of this student and not of the
  // people sitting next to them — which here means a per-start-time, per-day-length or
  // per-gap cohort baseline threaded through cohort.js, built once per run from
  // StudentPredictionCurrent and never from the chunk.
  const codes = [];

  /* --- the settling-in exemption, and why there is nothing to exempt ------- */

  // CLAUDE.md: "`weeksIntoProgramme` mutes the disengagement codes inside a settling-in
  // period... An *unknown* programme age is deliberately not exempt."
  //
  // With no codes there is nothing to mute, so the rule is satisfied vacuously and the
  // field is accepted and read by nothing — ON PURPOSE, so the decision is visible at the
  // call site rather than looking like an oversight, and so anybody adding a code later
  // has the field already in their hand and must confront both halves of the rule rather
  // than discovering the first half only.
  //
  // Worth stating for that future reader: the figures below are NOT muted early in a
  // programme either, and should not be. A rate with a minimum denominator on both sides
  // cannot fire on an intake nobody has marked — with no marks there are no days, both
  // sides are empty, every figure is null. It reports only where the register EXISTS and
  // says something. That is evidence, not silence, which is the same distinction
  // tripwires.js draws when it exempts NO_PASTORAL_CONTACT and pointedly does not exempt
  // ABSENCE_STREAK.

  return {
    /* --- early start: figures only ---------------------------------------- */
    earlyStartAbsenceRate: early.earlyStartAbsenceRate,
    laterStartAbsenceRate: early.laterStartAbsenceRate,
    earlyStartAbsenceGap: early.earlyStartAbsenceGap,
    // The half of the finding that absence cannot carry: at nine o'clock, arriving at
    // 09:20 is the same phenomenon as not arriving. Null at a college with no "L".
    earlyStartLatenessRate: early.earlyStartLatenessRate,
    laterStartLatenessRate: early.laterStartLatenessRate,
    earlyStartLatenessGap: early.earlyStartLatenessGap,
    // The denominator, so a reader can see the gap rests on nine early mornings rather
    // than on two.
    earlyStartDays: early.earlyStartDays,

    /* --- day length: figures only ----------------------------------------- */
    longDayMissedRate: length.longDayMissedRate,
    shortDayMissedRate: length.shortDayMissedRate,
    longDayMissedGap: length.longDayMissedGap,
    longDaysMeasured: length.longDaysMeasured,

    /* --- gaps: figures only ----------------------------------------------- */
    afterLongGapAbsenceRate: gaps.afterLongGapAbsenceRate,
    afterShortGapAbsenceRate: gaps.afterShortGapAbsenceRate,
    longGapAbsenceGap: gaps.longGapAbsenceGap,
    longGapSessions: gaps.longGapSessions,

    /* --- what could not be seen ------------------------------------------- */
    // THE WIRING SIGNAL, and the reason it is a stored figure rather than a log line.
    // `endTime` is not yet carried into the flattened mark by metrics.js, so on the day
    // this is wired every day-length figure and every gap figure will be null. Null on its
    // own reads as "this student's timetable is uniform"; null WITH this count equal to the
    // student's whole day count reads as "the field is not being carried", which is the
    // true statement and the one that gets somebody to fix it.
    daysWithoutSessionEnd: length.daysWithoutSessionEnd,
    // Days that could never have carried a gap, so "no gap finding" is distinguishable
    // from "this college does not timetable two sessions in a day".
    singleSessionDays: gaps.singleSessionDays,

    codes,
  };
}

module.exports = {
  evaluate,
  earlyStartShape,
  dayLengthShape,
  gapShape,
  twoGroupShape,
  buildDays,
  minutesOf,
  assertInstitutionProbe,
  TIMETABLE,
  TIMETABLE_CODES,
  TIMETABLE_DEFAULTS,
};
