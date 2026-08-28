// Tests for the workload layer: where a student's deadlines bunch, and whether they
// are carrying a backlog into the bunch.
//
// No database. workload.js is pure — it takes the in-memory arrays the gather has
// already built, plus today's date and an institution-wide probe result, and returns
// plain data.
//
// WEIGHTED TOWARDS NEGATIVE ASSERTIONS on purpose, in the house style: what does NOT
// fire, what comes back null rather than zero, and what is refused outright. The
// failure this module exists to prevent is a code that fires for a whole cohort at
// once, and a cohort-wide code looks exactly like a working one until somebody opens
// the caseload and finds a hundred identical rows on it.
//
// Run with: node --test src/prediction/workload.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluate, deadlineClusters, peakLoad, carriedBacklog,
  WORKLOAD, WORKLOAD_CODES, WORKLOAD_DEFAULTS,
} = require("./workload");
const { TRIP_CODES } = require("./tripwires");
const { COVERAGE_CODES } = require("./coverage");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A college whose feed populates AssessmentSubmission. */
const RECORDED = { submissionsRecorded: true };
/** A college where nothing writes it — CLAUDE.md's dead-end table. */
const UNRECORDED = { submissionsRecorded: false };

/** `due("2026-03-23")` reads better than an object literal. Weight unset by default,
 *  which is the ORDINARY state at a Moodle-synced college rather than an edge case. */
const due = (dueDate, weight = 0) => ({ dueDate, weight });

/** A piece of outstanding work. */
const piece = (assessmentId, dueDate) => ({ assessmentId, dueDate });

/** Three deadlines inside one week — the shared, cohort-wide half of every code. */
const PEAK_WEEK = [due("2026-03-23"), due("2026-03-25"), due("2026-03-27")];

/** One piece of work already past its deadline and unresolved. */
const ONE_OUTSTANDING = { missing: [piece("a1", "2026-03-10")], unresolved: [] };

/** The shape a caller hands evaluate(), with everything benign unless a test says so.
 *  Attendance is deliberately healthy by default so a test that means to exercise the
 *  backlog conjunction cannot accidentally fire the attendance one. */
const input = (over = {}) => ({
  today: "2026-03-20",
  assessments: [],
  backlog: { missing: [], unresolved: [] },
  recentAttendance: { pct: 95, marked: 20 },
  weeksIntoProgramme: 20,
  institution: RECORDED,
  ...over,
});

/* ========================================================================== */
/* The codes themselves                                                        */
/* ========================================================================== */

test("every code is namespaced TRIP_", () => {
  // Structural, and not decoration. These strings are appended to riskDriverCodes, the
  // same array engine.js fills from its six RED indicators. A code named RED_something
  // would read as the engine's own, and the next person to take redIndicatorCount off
  // the copy rather than off engine.js's internal `reds` array would silently wire the
  // assessment calendar into a student's band via OVR-004.
  for (const code of WORKLOAD_CODES) assert.ok(code.startsWith("TRIP_"), code);
});

test("no code collides with one tripwires.js or coverage.js already stores", () => {
  // Three files write into the same array and all three sets of strings outlive the
  // screen that renders them. A collision would make a stored history row mean two
  // things, and history rows are what an appeal is argued from.
  for (const code of WORKLOAD_CODES) {
    assert.equal(TRIP_CODES.includes(code), false, code);
    assert.equal(COVERAGE_CODES.includes(code), false, code);
  }
});

/* ========================================================================== */
/* TRAP ONE: a timetable fact must not become a per-student code               */
/* ========================================================================== */

test("a heavy deadline week ON ITS OWN raises NOTHING", () => {
  // THE CENTRAL TEST OF THIS FILE. Three deadlines in one week is a property of the
  // assessment calendar. Every student on the unit has it, so a code raised on it puts
  // the whole cohort on the caseload with an identical reason — which CLAUDE.md is
  // blunt is the same as no caseload. metrics.js already made this judgement about
  // assessmentsDueSoon; this keeps it structurally rather than by memory.
  const r = evaluate(input({ assessments: PEAK_WEEK }), {});

  assert.equal(r.peakCount, 3, "the peak is measured and reported");
  assert.deepEqual(r.codes, [], "and it raises nothing by itself");
});

test("an even heavier week on its own still raises nothing", () => {
  // No amount of shared timetable becomes a per-student finding. The threshold is not
  // what stops this — the conjunction is — so raising the calendar to six deadlines
  // must not tip anything over.
  const r = evaluate(input({
    assessments: [
      due("2026-03-23"), due("2026-03-23"), due("2026-03-24"),
      due("2026-03-25"), due("2026-03-26"), due("2026-03-27"),
    ],
  }), {});

  assert.equal(r.peakCount, 6);
  assert.deepEqual(r.codes, []);
});

test("a backlog ON ITS OWN raises nothing", () => {
  // The other half, alone. Outstanding work with a clear calendar ahead is already
  // reported by missingAssessmentCount and oldestUnmarkedDueDate, and this module is
  // not a third count of it.
  const r = evaluate(input({
    assessments: [due("2026-04-30")],   // dated, outside the horizon
    backlog: { missing: [piece("a1", "2026-03-01"), piece("a2", "2026-03-02")], unresolved: [] },
  }), {});

  assert.equal(r.carriedBacklogCount, 2);
  assert.deepEqual(r.codes, []);
});

test("weak recent attendance ON ITS OWN raises nothing", () => {
  // ATTENDANCE_FALLING and NOT_SEEN already exist next door. A second code saying "poor
  // attendance" in different words is noise on the same row.
  const r = evaluate(input({
    assessments: [due("2026-04-30")],
    recentAttendance: { pct: 20, marked: 30 },
  }), {});

  assert.deepEqual(r.codes, []);
});

test("the peak plus THIS student's backlog is the finding", () => {
  const r = evaluate(input({ assessments: PEAK_WEEK, backlog: ONE_OUTSTANDING }), {});

  assert.deepEqual(r.codes, [WORKLOAD.PILEUP]);
});

test("the peak plus THIS student's absence is a different finding", () => {
  // Deliberately with an empty backlog: a student who is up to date and has stopped
  // attending in the run-up is not behind YET, which is exactly why it is worth a
  // contact now rather than after the deadlines.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    recentAttendance: { pct: 40, marked: 20 },
  }), {});

  assert.deepEqual(r.codes, [WORKLOAD.ABSENT]);
});

test("both may fire together and neither is filtered out", () => {
  // Overlap is already how tripwires.js behaves — ABSENCE_STREAK and NOT_SEEN both fire
  // on one disappearance. Two findings about the same week are two things to say.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    backlog: ONE_OUTSTANDING,
    recentAttendance: { pct: 40, marked: 20 },
  }), {});

  assert.deepEqual(r.codes.sort(), [WORKLOAD.ABSENT, WORKLOAD.PILEUP].sort());
});

/* --- the thresholds either side of the conjunction -------------------------- */

test("a window one deadline short of the limit fires nothing, backlog or not", () => {
  const r = evaluate(input({
    assessments: [due("2026-03-23"), due("2026-03-25")],
    backlog: ONE_OUTSTANDING,
    recentAttendance: { pct: 20, marked: 30 },
  }), {});

  assert.equal(r.peakCount, 2);
  assert.deepEqual(r.codes, []);
});

test("a peak exactly AT the limit fires", () => {
  const r = evaluate(input({ assessments: PEAK_WEEK, backlog: ONE_OUTSTANDING }), {});
  assert.equal(r.peakCount, WORKLOAD_DEFAULTS.peakDeadlineLimit);
  assert.ok(r.codes.includes(WORKLOAD.PILEUP));
});

test("a backlog of zero does not fire the pile-up", () => {
  // And this is a MEASURED zero, not an absence of evidence: the college records
  // submissions and this student has nothing outstanding.
  const r = evaluate(input({ assessments: PEAK_WEEK }), {});
  assert.equal(r.carriedBacklogCount, 0);
  assert.equal(r.codes.includes(WORKLOAD.PILEUP), false);
});

test("attendance exactly at the floor fires; one point above it does not", () => {
  const at = evaluate(input({
    assessments: PEAK_WEEK,
    recentAttendance: { pct: WORKLOAD_DEFAULTS.peakAttendanceFloor, marked: 20 },
  }), {});
  const above = evaluate(input({
    assessments: PEAK_WEEK,
    recentAttendance: { pct: WORKLOAD_DEFAULTS.peakAttendanceFloor + 1, marked: 20 },
  }), {});

  assert.ok(at.codes.includes(WORKLOAD.ABSENT));
  assert.equal(above.codes.includes(WORKLOAD.ABSENT), false);
});

test("a thin recent window cannot raise the attendance conjunction", () => {
  // A window holding two registers reads 0 or 50 or 100 and none of them is
  // information. Without the floor, one absent mark is the loudest code on the screen.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    recentAttendance: { pct: 0, marked: WORKLOAD_DEFAULTS.recentMinMarks - 1 },
  }), {});

  assert.equal(r.codes.includes(WORKLOAD.ABSENT), false);
});

test("an unmeasurable recent window is not a bad one", () => {
  // Null pct means nobody took a register in the window. Reading it as 0 would raise
  // this on every student whose tutor did not open the register in the run-up to the
  // deadlines — a staff finding wearing a student's name, which is coverage.js's whole
  // subject and must not leak into this file.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    recentAttendance: { pct: null, marked: 0 },
  }), {});

  assert.equal(r.codes.includes(WORKLOAD.ABSENT), false);
});

/* ========================================================================== */
/* TRAP TWO: null means not measurable, zero means zero                        */
/* ========================================================================== */

test("a student with no dated assessments has an UNKNOWN workload, not a clear one", () => {
  // The heart of trap two. Three assessments nobody dated is not a clear month ahead;
  // it is a month nobody can see. A stored 0 would read as "we looked and there is
  // nothing coming", which is the inversion this codebase is organised to avoid.
  const r = evaluate(input({ assessments: [due(null), due(null), due(null)] }), {});

  assert.equal(r.peakCount, null);
  assert.equal(r.peakFrom, null);
  assert.equal(r.undatedAssessments, 3);
  assert.deepEqual(r.codes, []);
});

test("no assessments at all is also unknown, not zero", () => {
  const r = evaluate(input({ assessments: [] }), {});
  assert.equal(r.peakCount, null);
});

test("dated assessments with an empty horizon IS a measured zero", () => {
  // The other side of the same rule, and the reason `null` and `[]` are different
  // return values rather than one falsy shrug. This college dates its work, nothing of
  // this student's is undated, and there is genuinely nothing in the next four weeks.
  const r = evaluate(input({ assessments: [due("2026-06-01"), due("2026-01-05")] }), {});

  assert.equal(r.peakCount, 0);
  assert.equal(r.undatedAssessments, 0);
});

test("one undated assessment turns an empty horizon back into unknown", () => {
  // Partial blindness plus nothing found is not a finding of nothing. "No deadlines
  // ahead" printed beside "one assessment we could not date" is a reassurance the data
  // cannot support.
  const r = evaluate(input({ assessments: [due("2026-06-01"), due(null)] }), {});

  assert.equal(r.peakCount, null);
  assert.equal(r.undatedAssessments, 1);
});

test("an undated assessment never joins a window, and is reported as a lower bound", () => {
  // It leaves BOTH sides — the same rule metrics.js applies to the same rows in the
  // other direction ("No due date means nothing can be overdue against it"). Counting
  // it into the peak would manufacture a pile-up out of a blank column.
  const r = evaluate(input({
    assessments: [due("2026-03-23"), due("2026-03-25"), due(null), due(null)],
    backlog: ONE_OUTSTANDING,
  }), {});

  assert.equal(r.peakCount, 2, "two placeable deadlines, not four");
  assert.equal(r.undatedAssessments, 2, "and the reader can see the peak is a floor");
  assert.deepEqual(r.codes, [], "undercounting produces silence, never a false alarm");
});

test("a backlog at a college that does not record submissions is NULL, not zero", () => {
  // AssessmentSubmission is written by nothing. At such a college every student's
  // backlog is empty and every past-due piece looks unanswered, and both readings
  // describe the integration. A zero here would fire, or silence, the conjunction for
  // the entire institution at once.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    backlog: { missing: [piece("a1", "2026-03-01")], unresolved: [] },
    institution: UNRECORDED,
  }), {});

  assert.equal(r.carriedBacklogCount, null);
  assert.equal(r.codes.includes(WORKLOAD.PILEUP), false);
});

test("an unmeasurable backlog still leaves the attendance conjunction working", () => {
  // The two halves fail independently. A college with no submission feed can still see
  // its register, and silencing both codes on one missing integration would be the
  // quiet total failure this module's probe exists to make loud.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    institution: UNRECORDED,
    recentAttendance: { pct: 30, marked: 20 },
  }), {});

  assert.deepEqual(r.codes, [WORKLOAD.ABSENT]);
});

/* ========================================================================== */
/* TRAP THREE: weight is usually unset and must not be pretended otherwise     */
/* ========================================================================== */

test("with every weight unset the share is NULL and the flag says so", () => {
  // Assessment.weight defaults to 0 and the Moodle importer never sets it, so this is
  // the ordinary state at a synced college. A share of 0 beside three deadlines would
  // read as "none of this counts for anything".
  const r = evaluate(input({ assessments: PEAK_WEEK }), {});

  assert.equal(r.peakWeightShare, null);
  assert.equal(r.peakWasWeighted, false, "gradeWasWeighted's contract: WHICH figure this is");
  assert.equal(r.peakCount, 3, "and the count is unaffected — it is what the ranking uses");
});

test("the heaviest window is chosen by COUNT, never by weight", () => {
  // THE TRAP, and it is the mirror of weightedGrade's. A mean may exclude an unweighted
  // mark because the piece leaves both sides. A peak load is a count of things that
  // must be DONE, and an excluded deadline leaves only one side — the work still has to
  // be done. Ranked by weight, four unweighted assignments score 0 and lose to a single
  // 60% quiz, and the heavy week disappears precisely because nobody typed the weights
  // in.
  const r = peakLoad([
    due("2026-03-23"), due("2026-03-24"), due("2026-03-25"), due("2026-03-26"),
    due("2026-04-10", 60),
  ], "2026-03-20", {});

  assert.equal(r.peakFrom, "2026-03-23");
  assert.equal(r.peakCount, 4);
  assert.equal(r.peakWasWeighted, false);
  assert.equal(r.peakWeightShare, null);
});

test("a partly weighted window reports the share it could compute and how much it could not", () => {
  // An assessment with no weight is not worth nothing — it is worth an unknown amount.
  // Averaging it in at zero would silently discard a real deadline, so it is excluded
  // from the SHARE and counted, exactly as weightedGrade() counts its `ignored`.
  const r = peakLoad([due("2026-03-23", 50), due("2026-03-24"), due("2026-03-25")], "2026-03-20", {});

  assert.equal(r.peakCount, 3);
  assert.equal(r.peakWeightShare, 50);
  assert.equal(r.peakWasWeighted, true);
  assert.equal(r.weightsUnset, 2);
});

test("a fully weighted window sums its weights", () => {
  const r = peakLoad([due("2026-03-23", 20), due("2026-03-24", 30), due("2026-03-25", 10)], "2026-03-20", {});

  assert.equal(r.peakWeightShare, 60);
  assert.equal(r.peakWasWeighted, true);
  assert.equal(r.weightsUnset, 0);
});

test("a negative or non-numeric weight is treated as unset, not subtracted", () => {
  // Weight is validated on the way in, so this is defensive — but a negative weight
  // reaching a sum would reduce the reported share below the work actually in the week.
  const r = peakLoad([due("2026-03-23", -40), due("2026-03-24", null), due("2026-03-25")], "2026-03-20", {});

  assert.equal(r.peakWeightShare, null);
  assert.equal(r.peakWasWeighted, false);
  assert.equal(r.weightsUnset, 3);
});

/* ========================================================================== */
/* TRAP FOUR: dates are strings, today is an argument, no day counts stored     */
/* ========================================================================== */

test("the peak is reported as a pair of DATES and never as a day count", () => {
  // Nothing in this feature runs on a schedule — markStale() fires on data events, and
  // a day passing is not an event. "Peak in 3 days" written to a column is wrong by the
  // next morning with nothing to correct it; the date is true forever, and the screen
  // subtracts.
  const r = evaluate(input({ assessments: PEAK_WEEK }), {});

  assert.equal(r.peakFrom, "2026-03-23");
  assert.equal(r.peakTo, "2026-03-29");
  for (const key of Object.keys(r)) {
    assert.equal(/days|until|weeks/i.test(key), false, `${key} looks like a stored day count`);
  }
});

test("today is an ARGUMENT — the same assessments give a different answer on a later date", () => {
  // There is no clock in this file. src/clock.js pins APP_TIMEZONE precisely because
  // the host clock is not the college's day, and a module calling new Date() would give
  // a different answer depending on which machine ran the batch.
  const before = evaluate(input({ assessments: PEAK_WEEK, today: "2026-03-20" }), {});
  const after = evaluate(input({ assessments: PEAK_WEEK, today: "2026-03-28" }), {});

  assert.equal(before.peakCount, 3);
  assert.equal(after.peakCount, 0, "the week has passed — the calendar ahead is now clear");
});

test("an unparseable today refuses to answer rather than reporting a clear calendar", () => {
  // Deriving a horizon from NaN makes every comparison false, which would report an
  // empty month for every student in the batch — manufactured reassurance produced by a
  // malformed string rather than by evidence.
  const r = evaluate(input({ assessments: PEAK_WEEK, backlog: ONE_OUTSTANDING, today: "20/03/2026" }), {});

  assert.equal(r.peakCount, null);
  assert.equal(r.carriedBacklogCount, null);
  assert.deepEqual(r.codes, []);
});

test("the window is seven days INCLUSIVE at both ends", () => {
  // from + 6, not from + 7. An eight-day window quietly inflates every count by
  // whatever falls on the extra day, and the inflation is invisible on the row.
  const sixApart = peakLoad([due("2026-03-23"), due("2026-03-29")], "2026-03-20", {});
  const sevenApart = peakLoad([due("2026-03-23"), due("2026-03-30")], "2026-03-20", {});

  assert.equal(sixApart.peakCount, 2, "23rd to 29th is one week");
  assert.equal(sevenApart.peakCount, 1, "the 30th is the next one");
});

test("the horizon is inclusive at its far end and excludes the day after", () => {
  const on = peakLoad([due("2026-03-21"), due("2026-04-17")], "2026-03-20", {});
  const off = peakLoad([due("2026-03-21"), due("2026-04-18")], "2026-03-20", {});

  assert.equal(on.ahead, 2);
  assert.equal(off.ahead, 1);
});

test("work due TODAY is ahead of the student, not behind them", () => {
  const r = peakLoad([due("2026-03-20"), due("2026-03-21"), due("2026-03-22")], "2026-03-20", {});

  assert.equal(r.peakCount, 3);
  assert.equal(r.peakFrom, "2026-03-20");
});

test("a deadline already passed never joins the peak", () => {
  // Otherwise the backlog is folded into the very peak it is meant to be compared
  // against, and one number is counted on both sides of the conjunction.
  const r = peakLoad([due("2026-03-18"), due("2026-03-19"), due("2026-03-23")], "2026-03-20", {});

  assert.equal(r.peakCount, 1);
  assert.equal(r.peakFrom, "2026-03-23");
});

test("two equally heavy windows resolve to the EARLIER one", () => {
  // The actionable one, and a deterministic one. A peak that moved between runs with
  // nothing about the student having changed would make the row untrustworthy — the
  // reason metrics.js sorts grades with an assessment-id tie-break.
  const r = peakLoad([
    due("2026-03-23"), due("2026-03-24"),
    due("2026-04-10"), due("2026-04-11"),
  ], "2026-03-20", {});

  assert.equal(r.peakCount, 2);
  assert.equal(r.peakFrom, "2026-03-23");
});

/* ========================================================================== */
/* TRAP FIVE: the settling-in period, both halves                              */
/* ========================================================================== */

test("a first-year drowning in week 3 is a finding, not noise", () => {
  // NOT muted, and the choice is argued rather than copied. The exemption covers codes
  // firing on the ABSENCE of a record — no pastoral contact, no attendance history —
  // because in week one that absence describes the calendar. Both codes here fire on
  // the PRESENCE of evidence: a published deadline calendar, positively recorded
  // outstanding work, a register that exists and says the student was not there. That
  // is the ABSENCE_STREAK and FOLLOWUP_MISSED family, which tripwires.js pointedly does
  // not mute. Induction is also exactly when badly-planned diagnostic clusters land.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    backlog: ONE_OUTSTANDING,
    weeksIntoProgramme: 1,
  }), {});

  assert.deepEqual(r.codes, [WORKLOAD.PILEUP]);
});

test("an UNKNOWN programme age fires identically to a known one", () => {
  // The second half of the rule, and the half that is got wrong: muting every code for
  // a student the calendar cannot place fails safe in the wrong direction — silence
  // about exactly the students the timetable already cannot account for. Here the
  // module is age-blind in BOTH directions, so a later reader who decides one of these
  // codes does belong in the muted class has to confront both halves.
  const known = evaluate(input({
    assessments: PEAK_WEEK, backlog: ONE_OUTSTANDING, weeksIntoProgramme: 30,
  }), {});
  const unknown = evaluate(input({
    assessments: PEAK_WEEK, backlog: ONE_OUTSTANDING, weeksIntoProgramme: null,
  }), {});

  assert.deepEqual(unknown.codes, known.codes);
  assert.deepEqual(unknown.codes, [WORKLOAD.PILEUP]);
});

/* ========================================================================== */
/* TRAP SIX: the conjunction, not a second count of what already exists        */
/* ========================================================================== */

test("the result does not re-report a second oldest-outstanding date", () => {
  // oldestUnmarkedDueDate already stores it. A second column with a slightly different
  // definition is exactly how two figures that must agree start disagreeing, and the
  // disagreement surfaces at an appeal rather than in a test.
  const r = evaluate(input({ assessments: PEAK_WEEK, backlog: ONE_OUTSTANDING }), {});

  for (const key of Object.keys(r)) {
    assert.equal(/oldest|unmarked|dueSoon/i.test(key), false, `${key} duplicates a stored figure`);
  }
});

test("the carried count is the UNION of the two sets, not either one of them", () => {
  // Returned so that "already behind" is auditable on the day it fired, and deliberately
  // a union so it cannot be mistaken for missingAssessmentCount, which is only one half.
  const r = evaluate(input({
    assessments: PEAK_WEEK,
    backlog: {
      missing: [piece("a1", "2026-03-01")],
      unresolved: [piece("a2", "2026-03-02"), piece("a3", "2026-03-03")],
    },
  }), {});

  assert.equal(r.carriedBacklogCount, 3);
});

/* ========================================================================== */
/* The institution probe                                                       */
/* ========================================================================== */

test("evaluate REFUSES to run without an institution-wide probe result", () => {
  // CLAUDE.md records this as the most repeated bug in this area, got wrong three
  // times, and coverage.js already answers it the same way. The tripwires guards
  // default to falsy and fall silent, which is right there — one code does not fire.
  // Here a missing flag would null the pile-up conjunction permanently and silently:
  // no test would fail, no row would look wrong, and the column would be blank for
  // every student at every college for as long as anybody left it alone.
  assert.throws(() => evaluate(input({ institution: undefined }), {}), TypeError);
  assert.throws(() => evaluate(input({ institution: {} }), {}), TypeError);
});

test("a truthy non-boolean probe is refused, not coerced", () => {
  // "yes" is what a config file or a JSON column hands over, and it is truthy. Coercing
  // it would turn a college that never answered the question into one that answered
  // yes, which is the loud direction of the failure.
  assert.throws(() => evaluate(input({ institution: { submissionsRecorded: "yes" } }), {}), TypeError);
  assert.throws(() => carriedBacklog({}, "2026-03-20", { submissionsRecorded: 1 }), TypeError);
});

test("carriedBacklog refuses on its own, not only through evaluate", () => {
  // The guard belongs on the function that reads the rows. A caller reaching past
  // evaluate() must hit the same wall.
  assert.throws(() => carriedBacklog(ONE_OUTSTANDING, "2026-03-20", null), TypeError);
});

/* ========================================================================== */
/* carriedBacklog                                                              */
/* ========================================================================== */

test("only work whose deadline has PASSED is outstanding", () => {
  // Work due next week is not a backlog, it is the peak, and it is already counted on
  // the other side of the conjunction. metrics.js applies the identical rule before
  // counting anything as missing: an assessment due next month must never count against
  // a student.
  const r = carriedBacklog({
    missing: [piece("a1", "2026-03-25"), piece("a2", "2026-03-20")],
    unresolved: [piece("a3", "2026-04-01")],
  }, "2026-03-20", RECORDED);

  assert.equal(r.carried, 0, "nothing here is behind them");
});

test("work with no deadline is neither outstanding nor evidence that nothing is", () => {
  const r = carriedBacklog({
    missing: [piece("a1", null), piece("a2", "2026-03-01")],
    unresolved: [piece("a3", undefined)],
  }, "2026-03-20", RECORDED);

  assert.equal(r.carried, 1);
  assert.equal(r.oldestOutstandingOn, "2026-03-01");
});

test("an assessment appearing in BOTH lists is counted once", () => {
  // metrics.js builds the two sets disjointly, so an overlap is a caller fault — and
  // one assessment counted twice would cross the threshold on its own.
  const r = carriedBacklog({
    missing: [piece("a1", "2026-03-01")],
    unresolved: [piece("a1", "2026-03-01")],
  }, "2026-03-20", RECORDED);

  assert.equal(r.carried, 1);
  assert.equal(r.missing, 1);
  assert.equal(r.unresolved, 0, "the stronger reading survives the dedupe");
});

test("rows with no assessment id are counted as they arrive", () => {
  // Stated rather than silently assumed: without an id there is nothing to dedupe on.
  const r = carriedBacklog({
    missing: [{ dueDate: "2026-03-01" }, { dueDate: "2026-03-02" }],
    unresolved: [],
  }, "2026-03-20", RECORDED);

  assert.equal(r.carried, 2);
});

test("a college that records submissions and a student with nothing behind them reads ZERO", () => {
  // A real zero, and the only reading under which the conjunction can be trusted to
  // stay silent for the right reason.
  const r = carriedBacklog({ missing: [], unresolved: [] }, "2026-03-20", RECORDED);

  assert.equal(r.carried, 0);
  assert.equal(r.missing, 0);
  assert.equal(r.unresolved, 0);
  assert.equal(r.oldestOutstandingOn, null);
});

test("a college that does not record submissions reads NULL on every figure", () => {
  const r = carriedBacklog(ONE_OUTSTANDING, "2026-03-20", UNRECORDED);

  assert.equal(r.carried, null);
  assert.equal(r.missing, null);
  assert.equal(r.unresolved, null);
  assert.equal(r.oldestOutstandingOn, null);
});

/* ========================================================================== */
/* deadlineClusters — the shape, not just the maximum                           */
/* ========================================================================== */

test("windows are anchored on due dates and returned earliest first", () => {
  // A window anchored on a due date is at least as full as any window that is not, so
  // the anchors enumerate every achievable count — and `from` is a date something is
  // actually due rather than an arbitrary Tuesday nothing happens on.
  const r = deadlineClusters([due("2026-03-25"), due("2026-03-23"), due("2026-04-06")], "2026-03-20", {});

  assert.deepEqual(r.windows.map((w) => w.from), ["2026-03-23", "2026-03-25", "2026-04-06"]);
  assert.deepEqual(r.windows.map((w) => w.count), [2, 1, 1]);
});

test("a cluster in the MIDDLE of the horizon is found, not just a near one", () => {
  // The reason the horizon is 28 days rather than dueSoonDays' 14: a cluster three
  // weeks out is the one there is still time to do something about, and a fourteen-day
  // horizon can only ever see the near half of it.
  const r = peakLoad([
    due("2026-03-21"),
    due("2026-04-13"), due("2026-04-14"), due("2026-04-15"),
  ], "2026-03-20", {});

  assert.equal(r.peakCount, 3);
  assert.equal(r.peakFrom, "2026-04-13");
});

test("two deadlines on the same day are two deadlines", () => {
  // Distinct anchors are deduped; the assessments behind them are not. A student with
  // two things due on one Friday has two things to hand in.
  const r = deadlineClusters([due("2026-03-23"), due("2026-03-23"), due("2026-03-24")], "2026-03-20", {});

  assert.equal(r.windows.length, 2, "two distinct anchor dates");
  assert.equal(r.windows[0].count, 3, "three pieces of work");
});

test("a config spread over the defaults changes the window and the horizon", () => {
  // The settings.js shape: platform defaults in code, a college's own values merged
  // over them. A college on fortnightly deadlines is entitled to say so.
  const wide = peakLoad([due("2026-03-23"), due("2026-04-01")], "2026-03-20", { clusterWindowDays: 14 });
  const narrow = peakLoad([due("2026-03-23"), due("2026-04-01")], "2026-03-20", {});
  const short = peakLoad([due("2026-04-10")], "2026-03-20", { horizonDays: 7 });

  assert.equal(wide.peakCount, 2);
  assert.equal(narrow.peakCount, 1);
  assert.equal(short.peakCount, 0, "outside a shortened horizon, and measurably clear");
});

test("a null or missing assessment list does not throw and does not invent a peak", () => {
  const r = peakLoad(null, "2026-03-20", {});
  assert.equal(r.peakCount, null);
  assert.equal(r.undated, 0);
});
