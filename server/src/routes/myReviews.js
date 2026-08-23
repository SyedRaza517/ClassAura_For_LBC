// A lecturer's OWN reviews, from the staff app.
//
// Deliberately separate from /api/staff-reviews, which is the admin console's
// page-gated view of everybody. Here `staffId` is never read from the request — it
// is always the signed-in user — so there is no id to tamper with and no way to read
// or write a colleague's reflection.
//
// Only forms marked `selfService` are offered. The Strategic Lecturer Self-Reflection
// is written by the lecturer about their own term; the Monthly Performance & Support
// Review is written by a reviewer ABOUT a lecturer, so it stays admin-only.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth } = require("../auth");
const { FORMS, byType, validateAnswers, denormalise } = require("../reviewForms");
const audit = require("../audit");

// Signed-in staff only. Students have their own router; a student token is already
// blocked from everything outside /api/student by requireAuth.
router.use(requireAuth, (req, res, next) => {
  if (req.user?.kind === "student") return res.status(403).json({ error: "Not available for student accounts" });
  next();
});

// (`!f.pending` was also tested here. No form has ever carried that flag — dead, and
// dropped rather than left implying a form could be hidden by it.)
const SELF_FORMS = () => FORMS.filter((f) => f.selfService);
const selfForm = (type) => SELF_FORMS().find((f) => f.type === type) || null;
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

const sMine = (r) => ({
  id: r.id,
  type: r.type,
  formTitle: byType(r.type)?.title || r.type,
  term: r.term,
  academicYear: r.academicYear,
  dateCompleted: r.dateCompleted,
  status: r.status,
  answers: parse(r.answers, {}),
  origin: r.origin,
  completedBy: r.completedBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// The forms this user may fill in about themselves.
router.get("/forms", (_req, res) => res.json(SELF_FORMS()));

// This router's scope is BOTH conditions: the review is about you AND it is a form you
// fill in yourself. Ownership alone is not enough — a Monthly, Evaluation or Teaching
// Quality review is *about* a lecturer but written by their reviewer, and contains
// candid judgements (escalation to the COO, "Intervention Required") the subject is not
// meant to read here. Filtering on staffId only meant this route handed a lecturer their
// own management review, and let them delete their reviewer's draft of it.
const SELF_TYPES = () => SELF_FORMS().map((f) => f.type);
const mineAndSelfService = (req) => ({ staffId: req.user.id, type: { in: SELF_TYPES() } });

router.get("/", async (req, res) => {
  const rows = await prisma.staffReview.findMany({
    where: mineAndSelfService(req),
    orderBy: [{ dateCompleted: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  res.json(rows.map(sMine));
});

router.get("/:id", async (req, res) => {
  const row = await prisma.staffReview.findFirst({ where: { id: req.params.id, ...mineAndSelfService(req) } });
  if (!row) return res.status(404).json({ error: "Review not found" });
  res.json(sMine(row));
});

// denormalise() is imported from ../reviewForms and shared with routes/staffReviews.js;
// it used to be copied into both, each with its own hand-kept list of date question ids.
// No request body is passed here on purpose: a lecturer filling in their own reflection
// may only supply answers, so the list fields must come from what they actually wrote and
// can never be set directly.

router.post("/", async (req, res) => {
  const form = selfForm(String(req.body?.type || "").trim());
  if (!form) return res.status(400).json({ error: "That review isn't one you can complete about yourself." });
  const status = req.body?.status === "draft" ? "draft" : "submitted";
  const a = validateAnswers(form, req.body?.answers, { draft: status === "draft" });
  if (a.error) return res.status(400).json({ error: a.error });

  const row = await prisma.staffReview.create({
    data: {
      // Always the signed-in user. Never req.body.staffId.
      staffId: req.user.id,
      type: form.type,
      status,
      ...denormalise(a.answers),
      answers: JSON.stringify(a.answers),
      completedBy: req.user?.name || null,
      origin: "self",
    },
  });
  // Only the submission. A draft is the author's working copy — they save it
  // repeatedly while writing, and logging every keystroke-sized save would bury the
  // one event that matters: the moment the reflection became a record their reviewer
  // can read and they can no longer change.
  if (row.status !== "draft") {
    audit.record(req, {
      action: "staffReview.submitted", entity: "StaffReview", entityId: row.id,
      summary: `${row.type} self-reflection submitted by ${row.completedBy || "a lecturer"} — it is now locked to them`,
      after: { type: row.type, staffId: row.staffId, status: row.status, origin: "self" },
    });
  }
  res.status(201).json(sMine(row));
});

router.put("/:id", async (req, res) => {
  const existing = await prisma.staffReview.findFirst({ where: { id: req.params.id, ...mineAndSelfService(req) } });
  if (!existing) return res.status(404).json({ error: "Review not found" });
  // A submitted reflection is a record their reviewer may already have read, so it
  // stops being editable. Drafts stay open until the author is ready.
  if (existing.status !== "draft") {
    return res.status(409).json({ error: "This reflection has already been submitted, so it can no longer be changed. Ask an administrator if something needs correcting." });
  }
  const form = selfForm(existing.type);
  if (!form) return res.status(400).json({ error: "That review isn't one you can edit." });

  const status = req.body?.status === undefined
    ? existing.status
    : (req.body.status === "draft" ? "draft" : "submitted");
  // Answers are replaced wholesale, so a body that omits them would blank the review.
  // Treat "no answers sent" as "keep what's there" and re-validate that instead.
  const raw = req.body?.answers !== undefined ? req.body.answers : parse(existing.answers, {});
  const a = validateAnswers(form, raw, { draft: status === "draft" });
  if (a.error) return res.status(400).json({ error: a.error });

  const row = await prisma.staffReview.update({
    where: { id: existing.id },
    data: { status, ...denormalise(a.answers), answers: JSON.stringify(a.answers) },
  });
  if (existing.status === "draft" && row.status !== "draft") {
    audit.record(req, {
      action: "staffReview.submitted", entity: "StaffReview", entityId: row.id,
      summary: `${row.type} self-reflection submitted by ${row.completedBy || "a lecturer"} — it is now locked to them`,
      before: { status: "draft" },
      after: { type: row.type, staffId: row.staffId, status: row.status, origin: "self" },
    });
  }
  res.json(sMine(row));
});

// A draft is the author's own working copy, so they may discard it. A submitted
// reflection is not theirs to delete — it belongs to the review record.
router.delete("/:id", async (req, res) => {
  // Scoped to self-service types as well as ownership. Without the type check this was
  // the one write on this router with no `selfForm()` guard, so a lecturer could destroy
  // their reviewer's in-progress Monthly review of them — and the staff app rendered a
  // "Discard draft" button that did exactly that.
  const existing = await prisma.staffReview.findFirst({ where: { id: req.params.id, ...mineAndSelfService(req) } });
  if (!existing) return res.status(404).json({ error: "Review not found" });
  if (existing.status !== "draft") {
    return res.status(409).json({ error: "A submitted reflection can't be deleted. Ask an administrator if it was sent in error." });
  }
  try { await prisma.staffReview.delete({ where: { id: existing.id } }); res.json({ ok: true }); }
  catch (_e) { res.status(404).json({ error: "Review not found" }); }
});

module.exports = router;
