// Staff reviews — the Strategic Lecturer Self-Reflection and the Monthly Performance
// & Support Review. Modelled on the PAT interactions log: admin-only throughout,
// reads included, because a review contains candid performance commentary about a
// named colleague.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requireAdmin, requirePage } = require("../auth");
const { FORMS, byType, validateAnswers, denormalise } = require("../reviewForms");
const audit = require("../audit");

// A review in the audit trail: whose it is, which form, what state it is in. Never
// the answers — a performance review is candid commentary about a named colleague,
// and the audit trail is read on the Settings, Access and Staff pages by admins who
// were never granted this one.
const reviewLabel = (row) => `${row.type || "Review"} for ${row.staff ? `${row.staff.name} (${row.staff.email})` : "a colleague"}`;

router.use(requireAuth, requirePage("staffreviews"));

const str = (v) => (typeof v === "string" ? v.trim() : "");
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

const sReview = (r) => ({
  id: r.id,
  staffId: r.staffId,
  staff: r.staff ? { id: r.staff.id, name: r.staff.name, initials: r.staff.initials, colour: r.staff.colour, role: r.staff.jobTitle, dept: r.staff.dept } : null,
  type: r.type,
  formTitle: byType(r.type)?.title || r.type,
  term: r.term,
  academicYear: r.academicYear,
  dateCompleted: r.dateCompleted,
  status: r.status,
  answers: parse(r.answers, {}),
  completedBy: r.completedBy,
  origin: r.origin,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// GET /api/staff-reviews/forms — the question definitions the client renders from.
// Served rather than duplicated in the front-end, so adding or rewording a question
// is a one-file change on the server with no client release.
router.get("/forms", (_req, res) => res.json(FORMS));

// GET /api/staff-reviews?staffId=&type=&status=
router.get("/", async (req, res) => {
  const where = {};
  const staffId = str(req.query?.staffId);
  const type = str(req.query?.type);
  const status = str(req.query?.status);
  if (staffId) where.staffId = staffId;
  if (type) {
    if (!byType(type)) return res.status(400).json({ error: "Unknown review type" });
    where.type = type;
  }
  if (status) {
    if (!["draft", "submitted"].includes(status)) return res.status(400).json({ error: "status must be draft or submitted" });
    where.status = status;
  }
  const rows = await prisma.staffReview.findMany({
    where,
    include: { staff: true },
    // nulls:"last" — Postgres sorts NULLs FIRST on a DESC column, so an undated review
    // (a draft, or a form whose date question is unanswered) pinned itself above every
    // properly dated one at the top of the list.
    orderBy: [{ dateCompleted: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  res.json(rows.map(sReview));
});

router.get("/:id", async (req, res) => {
  const row = await prisma.staffReview.findUnique({ where: { id: req.params.id }, include: { staff: true } });
  if (!row) return res.status(404).json({ error: "Review not found" });
  res.json(sReview(row));
});

// Shared validation for create and update.
async function validate(body, { partial = false } = {}) {
  const data = {};
  const type = str(body?.type);
  if (!partial || body?.type !== undefined) {
    const form = byType(type);
    if (!form) return { error: "Choose a review type" };
    // (There was a `form.pending` guard here for a form defined but not yet written.
    // reviewForms.js has never set that flag on any form, so the branch was unreachable
    // — removed rather than left looking like a rule someone still has to satisfy.)
    data.type = type;
  }
  if (!partial || body?.staffId !== undefined) {
    const staffId = str(body?.staffId);
    if (!staffId) return { error: "Choose the staff member this review is for" };
    const exists = await prisma.staff.findUnique({ where: { id: staffId } });
    if (!exists) return { error: "Unknown staff member" };
    data.staffId = staffId;
  }
  if (body?.status !== undefined) {
    const status = str(body.status);
    if (!["draft", "submitted"].includes(status)) return { error: "status must be draft or submitted" };
    data.status = status;
  }
  return { data };
}

// denormalise() — the list-view fields (term, academicYear, dateCompleted) lifted out of
// the answers — now comes from ../reviewForms, which is where the question ids it looks
// for are defined. This file and routes/myReviews.js each held their own copy of it, with
// a hand-maintained list of every form's date question id in both.

router.post("/", requireAdmin, async (req, res) => {
  const v = await validate(req.body, { partial: false });
  if (v.error) return res.status(400).json({ error: v.error });
  const form = byType(v.data.type);
  const status = v.data.status || "submitted";
  const a = validateAnswers(form, req.body?.answers, { draft: status === "draft" });
  if (a.error) return res.status(400).json({ error: a.error });

  const row = await prisma.staffReview.create({
    data: {
      ...v.data,
      status,
      ...denormalise(a.answers, req.body),
      answers: JSON.stringify(a.answers),
      completedBy: req.user?.name || null,
    },
    include: { staff: true },
  });
  audit.record(req, {
    action: "staffReview.created", entity: "StaffReview", entityId: row.id,
    summary: `${reviewLabel(row)} created as ${row.status} by ${row.completedBy || "an administrator"}`,
    after: { type: row.type, staffId: row.staffId, status: row.status, dateCompleted: row.dateCompleted, completedBy: row.completedBy },
  });
  res.status(201).json(sReview(row));
});

router.put("/:id", requireAdmin, async (req, res) => {
  const existing = await prisma.staffReview.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Review not found" });
  // The type is fixed once created — changing it would leave answers belonging to a
  // different set of questions. It goes AFTER the spread so a `type` in the body is
  // ignored rather than overriding it (which made an edit fail outright instead).
  const v = await validate({ ...req.body, type: existing.type }, { partial: true });
  if (v.error) return res.status(400).json({ error: v.error });

  const form = byType(existing.type);
  const data = { ...v.data };
  delete data.type;
  // Who the review is about is fixed at creation, for the same reason the type is:
  // the answers were written about this person. Moving them silently re-attributes
  // someone's appraisal to a colleague.
  delete data.staffId;

  // Validate whenever the answers change OR the review is being submitted. Gating this
  // on `answers` alone let `PUT {"status":"submitted"}` promote a one-answer draft to a
  // filed review without ever running the required-field checks — and, because a
  // submitted self-reflection then locks, it left the lecturer unable to fix their own.
  const status = data.status || existing.status;
  const submitting = status !== "draft";
  if (req.body?.answers !== undefined || submitting) {
    const raw = req.body?.answers !== undefined ? req.body.answers : parse(existing.answers, {});
    const a = validateAnswers(form, raw, { draft: !submitting });
    if (a.error) return res.status(400).json({ error: a.error });
    data.answers = JSON.stringify(a.answers);
    Object.assign(data, denormalise(a.answers, req.body));
  }
  const row = await prisma.staffReview.update({ where: { id: existing.id }, data, include: { staff: true } });
  // Whether the answers moved is recorded; what they now say is not. The status is
  // the part that matters here — submitting a review files it, and a filed review
  // locks.
  audit.record(req, {
    action: "staffReview.updated", entity: "StaffReview", entityId: row.id,
    summary: `${reviewLabel(row)} edited` + (existing.status !== row.status ? ` — ${existing.status} → ${row.status}` : "") + (data.answers !== undefined ? ", answers changed" : ""),
    before: { status: existing.status, dateCompleted: existing.dateCompleted },
    after: { status: row.status, dateCompleted: row.dateCompleted, answersChanged: data.answers !== undefined },
  });
  res.json(sReview(row));
});

router.delete("/:id", requireAdmin, async (req, res) => {
  const existing = await prisma.staffReview.findUnique({ where: { id: req.params.id }, include: { staff: true } });
  if (!existing) return res.status(404).json({ error: "Review not found" });
  try {
    await prisma.staffReview.delete({ where: { id: existing.id } });
    // A filed appraisal disappearing is the kind of thing an employment dispute turns
    // on, so the fact of the deletion outlives the record itself.
    audit.record(req, {
      action: "staffReview.deleted", entity: "StaffReview", entityId: existing.id,
      summary: `${reviewLabel(existing)} deleted — it was ${existing.status}, completed by ${existing.completedBy || "an administrator"}`,
      before: { type: existing.type, staffId: existing.staffId, status: existing.status, dateCompleted: existing.dateCompleted, completedBy: existing.completedBy },
      after: null,
    });
    res.json({ ok: true });
  }
  catch (_e) { res.status(404).json({ error: "Review not found" }); }
});

module.exports = router;
