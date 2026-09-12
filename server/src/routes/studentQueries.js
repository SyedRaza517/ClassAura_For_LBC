// Admin side of the student query system: list the queries students have sent, and
// reply to them. The student sees the reply back in their app (GET /student/me/queries).
const router = require("express").Router();
const prisma = require("../db");
const { sStudentQuery } = require("../serializers");
const { requireAuth, requireAnyPage } = require("../auth");
const { localDate } = require("../clock");
const audit = require("../audit");
// STATUS.md:229 records the gap this closes — this file wrote an answer to the
// query row and told nobody. A student who is not told an answer exists has to
// remember to reopen the app and check, which is the same failure the whole
// notification system exists to remove.
const { notifyStudent } = require("../notify");

const str = (v) => (typeof v === "string" ? v.trim() : "");
const guard = requireAnyPage(["studentqueries"]);

// GET /api/student-queries?status=open|answered — every query + who sent it.
router.get("/", requireAuth, guard, async (req, res) => {
  const status = str(req.query?.status);
  const where = ["open", "answered"].includes(status) ? { status } : {};
  const rows = await prisma.studentQuery.findMany({ where, include: { student: true }, orderBy: { createdAt: "desc" } });
  res.json(rows.map(sStudentQuery));
});

// PUT /api/student-queries/:id/respond — write an acknowledgement / feedback. Marks
// the query answered; the response is what the student sees in their app.
router.put("/:id/respond", requireAuth, guard, async (req, res) => {
  const response = str(req.body?.response);
  if (response.length < 1) return res.status(400).json({ error: "Write a response for the student" });
  if (response.length > 4000) return res.status(400).json({ error: "Response is too long" });
  const existing = await prisma.studentQuery.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Query not found" });
  const updated = await prisma.studentQuery.update({
    where: { id: req.params.id },
    data: { response, status: "answered", respondedBy: req.user.name, respondedAt: localDate() },
    include: { student: true },
  });
  // The answer a student is given by the college, in their own name. The text itself
  // stays on the query — a reply can concern welfare or finance, and the audit trail
  // is read on pages this router's gate keeps separate from it.
  audit.record(req, {
    action: "studentQuery.answered", entity: "StudentQuery", entityId: updated.id,
    summary: `Query from ${updated.student ? `${updated.student.firstName} ${updated.student.lastName} (${updated.student.studentRef})` : "a student"} answered by ${req.user.name}` + (existing.status === "answered" ? " — replacing an earlier answer" : ""),
    before: { status: existing.status, respondedBy: existing.respondedBy, respondedAt: existing.respondedAt },
    after: { status: "answered", respondedBy: req.user.name, respondedAt: updated.respondedAt, studentId: updated.studentId },
  });
  res.json(sStudentQuery(updated));

  // One call, at the point the query actually becomes "answered" — never inside a
  // loop, because this route only ever answers one query at a time. Named by its
  // subject (falling back to a generic phrase for the rare row with none), never by
  // the response text: the notification is a pointer back into the app, not a second
  // copy of the answer sitting in a push payload a lock screen might show. notify.js
  // never throws into this handler, so this runs after the response is already sent.
  notifyStudent(updated.studentId, {
    type: "success",
    message: updated.subject ? `Your query "${updated.subject}" has been answered` : "Your query has been answered",
    link: "query",
  });
});

module.exports = router;
