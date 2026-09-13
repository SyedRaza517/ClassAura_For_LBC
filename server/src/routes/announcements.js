// Announcements — a lecturer tells the students of a unit they teach something, once,
// in writing, from the staff app. Delivery is a Notification row per enrolled student
// plus a push (notify.js#notifyStudent), so the student side reads NOTHING from here —
// their existing Inbox is the surface. This router owns the sender's side: which units
// they may announce to, the send itself, and their sent history.
//
// ACCESS IS IDENTITY, NOT A PAGE. The audience a sender can reach is exactly the
// students enrolled on a unit that names them — Unit.tutorStaffId, or being named on
// one of the unit's timetable events — which is the same pair of answers the register
// trusts (hnd.js#teachesSession, and the reasoning above it). No admin page is
// involved, deliberately: the blast radius is one class of students who already know
// this person, and a college-wide announcement is a different feature with a different
// audience that should arrive behind a page grant when it is built. The two
// hand-synced ADMIN_PAGES lists stay untouched.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, isStudent } = require("../auth");
const { notifyStudent } = require("../notify");
const audit = require("../audit");

// The whole surface is staff-only. Students are rejected by identity kind, not by a
// missing page — same shape as hnd.js#requireStaffAccount.
router.use(requireAuth, (req, res, next) =>
  (isStudent(req.user) ? res.status(403).json({ error: "Student accounts cannot send announcements." }) : next()));

// One message may not be longer than this. The text lands verbatim in Notification
// rows and on lock screens; past a few hundred characters it is a document, and
// documents have their own feature.
const MAX_MESSAGE = 500;

// Per-sender send limiter: 5 an hour. In-process and module-level, so it is correct
// for ONE Node process; a clustered deployment needs Redis. Same shape and same caveat
// as the sticker-claim limiter in routes/tags.js — except keyed per sender, because
// the thing being paced here is one person's ability to ping a class of phones, and
// one impatient sender must not spend the whole college's allowance.
const sendHits = new Map(); // senderId -> [timestamps]
const SEND_WINDOW_MS = 60 * 60_000;
const SEND_MAX = 5;
function sendAllowed(senderId) {
  const now = Date.now();
  const hits = (sendHits.get(senderId) || []).filter((t) => now - t < SEND_WINDOW_MS);
  if (hits.length >= SEND_MAX) { sendHits.set(senderId, hits); return false; }
  hits.push(now);
  sendHits.set(senderId, hits);
  return true;
}

// Both ways a unit can name this person, OR'd — neither subsumes the other (a visiting
// lecturer tutors nothing but is on the event; a module tutor may have no timetabled
// event at all). See hnd.js#teachesSession for the long form of this argument.
async function teachesUnit(staffId, unitId) {
  const unit = await prisma.unit.findUnique({
    where: { id: String(unitId || "") },
    select: { id: true, code: true, name: true, tutorStaffId: true },
  });
  if (!unit) return { unit: null, teaches: false };
  if (unit.tutorStaffId === staffId) return { unit, teaches: true };
  const named = await prisma.timetableEventStaff.count({ where: { staffId, event: { unitId: unit.id } } });
  return { unit, teaches: named > 0 };
}

// GET /api/announcements/my-units — where this person may announce, with how many
// students each send would reach, so the compose screen can say "23 students" BEFORE
// the button is pressed rather than surprising the sender afterwards.
router.get("/my-units", async (req, res) => {
  const me = req.user.id;
  const [tutored, named] = await Promise.all([
    prisma.unit.findMany({ where: { tutorStaffId: me }, select: { id: true } }),
    prisma.timetableEventStaff.findMany({ where: { staffId: me }, select: { event: { select: { unitId: true } } } }),
  ]);
  const ids = [...new Set([...tutored.map((u) => u.id), ...named.map((r) => r.event?.unitId).filter(Boolean)])];
  if (!ids.length) return res.json({ units: [] });
  const units = await prisma.unit.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, name: true, _count: { select: { enrolments: true } } },
    orderBy: { code: "asc" },
  });
  // Allowlist out: id, code, name, count. The unit row carries Moodle ids and tutor
  // columns nobody composing a message needs.
  res.json({ units: units.map((u) => ({ id: u.id, code: u.code, name: u.name, students: u._count.enrolments })) });
});

// POST /api/announcements — send one. { unitId, message }.
router.post("/", async (req, res) => {
  const me = req.user.id;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "The announcement needs a message." });
  if (message.length > MAX_MESSAGE) {
    return res.status(400).json({ error: `That message is ${message.length} characters — the limit is ${MAX_MESSAGE}. Longer than that is a document, and Documents is the feature for one.` });
  }

  const { unit, teaches } = await teachesUnit(me, req.body?.unitId);
  // A unit that does not exist answers the same 403 as one the caller does not teach:
  // whether a unit id is real is not something a stranger to it has standing to learn.
  // Mirrors lecturerGate's refusal wording.
  if (!teaches) return res.status(403).json({ error: "You can only announce to the classes you teach." });

  // The limiter runs AFTER the identity check, so probing someone else's unit ids
  // cannot spend a lecturer's own allowance for the hour.
  if (!sendAllowed(me)) {
    return res.status(429).json({ error: "That is five announcements inside an hour. Wait a while — a class whose phone buzzes this often stops reading them." });
  }

  const enrolled = await prisma.enrolment.findMany({ where: { unitId: unit.id }, select: { studentId: true } });
  const audienceLabel = `${unit.code} — ${unit.name}`;

  // The record FIRST, then delivery. notifyStudent is best-effort by design (it
  // swallows provider failures so a flaky push service cannot fail the request), so
  // the row must not depend on how delivery went; recipientCount is the audience at
  // the moment of sending, and `delivered` in the response says how the attempt did.
  const record = await prisma.announcement.create({
    data: { senderId: me, unitId: unit.id, audienceLabel, message, recipientCount: enrolled.length },
  });
  const results = await Promise.all(
    enrolled.map((e) => notifyStudent(e.studentId, { type: "info", message, link: "inbox" })),
  );
  const delivered = results.filter(Boolean).length;

  // The audit summary carries the audience and the size, never the message text — the
  // students it was for have it, and the audit log's readers are a different audience.
  audit.record(req, {
    action: "announcement.sent", entity: "Announcement", entityId: record.id,
    summary: `Announcement to ${audienceLabel} (${enrolled.length} student${enrolled.length === 1 ? "" : "s"})`,
  });

  res.status(201).json({ id: record.id, audienceLabel, recipients: enrolled.length, delivered });
});

// GET /api/announcements/mine — what I have sent, newest first. Scoped by token
// identity exactly like the student portal's queries: no id parameter exists.
router.get("/mine", async (req, res) => {
  const rows = await prisma.announcement.findMany({
    where: { senderId: req.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, audienceLabel: true, message: true, recipientCount: true, createdAt: true },
  });
  res.json({ announcements: rows });
});

module.exports = router;
