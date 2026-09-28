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
const { requireAuth, requirePage, requireCollegeWide } = require("../auth");
const { sAcademicDepartment } = require("../serializers");
const departments = require("../academicDepartments");
const { withoutAcademicScope } = require("../academicScope");
const audit = require("../audit");
// requireAuth caches the caller's row WITH its academicDepartments memberships (see
// identityCache.js) — scopeForStaff reads both collegeWide and the membership rows
// from that cached copy, so the grant/narrow write below must drop it on commit.
const { identityCache } = require("../identityCache");

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
 * The school list as a FILTER VOCABULARY — names, colours, active flags. Nothing else.
 *
 * GATED ON requireAuth ALONE, unlike everything else in this router, and that is the
 * point of its existence. School-filter dropdowns now sit on admin screens across many
 * different page grants — students, registers, prediction, admissions, PAT — and the
 * two existing list routes each answer to one grant: GET / above needs "settings",
 * /api/timetabling/departments needs "scheduling". A PAT admin holds neither, the
 * fetch 403s, and the filter silently vanishes with nothing on screen saying why.
 *
 * The boundary routes/timetabling.js draws for its own copy holds here too: the list
 * of school NAMES is a label vocabulary every staff member can already read off any
 * student row (sStudent ships academicDepartmentId to any authenticated caller).
 * MEMBERSHIP — who is in one, and the counts that reveal how many — stays behind
 * "settings" and Super Admin above. `key` is withheld with the counts: it is the
 * membership editor's stable handle, and no filter needs it.
 *
 * Retired schools are returned too, carrying `active`, exactly as the timetabling
 * route argues: a filter (unlike a picker) must be able to find the students still
 * attached to a school the college has stopped running.
 */
router.get("/options", requireAuth, async (_req, res) => {
  // AcademicDepartment is declared UNSCOPED in academicScopeModels.js, so no
  // withoutAcademicScope() wrapper — see GET / above.
  const rows = await prisma.academicDepartment.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true, colour: true, active: true },
  });
  res.json(rows);
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
 *
 * COLLEGE-WIDE CALLERS ONLY. This replaces the whole list -- every other department's
 * name, colour and active flag included -- so an admin narrowed to one department could
 * retire the rest. Same rule as the planner's rename/retire in timetabling.js.
 */
router.put("/", requireAuth, requirePage("settings"), requireCollegeWide("Editing the list of departments"), async (req, res) => {
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

  // NARROWING IS ALLOWED, AND THAT IS WHAT SPEC 2 DELIVERED.
  //
  // This returned 400 for every request that would narrow an account, because the guard
  // rewrites the TOP-LEVEL query only and a Prisma client extension cannot reach a nested
  // include: measured 4 Sep 2026, a scope owning nothing returned 0 students at the top
  // level and 194 attendance marks through a session include. Offering the control would
  // have promised a confinement the product could not deliver, and the client is not where
  // a boundary is enforced, so it was refused in the API rather than hidden in the screen.
  //
  // Spec 2 closed it by scoping the PARENT models -- the child query is still not rewritten,
  // it simply has nothing left to hang off. scripts/smoke-academic-nested-reads.mjs holds
  // all 13 shapes at zero with a control proving the data is really there, and the whole
  // suite now runs a second time with every account narrowed
  // (SMOKE_SCOPED_DEPARTMENT=1) -- the branch that had never executed once when spec 1
  // shipped thirty green suites over a leaking boundary.

  // A SUPER ADMIN CANNOT REMOVE THEIR OWN COLLEGE-WIDE ACCESS.
  //
  // Nothing else stops it, and the result is a locked room: the account matches
  // { in: [] } on every scoped model, so every student list, register and prediction comes
  // back empty -- and the screen that would explain what happened is the empty one. It is
  // recoverable, because this route runs under withoutAcademicScope, but only by somebody
  // who already knows that.
  //
  // Narrowing SOMEBODY ELSE is fine and is the whole point of the feature. This refuses
  // exactly one thing: doing it to yourself. routes/staff.js sets the same precedent, where
  // the Super Admin's own row is special-cased so the equivalent lockout cannot be typed.
  if (!collegeWide && str(req.params.staffId) === req.user.id) {
    return res.status(400).json({
      error: "You cannot remove your own college-wide access — you would not be able to see " +
        "the college, or this screen, to put it back. Ask another Super Admin, or narrow a " +
        "different account.",
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
      // This transaction just changed which students this account can see — the
      // decision scopeForStaff makes from the cached row on every request. Narrowing
      // someone must narrow their NEXT request, not the one after their TTL expires.
      identityCache.invalidate("staff", staff.id);
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
