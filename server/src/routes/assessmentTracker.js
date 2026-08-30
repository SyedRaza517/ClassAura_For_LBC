// The assessment tracker — a management read-model over work that is already in the
// database. READ-ONLY, deliberately: the setup grid's two saves go to narrow doors on
// the routers that already own those columns (PUT /hnd/units/:id/leader and
// PUT /assessments/:id/marking-deadline), because a second general writer is a second
// place for the validation to drift out of step with the first.
//
// Nothing here is cached or materialised. A tracker row is three counts and some
// division; the prediction engine's cache exists because SCORING is expensive, and
// copying that pattern here would buy no measurable time while adding a whole class of
// staleness bug.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { localDate } = require("../clock");
const calc = require("../assessmentTracker");

router.use(requireAuth, requirePage("assessment-tracker"));

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Does this college record submission data AT ALL?
 *
 * One unfiltered count, evaluated ONCE per request and never inside a per-row loop.
 * This is the institution-wide question, and computing it from the rows on screen
 * answers a question about the view instead of about the college — the most repeated
 * bug in this codebase, got wrong three times in the prediction pipeline alone.
 *
 * It changes no figure. Every null in this file comes from the per-assessment rule in
 * submittedFor() below. What this decides is the WORDING: with no rows anywhere the
 * client says "Not synced", because the honest explanation is that no integration is
 * feeding it; with rows elsewhere in the college an individual gap says "Awaiting
 * sync", because the college's other modules plainly are covered.
 */
const recordsSubmissions = async () => (await prisma.assessmentSubmission.count()) > 0;

/**
 * How many students submitted this assessment — or null if we cannot say.
 *
 * A ROW MEANS "WE LOOKED". Presence of any AssessmentSubmission row for an assessment
 * is the evidence that the question was asked of it; with no rows at all, no count can
 * separate "the sync has not reached this assessment" from "fifty students ignored it",
 * and reporting the second when the first is true invents a crisis out of a gap in an
 * integration. This is the same rule vle/engagementNormalise.js already established for
 * VLE engagement, where absence IS the institution guard.
 *
 * Given rows, the count of status="submitted" is a real, earned figure — and a zero
 * there is a real zero.
 */
function submittedFor(byAssessment, assessmentId) {
  const seen = byAssessment.get(assessmentId);
  if (!seen) return null;
  return seen.submitted;
}

// GET /  — one row per assessment. Filters are all optional and all narrowing.
router.get("/", async (req, res) => {
  const courseId = str(req.query?.courseId);
  const cohortId = str(req.query?.cohortId);
  const termId = str(req.query?.termId);
  const unitId = str(req.query?.unitId);

  const unitWhere = {};
  if (unitId) unitWhere.id = unitId;
  if (courseId) unitWhere.courseId = courseId;
  if (cohortId) unitWhere.cohortId = cohortId;
  if (termId) unitWhere.termId = termId;

  const units = await prisma.unit.findMany({
    where: unitWhere,
    select: {
      id: true, code: true, name: true, tutor: true,
      leaderStaffId: true,
      leaderStaff: { select: { name: true } },
      tutorStaff: { select: { name: true } },
      cohort: { select: { id: true, name: true } },
      course: { select: { name: true } },
    },
    orderBy: [{ code: "asc" }],
  });
  const unitIds = units.map((u) => u.id);
  if (!unitIds.length) return res.json({ recordsSubmissions: await recordsSubmissions(), rows: [] });

  const assessments = await prisma.assessment.findMany({
    where: { unitId: { in: unitIds } },
    select: { id: true, unitId: true, title: true, type: true, dueDate: true, markingDueDate: true },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });
  const assessmentIds = assessments.map((a) => a.id);

  // Three grouped counts, not one query per row. At a college with 40 units and 200
  // assessments the per-row shape would be 600 round trips to paint one screen.
  const [enrolCounts, gradeCounts, submissionCounts, everRecorded] = await Promise.all([
    prisma.enrolment.groupBy({ by: ["unitId"], where: { unitId: { in: unitIds } }, _count: { _all: true } }),
    assessmentIds.length
      ? prisma.assessmentGrade.groupBy({ by: ["assessmentId"], where: { assessmentId: { in: assessmentIds } }, _count: { _all: true } })
      : [],
    assessmentIds.length
      ? prisma.assessmentSubmission.groupBy({ by: ["assessmentId", "status"], where: { assessmentId: { in: assessmentIds } }, _count: { _all: true } })
      : [],
    recordsSubmissions(),
  ]);

  const enrolled = new Map(enrolCounts.map((r) => [r.unitId, r._count._all]));
  const marked = new Map(gradeCounts.map((r) => [r.assessmentId, r._count._all]));
  // Only assessments appearing here have been looked at — see submittedFor above. The
  // map is keyed on every status, not just "submitted", precisely so that an assessment
  // whose rows are all "not_submitted" still counts as looked-at and reports 0 rather
  // than null.
  const submissions = new Map();
  for (const r of submissionCounts) {
    const cur = submissions.get(r.assessmentId) || { submitted: 0 };
    if (r.status === "submitted") cur.submitted += r._count._all;
    submissions.set(r.assessmentId, cur);
  }

  const today = localDate();   // APP_TIMEZONE, never the host clock
  const unitById = new Map(units.map((u) => [u.id, u]));

  const rows = assessments.map((a) => {
    const u = unitById.get(a.unitId);
    const enrolledCount = enrolled.get(a.unitId) ?? 0;
    const markedCount = marked.get(a.id) ?? 0;
    const submittedCount = submittedFor(submissions, a.id);
    return {
      assessmentId: a.id, title: a.title, type: a.type,
      unitId: a.unitId, unitCode: u?.code ?? "", unitName: u?.name ?? "",
      cohortId: u?.cohort?.id ?? null, cohortName: u?.cohort?.name ?? null,
      courseName: u?.course?.name ?? null,
      leaderStaffId: u?.leaderStaffId ?? null,
      leaderName: u?.leaderStaff?.name ?? null,
      // Falls back to the free-text `tutor`, which is the only name a unit assigned
      // before staff accounts were linked to units has.
      lecturerName: u?.tutorStaff?.name ?? u?.tutor ?? null,
      enrolled: enrolledCount,
      dueDate: a.dueDate ?? null,
      dueState: calc.deadlineState(a.dueDate, today),
      submitted: submittedCount,
      submissionRate: calc.submissionRate(submittedCount, enrolledCount),
      marked: markedCount,
      coverageRate: calc.coverageRate(markedCount, enrolledCount),
      markingRate: calc.markingRate(markedCount, submittedCount),
      markingDueDate: a.markingDueDate ?? null,
      markingState: calc.markingState(a.markingDueDate, markedCount, submittedCount, today),
    };
  });

  res.json({ recordsSubmissions: everRecorded, rows });
});

// GET /setup  — the module grid, plus the staff list its leader picker needs.
router.get("/setup", async (_req, res) => {
  const [units, staff] = await Promise.all([
    prisma.unit.findMany({
      select: {
        id: true, code: true, name: true, tutor: true,
        leaderStaffId: true,
        leaderStaff: { select: { name: true } },
        tutorStaff: { select: { name: true } },
        cohort: { select: { name: true } },
        course: { select: { name: true } },
        _count: { select: { enrolments: true } },
        assessments: {
          select: { id: true, title: true, dueDate: true, markingDueDate: true },
          orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
        },
      },
      orderBy: [{ code: "asc" }],
    }),
    // Anyone with an account can lead a module; the picker does not filter on role,
    // because a module leader is not necessarily an ADMIN in this system. There is no
    // `active` flag on Staff to filter on either — checked against schema.prisma.
    prisma.staff.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  res.json({
    modules: units.map((u) => ({
      unitId: u.id, unitCode: u.code, unitName: u.name,
      cohortName: u.cohort?.name ?? null,
      courseName: u.course?.name ?? null,
      lecturerName: u.tutorStaff?.name ?? u.tutor ?? null,
      leaderStaffId: u.leaderStaffId ?? null,
      leaderName: u.leaderStaff?.name ?? null,
      enrolled: u._count.enrolments,
      assessments: u.assessments.map((a) => ({
        id: a.id, title: a.title,
        dueDate: a.dueDate ?? null, markingDueDate: a.markingDueDate ?? null,
      })),
    })),
    staff,
  });
});

module.exports = router;
