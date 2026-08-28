// Divergence: when this student's signals DISAGREE with each other, what does the
// disagreement mean?
//
// PURE. No database, no clock, no tenant. Everything arrives already computed — this
// module takes FIGURES, never rows, and it takes no `today` at all because nothing here
// is date-relative. The same seam engine.js, tripwires.js, workload.js and cohort.js
// keep, and for the same reason: these are lines a college will be asked to defend at an
// appeal, so they have to be checkable without standing up an institution's worth of
// fixtures.
//
// ============================================================================
// WHY THIS LAYER EXISTS
// ============================================================================
//
// engine.js takes a WEIGHTED MEAN of seven components. A mean is precisely the operation
// that destroys disagreement. Two students:
//
//     A:  attendance 95%, submission rate 20%
//     B:  attendance 55%, submission rate 55%
//
// land within a few points of each other on the composite, and the screen shows one
// number for two situations that need completely opposite conversations. The score is
// not WRONG about either of them — it is answering "how is this student doing, overall",
// and the answer for both is "not well". It simply has no term in it for the SHAPE of
// the not-well, and no amount of retuning the weights can add one: the mean is the thing
// erasing the shape, so a better mean is still a mean.
//
// The four shapes this file names, and what each one is FOR — because a divergence with
// no named next step is not an intervention, which is the finding tripwires.js opens
// with and the reason none of this moves the score:
//
//   * ATTENDING, NOT SUBMITTING. Present in the room and producing nothing. Very often a
//     competence or a confidence problem, sometimes an undiagnosed need — this is the
//     shape a specific-learning-difficulty screening finds. The intervention is ACADEMIC
//     SUPPORT: study skills, a diagnostic, a conversation about the brief. Chasing them
//     for attendance is the one thing that certainly will not help, and it is what the
//     composite score invites, because their attendance is the good half.
//
//   * SUBMITTING, NOT ATTENDING. Working, but disconnected from teaching. Usually a job,
//     caring responsibilities, or a commute that has stopped working. The intervention is
//     TIMETABLING or a conversation about mode of study, and this student is at HIGH risk
//     of quietly disengaging despite good marks — they are coping alone, the coping is
//     invisible until it stops, and by the time the marks fall they have already gone.
//
//   * ENGAGED ONLINE, ABSENT IN PERSON. Newly answerable: `vleActiveDayRate` and
//     `vleLastAccessOn` did not exist until the engagement columns landed, and before
//     them a student who was reading the material every night and never entering the
//     building was indistinguishable from one who had vanished. This distinction carries
//     COMPLIANCE weight and not only pastoral weight — a sponsoring provider must
//     evidence academic ENGAGEMENT rather than attendance, so "absent but demonstrably
//     working" is a defensible position and "absent" is not.
//
//   * ATTAINING, NOT ATTENDING. Good marks with attendance FALLING under them. The
//     classic pre-withdrawal shape and the one the mean hides hardest, because the marks
//     prop the composite up right until the term the student stops. It is the only shape
//     here carrying a direction of travel, which is why it takes precedence — see
//     profile().
//
// ============================================================================
// TRAP 5: WHAT THIS MODULE DELIBERATELY DOES NOT DUPLICATE
// ============================================================================
//
// Stated up front so a later reader does not add a second copy of a figure that already
// has a column and a definition:
//
//   * `attendanceSlope` is an INPUT. It is not recomputed, and `ATTAINING_NOT_ATTENDING`
//     reuses `attendanceSlopeDrop` — the college's own already-configured opinion about
//     what a falling attendance is — rather than inventing a second opinion that would
//     drift away from it the first time somebody retuned one of the two.
//   * `gradeTrend` and `gradeVolatility` are not read at all. The direction and spread of
//     the marks are a question about the marks; this file's question is about the marks
//     AGAINST something else.
//   * `submissionRate` and `onTimeRate` are INPUTS and are not returned. `onTimeRate` in
//     particular is deliberately not used in any gap: it is measured against what was
//     HANDED IN rather than against what was due (engine.js is explicit that letting
//     unsubmitted work drag it too would charge the student three times), so its
//     denominator is a subset of submissionRate's and the two cannot both sit on one side
//     of a comparison without double-counting the same absence.
//   * Nothing here re-derives a percentage from rows. Every figure arrives as the same
//     number that will be stored on the row, so the gap on the screen and the gap in the
//     code can never disagree.
//
// What IS new is the RELATIONSHIP, and only the relationship. Two gaps and a name.
//
// ============================================================================
// TRAP 3: WHAT SUBTRACTING THESE NUMBERS DOES AND DOES NOT CLAIM
// ============================================================================
//
// This is the claim most easily got confidently wrong, so it is stated as a rule the
// code enforces rather than as an aspiration.
//
// THE ONLY FIGURES THIS FILE SUBTRACTS FROM ONE ANOTHER ARE OPPORTUNITY-TAKE RATES:
// "of the chances the college gave this student, what share did they take?"
//
//     attendance %        sessions attended      / sessions marked
//     submission rate %   pieces handed in       / pieces whose deadline has passed
//     VLE active day %    days the course opened / days we observed
//
// All three are the same KIND of quantity — a bounded 0–100 share of offered
// opportunities, where 100 means "took every chance" and 0 means "took none" — which is
// what makes the subtraction mean something. What it claims is narrow and worth writing
// out: that this student took a much larger share of one kind of opportunity than of
// another. It does NOT claim the two are equally easy, equally frequent, or that a point
// of one is worth a point of the other. That is exactly why the threshold below is large
// (trap 2) and why the shapes are named for the OBSERVATION — "attending, not
// submitting" — rather than for an inference like "unable" or "unmotivated".
//
// AVERAGE GRADE IS NOT IN THAT FAMILY AND IS NEVER SUBTRACTED FROM ANY OF THEM.
//
// A grade is a QUALITY measurement, not a share of opportunities taken. Its distribution
// is compressed and floored by the pass mark, it is bounded below in practice by whatever
// a marker will award for a genuine attempt, and 65% attendance and a 65% average are not
// two readings on one scale — they are two different scales that happen to share a
// symbol. "Attendance minus average grade = 30" is a number with no referent, and it
// would be a CONFIDENT one: it would print, it would look like the others, and nobody
// reading the row would be able to tell it apart from a gap that meant something.
//
// So the fourth shape is built the other way, and it is the reason `profile()` is not
// four calls to `gap()`. `ATTAINING_NOT_ATTENDING` is a CONJUNCTION of two independently
// meaningful facts — an ABSOLUTE judgement about the grade (is it clear of the college's
// own pass mark by a band step?) and an EXISTING direction figure about attendance (is
// `attendanceSlope` at or past the drop the college already calls a fall?) — with no
// subtraction between them anywhere. Comparing them by BAND rather than by raw points is
// the answer to "should some pairs be compared by band or by rank instead", and this is
// the pair for which the answer is yes.
//
// A rank comparison was considered for the grade side and rejected: cohort.js already
// ranks a student's average against their own cohort, that figure is already stored, and
// a second percentile computed here from a population this module cannot see would be
// the chunk-derived-population bug cohort.js spends eighty lines warning about.
//
// ============================================================================
// TRAP 1: NULL IS NOT ZERO, AND THIS IS THE FILE WHERE THAT IS EASIEST TO BREAK
// ============================================================================
//
// Every single input here can legitimately be null:
//
//   * attendance, because too few registers were taken for the percentage to be
//     reportable — coverage.js sanitises it away on purpose;
//   * submission rate, because this college records no submissions, or because nothing
//     is past its deadline yet;
//   * VLE, because the college was never observable — a Moodle with `hiddenuserfields`
//     set, or one nobody uses, or a college that teaches face to face;
//   * average grade, because nothing has been marked;
//   * attendance slope, because one of the two windows was too thin to compare.
//
// A GAP WHERE EITHER SIDE IS NULL IS NOT A LARGE GAP AND NOT A SMALL ONE. IT IS NOT A
// GAP. Under no circumstances may a missing figure be read as 0.
//
// This is the single most dangerous failure available to this module, and the reason is
// arithmetic: every shape fires on one side being far BELOW the other, so a null read as
// 0 fires the code. `95 - null` read as `95 - 0` is a 95-point divergence — the loudest
// possible reading — produced entirely by a figure nobody measured. It would therefore
// fire HARDEST for the students the college knows LEAST about, which is the exact
// inversion CLAUDE.md's null-is-not-zero rule exists to prevent, and it would fire for
// all of them at once at any college whose feed does not populate one of the three.
//
// Structurally, rather than by anybody remembering: `gap()` is the ONLY place a
// subtraction happens, it is a single function, and its first act is to refuse anything
// that is not a finite number on both sides. There is no `|| 0`, no `Number(x)`, and no
// `??` anywhere in this file, and a test asserts the file contains none of them.
//
// ============================================================================
// WHY THE CODES ARE NAMESPACED `TRIP_`
// ============================================================================
//
// They are appended to `riskDriverCodes`, the same array engine.js fills from its six RED
// indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band — is
// derived by engine.js from its OWN internal `reds` array, and `riskDriverCodes` is a
// COPY taken afterwards, so appending here provably cannot reach the override. The prefix
// is what keeps that visible: a code named `RED_`-anything would read as the engine's own
// and would invite the next person to take the count off the copy, which would wire a
// disagreement between two figures into a student's band. Keep the prefix; keep the count
// off the copy.
//
// AND HERE THAT WOULD BE PARTICULARLY WRONG. A divergence is not a severity. The student
// submitting everything and attending nothing may be at real risk, but they are not
// "worse" than the student who is doing neither — they are a different case with a
// different next step. Folding that into a band would replace a distinction with a
// magnitude, which is the mean's failure repeated one layer up.
//
// ============================================================================
// WHY AT MOST ONE CODE
// ============================================================================
//
// `profile()` returns exactly one shape or none, and `evaluate()` therefore pushes at
// most one code. This is a deliberate departure from tripwires.js, where ABSENCE_STREAK
// and NOT_SEEN happily fire together on one disappearance, and from workload.js, whose
// two codes are two separate findings about the same week.
//
// The difference is that these four are not four findings. They are four READINGS OF THE
// SAME DISAGREEMENT, and some of them are contradictory: "attending but not submitting"
// and "submitting but not attending" cannot both be true of one student, and a row
// carrying both would be unreadable rather than informative. Where two non-contradictory
// readings do both hold, the precedence rule at `profile()` picks the one that names the
// most, and `candidates` records what was set aside so the decision is auditable rather
// than invisible.

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so these
// strings outlive several rewrites of the screen. Structured codes, never display text —
// the client maps them to wording, and rewording must not orphan a stored row.
//
// NAMED FOR THE OBSERVATION, NEVER FOR THE INFERENCE, which is workload.js's rule and it
// applies with more force here. `TRIP_DIVERGENCE_STRUGGLING_ACADEMICALLY` would be a
// diagnosis drawn from two percentages; "attending, not submitting" is a fact two columns
// can be checked against. The whole value of this layer is that it hands staff a
// SITUATION to ask about rather than a conclusion to act on, and a code that states a
// conclusion throws that away in the one word a tutor actually reads.
//
// `DIVERGENCE_` in the middle is not decoration either: these are the sixth vocabulary
// writing into one column, and the segment makes the source of a code on the caseload
// readable without opening seven files.
const DIVERGENCE = {
  // Present in the room, producing nothing. Academic support.
  ATTENDING_NOT_SUBMITTING: "TRIP_DIVERGENCE_ATTENDING_NOT_SUBMITTING",
  // Producing, but disconnected from teaching. Timetabling or mode of study.
  SUBMITTING_NOT_ATTENDING: "TRIP_DIVERGENCE_SUBMITTING_NOT_ATTENDING",
  // Opening the course, not entering the building. Compliance as well as pastoral.
  ONLINE_NOT_ATTENDING: "TRIP_DIVERGENCE_ONLINE_NOT_ATTENDING",
  // Marks holding up while attendance falls under them. The pre-withdrawal shape.
  ATTAINING_NOT_ATTENDING: "TRIP_DIVERGENCE_ATTAINING_NOT_ATTENDING",
};

const DIVERGENCE_CODES = Object.values(DIVERGENCE);

// The shape names, kept separate from the codes on purpose. `profile()` is the classifier
// and is worth calling on its own — from a screen, from an export, from a test — without
// dragging in the caseload vocabulary, and a shape that is deliberately NOT stored (there
// is not one today, but a "both figures agree" shape would be exactly that) must be
// expressible without inventing a code for it.
const SHAPE = {
  ATTENDING_NOT_SUBMITTING: "ATTENDING_NOT_SUBMITTING",
  SUBMITTING_NOT_ATTENDING: "SUBMITTING_NOT_ATTENDING",
  ONLINE_NOT_ATTENDING: "ONLINE_NOT_ATTENDING",
  ATTAINING_NOT_ATTENDING: "ATTAINING_NOT_ATTENDING",
};

/** Shape name → the code stored for it. One entry each; a shape with no code would be a
 *  shape `evaluate()` silently drops, and a test asserts the map is total. */
const SHAPE_CODES = {
  [SHAPE.ATTENDING_NOT_SUBMITTING]: DIVERGENCE.ATTENDING_NOT_SUBMITTING,
  [SHAPE.SUBMITTING_NOT_ATTENDING]: DIVERGENCE.SUBMITTING_NOT_ATTENDING,
  [SHAPE.ONLINE_NOT_ATTENDING]: DIVERGENCE.ONLINE_NOT_ATTENDING,
  [SHAPE.ATTAINING_NOT_ATTENDING]: DIVERGENCE.ATTAINING_NOT_ATTENDING,
};

/* -------------------------------------------------------------------------- */
/* Constants, and the arguments for them                                       */
/* -------------------------------------------------------------------------- */

// Platform defaults, in the shape settings.js uses: defaults in code, overridden by
// whatever the caller spreads over them. Deliberately NOT added to settings.js here —
// wiring is a separate change and a config key nothing reads is worse than no key at all.
// Every function spreads `opts`/`config` OVER these, so the day they move into DEFAULTS
// no caller changes.
const DIVERGENCE_DEFAULTS = {
  // ==========================================================================
  // TRAP 2: A DIFFERENCE IS NOT A DIVERGENCE
  // ==========================================================================
  //
  // HOW MANY PERCENTAGE POINTS APART TWO OPPORTUNITY-TAKE RATES MUST BE BEFORE THE
  // DISAGREEMENT IS A FINDING. Twenty-five, and it is deliberately much larger than every
  // comparable threshold already in settings.js. The argument is not taste; it is that
  // those thresholds are measuring a different KIND of thing.
  //
  //     attendanceSlopeDrop   10   this student's attendance   vs  their own attendance
  //                                                                in the window before
  //     cohortOutlierGap      10   this student's attendance   vs  their cohort's
  //                                                                attendance
  //     gradeTrendThreshold    5   this student's recent marks vs  their own earlier
  //                                                                marks
  //
  // Every one of those is LIKE FOR LIKE. The same measurement, the same denominator, the
  // same instrument — only the window or the population moves. Everything except the
  // thing being measured is held constant, which is exactly what lets a ten-point
  // difference mean something: there is no structural reason for the two numbers to
  // differ, so a difference is signal.
  //
  // Nothing is held constant here. Attendance and submission rate have different
  // denominators (registers versus deadlines), different granularities (several marks a
  // week versus a handful of pieces a term), different mechanics (a tutor takes one,
  // a student initiates the other) and — the point — DIFFERENT NATURAL LEVELS. A healthy
  // cohort's mean attendance and its mean submission rate are simply not the same number
  // at any college, so a ten-point gap between them is the ordinary condition of an
  // ordinary student rather than a finding about anybody. A threshold set at the
  // like-for-like scale would put most of the institution on the caseload, and CLAUDE.md
  // is blunt that a caseload containing everybody is the same as no caseload.
  //
  // The threshold therefore has to clear the STRUCTURAL difference between the two scales
  // before it can be reading anything about a student. Twenty-five, specifically:
  //
  //   * The default band ladder steps in fifteens — 85 / 70 / 55 / 40. A gap smaller than
  //     one step cannot land the two figures in different bands, and two figures inside
  //     one band are not two situations. 25 is comfortably more than one step and less
  //     than two: the two figures are in different bands and not merely adjacent ones.
  //   * `redAttendanceThreshold` is 70 and `passThreshold` is 40. Thirty points is the
  //     entire distance this codebase already recognises between "we are worried" and
  //     "this is a fail". 25 sits just inside the widest interval the config already
  //     treats as meaningful, rather than inventing a wider one.
  //   * Against the cases in the brief: 95/20 is a 75-point gap and fires loudly; the
  //     ordinary 80/60 student does not. The boundary lands where it is supposed to.
  //
  // It is set high ON PURPOSE and the cost is accepted: this layer will miss genuine
  // twenty-point disagreements. That is the right direction to fail, because the FALSE
  // reading here is not "we did not call somebody" — it is "we called somebody and told
  // them the wrong thing", which is worse than silence and which staff correctly stop
  // trusting the whole screen for.
  divergenceGap: 25,

  // ==========================================================================
  // TRAP 4: SAMPLE SIZE, ON BOTH SIDES, ALWAYS
  // ==========================================================================
  //
  // A submission rate over two assessments against an attendance over forty registers is
  // not a comparison, and a floor on only the interesting side is a HALF-GUARD — which
  // this repo has shipped before and had to go back for. sessions.js records the fix in
  // its own words: "A floor on only the interesting number is a half-guard: '60% absent
  // on Fridays against 0% across two other marks' is not a comparison."
  //
  // So every gap in this file requires a floor on BOTH operands, both floors are named
  // separately because the two sides have genuinely different natural sample sizes, and
  // `gap()` refuses outright if a caller hands it a figure without the count behind it —
  // a MISSING count is not a satisfied floor, and defaulting one to zero or to Infinity
  // would each be a way of not having the guard while appearing to.

  // ATTENDANCE. Six marked sessions, mirroring `minMarksForRate` — this codebase's
  // existing opinion about the fewest registers that make a percentage reportable —
  // rather than a seventh independent opinion about the same question. Deliberately
  // higher than `slopeMinMarks` (3): a slope compares a window against a window of the
  // SAME instrument and can tolerate a thinner one, while this figure is about to be
  // compared against something measured a completely different way, and it has to stand
  // up on its own first.
  minAttendanceObservations: 6,

  // SUBMISSIONS. Three pieces past their deadline, mirroring `lateSubmissionMinPieces`
  // for exactly the reason given there: one piece not handed in reads 0% and the screen
  // renders "hands nothing in" — a pattern claimed from a single data point. It is lower
  // than the attendance floor and the asymmetry is real rather than sloppy: a term
  // carries dozens of registers and a handful of deadlines, so a floor of six here would
  // silence the comparison until the back half of the term at most colleges, which is
  // after the point where any of these conversations is still cheap.
  minSubmissionObservations: 3,

  // VLE. Five observed days, mirroring `minObservedDays`, which is the floor
  // engagementNormalise already applies before it will return an `activeDayRate` at all.
  //
  // WHY REPEAT A FLOOR THAT HAS ALREADY BEEN APPLIED UPSTREAM. Because it has been
  // applied in ANOTHER FILE, to answer a different question — "is this rate worth
  // storing" — and a later reader relaxing it there for a perfectly good reason of their
  // own would silently relax it here, where the rate is being compared against a figure
  // built from forty registers. The floor that protects a comparison belongs beside the
  // comparison. It also means `gap()` has the same contract on every call site rather
  // than one operand trusted and the other checked.
  minVleObservedDays: 5,

  // MARKS, for the attainment shape only. Four graded pieces. `gradeTrendAssessmentCount`
  // is 2 and the engine's trend reads the last 2 against the 2 before them, so four is
  // the sample the engine already requires before it will call a direction of travel at
  // all — and this shape is a claim about the marks holding up over time, not about one
  // good mark. Below four, "good marks" is one assignment.
  minGradedForAttainment: 4,

  // THE LEVEL AT WHICH AN AVERAGE GRADE COUNTS AS "HOLDING UP".
  //
  // Fifty-five, and it is a BAND rung rather than a number — the third boundary of the
  // default ladder (85 / 70 / 55 / 40), which is to say the level at which this
  // institution has already said out loud, in its own configuration, that a figure is
  // unremarkable rather than concerning. Mirroring an existing rung is the same move
  // `peakAttendanceFloor` makes in mirroring `redAttendanceThreshold`, and it means a
  // college that retunes its ladder moves this with it instead of leaving the two to
  // drift apart.
  //
  // WHY NOT `passThreshold` (40). Because 40 is the line between failing and not, and a
  // student sitting on it is not "attaining" — they are one bad mark from a red
  // indicator, and the engine will already have said so via LOW_AVERAGE_GRADE and
  // RECENT_FAIL. This shape's whole claim is that THE MARKS ARE PROPPING THE SCORE UP,
  // which requires them to be genuinely comfortable; a bare pass props nothing up. It is
  // also clear of `passThreshold + nearFailMargin` (50), the point at which tripwires.js
  // stops calling a mark a near-fail, by a further band step.
  attainingGradeFloor: 55,

  // ==========================================================================
  // TWO KEYS THAT ALREADY EXIST IN settings.js, RESTATED HERE AND ONLY HERE
  // ==========================================================================
  //
  // These are NOT second opinions. They are the SAME KEY NAMES settings.js already
  // carries, at the same values, so a real config spread over these defaults always wins
  // and the two can never diverge in production — the merge is what keeps them one
  // number. `peakAttendanceFloor` in workload.js mirrors `redAttendanceThreshold` in
  // exactly this way and for exactly this reason.
  //
  // They are restated at all because the alternative is worse. Without a default,
  // `profile()` called with no config reads `undefined`, `isNum` refuses it, and
  // ATTAINING_NOT_ATTENDING becomes permanently and silently inert — the failure mode
  // this file's institution probe throws to avoid, arriving through the back door. A
  // feature that quietly does nothing is not discoverable by reading the output.
  //
  // If either key is ever renamed in settings.js, the rename must land here too, and the
  // symptom of forgetting is a shape that stops firing rather than one that fires wrongly.
  // That is the safe direction, but it is not a free one, so: a test asserts both keys
  // hold the same value settings.js's DEFAULTS do.
  attendanceSlopeDrop: 10,
  settlingInWeeks: 3,
};

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * A number this module is prepared to treat as a percentage of something.
 *
 * THE RANGE CHECK IS NOT DEFENSIVENESS. All three rates here are 0–100 by construction,
 * so a value outside that range is not an extreme student — it is a caller who has handed
 * over a different quantity entirely: a count, a raw mark out of 20, a score, a
 * percentage already expressed as a fraction. Subtracting it would produce a large,
 * confident, plausible-looking gap from a category error, and every shape in this file
 * fires on a gap being large. Refusing is the only reading that cannot invent a finding.
 *
 * NaN and Infinity are excluded by `isNum` before the comparison, because both would slip
 * through a naive `x < 0 || x > 100` — NaN fails every comparison and would be treated as
 * in range.
 */
const isPct = (n) => isNum(n) && n >= 0 && n <= 100;

/* -------------------------------------------------------------------------- */
/* The one subtraction in the file                                             */
/* -------------------------------------------------------------------------- */

/**
 * The signed difference between two comparable percentages, or `null` when either is not
 * measurable.
 *
 * `a - b`. THE SIGN CONVENTION IS FIXED AND EVERY CALLER OBEYS IT: attendance is always
 * the left operand, so a POSITIVE gap always means "more present than <the other thing>"
 * and a NEGATIVE gap always means "less present than <the other thing>". One convention
 * across the file means a reader never has to check which way round a particular pair was
 * written, and a stored figure keeps its meaning when the column is read back in two
 * years by somebody who has not read this comment.
 *
 * FOUR WAYS TO GET NULL, and they are all the same rule wearing different hats:
 *
 *   1. Either value is not a finite number — trap 1. `95 - null` must never become
 *      `95 - 0`, which would be the loudest possible reading of a figure nobody measured.
 *   2. Either value is outside 0–100 — see `isPct`. Not a percentage, not comparable.
 *   3. Either sample size is missing or is not a number. A MISSING COUNT IS NOT A
 *      SATISFIED FLOOR. Defaulting it would be a way of not having the guard while
 *      appearing to, and the caller cannot tell the difference from the outside.
 *   4. Either sample size is below its floor — trap 4, enforced on BOTH sides. A floor on
 *      one side only is a half-guard.
 *
 * The floors are REQUIRED in `opts` rather than defaulted, for the same reason
 * workload.js throws on a missing institution probe: a default here would silently apply
 * a threshold the caller never chose to a comparison the caller never checked, and
 * nothing on the row would look wrong. Unlike workload.js this returns null rather than
 * throwing, because `gap()` is a leaf the client and an export may reasonably call with
 * partial data, and its whole contract is already "null when this cannot be answered" —
 * a null here costs one figure that does not print, not a feature that silently does
 * nothing.
 *
 * @param {number|null} a  a percentage, 0–100
 * @param {number|null} b  a percentage, 0–100, measuring the same KIND of thing — a share
 *        of opportunities taken. See the trap 3 section in the header for what is and is
 *        not claimed by subtracting them, and for why an average grade is never one of
 *        these.
 * @param {{nA:number|null, nB:number|null, minA:number, minB:number}} opts  the sample
 *        size behind each figure and the floor each must clear
 * @returns {number|null} signed percentage points to one decimal place, or null
 */
function gap(a, b, opts) {
  const o = opts || {};

  // Trap 1, first and unconditionally. Nothing below this line can see a null.
  if (!isPct(a) || !isPct(b)) return null;

  // Trap 4, on both sides, with a missing count treated as a failure rather than as an
  // absent constraint.
  if (!isNum(o.nA) || !isNum(o.nB)) return null;
  if (!isNum(o.minA) || !isNum(o.minB)) return null;
  if (o.nA < o.minA || o.nB < o.minB) return null;

  // One decimal place, matching every other stored figure in this feature. The rounding
  // happens AFTER the subtraction so a gap is never the difference of two roundings.
  return round1(a - b);
}

/* -------------------------------------------------------------------------- */
/* The classifier                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Classify the disagreement between this student's figures into ONE named shape, or none.
 *
 * @param {object} figures  ALREADY-COMPUTED figures, never rows. Each pairs with the
 *        sample size behind it, because a figure without its denominator cannot be
 *        compared against anything (trap 4).
 *
 *   attendancePct           {number|null}  the SANITISED overall attendance — the figure
 *                           coverage.js was willing to report, never the raw percentage.
 *                           A student this run has already decided cannot be described by
 *                           an attendance figure must not then be described by a gap
 *                           built out of one. cohort.js takes the same figure for the
 *                           same reason.
 *   attendanceObservations  {number|null}  marked sessions behind it
 *   submissionRate          {number|null}  submitted / (submitted + notSubmitted), as
 *                           engine.js's measure() computes it. NOT re-derived here.
 *   submissionObservations  {number|null}  submitted + notSubmitted — the denominator,
 *                           which deliberately excludes "unknown": engine.js drops those
 *                           because Moodle reports no submission state for most LTI grade
 *                           items, and counting them would invent a missing-work problem
 *                           for a whole cohort.
 *   vleActiveDayRate        {number|null}  days the student opened any course / days
 *                           observed. Null where the college was never observable.
 *   vleObservedDays         {number|null}  the denominator, in DAYS not rows
 *   averageGrade            {number|null}  the plain mean of normalised marks, exactly as
 *                           engine.js computes it — NOT weightedAverageGrade, which is a
 *                           different figure with a flag saying whether it means anything
 *   gradedCount             {number|null}  marks behind that average
 *   attendanceSlope         {number|null}  the EXISTING figure: percentage-point change
 *                           between the rolling window and the equal window before it.
 *                           Never recomputed here.
 *
 * @param {object} [opts]  spread over DIVERGENCE_DEFAULTS
 * @returns {{shape, candidates, attendanceSubmissionGap, attendanceVleGap}}
 */
function profile(figures, opts) {
  const cfg = { ...DIVERGENCE_DEFAULTS, ...(opts || {}) };
  const f = figures || {};

  // ATTENDANCE vs SUBMISSION. Positive: present more than they hand in.
  const attendanceSubmissionGap = gap(f.attendancePct, f.submissionRate, {
    nA: f.attendanceObservations,
    nB: f.submissionObservations,
    minA: cfg.minAttendanceObservations,
    minB: cfg.minSubmissionObservations,
  });

  // ATTENDANCE vs VLE. Positive: in the room more than they are in the course.
  const attendanceVleGap = gap(f.attendancePct, f.vleActiveDayRate, {
    nA: f.attendanceObservations,
    nB: f.vleObservedDays,
    minA: cfg.minAttendanceObservations,
    minB: cfg.minVleObservedDays,
  });

  // EVERY shape that holds, before precedence. Collected rather than short-circuited so
  // the discarded readings are visible to a caller and to a test — a precedence rule that
  // silently swallows its losers is one nobody can check.
  const candidates = [];

  // --- present, producing nothing ------------------------------------------
  //
  // `isNum` and not a truthiness test, and this is where trap 1 would actually bite: a
  // null gap is falsy, so `attendanceSubmissionGap >= cfg.divergenceGap` on a null
  // evaluates `null >= 25` — which JavaScript coerces to `0 >= 25`, i.e. false, and it
  // would be RIGHT here by pure luck. It is written explicitly so that a later reader who
  // flips a comparison, or who adds a shape firing on a gap being SMALL, does not inherit
  // a null silently behaving as a zero. `null <= -25` is likewise `0 <= -25` — false
  // today, and one sign change away from firing for every unmeasurable student at once.
  if (isNum(attendanceSubmissionGap) && attendanceSubmissionGap >= cfg.divergenceGap) {
    candidates.push(SHAPE.ATTENDING_NOT_SUBMITTING);
  }

  // --- producing, not present ----------------------------------------------
  //
  // The mirror, and sign-exclusive with the one above: one gap cannot be both ≥ +25 and
  // ≤ −25. That exclusivity is structural rather than enforced, which is why the
  // precedence rule below never has to arbitrate between these two.
  if (isNum(attendanceSubmissionGap) && attendanceSubmissionGap <= -cfg.divergenceGap) {
    candidates.push(SHAPE.SUBMITTING_NOT_ATTENDING);
  }

  // --- online, not in the building -----------------------------------------
  //
  // NO INSTITUTION PROBE IS NEEDED ON THIS SIDE AND THAT IS LOAD-BEARING, not an
  // omission. CLAUDE.md: for VLE engagement "a ROW MEANS 'WE LOOKED'", and absence IS the
  // institution guard, because no count can separate a disengaged cohort from a Moodle
  // with `$CFG->hiddenuserfields` set from a college that teaches face to face — all
  // three are zero rows. So an unobservable college produces a null rate, the gap is
  // null, and this shape cannot fire institution-wide. The guard is in the shape of the
  // data rather than in a flag, which is stronger, because there is no flag for anybody
  // to forget to pass.
  //
  // A DISTANCE-LEARNING PROVIDER IS SAFE FOR THE MIRROR REASON: no timetabled sessions
  // means no registers, so the attendance side is null and every student's gap is null.
  // Without that, a provider with no classroom at all would have its ENTIRE cohort read
  // as "engaged online, absent in person" — true, meaningless, and identical on every
  // row, which is the cohort-wide-code failure CLAUDE.md names.
  if (isNum(attendanceVleGap) && attendanceVleGap <= -cfg.divergenceGap) {
    candidates.push(SHAPE.ONLINE_NOT_ATTENDING);
  }

  // --- marks holding up while attendance falls under them ------------------
  //
  // NO SUBTRACTION ANYWHERE IN THIS ONE — see the trap 3 section of the header. A
  // conjunction of an ABSOLUTE band judgement about the grade and the EXISTING slope
  // figure about attendance, because an average grade and an attendance percentage are
  // not two readings on one scale and "attendance minus grade" is a number with no
  // referent.
  //
  // WHAT THIS ADDS OVER `TRIP_ATTENDANCE_FALLING`, which fires on the identical slope
  // test and reuses the identical threshold. Nothing about the attendance — deliberately,
  // because a second opinion about what a falling attendance is would drift from the
  // college's own the first time either was retuned. What it adds is the OTHER half:
  // that the composite score is not going to show the fall, because the marks are holding
  // it up. Two students with the same slope and averages of 30 and 70 get the same
  // ATTENDANCE_FALLING and need different conversations, and the one whose score looks
  // fine is the one nobody will ring.
  //
  // Neither half raises this alone and the code is written so it structurally cannot —
  // workload.js's rule, and the reason both halves sit in one condition rather than in
  // two nested ifs somebody could later separate.
  const marksHoldingUp = isNum(f.averageGrade)
    && isNum(f.gradedCount) && f.gradedCount >= cfg.minGradedForAttainment
    && f.averageGrade >= cfg.attainingGradeFloor;

  // The college's OWN threshold for a falling attendance, read from config rather than
  // restated. `attendanceSlopeDrop` is a positive magnitude in settings.js, so the
  // comparison negates it exactly as tripwires.js does.
  const attendanceFalling = isNum(f.attendanceSlope)
    && isNum(cfg.attendanceSlopeDrop)
    && f.attendanceSlope <= -cfg.attendanceSlopeDrop;

  // NO ABSOLUTE FLOOR ON THE CURRENT ATTENDANCE LEVEL, and that is a decision rather than
  // an omission. Requiring the student to already be BELOW some level would delay this
  // code until the fall had finished, which is exactly the point at which it stops being
  // an early warning and becomes a description. The shape is the DIRECTION; a student
  // going 95 → 78 is the case this exists for, and 78 is a comfortable number.
  if (marksHoldingUp && attendanceFalling) {
    candidates.push(SHAPE.ATTAINING_NOT_ATTENDING);
  }

  /* --- precedence ---------------------------------------------------------- */
  //
  // ONE SHAPE, OR NONE. These are four readings of one disagreement rather than four
  // findings, and two of them are outright contradictory, so a row carrying more than one
  // would be less readable than a row carrying the weakest. Where several hold, the order
  // below decides, and `candidates` keeps what was set aside visible.
  //
  // 1. ATTAINING_NOT_ATTENDING first, because it is THE ONLY SHAPE CARRYING A DIRECTION.
  //    The other three are static cross-sections: they say where the student is now, and
  //    are equally true of somebody who has been that way since October. This one says
  //    something is CHANGING, which is the only shape with a deadline attached — the
  //    window in which the conversation is still cheap closes, and the other three do not
  //    close. Given two true names for one student, the one with a deadline is the one
  //    that belongs on the screen.
  //
  // 2. SUBMITTING_NOT_ATTENDING next, ahead of ONLINE_NOT_ATTENDING. Both point the same
  //    way — engaged, absent — and where both hold they describe one student. Work handed
  //    in is strictly stronger evidence of engagement than a course page opened: one is a
  //    thing the student produced, the other is a thing they clicked, and a VLE access
  //    log cannot distinguish reading a brief from leaving a tab open. Naming the finding
  //    for the stronger evidence is what makes it defensible when it is used as it is
  //    meant to be used — to argue that an absent student is nonetheless academically
  //    engaged, which at a sponsoring provider is an argument made to somebody who will
  //    ask what it rests on.
  //
  // 3. ONLINE_NOT_ATTENDING, which therefore fires in the two cases the one above cannot:
  //    where this college does not record submissions at all (the ordinary state), and
  //    where the student is online and absent but is NOT handing work in — a genuinely
  //    different and worse case, and the one where the compliance argument is weakest.
  //
  // 4. ATTENDING_NOT_SUBMITTING last, which costs nothing: it is sign-exclusive with 2
  //    and cannot co-occur with 3 (which needs attendance far BELOW the VLE rate), so the
  //    only ordering that ever bites is 1 over 4 — a student attending, not submitting,
  //    with good marks on the little they have handed in and a falling attendance. The
  //    fall is the newer news.
  //
  // The list is iterated in order rather than sorted, so the precedence is the reading
  // order of the array and a reordering is a visible one-line diff.
  const PRECEDENCE = [
    SHAPE.ATTAINING_NOT_ATTENDING,
    SHAPE.SUBMITTING_NOT_ATTENDING,
    SHAPE.ONLINE_NOT_ATTENDING,
    SHAPE.ATTENDING_NOT_SUBMITTING,
  ];

  let shape = null;
  for (const s of PRECEDENCE) {
    if (candidates.includes(s)) { shape = s; break; }
  }

  return {
    shape,
    // Sorted so the array is stable between runs regardless of the order the tests above
    // happen to be written in. A figure that moved with nothing about the student having
    // changed is what makes a row untrustworthy — metrics.js sorts grades with an
    // assessment-id tie-break for the same reason.
    candidates: candidates.slice().sort(),
    attendanceSubmissionGap,
    attendanceVleGap,
  };
}

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a submission-side question without an institution-wide answer to "does
 * this college record whether work was handed in at all?"
 *
 * WHY THIS IS NEEDED WHEN `submissionRate` IS ALREADY NULL AT SUCH A COLLEGE.
 *
 * It is belt and braces, and the braces are in another file. engine.js computes the rate
 * as `pct(submitted, submitted + notSubmitted)` and `pct` returns null for a zero
 * denominator — so at a college whose feed populates nothing, the rate is null today and
 * every shape on that side is silent today. That correctness lives entirely in a
 * one-line helper in engine.js, and a later reader changing `pct` to return 0 for an
 * empty denominator (a perfectly reasonable thing to want on a dashboard) would turn
 * every student at every unsynced college into "attends, submits nothing" without ever
 * opening this file. CLAUDE.md records this exact class of mistake as the most repeated
 * bug in this area, got wrong three times.
 *
 * It also covers the case the null path does not: a PARTIALLY broken feed, where a
 * handful of rows exist and the denominator is non-zero. There the rate is a real number
 * and it is a fact about the integration.
 *
 * WHY IT THROWS RATHER THAN FALLING SILENT — workload.js's argument, and it applies
 * unchanged. A boolean defaulting to falsy would cost the submission shapes permanently
 * and invisibly: no test would fail, no row would look wrong, and the column would simply
 * be null for every student at every college for as long as anybody left it alone. A
 * TypeError at wiring time is recoverable; three years of blank columns nobody questioned
 * is not.
 *
 * DECIDED ONCE PER RUN, HOISTED OUT OF THE CHUNK LOOP, UNFILTERED BY STUDENT. `gather()`
 * runs on chunks of 200 and the incremental path scores the handful `markStale` flagged —
 * often exactly one. At that size the question is invisible: one student with no
 * submission rows is entirely ordinary.
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
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   Every figure `profile()` takes, plus:
 *
 *   weeksIntoProgramme {number|null} weeks since the cohort started. READ, and see below.
 *   institution        {{submissionsRecorded:boolean}} REQUIRED — throws without it
 *
 * @param {object} [config] a settings config, spread over DIVERGENCE_DEFAULTS. It must
 *        carry `attendanceSlopeDrop` and `settlingInWeeks`, both of which already exist
 *        and are deliberately REUSED rather than restated — see the constants.
 * @returns {{divergenceShape, attendanceSubmissionGap, attendanceVleGap, codes}}
 */
function evaluate(raw, config) {
  const cfg = { ...DIVERGENCE_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller that forgot the probe finds out on their
  // first fixture rather than after a term of blank columns.
  assertInstitutionProbe(input.institution, "evaluate");

  const codes = [];

  // ==========================================================================
  // TRAP 6: THESE CONDITIONS CAN BE COMMON, AND BOTH HALVES OF THE RULE APPLY
  // ==========================================================================
  //
  // CLAUDE.md: "`weeksIntoProgramme` mutes the disengagement codes inside a settling-in
  // period, because in week one nobody has attendance history, marks or a pastoral
  // record, and a caseload containing the whole intake is the same as no caseload. An
  // *unknown* programme age is deliberately not exempt."
  //
  // FIRST HALF — THE MUTE APPLIES TO THIS WHOLE MODULE, and the argument is specific to
  // it rather than borrowed.
  //
  // "Attends but does not submit" describes a third of a cohort in week three, and it is
  // a fact about the CALENDAR: barely anything has been set, so barely anything is past
  // its deadline, and the submission rate for the whole intake is computed over the one
  // or two diagnostic pieces that have. The sample floors do most of that work already —
  // `minSubmissionObservations` refuses a rate over fewer than three past-due pieces — but
  // they cannot do all of it, because in the settling-in period a cohort sits AT its
  // floors rather than above them. A gap between a rate over forty registers and a rate
  // over exactly three assessments passes trap 4 on paper and violates it in spirit, and
  // it does so for the entire intake simultaneously, in the same week, for the same
  // calendar reason. That is the cohort-wide-code failure with the floors satisfied.
  //
  // WHY THIS DOES NOT SILENCE A NON-STARTER, which is the objection tripwires.js answers
  // for ABSENCE_STREAK and which has to be answered again here rather than assumed. A
  // non-starter has no DISAGREEMENT: they attend nothing, submit nothing and open nothing,
  // so every gap is near zero and this module was never going to say anything about them.
  // They are found by ABSENCE_STREAK, by TRIP_WEEKS_UNSEEN and by the register itself,
  // all of which are unmuted for exactly that reason. Nothing is lost by muting a layer
  // that only ever speaks when two figures disagree, in a period when neither figure is
  // yet worth disagreeing about.
  //
  // Worth recording that one shape is doubly protected: ATTAINING_NOT_ATTENDING needs an
  // `attendanceSlope`, which needs two full non-overlapping windows of
  // `recentAttendanceDays` (28) — about eight weeks of register — so it could not fire
  // inside a three-week settling-in period even if this mute were deleted. The mute is
  // load-bearing for the other three.
  //
  // SECOND HALF — AN UNKNOWN PROGRAMME AGE IS NOT EXEMPT. `isNum` is what enforces it: a
  // null `weeksIntoProgramme` means the cohort has neither a start date nor terms, so the
  // student cannot be placed on a calendar, and muting every code for them would fail safe
  // in the wrong direction — silence about precisely the students the timetable already
  // cannot account for. A `weeksIntoProgramme < settlingInWeeks` written without the
  // `isNum` would compare `null < 3` as `0 < 3` and mute them, which is the same one-line
  // mistake in both directions and is why both halves get a test.
  const weeks = input.weeksIntoProgramme;
  const settlingIn = isNum(weeks) && isNum(cfg.settlingInWeeks) && weeks < cfg.settlingInWeeks;

  // THE INSTITUTION GUARD, APPLIED TO THE SUBMISSION SIDE ONLY.
  //
  // It nulls the submission rate rather than suppressing the code afterwards, so the
  // refusal is visible in the returned FIGURE as well as in the absence of a code. A
  // stored gap that survived a college with no submission feed would be the evidence
  // somebody later used to argue the code should have fired.
  //
  // The VLE side is deliberately NOT gated by anything: absence is its own guard there —
  // see the note at the ONLINE_NOT_ATTENDING candidate.
  const submissionRate = input.institution.submissionsRecorded ? input.submissionRate : null;
  const submissionObservations = input.institution.submissionsRecorded
    ? input.submissionObservations
    : null;

  const shaped = profile({
    attendancePct: input.attendancePct,
    attendanceObservations: input.attendanceObservations,
    submissionRate,
    submissionObservations,
    vleActiveDayRate: input.vleActiveDayRate,
    vleObservedDays: input.vleObservedDays,
    averageGrade: input.averageGrade,
    gradedCount: input.gradedCount,
    attendanceSlope: input.attendanceSlope,
  }, cfg);

  // AT MOST ONE CODE, and it comes from the map rather than from a switch, so a shape
  // added to SHAPE without a code cannot be silently dropped — a test asserts the map is
  // total over the vocabulary in both directions.
  if (!settlingIn && shaped.shape && SHAPE_CODES[shaped.shape]) {
    codes.push(SHAPE_CODES[shaped.shape]);
  }

  return {
    // THE NAME, STORED. Not derivable from the two gaps below, because the fourth shape is
    // built out of an absolute grade judgement and a slope with no gap between them at
    // all, and because the precedence decision is not reconstructible from the figures.
    //
    // NOTE THAT IT IS RETURNED EVEN WHEN THE SETTLING-IN MUTE SUPPRESSED THE CODE. The
    // mute is a decision about the CASELOAD — do not put the whole intake on a list — and
    // not a claim that the disagreement was not observed. Blanking the figure too would
    // make "we saw this and chose not to raise it" indistinguishable from "we saw
    // nothing", which is the same distinction null-is-not-zero protects everywhere else
    // in this feature, and it is the one a reader needs when the code appears in week
    // four and somebody asks how long it had been true.
    divergenceShape: shaped.shape,

    // THE TWO GAPS, STORED BESIDE THE CODE THEY WERE RAISED ON.
    //
    // Not a duplicate of the columns they came from, and worth saying why, because the
    // obvious objection is that a screen holding `overallAttendance` and `submissionRate`
    // could subtract them itself. It could, and it would get a different number: it would
    // subtract them for every student, including the ones whose sample sizes this module
    // refused, and the refusal is most of the value. A code stored without the figure it
    // rests on cannot be defended at an appeal a year later — `cohortSize` beside the
    // percentile and `gradedWithDates` beside the late rate are the same pattern, for the
    // same reason.
    //
    // Signed, always attendance-minus-the-other-thing. See gap().
    attendanceSubmissionGap: shaped.attendanceSubmissionGap,
    attendanceVleGap: shaped.attendanceVleGap,

    // DELIBERATELY NOT RETURNED: attendanceSlope, submissionRate, onTimeRate, averageGrade,
    // gradeTrend, gradeVolatility. Every one of them arrived as an input and already has a
    // column with a definition of its own. A second copy under a slightly different name
    // is exactly how two figures that must agree begin disagreeing, and the disagreement
    // surfaces at an appeal — workload.js refuses to re-emit `oldestUnmarkedDueDate` for
    // the identical reason.
    codes,
  };
}

module.exports = {
  evaluate,
  gap,
  profile,
  DIVERGENCE,
  DIVERGENCE_CODES,
  DIVERGENCE_DEFAULTS,
  SHAPE,
  SHAPE_CODES,
};
