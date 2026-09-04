// Mapping the VLE's own course grouping onto an academic department, once, by hand.
//
// CAPTURE, THEN MAP, NEVER GUESS. The sync records the category it found and stops there.
// A person decides what it means.
//
// The rejected alternative was inferring the department from the course NAME -- "contains
// the word Business". That is the class of error CLAUDE.md calls a data-protection
// incident rather than a bug, for the same reason matching SlcApplication.studentName to
// Student by string is forbidden: it attaches one person's records to another. Under
// scoping a wrong mapping is a Law tutor reading Health & Social Care pastoral notes, and
// nothing on any screen would say so.
//
// Gated on the existing "settings" page, like routes/academicDepartments.js and for the
// same reason.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { withoutAcademicScope } = require("../academicScope");
const audit = require("../audit");
const academicDepartments = require("../academicDepartments");

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Every VLE category we have seen, and what is inside it.
 *
 * INSTITUTION-WIDE on purpose. This is a question about the college's configuration, and a
 * scoped answer would show a departmental admin a tidy mapping while most of the college
 * was unmapped.
 */
router.get("/categories", requireAuth, requirePage("settings"), async (_req, res) => {
  const { courses, departments } = await withoutAcademicScope(
    "vle mapping: a college-wide configuration question",
    async () => ({
      courses: await prisma.course.findMany({
        select: {
          id: true, name: true,
          vleCategoryExternalId: true, vleCategoryName: true,
          academicDepartmentId: true,
        },
        orderBy: { name: "asc" },
      }),
      departments: await prisma.academicDepartment.findMany({
        select: { id: true, name: true }, orderBy: { name: "asc" },
      }),
    }),
  );

  const byCategory = new Map();
  for (const c of courses) {
    // Courses with NO captured category get their own bucket rather than being omitted.
    // A college whose Moodle predates the capture has every course here, and a screen
    // that silently dropped them would report the mapping as finished when none of it had
    // begun. The bucket is keyed on "" and reported with externalId null.
    const key = c.vleCategoryExternalId || "";
    if (!byCategory.has(key)) {
      byCategory.set(key, { externalId: c.vleCategoryExternalId || null, name: c.vleCategoryName || null, courses: [] });
    }
    byCategory.get(key).courses.push(c);
  }

  const categories = [...byCategory.values()].map((cat) => {
    const assigned = [...new Set(cat.courses.map((c) => c.academicDepartmentId).filter(Boolean))];
    return {
      externalId: cat.externalId,
      // NULL means "we could not read the name", NOT "it has no name". A Moodle whose
      // token lacks core_course_get_categories still yields ids, and the screen names them
      // by what is inside. Null-is-not-zero, applied to a permission we may not have.
      name: cat.name,
      courseCount: cat.courses.length,
      // HOW MANY OF THEM ARE STILL UNASSIGNED. Without this the row derived its department
      // from the non-null values alone, so a category with three mapped courses and one
      // unmapped read as fully "Business" -- exactly the state a sync creates when it adds
      // a course to an already-mapped category. The count is what makes that visible.
      unassignedCourseCount: cat.courses.filter((c) => !c.academicDepartmentId).length,
      sampleCourses: cat.courses.slice(0, 5).map((c) => c.name),
      // One id when the whole category maps to one department; null when none of it does.
      academicDepartmentId: assigned.length === 1 ? assigned[0] : null,
      // SPLIT is a real state, not a rounding error. It means somebody assigned courses by
      // hand, and flattening it to "unmapped" would invite an administrator to overwrite
      // deliberate work with one click.
      splitAcross: assigned.length > 1 ? assigned : null,
    };
  }).sort((a, b) => b.courseCount - a.courseCount);

  res.json({ categories, departments });
});

/**
 * Assign every course in one VLE category to one department -- and its students with them.
 *
 * THE STUDENTS MOVE IN THE SAME TRANSACTION, and that is why this is one endpoint rather
 * than two. Student.academicDepartmentId is denormalised from the course through the
 * cohort; a mapping that moved courses and left students behind would leave a
 * department's students invisible to the very staff who had just been given that
 * department, with nothing on screen explaining it.
 *
 * Passing academicDepartmentId: null is the deliberate un-assign, which returns those
 * courses and students to "visible only to college-wide accounts".
 */
router.put("/", requireAuth, requirePage("settings"), async (req, res) => {
  // SUPER-ADMIN ONLY, and this gate was missing.
  //
  // requirePage("settings") is an ordinary ADMIN_PAGES key, and an admin whose adminPages
  // is null -- the state at every college that has never configured page grants -- holds
  // it by default. That made this endpoint a self-service escalation: a Business-scoped
  // admin could read every category through GET /categories (institution-wide by design),
  // then PUT the Computing category with their OWN department id. Every Computing course
  // and student is rewritten into Business, and they then read those students through the
  // FILTERED paths, with the guard working exactly as designed.
  //
  // routes/academicDepartments.js claims PUT /staff/:staffId is "the one endpoint that can
  // hand somebody the entire college in a single request". It was the second, and it was
  // the one without the gate. This is a bulk write over Course and Student that redraws
  // the boundary itself, so it takes the same gate the sibling route takes.
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ error: "Only the Super Admin can map VLE categories to departments" });
  }

  const externalId = str(req.body?.externalId);
  if (!externalId) return res.status(400).json({ error: "externalId is required" });

  // PRESENT, AND EITHER A STRING OR AN EXPLICIT NULL. `str(x) || null` returned "" for any
  // NON-STRING and then fell to null -- so a number, an array, an object, a boolean or a
  // field-name typo all became the deliberate un-assign. One such request detaches every
  // course in the category AND every student in their cohorts, returns 200, and writes an
  // audit line reading "un-assigned" as though somebody meant it.
  const rawDept = req.body?.academicDepartmentId;
  if (rawDept !== null && typeof rawDept !== "string") {
    return res.status(400).json({ error: "academicDepartmentId must be a department id, or null to un-assign" });
  }
  const academicDepartmentId = str(rawDept) || null;

  const outcome = await withoutAcademicScope(
    "vle mapping: assigns courses and students across every department",
    async () => {
      // An unknown department is REJECTED, not dropped. Silently ignoring it would leave
      // the screen showing a mapping that was never made.
      let dept = null;
      if (academicDepartmentId) {
        dept = await prisma.academicDepartment.findUnique({ where: { id: academicDepartmentId } });
        if (!dept) return { error: 400, message: "No such academic department" };
      }

      const courses = await prisma.course.findMany({
        where: { vleCategoryExternalId: externalId },
        select: { id: true, name: true },
      });
      if (!courses.length) return { error: 404, message: "No courses carry that VLE category" };

      // THE SHARED HELPER, not a second copy of the transaction. This route and the course
      // routes are the only two writers of Course.academicDepartmentId, and they used to
      // carry the students-follow-the-course logic separately -- which is precisely the
      // drift academicDepartments.js warns about.
      const courseIds = courses.map((c) => c.id);
      const moved = await academicDepartments.assignCourses(prisma, courseIds, academicDepartmentId);
      return { courses, studentCount: moved.studentCount, dept };
    },
  );

  if (outcome.error) return res.status(outcome.error).json({ error: outcome.message });

  audit.record(req, {
    action: "academicDepartments.vleCategoryMapped",
    entity: "AcademicDepartment", entityId: academicDepartmentId || undefined,
    summary: `VLE category ${externalId} (${outcome.courses.length} course(s), ${outcome.studentCount} student(s)) ` +
      (outcome.dept ? `mapped to ${outcome.dept.name}` : "un-assigned") +
      " by " + (req.user?.name || "an administrator"),
    after: {
      externalId, academicDepartmentId,
      courseIds: outcome.courses.map((c) => c.id),
      studentCount: outcome.studentCount,
    },
  });

  res.json({ courseCount: outcome.courses.length, studentCount: outcome.studentCount });
});

module.exports = router;
