// The student app's own endpoints. Every route is scoped to the signed-in student
// (req.user.id) — a student can only ever see their own data. requireAuth's student
// branch already blocks student tokens from every other router.
const router = require("express").Router();
const prisma = require("../db");
const { sUnit, sStudent, sStudentQuery } = require("../serializers");
const { requireAuth, requireStudent } = require("../auth");
const { summarise } = require("../attendance");
const { localDate, localTime } = require("../clock");
const { notifyAdmins } = require("../notify");
const audit = require("../audit");
const tapConfig = require("../attendanceTapConfig");
const predictionRunner = require("../prediction/runner");
const { resolveTapSession, statusFor, SELF_CHECKIN_STAMP } = require("../attendanceTap");
const { isString } = require("../validate");

router.use(requireAuth, requireStudent);

// 70+ Distinction, 60-69 Merit, 50-59 Pass, below 50 Fail. Must match the same
// boundaries in routes/assessments.js and the client.
const bandOf = (pct) => (pct == null ? null : pct >= 70 ? "Distinction" : pct >= 60 ? "Merit" : pct >= 50 ? "Pass" : "Fail");
// Clamped 0–100, matching the admin gradebook: an historic mark above its
// assessment maximum would otherwise show the student a percentage over 100.
const pctOf = (marks, max) => (max > 0 ? Math.min(100, Math.max(0, Math.round((marks / max) * 1000) / 10)) : null);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/* ============================== NFC tap check-in ============================== */

// In-process, module-level, and therefore correct for ONE Node process — a clustered
// deployment needs Redis. Keyed on the student because the caller is already
// authenticated: this is not a login endpoint, so the point is to stop a runaway loop,
// not to ration people who are standing in a doorway.
const tapHits = new Map(); // studentId -> number[] of timestamps
const TAP_WINDOW_MS = 60_000;
const TAP_MAX = 10;
function tapAllowed(studentId) {
  const now = Date.now();
  const recent = (tapHits.get(studentId) || []).filter((t) => now - t < TAP_WINDOW_MS);
  if (recent.length >= TAP_MAX) { tapHits.set(studentId, recent); return false; }
  recent.push(now);
  tapHits.set(studentId, recent);
  return true;
}

/**
 * Record what happened, whatever happened.
 *
 * Never throws into the request. A tap that WAS marked must not report a failure because
 * the log write did — the register is the record, this is the account of it.
 */
async function logTap(req, fields) {
  try {
    await prisma.tagTap.create({ data: { ip: req.ip ? String(req.ip).slice(0, 60) : null, ...fields } });
  } catch (e) {
    console.error("[tap] could not log a student tap:", e.message);
  }
}

/** Today's sessions on units this student is enrolled on, shaped for the resolver. */
async function candidateSessions(studentId, date) {
  const enrolments = await prisma.enrolment.findMany({ where: { studentId }, select: { unitId: true } });
  const unitIds = enrolments.map((e) => e.unitId);
  if (!unitIds.length) return [];
  const sessions = await prisma.hndSession.findMany({
    where: { date, unitId: { in: unitIds } },
    include: { unit: { select: { code: true, name: true, term: { select: { name: true, start: true, end: true } } } } },
  });
  return sessions.map((s) => ({
    id: s.id,
    unitId: s.unitId,
    unitCode: s.unit?.code || "",
    unitName: s.unit?.name || "",
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    term: s.unit?.term ? { name: s.unit.term.name, start: s.unit.term.start, end: s.unit.term.end } : null,
  }));
}

/** What a session looks like on the check-in screen. No other student's data, ever. */
const sTapSession = (s) => ({ id: s.id, unitCode: s.unitCode, unitName: s.unitName, startTime: s.startTime, endTime: s.endTime });

// GET /api/student/me/tap-context — what the check-in screen shows before a tap.
//
// This student's classes today and whether taps are being accepted right now. Keyed on
// req.user.id like every other route in this file; no id parameter exists, so there is
// nothing to tamper with.
router.get("/me/tap-context", async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.enabled) return res.json({ enabled: false, armSeconds: settings.armSeconds, now: null, next: null });

  const date = localDate();
  const time = localTime();
  const candidates = await candidateSessions(req.user.id, date);
  const decision = resolveTapSession(candidates, { date, time }, settings);

  // The classes still to come today, so the screen can say "your next class is at 13:00"
  // rather than only "nothing on now" — which reads as a fault rather than a timetable.
  const later = candidates
    .filter((s) => s.startTime > time)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  res.json({
    enabled: true,
    armSeconds: settings.armSeconds,
    date,
    now: decision.kind === "one" ? [sTapSession(decision.session)]
       : decision.kind === "ambiguous" ? decision.sessions.map(sTapSession)
       : [],
    reason: decision.kind === "none" ? decision.reason : null,
    next: later.length ? sTapSession(later[0]) : null,
  });
});

// POST /api/student/me/tap-check-in — mark this student present at the class running now.
//
// Writes an ordinary P or L into the existing register. Three things it must never do,
// each of which would damage a record the college is asked to evidence:
//   * overwrite a mark a lecturer already set — the human in the room wins, the same
//     invariant the Moodle importer holds;
//   * write an A — absence is what an untaken register already means, and scoring "did
//     not tap" as absent turns a flat battery into a permanent academic record;
//   * bypass the term lock, which the register save enforces with a 423.
router.post("/me/tap-check-in", async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.enabled) return res.status(403).json({ error: "Tap check-in isn't switched on for this college." });

  const code = req.body?.tagCode;
  if (!isString(code) || !code.trim()) return res.status(400).json({ error: "A tag is required" });
  const chosenId = req.body?.sessionId;
  if (chosenId != null && !isString(chosenId)) return res.status(400).json({ error: "sessionId must be text" });

  if (!tapAllowed(req.user.id)) return res.status(429).json({ error: "Too many attempts — wait a moment and try again." });

  // Tenant-scoped by db.js, so a tag belonging to another college is simply not found.
  // That is the isolation working; it needs no special case here.
  const tag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
  if (!tag) return res.status(404).json({ error: "That tag isn't recognised." });

  const date = localDate();
  const time = localTime();
  const candidates = await candidateSessions(req.user.id, date);
  const decision = resolveTapSession(candidates, { date, time }, settings);

  const base = { tagId: tag.id, studentId: req.user.id };

  if (decision.kind === "none") {
    await logTap(req, { ...base, outcome: decision.reason });
    return res.status(409).json({
      error: decision.reason === "term_locked"
        ? "That class is outside its teaching term, so the register is closed."
        : "No class of yours is running right now.",
      reason: decision.reason,
    });
  }

  let chosen;
  if (decision.kind === "ambiguous") {
    chosen = chosenId ? decision.sessions.find((s) => s.id === chosenId) : null;
    if (!chosen) {
      await logTap(req, { ...base, outcome: "ambiguous" });
      return res.status(409).json({ reason: "ambiguous", sessions: decision.sessions.map(sTapSession) });
    }
  } else {
    chosen = decision.session;
    // A sessionId naming something else is a stale screen or a tampered body. It must
    // not silently mark a different class than the one the student was shown.
    if (chosenId && chosenId !== chosen.id) return res.status(409).json({ error: "That class is no longer running. Try again." });
  }

  // Recomputed for the CHOSEN session rather than reusing the single-session verdict: an
  // ambiguous pick may be a class that started at a different time, and inheriting the
  // first candidate's answer would mark a punctual student late.
  const status = statusFor(chosen, { date, time }, settings);

  const existing = await prisma.attendanceMark.findUnique({
    where: { sessionId_studentId: { sessionId: chosen.id, studentId: req.user.id } },
  });
  if (existing) {
    await logTap(req, { ...base, sessionId: chosen.id, outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: existing.status, checkedInAt: existing.checkedInAt ?? null, session: sTapSession(chosen) });
  }

  const mark = await prisma.attendanceMark.create({
    data: { sessionId: chosen.id, studentId: req.user.id, status, remark: "", takenBy: SELF_CHECKIN_STAMP, checkedInAt: time },
  });

  await prisma.attendanceTag.update({ where: { id: tag.id }, data: { lastTapAt: new Date() } });
  await logTap(req, { ...base, sessionId: chosen.id, outcome: "marked", status });

  // Attendance feeds the progression score, and none of that is written by the
  // prediction feature itself — so anything that touches a mark has to say so. Cheap,
  // and deliberately does NOT rescore: a check-in must not wait on arithmetic. Never
  // throws into a request that has already written; the mark is saved either way.
  try { await predictionRunner.markStale([req.user.id]); }
  catch (e) { console.error("[prediction] could not flag a score after a tap check-in:", e.message); }

  audit.record(req, {
    action: "attendance.tap.marked",
    entity: "AttendanceMark", entityId: mark.id,
    summary: `Student ${req.user.name || "unknown"} (${req.user.studentRef || "no ref"}) checked themselves in at ${time} on the ${chosen.date} register for ${chosen.unitCode || "a unit"} — recorded ${status} via tag "${tag.label}"`,
    before: null,
    after: { sessionId: chosen.id, status, checkedInAt: time, tag: tag.label },
  });

  res.status(201).json({ ok: true, status, checkedInAt: time, session: sTapSession(chosen) });
});

// GET /api/student/me — the signed-in student's own profile.
router.get("/me", async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.user.id }, include: { enrolments: { select: { unitId: true } } } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  res.json(sStudent(student));
});

// GET /api/student/me/attendance — current vs previous units by each unit's last
// session date, with per-unit and current-overall percentages. Mirrors the admin
// per-student breakdown but locked to this student.
router.get("/me/attendance", async (req, res) => {
  const sid = req.user.id;
  const student = await prisma.student.findUnique({ where: { id: sid }, include: { enrolments: { select: { unitId: true } } } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  const enrolledIds = student.enrolments.map((e) => e.unitId);
  const safeIds = enrolledIds.length ? enrolledIds : ["__none__"];

  const [units, marks, sessions] = await Promise.all([
    prisma.unit.findMany({ where: { id: { in: safeIds } } }),
    prisma.attendanceMark.findMany({ where: { studentId: sid }, select: { status: true, sessionId: true } }),
    prisma.hndSession.findMany({ where: { unitId: { in: safeIds } }, select: { id: true, unitId: true, date: true } }),
  ]);

  const today = localDate();
  const endByUnit = new Map();
  const sessMod = new Map();
  for (const s of sessions) { sessMod.set(s.id, s.unitId); const cur = endByUnit.get(s.unitId); if (!cur || s.date > cur) endByUnit.set(s.unitId, s.date); }
  const marksByUnit = new Map();
  for (const m of marks) { const mid = sessMod.get(m.sessionId); if (!mid) continue; if (!marksByUnit.has(mid)) marksByUnit.set(mid, []); marksByUnit.get(mid).push(m); }

  // A unit is FINISHED when its teaching window has passed. The window (Unit.endDate)
  // is what staff see on the Registers tab, so both sides now agree; the last-session
  // date is only a fallback for units nobody has scheduled yet. Using the session date
  // alone meant a unit whose registers were generated a term at a time dropped out of
  // a student's current attendance months before staff considered it over.
  const rowFor = (mod) => {
    const lastSession = endByUnit.get(mod.id) || null;
    const endDate = mod.endDate || lastSession;
    return {
      unit: sUnit(mod),
      summary: summarise(marksByUnit.get(mod.id) || []),
      endDate, lastSessionDate: lastSession,
      finished: !!(endDate && endDate < today),
    };
  };
  const rows = units.map(rowFor);
  const current = rows.filter((r) => !r.finished).sort((a, b) => (a.endDate || "9999").localeCompare(b.endDate || "9999"));
  const previous = rows.filter((r) => r.finished).sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""));
  const currentOverall = summarise(current.flatMap((r) => marksByUnit.get(r.unit.id) || []));

  // Back-compat: the Course→Unit rename renamed `module`→`unit` and `modules`→`units`
  // in this response. Older installed app builds still read the OLD keys, so we send
  // BOTH — new builds use unit/units, old installed builds keep working (no reinstall).
  const alias = (r) => ({ ...r, module: r.unit });
  res.json({
    current: { units: current.map(alias), modules: current.map(alias), overall: currentOverall },
    previous: previous.map(alias),
  });
});

// GET /api/student/me/assessments — this student's assessments, marks, grades, average.
router.get("/me/assessments", async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.user.id }, include: { enrolments: { select: { unitId: true } } } });
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
    return { id: a.id, title: a.title, type: a.type, maxMarks: a.maxMarks, weight: a.weight, dueDate: a.dueDate, unitCode: a.unit.code, unitName: a.unit.name, unitId: a.unitId, moduleCode: a.unit.code, moduleName: a.unit.name, moduleId: a.unitId, marks: g ? g.marks : null, feedback: g ? g.feedback : "", pct, grade: bandOf(pct) };
  });
  res.json({
    assessments: items, count: items.length, graded: n,
    averagePct: n ? Math.round((sum / n) * 10) / 10 : null,
    averageGrade: n ? bandOf(Math.round((sum / n) * 10) / 10) : null,
  });
});

// GET /api/student/me/timetable — the weekly timetable relevant to this student.
//
// A student's course/year/term is derived from the units they are ENROLLED on (a
// cohort is set for very few students, so enrolments are the reliable signal). Their
// timetable is every slot whose (courseId, year, termNumber) matches one of those
// enrolled units — which includes the workshop/support rows that share the same scope
// but are not units. Grouped by stage so the app can show one course/year/term block.
router.get("/me/timetable", async (req, res) => {
  const student = await prisma.student.findUnique({
    where: { id: req.user.id },
    include: { enrolments: { include: { unit: { select: { courseId: true, year: true, termNumber: true, startDate: true, endDate: true } } } } },
  });
  if (!student) return res.status(404).json({ error: "Student not found" });

  // The distinct (course, year, term) stages the student's units place them in, and the
  // term's date window per stage (earliest unit start, latest unit end) for the header.
  const stageKeys = new Set();
  const winStart = new Map(), winEnd = new Map();  // stageKey -> earliest start / latest end
  for (const e of student.enrolments) {
    const u = e.unit;
    if (u?.courseId == null || u.year == null || u.termNumber == null) continue;
    const key = `${u.courseId}|${u.year}|${u.termNumber}`;
    stageKeys.add(key);
    if (u.startDate && (!winStart.has(key) || u.startDate < winStart.get(key))) winStart.set(key, u.startDate);
    if (u.endDate && (!winEnd.has(key) || u.endDate > winEnd.get(key))) winEnd.set(key, u.endDate);
  }
  if (!stageKeys.size) return res.json({ stages: [] });

  const or = [...stageKeys].map((k) => { const [courseId, year, termNumber] = k.split("|"); return { courseId, year: Number(year), termNumber: Number(termNumber) }; });
  // Only PUBLISHED rows/calendars — a draft the admin is still building stays invisible
  // to students until they press Publish.
  const slots = await prisma.timetableSlot.findMany({
    where: { published: true, OR: or },
    include: { course: { select: { name: true, colour: true } }, unit: { select: { code: true } } },
    orderBy: [{ day: "asc" }, { startTime: "asc" }],
  });
  // Best-effort: a missing calendar table must not stop the timetable itself loading.
  let calendars = [];
  try { calendars = await prisma.termCalendar.findMany({ where: { published: true, OR: or }, include: { course: { select: { name: true, colour: true } } } }); } catch (_e) { calendars = []; }

  // One block per (course, year, term) — from either a timetable row or a calendar.
  const byStage = new Map();
  const ensure = (courseId, year, termNumber, courseName, colour) => {
    const key = `${courseId}|${year}|${termNumber}`;
    if (!byStage.has(key)) {
      const win = { start: winStart.get(key) || null, end: winEnd.get(key) || null };
      byStage.set(key, { courseId, courseName: courseName || "", colour: colour || null, year, termNumber, termDates: win, rows: [], calendar: null });
    }
    return byStage.get(key);
  };
  for (const s of slots) {
    ensure(s.courseId, s.year, s.termNumber, s.course?.name, s.course?.colour)
      .rows.push({ id: s.id, day: s.day, start: s.startTime, end: s.endTime, title: s.title, lecturer: s.lecturer || "", room: s.room || "", unitCode: s.unit?.code || null });
  }
  for (const c of calendars) {
    const st = ensure(c.courseId, c.year, c.termNumber, c.course?.name, c.course?.colour);
    const weeks = Array.isArray(c.weeks) ? c.weeks : (() => { try { return JSON.parse(c.weeks || "[]"); } catch { return []; } })();
    st.calendar = { startDate: c.startDate || null, endDate: c.endDate || null, weeks };
    // A calendar's own dates win for the header when set; otherwise keep the unit-derived ones.
    if (c.startDate) st.termDates.start = c.startDate;
    if (c.endDate) st.termDates.end = c.endDate;
  }
  res.json({ stages: [...byStage.values()].sort((a, b) => (a.year - b.year) || (a.termNumber - b.termNumber)) });
});

// GET /api/student/me/queries — this student's own queries and any admin replies.
router.get("/me/queries", async (req, res) => {
  const rows = await prisma.studentQuery.findMany({ where: { studentId: req.user.id }, orderBy: { createdAt: "desc" } });
  res.json(rows.map(sStudentQuery));
});

// GET /api/student/me/reviews — the progress reviews lecturers have written about
// this student. Read-only: writing lives on /api/student-reviews, which is staff-only.
//
// It belongs HERE rather than on that router because requireAuth deliberately blocks a
// student token from every router except /api/student — a single choke point that keeps
// students out of all staff data regardless of any individual route's own guards.
// Widening that allowlist to serve one endpoint would trade a strong invariant for a
// convenience, so the endpoint moved to the student router instead.
router.get("/me/reviews", async (req, res) => {
  const rows = await prisma.studentReview.findMany({
    where: { studentId: req.user.id },
    include: { unit: true, staff: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  res.json(rows.map((r) => ({
    id: r.id,
    unitId: r.unitId,
    unit: r.unit ? { id: r.unit.id, code: r.unit.code, name: r.unit.name } : null,
    // The author's name is stored on the row, so a review still says who wrote it
    // after that lecturer leaves the college.
    staffName: r.staffName || r.staff?.name || "",
    date: r.date,
    progress: r.progress,
    concerns: (() => { try { return JSON.parse(r.concerns || "[]"); } catch { return []; } })(),
    summary: r.summary,
    agreedActions: r.agreedActions,
    followUp: r.followUp,
    followUpDate: r.followUpDate,
    createdAt: r.createdAt,
  })));
});

// POST /api/student/me/query — the student sends a query to the college. Admins pick
// it up and reply in the Student Queries tab; the reply comes back here to the student.
router.post("/me/query", async (req, res) => {
  const message = str(req.body?.message);
  const subject = str(req.body?.subject) || "Student query";
  if (message.length < 3) return res.status(400).json({ error: "Please write your query" });
  if (message.length > 4000) return res.status(400).json({ error: "Query is too long" });
  // Cap the subject too — message was bounded but subject wasn't, so a student could
  // push a 1MB blob into StudentQuery.subject and into every admin's notification row.
  if (subject.length > 200) return res.status(400).json({ error: "Subject is too long (200 characters maximum)" });

  const query = await prisma.studentQuery.create({
    data: { studentId: req.user.id, subject, message, status: "open" },
  });
  notifyAdmins({ type: "info", message: `New query from student ${req.user.name}: ${subject}`, link: "studentqueries" });
  res.status(201).json(sStudentQuery(query));
});

module.exports = router;
