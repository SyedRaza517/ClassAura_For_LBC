# Auto attendance from Microsoft Teams — design

**Date:** 11 September 2026
**Status:** approved in conversation 11 Sep 2026; implementation plan not yet written.

## What this is

The fifth way to fill a register, and the first that no human triggers. Today a mark
reaches `AttendanceMark` four ways: a lecturer saves the register, a student taps an NFC
sticker, a student scans a rotating QR code, or a student presses "I'm here". All four
require somebody to *do something at the time of the class*. For online teaching that is
exactly the step that gets forgotten — the lecturer is busy delivering the session inside
Teams, and the register stays empty.

Microsoft already keeps the register. Every Teams meeting records, per participant, who
joined, when they joined, when they left, and total attendance time. This design pulls
that record through Microsoft Graph after the class ends and writes the marks itself.

The presence-verification spec (`2026-09-10-presence-verification-design.md`) anticipated
this subsystem by name: online attendance was the reason "I'm here" existed, and gating
"I'm here" behind campus-presence checks was only defensible because online attendance
would arrive from Teams instead. This is that arrival.

## Decisions taken

**The meeting is created in Teams, not by the platform.** The alternative — the platform
creating meetings via Graph when a timetable event is published — was rejected for now
because it needs *write* permissions (`OnlineMeetings.ReadWrite.All`), forces every
lecturer onto platform-generated links on day one, and couples timetable publishing to a
network call to Microsoft. The chosen shape needs only *read* permissions and changes
nobody's scheduling habits. The door to platform-created meetings stays open (see "Not in
scope") and nothing here forecloses it.

**One dedicated organizer account, set in Settings.** The college admin creates every
class meeting from a single account (the "ClassAura" account) and adds the teacher as
co-organizer/presenter. This was the user's own suggestion, refined: Graph exposes a
meeting's attendance artifacts only through its *organizer*, so being added to a meeting
afterwards unlocks nothing — the account must be the creator. The payoff for that
discipline is large: Microsoft's application access policy (the one-time IT setup that
authorises app-only access to a user's meetings) needs to cover exactly one account
instead of the whole teaching staff, and every Graph lookup addresses one known user id.
The organizer account's email/id is a Settings field, not code.

**The link between a meeting and a register is a pasted URL.** The admin pastes the Teams
join link into the timetable event when building the timetable. Two alternatives were
rejected. *Matching by lecturer calendars* needs `Calendars.Read` over all staff — the
most invasive permission on offer — and fuzzy time-overlap matching that picks the wrong
meeting on a busy calendar. *Listing all the organizer's meetings and matching by time*
is not even possible: Graph refuses to enumerate `/users/{id}/onlineMeetings` without a
filter on the join URL or join id; the URL is the lookup key, so somebody has to supply
it. Reading the ClassAura account's *calendar* to harvest links automatically would work
and is deliberately deferred, not rejected — it is the natural second version, and it
only makes sense once this version has proven the pipeline.

**Marks are written automatically, with no confirmation step.** "Suggest, then a teacher
confirms" was rejected because it converts an automation into a daily chore, and an
unconfirmed register is an empty register — the failure mode this feature exists to
remove. The safety valve is the same one every machine writer here already honours: a
mark made by a person is never overwritten, and a person can overwrite a machine's mark
at any time.

**Present requires a minimum share of the class, configurable, default 50%.** "Joined at
all counts as Present" was rejected because a student can join for one minute of a
two-hour class; a college defending its figures at audit needs a rule with a number in
it. The number is configurable because colleges differ, and hard-coding it would mean a
code change per college opinion. Attendance share is measured against the *timetabled*
session length (`startTime`→`endTime`), not the meeting's actual length — a lecturer
running twenty minutes over must not retroactively turn Present students Absent.

**Unmatched participants are reported, never guessed.** A participant whose email matches
no student produces a note on the sync run, not a mark. And a rostered student who never
joined is marked Absent *only when the session had a linked meeting and the report was
successfully fetched* — if the fetch failed, nobody is marked anything. Null means "not
measurable" in this codebase; a machine writing A because it couldn't see is exactly the
zero-coercion bug the conventions file warns about.

**Ships switched off.** Every automatic writer in this codebase arrives behind its own
boolean defaulting `false` (NFC tap, attendance emails, the prediction schedulers), and
this one is no exception. A college turns it on in Settings after IT has completed the
Graph setup and the Test button passes.

## The flow, end to end

1. Admin creates the meeting in Teams from the ClassAura account, adds the teacher as
   co-organizer, copies the join link.
2. Admin pastes the link into the **Teams meeting link** field on the timetable event.
   Publishing the event carries the link down to each generated `HndSession`, exactly as
   rooms and times already carry down.
3. On first sight of a link, the server resolves it to a stable meeting id:
   `GET /users/{organizerId}/onlineMeetings?$filter=JoinWebUrl eq '<url>'`, and stores
   the id on the session. Resolution failures (bad paste, meeting deleted, wrong
   organizer account) surface on the sync log and in Settings, not silently.
4. A poller inside the existing scheduler notices sessions whose `endTime` has passed,
   whose meeting id is set, and whose Teams marks have not yet been written. For each, it
   fetches `GET /users/{organizerId}/onlineMeetings/{id}/attendanceReports` and the
   report's `attendanceRecords`.
5. Each record carries the participant's email, AAD user id, and join/leave intervals.
   Records are matched to students by email; a successful match caches the AAD id on the
   student so subsequent syncs match by id even if the email later changes.
6. Marks are computed (rules below) for every student on `rosterForSession(session)` and
   written with `takenBy: "Auto check-in (Teams)"`, skipping any student who already has
   a mark. The run is recorded in `TeamsSync`; each written or refused mark is logged to
   `TagTap` with method `"teams"`.

Polling, not Graph change-notification webhooks. Webhooks need a public, validated push
endpoint, subscription renewal every ~3 days, and reconciliation for missed pushes — all
to learn slightly sooner something the poller learns within its interval anyway. Every
existing sync here polls; attendance reports also lag the meeting's end by a few minutes
on Microsoft's side, so "live" was never on offer.

## The marking rules

For each rostered student, with `sessionMinutes = endTime − startTime` and
`attended =` the sum of that participant's join/leave intervals *clipped to the session
window* (minutes in the meeting before `startTime` or after `endTime` count for nothing):

- `attended ≥ minAttendancePct × sessionMinutes` and first join before
  `startTime + lateAfterMins` → **P**.
- `attended ≥ minAttendancePct × sessionMinutes` but first join after the late cut-off
  → **L**. `lateAfterMins` is the existing tap setting; the same lateness rule applies
  whether a student walked into a room or clicked a link.
- Joined but `attended` below the threshold → **A**, with a remark recording the actual
  minutes so a lecturer reviewing the register sees *why* ("Joined 11 of 90 min").
- On the roster, report fetched, never joined → **A**.
- Already has a mark (from a lecturer, a tap, a scan, a declaration, or a previous run)
  → untouched, always.

`minAttendancePct` defaults to 50 and lives in the new config singleton.

All the standing invariants of the other write paths hold: never a future session, term
lock respected, roster from `rosterForSession()` (enrolment *or* cohort — never enrolment
alone), times as London wall-clock strings via `clock.js`.

## What gets added

**Schema** — four small changes, each with an in-codebase precedent:

- `TimetableEvent.teamsJoinUrl String?` — the pasted link, on the planning object.
- `HndSession.teamsJoinUrl String?` and `HndSession.teamsMeetingId String?` — carried
  down at publish; the meeting id cached after resolution. Precedent: `moodleSessionId`.
  The session's uniqueness is not touched — the two partial unique indexes Prisma cannot
  see (`schema.prisma:1181-1213`) stay exactly as they are.
- `Student.msUserId String? @unique` — the AAD object id, cached on first email match.
  Precedent: `moodleUserId`, for the same reason it gives — later syncs re-use the match
  instead of re-resolving by email every time.
- `model TeamsSync` — the run log: when, which sessions, how many marks written, how many
  participants unmatched, errors. Precedent: `MoodleSync`.

**Credentials** — a new `teams` provider in `integrationConfig.js`, alongside `moodle`
and `sharepoint`, with its own `tenantId` / `clientId` / `clientSecret` and a new
non-secret setting `organizerUser` (the ClassAura account's email or AAD id). A separate
provider row rather than piggybacking on `sharepoint`, for the reason
`integrationConfig.js` itself argues: a college may legitimately hold two Microsoft app
registrations with different permission grants, and mixing them into one row means one
Test button vouching for two unrelated capabilities. Secrets are AES-256-GCM via
`secrets.js`, which means **`CREDENTIALS_KEY` must be set in the environment** — it is
optional today and unset on the live server; the setup guide and the Test button both say
so loudly rather than failing obscurely.

**Graph client** — the token-acquisition and fetch pattern proven in `sharepoint.js`
(client-credentials grant against `login.microsoftonline.com`, plain `fetch`, no
`@azure/*` or MSAL dependency — that absence is deliberate and documented there),
instantiated for the `teams` provider's credentials. Two Graph operations: the
URL→meeting-id resolution and the attendance-report fetch.

**Config singleton** — `TeamsAttendanceConfig` via the `add-config-table` skill:
`enabled` (default **false**) and `minAttendancePct` (default 50). Lateness reuses the
existing `lateAfterMins` rather than growing a twin.

**Scheduler** — a `maybeSyncTeamsAttendance()` job in the existing scheduler, modelled on
`maybeSyncMoodle()`: config-gated, dedupe against `TeamsSync`, stale-run sweep. Unlike
the Moodle sync it runs at every tick rather than a fixed hour, because its work is
"sessions that ended since last look", which is naturally incremental and cheap when
empty. Retries are inherent — a session with a meeting id and no marks is simply still
eligible next tick, with a bounded retry window — **7 days after the session date** —
so a meeting nobody joined does not poll forever, while a weekend outage still
self-heals on Monday.

**Capture method** — one line in the frozen map in `attendanceTap.js`:
`"Auto check-in (Teams)"` → `"teams"`, exactly as the comment there promises a new method
costs. The stamp string is frozen on arrival for the same reason the others are: it
crosses the wire to app builds that are not redeployed in step with the server.

**Audit** — accepted and refused marks logged to `TagTap` with method `"teams"`, new
outcome values added to the documented vocabulary in the schema comment, so "why is this
student marked absent for Tuesday?" has an answer in the tap log like every other method.

**Client** — the link field on the timetable event form; the Teams row on the existing
Integration Settings screen (credentials, organizer account, Test button); the config
toggle and threshold on the attendance settings; sync history read from `TeamsSync`.
Registers render Teams marks with their stamp exactly as they render NFC and QR marks
today — no new register UI.

**Documentation** — `TEAMS_SETUP.md` beside `SHAREPOINT_SETUP.md`: the app registration,
the two application permissions (`OnlineMeetings.Read.All`,
`OnlineMeetingArtifact.Read.All`), admin consent, and the Teams PowerShell application
access policy granted to the ClassAura account. The policy step gets particular care
because it is the one with no Azure-portal UI and the one everybody misses.

## What can go wrong, and what happens when it does

- **No link pasted** — the session works the old way: manual register, taps, scans.
  Nothing breaks, nothing nags.
- **Link fails to resolve** — recorded on the sync log with Microsoft's error text
  verbatim (the `sharepoint.js` habit); the session stays manual.
- **Student joins with a personal email** — no match, no mark, a named entry in the run's
  unmatched list for a human to resolve. Once resolved (the student's email corrected, or
  matched by hand), the next run marks them if the register row is still empty.
- **Report fetch fails** (permissions revoked, secret expired, Microsoft down) — the run
  records the failure, no marks are written, the session stays eligible for retry. Absent
  is only ever written on a *successful* fetch.
- **The meeting ran but attendance reports are disabled** in the tenant's Teams admin
  settings — surfaced by the Test button and in setup docs; the report simply isn't
  there to fetch, and the sync log says so.

## Not in scope, kept open

- **Platform-created meetings.** With the ClassAura account under the college's control
  and its credentials already in the `teams` provider, a later version can create the
  meeting at timetable-publish time (`OnlineMeetings.ReadWrite.All`) and eliminate the
  paste entirely.
- **Calendar harvesting.** Reading the ClassAura account's calendar to pick up join links
  automatically — one account, one `Calendars.Read` grant, none of the all-staff
  invasiveness that killed the general version of this idea.
- **Zoom.** The presence spec says "Teams/Zoom"; Zoom is a different API and a different
  provider row, and nothing here assumes Microsoft beyond the `teams` provider module.
- **Live in-meeting presence** (who is in the call right now, on the live register
  screen). Possible with change notifications; deliberately out until someone asks.

## Testing

Pure logic beside its code, per `testing.md`: the join-URL parser, the interval-clipping
and P/L/A decision (fed synthetic join/leave records — boundary cases at exactly the
threshold, joins spanning the start, double joins, joins entirely outside the window),
and the email→student matcher. None of it touches the network.

A `scripts/smoke-teams-attendance.mjs` suite mirroring `smoke-qr-checkin.mjs`, with the
Graph layer faked at the module boundary (the test runner has no Microsoft tenant, and
the suite must SKIP loudly, not pass vacuously, if the feature is off). It proves the
whole pipeline against the seeded fixtures: link on event → carried to session → resolved
id → fetched (fake) report → correct P/L/A written → lecturer's existing mark untouched →
unmatched participant reported → failed fetch writes nothing. Weighted toward refusals,
as the testing rule requires: the suite's most valuable assertions are the marks it
proves were *not* written.

All of it runs against the local `edtech_dev` database with `DATABASE_URL` passed inline,
per `database-safety.md`.
