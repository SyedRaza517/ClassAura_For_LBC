// Timetabling — the planner half.
//
// This is where an administrator places an event and ASSIGNS a room, staff and
// groups to it, from real dropdowns backed by real foreign keys. The read-only half
// that staff use is routes/myTimetable.js.
//
// Gated on its own "scheduling" admin page, reads and writes both, because the whole
// section is administrative. It is deliberately a different page from "timetable",
// which still serves the older TimetableSlot screen and the student timetable.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage } = require("../auth");
const { sRoom, sCategory } = require("../timetabling/serialize");

router.use(requireAuth, requirePage("scheduling"));

const str = (v) => (typeof v === "string" ? v.trim() : "");
const MAX = 200;

/* ------------------------------------------------------------------ rooms -- */

// Everything, including retired rooms: an administrator managing rooms is precisely
// the person who needs to see the retired ones. The staff-facing picker filters to
// active itself.
router.get("/rooms", async (_req, res) => {
  const rows = await prisma.room.findMany({ orderBy: [{ campus: "asc" }, { name: "asc" }] });
  res.json(rows.map(sRoom));
});

/** Validate a room body. `partial` allows omitted fields on update. */
function parseRoom(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("name")) {
    const name = str(body?.name);
    if (!name) return { error: "A room name is required" };
    data.name = name.slice(0, MAX);
  }
  if (body?.floor !== undefined) data.floor = str(body.floor).slice(0, MAX);
  if (body?.campus !== undefined) data.campus = str(body.campus).slice(0, MAX);
  if (body?.kind !== undefined) data.kind = str(body.kind).slice(0, MAX);
  if (body?.active !== undefined) data.active = !!body.active;

  if (body?.capacity !== undefined) {
    // Empty means "we have not recorded it" and is stored as NULL — NOT as 0. Zero
    // would say the room seats nobody, which a capacity check would later believe.
    if (body.capacity === null || body.capacity === "") data.capacity = null;
    else {
      const n = Number(body.capacity);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: "capacity must be a whole number of seats, or blank" };
      data.capacity = n;
    }
  }
  return { data };
}

router.post("/rooms", async (req, res) => {
  const { data, error } = parseRoom(req.body, false);
  if (error) return res.status(400).json({ error });
  try {
    const row = await prisma.room.create({ data });
    res.status(201).json(sRoom(row));
  } catch (e) {
    // The unique is (tenant, name, campus) — so this fires only for a genuine
    // duplicate on the same campus, not for room 101 existing at another site.
    if (e.code === "P2002") return res.status(409).json({ error: "That room already exists on that campus" });
    throw e;
  }
});

router.put("/rooms/:id", async (req, res) => {
  const { data, error } = parseRoom(req.body, true);
  if (error) return res.status(400).json({ error });
  try {
    const row = await prisma.room.update({ where: { id: req.params.id }, data });
    res.json(sRoom(row));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That room already exists on that campus" });
    if (e.code === "P2025") return res.status(404).json({ error: "Room not found" });
    throw e;
  }
});

// Deleting a room does NOT delete the classes that were in it — the FK is SetNull.
// The events survive with no room, which is visibly wrong on the screen and
// therefore gets fixed; a silently vanished lecture does not.
//
// The count is returned so the screen can say so plainly rather than leaving an
// administrator to discover it.
router.delete("/rooms/:id", async (req, res) => {
  const affected = await prisma.timetableEvent.count({ where: { roomId: req.params.id } });
  try {
    await prisma.room.delete({ where: { id: req.params.id } });
    res.json({ ok: true, eventsLeftWithoutARoom: affected });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Room not found" });
    throw e;
  }
});

/* ------------------------------------------------------------- categories -- */

router.get("/categories", async (_req, res) => {
  const rows = await prisma.eventCategory.findMany({ orderBy: { name: "asc" } });
  res.json(rows.map(sCategory));
});

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function parseCategory(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("name")) {
    const name = str(body?.name);
    if (!name) return { error: "A category name is required" };
    data.name = name.slice(0, MAX);
  }
  if (body?.colour !== undefined) {
    const colour = str(body.colour);
    // Validated because it is written straight into a style attribute on the client.
    if (!HEX_RE.test(colour)) return { error: "colour must be a hex value like #1a3a8f" };
    data.colour = colour;
  }
  if (body?.active !== undefined) data.active = !!body.active;
  return { data };
}

router.post("/categories", async (req, res) => {
  const { data, error } = parseCategory(req.body, false);
  if (error) return res.status(400).json({ error });
  try {
    res.status(201).json(sCategory(await prisma.eventCategory.create({ data })));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That category already exists" });
    throw e;
  }
});

router.put("/categories/:id", async (req, res) => {
  const { data, error } = parseCategory(req.body, true);
  if (error) return res.status(400).json({ error });
  try {
    res.json(sCategory(await prisma.eventCategory.update({ where: { id: req.params.id }, data })));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That category already exists" });
    if (e.code === "P2025") return res.status(404).json({ error: "Category not found" });
    throw e;
  }
});

router.delete("/categories/:id", async (req, res) => {
  const affected = await prisma.timetableEvent.count({ where: { categoryId: req.params.id } });
  try {
    await prisma.eventCategory.delete({ where: { id: req.params.id } });
    res.json({ ok: true, eventsLeftWithoutACategory: affected });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Category not found" });
    throw e;
  }
});

/* ----------------------------------------------------------------- events -- */

const { findClashes } = require("../timetabling/overlap");
const { sEvent } = require("../timetabling/serialize");

// Everything sEvent names. Kept in one constant because four handlers need the same
// shape and a query that forgets one of these returns an event whose room is null on
// the screen for no reason a reader could work out.
const EVENT_INCLUDE = {
  unit: { select: { code: true, name: true } },
  course: { select: { name: true } },
  room: { select: { id: true, name: true, floor: true, campus: true } },
  category: { select: { name: true, colour: true } },
  staff: { include: { staff: { select: { name: true } } } },
  groups: { include: { cohort: { select: { name: true } } } },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && x))] : []);

router.get("/events", async (req, res) => {
  const from = str(req.query.from), to = str(req.query.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "to must not be before from" });

  const where = { date: { gte: from, lte: to } };
  if (str(req.query.roomId)) where.roomId = str(req.query.roomId);
  if (str(req.query.unitId)) where.unitId = str(req.query.unitId);
  if (str(req.query.staffId)) where.staff = { some: { staffId: str(req.query.staffId) } };
  if (str(req.query.cohortId)) where.groups = { some: { cohortId: str(req.query.cohortId) } };
  // Absent means BOTH. An administrator building next term needs to see the drafts
  // they are building; that is the difference between this router and the other one.
  if (req.query.published === "true") where.published = true;
  if (req.query.published === "false") where.published = false;

  const rows = await prisma.timetableEvent.findMany({
    where, include: EVENT_INCLUDE, orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  res.json(rows.map(sEvent));
});

/** Validate an event body. `partial` allows omitted fields on update. */
function parseEvent(body, partial) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("date")) {
    const date = str(body?.date);
    if (!DATE_RE.test(date)) return { error: "date must be YYYY-MM-DD" };
    data.date = date;
  }
  if (need("start")) {
    const s = str(body?.start);
    if (!TIME_RE.test(s)) return { error: "start must be HH:MM" };
    data.startTime = s;
  }
  if (need("end")) {
    const e = str(body?.end);
    if (!TIME_RE.test(e)) return { error: "end must be HH:MM" };
    data.endTime = e;
  }
  if (need("title")) {
    const t = str(body?.title);
    if (!t) return { error: "A title is required" };
    data.title = t.slice(0, MAX);
  }
  if (body?.notes !== undefined) data.notes = str(body.notes).slice(0, 4000);
  if (body?.published !== undefined) data.published = !!body.published;

  // Nullable relations. An empty string clears the link; that is how a screen says
  // "no room" without a separate verb.
  for (const [key, field] of [["unitId", "unitId"], ["courseId", "courseId"], ["roomId", "roomId"], ["categoryId", "categoryId"]]) {
    if (body?.[key] !== undefined) data[field] = str(body[key]) || null;
  }

  const start = data.startTime, end = data.endTime;
  if (start && end && end <= start) return { error: "The end time must be after the start time" };
  return { data };
}

/**
 * Who else is already using this room, these staff or these groups at this time.
 *
 * A WARNING, NOT A BLOCK, and the handlers below treat it as one. A college has
 * legitimate reasons to overlap — a room split between two half-groups, a lecturer
 * nominally on two registers — and a hard refusal gets worked around by saving the
 * event with the room left blank, which loses the information entirely. A visible
 * warning that somebody overrode is a record; a refusal is a data-entry workaround.
 */
async function checkClashes(candidate, { roomId, staffIds, cohortIds }) {
  const sameDay = await prisma.timetableEvent.findMany({
    where: {
      date: candidate.date,
      OR: [
        ...(roomId ? [{ roomId }] : []),
        ...(staffIds.length ? [{ staff: { some: { staffId: { in: staffIds } } } }] : []),
        ...(cohortIds.length ? [{ groups: { some: { cohortId: { in: cohortIds } } } }] : []),
      ],
    },
    include: EVENT_INCLUDE,
  });
  // OR with no branches matches everything in Prisma, so an event with no room, no
  // staff and no group would otherwise collect the entire day as a clash.
  if (!roomId && !staffIds.length && !cohortIds.length) return [];

  const out = [];
  for (const e of findClashes(candidate, sameDay)) {
    if (roomId && e.roomId === roomId) out.push({ kind: "room", resource: e.room ? e.room.name : "", event: sEvent(e) });
    for (const s of e.staff || []) if (staffIds.includes(s.staffId)) out.push({ kind: "staff", resource: s.staff?.name || "", event: sEvent(e) });
    for (const g of e.groups || []) if (cohortIds.includes(g.cohortId)) out.push({ kind: "group", resource: g.cohort?.name || "", event: sEvent(e) });
  }
  return out;
}

router.post("/events", async (req, res) => {
  const { data, error } = parseEvent(req.body, false);
  if (error) return res.status(400).json({ error });

  const staffIds = ids(req.body?.staffIds);
  const cohortIds = ids(req.body?.cohortIds);
  const warnings = await checkClashes({ ...data, id: null }, { roomId: data.roomId || null, staffIds, cohortIds });

  const row = await prisma.timetableEvent.create({
    data: {
      ...data,
      staff: staffIds.length ? { create: staffIds.map((staffId) => ({ staffId })) } : undefined,
      groups: cohortIds.length ? { create: cohortIds.map((cohortId) => ({ cohortId })) } : undefined,
    },
    include: EVENT_INCLUDE,
  });
  res.status(201).json({ event: sEvent(row), warnings });
});

router.put("/events/:id", async (req, res) => {
  const { data, error } = parseEvent(req.body, true);
  if (error) return res.status(400).json({ error });

  const existing = await prisma.timetableEvent.findUnique({ where: { id: req.params.id }, include: EVENT_INCLUDE });
  if (!existing) return res.status(404).json({ error: "Event not found" });

  // Assignments are replaced wholesale when sent, and untouched when omitted. A
  // screen that only moves the time must not silently drop the staff on the event.
  const staffIds = req.body?.staffIds === undefined ? (existing.staff || []).map((s) => s.staffId) : ids(req.body.staffIds);
  const cohortIds = req.body?.cohortIds === undefined ? (existing.groups || []).map((g) => g.cohortId) : ids(req.body.cohortIds);

  const candidate = {
    id: existing.id,
    date: data.date ?? existing.date,
    startTime: data.startTime ?? existing.startTime,
    endTime: data.endTime ?? existing.endTime,
  };
  if (candidate.endTime <= candidate.startTime) return res.status(400).json({ error: "The end time must be after the start time" });

  const roomId = data.roomId !== undefined ? data.roomId : existing.roomId;
  const warnings = await checkClashes(candidate, { roomId: roomId || null, staffIds, cohortIds });

  // changedAt tracks MOVEMENT — a retitled event has not moved, and highlighting it
  // as "recently changed" would train readers to ignore the highlight.
  const moved = (data.date && data.date !== existing.date) ||
                (data.startTime && data.startTime !== existing.startTime) ||
                (data.endTime && data.endTime !== existing.endTime) ||
                (data.roomId !== undefined && data.roomId !== existing.roomId);

  const row = await prisma.$transaction(async (tx) => {
    if (req.body?.staffIds !== undefined) {
      await tx.timetableEventStaff.deleteMany({ where: { eventId: existing.id } });
      if (staffIds.length) await tx.timetableEventStaff.createMany({ data: staffIds.map((staffId) => ({ eventId: existing.id, staffId })) });
    }
    if (req.body?.cohortIds !== undefined) {
      await tx.timetableEventGroup.deleteMany({ where: { eventId: existing.id } });
      if (cohortIds.length) await tx.timetableEventGroup.createMany({ data: cohortIds.map((cohortId) => ({ eventId: existing.id, cohortId })) });
    }
    return tx.timetableEvent.update({
      where: { id: existing.id },
      data: { ...data, ...(moved ? { changedAt: new Date() } : {}) },
      include: EVENT_INCLUDE,
    });
  });

  res.json({ event: sEvent(row), warnings });
});

router.delete("/events/:id", async (req, res) => {
  try {
    // The join rows go with it — those FKs are Cascade, unlike room and category,
    // because an assignment has no meaning without the event it assigns to.
    await prisma.timetableEvent.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Event not found" });
    throw e;
  }
});

module.exports = router;
