// ISM — Intention to Study Meeting, the admission interview record.
//
// One row per meeting. Each ISM is usually LINKED to an applicant (admissionId,
// nullable — an interview can be recorded before the paper application is entered).
// The "Admitted?" answer is MIRRORED onto the linked Admission's ismOutcome column
// so the Admissions list can show the outcome without joining. All answers are free
// text so the interview form can evolve without a migration. The whole router is
// gated on the "ism" admin page.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const audit = require("../audit");

router.use(requireAuth, requirePage("ism"));

const str = (v) => (typeof v === "string" ? v.trim() : "");

// The ISM answers an admin may write. Everything else on the row (id, admissionId,
// interviewerName, timestamps) is set by the server, never copied off the body.
const FIELDS = [
  "name", "courseUnderstanding", "lastStudied", "independentLearning", "educationExperience",
  "strengthsWeaknesses", "prioritiseWorkload", "working", "teamworkExample", "wifiAccess",
  "officeSkills", "admitted", "interviewDate",
];

// Copy ONLY the whitelisted fields off the body, trimmed; empty -> null; capped so a
// pasted essay can't bloat a row. admissionId is handled separately (it's an id, not text).
const pick = (body) => {
  const b = body || {};
  const data = {};
  for (const f of FIELDS) data[f] = str(b[f]).slice(0, 5000) || null;
  return data;
};

// The applicant's outcome = the "Admitted?" answer of their most-recent ISM (or null if
// they have none left). Called after any create/update/delete that touches a link.
async function mirrorOutcome(admissionId) {
  if (!admissionId) return;
  const latest = await prisma.ism.findFirst({ where: { admissionId }, orderBy: { createdAt: "desc" } });
  // The admission may have been deleted (the link is SetNull), so this update can miss —
  // swallow the "record not found" (P2025) rather than 500 the whole request.
  try {
    await prisma.admission.update({ where: { id: admissionId }, data: { ismOutcome: latest?.admitted || null } });
  } catch (e) {
    // P2025 ONLY, which is what the comment above always claimed. A bare `catch (_) {}`
    // swallowed everything, so a genuine write failure left `ismOutcome` holding the
    // PREVIOUS interview verdict — silently, while the interview record itself said
    // something else. That value is what the applicant portal shows and what the
    // admissions funnel counts as an interview outcome, so the two screens disagree
    // about whether somebody was admitted and nothing anywhere says why.
    //
    // A missing row is ordinary here (the link is SetNull, so the admission may have
    // been deleted). Anything else is a real failure and belongs to the caller.
    if (e?.code !== "P2025") throw e;
  }
}

// The applicant picker for the ISM form — a light list of admissions to link against.
// MUST come before the "/:id" routes so "roster" isn't read as an id.
router.get("/roster", async (_req, res) => {
  const rows = await prisma.admission.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, firstName: true, surname: true, course: true, intake: true },
  });
  res.json(rows.map((a) => ({
    id: a.id,
    name: [a.firstName, a.surname].filter(Boolean).join(" ").trim(),
    course: a.course,
    intake: a.intake,
  })));
});

// All ISM records, newest first (an admin works the top of the pile). Each row carries a
// convenient `applicant` derived from the linked admission, or null when unlinked.
router.get("/", async (_req, res) => {
  const rows = await prisma.ism.findMany({
    orderBy: { createdAt: "desc" },
    include: { admission: { select: { id: true, firstName: true, surname: true, course: true } } },
  });
  res.json(rows.map((r) => ({
    ...r,
    applicant: r.admission
      ? { id: r.admission.id, name: [r.admission.firstName, r.admission.surname].filter(Boolean).join(" ").trim(), course: r.admission.course }
      : null,
  })));
});

router.post("/", async (req, res) => {
  const data = pick(req.body);
  data.admissionId = (typeof req.body?.admissionId === "string" && req.body.admissionId) ? req.body.admissionId : null;
  // We need SOMETHING to identify the meeting in the list — a name, or a linked applicant
  // we can read a name off. Require at least one rather than the whole form.
  if (!data.name && !data.admissionId) {
    return res.status(400).json({ error: "An ISM needs a name or a linked applicant." });
  }
  data.interviewerName = req.user?.name || req.user?.email || null;
  const row = await prisma.ism.create({ data });
  await mirrorOutcome(row.admissionId);
  // The interview decision, not the interview notes. "Admitted?" is mirrored onto the
  // linked application, so this row is a decision about whether someone gets a place.
  audit.record(req, {
    action: "ism.created", entity: "Ism", entityId: row.id,
    summary: `ISM recorded for ${row.name || "a linked applicant"} by ${row.interviewerName || "an interviewer"}` + (row.admitted ? ` — admitted: ${row.admitted}` : ""),
    after: { name: row.name, admissionId: row.admissionId, admitted: row.admitted, interviewDate: row.interviewDate, interviewerName: row.interviewerName },
  });
  res.status(201).json(row);
});

router.put("/:id", async (req, res) => {
  const existing = await prisma.ism.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "ISM not found." });
  const data = pick(req.body);
  // Allow re-linking or unlinking the applicant, but ONLY when the caller actually sent the
  // key — an omitted admissionId must leave the existing link intact, not silently null it.
  if (req.body && "admissionId" in req.body) data.admissionId = (typeof req.body.admissionId === "string" && req.body.admissionId) ? req.body.admissionId : null;
  // Backfill the interviewer for rows recorded before we captured it; otherwise leave it.
  if (!str(existing.interviewerName)) data.interviewerName = req.user?.name || req.user?.email || null;
  const row = await prisma.ism.update({ where: { id: req.params.id }, data });
  // The link may have moved, so refresh the outcome on BOTH the old and new applicant.
  await mirrorOutcome(existing.admissionId);
  await mirrorOutcome(row.admissionId);
  // Field names for the free-text answers (see audit.changedKeys), but the outcome
  // and the applicant link in full: changing either moves a decision on somebody's
  // application, and re-linking moves it onto a different applicant entirely.
  audit.record(req, {
    action: "ism.updated", entity: "Ism", entityId: row.id,
    summary: `ISM for ${row.name || "a linked applicant"} edited — ${audit.changedKeys(pick(existing), pick(row)).join(", ") || "no answers changed"}` +
      (existing.admitted !== row.admitted ? ` — outcome changed from ${existing.admitted || "none"} to ${row.admitted || "none"}` : "") +
      (existing.admissionId !== row.admissionId ? " — relinked to a different applicant" : ""),
    before: { admitted: existing.admitted, admissionId: existing.admissionId },
    after: { admitted: row.admitted, admissionId: row.admissionId, fieldsChanged: audit.changedKeys(pick(existing), pick(row)) },
  });
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const existing = await prisma.ism.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "ISM not found." });
  const admissionId = existing.admissionId;
  await prisma.ism.delete({ where: { id: req.params.id } });
  // Their outcome may now come from an earlier ISM, or none — recompute it.
  await mirrorOutcome(admissionId);
  audit.record(req, {
    action: "ism.deleted", entity: "Ism", entityId: existing.id,
    summary: `ISM for ${existing.name || "a linked applicant"} deleted` + (existing.admitted ? ` — its outcome (${existing.admitted}) no longer counts towards the applicant's` : ""),
    before: { name: existing.name, admissionId, admitted: existing.admitted, interviewDate: existing.interviewDate, interviewerName: existing.interviewerName },
    after: null,
  });
  res.json({ ok: true });
});

module.exports = router;
