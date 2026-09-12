// Teams automation, Phase A: reconcile timetable events against Microsoft calendar
// meetings — create one when a published event wants it and has none, update it when
// the event changed since the meeting was last synced, cancel it when the event no
// longer wants it (unpublished, or the checkbox cleared) but we own a meeting for it.
//
// Same split as teamsSync.js: decisions here are plain "what does this row need"
// logic against rows already in memory, Graph access is entirely in teamsGraph.js,
// and this file is wiring between the two — reading the right rows, calling the right
// function, writing the result back. Nothing here is unit-tested for the same reason
// nothing in teamsSync.js is: there is no pure decision to extract, only a database
// and a Microsoft tenant to talk to, which is exactly what the smoke suite is for.
const prisma = require("./db");
const graph = require("./teamsGraph");

// In-process, like every lock in this codebase (conventions.md): correct for one Node
// process, and one process is what a deployment is. See teamsSync.js's own comment on
// `running` for the clustered-deployment caveat — it applies here unchanged.
let running = false;
function isRunning() { return running; }

// A run that died mid-flight must not wedge tomorrow's — or this hour's — dedupe
// forever. Same reasoning, same threshold, as teamsSync.js's sweepStaleRuns: a row
// stuck on "running" because the process was killed is invisible to the scheduler's
// "did this already happen recently" count, and would otherwise block every later
// tick from ever trying again.
const STALE_MS = 60 * 60 * 1000;
async function sweepStaleRuns() {
  await prisma.teamsProvisionSync.updateMany({
    where: { job: "meetings", status: "running", startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "failed", error: "Abandoned — the process stopped mid-run.", finishedAt: new Date() },
  });
}

// The reconcile window: yesterday (so a class that was cancelled just after it
// finished still gets its meeting cancelled, rather than leaving a stray Teams
// calendar entry nobody will ever look at again) through two weeks ahead. Creating
// further out than that adds nothing a college can act on today and only makes every
// reconcile slower for it, so the window is deliberately short rather than "the whole
// term" the way the timetable screen itself might show.
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: require("./clock").ZONE });
};
const daysAhead = (n) => {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: require("./clock").ZONE });
};

/**
 * The channel address(es) to invite alongside staff, for an event whose unit already
 * has a provisioned channel. Returns [] rather than throwing when Phase B has not run
 * (or is switched off) for this cohort/unit — a meeting must still be creatable with
 * just its staff as attendees, because provisioning is a separate switch a college may
 * never turn on at all.
 *
 * Only when the event names exactly one cohort group: a merged class (two intakes,
 * one lecture) has no single "the" channel to address, and guessing one would put the
 * invite in front of the wrong intake's channel members. That case is silently skipped
 * (attendees fall back to staff only) rather than reported as an issue, because it is
 * an ordinary shape of timetable data, not a fault.
 */
async function channelEmailsFor(ev) {
  if (!ev.unitId || !ev.groups || ev.groups.length !== 1) return [];
  const cohortId = ev.groups[0].cohortId;
  const unitChannel = await prisma.unitChannel.findFirst({
    where: { unitId: ev.unitId, cohortTeam: { cohortId } },
    select: { channelEmail: true },
  });
  return unitChannel?.channelEmail ? [unitChannel.channelEmail] : [];
}

async function runMeetingsSync({ mode = "manual", startedBy = null } = {}) {
  if (running) throw new Error("A Teams meetings sync is already running.");
  running = true;
  const issues = [];
  const note = (m) => issues.push(String(m).slice(0, 500));
  const summary = { meetingsCreated: 0, meetingsUpdated: 0, meetingsCancelled: 0 };
  // `run` declared outside the try, assigned only as its first line — the same
  // create-inside-try shape teamsSync.js's own long comment justifies: a create that
  // itself rejects (a pooler blip, a deploy that reaches this code before
  // `prisma migrate deploy` has run for TeamsProvisionSync) must still reach the
  // `finally` below, or `running` stays true forever and every later call — manual or
  // scheduled — answers "already running" with no row anywhere recording why.
  let run;
  try {
    run = await prisma.teamsProvisionSync.create({ data: { job: "meetings", mode, startedBy } });

    const organizerId = await graph.resolveCreatorId();
    if (!organizerId) {
      throw new Error("No Teams creator account is configured (Settings -> Connected systems -> Teams).");
    }

    const events = await prisma.timetableEvent.findMany({
      where: { date: { gte: daysAgo(1), lte: daysAhead(14) } },
      include: {
        unit: { select: { code: true, name: true } },
        staff: { select: { staff: { select: { email: true } } } },
        groups: { select: { cohortId: true } },
      },
    });

    for (const ev of events) {
      try {
        const wants = ev.published && ev.teamsAutoMeeting;
        // A human's pasted link always wins — never create a second meeting beside
        // it. `teamsCalendarEventId` is how the machine tells its own meeting apart
        // from a pasted one (see the column's comment on schema.prisma): a paste has
        // no calendarEventId, so this only fires for a link nobody but a person put
        // there.
        const pasted = (ev.teamsJoinUrl || "").trim() && !ev.teamsCalendarEventId;
        if (pasted) continue;
        if (!wants && !ev.teamsCalendarEventId) continue; // nothing to do, nothing owned

        if (!wants && ev.teamsCalendarEventId) {
          // Unpublished (or the checkbox was cleared) after we created a meeting for
          // it — cancel OURS. The machine only ever cancels a meeting it owns, never
          // one it merely matched (constraints.md), and owning is exactly what a
          // non-null teamsCalendarEventId records.
          await graph.cancelClassMeeting({ organizerId, calendarEventId: ev.teamsCalendarEventId });
          await prisma.timetableEvent.update({
            where: { id: ev.id },
            data: { teamsCalendarEventId: null, teamsMeetingSyncedAt: null, teamsJoinUrl: "" },
          });
          // The registers this event built carry their own copies of the join
          // details (teamsJoinUrl/teamsMeetingId/teamsOrganizerId) so attendance can
          // work from the register alone — see HndSession's own comment on those
          // columns. Clearing THIS event's fields above does nothing to those copies,
          // and leaving them would have the attendance sync keep polling a meeting
          // that no longer exists on Microsoft's side until its 7-day retry window
          // gave up — a week of "could not be fetched" issues for a class the college
          // already knows is cancelled. Nulling them here, through the same fields
          // the paste-change reset already uses, is what stops that.
          await prisma.hndSession.updateMany({
            where: { timetableEventId: ev.id },
            data: { teamsJoinUrl: null, teamsMeetingId: null, teamsOrganizerId: null },
          });
          summary.meetingsCancelled++;
          continue;
        }

        const title = ev.title || ev.unit?.name || ev.unit?.code || "Class";
        const attendees = [...new Set([
          ...ev.staff.map((s) => s.staff.email),
          ...(await channelEmailsFor(ev)),
        ])].filter(Boolean);

        if (!ev.teamsCalendarEventId) {
          const { calendarEventId, joinUrl } = await graph.createClassMeeting({
            organizerId, subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees,
          });
          await prisma.timetableEvent.update({
            where: { id: ev.id },
            data: { teamsCalendarEventId: calendarEventId, teamsJoinUrl: joinUrl, teamsMeetingSyncedAt: new Date() },
          });
          // Carry to registers NOW rather than waiting for the next publish pass —
          // publishing is what BUILT these registers, so they already exist and the
          // attendance sync will look at teamsJoinUrl on exactly them. Filtered on
          // `teamsJoinUrl: null` so a register that already carries a link (an
          // admin's own paste on the SESSION, independent of the event) is left
          // alone — the same never-overwrite rule teamsSync.js's discovery half
          // holds for exactly the same reason.
          await prisma.hndSession.updateMany({
            where: { timetableEventId: ev.id, teamsJoinUrl: null },
            data: { teamsJoinUrl: joinUrl, teamsOrganizerId: organizerId },
          });
          summary.meetingsCreated++;
        } else if (!ev.teamsMeetingSyncedAt || ev.updatedAt > ev.teamsMeetingSyncedAt) {
          // updatedAt is bumped by ANY change to the row — time, room, title, staff —
          // so comparing it against teamsMeetingSyncedAt is what tells "the event
          // moved since we last told Microsoft about it" apart from "nothing changed,
          // skip the write". A meeting the college is not actually editing gets left
          // alone on every tick rather than PATCHed for no reason.
          await graph.updateClassMeeting({
            organizerId, calendarEventId: ev.teamsCalendarEventId,
            subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees,
          });
          await prisma.timetableEvent.update({ where: { id: ev.id }, data: { teamsMeetingSyncedAt: new Date() } });
          summary.meetingsUpdated++;
        }
      } catch (e) {
        // One broken event (a bad Graph response, a staff member whose email Graph
        // rejects) must not stop every other class in the college from getting its
        // meeting. Named by date/time/title so an admin reading the run log can find
        // the actual timetable entry rather than guessing from a bare id.
        note(`${ev.date} ${ev.startTime} "${ev.title || ev.unit?.name || ev.unit?.code || "Class"}": ${e.message}`);
      }
    }

    const finished = await prisma.teamsProvisionSync.update({
      where: { id: run.id },
      data: { status: "ok", finishedAt: new Date(), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
    });
    return { run: finished, summary, issues };
  } catch (e) {
    // `run` is undefined exactly when the create itself failed — there is then no row
    // to mark "failed" and nothing for sweepStaleRuns to ever find, because none was
    // written. Same reasoning as teamsSync.js's catch block.
    if (run) {
      await prisma.teamsProvisionSync.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error: String(e.message || e).slice(0, 1000), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
      }).catch(() => {});
    }
    throw e;
  } finally {
    running = false;
  }
}

module.exports = { runMeetingsSync, isRunning, sweepStaleRuns };
