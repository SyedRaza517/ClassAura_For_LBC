// Student Loans Company (SLC) tracking — a record per student of whether they've applied
// for a student loan and the current status of the application. Gated on the "slc" admin
// page. Standalone rows (all details on the row), with an optional admissionId link so a
// record can be pre-filled from an applicant.
const router = require("express").Router();
const prisma = require("../db");
const audit = require("../audit");
const { localDate } = require("../clock");
const predictionRunner = require("../prediction/runner");
const { requireAuth, requirePage } = require("../auth");

router.use(requireAuth, requirePage("slc"));

// Allowed values — mirrored on the client. Anything else falls back to a safe default.
const STATUSES = ["Not applied", "Applied", "Awaiting evidence", "Approved", "In payment", "Paid", "Declined", "Cancelled"];
const LOAN_TYPES = ["", "Tuition Fee Loan", "Maintenance Loan", "Both", "Other"];

const str = (v) => String(v == null ? "" : v).trim();
const dateOrNull = (v) => { const t = str(v); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null; };

// Whitelist + sanitise the writable fields from a request body.
function pick(b, user) {
  return {
    studentName: str(b.studentName).slice(0, 200),
    studentRef: str(b.studentRef).slice(0, 100),
    course: str(b.course).slice(0, 300),
    intake: str(b.intake).slice(0, 100),
    status: STATUSES.includes(str(b.status)) ? str(b.status) : "Not applied",
    loanType: LOAN_TYPES.includes(str(b.loanType)) ? str(b.loanType) : "",
    crn: str(b.crn).slice(0, 100),
    applicationDate: dateOrNull(b.applicationDate),
    decisionDate: dateOrNull(b.decisionDate),
    amount: str(b.amount).slice(0, 60),
    notes: str(b.notes).slice(0, 5000),
    admissionId: str(b.admissionId) || null,
    updatedBy: (user && (user.name || user.email)) || null,
  };
}

// WHAT LEAVES THE BUILDING. An allowlist, never a blocklist — CLAUDE.md records that
// sAdmission once stripped a fixed list of secrets, so every column added afterwards
// shipped to the browser by default. This route was returning raw Prisma rows, which is
// that failure in its purest form, on a table holding loan status and CRNs: the four
// columns added to this model recently (studentId, studentLinkSource, studentLinkedAt,
// statusChangedOn) all began shipping without anyone deciding they should.
const sSlc = (a) => ({
  id: a.id,
  studentId: a.studentId,
  studentName: a.studentName,
  studentRef: a.studentRef,
  course: a.course,
  intake: a.intake,
  status: a.status,
  statusChangedOn: a.statusChangedOn,
  loanType: a.loanType,
  crn: a.crn,
  applicationDate: a.applicationDate,
  decisionDate: a.decisionDate,
  amount: a.amount,
  notes: a.notes,
  admissionId: a.admissionId,
  updatedBy: a.updatedBy,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

router.get("/", async (_req, res) => {
  const rows = await prisma.slcApplication.findMany({ orderBy: [{ updatedAt: "desc" }] });
  res.json(rows.map(sSlc));
});

router.post("/", async (req, res) => {
  const data = pick(req.body || {}, req.user);
  if (!data.studentName) return res.status(400).json({ error: "A student name is required." });
  // WHEN THIS STATUS BECAME TRUE, which is the anchor the funding signals measure a
  // stall from. The column existed and nothing ever wrote it, so it was null on every
  // row and prediction/funding.js had to fall back to applicationDate — which measures
  // time in the PIPELINE rather than time in THIS STATE, and is why that fallback
  // carries a much longer threshold. Writing it here is what lets the stronger anchor
  // start being true for rows created from now on.
  //
  // The college's own date, never the host clock (see clock.js).
  const row = await prisma.slcApplication.create({ data: { ...data, statusChangedOn: localDate() } });
  audit.record(req, {
    action: "slc.created", entity: "SlcApplication", entityId: row.id,
    summary: `Student finance record created for ${row.studentName} — ${row.status}`,
    after: { studentName: row.studentName, status: row.status, admissionId: row.admissionId },
  });
  res.status(201).json(sSlc(row));
});

router.put("/:id", async (req, res) => {
  const data = pick(req.body || {}, req.user);
  if (!data.studentName) return res.status(400).json({ error: "A student name is required." });
  const existing = await prisma.slcApplication.findUnique({ where: { id: req.params.id } });
  try {
    // ONLY WHEN THE STATUS ACTUALLY MOVED. Stamping it on every save would turn "how
    // long has this been sitting at Awaiting evidence" into "when did somebody last
    // open the record and correct a typo", and the figure would look freshest for
    // exactly the claims being fussed over rather than the ones nobody has touched.
    // The comparison is the same one the audit summary below already makes.
    const statusMoved = Boolean(existing) && existing.status !== data.status;
    const row = await prisma.slcApplication.update({
      where: { id: req.params.id },
      data: statusMoved ? { ...data, statusChangedOn: localDate() } : data,
    });

    // A funding decision changes what the prediction layer can say about this student,
    // in both directions -- an approval settles a stall, a refusal opens one. Guarded on
    // the link because nothing populates studentId yet: until the backfill runs, every
    // row here is unattached to a Student and there is nobody to flag.
    if (row.studentId) {
      try { await predictionRunner.markStale([row.studentId]); } catch { /* scoring is not this route's job to guarantee */ }
    }
    // The status is the substance: whether a student's funding has been applied for,
    // approved or refused decides whether they can enrol and be charged.
    audit.record(req, {
      action: "slc.updated", entity: "SlcApplication", entityId: row.id,
      summary: `Student finance record for ${row.studentName} updated` + (existing && existing.status !== row.status ? ` — status changed from ${existing.status} to ${row.status}` : ""),
      before: existing ? { studentName: existing.studentName, status: existing.status, admissionId: existing.admissionId } : null,
      after: { studentName: row.studentName, status: row.status, admissionId: row.admissionId },
    });
    res.json(sSlc(row));
  } catch (_) { res.status(404).json({ error: "Record not found." }); }
});

router.delete("/:id", async (req, res) => {
  const existing = await prisma.slcApplication.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Record not found." });
  try {
    await prisma.slcApplication.delete({ where: { id: existing.id } });
    audit.record(req, {
      action: "slc.deleted", entity: "SlcApplication", entityId: existing.id,
      summary: `Student finance record for ${existing.studentName} deleted — it stood at ${existing.status}`,
      before: { studentName: existing.studentName, status: existing.status, admissionId: existing.admissionId },
      after: null,
    });
    res.json({ ok: true });
  }
  catch (_) { res.status(404).json({ error: "Record not found." }); }
});

module.exports = router;
