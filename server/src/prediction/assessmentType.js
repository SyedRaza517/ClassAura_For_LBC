// Assessment type: does this student fail a particular KIND of assessment?
//
// PURE. No database, no clock, no tenant. Everything arrives as arguments — the same
// seam as tripwires.js, sessions.js, coverage.js and engine.js, and for the same reason:
// these are lines a college will be asked to defend at an appeal, so they have to be
// checkable without standing up an institution's worth of fixtures.
//
// WHY THIS EXISTS, AND WHY THE AVERAGE IS THE THING THAT HIDES IT.
//
// `Assessment.type` — "Assignment | Exam | Presentation | Project | Portfolio" — has
// been in the schema since the gradebook was built, is validated in routes/assessments.js
// against that fixed list, and is displayed on the assessment itself. Nothing in the
// prediction layer has ever read it. So a student who passes every piece of coursework
// and fails every exam arrives at the engine as a middling average, and the average is
// precisely the operation that destroys the distinction: 85, 85, 85, 20, 20, 20 and six
// steady 55s are the same number and are not the same student.
//
// The distinction changes the intervention completely. Exam technique, timed-conditions
// practice, reasonable adjustments and access arrangements are a different purchase from
// essay support, referencing workshops and study skills, and a college that cannot see
// which one it needs buys the wrong one. It is also one of the strongest signals in this
// dataset for an undiagnosed access need — a student who can do the work but not under
// timed conditions is the textbook presentation — and that is both actionable and
// time-sensitive, because an assessment arrangement has to be in place before the next
// exam board rather than after it.
//
// THE INPUT SHAPE, AND THE ONE FIELD METRICS.JS DOES NOT CARRY YET.
//
// metrics.js already computes a percentage per grade, at line 866:
//
//     pct = round1(g.marks / (a.maxMarks > 0 ? a.maxMarks : 100) * 100)
//
// and already hands flattened `{ pct, weight }` pairs to tripwires.weightedGrade. This
// module takes the same shape plus one more field:
//
//     { pct, type }        type = Assessment.type, which the select does NOT yet carry
//
// THE PERCENTAGE IS TAKEN, NEVER RE-DERIVED, and that is a deliberate refusal rather
// than laziness. A mark of 18 means nothing without its maximum, and re-deriving it here
// would mean a second copy of the `maxMarks > 0 ? maxMarks : 100` guard — the exact half
// a re-implementation forgets, because a zero maximum is a row nobody has in front of
// them while they are writing the division. Two implementations of one number drift, and
// the drift would show up as a pass rate that disagreed with the average sitting next to
// it on the same screen, with no way to tell which of the two was wrong. So this module
// never sees `marks` or `maxMarks` at all: if it is not a `pct`, it is not evidence here.
//
// WHY THERE IS EXACTLY ONE CODE, AND WHY THE OBVIOUS SECOND ONE IS A FIGURE.
//
// "This student does better at coursework than at exams" is a compelling sentence and it
// must NOT be a caseload entry, because it is true of most students at most colleges.
// Coursework is done with notes, over weeks, with feedback available; an exam is done
// once, from memory, against a clock. A gap between the two is the ordinary shape of
// assessment design rather than a fact about a person, and CLAUDE.md is blunt about what
// happens to a signal like that: "A signal that fires for a whole cohort at once is a
// FIGURE, not a code... a hundred rows carrying an identical reason is the same as no
// caseload."
//
// So the gap is returned as a number and raises nothing on its own. The code requires
// something the gap cannot supply — see THE COHORT PROBLEM below.
//
// WHY THE CODE DOES NOT NAME THE TYPE.
//
// One code, with the type stored beside it as a figure — not TRIP_FAILS_EXAMS,
// TRIP_FAILS_PRESENTATIONS and three more. `Assessment.type` is a plain String column
// with a default, not a Prisma enum; the route layer validates against a five-item list
// today and a college asking for "Viva" or "Practical" gets it by editing one array. A
// per-type code vocabulary would therefore be unbounded, could not be asserted disjoint
// against the nine vocabularies already writing `riskDriverCodes`, and would orphan every
// stored history row the day somebody renamed a type. The code says "there is a kind of
// assessment this student fails"; the figure says which one, and the client renders the
// intervention from the figure.
//
// THE COHORT PROBLEM, WHICH IS THE HARDEST THING IN THIS FILE.
//
// A whole cohort can fail the same exam. If the January paper was simply too hard then
// every student in the room has a low exam mark against a respectable coursework record,
// and a code fired off that comparison lands on all of them at once — a fact about the
// exam board wearing a student's name. The evidence that would separate "this student
// cannot sit exams" from "nobody could sit that exam" is the REST OF THE COHORT'S exam
// marks, and it does not live in this module. It lives in cohort.js, which is built once
// per run from StudentPredictionCurrent, institution-wide. Computing a population here,
// from the chunk of 200 this module is handed, is the chunk-derived-population bug that
// CLAUDE.md records `cohortSize` as being STORED to make detectable — so it is not an
// option, and this module takes no population argument at all so that it cannot become
// one by accident.
//
// What is done about it, in three parts:
//
//   1. AN ABSOLUTE TEST AS WELL AS A RELATIVE ONE. CLAUDE.md: "Being below average is not
//      a risk... a cohort signal needs BOTH a rank test and an absolute gap." The worst
//      type's PASS RATE must be at or below `typePassRateCeiling` — the student must
//      actually be FAILING that type, not merely scoring less well at it. A cohort that
//      finds exams harder than coursework, which is nearly every cohort, does not clear
//      this; a cohort that fails its exams outright does, and that is a different and
//      much rarer thing.
//
//   2. THE REST MUST BE PASSING, WHICH FALLS OUT OF THE ARITHMETIC RATHER THAN NEEDING A
//      FOURTH CONSTANT. A worst-type pass rate at or below 34 with a pass-rate gap of at
//      least 40 forces the pooled rest above 74%. So a struggling student — or a
//      struggling cohort, failing everything — cannot fire this at all: the gap is nil
//      because both sides are bad. Only a cohort failing exactly one type while passing
//      the others can, and at that point what is on the screen is a college's exam board
//      rather than a caseload.
//
//   3. THE TYPE IS STORED, SO THE COHORT CASE IS VISIBLE RATHER THAN SILENT. Forty rows
//      naming "Exam" is legible as an exam-board problem in a way forty rows carrying an
//      opaque code is not. Same reason sessions.js returns `worstWeekday` as a number a
//      human reads next to the timetable.
//
// The residual risk is real and is stated rather than argued away: a genuinely brutal
// paper that a whole cohort failed while passing their coursework WILL fire this for the
// whole cohort. It is bounded (it needs the absolute failure, not just the gap), it is
// self-describing (the type is on the row), and closing it properly needs a per-type
// cohort baseline threaded through cohort.js. Anybody adding one has to satisfy the test
// workload.js already meets: every `codes.push` guarded by the shared half AND by
// something true of this student and not of their neighbours.
//
// WHY THE CODE IS NAMESPACED `TRIP_`.
//
// It is appended to `riskDriverCodes`, the same array engine.js builds from its six RED
// indicators. `redIndicatorCount` — the input to OVR-004, which can worsen a band — is
// derived by engine.js from its own internal `reds` array, and `riskDriverCodes` is a
// copy taken afterwards, so appending here provably cannot reach the override. The prefix
// is what keeps that visible: a code named `RED_`-anything would read as the engine's
// own, and the next person to take a count off the copy rather than off engine.js's
// `reds` would silently wire the shape of an exam timetable into a student's band. Keep
// the prefix; keep the count off the copy.
//
// WHY THERE IS NO DATE AND NO `today`.
//
// This module answers a SHAPE question — which kind of work does this student fail — and
// a shape has no date. `TRIP_RECENT_FAIL` already answers "have they failed something
// lately" and `engagementRecency` already answers "when did anything last happen", so a
// third date here would be the seventh count of the same thing sessions.js warns against.
// Nothing is returned that a reader could mistake for a day count, which is the failure
// mode CLAUDE.md names: "19 days since last attended" written to a column is wrong by the
// next morning with nothing to correct it. `today` is therefore not an argument, because
// nothing here needs one — and if a later reader adds a recency figure it must arrive as
// an argument and be stored as a DATE, never as a count of days.

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

// Stored in StudentPredictionCurrent.riskDriverCodes and in every history row, so these
// strings outlive several rewrites of the screen. Structured codes, never display text —
// the client maps them to wording, and rewording must not orphan a stored row.
const ASSESSMENT_TYPE = {
  // There is a KIND of assessment this student fails, while passing the rest of their
  // work. Named for the finding rather than for the type: which type it is arrives as a
  // figure on the same row, for the reason given in the header — the type list is a
  // mutable array in a route file, and a vocabulary that grows when somebody adds "Viva"
  // is a vocabulary that cannot be asserted disjoint.
  //
  // NOT "TRIP_EXAM_FAILING". Presentations are the second-commonest answer here and the
  // one with the sharpest pastoral reading — a student who scores well on paper and
  // freezes in front of a room is a specific, supportable case — and a code named for
  // exams would have quietly excluded them from a feature that finds them.
  TYPE_FAILING: "TRIP_ASSESSMENT_TYPE_FAILING",
};

const ASSESSMENT_TYPE_CODES = Object.values(ASSESSMENT_TYPE);

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
const round1 = (n) => Math.round(n * 10) / 10;

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Platform defaults, in the shape settings.js uses: defaults in code, overridden by
// whatever the caller merges over them. Deliberately NOT added to settings.js here —
// wiring is a separate change, and a config key that nothing reads is worse than no key
// at all. Every function takes an `opts`/`config` spread OVER these, so the day they move
// into DEFAULTS the callers do not change.
//
// EVERY FLOOR BELOW IS ARGUED AGAINST ONE settings.js ALREADY CARRIES rather than picked
// for looking round. The four that matter are `lateSubmissionMinPieces` (3, the floor on
// a rate over MARKED PIECES OF WORK), `disperseMinMarks` (4, the floor on one slice of a
// register being compared against another), `unitSpreadLimit` (40, how far apart two
// slices must be before the gap is worth reporting on its own) and `nearFailMargin` (10,
// the smallest difference in marks this codebase already treats as meaning anything).
const ASSESSMENT_TYPE_DEFAULTS = {
  // RESTATED FROM settings.js, NEVER A SECOND OPINION — same key name, same value, so a
  // real config always wins. It is here because without it `g.pct >= cfg.passThreshold`
  // compares against undefined and is false for everything: a student passing every piece
  // at 75-90%% is stored as failing 100%% of both types. The code cannot fire (the gap is
  // 0) so no caseload is harmed, but the ROW says a straight-A student fails all their
  // exams, and this module is exported and callable directly.
  //
  // Failing toward a confidently wrong figure is the wrong direction for a file whose
  // whole argument is that a missing measurement must be silent. divergence.js solved
  // this for itself the same way; a test pins both against settings.DEFAULTS.
  passThreshold: 40,

  // THE FEWEST MARKED PIECES OF ONE TYPE BEFORE ITS PASS RATE MAY BE NAMED.
  //
  // Three — `lateSubmissionMinPieces` exactly, and that is the closest existing analogue
  // rather than the nearest round number: it is the floor settings.js puts on a rate
  // computed over marked pieces of work, and it exists there for the identical reason.
  // "One piece handed in a day late reads 100%, and the screen calls that a pattern." One
  // exam failed reads "failed 100% of exams", and a pattern claimed from a single data
  // point is the loudest thing on the screen and the emptiest.
  //
  // DELIBERATELY NOT disperseMinMarks (4), which sessions.js and unitDispersion both use
  // for a slice of a REGISTER. Assessments are an order of magnitude scarcer than register
  // marks: a unit carries three or four pieces of work across a year, against a register
  // with a mark every week. A floor of four would silence this until the second year at
  // any college running one exam per unit — which is most of them — and the students it
  // exists to find would have sat four exams by the time it spoke.
  //
  // Three is also where the quantisation stops lying. With three pieces the reachable
  // pass rates are 0, 33.3, 66.7 and 100; with two they are 0, 50 and 100, and a single
  // resit failure would read exactly as a student who cannot sit exams.
  typeMinGrades: 3,

  // THE FEWEST MARKED PIECES ON THE OTHER SIDE OF THE COMPARISON.
  //
  // Four — `disperseMinMarks` — and the asymmetry against the three above is the point
  // rather than an oversight. A gap is TWO numbers, and a floor on only the interesting
  // one is the classic half-guard: "failed all three exams against 100% on the two
  // assignments we have" is a hundred-point gap drawn from two rows, and it is the shape
  // of claim that survives review precisely because the interesting half looks properly
  // guarded. sessions.js states the same rule for `weekdayMinOtherMarks`.
  //
  // The pooled side must never be the THINNER of the two, or the baseline the finding
  // rests on is flimsier than the finding. Four is one more than the slice floor and is
  // the number settings.js already uses for a denominator meant to be the steady one.
  //
  // NOT minMarksForRate (6). Six plus three is nine marked pieces, which at a college
  // assessing four times a unit is most of a year, and it would silence this for exactly
  // the first-year students an access arrangement has to be found for before their second
  // set of exams rather than after.
  typeMinOtherGrades: 4,

  // HOW MANY TYPES MUST CLEAR THE FLOOR BEFORE ONE IS CALLED THE WORST.
  //
  // Two, mirroring unitDispersion's `usable.length < 2` and sessions.minWeekdaysMeasured.
  // "The worst assessment type" is a superlative, and a superlative over one candidate is
  // not a comparison — it is a restatement of that type's own pass rate wearing a
  // comparative's clothes, and it would read on the screen as though four other types had
  // been ruled out. This is also the guard that makes a college with one type in use
  // produce nulls rather than a finding.
  minTypesMeasured: 2,

  // THE ABSOLUTE HALF: HOW BADLY THE WORST TYPE MUST GO BEFORE IT MAY RAISE A CODE.
  //
  // A pass rate at or below 34%. CLAUDE.md: "Being below average is not a risk... a
  // cohort signal needs BOTH a rank test and an absolute gap." This is the absolute half,
  // and without it the code fires on every student at every college, because doing worse
  // at exams than at coursework is the ordinary shape of assessment design rather than a
  // fact about anybody.
  //
  // THE NUMBER IS CHOSEN AGAINST THE QUANTISATION, NOT ROUNDED FOR LOOKS. At the minimum
  // denominator of three, the reachable pass rates are 0, 33.3, 66.7 and 100. A ceiling
  // of 33 would exclude 33.3 — "passed one of three exams" — by a rounding artefact
  // rather than by a decision, and the argument for excluding it would never have been
  // written down because nobody would notice it had been made. 34 admits one-in-three and
  // one-in-four and excludes two-in-four (50%), which is the intended line: at half, the
  // student passes this type sometimes and the finding is not "they fail it".
  typePassRateCeiling: 34,

  // THE RELATIVE HALF, IN PERCENTAGE POINTS OF PASS RATE.
  //
  // Forty — `unitSpreadLimit` — because it is the same shape of question and settings.js
  // has already argued it: "How far apart the best and worst unit may be, in percentage
  // points, before that gap is worth reporting on its own. A student at 90% in three
  // units and 20% in a fourth has an overall figure that looks survivable and a problem
  // that is not." Substitute "type" for "unit" and the sentence is unchanged. Inventing a
  // second opinion would leave two numbers to drift apart with no reason ever recorded
  // for why they differed.
  //
  // Paired with the ceiling above this is also what forces the pooled rest above 74% —
  // the guard, arithmetic rather than remembered, that stops a student failing everything
  // from firing a signal about one type.
  typePassRateGap: 40,

  // THE SECOND RELATIVE HALF, IN PERCENTAGE POINTS OF MARK, AND IT IS NOT REDUNDANT.
  //
  // Ten — `nearFailMargin`, the smallest difference in marks this codebase already treats
  // as meaning something.
  //
  // A pass rate is a THRESHOLDED number, and a threshold turns an arbitrarily small
  // difference into an absolute one. A student whose exam marks are 38, 39, 39 and whose
  // coursework is 41, 42, 41, 42 has a pass rate of 0% against 100% — a hundred-point
  // gap, the loudest possible reading — and is in fact uniformly borderline at everything.
  // Telling that student the answer is exam technique is worse than telling them nothing,
  // because it is specific, confident and wrong, and it costs them the general academic
  // support they actually need.
  //
  // So the MARKS have to separate the two sides as well as the threshold does. Ten points
  // is the width settings.js already calls the difference between failing and being
  // comfortable; below it the two groups are one distribution sitting either side of a
  // line.
  typeMeanGap: 10,
};

/* -------------------------------------------------------------------------- */
/* The institution probe                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Refuse to answer a type question without an institution-wide answer to "does this
 * college distinguish assessment types AT ALL?"
 *
 * WHY THIS THROWS INSTEAD OF DEFAULTING TO SILENCE.
 *
 * `Assessment.type` is `@default("Assignment")`. Every assessment created in Staff Hub
 * before somebody changes the dropdown carries it; every assessment the Moodle importer
 * creates carries it — moodle.js line 449 hardcodes `type: "Assignment"` on every grade
 * item it mirrors, so at a synced college the field is not merely unused, it is filled in
 * WRONGLY by construction; and a college that simply does not care about the distinction
 * carries it on every row it will ever write.
 *
 * AND THE DEFAULT HERE IS A REAL VALUE, WHICH IS WHY THIS PROBE IS HARDER THAN THE ONE IN
 * sessions.js AND CANNOT BE REPLACED BY A FILTER. `HndSession.kind` defaults to "", which
 * is not the name of any session kind, so sessions.js can drop the empty bucket into
 * `unkeyed` and lose nothing. "Assignment" is not that. It is the name of the commonest
 * assessment type there is, and it is the COURSEWORK SIDE — the very baseline an exam
 * would be compared against. Filtering it out would delete the comparison; keeping it
 * without knowing whether it means anything is how a college that has never touched the
 * field comes to be told which kind of work its students fail.
 *
 * Read from the chunk, none of that is visible. CLAUDE.md records this as the most
 * repeated bug in this area, got wrong three times: gather() runs on chunks of 200 and
 * the ordinary incremental path scores the handful of students markStale flagged — often
 * exactly one. THE TWO CASES THAT LOOK IDENTICAL IN A CHUNK AND ARE NOT:
 *
 *   * A student whose eight marked pieces are all "Assignment" AT A COLLEGE THAT USES
 *     TYPES is a real absence of evidence — we have no exam record for them yet, and one
 *     may arrive next term.
 *   * The same eight rows AT A COLLEGE THAT HAS NEVER SET THE FIELD are not evidence of
 *     anything at all; they are eight rows of unknown type wearing a default.
 *
 * Same array, different answers, and only an institution-wide count separates them. This
 * module makes the difference legible in its OUTPUT rather than hiding it: with the probe
 * true and one type in play, `typesMeasured` is 1 — the question was asked and there was
 * nothing to compare against. With the probe false it is `null` — the question could not
 * be asked. A reader who finds nulls everywhere can tell which of the two they are
 * looking at, which is the whole point of the guard; a reader who found 1 everywhere
 * would "fix" it by dropping minTypesMeasured to 1 and start naming a worst type with no
 * comparison behind it.
 *
 * The existing guards in tripwires.js take a boolean that defaults to falsy and fall
 * silent when it is missing. That is right for them: a missing flag there costs one code
 * that does not fire. Here it would cost the whole type dimension permanently and
 * silently — every figure null for every student at every college, no test failing, no
 * row looking wrong. A feature that quietly does nothing is not discoverable by reading
 * the output, and the Moodle default above guarantees it would look exactly like working
 * code.
 *
 * So this fails the way db.js fails a query with no tenant context, and the way
 * coverage.js and sessions.js fail a missing probe: loudly, at the first call, in the
 * caller's own test run. A TypeError at wiring time is recoverable; three years of blank
 * columns nobody questioned is not.
 *
 * It is a POSITIONAL parameter rather than a key on `opts`, for the reason
 * coverage.registerCoverage, workload.carriedBacklog and sessions.kindShape all take
 * theirs positionally: an options bag is the thing a caller assembles from a config
 * object and forgets to add to, and `typeShape(grades, opts)` would still be a
 * legal-looking call that silently answered a different question.
 *
 * WHAT THE PROBE MUST ACTUALLY COUNT, because the obvious query is wrong:
 *
 *     count(Assessment where type NOT IN ("Assignment", "")) > 0
 *              — institution-wide, unfiltered by student, hoisted out of the chunk loop
 *
 * NOT `count(Assessment) > 0`, which is true at every college that ever created a single
 * piece of work and answers a completely different question — the same mistake
 * coverage.js documents for the timetable probe and funding.js for the SLC one. The empty
 * string is excluded alongside the default because a blank type is an unset type written
 * by something that bypassed the route layer, not a sixth kind of assessment.
 *
 * A groupBy on `type` counting DISTINCT values was considered and rejected: it is a
 * heavier query issued once per run for an answer strictly weaker than the pair of guards
 * already here. "Does more than one type appear" is what `minTypesMeasured` tests, per
 * student, on the grades actually in front of it. What the probe has to answer — and what
 * only a count of non-default rows can answer — is whether the field was ever FILLED IN,
 * which is a different question and the one the default makes invisible.
 *
 * @param {{assessmentTypesRecorded:boolean}} institution
 */
function assertInstitutionProbe(institution, fnName) {
  if (!institution || typeof institution.assessmentTypesRecorded !== "boolean") {
    throw new TypeError(
      `${fnName}: institution.assessmentTypesRecorded must be a boolean — an `
      + "institution-wide probe result, decided once per run and never derived from one "
      + "student's rows",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The shape                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-type mean and pass rate, the worst type, and the gap between it and the rest.
 *
 * A TYPE THE STUDENT HAS NEVER BEEN ASSESSED ON IS NOT 0% AND NOT 100%. This is trap
 * three, and it falls out of the structure rather than needing a branch: the buckets are
 * built FROM the grades, so a type with no grades has no bucket, appears in no numerator
 * and no denominator, and cannot be named the worst. A college that runs no presentations
 * produces no presentation bucket for anybody — a fact about the assessment design that
 * this module is simply unable to report as a fact about a student. An implementation
 * that seeded the five known types as zeroed buckets to "make the array complete" would
 * invert exactly that, and it is the obvious tidy-up: every student would then be failing
 * 100% of the types nobody has ever set them.
 *
 * A GRADE WITH NO USABLE TYPE LEAVES BOTH SIDES AND IS COUNTED RATHER THAN DROPPED,
 * exactly as sessions.sliceShape counts an unkeyed mark and workload.deadlineClusters
 * counts an undated assessment. It is not evidence about any type and it is not evidence
 * that any type is clean; the count comes back so a caller can see how much of the corpus
 * was invisible, which is what distinguishes "the select is missing a column" from "this
 * college does not use types".
 *
 * A GRADE WITH NO USABLE `pct` LEAVES BOTH SIDES TOO, for the same reason and counted
 * separately. It is not a mark of zero. Coercing an unmeasurable mark to 0 would put the
 * student at the top of a fail list for a piece of work nobody scored, which is the
 * inversion this whole codebase is organised around.
 *
 * THE COMPARISON IS WORST-AGAINST-THE-POOLED-REST, not worst-against-best, following
 * sessions.sliceShape rather than unitDispersion. Two reasons. The denominator: "the rest
 * of their work" is every other mark the student has, which is a far steadier number than
 * one other type chosen for being the best — and the best of five noisy rates is as noisy
 * as the worst. The sentence: "she fails every exam and passes everything else" is what a
 * tutor says, while "her best assessment type is Portfolio" is not a finding about exams
 * at all.
 *
 * THE POOLED SIDE INCLUDES TYPES TOO THIN TO BE NAMED. A type holding two marks cannot be
 * called the worst — that is what `typeMinGrades` is for — but those two marks are still
 * two honest observations of what this student does at work that is not an exam.
 * Excluding them would shrink the only denominator in the comparison that is meant to be
 * the large one.
 *
 * THE GAPS ARE NOT CLAMPED AT ZERO. The worst NAMEABLE type can sit above the pooled rest,
 * because the pool contains types that were too thin to name and one of them may be worse.
 * A negative gap is the honest reading — "the type we can measure is not the problem" —
 * and clamping it to 0 would manufacture a tie between that and a student whose work is
 * genuinely flat. coverage.staleness leaves a negative day count alone for the same
 * reason.
 *
 * @param {Array<{pct:number, type:string}>} grades  any order. `pct` is metrics.js's
 *        already-computed percentage of the assessment's own maxMarks — see the header
 *        for why it is never re-derived here.
 * @param {{assessmentTypesRecorded:boolean}} institution  REQUIRED — throws without it
 * @param {{passThreshold, typeMinGrades, typeMinOtherGrades, minTypesMeasured}} [opts]
 */
function typeShape(grades, institution, opts) {
  assertInstitutionProbe(institution, "typeShape");
  const cfg = { ...ASSESSMENT_TYPE_DEFAULTS, ...(opts || {}) };

  const all = grades || [];
  // A mark that is not a finite number is not an observation. Split out before anything
  // else so that both the typed and the untyped counts below describe MARKS rather than
  // rows, and so `unscored` is visible on its own — a corpus that is mostly unscored is a
  // gather that is broken, not a student who is fine.
  const scored = all.filter((g) => g && isNum(g.pct));
  const unscored = all.length - scored.length;

  // THE INSTITUTION GUARD. Not an empty result computed from the grades — an explicit
  // refusal, with the whole corpus reported as untyped so a reader can see that nothing
  // was measured rather than that nothing was found. Returning zeroes here would say "we
  // looked at the types and there were none", about a college that does not have the
  // concept — and at a Moodle-synced college that sentence would be printed against a
  // gradebook in which every single row says "Assignment".
  if (!institution.assessmentTypesRecorded) {
    return {
      types: [],
      worstType: null,
      worstTypePassRate: null,
      worstTypeMeanPct: null,
      passRateGap: null,
      meanGap: null,
      // NULL, NOT ZERO, and the distinction is the one this whole codebase turns on. Zero
      // says "we counted the types that cleared the floor and there were none" — a
      // statement about a sample. This branch is reached when the college records no types
      // AT ALL, so there was no sample to count and the honest answer is that the question
      // could not be asked. The same reasoning submissionTiming gives for returning a null
      // `gradedWithDates` rather than a 0, and sessions.kindShape for `kindsMeasured`.
      //
      // `typesSeen` stays 0 because it means something different: how many distinct type
      // strings appeared, and none did — because none was looked at.
      typesMeasured: null,
      typesSeen: 0,
      untyped: scored.length,
      unscored,
    };
  }

  const buckets = new Map();
  let untyped = 0;
  let totalGraded = 0;
  let totalPassed = 0;
  let totalPct = 0;

  for (const g of scored) {
    // "" is what a row written outside the route layer carries, and a blank type is an
    // UNSET type rather than a sixth kind of assessment — the same reading sessions.js
    // gives HndSession.kind's "" and tripwires.js gives a weight of 0. Trimmed first,
    // because " Exam" and "Exam" are one type and two buckets would halve both
    // denominators.
    //
    // NOT CASE-FOLDED, deliberately. routes/assessments.js validates every hand-entered
    // type against a fixed five-item list and moodle.js writes the exact string
    // "Assignment", so the casing in the database is controlled at both write paths.
    // Folding would report a type name in a casing the college never typed — onto a
    // screen and into a stored history row — to solve a problem neither writer can create.
    const type = typeof g.type === "string" ? g.type.trim() : "";
    if (!type) { untyped += 1; continue; }

    // `pct >= passThreshold` passes, which is exactly tripwires.attainmentShape's rule
    // (`p < config.passThreshold` is a fail) stated the other way up. A mark sitting
    // exactly on the pass mark is a pass; writing it out here rather than relying on the
    // reader to invert the other file's comparison is the difference between one
    // definition and two.
    //
    // The threshold is the PREDICTION one, `config.passThreshold`, default 40 and
    // settable per tenant. Deliberately NOT routes/assessments.js's PASS_MARK of 50,
    // which is that screen's Distinction/Merit/Pass banding: a college that changes its
    // progression pass mark in Settings is entitled to expect this figure to move with it,
    // and a hardcoded 50 here would silently disagree with the failCount sitting beside it
    // on the same row.
    const passed = g.pct >= cfg.passThreshold;

    const b = buckets.get(type) || { type, graded: 0, passed: 0, sum: 0 };
    b.graded += 1;
    b.sum += g.pct;
    if (passed) b.passed += 1;
    buckets.set(type, b);

    totalGraded += 1;
    totalPct += g.pct;
    if (passed) totalPassed += 1;
  }

  const empty = {
    types: [],
    worstType: null,
    worstTypePassRate: null,
    worstTypeMeanPct: null,
    passRateGap: null,
    meanGap: null,
    // ZERO here, not null, and the contrast with the branch above is the whole design.
    // The question WAS asked — this college records types — and the answer is that none of
    // this student's work cleared the floor, or that there was no typed work to clear it.
    // That is a statement about a sample, and it is a different statement from "there was
    // no sample".
    typesMeasured: 0,
    typesSeen: 0,
    untyped,
    unscored,
  };

  if (!buckets.size) return empty;

  // Sorted by type name so the output is deterministic — a figure that changed between two
  // runs with nothing about the student having changed makes the whole row untrustworthy,
  // and Map iteration order is insertion order, which is the order Postgres happened to
  // return the grades in.
  const types = [...buckets.values()]
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
    .map((b) => ({
      type: b.type,
      graded: b.graded,
      passed: b.passed,
      failed: b.graded - b.passed,
      // Both rates on a bucket are always computable — this is the bucket's OWN
      // denominator, which is at least 1 by construction. Whether either may be REPORTED
      // as a finding is the floor's question, below, and the two are kept apart so a test
      // can see a thin type's arithmetic without the module having claimed anything about
      // it.
      passRate: round1((b.passed / b.graded) * 100),
      meanPct: round1(b.sum / b.graded),
      measurable: b.graded >= cfg.typeMinGrades,
    }));

  const measurable = types.filter((t) => t.measurable);
  const base = { types, typesMeasured: measurable.length, typesSeen: buckets.size, untyped, unscored };

  // NOT ENOUGH NAMEABLE TYPES. Null, never 0 and never the single type's own rate: with
  // one measurable type there is nothing to concentrate against, and printing its pass
  // rate under the heading "worst assessment type" would state a comparison that was never
  // made. This is also the branch a college with one type in use lands in, on every
  // student, for ever — which is correct, and is why the institution probe above has to be
  // a separate guard rather than something this branch could stand in for: the two produce
  // the same nulls for opposite reasons, and only `typesMeasured` tells them apart.
  if (measurable.length < cfg.minTypesMeasured) {
    return {
      ...base,
      worstType: null,
      worstTypePassRate: null,
      worstTypeMeanPct: null,
      passRateGap: null,
      meanGap: null,
    };
  }

  // Lowest pass rate wins. Ties broken by the lower MEAN — two types at 0% are not equally
  // bad if one averages 38 and the other 9, and the mean is the finer instrument — and
  // then, because `types` is already sorted by name, by the alphabetically first. Both
  // comparisons are STRICT, so the first of true equals is kept without a third test; the
  // same tie-break sessions.sliceShape and workload.peakLoad use, and it is the one easily
  // lost to a later `<=`.
  let worst = measurable[0];
  for (const t of measurable) {
    if (t.passRate < worst.passRate) worst = t;
    else if (t.passRate === worst.passRate && t.meanPct < worst.meanPct) worst = t;
  }

  // The pooled rest, from the RAW running totals rather than from the rounded per-type
  // figures. `worstRaw.sum` is the unrounded total for the worst bucket; subtracting
  // `worst.graded * worst.meanPct` instead would subtract a rounded mean multiplied back
  // up. round1 moves a mean by at most 0.05, so the error in the pooled sum is up to 0.05
  // per piece in the WORST bucket, spread over the pooled denominator — which means it
  // grows exactly when the worst type holds as many pieces as the rest of the record put
  // together, and that is the shape this module is built to find. It is a tenth of a point
  // rather than a wrong answer, and a tenth of a point is enough to move a gap across a
  // threshold; a test pins it.
  const worstRaw = buckets.get(worst.type);
  const otherGraded = totalGraded - worstRaw.graded;
  const otherPassed = totalPassed - worstRaw.passed;
  const otherPct = totalPct - worstRaw.sum;

  // THE OTHER SIDE HAS ITS OWN FLOOR — trap one, and the half that gets forgotten. The
  // worst type's own rates are still reported, because they are measurements of something
  // that cleared its own floor; the GAPS, which are the numbers that read as a pattern and
  // the numbers the code is gated on, are withheld.
  if (otherGraded < cfg.typeMinOtherGrades) {
    return {
      ...base,
      worstType: worst.type,
      worstTypePassRate: worst.passRate,
      worstTypeMeanPct: worst.meanPct,
      passRateGap: null,
      meanGap: null,
    };
  }

  return {
    ...base,
    worstType: worst.type,
    worstTypePassRate: worst.passRate,
    worstTypeMeanPct: worst.meanPct,
    // Positive means the rest of the student's work is better than their worst type,
    // which is the direction the code reads. The pooled side is recomputed from the
    // running totals rather than averaged over the per-type means, because the types hold
    // different numbers of pieces and a mean of means would weight a two-piece portfolio
    // as heavily as a nine-piece assignment record.
    passRateGap: round1(((otherPassed / otherGraded) * 100) - worst.passRate),
    meanGap: round1((otherPct / otherGraded) - worst.meanPct),
  };
}

/* -------------------------------------------------------------------------- */
/* The evaluation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} raw
 *   grades             {Array<{pct, type}>} every marked piece in scope, any order, as
 *                      metrics.js already flattens them for tripwires.weightedGrade —
 *                      plus `type`, which the assessment select does not carry yet
 *   institution        {{assessmentTypesRecorded:boolean}} REQUIRED — throws without it
 *   weeksIntoProgramme {number|null} accepted and deliberately unused; see below
 * @param {object} [config] a settings config, spread over ASSESSMENT_TYPE_DEFAULTS. Must
 *        carry `passThreshold` for the pass/fail split to mean what the college means.
 */
function evaluate(raw, config) {
  const cfg = { ...ASSESSMENT_TYPE_DEFAULTS, ...(config || {}) };
  const input = raw || {};
  // Throws before anything else, so a caller who forgot the probe finds out on their first
  // fixture rather than after a term of blank columns.
  assertInstitutionProbe(input.institution, "evaluate");

  const codes = [];
  const shape = typeShape(input.grades || [], input.institution, cfg);

  /* --- a kind of work this student fails, while passing the rest ---------- */

  // THREE GATES, AND ALL THREE ARE LOAD-BEARING. Each is argued at length beside its
  // constant; in short:
  //
  //   worstTypePassRate <= ceiling  THE ABSOLUTE HALF. The student must actually FAIL this
  //                                 type. Without it the code fires on every student
  //                                 everywhere, because scoring less well at exams than at
  //                                 coursework is the ordinary shape of assessment design.
  //                                 CLAUDE.md: "Being below average is not a risk."
  //   passRateGap >= gap            THE RELATIVE HALF. They must pass the rest. Paired with
  //                                 the ceiling this forces the pooled rest above 74%,
  //                                 which is what structurally excludes a student — or a
  //                                 cohort — who is failing everything.
  //   meanGap >= meanGap            THE MARKS MUST SEPARATE THE TWO SIDES AS WELL AS THE
  //                                 THRESHOLD DOES. A uniformly borderline student sits at
  //                                 a hundred-point pass-rate gap on marks three points
  //                                 apart, and "your problem is exam technique" is worse
  //                                 than silence for them: specific, confident, wrong, and
  //                                 it costs them the general support they need.
  //
  // `isNum` ON EACH IS DEFENCE IN DEPTH, AND A MUTATION PASS PROVED IT IS EXACTLY THAT —
  // removing all three changes no behaviour and no test can catch it, so this is written
  // down rather than left to look load-bearing.
  //
  // A null gap means the comparison was REFUSED: one type, a thin pooled side, or a college
  // that does not record types at all. `null >= 40` is false and `null <= 34` is TRUE — the
  // second only fails to fire because the gap beside it is null in the same breath. So the
  // module is one edit away from a code that fires on a student with no measurable types
  // at all: give the thin-pooled-side branch a 0 instead of a null, or reorder the
  // conjunction, and `null <= 34` starts deciding things. The guards state the intent that
  // the arithmetic below only accidentally honours. Every guard in tripwires.js is written
  // this way for the same reason, and a test pins the null surface each branch returns.
  if (isNum(shape.worstTypePassRate)
      && isNum(shape.passRateGap)
      && isNum(shape.meanGap)
      && shape.worstTypePassRate <= cfg.typePassRateCeiling
      && shape.passRateGap >= cfg.typePassRateGap
      && shape.meanGap >= cfg.typeMeanGap) {
    codes.push(ASSESSMENT_TYPE.TYPE_FAILING);
  }

  /* --- the gap on its own raises NOTHING, on purpose ---------------------- */

  // Enforced structurally rather than remembered. `passRateGap` and `meanGap` are returned
  // as figures and neither can raise anything without the absolute ceiling beside it,
  // because within one student's grades there is nothing to separate "this student cannot
  // sit exams" from "this college's exams are harder than its coursework" — and the second
  // is true nearly everywhere. The half that would separate them is the rest of the
  // cohort's exam marks, which lives in cohort.js and is deliberately not an input here:
  // building a population from the chunk of 200 this module is handed is the bug
  // `cohortSize` is stored to make detectable.

  /* --- the settling-in exemption, and why it is deliberately NOT applied --- */

  // CLAUDE.md: "`weeksIntoProgramme` mutes the disengagement codes inside a settling-in
  // period... An *unknown* programme age is deliberately not exempt."
  //
  // THIS CODE IS NOT IN THAT CLASS, and the class is the reason rather than the habit. The
  // exemption covers codes that fire on the ABSENCE OF A RECORD, because in week one that
  // absence describes the calendar rather than the student. tripwires.evaluate applies it
  // to NO_PASTORAL_CONTACT and pointedly does NOT apply it to ABSENCE_STREAK, whose
  // argument transfers here word for word: this fires on the PRESENCE of at least three
  // marked failures in one type AND four more marked pieces elsewhere — seven pieces of
  // marked work, which cannot exist in a settling-in period at any real college. It is
  // structurally unable to fire on an intake, so muting it would be ceremony, and ceremony
  // is how a guard comes to be dropped from the one place it was load-bearing.
  //
  // `weeksIntoProgramme` is accepted in the input and read by nothing, ON PURPOSE, so the
  // decision is visible at the call site rather than looking like an oversight — and so
  // anybody who later decides this code DOES belong in the muted class has the field in
  // their hand and must confront the second half of the rule too: an unknown programme age
  // is NOT exempt, because muting every code for a student the calendar cannot place fails
  // safe in the wrong direction. Two tests pin both halves.

  return {
    // WHICH kind of work, and the reason the code itself does not name it: see the header.
    // It is also what makes the residual cohort case legible — forty rows saying "Exam" is
    // an exam board, not forty caseloads.
    worstAssessmentType: shape.worstType,
    worstAssessmentTypePassRate: shape.worstTypePassRate,
    worstAssessmentTypeMeanPct: shape.worstTypeMeanPct,
    // FIGURES ONLY. Never gated on alone — see above.
    assessmentTypePassRateGap: shape.passRateGap,
    assessmentTypeMeanGap: shape.meanGap,
    // How many types cleared the floor, so a reader can see the gap is a comparison over
    // three kinds of work rather than over two. NULL when the college records no types at
    // all; 0 when it does and none of this student's work cleared the floor. Those are the
    // two states a chunk cannot tell apart, made distinguishable on the row.
    assessmentTypesMeasured: shape.typesMeasured,
    assessmentTypesSeen: shape.typesSeen,
    // The corpus this could not see. `untypedGradeCount` with the probe TRUE says the
    // select or the data is incomplete; the same number with the probe FALSE says the
    // college does not use the field. Without it, both look like a working feature that
    // found nothing.
    untypedGradeCount: shape.untyped,
    codes,
  };
}

module.exports = {
  evaluate,
  typeShape,
  assertInstitutionProbe,
  ASSESSMENT_TYPE,
  ASSESSMENT_TYPE_CODES,
  ASSESSMENT_TYPE_DEFAULTS,
};
