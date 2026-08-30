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

// sortOrder is a 32-bit Int column, and the number arrives from a JSON body nobody
// validates on the way in. `Number(v) || 0` let anything through: a value the column
// cannot hold reached Postgres as a conversion error, and the blanket catch below then
// reported it as "Course not found." — an admin told a row does not exist while looking
// straight at it. It is also the same class of defect as the adjustments overflow in
// STATUS.md §4, which wrote a row Prisma could never read again and killed the API for
// good. Bound it here instead, and say plainly what was wrong.
const INT_MAX = 2147483647;
const sortOrderOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && Math.abs(n) <= INT_MAX ? n : null;
};

// Prisma's "record to update/delete does not exist". Everything else that can come out
// of a write is a real error, and dressing it up as a 404 is how a failing database
// looked like an empty table: the GET routes in this file had their swallow-everything
// fallback removed for exactly that reason, and the writes kept theirs. A genuine fault
// belongs in the error middleware, visibly, not in a reassuring 404.
const isMissingRow = (e) => e?.code === "P2025";

// What a course/intake row is allowed to say back — an ALLOWLIST, for the same reason
// routes/admissions.js gives at length for the Admission serializer. These two routes
// answered `res.json(rows)` straight off Prisma, so every column shipped — and, more to
// the point, a column added to either model tomorrow becomes public the moment it
// exists, without anybody adding one thinking to come back here. An allowlist makes the
// new column private until somebody deliberately publishes it.
const sCourse = (r) => ({ id: r.id, name: r.name, active: r.active, sortOrder: r.sortOrder, createdAt: r.createdAt });
const sIntake = (r) => ({ id: r.id, label: r.label, active: r.active, sortOrder: r.sortOrder, createdAt: r.createdAt });

// ---- Courses ---------------------------------------------------------------
// No try/catch. This answered [] for ANY error, from the days of `prisma db push` when
// the table might genuinely not exist yet. Migrations are authoritative now, so the only
// errors left are real — and an empty list is the most dangerous possible answer here:
// the admin screen shows no courses, the obvious reaction is to type them in again, and
// the public application form loses every course it offers until someone notices. A 500
// says something is wrong; [] lies convincingly.
router.get("/courses", async (_req, res) => {
  const rows = await prisma.admissionCourse.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  res.json(rows.map(sCourse));
});

router.post("/courses", async (req, res) => {
  const name = clean(req.body?.name);
  if (!name) return res.status(400).json({ error: "A course name is required." });
  const row = await prisma.admissionCourse.create({ data: { name } });
  res.status(201).json(sCourse(row));
});

router.put("/courses/:id", async (req, res) => {
  const data = {};
  if (req.body?.name != null) { const name = clean(req.body.name); if (!name) return res.status(400).json({ error: "A course name is required." }); data.name = name; }
  if (req.body?.active != null) data.active = !!req.body.active;
  if (req.body?.sortOrder != null) {
    const n = sortOrderOf(req.body.sortOrder);
    if (n === null) return res.status(400).json({ error: "The sort order must be a whole number." });
    data.sortOrder = n;
  }
  try {
    const row = await prisma.admissionCourse.update({ where: { id: req.params.id }, data });
    res.json(sCourse(row));
  } catch (e) {
    if (isMissingRow(e)) return res.status(404).json({ error: "Course not found." });
    throw e;
  }
});

router.delete("/courses/:id", async (req, res) => {
  try { await prisma.admissionCourse.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (e) {
    if (isMissingRow(e)) return res.status(404).json({ error: "Course not found." });
    throw e;
  }
});

// ---- Intakes ---------------------------------------------------------------
// Same as /courses above: the swallow-everything fallback is gone. A read that fails must
// fail visibly rather than quietly emptying the intake list an applicant chooses from.
router.get("/intakes", async (_req, res) => {
  const rows = await prisma.admissionIntake.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  res.json(rows.map(sIntake));
});

router.post("/intakes", async (req, res) => {
  const label = clean(req.body?.label);
  if (!label) return res.status(400).json({ error: "An intake label is required." });
  const row = await prisma.admissionIntake.create({ data: { label } });
  res.status(201).json(sIntake(row));
});

router.put("/intakes/:id", async (req, res) => {
  const data = {};
  if (req.body?.label != null) { const label = clean(req.body.label); if (!label) return res.status(400).json({ error: "An intake label is required." }); data.label = label; }
  if (req.body?.active != null) data.active = !!req.body.active;
  if (req.body?.sortOrder != null) {
    const n = sortOrderOf(req.body.sortOrder);
    if (n === null) return res.status(400).json({ error: "The sort order must be a whole number." });
    data.sortOrder = n;
  }
  try {
    const row = await prisma.admissionIntake.update({ where: { id: req.params.id }, data });
    res.json(sIntake(row));
  } catch (e) {
    if (isMissingRow(e)) return res.status(404).json({ error: "Intake not found." });
    throw e;
  }
});

router.delete("/intakes/:id", async (req, res) => {
  try { await prisma.admissionIntake.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (e) {
    if (isMissingRow(e)) return res.status(404).json({ error: "Intake not found." });
    throw e;
  }
});

module.exports = router;
