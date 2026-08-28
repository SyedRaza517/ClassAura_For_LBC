# NFC tap check-in — students and staff

*Design, 28 Aug 2026. Status: awaiting review. Nothing here is built yet.*

A sticker on the classroom wall. The app is open and already signed in, and the
**Check in** button is greyed out. Touching the sticker switches it on. One press and the
register has them, with the minute they arrived.

The same sticker works for staff: tap, choose **Onsite** or **Online**, clocked in.

`STATUS.md` remains the map of what is actually built. This is not a claim that any of
it exists.

---

## 1. What already exists, and what this must not disturb

Attendance is a chain of four models:

    Unit ──< HndSession ──< AttendanceMark >── Student
                                                  │
    Unit ──────< Enrolment >──────────────────────┘

- `HndSession` is one timetabled class: `unitId` + `date` + `startTime`, unique together.
- `AttendanceMark` is one student's mark for one session — `P` | `L` | `E` | `A`.
- `Enrolment` is what makes a student eligible for a unit's registers at all.
- `Unit.tutorStaffId` names the lecturer, which is how the dashboard in §7 finds a
  lecturer's own sessions.

The arithmetic in `server/src/attendance.js` — P=2, L=1, E=1, A=0,
`pct = earned / (2 × marked)`, unmarked sessions excluded from the denominator — is
**not changed by this feature**. A tap produces an ordinary `P` or `L` and the existing
maths consumes it unchanged.

Staff attendance is a separate model entirely: `CheckIn`, one row per staff member per
day, `timeIn` / `timeOut` as `HH:MM` strings and an optional `site`. Conflating the two is
the easiest mistake to make in this area, so this document keeps them in separate
sections and never shares a code path between them beyond reading the tag.

Today exactly two things write an `AttendanceMark`: a member of staff saving a register
(`PUT /api/hnd/sessions/:id/register`), and the Moodle importer, which stamps
`takenBy: "Moodle import"` and never overwrites an existing mark. This feature adds a
third writer and inherits that invariant.

### Rules this feature is bound by

| Rule | How it binds this feature |
|---|---|
| A query with no tenant context throws (`db.js`) | Every tap arrives on an authenticated session carrying `tid`, so the tenant is resolved by the normal middleware. No `crossTenant` anywhere in this feature |
| Null means "not measurable", zero means zero | `checkedInAt` is NULL when nobody tapped. A refused tap has no student and no session; both columns nullable |
| Dates are strings, `YYYY-MM-DD`; times `HH:MM` | Session matching and `checkedInAt` use `localDate()` / `localTime()` from `clock.js` — never the host clock |
| Serialise through allowlists | `sMark` gains `checkedInAt` explicitly, or it does not reach the client |
| Rate limiters are in-process `Map`s | The new limiter carries the same "needs Redis if clustered" comment as its neighbours |
| Never rename an applied migration | One migration, named once. P3009 has cost this project two outages |
| `ADMIN_PAGES` exists twice | The new page goes into `validate.js` **and** `StaffHub.jsx` in one commit |

---

## 2. The student flow

```
  app open, already signed in
        │
        ▼
  [ Check in ]   ← greyed out
        │
        │  touch the sticker
        ▼
  the app reads the tag's secret          Android: silent, reader mode
  and arms the button for 60 seconds      iPhone:  Apple's scan sheet first
        │
        ▼
  [ Check in ]   ← live
        │  student presses
        ▼
  POST /api/student/me/tap-check-in  { tagCode }
        │
        ├── which session?  today's, on a unit they're enrolled on,
        │                   whose start–end window contains now
        │
        ├── may it be written?  term open, no existing mark
        │
        ▼
  AttendanceMark  P (or L past the late threshold)
  checkedInAt     "09:07"
  takenBy         "Self check-in (NFC)"
        │
        ▼
  "Marked present — Leadership and Management, 09:00–12:00, at 09:07"
```

**The tag holds an opaque secret, not a URL.** Because our own app reads it, there is no
reason for the sticker to carry a working web address. Someone tapping it with a generic
NFC reader app gets a meaningless string rather than a link they could save and fire from
home. This is why plain, pennies-each NTAG213 stickers are sufficient — the argument for
cryptographic tags was entirely about a readable URL, and there is not one.

**No email, no password, no device token.** The app is already signed in; that session is
the identity. The earlier design's device-binding machinery existed only to work around a
browser having no session, and it is gone.

**The endpoint lives under `/api/student`**, which is already in `STUDENT_ROUTERS`
(`auth.js:39`). Nothing about the student portal's isolation changes, and no new public
router is introduced.

**One tag serves both students and staff.** The server branches on who is signed in, not
on which sticker was touched, so a college prints one sticker per room rather than two.

---

## 3. When a tap is accepted

**Taps are accepted whenever the lecture is running, and at no other time.** There is no
button for a lecturer to press. A tap before the session starts is refused; so is a tap
after it ends.

```js
// candidates: today's sessions on units this student is enrolled on
// now:        { date: "2026-09-01", time: "09:07" }  ← clock.js, never the host clock

resolveTapSession(candidates, now, { lateAfterMins, earlyGraceMins })
  // → { kind: "one",       session, status: "P" | "L" }
  // → { kind: "ambiguous", sessions: [...] }
  // → { kind: "none",      reason: "no_session_now" | "term_locked" }
```

1. Keep sessions dated today whose unit the student is enrolled on. Enrolment is what
   makes a student eligible for a register at all, and taking candidates from `Enrolment`
   means a tap can never attach a student to a unit they were never on — the same reason
   `hnd.js:1091` checks enrolment rather than mere existence.
2. Keep those where `startTime − earlyGraceMins ≤ now ≤ endTime`.
3. Zero → refused, naming the next session of theirs if there is one today. One → marked.
   Two or more → the app lists them and the student picks; the choice returns as
   `sessionId`.
4. `P` if `now ≤ startTime + lateAfterMins`, otherwise `L`.

Times are zero-padded `HH:MM` strings, so a plain string compare sorts chronologically —
the convention already used throughout `checkins.js` and `hnd.js`.

**`earlyGraceMins` defaults to `0`**, which is the rule as asked for: not before the
lecture. It exists as a setting because a student standing outside the door at 08:58 for a
09:00 class is a normal thing that will be reported as a bug in week one, and a college
that decides five minutes is fine should not need a deploy to say so.

**A tap never marks anyone absent.** There is no path from this feature to an `A`.
Absence is what an untaken register already means, and `attendance.js` excludes unmarked
sessions from the denominator on purpose. Writing `A` for "did not tap" would convert a
flat battery, a forgotten phone or a handset with no NFC into a permanent academic
record — most often for the students least able to argue about it. §7 covers how a
lecturer records real absence.

### What was dropped, and what it cost

An earlier draft had the lecturer open a ten-minute window before taps were accepted. That
is gone: the session's own times are the window, and nothing needs pressing.

Worth recording once, because it is the trade: **the lecturer's press was the human
attestation.** Without it, a mark is the student's own assertion that they were present,
and a student who tapped from the corridor — or from home, if they are on the college
network — produces a mark nobody witnessed. What replaces it is §7: the lecturer sees the
whole thing live, with times, and can correct any of it. That is supervision after the
fact rather than consent before it. It is a real reduction in how defensible a single
mark is, and it is the right call only because the alternative — a press per session,
forever — is the kind of friction that gets a feature switched off.

---

## 4. Schema

Three new models, two new columns. All additive. Nothing on `StudentPredictionCurrent` /
`StudentPredictionHistory` is touched, so `schema-contract.test.js` is unaffected.

### `AttendanceTag` — a registered sticker

```prisma
model AttendanceTag {
  id        String    @id @default(cuid())
  // The secret written onto the sticker. Opaque and random — NOT a URL, because our own
  // app reads it, so there is nothing to gain from it being clickable and a lot to lose:
  // a readable link is one a student can save and replay from anywhere. Globally unique
  // so a tap can be resolved without first knowing the college.
  code      String    @unique
  label     String                       // "Room 101", "Reception"
  active    Boolean   @default(true)     // deactivate a peeled-off or lost sticker
  lastTapAt DateTime?                    // NULL until first use — never a zero date
  createdAt DateTime  @default(now())
  createdBy String?
  taps      TagTap[]

  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}
```

### `TagTap` — the log, for students and staff alike

```prisma
model TagTap {
  id        String   @id @default(cuid())
  tag       AttendanceTag @relation(fields: [tagId], references: [id], onDelete: Cascade)
  tagId     String
  // Exactly one of these is set on an accepted tap; both are NULL when the tap was
  // refused before anyone was identified. Not measurable, not a blank string standing
  // in for a person.
  studentId String?
  staffId   String?
  sessionId String?                      // the register, for a student tap
  outcome   String                       // see the table below
  status    String?                      // "P" | "L" when a mark was written
  site      String?                      // "Onsite" | "Online" for a staff tap
  at        DateTime @default(now())
  ip        String?

  @@index([tagId, at])
  @@index([studentId])
  @@index([staffId])
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}
```

**Every tap is logged, accepted or refused, and the refusals are the valuable half.**
Attendance is the record this college is asked to evidence most often — funding, visa
compliance, a student disputing a mark — and "I did tap, it didn't work" is a question the
system must be able to answer. It is also the only place a pattern shows up: one address
checking in six students inside a minute is invisible in `AttendanceMark` and obvious here.

| `outcome` | Meaning |
|---|---|
| `marked` | A mark was written; `status` says `P` or `L` |
| `checked_in` | A staff clock-in was recorded; `site` says which |
| `already_marked` | A mark already existed. The register was not touched |
| `already_checked_in` | Staff had already clocked in today |
| `no_session_now` | No session of theirs is running at this moment |
| `ambiguous` | Two sessions running; the app asked them to choose |
| `term_locked` | The unit's term is over or has not started |
| `tag_unknown` | The code matched no active tag |
| `rate_limited` | Too many taps from this account |

### `AttendanceTapConfig` — per-college settings

Follows the pattern `attendanceBandConfig.js` established, which is the reference
implementation: defaults in code, one JSON column per tenant merged over them, no row
until a college edits something, an allowlist on the way out, a short cache invalidated
on save.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | **Ships switched off**, like attendance emails. No college gets this by surprise |
| `lateAfterMins` | `15` | Past this many minutes after the start, a tap records `L` not `P` |
| `earlyGraceMins` | `0` | Minutes before the start that taps begin to be accepted |
| `armSeconds` | `60` | How long a tag read keeps the button live |
| `staffTapEnabled` | `true` | Whether the same stickers also clock staff in |

### `AttendanceMark.checkedInAt`

```prisma
  // When the student actually tapped in. NULL when nobody self-checked-in — the lecturer
  // marked them by hand — which is "not measurable", not an early arrival.
  //
  // Written ONCE and never again. A later register save must not overwrite it: takenAt
  // is already reset on every update (hnd.js:1167 writes takenAt: new Date()), so it
  // means "when this mark was last edited", and a lecturer correcting the register at
  // four o'clock would otherwise destroy the only record of the 09:07 arrival.
  //
  // A string, not a DateTime, matching CheckIn.timeIn: the session carries the date, so
  // the two reconstruct the instant, and a time written through clock.localTime() is
  // right when stored and stays right. STATUS.md records D8 — the 08:00 notifications
  // firing at 09:00 through BST because something read the host clock — which is the
  // bug a stored instant re-zoned at every render invites back.
  checkedInAt String?   // "HH:MM", London
```

`sMark` in `serializers.js:117` must add it explicitly. That serialiser is an allowlist,
so a new column stays private until someone publishes it deliberately.

### `CheckIn.tagId`

```prisma
  // The sticker this clock-in was made at. NULL for one made by pressing the button in
  // the app, which stays available. Distinguishes "was in the building" from "said they
  // were", without a second boolean that could disagree with it.
  tagId String?
```

---

## 5. The student API

### `POST /api/student/me/tap-check-in`

Body `{ tagCode, sessionId? }`. `sessionId` is only sent after an `ambiguous` reply.

Order of checks:

1. **Rate limit.** In-process `Map`, module-level, with the standard clustering comment.
   Keyed on the student, since the caller is authenticated — a handful of taps a minute is
   generous for a person and stops a loop.
2. **Tag** active, and belonging to the caller's college. A tag from another tenant is
   simply not found: `db.js` scopes the lookup, so this needs no special handling and
   cannot be got wrong later.
3. **Session** — §3.
4. **Term lock.** `PUT /sessions/:id/register` returns 423 outside the term window
   (`hnd.js:1091`). A tap must not become a back door around it: same check, same refusal.
5. **Existing mark** → `already_marked`, register untouched.
6. **Write.** `AttendanceMark` with `P` or `L`, `checkedInAt` from `localTime()`,
   `takenBy: "Self check-in (NFC)"`. Then, exactly as a register save does:
   `flagStale([studentId], "an NFC self check-in")` so progression risk rescores, and an
   `audit.record` naming the student, the session and the tag.

Every path writes a `TagTap` row, including every refusal.

### `GET /api/student/me/tap-context`

What the check-in screen shows before a tap: the student's next or current session today,
and whether taps are being accepted right now. Read-only, own data only, keyed on
`req.user.id` like every other route in that file — no id parameter exists.

---

## 6. The staff flow

Same sticker, different half of the building.

```
  staff app, signed in
        │
        │  touch the sticker
        ▼
  button arms
        │
        ▼
  Where are you working today?
     [ Onsite ]   [ Online ]
        │
        ▼
  POST /api/checkins/tap-check-in  { tagCode, site }
        │
        ▼
  CheckIn  timeIn = "08:41", site, tagId
```

This reuses the existing `CheckIn` model unchanged: one row per staff member per day,
`@@unique([staffId, date])`, `timeIn` as `HH:MM` from `localTime()`. The existing
`POST /api/checkins/check-in` already takes a `site` validated against
`SITES = ["Onsite", "Online"]` in `validate.js:52`, and already handles the
summary-first row whose `timeIn` is `""`. The tap endpoint is a thin sibling that adds
`tagId` and logs a `TagTap`; it does not fork that logic.

**Checking out is unchanged** — `POST /api/checkins/:id/check-out`, and still final on
first use. Tapping out is deliberately not built: the existing rule is that the first
check-out stands, and a tag by the door that a member of staff walks past twice would
break that quietly.

### One thing to decide

**Tapping a sticker in the building and choosing "Online" is a contradiction.** They are
demonstrably on site — that is what the tap proves. Three ways to go, and I would take
the first:

1. A tap records **Onsite** without asking, and **Online** stays available through the
   existing button. Fastest, and the data means what it says.
2. Ask anyway, and accept that `site` records intent rather than fact — "I am here now but
   teaching remotely later".
3. Ask, but record both: the tag says onsite, the answer says how they are working.

Nothing else in this document depends on which is chosen.

---

## 7. The lecturer's dashboard

A live view of one session: who is in, who is late, who has not appeared, and the minute
each of them arrived.

```
  Leadership and Management · Tue 1 Sep · 09:00–12:00
  Taps accepted until 12:00                          ● open

  ┌──────────────────────────────────────────────────┐
  │  18 present    3 late    5 not tapped            │
  └──────────────────────────────────────────────────┘

  Adams, C.        Present   09:02   tapped
  Ali, D.          Late      09:24   tapped
  Khan, A.         Present   09:01   tapped
  Osei, B.         —         —       not tapped
  Reyes, M.        Present   —       marked by you

  [ Mark the 5 remaining absent ]     [ Open full register ]
```

Built on the existing register screen rather than beside it, so there is one place a
lecturer edits attendance and one set of rules governing it.

**"Not tapped" is a display state, not a mark.** Nothing is written for those students
until the lecturer says so. The button that writes them makes that explicit — it says how
many and it goes through the ordinary register save, with its term lock, its audit record
and its `flagStale`. This is the only route from this feature to an `A`, and a named human
is on the end of it.

Rows the lecturer marked by hand are distinguished from tapped ones, because `takenBy`
already carries provenance this way for the Moodle importer.

### Endpoints

- `GET /api/hnd/sessions/:id/live` — the roll with tap states and times. Polled every few
  seconds while the session is running; this codebase has no websocket layer and one
  three-hour class does not justify introducing one.
- `GET /api/hnd/my-sessions/today` — the sessions this lecturer is teaching today, via
  `Unit.tutorStaffId`, so the dashboard opens on the right one without hunting.
- `POST /api/hnd/sessions/:id/mark-remaining-absent` — writes `A` for enrolled students
  with no mark. Requires the `registers` page, respects the term lock, audited.

Both read endpoints sit behind the existing `registers` / `students` / `executive` gate at
`hnd.js:81`.

---

## 8. Testing

**Unit** — `attendanceTap.test.js`, pure, no database:

- no sessions today; one running; two running; one that has ended; one not yet started
- a tap one minute before the start with `earlyGraceMins: 0`, and with it set to `5`
- the late boundary exactly at `lateAfterMins`, and one minute either side
- a session whose term has ended
- a session running whose unit the student is not enrolled on

**Smoke** — `scripts/smoke-nfc-tap.mjs`, weighted toward negative assertions as the house
style requires:

- a tag from college A cannot be used by a student of college B
- a tap before the lecture starts is refused, and after it ends is refused
- a tap cannot overwrite a mark the lecturer already set — including an `A`
- a tap outside the term window is refused, exactly as a register save is
- two taps in a row produce one mark, not two, and the second does not move `checkedInAt`
- a later register save does **not** overwrite `checkedInAt`
- a student session still reaches nothing but `/api/student`
- `mark-remaining-absent` writes nothing for a student who already has a mark
- the whole feature refuses everything while `enabled` is `false`
- a staff tap creates a `CheckIn` with `tagId` set; a second tap the same day does not
  create a second row

Per `CLAUDE.md`, each regression test is proved able to fail by reintroducing the bug
before it is trusted. Two tests in recent work passed while discriminating nothing.

The client has no test framework, so the check-in screen and the dashboard are verified by
building and by hand.

---

## 9. Deliberately not in scope

- **Tapping out.** The first check-out is final, and a doorway tag walked past twice
  would quietly break that.
- **A web page fallback.** The app reads the tag; there is no browser path. Dropping it
  removes the readable URL, the email-and-password screen and the device-token machinery
  in one go.
- **Rotating-code tags.** The argument for them was a readable URL on the sticker. There
  isn't one.
- **GPS geofencing.** 20–100m indoors, mock location is a settings toggle, and it costs a
  privacy conversation to get a worse answer than the tap already gives.
- **Bluetooth beacons.** The only option that knows the *room*, but cheap ones broadcast a
  fixed ID anyone can clone. Revisit only if room-level precision proves necessary.
- **Marking absence from a missing tap.** See §3 and §7.

## 10. Rollout dependencies

1. **The app, installed and signed in**, on each student's phone. This is now the whole
   identity story — there is no browser path — so it is the long pole.
2. **A phone with NFC.** Some budget Androids and any iPhone older than the 7 cannot use
   this at all. Those students are marked by the lecturer in the ordinary way.
3. **`@capgo/capacitor-nfc`**, `8.2.5` at the time of writing, MPL-2.0, peer-depending on
   `@capacitor/core >=8.0.0` against this client's `^8.4.2`. Android uses
   `NfcAdapter.enableReaderMode`, which is the silent path §2 depends on.
4. **iOS entitlement.** `NFCReaderUsageDescription` in `Info.plist` and the NFC reader
   session capability on the provisioning profile. Apple's scan sheet cannot be
   suppressed, so the iPhone flow has one press the Android flow does not.
5. **Blank NTAG213 stickers**, one per room, written with the tag's secret.
6. **`enabled: true`** for the college, since the feature ships off.
7. **One migration**, applied to staging and production, named once and never renamed.
