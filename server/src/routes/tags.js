// NFC tag administration — register a sticker, retire one, read its taps.
//
// The tag's `code` is the secret written onto the sticker. It is returned exactly once,
// to the administrator who creates it, because that is the moment somebody writes it
// onto the tag. There is deliberately no endpoint that reads a code back: a leaked code
// is a sticker anyone can simulate from anywhere, and the remedy is to retire it and
// write a new one, not to look the old one up.
const crypto = require("crypto");
const router = require("express").Router();
const prisma = require("../db");
const { crossTenant } = require("../db");
const audit = require("../audit");
const { requireAuth, requirePage } = require("../auth");
const { isString } = require("../validate");
const tapConfig = require("../attendanceTapConfig");

router.use(requireAuth, requirePage("attendance-tags"));

// 16 random bytes, base64url. Not sequential and not derived from the label: a code
// guessable from the sticker in the next room is a check-in nobody attended.
const newCode = () => crypto.randomBytes(16).toString("base64url");

/**
 * Is this physical tag already registered ANYWHERE on the platform?
 *
 * The one cross-tenant read in this feature, and it has to be: AttendanceTag.code is
 * globally unique, so a create() with a code another college already holds fails with an
 * opaque P2002 — and the honest answer to "is this sticker already in use" is yes, even
 * when the other holder is an institution this administrator cannot see.
 *
 * Returns a BOOLEAN and nothing else. Which college holds it, what they call it and when
 * they registered it all stay invisible; the caller learns only that this sticker is
 * spoken for, which is what they need to go and find a different one.
 */
async function crossTenantTagExists(code) {
  return await crossTenant(async () =>
    Boolean(await prisma.attendanceTag.findUnique({ where: { code }, select: { id: true } })));
}

// An allowlist, like every other serialiser here. Note what is absent: `code`. A column
// added to AttendanceTag tomorrow is private until somebody publishes it deliberately.
const sTag = (t) => ({
  id: t.id,
  label: t.label,
  active: t.active,
  lastTapAt: t.lastTapAt ?? null,
  createdAt: t.createdAt,
  createdBy: t.createdBy ?? null,
});

// GET /api/tags/settings — this college's tap check-in settings.
//
// Declared BEFORE GET /:id/log and PATCH /:id so "settings" is never parsed as a tag id.
// Express matches in declaration order, and a literal path that sorts after a parameter
// route is a route that never runs.
router.get("/settings", async (_req, res) => {
  res.json(await tapConfig.get());
});

// PUT /api/tags/settings — switch tap check-in on, or tune it.
//
// A PATCH in behaviour: only the keys sent are changed, so switching the feature on does
// not silently reset a lateness threshold somebody tuned last term. The allowlist and the
// caps live in the settings module, so nothing written here reads back as unusable.
router.put("/settings", async (req, res) => {
  const patch = req.body;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return res.status(400).json({ error: "Settings must be an object" });

  const before = await tapConfig.get();
  const { settings } = await tapConfig.save(patch, req.user?.name || null);

  // Worth auditing on its own. Switching this on makes every register in the college
  // writable by a student holding a phone, and switching it off silently stops
  // attendance being recorded — both are decisions somebody should be able to trace.
  audit.record(req, {
    action: "attendance.tap.settings.updated", entity: "AttendanceTapConfig", entityId: null,
    summary: before.enabled !== settings.enabled
      ? `Tap check-in ${settings.enabled ? "switched ON" : "switched OFF"} by ${req.user?.name || "an administrator"}`
      : `Tap check-in settings changed by ${req.user?.name || "an administrator"}`,
    before, after: settings,
  });

  res.json(settings);
});

// GET /api/tags — every sticker this college has registered. Never the codes.
router.get("/", async (_req, res) => {
  const rows = await prisma.attendanceTag.findMany({ orderBy: { label: "asc" } });
  res.json(rows.map(sTag));
});

// The shortest code we will accept from a caller. A tag's factory UID is 4–7 bytes,
// which is 8–14 hex characters, so this admits a real UID and refuses "room1".
const MIN_SUPPLIED_CODE = 8;

// POST /api/tags — register a sticker. The code comes back ONCE, to be written onto it.
//
// `code` is optional and exists for the second way of registering a sticker: an admin on
// a phone taps a BLANK tag and the app sends its factory UID. That needs no NFC writing
// tool at all — buy stickers, tap each one, name the room — which is a materially easier
// rollout than writing a generated secret onto every tag with a separate app. When it is
// omitted we generate a secret instead, for an admin working at a desktop with no NFC.
router.post("/", async (req, res) => {
  const label = req.body?.label;
  if (!isString(label) || !label.trim()) return res.status(400).json({ error: "A label is required — the room this sticker lives in" });
  if (label.length > 120) return res.status(400).json({ error: "That label is too long (120 characters maximum)" });

  const supplied = req.body?.code;
  if (supplied != null && !isString(supplied)) return res.status(400).json({ error: "code must be text" });
  const code = supplied ? supplied.trim() : null;
  if (code !== null && code.length < MIN_SUPPLIED_CODE) {
    return res.status(400).json({ error: `A tag's own code must be at least ${MIN_SUPPLIED_CODE} characters — a short one would be guessable` });
  }
  if (code !== null && code.length > 200) return res.status(400).json({ error: "That code is too long (200 characters maximum)" });

  // code is unique across every college, so a clash here means this physical sticker is
  // already registered — possibly to another institution, which is exactly the case we
  // must not paper over by generating a different code and pretending it worked.
  if (code !== null) {
    const clash = await crossTenantTagExists(code);
    if (clash) return res.status(409).json({ error: "That tag is already registered." });
  }

  const tag = await prisma.attendanceTag.create({
    data: { code: code || newCode(), label: label.trim(), createdBy: req.user?.name || null },
  });

  audit.record(req, {
    action: "attendance.tag.created", entity: "AttendanceTag", entityId: tag.id,
    summary: `NFC tag "${tag.label}" registered by ${req.user?.name || "an administrator"}`,
    // Never the code. The audit log is read on Settings by admins who were never granted
    // this page, and a code in it is a check-in they could manufacture.
    before: null, after: { label: tag.label },
  });

  res.status(201).json({ ...sTag(tag), code: tag.code });
});

// PATCH /api/tags/:id — rename, or retire a sticker that has been lost or peeled off.
router.patch("/:id", async (req, res) => {
  const tag = await prisma.attendanceTag.findUnique({ where: { id: req.params.id } });
  if (!tag) return res.status(404).json({ error: "Tag not found" });

  const data = {};
  if (req.body?.label != null) {
    if (!isString(req.body.label) || !req.body.label.trim()) return res.status(400).json({ error: "A label is required" });
    data.label = req.body.label.trim().slice(0, 120);
  }
  if (req.body?.active != null) {
    if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "active must be true or false" });
    data.active = req.body.active;
  }
  if (!Object.keys(data).length) return res.status(400).json({ error: "Nothing to change" });

  const updated = await prisma.attendanceTag.update({ where: { id: tag.id }, data });

  audit.record(req, {
    action: data.active === false ? "attendance.tag.retired" : "attendance.tag.updated",
    entity: "AttendanceTag", entityId: tag.id,
    summary: `NFC tag "${updated.label}" ${data.active === false ? "retired" : "updated"} by ${req.user?.name || "an administrator"}`,
    before: { label: tag.label, active: tag.active },
    after: { label: updated.label, active: updated.active },
  });

  res.json(sTag(updated));
});

// GET /api/tags/:id/log — this sticker's recent taps, refusals included.
//
// The refusals are the point. "I tapped and it didn't work" is answerable here and
// nowhere else, and so is a pattern — one address checking in six students inside a
// minute — which is invisible in AttendanceMark.
router.get("/:id/log", async (req, res) => {
  const tag = await prisma.attendanceTag.findUnique({ where: { id: req.params.id } });
  if (!tag) return res.status(404).json({ error: "Tag not found" });

  const rows = await prisma.tagTap.findMany({
    where: { tagId: tag.id },
    orderBy: { at: "desc" },
    take: 200,
  });

  // Names resolved in two queries rather than a join per row. NO email addresses: this
  // page is not the staff directory, and GET /staff already denies colleagues' addresses
  // to page-scoped admins for exactly this reason — otherwise a tag log becomes a way to
  // harvest the roster.
  const studentIds = [...new Set(rows.map((r) => r.studentId).filter(Boolean))];
  const staffIds = [...new Set(rows.map((r) => r.staffId).filter(Boolean))];
  const [students, staff] = await Promise.all([
    studentIds.length ? prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
    staffIds.length ? prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [],
  ]);
  const nameOf = new Map([
    ...students.map((s) => [s.id, `${s.firstName} ${s.lastName}`.trim()]),
    ...staff.map((s) => [s.id, s.name]),
  ]);

  res.json({
    tag: sTag(tag),
    taps: rows.map((r) => ({
      id: r.id,
      at: r.at,
      // null when the tap was refused before anyone was identified — which is a real
      // state, not a missing name.
      who: nameOf.get(r.studentId || r.staffId) || null,
      kind: r.studentId ? "student" : r.staffId ? "staff" : null,
      outcome: r.outcome,
      status: r.status ?? null,
      site: r.site ?? null,
    })),
  });
});

module.exports = router;
