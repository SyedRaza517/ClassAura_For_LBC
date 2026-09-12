// Predictive Analysis — the progression-risk register, its settings, and the record
// of what a college DID about a student it was worried about.
//
// Gated on the "prediction" page grant, like every other admin surface. That gate is
// the only thing switched on by deploying this: a college that grants the page to
// nobody has five empty tables and a menu item no one can see. Nothing here runs on
// a schedule, nothing emails a student, and no score exists until somebody presses
// Recalculate.
//
// WHY THE READS ARE GATED AS TIGHTLY AS THE WRITES
//
// A risk level is a judgement about a named student's likelihood of failing, derived
// from their attendance, their marks and a pastoral conversation somebody had with
// them. It is not a statistic. Handing "who is the college worried about" to every
// authenticated member of staff would be a wider disclosure than the gradebook, and
// the gradebook is already page-gated.
//
// WHAT IS DELIBERATELY ABSENT
//
//   - No student-facing route. The student app cannot reach this router at all (it
//     is not in STUDENT_ROUTERS), and a student being shown a machine's prediction
//     that they are likely to fail is a product decision nobody has taken.
//   - No automatic email. Compare attendanceEmails, which does write to students —
//     that feature had a template a human wrote and a band a human set. This one
//     would be a machine telling somebody they are at risk.
//   - No delete for a history row or an intervention. Both are records of what the
//     college knew and when, which is exactly what an appeal turns on.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { localDate } = require("../clock");
const { isString, isRealDate, MAX_TEXT } = require("../validate");
const audit = require("../audit");
const settings = require("../prediction/settings");
const runner = require("../prediction/runner");
const engine = require("../prediction/engine");
const tripwires = require("../prediction/tripwires");

router.use(requireAuth, requirePage("prediction"));

/**
 * Turn ?academicDepartmentId= into a fragment for a nested `student` relation filter.
 *
 * A FILTER, NOT A BOUNDARY — routes/hnd.js carries the long form of that distinction.
 * Scoping is enforced by the server and confines an account; this narrows a view the
 * caller chose and grants nothing. Same three cases as hnd.js's academicDepartmentFilter:
 * omitted -> everything, "none" -> students not yet assigned to a school, an id -> that
 * school. An unrecognised id passes through and matches nothing rather than being
 * silently dropped, because a filter that ignores a value it does not recognise shows
 * the whole college under a school heading.
 *
 * Nested under `student` rather than a column of its own because none of the prediction
 * tables carries academicDepartmentId — the student is the single source of it, and a
 * denormalised copy here would drift the day a student moves school.
 */
function studentDepartmentFilter(raw) {
  const v = isString(raw) ? raw.trim() : "";
  if (!v) return {};
  if (v === "none") return { academicDepartmentId: null };
  return { academicDepartmentId: v };
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

// An ALLOWLIST, not a blocklist, for the reason sAdmission carries one: a column
// added to StudentPredictionCurrent later must not ship to a browser because nobody
// remembered to strip it. Everything here is already visible to a member of staff
// holding this page.
const PREDICTION_OUT = [
  "scopeLabel", "scopeFrom", "scopeTo",
  "overallAttendance", "recentAttendance", "submissionRate", "onTimeRate",
  "missingAssessmentCount", "averageGrade",
  "gradeTrend", "gradeTrendScore", "interventionResponse", "interventionResponseScore",
  "baseProgressionScore", "progressionScore", "baseRiskLevel", "riskLevel",
  "directionOfTravel", "redIndicatorCount", "overrideApplied",
  "overrideCodes", "riskDriverCodes", "positiveDriverCodes",
  "primaryRiskDriver", "interventionRequired",
  "modelVersion", "lastCalculated", "stale",
  // Tripwire figures. Dates and counts only — the screen derives "not seen for 19
  // days" from lastAttendedOn at render time, because a day-count computed at score
  // time is wrong by the next morning and nothing recalculates on a clock.
  "absenceStreak", "lastAttendedOn", "oldestUnmarkedDueDate", "attendanceSlope",
  "lastEngagedOn", "unexplainedShare", "latenessRate", "failCount", "nearFailCount",
  "gradeVolatility", "worstUnitId", "unitAttendanceSpread", "unpassedUnitCount",
  "attendanceRegularity", "lateSubmissionRate", "meanDaysLate", "weeksIntoProgramme",
  "assessmentsDueSoon", "gradedWithDates", "oldestOpenQueryOn", "openQueryCount", "overdueFollowUpCount",
  "weightedAverageGrade", "gradeWasWeighted", "markingLatencyDays", "firstSessionAbsenceRate", "laterSessionAbsenceRate",
  "openMitigationCount", "oldestOpenMitigationOn", "mitigatedAssessmentCount", "attendanceMitigated",
  "registerCoverageRate", "scheduledSessionCount", "markedSessionCount", "attendanceConfidence", "attendanceObservations", "lastRegisterMarkOn", "cohortAttendancePercentile", "cohortAttainmentPercentile", "cohortSize", "cohortStruggling",
  "vleLastAccessOn", "vleActiveDayRate", "vleObservedDays", "vleUnitsObserved",
  "peakFrom", "peakTo", "peakCount", "peakWeightShare", "peakWasWeighted", "undatedAssessments", "carriedBacklogCount", "fundingPosition", "fundingUnsettledSince", "fundingSettledOn", "fundingRefusedOn", "fundingApplications", "fundingNotApplied",
  "worstAbsenceWeekday", "worstWeekdayAbsenceRate", "weekdayAbsenceGap", "weekdaysMeasured", "worstAbsenceKind", "worstKindAbsenceRate", "kindAbsenceGap", "kindsMeasured", "unseenWeekRun", "unseenSinceWeekOn", "lastAttendedWeekOn", "longestUnseenWeekRun", "observedWeeks",
  "entryProfileRecorded", "entryProfileOn", "entryProfileAnswered", "entryProfileQuestions", "entryProfileBarriers", "entryWifiAtHome", "entryKnowsOfficeSoftware", "entryAdmittedOutcome", "rightToStudyExpiresOn", "currentBandSince", "worstBandHeld", "worstBandSince", "observedDays", "bandChanges", "bandsVisited", "recoveredPoints", "recoveredBy", "lowestScore", "lowestOn", "divergenceShape", "attendanceSubmissionGap", "attendanceVleGap",
  "worstAssessmentType", "worstAssessmentTypePassRate", "worstAssessmentTypeMeanPct", "assessmentTypePassRateGap", "assessmentTypeMeanGap", "assessmentTypesMeasured", "assessmentTypesSeen", "untypedGradeCount", "earlyStartAbsenceRate", "laterStartAbsenceRate", "earlyStartAbsenceGap", "earlyStartLatenessRate", "laterStartLatenessRate", "earlyStartLatenessGap", "earlyStartDays", "longDayMissedRate", "shortDayMissedRate", "longDayMissedGap", "longDaysMeasured", "afterLongGapAbsenceRate", "afterShortGapAbsenceRate", "longGapAbsenceGap", "longGapSessions", "daysWithoutSessionEnd", "singleSessionDays",
  "earlyAttendance", "earlyAttendanceMarked", "subsequentAttendance", "subsequentAttendanceMarked", "earlyAttendanceGap", "earlyWindowEndsOn", "preStartMarked", "firstAssessmentPct", "firstAssessmentOn", "subsequentAverageGrade", "subsequentGradeCount", "firstAssessmentGap", "undatedGradeCount",
];

const pick = (row, keys) => {
  const out = {};
  for (const k of keys) if (row[k] !== undefined) out[k] = row[k];
  return out;
};

/** The student's identity, and nothing else from their record — no date of birth, no
 *  contact details, no login state. This screen needs to name them, not describe them. */
const sStudent = (s) => (s ? {
  id: s.id, firstName: s.firstName, lastName: s.lastName,
  studentRef: s.studentRef, initials: s.initials, colour: s.colour,
  cohortId: s.cohortId, cohortName: s.cohort ? s.cohort.name : null,
  courseName: s.cohort && s.cohort.course ? s.cohort.course.name : null,
} : null);

const sPrediction = (row) => (row ? { ...pick(row, PREDICTION_OUT), student: sStudent(row.student) } : null);

const INTERVENTION_OUT = [
  "id", "studentId", "interventionDate", "interventionType",
  "riskLevelAtIntervention", "progressionScoreAtIntervention",
  "attendanceAtIntervention", "recentAttendanceAtIntervention",
  "submissionRateAtIntervention", "averageGradeAtIntervention", "missingAtIntervention",
  "reviewDate", "status", "outcome", "reviewedAt", "reviewedBy",
  "notes", "createdBy", "createdAt", "studentReviewId",
];

const sIntervention = (row) => (row ? { ...pick(row, INTERVENTION_OUT), student: sStudent(row.student) } : null);

const STUDENT_SELECT = {
  id: true, firstName: true, lastName: true, studentRef: true, initials: true, colour: true, cohortId: true,
  cohort: { select: { name: true, course: { select: { name: true } } } },
};

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

// GET /settings — this college's configuration, plus the vocabulary the client needs
// to render it. The codes are served rather than duplicated in the client, so adding
// a red indicator does not need a matching edit in StaffHub.jsx to be visible.
router.get("/settings", async (_req, res) => {
  const [config, customised] = await Promise.all([settings.get(), settings.isCustomised()]);
  res.json({
    config,
    defaults: settings.DEFAULTS,
    customised,
    vocabulary: {
      weightKeys: settings.WEIGHT_KEYS,
      componentKeys: engine.COMPONENT_KEYS,
      redCodes: engine.RED_CODES,
      // Served rather than hardcoded client-side for the same reason the rest of this
      // block is: the client renders a code it does not recognise as the raw code, so
      // a screen that shipped before a code existed degrades to something readable
      // instead of rendering blank.
      tripwireCodes: tripwires.TRIP_CODES,
      attendanceModes: settings.ATTENDANCE_MODES,
      scopes: settings.SCOPES,
      gradeTrends: Object.values(engine.GRADE_TREND),
      interventionResponses: Object.values(engine.INTERVENTION_RESPONSE),
      directions: Object.values(engine.DIRECTION),
    },
  });
});

// PUT /settings — replace the configuration.
//
// Every stored score was produced under the OLD policy and is not comparable with one
// produced under the new one, so the whole college is marked stale. It is NOT
// rescored here: a save must not block on a cohort's worth of arithmetic, and an
// administrator nudging a weight would otherwise sit and watch a spinner.
router.put("/settings", async (req, res) => {
  // A MISSING config is refused rather than treated as an empty one.
  //
  // validate(undefined) legitimately answers "the platform defaults" — that is what a
  // college with no stored row is running on, and get() depends on it. But arriving
  // here, the same answer would mean a PUT with a malformed or truncated body
  // silently REPLACED a college's own model with the defaults and marked every score
  // in the institution stale, reporting 200. Resetting is a deliberate act and has
  // its own route: DELETE, below.
  const config = req.body && req.body.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return res.status(400).json({
      error: "No settings were sent. To return this college to the platform defaults, use Reset rather than saving an empty model.",
    });
  }

  const before = await settings.get();
  const result = await settings.save(config, req.user.email || req.user.id);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const staleCount = await runner.markAllStale();

  audit.record(req, {
    action: "prediction.settings.save",
    entity: "PredictionModelSettings",
    summary: `Updated the progression-risk model; ${staleCount} student score(s) marked for recalculation`,
    before, after: result.config,
  });

  res.json({ config: result.config, staleCount, recalculationRequired: staleCount > 0 });
});

// DELETE /settings — back to the platform defaults, which is what a college that has
// never touched this screen is already running on.
router.delete("/settings", async (req, res) => {
  const before = await settings.get();
  const result = await settings.save(null, req.user.email || req.user.id);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const staleCount = await runner.markAllStale();

  audit.record(req, {
    action: "prediction.settings.reset",
    entity: "PredictionModelSettings",
    summary: `Reset the progression-risk model to the platform defaults; ${staleCount} student score(s) marked for recalculation`,
    before, after: result.config,
  });

  res.json({ config: result.config, staleCount, reset: true });
});

/* -------------------------------------------------------------------------- */
/* The register                                                                */
/* -------------------------------------------------------------------------- */

// GET /summary — headcounts per band, for the top of the screen. Cheap: it groups in
// the database rather than reading every row.
router.get("/summary", async (_req, res) => {
  const config = await settings.get();

  const [byLevel, needing, staleCount, total, lastRow, submissionRows] = await Promise.all([
    prisma.studentPredictionCurrent.groupBy({ by: ["riskLevel"], _count: { _all: true } }),
    prisma.studentPredictionCurrent.count({ where: { interventionRequired: true } }),
    prisma.studentPredictionCurrent.count({ where: { stale: true } }),
    prisma.student.count({ where: { active: true } }),
    prisma.studentPredictionCurrent.findFirst({ orderBy: { lastCalculated: "desc" }, select: { lastCalculated: true } }),
    // Whether this college holds ANY record of work being handed in. Nothing writes
    // AssessmentSubmission yet — an AssessmentGrade appears only once work has been
    // MARKED, so a marking backlog is indistinguishable from a cohort that submitted
    // nothing, and the engine correctly refuses to guess. The consequence is that two
    // of the seven components (submission rate, on-time rate) and one override
    // (OVR-001) can measure nothing at all. That is safe — an unmeasurable component
    // is renormalised out rather than scored as zero — but it is NOT obvious, and a
    // college left to discover it would spend its time tuning weights that cannot
    // move anybody. So the screen is told, and says so.
    prisma.assessmentSubmission.count(),
  ]);

  const counts = Object.fromEntries(byLevel.map((r) => [r.riskLevel, r._count._all]));
  const scored = byLevel.reduce((t, r) => t + r._count._all, 0);

  res.json({
    // Every band, including the ones nobody is in — a band with no students is a
    // fact about the cohort, and hiding it makes the ladder look shorter than it is.
    bands: config.bands.map((b) => ({ ...b, count: counts[b.key] || 0 })),
    scored,
    activeStudents: total,
    // Named rather than derived in the client: a student with no score is not a
    // student at zero risk, and the screen has to be able to say which it is.
    notScored: Math.max(0, total - scored),
    interventionRequired: needing,
    staleCount,
    lastCalculated: lastRow ? lastRow.lastCalculated : null,
    modelVersion: config.modelVersion,
    // See the note above the count.
    submissionDataAvailable: submissionRows > 0,
    componentsUnmeasurable: submissionRows > 0 ? [] : ["submissionRate", "onTimeRate"],
  });
});

// GET /students — the risk register.
router.get("/students", async (req, res) => {
  const where = {};

  if (isString(req.query.riskLevel) && req.query.riskLevel) where.riskLevel = req.query.riskLevel;
  if (req.query.interventionRequired === "true") where.interventionRequired = true;
  if (isString(req.query.cohortId) && req.query.cohortId) where.student = { cohortId: req.query.cohortId };

  const deptFilter = studentDepartmentFilter(req.query.academicDepartmentId);
  if (Object.keys(deptFilter).length) where.student = { ...(where.student || {}), ...deptFilter };

  const q = isString(req.query.q) ? req.query.q.trim() : "";
  if (q) {
    where.student = {
      ...(where.student || {}),
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { studentRef: { contains: q, mode: "insensitive" } },
      ],
    };
  }

  const rows = await prisma.studentPredictionCurrent.findMany({
    where,
    // Worst first: this screen exists to be read from the top, and a member of staff
    // with ten minutes should spend them on the student in the most trouble.
    orderBy: [{ progressionScore: "asc" }],
    take: 500,
    include: { student: { select: STUDENT_SELECT } },
  });

  res.json({ students: rows.map(sPrediction), truncated: rows.length === 500 });
});

// GET /students/:id — one student, with the history behind the number and every
// intervention anybody has raised for them.
router.get("/students/:id", async (req, res) => {
  const [current, history, interventions] = await Promise.all([
    prisma.studentPredictionCurrent.findFirst({
      where: { studentId: req.params.id },
      include: { student: { select: STUDENT_SELECT } },
    }),
    prisma.studentPredictionHistory.findMany({
      where: { studentId: req.params.id },
      orderBy: { calculationDateTime: "desc" },
      take: 60,
    }),
    prisma.intervention.findMany({
      where: { studentId: req.params.id },
      orderBy: { interventionDate: "desc" },
    }),
  ]);

  if (!current) {
    // Deliberately distinguished from a 404 on the student themselves. "We have not
    // scored this person" and "this person does not exist" are different answers, and
    // the first one is the common case for a student who has only just enrolled.
    const student = await prisma.student.findUnique({ where: { id: req.params.id }, select: STUDENT_SELECT });
    if (!student) return res.status(404).json({ error: "Student not found" });
    return res.json({
      student: sStudent(student),
      prediction: null,
      reason: "No score yet — either this student has not been included in a recalculation, or there is not yet enough attendance or assessment data to score them.",
      history: [],
      interventions: interventions.map(sIntervention),
    });
  }

  res.json({
    student: sStudent(current.student),
    prediction: sPrediction(current),
    history: history.map((h) => ({ ...pick(h, PREDICTION_OUT), calculationDateTime: h.calculationDateTime })),
    interventions: interventions.map(sIntervention),
  });
});

/* -------------------------------------------------------------------------- */
/* Recalculation                                                               */
/* -------------------------------------------------------------------------- */

// POST /recalculate — score the students who need it.
//
// Bounded, and synchronous within that bound. There is no job queue in this product,
// and a route that fires an unbounded background task would have no way to report
// that it failed. `limit` caps the work so the request always returns; the response
// says how many are still outstanding so the screen can ask again.
router.post("/recalculate", async (req, res) => {
  const all = req.body && req.body.all === true;
  const limitRaw = Number(req.body && req.body.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 2000 ? limitRaw : 500;

  const summary = await runner.recalculate({ all, limit });

  // Outstanding = flagged stale PLUS never scored at all. Counting only `stale: true`
  // missed the larger half: on a first run at a big college the students past the
  // limit have no row of any kind, so they are not stale — they are nothing. The
  // screen would have been told 0 remaining, stopped asking, and left them off the
  // risk register entirely.
  const [staleRemaining, scoredRows, activeTotal] = await Promise.all([
    prisma.studentPredictionCurrent.count({ where: { stale: true } }),
    prisma.studentPredictionCurrent.count(),
    prisma.student.count({ where: { active: true } }),
  ]);
  const remaining = staleRemaining + Math.max(0, activeTotal - scoredRows);

  audit.record(req, {
    action: "prediction.recalculate",
    entity: "StudentPredictionCurrent",
    summary: `Recalculated ${summary.scored} progression score(s)` +
      (summary.insufficientData ? `; ${summary.insufficientData} student(s) had too little data to score` : ""),
  });

  res.json({ ...summary, remaining });
});

/* -------------------------------------------------------------------------- */
/* Interventions                                                               */
/* -------------------------------------------------------------------------- */

const INTERVENTION_TYPES = [
  "tutorial", "pastoral_meeting", "attendance_warning", "academic_support",
  "welfare_referral", "parent_guardian_contact", "attendance_contract", "other",
];

const OUTCOMES = ["improved", "no_change", "declined", "withdrawn", "other"];

// POST /interventions — record that somebody stepped in.
//
// The student's CURRENT metrics are snapshotted onto the row rather than read back
// later, because the question this table answers is "were they worse when we stepped
// in than they are now?", which is unanswerable if the numbers move underneath it.
/* -------------------------------------------------------------------------- */
/* Outcomes — what actually happened                                           */
/* -------------------------------------------------------------------------- */

// WHY THIS EXISTS AT ALL.
//
// Every weight in PredictionModelSettings is currently a judgement nobody can check.
// A college can say "attendance is worth 20% of the score" but not "and students the
// model called R5 withdrew four times as often as students it called R2", because
// nothing recorded whether they withdrew. These rows are what turns the first
// statement into the second — and they are the labels any future supervised model
// would train against.
//
// The outcome vocabulary is deliberately wider than "left or stayed". A transfer to
// another provider is a success for the student and a failure in any metric that
// cannot tell it from dropping out; an agreed interruption is neither; and voluntary
// versus academic withdrawal have different predictors, so a model trained on the two
// mixed together learns neither well.
const STUDENT_OUTCOMES = ["withdrawn", "progressed", "completed", "interrupted", "transferred"];

// "unknown" is a first-class member. A college that does not know why a student left
// should record that it does not know — the alternative is an administrator guessing
// under the pressure of a required field, and a guess stored as fact is worse than an
// admitted gap for exactly the training use this table exists to serve.
const STUDENT_OUTCOME_REASONS = ["voluntary", "academic", "financial", "personal", "visa", "unknown"];

const STUDENT_OUTCOME_OUT = [
  "id", "studentId", "outcome", "reason", "effectiveOn", "stage", "notes",
  "scoreAtOutcome", "riskLevelAtOutcome", "recordedBy", "createdAt",
];

const sOutcome = (row) => (row ? { ...pick(row, STUDENT_OUTCOME_OUT), student: sStudent(row.student) } : null);

// GET /outcomes — the record, newest first. Filterable by outcome so "show me every
// withdrawal this year" is one request.
router.get("/outcomes", async (req, res) => {
  const where = {};
  // Filtered HERE, not in the browser. The list is capped at 500 newest-first, so a
  // client-side filter silently loses a student's own outcome once a college passes
  // that many — and the record page would then say "no outcome recorded" about a
  // student who has one on file, which is worse than saying nothing.
  if (isString(req.query.studentId) && req.query.studentId) where.studentId = String(req.query.studentId);
  // An unrecognised value is refused rather than ignored: silently returning EVERY
  // outcome under a heading that says "withdrawals" is a wrong answer, not a broad one.
  if (req.query.outcome != null && req.query.outcome !== "") {
    if (!STUDENT_OUTCOMES.includes(String(req.query.outcome))) {
      return res.status(400).json({ error: `outcome must be one of: ${STUDENT_OUTCOMES.join(", ")}` });
    }
    where.outcome = String(req.query.outcome);
  }
  if (isRealDate(req.query.from)) where.effectiveOn = { ...(where.effectiveOn || {}), gte: String(req.query.from) };
  if (isRealDate(req.query.to)) where.effectiveOn = { ...(where.effectiveOn || {}), lte: String(req.query.to) };

  const outcomeDept = studentDepartmentFilter(req.query.academicDepartmentId);
  if (Object.keys(outcomeDept).length) where.student = outcomeDept;

  const rows = await prisma.studentOutcome.findMany({
    where,
    orderBy: [{ effectiveOn: "desc" }, { createdAt: "desc" }],
    take: 500,
    include: { student: { select: STUDENT_SELECT } },
  });
  res.json({ outcomes: rows.map(sOutcome), vocabulary: { outcomes: STUDENT_OUTCOMES, reasons: STUDENT_OUTCOME_REASONS } });
});

// POST /outcomes — record what happened.
router.post("/outcomes", async (req, res) => {
  const b = req.body || {};

  const student = await prisma.student.findUnique({ where: { id: String(b.studentId || "") } });
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (!STUDENT_OUTCOMES.includes(b.outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${STUDENT_OUTCOMES.join(", ")}` });
  }

  // A reason belongs to a withdrawal and to nothing else. Accepting one on a
  // completion would let "completed / academic" into the table, which reads as a
  // failure and would poison the very comparison this table exists to make.
  let reason = null;
  if (b.outcome === "withdrawn") {
    if (!STUDENT_OUTCOME_REASONS.includes(b.reason)) {
      return res.status(400).json({ error: `reason must be one of: ${STUDENT_OUTCOME_REASONS.join(", ")}` });
    }
    reason = b.reason;
  } else if (b.reason != null && b.reason !== "") {
    return res.status(400).json({ error: "reason applies only to a withdrawal." });
  }

  // The date the outcome TOOK EFFECT, not the date somebody typed it in. Those differ
  // by weeks in practice, and a model trained on the typing date learns when
  // administrators do their paperwork rather than when students leave.
  if (!isRealDate(b.effectiveOn)) {
    return res.status(400).json({ error: "effectiveOn must be a real date in YYYY-MM-DD form." });
  }
  // A mistyped year passes isRealDate and then sorts to the top of the list forever.
  // Outcomes are recorded after the fact, so a date in the future is always an error.
  if (b.effectiveOn > localDate()) {
    return res.status(400).json({ error: "effectiveOn cannot be in the future — record an outcome after it has happened." });
  }

  // The live score moves every time anything is recalculated. Freezing it here is what
  // keeps "what did the model say about this student at the time" answerable — without
  // it, comparing predictions against outcomes compares an outcome with a score that
  // has since absorbed the outcome's own consequences, which is circular.
  const current = await prisma.studentPredictionCurrent.findFirst({ where: { studentId: student.id } });

  const row = await prisma.studentOutcome.create({
    data: {
      studentId: student.id,
      outcome: b.outcome,
      reason,
      effectiveOn: b.effectiveOn,
      stage: isString(b.stage) ? b.stage.slice(0, 120) : null,
      notes: isString(b.notes) ? b.notes.slice(0, MAX_TEXT) : "",
      scoreAtOutcome: current ? current.progressionScore : null,
      riskLevelAtOutcome: current ? current.riskLevel : null,
      recordedBy: req.user ? req.user.name || req.user.email || null : null,
    },
    include: { student: { select: STUDENT_SELECT } },
  });

  // audit.record, NOT audit.log — there is no `log` export, and calling it threw
  // AFTER the row was created: Express does not catch async rejections here, so the
  // outcome was written, the client got no 201, and the process died. The summary
  // deliberately carries no student name, matching the intervention route beside it.
  audit.record(req, {
    action: "prediction.outcome.create",
    entity: "StudentOutcome",
    entityId: row.id,
    summary: `Recorded outcome: ${row.outcome}${row.reason ? ` (${row.reason})` : ""}`,
  });

  res.status(201).json({ outcome: sOutcome(row) });
});

// GET /outcomes/calibration — does the model actually predict what happened?
//
// The one endpoint in this feature that can EMBARRASS the model, which is the point.
// It buckets recorded outcomes by the risk level the student carried at the time, so
// a college can see whether its R5 students withdrew more than its R2 students. If
// they did not, the weights are wrong and this is the only screen that will say so.
//
// Deliberately raw counts and no percentage where the denominator is small: a
// withdrawal rate of "100%" drawn from one student is the kind of number that gets
// quoted in a meeting.
router.get("/outcomes/calibration", async (_req, res) => {
  const rows = await prisma.studentOutcome.findMany({
    select: { outcome: true, riskLevelAtOutcome: true },
  });

  const byBand = {};
  for (const r of rows) {
    // A student who was never scored has no band to attribute the outcome to. They are
    // counted separately rather than dropped, because a college whose withdrawals are
    // mostly unscored students has a coverage problem, and hiding them would hide it.
    const key = r.riskLevelAtOutcome || "UNSCORED";
    byBand[key] = byBand[key] || { total: 0, withdrawn: 0, progressed: 0, completed: 0, interrupted: 0, transferred: 0 };
    byBand[key].total += 1;
    if (byBand[key][r.outcome] !== undefined) byBand[key][r.outcome] += 1;
  }

  res.json({
    byBand,
    total: rows.length,
    // Said out loud so nobody reads a thin table as a verdict on the model.
    caveat: "Counts only. A band with few recorded outcomes says nothing about the model yet.",
  });
});

router.post("/interventions", async (req, res) => {
  const b = req.body || {};

  const student = await prisma.student.findUnique({ where: { id: String(b.studentId || "") } });
  if (!student) return res.status(404).json({ error: "Student not found" });

  if (!INTERVENTION_TYPES.includes(b.interventionType)) {
    return res.status(400).json({ error: `interventionType must be one of: ${INTERVENTION_TYPES.join(", ")}` });
  }

  const interventionDate = isRealDate(b.interventionDate) ? b.interventionDate : localDate();
  if (b.reviewDate != null && b.reviewDate !== "" && !isRealDate(b.reviewDate)) {
    return res.status(400).json({ error: "reviewDate must be a real date in YYYY-MM-DD form." });
  }
  const notes = isString(b.notes) ? b.notes.slice(0, MAX_TEXT) : "";

  const current = await prisma.studentPredictionCurrent.findFirst({ where: { studentId: student.id } });

  // An intervention can be raised for a student who has never been scored — staff
  // notice things the model has no data for. The snapshot is then zeroed rather than
  // invented, and the response comparison later simply has nothing to compare.
  const created = await prisma.intervention.create({
    data: {
      studentId: student.id,
      interventionDate,
      interventionType: b.interventionType,
      riskLevelAtIntervention: current ? current.riskLevel : "UNSCORED",
      // NULL, never 0, for anything that was not measured at the time.
      //
      // Zero is not a neutral baseline, it is an invention — and a one-directional
      // one. The engine compares today's figures against these, and against a zero
      // baseline every student looks enormously improved, so a student nobody had
      // ever measured would be recorded as having responded well to support. That
      // bias falls on exactly the students somebody was worried enough to intervene
      // on. Null means "no figure at the time", and the engine skips the comparison.
      progressionScoreAtIntervention: current ? current.progressionScore : null,
      attendanceAtIntervention: current ? current.overallAttendance : null,
      recentAttendanceAtIntervention: current ? current.recentAttendance : null,
      submissionRateAtIntervention: current ? current.submissionRate : null,
      averageGradeAtIntervention: current ? current.averageGrade : null,
      missingAtIntervention: current ? current.missingAssessmentCount : 0,
      reviewDate: b.reviewDate || null,
      notes,
      createdBy: req.user.email || req.user.id,
      studentReviewId: isString(b.studentReviewId) && b.studentReviewId ? b.studentReviewId : null,
    },
  });

  // The response to an intervention is one of the seven components, so the student's
  // score is now out of date.
  await runner.markStale([student.id]);

  // THE AUDIT LINE NAMES NO STUDENT, and that is deliberate.
  //
  // This router is gated on requirePage("prediction") precisely because a risk level
  // is a judgement about a named student. The audit trail is read on the Settings,
  // Access and Staff pages — AUDIT_PAGES in routes/audit.js — which is a DIFFERENT
  // and disjoint grant. Putting "welfare_referral for Jane Smith" in the summary
  // hands the whole safeguarding caseload to an administrator this page refuses.
  //
  // entityId is recorded, so anyone who legitimately holds the page can still resolve
  // the row. The trail keeps its purpose — who did what, when — without becoming a
  // second, less-guarded copy of the thing it describes.
  audit.record(req, {
    action: "prediction.intervention.create",
    entity: "Intervention",
    entityId: created.id,
    summary: `Raised a ${b.interventionType} intervention`,
  });

  res.status(201).json({ intervention: sIntervention(created) });
});

// GET /interventions — the caseload.
router.get("/interventions", async (req, res) => {
  const where = {};
  if (isString(req.query.status) && req.query.status) where.status = req.query.status;
  if (isString(req.query.studentId) && req.query.studentId) where.studentId = req.query.studentId;
  if (req.query.due === "true") where.AND = [{ status: "open" }, { reviewDate: { lte: localDate() } }];

  const interventionDept = studentDepartmentFilter(req.query.academicDepartmentId);
  if (Object.keys(interventionDept).length) where.student = interventionDept;

  const rows = await prisma.intervention.findMany({
    where,
    orderBy: [{ status: "asc" }, { interventionDate: "desc" }],
    take: 500,
    include: { student: { select: STUDENT_SELECT } },
  });

  res.json({ interventions: rows.map(sIntervention) });
});

// PUT /interventions/:id — review one, and record what happened.
//
// The metrics snapshot is NEVER rewritten here. It is the baseline the outcome is
// judged against, and a review that moved it would be marking its own homework.
router.put("/interventions/:id", async (req, res) => {
  const b = req.body || {};
  const existing = await prisma.intervention.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Intervention not found" });

  const data = {};

  if (b.status !== undefined) {
    if (!["open", "reviewed", "closed"].includes(b.status)) {
      return res.status(400).json({ error: "status must be one of: open, reviewed, closed" });
    }
    data.status = b.status;
  }

  if (b.outcome !== undefined && b.outcome !== null && b.outcome !== "") {
    // The INTERVENTION review vocabulary (improved / no_change / declined / ...), not
    // the student-outcome one. The two are different questions that happen to share a
    // word: "how did this student respond to what we did" versus "what became of them".
    if (!OUTCOMES.includes(b.outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(", ")}` });
    }
    data.outcome = b.outcome;
    data.reviewedAt = new Date();
    data.reviewedBy = req.user.email || req.user.id;
  }

  if (b.reviewDate !== undefined) {
    if (b.reviewDate !== null && b.reviewDate !== "" && !isRealDate(b.reviewDate)) {
      return res.status(400).json({ error: "reviewDate must be a real date in YYYY-MM-DD form." });
    }
    data.reviewDate = b.reviewDate || null;
  }

  if (b.notes !== undefined) data.notes = isString(b.notes) ? b.notes.slice(0, MAX_TEXT) : "";

  if (!Object.keys(data).length) return res.status(400).json({ error: "Nothing to update." });

  const updated = await prisma.intervention.update({ where: { id: existing.id }, data });

  // Closing an intervention removes it from the response comparison, so the score
  // changes even though nothing about the student did.
  await runner.markStale([existing.studentId]);

  // WHICH fields moved is recorded; what they now SAY is not.
  //
  // before/after here were whole Intervention rows, and `notes` is free-text pastoral
  // commentary. audit.js redacts SECRET_FIELDS, which is a list of credential names —
  // none of this is a secret, it is simply personal, so nothing there caught it and
  // up to 500 characters per side reached a log read under a different grant.
  //
  // changedKeys() exists for exactly this, and studentReviews.js, admissions.js,
  // ism.js and interactions.js all use it the same way.
  audit.record(req, {
    action: "prediction.intervention.update",
    entity: "Intervention",
    entityId: existing.id,
    summary: `Updated an intervention (${Object.keys(data).join(", ")})`,
    after: { fieldsChanged: audit.changedKeys(existing, updated) },
  });

  res.json({ intervention: sIntervention(updated) });
});

module.exports = router;
