# Teams Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independently-switchable automations: timetable events create their own
scheduled Teams meetings (link flowing into the existing attendance pipeline), and
cohorts get class Teams with per-unit channels, teachers as owners, students as members.

**Architecture:** Both automations are scheduler-driven reconcilers (publishing never
blocks on Microsoft). Phase A (`teamsMeetings.js`) reconciles published auto-meeting
events against calendar events it owns via `teamsCalendarEventId` +
`teamsMeetingSyncedAt`. Phase B (`teamsProvisioning.js`) additively syncs
CohortTeam/UnitChannel/memberships from the timetable. All Graph writes go through new
functions in `teamsGraph.js` behind the existing fixtures seam, extended with a WRITE
JOURNAL for the smoke suite.

**Tech Stack:** unchanged — Node 22 CommonJS server, plain fetch Graph client, Prisma,
React client.

**Spec:** `docs/superpowers/specs/2026-09-12-teams-automation-design.md` (this plan's
authority). The attendance feature it builds on:
`docs/superpowers/specs/2026-09-11-teams-auto-attendance-design.md` — CHANGE NOTHING
about its behaviour.

## Global Constraints

Identical to `docs/superpowers/plans/2026-09-12-teams-auto-attendance.md` §Global
Constraints (read them there: DATABASE_URL inline to local `edtech_dev`; migrations
raw-SQL forward-only `YYYYMMDDTHHMMSS_name`; never touch HndSession uniqueness; London
string dates; WHY-comments house style; unit tests via glob never bare directory;
commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; work on the
feature branch, never push). Plus, from this spec:

- **Both switches default `false`; OFF means nothing runs** (no Graph calls at all).
- **The machine only cancels meetings it created** (`teamsCalendarEventId` set); a
  pasted `teamsJoinUrl` on an event makes auto-creation SKIP that event.
- **Provisioning is additive-only**: never remove a member/channel/Team, never rename
  after creation.
- **Unmatched people are reported on the run log, never guessed.**
- **Every new Prisma model gets an explicit entry in
  `server/src/academicScopeModels.js`** — the guard test fails the build otherwise.
- New routes gated `requirePage("attendance-settings")` (the established ruling).

---

### Task 1: Schema + scope guard

**Files:**
- Modify: `server/prisma/schema.prisma`; Create:
  `server/prisma/migrations/20260912T150000_teams_automation/migration.sql`
- Modify: `server/src/academicScopeModels.js`

**Interfaces (produces):** `TimetableEvent.teamsAutoMeeting Boolean @default(false)`,
`TimetableEvent.teamsCalendarEventId String?`, `TimetableEvent.teamsMeetingSyncedAt
DateTime?`; `Staff.msUserId String? @unique` (mirror `Student.msUserId`, same comment
shape); models:

```prisma
// One provisioned class space per cohort. Additive-only: rows are created and
// updated by teamsProvisioning.js and never deleted by it — deleting the row would
// orphan the Team in Microsoft with nothing linking it back.
model CohortTeam {
  id           String    @id @default(cuid())
  cohort       Cohort    @relation(fields: [cohortId], references: [id], onDelete: Cascade)
  cohortId     String
  // Microsoft's group id (the Team's underlying group) — the handle every later
  // channel/membership call addresses.
  groupId      String
  displayName  String
  createdAt    DateTime  @default(now())
  lastSyncedAt DateTime?
  channels     UnitChannel[]
  @@unique([cohortId])
}

// One channel per unit inside a cohort's Team. channelEmail is cached because it is
// how the meeting invite reaches the channel (app-only cannot post messages), and
// null records "this tenant has channel email disabled" after one failed read —
// distinct from "never fetched", which is the empty string default's job.
model UnitChannel {
  id           String     @id @default(cuid())
  cohortTeam   CohortTeam @relation(fields: [cohortTeamId], references: [id], onDelete: Cascade)
  cohortTeamId String
  unit         Unit       @relation(fields: [unitId], references: [id], onDelete: Cascade)
  unitId       String
  channelId    String
  channelEmail String?
  createdAt    DateTime   @default(now())
  @@unique([cohortTeamId, unitId])
}

// Run log for both automations — `job` says which. Mirror of TeamsSync.
model TeamsProvisionSync {
  id         String    @id @default(cuid())
  job        String // "meetings" | "provisioning"
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  status     String    @default("running") // running | ok | failed
  mode       String    @default("manual") // manual | scheduled
  startedBy  String?
  summary    String    @default("{}")
  issues     String    @default("[]")
  error      String?
  @@index([startedAt])
}

model TeamsAutomationConfig {
  id        String   @id @default("singleton")
  settings  Json     @default("{}")
  updatedBy String?
  updatedAt DateTime @updatedAt
}
```

Add relation fields on `Cohort` (`teamsTeam CohortTeam?`) and `Unit`
(`teamsChannels UnitChannel[]`).

- [ ] **Step 1:** Schema edits above (house-style comments; `Staff.msUserId` mirrors
  the student one). Migration SQL to match — Prisma naming conventions for the unique
  indexes (`CohortTeam_cohortId_key`, `UnitChannel_cohortTeamId_unitId_key`,
  `Staff_msUserId_key`); `TeamsAutomationConfig` mirrors the
  `20260912T121500_teams_attendance_config` migration (JSONB, no default on
  updatedAt).
- [ ] **Step 2:** Declare in `academicScopeModels.js`: `CohortTeam: "UNSCOPED"`,
  `UnitChannel: "UNSCOPED"`, `TeamsProvisionSync: "UNSCOPED"`,
  `TeamsAutomationConfig: "UNSCOPED"` — beside the TeamsSync/TeamsAttendanceConfig
  entries added 12 Sep, with one-line WHYs in that section's style (provisioning
  metadata + config + run log; no per-student rows).
- [ ] **Step 3:** From `server/`, with inline local DATABASE_URL: `npx prisma migrate
  deploy` then `npx prisma generate`; then `node --test
  src/academicScopeModels.test.js` and `node --test
  src/timetabling/schema-contract.test.js` — both pass.
- [ ] **Step 4:** Commit.

---

### Task 2: Graph write operations + the fixtures journal

**Files:** Modify: `server/src/teamsGraph.js`

**Interfaces (produces — Tasks 5,6,9 consume verbatim):**
- `createClassMeeting({ organizerId, subject, date, startTime, endTime, attendeeEmails }) -> Promise<{ calendarEventId, joinUrl }>`
  — POST `/users/{organizerId}/events` with `isOnlineMeeting: true`,
  `onlineMeetingProvider: "teamsForBusiness"`, `start`/`end` as
  `{ dateTime: \`${date}T${startTime}:00\`, timeZone: ZONE }`, attendees mapped to
  `{ emailAddress: { address }, type: "required" }`. If the response lacks
  `onlineMeeting.joinUrl`, re-GET the event once (Teams populates it asynchronously);
  still missing → throw with a clear message.
- `updateClassMeeting({ organizerId, calendarEventId, subject, date, startTime, endTime, attendeeEmails }) -> Promise<void>` — PATCH the event.
- `cancelClassMeeting({ organizerId, calendarEventId }) -> Promise<void>` — DELETE the
  event; a 404 is success (already gone), every other error throws.
- `createTeam({ displayName, ownerUserId }) -> Promise<{ groupId }>` — POST `/teams`
  with `template@odata.bind` standard template and the owner bound; Graph answers 202
  with a `Location` header — poll the async operation (or GET the location) until the
  team id is available, bounded to ~5 tries with short waits; return the group id.
- `createChannel({ groupId, displayName }) -> Promise<{ channelId }>`;
  `getChannelEmail({ groupId, channelId }) -> Promise<string|null>` (GET the channel,
  return `email || null`);
- `addTeamMember({ groupId, userId, owner }) -> Promise<void>` — POST
  `/teams/{groupId}/members` with the `aadUserConversationMember` shape, roles
  `["owner"]` when owner; a 400/409 "already exists" is success — say why in a comment
  (additive sync re-adds constantly).
- `resolveUserId(email) -> Promise<string|null>` — GET `/users/{email}?$select=id`,
  404 → null.
- **Fixtures:** all of the above, in fixture mode, read canned results from the
  fixtures file (`users` {email:id}, `channelEmails` {channelId:email or null},
  fixed-id generators for created things: `"cal-" + subject slug`, `"team-" +
  displayName slug`, `"chan-" + displayName slug`, joinUrl
  `"https://teams.microsoft.com/l/meetup-join/fixture-" + slug`) AND append one line
  `{ op, args }` as JSON to the file named by `TEAMS_GRAPH_JOURNAL` (append-only;
  create if missing). The journal is how the smoke suite asserts writes without a
  tenant. Production guard: the existing `NODE_ENV === "production"` check in
  `fixtures()` already covers all of this — state that in a comment rather than
  duplicating the check.

- [ ] **Step 1:** Implement, following the file's established idioms (graphFetch,
  error surfacing, house comments — including WHY the create polls: Teams team
  creation is asynchronous on Microsoft's side).
- [ ] **Step 2:** `node -e "require('./src/teamsGraph.js')"` loads; commit.

---

### Task 3: `TeamsAutomationConfig` modules

**Files:** Create `server/src/teamsAutomationSettings.js`,
`server/src/teamsAutomationSettings.test.js`, `server/src/teamsAutomationConfig.js`

**Interfaces (produces):** `DEFAULTS = { autoCreateMeetings: false, provisionTeams:
false }`; `merge(patch, base)` allowlist/coercion; config module `get/save/invalidate`
on model `TeamsAutomationConfig`, TTL env `TEAMS_AUTOMATION_CACHE_MS`.

- [ ] **Step 1 (TDD):** tests first — defaults both false; patch merges without
  disturbing the neighbour switch; non-boolean values fall back to base; unknown keys
  dropped. Run, see them fail.
- [ ] **Step 2:** Implement both modules by transcribing
  `teamsAttendanceSettings.js`/`teamsAttendanceConfig.js` (which are themselves
  transcriptions of the attendanceTap pair — keep the lastConfirmed semantics; change
  names only). Tests green. Commit.

---

### Task 4: `creatorAccount` provider setting

**Files:** Modify `server/src/integrationConfig.js` (add `"creatorAccount"` to the
teams provider's `settingFields` + env `TEAMS_CREATOR_ACCOUNT`),
`client/src/IntegrationSettings.jsx` (a field in the teams form: label "Creator
account", hint "Which organizer account creates meetings and owns new class Teams.
Leave blank to use the first organizer account."), and `server/src/teamsGraph.js`: add
export `creatorEmail()` returning `cfg.peek("teams").creatorAccount?.trim() ||
ORGANIZERS()[0] || ""`, plus `resolveCreatorId()` (resolveOrganizers-style cached
lookup of that one account, fixture-aware via `users`).

- [ ] **Step 1:** Implement all three; load-check server files; commit.

---

### Task 5: Phase A engine — `teamsMeetings.js` + scheduler

**Files:** Create `server/src/teamsMeetings.js`; Modify `server/src/scheduler.js`

**Interfaces (produces):** `runMeetingsSync({ mode, startedBy })`, `isRunning()`,
`sweepStaleRuns()` — run rows in `TeamsProvisionSync` with `job: "meetings"`.

Core reconciliation (write this logic; the run/lock/summary scaffolding mirrors
`teamsSync.js` including the create-inside-try lesson its comments record):

```js
// Which published events want a meeting, and what to do for each. Window: today-1
// (cancellations of just-passed classes still land) to today+14 — creating further
// ahead adds nothing and widens every reconcile.
const events = await prisma.timetableEvent.findMany({
  where: { date: { gte: daysAgo(1), lte: daysAhead(14) } },
  include: { unit: { select: { code: true, name: true } },
             staff: { select: { staff: { select: { email: true } } } },
             groups: { select: { cohortId: true } } },
});
for (const ev of events) {
  const wants = ev.published && ev.teamsAutoMeeting;
  const pasted = (ev.teamsJoinUrl || "").trim() && !ev.teamsCalendarEventId;
  if (pasted) continue;              // a human's link wins; never create beside it
  if (!wants && !ev.teamsCalendarEventId) continue;      // nothing to do, nothing owned
  if (!wants && ev.teamsCalendarEventId) {
    // Unpublished (or the checkbox cleared) after we created — cancel OUR meeting.
    await graph.cancelClassMeeting({ organizerId, calendarEventId: ev.teamsCalendarEventId });
    await prisma.timetableEvent.update({ where: { id: ev.id },
      data: { teamsCalendarEventId: null, teamsMeetingSyncedAt: null, teamsJoinUrl: "" } });
    // The registers keep their carried-down URL cleared by the same update path the
    // paste-change reset uses: null out session teams fields for THIS event's
    // registers so attendance does not chase a cancelled meeting.
    await prisma.hndSession.updateMany({ where: { timetableEventId: ev.id },
      data: { teamsJoinUrl: null, teamsMeetingId: null, teamsOrganizerId: null } });
    summary.meetingsCancelled++; continue;
  }
  const title = ev.title || ev.unit?.name || ev.unit?.code || "Class";
  const attendees = [...new Set([...ev.staff.map((s) => s.staff.email), ...(await channelEmailsFor(ev))])].filter(Boolean);
  if (!ev.teamsCalendarEventId) {
    const { calendarEventId, joinUrl } = await graph.createClassMeeting({
      organizerId, subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees });
    await prisma.timetableEvent.update({ where: { id: ev.id },
      data: { teamsCalendarEventId: calendarEventId, teamsJoinUrl: joinUrl, teamsMeetingSyncedAt: new Date() } });
    // Carry to registers NOW (they exist — publishing built them): same fields the
    // paste path fills, so attendance needs nothing new.
    await prisma.hndSession.updateMany({ where: { timetableEventId: ev.id, teamsJoinUrl: null },
      data: { teamsJoinUrl: joinUrl, teamsOrganizerId: organizerId } });
    summary.meetingsCreated++;
  } else if (!ev.teamsMeetingSyncedAt || ev.updatedAt > ev.teamsMeetingSyncedAt) {
    await graph.updateClassMeeting({ organizerId, calendarEventId: ev.teamsCalendarEventId,
      subject: title, date: ev.date, startTime: ev.startTime, endTime: ev.endTime, attendeeEmails: attendees });
    await prisma.timetableEvent.update({ where: { id: ev.id }, data: { teamsMeetingSyncedAt: new Date() } });
    summary.meetingsUpdated++;
  }
}
```

`channelEmailsFor(ev)`: when the event has a unit and exactly-one-cohort group with a
`CohortTeam` + `UnitChannel` whose `channelEmail` is non-null → `[channelEmail]`, else
`[]` (Phase B may not be on; that is fine). Per-event errors are caught, noted with
the event's date/time/title, and the loop continues — one broken event must not stop
the college's other meetings.

- [ ] **Step 1:** Implement engine (scaffolding mirrored from `teamsSync.js`, WHY
  comments written out). Load-check.
- [ ] **Step 2:** Scheduler job `maybeRunTeamsMeetings()` mirroring
  `maybeSyncTeamsAttendance()` — gated on `teamsAutomationConfig.get()
  .autoCreateMeetings` AND `graph.isConfigured()` AND not running; 30-min dedupe on
  `TeamsProvisionSync` where `job:"meetings"`, `mode:"scheduled"`; its own statement
  + catch in `run()`; boot-log line extended (the log now names all four jobs — the
  final review flagged the last omission). Commit.

---

### Task 6: Phase B engine — `teamsProvisioning.js` + scheduler

**Files:** Create `server/src/teamsProvisioning.js`; Modify `server/src/scheduler.js`

**Interfaces (produces):** `runProvisioning({ mode, startedBy })`, `isRunning()`,
`sweepStaleRuns()` — run rows with `job: "provisioning"`.

Logic, in order, all additive, every miss reported not guessed:

1. Cohorts in scope: distinct cohorts appearing in `TimetableEventGroup` of PUBLISHED
   events. For each, resolve course name (`cohort.course` — check the actual relation;
   read `schema.prisma` for Cohort's course link and use what exists, else fall back
   to the cohort name alone).
2. Ensure `CohortTeam`: create via `graph.createTeam({ displayName: teamName,
   ownerUserId: creatorId })`, store row. Name truncation to 120 chars, pure helper.
3. Ensure channels: units taught to that cohort = distinct `unitId` of its published
   events (skip null); `graph.createChannel` per missing `UnitChannel`, then
   `getChannelEmail` once (store null when the tenant answers none — and never re-ask
   a stored null, that is the null's job).
4. Ensure owners: staff on those events, `Staff.msUserId` cached via
   `resolveUserId(email)` (P2002 swallow like the student path); `addTeamMember`
   owner:true.
5. Ensure members: the cohort's students, `Student.msUserId` reused/cached the same
   way; `addTeamMember` owner:false. Unmatched → issues + counter.
6. Summary counters: `teamsCreated, channelsCreated, ownersAdded, membersAdded,
   peopleUnmatched, channelEmailMissing`. "Added" counts only NEW adds where
   distinguishable; the already-exists success path counts nothing (comment why: an
   additive sync re-adds everyone every run — counting them as work would make every
   run look busy).

- [ ] **Step 1:** Implement + load-check.
- [ ] **Step 2:** `maybeRunTeamsProvisioning()` — same gating shape on
  `provisionTeams`, NIGHTLY like the Moodle sync (02:30 guard — provisioning touches
  the whole estate; hourly adds nothing) + always available manually. Wire + boot log.
  Commit.

---

### Task 7: Routes + settings card

**Files:** Create `server/src/routes/teamsAutomation.js`; Modify `server/src/index.js`
(mount beside teamsAttendance), `client/src/AdminNfcTags.jsx` (a "Teams automation"
card following the existing TeamsAttendance card's idiom exactly), `client/src/api.js`.

Routes (all `requireAuth, requirePage("attendance-settings")`, allowlist serialisers —
mirror `routes/teamsAttendance.js` including its sRun allowlist and its
`cfg.load("teams")` priming):
- `GET /settings` → `{ settings, configured, meetingsRunning, provisioningRunning }`
- `PUT /settings` → save `{ autoCreateMeetings?, provisionTeams? }`, audited
- `POST /run-meetings`, `POST /run-provisioning` → 409 when its switch is off ("…is
  switched off — turn it on first."), when unconfigured, or when running; else run and
  return `{ ok, summary, issues }`
- `GET /runs` → last 20 `TeamsProvisionSync` rows through an explicit allowlist
  (id, job, startedAt, finishedAt, status, mode, startedBy, summary, issues, error)

Card: two labelled toggles with one-line explanations (meetings: "Classes marked
online get their Teams meeting created automatically at the timetabled time";
provisioning: "Each cohort gets a class Team with a channel per unit, teachers as
owners, students as members"), two Run-now buttons, shared runs list showing `job` per
row.

- [ ] **Step 1:** Routes + mount; load-checks. **Step 2:** Client card + api helpers;
  `npm run --workspace client build` clean. Commit.

---

### Task 8: The timetable checkbox

**Files:** Modify `server/src/routes/timetabling.js` (accept boolean
`teamsAutoMeeting` on create/update exactly as `createRegisters` flows — find it and
mirror, including series creation), `server/src/timetabling/serialize.js` (add
`teamsAutoMeeting: !!e.teamsAutoMeeting` to `sEvent` beside `teamsJoinUrl`, comment
per the allowlist rule), `client/src/AdminTimetablePlanner.jsx` (checkbox "Online
class — create the Teams meeting automatically" beside the createRegisters control,
same idiom, in both the single-edit and series forms; hydrates on edit; submitted in
the payload).

- [ ] **Step 1:** Implement; `node --test src/timetabling/*.test.js` (glob the actual
  test files) passes; client build clean. Commit.

---

### Task 9: `scripts/smoke-teams-automation.mjs`

**Files:** Create the suite; it may add fixture keys but must not change
`teamsGraph.js` semantics beyond what Task 2 defined.

Mirror `smoke-teams-attendance.mjs`'s structure (own spawned API on a spare port ≠
4017, throwaway CREDENTIALS_KEY, `TEAMS_GRAPH_FIXTURES` + NEW `TEAMS_GRAPH_JOURNAL`
env, admin with both page grants, RUN-suffix seeding, scoped cleanup, SKIP=exit 2
discipline). Scenarios, refusal-weighted:

1. Both switches off (after credentials configured): `POST /run-meetings` and `POST
   /run-provisioning` both 409 `/switched off/i` — the ship-off proof.
2. Enable meetings only. Seed a published event (+7 days, checkbox on, one cohort
   group, unit, teacher) with registers. Run meetings → journal contains ONE
   `createClassMeeting` with the class title and London times; event has
   `teamsJoinUrl` (fixture URL) + `teamsCalendarEventId`; its register inherited the
   URL + organizerId.
3. Idempotence: run again → no new `createClassMeeting` in the journal.
4. Reschedule the event (change startTime via the API) → run → journal has ONE
   `updateClassMeeting`; no duplicate create.
5. Pasted-link event (teamsAutoMeeting on AND a pasted URL, no calendarEventId) → run
   → journal has NO create for it; its pasted URL unchanged.
6. Unpublish the created event → run → journal has `cancelClassMeeting`; event fields
   cleared; register teams fields nulled.
7. Enable provisioning. Run → journal has `createTeam` (name contains cohort name),
   `createChannel` per unit, owner add for the teacher, member adds for matched
   students; a student seeded with an email absent from fixtures `users` appears in
   issues and got no add; run row `job:"provisioning"`.
8. Provisioning idempotence: run again → no new `createTeam`/`createChannel` in the
   journal (member re-adds allowed — additive — but team/channel creation must not
   repeat; `CohortTeam`/`UnitChannel` rows exist once).
9. Cleanup verified; whole runner still green.

- [ ] **Step 1:** Write + run to green (inline local DATABASE_URL through the runner).
  **Step 2:** Full `npm test` sweep green. Commit.

---

### Task 10: Docs

**Files:** Modify `TEAMS_SETUP.md` (Phase A: Calendars.Read→**ReadWrite** upgrade
note; Phase B: the four tenant-wide permissions in bold with the spec's honest
framing; the channel-email caveat and how the run log reports it; creatorAccount);
`API.md` (the four new endpoints + the checkbox field on the timetable event
endpoints); `STATUS.md` (new subsection: what is demonstrated by
`smoke-teams-automation.mjs` vs code-read — count the suite's actual assertions);
`server/.env.example` (`TEAMS_CREATOR_ACCOUNT`, `TEAMS_GRAPH_JOURNAL` in the test-only
block beside TEAMS_GRAPH_FIXTURES).

- [ ] **Step 1:** Write all four; full sweep + client build one final time. Commit.

---

## Self-Review (planning time)

Spec coverage: two switches/OFF-nothing-runs (T3/T7/T9-1), publish-never-blocks +
reconcile by timestamp (T5), pasted-link-wins + machine-cancels-only-its-own (T5,
proven T9-5/6), Team-per-cohort/channel-per-unit/owners/members additive (T6, proven
T9-7/8), email→id cached both kinds (T6), channel email invite path + disabled-tenant
degrade (T2/T5/T6), permissions honesty (T10), scope-guard declarations (T1),
attendance feature untouched (no task edits teamsSync/teamsAttendance paths; T5
writes the same session fields the paste path owns, via updateMany fill/clear only).
Type consistency: `TeamsProvisionSync.job` values "meetings"/"provisioning" used in
T5/T6 dedupe and T7 serialiser; journal op names in T2 match T9's assertions
(`createClassMeeting`, `updateClassMeeting`, `cancelClassMeeting`, `createTeam`,
`createChannel`). Known judgement calls: cancel clears event.teamsJoinUrl AND register
teams fields (a cancelled meeting must not be attendance-collected); provisioning
nightly not hourly.
