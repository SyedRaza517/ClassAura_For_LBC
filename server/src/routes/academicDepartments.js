// The college's academic departments — Business, Computing, Law — and who may see them.
//
// NOT routes/referrals.js's departments. That file's queues are WELLBEING teams, gated by
// Staff.supportDepartments, and answer "who reads a student's disclosure". These decide
// which students a member of staff may see at all. Two access boundaries with one English
// word between them; every identifier here is spelled academicDepartment.
//
// GATED ON THE EXISTING "settings" PAGE rather than a new ADMIN_PAGES key. CLAUDE.md
// records that ADMIN_PAGES is two hand-maintained copies (validate.js and StaffHub.jsx),
// and supportDepartments.js gives the reason not to add to it: a college adding "Law" at
// four in the afternoon cannot also add a permission key to both. The page grants the
// FEATURE; membership decides the rows.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { sAcademicDepartment } = require("../serializers");
const departments = require("../academicDepartments");
const { withoutAcademicScope } = require("../academicScope");
const audit = require("../audit");

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Every department, with the counts the Settings screen shows beside each. */
router.get("/", requireAuth, requirePage("settings"), async (_req, res) => {
  // Institution-wide: reading the department LIST must never be filtered by department
  // membership, or a scoped account could not be shown the name of its own department.
  // AcademicDepartment is declared UNSCOPED for the same reason; the counts hanging off
  // it are of scoped models, hence the declaration.
  const rows = await withoutAcademicScope(
    "academic departments: the list itself is a college-wide fact",
    () => prisma.academicDepartment.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: { _count: { select: { courses: true, students: true } } },
    }),
  );
  res.json({ departments: rows.map(sAcademicDepartment) });
});

/**
 * What the college has NOT finished configuring.
 *
 * BOTH NUMBERS ARE THE VISIBLE HALF OF A FAIL DIRECTION, and neither is allowed to be
 * silent. `collegeWideStaff` is the migration's deliberate fail-OPEN — every account that
 * existed when it ran, plus every account created since, sees everything — made
 * permanently visible so narrowing stays a decision somebody takes rather than one nobody
 * notices was never taken. `unassignedCourses` and `unassignedStudents` are the
 * fail-CLOSED: rows with no department are visible only to college-wide accounts, which is
 * safe and would otherwise be a black hole. Shown as a count, it is a to-do list.
 */
router.get("/summary", requireAuth, requirePage("settings"), async (_req, res) => {
  // Counted institution-wide on purpose. This is a question about the WHOLE college's
  // configuration, and a scoped answer would tell a departmental admin their corner is
  // tidy while most of the college was unassigned.
  const summary = await withoutAcademicScope(
    "academic departments summary: a college-wide configuration question",
    async () => {
      const [collegeWideStaff, totalStaff, unassignedCourses, totalCourses, unassignedStudents, totalStudents, departmentCount] =
        await Promise.all([
          prisma.staff.count({ where: { collegeWide: true } }),
          prisma.staff.count(),
          prisma.course.count({ where: { academicDepartmentId: null } }),
          prisma.course.count(),
          prisma.student.count({ where: { academicDepartmentId: null } }),
          prisma.student.count(),
          prisma.academicDepartment.count({ where: { active: true } }),
        ]);
      return {
        collegeWideStaff, totalStaff,
        unassignedCourses, totalCourses,
        unassignedStudents, totalStudents,
        departmentCount,
      };
    },
  );
  res.json(summary);
});

/**
 * Replace the whole list. Upserts by key; a department dropped from the list is RETIRED.
 *
 * RETIRED, NEVER DELETED, and that is the load-bearing decision in this file. Deleting a
 * department sets academicDepartmentId to null on every course and student pointing at it
 * — onDelete: SetNull, chosen so a deletion can never cascade into losing registers. But
 * under scoping, "null department" means "visible only to college-wide accounts", so
 * deleting a department would silently hide a whole department's students and courses
 * from every member of staff who teaches them, with nothing on screen saying why.
 * Retiring keeps every row attached and merely stops offering the department as a
 * destination.
 */
router.put("/", requireAuth, requirePage("settings"), async (req, res) => {
  const cleaned = departments.cleanList(req.body?.departments);
  if (!cleaned) return res.status(400).json({ error: "departments must be an array" });

  const result = await withoutAcademicScope(
    "academic departments: saving the college's own organisation chart",
    async () => {
      const before = await prisma.academicDepartment.findMany({ orderBy: { name: "asc" } });
      const keptKeys = cleaned.map((d) => d.key);

      await prisma.$transaction([
        ...cleaned.map((d) => prisma.academicDepartment.upsert({
          where: { key: d.key },
          // The KEY is never updated — it is the one immutable field, because a saved
          // filter, a URL fragment and the VLE mapping screen all carry it and none of
          // them re-resolves it afterwards.
          update: { name: d.name, colour: d.colour, active: d.active },
          create: d,
        })),
        // Anything the college left out is retired rather than removed. `keptKeys` may be
        // empty, and notIn: [] correctly matches everything — a college clearing the list
        // retires all of them, which is the reversible reading of that gesture.
        prisma.academicDepartment.updateMany({
          where: { key: { notIn: keptKeys } },
          data: { active: false },
        }),
      ]);
      departments.invalidate();

      const after = await prisma.academicDepartment.findMany({
        orderBy: [{ active: "desc" }, { name: "asc" }],
        include: { _count: { select: { courses: true, students: true } } },
      });
      return { before, after };
    },
  );

  audit.record(req, {
    action: "academicDepartments.saved", entity: "AcademicDepartment",
    summary: "Academic departments updated by " + (req.user?.name || "an administrator") +
      " — " + (result.after.filter((d) => d.active).map((d) => d.name).join(", ") || "none active"),
    before: result.before.map((d) => ({ key: d.key, name: d.name, active: d.active })),
    after: result.after.map((d) => ({ key: d.key, name: d.name, active: d.active })),
  });

  res.json({ departments: result.after.map(sAcademicDepartment) });
});

/**
 * Set one member of staff's departments, and whether they are college-wide.
 *
 * SUPER-ADMIN ONLY, unlike the list above, and the split is deliberate. Editing the
 * department LIST is configuration — a name, a colour, which teams the college runs.
 * Editing who may SEE a department is granting access to students' registers, predictions
 * and pastoral records, and this is the one endpoint that can hand somebody the entire
 * college in a single request. It matches the rule Staff.supportDepartments already
 * follows: membership of a confidentiality boundary is not an ordinary settings edit.
 */
router.put("/staff/:staffId", requireAuth, requirePage("settings"), async (req, res) => {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ error: "Only the Super Admin can change academic department access" });
  }

  const ids = Array.isArray(req.body?.academicDepartmentIds)
    ? [...new Set(req.body.academicDepartmentIds.filter((v) => typeof v === "string" && v))]
    : null;
  if (!ids) return res.status(400).json({ error: "academicDepartmentIds must be an array" });
  // `=== true`, never truthiness. This is the flag that grants the whole college, and it
  // fails closed for the same reason parseAdminPages does.
  const collegeWide = req.body?.collegeWide === true;

  const outcome = await withoutAcademicScope(
    "academic departments: granting access, which is a college-wide act",
    async () => {
      const staff = await prisma.staff.findUnique({
        where: { id: str(req.params.staffId) },
        include: { academicDepartments: { select: { academicDepartmentId: true } } },
      });
      if (!staff) return { error: 404, message: "No such staff member" };

      // Every id must be a real department. An unknown one is REJECTED rather than
      // dropped: silently ignoring it leaves the Access screen showing a grant that was
      // never made, which is worse than an error the administrator can act on.
      if (ids.length) {
        const known = await prisma.academicDepartment.findMany({ where: { id: { in: ids } }, select: { id: true } });
        if (known.length !== ids.length) return { error: 400, message: "One or more departments do not exist" };
      }

      const beforeIds = staff.academicDepartments.map((m) => m.academicDepartmentId);
      await prisma.$transaction([
        prisma.staffAcademicDepartment.deleteMany({ where: { staffId: staff.id } }),
        ...ids.map((academicDepartmentId) =>
          prisma.staffAcademicDepartment.create({ data: { staffId: staff.id, academicDepartmentId } })),
        prisma.staff.update({ where: { id: staff.id }, data: { collegeWide } }),
      ]);
      return { staff, beforeIds };
    },
  );

  if (outcome.error) return res.status(outcome.error).json({ error: outcome.message });

  // The summary names the PERSON and the DECISION, never a student. This audit log is
  // read on the Settings screen by admins who were never granted the pastoral pages — the
  // same reason the mitigating-circumstances audit records the fact of a decision and
  // never its category.
  audit.record(req, {
    action: "academicDepartments.staffAccessChanged", entity: "Staff", entityId: outcome.staff.id,
    summary: outcome.staff.name +
      (collegeWide ? " was granted college-wide access to every department"
                   : ` was scoped to ${ids.length} academic department(s)`) +
      " by " + (req.user?.name || "an administrator"),
    before: { academicDepartmentIds: outcome.beforeIds, collegeWide: outcome.staff.collegeWide },
    after: { academicDepartmentIds: ids, collegeWide },
  });

  res.json({ ok: true, academicDepartmentIds: ids, collegeWide });
});

module.exports = router;
