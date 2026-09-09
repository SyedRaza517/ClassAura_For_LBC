// The student app's own endpoints. Every route is scoped to the signed-in student
// (req.user.id) — a student can only ever see their own data. requireAuth's student
// branch already blocks student tokens from every other router.
const router = require("express").Router();
const prisma = require("../db");
const { sUnit, sStudent, sStudentQuery, sReferralForStudent, sReferralMessage } = require("../serializers");
const { requireAuth, requireStudent } = require("../auth");
const { summarise } = require("../attendance");
const { localDate, localTime } = require("../clock");
const { notifyAdmins } = require("../notify");
const audit = require("../audit");
const tapConfig = require("../attendanceTapConfig");
const { rosterForSession } = require("../timetabling/registers");
const supportDepartments = require("../supportDepartments");
const predictionRunner = require("../prediction/runner");
const { resolveTapSession, statusFor, withinSessionWindow, termOpenOn, SELF_CHECKIN_STAMP, SELF_CHECKIN_QR_STAMP } = require("../attendanceTap");
const { verifyCode } = require("../attendanceQr");
const { qrSigningKey, SecretsNotConfigured } = require("../secrets");
const { isString, isRealDate } = require("../validate");

router.use(requireAuth, requireStudent);

// 70+ Distinction, 60-69 Merit, 50-59 Pass, below 50 Fail. Must match the same
// boundaries in routes/assessments.js and the client.
const bandOf = (pct) => (pct == null ? null : pct >= 70 ? "Distinction" : pct >= 60 ? "Merit" : pct >= 50 ? "Pass" : "Fail");
// Clamped 0–100, matching the admin gradebook: an historic mark above its
// assessment maximum would otherwise show the student a percentage over 100.
const pctOf = (marks, max) => (max > 0 ? Math.min(100, Math.max(0, Math.round((marks / max) * 1000) / 10)) : null);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/* ============================== NFC tap check-in ============================== */

// WHAT A TAP PROVES, STATED HONESTLY
//
// That somebody was at that sticker once, with this account signed in. NOT that they are
// there now: the code on a sticker is static and any phone with a generic NFC reader app
// can lift it, so a student who notes one down can mark themselves present from home for
// the rest of the year — and the ten-per-minute limiter is no obstacle at one request per
// class. The lecturer's live view and the TagTap log, which carries the IP, are what make
// that visible after the fact. Nothing here prevents it.
//
// This is a real improvement on a button anybody could press, and it is not proof of
// presence. Closing the gap properly means a tag that rotates its code, or a tag bound to
// a room with the session required to match it. Both are recorded in the design note under
// docs/superpowers/specs/. Comments elsewhere in this feature once claimed more than this;
// they have been corrected, because an overclaim in an attendance record is worse than a
// gap somebody knows about.

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
// The device id the app sends, cut to size and reduced to id characters before it is
// stored: it is a header any client can set to anything, and the log is read by
// administrators in a browser. Null when absent — never invented.
function deviceIdFrom(req) {
  const raw = req.get?.("x-device-id");
  if (typeof raw !== "string" || !raw.trim()) return null;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return clean || null;
}

async function logTap(req, fields) {
  try {
    await prisma.tagTap.create({ data: { ip: req.ip ? String(req.ip).slice(0, 60) : null, deviceId: deviceIdFrom(req), ...fields } });
  } catch (e) {
    console.error("[tap] could not log a student tap:", e.message);
  }
}

/** Today's sessions on units this student is enrolled on, shaped for the resolver. */
async function candidateSessions(studentId, date) {
  // A STUDENT REACHES A CLASS BY TWO ROUTES, and this asked about only one of them.
  //
  // It read the student's ENROLMENTS and nothing else, so a class timetabled for their
  // GROUP on a module that records no enrolments — which is every module created by hand
  // rather than synced from Moodle — did not appear on their Check In screen at all.
  // They could not mark themselves present at a class the college had scheduled for them,
  // and the screen said they had nothing on. The fifth handler with this shape; the other
  // four were the register, the live view, the save path and the close-off.
  //
  // `cohortId` is the second route. The candidate set is deliberately WIDE — every
  // session today on a module they are enrolled on, plus every session today belonging to
  // their group — and is then narrowed by the shared rule below, so this function cannot
  // become a sixth opinion about who is on a register.
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { cohortId: true } });
  const enrolments = await prisma.enrolment.findMany({ where: { studentId }, select: { unitId: true } });
  const unitIds = enrolments.map((e) => e.unitId);
  if (!unitIds.length && !student?.cohortId) return [];

  const where = { date, OR: [] };
  if (unitIds.length) where.OR.push({ unitId: { in: unitIds } });
  if (student?.cohortId) where.OR.push({ cohortId: student.cohortId });

  const found = await prisma.hndSession.findMany({
    where,
    include: { unit: { select: { code: true, name: true, term: { select: { name: true, start: true, end: true } } } } },
  });

  // NARROWED BY THE SAME RULE THE REGISTER USES. Being on a module or in a group makes a
  // session a CANDIDATE; whether this student is actually on that register is
  // rosterForSession's question, and asking it here is what stops a student appearing on
  // a class whose group they are not in but whose module they happen to be enrolled on.
  // A day is a handful of classes, so the per-session call is a handful of queries.
  const rosters = await Promise.all(found.map((s) => rosterForSession(s)));
  const sessions = found.filter((_, i) => rosters[i].studentIds.includes(studentId));
  return sessions.map((s) => ({
    id: s.id,
    unitId: s.unitId,
    unitCode: s.unit?.code || "",
    unitName: s.unit?.name || "",
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    // The lecturer's overrides travel with the candidate, or the shared predicate
    // would judge a closed class open and a held-open one shut.
    checkInClosedAt: s.checkInClosedAt ?? null,
    checkInOpenUntil: s.checkInOpenUntil ?? null,
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
  const date = localDate();
  const time = localTime();

  // Today's timetable is built BEFORE the enabled check, and returned either way.
  //
  // "Which lessons do I have today, and when" is a question worth answering whether or
  // not this college taps stickers — and answering it is what turns the Check In screen
  // from a dead end into something useful on day one. A college that never switches tap
  // check-in on still gets a student's day out of this route.
  const candidates = await candidateSessions(req.user.id, date);

  // One query for the whole day rather than one per session. A student with six classes
  // should not cost six round trips to render a list.
  const marks = candidates.length
    ? await prisma.attendanceMark.findMany({
        where: { studentId: req.user.id, sessionId: { in: candidates.map((c) => c.id) } },
        select: { sessionId: true, status: true, checkedInAt: true },
      })
    : [];
  const markBy = new Map(marks.map((m) => [m.sessionId, m]));

  const today = candidates
    .slice()
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime))
    .map((c) => {
      const mark = markBy.get(c.id);
      // A term that has closed cannot be checked into at all, so the screen needs to know
      // rather than offering a class the tap will refuse.
      const termOpen = !c.term || (date >= c.term.start && date <= c.term.end);
      return {
        ...sTapSession(c),
        // Where this class sits relative to the clock. Three states rather than a
        // boolean, because "finished" and "not started" want different words on screen.
        state: time < c.startTime ? "upcoming" : time > c.endTime ? "over" : "now",
        // The mark if one exists. NULL means no mark — which is not the same as absent,
        // and the screen must not render it as such.
        status: mark?.status ?? null,
        checkedInAt: mark?.checkedInAt ?? null,
        termOpen,
      };
    });

  // "There is no check-in here" is a question about BOTH switches.
  //
  // This branch used to fire on the sticker switch alone and return an empty running-now
  // list and no next class. It carried a comment saying a QR-only college must not read
  // as "not switched on" — and it fixed only the FLAG it hands back, while every field
  // the screen actually reasons from stayed empty. The result was a student in a lecture,
  // with the code on the wall behind them, being told "that's you done for today", all
  // day, on the one configuration this feature was built for.
  if (!settings.enabled && !settings.qrEnabled) {
    return res.json({
      enabled: false,
      qrEnabled: false,
      armSeconds: settings.armSeconds,
      date,
      now: [],
      reason: null,
      next: null,
      today,
    });
  }

  // Which class is on, and what a mark for it would be. Deliberately the same decision on
  // both capture methods: what is running is a fact about the timetable and the clock,
  // not about how the student is going to tell us they are there.
  const decision = resolveTapSession(candidates, { date, time }, settings);

  // The classes still to come today, so the screen can say "your next class is at 13:00"
  // rather than only "nothing on now" — which reads as a fault rather than a timetable.
  const later = candidates
    .filter((s) => s.startTime > time)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  res.json({
    // The sticker switch, reported honestly. The client uses it to decide whether the
    // arming walkthrough belongs on screen, so it must stay the sticker's own answer and
    // not become "some kind of check-in is available".
    enabled: settings.enabled === true,
    qrEnabled: settings.qrEnabled,
    armSeconds: settings.armSeconds,
    date,
    now: decision.kind === "one" ? [sTapSession(decision.session)]
       : decision.kind === "ambiguous" ? decision.sessions.map(sTapSession)
       : [],
    reason: decision.kind === "none" ? decision.reason : null,
    next: later.length ? sTapSession(later[0]) : null,
    today,
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
  // Logged with no tag, like the two refusals below it. A college that switched this off
  // while students were still tapping needs to be able to see that happening, and until
  // TagTap.tagId became nullable none of these three could be recorded at all.
  if (!settings.enabled) {
    await logTap(req, { studentId: req.user.id, method: "nfc", outcome: "disabled" });
    return res.status(403).json({ error: "Tap check-in isn't switched on for this college." });
  }

  const code = req.body?.tagCode;
  if (!isString(code) || !code.trim()) return res.status(400).json({ error: "A tag is required" });
  const chosenId = req.body?.sessionId;
  if (chosenId != null && !isString(chosenId)) return res.status(400).json({ error: "sessionId must be text" });

  if (!tapAllowed(req.user.id)) {
    await logTap(req, { studentId: req.user.id, method: "nfc", outcome: "rate_limited" });
    return res.status(429).json({ error: "Too many attempts — wait a moment and try again." });
  }

  // Every tag in this database belongs to this college, because every row does — so a
  // sticker that is not found is one nobody here registered. This used to be scoped by
  // db.js, and the not-found was the isolation working rather than an absence.
  const tag = await prisma.attendanceTag.findFirst({ where: { code: code.trim(), active: true } });
  if (!tag) {
    // The code itself is NOT stored. It is a secret, and a log an administrator can read
    // must not become a list of the codes somebody has been trying. What is worth
    // keeping is that an unrecognised tap happened, when, and from where — which is what
    // makes a run of them visible as a run.
    await logTap(req, { studentId: req.user.id, method: "nfc", outcome: "tag_unknown" });
    return res.status(404).json({ error: "That tag isn't recognised." });
  }

  const date = localDate();
  const time = localTime();
  const candidates = await candidateSessions(req.user.id, date);
  const decision = resolveTapSession(candidates, { date, time }, settings);

  // method sits in base so every outcome below carries it — a refusal is as much an
  // NFC event as a mark, and the QR route logs its own method the same way.
  const base = { tagId: tag.id, studentId: req.user.id, method: "nfc" };

  if (decision.kind === "none") {
    await logTap(req, { ...base, outcome: decision.reason });
    return res.status(409).json({
      error: decision.reason === "term_locked"
        ? "That class is outside term dates, so check-in is closed."
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

  let mark;
  try {
    mark = await prisma.attendanceMark.create({
      data: { sessionId: chosen.id, studentId: req.user.id, status, remark: "", takenBy: SELF_CHECKIN_STAMP, checkedInAt: time },
    });
  } catch (e) {
    // P2002 on @@unique([sessionId, studentId]): two taps raced past the existence check
    // above, or a lecturer saved the register in between. Either way a mark now exists
    // and this request must not have written it — report what stands rather than a 500.
    const standing = await prisma.attendanceMark.findUnique({
      where: { sessionId_studentId: { sessionId: chosen.id, studentId: req.user.id } },
    });
    if (!standing) throw e;
    await logTap(req, { ...base, sessionId: chosen.id, outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: standing.status, checkedInAt: standing.checkedInAt ?? null, session: sTapSession(chosen) });
  }

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

/* ============================== QR check-in ============================== */

// POST /api/student/me/qr-check-in — mark this student present via the rotating code.
//
// The second capture path. The code names its own session (see attendanceQr.js for why
// that is safe), so there is no candidate resolution and no ambiguity branch — but
// naming the session proves only which screen was scanned, nothing about who scanned
// it. Everything the NFC route establishes about the PERSON is re-established here:
// enrolment, the session's own window, the term lock, and the four invariants (never
// overwrite a lecturer's mark, never write an A, checkedInAt written once, nothing on
// a schedule).
//
// One divergence from the NFC route, on purpose: a locked term answers 423 rather than
// 409. The NFC path reports term_locked through resolveTapSession's shared "none"
// branch; this route knows exactly which register was asked for, so it mirrors
// PUT /sessions/:id/register — the route whose lock it is enforcing. Do not "fix"
// either route to match the other.
router.post("/me/qr-check-in", async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.qrEnabled) {
    await logTap(req, { studentId: req.user.id, method: "qr", outcome: "disabled" });
    return res.status(403).json({ error: "Scanning to check in isn't switched on. Your lecturer will mark you in.", reason: "qr_off" });
  }

  const rawSessionId = req.body?.sessionId;
  const rawCode = req.body?.code;
  if (!isString(rawSessionId) || !rawSessionId.trim() || !isString(rawCode) || !rawCode.trim()) {
    return res.status(400).json({ error: "A class code is required", reason: "qr_missing" });
  }
  const sessionId = rawSessionId.trim();

  // The SAME budget as the NFC path, deliberately — one student gets ten check-in
  // attempts a minute across both capture methods, not ten of each.
  if (!tapAllowed(req.user.id)) {
    await logTap(req, { studentId: req.user.id, method: "qr", outcome: "rate_limited" });
    return res.status(429).json({ error: "Too many attempts. Wait a moment and try again.", reason: "too_many" });
  }

  let secret;
  try {
    secret = qrSigningKey();
  } catch (e) {
    // Fail loudly. A missing CREDENTIALS_KEY must not present as "the QR never works",
    // one refused scan at a time — 503 names the configuration problem to fix.
    if (e instanceof SecretsNotConfigured) {
      // The detail goes to the OPERATOR, never down the wire. e.message names the
      // environment variable and carries the shell command that generates it, and the
      // only reader of this response is a student holding a phone in a lecture theatre.
      console.error("[qr] cannot sign or verify codes:", e.message);
      return res.status(e.status).json({ error: "Check-in isn't available right now.", reason: "qr_unavailable" });
    }
    throw e;
  }

  // Cheap crypto before any database read. The claimed sessionId is logged on every
  // refusal below even though it is unproven at that point: a scan names a session
  // even when it is refused, and that is the half of the log worth having — "six
  // refusals against one register inside a minute" is a pattern, "six refusals" is
  // noise. The CODE string is never stored, same as the NFC tag code: it is a bearer
  // credential for a mark, and a log administrators read must not become a list of
  // recently-valid credentials.
  const verdict = verifyCode({
    secret,
    sessionId,
    code: rawCode.trim(),
    nowSeconds: Math.floor(Date.now() / 1000),
    rotateSeconds: settings.qrRotateSeconds,
  });
  if (!verdict.valid) {
    if (verdict.reason === "expired") {
      // "Expired" and "never ours" are different sentences with different next steps.
      await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "qr_expired" });
      return res.status(409).json({ error: "That code has expired. Scan the one on screen again.", reason: "qr_expired" });
    }
    await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "qr_bad_code" });
    return res.status(404).json({ error: "That code isn't recognised.", reason: "qr_bad_code" });
  }

  const session = await prisma.hndSession.findUnique({
    where: { id: sessionId },
    include: { unit: { select: { code: true, name: true, term: { select: { name: true, start: true, end: true } } } } },
  });
  if (!session) {
    // A valid signature for a session that no longer exists: deleted mid-lecture.
    await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "session_unknown" });
    return res.status(404).json({ error: "That class no longer exists.", reason: "no_session" });
  }

  // Enrolment is what makes a student eligible for a register at all — the NFC path
  // gets this from building candidates off Enrolment; here it is the explicit check.
  const enrolled = await prisma.enrolment.findFirst({
    where: { studentId: req.user.id, unitId: session.unitId },
    select: { id: true },
  });
  if (!enrolled) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "not_enrolled" });
    return res.status(403).json({ error: "You're not on the list for that class.", reason: "not_enrolled" });
  }

  const date = localDate();
  const time = localTime();

  // The session's own window, through the SAME predicate the mint route and both
  // dashboards use — this check existed four times with drifting copies, and the drift
  // is precisely how a projector ends up advertising a code every scan is refused.
  // Window before term, mirroring resolveTapSession: a student who scanned at the wrong
  // time of day must not be told their term is closed.
  if (!withinSessionWindow(session, { date, time }, settings)) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "no_session_now" });
    return res.status(409).json({ error: "That class isn't running right now.", reason: "no_session_now" });
  }

  if (!termOpenOn(session.unit?.term, date)) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "term_locked" });
    return res.status(423).json({ error: "That class is outside term dates, so check-in is closed.", reason: "term_locked" });
  }

  const shaped = {
    id: session.id,
    unitCode: session.unit?.code || "",
    unitName: session.unit?.name || "",
    startTime: session.startTime,
    endTime: session.endTime,
  };
  const status = statusFor(session, { date, time }, settings);

  const existing = await prisma.attendanceMark.findUnique({
    where: { sessionId_studentId: { sessionId: session.id, studentId: req.user.id } },
  });
  if (existing) {
    await logTap(req, { studentId: req.user.id, sessionId: session.id, method: "qr", outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: existing.status, checkedInAt: existing.checkedInAt ?? null, session: sTapSession(shaped) });
  }

  let mark;
  try {
    mark = await prisma.attendanceMark.create({
      data: { sessionId: session.id, studentId: req.user.id, status, remark: "", takenBy: SELF_CHECKIN_QR_STAMP, checkedInAt: time },
    });
  } catch (e) {
    // P2002 on @@unique([sessionId, studentId]): two scans raced past the existence
    // check, or a lecturer saved the register in between. A mark now stands and this
    // request must not have written it — report what stands rather than a 500.
    const standing = await prisma.attendanceMark.findUnique({
      where: { sessionId_studentId: { sessionId: session.id, studentId: req.user.id } },
    });
    if (!standing) throw e;
    await logTap(req, { studentId: req.user.id, sessionId: session.id, method: "qr", outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: standing.status, checkedInAt: standing.checkedInAt ?? null, session: sTapSession(shaped) });
  }

  await logTap(req, { studentId: req.user.id, sessionId: session.id, method: "qr", outcome: "marked", status });

  // Flag, never rescore: a check-in must not wait on arithmetic. Never throws into a
  // request that has already written the mark.
  try { await predictionRunner.markStale([req.user.id]); }
  catch (e) { console.error("[prediction] could not flag a score after a QR check-in:", e.message); }

  audit.record(req, {
    action: "attendance.qr.marked",
    entity: "AttendanceMark", entityId: mark.id,
    summary: `Student ${req.user.name || "unknown"} (${req.user.studentRef || "no ref"}) checked themselves in at ${time} on the ${session.date} register for ${shaped.unitCode || "a unit"} — recorded ${status} via the code on screen`,
    before: null,
    after: { sessionId: session.id, status, checkedInAt: time, method: "qr" },
  });

  res.status(201).json({ ok: true, status, checkedInAt: time, session: sTapSession(shaped) });
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
/**
 * THE STUDENT'S ACTUAL CLASSES, FROM THE CALENDAR.
 *
 * `stages` above is the OLD weekly timetable: TimetableSlot rows, a repeating grid of
 * "Monday, 9am, Room 3" with no dates on it. Nothing writes TimetableSlot any more — the
 * screen that did was retired on 8 Sep 2026 — so on this college it is empty and every
 * student's timetable screen said "no timetable yet" while their calendar was full.
 *
 * These are TimetableEvent rows: dated, real, the same records the staff timetable and
 * the registers are built from. Returned ALONGSIDE `stages` rather than instead of it,
 * because a college that still has TimetableSlot data keeps seeing it, and an app build
 * older than this server ignores a key it does not know about.
 *
 * PUBLISHED ONLY. A draft term an administrator is still arranging must never appear in
 * a student's app, where it is indistinguishable from a real one and gets somebody to a
 * room at 9am for a class that was moved before it was announced.
 *
 * TWO ROUTES IN, matching every other roster question on this platform: a class
 * timetabled for a GROUP the student is in, or one on a MODULE they are enrolled on.
 * Reading only enrolments is the bug this codebase has now fixed in five other handlers.
 *
 * sessionId IS THE POINT OF THE JOIN. A mark cannot be written against an event — only
 * against a register — so the app can offer "check in" on exactly the classes that have
 * one, and simply display the rest. A published exam with no module has no register and
 * is not checkable-in, which is correct and is why the field is nullable rather than
 * absent.
 */
async function studentEvents(studentId, cohortId, unitIds, from, to) {
  const or = [];
  if (cohortId) or.push({ groups: { some: { cohortId } } });
  if (unitIds.length) or.push({ unitId: { in: unitIds } });
  if (!or.length) return [];

  const events = await prisma.timetableEvent.findMany({
    where: { published: true, date: { gte: from, lte: to }, OR: or },
    select: {
      id: true, date: true, startTime: true, endTime: true, title: true,
      unit: { select: { id: true, code: true, name: true } },
      // The colour the college chose for this KIND of class — Lecture, Seminar, Lab. It
      // is the same colour the staff timetable paints, so a student and their lecturer
      // are looking at the same coded grid rather than two unrelated palettes.
      category: { select: { name: true, colour: true } },
      // The room, and the campus through it — same precedence as everywhere else: the
      // related Campus wins so a rename propagates, the legacy string is the fallback.
      room: { select: { name: true, floor: true, campus: true, campusRef: { select: { name: true } } } },
      staff: { select: { staff: { select: { name: true } } } },
      groups: { select: { cohortId: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  if (!events.length) return [];

  // The register for each event that THIS student would be marked on: their own group's,
  // or the ungrouped one. One query for the whole window rather than one per class.
  const sessions = await prisma.hndSession.findMany({
    where: {
      timetableEventId: { in: events.map((e) => e.id) },
      OR: [{ cohortId }, { cohortId: null }].filter((c) => c.cohortId !== undefined),
    },
    select: { id: true, timetableEventId: true, cohortId: true },
  });
  // A cohort register wins over the ungrouped one: on a merged class the student belongs
  // to their group's sheet, and falling back to a null-cohort register would put them on
  // a register built for everybody.
  const sessionFor = new Map();
  for (const s of sessions) {
    const cur = sessionFor.get(s.timetableEventId);
    if (!cur || (cur.cohortId === null && s.cohortId === cohortId)) sessionFor.set(s.timetableEventId, s);
  }

  return events.map((e) => ({
    id: e.id,
    date: e.date,
    start: e.startTime,
    end: e.endTime,
    title: e.title || e.unit?.name || "Class",
    unitCode: e.unit?.code || null,
    unitName: e.unit?.name || null,
    category: e.category?.name || null,
    // Null when the college has not categorised this class. The app then derives a
    // stable colour from the module code rather than painting everything one shade —
    // a timetable where every block is identical is a list with extra steps. Derived
    // on the CLIENT because it is presentation, and stored here only when it is a
    // decision the college actually made.
    colour: e.category?.colour || null,
    room: e.room?.name || null,
    floor: e.room?.floor || null,
    campus: e.room ? (e.room.campusRef?.name || e.room.campus || null) : null,
    // Names only. A student's timetable needs to say who is teaching; it does not need a
    // colleague's email address, and sStaff is not used here for exactly that reason.
    staff: (e.staff || []).map((x) => x.staff?.name).filter(Boolean),
    // Null where the class has no register — an exam, a workshop with no module. The app
    // shows the class and offers no check-in, rather than offering one that would 404.
    sessionId: sessionFor.get(e.id)?.id ?? null,
  }));
}

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
  // THE WINDOW: four weeks back, twelve forward. Back, because "was I marked for last
  // Tuesday" is a question a student asks; forward, because a term is what they are
  // planning around. Bounded either way rather than "everything", so a college three
  // years in does not send a student's phone its whole history.
  const ttToday = localDate();
  const shiftDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const ttUnitIds = student.enrolments.map((e) => e.unitId);
  const events = await studentEvents(student.id, student.cohortId ?? null, ttUnitIds, shiftDays(ttToday, -28), shiftDays(ttToday, 84));

  // `stages` may legitimately be empty while `events` is full — that is this college
  // exactly — so an early return on the old shape would hide the new one.
  if (!stageKeys.size) return res.json({ stages: [], events, today: ttToday });

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
  res.json({ stages: [...byStage.values()].sort((a, b) => (a.year - b.year) || (a.termNumber - b.termNumber)), events, today: ttToday });
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

// GET /api/student/me/referrals — the support referrals this student was TOLD about.
//
// THE FILTER IS THE FEATURE, AND WITHOUT IT THIS ENDPOINT IS A SAFEGUARDING INCIDENT.
//
// Referral.studentNotified records whether the referrer ticked "tell the student", and
// it defaults OFF precisely so that a tutor raising a safeguarding concern does not
// have to remember to suppress anything. An endpoint that listed every referral would
// defeat that tickbox completely: the concern raised this afternoon with the box
// unticked would appear in the student's app this evening, which is both the thing the
// default exists to prevent and a great deal worse than the email it prevents.
//
// So the filter is in the WHERE clause, not in the serialiser. sReferralForStudent
// could be trusted to omit a field; only a query can be trusted not to load the row.
//
// What is shown is deliberately thin: which team, when, where it got to. Never the
// reason — that is the tutor's account of the student, written for somebody else, and
// a student reading it is how tutors learn to write nothing useful. Never the case
// notes or the closing detail, which even the referrer cannot read.
router.get("/me/referrals", async (req, res) => {
  const rows = await prisma.referral.findMany({
    where: { studentId: req.user.id, studentNotified: true },
    orderBy: [{ raisedOn: "desc" }, { createdAt: "desc" }],
  });
  // Names, never slugs. byKey resolves retired departments too, so a referral to a desk
  // the college has since closed still renders as "Wellbeing" rather than "wellbeing".
  const all = await supportDepartments.all();
  const nameOf = (k) => all.find((d) => d.key === k)?.name || k;
  res.json(rows.map((r) => sReferralForStudent(r, nameOf(r.department))));
});

/* ===================== asking a support team for help yourself ===================== */

// THE GAP THIS FILLS. Until now the ONLY way into the Wellbeing or ASK queue was a
// member of staff raising a referral. A student who knew they were struggling had no
// route to either team: "Ask the College" goes to the office as a general query, and a
// wellbeing concern sitting in a general query inbox is a wellbeing concern nobody on
// the wellbeing team has seen.
//
// A self-referral lands in the SAME queue a tutor's referral lands in, so it is
// accepted, worked, noted and closed by the same machinery, appears in the same place,
// and is counted the same way. The alternative — a separate inbox for student requests
// — is how a college ends up with two queues and works one of them.

// GET /api/student/me/support-departments — what the form can offer.
//
// ACTIVE ONLY. A retired desk still resolves for READING, so an old referral renders
// under its name, but offering it on a form would be offering a button that the POST
// below refuses. The list is the college's own configuration, so a college that renames
// ASK or adds Careers gets its own words with no code change.
router.get("/me/support-departments", async (req, res) => {
  const active = await supportDepartments.active();
  // key and name only. `active` is implied by being in this list at all, and anything
  // else the config grows later is not the student app's business.
  res.json(active.map((d) => ({ key: d.key, name: d.name })));
});

// POST /api/student/me/referrals — the Wellbeing / ASK form.
router.post("/me/referrals", async (req, res) => {
  const department = str(req.body?.department).toLowerCase();
  const dept = (await supportDepartments.active()).find((d) => d.key === department);
  if (!dept) return res.status(400).json({ error: "Choose a team that is currently taking requests." });

  const reason = str(req.body?.reason).slice(0, 5000);
  if (reason.length < 3) return res.status(400).json({ error: "Tell them a little about what you need." });

  // URGENCY IS THE STUDENT'S OWN ASSESSMENT and is taken at face value. A form that
  // quietly downgrades what somebody said was urgent is worse than no urgency field:
  // it teaches them the app does not listen, and the one time it matters is the time it
  // is wrong. The queue sorts on it; nobody's judgement is overridden by it.
  const urgency = ["routine", "urgent"].includes(str(req.body?.urgency)) ? str(req.body.urgency) : "routine";

  // ONE OPEN REQUEST PER TEAM, and this is a dedupe rather than a rate limit.
  //
  // The failure to prevent is a double-tapped button putting the same student in the
  // wellbeing queue five times, which buries the other people in it. The failure NOT to
  // cause is a student in difficulty being told to go away — so this refuses only while
  // an earlier request to THE SAME team is still open, says so plainly, and returns the
  // id so the app can point them at it and let them add to it instead. A count-per-hour
  // limiter would have silenced somebody with a genuinely new thing to say.
  const open = await prisma.referral.findFirst({
    where: { studentId: req.user.id, department, selfReferred: true, status: { in: ["open", "accepted"] } },
    select: { id: true },
  });
  if (open) {
    return res.status(409).json({
      error: `You already have a request with ${dept.name}. You can add to it rather than sending another.`,
      referralId: open.id,
    });
  }

  const raisedOn = localDate();
  if (!isRealDate(raisedOn)) return res.status(500).json({ error: "Clock misconfigured" });

  const row = await prisma.referral.create({
    data: {
      studentId: req.user.id,
      department,
      reason,
      urgency,
      raisedOn,
      // raisedBy stays NULL. Writing the student's name into a column the staff screens
      // read as "which colleague raised this" is how a self-referral turns up in
      // somebody's Sent-by-me — /referrals/mine matches that column against the signed-in
      // member of staff's name.
      raisedBy: null,
      selfReferred: true,
      // They asked; they plainly know. The tickbox this mirrors exists to decide whether
      // to TELL a student about a referral made without their knowledge, and that
      // question does not arise here.
      studentNotified: true,
    },
  });

  audit.record(req, {
    action: "referral.selfRaised", entity: "Referral", entityId: row.id,
    // WHO and WHERE, never why — the same rule the staff routes follow, and the same
    // reason: the audit log is read on Settings by administrators who were never granted
    // the referrals page.
    summary: `${req.user.name || "A student"} asked ${dept.name} for support`,
    after: { department, urgency, selfReferred: true },
  });

  res.status(201).json(sReferralForStudent(row, dept.name));

  // The team is told in the app, exactly as for a staff referral, and the notification
  // still names no student — the queue says who.
  (async () => {
    const members = await prisma.staff.findMany({ where: { pendingActivation: false } });
    const recipients = members.filter((s) => supportDepartments.canReadDepartment(s, department));
    if (!recipients.length) return;
    await prisma.notification.createMany({
      data: recipients.map((s) => ({
        staffId: s.id,
        type: urgency === "urgent" ? "error" : "info",
        message: (urgency === "urgent" ? "Urgent — " : "") + "A student has asked " + dept.name + " for support",
        link: "referrals-" + department,
      })),
    });
  })().catch(() => {});
});

// GET /api/student/me/referrals/:id/messages — the conversation on their OWN request.
//
// Scoped to a referral this student both owns AND raised. Owning it is not enough: a
// tutor's referral carries a thread between that tutor and the department, written by
// two people who did not know the student would read it.
router.get("/me/referrals/:id/messages", async (req, res) => {
  const row = await prisma.referral.findFirst({
    where: { id: req.params.id, studentId: req.user.id, selfReferred: true },
    select: { id: true, department: true },
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  const rows = await prisma.referralMessage.findMany({
    where: { referralId: row.id, department: row.department },
    orderBy: { createdAt: "asc" },
  });
  res.json(rows.map(sReferralMessage));
});

// POST /api/student/me/referrals/:id/messages — add to it rather than starting another.
//
// This is what makes the one-open-request rule humane rather than a wall: a student who
// remembers something, or whose situation changes, has somewhere to put it that the team
// working the case will actually see.
router.post("/me/referrals/:id/messages", async (req, res) => {
  const row = await prisma.referral.findFirst({
    where: { id: req.params.id, studentId: req.user.id, selfReferred: true },
    select: { id: true, department: true, status: true },
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.status === "closed") {
    // A closed case has an outcome the student has already been shown. Reopening it by
    // the side door would leave the team with work nothing tells them about, so the
    // honest answer is a new request.
    return res.status(409).json({ error: "That request is closed. You can send a new one." });
  }

  const body = str(req.body?.body).slice(0, 5000);
  if (!body) return res.status(400).json({ error: "Write a message." });

  const created = await prisma.referralMessage.create({
    data: {
      referralId: row.id,
      department: row.department,
      // "student", not "referrer": on a self-referral there is no staff referrer, and
      // the screens label the two differently.
      authorRole: "student",
      authorName: req.user.name || null,
      body,
    },
  });

  audit.record(req, {
    action: "referral.messaged", entity: "Referral", entityId: row.id,
    summary: `${req.user.name || "A student"} added to their own support request`,
  });

  res.status(201).json(sReferralMessage(created));
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
