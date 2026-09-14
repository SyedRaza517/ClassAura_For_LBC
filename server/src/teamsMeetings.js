// Teams automation, Phase A: reconcile timetable events against Microsoft calendar
// meetings — create one when a published event wants it and has none, update it when
// the event changed since the meeting was last synced, cancel it when the event no
// longer wants it (unpublished, or the checkbox cleared) but we own a meeting for it.
//
// Same split as teamsSync.js: decisions here are plain "what does this row need"
// logic against rows already in memory, Graph access is entirely in teamsGraph.js,
// and this file is wiring between the two — reading the right rows, calling the right
// function, writing the result back. Most of it is unit-tested for the same reason
// most of teamsSync.js is not: there IS one pure decision worth extracting here —
// meetingFingerprint, below — after an engine review found the interim
// updatedAt-vs-teamsMeetingSyncedAt gate never actually closed (see that function's
// own comment). teamsMeetings.test.js covers it without a database or a Microsoft
// tenant; runMeetingsSync itself remains wiring, exercised by the smoke suite the
// same as teamsSync.js's runSync.
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
 * A fingerprint of exactly the fields sent to Graph in createClassMeeting /
 * updateClassMeeting — subject, date, start/end time, and the attendee list sorted
 * (so the SAME set of attendees in a different array order, which owes nothing to
 * anyone actually changing, does not read as a change). This REPLACES comparing
 * TimetableEvent.updatedAt against teamsMeetingSyncedAt as the patch gate: updatedAt
 * is `@updatedAt`, so the very update that stores teamsMeetingSyncedAt bumps
 * updatedAt to a LATER instant than what was just recorded, making
 * "updatedAt > teamsMeetingSyncedAt" permanently true from the first sync onward —
 * every owned meeting got re-PATCHed, and every attendee re-notified by Microsoft,
 * on every single hourly tick forever. A tick that finds nothing actually different
 * about the meeting's own inputs now computes the same string as last time and
 * skips the PATCH; teamsMeetingSyncedAt remains on the row purely as an
 * informational "last touched" timestamp for the UI/debugging, never read here.
 */
function meetingFingerprint({ subject, date, startTime, endTime, attendeeEmails }) {
  return [subject, date, startTime, endTime, ...[...attendeeEmails].sort()].join("|");
}

/**
 * A fingerprint of exactly the fields sent to Graph for a recurring series meeting —
 * subject, the date range, the weekly pattern, the times, the attendee list AND the
 * teaching-staff list (staff drive co-organizer, so a lecturer change must re-sync even
 * though attendees may already contain that email). All list fields sorted so order,
 * which owes nothing to a real change, does not read as one. The series pass PATCHes the
 * meeting only when this differs from the stored fingerprint — the same gate
 * meetingFingerprint gives the per-event pass.
 */
function seriesFingerprint({ subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails, staffEmails }) {
  return [
    subject, firstDate, lastDate, startTime, endTime,
    [...(weekdays || [])].sort().join(","),
    [...(attendeeEmails || [])].sort().join(","),
    [...(staffEmails || [])].sort().join(","),
  ].join("|");
}

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

async function reconcileSeries({ organizerId, note, summary, legacySeriesIds }) {
  // Candidate series: those with at least one still-relevant (>= yesterday) published,
  // wanted occurrence. Grouped by seriesId.
  const events = await prisma.timetableEvent.findMany({
    where: { seriesId: { not: null }, date: { gte: daysAgo(1) } },
    include: {
      unit: { select: { code: true, name: true } },
      staff: { select: { staff: { select: { email: true } } } },
      groups: { select: { cohortId: true } },
    },
    orderBy: { date: "asc" },
  });
  const bySeries = new Map();
  for (const ev of events) {
    if (!bySeries.has(ev.seriesId)) bySeries.set(ev.seriesId, []);
    bySeries.get(ev.seriesId).push(ev);
  }

  for (const [seriesId, group] of bySeries) {
    try {
      const wantedEvents = group.filter((e) => e.published && e.teamsAutoMeeting);
      const existing = await prisma.teamsSeriesMeeting.findUnique({ where: { seriesId } });

      // Legacy series (per-event meetings predate recurring ones) stay wholly on the
      // per-event path — never converted here.
      if (legacySeriesIds.has(seriesId)) continue;

      // Not wanted (unpublished / checkbox cleared across the whole series) but we own a
      // recurring meeting: cancel OURS and clear the links.
      if (!wantedEvents.length) {
        if (existing) {
          await graph.cancelClassMeeting({ organizerId, calendarEventId: existing.calendarEventId });
          const ids = group.map((e) => e.id);
          await prisma.timetableEvent.updateMany({ where: { id: { in: ids }, teamsJoinUrl: existing.joinUrl }, data: { teamsJoinUrl: "" } });
          await prisma.hndSession.updateMany({ where: { timetableEventId: { in: ids }, teamsJoinUrl: existing.joinUrl }, data: { teamsJoinUrl: null, teamsMeetingId: null, teamsOrganizerId: null } });
          await prisma.teamsSeriesMeeting.delete({ where: { seriesId } });
          summary.seriesMeetingsCancelled++;
        }
        continue;
      }

      // The meeting's range/pattern must reflect the WHOLE series, not just the occurrences
      // still inside the reconcile window — otherwise firstDate/weekdays drift forward as past
      // weeks age out, the fingerprint changes weekly, and Microsoft re-notifies everyone every
      // week. Queried fresh (id + date only) so it stays stable for the life of the series.
      const allSeriesEvents = await prisma.timetableEvent.findMany({
        where: { seriesId, published: true, teamsAutoMeeting: true },
        select: { date: true },
      });
      const allDates = allSeriesEvents.map((e) => e.date).sort();
      const firstDate = allDates[0];
      const lastDate = allDates[allDates.length - 1];
      const weekdays = [...new Set(allSeriesEvents.map((e) => graph.graphWeekday(e.date)))].sort();
      const startTime = wantedEvents[0].startTime;
      const endTime = wantedEvents[0].endTime;
      const subject = wantedEvents[0].title || wantedEvents[0].unit?.name || wantedEvents[0].unit?.code || "Class";
      const staffEmails = [...new Set(wantedEvents.flatMap((e) => e.staff.map((s) => s.staff.email)))].filter(Boolean);
      // Attendees = staff + the unit's channel (one cohort only), same rule as the
      // per-event pass. Reuse channelEmailsFor on a representative event.
      const channelEmails = await channelEmailsFor(wantedEvents[0]);
      const attendeeEmails = [...new Set([...staffEmails, ...channelEmails])].filter(Boolean);
      const fp = seriesFingerprint({ subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails, staffEmails });

      let row = existing;
      if (!row) {
        const { calendarEventId, joinUrl } = await graph.createRecurringClassMeeting({ organizerId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails });
        row = await prisma.teamsSeriesMeeting.create({ data: { seriesId, calendarEventId, joinUrl, organizerId, fingerprint: fp } });
        summary.seriesMeetingsCreated++;
      } else if (fp !== row.fingerprint) {
        await graph.updateRecurringClassMeeting({ organizerId, calendarEventId: row.calendarEventId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails });
        row = await prisma.teamsSeriesMeeting.update({ where: { seriesId }, data: { fingerprint: fp, lastSyncedAt: new Date() } });
        summary.seriesMeetingsUpdated++;
      }

      // Fan the ONE join URL onto every occurrence's event + registers (blanks only, so
      // an admin's paste and an already-set link both stand — the never-overwrite rule).
      const ids = group.map((e) => e.id);
      await prisma.timetableEvent.updateMany({ where: { id: { in: ids }, teamsJoinUrl: "" }, data: { teamsJoinUrl: row.joinUrl } });
      await prisma.hndSession.updateMany({ where: { timetableEventId: { in: ids }, teamsJoinUrl: null }, data: { teamsJoinUrl: row.joinUrl, teamsOrganizerId: organizerId } });

      // Resolve the onlineMeeting id once, then promote staff to co-organizers when the
      // staff set changed (or was never written). Failure to resolve/promote is a NOTE,
      // never a thrown run — the meeting and its link already stand.
      if (!row.meetingId) {
        try {
          const mid = await graph.resolveMeetingId(organizerId, row.joinUrl);
          if (mid) row = await prisma.teamsSeriesMeeting.update({ where: { seriesId }, data: { meetingId: mid } });
        } catch (e) { note(`Series "${subject}": resolving its meeting id for co-organizers: ${e.message}`); }
      }
      if (row.meetingId && (!row.coorganizersSetAt || fp !== existing?.fingerprint)) {
        try {
          const ids2 = [];
          for (const email of staffEmails) { const uid = await graph.resolveUserId(email); if (uid) ids2.push(uid); else note(`Series "${subject}": ${email} has no Microsoft account — not made a co-organizer.`); }
          await graph.setMeetingCoorganizers({ organizerId, meetingId: row.meetingId, coorganizerUserIds: ids2 });
          await prisma.teamsSeriesMeeting.update({ where: { seriesId }, data: { coorganizersSetAt: new Date() } });
        } catch (e) { note(`Series "${subject}": setting co-organizers: ${e.message}`); }
      }

      // Fan the resolved onlineMeeting id to every occurrence's register too, so
      // attendance collection can read it straight from the session rather than
      // re-resolving it per occurrence (blanks only, same never-overwrite rule as the
      // join-URL fan-out above).
      if (row.meetingId) {
        await prisma.hndSession.updateMany({ where: { timetableEventId: { in: ids }, teamsMeetingId: null }, data: { teamsMeetingId: row.meetingId } });
      }
    } catch (e) {
      note(`Series ${seriesId}: ${e.message}`);
    }
  }
}

async function runMeetingsSync({ mode = "manual", startedBy = null } = {}) {
  if (running) throw new Error("A Teams meetings sync is already running.");
  running = true;
  const issues = [];
  const note = (m) => issues.push(String(m).slice(0, 500));
  const summary = { meetingsCreated: 0, meetingsUpdated: 0, meetingsCancelled: 0, seriesMeetingsCreated: 0, seriesMeetingsUpdated: 0, seriesMeetingsCancelled: 0 };
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

    // Legacy series ids, computed ONCE across every event (not just the reconcile
    // window) so a legacy series' brand-new occurrence — one that rolls into the window
    // after this deploy, with no teamsCalendarEventId of its own yet — is still
    // recognised as belonging to a legacy series and stays on the per-event path
    // instead of being stranded (skipped by both the per-event loop AND
    // reconcileSeries, neither of which then owns it).
    const legacyRows = await prisma.timetableEvent.findMany({
      where: { seriesId: { not: null }, teamsCalendarEventId: { not: null } },
      select: { seriesId: true }, distinct: ["seriesId"],
    });
    const legacySeriesIds = new Set(legacyRows.map((r) => r.seriesId));

    await reconcileSeries({ organizerId, note, summary, legacySeriesIds });

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
        // Series events are owned by reconcileSeries UNLESS the series is legacy (already has
        // per-event meetings from before recurring meetings existed) — a legacy series stays
        // wholly on this per-event path, new occurrences included. One-offs (seriesId null)
        // always run here.
        if (ev.seriesId && !legacySeriesIds.has(ev.seriesId)) continue;

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
            data: { teamsCalendarEventId: null, teamsMeetingSyncedAt: null, teamsMeetingFingerprint: null, teamsJoinUrl: "" },
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

        const fp = meetingFingerprint({ subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees });

        if (!ev.teamsCalendarEventId) {
          const { calendarEventId, joinUrl } = await graph.createClassMeeting({
            organizerId, subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees,
          });
          await prisma.timetableEvent.update({
            where: { id: ev.id },
            data: { teamsCalendarEventId: calendarEventId, teamsJoinUrl: joinUrl, teamsMeetingSyncedAt: new Date(), teamsMeetingFingerprint: fp },
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
        } else if (fp !== ev.teamsMeetingFingerprint) {
          // The gate: PATCH only when the fields Graph was actually told about
          // (subject/date/times/attendees) differ from what was stored after the
          // last successful create or PATCH. See meetingFingerprint's own comment
          // for why this replaced comparing updatedAt against teamsMeetingSyncedAt
          // — that comparison never went false once true, so it re-PATCHed (and
          // re-notified every attendee) on every hourly tick forever. A room change
          // or a title edit that does not touch any of these fields correctly does
          // NOT trigger a PATCH here — Graph's calendar event has nothing to say
          // about a room, and this sync's whole job is the meeting, not the event.
          await graph.updateClassMeeting({
            organizerId, calendarEventId: ev.teamsCalendarEventId,
            subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees,
          });
          await prisma.timetableEvent.update({ where: { id: ev.id }, data: { teamsMeetingSyncedAt: new Date(), teamsMeetingFingerprint: fp } });
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

module.exports = { runMeetingsSync, isRunning, sweepStaleRuns, meetingFingerprint, seriesFingerprint };
