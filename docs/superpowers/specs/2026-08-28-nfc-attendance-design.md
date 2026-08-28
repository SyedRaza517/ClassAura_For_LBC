# NFC tap check-in for student attendance

*Design, 28 Aug 2026. Status: awaiting review. Nothing here is built yet.*

A student taps a printed NFC sticker on the classroom wall. Their phone opens a web
page. They sign in once, tick "save on this phone", and from then on every class is one
button press. The system finds the register they belong to and marks them present.

This document is the agreed design. `STATUS.md` remains the map of what is actually
built; this is not a claim that any of it exists.

---

## 1. What already exists, and what this must not disturb

Attendance in this platform is a chain of four models:

    Unit ──< HndSession ──< AttendanceMark >── Student
                                                  │
    Unit ──────< Enrolment >──────────────────────┘

- `HndSession` is one timetabled class: `unitId` + `date` + `startTime`, unique together.
- `AttendanceMark` is one student's mark for one session — `P` | `L` | `E` | `A`, unique
  on `sessionId` + `studentId`.
- `Enrolment` is what makes a student eligible for a unit's registers at all.

The arithmetic lives in `server/src/attendance.js`: P=2, L=1, E=1, A=0, and
`pct = earned / (2 × marked)`. **Unmarked sessions are excluded from the denominator.**
Nothing in this feature changes that file. A tap produces an ordinary `P` or `L` and the
existing maths consumes it unchanged.

Today exactly two things write an `AttendanceMark`:

1. A member of staff saving a whole register — `PUT /api/hnd/sessions/:id/register`.
2. The Moodle importer, `moodleAttendance.js`, which stamps `takenBy: "Moodle import"`
   and **never overwrites an existing mark**.

This feature adds a third writer. It inherits the importer's invariant, for the same
reason: where two sources disagree about a student, the human who was in the room wins.

### The rules this feature is bound by

Carried over from `CLAUDE.md` and the code, listed here because each one is a way this
feature could quietly do damage:

| Rule | How it binds this feature |
|---|---|
| A query with no tenant context throws (`db.js`) | The tap route runs before tenant middleware, so it must resolve the college from the tag and use `runInTenant` explicitly |
| Null means "not measurable", zero means zero | A refused tap has no student and no session; both columns are nullable, never a sentinel |
| Dates are strings, `YYYY-MM-DD`, compared as strings | Session matching uses `localDate()`/`localTime()` from `clock.js` — never the host clock |
| Serialise through allowlists, never blocklists | The tap page is public; every field it returns is named explicitly |
| Rate limiters and locks are in-process `Map`s | Correct for one Node process; the new limiter carries the same comment as its neighbours |
| Never rename an applied migration directory | One migration, named once. P3009 has cost this project two outages |
| `ADMIN_PAGES` exists twice and must not drift | The new page is added to `validate.js` **and** `StaffHub.jsx` in the same commit |

---

## 2. The flow

```
  student taps the sticker
        │
        ▼
  browser opens  https://<host>/tap/<code>
        │
        ▼
  GET /api/tap/<code>          ← public; returns college name, branding, room label
        │
        ├── saved on this phone? ──── YES ──▶  [ Check in ]         (nothing typed)
        │                                            │
        └── NO ──▶ [ email ] [ password ]            │
                   [x] Save on this phone            │
                   [ Check in ]                      │
                          │                          │
                          └──────────┬───────────────┘
                                     ▼
                    POST /api/tap/<code>/check-in
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        who is this?          which register?          may it be written?
        password, or          today's sessions on      window open, term
        saved device          enrolled units, open     open, no existing
        token                 for check-in, now        mark
                                     │
                                     ▼
                     AttendanceMark  P (or L if late)
                     takenBy = "Self check-in (NFC)"
                                     │
                                     ▼
              "Marked present — Leadership & Management, 09:00–12:00"
```

### The lecturer's half

Taps are only accepted while the lecturer has **opened a check-in window** on the
register screen. They press *Open check-in*, the window runs for ten minutes (a
per-college setting), names appear on their screen as students tap, and it closes on
its own.

This is what proves the student is in the room. The sticker's URL is plain text on a
passive tag — any phone can read it, and a student could save the link and use it from
home. The window shrinks that to ten minutes while the lecturer is watching the list
fill up, which is a thing a person in the room can notice.

It also removes most of the ambiguity in matching. If a student's timetable has two
sessions overlapping, ordinarily the server cannot tell which one they walked into —
but only one lecturer has a window open, so the open window does the disambiguating.

---

## 3. Schema

Four new models and one new column. All additive; no existing column changes type or
nullability, and nothing on `StudentPredictionCurrent` / `StudentPredictionHistory` is
touched, so `schema-contract.test.js` is unaffected.

### `AttendanceTag` — a registered sticker

```prisma
model AttendanceTag {
  id           String    @id @default(cuid())
  // Globally unique, NOT unique-per-tenant: this code is what identifies the college,
  // because the phone that reads it sends no X-Tenant header. Opaque and random, so
  // it cannot be guessed from a neighbouring room's tag. ~16 chars of base32url.
  code         String    @unique
  label        String                        // "Room 101", "Main entrance"
  active       Boolean   @default(true)      // deactivate a lost or peeled-off sticker
  lastTappedAt DateTime?                     // null until first use — never zero
  createdAt    DateTime  @default(now())
  createdBy    String?                       // staff name, for the admin list
  checkIns     SelfCheckIn[]

  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}
```

### `TapDevice` — "save on this phone"

```prisma
model TapDevice {
  id         String    @id @default(cuid())
  student    Student   @relation(fields: [studentId], references: [id], onDelete: Cascade)
  studentId  String
  // The secret is stored HASHED, like PasswordReset does. A leaked database row must
  // not let anyone check in as this student.
  tokenHash  String    @unique
  label      String    @default("")          // coarse user-agent, e.g. "Android · Chrome"
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?                       // set by the student, an admin, or a password change

  @@index([studentId])
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}
```

**Why this is not a saved session token.** `JWT_EXPIRES` defaults to `"1d"`
(`auth.js:26`), so a stored login token would stop working every morning and the student
would type their password daily — which defeats the point. Raising `JWT_EXPIRES`
globally is the wrong fix: it would lengthen every staff and student session in the
product to buy a convenience for one screen.

So the saved credential is a separate secret with exactly one power: check in at a tag.
A lost phone therefore does not hand over the student portal — not their grades, not
their timetable, not their queries. It cannot read anything at all.

### `SelfCheckIn` — the tap log

```prisma
model SelfCheckIn {
  id        String   @id @default(cuid())
  tag       AttendanceTag @relation(fields: [tagId], references: [id], onDelete: Cascade)
  tagId     String
  // Null when the tap was refused before a student was identified — a wrong password,
  // an unknown address. "Not measurable", not a blank string standing in for a student.
  studentId String?
  sessionId String?
  outcome   String   // see the table below
  status    String?  // "P" | "L" when a mark was actually written; null otherwise
  at        DateTime @default(now())
  ip        String?
  userAgent String?

  @@index([tagId, at])
  @@index([studentId])
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  @@index([tenantId])
}
```

**Every tap is logged, accepted or refused, and the refusals are the valuable half.**
Attendance is the record this college is asked to evidence most often — funding, visa
compliance, a student disputing a mark — and "she says she tapped" is a question the
system must be able to answer. It is also the only place a pattern shows up: one IP
marking six students in forty seconds is invisible in `AttendanceMark` and obvious here.

The e-mail address as typed is deliberately **not** stored. A failed tap logs that a
sign-in failed at that tag at that time, not a list of addresses somebody was guessing.

Outcomes:

| `outcome` | Meaning |
|---|---|
| `marked` | A mark was written. `status` says `P` or `L` |
| `already_marked` | The lecturer (or an earlier tap) had already marked them. Register untouched |
| `bad_credentials` | Wrong password, unknown address, or a revoked device token |
| `no_open_window` | No session of theirs currently has check-in open |
| `ambiguous` | Two open sessions; the page asked them to choose |
| `term_locked` | The unit's term is over or has not started |
| `tag_unknown` | The code matched no active tag |
| `rate_limited` | Too many attempts at this tag or for this account |

### `AttendanceTapConfig` — per-college settings

Follows the pattern `attendanceBandConfig.js` established, which is the reference
implementation: platform defaults in code, one JSON column per tenant merged over them,
no row until a college edits something, an allowlist on the way out, a short cache
invalidated on save.

```prisma
model AttendanceTapConfig {
  id        String @id @default(cuid())
  settings  Json   @default("{}")
  updatedAt DateTime @updatedAt
  tenantId  String @unique
  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | **Ships switched off**, like attendance emails. No college gets this by surprise |
| `windowMins` | `10` | How long *Open check-in* accepts taps |
| `lateAfterMins` | `15` | Past this many minutes after the session start, a tap records `L` not `P` |
| `requireStaffConfirmForNewDevice` | `false` | When true, binding a *second* phone needs a lecturer's confirmation (see §6) |

### `HndSession.checkInOpenUntil`

```prisma
  // When the lecturer's check-in window closes. NULL means closed, which is the
  // resting state for every register ever taken by hand — hence nullable, not a
  // default of now(). Stored as an instant, not a duration: a duration would need
  // something to tick it down, and nothing here runs on a schedule.
  checkInOpenUntil DateTime?
```

---

## 4. The API

`/api/tap` mounts **above** `tenantMiddleware` in `index.js`, next to `/api/registrations`
and for the same reason: the phone reading a sticker is not yet inside a college. The
router resolves the tenant from the tag code inside a `crossTenant()` block — the only
cross-tenant read in the feature, deliberately conspicuous — and then does every
subsequent read and write inside `runInTenant(tenantId, …)`.

It never touches `STUDENT_ROUTERS`, so the student portal's isolation is unchanged.

### `GET /api/tap/:code` — public

Returns only what a wall sticker may safely announce: the college's display name and
branding colours, and the tag's label. It does **not** say which classes are running,
who is enrolled, or whether any window is open — that would let anyone holding the URL
survey the timetable.

An unknown or deactivated code returns **404 without distinguishing the two**, matching
how an unknown tenant is handled: no confirmation that a code exists.

### `POST /api/tap/:code/check-in`

Accepts **either**

- `{ email, password, remember }` — the first time on a handset, or
- `{ deviceToken }` — every time after that,

plus an optional `sessionId` when the previous call came back `ambiguous`.

Order of checks, and what each refuses:

1. **Rate limit.** In-process `Map`s, module-level, with the standard "needs Redis if
   this is ever clustered" comment. Generous per tag — thirty students arriving inside
   five minutes is a normal class, not abuse. Tight per address, to blunt password
   guessing at a public endpoint — the address is a key in an in-memory `Map` that is
   gone on restart, which is not the same thing as writing it to `SelfCheckIn`, and the
   distinction is the point of not logging it.
2. **Tag.** Active, and its tenant resolved. Otherwise `tag_unknown`.
3. **Identity.** `verifyPassword` against `Student.passwordHash`, reusing the same
   comparison as the student branch of `auth.js` — no second identity system, so a
   deactivated account or a bumped `tokenVersion` stops working here at the same moment
   it stops working everywhere else. Or `TapDevice.tokenHash`, unrevoked.
   A failure runs one bcrypt against a fixed dummy hash regardless, matching the timing
   defence already in `routes/auth.js`, so this endpoint cannot be used to discover
   which addresses are on the roll.
4. **Session.** See §5.
5. **Term lock.** `PUT /sessions/:id/register` returns 423 outside the term window
   (`hnd.js:1091`). A tap must not become a back door around it — same check, same refusal.
6. **Existing mark.** If one exists, `already_marked` and the register is left alone.
7. **Write.** `AttendanceMark` with `status` `P` or `L` and
   `takenBy: "Self check-in (NFC)"`. Then, exactly as a register save does:
   `flagStale([studentId], "an NFC self check-in")` so progression risk rescores, and an
   `audit.record` naming the student, the session and the tag.

`remember: true` mints a `TapDevice` secret and returns it once. The page stores it in
`localStorage`. The raw secret is never stored server-side and never returned again.

### Staff endpoints, on the existing `/api/hnd` router

- `POST /sessions/:id/open-check-in` — sets `checkInOpenUntil = now + windowMins`.
  Pressing again extends it. Requires the `registers` page, like every other write there.
- `POST /sessions/:id/close-check-in` — sets it back to `NULL`.
- `GET /sessions/:id/register` — extended, not replaced, with `checkInOpenUntil` and a
  per-row flag for marks whose `takenBy` is the self check-in stamp.

### Admin endpoints, new `/api/tags` router

`GET` / `POST` / `PATCH` (deactivate) for tags, and `GET /api/tags/:id/log` for that
sticker's recent taps. Gated by a new grantable page, `attendance-tags`, added to
`ADMIN_PAGES` in **both** `server/src/validate.js` and `client/src/StaffHub.jsx` in the
same commit.

---

## 5. Choosing the register

A pure function in `server/src/attendanceTap.js`, tests beside it, no database — the
pattern `src/prediction/` and `src/vle/*Normalise.js` already set. It takes a list of
candidate sessions and the current local date and time; it returns a decision. Every
interesting case is then a unit test with no fixtures.

```js
// candidates: the student's sessions for today, each with startTime, endTime,
//             checkInOpenUntil, and its unit's term window
// now:        { date: "2026-09-01", time: "09:07" }  ← from clock.js, never the host

resolveTapSession(candidates, now, { lateAfterMins })
  // → { kind: "one",       session, status: "P" | "L" }
  // → { kind: "ambiguous", sessions: [...] }
  // → { kind: "none",      reason: "no_open_window" | "term_locked" }
```

The rules:

1. Keep sessions dated today whose unit the student is enrolled on. Enrolment is what
   makes a student eligible for a register at all, and taking it from `Enrolment` means
   a tap can never attach a student to a unit they were never on — the same reason
   `hnd.js:1091` checks enrolment rather than mere existence.
2. Of those, keep the ones with `checkInOpenUntil > now`.
3. Zero → `none`. One → `one`. Two or more → `ambiguous`; the page lists them and the
   student picks, and the choice comes back as `sessionId`.
4. `P` if `now <= startTime + lateAfterMins`, otherwise `L`.

Times are `HH:MM` 24-hour strings, zero-padded, so a plain string compare sorts
chronologically — the convention already used throughout `checkins.js` and `hnd.js`.

**A tap never marks anyone absent.** There is no path from this feature to an `A`.
Absence is what an untaken register already means, and the maths in `attendance.js`
excludes unmarked sessions from the denominator on purpose. Writing `A` for "did not
tap" would convert a phone that was flat, or forgotten, or out of NFC range, into a
permanent academic record — and it would do so most often to the students least able to
argue about it.

---

## 6. Losing a phone

The awkward case, stated plainly because it will happen in the first week.

`TapDevice` binds a student to one handset. A student on a new phone signs in with email
and password as they did the first time, which mints a device token for the new phone.
That is all that is needed, and it is why the default posture works.

The risk it leaves is a student who hands their password to a friend so the friend can
tap for them. Nothing on a phone solves that — it is the oldest problem in attendance and
it predates computers. What the design does instead is make it visible: the tap log
records each device, so one handset checking in for several students, or an account whose
device changes every week, is a query away rather than invisible.

`requireStaffConfirmForNewDevice` is available for a college that wants the tighter
posture: binding a *second* device requires a lecturer to confirm it once on the register
screen. It defaults to `false` — off — because the friction lands almost entirely on
students who have simply changed phone.

---

## 7. What the student sees

A public SPA route `/tap/:code`, outside the authenticated shell — no app install, no
Capacitor, plain mobile web. It renders the college's own branding via the existing
per-tenant `branding.js`, the room label from the tag, and then one of three states:

- **Saved phone:** the student's first name and a single large *Check in* button.
- **First time:** email, password, a *Save on this phone* checkbox ticked by default,
  and *Check in*.
- **Result:** a large "Marked present — Leadership and Management, 09:00–12:00", or a
  refusal in plain words: *"Check-in isn't open for any of your classes right now."*

Nothing on this page is reachable without the tag's code, and nothing on it reveals a
student's record beyond the class they just checked into.

## 8. What the lecturer sees

On the existing register screen for a session: an *Open check-in* button, a countdown
while the window is live, and the register filling in as students tap — polled every few
seconds, since this codebase has no websocket layer and a ten-minute window does not
justify introducing one.

Self-marked rows are **visibly distinguished** from ones the lecturer took. The lecturer
keeps the final word: any mark can be corrected in the normal way, and because a tap
never overwrites an existing mark, a correction stays corrected.

---

## 9. Testing

**Unit** — `attendanceTap.test.js`, no database:

- no sessions today; sessions today but none open; exactly one open; two open
- a tap before the window opens, and after it closes
- the late boundary exactly at `lateAfterMins`, and one minute either side
- a session whose term has ended
- a student enrolled on a unit with a session running but not open

**Smoke** — `scripts/smoke-nfc-tap.mjs`, weighted toward negative assertions as the house
style requires. Who is refused, what never leaves the building, what cannot be done twice:

- an unknown tag code 404s, and does not distinguish "never existed" from "deactivated"
- `GET /api/tap/:code` returns the college name and nothing about classes or people
- a tag belonging to college A cannot mark a student of college B
- a wrong password is refused, and takes about as long as a right one
- a tap with no open window is refused
- a tap cannot overwrite a mark the lecturer already set — including an `A`
- a tap outside the term window is refused, exactly as the register save is
- two taps in a row produce one mark, not two
- a revoked `TapDevice` no longer works
- the tap endpoint works with no `Authorization` header and no `X-Tenant` header at all
- the feature refuses everything while `enabled` is `false`

Per `CLAUDE.md`: each regression test is proved able to fail by reintroducing the bug
before it is trusted. Two tests in recent work passed while discriminating nothing.

The client has no test framework, so the tap page and the register changes are verified
by building and by hand.

---

## 10. Deliberately not in scope

- **Check-out and duration.** Attendance here is a mark per session, not hours.
- **NFC for staff clock-in.** `CheckIn` is a separate model and a separate feature;
  conflating them is the single easiest mistake to make in this area.
- **Rotating-code tags (NTAG 424 DNA).** Considered and set aside in favour of the
  lecturer's window, which costs nothing in hardware. If the window proves too loose,
  this is the upgrade, and it needs no change to the student's experience.
- **Geofencing.** Wi-Fi and GPS on a phone are both spoofable and both leak location.
- **Marking absence from a missing tap.** See §5.

## 11. Rollout dependencies

Not code, but the feature does not work without them:

1. **Every student needs a password.** `Student.passwordHash` is `NULL` until claimed.
   Two existing routes: the student signs up and an admin approves, or an admin sets one
   at the desk — `passwords.js:59` already lists students with a "Has not set a password
   yet" note for exactly this purpose.
2. **Blank NTAG stickers**, one per classroom, written with the tag's URL using any
   phone app. Nothing to build; the admin screen shows the URL and a QR fallback for
   phones without NFC, using the `qrcode` dependency the client already has.
3. **`enabled: true`** set for the college, since the feature ships off.
4. **One migration**, applied to staging and production. It is named once and never
   renamed: a rename makes an applied migration look new, it re-runs, and P3009 then
   blocks every later deploy. That has happened twice on this project.
