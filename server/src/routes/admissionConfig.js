// Admissions configuration — the course and intake lists an admin manages from the
// Admissions page. These feed the PUBLIC application form's Course and Intake dropdowns
// (see routes/admissionApply.js) and are deliberately independent of the Moodle-synced
// `Course` table: admissions controls exactly what a prospective student can apply for.
//
// Gated on the "admissions" admin page, like routes/admissions.js. The public read-only
// views live in admissionApply.js (no auth) so an applicant never needs to log in.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");

router.use(requireAuth, requirePage("admissions"));

// Trim to a string, cap length, and coalesce empties to "".
const clean = (v) => String(v == null ? "" : v).trim().slice(0, 300);

// ---- Courses ---------------------------------------------------------------
// No try/catch. This answered [] for ANY error, from the days of `prisma db push` when
// the table might genuinely not exist yet. Migrations are authoritative now, so the only
// errors left are real — and an empty list is the most dangerous possible answer here:
// the admin screen shows no courses, the obvious reaction is to type them in again, and
// the public application form loses every course it offers until someone notices. A 500
// says something is wrong; [] lies convincingly.
router.get("/courses", async (_req, res) => {
  const rows = await prisma.admissionCourse.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  res.json(rows);
});

router.post("/courses", async (req, res) => {
  const name = clean(req.body?.name);
  if (!name) return res.status(400).json({ error: "A course name is required." });
  const row = await prisma.admissionCourse.create({ data: { name } });
  res.status(201).json(row);
});

router.put("/courses/:id", async (req, res) => {
  const data = {};
  if (req.body?.name != null) { const name = clean(req.body.name); if (!name) return res.status(400).json({ error: "A course name is required." }); data.name = name; }
  if (req.body?.active != null) data.active = !!req.body.active;
  if (req.body?.sortOrder != null) data.sortOrder = Number(req.body.sortOrder) || 0;
  try {
    const row = await prisma.admissionCourse.update({ where: { id: req.params.id }, data });
    res.json(row);
  } catch (_) { res.status(404).json({ error: "Course not found." }); }
});

router.delete("/courses/:id", async (req, res) => {
  try { await prisma.admissionCourse.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (_) { res.status(404).json({ error: "Course not found." }); }
});

// ---- Intakes ---------------------------------------------------------------
// Same as /courses above: the swallow-everything fallback is gone. A read that fails must
// fail visibly rather than quietly emptying the intake list an applicant chooses from.
router.get("/intakes", async (_req, res) => {
  const rows = await prisma.admissionIntake.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  res.json(rows);
});

router.post("/intakes", async (req, res) => {
  const label = clean(req.body?.label);
  if (!label) return res.status(400).json({ error: "An intake label is required." });
  const row = await prisma.admissionIntake.create({ data: { label } });
  res.status(201).json(row);
});

router.put("/intakes/:id", async (req, res) => {
  const data = {};
  if (req.body?.label != null) { const label = clean(req.body.label); if (!label) return res.status(400).json({ error: "An intake label is required." }); data.label = label; }
  if (req.body?.active != null) data.active = !!req.body.active;
  if (req.body?.sortOrder != null) data.sortOrder = Number(req.body.sortOrder) || 0;
  try {
    const row = await prisma.admissionIntake.update({ where: { id: req.params.id }, data });
    res.json(row);
  } catch (_) { res.status(404).json({ error: "Intake not found." }); }
});

router.delete("/intakes/:id", async (req, res) => {
  try { await prisma.admissionIntake.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (_) { res.status(404).json({ error: "Intake not found." }); }
});

module.exports = router;
