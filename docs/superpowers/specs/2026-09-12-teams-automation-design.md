# Teams automation — meetings and class spaces from the timetable

**Date:** 12 September 2026
**Status:** approved in conversation 12 Sep 2026; builds ON TOP of
`2026-09-11-teams-auto-attendance-design.md` (shipped same day) and changes none of it.
**Two switches, independently selectable in Settings** — the user's explicit requirement:
a college may run either, both, or neither.

## What this is

The attendance feature reads what already happened in Teams. This adds the other
direction — the platform *writes into* Teams, from the timetable the college already
maintains:

- **Auto-meetings** (`autoCreateMeetings`, default off): a timetable event marked
  "online" gets its scheduled Teams meeting created automatically from a college
  organizer account, at the class's exact time, titled with the class name, teachers
  invited. The join link lands on the event and its registers through the exact fields
  the attendance feature already reads — no pasting, no calendar matching needed for
  these classes.
- **Class spaces** (`provisionTeams`, default off): one Team per cohort ("HND Business —
  SEP 25"), one channel per unit taught to it, teachers as owners, the cohort's students
  as members — all derived from the timetable and the student records, kept in sync by a
  scheduled job. The college confirmed every student holds a college Microsoft account,
  which is what makes membership sync possible at all.

## Decisions taken

**Two switches, not one.** The user asked to select each capability from Settings.
`TeamsAutomationConfig` (singleton, both defaults false) carries `autoCreateMeetings`
and `provisionTeams`. They are functionally independent: auto-meetings work with no
Team provisioned, and provisioned Teams are useful without auto-meetings. OFF means
nothing runs — the same ruling the attendance feature settled: no Graph writes, no
reconciliation, nothing, while a switch is off.

**One Team per cohort, one channel per unit.** Chosen by the user over per-unit and
per-course Teams. It matches how the timetable already groups classes
(`TimetableEventGroup` → cohort; events carry the unit), and a student lives in one
Team per course instead of ten.

**Publishing never blocks on Microsoft.** The attendance spec rejected coupling
timetable publishing to a network call, and creating meetings does not reopen that
door: publish marks intent (the checkbox + published state), and a scheduler job
reconciles — creates the meeting, patches it after a reschedule, cancels it after an
unpublish. The screen shows "meeting pending" until the job has run; a manual "Run now"
exists for the impatient.

**Reconciliation is by timestamps, not snapshots.** The job PATCHes the calendar event
when `TimetableEvent.updatedAt > teamsMeetingSyncedAt` — one stored timestamp instead
of a copied shadow of every field. An occasional no-op PATCH after an unrelated edit
(a note changed) costs one idempotent Graph call; a missed reschedule costs a class
meeting at the wrong time.

**A human's pasted link always wins.** If an event already carries a pasted
`teamsJoinUrl`, auto-creation skips that event entirely — the human said which meeting
this class is, and creating a second one would produce two meetings for one class. The
machine only cancels meetings it created (`teamsCalendarEventId` is the ownership
marker); it never touches a meeting a person scheduled.

**Provisioning is additive, never destructive.** The sync creates missing Teams,
channels and memberships and reports drift; it never removes a member, never deletes a
channel or a Team, and a finished cohort's Team is archived by a human, not the
machine. Same philosophy, same reason as the Moodle sync: an automated deleter that is
wrong once destroys a term of coursework conversations.

**Students and staff are matched by email, cached by id.** `Student.msUserId` already
exists from the attendance feature; `Staff.msUserId` joins it, same shape. Anyone who
cannot be matched is *reported on the run log, never guessed* — the standing rule.

**The join link reaches the channel by the channel's own email address.** Server
applications cannot post ordinary channel messages (Microsoft restricts
`ChannelMessage.Send` to signed-in users; the app-only variant exists only for
migrations), so the invite is addressed TO the channel's email as an attendee — the
invitation, with its Join button, arrives as a post in the right unit's channel. Some
tenants disable channel email; the run log says so per channel, and the student app
timetable remains the guaranteed route to the link either way.

**Which cohorts get a Team:** those with at least one published timetable event for one
of their groups. A cohort with no timetable yet gets nothing — provisioning follows the
timetable, and an empty Team for an unscheduled cohort is clutter that erodes trust in
the sync.

**Naming:** Team `"<course name> — <cohort name>"`; channel `"<unit code> — <unit
name>"`, both truncated to Graph's limits. Names are written once at creation; a
renamed course does NOT rename the Team (additive-only extends to names — a college may
have deliberately renamed the Team in Teams itself).

## Permissions, stated honestly

Phase A upgrades the organizer-mailbox calendar permission from `Calendars.Read` to
**`Calendars.ReadWrite`** — still scoped to only the organizer accounts by the existing
Exchange application access policy.

Phase B is the big ask and the setup guide says so in bold: **`Team.Create`**,
**`TeamMember.ReadWrite.All`**, **`Group.ReadWrite.All`**, **`User.Read.All`** are
tenant-wide application permissions. There is no Microsoft mechanism to scope Team
creation the way mailbox access is scoped. The guide presents this as the deliberate
trade the college's IT makes to get automated class spaces, not as fine print.

New non-secret provider setting: `creatorAccount` — which organizer account creates
meetings and initially owns provisioned Teams. Defaults to the first entry of
`organizerAccounts`.

## What gets added

- **Schema:** `TimetableEvent.teamsAutoMeeting Boolean @default(false)`,
  `TimetableEvent.teamsCalendarEventId String?`, `TimetableEvent.teamsMeetingSyncedAt
  DateTime?`; `Staff.msUserId String? @unique`; `CohortTeam` (cohortId unique →
  groupId/teamId, displayName, channel email cache per unit via `UnitChannel`
  (cohortTeam+unit unique → channelId, channelEmail)); `TeamsProvisionSync` run log
  (mirror of `TeamsSync`); `TeamsAutomationConfig` singleton. Every new model declared
  in the academic-scope guard (the lesson the attendance build taught).
- **Graph client:** write operations join `teamsGraph.js` — create/patch/cancel a
  calendar event (with `isOnlineMeeting`), create Team from the standard template,
  create channel, read a channel's email, add owner/member, resolve a user by email —
  all behind the same fixtures seam, which gains a **journal**: in fixture mode every
  write is appended to a JSON file so the smoke suite can assert exactly what would
  have been sent to Microsoft.
- **Engines:** `teamsMeetings.js` (Phase A reconciler) and `teamsProvisioning.js`
  (Phase B sync), each config-gated, each with its own run dedupe, both on the existing
  hourly scheduler plus manual run endpoints.
- **Client:** the timetable event form gains the "Online class — create the Teams
  meeting automatically" checkbox (series-aware, like `createRegisters`); the
  attendance-settings screen gains a "Teams automation" card: the two switches, Run-now
  buttons, run history with the unmatched/skipped lines.
- **Routes:** `/api/teams-automation/{settings,run-meetings,run-provisioning,runs}`,
  gated `requirePage("attendance-settings")` — same ruling as the attendance routes:
  the grant that opens the screen is the grant the API honours.
- **Docs:** `TEAMS_SETUP.md` gains the Phase A/B permission steps and the channel-email
  caveat; `API.md`, `STATUS.md`, `.env.example` updated.

## What can go wrong, and what happens

- Meeting creation fails (Graph down, permission missing) → the event stays "pending",
  the run log carries Microsoft's error verbatim, next tick retries. No half-created
  state: the calendar event id is stored only from a successful create.
- A class is unpublished after its meeting was created → the machine cancels the
  meeting it created. A class whose link was pasted is never touched.
- A student or teacher has no resolvable Microsoft account → named on the run log,
  membership continues for everyone else.
- Channel email disabled in the tenant → the invite simply has one less attendee; the
  run log notes it once per channel; students still get the link in the app.
- Both switches off → nothing runs, provably (the smoke suite asserts the refusal).

## Testing

Unit tests beside the pure logic (naming/truncation, the reconciliation decision —
create/patch/cancel/skip from event state + stored markers, cohort selection). A
`scripts/smoke-teams-automation.mjs` suite driving the real API with the fixtures
journal: checkbox → publish → job creates meeting (journal shows the create, event
carries the link, registers inherit it) → reschedule patches → unpublish cancels →
pasted-link event is skipped → provisioning creates Team/channels/memberships in the
journal → unmatched student reported → second run is a no-op (idempotence) → both
switches off refuse. Weighted toward refusals, as the house testing rule requires.
