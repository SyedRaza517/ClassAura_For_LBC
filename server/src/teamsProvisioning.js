// Teams automation, Phase B: provision a class space per cohort — a Team, one
// channel per unit the cohort is taught, the cohort's teaching staff as owners and
// its students as members — and keep membership current on every run.
//
// ADDITIVE-ONLY, throughout (constraints.md): this file creates and adds, never
// removes and never renames. A student who withdraws keeps their Team membership; a
// unit dropped from the timetable keeps its channel. Undoing either is a decision for
// a human in the Teams admin center, not something an unattended nightly sweep should
// ever be trusted to infer from a timetable change.
//
// Same split as teamsMeetings.js and teamsSync.js: Graph access lives entirely in
// teamsGraph.js, and this file is wiring — reading which cohorts/units/people are in
// scope, calling the right Graph write, recording what happened. Every step reports a
// miss rather than guessing (constraints.md) — an unmatched person is a counted,
// named issue, never silently skipped and never invented.
const prisma = require("./db");
const graph = require("./teamsGraph");

// In-process, like every lock in this codebase (conventions.md) — see teamsSync.js's
// own comment on `running` for the clustered-deployment caveat, unchanged here.
let running = false;
function isRunning() { return running; }

// Same abandoned-run rescue as teamsMeetings.js and teamsSync.js: a "running" row left
// behind by a killed process must not block every later dedupe forever.
const STALE_MS = 60 * 60 * 1000;
async function sweepStaleRuns() {
  await prisma.teamsProvisionSync.updateMany({
    where: { job: "provisioning", status: "running", startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "failed", error: "Abandoned — the process stopped mid-run.", finishedAt: new Date() },
  });
}

// Microsoft Graph's own limit on a Team's displayName. Exceeding it is a 400 from
// Graph, not a soft truncation on Microsoft's side, so this has to happen before the
// call rather than being left for the per-cohort catch below to turn into a reported
// failure for what is, underneath, a perfectly good cohort.
const MAX_TEAM_NAME = 120;
// A standard channel's displayName limit is smaller (50) — the same reasoning as
// MAX_TEAM_NAME above, kept as its own constant because the two are independent Graph
// limits on independent fields, not one number reused for two unrelated reasons.
const MAX_CHANNEL_NAME = 50;

function truncateName(name, max) {
  const s = String(name || "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * The Team's display name for a cohort: "<course> — <intake>" when the cohort has a
 * course to name (Cohort.course is a required relation in schema.prisma, so in
 * practice it always does — but the include below is what makes it present, and
 * reading `?.name` rather than assuming the object is there is what keeps this
 * function correct even if a future caller passes a cohort fetched without it), or
 * the cohort name alone otherwise. Pure and exported so its truncation can be tested
 * without a database or a Microsoft tenant.
 */
function teamNameFor(cohort) {
  const courseName = cohort.course?.name;
  const base = courseName ? `${courseName} — ${cohort.name}` : cohort.name;
  return truncateName(base, MAX_TEAM_NAME);
}

/**
 * Resolves `person`'s Microsoft user id, caching it onto the row exactly as
 * teamsSync.js caches Student.msUserId from the attendance side: reuse a cached id
 * first, otherwise ask Graph and write the answer back so the next run does not ask
 * again. `delegate` is the Prisma model delegate (prisma.staff or prisma.student) —
 * one function serves both tables because the caching shape is identical and both
 * carry the same `@@unique([msUserId])` constraint with the same failure mode.
 *
 * The P2002 swallow matters for the same reason it does in teamsSync.js: two people
 * legitimately sharing one Microsoft account (a shared demo login, a data error) must
 * not crash the run — it is reported as an issue by the caller instead — but the id
 * Graph just resolved is still correct and still usable for THIS run's addTeamMember
 * call even when it could not be cached for next time.
 */
async function resolveAndCacheMsId(delegate, person) {
  if (person.msUserId) return person.msUserId;
  const id = await graph.resolveUserId(person.email);
  if (!id) return null;
  try {
    await delegate.update({ where: { id: person.id }, data: { msUserId: id } });
  } catch (e) {
    if (e?.code !== "P2002") throw e;
  }
  return id;
}

async function runProvisioning({ mode = "manual", startedBy = null } = {}) {
  if (running) throw new Error("A Teams provisioning sync is already running.");
  running = true;
  const issues = [];
  const note = (m) => issues.push(String(m).slice(0, 500));
  const summary = {
    teamsCreated: 0, channelsCreated: 0, ownersAdded: 0, membersAdded: 0,
    peopleUnmatched: 0, channelEmailMissing: 0,
  };
  // Create-inside-try, same as teamsSync.js and teamsMeetings.js, for the same
  // reason: a create that itself rejects must still reach `finally`, or `running`
  // stays true for the rest of the process's life with no row anywhere recording why.
  let run;
  // The creator account resolved (or found missing) at most once per run, not once
  // per cohort — it is one setting, so ten cohorts needing a new Team in the same run
  // must not ask Graph the same question ten times, and a college with no creator
  // account configured must not get the same "not configured" issue logged once per
  // cohort. `undefined` means "not yet asked"; `null` is a real, cached answer of "no
  // creator account", distinct from never having asked — the same null-means-checked
  // shape UnitChannel.channelEmail uses below.
  let creatorId;
  async function getCreatorId() {
    if (creatorId === undefined) creatorId = await graph.resolveCreatorId();
    return creatorId;
  }

  try {
    run = await prisma.teamsProvisionSync.create({ data: { job: "provisioning", mode, startedBy } });

    // Step 1: cohorts in scope — distinct cohorts appearing in a PUBLISHED event's
    // group list. A cohort with only draft events has nothing a student or member of
    // staff should see yet, so it gets no Team either — provisioning follows
    // publication the same way the meetings engine does.
    const groups = await prisma.timetableEventGroup.findMany({
      where: { event: { published: true } },
      select: { cohortId: true },
      distinct: ["cohortId"],
    });
    const cohortIds = groups.map((g) => g.cohortId);
    const cohorts = await prisma.cohort.findMany({
      where: { id: { in: cohortIds } },
      include: {
        course: { select: { name: true } },
        // Both fetched up front so a cohort with an existing Team does not need a
        // second round trip to learn which channels it already has — only a NEW
        // Team (teamsTeam null here) skips straight to an empty channel list, which
        // is correct: nothing can have a channel on a Team that did not exist a
        // moment ago.
        teamsTeam: { include: { channels: true } },
      },
    });

    for (const cohort of cohorts) {
      try {
        // Step 2: ensure the CohortTeam.
        let cohortTeam = cohort.teamsTeam;
        let justCreatedTeam = false;
        if (!cohortTeam) {
          const owner = await getCreatorId();
          if (!owner) {
            note(`No Teams creator account is configured — "${cohort.name}" was not provisioned a Team.`);
            continue; // nothing else in this cohort can proceed without a Team to attach it to
          }
          const displayName = teamNameFor(cohort);
          const { groupId } = await graph.createTeam({ displayName, ownerUserId: owner });
          cohortTeam = await prisma.cohortTeam.create({
            data: { cohortId: cohort.id, groupId, displayName, lastSyncedAt: new Date() },
          });
          justCreatedTeam = true;
          summary.teamsCreated++;
        } else {
          await prisma.cohortTeam.update({ where: { id: cohortTeam.id }, data: { lastSyncedAt: new Date() } });
        }

        // Step 3: ensure channels — one per unit this cohort is actually taught,
        // going only by PUBLISHED events (unpublished timetabling is a draft nobody
        // should get a channel for yet), skipping the null unitId a workshop or
        // study-support session carries (TimetableEvent.unitId is nullable exactly
        // for those, and a channel needs a unit to be named after).
        const taughtUnits = await prisma.timetableEvent.findMany({
          where: { published: true, unitId: { not: null }, groups: { some: { cohortId: cohort.id } } },
          select: { unitId: true },
          distinct: ["unitId"],
        });
        const existingChannelUnitIds = new Set((cohortTeam.channels || []).map((c) => c.unitId));
        for (const { unitId } of taughtUnits) {
          if (existingChannelUnitIds.has(unitId)) continue; // never re-ask a channel that already exists
          try {
            const unit = await prisma.unit.findUnique({ where: { id: unitId }, select: { code: true, name: true } });
            const displayName = truncateName(unit?.name || unit?.code || "Unit", MAX_CHANNEL_NAME);
            const { channelId } = await graph.createChannel({ groupId: cohortTeam.groupId, displayName });
            // Fetched exactly once, right here, at creation — never again for this
            // channel. A null answer is stored as null (not skipped, not retried):
            // it means "this tenant has channel email disabled", and re-asking a
            // stored null on every future run would just spend a Graph call
            // re-learning a fact this run already learned for good.
            const channelEmail = await graph.getChannelEmail({ groupId: cohortTeam.groupId, channelId });
            await prisma.unitChannel.create({
              data: { cohortTeamId: cohortTeam.id, unitId, channelId, channelEmail: channelEmail ?? null },
            });
            summary.channelsCreated++;
            if (channelEmail === null) summary.channelEmailMissing++;
          } catch (e) {
            note(`Channel for unit ${unitId} in "${cohortTeam.displayName}": ${e.message}`);
          }
        }

        // Step 4: ensure owners — every staff member teaching a published event this
        // cohort attends, across every unit, not only the ones that just got a
        // channel. distinct on staffId so a lecturer teaching this cohort three
        // units is one owner add, not three.
        const staffRows = await prisma.timetableEventStaff.findMany({
          where: { event: { published: true, groups: { some: { cohortId: cohort.id } } } },
          select: { staffId: true, staff: { select: { id: true, email: true, msUserId: true } } },
          distinct: ["staffId"],
        });
        for (const { staff } of staffRows) {
          try {
            const userId = await resolveAndCacheMsId(prisma.staff, staff);
            if (!userId) {
              summary.peopleUnmatched++;
              note(`Staff "${staff.email}" has no matching Microsoft account — not added as an owner of "${cohortTeam.displayName}".`);
              continue;
            }
            await graph.addTeamMember({ groupId: cohortTeam.groupId, userId, owner: true });
            // "Added" counts a NEW add, and a brand-new Team is the only case this
            // sync can actually PROVE that in: addTeamMember() itself succeeds
            // identically whether Graph just created the membership or merely found
            // it already there (see its own comment on swallowing 400/409), so on an
            // EXISTING Team there is no way from here to tell "just added" from
            // "already was one" — and this sync re-adds the same roster on every
            // single run regardless (additive-only, constraints.md). Counting every
            // one of those re-adds as "added" would make every ordinary night look
            // like it just onboarded the whole staff list. Only when the Team itself
            // is new this run can every owner in it be guaranteed new too.
            if (justCreatedTeam) summary.ownersAdded++;
          } catch (e) {
            note(`Adding "${staff.email}" as an owner of "${cohortTeam.displayName}": ${e.message}`);
          }
        }

        // Step 5: ensure members — the cohort's own students. No `active` filter:
        // this table has never scoped a cohort roster that way (registers.js and
        // hnd.js's own cohort-roster reads do not either), and provisioning being
        // additive-only means a withdrawn student's continued Team membership is a
        // decision for a human to reverse, not one this sync should infer.
        const students = await prisma.student.findMany({
          where: { cohortId: cohort.id },
          select: { id: true, email: true, msUserId: true },
        });
        for (const student of students) {
          try {
            const userId = await resolveAndCacheMsId(prisma.student, student);
            if (!userId) {
              summary.peopleUnmatched++;
              note(`Student "${student.email}" has no matching Microsoft account — not added to "${cohortTeam.displayName}".`);
              continue;
            }
            await graph.addTeamMember({ groupId: cohortTeam.groupId, userId, owner: false });
            // Same reasoning as the owners loop above: only provably new on a
            // brand-new Team.
            if (justCreatedTeam) summary.membersAdded++;
          } catch (e) {
            note(`Adding "${student.email}" to "${cohortTeam.displayName}": ${e.message}`);
          }
        }
      } catch (e) {
        // One broken cohort (a Graph outage mid-Team-creation, a stuck provisioning
        // operation) must not stop every other cohort's provisioning from running.
        note(`Cohort "${cohort.name}": ${e.message}`);
      }
    }

    const finished = await prisma.teamsProvisionSync.update({
      where: { id: run.id },
      data: { status: "ok", finishedAt: new Date(), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
    });
    return { run: finished, summary, issues };
  } catch (e) {
    // `run` is undefined exactly when the create itself failed — see teamsSync.js's
    // own catch block for why there is then no row to mark failed.
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

module.exports = { runProvisioning, isRunning, sweepStaleRuns, teamNameFor, truncateName };
