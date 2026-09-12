// The Teams attendance sync: discover meetings on the organizer accounts' calendars,
// match them to registers, and after each class ends write the marks its attendance
// report supports. Decisions live in teamsAttendance.js (pure, tested); Graph access
// in teamsGraph.js; this file only APPLIES them — the same split as
// timetabling/registers.js, for the same reason: a decision that can be reasoned about
// without a database or a Microsoft tenant belongs in a module that has neither, and
// what is left here is wiring — reading the right rows, calling the right function,
// writing the result — which is exactly what an integration test (or the smoke suite)
// is for, rather than a unit test asserting the wiring is wired.
const prisma = require("./db");
const graph = require("./teamsGraph");
const { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus } = require("./teamsAttendance");
const { TEAMS_AUTO_STAMP, termOpenOn } = require("./attendanceTap");
const { rosterForSession } = require("./timetabling/registers");
const teamsConfig = require("./teamsAttendanceConfig");
const tapConfig = require("./attendanceTapConfig");
const { localDate, localTime } = require("./clock");

// In-process, like every lock in this codebase (see conventions.md): correct for one
// Node process, and one process is what a deployment is. A clustered deployment would
// need this to be a database-backed lock (e.g. the "running" TeamsSync row itself, read
// with SELECT ... FOR UPDATE) rather than a module-level boolean, because two processes
// each holding their own `running` flag would both believe they were the only sync in
// progress and both start fetching the same meetings.
let running = false;
function isRunning() { return running; }

// A run that died with status "running" must not block tomorrow's dedupe forever. The
// scheduler's own dedupe (scheduler.js) counts recent runs by status "ok" | "failed" to
// decide whether tonight's — or this hour's — sync already happened; a row stuck on
// "running" because the process was killed mid-fetch is invisible to that count and
// would otherwise let the poller retry every hour forever, each time colliding with
// `running` still being (falsely, in a NEW process) considered held. Sweeping it to
// "failed" after a generous timeout is what lets the next tick actually try again.
const STALE_MS = 60 * 60 * 1000;
async function sweepStaleRuns() {
  await prisma.teamsSync.updateMany({
    where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "failed", error: "Abandoned — the process stopped mid-run.", finishedAt: new Date() },
  });
}

// The retry window. A session with a joinUrl and no teamsCollectedAt is simply still
// eligible; 7 days bounds that so a meeting nobody joined does not poll forever,
// while a weekend outage still self-heals on Monday. (Spec: "The flow", step 4.)
const RETRY_DAYS = 7;
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: require("./clock").ZONE });
};
const daysAhead = (n) => {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: require("./clock").ZONE });
};

async function runSync({ mode = "manual", startedBy = null } = {}) {
  if (running) throw new Error("A Teams attendance sync is already running.");
  running = true;
  const issues = [];
  const note = (m) => issues.push(String(m).slice(0, 500));
  const summary = {
    meetingsDiscovered: 0, sessionsMatched: 0, sessionsAmbiguous: 0,
    reportsFetched: 0, marksCreated: 0, marksSkippedExisting: 0,
    participantsUnmatched: 0,
  };
  // `run` is declared here, outside the try, only so the catch block below can still
  // see it — it is not assigned until the FIRST line inside the try. The create used
  // to sit ahead of the try/finally entirely, which reads as harmless (it's "just"
  // the row that records the run) but is not: a create that itself rejects — a pooler
  // blip, or a deploy that reaches this code before `prisma migrate deploy` has run
  // for the TeamsSync table — threw straight out of runSync without ever reaching
  // `finally`, so `running` stayed true for the rest of the process's life. Every
  // later call answered "A Teams attendance sync is already running", isRunning()
  // told the scheduler to skip its hourly tick forever, and POST /sync answered 409
  // forever too — with no TeamsSync row anywhere recording why, because the one
  // attempt to create one is exactly what failed. Moving the create inside the try
  // means its failure now reaches the same `finally { running = false }` every other
  // failure here does.
  let run;
  try {
    run = await prisma.teamsSync.create({ data: { mode, startedBy } });

    // ---- DISCOVERY: put join URLs onto sessions that have none. -------------------
    const organizers = await graph.resolveOrganizers();
    const today = localDate();
    // Candidate registers: recent past (the retry window) through the coming week.
    // The forward edge matters as much as the backward one — a college that turns the
    // feature on today should have next Monday's lecture already matched by the time
    // it happens, rather than discovering it only once that class is already running.
    const sessions = await prisma.hndSession.findMany({
      where: { date: { gte: daysAgo(RETRY_DAYS), lte: daysAhead(7) } },
      include: { unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, term: { select: { start: true, end: true } } } } },
    });
    // One matcher candidate per (date,startTime,title) GROUP OF SESSIONS, because a
    // merged class is several registers sharing one meeting — a match must land the
    // URL on every one of them, and counting each register as a separate candidate
    // would make every merged class "ambiguous" against itself (two or more candidates
    // at the same date+time, exactly the shape matchMeeting treats as needing a title
    // tiebreak, when in truth there is only one meeting and one class).
    const groups = new Map(); // date|start|eventKey -> { id (rep), title, sessionIds }
    for (const s of sessions) {
      const key = `${s.date}|${s.startTime}|${s.timetableEventId || s.unitId}`;
      if (!groups.has(key)) groups.set(key, { id: key, date: s.date, startTime: s.startTime, title: s.description || s.unit?.name || s.unit?.code || "", sessionIds: [] });
      groups.get(key).sessionIds.push(s.id);
    }
    const candidates = [...groups.values()];
    for (const org of organizers) {
      let meetings = [];
      try { meetings = await graph.calendarView(org.id, daysAgo(RETRY_DAYS), daysAhead(7)); }
      catch (e) { note(`Calendar for ${org.email} could not be read: ${e.message}`); continue; }
      for (const m of meetings) {
        summary.meetingsDiscovered++;
        const url = parseJoinUrl(m.joinUrl);
        if (!url) continue;
        const verdict = matchMeeting({ subject: m.subject, date: m.date, startTime: m.startTime }, candidates);
        if (verdict.kind === "none") continue; // a staff meeting on the same calendar is not an issue
        if (verdict.kind === "ambiguous") {
          summary.sessionsAmbiguous++;
          note(`Meeting "${m.subject}" (${m.date} ${m.startTime}, organizer ${org.email}) matches more than one class — paste its join link onto the right timetable event to resolve it.`);
          continue;
        }
        const group = groups.get(verdict.id);
        // NEVER overwrite a URL already on the session: an admin's paste (carried
        // down from the event) or an earlier match stands. Fill blanks only. This is
        // the discovery-side twin of the never-overwrite-a-mark rule below — once
        // something has told the sync which meeting a class belongs to, discovery's
        // job on that session is done, permanently, not "until the next calendar scan
        // disagrees".
        const r = await prisma.hndSession.updateMany({
          where: { id: { in: group.sessionIds }, teamsJoinUrl: null },
          data: { teamsJoinUrl: url, teamsOrganizerId: org.id },
        });
        if (r.count > 0) summary.sessionsMatched += r.count;
      }
    }

    // ---- COLLECTION: ended sessions with a URL and no collectedAt. ----------------
    const nowTime = localTime();
    const eligible = await prisma.hndSession.findMany({
      where: {
        teamsJoinUrl: { not: null }, teamsCollectedAt: null,
        date: { gte: daysAgo(RETRY_DAYS), lte: today },
      },
      include: { unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, term: { select: { start: true, end: true } } } } },
    });
    const tap = await tapConfig.get(); // lateAfterMins — the same lateness rule as taps
    const cfgTeams = await teamsConfig.get();
    for (const session of eligible) {
      // A future session is NEVER marked (global constraint). Zero-padded HH:MM
      // compares as strings, the codebase-wide convention.
      if (session.date === today && session.endTime >= nowTime) continue;
      // Term lock, as every write path honours it. Collected-and-refused, not
      // retried: the term will not reopen inside the retry window, so leaving
      // collectedAt null here would just have the sync ask the same unanswerable
      // question every day until RETRY_DAYS gave up on it anyway — marking it done
      // now is honest about the outcome rather than a delay that changes nothing.
      if (!termOpenOn(session.unit?.term, session.date)) {
        note(`Register ${session.date} ${session.startTime} (${session.unit?.code || "?"}) is outside its term — no Teams marks written.`);
        await prisma.hndSession.update({ where: { id: session.id }, data: { teamsCollectedAt: new Date() } });
        continue;
      }
      // Resolve the meeting id once; an organizer id is on the session from
      // discovery, or must be findable by asking each organizer (the paste path has
      // no organizer) — try each until one answers.
      let meetingId = session.teamsMeetingId;
      let organizerId = session.teamsOrganizerId;
      if (!meetingId) {
        const tryOrgs = organizerId ? [{ id: organizerId }] : await graph.resolveOrganizers();
        for (const org of tryOrgs) {
          try {
            const id = await graph.resolveMeetingId(org.id, session.teamsJoinUrl);
            if (id) { meetingId = id; organizerId = org.id; break; }
          } catch (e) { note(`Resolving the meeting for ${session.date} ${session.startTime}: ${e.message}`); }
        }
        if (!meetingId) {
          note(`The Teams link on ${session.date} ${session.startTime} (${session.unit?.code || "?"}) resolves to no meeting on any organizer account — was it created elsewhere, or deleted?`);
          continue; // stays eligible; the retry window bounds this
        }
        await prisma.hndSession.update({ where: { id: session.id }, data: { teamsMeetingId: meetingId, teamsOrganizerId: organizerId } });
      }
      let participants;
      try { participants = await graph.attendanceIntervals(organizerId, meetingId); }
      catch (e) {
        note(`Attendance report for ${session.date} ${session.startTime} (${session.unit?.code || "?"}) could not be fetched: ${e.message}`);
        continue; // NO marks on a failed fetch — Absent is only written on success
      }
      summary.reportsFetched++;

      // Match participants to students: cached msUserId first, then email.
      const roster = await rosterForSession(session);
      const students = await prisma.student.findMany({
        where: { id: { in: roster.studentIds } },
        select: { id: true, email: true, msUserId: true },
      });
      const byMsId = new Map(students.filter((s) => s.msUserId).map((s) => [s.msUserId, s]));
      const byEmail = new Map(students.map((s) => [s.email.toLowerCase(), s]));
      const attendedBy = new Map(); // studentId -> participant
      for (const p of participants) {
        const s = (p.msUserId && byMsId.get(p.msUserId)) || (p.email && byEmail.get(p.email));
        if (!s) {
          // On the call but on no roster we can see. Reported, never guessed —
          // could be the teacher, could be a personal email. (Spec: "Unmatched
          // participants are reported, never guessed.")
          summary.participantsUnmatched++;
          note(`"${p.email || p.msUserId}" was in the ${session.date} ${session.startTime} meeting but matches no student on that register.`);
          continue;
        }
        if (p.msUserId && !s.msUserId) {
          // Cache the match, moodleUserId-style. Swallow a P2002: two students
          // sharing one Microsoft account is a data problem to report, not a crash —
          // Student.msUserId carries its own @@unique, so the second student to
          // report that id hits the constraint rather than silently overwriting the
          // first student's cached id.
          try { await prisma.student.update({ where: { id: s.id }, data: { msUserId: p.msUserId } }); }
          catch (e) { if (e?.code !== "P2002") throw e; note(`Microsoft account ${p.email} appears to belong to two students — id not cached.`); }
        }
        attendedBy.set(s.id, p);
      }

      // Decide every rostered student, then write ONLY where no mark stands.
      const rows = [];
      for (const studentId of roster.studentIds) {
        const p = attendedBy.get(studentId);
        const { minutes, firstJoin } = p
          ? attendedMinutes(p.intervals, session)
          : { minutes: 0, firstJoin: null };
        const d = decideStatus({ minutes, firstJoin, session, minAttendancePct: cfgTeams.minAttendancePct, lateAfterMins: tap.lateAfterMins });
        rows.push({
          sessionId: session.id, studentId, status: d.status, remark: d.remark,
          takenBy: TEAMS_AUTO_STAMP,
          // The arrival minute, only when they actually joined — null is "not
          // measurable", exactly as checkedInAt's own comment requires.
          checkedInAt: firstJoin,
        });
      }
      // createMany + skipDuplicates on @@unique([sessionId, studentId]) IS the
      // never-overwrite invariant, the same way moodleAttendance.js holds it: a mark
      // a lecturer already took (or one an earlier sync run already wrote) is a row
      // that already exists at that key, so the insert for it is silently skipped
      // rather than colliding — and a person's mark, or the earlier machine mark,
      // stands exactly as it was.
      const res = await prisma.attendanceMark.createMany({ data: rows, skipDuplicates: true });
      summary.marksCreated += res.count;
      summary.marksSkippedExisting += rows.length - res.count;
      // The audit trail, in the tap log every other method already writes — the spec
      // requires BOTH "accepted and refused marks logged to TagTap", and TagTap.outcome
      // is documented in schema.prisma as carrying "marked" and "already_marked" for
      // method "teams" for exactly this pair.
      //
      // One re-read after createMany answers "which of these did this run actually
      // write" for every rostered student at once, and it is read back rather than
      // derived from `res.count` plus this process's belief about ordering: skipDuplicates
      // gives no guarantee about WHICH rows in a batch were the duplicates, only how many,
      // so `res.count` alone cannot tell "marked" from "already_marked" per student — only
      // the database's own account of what now stands can. A student whose mark carries
      // takenBy === TEAMS_AUTO_STAMP is one this run just wrote (or, exactly once, a run
      // that crashed after this createMany but before teamsCollectedAt was set — a retry
      // would then find its own prior write already standing and correctly log THAT as
      // "already_marked", not double-count it as newly marked); anything else is a mark
      // that already stood before this run touched the session — a lecturer's tick, a
      // Moodle import, or an earlier capture method — and was correctly left alone.
      if (rows.length > 0) {
        const standing = await prisma.attendanceMark.findMany({
          where: { sessionId: session.id, studentId: { in: rows.map((r) => r.studentId) } },
          select: { studentId: true, status: true, takenBy: true },
        });
        const byStudent = new Map(standing.map((m) => [m.studentId, m]));
        const tapRows = [];
        for (const r of rows) {
          const mark = byStudent.get(r.studentId);
          if (!mark) continue; // every row was either just inserted or already existed
          if (mark.takenBy === TEAMS_AUTO_STAMP) {
            tapRows.push({ studentId: r.studentId, sessionId: session.id, method: "teams", outcome: "marked", status: mark.status });
          } else {
            // Refused, not silent — the never-overwrite invariant above is a decision,
            // and a decision the sync makes belongs in the log the same as one it acts
            // on. No `status`: the mark this run refused to write may disagree with the
            // one already on the register (a lecturer may have marked this student
            // differently), so reporting the STANDING mark's status here would credit
            // it to the Teams sync's own judgement, which is exactly what did not
            // happen. Bounded the same way "marked" is: teamsCollectedAt stops this
            // session being looked at again, so a register a lecturer already took does
            // not grow one "already_marked" row per student per hour.
            tapRows.push({ studentId: r.studentId, sessionId: session.id, method: "teams", outcome: "already_marked" });
          }
        }
        if (tapRows.length) await prisma.tagTap.createMany({ data: tapRows });
      }
      await prisma.hndSession.update({ where: { id: session.id }, data: { teamsCollectedAt: new Date() } });
    }

    const finished = await prisma.teamsSync.update({
      where: { id: run.id },
      data: { status: "ok", finishedAt: new Date(), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
    });
    return { run: finished, summary, issues };
  } catch (e) {
    // `run` is undefined here exactly when the create itself was what failed — in
    // that case there is no row to mark "failed" and nothing for a later sweep to
    // find, because none was ever written.
    if (run) {
      await prisma.teamsSync.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error: String(e.message || e).slice(0, 1000), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
      }).catch(() => {});
    }
    throw e;
  } finally {
    running = false;
  }
}

module.exports = { runSync, isRunning, sweepStaleRuns };
