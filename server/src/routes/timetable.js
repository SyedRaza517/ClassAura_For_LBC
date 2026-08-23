// Weekly timetables — the schedule a student reads on their app, managed by admins.
//
// A timetable is a set of TimetableSlot rows scoped to a course + year + term. Rows are
// auto-filled from a unit's generated sessions (which supply the weekday and times),
// then edited; extra rows (workshops, study support) are added by hand. See the model
// comment in schema.prisma.
//
// Gated on its own "timetable" admin page, like every other section — reads and writes
// both, since the whole feature is admin-only (students read via /api/student/me/timetable).
const router = require("express").Router();
const prisma = require("../db");
const { sTimetableSlot, sTermCalendar } = require("../serializers");
const { requireAuth, requirePage } = require("../auth");
const { isRealDate } = require("../validate");

router.use(requireAuth, requirePage("timetable"));

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isDay = (v) => Number.isInteger(v) && v >= 1 && v <= 7;
const MAX_YEAR = 2, MAX_TERM = 6;
// The weekday a dated session falls on, as ISO 1..7 (Mon..Sun). Sunday is 0 in JS.
const isoDay = (dateStr) => { const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
// The distinct weekly pattern a unit is taught on, derived from its dated sessions:
// one entry per (weekday, start, end, kind). This is what becomes its timetable rows.
function scheduleOf(sessions) {
  const seen = new Set(); const out = [];
  for (const s of sessions) {
    const day = isoDay(s.date);
    const key = `${day}|${s.startTime}|${s.endTime}|${s.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, start: s.startTime, end: s.endTime, kind: s.kind || "" });
  }
  return out.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
}
// The term's date window, read from the units in scope: earliest start, latest end.
// This is what fills the "Term 3, 1 Jun – 27 Jul" header without asking for it twice.
function termWindow(units) {
  const starts = units.map((u) => u.startDate).filter(Boolean).sort();
  const ends = units.map((u) => u.endDate).filter(Boolean).sort();
  return { start: starts[0] || null, end: ends.length ? ends[ends.length - 1] : null };
}

// Validate a slot body for create/update. `partial` allows omitted fields on update.
function parseSlot(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;
  if (need("day")) {
    const day = Number(body?.day);
    if (!isDay(day)) return { error: "day must be 1 (Monday) to 7 (Sunday)" };
    data.day = day;
  }
  if (need("start")) { const s = str(body?.start); if (!isTime(s)) return { error: "start must be HH:MM" }; data.startTime = s; }
  if (need("end")) { const e = str(body?.end); if (!isTime(e)) return { error: "end must be HH:MM" }; data.endTime = e; }
  const start = data.startTime ?? undefined, end = data.endTime ?? undefined;
  if (start && end && end <= start) return { error: "end time must be after the start time" };
  if (need("title")) { const t = str(body?.title); if (!t) return { error: "A session title is required" }; data.title = t.slice(0, 200); }
  if (body?.lecturer !== undefined) data.lecturer = str(body.lecturer).slice(0, 120);
  if (body?.room !== undefined) data.room = str(body.room).slice(0, 120);
  return { data };
}

// Resolve and validate the course/year/term scope from a body.
async function parseScope(body) {
  const courseId = str(body?.courseId);
  if (!courseId) return { error: "A course is required" };
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) return { error: "Unknown course" };
  const year = body?.year == null || body.year === "" ? null : Number(body.year);
  const termNumber = body?.termNumber == null || body.termNumber === "" ? null : Number(body.termNumber);
  if (year != null && (!Number.isInteger(year) || year < 1 || year > MAX_YEAR)) return { error: `year must be 1 to ${MAX_YEAR}` };
  if (termNumber != null && (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > MAX_TERM)) return { error: `term must be 1 to ${MAX_TERM}` };
  return { courseId, year, termNumber };
}

// GET /api/timetable/courses — courses that have units, for the picker, each with the
// (year, term) placements its units cover, so the admin can jump straight to a stage.
router.get("/courses", async (_req, res) => {
  const courses = await prisma.course.findMany({ orderBy: { name: "asc" }, include: { units: { select: { year: true, termNumber: true } } } });
  res.json(courses.map((c) => {
    const stages = [...new Set(c.units.filter((u) => u.year != null && u.termNumber != null).map((u) => `${u.year}|${u.termNumber}`))]
      .map((k) => { const [y, t] = k.split("|"); return { year: Number(y), termNumber: Number(t) }; })
      .sort((a, b) => a.year - b.year || a.termNumber - b.termNumber);
    return { id: c.id, name: c.name, colour: c.colour, stages };
  }));
});

// GET /api/timetable?courseId=&year=&termNumber= — the slots in one scope, plus the
// units in that scope (so the admin can see which units have no timetable rows yet).
router.get("/", async (req, res) => {
  const courseId = str(req.query?.courseId);
  if (!courseId) return res.status(400).json({ error: "courseId is required" });
  const year = req.query?.year != null && req.query.year !== "" ? Number(req.query.year) : null;
  const termNumber = req.query?.termNumber != null && req.query.termNumber !== "" ? Number(req.query.termNumber) : null;
  // null year/term means "all" — don't filter that dimension, rather than "IS NULL".
  const where = { courseId, ...(year != null ? { year } : {}), ...(termNumber != null ? { termNumber } : {}) };
  const [slots, units] = await Promise.all([
    prisma.timetableSlot.findMany({ where, include: { unit: { select: { code: true } } }, orderBy: [{ day: "asc" }, { startTime: "asc" }] }),
    prisma.unit.findMany({
      where: { courseId, ...(year != null ? { year } : {}), ...(termNumber != null ? { termNumber } : {}) },
      select: {
        id: true, code: true, name: true, year: true, termNumber: true,
        startDate: true, endDate: true, tutor: true, tutorStaff: { select: { name: true } },
        sessions: { select: { date: true, startTime: true, endTime: true, kind: true } },
        _count: { select: { sessions: true, timetableSlots: true } },
      },
      orderBy: [{ year: "asc" }, { termNumber: "asc" }, { code: "asc" }],
    }),
  ]);

  // The academic calendar is one row per exact (course, year, term). Only fetch it when
  // both are pinned — an "all years/terms" view has no single calendar.
  let calendar = null;
  if (year != null && termNumber != null) {
    // No try/catch here, deliberately. This read used to swallow EVERY error and answer
    // `calendar: null`, from the days when TermCalendar might not have been created yet.
    // Migrations are authoritative now — the table exists wherever the app runs — so the
    // only errors left are real ones (a dropped connection, a broken query), and turning
    // those into "this term has no calendar" is worse than a 500: the screen quietly shows
    // an empty term and an admin re-enters a calendar that was already there. Let it throw.
    const c = await prisma.termCalendar.findFirst({ where: { courseId, year, termNumber } });
    if (c) calendar = sTermCalendar(c);
  }

  res.json({
    slots: slots.map(sTimetableSlot),
    // Each unit carries its own dates and the weekly pattern read from its registers,
    // so the dashboard can show "this unit runs Mon 18:00–21:00, 12 Jun–20 Sep" and let
    // the admin set a lecturer and add it in one tap.
    units: units.map((u) => ({
      id: u.id, code: u.code, name: u.name, year: u.year ?? null, termNumber: u.termNumber ?? null,
      startDate: u.startDate || null, endDate: u.endDate || null,
      tutor: u.tutorStaff?.name || u.tutor || "",
      sessionCount: u._count.sessions, slotCount: u._count.timetableSlots,
      schedule: scheduleOf(u.sessions),
    })),
    termDates: termWindow(units),   // derived from the units, for the header
    calendar,                        // stored academic calendar for this exact stage (or null)
  });
});

// POST /api/timetable/autofill  { courseId, year, termNumber, unitId?, lecturer? }
// Build slots from units' generated sessions. Each distinct (weekday, start, end, kind)
// becomes a slot: a "Teaching" session is the class, a "Seminar" becomes a "… Tutorial"
// row — matching how the college lays it out. Idempotent: a unit that already has slots
// is skipped, so re-running never duplicates.
//
// Two ways to call it:
//   - no unitId  → fill every unit in the (course, year, term) scope at once.
//   - a unitId   → fill just that one unit, optionally with a `lecturer` the admin typed.
//
// Each slot takes the UNIT's own year/term (not the picker's), so a timetable built while
// viewing "all years" still lands on the exact stage a student is enrolled in and shows up.
router.post("/autofill", async (req, res) => {
  const scope = await parseScope(req.body);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const { courseId, year, termNumber } = scope;
  const onlyUnitId = str(req.body?.unitId) || null;
  const lecturerOverride = typeof req.body?.lecturer === "string" ? str(req.body.lecturer).slice(0, 120) : null;

  const units = await prisma.unit.findMany({
    where: { courseId, ...(year != null ? { year } : {}), ...(termNumber != null ? { termNumber } : {}), ...(onlyUnitId ? { id: onlyUnitId } : {}) },
    include: { sessions: { select: { date: true, startTime: true, endTime: true, kind: true } }, tutorStaff: { select: { name: true } }, _count: { select: { timetableSlots: true } } },
  });

  const toCreate = [];
  const skipped = [];
  for (const u of units) {
    if (u._count.timetableSlots > 0) { skipped.push({ code: u.code, reason: "already has timetable rows" }); continue; }
    if (!u.sessions.length) { skipped.push({ code: u.code, reason: "no registers to read a day/time from" }); continue; }
    const lecturer = lecturerOverride != null ? lecturerOverride : (u.tutorStaff?.name || u.tutor || "");
    for (const s of scheduleOf(u.sessions)) {
      const isTutorial = String(s.kind || "").toLowerCase() === "seminar";
      toCreate.push({
        courseId, year: u.year ?? year, termNumber: u.termNumber ?? termNumber, unitId: u.id,
        day: s.day, startTime: s.start, endTime: s.end,
        title: `${u.name}${isTutorial ? " Tutorial" : ""}`,
        lecturer, room: "",
      });
    }
  }
  if (toCreate.length) await prisma.timetableSlot.createMany({ data: toCreate });
  res.status(201).json({ created: toCreate.length, unitsFilled: units.length - skipped.length, skipped });
});

// POST /api/timetable/publish  { courseId, year, termNumber, published }
// Release a whole scope to students, or pull it back to draft. Students only ever see
// published rows (see /api/student/me/timetable), so this one switch is what makes a
// finished timetable visible — the admin builds privately, then publishes in one go.
// Operates on the exact (course, year, term) scope shown in the dashboard.
router.post("/publish", async (req, res) => {
  const scope = await parseScope(req.body);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const published = req.body?.published !== false; // anything but an explicit false publishes
  // null year/term = "all in view" — publish/hide every row currently shown, not just
  // the null-scoped ones (matches how GET / filters the same scope).
  const where = { courseId: scope.courseId, ...(scope.year != null ? { year: scope.year } : {}), ...(scope.termNumber != null ? { termNumber: scope.termNumber } : {}) };
  const r = await prisma.timetableSlot.updateMany({ where, data: { published } });
  // The academic calendar rides the same switch. This was wrapped in a swallow-everything
  // try/catch for the unmigrated-table case; migrations are authoritative now, and the
  // catch could only hide a real failure — leaving the timetable published while the
  // calendar stayed hidden, and reporting success for a half-done publish.
  await prisma.termCalendar.updateMany({ where, data: { published } });
  res.json({ published, count: r.count });
});

// PUT /api/timetable/calendar  { courseId, year, termNumber, startDate?, endDate?, weeks }
// Save the term's dates and week-by-week structure (Week 1 TEACHING … Week 9 ASSESSMENT)
// for one exact stage. Upserted — there is at most one calendar per (course, year, term).
// It keeps its current published state on save, so editing never surprises students; the
// Publish button is what makes it (and the timetable) visible.
router.put("/calendar", async (req, res) => {
  const scope = await parseScope(req.body);
  if (scope.error) return res.status(400).json({ error: scope.error });
  if (scope.year == null || scope.termNumber == null) return res.status(400).json({ error: "Pick a specific year and term for the calendar" });
  const startDate = req.body?.startDate ? str(req.body.startDate) : null;
  const endDate = req.body?.endDate ? str(req.body.endDate) : null;
  if (startDate && !isRealDate(startDate)) return res.status(400).json({ error: "Start date is not a real date" });
  if (endDate && !isRealDate(endDate)) return res.status(400).json({ error: "End date is not a real date" });
  if (startDate && endDate && endDate < startDate) return res.status(400).json({ error: "End date must be after the start date" });

  // Sanitise the weeks array: a numbered list of { n, wc (real date), activity (<=60 chars) }.
  const rawWeeks = Array.isArray(req.body?.weeks) ? req.body.weeks : [];
  if (rawWeeks.length > 60) return res.status(400).json({ error: "Too many weeks" });
  const weeks = rawWeeks.map((w, i) => ({
    n: Number.isInteger(w?.n) ? w.n : i + 1,
    wc: isRealDate(str(w?.wc)) ? str(w.wc) : null,
    activity: str(w?.activity).slice(0, 60) || "Teaching",
  }));

  // A save failure is a 500 (wrapAsync forwards the rejection — see asyncRoutes.js).
  // It used to map "table does not exist" to a 503 telling the admin to "run the database
  // setup". That advice predates migrations being authoritative: the table is always there
  // now, so the message only ever sent someone chasing a setup step for what was really a
  // database fault — and the string match on /does not exist/ caught unrelated errors
  // (a missing COLUMN, a missing row in a relation) and mislabelled those too.
  const existing = await prisma.termCalendar.findFirst({ where: { courseId: scope.courseId, year: scope.year, termNumber: scope.termNumber } });
  const data = { courseId: scope.courseId, year: scope.year, termNumber: scope.termNumber, startDate, endDate, weeks };
  const saved = existing
    ? await prisma.termCalendar.update({ where: { id: existing.id }, data })
    : await prisma.termCalendar.create({ data });
  res.json(sTermCalendar(saved));
});

// POST /api/timetable/slots — add one row by hand (a workshop, study support, or a
// correction). courseId/year/termNumber set the scope; unitId is optional.
router.post("/slots", async (req, res) => {
  const scope = await parseScope(req.body);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const parsed = parseSlot(req.body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  let unitId = str(req.body?.unitId) || null;
  if (unitId && !(await prisma.unit.findUnique({ where: { id: unitId } }))) unitId = null;
  const slot = await prisma.timetableSlot.create({
    data: { courseId: scope.courseId, year: scope.year, termNumber: scope.termNumber, unitId, ...parsed.data },
    include: { unit: { select: { code: true } } },
  });
  res.status(201).json(sTimetableSlot(slot));
});

// PUT /api/timetable/slots/:id — edit a row's day/time/title/lecturer/room.
router.put("/slots/:id", async (req, res) => {
  const existing = await prisma.timetableSlot.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Timetable row not found" });
  const parsed = parseSlot(req.body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // Cross-field time check when only one side is being changed.
  const start = parsed.data.startTime ?? existing.startTime, end = parsed.data.endTime ?? existing.endTime;
  if (end <= start) return res.status(400).json({ error: "end time must be after the start time" });
  const slot = await prisma.timetableSlot.update({ where: { id: existing.id }, data: parsed.data, include: { unit: { select: { code: true } } } });
  res.json(sTimetableSlot(slot));
});

// DELETE /api/timetable/slots/:id
router.delete("/slots/:id", async (req, res) => {
  try { await prisma.timetableSlot.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (_e) { res.status(404).json({ error: "Timetable row not found" }); }
});

module.exports = router;
