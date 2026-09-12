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
 * `note` is the caller's issue-recorder — passed in, not read off a shared closure,
 * because this function is called for both staff and students from two different
 * loops and has no run of its own to remember one.
 *
 * The P2002 catch matters for the same reason it does in teamsSync.js:215 — two
 * people legitimately sharing one Microsoft account (a shared demo login, a data
 * error) must not crash the run. It previously stopped there with a comment
 * claiming the caller reports the case, which was never true: the exception was
 * simply swallowed and nothing downstream ever saw it. `note()` is now called
 * directly here, matching teamsSync.js's own wording for the identical collision,
 * so the run log actually carries the same fact the comment always claimed it did.
 * The id Graph just resolved is still returned and still usable for THIS run's
 * addTeamMember call even though it could not be cached for next time.
 */
async function resolveAndCacheMsId(delegate, person, note) {
  if (person.msUserId) return person.msUserId;
  const id = await graph.resolveUserId(person.email);
  if (!id) return null;
  try {
    await delegate.update({ where: { id: person.id }, data: { msUserId: id } });
  } catch (e) {
    if (e?.code !== "P2002") throw e;
    note(`Microsoft account "${person.email}" appears to belong to two people — id not cached.`);
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
  // must not ask Graph the same question ten times. `undefined` means "not yet
  // asked"; `null` is a real, cached answer of "no creator account", distinct from
  // never having asked — the same null-means-checked shape UnitChannel.channelEmail
  // uses below. Memoizing the RESOLUTION here only stops the repeated Graph call —
  // it says nothing about how many times the cohort loop below reports the miss, so
  // `creatorMissingNoted` (declared right after it) is what actually keeps that to
  // once per run rather than once per cohort lacking a Team.
  let creatorId;
  async function getCreatorId() {
    if (creatorId === undefined) creatorId = await graph.resolveCreatorId();
    return creatorId;
  }
  let creatorMissingNoted = false;

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
            // Noted ONCE per run, not once per cohort missing a Team — a college
            // with no creator account configured and fifty un-provisioned cohorts
            // does not need the identical sentence fifty times in its run log to
            // understand the one thing that is actually wrong.
            if (!creatorMissingNoted) {
              note("No Teams creator account is configured — no new Teams were provisioned this run.");
              creatorMissingNoted = true;
            }
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
        const existingChannelsByUnitId = new Map((cohortTeam.channels || []).map((c) => [c.unitId, c]));
        for (const { unitId } of taughtUnits) {
          const existing = existingChannelsByUnitId.get(unitId);
          if (existing) {
            // The channel row already exists. channelEmail === "" is the schema's
            // "never fetched" state (its own default, restored by the
            // 20260912T160000 migration) — distinct from a stored `null`, which
            // means the email WAS asked for and this tenant has none. Only the
            // never-fetched case is worth asking again; a confirmed null is not
            // re-asked, exactly as the comment beside the create branch below
            // already promises.
            if (existing.channelEmail === "") {
              try {
                const channelEmail = await graph.getChannelEmail({ groupId: cohortTeam.groupId, channelId: existing.channelId });
                await prisma.unitChannel.update({ where: { id: existing.id }, data: { channelEmail: channelEmail ?? null } });
                if (channelEmail === null) summary.channelEmailMissing++;
              } catch (e) {
                note(`Channel email retry for unit ${unitId} in "${cohortTeam.displayName}": ${e.message}`);
              }
            }
            continue; // never re-ask a channel that already exists
          }
          try {
            const unit = await prisma.unit.findUnique({ where: { id: unitId }, select: { code: true, name: true } });
            const displayName = truncateName(unit?.name || unit?.code || "Unit", MAX_CHANNEL_NAME);
            const { channelId } = await graph.createChannel({ groupId: cohortTeam.groupId, displayName });
            // Written IMMEDIATELY, with channelEmail left at its "" (never fetched)
            // default, rather than after the getChannelEmail call below. The
            // channel already exists in Microsoft the instant createChannel
            // returns; if the process died, or getChannelEmail threw, between here
            // and a combined create+email write, this row would never exist and a
            // LATER run would see no UnitChannel for this unit and create a SECOND
            // channel — the first one left live in Teams with nothing in this
            // database ever pointing at it again (there is no "list channels and
            // reconcile" pass; UnitChannel rows ARE this sync's only memory of what
            // it already made). Splitting the write in two means a crash after this
            // line still leaves a row a later run recognises and merely retries the
            // email fetch for (the branch above), never a duplicate channel.
            const created = await prisma.unitChannel.create({
              data: { cohortTeamId: cohortTeam.id, unitId, channelId },
            });
            summary.channelsCreated++;
            try {
              // A null answer is stored as null (not left at ""): it means "this
              // tenant has channel email disabled", and re-asking a stored null on
              // every future run would just spend a Graph call re-learning a fact
              // this run already learned for good.
              const channelEmail = await graph.getChannelEmail({ groupId: cohortTeam.groupId, channelId });
              await prisma.unitChannel.update({ where: { id: created.id }, data: { channelEmail: channelEmail ?? null } });
              if (channelEmail === null) summary.channelEmailMissing++;
            } catch (e) {
              // The channel itself is safely recorded above; only the email lookup
              // failed. channelEmail stays at its "" default, so the branch above
              // retries JUST the email on a later run — not the whole channel.
              note(`Channel email for unit ${unitId} in "${cohortTeam.displayName}": ${e.message}`);
            }
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
            const userId = await resolveAndCacheMsId(prisma.staff, staff, note);
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
            const userId = await resolveAndCacheMsId(prisma.student, student, note);
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
