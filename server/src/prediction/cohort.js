// Cohort standing: where this student sits relative to the people sitting next to them.
//
// PURE. No database, no clock, no tenant. Every population arrives as an argument —
// the same seam engine.js, tripwires.js and adjustments.js keep, and for the same
// reason: these are lines a college will be asked to defend at an appeal, so they have
// to be checkable without standing up an institution's worth of fixtures.
//
// WHY THIS LAYER EXISTS AT ALL.
//
// The engine scores every student against fixed absolute thresholds. 62% attendance is
// scored identically whether the cohort mean is 58% or 91%. Those are two completely
// different situations and staff need opposite things from them:
//
//   * mean 58 — the student is ORDINARY. The finding is about the programme: a timetable
//     clash, a room across town, a unit nobody can get to on a Friday. Ringing this one
//     student changes nothing, because the next forty are in the same place and the tutor
//     cannot ring all of them.
//   * mean 91 — the student is an OUTLIER. Something is happening to this person that is
//     not happening to their peers, and that is precisely a conversation.
//
// An absolute threshold cannot tell those apart, and no amount of retuning it can: it has
// no term for the cohort in it.
//
// WHAT THIS LAYER IS *NOT* FOR, AND THIS IS THE SHARPEST EDGE IN THE FILE.
//
// It does not replace the absolute thresholds, soften them, or override anything. A
// student at the 90th percentile of a failing cohort IS STILL FAILING. If a cohort
// averages 45% attendance, the student at 60% is comfortably top-decile and comfortably
// in breach of the college's own attendance policy and, at a sponsoring provider, of the
// conditions of somebody's visa. The relative view is CONTEXT PLACED BESIDE THE SCORE,
// never a correction applied to it.
//
// The failure mode this is written against is a graceful-sounding one: "normalise the
// score against the cohort so the model is fair to weaker programmes". That silently
// grades on a curve. It excuses a weak cohort — every student in a collapsing programme
// looks average, because they are — and it punishes a strong one, where an 85% student in
// a 95% cohort acquires a risk flag for doing well. Both directions are wrong and the
// first is dangerous, because it removes from view exactly the cohorts that need
// intervening on.
//
// So, structurally:
//
//     EVERY CODE THIS MODULE CAN EMIT ADDS A FINDING. NONE OF THEM REMOVES ONE.
//
// There is no "the cohort explains it" output, no suppression flag, no multiplier, and
// nothing here is subtracted from anything. The vocabulary below is the whole surface,
// and a reader can check the claim by reading it: there is no reassuring member.
//
// WHY THE CODES ARE NAMESPACED `TRIP_`.
//
// They are appended to `riskDriverCodes`, which is the same array engine.js builds from
// its six RED indicators — and `redIndicatorCount`, which OVR-004 compares against
// `redIndicatorThreshold` to decide whether to worsen a band, is derived from engine.js's
// own internal `reds` array. `riskDriverCodes` is a COPY taken afterwards, so appending
// here provably cannot reach the override. The prefix keeps that visible: a code named
// `RED_`-something would read as the engine's, and anyone later taking the count off the
// copy would silently wire cohort standing into banding — which would be this layer
// moving a band, the one thing every paragraph above says it must never do.
//
// ============================================================================
// THE POPULATION IS A COHORT-WIDE QUESTION. READ THIS BEFORE CALLING ANYTHING.
// ============================================================================
//
// CLAUDE.md records "does this college record this field at all" as the most repeated bug
// in this area, and it has been got wrong three times. This module is the same shape of
// question one level up, and it is MORE dangerous, because the wrong answer here is a
// plausible number rather than a null.
//
//   * `gather()` runs on chunks of 200 students.
//   * The ordinary incremental path scores only the handful of students `markStale`
//     flagged — very often exactly ONE.
//
// A mean computed from the chunk is not the cohort mean. It is the mean of the students
// who happened to be dirty this morning, and those are, by construction, the students
// something has recently changed for. Comparing a struggling student against a population
// of struggling students reports them as unremarkable — the signal inverts, and it
// inverts hardest for exactly the students it exists to find.
//
// This module is pure, so it cannot make that mistake itself. Its SIGNATURE is written to
// make the caller's version of the mistake hard:
//
//   1. The population is always an EXPLICIT argument. There is no gather, no default and
//      no way to call any of this without having built a population somewhere else and
//      thought about what went into it.
//   2. Every parameter carrying one is named `cohort…`, so a variable holding the chunk
//      cannot be passed without the mismatch being visible on the line.
//   3. `MIN_COHORT_SIZE` catches the commonest form of the bug outright. An incremental
//      run that passes its own stale set as the population yields n = 1, which is below
//      the floor, so everything returns null rather than "50th percentile". The floor is
//      doing double duty and that is deliberate.
//   4. `cohortShape()` returns `n` so the caller can STORE it beside the figure. A
//      population whose n is exactly 200 is the fingerprint of a chunk-derived
//      population, and on the row it is visible to anybody reading the record rather than
//      only to somebody re-reading the gather.
//
// The caller's obligations, which nothing here can enforce:
//
//     Build the population with ONE query per run, cohort-wide, UNFILTERED by the stale
//     set, HOISTED OUT of the chunk loop — exactly as `lateRecorded` and the other four
//     institution-level probes are built. Not per chunk. Not per student. Never from the
//     rows already in hand.
const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// TRIP_-prefixed, and the prefix is structural rather than decorative. OVR-004 worsens a
// band on redIndicatorCount, which engine.js derives from its OWN internal reds array;
// riskDriverCodes is a copy taken afterwards, so nothing appended to it can reach the
// override. A code named RED_something would read as the engine's own and invite a later
// reader to take the count from the copy, which would silently wire this layer into
// banding. See the Tripwires section of CLAUDE.md.
//
// TWO CODES, BOTH ABOUT ONE STUDENT. The cohort being weak is NOT here: it fires for
// every student at once, which makes it a figure rather than a caseload entry, and it
// leaves evaluate() as `cohortStruggling` instead. The argument is at that return.
const COHORT = {
  // This student is far enough below their own cohort that the gap is a finding rather
  // than arithmetic. Both a rank test AND an absolute gap have to pass -- see the
  // constants -- because half of every cohort is below the median by definition.
  ATTENDANCE_OUTLIER: "TRIP_COHORT_ATTENDANCE_OUTLIER",
  ATTAINMENT_OUTLIER: "TRIP_COHORT_ATTAINMENT_OUTLIER",
};

const COHORT_CODES = Object.values(COHORT);

/* -------------------------------------------------------------------------- */
/* The constants, and the arguments for them                                   */
/* -------------------------------------------------------------------------- */

// THE FLOOR BELOW WHICH A COHORT CANNOT DESCRIBE ANYBODY.
//
// A percentile from a cohort of 3 is noise. From a cohort of 1 it is not even noise: the
// only student is simultaneously the best and the worst, and every definition of
// percentile returns something structurally meaningless for them (0, 50 or 100 depending
// only on which convention the author happened to pick).
//
// Why 12 rather than 2, or 5, or 10:
//
//   * A bottom DECILE is not a decile until there are ten people in the room. Below that,
//     "in the bottom 10%" and "is the single worst student" are the same statement — and
//     exactly one student in every group is the worst, always, by definition. A signal
//     that names precisely one person per group is a quota, not a finding: it would
//     produce a caseload the size of the number of cohorts in the college, whether or not
//     anything at all was wrong in any of them.
//   * One value carries 1/n of the mean it is being compared against. At n = 12 that is
//     8%; at n = 4 a student contributes a quarter of the yardstick they are measured
//     with, so a struggling student drags the mean down towards themselves and reads as
//     closer to normal than they are. The bias points the wrong way — it HIDES.
//   * FE teaching groups run to 15-20. A "cohort" below 12 in this data is usually an
//     artefact of how the grouping was built (a niche unit, a resit group, a course
//     mid-teach-out) rather than a real peer group, and the honest answer for one is "we
//     cannot compare" rather than a comparison against four people.
//
// Overridable by the caller, because a college running small specialist provision may
// disagree — but never silently, and never by default.
const MIN_COHORT_SIZE = 12;

// HOW FAR OUT "OUTLYING" STARTS. This is the constant that decides whether this feature
// produces a caseload or a phone book.
//
// BEING BELOW AVERAGE IS NOT A RISK. Half of every cohort is below the median BY
// DEFINITION, in every cohort, for ever, including a cohort in which every single student
// is thriving. A signal that fires on the bottom half produces a caseload of half the
// college, and a caseload of half the college is indistinguishable from no caseload —
// staff stop reading it, and the students who are genuinely disappearing are buried under
// four hundred who are merely on the ordinary side of ordinary.
//
// The quartile is not enough either: a quarter of a 900-student college is 225 students,
// which is still nobody's Monday morning.
//
// The bottom decile of a twenty-student group is two people. That is a tutor's morning,
// and it COMPOSES with the absolute thresholds rather than swamping them — most of the
// bottom decile of a healthy cohort is already flagged absolutely, so the students this
// adds are few, and they are precisely the ones the absolute view missed: the outlier
// inside a cohort that is otherwise doing well.
//
// It is also, deliberately, not symmetric with anything: there is no top-decile code. See
// standing() — the test is one-tailed on purpose.
const OUTLIER_PERCENTILE = 10;

// A RANK ALONE IS NOT A FINDING, AND THIS IS THE GUARD THAT SAYS SO.
//
// A cohort whose attendance runs from 88% to 92% has a bottom decile like every other
// cohort, and its members sit three points off the mean. Flagging them manufactures a
// finding out of a cohort that contains none — and it does it worst exactly where the
// cohort is doing WELL, which is the "punish a strong cohort" failure this whole file is
// organised against, pointed at one student instead of at a programme.
//
// So an outlier must be outlying by an AMOUNT, not merely occupying a POSITION: at least
// this many points the wrong side of the cohort mean, as well as inside the tail. Two
// conditions, and the second is the one that keeps the decile honest.
//
// 10 points, matching `attendanceSlopeDrop` — the movement this college has already said
// is deterioration rather than ordinary variation. Reusing that magnitude rather than
// inventing a new one keeps the two from drifting apart, which is the argument settings.js
// already makes for the four red indicators that reuse thresholds set elsewhere.
const OUTLIER_MIN_GAP = 10;

// A COHORT WITH NO SPREAD CANNOT PLACE ANYBODY IN IT.
//
// The degenerate case is a cohort in which everybody has the same value — a unit whose
// register was taken once and everybody was present, a module where every student scored
// the same pass mark. Every percentile in it is degenerate: percentile() returns 50 for
// all of them (see the midrank argument there), which is the honest answer, but a caller
// reading "50th percentile" and inferring a middle-ranked student would be inferring a
// rank that does not exist.
//
// The NEAR-degenerate case is worse than the exactly-degenerate one, because it looks
// fine. If the whole cohort sits inside two points, the ordering between students is
// decided by rounding and by which register happened to be taken, and it reshuffles on the
// next run for reasons that have nothing to do with any student. Two points of population
// standard deviation is where this file declines to pretend there is a distribution.
//
// Note this guard is about the COHORT and OUTLIER_MIN_GAP is about the STUDENT. They
// overlap heavily and neither subsumes the other: a cohort can be widely spread while one
// student sits three points below the mean (the gap catches that), and a tight cohort can
// contain one student twenty points adrift (the spread guard would let the gap through,
// so this one has to say no to the surrounding rank claim on its own account).
const MIN_COHORT_SPREAD = 2;

/** Resolve the tunables once, so every function in the file reads them identically. */
function limits(opts) {
  const o = opts || {};
  return {
    minPopulation: isNum(o.minPopulation) ? o.minPopulation : MIN_COHORT_SIZE,
    minSpread: isNum(o.minSpread) ? o.minSpread : MIN_COHORT_SPREAD,
    outlierPercentile: isNum(o.outlierPercentile) ? o.outlierPercentile : OUTLIER_PERCENTILE,
    outlierGap: isNum(o.outlierGap) ? o.outlierGap : OUTLIER_MIN_GAP,
    // Whether a LOW number is the good one, for a figure like a lateness rate. Defaults
    // false, because both figures this module was built for — attendance and attainment —
    // are higher-is-better, and a wrong default should fail in the direction of the common
    // case rather than the rare one.
    lowerIsBetter: Boolean(o.lowerIsBetter),
  };
}

/**
 * The measurable members of a population.
 *
 * NULL MEANS "NOT MEASURABLE" AND IT LEAVES BOTH SIDES.
 *
 * A student whose register was never taken has no attendance percentage. Their null must
 * not enter the population — not as a 0, obviously, but also not as a member of the
 * denominator: a cohort of 40 students of whom 25 have never been marked is a cohort of 15
 * for the purpose of describing anybody, and calling it 40 both understates the spread and
 * overstates how much the comparison is worth.
 *
 * The caller is expected to have excluded them already; this filters anyway. Two guards
 * for one fact is the house pattern wherever getting it wrong would be silent, and this
 * one is silent: a null coerced to 0 in a population of attendance percentages does not
 * throw, it drags the mean down and makes every genuinely struggling student look average.
 */
const measurable = (population) => (Array.isArray(population) ? population : []).filter(isNum);

/* -------------------------------------------------------------------------- */
/* Where one value sits in a population                                        */
/* -------------------------------------------------------------------------- */

/**
 * The percentile rank of `value` within `cohortValues`, 0-100, or null.
 *
 * WHICH DEFINITION OF PERCENTILE, AND WHY IT MATTERS MORE THAN IT LOOKS.
 *
 * Three conventions are in common use and they disagree exactly where this codebase is
 * most exposed — on ties, which are everywhere in this data because attendance
 * percentages off short registers land on the same handful of values:
 *
 *   strictly below      the worst student scores 0, and a cohort where EVERYBODY has the
 *                       same value scores 0 for all of them: "every student is in the
 *                       bottom 0% of their cohort", which is not a sentence.
 *   below or equal      the same cohort scores 100 for everybody: the mirror image, and
 *                       the dangerous one, because it reads as reassurance.
 *   midrank (this one)  below + half the equals. The all-identical cohort scores 50 for
 *                       everybody, which is the true answer — they are indistinguishable
 *                       from the middle because they ARE the middle.
 *
 * Midrank is also the only one of the three that is symmetric, so reversing the direction
 * of a figure (lateness, where low is good) reverses the percentile cleanly instead of
 * shifting everything by the size of the tie group.
 *
 * THE VALUE IS NOT ADDED TO THE POPULATION AND NOT REMOVED FROM IT. The population is the
 * cohort as the caller built it, which normally INCLUDES this student. That is the right
 * choice — "where do I stand among my peers" includes standing next to yourself, and the
 * alternative gives every student a slightly different denominator — but it is also why
 * n = 1 is meaningless and why the floor below exists.
 *
 * THE FLOOR APPLIES HERE, not only in standing(). It would be tidier to leave this as pure
 * arithmetic and put the policy one level up, but a caller reaching for the primitive is
 * exactly the caller who has not read the header, and returning 50.0 for a population of
 * one is the failure this module was written to prevent. Opting out is possible and takes
 * a deliberate `minPopulation`.
 *
 * @param {number} value
 * @param {number[]} cohortValues  COHORT-WIDE, unfiltered by the stale set. See header.
 * @param {{minPopulation?:number}} [opts]
 * @returns {number|null} 0-100 to one decimal, or null when it cannot be answered
 */
function percentile(value, cohortValues, opts) {
  const { minPopulation } = limits(opts);
  if (!isNum(value)) return null;             // not measurable — no rank, not the 0th

  const pop = measurable(cohortValues);
  if (!pop.length) return null;               // nothing to rank against
  if (pop.length < minPopulation) return null;

  let below = 0, equal = 0;
  for (const v of pop) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }

  return round1(((below + equal / 2) / pop.length) * 100);
}

/* -------------------------------------------------------------------------- */
/* What the population itself looks like                                       */
/* -------------------------------------------------------------------------- */

/**
 * Describes the COHORT, not any student in it.
 *
 * Separated from standing() because it is asked once per run per cohort and standing() is
 * asked once per student — and because "is this cohort describable at all" is a question
 * the caller should be able to ask, and log, without a student in hand.
 *
 * @param {number[]} cohortValues  COHORT-WIDE, unfiltered by the stale set. See header.
 * @param {{minPopulation?:number, minSpread?:number}} [opts]
 * @returns {{n:number, mean:number|null, median:number|null, spread:number|null, usable:boolean}}
 *
 *   n       how many MEASURABLE values the population holds. Not the length of the array
 *           handed in: nulls left both sides at the door. Store it — see point 4 of the
 *           header, this is the figure that makes a chunk-derived population visible after
 *           the fact.
 *   usable  whether this cohort may be used to place a student. Two separate reasons it
 *           can be false, and they are not the same reason:
 *
 *   TOO SMALL — n below the floor. Everything is null, including the mean, because a mean
 *   of four is not a description of anything and putting it on a screen invites somebody
 *   to read it as one. This is the null-is-not-measurable rule: we did not fail to compute
 *   it, there is nothing there to compute.
 *
 *   TOO FLAT — spread below the floor. Here the mean and median ARE reported, and this
 *   asymmetry is deliberate. "Every student in this cohort is at 91%" is a real, measured,
 *   useful fact about a real cohort; it is the RANK inside it that is meaningless, not the
 *   description of it. Nulling the mean would throw away a true finding in order to
 *   suppress a false one.
 */
function cohortShape(cohortValues, opts) {
  const { minPopulation, minSpread } = limits(opts);
  const pop = measurable(cohortValues);
  const n = pop.length;

  if (!n || n < minPopulation) {
    return { n, mean: null, median: null, spread: null, usable: false };
  }

  const mean = round1(pop.reduce((a, b) => a + b, 0) / n);

  const sorted = [...pop].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = round1(n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);

  // Population standard deviation, not the sample one. The cohort IS the population here
  // — we are not estimating the spread of some larger group of students we did not
  // observe, we are describing this teaching group — and it matches attainmentShape() and
  // weeklyRegularity() in tripwires.js, which chose the same for the same reason. With
  // n < 2 there is no spread at all, but the size floor above has already returned.
  const rawMean = pop.reduce((a, b) => a + b, 0) / n;
  const variance = pop.reduce((acc, v) => acc + (v - rawMean) ** 2, 0) / n;
  const spread = round1(Math.sqrt(variance));

  return { n, mean, median, spread, usable: spread >= minSpread };
}

/* -------------------------------------------------------------------------- */
/* Where one student stands                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One figure for one student, placed in their cohort.
 *
 * @param {number|null} value  this student's figure, null if they have none
 * @param {number[]} cohortValues  COHORT-WIDE, unfiltered by the stale set. See header.
 * @param {object} [opts]  minPopulation, minSpread, outlierPercentile, outlierGap,
 *                         lowerIsBetter
 * @returns {{percentile, mean, median, deltaFromMean, isOutlier}}
 *
 * ALL FIVE ARE NULL TOGETHER OR NONE OF THEM IS. A partial answer here would be read as a
 * whole one: a percentile beside a null mean invites somebody to compare it against the
 * absolute thresholds instead.
 *
 * `isOutlier` IS TRI-STATE, AND THE THIRD STATE IS THE POINT. true / false / null, where
 * null means "not comparable" — no figure for this student, or no cohort to compare them
 * against. Returning `false` there would say "we compared them and they are ordinary",
 * which is the null-is-not-zero rule applied to a boolean, and it is the same inversion
 * that makes a never-marked student's 0% attendance top a risk list. A reader must be able
 * to tell "we looked and they are fine" from "we could not look".
 *
 * `deltaFromMean` is `value - mean`, ALWAYS, regardless of direction: negative means below
 * the cohort mean. It is not flipped for lowerIsBetter figures, because a delta that
 * changes sign depending on a flag is a number nobody can read off a stored row a year
 * later without also knowing which flag was set at the time.
 *
 * `percentile` is likewise DIRECTION-FREE — the share of the cohort at or below this value
 * (midrank). For a lowerIsBetter figure this means the most punctual student in the group
 * scores near 0, and a screen rendering "10th percentile" as bad news would be wrong.
 * Direction lives in isOutlier and nowhere else, on purpose: one place to get it right.
 */
function standing(value, cohortValues, opts) {
  const cfg = limits(opts);
  const shape = cohortShape(cohortValues, opts);

  const nothing = { percentile: null, mean: null, median: null, deltaFromMean: null, isOutlier: null };

  // A student with no figure has no standing. NOT the 0th percentile — that would place
  // them below every peer on the strength of a register nobody took, which is the exact
  // inversion CLAUDE.md's null-means-not-measurable rule exists to prevent, and here it
  // would be laundered through a comparison and come out looking like evidence.
  if (!isNum(value)) return nothing;

  // No describable cohort: too few to describe, or too flat to rank inside. Both give a
  // null standing rather than a default one.
  if (!shape.usable) return nothing;

  const pct = percentile(value, cohortValues, opts);
  if (pct === null) return nothing;   // belt and braces; shape.usable already implies it

  const deltaFromMean = round1(value - shape.mean);

  // TWO CONDITIONS, AND BOTH ARE LOAD-BEARING.
  //
  //   in the tail  — being below average is not a risk (see OUTLIER_PERCENTILE). Half of
  //                  every cohort is below the median by definition.
  //   by an amount — a rank alone is not a finding (see OUTLIER_MIN_GAP). The bottom
  //                  decile of a cohort spanning four points is nobody in particular.
  //
  // ONE-TAILED. There is deliberately no code for standing OUT at the top: a caseload of
  // the best students in each cohort is worse than useless, it is an insult, and "outlier"
  // without a direction would generate exactly that. The tail examined is the one where
  // the student is doing WORSE than their peers, which for a lowerIsBetter figure is the
  // high end.
  const inTail = cfg.lowerIsBetter
    ? pct >= 100 - cfg.outlierPercentile
    : pct <= cfg.outlierPercentile;
  const farEnough = cfg.lowerIsBetter
    ? deltaFromMean >= cfg.outlierGap
    : deltaFromMean <= -cfg.outlierGap;

  return {
    percentile: pct,
    mean: shape.mean,
    median: shape.median,
    deltaFromMean,
    isOutlier: inTail && farEnough,
  };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Assembles the codes.
 *
 * @param {object} raw
 *   attendancePct        {number|null}  this student's attendance figure
 *   cohortAttendancePcts {number[]}     EVERY student in the cohort's attendance figure.
 *                                       COHORT-WIDE. Built by one query per run, hoisted
 *                                       out of the chunk loop, unfiltered by the stale
 *                                       set. See the header — this is the trap.
 *   averageGrade         {number|null}  this student's average grade
 *   cohortAverageGrades  {number[]}     the same, cohort-wide, same obligations
 * @param {object} config  a complete config from settings.get(); the cohort tunables are
 *        optional overrides on it and fall back to the constants in this file, because
 *        wiring them into settings.js is a separate change and this module must be
 *        correct with today's DEFAULTS unchanged.
 * @returns {{attendance, attainment, cohortAttendance, cohortAttainment, codes}}
 *
 * The two shapes are returned as well as the two standings BECAUSE OF THE HEADER: `n` on
 * the row is what makes a chunk-derived population detectable afterwards, and the mean is
 * what lets the screen say "your cohort averages 58%" instead of asking a tutor to take
 * the word of a code.
 */
function evaluate(raw, config) {
  const r = raw || {};
  const cfg = config || {};
  const codes = [];

  // Tunables travel with the rest of the config when a college has set them, and fall back
  // to this file's constants when it has not.
  const opts = {
    minPopulation: cfg.cohortMinSize,
    minSpread: cfg.cohortMinSpread,
    outlierPercentile: cfg.cohortOutlierPercentile,
    outlierGap: cfg.cohortOutlierGap,
  };

  const cohortAttendance = cohortShape(r.cohortAttendancePcts, opts);
  const cohortAttainment = cohortShape(r.cohortAverageGrades, opts);

  const attendance = standing(r.attendancePct, r.cohortAttendancePcts, opts);
  const attainment = standing(r.averageGrade, r.cohortAverageGrades, opts);

  // `=== true` rather than a truthiness test, because isOutlier is tri-state and null is
  // falsy. It reads as redundant and it is not: it documents at the call site that the
  // third state exists, so that a later reader who adds a fourth caller does not write
  // `if (!isOutlier)` and quietly treat "could not compare" as "compared, and fine".
  if (attendance.isOutlier === true) codes.push(COHORT.ATTENDANCE_OUTLIER);
  if (attainment.isOutlier === true) codes.push(COHORT.ATTAINMENT_OUTLIER);

  /* --- the cohort itself ------------------------------------------------- */

  // THE OTHER HALF OF THE OPENING ARGUMENT, and the half that is easy to leave out.
  //
  // Without this, a weak cohort produces silence: nobody is an outlier, because the
  // problem is uniform, and a feature whose whole justification was "the student is
  // ordinary and the PROGRAMME is the problem" would have found the ordinariness and
  // dropped the problem on the floor.
  //
  // THIS IS THE ONE PLACE THE ABSOLUTE THRESHOLD STILL RULES, and that is exactly the
  // point of it. The cohort mean is compared against the college's own configured
  // thresholds — the same `redAttendanceThreshold` the engine already uses for one student,
  // asked of forty. Nothing relative can raise this code and nothing relative can suppress
  // it, which is what stops this module from grading on a curve: however the distribution
  // is shaped, a cohort below the line is reported as below the line.
  //
  // IT FIRES FOR EVERY STUDENT IN THE COHORT AT ONCE, and that is why it is NOT a code.
  //
  // An earlier version of this block argued the opposite at length — that it could be a
  // code because it is "the caption under a caseload entry rather than an entry itself",
  // with its audience a curriculum manager rather than a tutor. That argument was
  // rejected on review and the code was changed; the paragraph making it survived, so
  // this file spent several commits carrying two contradictory specifications of the
  // same value. In a codebase where the comments ARE the specification, that is a real
  // hazard, and it is recorded here rather than quietly deleted.
  //
  // What settled it: `riskDriverCodes` is a per-student array and nothing downstream can
  // tell a caption from an entry. A hundred students carrying one identical reason is a
  // caseload of a hundred, which is the same as no caseload — the judgement metrics.js
  // had already made for `assessmentsDueSoon`. So the finding leaves `evaluate()` as its
  // own field and the screen renders it once.
  //
  // The two thresholds below are the college's own, reused rather than reinvented.
  const attendanceLine = isNum(cfg.redAttendanceThreshold) ? cfg.redAttendanceThreshold : null;
  // For attainment, pass + near-miss margin rather than the bare pass mark. A cohort whose
  // AVERAGE sits on the pass mark is a cohort half of which is failing; waiting for the
  // mean to drop below 40 before saying anything means saying it long after the year is
  // unrecoverable. This reuses the two thresholds the college has already set rather than
  // introducing a third for the same idea — settings.js makes that argument for the reds.
  const gradeLine = isNum(cfg.passThreshold) && isNum(cfg.nearFailMargin)
    ? cfg.passThreshold + cfg.nearFailMargin
    : null;

  // A null mean is a cohort too small to describe, not a healthy one. It must not raise
  // this code, and it must not be read as clearing the programme either — which is why
  // `n` goes back to the caller alongside.
  const weakAttendance = isNum(cohortAttendance.mean) && attendanceLine !== null
    && cohortAttendance.mean < attendanceLine;
  const weakAttainment = isNum(cohortAttainment.mean) && gradeLine !== null
    && cohortAttainment.mean < gradeLine;

  // A FIGURE, NOT A CODE, AND THE DISTINCTION IS THE WHOLE POINT.
  //
  // This one fires for every student in the cohort at once, because it is not about any
  // of them -- it says the PROGRAMME is in trouble. riskDriverCodes is a per-student
  // caseload array: whatever lands in it is read as "here is why THIS student is on the
  // list", and a hundred students each carrying an identical reason is a caseload of a
  // hundred, which is the same as no caseload at all.
  //
  // metrics.js already settled this exact question for assessmentsDueSoon -- "a fact
  // about the timetable rather than the student, so it is a figure and never a code -- it
  // would fire cohort-wide" -- and the same reasoning applies unchanged here.
  //
  // So it leaves as its own field. Its audience is a curriculum manager looking at one
  // programme, not a tutor working a caseload, and the two want it on different screens.
  // Returning it separately is what lets the client render it once as a caption rather
  // than a hundred times as an alarm.
  const cohortStruggling = (cohortAttendance.mean === null && cohortAttainment.mean === null)
    ? null                                   // too small to describe: not a healthy cohort
    : Boolean(weakAttendance || weakAttainment);

  return { attendance, attainment, cohortAttendance, cohortAttainment, cohortStruggling, codes };
}

module.exports = {
  percentile, standing, cohortShape, evaluate,
  COHORT, COHORT_CODES,
  MIN_COHORT_SIZE, OUTLIER_PERCENTILE, OUTLIER_MIN_GAP, MIN_COHORT_SPREAD,
};
