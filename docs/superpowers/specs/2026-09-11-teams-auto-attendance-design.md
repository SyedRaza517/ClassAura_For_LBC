# Auto attendance from Microsoft Teams — design

**Date:** 11 September 2026
**Revised:** 12 September 2026 — the first version had ONE dedicated organizer account
("the ClassAura account") and an admin pasting every join link by hand. Both are
replaced: the college now runs **a small set of dedicated organizer accounts** and the
system **discovers their meetings automatically from those accounts' calendars**, with
the pasted link demoted to a rescue hatch for the rare meeting the matcher cannot place.
The old text is summarised where it changed rather than deleted, per the house rule.
**Status:** revised model approved in conversation 12 Sep 2026; implementation plan not
yet written.

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

## The two roles that make the whole design work

A Teams meeting distinguishes its **organizer** (the account that created it) from the
people who help run it (**co-organizers / owners**). Graph exposes a meeting's attendance
artifacts only through its *organizer* — being added to a meeting afterwards unlocks
nothing on the API side. The design leans on that split:

- **Organizer accounts** — a small set of dedicated, college-owned scheduling accounts
  (one, or one per department) that create *all* online class meetings. These are the
  accounts our app is permitted to read. Their emails are listed in Settings.
- **Teachers** — added to each meeting as co-organizer/owner. They start the class, share
  the screen, admit students, and can still take the register by hand. Their personal
  accounts and calendars are **never** read by this system.

## Decisions taken

**The meeting is created in Teams, not by the platform.** The alternative — the platform
creating meetings via Graph when a timetable event is published — was rejected for now
because it needs *write* permissions (`OnlineMeetings.ReadWrite.All`), and couples
timetable publishing to a network call to Microsoft. The chosen shape needs only *read*
permissions. The door to platform-created meetings stays open (see "Not in scope") and
nothing here forecloses it.

**Meetings are created by dedicated organizer accounts, listed in Settings — not by each
teacher, and not by one hardcoded account.** The first draft fixed a single "ClassAura"
account; the revision generalises it to a list, because a real college schedules by
department and one shared login for every scheduler is an operational bottleneck. The
constraint that earns the whole feature stays the same either way: because the organizer
accounts are a known, small, college-owned set, the Microsoft-side permissions (below)
are scoped to *exactly those accounts* — never to teaching staff at large. "Credentials"
here means email addresses only; no passwords are ever stored, because app-only Graph
access authenticates with the app registration's own secret, not with any user's.

**Meetings are discovered automatically from the organizer accounts' calendars.** The
first draft had an admin pasting every join link onto every timetable event; that is now
the fallback, not the flow. Graph refuses to enumerate `/users/{id}/onlineMeetings`
directly — the only filterable key is the join URL — but every *scheduled* meeting sits
on its organizer's calendar with its join URL attached, so "find all this organizer's
classes" is implemented as a `calendarView` read over the organizer accounts for the
relevant dates. Reading calendars was rejected in the first draft as "the most invasive
permission on offer" — that verdict was about reading *all teaching staff's personal
calendars*. Reading the calendars of a handful of dedicated scheduling accounts that
exist only to hold class meetings is a different proposition, and the Exchange
application access policy (setup, below) pins the permission to those mailboxes so it
cannot quietly mean more.

**Matching a discovered meeting to a timetable session is by organizer + date + start
time, with the title as tiebreak.** The organizer schedules the meeting at the class's
timetabled time, which they naturally would. Where one organizer account has two classes
at the same moment, the meeting title must contain the class/unit name and the matcher
uses it. A meeting the matcher still cannot place is *reported, never guessed* — it lands
on the sync log as unmatched, and an admin can paste that meeting's join link onto the
right timetable event, which is an exact, non-fuzzy link and always wins over matching.
Guessing was rejected for the same reason everywhere else in this codebase: a wrong
automatic match writes wrong marks onto a real student's record.

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

1. A departmental organizer account creates the class meeting in Teams at the class's
   timetabled time, titled with the class/unit name, and adds the teacher as
   co-organizer. Nothing else is asked of anyone.
2. The discovery job reads each listed organizer account's `calendarView` for the coming
   days, takes every event that carries a Teams join URL, and matches it to a published
   timetable session: same organizer's meeting, same date, same start time; title
   tiebreak when two collide. A confident match stores the join URL and organizer on the
   session. An unconfident one goes on the sync log for the paste-link rescue.
3. On first sight of a join URL (matched or pasted), the server resolves it to a stable
   meeting id — `GET /users/{organizerId}/onlineMeetings?$filter=JoinWebUrl eq '<url>'`
   — and stores the id on the session. Resolution failures (deleted meeting, wrong
   organizer) surface on the sync log, not silently.
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

**Schema** — five small changes, each with an in-codebase precedent:

- `TimetableEvent.teamsJoinUrl String?` — the rescue-hatch pasted link, on the planning
  object. An explicit paste always beats the matcher.
- `HndSession.teamsJoinUrl String?`, `HndSession.teamsMeetingId String?` and
  `HndSession.teamsOrganizerId String?` — the discovered (or pasted) link, the resolved
  meeting id, and the organizer account it belongs to, since every artifact fetch is
  addressed through the organizer. Precedent: `moodleSessionId`. The session's
  uniqueness is not touched — the two partial unique indexes Prisma cannot see
  (`schema.prisma:1181-1213`) stay exactly as they are.
- `Student.msUserId String? @unique` — the AAD object id, cached on first email match.
  Precedent: `moodleUserId`, for the same reason it gives — later syncs re-use the match
  instead of re-resolving by email every time.
- `model TeamsSync` — the run log: when, which sessions, how many marks written, how many
  participants unmatched, which meetings could not be matched to a session, errors.
  Precedent: `MoodleSync`.

**Credentials** — a new `teams` provider in `integrationConfig.js`, alongside `moodle`
and `sharepoint`, with its own `tenantId` / `clientId` / `clientSecret` and a new
non-secret setting `organizerAccounts` — the list of organizer emails, resolved once to
AAD user ids and cached. A separate provider row rather than piggybacking on
`sharepoint`, for the reason `integrationConfig.js` itself argues: a college may
legitimately hold two Microsoft app registrations with different permission grants, and
mixing them into one row means one Test button vouching for two unrelated capabilities.
Secrets are AES-256-GCM via `secrets.js`, which means **`CREDENTIALS_KEY` must be set in
the environment** — it is optional today and unset on the live server; the setup guide
and the Test button both say so loudly rather than failing obscurely.

**Graph client** — the token-acquisition and fetch pattern proven in `sharepoint.js`
(client-credentials grant against `login.microsoftonline.com`, plain `fetch`, no
`@azure/*` or MSAL dependency — that absence is deliberate and documented there),
instantiated for the `teams` provider's credentials. Three Graph operations: the
organizer `calendarView` read, the URL→meeting-id resolution, and the attendance-report
fetch.

**Config singleton** — `TeamsAttendanceConfig` via the `add-config-table` skill:
`enabled` (default **false**) and `minAttendancePct` (default 50). Lateness reuses the
existing `lateAfterMins` rather than growing a twin.

**Scheduler** — a `maybeSyncTeamsAttendance()` job in the existing scheduler, modelled on
`maybeSyncMoodle()`: config-gated, dedupe against `TeamsSync`, stale-run sweep. Two
sub-steps per run — discover/match upcoming meetings, then collect reports for ended
sessions. Unlike the Moodle sync it runs at every tick rather than a fixed hour, because
its work is "sessions that ended since last look", which is naturally incremental and
cheap when empty. Retries are inherent — a session with a meeting id and no marks is
simply still eligible next tick, with a bounded retry window — **7 days after the
session date** — so a meeting nobody joined does not poll forever, while a weekend
outage still self-heals on Monday.

**Capture method** — one line in the frozen map in `attendanceTap.js`:
`"Auto check-in (Teams)"` → `"teams"`, exactly as the comment there promises a new method
costs. The stamp string is frozen on arrival for the same reason the others are: it
crosses the wire to app builds that are not redeployed in step with the server.

**Audit** — accepted and refused marks logged to `TagTap` with method `"teams"`, new
outcome values added to the documented vocabulary in the schema comment, so "why is this
student marked absent for Tuesday?" has an answer in the tap log like every other method.

**Client** — the Teams row on the existing Integration Settings screen (credentials, the
organizer-accounts list, Test button); the config toggle and threshold on the attendance
settings; sync history and the unmatched-meetings list read from `TeamsSync`; the
rescue-hatch link field on the timetable event form. Registers render Teams marks with
their stamp exactly as they render NFC and QR marks today — no new register UI.

**Documentation** — `TEAMS_SETUP.md` beside `SHAREPOINT_SETUP.md`: the app registration;
the three application permissions (`Calendars.Read`, `OnlineMeetings.Read.All`,
`OnlineMeetingArtifact.Read.All`); admin consent; the **Teams application access policy**
(PowerShell) granting meeting-artifact access for the organizer accounts; and the
**Exchange application access policy** (`New-ApplicationAccessPolicy`) restricting
`Calendars.Read` to a mail-enabled security group containing exactly the organizer
accounts — without which the calendar permission is tenant-wide, which no college should
accept and none should be asked to. The two policy steps get particular care because
they are the ones with no portal UI and the ones everybody misses.

## What can go wrong, and what happens when it does

- **A class has no meeting** (in-person teaching, or the organizer never scheduled one) —
  the session works the old way: manual register, taps, scans. Nothing breaks, nothing
  nags.
- **The matcher can't place a meeting** (time moved, two classes at once with unhelpful
  titles) — it appears on the sync log as unmatched; an admin pastes the join link on the
  right class and the pipeline continues from there. No guess is ever written.
- **A link fails to resolve** (deleted meeting, wrong organizer) — recorded on the sync
  log with Microsoft's error text verbatim (the `sharepoint.js` habit); the session stays
  manual.
- **A student joins with a personal email** — no match, no mark, a named entry in the
  run's unmatched list for a human to resolve. Once resolved (the student's email
  corrected, or matched by hand), the next run marks them if the register row is still
  empty.
- **Report fetch fails** (permissions revoked, secret expired, Microsoft down) — the run
  records the failure, no marks are written, the session stays eligible for retry. Absent
  is only ever written on a *successful* fetch.
- **The meeting ran but attendance reports are disabled** in the tenant's Teams admin
  settings — surfaced by the Test button and in setup docs; the report simply isn't
  there to fetch, and the sync log says so.
- **A meeting is started ad hoc ("Meet now") instead of scheduled** — it never appears on
  the organizer's calendar, so it cannot be discovered; the paste rescue works if the
  link is captured, otherwise the register is manual. The setup guide tells organizers to
  schedule, not improvise.

## Not in scope, kept open

- **Platform-created meetings.** With the organizer accounts under the college's control
  and the `teams` provider already holding credentials, a later version can create the
  meeting at timetable-publish time (`OnlineMeetings.ReadWrite.All`) and eliminate even
  the scheduling step.
- **Teacher-calendar matching.** Rejected, not deferred: reading all staff calendars is
  an invasive grant, and the organizer-account model makes it unnecessary.
- **Zoom.** The presence spec says "Teams/Zoom"; Zoom is a different API and a different
  provider row, and nothing here assumes Microsoft beyond the `teams` provider module.
- **Live in-meeting presence** (who is in the call right now, on the live register
  screen). Possible with change notifications; deliberately out until someone asks.

## Testing

Pure logic beside its code, per `testing.md`: the join-URL parser; the calendar-event →
session matcher (exact match, title tiebreak, the two-classes-same-time collision, the
must-not-guess refusal); the interval-clipping and P/L/A decision (fed synthetic
join/leave records — boundary cases at exactly the threshold, joins spanning the start,
double joins, joins entirely outside the window); and the email→student matcher. None of
it touches the network.

A `scripts/smoke-teams-attendance.mjs` suite mirroring `smoke-qr-checkin.mjs`, with the
Graph layer faked at the module boundary (the test runner has no Microsoft tenant, and
the suite must SKIP loudly, not pass vacuously, if the feature is off). It proves the
whole pipeline against the seeded fixtures: organizer calendar (fake) → matched to
session → resolved id → fetched (fake) report → correct P/L/A written → lecturer's
existing mark untouched → unmatched participant reported → ambiguous meeting NOT matched
→ pasted link overrides the matcher → failed fetch writes nothing. Weighted toward
refusals, as the testing rule requires: the suite's most valuable assertions are the
marks and matches it proves were *not* made.

All of it runs against the local `edtech_dev` database with `DATABASE_URL` passed inline,
per `database-safety.md`.
