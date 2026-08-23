// Assessments & grades (a gradebook for HND units).
// Reads require a signed-in user; every mutation is admin-only.
const router = require("express").Router();
const prisma = require("../db");
const { sAssessment, sGrade, sStudent, sUnit } = require("../serializers");
const { requireAuth, requireAdmin, requirePage, requireAnyPage } = require("../auth");
const { isRealDate } = require("../validate");
const audit = require("../audit");

// The Executive Dashboard is its own admin page, so its summary endpoint accepts
// EITHER "executive" or "assessments". Registered before the router-wide gate below,
// which would otherwise demand "assessments" and leave an executive-only admin
// staring at an empty dashboard.
router.get("/exec-summary", requireAuth, requireAnyPage(["executive", "assessments"]), (req, res, next) => execSummary(req, res).catch(next));

// DEF-01: the gradebook is admin-only (student marks are sensitive; no staff/mobile
// flow reads them). Guard every route, reads included, against non-admin tokens.
router.use(requireAuth, requirePage("assessments"));

const TYPES = ["Assignment", "Exam", "Presentation", "Project", "Portfolio"];
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isInt = (v) => Number.isInteger(v);
// HND-style banding of a percentage.
// The college's grade boundaries: 70+ Distinction, 60-69 Merit, 50-59 Pass, below
// 50 Fail. Repeated in routes/student.js and the client — keep all three in step.
// PASS_MARK is the Pass boundary; pass RATES must use it rather than a literal, or
// the headline pass rate silently disagrees with the Distinction/Merit/Pass counts
// sitting beside it.
const PASS_MARK = 50;
const bandOf = (pct) => (pct == null ? null : pct >= 70 ? "Distinction" : pct >= 60 ? "Merit" : pct >= PASS_MARK ? "Pass" : "Fail");
// Percentage of a mark out of its maximum, clamped to 0–100. The clamp is a safety
// net for any historic row whose mark exceeds the assessment's current maximum — an
// uncapped value would report >100% and skew averages, bands and pass rates.
const pctOf = (marks, max) => (max > 0 ? Math.min(100, Math.max(0, Math.round((marks / max) * 1000) / 10)) : null);

/* ============================== assessments ============================== */

// GET /assessments?unitId=  — assessments with graded count + average mark.
router.get("/", requireAuth, async (req, res) => {
  const unitId = str(req.query?.unitId);
  const rows = await prisma.assessment.findMany({
    where: unitId ? { unitId } : undefined,
    orderBy: [{ unitId: "asc" }, { createdAt: "asc" }],
    include: { unit: { select: { code: true, name: true } }, _count: { select: { grades: true } } },
  });
  // Average mark per assessment, in one grouped query.
  const agg = await prisma.assessmentGrade.groupBy({ by: ["assessmentId"], _avg: { marks: true } });
  const avgById = Object.fromEntries(agg.map((a) => [a.assessmentId, a._avg.marks]));
  res.json(rows.map((a) => {
    const avgMarks = avgById[a.id] != null ? Math.round(avgById[a.id] * 10) / 10 : null;
    return { ...sAssessment(a), avgMarks, avgPct: avgMarks != null ? pctOf(avgMarks, a.maxMarks) : null };
  }));
});

async function validateAssessment(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;
  if (need("unitId")) {
    const unitId = str(body?.unitId);
    if (!unitId) return { error: "Unit is required" };
    const m = await prisma.unit.findUnique({ where: { id: unitId } });
    if (!m) return { error: "Unknown unit" };
    data.unitId = unitId;
  }
  if (need("title")) {
    const title = str(body?.title);
    if (!title) return { error: "Assessment title is required" };
    data.title = title;
  }
  if (body?.type !== undefined) {
    const type = str(body.type);
    if (!TYPES.includes(type)) return { error: `Type must be one of: ${TYPES.join(", ")}` };
    data.type = type;
  }
  if (body?.maxMarks !== undefined) {
    const max = Number(body.maxMarks);
    if (!isInt(max) || max < 1 || max > 1000) return { error: "Max marks must be a whole number between 1 and 1000" };
    data.maxMarks = max;
  }
  if (body?.weight !== undefined) {
    const w = Number(body.weight);
    if (!isInt(w) || w < 0 || w > 100) return { error: "Weight must be a whole number between 0 and 100" };
    data.weight = w;
  }
  if (body?.dueDate !== undefined) {
    const d = str(body.dueDate);
    if (d && !isRealDate(d)) return { error: "Due date must be a valid date (YYYY-MM-DD)" };
    data.dueDate = d || null;
  }
  return { data };
}

router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const v = await validateAssessment(req.body, false);
  if (v.error) return res.status(400).json({ error: v.error });
  const a = await prisma.assessment.create({ data: { type: "Assignment", maxMarks: 100, ...v.data }, include: { unit: { select: { code: true, name: true } }, _count: { select: { grades: true } } } });
  audit.record(req, {
    action: "assessment.created", entity: "Assessment", entityId: a.id,
    summary: `Assessment "${a.title}" created on ${a.unit?.code || "a unit"} — ${a.type}, out of ${a.maxMarks}`,
    after: { title: a.title, type: a.type, maxMarks: a.maxMarks, unitId: a.unitId, dueDate: a.dueDate },
  });
  res.status(201).json(sAssessment(a));
});

router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
  const existing = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Assessment not found" });
  const v = await validateAssessment(req.body, true);
  if (v.error) return res.status(400).json({ error: v.error });
  // Lowering the maximum below a mark that has already been awarded would make that
  // mark score over 100% and silently inflate every average, grade band and pass
  // rate that reads it. Refuse instead, naming the highest mark in the way.
  if (v.data.maxMarks != null && v.data.maxMarks < existing.maxMarks) {
    const top = await prisma.assessmentGrade.aggregate({ where: { assessmentId: existing.id }, _max: { marks: true } });
    const highest = top._max.marks;
    if (highest != null && highest > v.data.maxMarks) {
      return res.status(409).json({ error: `Can't lower the maximum to ${v.data.maxMarks}: a mark of ${highest} has already been awarded. Change that mark first.` });
    }
  }
  const a = await prisma.assessment.update({ where: { id: existing.id }, data: v.data, include: { unit: { select: { code: true, name: true } }, _count: { select: { grades: true } } } });
  // maxMarks in particular: it is the denominator under every mark already awarded,
  // so moving it moves every percentage, band and pass rate derived from this
  // assessment without touching a single grade row.
  //
  // unitId is here for the same reason and was missing. This route accepts a change of
  // unit, and every mark already awarded travels with the assessment — off one unit's
  // average, band distribution and pass rate, and onto another's. The log recorded
  // none of it: unitId was absent from both objects, so diff() found no differences,
  // wrote before/after as null, and a re-filing of a whole gradebook was indis-
  // tinguishable from a save that changed nothing at all.
  const movedUnit = v.data.unitId != null && v.data.unitId !== existing.unitId;
  audit.record(req, {
    action: "assessment.updated", entity: "Assessment", entityId: a.id,
    summary: `Assessment "${a.title}" updated`
      + (movedUnit ? ` — moved to unit ${a.unit?.code || a.unitId}, taking ${a._count.grades} awarded mark(s) off the previous unit's averages` : "")
      + (v.data.maxMarks != null && v.data.maxMarks !== existing.maxMarks ? ` — maximum changed from ${existing.maxMarks} to ${a.maxMarks}, which re-scores every mark already awarded` : ""),
    before: { title: existing.title, type: existing.type, maxMarks: existing.maxMarks, weight: existing.weight, dueDate: existing.dueDate, unitId: existing.unitId },
    after: { title: a.title, type: a.type, maxMarks: a.maxMarks, weight: a.weight, dueDate: a.dueDate, unitId: a.unitId },
  });
  res.json(sAssessment(a));
});

router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  // Read first, so the log can say what went. Deleting an assessment takes every mark
  // awarded under it, which is student academic record, not scaffolding.
  const existing = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { unit: { select: { code: true } }, _count: { select: { grades: true } } } });
  if (!existing) return res.status(404).json({ error: "Assessment not found" });
  try {
    await prisma.assessment.delete({ where: { id: existing.id } });
    audit.record(req, {
      action: "assessment.deleted", entity: "Assessment", entityId: existing.id,
      summary: `Assessment "${existing.title}" on ${existing.unit?.code || "a unit"} deleted, taking ${existing._count.grades} awarded mark(s) with it`,
      before: { title: existing.title, type: existing.type, maxMarks: existing.maxMarks, unitId: existing.unitId, gradesDestroyed: existing._count.grades },
      after: null,
    });
    res.json({ ok: true });
  }
  catch (_e) { res.status(404).json({ error: "Assessment not found" }); }
});

// GET /assessments/grades?courseId=&unitId=&studentId=
// A flat, filterable list of individual grade records for the record-level CRUD
// view. Capped so an unfiltered call can't return the entire gradebook at once.
router.get("/grades", requireAuth, async (req, res) => {
  const courseId = str(req.query?.courseId);
  const unitId = str(req.query?.unitId);
  const studentId = str(req.query?.studentId);
  const where = {};
  if (studentId) where.studentId = studentId;
  if (unitId) where.assessment = { unitId };
  else if (courseId) where.assessment = { is: { unit: { is: { courseId } } } };
  // DEF-06: report the true total and whether the result was truncated, so the UI
  // can tell the user to narrow the filter instead of silently hiding records.
  const LIMIT = 2000;
  const [total, rows] = await Promise.all([
    prisma.assessmentGrade.count({ where }),
    prisma.assessmentGrade.findMany({
      where,
      include: { student: true, assessment: { include: { unit: { select: { code: true, name: true, courseId: true } } } } },
      orderBy: { gradedAt: "desc" },
      take: LIMIT,
    }),
  ]);
  res.json({
    total, returned: rows.length, capped: total > rows.length, limit: LIMIT,
    records: rows.map((g) => {
      const pct = pctOf(g.marks, g.assessment.maxMarks);
      return {
        id: g.id, assessmentId: g.assessmentId, studentId: g.studentId, marks: g.marks, pct, grade: bandOf(pct),
        // Provenance: "manual" marks are protected from the Moodle sync, "moodle" ones
        // are refreshed by it. Surfaced so that guarantee is checkable, not just claimed.
        source: g.source ?? "manual", gradedBy: g.gradedBy ?? null,
        student: { id: g.student.id, name: `${g.student.firstName} ${g.student.lastName}`, studentRef: g.student.studentRef, initials: g.student.initials, colour: g.student.colour },
        assessment: { id: g.assessment.id, title: g.assessment.title, type: g.assessment.type, maxMarks: g.assessment.maxMarks },
        unit: { id: g.assessment.unitId, code: g.assessment.unit.code, name: g.assessment.unit.name, courseId: g.assessment.unit.courseId },
      };
    }),
  });
});

/* ============================== grade entry ============================== */

// GET /assessments/:id/grades — every enrolled student with their mark (if any).
router.get("/:id/grades", requireAuth, async (req, res) => {
  const a = await prisma.assessment.findUnique({ where: { id: req.params.id }, include: { unit: true, grades: true } });
  if (!a) return res.status(404).json({ error: "Assessment not found" });
  const enrolments = await prisma.enrolment.findMany({ where: { unitId: a.unitId }, include: { student: true } });
  const byStudent = new Map(a.grades.map((g) => [g.studentId, g]));
  // Keep a graded student who has since been un-enrolled.
  const extraIds = a.grades.filter((g) => !enrolments.some((e) => e.studentId === g.studentId)).map((g) => g.studentId);
  const extra = extraIds.length ? await prisma.student.findMany({ where: { id: { in: extraIds } } }) : [];
  const students = [...enrolments.map((e) => e.student), ...extra].sort((x, y) => x.lastName.localeCompare(y.lastName) || x.firstName.localeCompare(y.firstName));
  res.json({
    assessment: sAssessment(a), unit: sUnit(a.unit),
    rows: students.map((s) => {
      const g = byStudent.get(s.id);
      const pct = g ? pctOf(g.marks, a.maxMarks) : null;
      // source tells the marker whether this mark is protected from the Moodle sync
      // ("manual") or will be refreshed by it ("moodle"). Without it, that guarantee
      // was only observable on the flat /assessments/grades list.
      return {
        student: sStudent(s), marks: g ? g.marks : null, grade: bandOf(pct), pct,
        source: g ? (g.source ?? "manual") : null, gradedBy: g ? g.gradedBy : null,
        // When this mark last changed here — a full timestamp, so a marker can tell a
        // figure that arrived in this morning's sync from one entered weeks ago.
        // gradedOn is Moodle's own grading date and can be much older, so both travel.
        gradedAt: g ? g.gradedAt : null, gradedOn: g ? (g.gradedOn ?? null) : null,
        enrolled: enrolments.some((e) => e.studentId === s.id),
      };
    }),
  });
});

// PUT /assessments/:id/grades  — bulk upsert. A row with marks null/"" clears it.
router.put("/:id/grades", requireAuth, requireAdmin, async (req, res) => {
  const a = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!a) return res.status(404).json({ error: "Assessment not found" });
  const grades = Array.isArray(req.body?.grades) ? req.body.grades : null;
  if (!grades) return res.status(400).json({ error: "grades array required" });
  // Same cap the identical register endpoint (hnd.js) enforces: a grade save can never
  // legitimately carry more rows than the unit has students. Without it a 1MB body of
  // ~20,000 studentIds forces a 20k-iteration loop plus two huge IN() queries before
  // the enrolment check rejects it — pre-check work heavy enough to stall the API.
  const MAX_GRADE_ROWS = 500;
  if (grades.length > MAX_GRADE_ROWS) return res.status(400).json({ error: `Too many rows in one save (limit ${MAX_GRADE_ROWS})` });

  const rows = [];
  for (const g of grades) {
    const studentId = str(g?.studentId);
    if (!studentId) return res.status(400).json({ error: "Each grade needs a studentId" });
    let marks = g?.marks;
    // "Not marked yet" and "scored nothing" are different facts, and only an explicit
    // clear may mean the first. Number() on its own turned a whitespace-only cell into
    // 0, an empty array into 0 and `true` into 1 — all of them saved silently as real
    // marks, so a student nobody had marked was recorded as having scored zero. That
    // drags the unit average down and fails them on a mark that was never awarded.
    // Trim first (a spacebar is not a mark), then accept only a number or a numeric
    // string; the string form has to stay because the grade grid posts its cells as
    // text.
    if (typeof marks === "string") marks = marks.trim();
    if (marks === "" || marks == null) { rows.push({ studentId, marks: null }); continue; }
    if (typeof marks !== "number" && typeof marks !== "string") return res.status(400).json({ error: `Marks must be a whole number between 0 and ${a.maxMarks}` });
    marks = Number(marks);
    if (!isInt(marks) || marks < 0 || marks > a.maxMarks) return res.status(400).json({ error: `Marks must be a whole number between 0 and ${a.maxMarks}` });
    rows.push({ studentId, marks });
  }
  const ids = rows.map((r) => r.studentId);
  if (ids.length !== new Set(ids).size) return res.status(400).json({ error: "The same student appears twice in one save" });
  if (ids.length) {
    // Enrolment, not mere existence — the register endpoint already works this way.
    // Checking only that the student exists let a mistyped id attach a mark to
    // somebody who was never on the unit.
    const enrolled = await prisma.enrolment.findMany({ where: { unitId: a.unitId, studentId: { in: ids } }, select: { studentId: true } });
    const okIds = new Set(enrolled.map((e) => e.studentId));
    // A student marked before being un-enrolled stays editable, so historic marks
    // remain correctable.
    if (okIds.size !== ids.length) {
      const existing = await prisma.assessmentGrade.findMany({ where: { assessmentId: a.id, studentId: { in: ids } }, select: { studentId: true } });
      for (const e of existing) okIds.add(e.studentId);
    }
    const stray = ids.filter((id) => !okIds.has(id));
    if (stray.length) return res.status(400).json({ error: `${stray.length} student${stray.length === 1 ? " is" : "s are"} not enrolled on this unit` });
  }
  const gradedBy = req.user?.name || null;
  // The marks as they stand, read before the write. A grade save is a bulk upsert, so
  // without this snapshot the log could say a mark was set but never what it replaced
  // — and "it used to be 62" is the whole substance of a marking dispute.
  const priorRows = await prisma.assessmentGrade.findMany({ where: { assessmentId: a.id }, select: { studentId: true, marks: true } });
  const prior = new Map(priorRows.map((g) => [g.studentId, g.marks]));
  await prisma.$transaction(rows.map((r) => (
    r.marks === null
      ? prisma.assessmentGrade.deleteMany({ where: { assessmentId: a.id, studentId: r.studentId } })
      : prisma.assessmentGrade.upsert({
          where: { assessmentId_studentId: { assessmentId: a.id, studentId: r.studentId } },
          // source: "manual" on BOTH branches. A mark a person typed must carry that
          // provenance, or the Moodle sync — which only spares source === "manual" —
          // silently reverts the correction on its next run. The schema default only
          // applies on create, so the update branch omitting it meant every mark that
          // originated in Moodle could never be corrected durably.
          create: { assessmentId: a.id, studentId: r.studentId, marks: r.marks, gradedBy, source: "manual" },
          update: { marks: r.marks, gradedBy, gradedAt: new Date(), source: "manual" },
        })
  )));
  // One row for the save, carrying only the marks that actually MOVED. A register
  // screen re-submits every student on the unit whether or not anything changed, so
  // logging the payload would bury one corrected mark under forty unchanged ones.
  // Keyed by student id: audit.js caps the object at 40 keys, which is more than a
  // real marking session touches and stops a 500-row bulk import from writing a
  // 500-key blob into the log.
  const before = {}, after = {};
  for (const r of rows) {
    const was = prior.has(r.studentId) ? prior.get(r.studentId) : null;
    if (was === r.marks) continue;
    before[r.studentId] = was;
    after[r.studentId] = r.marks;
  }
  const moved = Object.keys(after).length;
  if (moved) {
    const cleared = Object.values(after).filter((m) => m === null).length;
    audit.record(req, {
      action: "assessment.grades.saved", entity: "Assessment", entityId: a.id,
      summary: `${moved} mark(s) changed on "${a.title}" (out of ${a.maxMarks}) by ${gradedBy || "an administrator"}` + (cleared ? `, ${cleared} of them cleared` : ""),
      before, after,
    });
  }

  const saved = await prisma.assessmentGrade.findMany({ where: { assessmentId: a.id } });
  res.json({ ok: true, saved: saved.length });
});

/* ============================== analytics ============================== */

// GET /assessments/overview — per-unit averages + distribution + overall.
router.get("/overview", requireAuth, async (_req, res) => {
  const [assessments, units, allGrades] = await Promise.all([
    prisma.assessment.findMany({ select: { id: true, unitId: true, maxMarks: true } }),
    prisma.unit.findMany({ orderBy: { code: "asc" }, include: { _count: { select: { enrolments: true, assessments: true } } } }),
    prisma.assessmentGrade.findMany({ select: { assessmentId: true, marks: true } }),
  ]);
  const aMap = new Map(assessments.map((a) => [a.id, a]));
  const perUnit = new Map(units.map((m) => [m.id, { sum: 0, n: 0, dist: { Distinction: 0, Merit: 0, Pass: 0, Fail: 0 } }]));
  let sumAll = 0, nAll = 0, passAll = 0;
  const distAll = { Distinction: 0, Merit: 0, Pass: 0, Fail: 0 };
  for (const g of allGrades) {
    const a = aMap.get(g.assessmentId); if (!a) continue;
    const pct = pctOf(g.marks, a.maxMarks); if (pct == null) continue;
    const band = bandOf(pct);
    const pm = perUnit.get(a.unitId); if (pm) { pm.sum += pct; pm.n++; pm.dist[band]++; }
    sumAll += pct; nAll++; distAll[band]++; if (pct >= PASS_MARK) passAll++;
  }
  const unitsOut = units.map((m) => {
    const pm = perUnit.get(m.id);
    return {
      id: m.id, code: m.code, name: m.name,
      students: m._count.enrolments, assessmentCount: m._count.assessments,
      gradedCount: pm.n, avgPct: pm.n ? Math.round((pm.sum / pm.n) * 10) / 10 : null, dist: pm.dist,
    };
  });
  res.json({
    overall: {
      assessments: assessments.length, gradedSubmissions: nAll,
      avgPct: nAll ? Math.round((sumAll / nAll) * 10) / 10 : null,
      passRate: nAll ? Math.round((passAll / nAll) * 1000) / 10 : null,
      dist: distAll,
    },
    units: unitsOut,
  });
});

// GET /assessments/student/:id — one student's assessments, marks, grades + average.
router.get("/student/:id", requireAuth, async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.params.id }, include: { enrolments: { select: { unitId: true } } } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  const unitIds = student.enrolments.map((e) => e.unitId);
  const assessments = await prisma.assessment.findMany({
    where: { unitId: { in: unitIds.length ? unitIds : ["__none__"] } },
    include: { unit: { select: { code: true, name: true } } },
    orderBy: [{ unitId: "asc" }, { createdAt: "asc" }],
  });
  const grades = await prisma.assessmentGrade.findMany({ where: { studentId: student.id } });
  const gMap = new Map(grades.map((g) => [g.assessmentId, g]));
  let sum = 0, n = 0;
  const items = assessments.map((a) => {
    const g = gMap.get(a.id);
    const pct = g ? pctOf(g.marks, a.maxMarks) : null;
    if (pct != null) { sum += pct; n++; }
    return { id: a.id, title: a.title, type: a.type, maxMarks: a.maxMarks, weight: a.weight, dueDate: a.dueDate, unitCode: a.unit.code, unitName: a.unit.name, unitId: a.unitId, marks: g ? g.marks : null, pct, grade: bandOf(pct) };
  });
  res.json({
    student: sStudent(student),
    assessments: items,
    count: items.length, graded: n,
    averagePct: n ? Math.round((sum / n) * 10) / 10 : null,
    averageGrade: n ? bandOf(Math.round((sum / n) * 10) / 10) : null,
  });
});

// GET /assessments/exec-summary — college-wide pass statistics for the Executive
// Dashboard. A student "passes" if their AVERAGE graded mark is at or above PASS_MARK. Results are
// grouped by cohort (the "course"), plus per-course pass-rate. Heavy per-student
// aggregation done here (server-side) so the client never fetches 100s of students.
async function execSummary(req, res) {
  const [students, assessments, grades, cohorts, courseList, unitList, enrolments] = await Promise.all([
    prisma.student.findMany({ select: { id: true, cohortId: true } }),
    prisma.assessment.findMany({ select: { id: true, maxMarks: true, unitId: true } }),
    prisma.assessmentGrade.findMany({ select: { studentId: true, assessmentId: true, marks: true } }),
    prisma.cohort.findMany({ select: { id: true, name: true, courseId: true } }),
    prisma.course.findMany({ select: { id: true, name: true } }),
    prisma.unit.findMany({ select: { id: true, courseId: true } }),
    prisma.enrolment.findMany({ select: { studentId: true, unitId: true } }),
  ]);
  // How many assessments belong to each course (via unit → course).
  const unitCourse = new Map(unitList.map((u) => [u.id, u.courseId || null]));
  const assessByCourse = new Map();
  for (const a of assessments) {
    const cid = unitCourse.get(a.unitId) || "__none__";
    assessByCourse.set(cid, (assessByCourse.get(cid) || 0) + 1);
  }
  // Each student's course from their ENROLLED UNITS (the course whose units they're
  // on most). This is how students are actually put on a course, so it's the primary
  // signal — a cohort link is only a fallback. Fixes students showing "Unassigned".
  const stuCourseCount = new Map(); // studentId -> Map(courseId -> unit count)
  for (const e of enrolments) {
    const cid = unitCourse.get(e.unitId); if (!cid) continue;
    if (!stuCourseCount.has(e.studentId)) stuCourseCount.set(e.studentId, new Map());
    const m = stuCourseCount.get(e.studentId); m.set(cid, (m.get(cid) || 0) + 1);
  }
  const studentCourse = new Map();
  for (const [sid, m] of stuCourseCount) {
    let best = null, n = 0; for (const [cid, c] of m) if (c > n) { best = cid; n = c; }
    if (best) studentCourse.set(sid, best);
  }
  const aMax = new Map(assessments.map((a) => [a.id, a.maxMarks]));
  // Average graded % per student.
  const perStudent = new Map();
  for (const g of grades) {
    const max = aMax.get(g.assessmentId); if (!max) continue;
    const pct = pctOf(g.marks, max); if (pct == null) continue;
    const s = perStudent.get(g.studentId) || { sum: 0, n: 0 };
    s.sum += pct; s.n += 1; perStudent.set(g.studentId, s);
  }
  // Map a student to their Course via their cohort (student → cohort → course).
  // Students with no cohort, or a cohort with no course, are "Unassigned".
  const cohortCourse = new Map(cohorts.map((c) => [c.id, c.courseId || null]));
  // Seed a bucket for EVERY course up front, so a course with no students yet
  // still appears on the dashboard (that was the missing piece).
  const byCourse = new Map();
  for (const c of courseList) byCourse.set(c.id, { code: c.name, count: 0, passed: 0, graded: 0 });
  byCourse.set("__none__", { code: "Unassigned", count: 0, passed: 0, graded: 0 });
  let totalPassed = 0, totalGraded = 0;
  for (const st of students) {
    const key = studentCourse.get(st.id) || (st.cohortId && cohortCourse.get(st.cohortId)) || "__none__";
    const b = byCourse.get(key) || byCourse.get("__none__");
    b.count += 1;
    const g = perStudent.get(st.id);
    if (g && g.n > 0) {
      b.graded += 1; totalGraded += 1;
      if (g.sum / g.n >= PASS_MARK) { b.passed += 1; totalPassed += 1; }
    }
  }
  // Pass rate is measured over students who have actually been ASSESSED (graded),
  // not the whole headcount — otherwise every un-marked student counts as a failure
  // and a course reads 0% until marking is complete. Matches /overview's definition.
  const courses = [...byCourse.entries()]
    .map(([cid, b]) => ({
      courseId: cid, code: b.code,
      studentCount: b.count, studentsPassed: b.passed, graded: b.graded,
      assessments: assessByCourse.get(cid) || 0,
      passRate: b.graded ? Math.round((b.passed / b.graded) * 1000) / 10 : null,
    }))
    .filter((c) => c.courseId !== "__none__" || c.studentCount > 0) // hide empty "Unassigned"
    .sort((a, b) => b.studentCount - a.studentCount);
  res.json({
    totals: {
      students: students.length,
      studentsPassed: totalPassed,
      graded: totalGraded,
      passRate: totalGraded ? Math.round((totalPassed / totalGraded) * 1000) / 10 : null,
      assessments: assessments.length,
      courses: courseList.length,
    },
    courses,
  });
}

module.exports = router;
module.exports.TYPES = TYPES;
