// Conduct events — the two-tap behaviour/merit capture, and the vocabulary it offers.
//
// ACCESS IS IDENTITY, NOT A PAGE, for the capture half: a lecturer may log an event
// against a student ENROLLED ON A UNIT THAT NAMES THEM (as tutor, or on one of its
// timetable events) — the same pair of answers the register and announcements trust,
// widened from unit to student because the tap happens against a person, not a class.
// No admin page is involved in logging, deliberately: the surface is the lecturer's
// own register, about students they already stand in front of.
//
// The VOCABULARY is different: reading it is open to any member of staff (the sheet
// cannot render without it, and it is the college's public behaviour policy, not a
// secret), but changing it is requirePage("settings") — the same door every other
// college-policy edit walks through.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage, isStudent } = require("../auth");
const vocab = require("../conductConfig");
const { notifyStudent } = require("../notify");
const audit = require("../audit");

// Staff only, by identity kind — same shape as announcements and hnd's staff gate.
router.use(requireAuth, (req, res, next) =>
  (isStudent(req.user) ? res.status(403).json({ error: "Student accounts cannot use conduct points." }) : next()));

// Does this staff member teach this student? One count over enrolments, with the
// unit's two naming routes OR'd inside it — a row exists exactly when some unit both
// enrols the student and names the caller. See hnd.js#teachesSession for why neither
// half subsumes the other.
async function teachesStudent(staffId, studentId) {
  const n = await prisma.enrolment.count({
    where: {
      studentId,
      unit: {
        OR: [
          { tutorStaffId: staffId },
          { timetableEvents: { some: { staff: { some: { staffId } } } } },
        ],
      },
    },
  });
  return n > 0;
}

// GET /api/conduct/vocabulary — the entries, all of them; the sheet offers the active
// ones, the settings editor needs the rest. Always complete and valid (conductConfig
// falls back to the defaults), so no caller renders half a vocabulary.
router.get("/vocabulary", async (_req, res) => {
  res.json({ vocabulary: await vocab.get(), customised: await vocab.isCustomised() });
});

// PUT /api/conduct/vocabulary — replace it ({ vocabulary: [...] }), or reset
// ({ vocabulary: null }). College policy, so the settings door.
router.put("/vocabulary", requirePage("settings"), async (req, res) => {
  const list = req.body?.vocabulary === null ? null : req.body?.vocabulary;
  const saved = await vocab.save(list, req.user?.name || "");
  if (!saved.ok) return res.status(400).json({ error: saved.error });
  audit.record(req, {
    action: "conduct.vocabularySaved", entity: "ConductVocabularyConfig",
    summary: saved.reset
      ? `Conduct vocabulary reset to the platform defaults by ${req.user?.name || "an administrator"}`
      : `Conduct vocabulary updated by ${req.user?.name || "an administrator"} — ${saved.vocabulary.length} entries`,
  });
  res.json({ vocabulary: saved.vocabulary, reset: saved.reset === true });
});

// POST /api/conduct/events — log one. { studentId, key, note?, sessionId? }.
router.post("/events", async (req, res) => {
  const studentId = typeof req.body?.studentId === "string" ? req.body.studentId : "";
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 200) : "";

  // The entry decides everything about what is written; an unknown or inactive key
  // is refused rather than guessed at — an inactive entry is one the college has
  // withdrawn, and "the button still works if you know the key" is not withdrawal.
  const entry = (await vocab.get()).find((e) => e.key === key);
  if (!entry || !entry.active) return res.status(400).json({ error: "That conduct entry does not exist or has been retired." });

  // Same refusal for "not yours" and "not real" — whether a student id exists is not
  // a stranger's to learn. Mirrors announcements' unit refusal.
  if (!studentId || !(await teachesStudent(req.user.id, studentId))) {
    return res.status(403).json({ error: "You can only log conduct for the students of classes you teach." });
  }

  // The session link is optional CONTEXT, not a gate — but a bogus id must not be
  // stored, so it is resolved and dropped silently if it does not exist. (SetNull on
  // delete means a null here and a deleted-later session read identically, which is
  // the point: the event never depends on the class surviving.)
  let sessionId = typeof req.body?.sessionId === "string" && req.body.sessionId ? req.body.sessionId : null;
  if (sessionId) {
    const s = await prisma.hndSession.findUnique({ where: { id: sessionId }, select: { id: true } });
    if (!s) sessionId = null;
  }

  // key/label/points/tone FROZEN from the entry — the row must still say what was
  // given after the vocabulary is relabelled or the entry deleted.
  const event = await prisma.conductEvent.create({
    data: {
      studentId, staffId: req.user.id, staffName: req.user.name || "",
      key: entry.key, label: entry.label, points: entry.points, tone: entry.tone,
      note, sessionId,
    },
  });

  // Told the student ONLY when the college switched that entry's notifyStudent on.
  // Wording is deliberately flat for both tones — a lock screen is not the place a
  // negative event gets its adjectives.
  if (entry.notifyStudent === true) {
    notifyStudent(studentId, {
      type: entry.tone === "positive" ? "success" : "info",
      message: `${entry.label} (${entry.points > 0 ? "+" : ""}${entry.points}) — recorded by ${req.user.name || "a member of staff"}`,
      link: "inbox",
    });
  }

  res.status(201).json({
    id: event.id, studentId, key: event.key, label: event.label,
    points: event.points, tone: event.tone, note: event.note, createdAt: event.createdAt,
  });
});

// GET /api/conduct/events?studentId= — one student's history, newest first, for the
// register's per-student view. Same identity gate as logging: the students of your
// classes, nobody else's.
router.get("/events", async (req, res) => {
  const studentId = typeof req.query?.studentId === "string" ? req.query.studentId : "";
  if (!studentId || !(await teachesStudent(req.user.id, studentId))) {
    return res.status(403).json({ error: "You can only log conduct for the students of classes you teach." });
  }
  const rows = await prisma.conductEvent.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, key: true, label: true, points: true, tone: true, note: true, staffName: true, createdAt: true },
  });
  res.json({ events: rows });
});

// GET /api/conduct/mine — what I have logged, newest first. Token identity; no id
// parameter exists.
router.get("/mine", async (req, res) => {
  const rows = await prisma.conductEvent.findMany({
    where: { staffId: req.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, studentId: true, label: true, points: true, tone: true, note: true, createdAt: true },
  });
  res.json({ events: rows });
});

module.exports = router;
