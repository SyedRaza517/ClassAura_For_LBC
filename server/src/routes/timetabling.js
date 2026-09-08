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
const { sRoom, sCampus, sCategory } = require("../timetabling/serialize");
const { normaliseCampus } = require("../timetabling/campusMatch");
const { seriesDates } = require("../timetabling/recurrence");
const { parseSessions } = require("../timetabling/sessions");
// The SAME module the Settings screen validates against, imported rather than
// reimplemented: the key rules and the name cap live in one place, so a school this
// route accepts cannot be one that screen then refuses to save.
const departments = require("../academicDepartments");
const audit = require("../audit");
const { randomUUID } = require("node:crypto");

router.use(requireAuth, requirePage("scheduling"));

const str = (v) => (typeof v === "string" ? v.trim() : "");
const MAX = 200;

/* ------------------------------------------------------------------ rooms -- */

// Everything, including retired rooms: an administrator managing rooms is precisely
// the person who needs to see the retired ones. The staff-facing picker filters to
// active itself.
router.get("/rooms", async (_req, res) => {
  // campusRef included so roomLabel prints the CURRENT campus name rather than the
  // legacy string frozen into the row.
  const rows = await prisma.room.findMany({ include: { campusRef: true }, orderBy: [{ campus: "asc" }, { name: "asc" }] });
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
  // The legacy free-text column. Still writable so an install mid-migration is not
  // broken, but campusId below is what the screens set and what the unique is on.
  if (body?.campus !== undefined) data.campus = str(body.campus).slice(0, MAX);
  if (body?.campusId !== undefined) {
    // Empty string means "no campus", stored as NULL. Not "" — a room with no campus
    // must not be a room on a campus whose name is blank, and @@unique([name, campusId])
    // treats those two very differently.
    data.campusId = str(body.campusId) || null;
  }
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

/**
 * Give `data` a real campusId whenever a campus was named, creating the Campus if the
 * college has not got one by that name yet.
 *
 * WITHOUT THIS THE DUPLICATE-ROOM GUARD SILENTLY STOPS WORKING, and the failure is the
 * quiet kind. Room's unique is @@unique([name, campusId]) since campuses became rows.
 * A caller that sends only the legacy `campus` string — every client written before
 * 7 Sep 2026 — leaves campusId NULL, Postgres treats NULLs as distinct, and two rooms
 * called "101" on the same campus are BOTH accepted. Caught by
 * smoke-timetabling.mjs's "the same room on the same campus is refused", which started
 * returning 201.
 *
 * It also finishes the migration incrementally: every room saved through this route
 * moves itself onto a Campus row, so the legacy column drains rather than lingering.
 */
async function resolveCampusId(data) {
  // An explicit campusId always wins — including an explicit null, which means "no
  // campus" and must not be second-guessed from a stale string.
  if (data.campusId !== undefined) return;
  if (data.campus === undefined) return;

  const wanted = String(data.campus).trim().replace(/\s+/g, " ");
  if (!wanted) { data.campusId = null; return; }

  const key = normaliseCampus(wanted);
  const existing = (await prisma.campus.findMany({ select: { id: true, name: true } }))
    .find((c) => normaliseCampus(c.name) === key);
  if (existing) { data.campusId = existing.id; return; }

  try {
    data.campusId = (await prisma.campus.create({ data: { name: wanted } })).id;
  } catch (e) {
    // Two administrators adding the same campus at once. The loser reads the winner's
    // row rather than failing the room save, which is what the person was doing.
    if (e.code !== "P2002") throw e;
    const row = await prisma.campus.findFirst({ where: { name: wanted } });
    data.campusId = row?.id ?? null;
  }
}

router.post("/rooms", async (req, res) => {
  const { data, error } = parseRoom(req.body, false);
  if (error) return res.status(400).json({ error });
  await resolveCampusId(data);
  try {
    const row = await prisma.room.create({ data, include: { campusRef: true } });
    res.status(201).json(sRoom(row));
  } catch (e) {
    // The unique is (name, campusId) — so this fires only for a genuine duplicate on
    // the same campus, not for room 101 existing at another site.
    if (e.code === "P2002") return res.status(409).json({ error: "That room already exists on that campus" });
    throw e;
  }
});

router.put("/rooms/:id", async (req, res) => {
  const { data, error } = parseRoom(req.body, true);
  if (error) return res.status(400).json({ error });
  await resolveCampusId(data);
  try {
    const row = await prisma.room.update({ where: { id: req.params.id }, data, include: { campusRef: true } });
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

/* ---------------------------------------------------------------- campuses -- */

// Everything, retired included: an administrator managing campuses is the person who
// needs to see the retired ones. Pickers filter to active themselves.
router.get("/campuses", async (_req, res) => {
  const rows = await prisma.campus.findMany({ orderBy: { name: "asc" } });
  res.json(rows.map(sCampus));
});

function parseCampus(body, partial) {
  const data = {};
  if (!partial || body?.name !== undefined) {
    const name = str(body?.name);
    if (!name) return { error: "A campus name is required" };
    data.name = name.slice(0, MAX);
  }
  if (body?.active !== undefined) data.active = !!body.active;
  return { data };
}

router.post("/campuses", async (req, res) => {
  const { data, error } = parseCampus(req.body, false);
  if (error) return res.status(400).json({ error });
  try {
    res.status(201).json(sCampus(await prisma.campus.create({ data })));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That campus already exists" });
    throw e;
  }
});

router.put("/campuses/:id", async (req, res) => {
  const { data, error } = parseCampus(req.body, true);
  if (error) return res.status(400).json({ error });
  try {
    res.json(sCampus(await prisma.campus.update({ where: { id: req.params.id }, data })));
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "That campus already exists" });
    if (e.code === "P2025") return res.status(404).json({ error: "Campus not found" });
    throw e;
  }
});

// DEACTIVATES RATHER THAN DELETES WHEN ROOMS STILL POINT AT IT, and that is the whole
// difference from the rooms and categories handlers above.
//
// Room.campusId is SetNull, so deleting a campus with rooms on it would silently
// detach every one of them — and Room's unique is @@unique([name, campusId]), so two
// rooms called "101" on the deleted campus would both land on campusId NULL and
// collide. The delete would then succeed for one college and fail with a constraint
// error for another, depending on data nobody was looking at.
//
// Deactivating keeps the rooms attached and takes the campus out of every picker,
// which is what "delete this campus" actually means to the person asking.
router.delete("/campuses/:id", async (req, res) => {
  const rooms = await prisma.room.count({ where: { campusId: req.params.id } });
  try {
    if (rooms > 0) {
      const row = await prisma.campus.update({ where: { id: req.params.id }, data: { active: false } });
      return res.json({ ok: true, deactivated: true, rooms, campus: sCampus(row) });
    }
    await prisma.campus.delete({ where: { id: req.params.id } });
    res.json({ ok: true, deactivated: false, rooms: 0 });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Campus not found" });
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

/* ---------------------------------------------------- schools (departments) -- */

// The college's SCHOOLS — its AcademicDepartment rows — as the planner needs them.
//
// WHY THIS EXISTS BESIDE /api/academic-departments RATHER THAN INSTEAD OF IT.
//
// That router lists the same rows and is gated on requirePage("settings"). A timetabler
// is exactly the person who holds "scheduling" and NOT "settings" — the two are separate
// grants precisely so the person building next term is not also the person editing the
// college's configuration. Pointed at the settings route they would get a 403 and an
// empty School picker on the one screen they are meant to spend the week in, with
// nothing on it saying why.
//
// NAMES AND COLOURS ONLY, and that is the boundary rather than an economy. Department
// MEMBERSHIP — which staff and which students are in one, and the counts that reveal how
// many — is an access-control question: routes/academicDepartments.js gates the staff
// half on Super Admin alone, because that endpoint can hand somebody the whole college.
// None of that is needed to label a class, so none of it is served here. `key` and
// `active` are left out for the same reason there is no `_count`: this answers "what may
// I file this class under", and the answer is a label, an id and a colour.
router.get("/departments", async (_req, res) => {
  // AcademicDepartment is declared UNSCOPED in academicScopeModels.js, so this needs no
  // withoutAcademicScope() wrapper — the department LIST is a college-wide fact, and a
  // scoped account that could not read it could not be shown the name of its own school.
  //
  // RETIRED ONES ARE RETURNED TOO, CARRYING `active`, and the caller filters.
  //
  // This started as active-only, on the reasoning that offering a retired school as a
  // destination for next term's classes is how a retired school stops being retired.
  // That is still true of the PICKER — which now filters on `active` itself, exactly as
  // the room and campus pickers already do.
  //
  // But the Schools tab has to manage them, and a management screen that cannot see a
  // retired row cannot restore one: retiring a school by mistake would be irreversible
  // from the only screen that offers the button. One endpoint returning the honest set
  // beats a second endpoint differing by one WHERE clause.
  const rows = await prisma.academicDepartment.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true, colour: true, active: true },
  });
  res.json(rows);
});

/**
 * A name → the immutable slug AcademicDepartment.key requires.
 *
 * The key is never shown and never edited, but it is @unique and — per the schema —
 * immutable once created, because a saved filter, a URL fragment and the VLE mapping
 * screen all carry it and none of them re-resolves it afterwards. Deriving it from the
 * name is what lets this endpoint take `{ name }` alone; the Settings screen asks for
 * both because that is where an administrator is deliberately editing configuration,
 * and a timetabler adding "School of Law" at four in the afternoon should not have to
 * learn what a slug is.
 *
 * Accents are folded rather than dropped, so "Santé" becomes "sante" and not "sant".
 */
function slugifyName(name) {
  return String(name)
    .normalize("NFKD")
    // NFKD splits an accented letter into a letter plus a combining mark, and
    // \p{M} then drops the mark -- so "Sante" survives where stripping every
    // non-ASCII character outright would leave "Sant".
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // KEY_RE caps at 40. Trimmed again after the slice because cutting mid-word can
    // leave the hyphen that was joining it.
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * Add ONE school. Additive only, and that is the entire safety story of this handler.
 *
 * THIS DELIBERATELY DOES NOT REUSE PUT /api/academic-departments, and the reason is the
 * shape of that endpoint rather than its gate. It is a whole-list replace with
 * retire-by-omission: anything absent from the submitted array is set active:false. A
 * planner screen calling it to add one school would have to send back every other school
 * exactly as it found it, and the first time it sent a short list — a stale cache, a
 * filtered array, a failed load that resolved to [] — it would retire the college's
 * entire organisation chart with a 200 and no warning. There is no request this endpoint
 * can be given that retires anything, because it only ever creates.
 *
 * There is deliberately no update and no delete here either. Renaming or retiring a
 * school changes what other people can see, is audited as a configuration change, and
 * belongs on the Settings screen with the rest of the organisation chart.
 */
router.post("/departments", async (req, res) => {
  const name = str(req.body?.name);
  if (!name) return res.status(400).json({ error: "A school name is required" });

  const key = slugifyName(name);

  // Every validation rule comes from departments.cleanOne rather than being restated —
  // KEY_RE, the 60-character name cap, the colour default. A second copy of those rules
  // is a second thing to keep in step with the Settings screen, and the failure would be
  // a row this route accepts that that screen then refuses to save.
  const cleaned = departments.cleanOne({ key, name, colour: departments.DEFAULT_COLOUR });
  if (!cleaned) {
    // Reached when the name slugifies to nothing — a name written entirely in a script
    // with no ASCII letters or digits, or one made only of punctuation.
    //
    // A generated fallback key ("dept-9f2a") was the rejected alternative. The key is
    // IMMUTABLE and travels in saved filters and URL fragments for the life of the
    // install, so quietly minting a meaningless permanent identifier to avoid one error
    // message is the worse trade. The Settings screen is where a key can be typed by
    // hand, so that is where this points.
    return res.status(400).json({
      error: "That name has no letters or digits to build a key from. Add this school on " +
        "the Settings screen, where the key can be typed directly.",
    });
  }

  // CAPPED AT THE SAME 50 THE SETTINGS SCREEN ENFORCES, and the cap is not cosmetic.
  // departments.cleanList() slices a submitted list to 50, and PUT / retires by
  // omission — so a 51st school created here would be dropped from the next Settings
  // save. That currently surfaces as a 400 rather than a silent retirement, but only by
  // way of a count comparison written for a different reason, and this route has no
  // business relying on it.
  const existing = await prisma.academicDepartment.findMany({ select: { id: true, key: true, name: true, active: true } });
  if (existing.length >= 50) {
    return res.status(400).json({ error: "This college already has the maximum of 50 schools." });
  }

  // CASE-INSENSITIVE ON THE NAME, not just on the derived key, matching the instinct
  // campuses already follow through normaliseCampus: a college that has "Computing"
  // wants to be told so rather than given a second "computing" beside it. Two schools
  // with names differing only in case are indistinguishable on every picker in the
  // application, and a class filed under the wrong one is invisible to the department
  // that teaches it.
  //
  // Retired rows count. A retired school still holds its courses and students, and
  // creating a fresh row with the same name would leave the college with two — the
  // populated one nobody can pick and the empty one everybody picks.
  const lower = name.toLowerCase();
  const clash = existing.find((d) => d.name.toLowerCase() === lower) ||
                existing.find((d) => d.key === cleaned.key);
  if (clash) {
    return res.status(409).json({
      error: clash.active
        ? `"${clash.name}" already exists.`
        : `"${clash.name}" already exists but has been retired. Bring it back on the Settings screen rather than adding a second one.`,
      department: { id: clash.id, name: clash.name },
    });
  }

  let row;
  try {
    row = await prisma.academicDepartment.create({ data: cleaned });
  } catch (e) {
    // Two administrators adding the same school at once. The read above cannot close
    // that window; the unique on `key` can, and the loser is told what the winner made
    // rather than being handed a 500.
    if (e.code !== "P2002") throw e;
    const won = await prisma.academicDepartment.findUnique({ where: { key: cleaned.key } });
    return res.status(409).json({
      error: `"${won?.name || name}" already exists.`,
      ...(won ? { department: { id: won.id, name: won.name } } : {}),
    });
  }

  // The cache in academicDepartments.js is a 30-second TTL invalidated on save, and the
  // Settings route invalidates it for exactly this reason. A school created here and not
  // invalidated is one that scoping checks and the mapping screen cannot see for half a
  // minute — long enough to be reported as "it did not save".
  departments.invalidate();

  // AUDITED LIKE THE SETTINGS EDIT IT IS. This route is reachable by an account holding
  // "scheduling" and not "settings", so it is the one way the organisation chart can
  // change without the Settings screen being opened. An unaudited path to a change that
  // is audited everywhere else is a gap in the log rather than an absence of one.
  audit.record(req, {
    action: "academicDepartments.created", entity: "AcademicDepartment", entityId: row.id,
    summary: `School "${row.name}" was added from the timetable planner by ` +
      (req.user?.name || "an administrator"),
    before: null,
    after: { key: row.key, name: row.name, active: row.active },
  });

  res.status(201).json({ id: row.id, name: row.name, colour: row.colour });
});

/**
 * Rename a school, or change its colour. NOT its key.
 *
 * `key` is the stable identifier — it is what `departments.cleanOne` validates, what the
 * Settings screen matches rows on, and what a college's own configuration refers to.
 * Renaming the DISPLAY name is cosmetic and safe; changing the key underneath it is a
 * different act with a different blast radius, and it stays on Settings.
 */
router.put("/departments/:id", async (req, res) => {
  const existing = await prisma.academicDepartment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "School not found" });

  const data = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name);
    if (!name) return res.status(400).json({ error: "A school name is required" });
    // Same case-insensitive clash rule the create path uses, so a rename cannot produce
    // the near-duplicate a create would have been refused for.
    const clash = (await prisma.academicDepartment.findMany({ select: { id: true, name: true } }))
      .find((d) => d.id !== existing.id && d.name.trim().toLowerCase() === name.toLowerCase());
    if (clash) return res.status(409).json({ error: `A school called "${clash.name}" already exists.` });
    data.name = name.slice(0, 60);
  }
  if (req.body?.active !== undefined) data.active = !!req.body.active;
  if (!Object.keys(data).length) return res.status(400).json({ error: "Nothing to change" });

  const row = await prisma.academicDepartment.update({ where: { id: existing.id }, data });
  departments.invalidate();
  audit.record(req, {
    action: "academicDepartments.updated", entity: "AcademicDepartment", entityId: row.id,
    summary: `School "${existing.name}" was ` +
      (data.name && data.name !== existing.name ? `renamed to "${row.name}"` : (row.active ? "restored" : "retired")) +
      ` from the timetable planner by ${req.user?.name || "an administrator"}`,
    before: { name: existing.name, active: existing.active },
    after: { name: row.name, active: row.active },
  });
  res.json({ id: row.id, name: row.name, colour: row.colour, active: row.active });
});

/**
 * Retire a school, or delete it outright if nothing has ever belonged to it.
 *
 * A HARD DELETE OF A SCHOOL IN USE WOULD HIDE PEOPLE FROM THEIR OWN TUTORS, and that is
 * why this counts first. Every relation to AcademicDepartment is SetNull, so deleting one
 * does not remove its courses, students or classes — it sets their department to NULL.
 * And a row with no department is visible ONLY to college-wide accounts, by design. So
 * deleting a school in use would silently take every student in it out of the sight of
 * every member of staff scoped to it, with nothing on any screen to say why.
 *
 * Retiring keeps every link intact and takes the school out of the pickers, which is what
 * "delete this school" actually means to the person asking. A hard delete is allowed only
 * when there is genuinely nothing to orphan — a school added by mistake a minute ago.
 */
router.delete("/departments/:id", async (req, res) => {
  const id = req.params.id;
  const existing = await prisma.academicDepartment.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "School not found" });

  const [courses, students, cohorts, units, events, slots, staff] = await Promise.all([
    prisma.course.count({ where: { academicDepartmentId: id } }),
    prisma.student.count({ where: { academicDepartmentId: id } }),
    prisma.cohort.count({ where: { academicDepartmentId: id } }),
    prisma.unit.count({ where: { academicDepartmentId: id } }),
    prisma.timetableEvent.count({ where: { academicDepartmentId: id } }),
    prisma.timetableSlot.count({ where: { academicDepartmentId: id } }),
    prisma.staffAcademicDepartment.count({ where: { academicDepartmentId: id } }),
  ]);
  const inUse = courses + students + cohorts + units + events + slots + staff;

  if (inUse > 0) {
    const row = await prisma.academicDepartment.update({ where: { id }, data: { active: false } });
    departments.invalidate();
    audit.record(req, {
      action: "academicDepartments.retired", entity: "AcademicDepartment", entityId: id,
      summary: `School "${existing.name}" was retired from the timetable planner by ${req.user?.name || "an administrator"} — ${inUse} record(s) still belong to it`,
      before: { active: true }, after: { active: false },
    });
    return res.json({
      ok: true, retired: true, inUse,
      counts: { courses, students, cohorts, units, events, staff },
      department: { id: row.id, name: row.name, colour: row.colour, active: row.active },
    });
  }

  await prisma.academicDepartment.delete({ where: { id } });
  departments.invalidate();
  audit.record(req, {
    action: "academicDepartments.deleted", entity: "AcademicDepartment", entityId: id,
    summary: `Empty school "${existing.name}" was deleted from the timetable planner by ${req.user?.name || "an administrator"}`,
    before: { key: existing.key, name: existing.name }, after: null,
  });
  res.json({ ok: true, retired: false, inUse: 0 });
});

/* --------------------------------------------- groups (cohorts) + courses -- */
//
// A GROUP IS A COHORT. There is no second table and there must never be one: the thing a
// timetabled class is addressed to — "BSc Software Engineering SEP 25" — is the same
// intake the registers, the terms and the progression scores hang off, and
// TimetableEventGroup already points at Cohort. "Group" is only what the planner calls it
// on screen, because "cohort" is registry vocabulary and a timetabler is not a registrar.
//
// WHY THESE LIVE HERE AND NOT ON /api/hnd, which has the same rows.
//
// The same reason GET /departments above exists beside /api/academic-departments: the
// gate. /hnd/cohorts is gated on requireAnyPage(["registers"]) for every write, and a
// timetabler holds "scheduling" and not "registers" — the grants are separate precisely
// so the person building next term is not the person who can restructure a course or
// rewrite a register. Pointed at the /hnd routes they would get a 403 and an empty Groups
// tab, with nothing on it saying why.
//
// WHAT THIS ADDS THAT /hnd/cohorts DOES NOT: the school. sCohort carries id, name,
// courseId, startDate and createdAt, so a client holding store.cohorts cannot say which
// school a group is in, cannot group the tab by school and cannot filter the course
// picker. That is not an oversight there — the Registers screen has a course in hand
// already — it is simply a different question.
const { sGroup, sCourseOption } = require("../timetabling/serialize");
const predictionRunner = require("../prediction/runner");

/**
 * Flag students whose progression score a change here has invalidated.
 *
 * The same helper routes/hnd.js carries, and deliberately the same shape: it swallows its
 * own failure, because a cache that could not be invalidated must never be reported to an
 * administrator as a delete that did not happen. Flagging is cheap and does NOT rescore —
 * a group being deleted must not wait on a cohort's worth of arithmetic.
 */
async function flagStale(studentIds, what) {
  if (!studentIds.length) return;
  try { await predictionRunner.markStale(studentIds); }
  catch (e) { console.error(`[prediction] could not flag scores after ${what}:`, e.message); }
}

/**
 * Every group, with the school it is in and how many people are in it.
 *
 * THE SCHOOL IS READ FROM THE COHORT'S OWN COLUMN, not derived here from the course.
 * Cohort.academicDepartmentId already exists and is a denormalised copy of the course's
 * department, maintained by academicDepartments.assignCourses() — the one implementation
 * of "move a course and everything hanging off it". Computing it here from
 * `course.academicDepartmentId` would be a second definition of the same fact, which is
 * exactly the drift that column's schema comment warns about, and the scope guard resolves
 * a SINGLE hop off that column, so a route disagreeing with it would disagree with the
 * access boundary too.
 *
 * For the same reason there is no writable school on a group anywhere in this file. A
 * group's school comes from its COURSE; moving it means moving the course, which is
 * assignCourses()' job. A settable school on Cohort would be a second source of truth for
 * "which school is this group in", and the first course move would silently contradict it.
 *
 * ORDERED BY SCHOOL, THEN COURSE, THEN GROUP — the order the tab reads in, done in SQL
 * rather than in the client so that two clients cannot disagree about it. Groups with no
 * school sort LAST, because Postgres puts NULLs last in an ascending order and that is the
 * right end for them: they are the ones needing attention, and burying them above the
 * first real school is how nobody notices there are eleven of them.
 */
router.get("/groups", async (_req, res) => {
  const rows = await prisma.cohort.findMany({
    // A SELECT, not an include, so the allowlist starts at the query. sGroup is the second
    // half of the same promise; a column added to Cohort tomorrow reaches neither.
    select: {
      id: true, name: true, courseId: true, academicDepartmentId: true,
      course: { select: { name: true } },
      // The NAME comes from the joined row rather than from the cohort, so a school
      // renamed on Settings is renamed here too. Only the id is denormalised; a
      // denormalised name would have to be rewritten on every rename and would be wrong
      // until it was.
      academicDepartment: { select: { name: true } },
      _count: { select: { students: true } },
    },
    orderBy: [
      { academicDepartment: { name: "asc" } },
      { course: { name: "asc" } },
      { name: "asc" },
    ],
  });
  res.json(rows.map(sGroup));
});

/**
 * The courses the group form may offer, optionally narrowed to one school.
 *
 * WHY NOT /hnd/courses: it is gated on "registers" for its writes and lives on a screen
 * this caller may not hold at all. Same rows, different door — see the section header.
 *
 * THREE CASES FOR THE FILTER, copied deliberately from academicDepartmentFilter() in
 * routes/hnd.js so that two screens narrow by the same rules:
 *
 *   omitted   -> every course
 *   "none"    -> the courses no school has been assigned to yet
 *   an id     -> that school's courses
 *
 * The third case is not decoration. A college mid-setup has courses in no school at all,
 * and a picker that could only ever show assigned ones would make those courses
 * unreachable from the screen that has to file their groups. An UNRECOGNISED id is passed
 * through as itself and simply matches nothing — not ignored, because a filter that
 * silently dropped a value it did not recognise would show the whole college's courses
 * under one school's heading, which is the failure worth avoiding.
 *
 * A FILTER, NOT A BOUNDARY. Course is scoped by academicDepartmentId in
 * academicScopeModels.js, so a departmental account already sees only its own courses
 * whatever it passes here; this narrows a view the caller chose and grants nothing.
 */
router.get("/courses", async (req, res) => {
  const filter = str(req.query.academicDepartmentId);
  const where = !filter ? {}
    : filter === "none" ? { academicDepartmentId: null }
    : { academicDepartmentId: filter };

  const rows = await prisma.course.findMany({
    where,
    select: { id: true, name: true, academicDepartmentId: true },
    orderBy: { name: "asc" },
  });
  res.json(rows.map(sCourseOption));
});

/**
 * Rename a group. THE NAME AND NOTHING ELSE.
 *
 * Not the course: moving a group to another course moves its students' whole curriculum,
 * its terms and its registers, and is a registry act rather than a timetabling one. Not
 * the school, for the reason GET /groups states at length — a group's school is its
 * course's. Not the start date, which is what the term calendar is generated from and
 * belongs beside the terms on the Registers screen. Each of those is a bigger act wearing
 * a rename's clothes, and this endpoint is reachable by an account holding "scheduling"
 * alone.
 *
 * CASE-INSENSITIVE CLASH, WITHIN THE COURSE. The uniqueness rule is Cohort's own
 * @@unique([courseId, name]): a name is unique per COURSE, not per college, because two
 * courses both running a "SEP 2025" intake is normal and forbidding it would be wrong.
 *
 * It is case-INSENSITIVE here where POST and PUT /hnd/cohorts are case-SENSITIVE, and that
 * difference is deliberate rather than an oversight in either place. Those handlers compare
 * with `findFirst({ where: { courseId, name } })`, which Postgres answers case-sensitively,
 * so "SEP 2025" and "Sep 2025" are two accepted rows there. On a screen that lists every
 * group in the college grouped by school they are indistinguishable, and a class addressed
 * to the wrong one is a register nobody takes. Refusing the near-duplicate is the same
 * instinct POST /departments above already follows for school names, and it is strictly
 * NARROWER than the database constraint — so nothing this accepts can fail the unique, and
 * no name /hnd already stored becomes unreadable here.
 */
router.put("/groups/:id", async (req, res) => {
  const existing = await prisma.cohort.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, courseId: true },
  });
  if (!existing) return res.status(404).json({ error: "Group not found" });

  const raw = str(req.body?.name);
  if (!raw) return res.status(400).json({ error: "A group name is required" });
  // Capped, then clash-checked on the CAPPED value — checking the submitted name and
  // storing the truncation is how two identical rows get past a cap meant to stop them.
  const name = raw.slice(0, MAX);
  if (name === existing.name) return res.json({ ok: true, id: existing.id, name: existing.name, unchanged: true });

  const siblings = await prisma.cohort.findMany({
    where: { courseId: existing.courseId, id: { not: existing.id } },
    select: { id: true, name: true },
  });
  const clash = siblings.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) return res.status(409).json({ error: `"${clash.name}" already exists on this course` });

  let row;
  try {
    row = await prisma.cohort.update({ where: { id: existing.id }, data: { name } });
  } catch (e) {
    // The read above cannot close the window between two administrators renaming at once;
    // @@unique([courseId, name]) can, and the loser is told rather than handed a 500.
    if (e.code === "P2002") return res.status(409).json({ error: `"${name}" already exists on this course` });
    if (e.code === "P2025") return res.status(404).json({ error: "Group not found" });
    throw e;
  }

  // NO flagStale HERE, and it is worth saying so out loud. A progression score is
  // calculated over a group's TERM DATES and its members' attendance; a name is a label on
  // a screen and appears in no window, no denominator and no threshold. routes/hnd.js
  // flags on a cohort being DELETED and on a term's dates MOVING, and on neither rename —
  // flagging here would rescore a whole intake for a corrected typo.
  audit.record(req, {
    action: "cohort.renamed", entity: "Cohort", entityId: row.id,
    summary: `Group "${existing.name}" was renamed to "${row.name}" from the timetable planner by ` +
      (req.user?.name || "an administrator"),
    before: { name: existing.name },
    after: { name: row.name },
  });
  res.json({ ok: true, id: row.id, name: row.name });
});

/**
 * Delete a group — ONLY WHEN IT IS EMPTY.
 *
 * A POPULATED GROUP IS REFUSED, and that is the whole reason this is not a one-liner.
 * Student.cohortId is `onDelete: SetNull`, so deleting a cohort neither fails nor deletes
 * anybody: it quietly detaches every student in it. Two things then happen at once,
 * neither of them visible on this screen. The students land in no group — which under
 * departmental scoping is how they reach their own school at all — and their progression
 * scores are calculated over their cohort's TERM dates, which the cascade has just deleted
 * along with the Term rows, so the window every score was measured in is gone. Thirty
 * people silently un-grouped and un-scored, from a button labelled "delete".
 *
 * DELETE /hnd/cohorts does exactly that and flags the detached students afterwards, which
 * is the right treatment on a registry screen where emptying an intake is a deliberate
 * act. It is the wrong default for a planner: the person clearing a duplicate group off
 * the Groups tab is not the person who meant to empty an intake. So the count comes first
 * and a 409 names it, because "move them first" is an instruction somebody can act on
 * where a silent success is not.
 *
 * Retiring rather than deleting — the answer DELETE /departments/:id gives to the same
 * problem — was the rejected alternative: Cohort has no `active` column, adding one would
 * put a second lifecycle on the model every register hangs off, and unlike a school a
 * group with nobody in it genuinely is disposable.
 */
router.delete("/groups/:id", async (req, res) => {
  const id = req.params.id;
  const existing = await prisma.cohort.findUnique({
    where: { id },
    select: { id: true, name: true, courseId: true, course: { select: { name: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Group not found" });

  const studentCount = await prisma.student.count({ where: { cohortId: id } });
  if (studentCount > 0) {
    return res.status(409).json({
      error: `"${existing.name}" still has ${studentCount} student${studentCount === 1 ? "" : "s"} in it. ` +
        "Move them to another group first — deleting this one would take them out of every " +
        "group and out of the term dates their attendance is measured against.",
      studentCount,
    });
  }

  // THE AFFECTED SET, READ BEFORE THE DELETE — and it is NOT the group's own students,
  // because the guard above has just proved there are none.
  //
  // Unit.cohortId is SetNull as well, so deleting even an empty group detaches any units
  // pinned to it, and Unit.termId goes with them because the Terms cascade away. A unit's
  // term is part of the window its enrolled students are scored over, and those students
  // belong to OTHER groups, so nothing else in this request would ever reach them.
  // routes/hnd.js does not flag them either — but there the group's own members dominate
  // the affected set, and here they cannot exist, so flagging only members would be a call
  // that discriminates nothing.
  const strandedUnits = await prisma.unit.findMany({ where: { cohortId: id }, select: { id: true } });
  const affected = strandedUnits.length
    ? [...new Set((await prisma.enrolment.findMany({
        where: { unitId: { in: strandedUnits.map((u) => u.id) } },
        select: { studentId: true },
      })).map((e) => e.studentId))]
    : [];

  try {
    await prisma.cohort.delete({ where: { id } });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Group not found" });
    throw e;
  }
  await flagStale(affected, "an empty group being deleted");

  audit.record(req, {
    action: "cohort.deleted", entity: "Cohort", entityId: id,
    summary: `Empty group "${existing.name}"` +
      (existing.course?.name ? ` on ${existing.course.name}` : "") +
      ` was deleted from the timetable planner by ${req.user?.name || "an administrator"}`,
    before: { name: existing.name, courseId: existing.courseId, studentCount: 0 },
    after: null,
  });
  res.json({ ok: true, unitsDetached: strandedUnits.length, scoresFlagged: affected.length });
});

/* ----------------------------------------------------------------- events -- */

const { findClashes } = require("../timetabling/overlap");
const { syncEventRegisters } = require("../timetabling/registers");
const { sEvent } = require("../timetabling/serialize");

// Everything sEvent names. Kept in one constant because four handlers need the same
// shape and a query that forgets one of these returns an event whose room is null on
// the screen for no reason a reader could work out.
const EVENT_INCLUDE = {
  unit: { select: { code: true, name: true } },
  course: { select: { name: true } },
  // campusRef so roomLabel prints the CURRENT campus name, not the legacy string.
  room: { select: { id: true, name: true, floor: true, campus: true, campusRef: { select: { name: true } } } },
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
  //
  // academicDepartmentId — the SCHOOL — joins the list here rather than getting a
  // clause of its own, because it wants exactly the same treatment: optional, cleared
  // by an empty string, never invented. The column has existed on TimetableEvent since
  // the scoping work and nothing has ever set it, so every event at every install
  // carries NULL. That is not an accident to be fixed by defaulting: on this model NULL
  // means "shown to everyone" (the schema says so at length, and academicScopeModels.js
  // gives it its own `columnOrNull` kind), which is the right answer for the workshops
  // and study-support sessions this table exists to hold. Setting it is how a class
  // becomes one school's rather than the college's, and that has to stay a decision the
  // administrator takes.
  for (const [key, field] of [["unitId", "unitId"], ["courseId", "courseId"], ["roomId", "roomId"], ["categoryId", "categoryId"], ["academicDepartmentId", "academicDepartmentId"]]) {
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

/**
 * Create an event and its staff/group assignments.
 *
 * THREE STATEMENTS, NOT ONE NESTED CREATE.
 *
 * This was once an isolation rule: db.js stamped the tenant onto `args.data` at the
 * top level only, so join rows created inside a nested `staff: { create: [...] }`
 * would have been written belonging to no institution. That extension is gone.
 *
 * The shape survives it, because Prisma refuses the nested form here anyway: the
 * nested input type wants a `staff` relation connect, not the `staffId` scalar these
 * join rows are built from. Writing the assignments as their own createMany calls is
 * what makes them expressible at all, which is why the update handler below already
 * reads this way and why this is a shared helper — a third call site written from
 * first principles would rediscover the same wall.
 *
 * Wrapped in a transaction so an event cannot survive without the assignments that
 * were meant to come with it: a lecture that silently belongs to nobody is exactly
 * the "quietly wrong timetable" this module exists to prevent.
 */
function createEventWithAssignments(data, staffIds, cohortIds, include) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.timetableEvent.create({ data });
    if (staffIds.length) await tx.timetableEventStaff.createMany({ data: staffIds.map((staffId) => ({ eventId: event.id, staffId })) });
    if (cohortIds.length) await tx.timetableEventGroup.createMany({ data: cohortIds.map((cohortId) => ({ eventId: event.id, cohortId })) });
    return include ? tx.timetableEvent.findUnique({ where: { id: event.id }, include }) : event;
  });
}

// Create one event, or a whole series in one call.
//
// A SERIES IS ONE REQUEST, NOT A CREATE FOLLOWED BY A REPEAT. The two-step it replaces
// (create Tuesday, then "repeat weekly until") could only ever produce ONE weekday, so a
// module taught Monday and Thursday was two series — and two series drift, because
// somebody moves the Monday one and nothing records that the Thursday one was ever the
// same class. `seriesId` is what ties them together now.
// A DAY MAY BE TWO BLOCKS, AND EACH BLOCK IS ITS OWN EVENT. A module taught 09:00-12:00
// and 13:00-16:00 on three days for twelve weeks is 72 rows, all under one seriesId, and
// therefore 72 registers — which is what the college is actually asking for when it says
// "morning and afternoon". See timetabling/sessions.js for why this is two events rather
// than one event holding two time ranges.
/**
 * Confirm every relation id on `data` names a row that exists.
 *
 * Returns a message naming the offending field, or null. Only checks the keys actually
 * present and non-null, so it costs nothing for the fields a caller left alone.
 */
async function checkRelations(data) {
  const checks = [
    ["unitId", "module", (id) => prisma.unit.count({ where: { id } })],
    ["roomId", "room", (id) => prisma.room.count({ where: { id } })],
    ["categoryId", "category", (id) => prisma.eventCategory.count({ where: { id } })],
    ["academicDepartmentId", "school", (id) => prisma.academicDepartment.count({ where: { id } })],
  ];
  for (const [field, label, count] of checks) {
    const id = data[field];
    if (!id) continue;
    if ((await count(id)) === 0) {
      return `That ${label} no longer exists — reload the page and choose it again.`;
    }
  }
  return null;
}

router.post("/events", async (req, res) => {
  // SESSIONS ARE PARSED BEFORE THE EVENT, and the order is load-bearing rather than
  // tidy. parseEvent requires `start` and `end`, so a client that expressed its times
  // ONLY as sessions[] — the natural thing to send, and what the planner screen does —
  // would be refused for omitting a field its sessions replace. Feeding parseEvent the
  // first session closes that, and leaves the legacy top-level pair working untouched
  // because parseSessions falls back to exactly those two fields when no array is sent.
  const { sessions, error: sessionError } = parseSessions(req.body);
  if (sessionError) return res.status(400).json({ error: sessionError });

  const { data, error } = parseEvent({ ...req.body, start: sessions[0].start, end: sessions[0].end }, false);
  if (error) return res.status(400).json({ error });

  const staffIds = ids(req.body?.staffIds);
  const cohortIds = ids(req.body?.cohortIds);

  // A STALE ID IS THE ADMINISTRATOR'S PROBLEM AND MUST BE NAMED, not a 500.
  //
  // These four go straight to Prisma as foreign keys. A room deleted in another tab, a
  // category retired between page load and save, a school that no longer exists — each
  // raises P2003 inside the create transaction, which index.js logs and answers as
  // `500 "Server error"`. The screen then shows "Module 1: Server error": a message that
  // names neither the field nor the fact that reloading fixes it, and a client mistake
  // recorded in the log as a server fault.
  //
  // One count per relation actually present on the body — four cheap reads at most, and
  // only on the create path, against a request that is about to do far more work than
  // this.
  const relationErr = await checkRelations(data);
  if (relationErr) return res.status(400).json({ error: relationErr });

  const endDate = str(req.body?.endDate);

  // No endDate AND one session means the old behaviour exactly: one event on one date,
  // no seriesId, the same response keys. Every client written before sessions existed
  // lands here unchanged.
  //
  // TWO SESSIONS ON A SINGLE DAY DELIBERATELY DOES NOT, and that is the one place this
  // handler's shape had to change rather than merely extend. Leaving the fast path to
  // match on `!endDate` alone would have taken a request carrying a morning and an
  // afternoon block and written the morning, silently, with a 201 and `created: 1` — the
  // quiet half-save this module exists to prevent. A one-off day with two blocks falls
  // through to the loop below and gets a seriesId, which is correct: the two halves are
  // one submission and "cancel this class" has to reach both.
  if (!endDate && sessions.length === 1) {
    const warnings = await checkClashes({ ...data, id: null }, { roomId: data.roomId || null, staffIds, cohortIds });
    const row = await createEventWithAssignments(data, staffIds, cohortIds, EVENT_INCLUDE);
    return res.status(201).json({ event: sEvent(row), warnings, created: 1, sessionsPerDay: 1 });
  }

  let dates;
  if (endDate) {
    if (!DATE_RE.test(endDate)) return res.status(400).json({ error: "endDate must be YYYY-MM-DD" });
    if (endDate < data.date) return res.status(400).json({ error: "endDate must not be before the start date" });

    const skip = new Set(ids(req.body?.skip));
    // Bank holidays are skipped unless the caller says otherwise, matching /repeat. The
    // college that DOES teach on Easter Monday says so; hardcoding one answer to somebody
    // else's policy is the worse failure.
    if (req.body?.skipBankHolidays !== false) {
      for (let y = Number(data.date.slice(0, 4)); y <= Number(endDate.slice(0, 4)); y++) {
        for (const d of bankHolidays.ukBankHolidays(y) || []) skip.add(d);
      }
    }

    dates = seriesDates(data.date, endDate, req.body?.days, { skip: [...skip] });
    if (!dates.length) {
      // An empty series is a real answer — "Tuesdays" over a range containing no Tuesday —
      // and 400 with the reason beats silently creating nothing and reporting success.
      return res.status(400).json({ error: "No dates fall on the days you chose within that range." });
    }
  } else {
    // Two blocks, one day, no range. NO weekday filter and NO bank-holiday skip here:
    // the administrator typed this single date, and silently dropping it because it is
    // Easter Monday would report success having created nothing at all.
    dates = [data.date];
  }

  // DATES OUTER, SESSIONS INNER, so the rows are written in the order a person reads a
  // timetable and `first` below is genuinely the earliest class. It also means the
  // afternoon block's clash check runs after the morning one is stored, which is the
  // same "a later date sees the earlier ones" property the date loop already had — and
  // back-to-back blocks still do not warn, because findClashes is half-open.
  //
  // Reported PER DATE AND PER BLOCK, because "week 4, the afternoon" is actionable and
  // "there were clashes" is not. `date` and `clashes` keep their meaning; `start`/`end`
  // are what stop two warnings on one date being indistinguishable once a day can hold
  // two blocks.
  const seriesId = randomUUID();
  const warnings = [];
  let first = null;
  let written = 0;
  try {
    for (const date of dates) {
      for (const session of sessions) {
        const candidate = { ...data, date, startTime: session.start, endTime: session.end, id: null };
        const found = await checkClashes(candidate, { roomId: data.roomId || null, staffIds, cohortIds });
        if (found.length) warnings.push({ date, start: session.start, end: session.end, clashes: found });
        const row = await createEventWithAssignments(
          { ...data, date, startTime: session.start, endTime: session.end, seriesId },
          staffIds, cohortIds, first ? null : EVENT_INCLUDE,
        );
        if (!first) first = row;
        written++;
      }
    }
  } catch (e) {
    // A HALF-WRITTEN SERIES IS REPORTED WITH ITS seriesId, not swallowed into a bare 500.
    //
    // The loop is deliberately N small transactions rather than one large one — each
    // createEventWithAssignments is already a transaction, and holding one open across
    // seventy-two of them would pin a connection for the whole request. The cost of that
    // choice is that a failure at row 40 leaves 40 committed rows, and until now the
    // seriesId that identifies them was minted here and only ever returned in the SUCCESS
    // body. So the rows existed, were on the calendar, and the one handle that could
    // find them as a set had been discarded — leaving an administrator to identify forty
    // classes by title and date, by eye.
    //
    // Rethrowing after answering is not an option, so the error is logged for the
    // operator and the caller is told exactly what to clean up.
    console.error("[timetabling] series create failed after", written, "row(s), seriesId", seriesId, "-", e?.message);
    return res.status(500).json({
      error: `Only ${written} of ${dates.length * sessions.length} classes were created before this failed. `
        + `They are saved under series ${seriesId} — delete those before trying again, or you will get two copies.`,
      seriesId, created: written, expected: dates.length * sessions.length,
      partial: true,
    });
  }

  res.status(201).json({
    event: sEvent(first), seriesId,
    // Every row written. `dates` and `sessionsPerDay` are the two factors of it, sent
    // separately so a screen can say "24 days × 2 sessions" rather than an unexplained
    // 48 — a number nobody can check is a number nobody trusts.
    created: dates.length * sessions.length,
    dates, sessionsPerDay: sessions.length,
    // Echoed back NORMALISED — sorted, trimmed — because the client may have sent them
    // in either order and the screen should name the blocks the way they were stored.
    sessions,
    warnings,
  });
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

  // The register follows the event — unless it has already been marked, in which case
  // it stays where it is and says so. `frozen` is how an administrator learns that the
  // class they just moved has a taken register still sitting at the old time; without
  // it the edit looks entirely successful and the divergence surfaces weeks later, in
  // a dispute, with nobody able to say when the times stopped matching.
  const registers = await syncEventRegisters(existing.id);

  res.json({ event: sEvent(row), warnings, registers });
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

/* ---------------------------------------------------- repeat and publish -- */

const { weeklyDates } = require("../timetabling/recurrence");
const bankHolidays = require("../bankHolidays");

/**
 * Copy one event forward, weekly, to `until`.
 *
 * This exists because hand-entering twelve weeks of a Tuesday lecture is not a
 * feature, it is a reason a tool goes unused.
 *
 * Bank holidays are skipped BY DEFAULT but the caller can say otherwise. The
 * register generator does not consult bankHolidays.js at all, which is why registers
 * get generated on Easter Monday; that is a known defect and this does not repeat
 * it. It stays a flag rather than a rule because whether a college teaches on a
 * given holiday is that college's policy, and hardcoding one answer to somebody
 * else's policy is the worse failure.
 */
router.post("/events/:id/repeat", async (req, res) => {
  const until = str(req.body?.until);
  if (!DATE_RE.test(until)) return res.status(400).json({ error: "until must be YYYY-MM-DD" });

  const source = await prisma.timetableEvent.findUnique({ where: { id: req.params.id }, include: EVENT_INCLUDE });
  if (!source) return res.status(404).json({ error: "Event not found" });
  if (until <= source.date) return res.status(400).json({ error: "until must be after the event's own date" });

  const skip = new Set(ids(req.body?.skip));
  if (req.body?.skipBankHolidays !== false) {
    const years = new Set([source.date.slice(0, 4), until.slice(0, 4)]);
    // ukBankHolidays(year) — the England & Wales dates as an array of 'YYYY-MM-DD'
    // strings, which is exactly the shape `skip` wants. Named for the jurisdiction
    // on purpose: it encodes the England & Wales rules including the Christmas and
    // New Year weekend substitutions, and a Scottish or Northern Irish college would
    // need a different list rather than a different call. The sibling export
    // namedUkBankHolidays() carries the same dates with their names and is for
    // messaging ("college closed tomorrow"); pairing the name with each date here
    // would mean carrying a label nothing on this path ever reads.
    for (const y of years) for (const d of bankHolidays.ukBankHolidays(Number(y)) || []) skip.add(d);
  }

  // The source date itself is dropped: the event already exists on it, and copying
  // it would double-book the room against itself on day one.
  const dates = weeklyDates(source.date, until, { skip: [...skip] }).filter((d) => d !== source.date);

  const staffIds = (source.staff || []).map((s) => s.staffId);
  const cohortIds = (source.groups || []).map((g) => g.cohortId);

  const warnings = [];
  let created = 0;
  for (const date of dates) {
    const candidate = { id: null, date, startTime: source.startTime, endTime: source.endTime };
    const found = await checkClashes(candidate, { roomId: source.roomId || null, staffIds, cohortIds });
    // Reported per date rather than as one lump, because "week 4 clashes" is
    // actionable and "there were clashes" is not.
    if (found.length) warnings.push({ date, clashes: found });

    // Same helper as the create handler, for the same reason: a nested create would
    // leave the join rows unstamped by db.js. A repeat is the call most likely to
    // have got this wrong quietly, because it writes a whole term at once.
    await createEventWithAssignments({
      date, startTime: source.startTime, endTime: source.endTime,
      title: source.title, notes: source.notes,
      unitId: source.unitId, courseId: source.courseId,
      roomId: source.roomId, categoryId: source.categoryId,
      published: source.published,
    }, staffIds, cohortIds, null);
    created++;
  }

  res.json({ created, dates, warnings });
});

/**
 * Flip `published` across a date range. This is the one switch that makes a term's
 * work visible to staff, exactly as TimetableSlot's publish flag governs what
 * students see.
 */
router.post("/events/publish", async (req, res) => {
  const from = str(req.body?.from), to = str(req.body?.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "to must not be before from" });
  if (typeof req.body?.published !== "boolean") return res.status(400).json({ error: "published must be true or false" });

  const { count } = await prisma.timetableEvent.updateMany({
    where: { date: { gte: from, lte: to } },
    data: { published: req.body.published },
  });

  // Stamped in a SECOND pass, narrowed to `publishedAt: null`, and only when going live.
  //
  // publishedAt means "when this first went out". Re-publishing a term after a
  // withdrawal must not rewrite it, or the record of when students were first told is
  // destroyed by an administrator fixing a typo. Withdrawing does not clear it either,
  // for the same reason — which is what makes it distinguishable from `published`.
  if (req.body.published) {
    await prisma.timetableEvent.updateMany({
      where: { date: { gte: from, lte: to }, published: true, publishedAt: null },
      data: { publishedAt: new Date() },
    });
  }
  // NOT a changedAt bump. Publishing does not move anything; marking a whole term as
  // "recently changed" the moment it goes live would make the highlight meaningless
  // on the first day anybody used it.

  // REGISTERS ARE BUILT AFTER THE FLAG IS SET, one event at a time, and the outcome is
  // REPORTED rather than summarised as "published".
  //
  // A term publish is exactly where an administrator needs to know that four workshops
  // produced no register because they have no module, and that two registers did not
  // move because they had already been taken. Returning only a count leaves all of that
  // to be discovered later by whoever the register is wrong for.
  const ids = req.body.published
    ? (await prisma.timetableEvent.findMany({
        where: { date: { gte: from, lte: to }, published: true },
        select: { id: true },
      })).map((e) => e.id)
    : [];

  const registers = { created: 0, updated: 0, frozen: [], skipped: [] };
  for (const id of ids) {
    const r = await syncEventRegisters(id);
    registers.created += r.created;
    registers.updated += r.updated;
    registers.frozen.push(...r.frozen);
    registers.skipped.push(...r.skipped);
  }
  // Collapsed to counts per reason: a term of 300 workshops would otherwise return 300
  // identical sentences, and a report nobody can read is not a report.
  const bySkipReason = {};
  for (const s of registers.skipped) bySkipReason[s.reason] = (bySkipReason[s.reason] || 0) + 1;

  res.json({
    updated: count,
    registers: {
      created: registers.created,
      updated: registers.updated,
      frozen: registers.frozen,
      skipped: Object.entries(bySkipReason).map(([reason, events]) => ({ reason, events })),
    },
  });
});

/* --------------------------------------------------------------- settings -- */

const timetableSettings = require("../timetabling/settings");
const { DEFAULTS: SETTINGS_DEFAULTS } = require("../timetabling/settingsDefaults");

/**
 * What the college has set, and what it would be if it set nothing.
 *
 * Both, deliberately. The screen needs to show an administrator which values are
 * theirs and which are inherited — otherwise "reset to default" has nothing to reset
 * to, and every field looks equally deliberate.
 */
router.get("/settings", async (_req, res) => {
  res.json({ defaults: SETTINGS_DEFAULTS, institution: await timetableSettings.getInstitution() });
});

// A patch: the screen sends the field it changed. Unknown and invalid keys are
// dropped by cleanInstitution rather than stored, so a client sending nonsense cannot
// park it in the column for a later reader to trip over.
router.put("/settings", async (req, res) => {
  const saved = await timetableSettings.saveInstitution(req.body || {}, req.user?.name || req.user?.email || "");
  res.json({ institution: saved });
});

module.exports = router;
