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
  const submitted = req.body?.departments;
  const cleaned = departments.cleanList(submitted);
  if (!cleaned) return res.status(400).json({ error: "departments must be an array" });

  // A DROPPED ROW IS REFUSED HERE, EVEN THOUGH cleanList DROPS IT SILENTLY.
  //
  // supportDepartments.cleanList drops invalid rows so an administrator editing eight
  // teams does not lose seven good edits to one typo, and that is right there -- the
  // consequence is one missing entry in a JSON blob. Here the same rule composes with
  // retire-by-omission below into something much larger: anything dropped is absent from
  // keptKeys, `notIn: []` matches EVERY row, and a submission whose rows are all invalid
  // retires the college's entire organisation chart with a 200 and no warning.
  //
  // Duplicate keys legitimately collapse, so the comparison is against the count of
  // DISTINCT valid keys rather than the raw length.
  const distinctSubmitted = new Set(
    (Array.isArray(submitted) ? submitted : [])
      .map((d) => (typeof d?.key === "string" ? d.key.trim().toLowerCase() : null))
      .filter(Boolean),
  );
  if (Array.isArray(submitted) && cleaned.length !== distinctSubmitted.size) {
    return res.status(400).json({
      error: "One or more departments could not be saved — every department needs a name and a key " +
        "of lower-case letters, digits and hyphens. Nothing was changed.",
    });
  }
  if (Array.isArray(submitted) && submitted.length > 50) {
    return res.status(400).json({ error: "Too many departments in one request — nothing was changed." });
  }

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
  if (ids.length > 50) return res.status(400).json({ error: "Too many departments in one request" });

  // PRESENT AND BOOLEAN, not merely truthy. `=== true` alone would read an OMITTED field
  // as false and silently revoke college-wide access from anybody whose client PATCHed
  // only the department list -- which is how the lockout below gets typed by accident
  // rather than on purpose. routes/staff.js sets the house convention: undefined means
  // "not being changed", so an absent value is refused rather than guessed.
  if (typeof req.body?.collegeWide !== "boolean") {
    return res.status(400).json({ error: "collegeWide must be true or false" });
  }
  const collegeWide = req.body.collegeWide;

  // NARROWING IS REFUSED, AND THIS IS THE HONEST STATE OF THE FEATURE.
  //
  // The guard in academicScopeGuard.js rewrites the TOP-LEVEL query only. A Prisma client
  // extension cannot reach a nested `include`, so a scoped account still reads other
  // departments' rows through any unscoped parent -- measured on 4 Sep 2026 against a
  // scope owning nothing: student.findMany() returned 0 while
  // hndSession.findMany({ include: { marks: true } }) returned 194 attendance marks and
  // unit.findMany({ include: { enrolments: true } }) returned 34 enrolments. Nine route
  // families do exactly this today.
  //
  // The design document predicted this in §9.2 and called it "a claim to be tested, not
  // assumed". It was not tested before the Access control shipped, and the control is what
  // turns a latent gap into a promise the product cannot keep: an administrator who ticks
  // a tutor down to one department is told they are confined, and they are not.
  //
  // So the column, the guard, the configuration screens and the VLE mapping all stand --
  // they are correct and they are what spec 2 builds on -- but nobody can be narrowed
  // until spec 2 closes the nested reads route by route. Refusing here rather than hiding
  // the control in the client is deliberate: the client is not where a boundary is
  // enforced, and an API that accepted this would be enough to break the promise.
  if (!collegeWide) {
    return res.status(400).json({
      error: "Departmental scoping is not switched on yet. Nested reads are not filtered, " +
        "so an account narrowed to a department could still reach other departments' records " +
        "through related data. Assign departments to courses and students now; narrowing " +
        "staff access follows once that is closed.",
    });
  }

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
