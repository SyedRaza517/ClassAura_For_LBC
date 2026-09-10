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
const audit = require("../audit");
const { requireAuth, requirePage } = require("../auth");
const { isString } = require("../validate");
const tapConfig = require("../attendanceTapConfig");
const { describeAddress, parseCidr } = require("../presence");

router.use(requireAuth, requirePage("attendance-settings"));

// 16 random bytes, base64url. Not sequential and not derived from the label: a code
// guessable from the sticker in the next room is a check-in nobody attended.
const newCode = () => crypto.randomBytes(16).toString("base64url");

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

  // WHICH LINES WE THREW AWAY, so an administrator is told rather than left to notice.
  //
  // The settings module drops an unusable range and keeps the rest, which is the right
  // behaviour — a college pasting four ranges off a network diagram will get one wrong,
  // and refusing the whole save punishes the typo by leaving check-in unprotected. But
  // dropping it SILENTLY is how somebody saves a list of four, sees four lines of text go
  // in, and finds out in a lecture theatre that only three of them work.
  //
  // Deliberately not an error: the save has already happened and the good lines are in
  // force. This is the receipt, not a refusal.
  const rejectedNetworks = Array.isArray(patch.allowedNetworks)
    ? patch.allowedNetworks
        // A blank line is what a textarea produces from a stray Enter. Not a mistake, and
        // reporting it as one trains an administrator to ignore this list.
        .filter((e) => !(typeof e === "string" && !e.trim()))
        // Two ways a line fails to make it: it is not a range at all, or it is one and did
        // not survive the cap. Both are worth reporting, and testing membership catches
        // the second without needing to know where the cap is. A duplicate is NOT caught
        // here, correctly — both copies are present in the saved list.
        .filter((e) => !parseCidr(e) || !settings.allowedNetworks.includes(e.trim()))
        .map((e) => String(e).slice(0, 60))
    : [];

  res.json({ ...settings, rejectedNetworks });
});

// GET /api/tags/settings/my-address — the address THIS request arrived from.
//
// The single most likely way the network check fails at a real college: somebody types
// the address off a router's label, or the one their provider quoted them years ago, and
// it is not the address their traffic actually leaves from. Every student is then refused
// and the settings screen cheerfully reports that the network is configured.
//
// The fix is not documentation. It is showing an administrator, standing in their own
// college on their own WiFi, the address WE see — so they can add that one. `allowlistable`
// is the honest half: a college whose traffic leaves over IPv6 cannot use this feature,
// because the ranges are IPv4-only, and they need to know that while they are looking at
// the screen rather than after a hall of students cannot check in.
//
// Declared BEFORE GET /:id/log and PATCH /:id, like GET /settings above, or "settings"
// is parsed as a tag id. Express matches in declaration order.
router.get("/settings/my-address", (req, res) => {
  res.json(describeAddress(req.ip));
});

// GET /api/tags — every sticker this college has registered. Never the codes.
router.get("/", async (_req, res) => {
  const rows = await prisma.attendanceTag.findMany({ orderBy: { label: "asc" } });
  res.json(rows.map(sTag));
});

// The shortest code we will accept from a caller. A tag's factory UID is 4–7 bytes,
// which is 8–14 hex characters, so this admits a real UID and refuses "room1".
const MIN_SUPPLIED_CODE = 8;

// How fast codes that came from outside this system may be registered. Deliberately
// generous: registering a blank sticker means walking to it, holding a phone against it
// and typing a room name, so one every fifteen seconds is a brisk rollout and sixty in
// ten minutes is well clear of it. What it is not clear of is a script, which is the only
// version of this that scales — and a script pointed at this endpoint fills AttendanceTag
// with rows for stickers nobody owns.
//
// WHY IT IS ONE COUNTER AND NOT A MAP.
//
// It was `Map<tenantId, timestamps[]>` and the reasoning was about squatting: with many
// colleges on one platform, pre-registering UIDs read off somebody else's blank pack took
// those stickers away from their rightful owner, and that is an act an INSTITUTION
// commits, so a college with five admins should not get five times the allowance for it.
// There is one institution now, so the map has one key, and one key is a counter. Note
// what did NOT change: it is still not keyed on the administrator, because the thing
// being paced is the deployment's rate of claiming codes, not any one person's.
//
// In-process and module-level, so it is correct for ONE Node process; a clustered
// deployment needs Redis. Same shape and same caveat as the tap limiter in
// routes/student.js.
let claimHits = []; // timestamps
const CLAIM_WINDOW_MS = 10 * 60_000;
const CLAIM_MAX = 60;
function claimAllowed() {
  const now = Date.now();
  claimHits = claimHits.filter((t) => now - t < CLAIM_WINDOW_MS);
  if (claimHits.length >= CLAIM_MAX) return false;
  claimHits.push(now);
  return true;
}

// POST /api/tags — register a sticker. The code comes back ONCE, to be written onto it.
//
// `code` is optional and exists for the second way of registering a sticker: an admin on
// a phone taps a BLANK tag and the app sends its factory UID. That needs no NFC writing
// tool at all — buy stickers, tap each one, name the room — which is a materially easier
// rollout than writing a generated secret onto every tag with a separate app. When it is
// omitted we generate a secret instead, for an admin working at a desktop with no NFC.
//
// A supplied code may already exist, and the two answers are deliberately different
// because they are two different situations wearing the same 409:
//
//   * A RETIRED sticker — restored, relabelled and handed back. Retiring a sticker must
//     take it out of service, not destroy it.
//   * A LIVE sticker — refused, but named, because the admin is entitled to know which of
//     their own rows they are looking at.
//
// There used to be a THIRD answer: "registered to another institution on this platform",
// refused without a word about whose, because the code column was unique across every
// college in one shared database and an administrator here was not entitled to learn
// anything about a college over there. One database per college deletes the case
// entirely — a code either is in this table or is not — so that branch and the
// cross-tenant probe behind it are gone rather than rephrased.
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

  // code is unique, so a clash here means this physical sticker is already registered —
  // which is exactly the case we must not paper over by generating a different code and
  // pretending it worked.
  if (code !== null) {
    // `code` is not selected. Nothing here needs it — we were handed it — and a variable
    // holding a live tag's secret is a variable that ends up in a log line one day.
    const ours = await prisma.attendanceTag.findUnique({
      where: { code },
      select: { id: true, label: true, active: true },
    });

    if (ours && !ours.active) {
      // RESTORE, rather than refuse. Retiring is meant to take a peeled-off or lost
      // sticker out of service; before this, it destroyed the sticker — the code is
      // globally unique so no second row can ever be created for the same physical tag,
      // and the 409 said "already registered" with no route back. The Retire button was
      // quietly a Destroy button.
      //
      // Reuse also keeps the tap log attached to the object it describes. A fresh row
      // would orphan it: the log that answers "I did tap and it didn't work" would start
      // again at nothing, while the sticker's real history sat under a tag nobody can see.
      //
      // THE ALTERNATIVE — refuse with "this is your tag ‘Room 101’, restore it from the
      // list" — is defensible and was rejected on where the administrator is standing.
      // They are in a corridor with a phone held against a sticker. The list cannot tell
      // them WHICH retired row this is, because a code is never shown on it: they would be
      // asked to identify one row among two hundred from a label somebody typed last year.
      // The server is the only party that can make that identification, and it is making
      // it right here. A refusal that names the tag would be an improvement on today and
      // still an instruction to go and do by hand what we have already worked out.
      //
      // The label comes from THIS request: they have just typed where the sticker is
      // going, and one retired from Room 101 and put up in Room 202 is Room 202. createdAt
      // and createdBy are deliberately left alone — they record when this sticker first
      // entered service and who put it there, which restoring does not change. Who
      // restored it is in the audit entry.
      const restored = await prisma.attendanceTag.update({
        where: { id: ours.id },
        data: { active: true, label: label.trim() },
      });

      audit.record(req, {
        action: "attendance.tag.restored", entity: "AttendanceTag", entityId: restored.id,
        summary: `Retired NFC tag "${ours.label}" brought back into use as "${restored.label}" by ${req.user?.name || "an administrator"}`,
        // Never the code, for the reason given on the create below: this log is read on
        // Settings by admins who were never granted this page.
        before: { label: ours.label, active: ours.active },
        after: { label: restored.label, active: restored.active },
      });

      // 200 and no `code`, both on purpose. Nothing was created, and nothing needs writing
      // onto a sticker that already carries its own identifier — the one place in this
      // feature that emits a code stays the one place. `restored` distinguishes the two
      // outcomes so a screen can say "brought back into use" instead of claiming a
      // registration that did not happen; the client ignores what it does not know.
      return res.json({ ...sTag(restored), restored: true });
    }

    if (ours) {
      // Ours and live. Naming it is the entire value of this message: "already registered"
      // sends an admin hunting for something they own, and it is our own label, so there
      // is nothing to protect by withholding it.
      //
      // NOT relabelled silently. A live sticker is on a wall being tapped, and quietly
      // renaming it through an endpoint the administrator believes is creating something
      // would move a room's attendance under a name nobody chose. Renaming is PATCH.
      return res.status(409).json({ error: `That sticker is already registered here, as "${ours.label}". Rename it from the list if it has moved.` });
    }

    // From here the code is one this college does not hold, so this request is claiming a
    // code that came from outside the system — a genuinely blank sticker's factory UID, or
    // a value someone typed. That is exactly the population worth pacing, and a first
    // rollout of blank stickers lands here too, hence the generous cap.
    if (!claimAllowed()) {
      return res.status(429).json({ error: "Too many new stickers in a short time. Wait a few minutes and carry on." });
    }
  }

  // The checks above are a read followed by a write, so two administrators tapping the
  // same sticker in the same second both get past them and the second create loses on the
  // unique index. That is the same answer as the check found it, arriving a moment later —
  // and answering it with a 500 would tell somebody their sticker is broken when it is
  // merely already registered. Caught narrowly: only P2002, only on `code`, so any other
  // failure still surfaces as a failure.
  let tag;
  try {
    tag = await prisma.attendanceTag.create({
      data: { code: code || newCode(), label: label.trim(), createdBy: req.user?.name || null },
    });
  } catch (e) {
    // Only for a SUPPLIED code. A generated one colliding would be 128 random bits landing
    // on a value already taken, which is not a thing that happens — and if it somehow did,
    // "somebody registered this a moment ago" would be a lie told confidently, which is
    // worse than the 500. meta.target is an array of column names on PostgreSQL and the
    // constraint's name on some other connectors, so it is matched as text: "code" appears
    // in both spellings.
    if (code !== null && e?.code === "P2002" && String(e?.meta?.target ?? "").includes("code")) {
      return res.status(409).json({ error: "That sticker was registered a moment ago. Refresh the list and check it is not already there." });
    }
    throw e;
  }

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
