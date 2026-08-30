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

module.exports = router;
