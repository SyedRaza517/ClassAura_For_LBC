// Mitigating circumstances — recording that the college agreed to take something into
// account, and what it agreed to change.
//
// WHY THIS EXISTS. TRIP_CHRONIC_LATE is live: moodle.js populates
// AssessmentGrade.submittedAt from gradedatesubmitted and metrics.js compares it against
// the assessment's own dueDate. Nothing recorded that an extension had been granted, so
// the comparison used the only date it had — the original. The college was reporting a
// student as chronically late for using an accommodation the college itself granted them.
//
// SPECIAL CATEGORY DATA, AND THE ROUTE IS SHAPED AROUND IT.
//
// A claim is usually health data: illness, mental health, bereavement, pregnancy, a
// caring responsibility. Article 9 data, collected for student support and not for
// building a risk score. Three consequences visible in this file:
//
//   1. Its own admin page. Access is `requirePage("mitigations")`, not the general
//      student pages, so a college can grant "see the risk register" without also
//      granting "read why each student is on it".
//   2. The audit trail records the FACT of a decision and never the category or the
//      detail. interactions.js already does this for pastoral notes and says why: the
//      audit log is read on Settings and Staff by admins who were never granted this
//      page, so writing the category there would route health data straight past the
//      access control this page exists to apply.
//   3. What the prediction pipeline may read is narrower still — status, the window,
//      coversAttendance and the adjustments. Never the category, never the detail. That
//      line is enforced by the select in metrics.js and asserted by a test.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { isString, isRealDate, MAX_TEXT } = require("../validate");
const { localDate } = require("../clock");
const settings = require("../prediction/settings");
const predictionRunner = require("../prediction/runner");
const audit = require("../audit");

router.use(requireAuth, requirePage("mitigations"));

// Validated in the route layer rather than by a Prisma enum, matching the rest of this
// schema. "other" exists so a college is never forced to file a circumstance under a
// category that misdescribes it, and null exists so it is never forced to pick one at
// all — a claim can be decided without the reason ever being categorised.
const CATEGORIES = [
  "illness", "mental-health", "bereavement", "caring", "financial",
  "accident", "victim-of-crime", "pregnancy-maternity", "other",
];
const STATUSES = ["open", "approved", "rejected", "withdrawn"];
const ADJUSTMENT_TYPES = ["extension", "exclusion"];

const str = (v) => (typeof v === "string" ? v.trim() : "");

// Day arithmetic on YYYY-MM-DD strings. Dates are strings throughout this codebase and
// compared as strings; this is the one place a DURATION between two of them is needed, so
// the conversion is local and does not leak a Date object anywhere else.
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// WHAT LEAVES THE BUILDING. An allowlist, never a blocklist — sAdmission once stripped a
// fixed list of secrets and every column added afterwards shipped to the browser by
// default. A field added to this model in future is invisible here until somebody adds
// it deliberately.
const sMitigation = (m) => ({
  id: m.id,
  studentId: m.studentId,
  status: m.status,
  coversFrom: m.coversFrom,
  coversTo: m.coversTo,
  coversAttendance: m.coversAttendance,
  category: m.category,
  detail: m.detail,
  raisedOn: m.raisedOn,
  decidedOn: m.decidedOn,
  decidedBy: m.decidedBy,
  decisionNote: m.decisionNote,
  createdBy: m.createdBy,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  student: m.student
    ? { id: m.student.id, firstName: m.student.firstName, lastName: m.student.lastName, studentRef: m.student.studentRef }
    : undefined,
  adjustments: (m.adjustments || []).map((a) => ({
    id: a.id,
    assessmentId: a.assessmentId,
    adjustmentType: a.adjustmentType,
    revisedDueDate: a.revisedDueDate,
    assessment: a.assessment
      ? { id: a.assessment.id, title: a.assessment.title, dueDate: a.assessment.dueDate }
      : undefined,
  })),
});

// The audit summary. NAMES THE STUDENT AND THE DECISION, NEVER THE REASON. A summary
// reading "bereavement claim approved for J Smith" would put a death in the family on the
// Settings page of every admin in the college.
const label = (row, student) => {
  const s = student || row.student;
  const who = s ? `${s.firstName} ${s.lastName} (${s.studentRef})` : "a student";
  return `Mitigating circumstances for ${who}`;
};

const withRelations = {
  student: { select: { id: true, firstName: true, lastName: true, studentRef: true } },
  adjustments: {
    include: { assessment: { select: { id: true, title: true, dueDate: true } } },
    orderBy: { createdAt: "asc" },
  },
};

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

router.get("/", async (req, res) => {
  const where = {};
  if (isString(req.query.studentId) && req.query.studentId) where.studentId = req.query.studentId;
  if (isString(req.query.status) && req.query.status) {
    if (!STATUSES.includes(req.query.status)) return res.status(400).json({ error: "Unknown status." });
    where.status = req.query.status;
  }
  const rows = await prisma.mitigatingCircumstance.findMany({
    where,
    include: withRelations,
    orderBy: [{ raisedOn: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  res.json(rows.map(sMitigation));
});

router.get("/:id", async (req, res) => {
  const row = await prisma.mitigatingCircumstance.findUnique({
    where: { id: req.params.id }, include: withRelations,
  });
  if (!row) return res.status(404).json({ error: "Not found." });
  res.json(sMitigation(row));
});

/* -------------------------------------------------------------------------- */
/* Validation shared by create and edit                                        */
/* -------------------------------------------------------------------------- */

async function validateWindow(body, cfg) {
  const coversFrom = str(body.coversFrom);
  const coversTo = str(body.coversTo);

  if (!isRealDate(coversFrom) || !isRealDate(coversTo)) {
    return { error: "The covered period needs a real start and end date (YYYY-MM-DD)." };
  }
  // Inclusive at both ends, so a single-day claim has coversFrom === coversTo. Ordering
  // is checked because a reversed window matches NOTHING — every comparison in
  // adjustments.js is `date >= from && date <= to` — so it would be stored, displayed as
  // though it protected the student, and silently cover nobody.
  if (coversTo < coversFrom) {
    return { error: "The covered period ends before it starts, which would cover nothing at all." };
  }

  // CAPPED. An unbounded window is a permanent suppression, and a permanent suppression
  // is indistinguishable from the student having been taken off the risk register
  // altogether. A college that needs longer — a year out for treatment — should record an
  // interruption on StudentOutcome, which is the table for exactly that, rather than a
  // claim that quietly mutes every signal for twelve months.
  const span = daysBetween(coversFrom, coversTo) + 1;
  if (span > cfg.mitigationWindowMaxDays) {
    return {
      error: `That covers ${span} days. The longest a single claim may cover is ${cfg.mitigationWindowMaxDays}, ` +
        `because a claim suppresses signals for as long as it runs and an open-ended one is indistinguishable ` +
        `from taking the student off the risk register. A longer absence should be recorded as an interruption instead.`,
    };
  }
  return { coversFrom, coversTo };
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

router.post("/", async (req, res) => {
  const b = req.body || {};
  const studentId = str(b.studentId);
  if (!studentId) return res.status(400).json({ error: "A claim needs a student." });

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { id: true, firstName: true, lastName: true, studentRef: true },
  });
  if (!student) return res.status(404).json({ error: "Student not found." });

  const cfg = await settings.get();
  const win = await validateWindow(b, cfg);
  if (win.error) return res.status(400).json({ error: win.error });

  // WHEN THE STUDENT RAISED IT, not when an administrator typed it in. Those differ by
  // days or weeks in practice, and the gap between them IS the college's response time —
  // the figure a college most needs and is least likely to record if the field defaults
  // to today without anyone noticing.
  const raisedOn = str(b.raisedOn) || localDate();
  if (!isRealDate(raisedOn)) return res.status(400).json({ error: "The date raised must be a real date." });

  const category = str(b.category);
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Unknown category." });
  }
  const detail = str(b.detail).slice(0, MAX_TEXT);

  const row = await prisma.mitigatingCircumstance.create({
    data: {
      studentId,
      status: "open",
      coversFrom: win.coversFrom,
      coversTo: win.coversTo,
      coversAttendance: b.coversAttendance === true,
      category: category || null,
      detail,
      raisedOn,
      createdBy: req.user ? req.user.name || req.user.id : null,
    },
    include: withRelations,
  });

  // The score this student carries is now wrong in the student's favour or against it,
  // and either way it is out of date. Flagging is cheap; the runner picks it up.
  try { await predictionRunner.markStale([studentId]); } catch { /* scoring is not this route's job to guarantee */ }

  // NO CATEGORY, NO DETAIL. See the note on `label`.
  audit.record(req, {
    action: "mitigation.created", entity: "MitigatingCircumstance", entityId: row.id,
    summary: `${label(row, student)} raised, covering ${row.coversFrom} to ${row.coversTo}`,
    after: {
      studentId, status: row.status, coversFrom: row.coversFrom, coversTo: row.coversTo,
      coversAttendance: row.coversAttendance, raisedOn: row.raisedOn,
    },
  });

  res.status(201).json(sMitigation(row));
});

/* -------------------------------------------------------------------------- */
/* Decide, or correct                                                          */
/* -------------------------------------------------------------------------- */

router.patch("/:id", async (req, res) => {
  const b = req.body || {};
  const existing = await prisma.mitigatingCircumstance.findUnique({
    where: { id: req.params.id }, include: withRelations,
  });
  if (!existing) return res.status(404).json({ error: "Not found." });

  const data = {};
  const cfg = await settings.get();

  if (b.coversFrom !== undefined || b.coversTo !== undefined) {
    const win = await validateWindow(
      { coversFrom: b.coversFrom !== undefined ? b.coversFrom : existing.coversFrom,
        coversTo: b.coversTo !== undefined ? b.coversTo : existing.coversTo },
      cfg,
    );
    if (win.error) return res.status(400).json({ error: win.error });
    data.coversFrom = win.coversFrom;
    data.coversTo = win.coversTo;
  }

  if (b.category !== undefined) {
    const category = str(b.category);
    if (category && !CATEGORIES.includes(category)) return res.status(400).json({ error: "Unknown category." });
    data.category = category || null;
  }
  if (b.detail !== undefined) data.detail = str(b.detail).slice(0, MAX_TEXT);
  if (b.coversAttendance !== undefined) data.coversAttendance = b.coversAttendance === true;
  if (b.decisionNote !== undefined) data.decisionNote = str(b.decisionNote).slice(0, MAX_TEXT);

  let decided = false;
  if (b.status !== undefined) {
    const status = str(b.status);
    if (!STATUSES.includes(status)) return res.status(400).json({ error: "Unknown status." });
    data.status = status;

    // A DECISION IS DATED AND ATTRIBUTED, or it is not a decision. An approval with
    // nobody's name on it cannot be explained to a student who asks why, and this is
    // exactly the record an appeal turns on.
    if (status !== existing.status && (status === "approved" || status === "rejected")) {
      data.decidedOn = str(b.decidedOn) || localDate();
      if (!isRealDate(data.decidedOn)) return res.status(400).json({ error: "The decision date must be a real date." });
      data.decidedBy = req.user ? req.user.name || req.user.id : null;
      decided = true;
    }
    // Reopening clears the decision rather than leaving a stale approver's name on a
    // claim that is undecided again. A retraction that leaves the old fields in place is
    // how the audit trail comes to say two contradictory things at once.
    if (status === "open" && existing.status !== "open") {
      data.decidedOn = null;
      data.decidedBy = null;
    }
  }

  if (!Object.keys(data).length) return res.json(sMitigation(existing));

  let row;
  try {
    row = await prisma.mitigatingCircumstance.update({
      where: { id: existing.id }, data, include: withRelations,
    });
  } catch (e) {
    // Two admins on the same claim: one deletes while the other saves.
    if (e && e.code === "P2025") return res.status(404).json({ error: "Not found." });
    throw e;
  }

  // Deciding a claim changes what the engine may suppress, in EITHER direction — an
  // approval starts cover, a rejection ends it. Both must re-score, which is what makes
  // the "undecided suppresses" default safe: the suppression cannot outlive the decision.
  try { await predictionRunner.markStale([row.studentId]); } catch { /* not this route's job to guarantee */ }

  audit.record(req, {
    action: decided ? "mitigation.decided" : "mitigation.updated",
    entity: "MitigatingCircumstance", entityId: row.id,
    summary: decided
      ? `${label(row)} ${row.status} by ${row.decidedBy || "an administrator"}`
      : `${label(row)} edited`,
    after: {
      status: row.status, coversFrom: row.coversFrom, coversTo: row.coversTo,
      coversAttendance: row.coversAttendance, decidedOn: row.decidedOn, decidedBy: row.decidedBy,
      fieldsChanged: audit.changedKeys(existing, { ...existing, ...data }),
    },
  });

  res.json(sMitigation(row));
});

/* -------------------------------------------------------------------------- */
/* Adjustments — what the claim actually changed                               */
/* -------------------------------------------------------------------------- */

router.post("/:id/adjustments", async (req, res) => {
  const b = req.body || {};
  const claim = await prisma.mitigatingCircumstance.findUnique({ where: { id: req.params.id } });
  if (!claim) return res.status(404).json({ error: "Not found." });

  const adjustmentType = str(b.adjustmentType);
  if (!ADJUSTMENT_TYPES.includes(adjustmentType)) {
    return res.status(400).json({ error: "An adjustment is either an extension or an exclusion." });
  }

  const assessmentId = str(b.assessmentId);
  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId }, select: { id: true, title: true, dueDate: true },
  });
  if (!assessment) return res.status(404).json({ error: "Assessment not found." });

  let revisedDueDate = null;
  if (adjustmentType === "extension") {
    revisedDueDate = str(b.revisedDueDate);
    if (!isRealDate(revisedDueDate)) {
      return res.status(400).json({ error: "An extension needs the new deadline (YYYY-MM-DD)." });
    }
    // AN EXTENSION THAT MOVES A DEADLINE EARLIER IS REFUSED. Accepting it would turn this
    // table into a way of manufacturing lateness — the exact harm this feature exists to
    // undo, pointed the other way. adjustments.js ignores such a date as well, so a row
    // that somehow got past this check could still only ever be harmless; the belt and
    // the braces are both deliberate.
    if (assessment.dueDate && revisedDueDate < assessment.dueDate) {
      return res.status(400).json({
        error: `That is earlier than the original deadline (${assessment.dueDate}). An extension can only move a deadline later.`,
      });
    }
  }

  let row;
  try {
    row = await prisma.assessmentAdjustment.create({
      data: {
        circumstanceId: claim.id, assessmentId: assessment.id, adjustmentType, revisedDueDate,
        createdBy: req.user ? req.user.name || req.user.id : null,
      },
    });
  } catch (e) {
    // One adjustment per assessment per claim. Two claims may still both touch the same
    // assessment — an illness and a bereavement in one term — and adjustments.js resolves
    // that by taking the most generous.
    if (e && e.code === "P2002") {
      return res.status(409).json({ error: "This claim already carries an adjustment for that assessment." });
    }
    throw e;
  }

  try { await predictionRunner.markStale([claim.studentId]); } catch { /* not this route's job */ }

  audit.record(req, {
    action: "mitigation.adjustment.added", entity: "AssessmentAdjustment", entityId: row.id,
    summary: `${adjustmentType === "exclusion" ? "Exclusion" : "Extension"} recorded for "${assessment.title}"`,
    after: { circumstanceId: claim.id, assessmentId: assessment.id, adjustmentType, revisedDueDate },
  });

  const full = await prisma.mitigatingCircumstance.findUnique({ where: { id: claim.id }, include: withRelations });
  res.status(201).json(sMitigation(full));
});

router.delete("/:id/adjustments/:adjustmentId", async (req, res) => {
  const row = await prisma.assessmentAdjustment.findUnique({
    where: { id: req.params.adjustmentId },
    include: { circumstance: { select: { id: true, studentId: true } }, assessment: { select: { title: true } } },
  });
  // Checked against the claim in the path as well as its own id: an adjustment id alone
  // would let a caller delete a row belonging to a different claim by guessing.
  if (!row || !row.circumstance || row.circumstance.id !== req.params.id) {
    return res.status(404).json({ error: "Not found." });
  }

  await prisma.assessmentAdjustment.delete({ where: { id: row.id } });
  try { await predictionRunner.markStale([row.circumstance.studentId]); } catch { /* not this route's job */ }

  audit.record(req, {
    action: "mitigation.adjustment.removed", entity: "AssessmentAdjustment", entityId: row.id,
    summary: `Adjustment removed from "${row.assessment ? row.assessment.title : "an assessment"}"`,
    before: { circumstanceId: row.circumstance.id, assessmentId: row.assessmentId, adjustmentType: row.adjustmentType },
  });

  const full = await prisma.mitigatingCircumstance.findUnique({ where: { id: req.params.id }, include: withRelations });
  res.json(sMitigation(full));
});

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

// WITHDRAWING IS USUALLY RIGHT AND DELETING USUALLY IS NOT. A withdrawn claim keeps the
// record that a student asked and later did not pursue it, which is the fact an appeal
// turns on; a deleted one leaves the college unable to show it ever received anything.
// Deletion stays available for a row entered against the wrong student — a real and
// urgent case, since that is somebody else's health data on the wrong record.
router.delete("/:id", async (req, res) => {
  const row = await prisma.mitigatingCircumstance.findUnique({
    where: { id: req.params.id },
    include: { student: { select: { id: true, firstName: true, lastName: true, studentRef: true } } },
  });
  if (!row) return res.status(404).json({ error: "Not found." });

  await prisma.mitigatingCircumstance.delete({ where: { id: row.id } });
  try { await predictionRunner.markStale([row.studentId]); } catch { /* not this route's job */ }

  audit.record(req, {
    action: "mitigation.deleted", entity: "MitigatingCircumstance", entityId: row.id,
    summary: `${label(row)} deleted`,
    before: { studentId: row.studentId, status: row.status, coversFrom: row.coversFrom, coversTo: row.coversTo },
  });

  res.json({ ok: true });
});

module.exports = router;
