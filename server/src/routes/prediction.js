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

router.use(requireAuth, requirePage("prediction"));

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
  const remaining = await prisma.studentPredictionCurrent.count({ where: { stale: true } });

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
      progressionScoreAtIntervention: current ? current.progressionScore : 0,
      attendanceAtIntervention: current && current.overallAttendance != null ? current.overallAttendance : 0,
      recentAttendanceAtIntervention: current && current.recentAttendance != null ? current.recentAttendance : 0,
      submissionRateAtIntervention: current && current.submissionRate != null ? current.submissionRate : 0,
      averageGradeAtIntervention: current && current.averageGrade != null ? current.averageGrade : 0,
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

  audit.record(req, {
    action: "prediction.intervention.create",
    entity: "Intervention",
    entityId: created.id,
    summary: `Raised a ${b.interventionType} intervention for ${student.firstName} ${student.lastName}`,
  });

  res.status(201).json({ intervention: sIntervention(created) });
});

// GET /interventions — the caseload.
router.get("/interventions", async (req, res) => {
  const where = {};
  if (isString(req.query.status) && req.query.status) where.status = req.query.status;
  if (isString(req.query.studentId) && req.query.studentId) where.studentId = req.query.studentId;
  if (req.query.due === "true") where.AND = [{ status: "open" }, { reviewDate: { lte: localDate() } }];

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

  audit.record(req, {
    action: "prediction.intervention.update",
    entity: "Intervention",
    entityId: existing.id,
    summary: `Updated an intervention (${Object.keys(data).join(", ")})`,
    before: existing, after: updated,
  });

  res.json({ intervention: sIntervention(updated) });
});

module.exports = router;
