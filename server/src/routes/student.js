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
const attendanceBandConfig = require("../attendanceBandConfig");
const { computeStreaks, attendedForDay } = require("../studentStreaks");
const { weightedAveragePct } = require("../studentAssessmentAverage");
const { rosterForSession, unitIdsForStudent } = require("../timetabling/registers");
const supportDepartments = require("../supportDepartments");
const predictionRunner = require("../prediction/runner");
const { resolveTapSession, statusFor, withinSessionWindow, termOpenOn, SELF_CHECKIN_STAMP, SELF_CHECKIN_QR_STAMP, SELF_CHECKIN_DECLARED_STAMP } = require("../attendanceTap");
const { checkPresence } = require("../presence");
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

/**
 * Refuse a check-in from a device that is not where it says it is — or let it through.
 *
 * Returns true when it has ALREADY answered the request, so every caller is one line:
 *   if (await refusedForPlace(req, res, settings, "nfc", session.id)) return;
 *
 * ONE FUNCTION FOR ALL THREE CAPTURE METHODS, which is the whole point of the phase that
 * built presence.js. A network rule written separately in the tap route, the scan route
 * and the declare route would drift, and the drift would be silent: each route would still
 * refuse somebody, just not the same somebody. That is not a hypothetical failure in this
 * codebase — six handlers each grew their own answer to "who is on this register", and it
 * was fixed six separate times.
 *
 * NOT APPLIED TO A MARK A MEMBER OF STAFF SETS. A lecturer correcting a register from home
 * in the evening is doing their job. These checks exist for the three methods where the
 * person making the mark is the person the mark is about.
 *
 * WHERE THE ADDRESS COMES FROM, because getting this wrong makes the whole check theatre.
 * `req.ip` is resolved by Express under `trust proxy: 1` (set in index.js), which trusts
 * exactly ONE hop — Render's. A phone can put anything it likes in X-Forwarded-For, and
 * with one real proxy in front, its header is pushed to the left and the address Render
 * observed is the one used. Setting `trust proxy: true` instead would take the leftmost
 * entry, which IS the phone's own claim, and this entire check would be a value the
 * student chooses. If another proxy is ever put in front of Render, that number must go up
 * with it, or req.ip becomes the new proxy's address and the whole college shares one.
 */
async function refusedForPlace(req, res, settings, method, sessionId = null) {
  const verdict = checkPresence({
    ip: req.ip,
    // The phone's own reading, and NOT its opinion of whether that is close enough. The
    // distance is computed on the server against coordinates the college recorded; a
    // client that reported "I am in range" would be reporting a value anybody can send.
    position: req.body?.position,
    campuses: settings.geofenceCheck === true ? await campusesFor(sessionId) : [],
    settings,
  });
  if (verdict.ok) return false;

  const first = verdict.failures[0];

  // EVERY failure is logged, not only the one reported. A college switching this on for
  // the first time wants to see that its IP list is wrong AND its coordinates are, rather
  // than discovering the second a week after fixing the first.
  for (const f of verdict.failures) {
    await logTap(req, { studentId: req.user.id, sessionId, method, outcome: f.reason });
  }

  // A misconfiguration is the operator's problem, not the student's, and it is invisible
  // from the outside: every student is refused and the settings screen says the network is
  // enforced. So it is said out loud in the log where somebody reading the service's
  // output will meet it.
  if (first.reason === "network_not_configured") {
    console.error("[presence] the college network check is ON but no usable IP range is saved — every check-in is being refused");
  }
  // THE SAME ALARM FOR THE GEOFENCE, which had none. The comment above states the
  // principle — a misconfiguration is invisible from the outside, so it is said out loud
  // where an operator will meet it — and then applied it to one of the two checks. The
  // geofence reaches the identical state by switching on with no campus pinned, or by
  // somebody clearing the coordinates of the only one that was.
  if (first.reason === "campus_not_located") {
    console.error("[presence] the campus geofence is ON but no active campus has coordinates — every check-in is being refused");
  }

  // 403, not 409. The class may well be running and the student may well be on the
  // register; what is wrong is WHERE they are, and that distinction matters to the app,
  // which shows a different thing for "not now" than for "not here".
  res.status(403).json({
    error: PLACE_REFUSALS[first.reason] || PLACE_REFUSALS.default,
    reason: first.reason,
  });
  return true;
}

/**
 * The campuses a check-in for this class could legitimately be at.
 *
 * A class held in a room is at that room's campus, and that is the tightest answer
 * available. When there is no room, or the room predates campuses, EVERY located campus is
 * returned instead — because "which campus" is frequently unknowable and refusing all of
 * those would make the geofence unusable at exactly the colleges that want it. What it
 * still refuses is a phone at none of them, which is what the college asked for.
 *
 * Only called when the geofence is switched on: this is two queries on the check-in path,
 * and a college that has not opted in should not pay for them.
 */
async function campusesFor(sessionId) {
  if (sessionId) {
    // Reached from the id rather than a loaded row, because the check runs BEFORE each
    // route resolves its session — and it has to. A student off the college network must
    // be told that, not handed "tag not recognised" or "wrong code" from a check they were
    // never going to get past. One query, and only when the geofence is switched on.
    const room = await prisma.hndSession.findUnique({
      where: { id: sessionId },
      select: { room: { select: { campusRef: { select: { latitude: true, longitude: true } } } } },
    }).then((s) => s?.room).catch(() => null);
    // Only when it actually has coordinates. A room on an unlocated campus falls through
    // to the college-wide list rather than refusing — the class is somewhere, and the
    // college's other campuses are a better guess than none. If NOTHING is located, the
    // list comes back empty and presence.js refuses under `campus_not_located`, which is
    // the loud failure a misconfiguration deserves.
    if (room?.campusRef?.latitude != null && room?.campusRef?.longitude != null) return [room.campusRef];
  }
  return prisma.campus.findMany({
    where: { active: true, latitude: { not: null }, longitude: { not: null } },
    select: { latitude: true, longitude: true },
  });
}

// The student's half of a refusal, in words they can act on.
//
// "Check-in didn't work" sends somebody to a lecturer who cannot help them. "You need to
// be on the college WiFi" is a thing they can fix while standing there. The two
// configuration failures deliberately read the same to a student as the ordinary one —
// they cannot tell the difference and there is nothing for them to do about it — while
// the `reason` code beside it stays distinct for the log and the dashboard.
const PLACE_REFUSALS = {
  off_network: "You need to be on the college WiFi to check in.",
  network_not_configured: "You need to be on the college WiFi to check in.",
  off_campus: "You're too far from the college to check in.",
  campus_not_located: "You're too far from the college to check in.",
  position_missing: "Turn on location so we can check you're at the college, then try again.",
  accuracy_unknown: "We couldn't tell where you are accurately enough. Try again near a window.",
  accuracy_too_poor: "We couldn't tell where you are accurately enough. Try again near a window.",
  default: "You can't check in from here.",
};

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
    include: {
      // moodleSectionId/moodleCourseId are selected for rosterForSession, which needs to
      // know whether this module's enrolment list was enumerated. Selected HERE rather
      // than left to rosterForSession's own lookup because this is the one caller that
      // asks per session across a whole day, and that would be a query per class.
      unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, tutorStaff: { select: { name: true } }, tutor: true, term: { select: { name: true, start: true, end: true } }, course: { select: { name: true, academicDepartment: { select: { name: true } } } } } },
      // WHERE and WHO, which the check-in card has to show. A student deciding whether
      // this is the class in front of them needs the room; a student with two classes at
      // once needs the lecturer to tell them apart. Both come from the TIMETABLE event
      // where there is one, because that is the per-class truth -- the unit's tutor is
      // the term-long role and is only the fallback for a register the generator made.
      room: { select: { name: true, floor: true, campus: true, campusRef: { select: { name: true } } } },
      timetableEvent: { select: { staff: { select: { staff: { select: { name: true } } } } } },
    },
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
    // THE SAME FACTS THE TIMETABLE CARD PRINTS, from the same place. The two screens
    // describe one class, and a student who taps a row on their timetable lands here — so
    // a card that dropped half of what they were just looking at reads as a different
    // class. Reached through the UNIT rather than the session's own course, exactly as
    // the timetable does, or the two could disagree about which course a module is on.
    course: s.unit?.course?.name || null,
    school: s.unit?.course?.academicDepartment?.name || null,
    date: s.date,
    startTime: s.startTime,
    endTime: s.endTime,
    room: s.room?.name || null,
    floor: s.room?.floor || null,
    campus: s.room ? (s.room.campusRef?.name || s.room.campus || null) : null,
    // Names only, and the event's staff win over the unit's tutor: the timetable says who
    // is in THAT room on THAT day, which is the more specific claim. Free text `tutor` is
    // the last fallback for a visiting lecturer with no account.
    staff: (s.timetableEvent?.staff || []).map((x) => x.staff?.name).filter(Boolean).length
      ? (s.timetableEvent?.staff || []).map((x) => x.staff?.name).filter(Boolean)
      : [s.unit?.tutorStaff?.name || s.unit?.tutor].filter(Boolean),
    // The lecturer's overrides travel with the candidate, or the shared predicate
    // would judge a closed class open and a held-open one shut.
    checkInClosedAt: s.checkInClosedAt ?? null,
    checkInOpenUntil: s.checkInOpenUntil ?? null,
    term: s.unit?.term ? { name: s.unit.term.name, start: s.unit.term.start, end: s.unit.term.end } : null,
  }));
}

/** What a session looks like on the check-in screen. No other student's data, ever. */
const sTapSession = (s) => ({
  id: s.id, unitCode: s.unitCode, unitName: s.unitName, startTime: s.startTime, endTime: s.endTime,
  // Room, campus and lecturer travel with every check-in card. Null where the college has
  // not recorded one -- an online class has no room, and "not recorded" is not "unknown
  // room", so the card omits the line rather than printing a dash.
  room: s.room ?? null, floor: s.floor ?? null, campus: s.campus ?? null, staff: s.staff ?? [],
  // And what the hour is FOR. Same pair the timetable carries, for the same reason: this
  // is the one screen a student opens while standing outside a door, and "which course is
  // this" is a real question when two modules share a room and a time.
  course: s.course ?? null, school: s.school ?? null,
});

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
      needsLocation: settings.geofenceCheck === true,
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
    // Whether to OFFER the "I'm here" action at all. The app cannot work this out for
    // itself, and a button that always answers 403 is worse than no button.
    declareEnabled: settings.declareEnabled === true,
    // Whether the app should ask the phone where it is before checking in.
    //
    // TOLD, NOT GUESSED, and only when the college has switched the geofence on. Asking
    // every student for their location whether or not it is used would be a permission
    // prompt with no honest answer to "why does this app want that", on the screen where
    // trust matters most — and both app stores ask precisely that question at review.
    //
    // It does NOT say the check will pass. The distance is computed on the server against
    // coordinates the college recorded; the phone reports a reading, never a verdict.
    needsLocation: settings.geofenceCheck === true,
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

  // THE SESSION ID, WHEN THE STUDENT HAS NAMED ONE. This passed nothing, so the geofence
  // fell back to "near any of the college's campuses" and every NFC place-refusal was
  // logged against no register at all — the one capture method whose refusals could not be
  // attributed to a class. It was already validated three lines above.
  //
  // Still null on the first tap of an ambiguous pair, which is correct rather than a gap:
  // at that moment nobody knows which of two overlapping classes the student means, and
  // the college-wide campus list is the honest answer to "is this phone at the college".
  if (await refusedForPlace(req, res, settings, "nfc", isString(chosenId) ? chosenId.trim() || null : null)) return;

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
      data: { sessionId: chosen.id, studentId: req.user.id, status, remark: "", takenBy: SELF_CHECKIN_STAMP, checkedInAt: time, deviceId: deviceIdFrom(req) },
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

  if (await refusedForPlace(req, res, settings, "qr", sessionId)) return;

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
    // moodleSectionId/moodleCourseId for rosterForSession below — see roster.js.
    include: { unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, term: { select: { name: true, start: true, end: true } } } } },
  });
  if (!session) {
    // A valid signature for a session that no longer exists: deleted mid-lecture.
    await logTap(req, { studentId: req.user.id, sessionId, method: "qr", outcome: "session_unknown" });
    return res.status(404).json({ error: "That class no longer exists.", reason: "no_session" });
  }

  // THE ROSTER, NOT THE ENROLMENT LIST — the sixth handler with this defect, and the
  // last one that could still refuse a student standing in the room.
  //
  // The comment this replaces said "the NFC path gets this from building candidates off
  // Enrolment", and that was true until candidateSessions was fixed: a student reaches a
  // register EITHER by an enrolment on the module OR by membership of a group the class
  // was timetabled for. On every module created by hand rather than synced from Moodle
  // there are no enrolments at all, so this check refused every student of every such
  // class — scanning the code their lecturer had just put on the screen.
  const roster = await rosterForSession(session);
  if (!roster.studentIds.includes(req.user.id)) {
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
      data: { sessionId: session.id, studentId: req.user.id, status, remark: "", takenBy: SELF_CHECKIN_QR_STAMP, checkedInAt: time, deviceId: deviceIdFrom(req) },
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

// POST /api/student/me/declare-check-in  { sessionId }
//
// "I'm here." The student opens Check In, sees the classes the timetable says are running
// for them, taps one, and is marked present. No sticker, no code on a screen.
//
// EVERY OTHER MARK IN THIS DATABASE IS AN OBSERVATION; THIS ONE IS A CLAIM. A sticker
// needs a phone within a few centimetres of a tag that is physically in the room. A code
// on a projector needs a camera pointed at that screen while the code is still current.
// This needs neither, and can be done from a bus. Three things follow, and none of them
// is optional:
//
//   IT SHIPS OFF. `declareEnabled` defaults false and a college turns it on deliberately,
//   with the trade-off in front of them, because it changes what their attendance data
//   MEANS at a funding audit or a student's appeal.
//
//   IT IS DISTINGUISHABLE FOREVER. SELF_CHECKIN_DECLARED_STAMP is its own stamp with its
//   own token, so the live view, the register, a student's history and the CSV an
//   administrator attaches to an email all report how this mark was made. Recording a
//   declaration as a tap would answer "what evidence stands behind this" wrongly, on rows
//   nobody can go back and re-evidence.
//
//   EVERY OTHER GUARD STILL APPLIES. Same rate budget, same session window, same term
//   lock, same "a mark that already stands wins" rule as the two capture methods beside
//   it. What is removed is the proof of presence, and nothing else.
router.post("/me/declare-check-in", async (req, res) => {
  const settings = await tapConfig.get();
  if (!settings.declareEnabled) {
    await logTap(req, { studentId: req.user.id, method: "declared", outcome: "disabled" });
    return res.status(403).json({ error: "Marking yourself in isn't switched on. Your lecturer will mark you in.", reason: "declare_off" });
  }

  const rawSessionId = req.body?.sessionId;
  if (!isString(rawSessionId) || !rawSessionId.trim()) {
    return res.status(400).json({ error: "A class is required", reason: "declare_missing" });
  }
  const sessionId = rawSessionId.trim();

  // The SAME budget as the other two, deliberately: one student gets ten check-in
  // attempts a minute ACROSS every capture method, not ten of each.
  if (!tapAllowed(req.user.id)) {
    await logTap(req, { studentId: req.user.id, method: "declared", outcome: "rate_limited" });
    return res.status(429).json({ error: "Too many attempts. Wait a moment and try again.", reason: "too_many" });
  }

  if (await refusedForPlace(req, res, settings, "declared", sessionId)) return;

  const session = await prisma.hndSession.findUnique({
    where: { id: sessionId },
    // moodleSectionId/moodleCourseId for rosterForSession below — see roster.js.
    include: { unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, term: { select: { name: true, start: true, end: true } } } } },
  });
  if (!session) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "declared", outcome: "session_unknown" });
    return res.status(404).json({ error: "That class no longer exists.", reason: "no_session" });
  }

  // THE ROSTER, NOT THE ENROLMENT LIST. A student reaches a register by two routes — an
  // enrolment on the module, or membership of a group the class was timetabled for — and
  // rosterForSession is the one place that decides between them. An enrolment-only check
  // here would refuse every student of every hand-made module, which is the defect this
  // codebase has now closed in six other handlers.
  const roster = await rosterForSession(session);
  if (!roster.studentIds.includes(req.user.id)) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "declared", outcome: "not_enrolled" });
    return res.status(403).json({ error: "You're not on the list for that class.", reason: "not_enrolled" });
  }

  const date = localDate();
  const time = localTime();

  // Window before term, mirroring the other two routes: a student who tapped at the wrong
  // time of day must not be told their term is closed.
  if (!withinSessionWindow(session, { date, time }, settings)) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "declared", outcome: "no_session_now" });
    return res.status(409).json({ error: "That class isn't running right now.", reason: "no_session_now" });
  }
  if (!termOpenOn(session.unit?.term, date)) {
    await logTap(req, { studentId: req.user.id, sessionId, method: "declared", outcome: "term_locked" });
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
    await logTap(req, { studentId: req.user.id, sessionId: session.id, method: "declared", outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: existing.status, checkedInAt: existing.checkedInAt ?? null, session: sTapSession(shaped) });
  }

  let mark;
  try {
    mark = await prisma.attendanceMark.create({
      data: { sessionId: session.id, studentId: req.user.id, status, remark: "", takenBy: SELF_CHECKIN_DECLARED_STAMP, checkedInAt: time, deviceId: deviceIdFrom(req) },
    });
  } catch (e) {
    // P2002 on @@unique([sessionId, studentId]): two presses raced past the check above,
    // or a lecturer saved the register in between. A mark now stands and this request
    // must not have written it — report what stands rather than a 500.
    const standing = await prisma.attendanceMark.findUnique({
      where: { sessionId_studentId: { sessionId: session.id, studentId: req.user.id } },
    });
    if (!standing) throw e;
    await logTap(req, { studentId: req.user.id, sessionId: session.id, method: "declared", outcome: "already_marked" });
    return res.json({ ok: true, alreadyMarked: true, status: standing.status, checkedInAt: standing.checkedInAt ?? null, session: sTapSession(shaped) });
  }

  await logTap(req, { studentId: req.user.id, sessionId: session.id, method: "declared", outcome: "marked", status });

  // Flag, never rescore: a check-in must not wait on arithmetic.
  try { await predictionRunner.markStale([req.user.id]); }
  catch (e) { console.error("[prediction] could not flag a score after a declared check-in:", e.message); }

  // The audit line says HOW, in words, because this is the mark somebody will question.
  audit.record(req, {
    action: "attendance.declared.marked",
    entity: "AttendanceMark", entityId: mark.id,
    summary: `Student ${req.user.name || "unknown"} (${req.user.studentRef || "no ref"}) declared themselves present at ${time} on the ${session.date} register for ${shaped.unitCode || "a unit"} — recorded ${status}, with no sticker or code`,
    before: null,
    after: { status, checkedInAt: time },
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
  const student = await prisma.student.findUnique({ where: { id: sid }, select: { id: true } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  // THE STUDENT'S MODULES, NOT THEIR ENROLMENTS. This read `Enrolment` alone, so a student
  // taught on hand-created modules — every module a college builds itself rather than
  // syncing from Moodle — opened this screen and saw nothing at all. Their marks existed,
  // their lecturer's register showed them correctly, and their own attendance record was
  // invisible to them. unitIdsForStudent is the inverse of the roster rule, and the one
  // place that question gets answered.
  const enrolledIds = await unitIdsForStudent(sid);
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

// GET /api/student/me/attendance-bands — this college's OWN attendance ladder, so the
// app can colour a percentage the same way the admin table does instead of carrying a
// second, hardcoded copy of the six platform defaults (client survey, 12 Sep: the app
// had its own inline 85/70 scale, independent of whatever the college had configured).
//
// Served from attendanceBandConfig.get(), which already resolves this college's saved
// bands over the platform defaults — the SAME resolution the admin screen and the
// month-end email send use, so a threshold an administrator just moved is reflected
// here on the same TTL rather than needing its own cache.
//
// ALLOWLISTED DOWN TO {key,label,min,colour} — narrower than attendanceBandConfig's
// own BAND_FIELDS, which also carries `max` and `emailTrigger`. `max` is redundant on
// the wire (bandForPct's own comment: the boundary that actually decides is the NEXT
// band's `min`, and normaliseBands guarantees the ladder is gap-free, so a client only
// ever needs "where does this band start"). `emailTrigger` is a STAFF fact — whether
// landing in a band fires the automated warning letter — and has no business reaching
// the person the letter would be sent to.
router.get("/me/attendance-bands", async (req, res) => {
  const bands = await attendanceBandConfig.get();
  res.json({ bands: bands.map((b) => ({ key: b.key, label: b.label, min: b.min, colour: b.colour })) });
});

// GET /api/student/me/streaks — private, per-student attendance streaks and badges.
//
// NEVER A LEADERBOARD, NEVER A COMPARISON. Computed fresh on every read from this
// student's own marks; nothing is stored, so there is no cross-student table a wider
// query could ever read from by mistake (constraints.md: streaks/badges are per-
// student only). And NEVER prediction data: this reads AttendanceMark and HndSession
// directly, the same two tables /me/attendance already reads for this student, not
// anything the prediction feature computes.
//
// `days` IS BUILT HERE, PURELY FROM WHAT THIS STUDENT WAS ACTUALLY MARKED. Sessions
// are looked up by the ids the marks themselves reference, rather than re-deriving the
// student's unit list first — unitIdsForStudent already folds in every unit a mark
// exists for, current enrolment or not (timetabling/registers.js), so this is not a
// wider scope than /me/attendance's, just a more direct route to the same rows: a
// streak is a record of what already happened, and going by the marks themselves
// means it is built without needing to ask "which units" at all.
router.get("/me/streaks", async (req, res) => {
  const sid = req.user.id;
  const student = await prisma.student.findUnique({ where: { id: sid }, select: { id: true } });
  if (!student) return res.status(404).json({ error: "Student not found" });

  const marks = await prisma.attendanceMark.findMany({ where: { studentId: sid }, select: { status: true, sessionId: true } });
  const sessionIds = [...new Set(marks.map((m) => m.sessionId))];
  const sessions = sessionIds.length
    ? await prisma.hndSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true, unitId: true, date: true } })
    : [];
  const sessById = new Map(sessions.map((s) => [s.id, s]));

  // Group THIS STUDENT'S OWN marks by calendar date. A date with no mark for it never
  // appears at all — "no sessions" per the brief — which is the same "not measurable,
  // not zero" rule attendance.js applies elsewhere: a day nobody took a register for
  // is not a day the student failed to attend.
  const byDate = new Map(); // date -> status[]
  for (const m of marks) {
    const sess = sessById.get(m.sessionId);
    if (!sess) continue; // a mark whose session was since deleted — nothing to date it by
    if (!byDate.has(sess.date)) byDate.set(sess.date, []);
    byDate.get(sess.date).push(m.status);
  }

  const days = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0])) // dates are strings, compared as strings
    .map(([date, statuses]) => ({
      date,
      // See studentStreaks.js's attendedForDay() for the rule and why a mixed
      // P/L + E day counts in full rather than being discounted a second time.
      attended: attendedForDay(statuses),
    }));

  const { current, best, badges } = computeStreaks({ days });

  // perfectUnit: THE SAME summarise() /me/attendance calls, on the SAME per-unit
  // grouping (marks bucketed by the unit their session belongs to) — never a second
  // attendance formula living in this route, which is exactly the kind of drift a
  // null-vs-zero bug hides behind. A unit is "perfect" when summarise() returns
  // pct === 100, which can only happen once at least one session on it was marked
  // (pct is null, not 100, when nothing was ever marked).
  //
  // ONE badge, not one per unit — badges are a flat achievement list, and a student
  // is shown "a fully-attended unit exists", not an inventory of which ones. Dated
  // the LATEST marked session across every perfect unit: the most recent day the
  // record was reconfirmed still perfect, never an invented "today".
  const marksByUnit = new Map();
  for (const m of marks) {
    const sess = sessById.get(m.sessionId);
    if (!sess) continue;
    if (!marksByUnit.has(sess.unitId)) marksByUnit.set(sess.unitId, []);
    marksByUnit.get(sess.unitId).push(m);
  }
  let perfectUnitEarnedOn = null;
  for (const unitMarks of marksByUnit.values()) {
    if (summarise(unitMarks).pct !== 100) continue;
    for (const m of unitMarks) {
      const d = sessById.get(m.sessionId)?.date;
      if (d && (!perfectUnitEarnedOn || d > perfectUnitEarnedOn)) perfectUnitEarnedOn = d;
    }
  }

  res.json({
    current, best,
    badges: perfectUnitEarnedOn ? [...badges, { key: "perfectUnit", earnedOn: perfectUnitEarnedOn }] : badges,
  });
});

// GET /api/student/me/assessments — this student's assessments, marks, grades, average.
router.get("/me/assessments", async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.user.id }, select: { id: true } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  // Same correction as /me/attendance, and the same consequence without it: a student with
  // graded work on a hand-created module saw an empty Results screen.
  const unitIds = await unitIdsForStudent(req.user.id);
  const assessments = await prisma.assessment.findMany({
    where: { unitId: { in: unitIds.length ? unitIds : ["__none__"] } },
    include: { unit: { select: { code: true, name: true } } },
    orderBy: [{ unitId: "asc" }, { createdAt: "asc" }],
  });
  const grades = await prisma.assessmentGrade.findMany({ where: { studentId: student.id } });
  const gMap = new Map(grades.map((g) => [g.assessmentId, g]));
  let n = 0;
  const items = assessments.map((a) => {
    const g = gMap.get(a.id);
    const pct = g ? pctOf(g.marks, a.maxMarks) : null;
    if (pct != null) n++;
    return { id: a.id, title: a.title, type: a.type, maxMarks: a.maxMarks, weight: a.weight, dueDate: a.dueDate, unitCode: a.unit.code, unitName: a.unit.name, unitId: a.unitId, moduleCode: a.unit.code, moduleName: a.unit.name, moduleId: a.unitId, marks: g ? g.marks : null, feedback: g ? g.feedback : "", pct, grade: bandOf(pct) };
  });
  // studentAssessmentAverage.js's own file header explains why 0/missing weight is
  // NOT a real weight of zero, and asserts in its own unit test that a college with
  // no weights set gets back exactly the plain mean this route used to compute here.
  const averagePct = weightedAveragePct(items.map((it) => ({ pct: it.pct, weight: it.weight })));
  res.json({
    assessments: items, count: items.length, graded: n,
    averagePct,
    averageGrade: averagePct != null ? bandOf(averagePct) : null,
    // Whether the figure above actually reflects a college-set weight, or is the
    // equal-weighting fallback wearing the same field name. `weight` already
    // serialises per assessment above; a student comparing the two should not have
    // to reconstruct this by eye. Restricted to GRADED items — an ungraded
    // assessment's weight never entered the sum, so it cannot be why this is (or
    // isn't) weighted.
    averageIsWeighted: items.some((it) => it.pct != null && Number(it.weight) > 0),
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
      // The module, AND the course and school it sits in.
      //
      // Course and school come through the UNIT rather than the event's own courseId,
      // because the unit is what the class actually teaches: an event can be created
      // against a course for scheduling reasons while its module belongs elsewhere, and
      // the student is being told which qualification this hour counts towards. Null all
      // the way down is a real state — a module with no course, a course with no school —
      // and each renders as absent rather than as a guess.
      unit: {
        select: {
          id: true, code: true, name: true,
          course: { select: { name: true, academicDepartment: { select: { name: true } } } },
        },
      },
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
    // teamsJoinUrl comes from the SESSION, not the event. TimetableEvent.teamsJoinUrl
    // is the admin's rescue-hatch paste, "carried down to this event's registers on
    // publish" (schema.prisma) — so by the time a class has a register at all, the
    // register's OWN copy on HndSession is the per-class truth, and reading the
    // event's copy here would show a link that publish already superseded on a
    // reschedule. STATUS.md's own words for the feature this was meant to guarantee:
    // "the guaranteed route for a student to find their class link is the student
    // app reading the session's own teamsJoinUrl" — a promise this app was not
    // keeping until now (closes the gap the 12 Sep claim-vs-code survey found).
    select: { id: true, timetableEventId: true, cohortId: true, teamsJoinUrl: true },
  });
  // A cohort register wins over the ungrouped one: on a merged class the student belongs
  // to their group's sheet, and falling back to a null-cohort register would put them on
  // a register built for everybody.
  const sessionFor = new Map();
  for (const s of sessions) {
    const cur = sessionFor.get(s.timetableEventId);
    if (!cur || (cur.cohortId === null && s.cohortId === cohortId)) sessionFor.set(s.timetableEventId, s);
  }

  // WHAT THIS STUDENT WAS MARKED, per class. One query for the window, not one per row.
  //
  // It is the detail that turns a timetable into something worth opening twice: a term of
  // dates says when to turn up, and the same term with marks on it answers "am I actually
  // attending", which is the question behind the emails the college sends them.
  //
  // NULL IS NOT ABSENT. A class nobody has taken a register for comes back with no
  // status, and the app renders that as "not marked" in grey — never as an absence. A
  // student looking at a red mark for a lecture the lecturer simply never registered is
  // how a support conversation starts from a false premise.
  const myMarks = sessions.length
    ? await prisma.attendanceMark.findMany({
        where: { studentId, sessionId: { in: [...sessionFor.values()].map((x) => x.id) } },
        select: { sessionId: true, status: true },
      })
    : [];
  const markFor = new Map(myMarks.map((m) => [m.sessionId, m.status]));

  return events.map((e) => ({
    id: e.id,
    date: e.date,
    course: e.unit?.course?.name || null,
    school: e.unit?.course?.academicDepartment?.name || null,
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
    // "P" | "L" | "E" | "A", or null for "nobody has marked this" — which is a different
    // fact from being absent and must never be drawn as one.
    status: markFor.get(sessionFor.get(e.id)?.id) ?? null,
    // Nullable passthrough of the register's own join link — a class with no meeting
    // (in person, or never synced) serialises null and the app shows no Join button,
    // rather than a dash or an empty string standing in for "there is nothing here".
    teamsJoinUrl: sessionFor.get(e.id)?.teamsJoinUrl || null,
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

/* ============================== Notifications ============================== */

// What a student may see of their own Notification row. An allowlist, like every
// other shape in this file (sTapSession above is the same idea) — Notification now
// carries BOTH staffId and studentId (Task 1's exactly-one-owner column pair), and
// nothing about ownership, or any column added to this table later for staff's
// sake, should reach a student's screen just because it happened to sit on the row.
// Defined here rather than in serializers.js: this task's file list is
// server/src/{notify,auth,routes/devices,routes/student}.js only, and student.js
// already keeps its own local serialisers for shapes specific to this router.
const sStudentNotification = (n) => ({
  id: n.id, type: n.type, message: n.message, link: n.link, read: n.read, createdAt: n.createdAt,
});

// GET /api/student/me/notifications — this student's own notifications, latest 50,
// newest first, plus how many are unread.
//
// `unread` counts EVERY unread row, not just the 50 returned — a badge that stopped
// counting once the list scrolled off-screen would undercount a student who ignored
// their notifications for a while, which is exactly the student a badge exists for.
// Scoped to req.user.id like every route in this file; there is no id parameter to
// tamper with.
router.get("/me/notifications", async (req, res) => {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { studentId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.notification.count({ where: { studentId: req.user.id, read: false } }),
  ]);
  res.json({ notifications: rows.map(sStudentNotification), unread });
});

// PUT /api/student/me/notifications/read — mark notifications read. Body { ids? }:
// given, mark just those; omitted, mark every one of this student's unread
// notifications.
//
// NEVER AN ID PARAMETER THAT COULD REACH ANOTHER STUDENT'S ROWS. `ids` narrows the
// WHERE clause, it does not replace it — `studentId: req.user.id` is always ANDed
// in, so an id copied from another student's notification (guessed, or seen over
// their shoulder) simply matches zero rows here rather than marking someone else's
// notification read. That is why this reads `ids` from the body and updates by a
// WHERE filter rather than looping `findUnique`+`update` by id: a per-id ownership
// check that is ever skipped is a leak, and an unconditional filter cannot be
// skipped.
router.put("/me/notifications/read", async (req, res) => {
  const { ids } = req.body || {};
  const where = { studentId: req.user.id, read: false };
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.every(isString)) {
      return res.status(400).json({ error: "ids must be an array of notification ids" });
    }
    if (!ids.length) return res.json({ ok: true, updated: 0 });
    where.id = { in: ids };
  }
  const r = await prisma.notification.updateMany({ where, data: { read: true } });
  res.json({ ok: true, updated: r.count });
});

module.exports = router;
