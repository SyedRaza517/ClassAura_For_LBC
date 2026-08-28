// How ONE college weights, bands and scopes the progression score.
//
// WHY THIS IS PER TENANT
//
// The spec's numbers — attendance at 20%, average grade at 25%, R3 starting at 55,
// a pass threshold of 40 — are one institution's academic policy written down. A
// college running a Student-visa cohort weights attendance far above a part-time
// evening provider; a college whose pass mark is 50 would have OVR-003 fire for
// nobody at 40. Scoring students against another institution's policy is not a
// cosmetic mismatch: this score decides who gets flagged for intervention, who gets
// a review date, and who gets escalated.
//
// So the configuration is DATA, in exactly the shape attendanceBandConfig.js
// established: platform defaults in code, ONE JSON column per tenant merged OVER
// them, no row until a college edits something, an allowlist on the way out, and a
// short cache invalidated on save. Read that file alongside this one.
//
// WHY VALIDATION IS THE POINT OF THIS FILE
//
// Every other rule here is recoverable; a bad configuration is not, because it
// fails SILENTLY and it fails for a whole cohort at once.
//
//   - Weights totalling 0.9 do not produce an error anywhere. They produce a
//     weighted sum that is 10% too low for every student in the college, which
//     walks the entire cohort one band down the ladder. Staff would see a sudden
//     surge of "High Risk" students, believe it, and act on it.
//   - A gap in the bands means a student whose score lands in the hole is
//     classified against nothing — no band, no action, no flag. Silently skipped,
//     and worst at the bottom end where it matters most.
//   - An overlap means which band a student lands in depends on the order of an
//     array, so a student can change risk level because an administrator dragged a
//     row.
//   - An unknown key stored verbatim is a setting somebody believes they have
//     changed and which nothing reads. "I set the pass threshold to 50" and the
//     engine still using 40 is worse than a rejected save.
//
// So validate() refuses all four, and get() re-runs it on the way OUT as well —
// a row can predate a rule or be edited by hand in a console.
const prisma = require("../db");
const { currentTenantId } = require("../db");

/* -------------------------------------------------------------------------- */
/* 1) The platform defaults.                                                  */
/* -------------------------------------------------------------------------- */

// The seven components and their weights, from the spec. They MUST total 1 — see
// validate(). Percentages are expressed as fractions rather than 20/15/25 so that
// "sums to 1" is a single unambiguous check and the engine can multiply directly.
const DEFAULT_WEIGHTS = {
  overallAttendance: 0.2,
  recentAttendance: 0.15,
  submissionRate: 0.15,
  onTimeRate: 0.1,
  averageGrade: 0.25,
  gradeTrend: 0.1,
  interventionResponse: 0.05,
};

// R1..R5, best -> worst. `key` is stable and is what StudentPredictionCurrent.riskLevel
// stores, so it must survive a college renaming a band: rename "Moderate Risk" to
// "Amber" and every history row still means what it meant.
//
// `max` is DISPLAY ONLY. The boundary that decides is the next band's `min` — see
// bandForScore, which matches on the lower bound walking best -> worst, the same fix
// attendanceBands.bandForPct carries and for the same reason: progression scores
// carry one decimal, so an inclusive `>= min && <= max` test drops a student on 84.95
// out of both R2 and R1 and hands back null.
const DEFAULT_BANDS = [
  { key: "R1", label: "Very High Progression Confidence", min: 85, max: 100 },
  { key: "R2", label: "Likely to Progress", min: 70, max: 84.99 },
  { key: "R3", label: "Moderate Risk", min: 55, max: 69.99 },
  { key: "R4", label: "High Risk", min: 40, max: 54.99 },
  { key: "R5", label: "Critical Risk", min: 0, max: 39.99 },
];

const DEFAULTS = {
  weights: DEFAULT_WEIGHTS,
  bands: DEFAULT_BANDS,

  // Rolling window for the "recent attendance" component, in days.
  recentAttendanceDays: 28,

  // Grade trend: mean of the latest N valid grades minus the mean of the previous N.
  // N assessments each side, so 2 needs four graded pieces before a trend exists at
  // all; fewer is INSUFFICIENT_DATA and scores neutral, never badly.
  gradeTrendAssessmentCount: 2,
  // Percentage points of movement that count as improving / declining. Inside
  // +/- this, the trend is Stable.
  gradeTrendThreshold: 5,

  // The mark a piece of work has to reach to pass, 0-100. Drives OVR-003 and the
  // LOW_AVERAGE_GRADE red indicator, so a college with a 50 pass mark must change
  // it or those two rules fire for nobody it would want them to.
  passThreshold: 40,

  // "points"  — the P=2 / L=1 / E=1 / A=0 model in attendance.js, which is what the
  //             Attendance % tab already shows. The engine must produce the same
  //             number the tab does or staff will not trust either.
  // "binary"  — present or not; late and excused count as absent.
  attendanceMode: "points",

  // Which assessments and sessions count. "current-term" is the default and the one
  // the spec argues for: a strong Year 1 must not mask a collapse happening now.
  // Grade TREND deliberately ignores this and crosses term boundaries — see the
  // engine, not here.
  scope: "current-term",

  // OVR-001: this many missing assessments and the student cannot be better than R3.
  missingOverrideCount: 2,
  // OVR-002: recent attendance below this and the student cannot be better than R4.
  criticalRecentAttendance: 50,
  // OVR-004: this many red indicators worsens the band by one level, clamped at R5.
  // There are exactly six reds, so a threshold above six can never fire.
  redIndicatorThreshold: 3,

  // WHICH BAND EACH OVERRIDE CAPS AT.
  //
  // Named by band KEY rather than by position, because the ladder is configurable.
  // "cannot be better than R3" is only meaningful while R3 exists: a college that
  // replaced the five default bands with four of its own has no R3, and a rule
  // expressed as "the third band from the top" would quietly mean something
  // different at every institution that touched its ladder.
  //
  // validate() therefore checks each of these names a band that actually exists, and
  // refuses the save otherwise — a college cannot end up with a dead override it
  // believes is protecting students.
  missingOverrideBand: "R3",     // OVR-001
  criticalAttendanceBand: "R4",  // OVR-002
  lowGradeBand: "R3",            // OVR-003

  // At or below this band, the student is flagged as needing an intervention. It is
  // separate from the bands themselves because "how worried are we" and "does
  // somebody have to do something this week" are different questions, and a college
  // may want the second to start one rung later than the first.
  interventionBand: "R3",

  // The two red indicators that have no threshold of their own elsewhere. The other
  // four reuse thresholds already configured above (criticalRecentAttendance,
  // missingOverrideCount, passThreshold) or need none (a declining grade trend), so
  // moving one of those moves the matching red with it rather than leaving the two
  // to drift apart.
  redAttendanceThreshold: 70,
  redSubmissionThreshold: 70,

  // Direction of travel: this score against the nearest stored score this many days
  // back, and how many points of movement count as a direction rather than noise.
  // Scores move a little every time a register is taken; reporting that as "getting
  // worse" on a student's record would cry wolf.
  directionOfTravelDays: 28,
  directionOfTravelThreshold: 2,

  // How long an intervention must have been running before its effect is judged.
  // Below this the response is TOO_EARLY, which scores neither well nor badly: a
  // student cannot fairly be marked down for not having recovered in three days.
  interventionReviewDays: 14,

  // --- Tripwires -------------------------------------------------------------
  //
  // These govern the conditions that ride ALONGSIDE the score rather than inside it
  // (see tripwires.js). None of them can move a progression score or a band; they
  // decide when a fact about a student is worth putting in front of a human.
  //
  // Every one is a college's judgement rather than a property of the code, for the
  // same reason the weights are: a provider running a Student-visa cohort loses
  // contact with somebody after three sessions, while an evening course that meets
  // fortnightly would fire this on everybody.

  // A run of unexplained absences, in sessions. Only A counts — an excused absence
  // breaks the run, because the student told somebody and has not been lost.
  absenceStreakSessions: 3,

  // Days since the student was last marked present or late. Deliberately not "days
  // since a register was taken": the question is when this person was last in a room.
  notSeenDays: 14,

  // How long after a deadline work may sit with no submission record before it is
  // reported. Marking takes time, and a flag that lights the morning after every
  // deadline is one staff learn to scroll past.
  unmarkedGraceDays: 7,

  // A fall in attendance between the rolling window and the one before it, in
  // percentage points, that counts as deterioration rather than ordinary movement.
  attendanceSlopeDrop: 10,

  // The fewest marked sessions a window needs before a percentage drawn from it is
  // allowed to contribute to a slope. A window holding one register reads 0 or 100
  // and neither is information — without this floor a two-mark student produces the
  // loudest number on the screen.
  slopeMinMarks: 3,

  // How far above the pass mark still counts as a near miss. A student sitting two
  // points clear of failing is not comfortable, and an average grade cannot say so —
  // it reports the same 45 for somebody scraping through every unit and somebody
  // alternating firsts with failures.
  nearFailMargin: 10,

  // How many missed arranged meetings count as a pattern rather than a bad week.
  noShowLimit: 2,

  // How long a student may go without any logged conversation before that becomes
  // worth reporting. This one describes the COLLEGE, not the student.
  staleContactDays: 42,

  // The fewest marked sessions a UNIT needs before its percentage may be compared
  // against another unit's. A unit holding one register reads 0% or 100%, and left in
  // the comparison it is always the worst unit — the signal would be pointing at the
  // register rather than at the student.
  disperseMinMarks: 4,

  // How far apart the best and worst unit may be, in percentage points, before that
  // gap is worth reporting on its own. A student at 90% in three units and 20% in a
  // fourth has an overall figure that looks survivable and a problem that is not.
  unitSpreadLimit: 40,

  // What share of marked work arriving after its deadline counts as a pattern rather
  // than a bad month.
  lateSubmissionLimit: 40,

  // How long a student is treated as new. Inside this, the "we have not seen this"
  // codes are suppressed — in week one nobody has attendance history, marks or a
  // pastoral record, and firing on all of that would put the entire intake on the
  // caseload at once.
  settlingInWeeks: 3,

  // How far ahead to look for work falling due. A fact about the timetable rather than
  // the student, reported as a figure and never as a code.
  dueSoonDays: 14,

  // The fewest marked, dated pieces of work before a late-submission percentage may
  // raise a code. One piece handed in a day late reads 100%, and the screen calls that
  // a pattern. Every other rate here carries the same kind of floor.
  lateSubmissionMinPieces: 3,

  // How far back a repeated concern is looked for. Unbounded, a concern raised twice in
  // a student's first term would stay on their record for the rest of the programme,
  // and no number of clean reviews since could clear it.
  concernWindowDays: 180,

  // How far back a missed meeting counts. Unbounded, a student who missed two
  // arranged meetings in their first term would sit on the caseload for the rest of
  // the programme however faithfully they attended afterwards — the same failure the
  // repeated-concern window above exists to prevent, in the signal beside it.
  noShowWindowDays: 180,

  // How long a question a student asked may sit unanswered before that is worth
  // reporting. This one describes the COLLEGE, and is set shorter than
  // staleContactDays because a query is a person who has already put their hand up.
  unansweredQueryDays: 5,

  // How long a student the model has placed in trouble may go without a logged
  // conversation. Deliberately much shorter than staleContactDays: that asks the
  // question of everybody at a leisurely pace, this asks it of the students the
  // college's own engine has just flagged. Both describe the COLLEGE.
  contactDeficitDays: 14,

  // The band at which that shorter clock starts. A band KEY, validated against the
  // ladder this same save is storing — a college that deletes R3 must not be left with
  // a rule pointing at it.
  contactDeficitBand: "R3",

  // The fewest absences before the unexplained share is a percentage worth showing.
  // One unexcused absence reads 100%, which is a pattern claimed from one data point.
  minAbsencesForShare: 3,

  // How long after its promised date a follow-up stops being "arranged for this week"
  // and starts being one nobody kept. Without a grace period this fires the morning
  // after every date in the diary, cohort-wide in any week a tutor arranged a batch --
  // and a column that is always lit is a column staff stop reading.
  followUpGraceDays: 7,

  // How far back a missed follow-up counts. Unbounded, a promise made eighteen months
  // ago and never held would sit on the row for the rest of the programme — the same
  // accumulating pile this signal replaced.
  followUpWindowDays: 180,

  // How long a question may sit unanswered before it stops being reported. The code
  // exists to prompt a reply; past this point nobody is going to answer it, and a
  // permanently-lit row is one staff scroll past.
  unansweredQueryCeilingDays: 180,

  // The fewest teaching days carrying MORE THAN ONE session before the first-session
  // absence pattern is reported. A single-register day has no later session to compare
  // against, so at a college timetabling one session a day this figure stays null
  // rather than reporting every absent student as unable to get out of bed.
  firstSessionMinDays: 3,

  // The longest window one mitigating-circumstances claim may cover, in days. An
  // unbounded window is a permanent suppression, and a permanent suppression is
  // indistinguishable from the student having been taken off the risk register
  // altogether. A college needing longer -- a year out for treatment -- should record
  // that as an interruption on StudentOutcome, which is what that table is for, rather
  // than as a claim that silently mutes every signal for twelve months.
  mitigationWindowMaxDays: 120,

  // Whether an UNDECIDED claim suppresses. Default true, and the reasoning is set out at
  // length in prediction/adjustments.js: with a claim pending, "did this student fail to
  // hand work in" is not a question about the student, because the answer depends on a
  // decision the institution has not taken.
  //
  // It is a SETTING rather than a constant because it is a policy judgement wearing code.
  // If a college's academic regulations say a pending claim has no effect until
  // determined, that college is entitled to say so, and the alternative -- hardcoding one
  // reading of somebody else's regulations -- is the worse failure.
  pendingClaimSuppresses: true,

  // How long a claim may sit undecided before it is reported. A STAFF signal: the delay
  // belongs to the institution and the student underneath it is the one harmed by it.
  mitigationUndecidedDays: 14,

  /* --- cohort standing ---------------------------------------------------- */

  // How many measurable peers before a cohort may describe anybody. Below ten, "in the
  // bottom 10%" and "is the worst student in the room" are the same statement, and
  // exactly one student per group is the worst BY DEFINITION — a quota, not a finding.
  cohortMinSize: 12,
  // The tail that counts as outlying. Half of every cohort is below the median by
  // definition, and the bottom quartile of a 900-student college is 225 people: a
  // caseload nobody can work. The bottom decile of a 20-strong group is two students.
  cohortOutlierPercentile: 10,
  // AND an absolute gap, because a rank alone is not a finding. The bottom decile of a
  // cohort sitting between 88% and 92% is three points off the mean, which is nothing.
  cohortOutlierGap: 10,
  // Below this spread the ordering inside a cohort is decided by rounding and reshuffles
  // on every run. A near-uniform cohort is more dangerous than a flat one, because it
  // still looks like a ranking.
  cohortMinSpread: 2,

  /* --- register coverage -------------------------------------------------- */

  // The fewest marks before an attendance percentage may be PRINTED AT ALL. At five, one
  // observation is worth twenty points and the band ladder is fifteen wide, so a single
  // register moves a student more than a whole band: the figure measures how often
  // somebody opened the register, not the student.
  minMarksForRate: 6,
  // Above this the figure is reported as confident. 100/12 is 8.3 points, inside the
  // narrowest default band, so one register can no longer walk a student across one.
  confidentMarks: 12,
  // Below this share of a student's scheduled sessions carrying any mark, the register is
  // reported as not being taken — a finding about STAFF. Deliberately generous:
  // HndSession.audience means some scheduled sessions legitimately do not apply to a
  // student and this pipeline cannot see which, so a tight limit would turn a timetabling
  // quirk into an accusation.
  lowCoverageLimit: 60,
  minScheduledForCoverage: 4,
  // How long a register may go untaken before it is reported. Longer than notSeenDays
  // (14) on purpose, so the STUDENT-side code fires first and one event does not put two
  // rows on the caseload. Three weeks cannot be a reading week plus a bank holiday.
  staleRegisterDays: 21,

  /* --- VLE engagement ------------------------------------------------------ */

  // The fewest observed DAYS before an active-day rate is reported. One observed day on
  // which the student did not log in reads 0% and the screen renders "never active" -- a
  // pattern claimed from a single data point, on the first day of observation, which is
  // exactly when that data point exists and nothing else does.
  minObservedDays: 5,

  /* --- assessment workload -------------------------------------------------- */

  // The window deadlines are bunched into, and how far ahead to look. A week is the unit
  // both a timetable and a student's own planning are in. The horizon is 28 rather than
  // 14 because a fortnight-wide view can only see the near half of a cluster that
  // straddles its edge, and would report it at half size; 28 also matches
  // recentAttendanceDays and directionOfTravelDays.
  clusterWindowDays: 7,
  horizonDays: 28,
  // Deadlines in one window before it counts as heavy. Two a week is ordinary; three
  // cannot be sequenced. Set at "heavy, not extreme" ON PURPOSE, because the threshold is
  // never the whole test — every workload CODE also requires something about this
  // student, so it is the conjunction that discriminates, not this number.
  peakDeadlineLimit: 3,
  // Outstanding pieces carried INTO that window. A count of concrete pieces, not a rate,
  // so it does not need the sample floors that lateSubmissionMinPieces and
  // disperseMinMarks carry — those protect percentages from tiny denominators.
  backlogLimit: 1,
  // The attendance the run-up has to fall below for the second conjunction, and the
  // fewest marks behind it. Both mirror figures already here — redAttendanceThreshold
  // and slopeMinMarks — rather than inventing a third opinion.
  peakAttendanceFloor: 70,
  recentMinMarks: 3,

  /* --- student finance ------------------------------------------------------ */

  // How long a claim may sit in one non-terminal state before it is reported. A third of
  // a twelve-week term: late enough to be a real stall, early enough that a hardship
  // payment still helps. Twice notSeenDays because a register is touched weekly and a
  // finance queue monthly.
  stalledStatusDays: 28,
  // The same question measured from applicationDate, which is the WEAKER anchor: it
  // measures time in the pipeline rather than time in THIS state, so it gets a longer
  // rope. Used only where statusChangedOn is null — which, until routes/slc.js began
  // writing it, was every row.
  unsettledApplicationDays: 56,
  // Shorter on purpose. "Awaiting evidence" is the one state the college can clear this
  // afternoon, by telling the student what is missing.
  evidenceOutstandingDays: 21,
  // The ceiling, in the shape unansweredQueryCeilingDays already carries. Unbounded, one
  // abandoned row from a first term keeps a code lit for three years.
  stalledCeilingDays: 240,
  // How long a refusal stays reportable. A student still enrolled a year after a decline
  // resolved it some other way, and that continued enrolment is the only evidence of
  // resolution this table can offer.
  refusedWindowDays: 365,

  /* --- the shape of the absence --------------------------------------------- */

  // Marks on ONE weekday (or one session kind) before that slice may be compared against
  // the rest. Four, matching disperseMinMarks: a weekday is the same shape of slice as a
  // unit. Deliberately NOT minMarksForRate (6), which would silence the signal entirely
  // for a cohort timetabled two days a week — exactly the cohorts where a clash on one of
  // those days matters most.
  weekdayMinMarks: 4,
  kindMinMarks: 4,
  // And a floor on the POOLED side too. A floor on only the interesting number is a
  // half-guard: "60% absent on Fridays against 0% across two other marks" is not a
  // comparison. Six, because the pooled side is the whole register minus one slice.
  weekdayMinOtherMarks: 6,
  kindMinOtherMarks: 6,
  // At least two slices must clear the floor before a worst one is named. A superlative
  // over one candidate is not a comparison — unitDispersion already refuses on the same
  // grounds.
  minWeekdaysMeasured: 2,
  minKindsMeasured: 2,

  // Consecutive weeks in which the register RAN and the student appeared in none of them.
  // Two, because one unattended week is a bad week and everybody has one. Commensurable
  // with notSeenDays (14) on purpose, so the two say the same thing in different units
  // rather than contradicting each other on the same screen.
  zeroWeekLimit: 2,
  // Marks across the whole RUN, not per week. A per-week floor would make this
  // structurally unable to fire at a college teaching one session a week — which is
  // precisely a college where three unseen weeks matters.
  zeroWeekMinMarks: 3,
  // How recent the run must be to still be reported. Empty weeks are transparent, which
  // is what lets a reading week pass without breaking a run — and would otherwise keep
  // one lit all summer. Past this, the finding hands over to the stale-register code, so
  // one event puts one row on the caseload rather than two.
  runRecencyDays: 21,

  /* --- what the student said before they started ---------------------------- */

  // A CEILING, running the opposite way to settlingInWeeks' floor. The entry profile is
  // worth most in week one, when nothing else has any data, and must DECAY — because
  // nothing ever updates an Ism. No route re-asks the questions, so a September answer
  // would still be sitting on the row in year two with no event able to clear it.
  entryProfileWeeks: 12,
  // How much notice before a right to study runs out. Renewals take weeks, so a term of
  // warning makes this an intervention rather than a report. Chosen structurally, NOT
  // from any published Home Office turnaround.
  idExpiryWarnDays: 90,
  // And a ceiling on how long an expired date stays on the caseload, in the shape
  // refusedWindowDays already carries. Admission stops being maintained the day somebody
  // enrols, so an old expiry usually means "renewed, nobody updated the row". It costs
  // nothing: the DATE is stored regardless, so a compliance list still sees every expiry
  // for ever — only the caseload code ages out.
  idExpiredCeilingDays: 365,

  /* --- when the signals disagree -------------------------------------------- */

  // How far apart two rates must be before the disagreement is a finding.
  //
  // DELIBERATELY LARGER than attendanceSlopeDrop (10) or cohortOutlierGap (10), and the
  // reason is that those compare LIKE WITH LIKE — the same instrument and the same
  // denominator, with only the window or the population moving. Nothing is held constant
  // here, so ten points between an attendance percentage and a submission rate is the
  // ordinary state of an ordinary student. 25 is more than one step of the band ladder
  // (85/70/55/40) and less than two: 95/20 fires, 80/60 does not.
  divergenceGap: 25,
  // Floors on BOTH sides of every comparison. A floor on only the interesting number is
  // a half-guard, which this codebase has shipped before. The asymmetry is deliberate:
  // requiring six submissions would silence the comparison until the back half of a term.
  minAttendanceObservations: 6,
  minSubmissionObservations: 3,
  minVleObservedDays: 5,
  minGradedForAttainment: 4,
  // The mark at which attainment counts as "holding up" despite falling attendance. A
  // band rung rather than a number, and clear of a bare pass: 40 props nothing up.
  attainingGradeFloor: 55,

  // Which version of the engine produced a score. NOT a college's policy — it is a
  // property of the code, and two rows scored by different versions are not
  // comparable. It appears here because every caller reads the whole config and the
  // engine has to stamp it on every row it writes; validate() always emits the
  // value below and ignores any stored one. See validate() for why it is accepted
  // as input rather than rejected outright.
  modelVersion: "PROG-1.0",
};

// Frozen because it is shared by every tenant in the process. get() hands back a
// clone, but one caller that reaches for DEFAULTS directly and edits a weight would
// otherwise change the policy every other college falls back to, for the lifetime of
// the process, with nothing in any diff to show for it.
deepFreeze(DEFAULTS);

/* -------------------------------------------------------------------------- */
/* 2) Cache.                                                                  */
/* -------------------------------------------------------------------------- */

// Short, matching attendanceBandConfig.js and branding.js. This is read once per
// batch recalculation rather than per student, it changes about never, and an
// administrator who has just moved a weight should see the next run use it.
const TTL_MS = Number(process.env.PREDICTION_SETTINGS_CACHE_MS ?? 30_000);
const cache = new Map(); // tenantId -> { value, at }

/* -------------------------------------------------------------------------- */
/* 3) Validation.                                                             */
/* -------------------------------------------------------------------------- */

// What may appear at the top level of a stored config. An allowlist rather than a
// merge of whatever arrived, so a key nobody implemented cannot be stored and read
// back as though the system honours it.
const KNOWN_KEYS = Object.keys(DEFAULTS);
const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS);

const ATTENDANCE_MODES = ["points", "binary"];
const SCOPES = ["current-term", "current-year", "all"];

// Floating point. 0.2 + 0.15 + 0.15 + 0.1 + 0.25 + 0.1 + 0.05 is 0.9999999999999999
// in IEEE 754, so an exact === 1 would reject the platform defaults themselves.
const WEIGHT_EPSILON = 1e-6;

// Progression scores carry ONE decimal (weighted sum of components, rounded to one
// place — the same precision attendance.js works in). So the smallest gap that can
// actually swallow a student is 0.1, and a band list running to 84.99 or to 84.9 is
// equally watertight against a real score. Anything wider than one step is a hole.
const SCORE_STEP = 0.1;
const nextScoreAbove = (n) => Math.round((n + SCORE_STEP) * 10) / 10;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

const fail = (error) => ({ ok: false, error });

/** Present a fraction the way an administrator entered it: "0.9 (90%)". */
const showWeight = (n) => `${Number(n.toFixed(6))} (${Math.round(n * 1000) / 10}%)`;

/** A number that arrived from a form: "28" must mean 28, but "" must not mean 0. */
function num(raw) {
  if (raw === "" || raw == null) return NaN;
  if (typeof raw === "boolean") return NaN; // Number(true) is 1; a tickbox is not a threshold
  return Number(raw);
}

/**
 * Check a single numeric setting, in range, with an error an administrator can act
 * on. `whole` demands an integer — a count of assessments or of red indicators has
 * no meaningful fractional value and 2.5 missing assessments would compare oddly.
 */
function checkNumber(out, key, raw, { min, max, whole = false, label, why }) {
  const n = num(raw);
  if (!isFiniteNumber(n)) {
    return fail(`${label} is "${raw === "" || raw == null ? "(blank)" : raw}". It must be a number between ${min} and ${max}.`);
  }
  if (whole && !Number.isInteger(n)) {
    return fail(`${label} is ${n}. It must be a whole number — ${why}`);
  }
  if (n < min || n > max) {
    return fail(`${label} is ${n}. It must be between ${min} and ${max}. ${why}`);
  }
  out[key] = n;
  return null;
}

/**
 * Validate and tidy a proposed configuration.
 *
 * Returns { ok: true, config } — a COMPLETE config, every key present, defaults
 * merged underneath whatever was supplied — or { ok: false, error }, where `error`
 * is the sentence the administrator is shown and says what would happen to students
 * if it were saved. Nobody can act on "invalid configuration".
 *
 * validate({}) therefore returns the platform defaults unchanged, which is exactly
 * what a college with no stored row is running on.
 */
function validate(input) {
  if (input == null) return { ok: true, config: clone(DEFAULTS) };
  if (!isPlainObject(input)) {
    return fail("The prediction settings must be sent as an object.");
  }

  // Unknown keys are refused rather than dropped. Dropping is worse: the save
  // succeeds, the administrator believes the setting is live, and nothing reads it.
  const unknown = Object.keys(input).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length) {
    return fail(
      `Unknown setting${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `"${k}"`).join(", ")}. ` +
      `Nothing reads ${unknown.length > 1 ? "those" : "that"}, so saving ${unknown.length > 1 ? "them" : "it"} ` +
      `would leave you believing a change had taken effect when it had not. Valid settings are: ${KNOWN_KEYS.join(", ")}.`
    );
  }

  const out = {};

  /* --- weights ---------------------------------------------------------- */

  const weightsIn = input.weights === undefined ? {} : input.weights;
  if (!isPlainObject(weightsIn)) {
    return fail("The weights must be sent as an object with one entry per component.");
  }
  const unknownWeights = Object.keys(weightsIn).filter((k) => !WEIGHT_KEYS.includes(k));
  if (unknownWeights.length) {
    return fail(
      `Unknown weight${unknownWeights.length > 1 ? "s" : ""}: ${unknownWeights.map((k) => `"${k}"`).join(", ")}. ` +
      `The score has exactly seven components: ${WEIGHT_KEYS.join(", ")}.`
    );
  }

  // Merged per key over the defaults, so a form that posts one changed weight is
  // valid input — but the SUM is then checked across the merged set, which is the
  // only level at which the rule means anything.
  const weights = {};
  for (const k of WEIGHT_KEYS) {
    const supplied = Object.prototype.hasOwnProperty.call(weightsIn, k);
    const n = supplied ? num(weightsIn[k]) : DEFAULT_WEIGHTS[k];
    if (!isFiniteNumber(n)) {
      return fail(`The weight for "${k}" is "${weightsIn[k] === "" || weightsIn[k] == null ? "(blank)" : weightsIn[k]}". Weights are numbers between 0 and 1.`);
    }
    if (n < 0 || n > 1) {
      return fail(`The weight for "${k}" is ${n}. Weights are fractions between 0 and 1 — 20% is 0.2, not 20.`);
    }
    weights[k] = n;
  }

  const sum = WEIGHT_KEYS.reduce((t, k) => t + weights[k], 0);
  if (Math.abs(sum - 1) > WEIGHT_EPSILON) {
    return fail(
      `The seven weights total ${showWeight(sum)}. They must total 1 (100%). ` +
      (sum < 1
        ? `A total below 1 deflates every score by the difference — at ${showWeight(sum)} every student in the college scores ` +
          `${Math.round((1 - sum) * 1000) / 10}% lower than they should, which walks the whole cohort down the risk ladder and ` +
          `produces a wave of "High Risk" flags that nothing in the students' behaviour explains.`
        : `A total above 1 inflates every score, so students in genuine difficulty are scored into the safe bands and never flagged.`)
    );
  }
  out.weights = weights;

  /* --- bands ------------------------------------------------------------ */

  // Replaced wholesale, never merged. A band list is only valid as a SET, and a
  // per-key merge cannot express "this college now has four bands where it had
  // five" — deleting a band is the one edit that must work. Same reasoning as
  // attendanceBandConfig.
  const bandsIn = input.bands === undefined ? DEFAULT_BANDS : input.bands;
  const checkedBands = normaliseBands(bandsIn);
  if (!checkedBands.ok) return fail(checkedBands.error);
  out.bands = checkedBands.bands;

  /* --- scalars ---------------------------------------------------------- */

  const pick = (key) => (input[key] === undefined ? DEFAULTS[key] : input[key]);

  let err =
    checkNumber(out, "recentAttendanceDays", pick("recentAttendanceDays"), {
      min: 1, max: 365, whole: true,
      label: "The recent-attendance window",
      why: "it is a count of days. A window of 0 would leave the recent-attendance component with no sessions to read and every student scoring on no evidence.",
    }) ||
    checkNumber(out, "gradeTrendAssessmentCount", pick("gradeTrendAssessmentCount"), {
      min: 1, max: 10, whole: true,
      label: "The grade-trend assessment count",
      why: "it is a count of assessments. It is needed TWICE over — the trend compares the latest N against the previous N — so a value of N requires 2N graded pieces before any trend can be calculated at all.",
    }) ||
    checkNumber(out, "gradeTrendThreshold", pick("gradeTrendThreshold"), {
      min: 0, max: 100,
      label: "The grade-trend threshold",
      why: "it is a movement in percentage points.",
    }) ||
    checkNumber(out, "passThreshold", pick("passThreshold"), {
      min: 0, max: 100,
      label: "The pass threshold",
      why: "it is a percentage. At 0 nothing can ever be below it, so OVR-003 and the low-grade red indicator would never fire for anybody.",
    }) ||
    checkNumber(out, "missingOverrideCount", pick("missingOverrideCount"), {
      min: 1, max: 50, whole: true,
      label: "The missing-assessment override count (OVR-001)",
      why: "it is a count of assessments. At 0 every student alive would be capped at R3.",
    }) ||
    checkNumber(out, "criticalRecentAttendance", pick("criticalRecentAttendance"), {
      min: 0, max: 100,
      label: "The critical recent-attendance threshold (OVR-002)",
      why: "it is a percentage.",
    }) ||
    checkNumber(out, "redIndicatorThreshold", pick("redIndicatorThreshold"), {
      min: 1, max: 6, whole: true,
      label: "The red-indicator threshold (OVR-004)",
      why: "there are exactly six red indicators, so a threshold above six could never fire and the override would be silently dead.",
    }) ||
    checkNumber(out, "redAttendanceThreshold", pick("redAttendanceThreshold"), {
      min: 0, max: 100,
      label: "The red attendance threshold",
      why: "it is a percentage. At 0 the attendance red could never fire and OVR-004 would be one indicator short of the six it counts.",
    }) ||
    checkNumber(out, "redSubmissionThreshold", pick("redSubmissionThreshold"), {
      min: 0, max: 100,
      label: "The red submission-rate threshold",
      why: "it is a percentage. At 0 the submission red could never fire.",
    }) ||
    checkNumber(out, "directionOfTravelDays", pick("directionOfTravelDays"), {
      min: 1, max: 365, whole: true,
      label: "The direction-of-travel window",
      why: "it is a count of days back to the score this one is compared against.",
    }) ||
    checkNumber(out, "directionOfTravelThreshold", pick("directionOfTravelThreshold"), {
      min: 0, max: 100,
      label: "The direction-of-travel threshold",
      why: "it is a movement in progression-score points. At 0 every student would be reported as improving or declining on the ordinary movement a single register causes.",
    }) ||
    checkNumber(out, "interventionReviewDays", pick("interventionReviewDays"), {
      min: 1, max: 365, whole: true,
      label: "The intervention review window",
      why: "it is a count of days an intervention must run before its effect is judged. At 0 a student would be marked down for not having recovered the same afternoon somebody spoke to them.",
    }) ||
    checkNumber(out, "absenceStreakSessions", pick("absenceStreakSessions"), {
      min: 1, max: 50, whole: true,
      label: "The absence-streak threshold",
      why: "it is a count of consecutive unexplained absences. At 0 every student with a register would be reported as having stopped attending.",
    }) ||
    checkNumber(out, "notSeenDays", pick("notSeenDays"), {
      min: 1, max: 365, whole: true,
      label: "The not-seen window",
      why: "it is a count of days since the student was last in a room. At 0 everybody who did not attend today would be flagged as lost.",
    }) ||
    checkNumber(out, "unmarkedGraceDays", pick("unmarkedGraceDays"), {
      min: 0, max: 365, whole: true,
      label: "The marking grace period",
      why: "it is how long work may sit unmarked after its deadline before it is reported. At 0 every assessment is reported the morning after it was due, including the ones being marked that week.",
    }) ||
    checkNumber(out, "attendanceSlopeDrop", pick("attendanceSlopeDrop"), {
      min: 1, max: 100,
      label: "The attendance-fall threshold",
      why: "it is a fall in percentage points between two windows. At 0 the ordinary movement of a single register would be reported as deterioration.",
    }) ||
    checkNumber(out, "slopeMinMarks", pick("slopeMinMarks"), {
      min: 1, max: 100, whole: true,
      label: "The minimum marks for an attendance slope",
      why: "it is how many marked sessions a window needs before a percentage from it may be compared. At 1 a single register reads as 0% or 100% and produces the largest fall on the screen from no evidence at all.",
    }) ||
    checkNumber(out, "nearFailMargin", pick("nearFailMargin"), {
      min: 0, max: 100,
      label: "The near-miss margin",
      why: "it is how far above the pass mark still counts as a near miss. At 0 nothing is ever a near miss and the figure is dead.",
    }) ||
    checkNumber(out, "noShowLimit", pick("noShowLimit"), {
      min: 1, max: 50, whole: true,
      label: "The no-show limit",
      why: "it is how many missed arranged meetings count as a pattern. At 0 every student would be reported, including those who have never been offered one.",
    }) ||
    checkNumber(out, "staleContactDays", pick("staleContactDays"), {
      min: 1, max: 365, whole: true,
      label: "The pastoral-contact window",
      why: "it is how long a student may go without a logged conversation before that is reported. At 0 every student is reported every day and the list means nothing.",
    }) ||
    checkNumber(out, "disperseMinMarks", pick("disperseMinMarks"), {
      min: 1, max: 100, whole: true,
      label: "The minimum marks for a per-unit comparison",
      why: "it is how many marked sessions a unit needs before its percentage may be compared with another unit's. At 1 a unit with a single register is always the worst unit.",
    }) ||
    checkNumber(out, "unitSpreadLimit", pick("unitSpreadLimit"), {
      min: 1, max: 100,
      label: "The per-unit attendance gap",
      why: "it is how far apart the best and worst unit may be before the gap is reported. At 0 every student with any variation between units is flagged.",
    }) ||
    checkNumber(out, "lateSubmissionLimit", pick("lateSubmissionLimit"), {
      min: 1, max: 100,
      label: "The late-submission threshold",
      why: "it is the share of marked work arriving after its deadline that counts as a pattern. At 0 a single late piece flags every student who has ever handed anything in late.",
    }) ||
    checkNumber(out, "settlingInWeeks", pick("settlingInWeeks"), {
      min: 0, max: 52, whole: true,
      label: "The settling-in period",
      why: "it is how long a new student is exempt from the disengagement codes. At 0 the whole intake is flagged in week one, and a caseload containing everybody is the same as no caseload.",
    }) ||
    checkNumber(out, "dueSoonDays", pick("dueSoonDays"), {
      min: 1, max: 365, whole: true,
      label: "The upcoming-work window",
      why: "it is how far ahead to count work falling due. At 0 nothing is ever upcoming and the figure is dead.",
    }) ||
    checkNumber(out, "lateSubmissionMinPieces", pick("lateSubmissionMinPieces"), {
      min: 1, max: 100, whole: true,
      label: "The minimum work for a late-submission pattern",
      why: "it is how many marked, dated pieces are needed before lateness is called a pattern. At 1 a single late assignment reads as 100% late.",
    }) ||
    checkNumber(out, "concernWindowDays", pick("concernWindowDays"), {
      min: 1, max: 3650, whole: true,
      label: "The repeated-concern window",
      why: "it is how far back a repeated concern is looked for. Unbounded, a concern raised twice in a first term never clears.",
    }) ||
    checkNumber(out, "noShowWindowDays", pick("noShowWindowDays"), {
      min: 1, max: 3650, whole: true,
      label: "The missed-meeting window",
      why: "it is how far back a missed meeting counts. Unbounded, two missed meetings in a first term keep a student on the caseload for the rest of their programme.",
    }) ||
    checkNumber(out, "unansweredQueryDays", pick("unansweredQueryDays"), {
      min: 1, max: 365, whole: true,
      label: "The unanswered-query window",
      why: "it is how long a student's question may go unanswered before it is reported. At 0 every query is reported the moment it is sent, including the ones being answered that morning.",
    }) ||
    checkNumber(out, "contactDeficitDays", pick("contactDeficitDays"), {
      min: 1, max: 365, whole: true,
      label: "The high-risk contact window",
      why: "it is how long a student the model has flagged may go without a logged conversation before that is reported. At 0 every flagged student is reported every day, including those somebody spoke to this morning.",
    }) ||
    checkNumber(out, "minAbsencesForShare", pick("minAbsencesForShare"), {
      min: 1, max: 100, whole: true,
      label: "The minimum absences for an unexplained share",
      why: "it is how many absences are needed before the unexplained share is shown. At 1 a single unexcused absence reads as 100% unexplained.",
    }) ||
    checkNumber(out, "followUpGraceDays", pick("followUpGraceDays"), {
      min: 0, max: 365, whole: true,
      label: "The follow-up grace period",
      why: "it is how long after its promised date a follow-up may go unrecorded before it is reported. At 0 every follow-up is reported the morning after its date, including the ones being held that afternoon.",
    }) ||
    checkNumber(out, "followUpWindowDays", pick("followUpWindowDays"), {
      min: 1, max: 3650, whole: true,
      label: "The missed-follow-up window",
      why: "it is how far back a missed follow-up counts. Unbounded, one promise never held keeps a student on the caseload for the rest of their programme.",
    }) ||
    checkNumber(out, "unansweredQueryCeilingDays", pick("unansweredQueryCeilingDays"), {
      min: 1, max: 3650, whole: true,
      label: "The unanswered-query ceiling",
      why: "it is how long an unanswered question keeps being reported. Unbounded, one query nobody answered in a first term lights the row for ever.",
    }) ||
    checkNumber(out, "firstSessionMinDays", pick("firstSessionMinDays"), {
      min: 1, max: 100, whole: true,
      label: "The minimum days for a first-session pattern",
      why: "it is how many multi-session teaching days are needed before morning absence is reported as a pattern. At 1 a single bad morning reads as an inability to get here.",
    }) ||
    checkNumber(out, "mitigationWindowMaxDays", pick("mitigationWindowMaxDays"), {
      min: 1, max: 730, whole: true,
      label: "The longest a mitigating-circumstances claim may cover",
      why: "an unbounded window is a permanent suppression, which is indistinguishable from the student having been taken off the risk register altogether.",
    }) ||
    checkNumber(out, "mitigationUndecidedDays", pick("mitigationUndecidedDays"), {
      min: 1, max: 365, whole: true,
      label: "The undecided-claim reporting threshold",
      why: "it is how long a claim may sit undecided before the delay is reported. The delay is the institution's and the student underneath it is the one harmed by it.",
    }) ||
    checkNumber(out, "cohortMinSize", pick("cohortMinSize"), {
      min: 2, max: 1000, whole: true,
      label: "The smallest cohort that may rank anybody",
      why: "below ten students, \"in the bottom 10%\" and \"is the worst in the room\" are the same statement, and exactly one student per group is the worst by definition.",
    }) ||
    checkNumber(out, "cohortOutlierPercentile", pick("cohortOutlierPercentile"), {
      min: 1, max: 50,
      label: "The cohort outlier tail",
      why: "half of every cohort is below the median by definition, so a signal set near 50 fires for half the college and produces no caseload at all.",
    }) ||
    checkNumber(out, "cohortOutlierGap", pick("cohortOutlierGap"), {
      min: 0, max: 100,
      label: "The cohort outlier gap",
      why: "a rank alone is not a finding. The bottom decile of a cohort sitting between 88 and 92 percent is three points off the mean, which is nothing.",
    }) ||
    checkNumber(out, "cohortMinSpread", pick("cohortMinSpread"), {
      min: 0, max: 100,
      label: "The smallest cohort spread worth ranking",
      why: "below it the ordering is decided by rounding and reshuffles on every run, while still looking like a ranking.",
    }) ||
    checkNumber(out, "minMarksForRate", pick("minMarksForRate"), {
      min: 1, max: 200, whole: true,
      label: "The fewest marks behind a printed attendance percentage",
      why: "at five marks one observation is worth twenty points and the band ladder is fifteen wide, so a single register moves a student more than a whole band.",
    }) ||
    checkNumber(out, "confidentMarks", pick("confidentMarks"), {
      min: 1, max: 500, whole: true,
      label: "The marks needed for a confident attendance figure",
      why: "it is where one more register stops being able to walk a student across a band.",
    }) ||
    checkNumber(out, "lowCoverageLimit", pick("lowCoverageLimit"), {
      min: 0, max: 100,
      label: "The register-coverage limit",
      why: "below it the register is reported as not being taken, which is a finding about staff. Set too high it accuses a college of a timetabling quirk it cannot see.",
    }) ||
    checkNumber(out, "minScheduledForCoverage", pick("minScheduledForCoverage"), {
      min: 1, max: 200, whole: true,
      label: "The fewest scheduled sessions before coverage is judged",
      why: "a coverage fraction over one or two sessions is not a measurement of anybody's register-keeping.",
    }) ||
    checkNumber(out, "staleRegisterDays", pick("staleRegisterDays"), {
      min: 1, max: 365, whole: true,
      label: "The stale-register threshold",
      why: "it is how long a register may go untaken before it is reported. Shorter than the not-seen threshold, one event puts two rows on the caseload.",
    }) ||
    checkNumber(out, "minObservedDays", pick("minObservedDays"), {
      min: 1, max: 365, whole: true,
      label: "The fewest observed days behind a VLE engagement rate",
      why: "one observed day on which a student did not log in reads 0% and renders as \"never active\" — a pattern claimed from a single data point on the first day of observation.",
    }) ||
    checkNumber(out, "clusterWindowDays", pick("clusterWindowDays"), {
      min: 1, max: 90, whole: true,
      label: "The workload clustering window",
      why: "it is the span deadlines are bunched into. A week is the unit both a timetable and a student's own planning are in.",
    }) ||
    checkNumber(out, "horizonDays", pick("horizonDays"), {
      min: 1, max: 365, whole: true,
      label: "The workload horizon",
      why: "a horizon shorter than twice the clustering window can only see the near half of a cluster straddling its edge, and reports it at half size.",
    }) ||
    checkNumber(out, "peakDeadlineLimit", pick("peakDeadlineLimit"), {
      min: 1, max: 50, whole: true,
      label: "The heavy-window threshold",
      why: "it is how many deadlines in one window count as heavy. It never fires alone — every workload code also requires something about the individual student.",
    }) ||
    checkNumber(out, "backlogLimit", pick("backlogLimit"), {
      min: 1, max: 50, whole: true,
      label: "The carried-backlog threshold",
      why: "it is how much outstanding work a student must be carrying into a heavy window before that combination is reported.",
    }) ||
    checkNumber(out, "peakAttendanceFloor", pick("peakAttendanceFloor"), {
      min: 0, max: 100,
      label: "The workload attendance floor",
      why: "it is the attendance in the run-up below which a heavy window ahead becomes a finding rather than a timetable fact.",
    }) ||
    checkNumber(out, "recentMinMarks", pick("recentMinMarks"), {
      min: 1, max: 200, whole: true,
      label: "The fewest recent marks behind that judgement",
      why: "an attendance figure from one or two registers is not evidence a student has stopped turning up.",
    }) ||
    checkNumber(out, "stalledStatusDays", pick("stalledStatusDays"), {
      min: 1, max: 365, whole: true,
      label: "The stalled-claim threshold",
      why: "it is how long a finance claim may sit in one state before it is reported. Late enough to be a real stall, early enough that a hardship payment still helps.",
    }) ||
    checkNumber(out, "unsettledApplicationDays", pick("unsettledApplicationDays"), {
      min: 1, max: 730, whole: true,
      label: "The unsettled-claim threshold",
      why: "the same question measured from the application date, which is a weaker anchor — it measures time in the pipeline rather than time in this state — so it gets a longer rope.",
    }) ||
    checkNumber(out, "evidenceOutstandingDays", pick("evidenceOutstandingDays"), {
      min: 1, max: 365, whole: true,
      label: "The outstanding-evidence threshold",
      why: "awaiting evidence is the one state the college can clear this afternoon, by telling the student what is missing, so it is reported sooner.",
    }) ||
    checkNumber(out, "stalledCeilingDays", pick("stalledCeilingDays"), {
      min: 1, max: 3650, whole: true,
      label: "The stalled-claim ceiling",
      why: "unbounded, one abandoned row from a first term keeps a code lit for three years.",
    }) ||
    checkNumber(out, "refusedWindowDays", pick("refusedWindowDays"), {
      min: 1, max: 3650, whole: true,
      label: "The refusal reporting window",
      why: "a student still enrolled a year after a decline resolved it some other way, and that continued enrolment is the only evidence of resolution this table can offer.",
    }) ||
    checkNumber(out, "weekdayMinMarks", pick("weekdayMinMarks"), {
      min: 1, max: 200, whole: true,
      label: "The fewest marks on one weekday",
      why: "a weekday absence rate from two registers is a pattern claimed from two data points.",
    }) ||
    checkNumber(out, "kindMinMarks", pick("kindMinMarks"), {
      min: 1, max: 200, whole: true,
      label: "The fewest marks on one session kind",
      why: "the same floor as a weekday, for the same reason — one slice compared against the rest.",
    }) ||
    checkNumber(out, "weekdayMinOtherMarks", pick("weekdayMinOtherMarks"), {
      min: 1, max: 500, whole: true,
      label: "The fewest marks on the other weekdays",
      why: "a floor on only the interesting number is a half-guard: 60% absent on Fridays against two marks elsewhere is not a comparison.",
    }) ||
    checkNumber(out, "kindMinOtherMarks", pick("kindMinOtherMarks"), {
      min: 1, max: 500, whole: true,
      label: "The fewest marks on the other session kinds",
      why: "the pooled side needs a floor as much as the slice does, or the gap is measured against nothing.",
    }) ||
    checkNumber(out, "minWeekdaysMeasured", pick("minWeekdaysMeasured"), {
      min: 2, max: 7, whole: true,
      label: "The fewest weekdays before a worst one is named",
      why: "a superlative over one candidate is not a comparison — it names the only weekday there is.",
    }) ||
    checkNumber(out, "minKindsMeasured", pick("minKindsMeasured"), {
      min: 2, max: 50, whole: true,
      label: "The fewest session kinds before a worst one is named",
      why: "naming the worst of one kind says nothing about the student.",
    }) ||
    checkNumber(out, "zeroWeekLimit", pick("zeroWeekLimit"), {
      min: 1, max: 52, whole: true,
      label: "The unseen-weeks threshold",
      why: "one unattended week is a bad week and everybody has one. At 1 this fires for most of the college in any week containing a bank holiday.",
    }) ||
    checkNumber(out, "zeroWeekMinMarks", pick("zeroWeekMinMarks"), {
      min: 1, max: 200, whole: true,
      label: "The fewest marks behind an unseen run",
      why: "measured across the whole run rather than per week, because a per-week floor makes this unable to fire at a college teaching one session a week.",
    }) ||
    checkNumber(out, "runRecencyDays", pick("runRecencyDays"), {
      min: 1, max: 365, whole: true,
      label: "How recent an unseen run must be to report",
      why: "empty weeks are transparent, which is what lets a reading week pass without breaking a run — and would otherwise keep one lit all summer.",
    }) ||
    checkNumber(out, "entryProfileWeeks", pick("entryProfileWeeks"), {
      min: 1, max: 104, whole: true,
      label: "How long the entry profile stays relevant",
      why: "nothing ever updates an ISM — no route re-asks the questions — so without a ceiling a September answer sits on the record in year two with no event able to clear it.",
    }) ||
    checkNumber(out, "idExpiryWarnDays", pick("idExpiryWarnDays"), {
      min: 1, max: 730, whole: true,
      label: "The right-to-study warning window",
      why: "renewals take weeks, so a warning shorter than that is a report rather than an intervention.",
    }) ||
    checkNumber(out, "idExpiredCeilingDays", pick("idExpiredCeilingDays"), {
      min: 1, max: 3650, whole: true,
      label: "How long an expired document stays on the caseload",
      why: "an admission record stops being maintained the day somebody enrols, so an old expiry usually means it was renewed and nobody updated the row. The date is stored regardless.",
    }) ||
    checkNumber(out, "divergenceGap", pick("divergenceGap"), {
      min: 1, max: 100,
      label: "The divergence threshold",
      why: "it is how far two rates must disagree before that is a finding. Set near the like-for-like thresholds it fires for ordinary students, because nothing is held constant between two different measurements.",
    }) ||
    checkNumber(out, "minAttendanceObservations", pick("minAttendanceObservations"), {
      min: 1, max: 500, whole: true,
      label: "The attendance sample behind a divergence",
      why: "a floor on only one side of a comparison is a half-guard.",
    }) ||
    checkNumber(out, "minSubmissionObservations", pick("minSubmissionObservations"), {
      min: 1, max: 500, whole: true,
      label: "The submission sample behind a divergence",
      why: "deliberately lower than the attendance floor — requiring six would silence the comparison until the back half of a term.",
    }) ||
    checkNumber(out, "minVleObservedDays", pick("minVleObservedDays"), {
      min: 1, max: 365, whole: true,
      label: "The VLE sample behind a divergence",
      why: "the same floor engagement itself applies, restated because it answers a different question here.",
    }) ||
    checkNumber(out, "minGradedForAttainment", pick("minGradedForAttainment"), {
      min: 1, max: 200, whole: true,
      label: "The marks needed before attainment props anything up",
      why: "it is the sample the engine already requires before calling a grade direction at all.",
    }) ||
    checkNumber(out, "attainingGradeFloor", pick("attainingGradeFloor"), {
      min: 0, max: 100,
      label: "The mark at which attainment is holding up",
      why: "a bare pass props nothing up, so this sits a band rung clear of the pass mark.",
    });
  if (err) return err;

  /* --- the bands each override caps at ---------------------------------- */

  // Checked AFTER the bands, because the whole point is that the name must exist in
  // the ladder this same save is storing. Checking it against the previously stored
  // ladder would let a college delete R3 and keep an override pointing at it.
  const bandKeys = out.bands.map((b) => b.key);
  for (const [key, what] of [
    ["missingOverrideBand", "the missing-assessment override (OVR-001)"],
    ["criticalAttendanceBand", "the critical-attendance override (OVR-002)"],
    ["lowGradeBand", "the below-pass-average override (OVR-003)"],
    ["interventionBand", "the intervention flag"],
    ["contactDeficitBand", "the high-risk contact deficit"],
  ]) {
    const value = pick(key);
    if (typeof value !== "string" || !bandKeys.includes(value)) {
      return fail(
        `${what[0].toUpperCase()}${what.slice(1)} names the band "${value}", which is not one of your risk bands (${bandKeys.join(", ")}). ` +
        `An override pointing at a band that does not exist does nothing at all, and it does nothing SILENTLY — the rule would appear on this screen, ` +
        `read as though it were protecting students, and never fire for anybody.`
      );
    }
    out[key] = value;
  }

  /* --- enumerations ----------------------------------------------------- */

  const attendanceMode = pick("attendanceMode");
  if (!ATTENDANCE_MODES.includes(attendanceMode)) {
    return fail(
      `The attendance mode is "${attendanceMode}". It must be one of: ${ATTENDANCE_MODES.map((m) => `"${m}"`).join(", ")}. ` +
      `"points" is the P=2 / L=1 / E=1 / A=0 model the Attendance % tab already displays.`
    );
  }
  out.attendanceMode = attendanceMode;

  const scope = pick("scope");
  if (!SCOPES.includes(scope)) {
    return fail(
      `The scope is "${scope}". It must be one of: ${SCOPES.map((s) => `"${s}"`).join(", ")}. ` +
      `"current-term" scores the student's current term only, so a difficult first year is not carried forever and — the direction that matters more — a strong first year cannot mask a collapse happening now.`
    );
  }
  out.scope = scope;

  /* --- tickboxes -------------------------------------------------------- */

  // The only boolean in the configuration, so it is checked here rather than through a
  // checkBool helper that would have exactly one caller.
  //
  // STRICTLY typed, never coerced. Boolean("false") is true, and a config posted from a
  // form that stringifies its fields would silently flip a college from "a pending claim
  // has no effect" to "a pending claim suppresses" — which is a change to who appears on
  // a risk register, made by nobody, visible on no screen. Refusing is the only safe
  // reading of a value that is not already a boolean.
  const pendingClaimSuppresses = pick("pendingClaimSuppresses");
  if (typeof pendingClaimSuppresses !== "boolean") {
    return fail(
      `Whether a pending claim suppresses is "${pendingClaimSuppresses}", which is not true or false. ` +
      `It decides whether a student with an undecided mitigating-circumstances claim is measured as though they had simply not handed the work in, ` +
      `so a value that is not a tickbox must be refused rather than guessed at.`
    );
  }
  out.pendingClaimSuppresses = pendingClaimSuppresses;

  /* --- modelVersion ----------------------------------------------------- */

  // Always the code's value, whatever arrived. It identifies the ENGINE, not the
  // college's policy, and a stored one would win the merge in get() and go on
  // stamping a version string that no longer describes the code that produced the
  // row. It is accepted as input rather than refused so that the obvious admin-UI
  // round trip — read the whole config, change one weight, post the whole config
  // back — keeps working across an engine upgrade.
  out.modelVersion = DEFAULTS.modelVersion;

  // Fixed key order, so two configs that mean the same thing are the same JSON and a
  // diff of the stored column is readable.
  return { ok: true, config: orderKeys(out) };
}

/**
 * Validate and tidy a proposed band list: { ok: true, bands } or { ok: false, error }.
 *
 * The rules are the same ones attendanceBands.normaliseBands enforces, for the same
 * reasons, restated here against progression scores rather than attendance
 * percentages — a gap means a student is classified against nothing and is never
 * flagged; an overlap means their risk level depends on the order of an array.
 */
function normaliseBands(input) {
  if (!Array.isArray(input)) {
    return fail("The risk bands must be sent as a list.");
  }
  if (input.length < 2) {
    return fail("At least two risk bands are required — with one, every student in the college shares a single risk level and the score can never distinguish anybody.");
  }
  if (input.length > 10) {
    return fail(`A maximum of 10 risk bands is allowed; you sent ${input.length}. Each band carries its own action, and past ten nobody can keep them distinct.`);
  }

  const cleaned = [];
  const seenKeys = new Set();

  for (let i = 0; i < input.length; i++) {
    const raw = isPlainObject(input[i]) ? input[i] : {};
    const position = `Band ${i + 1}`;

    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key) return fail(`${position} has no key. The key is what every prediction row stores as its risk level, so it must be set and must not change when the band is renamed.`);
    if (key.length > 16) return fail(`${position} has a key of ${key.length} characters ("${key.slice(0, 16)}…"); the limit is 16.`);
    if (seenKeys.has(key)) return fail(`Two bands share the key "${key}". Keys identify a risk level in every stored row and in every history row, so they must be unique.`);
    seenKeys.add(key);

    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label) return fail(`Band "${key}" has no name. Every band needs a label — it is what staff read on the student's record.`);
    if (label.length > 60) return fail(`Band "${key}" has a name of ${label.length} characters; the limit is 60.`);

    const min = num(raw.min);
    const max = num(raw.max);
    if (!isFiniteNumber(min) || min < 0 || min > 100) {
      return fail(`Band "${label}" has a lower bound of ${raw.min === "" || raw.min == null ? "(blank)" : raw.min}. Bounds are scores between 0 and 100.`);
    }
    if (!isFiniteNumber(max) || max < 0 || max > 100) {
      return fail(`Band "${label}" has an upper bound of ${raw.max === "" || raw.max == null ? "(blank)" : raw.max}. Bounds are scores between 0 and 100.`);
    }
    if (min > max) {
      return fail(`Band "${label}" runs from ${min} down to ${max} — its lower bound is above its upper bound.`);
    }

    cleaned.push({ key, label, min, max });
  }

  // Sorted best -> worst here rather than trusting the caller. The ladder's order is
  // a property of the bounds, and both bandForScore and the override rules ("cannot
  // be better than R3", "worsen one level") walk this array by index — a list that
  // arrived in the wrong order would worsen a student's band upward.
  cleaned.sort((a, b) => b.min - a.min);

  const best = cleaned[0];
  const worst = cleaned[cleaned.length - 1];
  if (worst.min !== 0) {
    return fail(`The lowest band, "${worst.label}", starts at ${worst.min}. Bands must cover 0 — a student scoring ${Math.max(0, worst.min - SCORE_STEP)} would fall in no band at all, and a student in that much trouble is the one this system exists to find.`);
  }
  if (best.max !== 100) {
    return fail(`The highest band, "${best.label}", stops at ${best.max}. Bands must cover 100 — a student with a perfect score would fall in no band at all.`);
  }

  for (let i = 0; i < cleaned.length - 1; i++) {
    const upper = cleaned[i];     // the better band
    const lower = cleaned[i + 1]; // the one directly below it

    if (lower.max >= upper.min) {
      return fail(`"${lower.label}" (${lower.min}–${lower.max}) overlaps "${upper.label}" (${upper.min}–${upper.max}). A student scoring ${upper.min} would match two bands, and which risk level they were given — and therefore whether anyone intervened — would depend on the order of the list.`);
    }

    // Scores carry one decimal, so the test is whether a REAL score can land between
    // the two bands, not whether the numbers touch exactly. 84.99 -> 85 and
    // 84.9 -> 85 are both watertight; 80 -> 85 is a hole five points wide.
    const orphan = nextScoreAbove(lower.max);
    if (orphan < upper.min) {
      return fail(`There is a gap between "${lower.label}" (${lower.min}–${lower.max}) and "${upper.label}" (${upper.min}–${upper.max}). A student scoring ${orphan} would fall in no band, be given no risk level, and be silently skipped by every action the score is supposed to trigger.`);
    }
  }

  return { ok: true, bands: cleaned };
}

/* -------------------------------------------------------------------------- */
/* 4) Reading and writing.                                                    */
/* -------------------------------------------------------------------------- */

/**
 * This institution's prediction settings: what it saved, merged over the platform
 * defaults.
 *
 * Always a COMPLETE, VALID config — never null, never partial — so no caller needs a
 * fallback of its own and no batch run can score a cohort against half a policy.
 */
async function get() {
  const tenantId = currentTenantId();
  // Outside a request — a script, a one-off — there is no institution to look up,
  // and the defaults are the honest answer. A scheduler that means a particular
  // college's settings must say so with runInTenant; see db.js.
  if (!tenantId) return clone(DEFAULTS);

  const hit = cache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let row = null;
  try {
    row = await prisma.predictionModelSettings.findFirst();
  } catch {
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  // Re-validated on the way OUT, not only on the way in. A row can predate a rule,
  // or be edited by hand in a console, and weights totalling 0.9 would deflate an
  // entire cohort's scores without raising anything. Falling back to the defaults
  // keeps every student scored against a coherent policy, and the log names the
  // college so somebody can go and fix the row.
  let value = clone(DEFAULTS);
  if (row && isPlainObject(row.config)) {
    const checked = validate(row.config);
    if (checked.ok) value = checked.config;
    else console.error(`[prediction-settings] tenant ${tenantId} has an unusable stored config (${checked.error}) — using the platform defaults`);
  }

  cache.set(tenantId, { value, at: Date.now() });
  return value;
}

/**
 * Replace this institution's prediction settings. `config` is whatever the
 * administrator submitted; it is validated here, so no caller can write a config
 * that get() would then refuse and silently ignore.
 *
 * Returns { ok: true, config } or { ok: false, error }.
 *
 * Passing null RESETS to the platform defaults by deleting the row, so "no row" and
 * "a row holding the defaults" mean the same thing they do in attendanceBandConfig:
 * this college has never customised anything.
 *
 * NOTE FOR THE CALLER: every stored score was produced under the OLD settings and is
 * not comparable with one produced under the new ones. A save should mark the
 * college's StudentPredictionCurrent rows stale so the next batch rescores them;
 * that is deliberately not done here, because this module owns configuration and
 * knows nothing about scoring.
 */
async function save(config, updatedBy) {
  const tenantId = currentTenantId();
  const existing = await prisma.predictionModelSettings.findFirst();

  if (config === null) {
    if (existing) await prisma.predictionModelSettings.delete({ where: { id: existing.id } });
    invalidate(tenantId);
    return { ok: true, config: clone(DEFAULTS), reset: true };
  }

  const checked = validate(config);
  if (!checked.ok) return { ok: false, error: checked.error };

  const data = { config: checked.config, updatedBy: updatedBy || null };
  if (existing) await prisma.predictionModelSettings.update({ where: { id: existing.id }, data });
  else await prisma.predictionModelSettings.create({ data });

  invalidate(tenantId);
  return { ok: true, config: checked.config };
}

/** Whether this college has settings of its own, or is running on the defaults. */
async function isCustomised() {
  if (!currentTenantId()) return false;
  try {
    return Boolean(await prisma.predictionModelSettings.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

/** Drop the cached config — called after every save. */
const invalidate = (tenantId) => (tenantId ? void cache.delete(tenantId) : cache.clear());

/* -------------------------------------------------------------------------- */
/* 5) Helpers the engine needs.                                               */
/* -------------------------------------------------------------------------- */

/**
 * The band a progression score falls in.
 *
 * MATCHED ON THE LOWER BOUND ONLY, walking best -> worst — see the comment on
 * DEFAULT_BANDS. normaliseBands guarantees the list is sorted, gap-free and starts
 * at 0, so "the first band whose lower bound this score reaches" is total: every
 * value in 0..100 lands in exactly one band, decimals included.
 */
function bandForScore(score, bands) {
  if (score == null) return null; // == also catches undefined
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_BANDS;
  return list.find((b) => score >= b.min) || null;
}

/** A structured clone, so a caller mutating what it was given cannot edit the defaults. */
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Freeze an object and everything under it. Hoisted, so DEFAULTS can use it above. */
function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

/** DEFAULTS' key order, so the stored JSON is stable and diffable. */
function orderKeys(config) {
  const out = {};
  for (const k of KNOWN_KEYS) out[k] = config[k];
  return out;
}

module.exports = {
  DEFAULTS,
  get,
  save,
  validate,
  normaliseBands,
  bandForScore,
  invalidate,
  isCustomised,
  ATTENDANCE_MODES,
  SCOPES,
  WEIGHT_KEYS,
};
