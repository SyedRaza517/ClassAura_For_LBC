// The timetable a member of staff READS. The planner half is routes/timetabling.js.
//
// requireAuth ONLY — no requirePage. Every lecturer reads their own timetable, and
// gating that on an admin page would mean granting an admin page to the entire
// teaching staff, which is the opposite of what page grants are for.
//
// Student and applicant tokens cannot reach here at all: they are confined by the
// STUDENT_ROUTERS / APPLICANT_ROUTERS allowlists in auth.js, and this router is in
// neither. That is closed-by-default and is why there is no per-route check for it;
// smoke-timetabling.mjs asserts it rather than trusting the comment.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth } = require("../auth");
const { sResource } = require("../timetabling/serialize");

router.use(requireAuth);

const str = (v) => (typeof v === "string" ? v.trim() : "");

// A picker, not an export. The reference institution's list runs to 9,009 students,
// and a limit is what keeps this from becoming a way to page the whole directory
// into a file.
const MAX_LIMIT = 50;

/**
 * Search one resource type.
 *
 * ALL FIVE TYPES ARE OPEN TO ANY SIGNED-IN MEMBER OF STAFF, matching the system this
 * reproduces. That includes looking up a named student's week, which is a larger
 * disclosure than anything else in the staff app — a decision taken deliberately and
 * recorded in the design document, not an oversight. Narrowing it later means
 * removing types from this switch and nothing else.
 */
router.get("/resources", async (req, res) => {
  const type = str(req.query.type);
  const q = str(req.query.q).slice(0, 100);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 25));
  const like = { contains: q, mode: "insensitive" };

  let rows = [], total = 0;
  switch (type) {
    case "room": {
      // Active only. The planner shows retired rooms because it manages them; a
      // reader looking for somewhere to be should not be offered one.
      const where = { active: true, ...(q ? { OR: [{ name: like }, { campus: like }] } : {}) };
      [rows, total] = await Promise.all([
        prisma.room.findMany({ where, orderBy: [{ campus: "asc" }, { name: "asc" }], take: limit }),
        prisma.room.count({ where }),
      ]);
      break;
    }
    case "staff": {
      const where = q ? { name: like } : {};
      [rows, total] = await Promise.all([
        prisma.staff.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, dept: true } }),
        prisma.staff.count({ where }),
      ]);
      break;
    }
    case "student": {
      // Requiring a query for students is deliberate. Every other type is small
      // enough to browse; this one is thousands of named people, and an empty search
      // returning the first 25 of them makes the picker a directory you scroll.
      if (!q) return res.json({ type, total: 0, results: [], needsQuery: true });
      // There is no `name` column on Student — it is firstName, lastName and
      // studentRef. All three are searched, because a member of staff looking a
      // student up has whichever one they happen to be holding.
      const where = { OR: [{ firstName: like }, { lastName: like }, { studentRef: like }] };
      [rows, total] = await Promise.all([
        prisma.student.findMany({ where, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: limit, select: { id: true, firstName: true, lastName: true, studentRef: true } }),
        prisma.student.count({ where }),
      ]);
      break;
    }
    case "group": {
      const where = q ? { name: like } : {};
      [rows, total] = await Promise.all([
        prisma.cohort.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, course: { select: { name: true } } } }),
        prisma.cohort.count({ where }),
      ]);
      break;
    }
    case "module": {
      const where = q ? { OR: [{ name: like }, { code: like }] } : {};
      [rows, total] = await Promise.all([
        prisma.unit.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, code: true } }),
        prisma.unit.count({ where }),
      ]);
      break;
    }
    default:
      return res.status(400).json({ error: "type must be one of: module, room, staff, student, group" });
  }

  res.json({ type, total, results: rows.map((r) => sResource(type, r)) });
});

module.exports = router;
